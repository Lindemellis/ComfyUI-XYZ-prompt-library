# Tag Autocomplete & Dataset

**English** | [中文](README_zh.md) · [← Back to main README](../README.md)

Danbooru tag autocomplete backed by a versioned local SQLite dataset. As you type in any prompt box you get tag suggestions ordered by post count; the dataset is downloaded prebuilt and can be updated, snapshotted, and rolled back to a past date.

## Getting a dataset

On first run the plugin downloads the author's prebuilt dataset (~66 MB, ~118K tags with post-count ≥ 50) in the background — autocomplete works as soon as it finishes. Nothing is scraped automatically.

If the download fails (offline, none published yet), open **XYZ Prompt Tools → Tag dataset** and either retry **Download / Update**, or build your own (needs a free Danbooru login + API key).

### Data layout (`tagdb_data/`, gitignored)

```
tagdb_data/
├── danbooru.sqlite       ← danbooru working DB (autocomplete reads this by default)
├── gelbooru.sqlite       ← optional second-source DB (present only if installed)
├── settings.json         ← Danbooru/Gelbooru credentials + preferences
└── snapshots/
    ├── official/         ← prebuilt copies from the GitHub Release (read-only)
    └── local/            ← your exports + reconstruction results (read-only)
```

## Using autocomplete

- Type in any ComfyUI prompt textarea (and in the Prompt Library editors). Use ↑/↓ to move, Enter/Tab to accept, Esc to dismiss.
- Tag names are stored with underscores; with **Replace `_` with space** on, they are inserted with spaces.
- Relevant settings (**XYZ Prompt Tools → …**):
  - **Autocomplete**: enable on/off, max suggestions (default 15), hide rare tags (skip below a post count; default 0 = show all).
  - **Insertion**: underscore→space, auto comma, escape brackets, full-width→half-width.
  - **Library**: also suggest your own Prompt Library prompts / entry references.
  - **Related**: click a tag in the rich editor / entry text view to see related tags (one request per lookup; cached).
  - **Preview**: hover the 🖼 icon for an artist-works popup or a tag preview image. **Both are off by default**; fetched on demand from Danbooru, cached in memory.

## Tag dataset manager

**XYZ Prompt Tools → Tag dataset**:

| Action | What it does |
|---|---|
| **Download / Update** | Download the author's prebuilt dataset from the GitHub Release. Replaces the working DB. |
| **Incremental** | Apply new/changed tag events since your last sync and refresh post counts. Needs a Danbooru login + API key. |
| **Full re-scrape** | Rebuild the dataset from scratch from Danbooru. Needs credentials; takes a while. |
| **Snapshots → Use** | Point autocomplete at a snapshot **without** changing the working DB. |
| **Snapshots → Export / Delete** | Save the working DB as a local checkpoint, or remove a snapshot file. |
| **Reconstruct & use** | "Time machine" — rebuild the tag vocabulary as of a past date. |

### Danbooru credentials

Your login and API key are stored in plaintext in `tagdb_data/settings.json` (gitignored) and used only for your own Incremental / Full updates. A free Danbooru account can generate an API key in its profile settings.

### Time machine (Reconstruct)

Rebuilds tag existence, category, and names as of a chosen date — including rolling artist names back along their rename history, so searching any historical name finds the artist. Requires the version history that the official releases include. The result is saved to `snapshots/local/` and activated; switch back via **Snapshots → Use** on `danbooru.sqlite`.

## Gelbooru (second source)

Gelbooru is an **optional second tag set** that lives in its own file (`tagdb_data/gelbooru.sqlite`) alongside the Danbooru working DB. It is independent and **current-only** — there is no time machine for Gelbooru (its API exposes no versioned history). Deprecated Gelbooru tags (typo/redirect tags) are excluded from the dataset.

**Enable it:** *Settings → Autocomplete → Gelbooru tags*. Install/manage it in *Tag dataset → **Gelbooru** tab*.

**How both sources combine** — with Danbooru and Gelbooru both enabled, suggestions are **merged and deduped by name**, and each row shows a clickable source token:

- **`D`** → opens the Danbooru wiki for that tag · **`G`** → opens the tag's posts on gelbooru.com.
- A tag in both shows **`D G`**; a tag in only one shows just its token.
- On any disagreement (e.g. different category), **Danbooru is authoritative**. Tags Danbooru has renamed but Gelbooru still keeps live appear as `G`-only rows.
- Clicking a tag shows its detail panel. Gelbooru has no related-tags API, so a **Gelbooru-only tag shows just its own info** (no related list).

**Get the dataset** (*Tag dataset → Gelbooru*):

| Action | What it does |
|---|---|
| **Download dataset** | Fetch the author's prebuilt Gelbooru DLC from the GitHub Release (no credentials needed). |
| **Build from gelbooru** | Scrape directly from Gelbooru into `gelbooru.sqlite`. Needs a free Gelbooru `api_key` + `user_id` (the tag API returns HTTP 401 without them). |
| **Gelbooru snapshots → Use** | Switch between Gelbooru datasets scraped at different dates (downloads + exported checkpoints). |
| **Remove** | Delete `gelbooru.sqlite` and fall back to Danbooru only. |

**Gelbooru credentials:** create a free account → *My Account → Options → API Access Credentials* to get `api_key` + `user_id`. Stored in `tagdb_data/settings.json` (gitignored), used only to build/update directly — downloading the prebuilt DLC needs none.

## FAQ

**Typing Japanese/Chinese finds nothing.** The dataset has no wiki translations — search matches English tag names and artists' former names only.

**Tag count doesn't match the release.** Releases use `min_post_count = 50`. Your own update with a lower threshold yields more tags.

**Tag count dropped.** You probably switched the active snapshot — **Snapshots → Use** on `danbooru.sqlite` to switch back.

---

## Building your own dataset (advanced)

The author CLI runs standalone (no ComfyUI). It needs `curl_cffi` and Danbooru credentials:

```bash
python -m tagdb.build_dataset --full --min-post-count 50 --with-versions --with-artists --zip \
    --login YOUR_LOGIN --api-key YOUR_API_KEY
```

It writes a `.sqlite` (and `.zip` with `--zip`) to `dist/` and prints a manifest entry. `--with-versions` enables time-machine reconstruction; `--with-artists` adds artist data. To publish, upload the `.zip` to a GitHub Release and update `tagdb/official_manifest.json`.

**Gelbooru** builds use the same CLI with `--gelbooru` (credentials from `settings.json`, or pass `--api-key` + `--user-id`):

```bash
python -m tagdb.build_dataset --gelbooru --min-post-count 50 --zip
```

This writes `dist/gelbooru_<date>.sqlite(.zip)` and prints a `datasets_gelbooru[]` entry for the manifest (set `latest_gelbooru`). To audit cross-source name collisions between the two full datasets: `python -m tagdb.audit_sources` (defaults to `tagdb_data/danbooru.sqlite` + `tagdb_data/gelbooru.sqlite`).

For backend/architecture notes see the project root `CLAUDE.md`.
