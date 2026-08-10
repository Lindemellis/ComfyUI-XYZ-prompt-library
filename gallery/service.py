"""XYZ Image Gallery — use-case orchestration (T19).

PATCH / resync flows: sandbox → ``WriteQueue(HIGH)`` → WS fan-out →
``metadata_sync.notify`` (ARCHITECTURE §4.3 / §4.8).
"""

from __future__ import annotations

import errno
import logging
import os
import platform
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Sequence, Set, Tuple

from . import audit as _audit
from . import db as _db
from . import folders as _folders
from . import metadata_sync as _metadata_sync
from . import paths as _paths
from . import repo as _repo
from . import vocab as _vocab
from . import ws_hub as _ws_hub

logger = logging.getLogger("xyz.gallery.service")

BULK_HIGH_IF_TOTAL_LEQ: int = 64


def _emit_bulk_progress(d: dict) -> None:
    from . import job_registry as _jr

    out = _jr.sync_bulk_payload(d)
    _ws_hub.broadcast(_ws_hub.BULK_PROGRESS, out)


def _emit_bulk_completed(d: dict) -> None:
    from . import job_registry as _jr

    out = dict(d)
    bid = out.get("bulk_id") or out.get("plan_id")
    if bid is not None and "job_id" not in out:
        out["job_id"] = str(bid)
    _ws_hub.broadcast(_ws_hub.BULK_COMPLETED, out)
    _jr.finish_bulk(out)

__all__ = [
    "update_image",
    "resync_image",
    "broadcast_image_upserted",
    "broadcast_image_deleted",
    "broadcast_index_overflow",
    "bulk_set_favorite",
    "bulk_edit_tags",
    "preflight_move",
    "execute_move",
    "move_single_image",
    "preflight_delete",
    "execute_delete",
    "delete_single_image",
    "PreflightMoveError",
    "folder_register_custom_root",
    "folder_unregister_custom_root",
    "folder_schedule_rescan",
    "folder_mkdir",
    "folder_rename",
    "folder_move",
    "folder_delete_empty",
    "folder_delete_preview",
    "folder_delete_purge",
    "folder_open_in_os",
    "tag_admin_list",
    "tag_admin_delete",
    "tag_admin_purge_zero",
    "tag_admin_rename",
]

_PLAN_TTL_SEC = 300.0
_plan_lock = threading.Lock()
_plans: Dict[str, "_MovePlanRecord"] = {}
_delete_plans: Dict[str, "_DeletePlanRecord"] = {}


class PreflightMoveError(Exception):
    """Validated client-facing move preflight failure (HTTP 4xx mapping)."""

    def __init__(self, code: str, message: str, details: Optional[dict] = None):
        super().__init__(message)
        self.code = str(code)
        self.details = dict(details) if details else {}


@dataclass
class _MoveMapping:
    image_id: int
    src: str
    dst: str
    conflict: str  # "clean" | "renamed"


@dataclass
class _MovePlanRecord:
    mappings: List[_MoveMapping] = field(default_factory=list)
    expires_at: float = 0.0
    total_bytes: int = 0
    target_folder_id: int = 0


@dataclass
class _DeletePlanRecord:
    rows: List[Tuple[int, str]] = field(default_factory=list)
    expires_at: float = 0.0
    total_bytes: int = 0


def _plan_gc_locked() -> None:
    now = time.monotonic()
    dead = [k for k, v in _plans.items() if v.expires_at <= now]
    for k in dead:
        del _plans[k]
    dead_d = [k for k, v in _delete_plans.items() if v.expires_at <= now]
    for k in dead_d:
        del _delete_plans[k]


def _store_put(plan_id: str, rec: _MovePlanRecord) -> None:
    with _plan_lock:
        _plan_gc_locked()
        _plans[plan_id] = rec


def _store_get(plan_id: str) -> Optional[_MovePlanRecord]:
    with _plan_lock:
        _plan_gc_locked()
        rec = _plans.get(plan_id)
        if rec is None:
            return None
        if rec.expires_at <= time.monotonic():
            del _plans[plan_id]
            return None
        return rec


def _store_pop(plan_id: str) -> Optional[_MovePlanRecord]:
    with _plan_lock:
        _plan_gc_locked()
        rec = _plans.pop(plan_id, None)
        if rec is None:
            return None
        if rec.expires_at <= time.monotonic():
            return None
        return rec


def _delete_store_put(plan_id: str, rec: _DeletePlanRecord) -> None:
    with _plan_lock:
        _plan_gc_locked()
        _delete_plans[plan_id] = rec


def _delete_store_pop(plan_id: str) -> Optional[_DeletePlanRecord]:
    with _plan_lock:
        _plan_gc_locked()
        rec = _delete_plans.pop(plan_id, None)
        if rec is None:
            return None
        if rec.expires_at <= time.monotonic():
            return None
        return rec


def _next_free_name(filename: str, taken_lower: set) -> str:
    """Pick ``stem (n).ext`` not present in ``taken_lower`` (case-insensitive)."""
    p = Path(filename)
    stem, ext = p.stem, p.suffix
    base = filename
    if base.lower() not in taken_lower:
        return base
    n = 1
    while True:
        cand = f"{stem} ({n}){ext}"
        if cand.lower() not in taken_lower:
            return cand
        n += 1


def _target_dir_path(*, db_path: Path, target_folder_id: int) -> str:
    conn = _db.connect_read(db_path)
    try:
        row = conn.execute(
            "SELECT path FROM folder WHERE id = ?", (int(target_folder_id),),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        raise PreflightMoveError("not_found", f"folder id={target_folder_id} not found")
    raw = str(row["path"])
    p = Path(raw).resolve(strict=False)
    if not p.is_dir():
        raise PreflightMoveError(
            "bad_path", f"target folder is not a directory: {raw!r}",
        )
    return p.as_posix()


def _listdir_lower(dir_path: str) -> set:
    try:
        names = os.listdir(dir_path)
    except OSError as exc:
        raise PreflightMoveError(
            "bad_path", f"cannot list target directory: {exc}",
        ) from exc
    return {n.lower() for n in names}


def _physical_move(src: str, dst: str) -> None:
    dst_parent = Path(dst).parent
    dst_parent.mkdir(parents=True, exist_ok=True)
    try:
        os.replace(src, dst)
    except OSError as exc:
        if not _is_cross_device(exc):
            raise
        shutil.copy2(src, dst)
        if Path(src).stat().st_size != Path(dst).stat().st_size:
            try:
                os.unlink(dst)
            except OSError:
                pass
            raise RuntimeError("cross-device copy size mismatch") from exc
        os.unlink(src)


def _is_cross_device(exc: OSError) -> bool:
    if exc.errno == errno.EXDEV:
        return True
    if getattr(exc, "winerror", None) == 17:
        return True
    return False


def _fields_for_moved_file(
    dst_posix: str, roots: List[Mapping[str, Any]],
) -> Tuple[int, str, str, str, str, str, int, int]:
    """Return folder_id, path, relative_path, filename, filename_lc, ext, mtime_ns, file_size."""
    st = Path(dst_posix).stat()
    file_size = int(st.st_size)
    mtime_ns = int(getattr(st, "st_mtime_ns", int(st.st_mtime * 1e9)))
    resolved = Path(dst_posix).resolve(strict=False)
    path_posix = resolved.as_posix()
    filename = resolved.name
    ext = resolved.suffix.lower().lstrip(".")
    filename_lc = filename.lower()
    root_paths = [str(r["path"]) for r in roots]
    _paths.assert_inside_root(path_posix, root_paths)
    for r in roots:
        rp = Path(str(r["path"])).resolve(strict=False)
        try:
            rel = resolved.relative_to(rp).as_posix()
        except ValueError:
            continue
        return (
            int(r["id"]),
            path_posix,
            rel,
            filename,
            filename_lc,
            ext,
            mtime_ns,
            file_size,
        )
    raise _paths.SandboxError(
        f"path {path_posix!r} is not inside any registered root"
    )


def preflight_move(
    sel: _repo.SelectionSpec,
    target_folder_id: int,
    *,
    db_path: Path,
) -> dict:
    """Phase-1 bulk move: sandbox, disk budget, name simulation → ``plan_id``."""
    rows = _repo.fetch_selection_move_sources(db_path=db_path, sel=sel)
    if not rows:
        raise PreflightMoveError("invalid_body", "selection resolves to zero images")

    target_dir = _target_dir_path(db_path=db_path, target_folder_id=target_folder_id)
    roots = _folders.list_roots(db_path=db_path)
    root_paths = [str(r["path"]) for r in roots]
    _paths.assert_inside_root(target_dir, root_paths)

    if not os.access(target_dir, os.W_OK):
        raise PreflightMoveError(
            "bad_path", f"target folder not writable: {target_dir!r}",
        )

    total_bytes = 0
    for _i, _p, fs, _fn in rows:
        total_bytes += int(fs) if fs is not None else 0

    du = shutil.disk_usage(target_dir)
    free_bytes = int(du.free)
    if total_bytes > free_bytes * 0.95:
        raise PreflightMoveError(
            "invalid_body",
            "insufficient free space on target volume "
            f"(need ~{total_bytes} bytes, ~{free_bytes} bytes free)",
            {"total_bytes": total_bytes, "free_bytes": free_bytes},
        )

    taken = _listdir_lower(target_dir)
    mappings: List[_MoveMapping] = []
    unresolved: List[dict] = []

    for image_id, src, _fs, orig_fn in rows:
        try:
            _paths.assert_inside_root(src, root_paths)
        except _paths.SandboxError as exc:
            raise PreflightMoveError(
                "sandbox", str(exc), {"id": int(image_id)},
            ) from exc

        src_res = Path(src).resolve(strict=False)
        candidate = orig_fn
        if candidate.lower() in taken:
            candidate = _next_free_name(orig_fn, taken)
        dst = str(Path(target_dir) / candidate)
        dst_res = Path(dst).resolve(strict=False)
        if src_res == dst_res:
            continue
        taken.add(candidate.lower())
        conflict = "clean" if candidate == orig_fn else "renamed"
        mappings.append(
            _MoveMapping(
                image_id=int(image_id),
                src=src_res.as_posix(),
                dst=dst_res.as_posix(),
                conflict=conflict,
            ),
        )

    if not mappings:
        raise PreflightMoveError("invalid_body", "nothing to move (all targets match sources)")

    plan_id = uuid.uuid4().hex
    rec = _MovePlanRecord(
        mappings=mappings,
        expires_at=time.monotonic() + _PLAN_TTL_SEC,
        total_bytes=total_bytes,
        target_folder_id=int(target_folder_id),
    )
    _store_put(plan_id, rec)

    wire_maps = [
        {
            "id": m.image_id,
            "src": m.src,
            "dst": m.dst,
            "conflict": m.conflict,
        }
        for m in mappings
    ]
    return {
        "plan_id": plan_id,
        "total_bytes": total_bytes,
        "free_bytes": free_bytes,
        "mappings": wire_maps,
        "unresolved_conflicts": unresolved,
    }


def _apply_rename_overrides(
    plan: _MovePlanRecord, overrides: Optional[Mapping[str, Any]],
) -> _MovePlanRecord:
    if not overrides:
        return plan
    target_dir = str(Path(plan.mappings[0].dst).parent.as_posix())
    new_maps: List[_MoveMapping] = []
    for m in plan.mappings:
        key = str(m.image_id)
        name = overrides.get(key)
        if name is None:
            name = overrides.get(m.image_id)
        if name is None:
            new_maps.append(m)
            continue
        if not isinstance(name, str) or not name.strip():
            raise PreflightMoveError("invalid_body", f"empty rename for id={m.image_id}")
        base = Path(name).name
        dst = str(Path(target_dir) / base)
        new_maps.append(
            _MoveMapping(
                image_id=m.image_id,
                src=m.src,
                dst=Path(dst).resolve(strict=False).as_posix(),
                conflict="renamed",
            ),
        )
    return _MovePlanRecord(
        mappings=new_maps,
        expires_at=plan.expires_at,
        total_bytes=plan.total_bytes,
        target_folder_id=plan.target_folder_id,
    )


def _re_check_plan_disk(plan: _MovePlanRecord) -> None:
    for m in plan.mappings:
        par = Path(m.dst).parent
        if not par.is_dir():
            raise PreflightMoveError(
                "bad_path", f"target directory missing: {str(par)!r}",
            )
        dst_p = Path(m.dst)
        if dst_p.exists():
            if dst_p.resolve(strict=False) != Path(m.src).resolve(strict=False):
                raise PreflightMoveError(
                    "invalid_body",
                    f"destination blocked by existing file: {m.dst!r}",
                    {"id": m.image_id},
                )


def execute_move(
    plan_id: str,
    rename_overrides: Optional[Mapping[str, Any]],
    *,
    db_path: Path,
    actor: str = "unknown",
) -> dict:
    raw = _store_pop(plan_id)
    if raw is None:
        raise PreflightMoveError("not_found", "unknown or expired plan_id")

    plan = _apply_rename_overrides(raw, rename_overrides)
    roots = _folders.list_roots(db_path=db_path)
    root_paths = [str(r["path"]) for r in roots]
    for m in plan.mappings:
        try:
            _paths.assert_inside_root(m.src, root_paths)
            _paths.assert_inside_root(m.dst, root_paths)
        except _paths.SandboxError as exc:
            raise PreflightMoveError("sandbox", str(exc)) from exc

    _re_check_plan_disk(plan)

    wq = _write_queue_handle()
    total = len(plan.mappings)
    ok_count = 0
    failed: List[dict] = []

    _emit_bulk_progress(
        {
            "plan_id": plan_id,
            "bulk_id": plan_id,
            "done": 0,
            "total": total,
            "kind": "move",
        },
    )

    for i, m in enumerate(plan.mappings):
        try:
            if Path(m.src).resolve(strict=False) == Path(m.dst).resolve(strict=False):
                ok_count += 1
            else:
                _physical_move(m.src, m.dst)
                (
                    folder_id,
                    path_posix,
                    rel,
                    filename,
                    filename_lc,
                    ext,
                    mtime_ns,
                    file_size,
                ) = _fields_for_moved_file(m.dst, roots)
                fut = wq.enqueue_write(
                    _repo.MID,
                    _repo.UpdateImagePathOp(
                        image_id=m.image_id,
                        path=path_posix,
                        folder_id=folder_id,
                        relative_path=rel,
                        filename=filename,
                        filename_lc=filename_lc,
                        ext=ext,
                        file_size=file_size,
                        mtime_ns=mtime_ns,
                        # Pure filesystem move: file bytes (incl. xyz_gallery.*) unchanged;
                        # DB tags/favorite unchanged — skip PNG metadata_sync storm (T24).
                        refresh_sync=False,
                    ),
                )
                ver = int(fut.result(timeout=120.0))
                ok_count += 1
                _ws_hub.broadcast(
                    _ws_hub.IMAGE_UPDATED,
                    {
                        "id": int(m.image_id),
                        "version": ver,
                        "moved_to": path_posix,
                    },
                )
        except Exception as exc:  # noqa: BLE001
            failed.append(
                {
                    "id": int(m.image_id),
                    "code": "internal",
                    "message": str(exc),
                },
            )
            logger.exception("execute_move failed id=%s", m.image_id)
        _emit_bulk_progress(
            {
                "plan_id": plan_id,
                "bulk_id": plan_id,
                "done": i + 1,
                "total": total,
                "kind": "move",
            },
        )
        if (i + 1) % 50 == 0:
            time.sleep(0)

    _emit_bulk_completed(
        {
            "plan_id": plan_id,
            "bulk_id": plan_id,
            "done": total,
            "total": total,
            "kind": "move",
            "failed": failed,
        },
    )
    logger.info(
        "bulk move completed plan_id=%s ok=%s failed=%s",
        plan_id, ok_count, len(failed),
    )
    _audit.log_event(
        "bulk_move_completed",
        actor,
        {
            "plan_id": plan_id,
            "moved": ok_count,
            "failed": len(failed),
            "total": total,
        },
    )
    return {"moved": ok_count, "failed": failed, "plan_id": plan_id}


def move_single_image(
    image_id: int,
    target_folder_id: int,
    rename: Optional[str],
    *,
    db_path: Path,
) -> _repo.ImageRecord:
    """Move one image; 409-style collision surfaced as ``PreflightMoveError``."""
    rec = _repo.get_image(int(image_id), db_path=db_path)
    if rec is None:
        raise KeyError(f"image {image_id} not found")

    roots = _folders.list_roots(db_path=db_path)
    root_paths = [r["path"] for r in roots]
    _paths.assert_inside_root(rec.path, root_paths)

    target_dir = _target_dir_path(db_path=db_path, target_folder_id=target_folder_id)
    _paths.assert_inside_root(target_dir, root_paths)

    if not os.access(target_dir, os.W_OK):
        raise PreflightMoveError(
            "bad_path", f"target folder not writable: {target_dir!r}",
        )

    src_res = Path(rec.path).resolve(strict=False)
    dst_name = (rename or rec.filename).strip()
    if not dst_name or dst_name != Path(dst_name).name:
        raise PreflightMoveError("invalid_body", "rename must be a plain filename")
    dst = str(Path(target_dir) / dst_name)
    dst_res = Path(dst).resolve(strict=False)

    if src_res != dst_res:
        if dst_res.exists():
            taken = _listdir_lower(target_dir)
            suggested = _next_free_name(dst_name, taken)
            raise PreflightMoveError(
                "invalid_body",
                f"destination exists: {dst_res.as_posix()!r}",
                {"suggested_name": suggested},
            )

    du = shutil.disk_usage(target_dir)
    if int(rec.file_size or 0) > int(du.free) * 0.95:
        raise PreflightMoveError(
            "invalid_body",
            "insufficient free space on target volume",
            {"total_bytes": int(rec.file_size or 0), "free_bytes": int(du.free)},
        )

    if src_res == dst_res:
        out = _repo.get_image(int(image_id), db_path=db_path)
        if out is None:
            raise RuntimeError(f"image {image_id} missing")
        return out

    _physical_move(src_res.as_posix(), dst_res.as_posix())
    (
        folder_id,
        path_posix,
        rel,
        filename,
        filename_lc,
        ext,
        mtime_ns,
        file_size,
    ) = _fields_for_moved_file(dst_res.as_posix(), roots)

    wq = _write_queue_handle()
    fut = wq.enqueue_write(
        _repo.MID,
        _repo.UpdateImagePathOp(
            image_id=int(image_id),
            path=path_posix,
            folder_id=folder_id,
            relative_path=rel,
            filename=filename,
            filename_lc=filename_lc,
            ext=ext,
            file_size=file_size,
            mtime_ns=mtime_ns,
            refresh_sync=False,
        ),
    )
    ver = int(fut.result(timeout=120.0))
    _ws_hub.broadcast(
        _ws_hub.IMAGE_UPDATED,
        {"id": int(image_id), "version": ver, "moved_to": path_posix},
    )

    out = _repo.get_image(int(image_id), db_path=db_path)
    if out is None:
        raise RuntimeError(f"image {image_id} vanished after move")
    return out


def preflight_delete(sel: _repo.SelectionSpec, *, db_path: Path) -> dict:
    """Two-phase bulk delete — phase 1: sandbox + size tally + ``plan_id``."""
    rows = _repo.fetch_selection_move_sources(db_path=db_path, sel=sel)
    if not rows:
        raise PreflightMoveError(
            "invalid_body", "selection resolves to zero images",
        )

    roots = _folders.list_roots(db_path=db_path)
    root_paths = [str(r["path"]) for r in roots]
    plan_rows: List[Tuple[int, str]] = []
    total_bytes = 0
    for image_id, path, fs, _fn in rows:
        try:
            _paths.assert_inside_root(path, root_paths)
        except _paths.SandboxError as exc:
            raise PreflightMoveError(
                "sandbox", str(exc), {"id": int(image_id)},
            ) from exc
        total_bytes += int(fs or 0)
        plan_rows.append((int(image_id), str(path)))

    plan_id = uuid.uuid4().hex
    _delete_store_put(
        plan_id,
        _DeletePlanRecord(
            rows=plan_rows,
            expires_at=time.monotonic() + _PLAN_TTL_SEC,
            total_bytes=int(total_bytes),
        ),
    )
    return {
        "plan_id": plan_id,
        "total": len(plan_rows),
        "total_bytes": int(total_bytes),
    }


def execute_delete(plan_id: str, *, db_path: Path, actor: str = "unknown") -> dict:
    """Phase-2 bulk delete: unlink then ``DeleteImageOp`` per row (T25)."""
    raw = _delete_store_pop(plan_id)
    if raw is None:
        raise PreflightMoveError("not_found", "unknown or expired plan_id")

    wq = _write_queue_handle()
    roots = _folders.list_roots(db_path=db_path)
    root_paths = [str(r["path"]) for r in roots]
    total = len(raw.rows)
    failed: List[dict] = []
    ok_count = 0
    bid = plan_id

    _emit_bulk_progress(
        {
            "plan_id": bid,
            "bulk_id": bid,
            "done": 0,
            "total": total,
            "kind": "delete",
        },
    )

    for i, (image_id, path) in enumerate(raw.rows):
        try:
            _paths.assert_inside_root(path, root_paths)
            p = Path(path)
            if p.is_file():
                os.unlink(str(p))
            fut = wq.enqueue_write(
                _repo.MID,
                _repo.DeleteImageOp(path=p.as_posix()),
            )
            did = fut.result(timeout=120.0)
            if did is not None:
                broadcast_image_deleted(int(did))
                ok_count += 1
        except Exception as exc:  # noqa: BLE001
            failed.append(
                {
                    "id": int(image_id),
                    "code": "internal",
                    "message": str(exc),
                },
            )
            logger.exception("execute_delete id=%s", image_id)
        _emit_bulk_progress(
            {
                "plan_id": bid,
                "bulk_id": bid,
                "done": i + 1,
                "total": total,
                "kind": "delete",
            },
        )
        if (i + 1) % 50 == 0:
            time.sleep(0)

    _emit_bulk_completed(
        {
            "plan_id": bid,
            "bulk_id": bid,
            "done": total,
            "total": total,
            "kind": "delete",
            "failed": failed,
        },
    )
    _audit.log_event(
        "bulk_delete_completed",
        actor,
        {
            "plan_id": bid,
            "deleted": ok_count,
            "failed": len(failed),
            "total_bytes": raw.total_bytes,
        },
    )
    return {"deleted": ok_count, "failed": failed, "plan_id": bid}


def delete_single_image(
    image_id: int,
    *,
    db_path: Path,
    actor: str = "unknown",
) -> dict:
    """Delete one on-disk file then DB row via ``DeleteImageOp`` (T25)."""
    rec = _repo.get_image(int(image_id), db_path=db_path)
    if rec is None:
        raise KeyError(f"image {image_id} not found")

    roots = _folders.list_roots(db_path=db_path)
    root_paths = [str(r["path"]) for r in roots]
    _paths.assert_inside_root(rec.path, root_paths)

    p = Path(rec.path)
    posix_path = p.as_posix()
    if p.is_file():
        try:
            os.unlink(str(p))
        except OSError as exc:
            raise PreflightMoveError(
                "bad_path", str(exc), {"id": int(image_id)},
            ) from exc

    wq = _write_queue_handle()
    fut = wq.enqueue_write(
        _repo.MID,
        _repo.DeleteImageOp(path=posix_path),
    )
    did = fut.result(timeout=120.0)
    if did is not None:
        broadcast_image_deleted(int(did))
    _audit.log_event(
        "image_delete",
        actor,
        {"id": int(image_id), "path": posix_path},
    )
    return {"id": int(image_id), "removed_row": did is not None}


def _write_queue_handle() -> _repo.WriteQueue:
    from . import _write_queue as wq  # noqa: WPS433 — lazy init (routes pattern)

    if wq is None:
        raise RuntimeError("gallery WriteQueue is not started")
    return wq


def _bulk_priority(n_rows: int) -> int:
    return _repo.HIGH if n_rows <= BULK_HIGH_IF_TOTAL_LEQ else _repo.MID


def _tags_from_csv(tags_csv: Optional[str]) -> Tuple[str, ...]:
    if not tags_csv:
        return ()
    return tuple(t for t in str(tags_csv).split(",") if t)


def _merge_tag_lists(
    current: Tuple[str, ...],
    add: List[str],
    remove: List[str],
) -> List[str]:
    rset = {_vocab.normalize_tag(x) for x in remove}
    rset.discard("")
    out = [t for t in current if _vocab.normalize_tag(t) not in rset]
    seen = {_vocab.normalize_tag(t) for t in out}
    for a in add:
        nt = _vocab.normalize_tag(a)
        if nt and nt not in seen:
            out.append(nt)
            seen.add(nt)
    return out


def _parse_patch(body: Any) -> Tuple[Optional[int], Optional[List[str]]]:
    """Return ``(favorite_int_or_none, normalized_tags_or_none)``.

    ``normalized_tags`` is ``None`` when the wire body omits ``tags``;
    otherwise a (possibly empty) list of normalised unique tag strings.
    ``favorite`` is ``None`` when omitted, else ``0`` or ``1``.
    """
    if not isinstance(body, Mapping):
        raise ValueError("PATCH body must be a JSON object")
    unknown = set(body.keys()) - {"favorite", "tags"}
    if unknown:
        raise ValueError(f"unknown PATCH fields: {sorted(unknown)!r}")

    fav_raw = body.get("favorite", None)
    favorite: Optional[int] = None
    if "favorite" in body:
        if fav_raw is True:
            favorite = 1
        elif fav_raw is False:
            favorite = 0
        elif fav_raw in (0, 1):
            favorite = int(fav_raw)
        else:
            raise ValueError("favorite must be a boolean or 0/1")

    normalized_tags: Optional[List[str]] = None
    if "tags" in body:
        raw_tags = body["tags"]
        if raw_tags is None:
            raw_tags = []
        if not isinstance(raw_tags, list):
            raise ValueError("tags must be an array of strings")
        seen: set[str] = set()
        out: List[str] = []
        for item in raw_tags:
            if not isinstance(item, str):
                raise ValueError("each tag must be a string")
            nt = _vocab.normalize_tag(item)
            if not nt or nt in seen:
                continue
            seen.add(nt)
            out.append(nt)
        normalized_tags = out

    if favorite is None and normalized_tags is None:
        raise ValueError("PATCH body must set favorite and/or tags")

    return favorite, normalized_tags


def update_image(
    image_id: int,
    body: Any,
    *,
    db_path: Path,
) -> _repo.ImageRecord:
    """Apply gallery fields; bump ``version``; broadcast; ``notify`` worker."""
    rec = _repo.get_image(int(image_id), db_path=db_path)
    if rec is None:
        raise KeyError(f"image {image_id} not found")

    roots = _folders.list_roots(db_path=db_path)
    root_paths = [r["path"] for r in roots]
    _paths.assert_inside_root(rec.path, root_paths)

    favorite, normalized_tags = _parse_patch(body)

    wq = _write_queue_handle()
    op = _repo.UpdateImageOp(
        image_id=int(image_id),
        favorite=favorite,
        normalized_tags=normalized_tags,
        bump_version=True,
        refresh_sync=True,
    )
    fut = wq.enqueue_write(_repo.HIGH, op)
    new_version = int(fut.result(timeout=30.0))

    data: dict = {"id": int(image_id), "version": new_version}
    if favorite is not None:
        data["favorite"] = bool(favorite)
    if normalized_tags is not None:
        data["tags"] = list(normalized_tags)

    _ws_hub.broadcast(_ws_hub.IMAGE_UPDATED, data)
    _metadata_sync.notify(int(image_id), new_version)

    out = _repo.get_image(int(image_id), db_path=db_path)
    if out is None:
        raise RuntimeError(f"image {image_id} vanished after PATCH")
    return out


def resync_image(image_id: int, *, db_path: Path) -> _repo.ImageRecord:
    """Clear sync retry fields only (no ``version`` bump); ``notify`` worker."""
    rec = _repo.get_image(int(image_id), db_path=db_path)
    if rec is None:
        raise KeyError(f"image {image_id} not found")

    roots = _folders.list_roots(db_path=db_path)
    root_paths = [r["path"] for r in roots]
    _paths.assert_inside_root(rec.path, root_paths)

    wq = _write_queue_handle()
    fut = wq.enqueue_write(_repo.HIGH, _repo.ResyncMetadataOp(image_id=int(image_id)))
    ver = int(fut.result(timeout=30.0))

    _ws_hub.broadcast(
        _ws_hub.IMAGE_SYNC_STATUS_CHANGED,
        {"id": int(image_id), "sync_status": "pending", "version": ver},
    )
    _metadata_sync.notify(int(image_id), ver)

    out = _repo.get_image(int(image_id), db_path=db_path)
    if out is None:
        raise RuntimeError(f"image {image_id} vanished after resync")
    return out


def backfill_missing_steps(*, db_path: Path) -> Dict[str, Any]:
    """Re-read the metadata of every image that has no ``steps``.

    ``steps`` arrived in schema v7, so anything indexed before it is NULL — and the
    value is in the PNG, not in anything the database already holds. This marks those
    rows ``pending`` and lets the metadata sync worker do the reading: it already has
    the retry policy, the backoff and the broadcasts, and it picks the rows up on its
    own poll, so nothing here has to walk the disk or block the request.

    Manual on purpose (user's call, 2026-08-06): a migration must not spend minutes of
    disk re-reading a library while ComfyUI is trying to start.
    """
    missing = _repo.count_missing_steps(db_path=db_path)
    if missing == 0:
        return {"queued": 0, "missing": 0}
    wq = _write_queue_handle()
    fut = wq.enqueue_write(_repo.LOW, _repo.ResyncMissingStepsOp())
    queued = int(fut.result(timeout=60.0))
    logger.info("backfill: marked %s image(s) for a metadata re-read", queued)
    return {"queued": queued, "missing": missing}


#: What "send to Krita" will convert on the way. Krita's bridge takes PNG bytes and
#: decodes them with an explicit PNG hint, so anything else has to be re-encoded here.
_KRITA_NATIVE_SUFFIX = ".png"


def _png_bytes_for_krita(path: Path) -> bytes:
    """The file as PNG bytes. A JPEG/WebP in the gallery is re-encoded, losslessly as
    far as the pixels are concerned — the bridge decodes with a PNG format hint and
    would simply refuse the original."""
    if path.suffix.lower() == _KRITA_NATIVE_SUFFIX:
        return path.read_bytes()
    import io as _io

    from PIL import Image as _Image

    with _Image.open(path) as img:
        img.load()
        if img.mode not in ("RGB", "RGBA", "L"):
            img = img.convert("RGBA")
        buf = _io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()


def send_images_to_krita(
    image_ids: Sequence[int],
    *,
    mode: str = "new_layer",
    fit: str = "fit",
    db_path: Path,
) -> Dict[str, Any]:
    """Push gallery images into Krita, one layer each, in the order given.

    The layer is named after the file, so a Krita document with six of these in it
    still says which is which.

    Every image goes through the SAME send helper the node uses, which means the
    new_layer -> new_document fallback applies per image: with nothing open in Krita,
    the first image creates the document and the rest land on top of it. That is the
    behaviour you want for a batch, and it falls out rather than being special-cased.

    A failure on one image does not abort the rest — the result says which ones went
    and which did not, because "I selected twelve and something went wrong" needs to
    name the ones that did not make it.
    """
    from krita_nodes import send as _krita_send

    roots = _folders.list_roots(db_path=db_path)
    root_paths = [r["path"] for r in roots]

    sent: List[Dict[str, Any]] = []
    failed: List[Dict[str, Any]] = []
    for image_id in image_ids:
        iid = int(image_id)
        try:
            rec = _repo.get_image(iid, db_path=db_path)
            if rec is None:
                raise KeyError(f"image {iid} not found")
            if rec.media_kind == "video":
                # Krita has no notion of a video layer. The grid already hides
                # the button on a video card; this is the batch case, where a
                # mixed selection must skip the clips and still send the stills
                # rather than failing the whole send.
                raise ValueError("videos cannot be sent to Krita")
            _paths.assert_inside_root(rec.path, root_paths)
            disk = Path(rec.path)
            if not disk.is_file():
                raise FileNotFoundError(f"missing on disk: {rec.path}")
            result = _krita_send.send_png(
                _png_bytes_for_krita(disk),
                mode=str(mode),
                layer_name=disk.stem or f"image {iid}",
                fit=str(fit),
                launch=True,
                max_wait=180.0,
            )
            sent.append({
                "id": iid,
                "name": disk.name,
                "mode": result.get("mode"),
                "layer": result.get("layer"),
                "document": result.get("document"),
            })
        except Exception as exc:  # noqa: BLE001 - one bad image must not sink the batch
            logger.warning("send_to_krita failed for image %s: %s", iid, exc)
            failed.append({"id": iid, "error": str(exc)})

    return {"sent": sent, "failed": failed, "total": len(list(image_ids))}


def broadcast_image_upserted(image_id: int) -> None:
    """T20 watcher: indexer wrote a row; notify WS (SPEC 7.9 信封)."""
    _ws_hub.broadcast(_ws_hub.IMAGE_UPSERTED, {"id": int(image_id)})


def broadcast_image_deleted(image_id: int) -> None:
    _ws_hub.broadcast(_ws_hub.IMAGE_DELETED, {"id": int(image_id)})


def broadcast_index_overflow(root_id: int) -> None:
    """T20: Coalescer 触顶 → 降级 delta_scan; 用漂移事件可观测 (前端 T22+)."""
    _ws_hub.broadcast(
        _ws_hub.INDEX_DRIFT_DETECTED,
        {"root_id": int(root_id), "reason": "coalescer_high_watermark"},
    )


def bulk_set_favorite(
    sel: _repo.SelectionSpec,
    value: bool,
    *,
    db_path: Path,
) -> dict:
    """Apply favorite to every image in ``sel``; one op / tx + per-id WS (T23)."""
    rows = _repo.fetch_selection_id_paths(db_path=db_path, sel=sel)
    total = len(rows)
    bulk_id = str(uuid.uuid4())
    if total == 0:
        _emit_bulk_completed(
            {
                "bulk_id": bulk_id, "done": 0, "total": 0, "kind": "favorite",
            },
        )
        return {"affected": 0, "bulk_id": bulk_id}

    pr = _bulk_priority(total)
    roots = _folders.list_roots(db_path=db_path)
    root_paths = [r["path"] for r in roots]
    wq = _write_queue_handle()
    _emit_bulk_progress(
        {
            "bulk_id": bulk_id, "done": 0, "total": total, "kind": "favorite",
        },
    )
    failed: List[dict] = []
    ok_count = 0
    sync_hint: Dict[int, int] = {}
    for i, (image_id, path) in enumerate(rows):
        try:
            _paths.assert_inside_root(path, root_paths)
            fut = wq.enqueue_write(
                pr,
                _repo.UpdateImageOp(
                    image_id=int(image_id),
                    favorite=1 if value else 0,
                    normalized_tags=None,
                    bump_version=True,
                    refresh_sync=True,
                ),
            )
            ver = int(fut.result(timeout=120.0))
        except (KeyError, _paths.SandboxError) as e:
            code = "sandbox" if isinstance(e, _paths.SandboxError) else "not_found"
            failed.append(
                {"id": int(image_id), "code": code, "message": str(e)},
            )
            logger.warning("bulk_set_favorite id=%s: %s", image_id, e)
        except Exception as e:  # noqa: BLE001
            failed.append(
                {
                    "id": int(image_id),
                    "code": "internal",
                    "message": str(e),
                },
            )
            logger.exception("bulk_set_favorite id=%s", image_id)
        else:
            ok_count += 1
            _ws_hub.broadcast(
                _ws_hub.IMAGE_UPDATED,
                {
                    "id": int(image_id),
                    "version": ver,
                    "favorite": bool(value),
                },
            )
            sync_hint[int(image_id)] = int(ver)
        _emit_bulk_progress(
            {
                "bulk_id": bulk_id,
                "done": i + 1,
                "total": total,
                "kind": "favorite",
            },
        )
    if sync_hint:
        _metadata_sync.queue_many(sync_hint)
    _emit_bulk_completed(
        {
            "bulk_id": bulk_id,
            "done": total,
            "total": total,
            "kind": "favorite",
            "failed": failed,
        },
    )
    return {
        "affected": ok_count, "failed": failed, "bulk_id": bulk_id,
    }


def bulk_edit_tags(
    sel: _repo.SelectionSpec,
    add: List[str],
    remove: List[str],
    *,
    db_path: Path,
) -> dict:
    """Add/remove normalised tags on every image in ``sel`` (T23)."""
    add_n = [_vocab.normalize_tag(x) for x in add]
    add_n = [x for x in add_n if x]
    rem_n = [_vocab.normalize_tag(x) for x in remove]
    rem_n = [x for x in rem_n if x]
    if not add_n and not rem_n:
        raise ValueError("add/remove must contain at least one non-empty tag")

    rows = _repo.fetch_selection_id_path_tags_csv(db_path=db_path, sel=sel)
    total = len(rows)
    bulk_id = str(uuid.uuid4())
    if total == 0:
        _emit_bulk_completed(
            {"bulk_id": bulk_id, "done": 0, "total": 0, "kind": "tags"},
        )
        return {"affected": 0, "bulk_id": bulk_id}

    pr = _bulk_priority(total)
    roots = _folders.list_roots(db_path=db_path)
    root_paths = [r["path"] for r in roots]
    wq = _write_queue_handle()
    _emit_bulk_progress(
        {
            "bulk_id": bulk_id, "done": 0, "total": total, "kind": "tags",
        },
    )
    failed: List[dict] = []
    ok_count = 0
    sync_hint2: Dict[int, int] = {}
    for i, (image_id, path, tags_csv) in enumerate(rows):
        try:
            _paths.assert_inside_root(path, root_paths)
        except _paths.SandboxError as e:
            failed.append(
                {"id": int(image_id), "code": "sandbox", "message": str(e)},
            )
            logger.warning("bulk_edit_tags sandbox id=%s: %s", image_id, e)
            _emit_bulk_progress(
                {
                    "bulk_id": bulk_id,
                    "done": i + 1,
                    "total": total,
                    "kind": "tags",
                },
            )
            continue
        cur = _tags_from_csv(tags_csv)
        new_list = _merge_tag_lists(cur, add_n, rem_n)
        # Must match what UpdateImageOp will write: ",".join(new_list) or NULL for empty.
        # list(cur) == new_list is unsafe (tuple vs list) and can diverge from tags_csv
        # string form; one bad skip leaves disk/DB out of sync with a few items.
        if (not new_list) and (not cur):
            _emit_bulk_progress(
                {
                    "bulk_id": bulk_id,
                    "done": i + 1,
                    "total": total,
                    "kind": "tags",
                },
            )
            continue
        want_csv: Optional[str] = ",".join(new_list) if new_list else None
        if want_csv is not None and (tags_csv or "") == want_csv:
            _emit_bulk_progress(
                {
                    "bulk_id": bulk_id,
                    "done": i + 1,
                    "total": total,
                    "kind": "tags",
                },
            )
            continue
        try:
            fut = wq.enqueue_write(
                pr,
                _repo.UpdateImageOp(
                    image_id=int(image_id),
                    favorite=None,
                    normalized_tags=new_list,
                    bump_version=True,
                    refresh_sync=True,
                ),
            )
            ver = int(fut.result(timeout=120.0))
        except (KeyError, _paths.SandboxError) as e:
            code = "sandbox" if isinstance(e, _paths.SandboxError) else "not_found"
            failed.append(
                {"id": int(image_id), "code": code, "message": str(e)},
            )
            logger.warning("bulk_edit_tags op id=%s: %s", image_id, e)
        except Exception as e:  # noqa: BLE001
            failed.append(
                {
                    "id": int(image_id),
                    "code": "internal",
                    "message": str(e),
                },
            )
            logger.exception("bulk_edit_tags id=%s", image_id)
        else:
            ok_count += 1
            _ws_hub.broadcast(
                _ws_hub.IMAGE_UPDATED,
                {
                    "id": int(image_id),
                    "version": ver,
                    "tags": list(new_list),
                },
            )
            sync_hint2[int(image_id)] = int(ver)
        _emit_bulk_progress(
            {
                "bulk_id": bulk_id,
                "done": i + 1,
                "total": total,
                "kind": "tags",
            },
        )
    if sync_hint2:
        _metadata_sync.queue_many(sync_hint2)
    _emit_bulk_completed(
        {
            "bulk_id": bulk_id,
            "done": total,
            "total": total,
            "kind": "tags",
            "failed": failed,
        },
    )
    return {
        "affected": ok_count, "failed": failed, "bulk_id": bulk_id,
    }


def _folder_segment_ok(name: str) -> bool:
    s = (name or "").strip()
    if not s or s in (".", ".."):
        return False
    if "/" in s or "\\" in s or "\x00" in s:
        return False
    return True


def _rel_from_root(*, abs_path: str, root_path: str) -> str:
    rp = Path(str(root_path)).resolve(strict=False).as_posix().rstrip("/")
    ap = Path(str(abs_path)).resolve(strict=False).as_posix()
    if ap == rp:
        return ""
    if not ap.startswith(rp + "/"):
        return "\x00"
    return ap[len(rp) + 1:]


def _image_count_under_rel(
    *, db_path: Path, root_id: int, rel_prefix: str,
) -> int:
    conn = _db.connect_read(db_path)
    try:
        if rel_prefix == "":
            row = conn.execute(
                "SELECT COUNT(*) AS c FROM image WHERE folder_id = ?",
                (int(root_id),),
            ).fetchone()
            return int(row["c"])
        esc = (
            rel_prefix.replace("\\", "\\\\")
            .replace("%", "\\%")
            .replace("_", "\\_")
        )
        pat = esc + "/%"
        row = conn.execute(
            "SELECT COUNT(*) AS c FROM image WHERE folder_id = ? AND "
            "(relative_path = ? OR relative_path LIKE ? ESCAPE '\\')",
            (int(root_id), rel_prefix, pat),
        ).fetchone()
        return int(row["c"])
    finally:
        conn.close()


def _broadcast_folder_changed(root_id: int) -> None:
    _ws_hub.broadcast(_ws_hub.FOLDER_CHANGED, {"root_id": int(root_id)})


def folder_register_custom_root(
    path: str, *, db_path: Path, data_dir: Path,
) -> Dict[str, Any]:
    wq = _write_queue_handle()
    out = _folders.add_root(
        path, db_path=db_path, data_dir=data_dir, write_queue=wq,
    )
    posix = str(out["path"])
    for row in _folders.list_roots(db_path=db_path):
        if str(row["path"]) == posix:
            rid = int(row["id"])
            folder_schedule_rescan(rid, db_path=db_path)
            _broadcast_folder_changed(rid)
            return {
                "id": rid,
                "path": posix,
                "kind": str(out["kind"]),
                "display_name": str(out["display_name"]),
                "removable": int(out["removable"]),
            }
    raise RuntimeError("folder row missing after add_root")


def folder_unregister_custom_root(
    folder_id: int, *, db_path: Path, data_dir: Path,
) -> None:
    row = _repo.fetch_folder_row(db_path=db_path, folder_id=int(folder_id))
    if row is None:
        raise KeyError(f"folder {folder_id} not found")
    if row["parent_id"] is not None:
        raise ValueError("not a registered root")
    if int(row["removable"]) != 1:
        raise PermissionError("cannot remove built-in root")
    wq = _write_queue_handle()
    fut = wq.enqueue_write(
        _repo.MID,
        _repo.UnindexCustomRootOp(
            root_id=int(folder_id),
            root_path=str(row["path"]),
        ),
    )
    fut.result(timeout=120.0)
    _folders.remove_root_from_config(str(row["path"]), data_dir=data_dir)
    _broadcast_folder_changed(int(folder_id))


def _moved_subtree_bypass_path_sets(
    old_prefix: str, new_prefix: str, *, db_path: Path,
) -> Tuple[Set[str], Set[str]]:
    """After ``RelocateFolderSubtree``, return exact (old, new) image path sets
    for the moved subtree. Used to skip redundant watcher d/u (bulk-move style).
    """
    n_new = _repo._norm_fs_path(new_prefix)
    o_old = _repo._norm_fs_path(old_prefix)
    new_set: Set[str] = set()
    conn = _db.connect_read(db_path)
    try:
        like_pat = _repo._sql_like_escape(n_new) + "/%"
        for (pth,) in conn.execute(
            "SELECT path FROM image "
            "WHERE path = ? OR (path LIKE ? ESCAPE '\\')",
            (n_new, like_pat),
        ):
            new_set.add(_repo._norm_fs_path(str(pth)))
    finally:
        conn.close()
    old_set: Set[str] = set()
    for p in new_set:
        if p == n_new:
            old_set.add(o_old)
        elif p.startswith(n_new + "/"):
            rel = p[len(n_new) + 1 :]
            old_set.add(f"{o_old}/{rel}" if o_old else rel)
    return old_set, new_set


def _register_moved_subtree_bypass(old_p: str, new_p: str, *, db_path: Path) -> None:
    try:
        s_old, s_new = _moved_subtree_bypass_path_sets(old_p, new_p, db_path=db_path)
        if not s_old and not s_new:
            return
        from . import watcher as _watcher

        _watcher.register_moved_subtree_bypass(s_old, s_new)
    except Exception:  # noqa: BLE001
        logger.debug(
            "register_moved_subtree_bypass failed old=%r new=%r",
            old_p, new_p, exc_info=True,
        )


def folder_schedule_rescan(folder_id: int, *, db_path: Path) -> None:
    pair = _repo.fetch_folder_with_root(db_path=db_path, folder_id=int(folder_id))
    if pair is None:
        raise KeyError(f"folder {folder_id} not found")
    _ignored, root = pair
    wq = _write_queue_handle()
    root_dict = {
        "id": int(root["id"]),
        "path": str(root["path"]),
        "kind": str(root["kind"]),
    }

    def _worker() -> None:
        from . import indexer as _indexer
        from . import job_registry as _jr
        try:
            jid = _jr.new_job_id()
            _indexer.delta_scan(
                root_dict, db_path=db_path, write_queue=wq, mode="light",
                job_id=jid,
            )
        except Exception:
            logger.exception("folder rescan worker failed root_id=%s", root_dict["id"])

    threading.Thread(target=_worker, name="gallery-folder-rescan", daemon=True).start()


def folder_mkdir(parent_folder_id: int, name: str, *, db_path: Path) -> Dict[str, Any]:
    if not _folder_segment_ok(name):
        raise ValueError("invalid folder name")
    pair = _repo.fetch_folder_with_root(
        db_path=db_path, folder_id=int(parent_folder_id),
    )
    if pair is None:
        raise KeyError("folder not found")
    parent_folder, root = pair
    roots = _folders.list_roots(db_path=db_path)
    root_paths = [str(r["path"]) for r in roots]
    parent_dir = _paths.assert_inside_root(parent_folder["path"], root_paths)
    dest = (Path(str(parent_dir)) / str(name).strip()).resolve(strict=False)
    _paths.assert_inside_root(dest, root_paths)
    rp = Path(str(root["path"])).resolve(strict=False).as_posix()
    if _paths.is_derivative_path_excluded(dest.as_posix() + "/.probe.png", rp):
        raise ValueError("path not allowed under root")
    if dest.exists():
        raise FileExistsError(str(dest))
    os.mkdir(str(dest), mode=0o755)
    wq = _write_queue_handle()
    fut = wq.enqueue_write(
        _repo.LOW,
        _repo.ReconcileFoldersUnderRootOp(
            root_id=int(root["id"]),
            root_path=str(root["path"]),
            root_kind=str(root["kind"]),
        ),
    )
    fut.result(timeout=120.0)
    _broadcast_folder_changed(int(root["id"]))
    return {"path": dest.as_posix(), "root_id": int(root["id"])}


def folder_rename(folder_id: int, new_name: str, *, db_path: Path) -> None:
    if not _folder_segment_ok(new_name):
        raise ValueError("invalid folder name")
    pair = _repo.fetch_folder_with_root(db_path=db_path, folder_id=int(folder_id))
    if pair is None:
        raise KeyError("folder not found")
    folder, root = pair
    if folder["parent_id"] is None:
        raise PermissionError("cannot rename registered root")
    roots = _folders.list_roots(db_path=db_path)
    root_paths = [str(r["path"]) for r in roots]
    old_abs = _paths.assert_inside_root(folder["path"], root_paths)
    parent = Path(str(old_abs)).parent
    dest = (parent / str(new_name).strip()).resolve(strict=False)
    _paths.assert_inside_root(dest, root_paths)
    rp = Path(str(root["path"])).resolve(strict=False).as_posix()
    if _paths.is_derivative_path_excluded(dest.as_posix() + "/.probe.png", rp):
        raise ValueError("path not allowed under root")
    if dest.exists():
        raise FileExistsError(str(dest))
    old_p = Path(str(old_abs)).resolve(strict=False).as_posix()
    new_p = dest.as_posix()
    os.rename(old_p, new_p)
    wq = _write_queue_handle()
    fut = wq.enqueue_write(
        _repo.MID,
        _repo.RelocateFolderSubtreeDbOp(
            root_id=int(root["id"]),
            root_path=str(root["path"]),
            old_prefix=old_p,
            new_prefix=new_p,
        ),
    )
    fut.result(timeout=120.0)
    fut_rec = wq.enqueue_write(
        _repo.LOW,
        _repo.ReconcileFoldersUnderRootOp(
            root_id=int(root["id"]),
            root_path=str(root["path"]),
            root_kind=str(root["kind"]),
        ),
    )
    fut_rec.result(timeout=120.0)
    _register_moved_subtree_bypass(str(old_p), new_p, db_path=db_path)
    _broadcast_folder_changed(int(root["id"]))
    # RelocateFolderSubtree + Reconcile already make folder/image paths
    # consistent. A follow-up full-root delta_scan would only duplicate
    # work with the file-watcher d+u storm and can stall progress for
    # large subfolders. Manual rescan remains available on the API.
    # Watcher d/u for moved files is also skipped for exact precomputed paths.


def folder_move(folder_id: int, target_parent_id: int, *, db_path: Path) -> None:
    pair = _repo.fetch_folder_with_root(db_path=db_path, folder_id=int(folder_id))
    if pair is None:
        raise KeyError("folder not found")
    folder, root = pair
    if folder["parent_id"] is None:
        raise PermissionError("cannot move registered root")
    tgt = _repo.fetch_folder_with_root(
        db_path=db_path, folder_id=int(target_parent_id),
    )
    if tgt is None:
        raise KeyError("target folder not found")
    tgt_folder, tgt_root = tgt
    cross = int(root["id"]) != int(tgt_root["id"])
    roots = _folders.list_roots(db_path=db_path)
    root_paths = [str(r["path"]) for r in roots]
    old_abs = Path(
        str(_paths.assert_inside_root(folder["path"], root_paths)),
    ).resolve(strict=False)
    parent_abs = Path(
        str(_paths.assert_inside_root(tgt_folder["path"], root_paths)),
    ).resolve(strict=False)
    new_abs = (parent_abs / old_abs.name).resolve(strict=False)
    _paths.assert_inside_root(new_abs, root_paths)
    rp_src = Path(str(root["path"])).resolve(strict=False).as_posix()
    rp_tgt = Path(str(tgt_root["path"])).resolve(strict=False).as_posix()
    rp_chk = rp_tgt if cross else rp_src
    if _paths.is_derivative_path_excluded(new_abs.as_posix() + "/.probe.png", rp_chk):
        raise ValueError("path not allowed under root")
    try:
        new_abs.relative_to(parent_abs)
    except ValueError as exc:
        raise ValueError("invalid target parent") from exc
    o_str = old_abs.as_posix()
    p_str = parent_abs.as_posix()
    if p_str.startswith(o_str + "/") or p_str == o_str:
        raise ValueError("cannot move folder into itself or its descendant")
    if new_abs == old_abs:
        return
    if new_abs.exists():
        raise FileExistsError(str(new_abs))
    shutil.move(o_str, str(new_abs))
    roots_pairs = [(int(r["id"]), str(r["path"])) for r in roots]
    sec_rel = (int(tgt_root["id"]), str(tgt_root["path"])) if cross else None
    wq = _write_queue_handle()
    fut = wq.enqueue_write(
        _repo.MID,
        _repo.RelocateFolderSubtreeDbOp(
            root_id=int(root["id"]),
            root_path=str(root["path"]),
            old_prefix=o_str,
            new_prefix=str(new_abs),
            all_roots=roots_pairs,
            secondary_relink=sec_rel,
        ),
    )
    fut.result(timeout=120.0)
    to_rec = [root, tgt_root] if cross else [root]
    seen: Dict[int, Any] = {}
    for r in to_rec:
        seen[int(r["id"])] = r
    for r in seen.values():
        fut_rec = wq.enqueue_write(
            _repo.LOW,
            _repo.ReconcileFoldersUnderRootOp(
                root_id=int(r["id"]),
                root_path=str(r["path"]),
                root_kind=str(r["kind"]),
            ),
        )
        fut_rec.result(timeout=120.0)
    for r in seen.values():
        _broadcast_folder_changed(int(r["id"]))
    _register_moved_subtree_bypass(o_str, str(new_abs), db_path=db_path)
    # Intentionally no folder_schedule_rescan: same as folder_rename
    # (see comment there). Watcher T20 + optional manual rescan cover drift;
    # moved file d/u is skipped for exact precomputed path pairs.


def folder_delete_preview(folder_id: int, *, db_path: Path) -> Dict[str, Any]:
    pair = _repo.fetch_folder_with_root(db_path=db_path, folder_id=int(folder_id))
    if pair is None:
        raise KeyError("folder not found")
    folder, root = pair
    if folder["parent_id"] is None:
        raise PermissionError("preview is only for subfolders")
    roots = _folders.list_roots(db_path=db_path)
    root_paths = [str(r["path"]) for r in roots]
    abs_path = _paths.assert_inside_root(folder["path"], root_paths)
    rel = _rel_from_root(abs_path=str(abs_path), root_path=str(root["path"]))
    if rel == "\x00":
        raise _paths.SandboxError("path outside root")
    n_img = _image_count_under_rel(
        db_path=db_path, root_id=int(root["id"]), rel_prefix=rel,
    )
    try:
        disk_n = len(os.listdir(str(abs_path)))
    except OSError:
        disk_n = -1
    return {
        "indexed_images": int(n_img),
        "disk_entry_count": int(disk_n),
        "can_empty_delete": int(n_img) == 0 and disk_n == 0,
    }


def folder_delete_purge(folder_id: int, *, db_path: Path) -> Dict[str, Any]:
    pair = _repo.fetch_folder_with_root(db_path=db_path, folder_id=int(folder_id))
    if pair is None:
        raise KeyError("folder not found")
    folder, root = pair
    if folder["parent_id"] is None:
        raise PermissionError("cannot purge-delete a registered root this way")
    roots = _folders.list_roots(db_path=db_path)
    root_paths = [str(r["path"]) for r in roots]
    abs_path = _paths.assert_inside_root(folder["path"], root_paths)
    rel = _rel_from_root(abs_path=str(abs_path), root_path=str(root["path"]))
    if rel == "\x00":
        raise _paths.SandboxError("path outside root")
    prefix_norm = Path(str(abs_path)).resolve(strict=False).as_posix().rstrip("/")
    if not os.path.isdir(str(abs_path)):
        raise FileNotFoundError(str(abs_path))
    shutil.rmtree(str(abs_path), ignore_errors=False)
    wq = _write_queue_handle()
    fut = wq.enqueue_write(
        _repo.MID,
        _repo.PurgeFolderSubtreeDbOp(subtree_prefix_posix=prefix_norm),
    )
    raw = fut.result(timeout=120.0)
    deleted_ids = raw if isinstance(raw, list) else []
    for iid in deleted_ids:
        broadcast_image_deleted(int(iid))
    fut_rec = wq.enqueue_write(
        _repo.LOW,
        _repo.ReconcileFoldersUnderRootOp(
            root_id=int(root["id"]),
            root_path=str(root["path"]),
            root_kind=str(root["kind"]),
        ),
    )
    fut_rec.result(timeout=120.0)
    _broadcast_folder_changed(int(root["id"]))
    folder_schedule_rescan(int(root["id"]), db_path=db_path)
    return {"deleted_images": len(deleted_ids)}


def folder_delete_empty(folder_id: int, *, db_path: Path) -> None:
    pair = _repo.fetch_folder_with_root(db_path=db_path, folder_id=int(folder_id))
    if pair is None:
        raise KeyError("folder not found")
    folder, root = pair
    if folder["parent_id"] is None:
        raise PermissionError("use DELETE /folders/{id} to remove a custom root")
    roots = _folders.list_roots(db_path=db_path)
    root_paths = [str(r["path"]) for r in roots]
    abs_path = _paths.assert_inside_root(folder["path"], root_paths)
    rel = _rel_from_root(abs_path=str(abs_path), root_path=str(root["path"]))
    if rel == "\x00":
        raise _paths.SandboxError("path outside root")
    n_img = _image_count_under_rel(
        db_path=db_path, root_id=int(root["id"]), rel_prefix=rel,
    )
    if n_img > 0:
        raise OSError(errno.ENOTEMPTY, "folder is not empty (indexed images)")
    try:
        names = os.listdir(str(abs_path))
    except OSError as exc:
        raise exc
    if names:
        raise OSError(errno.ENOTEMPTY, "folder is not empty on disk")
    os.rmdir(str(abs_path))
    wq = _write_queue_handle()
    fut = wq.enqueue_write(
        _repo.LOW,
        _repo.ReconcileFoldersUnderRootOp(
            root_id=int(root["id"]),
            root_path=str(root["path"]),
            root_kind=str(root["kind"]),
        ),
    )
    fut.result(timeout=120.0)
    _broadcast_folder_changed(int(root["id"]))


def folder_open_in_os(folder_id: int, *, db_path: Path) -> None:
    pair = _repo.fetch_folder_with_root(db_path=db_path, folder_id=int(folder_id))
    if pair is None:
        raise KeyError("folder not found")
    folder, _root = pair
    roots = _folders.list_roots(db_path=db_path)
    root_paths = [str(r["path"]) for r in roots]
    abs_path = _paths.assert_inside_root(folder["path"], root_paths)
    p = str(Path(str(abs_path)).resolve(strict=False))
    system = platform.system()
    try:
        if system == "Windows":
            os.startfile(p)  # type: ignore[attr-defined]
        elif system == "Darwin":
            subprocess.Popen(["open", p], close_fds=True)  # noqa: S603
        else:
            subprocess.Popen(["xdg-open", p], close_fds=True)  # noqa: S603
    except OSError as exc:
        raise RuntimeError(f"failed to open folder: {exc}") from exc


def tag_admin_list(
    *,
    db_path: Path,
    query: str = "",
    limit: int = 10,
    offset: int = 0,
    sort_key: str = "usage",
    sort_dir: str = "desc",
) -> Dict[str, Any]:
    """Read-only tag page for Settings (sortable; substring + exact-first; total count)."""
    page = _repo.list_tags_admin(
        db_path=db_path,
        query=query,
        limit=limit,
        offset=offset,
        sort_key=sort_key,
        sort_dir=sort_dir,
    )
    return {
        "tags": list(page["tags"]),
        "total": int(page["total"]),
    }


def _broadcast_image_updated_tags(
    image_id: int, version: int, *, db_path: Path,
) -> None:
    """``image.updated`` (tags) for callers that batch `metadata_sync.queue_many` (T44)."""
    rec = _repo.get_image(int(image_id), db_path=db_path)
    payload: Dict[str, Any] = {"id": int(image_id), "version": int(version)}
    if rec is not None:
        payload["tags"] = list(rec.tags)
    _ws_hub.broadcast(_ws_hub.IMAGE_UPDATED, payload)


def tag_admin_delete(*, name: str, db_path: Path) -> Dict[str, Any]:
    from . import job_registry as _jr

    wq = _write_queue_handle()
    fut = wq.enqueue_write(_repo.MID, _repo.DeleteTagByNameOp(name=name))
    out = fut.result(timeout=120.0)
    aff = list(out.get("affected") or ())
    to_sync: Dict[int, int] = {}
    naff = len(aff)
    jid: Optional[str] = _jr.new_job_id() if naff > 1 else None
    if jid is not None:
        _jr.start_generic_job(
            jid, kind="tag_delete", done=0, total=naff, phase="notify", message="",
        )
    for k, pair in enumerate(aff):
        iid, ver = int(pair[0]), int(pair[1])
        to_sync[iid] = ver
        _broadcast_image_updated_tags(iid, ver, db_path=db_path)
        if jid is not None and ((k + 1) % 10 == 0 or (k + 1) == naff):
            _jr.emit_job_progress(
                jid, kind="tag_delete", done=k + 1, total=naff, phase="notify",
            )
    if to_sync:
        _metadata_sync.queue_many(to_sync)
    if jid is not None and naff > 1:
        _jr.emit_job_done(
            jid, kind="tag_delete", terminal="ok", ok=naff, failed=0, phase="notify",
        )
    return out


def tag_admin_purge_zero(*, db_path: Path) -> Dict[str, Any]:
    _ = db_path
    wq = _write_queue_handle()
    fut = wq.enqueue_write(_repo.LOW, _repo.PurgeZeroUsageTagsOp())
    return fut.result(timeout=120.0)


def tag_admin_rename(*, old_name: str, new_name: str, db_path: Path) -> Dict[str, Any]:
    from . import job_registry as _jr

    wq = _write_queue_handle()
    fut = wq.enqueue_write(
        _repo.MID,
        _repo.RenameTagOp(old_name=old_name, new_name=new_name),
    )
    out = fut.result(timeout=120.0)
    aff = list(out.get("affected") or ())
    to_sync: Dict[int, int] = {}
    naff = len(aff)
    jid2: Optional[str] = _jr.new_job_id() if naff > 1 else None
    if jid2 is not None:
        _jr.start_generic_job(
            jid2, kind="tag_rename", done=0, total=naff, phase="notify", message="",
        )
    for k, pair in enumerate(aff):
        iid, ver = int(pair[0]), int(pair[1])
        to_sync[iid] = ver
        _broadcast_image_updated_tags(iid, ver, db_path=db_path)
        if jid2 is not None and ((k + 1) % 10 == 0 or (k + 1) == naff):
            _jr.emit_job_progress(
                jid2, kind="tag_rename", done=k + 1, total=naff, phase="notify",
            )
    if to_sync:
        _metadata_sync.queue_many(to_sync)
    if jid2 is not None and naff > 1:
        _jr.emit_job_done(
            jid2, kind="tag_rename", terminal="ok", ok=naff, failed=0, phase="notify",
        )
    return out
