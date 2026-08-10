"""XYZ Image Gallery — cold scan + delta scan + single-file index path (T07).

Scope (per TASKS.md T07 + PROJECT_STATE §7):

* ``cold_scan(root)`` — background full-walk of a registered root at
  startup; per-file ``(size, mtime_ns)`` fingerprint short-circuit so
  warm restarts are ~free (C-3 / NFR-8).
* ``delta_scan(root, mode='light')`` — same fingerprint comparison
  without the Pillow decode; differences hand off to ``index_one``.
  Exposed here for T20 watcher heartbeat and T25 drift checks; not
  called anywhere in T07 itself but part of the module contract.
* ``index_one(path)`` — single-file path; returns ``image.id`` after
  the LOW write, or ``None`` if skipped (watcher T20, ``service`` 广播 id).
* ``delete_one(path)`` — T20 watcher: delete DB row by POSIX path, idem.
* ``_inflight`` + ``_inflight_lock`` — module-wide de-duplication
  barrier keyed on ``os.path.realpath + os.path.normcase`` (TASKS T07
  UPDATED / T20 UPDATED).  Released unconditionally in ``finally``.

Boundaries:
* No HTTP / no routes.
* All writes go through ``repo.enqueue_write(...)`` (ARCHITECTURE §4.6).
  Fingerprint pre-reads use ``db.connect_read`` — never a write handle.
* Consumes ``metadata.read_comfy_metadata`` as a pure function; does
  NOT reach into PIL behind its back (PROJECT_STATE §7 note 8).
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple, Union

from PIL import Image, UnidentifiedImageError

from . import db as _db
from . import metadata as _metadata
from . import paths as _paths
from . import repo as _repo
from . import video as _video
from . import vocab as _vocab

logger = logging.getLogger("xyz.gallery.indexer")

__all__ = [
    "cold_scan",
    "delta_scan",
    "index_one",
    "delete_one",
    "is_cold_scanning",
    "schedule_cold_scan_all",
    "is_derivative_path_excluded",
    "maybe_rebuild_prompt_vocab_from_config",
    "reconcile_folders_under_root",
    "reconcile_folders_under_root_block",
]

_PathLike = Union[str, Path]

# Image file extensions recognised by the indexer. Narrow on purpose:
# adding RAW / etc. is a future task, not T07.
_IMAGE_EXTS: frozenset = frozenset({".png", ".jpg", ".jpeg", ".webp"})

# Video containers (schema v8). Kept as a separate set from ``_IMAGE_EXTS``
# because ``media_kind`` is derived from which set an extension falls in —
# ``_MEDIA_EXTS`` is only ever the "should this file be indexed at all" gate.
_VIDEO_EXTS: frozenset = _video.VIDEO_EXTS
_MEDIA_EXTS: frozenset = _IMAGE_EXTS | _VIDEO_EXTS

def is_derivative_path_excluded(abs_path: str, root_path: str) -> bool:
    """Delegate to ``paths.is_derivative_path_excluded`` (T29)."""
    return _paths.is_derivative_path_excluded(abs_path, root_path)


def _prune_derivative_walk_dirs(dirnames: List[str]) -> None:
    _paths.prune_derivative_walk_dirnames(dirnames)

# inflight barrier (TASKS T07 UPDATED): dedupes concurrent requests
# targeting the same physical file across cold_scan / index_one / the
# future watcher callback (T20). Keys are ``normcase(realpath(path))``.
_inflight: Set[str] = set()
_inflight_lock: threading.Lock = threading.Lock()
_cold_thread: Optional[threading.Thread] = None


def _normalise_key(path: _PathLike) -> str:
    # realpath collapses symlinks; normcase handles Windows case / slash
    # differences. Together they prevent two "different looking" paths
    # from slipping past the dedup barrier.
    return os.path.normcase(os.path.realpath(str(path)))


def _claim(key: str) -> bool:
    """Try to add ``key`` to inflight. Returns True iff we won the slot."""
    with _inflight_lock:
        if key in _inflight:
            return False
        _inflight.add(key)
    return True


def _release(key: str) -> None:
    with _inflight_lock:
        _inflight.discard(key)


# -- fingerprint / existing-row lookup --------------------------------------

def _load_fingerprints(
    db_path: _PathLike, folder_id: int
) -> Dict[str, Tuple[int, int]]:
    """Return ``{path: (file_size, mtime_ns)}`` for images under ``folder_id``.

    Pre-loaded once per cold_scan so the per-file short-circuit is a
    plain dict lookup instead of 50 000 single-row SELECTs.
    """
    conn = _db.connect_read(db_path)
    try:
        rows = conn.execute(
            "SELECT path, file_size, mtime_ns FROM image WHERE folder_id = ?",
            (folder_id,),
        ).fetchall()
    finally:
        conn.close()
    out: Dict[str, Tuple[int, int]] = {}
    for r in rows:
        if r["file_size"] is None or r["mtime_ns"] is None:
            continue
        out[r["path"]] = (int(r["file_size"]), int(r["mtime_ns"]))
    return out


def _load_single_fingerprint(
    db_path: _PathLike, posix_path: str
) -> Optional[Tuple[int, int]]:
    conn = _db.connect_read(db_path)
    try:
        row = conn.execute(
            "SELECT file_size, mtime_ns FROM image WHERE path = ?",
            (posix_path,),
        ).fetchone()
    finally:
        conn.close()
    if row is None or row["file_size"] is None or row["mtime_ns"] is None:
        return None
    return int(row["file_size"]), int(row["mtime_ns"])


# -- parsing helpers --------------------------------------------------------

def _is_image(name: str) -> bool:
    if _metadata.is_gallery_atomic_temp_basename(name):
        return False
    ext = os.path.splitext(name)[1].lower()
    return ext in _IMAGE_EXTS


def _is_media(name: str) -> bool:
    """Indexable at all? — images *and* video containers (schema v8)."""
    if _metadata.is_gallery_atomic_temp_basename(name):
        return False
    ext = os.path.splitext(name)[1].lower()
    return ext in _MEDIA_EXTS


def _read_dims(path: str) -> Tuple[Optional[int], Optional[int]]:
    # PIL Image.open is lazy: .size is read from the header without
    # decoding pixels, so this is cheap (~0.3 ms on a typical PNG).
    # T06's read_comfy_metadata does not expose dimensions, and widening
    # its contract is explicitly off-limits (PROJECT_STATE §7 note 8).
    try:
        with Image.open(path) as img:
            w, h = img.size
            return int(w), int(h)
    except (UnidentifiedImageError, OSError, ValueError):
        return None, None


def _read_media_props(path: str) -> Dict[str, Any]:
    """Dimensions + (for video) clip properties, as upsert kwargs.

    One probe per file: ``av.open`` is not free, so the video branch must not
    call it once for the size and again for the duration.
    """
    if not _video.is_video_path(path):
        w, h = _read_dims(path)
        return {
            "media_kind": "image", "width": w, "height": h,
            "duration_ms": None, "fps": None, "has_audio": None, "vcodec": None,
        }
    info = _video.probe(path)
    if info is None:
        # Unreadable container: still index the row (the file exists and the
        # user should see it), just with nothing known about the picture.
        return {
            "media_kind": "video", "width": None, "height": None,
            "duration_ms": None, "fps": None, "has_audio": None, "vcodec": None,
        }
    return {
        "media_kind": "video",
        "width": info.width,
        "height": info.height,
        "duration_ms": info.duration_ms,
        "fps": info.fps,
        "has_audio": 1 if info.has_audio else 0,
        "vcodec": info.vcodec,
    }


def _load_audio_twin_suffixes(db_path: _PathLike) -> Tuple[str, ...]:
    return _video.audio_twin_suffixes_from_config(
        Path(db_path).parent / "gallery_config.json"
    )


def _normalise_tags_csv(raw: Optional[str]) -> Optional[str]:
    # Per PROJECT_STATE §4 #24: tags mirror normalisation for ``tags_csv``
    # stays minimal (trim / lower / comma split). Link-table tag strings for
    # ``tag`` / ``image_tag`` use ``vocab.normalize_tag`` (T15) in
    # ``_normalized_tag_list``.
    if raw is None:
        return None
    parts = [t.strip().lower() for t in str(raw).split(",") if t.strip()]
    return ",".join(parts) if parts else None


def _load_prompt_stopwords(db_path: _PathLike) -> frozenset:
    cfg = Path(db_path).parent / "gallery_config.json"
    if not cfg.is_file():
        return frozenset()
    try:
        data = json.loads(cfg.read_text(encoding="utf-8"))
    except Exception:
        return frozenset()
    words = data.get("prompt_stopwords")
    if not words:
        return frozenset()
    return frozenset(str(w).strip().lower() for w in words if str(w).strip())


def _normalized_tag_list(raw: Optional[str]) -> List[str]:
    return _vocab.normalized_tag_list_from_csv(raw)


def _normalise_favorite(raw: Optional[str]) -> Optional[int]:
    # Same scoping rule as tags: PNG chunk is a raw str; we decide the
    # 0/1 mapping here (and only here).
    if raw is None:
        return None
    v = str(raw).strip().lower()
    if v in ("1", "true", "yes", "t", "y"):
        return 1
    if v in ("0", "false", "no", "f", "n"):
        return 0
    return None


def _build_upsert_op(
    *, abs_path: str, root: Dict[str, Any], stat_result: os.stat_result,
    meta: _metadata.ComfyMeta, extra_stopwords: frozenset,
) -> _repo.UpsertImageOp:
    # Store paths as POSIX absolute strings — invariant §4 #9.
    posix_path = Path(abs_path).as_posix()
    root_posix = str(root["path"])  # already POSIX from T05
    # relative_path is POSIX relative to the root.  Path.relative_to
    # handles platform separators; as_posix normalises the result.
    rel = Path(abs_path).resolve(strict=False).relative_to(
        Path(root_posix).resolve(strict=False)
    ).as_posix()
    filename = os.path.basename(posix_path)
    ext = os.path.splitext(filename)[1].lower().lstrip(".")
    props = _read_media_props(abs_path)
    now = int(time.time())
    prompt_tokens = _vocab.normalize_prompt(meta.positive_prompt, extra_stopwords)
    word_tokens = list(_vocab.split_positive_prompt_words(meta.positive_prompt))
    normalized_tags = _normalized_tag_list(meta.tags)
    return _repo.UpsertImageOp(
        path=posix_path,
        folder_id=int(root["id"]),
        root_path=root_posix,
        root_kind=str(root["kind"]),
        relative_path=rel,
        filename=filename,
        filename_lc=filename.lower(),
        ext=ext,
        media_kind=props["media_kind"],
        width=props["width"],
        height=props["height"],
        duration_ms=props["duration_ms"],
        fps=props["fps"],
        has_audio=props["has_audio"],
        vcodec=props["vcodec"],
        file_size=int(stat_result.st_size),
        mtime_ns=int(stat_result.st_mtime_ns),
        # SPEC §6.1: created_at epoch seconds; preferred ComfyUI metadata
        # creation date, fallback ctime. T06 does not surface a creation
        # timestamp, so fall back to mtime — a deliberate MVP choice
        # (AI_RULES R4.3).
        created_at=int(stat_result.st_mtime),
        positive_prompt=meta.positive_prompt,
        negative_prompt=meta.negative_prompt,
        model=_vocab.normalize_stored_model(meta.model),
        seed=meta.seed,
        cfg=meta.cfg,
        steps=meta.steps,
        sampler=meta.sampler,
        scheduler=meta.scheduler,
        workflow_present=1 if meta.has_workflow else 0,
        favorite=_normalise_favorite(meta.favorite),
        tags_csv=_normalise_tags_csv(meta.tags),
        indexed_at=now,
        prompt_tokens=prompt_tokens,
        word_tokens=word_tokens,
        normalized_tags=normalized_tags,
    )


# -- cold / delta scans -----------------------------------------------------

def _iter_image_files(
    root_path: str, *, audio_twin_suffixes: Optional[Tuple[str, ...]] = None,
) -> Iterable[str]:
    # os.walk with onerror logging: permission errors etc. should not
    # abort the entire scan. Broken symlinks are filtered by followlinks=False.
    def _onerror(exc: OSError) -> None:
        logger.warning("walk error under %s: %s", root_path, exc)

    suffixes = (
        _video.DEFAULT_AUDIO_TWIN_SUFFIXES
        if audio_twin_suffixes is None else audio_twin_suffixes
    )
    for dirpath, dirnames, filenames in os.walk(root_path, onerror=_onerror):
        _prune_derivative_walk_dirs(dirnames)
        # The twin lookup answers from this listing rather than stat()-ing a
        # candidate sibling per video — the walk already holds the directory.
        here = {n.casefold() for n in filenames}

        def _sibling_here(candidate: str, _here=here) -> bool:
            return os.path.basename(candidate).casefold() in _here

        for name in filenames:
            if not _is_media(name):
                continue
            full = os.path.join(dirpath, name)
            if is_derivative_path_excluded(full, root_path):
                continue
            if _video.superseded_by_audio_twin(
                full, suffixes=suffixes, exists=_sibling_here,
            ):
                continue
            yield full


# Progress reporting batch size per TASKS T07 ("每 500 条触发一次进度统计").
_PROGRESS_BATCH: int = 500
# T44: lighter WS cadence for delta scans (walked / …).
_DELTA_PROGRESS_STRIDE: int = 200


def cold_scan(
    root: Dict[str, Any], *, db_path: _PathLike, write_queue,
    job_id: Optional[str] = None,
) -> Dict[str, int]:
    """Walk one registered root once, enqueuing upserts for any diffs.

    ``root`` is a dict with keys ``id``, ``path``, ``kind`` (the shape
    returned by ``folders.list_roots`` and friends).  Runs synchronously
    in whatever thread calls it — the top-level startup wrapper
    (``schedule_cold_scan_all``) is what actually backgrounds it.

    Returns a summary dict ``{walked, skipped, enqueued, errors}`` mostly
    for logging / later telemetry hooks.
    """
    from . import job_registry as _jobs

    root_path = str(root["path"])
    root_id = int(root["id"])
    jref = str(job_id) if job_id else None

    if not os.path.isdir(root_path):
        logger.warning("cold_scan: root path not a directory: %s", root_path)
        return {"walked": 0, "skipped": 0, "enqueued": 0, "errors": 0}

    if jref is not None:
        _jobs.start_index_job(
            jref, kind="index", root_id=root_id, phase="cold_scan", message="",
        )

    fingerprints = _load_fingerprints(db_path, root_id)
    extra_sw = _load_prompt_stopwords(db_path)
    twin_suffixes = _load_audio_twin_suffixes(db_path)

    walked = 0
    skipped = 0
    enqueued = 0
    errors = 0
    crash = False

    try:
        for abs_path in _iter_image_files(
            root_path, audio_twin_suffixes=twin_suffixes,
        ):
            walked += 1
            key = _normalise_key(abs_path)
            if not _claim(key):
                skipped += 1
                continue
            try:
                try:
                    st = os.stat(abs_path)
                except OSError as exc:
                    errors += 1
                    logger.debug("stat failed for %s: %s", abs_path, exc)
                    continue

                posix_path = Path(abs_path).as_posix()
                cached = fingerprints.get(posix_path)
                if cached is not None and cached == (
                    int(st.st_size), int(st.st_mtime_ns)
                ):
                    skipped += 1
                    continue

                meta = _metadata.read_comfy_metadata(abs_path)
                # NB: meta.errors being non-empty is NOT a reason to skip the
                # row — we still want the image indexed (filename / size /
                # dims) even if its prompt chunks are corrupt. PROJECT_STATE
                # §4 #22: errors are informational; a single broken PNG must
                # never stall the cold scan (NFR-1).
                try:
                    op = _build_upsert_op(
                        abs_path=abs_path, root=root,
                        stat_result=st, meta=meta,
                        extra_stopwords=extra_sw,
                    )
                except Exception:
                    errors += 1
                    logger.exception("failed to build op for %s", abs_path)
                    continue

                write_queue.enqueue_write(_repo.LOW, op)
                enqueued += 1

                if enqueued and enqueued % _PROGRESS_BATCH == 0:
                    logger.info(
                        "cold_scan progress (root=%s): walked=%d enqueued=%d skipped=%d",
                        root_path, walked, enqueued, skipped,
                    )
                if jref is not None and enqueued and enqueued % _PROGRESS_BATCH == 0:
                    _jobs.emit_index_progress(
                        jref, done=walked, total=0, root_id=root_id,
                        phase="cold_scan",
                        message=f"enqueued {enqueued} (walked {walked})",
                    )
            except Exception:
                errors += 1
                logger.exception("indexer error for %s", abs_path)
            finally:
                _release(key)

        logger.info(
            "cold_scan done (root=%s): walked=%d enqueued=%d skipped=%d errors=%d",
            root_path, walked, enqueued, skipped, errors,
        )
        if jref is not None:
            _jobs.emit_index_progress(
                jref, done=walked, total=0, root_id=root_id, phase="cold_scan",
                message="finishing",
            )
        reconcile_folders_under_root(root, db_path=db_path, write_queue=write_queue)
    except BaseException:
        crash = True
        raise
    finally:
        if jref is not None:
            _jobs.emit_index_done(
                jref, root_id=root_id, phase="cold_scan",
                ok=0 if crash else 1, failed=1 if crash else 0,
            )

    return {
        "walked": walked, "skipped": skipped,
        "enqueued": enqueued, "errors": errors,
    }


def index_one(
    path: _PathLike, *, root: Dict[str, Any],
    db_path: _PathLike, write_queue,
) -> Optional[int]:
    """Index a single file. Returns the ``image.id`` if a row was written.

    Returns ``None`` when the path is skipped (inflight loss, stat
    failure, or fingerprint still matches) — T07 test #2 / #5 semantics.

    ``delete_one`` is the delete counterpart for T20 watcher.
    """
    abs_path = str(path)
    if _metadata.is_gallery_atomic_temp_basename(os.path.basename(abs_path)):
        return None
    if is_derivative_path_excluded(abs_path, str(root["path"])):
        return None
    twin_suffixes = _load_audio_twin_suffixes(db_path)
    if _video.superseded_by_audio_twin(abs_path, suffixes=twin_suffixes):
        return None
    key = _normalise_key(abs_path)
    if not _claim(key):
        return None
    try:
        try:
            st = os.stat(abs_path)
        except OSError:
            return None

        posix_path = Path(abs_path).as_posix()
        cached = _load_single_fingerprint(db_path, posix_path)
        if cached is not None and cached == (
            int(st.st_size), int(st.st_mtime_ns)
        ):
            return None

        meta = _metadata.read_comfy_metadata(abs_path)
        extra_sw = _load_prompt_stopwords(db_path)
        op = _build_upsert_op(
            abs_path=abs_path, root=root,
            stat_result=st, meta=meta,
            extra_stopwords=extra_sw,
        )
        fut = write_queue.enqueue_write(_repo.LOW, op)
        fut.result(timeout=30.0)
        # Write order makes this necessary: the silent ``X.mp4`` lands (and is
        # indexed) before ``X-audio.mp4`` is muxed, so skipping at index time
        # cannot catch it — the row already exists by then. Drop it now.
        for stale in _video.supersedes_paths(abs_path, suffixes=twin_suffixes):
            if os.path.isfile(stale):
                try:
                    write_queue.enqueue_write(
                        _repo.LOW,
                        _repo.DeleteImageOp(path=Path(stale).as_posix()),
                    )
                except Exception:
                    logger.exception("failed to drop silent twin row %s", stale)
        conn = _db.connect_read(db_path)
        try:
            row = conn.execute(
                "SELECT id FROM image WHERE path = ?",
                (posix_path,),
            ).fetchone()
        finally:
            conn.close()
        return int(row[0]) if row is not None else None
    finally:
        _release(key)


def delete_one(
    path: _PathLike, *, db_path: _PathLike, write_queue,
) -> Optional[int]:
    """Delete DB row for ``path`` (POSIX) if present.  Returns deleted id or None.

    Deduplication uses the same ``_inflight`` set as ``index_one``.  Safe
    when the file is already missing on disk.
    """
    abs_path = str(path)
    key = _normalise_key(abs_path)
    if not _claim(key):
        return None
    try:
        posix_path = Path(abs_path).as_posix()
        fut = write_queue.enqueue_write(_repo.LOW, _repo.DeleteImageOp(path=posix_path))
        return fut.result(timeout=30.0)
    finally:
        _release(key)


def delta_scan(
    root: Dict[str, Any], *, db_path: _PathLike, write_queue,
    mode: str = "light",
    job_id: Optional[str] = None,
) -> Dict[str, int]:
    """Light delta scan: ``(size, mtime_ns)`` comparison, no PIL decode.

    Only files that actually differ are handed off to ``index_one``
    (where the full ``read_comfy_metadata`` path runs).  Deletion
    reconciliation is intentionally out of scope for T07 — that is
    T20 / T25's heartbeat territory (AI_RULES R1.2).
    """
    if mode != "light":
        raise ValueError(f"delta_scan: unknown mode {mode!r}")

    from . import job_registry as _jobs

    root_path = str(root["path"])
    root_id = int(root["id"])
    if not os.path.isdir(root_path):
        return {"walked": 0, "changed": 0, "errors": 0}

    jref = str(job_id) if job_id else None
    if jref is not None:
        _jobs.start_index_job(
            jref, kind="index", root_id=root_id, phase="delta", message="",
        )

    fingerprints = _load_fingerprints(db_path, root_id)
    twin_suffixes = _load_audio_twin_suffixes(db_path)
    walked = 0
    changed = 0
    errors = 0
    crash = False
    deleted_ids: List[int] = []

    try:
        for abs_path in _iter_image_files(
            root_path, audio_twin_suffixes=twin_suffixes,
        ):
            walked += 1
            if jref is not None and (
                walked == 1
                or (walked % _DELTA_PROGRESS_STRIDE) == 0
            ):
                _jobs.emit_index_progress(
                    jref, done=walked, total=0, root_id=root_id, phase="delta",
                    message=f"changed {changed} err {errors}",
                )
            try:
                st = os.stat(abs_path)
            except OSError:
                errors += 1
                continue
            posix_path = Path(abs_path).as_posix()
            cached = fingerprints.get(posix_path)
            if cached is not None and cached == (
                int(st.st_size), int(st.st_mtime_ns)
            ):
                continue
            try:
                if index_one(
                    abs_path, root=root,
                    db_path=db_path, write_queue=write_queue,
                ):
                    changed += 1
            except Exception:
                errors += 1
                logger.exception("delta_scan index_one failed for %s", abs_path)

        deleted_ids = _reconcile_missing_disk_rows(
            root, db_path=db_path, write_queue=write_queue,
        )
        reconcile_folders_under_root(
            root, db_path=db_path, write_queue=write_queue,
        )
    except BaseException:
        crash = True
        raise
    finally:
        if jref is not None:
            _jobs.emit_index_done(
                jref, root_id=root_id, phase="delta",
                ok=0 if crash else 1, failed=1 if crash else 0,
            )

    return {
        "walked": walked,
        "changed": changed,
        "errors": errors,
        "removed": len(deleted_ids),
        "deleted_ids": deleted_ids,
    }


def _reconcile_missing_disk_rows(
    root: Dict[str, Any], *, db_path: _PathLike, write_queue,
) -> List[int]:
    """Drop DB rows under ``root`` whose files no longer exist (T25 heartbeat).

    Uses the same ``delete_one`` path as the file watcher so in-flight
    dedup + ``DeleteImageOp`` semantics stay unified.
    """
    root_id = int(root["id"])
    root_path = os.path.normcase(os.path.normpath(str(root["path"])))
    twin_suffixes = _load_audio_twin_suffixes(db_path)
    conn = _db.connect_read(db_path)
    try:
        rows = conn.execute(
            "SELECT path FROM image WHERE folder_id = ? ORDER BY id",
            (root_id,),
        ).fetchall()
    finally:
        conn.close()

    deleted: List[int] = []
    rds = root_path if (root_path.endswith(os.sep) or len(root_path) == 3) else (
        root_path + os.sep
    )
    for (posix_path,) in rows:
        p = str(posix_path)
        try:
            pc = os.path.normcase(os.path.normpath(p))
            if not (pc == root_path or pc.startswith(rds)):
                continue
        except (OSError, TypeError, ValueError):
            continue
        # Two ways a row can be stale while its file is still on disk: the
        # path became a derivative one, or a muxed audio twin has since
        # appeared next to it. Both mean the row must go even though
        # ``os.path.isfile`` below would happily keep it. The twin case also
        # self-heals a library indexed before the rule existed, and reacts to
        # the user editing ``video_audio_twin_suffixes``.
        if is_derivative_path_excluded(p, str(root["path"])) or (
            _video.superseded_by_audio_twin(p, suffixes=twin_suffixes)
        ):
            try:
                iid = delete_one(p, db_path=db_path, write_queue=write_queue)
            except Exception:
                logger.exception("reconcile delete_one failed path=%r", p)
                continue
            if iid is not None:
                deleted.append(int(iid))
            continue
        if os.path.isfile(p):
            continue
        try:
            iid = delete_one(p, db_path=db_path, write_queue=write_queue)
        except Exception:
            logger.exception("reconcile delete_one failed path=%r", p)
            continue
        if iid is not None:
            deleted.append(int(iid))
    return deleted


# -- startup orchestration --------------------------------------------------

def maybe_rebuild_prompt_vocab_from_config(
    *, db_path: _PathLike, data_dir: _PathLike, write_queue,
) -> None:
    """T30: when ``vocab_version`` in ``gallery_config.json`` is below
    ``vocab.PROMPT_VOCAB_PIPELINE_VERSION``, enqueue a full rebuild of
    ``prompt_token`` / ``image_prompt_token`` from ``image.positive_prompt``,
    then bump the config. No-op when already current.
    """
    from . import folders as _folders

    dp = Path(data_dir)
    cfg = _folders._load_config(dp)
    cur_raw = cfg.get("vocab_version", 0)
    try:
        cur = int(cur_raw)
    except (TypeError, ValueError):
        cur = 0
    target = int(_vocab.PROMPT_VOCAB_PIPELINE_VERSION)
    if cur >= target:
        return
    extra_sw = _load_prompt_stopwords(db_path)
    fut = write_queue.enqueue_write(
        _repo.HIGH,
        _repo.RebuildPromptVocabFullOp(extra_stopwords=extra_sw),
    )
    fut.result(timeout=None)
    cfg2 = _folders._load_config(dp)
    cfg2["vocab_version"] = target
    _folders._save_config(dp, cfg2)


def reconcile_folders_under_root(
    root: Dict[str, Any], *, db_path: _PathLike, write_queue,
) -> None:
    """Enqueue ``ReconcileFoldersUnderRootOp`` (LOW) — sync ``folder`` rows with disk."""
    try:
        write_queue.enqueue_write(
            _repo.LOW,
            _repo.ReconcileFoldersUnderRootOp(
                root_id=int(root["id"]),
                root_path=str(root["path"]),
                root_kind=str(root["kind"]),
            ),
        )
    except Exception:
        logger.exception(
            "reconcile_folders_under_root enqueue failed root_id=%s",
            root.get("id"),
        )


def reconcile_folders_under_root_block(
    root: Dict[str, Any], *, db_path: _PathLike, write_queue, timeout: float = 120.0,
) -> None:
    """Like :func:`reconcile_folders_under_root` but wait for the op to complete.

    Used before the client is told the ``index`` job is finished, so
    ``folder`` image_count rows match the ``image`` table (T20 watcher follow-up).
    """
    try:
        fut = write_queue.enqueue_write(
            _repo.LOW,
            _repo.ReconcileFoldersUnderRootOp(
                root_id=int(root["id"]),
                root_path=str(root["path"]),
                root_kind=str(root["kind"]),
            ),
        )
    except Exception:
        logger.exception(
            "reconcile_folders_under_root_block enqueue root_id=%s", root.get("id"),
        )
        return
    try:
        fut.result(timeout=timeout)
    except Exception:  # noqa: BLE001
        logger.exception(
            "reconcile_folders_under_root_block wait root_id=%s db_path=%r",
            root.get("id"), str(db_path),
        )


def _load_roots(db_path: _PathLike) -> List[Dict[str, Any]]:
    conn = _db.connect_read(db_path)
    try:
        rows = conn.execute(
            "SELECT id, path, kind FROM folder WHERE parent_id IS NULL"
        ).fetchall()
    finally:
        conn.close()
    return [
        {"id": int(r["id"]), "path": str(r["path"]), "kind": str(r["kind"])}
        for r in rows
    ]


def _cold_scan_all_worker(db_path: _PathLike, write_queue) -> None:
    from . import job_registry as _jobs

    try:
        roots = _load_roots(db_path)
    except Exception:
        logger.exception("indexer: failed to load roots; aborting cold scan")
        return
    for root in roots:
        try:
            jid = _jobs.new_job_id()
            cold_scan(
                root, db_path=db_path, write_queue=write_queue,
                job_id=jid,
            )
        except Exception:
            logger.exception(
                "indexer: cold_scan crashed for root %s", root.get("path"),
            )


def is_cold_scanning() -> bool:
    """True while the T07 one-shot ``schedule_cold_scan_all`` thread is alive."""
    t = _cold_thread
    return t is not None and t.is_alive()


def schedule_cold_scan_all(
    *, db_path: _PathLike, write_queue,
) -> threading.Thread:
    """Fire-and-forget background cold scan of every registered root.

    Single worker thread per TASKS T07 ("第一版单线程解析"); ProcessPool
    fan-out is T27's scope and must not leak forward here
    (AI_RULES R1.2).
    """
    global _cold_thread
    t = threading.Thread(
        target=_cold_scan_all_worker,
        args=(db_path, write_queue),
        name="xyz-gallery-indexer-coldscan",
        daemon=True,
    )
    t.start()
    _cold_thread = t
    return t
