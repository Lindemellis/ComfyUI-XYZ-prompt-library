"""Krita integration — pull layers and masks out of a running Krita.

ComfyUI is the main tool here and Krita is the sketchpad: you draw, ComfyUI asks
for the layer when the graph runs. See `README.md`.

Phase one: the plugin, the installer, the layer list, and the two fetch nodes.
Send To Krita, Fetch Color Masks and the cache slots are still to come — see
`mask_krita_nodes_design.md`.
"""

from __future__ import annotations

from .nodes import XYZKritaFetchImage, XYZKritaFetchMask

__all__ = ["XYZKritaFetchImage", "XYZKritaFetchMask", "setup"]


def setup() -> None:
    from server import PromptServer

    from .routes import register

    register(PromptServer.instance)
    print("[XYZ Krita] routes registered")
