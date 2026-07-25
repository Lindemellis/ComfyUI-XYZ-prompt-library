"""Shared region-expression rendering for both backends."""
from __future__ import annotations

from ..ir import Segment, num


def region_expr(seg: Segment, op: str | None = None) -> str:
    """`MASK(x1 x2, y1 y2, w)` / `IMASK(i, w)`, with an optional composite op.

    `w` is the segment's **mask weight** (spatial share); the cond weight is a
    separate trailing `:w`, see `cond_suffix`."""
    tail = f", {op}" if op else ""
    if seg.kind == "imask":
        return f"IMASK({seg.imask or 0}, {num(seg.mask_weight)}{tail})"
    if seg.kind == "mask":
        x1, x2, y1, y2 = seg.mask or (0.0, 1.0, 0.0, 1.0)
        return (
            f"MASK({num(x1)} {num(x2)}, {num(y1)} {num(y2)}, "
            f"{num(seg.mask_weight)}{tail})"
        )
    return ""


def full_mask(weight: float = 1.0, op: str | None = None) -> str:
    tail = f", {op}" if op else ""
    return f"MASK(0 1, 0 1, {num(weight)}{tail})"


def feather_expr(seg: Segment) -> str:
    if not seg.feather:
        return ""
    f = seg.feather
    return f"FEATHER({f} {f} {f} {f})"


def cond_suffix(seg: Segment) -> str:
    """Cond strength: a trailing ` :w` on the chunk.  prompt-control reads the
    LAST `:number` of a chunk as the whole cond's strength (see prompts.py
    `weight()`), which is a different knob from the mask weight above.  It lives
    outside the text and is never escaped — it is not part of the prompt."""
    if seg.cond_weight == 1.0:
        return ""
    return f" :{num(seg.cond_weight)}"
