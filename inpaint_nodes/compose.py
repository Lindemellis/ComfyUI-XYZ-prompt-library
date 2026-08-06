"""The inpainted region on its own, at its place in the original — pure numpy.

`XYZ Inpaint Stitch To RGBA` decides nothing; it calls `place_rgba` and converts at
the boundary.  Same split as `mask_nodes.build_masks` and `krita geometry.plan_layer`,
and for the same reason: torch lives in ComfyUI's interpreter and pytest lives in the
dev one, so the maths has to be reachable without it.

What this produces, and why it is NOT the Stitch node's output:

    Stitch:  out = mask * inpainted + (1 - mask) * original      (one flat picture)
    this:    rgb = inpainted,  alpha = mask                      (a layer)

Composite the second over the original and you get the first, exactly — which is the
point. It goes into Krita as a layer that sits over the untouched original, so the
inpaint stays undoable, maskable and movable after the fact.

The one subtlety worth stating: **the RGB is kept where alpha is 0.** Blanking it
would look tidier in a pixel inspector and would put a dark halo around the result the
moment anything composited it, because the blend mask is FEATHERED — along its edge
alpha is partial, and `a*rgb + (1-a)*dst` needs the real colour there.
"""
from __future__ import annotations

import numpy as np

__all__ = ["place_rgba", "PlacementError"]


class PlacementError(ValueError):
    """A stitcher whose numbers do not describe the image it came with."""


def place_rgba(
    inpainted: np.ndarray,
    mask: np.ndarray,
    canvas_w: int,
    canvas_h: int,
    ctc: tuple[int, int, int, int],
    cto: tuple[int, int, int, int],
) -> np.ndarray:
    """The inpainted crop, alone, on a transparent image the size of the original.

    `inpainted` is (h, w, 3|4) in 0..1 and `mask` is (h, w) in 0..1 — both already
    rescaled to the canvas region's size, which is the caller's job because the
    resampling filters come from the stitcher and must match the ones Stitch uses.

    `ctc` = (x, y, w, h) puts the region on the canvas; `cto` = (x, y, w, h) cuts the
    canvas back down to the original image.  Both are needed: the canvas is not the
    original — the crop node may have extended it for outpainting — so pasting at one
    and cropping at the other is what carries the position through.

    Returns (cto_h, cto_w, 4), straight (non-premultiplied) alpha.
    """
    ctc_x, ctc_y, ctc_w, ctc_h = (int(v) for v in ctc)
    cto_x, cto_y, cto_w, cto_h = (int(v) for v in cto)
    canvas_w, canvas_h = int(canvas_w), int(canvas_h)

    if inpainted.ndim != 3 or inpainted.shape[2] < 3:
        raise PlacementError(f"expected an (h, w, 3|4) image, got {inpainted.shape}")
    if inpainted.shape[:2] != (ctc_h, ctc_w):
        raise PlacementError(
            f"the image is {inpainted.shape[1]}x{inpainted.shape[0]} but the stitcher "
            f"places a {ctc_w}x{ctc_h} region"
        )
    if mask.shape != (ctc_h, ctc_w):
        raise PlacementError(
            f"the mask is {mask.shape[1]}x{mask.shape[0]}, not {ctc_w}x{ctc_h}"
        )
    if cto_w <= 0 or cto_h <= 0:
        raise PlacementError(f"the original is {cto_w}x{cto_h}")

    canvas = np.zeros((canvas_h, canvas_w, 4), dtype=np.float32)

    # The region can hang off the canvas — clip both sides of the copy together, or a
    # stitcher from an edge-touching mask would raise instead of drawing what fits.
    dst_x0, dst_y0 = max(0, ctc_x), max(0, ctc_y)
    dst_x1, dst_y1 = min(canvas_w, ctc_x + ctc_w), min(canvas_h, ctc_y + ctc_h)
    if dst_x1 > dst_x0 and dst_y1 > dst_y0:
        src_x0, src_y0 = dst_x0 - ctc_x, dst_y0 - ctc_y
        src_x1, src_y1 = src_x0 + (dst_x1 - dst_x0), src_y0 + (dst_y1 - dst_y0)
        canvas[dst_y0:dst_y1, dst_x0:dst_x1, :3] = inpainted[
            src_y0:src_y1, src_x0:src_x1, :3
        ]
        # The inpainted image may itself carry alpha; the blend mask still wins — it is
        # what decides how much of this pixel belongs to the inpaint at all.
        alpha = mask[src_y0:src_y1, src_x0:src_x1]
        if inpainted.shape[2] == 4:
            alpha = alpha * inpainted[src_y0:src_y1, src_x0:src_x1, 3]
        canvas[dst_y0:dst_y1, dst_x0:dst_x1, 3] = alpha

    out = np.zeros((cto_h, cto_w, 4), dtype=np.float32)
    src_x0, src_y0 = max(0, cto_x), max(0, cto_y)
    src_x1, src_y1 = min(canvas_w, cto_x + cto_w), min(canvas_h, cto_y + cto_h)
    if src_x1 > src_x0 and src_y1 > src_y0:
        dst_x0, dst_y0 = src_x0 - cto_x, src_y0 - cto_y
        out[
            dst_y0 : dst_y0 + (src_y1 - src_y0),
            dst_x0 : dst_x0 + (src_x1 - src_x0),
        ] = canvas[src_y0:src_y1, src_x0:src_x1]
    return np.clip(out, 0.0, 1.0)


def over(layer: np.ndarray, background: np.ndarray) -> np.ndarray:
    """Composite straight-alpha `layer` over `background` — the identity this whole
    module exists to satisfy, and the one the tests check against Stitch's own maths."""
    alpha = layer[..., 3:4]
    return np.clip(alpha * layer[..., :3] + (1.0 - alpha) * background[..., :3], 0.0, 1.0)
