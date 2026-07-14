"""PLv3 backend: COUPLE (attention couple) — spec §4.5.

prompt-control's "base prompt slot" and our BASE segment are two different
things, and the difference only shows when a `region: fill` group exists:

  * with a FILL segment  — the FILL text takes the base prompt slot and gets
    `FILL()`; our BASE segment degrades into an ordinary COUPLE segment with an
    implicit full-image mask.
  * without one          — the BASE segment takes the base prompt slot (in
    COUPLE mode the base prompt covers the whole image anyway, which is exactly
    the "base is always full-image" rule).
"""
from __future__ import annotations

from ..diagnostics import Diagnostics
from ..ir import Segment
from .common import feather_expr, region_expr


def render(segments: list[Segment], diags: Diagnostics) -> str:
    base = next((s for s in segments if s.kind == "base"), None)
    fill = next((s for s in segments if s.kind == "fill"), None)
    others = [s for s in segments if s.kind in ("mask", "imask")]

    lines: list[str] = []

    if fill is not None and fill.text:
        lines.append(f"FILL() {fill.text}")
        if base is not None and base.text:
            lines.append(f"COUPLE {base.text}")
    elif base is not None and base.text:
        lines.append(base.text)

    for seg in others:
        if not seg.text:
            continue
        prefix = " ".join(x for x in (region_expr(seg), feather_expr(seg)) if x)
        lines.append(f"COUPLE {prefix} {seg.text}" if prefix else f"COUPLE {seg.text}")

    return "\n".join(lines)
