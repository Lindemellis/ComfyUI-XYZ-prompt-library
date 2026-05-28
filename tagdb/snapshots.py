"""Tag DB snapshots — build a dated snapshot SQLite file from scraped data.

build_snapshot() is called from routes.py in a background thread when the user
triggers /xyz/tagdb/maintain. It writes directly (no WriteQueue needed — the
build is a one-shot batch, not concurrent per-request writes).
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import date
from pathlib import Path
from typing import Callable, Optional

from . import db as _db
from .scraper import (
    scrape_tags, scrape_aliases, scrape_gelbooru_tags, scrape_gelbooru_aliases,
)

logger = logging.getLogger("xyz.tagdb.snapshots")

__all__ = ["build_snapshot", "build_gelbooru_snapshot", "rebuild_fts"]

_BATCH_SIZE = 500


def build_snapshot(
    data_dir: Path,
    label: str = "danbooru",
    min_post_count: int = 5,
    login: Optional[str] = None,
    api_key: Optional[str] = None,
    progress_cb: Optional[Callable[[str], None]] = None,
    stop_event: Optional[threading.Event] = None,
) -> Path:
    """Scrape danbooru and write a dated snapshot file.

    Returns the path to the new snapshot file.
    Calls progress_cb(message) periodically if provided.
    Checks stop_event to support cancellation.

    Args:
        login:   danbooru login (bypasses Cloudflare 403; free account suffices).
        api_key: danbooru API key matching the login.
    """
    today = date.today().strftime("%Y-%m-%d")
    filename = f"{today}_{label}.sqlite"
    snap_dir = Path(data_dir) / "snapshots"
    snap_dir.mkdir(parents=True, exist_ok=True)
    snap_path = snap_dir / filename

    def _progress(msg: str) -> None:
        logger.info(msg)
        if progress_cb:
            progress_cb(msg)

    auth_note = f" (auth: {login})" if login else " (anonymous — browser-impersonated)"
    _progress(f"Building snapshot{auth_note}: {snap_path}")

    conn = _db.connect_write(snap_path)
    try:
        _db.migrate(conn)

        # --- Tags ---
        _progress("Scraping tags from danbooru...")
        tag_count = 0
        conn.execute("BEGIN")
        for tag in scrape_tags(
            min_post_count=min_post_count,
            login=login,
            api_key=api_key,
            stop_event=stop_event,
        ):
            if stop_event and stop_event.is_set():
                conn.execute("ROLLBACK")
                _progress("Cancelled during tag scrape")
                return snap_path
            conn.execute(
                "INSERT OR REPLACE INTO tags(name, source, category, post_count, is_deprecated)"
                " VALUES (?,?,?,?,?)",
                (tag["name"], "danbooru", tag["category"], tag["post_count"], tag["is_deprecated"]),
            )
            tag_count += 1
            if tag_count % _BATCH_SIZE == 0:
                conn.execute("COMMIT")
                conn.execute("BEGIN")
                _progress(f"Tags scraped: {tag_count:,}")
        conn.execute("COMMIT")
        _progress(f"Tags done: {tag_count:,}")

        # --- Aliases ---
        _progress("Scraping tag aliases from danbooru...")
        alias_count = 0
        conn.execute("BEGIN")
        for alias in scrape_aliases(
            login=login,
            api_key=api_key,
            stop_event=stop_event,
        ):
            if stop_event and stop_event.is_set():
                conn.execute("ROLLBACK")
                _progress("Cancelled during alias scrape")
                return snap_path
            conn.execute(
                "INSERT OR REPLACE INTO aliases(alias, canonical) VALUES (?,?)",
                (alias["alias"], alias["canonical"]),
            )
            alias_count += 1
            if alias_count % _BATCH_SIZE == 0:
                conn.execute("COMMIT")
                conn.execute("BEGIN")
                _progress(f"Aliases scraped: {alias_count:,}")
        conn.execute("COMMIT")
        _progress(f"Aliases done: {alias_count:,}")

        # --- FTS index ---
        _progress("Building FTS index...")
        rebuild_fts(conn)
        _progress("FTS index done")

        # --- Meta ---
        conn.execute("BEGIN")
        for k, v in [
            ("date", today),
            ("label", label),
            ("source", "danbooru"),
            ("created_at", str(int(time.time()))),
            ("tag_count", str(tag_count)),
            ("alias_count", str(alias_count)),
        ]:
            conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?,?)", (k, v))
        conn.execute("COMMIT")

        _progress(f"Snapshot complete: {tag_count:,} tags, {alias_count:,} aliases → {snap_path.name}")
        return snap_path

    except Exception:
        logger.exception("Snapshot build failed")
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        conn.close()


def build_gelbooru_snapshot(
    data_dir: Path,
    label: str = "gelbooru",
    min_post_count: int = 5,
    api_key: Optional[str] = None,
    user_id: Optional[str] = None,
    progress_cb: Optional[Callable[[str], None]] = None,
    stop_event: Optional[threading.Event] = None,
    out_path: Optional[Path] = None,
) -> Path:
    """Scrape gelbooru and write a dated snapshot file (source='gelbooru').

    Mirrors build_snapshot but uses the gelbooru scrapers and leaves the danbooru-only
    event-log tables (tag_versions/artist_versions) empty — gelbooru is current-only
    (no time machine). Tags come from the JSON dapi (needs api_key+user_id); aliases
    from the HTML alias list. Returns the new snapshot path.

    If `out_path` is given (author dist build), writes there; otherwise writes a dated
    file under `data_dir/snapshots/` (in-server build).
    """
    today = date.today().strftime("%Y-%m-%d")
    if out_path is not None:
        snap_path = Path(out_path)
        snap_path.parent.mkdir(parents=True, exist_ok=True)
    else:
        snap_dir = Path(data_dir) / "snapshots"
        snap_dir.mkdir(parents=True, exist_ok=True)
        snap_path = snap_dir / f"{today}_{label}.sqlite"

    def _progress(msg: str) -> None:
        logger.info(msg)
        if progress_cb:
            progress_cb(msg)

    _progress(f"Building gelbooru snapshot: {snap_path}")

    conn = _db.connect_write(snap_path)
    try:
        _db.migrate(conn)

        # --- Tags ---
        _progress("Scraping tags from gelbooru...")
        tag_count = 0
        conn.execute("BEGIN")
        for tag in scrape_gelbooru_tags(
            min_post_count=min_post_count,
            api_key=api_key,
            user_id=user_id,
            stop_event=stop_event,
        ):
            if stop_event and stop_event.is_set():
                conn.execute("ROLLBACK")
                _progress("Cancelled during tag scrape")
                return snap_path
            conn.execute(
                "INSERT OR REPLACE INTO tags(name, source, category, post_count, is_deprecated)"
                " VALUES (?,?,?,?,?)",
                (tag["name"], "gelbooru", tag["category"], tag["post_count"], tag["is_deprecated"]),
            )
            tag_count += 1
            if tag_count % _BATCH_SIZE == 0:
                conn.execute("COMMIT")
                conn.execute("BEGIN")
                _progress(f"Tags scraped: {tag_count:,}")
        conn.execute("COMMIT")
        _progress(f"Tags done: {tag_count:,}")

        # --- Aliases (HTML scrape; gelbooru has no alias JSON API) ---
        _progress("Scraping tag aliases from gelbooru...")
        alias_count = 0
        conn.execute("BEGIN")
        for alias in scrape_gelbooru_aliases(
            api_key=api_key,
            user_id=user_id,
            stop_event=stop_event,
        ):
            if stop_event and stop_event.is_set():
                conn.execute("ROLLBACK")
                _progress("Cancelled during alias scrape")
                return snap_path
            conn.execute(
                "INSERT OR REPLACE INTO aliases(alias, canonical) VALUES (?,?)",
                (alias["alias"], alias["canonical"]),
            )
            alias_count += 1
            if alias_count % _BATCH_SIZE == 0:
                conn.execute("COMMIT")
                conn.execute("BEGIN")
                _progress(f"Aliases scraped: {alias_count:,}")
        conn.execute("COMMIT")
        _progress(f"Aliases done: {alias_count:,}")

        # --- FTS index ---
        _progress("Building FTS index...")
        rebuild_fts(conn)
        _progress("FTS index done")

        # --- Meta ---
        conn.execute("BEGIN")
        for k, v in [
            ("date", today),
            ("label", label),
            ("source", "gelbooru"),
            ("created_at", str(int(time.time()))),
            ("tag_count", str(tag_count)),
            ("alias_count", str(alias_count)),
        ]:
            conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES (?,?)", (k, v))
        conn.execute("COMMIT")

        _progress(f"Gelbooru snapshot complete: {tag_count:,} tags, {alias_count:,} aliases → {snap_path.name}")
        return snap_path

    except Exception:
        logger.exception("Gelbooru snapshot build failed")
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        conn.close()


def rebuild_fts(conn) -> None:
    """Rebuild the contentless FTS5 table from the current tags + aliases tables.

    Called after a batch insert or when the index is stale.
    Uses a single transaction: delete old FTS rows, then re-insert.
    """
    conn.execute("BEGIN")
    # Contentless FTS5 (content='') forbids plain DELETE; use the delete-all directive.
    conn.execute("INSERT INTO tags_fts(tags_fts) VALUES('delete-all')")
    # aliases_text indexes aliases + artist other_names so a tag is
    # findable by its alternate/former names. Wiki translations are excluded.
    rows = conn.execute("""
        SELECT t.id, t.name,
               TRIM(COALESCE(GROUP_CONCAT(a.alias, ' '), '') || ' ' ||
                    COALESCE((SELECT GROUP_CONCAT(tr.text, ' ') FROM translations tr
                              WHERE tr.tag = t.name AND tr.lang = 'artist'), '')) AS aliases_text
        FROM tags t
        LEFT JOIN aliases a ON a.canonical = t.name
        GROUP BY t.id
    """).fetchall()
    # connect_write uses the default row factory (tuples), so index positionally.
    for row in rows:
        conn.execute(
            "INSERT INTO tags_fts(rowid, name, aliases_text) VALUES (?, ?, ?)",
            (row[0], row[1], row[2]),
        )
    conn.execute("COMMIT")
