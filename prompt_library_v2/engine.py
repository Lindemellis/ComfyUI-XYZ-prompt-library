"""Prompt Library V2 — text generation engine.

Two entry points:

resolve_template(template, seed, output_index):
    Process a full prompt template string.
    1. {a|b} pattern → select the output_index-th option
    2. [entry_ref] → recursively expand, with cycle detection
    3. Clean up stray delimiters

generate_entry_text(node_id, rng, resolving_set):
    Generate the prompt text for a single entry node.
    Applies: enabled-prompt filtering, random mode (select/dropout),
    shuffle, format ({p}/{prompt}), weight, and delimiter.
"""

from __future__ import annotations

import random as _random
import re
from typing import Optional, Set

from . import repo as _repo
from .trigger import resolve_trigger

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MAX_EXPANSION_DEPTH = 50   # safety cap on [ref] recursion depth
_WEIGHT_EPS = 1e-9         # treat weights within this of 1.0 as unweighted


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def resolve_template(
    template: str,
    seed: int,
    output_index: int = 0,
) -> str:
    """Process a prompt template and return the fully expanded text.

    Args:
        template:     raw text from the node's prompt_template widget
        seed:         RNG seed (controls random mode + dropout)
        output_index: which option to pick from {a|b|c} patterns
    """
    if not template or not template.strip():
        return ""

    rng = _random.Random(seed)

    # Step 1: resolve {a|b} multi-output patterns
    text = _apply_choices(template, output_index)

    # Step 2: recursively expand [entry_ref] patterns
    text = _expand_refs(text, rng, resolving_set=frozenset(), depth=0)

    # Step 3: clean up
    return _cleanup(text)


def generate_entry_text(
    node_id: int,
    rng: _random.Random,
    resolving_set: frozenset,
) -> str:
    """Generate prompt text for a single entry node.

    Called by _expand_refs; resolving_set is passed through for cycle detection.
    """
    node = _repo.get_node(node_id)
    if node is None or not node["has_prompts"]:
        return ""

    all_prompts = _repo.get_prompts(node_id)
    # get_prompts already orders: enabled by order_index, disabled alphabetically
    enabled = [p for p in all_prompts if p["enabled"]]
    if not enabled:
        return ""

    # -- Apply random mode --------------------------------------------------
    mode = node["random_mode"]
    if mode == "select":
        lo = max(1, node["select_min"])
        hi = max(lo, node["select_max"])
        count = rng.randint(lo, hi)
        count = min(count, len(enabled))
        if node["shuffle"]:
            selected = rng.sample(enabled, count)
        else:
            # Order-preserving: sample indices, then sort
            idxs = sorted(rng.sample(range(len(enabled)), count))
            selected = [enabled[i] for i in idxs]

    elif mode == "dropout":
        rate = float(node["dropout_rate"])
        selected = [p for p in enabled if rng.random() >= rate]
        if node["shuffle"]:
            rng.shuffle(selected)

    else:  # 'none'
        selected = list(enabled)
        if node["shuffle"]:
            rng.shuffle(selected)

    if not selected:
        return ""

    # -- Format + weight each prompt ----------------------------------------
    fmt: str = node["format"] or ""
    delimiter: str = node["delimiter"] or ", "
    parts = []

    for prompt in selected:
        content: str = prompt["content"]
        weight: float = float(prompt["weight"])

        # Apply format template (replace {p} and {prompt})
        if fmt:
            text = fmt.replace("{prompt}", content).replace("{p}", content)
        else:
            text = content

        # Apply weight wrapping
        if abs(weight - 1.0) > _WEIGHT_EPS:
            text = f"({text}:{_fmt_weight(weight)})"

        if text.strip():            # drop empty/whitespace parts (no stray delimiters)
            parts.append(text)

    return delimiter.join(parts)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _fmt_weight(w: float) -> str:
    """Format weight as the shortest clean decimal string, e.g. 1.1, 1.05."""
    s = f"{w:.2f}"
    # Strip trailing zero after the decimal point: "1.10" → "1.1"
    if s.endswith("0") and "." in s:
        s = s[:-1]
    return s


# {a|b|c} pattern — picks output_index-th option (0-indexed).
# If index is out of range, returns empty string.
_CHOICE_RE = re.compile(r"\{([^{}]+)\}")


def _apply_choices(text: str, output_index: int) -> str:
    def _pick(m: re.Match) -> str:
        options = m.group(1).split("|")
        if output_index < len(options):
            return options[output_index]
        return ""
    return _CHOICE_RE.sub(_pick, text)


# [entry_ref] pattern — matches anything inside square brackets that doesn't
# itself contain square brackets (prevents nested bracket confusion).
_REF_RE = re.compile(r"\[([^\[\]]+)\]")


def _expand_refs(
    text: str,
    rng: _random.Random,
    resolving_set: frozenset,
    depth: int,
) -> str:
    """Expand all [entry_ref] patterns in text, recursing into generated text.

    resolving_set tracks which node_ids are currently being expanded in this
    call chain — the cycle guard. Uses frozenset so each recursive frame gets
    its own immutable snapshot (no shared mutable state across sibling expansions).
    """
    if depth > MAX_EXPANSION_DEPTH:
        # Safety cap: return text unexpanded to avoid runaway recursion
        return text

    if not _REF_RE.search(text):
        return text   # Fast path: nothing to expand

    def _replacer(m: re.Match) -> str:
        token = m.group(1).strip()

        # Resolve the trigger/path to a (node_id, sub_path) pair
        resolution = resolve_trigger(token)
        if resolution is None:
            return ""   # Unknown reference → silently remove

        node_id, sub_path = resolution

        # If sub_path is non-empty, navigate to the child node
        target_id = node_id
        if sub_path:
            parent = _repo.get_node(node_id)
            if parent is None:
                return ""
            child_path = parent["full_path"] + "." + sub_path
            child = _repo.get_node_by_path(child_path)
            if child is None:
                return ""   # Sub-path doesn't exist
            target_id = child["id"]

        # Cycle detection
        if target_id in resolving_set:
            import logging
            logging.getLogger("xyz.plv2.engine").warning(
                "Circular reference detected for node_id=%d (token=%r); skipping.",
                target_id, token,
            )
            return ""

        # Generate text for the target entry
        new_resolving_set = resolving_set | {target_id}
        generated = generate_entry_text(target_id, rng, new_resolving_set)

        # Recursively expand any [refs] inside the generated text
        return _expand_refs(generated, rng, new_resolving_set, depth + 1)

    return _REF_RE.sub(_replacer, text)


# Cleanup: collapse runs of consecutive delimiters (left behind by empty [refs]
# or by nested entries with differing delimiters) and tidy whitespace. Newlines
# are preserved — they are the user's paragraph structure, not delimiters.
#
# Delimiter chars: , . ; | /   (the punctuation entries use as delimiters).
_DELIM_CHARS = r",.;|/"
# A run of 2+ delimiter chars separated only by spaces/tabs → keep the FIRST one.
_DELIM_RUN_RE     = re.compile(rf"([{_DELIM_CHARS}])(?:[ \t]*[{_DELIM_CHARS}])+")
# A delimiter stranded at the start of a line (or the whole string).
_LINE_LEAD_RE     = re.compile(rf"(?m)^[ \t]*[{_DELIM_CHARS}]+[ \t]*")
# A delimiter stranded at the very end of the whole string (any delimiter).
_TRAILING_RE      = re.compile(rf"[ \t]*[{_DELIM_CHARS}]+[ \t]*$")
_MULTI_SPACE_RE   = re.compile(r"[ \t]{2,}")


def _cleanup(text: str) -> str:
    text = _DELIM_RUN_RE.sub(r"\1", text)   # ". ," / ", ." / ",," → first delimiter
    text = _LINE_LEAD_RE.sub("", text)      # drop delimiters left at line starts
    text = _TRAILING_RE.sub("", text)       # drop a trailing delimiter at the end
    text = _MULTI_SPACE_RE.sub(" ", text)
    return text.strip()
