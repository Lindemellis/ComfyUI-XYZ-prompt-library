"""Separate V4 store; V3 personal data remains intact until explicit migration."""
import atexit
from pathlib import Path
from .assets import AssetLibrary
from .asset_routes import register

_library = None


def setup(server, path=None, legacy_source=None):
    global _library
    if _library is not None: return _library
    _library = AssetLibrary(path or Path(__file__).resolve().parent.parent / 'prompt_library_v4_data' / 'plv4-pools.db')
    register(server, _library, legacy_source or (Path(path).parent / 'library.db' if path else Path(__file__).resolve().parent.parent / 'prompt_library_v3_data' / 'plv3.db'))
    import folder_paths
    from .loras import LoraBrowser
    from .lora_routes import register as register_loras
    register_loras(server, LoraBrowser(lambda: folder_paths.get_folder_paths('loras'), _library, _library.path.parent / 'lora-metadata', extensions=lambda: folder_paths.folder_names_and_paths['loras'][1]))
    atexit.register(_library.close)
    return _library
