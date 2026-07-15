# Mask Nodes

Two nodes that give [Prompt Library V3](../prompt_library_v3/README.md)'s regions something to
point at: you draw rectangles, and `imask: 0` in your prompt refers to the first one.

| Node | Category | Purpose |
|---|---|---|
| **XYZ Mask Editor** | `XYZNodes/Mask` | Draw rectangles on a canvas; emits one `MASK` per rectangle |
| **XYZ Attach Masks** | `XYZNodes/Mask` | Hangs those masks off a `CLIP` so `IMASK(i)` / `imask: i` can address them |

They are the rectangle half of the mask story. The Krita half — arbitrary-shape masks from a
colour-partitioned layer — is designed but not built yet.

---

## The one thing that will bite you

**`imask: i` counts the masks in the order they are attached — it is not a slot number.**

Wire the Mask Editor's `mask_0`, `mask_1`, … into Attach Masks **in order**, and leave `preview`,
`base` and `fill` **unconnected**. Connect one of them and everything shifts, silently: no error, no
warning, just a wrong picture.

```
XYZ Mask Editor            XYZ Attach Masks         PLv3
  ├─ preview ─┐ (leave unconnected — it is an IMAGE, not a mask)
  ├─ base    ─┤
  ├─ fill    ─┘
  ├─ mask_0  ─────────────→ mask 0    ───────────→  imask: 0
  ├─ mask_1  ─────────────→ mask 1    ───────────→  imask: 1
  └─ mask_2  ─────────────→ mask 2    ───────────→  imask: 2
```

Three things are there to keep you honest, and all three show the same number:

- the index drawn on each rectangle in the canvas,
- the output slot names (`mask_0`, `mask_1`, …) and the Attach Masks input labels (`mask 0`, …),
- the mapping table Attach Masks prints to the console on every run:
  ```
  [XYZ Attach Masks] IMASK index -> input:
      IMASK(0)  <-  mask_1  (1, 512, 512)
      IMASK(1)  <-  mask_2  (1, 512, 512)
  ```

---

## XYZ Mask Editor

Drag on empty canvas to draw a rectangle. Click one to select it, drag it to move, drag a handle
to resize, press <kbd>Delete</kbd> to remove it. Drag the node's corner to make the canvas bigger.

### Outputs

| Slot | Name | Type | What it is |
|---|---|---|---|
| 0 | `preview` | `IMAGE` | A picture of the layout: white paper, one colour per rectangle |
| 1 | `base` | `MASK` | A full-white mask covering the whole canvas |
| 2 | `fill` | `MASK` | Everything **not** covered by any rectangle |
| 3… | `mask_0`, `mask_1`, … | `MASK` | One per rectangle, in list order |

**`preview`** is what the canvas looks like, as an image you can wire into a `PreviewImage` or
stack next to your generation to check the composition. The colours are the canvas's own, so it
reads the same. **A lower index is painted on top** — where two rectangles overlap, the one earlier
in the list wins, which is also the one drawn on top in the editor. A feathered edge fades to the
paper exactly as its mask does.

`base` and `fill` exist for **other** nodes — regional-conditioning packs, inpainting, and so on.
PLv3 does not need them: its base region is implicitly the whole image, and it computes the fill
itself. They occupy slots 0 and 1 whether you use them or not.

Rectangles are stored as fractions of the canvas, so the masks are resolution-independent —
ComfyUI rescales them to whatever you are actually generating at.

### Feather

`feather` softens a rectangle's edge **inwards**, measured in pixels of the 512×512 mask: the
mask is 0 at the rectangle's border and ramps up to 1 over `feather` pixels. A rectangle therefore
never covers more than you drew, and two rectangles drawn edge-to-edge never overlap.

`fill` is the exact complement of what is emitted, feathering included — the masks and `fill`
always sum to 1 at every pixel, so nothing is double-weighted and nothing is left out.

> **Feather in one place only.** PLv3 regions have a `feather:` field of their own, and it
> compiles to prompt-control's `FEATHER()`, which is applied *on top of* the mask tensor you
> hand it. Setting both feathers a rectangle **twice**. Pick one: feather here, where you can
> see the rectangle, and leave `feather:` off your `imask:` regions.

### Slots move when you delete a rectangle

Delete the middle of three and the third one's slot moves up. ComfyUI addresses links by slot
index, so the node re-runs the links for you: each connection follows **its own rectangle**, not
the slot number it used to sit in. The remaining rectangles renumber (`mask_0`, `mask_1`), and the
`imask:` indices in your prompt shift with them — so check your prompt after deleting one.

---

## XYZ Attach Masks

`clip` in, `clip` out, with up to **16** masks attached. The inputs grow as you fill them, and
there is always one spare.

Unplug a mask in the middle and the ones below slide up to close the gap, because a hole would
silently renumber every `IMASK` after it.

This is the only node in the pack that reaches into `comfyui-prompt-control`'s internals (its
`model_options["x-promptcontrol.masks"]` list). If prompt-control ever changes that key, this one
node is all that needs fixing — PLv3 itself only ever emits a string.

---

## A worked example

Three characters, left to right:

1. **XYZ Mask Editor** — draw three rectangles across the canvas.
2. **XYZ Attach Masks** — `clip` from your checkpoint; `mask_0` → `mask 0`, `mask_1` → `mask 1`,
   `mask_2` → `mask 2`.
3. **XYZ Prompt Library V3** — write the regions against those indices:
   ```
   masterpiece, best quality

   [@region]: {
       base: { 3girls, standing, side-by-side }

       [imask: 0]: { 1girl, red hair, red dress }
       [imask: 1]: { 1girl, blue hair, blue dress }
       [imask: 2]: { 1girl, green hair, green dress }

       fill: { detailed background, bokeh }
   }
   ```
   `masterpiece, best quality` sits outside the region group, so it is copied into every
   segment — see [ambient text](../prompt_library_v3/README.md#regions).
4. Feed the V3 node's output and the Attach Masks node's `clip` into **PC: Schedule Prompt**.

Check the console line to confirm the indices landed where you think they did.
