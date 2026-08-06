from .prompt_library_v2 import PromptLibraryV2PositiveNode, PromptLibraryV2NegativeNode
from .prompt_library_v3 import PromptLibraryV3Node, PromptLibraryV3MonacoNode
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



NODE_CLASS_MAPPINGS = {
    "XYZ Prompt Library V2 Positive": PromptLibraryV2PositiveNode,
    "XYZ Prompt Library V2 Negative": PromptLibraryV2NegativeNode,
    "XYZ Prompt Library V3": PromptLibraryV3Node,
    "XYZ Prompt Library V3 Monaco": PromptLibraryV3MonacoNode,
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


# The gallery, the LLM assistant and the TagDB are all handed PromptServer.instance
# below; the PLv2/PLv3/Krita/cache setups import it themselves.
from server import PromptServer


try:
    from . import gallery as _xyz_gallery
    _xyz_gallery.setup(PromptServer.instance.app)
except Exception as _xyz_gallery_err:
    print(f"[XYZ Gallery] setup failed, continuing without gallery: {_xyz_gallery_err!r}")

try:
    from .prompt_library_v2 import setup as _plv2_setup
    _plv2_setup()
except Exception as _plv2_err:
    print(f"[PLv2] setup failed, continuing without PLv2: {_plv2_err!r}")

try:
    from .prompt_library_v3 import setup as _plv3_setup
    _plv3_setup()
except Exception as _plv3_err:
    print(f"[PLv3] setup failed, continuing without PLv3: {_plv3_err!r}")

# LLM Prompt Assistant — must run AFTER PLv2 (reuses its DB + WriteQueue).
try:
    from .llm import setup as _llm_setup
    _llm_setup(PromptServer.instance)
except Exception as _llm_err:
    print(f"[LLM] setup failed, continuing without LLM assistant: {_llm_err!r}")

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

