"""LLM Prompt Assistant — package init and ComfyUI setup hook.

Reuses the Prompt Library V2 SQLite DB + WriteQueue (schema v7 tables). Must be set up
AFTER prompt_library_v2.setup() (which runs the migration + repo.init()).

Call setup(server) once during ComfyUI startup from the top-level __init__.py.
"""

from __future__ import annotations

__all__ = ["setup"]


def setup(server=None) -> None:
    """Seed the default preset (once) and register the /xyz/llm/ routes."""
    try:
        from . import store
        store.seed_defaults_if_needed()
    except Exception as e:
        print(f"[LLM] default seed skipped: {e}")

    try:
        if server is None:
            from server import PromptServer
            server = PromptServer.instance
        from .routes import register
        register(server)
        print("[LLM] routes registered")
    except Exception as e:
        print(f"[LLM] route registration skipped: {e}")
