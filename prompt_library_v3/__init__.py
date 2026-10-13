"""Prompt Library V3 — own nested-group syntax, compiled to comfyui-prompt-control.

The document model is authoritative; rendered text contains enabled nodes only.
Compilation remains a pure function of (text, seed, region_mode) and deliberately
never reads the library database. V3 product UI/Library services are retired;
language/compiler and compatibility nodes remain shared with V4. Historical
Library tooling is retained but is never initialized by the node pack.

Public:
    compile_text(text, seed, region_mode, polarity) -> CompileResult
    PromptLibraryV3Node / PromptLibraryV3MonacoNode
"""

from __future__ import annotations

from .compile import CompileResult, compile_text
from .diagnostics import Diag, Diagnostics, PLv3Error
from .node import PromptLibraryV3MonacoNode, PromptLibraryV3Node

__all__ = [
    "compile_text",
    "CompileResult",
    "Diag",
    "Diagnostics",
    "PLv3Error",
    "PromptLibraryV3Node",
    "PromptLibraryV3MonacoNode",
    "setup",
]


def setup() -> None:
    """Historical tooling only: explicitly open the old Library and its routes.

    The node-pack initializer never calls this function after V3 retirement.
    """
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
