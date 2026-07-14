"""PLv3 backend: MASK (latent mask, `AND` segments) — spec §4.5.

Each segment becomes an `AND` chunk carrying its own `MASK()` / `IMASK()`.  The
BASE segment is the whole image, so it needs no mask expression at all.

`region: fill` has no native equivalent here, but it is computable: prompt-control
composites several `MASK()` calls with `MaskComposite`, so "everything the other
regions do not cover" = a full-image mask minus each other region's mask.  The
compiler synthesises that and reports W12 (spec §4.5, W12).
"""
from __future__ import annotations

from ..diagnostics import W12, Diagnostics
from ..ir import Segment
from .common import feather_expr, full_mask, region_expr


def render(segments: list[Segment], diags: Diagnostics) -> str:
    masked = [s for s in segments if s.kind in ("mask", "imask")]
    chunks: list[str] = []

    for seg in segments:
        if not seg.text:
            continue

        if seg.kind == "base":
            expr = ""  # implicit full image
        elif seg.kind == "fill":
            diags.warn(W12)
            pieces = [full_mask(seg.region_weight)]
            pieces += [region_expr(other, op="subtract") for other in masked]
            expr = " ".join(pieces)
        else:
            expr = region_expr(seg)

        feather = feather_expr(seg)
        prefix = " ".join(x for x in (expr, feather) if x)
        chunks.append(f"{prefix} {seg.text}" if prefix else seg.text)

    return "\nAND ".join(chunks)
