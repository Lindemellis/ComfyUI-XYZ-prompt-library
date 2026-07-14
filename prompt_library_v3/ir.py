"""PLv3 IR — AST -> segment list (spec §4).

A Segment is one `AND` / `COUPLE` chunk: a region plus the finished text for it.
The backends in `compile/` do nothing but render segments into a target syntax,
which is what makes the target swappable (spec §4.1).

The load-bearing rule is §4.2 — **ambient-text injection**:

    A segment's prompt = the ambient text (everything outside any region group)
    + that region group's own content, spliced in text order.

Ambient text is copied into *every* segment.  `include_in_base` only adds a
region group's content to the BASE segment as well.

Implementation: for each segment the whole tree is re-rendered, with region
groups that do not belong to the segment skipped.  Ancestor groups survive the
walk, so their weight / format / schedule / randomisation apply in every segment
they contribute to.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, replace
from random import Random

from .diagnostics import W05, W11, Diagnostics
from .parser import Group, Item, Lora, Node, Region, Text

FULL: tuple[float, float] = (0.0, 1.0)


@dataclass
class Segment:
    kind: str  # base | fill | mask | imask
    key: tuple
    text: str = ""
    mask: tuple[float, float, float, float] | None = None
    imask: int | None = None
    feather: int = 0
    region_weight: float = 1.0
    schedule: tuple[float, float] = FULL


@dataclass
class Part:
    """A rendered chunk.  `terminated` means it already carries its own trailing
    comma inside a schedule bracket — `[1girl, :0,0.2]` — so the joiner must not
    add another one after it (spec §4.4)."""

    text: str
    terminated: bool = False


@dataclass
class RenderCtx:
    seed: int
    diags: Diagnostics
    segment: Segment | None = None
    interval: tuple[float, float] = FULL
    # The interval an ancestor (or the segment wrapper) has *already* wrapped this
    # content in. A group whose own interval equals it must not wrap again, or a
    # [@region] block with a schedule ends up triple-bracketed in the same window.
    wrapped: tuple[float, float] = FULL


# --- numbers ----------------------------------------------------------------


def num(v: float) -> str:
    """1.0 -> '1', 0.2 -> '0.2'."""
    return f"{float(v):g}"


def _intersect(
    a: tuple[float, float], b: tuple[float, float] | None
) -> tuple[float, float] | None:
    if b is None:
        return a
    lo = max(a[0], b[0])
    hi = min(a[1], b[1])
    if lo >= hi:
        return None
    return (lo, hi)


# --- randomisation (spec §4.6) ----------------------------------------------


def _rng(group: Group, ctx: RenderCtx) -> Random:
    if group.settings.seed is not None:
        # An explicit seed locks the group's random source; the node seed and the
        # group's position no longer matter.
        return Random(group.settings.seed)
    path = ".".join(str(i) for i in group.path)
    digest = hashlib.blake2b(f"{ctx.seed}:{path}".encode(), digest_size=8).digest()
    return Random(int.from_bytes(digest, "big"))


def _randomise(parts: list[Part], group: Group, ctx: RenderCtx) -> list[Part]:
    s = group.settings
    if s.dropout <= 0 and s.random_select is None and not s.shuffle:
        return parts
    rng = _rng(group, ctx)

    if s.dropout > 0:
        parts = [p for p in parts if rng.random() >= s.dropout]

    if s.random_select is not None and parts:
        lo, hi = s.random_select
        k = lo if lo == hi else rng.randint(lo, hi)
        k = max(0, min(k, len(parts)))
        keep = sorted(rng.sample(range(len(parts)), k))
        parts = [parts[i] for i in keep]

    if s.shuffle:
        parts = list(parts)
        rng.shuffle(parts)

    return parts


# --- rendering --------------------------------------------------------------


def _join(parts: list[Part]) -> str:
    out: list[str] = []
    for i, p in enumerate(parts):
        if i:
            # A terminated part already carries its comma inside the bracket, so it
            # gets a plain space: a separator there would become a stray comma the
            # moment its time window closes. Whitespace is nothing to the encoder.
            out.append(" " if parts[i - 1].terminated else ", ")
        out.append(p.text)
    return "".join(out)


def _belongs(group: Group, segment: Segment | None) -> bool:
    region = group.settings.region
    if region is None or segment is None:
        return True
    if region.key() == segment.key:
        return True
    return segment.kind == "base" and region.include_in_base


def render(node: Node, ctx: RenderCtx) -> Part | None:
    if isinstance(node, Text):
        text = node.text.strip()
        return Part(text) if text else None

    if isinstance(node, Lora):
        return Part(node.text)

    if isinstance(node, Item):
        chunks: list[str] = []
        for atom in node.atoms:
            if isinstance(atom, Text):
                chunks.append(atom.text)  # keep the spacing *between* atoms
                continue
            part = render(atom, ctx)
            if part is not None:
                chunks.append(part.text)
        text = "".join(chunks).strip()
        return Part(text) if text else None

    if isinstance(node, Group):
        return _render_group(node, ctx)

    return None  # pragma: no cover


def _render_group(group: Group, ctx: RenderCtx) -> Part | None:
    if group.settings.region is not None and not _belongs(group, ctx.segment):
        return None

    interval = _intersect(ctx.interval, group.settings.schedule)
    if interval is None:
        ctx.diags.warn(W05, pos=group.pos)
        return None

    will_wrap = interval != FULL and interval != ctx.wrapped
    inner = replace(
        ctx, interval=interval, wrapped=interval if will_wrap else ctx.wrapped
    )
    parts = [p for p in (render(c, inner) for c in group.children) if p is not None]
    parts = _randomise(parts, group, ctx)

    fmt = group.settings.format
    if fmt:
        parts = [Part(fmt.replace("$p", p.text), p.terminated) for p in parts]

    body = _join(parts)
    if not body.strip():
        return None

    weight = group.settings.weight
    if weight is not None and weight != 1.0:
        body = f"({body}:{num(weight)})"
    elif group.paren and weight is None:
        # Bare parens with no weight: pass the user's parens through as written.
        body = f"({body})"

    terminated = False
    if will_wrap:
        # The comma lives inside the bracket so that a closed time window cannot
        # leave a dangling separator behind (spec §4.4).
        body = f"[{body}, :{num(interval[0])},{num(interval[1])}]"
        terminated = True

    return Part(body, terminated)


# --- segments ---------------------------------------------------------------


def _collect_regions(
    node: Node, interval: tuple[float, float], out: list[tuple[Group, tuple[float, float]]],
    diags: Diagnostics,
) -> None:
    if isinstance(node, Item):
        for atom in node.atoms:
            _collect_regions(atom, interval, out, diags)
        return
    if not isinstance(node, Group):
        return

    here = _intersect(interval, node.settings.schedule)
    if here is None:
        # The group can never be on screen — it produces no segment at all.
        return
    if node.settings.region is not None:
        out.append((node, here))
        return  # region groups cannot nest (E01), no need to walk deeper
    for child in node.children:
        _collect_regions(child, here, out, diags)


def build_segments(root: Group, seed: int, diags: Diagnostics) -> list[Segment]:
    """AST -> segment list.  BASE always exists, even with no region groups."""
    found: list[tuple[Group, tuple[float, float]]] = []
    _collect_regions(root, FULL, found, diags)

    segments: list[Segment] = []
    by_key: dict[tuple, Segment] = {}

    for group, interval in found:
        region: Region = group.settings.region  # type: ignore[assignment]
        key = region.key()
        existing = by_key.get(key)
        if existing is not None:
            # Same mask -> same segment (spec §4.3).  The first group's values win.
            if (
                existing.feather != region.feather
                or existing.region_weight != region.region_weight
                or existing.schedule != _seg_schedule(region.kind, interval)
            ):
                diags.warn(W11, pos=group.pos)
            continue
        seg = Segment(
            kind=region.kind,
            key=key,
            mask=region.mask,
            imask=region.imask,
            feather=region.feather,
            region_weight=region.region_weight,
            schedule=_seg_schedule(region.kind, interval),
        )
        by_key[key] = seg
        segments.append(seg)

    base = by_key.get(("base",))
    if base is None:
        base = Segment(kind="base", key=("base",))
        segments.insert(0, base)
    else:
        segments.remove(base)
        segments.insert(0, base)

    for seg in segments:
        # The segment wrapper below already applies seg.schedule, so the render
        # starts out with that interval marked as wrapped.
        ctx = RenderCtx(
            seed=seed, diags=diags, segment=seg, interval=FULL, wrapped=seg.schedule
        )
        part = render(root, ctx)
        text = part.text if part is not None else ""
        if seg.schedule != FULL and text:
            text = f"[{text}, :{num(seg.schedule[0])},{num(seg.schedule[1])}]"
        seg.text = text

    return segments


def _seg_schedule(kind: str, interval: tuple[float, float]) -> tuple[float, float]:
    """A masked region can blink in and out of existence over time; the BASE
    segment cannot — an empty base prompt outside the window is never what the
    user meant.  So base groups keep their schedule as an ordinary nested wrap
    and the BASE segment itself is never time-limited."""
    return FULL if kind == "base" else interval
