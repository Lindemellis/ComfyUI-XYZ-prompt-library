"""Tag DB — package init and ComfyUI setup hook.

Call setup(server) once during ComfyUI startup from the top-level __init__.py.

Data lives in tagdb_data/ (gitignored):
  danbooru.sqlite          — the mutable danbooru WORKING DB (autocomplete reads it)
  gelbooru.sqlite          — the optional second-source DB (present iff installed)
  settings.json            — danbooru/gelbooru credentials, active read DB, etc.
  snapshots/official/      — immutable datasets downloaded from the GitHub Release
  snapshots/local/         — immutable user export checkpoints

(The working DB was named tagdb.sqlite before gelbooru was added; setup() renames
it to danbooru.sqlite on first launch — see _rename_legacy_working_db.)

First-run behaviour (NO auto-scrape):
  If there is no working DB yet, we DOWNLOAD the author's prebuilt dataset from
  the GitHub Release named in tagdb/official_manifest.json. If that fails (offline,
  or no dataset published yet), we log a clear message and stop — the user opens
  the Tag DB panel to retry the download or run a manual scrape after entering
  their danbooru login + api_key. We never silently start a long scrape.
"""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger("xyz.tagdb")

_PKG_DIR = Path(__file__).resolve().parent
DATA_DIR: Path = _PKG_DIR.parent / "tagdb_data"
WORKING_DB: Path = DATA_DIR / "danbooru.sqlite"   # renamed from tagdb.sqlite (see setup)

__all__ = ["setup", "DATA_DIR", "WORKING_DB"]


def setup(server) -> None:
    """Initialise data dirs, register HTTP routes, download dataset if first run."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "snapshots").mkdir(exist_ok=True)
    (DATA_DIR / "snapshots" / "official").mkdir(exist_ok=True)
    (DATA_DIR / "snapshots" / "local").mkdir(exist_ok=True)

    _rename_legacy_working_db()  # tagdb.sqlite → danbooru.sqlite (before routes open it)

    from .routes import register
    register(server, DATA_DIR)

    if not WORKING_DB.exists():
        _migrate_legacy_layout()
    if not WORKING_DB.exists():
        _spawn_first_run_download()

    logger.info("[TagDB] setup complete. Data dir: %s", DATA_DIR)


def _rename_legacy_working_db() -> None:
    """One-time rename of the working DB tagdb.sqlite → danbooru.sqlite (+wal/shm).

    The working DB was called tagdb.sqlite before gelbooru was added as a second
    source; danbooru.sqlite is symmetric with gelbooru.sqlite. No-op once renamed,
    or if the legacy file is absent. Runs at startup before any DB handle is opened.
    """
    import os
    legacy = DATA_DIR / "tagdb.sqlite"
    if WORKING_DB.exists() or not legacy.exists():
        return
    for suffix in ("", "-wal", "-shm"):
        src = Path(str(legacy) + suffix)
        if src.exists():
            try:
                os.replace(src, Path(str(WORKING_DB) + suffix))
            except OSError as exc:
                logger.warning("[TagDB] Could not rename %s → %s: %s",
                               src.name, WORKING_DB.name, exc)
                return
    logger.info("[TagDB] Renamed working DB tagdb.sqlite → danbooru.sqlite")


def _migrate_legacy_layout() -> None:
    """Seed the working DB from a pre-existing flat snapshot (older installs).

    Non-destructive: copies the active (or newest) flat `snapshots/*.sqlite` to
    the working DB (danbooru.sqlite) and migrates it to the current schema. Original
    files are left in place; the routes layer relocates them to snapshots/local/ when
    it adopts the working-DB model.
    """
    import json
    import shutil

    snap_dir = DATA_DIR / "snapshots"
    flat = [p for p in snap_dir.glob("*.sqlite") if p.parent == snap_dir]
    if not flat:
        return

    chosen = None
    settings_path = DATA_DIR / "settings.json"
    if settings_path.exists():
        try:
            active = json.loads(settings_path.read_text("utf-8")).get("active_snapshot")
            if active:
                cand = snap_dir / active
                if cand.exists():
                    chosen = cand
        except Exception:
            pass
    if chosen is None:
        chosen = max(flat, key=lambda p: p.stat().st_mtime)

    try:
        shutil.copy(chosen, WORKING_DB)
        from . import db as _db
        conn = _db.connect_write(WORKING_DB)
        try:
            _db.migrate(conn)
            conn.execute(
                "INSERT INTO meta(key,value) VALUES('schema_kind','working') "
                "ON CONFLICT(key) DO UPDATE SET value='working'"
            )
        finally:
            conn.close()
        logger.info("[TagDB] Seeded working DB from legacy snapshot %s", chosen.name)
    except Exception:
        logger.exception("[TagDB] Legacy layout migration failed")


def _spawn_first_run_download() -> None:
    """Download the official dataset in the background (no scrape fallback)."""
    import json
    import threading

    manifest_url = None
    settings_path = DATA_DIR / "settings.json"
    if settings_path.exists():
        try:
            manifest_url = json.loads(settings_path.read_text("utf-8")).get("manifest_url") or None
        except Exception:
            pass

    def _run() -> None:
        from . import distribution as _dist
        from . import routes as _routes

        _routes._maintain_running = True
        _routes._maintain_log = ["[Auto] First run — checking for a prebuilt dataset..."]

        def _log(m: str) -> None:
            _routes._maintain_log.append(m)

        try:
            info = _dist.check_official(DATA_DIR, manifest_url)
            if not info.get("has_manifest") or not info.get("latest"):
                _log(
                    "[Auto] No prebuilt dataset is published yet. Open the Tag DB "
                    "panel to enter danbooru credentials and run a build, or wait "
                    "for the author to publish one. (No scrape was started.)"
                )
                return
            path = _dist.download_official(
                DATA_DIR, version=info["latest"], manifest_url=manifest_url,
                progress_cb=_log,
            )
            _dist.seed_working_db_from_official(path, WORKING_DB, version=info["latest"])
            _routes._adopt_working_db()
            _log(f"[Auto] Prebuilt dataset {info['latest']} installed and active.")
        except Exception as exc:
            _log(
                f"[Auto] Prebuilt dataset download failed: {exc}. "
                "Open the Tag DB panel to retry, or run a manual build with your "
                "danbooru credentials. (No scrape was started.)"
            )
            logger.exception("[TagDB] First-run download failed")
        finally:
            _routes._maintain_running = False

    threading.Thread(target=_run, daemon=True, name="tagdb-first-run").start()
