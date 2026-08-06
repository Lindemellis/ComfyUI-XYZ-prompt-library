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
});

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
