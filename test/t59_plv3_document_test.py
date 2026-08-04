# T59 — PLv3 documents: the structured source of truth.
#
# The document replaces "the text is the truth" (spec §5.2). Two properties carry
# the whole design and are asserted here on every construct the language has:
#
#   1. render(from_text(t)) == t          — byte-for-byte, no pretty-printer
#   2. switching a node off removes it from the text and NOTHING else moves;
#      switching it back on puts it back where it was.
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from prompt_library_v3.document import Document, from_text, reconcile, render

SOURCES = [
    "",
    "masterpiece",
    "masterpiece, best quality, 1girl",
    "masterpiece,\n    worst quality,\n    1girl,\n",
    "a, (b:1.2), <lora:foo:1.0>, c",
    "{ nested, group }, tail",
    "[chars.illya]: { blonde hair, red eyes }, extra",
    """[@region]: {
    base: { 2girls }

    [imask: 0]: { red dress }

    [imask: 1]: { blue dress }

    fill: { detailed background }
}""",
    """[@schedule]: {
    0 - 0.3: closed eyes,
    0.3 - 1: open eyes,
}""",
    "{ a, b }.set{ weight: 1.2, shuffle: true }, c",
]


def ids_of(doc):
    return [n.id for n in doc.root.walk()]


# --- property 1: round trip -------------------------------------------------


def test_round_trip_is_byte_exact():
    for src in SOURCES:
        assert render(from_text(src)) == src, src


def test_round_trip_survives_json():
    for src in SOURCES:
        doc = Document.from_json(from_text(src).to_json())
        assert render(doc) == src, src


def test_every_node_has_a_unique_id():
    for src in SOURCES:
        ids = ids_of(from_text(src))
        assert len(ids) == len(set(ids)), src


# --- property 2: a toggle moves nothing -------------------------------------


def kids(doc):
    return doc.root.children


def test_disabling_a_middle_item_leaves_the_others_in_place():
    doc = from_text("masterpiece, worst quality, 1girl")
    doc.set_enabled(kids(doc)[1].id, False)
    assert render(doc) == "masterpiece, 1girl"


def test_disabling_the_first_item_does_not_leave_a_leading_comma():
    doc = from_text("masterpiece, worst quality, 1girl")
    doc.set_enabled(kids(doc)[0].id, False)
    assert render(doc) == "worst quality, 1girl"


def test_disabling_the_last_item_is_clean():
    doc = from_text("masterpiece, worst quality, 1girl")
    doc.set_enabled(kids(doc)[2].id, False)
    assert render(doc) == "masterpiece, worst quality, "


def test_re_enabling_restores_the_original_text():
    for src in SOURCES:
        doc = from_text(src)
        for node in list(doc.root.walk())[1:]:
            doc.set_enabled(node.id, False)
            doc.set_enabled(node.id, True)
        assert render(doc) == src, src


def test_disabling_a_region_segment_keeps_the_block_shape():
    src = SOURCES[7]
    doc = from_text(src)
    region = kids(doc)[0]
    segment = region.children[1]  # [imask: 0]: { red dress }
    doc.set_enabled(segment.id, False)
    out = render(doc)
    assert "red dress" not in out
    assert "blue dress" in out and "2girls" in out and "detailed background" in out
    # the block itself is untouched — same head, same closing brace, same order
    assert out.startswith("[@region]: {") and out.rstrip().endswith("}")
    assert out.index("2girls") < out.index("blue dress")


def test_disabling_a_whole_block_removes_it_all():
    doc = from_text("[chars.illya]: { blonde hair }, extra")
    doc.set_enabled(kids(doc)[0].id, False)
    assert render(doc) == "extra"


def test_multiline_layout_is_preserved_when_one_line_goes_off():
    doc = from_text("masterpiece,\n    worst quality,\n    1girl,\n")
    doc.set_enabled(kids(doc)[1].id, False)
    assert render(doc) == "masterpiece,\n    1girl,\n"


def test_any_single_toggle_still_parses():
    """A switch must never be able to produce a broken document.

    Dropping a node drops its separator too, so the danger is at the edges: the
    first item's comma, an only child leaving `{ }`, a region block losing its
    base. Exhaustive over every node of every source.
    """
    from prompt_library_v3.parser import parse

    for src in SOURCES:
        for node_id in [n.id for n in from_text(src).root.walk()][1:]:
            doc = from_text(src)
            doc.set_enabled(node_id, False)
            out = render(doc)
            _, diags = parse(out)
            errors = [d.code for d in diags.items if d.code.startswith("E")]
            assert not errors, f"{errors} after disabling {node_id} in {src!r} -> {out!r}"


def test_toggling_does_not_disturb_the_compiled_output_of_the_rest():
    from prompt_library_v3 import compile_text

    src = SOURCES[7]  # the four-part region block
    doc = from_text(src)
    segment = doc.root.children[0].children[1]  # [imask: 0]: { red dress }
    doc.set_enabled(segment.id, False)

    before = compile_text(src).text.splitlines()
    after = compile_text(render(doc)).text.splitlines()
    dropped = [line for line in before if line not in after]
    assert len(dropped) == 1 and "red dress" in dropped[0]
    # every other line survives, in the same order
    assert [line for line in before if line in after] == after


# --- the invariant the frontend pairs rows up with ---------------------------


def test_enabled_children_line_up_with_a_reparse():
    """`indexDocument` in js/plv3/detail.js walks the document and the AST in step:
    it consumes one AST child per ENABLED document child, and treats the rest as
    parked. If that correspondence ever slipped, every switch below the slip would
    be wired to the wrong item — silently.

    Checked with every single node switched off, one at a time, at every depth.
    """
    from prompt_library_v3.parser import Group, Item, Lora, Text, parse

    def kind_of(node):
        if isinstance(node, Group):
            return "group"
        if isinstance(node, Lora):
            return "lora"
        if isinstance(node, Item):
            return "item"
        return "text"

    def check(doc_node, ast_node, where):
        ast_kids = list(getattr(ast_node, "children", []) or [])
        i = 0
        for child in doc_node.children:
            if not child.enabled:
                continue
            assert i < len(ast_kids), f"{where}: document has more enabled children than the text"
            ast_child = ast_kids[i]
            i += 1
            assert child.kind == kind_of(ast_child), (
                f"{where}: pairing slipped — doc {child.kind} vs ast {kind_of(ast_child)}"
            )
            if child.kind == "group" and not child.opaque:
                check(child, ast_child, f"{where}/{child.id}")
        assert i == len(ast_kids), f"{where}: the text has children the document does not"

    for src in SOURCES:
        for node_id in [n.id for n in from_text(src).root.walk()][1:]:
            doc = from_text(src)
            doc.set_enabled(node_id, False)
            root, _ = parse(render(doc), recover=True)
            check(doc.root, root, f"{src!r} off={node_id}")


# --- reconciling a hand-edited text -----------------------------------------


def test_editing_the_text_keeps_ids_of_untouched_items():
    doc = from_text("a, b, c")
    before = {n.raw: n.id for n in kids(doc)}
    merged = reconcile(doc, "a, b, c, d")
    after = {n.raw: n.id for n in kids(merged)}
    for raw in ("a", "b", "c"):
        assert after[raw] == before[raw]
    assert after["d"] not in before.values()


def test_a_disabled_item_survives_an_edit_elsewhere():
    doc = from_text("a, b, c")
    doc.set_enabled(kids(doc)[1].id, False)
    assert render(doc) == "a, c"

    merged = reconcile(doc, "a, c, d")
    # b is still parked at index 1 and still off
    raws = [n.raw for n in kids(merged)]
    assert raws == ["a", "b", "c", "d"]
    assert [n.enabled for n in kids(merged)] == [True, False, True, True]
    assert render(merged) == "a, c, d"

    # ...and switching it back on puts it back in its old place
    parked = kids(merged)[1]
    merged.set_enabled(parked.id, True)
    assert render(merged) == "a, b, c, d"


def test_editing_an_item_in_place_keeps_its_id():
    doc = from_text("a, b, c")
    original = kids(doc)[1].id
    merged = reconcile(doc, "a, bbb, c")
    assert kids(merged)[1].raw == "bbb"
    assert kids(merged)[1].id == original


def test_reconcile_never_reuses_an_id():
    doc = from_text("a, b, c")
    doc.set_enabled(kids(doc)[0].id, False)
    merged = reconcile(doc, "b, c, d, e")
    ids = ids_of(merged)
    assert len(ids) == len(set(ids))


def test_re_enabling_after_an_edit_does_not_glue_two_items_together():
    """The parked node was LAST when it was parsed, so its separator has no comma.

    Something has landed behind it since; without a supplied comma the two would
    render as `a, bc` — one item, silently.
    """
    doc = from_text("a, b")
    doc.set_enabled(kids(doc)[1].id, False)
    merged = reconcile(doc, "a, c")
    parked = [n for n in kids(merged) if not n.enabled][0]
    merged.set_enabled(parked.id, True)
    out = render(merged)
    assert out == "a, b, c", out

    from prompt_library_v3.parser import parse
    root, _ = parse(out)
    assert len(root.children) == 3


# --- one toggle == one text edit --------------------------------------------


def apply_edit(text, edit):
    start, end = edit["span"]
    return text[:start] + edit["insert"] + text[end:]


def test_toggle_edit_is_a_minimal_span_edit():
    from prompt_library_v3.document import toggle_edit

    for src in SOURCES:
        for node_id in [n.id for n in from_text(src).root.walk()][1:]:
            doc = from_text(src)
            edit = toggle_edit(doc, node_id, False)
            assert edit is not None
            # applying the edit to the old text must give exactly the new render
            assert apply_edit(src, edit) == edit["text"], (src, node_id)
            # ...and it must be a single contiguous cut, not a whole-document rewrite
            assert edit["span"][0] <= edit["span"][1] <= len(src)


def test_toggle_edit_round_trips_off_and_on():
    from prompt_library_v3.document import toggle_edit

    src = "masterpiece, worst quality, 1girl"
    doc = from_text(src)
    target = kids(doc)[1].id

    off = toggle_edit(doc, target, False)
    assert apply_edit(src, off) == "masterpiece, 1girl"

    doc = Document.from_json(off["doc"])
    on = toggle_edit(doc, target, True)
    assert apply_edit(off["text"], on) == src


def test_toggle_edit_on_an_unknown_id_is_none():
    from prompt_library_v3.document import toggle_edit

    assert toggle_edit(from_text("a"), "nope", False) is None


def test_disabled_node_inside_an_edited_group_is_kept():
    doc = from_text("{ a, b }, tail")
    group = kids(doc)[0]
    doc.set_enabled(group.children[0].id, False)
    assert render(doc) == "{ b }, tail"

    merged = reconcile(doc, "{ b }, tail, more")
    inner = kids(merged)[0]
    assert [c.raw for c in inner.children] == ["a", "b"]
    assert [c.enabled for c in inner.children] == [False, True]
