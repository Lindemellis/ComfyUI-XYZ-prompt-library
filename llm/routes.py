"""LLM Prompt Assistant — HTTP routes (/xyz/llm/...).

Phase 1: settings + blocks/variants/conversations/messages CRUD. The DeepSeek chat
proxy + tool loop (POST /xyz/llm/chat) lands in Phase 2/6.

No direct SQL here — reads via the shared PLv2 repo, writes via its WriteQueue.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Dict, Optional

from aiohttp import web

try:  # runtime: llm is a subpackage of the custom-node root
    from ..prompt_library_v2 import repo as _repo
except ImportError:  # standalone (tests with the repo root on sys.path)
    from prompt_library_v2 import repo as _repo
from . import settings as _settings
from . import store as _store
from . import assembly as _assembly
from . import client as _client
from . import chat as _chat
from . import tools as _tools

logger = logging.getLogger("xyz.llm.routes")

_registered = False

__all__ = ["register"]


def _ok(data: Any) -> web.Response:
    return web.json_response(data)


def _err(status: int, code: str, msg: str) -> web.Response:
    return web.json_response({"error": {"code": code, "message": msg}}, status=status)


def _id(request: web.Request, key: str = "id") -> int:
    return int(request.match_info[key])


async def _json(request: web.Request) -> Dict[str, Any]:
    try:
        body = await request.json()
        return body if isinstance(body, dict) else {}
    except Exception:
        return {}


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

async def _get_settings(request: web.Request) -> web.Response:
    return _ok(_settings.public())


async def _post_settings(request: web.Request) -> web.Response:
    patch = await _json(request)
    try:
        return _ok(_settings.update(patch))
    except Exception as e:
        return _err(400, "bad_settings", str(e))


# ---------------------------------------------------------------------------
# Blocks
# ---------------------------------------------------------------------------

async def _get_blocks(request: web.Request) -> web.Response:
    return _ok({"blocks": _store.get_blocks()})


async def _post_block(request: web.Request) -> web.Response:
    b = await _json(request)
    name = str(b.get("name", "")).strip() or "New block"
    kind = str(b.get("kind", "custom")) or "custom"
    keep_turns = b.get("keep_turns")
    op = _repo.CreateLlmBlockOp(
        kind=kind,
        name=name,
        text=str(b.get("text", "")),
        enabled=bool(b.get("enabled", True)),
        order_index=int(b.get("order_index", 0)),
        keep_turns=None if keep_turns is None else int(keep_turns),
    )
    try:
        block_id = _repo.enqueue_write(_repo.MID, op).result(timeout=5)
    except Exception as e:
        return _err(500, "create_failed", str(e))
    return _ok({"id": block_id})


async def _patch_block(request: web.Request) -> web.Response:
    bid = _id(request)
    b = await _json(request)
    keep_turns_set = "keep_turns" in b
    op = _repo.UpdateLlmBlockOp(
        block_id=bid,
        name=b.get("name"),
        enabled=b.get("enabled"),
        order_index=b.get("order_index"),
        keep_turns=(int(b["keep_turns"]) if b.get("keep_turns") is not None else None),
        active_variant_id=b.get("active_variant_id"),
        keep_turns_set=keep_turns_set,
    )
    try:
        _repo.enqueue_write(_repo.MID, op).result(timeout=5)
    except Exception as e:
        return _err(500, "update_failed", str(e))
    return _ok({"ok": True})


async def _delete_block(request: web.Request) -> web.Response:
    bid = _id(request)
    try:
        _repo.enqueue_write(_repo.MID, _repo.DeleteLlmBlockOp(block_id=bid)).result(timeout=5)
    except Exception as e:
        return _err(500, "delete_failed", str(e))
    return _ok({"ok": True})


async def _reorder_blocks(request: web.Request) -> web.Response:
    b = await _json(request)
    raw = b.get("order") or {}
    try:
        order_map = {int(k): int(v) for k, v in raw.items()}
    except Exception:
        return _err(400, "bad_order", "order must be {block_id: index}")
    try:
        _repo.enqueue_write(_repo.MID, _repo.ReorderLlmBlocksOp(order_map=order_map)).result(timeout=5)
    except Exception as e:
        return _err(500, "reorder_failed", str(e))
    return _ok({"ok": True})


# ---------------------------------------------------------------------------
# Variants
# ---------------------------------------------------------------------------

async def _get_variants(request: web.Request) -> web.Response:
    return _ok({"variants": _store.get_variants(_id(request))})


async def _post_variant(request: web.Request) -> web.Response:
    bid = _id(request)
    b = await _json(request)
    op = _repo.UpsertLlmVariantOp(
        block_id=bid,
        text=str(b.get("text", "")),
        variant_name=str(b.get("variant_name", "default")) or "default",
    )
    try:
        vid = _repo.enqueue_write(_repo.MID, op).result(timeout=5)
        if bool(b.get("set_active", True)):
            _repo.enqueue_write(
                _repo.MID, _repo.SetActiveVariantOp(block_id=bid, variant_id=vid)
            ).result(timeout=5)
    except Exception as e:
        return _err(500, "variant_failed", str(e))
    return _ok({"id": vid})


async def _patch_variant(request: web.Request) -> web.Response:
    bid = _id(request)
    vid = _id(request, "vid")
    b = await _json(request)
    op = _repo.UpsertLlmVariantOp(
        block_id=bid,
        text=str(b.get("text", "")),
        variant_name=str(b.get("variant_name", "default")) or "default",
        variant_id=vid,
    )
    try:
        _repo.enqueue_write(_repo.MID, op).result(timeout=5)
    except Exception as e:
        return _err(500, "variant_failed", str(e))
    return _ok({"ok": True})


async def _delete_variant(request: web.Request) -> web.Response:
    vid = _id(request, "vid")
    try:
        _repo.enqueue_write(_repo.MID, _repo.DeleteLlmVariantOp(variant_id=vid)).result(timeout=5)
    except ValueError as e:
        return _err(400, "last_variant", str(e))
    except Exception as e:
        return _err(500, "delete_failed", str(e))
    return _ok({"ok": True})


async def _set_active_variant(request: web.Request) -> web.Response:
    bid = _id(request)
    b = await _json(request)
    vid = b.get("variant_id")
    if vid is None:
        return _err(400, "missing", "variant_id required")
    try:
        _repo.enqueue_write(
            _repo.MID, _repo.SetActiveVariantOp(block_id=bid, variant_id=int(vid))
        ).result(timeout=5)
    except Exception as e:
        return _err(500, "active_failed", str(e))
    return _ok({"ok": True})


# ---------------------------------------------------------------------------
# Conversations + messages
# ---------------------------------------------------------------------------

async def _get_conversations(request: web.Request) -> web.Response:
    return _ok({"conversations": _store.get_conversations()})


async def _post_conversation(request: web.Request) -> web.Response:
    b = await _json(request)
    op = _repo.CreateConversationOp(title=str(b.get("title", "")))
    try:
        cid = _repo.enqueue_write(_repo.MID, op).result(timeout=5)
    except Exception as e:
        return _err(500, "create_failed", str(e))
    return _ok({"id": cid})


async def _patch_conversation(request: web.Request) -> web.Response:
    cid = _id(request)
    b = await _json(request)
    title = b.get("title")
    if title is None:
        return _err(400, "missing", "title required")
    try:
        _repo.enqueue_write(
            _repo.MID, _repo.RenameConversationOp(conversation_id=cid, title=str(title))
        ).result(timeout=5)
    except Exception as e:
        return _err(500, "rename_failed", str(e))
    return _ok({"ok": True})


async def _delete_conversation(request: web.Request) -> web.Response:
    cid = _id(request)
    try:
        _repo.enqueue_write(
            _repo.MID, _repo.DeleteConversationOp(conversation_id=cid)
        ).result(timeout=5)
    except Exception as e:
        return _err(500, "delete_failed", str(e))
    return _ok({"ok": True})


async def _get_messages(request: web.Request) -> web.Response:
    return _ok({"messages": _store.get_messages(_id(request))})


async def _post_message(request: web.Request) -> web.Response:
    cid = _id(request)
    b = await _json(request)
    role = str(b.get("role", "")).strip()
    if role not in ("user", "assistant", "tool"):
        return _err(400, "bad_role", "role must be user|assistant|tool")
    meta = b.get("meta")
    op = _repo.AppendMessageOp(
        conversation_id=cid,
        role=role,
        content=str(b.get("content", "")),
        meta=meta if isinstance(meta, dict) else None,
    )
    try:
        mid = _repo.enqueue_write(_repo.MID, op).result(timeout=5)
    except Exception as e:
        return _err(500, "append_failed", str(e))
    return _ok({"id": mid})


# ---------------------------------------------------------------------------
# Chat proxy (tool loop)
# ---------------------------------------------------------------------------

async def _post_chat(request: web.Request) -> web.Response:
    """POST /xyz/llm/chat — assemble messages from blocks+history, run the tool loop,
    persist (when conversation_id given), and return the assistant message + trace."""
    b = await _json(request)
    conversation_id = b.get("conversation_id")
    conversation_id = int(conversation_id) if conversation_id else None
    base_prompt = str(b.get("base_prompt", "") or "")
    user_request = str(b.get("user_request", "") or "")
    if not user_request.strip() and not base_prompt.strip():
        return _err(400, "empty", "user_request (or base_prompt) is required")

    shared = _settings.load()
    pcfg = _settings.active_provider_config()
    if not (pcfg.get("api_key") or "").strip():
        return _err(400, "no_api_key",
                    f"Set an API key for {pcfg.get('provider', 'the active provider')} in Settings → LLM first.")

    sources = _tools.resolve_sources(shared)
    enable_tools = bool(shared.get("lookup_enabled", True)) and len(sources) > 0

    messages = _assembly.build_messages(conversation_id, base_prompt, user_request)

    # Persist the user turn up-front (kept even if generation later fails / is stopped).
    user_msg_id = None
    if conversation_id:
        meta = {"base_prompt": base_prompt} if base_prompt.strip() else None
        try:
            user_msg_id = _repo.enqueue_write(
                _repo.MID,
                _repo.AppendMessageOp(conversation_id=conversation_id, role="user",
                                      content=user_request, meta=meta),
            ).result(timeout=5)
        except Exception as e:
            return _err(500, "persist_failed", str(e))

    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            None,
            lambda: _chat.run_chat(pcfg, messages, enable_tools=enable_tools, sources=sources),
        )
    except _client.LlmError as e:
        code = "no_api_key" if str(e) == "no_api_key" else "api_error"
        status = 400 if code == "no_api_key" else 502
        return _err(status, code, str(e))
    except Exception as e:
        return _err(502, "api_error", str(e))

    assistant = result.get("message") or {}
    content = assistant.get("content") or ""
    trace = result.get("trace") or []

    assistant_msg_id = None
    if conversation_id:
        # Persist tool results (for the verified-tag digest) then the assistant message.
        for t in trace:
            try:
                _repo.enqueue_write(
                    _repo.MID,
                    _repo.AppendMessageOp(
                        conversation_id=conversation_id, role="tool",
                        content=json.dumps(t.get("results") or [], ensure_ascii=False),
                        meta={"name": t.get("name"), "args": t.get("args")},
                    ),
                ).result(timeout=5)
            except Exception:
                logger.exception("failed to persist tool message")
        try:
            assistant_msg_id = _repo.enqueue_write(
                _repo.MID,
                _repo.AppendMessageOp(
                    conversation_id=conversation_id, role="assistant", content=content,
                    meta={"model": result.get("model"), "usage": result.get("usage"),
                          "trace": trace, "capped": result.get("capped", False)},
                ),
            ).result(timeout=5)
        except Exception as e:
            return _err(500, "persist_failed", str(e))

    return _ok({
        "message": {"role": "assistant", "content": content},
        "usage": result.get("usage"),
        "model": result.get("model"),
        "trace": trace,
        "capped": result.get("capped", False),
        "user_msg_id": user_msg_id,
        "assistant_msg_id": assistant_msg_id,
    })


async def _post_test(request: web.Request) -> web.Response:
    """POST /xyz/llm/test — a tiny live completion to validate the active provider's
    key / base_url / model. Returns {ok, model, reply} or a structured error."""
    pcfg = _settings.active_provider_config()
    if not (pcfg.get("api_key") or "").strip():
        return _err(400, "no_api_key", f"No API key set for {pcfg.get('provider')}.")
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            None,
            lambda: _client.complete(pcfg, [{"role": "user", "content": "Reply with exactly: OK"}],
                                     tools=None, timeout=30),
        )
        return _ok({"ok": True, "provider": pcfg["provider"], "model": result.get("model"),
                    "reply": (result["message"].get("content") or "")[:80]})
    except _client.LlmError as e:
        return _err(502, "api_error", str(e))
    except Exception as e:
        return _err(502, "api_error", str(e))


async def _post_models(request: web.Request) -> web.Response:
    """POST /xyz/llm/models — fetch the active provider's available model ids."""
    pcfg = _settings.active_provider_config()
    if not (pcfg.get("api_key") or "").strip():
        return _err(400, "no_api_key", f"No API key set for {pcfg.get('provider')}.")
    loop = asyncio.get_event_loop()
    try:
        models = await loop.run_in_executor(None, lambda: _client.list_models(pcfg))
        return _ok({"provider": pcfg["provider"], "models": models})
    except _client.LlmError as e:
        code = "no_api_key" if str(e) == "no_api_key" else "api_error"
        return _err(400 if code == "no_api_key" else 502, code, str(e))
    except Exception as e:
        return _err(502, "api_error", str(e))


async def _delete_last_assistant(request: web.Request) -> web.Response:
    """DELETE /xyz/llm/conversations/{id}/last-assistant — drop the trailing assistant
    turn (and any tool messages after the last user turn) so the client can regenerate.

    `?include_user=1` also drops the last user message, so a regenerate can resend it
    cleanly without leaving a duplicate."""
    cid = _id(request)
    include_user = request.rel_url.query.get("include_user") in ("1", "true", "yes")
    msgs = _repo.get_messages(cid)
    # find the last user message index
    last_user = -1
    for i, m in enumerate(msgs):
        if m.get("role") == "user":
            last_user = i
    start = last_user if include_user else last_user + 1
    to_delete = [m["id"] for m in msgs[start:]] if last_user >= 0 else []
    for mid in to_delete:
        try:
            _repo.enqueue_write(_repo.MID, _repo.DeleteMessageOp(message_id=mid)).result(timeout=5)
        except Exception:
            logger.exception("failed to delete message %s", mid)
    return _ok({"deleted": to_delete})


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

def register(server) -> None:
    """Register all /xyz/llm/ routes. Idempotent."""
    global _registered
    if _registered:
        return
    r = server.routes

    r.get("/xyz/llm/settings")(_get_settings)
    r.post("/xyz/llm/settings")(_post_settings)

    r.get("/xyz/llm/blocks")(_get_blocks)
    r.post("/xyz/llm/blocks")(_post_block)
    r.post("/xyz/llm/blocks/reorder")(_reorder_blocks)
    r.patch(r"/xyz/llm/blocks/{id:\d+}")(_patch_block)
    r.delete(r"/xyz/llm/blocks/{id:\d+}")(_delete_block)

    r.get(r"/xyz/llm/blocks/{id:\d+}/variants")(_get_variants)
    r.post(r"/xyz/llm/blocks/{id:\d+}/variants")(_post_variant)
    r.post(r"/xyz/llm/blocks/{id:\d+}/active-variant")(_set_active_variant)
    r.patch(r"/xyz/llm/blocks/{id:\d+}/variants/{vid:\d+}")(_patch_variant)
    r.delete(r"/xyz/llm/blocks/{id:\d+}/variants/{vid:\d+}")(_delete_variant)

    r.get("/xyz/llm/conversations")(_get_conversations)
    r.post("/xyz/llm/conversations")(_post_conversation)
    r.patch(r"/xyz/llm/conversations/{id:\d+}")(_patch_conversation)
    r.delete(r"/xyz/llm/conversations/{id:\d+}")(_delete_conversation)
    r.get(r"/xyz/llm/conversations/{id:\d+}/messages")(_get_messages)
    r.post(r"/xyz/llm/conversations/{id:\d+}/messages")(_post_message)
    r.delete(r"/xyz/llm/conversations/{id:\d+}/last-assistant")(_delete_last_assistant)

    r.post("/xyz/llm/chat")(_post_chat)
    r.post("/xyz/llm/test")(_post_test)
    r.post("/xyz/llm/models")(_post_models)

    _registered = True
    logger.info("LLM routes registered")
