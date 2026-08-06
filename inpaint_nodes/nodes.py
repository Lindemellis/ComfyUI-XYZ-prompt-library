"""XYZ Inpaint Stitch To RGBA — the inpainted region as a transparent layer.

Feed it the same `stitcher` and `inpainted_image` you would give **Inpaint Stitch
Improved** (ComfyUI-Inpaint-CropAndStitch) and it returns, instead of one flat
picture, the inpaint ALONE: an image the size of the original, transparent
everywhere the inpaint did not reach, with the region sitting exactly where it
belongs.

    Stitch:  mask * inpainted + (1 - mask) * original
    this:    rgb = inpainted, alpha = mask

Composite this over the original and you get Stitch's output back, pixel for pixel.
That is the point — send it to Krita (`XYZ Krita Send To Krita`, `fit: keep`) and the
inpaint arrives as a layer over your untouched artwork, still maskable and still
undoable, instead of a flattened replacement.

Nothing here imports ComfyUI-Inpaint-CropAndStitch. `STITCHER` is just a socket name
and the stitcher itself is a plain dict, so this node loads and runs whether or not
that pack is installed — it simply has nothing to connect to without it.
"""

from __future__ import annotations

import numpy as np

from .compose import place_rgba

#: The stitcher keys this node reads. Listed so a stitcher from a version that renamed
#: something fails with a sentence instead of a KeyError traceback.
REQUIRED_KEYS = (
    "canvas_image",
    "cropped_mask_for_blend",
    "cropped_to_canvas_x",
    "cropped_to_canvas_y",
    "cropped_to_canvas_w",
    "cropped_to_canvas_h",
    "canvas_to_orig_x",
    "canvas_to_orig_y",
    "canvas_to_orig_w",
    "canvas_to_orig_h",
)

#: PIL filter names the crop node stores. Anything else falls back to bicubic.
_PIL_FILTERS = ("nearest", "bilinear", "bicubic", "lanczos", "box", "hamming")


def _pil_filter(name: str):
    from PIL import Image

    key = str(name or "").lower()
    if key not in _PIL_FILTERS:
        key = "bicubic"
    return getattr(Image, key.upper())


def _rescale_rgb(array: np.ndarray, width: int, height: int, filt) -> np.ndarray:
    """(h, w, c) float 0..1 -> (height, width, c). Per channel-group, via PIL — the
    same library and the same filters the Stitch node uses, so the result matches."""
    from PIL import Image

    if array.shape[:2] == (height, width):
        return array
    mode = "RGBA" if array.shape[2] == 4 else "RGB"
    pil = Image.fromarray((np.clip(array, 0.0, 1.0) * 255.0).round().astype(np.uint8), mode)
    return np.asarray(pil.resize((width, height), filt)).astype(np.float32) / 255.0


def _rescale_mask(array: np.ndarray, width: int, height: int, filt) -> np.ndarray:
    from PIL import Image

    if array.shape == (height, width):
        return array
    pil = Image.fromarray((np.clip(array, 0.0, 1.0) * 255.0).round().astype(np.uint8), "L")
    return np.asarray(pil.resize((width, height), filt)).astype(np.float32) / 255.0


def _np(tensor) -> np.ndarray:
    """A torch tensor or an array -> float32 numpy on the CPU. `np.asarray` reads both,
    which is what keeps the maths (and its tests) off torch."""
    if hasattr(tensor, "detach"):
        tensor = tensor.detach().cpu()
    return np.asarray(tensor, dtype=np.float32)


def _item(value, index: int, single: bool):
    """One batch entry out of a stitcher field.

    Every per-image field is a LIST — one entry per image the crop node saw. A stitcher
    made from one image drives a whole batch (the Stitch node allows it), which is what
    `single` covers.
    """
    if not isinstance(value, (list, tuple)):
        return value
    return value[0] if single else value[index]


def _scalar(value) -> int:
    """The coordinates arrive as ints, 0-d tensors or 1-element tensors."""
    if hasattr(value, "item"):
        try:
            return int(value.item())
        except (ValueError, RuntimeError):
            pass
    if isinstance(value, (list, tuple)) and len(value) == 1:
        return _scalar(value[0])
    return int(value)


def layers_from_stitcher(stitcher: dict, inpainted) -> np.ndarray:
    """(B, H, W, 4) straight-alpha layers, one per inpainted image. Pure numpy."""
    missing = [k for k in REQUIRED_KEYS if k not in stitcher]
    if missing:
        raise ValueError(
            "this stitcher is missing " + ", ".join(missing) + " — it did not come "
            "from Inpaint Crop Improved, or that node's format changed"
        )

    images = _np(inpainted)
    if images.ndim == 3:
        images = images[None, ...]
    batch = images.shape[0]

    count = len(stitcher["cropped_to_canvas_x"])
    if count != batch and count != 1:
        raise ValueError(
            f"the stitcher holds {count} image(s) but {batch} were inpainted — they "
            "must match, or the stitcher must hold exactly one"
        )
    single = count == 1 and batch != 1

    down = _pil_filter(stitcher.get("downscale_algorithm"))
    up = _pil_filter(stitcher.get("upscale_algorithm"))

    out = []
    for index in range(batch):
        canvas = _np(_item(stitcher["canvas_image"], index, single))
        if canvas.ndim == 4:
            canvas = canvas[0]
        mask = _np(_item(stitcher["cropped_mask_for_blend"], index, single))
        while mask.ndim > 2:
            mask = mask[0]

        ctc = tuple(
            _scalar(_item(stitcher[f"cropped_to_canvas_{k}"], index, single))
            for k in "xywh"
        )
        cto = tuple(
            _scalar(_item(stitcher[f"canvas_to_orig_{k}"], index, single))
            for k in "xywh"
        )

        image = images[index]
        # Up or down decides the filter, exactly as the Stitch node decides it — the
        # two must agree or this layer will not composite back to Stitch's output.
        filt = up if (ctc[2] > image.shape[1] or ctc[3] > image.shape[0]) else down
        image = _rescale_rgb(image, ctc[2], ctc[3], filt)
        mask = _rescale_mask(mask, ctc[2], ctc[3], filt)

        out.append(place_rgba(image, mask, canvas.shape[1], canvas.shape[0], ctc, cto))

    return np.stack(out, axis=0)


class XYZInpaintStitchToRGBA:
    NAME = "XYZ Inpaint Stitch To RGBA"
    DESCRIPTION = (
        "The inpainted region ALONE, on a transparent image the size of the "
        "original, at the position it belongs.\n"
        "Same inputs as Inpaint Stitch Improved, but instead of one flat picture you "
        "get a layer: RGB is the inpaint, alpha is its (feathered) blend mask. "
        "Composite it over the original and you get Stitch's output back exactly.\n"
        "Send it to Krita with 'XYZ Krita Send To Krita' (fit: keep) and the inpaint "
        "lands as a layer over your untouched artwork."
    )
    CATEGORY = "XYZNodes"
    RETURN_TYPES = ("IMAGE", "MASK")
    RETURN_NAMES = ("image", "mask")
    FUNCTION = "execute"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "stitcher": ("STITCHER",),
                "inpainted_image": ("IMAGE",),
            }
        }

    def execute(self, stitcher, inpainted_image):
        import torch

        layers = layers_from_stitcher(stitcher, inpainted_image)
        image = torch.from_numpy(layers)
        # The alpha, on its own, as a MASK — for anything downstream that wants to
        # select the region rather than draw it.
        mask = torch.from_numpy(layers[..., 3].copy())
        height, width = layers.shape[1:3]
        print(
            f"[XYZ Inpaint] {layers.shape[0]} layer(s) at {width}x{height}, "
            f"alpha covers {float(layers[..., 3].mean()) * 100:.1f}% of the frame"
        )
        return (image, mask)


NODE_CLASS_MAPPINGS = {"XYZInpaintStitchToRGBA": XYZInpaintStitchToRGBA}
NODE_DISPLAY_NAME_MAPPINGS = {"XYZInpaintStitchToRGBA": XYZInpaintStitchToRGBA.NAME}
