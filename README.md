# ComfyUI-XYZNodes

**English** | [中文](README_zh.md)

A ComfyUI custom-node pack with five larger tools — **Danbooru (+ optional Gelbooru) tag autocomplete**, a **prompt language with an editor and a library (V3)**, the older **hierarchical prompt library (V2)**, an **LLM prompt assistant** (multi-provider, with local tag grounding), and an **image gallery**.

Each tool has its own manual:

- 📖 [Tag Autocomplete & Dataset](tagdb/README.md)
- 📖 **[Prompt Library V3](prompt_library_v3/README.md)** — the current one
- 📖 [Prompt Library V2](prompt_library_v2/README.md) — still supported; [migration tool](prompt_library_v3/README.md#migrating-from-v2)
- 📖 [LLM Prompt Assistant](llm/README.md)
- 📖 [Image Gallery](gallery/README.md)
- 📖 [Mask Nodes](mask_nodes/README.md) — rectangle masks for PLv3's regions
- 📖 [Krita Bridge](krita_nodes/README.md) — pull layers and masks out of a running Krita
- 📖 [Cache Slots](cache_nodes/README.md) — hand an image from one run to the next

## Installation

1. Go to your ComfyUI `custom_nodes` directory:
   ```bash
   cd ComfyUI/custom_nodes/
   ```
2. Clone this repository:
   ```bash
   git clone https://github.com/Lindemellis/ComfyUI-XYZ-prompt-library.git
   ```
3. *(Optional)* Install `curl_cffi` — **only** needed if you want to scrape/update the tag dataset from Danbooru yourself. Downloading the prebuilt dataset does not need it:
   ```bash
   pip install curl_cffi>=0.7.0
   ```
4. Restart ComfyUI.

On the **first run**, the prebuilt Danbooru tag dataset (~66 MB, ~118K tags with post-count ≥ 50) downloads automatically in the background. Tag autocomplete becomes ready once it finishes. Nothing is scraped automatically — if the download fails (offline, etc.), open the Tag dataset panel to retry.

## Features

| Tool | What it does | Manual |
|---|---|---|
| **Tag autocomplete** | Danbooru tag suggestions as you type in any prompt box, with a versioned local dataset, updates, snapshots, and date-based "time-machine" reconstruction. | [tagdb](tagdb/README.md) |
| **Prompt Library V3** | A prompt *language* — nested groups with settings, schedules, regions, library blocks — compiled to [comfyui-prompt-control](https://github.com/asagi4/comfyui-prompt-control) syntax. A Monaco editor, a detail page of live controls over the same text, a preview, and a library with presets. The text is the only store: a workflow carries everything it needs. | [plv3](prompt_library_v3/README.md) |
| **Prompt Library V2** | A SQLite-backed hierarchical prompt library with `[ref]` references, trigger aliases, weights, random modes, and a floating text editor. Resolved by two nodes at execution time. | [plv2](prompt_library_v2/README.md) |
| **LLM Prompt Assistant** | A floating window that uses an LLM (DeepSeek / OpenAI / Claude / Grok / custom) to generate or optimize txt2img prompts, grounding danbooru tags against your local dataset so they stay real. | [llm](llm/README.md) |
| **Image Gallery** | Browse and manage ComfyUI output/input images **and videos** — filters, tags, bulk operations, metadata viewing, video playback. | [gallery](gallery/README.md) |
| **Mask Nodes** | Draw rectangle masks on a canvas and attach them to a CLIP, so PLv3's `imask: i` regions have something to point at. | [masks](mask_nodes/README.md) |
| **Krita Bridge** | A Krita plugin + nodes that pull a layer or a mask straight out of the running Krita, split a flat-colour layer into region masks, and push a result back as a new layer. ComfyUI stays the workspace; Krita is the sketchpad. | [krita](krita_nodes/README.md) |
| **Cache Slots** | Park an image in a named slot and pick it up on a later run — the cross-run hand-off, without Krita. | [cache](cache_nodes/README.md) |

## Where things live

After restarting ComfyUI, two buttons appear in the top bar:

- **Open XYZ Gallery** (image icon) — opens the gallery.
- **XYZ Tools** (menu) — opens:
  - *Prompt Library V3 — Editor*
  - *Prompt Library V3 — Library*
  - *Prompt Library V2 — Library*
  - *Prompt Library V2 — Text Editor*
  - *Prompt Library V2 — LLM Prompt*
  - *XYZ Prompt Tools Settings*

The **settings window** (also reachable from the ComfyUI command palette: *"Open XYZ Prompt Tools settings"*) has these tabs:

| Tab | Controls |
|---|---|
| Prompt Library V3 | Slider ranges (prompt weight, LoRA weight, schedule step), editor font/wrap, refresh delay, library autosave delay |
| Autocomplete | Enable on/off, max suggestions, hide rare tags, **Danbooru / Gelbooru sources** |
| Insertion | Underscore→space, auto comma, escape brackets, full-width→half-width |
| Library | Use your prompt library as autocomplete sources; entry-ref suggestions |
| Related | Click-a-tag related lookups + cache freshness |
| Preview | Artist-works / tag preview images on hover (both **off** by default) |
| Tag dataset | **Danbooru / Gelbooru tabs**: credentials, prebuilt dataset, updates, snapshots, reconstruct |
| LLM | **Provider** (DeepSeek / OpenAI / Claude / Grok / custom), API key, model, **Test connection**, temperature/top_p, tag-lookup sources |
| About | Version / info |

Each Prompt Library V2 node also has its own **Library / Editor / Preview / LLM** buttons.

## Nodes

| Node | Category | Purpose |
|---|---|---|
| XYZ Prompt Library V3 | `XYZNodes/Prompt` | Compile a PLv3 document into [prompt-control](https://github.com/asagi4/comfyui-prompt-control) syntax (plain textarea) |
| XYZ Prompt Library V3 Monaco | `XYZNodes/Prompt` | The same, with the full editor embedded in the node (library autocomplete, folding, tags). Regions are for the positive prompt only — don't put one in a negative prompt |
| XYZ Prompt Library V2 Positive | `XYZNodes/Prompt` | Resolve a positive prompt template against the library |
| XYZ Prompt Library V2 Negative | `XYZNodes/Prompt` | Resolve a negative prompt template against the library |
| XYZ Mask Editor | `XYZNodes/Mask` | Draw rectangle masks; one `MASK` output per rectangle ([manual](mask_nodes/README.md)) |
| XYZ Attach Masks | `XYZNodes/Mask` | Attach those masks to a `CLIP` for `IMASK(i)` / PLv3's `imask: i` |
| XYZ Krita Fetch Image | `XYZNodes/Krita` | A Krita layer (or the whole document) → `IMAGE` ([manual](krita_nodes/README.md)) |
| XYZ Krita Fetch Mask | `XYZNodes/Krita` | A Krita layer → `MASK`; mask layers read directly, paint layers give alpha |
| XYZ Krita Fetch Color Masks | `XYZNodes/Krita` | One flat-colour layer → N masks of any shape |
| XYZ Krita Send To Krita | `XYZNodes/Krita` | An `IMAGE` → a new Krita layer or a new document; can grow the whole document |
| XYZ Krita Open File | `XYZNodes/Krita` | Open a file on disk in Krita — a `.kra` keeps every layer |
| XYZ Cache Slot Write / Read | `XYZNodes/Cache` | Park an image for a later run ([manual](cache_nodes/README.md)) |

## FAQ

**Can't find a tag by typing Japanese/Chinese?**
The dataset does not include wiki translations. Search matches English tag names and artists' former names only.

**Do I need a Danbooru account?**
No, for downloading the prebuilt dataset. Yes (a free login + API key) only if you run your own Incremental / Full update or build a dataset.

**Tag count doesn't match the release number?**
The release is built with `min_post_count = 50`. If you run your own update with a lower threshold you'll get more tags.

**Tag count dropped suddenly?**
You may have switched the active snapshot. In *Tag dataset → Snapshots*, click **Use** on the working DB (`danbooru.sqlite`) to switch back.

**What's the Gelbooru source?**
An optional second tag set. Enable it in *Settings → Autocomplete → Gelbooru tags* and install the dataset in *Tag dataset → Gelbooru*. With both sources on, suggestions merge and each row shows a clickable **D**/**G** token (Danbooru wiki / Gelbooru posts). Danbooru wins on any conflict; Gelbooru is current-only (no time machine). See the [tag manual](tagdb/README.md#gelbooru-second-source).

---

Data directories (`tagdb_data/`, `prompt_library_v2_data/`, `prompt_library_v3_data/`, `gallery_data/`, `krita_data/`) are created at runtime and are gitignored.
