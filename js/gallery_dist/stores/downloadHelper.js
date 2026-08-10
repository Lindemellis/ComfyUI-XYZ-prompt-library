// Central download flow: optional modal vs saved ``download_variant`` (T36 prefs).
import * as api from '../api.js';
import { downloadPromptEachTime } from './gallerySettings.js';
import { requestDownloadPick } from './downloadPick.js';

/**
 * When ``download_prompt_each_time`` is off: ``undefined``.
 * When on: chosen variant, or ``null`` if user cancelled the modal.
 * @param {{ title?: string }} [opts]
 */
export async function pickDownloadVariantOptional(opts = {}) {
  if (!downloadPromptEachTime.value) return undefined;
  return requestDownloadPick(opts);
}

/**
 * Download one file, falling back to as-is when the variant cannot apply.
 *
 * The two download checkboxes rewrite PNG text chunks, so the backend refuses
 * them (400) for anything that is not a PNG — correctly: it will not pretend
 * to have stripped metadata it cannot reach. But the *caller* asked for a
 * file, so retry for the only form that file has. This predates video: a JPEG
 * or WebP in the library hits it too, which is why the fallback lives here
 * rather than in the video branch.
 *
 * ``api.downloadImage`` always sends a variant — an empty ``opts`` still falls
 * back to the stored default — so "no variant" has to be spelled ``full``.
 */
async function downloadOne(imageId, variant) {
  const opts = variant ? { variant } : {};
  try {
    await api.downloadImage(imageId, opts);
  } catch (e) {
    const canRetry = e && e.status === 400 && e.code === 'invalid_query';
    if (!canRetry) throw e;
    await api.downloadImage(imageId, { variant: 'full' });
  }
}

/**
 * Download one item. ``isVideo`` skips the variant question entirely: the two
 * checkboxes rewrite PNG text chunks, and there is no equivalent surgery for
 * an MP4 that would not mean remuxing the container. A clip downloads as-is,
 * which is also what the backend enforces (``/raw/{id}/download`` rejects any
 * variant but ``full`` for a non-PNG).
 */
export async function executeImageDownload(imageId, { isVideo = false } = {}) {
  if (isVideo) {
    // Skip the question entirely rather than ask it and then ignore the answer.
    await api.downloadImage(imageId, { variant: 'full' });
    return;
  }
  const v = await pickDownloadVariantOptional({ title: 'Download image' });
  if (downloadPromptEachTime.value && v == null) return;
  await downloadOne(imageId, v);
}

/**
 * @param {number[]} ids
 * @param {{ title?: string, gapMs?: number }} [opts]
 */
export async function executeBulkImageDownloads(ids, opts = {}) {
  if (!ids.length) return;
  const title = opts.title || 'Bulk download';
  const gapMs = typeof opts.gapMs === 'number' ? opts.gapMs : 40;
  const v = await pickDownloadVariantOptional({ title });
  if (downloadPromptEachTime.value && v == null) return;
  for (let i = 0; i < ids.length; i += 1) {
    // A mixed selection is normal — the fallback inside is what lets one
    // video (or JPEG) in the middle not abort the rest of the batch.
    await downloadOne(ids[i], v);
    if (i < ids.length - 1) {
      await new Promise((res) => { setTimeout(res, gapMs); });
    }
  }
}
