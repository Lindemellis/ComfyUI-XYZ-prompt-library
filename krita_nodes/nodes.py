"""XYZ Krita Fetch Image / XYZ Krita Fetch Mask.

Pull, not push: the node asks Krita for the layer when the graph runs, and blocks
until Krita answers (design decision 11). Krita not running is an error, on
purpose — silently substituting a blank image would waste a generation.

The `layer` widget is a COMBO whose values the frontend fills in from
`/xyz/krita/layers` (js/xyz_krita.js). ComfyUI would normally reject a value that
is not in the list INPUT_TYPES declared, so both nodes define `VALIDATE_INPUTS`
with `layer` in the signature — that makes ComfyUI skip its own combo check for
that input (execution.py:1007).
"""

from __future__ import annotations

import hashlib
import io
import time

import numpy as np

from . import client

#: What the frontend shows before it has talked to Krita.
LAYER_PLACEHOLDER = "(click Refresh layers)"

#: The combo entry that means the whole flattened document.
DOCUMENT_ENTRY = "document: (whole document, flattened)"

RESIZE_MODES = ["none", "by_width", "by_height"]

#: name -> PIL resampling filter, resolved lazily so importing this module does
#: not require PIL.
INTERPOLATIONS = ["nearest", "bilinear", "bicubic", "lanczos", "area"]


def _pil_filter(name: str):
    from PIL import Image

    return {
        "nearest": Image.NEAREST,
        "bilinear": Image.BILINEAR,
        "bicubic": Image.BICUBIC,
        "lanczos": Image.LANCZOS,
        "area": Image.BOX,
    }.get(name, Image.LANCZOS)


def layer_key(value: str) -> str:
    """The id out of a combo entry.

    The entry is `"<short id>: <layer name>"`. The id comes first and is fixed
    width, so a layer name containing a colon cannot break the split. The plugin
    matches an id by prefix, so the short form is enough.
    """
    return (value or "").split(":", 1)[0].strip()


def combo_entry(layer: dict) -> str:
    return f"{short_id(layer['id'])}: {layer['name']}"


def short_id(unique_id: str) -> str:
    return unique_id.strip("{}").replace("-", "")[:8]


def _round_to(value: float, multiple: int) -> int:
    value = max(1, int(round(value)))
    if multiple and multiple > 1:
        value = max(multiple, int(round(value / multiple)) * multiple)
    return value


def _decode(png: bytes):
    from PIL import Image

    return Image.open(io.BytesIO(png))


def _resize(image, mode: str, size: int, round_to: int, interpolation: str):
    """Keeps the aspect ratio; `size` is the target width or height."""
    if mode == "none":
        return image

    width, height = image.size
    if width == 0 or height == 0:
        return image

    if mode == "by_width":
        target_w = _round_to(size, round_to)
        target_h = _round_to(size * height / width, round_to)
    else:  # by_height
        target_h = _round_to(size, round_to)
        target_w = _round_to(size * width / height, round_to)

    if (target_w, target_h) == (width, height):
        return image
    return image.resize((target_w, target_h), _pil_filter(interpolation))


# ------------------------------------------------------------------ the nodes


class _KritaBase:
    CATEGORY = "XYZNodes/Krita"
    FUNCTION = "execute"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Krita's document changes without ComfyUI knowing, so a cached result is
        # always suspect: re-fetch every run.
        return time.time()

    @classmethod
    def VALIDATE_INPUTS(cls, layer=None, **kwargs):
        # Naming `layer` here is what makes ComfyUI skip its combo-membership
        # check — the real values only exist once the frontend has asked Krita.
        return True


class XYZKritaFetchImage(_KritaBase):
    NAME = "XYZ Krita Fetch Image"
    DESCRIPTION = (
        "Pulls a layer (or the whole document) out of the running Krita as an IMAGE.\n"
        "Click 'Refresh layers' on the node to load Krita's layer list.\n"
        "Krita must be running with the 'XYZ ComfyUI Bridge' plugin enabled."
    )
    RETURN_TYPES = ("IMAGE", "INT", "INT")
    RETURN_NAMES = ("image", "width", "height")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "layer": ([LAYER_PLACEHOLDER], {"tooltip": "Which Krita layer to fetch."}),
                "resize_mode": (
                    RESIZE_MODES,
                    {
                        "default": "none",
                        "tooltip": "by_width / by_height keep the aspect ratio.",
                    },
                ),
                "size": (
                    "INT",
                    {
                        "default": 1216,
                        "min": 8,
                        "max": 16384,
                        "tooltip": "The target width or height, per resize_mode.",
                    },
                ),
                "round_to": (
                    "INT",
                    {
                        "default": 8,
                        "min": 1,
                        "max": 64,
                        "tooltip": "Snap the result to a multiple of this. 8 keeps "
                        "the latent happy.",
                    },
                ),
                "interpolation": (INTERPOLATIONS, {"default": "lanczos"}),
                "max_wait": (
                    "FLOAT",
                    {"default": 60.0, "min": 1.0, "max": 600.0, "step": 1.0},
                ),
            },
        }

    def execute(
        self,
        layer=LAYER_PLACEHOLDER,
        resize_mode="none",
        size=1216,
        round_to=8,
        interpolation="lanczos",
        max_wait=60.0,
        **_,
    ):
        import torch

        key = layer_key(layer)
        if not key or layer == LAYER_PLACEHOLDER:
            raise RuntimeError(
                "No Krita layer chosen. Click 'Refresh layers' on the node, then "
                "pick one."
            )

        png = client.fetch_image(key, timeout=max_wait)
        image = _decode(png)
        image = _resize(image, resize_mode, size, round_to, interpolation)

        # Krita layers are RGBA and a sketch layer is mostly transparent. ComfyUI's
        # IMAGE is RGB, and simply dropping alpha would leave those pixels black —
        # so composite onto white, which is what a lineart/depth ControlNet wants.
        if image.mode in ("RGBA", "LA", "P"):
            from PIL import Image as PILImage

            image = image.convert("RGBA")
            canvas = PILImage.new("RGBA", image.size, (255, 255, 255, 255))
            image = PILImage.alpha_composite(canvas, image)
        image = image.convert("RGB")

        array = np.asarray(image, dtype=np.float32) / 255.0
        tensor = torch.from_numpy(array).unsqueeze(0)  # (1, H, W, 3)
        width, height = image.size
        print(f"[XYZ Krita] fetched image '{layer}' -> {width}x{height}")
        return (tensor, width, height)


class XYZKritaFetchMask(_KritaBase):
    NAME = "XYZ Krita Fetch Mask"
    DESCRIPTION = (
        "Pulls a Krita layer out as a MASK.\n"
        "A mask layer (transparency / local selection) is read straight; a paint "
        "layer or group contributes its ALPHA — 'wherever you painted something'.\n"
        "Connect `reference` to align the mask to an image's size (inpainting needs "
        "them to match exactly)."
    )
    RETURN_TYPES = ("MASK",)
    RETURN_NAMES = ("mask",)

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "layer": (
                    [LAYER_PLACEHOLDER],
                    {"tooltip": "Any layer: masks read directly, paint layers give alpha."},
                ),
                "max_wait": (
                    "FLOAT",
                    {"default": 60.0, "min": 1.0, "max": 600.0, "step": 1.0},
                ),
            },
            "optional": {
                "reference": (
                    "IMAGE",
                    {
                        "tooltip": "Optional. Scales the mask to this image's size — "
                        "connect the Fetch Image output when inpainting."
                    },
                ),
            },
        }

    def execute(self, layer=LAYER_PLACEHOLDER, max_wait=60.0, reference=None, **_):
        import torch

        key = layer_key(layer)
        if not key or layer == LAYER_PLACEHOLDER:
            raise RuntimeError(
                "No Krita layer chosen. Click 'Refresh layers' on the node, then "
                "pick one."
            )

        png = client.fetch_mask(key, timeout=max_wait)
        image = _decode(png).convert("L")

        if reference is not None:
            # Regional conditioning rescales a MASK for you; inpainting does not —
            # it errors out unless the mask matches the image exactly.
            ref_h, ref_w = int(reference.shape[1]), int(reference.shape[2])
            if image.size != (ref_w, ref_h):
                image = image.resize((ref_w, ref_h), _pil_filter("bilinear"))

        array = np.asarray(image, dtype=np.float32) / 255.0
        tensor = torch.from_numpy(array).unsqueeze(0)  # (1, H, W)
        print(f"[XYZ Krita] fetched mask '{layer}' -> {image.size[0]}x{image.size[1]}")
        return (tensor,)
