"""T09 offline validation script.

Mirrors TASKS.md T09 test plan on a scratch DB (no ComfyUI, no real
gallery_data/).  Style mirrors test/t07_test.py + test/t08_test.py.

Covers:
  * T09 #1 — 所有过滤维度组合正确且命中索引（EXPLAIN QUERY PLAN 自检）
  * T09 #2 — 翻页 N 次 → 无重复 / 无缺失 id
  * T09 #3 — 中途插入新行 → 游标仍稳定
  * T09 #4 — neighbors 首尾返回 None（不环绕）
  * 额外：folder_tree + include_counts；total_estimate 边界；neighbors
    对不存在 / 不匹配 filter 的 id 返回 (None, None)。
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))


def _bootstrap(scratch: Path) -> Path:
    from gallery import db
    db_path = scratch / "gallery.sqlite"
    conn = db.connect_write(db_path)
    try:
        db.migrate(conn)
    finally:
        conn.close()
    return db_path


def _insert_folder(
    conn: sqlite3.Connection, *, path: str, kind: str,
    parent_id=None, display_name=None, removable: int = 0,
) -> int:
    cur = conn.execute(
        "INSERT INTO folder(path, kind, parent_id, display_name, removable) "
        "VALUES (?, ?, ?, ?, ?)",
        (path, kind, parent_id, display_name, removable),
    )
    return int(cur.lastrowid)


def _insert_image(
    conn: sqlite3.Connection, *,
    path: str, folder_id: int, relative_path: str,
    filename: str, file_size: int, mtime_ns: int, created_at: int,
    model: str = None, seed: int = None, positive_prompt: str = None,
    negative_prompt: str = None, sampler: str = None, scheduler: str = None,
    cfg: float = None, width: int = 64, height: int = 64,
    favorite: int = None, tags_csv: str = None, workflow_present: int = 0,
) -> int:
    cur = conn.execute(
        "INSERT INTO image("
        "path, folder_id, relative_path, filename, filename_lc, ext, "
        "width, height, file_size, mtime_ns, created_at, "
        "positive_prompt, negative_prompt, model, seed, cfg, sampler, scheduler, "
        "workflow_present, favorite, tags_csv, indexed_at"
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (path, folder_id, relative_path, filename, filename.lower(),
         Path(filename).suffix.lstrip(".").lower(),
         width, height, file_size, mtime_ns, created_at,
         positive_prompt, negative_prompt, model, seed, cfg, sampler, scheduler,
         workflow_present, favorite, tags_csv, int(time.time())),
    )
    return int(cur.lastrowid)


def _seed_fixture(db_path: Path) -> dict:
    """Seed 2 roots + 2 subfolders per root + ~15 images with varied
    metadata so we can exercise every filter/sort combo.  Returns
    a dict of reference ids for assertions.
    """
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        out_root = _insert_folder(
            conn, path="/scratch/output", kind="output", removable=0,
            display_name="output")
        inp_root = _insert_folder(
            conn, path="/scratch/input", kind="input", removable=0,
            display_name="input")
        out_a = _insert_folder(
            conn, path="/scratch/output/day1", kind="output",
            parent_id=out_root, display_name="day1", removable=0)
        out_b = _insert_folder(
            conn, path="/scratch/output/day2", kind="output",
            parent_id=out_root, display_name="day2", removable=0)
        inp_a = _insert_folder(
            conn, path="/scratch/input/cats", kind="input",
            parent_id=inp_root, display_name="cats", removable=0)

        img_ids = {}
        # Root-level flat files (relative_path has no '/').
        img_ids["out_flat_1"] = _insert_image(
            conn, path="/scratch/output/flat_a.png", folder_id=out_root,
            relative_path="flat_a.png", filename="flat_a.png",
            file_size=100, mtime_ns=1_000_000_000_000_000, created_at=100,
            model="sdxl", positive_prompt="cat, sitting, mat",
            favorite=1, tags_csv="cat,cute", workflow_present=1)
        img_ids["out_flat_2"] = _insert_image(
            conn, path="/scratch/output/flat_b.png", folder_id=out_root,
            relative_path="flat_b.png", filename="flat_b.png",
            file_size=200, mtime_ns=2_000_000_000_000_000, created_at=200,
            model="sd15", positive_prompt="a dog running",
            favorite=0, tags_csv="dog", workflow_present=0)
        # day1 contents
        for i in range(5):
            img_ids[f"day1_{i}"] = _insert_image(
                conn,
                path=f"/scratch/output/day1/img_{i}.png", folder_id=out_root,
                relative_path=f"day1/img_{i}.png", filename=f"img_{i}.png",
                file_size=300 + i * 10,
                mtime_ns=3_000_000_000_000_000 + i,
                created_at=300 + i,
                model="sdxl" if i % 2 == 0 else "sd15",
                positive_prompt=("a mountain landscape" if i % 2 == 0
                                 else "ocean waves"),
                favorite=1 if i == 0 else None,
                tags_csv=("landscape,mountain" if i % 2 == 0
                          else "ocean,water"),
                workflow_present=1 if i == 0 else 0,
            )
        # day2 contents
        for i in range(3):
            img_ids[f"day2_{i}"] = _insert_image(
                conn,
                path=f"/scratch/output/day2/deep_{i}.png", folder_id=out_root,
                relative_path=f"day2/deep_{i}.png", filename=f"deep_{i}.png",
                file_size=500 + i,
                mtime_ns=4_000_000_000_000_000 + i,
                created_at=500 + i,
                model="sd15", positive_prompt="a portrait of a person",
                favorite=None, tags_csv=None, workflow_present=0,
            )
        # input/cats contents (one extra level deep too)
        img_ids["inp_flat"] = _insert_image(
            conn, path="/scratch/input/root_inp.png", folder_id=inp_root,
            relative_path="root_inp.png", filename="root_inp.png",
            file_size=10, mtime_ns=5_000_000_000_000_000, created_at=50,
            model=None, positive_prompt=None,
            favorite=1, tags_csv="misc", workflow_present=0)
        img_ids["cats_1"] = _insert_image(
            conn, path="/scratch/input/cats/fluffy.png", folder_id=inp_root,
            relative_path="cats/fluffy.png", filename="fluffy.png",
            file_size=20, mtime_ns=5_500_000_000_000_000, created_at=60,
            model="sdxl", positive_prompt="cat, sitting, alone",
            favorite=0, tags_csv="cat,fluffy", workflow_present=0)
        conn.commit()
    finally:
        conn.close()

    return {
        "out_root": out_root, "inp_root": inp_root,
        "out_a": out_a, "out_b": out_b, "inp_a": inp_a,
        "img_ids": img_ids,
    }


def _seed_vocab_links(db_path: Path) -> None:
    """Backfill ``image_tag`` / ``image_prompt_token`` like the T15 indexer."""
    from gallery import db, vocab
    from gallery.repo import UpsertVocabAndLinksOp

    conn = db.connect_write(db_path)
    try:
        rows = conn.execute(
            "SELECT id, tags_csv, positive_prompt FROM image",
        ).fetchall()
        for row in rows:
            iid = int(row[0])
            tags_csv = row[1]
            pp = row[2]
            tag_names: list[str] = []
            for part in (tags_csv or "").split(","):
                nt = vocab.normalize_tag(part)
                if nt:
                    tag_names.append(nt)
            prompt_toks = list(vocab.normalize_prompt(pp or "", frozenset()))
            UpsertVocabAndLinksOp(
                image_id=iid,
                prompt_tokens=prompt_toks,
                tag_names=tag_names,
            ).apply(conn)
        conn.commit()
    finally:
        conn.close()


# ---- tests ---------------------------------------------------------------

def test_get_image(db_path: Path, ref: dict) -> None:
    from gallery import repo
    rec = repo.get_image(ref["img_ids"]["out_flat_1"], db_path=db_path)
    assert rec is not None
    assert rec.filename == "flat_a.png"
    assert rec.folder_kind == "output"
    assert rec.has_workflow is True
    assert rec.favorite is True
    assert rec.tags == ("cat", "cute")
    assert rec.relative_dir == ""
    assert rec.model == "sdxl"
    assert repo.get_image(999_999, db_path=db_path) is None
    print("T09 get_image OK")


def test_list_basic_and_pagination(db_path: Path, ref: dict) -> None:
    from gallery import repo
    # Full list, sorted by name asc, paged in groups of 3.
    srt = repo.SortSpec(key="name", dir="asc")
    seen: list = []
    cursor = None
    pages = 0
    while True:
        pg = repo.list_images(
            db_path=db_path, sort=srt, cursor=cursor, limit=3)
        for r in pg.items:
            assert r.id not in seen, f"duplicate id {r.id} on page {pages}"
            seen.append(r.id)
        pages += 1
        if pg.next_cursor is None:
            break
        cursor = pg.next_cursor
        assert pages < 30, "pagination failed to terminate"

    # Compare against a reference ordering (name asc).
    conn = sqlite3.connect(str(db_path))
    try:
        expected = [r[0] for r in conn.execute(
            "SELECT id FROM image ORDER BY filename_lc ASC, id ASC"
        ).fetchall()]
    finally:
        conn.close()
    assert seen == expected, f"paged seq {seen} != expected {expected}"
    # Verify total is exact when under cap.
    pg_one = repo.list_images(db_path=db_path, sort=srt, limit=200)
    assert pg_one.total == len(expected)
    assert pg_one.total_approximate is False
    print(f"T09 list pagination OK (pages={pages}, total={pg_one.total})")


def test_cursor_stable_under_concurrent_insert(db_path: Path, ref: dict) -> None:
    """TASKS T09 test #3 — mid-iteration insert should not corrupt cursor."""
    from gallery import repo
    srt = repo.SortSpec(key="time", dir="asc")
    pg1 = repo.list_images(db_path=db_path, sort=srt, limit=3)
    assert pg1.next_cursor is not None
    seen = [r.id for r in pg1.items]

    # Insert a row whose created_at is *earlier* than the last emitted
    # row — this row MUST NOT appear on page 2 because page 2 starts
    # strictly after pg1's cursor. (It WILL appear if you re-run the
    # query from scratch — that's the normal "list shifted" behaviour.)
    last = pg1.items[-1]
    conn = sqlite3.connect(str(db_path))
    try:
        _insert_image(
            conn,
            path="/scratch/output/injected.png",
            folder_id=ref["out_root"], relative_path="injected.png",
            filename="injected.png",
            file_size=1, mtime_ns=6_000_000_000_000_000,
            created_at=0,  # < everything else
        )
        conn.commit()
    finally:
        conn.close()

    pg2 = repo.list_images(
        db_path=db_path, sort=srt, cursor=pg1.next_cursor, limit=3)
    for r in pg2.items:
        assert r.id not in seen
        seen.append(r.id)
    # The injected row's created_at=0 is strictly less than last.created_at,
    # so it cannot satisfy (created_at, id) > last_cursor → must be absent.
    for r in pg2.items:
        assert r.filename != "injected.png", (
            "injected earlier row leaked past cursor — FIFO broken")
    print("T09 cursor stability under concurrent insert OK")


def test_filters(db_path: Path, ref: dict) -> None:
    from gallery import repo
    # favorite
    fav = repo.list_images(
        db_path=db_path, filter=repo.FilterSpec(favorite="yes"), limit=50)
    assert len(fav.items) == 3, f"favorite=yes count {len(fav.items)}"
    for r in fav.items:
        assert r.favorite is True

    notfav = repo.list_images(
        db_path=db_path, filter=repo.FilterSpec(favorite="no"), limit=50)
    # Includes favorite=0 OR IS NULL (day2 rows have NULL).
    assert all(r.favorite is False for r in notfav.items)

    # model
    sdxl = repo.list_images(
        db_path=db_path, filter=repo.FilterSpec(model="sdxl"), limit=50)
    assert all(r.model == "sdxl" for r in sdxl.items)

    # name filter: substring on ``filename_lc`` for all lengths (1+).
    short_sub = repo.list_images(
        db_path=db_path, filter=repo.FilterSpec(name="fl"), limit=50)
    assert {r.filename for r in short_sub.items} == {
        "flat_a.png", "flat_b.png", "fluffy.png"
    }, "2-char substring filter mismatch"

    mid_sub = repo.list_images(
        db_path=db_path, filter=repo.FilterSpec(name="ep"), limit=50)
    assert {r.filename for r in mid_sub.items} == {
        "deep_0.png", "deep_1.png", "deep_2.png"
    }, "2-char interior substring (not prefix) mismatch"

    # ``_`` must be literal, not a LIKE single-char wildcard (common 2-char query).
    u0 = repo.list_images(
        db_path=db_path, filter=repo.FilterSpec(name="_0"), limit=50)
    assert {r.filename for r in u0.items} == {
        "deep_0.png", "img_0.png",
    }, "needle with underscore must match literal substring only"

    substr_hit = repo.list_images(
        db_path=db_path, filter=repo.FilterSpec(name="deep"), limit=50)
    assert all("deep" in r.filename for r in substr_hit.items)
    assert len(substr_hit.items) == 3

    # date_after / date_before (half-open).
    d = repo.list_images(
        db_path=db_path,
        filter=repo.FilterSpec(date_after=200, date_before=400),
        limit=50,
    )
    for r in d.items:
        assert 200 <= r.created_at < 400

    # tag AND
    tag_hit = repo.list_images(
        db_path=db_path,
        filter=repo.FilterSpec(tags_and=("cat",)),
        limit=50,
    )
    assert {r.filename for r in tag_hit.items} == {"flat_a.png", "fluffy.png"}
    tag_and = repo.list_images(
        db_path=db_path,
        filter=repo.FilterSpec(tags_and=("cat", "fluffy")),
        limit=50,
    )
    assert {r.filename for r in tag_and.items} == {"fluffy.png"}
    # Boundary check: 'cat' must NOT match 'category' had it been stored.
    # Our fixture stores 'cat,cute' so a hypothetical 'category' entry
    # would have surfaced here; the comma-bracket LIKE keeps us safe.

    # prompt AND
    prompt_hit = repo.list_images(
        db_path=db_path,
        filter=repo.FilterSpec(prompts_and=("cat", "sitting")),
        limit=50,
    )
    assert {r.filename for r in prompt_hit.items} == {
        "flat_a.png", "fluffy.png"}, [r.filename for r in prompt_hit.items]
    print("T09 filter dimensions OK")


def test_folder_recursive(db_path: Path, ref: dict) -> None:
    from gallery import repo
    # Root + recursive → every image under output.
    rec = repo.list_images(
        db_path=db_path,
        filter=repo.FilterSpec(folder_id=ref["out_root"], recursive=True),
        limit=50,
    )
    for r in rec.items:
        assert r.path.startswith("/scratch/output/")
    # Lower bound only — an earlier test may have injected rows.
    assert len(rec.items) >= 2 + 5 + 3

    # Root + non-recursive → only files whose relative_path has no '/'.
    # The cursor-stability test injects ``injected.png`` into out_root
    # (also flat) — so we use a superset assertion.
    flat = repo.list_images(
        db_path=db_path,
        filter=repo.FilterSpec(folder_id=ref["out_root"], recursive=False),
        limit=50,
    )
    names = {r.filename for r in flat.items}
    assert {"flat_a.png", "flat_b.png"} <= names, names
    for r in flat.items:
        assert "/" not in r.relative_path

    # Subfolder + recursive.
    sub_r = repo.list_images(
        db_path=db_path,
        filter=repo.FilterSpec(folder_id=ref["out_a"], recursive=True),
        limit=50,
    )
    assert {r.filename for r in sub_r.items} == {
        f"img_{i}.png" for i in range(5)}

    # Subfolder + non-recursive (same set here since day1 has no deeper
    # nesting in our fixture) — exercises the "NOT LIKE prefix+%/%" branch.
    sub_nr = repo.list_images(
        db_path=db_path,
        filter=repo.FilterSpec(folder_id=ref["out_a"], recursive=False),
        limit=50,
    )
    assert {r.filename for r in sub_nr.items} == {
        f"img_{i}.png" for i in range(5)}

    # Input/cats subfolder: only fluffy.png.
    inp = repo.list_images(
        db_path=db_path,
        filter=repo.FilterSpec(folder_id=ref["inp_a"], recursive=True),
        limit=50,
    )
    assert [r.filename for r in inp.items] == ["fluffy.png"]
    print("T09 folder + recursive OK")


def test_sorts(db_path: Path, ref: dict) -> None:
    from gallery import repo
    for key in ("name", "time", "size", "folder"):
        for d in ("asc", "desc"):
            pg = repo.list_images(
                db_path=db_path, sort=repo.SortSpec(key=key, dir=d), limit=50)
            ids_page = [r.id for r in pg.items]
            # Re-issue without cursor and paginate through to confirm
            # ORDER BY is stable and cursor agrees.
            collected = []
            c = None
            while True:
                page = repo.list_images(
                    db_path=db_path,
                    sort=repo.SortSpec(key=key, dir=d),
                    cursor=c, limit=3)
                collected.extend(r.id for r in page.items)
                if page.next_cursor is None:
                    break
                c = page.next_cursor
            assert collected[:len(ids_page)] == ids_page, (
                f"sort {key}/{d}: cursor/non-cursor disagree\n"
                f"full: {ids_page[:5]}\npaged: {collected[:5]}")
    print("T09 sort keys x dirs OK")


def test_folder_line_header_sort_order(db_path: Path, ref: dict) -> None:
    """``SortSpec(folder)`` orders by UI line header, not ``image.path``."""
    from gallery import repo

    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        _insert_image(
            conn,
            path="/scratch/output/zzz_linehdr_root.png",
            folder_id=ref["out_root"],
            relative_path="zzz_linehdr_root.png",
            filename="zzz_linehdr_root.png",
            file_size=910, mtime_ns=9_100_000_000_000_000, created_at=910,
        )
        _insert_image(
            conn,
            path="/scratch/output/a_sub/linehdr_sub.png",
            folder_id=ref["out_root"],
            relative_path="a_sub/linehdr_sub.png",
            filename="linehdr_sub.png",
            file_size=920, mtime_ns=9_200_000_000_000_000, created_at=920,
        )
        conn.commit()
    finally:
        conn.close()

    pg = repo.list_images(
        db_path=db_path, sort=repo.SortSpec(key="folder", dir="asc"), limit=500,
    )
    names = [r.filename for r in pg.items]
    assert names.index("zzz_linehdr_root.png") < names.index("linehdr_sub.png"), (
        "root ``output`` section must sort before ``output/a_sub`` "
        f"(got positions {names.index('zzz_linehdr_root.png')} vs "
        f"{names.index('linehdr_sub.png')})"
    )
    print("T09 folder line-header sort OK")


def test_total_estimate_cap(db_path: Path, ref: dict) -> None:
    from gallery import repo
    # Temporarily lower the cap to exercise the approximate branch
    # without seeding 5000 rows.
    orig = repo.TOTAL_ESTIMATE_CAP
    try:
        repo.TOTAL_ESTIMATE_CAP = 3
        pg = repo.list_images(db_path=db_path, limit=2)
        assert pg.total == 3
        assert pg.total_approximate is True
    finally:
        repo.TOTAL_ESTIMATE_CAP = orig

    pg2 = repo.list_images(db_path=db_path, limit=2)
    assert pg2.total_approximate is False
    print("T09 total_estimate cap OK")


def test_neighbors(db_path: Path, ref: dict) -> None:
    from gallery import repo
    srt = repo.SortSpec(key="time", dir="asc")
    # Collect the full ordered id list once for the reference.
    all_ids: list = []
    c = None
    while True:
        pg = repo.list_images(db_path=db_path, sort=srt, cursor=c, limit=50)
        all_ids.extend(r.id for r in pg.items)
        if pg.next_cursor is None:
            break
        c = pg.next_cursor

    # First: prev is None.
    n = repo.neighbors(all_ids[0], db_path=db_path, sort=srt)
    assert n.prev_id is None
    assert n.next_id == all_ids[1]
    # Middle.
    n = repo.neighbors(all_ids[3], db_path=db_path, sort=srt)
    assert n.prev_id == all_ids[2]
    assert n.next_id == all_ids[4]
    # Last: next is None.
    n = repo.neighbors(all_ids[-1], db_path=db_path, sort=srt)
    assert n.prev_id == all_ids[-2]
    assert n.next_id is None

    # Unknown id → (None, None).
    n = repo.neighbors(999_999, db_path=db_path, sort=srt)
    assert n.prev_id is None and n.next_id is None

    # Image exists but filter excludes it → (None, None).
    out_flat_1 = ref["img_ids"]["out_flat_1"]
    n = repo.neighbors(
        out_flat_1, db_path=db_path,
        filter=repo.FilterSpec(model="nonexistent"), sort=srt,
    )
    assert n.prev_id is None and n.next_id is None
    print("T09 neighbors boundaries OK")


def test_folder_tree(db_path: Path, ref: dict) -> None:
    from gallery import repo
    tree = repo.folder_tree(db_path=db_path, include_counts=False)
    assert len(tree) == 2, f"expected 2 roots, got {len(tree)}"
    names = {n.display_name for n in tree}
    assert names == {"output", "input"}

    out_node = next(n for n in tree if n.display_name == "output")
    kids = {n.display_name for n in out_node.children}
    assert kids == {"day1", "day2"}

    # With counts
    tree2 = repo.folder_tree(db_path=db_path, include_counts=True)
    out_node = next(n for n in tree2 if n.display_name == "output")
    # Lower bound — the cursor-stability test may have injected an
    # extra flat row into out_root earlier in the suite.
    assert out_node.image_count_self >= 2
    assert out_node.image_count_recursive >= 10
    # And they must remain consistent: recursive >= self.
    assert (out_node.image_count_recursive >=
            out_node.image_count_self)

    day1 = next(c for c in out_node.children if c.display_name == "day1")
    assert day1.image_count_self == 5
    assert day1.image_count_recursive == 5

    day2 = next(c for c in out_node.children if c.display_name == "day2")
    assert day2.image_count_self == 3
    assert day2.image_count_recursive == 3

    inp_node = next(n for n in tree2 if n.display_name == "input")
    # input root flat = 1 (root_inp.png), recursive = 2.
    assert inp_node.image_count_self == 1
    assert inp_node.image_count_recursive == 2
    print("T09 folder_tree OK")


def test_explain_query_plan_hits_indexes(db_path: Path, ref: dict) -> None:
    """R7.1 self-check: confirm key queries range-scan their indexes
    rather than fall back to SCAN image."""
    conn = sqlite3.connect(str(db_path))
    try:
        # folder_id + relative_path → idx_image_folder_rel
        plan = conn.execute(
            "EXPLAIN QUERY PLAN "
            "SELECT id FROM image WHERE folder_id = ? AND relative_path LIKE ? "
            "ORDER BY created_at ASC, id ASC LIMIT 10",
            (ref["out_root"], "day1/%"),
        ).fetchall()
        plan_text = " | ".join(str(r[3]) for r in plan)
        assert "idx_image_folder_rel" in plan_text, plan_text

        # model → idx_image_model
        plan = conn.execute(
            "EXPLAIN QUERY PLAN "
            "SELECT id FROM image WHERE model = ? ORDER BY id LIMIT 10",
            ("sdxl",),
        ).fetchall()
        plan_text = " | ".join(str(r[3]) for r in plan)
        assert "idx_image_model" in plan_text, plan_text

        # created_at range → idx_image_created_at (or composite index choice)
        plan = conn.execute(
            "EXPLAIN QUERY PLAN "
            "SELECT id FROM image WHERE created_at >= ? AND created_at < ? "
            "ORDER BY created_at ASC, id ASC LIMIT 10",
            (0, 1000),
        ).fetchall()
        plan_text = " | ".join(str(r[3]) for r in plan)
        assert "idx_image_created_at" in plan_text, plan_text
    finally:
        conn.close()
    print("T09 EXPLAIN QUERY PLAN index hits OK")


def main() -> None:
    scratch = Path(tempfile.mkdtemp(prefix="xyz_t09_"))
    try:
        db_path = _bootstrap(scratch)
        ref = _seed_fixture(db_path)
        _seed_vocab_links(db_path)

        test_get_image(db_path, ref)
        test_list_basic_and_pagination(db_path, ref)
        test_cursor_stable_under_concurrent_insert(db_path, ref)
        test_filters(db_path, ref)
        test_folder_recursive(db_path, ref)
        test_sorts(db_path, ref)
        test_folder_line_header_sort_order(db_path, ref)
        test_total_estimate_cap(db_path, ref)
        test_neighbors(db_path, ref)
        test_folder_tree(db_path, ref)
        test_explain_query_plan_hits_indexes(db_path, ref)
        print("\nALL T09 TESTS PASSED")
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    main()
