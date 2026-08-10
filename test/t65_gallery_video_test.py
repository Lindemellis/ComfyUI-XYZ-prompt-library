"""Gallery video support (schema v8) — the parts that are not PyAV.

The probe / frame-decode paths need ``av``, which lives in ComfyUI's
interpreter and not in the one pytest runs (same split as ``build_masks`` vs
torch, and ``geometry`` vs Krita). Those tests are guarded and skip cleanly.

Everything else here is pure and always runs:

    the audio-twin rule      — which half of an ``X`` / ``X-audio`` pair survives
    the schema v8 migration  — including that existing rows become 'image'
    the media_kind filter     — three states, and "neither" folding onto "all"

Run:
    pytest test/t65_gallery_video_test.py -v
"""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))

from gallery import db as _db  # noqa: E402
from gallery import repo as _repo  # noqa: E402
from gallery import video as _video  # noqa: E402


# ---------------------------------------------------------------------------
# extension classification
# ---------------------------------------------------------------------------

def test_video_extensions_are_recognised_with_or_without_the_dot():
    assert _video.is_video_ext(".mp4") and _video.is_video_ext("mp4")
    assert _video.is_video_ext(".MP4")
    assert not _video.is_video_ext(".png")
    assert not _video.is_video_ext("")


def test_gif_stays_an_image():
    # Pillow already indexes .gif; reclassifying it would silently move rows
    # that already exist between the two filter checkboxes.
    assert _video.media_kind_for_ext(".gif") == "image"
    assert _video.media_kind_for_ext(".webp") == "image"
    assert _video.media_kind_for_ext(".mp4") == "video"


# ---------------------------------------------------------------------------
# the audio-twin rule
# ---------------------------------------------------------------------------

def _fake_fs(*names):
    """An ``exists`` callback answering from a fixed set of basenames."""
    have = {n.casefold() for n in names}
    return lambda p: Path(p).name.casefold() in have


def test_the_silent_half_is_skipped_when_its_muxed_twin_exists():
    assert _video.superseded_by_audio_twin(
        r"C:\out\exp_00001.mp4",
        exists=_fake_fs("exp_00001.mp4", "exp_00001-audio.mp4"),
    )


def test_the_muxed_half_is_never_skipped():
    # If this ever returned True the pair would vanish from the gallery
    # entirely — both halves excluded, nothing left to show.
    assert not _video.superseded_by_audio_twin(
        r"C:\out\exp_00001-audio.mp4",
        exists=_fake_fs("exp_00001.mp4", "exp_00001-audio.mp4"),
    )


def test_a_lone_video_with_no_twin_is_kept():
    assert not _video.superseded_by_audio_twin(
        r"C:\out\exp_00001.mp4", exists=_fake_fs("exp_00001.mp4"),
    )


def test_a_png_is_never_touched_by_the_twin_rule():
    # The poster PNG that ships next to a clip is a legitimate image row.
    assert not _video.superseded_by_audio_twin(
        r"C:\out\exp_00001.png",
        exists=_fake_fs("exp_00001.png", "exp_00001-audio.mp4"),
    )


def test_the_twin_must_share_the_extension():
    # ``X.mp4`` is not superseded by ``X-audio.webm``: different container,
    # not the pair the rule is about.
    assert not _video.superseded_by_audio_twin(
        r"C:\out\exp_00001.mp4",
        exists=_fake_fs("exp_00001.mp4", "exp_00001-audio.webm"),
    )


def test_an_empty_suffix_list_indexes_both_halves():
    assert not _video.superseded_by_audio_twin(
        r"C:\out\exp_00001.mp4",
        suffixes=(),
        exists=_fake_fs("exp_00001.mp4", "exp_00001-audio.mp4"),
    )


def test_supersedes_paths_is_the_inverse_and_names_the_silent_file():
    got = _video.supersedes_paths(r"C:\out\exp_00001-audio.mp4")
    assert [Path(p).name for p in got] == ["exp_00001.mp4"]
    # The silent file supersedes nothing — only the muxed one displaces.
    assert _video.supersedes_paths(r"C:\out\exp_00001.mp4") == ()


def test_config_overrides_the_suffix_list(tmp_path):
    cfg = tmp_path / "gallery_config.json"
    assert _video.audio_twin_suffixes_from_config(cfg) == \
        _video.DEFAULT_AUDIO_TWIN_SUFFIXES  # missing file → default

    cfg.write_text(json.dumps({"video_audio_twin_suffixes": ["-snd", "_a"]}),
                   encoding="utf-8")
    assert _video.audio_twin_suffixes_from_config(cfg) == ("-snd", "_a")

    # An explicit empty list is a real choice ("index both"), not a missing
    # value to be replaced by the default.
    cfg.write_text(json.dumps({"video_audio_twin_suffixes": []}), encoding="utf-8")
    assert _video.audio_twin_suffixes_from_config(cfg) == ()

    cfg.write_text("{not json", encoding="utf-8")
    assert _video.audio_twin_suffixes_from_config(cfg) == \
        _video.DEFAULT_AUDIO_TWIN_SUFFIXES


# ---------------------------------------------------------------------------
# schema v8
# ---------------------------------------------------------------------------

def _fresh_db(tmp_path) -> Path:
    p = tmp_path / "gallery.sqlite"
    conn = sqlite3.connect(str(p))
    try:
        _db.migrate(conn)
        conn.commit()
    finally:
        conn.close()
    return p


def test_v8_adds_the_media_columns_and_the_index(tmp_path):
    conn = sqlite3.connect(str(_fresh_db(tmp_path)))
    try:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(image)")}
        assert {"media_kind", "duration_ms", "fps", "has_audio", "vcodec"} <= cols
        idx = {r[1] for r in conn.execute("PRAGMA index_list(image)")}
        assert "idx_image_media_kind" in idx
        assert conn.execute("PRAGMA user_version").fetchone()[0] == _db.SCHEMA_VERSION
    finally:
        conn.close()


def test_a_row_written_without_media_kind_defaults_to_image(tmp_path):
    """The v8 default is not a guess: every row that predates the migration
    was indexed under an image-only extension whitelist."""
    conn = sqlite3.connect(str(_fresh_db(tmp_path)))
    try:
        conn.execute(
            "INSERT INTO image (path, relative_path, filename, filename_lc, ext) "
            "VALUES ('/a/b.png', 'b.png', 'b.png', 'b.png', 'png')"
        )
        got = conn.execute("SELECT media_kind FROM image").fetchone()[0]
        assert got == "image"
    finally:
        conn.close()


def test_migration_is_rerunnable(tmp_path):
    # Forcing user_version back is how the project's own DDL comments say the
    # guards get exercised; a second pass must not raise on duplicate columns.
    p = _fresh_db(tmp_path)
    conn = sqlite3.connect(str(p))
    try:
        conn.execute("PRAGMA user_version = 7")
        conn.commit()
        _db.migrate(conn)
        conn.commit()
        cols = {r[1] for r in conn.execute("PRAGMA table_info(image)")}
        assert "media_kind" in cols
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# the media_kind filter
# ---------------------------------------------------------------------------

def test_filterspec_accepts_the_three_states_and_defaults_to_all():
    assert _repo.FilterSpec().media_kind == "all"
    for v in ("all", "image", "video"):
        assert _repo.FilterSpec(media_kind=v).media_kind == v


def test_filterspec_rejects_anything_else():
    with pytest.raises(ValueError):
        _repo.FilterSpec(media_kind="movies")


def _kinds_returned(db_path, media_kind):
    page = _repo.list_images(
        db_path=db_path,
        filter=_repo.FilterSpec(media_kind=media_kind),
        sort=_repo.SortSpec(key="name", dir="asc"),
        limit=50,
    )
    return sorted(r.filename for r in page.items)


def test_the_filter_selects_by_media_kind(tmp_path):
    p = _fresh_db(tmp_path)
    conn = sqlite3.connect(str(p))
    try:
        conn.execute(
            "INSERT INTO folder (id, path, kind, display_name, removable) "
            "VALUES (1, '/root', 'output', 'root', 0)"
        )
        for name, ext, kind in (
            ("a.png", "png", "image"),
            ("b.mp4", "mp4", "video"),
            ("c.jpg", "jpg", "image"),
        ):
            conn.execute(
                "INSERT INTO image (path, folder_id, relative_path, filename, "
                "filename_lc, ext, media_kind) VALUES (?, 1, ?, ?, ?, ?, ?)",
                (f"/root/{name}", name, name, name.lower(), ext, kind),
            )
        conn.commit()
    finally:
        conn.close()

    assert _kinds_returned(p, "all") == ["a.png", "b.mp4", "c.jpg"]
    assert _kinds_returned(p, "image") == ["a.png", "c.jpg"]
    assert _kinds_returned(p, "video") == ["b.mp4"]


# ---------------------------------------------------------------------------
# container tags → PNG-chunk shape
# ---------------------------------------------------------------------------

def test_comfy_tags_pass_through_untouched():
    # ComfyUI writes the same JSON into an MP4 that it writes into a PNG, which
    # is the whole reason metadata.py can share one derivation pipeline.
    out = _video.normalise_container_tags(
        {"workflow": '{"nodes": []}', "prompt": '{"1": {}}', "encoder": "Lavf61"},
    )
    assert out["workflow"] == '{"nodes": []}'
    assert out["prompt"] == '{"1": {}}'


def test_keys_are_lowercased():
    assert _video.normalise_container_tags({"WorkFlow": "{}"})["workflow"] == "{}"


def test_a_json_comment_is_aliased_onto_workflow():
    out = _video.normalise_container_tags({"comment": ' {"nodes": []}'})
    assert out["workflow"] == ' {"nodes": []}'
    assert "parameters" not in out


def test_a_prose_comment_is_aliased_onto_parameters_not_workflow():
    # Aliasing unconditionally would set has_workflow on a clip whose comment
    # is just a sentence, and the detail page would claim a graph it has not got.
    out = _video.normalise_container_tags({"comment": "rendered on the 4060"})
    assert out["parameters"] == "rendered on the 4060"
    assert "workflow" not in out


def test_a_real_workflow_tag_beats_the_comment_alias():
    out = _video.normalise_container_tags(
        {"workflow": '{"real": 1}', "comment": '{"other": 2}'},
    )
    assert out["workflow"] == '{"real": 1}'


# ---------------------------------------------------------------------------
# PyAV-dependent — skipped where ``av`` is not installed
# ---------------------------------------------------------------------------

requires_av = pytest.mark.skipif(
    not _video.have_av(), reason="PyAV lives in ComfyUI's interpreter, not this one",
)


@requires_av
def test_probe_returns_nothing_for_a_file_that_is_not_a_video(tmp_path):
    junk = tmp_path / "not-a-clip.mp4"
    junk.write_bytes(b"definitely not an mp4")
    assert _video.probe(junk) is None


@requires_av
def test_extract_frame_survives_a_corrupt_file(tmp_path):
    junk = tmp_path / "broken.mp4"
    junk.write_bytes(b"\x00" * 512)
    assert _video.extract_frame(junk) is None


def test_probe_degrades_quietly_when_pyav_is_absent(tmp_path, monkeypatch):
    """No ``av`` must mean "no videos indexed", never an import-time crash that
    takes ComfyUI's startup down with it."""
    monkeypatch.setattr(_video, "_av", lambda: None)
    clip = tmp_path / "x.mp4"
    clip.write_bytes(b"whatever")
    assert _video.probe(clip) is None
    assert _video.read_container_metadata(clip) is None
    assert _video.extract_frame(clip) is None
