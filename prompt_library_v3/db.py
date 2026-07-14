"""Prompt Library V3 — SQLite schema, PRAGMAs, forward-only migrations (spec §5.7).

DB file: prompt_library_v3_data/plv3.db

The library is a *creation-time aid only*: compilation never reads it (spec §4.7).
Nothing here is on the execution path.

Tables (v1):
  folders  — the tree of folders
  groups   — library groups.  parent_group_id non-null = a "true subgroup", owned by
             its parent and deleted with it (spec §5.1)
  items    — a group's contents.  kind: prompt | lora | ref.  A ref points at any
             other group — that is *sharing*, as opposed to a subgroup's *ownership*
  presets  — an enable whitelist + order + settings, snapshotted (spec §5.4)

Note what is NOT here: an item's enabled flag.  "The text is the truth" (spec §5.2)
— an item is enabled iff it appears in the document, so storing it would create a
second source of truth, which is exactly the trap PLv2 fell into.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Callable, Dict, Union

__all__ = ["connect_read", "connect_write", "migrate", "MIGRATIONS", "SCHEMA_VERSION"]

_MMAP_BYTES = 256 * 1024 * 1024
_BUSY_TIMEOUT_MS = 5000

_PathLike = Union[str, Path]


def _apply_pragmas(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA temp_store = MEMORY")
    conn.execute(f"PRAGMA mmap_size = {_MMAP_BYTES}")
    conn.execute(f"PRAGMA busy_timeout = {_BUSY_TIMEOUT_MS}")
    conn.execute("PRAGMA foreign_keys = ON")


def connect_read(path: _PathLike) -> sqlite3.Connection:
    """A short-lived read connection.  WAL allows many at once."""
    conn = sqlite3.connect(str(path))
    _apply_pragmas(conn)
    conn.row_factory = sqlite3.Row
    return conn


def connect_write(path: _PathLike) -> sqlite3.Connection:
    """The single writer's connection.  Only WriteQueue may hold one."""
    conn = sqlite3.connect(str(path), isolation_level=None)
    _apply_pragmas(conn)
    conn.row_factory = sqlite3.Row
    return conn


def _v1(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE folders (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            parent_id  INTEGER REFERENCES folders(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            sort_index INTEGER NOT NULL DEFAULT 0,
            UNIQUE(parent_id, name)
        );

        CREATE TABLE groups (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            folder_id       INTEGER REFERENCES folders(id) ON DELETE CASCADE,
            parent_group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
            name            TEXT NOT NULL,
            sort_index      INTEGER NOT NULL DEFAULT 0,
            polarity        TEXT NOT NULL DEFAULT 'positive',
            settings_json   TEXT NOT NULL DEFAULT '{}',
            UNIQUE(folder_id, parent_group_id, name)
        );

        CREATE TABLE items (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id     INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            kind         TEXT NOT NULL DEFAULT 'prompt',
            sort_index   INTEGER NOT NULL DEFAULT 0,
            text         TEXT NOT NULL DEFAULT '',
            ref_group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
            weight       REAL
        );

        CREATE TABLE presets (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            sort_index INTEGER NOT NULL DEFAULT 0,
            body_json  TEXT NOT NULL DEFAULT '{}',
            UNIQUE(group_id, name)
        );

        CREATE INDEX idx_groups_folder ON groups(folder_id);
        CREATE INDEX idx_groups_parent ON groups(parent_group_id);
        CREATE INDEX idx_items_group    ON items(group_id);
        CREATE INDEX idx_items_ref      ON items(ref_group_id);
        CREATE INDEX idx_presets_group  ON presets(group_id);
        """
    )
    _item_uniques(conn)


def _item_uniques(conn: sqlite3.Connection) -> None:
    """The two identities an item can have.

    Spec §5.3 makes an item's *text* how a line in the document is matched back to
    its row, so text must be unique in a group — but that only applies to items that
    HAVE text.  A ref's text is empty and its identity is the group it points at, so
    a plain UNIQUE(group_id, text) would let a group hold only one reference.
    """
    conn.executescript(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_items_text
            ON items(group_id, text) WHERE kind <> 'ref';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_items_refunique
            ON items(group_id, ref_group_id) WHERE kind = 'ref';
        """
    )


def _v2(conn: sqlite3.Connection) -> None:
    """Rebuild `items` without the table-level UNIQUE(group_id, text).

    SQLite cannot drop a table constraint in place, so the table is recreated.  See
    `_item_uniques` for why the constraint had to become partial.
    """
    conn.executescript(
        """
        PRAGMA foreign_keys = OFF;
        CREATE TABLE items_new (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id     INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            kind         TEXT NOT NULL DEFAULT 'prompt',
            sort_index   INTEGER NOT NULL DEFAULT 0,
            text         TEXT NOT NULL DEFAULT '',
            ref_group_id INTEGER REFERENCES groups(id) ON DELETE CASCADE,
            weight       REAL
        );
        INSERT INTO items_new(id, group_id, kind, sort_index, text, ref_group_id, weight)
            SELECT id, group_id, kind, sort_index, text, ref_group_id, weight FROM items;
        DROP TABLE items;
        ALTER TABLE items_new RENAME TO items;
        CREATE INDEX IF NOT EXISTS idx_items_group ON items(group_id);
        CREATE INDEX IF NOT EXISTS idx_items_ref   ON items(ref_group_id);
        PRAGMA foreign_keys = ON;
        """
    )
    _item_uniques(conn)


MIGRATIONS: Dict[int, Callable[[sqlite3.Connection], None]] = {1: _v1, 2: _v2}
SCHEMA_VERSION: int = max(MIGRATIONS)


def migrate(conn: sqlite3.Connection) -> int:
    """Forward-execute pending migrations.  Never rewrites history."""
    current = conn.execute("PRAGMA user_version").fetchone()[0]
    if current > SCHEMA_VERSION:
        raise RuntimeError(
            f"plv3.db is at schema v{current}, newer than this build knows "
            f"(max={SCHEMA_VERSION}); refusing to open."
        )
    for version in sorted(MIGRATIONS):
        if version <= current:
            continue
        MIGRATIONS[version](conn)
        conn.execute(f"PRAGMA user_version = {version}")
    return SCHEMA_VERSION
