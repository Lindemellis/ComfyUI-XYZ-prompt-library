"""XYZ Cache Slot Write / XYZ Cache Slot Read.

A slot is a folder under `output/xyz_cache/` holding exactly one image. Writing to
a slot replaces what was there; reading gives it back. That is the whole model —
it is the folder-and-a-file workflow, node-ified (design §13).

The slot combo on the Read node CAN be built in INPUT_TYPES, unlike the Krita
layer combo: the slots are local directories, so listing them is instant and
cannot hang ComfyUI's startup.
"""

from __future__ import annotations

import io
import re
import shutil
from pathlib import Path

import numpy as np

#: Only what is safe as a folder name — a slot is user-typed.
SLOT_OK = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

NO_SLOTS = "(no slots yet — write one first)"

IMAGE_NAME = "image.png"


def cache_dir() -> Path:
    """`output/xyz_cache/`, wherever ComfyUI's output happens to be."""
    try:
        import folder_paths

        base = Path(folder_paths.get_output_directory())
    except Exception:  # noqa: BLE001 - outside ComfyUI (tests)
        base = Path(__file__).resolve().parent.parent / "output"
    return base / "xyz_cache"


def list_slots() -> list[str]:
    """Slots that actually hold an image — what Read can read."""
    return [s["name"] for s in describe_slots() if s["has_image"]]


def list_slot_names() -> list[str]:
    """Every slot, including ones just created and still empty — what Write can write."""
    return [s["name"] for s in describe_slots()]


def describe_slots() -> list[dict]:
    root = cache_dir()
    if not root.is_dir():
        return []

    out = []
    for entry in sorted(root.iterdir(), key=lambda p: p.name.lower()):
        if not entry.is_dir():
            continue
        image = entry / IMAGE_NAME
        record = {"name": entry.name, "has_image": image.is_file()}
        if record["has_image"]:
            stat = image.stat()
            record["mtime"] = int(stat.st_mtime)
            record["bytes"] = stat.st_size
            try:
                from PIL import Image

                with Image.open(image) as im:
                    record["width"], record["height"] = im.size
            except Exception:  # noqa: BLE001 - a corrupt slot must not kill the list
                record["width"] = record["height"] = 0
        out.append(record)
    return out


def create_slot(name: str) -> str:
    directory = slot_path(name)
    directory.mkdir(parents=True, exist_ok=True)
    return directory.name


def delete_slot(name: str) -> str:
    directory = slot_path(name)
    if directory.is_dir():
        shutil.rmtree(directory)
    return directory.name


def slot_path(slot: str) -> Path:
    slot = (slot or "").strip()
    if not SLOT_OK.match(slot):
        raise ValueError(
            f"'{slot}' is not a usable slot name — letters, digits, dot, dash and "
            "underscore only"
        )
    # Belt and braces: the regex already forbids separators, but a slot name is
    # user input that becomes a path.
    path = (cache_dir() / slot).resolve()
    if cache_dir().resolve() not in path.parents:
        raise ValueError(f"'{slot}' escapes the cache directory")
    return path


def write_slot(slot: str, image) -> Path:
    from PIL import Image

    if image.ndim == 4 and image.shape[0] > 1:
        # A slot holds one image. Say so, rather than quietly keeping the first
        # of four and letting the user believe all four were saved.
        print(
            f"[XYZ Cache] the image is a batch of {image.shape[0]} — only the first "
            f"one goes into slot '{slot}'"
        )
    array = image[0] if image.ndim == 4 else image
    array = (array.clamp(0.0, 1.0) * 255.0).round().to("cpu").numpy().astype(np.uint8)

    directory = slot_path(slot)
    # One image per slot: clear the folder rather than pile up.
    if directory.exists():
        shutil.rmtree(directory)
    directory.mkdir(parents=True)

    target = directory / IMAGE_NAME
    Image.fromarray(array, "RGBA" if array.shape[2] == 4 else "RGB").save(target)
    return target


def read_slot(slot: str):
    import torch
    from PIL import Image

    target = slot_path(slot) / IMAGE_NAME
    if not target.is_file():
        raise RuntimeError(
            f"cache slot '{slot}' is empty — run an 'XYZ Cache Slot Write' into it first"
        )

    image = Image.open(io.BytesIO(target.read_bytes())).convert("RGB")
    array = np.asarray(image, dtype=np.float32) / 255.0
    return torch.from_numpy(array).unsqueeze(0), image.size


def read_mask(image_ref: str, width: int, height: int):
    """The MASK output.

    `image_ref` is the value the core Mask Editor writes into our hidden `image`
    widget — a `clipspace/clipspace-painted-masked-<t>.png [input]` reference. The
    editor stores the mask in that file's alpha channel, exactly like a Load Image
    node, so the mask is `1 - alpha` (Load Image's own convention).

    No reference (nothing painted, or the frontend dropped a stale edit) → an all-
    zero mask the size of the slot image. A reference we cannot open (the clipspace
    file was cleaned up) → the same, with a warning, never a crash.
    """
    import torch
    from PIL import Image

    blank = torch.zeros((1, height, width), dtype=torch.float32)

    ref = (image_ref or "").strip()
    if not ref:
        return blank

    try:
        import folder_paths

        path = folder_paths.get_annotated_filepath(ref)
        with Image.open(path) as img:
            if "A" not in img.getbands():
                return blank
            alpha = np.asarray(img.getchannel("A"), dtype=np.float32) / 255.0
    except Exception as exc:  # noqa: BLE001 - a missing/bad clipspace file is not fatal
        print(f"[XYZ Cache] could not read the painted mask '{ref}': {exc}")
        return blank

    mask = 1.0 - alpha
    tensor = torch.from_numpy(mask).unsqueeze(0)

    # Option A: the IMAGE output is always the live slot, so the mask must line up
    # with it. The editor works at the image's resolution, so they normally already
    # match; resize only if some earlier edit was against a differently sized image.
    if tensor.shape[1] != height or tensor.shape[2] != width:
        tensor = torch.nn.functional.interpolate(
            tensor.unsqueeze(0), size=(height, width), mode="nearest"
        ).squeeze(0)
    return tensor


# ------------------------------------------------------------------ the nodes


class XYZCacheSlotWrite:
    NAME = "XYZ Cache Slot Write"
    CATEGORY = "XYZNodes/Cache"
    DESCRIPTION = (
        "Parks an image in a named slot under output/xyz_cache/, for a later run to "
        "pick up with 'XYZ Cache Slot Read'.\n"
        "A slot holds exactly one image — writing replaces it."
    )
    FUNCTION = "execute"
    RETURN_TYPES = ()
    OUTPUT_NODE = True

    @classmethod
    def INPUT_TYPES(cls):
        slots = list_slot_names()
        return {
            "required": {
                "image": ("IMAGE",),
                "slot": (
                    slots or [NO_SLOTS],
                    {"tooltip": "Pick a slot, or press 'Create slot' to make a new one."},
                ),
            },
        }

    @classmethod
    def VALIDATE_INPUTS(cls, slot=None, **_):
        # A slot created during THIS session is not in the list INPUT_TYPES built
        # at startup; don't let ComfyUI reject it.
        return True

    def execute(self, image=None, slot=NO_SLOTS, **_):
        if image is None:
            raise RuntimeError("nothing connected to `image`")
        if slot == NO_SLOTS:
            raise RuntimeError(
                "No cache slot chosen. Press 'Create slot' on the node to make one."
            )
        target = write_slot(slot, image)
        print(f"[XYZ Cache] wrote slot '{slot}' -> {target}")
        return {}


class XYZCacheSlotRead:
    NAME = "XYZ Cache Slot Read"
    CATEGORY = "XYZNodes/Cache"
    DESCRIPTION = (
        "Reads back the image parked in a cache slot.\n"
        "Right-click -> 'Open in MaskEditor | Image Canvas' to paint a mask on the "
        "slot image (ComfyUI's own editor). The image output stays the live slot; "
        "the mask output is whatever you painted."
    )
    FUNCTION = "execute"
    RETURN_TYPES = ("IMAGE", "MASK", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "width", "height")

    @classmethod
    def INPUT_TYPES(cls):
        slots = list_slots()
        return {
            "required": {
                "slot": (slots or [NO_SLOTS],),
            },
            # The Mask Editor round-trip writes the painted 'clipspace-…' reference
            # here; the frontend hides this widget and drives it per slot. It is a
            # plain string so an old workflow without it still loads.
            "optional": {
                "image": ("STRING", {"default": "", "multiline": False}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, slot=NO_SLOTS, image="", **_):
        # The slot file changes behind ComfyUI's back, so key on its mtime; the
        # painted mask changes the 'image' reference, so key on that too.
        try:
            mtime = str((slot_path(slot) / IMAGE_NAME).stat().st_mtime_ns)
        except (OSError, ValueError):
            mtime = "missing"
        return f"{mtime}:{image}"

    @classmethod
    def VALIDATE_INPUTS(cls, slot=None, **_):
        # A slot written during THIS session is not in the list INPUT_TYPES built
        # at startup; don't let ComfyUI reject it.
        return True

    def execute(self, slot=NO_SLOTS, image="", **_):
        if slot == NO_SLOTS:
            raise RuntimeError(
                "No cache slot chosen. Write one with 'XYZ Cache Slot Write' first."
            )
        tensor, (width, height) = read_slot(slot)
        mask = read_mask(image, width, height)
        print(f"[XYZ Cache] read slot '{slot}' -> {width}x{height}")
        return (tensor, mask, width, height)
