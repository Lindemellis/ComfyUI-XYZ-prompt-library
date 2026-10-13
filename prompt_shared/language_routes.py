"""Stateless shared prompt-language HTTP; legacy URLs keep old workflows editable.

No Library imports, SQLite connections, migration or writer initialization.
The PLv3 language implementation remains shared by V4 and compatibility nodes.
"""
from __future__ import annotations

from aiohttp import web

from .language import document
from .language.ast_json import to_json
from .language.compile import REGION_MODES, compile_text
from .language.diagnostics import Diagnostics, PLv3Error
from .language.parser import parse

from .routes import register_monaco


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
                    "mask_weight": s.mask_weight,
                    "cond_weight": s.cond_weight,
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


# --- documents --------------------------------------------------------------
#
# The document is the source of truth: the same tree as the text, plus a stable id
# and an on/off switch per item.  The text is what its ENABLED items render to, so
# an item switched off is nowhere in the text — which is the whole point, and also
# why the frontend cannot work these out for itself.


def _doc_of(body) -> "Document":
    """The posted document, or a fresh one built from the posted text."""
    Document, from_text, reconcile = document.Document, document.from_text, document.reconcile

    raw = body.get("doc")
    text = body.get("text") or ""
    if not raw:
        return from_text(text)
    doc = Document.from_json(raw)
    # A text came with it: the user has been typing, so fold those edits in first.
    if "text" in body and render_doc(doc) != text:
        doc = reconcile(doc, text)
    return doc


def render_doc(doc) -> str:
    render = document.render

    return render(doc)


async def _post_doc_sync(request):
    """text (+ the document we last handed out) -> the document that matches it.

    Called on the same beat as the editor's lint, so the parked items survive
    whatever the user just typed.  With no document posted this is simply
    "wrap this text", which is how an older workflow gets one.
    """
    try:
        body = await request.json()
        doc = _doc_of(body)
    except Exception as exc:  # noqa: BLE001
        return web.json_response({"error": f"bad request: {exc}"}, status=400)

    return web.json_response({"ok": True, "doc": doc.to_json(), "text": render_doc(doc)})


async def _post_doc_toggle(request):
    """Switch one item on or off, and say which characters that changes.

    Returning the edit rather than the whole text lets the detail page push it
    through its existing span-edit path — version stamp, rebase, one undo step.
    """
    try:
        body = await request.json()
        node_id = str(body.get("id") or "")
        enabled = bool(body.get("enabled"))
        doc = _doc_of(body)
    except Exception as exc:  # noqa: BLE001
        return web.json_response({"error": f"bad request: {exc}"}, status=400)

    toggle_edit = document.toggle_edit

    edit = toggle_edit(doc, node_id, enabled)
    if edit is None:
        return web.json_response({"error": f"unknown item '{node_id}'"}, status=404)
    return web.json_response({"ok": True, **edit})


def register(server) -> None:
    """Register pure language/document compatibility and shared Monaco once."""
    if getattr(server, '_xyz_prompt_language_registered', False):
        return
    for path, handler in (
        ('compile', _post_compile), ('ast', _post_ast),
        ('doc/sync', _post_doc_sync), ('doc/toggle', _post_doc_toggle),
    ):
        server.routes.post('/xyz/plv3/' + path)(handler)
    register_monaco(server)
    server._xyz_prompt_language_registered = True
