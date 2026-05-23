"""Prompt Library V2 — package init and ComfyUI setup hook.

Completely isolated from v1 (prompt_library_node.py / prompt_library/ dir).
Call setup() once during ComfyUI startup from the top-level __init__.py.

Public node classes (re-exported for top-level __init__.py):
    PromptLibraryV2PositiveNode
    PromptLibraryV2NegativeNode
"""

from __future__ import annotations

import os
from pathlib import Path

_PKG_DIR = Path(__file__).parent
_DATA_DIR = _PKG_DIR.parent / "prompt_library_v2_data"


def _ensure_db() -> Path:
    _DATA_DIR.mkdir(exist_ok=True)
    db_path = _DATA_DIR / "plv2.db"

    from .db import connect_write, migrate

    conn = connect_write(db_path)
    try:
        migrate(conn)
    finally:
        conn.close()

    return db_path


from .node import PromptLibraryV2PositiveNode, PromptLibraryV2NegativeNode

__all__ = ["setup", "PromptLibraryV2PositiveNode", "PromptLibraryV2NegativeNode"]


def setup() -> None:
    """Initialise DB and register API routes. Called from top-level __init__.py."""
    db_path = _ensure_db()
    from . import repo
    repo.init(db_path)
    print(f"[PLv2] database ready at {db_path}")

    try:
        from server import PromptServer
        from .routes import register
        register(PromptServer.instance)
        print("[PLv2] routes registered")
    except Exception as e:
        print(f"[PLv2] route registration skipped: {e}")
