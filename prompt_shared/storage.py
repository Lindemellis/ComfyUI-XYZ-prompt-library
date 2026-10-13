"""Shared SQLite connections and single-writer transactions, without any schema."""
from __future__ import annotations

import itertools
import logging
import queue
import sqlite3
import threading
import time
from concurrent.futures import Future
from pathlib import Path
from typing import Any, Optional, Union

logger = logging.getLogger(__name__)
_STOP = object()
_CRASH_RESTART_SLEEP_SEC = 0.5

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


class WriteQueue:
    """Single-writer queue.  One op -> one BEGIN IMMEDIATE / COMMIT."""

    def __init__(self, db_path: _PathLike) -> None:
        self._db_path = Path(db_path)
        self._q: "queue.Queue[tuple[int, Any, Optional[Future]]]" = queue.Queue()
        self._seq = itertools.count()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()

    def enqueue(self, op: Any) -> Future:
        if not hasattr(op, "apply"):
            raise TypeError("op must implement .apply(conn)")
        fut: Future = Future()
        self._q.put((next(self._seq), op, fut))
        return fut

    def start(self) -> None:
        with self._lock:
            if self._thread is not None and self._thread.is_alive():
                return
            self._stop.clear()
            self._thread = threading.Thread(
                target=self._supervised, name="xyz-prompt-writer", daemon=True
            )
            self._thread.start()

    def stop(self, timeout: float = 0.5) -> bool:
        with self._lock:
            t = self._thread
            if t is None:
                return True
            self._stop.set()
            self._q.put((-1, _STOP, None))
        t.join(timeout=timeout)
        if not t.is_alive():
            with self._lock:
                self._thread = None
            return True
        return False

    def _supervised(self) -> None:
        while not self._stop.is_set():
            try:
                self._loop()
                return
            except Exception:  # pragma: no cover - defensive
                logger.exception("prompt writer loop crashed; restarting")
                time.sleep(_CRASH_RESTART_SLEEP_SEC)

    def _loop(self) -> None:
        conn = connect_write(self._db_path)
        try:
            while not self._stop.is_set():
                _seq, op, fut = self._q.get(block=True)
                if op is _STOP:
                    return
                self._run(conn, op, fut)
        finally:
            try:
                conn.close()
            except Exception:  # pragma: no cover
                logger.exception("error closing prompt write connection")

    def _run(self, conn: sqlite3.Connection, op: Any, fut: Optional[Future]) -> None:
        open_tx = False
        try:
            conn.execute("BEGIN IMMEDIATE")
            open_tx = True
            result = op.apply(conn)
            conn.execute("COMMIT")
            open_tx = False
            if fut is not None and not fut.done():
                fut.set_result(result)
        except BaseException as exc:
            if open_tx:
                try:
                    conn.execute("ROLLBACK")
                except Exception:  # pragma: no cover
                    logger.exception("ROLLBACK failed")
            if fut is not None and not fut.done():
                fut.set_exception(exc)
            if not isinstance(exc, Exception):
                raise


