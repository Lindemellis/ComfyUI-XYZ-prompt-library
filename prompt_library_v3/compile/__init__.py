"""PLv3 compiler entry point.

    compile_text(text, seed, region_mode, polarity) -> CompileResult

Compilation is a pure function of `(text, seed, region_mode)` — the library DB is
never read (spec §4.7).  Library groups are fully expanded into the text by the
editor, so a workflow can be shared without the library.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ..diagnostics import Diag, Diagnostics
from ..ir import Segment, RenderCtx, render as render_part, build_segments, FULL, num
from ..parser import Group, Item, parse
from ..validate import validate
from . import couple as couple_backend
from . import mask as mask_backend

BACKENDS = {
    "couple": couple_backend.render,
    "mask": mask_backend.render,
}

REGION_MODES = tuple(BACKENDS)


@dataclass
class CompileResult:
    text: str
    diagnostics: list[Diag] = field(default_factory=list)
    segments: list[Segment] = field(default_factory=list)
    ast: Group | None = None

    @property
    def warnings(self) -> list[Diag]:
        return [d for d in self.diagnostics if not d.is_error]


def strip_regions(node) -> None:
    """Forget every region declaration in the tree, in place.

    This is what the node's **plain** output is: the same document with the region
    syntax ignored, so every prompt — the base, each masked region, the fill —
    lands in ONE prompt, in the order it was written. Schedules, weights, shuffle,
    LoRAs and the rest are untouched; only the spatial split goes away.

    Not the same thing as "the base region": a base region is one region among
    several that the user declared and can still weight and schedule. Plain is the
    whole document with no regions in it at all.
    """
    if isinstance(node, Group):
        if node.settings.region is not None:
            node.settings.region = None
        for child in node.children:
            strip_regions(child)


def compile_text(
    text: str,
    seed: int = 0,
    region_mode: str = "couple",
    polarity: str = "positive",
    recover: bool = False,
    ignore_regions: bool = False,
    ignore_group_seeds: bool = False,
    centralize_loras: bool = False,
    lora_block_positions=(),
) -> CompileResult:
    """Compile PLv3 source into a prompt-control string.

    Strict by default: PLv3Error (E01 / E02 / E03) propagates, so the node stops
    ComfyUI instead of silently rendering a wrong image (spec §6).

    `recover=True` is for the editor, which asks about documents that are still
    being typed.  A broken construct is then reported as an E03 diagnostic and
    skipped, and everything around it still compiles — the preview and the detail
    page keep working on the half of the document that is fine, instead of going
    blank the moment a brace is missing.

    `ignore_regions=True` is the node's **plain** output: the regions are dropped
    before anything looks at them, so the whole document compiles to one prompt.
    Validation runs on the stripped tree, so the region-only rules (E01 nested
    regions, W13 a region in a negative prompt) have nothing to fire on — this
    output cannot be wrong about a split it does not make.
    """
    diags = Diagnostics()
    if not text or not text.strip():
        return CompileResult("", diags.items, [], None)

    root, diags = parse(text, diags, recover=recover)
    if ignore_group_seeds:
        # PLv4 uses the ComfyUI node's seed input for every group. Keep legacy
        # source unchanged while ignoring local overrides, including Item atoms.
        def clear_seed(node):
            if isinstance(node, Group):
                node.settings.seed = None
                for child in node.children:
                    clear_seed(child)
            elif isinstance(node, Item):
                for atom in node.atoms:
                    clear_seed(atom)
        clear_seed(root)
    if ignore_regions:
        strip_regions(root)
    validate(root, diags, allow_region=(polarity != "negative"), src=text)
    backend = BACKENDS.get(region_mode, couple_backend.render)
    def groups(node):
        if isinstance(node, Group):
            yield node
            if node.settings.avg_weight == 0:
                return
            for child in node.children:
                yield from groups(child)
        elif isinstance(node, Item):
            for atom in node.atoms:
                yield from groups(atom)
    all_groups = list(groups(root))
    has_avg = any(g.average for g in all_groups)
    loras = [] if centralize_loras or has_avg else None
    if has_avg:
        random_plan = {}
        build_segments(root, seed, Diagnostics(), lora_output=[],
                       lora_block_positions=lora_block_positions, random_plan=random_plan)
        # A timed region can disappear, revealing an implicit full-image base
        # that was absent in the full-tree pass. Plan that ambient view too.
        render_part(root, RenderCtx(seed=seed, diags=Diagnostics(),
                    segment=Segment(kind='base', key=('base',)), centralize_loras=True,
                    lora_block_positions=frozenset(lora_block_positions), random_plan=random_plan))
        # Prompt Control resolves schedules before AVG/COUPLE/AND. Rendering each
        # active interval first keeps operator scope and renormalises only active
        # entries, including schedules in their nested content.
        boundaries = sorted({0.0, 1.0, *(v for g in all_groups if g.settings.schedule
                                       for v in g.settings.schedule)})
        pieces, segments = [], []
        for interval in zip(boundaries, boundaries[1:]):
            current = build_segments(root, seed, diags, lora_output=loras,
                                     lora_block_positions=lora_block_positions, time_slice=interval, random_plan=random_plan)
            segments.extend(current)
            text = backend(current, diags)
            if pieces and pieces[-1][0] == text:
                pieces[-1] = (text, (pieces[-1][1][0], interval[1]))
            else:
                pieces.append((text, interval))
        out = ' '.join(text if interval == FULL else
                       f'[{text}, :{num(interval[0])},{num(interval[1])}]'
                       for text, interval in pieces if text)
        if loras:
            # Ambient LoRA tokens are copied across alternatives/regions/time
            # slices. Their provenance collapses those copies, but never two
            # explicit source invocations (even when names and weights agree).
            merged = {}
            for identity, token, interval in loras:
                merged.setdefault((identity, token), []).append(interval)
            loras = []
            for (identity, token), intervals in merged.items():
                windows = []
                for start, end in sorted(set(intervals)):
                    if windows and start <= windows[-1][1]:
                        windows[-1] = (windows[-1][0], max(windows[-1][1], end))
                    else:
                        windows.append((start, end))
                loras.extend((identity, token, interval) for interval in windows)
    else:
        segments = build_segments(root, seed, diags, lora_output=loras, lora_block_positions=lora_block_positions)
        out = backend(segments, diags)
    if loras:
        tail = ' '.join(token if interval == FULL else f'[{token}, :{num(interval[0])},{num(interval[1])}]' for _, token, interval in loras)
        out = (out + '\n' + tail) if out else tail

    return CompileResult(out.strip(), diags.items, segments, root)
