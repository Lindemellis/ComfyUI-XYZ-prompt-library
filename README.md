# ComfyUI-XYZNodes

**English** | [中文](README_zh.md)

A ComfyUI custom-node pack with three larger tools — **Danbooru (+ optional Gelbooru) tag autocomplete**, a **hierarchical prompt library (V2)**, and an **image gallery**.

Each tool has its own manual:

- 📖 [Tag Autocomplete & Dataset](tagdb/README.md)
- 📖 [Prompt Library V2](prompt_library_v2/README.md)
- 📖 [Image Gallery](gallery/README.md)

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
| **Prompt Library V2** | A SQLite-backed hierarchical prompt library with `[ref]` references, trigger aliases, weights, random modes, and a floating text editor. Resolved by two nodes at execution time. | [plv2](prompt_library_v2/README.md) |
| **Image Gallery** | Browse and manage ComfyUI output/input images — filters, tags, bulk operations, and metadata viewing. | [gallery](gallery/README.md) |

## Where things live

After restarting ComfyUI, two buttons appear in the top bar:

- **Open XYZ Gallery** (image icon) — opens the gallery.
- **XYZ Tools** (menu) — opens:
  - *Prompt Library V2 — Library*
  - *Prompt Library V2 — Text Editor*
  - *Prompt Library V1 Manager* (legacy)
  - *XYZ Prompt Tools Settings*

The **settings window** (also reachable from the ComfyUI command palette: *"Open XYZ Prompt Tools settings"*) has these tabs:

| Tab | Controls |
|---|---|
| Autocomplete | Enable on/off, max suggestions, hide rare tags, **Danbooru / Gelbooru sources** |
| Insertion | Underscore→space, auto comma, escape brackets, full-width→half-width |
| Library | Use your prompt library as autocomplete sources; entry-ref suggestions |
| Related | Click-a-tag related lookups + cache freshness |
| Preview | Artist-works / tag preview images on hover (both **off** by default) |
| Tag dataset | **Danbooru / Gelbooru tabs**: credentials, prebuilt dataset, updates, snapshots, reconstruct |
| About | Version / info |

Each Prompt Library V2 node also has its own **Library / Editor / Preview** buttons.

## Nodes

| Node | Category | Purpose |
|---|---|---|
| XYZ Prompt Library V2 Positive | `XYZNodes/Prompt` | Resolve a positive prompt template against the library |
| XYZ Prompt Library V2 Negative | `XYZNodes/Prompt` | Resolve a negative prompt template against the library |
| XYZ Prompt Library | `XYZNodes/Prompt` | Legacy V1 prompt library node (kept for backward compatibility) |

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

Data directories (`tagdb_data/`, `prompt_library_v2_data/`, `gallery_data/`, `prompt_library/`) are created at runtime and are gitignored.
