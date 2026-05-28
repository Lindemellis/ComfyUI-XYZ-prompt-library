"""Tag DB distribution — download the author's prebuilt dataset from a GitHub Release.

The dataset is NOT committed to the repo (tagdb_data/ is gitignored and the file
is large). Instead `tagdb/official_manifest.json` (committed) points at Release
assets; this module reads it, downloads the latest asset, verifies its sha256,
unzips it (stdlib zipfile), and seeds the working DB.

No scraping happens here. First-run failure must surface to the UI for a manual
retry — never silently fall back to a long danbooru scrape.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import zipfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from . import db as _db
from . import scraper as _sc

logger = logging.getLogger("xyz.tagdb.distribution")

__all__ = [
    "load_manifest", "check_official", "download_official",
    "seed_working_db_from_official", "OFFICIAL_DIR_NAME",
    "check_gelbooru", "download_gelbooru", "seed_gelbooru_db_from_official",
    "installed_gelbooru_version",
]

_MANIFEST_PATH = Path(__file__).resolve().parent / "official_manifest.json"
OFFICIAL_DIR_NAME = "official"


def load_manifest(manifest_url: Optional[str] = None) -> Dict[str, Any]:
    """Load the dataset manifest.

    Prefers a remote `manifest_url` (lets the author ship datasets without a code
    release); falls back to the committed local manifest. Returns {} on failure.
    """
    if manifest_url:
        try:
            session = _sc._make_session()
            return _sc._get_json(session, manifest_url, timeout=20)
        except Exception as exc:
            logger.warning("Remote manifest fetch failed (%s); using local.", exc)
    try:
        return json.loads(_MANIFEST_PATH.read_text("utf-8"))
    except Exception as exc:
        logger.warning("Local manifest unreadable: %s", exc)
        return {}


def _dataset_by_version(manifest: Dict[str, Any], version: Optional[str],
                        key: str = "datasets", latest_key: str = "latest") -> Optional[Dict]:
    datasets: List[Dict] = manifest.get(key) or []
    if not datasets:
        return None
    if version is None:
        version = manifest.get(latest_key)
        if version is None and datasets:
            version = datasets[0].get("version")
    for d in datasets:
        if d.get("version") == version:
            return d
    return None


def _official_dir(data_dir: Path) -> Path:
    d = Path(data_dir) / "snapshots" / OFFICIAL_DIR_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def installed_official_version(data_dir: Path) -> Optional[str]:
    """Newest official version present on disk (from `<version>_danbooru.sqlite`)."""
    versions = []
    for p in _official_dir(data_dir).glob("*_danbooru.sqlite"):
        versions.append(p.name.split("_danbooru.sqlite")[0])
    return max(versions) if versions else None


def check_official(data_dir: Path, manifest_url: Optional[str] = None) -> Dict[str, Any]:
    """Report latest available vs installed prebuilt dataset version."""
    manifest = load_manifest(manifest_url)
    latest = manifest.get("latest")
    installed = installed_official_version(data_dir)
    ds = _dataset_by_version(manifest, latest)
    return {
        "latest": latest,
        "installed": installed,
        "update_available": bool(latest and latest != installed),
        "size_bytes": (ds or {}).get("size_bytes"),
        "tag_count": (ds or {}).get("tag_count"),
        "has_manifest": bool(manifest.get("datasets")),
    }


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _download_dataset(ds: Dict[str, Any], out_dir: Path, target: Path,
                      progress_cb: Optional[Callable[[str], None]], stop_event) -> Path:
    """Download + verify(sha256) + unzip a manifest dataset entry into `target`.

    Shared core for the danbooru base and the gelbooru DLC. Returns `target`.
    """
    def _log(m: str) -> None:
        logger.info(m)
        if progress_cb:
            progress_cb(m)

    version = ds["version"]
    url = ds["url"]
    if target.exists() and ds.get("sha256") and _sha256(target) == ds["sha256"]:
        _log(f"Dataset {target.name} already present and verified.")
        return target

    part = out_dir / f".{target.stem}.part"
    _log(f"Downloading {target.name} ({ds.get('size_bytes', '?')} bytes)...")
    session = _sc._make_session()
    resp = session.get(url, stream=True, timeout=120)
    resp.raise_for_status()
    with open(part, "wb") as f:
        for chunk in resp.iter_content(chunk_size=1 << 20):
            if stop_event and stop_event.is_set():
                f.close(); part.unlink(missing_ok=True)
                raise RuntimeError("Download cancelled")
            if chunk:
                f.write(chunk)

    expected = ds.get("sha256")
    if expected:
        actual = _sha256(part)
        if actual != expected:
            part.unlink(missing_ok=True)
            raise RuntimeError(f"sha256 mismatch (expected {expected[:12]}…, got {actual[:12]}…)")
        _log("sha256 verified.")

    if ds.get("compression") == "zip":
        _log("Unzipping...")
        with zipfile.ZipFile(part) as zf:
            members = [n for n in zf.namelist() if n.endswith(".sqlite")]
            if not members:
                part.unlink(missing_ok=True)
                raise RuntimeError("Zip contains no .sqlite file")
            tmp = out_dir / f".{target.stem}.unzipped.sqlite"
            with zf.open(members[0]) as src, open(tmp, "wb") as dst:
                shutil.copyfileobj(src, dst)
        part.unlink(missing_ok=True)
        os.replace(tmp, target)
    else:
        os.replace(part, target)

    _log(f"Dataset ready: {target.name}")
    return target


def download_official(
    data_dir: Path,
    version: Optional[str] = None,
    manifest_url: Optional[str] = None,
    progress_cb: Optional[Callable[[str], None]] = None,
    stop_event=None,
) -> Path:
    """Download + verify + unzip the prebuilt danbooru dataset into snapshots/official/.

    Returns the path to the verified `.sqlite`. Raises on any failure (missing
    manifest entry, sha256 mismatch, bad zip) — the caller surfaces it to the UI.
    """
    manifest = load_manifest(manifest_url)
    ds = _dataset_by_version(manifest, version)
    if not ds:
        raise RuntimeError(
            "No prebuilt dataset is available in the manifest yet. "
            "Enter danbooru credentials and run a Full build instead, "
            "or try again after the author publishes a dataset."
        )
    out_dir = _official_dir(data_dir)
    target = out_dir / f"{ds['version']}_danbooru.sqlite"
    return _download_dataset(ds, out_dir, target, progress_cb, stop_event)


def seed_working_db_from_official(official_path: Path, working_path: Path,
                                  version: Optional[str] = None) -> None:
    """Copy a downloaded official file to the working DB and mark its origin."""
    working_path = Path(working_path)
    working_path.parent.mkdir(parents=True, exist_ok=True)
    # Clean destination + WAL/SHM sidecars so shutil.copy doesn't fail on Windows
    # when the old file has open handles or WAL artefacts.
    for p in [working_path, Path(str(working_path) + "-wal"), Path(str(working_path) + "-shm")]:
        try:
            p.unlink(missing_ok=True)
        except OSError:
            pass
    shutil.copy(official_path, working_path)
    conn = _db.connect_write(working_path)
    try:
        _db.migrate(conn)
        if version is None:
            version = official_path.name.split("_danbooru.sqlite")[0]
        conn.execute(
            "INSERT INTO meta(key,value) VALUES('schema_kind','working') "
            "ON CONFLICT(key) DO UPDATE SET value='working'"
        )
        conn.execute(
            "INSERT INTO meta(key,value) VALUES('origin_official_version',?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (version,),
        )
        # Rebuild the contentless FTS5 index locally. This self-heals a shipped
        # dataset whose index has stale/doubled postings (search would otherwise
        # return tags that don't contain the query). Cheap: ~1s for ~120k rows.
        from .snapshots import rebuild_fts
        rebuild_fts(conn)
    finally:
        conn.close()


# ─── Gelbooru DLC (opt-in second source) ────────────────────────────────────────
#
# Gelbooru ships as a separate manifest list `datasets_gelbooru[]` (latest pointer
# `latest_gelbooru`) and downloads into the gelbooru working file `gelbooru.sqlite`.
# It is NOT part of the first-run auto-download — the user opts in from the manager.

def installed_gelbooru_version(data_dir: Path) -> Optional[str]:
    """Newest gelbooru official version on disk (from `<version>_gelbooru.sqlite`)."""
    versions = [p.name.split("_gelbooru.sqlite")[0]
                for p in _official_dir(data_dir).glob("*_gelbooru.sqlite")]
    return max(versions) if versions else None


def check_gelbooru(data_dir: Path, manifest_url: Optional[str] = None) -> Dict[str, Any]:
    """Report latest available vs installed gelbooru DLC version + whether installed."""
    manifest = load_manifest(manifest_url)
    latest = manifest.get("latest_gelbooru")
    ds = _dataset_by_version(manifest, latest, key="datasets_gelbooru",
                             latest_key="latest_gelbooru")
    installed = installed_gelbooru_version(data_dir)
    gel_working = Path(data_dir) / "gelbooru.sqlite"
    return {
        "latest": (ds or {}).get("version", latest),
        "installed": installed,
        "active": gel_working.exists(),
        "update_available": bool(ds and ds.get("version") and ds["version"] != installed),
        "size_bytes": (ds or {}).get("size_bytes"),
        "tag_count": (ds or {}).get("tag_count"),
        "has_manifest": bool(manifest.get("datasets_gelbooru")),
    }


def download_gelbooru(
    data_dir: Path,
    version: Optional[str] = None,
    manifest_url: Optional[str] = None,
    progress_cb: Optional[Callable[[str], None]] = None,
    stop_event=None,
) -> Path:
    """Download + verify + unzip the prebuilt gelbooru DLC into snapshots/official/.

    Returns the verified `<version>_gelbooru.sqlite`. Raises if no gelbooru entry is
    in the manifest yet (author hasn't published one).
    """
    manifest = load_manifest(manifest_url)
    ds = _dataset_by_version(manifest, version, key="datasets_gelbooru",
                             latest_key="latest_gelbooru")
    if not ds:
        raise RuntimeError(
            "No prebuilt gelbooru dataset is published yet. Either wait for the author "
            "to release one, or build your own with gelbooru credentials "
            "(python -m tagdb.build_dataset --gelbooru)."
        )
    out_dir = _official_dir(data_dir)
    target = out_dir / f"{ds['version']}_gelbooru.sqlite"
    return _download_dataset(ds, out_dir, target, progress_cb, stop_event)


def seed_gelbooru_db_from_official(official_path: Path, gelbooru_path: Path,
                                   version: Optional[str] = None) -> None:
    """Copy a downloaded gelbooru file to the gelbooru working DB and rebuild its FTS."""
    gelbooru_path = Path(gelbooru_path)
    gelbooru_path.parent.mkdir(parents=True, exist_ok=True)
    for p in [gelbooru_path, Path(str(gelbooru_path) + "-wal"), Path(str(gelbooru_path) + "-shm")]:
        try:
            p.unlink(missing_ok=True)
        except OSError:
            pass
    shutil.copy(official_path, gelbooru_path)
    conn = _db.connect_write(gelbooru_path)
    try:
        _db.migrate(conn)
        if version is None:
            version = official_path.name.split("_gelbooru.sqlite")[0]
        conn.execute(
            "INSERT INTO meta(key,value) VALUES('schema_kind','working') "
            "ON CONFLICT(key) DO UPDATE SET value='working'"
        )
        conn.execute(
            "INSERT INTO meta(key,value) VALUES('origin_official_version',?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (version,),
        )
        from .snapshots import rebuild_fts
        rebuild_fts(conn)
    finally:
        conn.close()
