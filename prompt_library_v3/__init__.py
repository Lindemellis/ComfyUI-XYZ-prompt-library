"""Prompt Library V3 — own nested-group syntax, compiled to comfyui-prompt-control.

Design spec: `prompt_library_v3_design.md` (locked).  This is P1: lexer, parser,
IR, the two backends, validation and the two nodes.  No DB, no routes, no
frontend yet — compilation is a pure function of (text, seed, region_mode) and
deliberately never reads the library (spec §4.7).

Public:
    compile_text(text, seed, region_mode, polarity) -> CompileResult
    PromptLibraryV3PositiveNode / PromptLibraryV3NegativeNode
"""

from __future__ import annotations

from .compile import CompileResult, compile_text
from .diagnostics import Diag, Diagnostics, PLv3Error
from .node import PromptLibraryV3NegativeNode, PromptLibraryV3PositiveNode

__all__ = [
    "compile_text",
    "CompileResult",
    "Diag",
    "Diagnostics",
    "PLv3Error",
    "PromptLibraryV3PositiveNode",
    "PromptLibraryV3NegativeNode",
    "setup",
]


def setup() -> None:
    """Open the library DB and register the HTTP routes."""
    from pathlib import Path

    from . import repo
    from .db import connect_write, migrate

    data_dir = Path(__file__).parent.parent / "prompt_library_v3_data"
    data_dir.mkdir(exist_ok=True)
    db_path = data_dir / "plv3.db"

    conn = connect_write(db_path)
    try:
        migrate(conn)
    finally:
        conn.close()
    repo.init(db_path)
    print(f"[PLv3] library ready at {db_path}")

    try:
        from server import PromptServer

        from .routes import register

        register(PromptServer.instance)
        print("[PLv3] routes registered")
    except Exception as exc:  # pragma: no cover - ComfyUI not running
        print(f"[PLv3] route registration skipped: {exc}")
