"""Server-side LLM settings (api keys never touch the page / localStorage).

Multi-provider: the user picks an active `provider` (deepseek / openai / anthropic /
xai / custom); each provider keeps its own api_key + base_url + model so switching back
and forth never loses credentials. Shared across providers: temperature, top_p, and the
tag-lookup config. Stored as a single JSON file in
prompt_library_v2_data/llm_settings.json. Keys are returned masked from public().

`kind` selects the wire protocol: 'openai' (OpenAI/DeepSeek/Grok/most custom) vs
'anthropic' (Claude — different endpoint/headers/message+tool shape). The client layer
dispatches on it.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any, Dict

_PKG_DIR = Path(__file__).parent
_DATA_DIR = _PKG_DIR.parent / "prompt_library_v2_data"
_SETTINGS_PATH = _DATA_DIR / "llm_settings.json"
_TAGDB_DIR = _PKG_DIR.parent / "tagdb_data"

_LOCK = threading.Lock()

# The mask sentinel the frontend echoes back when the user did NOT retype the key.
MASK_SENTINEL = "__keep__"

# Built-in provider presets. `models` is just a suggestion list — the field is editable,
# so an evolving model name is never blocking. `custom` carries no preset (user fills all).
PROVIDER_PRESETS: Dict[str, Dict[str, Any]] = {
    "deepseek":  {"label": "DeepSeek",  "kind": "openai",
                  "base_url": "https://api.deepseek.com",
                  "models": ["deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"]},
    "openai":    {"label": "OpenAI (GPT)", "kind": "openai",
                  "base_url": "https://api.openai.com/v1",
                  "models": ["gpt-5.1", "gpt-5", "gpt-4.1", "gpt-4o", "o3"]},
    "anthropic": {"label": "Claude", "kind": "anthropic",
                  "base_url": "https://api.anthropic.com",
                  "models": ["claude-opus-4-1", "claude-sonnet-4-5", "claude-3-5-sonnet-latest"]},
    "xai":       {"label": "Grok (xAI)", "kind": "openai",
                  "base_url": "https://api.x.ai/v1",
                  "models": ["grok-4", "grok-3", "grok-beta"]},
    "custom":    {"label": "Custom", "kind": "openai", "base_url": "", "models": []},
}
_PROVIDER_IDS = list(PROVIDER_PRESETS.keys())

_SHARED_DEFAULTS: Dict[str, Any] = {
    "provider": "deepseek",
    "temperature": 1.0,
    "top_p": 1.0,
    "lookup_enabled": True,
    "lookup_sources": {"danbooru": True, "gelbooru": False},
    "seeded": False,
}


def _guess_provider(base_url: str) -> str:
    b = (base_url or "").lower()
    if "deepseek" in b: return "deepseek"
    if "openai" in b: return "openai"
    if "anthropic" in b: return "anthropic"
    if "x.ai" in b or "xai" in b: return "xai"
    return "custom"


def _empty_providers() -> Dict[str, Dict[str, Any]]:
    return {pid: {"api_key": "", "base_url": "", "model": "", "kind": ""} for pid in _PROVIDER_IDS}


def _normalize(data: Dict[str, Any]) -> Dict[str, Any]:
    """Normalize raw JSON into {shared..., provider, providers{id:{api_key,base_url,model,kind}}}.

    Migrates a legacy flat {api_key, base_url, model} layout into providers[<guess>]."""
    out: Dict[str, Any] = dict(_SHARED_DEFAULTS)
    for k in _SHARED_DEFAULTS:
        if k in data:
            out[k] = data[k]
    # lookup_sources nested merge
    src = dict(_SHARED_DEFAULTS["lookup_sources"])
    if isinstance(data.get("lookup_sources"), dict):
        src.update({k: bool(v) for k, v in data["lookup_sources"].items() if k in src})
    out["lookup_sources"] = src

    providers = _empty_providers()
    if isinstance(data.get("providers"), dict):
        for pid, pcfg in data["providers"].items():
            if pid in providers and isinstance(pcfg, dict):
                for f in ("api_key", "base_url", "model", "kind"):
                    if f in pcfg and pcfg[f] is not None:
                        providers[pid][f] = pcfg[f]
    elif data.get("api_key") or data.get("base_url") or data.get("model"):
        # legacy flat layout → fold into the guessed provider
        pid = _guess_provider(data.get("base_url", ""))
        providers[pid]["api_key"] = data.get("api_key", "")
        providers[pid]["base_url"] = data.get("base_url", "")
        providers[pid]["model"] = data.get("model", "")
        out["provider"] = pid
    out["providers"] = providers
    if out["provider"] not in _PROVIDER_IDS:
        out["provider"] = "deepseek"
    return out


def _read_raw() -> Dict[str, Any]:
    if not _SETTINGS_PATH.exists():
        return _normalize({})
    try:
        return _normalize(json.loads(_SETTINGS_PATH.read_text(encoding="utf-8")))
    except Exception:
        return _normalize({})


def _write_raw(data: Dict[str, Any]) -> None:
    _DATA_DIR.mkdir(exist_ok=True)
    tmp = _SETTINGS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
    tmp.replace(_SETTINGS_PATH)


def load() -> Dict[str, Any]:
    """Full normalized settings (incl. real keys) — server-internal use."""
    with _LOCK:
        return _read_raw()


def active_provider_config() -> Dict[str, Any]:
    """Resolved config for the active provider, merged with its preset. Used by the client.

    Returns {provider, kind, api_key, base_url, model, temperature, top_p}.
    """
    s = load()
    pid = s["provider"]
    preset = PROVIDER_PRESETS.get(pid, PROVIDER_PRESETS["custom"])
    saved = s["providers"].get(pid, {})
    models = preset.get("models") or []
    return {
        "provider": pid,
        "kind": saved.get("kind") or preset.get("kind") or "openai",
        "api_key": saved.get("api_key", ""),
        "base_url": (saved.get("base_url") or preset.get("base_url") or "").rstrip("/"),
        "model": saved.get("model") or (models[0] if models else ""),
        "temperature": s.get("temperature", 1.0),
        "top_p": s.get("top_p", 1.0),
    }


def _mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 4:
        return "…" + key
    return key[:3] + "…" + key[-4:]


def db_status() -> Dict[str, bool]:
    return {
        "danbooru": (_TAGDB_DIR / "danbooru.sqlite").exists(),
        "gelbooru": (_TAGDB_DIR / "gelbooru.sqlite").exists(),
    }


def public() -> Dict[str, Any]:
    """Frontend view: per-provider keys masked, presets included, plus db_status."""
    s = load()
    providers_pub: Dict[str, Any] = {}
    for pid in _PROVIDER_IDS:
        preset = PROVIDER_PRESETS[pid]
        saved = s["providers"].get(pid, {})
        key = saved.get("api_key", "")
        providers_pub[pid] = {
            "label": preset["label"],
            "kind": saved.get("kind") or preset.get("kind") or "openai",
            "default_kind": preset.get("kind", "openai"),
            "base_url": saved.get("base_url") or "",
            "preset_base_url": preset.get("base_url", ""),
            "model": saved.get("model") or "",
            "model_suggestions": preset.get("models", []),
            "has_key": bool(key),
            "api_key_masked": _mask_key(key),
            "is_custom": pid == "custom",
        }
    return {
        "provider": s["provider"],
        "provider_ids": _PROVIDER_IDS,
        "providers": providers_pub,
        "temperature": s["temperature"],
        "top_p": s["top_p"],
        "lookup_enabled": s["lookup_enabled"],
        "lookup_sources": s["lookup_sources"],
        "db_status": db_status(),
    }


def update(patch: Dict[str, Any]) -> Dict[str, Any]:
    """Merge a patch and persist. Recognized keys:
      - provider: switch the active provider
      - temperature / top_p / lookup_enabled / lookup_sources: shared
      - provider_update: {id, api_key?, base_url?, model?, kind?}  (api_key==MASK_SENTINEL=keep)
    Returns the new public() view.
    """
    with _LOCK:
        data = _read_raw()
        p = patch or {}

        if p.get("provider") in _PROVIDER_IDS:
            data["provider"] = p["provider"]
        if "temperature" in p:
            try: data["temperature"] = float(p["temperature"])
            except Exception: pass
        if "top_p" in p:
            try: data["top_p"] = float(p["top_p"])
            except Exception: pass
        if "lookup_enabled" in p:
            data["lookup_enabled"] = bool(p["lookup_enabled"])
        if isinstance(p.get("lookup_sources"), dict):
            src = dict(data.get("lookup_sources", {}))
            for sk, sv in p["lookup_sources"].items():
                if sk in ("danbooru", "gelbooru"):
                    src[sk] = bool(sv)
            data["lookup_sources"] = src
        if "seeded" in p:
            data["seeded"] = bool(p["seeded"])

        pu = p.get("provider_update")
        if isinstance(pu, dict) and pu.get("id") in _PROVIDER_IDS:
            pid = pu["id"]
            entry = data["providers"].setdefault(pid, {"api_key": "", "base_url": "", "model": "", "kind": ""})
            if "api_key" in pu and pu["api_key"] not in (None, MASK_SENTINEL):
                entry["api_key"] = str(pu["api_key"])
            if "base_url" in pu and pu["base_url"] is not None:
                entry["base_url"] = str(pu["base_url"]).strip()
            if "model" in pu and pu["model"] is not None:
                entry["model"] = str(pu["model"]).strip()
            if "kind" in pu and pu["kind"] in ("openai", "anthropic"):
                entry["kind"] = pu["kind"]

        _write_raw(data)
    return public()


def mark_seeded() -> None:
    with _LOCK:
        data = _read_raw()
        data["seeded"] = True
        _write_raw(data)


def is_seeded() -> bool:
    return bool(load().get("seeded"))
