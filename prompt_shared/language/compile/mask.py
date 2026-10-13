"""PLv3 backend: MASK (latent mask, `AND` segments) — spec §4.5.

Each segment becomes an `AND` chunk carrying its own `MASK()` / `IMASK()`.  The
BASE segment is the whole image; it needs a mask expression only when it carries
a mask weight to compete with the other regions, otherwise it is left implicit.

`region: fill` has no native equivalent here, but it is computable: prompt-control
composites several `MASK()` calls with `MaskComposite`, so "everything the other
regions do not cover" = a full-image mask minus each other region's mask.  The
compiler synthesises that and reports W12 (spec §4.5, W12).  Fill carries no mask
weight (decision) — its full-image piece stays at weight 1.

The cond weight is a trailing ` :w` on every chunk, independent of the mask.

ComfyUI averages the chunks per pixel by their masks; where NO mask is non-zero
the positive prediction is a hard zero, and CFG turns that into
`uncond * (1 - cfg)`.  So the compiler's synthetic fill (no base, no fill written)
is emitted unless the rectangles provably cover the whole image -- even with no
ambient text, as an empty prompt, which is at least a real prediction.
"""
from __future__ import annotations

from ..diagnostics import W12, Diagnostics
from ..ir import Segment
from .common import cond_suffix, feather_expr, full_mask, region_expr


def _covers_image(masked: list[Segment]) -> bool:
    """Do these regions certainly put a non-zero mask on every pixel?

    Only plain fractional rectangles can be checked here; an IMASK, a feather (it
    fades to zero at the edge) or pixel coordinates mean "do not know"."""
    rects = []
    for seg in masked:
        if seg.kind != "mask" or seg.feather or seg.mask_weight <= 0 or seg.mask is None:
            return False
        if not all(0 <= v <= 1 for v in seg.mask):
            return False
        x1, x2, y1, y2 = seg.mask
        rects.append((min(x1, x2), max(x1, x2), min(y1, y2), max(y1, y2)))
    xs = sorted({v for r in rects for v in r[:2]} | {0.0, 1.0})
    ys = sorted({v for r in rects for v in r[2:]} | {0.0, 1.0})
    for xa, xb in zip(xs, xs[1:]):
        for ya, yb in zip(ys, ys[1:]):
            cx, cy = (xa + xb) / 2, (ya + yb) / 2
            if not any(r[0] <= cx <= r[1] and r[2] <= cy <= r[3] for r in rects):
                return False
    return True


def render(segments: list[Segment], diags: Diagnostics) -> str:
    masked = [s for s in segments if s.kind in ("mask", "imask") and s.text]
    chunks: list[str] = []

    for seg in segments:
        if seg.synthetic:
            # Always a real prediction where no region reaches, even an empty one.
            if _covers_image(masked):
                continue
        elif not seg.text:
            continue

        if seg.kind == "base":
            # Full image.  A mask weight only competes when other regions exist.
            expr = full_mask(seg.mask_weight) if seg.mask_weight != 1.0 and masked else ""
        elif seg.kind == "fill":
            if not seg.synthetic:
                diags.warn(W12)
            pieces = [full_mask()]  # fill has no mask weight
            pieces += [region_expr(other, op="subtract") for other in masked]
            expr = " ".join(pieces)
        else:
            expr = region_expr(seg)

        feather = feather_expr(seg)
        prefix = " ".join(x for x in (expr, feather) if x)
        body = f"{prefix} {seg.text}".rstrip() if prefix else seg.text
        chunks.append(body + cond_suffix(seg))

    return "\nAND ".join(chunks)
