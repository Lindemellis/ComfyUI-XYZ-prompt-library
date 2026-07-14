# T59 — XYZ Mask Editor / XYZ Attach Masks (mask_krita_nodes_design.md, part one)
#
# The mask maths is numpy; only XYZMaskEditor.execute() touches torch, and torch
# lives in ComfyUI's interpreter rather than this one. So everything here is
# tested through build_masks(), which is what execute() wraps.
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from mask_nodes.nodes import (  # noqa: E402
    CANVAS_SIZE,
    MAX_ATTACH_MASKS,
    PC_MASKS_KEY,
    PREVIEW_COLORS,
    XYZAttachMasks,
    XYZMaskEditor,
    _parse_rects,
    _rasterise,
    build_masks,
    build_preview,
)

LEFT = {"id": "a", "x": 0.0, "y": 0.0, "w": 0.5, "h": 1.0, "feather": 0}
RIGHT = {"id": "b", "x": 0.5, "y": 0.0, "w": 0.5, "h": 1.0, "feather": 0}

HALF = CANVAS_SIZE // 2


def _run(rects) -> list[np.ndarray]:
    """What execute() would emit, minus the torch conversion."""
    return build_masks(_parse_rects(json.dumps(rects)))


# --------------------------------------------------------------- parsing


def test_parse_drops_junk_and_degenerate_rects():
    raw = json.dumps(
        [
            LEFT,
            "not a dict",
            {"x": 0.1, "y": 0.1, "w": 0.0, "h": 0.5},  # zero width
            {"x": 0.2, "y": 0.2, "w": 0.3, "h": 0.3},  # bare, but valid
        ]
    )
    out = _parse_rects(raw)
    assert len(out) == 2
    assert out[1] == {"x": 0.2, "y": 0.2, "w": 0.3, "h": 0.3, "feather": 0.0}


def test_parse_survives_broken_json():
    assert _parse_rects("{{{") == []
    assert _parse_rects("") == []
    assert _parse_rects(None) == []


# --------------------------------------------------------------- rasterising


def test_hard_rect_is_binary_and_covers_the_right_half():
    m = _rasterise(RIGHT)
    assert m.shape == (CANVAS_SIZE, CANVAS_SIZE)
    assert set(np.unique(m).tolist()) == {0.0, 1.0}
    assert m[:, :HALF].sum() == 0
    assert m[:, HALF:].mean() == pytest.approx(1.0)


def test_feather_fades_inwards_and_never_grows_the_rect():
    m = _rasterise(dict(LEFT, feather=16))
    # Nothing outside the hard rectangle.
    assert m[:, HALF:].sum() == 0
    # 0 at the edge, 1 once past the feather band.
    row = m[HALF]
    assert row[0] < 0.1
    assert row[8] == pytest.approx(0.5, abs=0.05)
    assert row[20] == pytest.approx(1.0)


def test_feather_wider_than_the_rect_still_saturates():
    # Without the clamp a 200px feather on a 51px-wide rect would leave the
    # whole thing grey.
    m = _rasterise({"x": 0.4, "y": 0.4, "w": 0.1, "h": 0.1, "feather": 200})
    assert m.max() == pytest.approx(1.0)


# --------------------------------------------------------------- the editor node


def test_slot_layout_is_base_fill_then_one_per_rect():
    out = _run([LEFT, RIGHT])
    assert len(out) == 4
    assert all(m.shape == (CANVAS_SIZE, CANVAS_SIZE) for m in out)

    base, fill, left, right = out
    assert base.mean() == pytest.approx(1.0)
    assert left[:, :HALF].mean() == pytest.approx(1.0)
    assert right[:, HALF:].mean() == pytest.approx(1.0)
    # The two rects tile the canvas, so nothing is left over.
    assert fill.sum() == 0


def test_fill_is_the_complement_of_what_is_emitted():
    base, fill, left = _run([LEFT])
    assert np.abs(left + fill - base).max() == pytest.approx(0.0)


def test_fill_complements_the_feathered_edge_not_the_hard_one():
    _, fill, left = _run([dict(LEFT, feather=16)])
    total = left + fill
    # Sums to exactly 1 everywhere, including inside the soft band.
    assert total.min() == pytest.approx(1.0)
    assert total.max() == pytest.approx(1.0)


def test_overlapping_rects_do_not_push_fill_negative():
    a = {"id": "a", "x": 0.0, "y": 0.0, "w": 0.8, "h": 1.0, "feather": 0}
    b = {"id": "b", "x": 0.2, "y": 0.0, "w": 0.8, "h": 1.0, "feather": 0}
    _, fill, _, _ = _run([a, b])
    assert fill.min() >= 0.0
    assert fill.sum() == 0  # the union covers the canvas


def test_no_rects_gives_base_plus_an_all_white_fill():
    out = _run([])
    assert len(out) == 2
    base, fill = out
    assert base.mean() == pytest.approx(1.0)
    assert fill.mean() == pytest.approx(1.0)


def test_is_changed_tracks_the_rect_list():
    a = XYZMaskEditor.IS_CHANGED(rects=json.dumps([LEFT]))
    b = XYZMaskEditor.IS_CHANGED(rects=json.dumps([LEFT]))
    c = XYZMaskEditor.IS_CHANGED(rects=json.dumps([dict(LEFT, feather=4)]))
    assert a == b
    assert a != c


# --------------------------------------------------------------- attach masks


class _FakePatcher:
    def __init__(self, options=None):
        self.model_options = dict(options or {})


class _FakeClip:
    """Mimics ComfyUI's CLIP.clone(): a fresh patcher with a copied options dict."""

    def __init__(self, options=None):
        self.patcher = _FakePatcher(options)

    def clone(self):
        return _FakeClip(self.patcher.model_options)


def test_attach_appends_in_slot_order():
    m1, m2 = object(), object()
    (clip,) = XYZAttachMasks().execute(_FakeClip(), mask_1=m1, mask_3=m2)
    masks = clip.patcher.model_options[PC_MASKS_KEY]
    # A hole in the inputs closes up: mask_3 becomes IMASK(1), not IMASK(2).
    assert masks == [m1, m2]


def test_attach_stacks_onto_an_upstream_node_without_mutating_it():
    upstream = object()
    source = _FakeClip({PC_MASKS_KEY: [upstream]})
    (clip,) = XYZAttachMasks().execute(source, mask_1=object())

    assert len(clip.patcher.model_options[PC_MASKS_KEY]) == 2
    # The source CLIP is still holding only its own mask — no in-place extend.
    assert source.patcher.model_options[PC_MASKS_KEY] == [upstream]


def test_attach_with_nothing_connected_passes_the_clip_through():
    (clip,) = XYZAttachMasks().execute(_FakeClip())
    assert clip.patcher.model_options[PC_MASKS_KEY] == []


def test_attach_declares_exactly_max_optional_slots():
    optional = XYZAttachMasks.INPUT_TYPES()["optional"]
    assert len(optional) == MAX_ATTACH_MASKS
    assert set(optional) == {f"mask_{i}" for i in range(1, MAX_ATTACH_MASKS + 1)}


# --------------------------------------------------------------- the preview


def _preview(rects) -> np.ndarray:
    _, _, *masks = build_masks(_parse_rects(json.dumps(rects)))
    return build_preview(masks)


def _at(image, x, y):
    """The pixel at a fraction of the canvas, as 0-255 ints."""
    px = image[int(y * CANVAS_SIZE), int(x * CANVAS_SIZE)]
    return tuple(int(round(v * 255)) for v in px)


def test_an_empty_canvas_is_white_paper():
    image = _preview([])
    assert image.shape == (CANVAS_SIZE, CANVAS_SIZE, 3)
    assert (image == 1.0).all()


def test_bare_paper_stays_white_around_the_rects():
    assert _at(_preview([LEFT]), 0.75, 0.5) == (255, 255, 255)


def test_each_rect_gets_its_own_colour_from_the_canvas_palette():
    image = _preview([LEFT, RIGHT])
    assert _at(image, 0.25, 0.5) == PREVIEW_COLORS[0]
    assert _at(image, 0.75, 0.5) == PREVIEW_COLORS[1]


def test_the_lower_index_wins_an_overlap():
    # The whole point of the ordering: rect 0 is painted ON TOP of rect 1.
    a = {"id": "a", "x": 0.0, "y": 0.0, "w": 0.6, "h": 1.0, "feather": 0}
    b = {"id": "b", "x": 0.4, "y": 0.0, "w": 0.6, "h": 1.0, "feather": 0}
    image = _preview([a, b])

    assert _at(image, 0.5, 0.5) == PREVIEW_COLORS[0]  # the overlap
    assert _at(image, 0.2, 0.5) == PREVIEW_COLORS[0]  # a alone
    assert _at(image, 0.8, 0.5) == PREVIEW_COLORS[1]  # b alone


def test_a_feathered_edge_fades_towards_the_paper():
    image = _preview([dict(LEFT, feather=24)])
    core = _at(image, 0.25, 0.5)
    edge = _at(image, 0.005, 0.5)

    assert core == PREVIEW_COLORS[0]
    # Not the flat colour, not yet white: a blend.
    assert edge != PREVIEW_COLORS[0]
    assert all(c > 200 for c in edge)


def test_the_palette_wraps_past_its_last_colour():
    rects = [
        {"id": str(i), "x": i * 0.08, "y": 0.0, "w": 0.07, "h": 1.0, "feather": 0}
        for i in range(12)
    ]
    image = _preview(rects)
    # Rect 10 reuses colour 0 — the palette has ten entries.
    assert _at(image, 10 * 0.08 + 0.03, 0.5) == PREVIEW_COLORS[0]


def test_the_slot_layout_is_preview_base_fill_then_the_masks():
    parsed = _parse_rects(json.dumps([LEFT, RIGHT]))
    base, fill, *masks = build_masks(parsed)
    preview = build_preview(masks)

    # What execute() hands back, in order: an IMAGE first, then the MASKs.
    assert preview.shape == (CANVAS_SIZE, CANVAS_SIZE, 3)
    assert base.shape == fill.shape == (CANVAS_SIZE, CANVAS_SIZE)
    assert len(masks) == 2
