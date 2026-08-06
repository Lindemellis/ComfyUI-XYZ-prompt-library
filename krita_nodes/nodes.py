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
from . import send as _send

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


#: The most colour masks the node will emit — and the number of fallback slots it
#: declares. Must match the `count` widget's max and MAX_COLOR_MASKS in js/xyz_krita.js.
MAX_COLOR_MASKS = 16


def _mask_to_np(mask) -> np.ndarray:
    """A ComfyUI MASK tensor -> a 2-D float array in [0, 1].

    MASK is (B, H, W) or (H, W); we take the first item of a batch. This is the
    fallback path — the incoming masks stand in for what Krita's colour split would
    have produced, so they go straight through with no colour maths.

    `np.asarray` reads a torch tensor and a bare numpy array alike, which keeps the
    maths (and its tests) off torch — torch only crosses back at execute()'s return.
    """
    if hasattr(mask, "detach"):  # a torch tensor
        mask = mask.detach().cpu()
    arr = np.asarray(mask, dtype=np.float32)
    if arr.ndim == 3:
        arr = arr[0]
    return np.clip(arr, 0.0, 1.0)


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


#: The errors a fallback is allowed to cover: Krita is closed, has nothing open,
#: or no longer has the layer. NOT a bug in our code — that must still surface.
FALLBACK_ERRORS = (client.KritaUnreachable, client.KritaError)


def use_fallback(what: str, fallback, error: Exception):
    """Decide whether to fall back, and say so loudly if we do.

    A fallback is the perfect hiding place for a silent wrong answer: Krita is
    closed, you don't notice, and the whole batch renders against the stand-in.
    So it only ever engages when something IS connected to the fallback input —
    that connection is the user saying "yes, I mean it" — and it always shouts.
    """
    if fallback is None:
        raise error
    print(f"[XYZ Krita] !! {error}")
    print(f"[XYZ Krita] !! FALLING BACK to the connected {what} — this run is NOT using Krita")
    return fallback


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
            "optional": {
                "fallback": (
                    "IMAGE",
                    {
                        "tooltip": "Used INSTEAD of Krita when Krita is closed, has no "
                        "document, or no longer has the layer. Leave it unconnected and "
                        "those become errors, which is usually what you want."
                    },
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
        fallback=None,
        **_,
    ):
        import torch

        key = layer_key(layer)
        if not key or layer == LAYER_PLACEHOLDER:
            error = RuntimeError(
                "No Krita layer chosen. Click 'Refresh layers' on the node, then "
                "pick one."
            )
            if fallback is None:
                raise error
            return self._from_tensor(
                use_fallback("image", fallback, error),
                resize_mode,
                size,
                round_to,
                interpolation,
            )

        try:
            png = client.fetch_image(key, timeout=max_wait)
        except FALLBACK_ERRORS as exc:
            return self._from_tensor(
                use_fallback("image", fallback, exc),
                resize_mode,
                size,
                round_to,
                interpolation,
            )

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

    def _from_tensor(self, tensor, resize_mode, size, round_to, interpolation):
        """The fallback goes through the SAME resize, so downstream sizes agree
        whether the picture came from Krita or from the stand-in."""
        import torch
        from PIL import Image as PILImage

        array = tensor[0] if tensor.ndim == 4 else tensor
        array = (array.clamp(0, 1) * 255).round().to("cpu").numpy().astype(np.uint8)
        image = PILImage.fromarray(array[:, :, :3], "RGB")
        image = _resize(image, resize_mode, size, round_to, interpolation)

        out = np.asarray(image, dtype=np.float32) / 255.0
        width, height = image.size
        print(f"[XYZ Krita] fallback image -> {width}x{height}")
        return (torch.from_numpy(out).unsqueeze(0), width, height)


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
                "fallback": (
                    "MASK",
                    {
                        "tooltip": "Used INSTEAD of Krita when Krita is closed, has no "
                        "document, or no longer has the layer. Leave it unconnected and "
                        "those become errors, which is usually what you want."
                    },
                ),
            },
        }

    def execute(
        self,
        layer=LAYER_PLACEHOLDER,
        max_wait=60.0,
        reference=None,
        fallback=None,
        **_,
    ):
        import torch
        from PIL import Image as PILImage

        key = layer_key(layer)
        missing = (
            RuntimeError(
                "No Krita layer chosen. Click 'Refresh layers' on the node, then "
                "pick one."
            )
            if (not key or layer == LAYER_PLACEHOLDER)
            else None
        )

        try:
            if missing is not None:
                raise missing
            png = client.fetch_mask(key, timeout=max_wait)
            image = _decode(png).convert("L")
            source = f"'{layer}'"
        except (RuntimeError, *FALLBACK_ERRORS) as exc:
            mask = use_fallback("mask", fallback, exc)
            array = mask[0] if mask.ndim == 3 else mask
            array = (array.clamp(0, 1) * 255).round().to("cpu").numpy().astype(np.uint8)
            image = PILImage.fromarray(array, "L")
            source = "the FALLBACK (not Krita)"

        if reference is not None:
            # Regional conditioning rescales a MASK for you; inpainting does not —
            # it errors out unless the mask matches the image exactly.
            ref_h, ref_w = int(reference.shape[1]), int(reference.shape[2])
            if image.size != (ref_w, ref_h):
                image = image.resize((ref_w, ref_h), _pil_filter("bilinear"))

        array = np.asarray(image, dtype=np.float32) / 255.0
        tensor = torch.from_numpy(array).unsqueeze(0)  # (1, H, W)
        print(f"[XYZ Krita] mask from {source} -> {image.size[0]}x{image.size[1]}")
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
                # One fallback MASK per output slot: fallback_i stands in for output
                # mask_i when Krita is unavailable. js/xyz_krita.js shows exactly `count`
                # of them; the rest stay hidden. Declared here (not added purely in JS)
                # so ComfyUI validates the connections.
                **{
                    f"fallback_{i}": (
                        "MASK",
                        {
                            "tooltip": "Used INSTEAD of Krita for this slot when Krita is "
                            "closed, has no document, or no longer has the layer. "
                            f"Stands in for mask_{i}."
                        },
                    )
                    for i in range(MAX_COLOR_MASKS)
                },
            },
        }

    def execute(
        self,
        layer=LAYER_PLACEHOLDER,
        count=3,
        tolerance=0.15,
        max_wait=60.0,
        reference=None,
        **kwargs,
    ):
        import torch
        from PIL import Image as PILImage

        key = layer_key(layer)
        missing = (
            RuntimeError(
                "No Krita layer chosen. Click 'Refresh layers' on the node, then "
                "pick one."
            )
            if (not key or layer == LAYER_PLACEHOLDER)
            else None
        )

        try:
            if missing is not None:
                raise missing
            image = _decode(client.fetch_image(key, timeout=max_wait)).convert("RGBA")
            array = np.asarray(image, dtype=np.uint8)
            rgb, alpha = array[:, :, :3], array[:, :, 3]

            colors = pick_colors(rgb, alpha, count)
            masks = split_colors(rgb, alpha, colors, tolerance)
            height, width = alpha.shape

            print(f"[XYZ Krita] colour masks from '{layer}':")
            for i, (color, mask) in enumerate(zip(colors, masks)):
                share = float(mask.mean()) * 100.0
                print(f"    mask_{i}  #{color[0]:02x}{color[1]:02x}{color[2]:02x}  {share:.1f}% of the canvas")

            # Fewer colours on the layer than asked for: the spare slots come back
            # empty rather than erroring (design decision 18). A silent empty region is
            # the trade — it is in the README.
            if len(masks) < count:
                print(
                    f"[XYZ Krita] only {len(masks)} colour(s) found but count={count} — "
                    f"{count - len(masks)} mask(s) will be empty"
                )
                masks += [np.zeros((height, width), dtype=np.float32)] * (count - len(masks))
        except (RuntimeError, *FALLBACK_ERRORS) as exc:
            # The fallback is now a mask PER slot, not one image re-split: fallback_i
            # IS output mask_i. Nothing to colour-split — the masks stand in directly.
            masks, height, width = self._fallback_masks(count, kwargs, exc)

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

    @staticmethod
    def _fallback_masks(count, kwargs, error):
        """`count` masks from the fallback_* inputs when Krita is unavailable.

        A fallback is the perfect place to hide a wrong answer (Krita quietly closed,
        the whole batch renders against the stand-in), so — like use_fallback — it only
        engages when the user has ACTUALLY connected a stand-in. No fallback mask
        connected means the error surfaces instead of a silent set of empty masks.

        An unconnected slot among connected ones is an empty mask, at the same size as
        its neighbours: exactly the "spare slots come back empty" contract of the Krita
        path (design decision 18).
        """
        supplied = {i: kwargs.get(f"fallback_{i}") for i in range(count)}
        if not any(m is not None for m in supplied.values()):
            raise error

        print(f"[XYZ Krita] !! {error}")
        print("[XYZ Krita] !! FALLING BACK to the connected masks — this run is NOT using Krita")

        arrays = {i: _mask_to_np(m) for i, m in supplied.items() if m is not None}
        # The canvas size is whatever the connected masks agree on; the first one sets it.
        height, width = next(iter(arrays.values())).shape
        masks = [
            arrays.get(i, np.zeros((height, width), dtype=np.float32))
            for i in range(count)
        ]
        empty = count - len(arrays)
        if empty:
            print(f"[XYZ Krita] {empty} of {count} fallback slot(s) empty (nothing connected there)")
        return masks, height, width


def resolve_path(path: str) -> str:
    """An absolute path, or one relative to ComfyUI's input/ or output/ folder.

    Typing an absolute path every time is miserable, and the file you want to open
    in Krita is almost always something ComfyUI just made or something you dropped
    in input/.
    """
    from pathlib import Path

    path = (path or "").strip().strip('"')
    if not path:
        raise RuntimeError("no file path given")

    candidate = Path(path).expanduser()
    if candidate.is_absolute():
        return str(candidate)

    try:
        import folder_paths

        roots = [
            Path(folder_paths.get_output_directory()),
            Path(folder_paths.get_input_directory()),
        ]
    except Exception:  # noqa: BLE001 - outside ComfyUI
        roots = []

    for root in roots:
        resolved = root / candidate
        if resolved.is_file():
            return str(resolved)

    tried = " or ".join(str(r) for r in roots) or "the current directory"
    raise RuntimeError(f"could not find '{path}' — looked in {tried}")


class XYZKritaOpenFile(_KritaBase):
    NAME = "XYZ Krita Open File"
    DESCRIPTION = (
        "Opens a file on disk in Krita, as itself.\n"
        "Not the same as sending an IMAGE: a .kra opened this way keeps every "
        "layer, and Krita knows the path, so Ctrl+S saves back over the original. "
        "Sending pixels flattens the layers and gives you an unnamed document.\n"
        "The path may be absolute, or relative to ComfyUI's output/ or input/ folder."
    )
    FUNCTION = "execute"
    RETURN_TYPES = ()
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "path": (
                    "STRING",
                    {
                        "default": "",
                        "multiline": False,
                        "tooltip": "e.g. sketch.kra, or 2026-07-14/foo.png, or a full path.",
                    },
                ),
                "launch_krita": (
                    "BOOLEAN",
                    {"default": True, "tooltip": "Start Krita first if it is not running."},
                ),
                "max_wait": (
                    "FLOAT",
                    {"default": 120.0, "min": 1.0, "max": 900.0, "step": 1.0},
                ),
            },
        }

    def execute(self, path="", launch_krita=True, max_wait=120.0, **_):
        resolved = resolve_path(path)

        if launch_krita and not launcher.is_running():
            print("[XYZ Krita] Krita is not running — starting it")
            launcher.launch(timeout=max(60.0, max_wait))

        result = client.open_file(resolved, timeout=max_wait)
        size = result.get("size", [0, 0])
        print(
            f"[XYZ Krita] opened '{result.get('document')}' "
            f"({size[0]}x{size[1]}, {result.get('layers')} layer(s)) from {resolved}"
        )
        return {}


SEND_MODES = ["new_layer", "new_document"]
#: Mirrors krita_plugin/xyz_comfy/geometry.FIT_MODES. The PLUGIN decides the geometry;
#: this list only has to offer the same names. An unknown one falls back there, so a
#: node newer than the installed plugin degrades instead of failing.
FIT_MODES = ["keep", "fit", "grow_canvas"]


class XYZKritaSendToKrita(_KritaBase):
    NAME = "XYZ Krita Send To Krita"
    DESCRIPTION = (
        "Pushes an image into Krita.\n"
        "new_layer: on top of the document already open. Sizes rarely match, and "
        "`fit` is what to do about it — keep the image as it is, scale it to the "
        "canvas without deforming it, or grow the canvas to the image.\n"
        "new_document: opens a brand-new Krita document at the image's size. This is "
        "the front of the workflow, when Krita has nothing open yet.\n"
        "launch_krita on: Krita is started if it is not already running (a freshly "
        "started Krita has nothing open, so the image lands in a new document).\n"
        "launch_krita off: if Krita is not running the node quietly does nothing, "
        "so an unopened Krita never breaks the run."
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
                "fit": (
                    FIT_MODES,
                    {
                        "default": "fit",
                        "tooltip": "new_layer only — what to do when the image and "
                        "the canvas are different sizes.\n"
                        "keep: the image keeps its own pixel size, centred. The "
                        "canvas is not touched; a bigger image overhangs it.\n"
                        "fit: the image is scaled to the canvas WITH ITS ASPECT "
                        "RATIO KEPT, centred. What is left over stays transparent.\n"
                        "grow_canvas: an image bigger than the canvas grows the "
                        "canvas to it and scales the existing content up by one "
                        "factor (so nothing deforms); the image goes in 1:1. An "
                        "image that is not bigger behaves like keep.\n"
                        "The canvas only ever grows, in every mode.",
                    },
                ),
                "launch_krita": (
                    "BOOLEAN",
                    {
                        "default": True,
                        "tooltip": "On: start Krita if it is not running, and wait "
                        "for it (~20s to come up). Off: if Krita is not running, "
                        "skip this node quietly instead of failing the run.",
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
        fit="fit",
        launch_krita=True,
        max_wait=180.0,
        **_,
    ):
        if image is None:
            raise RuntimeError("nothing connected to `image`")

        if not launcher.is_running():
            if not launch_krita:
                # launch_krita is off and Krita is not open. This node is then
                # best-effort: do nothing rather than fail the whole run. Turn
                # launch_krita on (or open Krita yourself) to have the image sent.
                print(
                    "[XYZ Krita] Krita is not running and launch_krita is off — "
                    "skipping this node (nothing sent)."
                )
                return {}
            print("[XYZ Krita] Krita is not running — starting it")
            launcher.launch(timeout=max(60.0, max_wait))

        # The sequence — launch wait, and the new_layer -> new_document fallback for a
        # Krita with nothing open — lives in send.py, because the gallery's "send to
        # Krita" needs exactly the same one and two copies would drift.
        result = _send.send_png(
            _encode(image),
            mode=mode,
            layer_name=layer_name,
            fit=str(fit),
            launch=True,          # the "not running and launch off" case returned above
            max_wait=max_wait,
        )
        size = result.get("size", [0, 0])
        if result.get("mode") == "new_document":
            if result.get("requested_mode") == "new_layer":
                print(
                    "[XYZ Krita] new_layer: Krita has no open document — created a "
                    "new one instead"
                )
            print(
                f"[XYZ Krita] opened a new document '{result.get('document')}' "
                f"({size[0]}x{size[1]})"
            )
            return {}
        if result.get("document_scaled"):
            print(f"[XYZ Krita] the Krita document was scaled up to {size[0]}x{size[1]}")
        print(f"[XYZ Krita] added layer '{result.get('layer')}' ({size[0]}x{size[1]})")
        return {}
