# T51 — PLv3 node classes (spec §7): IS_CHANGED, region_mode, the two editor variants.
#
# There is no positive/negative split any more: `Prompt Library V3` and
# `Prompt Library V3 (Monaco)` differ only in their editor (a frontend concern) and
# compile identically. Regions are always kept — a region simply must not be wired to a
# negative conditioning (documented, not enforced). The pure compiler still honours a
# `polarity` argument; that is exercised in the compile/validate tests, not here.
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from prompt_library_v3.diagnostics import PLv3Error
from prompt_library_v3.node import (
    PromptLibraryV3MonacoNode,
    PromptLibraryV3Node,
)

BOTH = [PromptLibraryV3Node, PromptLibraryV3MonacoNode]


@pytest.mark.parametrize("cls", BOTH)
def test_node_inputs(cls):
    spec = cls.INPUT_TYPES()["required"]
    assert set(spec) == {"text", "seed", "region_mode"}
    assert spec["region_mode"][0] == ["couple", "mask"]
    assert spec["seed"][1]["control_after_generate"] is True


def test_output_is_a_single_string():
    assert PromptLibraryV3Node.RETURN_TYPES == ("STRING",)
    out = PromptLibraryV3Node().execute(text="1girl, {a, b}.set{weight: 1.2}")
    assert out == ("1girl, (a, b:1.2)",)


def test_the_two_variants_compile_identically():
    src = "1girl, {a, b}.set{weight: 1.2}"
    assert (
        PromptLibraryV3Node().execute(text=src)
        == PromptLibraryV3MonacoNode().execute(text=src)
    )


def test_is_changed_tracks_text_seed_and_region_mode():
    n = PromptLibraryV3Node
    base = n.IS_CHANGED(text="a", seed=0, region_mode="couple")
    assert base == n.IS_CHANGED(text="a", seed=0, region_mode="couple")
    assert base != n.IS_CHANGED(text="b", seed=0, region_mode="couple")
    assert base != n.IS_CHANGED(text="a", seed=1, region_mode="couple")
    assert base != n.IS_CHANGED(text="a", seed=0, region_mode="mask")


def test_is_changed_no_longer_depends_on_the_variant():
    # Same document, same key — the editor kind is not part of what the backend renders.
    assert (
        PromptLibraryV3Node.IS_CHANGED(text="a")
        == PromptLibraryV3MonacoNode.IS_CHANGED(text="a")
    )


def test_region_mode_switches_the_backend():
    src = "q, {x}.set{region: {imask: 0}}"
    couple = PromptLibraryV3Node().execute(text=src, region_mode="couple")[0]
    masked = PromptLibraryV3Node().execute(text=src, region_mode="mask")[0]
    # no base group -> no base line; ambient `q` injects into the one region instead
    assert couple == "COUPLE IMASK(0, 1) q, x"
    assert masked == "IMASK(0, 1) q, x"


def test_regions_are_kept_now_that_there_is_no_negative_node():
    # What used to be dropped on the negative side is now compiled like any region.
    out = PromptLibraryV3Node().execute(
        text="q, {blurry}.set{region: {imask: 0}}"
    )[0]
    assert "IMASK" in out and "blurry" in out


def test_a_compile_error_propagates_and_stops_execution():
    with pytest.raises(PLv3Error):
        PromptLibraryV3Node().execute(text="{unclosed")


def test_empty_text_is_not_an_error():
    assert PromptLibraryV3Node().execute(text="")[0] == ""
