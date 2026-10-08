"""Shared imports in standalone tests and ComfyUI's custom-node package loader."""
if "." in __package__:
    from ..prompt_library_v3.ast_json import to_json as ast_json
    from ..prompt_library_v3.compile import compile_text
    from ..prompt_library_v3.diagnostics import PLv3Error, Diagnostics
    from ..prompt_library_v3.document import Document, DocNode, from_text, reconcile, render
    from ..prompt_library_v3.parser import Group, parse
    from ..prompt_library_v3.validate import validate
else:
    from prompt_library_v3.ast_json import to_json as ast_json
    from prompt_library_v3.compile import compile_text
    from prompt_library_v3.diagnostics import PLv3Error, Diagnostics
    from prompt_library_v3.document import Document, DocNode, from_text, reconcile, render
    from prompt_library_v3.parser import Group, parse
    from prompt_library_v3.validate import validate
