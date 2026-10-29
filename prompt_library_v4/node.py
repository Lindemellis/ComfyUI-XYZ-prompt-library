"""V4 node identities, with the existing editor sockets and pure compiler."""
import hashlib
import json

from .compiler import compile_document
from .model import EditorState
from ._v3 import REGION_MODES

if '.' in __package__:
    from ..prompt_shared.node_schema import PromptNodeSchema
else:
    from prompt_shared.node_schema import PromptNodeSchema


class PromptLibraryV4Node(PromptNodeSchema):
    REGION_MODES = REGION_MODES
    NAME = 'Prompt Library V4'
    DESCRIPTION = 'Edit prompt blocks, Class pools and Mask Library references. Outputs: prompt / plain / metadata / mask_bundle. Connect masks to XYZ PLV4 Mask Preview and Attach Masks.'
    RETURN_TYPES = ('STRING', 'STRING', 'PLV4_METADATA', 'PLV4_MASK_BUNDLE')
    RETURN_NAMES = ('prompt', 'plain', 'metadata', 'mask_bundle')
    OUTPUT_TOOLTIPS = (*PromptNodeSchema.OUTPUT_TOOLTIPS,
        'Execution snapshot: Source, full Document (including disabled items), prompt, plain, seed and effective LoRAs.',
        'Resolved rectangle/image masks. Connect to XYZ PLV4 Mask Preview / Attach Masks.')

    @classmethod
    def INPUT_TYPES(cls):
        schema = super().INPUT_TYPES()
        # Append sockets, preserving every historical widget/socket position.
        schema['optional'].update(width=('INT', {'forceInput': True, 'min': 16, 'max': 16384, 'step': 16}),
                                  height=('INT', {'forceInput': True, 'min': 16, 'max': 16384, 'step': 16}))
        return schema

    @classmethod
    def IS_CHANGED(cls, text='', seed=0, region_mode='couple', doc='', width=None, height=None, **_):
        # LoRA block markers protect the invocation during its own randomisation.
        # Other presentation/pool metadata remains irrelevant to generation.
        try:
            state = EditorState.create(doc=json.loads(doc)) if doc and doc.strip() else EditorState.create(text=text)
            content = json.dumps(state.doc.to_json(), ensure_ascii=False, sort_keys=True)
            from .mask_resources import fingerprint
            content += fingerprint(state)
        except (ValueError, TypeError, KeyError, AttributeError, OSError):
            # A broken resource must never reuse an earlier successful execution.
            return float('nan')
        return hashlib.sha256(f'{content}\0{seed}\0{region_mode}\0{width}\0{height}\0plv4'.encode()).hexdigest()

    def execute(self, text='', seed=0, region_mode='couple', doc='', width=None, height=None, **_):
        # A supplied corrupt document must surface, not silently execute older text.
        state = EditorState.create(doc=json.loads(doc)) if doc and doc.strip() else EditorState.create(text=text)
        result = compile_document(state, seed=seed, region_mode=region_mode, include_metadata=True, width=width, height=height)
        return result['prompt'], result['plain'], result['metadata'], result['mask_bundle']


class PromptLibraryV4MonacoNode(PromptLibraryV4Node):
    NAME = 'Prompt Library V4 (Monaco)'
