"""Historical import alias; one shared compiler preserves module identity."""
from importlib import import_module
import sys

_shared = import_module(__name__.partition('prompt_library_v3')[0] + 'prompt_shared.language.compile.common')
sys.modules[__name__] = _shared
