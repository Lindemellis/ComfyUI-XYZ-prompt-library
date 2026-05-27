# Image Gallery

Browse and manage ComfyUI output images. Auto-indexing, tag management, bulk operations, metadata viewing.

## Opening

Click the **Gallery** button in ComfyUI's top bar, or navigate to `/xyz/gallery`.

On first open, the gallery automatically scans your `output` and `input` directories.

## Browsing Images

### Filters

The left panel provides filter controls:

| Filter | Description |
|---|---|
| Folder | Select a folder, optionally include subfolders |
| Favorites | Only show favorited images |
| Tags | Images with specific tags (multiple supported) |
| Model | Filter by checkpoint model |
| Prompt | Search for keywords in prompts |
| Date range | Filter by file modification time |

### Sorting

By time, filename, file size, or folder, ascending or descending.

### View Modes

- **Grid view**: Thumbnail cards for quick browsing
- **Compact view**: Dense thumbnails for many images
- **Line view**: Grouped by size/date/first letter
- **Detail view**: Full metadata for a single image

## Tags

- Add/remove tags on the image detail page
- Bulk tag operations on selected images
- Settings → Tag management to rename, delete, or clean up tags

## Bulk Operations

1. Select multiple images
2. Choose operation: move, delete, favorite, tag
3. System runs a preflight check (disk space, name conflicts)
4. Confirm to execute

## Settings

Settings panel inside the Gallery page:

- **Theme**: dark / light
- **Download mode**: original / with metadata
- **Filter visibility**: choose which filters to show
- **Developer mode**: extra debug info

## Folder Management

- Default folders: ComfyUI `output` and `input`
- Add custom folders
- Create subfolders, rename, move

## FAQ

**Images not appearing?** Check folder settings, or manually click Rescan.

**Thumbnails loading slowly?** First visit generates thumbnails — cached after that.

**Tags written back to files?** Favorites and tags auto-write to PNG metadata chunks.

[中文版 (Chinese)](README_zh.md)
