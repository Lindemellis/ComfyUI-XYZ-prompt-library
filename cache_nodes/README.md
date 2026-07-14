# Cache Slots

Park an image in a named slot; pick it up on a later run.

| Node | Category | Purpose |
|---|---|---|
| **XYZ Cache Slot Write** | `XYZNodes/Cache` | An `IMAGE` → a slot |
| **XYZ Cache Slot Read** | `XYZNodes/Cache` | A slot → `IMAGE` + its `width`/`height` |

**Nothing to do with Krita.** This is the plain-ComfyUI way of handing an intermediate result to a
later run — a base image, an upscale — instead of re-running the whole chain every time you want to
poke at the next step. The Krita bridge is the other hand-off route; both exist, and they are for
different things.

## How it works

A slot is a folder under **`output/xyz_cache/<slot>/`** holding exactly one image. Writing to a
slot replaces whatever was there. That is the whole model: it is the folder-and-a-file habit you
already have, node-ified.

Slot names take letters, digits, `.`, `-` and `_` — nothing that could climb out of the cache
directory.

## Using it

```
… → XYZ Cache Slot Write   (slot: "base")
```
Run it. Then, in a *later* run — a different graph, a different day:
```
XYZ Cache Slot Read  (slot: "base") → upscale → …
```

The Read node's dropdown lists the slots that exist. A slot you write during the *current* ComfyUI
session will not be in that list until you reload the page — but you can still type it, and it will
work: the node does not reject a name it has not heard of.

Reading re-checks the file on every run, so editing a slot's image outside ComfyUI takes effect
immediately rather than being served from the execution cache.
