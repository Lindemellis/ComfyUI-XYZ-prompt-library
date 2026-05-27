# ComfyUI-XYZNodes

A ComfyUI custom node pack — **Danbooru tag autocomplete**, **hierarchical prompt library**, **image gallery**, plus 4 lightweight text processing nodes.

## Installation

1. Navigate to ComfyUI's `custom_nodes` directory:
   ```bash
   cd ComfyUI/custom_nodes/
   ```
2. Clone the repository:
   ```bash
   git clone https://github.com/Lindemellis/ComfyUI-XYZ-prompt-library.git
   ```
3. Optional dependency (only needed if you plan to scrape Danbooru yourself):
   ```bash
   pip install curl_cffi>=0.7.0
   ```
4. Restart ComfyUI.

On first startup, a prebuilt tag dataset downloads automatically in the background. Autocomplete is ready when it finishes.

## Tag Database (Autocomplete)

Type in any ComfyUI prompt textarea to get tag suggestions.

### Managing Your Dataset

The plugin needs a Danbooru tag database. Open **XYZ Prompt Tools → Tag dataset** to manage it:

| Action | Button | Description |
|---|---|---|
| Download official dataset | Download / Update | Downloads the author's prebuilt dataset from GitHub Release (~65 MB, 118K tags, post_count ≥ 50) |
| Local incremental update | Incremental | Sync new/changed tags from Danbooru + refresh all post_counts (~3–5 min, needs Danbooru account) |
| Local full rebuild | Full | Rebuild the entire dataset from Danbooru (~90 min, needs Danbooru account) |
| Time travel | Reconstruct | Rebuild the tag vocabulary as of a historical date, with artist name rollback |

### Dataset Files Explained

```
tagdb_data/
├── tagdb.sqlite        ← Working DB (mutable, autocomplete reads from here by default)
├── snapshots/
│   ├── official/       ← Prebuilt copies downloaded from Release (read-only)
│   └── local/          ← Local backups and time-machine snapshots (read-only)
```

- **tagdb.sqlite**: Your local dataset. Incremental/Full maintenance writes here. Downloading a release with "replace" overwrites this.
- **official/**: Frozen prebuilt copies. The "Use" button switches autocomplete to read from one without modifying the working DB.
- **local/**: Auto-backups before maintenance, time-machine reconstruction results.

**Note**: Switching to a snapshot with "Use" does NOT change the working DB's tag count. It only changes where autocomplete reads from.

### Choosing a Data Source

| Source | Tag Count | Freshness | Network | Action |
|---|---|---|---|---|
| Download Release (recommended) | 118K tags | As of release | Download once | Download / Update |
| Your own Incremental | Based on your threshold | Live | Danbooru account, ~3 min each | Incremental |
| Your own Full rebuild | Based on your threshold | Live | Danbooru account, ~90 min | Full |

### Time Machine (Reconstruct)

Rebuild the tag state as of any past date, including artist name rollback.

- Requires `tag_versions` and `artist_versions` data (included in official releases)
- Result saved to `local/recon_YYYY-MM-DD.sqlite` and auto-activated
- Artist names are rolled back along their rename timeline: e.g. `range_murata → murata_renji → murata_range`, searching any historical name finds the artist

### Settings

Open **XYZ Prompt Tools → Autocomplete**:

| Setting | Description | Default |
|---|---|---|
| Enable autocomplete | Global on/off | On |
| Max suggestions | Dropdown max items | 15 |
| Hide rare tags | Skip tags below this post_count (0 = show all) | 0 |
| Show artist preview | Show recent works on artist tag hover | On |
| Show tag preview | Show sample image on tag hover | On |
| Scrape threshold | Only fetch tags ≥ this post_count during maintenance | 50 |

Additional panels (Insertion, Library, Related, Preview) control insertion behavior, library sources, and related-tag caching. Settings save to browser localStorage.

## Prompt Library V2

Hierarchical prompt library with templates and references. Two nodes:

- **XYZ Prompt Library V2 Positive** — positive prompts
- **XYZ Prompt Library V2 Negative** — negative prompts

### Quick Start

1. Add the node to your workflow
2. Click the **Library** button on the node to open the library window
3. Browse the folder tree, create entries
4. Syntax support: `[ref]` references, `{a|b}` random choice, `(text:1.2)` weights
5. Double-click entries or type `/trigger_name` to insert into the editor

See [Prompt Library V2 docs](prompt_library_v2/README.md) for details.

## Image Gallery

Browse and manage ComfyUI output images with tags, bulk operations, and metadata viewing.

See [Gallery docs](gallery/README.md) for details.

## Core Nodes

| Node | Category | Purpose |
|---|---|---|
| XYZ Multi Text Concatenate | XYZ Node | Join text inputs with delimiter, prefix, suffix |
| XYZ Multi Text Replace | XYZ Node | Template replacement with `[N]` placeholders |
| XYZ Multi Clip Encoder | XYZ Node | Batch CLIP encoding for multiple prompts |
| XYZ Random String Picker | XYZ Node | Random selection from `;`-separated tagged items |

## FAQ

**Q: Can't find tags by typing Japanese/Chinese?**
The plugin does not include wiki translations. Search matches English tag names and artist former names only.

**Q: How do I switch back to my working database?**
Tag dataset → Snapshots → click "Use" on the tagdb.sqlite row.

**Q: Do I need a Danbooru account?**
No for downloading releases. Yes (free API key) for running your own Incremental/Full maintenance.

**Q: Tag count doesn't match what the release says?**
Releases use min_post_count=50. Your own maintenance may use a lower threshold, yielding more tags.

**Q: Tag count dropped suddenly?**
Check if you've activated a smaller snapshot (marked "active" in the list). Click "Use" on the working DB to switch back.

---

[中文版 (Chinese)](README_zh.md)
