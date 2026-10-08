from .prompt_library_v3 import PromptLibraryV3Node, PromptLibraryV3MonacoNode
from .prompt_library_v4.node import PromptLibraryV4Node, PromptLibraryV4MonacoNode
from .mask_nodes import XYZAttachMasks, XYZMaskEditor
from .krita_nodes import (
    XYZKritaFetchColorMasks,
    XYZKritaFetchImage,
    XYZKritaFetchMask,
    XYZKritaOpenFile,
    XYZKritaSendToKrita,
)
from .cache_nodes import XYZCacheSlotRead, XYZCacheSlotWrite
from .inpaint_nodes import XYZInpaintStitchToRGBA

# ComfyUI's scheduled WeightHooks need full parameter replacement on quantized
# models. Install the guarded compatibility shim at node-pack startup.
try:
    from .quantized_hook_compat import install as _install_quantized_hook_compat
    _install_quantized_hook_compat()
except Exception as _quantized_hook_err:
    import logging
    logging.warning("[XYZ] quantized WeightHook compatibility unavailable: %r", _quantized_hook_err)



NODE_CLASS_MAPPINGS = {
    "XYZ Prompt Library V3": PromptLibraryV3Node,
    "XYZ Prompt Library V3 Monaco": PromptLibraryV3MonacoNode,
    "XYZ Prompt Library V4": PromptLibraryV4Node,
    "XYZ Prompt Library V4 Monaco": PromptLibraryV4MonacoNode,
    "XYZ Mask Editor": XYZMaskEditor,
    "XYZ Attach Masks": XYZAttachMasks,
    "XYZ Krita Fetch Image": XYZKritaFetchImage,
    "XYZ Krita Fetch Mask": XYZKritaFetchMask,
    "XYZ Krita Fetch Color Masks": XYZKritaFetchColorMasks,
    "XYZ Krita Send To Krita": XYZKritaSendToKrita,
    "XYZ Krita Open File": XYZKritaOpenFile,
    "XYZ Cache Slot Write": XYZCacheSlotWrite,
    "XYZ Inpaint Stitch To RGBA": XYZInpaintStitchToRGBA,
    "XYZ Cache Slot Read": XYZCacheSlotRead,
}

WEB_DIRECTORY = "./js"
__all__ = ["NODE_CLASS_MAPPINGS", "WEB_DIRECTORY"]


# The gallery and TagDB are handed PromptServer.instance below; the
# PLv3/Krita/cache setups import it themselves.
from server import PromptServer


try:
    from . import gallery as _xyz_gallery
    _xyz_gallery.setup(PromptServer.instance.app)
except Exception as _xyz_gallery_err:
    print(f"[XYZ Gallery] setup failed, continuing without gallery: {_xyz_gallery_err!r}")

try:
    from .prompt_library_v3 import setup as _plv3_setup
    _plv3_setup()
except Exception as _plv3_err:
    print(f"[PLv3] setup failed, continuing without PLv3: {_plv3_err!r}")

try:
    from .krita_nodes import setup as _krita_setup
    _krita_setup()
except Exception as _krita_err:
    print(f"[XYZ Krita] setup failed, continuing without the Krita routes: {_krita_err!r}")

try:
    from .cache_nodes import setup as _cache_setup
    _cache_setup()
except Exception as _cache_err:
    print(f"[XYZ Cache] setup failed, continuing without the cache routes: {_cache_err!r}")

try:
    from .tagdb import setup as _tagdb_setup
    _tagdb_setup(PromptServer.instance)
except Exception as _tagdb_err:
    print(f"[TagDB] setup failed, continuing without TagDB: {_tagdb_err!r}")

try:
    from .agent_nodes import setup as _agent_setup
    _agent_setup()
except Exception as _agent_err:
    print(f"[XYZ Agent] setup failed, continuing without the agent routes: {_agent_err!r}")

