"""XYZ Image Gallery — registered roots manager + config persistence (T05).

Owns the rows in ``folder`` whose ``parent_id IS NULL`` (= registered roots):
  * Default ``output`` / ``input`` (kind in {'output','input'}, removable=0)
    — seeded once at startup from ``folder_paths`` (ComfyUI core, C-8).
  * Custom roots (kind='custom', removable=1) — added via ``add_root()``.

Mirrors custom-root paths into ``gallery_data/gallery_config.json`` per C-10
so the human-editable file can be used for recovery / inspection.

All writes go through ``repo.WriteQueue`` — never ``conn.execute("INSERT…")``
from this module — so the single-writer invariant from ARCHITECTURE §4.6
(restated as PROJECT_STATE §4 #15 / AI_RULES R5.5) is preserved even for
the trivial first-startup seed.

Out of scope (deferred, per AI_RULES R1.2 / R4.3):
  * ``remove_root`` / UI management of custom roots — L4 (TASKS notes).
  * Auto-rehydration of custom roots from ``gallery_config.json`` into the
    DB on startup — not in T05's test set.
  * Real consumers of ``prompt_stopwords`` / ``vocab_version`` — T15 / T28.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from . import db as _db
from . import repo as _repo

logger = logging.getLogger("xyz.gallery.folders")

__all__ = [
    "ensure_default_roots",
    "add_root",
    "list_roots",
    "remove_root_from_config",
    "RootConflictError",
    "CONFIG_FILENAME",
    "get_gallery_preferences",
    "patch_gallery_preferences",
    "normalize_download_variant",
]

_PathLike = Union[str, Path]

CONFIG_FILENAME = "gallery_config.json"

# Bound the wait on the WriteQueue future during startup root registration.
# A folder INSERT is trivial; if we exceed this the writer thread is wedged
# and bubbling the timeout is the right behaviour (don't silently swallow).
_WRITE_TIMEOUT_SEC = 5.0

# Placeholder fields per PROJECT_STATE §7 note 6 — only ``roots`` is consumed
# by T05. ``prompt_stopwords`` / ``vocab_version`` are existence-only stubs
# that T15 / T28 will fill with real semantics.
_DEFAULT_CONFIG: Dict[str, Any] = {
    "roots": [],
    "prompt_stopwords": [],
    "vocab_version": 2,
    # T35 / T36 — PNG download variant for ``GET …/raw/{id}/download`` default
    # (query ``?variant=`` overrides). Values: full | no_workflow | clean.
    "download_variant": "full",
    # When true, SPA prompts per download; when false, ``download_variant`` applies.
    "download_prompt_each_time": False,
    # T36 — optional filename prefix for client-side ``download`` attribute.
    "download_basename_prefix": "",
    "developer_mode": False,
    "theme": "dark",
    "filter_visibility": {
        "name": True,
        "metadata_presence": True,
        "prompt_mode": True,
        "prompt_tokens": True,
        "tags": True,
        "favorite": True,
        "model": True,
        "dates": True,
    },
}

_DOWNLOAD_VARIANTS = frozenset({"full", "no_workflow", "no_gen", "clean"})
#: The variant IS two booleans — keep the workflow graph, keep the generation
#: data — and the four names are their four combinations. The UI shows the two
#: checkboxes; this stays the stored/wire form so an old preference and an old
#: `?variant=` link both keep working.
#:    full = both   no_workflow = gen only   no_gen = workflow only   clean = neither
_THEME_ALLOWED = frozenset({"dark", "light"})


class RootConflictError(ValueError):
    """``add_root()`` rejected because the candidate overlaps an existing root.

    Subclasses ``ValueError`` so generic callers can catch broadly, but the
    distinct type lets routes / UI render a specific message in T10.
    """


# -- gallery_config.json ----------------------------------------------------

def _config_path(data_dir: Path) -> Path:
    return Path(data_dir) / CONFIG_FILENAME


def _load_config(data_dir: Path) -> Dict[str, Any]:
    p = _config_path(data_dir)
    if not p.exists():
        return dict(_DEFAULT_CONFIG)
    try:
        with p.open("r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        # Corrupt / unreadable config must not brick the gallery — fall back
        # to defaults and log. The original file is left in place so a human
        # can recover it (C-10).
        logger.exception("failed to read %s; using defaults", p)
        return dict(_DEFAULT_CONFIG)
    merged = dict(_DEFAULT_CONFIG)
    if isinstance(data, dict):
        merged.update(data)
    if not isinstance(merged.get("roots"), list):
        merged["roots"] = []
    return merged


def _save_config(data_dir: Path, cfg: Dict[str, Any]) -> None:
    # write-temp + os.replace for crash-safety (mirrors the C-6 pattern that
    # T17 will use for PNG chunks; doing it here too keeps the on-disk file
    # never half-written).
    p = _config_path(data_dir)
    tmp = p.with_suffix(p.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    os.replace(tmp, p)


# -- helpers ----------------------------------------------------------------

def _posix(p: _PathLike) -> str:
    return Path(p).resolve(strict=False).as_posix()


def _select_existing_roots(db_path: _PathLike) -> List[Dict[str, Any]]:
    conn = _db.connect_read(db_path)
    try:
        rows = conn.execute(
            "SELECT id, path, kind, display_name, removable "
            "FROM folder WHERE parent_id IS NULL"
        ).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


def _is_overlap(a: str, b: str) -> bool:
    """True iff POSIX path ``a`` equals ``b`` or is its ancestor / descendant."""
    if a == b:
        return True
    pa, pb = Path(a), Path(b)
    try:
        pa.relative_to(pb)
        return True
    except ValueError:
        pass
    try:
        pb.relative_to(pa)
        return True
    except ValueError:
        pass
    return False


def _enqueue_ensure(write_queue, *, path: str, kind: str, removable: int,
                    display_name: str) -> None:
    op = _repo.EnsureFolderOp(
        path=path,
        kind=kind,
        removable=removable,
        display_name=display_name,
    )
    fut = write_queue.enqueue_write(_repo.HIGH, op)
    fut.result(timeout=_WRITE_TIMEOUT_SEC)


# -- public API -------------------------------------------------------------

def ensure_default_roots(*, db_path: _PathLike, data_dir: _PathLike,
                         write_queue) -> None:
    """Idempotently register ComfyUI ``output`` / ``input`` as non-removable roots.

    Safe to call on every startup; ``EnsureFolderOp`` uses INSERT OR IGNORE,
    and we additionally pre-filter against the current row set so the writer
    thread is not pestered with no-op inserts on warm starts.

    Also creates ``gallery_config.json`` with default fields if absent.
    Existing config files are left untouched to preserve manual edits (C-10).
    """
    try:
        import folder_paths  # ComfyUI core module, per C-8
    except Exception:
        # Should not happen inside ComfyUI runtime, but tests / standalone
        # use of this module shouldn't crash if folder_paths is missing.
        logger.exception(
            "folder_paths import failed; skipping default-root registration"
        )
        return

    candidates = [
        ("output", folder_paths.get_output_directory()),
        ("input", folder_paths.get_input_directory()),
    ]
    existing = {row["path"] for row in _select_existing_roots(db_path)}

    for kind, raw in candidates:
        if not raw:
            continue
        posix = _posix(raw)
        if posix in existing:
            continue
        _enqueue_ensure(
            write_queue,
            path=posix,
            kind=kind,
            removable=0,
            display_name=Path(posix).name or kind,
        )

    # Touch config file with defaults if it doesn't exist yet.
    cfg_path = _config_path(Path(data_dir))
    if not cfg_path.exists():
        _save_config(Path(data_dir), dict(_DEFAULT_CONFIG))


def add_root(path: _PathLike, *, db_path: _PathLike, data_dir: _PathLike,
             write_queue, display_name: Optional[str] = None) -> Dict[str, Any]:
    """Register a custom root after sandbox / overlap validation.

    Raises:
      * ``FileNotFoundError``  if ``path`` is not an existing directory.
      * ``PermissionError``    if the directory is not readable.
      * ``RootConflictError``  if it equals or overlaps any existing root
                               (default = forbid overlap, per
                               PROJECT_SPEC §10 Q5).
    """
    p = Path(path).resolve(strict=False)
    if not p.is_dir():
        raise FileNotFoundError(f"not a directory: {p}")
    if not os.access(str(p), os.R_OK):
        raise PermissionError(f"directory not readable: {p}")

    candidate = p.as_posix()
    for row in _select_existing_roots(db_path):
        if _is_overlap(candidate, row["path"]):
            raise RootConflictError(
                f"root {candidate!r} overlaps existing root {row['path']!r}"
            )

    label = display_name or p.name or candidate
    _enqueue_ensure(
        write_queue,
        path=candidate,
        kind="custom",
        removable=1,
        display_name=label,
    )

    cfg = _load_config(Path(data_dir))
    if candidate not in cfg["roots"]:
        cfg["roots"].append(candidate)
        _save_config(Path(data_dir), cfg)

    return {
        "path": candidate,
        "kind": "custom",
        "removable": 1,
        "display_name": label,
    }


def list_roots(*, db_path: _PathLike) -> List[Dict[str, Any]]:
    """Return all registered roots (``parent_id IS NULL``) from the DB."""
    return _select_existing_roots(db_path)


def normalize_download_variant(raw: Optional[Any]) -> str:
    """Return a safe ``download_variant`` string (T35)."""
    s = str(raw or "").strip()
    return s if s in _DOWNLOAD_VARIANTS else "full"


def normalize_theme(raw: Optional[Any]) -> str:
    s = str(raw or "").strip().lower()
    return s if s in _THEME_ALLOWED else "dark"


def _sanitize_download_basename_prefix(raw: Optional[Any]) -> str:
    s = str(raw or "").strip()[:64]
    out: List[str] = []
    for ch in s:
        if ch.isalnum() or ch in "-_.":
            out.append(ch)
    return "".join(out)[:64]


def _merge_filter_visibility(raw: Any) -> Dict[str, bool]:
    base = dict(_DEFAULT_CONFIG["filter_visibility"])
    if not isinstance(raw, dict):
        return base
    for k, default_v in base.items():
        if k in raw:
            base[k] = bool(raw[k])
    return base


def get_gallery_preferences(*, data_dir: _PathLike) -> Dict[str, Any]:
    """Subset of ``gallery_config.json`` exposed to the SPA (T36)."""
    cfg = _load_config(Path(data_dir))
    return {
        "download_variant": normalize_download_variant(cfg.get("download_variant")),
        "download_prompt_each_time": bool(cfg.get("download_prompt_each_time")),
        "download_basename_prefix": _sanitize_download_basename_prefix(
            cfg.get("download_basename_prefix"),
        ),
        "developer_mode": bool(cfg.get("developer_mode")),
        "theme": normalize_theme(cfg.get("theme")),
        "filter_visibility": _merge_filter_visibility(cfg.get("filter_visibility")),
    }


def patch_gallery_preferences(
    *, data_dir: _PathLike, body: Dict[str, Any],
) -> Dict[str, Any]:
    """Merge known preference keys and persist (T36). Unknown keys ignored."""
    cfg = _load_config(Path(data_dir))
    if not isinstance(body, dict):
        body = {}
    if "download_variant" in body:
        cfg["download_variant"] = normalize_download_variant(body.get("download_variant"))
    if "download_prompt_each_time" in body:
        cfg["download_prompt_each_time"] = bool(body.get("download_prompt_each_time"))
    if "download_basename_prefix" in body:
        cfg["download_basename_prefix"] = _sanitize_download_basename_prefix(
            body.get("download_basename_prefix"),
        )
    if "developer_mode" in body:
        cfg["developer_mode"] = bool(body.get("developer_mode"))
    if "theme" in body:
        cfg["theme"] = normalize_theme(body.get("theme"))
    if "filter_visibility" in body:
        merged = _merge_filter_visibility(cfg.get("filter_visibility"))
        sub = body.get("filter_visibility")
        if isinstance(sub, dict):
            for k in list(merged.keys()):
                if k in sub:
                    merged[k] = bool(sub[k])
        cfg["filter_visibility"] = merged
    _save_config(Path(data_dir), cfg)
    return get_gallery_preferences(data_dir=data_dir)


def remove_root_from_config(path: _PathLike, *, data_dir: _PathLike) -> None:
    """Remove ``path`` from ``gallery_config.json`` ``roots`` list (T33).

    Caller must already have removed / unindexed the DB side.
    """
    posix = _posix(path)
    cfg = _load_config(Path(data_dir))
    roots = cfg.get("roots", [])
    if not isinstance(roots, list):
        roots = []
    cfg["roots"] = [p for p in roots if _posix(str(p)) != posix]
    _save_config(Path(data_dir), cfg)
