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
    root = cache_dir()
    if not root.is_dir():
        return []
    return sorted(
        entry.name
        for entry in root.iterdir()
        if entry.is_dir() and (entry / IMAGE_NAME).is_file()
    )


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
        return {
            "required": {
                "image": ("IMAGE",),
                "slot": ("STRING", {"default": "base"}),
            },
        }

    def execute(self, image=None, slot="base", **_):
        if image is None:
            raise RuntimeError("nothing connected to `image`")
        target = write_slot(slot, image)
        print(f"[XYZ Cache] wrote slot '{slot}' -> {target}")
        return {}


class XYZCacheSlotRead:
    NAME = "XYZ Cache Slot Read"
    CATEGORY = "XYZNodes/Cache"
    DESCRIPTION = "Reads back the image parked in a cache slot."
    FUNCTION = "execute"
    RETURN_TYPES = ("IMAGE", "INT", "INT")
    RETURN_NAMES = ("image", "width", "height")

    @classmethod
    def INPUT_TYPES(cls):
        slots = list_slots()
        return {
            "required": {
                "slot": (slots or [NO_SLOTS],),
            },
        }

    @classmethod
    def IS_CHANGED(cls, slot=NO_SLOTS, **_):
        # The file changes behind ComfyUI's back, so key the cache on its mtime.
        try:
            return str((slot_path(slot) / IMAGE_NAME).stat().st_mtime_ns)
        except (OSError, ValueError):
            return "missing"

    @classmethod
    def VALIDATE_INPUTS(cls, slot=None, **_):
        # A slot written during THIS session is not in the list INPUT_TYPES built
        # at startup; don't let ComfyUI reject it.
        return True

    def execute(self, slot=NO_SLOTS, **_):
        if slot == NO_SLOTS:
            raise RuntimeError(
                "No cache slot chosen. Write one with 'XYZ Cache Slot Write' first."
            )
        tensor, (width, height) = read_slot(slot)
        print(f"[XYZ Cache] read slot '{slot}' -> {width}x{height}")
        return (tensor, width, height)
