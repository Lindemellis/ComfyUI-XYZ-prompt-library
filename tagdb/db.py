"""Tag DB — SQLite schema, PRAGMAs, and forward-only migrations.

Used for both the mutable working DB (tagdb_data/tagdb.sqlite) and immutable
snapshot files (tagdb_data/snapshots/{official,local}/*.sqlite); the schema is
identical, only the meta `schema_kind` differs.

Tables:
  meta            — key/value metadata + provenance watermarks (see V2 keys below)
  tags            — name, source, category, post_count, is_deprecated + V2 provenance
  aliases         — antecedent → canonical mapping (+ V2 created_at/synced_at)
  translations    — optional multilingual aliases (lang, text)
  tags_fts        — FTS5 contentless table with trigram tokenizer for substring search
  tag_versions    — (V2) append-only danbooru tag category/deprecation event log
  artist_versions — (V2) append-only danbooru artist-entry event log
  related_tags    — (V2) lazily-cached related-tag results, per query tag

V2 meta watermark keys (see plan §"Provenance / time-binding"):
  schema_kind, origin_official_version, structure_synced_through,
  full_count_synced_at, aliases_synced_through
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Union

__all__ = ["connect_read", "connect_write", "migrate", "SCHEMA_VERSION"]

_MMAP_BYTES = 256 * 1024 * 1024
_BUSY_TIMEOUT_MS = 5000


def _apply_pragmas(conn: sqlite3.Connection) -> None:
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA temp_store = MEMORY")
    conn.execute(f"PRAGMA mmap_size = {_MMAP_BYTES}")
    conn.execute(f"PRAGMA busy_timeout = {_BUSY_TIMEOUT_MS}")


_PathLike = Union[str, Path]


def connect_read(path: _PathLike) -> sqlite3.Connection:
    """Open a short-lived read connection. WAL allows many of these concurrently."""
    conn = sqlite3.connect(str(path))
    _apply_pragmas(conn)
    conn.row_factory = sqlite3.Row
    return conn


def connect_write(path: _PathLike) -> sqlite3.Connection:
    """Open the exclusive writer-side connection (autocommit mode)."""
    conn = sqlite3.connect(str(path), isolation_level=None)
    _apply_pragmas(conn)
    return conn


SCHEMA_VERSION = 2

_V1_DDL = """\
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS tags (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL UNIQUE,
    source        TEXT    NOT NULL DEFAULT 'danbooru',
    category      INTEGER NOT NULL DEFAULT 0,
    post_count    INTEGER NOT NULL DEFAULT 0,
    is_deprecated INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tags_post_count ON tags(post_count DESC);
CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);

CREATE TABLE IF NOT EXISTS aliases (
    alias     TEXT PRIMARY KEY,
    canonical TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_aliases_canonical ON aliases(canonical);

CREATE TABLE IF NOT EXISTS translations (
    tag  TEXT NOT NULL,
    lang TEXT NOT NULL DEFAULT 'ja',
    text TEXT NOT NULL,
    PRIMARY KEY (tag, lang)
);

CREATE VIRTUAL TABLE IF NOT EXISTS tags_fts USING fts5(
    name,
    aliases_text,
    content='',
    tokenize='trigram'
);
"""

# V2 — new event-log + related-cache tables. ADD COLUMN statements are handled
# separately in _migrate_v2 (SQLite has no `ADD COLUMN IF NOT EXISTS`).
_V2_DDL = """\
CREATE TABLE IF NOT EXISTS tag_versions (
    version_id          INTEGER PRIMARY KEY,
    tag_id              INTEGER NOT NULL,
    name                TEXT    NOT NULL,
    category            INTEGER NOT NULL DEFAULT 0,
    is_deprecated       INTEGER NOT NULL DEFAULT 0,
    created_at          INTEGER NOT NULL DEFAULT 0,
    previous_version_id INTEGER,
    synced_at           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tagver_tag_id     ON tag_versions(tag_id);
CREATE INDEX IF NOT EXISTS idx_tagver_created_at ON tag_versions(created_at);

CREATE TABLE IF NOT EXISTS artist_versions (
    version_id   INTEGER PRIMARY KEY,
    artist_id    INTEGER NOT NULL,
    name         TEXT    NOT NULL,
    other_names  TEXT,
    group_name   TEXT,
    urls         TEXT,
    is_banned    INTEGER NOT NULL DEFAULT 0,
    is_deleted   INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL DEFAULT 0,
    synced_at    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_artver_artist_id  ON artist_versions(artist_id);
CREATE INDEX IF NOT EXISTS idx_artver_created_at ON artist_versions(created_at);

CREATE TABLE IF NOT EXISTS related_tags (
    query_tag   TEXT    NOT NULL,
    related_tag TEXT    NOT NULL,
    category    INTEGER NOT NULL DEFAULT 0,
    cosine      REAL,
    jaccard     REAL,
    overlap     REAL,
    rank        INTEGER NOT NULL DEFAULT 0,
    synced_at   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (query_tag, related_tag)
);
CREATE INDEX IF NOT EXISTS idx_related_query ON related_tags(query_tag, rank);
"""

# (table, column, definition) — added one-by-one, skipped if already present.
_V2_COLUMNS = [
    ("tags", "danbooru_id", "INTEGER"),
    ("tags", "created_at", "INTEGER NOT NULL DEFAULT 0"),
    ("tags", "post_count_synced_at", "INTEGER NOT NULL DEFAULT 0"),
    ("tags", "structure_synced_at", "INTEGER NOT NULL DEFAULT 0"),
    ("aliases", "created_at", "INTEGER NOT NULL DEFAULT 0"),
    ("aliases", "synced_at", "INTEGER NOT NULL DEFAULT 0"),
]


def _has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
    return any(r[1] == column for r in rows)


def _migrate_v2(conn: sqlite3.Connection) -> None:
    """Add V2 tables, columns, and backfill provenance watermarks.

    Idempotent: every step guards against pre-existing tables/columns so it is
    safe to run on a partially-migrated file (e.g. the legacy-import path).
    """
    conn.executescript(_V2_DDL)

    for table, column, ddl in _V2_COLUMNS:
        if not _has_column(conn, table, column):
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")

    # Index on danbooru_id must come after the column exists.
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_danbooru_id "
        "ON tags(danbooru_id) WHERE danbooru_id IS NOT NULL"
    )

    # Backfill watermarks for a snapshot migrated from V1: its counts/structure
    # were captured at build time (meta.created_at), so seed every provenance
    # clock to that epoch. Brand-new DBs have no meta.created_at → seed to 0.
    row = conn.execute("SELECT value FROM meta WHERE key = 'created_at'").fetchone()
    base = 0
    if row and str(row[0]).isdigit():
        base = int(row[0])

    conn.execute(
        "UPDATE tags SET post_count_synced_at = ? WHERE post_count_synced_at = 0",
        (base,),
    )
    conn.execute(
        "UPDATE tags SET structure_synced_at = ? WHERE structure_synced_at = 0",
        (base,),
    )
    conn.execute(
        "UPDATE aliases SET synced_at = ? WHERE synced_at = 0",
        (base,),
    )
    for key, value in [
        ("structure_synced_through", str(base)),
        ("full_count_synced_at", str(base)),
        ("aliases_synced_through", str(base)),
    ]:
        conn.execute(
            "INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)", (key, value)
        )


def migrate(conn: sqlite3.Connection) -> None:
    """Apply forward-only migrations. executescript issues an implicit COMMIT first."""
    ver = conn.execute("PRAGMA user_version").fetchone()[0]
    if ver >= SCHEMA_VERSION:
        return
    if ver < 1:
        conn.executescript(_V1_DDL)
    if ver < 2:
        _migrate_v2(conn)
    conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
