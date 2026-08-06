"""Inpaint helpers that work off ComfyUI-Inpaint-CropAndStitch's stitcher.

No import of that pack, and no dependency on it: `STITCHER` is a socket name and the
stitcher is a plain dict, so these nodes load either way.
"""

from .nodes import XYZInpaintStitchToRGBA

__all__ = ["XYZInpaintStitchToRGBA"]
