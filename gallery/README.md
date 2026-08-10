# Image Gallery

**English** | [中文](README_zh.md) · [← Back to main README](../README.md)

Browse and manage your ComfyUI images **and videos** — auto-indexed, with filtering, tagging, bulk operations, and metadata viewing.

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
| Media | Two checkboxes: images / videos. Ticking neither is the same as ticking both (shows everything) |

Sort by time, filename, size, or folder (ascending / descending).

### View modes

- **Grid** — thumbnail cards.
- **Compact** — dense thumbnails for many images.
- **Line** — grouped rows (by size / date / first letter).
- **Detail** — full metadata for a single image (open by clicking an image).

## Videos

`.mp4`, `.webm`, `.mkv`, `.mov` and `.m4v` are indexed alongside images and share the
same detail page — favourite, tags, delete and generation data are identical; the only
addition is the duration, shown next to the dimensions.

- **Grid** — the thumbnail is a frame taken from the clip (10% in, capped at 1 s; never
  frame 0, because generated video so often opens on black). The corner shows the
  duration, plus a ♪ when the clip has audio. Resting the pointer on a card plays a
  muted preview.
- **Player** — play/pause, scrub, ±5 s, **frame stepping**, volume, speed (0.25×–2×), loop.
- **Save frame** — write the frame on screen out as a PNG, ready to use as a reference
  or to send to Krita.
- **Generation data** — ComfyUI writes the same workflow JSON into an MP4 that it writes
  into a PNG, so prompts, model and seed show up as usual.

Two deliberate limits:

- **Videos cannot be sent to Krita** (there is no video layer), so the button is absent
  on a clip.
- **Videos download as-is.** The two download checkboxes rewrite PNG text chunks; there
  is no equivalent operation on an MP4.

> **Two MP4s per generation?** ComfyUI video workflows often emit a silent `X.mp4` and a
> muxed `X-audio.mp4` for one run. The gallery indexes **only the one with sound**, or
> every generation would appear twice in the grid. To keep both, set
> `video_audio_twin_suffixes` to `[]` in `gallery_data/gallery_config.json`.

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
- **Download** — choose what to include when downloading (e.g. with metadata) via the download picker. PNG only.
- **Video** — card hover preview, autoplay on open, default loop, start muted. Stored in this browser only.
- **Filters** — choose which filter controls are shown.
- **Image metadata** — re-read files whose generation data is incomplete. Worth running
  after the workflow reader learns a new graph shape (it now follows
  `SamplerCustomAdvanced` and pipe-routed conditioning), which recovers the model and
  prompt on older images.
- **Developer mode** — extra debug information.

## Folders

- Default roots are ComfyUI's `output` and `input`.
- Add custom folders; create subfolders, rename, and move within the tree.

## FAQ

**Images not appearing?** Check your folder settings, or trigger a rescan.

**Videos not appearing?** Video needs PyAV, which ComfyUI already depends on — normally
nothing to do. If `av` is missing from the environment, videos are skipped silently and
images are unaffected. Also check the "videos" filter checkbox is still ticked.

**Generation data blank?** Go to **Settings → Image metadata** and click "Re-read missing
metadata". It re-reads the files with incomplete fields in the background.

**Thumbnails slow at first?** They are generated on first view, then cached as `.webp`.

**Where is the data?** In `gallery_data/` (gitignored): the index DB and thumbnail cache. Your original images are never modified except for the favorite/tag metadata mirror.
