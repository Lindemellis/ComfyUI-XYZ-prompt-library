"""T08 offline validation script.

Mirrors TASKS.md T08 test plan (D.1 schema migration + D.2 request /
touch / mtime invalidation / concurrent dedup) on a scratch DB + scratch
thumbs dir so the real gallery_data/ is never touched. Style follows
test/t07_test.py.
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import time
from pathlib import Path

# Allow running as ``python test/t08_test.py`` from the plugin root by
# putting that root on sys.path so ``import gallery`` resolves.
_PLUGIN_ROOT = Path(__file__).resolve().parent.parent
if str(_PLUGIN_ROOT) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_ROOT))

from PIL import Image


def _make_png(dst: Path, color: str = "red", size=(64, 64)) -> int:
    dst.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", size, color).save(dst, format="PNG")
    return dst.stat().st_size


def _insert_image_row(db_path: Path, *, image_id: int, posix_path: str,
                      folder_id: int, mtime_ns: int, file_size: int) -> None:
    """Bypass indexer: stuff a minimal image row directly (test-only).

    Production writes go through WriteQueue; here we only need a row that
    carries a valid (path, mtime_ns) pair for thumbs.request to resolve.
    """
    conn = sqlite3.connect(str(db_path))
    try:
        filename = os.path.basename(posix_path)
        conn.execute(
            "INSERT OR REPLACE INTO image("
            "id, path, folder_id, relative_path, filename, filename_lc, ext, "
            "file_size, mtime_ns, created_at, workflow_present, indexed_at"
            ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (image_id, posix_path, folder_id, filename, filename,
             filename.lower(), Path(posix_path).suffix.lstrip("."),
             file_size, mtime_ns, int(mtime_ns // 1_000_000_000),
             0, int(time.time())),
        )
        conn.commit()
    finally:
        conn.close()


def _run_d1(scratch: Path) -> None:
    """D.1 — schema v2 migration (fresh DB + forced re-run)."""
    from gallery import db

    db_path = scratch / "d1.sqlite"

    # Fresh migrate: 0 → SCHEMA_VERSION (v1…v5).
    conn = db.connect_write(db_path)
    try:
        db.migrate(conn)
    finally:
        conn.close()
    rc = db.connect_read(db_path)
    try:
        (uv,) = rc.execute("PRAGMA user_version").fetchone()
        assert uv == db.SCHEMA_VERSION, f"expected user_version={db.SCHEMA_VERSION}, got {uv}"
        cols = {r[1] for r in rc.execute("PRAGMA table_info(thumbnail_cache)")}
        assert cols == {"hash_key", "image_id", "size_bytes",
                        "created_at", "last_accessed"}, cols
        idx_names = {r[1] for r in rc.execute(
            "PRAGMA index_list(thumbnail_cache)")}
        assert "idx_thumb_last_accessed" in idx_names, idx_names
        assert "idx_thumb_image_id" in idx_names, idx_names
    finally:
        rc.close()
    print(f"D.1 OK (fresh) — user_version={db.SCHEMA_VERSION}, thumbnail_cache + T16 sync + model canon + word_token + steps")

    # Forced replay: user_version=0 → latest, idempotent DDL (IF NOT EXISTS).
    conn = db.connect_write(db_path)
    try:
        conn.execute("PRAGMA user_version = 0")
        conn.commit()
        db.migrate(conn)
    finally:
        conn.close()
    rc = db.connect_read(db_path)
    try:
        (uv,) = rc.execute("PRAGMA user_version").fetchone()
        assert uv == db.SCHEMA_VERSION
        # Table still there, not duplicated.
        (n,) = rc.execute(
            "SELECT COUNT(*) FROM sqlite_master "
            "WHERE type='table' AND name='thumbnail_cache'"
        ).fetchone()
        assert n == 1
    finally:
        rc.close()
    print(f"D.1 OK (idempotent replay) — user_version=0 → {db.SCHEMA_VERSION} without dup tables")


def _run_d2(scratch: Path) -> None:
    """D.2 — T08 official acceptance (tests #1..#4)."""
    from gallery import db, repo, thumbs

    db_path = scratch / "gallery.sqlite"
    thumbs_dir = scratch / "thumbs"
    root_dir = scratch / "output"
    root_dir.mkdir()
    thumbs_dir.mkdir()

    # bootstrap DB
    conn = db.connect_write(db_path)
    try:
        db.migrate(conn)
    finally:
        conn.close()

    wq = repo.WriteQueue(db_path)
    wq.start()
    try:
        # Register one root (needed for folder_id FK on the image row).
        wq.enqueue_write(repo.HIGH, repo.EnsureFolderOp(
            path=Path(root_dir).as_posix(), kind="output",
            removable=0, display_name=root_dir.name,
        )).result(timeout=5)
        rc = db.connect_read(db_path)
        try:
            root_id = int(rc.execute(
                "SELECT id FROM folder WHERE parent_id IS NULL"
            ).fetchone()[0])
        finally:
            rc.close()

        src = root_dir / "a.png"
        file_size = _make_png(src)
        st = os.stat(src)
        posix = Path(src).as_posix()
        _insert_image_row(
            db_path, image_id=1, posix_path=posix,
            folder_id=root_id, mtime_ns=st.st_mtime_ns,
            file_size=st.st_size,
        )

        # ---- T08 test #1: first generates, second hits disk ---------
        p1 = thumbs.request(1, db_path=db_path,
                            thumbs_dir=thumbs_dir, write_queue=wq)
        assert p1 is not None and p1.exists() and p1.stat().st_size > 0, p1
        # sharded layout
        assert p1.parent.name == p1.stem[:2], p1
        # Let writer drain the InsertThumbCacheOp.
        time.sleep(0.3)
        rc = db.connect_read(db_path)
        try:
            row = rc.execute(
                "SELECT image_id, size_bytes, created_at, last_accessed "
                "FROM thumbnail_cache"
            ).fetchone()
            assert row is not None, "thumbnail_cache row missing after request"
            assert int(row["image_id"]) == 1
            assert int(row["size_bytes"]) == p1.stat().st_size
            gen_ts = int(row["last_accessed"])
        finally:
            rc.close()

        # Spy on generator to confirm the 2nd call never regenerates.
        orig_gen = thumbs._generate_and_save
        gen_calls = [0]

        def counted_gen(*a, **kw):
            gen_calls[0] += 1
            return orig_gen(*a, **kw)

        thumbs._generate_and_save = counted_gen
        try:
            p2 = thumbs.request(1, db_path=db_path,
                                thumbs_dir=thumbs_dir, write_queue=wq)
            assert p2 == p1, (p1, p2)
            assert gen_calls[0] == 0, (
                f"expected no regen on disk hit, got {gen_calls[0]}"
            )
        finally:
            thumbs._generate_and_save = orig_gen
        print("T08 #1 OK — first generates, second hits disk (regen=0)")

        # ---- T08 test #2: touch is batched, not per-request ---------
        # 100 hits must NOT bump last_accessed in DB; an explicit flush
        # op does bump it exactly once. This verifies the /thumb hot
        # path doesn't poison WriteQueue (§8.3).
        for _ in range(100):
            thumbs.request(1, db_path=db_path,
                           thumbs_dir=thumbs_dir, write_queue=wq)
        time.sleep(0.2)
        rc = db.connect_read(db_path)
        try:
            t_after_hits = int(rc.execute(
                "SELECT last_accessed FROM thumbnail_cache WHERE image_id=1"
            ).fetchone()[0])
        finally:
            rc.close()
        assert t_after_hits == gen_ts, (
            f"last_accessed drifted during 100 hits ({gen_ts} → {t_after_hits}); "
            "touch() must not write per-request"
        )
        with thumbs._touch_lock:
            assert p1.stem in thumbs._touch_set, "key missing from touch set"

        # Simulate one flusher tick deterministically.
        flush_now = int(time.time()) + 10  # clearly distinct from gen_ts
        keys = thumbs._drain_touch_set()
        assert keys, "drain returned empty"
        wq.enqueue_write(
            repo.LOW, thumbs._TouchFlushOp(keys, now=flush_now),
        ).result(timeout=5)
        rc = db.connect_read(db_path)
        try:
            t_flushed = int(rc.execute(
                "SELECT last_accessed FROM thumbnail_cache WHERE image_id=1"
            ).fetchone()[0])
        finally:
            rc.close()
        assert t_flushed == flush_now, (t_flushed, flush_now, gen_ts)
        print("T08 #2 OK — 100 hits → 0 DB writes; 1 flush → 1 UPDATE")

        # ---- T08 test #3: mtime_ns change → new hash_key → regen ----
        time.sleep(1.1)  # ensure filesystem mtime advances past resolution
        _make_png(src, color="blue")
        new_st = os.stat(src)
        assert new_st.st_mtime_ns != st.st_mtime_ns, (
            "filesystem mtime didn't advance; test box has too-coarse mtime"
        )
        _insert_image_row(
            db_path, image_id=1, posix_path=posix,
            folder_id=root_id, mtime_ns=new_st.st_mtime_ns,
            file_size=new_st.st_size,
        )
        p3 = thumbs.request(1, db_path=db_path,
                            thumbs_dir=thumbs_dir, write_queue=wq)
        assert p3 is not None and p3.exists()
        assert p3 != p1, (
            f"hash_key unchanged after mtime_ns change: {p1} vs {p3}"
        )
        # Old .webp still sits on disk — T26 janitor's job to collect.
        assert p1.exists(), "old thumb unexpectedly vanished"
        time.sleep(0.3)
        rc = db.connect_read(db_path)
        try:
            (n,) = rc.execute(
                "SELECT COUNT(*) FROM thumbnail_cache WHERE image_id=1"
            ).fetchone()
            # foreign_keys is OFF (see gallery/db.py _apply_pragmas): the
            # old cache row persists alongside the new one. Both key off
            # hash_key, not image_id, so this is expected.
            assert n == 2, f"expected 2 cache rows (old+new), got {n}"
        finally:
            rc.close()
        print("T08 #3 OK — mtime_ns advance → new hash_key → new .webp")

        # ---- T08 test #4: 1000 concurrent same id → 1 generation ----
        # Force a miss: drop the on-disk .webp AND the cache row for the
        # current hash_key so there's no fast-path short-circuit.
        p3.unlink()
        conn = sqlite3.connect(str(db_path))
        try:
            conn.execute("DELETE FROM thumbnail_cache WHERE image_id=1")
            conn.commit()
        finally:
            conn.close()

        orig_gen = thumbs._generate_and_save
        gen_calls = [0]
        gen_lock = threading.Lock()

        def counted_gen(*a, **kw):
            # Hold the slot just long enough that all 1000 racers queue
            # up on the winner's Future instead of arriving after pop().
            time.sleep(0.05)
            with gen_lock:
                gen_calls[0] += 1
            return orig_gen(*a, **kw)

        thumbs._generate_and_save = counted_gen
        try:
            results: list = [None] * 1000
            barrier = threading.Event()

            def hammer(i: int) -> None:
                barrier.wait()
                results[i] = thumbs.request(
                    1, db_path=db_path,
                    thumbs_dir=thumbs_dir, write_queue=wq,
                )

            ths = [threading.Thread(target=hammer, args=(i,))
                   for i in range(1000)]
            for t in ths:
                t.start()
            barrier.set()
            for t in ths:
                t.join(timeout=30)
        finally:
            thumbs._generate_and_save = orig_gen

        missing = [i for i, r in enumerate(results) if r is None]
        assert not missing, f"{len(missing)} requests returned None"
        unique_paths = {str(r) for r in results}
        assert len(unique_paths) == 1, unique_paths
        assert gen_calls[0] == 1, (
            f"expected exactly 1 generation, got {gen_calls[0]}"
        )
        with thumbs._inflight_lock:
            assert len(thumbs._inflight) == 0, thumbs._inflight
        print("T08 #4 OK — 1000 concurrent → exactly 1 generation, "
              "_inflight drained")

    finally:
        wq.stop(timeout=2)


def main() -> None:
    scratch = Path(tempfile.mkdtemp(prefix="xyz_t08_"))
    try:
        _run_d1(scratch)
        _run_d2(scratch)
        print("\nAll T08 tests passed.")
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


if __name__ == "__main__":
    main()
