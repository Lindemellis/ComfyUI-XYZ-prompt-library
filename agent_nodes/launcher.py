"""Find and start the comfyui-mcp orchestrator.

The agent panel is a sidebar inside ComfyUI, but its brain is a separate Node
process. The panel deliberately cannot start it — that pack is published to the
Comfy Registry, whose standards forbid a custom node from spawning processes, so
it stays a pure frontend extension and tells the user to run a command by hand.

We are not published there, so we can just press the button. Same shape as
`krita_nodes/launcher.py`, including the part that actually matters: do NOT
report success the moment the process exists — poll the bridge until it answers,
because a panel that connects too early just sits there retrying.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "agent_data"
SETTINGS = DATA_DIR / "settings.json"

#: Standing behaviour rules. Always on and not user-switchable — they are what
#: stops the agent editing the canvas unasked and writing prompts without
#: reading the model's skill, which is not a preference.
HOUSE_RULES_FILE = DATA_DIR / "house_rules.md"

#: The content notes. One file per note, pick one in the UI. Kept a DIRECTORY
#: rather than a single file because these are alternatives, not layers: two of
#: them stacked would be two sets of framing instructions contradicting each
#: other. `unlock.md` from the single-file era migrates in on first use.
UNLOCK_DIR = DATA_DIR / "unlock"
LEGACY_UNLOCK_FILE = DATA_DIR / "unlock.md"

#: What the orchestrator actually reads: a rendered copy of the selected note,
#: or empty when the switch is off. Generated — never edit it, edits are lost on
#: the next toggle. See the comment in `_env_for_child`.
ACTIVE_UNLOCK = DATA_DIR / "unlock_active.md"

#: The orchestrator's loopback bridge — what the sidebar panel connects to.
BRIDGE_HOST = "127.0.0.1"
BRIDGE_PORT = int(os.getenv("COMFYUI_MCP_BRIDGE_PORT", "9180"))

#: Where a patched fork usually sits, if settings say nothing.
ENTRY_GUESSES = [
    r"E:\AI\forks\comfyui-mcp\dist\index.js",
]


class OrchestratorNotFound(Exception):
    """No entry point to run. The user has to point us at one."""


def _load() -> dict:
    try:
        return json.loads(SETTINGS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save(settings: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS.write_text(json.dumps(settings, indent=2), encoding="utf-8")


def _migrate_legacy_unlock() -> None:
    """Move the single-file `unlock.md` into the directory, once.

    Idempotent and never destructive: it only runs when the directory does not
    already hold that name, so a user who has since edited the moved copy keeps
    theirs.
    """
    if not LEGACY_UNLOCK_FILE.is_file():
        return
    UNLOCK_DIR.mkdir(parents=True, exist_ok=True)
    target = UNLOCK_DIR / LEGACY_UNLOCK_FILE.name
    if target.exists():
        return
    LEGACY_UNLOCK_FILE.replace(target)


def _label_of(path: Path) -> str:
    """A readable name for the dropdown: the file's first markdown heading, else
    its stem. Lets a file keep an ASCII filename while showing a Chinese name."""
    try:
        for line in path.read_text(encoding="utf-8").splitlines()[:20]:
            line = line.strip()
            if line.startswith("#"):
                return line.lstrip("#").strip() or path.stem
    except OSError:
        pass
    return path.stem


def list_unlocks() -> list[dict]:
    """Every content note on offer, newest-looking name first is NOT the order —
    they are sorted by name so the dropdown does not reshuffle itself."""
    _migrate_legacy_unlock()
    if not UNLOCK_DIR.is_dir():
        return []
    out = []
    for path in sorted(UNLOCK_DIR.glob("*.md")):
        try:
            # Characters, not st_size: these notes are largely Chinese, where a
            # byte count reads as roughly triple the real length.
            chars = len(path.read_text(encoding="utf-8"))
        except OSError:
            continue
        out.append({"name": path.name, "label": _label_of(path), "chars": chars})
    return out


def unlock_path() -> Path | None:
    """The chosen note's file, or None when nothing usable is selected.

    Falls back to the single remaining option when the stored choice is gone —
    a renamed file should not silently disable the switch the user left on.
    """
    options = list_unlocks()
    if not options:
        return None
    chosen = _load().get("unlock_choice")
    names = [o["name"] for o in options]
    if chosen in names:
        return UNLOCK_DIR / chosen
    return UNLOCK_DIR / names[0]


def _seed_house_rules() -> None:
    """Put the shipped rules in place on a fresh install, once.

    `agent_data/` is gitignored — it holds this machine's settings and the
    content notes — so the rules cannot live there in the repository, and a
    clone with no copy would run with them silently absent. The default ships
    next to the code and is copied across only when the data file is MISSING,
    so a user's edits are never overwritten by an update.
    """
    if HOUSE_RULES_FILE.is_file():
        return
    default = Path(__file__).resolve().parent / "house_rules.default.md"
    if not default.is_file():
        return
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    HOUSE_RULES_FILE.write_text(default.read_text(encoding="utf-8"), encoding="utf-8")


def _write_active_unlock() -> Path | None:
    """Render the current selection into the file the orchestrator reads.

    Returns the source note in force, or None when the switch is off / nothing
    is selectable. Writing an EMPTY file for "off" is deliberate: the reader
    treats empty as absent, and leaving a stale file behind would keep the note
    live after the user switched it off.
    """
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    source = unlock_path() if _load().get("unlock") else None
    text = ""
    if source is not None:
        try:
            text = source.read_text(encoding="utf-8").strip()
        except OSError:
            source, text = None, ""
    try:
        if ACTIVE_UNLOCK.read_text(encoding="utf-8") == text:
            return source  # unchanged — do not touch the mtime
    except OSError:
        pass
    ACTIVE_UNLOCK.write_text(text, encoding="utf-8")
    return source


def set_entry(path: str) -> str:
    entry = Path(path).expanduser()
    if not entry.is_file():
        raise OrchestratorNotFound(f"{entry} is not a file")
    settings = _load()
    settings["entry"] = str(entry)
    _save(settings)
    return str(entry)


def find_entry() -> str | None:
    """A saved path, then the environment, then the usual place."""
    saved = _load().get("entry")
    if saved and Path(saved).is_file():
        return saved

    env = os.getenv("XYZ_AGENT_ENTRY")
    if env and Path(env).is_file():
        return env

    for guess in ENTRY_GUESSES:
        if Path(guess).is_file():
            return guess
    return None


def find_node() -> str | None:
    saved = _load().get("node")
    if saved and Path(saved).is_file():
        return saved
    return shutil.which("node")


def is_running() -> bool:
    """Is something listening on the bridge port? That is the whole question —
    we do not own the process, and the user may have started it themselves."""
    with socket.socket(AF := socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex((BRIDGE_HOST, BRIDGE_PORT)) == 0


def wait_for_bridge(timeout: float = 60.0) -> bool:
    """Poll until the bridge accepts a connection, or give up. Bounded, always."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if is_running():
            return True
        time.sleep(1.0)
    return False


def _env_for_child(overrides: dict | None = None) -> dict:
    """The orchestrator reads its whole configuration from the environment.

    Anything already set in ComfyUI's environment wins, so a user who exports
    their own COMFYUI_MCP_* keeps them; we only fill in what is missing.
    """
    settings = _load()
    env = os.environ.copy()

    def default(key: str, value) -> None:
        if value and not env.get(key):
            env[key] = str(value)

    # Pin the filesystem target. Left unset, the orchestrator picks an install on
    # its own; it happily chose a different one than the URL during testing, and
    # the tools that write files would have followed the wrong pick. Outside
    # ComfyUI (a standalone call, a test) fall back to this file's own install.
    try:
        import folder_paths  # ComfyUI's own — the path IS this install

        comfy_path = folder_paths.base_path
    except ImportError:
        comfy_path = str(Path(__file__).resolve().parents[3])
    default("COMFYUI_PATH", comfy_path)
    default("COMFYUI_URL", settings.get("comfyui_url") or _self_url())
    default("PANEL_AGENT_BACKEND", settings.get("backend") or "custom")
    default("COMFYUI_MCP_CUSTOM_BASE_URL", settings.get("base_url"))
    default("COMFYUI_MCP_CUSTOM_MODEL", settings.get("model"))
    # Models the endpoint serves but does not advertise (see the GLM preset).
    default("COMFYUI_MCP_CUSTOM_EXTRA_MODELS", ",".join(settings.get("extra_models") or []))
    default("COMFYUI_MCP_CUSTOM_API_KEY", settings.get("api_key") or _pi_key(settings))
    # Auto-selection drops to a 6-tool router for any model whose parameter count
    # it cannot read, which cripples a capable one. Ask for the full surface.
    default("COMFYUI_MCP_TOOL_MODE", settings.get("tool_mode") or "full")
    # pi brings its own default model from ~/.pi/agent/settings.json, which is
    # whatever the user picked for terminal work — deepseek here, and text-only.
    # Pin the panel lane separately so selecting pi does not silently land on a
    # model that cannot see the images this agent spends its time looking at.
    default("COMFYUI_MCP_PI_PROVIDER", settings.get("pi_provider"))
    default("COMFYUI_MCP_PI_MODEL", settings.get("pi_model"))
    # The OpenAI-compatible lane reserves 8192 output tokens by default — a cap
    # aimed at runaway small models and prepaid balances. A thinking model spends
    # that budget on reasoning before it writes anything, so the visible answer
    # gets cut mid-sentence. Raise it for the frontier models this lane runs.
    default("COMFYUI_MCP_OLLAMA_MAX_TOKENS", settings.get("max_tokens") or 32768)

    # Both standing notes are passed as FILE PATHS, never as text: the
    # orchestrator re-reads them every turn, so editing a file or flipping the
    # switch takes effect on the next message instead of needing a restart.
    #
    # The house rules are unconditional. Everything they carry — do not edit the
    # canvas unasked, read the model's skill before writing its prompt — is a
    # correctness rule, and a correctness rule behind a toggle is a bug waiting
    # for the toggle to be off.
    _seed_house_rules()
    if HOUSE_RULES_FILE.is_file():
        env["COMFYUI_MCP_HOUSE_RULES_FILE"] = str(HOUSE_RULES_FILE)
    else:
        env.pop("COMFYUI_MCP_HOUSE_RULES_FILE", None)

    # The content note points at ONE stable path whose CONTENTS we rewrite,
    # rather than at whichever note is selected. The orchestrator captured this
    # variable when it was spawned, so a path that moved with the selection
    # would strand it on the old file — and switching the note off by unsetting
    # the variable could not work at all without a restart. Rewriting a fixed
    # file makes both the switch and the dropdown take effect on the next turn.
    _write_active_unlock()
    env["COMFYUI_MCP_UNLOCK_FILE"] = str(ACTIVE_UNLOCK)

    # Provider keys come from pi's auth file — the one credential store. The
    # orchestrator's own backends read them from the environment under different
    # names than pi uses, so the names are translated here rather than the key
    # being written down twice.
    #
    # `default`, not an overwrite: an explicit entry in the settings env block
    # below still wins, which is what a key that exists ONLY for the panel needs.
    for var, key in keys_from_pi_auth().items():
        default(var, key)

    # A free-form env block in settings.json. The orchestrator reads its whole
    # configuration from the environment, and several providers (GLM, Kimi,
    # Moonshot, MiniMax) are keyed by env var alone — but the variable has to
    # exist BEFORE the process is spawned, and we are what spawns it. Without
    # this the only way to set one is to export it in whatever shell started
    # ComfyUI, which does not survive a reboot or a desktop launcher.
    #
    # Applied BEFORE the per-call overrides so a route can still win, and it
    # deliberately overwrites rather than defaulting: a value the user wrote
    # here is a decision, not a fallback.
    for key, value in (settings.get("env") or {}).items():
        if value:
            env[str(key)] = str(value)

    for key, value in (overrides or {}).items():
        if value:
            env[str(key)] = str(value)
    return env


def _self_url() -> str:
    try:
        from server import PromptServer

        port = PromptServer.instance.port
    except Exception:
        port = 8188
    return f"http://127.0.0.1:{port}"


#: pi's credential file — ONE place for every provider key.
PI_AUTH = Path.home() / ".pi" / "agent" / "auth.json"

#: pi provider name -> the env var the ORCHESTRATOR's own backends read for it.
#:
#: These are two different vocabularies for the same key: pi resolves `zai` from
#: its auth file, while the panel's GLM backend only ever looks at GLM_API_KEY in
#: the environment. Keeping a copy in both places is what made "where is my key
#: stored" have two answers; deriving the environment from the auth file leaves
#: exactly one file to edit.
#:
#: A provider listed twice (moonshotai / moonshotai-cn) maps to the same var —
#: first one present wins, so a China-region entry works without extra config.
_PI_PROVIDER_ENV: dict[str, str] = {
    "zai": "GLM_API_KEY",
    "zai-coding-cn": "GLM_API_KEY",
    "moonshotai-cn": "MOONSHOT_API_KEY",
    "moonshotai": "MOONSHOT_API_KEY",
    "kimi-coding": "KIMI_API_KEY",
    "minimax-cn": "MINIMAX_API_KEY",
    "minimax": "MINIMAX_API_KEY",
    "openrouter": "OPENROUTER_API_KEY",
    "xai": "XAI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    # Qwen's platform API (Alibaba DashScope / 百炼). pi has no BUILT-IN provider
    # for it — its `qwen-token-plan` entries are the coding subscription, a
    # different product — so pi reaches it through a custom provider declared in
    # `~/.pi/agent/models.json`, and this exports the key that provider reads.
    "dashscope": "DASHSCOPE_API_KEY",
}


#: The OpenAI-compatible endpoints the custom lane can be pointed at.
#:
#: `pi` is the provider name in pi's auth file, which is where the key comes
#: from — so an entry is offered only when that provider is actually logged in,
#: and adding a fifth endpoint means adding a row here, never a second key store.
#:
#: A user who wants something not listed can still write `base_url` / `model`
#: into settings.json by hand; this table is the set with one-click switching,
#: not the set that is permitted.
PROVIDER_PRESETS: list[dict] = [
    {
        "id": "gemini",
        "label": "Gemini (Google)",
        "base_url": "https://generativelanguage.googleapis.com/v1beta/openai",
        "pi": "google",
        "default_model": "gemini-2.5-pro",
    },
    {
        "id": "kimi",
        "label": "Kimi (Moonshot 国内)",
        "base_url": "https://api.moonshot.cn/v1",
        "pi": "moonshotai-cn",
        "default_model": "kimi-k3",
    },
    {
        "id": "kimi-global",
        "label": "Kimi (Moonshot 国际)",
        "base_url": "https://api.moonshot.ai/v1",
        "pi": "moonshotai",
        "default_model": "kimi-k3",
    },
    {
        "id": "glm",
        "label": "GLM (Z.AI / 智谱)",
        "base_url": "https://api.z.ai/api/paas/v4",
        "pi": "zai",
        "default_model": "glm-4.5v",
        # Z.AI's /models lists only its eight TEXT models, yet these answer,
        # see images and call tools — all four verified against the live
        # endpoint. Without naming them here the picker can only ever offer
        # text-only models and the lane looks blind.
        "extra_models": ["glm-4.6v", "glm-4.5v", "glm-4v"],
    },
    # Qwen ships the SAME OpenAI-compatible protocol on two hosts, and a key is
    # only valid on the one it was issued from — a key from the other host fails
    # with a 401 that says nothing about the region. The label carries the
    # console each one belongs to, because that is the only thing distinguishing
    # them at the moment of choosing.
    {
        "id": "qwen-intl",
        "label": "Qwen 通义千问（qwencloud.com / 国际站）",
        "base_url": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        "pi": "dashscope",
        "default_model": "qwen3-vl-plus",
    },
    {
        "id": "qwen",
        "label": "Qwen 通义千问（阿里云百炼 / 国内站）",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "pi": "dashscope",
        "default_model": "qwen3-vl-plus",
    },
    {
        "id": "deepseek",
        "label": "DeepSeek",
        "base_url": "https://api.deepseek.com/v1",
        "pi": "deepseek",
        "default_model": "deepseek-chat",
    },
]


def _preset(pid: str) -> dict | None:
    return next((p for p in PROVIDER_PRESETS if p["id"] == pid), None)


def list_providers() -> dict:
    """The switchable endpoints, which one is live, and which have a key."""
    auth = _pi_auth()
    settings = _load()
    base = (settings.get("base_url") or "").rstrip("/")
    current = next((p["id"] for p in PROVIDER_PRESETS if p["base_url"].rstrip("/") == base), None)
    return {
        "current": current,
        "base_url": settings.get("base_url"),
        "model": settings.get("model"),
        "auth_file": str(PI_AUTH),
        "providers": [
            {
                "id": p["id"],
                "label": p["label"],
                "base_url": p["base_url"],
                "default_model": p["default_model"],
                # No key means the row is shown but not selectable — "log in with
                # pi" is a more useful message than a silently missing option.
                "has_key": bool(isinstance(auth.get(p["pi"]), dict) and auth[p["pi"]].get("key")),
                "pi_provider": p["pi"],
            }
            for p in PROVIDER_PRESETS
        ],
    }


def list_models(pid: str) -> dict:
    """Ask an endpoint what it serves.

    Live rather than a hardcoded list: these catalogues change, and two of them
    (Z.AI, Moonshot) differ between their China and global hosts.
    """
    import urllib.error
    import urllib.request

    preset = _preset(pid)
    if preset is None:
        return {"ok": False, "error": f"unknown provider: {pid}"}
    key = (_pi_auth().get(preset["pi"]) or {}).get("key")
    if not key:
        return {"ok": False, "error": f"{preset['label']} 还没有 key（{PI_AUTH} 里没有 {preset['pi']}）"}
    req = urllib.request.Request(
        preset["base_url"].rstrip("/") + "/models",
        headers={"Authorization": f"Bearer {key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        return {"ok": False, "error": f"HTTP {exc.code} — key 或端点不对"}
    except Exception as exc:  # noqa: BLE001 — surfaced as text, never raised
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    ids = sorted(m.get("id", "") for m in payload.get("data", []) if m.get("id"))
    return {"ok": True, "models": ids, "default_model": preset["default_model"]}


def set_provider(pid: str, model: str | None = None) -> dict:
    """Point the custom lane at a preset and restart so it takes effect.

    The restart is not optional and not a caller's problem to remember: the
    orchestrator reads its endpoint from the environment when it is SPAWNED, so
    a switch that only rewrote settings.json would leave the old endpoint live
    and look like the switch had silently failed.
    """
    preset = _preset(pid)
    if preset is None:
        return {"ok": False, "error": f"unknown provider: {pid}"}
    settings = _load()
    settings["base_url"] = preset["base_url"]
    settings["model"] = model or preset["default_model"]
    settings["borrow_pi_provider"] = preset["pi"]
    settings["extra_models"] = preset.get("extra_models") or []
    _save(settings)

    restarted = False
    if is_running():
        stop()
        restarted = True
    launch(wait=True, timeout=60)
    return {
        "ok": True,
        "provider": pid,
        "label": preset["label"],
        "model": settings["model"],
        "restarted": restarted,
    }


def stop() -> bool:
    """Kill whatever holds the bridge port. Returns whether something was there."""
    if not is_running():
        return False
    if sys.platform == "win32":
        subprocess.run(
            ["netstat", "-ano"], capture_output=True, text=True, check=False
        )
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"(Get-NetTCPConnection -LocalPort {BRIDGE_PORT} -State Listen"
             " -ErrorAction SilentlyContinue).OwningProcess"],
            capture_output=True, text=True, check=False,
        ).stdout.strip()
        for pid in {line.strip() for line in out.splitlines() if line.strip().isdigit()}:
            subprocess.run(["taskkill", "/F", "/PID", pid], capture_output=True, check=False)
    else:
        subprocess.run(["pkill", "-f", "panel-orchestrator"], capture_output=True, check=False)
    deadline = time.time() + 15
    while time.time() < deadline:
        if not is_running():
            return True
        time.sleep(0.5)
    return True


def _pi_auth() -> dict:
    try:
        return json.loads(PI_AUTH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def keys_from_pi_auth() -> dict[str, str]:
    """Every orchestrator env var derivable from pi's credential file.

    Only plain `api_key` records — an OAuth stanza holds a refresh token, not
    something an OpenAI-compatible backend can send as a bearer key, and
    exporting one would green a backend that cannot actually authenticate.
    """
    out: dict[str, str] = {}
    for provider, record in _pi_auth().items():
        var = _PI_PROVIDER_ENV.get(provider)
        if not var or var in out or not isinstance(record, dict):
            continue
        if record.get("type") != "api_key":
            continue
        key = record.get("key")
        if isinstance(key, str) and key.strip():
            out[var] = key.strip()
    return out


def _pi_key(settings: dict) -> str | None:
    """The custom lane's key, borrowed from pi's auth file.

    Named provider only — never a blanket sweep — because this one picks the
    single endpoint the custom lane talks to, unlike `keys_from_pi_auth` where
    each key lands in its own provider's variable.
    """
    provider = settings.get("borrow_pi_provider")
    if not provider:
        return None
    record = _pi_auth().get(provider)
    return record.get("key") if isinstance(record, dict) else None


def launch(wait: bool = True, timeout: float = 60.0, env_overrides: dict | None = None) -> dict:
    """Start the orchestrator if the bridge is not already up, then wait for it."""
    already = is_running()
    if already:
        return {"ok": True, "launched": False, "waited": False, "bridge": bridge_url()}

    entry = find_entry()
    if entry is None:
        raise OrchestratorNotFound(
            "could not find the orchestrator entry point. Set it with "
            "POST /xyz/agent/entry, or point XYZ_AGENT_ENTRY at "
            "<comfyui-mcp>/dist/index.js."
        )
    node = find_node()
    if node is None:
        raise OrchestratorNotFound("node is not on PATH — install Node 22+ or set it in settings.json.")

    log_path = DATA_DIR / "orchestrator.log"
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    log = open(log_path, "ab", buffering=0)  # noqa: SIM115 — outlives this call

    creationflags = 0
    if sys.platform == "win32":
        creationflags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    subprocess.Popen(
        [node, entry, "--panel-orchestrator"],
        cwd=str(Path(entry).parent),
        stdout=log,
        stderr=log,
        stdin=subprocess.DEVNULL,
        close_fds=True,
        creationflags=creationflags,
        env=_env_for_child(env_overrides),
    )

    if not wait:
        return {"ok": True, "launched": True, "waited": False, "log": str(log_path)}

    if not wait_for_bridge(timeout):
        raise RuntimeError(
            f"the orchestrator was started but its bridge did not answer within {timeout:.0f}s. "
            f"See {log_path}."
        )
    return {"ok": True, "launched": True, "waited": True, "bridge": bridge_url(), "log": str(log_path)}


def bridge_url() -> str:
    return f"ws://{BRIDGE_HOST}:{BRIDGE_PORT}"


def status() -> dict:
    entry = find_entry()
    settings = _load()
    options = list_unlocks()
    active = unlock_path() if settings.get("unlock") else None
    return {
        "entry": entry,
        "found": entry is not None,
        "unlock": bool(settings.get("unlock")) and active is not None,
        "unlock_choice": active.name if active else settings.get("unlock_choice"),
        "unlock_options": options,
        "unlock_dir": str(UNLOCK_DIR),
        "unlock_present": bool(options),
        "house_rules": HOUSE_RULES_FILE.is_file(),
        "house_rules_file": str(HOUSE_RULES_FILE),
        "node": find_node(),
        "running": is_running(),
        "bridge": bridge_url(),
        "model": settings.get("model"),
        "backend": settings.get("backend") or "custom",
        "log": str(DATA_DIR / "orchestrator.log"),
    }


def set_unlock(enabled: bool | None = None, choice: str | None = None) -> dict:
    """Flip the content note and/or pick which one is in force.

    Live for the custom lane and pi alike, with no restart in any case: the
    orchestrator re-reads one fixed path per turn and this rewrites what is at
    that path. Either argument may be omitted to leave it alone.

    A `choice` that names no existing note is rejected rather than silently
    ignored — it is a filename coming in over HTTP, and quietly falling back
    would leave the UI showing a selection that is not the one in force.
    """
    settings = _load()
    if enabled is not None:
        settings["unlock"] = bool(enabled)
    if choice is not None:
        names = [o["name"] for o in list_unlocks()]
        if choice not in names:
            return {"ok": False, "error": f"no such note: {choice}", "options": names}
        settings["unlock_choice"] = choice
    _save(settings)
    source = _write_active_unlock()
    return {
        "ok": True,
        "unlock": bool(settings.get("unlock")),
        "choice": source.name if source else None,
        "label": _label_of(source) if source else None,
        "chars": len(ACTIVE_UNLOCK.read_text(encoding="utf-8")) if ACTIVE_UNLOCK.is_file() else 0,
        "options": list_unlocks(),
    }
