"""PLv3 — the full stop as an item separator (spec update 2026-08-05).

A prompt may be a tag list, prose, or both at once.  `,` and `.` both separate items;
they differ in one way that matters, and every test here is about that difference:

    a comma is punctuation BETWEEN items and is dropped
    a full stop is part of the item it ENDS and is kept

`tag1, tag2. tag3.` is therefore `tag1`, `tag2.`, `tag3.`.

A `.` separates only when whitespace or the end of the text follows it, which is what
keeps `[a.b]`, `.set`, `0.3` and `<lora:x:0.8>` meaning what they always meant.
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from prompt_library_v3 import db as D  # noqa: E402
from prompt_library_v3 import lexer as lx  # noqa: E402
from prompt_library_v3.compile import compile_text  # noqa: E402
from prompt_library_v3.document import from_text, render, toggle_edit  # noqa: E402
from prompt_library_v3.library import join_items  # noqa: E402
from prompt_library_v3.parser import Group, Item, Lora, Text, parse  # noqa: E402

SPEC_EXAMPLE = "tag1, tag2. tag3. tag4, tag5"
SPEC_ITEMS = ["tag1", "tag2.", "tag3.", "tag4", "tag5"]


def top_items(src: str) -> list[str]:
    root, _ = parse(src)
    out = []
    for child in root.children:
        if isinstance(child, (Text, Lora, Item)):
            out.append(src[child.pos : child.end])
        elif isinstance(child, Group):
            out.append(f"<group {child.header or ''}>")
    return out


# --- the rule ---------------------------------------------------------------


def test_spec_example_splits_as_specified():
    assert top_items(SPEC_EXAMPLE) == SPEC_ITEMS


def test_period_stays_with_its_item_comma_does_not():
    assert top_items("a, b.") == ["a", "b."]


def test_prose_splits_into_sentences():
    assert top_items("a photo of a cat. it sits on a mat.") == [
        "a photo of a cat.",
        "it sits on a mat.",
    ]


def test_a_period_without_following_blank_is_not_a_separator():
    for src in ("a.b", "0.35", "v1.2.3"):
        assert top_items(src) == [src], src


def test_tokeniser_boundaries():
    assert any(t.kind == lx.STOP for t in lx.tokenize("a. b"))
    assert any(t.kind == lx.STOP for t in lx.tokenize("ends here."))
    assert not any(t.kind == lx.STOP for t in lx.tokenize("dropout: 0.35"))
    assert not any(t.kind == lx.STOP for t in lx.tokenize("[a.b.c]"))
    assert not any(t.kind == lx.STOP for t in lx.tokenize("{ a }.set{weight: 1.2}"))


# --- the other four meanings of `.` are untouched ---------------------------


def test_the_other_meanings_of_a_dot_still_parse():
    sources = [
        "[characters.illya]: { a }",
        "{ a }.set{weight: 1.2}",
        "{ a }.set{dropout: 0.35}",
        "{ a }.set{schedule: {0, 0.3}}",
        "<lora:mylora:0.8>",
        "(artist:wlop:1.1)",
        "[@schedule]: { 0 - 0.3: { a }, 0.3 - 1: { b } }",
        "[@region]: { base: { a }, [imask: 0]: { b } }",
    ]
    for src in sources:
        _root, diags = parse(src)
        assert not [d for d in diags if d.is_error], (src, diags.codes())


def test_a_library_path_is_not_split():
    root, _ = parse("[characters.illya]: { a }")
    assert root.children[0].header == "characters.illya"


# --- joining back ------------------------------------------------------------


def test_compiled_output_does_not_weld_a_comma_onto_a_full_stop():
    result = compile_text(SPEC_EXAMPLE, seed=0, region_mode="couple", polarity="positive")
    assert result.text == SPEC_EXAMPLE
    prose = compile_text("a cat. on a mat.", seed=0, region_mode="couple", polarity="positive")
    assert prose.text == "a cat. on a mat."


def test_join_items_round_trips():
    assert join_items(SPEC_ITEMS) == SPEC_EXAMPLE
    assert top_items(join_items(SPEC_ITEMS)) == SPEC_ITEMS


# --- the document invariants still hold -------------------------------------

DOCS = [
    SPEC_EXAMPLE,
    "a photo of a cat. it sits on a mat.\n\nmore, tags. here.",
    "intro. [chars.illya]: {\n    a, b. c,\n}. outro",
    "[@region]: {\n    base: { one. two. },\n    [imask: 0]: { red dress. },\n}",
    "1girl, solo.",
    "a. b. c. d.",
]


def test_render_from_text_is_byte_identical():
    for src in DOCS:
        assert render(from_text(src)) == src, src


def test_every_single_toggle_restores_in_place():
    for src in DOCS:
        for node_id in [n.id for n in from_text(src).root.walk()]:
            doc = from_text(src)
            if toggle_edit(doc, node_id, False) is None:
                continue
            doc.find(node_id).enabled = True
            assert render(doc) == src, (src, node_id)


def test_switching_one_off_leaves_a_document_that_parses():
    for src in DOCS:
        for node_id in [n.id for n in from_text(src).root.walk()]:
            doc = from_text(src)
            edit = toggle_edit(doc, node_id, False)
            if edit is None:
                continue
            after = src[: edit["span"][0]] + edit["insert"] + src[edit["span"][1] :]
            _root, diags = parse(after, recover=False)
            assert not [d for d in diags if d.is_error], (src, node_id, after)


# --- splitting stored text ---------------------------------------------------


def test_split_sentences():
    assert lx.split_sentences("a photo of a cat. it sits.") == [
        "a photo of a cat.",
        "it sits.",
    ]
    assert lx.split_sentences("plain tag") == ["plain tag"]
    assert lx.split_sentences("0.5 weight thing") == ["0.5 weight thing"]
    assert lx.split_sentences("path a.b.c here") == ["path a.b.c here"]
    # a nested group is one item however many stops are inside it
    assert lx.split_sentences("{a. b} stays whole") == ["{a. b} stays whole"]


# --- migration v4 ------------------------------------------------------------


def _v3_db() -> "sqlite3.Connection":  # noqa: F821
    conn = D.connect_write(Path(tempfile.mkdtemp()) / "plv3.db")
    for version in (1, 2, 3):
        D.MIGRATIONS[version](conn)
    conn.execute("PRAGMA user_version = 3")
    return conn


def _add(conn, item_id, group_id, index, text, weight=None, kind="prompt", ref=None):
    conn.execute(
        "INSERT INTO items(id, group_id, kind, sort_index, text, ref_group_id, weight) "
        "VALUES (?,?,?,?,?,?,?)",
        (item_id, group_id, kind, index, text, ref, weight),
    )


def test_migration_splits_items_and_keeps_presets_whole():
    conn = _v3_db()
    conn.execute("INSERT INTO groups(id, name) VALUES (1, 'g')")
    conn.execute("INSERT INTO groups(id, name) VALUES (2, 'other')")
    _add(conn, 10, 1, 0, "first tag")
    _add(conn, 11, 1, 1, "a photo of a cat. it sits on a mat.", 1.2)
    _add(conn, 12, 1, 2, "last tag")
    _add(conn, 13, 1, 3, "", kind="ref", ref=2)
    # the second sentence already exists as its own row: it must be REUSED, because
    # `UNIQUE(group_id, text)` is what makes an item's text its identity
    _add(conn, 14, 1, 4, "it sits on a mat.")
    _add(conn, 20, 2, 0, "nested one. nested two.")
    conn.execute(
        "INSERT INTO presets(id, group_id, name, body_json) VALUES (?,?,?,?)",
        (
            100,
            1,
            "p",
            json.dumps(
                {
                    "items": [10, 11, 12, 13],
                    "weights": {"11": 1.2},
                    "settings": {},
                    "children": {
                        "13": {
                            "mode": "snapshot",
                            "items": [20],
                            "weights": {},
                            "children": {},
                        }
                    },
                }
            ),
        ),
    )

    assert D.migrate(conn) == D.SCHEMA_VERSION

    rows = conn.execute(
        "SELECT id, group_id, sort_index, text, weight, kind FROM items "
        "ORDER BY group_id, sort_index, id"
    ).fetchall()
    g1 = [r for r in rows if r["group_id"] == 1]
    assert [r["text"] for r in g1] == [
        "first tag",
        "a photo of a cat.",
        "it sits on a mat.",
        "last tag",
        "",
    ]
    assert g1[-1]["kind"] == "ref"
    # the original row kept its id and became the FIRST piece
    assert {int(r["id"]): r["text"] for r in g1}[11] == "a photo of a cat."
    # ...and the duplicate was reused, not inserted again
    texts = [r["text"] for r in g1]
    assert len(texts) == len(set(texts))

    body = json.loads(
        conn.execute("SELECT body_json FROM presets WHERE id = 100").fetchone()[0]
    )
    assert body["items"] == [10, 11, 14, 12, 13]
    # the weight belonged to the whole sentence, so every piece keeps it
    assert body["weights"] == {"11": 1.2, "14": 1.2}
    # a nested snapshot's whitelist points at another group's items — remapped too
    assert len(body["children"]["13"]["items"]) == 2
    conn.close()


def test_migration_is_idempotent():
    conn = _v3_db()
    conn.execute("INSERT INTO groups(id, name) VALUES (1, 'g')")
    _add(conn, 10, 1, 0, "one. two.")
    D.migrate(conn)
    before = [tuple(r) for r in conn.execute("SELECT id, text FROM items ORDER BY id")]
    D._v4(conn)
    after = [tuple(r) for r in conn.execute("SELECT id, text FROM items ORDER BY id")]
    assert before == after
    conn.close()
