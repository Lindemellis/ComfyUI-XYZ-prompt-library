"""XYZ Image Gallery — video support: probing, container metadata, poster frames.

Everything video-specific that is *not* SQL, HTTP or Vue lives here, so the
rest of the gallery keeps talking about "media" and never imports PyAV.

Why PyAV and not an ``ffmpeg`` subprocess: ComfyUI itself depends on
``av>=16.0.0``, so it is already in the interpreter that runs this code —
whereas an ``ffmpeg`` binary is very often *not* on PATH (it is not on the
author's machine).  A hard dependency on a binary we cannot assume exists
would make the whole feature fail silently on a normal install.

Three jobs:

* :func:`probe` — dimensions, duration, fps, audio presence, codec.  The
  dimensions come from the **video stream**, not the container, and a
  display-matrix rotation of 90/270 swaps them (a phone-shot clip imported
  into the library reports 1920x1080 with rotate=90 but *displays* as
  1080x1920; the grid would letterbox it wrongly otherwise).
* :func:`read_container_metadata` — the ``workflow`` / ``prompt`` JSON that
  ComfyUI writes into the MP4 container.  It is byte-for-byte the same JSON
  it writes into a PNG ``tEXt`` chunk, which is why ``metadata.py`` can feed
  it straight into the existing ``_derive_from_workflow`` pipeline.
* :func:`extract_frame` — a poster frame for the thumbnailer.

Plus the *audio-twin* rule (:func:`superseded_by_audio_twin`): ComfyUI video
workflows habitually emit a silent ``X.mp4`` **and** a muxed ``X-audio.mp4``
for one generation.  Indexing both means every generation shows up twice in
the grid, and favouriting/deleting has to be done twice.  We keep the one
with sound.  The suffix list is configuration, not a constant, because it is
a convention of VideoHelperSuite / the MiniMax nodes, not of the format.

PyAV is imported lazily and defensively: the dev interpreter that runs pytest
has no ``av`` (same split as ``build_masks`` vs torch), and a gallery whose
video probing is unavailable must degrade to "no videos indexed", never to an
import-time crash that takes ComfyUI's startup with it.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, Optional, Sequence, Tuple

logger = logging.getLogger("xyz.gallery.video")

__all__ = [
    "VIDEO_EXTS",
    "DEFAULT_AUDIO_TWIN_SUFFIXES",
    "VideoProbe",
    "is_video_ext",
    "is_video_path",
    "media_kind_for_ext",
    "have_av",
    "probe",
    "read_container_metadata",
    "normalise_container_tags",
    "extract_frame",
    "audio_twin_suffixes_from_config",
    "superseded_by_audio_twin",
    "supersedes_paths",
]


#: Container extensions the gallery treats as video.  Deliberately narrow:
#: these are what ComfyUI's own savers emit (``.mp4`` / ``.webm``) plus the
#: handful a user is likely to drop into an output folder by hand.  ``.gif``
#: is **not** here — Pillow already indexes it as an image and re-classifying
#: it would silently move existing rows between the two filter checkboxes.
VIDEO_EXTS: frozenset = frozenset({".mp4", ".webm", ".mkv", ".mov", ".m4v"})

#: Suffixes marking "the same generation, but muxed with its audio track".
#: ``exp_00001.mp4`` + ``exp_00001-audio.mp4`` → only the latter is indexed.
DEFAULT_AUDIO_TWIN_SUFFIXES: Tuple[str, ...] = ("-audio",)

_MEDIA_KIND_IMAGE = "image"
_MEDIA_KIND_VIDEO = "video"

# Poster-frame position.  Never frame 0: generated clips very often open on
# black or a fade-in, which makes an entire grid page look empty.  10% in,
# capped at 1 s so a long clip still gets a frame from its opening beat.
_POSTER_FRACTION = 0.10
_POSTER_MAX_MS = 1000


def is_video_ext(ext: str) -> bool:
    """True for a video container extension, with or without the leading dot."""
    if not ext:
        return False
    e = str(ext).lower()
    if not e.startswith("."):
        e = "." + e
    return e in VIDEO_EXTS


def is_video_path(path: Any) -> bool:
    return is_video_ext(os.path.splitext(str(path))[1])


def media_kind_for_ext(ext: str) -> str:
    """``'video'`` for a video container, else ``'image'``.

    The fallback is ``'image'`` on purpose: it is what every row written
    before schema v8 is, so the column default and this function agree.
    """
    return _MEDIA_KIND_VIDEO if is_video_ext(ext) else _MEDIA_KIND_IMAGE


# -- PyAV access ------------------------------------------------------------

def _av():
    """Return the ``av`` module, or None when it is not importable."""
    try:
        import av  # noqa: PLC0415 — lazy on purpose (see module docstring)
    except Exception:  # ImportError, but a broken build can raise others
        return None
    return av


def have_av() -> bool:
    return _av() is not None


@dataclass(frozen=True)
class VideoProbe:
    """What one ``av.open`` tells us about a clip.  All fields optional —
    a partially-readable file yields what it can rather than nothing."""

    width: Optional[int] = None
    height: Optional[int] = None
    duration_ms: Optional[int] = None
    fps: Optional[float] = None
    has_audio: bool = False
    vcodec: Optional[str] = None


def _rotation_degrees(stream: Any) -> int:
    """Display rotation in degrees, normalised to 0/90/180/270.

    Two places carry it depending on the muxer and the ffmpeg version: the
    legacy ``rotate`` metadata tag, and a ``DISPLAYMATRIX`` side-data entry.
    Check both; a file that has neither is upright.
    """
    try:
        raw = stream.metadata.get("rotate")
        if raw is not None:
            return int(round(float(raw))) % 360
    except (AttributeError, TypeError, ValueError):
        pass
    try:
        for sd in getattr(stream, "side_data", None) or ():
            rot = getattr(sd, "rotation", None)
            if rot is not None:
                # DisplayMatrix.rotation is counter-clockwise; only the
                # axis-swap parity matters to us, so the sign is irrelevant.
                return int(round(float(rot))) % 360
    except (AttributeError, TypeError, ValueError):
        pass
    return 0


def _fps_of(stream: Any) -> Optional[float]:
    # ``average_rate`` is a Fraction and is the honest answer for a VFR
    # clip; ``base_rate`` / ``guessed_rate`` are the fallbacks.
    for attr in ("average_rate", "guessed_rate", "base_rate"):
        try:
            val = getattr(stream, attr, None)
            if val:
                f = float(val)
                if f > 0:
                    return round(f, 6)
        except (TypeError, ValueError, ZeroDivisionError):
            continue
    return None


def probe(path: Any) -> Optional[VideoProbe]:
    """Probe one video file.  Returns None when it cannot be opened at all."""
    av = _av()
    if av is None:
        return None
    try:
        with av.open(str(path)) as container:
            streams = container.streams
            vstreams = list(streams.video)
            has_audio = bool(list(streams.audio))
            duration_ms: Optional[int] = None
            if container.duration:
                # container.duration is in av.time_base (microsecond) units.
                duration_ms = int(round(container.duration / av.time_base * 1000))

            if not vstreams:
                # Audio-only in a video container: still a media file, but it
                # has no frame and no size.  Report what we know.
                return VideoProbe(
                    duration_ms=duration_ms, has_audio=has_audio,
                )

            v = vstreams[0]
            width = int(v.width) if v.width else None
            height = int(v.height) if v.height else None
            if _rotation_degrees(v) in (90, 270) and width and height:
                width, height = height, width

            if duration_ms is None and v.duration and v.time_base:
                duration_ms = int(round(float(v.duration * v.time_base) * 1000))

            vcodec = None
            try:
                vcodec = str(v.codec_context.name) or None
            except (AttributeError, ValueError):
                pass

            return VideoProbe(
                width=width,
                height=height,
                duration_ms=duration_ms,
                fps=_fps_of(v),
                has_audio=has_audio,
                vcodec=vcodec,
            )
    except Exception as exc:  # av raises a wide family; a bad file is not fatal
        logger.debug("video.probe failed for %s: %s", path, exc)
        return None


def read_container_metadata(path: Any) -> Optional[Dict[str, str]]:
    """Return the container's metadata tags, keyed like PNG text chunks.

    ComfyUI writes the very same ``workflow`` / ``prompt`` JSON it puts in a
    PNG, so the returned dict is a drop-in for ``metadata._open_png_text``.

    One normalisation: writers that predate the dedicated tags stash the graph
    in ``comment``.  We alias it — to ``workflow`` when it looks like JSON, to
    ``parameters`` otherwise (that is where an A1111-style text block belongs).
    Aliasing unconditionally would set ``has_workflow`` on a clip whose comment
    is prose.
    """
    av = _av()
    if av is None:
        return None
    try:
        with av.open(str(path)) as container:
            raw = dict(container.metadata or {})
    except Exception as exc:
        logger.debug("video.read_container_metadata failed for %s: %s", path, exc)
        return None

    return normalise_container_tags(raw)


def normalise_container_tags(raw: Dict[str, Any]) -> Dict[str, str]:
    """Container tags → PNG-text-chunk shape. Pure; split out so it is testable
    without an encoder to mux a fixture file with."""
    chunks: Dict[str, str] = {}
    for key, value in (raw or {}).items():
        if key is None or value is None:
            continue
        chunks[str(key).strip().lower()] = str(value)

    comment = chunks.get("comment")
    if comment:
        looks_json = comment.lstrip()[:1] in ("{", "[")
        target = "workflow" if looks_json else "parameters"
        chunks.setdefault(target, comment)
    return chunks


def _poster_offset_ms(duration_ms: Optional[int]) -> int:
    if not duration_ms or duration_ms <= 0:
        return 0
    return int(min(_POSTER_MAX_MS, duration_ms * _POSTER_FRACTION))


def extract_frame(path: Any, *, at_ms: Optional[int] = None):
    """Decode one frame as a PIL image, or None on any failure.

    ``at_ms=None`` picks the poster position (see ``_POSTER_FRACTION``).
    Seeking is best-effort: a container that will not seek falls back to
    decoding from the start, which is why the offset is deliberately small.
    """
    av = _av()
    if av is None:
        return None
    try:
        with av.open(str(path)) as container:
            vstreams = list(container.streams.video)
            if not vstreams:
                return None
            stream = vstreams[0]
            stream.thread_type = "AUTO"

            offset_ms = at_ms
            if offset_ms is None:
                duration_ms = None
                if container.duration:
                    duration_ms = int(round(container.duration / av.time_base * 1000))
                offset_ms = _poster_offset_ms(duration_ms)

            if offset_ms and stream.time_base:
                try:
                    ts = int((offset_ms / 1000.0) / float(stream.time_base))
                    container.seek(ts, stream=stream, any_frame=False, backward=True)
                except Exception:
                    # Unseekable: decoding from position 0 still yields a frame.
                    pass

            for frame in container.decode(stream):
                image = frame.to_image()
                rot = _rotation_degrees(stream)
                if rot:
                    # PIL rotates counter-clockwise; the display matrix is the
                    # transform to APPLY, so pass it through directly.
                    image = image.rotate(rot, expand=True)
                return image
    except Exception as exc:
        logger.debug("video.extract_frame failed for %s: %s", path, exc)
    return None


# -- the audio-twin rule ----------------------------------------------------

def audio_twin_suffixes_from_config(config_path: Any) -> Tuple[str, ...]:
    """Read ``video_audio_twin_suffixes`` from ``gallery_config.json``.

    Missing / unreadable / empty config → :data:`DEFAULT_AUDIO_TWIN_SUFFIXES`.
    An explicit empty list in the config means "index both files", which is a
    legitimate choice and must not be overridden by the default.
    """
    import json  # local: this is a cold path, once per scan

    try:
        p = Path(str(config_path))
        if not p.is_file():
            return DEFAULT_AUDIO_TWIN_SUFFIXES
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return DEFAULT_AUDIO_TWIN_SUFFIXES
    if not isinstance(data, dict) or "video_audio_twin_suffixes" not in data:
        return DEFAULT_AUDIO_TWIN_SUFFIXES
    raw = data.get("video_audio_twin_suffixes")
    if not isinstance(raw, (list, tuple)):
        return DEFAULT_AUDIO_TWIN_SUFFIXES
    return tuple(str(s) for s in raw if str(s).strip())


def superseded_by_audio_twin(
    abs_path: Any,
    *,
    suffixes: Optional[Sequence[str]] = None,
    exists: Optional[Any] = None,
) -> bool:
    """True when ``abs_path`` is the silent half of an ``X`` / ``X-audio`` pair.

    Only ever True for a video whose stem does **not** already carry the
    suffix, and only when the muxed sibling actually exists next to it with
    the same extension.  ``exists`` is injectable so the scan can answer from
    a directory listing it already has instead of hitting the filesystem
    once per candidate.
    """
    if not is_video_path(abs_path):
        return False
    sfx = DEFAULT_AUDIO_TWIN_SUFFIXES if suffixes is None else tuple(suffixes)
    if not sfx:
        return False

    p = Path(str(abs_path))
    stem, ext = p.stem, p.suffix
    check = exists if exists is not None else (lambda q: Path(q).is_file())
    for suffix in sfx:
        if not suffix:
            continue
        # The twin itself must never be skipped, or the pair vanishes entirely.
        if stem.casefold().endswith(suffix.casefold()):
            return False
    for suffix in sfx:
        if not suffix:
            continue
        twin = p.with_name(f"{stem}{suffix}{ext}")
        try:
            if check(str(twin)):
                return True
        except OSError:
            continue
    return False


def supersedes_paths(
    abs_path: Any, *, suffixes: Optional[Sequence[str]] = None,
) -> Tuple[str, ...]:
    """Paths that ``abs_path`` displaces by being the muxed half of a pair.

    The inverse of :func:`superseded_by_audio_twin`, and it exists because of
    write ORDER: ComfyUI emits the silent ``X.mp4`` first and muxes
    ``X-audio.mp4` afterwards, so the file watcher indexes the silent one
    before its twin exists.  Skipping at index time is therefore not enough —
    when the twin finally lands, the row already written for the silent file
    has to go, or the pair shows up twice forever.

    Returns absolute paths (they may not exist; the caller deletes by path
    and a no-op delete is fine).
    """
    if not is_video_path(abs_path):
        return ()
    sfx = DEFAULT_AUDIO_TWIN_SUFFIXES if suffixes is None else tuple(suffixes)
    p = Path(str(abs_path))
    stem, ext = p.stem, p.suffix
    out = []
    for suffix in sfx:
        if not suffix:
            continue
        if stem.casefold().endswith(suffix.casefold()):
            out.append(str(p.with_name(f"{stem[: -len(suffix)]}{ext}")))
    return tuple(out)


def iter_media_exts(image_exts: Iterable[str]) -> frozenset:
    """Union of the caller's image extensions and :data:`VIDEO_EXTS`."""
    return frozenset(set(image_exts) | set(VIDEO_EXTS))
