"""Tag DB updaters — full re-scrape and incremental update of a working DB.

Both functions mutate a single SQLite file in place (the working DB, or a fresh
file for the author's standalone build) under the caller's maintenance lock; no
WriteQueue is needed (single writer).

Provenance / time-binding (see plan §"Provenance / time-binding algorithm"):
  - meta.structure_synced_through — event-time watermark. FULL forwards it to now;
    INCREMENTAL advances it only to the max event created_at actually consumed.
  - meta.full_count_synced_at + tags.post_count_synced_at — count freshness. FULL
    stamps all rows = now; INCREMENTAL stamps only the NEW tags it fetched.
  - related_tags.synced_at — refreshed on demand only (never by these functions).
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from . import db as _db
from . import scraper as _sc
from .snapshots import rebuild_fts

logger = logging.getLogger("xyz.tagdb.updater")

__all__ = ["run_full_update", "run_incremental_update", "IncrementalBaselineError"]

_BATCH = 500

_UPSERT_TAG_FULL = """
INSERT INTO tags(name, source, category, post_count, is_deprecated,
                 danbooru_id, created_at, post_count_synced_at, structure_synced_at)
VALUES (?, 'danbooru', ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(name) DO UPDATE SET
    category=excluded.category,
    post_count=excluded.post_count,
    is_deprecated=excluded.is_deprecated,
    danbooru_id=excluded.danbooru_id,
    created_at=excluded.created_at,
    post_count_synced_at=excluded.post_count_synced_at,
    structure_synced_at=excluded.structure_synced_at
"""

# Apply a tag_version event: update structure only, never post_count. A brand-new
# structural row gets post_count=0 (post_count_synced_at stays 0 ⇒ flagged stale).
_UPSERT_TAG_STRUCTURE = """
INSERT INTO tags(name, source, category, post_count, is_deprecated,
                 danbooru_id, structure_synced_at)
VALUES (?, 'danbooru', ?, 0, ?, ?, ?)
ON CONFLICT(name) DO UPDATE SET
    category=excluded.category,
    is_deprecated=excluded.is_deprecated,
    danbooru_id=excluded.danbooru_id,
    structure_synced_at=excluded.structure_synced_at
"""

_UPSERT_ALIAS = """
INSERT INTO aliases(alias, canonical, created_at, synced_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(alias) DO UPDATE SET
    canonical=excluded.canonical,
    created_at=excluded.created_at,
    synced_at=excluded.synced_at
"""


class IncrementalBaselineError(RuntimeError):
    """Raised when an incremental update is requested but no baseline exists."""


def _now() -> int:
    return int(time.time())


def _get_meta_int(conn, key: str, default: int = 0) -> int:
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    if row and str(row[0]).lstrip("-").isdigit():
        return int(row[0])
    return default


def _set_meta(conn, key: str, value: Any) -> None:
    conn.execute(
        "INSERT INTO meta(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )


def _progress(progress_cb: Optional[Callable[[str], None]], msg: str) -> None:
    logger.info(msg)
    if progress_cb:
        progress_cb(msg)


def backfill_tag_versions(
    conn,
    login: Optional[str] = None,
    api_key: Optional[str] = None,
    progress_cb: Optional[Callable[[str], None]] = None,
    stop_event=None,
) -> int:
    """Scrape the entire tag_versions event log (back to 2013) into `conn`.

    Enables date reconstruction of category/deprecation history. Idempotent
    (INSERT OR IGNORE on version_id).
    """
    now = _now()
    n = 0
    conn.execute("BEGIN")
    for v in _sc.scrape_tag_versions_since(0, login=login, api_key=api_key,
                                           stop_event=stop_event):
        if stop_event and stop_event.is_set():
            conn.execute("COMMIT")
            return n
        conn.execute(
            "INSERT OR IGNORE INTO tag_versions(version_id, tag_id, name, category, "
            "is_deprecated, created_at, previous_version_id, synced_at) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (v["version_id"], v["tag_id"], v["name"], v["category"],
             v["is_deprecated"], v["created_at"], v["previous_version_id"], now),
        )
        n += 1
        if n % 2000 == 0:
            conn.execute("COMMIT"); conn.execute("BEGIN")
            _progress(progress_cb, f"  tag_versions: {n:,}")
    conn.execute("COMMIT")
    return n


def backfill_artist_versions(
    conn,
    login: Optional[str] = None,
    api_key: Optional[str] = None,
    progress_cb: Optional[Callable[[str], None]] = None,
    stop_event=None,
) -> int:
    """Scrape the entire artist_versions event log into `conn` (large: ~millions).

    Enables exact artist rename timelines + multi-level name rollback in date
    reconstruction. Stores ONLY name-change events (not url/other-name edits) with
    the heavy JSON columns left NULL — the full log is ~2.7M rows / 2 GB, but the
    rename timeline is ~700k rows. Current other_names (for search) come from the
    separate artist-other_names scrape. Versions arrive in version_id (chronological)
    order, so a per-artist last-name map detects changes in one pass.
    """
    now = _now()
    n = 0
    last_name: Dict[int, str] = {}
    conn.execute("BEGIN")
    for v in _sc.scrape_artist_versions_since(0, login=login, api_key=api_key,
                                              stop_event=stop_event):
        if stop_event and stop_event.is_set():
            conn.execute("COMMIT")
            return n
        aid, nm = v["artist_id"], v["name"]
        if last_name.get(aid) == nm:
            continue  # not a rename — skip
        last_name[aid] = nm
        conn.execute(
            "INSERT OR IGNORE INTO artist_versions(version_id, artist_id, name, "
            "other_names, group_name, urls, is_banned, is_deleted, created_at, synced_at) "
            "VALUES (?,?,?,NULL,NULL,NULL,?,?,?,?)",
            (v["version_id"], aid, nm, v["is_banned"], v["is_deleted"],
             v["created_at"], now),
        )
        n += 1
        if n % 2000 == 0:
            conn.execute("COMMIT"); conn.execute("BEGIN")
            _progress(progress_cb, f"  artist name-change events: {n:,}")
    conn.execute("COMMIT")
    return n


def run_full_update(
    db_path: Path,
    min_post_count: int = 10,
    label: str = "danbooru",
    login: Optional[str] = None,
    api_key: Optional[str] = None,
    with_translations: bool = False,
    with_versions: bool = False,
    with_artist_names: bool = False,
    with_artist_versions: bool = False,
    progress_cb: Optional[Callable[[str], None]] = None,
    stop_event=None,
) -> Dict[str, Any]:
    """Full re-scrape into `db_path` (created/migrated if needed).

    Refreshes post_count for every tag (count freshness = now) and forwards the
    structure watermark to now. Used by the working-DB 'full' mode and by the
    author's standalone build. Returns a summary dict.
    """
    db_path = Path(db_path)
    db_path.parent.mkdir(parents=True, exist_ok=True)
    now = _now()
    conn = _db.connect_write(db_path)
    try:
        _db.migrate(conn)

        _progress(progress_cb, f"[Full] Scraping tags (post_count>={min_post_count})...")
        tag_count = 0
        conn.execute("BEGIN")
        for t in _sc.scrape_tags(min_post_count=min_post_count, login=login,
                                 api_key=api_key, stop_event=stop_event):
            if stop_event and stop_event.is_set():
                conn.execute("ROLLBACK")
                _progress(progress_cb, "[Full] Cancelled during tag scrape (no changes committed)")
                return {"mode": "full", "cancelled": True}
            conn.execute(_UPSERT_TAG_FULL, (
                t["name"], t["category"], t["post_count"], t["is_deprecated"],
                t["danbooru_id"], t["created_at"], now, now,
            ))
            tag_count += 1
            if tag_count % _BATCH == 0:
                conn.execute("COMMIT"); conn.execute("BEGIN")
                _progress(progress_cb, f"[Full] Tags: {tag_count:,}")
        conn.execute("COMMIT")
        _progress(progress_cb, f"[Full] Tags done: {tag_count:,}")

        _progress(progress_cb, "[Full] Scraping aliases...")
        alias_count = 0
        conn.execute("BEGIN")
        for a in _sc.scrape_aliases(login=login, api_key=api_key, stop_event=stop_event):
            if stop_event and stop_event.is_set():
                conn.execute("ROLLBACK")
                _progress(progress_cb, "[Full] Cancelled during alias scrape")
                return {"mode": "full", "cancelled": True}
            conn.execute(_UPSERT_ALIAS, (a["alias"], a["canonical"], a["created_at"], now))
            alias_count += 1
            if alias_count % _BATCH == 0:
                conn.execute("COMMIT"); conn.execute("BEGIN")
        conn.execute("COMMIT")
        _progress(progress_cb, f"[Full] Aliases done: {alias_count:,}")

        if with_translations:
            _progress(progress_cb, "[Full] Scraping wiki other_names (translations)...")
            tr_count = 0
            conn.execute("BEGIN")
            for w in _sc.scrape_wiki_other_names(login=login, api_key=api_key,
                                                 stop_event=stop_event):
                if stop_event and stop_event.is_set():
                    conn.execute("ROLLBACK")
                    _progress(progress_cb, "[Full] Cancelled during translations scrape")
                    return {"mode": "full", "cancelled": True}
                conn.execute(
                    "INSERT OR REPLACE INTO translations(tag, lang, text) VALUES (?, 'other', ?)",
                    (w["tag"], " ".join(w["other_names"])),
                )
                tr_count += 1
                if tr_count % _BATCH == 0:
                    conn.execute("COMMIT"); conn.execute("BEGIN")
                    _progress(progress_cb, f"[Full] Translations: {tr_count:,}")
            conn.execute("COMMIT")
            _progress(progress_cb, f"[Full] Translations done: {tr_count:,}")

        if with_artist_names:
            _progress(progress_cb, "[Full] Scraping artist other_names (handles / former names)...")
            an_count = 0
            conn.execute("BEGIN")
            for a in _sc.scrape_artist_other_names(login=login, api_key=api_key,
                                                   stop_event=stop_event):
                if stop_event and stop_event.is_set():
                    conn.execute("ROLLBACK")
                    _progress(progress_cb, "[Full] Cancelled during artist names scrape")
                    return {"mode": "full", "cancelled": True}
                conn.execute(
                    "INSERT OR REPLACE INTO translations(tag, lang, text) VALUES (?, 'artist', ?)",
                    (a["tag"], " ".join(a["other_names"])),
                )
                an_count += 1
                if an_count % _BATCH == 0:
                    conn.execute("COMMIT"); conn.execute("BEGIN")
                    _progress(progress_cb, f"[Full] Artist names: {an_count:,}")
            conn.execute("COMMIT")
            _progress(progress_cb, f"[Full] Artist names done: {an_count:,}")

        if with_versions:
            _progress(progress_cb, "[Full] Backfilling tag_versions event log...")
            nver = backfill_tag_versions(conn, login=login, api_key=api_key,
                                         progress_cb=progress_cb, stop_event=stop_event)
            _progress(progress_cb, f"[Full] tag_versions backfilled: {nver:,}")

        if with_artist_versions:
            _progress(progress_cb, "[Full] Backfilling artist_versions event log (large)...")
            nav = backfill_artist_versions(conn, login=login, api_key=api_key,
                                           progress_cb=progress_cb, stop_event=stop_event)
            _progress(progress_cb, f"[Full] artist_versions backfilled: {nav:,}")

        _progress(progress_cb, "[Full] Rebuilding FTS index...")
        rebuild_fts(conn)

        conn.execute("BEGIN")
        # A full read observed current truth for every tag → all clocks = now.
        for k, v in [
            ("date", time.strftime("%Y-%m-%d")),
            ("label", label),
            ("source", "danbooru"),
            ("created_at", now),
            ("tag_count", tag_count),
            ("alias_count", alias_count),
            ("full_count_synced_at", now),
            ("structure_synced_through", now),
            ("aliases_synced_through", now),
        ]:
            _set_meta(conn, k, v)
        conn.execute("COMMIT")

        _progress(progress_cb, f"[Full] Complete: {tag_count:,} tags, {alias_count:,} aliases")
        return {
            "mode": "full", "tags": tag_count, "aliases": alias_count,
            "full_count_synced_at": now, "structure_synced_through": now,
        }
    except Exception:
        logger.exception("Full update failed")
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        conn.close()


def reconstruct_as_of(
    src_path: Path,
    target_epoch: int,
    out_path: Path,
    progress_cb: Optional[Callable[[str], None]] = None,
    stop_event=None,
) -> Dict[str, Any]:
    """Build a snapshot reflecting the tag vocabulary as it was at `target_epoch`.

    From the working DB's event log + timestamps:
      - existence: tags with created_at <= X (or unknown),
      - category/deprecation: the latest tag_version with created_at <= X (else current),
      - name: rolled back to the antecedent of the earliest rename-alias created after X,
      - aliases: those created at/before X.
    post_count and related are NOT historical (kept as current / omitted) — documented
    in the UI. Category rollback requires tag_versions to be present (build with
    --with-versions), otherwise categories stay at their current values.
    """
    src_path, out_path = Path(src_path), Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists():
        out_path.unlink()
    now = _now()
    iso = _sc.epoch_to_iso(target_epoch)[:10]
    src = _db.connect_read(src_path)
    out = _db.connect_write(out_path)
    try:
        _db.migrate(out)
        _progress(progress_cb, f"[Recon] Reconstructing vocabulary as of {iso}...")

        tags = src.execute(
            "SELECT name, source, category, post_count, is_deprecated, danbooru_id, created_at "
            "FROM tags WHERE created_at <= ? OR created_at = 0",
            (target_epoch,),
        ).fetchall()

        # Artist name-history map (multi-level rename rollback). artist_versions is
        # ordered by created_at per artist; the latest version's name = the current
        # tag name, so map current-name → artist_id, and keep each artist's timeline.
        from collections import defaultdict
        artist_hist: dict = defaultdict(list)
        for av in src.execute(
            "SELECT artist_id, name, created_at FROM artist_versions "
            "ORDER BY artist_id, created_at, version_id"
        ).fetchall():
            artist_hist[av["artist_id"]].append((av["created_at"], av["name"]))
        name_to_aid = {lst[-1][1]: aid for aid, lst in artist_hist.items() if lst}

        def _artist_name_as_of(current_name):
            aid = name_to_aid.get(current_name)
            if aid is None:
                return None
            nm = None
            for ca, nval in artist_hist[aid]:
                if ca <= target_epoch:
                    nm = nval
                else:
                    break
            return nm

        n = 0
        out.execute("BEGIN")
        for r in tags:
            if stop_event and stop_event.is_set():
                out.execute("ROLLBACK")
                _progress(progress_cb, "[Recon] Cancelled")
                return {"mode": "reconstruct", "cancelled": True}
            cat, dep, did = r["category"], r["is_deprecated"], r["danbooru_id"]
            if did is not None:
                v = src.execute(
                    "SELECT category, is_deprecated FROM tag_versions "
                    "WHERE tag_id = ? AND created_at <= ? "
                    "ORDER BY created_at DESC, version_id DESC LIMIT 1",
                    (did, target_epoch),
                ).fetchone()
                if v:
                    cat, dep = v["category"], v["is_deprecated"]
            # Name as of X: prefer the artist_versions timeline (multi-level), else
            # the antecedent of the earliest rename-alias created AFTER X (one level).
            out_name = _artist_name_as_of(r["name"]) if cat == 1 else None
            if out_name is None:
                alias_row = src.execute(
                    "SELECT alias FROM aliases WHERE canonical = ? AND created_at > ? "
                    "ORDER BY created_at ASC LIMIT 1",
                    (r["name"], target_epoch),
                ).fetchone()
                out_name = alias_row["alias"] if alias_row else r["name"]
            out.execute(
                "INSERT OR IGNORE INTO tags(name, source, category, post_count, is_deprecated, "
                "danbooru_id, created_at, post_count_synced_at, structure_synced_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                (out_name, r["source"], cat, r["post_count"], dep, did,
                 r["created_at"], 0, target_epoch),
            )
            n += 1
            if n % _BATCH == 0:
                out.execute("COMMIT"); out.execute("BEGIN")
        out.execute("COMMIT")
        _progress(progress_cb, f"[Recon] Tags as of {iso}: {n:,}")

        out.execute("BEGIN")
        for a in src.execute(
            "SELECT alias, canonical, created_at FROM aliases "
            "WHERE created_at <= ? OR created_at = 0",
            (target_epoch,),
        ).fetchall():
            out.execute(
                "INSERT OR IGNORE INTO aliases(alias, canonical, created_at, synced_at) "
                "VALUES (?,?,?,?)",
                (a["alias"], a["canonical"], a["created_at"], now),
            )
        out.execute("COMMIT")

        # Carry over translations as-is (other_names aren't time-stamped).
        out.execute("BEGIN")
        for tr in src.execute("SELECT tag, lang, text FROM translations").fetchall():
            out.execute(
                "INSERT OR REPLACE INTO translations(tag, lang, text) VALUES (?,?,?)",
                (tr["tag"], tr["lang"], tr["text"]),
            )
        out.execute("COMMIT")

        _progress(progress_cb, "[Recon] Rebuilding FTS index...")
        rebuild_fts(out)

        out.execute("BEGIN")
        for k, v in [
            ("date", iso), ("label", f"recon_{iso}"), ("source", "danbooru"),
            ("created_at", now), ("schema_kind", "local"),
            ("structure_synced_through", target_epoch), ("full_count_synced_at", 0),
            ("tag_count", n),
        ]:
            _set_meta(out, k, v)
        out.execute("COMMIT")

        _progress(progress_cb, f"[Recon] Done: {n:,} tags as of {iso} → {out_path.name}")
        return {"mode": "reconstruct", "tags": n, "as_of": target_epoch, "path": str(out_path)}
    except Exception:
        logger.exception("Reconstruct failed")
        try:
            out.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        src.close()
        out.close()


def run_incremental_update(
    db_path: Path,
    min_post_count: int = 10,
    login: Optional[str] = None,
    api_key: Optional[str] = None,
    progress_cb: Optional[Callable[[str], None]] = None,
    stop_event=None,
) -> Dict[str, Any]:
    """Apply only events created at/after the structure watermark.

    Does NOT refresh post_count or related_tags of unchanged tags (no incremental
    count feed exists). Advances structure_synced_through only to the max event
    time actually consumed; a cancelled run leaves the watermark untouched so it
    is safe to re-run. Returns a summary incl. staleness of the count clock.
    """
    db_path = Path(db_path)
    now = _now()
    conn = _db.connect_write(db_path)
    try:
        _db.migrate(conn)
        wm = _get_meta_int(conn, "structure_synced_through", 0)
        if wm <= 0:
            raise IncrementalBaselineError(
                "No baseline to update from. Download the official dataset or run a "
                "Full re-scrape first, then incremental updates can apply changes."
            )
        _progress(progress_cb, f"[Incr] Updating events since {_sc.epoch_to_iso(wm)}...")

        max_event = wm
        affected_names: set[str] = set()
        new_tags = versions = artists = aliases = 0

        # 1) New tags (created since wm) — these carry a real current count.
        conn.execute("BEGIN")
        for t in _sc.scrape_tags_since(wm, min_post_count=min_post_count,
                                       login=login, api_key=api_key, stop_event=stop_event):
            if stop_event and stop_event.is_set():
                conn.execute("ROLLBACK")
                _progress(progress_cb, "[Incr] Cancelled (watermark unchanged)")
                return {"mode": "incremental", "cancelled": True}
            conn.execute(_UPSERT_TAG_FULL, (
                t["name"], t["category"], t["post_count"], t["is_deprecated"],
                t["danbooru_id"], t["created_at"], now, now,
            ))
            affected_names.add(t["name"])
            max_event = max(max_event, t["created_at"])
            new_tags += 1
        conn.execute("COMMIT")
        _progress(progress_cb, f"[Incr] New tags: {new_tags:,}")

        # 2) tag_versions — append events, then apply latest per tag_id (structure only).
        latest: Dict[int, Dict[str, Any]] = {}
        conn.execute("BEGIN")
        for v in _sc.scrape_tag_versions_since(wm, login=login, api_key=api_key,
                                               stop_event=stop_event):
            if stop_event and stop_event.is_set():
                conn.execute("ROLLBACK")
                _progress(progress_cb, "[Incr] Cancelled (watermark unchanged)")
                return {"mode": "incremental", "cancelled": True}
            conn.execute(
                "INSERT OR IGNORE INTO tag_versions(version_id, tag_id, name, category, "
                "is_deprecated, created_at, previous_version_id, synced_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (v["version_id"], v["tag_id"], v["name"], v["category"],
                 v["is_deprecated"], v["created_at"], v["previous_version_id"], now),
            )
            versions += 1
            max_event = max(max_event, v["created_at"])
            prev = latest.get(v["tag_id"])
            if prev is None or v["version_id"] > prev["version_id"]:
                latest[v["tag_id"]] = v
        conn.execute("COMMIT")

        conn.execute("BEGIN")
        for v in latest.values():
            conn.execute(_UPSERT_TAG_STRUCTURE, (
                v["name"], v["category"], v["is_deprecated"], v["tag_id"], now,
            ))
            affected_names.add(v["name"])
        conn.execute("COMMIT")
        _progress(progress_cb, f"[Incr] Tag-version events: {versions:,} ({len(latest)} tags)")

        # 3) artist_versions — append events (artist-entry alias supplement).
        conn.execute("BEGIN")
        for av in _sc.scrape_artist_versions_since(wm, login=login, api_key=api_key,
                                                   stop_event=stop_event):
            if stop_event and stop_event.is_set():
                conn.execute("ROLLBACK")
                _progress(progress_cb, "[Incr] Cancelled (watermark unchanged)")
                return {"mode": "incremental", "cancelled": True}
            conn.execute(
                "INSERT OR IGNORE INTO artist_versions(version_id, artist_id, name, "
                "other_names, group_name, urls, is_banned, is_deleted, created_at, synced_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (av["version_id"], av["artist_id"], av["name"], av["other_names"],
                 av["group_name"], av["urls"], av["is_banned"], av["is_deleted"],
                 av["created_at"], now),
            )
            artists += 1
            max_event = max(max_event, av["created_at"])
        conn.execute("COMMIT")
        _progress(progress_cb, f"[Incr] Artist-version events: {artists:,}")

        # 4) aliases (created since wm).
        conn.execute("BEGIN")
        for a in _sc.scrape_aliases_since(wm, login=login, api_key=api_key,
                                          stop_event=stop_event):
            if stop_event and stop_event.is_set():
                conn.execute("ROLLBACK")
                _progress(progress_cb, "[Incr] Cancelled (watermark unchanged)")
                return {"mode": "incremental", "cancelled": True}
            conn.execute(_UPSERT_ALIAS, (a["alias"], a["canonical"], a["created_at"], now))
            affected_names.add(a["canonical"])
            max_event = max(max_event, a["created_at"])
            aliases += 1
        conn.execute("COMMIT")
        _progress(progress_cb, f"[Incr] New aliases: {aliases:,}")

        # 5) Refresh FTS if any tag name/alias set changed. (Category/deprecation
        # changes don't affect the index, which only covers name + alias text;
        # contentless FTS5 can't do targeted row deletes, so rebuild wholesale.)
        if affected_names:
            rebuild_fts(conn)  # manages its own BEGIN/COMMIT (delete-all + reinsert)

        # 6) Advance watermarks — never ahead of a consumed event, never past now.
        new_wm = min(now, max(wm, max_event))
        conn.execute("BEGIN")
        _set_meta(conn, "structure_synced_through", new_wm)
        _set_meta(conn, "aliases_synced_through", new_wm)
        _set_meta(conn, "tag_count",
                  conn.execute("SELECT COUNT(*) FROM tags").fetchone()[0])
        _set_meta(conn, "alias_count",
                  conn.execute("SELECT COUNT(*) FROM aliases").fetchone()[0])
        conn.execute("COMMIT")

        full_sync = _get_meta_int(conn, "full_count_synced_at", 0)
        age_days = round((now - full_sync) / 86400.0, 1) if full_sync else None
        _progress(
            progress_cb,
            f"[Incr] Done. Structure now current to {_sc.epoch_to_iso(new_wm)}. "
            f"NOTE: post_count/related of unchanged tags NOT refreshed "
            f"(counts last fully refreshed {age_days} days ago — run Full to refresh).",
        )
        return {
            "mode": "incremental", "new_tags": new_tags, "tag_versions": versions,
            "artist_versions": artists, "aliases": aliases,
            "structure_synced_through": new_wm, "full_count_synced_at": full_sync,
            "full_count_age_days": age_days,
        }
    except Exception:
        logger.exception("Incremental update failed")
        try:
            conn.execute("ROLLBACK")
        except Exception:
            pass
        raise
    finally:
        conn.close()
