"""Author-side standalone dataset builder (runs WITHOUT ComfyUI).

Builds a V2 TagDB SQLite via a full danbooru scrape, optionally backfills the
tag_versions event log, optionally zips it, then prints the sha256 and a
ready-to-paste `official_manifest.json` entry. Upload the (zip) asset to a GitHub
Release and paste the entry into tagdb/official_manifest.json.

Usage:
    python -m tagdb.build_dataset --full --min-post-count 10 --out dist/danbooru_2026-05-24.sqlite
    python -m tagdb.build_dataset --full --min-post-count 10 --with-versions --zip \
        --login myuser --api-key abc123
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import sys
import time
import zipfile
from datetime import date
from pathlib import Path

from . import db as _db
from . import scraper as _sc
from . import updater as _up

if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")


def _load_saved_creds() -> tuple:
    """Fall back to tagdb_data/settings.json credentials (no ComfyUI needed)."""
    p = Path(__file__).resolve().parent.parent / "tagdb_data" / "settings.json"
    if p.exists():
        try:
            s = json.loads(p.read_text("utf-8"))
            return s.get("danbooru_login") or None, s.get("danbooru_api_key") or None
        except Exception:
            pass
    return None, None


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _backfill_tag_versions(db_path: Path, login, api_key) -> int:
    """Scrape the entire tag_versions event log (small; back to 2013) into the DB."""
    conn = _db.connect_write(db_path)
    n = 0
    try:
        conn.execute("BEGIN")
        for v in _sc.scrape_tag_versions_since(0, login=login, api_key=api_key):
            conn.execute(
                "INSERT OR IGNORE INTO tag_versions(version_id, tag_id, name, category, "
                "is_deprecated, created_at, previous_version_id, synced_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (v["version_id"], v["tag_id"], v["name"], v["category"],
                 v["is_deprecated"], v["created_at"], v["previous_version_id"], int(time.time())),
            )
            n += 1
            if n % 2000 == 0:
                conn.execute("COMMIT"); conn.execute("BEGIN")
                print(f"  tag_versions: {n:,}")
        conn.execute("COMMIT")
    finally:
        conn.close()
    return n


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser(description="Build a TagDB dataset for distribution")
    ap.add_argument("--full", action="store_true", help="full scrape (currently the only mode)")
    ap.add_argument("--min-post-count", type=int, default=10)
    ap.add_argument("--out", default=None, help="output .sqlite path")
    ap.add_argument("--with-versions", action="store_true",
                    help="also backfill the full tag_versions event log")
    ap.add_argument("--zip", action="store_true", help="also produce a .zip asset")
    ap.add_argument("--login", default=None)
    ap.add_argument("--api-key", default=None)
    args = ap.parse_args()

    login, api_key = args.login, args.api_key
    if not login:
        login, api_key = _load_saved_creds()
        if login:
            print(f"Using saved danbooru credentials (login: {login}).")

    version = date.today().strftime("%Y-%m-%d")
    out = Path(args.out) if args.out else Path("dist") / f"danbooru_{version}.sqlite"
    out.parent.mkdir(parents=True, exist_ok=True)

    print(f"Building {out} (min_post_count={args.min_post_count})...")
    t0 = time.time()
    summary = _up.run_full_update(
        out, min_post_count=args.min_post_count, label="danbooru",
        login=login, api_key=api_key, progress_cb=print,
    )
    if args.with_versions:
        print("Backfilling tag_versions event log...")
        nver = _backfill_tag_versions(out, login, api_key)
        print(f"  tag_versions backfilled: {nver:,}")

    conn = _db.connect_read(out)
    meta = dict(conn.execute("SELECT key, value FROM meta"))
    conn.close()

    asset = out
    compression = "none"
    if args.zip:
        asset = out.with_suffix(out.suffix + ".zip")
        print(f"Zipping → {asset}...")
        with zipfile.ZipFile(asset, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(out, arcname=out.name)
        compression = "zip"

    sha = _sha256(asset)
    entry = {
        "version": version,
        "min_post_count": args.min_post_count,
        "tag_count": int(meta.get("tag_count", 0)),
        "alias_count": int(meta.get("alias_count", 0)),
        "schema_version": _db.SCHEMA_VERSION,
        "structure_synced_through": int(meta.get("structure_synced_through", 0)),
        "full_count_synced_at": int(meta.get("full_count_synced_at", 0)),
        "url": f"https://github.com/zhupeter010903/ComfyUI-XYZ-prompt-library/releases/download/tagdb-{version}/{asset.name}",
        "sha256": sha,
        "size_bytes": asset.stat().st_size,
        "compression": compression,
    }
    print(f"\nDone in {time.time()-t0:.0f}s. Summary: {summary}")
    print("\n=== Paste into tagdb/official_manifest.json (datasets[]) and set latest ===")
    print(json.dumps(entry, indent=2))


if __name__ == "__main__":
    main()
