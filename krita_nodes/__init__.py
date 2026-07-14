"""Krita integration — pull layers and masks out of a running Krita.

ComfyUI is the main tool here and Krita is the sketchpad: you draw, ComfyUI asks
for the layer when the graph runs. See `README.md`.

The plugin, the installer, the layer list, and four nodes: Fetch Image, Fetch
Mask, Fetch Color Masks and Send To Krita. The cache slots live in
`cache_nodes/` — they have nothing to do with Krita.
"""

from __future__ import annotations

from .nodes import (
    XYZKritaFetchColorMasks,
    XYZKritaFetchImage,
    XYZKritaFetchMask,
    XYZKritaOpenFile,
    XYZKritaSendToKrita,
)

__all__ = [
    "XYZKritaFetchImage",
    "XYZKritaFetchMask",
    "XYZKritaFetchColorMasks",
    "XYZKritaSendToKrita",
    "XYZKritaOpenFile",
    "setup",
]


def setup() -> None:
    from server import PromptServer

    from .routes import register

    register(PromptServer.instance)
    print("[XYZ Krita] routes registered")
