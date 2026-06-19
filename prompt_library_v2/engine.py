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

# [this] / [this.sub] — "this" is rebound to the owning entry's full_path at
# generation time so the ref resolves against the right node (feature e).
_THIS_RE = re.compile(r"\[this(\.[^\[\]]*)?\]")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def resolve_template(
    template: str,
    seed: int,
    output_index: int = 0,
    deps: Optional[Set[int]] = None,
) -> str:
    """Process a prompt template and return the fully expanded text.

    Args:
        template:     raw text from the node's prompt_template widget
        seed:         RNG seed (controls random mode + dropout)
        output_index: which option to pick from {a|b|c} patterns
        deps:         if given, every node_id this resolution actually walks
                      through is added to it — the expanded entries AND the
                      origin nodes of the prompts they used (template sources).
                      Lets a caller know which entry edits should re-resolve.
    """
    if not template or not template.strip():
        return ""

    rng = _random.Random(seed)

    # Step 1: resolve {a|b} multi-output patterns
    text = _apply_choices(template, output_index)

    # Step 2: recursively expand [entry_ref] patterns
    text = _expand_refs(text, rng, resolving_set=frozenset(), depth=0, deps=deps)

    # Step 3: clean up
    return _cleanup(text)


def generate_entry_text(
    node_id: int,
    rng: _random.Random,
    resolving_set: frozenset,
    deps: Optional[Set[int]] = None,
) -> str:
    """Generate prompt text for a single entry node.

    Called by _expand_refs; resolving_set is passed through for cycle detection.
    If `deps` is given, this entry and the origin nodes of its (enabled) prompts
    are recorded into it (so template-inheritance sources are captured too).
    """
    node = _repo.get_node(node_id)
    if node is None or not node["has_prompts"]:
        return ""

    if deps is not None:
        deps.add(node_id)   # the entry contributes even when it currently yields ""

    # Effective enabled prompts = own + inherited template prompts (cascaded
    # per-entry overrides, deduped by content), in own-then-inherited order.
    from .template import effective_enabled_prompts
    enabled = effective_enabled_prompts(node_id)
    if deps is not None:
        for it in enabled:
            oid = it.get("origin_id")
            if oid is not None:
                deps.add(oid)   # inherited prompts → their _template owner node
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
            parts.append((text, int(prompt["sep_after"] or 0)))

    # Join with the delimiter, but where a prompt carries trailing newlines
    # (sep_after > 0) emit them as the user's line breaks (feature B). The
    # delimiter's trailing spaces are dropped before a newline so lines stay clean.
    delim_trim = delimiter.rstrip(" \t")
    segs = []
    for i, (text, sep) in enumerate(parts):
        segs.append(text)
        if i < len(parts) - 1:
            segs.append((delim_trim + "\n" * sep) if sep > 0 else delimiter)
        elif sep > 0:
            segs.append("\n" * sep)   # trailing layout (cleanup strips it at the end)
    joined = "".join(segs)
    # Rebind [this]/[this.sub] to this entry's own full_path so the outer
    # ref-expander targets the right node (feature e).
    full_path = node["full_path"]
    return _THIS_RE.sub(lambda m: f"[{full_path}{m.group(1) or ''}]", joined)


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
    deps: Optional[Set[int]] = None,
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

        # Not a PLv2 entry reference: prompt scheduling / alternation syntax
        # (e.g. `[red:blue:0.5]`, `[cat|dog:0.1]`, `[SEQ:a:0.3:b:0.6]`) reuses
        # square brackets but belongs to downstream nodes (comfyui-prompt-control).
        # A real ref is a path / trigger name, which never contains ':' or '|'
        # (trigger names forbid '|'; paths use '.' as separator, never ':').
        # Leave such expressions untouched so they pass through verbatim instead
        # of resolving to nothing and being silently dropped.
        if ":" in token or "|" in token:
            return m.group(0)

        # Resolve the trigger/path to a (node_id, sub_path) pair
        resolution = resolve_trigger(token)
        if resolution is None:
            return ""   # Unknown reference → silently remove

        node_id, sub_path = resolution

        # If sub_path is non-empty, navigate to the child node
        target_id = node_id
        inherited = False
        if sub_path:
            parent = _repo.get_node(node_id)
            if parent is None:
                return ""
            child_path = parent["full_path"] + "." + sub_path
            child = _repo.get_node_by_path(child_path)
            if child is None:
                # No own child — fall back to an inherited template sub-entry (#1).
                from .template import resolve_inherited_target
                tgt = resolve_inherited_target(node_id, sub_path)
                if tgt is None:
                    return ""   # Sub-path doesn't exist
                target_id = tgt
                inherited = True
            else:
                target_id = child["id"]

        # A _template entry (or anything under one) is not directly referenceable —
        # its prompts only reach entries through inheritance, never via direct [ref]
        # (#11). Targets reached THROUGH inheritance above are allowed.
        if not inherited:
            _tnode = _repo.get_node(target_id)
            if _tnode is not None and "_template" in _tnode["full_path"].split("."):
                return ""

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
        generated = generate_entry_text(target_id, rng, new_resolving_set, deps)

        # Recursively expand any [refs] inside the generated text
        return _expand_refs(generated, rng, new_resolving_set, depth + 1, deps)

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
