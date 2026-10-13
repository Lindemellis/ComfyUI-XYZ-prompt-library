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


def test_include_in_base_works_on_a_fill_region_too():
    # §4.2's walk never looks at the kind: a fill's background text can be asked into
    # the base as well — when the same group holds a base region.
    src = (
        "A, {B}.set{region: base} {C}.set{region: {imask: 1}} "
        "{E}.set{region: {kind: fill, include_in_base: true}} D"
    )
    got = segs(src)
    assert got[("base",)] == "A, B, E, D"
    assert got[("fill",)] == "A, E, D"
    assert got[("imask", 1)] == "A, C, D"


def test_include_in_base_never_conjures_a_base():
    # user decision 2026-10-13: without a live base region (absent, or switched
    # off — which removes it from the text) the flag does nothing at all.
    src = "A, {C}.set{region: {imask: 1, include_in_base: true}} D"
    got = segs(src)
    assert ("base",) not in got
    assert got[("imask", 1)] == "A, C, D"
    r = compile_text("[@region]: { [mask: [0, 0.5, 0, 1], include_in_base: true]: { b } [fill]: { c } }")
    assert not any(s.kind == "base" for s in r.segments)


def test_include_in_base_needs_a_base_in_its_own_region_group():
    src = (
        "[@region]: { base: { x } [imask: 0]: { y } } "
        "[@region]: { [imask: 1, include_in_base: true]: { z } }"
    )
    got = segs(src)
    assert got[("base",)] == "x"
    assert got[("imask", 1)] == "z"
    src = "[@region]: { base: { x } [imask: 0, include_in_base: true]: { y } }"
    assert segs(src)[("base",)] == "x, y"


def test_ambient_alone_no_longer_conjures_a_base_segment():
    # a region with no `region: base` group and no include_in_base produces NO
    # base segment — ambient text injects into the region instead of forcing a
    # full-image base the user never asked for
    r = compile_text("quality, {x}.set{region: {imask: 0}}")
    got = {s.key: s.text for s in r.segments}
    assert ("base",) not in got
    assert got[("imask", 0)] == "quality, x"


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


def test_ambient_text_inside_a_plain_group_keeps_its_weight_when_injected():
    got = segs("{quality, best}.set{weight: 1.2} {x}.set{region: {imask: 0}}")
    assert ("base",) not in got
    assert got[("imask", 0)] == "(quality, best:1.2), x"


# --- §4.4 schedule ----------------------------------------------------------


def test_schedule_wraps_with_the_comma_inside_the_bracket():
    # the comma lives *inside* the bracket, so a closed window leaves no orphan
    # separator behind; what follows a wrapped part is joined with a plain space
    r = compile_text("[@schedule]: { 0 - 0.2: 1girl, 0.2 - 1: { 2girls, yuri, } }")
    assert r.text == "[1girl, :0,0.2] [2girls, yuri, :0.2,1]"


def test_a_scheduled_region_block_exists_only_inside_its_window():
    # decision 2026-10-13: a schedule on (or above) a region decides whether the
    # region exists. Outside the window there is no region syntax at all, only the
    # ambient text; inside it nothing is bracketed twice.
    r = compile_text(
        "q, [@region]: { base: { 2girls, } [imask: 0, include_in_base: true]: { illya, } }"
        ".set{schedule: {0.2, 0.5}}"
    )
    assert r.text == (
        "[q, :0,0.2] [q, 2girls, illya\n"
        "COUPLE IMASK(0, 1) q, illya, :0.2,0.5] [q, :0.5,1]"
    )


def test_full_interval_is_not_wrapped():
    r = compile_text("{a}.set{schedule: {0, 1}}")
    assert r.text == "a"


def test_nested_schedules_intersect_and_empty_ones_warn_W05():
    r = compile_text("{ {a}.set{schedule: {0, 0.2}} }.set{schedule: {0.5, 1}}")
    assert r.text == ""
    assert any(d.code == W05 for d in r.diagnostics)


def test_a_scheduled_region_is_absent_outside_its_window():
    # Outside its window the region is gone, not an empty prompt holding its mask.
    # Inside it the area no region covers gets the ambient text (FILL), never an
    # empty full-image base that would take half of every region.
    r = compile_text("quality, {illya}.set{region: {imask: 0}, schedule: {0.2, 0.5}}")
    assert r.text == (
        "[quality, :0,0.2] [FILL() quality\n"
        "COUPLE IMASK(0, 1) quality, illya, :0.2,0.5] [quality, :0.5,1]"
    )
    # the compiler's own fill is not reported as a region the user wrote
    assert not any(s.kind == "fill" for s in r.segments)


def test_a_scheduled_region_block_takes_every_region_with_it():
    r = compile_text(
        "[@region]: { [imask: 0]: { a, } [imask: 1]: { b, } }.set{schedule: {0.2, 0.5}}"
    )
    assert r.text == "[FILL()\nCOUPLE IMASK(0, 1) a\nCOUPLE IMASK(1, 1) b, :0.2,0.5]"


def test_a_scheduled_base_is_absent_outside_its_window_too():
    # The same rule as every other region: outside the window there is no base;
    # what it covered falls to the ambient text, never to an empty prompt.
    r = compile_text("quality, {a}.set{region: base, schedule: {0, 0.5}}")
    assert r.text == "[quality, a, :0,0.5] [quality, :0.5,1]"
    r = compile_text("quality, [@region]: { [base]: { a }.set{schedule: {0, 0.5}}, [imask: 0]: { b } }")
    assert r.text == (
        "[quality, a\nCOUPLE IMASK(0, 1) quality, b, :0,0.5] "
        "[FILL() quality\nCOUPLE IMASK(0, 1) quality, b, :0.5,1]"
    )


def test_a_schedule_inside_a_region_only_times_that_content():
    r = compile_text("q, [@region]: { [imask: 0]: { a, { early }.set{schedule: {0, 0.4}} } }")
    assert r.text == "FILL() q\nCOUPLE IMASK(0, 1) q, a, [early, :0,0.4]"


def test_a_later_schedule_stage_reaches_the_area_a_region_left():
    # A region inside a [@schedule] stage lives in that stage only; the next stage's
    # content is ambient and reaches every area, including the one it left.
    r = compile_text(
        "q, [@schedule]: { 0 - 0.4: { { A }.set{region: {mask: [0, 0.5, 0, 1]}} }, 0.4 - 1: { C } },"
        " { B }.set{region: {mask: [0.5, 1, 0, 1]}}"
    )
    assert r.text == (
        "[FILL() q\nCOUPLE MASK(0 0.5, 0 1, 1) q, A\nCOUPLE MASK(0.5 1, 0 1, 1) q, B, :0,0.4] "
        "[FILL() q, C\nCOUPLE MASK(0.5 1, 0 1, 1) q, C, B, :0.4,1]"
    )
    assert not any(d.code == W05 for d in r.diagnostics)  # a slice is not an empty window


def test_region_window_turns_the_block_into_plain_text_outside_it():
    src = ("m, 2girls, [@region]: { [mask: [0, 0.5, 0, 1]]: { stelle }, [mask: [0.5, 1, 0, 1]]: { kafka } }"
           ".set{schedule: {0, 0.8}, region_window: {0, 0.4}}")
    split = "COUPLE MASK(0 0.5, 0 1, 1) m, 2girls, stelle\nCOUPLE MASK(0.5 1, 0 1, 1) m, 2girls, kafka"
    assert compile_text(src).text == (
        f"[FILL() m, 2girls\n{split}, :0,0.4] [m, 2girls, stelle, kafka, :0.4,0.8] [m, 2girls, :0.8,1]"
    )


def test_region_window_does_not_duplicate_include_in_base_content():
    src = ("q, [@region]: { [base]: { g }, [imask: 0, include_in_base: true]: { a }, [imask: 1]: { b } }"
           ".set{region_window: {0, 0.4}}")
    assert compile_text(src).text.endswith("[q, g, a, b, :0.4,1]")


def test_region_window_keeps_one_random_draw_across_slices():
    src = ("q, [@region]: { [imask: 0]: { {x, y, z, w}.set{random_select: 1} }, [imask: 1]: { b } }"
           ".set{region_window: {0, 0.4}}")
    for seed in range(8):
        text = compile_text(src, seed=seed).text
        picked = [t for t in "xyzw" if f"q, {t}\n" in text]
        assert len(picked) == 1 and f"q, {picked[0]}, b, :0.4,1]" in text


def test_region_window_only_applies_to_a_region_block():
    r = compile_text("q, { a }.set{region_window: {0, 0.4}}")
    assert r.text == "q, a"
    assert any(d.code == "W08" for d in r.diagnostics)


# --- §3.3 group settings ----------------------------------------------------


def test_group_weight_wraps_the_whole_group():
    assert compile_text("{a, b}.set{weight: 1.5}").text == "(a, b:1.5)"


def test_weight_of_one_is_a_no_op():
    assert compile_text("{a, b}.set{weight: 1.0}").text == "a, b"


def test_format_applies_to_each_item_with_a_subgroup_counting_as_one():
    r = compile_text('{a, {b, c}}.set{format: "masterpiece $p"}')
    assert r.text == "masterpiece a, masterpiece b, c"


def test_format_stays_inside_an_items_weight_wrapper():
    assert compile_text('{(tag:0.8)}.set{format: "@$p"}').text == "(@tag:0.8)"


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
        "{base}.set{region: base} {a, b, c, d, e, f}.set{region: {imask: 0, include_in_base: true}, "
        "random_select: 3}"
    )
    r = compile_text(src, seed=5)
    got = {s.key: s.text for s in r.segments}
    assert got[("base",)] == "base, " + got[("imask", 0)]


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
