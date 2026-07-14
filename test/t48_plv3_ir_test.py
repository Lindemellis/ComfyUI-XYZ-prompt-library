# T48 — PLv3 IR: ambient-text injection, segment merging, schedule, randomisation
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from prompt_library_v3.compile import compile_text
from prompt_library_v3.diagnostics import W05, W11


def segs(src, **kw):
    r = compile_text(src, **kw)
    return {s.key: s.text for s in r.segments}


# --- §4.2 ambient text is copied into every segment -------------------------


def test_ambient_text_is_injected_into_every_segment():
    # spec §4.2's own table: A, {B}.base, {C}.mask1, {E}.mask2, D
    src = (
        "A, {B}.set{region: base} {C}.set{region: {imask: 1}} "
        "{E}.set{region: {imask: 2}} D"
    )
    got = segs(src)
    assert got[("base",)] == "A, B, D"
    assert got[("imask", 1)] == "A, C, D"
    assert got[("imask", 2)] == "A, E, D"


def test_include_in_base_adds_the_content_to_base_at_its_text_position():
    src = (
        "A, {B}.set{region: base} {C}.set{region: {imask: 1, include_in_base: true}} "
        "{E}.set{region: {imask: 2, include_in_base: true}} D"
    )
    got = segs(src)
    assert got[("base",)] == "A, B, C, E, D"
    # include_in_base never leaks into the *other* region segments
    assert got[("imask", 1)] == "A, C, D"
    assert got[("imask", 2)] == "A, E, D"


def test_base_segment_always_exists_even_with_no_base_group():
    got = segs("quality, {x}.set{region: {imask: 0}}")
    assert got[("base",)] == "quality"


def test_several_base_groups_merge_in_text_order():
    got = segs("{a}.set{region: base} mid, {b}.set{region: base}")
    assert got[("base",)] == "a, mid, b"


def test_same_mask_groups_merge_into_one_segment():
    r = compile_text(
        "{a}.set{region: {imask: 0}} sep, {b}.set{region: {imask: 0}}"
    )
    keys = [s.key for s in r.segments]
    assert keys.count(("imask", 0)) == 1
    text = {s.key: s.text for s in r.segments}[("imask", 0)]
    assert text == "a, sep, b"


def test_merged_regions_that_disagree_warn_W11_and_the_first_one_wins():
    r = compile_text(
        "{a}.set{region: {imask: 0, feather: 10}} {b}.set{region: {imask: 0, feather: 40}}"
    )
    seg = next(s for s in r.segments if s.key == ("imask", 0))
    assert seg.feather == 10
    assert any(d.code == W11 for d in r.diagnostics)


def test_ambient_text_inside_a_plain_group_keeps_its_weight_in_every_segment():
    got = segs("{quality, best}.set{weight: 1.2} {x}.set{region: {imask: 0}}")
    assert got[("base",)] == "(quality, best:1.2)"
    assert got[("imask", 0)] == "(quality, best:1.2), x"


# --- §4.4 schedule ----------------------------------------------------------


def test_schedule_wraps_with_the_comma_inside_the_bracket():
    # the comma lives *inside* the bracket, so a closed window leaves no orphan
    # separator behind; what follows a wrapped part is joined with a plain space
    r = compile_text("[@schedule]: { 0 - 0.2: 1girl, 0.2 - 1: { 2girls, yuri, } }")
    assert r.text == "[1girl, :0,0.2] [2girls, yuri, :0.2,1]"


def test_an_interval_an_ancestor_already_wrapped_is_not_wrapped_again():
    # a [@region] block with a schedule wraps its content once; the region groups
    # inside inherit that same interval and must not bracket it a second time
    r = compile_text(
        "q, [@region]: { base: { 2girls, } [imask: 0, include_in_base: true]: { illya, } }"
        ".set{schedule: {0.2, 0.5}}"
    )
    got = {s.key: s.text for s in r.segments}
    assert got[("base",)] == "q, [2girls, illya, :0.2,0.5]"
    assert got[("imask", 0)] == "[q, illya, :0.2,0.5]"


def test_full_interval_is_not_wrapped():
    r = compile_text("{a}.set{schedule: {0, 1}}")
    assert r.text == "a"


def test_nested_schedules_intersect_and_empty_ones_warn_W05():
    r = compile_text("{ {a}.set{schedule: {0, 0.2}} }.set{schedule: {0.5, 1}}")
    assert r.text == ""
    assert any(d.code == W05 for d in r.diagnostics)


def test_a_scheduled_region_wraps_the_whole_segment():
    # spec §4.4: the region is hoisted to a top-level segment and the time window
    # travels with it — the entire segment text is wrapped exactly once
    r = compile_text("quality, {illya}.set{region: {imask: 0}, schedule: {0.2, 0.5}}")
    seg = next(s for s in r.segments if s.key == ("imask", 0))
    assert seg.text == "[quality, illya, :0.2,0.5]"
    base = next(s for s in r.segments if s.kind == "base")
    assert base.text == "quality"


def test_a_scheduled_region_block_pushes_the_window_onto_each_region():
    r = compile_text(
        "[@region]: { [imask: 0]: { a, } [imask: 1]: { b, } }.set{schedule: {0.2, 0.5}}"
    )
    got = {s.key: s.text for s in r.segments}
    assert got[("imask", 0)] == "[a, :0.2,0.5]"
    assert got[("imask", 1)] == "[b, :0.2,0.5]"


def test_base_segment_is_never_time_limited_as_a_whole():
    # a base group's schedule wraps only its own content, never the ambient text —
    # an empty base prompt outside the window is never what the user meant
    r = compile_text("quality, {a}.set{region: base, schedule: {0, 0.5}}")
    base = next(s for s in r.segments if s.kind == "base")
    assert base.text == "quality, [a, :0,0.5]"


# --- §3.3 group settings ----------------------------------------------------


def test_group_weight_wraps_the_whole_group():
    assert compile_text("{a, b}.set{weight: 1.5}").text == "(a, b:1.5)"


def test_weight_of_one_is_a_no_op():
    assert compile_text("{a, b}.set{weight: 1.0}").text == "a, b"


def test_format_applies_to_each_item_with_a_subgroup_counting_as_one():
    r = compile_text('{a, {b, c}}.set{format: "masterpiece $p"}')
    assert r.text == "masterpiece a, masterpiece b, c"


def test_settings_do_not_inherit_from_the_parent_group():
    r = compile_text("{ {a, b}, c }.set{weight: 1.5}")
    assert r.text == "(a, b, c:1.5)"


# --- §4.6 randomness --------------------------------------------------------


def test_random_select_is_reproducible_for_a_given_seed():
    src = "{a, b, c, d, e}.set{random_select: 2}"
    first = compile_text(src, seed=7).text
    assert first == compile_text(src, seed=7).text
    assert len(first.split(", ")) == 2


def test_a_different_seed_gives_a_different_pick():
    src = "{a, b, c, d, e, f, g, h}.set{random_select: 3}"
    picks = {compile_text(src, seed=s).text for s in range(8)}
    assert len(picks) > 1


def test_random_select_keeps_the_text_order():
    src = "{a, b, c, d, e}.set{random_select: 3}"
    out = compile_text(src, seed=3).text.split(", ")
    assert out == sorted(out)  # a..e are alphabetical in text order


def test_sibling_groups_with_the_same_content_randomise_independently():
    # the RNG is keyed on the group's tree path, so identical siblings do not
    # move in lockstep
    src = "{a, b, c, d, e, f}.set{shuffle: true} {a, b, c, d, e, f}.set{shuffle: true}"
    parts = compile_text(src, seed=1).text.split(", ")
    assert parts[:6] != parts[6:]


def test_an_explicit_group_seed_ignores_the_node_seed():
    src = "{a, b, c, d, e}.set{shuffle: true, seed: 99}"
    assert compile_text(src, seed=1).text == compile_text(src, seed=2).text


def test_dropout_of_one_drops_everything():
    assert compile_text("{a, b, c}.set{dropout: 1}").text == ""


def test_dropout_of_zero_keeps_everything():
    assert compile_text("{a, b, c}.set{dropout: 0}").text == "a, b, c"


def test_a_group_randomises_identically_in_every_segment_it_lands_in():
    # include_in_base renders the same group twice — the picks must agree,
    # otherwise base and the region would disagree about what is in the picture
    src = (
        "{a, b, c, d, e, f}.set{region: {imask: 0, include_in_base: true}, "
        "random_select: 3}"
    )
    r = compile_text(src, seed=5)
    got = {s.key: s.text for s in r.segments}
    assert got[("base",)] == got[("imask", 0)]


# --- escaping ---------------------------------------------------------------


def test_escaped_parens_and_colons_survive_compilation():
    r = compile_text(r"smile \(cat\), (artist:wlop:1.1)")
    assert r.text == r"smile \(cat\), (artist\:wlop:1.1)"


def test_a_subgroup_is_how_two_tags_stay_one_unit():
    # this is what `\,` would have been for; the subgroup does it without making
    # the item count depend on a backslash
    assert compile_text('{{a, b}, c}.set{format: "x $p"}').text == "x a, b, x c"
    assert compile_text("{{a, b}, c}.set{random_select: 1, seed: 1}").text in (
        "a, b",
        "c",
    )


def test_lora_items_pass_through():
    assert compile_text("1girl, <lora:foo:1.0:0.8>").text == "1girl, <lora:foo:1.0:0.8>"


def test_empty_text_compiles_to_empty():
    assert compile_text("   ").text == ""
