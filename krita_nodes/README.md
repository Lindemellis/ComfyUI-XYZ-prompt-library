# Krita Bridge

Pull layers and masks out of a running Krita, straight into your graph.

This is the *inverse* of krita-ai-diffusion. There, Krita is the workspace and ComfyUI is a
backend. Here **ComfyUI is the workspace** and Krita is the sketchpad you reach for when you need
to draw a rough composition, paint a region by hand, or mask something precisely.

| Node | Category | Purpose |
|---|---|---|
| **XYZ Krita Fetch Image** | `XYZNodes/Krita` | A layer (or the whole document) → `IMAGE` + its `width`/`height` |
| **XYZ Krita Fetch Mask** | `XYZNodes/Krita` | A layer → `MASK` |

Still to come: Send To Krita, Fetch Color Masks, and the cache slots.

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
