"""Tag DB — HTTP routes registered under /xyz/tagdb/*.

Endpoints:
  GET  /xyz/tagdb/search?q=&limit=         — FTS/LIKE tag autocomplete
  GET  /xyz/tagdb/snapshots                — list available snapshot files
  POST /xyz/tagdb/snapshots/active         — {"filename": "..."} set active snapshot
  GET  /xyz/tagdb/snapshots/active         — get current active snapshot info
  GET  /xyz/tagdb/settings                 — get persisted settings (credentials etc.)
  POST /xyz/tagdb/settings                 — update settings (login, api_key, …)
  POST /xyz/tagdb/maintain                 — {"min_post_count":5,"label":"danbooru"} start scrape
  GET  /xyz/tagdb/maintain/status          — poll scrape progress
  POST /xyz/tagdb/maintain/cancel          — cancel running scrape
"""

from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

from aiohttp import web

logger = logging.getLogger("xyz.tagdb.routes")

__all__ = ["register"]

_registered = False

# Module-level state ——————————————————————————————————————————————————————————

_data_dir: Optional[Path] = None
_active_snapshot_path: Optional[Path] = None   # DB that search reads (defaults to working)
_working_db_path: Optional[Path] = None        # the mutable working DB
_settings_path: Optional[Path] = None

# Maintain task state
_maintain_thread: Optional[threading.Thread] = None
_maintain_stop_event: Optional[threading.Event] = None
_maintain_log: List[str] = []
_maintain_running: bool = False
_maintain_mode: Optional[str] = None
# Serialises any writer to the working DB (updates, related-cache refresh).
_maintain_lock = threading.Lock()

# Persistent read connection for autocomplete (avoids per-keystroke open cost).
_search_conn = None
_search_conn_path: Optional[Path] = None


def _search_connection():
    """Return (conn, active_path) reusing a cached read connection; reopen on switch."""
    global _search_conn, _search_conn_path
    active = _active_db()
    if active is None:
        return None, None
    if _search_conn is None or _search_conn_path != active:
        if _search_conn is not None:
            try:
                _search_conn.close()
            except Exception:
                pass
        from . import db as _db
        _search_conn = _db.connect_read(active)
        _search_conn_path = active
    return _search_conn, active


# ─── Internal helpers ─────────────────────────────────────────────────────────

def _ok(data: Any) -> web.Response:
    return web.json_response(data)


def _err(status: int, msg: str) -> web.Response:
    return web.json_response({"error": msg}, status=status)


def _load_settings() -> Dict[str, Any]:
    if _settings_path and _settings_path.exists():
        try:
            return json.loads(_settings_path.read_text("utf-8"))
        except Exception:
            pass
    return {}


def _save_settings(data: Dict[str, Any]) -> None:
    if _settings_path:
        _settings_path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _resolve_snapshot_path(filename: str) -> Optional[Path]:
    """Resolve a snapshot filename to a path, searching working/official/local/flat."""
    if not _data_dir:
        return None
    if filename in ("tagdb.sqlite", "working") and _working_db_path:
        return _working_db_path if _working_db_path.exists() else None
    snap_dir = _data_dir / "snapshots"
    for cand in (snap_dir / "official" / filename,
                 snap_dir / "local" / filename,
                 snap_dir / filename):
        if cand.exists():
            return cand
    return None


def _active_db() -> Optional[Path]:
    """The DB search reads: the explicit active snapshot, else the working DB."""
    if _active_snapshot_path and _active_snapshot_path.exists():
        return _active_snapshot_path
    if _working_db_path and _working_db_path.exists():
        return _working_db_path
    return None


def _adopt_working_db() -> None:
    """Point the active read DB at the working DB and relocate legacy flat files.

    Called by tagdb.__init__ after a first-run download seeds the working DB, and
    on registration when a working DB already exists.
    """
    global _active_snapshot_path
    if _working_db_path and _working_db_path.exists():
        _active_snapshot_path = _working_db_path
        _relocate_legacy_flat()


def _relocate_legacy_flat() -> None:
    """Move pre-working-DB flat snapshots/*.sqlite into snapshots/local/ (with sidecars)."""
    if not _data_dir:
        return
    import shutil
    snap_dir = _data_dir / "snapshots"
    local_dir = snap_dir / "local"
    local_dir.mkdir(parents=True, exist_ok=True)
    for p in list(snap_dir.glob("*.sqlite")):
        if p.parent != snap_dir:
            continue
        try:
            for suffix in ("", "-wal", "-shm"):
                src = Path(str(p) + suffix)
                if src.exists():
                    shutil.move(str(src), str(local_dir / src.name))
        except Exception as exc:
            logger.warning("[TagDB] Could not relocate legacy snapshot %s: %s", p.name, exc)


def _active_snapshot_info() -> Optional[Dict[str, Any]]:
    active = _active_db()
    if not active:
        return None
    from . import repo as _repo
    meta = _repo.get_snapshot_meta(active)
    return {
        "filename": active.name,
        "path": str(active),
        "is_working": active == _working_db_path,
        **meta,
    }


def _get_credentials() -> tuple[Optional[str], Optional[str]]:
    """Return (login, api_key) from persisted settings, or (None, None)."""
    s = _load_settings()
    return s.get("danbooru_login") or None, s.get("danbooru_api_key") or None


# ─── Route handlers ───────────────────────────────────────────────────────────

async def _handle_search(request: web.Request) -> web.Response:
    conn, active = _search_connection()
    if not active:
        return _ok([])
    q = request.rel_url.query.get("q", "").strip()
    if not q:
        return _ok([])
    try:
        limit = int(request.rel_url.query.get("limit", "20"))
        limit = max(1, min(limit, 100))
    except ValueError:
        limit = 20

    from . import repo as _repo
    results = _repo.search_tags(q, active, limit=limit, conn=conn)
    return _ok(results)


async def _handle_snapshots_list(request: web.Request) -> web.Response:
    if not _data_dir:
        return _ok([])
    from . import repo as _repo
    return _ok(_repo.list_snapshots(_data_dir))


async def _handle_snapshots_get_active(request: web.Request) -> web.Response:
    info = _active_snapshot_info()
    return _ok({"active": info})


async def _handle_snapshots_set_active(request: web.Request) -> web.Response:
    global _active_snapshot_path
    try:
        body = await request.json()
    except Exception:
        return _err(400, "invalid JSON body")

    filename = (body.get("filename") or "").strip()
    if not filename:
        return _err(400, "filename required")

    p = _resolve_snapshot_path(filename)
    if p is None:
        return _err(404, f"snapshot not found: {filename}")

    _active_snapshot_path = p
    settings = _load_settings()
    settings["active_snapshot"] = filename
    _save_settings(settings)
    return _ok({"ok": True, "active": filename})


async def _handle_settings_get(request: web.Request) -> web.Response:
    s = _load_settings()
    has_key = bool(s.get("danbooru_api_key"))
    # api_key is masked by default; ?reveal=1 returns the real value so the panel's
    # "Show" button can display the user's own stored key (localhost, single user).
    reveal = request.rel_url.query.get("reveal") in ("1", "true")
    return _ok({
        "danbooru_login":   s.get("danbooru_login", ""),
        "danbooru_api_key": (s.get("danbooru_api_key", "") if reveal else ("***" if has_key else "")),
        "has_credentials":  bool(s.get("danbooru_login") and has_key),
    })


async def _handle_settings_post(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return _err(400, "invalid JSON body")

    settings = _load_settings()
    if "danbooru_login" in body:
        settings["danbooru_login"] = str(body["danbooru_login"]).strip()
    if "danbooru_api_key" in body:
        settings["danbooru_api_key"] = str(body["danbooru_api_key"]).strip()
    _save_settings(settings)
    return _ok({"ok": True})


def _start_maintain_thread(name: str, target, mode: Optional[str], first_log: str,
                           stop_event: "threading.Event") -> None:
    """Spawn the single maintenance worker thread (guarded by _maintain_running)."""
    global _maintain_thread, _maintain_stop_event, _maintain_log, _maintain_running, _maintain_mode
    _maintain_log = [first_log]
    _maintain_running = True
    _maintain_mode = mode
    _maintain_stop_event = stop_event
    _maintain_thread = threading.Thread(target=target, daemon=True, name=name)
    _maintain_thread.start()


async def _handle_maintain_start(request: web.Request) -> web.Response:
    if _maintain_running:
        return _err(409, "a maintenance task is already running")
    try:
        body = await request.json()
    except Exception:
        body = {}
    if not _data_dir or not _working_db_path:
        return _err(500, "tagdb data directory not initialized")

    mode = str(body.get("mode", "full")).strip().lower()
    if mode not in ("full", "incremental"):
        return _err(400, "mode must be 'full' or 'incremental'")
    min_post_count = int(body.get("min_post_count", 10))
    login, api_key = _get_credentials()
    if body.get("login"):
        login = str(body["login"]).strip() or None
    if body.get("api_key"):
        api_key = str(body["api_key"]).strip() or None

    stop_ev = threading.Event()
    working = _working_db_path

    def _run() -> None:
        global _maintain_running, _active_snapshot_path
        from . import updater as _up
        log = _maintain_log.append
        try:
            with _maintain_lock:
                if mode == "full":
                    # Include reconstruction data (tag_versions) + translations +
                    # artist other_names so a full rebuild stays self-sufficient.
                    # (artist_versions — millions of rows — is left to the prebuilt
                    # dataset + incrementals to avoid a ~45min routine refresh.)
                    _up.run_full_update(working, min_post_count=min_post_count,
                                        login=login, api_key=api_key,
                                        with_translations=True, with_versions=True,
                                        with_artist_names=True,
                                        progress_cb=log, stop_event=stop_ev)
                else:
                    _up.run_incremental_update(working, min_post_count=min_post_count,
                                              login=login, api_key=api_key,
                                              progress_cb=log, stop_event=stop_ev)
            _adopt_working_db()
            settings = _load_settings()
            settings.pop("active_snapshot", None)
            _save_settings(settings)
            log("Done.")
        except _up.IncrementalBaselineError as exc:
            log(f"Cannot run incremental: {exc}")
        except Exception as exc:
            log(f"Error: {exc}")
            logger.exception("Maintain (%s) failed", mode)
        finally:
            _maintain_running = False

    _start_maintain_thread("tagdb-maintain", _run, mode,
                           f"[{mode}] starting (min_post_count={min_post_count}, "
                           f"auth={'yes' if login else 'anonymous'})...", stop_ev)
    return _ok({"ok": True, "mode": mode, "message": "maintain started"})


async def _handle_maintain_status(request: web.Request) -> web.Response:
    from . import repo as _repo
    fresh: Dict[str, Any] = {}
    if _working_db_path and _working_db_path.exists():
        fresh = _repo.get_meta_watermarks(_working_db_path)
    return _ok({
        "running": _maintain_running,
        "mode":    _maintain_mode,
        "log":     list(_maintain_log),
        "freshness": fresh,
    })


async def _handle_maintain_cancel(request: web.Request) -> web.Response:
    if _maintain_stop_event:
        _maintain_stop_event.set()
    return _ok({"ok": True})


async def _handle_reconstruct(request: web.Request) -> web.Response:
    if _maintain_running:
        return _err(409, "a maintenance task is already running")
    if not _data_dir or not _working_db_path or not _working_db_path.exists():
        return _err(400, "no working DB to reconstruct from")
    try:
        body = await request.json()
    except Exception:
        body = {}
    date_str = (body.get("date") or "").strip()
    import datetime as _dt
    try:
        d = _dt.datetime.strptime(date_str, "%Y-%m-%d").replace(
            hour=23, minute=59, second=59, tzinfo=_dt.timezone.utc)
    except ValueError:
        return _err(400, "date must be YYYY-MM-DD")
    target = int(d.timestamp())
    out = _data_dir / "snapshots" / "local" / f"recon_{date_str}.sqlite"
    src = _working_db_path

    def _run() -> None:
        global _maintain_running, _active_snapshot_path
        from . import updater as _up
        log = _maintain_log.append
        try:
            with _maintain_lock:
                _up.reconstruct_as_of(src, target, out, progress_cb=log,
                                     stop_event=_maintain_stop_event)
            _active_snapshot_path = out  # serve the historical view (read-only)
            log("Reconstructed snapshot is now the active autocomplete source. "
                "NOTE: post_count and related tags are current values, not historical.")
        except Exception as exc:
            log(f"Error: {exc}")
            logger.exception("Reconstruct failed")
        finally:
            _maintain_running = False

    _start_maintain_thread("tagdb-reconstruct", _run, "reconstruct",
                           f"[reconstruct] building vocabulary as of {date_str}...",
                           threading.Event())
    return _ok({"ok": True, "message": "reconstruct started"})


async def _handle_artist_posts(request: web.Request) -> web.Response:
    name = request.rel_url.query.get("name", "").strip()
    if not name:
        return _ok({"name": "", "posts": []})
    try:
        limit = max(1, min(int(request.rel_url.query.get("limit", "20")), 50))
    except ValueError:
        limit = 20
    login, api_key = _get_credentials()
    from . import scraper as _sc
    loop = request.app.loop if hasattr(request.app, "loop") else None

    def _fetch():
        return _sc.fetch_artist_posts(name, limit=limit, login=login, api_key=api_key)

    try:
        posts = await loop.run_in_executor(None, _fetch) if loop else _fetch()
    except Exception as exc:
        return _err(502, f"artist posts fetch failed: {exc}")
    return _ok({"name": name, "posts": posts})


async def _handle_official_check(request: web.Request) -> web.Response:
    if not _data_dir:
        return _err(500, "tagdb data directory not initialized")
    from . import distribution as _dist
    manifest_url = _load_settings().get("manifest_url") or None
    return _ok(_dist.check_official(_data_dir, manifest_url))


async def _handle_official_download(request: web.Request) -> web.Response:
    if _maintain_running:
        return _err(409, "a maintenance task is already running")
    if not _data_dir or not _working_db_path:
        return _err(500, "tagdb data directory not initialized")
    try:
        body = await request.json()
    except Exception:
        body = {}
    version = body.get("version") or None
    replace_working = bool(body.get("replace_working", False))
    manifest_url = _load_settings().get("manifest_url") or None
    working = _working_db_path
    data_dir = _data_dir

    def _run() -> None:
        global _maintain_running
        from . import distribution as _dist
        log = _maintain_log.append
        try:
            with _maintain_lock:
                if working.exists() and not replace_working:
                    log("A working DB already exists. Pass replace_working=true to "
                        "re-seed from the prebuilt dataset (your current working DB "
                        "is exported to snapshots/local/ first).")
                    return
                if working.exists() and replace_working:
                    _export_working_to_local(log)
                path = _dist.download_official(data_dir, version=version,
                                              manifest_url=manifest_url, progress_cb=log,
                                              stop_event=_maintain_stop_event)
                ver = path.name.split("_danbooru.sqlite")[0]
                _dist.seed_working_db_from_official(path, working, version=ver)
            _adopt_working_db()
            log("Prebuilt dataset installed and active.")
        except Exception as exc:
            log(f"Error: {exc}")
            logger.exception("Official download failed")
        finally:
            _maintain_running = False

    _start_maintain_thread("tagdb-download", _run, "download",
                           "[download] fetching official dataset...", threading.Event())
    return _ok({"ok": True, "message": "download started"})


def _export_working_to_local(log) -> Optional[Path]:
    """Copy the working DB into snapshots/local/ as a dated checkpoint."""
    import shutil
    import time as _t
    if not (_working_db_path and _working_db_path.exists() and _data_dir):
        return None
    from . import repo as _repo
    meta = _repo.get_snapshot_meta(_working_db_path)
    label = meta.get("label", "danbooru")
    stamp = _t.strftime("%Y-%m-%d_%H%M%S")
    dst = _data_dir / "snapshots" / "local" / f"{stamp}_{label}.sqlite"
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy(_working_db_path, dst)
    log(f"Exported current working DB → snapshots/local/{dst.name}")
    return dst


async def _handle_snapshots_export(request: web.Request) -> web.Response:
    if not _working_db_path or not _working_db_path.exists():
        return _err(404, "no working DB to export")
    dst = _export_working_to_local(lambda m: None)
    return _ok({"ok": True, "filename": dst.name if dst else None})


async def _handle_related(request: web.Request) -> web.Response:
    active = _active_db()
    if not active:
        return _ok({"query": "", "related": [], "stale": False})
    q = request.rel_url.query.get("q", "").strip()
    if not q:
        return _ok({"query": "", "related": [], "stale": False})
    try:
        limit = max(1, min(int(request.rel_url.query.get("limit", "20")), 50))
    except ValueError:
        limit = 20
    try:
        max_age_days = float(request.rel_url.query.get("max_age_days", "30"))
    except ValueError:
        max_age_days = 30.0

    from . import repo as _repo
    cached = _repo.get_cached_related(active, q, limit)
    import time as _t
    now = _t.time()
    if cached and (now - cached["synced_at"]) <= max_age_days * 86400:
        return _ok({"query": q, "related": cached["related"],
                    "synced_at": cached["synced_at"], "stale": False})

    # Cache miss/stale → fetch live (off the event loop) and cache into the working DB.
    login, api_key = _get_credentials()
    loop = request.app.loop if hasattr(request.app, "loop") else None
    from . import scraper as _sc

    def _fetch_and_store():
        rows = _sc.fetch_related(q, limit=limit, login=login, api_key=api_key)
        # Only cache into the writable working DB (snapshots are read-only).
        if _working_db_path and _working_db_path.exists():
            with _maintain_lock:
                _repo.store_related(_working_db_path, q, rows)
        return rows

    try:
        if loop is not None:
            rows = await loop.run_in_executor(None, _fetch_and_store)
        else:
            rows = _fetch_and_store()
    except Exception as exc:
        if cached:
            return _ok({"query": q, "related": cached["related"],
                        "synced_at": cached["synced_at"], "stale": True})
        return _err(502, f"related fetch failed: {exc}")

    related = [{
        "name": r["related_tag"], "category": r["category"],
        "cosine": r["cosine"], "jaccard": r["jaccard"], "overlap": r["overlap"],
    } for r in rows]
    return _ok({"query": q, "related": related, "synced_at": int(now), "stale": False})


# ─── Registration ──────────────────────────────────────────────────────────────

def register(server: Any, data_dir: Path) -> None:
    global _registered, _data_dir, _active_snapshot_path, _working_db_path, _settings_path

    if _registered:
        return
    _registered = True

    _data_dir = Path(data_dir)
    _data_dir.mkdir(parents=True, exist_ok=True)
    (_data_dir / "snapshots").mkdir(exist_ok=True)
    _settings_path = _data_dir / "settings.json"
    _working_db_path = _data_dir / "tagdb.sqlite"

    # Prefer the working DB; otherwise honour an explicit active snapshot, else newest.
    if _working_db_path.exists():
        _adopt_working_db()
    else:
        saved = _load_settings().get("active_snapshot", "")
        p = _resolve_snapshot_path(saved) if saved else None
        if p:
            _active_snapshot_path = p
        else:
            _try_auto_activate()

    r = server.routes
    r.get("/xyz/tagdb/search")(_handle_search)
    r.get("/xyz/tagdb/related")(_handle_related)
    r.get("/xyz/tagdb/artist_posts")(_handle_artist_posts)
    r.post("/xyz/tagdb/reconstruct")(_handle_reconstruct)
    r.get("/xyz/tagdb/snapshots")(_handle_snapshots_list)
    r.get("/xyz/tagdb/snapshots/active")(_handle_snapshots_get_active)
    r.post("/xyz/tagdb/snapshots/active")(_handle_snapshots_set_active)
    r.post("/xyz/tagdb/snapshots/export")(_handle_snapshots_export)
    r.get("/xyz/tagdb/settings")(_handle_settings_get)
    r.post("/xyz/tagdb/settings")(_handle_settings_post)
    r.get("/xyz/tagdb/official/check")(_handle_official_check)
    r.post("/xyz/tagdb/official/download")(_handle_official_download)
    r.post("/xyz/tagdb/maintain")(_handle_maintain_start)
    r.get("/xyz/tagdb/maintain/status")(_handle_maintain_status)
    r.post("/xyz/tagdb/maintain/cancel")(_handle_maintain_cancel)

    active = _active_db()
    logger.info("[TagDB] Routes registered. Active DB: %s",
                active.name if active else "none")


def _try_auto_activate() -> None:
    """Activate the newest available snapshot, if any (no working DB present)."""
    global _active_snapshot_path
    from . import repo as _repo
    snaps = _repo.list_snapshots(_data_dir)
    if snaps:
        _active_snapshot_path = Path(snaps[0]["path"])
        logger.info("[TagDB] Auto-activated newest snapshot: %s", _active_snapshot_path.name)
