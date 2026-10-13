"""Disposable Mask Library fixture; no personal resources or model execution."""
from pathlib import Path
import os
import runpy
import sys
import tempfile

REPO = Path(__file__).resolve().parents[2]
SCRATCH = Path(os.environ.get('PLV4_FIXTURE_ROOT', Path(tempfile.gettempdir()) / 'xyz-mask-comfy-fixture'))


if __name__ == '__main__':
    os.environ['PLV4_FIXTURE_ROOT'] = str(SCRATCH)
    runpy.run_path(str(REPO / 'test/manual/plv4_comfy_fixture.py'), run_name='__main__')
    wrapper = SCRATCH / 'custom_nodes' / 'plv4_fixture'
    (wrapper / '__init__.py').write_text(f"import runpy\nglobals().update(runpy.run_path({str(Path(__file__).resolve())!r}, run_name='mask_fixture'))\n", encoding='utf-8')
    import shutil
    shutil.copy2(REPO / 'js/xyz_plv4_mask_preview.js', wrapper / 'js/xyz_plv4_mask_preview.js')
    from PIL import Image
    import numpy as np
    directory = SCRATCH / 'input' / 'xyz_masks'; directory.mkdir(parents=True, exist_ok=True)
    pixels = np.zeros((32, 64, 4), np.uint8)
    pixels[:, :32] = [0, 0, 0, 255]; pixels[:, 32:] = [255, 255, 255, 128]
    Image.fromarray(pixels).save(directory / 'Split.png')
else:
    os.environ['PLV4_FIXTURE_ROOT'] = str(SCRATCH)
    globals().update(runpy.run_path(str(REPO / 'test/manual/plv4_comfy_fixture.py'), run_name='comfy_fixture'))
    from prompt_library_v4.mask_nodes import PLV4MaskPreview, PLV4AttachMasks
    NODE_CLASS_MAPPINGS.update({'XYZ PLV4 Mask Preview': PLV4MaskPreview, 'XYZ PLV4 Attach Masks': PLV4AttachMasks})
    class SyntheticClip:
        def __init__(self, options):
            from types import SimpleNamespace
            self.patcher = SimpleNamespace(model_options=options)
        def clone(self): return SyntheticClip(dict(self.patcher.model_options))
    class ClipFixture:
        CATEGORY = 'PLv4 Fixture'
        FUNCTION = 'execute'
        RETURN_TYPES = ('CLIP',)
        @classmethod
        def INPUT_TYPES(cls): return {'required': {'count': ('INT', {'default':0,'min':0,'max':4})}}
        def execute(self, count):
            import torch
            return (SyntheticClip({'x-promptcontrol.masks':[torch.ones(1,512,512) for _ in range(count)]}),)
    class ClipCapture:
        CATEGORY = 'PLv4 Fixture'
        FUNCTION = 'execute'
        RETURN_TYPES = ()
        OUTPUT_NODE = True
        @classmethod
        def INPUT_TYPES(cls): return {'required': {'clip': ('CLIP',)}}
        def execute(self, clip):
            masks = clip.patcher.model_options['x-promptcontrol.masks']
            return {'ui': {'count':[len(masks)], 'shapes':[list(m.shape) for m in masks]}}
    NODE_CLASS_MAPPINGS.update({'PLv4 Mask Fixture Clip':ClipFixture,'PLv4 Mask Fixture Capture':ClipCapture})
    NODE_DISPLAY_NAME_MAPPINGS.update({name:name for name in NODE_CLASS_MAPPINGS})
