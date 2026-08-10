"""XYZ Image Gallery — on-demand thumbnail generation + LRU bookkeeping (T08).

Scope (per TASKS.md T08 + PROJECT_STATE §7):

* ``request(image_id, ...)`` — cache-on-miss thumbnail generation. Hits
  disk if a .webp already exists; otherwise builds one with Pillow
  (320×320 cover, WebP q=78) and records a bookkeeping row via the
  shared ``repo.WriteQueue``. Concurrent requests for the same
  ``hash_key`` share a single ``Future`` so 1000 simultaneous calls
  produce exactly one .webp (SPEC §8.3 "同 key 串行" / TASKS T08 #4).
* ``touch(hash_key)`` — buffer a ``last_accessed`` bump in a bounded
  in-memory set; the flusher thread coalesces 10 s worth of hits into
  a single ``executemany`` to keep the /thumb hot path off WriteQueue.
* ``start_touch_flusher`` / ``stop_touch_flusher`` — lifecycle hooks
  mirroring PROJECT_STATE §4 #17: this is the first long-running
  gallery daemon after ``WriteQueue`` itself, so it must be both
  ``start()``ed and ``stop()``ped by ``gallery/__init__``.

Boundaries (AI_RULES R5.5 / §4 #15):
* All writes go through ``repo.enqueue_write(LOW, ...)`` — never a
  direct ``cursor.execute`` on a write connection.
* Only *reads* touch SQLite directly (``db.connect_read`` for the
  one-column image lookup); consistent with ``indexer.py`` precedent
  since ``repo`` read APIs are T09's scope, not T08.
* LIFO viewport scheduling / LRU eviction / janitor — T26. Here the
  scheduler is strictly "correctness-level" serialisation per key;
  prioritisation is deliberately unordered.
"""

from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
from concurrent.futures import Future
from pathlib import Path
from typing import Dict, Optional, Set, Tuple, Union

from PIL import Image, UnidentifiedImageError

from . import db as _db
from . import repo as _repo
from . import video as _video

logger = logging.getLogger("xyz.gallery.thumbs")

__all__ = [
    "request",
    "touch",
    "hash_key_for",
    "thumb_path_for",
    "start_touch_flusher",
    "stop_touch_flusher",
]

_PathLike = Union[str, Path]

# 320×320 cover crop, WebP q=78 — SPEC §8.3 verbatim. Do NOT widen these
# knobs without a SPEC change first (AI_RULES R5.2).
_THUMB_SIZE: int = 320
_WEBP_QUALITY: int = 78
_RESAMPLE = Image.Resampling.LANCZOS

# Touch-flush daemon cadence. 10 s of stale last_accessed is irrelevant
# for an LRU whose budget is measured in days (§8.3), and batching saves
# 1000+ synchronous writes per viewport scroll.
_TOUCH_FLUSH_INTERVAL_SEC: float = 10.0

# Bounded in-memory set (R7.4 / PROJECT_STATE §7 note 7): over-cap
# touches are silently dropped. Each forthcoming /thumb hit or thumb
# (re-)generation will re-add the key post-flush, so the worst a drop
# can do is delay an LRU hint by one 10 s window.
_TOUCH_SET_MAX: int = 10_000

_touch_set: Set[str] = set()
_touch_lock: threading.Lock = threading.Lock()

# Corrupt / zero-byte sources still appear in ``image`` after cold scan
# (T07 fixtures).  Grid polling can hammer ``/thumb`` — log at warning
# without a traceback, and throttle per source path (R7.4 bounded dict).
_THUMB_GEN_FAIL_LOG_INTERVAL_SEC: float = 120.0
_thumb_gen_fail_last: Dict[str, float] = {}
_thumb_gen_fail_lock = threading.Lock()


def _log_thumb_gen_failure(src_path: str, exc: BaseException) -> None:
    now = time.time()
    with _thumb_gen_fail_lock:
        last = _thumb_gen_fail_last.get(src_path, 0.0)
        if now - last < _THUMB_GEN_FAIL_LOG_INTERVAL_SEC:
            return
        _thumb_gen_fail_last[src_path] = now
        if len(_thumb_gen_fail_last) > 512:
            _thumb_gen_fail_last.clear()
    logger.warning(
        "thumbs: failed to generate thumbnail for %s (%s: %s)",
        src_path,
        type(exc).__name__,
        exc,
    )

# Per-hash-key dedup registry. Entries are popped as soon as the
# generating call finishes, so the dict is naturally bounded by the
# number of *currently-generating* thumbs (not by total library size).
_inflight: Dict[str, "Future[Optional[Path]]"] = {}
_inflight_lock: threading.Lock = threading.Lock()

# Flusher singleton state.
_flusher_thread: Optional[threading.Thread] = None
_flusher_stop: threading.Event = threading.Event()
_flusher_lock: threading.Lock = threading.Lock()


# -- key / layout helpers ---------------------------------------------------

def hash_key_for(posix_path: str, mtime_ns: int) -> str:
    """``sha1(path + mtime_ns)`` — the disk-cache key (SPEC §6.1 / §8.3).

    Feeding mtime_ns in is how content changes invalidate the cache
    without any extra bookkeeping: a new mtime produces a new key and
    therefore a new .webp path, so T10's ``?v=<mtime_ns>`` URL pattern
    behaves as a cache-buster for free.
    """
    h = hashlib.sha1()
    h.update(posix_path.encode("utf-8"))
    h.update(str(int(mtime_ns)).encode("ascii"))
    return h.hexdigest()


def thumb_path_for(hash_key: str, thumbs_dir: _PathLike) -> Path:
    """2-char shard under ``thumbs_dir`` to dodge FS directory-size walls."""
    return Path(thumbs_dir) / hash_key[:2] / f"{hash_key}.webp"


# -- per-image lookup -------------------------------------------------------

def _load_image_row(
    db_path: _PathLike, image_id: int,
) -> Optional[Tuple[str, int]]:
    """Return ``(posix_path, mtime_ns)`` for the given image, or None."""
    conn = _db.connect_read(db_path)
    try:
        row = conn.execute(
            "SELECT path, mtime_ns FROM image WHERE id = ?",
            (int(image_id),),
        ).fetchone()
    finally:
        conn.close()
    if row is None or row["path"] is None or row["mtime_ns"] is None:
        return None
    return str(row["path"]), int(row["mtime_ns"])


# -- thumbnail synthesis ----------------------------------------------------

def _open_source_image(src_path: str):
    """A PIL image for ``src_path`` — decoded frame for video, file for image.

    Returned as a context manager either way so the caller's ``with`` block
    is identical; an extracted frame is already fully in memory, and PIL
    images support the protocol, so no wrapper is needed.
    """
    if not _video.is_video_path(src_path):
        return Image.open(src_path)
    frame = _video.extract_frame(src_path)
    if frame is None:
        # Same failure shape the image path produces for a corrupt file, so
        # ``_generate_and_save``'s except clause handles both identically.
        raise UnidentifiedImageError(
            f"no decodable video frame: {src_path}"
        )
    return frame


def _generate_and_save(src_path: str, dst_path: Path) -> Optional[int]:
    """Build a ``_THUMB_SIZE`` × ``_THUMB_SIZE`` cover-crop WebP.

    Returns the on-disk size in bytes on success, None on any failure.
    Uses write-to-temp + ``os.replace`` so a crash mid-encode cannot
    leave a partially-written .webp that a subsequent request would
    mistake for a cache hit.
    """
    tmp_path = dst_path.with_suffix(dst_path.suffix + ".tmp")
    try:
        with _open_source_image(src_path) as img:
            img.load()
            if img.mode not in ("RGB", "RGBA"):
                img = img.convert("RGBA" if "A" in img.getbands() else "RGB")
            w, h = img.size
            if w <= 0 or h <= 0:
                return None
            # Cover: scale so the shorter side reaches _THUMB_SIZE, then
            # centre-crop to the target square. Equivalent to CSS's
            # ``object-fit: cover`` done server-side (SPEC §8.3) so we
            # never ship oversized bytes to the grid.
            scale = max(_THUMB_SIZE / w, _THUMB_SIZE / h)
            new_w = max(_THUMB_SIZE, int(round(w * scale)))
            new_h = max(_THUMB_SIZE, int(round(h * scale)))
            scaled = img.resize((new_w, new_h), _RESAMPLE)
            left = (new_w - _THUMB_SIZE) // 2
            top = (new_h - _THUMB_SIZE) // 2
            cropped = scaled.crop(
                (left, top, left + _THUMB_SIZE, top + _THUMB_SIZE)
            )
            dst_path.parent.mkdir(parents=True, exist_ok=True)
            cropped.save(tmp_path, format="WEBP", quality=_WEBP_QUALITY)
        os.replace(tmp_path, dst_path)
        return int(dst_path.stat().st_size)
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        _log_thumb_gen_failure(src_path, exc)
        try:
            if tmp_path.exists():
                tmp_path.unlink()
        except OSError:
            pass
        return None


def _generate_and_record(
    *, image_id: int, src_posix: str, key: str, dst: Path, write_queue,
) -> Optional[Path]:
    size_bytes = _generate_and_save(src_posix, dst)
    if size_bytes is None:
        return None
    now = int(time.time())
    # Order matters: the .webp is already on disk above. Only after
    # that do we enqueue the cache row (§4.5 "先物理后入队"). If the
    # enqueue itself fails, we still return the path — the file is
    # usable, just unknown to the LRU table; T26's daily janitor will
    # reconcile orphans. Never the inverse (DB row but no file).
    op = _repo.InsertThumbCacheOp(
        hash_key=key, image_id=int(image_id),
        size_bytes=int(size_bytes),
        created_at=now, last_accessed=now,
    )
    try:
        write_queue.enqueue_write(_repo.LOW, op)
    except Exception:
        logger.exception(
            "thumbs: enqueue_write failed for image_id=%s hash=%s",
            image_id, key,
        )
    return dst


# -- public: request / touch ------------------------------------------------

def request(
    image_id: int, *,
    db_path: _PathLike,
    thumbs_dir: _PathLike,
    write_queue,
) -> Optional[Path]:
    """Return a path to the cached thumbnail, generating it if missing.

    Same-key de-duplication means a 1000-request storm for the same id
    produces exactly one generation (TASKS T08 #4); losers wait on the
    winner's ``Future``. Cross-key calls proceed in parallel — there is
    no global thumbnail lock.
    """
    row = _load_image_row(db_path, image_id)
    if row is None:
        return None
    src_posix, mtime_ns = row
    key = hash_key_for(src_posix, mtime_ns)
    dst = thumb_path_for(key, thumbs_dir)

    # Fast path: already materialised. A zero-byte file means the last
    # write aborted half-way; treat it as a miss and regenerate.
    try:
        if dst.is_file() and dst.stat().st_size > 0:
            touch(key)
            return dst
    except OSError:
        pass

    fut: "Future[Optional[Path]]"
    is_owner = False
    with _inflight_lock:
        existing = _inflight.get(key)
        if existing is not None:
            fut = existing
        else:
            fut = Future()
            _inflight[key] = fut
            is_owner = True

    if is_owner:
        try:
            result = _generate_and_record(
                image_id=image_id, src_posix=src_posix,
                key=key, dst=dst, write_queue=write_queue,
            )
        except BaseException as exc:
            fut.set_exception(exc)
        else:
            fut.set_result(result)
        finally:
            with _inflight_lock:
                _inflight.pop(key, None)

    result = fut.result()
    if result is not None:
        # Every served hit counts as an access — whether or not we were
        # the generator. Winners already paid the INSERT, so this just
        # schedules a cheap last_accessed bump.
        touch(key)
    return result


def touch(hash_key: str) -> None:
    """Buffer a ``last_accessed`` bump; coalesced by the flusher thread."""
    with _touch_lock:
        if len(_touch_set) >= _TOUCH_SET_MAX:
            return
        _touch_set.add(hash_key)


def _drain_touch_set() -> Set[str]:
    with _touch_lock:
        drained = set(_touch_set)
        _touch_set.clear()
    return drained


# -- flusher op + daemon ----------------------------------------------------

class _TouchFlushOp:
    """Coalesced ``UPDATE ... last_accessed`` for every buffered key.

    Uses ``executemany`` so a 1000-key batch is still one BEGIN/COMMIT
    round-trip on the writer thread. Unknown hash_keys are harmless
    no-ops (WHERE matches nothing) — no schema coupling with the
    caller required.
    """

    def __init__(self, keys: Set[str], now: int):
        self._rows = [(int(now), k) for k in keys]

    def apply(self, conn) -> None:
        if not self._rows:
            return None
        conn.executemany(
            "UPDATE thumbnail_cache SET last_accessed = ? WHERE hash_key = ?",
            self._rows,
        )
        return None


def _flusher_loop(write_queue) -> None:
    while not _flusher_stop.is_set():
        # wait() returns True when the stop event fires, False on timeout.
        # We flush BEFORE checking the exit flag a second time so that
        # shutdown while holding un-flushed keys still surfaces the
        # latest last_accessed hints on the next cycle (best-effort).
        if _flusher_stop.wait(timeout=_TOUCH_FLUSH_INTERVAL_SEC):
            break
        keys = _drain_touch_set()
        if not keys:
            continue
        try:
            write_queue.enqueue_write(
                _repo.LOW, _TouchFlushOp(keys, now=int(time.time())),
            )
        except Exception:
            logger.exception("thumbs: touch flush enqueue failed")


def start_touch_flusher(*, write_queue) -> threading.Thread:
    """Start the 10 s periodic ``last_accessed`` flusher (idempotent)."""
    global _flusher_thread
    with _flusher_lock:
        if _flusher_thread is not None and _flusher_thread.is_alive():
            return _flusher_thread
        _flusher_stop.clear()
        _flusher_thread = threading.Thread(
            target=_flusher_loop, args=(write_queue,),
            name="xyz-gallery-thumbs-flusher", daemon=True,
        )
        _flusher_thread.start()
        return _flusher_thread


def stop_touch_flusher(timeout: float = 0.5) -> bool:
    """Signal the flusher to exit; returns True iff it joined in time."""
    global _flusher_thread
    with _flusher_lock:
        t = _flusher_thread
        if t is None:
            return True
        _flusher_stop.set()
    t.join(timeout=timeout)
    joined = not t.is_alive()
    if joined:
        with _flusher_lock:
            _flusher_thread = None
    return joined
