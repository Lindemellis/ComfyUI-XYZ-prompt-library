# Tag Database

Danbooru-style tag autocomplete for ComfyUI. Provides fast substring search over a comprehensive tag vocabulary with category colors, related tags, artist previews, and a prebuilt dataset distribution model so users never need to scrape Danbooru themselves.

## Design Philosophy

**No silent scraping.** On first run, the plugin downloads a prebuilt dataset from a GitHub Release. If the download fails, the user can retry from the Tag DB Manager panel or optionally enter Danbooru credentials to scrape their own dataset. The scraper is opt-in and always requires explicit user action.

## Architecture

```
tagdb/                         ← Package (committed to git)
├── official_manifest.json     ←   Prebuilt dataset metadata

tagdb_data/                    ← Runtime data (gitignored)
├── tagdb.sqlite               ←   Mutable working DB (autocomplete reads this)
├── settings.json              ←   Danbooru credentials (optional), manifest URL
└── snapshots/
    ├── official/              ←   Immutable prebuilt datasets from GitHub Release
    └── local/                 ←   User-exported snapshot checkpoints
```

- **Working DB** — mutable, holds the active dataset used for autocomplete
- **Official snapshots** — read-only, downloaded prebuilt datasets
- **Local snapshots** — user-exported checkpoints of the working DB
- **Manifest** — `tagdb/official_manifest.json` (committed) or remote URL (configurable in settings)
- **Settings** — optional Danbooru credentials, active DB selection, manifest URL

## Getting Started

### Automatic (recommended)

1. Install the plugin and restart ComfyUI.
2. On first startup, a prebuilt dataset downloads automatically in the background (~300 MB zip).
3. Once downloaded, the dataset is verified (SHA-256), unzipped, and seeded as the working DB.
4. Tag autocomplete is immediately available across all multiline STRING widgets.

### Manual

Open the **Tag DB Manager** panel from ComfyUI's sidebar. From there you can:
- Check for newer official dataset versions
- Download and install an official dataset
- Download optional translations DLC (Japanese/Chinese search)
- Enter Danbooru credentials and run a full or incremental scrape
- Switch between working DB and snapshot databases
- Export the current working DB as a local snapshot
- Reconstruct a historical vocabulary snapshot as of a specific date

## Search Features

### Two-Tier Search Strategy

| Query Type | Method | Detail |
|------------|--------|--------|
| 3+ characters (ASCII) | FTS5 trigram | Fast substring matching on `tags.name`, `aliases`, and `translations` via contentless FTS5 with a trigram tokenizer |
| < 3 characters | LIKE prefix | `LIKE 'q%'` on tag names, enriched with aliases and translations for the top results |
| CJK/kana/hangul | LIKE substring | Wider `LIKE '%q%'` scan across all three text sources (less frequent queries, acceptable slower scan) |

### Result Enrichment

Each search result includes:
- **Category** — rendered in distinct colors: general (blue), artist (pink), copyright (purple), character (green), meta (yellow)
- **Post count** — Danbooru usage count
- **Aliases** — comma-separated alternative names
- **Translations** — Japanese/Chinese names (if translations DLC installed)
- **Artist previews** — recent post thumbnails on hover (for artist tags)
- **Tag image previews** — cached sample images for any tag (10-minute TTL)

## Database Schema (V2)

### Core Tables

| Table | Purpose |
|-------|---------|
| `tags` | Canonical tag vocabulary: `name`, `category`, `post_count`, `is_deprecated`, `danbooru_id` |
| `aliases` | Synonym mappings: `alias → canonical` |
| `translations` | Multilingual names: `tag, lang, text` |
| `tags_fts` | FTS5 contentless trigram index (virtual table) |

### Version Tables (append-only event logs)

| Table | Purpose |
|-------|---------|
| `tag_versions` | Tag category/deprecation change events |
| `artist_versions` | Artist entry change events (name changes, bans, deletions) |

### Derived Data

| Table | Purpose |
|-------|---------|
| `related_tags` | Lazily cached related-tag results: `query_tag → related_tag` with cosine/jaccard/overlap scores |
| `meta` | Provenance watermarks: `structure_synced_through`, `full_count_synced_at`, `aliases_synced_through` |

### Watermarks (Provenance Clocks)

Three independent time-tracking columns enable incremental updates:

- `tags.post_count_synced_at` — per-tag: when this tag's post_count was last refreshed
- `meta.full_count_synced_at` — global: when the last full post_count refresh completed
- `meta.structure_synced_through` — event-time watermark for tag_versions/aliases incremental sync

## Distribution Model

### Prebuilt Dataset

The author publishes datasets as GitHub Release assets. Each release is described in `official_manifest.json` (committed to git or fetched from a remote URL):

```json
{
  "latest": "v2025.01.01",
  "datasets": [{
    "version": "v2025.01.01",
    "url": "https://github.com/.../releases/download/.../tagdb_v2025.01.01.zip",
    "sha256": "abc123...",
    "size_bytes": 314572800,
    "tag_count": 450000
  }]
}
```

The `distribution.py` module handles:
1. Loading the manifest (local git → remote URL fallback)
2. Streaming download in 1 MB chunks (cancellable)
3. SHA-256 verification
4. Unzipping (for `.zip` datasets)
5. Seeding the working DB from the verified `.sqlite`

### Translations DLC

An optional add-on dataset with Japanese, Chinese, and other language names. Downloaded and merged into the working DB via `ATTACH DATABASE` + `INSERT OR REPLACE`, then triggers an FTS index rebuild to include the new names.

### Official Update Check

`GET /xyz/tagdb/official/check` compares the installed official snapshot version against the manifest's `latest` version. The Tag DB Manager panel shows an "update available" banner when a newer dataset exists.

## Scraping (Opt-In)

The scraper uses `curl_cffi` (with `impersonate="chrome"`) to bypass Danbooru's Cloudflare JS challenge. This is the only external dependency (`curl_cffi>=0.7.0`).

### Why curl_cffi?

Danbooru blocks standard Python HTTP libraries (urllib, requests) based on TLS handshake fingerprint (JA3/JA4), not IP. `curl_cffi` reproduces Chrome's TLS + HTTP/2 fingerprint exactly, passing the challenge without a proxy.

### Scraping Capabilities

| Function | Endpoint | Pagination |
|----------|----------|------------|
| `scrape_tags(min_post_count)` | `/tags.json` | ID-cursor `page=a{id}` (bypasses 1000-page cap) |
| `scrape_tags_since(after_epoch)` | `/tags.json` | ID-cursor |
| `scrape_aliases()` / `scrape_aliases_since()` | `/tag_aliases.json` | Page-numbered |
| `scrape_tag_versions_since()` | `/tag_versions.json` | Page-numbered |
| `scrape_artist_versions_since()` | `/artist_versions.json` | Page-numbered |
| `fetch_related(query_tag, limit)` | `/related_tag.json` | Single request per tag |
| `fetch_artist_posts(name, limit)` | `/posts.json` | Single request |
| `scrape_wiki_other_names()` | Wiki pages | One page per tag |

Rate limit: 1.0 second delay between pages, up to 1000 items per page.

### Update Modes

**Full update** (`run_full_update`):
- Scrapes all tags with `post_count >= min_post_count`
- Scrapes all active aliases
- Batch upserts all data
- Stamps `post_count_synced_at = now` on every tag
- Sets watermarks to current time
- Optionally fetches translations and tag_versions event log

**Incremental update** (`run_incremental_update`):
- Reads `structure_synced_through` watermark
- Scrapes only tags and aliases created after that timestamp
- Applies structure-only updates (doesn't refresh post_count of existing tags)
- Advances watermark to the max event timestamp actually consumed
- Much faster than a full update (minutes vs hours)

## Frontend Integration

### Tag Autocomplete (`js/tagac.js`)

Hooks every multiline STRING textarea in ComfyUI:

- **Activation**: types into any prompt textarea → dropdown appears at caret
- **Debounced** 70ms input handling
- **LRU cache** of 300 recent queries
- **Category-colored** suggestions (inline DOM styling)
- **Related tags** shown below search results (configurable `relatedMaxAgeDays`)
- **Tag preview images** on hover (200-entry LRU cache)
- **PLv2 integration** — library prompts appear alongside tags in dropdown
- **Configurable** via settings panel (persisted to localStorage)

### Tag DB Manager Panel (`js/tagdb_panel.js`)

A self-contained floating window providing:

- **Credentials** — Danbooru login + API key management
- **Official dataset** — check version, download, install
- **Translations DLC** — check, download, merge
- **Manual maintenance** — launch full/incremental scrape with live log
- **Snapshot management** — list, activate, export
- **Staleness banner** — shows `full_count_age_days` from watermark data
- **Reconstruct** — build a historical vocabulary as of a given date

## HTTP API

All endpoints under `/xyz/tagdb/`:

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/search?q=&limit=` | Tag autocomplete (FTS5 → LIKE fallback) |
| GET | `/related?q=&limit=&max_age_days=` | Get/sync related tags |
| GET | `/artist_posts?name=&limit=` | Recent posts for an artist tag |
| GET | `/tag_preview?name=&limit=` | Cached tag preview images (10min TTL) |
| GET | `/preview_image?url=` | Proxy CDN images through backend |
| GET | `/snapshots` | List all snapshot databases |
| GET/POST | `/snapshots/active` | Get/set active snapshot |
| POST | `/snapshots/export` | Export working DB to local snapshot |
| GET/POST | `/settings` | Get/update Danbooru credentials |
| GET | `/official/check` | Check latest vs installed version |
| POST | `/official/download` | Download + install official dataset |
| GET/POST | `/translations/check` + `/translations/download` | Manage translations DLC |
| POST | `/maintain` | Start full or incremental scrape |
| GET | `/maintain/status` | Poll scrape progress |
| POST | `/maintain/cancel` | Cancel running maintenance |
| POST | `/reconstruct` | Build historical snapshot as-of a date |

## For Dataset Maintainers

The `build_dataset.py` module is a standalone CLI for building and publishing official datasets:

```bash
python -m tagdb.build_dataset --full --min-post-count 10 --with-versions --zip \
    --login myuser --api-key abc123
```

It produces a `.sqlite` file (optionally `.zip`), computes its SHA-256, and prints a ready-to-paste manifest entry. Credentials can also be read from `tagdb_data/settings.json`.

---

[中文版 (Chinese)](README_zh.md)
