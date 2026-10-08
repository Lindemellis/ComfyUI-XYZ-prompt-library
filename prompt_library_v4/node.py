"""V4 node identities, with the existing editor sockets and pure compiler."""
import hashlib
import json

from .compiler import compile_document
from .model import EditorState

if '.' in __package__:
    from ..prompt_library_v3.node import _PLv3Base
else:
    from prompt_library_v3.node import _PLv3Base


class PromptLibraryV4Node(_PLv3Base):
    NAME = 'Prompt Library V4'
    DESCRIPTION = 'Edit prompt blocks and Folder pool candidates. All random choices use the ComfyUI node seed. Outputs: prompt / plain.'

    @classmethod
    def IS_CHANGED(cls, text='', seed=0, region_mode='couple', doc='', **_):
        # Metadata does not change generation; invalid JSON still invalidates cache.
        try:
            state = EditorState.create(doc=json.loads(doc)) if doc and doc.strip() else EditorState.create(text=text)
            content = state.text
        except (ValueError, TypeError, KeyError, AttributeError): content = doc or text
        return hashlib.sha256(f'{content}\0{seed}\0{region_mode}\0plv4'.encode()).hexdigest()

    def execute(self, text='', seed=0, region_mode='couple', doc='', **_):
        # A supplied corrupt document must surface, not silently execute older text.
        state = EditorState.create(doc=json.loads(doc)) if doc and doc.strip() else EditorState.create(text=text)
        result = compile_document(state, seed=seed, region_mode=region_mode)
        return result['prompt'], result['plain']


class PromptLibraryV4MonacoNode(PromptLibraryV4Node):
    NAME = 'Prompt Library V4 (Monaco)'
