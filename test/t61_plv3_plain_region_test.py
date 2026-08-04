# T61 — the node's `plain` output, and the region header shape.
#
# plain  = the same document with the region syntax IGNORED: one prompt, everything
#          in the order it was written, schedules and weights intact.
# header = `[<kind>, <params>]`, the kind ALWAYS first, base and fill as bare words.
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from prompt_library_v3 import compile_text
from prompt_library_v3.node import PromptLibraryV3Node
from prompt_library_v3.parser import parse

REGIONS = """masterpiece,
[@region]: {
    [base, mask_weight: 0.5]: { 2girls }

    [imask: 0, feather: 12]: { red dress }

    [imask: 1]: { blue dress }

    [fill]: { detailed background }
}
best quality"""


# --- plain -------------------------------------------------------------------


def test_plain_is_one_prompt_with_everything_in_order():
    out = compile_text(REGIONS, ignore_regions=True).text
    assert out == (
        "masterpiece, 2girls, red dress, blue dress, detailed background, best quality"
    )


def test_plain_emits_no_region_syntax():
    out = compile_text(REGIONS, ignore_regions=True).text
    for token in ("COUPLE", "AND ", "MASK(", "IMASK(", "FILL(", "FEATHER("):
        assert token not in out, token


def test_plain_is_one_segment():
    result = compile_text(REGIONS, ignore_regions=True)
    assert len(result.segments) == 1
    assert result.segments[0].kind == "base"


def test_plain_keeps_schedules():
    src = "[@region]: { base: { a }, [imask: 0]: { [@schedule]: { 0 - 0.3: x, 0.3 - 1: y } } }"
    out = compile_text(src, ignore_regions=True).text
    assert "[x, :0,0.3]" in out and "[y, :0.3,1]" in out
    assert "IMASK" not in out


def test_plain_keeps_weights_and_loras():
    src = "[@region]: { base: { (a:1.3) }, [imask: 0]: { <lora:x:0.8> } }"
    out = compile_text(src, ignore_regions=True).text
    assert "(a:1.3)" in out and "<lora:x:0.8>" in out


def test_plain_is_the_same_as_the_normal_output_when_there_are_no_regions():
    src = "masterpiece, (best quality:1.2), [@schedule]: { 0 - 0.5: a, 0.5 - 1: b }"
    assert compile_text(src, ignore_regions=True).text == compile_text(src).text


def test_plain_never_needs_the_region_rules():
    """A region in a NEGATIVE document is W13; plain makes no regions, so it is clean."""
    result = compile_text(REGIONS, polarity="negative", ignore_regions=True)
    assert [d.code for d in result.diagnostics] == []


def test_the_node_returns_both():
    prompt, plain = PromptLibraryV3Node().execute(text=REGIONS)
    assert "COUPLE" in prompt and "IMASK(0, 1)" in prompt
    assert "COUPLE" not in plain and "IMASK" not in plain
    assert plain.startswith("masterpiece, 2girls,")


def test_the_node_declares_two_outputs():
    assert PromptLibraryV3Node.RETURN_TYPES == ("STRING", "STRING")
    assert PromptLibraryV3Node.RETURN_NAMES == ("prompt", "plain")


def test_both_outputs_use_the_same_seed():
    """Two renderings of ONE document — a shuffle must not draw twice."""
    src = "[@region]: { base: { { a, b, c, d }.set{ shuffle: true } } }"
    for seed in (1, 7, 99):
        prompt, plain = PromptLibraryV3Node().execute(text=src, seed=seed)
        assert sorted(prompt.split(", ")) == sorted(plain.split(", "))
        assert prompt == plain  # no region syntax to differ over, so identical


# --- the region header -------------------------------------------------------


def region_of(head):
    root, diags = parse("[@region]: { %s: { a } }" % head)
    return root.children[0].children[0].settings.region, [d.code for d in diags.items]


def test_the_kind_may_be_a_bare_word_in_first_place():
    for kind in ("base", "fill"):
        r, diags = region_of(f"[{kind}]")
        assert r.kind == kind and diags == []


def test_a_bare_kind_survives_the_params_that_follow_it():
    """`[fill, mask_weight: 0.3]` used to parse as a BASE region: the positional entry
    was thrown away as soon as a `key: value` joined it, silently."""
    r, diags = region_of("[fill, mask_weight: 0.3]")
    assert r.kind == "fill" and r.mask_weight == 0.3 and diags == []

    r, _ = region_of("[base, cond_weight: 0.8, include_in_base: true]")
    assert r.kind == "base" and r.cond_weight == 0.8 and r.include_in_base is True


def test_mask_and_imask_keep_carrying_their_value():
    r, _ = region_of("[imask: 2, feather: 4]")
    assert r.kind == "imask" and r.imask == 2 and r.feather == 4
    r, _ = region_of("[mask: [0, 0.5, 0, 1], cond_weight: 0.8]")
    assert r.kind == "mask" and r.mask == (0, 0.5, 0, 1) and r.cond_weight == 0.8


def test_an_explicit_kind_field_still_works():
    r, diags = region_of("[kind: fill, mask_weight: 0.3]")
    assert r.kind == "fill" and r.mask_weight == 0.3 and diags == []


def test_an_unknown_bare_word_warns_instead_of_vanishing():
    r, diags = region_of("[bogus, mask_weight: 0.5]")
    assert r.kind == "base" and r.mask_weight == 0.5
    assert "W08" in diags


def test_the_set_form_takes_a_bare_kind_too():
    root, _ = parse("{ a }.set{ region: { fill, mask_weight: 0.3 } }")
    r = root.children[0].settings.region
    assert r.kind == "fill" and r.mask_weight == 0.3


def test_a_positional_entry_never_leaks_into_set_fields():
    root, diags = parse("{ a }.set{ weight: 1.2, region: { fill } }")
    assert [d.code for d in diags.items] == []
    assert root.children[0].settings.weight == 1.2
    assert root.children[0].settings.region.kind == "fill"
