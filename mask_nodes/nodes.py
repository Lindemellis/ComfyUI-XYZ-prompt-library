"""XYZ Mask Editor / XYZ Attach Masks.

Rectangles are stored normalised (x, y, w, h in 0..1) in the `rects` widget, so
the canvas size is a rendering detail; the masks are rasterised at CANVAS_SIZE
and ComfyUI rescales them to the latent at encode time (decision 7).

`feather` is a per-rect INWARD fade, in pixels of the 512-canvas: the value is 0
at the rectangle's edge and ramps linearly to 1 over `feather` pixels inwards.
Rectangles therefore never gain area, and two adjacent rectangles never overlap.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

import numpy as np

try:
    from ..node import ByPassTypeTuple
except ImportError:  # imported as a top-level package (the tests put the repo root on sys.path)
    from node import ByPassTypeTuple

CANVAS_SIZE = 512

#: prompt-control's internal key.  The one place in this project that depends on
#: prompt-control's implementation (see nodes_tools.py, PCAddMaskToCLIPMany).
PC_MASKS_KEY = "x-promptcontrol.masks"

MAX_ATTACH_MASKS = 16


# ---------------------------------------------------------------- rasterising


def _parse_rects(raw: Any) -> list[dict]:
    if isinstance(raw, list):
        data = raw
    else:
        try:
            data = json.loads(raw or "[]")
        except (TypeError, ValueError):
            print("[XYZ Mask Editor] could not parse the rectangle list; treating it as empty")
            return []
    if not isinstance(data, list):
        return []

    rects: list[dict] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        try:
            rect = {
                "x": float(item.get("x", 0.0)),
                "y": float(item.get("y", 0.0)),
                "w": float(item.get("w", 0.0)),
                "h": float(item.get("h", 0.0)),
                "feather": max(0.0, float(item.get("feather", 0) or 0)),
            }
        except (TypeError, ValueError):
            continue
        if rect["w"] <= 0 or rect["h"] <= 0:
            continue
        rects.append(rect)
    return rects


def _rasterise(rect: dict, size: int = CANVAS_SIZE) -> np.ndarray:
    """One rectangle -> a (size, size) float mask, feathered inwards."""
    x0 = rect["x"] * size
    y0 = rect["y"] * size
    x1 = (rect["x"] + rect["w"]) * size
    y1 = (rect["y"] + rect["h"]) * size

    # Pixel centres, so a rect that lands exactly on a pixel boundary is crisp.
    xs = np.arange(size, dtype=np.float32) + 0.5
    ys = np.arange(size, dtype=np.float32) + 0.5

    dx = np.minimum(xs - x0, x1 - xs)  # >0 inside horizontally
    dy = np.minimum(ys - y0, y1 - ys)
    dist = np.minimum(dy[:, None], dx[None, :])  # (H, W)

    # A feather wider than half the rect would never reach 1; clamp so the
    # centre still saturates rather than the whole rect going grey. The half
    # pixel is what makes the innermost pixel *centre* land on 1, not just the
    # geometric centre line.
    feather = min(rect["feather"], min(x1 - x0, y1 - y0) / 2.0 - 0.5)
    if feather <= 0:
        return (dist > 0).astype(np.float32)
    return np.clip(dist / feather, 0.0, 1.0).astype(np.float32)


def build_masks(rects: list[dict], size: int = CANVAS_SIZE) -> list[np.ndarray]:
    """The full slot layout: [base, fill, one per rect]."""
    base = np.ones((size, size), dtype=np.float32)
    masks = [_rasterise(r, size) for r in rects]

    # The complement of what we actually emit, not of the hard rectangles — with
    # feathering the two differ, and this one still sums to 1 everywhere.
    union = (
        np.clip(np.sum(masks, axis=0), 0.0, 1.0)
        if masks
        else np.zeros_like(base)
    )
    fill = np.clip(base - union, 0.0, 1.0).astype(np.float32)

    return [base, fill, *masks]


#: The rectangle colours, matching js/xyz_mask_editor.js exactly — the preview has
#: to look like the canvas you drew on, or it is worse than useless.
PREVIEW_COLORS = [
    (0xF3, 0x8B, 0xA8),
    (0x89, 0xB4, 0xFA),
    (0xA6, 0xE3, 0xA1),
    (0xF9, 0xE2, 0xAF),
    (0xCB, 0xA6, 0xF7),
    (0x94, 0xE2, 0xD5),
    (0xFA, 0xB3, 0x87),
    (0x74, 0xC7, 0xEC),
    (0xEB, 0xA0, 0xAC),
    (0xB4, 0xBE, 0xFE),
]


def build_preview(masks: list[np.ndarray], size: int = CANVAS_SIZE) -> np.ndarray:
    """White paper, one colour per rectangle. Returns (H, W, 3) float 0..1.

    **The LOWER index wins an overlap**, so it is painted last: composite from the
    back (the highest index) forwards. Each rectangle is blended by its own mask
    value, so a feathered edge fades out exactly as the mask does.
    """
    canvas = np.ones((size, size, 3), dtype=np.float32)

    for i in range(len(masks) - 1, -1, -1):
        color = np.asarray(
            PREVIEW_COLORS[i % len(PREVIEW_COLORS)], dtype=np.float32
        ) / 255.0
        alpha = masks[i][:, :, None]
        canvas = canvas * (1.0 - alpha) + color * alpha

    return canvas.astype(np.float32)


# ------------------------------------------------------------------ the nodes


class XYZMaskEditor:
    NAME = "XYZ Mask Editor"
    CATEGORY = "XYZNodes/Mask"
    DESCRIPTION = (
        "Draw rectangle masks on a 512x512 canvas.\n"
        "Outputs: preview (an IMAGE of the layout, in the canvas's own colours), "
        "base (full white), fill (the complement of every rectangle), then one "
        "MASK per rectangle.\n"
        "Do NOT wire preview/base/fill into 'XYZ Attach Masks' — it would shift "
        "every IMASK index."
    )
    FUNCTION = "execute"
    # ByPassTypeTuple clamps every index to 0, so the whole node advertises one
    # output. That is fine for the MASK slots as well: TautologyStr never compares
    # unequal, so any slot validates against any input type, and the frontend adds
    # the real slots with their real types.
    RETURN_TYPES = ByPassTypeTuple(("IMAGE",))
    RETURN_NAMES = ByPassTypeTuple(("preview",))

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # Hidden by js/xyz_mask_editor.js; the canvas is the real UI.
                "rects": ("STRING", {"default": "[]", "multiline": False}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, rects: str = "[]", **_):
        return hashlib.sha256(str(rects).encode("utf-8")).hexdigest()

    def execute(self, rects: str = "[]", **_):
        # torch only at the boundary: the mask maths is numpy so the tests can
        # run outside ComfyUI's interpreter.
        import torch

        base, fill, *masks = build_masks(_parse_rects(rects))
        preview = build_preview(masks)

        return (
            torch.from_numpy(preview).unsqueeze(0),  # (1, H, W, 3) — an IMAGE
            torch.from_numpy(base).unsqueeze(0),
            torch.from_numpy(fill).unsqueeze(0),
            *(torch.from_numpy(m).unsqueeze(0) for m in masks),
        )


class XYZAttachMasks:
    NAME = "XYZ Attach Masks"
    CATEGORY = "XYZNodes/Mask"
    DESCRIPTION = (
        "Attaches any number of masks to a CLIP for comfyui-prompt-control's "
        "IMASK(i) / PLv3's `imask: i`.\n"
        "The index is the ATTACH ORDER, counting from 0 — not the Mask Editor's "
        "output slot number."
    )
    FUNCTION = "execute"
    RETURN_TYPES = ("CLIP",)
    RETURN_NAMES = ("clip",)

    @classmethod
    def INPUT_TYPES(cls):
        optional = {
            f"mask_{i}": ("MASK", {}) for i in range(1, MAX_ATTACH_MASKS + 1)
        }
        return {
            "required": {"clip": ("CLIP",)},
            "optional": optional,
        }

    def execute(self, clip, **kwargs):
        incoming = []
        for i in range(1, MAX_ATTACH_MASKS + 1):
            mask = kwargs.get(f"mask_{i}")
            if mask is not None:
                incoming.append((f"mask_{i}", mask))

        clip = clip.clone()
        options = clip.patcher.model_options
        # Copy rather than extend in place: `.get()` would hand us the list the
        # upstream CLIP is still holding.
        masks = list(options.get(PC_MASKS_KEY, []))
        base_index = len(masks)
        masks.extend(m for _, m in incoming)
        options[PC_MASKS_KEY] = masks

        if incoming:
            print("[XYZ Attach Masks] IMASK index -> input:")
            for offset, (slot, mask) in enumerate(incoming):
                shape = tuple(getattr(mask, "shape", ()))
                print(f"    IMASK({base_index + offset})  <-  {slot}  {shape}")
        else:
            print("[XYZ Attach Masks] no masks connected; the CLIP passes through unchanged")

        return (clip,)
