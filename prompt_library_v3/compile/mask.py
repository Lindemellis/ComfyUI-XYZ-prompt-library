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
"""
from __future__ import annotations

from ..diagnostics import W12, Diagnostics
from ..ir import Segment
from .common import cond_suffix, feather_expr, full_mask, region_expr


def render(segments: list[Segment], diags: Diagnostics) -> str:
    masked = [s for s in segments if s.kind in ("mask", "imask")]
    chunks: list[str] = []

    for seg in segments:
        if not seg.text:
            continue

        if seg.kind == "base":
            # Full image.  A mask weight only competes when other regions exist.
            expr = full_mask(seg.mask_weight) if seg.mask_weight != 1.0 and masked else ""
        elif seg.kind == "fill":
            diags.warn(W12)
            pieces = [full_mask()]  # fill has no mask weight
            pieces += [region_expr(other, op="subtract") for other in masked]
            expr = " ".join(pieces)
        else:
            expr = region_expr(seg)

        feather = feather_expr(seg)
        prefix = " ".join(x for x in (expr, feather) if x)
        body = f"{prefix} {seg.text}" if prefix else seg.text
        chunks.append(body + cond_suffix(seg))

    return "\nAND ".join(chunks)
