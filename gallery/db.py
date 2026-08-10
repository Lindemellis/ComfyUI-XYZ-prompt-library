"""XYZ Image Gallery — SQLite schema, PRAGMAs, and forward-only migrations (T03).

Scope (per TASKS.md T03):
  * Opinionated PRAGMA setup (WAL / NORMAL / MEMORY / 256 MiB mmap / 5 s busy_timeout)
    applied uniformly to both read and write connections.
  * Version-gated forward-only migration framework keyed on ``PRAGMA user_version``.
  * ``MIGRATIONS[1]`` creates the ``folder`` + ``image`` tables and all indexes
    listed in ``PROJECT_SPEC §6.1``.

Out of scope (intentionally deferred, per AI_RULES R1.2 / R6.3 / R6.4):
  * ``image_fts`` + FTS5 tokenizer declaration — T28
  * WriteQueue internals beyond migrations — T04
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Callable, Dict, Union

from . import folder_header as _folder_header

__all__ = [
    "connect_read",
    "connect_write",
    "migrate",
    "MIGRATIONS",
    "SCHEMA_VERSION",
]


# -- PRAGMA -----------------------------------------------------------------

_MMAP_BYTES = 256 * 1024 * 1024
_BUSY_TIMEOUT_MS = 5000


def _register_sqlite_functions(conn: sqlite3.Connection) -> None:
    """Per-connection helpers (folder sort label, etc.)."""
    conn.create_function(
        "xyz_folder_line_header",
        3,
        _folder_header.folder_line_header_value_sql,
    )


def _apply_pragmas(conn: sqlite3.Connection) -> None:
    # Order matters: WAL must be set before heavy reads/writes touch the file.
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA temp_store = MEMORY")
    conn.execute(f"PRAGMA mmap_size = {_MMAP_BYTES}")
    conn.execute(f"PRAGMA busy_timeout = {_BUSY_TIMEOUT_MS}")


# -- Connection factories ---------------------------------------------------

_PathLike = Union[str, Path]


def connect_read(path: _PathLike) -> sqlite3.Connection:
    """Open a short-lived read connection. WAL allows many of these concurrently."""
    conn = sqlite3.connect(str(path))
    _apply_pragmas(conn)
    conn.row_factory = sqlite3.Row
    _register_sqlite_functions(conn)
    return conn


def connect_write(path: _PathLike) -> sqlite3.Connection:
    """Open an exclusive writer-side connection.

    ``isolation_level=None`` puts sqlite3 in autocommit mode so the future
    single-writer loop (T04) can own ``BEGIN`` / ``COMMIT`` boundaries
    explicitly (one op per transaction, per ARCHITECTURE §4.6).
    """
    conn = sqlite3.connect(str(path), isolation_level=None)
    _apply_pragmas(conn)
    _register_sqlite_functions(conn)
    return conn


# -- Schema v1 --------------------------------------------------------------

# NOTE: every DDL uses IF NOT EXISTS so that forcing ``PRAGMA user_version=0``
# and restarting re-runs the migration idempotently (TASKS.md T03 test #3).
_V1_DDL = """
CREATE TABLE IF NOT EXISTS folder (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    path          TEXT UNIQUE NOT NULL,
    kind          TEXT NOT NULL,
    parent_id     INTEGER REFERENCES folder(id),
    display_name  TEXT,
    removable     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS image (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    path              TEXT UNIQUE NOT NULL,
    folder_id         INTEGER REFERENCES folder(id),
    relative_path     TEXT NOT NULL,
    filename          TEXT NOT NULL,
    filename_lc       TEXT NOT NULL,
    ext               TEXT NOT NULL,
    width             INTEGER,
    height            INTEGER,
    file_size         INTEGER,
    mtime_ns          INTEGER,
    created_at        INTEGER,
    content_hash      TEXT,
    positive_prompt   TEXT,
    negative_prompt   TEXT,
    model             TEXT,
    seed              INTEGER,
    cfg               REAL,
    sampler           TEXT,
    scheduler         TEXT,
    workflow_present  INTEGER,
    favorite          INTEGER,
    tags_csv          TEXT,
    indexed_at        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_image_folder_rel    ON image(folder_id, relative_path);
CREATE INDEX IF NOT EXISTS idx_image_filename_lc   ON image(filename_lc);
CREATE INDEX IF NOT EXISTS idx_image_model         ON image(model);
CREATE INDEX IF NOT EXISTS idx_image_favorite      ON image(favorite);
CREATE INDEX IF NOT EXISTS idx_image_created_at    ON image(created_at);
CREATE INDEX IF NOT EXISTS idx_image_file_size     ON image(file_size);
CREATE INDEX IF NOT EXISTS idx_image_mtime_ns      ON image(mtime_ns);
"""


def _migrate_v1(conn: sqlite3.Connection) -> None:
    conn.executescript(_V1_DDL)


# -- Schema v2 (T08) --------------------------------------------------------

# ``thumbnail_cache`` is the authoritative LRU index for the on-disk .webp
# shards under ``gallery_data/thumbs/`` (SPEC §6.1, §8.3). The ``.webp``
# files are treated as a materialisation of the rows here; a daily janitor
# (T26) reconciles drift. ON DELETE CASCADE on ``image_id`` means deleting
# an image row automatically prunes its thumb-cache bookkeeping, but the
# physical .webp still needs the janitor (§8.3 "two-way reconciliation").
_V2_DDL = """
CREATE TABLE IF NOT EXISTS thumbnail_cache (
    hash_key       TEXT PRIMARY KEY,
    image_id       INTEGER NOT NULL REFERENCES image(id) ON DELETE CASCADE,
    size_bytes     INTEGER NOT NULL,
    created_at     INTEGER NOT NULL,
    last_accessed  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_thumb_last_accessed ON thumbnail_cache(last_accessed);
CREATE INDEX IF NOT EXISTS idx_thumb_image_id      ON thumbnail_cache(image_id);
"""


def _migrate_v2(conn: sqlite3.Connection) -> None:
    conn.executescript(_V2_DDL)


# -- Schema v3 (T15) — tag / prompt_token vocab ----------------------------

_V3_DDL = """
CREATE TABLE IF NOT EXISTS tag (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL COLLATE NOCASE UNIQUE,
    usage_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS image_tag (
    image_id      INTEGER NOT NULL REFERENCES image(id) ON DELETE CASCADE,
    tag_id        INTEGER NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
    PRIMARY KEY (image_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_image_tag_tag ON image_tag(tag_id, image_id);

CREATE TABLE IF NOT EXISTS prompt_token (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    token         TEXT NOT NULL COLLATE NOCASE UNIQUE,
    usage_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS image_prompt_token (
    image_id      INTEGER NOT NULL REFERENCES image(id) ON DELETE CASCADE,
    token_id      INTEGER NOT NULL REFERENCES prompt_token(id) ON DELETE CASCADE,
    PRIMARY KEY (image_id, token_id)
);

CREATE INDEX IF NOT EXISTS idx_image_prompt_token_token ON image_prompt_token(token_id, image_id);
"""


def _migrate_v3(conn: sqlite3.Connection) -> None:
    conn.executescript(_V3_DDL)


# -- Schema v4 (T16) — metadata sync bookkeeping + row ``version`` ---------

def _migrate_v4(conn: sqlite3.Connection) -> None:
    """Append ``metadata_sync_*`` / ``version`` columns + partial sync index."""
    cols = {
        row[1]
        for row in conn.execute("PRAGMA table_info(image)")
    }
    if "metadata_sync_status" not in cols:
        conn.execute(
            "ALTER TABLE image ADD COLUMN metadata_sync_status TEXT DEFAULT 'ok'"
        )
    if "metadata_sync_retry_count" not in cols:
        conn.execute(
            "ALTER TABLE image ADD COLUMN metadata_sync_retry_count INTEGER DEFAULT 0"
        )
    if "metadata_sync_next_retry_at" not in cols:
        conn.execute(
            "ALTER TABLE image ADD COLUMN metadata_sync_next_retry_at INTEGER"
        )
    if "metadata_sync_last_error" not in cols:
        conn.execute(
            "ALTER TABLE image ADD COLUMN metadata_sync_last_error TEXT"
        )
    if "version" not in cols:
        conn.execute(
            "ALTER TABLE image ADD COLUMN version INTEGER NOT NULL DEFAULT 0"
        )
    # Explicit backfill for pre-existing rows (TASKS.md T16).
    conn.execute(
        "UPDATE image SET "
        "metadata_sync_status = 'ok', "
        "metadata_sync_retry_count = 0, "
        "metadata_sync_next_retry_at = NULL, "
        "metadata_sync_last_error = NULL, "
        "version = 0"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_image_sync "
        "ON image(metadata_sync_status) "
        "WHERE metadata_sync_status != 'ok'"
    )


def _migrate_v5(conn: sqlite3.Connection) -> None:
    """Unify ``image.model`` by stripping known checkpoint filename extensions."""
    # Relative import: under ComfyUI the package is ``…ComfyUI-XYZNodes.gallery``,
    # not top-level ``gallery`` (absolute ``from gallery.vocab`` breaks startup).
    from .vocab import normalize_stored_model

    rows = conn.execute(
        "SELECT id, model FROM image WHERE model IS NOT NULL AND TRIM(model) != ''",
    ).fetchall()
    for row in rows:
        img_id = int(row[0])
        raw = str(row[1])
        canon = normalize_stored_model(raw)
        if canon is None:
            continue
        if canon != raw.strip():
            conn.execute(
                "UPDATE image SET model = ? WHERE id = ?",
                (canon, img_id),
            )


# -- Schema v6 — §11 F04 word-mode lexeme vocab (parallel to ``prompt_token``) --

_V6_DDL = """
CREATE TABLE IF NOT EXISTS word_token (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    token         TEXT NOT NULL COLLATE NOCASE UNIQUE,
    usage_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS image_word_token (
    image_id      INTEGER NOT NULL REFERENCES image(id) ON DELETE CASCADE,
    token_id      INTEGER NOT NULL REFERENCES word_token(id) ON DELETE CASCADE,
    PRIMARY KEY (image_id, token_id)
);

CREATE INDEX IF NOT EXISTS idx_image_word_token_token
    ON image_word_token(token_id, image_id);
"""


def _migrate_v6(conn: sqlite3.Connection) -> None:
    conn.executescript(_V6_DDL)


# -- Schema v7 — the sampler's step count, alongside cfg / sampler / scheduler --


def _migrate_v7(conn: sqlite3.Connection) -> None:
    """Add ``image.steps``.

    Guarded, because a database that has already been through this must not fail
    the whole migration on a duplicate column.

    Rows indexed before this stay NULL: the value lives in the PNG's metadata, not
    in anything we already have, so filling it in means re-reading every file. That
    is what the settings page's "re-read metadata" button is for — a backfill that
    walks the library is not something a schema migration should do behind your back
    while ComfyUI is trying to start.
    """
    columns = {row[1] for row in conn.execute("PRAGMA table_info(image)")}
    if "steps" not in columns:
        conn.execute("ALTER TABLE image ADD COLUMN steps INTEGER")


# -- Schema v8 — video: what kind of media a row is, and its clip properties --


def _migrate_v8(conn: sqlite3.Connection) -> None:
    """Add ``image.media_kind`` + the video-only columns.

    ``media_kind`` is a real column with an index rather than something
    derived from ``ext`` at query time, because the grid's image/video filter
    is a SQL ``WHERE`` on every page of a 2000+ row library and ``ext`` has no
    index.

    Unlike v7 (``steps``), this one needs **no backfill**: every row that
    exists at migration time was indexed under the image-only extension
    whitelist, so the ``'image'`` default is not a guess — it is the answer.
    The video columns stay NULL for them, which is exactly right.
    """
    columns = {row[1] for row in conn.execute("PRAGMA table_info(image)")}
    additions = (
        ("media_kind", "TEXT NOT NULL DEFAULT 'image'"),
        ("duration_ms", "INTEGER"),
        ("fps", "REAL"),
        ("has_audio", "INTEGER"),
        ("vcodec", "TEXT"),
    )
    for name, decl in additions:
        if name not in columns:
            conn.execute(f"ALTER TABLE image ADD COLUMN {name} {decl}")
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_image_media_kind ON image(media_kind)"
    )


# -- Migration framework ----------------------------------------------------

# Forward-only ledger. ``6`` = word_token / image_word_token (§11 F04 word);
# ``7`` = image.steps; ``8`` = media_kind + video columns.
# FTS5 / T28 will append later steps (see module docstring).
MIGRATIONS: Dict[int, Callable[[sqlite3.Connection], None]] = {
    1: _migrate_v1,
    2: _migrate_v2,
    3: _migrate_v3,
    4: _migrate_v4,
    5: _migrate_v5,
    6: _migrate_v6,
    7: _migrate_v7,
    8: _migrate_v8,
}

SCHEMA_VERSION: int = max(MIGRATIONS)


def migrate(conn: sqlite3.Connection) -> None:
    """Bring ``conn`` up to ``SCHEMA_VERSION`` by forward-executing MIGRATIONS.

    * Reads ``PRAGMA user_version`` as the current level.
    * Runs every registered step with ``version > current`` in ascending order.
    * Bumps ``user_version`` after each step (persisted on commit).
    * Raises on a DB that is *newer* than this build knows about, to avoid
      silently downgrading or stepping on unknown schema (C-4).
    """
    (current,) = conn.execute("PRAGMA user_version").fetchone()
    if current > SCHEMA_VERSION:
        raise RuntimeError(
            f"gallery.sqlite user_version={current} is newer than "
            f"this build (max known = {SCHEMA_VERSION}); refusing to downgrade."
        )
    for version in sorted(MIGRATIONS):
        if version <= current:
            continue
        MIGRATIONS[version](conn)
        conn.execute(f"PRAGMA user_version = {version}")
        conn.commit()
