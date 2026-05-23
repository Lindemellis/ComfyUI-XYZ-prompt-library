"""Prompt Library V2 — SQLite schema, PRAGMAs, and forward-only migrations.

Completely isolated from the v1 prompt_library/ JSON system.
DB file lives at: prompt_library_v2_data/plv2.db

Tables (v1):
  nodes            — unified tree: both class-folder nodes and entry nodes
  prompts          — individual prompt items within an entry
  triggers         — auto-computed and user-defined trigger names
  template_slots   — Phase 2: class folder template slot definitions
  template_prompts — Phase 2: default prompts per template slot
  common_formats   — shared format strings (global, all entries)
  common_delimiters — shared delimiter strings (global, two built-ins)
"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path
from typing import Callable, Dict, Union

__all__ = [
    "connect_read",
    "connect_write",
    "migrate",
    "MIGRATIONS",
    "SCHEMA_VERSION",
]


# ---------------------------------------------------------------------------
# PRAGMAs
# ---------------------------------------------------------------------------

_MMAP_BYTES = 256 * 1024 * 1024
_BUSY_TIMEOUT_MS = 5000


def _apply_pragmas(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA temp_store = MEMORY")
    conn.execute(f"PRAGMA mmap_size = {_MMAP_BYTES}")
    conn.execute(f"PRAGMA busy_timeout = {_BUSY_TIMEOUT_MS}")
    conn.execute("PRAGMA foreign_keys = ON")


# ---------------------------------------------------------------------------
# Connection factories
# ---------------------------------------------------------------------------

_PathLike = Union[str, Path]


def connect_read(path: _PathLike) -> sqlite3.Connection:
    """Open a short-lived read connection. WAL allows many concurrently."""
    conn = sqlite3.connect(str(path))
    _apply_pragmas(conn)
    conn.row_factory = sqlite3.Row
    return conn


def connect_write(path: _PathLike) -> sqlite3.Connection:
    """Open the exclusive writer-side connection.

    isolation_level=None → autocommit mode so the WriteQueue owns
    BEGIN/COMMIT boundaries explicitly (one operation per transaction).
    """
    conn = sqlite3.connect(str(path), isolation_level=None)
    _apply_pragmas(conn)
    return conn


# ---------------------------------------------------------------------------
# Schema v1
# ---------------------------------------------------------------------------

_V1_DDL = """
-- Unified tree: a node is simultaneously a class-folder (has_template=1)
-- and/or a prompt entry (has_prompts=1). parent_id=NULL means root level.
--
-- full_path is a denormalized dot-joined path, e.g. "character.blue_archive.toki".
-- It is kept in sync with the tree on every rename/move (one UPDATE...WHERE
-- full_path LIKE 'old_prefix%' covers the entire subtree).
--
-- random_mode controls how enabled prompts are sampled at generation time:
--   'none'    → all enabled prompts included
--   'select'  → pick select_min..select_max enabled prompts at random
--   'dropout' → each enabled prompt dropped independently at dropout_rate

CREATE TABLE IF NOT EXISTS nodes (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_id    INTEGER REFERENCES nodes(id) ON DELETE CASCADE,
    name         TEXT    NOT NULL,
    full_path    TEXT    NOT NULL UNIQUE,
    has_template INTEGER NOT NULL DEFAULT 0,
    has_prompts  INTEGER NOT NULL DEFAULT 1,
    pos_neg      TEXT    NOT NULL DEFAULT 'positive'
                         CHECK(pos_neg IN ('positive', 'negative', 'both')),
    shuffle      INTEGER NOT NULL DEFAULT 0,
    random_mode  TEXT    NOT NULL DEFAULT 'none'
                         CHECK(random_mode IN ('none', 'select', 'dropout')),
    select_min   INTEGER NOT NULL DEFAULT 1,
    select_max   INTEGER NOT NULL DEFAULT 1,
    dropout_rate REAL    NOT NULL DEFAULT 0.0,
    format       TEXT    NOT NULL DEFAULT '',
    delimiter    TEXT    NOT NULL DEFAULT ', ',
    order_index  INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nodes_parent    ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_full_path ON nodes(full_path);
CREATE INDEX IF NOT EXISTS idx_nodes_pos_neg   ON nodes(pos_neg);

-- Individual prompt items within an entry.
-- source='template' → locked (cannot be deleted via UI, only enabled/disabled).
-- source='custom'   → fully editable by the user.
-- Template-sourced prompts are written when Phase 2 auto-creates sub-entries
-- from class folder templates; in Phase 1 they can also be set manually.

CREATE TABLE IF NOT EXISTS prompts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id     INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    content     TEXT    NOT NULL,
    weight      REAL    NOT NULL DEFAULT 1.0,
    enabled     INTEGER NOT NULL DEFAULT 1,
    order_index INTEGER NOT NULL DEFAULT 0,
    source      TEXT    NOT NULL DEFAULT 'custom'
                        CHECK(source IN ('template', 'custom')),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_prompts_node_order ON prompts(node_id, order_index);

-- Trigger names: the short aliases users type inside [brackets] in node text.
--
-- is_auto=1 → computed by the trigger disambiguation engine (read-only in UI).
--             Recalculated on every create/rename/delete of any node.
-- is_auto=0 → manually added by the user (e.g. "tk" for "character.toki").
--
-- trigger_text UNIQUE enforces the no-ambiguity invariant across the entire library.
-- When disambiguation fails (two entries would share the same auto trigger),
-- the engine extends both auto triggers to the next longer suffix.

CREATE TABLE IF NOT EXISTS triggers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id      INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    trigger_text TEXT    NOT NULL UNIQUE,
    is_auto      INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_triggers_node ON triggers(node_id);
CREATE INDEX IF NOT EXISTS idx_triggers_text ON triggers(trigger_text);

-- Phase 2: class folder template slot definitions.
-- sub_name_template uses "{name}" as placeholder for the entry name,
-- e.g. "{name}.appearance" → "toki.appearance" for entry "toki".
-- Populated in Phase 2; schema is created now to avoid a later migration.

CREATE TABLE IF NOT EXISTS template_slots (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    folder_node_id    INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    sub_name_template TEXT    NOT NULL,
    order_index       INTEGER NOT NULL DEFAULT 0,
    created_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_template_slots_folder ON template_slots(folder_node_id);

-- Phase 2: default prompts for each template slot.
-- These are copied (with source='template') into sub-entries when auto-creation runs.

CREATE TABLE IF NOT EXISTS template_prompts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    template_slot_id INTEGER NOT NULL REFERENCES template_slots(id) ON DELETE CASCADE,
    content          TEXT    NOT NULL,
    weight           REAL    NOT NULL DEFAULT 1.0,
    enabled          INTEGER NOT NULL DEFAULT 1,
    order_index      INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_template_prompts_slot ON template_prompts(template_slot_id);

-- User-defined format strings shared across all entries.
-- use_count is incremented each time a format is applied to a node,
-- used to sort the dropdown by recency/popularity.

CREATE TABLE IF NOT EXISTS common_formats (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    format     TEXT    NOT NULL UNIQUE,
    use_count  INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);

-- Built-in delimiters: ', ' and '. ' cannot be deleted (is_builtin=1).
-- Additional delimiters added by the user have is_builtin=0.

CREATE TABLE IF NOT EXISTS common_delimiters (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    delimiter  TEXT    NOT NULL UNIQUE,
    use_count  INTEGER NOT NULL DEFAULT 0,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
"""

_V1_SEED = """
INSERT OR IGNORE INTO common_delimiters (delimiter, use_count, is_builtin, created_at)
VALUES (', ', 0, 1, {ts}), ('. ', 0, 1, {ts});
"""


def _migrate_v1(conn: sqlite3.Connection) -> None:
    conn.executescript(_V1_DDL)
    conn.executescript(_V1_SEED.format(ts=int(time.time())))


# ---------------------------------------------------------------------------
# Migration framework (mirrors gallery/db.py)
# ---------------------------------------------------------------------------

MIGRATIONS: Dict[int, Callable[[sqlite3.Connection], None]] = {
    1: _migrate_v1,
}

SCHEMA_VERSION: int = max(MIGRATIONS)


def migrate(conn: sqlite3.Connection) -> None:
    """Bring conn up to SCHEMA_VERSION by forward-executing pending migrations.

    Uses PRAGMA user_version as the current schema level.
    Raises if the DB is newer than this build (refuse silent downgrade).
    """
    (current,) = conn.execute("PRAGMA user_version").fetchone()
    if current > SCHEMA_VERSION:
        raise RuntimeError(
            f"plv2.db user_version={current} is newer than this build "
            f"(max known={SCHEMA_VERSION}); refusing to open."
        )
    for version in sorted(MIGRATIONS):
        if version <= current:
            continue
        MIGRATIONS[version](conn)
        conn.execute(f"PRAGMA user_version = {version}")
        conn.commit()
