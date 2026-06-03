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
from . import settings as _settings
from .defaults import DEFAULT_BLOCKS

logger = logging.getLogger("xyz.llm.store")


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
                    kind=kind, name=name, text=text, enabled=enabled,
                    order_index=order_index, keep_turns=keep_turns,
                ),
            ).result(timeout=5)
        _settings.mark_seeded()
        logger.info("LLM default preset seeded (%d blocks)", len(DEFAULT_BLOCKS))
    except Exception:
        logger.exception("LLM default seed failed")


# --- read pass-throughs (so routes import one module) -----------------------

def get_blocks() -> List[Dict[str, Any]]:
    return _repo.get_llm_blocks()


def get_variants(block_id: int) -> List[Dict[str, Any]]:
    return _repo.get_block_variants(block_id)


def get_conversations() -> List[Dict[str, Any]]:
    return _repo.get_conversations()


def get_messages(conversation_id: int) -> List[Dict[str, Any]]:
    return _repo.get_messages(conversation_id)
