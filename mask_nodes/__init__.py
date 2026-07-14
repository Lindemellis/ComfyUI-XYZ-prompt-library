"""Rectangle mask editor + mask attachment nodes.

Design spec: `mask_krita_nodes_design.md`, part one (decisions 1–7).

`XYZ Mask Editor` draws rectangles on a fixed 512x512 canvas and emits one MASK
per rectangle (plus `base` and `fill`).  `XYZ Attach Masks` hangs those masks off
a CLIP so PLv3's `imask: i` can address them.
"""

from __future__ import annotations

from .nodes import XYZAttachMasks, XYZMaskEditor

__all__ = ["XYZMaskEditor", "XYZAttachMasks"]
