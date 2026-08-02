"""One-off repair for rows indexed by the broken A1111 ``parameters`` parser.

An empty ``Negative prompt:`` header (what a no-negative model such as krea2
writes) used to make ``_derive_from_parameters`` swallow the newline before the
``Steps: …, Sampler: …`` line, so the kv blob landed in ``negative_prompt`` and
``model`` / ``seed`` / ``cfg`` / ``sampler`` stayed empty.  The parser is fixed,
but a cold scan skips files whose (size, mtime) fingerprint is unchanged, so
already-indexed rows keep the bad values.

This re-reads the affected PNGs and re-enqueues a normal ``UpsertImageOp``
through a private ``WriteQueue`` — the same write path the indexer uses, so
vocab tables stay consistent.

Usage (from the custom node dir)::

    python -m gallery.repair_parameters --dry-run
    python -m gallery.repair_parameters
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any, Dict

from . import db as _db
from . import folders as _folders
from . import indexer as _indexer
from . import metadata as _metadata
from . import repo as _repo

DEFAULT_DB = Path(__file__).resolve().parent.parent / "gallery_data" / "gallery.sqlite"

# A negative prompt that is really the kv blob.  Two markers, not one: a real
# negative prompt could contain the word "Steps".
_SUSPECT_SQL = """
    SELECT id, path, folder_id, negative_prompt
      FROM image
     WHERE negative_prompt LIKE '%Sampler:%'
       AND negative_prompt LIKE '%CFG scale:%'
     ORDER BY id
"""


def find_suspects(db_path: Path) -> list[dict[str, Any]]:
    conn = _db.connect_read(db_path)
    try:
        rows = conn.execute(_SUSPECT_SQL).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


def repair(db_path: Path, *, dry_run: bool) -> int:
    suspects = find_suspects(db_path)
    if not suspects:
        print("nothing to repair")
        return 0

    roots: Dict[int, Dict[str, Any]] = {
        int(r["id"]): r for r in _folders.list_roots(db_path=db_path)
    }
    extra_sw = _indexer._load_prompt_stopwords(db_path)

    wq = None
    if not dry_run:
        # This opens a SECOND writer on a DB that a running ComfyUI also writes
        # to.  WAL serialises them, but a burst can still push the live process
        # past its busy timeout.  Prefer running this with ComfyUI stopped.
        print(
            f"note: writing {len(suspects)} rows; stop ComfyUI first if you can "
            "(a second writer can make the running instance hit 'database is locked')"
        )
        wq = _repo.WriteQueue(db_path)
        wq.start()

    fixed = skipped = 0
    futures = []
    try:
        for row in suspects:
            abs_path = str(row["path"])
            root = roots.get(int(row["folder_id"]))
            if root is None:
                print(f"skip (root {row['folder_id']} gone): {abs_path}")
                skipped += 1
                continue
            try:
                st = os.stat(abs_path)
            except OSError as exc:
                print(f"skip (stat failed: {exc}): {abs_path}")
                skipped += 1
                continue

            meta = _metadata.read_comfy_metadata(abs_path)
            if meta.negative_prompt == row["negative_prompt"]:
                # Re-read still yields the kv blob — not this bug, leave it be.
                print(f"skip (unchanged): {abs_path}")
                skipped += 1
                continue

            print(
                f"fix #{row['id']} {os.path.basename(abs_path)}: "
                f"neg={meta.negative_prompt!r} model={meta.model!r} "
                f"seed={meta.seed!r} cfg={meta.cfg!r} sampler={meta.sampler!r}"
            )
            fixed += 1
            if dry_run:
                continue
            op = _indexer._build_upsert_op(
                abs_path=abs_path, root=root, stat_result=st, meta=meta,
                extra_stopwords=extra_sw,
            )
            futures.append(wq.enqueue_write(_repo.LOW, op))

        for fut in futures:
            fut.result(timeout=30)
    finally:
        if wq is not None:
            wq.stop(timeout=10)

    verb = "would fix" if dry_run else "fixed"
    print(f"{verb} {fixed}, skipped {skipped} (of {len(suspects)} suspect rows)")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--db", type=Path, default=DEFAULT_DB, help="gallery.sqlite path")
    ap.add_argument("--dry-run", action="store_true", help="report, write nothing")
    args = ap.parse_args(argv)
    if not args.db.is_file():
        print(f"no such db: {args.db}", file=sys.stderr)
        return 2
    return repair(args.db, dry_run=bool(args.dry_run))


if __name__ == "__main__":
    raise SystemExit(main())
