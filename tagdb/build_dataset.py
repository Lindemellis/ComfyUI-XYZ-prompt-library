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
    """Scrape the entire tag_versions event log into the DB (reuses updater helper)."""
    conn = _db.connect_write(db_path)
    try:
        return _up.backfill_tag_versions(conn, login=login, api_key=api_key, progress_cb=print)
    finally:
        conn.close()


def _build_translations_dlc(login, api_key, do_zip) -> None:
    """Build the translations add-on (wiki + artist other_names) as a standalone DLC sqlite."""
    version = date.today().strftime("%Y-%m-%d")
    out = Path("dist") / f"translations_{version}.sqlite"
    out.parent.mkdir(parents=True, exist_ok=True)
    print(f"Building translations DLC → {out}...")
    t0 = time.time()
    c = _db.connect_write(out)
    _db.migrate(c)
    n = 0
    c.execute("BEGIN")
    for w in _sc.scrape_wiki_other_names(login=login, api_key=api_key):
        c.execute("INSERT OR REPLACE INTO translations(tag, lang, text) VALUES (?, 'other', ?)",
                  (w["tag"], " ".join(w["other_names"])))
        n += 1
        if n % 2000 == 0:
            c.execute("COMMIT"); c.execute("BEGIN"); print(f"  wiki: {n:,}")
    c.execute("COMMIT")
    print(f"  wiki other_names: {n:,}")
    m = 0
    c.execute("BEGIN")
    for a in _sc.scrape_artist_other_names(login=login, api_key=api_key):
        c.execute("INSERT OR REPLACE INTO translations(tag, lang, text) VALUES (?, 'artist', ?)",
                  (a["tag"], " ".join(a["other_names"])))
        m += 1
        if m % 2000 == 0:
            c.execute("COMMIT"); c.execute("BEGIN"); print(f"  artist: {m:,}")
    c.execute("COMMIT")
    print(f"  artist other_names: {m:,}")
    c.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('kind','translations-dlc')")
    c.execute("INSERT OR REPLACE INTO meta(key,value) VALUES('version',?)", (version,))
    c.execute("VACUUM")
    c.close()

    asset = out
    compression = "none"
    if do_zip:
        asset = Path(str(out) + ".zip")
        with zipfile.ZipFile(asset, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.write(out, arcname=out.name)
        compression = "zip"
    entry = {
        "url": f"https://github.com/zhupeter010903/ComfyUI-XYZ-prompt-library/releases/download/tagdb-{version}/{asset.name}",
        "sha256": _sha256(asset),
        "size_bytes": asset.stat().st_size,
        "compression": compression,
    }
    print(f"\nDone in {time.time()-t0:.0f}s.")
    print('\n=== Paste into the dataset entry as its "translations" object ===')
    print(json.dumps(entry, indent=2))


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser(description="Build a TagDB dataset for distribution")
    ap.add_argument("--full", action="store_true", help="full scrape (currently the only mode)")
    ap.add_argument("--min-post-count", type=int, default=50)
    ap.add_argument("--out", default=None, help="output .sqlite path")
    ap.add_argument("--with-versions", action="store_true",
                    help="also backfill the full tag_versions event log")
    ap.add_argument("--with-translations", action="store_true",
                    help="also scrape wiki other_names (translations) INTO this DB")
    ap.add_argument("--with-artists", action="store_true",
                    help="also scrape artist other_names + slim artist_versions (rename history)")
    ap.add_argument("--translations-dlc", action="store_true",
                    help="build ONLY the translations add-on (wiki + artist other_names) as a separate DLC sqlite")
    ap.add_argument("--zip", action="store_true", help="also produce a .zip asset")
    ap.add_argument("--login", default=None)
    ap.add_argument("--api-key", default=None)
    args = ap.parse_args()

    login, api_key = args.login, args.api_key
    if not login:
        login, api_key = _load_saved_creds()
        if login:
            print(f"Using saved danbooru credentials (login: {login}).")

    if args.translations_dlc:
        _build_translations_dlc(login, api_key, args.zip)
        return

    version = date.today().strftime("%Y-%m-%d")
    out = Path(args.out) if args.out else Path("dist") / f"danbooru_{version}.sqlite"
    out.parent.mkdir(parents=True, exist_ok=True)

    print(f"Building {out} (min_post_count={args.min_post_count})...")
    t0 = time.time()
    summary = _up.run_full_update(
        out, min_post_count=args.min_post_count, label="danbooru",
        login=login, api_key=api_key, with_translations=args.with_translations,
        with_artist_names=args.with_artists, with_artist_versions=args.with_artists,
        progress_cb=print,
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
