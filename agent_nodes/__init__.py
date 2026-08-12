"""Agent orchestrator launcher — one button instead of a terminal.

The comfyui-mcp sidebar panel is a pure frontend extension by design (the Comfy
Registry forbids a published node pack from spawning processes), so it can only
tell you to run a command yourself. This pack is not published there, so it
starts the process for you — the same trick `krita_nodes` uses for krita.exe.

Ships no nodes: routes + the XYZ Tools menu entry in `js/xyz_agent_output.js`.
"""

from __future__ import annotations

__all__ = ["setup"]


def setup() -> None:
    from server import PromptServer

    from .routes import register

    register(PromptServer.instance)
    print("[XYZ Agent] routes registered")
