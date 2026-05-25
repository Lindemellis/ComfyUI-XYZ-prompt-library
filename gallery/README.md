# Image Gallery

A full-featured image browser embedded in ComfyUI. Automatically indexes your output images, extracts ComfyUI metadata, generates thumbnails, and provides a rich filtering and browsing experience with real-time WebSocket updates.

## Architecture

```
gallery_data/
├── gallery.sqlite       ← Indexed image metadata (SQLite, WAL, 256 MiB mmap)
├── gallery_config.json  ← Root folders & preferences
└── thumbs/              ← Sharded .webp thumbnails (xx/hash.webp)
```

- **Single-writer** via `WriteQueue` (priority queue, HIGH/MID/LOW)
- **Short-lived reads** — every query opens a fresh `connect_read()`
- **SQLite WAL** — schema v1–v6, forward-only migrations
- **Vue 3 SPA frontend** served at `/xyz/gallery`
- **WebSocket hub** for cross-tab real-time sync

## Lifecycle

At ComfyUI startup, the gallery:

1. Creates the data directory layout (`gallery_data/thumbs/`)
2. Runs all pending SQLite migrations
3. Registers 69 HTTP endpoints under `/xyz/gallery/`
4. Seeds default root folders from ComfyUI's `output` and `input` directories
5. Rebuilds prompt vocabulary if the pipeline version changed
6. Launches a background cold scan of all root folders
7. Starts filesystem watchers (watchdog) and a periodic heartbeat scanner

## Core Features

### Image Indexing

Three scanning strategies work together:

| Strategy | When | What |
|----------|------|------|
| **Cold scan** | Startup | Full walk of each root folder |
| **Delta scan** | Heartbeat / manual rescan | Fingerprint comparison, index only changed files |
| **File watcher** | Real-time | Watchdog observers per root folder |

Fingerprinting is `(file_size, mtime_ns)` — warm restarts are nearly instant because unchanged files skip metadata extraction entirely.

Recognized extensions: `.png`, `.jpg`, `.jpeg`, `.webp`.

### Metadata Extraction

For every indexed image, the gallery reads ComfyUI PNG chunks:
- Positive prompt
- Negative prompt
- Model (with checkpoint extension stripped for canonical names)
- Seed, CFG scale, sampler, scheduler
- Full workflow JSON (extractable via API)

### Cursor-Paginated Browsing

`GET /xyz/gallery/images` supports rich filtering and sorting:

**Filters:**
- `folder_id` + `recursive` — browse a folder with or without subfolders
- `name` — filename substring search
- `favorite` — only favorited images
- `model` — exact model name
- `tag` — repeatable, images must have all specified tags
- `prompt` — repeatable, with `prompt_match_mode`:
  - `prompt` — normalized prompt token matching
  - `word` — F04 word lexeme matching (splits on whitespace/underscore/punctuation)
  - `string` — raw substring matching in prompt text
- `metadata_presence` — filter by whether metadata exists
- `date_after` / `date_before` — file modification time range

**Sorting:** by time (default), name, file size, or folder, ascending or descending.

**Pagination:** cursor-based (stable under concurrent insertions), configurable `limit`.

Each image result includes: `id`, `path`, `filename`, `ext`, `width`/`height`, `file_size`, `created_at`, metadata block, gallery fields (favorite, tags, sync_status), and pre-computed `thumb_url` / `raw_url`.

### Thumbnail System

- **On-demand generation**: first request triggers Pillow LANCZOS resize to 320×320 center-cover WebP (quality 78)
- **Content-addressed cache**: keyed by `SHA1(path + mtime_ns)` — auto-invalidates on file change
- **Sharded storage**: `thumbs/{hash[:2]}/{hash}.webp` avoids single-directory wall
- **Immutable caching**: `Cache-Control: public, max-age=31536000, immutable`
- **Inflight dedup**: concurrent requests for the same hash share a single generation
- **Touch coalescing**: `last_accessed` timestamps buffered and flushed every 10 seconds

### Tag Management

- Add/remove tags on single images or in bulk
- Normalized tag vocabulary (lowercased, deduplicated, 2-64 char tokens)
- Admin panel: list all tags, rename, delete from all images, purge zero-usage
- Autocomplete widget with tag usage counts

### Bulk Operations

All bulk operations follow a **two-phase** pattern:

1. **Preflight** — validates constraints, simulates name collisions, checks disk space, returns a `plan_id` (5-minute TTL)
2. **Execute** — applies the plan, broadcasts progress/completion via WebSocket

Supported bulk actions: **move**, **delete**, **set favorite**, **add/remove tags**.

### WebSocket Real-Time Sync

Event types broadcast to all connected SPA tabs:

| Event | Trigger |
|-------|---------|
| `image.upserted` | New image indexed |
| `image.updated` | Metadata changed (favorite, tags, moved) |
| `image.deleted` | Image removed |
| `folder.changed` | Folder tree modified |
| `index.progress` | Scan progress update |
| `vocab.changed` | Vocabulary rebuilt |
| `image.sync_status_changed` | Metadata write-back status change |
| `bulk.progress` / `bulk.completed` | Bulk operation lifecycle |
| `job.progress` / `job.completed` | Background job lifecycle |

The frontend WebSocket manager handles automatic reconnection (exponential backoff, 1s–30s cap) and re-syncs on window focus.

### Metadata Write-Back

An asynchronous background worker writes gallery metadata (`favorite`, `tags`) back into PNG chunks of the source files:

- Triggered by PATCH/bulk operations and periodic patrol over unsynchronized rows
- Up to 32 images per tick, 1-second polling interval
- Up to 3 retries with exponential backoff for failed writes
- Atomic staging writes to avoid corrupting PNGs
- Non-PNG files are hard-failed immediately

### Folder Management

- **Root folders**: `output` and `input` (built-in, non-removable), plus user-added `custom` roots
- Overlap prevention: new roots cannot equal, contain, or sit inside existing roots
- Subfolder operations: create, rename, move (cross-device support via copy+unlink), delete
- Open in OS file manager (platform-aware)
- Config persisted in human-editable `gallery_config.json`

### Frontend Views

- **Main grid** — sidebar filter panel + virtual-scrolled image grid
- **Compact view** — dense thumbnail cards
- **Line view** — section-grouped line items (by size bin, date, first letter, or folder)
- **Detail view** — single image with full metadata, workflow JSON download, tag editor
- **Settings overlay** — preferences (theme, download variant, filter visibility), tag admin

## HTTP API Summary

| Group | Endpoints |
|-------|-----------|
| **Folders** | GET tree, POST create, DELETE, PATCH rename, POST move, POST rescan, POST mkdir, POST open-in-OS, GET delete-preview |
| **Images** | GET list (cursor-paged), GET count, GET detail, GET neighbors, PATCH update, POST resync, POST move, DELETE |
| **Binary** | GET thumbnail, GET raw, GET raw/download (with `?variant=` options) |
| **Bulk** | POST resolve_selection, POST favorite/tags/move/preflight/execute, POST delete/preflight/execute |
| **Vocab** | GET tags, GET prompts, GET words, GET models |
| **Admin** | GET tags list, POST tag delete/rename/purge-zero |
| **Monitoring** | GET index/status, GET jobs/active |
| **Preferences** | GET, PATCH |
| **WebSocket** | GET /ws upgrade |

All mutation endpoints follow the WriteQueue pattern. Error responses use a consistent `{"error": {"code": ..., "message": ..., "details": ...}}` envelope.

## Configuration

```json
// gallery_data/gallery_config.json (human-editable)
{
  "roots": [
    {"path": "ComfyUI/output", "kind": "output"},
    {"path": "ComfyUI/input", "kind": "input"},
    {"path": "/my/custom/folder", "kind": "custom"}
  ],
  "download_variant": "full",
  "theme": "dark",
  "developer_mode": false,
  ...
}
```

Preferences are also editable via the `/xyz/gallery/preferences` API and the Settings UI.

---

[中文版 (Chinese)](README_zh.md)
