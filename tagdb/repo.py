"""Tag DB — read-side repository.

All reads open a short-lived connect_read connection to the active snapshot file.
No writes happen here (writes are done in snapshots.py during the build process).

Category int mapping (danbooru convention):
  0 = general, 1 = artist, 3 = copyright, 4 = character, 5 = meta
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

from . import db as _db

logger = logging.getLogger("xyz.tagdb.repo")

__all__ = [
    "search_tags", "list_snapshots", "get_snapshot_meta", "get_meta_watermarks",
    "get_cached_related", "store_related",
]

_WATERMARK_KEYS = (
    "structure_synced_through", "full_count_synced_at", "aliases_synced_through",
    "created_at",
)

_CATEGORY_NAMES: Dict[int, str] = {
    0: "general",
    1: "artist",
    3: "copyright",
    4: "character",
    5: "meta",
}


def search_tags(
    q: str,
    db_path: Path,
    limit: int = 20,
    conn: Any = None,
) -> List[Dict[str, Any]]:
    """Substring search using FTS5 trigram index, falling back to LIKE for short queries.

    Returns list of dicts: name, category, category_name, post_count,
    is_deprecated, aliases (list of str).

    If `conn` is provided it is reused (and NOT closed) — the routes layer keeps a
    persistent read connection for autocomplete to avoid per-keystroke open cost.
    """
    q = q.strip()
    if not q:
        return []
    own = conn is None
    if own:
        if not db_path or not Path(db_path).exists():
            return []
        conn = _db.connect_read(db_path)
    try:
        if len(q) >= 3:
            try:
                rows = _search_fts(conn, q, limit)
                if rows is not None:
                    return rows
            except Exception as exc:
                logger.debug("FTS search failed, falling back to LIKE: %s", exc)
        return _search_like(conn, q, limit)
    finally:
        if own:
            conn.close()


def _search_fts(conn: Any, q: str, limit: int) -> Optional[List[Dict[str, Any]]]:
    """FTS5 trigram phrase search — matches any tag/alias containing q as substring."""
    escaped = q.replace('"', '""')
    sql = """
        SELECT t.name, t.category, t.post_count, t.is_deprecated,
               COALESCE(GROUP_CONCAT(a.alias, ','), '') AS aliases,
               (SELECT text FROM translations tr WHERE tr.tag = t.name AND tr.lang = 'artist') AS translations
        FROM tags_fts f
        JOIN tags t ON t.id = f.rowid
        LEFT JOIN aliases a ON a.canonical = t.name
        WHERE tags_fts MATCH ?
        GROUP BY t.id
        ORDER BY t.post_count DESC
        LIMIT ?
    """
    rows = conn.execute(sql, (f'"{escaped}"', limit)).fetchall()
    return [_row_to_dict(r) for r in rows]


def _search_like(conn: Any, q: str, limit: int) -> List[Dict[str, Any]]:
    """Fast name-prefix match for short queries (<3 chars) + FTS-failure fallback.

    Two cheap steps instead of a join+group over the whole prefix set (which would
    sort tens of thousands of rows): (1) top-N tag rows by post_count via the name
    prefix, then (2) enrich just those few with aliases/translations. Substring and
    translation search is handled by the FTS path for 3+ char queries.
    """
    # Non-ASCII (CJK/kana/hangul) short query: it can only be a translated name,
    # which lives mid-blob in translations.text — so accept a substring scan here
    # (these queries are less frequent and users expect a small delay).
    if not q.isascii():
        pat = f"%{q}%"
        rows = conn.execute("""
            SELECT t.name, t.category, t.post_count, t.is_deprecated,
                   COALESCE(GROUP_CONCAT(a.alias, ','), '') AS aliases,
                   (SELECT text FROM translations tr WHERE tr.tag = t.name AND tr.lang = 'artist') AS translations
            FROM tags t
            LEFT JOIN aliases a ON a.canonical = t.name
            WHERE t.name LIKE ? OR a.alias LIKE ?
            GROUP BY t.id ORDER BY t.post_count DESC LIMIT ?
        """, (pat, pat, limit)).fetchall()
        return [_row_to_dict(r) for r in rows]

    prefix = f"{q}%"
    base = conn.execute(
        "SELECT name, category, post_count, is_deprecated FROM tags "
        "WHERE name LIKE ? ORDER BY post_count DESC LIMIT ?",
        (prefix, limit),
    ).fetchall()
    if not base:
        return []
    names = [r["name"] for r in base]
    qmarks = ",".join("?" * len(names))
    amap: Dict[str, str] = {}
    for row in conn.execute(
        f"SELECT canonical, GROUP_CONCAT(alias, ',') FROM aliases "
        f"WHERE canonical IN ({qmarks}) GROUP BY canonical", names):
        amap[row[0]] = row[1]
    tmap: Dict[str, str] = {}
    for row in conn.execute(
        f"SELECT tag, text FROM translations WHERE tag IN ({qmarks}) AND lang = 'artist'", names):
        tmap[row[0]] = row[1]
    out: List[Dict[str, Any]] = []
    for r in base:
        aliases_raw = amap.get(r["name"], "") or ""
        translations_raw = tmap.get(r["name"], "") or ""
        out.append({
            "name": r["name"],
            "category": r["category"],
            "category_name": _CATEGORY_NAMES.get(r["category"], "general"),
            "post_count": r["post_count"],
            "is_deprecated": bool(r["is_deprecated"]),
            "aliases": [a for a in aliases_raw.split(",") if a],
            "translations": [t for t in translations_raw.split(" ") if t],
        })
    return out


def _row_to_dict(row: Any) -> Dict[str, Any]:
    aliases_raw = row["aliases"] or ""
    translations_raw = (row["translations"] if "translations" in row.keys() else "") or ""
    return {
        "name": row["name"],
        "category": row["category"],
        "category_name": _CATEGORY_NAMES.get(row["category"], "general"),
        "post_count": row["post_count"],
        "is_deprecated": bool(row["is_deprecated"]),
        "aliases": [a for a in aliases_raw.split(",") if a],
        "translations": [t for t in translations_raw.split(" ") if t],
    }


def _snapshot_entry(p: Path, kind: str) -> Optional[Dict[str, Any]]:
    try:
        conn = _db.connect_read(p)
        try:
            meta = dict(conn.execute("SELECT key, value FROM meta").fetchall())
        finally:
            conn.close()
    except Exception as exc:
        logger.warning("Could not read snapshot %s: %s", p, exc)
        return None
    return {
        "filename": p.name,
        "path": str(p),
        "kind": kind,
        "date": meta.get("date", ""),
        "label": meta.get("label", ""),
        "source": meta.get("source", ""),
        "tag_count": int(meta.get("tag_count", 0) or 0),
        "created_at": int(meta.get("created_at", 0) or 0),
        "structure_synced_through": int(meta.get("structure_synced_through", 0) or 0),
        "full_count_synced_at": int(meta.get("full_count_synced_at", 0) or 0),
        "origin_official_version": meta.get("origin_official_version", ""),
    }


def list_snapshots(data_dir: Path) -> List[Dict[str, Any]]:
    """List the working DB + official/local/legacy snapshots, working first.

    `kind` ∈ {working, official, local, legacy}. Legacy = flat files left by an
    older install (relocated to local/ once the working-DB model is adopted).
    """
    data_dir = Path(data_dir)
    snap_dir = data_dir / "snapshots"
    result: List[Dict[str, Any]] = []

    working = data_dir / "tagdb.sqlite"
    if working.exists():
        e = _snapshot_entry(working, "working")
        if e:
            result.append(e)

    for kind, sub in (("official", "official"), ("local", "local")):
        d = snap_dir / sub
        if d.exists():
            for p in sorted(d.glob("*.sqlite"), reverse=True):
                e = _snapshot_entry(p, kind)
                if e:
                    result.append(e)

    if snap_dir.exists():
        for p in sorted(snap_dir.glob("*.sqlite"), reverse=True):
            if p.parent == snap_dir:  # flat legacy file
                e = _snapshot_entry(p, "legacy")
                if e:
                    result.append(e)
    return result


def get_snapshot_meta(db_path: Path) -> Dict[str, str]:
    """Read the meta table from a snapshot file."""
    if not Path(db_path).exists():
        return {}
    conn = _db.connect_read(db_path)
    try:
        return dict(conn.execute("SELECT key, value FROM meta").fetchall())
    finally:
        conn.close()


def get_meta_watermarks(db_path: Path) -> Dict[str, int]:
    """Return the provenance watermark epochs from a DB's meta table."""
    meta = get_snapshot_meta(db_path)
    out = {k: int(meta.get(k, 0) or 0) for k in _WATERMARK_KEYS}
    now = int(time.time())
    fc = out.get("full_count_synced_at", 0)
    out["full_count_age_days"] = round((now - fc) / 86400.0, 1) if fc else None
    return out


def get_cached_related(db_path: Path, query_tag: str, limit: int = 20) -> Optional[Dict[str, Any]]:
    """Return cached related tags for query_tag, or None if not cached."""
    if not db_path or not Path(db_path).exists():
        return None
    conn = _db.connect_read(db_path)
    try:
        rows = conn.execute(
            "SELECT related_tag, category, cosine, jaccard, overlap, synced_at "
            "FROM related_tags WHERE query_tag=? ORDER BY rank LIMIT ?",
            (query_tag, limit),
        ).fetchall()
    except Exception:
        return None
    finally:
        conn.close()
    if not rows:
        return None
    return {
        "related": [{
            "name": r["related_tag"],
            "category": r["category"],
            "category_name": _CATEGORY_NAMES.get(r["category"], "general"),
            "cosine": r["cosine"], "jaccard": r["jaccard"], "overlap": r["overlap"],
        } for r in rows],
        "synced_at": max(r["synced_at"] for r in rows),
    }


def store_related(db_path: Path, query_tag: str, rows: List[Dict[str, Any]]) -> None:
    """Replace the cached related set for query_tag (stamped synced_at=now)."""
    now = int(time.time())
    conn = _db.connect_write(db_path)
    try:
        conn.execute("BEGIN")
        conn.execute("DELETE FROM related_tags WHERE query_tag=?", (query_tag,))
        for row in rows:
            conn.execute(
                "INSERT OR REPLACE INTO related_tags(query_tag, related_tag, category, "
                "cosine, jaccard, overlap, rank, synced_at) VALUES (?,?,?,?,?,?,?,?)",
                (query_tag, row["related_tag"], row["category"], row["cosine"],
                 row["jaccard"], row["overlap"], row["rank"], now),
            )
        conn.execute("COMMIT")
    finally:
        conn.close()
