"""Bundle consumers. torch exists only at node execution boundaries."""
import json
import logging
import numpy as np
from .mask_images import SIZE, composite
from .mask_resources import BUNDLE_SCHEMA
if '.' in __package__:
    from ..node import ByPassTypeTuple
    from ..mask_nodes.nodes import PC_MASKS_KEY
else:
    from node import ByPassTypeTuple
    from mask_nodes.nodes import PC_MASKS_KEY


def validate_bundle(bundle):
    if not isinstance(bundle, dict) or bundle.get('schema') != BUNDLE_SCHEMA or bundle.get('version') != 1:
        raise ValueError('Unsupported PLV4 mask bundle.')
    return bundle['items']


def preview_arrays(bundle, slot_keys='[]'):
    items = validate_bundle(bundle)
    keys = json.loads(slot_keys) if isinstance(slot_keys, str) else slot_keys
    if not isinstance(keys, list) or any(not isinstance(k, str) for k in keys) or len(set(keys)) != len(keys):
        raise ValueError('Mask slot keys must be unique strings.')
    if not keys: keys = [item['key'] for item in items]
    masks = {item['key']: item['mask'] for item in items}
    return (composite(items)[None], *[masks.get(key, np.zeros((SIZE, SIZE), np.float32))[None] for key in keys])


class PLV4MaskPreview:
    CATEGORY = 'XYZNodes/Prompt'
    FUNCTION = 'execute'
    RETURN_TYPES = ByPassTypeTuple(('IMAGE',))
    RETURN_NAMES = ('preview',)
    OUTPUT_NODE = True
    @classmethod
    def INPUT_TYPES(cls):
        return dict(required=dict(mask_bundle=('PLV4_MASK_BUNDLE',), slot_keys=('STRING', dict(default='[]', multiline=False))))
    def execute(self, mask_bundle, slot_keys='[]'):
        import torch
        arrays = preview_arrays(mask_bundle, slot_keys)
        return dict(result=tuple(torch.from_numpy(a.copy()) for a in arrays), ui=dict(mask_status=[dict(key=key, unused=key not in {i['key'] for i in mask_bundle['items']}) for key in json.loads(slot_keys)]))


class PLV4AttachMasks:
    CATEGORY = 'XYZNodes/Prompt'
    FUNCTION = 'execute'
    RETURN_TYPES = ('CLIP',)
    RETURN_NAMES = ('clip',)
    @classmethod
    def INPUT_TYPES(cls):
        return dict(required=dict(clip=('CLIP',), mask_bundle=('PLV4_MASK_BUNDLE',)))
    def execute(self, clip, mask_bundle):
        import torch
        items = validate_bundle(mask_bundle)
        cloned = clip.clone()
        existing = list(clip.patcher.model_options.get(PC_MASKS_KEY, []))
        warnings = []
        for item in items:
            if item['kind'] != 'picture': continue
            actual = len(existing)
            if actual != item['expected_imask']:
                warnings.append(f"{item['label']}: expected IMASK({item['expected_imask']}), actual IMASK({actual})")
            existing.append(torch.from_numpy(item['mask'].copy())[None])
        cloned.patcher.model_options[PC_MASKS_KEY] = existing
        message = '\n'.join(warnings)
        if message: logging.getLogger(__name__).warning('[PLV4 Attach Masks] %s', message)
        return dict(result=(cloned,), ui=dict(mask_warning=[message]))
