"""T16 offline validation — metadata_sync_* + version + partial index (TASKS.md).

No ComfyUI runtime; exercises ``gallery.db`` migration 4→5 + ``repo`` read path.
"""
from __future__ import annotations

import sqlite3
import sys
import tempfile
import time
from pathlib import Path

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))


def _migrate_to_v3_then_v4(scratch: Path) -> Path:
    """DB at user_version=3 without T16 columns, then forward migrate."""
    from gallery import db

    db_path = scratch / "gallery.sqlite"
    conn = db.connect_write(db_path)
    try:
        db.MIGRATIONS[1](conn)
        conn.execute("PRAGMA user_version = 1")
        conn.commit()
        db.MIGRATIONS[2](conn)
        conn.execute("PRAGMA user_version = 2")
        conn.commit()
        db.MIGRATIONS[3](conn)
        conn.execute("PRAGMA user_version = 3")
        conn.commit()
        conn.execute(
            "INSERT INTO folder(path, kind, parent_id, display_name, removable) "
            "VALUES (?, 'output', NULL, 'o', 0)",
            (scratch.resolve().as_posix() + "/out",),
        )
        fid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        conn.execute(
            "INSERT INTO image("
            "path, folder_id, relative_path, filename, filename_lc, ext, "
            "width, height, file_size, mtime_ns, created_at, "
            "positive_prompt, negative_prompt, model, seed, cfg, sampler, scheduler, "
            "workflow_present, favorite, tags_csv, indexed_at"
            ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                scratch.resolve().as_posix() + "/out/x.png",
                int(fid),
                "x.png",
                "x.png",
                "x.png",
                "png",
                64,
                64,
                100,
                1,
                int(time.time()),
                None,
                None,
                None,
                None,
                None,
                None,
                None,
                0,
                None,
                None,
                int(time.time()),
            ),
        )
        conn.commit()
    finally:
        conn.close()

    conn = db.connect_write(db_path)
    try:
        db.migrate(conn)
    finally:
        conn.close()
    return db_path


def test_migration_upgrade_and_backfill() -> None:
    from gallery import db

    with tempfile.TemporaryDirectory() as td:
        scratch = Path(td)
        db_path = _migrate_to_v3_then_v4(scratch)
        conn = sqlite3.connect(str(db_path))
        try:
            (uv,) = conn.execute("PRAGMA user_version").fetchone()
            assert uv == db.SCHEMA_VERSION, uv
            rows = conn.execute(
                "SELECT metadata_sync_status, metadata_sync_retry_count, "
                "metadata_sync_next_retry_at, metadata_sync_last_error, version "
                "FROM image"
            ).fetchall()
            assert len(rows) == 1
            st, rc, nxt, err, ver = rows[0]
            assert st == "ok"
            assert rc == 0
            assert nxt is None
            assert err is None
            assert ver == 0
        finally:
            conn.close()


def test_partial_index_used() -> None:
    from gallery import db

    with tempfile.TemporaryDirectory() as td:
        scratch = Path(td)
        db_path = scratch / "gallery.sqlite"
        conn = db.connect_write(db_path)
        try:
            db.migrate(conn)
            conn.execute(
                "INSERT INTO folder(path, kind, parent_id, display_name, removable) "
                "VALUES (?, 'output', NULL, 'o', 0)",
                (scratch.resolve().as_posix() + "/o",),
            )
            fid = int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
            base = scratch.resolve().as_posix() + "/o/"
            ts = int(time.time())
            # Many ``ok`` rows so the planner prefers the partial index for non-ok rows.
            for i in range(400):
                conn.execute(
                    "INSERT INTO image("
                    "path, folder_id, relative_path, filename, filename_lc, ext, "
                    "width, height, file_size, mtime_ns, created_at, "
                    "positive_prompt, negative_prompt, model, seed, cfg, sampler, scheduler, "
                    "workflow_present, favorite, tags_csv, indexed_at"
                    ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        base + f"b{i}.png",
                        fid,
                        f"b{i}.png",
                        f"b{i}.png",
                        f"b{i}.png",
                        "png",
                        1,
                        1,
                        1,
                        1,
                        ts,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        None,
                        0,
                        None,
                        None,
                        ts,
                    ),
                )
            conn.execute(
                "INSERT INTO image("
                "path, folder_id, relative_path, filename, filename_lc, ext, "
                "width, height, file_size, mtime_ns, created_at, "
                "positive_prompt, negative_prompt, model, seed, cfg, sampler, scheduler, "
                "workflow_present, favorite, tags_csv, indexed_at"
                ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    base + "p.png",
                    fid,
                    "p.png",
                    "p.png",
                    "p.png",
                    "png",
                    1,
                    1,
                    1,
                    1,
                    ts,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    0,
                    None,
                    None,
                    ts,
                ),
            )
            conn.commit()
            (iid,) = conn.execute(
                "SELECT id FROM image WHERE path = ?", (base + "p.png",)
            ).fetchone()
            conn.execute(
                "UPDATE image SET metadata_sync_status = 'pending' WHERE id = ?",
                (int(iid),),
            )
            conn.commit()
            (idx_sql,) = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_image_sync'"
            ).fetchone()
            assert idx_sql and "metadata_sync_status" in idx_sql
            assert "!=" in idx_sql or "!='ok'" in idx_sql.replace(" ", "")
            conn.execute("ANALYZE image")
            conn.commit()
            # Planner uses ``!= 'ok'`` / ``IS NOT 'ok'`` → covering idx_image_sync;
            # ``= 'pending'`` may table-scan even when tiny result (SQLite quirk).
            plan = conn.execute(
                "EXPLAIN QUERY PLAN SELECT id FROM image "
                "WHERE metadata_sync_status != 'ok'"
            ).fetchall()
            blob = "\n".join(str(r) for r in plan)
            assert "idx_image_sync" in blob, blob
        finally:
            conn.close()


def test_repo_roundtrip() -> None:
    from gallery import db, repo

    with tempfile.TemporaryDirectory() as td:
        scratch = Path(td)
        db_path = scratch / "gallery.sqlite"
        conn = db.connect_write(db_path)
        try:
            db.migrate(conn)
            conn.execute(
                "INSERT INTO folder(path, kind, parent_id, display_name, removable) "
                "VALUES (?, 'output', NULL, 'o', 0)",
                (scratch.resolve().as_posix() + "/r",),
            )
            fid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            conn.execute(
                "INSERT INTO image("
                "path, folder_id, relative_path, filename, filename_lc, ext, "
                "width, height, file_size, mtime_ns, created_at, "
                "positive_prompt, negative_prompt, model, seed, cfg, sampler, scheduler, "
                "workflow_present, favorite, tags_csv, indexed_at"
                ") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    scratch.resolve().as_posix() + "/r/z.png",
                    int(fid),
                    "z.png",
                    "z.png",
                    "z.png",
                    "png",
                    2,
                    2,
                    2,
                    2,
                    int(time.time()),
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    None,
                    0,
                    None,
                    None,
                    int(time.time()),
                ),
            )
            conn.commit()
            (iid,) = conn.execute(
                "SELECT id FROM image ORDER BY id DESC LIMIT 1"
            ).fetchone()
        finally:
            conn.close()

        rec = repo.get_image(int(iid), db_path=db_path)
        assert rec is not None
        assert rec.sync_status == "ok"
        assert rec.version == 0


def main() -> None:
    test_migration_upgrade_and_backfill()
    print("t16 #1 migration + backfill OK")
    test_partial_index_used()
    print("t16 #2 EXPLAIN partial index OK")
    test_repo_roundtrip()
    print("t16 #3 repo ImageRecord OK")


if __name__ == "__main__":
    main()
