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
import math
from itertools import product
from dataclasses import dataclass, field, replace
from random import Random

from .diagnostics import E03, W05, W11, Diagnostics, PLv3Error
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
    mask_weight: float = 1.0
    cond_weight: float = 1.0
    schedule: tuple[float, float] = FULL


@dataclass
class Part:
    """A rendered chunk.  `terminated` means it already carries its own trailing
    comma inside a schedule bracket — `[1girl, :0,0.2]` — so the joiner must not
    add another one after it (spec §4.4)."""

    text: str
    terminated: bool = False
    # Text before this part's own wrappers.  An ancestor format must decorate the
    # item inside a child weight: `@$p` + `(tag:0.8)` -> `(@tag:0.8)`.
    format_body: str | None = None
    wrapper: str | None = None  # "weight" or "paren"
    weight: float | None = None
    schedule: tuple[float, float] | None = None
    # V4 only: provenance + effective interval travel with the randomised part.
    loras: list[tuple[int, str, tuple[float, float]]] = field(default_factory=list)
    variants: list[tuple[float, 'Part']] | None = None
    origin: int | None = None

    def with_format(self, fmt: str) -> "Part":
        """Apply an item format while preserving this part's own wrappers."""
        if self.variants is not None:
            return Part('', loras=self.loras, variants=[(w, p.with_format(fmt)) for w, p in self.variants])
        if not self.text:
            return Part('', loras=self.loras)
        if self.format_body is None:
            return Part(fmt.replace("$p", self.text) if self.text else '', self.terminated, loras=self.loras)

        inner_body = fmt.replace("$p", self.format_body)
        body = inner_body
        if self.wrapper == "weight":
            body = f"({body}:{num(self.weight)})"
        elif self.wrapper == "paren":
            body = f"({body})"
        if self.schedule is not None:
            body = f"[{body}, :{num(self.schedule[0])},{num(self.schedule[1])}]"
        return Part(
            body,
            self.terminated,
            format_body=inner_body,
            wrapper=self.wrapper,
            weight=self.weight,
            schedule=self.schedule,
            loras=self.loras,
        )


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
    centralize_loras: bool = False
    lora_block_positions: frozenset[int] = frozenset()
    time_slice: tuple[float, float] | None = None
    random_plan: dict | None = None


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
    key = (id(group), ctx.segment.key if ctx.segment else None)
    if ctx.time_slice is not None and ctx.random_plan is not None:
        current = {p.origin: p for p in parts}
        return [current[origin] for origin in ctx.random_plan.get(key, []) if origin in current]
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

    if ctx.random_plan is not None:
        ctx.random_plan[key] = [p.origin for p in parts]

    return parts


# --- rendering --------------------------------------------------------------


def _ends_sentence(text: str) -> bool:
    """Does this part already end with its own punctuation?

    An item that ends in a full stop was written as prose, and prose does not want a
    comma welded onto it: `a cat., on a mat.` is not what anyone typed. The period is
    the separator there (spec update 2026-08-05), so the joiner adds only a space.
    """
    return text.rstrip().endswith(".")


def _join(parts: list[Part]) -> str:
    parts = [part for part in parts if part.text]
    out: list[str] = []
    for i, p in enumerate(parts):
        if i:
            # A terminated part already carries its comma inside the bracket, so it
            # gets a plain space: a separator there would become a stray comma the
            # moment its time window closes. Whitespace is nothing to the encoder.
            prev = parts[i - 1]
            out.append(" " if (prev.terminated or _ends_sentence(prev.text)) else ", ")
        out.append(p.text)
    return "".join(out)


def _combine(parts: list[Part], joiner=_join) -> Part:
    """Keep each mixture as one randomisation unit until ambient context is joined."""
    loras = list(dict.fromkeys(lora for p in parts for lora in p.loras))
    if not any(p.variants is not None for p in parts):
        return Part(joiner(parts), loras=loras)
    choices = [p.variants if p.variants is not None else [(1.0, p)] for p in parts]
    if math.prod(len(c) for c in choices) > 256:
        raise PLv3Error(E03, 'AVG expansion exceeds 256 alternatives in one region/time interval')
    variants = [(math.prod(w for w, _ in combination), Part(joiner([p for _, p in combination])))
                for combination in product(*choices)]
    return Part('', loras=loras, variants=variants)


def average_text(part: Part | None) -> str:
    """PC folds AVG from the left; cumulative ratios implement an N-way mean."""
    if part is None:
        return ''
    if part.variants is None:
        return part.text
    merged = {}
    for weight, variant in part.variants:
        if weight > 0:
            merged[variant.text] = merged.get(variant.text, 0.0) + weight
    if not merged or not any(merged):
        return ''
    items = iter(merged.items())
    text, total = next(items)
    for following, weight in items:
        ratio = total / (total + weight)
        text += f' AVG({ratio:.12g}) ' + following
        total += weight
    return text


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
        return Part(text, origin=id(node)) if text else None

    if isinstance(node, Lora):
        if ctx.centralize_loras and node.text.startswith('<lora:'):
            return Part('', loras=[(id(node), node.text, ctx.interval)], origin=id(node))
        return Part(node.text, origin=id(node))

    if isinstance(node, Item):
        chunks = []
        for atom in node.atoms:
            if isinstance(atom, Text):
                chunks.append(Part(atom.text))  # keep spacing between atoms
                continue
            part = render(atom, ctx)
            if part is not None:
                chunks.append(part)
        combined = _combine(chunks, lambda parts: ''.join(p.text for p in parts).strip())
        combined.origin = id(node)
        return combined if combined.text or combined.loras or combined.variants else None

    if isinstance(node, Group):
        part = _render_group(node, ctx)
        if part is not None:
            part.origin = id(node)
        return part

    return None  # pragma: no cover


def _render_group(group: Group, ctx: RenderCtx) -> Part | None:
    if group.settings.region is not None and not _belongs(group, ctx.segment):
        return None

    interval = _intersect(ctx.interval, group.settings.schedule)
    if interval is None:
        ctx.diags.warn(W05, pos=group.pos)
        return None

    will_wrap = ctx.time_slice is None and interval != FULL and interval != ctx.wrapped
    inner = replace(
        ctx, interval=interval, wrapped=interval if will_wrap else ctx.wrapped
    )
    if group.average:
        entries = [c for c in group.children if c.settings.avg_weight > 0
                   and _intersect(interval, c.settings.schedule) is not None]
        if not entries:
            return None
        # Scale before summing so large, finite relative weights cannot overflow.
        scale = max(c.settings.avg_weight for c in entries)
        total = sum(c.settings.avg_weight / scale for c in entries)
        variants, loras = [], []
        for entry in entries:
            part = render(entry, inner) or Part('')
            fraction = (entry.settings.avg_weight / scale) / total
            variants.extend((fraction * w, p) for w, p in
                            (part.variants if part.variants is not None else [(1.0, part)]))
            loras.extend(part.loras)
        if len(variants) > 256:
            raise PLv3Error(E03, 'AVG expansion exceeds 256 alternatives', group.pos)
        parts = [Part('', loras=list(dict.fromkeys(loras)), variants=variants)]
    else:
        parts = [p for p in (render(c, inner) for c in group.children) if p is not None]
    if ctx.centralize_loras and group.pos in ctx.lora_block_positions and parts and parts[0].loras:
        parts = [parts[0], *_randomise(parts[1:], group, ctx)]
    else:
        parts = _randomise(parts, group, ctx)

    fmt = group.settings.format
    if fmt:
        parts = [p.with_format(fmt) for p in parts]

    combined = _combine(parts)
    body = combined.text
    loras = [lora for part in parts for lora in part.loras]
    if combined.variants is not None:
        # Ordinary ancestor emphasis/format applies independently to every full
        # alternative, before the final conditioning mixture is emitted.
        def wrap(part):
            body = part.text
            weight = group.settings.weight
            wrapper = None
            if body and weight is not None and weight != 1:
                body, wrapper = f'({body}:{num(weight)})', 'weight'
            elif body and group.paren and weight is None:
                body, wrapper = f'({body})', 'paren'
            if will_wrap and body:
                body = f'[{body}, :{num(interval[0])},{num(interval[1])}]'
            return Part(body, will_wrap, format_body=part.text, wrapper=wrapper,
                        weight=weight if wrapper == 'weight' else None,
                        schedule=interval if will_wrap else None)
        return Part('', loras=loras, variants=[(w, wrap(p)) for w, p in combined.variants])
    if not body.strip() and not loras:
        return None
    if not body.strip(): return Part('', loras=loras)

    format_body = body
    weight = group.settings.weight
    wrapper = None
    if weight is not None and weight != 1.0:
        body = f"({body}:{num(weight)})"
        wrapper = "weight"
    elif group.paren and weight is None:
        # Bare parens with no weight: pass the user's parens through as written.
        body = f"({body})"
        wrapper = "paren"

    terminated = False
    schedule = None
    if will_wrap:
        # The comma lives inside the bracket so that a closed time window cannot
        # leave a dangling separator behind (spec §4.4).
        body = f"[{body}, :{num(interval[0])},{num(interval[1])}]"
        terminated = True
        schedule = interval

    return Part(
        body,
        terminated,
        format_body=format_body,
        wrapper=wrapper,
        weight=weight if wrapper == "weight" else None,
        schedule=schedule,
        loras=loras,
    )


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
    if node.settings.avg_weight == 0:
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


def build_segments(root: Group, seed: int, diags: Diagnostics, *, lora_output=None, lora_block_positions=(), time_slice=None, random_plan=None) -> list[Segment]:
    """AST -> segment list.  A BASE segment exists only when the user wrote a
    `region: base` group, or when there are no region groups at all (a plain
    prompt).  Ambient text alone no longer forces a base into existence."""
    found: list[tuple[Group, tuple[float, float]]] = []
    _collect_regions(root, time_slice or FULL, found, diags)

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
                or existing.mask_weight != region.mask_weight
                or existing.cond_weight != region.cond_weight
                or existing.schedule != (FULL if time_slice else _seg_schedule(region.kind, interval))
            ):
                diags.warn(W11, pos=group.pos)
            continue
        seg = Segment(
            kind=region.kind,
            key=key,
            mask=region.mask,
            imask=region.imask,
            feather=region.feather,
            mask_weight=region.mask_weight,
            cond_weight=region.cond_weight,
            schedule=FULL if time_slice else _seg_schedule(region.kind, interval),
        )
        by_key[key] = seg
        segments.append(seg)

    base = by_key.get(("base",))
    # `include_in_base: true` on any region is the user explicitly asking for base
    # content, so it conjures a base even without a `region: base` group.
    wants_base = any(g.settings.region.include_in_base for g, _ in found)
    has_regions = any(s.kind in ("mask", "imask", "fill") for s in segments)
    if base is not None:
        # The user wrote an explicit `region: base` group — keep it, at the front.
        segments.remove(base)
        segments.insert(0, base)
    elif wants_base or not has_regions:
        # A base is wanted: include_in_base asked for one, or there are no regions
        # at all (a plain prompt whose whole text is simply the base).
        base = Segment(kind="base", key=("base",))
        segments.insert(0, base)
    # Otherwise: regions present but neither a `region: base` group nor any
    # include_in_base -> NO base segment.  The ambient text still injects into
    # every region segment (unchanged); it just no longer conjures a full-image
    # base the user never asked for.

    for seg in segments:
        # The segment wrapper below already applies seg.schedule, so the render
        # starts out with that interval marked as wrapped.
        ctx = RenderCtx(
            seed=seed, diags=diags, segment=seg, interval=time_slice or FULL, wrapped=seg.schedule,
            centralize_loras=lora_output is not None, lora_block_positions=frozenset(lora_block_positions), time_slice=time_slice, random_plan=random_plan
        )
        part = render(root, ctx)
        if lora_output is not None and part is not None:
            for lora in part.loras:
                if lora not in lora_output: lora_output.append(lora)
        text = average_text(part)
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
