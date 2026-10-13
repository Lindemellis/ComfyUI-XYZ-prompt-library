"""Pure Mask Library extraction and square geometry (no torch/ComfyUI)."""
import base64
import hashlib
import io
import math

import numpy as np
from PIL import Image

SIZE = 512
DEFAULT_SETTINGS = dict(count=4, tolerance=0.05, invert_alpha=False)


def coordinates(value):
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise ValueError('A rectangle requires x1, x2, y1 and y2 coordinates.')
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not 0 <= v <= 1 for v in value):
        raise ValueError('Rectangle coordinates must be between 0 and 1.')
    x1, x2, y1, y2 = map(float, value)
    if x1 >= x2 or y1 >= y2:
        raise ValueError('A rectangle must have positive area.')
    return [x1, x2, y1, y2]


def settings(value=None):
    result = {**DEFAULT_SETTINGS, **(value or {})}
    if set(result) != set(DEFAULT_SETTINGS) or type(result['count']) is not int or not 1 <= result['count'] <= 32:
        raise ValueError('Color count must be between 1 and 32.')
    if type(result['invert_alpha']) is not bool or isinstance(result['tolerance'], bool) or not 0 <= result['tolerance'] <= 1:
        raise ValueError('Invalid image extraction settings.')
    return result


def rectangle(value, size=SIZE):
    # Library rectangles are validated on write. Historical manually authored
    # MASK syntax may be degenerate or use integer pixel coordinates.
    if '.' in __package__:
        from ..prompt_shared.language.ir import num
    else:
        from prompt_shared.language.ir import num
    x1, x2, y1, y2 = [float(num(v)) for v in value]
    mask = np.zeros((size, size), np.float32)
    # Prompt Control quantises fractional coordinates to integer pixel bounds.
    scale = size if all(0 <= v <= 1 for v in value) else 1
    x1, x2, y1, y2 = [max(0, min(size, int(v * scale))) for v in (x1, x2, y1, y2)]
    mask[y1:y2, x1:x2] = 1
    return mask


def extract(data, config=None):
    config = settings(config)
    with Image.open(io.BytesIO(data)) as image:
        image.seek(0)
        has_alpha = 'A' in image.getbands() or 'transparency' in image.info
        rgba = np.asarray(image.convert('RGBA'))
    rgb, alpha = rgba[..., :3], rgba[..., 3]
    solid = rgb[alpha >= 128].astype(np.uint32)
    colors = []
    if len(solid):
        packed = (solid[:, 0] << 16) | (solid[:, 1] << 8) | solid[:, 2]
        values, counts = np.unique(packed, return_counts=True)
        chosen = values[np.lexsort((values, -counts))[:config['count']]]
        colors = [(int(v >> 16), int((v >> 8) & 255), int(v & 255)) for v in chosen]
    # Reuse the established nearest-colour assignment; Krita's hex output order
    # remains its own contract. Apply original alpha to preserve soft edges.
    if '.' in __package__:
        from ..krita_nodes.nodes import split_colors
    else:
        from krita_nodes.nodes import split_colors
    masks = {}
    if has_alpha:
        masks['alpha'] = alpha.astype(np.float32) / 255 if config['invert_alpha'] else 1 - alpha.astype(np.float32) / 255
    for color, mask in zip(colors, split_colors(rgb, alpha, colors, config['tolerance'])):
        key = 'rgb:' + ''.join(f'{c:02x}' for c in color)
        masks[key] = mask * (alpha.astype(np.float32) / 255)
    masks = {key: np.asarray(Image.fromarray(mask).resize((SIZE, SIZE), Image.Resampling.BILINEAR), dtype=np.float32).copy() for key, mask in masks.items()}
    return dict(masks=masks, colors=colors, has_alpha=has_alpha, fingerprint=hashlib.sha256(data).hexdigest())


def composite(items, size=SIZE):
    image = np.ones((size, size, 3), np.float32)
    for item in reversed(items):  # first row is visually on top
        color = item.get('color', '#75a5df').lstrip('#')
        rgb = np.array([int(color[i:i+2], 16) / 255 for i in (0, 2, 4)], np.float32)
        mask = item['mask'][..., None]
        image = mask * rgb + (1 - mask) * image
    return image


def png_url(array):
    data = np.clip(array * 255, 0, 255).round().astype(np.uint8)
    out = io.BytesIO()
    Image.fromarray(data).save(out, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(out.getvalue()).decode('ascii')
