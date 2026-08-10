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
from . import video as _video


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
#: Ordered by how specific the hint is, because ``_iter_nodes`` walks them in
#: order and the first candidate that actually carries a model name wins.
#: ``Loader`` and ``Model`` are so broad that they match ``VAELoader``,
#: ``CLIPLoader`` and ``ApplyFBCacheOnModel`` — they must come last or they
#: shadow the real loader (which is exactly the bug this ordering fixes).
_CHECKPOINT_NODE_HINTS: Tuple[str, ...] = (
    "Checkpoint", "UNETLoader", "UnetLoader", "DiffusionModel", "Loader", "Model",
)
_TEXT_ENCODE_HINTS: Tuple[str, ...] = ("CLIPTextEncode", "TextEncode")

#: Input names that hold a model file name, most specific first.
_MODEL_NAME_FIELDS: Tuple[str, ...] = (
    "ckpt_name", "unet_name", "model_name", "model",
)

#: ``SamplerCustomAdvanced`` takes noise / guider / sampler / sigmas as LINKS
#: and so carries no scalar of its own. Everything a KSampler would have said
#: is spread across these core ComfyUI nodes instead. This is not a
#: workflow-pack special case — it is the standard modern graph (Flux, Anima,
#: MiniMax H3 and anything else built on SamplerCustomAdvanced).
_ADVANCED_SAMPLER_SOURCES: Tuple[Tuple[str, Tuple[Tuple[str, str], ...]], ...] = (
    ("RandomNoise", (("noise_seed", "seed"),)),
    ("DisableNoise", (("noise_seed", "seed"),)),
    ("BasicScheduler", (("steps", "steps"), ("scheduler", "scheduler"))),
    ("KSamplerSelect", (("sampler_name", "sampler"),)),
    ("CFGGuider", (("cfg", "cfg"),)),
    ("SamplerCustom", (("noise_seed", "seed"), ("cfg", "cfg"))),
)

#: Nodes that stand between an advanced sampler and its conditioning.
_GUIDER_HINTS: Tuple[str, ...] = ("Guider",)

#: ComfyUI's scheduler list (``comfy.samplers.SCHEDULER_HANDLERS``).  A1111's
#: ``parameters`` convention packs the scheduler *into* the ``Sampler:`` field
#: and emits no ``Scheduler:`` key of its own (``Sampler: Euler simple``);
#: writers also prettify the name (``sgm_uniform`` → ``SGM Uniform``).
#: Matching the normalised tail against this list is what splits them back
#: apart without eating a sampler whose own name carries underscores
#: (``dpmpp_2m_sde_gpu``).
_SCHEDULER_NAMES: Tuple[str, ...] = (
    "simple",
    "sgm_uniform",
    "karras",
    "exponential",
    "ddim_uniform",
    "beta",
    "normal",
    "linear_quadratic",
    "kl_optimal",
)


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
    steps: Optional[int] = None
    sampler: Optional[str] = None
    scheduler: Optional[str] = None
    has_workflow: bool = False
    tags: Optional[str] = None
    favorite: Optional[str] = None
    errors: Tuple[str, ...] = ()


def read_comfy_metadata(path) -> ComfyMeta:
    """Extract ComfyUI / A1111 metadata + gallery mirror fields from a media file.

    Source-priority for derived fields (TASKS T06 / SPEC §10 Q3):
    ``workflow JSON > parameters text > empty``.  Within "workflow JSON"
    the API-prompt chunk (``prompt``) is preferred over the UI graph chunk
    (``workflow``) because the former is shaped as
    ``{node_id: {class_type, inputs}}`` — the only form from which we can
    deterministically follow ``positive`` / ``negative`` links to text
    encoders without re-implementing the visual editor's link table.

    Video containers go through the identical pipeline.  Only the *reader*
    differs: ComfyUI writes the same ``workflow`` / ``prompt`` JSON into an
    MP4's container tags that it writes into a PNG's ``tEXt`` chunks, so
    swapping ``_open_png_text`` for ``video.read_container_metadata`` is the
    whole of the change — every derivation below is shared verbatim.
    """

    p = Path(path)
    errors: list[str] = []

    if _video.is_video_path(p):
        chunks = _open_video_tags(p, errors)
    else:
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
        steps=_int_or_none(derived.get("steps"), errors),
        sampler=_str_or_none(derived.get("sampler")),
        scheduler=_str_or_none(derived.get("scheduler")),
        has_workflow=has_workflow,
        tags=str(tags_raw) if tags_raw is not None else None,
        favorite=str(favorite_raw) if favorite_raw is not None else None,
        errors=tuple(errors),
    )


def _open_video_tags(p: Path, errors: list[str]) -> Optional[dict[str, str]]:
    """Container tags for a video, shaped like ``_open_png_text``'s return.

    A clip with *no* tags is not an error — plenty of videos carry none — so
    an empty dict is returned rather than None; the caller then derives
    nothing and the row is simply metadata-less. None is reserved for "could
    not read the file at all", which is what the image path means by it too.
    """
    if not p.is_file():
        errors.append(f"file not found: {p}")
        return None
    if not _video.have_av():
        errors.append("PyAV unavailable: video metadata not read")
        return None
    tags = _video.read_container_metadata(p)
    if tags is None:
        errors.append(f"could not open video container: {p.name}")
        return None
    return tags


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
    _derive_sampler_fields(nodes, out)
    _derive_model_name(nodes, out)
    return out


_SAMPLER_SCALAR_FIELDS: Tuple[Tuple[str, str], ...] = (
    ("seed", "seed"),
    ("noise_seed", "seed"),
    ("cfg", "cfg"),
    ("steps", "steps"),
    ("sampler_name", "sampler"),
    ("scheduler", "scheduler"),
)


def _derive_sampler_fields(
    nodes: Mapping[str, Mapping[str, Any]], out: dict[str, Any]
) -> None:
    """Fill seed / cfg / steps / sampler / scheduler / prompts.

    Walks EVERY sampler-shaped node rather than only the first one. The old
    code stopped at the first class_type containing "Sampler", which on a
    ``SamplerCustomAdvanced`` graph is a node whose five inputs are all links —
    so it extracted nothing and never looked further. First value wins per
    field, so a graph that already worked derives exactly what it did before.
    """
    for node in _iter_nodes(nodes, _SAMPLER_NODE_HINTS):
        inputs = node.get("inputs") or {}
        for src, dst in _SAMPLER_SCALAR_FIELDS:
            if dst in out:
                continue
            value = _literal(inputs, src)
            if value is not None:
                out[dst] = value
        _derive_prompts(nodes, inputs, out)

    # The advanced-sampler family keeps its scalars in sibling nodes.
    for hint, mapping in _ADVANCED_SAMPLER_SOURCES:
        if all(dst in out for _, dst in mapping):
            continue
        for node in _iter_nodes(nodes, (hint,)):
            inputs = node.get("inputs") or {}
            for src, dst in mapping:
                if dst in out:
                    continue
                value = _literal(inputs, src)
                if value is not None:
                    out[dst] = value


def _derive_prompts(
    nodes: Mapping[str, Mapping[str, Any]],
    inputs: Mapping[str, Any],
    out: dict[str, Any],
) -> None:
    """Positive / negative text, direct or through a guider.

    A KSampler links ``positive`` / ``negative`` straight at the text encoders.
    ``SamplerCustomAdvanced`` links a ``guider`` instead, and the conditioning
    hangs off that — one extra hop, and without it every modern graph reports
    no prompt at all.
    """
    for src, dst in (("positive", "positive_prompt"), ("negative", "negative_prompt")):
        if dst in out:
            continue
        text = _follow_text_link(nodes, inputs.get(src))
        if text is not None:
            out[dst] = text

    if "positive_prompt" in out and "negative_prompt" in out:
        return

    # SamplerCustomAdvanced hides conditioning behind a guider…
    guider = _resolve_link(nodes, inputs.get("guider"))
    if guider is not None:
        ginputs = guider.get("inputs") or {}
        # BasicGuider names it ``conditioning``; CFGGuider keeps pos/neg.
        for src, dst, role in (
            ("positive", "positive_prompt", "positive"),
            ("conditioning", "positive_prompt", "positive"),
            ("negative", "negative_prompt", "negative"),
        ):
            if dst in out:
                continue
            text = _trace_prompt_text(nodes, ginputs.get(src), role)
            if text is not None:
                out[dst] = text

    # …and Impact Pack hides it behind a pipe. Both end at the same walk.
    for src, dst, role in (
        ("positive", "positive_prompt", "positive"),
        ("negative", "negative_prompt", "negative"),
    ):
        if dst in out:
            continue
        start = inputs.get(src)
        if not _is_link(start):
            start = inputs.get("basic_pipe") or inputs.get("pipe")
        text = _trace_prompt_text(nodes, start, role)
        if text is not None:
            out[dst] = text


def _derive_model_name(
    nodes: Mapping[str, Mapping[str, Any]], out: dict[str, Any]
) -> None:
    """The checkpoint / UNet file name.

    Candidates are visited most-specific-hint first, and a candidate that
    carries none of the name fields is SKIPPED rather than ending the search.
    That is the fix for the shadowing bug: ``VAELoader`` matches the broad
    ``Loader`` hint and only has ``vae_name``, so under the old first-match
    rule it beat the real ``UNETLoader`` and the model came out empty — on
    roughly a third of an ordinary library, not just on video workflows.
    """
    if "model" in out:
        return
    for node in _iter_nodes(nodes, _CHECKPOINT_NODE_HINTS):
        inputs = node.get("inputs") or {}
        for key in _MODEL_NAME_FIELDS:
            value = _literal(inputs, key)
            if value is not None and str(value).strip():
                out["model"] = value
                return


def _is_link(value: Any) -> bool:
    """ComfyUI represents node-to-node connections as ``[node_id, slot]``."""
    return (
        isinstance(value, list)
        and len(value) == 2
        and isinstance(value[1], int)
    )


def _literal(inputs: Mapping[str, Any], key: str) -> Optional[Any]:
    """The value of ``key`` when it is a literal, not a node-to-node link."""
    value = inputs.get(key)
    if value is None or _is_link(value):
        return None
    return value


def _iter_nodes(
    nodes: Mapping[str, Mapping[str, Any]], hints: Tuple[str, ...]
):
    """Every node matching ``hints``, hint by hint in the order given.

    Hint order is priority order: all ``Checkpoint`` nodes are offered before
    any ``Loader`` node, so a broad hint can no longer shadow a specific one.
    Each node is yielded at most once even when several hints match it.
    """
    seen: set = set()
    for hint in hints:
        for nid, node in nodes.items():
            if nid in seen or not isinstance(node, Mapping):
                continue
            if hint in str(node.get("class_type") or ""):
                seen.add(nid)
                yield node


def _resolve_link(
    nodes: Mapping[str, Mapping[str, Any]], link: Any
) -> Optional[Mapping[str, Any]]:
    """The node a ``[node_id, slot]`` link points at."""
    if not _is_link(link):
        return None
    target = nodes.get(str(link[0]))
    return target if isinstance(target, Mapping) else None


def _find_node(
    nodes: Mapping[str, Mapping[str, Any]], hints: Tuple[str, ...]
) -> Optional[Mapping[str, Any]]:
    """First node matching any hint (hint order = priority)."""
    for node in _iter_nodes(nodes, hints):
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


#: Inputs that may hold prompt text as a literal, most likely first.
#: ``populated_text`` before ``wildcard_text``: Impact's wildcard processor
#: keeps the pattern in one and the RESOLVED prompt in the other, and the
#: resolved one is what actually generated the picture.
_TEXT_LITERAL_FIELDS: Tuple[str, ...] = (
    "text", "populated_text", "wildcard_text", "template",
    "string", "value", "prompt", "text_g", "text_l",
)

#: Role-specific text inputs, tried before the shared ones above so a node
#: carrying both halves cannot answer with the wrong one.
_TEXT_ROLE_FIELDS: dict = {
    "positive": ("text_positive", "positive_text", "positive_prompt"),
    "negative": ("text_negative", "negative_text", "negative_prompt"),
}

#: Inputs to follow when a node is a pass-through rather than an encoder.
#: Walked after the role-named input (``positive`` / ``negative``), which is
#: what keeps a negative chain from wandering into the positive branch.
_TEXT_PASSTHROUGH_FIELDS: Tuple[str, ...] = (
    "text", "conditioning", "basic_pipe", "pipe",
)

#: Conditioning rarely sits more than a handful of hops from the sampler even
#: through Impact's pipes; the cap is what stops a corrupt graph looping.
_TEXT_TRACE_MAX_DEPTH: int = 8


def _trace_prompt_text(
    nodes: Mapping[str, Mapping[str, Any]],
    link: Any,
    role: str,
    depth: int = 0,
    seen: Optional[set] = None,
) -> Optional[str]:
    """Follow a conditioning link to the text behind it, keeping its role.

    ``_follow_text_link`` only succeeds when the sampler links *straight* at a
    ``CLIPTextEncode``. Real graphs rarely do: Impact Pack routes conditioning
    through ``ToBasicPipe`` → ``FromBasicPipe`` → the sampler's ``basic_pipe``,
    and encoder wrappers add more hops. This walks that chain.

    ``role`` ('positive' / 'negative') is carried through every hop and tried
    before any generic input, so a negative chain cannot cross into the
    positive branch of a node that carries both — which is the one way a
    generic graph walk produces confidently wrong metadata.
    """
    if depth >= _TEXT_TRACE_MAX_DEPTH or not _is_link(link):
        return None
    node_id = str(link[0])
    seen = set() if seen is None else seen
    if node_id in seen:
        return None
    seen.add(node_id)
    target = nodes.get(node_id)
    if not isinstance(target, Mapping):
        return None
    inputs = target.get("inputs") or {}

    text_fields = (*_TEXT_ROLE_FIELDS.get(role, ()), *_TEXT_LITERAL_FIELDS)
    for field in text_fields:
        value = inputs.get(field)
        if isinstance(value, str) and value.strip():
            return value

    # The same field names again, this time as links: a text field is very
    # often wired from a string node rather than typed in (``XYZ Multi Text
    # Replace.template`` ← a wildcard processor), and stopping at "it is not a
    # literal" is what left the positive prompt empty while the negative —
    # which happened to end at a plain string node — resolved fine.
    for field in (role, *text_fields, *_TEXT_PASSTHROUGH_FIELDS):
        nxt = inputs.get(field)
        if _is_link(nxt):
            found = _trace_prompt_text(nodes, nxt, role, depth + 1, seen)
            if found is not None:
                return found
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
            elif key == "steps":
                out["steps"] = value
            elif key == "sampler":
                out["sampler"] = value
            elif key == "scheduler":
                out["scheduler"] = value
            elif key == "model":
                out["model"] = value

    sampler = out.get("sampler")
    if sampler and not out.get("scheduler"):
        head, sched = split_sampler_scheduler(str(sampler))
        if sched is not None:
            out["sampler"] = head
            out["scheduler"] = sched
    return out


def _normalise_scheduler(text: str) -> str:
    return re.sub(r"[\s-]+", "_", text.strip().lower())


def split_sampler_scheduler(value: str) -> tuple[str, Optional[str]]:
    """Peel a trailing scheduler name off an A1111 ``Sampler:`` value.

    Returns ``(sampler, scheduler)``; ``scheduler`` is ``None`` when the value
    carries no recognisable one, in which case ``sampler`` comes back
    untouched.  The whole value is never consumed — a bare ``simple`` is a
    sampler name as far as we know, not a scheduler with nothing in front.

    The scheduler is returned **as written** (``SGM Uniform``, not
    ``sgm_uniform``): the writers' prettified spelling is lossy — Danbooru-
    Gallery's ``SaveImagePlus`` maps ``normal`` → ``Simple`` — so mapping back
    to ComfyUI's internal name would invent a value the file never stated.

    Also used to backfill rows indexed before this split existed, which is why
    it is public and takes the stored string rather than the chunk.
    """
    text = str(value).strip()
    if not text:
        return text, None
    words = text.split()
    # Longest tail first: ``SGM Uniform`` is two words, ``simple`` is one.
    for take in (2, 1):
        if take >= len(words):
            continue
        tail = " ".join(words[-take:])
        if _normalise_scheduler(tail) in _SCHEDULER_NAMES:
            return " ".join(words[:-take]), tail
    return text, None


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

    A variant is really TWO booleans — keep the workflow graph, keep the generation
    data — and these are their combinations (the UI shows them as two checkboxes):

      * ``no_workflow`` — drop the ComfyUI UI graph ``workflow``; keep generation data.
      * ``no_gen`` — drop the API ``prompt`` and A1111 ``parameters``; keep ``workflow``.
      * ``clean`` — drop all three, and the ``xyz_gallery.*`` chunks with them: asking
        for neither means asking for a bare raster, and our own tags have no business
        riding along on one.

    ``full`` is not handled here — the route serves the file untouched for it.

    Pixel data and all other ancillary chunks are preserved as Pillow allows.
    Raises:
        FileNotFoundError / ValueError / OSError — same family as
        :func:`write_xyz_chunks` for non-PNG or missing files.
    """
    v = str(variant or "").strip()
    if v not in ("no_workflow", "no_gen", "clean"):
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
            if v == "no_gen" and sk in (_KEY_PROMPT, _KEY_PARAMETERS):
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
