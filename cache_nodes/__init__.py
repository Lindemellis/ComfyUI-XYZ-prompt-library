"""Cache slots — hand an image from one graph run to the next.

Nothing to do with Krita. This is the pure-ComfyUI way of parking an intermediate
result (a base image, an upscale) so a later run can pick it up, instead of
re-running the whole chain. Krita is the other hand-off route; both exist.

Design: `mask_krita_nodes_design.md` §13.
"""

from __future__ import annotations

from .nodes import XYZCacheSlotRead, XYZCacheSlotWrite

__all__ = ["XYZCacheSlotWrite", "XYZCacheSlotRead"]
