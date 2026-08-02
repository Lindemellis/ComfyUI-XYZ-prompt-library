"""XYZ Image Gallery — PNG metadata reader (T06).

Pure functions that extract ComfyUI / A1111 metadata from PNG ``tEXt`` /
``iTXt`` chunks, plus the gallery-owned mirror chunks
(``xyz_gallery.tags`` / ``xyz_gallery.favorite``).

Boundary notes (PROJECT_STATE §7 / AI_RULES R5.5):

* No SQLite knowledge here.  No imports from ``repo`` / ``db`` /
  ``folders`` / ``paths``.
* Read helpers are pure: read-only on disk, no logging side effects on
  caller state, no background tasks scheduled.  Two calls with the same
  input file return equal :class:`ComfyMeta` instances.
  :func:`write_xyz_chunks` mutates the target PNG atomically (T17).
* Failure-tolerant: malformed / non-PNG / missing-chunk inputs return a
  partially-filled :class:`ComfyMeta` plus an ``errors`` tuple — never
  raise (NFR-1, TASKS T06 test #3).
"""

from __future__ import annotations

import io
import json
import os
import re
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Tuple

from PIL import Image, UnidentifiedImageError
from PIL.PngImagePlugin import PngInfo

from . import paths as _paths


_KEY_PROMPT = "prompt"          # ComfyUI: API workflow JSON (executable form)
_KEY_WORKFLOW = "workflow"      # ComfyUI: UI graph JSON (download target)
_KEY_PARAMETERS = "parameters"  # A1111-style human-readable text

_KEY_XYZ_TAGS = "xyz_gallery.tags"
_KEY_XYZ_FAVORITE = "xyz_gallery.favorite"

# ``write_xyz_chunks`` uses :func:`tempfile.mkstemp` with this prefix;
# watcher / indexer must skip these names (they are not real gallery assets).
GALLERY_ATOMIC_TMP_PREFIX = ".xyz_gallery_"


def is_gallery_atomic_temp_basename(name: str) -> bool:
    """True for temp names created next to the target PNG during atomic writes."""
    s = str(name or "")
    return s.startswith(GALLERY_ATOMIC_TMP_PREFIX) and s.lower().endswith(".png")


_SAMPLER_NODE_HINTS: Tuple[str, ...] = ("KSampler", "Sampler")
_CHECKPOINT_NODE_HINTS: Tuple[str, ...] = ("Checkpoint", "Loader", "Model")
_TEXT_ENCODE_HINTS: Tuple[str, ...] = ("CLIPTextEncode", "TextEncode")


@dataclass(frozen=True)
class ComfyMeta:
    """Pure DTO returned by :func:`read_comfy_metadata`.

    Field set = ``PROJECT_SPEC §6.2 ImageRecord.metadata`` (read-only
    ComfyUI fields) ∪ the two gallery-owned mirror fields ∪ ``errors``.
    Frozen + tuple-only collections so equality / hashing are stable across
    calls (TASKS T06 test #4).

    Mirror fields (``tags`` / ``favorite``) are returned **verbatim** as
    strings; T06 must not parse / split / coerce them — that is T07's job
    (PROJECT_STATE §7 note 4).
    """

    positive_prompt: Optional[str] = None
    negative_prompt: Optional[str] = None
    model: Optional[str] = None
    seed: Optional[int] = None
    cfg: Optional[float] = None
    sampler: Optional[str] = None
    scheduler: Optional[str] = None
    has_workflow: bool = False
    tags: Optional[str] = None
    favorite: Optional[str] = None
    errors: Tuple[str, ...] = ()


def read_comfy_metadata(path) -> ComfyMeta:
    """Extract ComfyUI / A1111 metadata + gallery mirror fields from a PNG.

    Source-priority for derived fields (TASKS T06 / SPEC §10 Q3):
    ``workflow JSON > parameters text > empty``.  Within "workflow JSON"
    the API-prompt chunk (``prompt``) is preferred over the UI graph chunk
    (``workflow``) because the former is shaped as
    ``{node_id: {class_type, inputs}}`` — the only form from which we can
    deterministically follow ``positive`` / ``negative`` links to text
    encoders without re-implementing the visual editor's link table.
    """

    p = Path(path)
    errors: list[str] = []

    chunks = _open_png_text(p, errors)
    if chunks is None:
        return ComfyMeta(errors=tuple(errors))

    workflow_obj = _parse_json_chunk(chunks, _KEY_PROMPT, errors)
    if workflow_obj is None:
        workflow_obj = _parse_json_chunk(chunks, _KEY_WORKFLOW, errors)

    derived: dict[str, Any] = {}
    if isinstance(workflow_obj, Mapping):
        derived = _derive_from_workflow(workflow_obj)

    if not derived and _KEY_PARAMETERS in chunks:
        derived = _derive_from_parameters(str(chunks[_KEY_PARAMETERS]))

    has_workflow = bool(chunks.get(_KEY_WORKFLOW))

    tags_raw = chunks.get(_KEY_XYZ_TAGS)
    favorite_raw = chunks.get(_KEY_XYZ_FAVORITE)

    return ComfyMeta(
        positive_prompt=_str_or_none(derived.get("positive_prompt")),
        negative_prompt=_str_or_none(derived.get("negative_prompt")),
        model=_str_or_none(derived.get("model")),
        seed=_int_or_none(derived.get("seed"), errors),
        cfg=_float_or_none(derived.get("cfg"), errors),
        sampler=_str_or_none(derived.get("sampler")),
        scheduler=_str_or_none(derived.get("scheduler")),
        has_workflow=has_workflow,
        tags=str(tags_raw) if tags_raw is not None else None,
        favorite=str(favorite_raw) if favorite_raw is not None else None,
        errors=tuple(errors),
    )


def _open_png_text(p: Path, errors: list[str]) -> Optional[dict[str, str]]:
    if not p.is_file():
        errors.append(f"file not found: {p}")
        return None
    try:
        with Image.open(p) as img:
            if (img.format or "").upper() != "PNG":
                errors.append(f"not a PNG: format={img.format!r}")
                return None
            # Pillow lazy-loads PNG text chunks.  load() forces the parser
            # and merges tEXt / iTXt / zTXt into img.text (iTXt
            # decompression + UTF-8 decoding handled internally — TASKS
            # T06 §6 forbids hand-rolled chunk parsing).
            img.load()
            text = getattr(img, "text", None) or {}
            return {str(k): str(v) for k, v in text.items()}
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        errors.append(f"PIL open failed: {exc!s}")
        return None


def _parse_json_chunk(
    chunks: Mapping[str, str], key: str, errors: list[str]
) -> Optional[Any]:
    raw = chunks.get(key)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except (ValueError, TypeError) as exc:
        errors.append(f"chunk {key!r} is not valid JSON: {exc!s}")
        return None


def _derive_from_workflow(workflow: Mapping[str, Any]) -> dict[str, Any]:
    """Best-effort extraction from a ComfyUI API-prompt JSON.

    The API form is ``{node_id: {class_type, inputs}}``.  The UI graph
    form (``{"nodes": [...], "links": [...]}``) does not match this shape
    and is silently skipped — its parameters are recoverable from the
    sibling ``prompt`` chunk in any well-formed ComfyUI PNG.
    """

    if not all(
        isinstance(v, Mapping) and "class_type" in v
        for v in workflow.values()
    ):
        return {}
    nodes: Mapping[str, Mapping[str, Any]] = workflow  # type: ignore[assignment]

    out: dict[str, Any] = {}
    sampler_node = _find_node(nodes, _SAMPLER_NODE_HINTS)
    if sampler_node is not None:
        inputs = sampler_node.get("inputs") or {}
        for src, dst in (
            ("seed", "seed"),
            ("noise_seed", "seed"),
            ("cfg", "cfg"),
            ("sampler_name", "sampler"),
            ("scheduler", "scheduler"),
        ):
            if dst in out:
                continue
            value = inputs.get(src)
            if value is None or _is_link(value):
                continue
            out[dst] = value

        positive = _follow_text_link(nodes, inputs.get("positive"))
        if positive is not None:
            out["positive_prompt"] = positive
        negative = _follow_text_link(nodes, inputs.get("negative"))
        if negative is not None:
            out["negative_prompt"] = negative

    ckpt = _find_node(nodes, _CHECKPOINT_NODE_HINTS)
    if ckpt is not None:
        inputs = ckpt.get("inputs") or {}
        for key in ("ckpt_name", "model_name", "model"):
            value = inputs.get(key)
            if value is None or _is_link(value):
                continue
            out["model"] = value
            break
    return out


def _is_link(value: Any) -> bool:
    """ComfyUI represents node-to-node connections as ``[node_id, slot]``."""
    return (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[1], int)
    )


def _find_node(
    nodes: Mapping[str, Mapping[str, Any]], hints: Tuple[str, ...]
) -> Optional[Mapping[str, Any]]:
    for node in nodes.values():
        ct = str(node.get("class_type") or "")
        if any(h in ct for h in hints):
            return node
    return None


def _follow_text_link(
    nodes: Mapping[str, Mapping[str, Any]], link: Any, depth: int = 0
) -> Optional[str]:
    # Bounded recursion: real graphs are shallow, but we cap at 4 hops in
    # case of pathological inputs (cycles are forbidden by ComfyUI but a
    # corrupt PNG could carry one).
    if depth >= 4 or not _is_link(link):
        return None
    target = nodes.get(str(link[0]))
    if not isinstance(target, Mapping):
        return None
    ct = str(target.get("class_type") or "")
    if not any(h in ct for h in _TEXT_ENCODE_HINTS):
        return None
    text = (target.get("inputs") or {}).get("text")
    if isinstance(text, str):
        return text
    if _is_link(text):
        return _follow_text_link(nodes, text, depth + 1)
    return None


# A1111 ``parameters`` shape:
#   <positive prompt, may span lines>
#   Negative prompt: <negative prompt, may span lines>
#   Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 1234, Model: foo
# NB: the trailing run must NOT be ``\s*`` — an empty negative (``Negative
# prompt: \nSteps: …``, which is what a no-negative model like krea2 writes)
# would let it swallow the newline before the kv line, and the kv blob would
# then be read as the negative prompt.  Horizontal whitespace only.
_PARAMS_NEG_RE = re.compile(r"\nNegative prompt:[^\S\r\n]*", re.IGNORECASE)
_PARAMS_KV_RE = re.compile(
    r"([A-Za-z][A-Za-z0-9 _-]*?)\s*:\s*"
    r"([^,]+?)"
    r"(?=,\s*[A-Za-z][A-Za-z0-9 _-]*?\s*:|$)"
)


def _peel_kv_line(block: str) -> tuple[str, str]:
    """Split ``block`` into (prompt, kv line).

    The kv blob is always the last line, but only if it looks like one — a
    prompt that happens to end on its own line must not be eaten.
    """
    if "\n" not in block:
        return block, ""
    head, tail = block.rsplit("\n", 1)
    if ":" in tail and "," in tail:
        return head, tail
    return block, ""


def _derive_from_parameters(text: str) -> dict[str, Any]:
    if not text:
        return {}
    out: dict[str, Any] = {}

    neg_match = _PARAMS_NEG_RE.search(text)
    if neg_match:
        positive = text[: neg_match.start()]
        negative, kv_line = _peel_kv_line(text[neg_match.end():])
        out["negative_prompt"] = negative.strip()
    else:
        # No negative section — the trailing line may still be the kv blob
        # (some forks omit negatives entirely).
        positive, kv_line = _peel_kv_line(text)

    out["positive_prompt"] = positive.strip()

    if kv_line:
        for k, v in _PARAMS_KV_RE.findall(kv_line):
            key = k.strip().lower()
            value = v.strip()
            if key == "seed":
                out["seed"] = value
            elif key in ("cfg", "cfg scale"):
                out["cfg"] = value
            elif key == "sampler":
                out["sampler"] = value
            elif key == "scheduler":
                out["scheduler"] = value
            elif key == "model":
                out["model"] = value
    return out


def _str_or_none(value: Any) -> Optional[str]:
    if value is None:
        return None
    s = str(value)
    return s if s != "" else None


def _int_or_none(value: Any, errors: list[str]) -> Optional[int]:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError) as exc:
        errors.append(f"seed not int: {value!r} ({exc!s})")
        return None


def _float_or_none(value: Any, errors: list[str]) -> Optional[float]:
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        errors.append(f"cfg not float: {value!r} ({exc!s})")
        return None


def build_png_download_bytes(path: Any, variant: str) -> bytes:
    """Re-encode a PNG with text chunks filtered by export ``variant`` (T35).

    ``variant``:
      * ``no_workflow`` — drop the ComfyUI UI graph ``workflow`` chunk only.
      * ``clean`` — drop ``workflow``, API ``prompt``, A1111-style ``parameters``,
        and all ``xyz_gallery.*`` chunks (raster without embedded Comfy / webui
        generation metadata).

    Pixel data and all other ancillary chunks are preserved as Pillow allows.
    Raises:
        FileNotFoundError / ValueError / OSError — same family as
        :func:`write_xyz_chunks` for non-PNG or missing files.
    """
    v = str(variant or "").strip()
    if v not in ("no_workflow", "clean"):
        raise ValueError(f"unsupported export variant: {variant!r}")

    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(str(p))
    with Image.open(p) as img:
        img.load()
        if (img.format or "").upper() != "PNG":
            raise ValueError(f"not a PNG: format={img.format!r}")
        text = dict(getattr(img, "text", {}) or {})
        pnginfo = PngInfo()
        for key, value in text.items():
            sk = str(key)
            if v == "no_workflow" and sk == _KEY_WORKFLOW:
                continue
            if v == "clean":
                if sk in (_KEY_WORKFLOW, _KEY_PROMPT, _KEY_PARAMETERS):
                    continue
                if sk.startswith("xyz_gallery."):
                    continue
            pnginfo.add_text(sk, str(value), zip=False)
        buf = io.BytesIO()
        img.save(
            buf,
            format="PNG",
            pnginfo=pnginfo,
            compress_level=6,
        )
        return buf.getvalue()


def write_xyz_chunks(
    path: Any,
    tags: Optional[str],
    favorite: Optional[int],
    *,
    atomic_staging_dir: Optional[Any] = None,
) -> None:
    """Write gallery mirror chunks to a PNG; preserve all other tEXt / iTXt.

    Atomically replaces the file (write-temp + :func:`os.replace`). Only keys
    whose names start with ``xyz_gallery.`` are removed and optionally replaced
    by new ``xyz_gallery.tags`` / ``xyz_gallery.favorite`` chunks — every other
    text chunk (``prompt``, ``workflow``, …) is copied verbatim (C-6 /
    TASKS.md T17).

    ``tags`` / ``favorite`` mirror :func:`read_comfy_metadata` wire shapes:
    ``tags`` is the raw ``tags_csv`` string (or ``None`` to omit the chunk);
    ``favorite`` is ``0`` / ``1`` / ``None`` (omit chunk). This stays aligned
    with indexer normalisation (PROJECT_STATE §4 #24).

    ``atomic_staging_dir`` (optional): when set (e.g. under ``gallery_data/``),
    temp files are tried there first so clutter stays out of library trees when
    :func:`os.replace` can reach the target (same volume). When that fails
    (e.g. gallery DB on ``C:`` but images on ``D:``), the writer uses a hidden
    sibling directory ``<parent-of-target>/.xyz_gallery_atomic/`` — still the
    same volume as the PNG so replace succeeds; temps do **not** land next to
    real images in the visible folder. Only if both fail does it fall back to
    ``mkstemp`` directly in the target's parent (legacy).

    Raises:
        FileNotFoundError: path does not exist.
        ValueError: not a PNG or Pillow cannot decode the image.
        OSError: temp write / replace failed (permissions, disk full, …).
    """

    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(str(p))

    staging_parents: list[Path] = []
    seen_norm: set[str] = set()

    def _add_staging_parent(candidate: Path) -> None:
        try:
            key = str(candidate.resolve(strict=False))
        except OSError:
            key = str(candidate)
        if key in seen_norm:
            return
        seen_norm.add(key)
        staging_parents.append(candidate)

    if atomic_staging_dir is not None:
        sd = Path(atomic_staging_dir)
        try:
            sd.mkdir(parents=True, exist_ok=True)
            _add_staging_parent(sd)
        except OSError:
            pass
    try:
        local_staging = p.parent / _paths.XYZ_GALLERY_ATOMIC_DIRNAME
        local_staging.mkdir(parents=True, exist_ok=True)
        _add_staging_parent(local_staging)
    except OSError:
        pass
    _add_staging_parent(p.parent)

    last_os_err: Optional[OSError] = None
    for parent in staging_parents:
        tmp_fd: Optional[int] = None
        tmp_path: Optional[Path] = None
        try:
            with Image.open(p) as img:
                img.load()
                if (img.format or "").upper() != "PNG":
                    raise ValueError(f"not a PNG: format={img.format!r}")
                text = dict(getattr(img, "text", {}) or {})
                pnginfo = PngInfo()
                for key, value in text.items():
                    sk = str(key)
                    if sk.startswith("xyz_gallery."):
                        continue
                    pnginfo.add_text(sk, str(value), zip=False)
                if tags is not None:
                    pnginfo.add_text(_KEY_XYZ_TAGS, str(tags), zip=False)
                if favorite is not None:
                    fav_s = "1" if int(favorite) else "0"
                    pnginfo.add_text(_KEY_XYZ_FAVORITE, fav_s, zip=False)
                try:
                    parent.mkdir(parents=True, exist_ok=True)
                except OSError:
                    pass
                tmp_fd, tmp_name = tempfile.mkstemp(
                    suffix=".png",
                    prefix=GALLERY_ATOMIC_TMP_PREFIX,
                    dir=str(parent),
                )
                tmp_path = Path(tmp_name)
                os.close(tmp_fd)
                tmp_fd = None
                img.save(
                    tmp_path,
                    format="PNG",
                    pnginfo=pnginfo,
                    compress_level=6,
                )
            os.replace(str(tmp_path), str(p))
            tmp_path = None
            return
        except OSError as exc:
            last_os_err = exc
        finally:
            if tmp_fd is not None:
                try:
                    os.close(tmp_fd)
                except OSError:
                    pass
            if tmp_path is not None:
                try:
                    tmp_path.unlink()
                except OSError:
                    pass

    if last_os_err is not None:
        raise last_os_err
    raise OSError(f"write_xyz_chunks: atomic replace failed for {p!r}")


def read_workflow_chunk(path) -> Optional[str]:
    """Return the raw ``workflow`` tEXt/iTXt chunk verbatim, or ``None``.

    Added for T10's ``GET /xyz/gallery/image/{id}/workflow.json`` endpoint:
    the route layer must ship the UI graph JSON **unmodified** (so it can
    be pasted straight back into the ComfyUI editor — SPEC §4 #23), but
    also must not import PIL itself (ARCHITECTURE §2.1 module boundary —
    PNG-chunk knowledge stays inside ``metadata``).

    Pure / failure-tolerant in the same sense as :func:`read_comfy_metadata`:
    missing file, non-PNG, or absent chunk → ``None``, never an exception.
    """
    p = Path(path)
    errors: list[str] = []
    chunks = _open_png_text(p, errors)
    if chunks is None:
        return None
    raw = chunks.get(_KEY_WORKFLOW)
    if raw is None:
        return None
    s = str(raw)
    return s if s != "" else None


__all__ = [
    "ComfyMeta",
    "GALLERY_ATOMIC_TMP_PREFIX",
    "is_gallery_atomic_temp_basename",
    "read_comfy_metadata",
    "read_workflow_chunk",
    "build_png_download_bytes",
    "write_xyz_chunks",
]
