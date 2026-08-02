"""A1111 ``parameters`` chunk parsing (gallery.metadata._derive_from_parameters).

Self-contained: builds its PNGs in a tmp dir, no sample images on disk
(unlike the older script-style ``t06_test.py``).
"""

from pathlib import Path

import pytest
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from gallery.metadata import _derive_from_parameters, read_comfy_metadata

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
    assert out["sampler"] == "Euler simple"
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
    assert m.sampler == "Euler simple"
    assert m.model == "krea2TurboOfficialComfy_krea2TurboNvfp4"
