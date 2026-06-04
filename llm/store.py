"""LLM block / conversation persistence — a thin layer over the shared PLv2 repo.

All writes go through the existing PLv2 WriteQueue (repo.enqueue_write); reads use the
PLv2 short-lived read connections. Block text lives only in variants (see schema v7).
This module adds the one-time default-preset seeding on top of those primitives.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List

try:  # runtime: llm is a subpackage of the custom-node root
    from ..prompt_library_v2 import repo as _repo
except ImportError:  # standalone (tests with the repo root on sys.path)
    from prompt_library_v2 import repo as _repo
import hashlib

from . import settings as _settings
from .defaults import (
    DEFAULT_BLOCKS, ANIMA_BLOCKS, ANIMA_VARIANT_NAME, _WEBSEARCH, reflow,
    ANIMA_PRESET_VERSION, ANIMA_PRIOR_HASHES,
)

logger = logging.getLogger("xyz.llm.store")

# kind -> the originally-authored (hard-wrapped) default-variant text, used both as the
# seed source and as the "unedited" baseline the reflow migration compares against.
_DEFAULT_TEXT_BY_KIND = {kind: text for (kind, _name, text, _en, _kt) in DEFAULT_BLOCKS}


def seed_defaults_if_needed() -> None:
    """Seed the default blocks exactly once (guarded by the settings `seeded` flag).

    Uses the settings flag rather than a row count so a user who deliberately clears
    all blocks is never re-seeded on the next start.
    """
    if _settings.is_seeded():
        return
    if _repo.count_llm_blocks() > 0:
        # Pre-existing blocks (e.g. seeded before the flag existed) — adopt, don't duplicate.
        _settings.mark_seeded()
        return
    try:
        for order_index, (kind, name, text, enabled, keep_turns) in enumerate(DEFAULT_BLOCKS):
            _repo.enqueue_write(
                _repo.MID,
                _repo.CreateLlmBlockOp(
                    kind=kind, name=name, text=reflow(text), enabled=enabled,
                    order_index=order_index, keep_turns=keep_turns,
                ),
            ).result(timeout=5)
        _settings.mark_seeded()
        logger.info("LLM default preset seeded (%d blocks)", len(DEFAULT_BLOCKS))
    except Exception:
        logger.exception("LLM default seed failed")


def seed_anima_variants_if_needed() -> None:
    """Additively seed the Anima preset (once, guarded by the `anima_seeded` flag).

    Two idempotent steps that never overwrite the user's content:
      1. Ensure a `web_search` block exists (older installs were seeded before it
         was added to DEFAULT_BLOCKS) — created right after the `tooldoc` block.
      2. For every text block whose kind is in ANIMA_BLOCKS, add an "anima" variant
         (if it doesn't already exist). The active variant is left unchanged, so the
         user opts in by switching the block's variant dropdown to "anima".

    Guarded by the settings flag so a user who deletes anima variants is not re-seeded.
    """
    if _settings.is_anima_seeded():
        return
    try:
        blocks = _repo.get_llm_blocks()
        # 1) ensure the web_search block exists
        if not any(b.get("kind") == "web_search" for b in blocks):
            # slot it just after tooldoc (fallback: end of the list), pushing any
            # trailing blocks (base_prompt / user_request) down so ordering stays clean.
            tooldoc = next((b for b in blocks if b.get("kind") == "tooldoc"), None)
            order = (tooldoc["order_index"] + 1) if tooldoc else len(blocks)
            for other in blocks:
                if other["order_index"] >= order:
                    _repo.enqueue_write(
                        _repo.MID,
                        _repo.UpdateLlmBlockOp(block_id=other["id"], order_index=other["order_index"] + 1),
                    ).result(timeout=5)
            _repo.enqueue_write(
                _repo.MID,
                _repo.CreateLlmBlockOp(
                    kind="web_search", name="Web search tool", text=reflow(_WEBSEARCH),
                    enabled=True, order_index=order, variant_name="default",
                ),
            ).result(timeout=5)
            blocks = _repo.get_llm_blocks()  # refresh so the new block gets its anima variant

        # 2) add the "anima" variant to each matching block, if absent
        for b in blocks:
            text = ANIMA_BLOCKS.get(b.get("kind"))
            if text is None:
                continue
            existing = _repo.get_block_variants(b["id"])
            if any((v.get("variant_name") or "") == ANIMA_VARIANT_NAME for v in existing):
                continue
            _repo.enqueue_write(
                _repo.MID,
                _repo.UpsertLlmVariantOp(
                    block_id=b["id"], text=reflow(text), variant_name=ANIMA_VARIANT_NAME,
                ),
            ).result(timeout=5)

        _settings.mark_anima_seeded()
        logger.info("LLM anima preset seeded (variants + web_search block)")
    except Exception:
        logger.exception("LLM anima seed failed")


def reflow_existing_presets_if_needed() -> None:
    """One-time: reflow the hard-wrapped text of already-seeded preset variants so copied
    text is clean and the display wraps to width.

    Only rewrites a variant whose text still EXACTLY equals the originally-authored
    (hard-wrapped) baseline — i.e. the user has not edited it — so manual edits are never
    clobbered. Guarded by the `preset_reflowed` settings flag.
    """
    if _settings.is_preset_reflowed():
        return
    try:
        for b in _repo.get_llm_blocks():
            kind = b.get("kind")
            for v in _repo.get_block_variants(b["id"]):
                name = v.get("variant_name") or ""
                if name == ANIMA_VARIANT_NAME:
                    baseline = ANIMA_BLOCKS.get(kind)
                else:
                    baseline = _DEFAULT_TEXT_BY_KIND.get(kind)
                if not baseline:
                    continue
                new_text = reflow(baseline)
                if v.get("text") == baseline and new_text != baseline:
                    _repo.enqueue_write(
                        _repo.MID,
                        _repo.UpsertLlmVariantOp(
                            block_id=b["id"], text=new_text,
                            variant_name=name or "default", variant_id=v["id"],
                        ),
                    ).result(timeout=5)
        _settings.mark_preset_reflowed()
        logger.info("LLM preset texts reflowed (unedited variants only)")
    except Exception:
        logger.exception("LLM preset reflow failed")


def _hash16(s: str) -> str:
    return hashlib.sha256((s or "").encode("utf-8")).hexdigest()[:16]


def sync_anima_preset_if_outdated() -> None:
    """Refresh already-seeded anima variants when the authored text was edited in place
    (ANIMA_PRESET_VERSION bumped) — but only for UNEDITED variants, detected by hashing the
    current text against the known prior authored forms in ANIMA_PRIOR_HASHES.

    User edits (which won't match any known hash) are left untouched. Idempotent: once the
    stored version reaches the current one, this is a no-op.
    """
    if _settings.get_anima_preset_version() >= ANIMA_PRESET_VERSION:
        return
    try:
        for b in _repo.get_llm_blocks():
            kind = b.get("kind")
            priors = ANIMA_PRIOR_HASHES.get(kind)
            if not priors:
                continue
            desired = reflow(ANIMA_BLOCKS[kind])
            for v in _repo.get_block_variants(b["id"]):
                if (v.get("variant_name") or "") != ANIMA_VARIANT_NAME:
                    continue
                cur = v.get("text") or ""
                if cur != desired and _hash16(cur) in priors:
                    _repo.enqueue_write(
                        _repo.MID,
                        _repo.UpsertLlmVariantOp(
                            block_id=b["id"], text=desired,
                            variant_name=ANIMA_VARIANT_NAME, variant_id=v["id"],
                        ),
                    ).result(timeout=5)
        _settings.set_anima_preset_version(ANIMA_PRESET_VERSION)
        logger.info("LLM anima preset synced to v%d (unedited variants only)", ANIMA_PRESET_VERSION)
    except Exception:
        logger.exception("LLM anima preset sync failed")


# --- read pass-throughs (so routes import one module) -----------------------

def get_blocks() -> List[Dict[str, Any]]:
    return _repo.get_llm_blocks()


def get_variants(block_id: int) -> List[Dict[str, Any]]:
    return _repo.get_block_variants(block_id)


def get_conversations() -> List[Dict[str, Any]]:
    return _repo.get_conversations()


def get_messages(conversation_id: int) -> List[Dict[str, Any]]:
    return _repo.get_messages(conversation_id)
