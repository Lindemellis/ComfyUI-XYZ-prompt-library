"""Prompt Library V3 — ComfyUI node classes (spec §7).

Two nodes (positive / negative).  They compile the PLv3 text into a
prompt-control string; the output is a STRING on purpose, so we never depend on
prompt-control's internal API and the backend stays swappable.

The output must be fed to `PC: Schedule Prompt` / `PC: Schedule LoRAs`.
`PCTextEncode` does NOT understand schedule syntax.
"""
from __future__ import annotations

import hashlib

from .compile import REGION_MODES, compile_text

_USAGE = (
    "Compiles PLv3 text into comfyui-prompt-control syntax.\n"
    "Feed the output to 'PC: Schedule Prompt' / 'PC: Schedule LoRAs' — "
    "'PCTextEncode' does not support schedule syntax."
)


class _PLv3Base:
    CATEGORY = "XYZNodes/Prompt"
    FUNCTION = "execute"
    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("prompt",)

    polarity: str = "positive"

    @classmethod
    def IS_CHANGED(cls, text: str = "", seed: int = 0, region_mode: str = "couple", **_):
        key = f"{text}\x00{seed}\x00{region_mode}\x00{cls.polarity}"
        return hashlib.sha256(key.encode("utf-8")).hexdigest()

    def execute(self, text: str = "", seed: int = 0, region_mode: str = "couple", **_):
        result = compile_text(
            text, seed=seed, region_mode=region_mode, polarity=self.polarity
        )
        for diag in result.diagnostics:
            print(f"[PLv3] {diag}")
        return (result.text,)


class PromptLibraryV3PositiveNode(_PLv3Base):
    NAME = "Prompt Library V3 (Positive)"
    DESCRIPTION = _USAGE
    polarity = "positive"

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


class PromptLibraryV3NegativeNode(_PLv3Base):
    NAME = "Prompt Library V3 (Negative)"
    DESCRIPTION = _USAGE + "\nRegions are not available on the negative side."
    polarity = "negative"

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
            },
            "hidden": {"node_id": "UNIQUE_ID"},
        }
