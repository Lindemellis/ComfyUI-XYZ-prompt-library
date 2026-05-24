"""TagDB offline tests — V2 migration, full/incremental provenance, related cache.

Network-free: the danbooru scrapers are monkeypatched with canned generators, so
these run in CI without hitting danbooru.

    python -m pytest test/t_tagdb_test.py -v
"""
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from tagdb import db as _db
from tagdb import repo as _repo
from tagdb import scraper as _sc
from tagdb import updater as _up


def _tmp_db() -> Path:
    return Path(tempfile.mkdtemp()) / "tagdb.sqlite"


# ── migration ────────────────────────────────────────────────────────────────

def test_migrate_v1_to_v2():
    p = _tmp_db()
    # Simulate an existing V1 file.
    conn = _db.connect_write(p)
    conn.executescript(_db._V1_DDL)
    conn.execute("PRAGMA user_version = 1")
    conn.execute("INSERT INTO meta(key,value) VALUES('created_at','1700000000')")
    conn.execute("INSERT INTO tags(name,category,post_count) VALUES('1girl',0,100)")
    conn.close()

    conn = _db.connect_write(p)
    _db.migrate(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 2
    cols = {r[1] for r in conn.execute("PRAGMA table_info(tags)")}
    assert {"danbooru_id", "created_at", "post_count_synced_at", "structure_synced_at"} <= cols
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    assert {"tag_versions", "artist_versions", "related_tags"} <= tables
    meta = dict(conn.execute("SELECT key,value FROM meta"))
    assert meta["structure_synced_through"] == "1700000000"
    assert meta["full_count_synced_at"] == "1700000000"
    # existing row backfilled to created_at
    pcs = conn.execute("SELECT post_count_synced_at FROM tags WHERE name='1girl'").fetchone()[0]
    assert pcs == 1700000000
    _db.migrate(conn)  # idempotent
    conn.close()


# ── full + incremental provenance ─────────────────────────────────────────────

def _patch_scrapers(monkeypatch, tags=None, aliases=None, new_tags=None,
                    tag_versions=None, artist_versions=None, new_aliases=None):
    monkeypatch.setattr(_sc, "scrape_tags", lambda **k: iter(tags or []))
    monkeypatch.setattr(_sc, "scrape_aliases", lambda **k: iter(aliases or []))
    monkeypatch.setattr(_sc, "scrape_tags_since", lambda e, **k: iter(new_tags or []))
    monkeypatch.setattr(_sc, "scrape_tag_versions_since", lambda e, **k: iter(tag_versions or []))
    monkeypatch.setattr(_sc, "scrape_artist_versions_since", lambda e, **k: iter(artist_versions or []))
    monkeypatch.setattr(_sc, "scrape_aliases_since", lambda e, **k: iter(new_aliases or []))


def test_full_then_incremental_provenance(monkeypatch):
    p = _tmp_db()
    _patch_scrapers(
        monkeypatch,
        tags=[
            {"danbooru_id": 1, "name": "1girl", "category": 0, "post_count": 100,
             "is_deprecated": 0, "created_at": 1000},
            {"danbooru_id": 2, "name": "solo", "category": 0, "post_count": 50,
             "is_deprecated": 0, "created_at": 1000},
        ],
        aliases=[{"alias": "1girls", "canonical": "1girl", "created_at": 1000}],
    )
    s = _up.run_full_update(p, min_post_count=1)
    assert s["tags"] == 2 and s["aliases"] == 1

    conn = _db.connect_read(p)
    meta = dict(conn.execute("SELECT key,value FROM meta"))
    # full sets all three clocks equal to the same `now`
    assert meta["full_count_synced_at"] == meta["structure_synced_through"]
    pcs_solo_before = conn.execute(
        "SELECT post_count_synced_at FROM tags WHERE name='solo'").fetchone()[0]
    conn.close()

    # Back-date the watermark, then run incremental that only re-categorises 1girl.
    cw = _db.connect_write(p)
    cw.execute("UPDATE meta SET value='500' WHERE key='structure_synced_through'")
    cw.close()
    _patch_scrapers(
        monkeypatch,
        tag_versions=[
            {"version_id": 10, "tag_id": 1, "name": "1girl", "category": 4,
             "is_deprecated": 0, "created_at": 800, "previous_version_id": None},
        ],
    )
    s2 = _up.run_incremental_update(p, min_post_count=1)
    assert s2["tag_versions"] == 1

    conn = _db.connect_read(p)
    # 1girl recategorised to 4, but its post_count untouched (incremental rule)
    row = conn.execute("SELECT category, post_count FROM tags WHERE name='1girl'").fetchone()
    assert row[0] == 4 and row[1] == 100
    # solo (untouched) keeps its old count-sync stamp — provenance not scrambled
    pcs_solo_after = conn.execute(
        "SELECT post_count_synced_at FROM tags WHERE name='solo'").fetchone()[0]
    assert pcs_solo_after == pcs_solo_before
    # watermark advanced to the consumed event time (800), not blindly to now
    wm = int(dict(conn.execute("SELECT key,value FROM meta"))["structure_synced_through"])
    assert wm == 800
    # event log persisted
    assert conn.execute("SELECT COUNT(*) FROM tag_versions").fetchone()[0] == 1
    conn.close()


def test_incremental_requires_baseline():
    p = _tmp_db()
    conn = _db.connect_write(p); _db.migrate(conn); conn.close()
    try:
        _up.run_incremental_update(p, min_post_count=1)
        assert False, "expected IncrementalBaselineError"
    except _up.IncrementalBaselineError:
        pass


# ── related cache ──────────────────────────────────────────────────────────────

def test_related_cache_roundtrip():
    p = _tmp_db()
    conn = _db.connect_write(p); _db.migrate(conn); conn.close()
    rows = [
        {"related_tag": "ice", "category": 0, "cosine": 0.5, "jaccard": 0.2,
         "overlap": 0.4, "rank": 0},
        {"related_tag": "ice_wings", "category": 0, "cosine": 0.6, "jaccard": 0.3,
         "overlap": 0.9, "rank": 1},
    ]
    _repo.store_related(p, "cirno", rows)
    cached = _repo.get_cached_related(p, "cirno", limit=10)
    assert cached is not None
    assert [r["name"] for r in cached["related"]] == ["ice", "ice_wings"]
    assert cached["synced_at"] <= int(time.time())


# ── listing kinds ──────────────────────────────────────────────────────────────

def test_list_snapshots_kinds():
    data_dir = Path(tempfile.mkdtemp())
    (data_dir / "snapshots" / "official").mkdir(parents=True)
    (data_dir / "snapshots" / "local").mkdir(parents=True)
    for path, kind in [(data_dir / "tagdb.sqlite", "working"),
                       (data_dir / "snapshots" / "official" / "2026-05-01_danbooru.sqlite", "official"),
                       (data_dir / "snapshots" / "local" / "2026-05-02_danbooru.sqlite", "local")]:
        c = _db.connect_write(path); _db.migrate(c)
        c.execute("INSERT INTO meta(key,value) VALUES('tag_count','1')")
        c.close()
    kinds = {s["kind"] for s in _repo.list_snapshots(data_dir)}
    assert {"working", "official", "local"} <= kinds


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
