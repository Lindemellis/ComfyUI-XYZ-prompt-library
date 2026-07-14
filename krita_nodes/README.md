# Krita Bridge

Pull layers and masks out of a running Krita, straight into your graph.

This is the *inverse* of krita-ai-diffusion. There, Krita is the workspace and ComfyUI is a
backend. Here **ComfyUI is the workspace** and Krita is the sketchpad you reach for when you need
to draw a rough composition, paint a region by hand, or mask something precisely.

| Node | Category | Purpose |
|---|---|---|
| **XYZ Krita Fetch Image** | `XYZNodes/Krita` | A layer (or the whole document) → `IMAGE` + its `width`/`height` |
| **XYZ Krita Fetch Mask** | `XYZNodes/Krita` | A layer → `MASK` |
| **XYZ Krita Fetch Color Masks** | `XYZNodes/Krita` | One flat-colour layer → N masks of **any shape** |
| **XYZ Krita Send To Krita** | `XYZNodes/Krita` | An `IMAGE` → a new Krita layer, or a new document |
| **XYZ Krita Open File** | `XYZNodes/Krita` | A file on disk → open it in Krita, as itself |

For handing an image from one graph run to the next *without* Krita, see
[Cache Slots](../cache_nodes/README.md).

---

## Setup

1. **Install the Krita plugin.** With Krita **closed**, POST to `/xyz/krita/plugin/install`, or
   from the repo root:
   ```bash
   python -c "from krita_nodes import installer; print(installer.install())"
   ```
2. **Start Krita.** The plugin serves on `127.0.0.1:8765`.
3. In ComfyUI, add a Krita node and press **Refresh layers**.

> **Close Krita before installing.** Krita rewrites its config file when it quits, from whatever
> it read at startup — so enabling the plugin while Krita is open gets silently undone the moment
> you close it. The plugin then looks installed and never loads. The installer detects this and
> tells you; it is the single most confusing failure mode here.

To check the wiring without leaving ComfyUI:

| Route | Answers |
|---|---|
| `GET /xyz/krita/plugin` | Is the plugin installed and enabled? |
| `GET /xyz/krita/ping` | Is Krita running, and what document is open? |
| `GET /xyz/krita/layers` | The layer tree |

---

## How it works

The plugin runs a small HTTP server **inside Krita**, bound to localhost. When your graph runs,
the node asks Krita for the layer and blocks until it answers (*pull*, not push). Krita not
running is an error on purpose — quietly substituting a blank image would waste the run.

Krita's API is **main-thread only**, so the HTTP handler never touches a document directly: it
hands the work to Krita's main thread through a queued Qt signal and waits (`bridge.py`). Getting
this wrong crashes Krita, sometimes not immediately.

---

## XYZ Krita Fetch Image

Pick a layer — or `document`, which is everything flattened.

| Input | What it does |
|---|---|
| `layer` | Filled in by **Refresh layers**. Only picture layers are listed. |
| `resize_mode` | `none`, `by_width`, `by_height`. Both resizing modes **keep the aspect ratio**. |
| `size` | The target width or height. |
| `round_to` | Snap the result to a multiple of this. **Default 8** — an unaligned size gets silently cropped by the sampler. |
| `interpolation` | `lanczos` by default. |
| `max_wait` | How long to wait for Krita. |

It outputs the image plus its **final** `width`/`height`, so you can wire those straight into an
empty latent and know the sizes agree.

Only this node resizes. That is deliberate: once you scale the Krita document up, you still want
to *generate* at a sane resolution, and `by_height: 1216` gets you there without a chain of scale
nodes.

**Transparency becomes white.** A Krita sketch layer is mostly transparent, and ComfyUI's `IMAGE`
has no alpha. Dropping alpha would leave those pixels *black*; compositing onto white is what a
lineart or depth ControlNet actually wants.

## XYZ Krita Fetch Mask

| Selected layer | What you get |
|---|---|
| `transparencymask`, `selectionmask` (a saved *Local Selection*), other mask types | The mask, read straight — it is already single-channel selectedness |
| `paintlayer`, `grouplayer` | Its **alpha**: "wherever you painted something" |

No parameter picks between them — the layer's own type does.

**`reference` (optional `IMAGE`).** The mask comes back at Krita's canvas size, but your image may
have been resized by Fetch Image. Regional conditioning rescales a mask for you; **inpainting does
not — it errors out unless they match exactly.** Connect the Fetch Image output here and the mask
is aligned for you, with nothing to fill in.

## XYZ Krita Fetch Color Masks

**Paint the left character red, the right one blue, the background green — this splits them into
three masks.** It is what `XYZ Mask Editor` cannot do: masks of *any shape*, hugging a character's
outline, several at once.

| Input | What it does |
|---|---|
| `layer` | A paint layer or group. Only those are listed. |
| `count` | How many masks. **The output slots follow this number.** |
| `tolerance` | How far a pixel may sit from a region's colour and still join it. |
| `reference` | Optional, as above. |

The `count` largest colour regions are taken and ordered by **hex value ascending** — that, not
area, is what fixes which colour lands in which slot, so the order does not shuffle when you
repaint.

Every pixel joins its **nearest** colour within `tolerance`, and none beyond it. So the masks
never overlap and never leave a seam along an anti-aliased edge.

> **It will not tell you when a region goes missing.** More colours on the layer than `count`:
> the smallest are ignored. Fewer: the spare slots come back **empty**. Neither is an error — so
> if you add a fourth colour in Krita and forget to raise `count`, that region silently vanishes
> from your prompt. Watch the console; the node prints each mask's colour and its share of the
> canvas.

## Starting Krita from ComfyUI

Every Krita node has a **Launch Krita** button. It finds `krita.exe` for you, starts it, and
waits until the bridge answers — Krita takes ~20s to come up, and a node that fired the instant
the process existed would just time out. If Krita is already running it says so and does not open
a second one.

If it cannot find Krita, set the path once:

```bash
curl -X POST localhost:8188/xyz/krita/executable -d '{"path": "C:/Program Files/Krita (x64)/bin/krita.exe"}'
```
or point `XYZ_KRITA_EXE` at it. The saved path lives in `krita_data/settings.json`.

## XYZ Krita Send To Krita

Pushes an `IMAGE` into Krita. Two modes:

| `mode` | What it does |
|---|---|
| `new_layer` | On top of the document already open. **Needs a document.** |
| `new_document` | Opens a brand-new Krita document at the image's size. This is the front of the workflow, when Krita has nothing open yet. |

`launch_krita` (on by default) starts Krita first if it is not running, so a cold ComfyUI + a
closed Krita + one run is all it takes to get a canvas open.

## The fallback input

`Fetch Image`, `Fetch Mask` and `Fetch Color Masks` each take an optional **`fallback`**. If Krita
is closed, has nothing open, or no longer has the layer, the node uses the fallback instead of
stopping the run. Fetch Color Masks takes an `IMAGE` and splits it by colour exactly as it would a
Krita layer, so its slots keep meaning the same thing.

**Leave it unconnected unless you mean it.** A fallback is the perfect hiding place for a silent
wrong answer — Krita is closed, you don't notice, and the whole batch renders against the stand-in.
So it only ever engages when something *is* connected, and when it does it shouts on the console:

```
[XYZ Krita] !! could not reach the Krita plugin at http://127.0.0.1:8765 ...
[XYZ Krita] !! FALLING BACK to the connected image — this run is NOT using Krita
```

With nothing connected, those situations stay errors, which is usually what you want.

Only Krita's own failures fall back. A bug in the node still surfaces.

## XYZ Krita Open File

Opens a file **as itself**, rather than pushing pixels at Krita.

The difference matters. Send To Krita hands over an `IMAGE` — a flat grid of pixels — so a `.kra`
sent that way arrives with its layers already merged and no name. Open File gives Krita the
*path*: a `.kra` keeps **every layer**, and Krita knows where the file came from, so **Ctrl+S saves
back over the original**.

The path may be absolute, or relative to ComfyUI's `output/` or `input/` folder — the file you want
is nearly always something ComfyUI just made, or something you dropped in `input/`.

Use Send To Krita when the picture only exists in the graph. Use Open File when it exists on disk
and you care about its layers or its path.

### new_layer: the sizes rarely agree

So:

| The image is… | What happens |
|---|---|
| smaller than the canvas | Scaled **up** to the canvas. Krita is the canvas of record; it does not shrink. |
| bigger, `scale_document` **off** | Scaled **down** to the canvas. |
| bigger, `scale_document` **on** | The whole **document** grows to the image — every layer with it — and the image drops in 1:1. |

`scale_document` is how you upscale: generate at 2×, push it back with the switch on, and carry on
painting and inpainting at the new size. Your sketch layers go soft in the process, which is fine —
by the time you are upscaling, the sketch has done its job. **The canvas only ever grows.** To get
back to a generation resolution, use Fetch Image's `by_height`.

---

## Limits

- **8-bit documents only.** A 16-bit or float document raises a clear error telling you to convert
  it (*Image ▸ Convert Image Color Space ▸ 8-bit*). Krita's Python API hands out raw bytes and only
  the U8 layout is unambiguous.
- **One document at a time** — whichever is active in Krita.
- The port is fixed at **8765**; override with the `XYZ_COMFY_PORT` environment variable, which
  both sides read.
- The plugin is namespaced away from ComfyUI-Danbooru-Gallery's `open_in_krita` (different id,
  port and log), so both can live in the same Krita.

## When it will not connect

1. `GET /xyz/krita/plugin` → is it `installed` *and* `enabled`?
2. If `enabled` is false: close Krita, run the install again, then start Krita.
3. Still nothing? *Settings ▸ Configure Krita ▸ Python Plugin Manager* — tick **XYZ ComfyUI
   Bridge**, restart Krita.
4. The plugin's own log: `%APPDATA%\krita\xyz_comfy.log`.
