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


def compile_text(
    text: str,
    seed: int = 0,
    region_mode: str = "couple",
    polarity: str = "positive",
    recover: bool = False,
) -> CompileResult:
    """Compile PLv3 source into a prompt-control string.

    Strict by default: PLv3Error (E01 / E02 / E03) propagates, so the node stops
    ComfyUI instead of silently rendering a wrong image (spec §6).

    `recover=True` is for the editor, which asks about documents that are still
    being typed.  A broken construct is then reported as an E03 diagnostic and
    skipped, and everything around it still compiles — the preview and the detail
    page keep working on the half of the document that is fine, instead of going
    blank the moment a brace is missing.
    """
    diags = Diagnostics()
    if not text or not text.strip():
        return CompileResult("", diags.items, [], None)

    root, diags = parse(text, diags, recover=recover)
    validate(root, diags, allow_region=(polarity != "negative"), src=text)
    segments = build_segments(root, seed, diags)

    backend = BACKENDS.get(region_mode, couple_backend.render)
    out = backend(segments, diags)

    return CompileResult(out.strip(), diags.items, segments, root)
