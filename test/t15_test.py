"""T15 offline validation: vocab.normalize_prompt / Schema v3 / UpsertVocabAndLinksOp.

Runs without ComfyUI (scratch DB + WriteQueue), following test/t07_test.py style.
"""
from __future__ import annotations

import os
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))


def _assert_eq(name: str, got, exp) -> None:
    assert got == exp, f"{name}: got {got!r} expected {exp!r}"


def test_canonical_prompt() -> None:
    from gallery import vocab

    s = "(masterpiece:1.2), <lora:foo:0.7>, BREAK, masterpiece."
    _assert_eq("TASKS T15 #1", vocab.normalize_prompt(s), ["masterpiece"])


def test_fifty_corpus_rows() -> None:
    """Narrow expectations for 50 hand-written prompt fragments (TASKS #2)."""
    from gallery import vocab

    sw = frozenset()
    rows = [
        ("", []),
        ("   ", []),
        ("hello", ["hello"]),
        ("Hello WORLD", ["hello world"]),
        ("(foo:1.0)", ["foo"]),
        ("[bar:0.5]", ["bar"]),
        ("((baz))", ["baz"]),
        ("<lora:x:1>", []),
        ("<LyCo : name : 0.7 >", []),
        ("<hypernet:abc:1>", []),
        ("a, b, c", []),
        ("word, word", ["word"]),
        ("photo, photo, real", ["photo", "real"]),
        ("before BREAK after", ["before after"]),
        ("xa|yb|zc", ["xa", "yb", "zc"]),
        ("(nested (deep:2.0) test)", ["(nested deep test)"]),
        ("12345", []),
        ("3.14", []),
        ("v1.0release", ["v1.0release"]),
        ("a", []),
        ("ab", ["ab"]),
        ("x" * 65, []),
        ("  spaced  token  ", ["spaced token"]),
        (".,;:leading", ["leading"]),
        ("trailing.,", ["trailing"]),
        ("(weighted:1.2), plain", ["weighted", "plain"]),
        ("<lora:a:1>, visible", ["visible"]),
        ("foo,,,,bar", ["foo", "bar"]),
        ("mix (a:1) | (b:2)", ["mix a"]),
        ("no|pipes|here", ["no", "pipes", "here"]),
        ("{}", ["{}"]),
        ("()", ["()"]),
        ("[]", ["[]"]),
        ("back\\slash word", ["back\\slash word"]),
        ("unicode 你好", ["unicode 你好"]),
        ("café", ["café"]),
        ("repeat, repeat, repeat", ["repeat"]),
        ("(masterpiece:1.2), <lora:foo:0.7>, BREAK, masterpiece.", ["masterpiece"]),
        ("negative not here", ["negative not here"]),
        ("the, cat", ["cat"]),
        ("of, mice", ["mice"]),
        ("something AND nothing", ["something nothing"]),
        ("tag1, tag2, tag3", ["tag1", "tag2", "tag3"]),
        ("{weird:1}", ["weird"]),
        ("(xx:1.0), (yy:1.0)", ["xx", "yy"]),
        ("a,,,,,,b", []),
        ("onlystopwords", ["onlystopwords"]),
        ("the", []),
        ("hello, THE, world", ["hello", "world"]),
        ("extra", ["extra"]),
    ]
    assert len(rows) == 50, len(rows)
    for i, (inp, exp) in enumerate(rows):
        got = vocab.normalize_prompt(inp, sw)
        _assert_eq(f"row{i}", got, exp)


def test_normalize_tag_numeric_preserved() -> None:
    """Pure-digit tags are valid gallery labels (not prompt vocab tokens)."""
    from gallery import vocab

    assert vocab.normalize_tag("111") == "111"
    assert vocab.normalize_tag("  42  ") == "42"


def test_normalize_tag_joins() -> None:
    from gallery import vocab

    _assert_eq("tag1", vocab.normalize_tag("My Tag"), "my tag")
    _assert_eq("tag2", vocab.normalize_tag("(my tag:1.2)"), "my tag")
    _assert_eq("tag3", vocab.normalize_tag(""), "")


def test_stopwords_merge() -> None:
    from gallery import vocab

    sw = frozenset({"custom"})
    got = vocab.normalize_prompt("hello, custom, world", sw)
    _assert_eq("extra_sw", got, ["hello", "world"])


def test_naive_split_is_larger() -> None:
    """TASKS #4 — normalized token count << naive comma-split on messy prompts."""
    from gallery import vocab

    messy = ", ".join([f"(masterpiece:{1.0 + i / 100.0})" for i in range(80)])
    naive = [x.strip() for x in messy.split(",") if x.strip()]
    norm = vocab.normalize_prompt(messy, frozenset())
    assert len(norm) < len(naive), (len(norm), len(naive))
    assert len(norm) == 1, norm


def test_normalize_prompt_strips_trailing_ascii_period() -> None:
    from gallery import vocab

    toks = vocab.normalize_prompt("foo., bar", frozenset())
    assert "foo" in toks and "bar" in toks, toks
    assert not any(t.endswith(".") for t in toks), toks


def test_schema_v3_and_vocab_op() -> None:
    from gallery import db, repo

    scratch = Path(tempfile.mkdtemp(prefix="xyz_t15_"))
    try:
        db_path = scratch / "g.sqlite"
        conn = db.connect_write(db_path)
        try:
            db.migrate(conn)
        finally:
            conn.close()
        (uv,) = sqlite3.connect(str(db_path)).execute("PRAGMA user_version").fetchone()
        # Track SCHEMA_VERSION, not a literal: every new migration would
        # otherwise fail this test for no reason.
        assert uv == db.SCHEMA_VERSION, uv

        wq = repo.WriteQueue(db_path)
        wq.start()
        try:
            root_posix = (scratch / "out").resolve().as_posix()
            (scratch / "out").mkdir()
            fut = wq.enqueue_write(repo.HIGH, repo.EnsureFolderOp(
                path=root_posix, kind="output", removable=0,
                display_name="out",
            ))
            fut.result(timeout=5)

            rconn = db.connect_read(db_path)
            try:
                row = rconn.execute(
                    "SELECT id FROM folder WHERE parent_id IS NULL"
                ).fetchone()
            finally:
                rconn.close()
            root_id = int(row[0])
            posix = (scratch / "out" / "x.png").resolve().as_posix()
            op = repo.UpsertImageOp(
                path=posix,
                folder_id=root_id,
                root_path=root_posix,
                root_kind="output",
                relative_path="x.png",
                filename="x.png",
                filename_lc="x.png",
                ext="png",
                width=1,
                height=1,
                file_size=10,
                mtime_ns=123,
                created_at=int(time.time()),
                positive_prompt="hello, world, hello",
                negative_prompt=None,
                model=None,
                seed=None,
                cfg=None,
                steps=None,
                sampler=None,
                scheduler=None,
                workflow_present=0,
                favorite=None,
                tags_csv="alpha, beta",
                indexed_at=int(time.time()),
                prompt_tokens=["hello", "world"],
                normalized_tags=["alpha", "beta"],
            )
            wq.enqueue_write(repo.LOW, op).result(timeout=5)
        finally:
            wq.stop()

        r2 = db.connect_read(db_path)
        try:
            img = r2.execute("SELECT id FROM image WHERE path = ?", (posix,)).fetchone()
            assert img is not None
            iid = int(img[0])
            pt = r2.execute(
                "SELECT token, usage_count FROM prompt_token ORDER BY token"
            ).fetchall()
            assert [(str(r[0]), int(r[1])) for r in pt] == [("hello", 1), ("world", 1)]
            tg = r2.execute(
                "SELECT name, usage_count FROM tag ORDER BY name"
            ).fetchall()
            assert [(str(r[0]), int(r[1])) for r in tg] == [("alpha", 1), ("beta", 1)]
            npt = r2.execute(
                "SELECT COUNT(*) FROM image_prompt_token WHERE image_id = ?", (iid,)
            ).fetchone()[0]
            nit = r2.execute(
                "SELECT COUNT(*) FROM image_tag WHERE image_id = ?", (iid,)
            ).fetchone()[0]
            assert npt == 2 and nit == 2
        finally:
            r2.close()

        wq2 = repo.WriteQueue(db_path)
        wq2.start()
        try:
            op2 = repo.UpsertImageOp(
                path=posix,
                folder_id=root_id,
                root_path=root_posix,
                root_kind="output",
                relative_path="x.png",
                filename="x.png",
                filename_lc="x.png",
                ext="png",
                width=1,
                height=1,
                file_size=10,
                mtime_ns=999,
                created_at=int(time.time()),
                positive_prompt="onlyone",
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
                prompt_tokens=["onlyone"],
                normalized_tags=[],
            )
            wq2.enqueue_write(repo.LOW, op2).result(timeout=5)
        finally:
            wq2.stop()

        r3 = db.connect_read(db_path)
        try:
            pt = r3.execute(
                "SELECT token, usage_count FROM prompt_token ORDER BY token"
            ).fetchall()
            rows = [(str(r[0]), int(r[1])) for r in pt]
            # hello/world usage dropped to 0 → orphan ``prompt_token`` rows removed.
            assert rows == [("onlyone", 1)], rows
            assert r3.execute(
                "SELECT COUNT(*) FROM image_prompt_token WHERE image_id = ?",
                (iid,),
            ).fetchone()[0] == 1
            assert r3.execute(
                "SELECT token FROM prompt_token JOIN image_prompt_token "
                "ON prompt_token.id = image_prompt_token.token_id "
                "WHERE image_prompt_token.image_id = ?",
                (iid,),
            ).fetchone()[0] == "onlyone"
            # Second upsert had tags_csv=None in the op (simulates re-index with no
            # tag mirror in PNG). COALESCE preserves image.tags_csv; image_tag must
            # follow the row, not the empty in-memory tag list (otherwise usage/drift).
            tcsv = r3.execute(
                "SELECT tags_csv FROM image WHERE id = ?",
                (iid,),
            ).fetchone()[0]
            assert tcsv is not None and "alpha" in str(tcsv) and "beta" in str(tcsv)
            assert r3.execute(
                "SELECT COUNT(*) FROM image_tag WHERE image_id = ?",
                (iid,),
            ).fetchone()[0] == 2
            tnames = tuple(
                str(r[0]) for r in r3.execute(
                    "SELECT t.name FROM image_tag it "
                    "JOIN tag t ON t.id = it.tag_id WHERE it.image_id = ? "
                    "ORDER BY t.name",
                    (iid,),
                )
            )
            assert tnames == ("alpha", "beta"), tnames
        finally:
            r3.close()
    finally:
        try:
            os.chmod(scratch, 0o700)
            shutil_rmtree = __import__("shutil").rmtree
            shutil_rmtree(scratch, ignore_errors=True)
        except Exception:
            pass


def main() -> None:
    test_canonical_prompt()
    test_fifty_corpus_rows()
    test_normalize_tag_numeric_preserved()
    test_normalize_tag_joins()
    test_stopwords_merge()
    test_naive_split_is_larger()
    test_normalize_prompt_strips_trailing_ascii_period()
    test_schema_v3_and_vocab_op()
    print("t15_test: all OK")


if __name__ == "__main__":
    main()
