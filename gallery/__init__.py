"""XYZ Image Gallery — database, routes, indexers and background services."""

from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger("xyz.gallery")

_PACKAGE_ROOT: Path = Path(__file__).resolve().parent.parent
DATA_DIR: Path = _PACKAGE_ROOT / "gallery_data"
THUMBS_DIR: Path = DATA_DIR / "thumbs"
DB_PATH: Path = DATA_DIR / "gallery.sqlite"

_initialized: bool = False
_write_queue = None  # gallery.repo.WriteQueue, lazily created in start_background_services()


def _ensure_data_layout() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    DB_PATH.touch(exist_ok=True)
    from . import audit as _audit

    _audit.configure(data_dir=DATA_DIR)


def start_background_services() -> None:
    # T04: bring up the single-writer queue. metadata_sync / watcher / etc.
    # attach here in later tasks.
    global _write_queue
    from . import repo as _repo

    if _write_queue is None:
        _write_queue = _repo.WriteQueue(DB_PATH)
    _write_queue.start()
    # T08: 10 s periodic thumbnail_cache.last_accessed flusher. First
    # long-running daemon *after* WriteQueue itself — must be attached
    # to both start and stop hooks per PROJECT_STATE §4 #17.
    from . import thumbs as _thumbs
    _thumbs.start_touch_flusher(write_queue=_write_queue)
    from . import metadata_sync as _metadata_sync
    _metadata_sync.start_metadata_sync_worker(
        db_path=DB_PATH, write_queue=_write_queue,
    )


def stop_background_services() -> None:
    global _write_queue
    # Reverse startup order: stop producers before the WriteQueue closes.
    from . import metadata_sync as _metadata_sync
    _metadata_sync.stop_metadata_sync_worker()
    from . import watcher as _watcher
    _watcher.stop_heartbeat()
    _watcher.stop_file_watchers()
    from . import thumbs as _thumbs
    _thumbs.stop_touch_flusher()
    if _write_queue is not None:
        _write_queue.stop()


def setup(app=None) -> None:
    """Idempotent assembly hook. Safe to call multiple times."""
    global _initialized
    _ensure_data_layout()
    if not _initialized:
        from server import PromptServer  # local import: avoid module-load coupling
        from . import db as _db
        from . import folders as _folders
        from . import routes as _routes

        _conn = _db.connect_write(DB_PATH)
        try:
            _db.migrate(_conn)
        finally:
            _conn.close()
        _routes.register(PromptServer.instance)
        start_background_services()
        # T05: seed default `output` / `input` rows + materialise an empty
        # gallery_config.json. Must run AFTER start_background_services()
        # because the seed write goes through the WriteQueue (the only
        # legal write path; PROJECT_STATE §4 #15 / AI_RULES R5.5).
        _folders.ensure_default_roots(
            db_path=DB_PATH,
            data_dir=DATA_DIR,
            write_queue=_write_queue,
        )
        from . import indexer as _indexer
        _indexer.maybe_rebuild_prompt_vocab_from_config(
            db_path=DB_PATH,
            data_dir=DATA_DIR,
            write_queue=_write_queue,
        )
        # T07: kick off the first-run full index of every registered root
        # in a daemon thread. Must run AFTER ensure_default_roots so the
        # root rows exist; scan itself is non-blocking — NFR-1 budget
        # (PROJECT_STATE §5 "启动被 gallery 阻塞 ≤ 50 ms") only counts
        # the thread-start cost, not the walk.
        _indexer.schedule_cold_scan_all(
            db_path=DB_PATH,
            write_queue=_write_queue,
        )
        from . import watcher as _watcher
        _watcher.start_file_watchers(db_path=DB_PATH, write_queue=_write_queue)
        _watcher.start_heartbeat(db_path=DB_PATH, write_queue=_write_queue)
        _initialized = True
        logger.info("XYZ Gallery initialized (data dir: %s)", DATA_DIR)


__all__ = [
    "DATA_DIR",
    "THUMBS_DIR",
    "DB_PATH",
    "setup",
    "start_background_services",
    "stop_background_services",
]
