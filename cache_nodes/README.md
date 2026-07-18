# Cache Slots

Park an image in a named slot; pick it up on a later run.

| Node | Category | Purpose |
|---|---|---|
| **XYZ Cache Slot Write** | `XYZNodes/Cache` | An `IMAGE` → a slot |
| **XYZ Cache Slot Read** | `XYZNodes/Cache` | A slot → `image` + `mask` + `width`/`height` |

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

**Write** — pick a slot from the dropdown, or press **Create slot** to make a new one and name it.

```
… → XYZ Cache Slot Write   (slot: "base")
```
Run it. Then, in a *later* run — a different graph, a different day:
```
XYZ Cache Slot Read  (slot: "base") → upscale → …
```

**Read** shows a **live preview** of the slot it is pointing at, and **Browse slots** opens a window
with every slot that holds an image. Click one and the node switches to it.

**Drag the node to any shape to resize the preview** — the box is not locked to the picture's aspect
ratio. The image scales to touch the box on its tighter axis, so it always fills either the full
width or the full height; any leftover shows on one axis only, never on all four sides.

Both dropdowns are **live**, and so is the preview. They re-read the folder rather than trusting the
list ComfyUI built at startup, so a slot you create — or write to — during this session shows up
straight away, with no page reload. When a Write finishes, the Read node next to it refreshes on its
own.

The folder is polled every couple of seconds, so **a slot's image changing outside ComfyUI is picked
up too** — edit it in Krita, save over it, and the preview follows. The image only reloads when its
mtime actually moved, so it does not flicker. Polling stops while the tab is in the background and
catches up the moment you come back.

Read only offers slots that hold an image; Write also offers the empty ones you have just created.

Reading re-checks the file on every run, so editing a slot's image outside ComfyUI takes effect
immediately rather than being served from the execution cache.

## Painting a mask on the slot (Open in MaskEditor | Image Canvas)

Right-click the **Read** node → **Open in MaskEditor | Image Canvas** to paint on the slot image
with ComfyUI's own editor — the same one a Load Image node gives you. What you paint comes out of the
node's **`mask`** output; the **`image`** output stays the live slot (painting on the Image Canvas is
kept as editor state so you can keep refining, but it does not change the image output).

The edit is **remembered per slot**. Switch to another slot and the first slot's mask is parked;
switch back and it is still there. The mask is bound to the picture it was painted on: if that slot's
image is later **overwritten with a different one** (its mtime moves), the mask is dropped — it
belonged to the old picture. This lives in the workflow, so it survives save/reload.

Under the hood this is ComfyUI's stock editor, unchanged: it stores the layers as `clipspace-*.png`
files in `input/clipspace/` and the node reads the mask from the painted file's alpha channel, exactly
like Load Image. Nothing here re-implements the editor.
