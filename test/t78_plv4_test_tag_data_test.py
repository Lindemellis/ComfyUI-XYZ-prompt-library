"""The isolated ComfyUI must have usable tags without replacing test data."""
import importlib.util
from pathlib import Path
import sqlite3


spec = importlib.util.spec_from_file_location(
    "xyz_test_prepare", Path(__file__).parent / "manual/prepare_xyz_test_comfy.py")
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


def tag_db(path, names):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE tags (name TEXT)")
    conn.executemany("INSERT INTO tags VALUES (?)", [(name,) for name in names])
    conn.commit()
    return conn


def test_seeding_includes_committed_wal_and_keeps_source_independent(tmp_path):
    source, target = tmp_path / "source.sqlite", tmp_path / "test/tags.sqlite"
    with tag_db(source, ["1girl"]) as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("INSERT INTO tags VALUES ('blue_eyes')")
        conn.commit()
        assert prepare.seed_tag_data(source, target)
        with sqlite3.connect(target) as copied:
            assert copied.execute("SELECT name FROM tags").fetchall() == [("1girl",), ("blue_eyes",)]
            copied.execute("INSERT INTO tags VALUES ('test_only')")
        assert conn.execute("SELECT COUNT(*) FROM tags").fetchone()[0] == 2


def test_refresh_does_not_replace_populated_test_database(tmp_path):
    source, target = tmp_path / "source.sqlite", tmp_path / "test.sqlite"
    tag_db(source, ["1girl"]).close()
    tag_db(target, ["test_only"]).close()
    assert not prepare.seed_tag_data(source, target)
    with sqlite3.connect(target) as copied:
        assert copied.execute("SELECT name FROM tags").fetchall() == [("test_only",)]


def test_empty_test_database_is_seeded_but_absent_source_is_skipped(tmp_path):
    source, target = tmp_path / "source.sqlite", tmp_path / "test.sqlite"
    tag_db(source, ["1girl"]).close()
    tag_db(target, []).close()
    assert prepare.seed_tag_data(source, target)
    assert not prepare.seed_tag_data(tmp_path / "absent.sqlite", tmp_path / "untouched.sqlite")
    assert not (tmp_path / "untouched.sqlite").exists()
