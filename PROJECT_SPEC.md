# XYZ Image Gallery — PROJECT_SPEC

> A standalone image gallery sub-module living inside the existing
> `ComfyUI-XYZNodes` plugin. It shares the package, the web directory and the
> aiohttp routing surface of the host plugin, but is otherwise independent of
> the existing nodes.

> **Document layering（只增不改旧文）**：MVP（v1.0）正文保持有效；**v1.1** 增量以 §11 *v1.1 Overrides* 为准；**v1.2** 增量以 §12 *v1.2 Overrides* 为准。若与较早章节字面冲突，以**较新**覆盖节为**覆盖**说明，旧句视为 **deprecated** 并在对应覆盖节中指明。

---

## 1. Overview

The XYZ Image Gallery is a ComfyUI plugin that turns local image folders
(default `output/` and `input/`, plus user-defined custom folders) into a fast,
filterable, taggable gallery.

* **Entry point**: a button in the ComfyUI top-bar.
* **Surface**: clicking the button opens a **new browser tab** at
  `/xyz/gallery` served by ComfyUI's aiohttp server. The gallery is a full
  single-page application; it does **not** render inside the LiteGraph canvas.
* **Scale target**: smooth UX with **2 000 – 50 000 images**, where each image
  is **≥ 1024 × 1024** (typical SDXL/Flux outputs of 2 – 10 MB).
* **Persistence**: a SQLite-backed index plus an on-disk thumbnail cache live
  inside the plugin folder, so the gallery never re-scans every image at
  startup.
* **Live**: filesystem changes (new generations, renames, deletions, manual
  moves) are reflected without manual refresh.

---

## 2. Functional Requirements

### 2.1 Top-bar entry

* FR-1 Register a top-bar button in ComfyUI labelled **"Gallery"** with an
  icon. Clicking it opens `/xyz/gallery` in a new tab.
* FR-2 The gallery page is fully usable without an active ComfyUI workflow.

### 2.2 Main view — left sidebar

#### 2.2.1 Filter panel (collapsible, top of sidebar)

Vertical stack of controls; collapse state is persisted per browser.

| ID    | Control                | Behaviour                                                                                                                                                                                                                                                                  |
| ----- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-3a | **Name filter**        | Label `name filter:` + text input. Case-insensitive **literal substring** on lowercased basename (`filename_lc`): non-empty trimmed query → SQL ``instr(filename_lc, needle) > 0`` (so ``_`` and ``%`` in the query are **not** ``LIKE`` wildcards). Applies to **all** lengths (1+). Debounced (250 ms). (*Updated 2026-04-25* — substring semantics; *Updated 2026-04-25b* — ``instr`` for literal ``_`` / ``%``.)                                                                                                                                                                   |
| FR-3b | **Positive prompt**    | Label `positive prompt filter:` + text input. Comma-separated tokens; matches images whose positive prompt contains **all** tokens (AND semantics). While typing the **current** token, show top-20 autocomplete suggestions sourced from the indexed prompt vocabulary. Click a suggestion to complete the current token. |
| FR-3c | **Tag filter**         | Same UX as FR-3b but matches against the gallery-managed `tags` field. Suggestions sourced from the tag vocabulary.                                                                                                                                                        |
| FR-3d | **Favorite filter**    | Label `favorite filter:` + dropdown: `all` / `favorite` / `not favorite`.                                                                                                                                                                                                  |
| FR-3e | **Model filter**       | Label `model filter:` + dropdown: `all` + every distinct model name in the index.                                                                                                                                                                                          |
| FR-3f | **Date filter**        | Label `date filter:` + `before` toggle button + date picker + `after` toggle button + date picker. Each toggle independently enables its bound. Filter is applied to **image creation date** from metadata, falling back to file mtime.                                     |

* FR-4 All filters compose with AND semantics. The filter state is
  reflected in the URL query string (sharable / bookmarkable).

* **Reset control** (*Updated due to runtime implementation / QA feedback*): A **Reset** action restores filter fields (name / prompt / tag / favorite / model / dates / metadata presence / prompt match mode) and **SortSpec** to defaults **without** changing the selected **`folder_id`** or the **recursive** toggle — folder tree context is preserved.

* **Resizable sidebar chrome** (*Updated due to runtime implementation / QA feedback*): The user may adjust **sidebar width** and the **vertical split** between the filter block and the folder tree; dimensions are persisted in browser **`localStorage`** under namespaced keys (`xyz_gallery.*`). The filter control stack scrolls inside its pane when content exceeds the allocated height.

#### 2.2.2 Folder panel (below filters)

* FR-5 Tree view of folders and sub-folders.
* FR-6 Default roots: ComfyUI `output/` and `input/`. These are
  **non-removable**.
* FR-7 Toolbar with two buttons:
  * **Recursive toggle** — choose between *only the selected folder* and
    *the selected folder + all descendants*.
  * **Manage custom folders** — opens a modal where the user can:
    * add a new custom root folder (absolute path with validation),
    * remove an existing custom root (`output` and `input` excluded).
* FR-8 Folder selection narrows the working set; combined with the filter
  panel via AND.

### 2.3 Main view — center

#### 2.3.1 Top toolbar

| ID     | Control                                                                                                                                                                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-9a  | Slider controlling the **number of thumbnails per row** (e.g. 2 – 12).                                                                                                                                                                               |
| FR-9b  | Sort dropdown: `name`, `time`, `size`, `folder`; each with ascending / descending toggle.                                                                                                                                                            |
| FR-9c  | Layout switch: **compact grid** ⇄ **timeline**. Timeline groups thumbnails into vertical buckets driven by the active sort key (date buckets for `time`, alphabet buckets for `name`, size buckets for `size`, folder buckets for `folder`).         |
| FR-9d  | **Bulk-edit** toggle. See 2.3.2.                                                                                                                                                                                                                     |

#### 2.3.2 Bulk edit mode

When enabled, each thumbnail gains a checkbox. Additional buttons appear:

* FR-10a `Select all in current view` / `Clear selection`. *Current view* =
  current `folder + filter` result, **not** just the visually rendered slice.
* FR-10b Bulk **favorite / un-favorite**.
* FR-10c Bulk **add tags / remove tags**. The tag input must support the same
  autocomplete UX as FR-3c.
* FR-10d Bulk **move**. Opens a folder-picker modal. On collision the system
  follows FR-19 (rename loop with confirmation).

#### 2.3.3 Thumbnail grid

* FR-11 All thumbnails share the same display size and aspect ratio
  (`object-fit: cover`).
* FR-12 Filename rendered below the thumbnail (truncated with tooltip).
* FR-13 Top-right corner: **favorite** toggle button reflecting current state;
  click toggles without leaving the grid.
* FR-14 **Right-click** context menu: `Move…`, `Delete…`.
* FR-15 **Left-click** opens the **detail page** for that image, preserving
  the current `folder + filter + sort` context.

### 2.4 Detail page

* FR-16 Layout: 2-pane.
  * **Left**: original image with zoom in/out, fit-to-screen, 1:1, pan.
    Two buttons step to the **previous / next** image **within the current
    `folder + filter + sort` set**, wrapping at the ends.
  * **Right**: metadata pane.
* FR-17 Read-only metadata fields (sourced from PNG/EXIF/ComfyUI workflow
  payload):
  * size (`width × height`)
  * creation date
  * positive prompt — with **copy to clipboard** button
  * negative prompt — with **copy to clipboard** button
  * model
  * seed — with **copy to clipboard** button
  * cfg
  * sampler
  * scheduler
* FR-18 Editable, gallery-owned fields:
  * `tags` (with autocomplete identical to FR-3c)
  * `favorite` (toggle)
* FR-19 Action buttons:
  * **Download image** (original file)
  * **Download workflow** (`.json` extracted from PNG metadata, disabled if
    none)
  * **Back** to main view (restores prior scroll position and selection)
  * **Delete** (with confirmation modal — see FR-21). Deletion sends the
    user back to the main view.

### 2.5 Cross-cutting behaviour

* FR-20 **Auto-update**: any change in a watched folder (new file, deletion,
  rename, mtime change) is reflected in the gallery within ≤ 2 s, without
  user-initiated refresh, via WebSocket push from backend to frontend.
* FR-21 **Delete confirmation**: every delete (single or bulk) shows a modal
  requiring explicit confirmation. The modal lists the file count and total
  size.
* FR-22 **Move collision**: if any source filename collides with an existing
  file in the destination folder, the system proposes a renamed version
  (`<stem> (1).<ext>`, then `(2)`, …) and shows a confirmation step. The
  loop continues until **every** moved file has a unique name in the target,
  then performs the move atomically.
* FR-23 The gallery **reads** ComfyUI-written metadata (positive/negative
  prompt, model, seed, cfg, sampler, scheduler, workflow) from PNG `tEXt` /
  `iTXt` chunks. The gallery **writes** only its own `tags` and `favorite`
  fields, into a dedicated PNG chunk (key prefix `xyz_gallery.`), so it
  never corrupts the original ComfyUI metadata.
* FR-24 Gallery-owned fields are **also** mirrored into the SQLite index, so
  losing a single PNG chunk never loses gallery state, and so all queries
  hit the index, not the filesystem.

---

## 3. Non-Functional Requirements

### 3.1 Performance

* NFR-1 **Cold start of ComfyUI** must not be blocked by the gallery. The
  scanner runs in a background thread; ComfyUI's main loop is never blocked
  for more than ~50 ms by gallery startup work.
* NFR-2 **Cold start of the gallery page**: < 1 s to interactive on a
  20 000-image library; thumbnails appear progressively.
* NFR-3 **Filter / sort latency** on the index: P95 < 100 ms for 50 000
  images on a single SSD.
* NFR-4 **Autocomplete latency**: P95 < 30 ms per keystroke, even with
  ≥ 50 000 distinct tokens in the vocabulary.
* NFR-5 **Scroll**: 60 fps during virtual scroll on an integrated GPU;
  thumbnails decoded asynchronously.
* NFR-6 **Memory ceiling** (frontend): the DOM never holds more than ~3×
  the visible viewport's worth of thumbnail nodes (virtual scrolling).
* NFR-7 **Memory ceiling** (backend): peak resident size of the indexer ≤
  300 MB regardless of library size; thumbnails are streamed, never loaded
  in bulk.

### 3.2 Scalability

* NFR-8 Linear scan cost only on first index of a folder; subsequent
  startups perform a delta scan (compare cached `(path, mtime, size)` →
  re-index only changed entries).
* NFR-9 Watcher-based incremental updates: each filesystem event costs
  O(1) DB writes plus one thumbnail render.
* NFR-10 The architecture must remain functional up to **100 000** images
  without code changes (only longer first-time indexing).

### 3.3 Robustness

* NFR-11 Index and thumbnail cache are **rebuildable**: deleting them
  (manually or via a "rebuild" button) must restore correct behaviour
  with no data loss for user-managed fields, because user-managed fields
  are mirrored into PNG chunks (FR-23/24).
* NFR-12 All write operations to images are atomic (write-temp + rename).
* NFR-13 All destructive UI operations require confirmation (FR-21).
* NFR-14 Concurrent multi-tab usage: writes are serialised through the
  backend; the WebSocket fan-out keeps every tab consistent.

### 3.4 Compatibility

* NFR-15 Backend: Python ≥ 3.10, aiohttp (already used by ComfyUI), Pillow,
  watchdog, sqlite3 (stdlib).
* NFR-16 Frontend: evergreen browsers (Chromium ≥ 110, Firefox ≥ 110,
  Safari ≥ 16). No build step required for the user; bundled assets are
  shipped pre-built in `js/gallery_dist/`.
* NFR-17 Cross-platform: Windows, macOS, Linux. Path handling must be
  `pathlib`-based; folder paths stored as POSIX strings in the index.

### 3.5 Security & privacy

* NFR-18 The HTTP API is bound to whatever interface ComfyUI itself binds.
  No new ports are opened.
* NFR-19 Custom folder paths must be validated to be **readable
  directories**. Folder operations (move, delete) are restricted to paths
  inside one of the registered roots — never arbitrary FS access via the
  API.

* **NFR-20** **UI update stability** (*Updated due to v1.2*): The main grid
  and detail surfaces must **not** flash or reset scroll position on
  **per-row** metadata edits driven by WebSocket `image.updated` / local PATCH
  success; full list replacement is reserved for **query-set changes** (filter
  / sort / debounced OS upsert that introduces **new ids** not representable
  by row merge). See `ARCHITECTURE` §7.2–7.4.
* **NFR-21** **Batch operation visibility** (*Updated due to v1.2 / T44 spec*): Any
  user-initiated operation that mutates **more than one** indexed image in a
  **single** user action (or one HTTP execute), **and** any **long-running server job**
  that the gallery must surface (including **OS-side** bulk changes discovered
  after the user opens the page — see §12.4 **FR-Prog-5**), must use the **unified
  long-running job** contract and surface progress and completion in the client
  (see `PROJECT_SPEC` §12.4), without adding a second write path beside
  `repo.WriteQueue` + `ws_hub`.

---

## 4. System Architecture

### 4.1 High-level diagram

```
                    ┌──────────────────────────────────────────────┐
                    │            ComfyUI process                   │
                    │                                              │
   Top-bar button ──┼──► aiohttp (PromptServer.instance.routes)    │
   /xyz/gallery     │           │                                  │
                    │           ▼                                  │
                    │   ┌───────────────┐    ┌───────────────────┐ │
                    │   │ Gallery API   │◄──►│  Index (SQLite)   │ │
                    │   │  (routes.py)  │    │  + FTS5 virtual   │ │
                    │   └───────┬───────┘    │  + inverted maps  │ │
                    │           │            └───────────────────┘ │
                    │           ▼                                  │
                    │   ┌───────────────┐    ┌───────────────────┐ │
                    │   │ Indexer +     │◄──►│  Thumbnail cache  │ │
                    │   │ Watcher (BG)  │    │   (.webp on disk) │ │
                    │   └───────┬───────┘    └───────────────────┘ │
                    │           │                                  │
                    │           ▼                                  │
                    │   ┌───────────────┐                          │
                    │   │ WebSocket hub │──► live updates to tabs  │
                    │   └───────────────┘                          │
                    └──────────────────────────────────────────────┘
                                ▲
                                │ HTTP + WS
                                ▼
                    ┌──────────────────────────────────────────────┐
                    │              Browser (new tab)               │
                    │   SPA: virtual-scroll grid, detail view,     │
                    │        filter/sort/bulk-edit, autocomplete.  │
                    └──────────────────────────────────────────────┘
```

### 4.2 Backend modules (Python)

All under `ComfyUI-XYZNodes/gallery/`:

| Module                | Responsibility                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| `__init__.py`         | Wires the gallery into the host plugin: registers routes, starts background services on first import.         |
| `routes.py`           | All `/xyz/gallery/...` aiohttp handlers; pure I/O, no business logic.                                         |
| `service.py`          | Use-case layer: list/filter/move/delete/tag/favorite. Coordinates `repo`, `indexer`, `thumbs`, `ws_hub`.      |
| `repo.py`             | SQLite repository (CRUD + complex queries). Owns the connection pool and prepared statements.                 |
| `db.py`               | Schema, migrations, FTS5 setup, pragmas (`journal_mode=WAL`, `synchronous=NORMAL`).                           |
| `indexer.py`          | Initial scan + delta scan + per-event indexing. Extracts ComfyUI metadata via `metadata.py`.                  |
| `metadata.py`         | PNG chunk reader/writer for both ComfyUI fields (read-only) and gallery fields (R/W). Pure functions.         |
| `thumbs.py`           | Thumbnail generator (Pillow); on-demand + lazy + LRU eviction; output format WebP, 320×320 cover.             |
| `watcher.py`          | `watchdog` observers per registered root; debounced event coalescing; pushes to indexer queue.                |
| `ws_hub.py`           | WebSocket fan-out for live updates (`image.upserted`, `image.deleted`, `folder.changed`, `index.progress`).   |
| `folders.py`          | Manages root folder registry (`output`, `input`, custom). Persists to `gallery_config.json`.                  |
| `paths.py`            | Path validation + sandboxing (every path must resolve under a registered root).                               |
| `vocab.py`            | Tag / prompt-token vocabulary maintenance (counts, autocomplete queries).                                     |

### 4.3 Frontend modules (JavaScript)

Under `ComfyUI-XYZNodes/js/`:

| Module                                | Responsibility                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `gallery_topbar.js`                   | Loaded by ComfyUI (`WEB_DIRECTORY`). Adds the top-bar button via `app.registerExtension`.               |
| `gallery_dist/` (pre-bundled)         | The SPA assets shipped with the plugin: HTML shell, CSS, ESM modules. Served by `routes.py`.            |
| `gallery_dist/app.js` (entry)         | Bootstraps the SPA, mounts the router (`/`, `/image/:id`).                                              |
| `gallery_dist/views/MainView.*`       | Sidebar + grid + toolbar.                                                                               |
| `gallery_dist/views/DetailView.*`     | Detail page.                                                                                            |
| `gallery_dist/components/...`         | `VirtualGrid`, `ThumbCard`, `Autocomplete`, `FolderTree`, `BulkBar`, `ConfirmModal`, `MovePicker`, etc. |
| `gallery_dist/stores/...`             | Reactive state: `filters`, `selection`, `folders`, `vocab`, `connection`.                               |
| `gallery_dist/api.js`                 | Thin REST + WS client.                                                                                  |

### 4.4 Process & data flow

1. **Plugin import**: `__init__.py` imports `gallery`. `gallery.__init__`
   ensures the SQLite file exists, runs migrations, starts the indexer
   thread, mounts watchers on the registered roots, and registers HTTP
   routes.
2. **Top-bar button**: `gallery_topbar.js` is auto-loaded by ComfyUI; on
   click → `window.open('/xyz/gallery')`.
3. **Gallery page**: `routes.py` serves `gallery_dist/index.html`. The SPA
   opens a WS connection to `/xyz/gallery/ws` and issues `GET
   /xyz/gallery/images?...` for the first page.
4. **Live updates**: watcher event → debounced queue → `indexer` → SQLite
   write → `ws_hub.broadcast(...)` → frontend store patches local state.

---

## 5. Key Design Constraints (MUST follow)

* **C-1 Single source of truth = SQLite index.** All UI queries (filter,
  sort, count, paginate, autocomplete) hit the index, **never** the
  filesystem. Filesystem reads happen only inside `indexer`, `thumbs`,
  `metadata`, and binary endpoints.
* **C-2 No blocking work on the ComfyUI event loop.** All scanning,
  hashing, thumbnailing, and PNG metadata writing run in a dedicated
  worker thread / process pool. aiohttp handlers `await`
  `loop.run_in_executor(...)` for any CPU-bound or disk-bound call > 5 ms.
* **C-3 Idempotent indexing.** Re-running the indexer on an unchanged
  folder must be a no-op (detected via `(size, mtime_ns)` fingerprint
  before any expensive work).
* **C-4 Schema migrations are forward-only and versioned** in `db.py`.
  Never break an existing user's index without an automated migration.
* **C-5 Sandbox every path.** Any path coming from the client must be
  resolved (`Path.resolve()`) and verified to be inside a registered
  root before any read/write. Reject otherwise with HTTP 400.
* **C-6 Original ComfyUI metadata is read-only.** The gallery may add
  new chunks (`xyz_gallery.tags`, `xyz_gallery.favorite`) but must
  never modify or drop pre-existing ComfyUI chunks (`prompt`,
  `workflow`, `parameters`, …).
* **C-7 No new ports, no external network calls.** Everything is served
  on ComfyUI's existing aiohttp server. Thumbnails and originals are
  served by the gallery itself; the SPA never reaches outside.
* **C-8 Decoupled from existing nodes.** The gallery package depends on
  ComfyUI core (`server.PromptServer`, `folder_paths`) but **not** on
  any module under `ComfyUI-XYZNodes` other than its own subtree.
  Removing/renaming an existing node must not affect the gallery.
* **C-9 Frontend ships pre-built.** Users do not run `npm install`. The
  build artefact lives in `js/gallery_dist/` and is committed to the
  repo. Any framework choice must respect this (CDN ESM or pre-bundled).
* **C-10 Config is human-readable JSON.** `gallery_config.json` (roots,
  user preferences) lives next to the SQLite file and is editable by
  hand for recovery.
* **C-11 All destructive operations (delete, move with overwrite) are
  confirmed by an explicit user action and logged** to a rolling
  `gallery_audit.log` (last 30 days).
* **C-12 The DB and thumbnail cache live inside the plugin folder**, not
  in `output/`, so syncing or wiping ComfyUI's outputs never corrupts
  gallery state.

---

## 6. Data Model

### 6.1 SQLite schema (logical)

> Types use SQLite affinities; see `db.py` for the canonical DDL.

#### `image` — one row per indexed image

| Column                      | Type      | Notes                                                                                                     |
| --------------------------- | --------- | --------------------------------------------------------------------------------------------------------- |
| `id`                        | INTEGER PK | auto-increment surrogate                                                                                 |
| `path`                      | TEXT UNIQUE NOT NULL | absolute POSIX path                                                                            |
| `folder_id`                 | INTEGER FK → `folder.id` | the immediate registered root the file belongs to (for fast root scoping)                  |
| `relative_path`             | TEXT NOT NULL | path relative to the registered root, used for display & sub-folder scoping                           |
| `filename`                  | TEXT NOT NULL | basename, lower-cased duplicate stored in `filename_lc` for case-insensitive search                   |
| `filename_lc`               | TEXT NOT NULL | lower-cased filename for indexed substring search                                                     |
| `ext`                       | TEXT NOT NULL | e.g. `png`, `jpg`, `webp`                                                                             |
| `width` / `height`          | INTEGER   |                                                                                                          |
| `file_size`                 | INTEGER   | bytes                                                                                                    |
| `mtime_ns`                  | INTEGER   | filesystem mtime (ns); used for delta scan                                                               |
| `created_at`                | INTEGER   | seconds-epoch; preferred = ComfyUI metadata creation date, fallback = ctime                              |
| `content_hash`              | TEXT      | optional `xxhash64` of file body, for dedup detection (computed lazily)                                  |
| **ComfyUI metadata (read-only)** |       |                                                                                                          |
| `positive_prompt`           | TEXT      |                                                                                                          |
| `negative_prompt`           | TEXT      |                                                                                                          |
| `model`                     | TEXT      | indexed                                                                                                  |
| `seed`                      | INTEGER   |                                                                                                          |
| `cfg`                       | REAL      |                                                                                                          |
| `sampler`                   | TEXT      |                                                                                                          |
| `scheduler`                 | TEXT      |                                                                                                          |
| `workflow_present`          | INTEGER   | 0/1; the workflow JSON itself is **not** copied into the DB, only flagged                                |
| **Gallery-owned**           |           |                                                                                                          |
| `favorite`                  | INTEGER   | 0/1, indexed                                                                                             |
| `tags_csv`                  | TEXT      | denormalised CSV for quick read; canonical store is the `image_tag` join table                           |
| `indexed_at`                | INTEGER   | epoch                                                                                                    |

Indexes:
* `UNIQUE(path)`
* `INDEX(folder_id, relative_path)`
* `INDEX(filename_lc)`
* `INDEX(model)`
* `INDEX(favorite)`
* `INDEX(created_at)`
* `INDEX(file_size)`
* `INDEX(mtime_ns)`

#### `folder` — registered roots and discovered sub-folders

| Column         | Type    | Notes                                                          |
| -------------- | ------- | -------------------------------------------------------------- |
| `id`           | PK      |                                                                |
| `path`        | TEXT UNIQUE | absolute POSIX                                              |
| `kind`        | TEXT    | `output` / `input` / `custom`                                  |
| `parent_id`   | INTEGER FK → `folder.id` NULL | NULL = registered root                       |
| `display_name` | TEXT   |                                                                |
| `removable`   | INTEGER | 0 for `output`/`input`, 1 for custom                           |

#### `tag` — gallery tag vocabulary

| Column        | Type    | Notes                                  |
| ------------- | ------- | -------------------------------------- |
| `id`          | PK      |                                        |
| `name`        | TEXT UNIQUE NOT NULL |                           |
| `usage_count` | INTEGER | maintained on insert/delete in `image_tag` |

#### `image_tag` — many-to-many

| Column    | Type    | Notes |
| --------- | ------- | ----- |
| `image_id`| FK      |       |
| `tag_id`  | FK      |       |
| PK = `(image_id, tag_id)`; `INDEX(tag_id, image_id)` for inverted queries.

#### `prompt_token` — positive-prompt vocabulary

| Column      | Type    | Notes                                                                  |
| ----------- | ------- | ---------------------------------------------------------------------- |
| `id`        | PK      |                                                                        |
| `token`     | TEXT UNIQUE | output of the **Prompt Normalization Pipeline** (see §8.8): lower-cased, weight-stripped, LoRA-stripped, punctuation-cleaned, whitespace-collapsed |
| `usage_count` | INTEGER |                                                                      |

> **Critical invariant.** Raw prompt strings are **never** tokenised by a
> bare `split(',')`. Every token written to `prompt_token` /
> `image_prompt_token` must come out of `vocab.normalize_prompt(text)`
> (§8.8). This keeps the vocabulary bounded (typically ≤ 5 000 distinct
> tokens for a 100 000-image library, vs. > 1 M for a naive split) and
> keeps autocomplete meaningful.

#### `image_prompt_token` — many-to-many (for prompt-token AND-filter)

| Column      | Type    |
| ----------- | ------- |
| `image_id`  | FK      |
| `token_id`  | FK      |
PK + `INDEX(token_id, image_id)`.

#### `image_fts` — FTS5 virtual table

```
fts5(filename, positive_prompt, negative_prompt, tags, content='image', tokenize='unicode61 remove_diacritics 2')
```
Synced via triggers on `image` insert/update/delete. Used for:
* substring acceleration when name filter has ≥ 3 chars,
* fallback fuzzy search if the deterministic AND-filters return nothing.

#### `thumbnail_cache` — authoritative LRU index for the on-disk thumbnail folder

The filesystem alone cannot answer "which thumbnail is the oldest?" cheaply
once we have ≥ 100 000 entries — `os.scandir` over 100 k+ shards plus per-file
`stat()` is multi-second on cold cache. Cache bookkeeping therefore lives in
SQLite, and the on-disk `.webp` files are treated as a *materialisation* of
the rows in this table.

| Column          | Type    | Notes                                                                |
| --------------- | ------- | -------------------------------------------------------------------- |
| `hash_key`      | TEXT PK | `sha1(path + mtime_ns)`; matches the on-disk filename stem           |
| `image_id`      | INTEGER FK → `image.id` ON DELETE CASCADE | back-ref for orphan cleanup            |
| `size_bytes`    | INTEGER NOT NULL | physical size of the cached `.webp` on disk                 |
| `created_at`    | INTEGER NOT NULL | epoch seconds; when the thumb was first generated           |
| `last_accessed` | INTEGER NOT NULL | epoch seconds; **monotonically updated on every HTTP hit**  |

Indexes:
* `INDEX(last_accessed)` — drives LRU eviction
* `INDEX(image_id)` — drives orphan cleanup when an image row is deleted

Eviction policy (see §8.3): when `SUM(size_bytes)` exceeds the configured
budget (default 2 GB), evict rows in `ORDER BY last_accessed ASC` until the
total is back under 80 % of the budget, deleting the corresponding `.webp`
files in the same transaction. A periodic janitor (every 5 min, low priority)
also reconciles disk vs. DB to recover from crash-induced drift.

### 6.2 Domain DTOs (used across the API)

```text
ImageRecord {
    id: int
    path: str
    folder: { id, kind, display_name, relative_dir }
    filename: str
    ext: str
    size: { width, height, bytes }
    created_at: ISO-8601
    metadata: {
        positive_prompt: str | null
        positive_prompt_normalized: str | null  // comma+space-joined tokens (normalize_prompt + prompt_stopwords, same as T30/indexer); V1.1-F12 (*Updated due to runtime implementation / QA feedback*)
        negative_prompt: str | null
        model: str | null
        seed: int | null
        cfg: float | null
        sampler: str | null
        scheduler: str | null
        has_workflow: bool
    }
    gallery: {
        favorite: bool
        tags: [str]
    }
    thumb_url: str   // /xyz/gallery/thumb/{id}?v={mtime_ns}
    raw_url:   str   // /xyz/gallery/raw/{id}
}

FolderNode {
    id, path, kind, display_name, removable,
    children: [FolderNode],
    image_count_self: int,
    image_count_recursive: int
}

FilterSpec {
    name: str | null
    positive_tokens: [str]   // raw user input; backend re-runs them
                             //   through normalize_prompt() (§8.8) before
                             //   resolving to token_ids.
    tag_tokens: [str]        // same: normalised on the server.
    favorite: 'all' | 'yes' | 'no'
    model: str | null
    date_after: ISO-date | null
    date_before: ISO-date | null
    folder_id: int | null
    recursive: bool
}

SortSpec {
    key: 'name' | 'time' | 'size' | 'folder'
    dir: 'asc' | 'desc'
}

PageCursor {
    last_sort_key_value: any
    last_id: int           // tie-breaker for stable order
}

// Bulk-selection envelope. Used by every /bulk/* endpoint.
//
// Two modes:
//   1. Explicit mode  → mode = "explicit", ids = [int...]
//      Used when the user has hand-picked a small set of cards.
//   2. Inverted mode  → mode = "all_except",
//                       filters = <FilterSpec snapshot>,
//                       excluded_ids = [int...]
//      Used when the user clicked "Select all in current view": the
//      frontend stores ONE boolean + a (typically tiny) exclusion set
//      instead of materialising 100 000 ids in memory or on the wire.
//
// The backend resolves "all_except" to a server-side subquery — it
// NEVER expands to a list of ids in Python.
Selection {
    mode: 'explicit' | 'all_except'
    ids?: [int]                  // present when mode = 'explicit'
    filters?: FilterSpec         // present when mode = 'all_except'
    excluded_ids?: [int]         // present when mode = 'all_except'
}
```

### 6.3 On-disk layout

```
ComfyUI-XYZNodes/
├── PROJECT_SPEC.md
├── gallery/                          # backend package
│   └── ...
├── js/
│   ├── gallery_topbar.js             # top-bar entry
│   └── gallery_dist/                 # pre-built SPA
│       ├── index.html
│       ├── app.js
│       └── ...
└── gallery_data/                     # created at runtime (git-ignored)
    ├── gallery.sqlite                # index DB (WAL files alongside)
    ├── gallery_config.json           # roots + prefs
    ├── gallery_audit.log
    └── thumbs/
        └── ab/abc123def....webp      # 2-char shard prefix to keep dirs small
```

---

## 7. API Design

All endpoints are mounted under the existing aiohttp instance via
`PromptServer.instance.routes`, with prefix `/xyz/gallery`. JSON
request/response unless noted.

### 7.1 Page & assets

| Method | Path                          | Purpose                                                |
| ------ | ----------------------------- | ------------------------------------------------------ |
| GET    | `/xyz/gallery`                | Serves SPA `index.html`.                               |
| GET    | `/xyz/gallery/static/*`       | Serves `js/gallery_dist/*` (cache-busted by hash).     |

### 7.2 Folders

| Method | Path                                  | Body / Query                       | Returns                                |
| ------ | ------------------------------------- | ---------------------------------- | -------------------------------------- |
| GET    | `/xyz/gallery/folders`                | `?include_counts=true`             | tree of `FolderNode`                   |
| POST   | `/xyz/gallery/folders`                | `{ "path": str }`                  | new `FolderNode` (kind=`custom`)       |
| DELETE | `/xyz/gallery/folders/{id}`           |                                    | 204; rejects `output`/`input`          |
| POST   | `/xyz/gallery/folders/{id}/rescan`    |                                    | `{ "scheduled": true }`                |

### 7.3 Images — listing & detail

| Method | Path                                  | Notes                                                                                              |
| ------ | ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| GET    | `/xyz/gallery/images`                 | Query: `FilterSpec` flattened + `SortSpec` + `cursor` + `limit` (default 200). Returns `{ items: [ImageRecord], next_cursor, total_estimate }`. Cursor-based for stable scrolling. |
| GET    | `/xyz/gallery/images/count`           | Same query → `{ "total": int }`. Used by virtual scroll height estimate when needed.               |
| GET    | `/xyz/gallery/image/{id}`             | Full `ImageRecord`.                                                                                |
| GET    | `/xyz/gallery/image/{id}/neighbors`   | Query: same `FilterSpec`+`SortSpec` → `{ prev_id, next_id }`. Powers the detail-page nav buttons.  |

### 7.4 Images — binary

| Method | Path                                    | Notes                                                                            |
| ------ | --------------------------------------- | -------------------------------------------------------------------------------- |
| GET    | `/xyz/gallery/thumb/{id}?v={mtime_ns}`  | Returns the cached WebP thumbnail; generates on-demand if absent. `Cache-Control: public, max-age=31536000, immutable` (key includes `mtime_ns`). |
| GET    | `/xyz/gallery/raw/{id}`                 | Streams the original file. Supports HTTP `Range`. `Content-Disposition: inline`. |
| GET    | `/xyz/gallery/raw/{id}/download`        | Same content; `Content-Disposition: attachment`.                                 |
| GET    | `/xyz/gallery/image/{id}/workflow.json` | Extracted workflow; 404 if absent.                                               |

> **Updated due to runtime implementation / QA feedback**: `GET /raw/{id}/download` accepts **`?variant=full|no_workflow|clean`**; when omitted, effective variant follows **`gallery_config.json`** / **`GET|PATCH /preferences`** (`download_variant`). Re-encoded responses apply **`metadata.build_png_download_bytes`** for `no_workflow` / `clean`: **`clean`** strips **`workflow`**, API **`prompt`**, A1111 **`parameters`**, and all **`xyz_gallery.*`** text chunks (pixels unchanged).

### 7.5 Mutations — single image

| Method | Path                                          | Body                                            | Notes |
| ------ | --------------------------------------------- | ----------------------------------------------- | ----- |
| PATCH  | `/xyz/gallery/image/{id}`                     | `{ "favorite"?: bool, "tags"?: [str] }`         | Updates DB **and** PNG chunks atomically. |
| DELETE | `/xyz/gallery/image/{id}`                     | `{ "confirm": true }`                           | Hard delete from disk and index.          |
| POST   | `/xyz/gallery/image/{id}/move`                | `{ "target_folder_id": int, "rename"?: str }`  | If `rename` is omitted and a collision exists, returns `409` with a suggested name; client retries with `rename`. |

### 7.6 Mutations — bulk

> **Selection model.** Every bulk endpoint accepts the polymorphic
> `Selection` envelope (§6.2). For `mode = "all_except"` the backend
> resolves the target rowset with a single subquery (the same subquery
> the listing endpoint would use, minus pagination) and applies
> `WHERE id NOT IN (excluded_ids)`. The frontend therefore never
> serialises a 100 000-id array over HTTP.

| Method | Path                                  | Body                                                                                                | Notes |
| ------ | ------------------------------------- | --------------------------------------------------------------------------------------------------- | ----- |
| POST   | `/xyz/gallery/bulk/favorite`          | `{ "selection": Selection, "value": bool }`                                                         | Single transaction; emits one `vocab.changed` (no-op) + one summary `image.updated` per affected id. |
| POST   | `/xyz/gallery/bulk/tags`              | `{ "selection": Selection, "add": [str], "remove": [str] }`                                         | Tags are normalised the same way as prompt tokens (§8.8) before write. *（**v1.2 patch / 2026-04-24** — `normalize_tag()`：仍以 `normalize_prompt` 为主路径；若其结果为空，**保留** strip 后长度合法的 **纯数字/小数** 字符串作 gallery 标签，与 **prompt_token** 丢弃纯数字的卫生规则**分离**；见 §8.8 *Gallery tag* 段。）* |
| POST   | `/xyz/gallery/bulk/move/preflight`    | `{ "selection": Selection, "target_folder_id": int }`                                               | **Phase 1 of the two-phase move (§8.7).** Pure read + in-memory simulation: validates target writability, estimates required free bytes, and returns `{ plan_id, total_bytes, free_bytes, mappings: [{id, src, dst, conflict?: "renamed"\|"clean"}], unresolved_conflicts: [...] }`. No file is touched. |
| POST   | `/xyz/gallery/bulk/move/execute`      | `{ "plan_id": str, "rename_overrides"?: { "<id>": "<new_name>" } }`                                 | **Phase 2.** Server replays the previously-validated plan, performs every `os.replace`, then commits all path changes inside one SQLite transaction. Partial-failure rollback is best-effort: any successfully-moved file is recorded in the DB before a later failure aborts the plan, so on-disk state is always consistent with the index. |
| POST   | `/xyz/gallery/bulk/delete`            | `{ "selection": Selection, "confirm": true }`                                                       | Same pre-flight pattern: dry-run resolves the row set first, then physical deletes are batched in 200-row chunks per WS heartbeat. |
| POST   | `/xyz/gallery/bulk/resolve_selection` | `{ "selection": Selection, "limit"?: int }`                                                         | Diagnostics endpoint: returns the resolved id count (and optionally the first `limit` ids) without performing any mutation. Used by the confirm modal to display "you are about to affect N files".|

### 7.7 Vocab / autocomplete

| Method | Path                              | Query                        | Returns                                          |
| ------ | --------------------------------- | ---------------------------- | ------------------------------------------------ |
| GET    | `/xyz/gallery/vocab/tags`         | `?prefix=...&limit=20`       | `[ { name, usage_count } ]`, sorted by `usage_count desc, name asc`. |
| GET    | `/xyz/gallery/vocab/prompts`      | `?prefix=...&limit=20`       | same shape over `prompt_token`.                  |
| GET    | `/xyz/gallery/vocab/models`       |                              | `[str]` distinct model names.                    |

### 7.8 Index lifecycle

| Method | Path                              | Notes                                                                 |
| ------ | --------------------------------- | --------------------------------------------------------------------- |
| GET    | `/xyz/gallery/index/status`       | `{ scanning: bool, pending_events: int, last_full_scan_at, totals }`. |
| GET    | `/xyz/gallery/jobs/active`        | **T44**：返回当前**未结束**长作业列表（`job_id`、`kind`、`done`/`total`、`phase`…），供晚到 Web 会话在 WS 可用前挂载 `ProgressModal`（§12.4 **FR-Prog-5**）；**精确 JSON 以 `TASKS`/实现为准**。 |
| POST   | `/xyz/gallery/index/rebuild`      | Wipes index + thumbnails, re-scans roots in background.               |

### 7.9 WebSocket

`ws://.../xyz/gallery/ws` — server → client only (client may send pings).

Event envelope:
```text
{ "type": <string>, "data": <object>, "ts": <epoch_ms> }
```

| Type                | Data                                              | When                                            |
| ------------------- | ------------------------------------------------- | ----------------------------------------------- |
| `image.upserted`    | `ImageRecord` (compact)                           | After indexing a new or modified file           |
| `image.deleted`     | `{ "id": int, "path": str }`                      | After a file is removed from disk               |
| `image.updated`     | `{ "id": int, "favorite"?, "tags"?, "moved_to"? }`| After a mutation API call                       |
| `folder.changed`    | `{ "root_id": int }` — client SHOULD `GET /folders` to refresh the tree (`FolderNode` payload comes from HTTP, not inline in WS). *Updated due to runtime implementation / QA feedback.* | After `folder` rows under that root were reconciled with disk (add/remove subdirs) |
| `index.progress`    | `{ done, total, phase }`                          | During a full scan / rebuild                    |
| `bulk.progress`     | `{ bulk_id \| plan_id, done, total, kind, … }` | During bulk favorite / tags / move / delete execute（**T44** 归一为 **Job** 进度源之一） |
| `bulk.completed`    | `{ bulk_id \| plan_id, done, total, kind, failed?, … }` | 对应 bulk 执行结束 |
| `job.progress` / `job.completed` | *（**T44** 实现时补全；形状须与 `bulk.*` 对齐同一 **Job envelope**，见 §12.4 **FR-Prog-4**）* | Settings 多阶段、其他非 `bulk_id` 形状的长作业 |
| `vocab.changed`     | `{ "kind": "tag"\|"prompt", "added":[], "removed":[] }` | After tag/prompt vocab deltas             |

> **Active jobs (HTTP, T44).** `GET /xyz/gallery/jobs/active`（**精确路径以 `TASKS`/`routes` 为准**）返回当前进程内**未结束**的长作业摘要（含 `job_id`、`kind`、`done`/`total`、`phase`），供 Web 页**晚到会话**在 WS 首包前渲染 `ProgressModal`（§12.4 **FR-Prog-5**）。

> **Consistency model — deliberately simple.** This is a single-user
> local plugin. We do **not** introduce per-event sequence numbers, vector
> clocks, or strict-ordering buffers; the WS channel is fire-and-forget
> "backend pushes, frontend patches local state". The only safety net is
> a lightweight reconciliation pass that the frontend triggers on
> `window.onfocus` (and on WS reconnect): a single `GET
> /xyz/gallery/index/status` plus, if its `last_event_ts` is newer than
> the last event the tab actually applied, a `GET /xyz/gallery/images`
> for the currently visible window. This catches missed events from
> short disconnects without paying the complexity cost of a fully
> ordered protocol.

### 7.10 Error envelope

All errors return:
```text
{ "error": { "code": "<machine_code>", "message": "<human>", "details"?: {...} } }
```
HTTP status follows REST conventions (`400` validation, `404` missing,
`409` conflict for collisions, `500` unexpected).

---

## 8. Performance Strategy

### 8.1 Indexing

* **First scan** walks the registered roots once, in a background thread,
  in batches of 500 files per DB transaction (`BEGIN ... COMMIT`).
* Per file: `stat()` first; if `(size, mtime_ns)` matches the cached row,
  **skip everything else** (this makes restarts ~free).
* Otherwise: open with Pillow only to read header dims and PNG text
  chunks; close immediately. Thumbnails are **not** generated during
  indexing — they're produced lazily on first request, then cached.
* `xxhash64` is computed only on demand (e.g. dedupe view), never during
  the bulk scan.
* SQLite is opened with:
  * `PRAGMA journal_mode = WAL;`
  * `PRAGMA synchronous = NORMAL;`
  * `PRAGMA temp_store = MEMORY;`
  * `PRAGMA mmap_size = 256 MiB;`

### 8.2 Live updates — Dict Coalescing + Delta-Scan fallback

A naive `queue.Queue` consumer collapses under real-world event storms
(unzip of a 5 000-file archive, `git pull` over the output folder,
syncing a Dropbox / OneDrive folder). At ~1 000 events/s we hit two
failure modes simultaneously: queue overflow drops events silently, and
SQLite contention causes `database is locked` errors that propagate
back to the indexer thread. The watcher therefore uses a
**dict-coalescing buffer** in front of the indexer, with an automatic
fallback to a **bounded delta scan** when the buffer saturates.

**Pipeline.**

```
watchdog raw events ──►  Coalescer (in-memory dict)  ──► Indexer worker
                              │                                 │
                              │  if len(buffer) > HIGH_WATERMARK│
                              ▼                                 ▼
                         clear buffer                  one delta-scan task
                              │                                 │
                              └────────────►  scheduler  ◄──────┘
```

**Coalescer rules** (`watcher.Coalescer`):

* Keyed by absolute path. Value is the *latest observed* event kind +
  the timestamp of the most recent occurrence. Repeated events on the
  same path within the debounce window collapse into a single pending
  entry — `created` then `modified` ⇒ `upserted`; `created` then
  `deleted` ⇒ entry dropped entirely; `moved(a → b)` is split into
  `deleted(a)` + `upserted(b)` so it composes with everything else.
* A background timer drains entries older than `DEBOUNCE_MS` (default
  250 ms) into the indexer in micro-batches of up to 50, each wrapped
  in a single SQLite transaction.
* The coalescer has a hard size cap, `HIGH_WATERMARK = 500`. When the
  buffer would exceed it the watcher drops the in-memory buffer
  entirely and schedules **one** `delta_scan(folder_id)` task per
  affected registered root instead. This is strictly cheaper than
  draining hundreds of correlated events one-by-one, and it
  guarantees correctness because `delta_scan` re-derives the truth
  from `(path, size, mtime_ns)` directly (the same fingerprint used
  by the cold-start indexer, §8.1).
* Delta-scan tasks themselves are coalesced: only one scan can be
  in-flight per root at a time; while one is running, additional
  triggers for the same root just set a `dirty` flag that re-arms the
  scan when the current one finishes.

Pseudo-code:

```python
class Coalescer:
    DEBOUNCE_MS = 250
    HIGH_WATERMARK = 500
    FLUSH_BATCH = 50

    def __init__(self, indexer, scheduler):
        self._buf: dict[str, _PendingEvent] = {}
        self._lock = threading.Lock()
        self._indexer = indexer
        self._scheduler = scheduler

    def on_event(self, path: str, kind: EventKind, root: FolderRoot):
        with self._lock:
            prev = self._buf.get(path)
            merged = _merge(prev, kind)            # upsert+delete=drop, etc.
            if merged is None:
                self._buf.pop(path, None)
            else:
                self._buf[path] = _PendingEvent(merged, time.monotonic_ns())

            if len(self._buf) >= self.HIGH_WATERMARK:
                self._buf.clear()
                self._scheduler.request_delta_scan(root)
                return

    def drain_due(self):
        now = time.monotonic_ns()
        cutoff = now - self.DEBOUNCE_MS * 1_000_000
        with self._lock:
            ready = [(p, e) for p, e in self._buf.items() if e.ts <= cutoff]
            for p, _ in ready:
                self._buf.pop(p, None)

        for batch in _chunks(ready, self.FLUSH_BATCH):
            self._indexer.apply_batch(batch)        # one SQLite TX per batch
```

### 8.3 Thumbnails — SQLite-tracked LRU

* Format: **WebP** quality 78, generated with Pillow's `thumbnail`
  using `Image.Resampling.LANCZOS`, max 320 × 320, then cropped to the
  card's display ratio (`object-fit: cover` is achieved server-side to
  avoid sending oversized images).
* Generation runs in a `concurrent.futures.ProcessPoolExecutor`
  (bypasses the GIL; image decode is CPU-bound), bounded to
  `min(4, cpu_count)` workers.
* Disk cache key = `sha1(path + mtime_ns)`, sharded into 256 sub-dirs by
  the first 2 hex chars of the key.
* HTTP responses use long-lived immutable caching keyed on `mtime_ns`
  in the URL, so the browser never re-fetches an unchanged thumbnail.

**LRU bookkeeping.** Eviction is driven by the `thumbnail_cache` table
(§6.1), not by `os.scandir` over 100 k+ shards. The previous design's
"walk the cache directory and `stat()` every file to find the oldest"
costs seconds on cold cache and easily 100 ms on warm cache; the table
turns it into a single indexed query.

* On every served `GET /xyz/gallery/thumb/{id}`:
  ```sql
  UPDATE thumbnail_cache
     SET last_accessed = :now
   WHERE hash_key = :hash;
  ```
  Performed asynchronously after the response is flushed (the HTTP
  request never waits on it). To avoid write amplification we batch
  these touches: the route only marks the hash in an in-memory set,
  and a background task flushes the set every 10 s with a single
  `executemany`. A 10 s window of inaccurate `last_accessed` is
  irrelevant for an LRU whose budget is measured in days.
* On generation: insert into `thumbnail_cache(hash_key, image_id,
  size_bytes, created_at, last_accessed)` inside the same transaction
  that materialises the file on disk.
* Eviction (triggered after each insert, throttled to once per 30 s):
  ```sql
  -- 1. how big are we?
  SELECT COALESCE(SUM(size_bytes), 0) FROM thumbnail_cache;

  -- 2. if over budget, pick victims (drop until we are under 80 % of budget)
  SELECT hash_key, size_bytes
    FROM thumbnail_cache
   ORDER BY last_accessed ASC
   LIMIT :batch;
  ```
  For each victim: `os.unlink(path_for(hash_key))` then
  `DELETE FROM thumbnail_cache WHERE hash_key = ?`, all inside one
  transaction so a crash never leaves an orphan row.
* A daily janitor reconciles drift in both directions (file present
  on disk but no DB row → delete file; row present but file missing →
  delete row). This keeps the table authoritative even after a hard
  crash or a manual `rm` of the thumbs dir.

### 8.4 Query performance

* Every filter dimension is backed by either a B-tree index or an
  inverted join table — no full scans on the hot path.

**Tag / prompt-token AND filter — short-circuit strategy.**
The previous draft used `GROUP BY image_id HAVING COUNT(DISTINCT tag_id) = N`.
That works at 5 000 rows but degrades sharply by 100 000+: SQLite must
materialise the full `image_tag` rowset for every requested tag, then
sort, then aggregate, even when the answer is provably empty after the
first tag. We replace it with a strategy SQLite's planner can actually
short-circuit.

Two equivalent forms are accepted by `repo.list_images`; the planner
chooses based on tag selectivity (provided via the `usage_count`
hints), but both share the *driving table = rarest tag* invariant:

```sql
-- Form A: nested EXISTS, driven by the rarest tag.
-- Selectivity is exploited via the order in which we resolve tag IDs
-- in Python: rarest first (smallest usage_count), so the outer scan
-- is the smallest possible set, and each EXISTS short-circuits per row.
SELECT i.*
  FROM image AS i
  JOIN image_tag AS it0
    ON it0.image_id = i.id AND it0.tag_id = :tag_id_rarest
 WHERE EXISTS (SELECT 1 FROM image_tag
                WHERE image_id = i.id AND tag_id = :tag_id_2)
   AND EXISTS (SELECT 1 FROM image_tag
                WHERE image_id = i.id AND tag_id = :tag_id_3)
   -- ... one EXISTS per remaining tag ...
   AND i.folder_id IN (:folder_ids)        -- folder scope, optional
   AND (:fav IS NULL OR i.favorite = :fav) -- favourite filter, optional
 ORDER BY i.created_at DESC, i.id DESC
 LIMIT :limit;
```

```sql
-- Form B: INTERSECT of inverted lists.
-- Preferred when N >= 4 tags AND every tag has comparable cardinality;
-- INTERSECT lets SQLite stream-merge sorted id lists without a hash
-- aggregate.
SELECT image_id FROM image_tag WHERE tag_id = :tag_id_rarest
INTERSECT
SELECT image_id FROM image_tag WHERE tag_id = :tag_id_2
INTERSECT
SELECT image_id FROM image_tag WHERE tag_id = :tag_id_3
-- ...
;
-- Then JOIN the resulting id set back to `image` for projection + sort.
```

`repo.py` builds the SQL dynamically from the resolved `tag_id` list:

```python
def build_tag_and_query(tag_ids: list[int], extras: FilterExtras) -> Query:
    # Resolve ids in Python first, then sort by usage_count ASC so the
    # rarest tag drives the join. Empty resolution → return empty.
    if not tag_ids:
        return EMPTY_QUERY
    ordered = sorted(tag_ids, key=lambda t: vocab.usage_count(t))
    rarest, *rest = ordered

    if len(ordered) >= 4 and _all_dense(ordered):
        return _intersect_form(rarest, rest, extras)
    return _exists_form(rarest, rest, extras)
```

The exact same construction is used for prompt tokens against
`image_prompt_token`. Combined tag-AND + prompt-AND filters are
expressed as additional `EXISTS` clauses against the second table —
SQLite's planner happily reuses the same driving row.

* Name filter on `filename_lc` — **literal substring** via ``instr(lower(basename), needle)`` (implemented as ``instr(filename_lc, ?)``; **T28** may move long needles to FTS5 / `image_fts`).
* Sorting + pagination is **cursor-based** on `(sort_key, id)` — never
  `OFFSET` — so deep scrolling stays O(log N).
* Counts: server returns an **estimate** for very large result sets
  (`SELECT COUNT(*)` capped at a budget of 25 ms; otherwise reports
  `total_estimate` flagged as approximate). Exact counts only when the
  client requests `/images/count` explicitly (used for `Select all`).

### 8.5 Autocomplete

* `tag.name` and `prompt_token.token` columns are `COLLATE NOCASE` and
  indexed.
* Suggestion query:
  ```text
  SELECT name FROM tag
   WHERE name LIKE :prefix || '%'
   ORDER BY usage_count DESC, name ASC
   LIMIT 20;
  ```
* Frontend additionally caches per-prefix results in an in-memory LRU
  to suppress duplicate keystroke fetches.

### 8.6 Frontend rendering

* **Virtual scroll**: a windowed grid renders only the rows whose
  bounding box intersects the viewport ± 2 viewport heights. The
  grid's total height is computed from the (estimated) total count
  and the slider-controlled card size.
* **Image decode**: `<img loading="lazy" decoding="async">`, plus
  `IntersectionObserver` to assign `src` only when the card is within
  500 px of the viewport. Off-screen `<img>` elements have `src`
  cleared on aggressive evictions to keep GPU memory bounded.
* **State**: a single observable store. Selection uses the polymorphic
  `Selection` envelope (§6.2), **never** a `Set<100_000_ids>`:

  ```ts
  type SelectionState =
    | { mode: 'explicit';  ids: Set<number> }
    | { mode: 'all_except'; filters: FilterSpec; excludedIds: Set<number> };
  ```

  Toggling a single card mutates `ids` (explicit) or `excludedIds`
  (all_except) — both O(1). Clicking *Select all in current view*
  flips into `all_except` with `excludedIds = ∅` and an immutable
  snapshot of the active `FilterSpec`. Bulk endpoints accept this
  envelope verbatim, so the wire payload of "select everything in a
  100 000-image gallery" is < 200 bytes regardless of library size.
  Visual rendering of "is this card checked?" is derived:
  `(mode === 'explicit' ? ids.has(id) : !excludedIds.has(id))`.
* **WS reconciliation**: incoming `image.upserted` / `image.deleted`
  events patch the local index of the current query. If the event
  doesn't match the current `FilterSpec`, the count is bumped /
  decremented but no card is added/removed.
* **Focus reconciliation**: on `window.onfocus` (and on WS reconnect)
  the store fires a single `GET /xyz/gallery/index/status`. If the
  server's `last_event_ts` is newer than the most recently applied
  event in this tab, the store re-fetches just the currently visible
  page of `/xyz/gallery/images`. This is the *entire* drift-recovery
  mechanism — see the WS consistency note in §7.9.
* **Routing**: client-side hash router (`#/`, `#/image/<id>`) so
  Back/Forward and direct links work without server roundtrips.
* **Persisted UI state**: filter values, sort, layout, cards-per-row,
  recursive toggle, and the "main view" scroll position are stored in
  `localStorage` and restored on next visit.

### 8.7 Move / delete throughput — two-phase Pre-flight + Execution

A naive loop `for src in selection: os.replace(src, dst)` cannot be
rolled back: if file 437 of 500 fails (target dir suddenly read-only,
disk full, name collision discovered mid-flight), the first 436 are
already moved and the SQLite paths are now lying. We therefore split
every bulk move into two strictly-ordered phases.

**Phase 1 — Pre-flight (`POST /xyz/gallery/bulk/move/preflight`).**
Pure read + in-memory simulation, **no filesystem write**. Returns a
`plan_id` keyed in a short-lived in-memory store (TTL 5 min).

```python
def preflight_move(selection: Selection, target: FolderRow) -> MovePlan:
    ids = repo.resolve_selection(selection)             # SQL, never list expansion
    rows = repo.get_paths(ids)                          # [(id, src_abs)]

    # 1. Sandbox + writability.
    paths.assert_inside_root(target.path)
    if not os.access(target.path, os.W_OK):
        raise PreflightError("target_not_writable", target=target.path)

    # 2. Disk space estimate.
    total_bytes = sum(r.file_size for r in rows)
    free_bytes  = shutil.disk_usage(target.path).free
    if total_bytes > free_bytes * 0.95:                 # 5 % safety margin
        raise PreflightError("insufficient_space",
                             needed=total_bytes, free=free_bytes)

    # 3. Conflict resolution. Build the full src→dst mapping in memory,
    #    accounting for collisions both with existing files in the target
    #    AND with other files inside the same batch.
    taken: set[str] = set(_listdir_lower(target.path))
    mappings: list[Mapping] = []
    for r in rows:
        candidate = r.filename
        if candidate.lower() in taken:
            candidate = _next_free_name(r.filename, taken)   # "foo (1).png", "(2)" ...
        taken.add(candidate.lower())
        mappings.append(Mapping(
            id=r.id, src=r.path, dst=os.path.join(target.path, candidate),
            conflict="renamed" if candidate != r.filename else "clean",
        ))

    plan = MovePlan(id=uuid4().hex, target=target, mappings=mappings,
                    total_bytes=total_bytes, expires_at=now() + 300)
    PLAN_STORE.put(plan)
    return plan
```

The frontend renders the plan, lets the user override individual
renames (`rename_overrides`), and only then calls Phase 2.

**Phase 2 — Execution (`POST /xyz/gallery/bulk/move/execute`).**
Replays the validated plan. Filesystem moves first (in chunks, with WS
progress events), then **one** SQLite transaction commits every
`UPDATE image SET path = ?, folder_id = ?, relative_path = ?` and the
matching `image_tag` / `image_prompt_token` rows are unaffected (they
key on `image_id`, not path).

```python
def execute_move(plan_id: str, overrides: dict[int, str]) -> MoveResult:
    plan = PLAN_STORE.pop(plan_id)
    if plan is None or plan.expires_at < now():
        raise ExecError("plan_expired_or_unknown")

    plan = _apply_overrides(plan, overrides)
    _re_check_conflicts(plan)              # cheap: just listdir + set diff

    moved: list[Mapping] = []
    try:
        for m in plan.mappings:
            try:
                os.replace(m.src, m.dst)                       # atomic intra-volume
            except OSError:                                    # cross-volume
                shutil.copy2(m.src, m.dst)
                _verify_size(m.src, m.dst)
                os.unlink(m.src)
            moved.append(m)
            ws_hub.broadcast_progress(plan_id, len(moved), len(plan.mappings))
    finally:
        # Whatever ACTUALLY moved, we record. The DB never disagrees with
        # what is on disk. A partial failure leaves a partially-moved
        # batch but ZERO inconsistency between the index and reality.
        with repo.tx() as tx:
            for m in moved:
                tx.update_image_path(m.id, m.dst, plan.target.id)

    return MoveResult(moved=len(moved), planned=len(plan.mappings))
```

**Bulk delete** follows the same shape but Phase 1 only checks
sandbox + selection resolution; Phase 2 deletes in 200-row chunks with
a transaction per chunk (intermediate crashes leave the index
truthful). All bulk operations stream `image.updated` /
`image.deleted` events as they make progress, so the UI never waits
on the full batch.

---

### 8.8 Prompt Normalization Pipeline

A bare `text.split(',')` is catastrophic for the `prompt_token`
vocabulary. On a 50 000-image library it produces *hundreds of
thousands* of distinct rows because `(masterpiece:1.2)`,
`(masterpiece:1.3)`, `( masterpiece :1.4)`, `<lora:add_detail:0.6>`,
`masterpiece.`, and `masterpiece` all hash to different strings.
Autocomplete becomes useless and the table becomes a write
hotspot. Every prompt — both at index time (`indexer`) and at
query time (filter input) — therefore goes through a single
`vocab.normalize_prompt()` function.

**Pipeline stages** (applied in order, all on lower-cased input):

1. **Strip LoRA / hyper-network tags** — drop the entire
   `<lora:name:weight>` / `<lyco:...>` / `<hypernet:...>` fragment.
   These are syntax, not vocabulary; we may later index them in a
   separate `image_lora` table, but they never enter `prompt_token`.
2. **Strip BREAK / AND / control keywords** — A1111-style
   `BREAK`, `AND`, `ADDCOMM`, etc., are dropped.
3. **Unwrap weight syntax** — `(word:1.5)` → `word`,
   `[word:0.7]` → `word`, nested `((word))` → `word`. The numeric
   weight itself is discarded.
4. **Strip leftover grouping punctuation** — `()`, `[]`, `{}`, `\`.
   > **v1.1 deprecation（§11）**：本条整段行为**废弃**。归一化流水线须**保留**分组字符与转义括号场景（例：`yd \(orange maru\)` 进入词表 / DB 时不得因本步被抹平）。实现上删除本步或改为 no-op；需配合 **full re-derive** `prompt_token` / `image_prompt_token`（见 §11）。
5. **Split on commas and `|`** — these are the only real token
   separators in SD-style prompts.
6. **Per-token clean-up** — collapse internal whitespace, trim
   leading/trailing punctuation (`.,;:`), drop tokens that are
   numeric-only, single-character, or > 64 characters.
7. **Stop-word filter** — a small built-in deny-list (`a`, `an`,
   `the`, `of`, `and`, …) plus user-extensible `gallery_config.json
   :: prompt_stopwords`.
8. **Deduplicate** within the same image (set semantics).

```python
# vocab.py  —  pure functions, no I/O
import re

_RE_LORA      = re.compile(r"<(?:lora|lyco|hypernet)\s*:[^>]+>",  re.IGNORECASE)
_RE_KEYWORD   = re.compile(r"\b(BREAK|AND|ADDCOMM|ADDBASE)\b")
# Recursive weight unwrap: (word:1.5)  /  [word:0.7]  /  {word}  /  ((word))
_RE_WEIGHTED  = re.compile(r"[\(\[\{]\s*([^\(\)\[\]\{\}:]+?)\s*(?::\s*-?\d*\.?\d+)?\s*[\)\]\}]")
_RE_PUNCT     = re.compile(r"[\(\)\[\]\{\}\\]")
_RE_SPLIT     = re.compile(r"[,\|]+")
_RE_WS        = re.compile(r"\s+")
_RE_TRIM      = re.compile(r"^[\.,;:!\?\-_]+|[\.,;:!\?\-_]+$")
_RE_NUM_ONLY  = re.compile(r"^\d+(?:\.\d+)?$")

_DEFAULT_STOP = frozenset({
    "a", "an", "the", "of", "and", "or", "with", "in", "on", "for",
    "to", "by", "at", "is", "as",
})

def normalize_prompt(text: str | None,
                     extra_stopwords: frozenset[str] = frozenset()
                     ) -> list[str]:
    if not text:
        return []
    s = text.lower()

    # 1. LoRA / hyper-network tags - removed wholesale.
    s = _RE_LORA.sub(" ", s)
    # 2. Pipeline keywords.
    s = _RE_KEYWORD.sub(" ", s)
    # 3. Recursively unwrap weight syntax until a fixed point is reached.
    for _ in range(8):                  # bounded; deep nesting is pathological
        new_s = _RE_WEIGHTED.sub(r"\1", s)
        if new_s == s:
            break
        s = new_s
    # 4. Drop leftover grouping punctuation.
    s = _RE_PUNCT.sub(" ", s)

    # 5. Real token split.
    raw_tokens = _RE_SPLIT.split(s)

    stopwords = _DEFAULT_STOP | extra_stopwords
    out: list[str] = []
    seen: set[str] = set()
    for t in raw_tokens:
        # 6. Per-token clean-up.
        t = _RE_WS.sub(" ", t).strip()
        t = _RE_TRIM.sub("", t).strip()
        if not t or len(t) == 1 or len(t) > 64:
            continue
        if _RE_NUM_ONLY.match(t):
            continue
        # 7. Stop-words.
        if t in stopwords:
            continue
        # 8. Per-image dedup.
        if t in seen:
            continue
        seen.add(t)
        out.append(t)
    return out
```

Two consequences worth calling out:

* **Tag normalisation reuses the same function.** Bulk tag input
  (`POST /xyz/gallery/bulk/tags`) is run through `normalize_prompt`
  with an empty stopword set so that tags like `My Tag`, `my tag`,
  and `(my tag:1.2)` are treated as a single canonical `my tag`.
* **（v1.2 patch / 2026-04-24）Gallery `normalize_tag()` — numeric labels.**
  `vocab.normalize_tag()` still delegates to `normalize_prompt(…, frozenset())` first
  so weight/LORA unwrap rules stay aligned with the bullet above. **If that pipeline
  yields no tokens** (including because per-token stage 6 drops **numeric-only**
  strings that exist only to keep the *prompt* vocabulary bounded), **pure numeric /
  simple decimal** tag strings after lower-case + whitespace collapse + length checks
  (≤ 64) are **retained** as user gallery tags (e.g. `111`). This **does not** relax
  `prompt_token` hygiene inside `normalize_prompt` itself.
* **Re-indexing is required when the stopword set changes.** A
  config-bump increments `vocab_version` in `gallery_config.json`;
  the indexer detects the bump on next start and re-derives
  `image_prompt_token` for every row whose `image.indexed_at <
  vocab_version_changed_at`. This is incremental — it does not
  re-read PNG headers — so it costs seconds, not minutes.

---

## 9. Out of Scope (v1)

* Multi-user auth (gallery inherits ComfyUI's existing access model).
* Cloud storage backends.
* Image editing / re-generation from the gallery (the "send to ComfyUI"
  flow is left for a future spec).
* Trash / undo for deletes (deletes are immediate after confirmation).
* Mobile-first layout (the SPA is responsive but optimised for
  desktop ≥ 1280 px wide).

---

## 10. Open Questions (to confirm before implementation)

1. **Frontend stack**: vanilla TS + custom virtual grid, or Vue 3 ESM
   via importmap (no build step), or pre-bundled React via Vite? All
   three satisfy C-9; default recommendation is **Vue 3 + importmap**
   for fastest iteration without a build pipeline shipped to users.
2. ~~**Tag/prompt token normalisation**: lower-case + trim is mandatory;
   should we also strip leading `(weight)` syntax …?~~ **Resolved:**
   see §8.8 *Prompt Normalization Pipeline*. Weight syntax, LoRA tags,
   control keywords, and stopwords are all stripped; the canonical
   pipeline is a single function (`vocab.normalize_prompt`) used by
   both the indexer and the filter input.
3. **Workflow extraction**: extract from the `workflow` PNG chunk
   only, or also fall back to the legacy `parameters` chunk used by
   some forks? Default = **both**, prefer `workflow`.
4. **Date semantics**: "creation date" should prefer the ComfyUI
   metadata timestamp if present, otherwise file `ctime`, otherwise
   `mtime`. Confirm preference order.
5. **Custom folder sandbox**: should we forbid registering a custom
   folder that is an ancestor / descendant of an already-registered
   one (to avoid double-indexing)? Default = **forbid overlap**.

---

## 11. v1.1 Overrides（post-MVP，pre-L4）

> 来源：`docs/gallery_update_description.md`（gallery 初始版本全覆盖后的增量意见）。  
> 分类标签：**DM** = 数据模型 / 索引；**API** = HTTP / 查询语义 / 后台行为；**UI** = 前端交互与视觉。

### 11.1 变更清单与分类

| ID | 摘要 | DM | API | UI |
| --- | --- | --- | --- | --- |
| V1.1-F01 | 目录树：文件夹可折叠；右键改名 / 移动 / 删除 / 创建子文件夹；（可选）在 OS 中打开 | ○ | ● | ● |
| V1.1-F02 | Light / Dark 主题切换 | | | ● |
| V1.1-F03 | 过滤器增加：`all` / **有** ComfyUI metadata / **无** ComfyUI metadata | ● | ● | ● |
| V1.1-F04 | Prompt 过滤拆三种：**match prompt**（逗号分隔精确 token）、**match word**（空格分词）、**match string**（子串含无空格粘连）；各自自动补全策略（prompt/word 联想，string 不联想） | ● | ● | ● |
| V1.1-F05 | 数据库 / 查询侧：将 `_` **规范化**为空格（与既有 `normalize_prompt` / 存储策略对齐；具体落在索引列、迁移或查询层由 TASKS 固化） | ● | ● | ○ |
| V1.1-F06 | 缩略图网格多选：鼠标拖拽框选 + Shift 范围选择（Windows 风格） | | | ● |
| V1.1-F07 | 拖拽缩略图（单张或当前多选）到左侧目录 → **移动** | | ● | ● |
| V1.1-F08 | 右键缩略图：改名、移动、删除 | | ● | ● |
| V1.1-F09 | 多选模式下顶栏：集体移动 / 删除 / 统一增减 tag / 统一 favorite | | ● | ● |
| V1.1-F10 | Detail：可改图片名、tag、favorite（与 PATCH 语义一致） | | ● | ● |
| V1.1-F11 | **`output/_thumbs`**（及同类）不得作为画廊图源：缩略图缓存迁至 `gallery_data`/可控目录；非画廊用途文件删除或排除索引 | ● | ● | ○ |
| V1.1-F12 | Detail：positive prompt 展示切换「PNG 原文」vs「DB 归一化后」 | | | ● |
| V1.1-F13 | 移除 §8.8 流水线第 4 步（见上文 **deprecated** 标注）；重组 `prompt_token` | ● | ● | ○ |
| V1.1-F14 | Detail 右栏：gallery 相关 metadata **置顶**显示 | | | ● |
| V1.1-F15 | Settings 子页：开发者模式开关；下载策略（全 metadata / 无 workflow / clean copy）+ 自定义下载路径；过滤器「可见性」按项 checkbox；tag 管理（搜、删、清理 usage=0、重命名级联）；自定义图库根路径管理（**不得**改动内置 output/input 根） | ● | ● | ● |
| V1.1-F16 | 右键 / Detail / 批量选择：**下载**（策略由 Settings 统一） | | ● | ● |
| V1.1-F17 | 视觉整体美化（含滚动条、配色、字体、组件布局；参考 Apple 相册） | | | ● |

> **Updated due to runtime implementation / QA feedback (F15–F16)**：**Settings** 为 hash **overlay**（`#/settings`、`#/image/{id}/settings`），与 **MainView/DetailView** 同屏；顶栏在设置打开时保持；遮罩点击关闭。下载偏好含 **`download_prompt_each_time`**（每笔下载前弹窗选 `variant`）与持久化 **`download_variant`** / **`download_basename_prefix`**。**`GET /xyz/gallery/admin/tags`** 返回 **`{ "tags": [...], "total": int }`**，分页参数 **`limit`/`offset`**（默认 **`limit=10`**）。详见 `TASKS.md` **T35/T36** *Scope supplement*。

### 11.2 与 L4（性能层）关系 — **何种变更阻塞 L4**

以下完成后或明确并行策略前，**暂缓启动** `TASKS.md` 中 **T26–T28（MVP-L4）**，以免双重迁移与性能调优白费：

| 阻塞原因 | 关联项 |
| --- | --- |
| 索引集合与磁盘布局若仍含「衍生物目录 / 错误缓存 PNG」则 LRU、进程池与 FTS 重建口径不稳定 | **V1.1-F11**（及 TASKS **T29**） |
| `prompt_token` 语义变更会迫使全量重扫 / 重链 junction，应在 FTS5（T28）与 ProcessPool（T27）之前冻结 | **V1.1-F05、V1.1-F13**（及 TASKS **T30–T31**） |
| 下载与 PNG 重写策略若仍变动，`metadata_sync` 热路径与二进制输出形态未稳定 | **V1.1-F15–F16**（与实现批次相关；若仅客户端侧下载可并行） |

**不阻塞 L4 的项**：纯 UI（**F02、F06、F14、F17** 中与数据无关部分）、仅主视图过滤器展示开关（**F15** 子集）——可与 L4 并行，但需在 SPEC/TASKS 标注依赖以免合并冲突。

### 11.3 Backward compatibility

- v1.0 行为在 §8.8 第 4 步等处仍可在代码中读到；**v1.1** 通过 **§11 + 代码注释 `@deprecated v1.0`** 双重标记迁移路径。
- `docs/gallery_update_description.md` 列为需求溯源；实现验收以本文 §11 与 `TASKS.md` Pre-L4 阶段为准。

---

## 12. v1.2 Overrides（设计驱动系统级演进，post v1.1 QA）

> **来源**：`docs/gallery_update_description.md` **v1.2** 段；在 **v1.1 已完成并 QA 通过**（见 `PROJECT_STATE.md`）的前提下，对 **UI/UX、列表渲染行为、批处理可观测性** 做增量规格，**不**推翻 §2–§4、§6–§10、C-1…C-12、§11 已冻结的数据与写入语义。
>
> **Updated due to v1.2 planning**：本条为 **v1.2 唯一**覆盖台；与 §2.3.1 **FR-9c** 字面冲突时，以 **§12.2** 为**命名与行为**覆盖说明（v1.0 中 “timeline” 的措辞保留为历史文档，**产品内命名**以 **line view** 为准）。

### 12.1 目标摘要

1. **统一视觉语言**（参考 Apple 相册 / macOS Photos）：主视图、Detail、Settings 共用 **design system**（色板、圆角、动效、滚动条与表单控件在 Light/Dark 下均无“裸白块”与廉价网页感）。
2. **可发现性**：目录树具 **文件夹图式**（图标、缩进、悬停/选中）；全应用 **统一 icon 系统**；复杂控件旁可选 **`?` + 悬停说明**（不替代必要标签文案）。
   - *（**v1.1 patch / 2026-04-24 — overrides §12.1 item 2 的「须交付 `?`」解读**）* 经产品决策与 QA：**当前版本不交付** 独立 **`HelpTip` / `?` 悬停浮层**（`TASKS` **T41** 记为 **descoped · closed**）。可发现性仍由**必要标签文案**、Settings、本条 **统一 icon**、及下款 **T39** 目录图式等承担。**优先级**：本 patch **覆盖** item 2 中对「可选 `?`」控件的**实现义务**（不要求仓库内保留 `HelpTip` 类实现）；**不**废除 item 2 其余措辞（icon / 标签仍适用）。主视图筛选区在保存 Settings 后可**一次**将持久化高度收束至可见筛选项的自然高度（上界为侧栏 layout cap 与当前 `filters_pane_height_px` 的较小值），且以 **`.mv-filters-slack`** 吸收筛选项下方多余纵向空间——见 **`ARCHITECTURE`** `MainView` 条 *Updated 2026-04-24*。
   - *（**Updated due to T39 + QA**）* **主视图目录树不** 在节点标题前显示 **`folder.kind`** 标签（`input` / `output` / `custom` 等）。**`kind`** 为 SQLite `folder` 行在创建/链入时登记的服务端分类，**不是**“当前在 UI 树中视觉父级”的实时说明；在目录 **移动** 后如未在写入路径上重写该列，可能与新父级不一致，故**不作**用户可见前缀。**「All folders」** 与根级行 **同一缩进/行结构**（与 `depth=0` 的 chevron/占位+标签列对齐）。**含子目录过滤的 Recursive 开关** 在 **`MainView` 的 Folders 区标题行** 与 **「Folders」** 同排；`FolderTree` 可通过 **隐藏** 内置 **Recursive 工具条** 避免重复（见 `ARCHITECTURE` `FolderTree` / `MainView` 条、**`showRecursiveButton`** 语义）。*优先级：本条为 §12.1 在 **T39 交付后** 的 UI 细化，与 §2–§11 数据合同无冲突；若与旧版“展示 kind”的**临时**设想冲突，**以本条为准**。*
3. **消除开发期文案**：占位符、调试字符串不得面向最终用户（例：name filter 的 debounce 说明应移除或换为用户语言）。
4. **实时与稳定**：在既有 **watcher + 30 s 补偿 delta_scan**（FR-20、NFR-9、`ARCHITECTURE` §4.10）上，**审计并收敛** 前端在 WS / 对账时触发的 **全量重拉** 与布局跳动（见 §12.3）。
5. **批处理可观测性**：对「影响 **>1** 张已索引图片或等价长时间后端作业」的操作，提供 **统一 Progress 浮层**（进度条 + 处理对象/操作/结果摘要，结束自动关闭）；与既有 **`bulk.progress` / `bulk.completed`（WriteQueue 语义不变）** 对齐，并**收敛**到 **§12.4 长任务统一模型**（含 **`index.progress`**、Settings 阶段、晚到 Web 会话 — 见 **FR-Prog-4 / FR-Prog-5**），而非另建并行管道。
6. **主视图双模式**：在既有 **紧凑网格（compact）** 外增加 **行分组视图（line view）**（见 §12.2），**排序键与 `SortSpec` 一致**，列表数据仍来自 `GET /xyz/gallery/images` 分页结果（SQLite 为唯一查询源，C-1）。

### 12.2 功能需求 — Main view 布局（覆盖 FR-9c 的命名与线框图）

* **FR-9c（v1.2 覆盖）**：
  * **Compact view**：**当前已交付**的 **扁平虚拟网格**（`VirtualGrid`），缩略图等卡片尺寸由「每行张数」控制；**不改变** 既有游标分页与 NFR-6 预算。
  * **Line view**：在 **同一条目序列** 上，按 **当前 `SortSpec`** 将可见（已加载）条目 **分组** 为若干 **section**，每节 **顶栏** 为 **section header**（纯前端布局；**不** 要求后端新增 `GROUP BY` 游标，除非 `TASKS` 为性能单独立项）。**切换** compact ⇄ line **仅** 改变 `stores/filters`（或等效）中的 `view_mode` 与 `localStorage` 持久化，**不** 改变 `FilterSpec` 语义。

* **Line view — section header 的键（**全部基于 **已索引的 `ImageRecord` 字段** 在客户端派生，与 `repo.list_images` 排序列一致**）**：

| `SortSpec.key` | Header 键规则（展示字符串） | 组内顺序 |
| --- | --- | --- |
| `time` | 自然日 **`YYYY-MM-DD`（本地时区，不含时分秒）**，取自与列表排序相同的 **创建时间** 字段（`created_at` 语义同 §6.1 / 既有实现） | 同当前 `time` 排序 |
| `name` | **首字符**分桶：对 **basename 归一**（可沿用 **首字母 + `#`** 对非字母），展示为 `A` / `B` / … / `#` 等 | 同当前 `name` 排序 |
| `size` | **大小区间**标签，形如 **`≤1000 KiB`–`800 KiB`** 的 **相邻 bin 对**（**bin 边界**在 `TASKS` 固化，须保证 **相邻 section 不重叠、不漏档**；方向 `asc`/`desc` 仅影响 bin 列顺序，不改变键定义） | 同当前 `size` 排序 |
| `folder` | **已注册根下的相对父目录路径**（POSIX 风格、**无** 前导 `/`），例如 `output/test`、`download`、`download/test2`。**仅** 将 **直接位于该目录下** 的文件（即 `ImageRecord` 的 **`relative_path` 去掉 basename 后** 与该目录段一致）归入该 section；**不** 在父级 section **递归** 收拢子目录内文件。按 **header 路径的字典序 + `SortSpec.dir`** 排 section 顺序。 | 同当前 `folder` 键下序 |

* *（**v1.1 patch / 2026-04-25 — T45 QA，overrides 上表 `folder` 行与历史实现的可能偏差**）* **`GET /xyz/gallery/images`** 在 **`sort=folder`** 时，**服务端** **`ORDER BY`** 与 **游标** 必须使用 **与上表 section header 展示字符串相同的排序键**（根 **`folder.display_name`**，否则 **`folder.kind`**，否则字面 **`(root)`**；若 `relative_path` 在 POSIX 语义下含 `/` 则 **`/` + 父目录段**），**不得** 仅以 **`image.path`** 全路径字典序作为 folder 排序列（否则 compact 与 line 的 folder 顺序与标题脱节、line 追加页时易闪烁）。**实现**：Python 侧 **`gallery/folder_header.py`** + 在 **`gallery/db.connect_read` / `connect_write`** 注册的 SQLite UDF **`xyz_folder_line_header`**；**`repo.list_images` / `neighbors`** 使用该表达式（**`lower(...)`**，别名 **`folder_line_header`**）。**Line view 客户端**：**同 section key** 的合并顺序 **遵循** 已加载列表顺序（**`sectionKeys.partitionItemsForLineView`**），**不** 在分页追加后再单独按标题 **`localeCompare`** 重排全局 section 顺序。主视图筛选 **name / positive prompt / tag** 的 **清除（×）** 与 **输入控件** **同一行**（标签独占上一行），见 **`ARCHITECTURE`** **`MainView`** 与 **`index.html`** **`.mv-field-inputrow`**。

* **v1.0 措辞**：§2.3.1 表中 “**timeline**” 与 “vertical buckets” 的表述，在 v1.2 中**收敛为** **line view**（分段横排缩略行 + 顶栏），避免与音乐/时间轴类 UI 混淆。

### 12.3 非功能需求 — 实时一致与抗闪烁

* **与 §3 对齐**：**NFR-9**（§3.2）、**FR-20**（§2.5，≤2 s 反映）与 `ARCHITECTURE` §4.10 **watcher 心跳 + 补偿 `delta_scan`** 不变；**NFR-20、NFR-21** 的正式编号见 **§3.5 末尾**。
* **抗闪烁细则**（**实现约束**，不另占 NFR 号）：
  * 对 **`image.updated`（同 id 在列表中）**、**`image.deleted`**：**in-place 补丁** 或 **行删除**，**避免** 无因清空 `items`。
  * 对 **`image.upserted`（id 已存在）**：**行合并**；**id 尚不在当前页** 时 **防抖** 全量重拉（与 `MainView` 现实现一致**方向**；毫秒值以代码为准）。
  * 对 **`folder.changed`、漂移对账**（`index.drift_detected` 等）：允许 **全量** 对账，但须 **尽努力** 保留**可恢复**的滚动/选区（`TASKS` 验收）。

  * *（**v1.1 patch / 2026-04-24 — T43 交付，overrides 上款在实现层的解读**）* **`folder.changed`**：客户端**先**静默刷新目录树（**短去抖** 合并 burst **`GET /folders`**）；**仅当** 事件 **`root_id`** 与**当前**筛选 **`folder_id` 所在注册根**一致（或无法判定根时保守全量）才对 **`GET /images`** 走 **`resetAndFetch`**，否则**仅**更新树、**不**清空网格——对齐 **`ReconcileFoldersUnderRootOp`** 只改 **`folder` 行**、他根 reconcile **不**必使当前列表失效的语义。静默树刷新须在替换 `folders` 数据**前**快照目录区 **`scrollTop`** 并于 DOM 更新后恢复，避免批量操作后滚动条无故归零。**纯路径 bulk move**：服务层 **`UpdateImagePathOp`** 使用 **`refresh_sync=False`** 且**不**对每次移动 **`metadata_sync.notify`**，以避免无元数据变更下的 PNG 整文件回写与 **mtime** 搅动（**PATCH** / 用户编辑元数据路径仍走既有 **`notify`**）。**优先级**：本 patch **细化** §12.3 与 **`TASKS` T43** *Scope supplement*、**`ARCHITECTURE` §7.4** *Updated due to T43*；**不**改变 WS 事件名与 HTTP 合同。

> **Why it must not “flash”**：全量 `images = []` 会抬升 `VirtualGrid` 的 `listGen` 与重绘；v1.2 要求**最小化**该路径。细则见 `ARCHITECTURE` §7.2。

### 12.4 功能需求 — 批处理 Progress 浮层

* **FR-Prog-1** 凡满足以下**任一**的情况，在**执行从用户点击到落库/落盘**的有效阶段（或用户打开页面时已有作业在跑 — **FR-Prog-5**），显示 **全屏或居中的模态**（`ProgressModal` 抽象），并 **冻结** 主画廊交互（与 **NFR-20** 协调：冻结期间避免对半一致列表的写操作；细则见 `TASKS` **T44**）：
  * **BulkBar**：**favorite / tags / move / delete**；
  * **Folder 侧**：影响多图的 **rename / move / delete subtree**、**purge** 等（含 `RelocateFolderSubtreeDbOp` 触发的路径重写 + 后续 **rescan**）；
  * **Settings**：**增删 custom image folder root**、**tag 管理**（删、重命名、清 usage=0 等，若单请求或多阶段管线影响多行即属此类）；
  * **索引 / 对账**：全量或大规模 **`delta_scan` / rebuild** 等已由 **`index.progress`**（`INDEX_PROGRESS`）承载的步骤，**纳入**同一 Progress 信源（见 **FR-Prog-4**），不得在前端再维护一套脱钩假进度。

* **FR-Prog-2** 模态**至少**含：**进度条**（0–100% 或 已处理/总数；未知总长时 **indeterminate** + 文案）、**处理对象**（如当前文件名/相对路径摘要或阶段名）、**操作**（`move`/`delete`/`reindex`/`tag_rename`/`favorite`/`tags`/`folder_relocate`/`index` 等**枚举短码** + 可本地化标签）、**结果**（ok/fail 计数，失败可折行，**不** 替代审计日志 `gallery_audit.log`）。

* **FR-Prog-3** 正常完成后 **T秒** 内自动关闭（T 在 `TASKS` 给默认，如 0.4–0.8 s，可配置）；**失败/部分失败** 可 **延长展示** 或转 **可关闭 + 留一处 toast**（具体交互 `TASKS` 固化，须 **不** 阻塞单写者队列观察）。

* **FR-Prog-4（长任务统一模型）** 所有需向用户展示的长时间作业**映射到同一逻辑 Job**（字段至少：`job_id`（可与现有 `bulk_id` / `plan_id` 对齐或别名）、`kind`、`phase`（可选）、`done`、`total`（可选）、`message`（可选）、`terminal: ok|partial|failed`）。**事件载体**（实现择一或组合，须在 `ws_hub` 常量 + SPEC wire 表登记）：
  * 既存 **`bulk.progress` / `bulk.completed`**（`BULK_PROGRESS` / `BULK_COMPLETED`）— **favorite / tags / move / delete** 等；
  * 既存 **`index.progress`**（`INDEX_PROGRESS`）— 冷启/重扫等；
  * 非上述形状的长作业（如 Settings 多阶段）**允许**新增 **`job.progress` / `job.completed`**（或 **`op.progress` / `op.completed`**）**同一 envelope** 形状，**禁止**为进度新建第二 `WriteQueue`、第二端口或旁路 SQLite。

* **FR-Prog-5（晚到 Web 会话）** 若用户在**文件管理器**中已完成大规模变更、**服务端索引/DB 仍在处理**，随后才打开 Gallery 页：客户端必须在 **首屏可订阅 WS 之前或之后立即** 获得**当前活跃 Job 的快照**（推荐 **`GET`** 只读 **`/xyz/gallery/.../jobs/active`** 或等价 bootstrap 字段，**精确路径与 JSON 形状由 `TASKS`/`routes` 固化**）。快照非空时 **自动** 打开 `ProgressModal` 并应用与 **FR-Prog-1** 相同的冻结策略；连接 WS 后继续以**同一 `job_id`** 收增量事件，避免双模态。

* **FR-Prog-6（可见性阈值）** **不得**将「≥3 张」等固定张数作为**唯一**门槛。采用 **时间 + 规模** 组合（默认建议：**预计或已耗时 > 300–500 ms** 且/或 **影响行数超过 `TASKS` 给出的下限** 才显示模态；极短批量仅用 **BulkBar 内联** 或静默合并刷新）。具体常量在 `TASKS` **T44** 固化；目标为减少「进度条一闪而过」与 **NFR-20** 冲突的无效全量刷新。

* ***（T44 工程增补 — 批量路径与 metadata 优化，与 §12.3 / T43「纯移动」一致的精神）*** 除 **`execute_move` / `move_single_image`** 已对 **`UpdateImagePathOp`** 使用 **`refresh_sync=False`** 且跳过无谓 **`metadata_sync.notify`** 外，须 **审计** 下列大批次路径是否仍引入 **不必要的 PNG 整文件回写**、**过密 `metadata_sync.notify`**（每图一次唤醒）或 **可合并的 WriteQueue 往返**：
  * **`bulk_set_favorite`**、**`bulk_edit_tags`**（逐图 `UpdateImageOp` + 逐图 `notify`）；
  * **`tag_admin_rename` / `tag_admin_delete`**（`RenameTagOp` / `DeleteTagByNameOp` 后对受影响图逐条 `_broadcast_image_updated_tags` → `notify`）；
  * **`RelocateFolderSubtreeDbOp`（历史表述·deprecated）** ~~已在**单事务**内批量更新路径并置 **`metadata_sync_status=pending`** — …~~  
    **v1.1 override (2026-04-25)，优先级高于划线段**：**纯磁盘子树重定位**（**`os.rename` / `shutil.move` + 单事务路径改写**）在 **`repo.RelocateFolderSubtreeDbOp`** 中**不**重置 **`metadata_sync_*` 为 `pending`**，与 **`UpdateImagePathOp(refresh_sync=False)`** / **T24** 一致；**不** 触发「仅因换路径」的 **`metadata_sync`** 整文件 PNG 回写。**仍** **不得** 在 relocate 中逐图 `read_comfy_metadata` 入队。若未来某版本需「强制回写侧车」，应显式 **`refresh_sync`-类开关** 或单独 `Resync*`，**不得**再默认把**仅路径变更**与 **`pending` 全库风暴** 绑定。

  * **`execute_delete`**（逐文件 `unlink` 为固有成本；评估是否仅需文档化 **不可** 用「先读后写」替代）；
  * **custom root 注册/移除** 与 **`folder_schedule_rescan`** 触发的 **`indexer.delta_scan`**（与 **FR-Prog-4** 的 **`index.progress`** 合流）。

  上述优化的**验收**写进 **`TASKS.md` T44**（可含子 bullet）；**不改变** C-1 单写者与 **`metadata.write_xyz_chunks`** 原子语义的前提下，优先 **合并唤醒 / 合并事务 / 去冗余 `notify`**。

* **与架构对齐**：进度 **信源** 以 **既存 WS** 为首选；`stores/connection`（或单一 composable）**归一**订阅 **`bulk.*` / `index.progress` /（新增）`job.*`** 后喂给 `ProgressModal`。**禁止** 为进度另开端口或旁路 `repo` / `ws_hub`（C-1、解耦原则不变）。

### 12.5 设计约束与反模式（给实现与未来 AI）

* **Design 约束**：
  * 所有**新**或**改** 的 **visual** 需通过 **`index.html` 内 CSS 变量**（与现有 `--xyz-*` 体系统一）或**同一** stylesheet 中 **token**，**禁止** 在组件上散落硬编码色值作长期方案（一次性 hotfix 须在 `TASKS` 登记为清债）。
  * **Detail 与 Main** 的 `input` / `textarea` / `select` 与**滚动条** 在 **Dark** 下须与主网格区域 **同对比度曲线**（无#fff 槽、无未设 `color-scheme` 的裸控件）。

* **Anti-patterns（禁止）**：
  * 以 **内联 `style=…`** 替代 design token 作为**默认**手段。
  * 用 **纯文字 “Back”/链接色** 充当**全应用**返回 affordance，而 **v1.2 交付** 中已有 **统一 IconButton** 时仍不迁移。（*Updated due to T40*：核心返回路径已落地为 **`js/gallery_dist/components/IconButton.js`** + **`index.html`** 内 **`.ib*`**；**`app.js` 顶栏** 品牌/设置入口**仍**可为文字链，**不**以此条单独构成回归。）
  * 把 **内部列名/队列名/毫秒 debounce** 暴露为 **用户可见** placeholder 或 label。
  * 为 “line view” **单独** 维护第二套列表 truth（**禁止** 第二 SQLite 或旁路 state）；**唯一** 主列表仍为 **REST + 与 MainView 共享的 reactive 数组**。

### 12.6 与 L4 的关系

* **v1.2 不** 以 **L4**（T26–T28）为前置，除非 `TASKS` 某条显式写 **依赖 T26/T28**；**line view 分组** 不得 **依赖** FTS5 或进程池**语义**（仅为可选性能优化让路）。

### 12.7 Backward compatibility

* 覆盖节 **不** 删除 v1.0 / v1.1 API；**view_mode** 与 **Progress** 为增量子状态；`SortSpec` wire **不变**。
* `docs/gallery_update_description.md` **v1.2** 为需求溯源；实现与验收以 **本文 §12** 与 `TASKS.md` **v1.2 段** 为准。
