# T47 — PLv3 parser: groups, .set{}, paren weights, [@schedule]/[@region] desugar
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from prompt_library_v3.diagnostics import E03, PLv3Error
from prompt_library_v3.parser import Group, Item, Lora, Text, parse


def test_plain_items_split_on_commas():
    root, _ = parse("1girl, blonde hair,")
    assert [c.text for c in root.children] == ["1girl", "blonde hair"]


def test_groups_do_not_need_a_comma_after_them():
    src = """
    {
        2girls, yuri,

        {
            blonde hair, blue eyes,
        }

        { white hair, red eyes, }
    }
    """
    root, _ = parse(src)
    assert len(root.children) == 1
    outer = root.children[0]
    assert isinstance(outer, Group)
    # two plain items + two subgroups, in text order
    assert [type(c).__name__ for c in outer.children] == ["Text", "Text", "Group", "Group"]


def test_set_block_parses_every_field():
    root, diags = parse(
        '{a, b}.set{weight: 1.5, format: "masterpiece $p", shuffle: true, '
        "random_select: 3-5, dropout: 0.25, seed: 123, schedule: {0.2, 0.5}}"
    )
    s = root.children[0].settings
    assert s.weight == 1.5
    assert s.format == "masterpiece $p"
    assert s.shuffle is True
    assert s.random_select == (3, 5)
    assert s.dropout == 0.25
    assert s.seed == 123
    assert s.schedule == (0.2, 0.5)
    assert list(diags) == []


def test_a_trailing_comma_in_a_set_block_is_tolerated():
    # a user types it, and the detail page's "remove a field" can leave one behind;
    # it used to fall through to "bad config value '}'" and abort the whole document
    root, diags = parse("{a}.set{weight: 1.2, shuffle: true, }")
    s = root.children[0].settings
    assert s.weight == 1.2 and s.shuffle is True
    assert list(diags) == []


def test_random_select_single_number():
    root, _ = parse("{a, b}.set{random_select: 2}")
    assert root.children[0].settings.random_select == (2, 2)


def test_paren_with_one_item_is_a_weighted_item():
    root, _ = parse("(masterpiece:1.2)")
    g = root.children[0]
    assert isinstance(g, Group) and g.paren
    assert g.settings.weight == 1.2
    assert [c.text for c in g.children] == ["masterpiece"]


def test_paren_with_several_items_is_a_group():
    # spec §3.1: `(a, b, c:1.2)` == `{a, b, c}.set{weight: 1.2}`
    root, _ = parse("(a, b, c:1.2)")
    g = root.children[0]
    assert g.settings.weight == 1.2
    assert [c.text for c in g.children] == ["a", "b", "c"]


def test_paren_without_weight_keeps_its_parens():
    root, _ = parse("(a, b)")
    g = root.children[0]
    assert g.settings.weight is None and g.paren


def test_nested_paren_weights():
    root, _ = parse("((tag:1.2), other:1.1)")
    outer = root.children[0]
    assert outer.settings.weight == 1.1
    assert outer.children[0].settings.weight == 1.2


def test_the_last_colon_number_is_the_weight_the_rest_is_the_tag():
    # `(artist:wlop:1.1)` -> tag "artist:wlop" at weight 1.1.  No escaping asked of
    # the user; the colon is only a weight separator in that one position.
    root, diags = parse("(artist:wlop:1.1)")
    g = root.children[0]
    assert g.settings.weight == 1.1
    assert g.children[0].text == r"artist\:wlop"  # output form, for prompt-control
    assert list(diags) == []


def test_a_colon_with_no_number_after_it_stays_literal():
    root, _ = parse("(artist:wlop)")
    g = root.children[0]
    assert g.settings.weight is None
    assert g.children[0].text == r"artist\:wlop"


def test_escaping_the_colon_explicitly_still_works():
    root, _ = parse(r"(artist\:wlop:1.1)")
    g = root.children[0]
    assert g.settings.weight == 1.1
    assert g.children[0].text == r"artist\:wlop"


def test_lora_item():
    root, _ = parse("1girl, <lora:foo:1.0>")
    assert isinstance(root.children[1], Lora)
    assert root.children[1].text == "<lora:foo:1.0>"


def test_mixed_atoms_form_one_item():
    root, _ = parse("foo (bar:1.2) baz, next")
    first = root.children[0]
    assert isinstance(first, Item)
    assert len(root.children) == 2


def test_library_ref_block_keeps_its_header():
    root, _ = parse("[characters.illya]: { illya, blonde hair, }.set{weight: 1.1}")
    g = root.children[0]
    assert g.header == "characters.illya"
    assert g.settings.weight == 1.1
    assert [c.text for c in g.children] == ["illya", "blonde hair"]


def test_nested_library_refs_keep_both_headers():
    root, _ = parse(
        "[chars.A]: { 2girls, [chars.illya]: { illya, blonde hair, } }"
    )
    outer = root.children[0]
    inner = outer.children[1]
    assert outer.header == "chars.A"
    assert inner.header == "chars.illya"


def test_schedule_block_desugars_to_groups_with_schedule():
    # The head is `0 - 0.2`, not `[0, 0.2]`: a bracketed head would have exactly the
    # shape of a library reference (`[characters.illya]: { … }`), and two things that
    # mean nothing alike must not look alike (spec §3.4).
    root, _ = parse(
        "[@schedule]: {\n"
        "  0 - 0.2: 1girl,\n"
        "  0.2 - 0.5: { 2girls, yuri, },\n"
        "  0.5 - 1: 3girls\n"
        "}"
    )
    wrapper = root.children[0]
    got = [c.settings.schedule for c in wrapper.children]
    assert got == [(0.0, 0.2), (0.2, 0.5), (0.5, 1.0)]
    assert wrapper.settings.schedule is None
    assert wrapper.children[0].children[0].text == "1girl"


def test_schedule_endpoints_are_normalised_to_the_next_start():
    # spec §3.4: each entry's own `start` wins; the previous `end` is rewritten
    root, _ = parse("[@schedule]: { 0 - 0.9: a, 0.3 - 1: b }")
    got = [c.settings.schedule for c in root.children[0].children]
    assert got == [(0.0, 0.3), (0.3, 1.0)]


def test_region_block_desugars_to_groups_with_region():
    root, _ = parse(
        "[@region]: {\n"
        "  base: { 2girls, }\n"
        "  [imask: 0, feather: 10, include_in_base: true]: { illya, }\n"
        "  [mask: [0, 0.2, 0.1, 0.3]]: { miyu, }\n"
        "  fill: { detailed background, }\n"
        "}"
    )
    kids = root.children[0].children
    regions = [c.settings.region for c in kids]
    assert [r.kind for r in regions] == ["base", "imask", "mask", "fill"]
    assert regions[1].imask == 0
    assert regions[1].feather == 10
    assert regions[1].include_in_base is True
    assert regions[2].mask == (0.0, 0.2, 0.1, 0.3)


def test_region_kind_is_inferred_from_the_field_used():
    root, _ = parse("{a}.set{region: {imask: 2}}")
    r = root.children[0].settings.region
    assert r.kind == "imask" and r.imask == 2

    root, _ = parse("{a}.set{region: base}")
    assert root.children[0].settings.region.kind == "base"


def test_region_block_may_carry_a_schedule():
    # spec §3.5: this is the "all regions inside share a time window" capability
    root, _ = parse("[@region]: { [imask: 0]: { a, } }.set{schedule: {0.2, 0.5}}")
    assert root.children[0].settings.schedule == (0.2, 0.5)


def test_group_paths_are_stable_and_unique():
    root, _ = parse("{a}, {b, {c}}")
    assert root.children[0].path == (0,)
    assert root.children[1].path == (1,)
    assert root.children[1].children[1].path == (1, 1)


@pytest.mark.parametrize(
    "src",
    [
        "{a, b",          # unclosed brace
        "a, b}",          # stray closer
        "(a, b",          # unclosed paren
        "[@region]: {",   # unclosed region block
    ],
)
def test_unbalanced_text_is_E03(src):
    with pytest.raises(PLv3Error) as exc:
        parse(src)
    assert exc.value.diag.code == E03


def test_deep_nesting_is_rejected_rather_than_blowing_the_stack():
    src = "{" * 200 + "a" + "}" * 200
    with pytest.raises(PLv3Error):
        parse(src)


def test_a_schedule_head_that_is_not_a_range_is_E03():
    # `[@schedule]` entries take a range, and nothing else — including a bracketed
    # head, which now belongs exclusively to library references
    with pytest.raises(PLv3Error) as exc:
        parse("[@schedule]: { [0, 0.2]: 1girl }")
    assert exc.value.diag.code == E03
