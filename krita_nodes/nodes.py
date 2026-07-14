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

import io
import time

import numpy as np

from . import client, launcher

try:
    from ..node import ByPassTypeTuple
except ImportError:  # imported as a top-level package (the tests put the repo root on sys.path)
    from node import ByPassTypeTuple

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


def _encode(tensor, what: str = "image") -> bytes:
    """A ComfyUI IMAGE (B, H, W, 3|4) -> PNG bytes for the FIRST image."""
    from PIL import Image

    array = tensor
    if array.ndim == 4:
        if array.shape[0] > 1:
            # Dropping the rest silently would be the worst kind of bug: the run
            # succeeds and only one of your four pictures made it.
            print(
                f"[XYZ Krita] the {what} is a batch of {array.shape[0]} — only the "
                "first one is used"
            )
        array = array[0]
    array = (array.clamp(0.0, 1.0) * 255.0).round().to("cpu").numpy().astype(np.uint8)
    mode = "RGBA" if array.shape[2] == 4 else "RGB"
    buffer = io.BytesIO()
    Image.fromarray(array, mode).save(buffer, format="PNG")
    return buffer.getvalue()


#: Colour distance is euclidean in RGB; this is the largest it can be.
MAX_RGB_DISTANCE = float(np.sqrt(3.0) * 255.0)


def pick_colors(rgb: np.ndarray, alpha: np.ndarray, count: int) -> list[tuple[int, int, int]]:
    """The `count` largest colour regions in a flat-colour layer, hex-ascending.

    Only solid pixels are counted. An anti-aliased edge is a smear of unique
    colours, and letting those into the tally would crowd out real regions.
    Ties go to the lower hex value, so the result does not wobble between runs.
    """
    solid = alpha >= 128
    if not solid.any():
        return []

    flat = rgb[solid].astype(np.uint32)
    packed = (flat[:, 0] << 16) | (flat[:, 1] << 8) | flat[:, 2]

    values, counts = np.unique(packed, return_counts=True)
    # -counts first => biggest area wins; values second => a tie is broken by hex.
    order = np.lexsort((values, -counts))
    chosen = np.sort(values[order[:count]])  # slot order is hex ascending (§19)

    return [(int(v >> 16), int((v >> 8) & 0xFF), int(v & 0xFF)) for v in chosen]


def split_colors(
    rgb: np.ndarray, alpha: np.ndarray, colors: list, tolerance: float
) -> list[np.ndarray]:
    """One binary mask per colour: every pixel goes to its NEAREST colour.

    Within `tolerance` a pixel joins the closest region, beyond it joins none —
    so the masks neither overlap nor leave a seam along an anti-aliased edge
    (design decision 20).
    """
    height, width = alpha.shape
    if not colors:
        return []

    limit = tolerance * MAX_RGB_DISTANCE
    pixels = rgb.reshape(-1, 3).astype(np.float32)

    # A distance matrix would be H*W*N floats; keep a running minimum instead.
    best = np.full(pixels.shape[0], np.inf, dtype=np.float32)
    owner = np.zeros(pixels.shape[0], dtype=np.int32)
    for i, color in enumerate(colors):
        delta = pixels - np.asarray(color, dtype=np.float32)
        distance = np.sqrt((delta * delta).sum(axis=1))
        closer = distance < best
        best[closer] = distance[closer]
        owner[closer] = i

    visible = (alpha.reshape(-1) > 0) & (best <= limit)
    return [
        ((owner == i) & visible).reshape(height, width).astype(np.float32)
        for i in range(len(colors))
    ]


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


class XYZKritaFetchColorMasks(_KritaBase):
    NAME = "XYZ Krita Fetch Color Masks"
    DESCRIPTION = (
        "One flat-colour layer -> N masks. Paint the left character red, the right "
        "one blue, the background green, and this splits them apart.\n"
        "This is what the Mask Editor cannot do: arbitrary shapes that hug a "
        "character's outline.\n"
        "The N largest colour regions are taken, ordered by hex value ascending."
    )
    FUNCTION = "execute"
    RETURN_TYPES = ByPassTypeTuple(("MASK",))
    RETURN_NAMES = ByPassTypeTuple(("mask_0",))

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "layer": (
                    [LAYER_PLACEHOLDER],
                    {"tooltip": "A layer painted in flat colours, one per region."},
                ),
                "count": (
                    "INT",
                    {
                        "default": 3,
                        "min": 1,
                        "max": 16,
                        "tooltip": "How many masks to emit. The output slots follow "
                        "this number.",
                    },
                ),
                "tolerance": (
                    "FLOAT",
                    {
                        "default": 0.15,
                        "min": 0.0,
                        "max": 1.0,
                        "step": 0.01,
                        "tooltip": "How far a pixel may be from a region's colour and "
                        "still join it. Covers anti-aliased edges.",
                    },
                ),
                "max_wait": (
                    "FLOAT",
                    {"default": 60.0, "min": 1.0, "max": 600.0, "step": 1.0},
                ),
            },
            "optional": {
                "reference": (
                    "IMAGE",
                    {"tooltip": "Optional. Scales the masks to this image's size."},
                ),
            },
        }

    def execute(
        self,
        layer=LAYER_PLACEHOLDER,
        count=3,
        tolerance=0.15,
        max_wait=60.0,
        reference=None,
        **_,
    ):
        import torch
        from PIL import Image as PILImage

        key = layer_key(layer)
        if not key or layer == LAYER_PLACEHOLDER:
            raise RuntimeError(
                "No Krita layer chosen. Click 'Refresh layers' on the node, then "
                "pick one."
            )

        image = _decode(client.fetch_image(key, timeout=max_wait)).convert("RGBA")
        array = np.asarray(image, dtype=np.uint8)
        rgb, alpha = array[:, :, :3], array[:, :, 3]

        colors = pick_colors(rgb, alpha, count)
        masks = split_colors(rgb, alpha, colors, tolerance)

        print(f"[XYZ Krita] colour masks from '{layer}':")
        for i, (color, mask) in enumerate(zip(colors, masks)):
            share = float(mask.mean()) * 100.0
            print(f"    mask_{i}  #{color[0]:02x}{color[1]:02x}{color[2]:02x}  {share:.1f}% of the canvas")

        # Fewer colours on the layer than asked for: the spare slots come back
        # empty rather than erroring (design decision 18). A silent empty region is
        # the trade — it is in the README.
        height, width = alpha.shape
        if len(masks) < count:
            print(
                f"[XYZ Krita] only {len(masks)} colour(s) found but count={count} — "
                f"{count - len(masks)} mask(s) will be empty"
            )
            masks += [np.zeros((height, width), dtype=np.float32)] * (count - len(masks))

        if reference is not None:
            ref_h, ref_w = int(reference.shape[1]), int(reference.shape[2])
            if (width, height) != (ref_w, ref_h):
                masks = [
                    np.asarray(
                        PILImage.fromarray((m * 255).astype(np.uint8), "L").resize(
                            (ref_w, ref_h), _pil_filter("bilinear")
                        ),
                        dtype=np.float32,
                    )
                    / 255.0
                    for m in masks
                ]

        return tuple(torch.from_numpy(m).unsqueeze(0) for m in masks)


SEND_MODES = ["new_layer", "new_document"]


class XYZKritaSendToKrita(_KritaBase):
    NAME = "XYZ Krita Send To Krita"
    DESCRIPTION = (
        "Pushes an image into Krita.\n"
        "new_layer: on top of the document already open. Sizes rarely match — an "
        "image smaller than the canvas is scaled up to it; a bigger one either grows "
        "the whole document (scale_document) or is scaled down.\n"
        "new_document: opens a brand-new Krita document at the image's size. This is "
        "the front of the workflow, when Krita has nothing open yet.\n"
        "With launch_krita on, Krita is started if it is not already running."
    )
    RETURN_TYPES = ()
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "image": ("IMAGE",),
                "mode": (
                    SEND_MODES,
                    {
                        "default": "new_layer",
                        "tooltip": "new_layer needs a document open in Krita; "
                        "new_document creates one.",
                    },
                ),
                "layer_name": ("STRING", {"default": "ComfyUI"}),
                "scale_document": (
                    "BOOLEAN",
                    {
                        "default": False,
                        "tooltip": "new_layer only. If the image is bigger than the "
                        "canvas, scale the whole Krita document (every layer) up to "
                        "it. The canvas only ever grows.",
                    },
                ),
                "launch_krita": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "tooltip": "Start Krita if it is not running, and wait for it. "
                        "Krita takes ~20s to come up.",
                    },
                ),
                "max_wait": (
                    "FLOAT",
                    {"default": 180.0, "min": 1.0, "max": 900.0, "step": 1.0},
                ),
            },
        }

    def execute(
        self,
        image=None,
        mode="new_layer",
        layer_name="ComfyUI",
        scale_document=False,
        launch_krita=True,
        max_wait=180.0,
        **_,
    ):
        if image is None:
            raise RuntimeError("nothing connected to `image`")

        if launch_krita and not launcher.is_running():
            print("[XYZ Krita] Krita is not running — starting it")
            launcher.launch(timeout=max(60.0, max_wait))

        png = _encode(image)

        if mode == "new_document":
            result = client.new_document(png, name=layer_name, timeout=max_wait)
            size = result.get("size", [0, 0])
            print(
                f"[XYZ Krita] opened a new document '{result.get('document')}' "
                f"({size[0]}x{size[1]})"
            )
            return {}

        result = client.add_layer(
            png,
            name=layer_name,
            scale_document=bool(scale_document),
            timeout=max_wait,
        )
        size = result.get("size", [0, 0])
        if result.get("document_scaled"):
            print(f"[XYZ Krita] the Krita document was scaled up to {size[0]}x{size[1]}")
        print(f"[XYZ Krita] added layer '{result.get('layer')}' ({size[0]}x{size[1]})")
        return {}
