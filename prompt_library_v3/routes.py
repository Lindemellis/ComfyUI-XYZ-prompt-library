"""Historical V3 Library routes, retained for explicit offline tooling/tests.

The pack does not register these Library services. Stateless language/document
handlers are compatibility exports of prompt_shared.language_routes; active V4
setup registers that module directly without importing this legacy Library.
"""
from __future__ import annotations

import json

from aiohttp import web

from . import library, repo
from .diagnostics import E02, PLv3Error

_registered = False


# Historical handler exports for tests/tooling; the pack starts only the shared
# stateless routes. Legacy Library registration below is never called at startup.
if '.' in __package__:
    from ..prompt_shared.language_routes import (
        _diag_json, _read, _post_compile, _post_ast, _doc_of, render_doc,
        _post_doc_sync, _post_doc_toggle, register as register_language,
    )
else:
    from prompt_shared.language_routes import (
        _diag_json, _read, _post_compile, _post_ast, _doc_of, render_doc,
        _post_doc_sync, _post_doc_toggle, register as register_language,
    )


# --- library (spec §5) ------------------------------------------------------


def _json(body, status=200):
    return web.json_response(body, status=status)


async def _get_tree(request):
    """Folders + groups in one shot — the library window's left column."""
    groups = repo.list_groups()
    for g in groups:
        g["path"] = repo.group_path(int(g["id"]))
        g.pop("settings_json", None)
    return _json({
        "folders": repo.list_folders(),
        "groups": groups,
        # The `[` autocomplete offers a group's presets alongside the group itself, so
        # the tree carries them. Names only — the body is expanded server-side.
        "presets": repo.list_preset_names(),
        # Saved whole documents. Names and sizes only: the text of every prompt ever
        # saved has no business riding along with the tree.
        "documents": repo.list_documents(),
    })


async def _post_folder(request):
    body = await request.json()
    fid = repo.write(
        repo.CreateFolderOp(name=body["name"], parent_id=body.get("parent_id"))
    )
    return _json({"id": fid})


async def _patch_folder(request):
    fid = int(request.match_info["id"])
    body = await request.json()
    try:
        if body.get("name"):
            repo.write(repo.RenameFolderOp(folder_id=fid, name=body["name"]))
        if "parent_id" in body:
            repo.write(repo.MoveFolderOp(folder_id=fid, parent_id=body["parent_id"]))
    except repo.CycleError as exc:
        return _json({"error": str(exc)}, status=409)
    return _json({"ok": True})


async def _delete_folder(request):
    repo.write(repo.DeleteFolderOp(folder_id=int(request.match_info["id"])))
    return _json({"ok": True})


async def _post_group(request):
    body = await request.json()
    gid = repo.write(
        repo.CreateGroupOp(
            name=body["name"],
            folder_id=body.get("folder_id"),
            parent_group_id=body.get("parent_group_id"),
            polarity=body.get("polarity") or "positive",
            settings=body.get("settings") or {},
        )
    )
    return _json({"id": gid, "path": repo.group_path(gid)})


async def _patch_group(request):
    gid = int(request.match_info["id"])
    body = await request.json()
    repo.write(
        repo.UpdateGroupOp(
            group_id=gid,
            name=body.get("name"),
            polarity=body.get("polarity"),
            settings=body.get("settings"),
        )
    )
    return _json({"ok": True, "path": repo.group_path(gid)})


async def _post_move_group(request):
    gid = int(request.match_info["id"])
    body = await request.json()
    try:
        repo.write(
            repo.MoveGroupOp(
                group_id=gid,
                folder_id=body.get("folder_id"),
                parent_group_id=body.get("parent_group_id"),
            )
        )
    except repo.CycleError as exc:
        return _json({"error": str(exc)}, status=409)
    return _json({"ok": True, "path": repo.group_path(gid)})


async def _delete_group(request):
    repo.write(repo.DeleteGroupOp(group_id=int(request.match_info["id"])))
    return _json({"ok": True})


async def _get_group_items(request):
    gid = int(request.match_info["id"])
    group = repo.get_group(gid)
    if group is None:
        return _json({"error": "no such group"}, status=404)
    group.pop("settings_json", None)
    items = repo.list_items(gid)
    for item in items:
        if item["ref_group_id"]:
            item["ref_path"] = repo.group_path(int(item["ref_group_id"]))

    # Each preset's expanded text comes along for the ride. A document does not record
    # which preset a block came from — the text is all there is (§5.2) — so the way to
    # answer "which preset is this, and has it been edited since?" is to compare the
    # block against what each preset expands to. That comparison belongs where the block
    # is, so the text has to be here.
    presets = repo.list_presets(gid)
    for preset in presets:
        try:
            preset["text"] = library.expand(gid, preset_id=int(preset["id"]))
        except PLv3Error:
            preset["text"] = None   # a cycle: it still exists, it just cannot be shown
        # Which nested blocks this preset FOLLOWS (§5.4), keyed by path — the body keys
        # them by ref-item id, which is not something the UI should have to know.
        preset["links"] = library.links_of(preset["body"])

    return _json({
        "group": {**group, "path": repo.group_path(gid)},
        "items": items,
        "presets": presets,
    })


async def _post_item(request):
    gid = int(request.match_info["id"])
    body = await request.json()
    kind = body.get("kind") or "prompt"
    text = body.get("text") or ""
    if kind == "prompt":
        text = library.normalize_group_tag(text)
    try:
        item_id = repo.write(
            repo.AddItemOp(
                group_id=gid,
                kind=kind,
                text=text,
                ref_group_id=body.get("ref_group_id"),
                weight=body.get("weight"),
            )
        )
    except repo.CycleError as exc:
        # Spec §5.5 layer 1: the library never gets to contain a loop.
        return _json({"error": str(exc), "code": E02}, status=409)
    return _json({"id": item_id})


async def _patch_item(request):
    body = await request.json()
    item_id = int(request.match_info["id"])
    text = body.get("text")
    if text is not None:
        item = repo.get_item(item_id)
        if not item or item["kind"] == "prompt":
            text = library.normalize_group_tag(text)
    repo.write(
        repo.UpdateItemOp(
            item_id=item_id,
            text=text,
            weight=body.get("weight"),
            sort_index=body.get("sort_index"),
        )
    )
    return _json({"ok": True})


async def _delete_item(request):
    repo.write(repo.DeleteItemOp(item_id=int(request.match_info["id"])))
    return _json({"ok": True})


async def _post_reorder(request):
    gid = int(request.match_info["id"])
    body = await request.json()
    repo.write(repo.ReorderItemsOp(group_id=gid, item_ids=[int(i) for i in body["item_ids"]]))
    return _json({"ok": True})


async def _post_expand(request):
    """library -> text: the block the editor inserts for `[path]`."""
    body = await request.json()
    gid = body.get("group_id")
    if gid is None and body.get("path"):
        gid = repo.find_by_path(body["path"])
    if gid is None:
        return _json({"error": "unknown group"}, status=404)
    try:
        text = library.expand(int(gid), preset_id=body.get("preset_id"))
    except PLv3Error as exc:
        return _json({"error": exc.diag.message, "code": exc.diag.code}, status=409)
    return _json({"text": text})


async def _post_sync(request):
    """text -> library, on blur (spec §5.3)."""
    body = await request.json()
    try:
        return _json(library.sync_text(body.get("text") or ""))
    except PLv3Error as exc:
        return _json({"error": exc.diag.message, "code": exc.diag.code}, status=409)


async def _post_preset(request):
    """Save a named preset, either from a document block or from an explicit body.

    Two callers, two shapes:
      {text, path, name}          — snapshot the `[path]: { … }` block in that text
      {group_id, name, body}      — the library window toggling items on and off,
                                    where the whitelist IS the edit and asking the
                                    frontend to render a block first would be silly.
    """
    body = await request.json()
    name = body.get("name")

    if body.get("body") is not None and body.get("group_id") is not None:
        pid = repo.write(repo.SavePresetOp(
            group_id=int(body["group_id"]), name=name, body=body["body"],
        ))
        return _json({"id": pid, "body": body["body"]})

    text = body.get("text") or ""
    path = body.get("path")
    blocks = [b for b in library.find_blocks(text) if b.header == path]
    if not blocks:
        return _json({"error": f"no block for {path!r} in the text"}, status=404)
    group_id = repo.find_by_path(path)
    if group_id is None:
        return _json({"error": f"unknown library path {path!r}"}, status=404)

    # Take the text into the library FIRST. A preset is a whitelist of the group's item
    # ids, so an item that was typed a moment ago and has no row yet cannot be in it —
    # it would be dropped from the preset without a word. The blur-sync would have done
    # this anyway; saving must not depend on having blurred (spec §5.3).
    library.sync_text(text)

    # `links` — `{nested path: preset id}` — says which nested blocks FOLLOW a preset of
    # their own instead of being snapshotted here. An edit made inside such a block is an
    # edit to that preset, so it is written through to it before this preset is stored.
    # The shared preset changes for everyone who follows it: that is what a link is.
    #
    # Only links this preset ALREADY had are written through. A link made just now must
    # not be: what is on screen at that moment is still the block's old contents, and
    # writing them through would overwrite the very preset the user chose to follow.
    links = {str(k): int(v) for k, v in (body.get("links") or {}).items()}
    previous = next((p for p in repo.list_presets(group_id) if p["name"] == name), None)
    established = library.links_of(previous["body"]) if previous else {}
    written = (
        library.write_through(text, blocks[0], links, established=established)
        if links else []
    )

    preset_body = library.build_preset_body(text, blocks[0], links=links)
    # A disabled item is not in the text, so its remembered weight cannot be rebuilt from
    # the block. The client carries it forward — `{header: {item text: weight}}` — and it
    # rides along in the preset body so re-enabling an item keeps the weight the user set,
    # even across a reload (the detail page's document-scoped weight memory).
    wm = body.get("weight_memory")
    if wm is not None:
        preset_body["weight_memory"] = wm

    pid = repo.write(repo.SavePresetOp(group_id=group_id, name=name, body=preset_body))
    return _json({"id": pid, "body": preset_body, "written_through": written})


async def _delete_preset(request):
    repo.write(repo.DeletePresetOp(preset_id=int(request.match_info["id"])))
    return _json({"ok": True})


async def _post_group_from_text(request):
    """A chunk of a document -> a NEW library group, and the block that replaces it.

    `text` is returned expanded, because the caller's next move is to put the block in
    the editor where the selection was: a copy that merely resembles the group would
    start drifting from it immediately, and nothing in a document points back at the
    library except a `[path]` header.
    """
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name:
        return _json({"error": "a group needs a name"}, status=400)
    try:
        created = library.create_group_from_text(
            name=name,
            text=body.get("text") or "",
            folder_id=body.get("folder_id"),
            parent_group_id=body.get("parent_group_id"),
        )
    except ValueError as exc:
        return _json({"error": str(exc)}, status=400)
    except repo.CycleError as exc:
        return _json({"error": str(exc), "code": E02}, status=409)
    try:
        expanded = library.expand(int(created["id"]))
    except PLv3Error as exc:
        return _json({"error": exc.diag.message, "code": exc.diag.code}, status=409)
    return _json({**created, "text": expanded})


# --- saved documents --------------------------------------------------------


async def _post_document(request):
    """Save a whole document: the text AND the doc JSON that carries the items you
    switched off.  Same name in the same folder replaces it (the client confirms)."""
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name:
        return _json({"error": "a document needs a name"}, status=400)
    doc = body.get("doc")
    doc_json = doc if isinstance(doc, str) else ("" if doc is None else json.dumps(doc))
    did = repo.write(repo.SaveDocumentOp(
        name=name,
        text=body.get("text") or "",
        doc_json=doc_json,
        folder_id=body.get("folder_id"),
    ))
    return _json({"id": did})


async def _get_document(request):
    row = repo.get_document(int(request.match_info["id"]))
    if row is None:
        return _json({"error": "no such document"}, status=404)
    return _json(row)


async def _patch_document(request):
    did = int(request.match_info["id"])
    body = await request.json()
    if body.get("name"):
        repo.write(repo.RenameDocumentOp(document_id=did, name=body["name"]))
    if "folder_id" in body:
        repo.write(repo.MoveDocumentOp(document_id=did, folder_id=body["folder_id"]))
    return _json({"ok": True})


async def _delete_document(request):
    repo.write(repo.DeleteDocumentOp(document_id=int(request.match_info["id"])))
    return _json({"ok": True})


if '.' in __package__:
    from ..prompt_shared.routes import MONACO_DIR as _MONACO_DIR, register_monaco
else:
    from prompt_shared.routes import MONACO_DIR as _MONACO_DIR, register_monaco


def register(server) -> None:
    """Register PLv3 routes onto ComfyUI's PromptServer.  Idempotent."""
    global _registered
    if _registered:
        return
    r = server.routes
    register_language(server)

    # Library
    r.get("/xyz/plv3/library/tree")(_get_tree)
    r.post("/xyz/plv3/library/folders")(_post_folder)
    r.patch(r"/xyz/plv3/library/folders/{id:\d+}")(_patch_folder)
    r.delete(r"/xyz/plv3/library/folders/{id:\d+}")(_delete_folder)
    r.post("/xyz/plv3/library/groups")(_post_group)
    r.get(r"/xyz/plv3/library/groups/{id:\d+}")(_get_group_items)
    r.patch(r"/xyz/plv3/library/groups/{id:\d+}")(_patch_group)
    r.post(r"/xyz/plv3/library/groups/{id:\d+}/move")(_post_move_group)
    r.delete(r"/xyz/plv3/library/groups/{id:\d+}")(_delete_group)
    r.post(r"/xyz/plv3/library/groups/{id:\d+}/items")(_post_item)
    r.post(r"/xyz/plv3/library/groups/{id:\d+}/reorder")(_post_reorder)
    r.patch(r"/xyz/plv3/library/items/{id:\d+}")(_patch_item)
    r.delete(r"/xyz/plv3/library/items/{id:\d+}")(_delete_item)
    r.post("/xyz/plv3/library/expand")(_post_expand)
    r.post("/xyz/plv3/library/sync")(_post_sync)
    r.post("/xyz/plv3/library/presets")(_post_preset)
    r.delete(r"/xyz/plv3/library/presets/{id:\d+}")(_delete_preset)
    r.post("/xyz/plv3/library/groups/from_text")(_post_group_from_text)

    # Whole-document snapshots
    r.post("/xyz/plv3/library/documents")(_post_document)
    r.get(r"/xyz/plv3/library/documents/{id:\d+}")(_get_document)
    r.patch(r"/xyz/plv3/library/documents/{id:\d+}")(_patch_document)
    r.delete(r"/xyz/plv3/library/documents/{id:\d+}")(_delete_document)

    register_monaco(server)

    _registered = True
