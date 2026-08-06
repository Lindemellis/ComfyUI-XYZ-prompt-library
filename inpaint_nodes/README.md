# XYZ Inpaint Stitch To RGBA

The inpainted region **on its own**, on a transparent image the size of the original, sitting
exactly where it belongs.

Same two inputs as **Inpaint Stitch Improved** (ComfyUI-Inpaint-CropAndStitch) — but instead of one
flat picture you get a **layer**.

```
Inpaint Crop Improved ──stitcher──┐
                                  ├──▶ XYZ Inpaint Stitch To RGBA ──▶ image (RGBA), mask
        …sampler… ──inpainted─────┘
```

| | |
|---|---|
| **Inpaint Stitch** | `mask * inpainted + (1 - mask) * original` — the whole picture, inpaint baked in |
| **this node** | `rgb = inpainted`, `alpha = mask` — the inpaint alone, everything else transparent |

Composite this over the original and you get Stitch's output back **pixel for pixel**. That
identity is the point, and it is what `test/t64_inpaint_rgba_test.py` checks.

## What it is for

Sending an inpaint into Krita as a layer:

```
XYZ Inpaint Stitch To RGBA ──▶ XYZ Krita Send To Krita   (mode: new_layer, fit: keep)
```

`fit: keep` because the image is already the size of the canvas it came from — anything else would
scale it and lose the registration. The inpaint arrives on top of your untouched artwork, still
maskable, still erasable, still movable. Nothing is flattened, and you can run four seeds and keep
all four as four layers.

## Details worth knowing

- **The alpha is the *blend* mask**, not the raw one — it already carries the feather from Crop's
  `mask_blend_pixels`. That is why the composite matches Stitch exactly and why the edge does not
  show a seam.
- **The RGB is kept where alpha is 0.** Blanking it would look tidier in a pixel inspector and would
  put a dark halo around every composite, because along the feathered edge alpha is partial and
  `a*rgb + (1-a)*dst` needs the real colour there. Straight (non-premultiplied) alpha.
- **"The size of the original" means Crop's `canvas_to_orig` rectangle.** If you turned on
  `preresize`, that is the *pre-resized* size, not the file you opened. If you turned on
  `extend_for_outpainting`, the canvas is bigger still and this crop is what brings it back.
- **An inpainted image at a different resolution is rescaled to the region** using the stitcher's
  own `upscale_algorithm` / `downscale_algorithm`, chosen by the same test Stitch uses — so
  inpainting at 2× and sending back works.
- **A one-image stitcher can drive a whole batch**, exactly as Stitch allows: four seeds through one
  crop give four layers.
- The second output is that alpha as a `MASK`, for anything downstream that wants to *select* the
  region rather than draw it.

## No dependency

This node never imports ComfyUI-Inpaint-CropAndStitch. `STITCHER` is only a socket name and the
stitcher itself is a plain dict, so the node loads with or without that pack — without it, there is
simply nothing to plug in. If a future version of it renames a field, you get a sentence naming the
missing keys instead of a `KeyError` traceback.
