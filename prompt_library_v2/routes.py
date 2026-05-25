"""Prompt Library V2 — HTTP routes.

All routes are registered under /xyz/plv2/.
No direct SQL here — reads go through repo, writes through WriteQueue.
After any mutation that affects trigger names, rebuild_auto_triggers() is called.

Endpoints:
  GET    /xyz/plv2/nodes                      — full tree
  POST   /xyz/plv2/nodes                      — create node
  PATCH  /xyz/plv2/nodes/{id}                 — update fields / rename
  DELETE /xyz/plv2/nodes/{id}                 — delete subtree
  POST   /xyz/plv2/nodes/{id}/move            — reparent + rename

  GET    /xyz/plv2/nodes/{id}/prompts         — list prompts
  POST   /xyz/plv2/nodes/{id}/prompts         — add prompt
  PATCH  /xyz/plv2/prompts/{id}               — update prompt
  DELETE /xyz/plv2/prompts/{id}               — delete prompt
  POST   /xyz/plv2/nodes/{id}/prompts/reorder — bulk reorder

  GET    /xyz/plv2/nodes/{id}/triggers        — list triggers
  POST   /xyz/plv2/nodes/{id}/triggers        — add custom trigger
  DELETE /xyz/plv2/triggers/{id}              — delete custom trigger

  POST   /xyz/plv2/nodes/{id}/preview         — preview entry text (no recursion)
  POST   /xyz/plv2/resolve                    — resolve full template string

  GET    /xyz/plv2/common/formats             — shared formats
  GET    /xyz/plv2/common/delimiters          — shared delimiters

  GET    /xyz/plv2/nodes/{id}/template_slots  — list template slots for a folder node
  POST   /xyz/plv2/nodes/{id}/template_slots  — create template slot
  PATCH  /xyz/plv2/template_slots/{id}        — update template slot
  DELETE /xyz/plv2/template_slots/{id}        — delete template slot
  GET    /xyz/plv2/template_slots/{id}/prompts — list default prompts for a slot
  POST   /xyz/plv2/template_slots/{id}/prompts — add default prompt to a slot
  PATCH  /xyz/plv2/template_prompts/{id}      — update a template prompt
  DELETE /xyz/plv2/template_prompts/{id}      — delete a template prompt
"""

from __future__ import annotations

import logging
import random as _random
import re
from typing import Any, Dict, Optional

# ---------------------------------------------------------------------------
# unused-import guard (aiohttp is a ComfyUI dep; imported for type hints)
# ---------------------------------------------------------------------------

from aiohttp import web

from . import repo as _repo
from . import engine as _engine
from .trigger import (
    rebuild_auto_triggers, resolve_trigger, trigger_name_conflict,
    prune_shadowed_triggers,
)

logger = logging.getLogger("xyz.plv2.routes")

_registered = False

__all__ = ["register"]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ok(data: Any) -> web.Response:
    return web.json_response(data)


def _err(status: int, code: str, msg: str) -> web.Response:
    return web.json_response({"error": {"code": code, "message": msg}}, status=status)


def _node_id(request: web.Request) -> int:
    return int(request.match_info["id"])


def _compute_full_path(parent_id: Optional[int], name: str) -> str:
    """Compute full_path for a new or renamed node."""
    if parent_id is None:
        return name
    parent = _repo.get_node(parent_id)
    if parent is None:
        raise ValueError(f"parent node {parent_id} not found")
    return parent["full_path"] + "." + name


# Characters that would be mistaken for delimiters / path separators / refs and
# create ambiguity in prompts and references (#2). A name is a single path
# segment so it may not contain "." either.
_NAME_BAD_RE    = re.compile(r"[.,|/\\\[\]]")
# A trigger may be a dotted path (e.g. "toki.name"), so "." is allowed there.
_TRIGGER_BAD_RE = re.compile(r"[,|/\\\[\]\s]")


def _validate_name(name: str) -> Optional[str]:
    """Return error message if name is invalid, else None."""
    if not name or not name.strip():
        return "name must not be empty"
    if "." in name:
        return "name must not contain dots (dots are path separators)"
    if _NAME_BAD_RE.search(name):
        return "name must not contain any of  . , | / \\ [ ]  (they clash with delimiters/paths)"
    return None


# ---------------------------------------------------------------------------
# Node CRUD
# ---------------------------------------------------------------------------

async def _get_nodes(request: web.Request) -> web.Response:
    """GET /xyz/plv2/nodes — return the full node tree as a flat list."""
    nodes = _repo.get_tree()
    return _ok({"nodes": nodes})


async def _post_nodes(request: web.Request) -> web.Response:
    """POST /xyz/plv2/nodes — create a new node."""
    try:
        body: Dict = await request.json()
    except Exception:
        return _err(400, "bad_json", "request body must be valid JSON")

    name = str(body.get("name", "")).strip()
    err = _validate_name(name)
    if err:
        return _err(400, "invalid_name", err)

    parent_id: Optional[int] = body.get("parent_id")
    if parent_id is not None:
        parent_id = int(parent_id)

    try:
        full_path = _compute_full_path(parent_id, name)
    except ValueError as e:
        return _err(404, "parent_not_found", str(e))

    # Check uniqueness
    if _repo.get_node_by_path(full_path) is not None:
        return _err(409, "path_conflict", f"a node at '{full_path}' already exists")

    op = _repo.CreateNodeOp(
        parent_id=parent_id,
        name=name,
        full_path=full_path,
        has_template=bool(body.get("has_template", False)),
        has_prompts=bool(body.get("has_prompts", True)),
        pos_neg=str(body.get("pos_neg", "positive")),
        order_index=int(body.get("order_index", 0)),
    )
    try:
        node_id = _repo.enqueue_write(_repo.HIGH, op).result(timeout=5)
    except Exception as e:
        logger.exception("create node failed")
        return _err(500, "internal", str(e))

    removed = prune_shadowed_triggers()   # a new full_path may shadow an existing custom trigger
    rebuild_auto_triggers()
    node = _repo.get_node(node_id)
    return web.json_response({"node": node, "removed_triggers": removed}, status=201)


async def _patch_node(request: web.Request) -> web.Response:
    """PATCH /xyz/plv2/nodes/{id} — update node fields. Rename triggers cascade."""
    try:
        body: Dict = await request.json()
    except Exception:
        return _err(400, "bad_json", "request body must be valid JSON")

    nid = _node_id(request)
    node = _repo.get_node(nid)
    if node is None:
        return _err(404, "not_found", f"node {nid} not found")

    # Handle rename (name change → must cascade full_path for subtree)
    new_name = body.get("name")
    triggers_changed = False

    if new_name is not None:
        new_name = str(new_name).strip()
        err = _validate_name(new_name)
        if err:
            return _err(400, "invalid_name", err)

        if new_name != node["name"]:
            try:
                new_full_path = _compute_full_path(node["parent_id"], new_name)
            except ValueError as e:
                return _err(404, "parent_not_found", str(e))

            if _repo.get_node_by_path(new_full_path) is not None:
                return _err(409, "path_conflict",
                            f"a node at '{new_full_path}' already exists")

            move_op = _repo.MoveNodeOp(
                node_id=nid,
                new_parent_id=node["parent_id"],
                new_name=new_name,
                old_full_path=node["full_path"],
                new_full_path=new_full_path,
            )
            try:
                _repo.enqueue_write(_repo.HIGH, move_op).result(timeout=5)
            except Exception as e:
                logger.exception("rename failed")
                return _err(500, "internal", str(e))
            triggers_changed = True

    # Update remaining scalar fields
    scalar_fields = {
        "has_template", "has_prompts", "pos_neg", "shuffle",
        "random_mode", "select_min", "select_max", "dropout_rate",
        "format", "delimiter", "order_index",
    }
    update_kwargs = {k: body[k] for k in scalar_fields if k in body}
    if update_kwargs:
        op = _repo.UpdateNodeOp(node_id=nid, **update_kwargs)
        try:
            _repo.enqueue_write(_repo.HIGH, op).result(timeout=5)
        except Exception as e:
            logger.exception("update node failed")
            return _err(500, "internal", str(e))
        if "has_prompts" in update_kwargs:
            triggers_changed = True

    removed = []
    if triggers_changed:
        removed = prune_shadowed_triggers()   # rename may shadow a custom trigger
        rebuild_auto_triggers()

    node = _repo.get_node(nid)
    return _ok({"node": node, "removed_triggers": removed})


async def _delete_node(request: web.Request) -> web.Response:
    """DELETE /xyz/plv2/nodes/{id} — delete node and its entire subtree."""
    nid = _node_id(request)
    if _repo.get_node(nid) is None:
        return _err(404, "not_found", f"node {nid} not found")

    try:
        _repo.enqueue_write(_repo.HIGH, _repo.DeleteNodeOp(node_id=nid)).result(timeout=5)
    except Exception as e:
        logger.exception("delete node failed")
        return _err(500, "internal", str(e))

    rebuild_auto_triggers()
    return web.json_response({"deleted": nid})


async def _move_node(request: web.Request) -> web.Response:
    """POST /xyz/plv2/nodes/{id}/move — reparent (and optionally rename) a node."""
    try:
        body: Dict = await request.json()
    except Exception:
        return _err(400, "bad_json", "request body must be valid JSON")

    nid = _node_id(request)
    node = _repo.get_node(nid)
    if node is None:
        return _err(404, "not_found", f"node {nid} not found")

    new_parent_id: Optional[int] = body.get("parent_id")  # None = root
    if new_parent_id is not None:
        new_parent_id = int(new_parent_id)
        if new_parent_id == nid:
            return _err(400, "invalid_move", "a node cannot be its own parent")
        # Prevent moving into own subtree
        subtree = _repo.get_subtree_paths(node["full_path"])
        if new_parent_id in {
            _repo.get_node_by_path(p)["id"]
            for p in subtree
            if _repo.get_node_by_path(p)
        }:
            return _err(400, "invalid_move", "cannot move a node into its own subtree")

    new_name = str(body.get("name", node["name"])).strip()
    err = _validate_name(new_name)
    if err:
        return _err(400, "invalid_name", err)

    try:
        new_full_path = _compute_full_path(new_parent_id, new_name)
    except ValueError as e:
        return _err(404, "parent_not_found", str(e))

    existing = _repo.get_node_by_path(new_full_path)
    if existing and existing["id"] != nid:
        return _err(409, "path_conflict", f"a node at '{new_full_path}' already exists")

    op = _repo.MoveNodeOp(
        node_id=nid,
        new_parent_id=new_parent_id,
        new_name=new_name,
        old_full_path=node["full_path"],
        new_full_path=new_full_path,
    )
    try:
        _repo.enqueue_write(_repo.HIGH, op).result(timeout=5)
    except Exception as e:
        logger.exception("move node failed")
        return _err(500, "internal", str(e))

    removed = prune_shadowed_triggers()   # move changes full_paths → may shadow a custom trigger
    rebuild_auto_triggers()
    return _ok({"node": _repo.get_node(nid), "removed_triggers": removed})


# ---------------------------------------------------------------------------
# Prompt CRUD
# ---------------------------------------------------------------------------

async def _get_prompts(request: web.Request) -> web.Response:
    """GET /xyz/plv2/nodes/{id}/prompts"""
    nid = _node_id(request)
    if _repo.get_node(nid) is None:
        return _err(404, "not_found", f"node {nid} not found")
    return _ok({"prompts": _repo.get_prompts(nid)})


async def _post_prompt(request: web.Request) -> web.Response:
    """POST /xyz/plv2/nodes/{id}/prompts — add a prompt to an entry."""
    try:
        body: Dict = await request.json()
    except Exception:
        return _err(400, "bad_json", "request body must be valid JSON")

    nid = _node_id(request)
    if _repo.get_node(nid) is None:
        return _err(404, "not_found", f"node {nid} not found")

    content = str(body.get("content", "")).strip()
    if not content:
        return _err(400, "invalid_content", "content must not be empty")

    existing = _repo.get_prompts(nid)
    max_order = max((p["order_index"] for p in existing), default=-1) + 1

    op = _repo.UpsertPromptOp(
        node_id=nid,
        content=content,
        weight=float(body.get("weight", 1.0)),
        enabled=bool(body.get("enabled", True)),
        order_index=int(body.get("order_index", max_order)),
        source=str(body.get("source", "custom")),
    )
    try:
        prompt_id = _repo.enqueue_write(_repo.HIGH, op).result(timeout=5)
    except Exception as e:
        logger.exception("add prompt failed")
        return _err(500, "internal", str(e))

    prompts = _repo.get_prompts(nid)
    created = next((p for p in prompts if p["id"] == prompt_id), None)
    return web.json_response({"prompt": created}, status=201)


async def _patch_prompt(request: web.Request) -> web.Response:
    """PATCH /xyz/plv2/prompts/{id} — update prompt fields."""
    try:
        body: Dict = await request.json()
    except Exception:
        return _err(400, "bad_json", "request body must be valid JSON")

    pid = _node_id(request)
    row = _repo.get_prompt(pid)
    if row is None:
        return _err(404, "not_found", f"prompt {pid} not found")

    nid = int(row["node_id"])

    content = body.get("content")
    if content is not None:
        content = str(content).strip()
        if not content:
            return _err(400, "invalid_content", "content must not be empty")

    op = _repo.UpsertPromptOp(
        node_id=nid,
        content=content if content is not None else str(row["content"]),
        weight=float(body.get("weight", row["weight"])),
        enabled=bool(body.get("enabled", row["enabled"])),
        order_index=int(body.get("order_index", row["order_index"])),
        source=str(row["source"]),   # source is immutable after creation
        prompt_id=pid,
    )
    try:
        _repo.enqueue_write(_repo.HIGH, op).result(timeout=5)
    except Exception as e:
        logger.exception("patch prompt failed")
        return _err(500, "internal", str(e))

    return _ok({"prompt_id": pid, "node_id": nid})


async def _delete_prompt(request: web.Request) -> web.Response:
    """DELETE /xyz/plv2/prompts/{id}"""
    pid = _node_id(request)
    try:
        _repo.enqueue_write(
            _repo.HIGH, _repo.DeletePromptOp(prompt_id=pid)
        ).result(timeout=5)
    except ValueError as e:
        return _err(403, "locked", str(e))
    except Exception as e:
        logger.exception("delete prompt failed")
        return _err(500, "internal", str(e))
    return web.json_response({"deleted": pid})


async def _reorder_prompts(request: web.Request) -> web.Response:
    """POST /xyz/plv2/nodes/{id}/prompts/reorder
    Body: {"order": [[prompt_id, new_index], ...]}
    """
    try:
        body: Dict = await request.json()
    except Exception:
        return _err(400, "bad_json", "request body must be valid JSON")

    nid = _node_id(request)
    if _repo.get_node(nid) is None:
        return _err(404, "not_found", f"node {nid} not found")

    order_list = body.get("order", [])
    order_map = {int(pair[0]): int(pair[1]) for pair in order_list}

    try:
        _repo.enqueue_write(
            _repo.HIGH, _repo.ReorderPromptsOp(node_id=nid, order_map=order_map)
        ).result(timeout=5)
    except Exception as e:
        logger.exception("reorder prompts failed")
        return _err(500, "internal", str(e))

    return _ok({"prompts": _repo.get_prompts(nid)})


# ---------------------------------------------------------------------------
# Trigger management
# ---------------------------------------------------------------------------

async def _get_triggers(request: web.Request) -> web.Response:
    """GET /xyz/plv2/nodes/{id}/triggers"""
    nid = _node_id(request)
    if _repo.get_node(nid) is None:
        return _err(404, "not_found", f"node {nid} not found")
    return _ok({"triggers": _repo.get_triggers(nid)})


async def _post_trigger(request: web.Request) -> web.Response:
    """POST /xyz/plv2/nodes/{id}/triggers — add a custom trigger alias."""
    try:
        body: Dict = await request.json()
    except Exception:
        return _err(400, "bad_json", "request body must be valid JSON")

    nid = _node_id(request)
    if _repo.get_node(nid) is None:
        return _err(404, "not_found", f"node {nid} not found")

    text = str(body.get("trigger_text", "")).strip()
    if not text:
        return _err(400, "invalid_trigger", "trigger_text must not be empty")
    if _TRIGGER_BAD_RE.search(text):
        return _err(400, "invalid_trigger",
                    "trigger name must not contain spaces, brackets, or any of  , | / \\")

    # Unambiguity: a trigger must not collide with an existing trigger, any node
    # path, or any entry's default (entry-only) name (#1).
    conflict = trigger_name_conflict(text)
    if conflict:
        return _err(409, "trigger_conflict", conflict)

    try:
        _repo.enqueue_write(
            _repo.HIGH,
            _repo.UpsertTriggerOp(node_id=nid, trigger_text=text, is_auto=False),
        ).result(timeout=5)
    except ValueError as e:
        return _err(409, "trigger_conflict", str(e))
    except Exception as e:
        logger.exception("add trigger failed")
        return _err(500, "internal", str(e))

    # Adding a custom trigger may free up a shorter auto-trigger for another node
    rebuild_auto_triggers()
    return web.json_response({"triggers": _repo.get_triggers(nid)}, status=201)


async def _delete_trigger(request: web.Request) -> web.Response:
    """DELETE /xyz/plv2/triggers/{id} — delete a custom trigger."""
    tid = _node_id(request)
    try:
        _repo.enqueue_write(
            _repo.HIGH, _repo.DeleteTriggerOp(trigger_id=tid)
        ).result(timeout=5)
    except ValueError as e:
        return _err(403, "auto_trigger", str(e))
    except Exception as e:
        logger.exception("delete trigger failed")
        return _err(500, "internal", str(e))

    rebuild_auto_triggers()
    return web.json_response({"deleted": tid})


# ---------------------------------------------------------------------------
# Template slots
# ---------------------------------------------------------------------------

async def _get_template_slots(request: web.Request) -> web.Response:
    """GET /xyz/plv2/nodes/{id}/template_slots"""
    nid = _node_id(request)
    if _repo.get_node(nid) is None:
        return _err(404, "not_found", f"node {nid} not found")
    slots = _repo.get_template_slots(nid)
    return _ok({"slots": slots})


async def _post_template_slot(request: web.Request) -> web.Response:
    """POST /xyz/plv2/nodes/{id}/template_slots"""
    try:
        body: Dict = await request.json()
    except Exception:
        return _err(400, "bad_json", "request body must be valid JSON")
    nid = _node_id(request)
    if _repo.get_node(nid) is None:
        return _err(404, "not_found", f"node {nid} not found")
    tmpl = str(body.get("sub_name_template", "")).strip()
    if not tmpl:
        return _err(400, "invalid_template", "sub_name_template must not be empty")
    existing_slots = _repo.get_template_slots(nid)
    max_order = max((s["order_index"] for s in existing_slots), default=-1) + 1
    try:
        slot_id = _repo.enqueue_write(
            _repo.HIGH,
            _repo.CreateTemplateSlotOp(
                folder_node_id=nid,
                sub_name_template=tmpl,
                order_index=int(body.get("order_index", max_order)),
            ),
        ).result(timeout=5)
    except Exception as e:
        logger.exception("create template slot failed")
        return _err(500, "internal", str(e))
    slots = _repo.get_template_slots(nid)
    created = next((s for s in slots if s["id"] == slot_id), None)
    return web.json_response({"slot": created, "slots": slots}, status=201)


async def _patch_template_slot(request: web.Request) -> web.Response:
    """PATCH /xyz/plv2/template_slots/{id}"""
    try:
        body: Dict = await request.json()
    except Exception:
        return _err(400, "bad_json", "request body must be valid JSON")
    sid = _node_id(request)
    tmpl = body.get("sub_name_template")
    order = body.get("order_index")
    try:
        _repo.enqueue_write(
            _repo.HIGH,
            _repo.UpdateTemplateSlotOp(
                slot_id=sid,
                sub_name_template=str(tmpl).strip() if tmpl is not None else None,
                order_index=int(order) if order is not None else None,
            ),
        ).result(timeout=5)
    except Exception as e:
        logger.exception("update template slot failed")
        return _err(500, "internal", str(e))
    return _ok({"slot_id": sid})


async def _delete_template_slot(request: web.Request) -> web.Response:
    """DELETE /xyz/plv2/template_slots/{id}"""
    sid = _node_id(request)
    try:
        _repo.enqueue_write(_repo.HIGH, _repo.DeleteTemplateSlotOp(slot_id=sid)).result(timeout=5)
    except Exception as e:
        logger.exception("delete template slot failed")
        return _err(500, "internal", str(e))
    return web.json_response({"deleted": sid})


async def _get_slot_prompts(request: web.Request) -> web.Response:
    """GET /xyz/plv2/template_slots/{id}/prompts"""
    sid = _node_id(request)
    return _ok({"prompts": _repo.get_template_slot_prompts(sid)})


async def _post_slot_prompt(request: web.Request) -> web.Response:
    """POST /xyz/plv2/template_slots/{id}/prompts"""
    try:
        body: Dict = await request.json()
    except Exception:
        return _err(400, "bad_json", "request body must be valid JSON")
    sid = _node_id(request)
    content = str(body.get("content", "")).strip()
    if not content:
        return _err(400, "invalid_content", "content must not be empty")
    existing = _repo.get_template_slot_prompts(sid)
    max_order = max((p["order_index"] for p in existing), default=-1) + 1
    try:
        pid = _repo.enqueue_write(
            _repo.HIGH,
            _repo.CreateTemplatePromptOp(
                slot_id=sid,
                content=content,
                weight=float(body.get("weight", 1.0)),
                enabled=bool(body.get("enabled", True)),
                order_index=int(body.get("order_index", max_order)),
            ),
        ).result(timeout=5)
    except Exception as e:
        logger.exception("create slot prompt failed")
        return _err(500, "internal", str(e))
    prompts = _repo.get_template_slot_prompts(sid)
    created = next((p for p in prompts if p["id"] == pid), None)
    return web.json_response({"prompt": created}, status=201)


async def _patch_slot_prompt(request: web.Request) -> web.Response:
    """PATCH /xyz/plv2/template_prompts/{id}"""
    try:
        body: Dict = await request.json()
    except Exception:
        return _err(400, "bad_json", "request body must be valid JSON")
    pid = _node_id(request)
    try:
        _repo.enqueue_write(
            _repo.HIGH,
            _repo.UpdateTemplatePromptOp(
                prompt_id=pid,
                content=str(body["content"]).strip() if "content" in body else None,
                weight=float(body["weight"]) if "weight" in body else None,
                enabled=bool(body["enabled"]) if "enabled" in body else None,
                order_index=int(body["order_index"]) if "order_index" in body else None,
            ),
        ).result(timeout=5)
    except Exception as e:
        logger.exception("patch slot prompt failed")
        return _err(500, "internal", str(e))
    return _ok({"prompt_id": pid})


async def _delete_slot_prompt(request: web.Request) -> web.Response:
    """DELETE /xyz/plv2/template_prompts/{id}"""
    pid = _node_id(request)
    try:
        _repo.enqueue_write(_repo.HIGH, _repo.DeleteTemplatePromptOp(prompt_id=pid)).result(timeout=5)
    except Exception as e:
        logger.exception("delete slot prompt failed")
        return _err(500, "internal", str(e))
    return web.json_response({"deleted": pid})


# ---------------------------------------------------------------------------
# Preview / resolve
# ---------------------------------------------------------------------------

async def _preview_node(request: web.Request) -> web.Response:
    """POST /xyz/plv2/nodes/{id}/preview
    Body: {"seed": 0}
    Returns the entry's generated text WITHOUT recursively expanding [refs].
    """
    try:
        body: Dict = await request.json()
    except Exception:
        body = {}

    nid = _node_id(request)
    if _repo.get_node(nid) is None:
        return _err(404, "not_found", f"node {nid} not found")

    seed = int(body.get("seed", 0))
    rng = _random.Random(seed)
    text = _engine.generate_entry_text(nid, rng, frozenset())
    return _ok({"text": text, "node_id": nid})


async def _resolve_template(request: web.Request) -> web.Response:
    """POST /xyz/plv2/resolve
    Body: {"template": "...", "seed": 0, "output_index": 0}
    Returns the fully resolved prompt text.
    """
    try:
        body: Dict = await request.json()
    except Exception:
        return _err(400, "bad_json", "request body must be valid JSON")

    template = str(body.get("template", ""))
    seed = int(body.get("seed", 0))
    output_index = int(body.get("output_index", 0))

    text = _engine.resolve_template(template, seed, output_index)
    return _ok({"text": text})


async def _resolve_ref(request: web.Request) -> web.Response:
    """POST /xyz/plv2/resolve_ref
    Body: {"ref": "toki.face"}  — the inner text of a [ref].
    Returns {"node": {...}} for the referenced entry (or {"node": null}).
    Used by the editor to look up a referenced entry's delimiter when inserting.
    """
    try:
        body: Dict = await request.json()
    except Exception:
        return _err(400, "bad_json", "request body must be valid JSON")

    ref = str(body.get("ref", "")).strip()
    if not ref:
        return _ok({"node": None})

    res = resolve_trigger(ref)
    if res is None:
        return _ok({"node": None})

    node_id, sub_path = res
    node = _repo.get_node(node_id)
    if sub_path and node is not None:
        target_path = node["full_path"] + "." + sub_path
        node = next((n for n in _repo.get_tree() if n["full_path"] == target_path), node)
    return _ok({"node": node})


async def _replace_refs(request: web.Request) -> web.Response:
    """POST /xyz/plv2/nodes/{id}/refs/replace

    Body: {"replacements": [{"old": "old_path", "new": "new_path"}, ...]}

    Replaces ``[old]`` and ``[old.`` patterns in all prompt contents across the
    library with the new names. Used after rename/move to keep references in sync.
    """
    try:
        body: Dict = await request.json()
    except Exception:
        return _err(400, "bad_json", "request body must be valid JSON")

    replacements = body.get("replacements")
    if not isinstance(replacements, list) or not replacements:
        return _err(400, "bad_request", "replacements must be a non-empty list")

    for r in replacements:
        if not isinstance(r, dict) or "old" not in r or "new" not in r:
            return _err(400, "bad_request", "each replacement must have 'old' and 'new'")
        if not str(r["old"]).strip() or not str(r["new"]).strip():
            return _err(400, "bad_request", "'old' and 'new' must be non-empty strings")

    try:
        updated = _repo.replace_refs_in_prompts(replacements)
    except Exception as e:
        logger.exception("replace refs failed")
        return _err(500, "internal", str(e))

    return _ok({"updated": updated})


async def _get_usages(request: web.Request) -> web.Response:
    """GET /xyz/plv2/nodes/{id}/usages

    Returns all references to this node (and its subtree entries) in other entries'
    prompts. Used before delete to show impact.
    """
    nid = _node_id(request)
    if _repo.get_node(nid) is None:
        return _err(404, "not_found", f"node {nid} not found")
    try:
        usages = _repo.find_usages(nid)
    except Exception as e:
        logger.exception("find usages failed")
        return _err(500, "internal", str(e))
    return _ok(usages)


async def _strip_refs(request: web.Request) -> web.Response:
    """POST /xyz/plv2/nodes/{id}/strip_refs

    Body: {"refs": ["quality.toki", "toki", ...]}

    Removes all ``[ref]`` and ``[ref.sub]`` tokens from ALL prompts in the library.
    Used before delete to clean up references to entries being removed.
    """
    try:
        body: Dict = await request.json()
    except Exception:
        return _err(400, "bad_json", "request body must be valid JSON")

    refs = body.get("refs")
    if not isinstance(refs, list) or not refs:
        return _err(400, "bad_request", "refs must be a non-empty list of strings")

    try:
        updated = _repo.strip_refs([str(r) for r in refs])
    except Exception as e:
        logger.exception("strip refs failed")
        return _err(500, "internal", str(e))

    return _ok({"updated": updated})


# ---------------------------------------------------------------------------
# Autocomplete sources (library prompts + entry/trigger refs) + shallow resolve
# ---------------------------------------------------------------------------

def _ac_limit(request: web.Request, default: int = 20) -> int:
    try:
        return max(1, min(int(request.rel_url.query.get("limit", str(default))), 50))
    except ValueError:
        return default


async def _ac_prompts(request: web.Request) -> web.Response:
    """GET /xyz/plv2/ac/prompts?q=&limit= — library prompt texts matching q."""
    q = request.rel_url.query.get("q", "")
    return _ok({"prompts": _repo.search_prompt_contents(q, _ac_limit(request))})


async def _ac_refs(request: web.Request) -> web.Response:
    """GET /xyz/plv2/ac/refs?q=&limit= — entry full_paths + trigger names matching q."""
    q = request.rel_url.query.get("q", "")
    return _ok({"refs": _repo.search_refs(q, _ac_limit(request))})


async def _ac_entries_by_prompt(request: web.Request) -> web.Response:
    """GET /xyz/plv2/ac/entries_by_prompt?q=&limit= — entries whose prompts contain q."""
    q = request.rel_url.query.get("q", "")
    return _ok({"entries": _repo.search_entries_by_prompt(q, _ac_limit(request))})


async def _resolve_shallow(request: web.Request) -> web.Response:
    """POST /xyz/plv2/resolve_shallow  Body: {"ref": "...", "seed": 0}

    Resolve an entry ref to its OWN generated text, leaving nested [refs] literal
    (req 170: the `/entry` insert form). {a|b} choices are resolved; [refs] are not.
    """
    try:
        body: Dict = await request.json()
    except Exception:
        return _err(400, "bad_json", "request body must be valid JSON")
    ref = str(body.get("ref", "")).strip()
    seed = int(body.get("seed", 0))
    if not ref:
        return _ok({"text": "", "found": False})
    res = resolve_trigger(ref)
    if res is None:
        return _ok({"text": "", "found": False})
    node_id, sub_path = res
    if sub_path:
        node = _repo.get_node(node_id)
        if node is not None:
            target_path = node["full_path"] + "." + sub_path
            n2 = next((n for n in _repo.get_tree() if n["full_path"] == target_path), None)
            if n2 is not None:
                node_id = n2["id"]
    rng = _random.Random(seed)
    text = _engine.generate_entry_text(node_id, rng, frozenset())
    text = _engine._apply_choices(text, 0)
    text = _engine._cleanup(text)
    return _ok({"text": text, "found": True})


# ---------------------------------------------------------------------------
# Common formats / delimiters
# ---------------------------------------------------------------------------

async def _get_common_formats(request: web.Request) -> web.Response:
    return _ok({"formats": _repo.get_common_formats()})


async def _get_common_delimiters(request: web.Request) -> web.Response:
    return _ok({"delimiters": _repo.get_common_delimiters()})


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

def register(server) -> None:
    """Register all PLv2 HTTP routes onto ComfyUI's PromptServer. Idempotent."""
    global _registered
    if _registered:
        return

    r = server.routes

    # Nodes
    r.get("/xyz/plv2/nodes")(_get_nodes)
    r.post("/xyz/plv2/nodes")(_post_nodes)
    r.patch(r"/xyz/plv2/nodes/{id:\d+}")(_patch_node)
    r.delete(r"/xyz/plv2/nodes/{id:\d+}")(_delete_node)
    r.post(r"/xyz/plv2/nodes/{id:\d+}/move")(_move_node)

    # Prompts
    r.get(r"/xyz/plv2/nodes/{id:\d+}/prompts")(_get_prompts)
    r.post(r"/xyz/plv2/nodes/{id:\d+}/prompts")(_post_prompt)
    r.patch(r"/xyz/plv2/prompts/{id:\d+}")(_patch_prompt)
    r.delete(r"/xyz/plv2/prompts/{id:\d+}")(_delete_prompt)
    r.post(r"/xyz/plv2/nodes/{id:\d+}/prompts/reorder")(_reorder_prompts)

    # Triggers
    r.get(r"/xyz/plv2/nodes/{id:\d+}/triggers")(_get_triggers)
    r.post(r"/xyz/plv2/nodes/{id:\d+}/triggers")(_post_trigger)
    r.delete(r"/xyz/plv2/triggers/{id:\d+}")(_delete_trigger)

    # Preview / resolve
    r.post(r"/xyz/plv2/nodes/{id:\d+}/preview")(_preview_node)
    r.post("/xyz/plv2/resolve")(_resolve_template)
    r.post("/xyz/plv2/resolve_ref")(_resolve_ref)
    r.post(r"/xyz/plv2/nodes/{id:\d+}/refs/replace")(_replace_refs)
    r.get(r"/xyz/plv2/nodes/{id:\d+}/usages")(_get_usages)
    r.post(r"/xyz/plv2/nodes/{id:\d+}/strip_refs")(_strip_refs)
    r.get("/xyz/plv2/ac/prompts")(_ac_prompts)
    r.get("/xyz/plv2/ac/refs")(_ac_refs)
    r.get("/xyz/plv2/ac/entries_by_prompt")(_ac_entries_by_prompt)
    r.post("/xyz/plv2/resolve_shallow")(_resolve_shallow)

    # Common lists
    r.get("/xyz/plv2/common/formats")(_get_common_formats)
    r.get("/xyz/plv2/common/delimiters")(_get_common_delimiters)

    # Template slots
    r.get(r"/xyz/plv2/nodes/{id:\d+}/template_slots")(_get_template_slots)
    r.post(r"/xyz/plv2/nodes/{id:\d+}/template_slots")(_post_template_slot)
    r.patch(r"/xyz/plv2/template_slots/{id:\d+}")(_patch_template_slot)
    r.delete(r"/xyz/plv2/template_slots/{id:\d+}")(_delete_template_slot)
    r.get(r"/xyz/plv2/template_slots/{id:\d+}/prompts")(_get_slot_prompts)
    r.post(r"/xyz/plv2/template_slots/{id:\d+}/prompts")(_post_slot_prompt)
    r.patch(r"/xyz/plv2/template_prompts/{id:\d+}")(_patch_slot_prompt)
    r.delete(r"/xyz/plv2/template_prompts/{id:\d+}")(_delete_slot_prompt)

    _registered = True
    logger.info("PLv2 routes registered")
