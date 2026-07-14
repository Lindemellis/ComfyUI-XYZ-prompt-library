# T60 — Krita bridge, the parts that run without Krita
#
# The HTTP round-trip needs a running Krita, so it is not tested here. What IS
# tested is everything that silently broke on the way in: the combo <-> layer-id
# encoding, the resize maths, and the kritarc edit (which cost the most time — see
# `installer.kritarc_path`).
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from krita_nodes import installer  # noqa: E402
from krita_nodes.nodes import (  # noqa: E402
    DOCUMENT_ENTRY,
    _round_to,
    combo_entry,
    layer_key,
    short_id,
)

UUID = "{9c742cc6-3913-4c4e-9eed-36182fcefb8e}"


# --------------------------------------------------------- combo <-> layer id


def test_short_id_strips_braces_and_dashes():
    assert short_id(UUID) == "9c742cc6"


def test_combo_entry_round_trips_through_layer_key():
    entry = combo_entry({"id": UUID, "name": "sketch"})
    assert entry == "9c742cc6: sketch"
    assert layer_key(entry) == "9c742cc6"


def test_a_layer_name_containing_a_colon_still_parses():
    # The id comes FIRST for exactly this reason — a name may contain anything.
    entry = combo_entry({"id": UUID, "name": "wip: v2 (final)"})
    assert layer_key(entry) == "9c742cc6"


def test_a_cjk_layer_name_survives():
    entry = combo_entry({"id": UUID, "name": "背景"})
    assert entry == "9c742cc6: 背景"
    assert layer_key(entry) == "9c742cc6"


def test_document_entry_reduces_to_the_document_keyword():
    # ops.export_image() keys off exactly this word.
    assert layer_key(DOCUMENT_ENTRY) == "document"


def test_layer_key_of_junk_is_empty():
    assert layer_key("") == ""
    assert layer_key(None) == ""


# ---------------------------------------------------------------- resize maths


def test_round_to_snaps_to_a_multiple():
    assert _round_to(1216, 8) == 1216
    assert _round_to(869.3, 8) == 872
    assert _round_to(333, 8) == 336


def test_round_to_never_returns_zero():
    # A degenerate layer must not produce a 0-px side (ComfyUI would throw).
    assert _round_to(0, 8) == 8
    assert _round_to(1, 64) == 64


def test_round_to_one_is_a_no_op():
    assert _round_to(867, 1) == 867


def test_by_height_keeps_the_aspect_ratio():
    # 640x896 by_height=1216 -> 872x1216, which is what the live Krita returned.
    width, height = 640, 896
    target_h = _round_to(1216, 8)
    target_w = _round_to(1216 * width / height, 8)
    assert (target_w, target_h) == (872, 1216)
    assert abs(target_w / target_h - width / height) < 0.005


# -------------------------------------------------------------------- kritarc


def _rc(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "kritarc"
    path.write_text(body, encoding="utf-8")
    return path


def _enable(monkeypatch, path: Path) -> str:
    monkeypatch.setattr(installer, "kritarc_path", lambda: path)
    assert installer._enable_in_kritarc() is True
    return path.read_text(encoding="utf-8")


def test_kritarc_path_is_not_next_to_pykrita(monkeypatch):
    # The bug that cost an hour: pykrita is under APPDATA (Roaming) but kritarc
    # lives in LOCALAPPDATA, with no `krita/` folder. Writing the flag next to
    # pykrita creates a file Krita never reads.
    if sys.platform != "win32":
        pytest.skip("windows layout")
    monkeypatch.setenv("APPDATA", r"C:\Users\x\AppData\Roaming")
    monkeypatch.setenv("LOCALAPPDATA", r"C:\Users\x\AppData\Local")
    assert installer.pykrita_dir() == Path(r"C:\Users\x\AppData\Roaming\krita\pykrita")
    assert installer.kritarc_path() == Path(r"C:\Users\x\AppData\Local\kritarc")
    assert installer.kritarc_path() != installer.pykrita_dir().parent / "kritarc"


def test_enable_adds_the_key_to_an_existing_python_section(monkeypatch, tmp_path):
    out = _enable(
        monkeypatch,
        _rc(tmp_path, "[general]\nfoo=1\n\n[python]\nenable_other=true\n\n[tail]\nz=9\n"),
    )
    assert "enable_xyz_comfy=true" in out
    # ...inside [python], not after [tail].
    python_block = out.split("[python]")[1].split("[tail]")[0]
    assert "enable_xyz_comfy=true" in python_block
    # and it must not disturb another plugin
    assert "enable_other=true" in out


def test_enable_creates_the_python_section_when_there_is_none(monkeypatch, tmp_path):
    out = _enable(monkeypatch, _rc(tmp_path, "[general]\nfoo=1\n"))
    assert "[python]" in out
    assert out.index("[python]") < out.index("enable_xyz_comfy=true")
    assert "foo=1" in out


def test_enable_is_idempotent(monkeypatch, tmp_path):
    path = _rc(tmp_path, "[python]\nenable_xyz_comfy=true\n")
    out = _enable(monkeypatch, path)
    assert out.count("enable_xyz_comfy=true") == 1


def test_enable_flips_a_disabled_flag(monkeypatch, tmp_path):
    out = _enable(monkeypatch, _rc(tmp_path, "[python]\nenable_xyz_comfy=false\n"))
    assert "enable_xyz_comfy=true" in out
    assert "enable_xyz_comfy=false" not in out


def test_enable_handles_a_python_section_at_end_of_file(monkeypatch, tmp_path):
    out = _enable(monkeypatch, _rc(tmp_path, "[general]\nfoo=1\n[python]\nenable_a=true\n"))
    assert out.rstrip().endswith("enable_xyz_comfy=true")
    assert out.count("[python]") == 1


def test_enable_creates_the_file_when_it_does_not_exist(monkeypatch, tmp_path):
    path = tmp_path / "nested" / "kritarc"
    monkeypatch.setattr(installer, "kritarc_path", lambda: path)
    assert installer._enable_in_kritarc() is True
    assert "[python]" in path.read_text(encoding="utf-8")


# ------------------------------------------------------- error-message hygiene
# The plugin echoes the layer id back in its errors. That id is caller-supplied,
# so it must not go back unbounded or with control characters in it. `_short`
# lives in the plugin (which imports krita/PyQt5 and cannot be imported here), so
# this pins the CONTRACT the plugin's copy has to keep.


def _short(text: str, limit: int = 40) -> str:
    text = "".join(c if c.isprintable() else "?" for c in text)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def test_a_long_layer_id_is_truncated_in_an_error():
    assert len(_short("a" * 1000)) == 40


def test_control_characters_never_reach_an_error_message():
    assert _short("a\x00\x01b") == "a??b"


def test_a_normal_id_is_untouched():
    assert _short("9c742cc6") == "9c742cc6"


# --------------------------------------------------------------- the launcher


def test_a_saved_executable_path_wins(monkeypatch, tmp_path):
    from krita_nodes import launcher

    exe = tmp_path / "krita.exe"
    exe.write_text("")
    monkeypatch.setattr(launcher, "SETTINGS", tmp_path / "settings.json")
    monkeypatch.setattr(launcher, "DATA_DIR", tmp_path)

    launcher.set_executable(str(exe))
    assert launcher.find_executable() == str(exe)


def test_setting_a_path_that_is_not_a_file_is_refused(monkeypatch, tmp_path):
    from krita_nodes import launcher

    monkeypatch.setattr(launcher, "SETTINGS", tmp_path / "settings.json")
    monkeypatch.setattr(launcher, "DATA_DIR", tmp_path)
    with pytest.raises(launcher.KritaNotFound):
        launcher.set_executable(str(tmp_path / "nope.exe"))


def test_the_environment_overrides_when_nothing_is_saved(monkeypatch, tmp_path):
    from krita_nodes import launcher

    exe = tmp_path / "krita-from-env.exe"
    exe.write_text("")
    monkeypatch.setattr(launcher, "SETTINGS", tmp_path / "missing.json")
    monkeypatch.setenv("XYZ_KRITA_EXE", str(exe))
    monkeypatch.setattr(launcher.shutil, "which", lambda _: None)
    assert launcher.find_executable() == str(exe)


def test_wait_for_plugin_gives_up_instead_of_hanging(monkeypatch):
    from krita_nodes import client, launcher

    def never(*_, **__):
        raise client.KritaUnreachable("nope")

    monkeypatch.setattr(client, "ping", never)
    # Bounded, always: a launch that never comes up must fail, not block forever.
    assert launcher.wait_for_plugin(timeout=0.1) is None
