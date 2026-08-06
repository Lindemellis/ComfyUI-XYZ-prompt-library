"""T35/T36 offline pieces — PNG export variants, vocab ``match=contains``, preferences API.

Run:
    pytest test/t35_test.py -q
Expected: all passed.
"""
from __future__ import annotations

import asyncio
import io
import json
import sys
import tempfile
import time
from pathlib import Path

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))

from aiohttp import web  # noqa: E402
from PIL import Image  # noqa: E402
from PIL.PngImagePlugin import PngInfo  # noqa: E402


def test_build_png_download_bytes_no_workflow_and_clean() -> None:
    from gallery import metadata

    with tempfile.TemporaryDirectory() as td:
        p = Path(td) / "x.png"
        img = Image.new("RGB", (8, 8), color=(40, 60, 80))
        pnginfo = PngInfo()
        pnginfo.add_text("workflow", '{"nodes":[]}')
        pnginfo.add_text("prompt", '{"1":{"class_type":"CLIPTextEncode"}}')
        pnginfo.add_text("xyz_gallery.tags", "foo,bar")
        pnginfo.add_text("parameters", "hello\nNegative prompt: neg")
        img.save(p, pnginfo=pnginfo, compress_level=3)

        b_no = metadata.build_png_download_bytes(p, "no_workflow")
        im_no = Image.open(io.BytesIO(b_no))
        t_no = dict(im_no.text or {})
        assert "workflow" not in t_no
        assert "prompt" in t_no
        assert "xyz_gallery.tags" in t_no

        b_cl = metadata.build_png_download_bytes(p, "clean")
        im_cl = Image.open(io.BytesIO(b_cl))
        t_cl = dict(im_cl.text or {})
        assert "workflow" not in t_cl
        assert "prompt" not in t_cl
        assert "xyz_gallery.tags" not in t_cl
        assert "parameters" not in t_cl

        # The fourth combination the old three-button picker could not express:
        # keep the editor graph, drop the prompt and settings.
        b_ng = metadata.build_png_download_bytes(p, "no_gen")
        t_ng = dict(Image.open(io.BytesIO(b_ng)).text or {})
        assert "workflow" in t_ng
        assert "prompt" not in t_ng
        assert "parameters" not in t_ng
        # Only "keep neither" means a bare raster, so the gallery's own chunks stay.
        assert "xyz_gallery.tags" in t_ng


def test_download_variants_are_two_booleans() -> None:
    """A variant IS (keep workflow, keep generation data); all four exist and the
    names are the only place that mapping is written down."""
    from gallery import folders

    assert folders.normalize_download_variant("no_gen") == "no_gen"
    for name in ("full", "no_workflow", "no_gen", "clean"):
        assert folders.normalize_download_variant(name) == name


def test_vocab_lookup_contains_tags() -> None:
    from gallery import db
    from gallery import repo

    with tempfile.TemporaryDirectory() as td:
        db_path = Path(td) / "g.sqlite"
        conn = db.connect_write(db_path)
        try:
            db.migrate(conn)
            conn.execute(
                "INSERT INTO tag(name, usage_count) VALUES ('blonde eyes', 3), ('red', 9)",
            )
            conn.commit()
        finally:
            conn.close()

        rows_pre = repo.vocab_lookup(
            db_path=db_path, kind="tags", prefix="eyes", limit=10, match_mode="prefix",
        )
        assert not any(r["name"] == "blonde eyes" for r in rows_pre)

        rows_sub = repo.vocab_lookup(
            db_path=db_path, kind="tags", prefix="eyes", limit=10, match_mode="contains",
        )
        names = [r["name"] for r in rows_sub]
        assert "blonde eyes" in names


class _FakeSrv:
    def __init__(self) -> None:
        self.routes = web.RouteTableDef()


async def _prefs_roundtrip_and_download_variant_query(tmp: Path) -> None:
    from aiohttp.test_utils import TestClient, TestServer

    from gallery import routes as gallery_routes

    cfg = tmp / "gallery_config.json"
    cfg.write_text(json.dumps({"roots": [], "download_variant": "clean"}), encoding="utf-8")

    gallery_routes._registered = False
    fake = _FakeSrv()
    gallery_routes.register(fake)
    app = web.Application()
    app.add_routes(fake.routes)

    gallery_routes.DB_PATH = tmp / "gallery.sqlite"
    gallery_routes.DATA_DIR = tmp
    gallery_routes.THUMBS_DIR = tmp / "thumbs"

    from gallery import db as gallery_db

    conn = gallery_db.connect_write(gallery_routes.DB_PATH)
    try:
        gallery_db.migrate(conn)
        conn.execute(
            "INSERT INTO folder(path, kind, parent_id, display_name, removable) "
            "VALUES (?, 'output', NULL, 'o', 0)",
            ((tmp / "out").as_posix(),),
        )
        fid = int(conn.execute("SELECT id FROM folder WHERE parent_id IS NULL").fetchone()[0])
        png_path = tmp / "out" / "a.png"
        png_path.parent.mkdir(parents=True)
        img = Image.new("RGB", (4, 4), color=1)
        pi = PngInfo()
        pi.add_text("workflow", "{}")
        pi.add_text("prompt", "{}")
        pi.add_text("parameters", "positive\nNegative prompt: neg\nSteps: 1, Seed: 2, Sampler: euler")
        img.save(png_path, pnginfo=pi)
        st = png_path.stat()
        conn.execute(
            "INSERT INTO image(path, folder_id, relative_path, filename, filename_lc, "
            "ext, width, height, file_size, mtime_ns, created_at, positive_prompt, "
            "negative_prompt, model, seed, cfg, sampler, scheduler, workflow_present, "
            "favorite, tags_csv, indexed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                png_path.as_posix(),
                fid,
                "a.png",
                "a.png",
                "a.png",
                "png",
                4,
                4,
                st.st_size,
                int(st.st_mtime_ns),
                int(time.time()),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                1,
                0,
                None,
                int(time.time()),
            ),
        )
        conn.commit()
    finally:
        conn.close()

    async with TestServer(app) as srv:
        async with TestClient(srv) as client:
            r = await client.get("/xyz/gallery/preferences")
            assert r.status == 200
            j = await r.json()
            assert j.get("download_variant") == "clean"

            r2 = await client.patch(
                "/xyz/gallery/preferences",
                data=json.dumps({"download_variant": "no_workflow"}),
                headers={"Content-Type": "application/json"},
            )
            assert r2.status == 200
            j2 = await r2.json()
            assert j2.get("download_variant") == "no_workflow"
            disk = json.loads(cfg.read_text(encoding="utf-8"))
            assert disk.get("download_variant") == "no_workflow"

            r3 = await client.get("/xyz/gallery/raw/1/download?variant=clean")
            assert r3.status == 200
            raw = await r3.read()
            im = Image.open(io.BytesIO(raw))
            t = dict(im.text or {})
            assert "workflow" not in t and "prompt" not in t and "parameters" not in t


def test_preferences_http_and_download_variant_overrides_config() -> None:
    asyncio.run(_prefs_run())


async def _prefs_run() -> None:
    with tempfile.TemporaryDirectory() as td:
        await _prefs_roundtrip_and_download_variant_query(Path(td))


def test_folders_normalize_download_variant() -> None:
    from gallery import folders

    assert folders.normalize_download_variant(None) == "full"
    assert folders.normalize_download_variant("bogus") == "full"
    assert folders.normalize_download_variant("clean") == "clean"


def test_routes_invalid_vocab_match_returns_400() -> None:
    asyncio.run(_bad_vocab_match())


async def _bad_vocab_match() -> None:
    from aiohttp.test_utils import TestClient, TestServer

    from gallery import routes as gallery_routes

    gallery_routes._registered = False
    fake = _FakeSrv()
    gallery_routes.register(fake)
    app = web.Application()
    app.add_routes(fake.routes)

    tmp = Path(tempfile.mkdtemp())
    try:
        gallery_routes.DB_PATH = tmp / "x.sqlite"
        gallery_routes.DATA_DIR = tmp
        gallery_routes.THUMBS_DIR = tmp / "t"
        from gallery import db as gallery_db

        conn = gallery_db.connect_write(gallery_routes.DB_PATH)
        try:
            gallery_db.migrate(conn)
            conn.commit()
        finally:
            conn.close()

        async with TestServer(app) as srv:
            async with TestClient(srv) as client:
                r = await client.get("/xyz/gallery/vocab/tags?prefix=a&match=nope")
                assert r.status == 400
    finally:
        import shutil

        shutil.rmtree(tmp, ignore_errors=True)
