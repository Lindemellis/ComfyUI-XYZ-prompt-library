"""HTTP routes for the XYZ Image Gallery (T02 placeholder + T10 read endpoints).

T18 adds ``GET /xyz/gallery/ws`` (WebSocket) — see ``gallery/ws_hub.py``.

T19 adds ``PATCH /xyz/gallery/image/{id}``, ``POST …/resync``, and a
``DELETE`` stub — see ``gallery/service.py``.

T21 adds ``GET /xyz/gallery/vocab/{tags,prompts,models}`` for autocomplete
and model vocab (``repo.vocab_lookup`` / ``list_models_for_vocab``).

T22 adds ``GET /xyz/gallery/index/status`` for focus reconciliation
(SPEC §7.8 / §7.9).

T23 adds ``POST /xyz/gallery/bulk/*`` (favorite / tags / ``resolve_selection``)
with the SPEC §6.2 ``Selection`` envelope (see ``repo.SelectionSpec``).

T24 adds ``POST /xyz/gallery/bulk/move/preflight|execute`` and
``POST /xyz/gallery/image/{id}/move`` — see ``gallery/service.py``.

T10 scope (TASKS.md T10):
  * SPA shell + static assets (``/xyz/gallery`` + ``/static/*``).
  * Read-only data endpoints backed by ``repo`` read APIs (T09):
      - ``GET /xyz/gallery/folders``
      - ``GET /xyz/gallery/images`` (+ cursor + filter + sort)
      - ``GET /xyz/gallery/images/count``
      - ``GET /xyz/gallery/image/{id}``
      - ``GET /xyz/gallery/image/{id}/neighbors``
  * Binary endpoints:
      - ``GET /xyz/gallery/thumb/{id}``   (delegates to ``thumbs.request``)
      - ``GET /xyz/gallery/raw/{id}`` + ``/raw/{id}/download``  (HTTP Range)
      - ``GET /xyz/gallery/image/{id}/workflow.json``
  * Unified error envelope per SPEC §7.10.

Boundary notes (ARCHITECTURE §2.1 / AI_RULES R5.5 / R7.1):
  * No direct SQL here — all reads go through ``repo``; the request
    handler wraps each call in ``loop.run_in_executor`` (SPEC C-2).
  * ``thumbs.request`` is the only generation entry-point (§4.4); this
    module never opens PIL or writes .webp bytes directly.
  * Workflow chunk extraction goes through ``metadata.read_workflow_chunk``
    — same reason (PIL / PNG-text knowledge stays in ``metadata``).
  * Sandbox (``paths.assert_inside_root``) guards the raw/workflow
    binary paths against DB-side drift.
"""

from __future__ import annotations

import asyncio
import errno
import json
import logging
import time
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from aiohttp import web

from . import DATA_DIR, DB_PATH, THUMBS_DIR
from . import vocab as _vocab
from . import folders as _folders
from . import indexer as _indexer
from . import metadata as _metadata
from . import paths as _paths
from . import repo as _repo
from . import service as _service
from . import thumbs as _thumbs
from . import ws_hub as _ws_hub

logger = logging.getLogger("xyz.gallery.routes")

_CLIENT_HDR = "X-XYZ-Gallery-Client-Id"


def _client_actor(request: web.Request) -> str:
    """Stable tab id from SPA header (T25 audit ``actor``)."""
    raw = request.headers.get(_CLIENT_HDR) or request.headers.get(
        "X-xyz-gallery-client-id",
    )
    if raw and str(raw).strip():
        return str(raw).strip()[:128]
    return "anonymous"


_SPA_DIR: Path = Path(__file__).resolve().parent.parent / "js" / "gallery_dist"
_PLACEHOLDER_HTML = (
    "<!doctype html><html><head><meta charset=\"utf-8\">"
    "<title>XYZ Gallery</title></head>"
    "<body>Hello Gallery</body></html>"
)
# SPEC §7.4 verbatim — the cache key already varies by mtime_ns via the
# ?v=... suffix on thumb_url, so "immutable" is honest here.
_THUMB_CACHE_HEADER = "public, max-age=31536000, immutable"

_TRUE_TOKENS = ("1", "true", "yes", "on")

_registered: bool = False


__all__ = ["register"]


# ---- response helpers ----------------------------------------------------

def _error(status: int, code: str, message: str,
           details: Optional[dict] = None) -> web.Response:
    env: dict = {"error": {"code": code, "message": message}}
    if details is not None:
        env["error"]["details"] = details
    return web.json_response(env, status=status)


def _iso(ts: Optional[int]) -> Optional[str]:
    if ts is None:
        return None
    dt = datetime.fromtimestamp(int(ts), tz=timezone.utc)
    return dt.isoformat().replace("+00:00", "Z")


def _parse_iso_date(text: Optional[str]) -> Optional[int]:
    # SPEC §6.2 FilterSpec date_* fields are ISO-date on the wire, but
    # repo.FilterSpec takes epoch seconds (image.created_at is int sec).
    # Bare dates (YYYY-MM-DD) are interpreted as midnight UTC — this is
    # the only sensible default with no user tz on the wire.
    if not text:
        return None
    t = text.strip()
    if not t:
        return None
    if len(t) == 10 and t.count("-") == 2:
        t = t + "T00:00:00+00:00"
    else:
        t = t.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(t)
    except ValueError as exc:
        raise ValueError(f"invalid ISO date {text!r}: {exc}") from exc
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return int(dt.timestamp())


def _is_true(query, key: str, default: bool = False) -> bool:
    raw = query.get(key)
    if raw is None:
        return default
    return raw.strip().lower() in _TRUE_TOKENS


def _metadata_positive_prompt_normalized(
    positive_prompt: Optional[str],
) -> Optional[str]:
    """§11 V1.1-F12 — same tokenisation as ``indexer``/``/images`` filter (T30/§8.8)."""
    if not positive_prompt or not str(positive_prompt).strip():
        return None
    toks = _vocab.normalize_prompt(
        str(positive_prompt), _prompt_extra_stopwords()
    )
    if not toks:
        return None
    return ", ".join(toks)


def _serialize_image(rec: _repo.ImageRecord) -> dict:
    v_suffix = f"?v={rec.mtime_ns}" if rec.mtime_ns is not None else ""
    return {
        "id": rec.id,
        "path": rec.path,
        "folder": {
            "id": rec.folder_id,
            "kind": rec.folder_kind,
            "display_name": rec.folder_display_name,
            "relative_dir": rec.relative_dir,
        },
        "filename": rec.filename,
        "ext": rec.ext,
        "media_kind": rec.media_kind,
        "size": {
            "width": rec.width,
            "height": rec.height,
            "bytes": rec.file_size,
        },
        # Video-only; null on an image. Kept as a sibling of ``size`` rather
        # than inside it because the detail pane shows duration on the same
        # line as the dimensions but everything else here is playback state.
        "video": {
            "duration_ms": rec.duration_ms,
            "fps": rec.fps,
            "has_audio": rec.has_audio,
            "vcodec": rec.vcodec,
        } if rec.media_kind == "video" else None,
        "created_at": _iso(rec.created_at),
        "metadata": {
            "positive_prompt": rec.positive_prompt,
            "positive_prompt_normalized": _metadata_positive_prompt_normalized(
                rec.positive_prompt
            ),
            "negative_prompt": rec.negative_prompt,
            "model": rec.model,
            "seed": rec.seed,
            "cfg": rec.cfg,
            "steps": rec.steps,
            "sampler": rec.sampler,
            "scheduler": rec.scheduler,
            "has_workflow": rec.has_workflow,
        },
        "gallery": {
            "favorite": rec.favorite,
            "tags": list(rec.tags),
            "sync_status": rec.sync_status,
            "version": rec.version,
        },
        "thumb_url": f"/xyz/gallery/thumb/{rec.id}{v_suffix}",
        "raw_url": f"/xyz/gallery/raw/{rec.id}",
    }


def _serialize_folder(node: _repo.FolderNode) -> dict:
    return {
        "id": node.id,
        "path": node.path,
        "kind": node.kind,
        "display_name": node.display_name,
        "parent_id": node.parent_id,
        "removable": node.removable,
        "children": [_serialize_folder(c) for c in node.children],
        "image_count_self": node.image_count_self,
        "image_count_recursive": node.image_count_recursive,
    }


def _prompt_extra_stopwords() -> frozenset:
    """Mirror ``indexer`` / ``gallery_config.json`` prompt_stopwords (T15)."""
    try:
        cfg = DATA_DIR / "gallery_config.json"
        if not cfg.is_file():
            return frozenset()
        blob = json.loads(cfg.read_text(encoding="utf-8"))
        arr = blob.get("prompt_stopwords", [])
        return frozenset(str(x).lower() for x in arr if x)
    except Exception:
        return frozenset()


def _f05_query_underscores(s: str) -> str:
    """§11 V1.1-F05 — query-side ``_`` → space before prompt normalisation."""
    return str(s).replace("_", " ")


def _parse_media_kind(raw: object) -> str:
    """Wire ``media_kind`` → FilterSpec value; default ``all`` (schema v8).

    The UI sends the collapsed three-state form, never two booleans: with two
    checkboxes, "both on" and "both off" have to mean the same thing, and
    deciding that in one place beats deciding it in the store, the query
    string and the SQL builder separately.
    """
    if raw in (None, ""):
        return "all"
    v = str(raw).strip().lower()
    if v not in ("all", "image", "video"):
        raise ValueError(f"invalid media_kind: {raw!r}")
    return v


def _parse_metadata_presence(raw: object) -> str:
    if raw in (None, ""):
        return "all"
    v = str(raw).strip().lower()
    if v not in ("all", "yes", "no"):
        raise ValueError(f"invalid metadata_presence: {raw!r}")
    return v


def _parse_prompt_match_mode(raw: object) -> str:
    if raw in (None, ""):
        return "prompt"
    v = str(raw).strip().lower()
    if v not in ("prompt", "word", "string"):
        raise ValueError(f"invalid prompt_match_mode: {raw!r}")
    return v


def _parse_filter(query) -> _repo.FilterSpec:
    fav = query.get("favorite", "all")
    if fav not in ("all", "yes", "no"):
        raise ValueError(f"invalid favorite: {fav!r}")
    fid_raw = query.get("folder_id")
    try:
        folder_id = int(fid_raw) if fid_raw not in (None, "") else None
    except ValueError as exc:
        raise ValueError(f"invalid folder_id: {fid_raw!r}") from exc
    meta = _parse_metadata_presence(query.get("metadata_presence"))
    pmm = _parse_prompt_match_mode(query.get("prompt_match_mode"))
    extra_sw = _prompt_extra_stopwords()
    tags_and_list: list[str] = []
    for t in query.getall("tag", []):
        nt = _vocab.normalize_tag(t)
        if nt:
            tags_and_list.append(nt)
    tags_and = tuple(dict.fromkeys(tags_and_list))

    prompts_and_list: list[str] = []
    words_and_list: list[str] = []
    substrings_list: list[str] = []
    if pmm == "word":
        wire_frags: list[str] = []
        for p in query.getall("prompt", []):
            s_raw = str(p).strip()
            if not s_raw:
                continue
            wire_frags.append(_f05_query_underscores(s_raw))
        blob = ",".join(wire_frags)
        words_and_list.extend(_vocab.split_positive_prompt_words(blob or None))
    else:
        for p in query.getall("prompt", []):
            s_raw = str(p).strip()
            if not s_raw:
                continue
            s = _f05_query_underscores(s_raw)
            if pmm == "string":
                seg = s.strip().lower()
                if seg:
                    substrings_list.append(seg)
            else:
                prompts_and_list.extend(_vocab.normalize_prompt(s, extra_sw))
    prompts_and = tuple(dict.fromkeys(prompts_and_list))
    words_and = tuple(dict.fromkeys(words_and_list))
    prompt_substrings = tuple(dict.fromkeys(substrings_list))

    return _repo.FilterSpec(
        name=(query.get("name") or None),
        favorite=fav,
        model=(query.get("model") or None),
        date_after=_parse_iso_date(query.get("date_after")),
        date_before=_parse_iso_date(query.get("date_before")),
        folder_id=folder_id,
        recursive=_is_true(query, "recursive", default=False),
        tags_and=tags_and,
        prompts_and=prompts_and,
        words_and=words_and,
        metadata_presence=meta,
        prompt_match_mode=pmm,
        prompt_substrings=prompt_substrings,
        media_kind=_parse_media_kind(query.get("media_kind")),
    )


def _parse_filter_mapping(obj: Any) -> _repo.FilterSpec:
    """JSON body ``filters`` object (``Selection`` in all_except) → ``FilterSpec``."""
    if not obj:
        return _repo.FilterSpec()
    if not isinstance(obj, dict):
        raise ValueError("filters must be a JSON object")
    fav = obj.get("favorite", "all")
    if fav not in ("all", "yes", "no"):
        raise ValueError("invalid favorite in filters")
    raw_name = obj.get("name", None)
    name_val: Optional[str] = None
    if raw_name is not None and str(raw_name).strip():
        name_val = str(raw_name)
    raw_model = obj.get("model", None)
    model_val: Optional[str] = None
    if raw_model is not None and str(raw_model).strip():
        model_val = str(raw_model)
    folder_id: Optional[int] = None
    if obj.get("folder_id") is not None and obj.get("folder_id") != "":
        try:
            folder_id = int(obj["folder_id"])
        except (TypeError, ValueError) as exc:
            raise ValueError("invalid folder_id in filters") from exc
    recursive = bool(obj.get("recursive", False))
    meta = _parse_metadata_presence(obj.get("metadata_presence"))
    pmm = _parse_prompt_match_mode(obj.get("prompt_match_mode"))
    extra_sw = _prompt_extra_stopwords()
    tags_and_list: list[str] = []
    for t in (obj.get("tag_tokens") or obj.get("tags") or ()):
        nt = _vocab.normalize_tag(str(t))
        if nt:
            tags_and_list.append(nt)
    tags_and = tuple(dict.fromkeys(tags_and_list))
    prompts_and_list: list[str] = []
    words_and_list: list[str] = []
    substrings_list: list[str] = []
    if pmm == "word":
        wire_frags = [
            _f05_query_underscores(str(p).strip())
            for p in (obj.get("positive_tokens") or ())
            if str(p).strip()
        ]
        blob = ",".join(wire_frags)
        words_and_list.extend(_vocab.split_positive_prompt_words(blob or None))
    else:
        for p in (obj.get("positive_tokens") or ()):
            s_raw = str(p).strip()
            if not s_raw:
                continue
            s = _f05_query_underscores(s_raw)
            if pmm == "string":
                seg = s.strip().lower()
                if seg:
                    substrings_list.append(seg)
            else:
                prompts_and_list.extend(_vocab.normalize_prompt(s, extra_sw))
    prompts_and = tuple(dict.fromkeys(prompts_and_list))
    words_and = tuple(dict.fromkeys(words_and_list))
    prompt_substrings = tuple(dict.fromkeys(substrings_list))
    return _repo.FilterSpec(
        name=name_val,
        favorite=fav,
        model=model_val,
        date_after=_parse_iso_date(obj.get("date_after") or None),
        date_before=_parse_iso_date(obj.get("date_before") or None),
        folder_id=folder_id,
        recursive=recursive,
        tags_and=tags_and,
        prompts_and=prompts_and,
        words_and=words_and,
        metadata_presence=meta,
        prompt_match_mode=pmm,
        prompt_substrings=prompt_substrings,
        media_kind=_parse_media_kind(obj.get("media_kind")),
    )


def _parse_selection(obj: Any) -> _repo.SelectionSpec:
    if not isinstance(obj, dict):
        raise ValueError("selection must be a JSON object")
    mode = obj.get("mode")
    if mode == "explicit":
        raw = obj.get("ids")
        if not isinstance(raw, list) or not raw:
            raise ValueError("selection.ids must be a non-empty array")
        ids: list[int] = []
        for x in raw:
            try:
                i = int(x)
            except (TypeError, ValueError) as exc:
                raise ValueError("selection.ids must contain integers") from exc
            if i < 1:
                raise ValueError("invalid image id in selection.ids")
            ids.append(i)
        return _repo.SelectionSpec(mode="explicit", explicit_ids=tuple(dict.fromkeys(ids)))
    if mode == "all_except":
        flt = _parse_filter_mapping(obj.get("filters"))
        raw_ex = obj.get("excluded_ids", [])
        if not isinstance(raw_ex, list):
            raise ValueError("excluded_ids must be an array")
        ex_ids: list[int] = []
        for x in raw_ex:
            try:
                eid = int(x)
            except (TypeError, ValueError) as exc:
                raise ValueError("excluded_ids must contain integers") from exc
            if eid < 1:
                raise ValueError("invalid id in excluded_ids")
            ex_ids.append(eid)
        return _repo.SelectionSpec(
            mode="all_except",
            filter=flt,
            excluded_ids=tuple(dict.fromkeys(ex_ids)),
        )
    raise ValueError("selection.mode must be 'explicit' or 'all_except'")


def _parse_sort(query) -> _repo.SortSpec:
    # repo.SortSpec validates key/dir in __post_init__; we bubble the
    # ValueError up to the 400 branch of the caller.
    return _repo.SortSpec(
        key=query.get("sort", "time"),
        dir=query.get("dir", "desc"),
    )


def _parse_limit(query) -> int:
    raw = query.get("limit")
    if raw in (None, ""):
        return _repo.DEFAULT_PAGE_SIZE
    try:
        v = int(raw)
    except ValueError as exc:
        raise ValueError(f"invalid limit: {raw!r}") from exc
    return max(1, min(v, _repo.MAX_PAGE_SIZE))


async def _run(fn, *args, **kwargs):
    # C-2: non-trivial reads / disk work must not block the event loop.
    # repo's read APIs are sync and open a short-lived connection each.
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, lambda: fn(*args, **kwargs))


def _current_write_queue():
    # Resolved at call-time — gallery._write_queue is None until
    # start_background_services() runs (PROJECT_STATE §5 C-T04); a
    # module-top `from . import _write_queue` would capture that None
    # permanently.
    from . import _write_queue as wq
    return wq


def _content_disposition_attachment(filename: str, fallback_id: int) -> str:
    # RFC 5987 / 6266: both old-browser (ASCII filename=) and modern
    # filename*= (UTF-8 percent-encoded) forms. Non-ASCII filenames are
    # common in Chinese locales (C-5 folder content) so we must not ship
    # a raw high-byte filename= header.
    ascii_name = filename.encode("ascii", "ignore").decode("ascii") or (
        f"image_{fallback_id}"
    )
    ascii_name = ascii_name.replace('"', "").replace("\\", "")
    quoted = urllib.parse.quote(filename, safe="")
    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quoted}'


# ---- handlers -------------------------------------------------------------

async def _serve_spa(_request: web.Request) -> web.Response:
    # T10 allows a placeholder body until T11 ships gallery_dist/. If
    # T11 has landed we serve the real shell from disk.
    index = _SPA_DIR / "index.html"
    if index.is_file():
        return web.FileResponse(str(index))
    return web.Response(text=_PLACEHOLDER_HTML, content_type="text/html")


async def _serve_static(request: web.Request) -> web.Response:
    tail = request.match_info.get("tail", "")
    if not tail:
        return _error(404, "not_found", "empty static path")
    spa_root = _SPA_DIR.resolve(strict=False)
    candidate = (_SPA_DIR / tail).resolve(strict=False)
    try:
        candidate.relative_to(spa_root)
    except ValueError:
        return _error(400, "bad_path", "traversal rejected")
    if not candidate.is_file():
        return _error(404, "not_found", f"static file not found: {tail}")
    return web.FileResponse(str(candidate))


async def _get_folders(request: web.Request) -> web.Response:
    include_counts = _is_true(request.query, "include_counts", default=False)
    try:
        tree = await _run(
            _repo.folder_tree,
            db_path=DB_PATH, include_counts=include_counts,
        )
    except Exception as exc:
        logger.exception("folder_tree failed")
        return _error(500, "internal", str(exc))
    return web.json_response([_serialize_folder(n) for n in tree])


async def _post_folders(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        return _error(400, "invalid_body", f"invalid JSON: {exc}")
    if not isinstance(body, dict):
        return _error(400, "invalid_body", "body must be a JSON object")
    raw = body.get("path", None)
    if not isinstance(raw, str) or not raw.strip():
        return _error(400, "invalid_body", "path must be a non-empty string")
    try:
        out = await _run(
            _service.folder_register_custom_root,
            raw.strip(), db_path=DB_PATH, data_dir=DATA_DIR,
        )
    except FileNotFoundError as exc:
        return _error(404, "not_found", str(exc))
    except PermissionError as exc:
        return _error(403, "sandbox", str(exc))
    except _folders.RootConflictError as exc:
        return _error(409, "invalid_body", str(exc))
    except RuntimeError as exc:
        msg = str(exc)
        if "WriteQueue is not started" in msg or "not started" in msg:
            return _error(503, "not_ready", msg)
        logger.exception("folder_register_custom_root failed")
        return _error(500, "internal", msg)
    except Exception as exc:
        logger.exception("folder_register_custom_root failed")
        return _error(500, "internal", str(exc))
    return web.json_response(out, status=201)


async def _get_folder_delete_preview(request: web.Request) -> web.Response:
    folder_id = int(request.match_info["id"])
    try:
        out = await _run(
            _service.folder_delete_preview, folder_id, db_path=DB_PATH,
        )
    except KeyError as exc:
        return _error(404, "not_found", str(exc))
    except PermissionError as exc:
        return _error(403, "forbidden", str(exc))
    except _paths.SandboxError as exc:
        return _error(403, "sandbox", str(exc))
    except RuntimeError as exc:
        msg = str(exc)
        if "WriteQueue is not started" in msg or "not started" in msg:
            return _error(503, "not_ready", msg)
        logger.exception("folder_delete_preview failed")
        return _error(500, "internal", msg)
    except Exception as exc:
        logger.exception("folder_delete_preview failed")
        return _error(500, "internal", str(exc))
    return web.json_response(out)


async def _delete_folder(request: web.Request) -> web.Response:
    folder_id = int(request.match_info["id"])
    purge_raw = (request.rel_url.query.get("purge_files") or "").lower()
    purge = purge_raw in ("1", "true", "yes")
    try:
        row = await _run(
            _repo.fetch_folder_row, db_path=DB_PATH, folder_id=folder_id,
        )
    except Exception as exc:
        logger.exception("fetch_folder_row failed")
        return _error(500, "internal", str(exc))
    if row is None:
        return _error(404, "not_found", f"folder {folder_id} not found")
    try:
        if row["parent_id"] is None:
            if purge:
                return _error(400, "invalid_body", "cannot purge-delete a root folder")
            if int(row["removable"]) != 1:
                return _error(403, "forbidden", "cannot remove built-in root")
            await _run(
                _service.folder_unregister_custom_root,
                folder_id, db_path=DB_PATH, data_dir=DATA_DIR,
            )
        else:
            if purge:
                out = await _run(
                    _service.folder_delete_purge, folder_id, db_path=DB_PATH,
                )
                return web.json_response(out, status=200)
            await _run(
                _service.folder_delete_empty, folder_id, db_path=DB_PATH,
            )
    except KeyError as exc:
        return _error(404, "not_found", str(exc))
    except PermissionError as exc:
        return _error(403, "forbidden", str(exc))
    except FileNotFoundError as exc:
        return _error(404, "not_found", str(exc))
    except OSError as exc:
        if getattr(exc, "errno", None) == errno.ENOTEMPTY:
            return _error(409, "not_empty", str(exc))
        logger.exception("folder delete failed")
        return _error(500, "internal", str(exc))
    except RuntimeError as exc:
        msg = str(exc)
        if "WriteQueue is not started" in msg or "not started" in msg:
            return _error(503, "not_ready", msg)
        logger.exception("folder delete failed")
        return _error(500, "internal", msg)
    except Exception as exc:
        logger.exception("folder delete failed")
        return _error(500, "internal", str(exc))
    return web.Response(status=204)


async def _post_folder_rescan(request: web.Request) -> web.Response:
    folder_id = int(request.match_info["id"])
    try:
        await _run(_service.folder_schedule_rescan, folder_id, db_path=DB_PATH)
    except KeyError as exc:
        return _error(404, "not_found", str(exc))
    except Exception as exc:
        logger.exception("folder rescan schedule failed")
        return _error(500, "internal", str(exc))
    return web.json_response({"scheduled": True})


async def _post_folder_mkdir(request: web.Request) -> web.Response:
    folder_id = int(request.match_info["id"])
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        return _error(400, "invalid_body", f"invalid JSON: {exc}")
    if not isinstance(body, dict):
        return _error(400, "invalid_body", "body must be a JSON object")
    name = body.get("name", None)
    if not isinstance(name, str) or not name.strip():
        return _error(400, "invalid_body", "name must be a non-empty string")
    try:
        out = await _run(
            _service.folder_mkdir, folder_id, name.strip(), db_path=DB_PATH,
        )
    except KeyError as exc:
        return _error(404, "not_found", str(exc))
    except ValueError as exc:
        return _error(400, "invalid_body", str(exc))
    except FileExistsError as exc:
        return _error(409, "conflict", str(exc))
    except _paths.SandboxError as exc:
        return _error(403, "sandbox", str(exc))
    except RuntimeError as exc:
        msg = str(exc)
        if "WriteQueue is not started" in msg or "not started" in msg:
            return _error(503, "not_ready", msg)
        logger.exception("folder_mkdir failed")
        return _error(500, "internal", msg)
    except Exception as exc:
        logger.exception("folder_mkdir failed")
        return _error(500, "internal", str(exc))
    return web.json_response(out, status=201)


async def _patch_folder(request: web.Request) -> web.Response:
    folder_id = int(request.match_info["id"])
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        return _error(400, "invalid_body", f"invalid JSON: {exc}")
    if not isinstance(body, dict):
        return _error(400, "invalid_body", "body must be a JSON object")
    name = body.get("name", None)
    if not isinstance(name, str) or not name.strip():
        return _error(400, "invalid_body", "name must be a non-empty string")
    try:
        await _run(
            _service.folder_rename, folder_id, name.strip(), db_path=DB_PATH,
        )
    except KeyError as exc:
        return _error(404, "not_found", str(exc))
    except ValueError as exc:
        return _error(400, "invalid_body", str(exc))
    except PermissionError as exc:
        return _error(403, "forbidden", str(exc))
    except FileExistsError as exc:
        return _error(409, "conflict", str(exc))
    except _paths.SandboxError as exc:
        return _error(403, "sandbox", str(exc))
    except RuntimeError as exc:
        msg = str(exc)
        if "WriteQueue is not started" in msg or "not started" in msg:
            return _error(503, "not_ready", msg)
        logger.exception("folder_rename failed")
        return _error(500, "internal", msg)
    except Exception as exc:
        logger.exception("folder_rename failed")
        return _error(500, "internal", str(exc))
    return web.json_response({"ok": True})


async def _post_folder_move(request: web.Request) -> web.Response:
    folder_id = int(request.match_info["id"])
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        return _error(400, "invalid_body", f"invalid JSON: {exc}")
    if not isinstance(body, dict):
        return _error(400, "invalid_body", "body must be a JSON object")
    pid = body.get("parent_id", None)
    if isinstance(pid, bool):
        return _error(400, "invalid_body", "parent_id must be an int")
    try:
        pid_i = int(pid)
    except (TypeError, ValueError):
        return _error(400, "invalid_body", "parent_id must be an int")
    try:
        await _run(
            _service.folder_move, folder_id, pid_i, db_path=DB_PATH,
        )
    except KeyError as exc:
        return _error(404, "not_found", str(exc))
    except ValueError as exc:
        return _error(400, "invalid_body", str(exc))
    except PermissionError as exc:
        return _error(403, "forbidden", str(exc))
    except FileExistsError as exc:
        return _error(409, "conflict", str(exc))
    except _paths.SandboxError as exc:
        return _error(403, "sandbox", str(exc))
    except RuntimeError as exc:
        msg = str(exc)
        if "WriteQueue is not started" in msg or "not started" in msg:
            return _error(503, "not_ready", msg)
        logger.exception("folder_move failed")
        return _error(500, "internal", msg)
    except Exception as exc:
        logger.exception("folder_move failed")
        return _error(500, "internal", str(exc))
    return web.json_response({"ok": True})


async def _post_folder_open(request: web.Request) -> web.Response:
    folder_id = int(request.match_info["id"])
    try:
        await _run(_service.folder_open_in_os, folder_id, db_path=DB_PATH)
    except KeyError as exc:
        return _error(404, "not_found", str(exc))
    except _paths.SandboxError as exc:
        return _error(403, "sandbox", str(exc))
    except RuntimeError as exc:
        return _error(500, "internal", str(exc))
    except Exception as exc:
        logger.exception("folder_open_in_os failed")
        return _error(500, "internal", str(exc))
    return web.json_response({"ok": True})


async def _list_images(request: web.Request) -> web.Response:
    try:
        flt = _parse_filter(request.query)
        srt = _parse_sort(request.query)
        limit = _parse_limit(request.query)
    except ValueError as exc:
        return _error(400, "invalid_query", str(exc))
    cursor = request.query.get("cursor") or None
    try:
        page = await _run(
            _repo.list_images,
            db_path=DB_PATH, filter=flt, sort=srt,
            cursor=cursor, limit=limit,
        )
    except ValueError as exc:
        return _error(400, "invalid_cursor", str(exc))
    except Exception as exc:
        logger.exception("list_images failed")
        return _error(500, "internal", str(exc))
    return web.json_response({
        "items": [_serialize_image(r) for r in page.items],
        "next_cursor": page.next_cursor,
        "total_estimate": page.total,
        "total_approximate": page.total_approximate,
    })


async def _images_count(request: web.Request) -> web.Response:
    try:
        flt = _parse_filter(request.query)
    except ValueError as exc:
        return _error(400, "invalid_query", str(exc))
    try:
        # Reuse list_images' bounded count path rather than adding a
        # second codepath — limit=1 keeps the row materialisation tiny
        # and the total / total_approximate fields are the whole point.
        page = await _run(
            _repo.list_images,
            db_path=DB_PATH, filter=flt, limit=1,
        )
    except Exception as exc:
        logger.exception("images_count failed")
        return _error(500, "internal", str(exc))
    return web.json_response(
        {"total": page.total, "approximate": page.total_approximate}
    )


def _read_index_status() -> dict:
    page = _repo.list_images(
        db_path=DB_PATH,
        filter=_repo.FilterSpec(),
        sort=_repo.SortSpec(),
        cursor=None,
        limit=1,
    )
    return {
        "scanning": _indexer.is_cold_scanning(),
        "pending_events": 0,
        "last_full_scan_at": None,
        "totals": {
            "images": page.total,
            "approximate": page.total_approximate,
        },
        "last_event_ts": _ws_hub.get_last_event_ts(),
    }


def _read_jobs_active() -> dict:
    from . import job_registry as _jr
    return {"jobs": _jr.list_active()}


async def _get_jobs_active(_request: web.Request) -> web.Response:
    try:
        return web.json_response(await _run(_read_jobs_active))
    except Exception as exc:
        logger.exception("jobs/active failed")
        return _error(500, "internal", str(exc))


async def _get_index_status(request: web.Request) -> web.Response:
    try:
        return web.json_response(await _run(_read_index_status))
    except Exception as exc:
        logger.exception("index_status failed")
        return _error(500, "internal", str(exc))


def _parse_vocab_limit(query) -> int:
    raw = query.get("limit")
    if raw in (None, ""):
        return _repo.VOCAB_LOOKUP_DEFAULT_LIMIT
    try:
        v = int(raw)
    except ValueError as exc:
        raise ValueError(f"invalid limit: {raw!r}") from exc
    return max(1, min(v, _repo.VOCAB_LOOKUP_MAX_LIMIT))


def _parse_vocab_match_mode(query) -> str:
    """Autocomplete SQL mode: ``prefix`` (default) or ``contains`` (substring)."""
    raw = (query.get("match") or "prefix").strip().lower()
    if raw in ("prefix", "contains"):
        return raw
    raise ValueError(f"invalid match: {query.get('match')!r}")


_DOWNLOAD_VARIANTS = frozenset({"full", "no_workflow", "clean"})


def _effective_download_variant(request: web.Request) -> str:
    raw = request.query.get("variant")
    if raw is not None and str(raw).strip() != "":
        v = str(raw).strip()
        if v not in _DOWNLOAD_VARIANTS:
            raise ValueError(f"invalid variant: {raw!r}")
        return v
    prefs = _folders.get_gallery_preferences(data_dir=DATA_DIR)
    return str(prefs.get("download_variant") or "full")


async def _get_vocab_tags(request: web.Request) -> web.Response:
    try:
        limit = _parse_vocab_limit(request.query)
        match_mode = _parse_vocab_match_mode(request.query)
    except ValueError as exc:
        return _error(400, "invalid_query", str(exc))
    prefix = request.query.get("prefix", "")
    try:
        rows = await _run(
            _repo.vocab_lookup,
            db_path=DB_PATH, kind="tags", prefix=prefix, limit=limit,
            match_mode=match_mode,
        )
    except ValueError as exc:
        return _error(400, "invalid_query", str(exc))
    except Exception as exc:
        logger.exception("vocab_lookup tags failed")
        return _error(500, "internal", str(exc))
    return web.json_response(list(rows))


async def _get_vocab_prompts(request: web.Request) -> web.Response:
    try:
        limit = _parse_vocab_limit(request.query)
        match_mode = _parse_vocab_match_mode(request.query)
    except ValueError as exc:
        return _error(400, "invalid_query", str(exc))
    prefix = request.query.get("prefix", "")
    try:
        rows = await _run(
            _repo.vocab_lookup,
            db_path=DB_PATH, kind="prompts", prefix=prefix, limit=limit,
            match_mode=match_mode,
        )
    except ValueError as exc:
        return _error(400, "invalid_query", str(exc))
    except Exception as exc:
        logger.exception("vocab_lookup prompts failed")
        return _error(500, "internal", str(exc))
    return web.json_response(list(rows))


async def _get_vocab_words(request: web.Request) -> web.Response:
    """§11 F04 *word* mode autocomplete — ``word_token`` lexemes."""
    try:
        limit = _parse_vocab_limit(request.query)
        match_mode = _parse_vocab_match_mode(request.query)
    except ValueError as exc:
        return _error(400, "invalid_query", str(exc))
    prefix = request.query.get("prefix", "")
    try:
        rows = await _run(
            _repo.vocab_lookup,
            db_path=DB_PATH, kind="words", prefix=prefix, limit=limit,
            match_mode=match_mode,
        )
    except ValueError as exc:
        return _error(400, "invalid_query", str(exc))
    except Exception as exc:
        logger.exception("vocab_lookup words failed")
        return _error(500, "internal", str(exc))
    return web.json_response(list(rows))


async def _get_vocab_models(request: web.Request) -> web.Response:
    try:
        models = await _run(_repo.list_models_for_vocab, db_path=DB_PATH)
    except Exception as exc:
        logger.exception("list_models_for_vocab failed")
        return _error(500, "internal", str(exc))
    return web.json_response(list(models))


async def _get_image(request: web.Request) -> web.Response:
    image_id = int(request.match_info["id"])
    try:
        rec = await _run(_repo.get_image, image_id, db_path=DB_PATH)
    except Exception as exc:
        logger.exception("get_image failed")
        return _error(500, "internal", str(exc))
    if rec is None:
        return _error(404, "not_found", f"image {image_id} not found")
    return web.json_response(_serialize_image(rec))


async def _image_neighbors(request: web.Request) -> web.Response:
    image_id = int(request.match_info["id"])
    try:
        flt = _parse_filter(request.query)
        srt = _parse_sort(request.query)
    except ValueError as exc:
        return _error(400, "invalid_query", str(exc))
    try:
        nb = await _run(
            _repo.neighbors, image_id,
            db_path=DB_PATH, filter=flt, sort=srt,
        )
    except Exception as exc:
        logger.exception("neighbors failed")
        return _error(500, "internal", str(exc))
    return web.json_response({"prev_id": nb.prev_id, "next_id": nb.next_id})


async def _get_thumb(request: web.Request) -> web.StreamResponse:
    image_id = int(request.match_info["id"])
    wq = _current_write_queue()
    if wq is None:
        return _error(503, "not_ready", "gallery write queue not started")
    try:
        path = await _run(
            _thumbs.request, image_id,
            db_path=DB_PATH, thumbs_dir=THUMBS_DIR, write_queue=wq,
        )
    except Exception as exc:
        logger.exception("thumb request failed")
        return _error(500, "internal", str(exc))
    if path is None or not Path(path).is_file():
        return _error(404, "not_found",
                      f"thumbnail unavailable for image {image_id}")
    return web.FileResponse(
        str(path),
        headers={"Cache-Control": _THUMB_CACHE_HEADER},
    )


async def _serve_raw(request: web.Request, *, as_attachment: bool
                     ) -> web.StreamResponse:
    image_id = int(request.match_info["id"])
    try:
        rec = await _run(_repo.get_image, image_id, db_path=DB_PATH)
    except Exception as exc:
        logger.exception("get_image for raw failed")
        return _error(500, "internal", str(exc))
    if rec is None:
        return _error(404, "not_found", f"image {image_id} not found")
    try:
        roots = await _run(_folders.list_roots, db_path=DB_PATH)
        root_paths = [r["path"] for r in roots]
        await _run(_paths.assert_inside_root, rec.path, root_paths)
    except _paths.SandboxError as exc:
        return _error(403, "sandbox", str(exc))
    disk_path = Path(rec.path)
    if not disk_path.is_file():
        return _error(404, "not_found",
                      f"file missing on disk: image {image_id}")
    headers: dict = {}
    if as_attachment:
        headers["Content-Disposition"] = _content_disposition_attachment(
            rec.filename, image_id,
        )
    else:
        headers["Content-Disposition"] = "inline"
    # aiohttp's FileResponse handles HTTP Range natively (200 / 206 +
    # Content-Range + byte slicing) — TASKS T10 test #2.
    return web.FileResponse(str(disk_path), headers=headers)


async def _get_raw_inline(request: web.Request) -> web.StreamResponse:
    return await _serve_raw(request, as_attachment=False)


async def _get_raw_download(request: web.Request) -> web.StreamResponse:
    """``GET …/raw/{id}/download`` — optional ``?variant=full|no_workflow|clean`` (T35)."""
    try:
        variant = _effective_download_variant(request)
    except ValueError as exc:
        return _error(400, "invalid_query", str(exc))
    if variant == "full":
        return await _serve_raw(request, as_attachment=True)
    image_id = int(request.match_info["id"])
    try:
        rec = await _run(_repo.get_image, image_id, db_path=DB_PATH)
    except Exception as exc:
        logger.exception("get_image for raw download failed")
        return _error(500, "internal", str(exc))
    if rec is None:
        return _error(404, "not_found", f"image {image_id} not found")
    try:
        roots = await _run(_folders.list_roots, db_path=DB_PATH)
        root_paths = [r["path"] for r in roots]
        await _run(_paths.assert_inside_root, rec.path, root_paths)
    except _paths.SandboxError as exc:
        return _error(403, "sandbox", str(exc))
    disk_path = Path(rec.path)
    if not disk_path.is_file():
        return _error(404, "not_found",
                      f"file missing on disk: image {image_id}")
    if disk_path.suffix.lower() != ".png":
        return _error(
            400,
            "invalid_query",
            "stripping workflow or generation data applies to PNG files only",
        )
    try:
        body = await _run(_metadata.build_png_download_bytes, disk_path, variant)
    except FileNotFoundError:
        return _error(404, "not_found", f"file missing on disk: image {image_id}")
    except ValueError as exc:
        return _error(400, "invalid_query", str(exc))
    except Exception as exc:
        logger.exception("build_png_download_bytes failed")
        return _error(500, "internal", str(exc))
    headers = {
        "Content-Disposition": _content_disposition_attachment(
            rec.filename, image_id,
        ),
        "Content-Type": "image/png",
    }
    return web.Response(body=body, headers=headers)


async def _get_gallery_preferences(_request: web.Request) -> web.Response:
    try:
        out = await _run(_folders.get_gallery_preferences, data_dir=DATA_DIR)
    except Exception as exc:
        logger.exception("get_gallery_preferences failed")
        return _error(500, "internal", str(exc))
    return web.json_response(out)


async def _patch_gallery_preferences(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        return _error(400, "invalid_body", f"invalid JSON: {exc}")
    if not isinstance(body, dict):
        return _error(400, "invalid_body", "body must be a JSON object")
    try:
        out = await _run(_folders.patch_gallery_preferences, data_dir=DATA_DIR, body=body)
    except Exception as exc:
        logger.exception("patch_gallery_preferences failed")
        return _error(500, "internal", str(exc))
    return web.json_response(out)


async def _get_admin_tags(request: web.Request) -> web.Response:
    q = request.query.get("q", "")
    lim_raw = request.query.get("limit", "10")
    off_raw = request.query.get("offset", "0")
    sort_key = (request.query.get("sort") or "usage").strip().lower()
    sort_dir = (request.query.get("dir") or "desc").strip().lower()
    if sort_key not in ("name", "usage"):
        return _error(400, "invalid_query", "sort must be name or usage")
    if sort_dir not in ("asc", "desc"):
        return _error(400, "invalid_query", "dir must be asc or desc")
    try:
        limit = int(lim_raw)
    except ValueError:
        return _error(400, "invalid_query", "limit must be an integer")
    try:
        offset = int(off_raw)
    except ValueError:
        return _error(400, "invalid_query", "offset must be an integer")
    try:
        body = await _run(
            _service.tag_admin_list,
            db_path=DB_PATH,
            query=str(q),
            limit=limit,
            offset=offset,
            sort_key=sort_key,
            sort_dir=sort_dir,
        )
    except Exception as exc:
        logger.exception("tag_admin_list failed")
        return _error(500, "internal", str(exc))
    return web.json_response(body)


async def _post_admin_tags_delete(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        return _error(400, "invalid_body", f"invalid JSON: {exc}")
    if not isinstance(body, dict):
        return _error(400, "invalid_body", "body must be a JSON object")
    raw = body.get("name", None)
    if not isinstance(raw, str) or not raw.strip():
        return _error(400, "invalid_body", "name must be a non-empty string")
    try:
        out = await _run(
            _service.tag_admin_delete, name=raw.strip(), db_path=DB_PATH,
        )
    except KeyError as exc:
        return _error(404, "not_found", str(exc))
    except ValueError as exc:
        return _error(400, "invalid_body", str(exc))
    except RuntimeError as exc:
        msg = str(exc)
        if "WriteQueue is not started" in msg or "not started" in msg:
            return _error(503, "not_ready", msg)
        logger.exception("tag_admin_delete failed")
        return _error(500, "internal", msg)
    except Exception as exc:
        logger.exception("tag_admin_delete failed")
        return _error(500, "internal", str(exc))
    return web.json_response(out)


async def _post_admin_tags_purge_zero(request: web.Request) -> web.Response:
    try:
        await request.json()
    except json.JSONDecodeError:
        pass
    try:
        out = await _run(_service.tag_admin_purge_zero, db_path=DB_PATH)
    except RuntimeError as exc:
        msg = str(exc)
        if "WriteQueue is not started" in msg or "not started" in msg:
            return _error(503, "not_ready", msg)
        logger.exception("tag_admin_purge_zero failed")
        return _error(500, "internal", msg)
    except Exception as exc:
        logger.exception("tag_admin_purge_zero failed")
        return _error(500, "internal", str(exc))
    return web.json_response(out)


async def _post_admin_tags_rename(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        return _error(400, "invalid_body", f"invalid JSON: {exc}")
    if not isinstance(body, dict):
        return _error(400, "invalid_body", "body must be a JSON object")
    old_n = body.get("old_name")
    new_n = body.get("new_name")
    if not isinstance(old_n, str) or not old_n.strip():
        return _error(400, "invalid_body", "old_name must be a non-empty string")
    if not isinstance(new_n, str) or not new_n.strip():
        return _error(400, "invalid_body", "new_name must be a non-empty string")
    try:
        out = await _run(
            _service.tag_admin_rename,
            old_name=old_n.strip(),
            new_name=new_n.strip(),
            db_path=DB_PATH,
        )
    except KeyError as exc:
        return _error(404, "not_found", str(exc))
    except ValueError as exc:
        return _error(400, "invalid_body", str(exc))
    except RuntimeError as exc:
        msg = str(exc)
        if "WriteQueue is not started" in msg or "not started" in msg:
            return _error(503, "not_ready", msg)
        logger.exception("tag_admin_rename failed")
        return _error(500, "internal", msg)
    except Exception as exc:
        logger.exception("tag_admin_rename failed")
        return _error(500, "internal", str(exc))
    return web.json_response(out)


def _ws_pong_envelope() -> str:
    # Same shape as SPEC §7.9 (type / data / ts) — application-level ping.
    return json.dumps(
        {"type": "pong", "data": {}, "ts": int(time.time() * 1000)},
        separators=(",", ":"),
    )


async def _ws_handler(request: web.Request) -> web.WebSocketResponse:
    """SPEC §7.9 — server → client push; client may send text ``ping``."""
    from . import ws_hub as _ws_hub

    ws = web.WebSocketResponse()
    await ws.prepare(request)
    await _ws_hub.add_client(ws)
    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                raw = msg.data.strip()
                if raw.lower() == "ping":
                    await ws.send_str(_ws_pong_envelope())
                    continue
                if raw.startswith("{"):
                    try:
                        obj = json.loads(msg.data)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(obj, dict) and obj.get("type") == "ping":
                        await ws.send_str(_ws_pong_envelope())
            elif msg.type in (
                web.WSMsgType.CLOSE,
                web.WSMsgType.CLOSING,
                web.WSMsgType.ERROR,
            ):
                break
    finally:
        await _ws_hub.remove_client(ws)
    return ws


async def _get_workflow(request: web.Request) -> web.Response:
    image_id = int(request.match_info["id"])
    try:
        rec = await _run(_repo.get_image, image_id, db_path=DB_PATH)
    except Exception as exc:
        logger.exception("get_image for workflow failed")
        return _error(500, "internal", str(exc))
    if rec is None:
        return _error(404, "not_found", f"image {image_id} not found")
    if not rec.has_workflow:
        # §4 #23: workflow_present=0 → 404 even if the PNG is sitting
        # right there. The detail UI disables the button in that case.
        return _error(404, "no_workflow",
                      f"image {image_id} has no workflow")
    try:
        roots = await _run(_folders.list_roots, db_path=DB_PATH)
        root_paths = [r["path"] for r in roots]
        await _run(_paths.assert_inside_root, rec.path, root_paths)
    except _paths.SandboxError as exc:
        return _error(403, "sandbox", str(exc))
    try:
        text = await _run(_metadata.read_workflow_chunk, rec.path)
    except Exception as exc:
        logger.exception("workflow extraction failed")
        return _error(500, "internal", str(exc))
    if not text:
        return _error(404, "no_workflow",
                      f"workflow chunk absent for {image_id}")
    return web.Response(
        text=text, content_type="application/json",
        headers={
            "Content-Disposition": _content_disposition_attachment(
                f"workflow_{image_id}.json", image_id,
            )
        },
    )


async def _patch_image(request: web.Request) -> web.Response:
    image_id = int(request.match_info["id"])
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        return _error(400, "invalid_body", f"invalid JSON: {exc}")
    try:
        rec = await _run(
            _service.update_image, image_id, body, db_path=DB_PATH,
        )
    except KeyError as exc:
        return _error(404, "not_found", str(exc))
    except ValueError as exc:
        return _error(400, "invalid_body", str(exc))
    except _paths.SandboxError as exc:
        return _error(403, "sandbox", str(exc))
    except RuntimeError as exc:
        msg = str(exc)
        if "WriteQueue is not started" in msg or "not started" in msg:
            return _error(503, "not_ready", msg)
        logger.exception("update_image failed")
        return _error(500, "internal", msg)
    except Exception as exc:
        logger.exception("update_image failed")
        return _error(500, "internal", str(exc))
    return web.json_response(_serialize_image(rec))


async def _post_send_to_krita(request: web.Request) -> web.Response:
    """``POST /xyz/gallery/images/send_to_krita`` — {ids, mode, fit}.

    Synchronous on purpose: Krita may have to be started first (~20s), and the caller
    wants to know which images actually landed. It runs off the event loop like every
    other blocking call here.
    """
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        return _error(400, "invalid_body", f"invalid JSON: {exc}")
    if not isinstance(body, dict):
        return _error(400, "invalid_body", "body must be a JSON object")

    raw_ids = body.get("ids")
    if not isinstance(raw_ids, list) or not raw_ids:
        return _error(400, "invalid_body", "ids must be a non-empty array")
    try:
        ids = [int(x) for x in raw_ids]
    except (TypeError, ValueError):
        return _error(400, "invalid_body", "ids must be integers")

    mode = str(body.get("mode") or "new_layer")
    if mode not in ("new_layer", "new_document"):
        return _error(400, "invalid_body", "mode must be new_layer or new_document")
    fit = str(body.get("fit") or "fit")
    if fit not in ("keep", "fit", "grow_canvas"):
        return _error(400, "invalid_body", "fit must be keep, fit or grow_canvas")

    try:
        out = await _run(
            _service.send_images_to_krita,
            ids, mode=mode, fit=fit, db_path=DB_PATH,
        )
    except Exception as exc:
        logger.exception("send_images_to_krita failed")
        return _error(500, "internal", str(exc))
    return web.json_response(out)


async def _post_backfill_steps(request: web.Request) -> web.Response:
    """Queue a metadata re-read for every image with no step count.

    Returns immediately with the counts; the sync worker does the reading on its own
    poll, so a big library does not hold the request open.
    """
    try:
        out = await _run(_service.backfill_missing_steps, db_path=DB_PATH)
    except Exception:
        logger.exception("backfill_missing_steps failed")
        return web.json_response({"error": "backfill failed"}, status=500)
    return web.json_response(out)


async def _get_backfill_steps(request: web.Request) -> web.Response:
    """How many images still have no step count — what the button's label says."""
    try:
        missing = await _run(_repo.count_missing_steps, db_path=DB_PATH)
    except Exception:
        logger.exception("count_missing_steps failed")
        return web.json_response({"error": "count failed"}, status=500)
    return web.json_response({"missing": int(missing)})


async def _post_resync(request: web.Request) -> web.Response:
    image_id = int(request.match_info["id"])
    try:
        rec = await _run(_service.resync_image, image_id, db_path=DB_PATH)
    except KeyError as exc:
        return _error(404, "not_found", str(exc))
    except _paths.SandboxError as exc:
        return _error(403, "sandbox", str(exc))
    except RuntimeError as exc:
        msg = str(exc)
        if "WriteQueue is not started" in msg or "not started" in msg:
            return _error(503, "not_ready", msg)
        logger.exception("resync_image failed")
        return _error(500, "internal", msg)
    except Exception as exc:
        logger.exception("resync_image failed")
        return _error(500, "internal", str(exc))
    return web.json_response(_serialize_image(rec))


async def _delete_image(request: web.Request) -> web.Response:
    image_id = int(request.match_info.get("id", "0"))
    actor = _client_actor(request)
    try:
        out = await _run(
            _service.delete_single_image,
            image_id,
            db_path=DB_PATH,
            actor=actor,
        )
    except KeyError as exc:
        return _error(404, "not_found", str(exc))
    except _paths.SandboxError as exc:
        return _error(403, "sandbox", str(exc))
    except _service.PreflightMoveError as exc:
        st = _preflight_status_for_code(exc.code)
        return _error(st, exc.code, str(exc), exc.details or None)
    except RuntimeError as exc:
        msg = str(exc)
        if "WriteQueue is not started" in msg or "not started" in msg:
            return _error(503, "not_ready", msg)
        logger.exception("delete_single_image failed")
        return _error(500, "internal", msg)
    except Exception as exc:
        logger.exception("delete_single_image failed")
        return _error(500, "internal", str(exc))
    return web.json_response(out)


async def _post_bulk_resolve_selection(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        return _error(400, "invalid_body", f"invalid JSON: {exc}")
    if not isinstance(body, dict):
        return _error(400, "invalid_body", "body must be a JSON object")
    try:
        sel = _parse_selection(body.get("selection"))
    except ValueError as exc:
        return _error(400, "invalid_body", str(exc))
    lim_raw = body.get("limit", 0)
    try:
        limit = int(lim_raw) if lim_raw is not None else 0
    except (TypeError, ValueError):
        return _error(400, "invalid_body", "limit must be an integer")
    if limit < 0:
        return _error(400, "invalid_body", "limit must be non-negative")
    try:
        total, ids = await _run(
            _repo.list_selection_ids_preview,
            db_path=DB_PATH, sel=sel, limit=limit,
        )
    except Exception as exc:
        logger.exception("list_selection_ids_preview failed")
        return _error(500, "internal", str(exc))
    out: dict = {"count": total}
    if ids:
        out["ids"] = ids
    return web.json_response(out)


async def _post_bulk_favorite(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        return _error(400, "invalid_body", f"invalid JSON: {exc}")
    try:
        sel = _parse_selection(body.get("selection"))
    except ValueError as exc:
        return _error(400, "invalid_body", str(exc))
    val = body.get("value", None)
    if not isinstance(val, bool):
        return _error(400, "invalid_body", "value must be a boolean")
    try:
        out = await _run(
            _service.bulk_set_favorite, sel, val, db_path=DB_PATH,
        )
    except _paths.SandboxError as exc:
        return _error(403, "sandbox", str(exc))
    except ValueError as exc:
        return _error(400, "invalid_body", str(exc))
    except RuntimeError as exc:
        msg = str(exc)
        if "WriteQueue is not started" in msg or "not started" in msg:
            return _error(503, "not_ready", msg)
        logger.exception("bulk_set_favorite failed")
        return _error(500, "internal", msg)
    except Exception as exc:
        logger.exception("bulk_set_favorite failed")
        return _error(500, "internal", str(exc))
    return web.json_response(out)


def _preflight_status_for_code(code: str) -> int:
    if code == "not_found":
        return 404
    if code == "sandbox":
        return 403
    if code == "bad_path":
        return 400
    return 400


async def _post_bulk_move_preflight(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        return _error(400, "invalid_body", f"invalid JSON: {exc}")
    if not isinstance(body, dict):
        return _error(400, "invalid_body", "body must be a JSON object")
    try:
        sel = _parse_selection(body.get("selection"))
    except ValueError as exc:
        return _error(400, "invalid_body", str(exc))
    tid = body.get("target_folder_id", None)
    try:
        target_folder_id = int(tid)
    except (TypeError, ValueError):
        return _error(400, "invalid_body", "target_folder_id must be an integer")
    try:
        out = await _run(
            _service.preflight_move, sel, target_folder_id, db_path=DB_PATH,
        )
    except _service.PreflightMoveError as exc:
        st = _preflight_status_for_code(exc.code)
        return _error(st, exc.code, str(exc), exc.details or None)
    except RuntimeError as exc:
        msg = str(exc)
        if "WriteQueue is not started" in msg or "not started" in msg:
            return _error(503, "not_ready", msg)
        logger.exception("preflight_move failed")
        return _error(500, "internal", msg)
    except Exception as exc:
        logger.exception("preflight_move failed")
        return _error(500, "internal", str(exc))
    return web.json_response(out)


async def _post_bulk_move_execute(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        return _error(400, "invalid_body", f"invalid JSON: {exc}")
    if not isinstance(body, dict):
        return _error(400, "invalid_body", "body must be a JSON object")
    pid = body.get("plan_id", None)
    if not isinstance(pid, str) or not pid.strip():
        return _error(400, "invalid_body", "plan_id must be a non-empty string")
    ro = body.get("rename_overrides")
    if ro is not None and not isinstance(ro, dict):
        return _error(400, "invalid_body", "rename_overrides must be an object")
    actor = _client_actor(request)
    try:
        out = await _run(
            _service.execute_move,
            str(pid).strip(), ro, db_path=DB_PATH, actor=actor,
        )
    except _service.PreflightMoveError as exc:
        st = _preflight_status_for_code(exc.code)
        return _error(st, exc.code, str(exc), exc.details or None)
    except RuntimeError as exc:
        msg = str(exc)
        if "WriteQueue is not started" in msg or "not started" in msg:
            return _error(503, "not_ready", msg)
        logger.exception("execute_move failed")
        return _error(500, "internal", msg)
    except Exception as exc:
        logger.exception("execute_move failed")
        return _error(500, "internal", str(exc))
    return web.json_response(out)


async def _post_image_move(request: web.Request) -> web.Response:
    image_id = int(request.match_info["id"])
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        return _error(400, "invalid_body", f"invalid JSON: {exc}")
    if not isinstance(body, dict):
        return _error(400, "invalid_body", "body must be a JSON object")
    tid = body.get("target_folder_id", None)
    try:
        target_folder_id = int(tid)
    except (TypeError, ValueError):
        return _error(400, "invalid_body", "target_folder_id must be an integer")
    rename = body.get("rename", None)
    if rename is not None and not isinstance(rename, str):
        return _error(400, "invalid_body", "rename must be a string or omitted")
    try:
        rec = await _run(
            _service.move_single_image,
            image_id,
            target_folder_id,
            rename,
            db_path=DB_PATH,
        )
    except KeyError as exc:
        return _error(404, "not_found", str(exc))
    except _service.PreflightMoveError as exc:
        if exc.details and "suggested_name" in exc.details:
            return _error(
                409, "invalid_body", str(exc), exc.details,
            )
        st = _preflight_status_for_code(exc.code)
        return _error(st, exc.code, str(exc), exc.details or None)
    except _paths.SandboxError as exc:
        return _error(403, "sandbox", str(exc))
    except RuntimeError as exc:
        msg = str(exc)
        if "WriteQueue is not started" in msg or "not started" in msg:
            return _error(503, "not_ready", msg)
        logger.exception("move_single_image failed")
        return _error(500, "internal", msg)
    except Exception as exc:
        logger.exception("move_single_image failed")
        return _error(500, "internal", str(exc))
    return web.json_response(_serialize_image(rec))


async def _post_bulk_tags(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        return _error(400, "invalid_body", f"invalid JSON: {exc}")
    try:
        sel = _parse_selection(body.get("selection"))
    except ValueError as exc:
        return _error(400, "invalid_body", str(exc))
    add = body.get("add", [])
    remove = body.get("remove", [])
    if not isinstance(add, list) or not isinstance(remove, list):
        return _error(400, "invalid_body", "add and remove must be arrays")
    add_s = [str(x) for x in add]
    rem_s = [str(x) for x in remove]
    try:
        out = await _run(
            _service.bulk_edit_tags, sel, add_s, rem_s, db_path=DB_PATH,
        )
    except _paths.SandboxError as exc:
        return _error(403, "sandbox", str(exc))
    except ValueError as exc:
        return _error(400, "invalid_body", str(exc))
    except RuntimeError as exc:
        msg = str(exc)
        if "WriteQueue is not started" in msg or "not started" in msg:
            return _error(503, "not_ready", msg)
        logger.exception("bulk_edit_tags failed")
        return _error(500, "internal", msg)
    except Exception as exc:
        logger.exception("bulk_edit_tags failed")
        return _error(500, "internal", str(exc))
    return web.json_response(out)


async def _post_bulk_delete_preflight(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        return _error(400, "invalid_body", f"invalid JSON: {exc}")
    if not isinstance(body, dict):
        return _error(400, "invalid_body", "body must be a JSON object")
    try:
        sel = _parse_selection(body.get("selection"))
    except ValueError as exc:
        return _error(400, "invalid_body", str(exc))
    try:
        out = await _run(_service.preflight_delete, sel, db_path=DB_PATH)
    except _service.PreflightMoveError as exc:
        st = _preflight_status_for_code(exc.code)
        return _error(st, exc.code, str(exc), exc.details or None)
    except RuntimeError as exc:
        msg = str(exc)
        if "WriteQueue is not started" in msg or "not started" in msg:
            return _error(503, "not_ready", msg)
        logger.exception("preflight_delete failed")
        return _error(500, "internal", msg)
    except Exception as exc:
        logger.exception("preflight_delete failed")
        return _error(500, "internal", str(exc))
    return web.json_response(out)


async def _post_bulk_delete_execute(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except json.JSONDecodeError as exc:
        return _error(400, "invalid_body", f"invalid JSON: {exc}")
    if not isinstance(body, dict):
        return _error(400, "invalid_body", "body must be a JSON object")
    pid = body.get("plan_id", None)
    if not isinstance(pid, str) or not pid.strip():
        return _error(400, "invalid_body", "plan_id must be a non-empty string")
    actor = _client_actor(request)
    try:
        out = await _run(
            _service.execute_delete,
            str(pid).strip(),
            db_path=DB_PATH,
            actor=actor,
        )
    except _service.PreflightMoveError as exc:
        st = _preflight_status_for_code(exc.code)
        return _error(st, exc.code, str(exc), exc.details or None)
    except RuntimeError as exc:
        msg = str(exc)
        if "WriteQueue is not started" in msg or "not started" in msg:
            return _error(503, "not_ready", msg)
        logger.exception("execute_delete failed")
        return _error(500, "internal", msg)
    except Exception as exc:
        logger.exception("execute_delete failed")
        return _error(500, "internal", str(exc))
    return web.json_response(out)


# ---- registration --------------------------------------------------------

def register(server) -> None:
    """Register gallery HTTP routes onto the host PromptServer.

    ``server`` is ComfyUI's ``PromptServer`` (or any object with a
    ``routes`` attribute compatible with ``aiohttp.web.RouteTableDef``).
    Idempotent: a second call is a no-op.
    """
    global _registered
    if _registered:
        return
    routes = server.routes

    routes.get("/xyz/gallery")(_serve_spa)
    routes.get(r"/xyz/gallery/static/{tail:.*}")(_serve_static)
    routes.get("/xyz/gallery/folders")(_get_folders)
    routes.post("/xyz/gallery/folders")(_post_folders)
    routes.get(r"/xyz/gallery/folders/{id:\d+}/delete-preview")(
        _get_folder_delete_preview,
    )
    routes.delete(r"/xyz/gallery/folders/{id:\d+}")(_delete_folder)
    routes.post(r"/xyz/gallery/folders/{id:\d+}/rescan")(_post_folder_rescan)
    routes.post(r"/xyz/gallery/folders/{id:\d+}/mkdir")(_post_folder_mkdir)
    routes.patch(r"/xyz/gallery/folders/{id:\d+}")(_patch_folder)
    routes.post(r"/xyz/gallery/folders/{id:\d+}/move")(_post_folder_move)
    routes.post(r"/xyz/gallery/folders/{id:\d+}/open")(_post_folder_open)
    routes.get("/xyz/gallery/vocab/tags")(_get_vocab_tags)
    routes.get("/xyz/gallery/vocab/prompts")(_get_vocab_prompts)
    routes.get("/xyz/gallery/vocab/words")(_get_vocab_words)
    routes.get("/xyz/gallery/vocab/models")(_get_vocab_models)
    routes.get("/xyz/gallery/index/status")(_get_index_status)
    routes.get("/xyz/gallery/jobs/active")(_get_jobs_active)
    routes.get("/xyz/gallery/images")(_list_images)
    routes.get("/xyz/gallery/images/count")(_images_count)
    routes.get(r"/xyz/gallery/image/{id:\d+}")(_get_image)
    routes.get(r"/xyz/gallery/image/{id:\d+}/neighbors")(_image_neighbors)
    routes.get(r"/xyz/gallery/image/{id:\d+}/workflow.json")(_get_workflow)
    routes.patch(r"/xyz/gallery/image/{id:\d+}")(_patch_image)
    routes.post(r"/xyz/gallery/image/{id:\d+}/resync")(_post_resync)
    routes.post("/xyz/gallery/images/send_to_krita")(_post_send_to_krita)
    routes.get("/xyz/gallery/admin/backfill_steps")(_get_backfill_steps)
    routes.post("/xyz/gallery/admin/backfill_steps")(_post_backfill_steps)
    routes.delete(r"/xyz/gallery/image/{id:\d+}")(_delete_image)
    routes.get(r"/xyz/gallery/thumb/{id:\d+}")(_get_thumb)
    routes.get(r"/xyz/gallery/raw/{id:\d+}")(_get_raw_inline)
    routes.get(r"/xyz/gallery/raw/{id:\d+}/download")(_get_raw_download)
    routes.get("/xyz/gallery/preferences")(_get_gallery_preferences)
    routes.patch("/xyz/gallery/preferences")(_patch_gallery_preferences)
    routes.get("/xyz/gallery/admin/tags")(_get_admin_tags)
    routes.post("/xyz/gallery/admin/tags/delete")(_post_admin_tags_delete)
    routes.post("/xyz/gallery/admin/tags/purge_zero")(_post_admin_tags_purge_zero)
    routes.post("/xyz/gallery/admin/tags/rename")(_post_admin_tags_rename)
    routes.get("/xyz/gallery/ws")(_ws_handler)
    routes.post("/xyz/gallery/bulk/resolve_selection")(_post_bulk_resolve_selection)
    routes.post("/xyz/gallery/bulk/favorite")(_post_bulk_favorite)
    routes.post("/xyz/gallery/bulk/tags")(_post_bulk_tags)
    routes.post("/xyz/gallery/bulk/move/preflight")(_post_bulk_move_preflight)
    routes.post("/xyz/gallery/bulk/move/execute")(_post_bulk_move_execute)
    routes.post("/xyz/gallery/bulk/delete/preflight")(_post_bulk_delete_preflight)
    routes.post("/xyz/gallery/bulk/delete/execute")(_post_bulk_delete_execute)
    routes.post(r"/xyz/gallery/image/{id:\d+}/move")(_post_image_move)

    _registered = True
    logger.info(
        "XYZ Gallery routes registered (/xyz/gallery + vocab + read + "
        "write + bulk + move + delete + ws)"
    )
