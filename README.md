# ComfyUI-XYZNodes

A ComfyUI custom node pack that combines **prompt engineering tools**, an **image gallery**, and a **Danbooru tag autocomplete** system — all in one plugin.

## Features at a Glance

| Module | Description |
|--------|-------------|
| [**Prompt Library V2**](prompt_library_v2/) | SQLite-backed hierarchical prompt library with template engine, trigger alias system, and a floating-window editor. |
| [**Image Gallery**](gallery/) | Full-featured image browser with metadata extraction, tag management, thumbnail generation, WebSocket real-time sync, and bulk operations. |
| [**Tag Database**](tagdb/) | Danbooru-style tag autocomplete with FTS5 trigram search, category colors, related tags, and artist previews. Prebuilt dataset download — no scraper required. |

Plus 4 lightweight utility nodes for string concatenation, text replacement, CLIP encoding, and random selection.

## Installation

1. Navigate to your ComfyUI `custom_nodes` directory:
   ```bash
   cd ComfyUI/custom_nodes/
   ```

2. Clone this repository:
   ```bash
   git clone https://github.com/zhupeter010903/ComfyUI-XYZ-prompt-library.git
   ```

3. Install dependencies:
   ```bash
   pip install -r ComfyUI-XYZ-prompt-library/requirements.txt
   ```
   The only dependency is `curl_cffi>=0.7.0` — required if you intend to scrape Danbooru for the Tag Database. It is **not required** for the prebuilt dataset download path.

4. Restart ComfyUI.

On first startup, the Tag Database will automatically download a prebuilt dataset in the background. The Gallery and Prompt Library V2 initialize their databases automatically — no manual setup needed.

## Core Nodes

All nodes appear under the **XYZ Node** or **XYZNodes/Prompt** categories in ComfyUI.

| Display Name | Category | Description |
|---|---|---|
| **XYZ Multi Text Concatenate** | XYZ Node | Joins multiple string inputs with a configurable delimiter, prefix, and suffix. Dynamically accepts any number of extra string inputs. |
| **XYZ Multi Text Replace** | XYZ Node | Template-based replacement using `[N]` placeholders. Feed in a template and any number of `[1] value` mapping strings. |
| **XYZ Multi Clip Encoder** | XYZ Node | Batch CLIP text encoding for multiple positive/negative prompts in one node. |
| **XYZ Random String Picker** | XYZ Node | Randomly selects from semicolon-separated tagged items. Supports `:1` (always) / `:0` (never) tags, configurable count range, and seed control. |
| **XYZ Prompt Library** | XYZNodes/Prompt | **Legacy V1** — JSON-file-based hierarchical prompt library with `{a\|b}` patterns, `[[tag]]` resolution, and `[entry]` references. |
| **XYZ Prompt Library V2 Positive** | XYZNodes/Prompt | Current V2 SQLite-backed prompt library. Resolves `[ref]`, `{a\|b}`, weighted `(text:wt)` syntax against the library database. Filters to positive-polarity entries. |
| **XYZ Prompt Library V2 Negative** | XYZNodes/Prompt | Same as V2 Positive, filtered to negative-polarity entries. |

## Sub-Modules

### [Prompt Library V2](prompt_library_v2/) → [Full Documentation](prompt_library_v2/README.md)

A SQLite-backed hierarchical prompt library with:
- **Template engine** — `[entry_ref]` expansion, `{a|b}` alternation, `(text:1.2)` weight wrapping, random modes (select/dropout/shuffle)
- **Trigger alias system** — automatic shortest-unique-name triggers, custom user-defined aliases, conflict resolution
- **Floating window editor** — split positive/negative panes, syntax highlighting, undo/redo, find/replace, delimiter-aware smart insert
- **Folder tree & entry detail** — polarity/usage filters, drag-reorder prompts, `_neg` auto-insert, `_template` inheritance
- **Normalization settings** — escape parentheses, full-width→half-width, underscore→space, auto-trim delimiters
- **Cycle-safe resolution** — max depth 50, cycle detection via frozenset tracking

### [Image Gallery](gallery/) → [Full Documentation](gallery/README.md)

A full-featured image browser for your ComfyUI outputs:
- **Automatic indexing** — cold scan on startup, delta reconciliation, filesystem watching (watchdog)
- **Cursor-paginated browsing** — filter by folder, tags, models, prompts (F04 word-mode matching), favorites, date range
- **Thumbnail generation** — 320×320 WebP on-demand, SHA-1 content-based caching, immutable cache headers
- **Rich metadata extraction** — positive/negative prompts, model, seed, CFG, sampler, scheduler, workflow JSON
- **Tag system** — add/remove tags via UI, normalized tag vocabulary with autocomplete, bulk tag operations
- **Bulk operations** — two-phase (preflight + execute) for move, delete, favorite, tag
- **WebSocket real-time sync** — all connected tabs see changes instantly (upsert, delete, folder change, index progress)
- **Metadata write-back** — PNG chunk sync for gallery metadata (favorite, tags) back into source files
- **Virtual grid + line view** — compact grid or section-grouped line layout, both with virtual scrolling

### [Tag Database](tagdb/) → [Full Documentation](tagdb/README.md)

Danbooru tag autocomplete with a prebuilt distribution model:
- **FTS5 trigram search** — fast substring matching on tag names + aliases + translations
- **Two-tier fallback** — trigram for 3+ char queries, LIKE prefix for short/CJK queries
- **Prebuilt dataset** — download from GitHub Release on first run; no scraper needed
- **Incremental updates** — event-watermark-based delta sync that only fetches new data
- **Full rebuild** — re-scrape all tags down to a configurable `min_post_count`
- **Related tags** — lazy-cached from Danbooru API with configurable freshness window
- **Artist previews** — recent posts thumbnail grid on hover
- **Tag image previews** — cached sample images for any tag (10min TTL)
- **Category colors** — general, artist, copyright, character, meta tags rendered in distinct colors
- **Translations DLC** — optional multilingual (JP/CN) search support
- **Snapshot management** — switch between working DB, official releases, and local export checkpoints
- **Frontend integration** — `tagac.js` hooks every multiline STRING widget in ComfyUI for inline autocomplete
- **PLv2 cross-integration** — suggests prompt library entries alongside tags in the dropdown

## Project Structure

```
ComfyUI-XYZNodes/
├── __init__.py                  # Node registration, V1 API routes, sub-module setup
├── node.py                      # Core utility nodes (Concatenate, Replace, Clip Encode, Random Picker)
├── prompt_library_node.py       # Legacy V1 Prompt Library node
│
├── prompt_library_v2/           # V2 Prompt Library (SQLite-backed)
│   ├── node.py                  #   Node classes
│   ├── db.py                    #   Schema & migrations
│   ├── engine.py                #   Template resolution engine
│   ├── trigger.py               #   Trigger alias system
│   ├── repo.py                  #   Data access (WriteQueue)
│   ├── routes.py                #   HTTP API
│   └── README.md                #   Full documentation
│
├── gallery/                     # Image Gallery subsystem
│   ├── indexer.py               #   Image indexing & scanning
│   ├── watcher.py               #   Filesystem watching (watchdog)
│   ├── vocab.py                 #   Prompt/tag token normalization
│   ├── thumbs.py                #   Thumbnail generation & caching
│   ├── metadata.py              #   PNG metadata extraction
│   ├── metadata_sync.py         #   Metadata write-back to files
│   ├── service.py               #   Business logic (bulk ops, etc.)
│   ├── routes.py                #   HTTP API (69 endpoints)
│   ├── ws_hub.py                #   WebSocket broadcast hub
│   ├── repo.py                  #   Data access (WriteQueue)
│   ├── db.py                    #   Schema & migrations (v1-v6)
│   └── README.md                #   Full documentation
│
├── tagdb/                       # Tag Database subsystem
│   ├── db.py                    #   Schema (V2, FTS5 trigram)
│   ├── repo.py                  #   Search & data access
│   ├── scraper.py               #   Danbooru scraper (curl_cffi)
│   ├── updater.py               #   Full & incremental update logic
│   ├── distribution.py          #   Prebuilt dataset download/verify
│   ├── build_dataset.py         #   Author CLI for building official datasets
│   ├── routes.py                #   HTTP API
│   └── README.md                #   Full documentation
│
├── js/                          # Frontend JavaScript
│   ├── plv2.js                  #   PLv2 window manager & snapping
│   ├── plv2_editor.js           #   PLv2 text editor
│   ├── plv2_tree.js             #   PLv2 folder tree
│   ├── plv2_entry.js            #   PLv2 entry detail
│   ├── tagac.js                 #   Global tag autocomplete
│   ├── tagdb_panel.js           #   TagDB manager panel
│   ├── xyz_topbar.js            #   Top bar extension
│   ├── xyz_settings.js          #   Settings panel
│   └── gallery_dist/            #   Gallery SPA (Vue 3)
│
├── test/                        # Test suite
├── node_definition.json         # ComfyUI V2 node definition JSON Schema
├── requirements.txt             # curl_cffi >= 0.7.0
├── README.md                    # This file
├── README_zh.md                 # Chinese version
└── CLAUDE.md                    # Claude Code project instructions
```

## Configuration

Each sub-module manages its own data and configuration:

| Module | Data Directory | Config |
|--------|---------------|--------|
| Prompt Library V2 | `prompt_library_v2_data/plv2.db` | Normalization settings in localStorage |
| Gallery | `gallery_data/` (DB, thumbs, config) | `gallery_config.json`, UI preferences via API |
| Tag Database | `tagdb_data/` (working DB, snapshots) | `settings.json` (credentials), `tagdb/official_manifest.json` (committed) |

## Development

Tests are in `test/` named `t*_test.py`. Run them with:

```bash
python -m pytest test/ -v
```

The `CLAUDE.md` file at the repo root contains detailed architecture notes, coding conventions, and gotchas for contributors.

## Compatibility

- ComfyUI (recent versions with the V2 node API)
- Python 3.10+
- Optional: `curl_cffi` for TagDB scraping (not needed for prebuilt dataset)

---

[中文版 (Chinese)](README_zh.md)
