"""Send To Krita — the three `fit` modes (user decision 2026-08-05).

`geometry.plan_layer` is pure integers on purpose: `ops.add_layer` cannot be imported
outside Krita (`from krita import Krita` at module scope), and this maths is where the
mistakes live.  Same split as the mask nodes' `build_masks`.

Two rules hold in every mode, and each has a test of its own at the bottom:

    the canvas only ever GROWS — nothing here may crop a document
    whatever does not fill the canvas is CENTRED
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "krita_plugin" / "xyz_comfy"))

import geometry  # noqa: E402


def plan(iw, ih, cw, ch, fit):
    return geometry.plan_layer(iw, ih, cw, ch, fit)


# --- keep -------------------------------------------------------------------


def test_keep_leaves_a_smaller_image_alone_and_centres_it():
    p = plan(512, 512, 1024, 1024, "keep")
    assert p["image_size"] == (512, 512)
    assert p["offset"] == (256, 256)
    assert p["canvas_size"] == (1024, 1024)
    assert p["doc_scale"] is None and p["canvas_resize"] is None


def test_keep_lets_a_bigger_image_overhang_the_canvas():
    p = plan(1024, 1024, 512, 512, "keep")
    assert p["image_size"] == (1024, 1024)
    # centred means it hangs off every side — a paint layer may hold pixels there
    assert p["offset"] == (-256, -256)
    assert p["canvas_size"] == (512, 512)


def test_keep_never_touches_the_document():
    for size in [(64, 64), (4096, 900), (1000, 1000)]:
        p = plan(size[0], size[1], 1000, 1000, "keep")
        assert p["doc_scale"] is None
        assert p["canvas_resize"] is None
        assert p["image_size"] == size


# --- fit --------------------------------------------------------------------


def test_fit_keeps_the_aspect_ratio_scaling_up():
    p = plan(512, 384, 1024, 1024, "fit")
    # one factor for both axes: 2.0, limited by the width
    assert p["image_size"] == (1024, 768)
    assert p["offset"] == (0, 128)  # letterboxed, centred
    assert p["canvas_size"] == (1024, 1024)


def test_fit_keeps_the_aspect_ratio_scaling_down():
    p = plan(1024, 768, 512, 512, "fit")
    assert p["image_size"] == (512, 384)
    assert p["offset"] == (0, 64)


def test_fit_never_deforms():
    # the old behaviour stretched to the canvas with IgnoreAspectRatio; this is the
    # regression test for that
    for iw, ih, cw, ch in [(1024, 768, 512, 512), (300, 900, 1000, 1000), (16, 9, 100, 100)]:
        w, h = plan(iw, ih, cw, ch, "fit")["image_size"]
        assert abs(w / h - iw / ih) < 0.02, (iw, ih, w, h)


def test_fit_does_not_touch_the_canvas():
    p = plan(4096, 4096, 512, 512, "fit")
    assert p["canvas_size"] == (512, 512)
    assert p["doc_scale"] is None and p["canvas_resize"] is None


# --- grow_canvas ------------------------------------------------------------


def test_grow_canvas_scales_the_document_by_one_factor():
    # the worked example: 512x512 canvas, 1024x768 image
    p = plan(1024, 768, 512, 512, "grow_canvas")
    assert p["canvas_size"] == (1024, 768)
    # min(1024/512, 768/512) = 1.5 -> the old content fits WHOLE inside the new canvas
    assert p["doc_scale"] == (768, 768)
    # ...and is centred in it: the new canvas's top-left sits 128px left of the old
    assert p["canvas_resize"] == (-128, 0, 1024, 768)
    # the image itself goes in untouched, filling the canvas exactly
    assert p["image_size"] == (1024, 768)
    assert p["offset"] == (0, 0)


def test_grow_canvas_does_not_deform_the_existing_content():
    for iw, ih in [(1024, 768), (2000, 1000), (900, 3000)]:
        p = plan(iw, ih, 512, 512, "grow_canvas")
        if p["doc_scale"] is None:
            continue
        w, h = p["doc_scale"]
        assert abs(w / h - 1.0) < 0.01, (iw, ih, w, h)  # a square stays square


def test_grow_canvas_falls_back_to_keep_when_the_image_is_not_bigger():
    p = plan(256, 256, 1024, 1024, "grow_canvas")
    assert p["doc_scale"] is None
    assert p["canvas_resize"] is None
    assert p["image_size"] == (256, 256)
    assert p["offset"] == (384, 384)
    assert p["canvas_size"] == (1024, 1024)


def test_grow_canvas_matches_the_image_exactly_when_it_is_bigger_both_ways():
    p = plan(2048, 2048, 512, 512, "grow_canvas")
    assert p["canvas_size"] == (2048, 2048)
    assert p["doc_scale"] == (2048, 2048)
    assert p["canvas_resize"] is None  # already the right size, nothing to reframe
    assert p["offset"] == (0, 0)


def test_grow_canvas_never_crops_a_canvas_that_is_taller_than_the_image():
    # 1024 wide beats the canvas, but the canvas is 2000 tall: taking the image's
    # size outright would cut 1232px off the user's document.
    p = plan(1024, 768, 512, 2000, "grow_canvas")
    assert p["canvas_size"] == (1024, 2000)


# --- the two invariants -----------------------------------------------------


CASES = [
    (iw, ih, cw, ch, fit)
    for iw, ih in [(64, 64), (512, 384), (1024, 1024), (2048, 1152), (300, 4000)]
    for cw, ch in [(512, 512), (1024, 768), (1000, 3000)]
    for fit in geometry.FIT_MODES
]


def test_the_canvas_only_ever_grows():
    for iw, ih, cw, ch, fit in CASES:
        w, h = plan(iw, ih, cw, ch, fit)["canvas_size"]
        assert w >= cw and h >= ch, (iw, ih, cw, ch, fit, w, h)


def test_everything_is_centred():
    for iw, ih, cw, ch, fit in CASES:
        p = plan(iw, ih, cw, ch, fit)
        cw2, ch2 = p["canvas_size"]
        w, h = p["image_size"]
        x, y = p["offset"]
        # equal margins either side, to within the odd pixel integer division drops
        assert abs((cw2 - w - x) - x) <= 1, (iw, ih, cw, ch, fit)
        assert abs((ch2 - h - y) - y) <= 1, (iw, ih, cw, ch, fit)


def test_an_unknown_mode_falls_back_to_the_default():
    assert plan(100, 100, 200, 200, "nonsense") == plan(100, 100, 200, 200, geometry.DEFAULT_FIT)


def test_the_node_offers_exactly_the_modes_the_plugin_knows():
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from krita_nodes import nodes

    assert list(nodes.FIT_MODES) == list(geometry.FIT_MODES)
