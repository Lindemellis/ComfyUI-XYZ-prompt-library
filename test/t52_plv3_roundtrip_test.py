# T52 — PLv3 output round-trips through comfyui-prompt-control's own parser.
#
# This is the contract that pins our output escaping: everything PLv3 emits must
# come back out of prompt-control as the text the user actually wrote.  Skipped
# when prompt-control is not installed next to us.
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

PC = ROOT.parent / "comfyui-prompt-control"
if not PC.is_dir():  # pragma: no cover
    pytest.skip("comfyui-prompt-control not installed", allow_module_level=True)
if str(PC) not in sys.path:
    sys.path.insert(0, str(PC))

parse_prompt_schedules = pytest.importorskip(
    "prompt_control.parser_parsy"
).parse_prompt_schedules

from prompt_library_v3 import compile_text


def schedule_of(src, **kw):
    """Compile, then hand the result to prompt-control.  PromptSchedule iterates
    as [end_step, {"prompt": ..., "loras": ...}]."""
    return list(parse_prompt_schedules(compile_text(src, **kw).text))


def at(src, step=1.0, **kw):
    """What prompt-control thinks the prompt is at `step`."""
    steps = schedule_of(src, **kw)
    for end, node in steps:
        if step <= end:
            return node["prompt"]
    return steps[-1][1]["prompt"]  # pragma: no cover


def test_colon_survives_as_part_of_the_tag():
    # the whole point: the user writes `(artist:wlop:1.1)` and prompt-control
    # gets a tag "artist:wlop" weighted 1.1
    assert at("(artist:wlop:1.1)").startswith("(artist:wlop:1.1)")


def test_hash_is_not_swallowed_as_a_comment():
    assert "tag #1" in at("tag #1, 1girl")
    assert "1girl" in at("tag #1, 1girl")


def test_escaped_parens_stay_escaped_for_the_weight_parser():
    # `\(` `\)` must reach the encoder still escaped, or they become emphasis
    assert r"smile \(cat\)" in at(r"smile \(cat\)")


def test_escaped_brackets_and_backslash_come_back_literal():
    assert "[x]" in at(r"\[x\]")
    assert "a\\b" in at(r"a\\b")


def test_a_literal_backslash_reaches_the_encoder_as_one_backslash():
    assert "a\\ b" in at(r"a\ b")


def test_schedule_windows_switch_and_leave_no_orphan_comma():
    src = "quality, [@schedule]: { 0 - 0.3: 1girl, 0.3 - 1: { 2girls, yuri, } }"
    early = at(src, step=0.2)
    late = at(src, step=0.9)
    assert "1girl" in early and "2girls" not in early
    assert "2girls" in late and "1girl" not in late
    for prompt in (early, late):
        assert ", ," not in prompt
        assert not prompt.strip().startswith(",")


def test_lora_is_recognised_by_prompt_control():
    _, node = schedule_of("1girl, <lora:foo:0.8>")[-1]
    assert node["loras"] == {"foo": {"weight": 0.8, "weight_clip": 0.8}}
