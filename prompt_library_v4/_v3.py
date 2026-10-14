"""Shared imports in standalone tests and ComfyUI's custom-node package loader."""
if "." in __package__:
    from ..prompt_shared.language.ast_json import to_json as ast_json
    from ..prompt_shared.language.compile import REGION_MODES, compile_text
    from ..prompt_shared.language.diagnostics import PLv3Error, Diagnostics
    from ..prompt_shared.language.document import Document, DocNode, from_ast, from_text, reconcile, render, render_all
    from ..prompt_shared.language.parser import Group, parse
    from ..prompt_shared.language.validate import validate
else:
    from prompt_shared.language.ast_json import to_json as ast_json
    from prompt_shared.language.compile import REGION_MODES, compile_text
    from prompt_shared.language.diagnostics import PLv3Error, Diagnostics
    from prompt_shared.language.document import Document, DocNode, from_ast, from_text, reconcile, render, render_all
    from prompt_shared.language.parser import Group, parse
    from prompt_shared.language.validate import validate
