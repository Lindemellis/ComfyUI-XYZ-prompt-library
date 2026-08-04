"""PLv3 compiler entry point.

    compile_text(text, seed, region_mode, polarity) -> CompileResult

Compilation is a pure function of `(text, seed, region_mode)` — the library DB is
never read (spec §4.7).  Library groups are fully expanded into the text by the
editor, so a workflow can be shared without the library.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ..diagnostics import Diag, Diagnostics
from ..ir import Segment, build_segments
from ..parser import Group, parse
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
    if ignore_regions:
        strip_regions(root)
    validate(root, diags, allow_region=(polarity != "negative"), src=text)
    segments = build_segments(root, seed, diags)

    backend = BACKENDS.get(region_mode, couple_backend.render)
    out = backend(segments, diags)

    return CompileResult(out.strip(), diags.items, segments, root)
