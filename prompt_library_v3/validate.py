"""Historical import alias of the shared PLv3 language implementation."""
from importlib import import_module
import sys

_shared = import_module(__name__.partition('prompt_library_v3')[0] + 'prompt_shared.language.validate')
sys.modules[__name__] = _shared
