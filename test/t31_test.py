"""T31 offline — list filter backend (``FilterSpec`` / SQL / routes wire).

No ComfyUI. Covers ``TASKS.md`` T31: ``metadata_presence`` tri-state,
``prompt_match_mode`` prompt/word/string, §11 F05 ``_``→space, ``/images``
+ ``/images/count``, invalid query → 400 ``invalid_query``.

Run:
    pytest test/t31_test.py -q
Or:
    python test/t31_test.py
"""
from __future__ import annotations

import asyncio
import shutil
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))


def _insert_folder(conn: sqlite3.Connection, *, path: str, kind: str) -> int:
    cur = conn.execute(
        "INSERT INTO folder(path, kind, parent_id, display_name, removable) "
        "VALUES (?, ?, ?, ?, ?)",
        (path, kind, None, kind, 0),
    )
    return int(cur.lastrowid)


def _insert_image(conn: sqlite3.Connection, **kw: object) -> int:
    cur = conn.execute(
        "INSERT INTO image("
        "path, folder_id, relative_path, filename, filename_lc, ext, "
        "width, height, file_size, mtime_ns, created_at, "
        "positive_prompt, negative_prompt, model, seed, cfg, sampler, scheduler, "
        "workflow_present, favorite, tags_csv, indexed_at"
        ") VALUES ("
        ":path, :folder_id, :relative_path, :filename, :filename_lc, :ext, "
        ":width, :height, :file_size, :mtime_ns, :created_at, "
        ":positive_prompt, :negative_prompt, :model, :seed, :cfg, "
        ":sampler, :scheduler, :workflow_present, :favorite, :tags_csv, "
        ":indexed_at)",
        {
            "path": kw["path"],
            "folder_id": kw["folder_id"],
            "relative_path": kw["relative_path"],
            "filename": kw["filename"],
            "filename_lc": str(kw["filename"]).lower(),
            "ext": Path(str(kw["filename"])).suffix.lstrip(".").lower(),
            "width": kw.get("width", 32),
            "height": kw.get("height", 32),
            "file_size": kw["file_size"],
            "mtime_ns": kw["mtime_ns"],
            "created_at": kw.get("created_at", 1),
            "positive_prompt": kw.get("positive_prompt"),
            "negative_prompt": kw.get("negative_prompt"),
            "model": kw.get("model"),
            "seed": kw.get("seed"),
            "cfg": kw.get("cfg"),
            "sampler": kw.get("sampler"),
            "scheduler": kw.get("scheduler"),
            "workflow_present": int(kw.get("workflow_present", 0)),
            "favorite": kw.get("favorite"),
            "tags_csv": kw.get("tags_csv"),
            "indexed_at": int(time.time()),
        },
    )
    return int(cur.lastrowid)


def _bootstrap_db(scratch: Path) -> tuple[Path, dict[str, int]]:
    from gallery import db
    from gallery import repo as g_repo
    from gallery import vocab

    db_path = scratch / "gallery.sqlite"
    conn = db.connect_write(db_path)
    try:
        db.migrate(conn)
        root = _insert_folder(conn, path="/t31/out", kind="output")
        ids: dict[str, int] = {}
        ids["rich"] = _insert_image(
            conn,
            path="/t31/out/rich.png",
            folder_id=root,
            relative_path="rich.png",
            filename="rich.png",
            file_size=10,
            mtime_ns=1,
            positive_prompt="cat, sitting, mat",
            model="m1",
            workflow_present=1,
        )
        ids["bare"] = _insert_image(
            conn,
            path="/t31/out/bare.png",
            folder_id=root,
            relative_path="bare.png",
            filename="bare.png",
            file_size=11,
            mtime_ns=2,
            positive_prompt=None,
            negative_prompt=None,
            model=None,
            seed=None,
            cfg=None,
            sampler=None,
            scheduler=None,
            workflow_present=0,
        )
        ids["us"] = _insert_image(
            conn,
            path="/t31/out/us.png",
            folder_id=root,
            relative_path="us.png",
            filename="us.png",
            file_size=12,
            mtime_ns=3,
            positive_prompt="prefix hello_world suffix",
            model=None,
            workflow_present=0,
        )
        conn.commit()
    finally:
        conn.close()

    conn = db.connect_write(db_path)
    try:
        for iid, pp in (
            (ids["rich"], "cat, sitting, mat"),
            (ids["us"], "prefix hello_world suffix"),
        ):
            toks = list(vocab.normalize_prompt(pp, frozenset()))
            wtoks = list(vocab.split_positive_prompt_words(pp))
            g_repo.UpsertVocabAndLinksOp(
                image_id=iid,
                prompt_tokens=toks,
                word_tokens=wtoks,
                tag_names=[],
            ).apply(conn)
        conn.commit()
    finally:
        conn.close()

    return db_path, ids


def test_metadata_presence_and_prompt_modes(tmp_path: Path) -> None:
    from gallery import repo as g_repo

    db_path, ids = _bootstrap_db(tmp_path)

    page_all = g_repo.list_images(db_path=db_path, limit=50)
    assert {r.id for r in page_all.items} == {
        ids["rich"], ids["bare"], ids["us"],
    }

    page_yes = g_repo.list_images(
        db_path=db_path,
        filter=g_repo.FilterSpec(metadata_presence="yes"),
        limit=50,
    )
    assert {r.id for r in page_yes.items} == {ids["rich"], ids["us"]}

    page_no = g_repo.list_images(
        db_path=db_path,
        filter=g_repo.FilterSpec(metadata_presence="no"),
        limit=50,
    )
    assert {r.id for r in page_no.items} == {ids["bare"]}

    pg_prompt = g_repo.list_images(
        db_path=db_path,
        filter=g_repo.FilterSpec(
            prompt_match_mode="prompt",
            prompts_and=("cat", "sitting"),
        ),
        limit=50,
    )
    assert {r.id for r in pg_prompt.items} == {ids["rich"]}

    pg_word = g_repo.list_images(
        db_path=db_path,
        filter=g_repo.FilterSpec(
            prompt_match_mode="word",
            words_and=("cat", "sitting"),
        ),
        limit=50,
    )
    assert {r.id for r in pg_word.items} == {ids["rich"]}

    pg_str = g_repo.list_images(
        db_path=db_path,
        filter=g_repo.FilterSpec(
            prompt_match_mode="string",
            prompt_substrings=("hello world",),
        ),
        limit=50,
    )
    assert {r.id for r in pg_str.items} == {ids["us"]}


def test_f05_wire_underscore_string_mode(tmp_path: Path) -> None:
    from gallery import routes

    db_path, _ids = _bootstrap_db(tmp_path)
    fake = type("S", (), {"routes": web.RouteTableDef()})()
    routes._registered = False
    routes.DB_PATH = db_path
    routes.THUMBS_DIR = tmp_path / "thumbs"
    routes.THUMBS_DIR.mkdir(exist_ok=True)
    routes.register(fake)
    app = web.Application()
    app.add_routes(fake.routes)

    async def run() -> None:
        server = TestServer(app)
        client = TestClient(server)
        await server.start_server()
        try:
            r = await client.get(
                "/xyz/gallery/images"
                "?prompt_match_mode=string&prompt=hello_world&limit=50",
            )
            assert r.status == 200
            body = await r.json()
            got = {it["id"] for it in body["items"]}
            assert got == {_ids["us"]}, got
        finally:
            await client.close()
            await server.close()

    asyncio.run(run())


def test_images_count_matches_list_total(tmp_path: Path) -> None:
    from gallery import routes

    db_path, _ids = _bootstrap_db(tmp_path)
    fake = type("S", (), {"routes": web.RouteTableDef()})()
    routes._registered = False
    routes.DB_PATH = db_path
    routes.THUMBS_DIR = tmp_path / "thumbs2"
    routes.THUMBS_DIR.mkdir(exist_ok=True)
    routes.register(fake)
    app = web.Application()
    app.add_routes(fake.routes)

    async def run() -> None:
        server = TestServer(app)
        client = TestClient(server)
        await server.start_server()
        try:
            q = "metadata_presence=yes&prompt_match_mode=prompt&prompt=cat"
            r1 = await client.get(f"/xyz/gallery/images?{q}&limit=50")
            r2 = await client.get(f"/xyz/gallery/images/count?{q}")
            assert r1.status == 200 and r2.status == 200
            body = await r1.json()
            cnt = await r2.json()
            assert cnt["total"] == len(body["items"]) == 1
        finally:
            await client.close()
            await server.close()

    asyncio.run(run())


def test_invalid_query_envelope(tmp_path: Path) -> None:
    from gallery import routes

    db_path, _ = _bootstrap_db(tmp_path)
    fake = type("S", (), {"routes": web.RouteTableDef()})()
    routes._registered = False
    routes.DB_PATH = db_path
    routes.THUMBS_DIR = tmp_path / "thumbs3"
    routes.THUMBS_DIR.mkdir(exist_ok=True)
    routes.register(fake)
    app = web.Application()
    app.add_routes(fake.routes)

    async def run() -> None:
        server = TestServer(app)
        client = TestClient(server)
        await server.start_server()
        try:
            r = await client.get("/xyz/gallery/images?metadata_presence=maybe")
            assert r.status == 400
            j = await r.json()
            assert j["error"]["code"] == "invalid_query"
            r2 = await client.get("/xyz/gallery/images/count?prompt_match_mode=nope")
            assert r2.status == 400
            j2 = await r2.json()
            assert j2["error"]["code"] == "invalid_query"
        finally:
            await client.close()
            await server.close()

    asyncio.run(run())


def test_parse_filter_mapping_string_positive_tokens(tmp_path: Path) -> None:
    from gallery import routes
    from gallery import repo as g_repo

    db_path, ids = _bootstrap_db(tmp_path)
    flt = routes._parse_filter_mapping(
        {
            "prompt_match_mode": "string",
            "positive_tokens": ["prefix_hello"],
        },
    )
    assert flt.prompt_match_mode == "string"
    assert flt.prompt_substrings == ("prefix hello",)
    page = g_repo.list_images(db_path=db_path, filter=flt, limit=50)
    assert {r.id for r in page.items} == {ids["us"]}


def test_split_positive_prompt_words_underscore_f05(tmp_path: Path) -> None:
    from gallery import vocab

    assert vocab.split_positive_prompt_words("prefix hello_world suffix") == (
        "prefix",
        "hello",
        "world",
        "suffix",
    )
    assert vocab.split_positive_prompt_words("a,, b  c") == ("a", "b", "c")
    assert vocab.split_positive_prompt_words("hello.") == ("hello",)


def test_prompt_mode_underscore_token_matches(tmp_path: Path) -> None:
    """Regression: a danbooru/NAI prompt token that keeps underscores (e.g.
    ``slave_gear_\\(tsmg_nao!\\)``) is stored verbatim by the indexer, but the
    query side maps ``_``→space (F05). Prompt-mode filtering must still match it
    (previously: autocomplete showed N images, but the filter returned 0)."""
    from urllib.parse import quote

    from gallery import db
    from gallery import repo as g_repo
    from gallery import routes
    from gallery import vocab

    db_path = tmp_path / "gallery.sqlite"
    conn = db.connect_write(db_path)
    try:
        db.migrate(conn)
        root = _insert_folder(conn, path="/t31u/out", kind="output")
        # Escaped parens + underscores → stored token "slave_gear_(tsmg_nao!)".
        pp = "1girl, slave_gear_\\(tsmg_nao!\\), standing"
        img_id = _insert_image(
            conn, path="/t31u/out/a.png", folder_id=root,
            relative_path="a.png", filename="a.png", file_size=10, mtime_ns=1,
            positive_prompt=pp, model=None, workflow_present=0,
        )
        conn.commit()
    finally:
        conn.close()

    conn = db.connect_write(db_path)
    try:
        toks = list(vocab.normalize_prompt(pp, frozenset()))
        assert "slave_gear_(tsmg_nao!)" in toks, toks
        g_repo.UpsertVocabAndLinksOp(
            image_id=img_id, prompt_tokens=toks, word_tokens=[], tag_names=[],
        ).apply(conn)
        conn.commit()
    finally:
        conn.close()

    fake = type("S", (), {"routes": web.RouteTableDef()})()
    routes._registered = False
    routes.DB_PATH = db_path
    routes.THUMBS_DIR = tmp_path / "thumbs_u"
    routes.THUMBS_DIR.mkdir(exist_ok=True)
    routes.register(fake)
    app = web.Application()
    app.add_routes(fake.routes)

    async def run() -> None:
        server = TestServer(app)
        client = TestClient(server)
        await server.start_server()
        try:
            q = "prompt_match_mode=prompt&prompt=" + quote("slave_gear_(tsmg_nao!)")
            r1 = await client.get(f"/xyz/gallery/images?{q}&limit=50")
            r2 = await client.get(f"/xyz/gallery/images/count?{q}")
            assert r1.status == 200 and r2.status == 200
            body = await r1.json()
            cnt = await r2.json()
            got = {it["id"] for it in body["items"]}
            assert got == {img_id}, got
            assert cnt["total"] == 1, cnt
        finally:
            await client.close()
            await server.close()

    asyncio.run(run())


def test_explain_token_filter_not_full_table_scan(tmp_path: Path) -> None:
    from gallery import repo as g_repo

    db_path, _ = _bootstrap_db(tmp_path)
    conn = sqlite3.connect(str(db_path))
    try:
        flt = g_repo.FilterSpec(prompts_and=("cat",))
        where_sql, params = g_repo._build_filter(conn, flt)
        plan = conn.execute(
            "EXPLAIN QUERY PLAN SELECT image.id FROM image "
            "LEFT JOIN folder ON folder.id = image.folder_id "
            f"WHERE {where_sql}",
            params,
        ).fetchall()
        blob = " ".join(str(row) for row in plan).lower()
        assert "image_prompt_token" in blob or "prompt_token" in blob, blob
        flt_w = g_repo.FilterSpec(prompt_match_mode="word", words_and=("cat",))
        w_sql, w_params = g_repo._build_filter(conn, flt_w)
        plan_w = conn.execute(
            "EXPLAIN QUERY PLAN SELECT image.id FROM image "
            "LEFT JOIN folder ON folder.id = image.folder_id "
            f"WHERE {w_sql}",
            w_params,
        ).fetchall()
        blob_w = " ".join(str(row) for row in plan_w).lower()
        assert "image_word_token" in blob_w or "word_token" in blob_w, blob_w
    finally:
        conn.close()


def main() -> None:
    steps = [
        ("split_words", test_split_positive_prompt_words_underscore_f05),
        ("metadata", test_metadata_presence_and_prompt_modes),
        ("f05", test_f05_wire_underscore_string_mode),
        ("count", test_images_count_matches_list_total),
        ("400", test_invalid_query_envelope),
        ("mapping", test_parse_filter_mapping_string_positive_tokens),
        ("us_token", test_prompt_mode_underscore_token_matches),
        ("explain", test_explain_token_filter_not_full_table_scan),
    ]
    for label, fn in steps:
        scratch = Path(tempfile.mkdtemp(prefix=f"xyz-t31-{label}-"))
        try:
            fn(scratch)
            print(f"T31 {label} OK")
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
    print("\nT31 ALL TESTS PASSED")


if __name__ == "__main__":
    main()
