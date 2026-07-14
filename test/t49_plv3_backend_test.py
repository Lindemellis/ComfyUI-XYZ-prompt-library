# T49 — PLv3 backends: COUPLE and AND+MASK output (spec §4.5)
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from prompt_library_v3.compile import compile_text
from prompt_library_v3.diagnostics import W12

# The colon in `artist:wlop` is NOT escaped in the source — only the compiled
# output escapes it, for prompt-control's benefit (spec §3.1).
SPEC_EXAMPLE = r"""masterpiece, best quality, (artist:wlop:1.1),

[@region]: {
    base: { 2girls, yuri, side-by-side, }
    [imask: 0, feather: 10, include_in_base: true]: { illya, blonde hair, }
    [imask: 1, feather: 10, include_in_base: true]: { miyu, black hair, }
}"""


def test_spec_example_couple_output():
    # This is the exact expected output printed in spec §4.5.
    got = compile_text(SPEC_EXAMPLE, region_mode="couple").text
    assert got == (
        r"masterpiece, best quality, (artist\:wlop:1.1), 2girls, yuri, side-by-side, "
        "illya, blonde hair, miyu, black hair\n"
        r"COUPLE IMASK(0, 1) FEATHER(10 10 10 10) masterpiece, best quality, "
        r"(artist\:wlop:1.1), illya, blonde hair"
        "\n"
        r"COUPLE IMASK(1, 1) FEATHER(10 10 10 10) masterpiece, best quality, "
        r"(artist\:wlop:1.1), miyu, black hair"
    )


def test_spec_example_mask_output_is_the_same_with_AND():
    couple = compile_text(SPEC_EXAMPLE, region_mode="couple").text
    masked = compile_text(SPEC_EXAMPLE, region_mode="mask").text
    assert masked == couple.replace("\nCOUPLE ", "\nAND ")


def test_no_regions_means_a_single_line():
    assert compile_text("a, b", region_mode="couple").text == "a, b"
    assert compile_text("a, b", region_mode="mask").text == "a, b"


def test_rectangle_mask_expression():
    src = "q, {illya}.set{region: {mask: [0, 0.2, 0.1, 0.3], region_weight: 0.8}}"
    got = compile_text(src, region_mode="mask").text
    assert got == "q\nAND MASK(0 0.2, 0.1 0.3, 0.8) q, illya"


def test_feather_is_emitted_after_the_mask():
    src = "{x}.set{region: {imask: 3, feather: 12}}"
    got = compile_text(src, region_mode="couple").text
    assert got == "COUPLE IMASK(3, 1) FEATHER(12 12 12 12) x"


def test_couple_fill_takes_the_base_slot_and_base_becomes_a_couple_segment():
    src = (
        "[@region]: {\n"
        "  base: { 2girls, }\n"
        "  [imask: 0]: { illya, }\n"
        "  fill: { detailed background, }\n"
        "}"
    )
    got = compile_text(src, region_mode="couple").text
    assert got == (
        "FILL() detailed background\n"
        "COUPLE 2girls\n"
        "COUPLE IMASK(0, 1) illya"
    )


def test_couple_without_fill_puts_base_in_the_base_slot():
    src = "[@region]: { base: { 2girls, } [imask: 0]: { illya, } }"
    got = compile_text(src, region_mode="couple").text
    assert got == "2girls\nCOUPLE IMASK(0, 1) illya"


def test_mask_mode_synthesises_fill_and_warns_W12():
    src = (
        "[@region]: {\n"
        "  base: { 2girls, }\n"
        "  [imask: 0]: { illya, }\n"
        "  [mask: [0, 0.5, 0, 1]]: { miyu, }\n"
        "  fill: { background, }\n"
        "}"
    )
    r = compile_text(src, region_mode="mask")
    assert any(d.code == W12 for d in r.diagnostics)
    # there is no ambient text here — every line lives inside a region group, and
    # the base group's content belongs to the base segment alone
    assert r.text == (
        "2girls\n"
        "AND IMASK(0, 1) illya\n"
        "AND MASK(0 0.5, 0 1, 1) miyu\n"
        "AND MASK(0 1, 0 1, 1) IMASK(0, 1, subtract) "
        "MASK(0 0.5, 0 1, 1, subtract) background"
    )


def test_scheduled_region_survives_into_the_backend():
    src = "q, {illya}.set{region: {imask: 0}, schedule: {0.2, 0.5}}"
    got = compile_text(src, region_mode="couple").text
    assert got == "q\nCOUPLE IMASK(0, 1) [q, illya, :0.2,0.5]"


def test_unknown_region_mode_falls_back_to_couple():
    src = "{x}.set{region: {imask: 0}}"
    assert compile_text(src, region_mode="bogus").text == compile_text(
        src, region_mode="couple"
    ).text
