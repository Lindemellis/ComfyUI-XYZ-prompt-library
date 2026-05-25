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


def _dataset_by_version(manifest: Dict[str, Any], version: Optional[str]) -> Optional[Dict]:
    datasets: List[Dict] = manifest.get("datasets") or []
    if not datasets:
        return None
    if version is None:
        version = manifest.get("latest")
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


def download_official(
    data_dir: Path,
    version: Optional[str] = None,
    manifest_url: Optional[str] = None,
    progress_cb: Optional[Callable[[str], None]] = None,
    stop_event=None,
) -> Path:
    """Download + verify + unzip the prebuilt dataset into snapshots/official/.

    Returns the path to the verified `.sqlite`. Raises on any failure (missing
    manifest entry, sha256 mismatch, bad zip) — the caller surfaces it to the UI.
    """
    def _log(m: str) -> None:
        logger.info(m)
        if progress_cb:
            progress_cb(m)

    manifest = load_manifest(manifest_url)
    ds = _dataset_by_version(manifest, version)
    if not ds:
        raise RuntimeError(
            "No prebuilt dataset is available in the manifest yet. "
            "Enter danbooru credentials and run a Full build instead, "
            "or try again after the author publishes a dataset."
        )
    version = ds["version"]
    url = ds["url"]
    out_dir = _official_dir(data_dir)
    target = out_dir / f"{version}_danbooru.sqlite"
    if target.exists() and ds.get("sha256") and _sha256(target) == ds["sha256"]:
        _log(f"Prebuilt dataset {version} already present and verified.")
        return target

    part = out_dir / f".{version}.part"
    _log(f"Downloading prebuilt dataset {version} ({ds.get('size_bytes', '?')} bytes)...")
    session = _sc._make_session()
    resp = session.get(url, stream=True, timeout=120)
    resp.raise_for_status()
    downloaded = 0
    with open(part, "wb") as f:
        for chunk in resp.iter_content(chunk_size=1 << 20):
            if stop_event and stop_event.is_set():
                f.close(); part.unlink(missing_ok=True)
                raise RuntimeError("Download cancelled")
            if chunk:
                f.write(chunk)
                downloaded += len(chunk)

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
            tmp = out_dir / f".{version}.unzipped.sqlite"
            with zf.open(members[0]) as src, open(tmp, "wb") as dst:
                shutil.copyfileobj(src, dst)
        part.unlink(missing_ok=True)
        os.replace(tmp, target)
    else:
        os.replace(part, target)

    _log(f"Prebuilt dataset {version} ready: {target.name}")
    return target


def translations_available(manifest_url: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Return the translations-DLC entry for the latest dataset, or None."""
    manifest = load_manifest(manifest_url)
    ds = _dataset_by_version(manifest, manifest.get("latest"))
    return (ds or {}).get("translations")


def translations_installed(working_path: Path) -> bool:
    """True if the working DB already has translations merged in."""
    working_path = Path(working_path)
    if not working_path.exists():
        return False
    conn = _db.connect_read(working_path)
    try:
        return conn.execute("SELECT COUNT(*) FROM translations").fetchone()[0] > 0
    except Exception:
        return False
    finally:
        conn.close()


def merge_translations(working_path: Path, dlc_path: Path,
                       progress_cb: Optional[Callable[[str], None]] = None) -> None:
    """Merge a translations-DLC sqlite into the working DB + refold into FTS."""
    from .snapshots import rebuild_fts
    conn = _db.connect_write(working_path)
    try:
        conn.execute(f"ATTACH '{Path(dlc_path).as_posix()}' AS dlc")
        conn.execute("BEGIN")
        conn.execute("INSERT OR REPLACE INTO translations(tag, lang, text) "
                     "SELECT tag, lang, text FROM dlc.translations")
        conn.execute("COMMIT")
        conn.execute("DETACH dlc")
        if progress_cb:
            progress_cb("Folding translations into the search index...")
        rebuild_fts(conn)
        conn.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('translations_installed','1')")
    finally:
        conn.close()


def download_translations(data_dir: Path, working_path: Path, version: Optional[str] = None,
                          manifest_url: Optional[str] = None,
                          progress_cb: Optional[Callable[[str], None]] = None,
                          stop_event=None) -> None:
    """Download + verify + unzip the translations DLC, then merge it into the working DB."""
    def _log(m):
        logger.info(m)
        if progress_cb:
            progress_cb(m)

    manifest = load_manifest(manifest_url)
    ds = _dataset_by_version(manifest, version)
    tr = (ds or {}).get("translations")
    if not tr:
        raise RuntimeError("No translations DLC is available in the manifest.")
    if not Path(working_path).exists():
        raise RuntimeError("Download/seed the base dataset first, then add translations.")

    out_dir = _official_dir(data_dir)
    part = out_dir / ".translations.part"
    _log(f"Downloading translations DLC ({tr.get('size_bytes', '?')} bytes)...")
    session = _sc._make_session()
    resp = session.get(tr["url"], stream=True, timeout=120)
    resp.raise_for_status()
    with open(part, "wb") as f:
        for chunk in resp.iter_content(chunk_size=1 << 20):
            if stop_event and stop_event.is_set():
                f.close(); part.unlink(missing_ok=True)
                raise RuntimeError("Download cancelled")
            if chunk:
                f.write(chunk)
    if tr.get("sha256") and _sha256(part) != tr["sha256"]:
        part.unlink(missing_ok=True)
        raise RuntimeError("translations DLC sha256 mismatch")

    tmpdb = out_dir / ".translations.sqlite"
    if tr.get("compression") == "zip":
        with zipfile.ZipFile(part) as zf:
            members = [n for n in zf.namelist() if n.endswith(".sqlite")]
            if not members:
                part.unlink(missing_ok=True)
                raise RuntimeError("translations DLC zip has no .sqlite")
            with zf.open(members[0]) as src, open(tmpdb, "wb") as dst:
                shutil.copyfileobj(src, dst)
        part.unlink(missing_ok=True)
    else:
        os.replace(part, tmpdb)

    _log("Merging translations...")
    merge_translations(working_path, tmpdb, progress_cb)
    tmpdb.unlink(missing_ok=True)
    _log("Translations DLC installed.")


def seed_working_db_from_official(official_path: Path, working_path: Path,
                                  version: Optional[str] = None) -> None:
    """Copy a downloaded official file to the working DB and mark its origin."""
    working_path = Path(working_path)
    working_path.parent.mkdir(parents=True, exist_ok=True)
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
    finally:
        conn.close()
