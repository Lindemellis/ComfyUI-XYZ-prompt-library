"""Install the Krita plugin into Krita's `pykrita` directory.

Krita only loads plugins from there, so we copy rather than symlink (a symlink
needs admin rights on Windows). Reinstalling overwrites — the plugin holds no
state of its own.
"""

from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

PLUGIN_NAME = "xyz_comfy"

#: Where the plugin source lives in this repo.
SOURCE = Path(__file__).resolve().parent.parent / "krita_plugin"


def pykrita_dir() -> Path | None:
    """Krita's Python plugin directory, per platform."""
    if sys.platform == "win32":
        appdata = os.getenv("APPDATA")
        return Path(appdata) / "krita" / "pykrita" if appdata else None
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "krita" / "pykrita"
    return Path.home() / ".local" / "share" / "krita" / "pykrita"


def kritarc_path() -> Path | None:
    """Krita's config file.

    **This is NOT next to pykrita.** On Windows the plugins live in
    `%APPDATA%\\krita\\pykrita` but the config is `%LOCALAPPDATA%\\kritarc` —
    Roaming vs Local, and no `krita\\` folder. Writing the enable flag to
    `%APPDATA%\\krita\\kritarc` creates a file Krita never reads, and the plugin
    then silently never loads. (ComfyUI-Danbooru-Gallery's installer has exactly
    this bug; do not copy it.)
    """
    if sys.platform == "win32":
        local = os.getenv("LOCALAPPDATA")
        return Path(local) / "kritarc" if local else None
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Preferences" / "kritarc"
    return Path.home() / ".config" / "kritarc"


def _enable_in_kritarc() -> bool:
    """Tick the plugin on in Krita's config.

    `X-KDE-PluginInfo-EnabledByDefault=true` in the .desktop file does NOT do
    this — Krita only loads a Python plugin that has an explicit
    `enable_<name>=true` under `[python]` in kritarc. Without this the plugin
    installs, Krita starts, and nothing happens at all.
    """
    path = kritarc_path()
    if path is None:
        return False

    key = f"enable_{PLUGIN_NAME}"
    lines = path.read_text(encoding="utf-8").splitlines(True) if path.exists() else []

    out: list[str] = []
    in_python = False
    written = False

    for line in lines:
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            # Leaving [python] without having seen our key — add it before we go.
            if in_python and not written:
                out.append(f"{key}=true\n")
                written = True
            in_python = stripped.lower() == "[python]"
        elif in_python and stripped.lower().startswith(f"{key}="):
            out.append(f"{key}=true\n")
            written = True
            continue
        out.append(line)

    if not written:
        if not any(l.strip().lower() == "[python]" for l in out):
            if out and not out[-1].endswith("\n"):
                out.append("\n")
            out.append("[python]\n")
            out.append(f"{key}=true\n")
        else:
            # We were inside [python] when the file ended.
            out.append(f"{key}=true\n")

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(out), encoding="utf-8")
    return True


def krita_running() -> bool:
    """Krita REWRITES kritarc when it exits, from the config it read at startup.

    So enabling the plugin while Krita is open gets silently undone the moment the
    user quits — the plugin looks installed and never loads. Callers must tell the
    user to close Krita first.
    """
    import subprocess

    try:
        if sys.platform == "win32":
            # Capture BYTES, not text: on a non-English Windows `tasklist` prints its
            # header in the console codepage (GBK etc.), which is not UTF-8, and
            # letting subprocess decode it crashes the reader thread — which would
            # silently make this probe always return False. The process name is
            # ASCII, so match at the byte level instead.
            out = subprocess.run(
                ["tasklist", "/FI", "IMAGENAME eq krita.exe"],
                capture_output=True,
                timeout=5,
            ).stdout
            return b"krita.exe" in out.lower()
        out = subprocess.run(
            ["pgrep", "-x", "krita"], capture_output=True, text=True, timeout=5
        )
        return out.returncode == 0
    except Exception:  # noqa: BLE001 - a failed probe must not block the install
        return False


def status() -> dict:
    target = pykrita_dir()
    if target is None:
        return {"installed": False, "error": "could not work out Krita's plugin directory"}

    installed = (target / PLUGIN_NAME).is_dir() and (
        target / f"{PLUGIN_NAME}.desktop"
    ).is_file()

    rc = kritarc_path()
    enabled = False
    if rc is not None and rc.exists():
        enabled = f"enable_{PLUGIN_NAME}=true" in rc.read_text(
            encoding="utf-8", errors="replace"
        )

    return {
        "installed": installed,
        "enabled": enabled,
        "pykrita_dir": str(target),
        # Krita only exists once the user has run it at least once.
        "krita_seen": target.parent.is_dir(),
    }


def install() -> dict:
    target = pykrita_dir()
    if target is None:
        raise RuntimeError("could not work out Krita's plugin directory")

    src_pkg = SOURCE / PLUGIN_NAME
    src_desktop = SOURCE / f"{PLUGIN_NAME}.desktop"
    if not src_pkg.is_dir() or not src_desktop.is_file():
        raise RuntimeError(f"the plugin source is missing from {SOURCE}")

    target.mkdir(parents=True, exist_ok=True)

    dst_pkg = target / PLUGIN_NAME
    if dst_pkg.exists():
        shutil.rmtree(dst_pkg)
    # __pycache__ from our repo would shadow the new code with stale bytecode.
    shutil.copytree(src_pkg, dst_pkg, ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copy2(src_desktop, target / f"{PLUGIN_NAME}.desktop")

    was_running = krita_running()
    enabled = _enable_in_kritarc()

    if was_running:
        note = (
            "Krita is running. QUIT Krita and run this install again — Krita "
            "rewrites its config on exit and will undo the enable flag, and the "
            "plugin will silently never load."
        )
    else:
        note = (
            "Start Krita. If it still does not connect, tick 'XYZ ComfyUI Bridge' "
            "in Settings > Configure Krita > Python Plugin Manager."
        )

    return {
        "ok": True,
        "installed_to": str(dst_pkg),
        "enabled": enabled,
        "krita_was_running": was_running,
        "note": note,
    }


def uninstall() -> dict:
    target = pykrita_dir()
    if target is None:
        raise RuntimeError("could not work out Krita's plugin directory")

    removed = []
    pkg = target / PLUGIN_NAME
    if pkg.is_dir():
        shutil.rmtree(pkg)
        removed.append(str(pkg))
    desktop = target / f"{PLUGIN_NAME}.desktop"
    if desktop.is_file():
        desktop.unlink()
        removed.append(str(desktop))

    return {"ok": True, "removed": removed}
