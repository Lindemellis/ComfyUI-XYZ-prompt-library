"""Prompt Library V3 — ComfyUI node classes (spec §7).

Two nodes that differ ONLY in their editor: `Prompt Library V3` uses ComfyUI's
plain textarea; `Prompt Library V3 (Monaco)` mounts the full Monaco editor (library
autocomplete, folding, tag lookup) right in the node. The backend is identical.

There is no positive/negative split any more — a document compiles the same either
way. Regions are only meaningful on the positive side; if you feed this node's output
to a NEGATIVE conditioning, simply do not put a region in the text (there is nothing
to enforce it, by design).

The output is a STRING on purpose, so we never depend on prompt-control's internal
API and the backend stays swappable. Feed it to `PC: Schedule Prompt` /
`PC: Schedule LoRAs`; `PCTextEncode` does NOT understand schedule syntax.
"""
from __future__ import annotations

import hashlib
import json

from .compile import REGION_MODES, compile_text

_USAGE = (
    "Compiles PLv3 text into comfyui-prompt-control syntax.\n"
    "Feed the output to 'PC: Schedule Prompt' / 'PC: Schedule LoRAs' — "
    "'PCTextEncode' does not support schedule syntax.\n"
    "Regions are for the positive prompt only; don't put one in a negative prompt."
)


def source_text(text: str, doc: str) -> str:
    """What actually gets compiled.

    The **document** is the source of truth: it holds every item, switched on or
    off, and `text` is what you get when its enabled items are rendered. The two
    are kept in step by the editor, so normally they are identical — but when they
    are not, the document wins, or an item you switched off in the UI could come
    back at execution time.

    A document that is missing (an older workflow, a node driven purely through the
    API) or unreadable falls back to `text`, which is exactly the old behaviour.
    """
    if not doc or not doc.strip():
        return text

    try:
        from .document import Document, render

        return render(Document.from_json(json.loads(doc)))
    except Exception as exc:  # noqa: BLE001 - a bad doc must never block a render
        print(f"[PLv3] document unreadable, compiling the text instead: {exc}")
        return text


class _PLv3Base:
    CATEGORY = "XYZNodes/Prompt"
    FUNCTION = "execute"
    # `plain` is the same document with the region syntax IGNORED: base, every masked
    # region and the fill all land in one prompt, in the order they were written.
    # Schedules, weights, shuffle and LoRAs still work — only the spatial split goes.
    # Feed it to anything that wants one ordinary prompt (a negative, a second pass,
    # a model with no regional support) without keeping a second copy of the text.
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("prompt", "plain")
    OUTPUT_TOOLTIPS = (
        "The regions compiled to prompt-control (COUPLE / AND + MASK / IMASK / FILL).",
        "Every region flattened into ONE prompt, schedules and weights intact.",
    )
    DESCRIPTION = _USAGE

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"default": "", "multiline": True, "tooltip": _USAGE}),
                "seed": (
                    "INT",
                    {
                        "default": 0,
                        "min": 0,
                        "max": 0xFFFFFFFFFFFFFFFF,
                        "control_after_generate": True,
                        "tooltip": "Random source for shuffle / random_select / dropout.",
                    },
                ),
                "region_mode": (
                    list(REGION_MODES),
                    {
                        "default": "couple",
                        "tooltip": "couple = attention couple; mask = latent mask (AND + MASK).",
                    },
                ),
            },
            "optional": {
                # The structured document (JSON): the same tree as `text`, plus a
                # stable id and an on/off switch for every item. The frontend hides
                # this widget and keeps it in step with the text; it is what carries
                # the items you switched OFF, which by design are nowhere in the text.
                # A plain STRING so a workflow saved before it existed still loads.
                "doc": ("STRING", {"default": "", "multiline": False}),
            },
            "hidden": {"node_id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(cls, text: str = "", seed: int = 0, region_mode: str = "couple",
                   doc: str = "", **_):
        # Key on what is COMPILED, not on the raw widgets: flipping an item off
        # changes the document but leaves `text` alone for one beat, and two
        # documents that render the same text must not re-run.
        key = f"{source_text(text, doc)}\x00{seed}\x00{region_mode}"
        return hashlib.sha256(key.encode("utf-8")).hexdigest()

    def execute(self, text: str = "", seed: int = 0, region_mode: str = "couple",
                doc: str = "", **_):
        source = source_text(text, doc)
        result = compile_text(source, seed=seed, region_mode=region_mode)
        for diag in result.diagnostics:
            print(f"[PLv3] {diag}")
        # The SAME seed, so a shuffle / random_select picks the same words in both
        # outputs — they are two renderings of one document, not two draws.
        plain = compile_text(
            source, seed=seed, region_mode=region_mode, ignore_regions=True
        )
        return (result.text, plain.text)


class PromptLibraryV3Node(_PLv3Base):
    """The plain-textarea node."""

    NAME = "Prompt Library V3"


class PromptLibraryV3MonacoNode(_PLv3Base):
    """Same node, but the text box is the embedded Monaco editor (js/plv3.js)."""

    NAME = "Prompt Library V3 (Monaco)"
    DESCRIPTION = _USAGE + "\nThe text box is the full editor: library autocomplete, folding, tags."
