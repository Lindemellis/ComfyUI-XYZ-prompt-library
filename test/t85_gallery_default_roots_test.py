"""Default roots follow the CURRENT instance's output/input.

gallery.sqlite is shared by every ComfyUI that loads the pack; an isolated
instance must not leave its dirs behind as built-in roots, and must never
delete the index of another instance's roots.
"""
from __future__ import annotations

import shutil
import sys
import tempfile
import types
from pathlib import Path

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))


def _roots(db_path):
    from gallery import db
    conn = db.connect_read(db_path)
    try:
        return {r["path"]: (r["kind"], r["removable"]) for r in conn.execute(
            "SELECT path, kind, removable FROM folder WHERE parent_id IS NULL")}
    finally:
        conn.close()


def _start(fake, scratch, db_path, wq, name):
    from gallery import folders
    out, inp = scratch / name / "output", scratch / name / "input"
    fake.get_output_directory = lambda: str(out)
    fake.get_input_directory = lambda: str(inp)
    folders.ensure_default_roots(db_path=db_path, data_dir=scratch, write_queue=wq)
    return out.resolve().as_posix(), inp.resolve().as_posix()


def test_default_roots_follow_current_instance(monkeypatch) -> None:
    from gallery import db, repo

    scratch = Path(tempfile.mkdtemp(prefix="xyz_defroots_"))
    fake = types.ModuleType("folder_paths")
    monkeypatch.setitem(sys.modules, "folder_paths", fake)
    try:
        db_path = scratch / "g.sqlite"
        conn = db.connect_write(db_path)
        try:
            db.migrate(conn)
        finally:
            conn.close()
        wq = repo.WriteQueue(db_path)
        wq.start()
        try:
            real_out, real_in = _start(fake, scratch, db_path, wq, "real")
            custom = (scratch / "mine").resolve().as_posix()
            wq.enqueue_write(repo.HIGH, repo.EnsureFolderOp(
                path=custom, kind="custom", removable=1, display_name="mine",
            )).result(timeout=5)
            conn = db.connect_write(db_path)
            try:
                rid = conn.execute("SELECT id FROM folder WHERE path = ?",
                                   (real_out,)).fetchone()[0]
                conn.execute(
                    "INSERT INTO image(path, folder_id, relative_path, filename, "
                    "filename_lc, ext, file_size, mtime_ns, created_at, indexed_at) "
                    "VALUES (?, ?, 'a.png', 'a.png', 'a.png', 'png', 1, 1, 1, 1)",
                    (real_out + "/a.png", rid),
                )
                conn.commit()
            finally:
                conn.close()

            iso_out, iso_in = _start(fake, scratch, db_path, wq, "iso")
            roots = _roots(db_path)
            assert roots[iso_out] == ("output", 0)
            assert roots[iso_in] == ("input", 0)
            assert roots[real_out] == ("custom", 1)
            assert roots[real_in] == ("custom", 1)
            assert roots[custom] == ("custom", 1)

            _start(fake, scratch, db_path, wq, "real")
            roots = _roots(db_path)
            assert roots[real_out] == ("output", 0)
            assert roots[real_in] == ("input", 0)
            assert roots[iso_out] == ("custom", 1)
            assert roots[iso_in] == ("custom", 1)
            assert roots[custom] == ("custom", 1)
            conn = db.connect_read(db_path)
            try:
                n = conn.execute("SELECT COUNT(*) FROM image WHERE folder_id = ?",
                                 (rid,)).fetchone()[0]
            finally:
                conn.close()
            assert n == 1
        finally:
            wq.stop()
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
