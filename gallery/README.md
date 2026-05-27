# Image Gallery

**English** | [中文](README_zh.md) · [← Back to main README](../README.md)

Browse and manage your ComfyUI images — auto-indexed, with filtering, tagging, bulk operations, and metadata viewing.

## Opening

Click **Open XYZ Gallery** (the image icon) in the ComfyUI top bar. On first open it scans your `output` and `input` directories and builds a thumbnail index in the background.

## Browsing

### Filters (left panel)

| Filter | Description |
|---|---|
| Folder | Pick a folder, optionally including subfolders |
| Favorites | Only favorited images |
| Tags | Images carrying specific tags (autocompletes from your library) |
| Model | Filter by checkpoint model |
| Prompt | Keyword search within prompts |
| Date range | Filter by file modification time |

Sort by time, filename, size, or folder (ascending / descending).

### View modes

- **Grid** — thumbnail cards.
- **Compact** — dense thumbnails for many images.
- **Line** — grouped rows (by size / date / first letter).
- **Detail** — full metadata for a single image (open by clicking an image).

## Tags

- Add / remove tags on the detail page.
- Bulk-tag selected images.
- Favorites and tags are mirrored into the PNG's metadata so they travel with the file.

## Bulk operations

1. Select multiple images.
2. Choose an operation from the bulk bar: move, delete, favorite, or tag.
3. The gallery runs a preflight check (e.g. name conflicts) and shows progress.
4. Confirm to execute.

## Settings

In the gallery's **Settings** view:

- **Theme** — dark / light.
- **Download** — choose what to include when downloading (e.g. with metadata) via the download picker.
- **Filters** — choose which filter controls are shown.
- **Developer mode** — extra debug information.

## Folders

- Default roots are ComfyUI's `output` and `input`.
- Add custom folders; create subfolders, rename, and move within the tree.

## FAQ

**Images not appearing?** Check your folder settings, or trigger a rescan.

**Thumbnails slow at first?** They are generated on first view, then cached as `.webp`.

**Where is the data?** In `gallery_data/` (gitignored): the index DB and thumbnail cache. Your original images are never modified except for the favorite/tag metadata mirror.
