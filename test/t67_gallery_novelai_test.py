"""NovelAI native PNG metadata → Gallery detail contract."""

from __future__ import annotations

import json
import time
from pathlib import Path

import gallery
from PIL import Image
from PIL.PngImagePlugin import PngInfo

from gallery import db, repo, service
from gallery.metadata import read_comfy_metadata
from gallery.routes import _serialize_image


def _novelai_v5_png(path: Path) -> None:
    positive_characters = [
        {"char_caption": "red hair, green eyes", "centers": [{"x": 0.25, "y": 0.4}]},
        {"char_caption": "black hair, blue eyes", "centers": [{"x": 0.75, "y": 0.4}]},
    ]
    negative_characters = [
        {"char_caption": "hat", "centers": [{"x": 0.25, "y": 0.4}]},
        {"char_caption": "glasses", "centers": [{"x": 0.75, "y": 0.4}]},
    ]
    comment = {
        "model_name": "NovelAI Diffusion V5",
        "prompt": "2girls, outdoors",
        "uc": "lowres, blurry",
        "seed": 987654321,
        "steps": 28,
        "scale": 5.0,
        "sampler": "k_euler",
        "noise_schedule": "native",
        "v4_prompt": {
            "caption": {
                "base_caption": "2girls, outdoors",
                "char_captions": positive_characters,
            },
            "use_coords": True,
            "use_order": True,
            "legacy_uc": False,
        },
        "v4_negative_prompt": {
            "caption": {
                "base_caption": "lowres, blurry",
                "char_captions": negative_characters,
            },
            "use_coords": True,
            "use_order": True,
            "legacy_uc": False,
        },
    }
    info = PngInfo()
    info.add_text("Software", "NovelAI")
    info.add_text("Source", "NovelAI Diffusion V5 0ADF9AB7")
    info.add_text("Title", "AI generated image")
    info.add_text("Description", "2girls, outdoors")
    info.add_text("Comment", json.dumps(comment))
    Image.new("RGB", (16, 16), "white").save(path, pnginfo=info)


def test_novelai_v5_scalars_and_character_pairs(tmp_path: Path) -> None:
    path = tmp_path / "novelai-v5.png"
    _novelai_v5_png(path)

    meta = read_comfy_metadata(path)

    assert meta.errors == ()
    assert meta.model == "NovelAI Diffusion V5"
    assert meta.seed == 987654321
    assert meta.steps == 28
    assert meta.cfg == 5.0
    assert meta.sampler == "k_euler"
    assert meta.scheduler == "native"
    assert meta.positive_prompt == "2girls, outdoors"
    assert meta.negative_prompt == "lowres, blurry"
    assert meta.has_workflow is False

    generation = json.loads(meta.generation_data_json or "null")
    assert generation["provider"] == "novelai"
    assert generation["positive"] == {"use_coords": True, "use_order": True}
    assert generation["negative"] == {"use_coords": True, "use_order": True}
    assert generation["characters"] == [
        {
            "index": 1,
            "positive_prompt": "red hair, green eyes",
            "negative_prompt": "hat",
            "centers": [{"x": 0.25, "y": 0.4}],
        },
        {
            "index": 2,
            "positive_prompt": "black hair, blue eyes",
            "negative_prompt": "glasses",
            "centers": [{"x": 0.75, "y": 0.4}],
        },
    ]


def test_novelai_description_and_source_are_safe_fallbacks(tmp_path: Path) -> None:
    path = tmp_path / "novelai-legacy.png"
    info = PngInfo()
    info.add_text("Software", "NovelAI")
    info.add_text("Source", "NovelAI Diffusion V5 ABCDEF12")
    info.add_text("Description", "solo, portrait")
    info.add_text("Comment", json.dumps({"seed": 4, "uc": "bad anatomy"}))
    Image.new("RGB", (8, 8), "black").save(path, pnginfo=info)

    meta = read_comfy_metadata(path)
    assert meta.model == "NovelAI Diffusion V5"
    assert meta.positive_prompt == "solo, portrait"
    assert meta.negative_prompt == "bad anatomy"
    assert json.loads(meta.generation_data_json or "null")["characters"] == []


def test_generation_json_survives_database_and_detail_wire(tmp_path: Path) -> None:
    image_path = tmp_path / "novelai-v5.png"
    _novelai_v5_png(image_path)
    meta = read_comfy_metadata(image_path)
    db_path = tmp_path / "gallery.sqlite"
    conn = db.connect_write(db_path)
    try:
        db.migrate(conn)
        columns = {row[1] for row in conn.execute("PRAGMA table_info(image)")}
        assert "generation_data_json" in columns
        root_path = tmp_path.resolve().as_posix()
        conn.execute(
            "INSERT INTO folder(path, kind, display_name, removable) VALUES (?, ?, ?, ?)",
            (root_path, "output", "output", 0),
        )
        folder_id = int(conn.execute("SELECT id FROM folder").fetchone()[0])
        op = repo.UpsertImageOp(
            path=image_path.resolve().as_posix(),
            folder_id=folder_id,
            root_path=root_path,
            root_kind="output",
            relative_path=image_path.name,
            filename=image_path.name,
            filename_lc=image_path.name.lower(),
            ext="png",
            width=16,
            height=16,
            file_size=image_path.stat().st_size,
            mtime_ns=image_path.stat().st_mtime_ns,
            created_at=1,
            positive_prompt=meta.positive_prompt,
            negative_prompt=meta.negative_prompt,
            model=meta.model,
            seed=meta.seed,
            cfg=meta.cfg,
            steps=meta.steps,
            sampler=meta.sampler,
            scheduler=meta.scheduler,
            workflow_present=0,
            favorite=0,
            tags_csv=None,
            indexed_at=1,
            generation_data_json=meta.generation_data_json,
        )
        op.apply(conn)
        conn.execute(
            "INSERT INTO image(path, folder_id, relative_path, filename, filename_lc, ext, "
            "media_kind, workflow_present, favorite, indexed_at) "
            "VALUES (?, ?, ?, ?, ?, 'png', 'image', 0, 0, 1)",
            (
                (tmp_path / "legacy-novelai.png").resolve().as_posix(),
                folder_id,
                "legacy-novelai.png",
                "legacy-novelai.png",
                "legacy-novelai.png",
            ),
        )
        conn.commit()
    finally:
        conn.close()

    assert repo.count_missing_steps(db_path=db_path) == 1
    record = repo.get_image(db_path=db_path, image_id=1)
    assert record is not None
    detail = _serialize_image(record)
    assert detail["metadata"]["generation"]["provider"] == "novelai"
    assert len(detail["metadata"]["generation"]["characters"]) == 2


def test_detail_frontend_has_novelai_structure() -> None:
    root = Path(__file__).resolve().parent.parent
    body = (root / "js" / "gallery_dist" / "views" / "DetailView.js").read_text(
        encoding="utf-8"
    )
    css = (root / "js" / "gallery_dist" / "index.html").read_text(encoding="utf-8")
    assert "NovelAI data" in body
    assert "novelAICharacters" in body
    assert "Character prompts" in body
    assert "character.positive_prompt" in body
    assert "character.negative_prompt" in body
    assert "joinNovelAIPromptParts" in body
    assert "novelAICombinedPositive" in body
    assert "novelAICombinedNegative" in body
    assert "General + all characters" in body
    assert "Copy positive" in body
    assert "Copy negative" in body
    assert ".dv-nai-character" in css
    assert ".dv-nai-combined-buttons" in css


def test_missing_metadata_reread_forces_index_without_touching_png(tmp_path: Path) -> None:
    image_path = tmp_path / "NAI_autosave_00001_.png"
    _novelai_v5_png(image_path)
    original_bytes = image_path.read_bytes()
    original_mtime = image_path.stat().st_mtime_ns
    db_path = tmp_path / "gallery.sqlite"
    conn = db.connect_write(db_path)
    try:
        db.migrate(conn)
        root_path = tmp_path.resolve().as_posix()
        conn.execute(
            "INSERT INTO folder(path, kind, display_name, removable) VALUES (?, ?, ?, ?)",
            (root_path, "output", "output", 0),
        )
        folder_id = int(conn.execute("SELECT id FROM folder").fetchone()[0])
        stat = image_path.stat()
        conn.execute(
            "INSERT INTO image(path, folder_id, relative_path, filename, filename_lc, ext, "
            "media_kind, file_size, mtime_ns, created_at, workflow_present, favorite, "
            "indexed_at) VALUES (?, ?, ?, ?, ?, 'png', 'image', ?, ?, 1, 0, 0, 1)",
            (
                image_path.resolve().as_posix(),
                folder_id,
                image_path.name,
                image_path.name,
                image_path.name.lower(),
                stat.st_size,
                stat.st_mtime_ns,
            ),
        )
        conn.commit()
    finally:
        conn.close()

    queue = repo.WriteQueue(db_path)
    queue.start()
    gallery._write_queue = queue
    try:
        result = service.backfill_missing_steps(db_path=db_path)
        deadline = time.monotonic() + 5.0
        while repo.count_missing_steps(db_path=db_path) and time.monotonic() < deadline:
            time.sleep(0.01)
    finally:
        assert queue.stop(timeout=2.0)
        gallery._write_queue = None

    assert result == {"queued": 1, "missing": 1}
    assert repo.count_missing_steps(db_path=db_path) == 0
    record = repo.get_image(db_path=db_path, image_id=1)
    assert record is not None
    assert record.model == "NovelAI Diffusion V5"
    assert record.seed == 987654321
    detail = _serialize_image(record)
    assert detail["metadata"]["generation"]["provider"] == "novelai"
    assert len(detail["metadata"]["generation"]["characters"]) == 2
    assert image_path.read_bytes() == original_bytes
    assert image_path.stat().st_mtime_ns == original_mtime


def test_save_image_plus_ui_workflow_recovers_naidgenerator_metadata(
    tmp_path: Path,
) -> None:
    """SaveImagePlus drops native NAI chunks but keeps the UI workflow graph."""
    path = tmp_path / "save-image-plus-nai.png"
    workflow = {
        "nodes": [
            {
                "id": 1,
                "type": "XYZ Prompt Library V3 Monaco",
                "inputs": [],
                "outputs": [{"name": "prompt", "type": "STRING", "links": [1]}],
                "widgets_values": ["scene, (focus:1.2)"],
            },
            {
                "id": 2,
                "type": "PromptToNAID",
                "inputs": [{"name": "text", "type": "STRING", "link": 1}],
                "outputs": [{"name": "STRING", "type": "STRING", "links": [2]}],
                "widgets_values": [0.05, "numeric"],
            },
            {
                "id": 3,
                "type": "SetNode",
                "inputs": [{"name": "STRING", "type": "STRING", "link": 2}],
                "outputs": [{"name": "STRING", "type": "STRING", "links": None}],
                "widgets_values": ["positive-prompt"],
            },
            {
                "id": 4,
                "type": "GetNode",
                "inputs": [],
                "outputs": [{"name": "STRING", "type": "STRING", "links": [3]}],
                "widgets_values": ["positive-prompt"],
            },
            {
                "id": 5,
                "type": "XYZ Prompt Library V3 Monaco",
                "inputs": [],
                "outputs": [{"name": "prompt", "type": "STRING", "links": [4]}],
                "widgets_values": ["lowres, blurry"],
            },
            {
                "id": 10,
                "type": "ModelOptionNAID",
                "inputs": [{"name": "option", "type": "NAID_OPTION", "link": None}],
                "outputs": [{"name": "NAID_OPTION", "type": "NAID_OPTION", "links": [5]}],
                "widgets_values": ["nai-diffusion-5-full"],
            },
            {
                "id": 11,
                "type": "CharacterPromptOptionNAID",
                "inputs": [
                    {"name": "option", "type": "NAID_OPTION", "link": 5},
                    {"name": "positive", "type": "STRING", "link": 6},
                    {"name": "negative", "type": "STRING", "link": 7},
                ],
                "outputs": [{"name": "NAID_OPTION", "type": "NAID_OPTION", "links": [8]}],
                "widgets_values": ["", "", True, 0.25, 0.4, True],
            },
            {
                "id": 12,
                "type": "CharacterPromptOptionNAID",
                "inputs": [
                    {"name": "option", "type": "NAID_OPTION", "link": 8},
                    {"name": "positive", "type": "STRING", "link": 9},
                    {"name": "negative", "type": "STRING", "link": 10},
                ],
                "outputs": [{"name": "NAID_OPTION", "type": "NAID_OPTION", "links": [11]}],
                "widgets_values": ["", "", False, 0.75, 0.4, False],
            },
            {
                "id": 13,
                "type": "SetNode",
                "inputs": [{"name": "NAID_OPTION", "type": "NAID_OPTION", "link": 11}],
                "outputs": [{"name": "NAID_OPTION", "type": "NAID_OPTION", "links": None}],
                "widgets_values": ["final-nai-options"],
            },
            {
                "id": 14,
                "type": "GetNode",
                "inputs": [],
                "outputs": [{"name": "NAID_OPTION", "type": "NAID_OPTION", "links": [12]}],
                "widgets_values": ["final-nai-options"],
            },
            {
                "id": 20,
                "type": "StringLiteral",
                "inputs": [],
                "outputs": [{"name": "STRING", "type": "STRING", "links": [6]}],
                "widgets_values": ["red hair, green eyes"],
            },
            {
                "id": 21,
                "type": "StringLiteral",
                "inputs": [],
                "outputs": [{"name": "STRING", "type": "STRING", "links": [7]}],
                "widgets_values": ["hat"],
            },
            {
                "id": 22,
                "type": "StringLiteral",
                "inputs": [],
                "outputs": [{"name": "STRING", "type": "STRING", "links": [9]}],
                "widgets_values": ["black hair, blue eyes"],
            },
            {
                "id": 23,
                "type": "StringLiteral",
                "inputs": [],
                "outputs": [{"name": "STRING", "type": "STRING", "links": [10]}],
                "widgets_values": ["glasses"],
            },
            {
                "id": 99,
                "type": "GenerateNAID",
                "inputs": [
                    {"name": "option", "type": "NAID_OPTION", "link": 12},
                    {"name": "positive", "type": "STRING", "link": 3},
                    {"name": "negative", "type": "STRING", "link": 4},
                ],
                "outputs": [{"name": "IMAGE", "type": "IMAGE", "links": None}],
                "widgets_values": [
                    True,
                    832,
                    1216,
                    "unused positive widget",
                    "unused negative widget",
                    28,
                    7.0,
                    False,
                    False,
                    "none",
                    "k_euler_ancestral",
                    "native",
                    6174591079,
                    "randomize",
                    1.0,
                    0.0,
                    True,
                ],
            },
        ],
        "links": [
            [1, 1, 0, 2, 0, "STRING"],
            [2, 2, 0, 3, 0, "STRING"],
            [3, 4, 0, 99, 3, "STRING"],
            [4, 5, 0, 99, 4, "STRING"],
            [5, 10, 0, 11, 0, "NAID_OPTION"],
            [6, 20, 0, 11, 1, "STRING"],
            [7, 21, 0, 11, 2, "STRING"],
            [8, 11, 0, 12, 0, "NAID_OPTION"],
            [9, 22, 0, 12, 1, "STRING"],
            [10, 23, 0, 12, 2, "STRING"],
            [11, 12, 0, 13, 0, "NAID_OPTION"],
            [12, 14, 0, 99, 0, "NAID_OPTION"],
        ],
    }
    info = PngInfo()
    info.add_text("parameters", "\nNegative prompt: ")
    info.add_text("workflow", json.dumps(workflow))
    Image.new("RGB", (16, 16), "white").save(path, pnginfo=info)

    meta = read_comfy_metadata(path)

    assert meta.model == "nai-diffusion-5-full"
    assert meta.seed == 6174591079
    assert meta.steps == 28
    assert meta.cfg == 7.0
    assert meta.sampler == "k_euler_ancestral"
    assert meta.scheduler == "native"
    assert meta.positive_prompt == "scene, 1.2::focus ::"
    assert meta.negative_prompt == "lowres, blurry"
    assert meta.has_workflow is True
    generation = json.loads(meta.generation_data_json or "null")
    assert generation == {
        "provider": "novelai",
        "workflow_reader_version": 2,
        "positive": {"use_coords": True, "use_order": True},
        "negative": {"use_coords": True, "use_order": True},
        "characters": [
            {
                "index": 1,
                "positive_prompt": "red hair, green eyes",
                "negative_prompt": "hat",
                "centers": [{"x": 0.25, "y": 0.4}],
            },
            {
                "index": 2,
                "positive_prompt": "black hair, blue eyes",
                "negative_prompt": "glasses",
                "centers": [{"x": 0.75, "y": 0.4}],
            },
        ],
    }

    # ComfyUI keeps bypassed nodes and their links in the UI workflow.  Mode 4
    # is a transparent bypass: the upstream model option still reaches the
    # generator, but neither character node contributes its own prompt.
    for node in workflow["nodes"]:
        if node.get("type") == "CharacterPromptOptionNAID":
            node["mode"] = 4
    bypassed_path = tmp_path / "save-image-plus-nai-bypassed-characters.png"
    bypassed_info = PngInfo()
    bypassed_info.add_text("parameters", "\nNegative prompt: ")
    bypassed_info.add_text("workflow", json.dumps(workflow))
    Image.new("RGB", (16, 16), "white").save(bypassed_path, pnginfo=bypassed_info)

    bypassed_meta = read_comfy_metadata(bypassed_path)
    bypassed_generation = json.loads(bypassed_meta.generation_data_json or "null")
    assert bypassed_meta.model == "nai-diffusion-5-full"
    assert bypassed_generation["workflow_reader_version"] == 2
    assert bypassed_generation["characters"] == []
    assert bypassed_generation["positive"] == {"use_coords": False, "use_order": False}
    assert bypassed_generation["negative"] == {"use_coords": False, "use_order": False}


def test_metadata_reread_selects_stale_novelai_workflow_rows(tmp_path: Path) -> None:
    db_path = tmp_path / "gallery.sqlite"
    conn = db.connect_write(db_path)
    try:
        db.migrate(conn)
        root_path = tmp_path.resolve().as_posix()
        conn.execute(
            "INSERT INTO folder(path, kind, display_name, removable) VALUES (?, ?, ?, ?)",
            (root_path, "output", "output", 0),
        )
        folder_id = int(conn.execute("SELECT id FROM folder").fetchone()[0])
        common = (
            folder_id,
            "png",
            "image",
            1,
            28,
            "nai-diffusion-5-full",
            123,
            "k_euler",
            "general prompt",
        )
        conn.execute(
            "INSERT INTO image(path, folder_id, relative_path, filename, filename_lc, "
            "ext, media_kind, workflow_present, steps, model, seed, sampler, "
            "positive_prompt, indexed_at, generation_data_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
            (
                (tmp_path / "stale.png").resolve().as_posix(),
                *common[:1],
                "stale.png",
                "stale.png",
                "stale.png",
                *common[1:],
                json.dumps({"provider": "novelai", "characters": [{"index": 1}]}),
            ),
        )
        conn.execute(
            "INSERT INTO image(path, folder_id, relative_path, filename, filename_lc, "
            "ext, media_kind, workflow_present, steps, model, seed, sampler, "
            "positive_prompt, indexed_at, generation_data_json) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
            (
                (tmp_path / "current.png").resolve().as_posix(),
                *common[:1],
                "current.png",
                "current.png",
                "current.png",
                *common[1:],
                json.dumps({
                    "provider": "novelai",
                    "workflow_reader_version": 2,
                    "characters": [],
                }),
            ),
        )
        conn.commit()
    finally:
        conn.close()

    assert repo.count_missing_steps(db_path=db_path) == 1
    targets = repo.list_missing_metadata_targets(db_path=db_path)
    assert [Path(row["path"]).name for row in targets] == ["stale.png"]
