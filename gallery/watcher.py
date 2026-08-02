"""XYZ Image Gallery — per-root ``watchdog`` Observers + ``Coalescer`` (T20).

FS events (debounced + coalesced) hand off to ``indexer.index_one`` /
``indexer.delete_one``.  Overflow → ``indexer.delta_scan`` (SPEC §8.2 /
TASKS T20).  WS 广播经 ``service`` 薄封装。
"""

from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Set, Tuple, TYPE_CHECKING

if TYPE_CHECKING:
    from .repo import WriteQueue  # noqa: F401

logger = logging.getLogger("xyz.gallery.watcher")

__all__ = [
    "Coalescer",
    "merge_watcher_state",
    "register_moved_subtree_bypass",
    "start_file_watchers",
    "stop_file_watchers",
    "start_heartbeat",
    "stop_heartbeat",
]

# After ``RelocateFolderSubtree`` + Reconcile, the API already matches DB to
# disk. Watchdog will still emit delete+create per file; we skip d/u for the
# exact same paths to mirror bulk move (no redundant ``index_one``/``delete``).
_moved_bypass: List[Tuple[frozenset, frozenset, float]] = []
_moved_bypass_lock = threading.Lock()
MOVED_SUBTREE_BYPASS_TTL_S: float = 20.0


def register_moved_subtree_bypass(
    old_paths: Set[str] | None,
    new_paths: Set[str] | None,
    *,
    ttl_s: float = MOVED_SUBTREE_BYPASS_TTL_S,
) -> None:
    """Let the coalescer drop ``d``/``u`` for paths from a just-completed
    in-app folder subtree move/rename (``RelocateFolderSubtree`` already ran).
    """
    o = frozenset(str(x) for x in (old_paths or ()))
    n = frozenset(str(x) for x in (new_paths or ()))
    if not o and not n:
        return
    until = time.monotonic() + max(1.0, float(ttl_s))
    with _moved_bypass_lock:
        t = time.monotonic()
        # Drop expired
        _moved_bypass[:] = [x for x in _moved_bypass if x[2] > t]
        _moved_bypass.append((o, n, until))


def _bypasses_watcher_path_event(last_path: str, ev: str) -> bool:
    from . import repo as _repo

    t = time.monotonic()
    pn = _repo._norm_fs_path(str(last_path))
    e = (ev or "").lower()
    with _moved_bypass_lock:
        i = 0
        while i < len(_moved_bypass):
            so, sn, until = _moved_bypass[i]
            if until < t:
                _moved_bypass.pop(i)
                continue
            if e == "d" and so and pn in so:
                return True
            if e == "u" and sn and pn in sn:
                return True
            i += 1
    return False

_IMAGE_EXTS: frozenset = frozenset({".png", ".jpg", ".jpeg", ".webp"})

# ---- T25: coalescer counters (reset when heartbeat writes audit stats) ----

_coalescer_events_seen: int = 0
_coalescer_rows_flushed: int = 0


def _note_coalescer_event() -> None:
    global _coalescer_events_seen
    _coalescer_events_seen += 1


def _note_coalescer_flush(n: int) -> None:
    global _coalescer_rows_flushed
    _coalescer_rows_flushed += int(n)


def snapshot_coalescer_stats_for_audit() -> Tuple[int, int]:
    """Return ``(events_seen, rows_flushed)`` since last snapshot and zero both."""
    global _coalescer_events_seen, _coalescer_rows_flushed
    ev, rw = _coalescer_events_seen, _coalescer_rows_flushed
    _coalescer_events_seen = 0
    _coalescer_rows_flushed = 0
    return ev, rw


def _fan_out_delta_scan_result(root: Dict[str, Any], st: Dict[str, Any]) -> None:
    """WS: deleted rows + optional drift envelope (T25)."""
    from . import service as _service
    from . import ws_hub as _ws_hub

    for iid in st.get("deleted_ids") or []:
        _service.broadcast_image_deleted(int(iid))
    ch = int(st.get("changed", 0))
    rm = int(st.get("removed", 0))
    if ch > 0 or rm > 0:
        _ws_hub.broadcast(
            _ws_hub.INDEX_DRIFT_DETECTED,
            {
                "root_id": int(root["id"]),
                "changed": ch,
                "removed": rm,
                "walked": int(st.get("walked", 0)),
            },
        )


def _is_image_name(name: str) -> bool:
    from . import metadata as _metadata

    if _metadata.is_gallery_atomic_temp_basename(name):
        return False
    ext = os.path.splitext(name)[1].lower()
    return ext in _IMAGE_EXTS


def _is_derivative_excluded_path(path: str, root_path: str) -> bool:
    from . import indexer as _indexer

    return _indexer.is_derivative_path_excluded(path, root_path)


# ---- SPEC 8.2 merge (created+modified → upsert; created+delete → drop) ----


def merge_watcher_state(
    prior: Optional[str], event: str,
) -> Optional[str]:
    """``event`` 与 ``merge`` 输入为 ``'u'``(upsert) 或 ``'d'``(delete)."""
    e = (event or "").lower()
    if e not in ("u", "d"):
        raise ValueError("merge_watcher_state: expected 'u' or 'd'")
    if prior is None:
        return e
    if prior == "u" and e == "d":
        return None
    if prior == "d" and e == "u":
        return "u"
    return e


# ---- one delta at a time per root ----------------------------------------


class _DeltaArmer:
    def __init__(self, *, root: Dict[str, Any], db_path: Any, write_queue: Any) -> None:
        self._root = root
        self._db_path = db_path
        self._write_queue = write_queue
        self._lock = threading.Lock()
        self._running = False
        self._pending_again = False

    def request(self) -> None:
        with self._lock:
            if self._running:
                self._pending_again = True
                return
            self._running = True
        t = threading.Thread(
            target=self._run, name="xyz-gallery-watcher-deltascan", daemon=True,
        )
        t.start()

    def _run(self) -> None:
        from . import indexer as _indexer
        while True:
            try:
                # No ``job_id``: a full-tree walk can take minutes and would steal
                # the ProgressModal from the file-watcher session (T44). Drift
                # still goes out via ``_fan_out_delta_scan_result`` / index.drift.
                st = _indexer.delta_scan(
                    self._root, db_path=self._db_path, write_queue=self._write_queue,
                    job_id=None,
                )
                _fan_out_delta_scan_result(self._root, st)
            except Exception:
                logger.exception("delta_scan failed (root_id=%s)", self._root.get("id"))
            with self._lock:
                if not self._pending_again:
                    self._running = False
                    return
                self._pending_again = False


@dataclass
class _Pending:
    act: str  # 'u' or 'd'
    path: str
    t_mono: float


class Coalescer:
    """In-memory coalescer: 250 ms 沉寂后刷出、每批 ≤50 条、≥500 溢出。"""

    DEBOUNCE_S: float = 0.25
    FLUSH_MAX: int = 50
    # Each move ≈2 keys (delete+upsert). 500 overflowed on ~250 files and
    # started a full-tree ``delta_scan`` with its own T44 job, hijacking the UI.
    HIGH_WATERMARK: int = 2048
    _TICK_S: float = 0.05
    # Match ``T44_BULK_MODAL_MIN_ROWS`` (stores/galleryProgress.js): no modal for
    # tiny flushes; bulk moves/renames typically exceed this.
    WATCHER_PROGRESS_MIN: int = 12
    # After the last op in a run, wait this long (empty buffer) before
    # ``index.done`` — a second batch of OS events (large moves) can arrive
    # seconds later; merge them into the same job instead of two modals.
    WATCHER_SESSION_END_DELAY_S: float = 2.5

    def __init__(self, *, root: Dict[str, Any], db_path: Any, write_queue: Any, delta: _DeltaArmer) -> None:
        self._root = root
        self._db_path = db_path
        self._write_queue = write_queue
        self._delta = delta
        self._lock = threading.Lock()
        self._buf: Dict[str, _Pending] = {}
        self._stop = threading.Event()
        self._tick = threading.Thread(
            target=self._supervised_tick_loop,
            name="xyz-gallery-coalescer",
            daemon=True,
        )
        self._folder_mono: Optional[float] = None
        self._watcher_job_id: Optional[str] = None
        self._watcher_cum_done: int = 0
        self._watcher_cum_planned: int = 0
        self._watcher_end_timer: Optional[threading.Timer] = None

    def start(self) -> None:
        self._tick.start()

    def request_stop(self) -> None:
        self._stop.set()

    def join_tick(self, timeout: Optional[float] = 2.0) -> None:
        self._tick.join(timeout=timeout)

    def add(self, key: str, last_path: str, ev: str) -> None:
        """``ev`` ∈ ``'u'`` (upsert) 或 ``'d'`` (delete).  ``key``= indexer 去重 key。"""
        if _bypasses_watcher_path_event(str(last_path), str(ev)):
            return
        _note_coalescer_event()
        do_overflow = False
        with self._lock:
            p = self._buf.get(key)
            prior = p.act if p is not None else None
            m = merge_watcher_state(prior, ev)
            if m is None:
                self._buf.pop(key, None)
            else:
                self._buf[key] = _Pending(
                    act=m, path=last_path, t_mono=time.monotonic())
            n = len(self._buf)
            if n >= self.HIGH_WATERMARK:
                self._buf.clear()
                do_overflow = True
        if do_overflow:
            from . import job_registry as _jobs
            from . import service as _service
            with self._lock:
                wjid = self._watcher_job_id
                r_id = int(self._root["id"])
                self._watcher_job_id = None
                self._watcher_cum_done = 0
                self._watcher_cum_planned = 0
            if wjid is not None:
                _jobs.emit_index_done(
                    str(wjid), root_id=r_id, phase="", ok=0, failed=1,
                )
            _service.broadcast_index_overflow(int(self._root["id"]))
            self._delta.request()
            logger.info("coalescer overflow → delta_scan (root_id=%s)", self._root.get("id"))
        self._cancel_watcher_end_timer()

    def mark_folder_reconcile(self) -> None:
        with self._lock:
            self._folder_mono = time.monotonic()

    def _cancel_watcher_end_timer(self) -> None:
        t = self._watcher_end_timer
        if t is not None:
            try:
                t.cancel()
            except Exception:  # noqa: BLE001
                pass
            self._watcher_end_timer = None

    def _schedule_watcher_end_timer(self) -> None:
        self._cancel_watcher_end_timer()
        t = threading.Timer(
            self.WATCHER_SESSION_END_DELAY_S,
            self._watcher_on_idle,
        )
        t.daemon = True
        self._watcher_end_timer = t
        t.start()

    def _watcher_on_idle(self) -> None:
        from . import indexer as _indexer
        from . import job_registry as _jobs

        jid: Optional[str] = None
        r_id: int = int(self._root["id"])
        with self._lock:
            self._watcher_end_timer = None
            if not self._watcher_job_id:
                return
            if self._buf:
                self._schedule_watcher_end_timer()
                return
            jid = str(self._watcher_job_id)
            self._watcher_job_id = None
            self._watcher_cum_done = 0
            self._watcher_cum_planned = 0
        # Folder `image_count_*` in SQLite must match the image table *before* the
        # client leaves the progress modal, or the tree keeps ticking after "done".
        _indexer.reconcile_folders_under_root_block(
            self._root,
            db_path=self._db_path,
            write_queue=self._write_queue,
        )
        _jobs.emit_index_done(
            jid, root_id=r_id, phase="", ok=1, failed=0,
        )

    _CRASH_RESTART_SLEEP_S: float = 1.0

    def _supervised_tick_loop(self) -> None:
        """Restart ``_tick_loop`` if it ever escapes, mirroring ``WriteQueue``.

        A dead coalescer is invisible: watchdog keeps delivering events and
        ``add()`` keeps buffering them, but nothing ever flushes, so the whole
        gallery silently downgrades to the 30 s heartbeat ``delta_scan`` until
        ComfyUI is restarted.  Losing the loop must be loud and temporary.
        """
        while not self._stop.is_set():
            try:
                self._tick_loop()
                return
            except Exception:
                logger.exception(
                    "coalescer tick loop crashed; restarting (root_id=%s)",
                    self._root.get("id"),
                )
                if self._stop.wait(self._CRASH_RESTART_SLEEP_S):
                    return

    def _flush_one(self, pend: _Pending) -> None:
        """Apply one coalesced event.  Raises only on genuinely unexpected errors."""
        from . import indexer as _indexer
        from . import service as _service

        if pend.act == "d":
            iid = _indexer.delete_one(
                pend.path,
                db_path=self._db_path,
                write_queue=self._write_queue,
            )
            if iid is not None:
                _service.broadcast_image_deleted(int(iid))
            return
        if not _is_image_name(os.path.basename(pend.path)):
            return
        if _is_derivative_excluded_path(pend.path, str(self._root["path"])):
            return
        iid = _indexer.index_one(
            pend.path, root=self._root,
            db_path=self._db_path,
            write_queue=self._write_queue,
        )
        if iid is not None:
            _service.broadcast_image_upserted(int(iid))

    def _tick_loop(self) -> None:
        from . import indexer as _indexer
        from . import job_registry as _jobs

        while not self._stop.is_set():
            if self._stop.wait(self._TICK_S):
                break
            now = time.monotonic()
            with self._lock:
                to_flush = [
                    (k, v) for k, v in self._buf.items()
                    if now - v.t_mono >= self.DEBOUNCE_S
                ]
                for k, _ in to_flush:
                    self._buf.pop(k, None)
            if to_flush:
                _note_coalescer_flush(len(to_flush))
            nflush = len(to_flush)
            root_id = int(self._root["id"])
            w_msg = "Syncing file system changes"
            wjid: Optional[str] = None
            if nflush:
                in_sess = self._watcher_job_id is not None
                if in_sess or nflush >= self.WATCHER_PROGRESS_MIN:
                    with self._lock:
                        if self._watcher_job_id is not None:
                            wjid = str(self._watcher_job_id)
                            self._watcher_cum_planned += nflush
                            planned = int(self._watcher_cum_planned)
                            done0 = int(self._watcher_cum_done)
                        else:
                            wjid = str(_jobs.new_job_id())
                            self._watcher_job_id = wjid
                            self._watcher_cum_done = 0
                            self._watcher_cum_planned = int(nflush)
                            planned = int(nflush)
                            done0 = 0
                    if in_sess and self._watcher_job_id and done0 < planned:
                        _jobs.emit_index_progress(
                            wjid,
                            done=done0,
                            total=planned,
                            root_id=root_id,
                            phase="",
                            message=w_msg,
                        )
                    if not in_sess and wjid:
                        _jobs.start_index_job(
                            wjid,
                            kind="index",
                            root_id=root_id,
                            phase="",
                            message=w_msg,
                            total=planned,
                        )
            try:
                for i in range(0, nflush, self.FLUSH_MAX):
                    chunk = to_flush[i: i + self.FLUSH_MAX]
                    for _k, pend in chunk:
                        try:
                            self._flush_one(pend)
                        except Exception:
                            # One unreadable file — or a transient "database is
                            # locked" from a second writer — must never take the
                            # thread down with it.  Skip the item, keep the loop.
                            logger.exception(
                                "watcher flush failed (root_id=%s): %s",
                                self._root.get("id"), pend.path,
                            )
                        # Progress still advances for a failed item, or the job
                        # never reaches done == planned and the modal hangs.
                        if self._watcher_job_id is not None:
                            with self._lock:
                                self._watcher_cum_done += 1
                                cd = int(self._watcher_cum_done)
                                cp = int(self._watcher_cum_planned)
                                jcur = str(self._watcher_job_id)
                            if (
                                cd == 1
                                or cd == cp
                                or (cd % 10 == 0 and cd < cp)
                            ):
                                _jobs.emit_index_progress(
                                    jcur,
                                    done=cd,
                                    total=cp,
                                    root_id=root_id,
                                    phase="",
                                    message=w_msg,
                                )
            finally:
                if nflush and self._watcher_job_id is not None:
                    self._schedule_watcher_end_timer()

            with self._lock:
                fm = self._folder_mono
                if fm is not None and now - fm >= self.DEBOUNCE_S:
                    self._folder_mono = None
                    do_folder = True
                else:
                    do_folder = False
            if do_folder:
                try:
                    _indexer.reconcile_folders_under_root(
                        self._root,
                        db_path=self._db_path,
                        write_queue=self._write_queue,
                    )
                except Exception:
                    logger.exception(
                        "folder reconcile failed root_id=%s", self._root.get("id"),
                    )

_OBS: List[Any] = []
_CLS: List[Coalescer] = []
_WSTARTED: bool = False
_HEARTBEAT: Optional["HeartbeatThread"] = None


class HeartbeatThread:
    """30 s light ``delta_scan`` per root + 5 min audit stats line (T25)."""

    INTERVAL_S: float = 30.0
    STATS_INTERVAL_S: float = 300.0

    def __init__(self, *, db_path: Any, write_queue: Any) -> None:
        self._db_path = db_path
        self._write_queue = write_queue
        self._stop = threading.Event()
        self._thr: Optional[threading.Thread] = None
        self._scans_done: int = 0
        self._drifts_found: int = 0

    def start(self) -> None:
        if self._thr is not None and self._thr.is_alive():
            return
        self._stop.clear()
        self._thr = threading.Thread(
            target=self._loop, name="xyz-gallery-heartbeat", daemon=True,
        )
        self._thr.start()

    def stop(self, *, timeout: float = 3.0) -> None:
        self._stop.set()
        if self._thr is not None:
            self._thr.join(timeout=timeout)
            self._thr = None

    def _loop(self) -> None:
        from . import audit as _audit
        from . import folders as _folders
        from . import indexer as _indexer
        import time as _time

        last_audit = _time.monotonic()
        while not self._stop.wait(self.INTERVAL_S):
            self._scans_done += 1
            try:
                roots = _folders.list_roots(db_path=self._db_path)
            except Exception:
                logger.exception("HeartbeatThread list_roots failed")
                roots = []
            for root in roots:
                try:
                    st = _indexer.delta_scan(
                        root,
                        db_path=self._db_path,
                        write_queue=self._write_queue,
                        mode="light",
                    )
                    _fan_out_delta_scan_result(root, st)
                    if int(st.get("changed", 0)) + int(st.get("removed", 0)) > 0:
                        self._drifts_found += 1
                except Exception:
                    logger.exception(
                        "HeartbeatThread delta_scan root_id=%s",
                        root.get("id"),
                    )
            now = _time.monotonic()
            if now - last_audit >= self.STATS_INTERVAL_S:
                last_audit = now
                ev, co = snapshot_coalescer_stats_for_audit()
                _audit.log_heartbeat_stats(
                    events_seen=ev,
                    rows_coalesced=co,
                    scans_done=self._scans_done,
                    drifts_found=self._drifts_found,
                )


def start_heartbeat(*, db_path: Any, write_queue: Any) -> None:
    global _HEARTBEAT
    if _HEARTBEAT is not None:
        return
    _HEARTBEAT = HeartbeatThread(db_path=db_path, write_queue=write_queue)
    _HEARTBEAT.start()
    logger.info("gallery HeartbeatThread started")


def stop_heartbeat() -> None:
    global _HEARTBEAT
    if _HEARTBEAT is None:
        return
    _HEARTBEAT.stop()
    _HEARTBEAT = None
    logger.info("gallery HeartbeatThread stopped")


def _in_root(path: str, root_path: str) -> bool:
    r = os.path.normcase(os.path.normpath(root_path))
    try:
        p = os.path.normcase(os.path.normpath(path))
    except (OSError, TypeError, ValueError):
        return False
    rds = r if (r.endswith(os.sep) or len(r) == 3) else (r + os.sep)
    return p == r or p.startswith(rds)


def _as_key(path: str) -> str:
    return os.path.normcase(os.path.realpath(str(path)))


def _make_handler(coalescer: Coalescer, root_path: str) -> Any:
    from watchdog.events import (
        FileSystemEventHandler, FileCreatedEvent, FileModifiedEvent, FileDeletedEvent,
    )
    c = coalescer
    r = root_path

    def _dir_reconcile_if_tracked(dir_path: str) -> None:
        if not _in_root(dir_path, r):
            return
        probe = os.path.join(dir_path, ".__probe__.png")
        if _is_derivative_excluded_path(probe, r):
            return
        c.mark_folder_reconcile()

    class _H(FileSystemEventHandler):
        def on_moved(
            _self, event,  # noqa: N802
        ) -> None:  # type: ignore[no-untyped-def]
            if event.is_directory:
                src, dst = str(event.src_path or ""), str(event.dest_path or "")
                if src:
                    _dir_reconcile_if_tracked(src)
                if dst:
                    _dir_reconcile_if_tracked(dst)
                return
            src, dst = str(event.src_path or ""), str(event.dest_path or "")
            if src and _in_root(src, r):
                c.add(_as_key(src), src, "d")
            if dst and _in_root(dst, r) and not _is_derivative_excluded_path(
                dst, r,
            ) and _is_image_name(os.path.basename(dst)):
                c.add(_as_key(dst), dst, "u")

        def on_created(
            _self, event,  # noqa: N802
        ) -> None:  # type: ignore[no-untyped-def]
            if not isinstance(event, FileCreatedEvent):
                return
            if event.is_directory:
                _dir_reconcile_if_tracked(str(event.src_path))
                return
            p = str(event.src_path)
            if not _in_root(p, r) or _is_derivative_excluded_path(p, r):
                return
            if not _is_image_name(os.path.basename(p)):
                return
            c.add(_as_key(p), p, "u")

        def on_modified(
            _self, event,  # noqa: N802
        ) -> None:  # type: ignore[no-untyped-def]
            if not isinstance(event, FileModifiedEvent) or event.is_directory:
                return
            p = str(event.src_path)
            if not _in_root(p, r) or _is_derivative_excluded_path(p, r):
                return
            if not _is_image_name(os.path.basename(p)):
                return
            c.add(_as_key(p), p, "u")

        def on_deleted(
            _self, event,  # noqa: N802
        ) -> None:  # type: ignore[no-untyped-def]
            if not isinstance(event, FileDeletedEvent):
                return
            p = str(event.src_path)
            if not _in_root(p, r):
                return
            if event.is_directory:
                _dir_reconcile_if_tracked(p)
                return
            if _is_derivative_excluded_path(p, r):
                return
            c.add(_as_key(p), p, "d")

    return _H()  # type: ignore[no-any-return]


def start_file_watchers(
    *, db_path: Any, write_queue: Any,
) -> None:
    global _WSTARTED
    if _WSTARTED:
        return
    try:
        from watchdog.observers import Observer
    except Exception:
        logger.warning("watchdog not importable; file watchers disabled")
        return
    from . import folders as _folders

    roots = _folders.list_roots(db_path=db_path)
    for root in roots:
        delta = _DeltaArmer(root=root, db_path=db_path, write_queue=write_queue)
        c = Coalescer(root=root, db_path=db_path, write_queue=write_queue, delta=delta)
        c.start()
        _CLS.append(c)
        rpath = str(root["path"])
        h = _make_handler(c, rpath)
        o = Observer()
        o.schedule(h, rpath, recursive=True)
        o.start()
        _OBS.append(o)
    _WSTARTED = True
    logger.info("file watcher started (%d root(s))", len(roots))


def stop_file_watchers() -> None:
    global _WSTARTED, _OBS, _CLS
    if not _WSTARTED:
        return
    for o in _OBS:
        try:
            o.stop()
        except Exception:
            logger.debug("Observer.stop", exc_info=True)
    for o in _OBS:
        try:
            o.join(timeout=1.0)
        except Exception:
            pass
    for c in _CLS:
        c.request_stop()
    for c in _CLS:
        c.join_tick()
    _OBS, _CLS = [], []
    _WSTARTED = False
