# ComfyUI-XYZNodes

**English** | [中文](README_zh.md)

A focused ComfyUI custom-node pack for prompt authoring, image management and Krita-assisted workflows.

## Included tools

| Tool | What it does | Manual |
|---|---|---|
| **Prompt Library V3** | A prompt language with nested groups, schedules, regions, presets, saved documents, a Monaco editor and live detail controls. It compiles to [comfyui-prompt-control](https://github.com/asagi4/comfyui-prompt-control). | [PLv3](prompt_library_v3/README.md) |
| **Tag autocomplete** | English-only Danbooru tags plus optional Gelbooru tags, backed by a local versioned dataset with updates, snapshots and date reconstruction. | [TagDB](tagdb/README.md) |
| **XYZ Gallery** | Browse and manage ComfyUI images and videos, inspect metadata, filter and tag files, download variants, and send images to Krita. | [Gallery](gallery/README.md) |
| **Mask nodes** | Draw rectangle masks and attach them to CLIP for PLv3 `imask: i` regions. | [Masks](mask_nodes/README.md) |
| **Krita bridge** | Fetch images or masks from Krita, split colour regions, open files, and send generated images back as layers or documents. | [Krita](krita_nodes/README.md) |
| **Cache slots** | Save an image in a named slot and read it in a later run. | [Cache](cache_nodes/README.md) |
| **Inpaint RGBA** | Turn an Inpaint Crop and Stitch result into a correctly positioned transparent RGBA layer. | [Source](inpaint_nodes/) |
| **ComfyUI agent integration** | Local launcher and safety boundary for the separate comfyui-mcp panel/orchestrator. | [Agent](agent_nodes/README.md) |

Prompt Library V2 and the original LLM prompt assistant have been retired. The personal V2 database directory is deliberately left untouched, and the [one-shot V2 → V3 migration tool](prompt_library_v3/README.md#migrating-from-v2) remains available.

When tags are added to a PLv3 library group, unescaped underscores become spaces and literal
parentheses are escaped; an outer `(tag:weight)` wrapper keeps its weight.

## Installation

1. Clone this repository into `ComfyUI/custom_nodes/`.
2. Install [comfyui-prompt-control](https://github.com/asagi4/comfyui-prompt-control) if you use PLv3.
3. Optionally install `curl_cffi>=0.7.0` if you want to scrape or update Danbooru yourself. Downloading the prebuilt dataset does not require it.
4. Restart ComfyUI.

On first run, the prebuilt Danbooru dataset downloads in the background. Autocomplete becomes available after the download finishes. The dataset contains English canonical names and aliases only; Japanese and Chinese wiki translations are intentionally not stored or searched.

## Nodes

| Node | Category | Purpose |
|---|---|---|
| XYZ Prompt Library V3 | `XYZNodes/Prompt` | Compile a PLv3 document using the standard text widget |
| XYZ Prompt Library V3 Monaco | `XYZNodes/Prompt` | The same compiler with the full editor embedded in the node |
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

The top bar exposes the XYZ Gallery and an **XYZ Tools** menu for the PLv3 editor/library, TagDB maintenance, settings, Krita and the optional agent launcher. Settings cover autocomplete, insertion, related tags, previews, PLv3, datasets and general information.

## Data and privacy

Runtime data is stored in gitignored directories such as `tagdb_data/`, `prompt_library_v3_data/`, `gallery_data/`, `krita_data/`, `agent_data/` and `output/`. The retired `prompt_library_v2_data/` directory is also ignored and preserved solely so existing personal data can be migrated.

TagDB credential endpoints never return a saved API key to the browser. Agent control routes accept loopback requests only.
