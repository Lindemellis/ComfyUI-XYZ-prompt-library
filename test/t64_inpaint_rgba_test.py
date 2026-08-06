"""XYZ Inpaint Stitch To RGBA — the inpaint alone, at its place in the original.

The test that matters is the last one: **composite the layer over the original and you
must get Inpaint Stitch's own output back, pixel for pixel.** Everything else here is
about the ways a stitcher can be shaped.

`Stitch`'s maths, reproduced from ComfyUI-Inpaint-CropAndStitch (stitch_magic_im):

    blended = mask * inpainted + (1 - mask) * canvas_crop
    canvas[ctc region] = blended
    out = canvas[cto region]
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from inpaint_nodes.compose import PlacementError, over, place_rgba  # noqa: E402
from inpaint_nodes.nodes import layers_from_stitcher  # noqa: E402


def make_stitcher(canvas_w=200, canvas_h=160, ctc=(40, 30, 64, 48), cto=(10, 8, 180, 140),
                  seed=0, batch=1):
    """A stitcher shaped exactly like the crop node's: every per-image field a list,
    the canvas [1, H, W, C], the blend mask [1, H, W]."""
    rng = np.random.default_rng(seed)
    canvas = rng.random((1, canvas_h, canvas_w, 3), dtype=np.float32)
    # A feathered mask, because a hard one would hide fringing bugs
    yy, xx = np.mgrid[0 : ctc[3], 0 : ctc[2]].astype(np.float32)
    cy, cx = ctc[3] / 2, ctc[2] / 2
    radius = min(ctc[2], ctc[3]) * 0.35
    dist = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2)
    mask = np.clip((radius + 8 - dist) / 8.0, 0.0, 1.0)[None, ...].astype(np.float32)
    return {
        "downscale_algorithm": "bilinear",
        "upscale_algorithm": "bicubic",
        "canvas_image": [canvas] * batch,
        "cropped_mask_for_blend": [mask] * batch,
        "cropped_to_canvas_x": [ctc[0]] * batch,
        "cropped_to_canvas_y": [ctc[1]] * batch,
        "cropped_to_canvas_w": [ctc[2]] * batch,
        "cropped_to_canvas_h": [ctc[3]] * batch,
        "canvas_to_orig_x": [cto[0]] * batch,
        "canvas_to_orig_y": [cto[1]] * batch,
        "canvas_to_orig_w": [cto[2]] * batch,
        "canvas_to_orig_h": [cto[3]] * batch,
    }


def stitch_reference(stitcher, inpainted, index=0):
    """Inpaint Stitch's own maths, for the identity test. No rescale: the fixtures
    hand the inpainted image over already at the region's size."""
    canvas = np.array(stitcher["canvas_image"][index][0], dtype=np.float32)
    mask = np.array(stitcher["cropped_mask_for_blend"][index][0], dtype=np.float32)[..., None]
    x, y = stitcher["cropped_to_canvas_x"][index], stitcher["cropped_to_canvas_y"][index]
    w, h = stitcher["cropped_to_canvas_w"][index], stitcher["cropped_to_canvas_h"][index]
    crop = canvas[y : y + h, x : x + w]
    canvas = canvas.copy()
    canvas[y : y + h, x : x + w] = mask * inpainted[..., :3] + (1.0 - mask) * crop
    ox, oy = stitcher["canvas_to_orig_x"][index], stitcher["canvas_to_orig_y"][index]
    ow, oh = stitcher["canvas_to_orig_w"][index], stitcher["canvas_to_orig_h"][index]
    return canvas[oy : oy + oh, ox : ox + ow]


def original_of(stitcher, index=0):
    canvas = np.array(stitcher["canvas_image"][index][0], dtype=np.float32)
    ox, oy = stitcher["canvas_to_orig_x"][index], stitcher["canvas_to_orig_y"][index]
    ow, oh = stitcher["canvas_to_orig_w"][index], stitcher["canvas_to_orig_h"][index]
    return canvas[oy : oy + oh, ox : ox + ow]


# --- shape and placement ----------------------------------------------------


def test_the_layer_is_the_size_of_the_original_and_has_alpha():
    st = make_stitcher()
    inpainted = np.zeros((1, 48, 64, 3), dtype=np.float32)
    out = layers_from_stitcher(st, inpainted)
    assert out.shape == (1, 140, 180, 4)


def test_everything_outside_the_region_is_transparent():
    st = make_stitcher()
    inpainted = np.ones((1, 48, 64, 3), dtype=np.float32)
    layer = layers_from_stitcher(st, inpainted)[0]
    alpha = layer[..., 3]
    # the region lands at ctc - cto = (40-10, 30-8) = (30, 22), 64x48
    outside = alpha.copy()
    outside[22 : 22 + 48, 30 : 30 + 64] = 0.0
    assert outside.max() == 0.0, "something was drawn outside the inpainted region"
    assert alpha[22 : 22 + 48, 30 : 30 + 64].max() > 0.9, "the region is not opaque anywhere"


def test_the_region_lands_where_the_stitcher_says():
    st = make_stitcher(ctc=(40, 30, 64, 48), cto=(10, 8, 180, 140))
    inpainted = np.ones((1, 48, 64, 3), dtype=np.float32)
    alpha = layers_from_stitcher(st, inpainted)[0][..., 3]
    ys, xs = np.nonzero(alpha > 0.01)
    # both crops are applied: canvas position minus the original's origin
    assert 22 <= ys.min() and ys.max() < 22 + 48
    assert 30 <= xs.min() and xs.max() < 30 + 64


def test_the_rgb_survives_where_alpha_is_zero():
    """Blanking it would put a dark halo on every composite: the blend mask is
    feathered, and `a*rgb + (1-a)*dst` needs the real colour along that edge."""
    st = make_stitcher()
    inpainted = np.full((1, 48, 64, 3), 0.75, dtype=np.float32)
    layer = layers_from_stitcher(st, inpainted)[0]
    region = layer[22 : 22 + 48, 30 : 30 + 64]
    transparent = region[..., 3] < 0.01
    assert transparent.any(), "the fixture's mask should not cover the whole region"
    assert np.allclose(region[..., :3][transparent], 0.75, atol=0.01)


# --- batches ----------------------------------------------------------------


def test_a_batch_gets_one_layer_each():
    st = make_stitcher(batch=3)
    inpainted = np.zeros((3, 48, 64, 3), dtype=np.float32)
    assert layers_from_stitcher(st, inpainted).shape[0] == 3


def test_a_single_image_stitcher_drives_a_whole_batch():
    """The Stitch node allows it (its `override` path), so this must too."""
    st = make_stitcher(batch=1)
    inpainted = np.zeros((4, 48, 64, 3), dtype=np.float32)
    assert layers_from_stitcher(st, inpainted).shape[0] == 4


def test_a_mismatched_batch_is_refused_with_a_sentence():
    st = make_stitcher(batch=2)
    with pytest.raises(ValueError, match="must match"):
        layers_from_stitcher(st, np.zeros((3, 48, 64, 3), dtype=np.float32))


def test_a_stitcher_from_elsewhere_is_refused_with_a_sentence():
    st = make_stitcher()
    del st["cropped_mask_for_blend"]
    with pytest.raises(ValueError, match="missing"):
        layers_from_stitcher(st, np.zeros((1, 48, 64, 3), dtype=np.float32))


# --- rescaling --------------------------------------------------------------


def test_an_inpainted_image_of_another_size_is_rescaled_to_the_region():
    st = make_stitcher(ctc=(40, 30, 64, 48))
    # inpainted at 2x, as an "inpaint at higher resolution" workflow produces
    inpainted = np.ones((1, 96, 128, 3), dtype=np.float32)
    layer = layers_from_stitcher(st, inpainted)[0]
    assert layer.shape == (140, 180, 4)
    assert layer[22 : 22 + 48, 30 : 30 + 64, 3].max() > 0.9


def test_an_rgba_inpainted_image_multiplies_its_alpha_in():
    st = make_stitcher()
    inpainted = np.ones((1, 48, 64, 4), dtype=np.float32)
    inpainted[..., 3] = 0.5
    layer = layers_from_stitcher(st, inpainted)[0]
    assert layer[..., 3].max() <= 0.51


# --- placement edges --------------------------------------------------------


def test_a_region_hanging_off_the_canvas_draws_what_fits():
    image = np.ones((20, 20, 3), dtype=np.float32)
    mask = np.ones((20, 20), dtype=np.float32)
    out = place_rgba(image, mask, 30, 30, (-5, -5, 20, 20), (0, 0, 30, 30))
    assert out.shape == (30, 30, 4)
    assert out[0, 0, 3] == 1.0 and out[15, 15, 3] == 0.0


def test_a_lying_stitcher_is_refused():
    with pytest.raises(PlacementError):
        place_rgba(
            np.zeros((10, 10, 3), np.float32), np.zeros((10, 10), np.float32),
            50, 50, (0, 0, 20, 20), (0, 0, 50, 50),
        )


# --- THE identity -----------------------------------------------------------


def test_the_layer_over_the_original_is_exactly_what_stitch_produces():
    for seed in range(4):
        st = make_stitcher(seed=seed)
        rng = np.random.default_rng(100 + seed)
        inpainted = rng.random((1, 48, 64, 3), dtype=np.float32)

        layer = layers_from_stitcher(st, inpainted)[0]
        composited = over(layer, original_of(st))
        reference = stitch_reference(st, inpainted[0])

        assert composited.shape == reference.shape
        assert np.abs(composited - reference).max() < 1e-5, (
            f"seed {seed}: max diff {np.abs(composited - reference).max()}"
        )
