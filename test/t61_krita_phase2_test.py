# T61 — colour splitting and cache slots (mask_krita_nodes_design.md §11, §13)
#
# The colour maths is pure numpy, so it is tested for real here. Send To Krita is
# not — it needs a live Krita, and was verified against one by hand.
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from cache_nodes import nodes as cache  # noqa: E402
from krita_nodes.nodes import pick_colors, split_colors  # noqa: E402

RED = (220, 40, 40)
BLUE = (40, 80, 220)
GREEN = (40, 200, 60)


def _layer(regions: list[tuple[tuple[int, int, int], int]], height: int = 10):
    """A flat-colour layer: [(colour, width), ...] laid out left to right."""
    width = sum(w for _, w in regions)
    rgb = np.zeros((height, width, 3), dtype=np.uint8)
    alpha = np.full((height, width), 255, dtype=np.uint8)
    x = 0
    for color, w in regions:
        rgb[:, x : x + w] = color
        x += w
    return rgb, alpha


# ------------------------------------------------------------- picking colours


def test_the_largest_regions_win():
    rgb, alpha = _layer([(RED, 50), (BLUE, 30), (GREEN, 5)])
    assert pick_colors(rgb, alpha, 2) == sorted([RED, BLUE])  # green is dropped


def test_slot_order_is_hex_ascending_not_area():
    # BLUE 0x2850dc < GREEN 0x28c83c < RED 0xdc2828, whatever their areas.
    rgb, alpha = _layer([(RED, 50), (BLUE, 30), (GREEN, 20)])
    assert pick_colors(rgb, alpha, 3) == [BLUE, GREEN, RED]


def test_transparent_pixels_are_not_counted():
    rgb, alpha = _layer([(RED, 10), (BLUE, 90)])
    alpha[:, 10:] = 0  # the blue region is fully transparent
    assert pick_colors(rgb, alpha, 2) == [RED]


def test_antialiased_edges_do_not_crowd_out_a_real_region():
    # A soft edge is a smear of near-unique colours. Counted, they would beat a
    # small real region; they must not, because they are not solid.
    rgb, alpha = _layer([(RED, 40), (BLUE, 20), (GREEN, 6)], height=10)
    for i in range(40, 60):  # a fake gradient with a low alpha, as PIL would draw
        rgb[:, i] = (220 - i, 40 + i, 40)
        alpha[:, i] = 100
    picked = pick_colors(rgb, alpha, 2)
    assert RED in picked and GREEN in picked


def test_no_solid_pixels_gives_no_colours():
    rgb, alpha = _layer([(RED, 10)])
    alpha[:] = 0
    assert pick_colors(rgb, alpha, 3) == []


def test_asking_for_more_colours_than_exist_returns_what_exists():
    rgb, alpha = _layer([(RED, 10), (BLUE, 10)])
    assert len(pick_colors(rgb, alpha, 5)) == 2


# ------------------------------------------------------------- splitting them


def test_masks_are_binary_and_cover_their_own_region():
    rgb, alpha = _layer([(RED, 50), (BLUE, 50)])
    colors = pick_colors(rgb, alpha, 2)  # [BLUE, RED] — hex order
    masks = split_colors(rgb, alpha, colors, 0.15)

    assert set(np.unique(masks[0]).tolist()) <= {0.0, 1.0}
    assert masks[0][:, 50:].all()  # blue is the right half
    assert masks[1][:, :50].all()  # red is the left half


def test_masks_never_overlap_and_leave_no_seam():
    # The whole point of "nearest colour within tolerance" (decision 20).
    rgb, alpha = _layer([(RED, 30), (BLUE, 30), (GREEN, 40)])
    colors = pick_colors(rgb, alpha, 3)
    total = sum(split_colors(rgb, alpha, colors, 0.15))
    assert total.max() == 1.0  # no pixel in two masks
    assert total.min() == 1.0  # no solid pixel in none


def test_an_edge_pixel_joins_its_nearest_colour():
    rgb, alpha = _layer([(RED, 50), (BLUE, 50)])
    rgb[:, 99] = (200, 50, 50)  # nearly red, but not exactly
    colors = pick_colors(rgb, alpha, 2)  # [BLUE, RED]
    masks = split_colors(rgb, alpha, colors, 0.15)
    assert masks[1][:, 99].all()  # went to red
    assert not masks[0][:, 99].any()


def test_a_pixel_beyond_tolerance_joins_nothing():
    rgb, alpha = _layer([(RED, 50), (BLUE, 50)])
    rgb[:, 99] = (255, 255, 0)  # yellow: far from both
    colors = pick_colors(rgb, alpha, 2)
    masks = split_colors(rgb, alpha, colors, 0.02)
    assert not masks[0][:, 99].any()
    assert not masks[1][:, 99].any()


def test_tolerance_of_one_swallows_everything():
    rgb, alpha = _layer([(RED, 50), (BLUE, 50)])
    colors = pick_colors(rgb, alpha, 2)
    total = sum(split_colors(rgb, alpha, colors, 1.0))
    assert total.min() == 1.0


def test_transparent_pixels_are_in_no_mask():
    rgb, alpha = _layer([(RED, 50), (BLUE, 50)])
    alpha[:, :10] = 0
    colors = pick_colors(rgb, alpha, 2)
    masks = split_colors(rgb, alpha, colors, 0.5)
    assert not masks[0][:, :10].any()
    assert not masks[1][:, :10].any()


def test_no_colours_gives_no_masks():
    rgb, alpha = _layer([(RED, 10)])
    assert split_colors(rgb, alpha, [], 0.15) == []


# ---------------------------------------------------------------- cache slots


def test_a_slot_name_may_not_escape_the_cache_directory(monkeypatch, tmp_path):
    monkeypatch.setattr(cache, "cache_dir", lambda: tmp_path)
    for bad in ["../escape", "a/b", "a\\b", "", "  ", "x" * 65]:
        with pytest.raises(ValueError):
            cache.slot_path(bad)


def test_a_sane_slot_name_is_accepted(monkeypatch, tmp_path):
    monkeypatch.setattr(cache, "cache_dir", lambda: tmp_path)
    assert cache.slot_path("base-1_v2.a").name == "base-1_v2.a"


def test_list_slots_only_reports_slots_that_hold_an_image(monkeypatch, tmp_path):
    monkeypatch.setattr(cache, "cache_dir", lambda: tmp_path)
    (tmp_path / "full").mkdir()
    (tmp_path / "full" / cache.IMAGE_NAME).write_bytes(b"x")
    (tmp_path / "empty").mkdir()
    assert cache.list_slots() == ["full"]


def test_list_slots_is_empty_before_anything_is_written(monkeypatch, tmp_path):
    monkeypatch.setattr(cache, "cache_dir", lambda: tmp_path / "nothing-here")
    assert cache.list_slots() == []
