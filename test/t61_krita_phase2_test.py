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


# ------------------------------------------------- colour-mask fallback (§11)
#
# When Krita is unavailable, the fallback is now one MASK per output slot —
# fallback_i stands in for output mask_i — rather than a flat image re-split.

from krita_nodes.nodes import XYZKritaFetchColorMasks as CM  # noqa: E402

_ERR = RuntimeError("krita is closed")


def _kw(masks: dict) -> dict:
    """Fallback kwargs: {index: (H, W) array} -> {'fallback_i': array}."""
    return {f"fallback_{i}": m for i, m in masks.items()}


def test_fallback_masks_stand_in_slot_for_slot():
    a = np.full((8, 6), 0.5, dtype=np.float32)
    b = np.ones((8, 6), dtype=np.float32)
    masks, h, w = CM._fallback_masks(2, _kw({0: a, 1: b}), _ERR)
    assert (h, w) == (8, 6)
    assert np.allclose(masks[0], a) and np.allclose(masks[1], b)


def test_a_gap_among_connected_fallbacks_is_an_empty_mask():
    a = np.ones((4, 4), dtype=np.float32)
    # count=3, only slot 0 and 2 connected; slot 1 comes back empty, same size.
    masks, h, w = CM._fallback_masks(3, _kw({0: a, 2: a}), _ERR)
    assert len(masks) == 3
    assert masks[0].any() and masks[2].any()
    assert not masks[1].any() and masks[1].shape == (4, 4)


def test_more_slots_than_connected_pads_the_tail_empty():
    a = np.ones((5, 5), dtype=np.float32)
    masks, _, _ = CM._fallback_masks(4, _kw({0: a}), _ERR)
    assert len(masks) == 4
    assert masks[0].any()
    assert all(not m.any() for m in masks[1:])


def test_no_fallback_connected_re_raises_rather_than_hiding_it():
    # The whole point: a closed Krita with nothing wired in must SURFACE, not
    # silently render a set of empty masks.
    with pytest.raises(RuntimeError, match="krita is closed"):
        CM._fallback_masks(3, {}, _ERR)
    with pytest.raises(RuntimeError):
        CM._fallback_masks(3, _kw({0: None, 1: None}), _ERR)


def test_a_batched_mask_uses_its_first_item():
    batch = np.stack([np.ones((3, 3), dtype=np.float32), np.zeros((3, 3), dtype=np.float32)])
    masks, h, w = CM._fallback_masks(1, _kw({0: batch}), _ERR)
    assert (h, w) == (3, 3)
    assert masks[0].all()


def test_fallback_values_are_clamped_to_unit_range():
    wild = np.array([[-1.0, 2.0], [0.5, 0.5]], dtype=np.float32)
    masks, _, _ = CM._fallback_masks(1, _kw({0: wild}), _ERR)
    assert masks[0].min() >= 0.0 and masks[0].max() <= 1.0


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


# --------------------------------------------------- slots: empty vs with image


def test_write_sees_empty_slots_but_read_does_not(monkeypatch, tmp_path):
    # Create makes a slot before anything is in it: Write must be able to target
    # it, and Read must not offer a slot it cannot read.
    monkeypatch.setattr(cache, "cache_dir", lambda: tmp_path)
    (tmp_path / "full").mkdir()
    (tmp_path / "full" / cache.IMAGE_NAME).write_bytes(b"x")
    (tmp_path / "fresh").mkdir()

    assert cache.list_slot_names() == ["fresh", "full"]
    assert cache.list_slots() == ["full"]


def test_describe_slots_reports_what_the_browser_needs(monkeypatch, tmp_path):
    from PIL import Image

    monkeypatch.setattr(cache, "cache_dir", lambda: tmp_path)
    (tmp_path / "a").mkdir()
    Image.new("RGB", (7, 11)).save(tmp_path / "a" / cache.IMAGE_NAME)
    (tmp_path / "b").mkdir()

    described = {s["name"]: s for s in cache.describe_slots()}
    assert described["a"]["has_image"] and described["a"]["width"] == 7
    assert described["a"]["height"] == 11 and described["a"]["mtime"] > 0
    assert described["b"]["has_image"] is False


def test_a_corrupt_image_does_not_kill_the_slot_list(monkeypatch, tmp_path):
    monkeypatch.setattr(cache, "cache_dir", lambda: tmp_path)
    (tmp_path / "broken").mkdir()
    (tmp_path / "broken" / cache.IMAGE_NAME).write_bytes(b"not a png")

    described = cache.describe_slots()
    assert described[0]["name"] == "broken"
    assert described[0]["width"] == 0  # unreadable, but the list still comes back


def test_create_and_delete_a_slot(monkeypatch, tmp_path):
    monkeypatch.setattr(cache, "cache_dir", lambda: tmp_path)
    cache.create_slot("upscaled")
    assert (tmp_path / "upscaled").is_dir()
    assert cache.list_slot_names() == ["upscaled"]

    cache.delete_slot("upscaled")
    assert not (tmp_path / "upscaled").exists()


def test_create_refuses_a_name_that_escapes(monkeypatch, tmp_path):
    monkeypatch.setattr(cache, "cache_dir", lambda: tmp_path)
    with pytest.raises(ValueError):
        cache.create_slot("../escape")


# ------------------------------------------------- cache slots: the alpha switch
#
# The bug this pins: `convert("RGB")` DISCARDS alpha, it does not composite. A
# transparent pixel keeps whatever RGB was hiding under it — so a transparent inpaint
# layer, whose transparent areas are black, came out of a slot black AND OPAQUE.
# `alpha: keep` is the way through. `drop` stays the default, as Load Image does it.


def _write_rgba_png(tmp_path, monkeypatch, slot="lay"):
    """A slot holding a half-transparent PNG, written the way write_slot writes one."""
    from PIL import Image

    monkeypatch.setattr(cache, "cache_dir", lambda: tmp_path)
    array = np.zeros((4, 4, 4), dtype=np.uint8)
    array[..., :3] = 0            # black under the transparency, as our layers are
    array[1:3, 1:3] = [10, 200, 30, 255]   # the only opaque part
    directory = tmp_path / slot
    directory.mkdir(parents=True)
    Image.fromarray(array, "RGBA").save(directory / cache.IMAGE_NAME)
    return slot


def test_drop_is_the_default_and_loses_the_alpha(tmp_path, monkeypatch):
    slot = _write_rgba_png(tmp_path, monkeypatch)
    image = cache.load_slot_image(slot, keep_alpha=False)
    assert image.mode == "RGB"
    # ...and this is the symptom, in one assertion: the transparent corner is now a
    # black pixel that will be drawn.
    assert image.getpixel((0, 0)) == (0, 0, 0)


def test_keep_carries_the_transparency_through(tmp_path, monkeypatch):
    slot = _write_rgba_png(tmp_path, monkeypatch)
    image = cache.load_slot_image(slot, keep_alpha=True)
    assert image.mode == "RGBA"
    assert image.getpixel((0, 0))[3] == 0, "the transparent corner came back opaque"
    assert image.getpixel((1, 1)) == (10, 200, 30, 255)


def test_keep_on_a_slot_with_no_alpha_still_gives_four_opaque_channels(tmp_path, monkeypatch):
    """The channel count must not depend on what happens to be in the slot."""
    from PIL import Image

    monkeypatch.setattr(cache, "cache_dir", lambda: tmp_path)
    (tmp_path / "flat").mkdir(parents=True)
    Image.fromarray(np.full((4, 4, 3), 128, np.uint8), "RGB").save(
        tmp_path / "flat" / cache.IMAGE_NAME
    )
    image = cache.load_slot_image("flat", keep_alpha=True)
    assert image.mode == "RGBA"
    assert image.getpixel((0, 0)) == (128, 128, 128, 255)


def test_an_empty_slot_says_so_in_both_modes(tmp_path, monkeypatch):
    monkeypatch.setattr(cache, "cache_dir", lambda: tmp_path)
    (tmp_path / "bare").mkdir(parents=True)
    for keep in (False, True):
        with pytest.raises(RuntimeError, match="is empty"):
            cache.load_slot_image("bare", keep_alpha=keep)


def test_the_node_offers_the_switch_and_defaults_to_drop():
    spec = cache.XYZCacheSlotRead.INPUT_TYPES()["required"]["alpha"]
    assert list(spec[0]) == ["drop", "keep"]
    assert spec[1]["default"] == "drop"
