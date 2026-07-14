"""Prompt Library V3 — HTTP routes.

All routes are registered under /xyz/plv3/.  P1's compiler is a pure function, so
these are stateless: no DB, no WriteQueue (the library lands in P4).

Endpoints:
  POST /xyz/plv3/compile   — text -> prompt-control string + diagnostics.  This is
                             also the editor's lint: the squiggles come from the
                             same diagnostics the node would print.
  POST /xyz/plv3/ast       — text -> AST with source spans, for the detail page
  GET  /xyz/plv3/monaco/*  — the vendored Monaco build (static)

The detail page parses through *this* route rather than reimplementing the grammar
in JS: one parser, shared with the compiler, so the two can never drift.

Monaco is served from here rather than from WEB_DIRECTORY on purpose: ComfyUI
globs `**/*.js` under WEB_DIRECTORY and imports every hit as an ES-module
extension (server.py:353).  Monaco's AMD bundle and its web worker would both be
dragged into the main thread and blow up.
"""
from __future__ import annotations

from pathlib import Path

from aiohttp import web

from . import library, repo
from .ast_json import to_json
from .compile import REGION_MODES, compile_text
from .diagnostics import E02, Diagnostics, PLv3Error
from .parser import parse

_registered = False


def _diag_json(diag) -> dict:
    return {
        "code": diag.code,
        "message": diag.message,
        "pos": diag.pos,
        "severity": "error" if diag.is_error else "warning",
    }


async def _read(request) -> tuple[str, int, str, str]:
    body = await request.json()
    text = body.get("text") or ""
    seed = int(body.get("seed") or 0)
    region_mode = body.get("region_mode") or "couple"
    if region_mode not in REGION_MODES:
        region_mode = "couple"
    polarity = "negative" if body.get("polarity") == "negative" else "positive"
    return text, seed, region_mode, polarity


async def _post_compile(request):
    try:
        text, seed, region_mode, polarity = await _read(request)
    except Exception as exc:
        return web.json_response({"error": f"bad request: {exc}"}, status=400)

    try:
        # The editor asks about documents that are still being typed, so it compiles in
        # recovering mode: a broken construct becomes an E03 diagnostic (the editor puts
        # a squiggle on it) and everything around it still compiles.  The alternative —
        # returning nothing but the error — blanks the preview exactly when the user is
        # mid-edit and needs to see what they have.  The NODE never uses this route; it
        # compiles strictly and refuses to run (spec §6).
        result = compile_text(
            text, seed=seed, region_mode=region_mode, polarity=polarity, recover=True
        )
    except PLv3Error as exc:
        # Recovery covers the structural breaks; anything that still throws (E01/E02) is
        # a hard error with nothing partial to show.
        return web.json_response(
            {"ok": False, "text": "", "diagnostics": [_diag_json(exc.diag)]}
        )

    return web.json_response(
        {
            "ok": not any(d.is_error for d in result.diagnostics),
            "text": result.text,
            "diagnostics": [_diag_json(d) for d in result.diagnostics],
            "segments": [
                {
                    "kind": s.kind,
                    "text": s.text,
                    "schedule": list(s.schedule),
                    # The preview names its tabs from these — without them it can only
                    # fall back on the segment's index, which is not what the user
                    # wrote and not what `imask: i` means.
                    "imask": s.imask,
                    "mask": list(s.mask) if s.mask else None,
                    "feather": s.feather,
                    "region_weight": s.region_weight,
                }
                for s in result.segments
            ],
        }
    )


async def _post_ast(request):
    try:
        text, _seed, _mode, polarity = await _read(request)
    except Exception as exc:
        return web.json_response({"error": f"bad request: {exc}"}, status=400)

    diags = Diagnostics()
    try:
        root, diags = parse(text, diags, recover=True)
    except PLv3Error as exc:
        return web.json_response(
            {"ok": False, "ast": None, "diagnostics": [_diag_json(exc.diag)]}
        )

    return web.json_response(
        {
            # `ok: false` with an AST attached: the tree is real but partial.  The detail
            # page renders it and says so, rather than showing an error and nothing else.
            "ok": not any(d.is_error for d in diags),
            "ast": to_json(root),
            "polarity": polarity,
            "diagnostics": [_diag_json(d) for d in diags],
        }
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
    return _json({"folders": repo.list_folders(), "groups": groups})


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
    try:
        item_id = repo.write(
            repo.AddItemOp(
                group_id=gid,
                kind=body.get("kind") or "prompt",
                text=body.get("text") or "",
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
    repo.write(
        repo.UpdateItemOp(
            item_id=int(request.match_info["id"]),
            text=body.get("text"),
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
    pid = repo.write(repo.SavePresetOp(group_id=group_id, name=name, body=preset_body))
    return _json({"id": pid, "body": preset_body, "written_through": written})


async def _delete_preset(request):
    repo.write(repo.DeletePresetOp(preset_id=int(request.match_info["id"])))
    return _json({"ok": True})


_MONACO_DIR = Path(__file__).parent.parent / "web" / "monaco"


def register(server) -> None:
    """Register PLv3 routes onto ComfyUI's PromptServer.  Idempotent."""
    global _registered
    if _registered:
        return
    r = server.routes
    r.post("/xyz/plv3/compile")(_post_compile)
    r.post("/xyz/plv3/ast")(_post_ast)

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

    if _MONACO_DIR.is_dir():
        server.app.router.add_static(
            "/xyz/plv3/monaco/", path=str(_MONACO_DIR), name="plv3_monaco"
        )
    else:  # pragma: no cover
        print(f"[PLv3] Monaco not found at {_MONACO_DIR}; the editor will not load")

    _registered = True
