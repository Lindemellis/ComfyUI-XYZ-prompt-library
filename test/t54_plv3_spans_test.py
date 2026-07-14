# T54 — PLv3 source spans: the handles the detail page edits through.
#
# A span that is off by one character rewrites the wrong bytes and corrupts the
# user's document, so every span is asserted by slicing the source with it.
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from prompt_library_v3.ast_json import to_json
from prompt_library_v3.parser import parse


def ast(src):
    root, _ = parse(src)
    return src, to_json(root)


def cut(src, span):
    return src[span[0] : span[1]]


# --- items ------------------------------------------------------------------


def test_text_span_excludes_the_surrounding_whitespace():
    # the span must not swallow the indent, or every edit re-flows the document
    src, a = ast("  1girl  ,   blonde hair  ")
    assert [cut(src, c["span"]) for c in a["children"]] == ["1girl", "blonde hair"]


def test_text_span_survives_newlines_and_indentation():
    src, a = ast("{\n    2girls,\n    yuri,\n}")
    kids = a["children"][0]["children"]
    assert [cut(src, c["span"]) for c in kids] == ["2girls", "yuri"]


def test_a_colon_tag_spans_the_whole_tag():
    src, a = ast("(artist:wlop:1.1)")
    group = a["children"][0]
    assert cut(src, group["children"][0]["span"]) == "artist:wlop"
    assert cut(src, group["spans"]["fields"]["weight"]["value"]) == "1.1"


def test_item_span_starts_at_the_first_atom_not_at_the_whitespace():
    # `foo (bar:1.2) baz` is one item built from several atoms; its span must begin
    # at the `f`, not at the space separating it from the previous comma
    src, a = ast("1girl,   foo (bar:1.2) baz")
    item = a["children"][1]
    assert item["kind"] == "item"
    assert cut(src, item["span"]) == "foo (bar:1.2) baz"


def test_escaped_parens_round_trip_through_the_span():
    # what the detail page shows and writes back is the *source*, so a slice of the
    # span must be exactly what the user typed — escapes and all
    src, a = ast(r"a, smile \(cat\)")
    assert cut(src, a["children"][1]["span"]) == r"smile \(cat\)"


def test_lora_span():
    src, a = ast("1girl, <lora:foo:0.8>")
    assert cut(src, a["children"][1]["span"]) == "<lora:foo:0.8>"


# --- groups -----------------------------------------------------------------


def test_group_span_covers_the_braces_and_the_set_block():
    src, a = ast("a, {b, c}.set{weight: 1.2}, d")
    g = a["children"][1]
    assert cut(src, g["span"]) == "{b, c}.set{weight: 1.2}"
    assert cut(src, g["spans"]["content"]) == "b, c"
    assert cut(src, g["spans"]["set_block"]) == ".set{weight: 1.2}"
    assert cut(src, g["spans"]["set_body"]) == "weight: 1.2"


def test_group_without_a_set_block_reports_none():
    src, a = ast("{a, b}")
    g = a["children"][0]
    assert g["spans"]["set_block"] is None
    assert g["spans"]["set_body"] is None
    assert cut(src, g["spans"]["content"]) == "a, b"


def test_field_value_and_entry_spans():
    src, a = ast("{a}.set{weight: 1.2, shuffle: true, dropout: 0.5}")
    f = a["children"][0]["spans"]["fields"]
    assert cut(src, f["weight"]["value"]) == "1.2"
    assert cut(src, f["weight"]["entry"]) == "weight: 1.2,"  # trailing comma included
    assert cut(src, f["shuffle"]["value"]) == "true"
    assert cut(src, f["dropout"]["value"]) == "0.5"
    assert cut(src, f["dropout"]["entry"]) == "dropout: 0.5"  # last field, no comma


def test_format_string_span_includes_the_quotes():
    src, a = ast('{a}.set{format: "masterpiece $p"}')
    f = a["children"][0]["spans"]["fields"]
    assert cut(src, f["format"]["value"]) == '"masterpiece $p"'


def test_library_header_span():
    src, a = ast("[characters.illya]: { illya, }.set{weight: 1.1}")
    g = a["children"][0]
    assert g["header"] == "characters.illya"
    assert cut(src, g["spans"]["header"]) == "[characters.illya]"
    assert cut(src, g["span"]) == "[characters.illya]: { illya, }.set{weight: 1.1}"


# --- schedule ---------------------------------------------------------------


def test_schedule_in_a_set_block_is_form_set():
    src, a = ast("{a}.set{schedule: {0.2, 0.5}}")
    g = a["children"][0]
    assert g["spans"]["schedule_form"] == "set"
    assert cut(src, g["spans"]["fields"]["schedule"]["value"]) == "{0.2, 0.5}"


def test_schedule_in_a_block_head_is_form_block():
    # the range lives in the head `0 - 0.2`, not in a `.set{}` — the detail page
    # must rewrite *that*, not invent a `.set{schedule: ...}` beside it
    src, a = ast("[@schedule]: { 0 - 0.2: 1girl, 0.2 - 1: 2girls }")
    entries = a["children"][0]["children"]
    assert [e["spans"]["schedule_form"] for e in entries] == ["block", "block"]
    assert cut(src, entries[0]["spans"]["fields"]["schedule"]["value"]) == "0 - 0.2"
    assert cut(src, entries[1]["spans"]["fields"]["schedule"]["value"]) == "0.2 - 1"


# --- region -----------------------------------------------------------------


def test_region_in_a_set_block_is_form_set_with_nested_field_spans():
    src, a = ast("{a}.set{region: {imask: 0, feather: 10}}")
    s = a["children"][0]["spans"]
    assert s["region_form"] == "set"
    assert cut(src, s["region_decl"]) == "{imask: 0, feather: 10}"
    assert cut(src, s["region_body"]) == "imask: 0, feather: 10"
    assert cut(src, s["region_fields"]["imask"]["value"]) == "0"
    assert cut(src, s["region_fields"]["feather"]["value"]) == "10"


def test_region_in_a_block_head_is_form_block():
    src, a = ast(
        "[@region]: {\n"
        "    base: { 2girls, }\n"
        "    [imask: 0, feather: 10]: { illya, }\n"
        "}"
    )
    entries = a["children"][0]["children"]
    base, masked = entries
    assert base["spans"]["region_form"] == "block"
    assert cut(src, base["spans"]["region_decl"]) == "base"
    assert cut(src, masked["spans"]["region_decl"]) == "[imask: 0, feather: 10]"
    assert cut(src, masked["spans"]["region_fields"]["feather"]["value"]) == "10"


def test_mask_array_span():
    src, a = ast("{a}.set{region: {mask: [0, 0.2, 0.1, 0.3]}}")
    s = a["children"][0]["spans"]
    assert cut(src, s["region_fields"]["mask"]["value"]) == "[0, 0.2, 0.1, 0.3]"


# --- the invariant, over a realistic document -------------------------------

DOC = """masterpiece, (artist:wlop:1.1), <lora:detail:0.8>,

[characters.illya]: {
    illya, blonde hair,
}.set{weight: 1.1}

[@region]: {
    base: { 2girls, yuri, }
    [imask: 0, feather: 10, include_in_base: true]: {
        illya, {short, twintails}.set{random_select: 1},
    }
}.set{schedule: {0.2, 0.5}}
"""


def test_every_span_slices_back_to_something_sane():
    src, a = ast(DOC)

    def walk(node, root=False):
        span = node.get("span")
        if span and not root:  # the root spans the whole document, trailing \n and all
            piece = cut(src, span)
            # a span never starts or ends in the middle of whitespace
            assert piece == piece.strip(), repr(piece)
            assert piece, "empty span"
        for key, value in (node.get("spans") or {}).items():
            if key in ("region_form", "schedule_form") or value is None:
                continue
            if key in ("fields", "region_fields"):
                for entry in value.values():
                    for s in entry.values():
                        if s:
                            assert cut(src, s).strip(), f"{key} span is blank"
                continue
            if key in ("content", "set_body"):
                continue  # these legitimately span whitespace
            assert cut(src, value).strip(), f"{key} span is blank"
        for child in node.get("children") or []:
            walk(child)

    walk(a, root=True)


def test_spans_are_nested_not_overlapping():
    _, a = ast(DOC)

    def walk(node):
        s, e = node["span"]
        for child in node.get("children") or []:
            cs, ce = child["span"]
            assert s <= cs and ce <= e, f"child {child['span']} escapes parent {node['span']}"
            walk(child)

    walk(a)


# --- schedule entries are not groups ----------------------------------------


def test_a_bare_schedule_entry_is_marked_implicit():
    """`0.65 - 1: open eyes` has no braces. The Group around it exists only because a
    Group is where a schedule setting can hang — the detail page must be able to tell,
    or it draws a group card with a gear that writes `open eyes.set{…}` (a syntax error).
    """
    src = "[@schedule]: {\n    0 - 0.65: closed eyes,\n    0.65 - 1: { open eyes }\n}"
    root, _ = parse(src)
    entries = root.children[0].children
    assert entries[0].implicit is True     # bare item
    assert entries[1].implicit is False    # the user wrote braces


def test_the_end_of_an_entry_is_the_start_of_the_next_one():
    """Spec §3.4: the number between two entries is ONE boundary. The parser rewrites the
    previous entry's end to the next entry's start, which is why the detail page has to
    edit both heads at once — editing only one makes the text and the tree disagree."""
    src = "[@schedule]: {\n    0 - 0.9: a,\n    0.3 - 1: b\n}"
    root, _ = parse(src)
    a, b = root.children[0].children
    assert a.settings.schedule == (0.0, 0.3), "the end was not pulled to the next start"
    assert b.settings.schedule == (0.3, 1.0)


# --- the region kind is inferred, so it must not be written down ------------


def test_an_explicit_kind_base_overrides_the_inference():
    """Why the kind dropdown could not be changed: `mask:` alone MEANS kind=mask, but a
    `kind: base` sitting next to it wins — and the old "add one field" code wrote exactly
    that. The rule is: never write a kind that can be inferred."""
    inferred, _ = parse("{a}.set{region: {mask: [0, 0.5, 0, 1]}}")
    assert inferred.children[0].settings.region.kind == "mask"

    pinned, _ = parse("{a}.set{region: {kind: base, mask: [0, 0.5, 0, 1]}}")
    assert pinned.children[0].settings.region.kind == "base"


def test_imask_is_inferred_the_same_way():
    root, _ = parse("{a}.set{region: {imask: 2, feather: 12}}")
    r = root.children[0].settings.region
    assert (r.kind, r.imask, r.feather) == ("imask", 2, 12)
