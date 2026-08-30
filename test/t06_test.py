"""T06 metadata extraction tests using only synthetic local files."""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image
from PIL.PngImagePlugin import PngInfo

from gallery.metadata import ComfyMeta, read_comfy_metadata


def _comfy_png(path: Path) -> None:
    prompt = {
        "1": {
            "class_type": "KSampler",
            "inputs": {
                "seed": 12345,
                "steps": 20,
                "cfg": 7.0,
                "sampler_name": "euler",
                "scheduler": "normal",
                "positive": ["2", 0],
                "negative": ["3", 0],
                "model": ["4", 0],
            },
        },
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": "a cat"}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "blurry"}},
        "4": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": "sd15.ckpt"},
        },
    }
    info = PngInfo()
    info.add_text("prompt", json.dumps(prompt))
    info.add_text("workflow", json.dumps({"nodes": [], "links": []}))
    Image.new("RGB", (8, 8), "black").save(path, pnginfo=info)


def test_comfy_png_metadata(tmp_path: Path) -> None:
    path = tmp_path / "comfy.png"
    _comfy_png(path)
    meta = read_comfy_metadata(path)
    assert meta.errors == ()
    assert meta.has_workflow is True
    assert meta.positive_prompt == "a cat"
    assert meta.negative_prompt == "blurry"
    assert meta.model == "sd15.ckpt"
    assert meta.seed == 12345
    assert meta.steps == 20


def test_a1111_parameters_metadata(tmp_path: Path) -> None:
    info = PngInfo()
    info.add_text(
        "parameters",
        "beautiful sunset over the sea\n"
        "Negative prompt: ugly, blurry\n"
        "Steps: 20, Sampler: Euler a, CFG scale: 7, Seed: 12345, Model: sd15_foo",
    )
    path = tmp_path / "a1111.png"
    Image.new("RGB", (8, 8), "black").save(path, pnginfo=info)
    meta = read_comfy_metadata(path)
    assert meta.positive_prompt == "beautiful sunset over the sea"
    assert meta.negative_prompt == "ugly, blurry"
    assert meta.seed == 12345 and meta.cfg == 7.0
    assert meta.sampler == "Euler a" and meta.model == "sd15_foo"
    assert meta.has_workflow is False


def test_plain_jpeg_is_safe_and_empty(tmp_path: Path) -> None:
    path = tmp_path / "plain.jpg"
    Image.new("RGB", (8, 8), "white").save(path)
    meta = read_comfy_metadata(path)
    assert isinstance(meta, ComfyMeta)
    assert meta.positive_prompt is None
    assert meta.has_workflow is False


def test_corrupt_and_missing_files_report_errors(tmp_path: Path) -> None:
    corrupt = tmp_path / "bad.png"
    corrupt.write_bytes(b"\x89PNG\r\n\x1a\n_garbage_")
    assert read_comfy_metadata(corrupt).errors

    missing = tmp_path / "missing.png"
    meta = read_comfy_metadata(missing)
    assert meta.errors and "file not found" in meta.errors[0]


def test_metadata_read_is_deterministic(tmp_path: Path) -> None:
    path = tmp_path / "comfy.png"
    _comfy_png(path)
    first = read_comfy_metadata(path)
    second = read_comfy_metadata(path)
    assert first == second
    assert hash(first) == hash(second)
