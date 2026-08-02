"""Prompt templates — switch the whole system prompt in one move.

A **template is a named variant set**. Every text block already carries any number of
named variants (see schema v7); a template id IS one of those variant names, so the
per-block variant dropdown and the template switcher are two views of the same data —
there is no second store to keep in sync.

Applying template T:
  - every MANAGED block that owns a variant named T is pointed at it;
  - every MANAGED block is enabled unless T lists its kind in `disabled_kinds`;
  - non-managed blocks (custom ones, and the history / base_prompt / user_request
    placeholders) keep their enabled state, but still follow a variant named T if they
    happen to have one — so a user's own block can carry per-template text;
  - the id is recorded in settings as `active_template`.

**Tool availability is derived, never stored**: a tool is offered to the model only when
its documentation block is enabled (`tool_gate`). That is how Krea 2 ends up with no
danbooru lookup — its template simply disables the `tooldoc` block, so the model is never
told about a tool it doesn't have, and the schema is never attached.

User templates ("save as…") are ordinary variants named after the template, plus one
settings entry recording which blocks were disabled at save time.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

try:  # runtime: llm is a subpackage of the custom-node root
    from ..prompt_library_v2 import repo as _repo
except ImportError:  # standalone (tests with the repo root on sys.path)
    from prompt_library_v2 import repo as _repo

from . import settings as _settings
from .defaults import MANAGED_KINDS, TEMPLATES

logger = logging.getLogger("xyz.llm.templates")

# Placeholder blocks a template must never touch — they carry no text and their enabled
# flag is structural (history on/off is the user's call, not a template's).
_UNTOUCHABLE_KINDS = {"history", "base_prompt", "user_request"}

# Which block kind documents which tool. A tool is only offered when its block is on.
_TOOL_BLOCK_KIND = {"lookup": "tooldoc", "web_search": "web_search"}


def _variant_named(block_id: int, name: str) -> Optional[Dict[str, Any]]:
    for v in _repo.get_block_variants(block_id):
        if (v.get("variant_name") or "") == name:
            return v
    return None


def active_template() -> Dict[str, Any]:
    """Which template the blocks are ACTUALLY on — derived, not trusted.

    The blocks are the truth: if every managed block's active variant carries the same
    name, that name IS the active template, whatever settings happens to remember (an
    install that predates templates has `active_template: "default"` stored while sitting
    on anima variants). Disagreement means the user hand-picked variants: report the
    stored name and flag it `mixed` so the UI doesn't claim a template it isn't on.

    Only ENABLED blocks count. A disabled block contributes nothing to the system prompt,
    so the variant it happens to hold is irrelevant — and this is what lets krea2 read as
    krea2 even though the `tooldoc` block it switched off still points at another variant.
    """
    names = set()
    try:
        for b in _repo.get_llm_blocks():
            if b.get("kind") in MANAGED_KINDS and b.get("enabled") and b.get("active_variant_id"):
                names.add(b.get("variant_name") or "default")
    except Exception:
        logger.exception("deriving the active template failed")
    if len(names) == 1:
        return {"active": names.pop(), "mixed": False}
    return {"active": _settings.get_active_template(), "mixed": bool(names)}


def list_templates() -> Dict[str, Any]:
    """{templates: [{id, label, builtin, disabled_kinds, blocks}], active, mixed}.

    Built-ins always appear (even before their variants are seeded); user templates are
    discovered from the variant names actually present in the DB.
    """
    seen: Dict[str, Dict[str, Any]] = {}
    for tid, t in TEMPLATES.items():
        seen[tid] = {
            "id": tid,
            "label": t["label"],
            "builtin": True,
            "disabled_kinds": sorted(t["disabled_kinds"]),
            "blocks": 0,
        }
    custom = _settings.get_custom_templates()
    try:
        for b in _repo.get_llm_blocks():
            for v in _repo.get_block_variants(b["id"]):
                name = (v.get("variant_name") or "").strip()
                if not name:
                    continue
                if name not in seen:
                    seen[name] = {
                        "id": name,
                        "label": name,
                        "builtin": False,
                        "disabled_kinds": [],
                        "blocks": 0,
                    }
                seen[name]["blocks"] += 1
    except Exception:
        logger.exception("listing template variants failed")
    # a saved-but-empty custom template still deserves a row
    for name in custom:
        seen.setdefault(name, {"id": name, "label": name, "builtin": False,
                               "disabled_kinds": [], "blocks": 0})

    order = list(TEMPLATES.keys())
    rows = [seen[t] for t in order if t in seen]
    rows += sorted((r for k, r in seen.items() if k not in TEMPLATES), key=lambda r: r["id"])
    return {"templates": rows, **active_template()}


def apply_template(template_id: str) -> Dict[str, Any]:
    """Switch every block to `template_id`. Returns {active, blocks, tools, missing}.

    `missing` lists the managed kinds that have no variant of that name (they keep the
    variant they had) — the UI surfaces it rather than silently half-applying.
    """
    tid = str(template_id or "").strip()
    if not tid:
        raise ValueError("template id required")
    builtin = TEMPLATES.get(tid)
    if builtin is None and tid not in _settings.get_custom_templates():
        # A bare variant name that exists in the DB is a perfectly good template too.
        known = {t["id"] for t in list_templates()["templates"]}
        if tid not in known:
            raise ValueError(f"unknown template: {tid}")

    disabled_kinds = set(builtin["disabled_kinds"]) if builtin else set()
    disabled_ids = set()
    if builtin is None:
        entry = _settings.get_custom_templates().get(tid) or {}
        disabled_ids = {int(i) for i in (entry.get("disabled_block_ids") or [])}

    missing: List[str] = []
    for b in _repo.get_llm_blocks():
        kind = b.get("kind")
        if kind in _UNTOUCHABLE_KINDS:
            continue
        managed = kind in MANAGED_KINDS

        variant = _variant_named(b["id"], tid)
        if variant is not None and variant["id"] != b.get("active_variant_id"):
            _repo.enqueue_write(
                _repo.MID,
                _repo.SetActiveVariantOp(block_id=b["id"], variant_id=variant["id"]),
            ).result(timeout=5)
        elif variant is None and managed and (builtin is None or kind in builtin["blocks"]):
            missing.append(kind)

        if builtin is not None:
            if not managed:
                continue                         # built-in: leave the user's own blocks alone
            want = kind not in disabled_kinds
        else:
            # a user template snapshotted every block, so it restores every block
            want = b["id"] not in disabled_ids
        if bool(b.get("enabled")) != want:
            _repo.enqueue_write(
                _repo.MID,
                _repo.UpdateLlmBlockOp(block_id=b["id"], enabled=want),
            ).result(timeout=5)

    _settings.set_active_template(tid)
    return {
        **active_template(),          # derived, so a half-applied switch reports `mixed`
        "requested": tid,
        "blocks": _repo.get_llm_blocks(),
        "tools": tool_gate(),
        "missing": missing,
    }


def save_as_template(name: str) -> Dict[str, Any]:
    """Snapshot the current block state as a user template.

    Each text block's ACTIVE text is written to a variant named `name` (created or
    overwritten), and the ids of the currently-disabled blocks are recorded so applying
    the template later restores the same on/off picture — including the tool gate.
    """
    tid = str(name or "").strip()
    if not tid:
        raise ValueError("template name required")
    if tid in TEMPLATES:
        raise ValueError(f"'{tid}' is a built-in template — pick another name")

    disabled_ids: List[int] = []
    for b in _repo.get_llm_blocks():
        kind = b.get("kind")
        if not b.get("enabled") and kind not in _UNTOUCHABLE_KINDS:
            disabled_ids.append(int(b["id"]))
        if kind in _UNTOUCHABLE_KINDS:
            continue
        existing = _variant_named(b["id"], tid)
        _repo.enqueue_write(
            _repo.MID,
            _repo.UpsertLlmVariantOp(
                block_id=b["id"], text=b.get("text") or "", variant_name=tid,
                variant_id=(existing["id"] if existing else None),
            ),
        ).result(timeout=5)

    _settings.put_custom_template(tid, {"disabled_block_ids": disabled_ids})
    _settings.set_active_template(tid)
    return list_templates()


def delete_template(name: str) -> Dict[str, Any]:
    """Drop a user template: every variant of that name, plus its settings entry.

    A block's last variant cannot be deleted (the repo refuses) — such a block is simply
    left alone, since removing it would leave the block with no text at all.
    """
    tid = str(name or "").strip()
    if tid in TEMPLATES:
        raise ValueError("built-in templates cannot be deleted")
    for b in _repo.get_llm_blocks():
        v = _variant_named(b["id"], tid)
        if v is None:
            continue
        try:
            _repo.enqueue_write(
                _repo.MID, _repo.DeleteLlmVariantOp(variant_id=v["id"])
            ).result(timeout=5)
        except Exception:
            logger.warning("could not delete variant '%s' of block %s", tid, b["id"])
    _settings.drop_custom_template(tid)
    if _settings.get_active_template() == tid:
        _settings.set_active_template("default")
    return list_templates()


def tool_gate() -> Dict[str, bool]:
    """Which tools the CURRENT block set allows: a tool is on only when its doc block is.

    A missing block (an install that never had one) counts as allowed, so this can only
    ever withhold a tool the user explicitly switched off — never grant one.
    """
    try:
        by_kind = {b.get("kind"): b for b in _repo.get_llm_blocks()}
    except Exception:
        return {k: True for k in _TOOL_BLOCK_KIND}
    gate = {}
    for tool, kind in _TOOL_BLOCK_KIND.items():
        b = by_kind.get(kind)
        gate[tool] = True if b is None else bool(b.get("enabled"))
    return gate
