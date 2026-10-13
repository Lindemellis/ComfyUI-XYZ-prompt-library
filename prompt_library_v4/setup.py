"""Separate V4 store; V3 personal data remains intact until explicit migration."""
import atexit
from pathlib import Path
from .assets import AssetLibrary
from .asset_routes import register
from .routes import register as register_document

if '.' in __package__:
    from ..prompt_shared.language_routes import register as register_language
else:
    from prompt_shared.language_routes import register as register_language

_library = None


def setup(server, path=None, legacy_source=None):
    global _library
    register_document(server)
    register_language(server)
    if _library is not None: return _library
    _library = AssetLibrary(path or Path(__file__).resolve().parent.parent / 'prompt_library_v4_data' / 'plv4-pools.db')
    register(server, _library, legacy_source or (Path(path).parent / 'library.db' if path else Path(__file__).resolve().parent.parent / 'prompt_library_v3_data' / 'plv3.db'))
    import folder_paths
    from .mask_library import MaskLibrary, set_current
    from .mask_routes import register as register_masks
    masks = MaskLibrary(_library.path.parent / 'masks.db', folder_paths.get_input_directory())
    set_current(masks)
    register_masks(server, masks)
    atexit.register(masks.close)
    from .loras import LoraBrowser
    from .lora_routes import register as register_loras
    register_loras(server, LoraBrowser(lambda: folder_paths.get_folder_paths('loras'), _library, _library.path.parent / 'lora-metadata', extensions=lambda: folder_paths.folder_names_and_paths['loras'][1]))
    atexit.register(_library.close)
    return _library
