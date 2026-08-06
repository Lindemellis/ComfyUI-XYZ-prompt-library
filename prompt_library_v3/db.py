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

Tables (v3):
  documents — a WHOLE document, stored verbatim: the text and the document JSON.

A group is "a list of items"; a document is an arbitrary tree — region blocks,
schedule blocks, free text between them, several top-level constructs.  Those are
genuinely different shapes, and the second one has no container in v1's model: the
closest you can get is one enormous opaque item.  So a document gets its own table
rather than a distortion of `groups`.

It stores `doc_json` alongside the text because the DOCUMENT is the truth: an item
you switched off is by design nowhere in the text, so a text-only snapshot would
silently drop every disabled item the moment it was saved.

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


def _v3(conn: sqlite3.Connection) -> None:
    """Whole-document snapshots.

    `UNIQUE(folder_id, name)` is deliberately NOT declared: SQLite treats NULLs as
    distinct, so it would silently fail to constrain the root folder — the one place
    a first-time user saves everything.  Identity is enforced in `SaveDocumentOp`
    with an explicit `folder_id IS ?` lookup instead, which the single-writer queue
    makes exact.
    """
    conn.executescript(
        """
        CREATE TABLE documents (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            folder_id  INTEGER REFERENCES folders(id) ON DELETE CASCADE,
            name       TEXT NOT NULL,
            sort_index INTEGER NOT NULL DEFAULT 0,
            text       TEXT NOT NULL DEFAULT '',
            doc_json   TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX idx_documents_folder ON documents(folder_id);
        CREATE INDEX idx_documents_name   ON documents(folder_id, name);
        """
    )


def _remap_body(body: dict, expansion: Dict[int, list]) -> bool:
    """Rewrite one preset body so a split item is still fully selected.

    A preset is a whitelist of item IDs.  When `a. b.` becomes two rows, a preset that
    had the old row must now hold both, in place, or half of what it selected silently
    disappears.  Nested `children` snapshots hold whitelists of OTHER groups' items, so
    this recurses — the ids are globally unique, which is what lets one map serve all
    of them.
    """
    changed = False

    ids = body.get("items")
    if isinstance(ids, list):
        out: list = []
        seen: set = set()
        for raw in ids:
            try:
                old = int(raw)
            except (TypeError, ValueError):
                continue
            for new in expansion.get(old, [old]):
                if new in seen:
                    continue
                seen.add(new)
                out.append(new)
        if out != ids:
            body["items"] = out
            changed = True

    weights = body.get("weights")
    if isinstance(weights, dict) and weights:
        # The weight was the whole item's; every piece it broke into keeps it. Dropping
        # it from the tail pieces would quietly re-weight half of a prompt.
        out_w: dict = {}
        for key, value in weights.items():
            try:
                old = int(key)
            except (TypeError, ValueError):
                out_w[key] = value
                continue
            for new in expansion.get(old, [old]):
                out_w[str(new)] = value
        if out_w != weights:
            body["weights"] = out_w
            changed = True

    for child in (body.get("children") or {}).values():
        if isinstance(child, dict) and _remap_body(child, expansion):
            changed = True
    return changed


def _v4(conn: sqlite3.Connection) -> None:
    """The full stop became an item separator (spec update 2026-08-05).

    Items stored before that hold whole sentences — `a photo of a cat. it sits.` is one
    row where it should now be two.  Split them, keeping the original row as the FIRST
    piece so its id survives, and rewrite every preset whitelist that referred to it.

    A piece whose text a sibling row already has reuses that row: `UNIQUE(group_id,
    text)` is what makes an item's text its identity, and inserting a duplicate would
    fail the whole migration.
    """
    import json as _json

    from . import lexer as lx

    rows = conn.execute(
        "SELECT id, group_id, sort_index, text, weight FROM items "
        "WHERE kind <> 'ref' ORDER BY group_id, sort_index, id"
    ).fetchall()

    by_group: Dict[int, list] = {}
    for r in rows:
        by_group.setdefault(int(r["group_id"]), []).append(r)

    expansion: Dict[int, list] = {}
    for gid, items in by_group.items():
        have = {r["text"]: int(r["id"]) for r in items}
        order: list = []
        touched = False

        for r in items:
            old_id = int(r["id"])
            parts = lx.split_sentences(r["text"])
            if len(parts) <= 1:
                order.append(old_id)
                continue
            touched = True
            ids: list = []
            for index, piece in enumerate(parts):
                twin = have.get(piece)
                if index == 0:
                    if twin is not None and twin != old_id:
                        # The first piece is already a row of its own: this row has
                        # nothing left to be, so it goes and its id maps onto the twin.
                        conn.execute("DELETE FROM items WHERE id = ?", (old_id,))
                        ids.append(twin)
                        continue
                    conn.execute(
                        "UPDATE items SET text = ? WHERE id = ?", (piece, old_id)
                    )
                    have.pop(r["text"], None)
                    have[piece] = old_id
                    ids.append(old_id)
                    continue
                if twin is not None:
                    ids.append(twin)
                    continue
                cur = conn.execute(
                    "INSERT INTO items(group_id, kind, sort_index, text, weight) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (
                        gid,
                        "lora" if piece.startswith("<lora:") else "prompt",
                        0,
                        piece,
                        r["weight"],
                    ),
                )
                new_id = int(cur.lastrowid)
                have[piece] = new_id
                ids.append(new_id)
            expansion[old_id] = ids
            order.extend(ids)

        if not touched:
            continue
        # The pieces sit where the sentence they came from sat. Refs keep their own
        # sort_index, so they are renumbered too — after the prompts, which is where
        # the old numbering already put them relative to each other.
        seen: set = set()
        index = 0
        for item_id in order:
            if item_id in seen:
                continue
            seen.add(item_id)
            conn.execute(
                "UPDATE items SET sort_index = ? WHERE id = ?", (index, item_id)
            )
            index += 1
        for ref in conn.execute(
            "SELECT id FROM items WHERE group_id = ? AND kind = 'ref' ORDER BY sort_index, id",
            (gid,),
        ).fetchall():
            conn.execute(
                "UPDATE items SET sort_index = ? WHERE id = ?", (index, int(ref["id"]))
            )
            index += 1

    if not expansion:
        return
    for prow in conn.execute("SELECT id, body_json FROM presets").fetchall():
        try:
            body = _json.loads(prow["body_json"] or "{}")
        except Exception:  # noqa: BLE001 - a corrupt body is not this migration's to fix
            continue
        if not isinstance(body, dict):
            continue
        if _remap_body(body, expansion):
            conn.execute(
                "UPDATE presets SET body_json = ? WHERE id = ?",
                (_json.dumps(body), int(prow["id"])),
            )


MIGRATIONS: Dict[int, Callable[[sqlite3.Connection], None]] = {
    1: _v1,
    2: _v2,
    3: _v3,
    4: _v4,
}
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
