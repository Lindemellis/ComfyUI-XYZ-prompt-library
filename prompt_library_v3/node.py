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

from .compile import REGION_MODES, compile_text

_USAGE = (
    "Compiles PLv3 text into comfyui-prompt-control syntax.\n"
    "Feed the output to 'PC: Schedule Prompt' / 'PC: Schedule LoRAs' — "
    "'PCTextEncode' does not support schedule syntax.\n"
    "Regions are for the positive prompt only; don't put one in a negative prompt."
)


class _PLv3Base:
    CATEGORY = "XYZNodes/Prompt"
    FUNCTION = "execute"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)
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
            "hidden": {"node_id": "UNIQUE_ID"},
        }

    @classmethod
    def IS_CHANGED(cls, text: str = "", seed: int = 0, region_mode: str = "couple", **_):
        key = f"{text}\x00{seed}\x00{region_mode}"
        return hashlib.sha256(key.encode("utf-8")).hexdigest()

    def execute(self, text: str = "", seed: int = 0, region_mode: str = "couple", **_):
        result = compile_text(text, seed=seed, region_mode=region_mode)
        for diag in result.diagnostics:
            print(f"[PLv3] {diag}")
        return (result.text,)


class PromptLibraryV3Node(_PLv3Base):
    """The plain-textarea node."""

    NAME = "Prompt Library V3"


class PromptLibraryV3MonacoNode(_PLv3Base):
    """Same node, but the text box is the embedded Monaco editor (js/plv3.js)."""

    NAME = "Prompt Library V3 (Monaco)"
    DESCRIPTION = _USAGE + "\nThe text box is the full editor: library autocomplete, folding, tags."
