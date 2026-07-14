# T51 — PLv3 node classes (spec §7): IS_CHANGED, region_mode, negative polarity
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from prompt_library_v3.diagnostics import PLv3Error
from prompt_library_v3.node import (
    PromptLibraryV3NegativeNode,
    PromptLibraryV3PositiveNode,
)


def test_positive_node_inputs():
    spec = PromptLibraryV3PositiveNode.INPUT_TYPES()["required"]
    assert set(spec) == {"text", "seed", "region_mode"}
    assert spec["region_mode"][0] == ["couple", "mask"]
    assert spec["seed"][1]["control_after_generate"] is True


def test_negative_node_has_no_region_mode():
    spec = PromptLibraryV3NegativeNode.INPUT_TYPES()["required"]
    assert set(spec) == {"text", "seed"}


def test_output_is_a_single_string():
    assert PromptLibraryV3PositiveNode.RETURN_TYPES == ("STRING",)
    out = PromptLibraryV3PositiveNode().execute(text="1girl, {a, b}.set{weight: 1.2}")
    assert out == ("1girl, (a, b:1.2)",)


def test_is_changed_tracks_text_seed_and_region_mode():
    n = PromptLibraryV3PositiveNode
    base = n.IS_CHANGED(text="a", seed=0, region_mode="couple")
    assert base == n.IS_CHANGED(text="a", seed=0, region_mode="couple")
    assert base != n.IS_CHANGED(text="b", seed=0, region_mode="couple")
    assert base != n.IS_CHANGED(text="a", seed=1, region_mode="couple")
    assert base != n.IS_CHANGED(text="a", seed=0, region_mode="mask")


def test_positive_and_negative_differ_in_is_changed():
    assert PromptLibraryV3PositiveNode.IS_CHANGED(
        text="a"
    ) != PromptLibraryV3NegativeNode.IS_CHANGED(text="a")


def test_region_mode_switches_the_backend():
    src = "q, {x}.set{region: {imask: 0}}"
    couple = PromptLibraryV3PositiveNode().execute(text=src, region_mode="couple")[0]
    masked = PromptLibraryV3PositiveNode().execute(text=src, region_mode="mask")[0]
    assert couple.startswith("q\nCOUPLE ")
    assert masked.startswith("q\nAND ")


def test_negative_node_drops_regions():
    out = PromptLibraryV3NegativeNode().execute(
        text="worst quality, {blurry}.set{region: {imask: 0}}"
    )[0]
    assert out == "worst quality, blurry"


def test_a_compile_error_propagates_and_stops_execution():
    with pytest.raises(PLv3Error):
        PromptLibraryV3PositiveNode().execute(text="{unclosed")


def test_empty_text_is_not_an_error():
    assert PromptLibraryV3PositiveNode().execute(text="")[0] == ""
