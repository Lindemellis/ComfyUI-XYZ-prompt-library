"""Prompt Library V2 — ComfyUI node classes.

Two nodes (positive / negative) that resolve a prompt_template string against
the PLv2 SQLite library at execution time.  The pos_neg class attribute is read
by the JS frontend to filter the folder tree to matching nodes.
"""
from __future__ import annotations


class _PLv2Base:
    """Shared logic for both PLv2 node variants."""

    CATEGORY = "XYZNodes/Prompt"
    FUNCTION = "execute"
    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("resolved_prompt", "raw_template")

    pos_neg: str = "both"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "prompt_template": ("STRING", {"default": "", "multiline": True}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xFFFFFFFFFFFFFFFF}),
            },
            "hidden": {
                "node_id": "UNIQUE_ID",
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Always re-execute — library data in DB may have changed between runs.
        return float("nan")

    def execute(self, prompt_template: str, seed: int, node_id: str = "") -> tuple:
        if not prompt_template or not prompt_template.strip():
            return ("", "")
        try:
            from .engine import resolve_template
            text = resolve_template(prompt_template, seed)
        except Exception as exc:
            print(f"[PLv2] resolve_template error: {exc}")
            text = prompt_template
        return (text, prompt_template)


class PromptLibraryV2PositiveNode(_PLv2Base):
    NAME = "Prompt Library V2 (Positive)"
    DESCRIPTION = (
        "Resolves a prompt template against the PLv2 library. "
        "The folder tree is filtered to nodes tagged 'positive'."
    )
    pos_neg = "positive"


class PromptLibraryV2NegativeNode(_PLv2Base):
    NAME = "Prompt Library V2 (Negative)"
    DESCRIPTION = (
        "Resolves a prompt template against the PLv2 library. "
        "The folder tree is filtered to nodes tagged 'negative'."
    )
    pos_neg = "negative"
