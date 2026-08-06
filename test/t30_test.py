"""T30 offline: §8.8 v1.1 step-4 removal + full prompt_token rebuild (no ComfyUI)."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))


def test_normalize_preserves_escaped_parens() -> None:
    from gallery import vocab

    got = vocab.normalize_prompt(r"yd \(orange maru\)", frozenset())
    assert got == ["yd (orange maru)"], got


def test_prompt_vocab_pipeline_version() -> None:
    from gallery import vocab

    assert vocab.PROMPT_VOCAB_PIPELINE_VERSION == 2


def test_rebuild_prompt_vocab_full_op() -> None:
    from gallery import db, repo, vocab

    scratch = Path(tempfile.mkdtemp(prefix="xyz_t30_"))
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
            root_posix = (scratch / "out").resolve().as_posix()
            (scratch / "out").mkdir()
            wq.enqueue_write(
                repo.HIGH,
                repo.EnsureFolderOp(
                    path=root_posix,
                    kind="output",
                    removable=0,
                    display_name="out",
                ),
            ).result(timeout=5)
            rconn = db.connect_read(db_path)
            try:
                row = rconn.execute(
                    "SELECT id FROM folder WHERE parent_id IS NULL",
                ).fetchone()
            finally:
                rconn.close()
            root_id = int(row[0])
            posix = (scratch / "out" / "z.png").resolve().as_posix()
            raw_pp = r"yd \(orange maru\), hello"
            toks = vocab.normalize_prompt(raw_pp, frozenset())
            wq.enqueue_write(
                repo.LOW,
                repo.UpsertImageOp(
                    path=posix,
                    folder_id=root_id,
                    root_path=root_posix,
                    root_kind="output",
                    relative_path="z.png",
                    filename="z.png",
                    filename_lc="z.png",
                    ext="png",
                    width=1,
                    height=1,
                    file_size=10,
                    mtime_ns=1,
                    created_at=int(time.time()),
                    positive_prompt=raw_pp,
                    negative_prompt=None,
                    model=None,
                    seed=None,
                    cfg=None,
                    steps=None,
                    sampler=None,
                    scheduler=None,
                    workflow_present=0,
                    favorite=None,
                    tags_csv=None,
                    indexed_at=int(time.time()),
                    prompt_tokens=toks,
                    normalized_tags=[],
                ),
            ).result(timeout=5)

            pt_before = db.connect_read(db_path).execute(
                "SELECT token FROM prompt_token ORDER BY token",
            ).fetchall()
            assert pt_before, pt_before

            wq.enqueue_write(
                repo.HIGH,
                repo.RebuildPromptVocabFullOp(extra_stopwords=frozenset()),
            ).result(timeout=5)
        finally:
            wq.stop()

        r2 = db.connect_read(db_path)
        try:
            toks2 = [
                str(r[0])
                for r in r2.execute(
                    "SELECT prompt_token.token FROM image_prompt_token ipt "
                    "INNER JOIN prompt_token ON prompt_token.id = ipt.token_id "
                    "JOIN image ON image.id = ipt.image_id "
                    "WHERE image.path = ? ORDER BY prompt_token.token",
                    (posix,),
                ).fetchall()
            ]
            assert toks2 == sorted(toks), (toks2, toks)
        finally:
            r2.close()
    finally:
        try:
            os.chmod(scratch, 0o700)
            __import__("shutil").rmtree(scratch, ignore_errors=True)
        except Exception:
            pass


def test_maybe_rebuild_prompt_vocab_bumps_config() -> None:
    from gallery import db, indexer, repo

    scratch = Path(tempfile.mkdtemp(prefix="xyz_t30cfg_"))
    try:
        db_path = scratch / "g.sqlite"
        conn = db.connect_write(db_path)
        try:
            db.migrate(conn)
        finally:
            conn.close()

        cfg_path = scratch / "gallery_config.json"
        cfg_path.write_text(
            json.dumps(
                {"roots": [], "prompt_stopwords": [], "vocab_version": 1},
                indent=2,
            ),
            encoding="utf-8",
        )

        wq = repo.WriteQueue(db_path)
        wq.start()
        try:
            indexer.maybe_rebuild_prompt_vocab_from_config(
                db_path=db_path,
                data_dir=scratch,
                write_queue=wq,
            )
        finally:
            wq.stop()

        data = json.loads(cfg_path.read_text(encoding="utf-8"))
        assert int(data["vocab_version"]) == 2, data
    finally:
        try:
            os.chmod(scratch, 0o700)
            __import__("shutil").rmtree(scratch, ignore_errors=True)
        except Exception:
            pass


def main() -> None:
    test_normalize_preserves_escaped_parens()
    test_prompt_vocab_pipeline_version()
    test_rebuild_prompt_vocab_full_op()
    test_maybe_rebuild_prompt_vocab_bumps_config()
    print("t30_test: all OK")


if __name__ == "__main__":
    main()
