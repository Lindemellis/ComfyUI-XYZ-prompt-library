"""PLv3 backend: COUPLE (attention couple) — spec §4.5.

prompt-control's "base prompt slot" and our BASE segment are two different
things, and the difference only shows when a `region: fill` group exists:

  * with a FILL segment  — the FILL text takes the base prompt slot and gets
    `FILL()`; our BASE segment degrades into an ordinary COUPLE segment with an
    explicit full-image mask.
  * without one          — the BASE segment takes the base prompt slot (in
    COUPLE mode the base prompt covers the whole image anyway, which is exactly
    the "base is always full-image" rule).

Two weights ride along (spec §4.5):
  * mask weight  — the spatial share.  For a mask/imask it is the `w` inside
    `MASK()`/`IMASK()`; for BASE (which is full-image) it becomes an explicit
    `MASK(0 1, 0 1, w)`, but only when there are regions for it to compete with.
    FILL carries no mask weight — its gap-mask is fixed at 1.
  * cond weight  — a trailing ` :w` on the chunk, applied to every kind.
"""
from __future__ import annotations

from ..diagnostics import Diagnostics
from ..ir import Segment
from .common import cond_suffix, feather_expr, full_mask, region_expr


def render(segments: list[Segment], diags: Diagnostics) -> str:
    base = next((s for s in segments if s.kind == "base"), None)
    fill = next((s for s in segments if s.kind == "fill"), None)
    others = [s for s in segments if s.kind in ("mask", "imask")]
    # BASE's mask weight is a spatial share; it only means something when there is
    # another region (or a fill) on the same image to compete against.
    has_regions = bool(others) or fill is not None

    lines: list[str] = []

    def base_body(seg: Segment) -> str:
        prefix = (
            full_mask(seg.mask_weight)
            if seg.mask_weight != 1.0 and has_regions
            else ""
        )
        body = f"{prefix} {seg.text}" if prefix else seg.text
        return body + cond_suffix(seg)

    if fill is not None and fill.text:
        lines.append(f"FILL() {fill.text}" + cond_suffix(fill))
        if base is not None and base.text:
            lines.append(f"COUPLE {base_body(base)}")
    elif base is not None and base.text:
        lines.append(base_body(base))

    for seg in others:
        if not seg.text:
            continue
        prefix = " ".join(x for x in (region_expr(seg), feather_expr(seg)) if x)
        body = f"COUPLE {prefix} {seg.text}" if prefix else f"COUPLE {seg.text}"
        lines.append(body + cond_suffix(seg))

    return "\n".join(lines)
