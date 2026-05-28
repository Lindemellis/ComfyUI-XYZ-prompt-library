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


def test_translation_search():
    from tagdb.snapshots import rebuild_fts
    p = _tmp_db()
    c = _db.connect_write(p); _db.migrate(c)
    c.execute("INSERT INTO tags(name,category,post_count) VALUES('hakurei_reimu',4,500000)")
    c.execute("INSERT INTO translations(tag,lang,text) VALUES('hakurei_reimu','other','博麗霊夢 霊夢 reimu')")
    rebuild_fts(c); c.close()
    for q in ["博麗霊夢", "霊夢", "reimu"]:
        res = _repo.search_tags(q, p, limit=3)
        assert res and res[0]["name"] == "hakurei_reimu", f"{q} -> {res}"
        assert res[0]["translations"], "translations not returned"


def test_reconstruct_as_of():
    p = _tmp_db().parent
    src = p / "work.sqlite"
    c = _db.connect_write(src); _db.migrate(c)
    now = int(time.time()); old = now - 100 * 86400; new = now - 10 * 86400
    c.execute("INSERT INTO tags(name,category,post_count,danbooru_id,created_at) VALUES('cat_a',0,100,1,?)", (old,))
    c.execute("INSERT INTO tag_versions(version_id,tag_id,name,category,is_deprecated,created_at,synced_at) VALUES(10,1,'cat_a',4,0,?,?)", (new, now))
    c.execute("INSERT INTO tags(name,category,post_count,danbooru_id,created_at) VALUES('cat_b',0,50,2,?)", (new,))
    c.execute("INSERT INTO aliases(alias,canonical,created_at,synced_at) VALUES('old_name','cat_a',?,?)", (new, now))
    c.close()
    x = now - 50 * 86400
    out = p / "recon.sqlite"
    _up.reconstruct_as_of(src, x, out)
    c = _db.connect_read(out)
    rows = {r[0]: r[1] for r in c.execute("SELECT name, category FROM tags")}
    c.close()
    assert "cat_b" not in rows           # didn't exist at X
    assert "old_name" in rows            # cat_a's name rolled back
    assert rows["old_name"] == 0         # category as of X (before recat to 4)


def test_reconstruct_artist_multilevel_rename():
    p = _tmp_db().parent
    src = p / "work.sqlite"
    c = _db.connect_write(src); _db.migrate(c)
    now = int(time.time())
    d1, d2, d3 = now - 1500 * 86400, now - 700 * 86400, now - 60 * 86400
    c.execute("INSERT INTO tags(name,category,post_count,danbooru_id,created_at) VALUES('bunchi',1,385,99,?)", (d1,))
    for vid, (nm, ca) in enumerate([("o_(jshn3457)", d1), ("otintin", d2), ("bunchi", d3)], 1):
        c.execute("INSERT INTO artist_versions(version_id,artist_id,name,created_at,synced_at) VALUES(?,?,?,?,?)", (vid, 7, nm, ca, now))
    c.close()

    def recon(days_ago):
        x = now - days_ago * 86400
        out = p / f"r{days_ago}.sqlite"
        if out.exists():
            out.unlink()
        _up.reconstruct_as_of(src, x, out)
        cc = _db.connect_read(out)
        names = [r[0] for r in cc.execute("SELECT name FROM tags")]
        cc.close()
        return names

    assert recon(1000) == ["o_(jshn3457)"]   # o_ era
    assert recon(10) == ["bunchi"]            # current
    assert recon(2000) == []                  # before the tag existed


# ── gelbooru source: mappers + merged search (network-free) ────────────────────

def _build_source_db(path: Path, source: str, rows) -> Path:
    """rows: list of (name, category, post_count, is_deprecated). Builds + FTS."""
    from tagdb.snapshots import rebuild_fts
    conn = _db.connect_write(path)
    _db.migrate(conn)
    conn.execute("BEGIN")
    for name, cat, pc, dep in rows:
        conn.execute(
            "INSERT INTO tags(name,source,category,post_count,is_deprecated) VALUES(?,?,?,?,?)",
            (name, source, cat, pc, dep),
        )
    conn.execute("COMMIT")
    rebuild_fts(conn)
    conn.close()
    return path


def test_gelbooru_category_map_and_deprecated():
    # 0/1/3/4/5 map 1:1; type 6 → general(0) + is_deprecated=1.
    assert _sc._map_gelbooru_tag({"name": "wlop", "count": 5, "type": 1})["category"] == 1
    assert _sc._map_gelbooru_tag({"name": "x", "count": 1, "type": 5})["category"] == 5
    dep = _sc._map_gelbooru_tag({"name": "1firl", "count": 9, "type": 6})
    assert dep["category"] == 0 and dep["is_deprecated"] == 1


def test_gelbooru_alias_page_parse_and_end():
    row = (
        '<tr class="even"><td><a href="index.php?page=post&amp;s=list&amp;tags=evangelion">'
        'evangelion</a> <span class="tag-count">119</span> <b>&rarr;</b> '
        '<a href="index.php?page=post&amp;s=list&amp;tags=neon_genesis_evangelion">'
        'neon genesis evangelion</a></td></tr>'
    )
    pairs, n = _sc._parse_gelbooru_alias_page('<div id="aliases">' + row)
    assert pairs == [("evangelion", "neon_genesis_evangelion")] and n == 1
    # past-the-end page: only the header <tr> (no class) → 0 data rows → terminates.
    empty = '<div id="aliases"><table><tr><th>Tags</th></tr></table>'
    pairs2, n2 = _sc._parse_gelbooru_alias_page(empty)
    assert pairs2 == [] and n2 == 0


def test_gelbooru_tags_require_credentials():
    import pytest
    with pytest.raises(_sc.ScraperDependencyError):
        list(_sc.scrape_gelbooru_tags(api_key=None, user_id=None))


def test_search_tags_multi_merge_dedupe_and_authority():
    d = Path(tempfile.mkdtemp())
    dan = _build_source_db(d / "dan.sqlite", "danbooru", [
        ("hatsune_miku", 4, 900000, 0),     # character
        ("dan_only_artist", 1, 5000, 0),
    ])
    gel = _build_source_db(d / "gel.sqlite", "gelbooru", [
        ("hatsune_miku", 0, 800000, 0),     # conflict: gelbooru says general
        ("gel_only_tag", 0, 42000, 0),
    ])
    sources = [("danbooru", dan, None), ("gelbooru", gel, None)]

    rows = {r["name"]: r for r in _repo.search_tags_multi(sources, "miku", 10)}
    miku = rows["hatsune_miku"]
    assert miku["sources"] == ["danbooru", "gelbooru"]
    assert miku["category"] == 4                      # danbooru authoritative
    assert miku["post_count"] == 900000               # max across sources
    assert miku["post_counts"] == {"danbooru": 900000, "gelbooru": 800000}

    only = {r["name"]: r["sources"] for r in _repo.search_tags_multi(sources, "only", 10)}
    assert only["gel_only_tag"] == ["gelbooru"]
    assert only["dan_only_artist"] == ["danbooru"]

    # single-source result keeps the legacy shape (no `sources` key)
    legacy = _repo.search_tags("miku", dan, 10)
    assert legacy and "sources" not in legacy[0]


if __name__ == "__main__":
    import pytest
    pytest.main([__file__, "-v"])
