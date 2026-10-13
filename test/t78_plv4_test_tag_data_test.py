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


def test_code_refresh_copies_shared_backend_and_keeps_existing_user_data(tmp_path, monkeypatch):
    source, target = tmp_path / "source-pack", tmp_path / "test-root"
    source.mkdir()
    files = {
        "__init__.py": "# node pack\n",
        "prompt_shared/__init__.py": "# shared backend\n",
        "prompt_shared/storage.py": "# single writer\n",
        "prompt_shared/language/compile/__init__.py": "# compiler\n",
        "js/prompt_shared/node_host.js": "// shared frontend\n",
    }
    for name, text in files.items():
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    pack = target / "custom_nodes/ComfyUI-XYZNodes"
    protected = {
        pack / "prompt_library_v4_data/plv4-pools.db": b"existing Library",
        target / "user/default/workflows/edited.json": b"existing workflow",
        target / "user/default/comfy.settings.json": b"existing settings",
    }
    for path, contents in protected.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(contents)
    tags = pack / "tagdb_data/danbooru.sqlite"
    tags.parent.mkdir(parents=True)
    tag_db(tags, ["user_tag"]).close()
    monkeypatch.setattr(prepare, "REPO", source)
    prepare.prepare(target)
    for name, text in files.items():
        assert (pack / name).read_text(encoding="utf-8") == text
    for path, contents in protected.items():
        assert path.read_bytes() == contents
    with sqlite3.connect(tags) as conn:
        assert conn.execute("SELECT name FROM tags").fetchall() == [("user_tag",)]
