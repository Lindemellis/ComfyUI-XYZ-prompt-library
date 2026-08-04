# T60 — the document routes + the node's document input.
#
# These are the seam between the structured document and everything that already
# existed: the editor syncs through /doc/sync, a switch goes through /doc/toggle,
# and the node compiles the document rather than the text it was handed.
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from prompt_library_v3 import routes
from prompt_library_v3.document import Document, from_text, render
from prompt_library_v3.node import PromptLibraryV3Node, source_text


class MockRequest:
    def __init__(self, payload):
        self._payload = payload

    async def json(self):
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload


def call(handler, payload):
    resp = asyncio.run(handler(MockRequest(payload)))
    return resp.status, json.loads(resp.body.decode())


SRC = "masterpiece, worst quality, 1girl"


# --- /doc/sync --------------------------------------------------------------


def test_sync_wraps_a_bare_text():
    status, body = call(routes._post_doc_sync, {"text": SRC})
    assert status == 200 and body["ok"]
    assert body["text"] == SRC
    assert body["doc"]["root"]["children"]


def test_sync_keeps_parked_items_across_an_edit():
    doc = from_text(SRC)
    off = doc.root.children[1].id
    doc.set_enabled(off, False)

    # the user typed something else while an item was parked
    status, body = call(routes._post_doc_sync,
                        {"doc": doc.to_json(), "text": "masterpiece, 1girl, extra"})
    assert status == 200
    merged = Document.from_json(body["doc"])
    parked = [n for n in merged.root.children if not n.enabled]
    assert [n.raw for n in parked] == ["worst quality"]
    assert body["text"] == "masterpiece, 1girl, extra"


def test_sync_rejects_a_bad_body():
    status, body = call(routes._post_doc_sync, ValueError("nope"))
    assert status == 400 and "bad request" in body["error"]


# --- /doc/toggle ------------------------------------------------------------


def test_toggle_returns_an_applicable_edit():
    doc = from_text(SRC)
    target = doc.root.children[1].id

    status, body = call(routes._post_doc_toggle,
                        {"doc": doc.to_json(), "text": SRC, "id": target, "enabled": False})
    assert status == 200 and body["ok"]
    start, end = body["span"]
    assert SRC[:start] + body["insert"] + SRC[end:] == body["text"]
    assert body["text"] == "masterpiece, 1girl"


def test_toggle_back_on_restores_the_text():
    doc = from_text(SRC)
    target = doc.root.children[1].id
    _, off = call(routes._post_doc_toggle,
                  {"doc": doc.to_json(), "text": SRC, "id": target, "enabled": False})
    _, on = call(routes._post_doc_toggle,
                 {"doc": off["doc"], "text": off["text"], "id": target, "enabled": True})
    assert on["text"] == SRC


def test_toggle_unknown_id_is_404():
    status, body = call(routes._post_doc_toggle,
                        {"text": SRC, "id": "nope", "enabled": False})
    assert status == 404 and "nope" in body["error"]


# --- the node ---------------------------------------------------------------


def test_node_compiles_the_document_not_the_text():
    doc = from_text(SRC)
    doc.set_enabled(doc.root.children[1].id, False)
    payload = json.dumps(doc.to_json())

    # `text` is deliberately STALE here — the document is what counts.
    out = PromptLibraryV3Node().execute(text=SRC, doc=payload)[0]
    assert out == "masterpiece, 1girl"


def test_node_without_a_document_is_unchanged():
    assert PromptLibraryV3Node().execute(text=SRC)[0] == SRC
    assert PromptLibraryV3Node().execute(text=SRC, doc="")[0] == SRC


def test_a_broken_document_falls_back_to_the_text():
    assert source_text(SRC, "{not json") == SRC
    assert source_text(SRC, '{"root": {"nonsense": 1}}') == SRC


def test_is_changed_follows_the_document():
    doc = from_text(SRC)
    before = PromptLibraryV3Node.IS_CHANGED(text=SRC, doc=json.dumps(doc.to_json()))
    doc.set_enabled(doc.root.children[1].id, False)
    after = PromptLibraryV3Node.IS_CHANGED(text=SRC, doc=json.dumps(doc.to_json()))
    assert before != after
    # two documents that render the same text must not look like a change
    same = PromptLibraryV3Node.IS_CHANGED(text=render(doc), doc="")
    assert same == after


def test_the_doc_input_is_declared_optional():
    spec = PromptLibraryV3Node.INPUT_TYPES()
    assert "doc" in spec["optional"]
    assert "doc" not in spec["required"]
