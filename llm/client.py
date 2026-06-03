"""Multi-provider chat-completions client.

`complete(cfg, messages, tools)` dispatches on `cfg['kind']`:
  - 'openai'    → OpenAI-compatible `{base_url}/chat/completions` (OpenAI, DeepSeek, Grok,
                  most custom endpoints).
  - 'anthropic' → Claude `{base_url}/v1/messages` via an adapter that converts the
                  OpenAI-style messages/tools in and the response back out, so the rest of
                  the stack (assembly / tool loop) stays provider-agnostic.

Both paths return the SAME normalized dict:
    {message:{role,content,tool_calls?}, finish_reason, usage, model, raw}

The route layer runs this via loop.run_in_executor so the event loop never blocks.
Non-streaming. curl_cffi is already a repo dependency (tagdb/scraper.py).
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional

ANTHROPIC_VERSION = "2023-06-01"
ANTHROPIC_MAX_TOKENS = 8192


class LlmError(Exception):
    """Raised for missing key, network failure, or a non-2xx API response."""


def _import_session():
    try:
        from curl_cffi import requests as cffi_requests  # noqa: PLC0415
        return cffi_requests
    except Exception as exc:  # pragma: no cover - depends on env
        raise LlmError(
            "curl_cffi is required for the LLM client (pip install curl_cffi)"
        ) from exc


def _raise_for_status(resp) -> Dict[str, Any]:
    status = getattr(resp, "status_code", 0)
    text = getattr(resp, "text", "") or ""
    if status < 200 or status >= 300:
        msg = text
        try:
            err = json.loads(text)
            msg = err.get("error", {}).get("message") or err.get("message") or text
        except Exception:
            pass
        raise LlmError(f"API {status}: {msg}"[:500])
    try:
        return json.loads(text)
    except Exception as exc:
        raise LlmError(f"bad JSON from API: {exc}") from exc


def _post(url: str, headers: Dict[str, str], payload: Dict[str, Any], timeout: int) -> Dict[str, Any]:
    cffi = _import_session()
    try:
        resp = cffi.post(url, data=json.dumps(payload), headers=headers, timeout=timeout)
    except Exception as exc:
        raise LlmError(f"network error: {exc}") from exc
    return _raise_for_status(resp)


def _get(url: str, headers: Dict[str, str], timeout: int) -> Dict[str, Any]:
    cffi = _import_session()
    try:
        resp = cffi.get(url, headers=headers, timeout=timeout)
    except Exception as exc:
        raise LlmError(f"network error: {exc}") from exc
    return _raise_for_status(resp)


def list_models(cfg: Dict[str, Any], *, timeout: int = 20) -> List[str]:
    """Fetch the provider's available model ids (GET /models or /v1/models).

    Works for OpenAI-compatible and Anthropic endpoints. Returns a sorted list of ids."""
    api_key = (cfg or {}).get("api_key") or ""
    if not api_key:
        raise LlmError("no_api_key")
    base_url = (cfg.get("base_url") or "").rstrip("/")
    if (cfg.get("kind") or "openai").lower() == "anthropic":
        url = base_url + "/v1/models"
        headers = {"x-api-key": api_key, "anthropic-version": ANTHROPIC_VERSION}
    else:
        url = base_url + "/models"
        headers = {"Authorization": f"Bearer {api_key}"}
    data = _get(url, headers, timeout)
    items = data.get("data") or data.get("models") or []
    ids: List[str] = []
    for it in items:
        if isinstance(it, dict):
            mid = it.get("id") or it.get("name")
            if mid:
                ids.append(mid)
        elif isinstance(it, str):
            ids.append(it)
    return sorted(set(ids))


def complete(
    cfg: Dict[str, Any],
    messages: List[Dict[str, Any]],
    *,
    tools: Optional[List[Dict[str, Any]]] = None,
    timeout: int = 180,
) -> Dict[str, Any]:
    api_key = (cfg or {}).get("api_key") or ""
    if not api_key:
        raise LlmError("no_api_key")
    kind = (cfg.get("kind") or "openai").lower()
    if kind == "anthropic":
        return _complete_anthropic(cfg, messages, tools, timeout)
    return _complete_openai(cfg, messages, tools, timeout)


# ---------------------------------------------------------------------------
# OpenAI-compatible
# ---------------------------------------------------------------------------

def _complete_openai(cfg, messages, tools, timeout) -> Dict[str, Any]:
    base_url = (cfg.get("base_url") or "https://api.openai.com/v1").rstrip("/")
    url = base_url + "/chat/completions"
    payload: Dict[str, Any] = {
        "model": cfg.get("model") or "gpt-4o",
        "messages": messages,
        "temperature": cfg.get("temperature", 1.0),
        "top_p": cfg.get("top_p", 1.0),
        "stream": False,
    }
    if tools:
        payload["tools"] = tools
    headers = {"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"}
    data = _post(url, headers, payload, timeout)
    try:
        choice = data["choices"][0]
        message = choice.get("message", {}) or {}
        finish = choice.get("finish_reason", "")
    except Exception as exc:
        raise LlmError(f"unexpected API shape: {exc}") from exc
    return {
        "message": message,
        "finish_reason": finish,
        "usage": data.get("usage"),
        "model": data.get("model") or payload["model"],
        "raw": data,
    }


# ---------------------------------------------------------------------------
# Anthropic (Claude) — adapter
# ---------------------------------------------------------------------------

def _openai_tools_to_anthropic(tools):
    out = []
    for t in tools or []:
        fn = t.get("function", t) or {}
        out.append({
            "name": fn.get("name"),
            "description": fn.get("description", ""),
            "input_schema": fn.get("parameters", {"type": "object", "properties": {}}),
        })
    return out


def _openai_messages_to_anthropic(messages):
    """Returns (system_str, anthropic_messages). Groups OpenAI `tool` messages into a
    user turn of tool_result blocks; converts assistant tool_calls into tool_use blocks."""
    system_parts: List[str] = []
    out: List[Dict[str, Any]] = []
    pending_tool_results: List[Dict[str, Any]] = []

    def _flush_tools():
        nonlocal pending_tool_results
        if pending_tool_results:
            out.append({"role": "user", "content": pending_tool_results})
            pending_tool_results = []

    for m in messages:
        role = m.get("role")
        if role == "system":
            if m.get("content"):
                system_parts.append(m["content"])
            continue
        if role == "tool":
            pending_tool_results.append({
                "type": "tool_result",
                "tool_use_id": m.get("tool_call_id"),
                "content": m.get("content") or "",
            })
            continue
        _flush_tools()
        if role == "assistant":
            tool_calls = m.get("tool_calls")
            if tool_calls:
                blocks: List[Dict[str, Any]] = []
                if m.get("content"):
                    blocks.append({"type": "text", "text": m["content"]})
                for tc in tool_calls:
                    fn = tc.get("function") or {}
                    try:
                        args = json.loads(fn.get("arguments") or "{}")
                    except Exception:
                        args = {}
                    blocks.append({"type": "tool_use", "id": tc.get("id"),
                                   "name": fn.get("name"), "input": args})
                out.append({"role": "assistant", "content": blocks})
            else:
                out.append({"role": "assistant", "content": m.get("content") or ""})
        else:  # user
            out.append({"role": "user", "content": m.get("content") or ""})
    _flush_tools()
    return ("\n\n".join(system_parts), out)


def _complete_anthropic(cfg, messages, tools, timeout) -> Dict[str, Any]:
    base_url = (cfg.get("base_url") or "https://api.anthropic.com").rstrip("/")
    url = base_url + "/v1/messages"
    system, amsgs = _openai_messages_to_anthropic(messages)
    payload: Dict[str, Any] = {
        "model": cfg.get("model") or "claude-sonnet-4-5",
        "max_tokens": ANTHROPIC_MAX_TOKENS,
        "messages": amsgs,
        "temperature": cfg.get("temperature", 1.0),
        "top_p": cfg.get("top_p", 1.0),
    }
    if system:
        payload["system"] = system
    if tools:
        payload["tools"] = _openai_tools_to_anthropic(tools)
    headers = {
        "x-api-key": cfg["api_key"],
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
    }
    data = _post(url, headers, payload, timeout)

    # Convert the response back to the OpenAI-normalized shape.
    text_parts: List[str] = []
    tool_calls: List[Dict[str, Any]] = []
    for block in data.get("content", []) or []:
        if block.get("type") == "text":
            text_parts.append(block.get("text", ""))
        elif block.get("type") == "tool_use":
            tool_calls.append({
                "id": block.get("id"),
                "type": "function",
                "function": {"name": block.get("name"),
                             "arguments": json.dumps(block.get("input", {}), ensure_ascii=False)},
            })
    message: Dict[str, Any] = {"role": "assistant", "content": "".join(text_parts)}
    if tool_calls:
        message["tool_calls"] = tool_calls
    u = data.get("usage", {}) or {}
    usage = {
        "prompt_tokens": u.get("input_tokens"),
        "completion_tokens": u.get("output_tokens"),
        "total_tokens": (u.get("input_tokens") or 0) + (u.get("output_tokens") or 0),
    }
    return {
        "message": message,
        "finish_reason": data.get("stop_reason", ""),
        "usage": usage,
        "model": data.get("model") or payload["model"],
        "raw": data,
    }
