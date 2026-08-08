"""A1111 ``parameters`` chunk parsing (gallery.metadata._derive_from_parameters).

Self-contained: builds its PNGs in a tmp dir, no sample images on disk
(unlike the older script-style ``t06_test.py``).
"""

from pathlib import Path

import pytest
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from gallery.metadata import (
    _derive_from_parameters,
    read_comfy_metadata,
    split_sampler_scheduler,
)

KV = (
    "Steps: 8, Sampler: Euler simple, CFG scale: 1.0, "
    "Seed: 595611427178957, Size: 1344x1024, "
    "Model hash: 5394fca4fa, Model: krea2TurboOfficialComfy_krea2TurboNvfp4"
)


def test_empty_negative_does_not_swallow_the_kv_line():
    # krea2 needs no negative prompt, so the webui writes the header with an
    # empty value.  The kv line must still be parsed as the kv line.
    out = _derive_from_parameters("a cat\nNegative prompt: \n" + KV)
    assert out["positive_prompt"] == "a cat"
    assert out["negative_prompt"] == ""
    assert out["seed"] == "595611427178957"
    assert out["cfg"] == "1.0"
    # A1111 packs the scheduler into ``Sampler:``; we split it back out.
    assert out["sampler"] == "Euler"
    assert out["scheduler"] == "simple"
    assert out["model"] == "krea2TurboOfficialComfy_krea2TurboNvfp4"


def test_empty_negative_and_empty_positive():
    out = _derive_from_parameters("\nNegative prompt: \n" + KV)
    assert out["positive_prompt"] == ""
    assert out["negative_prompt"] == ""
    assert out["seed"] == "595611427178957"


def test_normal_negative_still_parses():
    out = _derive_from_parameters(
        "a cat, masterpiece\n"
        "Negative prompt: bad hands, blurry\n"
        "Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1234, Model: foo"
    )
    assert out["positive_prompt"] == "a cat, masterpiece"
    assert out["negative_prompt"] == "bad hands, blurry"
    assert out["seed"] == "1234"
    assert out["model"] == "foo"


def test_multiline_negative_without_kv_line_keeps_its_last_line():
    out = _derive_from_parameters("a cat\nNegative prompt: bad hands,\nlow quality")
    assert out["negative_prompt"] == "bad hands,\nlow quality"
    assert "seed" not in out


def test_no_negative_section():
    out = _derive_from_parameters(
        "a cat\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1, Model: foo"
    )
    assert out["positive_prompt"] == "a cat"
    assert "negative_prompt" not in out
    assert out["seed"] == "1"


def test_end_to_end_empty_negative_png(tmp_path: Path):
    info = PngInfo()
    info.add_text("parameters", "a cat\nNegative prompt: \n" + KV)
    png = tmp_path / "krea2.png"
    Image.new("RGB", (8, 8), "black").save(png, pnginfo=info)

    m = read_comfy_metadata(str(png))
    assert m.errors == ()
    assert m.positive_prompt == "a cat"
    assert m.negative_prompt is None  # "" is normalised away → UI shows "—"
    assert m.seed == 595611427178957
    assert m.cfg == pytest.approx(1.0)
    assert m.sampler == "Euler"
    assert m.scheduler == "simple"
    assert m.model == "krea2TurboOfficialComfy_krea2TurboNvfp4"


# --- the packed ``Sampler:`` field -----------------------------------------
#
# Danbooru-Gallery's SaveImagePlus writes ``Sampler: <sampler> <scheduler>``
# and no ``Scheduler:`` key at all (its own comment says "Sampler（合并
# Scheduler）"), which is A1111's convention.  Everything below is a real
# value observed in this install's library.


@pytest.mark.parametrize(
    "packed,sampler,scheduler",
    [
        ("Euler simple", "Euler", "simple"),
        ("Euler Simple", "Euler", "Simple"),
        ("Euler a Simple", "Euler a", "Simple"),
        ("Euler SGM Uniform", "Euler", "SGM Uniform"),
        ("res_multistep SGM Uniform", "res_multistep", "SGM Uniform"),
        ("er_sde Simple", "er_sde", "Simple"),
        # The sampler's own name carries underscores — the tail match must not
        # take a bite out of it.
        ("dpmpp_2m_sde_gpu simple", "dpmpp_2m_sde_gpu", "simple"),
        ("DPM++ 2M Karras", "DPM++ 2M", "Karras"),
    ],
)
def test_split_sampler_scheduler(packed, sampler, scheduler):
    assert split_sampler_scheduler(packed) == (sampler, scheduler)


@pytest.mark.parametrize(
    "value",
    [
        "euler",            # ComfyUI's own SaveImage: sampler alone
        "Euler a",          # "a" is not a scheduler
        "dpmpp_2m_sde_gpu",
        "simple",           # never eat the whole value — this is a sampler name
        "",
    ],
)
def test_split_leaves_a_bare_sampler_alone(value):
    assert split_sampler_scheduler(value) == (value, None)


def test_explicit_scheduler_key_wins_over_splitting():
    # A writer that emits both must not have its Sampler: field cut up.
    out = _derive_from_parameters(
        "a cat\nSteps: 20, Sampler: Euler a, Scheduler: karras, Seed: 1"
    )
    assert out["sampler"] == "Euler a"
    assert out["scheduler"] == "karras"
