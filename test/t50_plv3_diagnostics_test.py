# T50 — PLv3 errors and warnings (spec §6): every code has a defined degradation
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from prompt_library_v3.compile import compile_text
from prompt_library_v3.diagnostics import (
    E01,
    E03,
    W01,
    W02,
    W03,
    W04,
    W05,
    W07,
    W08,
    W10,
    W13,
    W14,
    PLv3Error,
)


def codes(src, **kw):
    return [d.code for d in compile_text(src, **kw).diagnostics]


# --- errors -----------------------------------------------------------------


def test_E01_region_nested_in_region():
    src = "{ {b}.set{region: {imask: 1}} }.set{region: base}"
    with pytest.raises(PLv3Error) as exc:
        compile_text(src)
    assert exc.value.diag.code == E01


def test_E03_broken_set_block():
    with pytest.raises(PLv3Error) as exc:
        compile_text("{a}.set{weight: 1.5")
    assert exc.value.diag.code == E03


def test_errors_abort_rather_than_producing_a_wrong_image():
    with pytest.raises(PLv3Error):
        compile_text("{a, b")


# --- warnings: schedule / region sugar --------------------------------------


def test_W01_schedule_block_with_its_own_schedule():
    src = "[@schedule]: { 0 - 1: a }.set{schedule: {0.2, 0.5}}"
    r = compile_text(src)
    assert W01 in [d.code for d in r.diagnostics]
    assert r.text == "a"  # the [@schedule] intervals win


def test_W02_child_of_schedule_block_declaring_its_own_schedule():
    src = "[@schedule]: { 0 - 0.5: {a}.set{schedule: {0.7, 1}} }"
    r = compile_text(src)
    assert W02 in [d.code for d in r.diagnostics]
    assert r.text == "[a, :0,0.5]"


def test_W03_region_block_with_its_own_region():
    src = "[@region]: { [imask: 0]: { a, } }.set{region: base}"
    assert W03 in codes(src)


def test_W04_child_of_region_block_declaring_its_own_region():
    src = "[@region]: { [imask: 0]: { a, }.set{region: {imask: 9}} }"
    r = compile_text(src)
    assert W04 in [d.code for d in r.diagnostics]
    assert [s.key for s in r.segments] == [("base",), ("imask", 0)]


def test_W05_empty_schedule_intersection_drops_the_item():
    src = "keep, { drop }.set{schedule: {0.5, 0.2}}"
    r = compile_text(src)
    assert W05 in [d.code for d in r.diagnostics]
    assert r.text == "keep"


# --- warnings: .set{} values ------------------------------------------------


def test_W07_unknown_field_is_ignored():
    r = compile_text("{a}.set{bogus: 1, weight: 1.5}")
    assert W07 in [d.code for d in r.diagnostics]
    assert r.text == "(a:1.5)"


def test_W08_bad_value_falls_back_to_the_default():
    r = compile_text("{a}.set{shuffle: maybe}")
    assert W08 in [d.code for d in r.diagnostics]
    assert r.text == "a"


def test_W08_dropout_is_clamped_into_range():
    r = compile_text("{a, b}.set{dropout: 5}")
    assert compile_text("{a, b}.set{dropout: 5}").text == ""
    assert "a" not in r.text


def test_W10_mask_mixing_percent_and_pixel_values():
    r = compile_text("{a}.set{region: {mask: [0, 512, 0.1, 0.3]}}", region_mode="mask")
    assert W10 in [d.code for d in r.diagnostics]
    # passed through as written for prompt-control to interpret
    assert "MASK(0 512, 0.1 0.3, 1)" in r.text


# --- warnings: negative node ------------------------------------------------


def test_W13_region_in_a_negative_node_is_ignored():
    src = "worst quality, {blurry}.set{region: {imask: 0}}"
    r = compile_text(src, polarity="negative")
    assert W13 in [d.code for d in r.diagnostics]
    assert r.text == "worst quality, blurry"  # merged into the single segment
    assert [s.key for s in r.segments] == [("base",)]


def test_positive_node_keeps_the_region():
    r = compile_text("q, {blurry}.set{region: {imask: 0}}", polarity="positive")
    assert len(r.segments) == 2


# --- warnings: recoverable syntax -------------------------------------------


def test_W14_unrecognised_bracket_block_passes_through():
    # a PLv2 habit: [a:b:0.5].  It is not a PLv3 block, so it is handed to
    # prompt-control untouched rather than rejected — this is commit 51a111f's
    # bug class, made harmless by design.
    r = compile_text("1girl, [a:b:0.5], 2girls")
    assert W14 in [d.code for d in r.diagnostics]
    assert r.text == "1girl, [a:b:0.5], 2girls"


def test_a_literal_colon_is_not_a_warning():
    # a colon is only a weight separator as the last `: number` before a `)`;
    # anywhere else it is plain tag text and needs no escaping and no warning
    r = compile_text("(artist:wlop:1.1), note: this is text")
    assert [d.code for d in r.diagnostics] == []
    assert r.text == r"(artist\:wlop:1.1), note\: this is text"


def test_no_diagnostics_for_clean_text():
    assert codes("1girl, {blonde hair, blue eyes}.set{weight: 1.1}") == []
