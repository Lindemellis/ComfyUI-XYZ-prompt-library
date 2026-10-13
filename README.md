# ComfyUI-XYZNodes

**English** | [中文](README_zh.md)

A focused ComfyUI custom-node pack for prompt authoring, image management and Krita-assisted workflows.

## Included tools

| Tool | What it does | Manual |
|---|---|---|
| **Prompt Library V4** | Author prompts through Blocks / Source / Preview, organize assets in Folders and bind Blocks to Class pools. Includes an independent LoRA browser and Schedule / Region / AVG blocks. Uses the PLv3 language and prompt-control compiler. | [PLv4](prompt_library_v4/README.md) |
| **PLv3 language / compatibility** | Shared language/compiler for V4 and deprecated nodes that keep older workflows runnable. Standalone V3 Editor / Library are retired. | [Language and compatibility](prompt_library_v3/README.md) |
| **Tag autocomplete** | English-only Danbooru tags plus optional Gelbooru tags, backed by a local versioned dataset with updates, snapshots and date reconstruction. | [TagDB](tagdb/README.md) |
| **XYZ Gallery** | Browse and manage ComfyUI images and videos, inspect metadata, filter and tag files, download variants, and send images to Krita. | [Gallery](gallery/README.md) |
| **Mask nodes** | Draw rectangle masks and attach them to CLIP for PLv3 `imask: i` regions. | [Masks](mask_nodes/README.md) |
| **Krita bridge** | Fetch images or masks from Krita, split colour regions, open files, and send generated images back as layers or documents. | [Krita](krita_nodes/README.md) |
| **Cache slots** | Save an image in a named slot and read it in a later run. | [Cache](cache_nodes/README.md) |
| **Inpaint RGBA** | Turn an Inpaint Crop and Stitch result into a correctly positioned transparent RGBA layer. | [Source](inpaint_nodes/) |
| **ComfyUI agent integration** | Local launcher and safety boundary for the separate comfyui-mcp panel/orchestrator. | [Agent](agent_nodes/README.md) |

Prompt Library V2 and the original LLM prompt assistant have been retired. The personal V2 database directory is deliberately left untouched, and the [one-shot V2 → V3 migration tool](prompt_library_v3/README.md#migrating-from-v2) remains available.

V3's standalone Editor / Library no longer start. Old workflow nodes, shared language and personal databases remain available; V3 Library import into V4 is explicit and backed up. Use V4 for new nodes.

## Installation

1. Clone this repository into `ComfyUI/custom_nodes/`.
2. Install [comfyui-prompt-control](https://github.com/asagi4/comfyui-prompt-control) if you use PLv3 or PLv4.
3. Optionally install `curl_cffi>=0.7.0` if you want to scrape or update Danbooru yourself. Downloading the prebuilt dataset does not require it.
4. Restart ComfyUI.

After updating an existing installation, restart your regular ComfyUI instance and press **Ctrl+F5** in the browser to load the new interface. Personal Libraries, model files and workflows are preserved; test-environment data is not needed.

On first run, the prebuilt Danbooru dataset downloads in the background. Autocomplete becomes available after the download finishes. The dataset contains English canonical names and aliases only; Japanese and Chinese wiki translations are intentionally not stored or searched.

## Nodes

| Node | Category | Purpose |
|---|---|---|
| XYZ Prompt Library V4 | `XYZNodes/Prompt` | Edit Blocks, Class pools and Mask Library references; output prompt / plain / metadata / mask_bundle |
| XYZ Prompt Library V4 Monaco | `XYZNodes/Prompt` | The same V4 compiler with an embedded source editor |
| XYZ PLV4 Image Metadata | `XYZNodes/Prompt` | Merge positive/negative PLV4 snapshots and additional LoRAs for Aaalice saving and Gallery Source display |
| XYZ PLV4 Mask Preview | `XYZNodes/Prompt` | Preview current Document geometry; output 512×512 IMAGE and stable dynamic MASKs |
| XYZ PLV4 Attach Masks | `XYZNodes/Prompt` | Clone CLIP and append library picture masks; warn and continue on IMASK index mismatch |
| XYZ Prompt Library V3 | `XYZNodes/Prompt` | Deprecated compatibility node for saved V3 workflows |
| XYZ Prompt Library V3 Monaco | `XYZNodes/Prompt` | Deprecated V3 compatibility node with shared embedded Monaco |
| XYZ Mask Editor | `XYZNodes/Mask` | Draw rectangles and emit base, fill and per-rectangle masks |
| XYZ Attach Masks | `XYZNodes/Mask` | Attach masks to CLIP in PLv3 IMASK order |
| XYZ Krita Fetch Image | `XYZNodes/Krita` | Fetch a layer or document as `IMAGE` |
| XYZ Krita Fetch Mask | `XYZNodes/Krita` | Fetch a mask layer or a paint layer's alpha as `MASK` |
| XYZ Krita Fetch Color Masks | `XYZNodes/Krita` | Split a flat-colour layer into dynamic mask outputs |
| XYZ Krita Send To Krita | `XYZNodes/Krita` | Send an image as a new layer or document |
| XYZ Krita Open File | `XYZNodes/Krita` | Open an image or `.kra` file in Krita |
| XYZ Cache Slot Write / Read | `XYZNodes/Cache` | Persist an image between runs |
| XYZ Inpaint Stitch To RGBA | `XYZNodes/Inpaint` | Produce a positioned transparent inpaint layer |

## User interface

The top bar exposes XYZ Gallery and **XYZ Tools**, including the V4 editor, original V3 editor/Library, TagDB maintenance, settings, Krita and the optional agent launcher. Prompt nodes' **Editor** button opens the V4 window; V3 nodes remain supported.

V4 separates a block's ordered **Content** from optional **Pool** candidates. Add candidates with **+**, edit or disable them in Content, and explicitly save reusable blocks. Single-click Library browsing uses one temporary tab; editing or double-clicking pins it. See the [V4 manual](prompt_library_v4/README.md) for dragging, search, Region/Schedule controls and migration.

## Data and privacy

Runtime data is stored in gitignored directories such as `tagdb_data/`, `prompt_library_v3_data/`, `prompt_library_v4_data/`, `gallery_data/`, `krita_data/`, `agent_data/` and `output/`. V4 uses its own `plv4-pools.db`; personal V3 data is not migrated automatically. The Library migration command backs up and imports V3 without replacing it. The retired `prompt_library_v2_data/` is also ignored and preserved for migration.

TagDB credential endpoints never return a saved API key to the browser. Agent control routes accept loopback requests only.
