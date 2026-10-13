"""Historical import alias; one shared compiler preserves module identity."""
from importlib import import_module
import sys

_shared = import_module(__name__.partition('prompt_library_v3')[0] + 'prompt_shared.language.compile')
for _child in ('common', 'couple', 'mask'):
    sys.modules[__name__ + '.' + _child] = import_module(_shared.__name__ + '.' + _child)
sys.modules[__name__] = _shared
