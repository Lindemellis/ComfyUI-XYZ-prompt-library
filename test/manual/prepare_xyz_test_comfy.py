"""Copy the complete XYZ pack into a persistent, isolated ComfyUI test root.

Personal data/config directories are deliberately excluded. Refresh code on each
launch without replacing the test instance's own Library and settings.
"""
from pathlib import Path
import argparse
import shutil
import sqlite3
import sys


REPO = Path(__file__).resolve().parents[2]
PACK_DIRS = (
    "prompt_shared", "prompt_library_v3", "prompt_library_v4", "mask_nodes", "krita_nodes",
    "krita_plugin", "cache_nodes", "inpaint_nodes", "gallery", "tagdb",
    "agent_nodes", "js", "web",
)
PACK_FILES = ("__init__.py", "node.py", "quantized_hook_compat.py")


def seed_tag_data(source, target):
    """Seed absent/empty test TagDBs with a consistent, independent local snapshot.

    SQLite backup includes committed WAL data without writing to the source.
    Never replace a populated test database or copy personal settings.
    """
    if not source.is_file():
        return False
    with sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True) as original:
        if not original.execute("SELECT COUNT(*) FROM tags").fetchone()[0]:
            return False
        if target.exists():
            with sqlite3.connect(target.resolve().as_uri() + "?mode=ro", uri=True) as existing:
                if existing.execute("SELECT COUNT(*) FROM tags").fetchone()[0]:
                    return False
        target.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(target) as snapshot:
            original.backup(snapshot)
    return True


def prepare(root):
    root = Path(root).resolve()
    if root == REPO or root in REPO.parents or REPO in root.parents:
        raise ValueError("Test root must be separate from the source node pack")
    pack = root / "custom_nodes" / "ComfyUI-XYZNodes"
    pack.mkdir(parents=True, exist_ok=True)
    for name in ("user", "input", "output", "temp", "logs"):
        (root / name).mkdir(exist_ok=True)
    copied = 0
    for name in PACK_FILES:
        source = REPO / name
        if source.is_file():
            shutil.copy2(source, pack / name)
            copied += 1
    for name in PACK_DIRS:
        source_dir = REPO / name
        for source in source_dir.rglob("*"):
            if not source.is_file() or "__pycache__" in source.parts or source.suffix == ".pyc":
                continue
            target = pack / source.relative_to(REPO)
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists() or (source.stat().st_size, source.stat().st_mtime_ns) != (target.stat().st_size, target.stat().st_mtime_ns):
                shutil.copy2(source, target)
                copied += 1
        # Remove obsolete *code* files only inside our copied package directories.
        # The independently created *_data directories are never traversed.
        destination = pack / name
        if destination.exists():
            for target in destination.rglob("*"):
                if target.is_file() and "__pycache__" not in target.parts:
                    source = REPO / target.relative_to(pack)
                    if not source.is_file():
                        target.unlink()
    # Autocomplete and related tags need actual data even in the isolated copy.
    # Reuse local data instead of downloading; preserve populated test databases.
    for name in ("danbooru.sqlite", "gelbooru.sqlite"):
        if seed_tag_data(REPO / "tagdb_data" / name, pack / "tagdb_data" / name):
            print(f"TagDB seeded from local data: {name}")
    # When no local dataset exists, initialise a valid empty DB to avoid an
    # automatic download. The TagDB panel can install data later.
    tag_path = pack / "tagdb_data" / "danbooru.sqlite"
    if not tag_path.exists():
        sys.path.insert(0, str(pack))
        from tagdb import db
        tag_path.parent.mkdir(exist_ok=True)
        connection = db.connect_write(tag_path)
        try:
            db.migrate(connection)
        finally:
            connection.close()
    print(f"Code refreshed: {copied} files; isolated root: {root}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    prepare(parser.parse_args().root)
