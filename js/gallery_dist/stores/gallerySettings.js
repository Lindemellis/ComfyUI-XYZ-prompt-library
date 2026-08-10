// T36 gallery UI prefs (server-backed via /preferences) + v1.2 layout / vocab match.
import { DOWNLOAD_VARIANTS } from './downloadVariant.js';
import { ref, reactive } from 'vue';
import { patchGalleryPreferences, setDownloadBasenamePrefix, setDownloadVariant } from '../api.js';

/** MainView splitters — same keys as T32+ ``MainView.js``. */
export const LS_SIDEBAR_W = 'xyz_gallery.sidebar_width_px';
export const LS_FILTERS_H = 'xyz_gallery.filters_pane_height_px';
export const DEFAULT_SIDEBAR_WIDTH_PX = 280;
export const DEFAULT_FILTERS_PANE_HEIGHT_PX = 240;

export function resetLayoutToDefaults() {
  try {
    localStorage.setItem(LS_SIDEBAR_W, String(DEFAULT_SIDEBAR_WIDTH_PX));
    localStorage.setItem(LS_FILTERS_H, String(DEFAULT_FILTERS_PANE_HEIGHT_PX));
  } catch { /* ignore */ }
}

const LS_VOCAB_MATCH = 'xyz_gallery.vocab_autocomplete_match.v1';

function readVocabMatch() {
  try {
    const v = localStorage.getItem(LS_VOCAB_MATCH);
    if (v === 'contains' || v === 'prefix') return v;
  } catch { /* ignore */ }
  return 'prefix';
}

export const vocabAutocompleteMatch = ref(readVocabMatch());

export function setVocabAutocompleteMatch(mode) {
  const m = mode === 'contains' ? 'contains' : 'prefix';
  vocabAutocompleteMatch.value = m;
  try {
    localStorage.setItem(LS_VOCAB_MATCH, m);
  } catch { /* ignore */ }
}

export const developerMode = ref(false);
export const theme = ref('dark');

export const filterVisibility = reactive({
  name: true,
  metadata_presence: true,
  prompt_mode: true,
  prompt_tokens: true,
  tags: true,
  favorite: true,
  model: true,
  dates: true,
  media_kind: true,
});

// -- Video playback preferences (schema v8) --------------------------------
//
// Local-only, unlike the download/filter prefs above: these describe how this
// browser should behave, and a hover-preview setting that followed you onto a
// different machine with a different GPU would be the wrong default there.

const LS_VIDEO_PREFS = 'xyz_gallery.video_prefs.v1';

const VIDEO_PREF_DEFAULTS = Object.freeze({
  /** Play a muted preview when the pointer rests on a video card. */
  hoverPreview: true,
  /**
   * Start playing as soon as a clip is opened. Safe to default on only
   * because ``muted`` also defaults on — a browser refuses to autoplay audible
   * media, and a refused play() leaves the clip paused on its poster frame,
   * which is exactly the autoplay-off experience.
   */
  autoplay: true,
  /** Start the detail-page player looping. */
  loop: false,
  /**
   * Start the detail-page player muted. Default ON deliberately: opening a
   * clip from a grid should never blast audio at someone browsing quietly,
   * and the volume they choose is remembered from then on.
   */
  muted: true,
  /** Last volume the user set, 0..1. Restored on the next clip. */
  volume: 1,
});

function readVideoPrefs() {
  const out = { ...VIDEO_PREF_DEFAULTS };
  try {
    const raw = localStorage.getItem(LS_VIDEO_PREFS);
    if (!raw) return out;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return out;
    if (typeof obj.hoverPreview === 'boolean') out.hoverPreview = obj.hoverPreview;
    if (typeof obj.autoplay === 'boolean') out.autoplay = obj.autoplay;
    if (typeof obj.loop === 'boolean') out.loop = obj.loop;
    if (typeof obj.muted === 'boolean') out.muted = obj.muted;
    const v = Number(obj.volume);
    if (Number.isFinite(v) && v >= 0 && v <= 1) out.volume = v;
  } catch { /* storage unavailable / corrupt — defaults are fine */ }
  return out;
}

export const videoPrefs = reactive(readVideoPrefs());

export function setVideoPref(key, value) {
  if (!Object.prototype.hasOwnProperty.call(VIDEO_PREF_DEFAULTS, key)) return;
  if (key === 'volume') {
    const v = Number(value);
    videoPrefs.volume = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
  } else {
    videoPrefs[key] = !!value;
  }
  try {
    localStorage.setItem(LS_VIDEO_PREFS, JSON.stringify({ ...videoPrefs }));
  } catch { /* storage unavailable — in-memory state still works */ }
}

export function resetVideoPrefs() {
  Object.assign(videoPrefs, VIDEO_PREF_DEFAULTS);
  try { localStorage.setItem(LS_VIDEO_PREFS, JSON.stringify({ ...videoPrefs })); }
  catch { /* ignore */ }
}

/** MainView bumps filters pane height to fit visible filters after Settings → Save. */
export const filtersPaneFitRequest = ref(0);

export const downloadBasenamePrefix = ref('');
/** When true, each download opens a variant picker; ``download_variant`` is ignored until then. */
export const downloadPromptEachTime = ref(false);

function _normalizeDownloadVariant(v) {
  const s = (v && String(v).trim()) || 'full';
  return DOWNLOAD_VARIANTS.includes(s) ? s : 'full';
}

/** The remembered answer to the download modal's two checkboxes. */
export const downloadVariant = ref('full');

/** Remember the checkboxes — locally at once, and on the server so it survives a
 *  reload. Fire and forget: a preference that failed to save must not stop a
 *  download the user already asked for. */
export function rememberDownloadVariant(variant) {
  const v = _normalizeDownloadVariant(variant);
  downloadVariant.value = v;
  setDownloadVariant(v);
  patchGalleryPreferences({ download_variant: v }).catch(() => {});
}

/** Apply ``GET /preferences`` payload to reactive store + download filename hook. */
export function applyServerPreferences(p) {
  if (!p || typeof p !== 'object') return;
  if (typeof p.developer_mode === 'boolean') {
    developerMode.value = p.developer_mode;
  }
  if (p.theme === 'light' || p.theme === 'dark') {
    theme.value = p.theme;
  }
  if (typeof p.download_prompt_each_time === 'boolean') {
    downloadPromptEachTime.value = p.download_prompt_each_time;
  }
  if (p.download_variant != null) {
    downloadVariant.value = _normalizeDownloadVariant(p.download_variant);
    setDownloadVariant(downloadVariant.value);
  }
  if (p.download_basename_prefix != null) {
    downloadBasenamePrefix.value = String(p.download_basename_prefix || '');
    setDownloadBasenamePrefix(downloadBasenamePrefix.value);
  }
  if (p.filter_visibility && typeof p.filter_visibility === 'object') {
    const fv = p.filter_visibility;
    Object.keys(filterVisibility).forEach((k) => {
      if (Object.prototype.hasOwnProperty.call(fv, k)) {
        filterVisibility[k] = !!fv[k];
      }
    });
  }
}

export function applyThemeToDocument() {
  const t = theme.value === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-xyz-gallery-theme', t);
}
