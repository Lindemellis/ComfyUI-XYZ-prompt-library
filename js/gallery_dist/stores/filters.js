// stores/filters.js — FilterSpec + SortSpec reactive store with
// URL-query mirror (FR-4: shareable / bookmarkable) and localStorage
// persistence.
//
// Initialization priority on fresh load:
//   1. URL query (wins, FR-4) if any recognised key is present;
//   2. else localStorage;
//   3. else hard-coded defaults.
//
// Any subsequent mutation fans out to BOTH sinks:
//   * history.replaceState(..., `?<qs>${hash}`) — keeps the hash router
//     (T11) intact; the query string lives before the `#`.
//   * localStorage[STORAGE_KEY] — JSON blob.
//
// Panel collapse state is a separate, boolean-only persistence key
// (FR-2.2.1); it is NOT mirrored to URL.
//
// Not implemented here (by task boundary):
//   * Sort dropdown UI (FR-9b) — that's T13; we still carry SortSpec in
//     the store so T13 can swap it in without re-plumbing persistence.
//   * T21: wire still carries raw comma-split tokens; HTTP layer normalises
//     via ``vocab.*`` before SQL (see ``routes._parse_filter``).
import { reactive, watch } from 'vue';
import { filterVisibility } from './gallerySettings.js';

const STORAGE_KEY = 'xyz_gallery.filters.v1';
const COLLAPSE_KEY = 'xyz_gallery.filter_panel_collapsed.v1';
const CARDS_PER_ROW_KEY = 'xyz_gallery.cards_per_row.v1';
const CARDS_PER_ROW_MIN = 2;
const CARDS_PER_ROW_MAX = 12;
const CARDS_PER_ROW_DEFAULT = 6;

const VALID_FAV = new Set(['all', 'yes', 'no']);
const VALID_SORT_KEY = new Set(['name', 'time', 'size', 'folder']);
const VALID_SORT_DIR = new Set(['asc', 'desc']);
/** T45 — compact grid vs line sections (PROJECT_SPEC §12.2); not mirrored to URL. */
const VALID_VIEW_MODE = new Set(['compact', 'line']);
/** T31 / SPEC §11 F03 — wire ``metadata_presence`` (default ``all`` = omit). */
const VALID_METADATA_PRESENCE = new Set(['all', 'yes', 'no']);
/** T31 / SPEC §11 F04 — wire ``prompt_match_mode`` (default ``prompt`` = omit). */
const VALID_PROMPT_MATCH_MODE = new Set(['prompt', 'word', 'string']);
/** Schema v8 — wire ``media_kind`` (default ``all`` = omit). */
const VALID_MEDIA_KIND = new Set(['all', 'image', 'video']);

/**
 * The two media checkboxes are stored as two booleans (that is what the UI
 * is) but travel as one three-state value, because "both ticked" and
 * "neither ticked" have to mean the same thing — an empty grid is a dead end
 * a user reads as a bug. Both defaults are `true`, so an existing install
 * sees exactly what it saw before videos were indexable.
 */
export function mediaKindOf(f) {
  const img = f.show_images !== false;
  const vid = f.show_videos !== false;
  if (img === vid) return 'all';
  return img ? 'image' : 'video';
}

export const DEFAULT_FILTER = Object.freeze({
  name: '',
  positive_tokens: [],
  tag_tokens: [],
  favorite: 'all',
  model: '',
  date_after: '',
  date_before: '',
  folder_id: null,
  recursive: false,
  metadata_presence: 'all',
  prompt_match_mode: 'prompt',
  show_images: true,
  show_videos: true,
});

export const DEFAULT_SORT = Object.freeze({ key: 'time', dir: 'desc' });
export const DEFAULT_VIEW_MODE = 'compact';

function cloneDefaults() {
  return {
    filter: {
      ...DEFAULT_FILTER,
      positive_tokens: [],
      tag_tokens: [],
      metadata_presence: 'all',
      prompt_match_mode: 'prompt',
      show_images: true,
      show_videos: true,
    },
    sort: { ...DEFAULT_SORT },
    view_mode: DEFAULT_VIEW_MODE,
  };
}

function coerceBool(v) {
  if (v === null || v === undefined) return false;
  const s = String(v).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

function _readURL() {
  let sp;
  try {
    sp = new URLSearchParams(window.location.search);
  } catch {
    return null;
  }
  const { filter, sort } = cloneDefaults();
  let hasAny = false;
  if (sp.has('name')) { filter.name = sp.get('name') || ''; hasAny = true; }
  if (sp.has('model')) { filter.model = sp.get('model') || ''; hasAny = true; }
  if (sp.has('favorite')) {
    const v = sp.get('favorite');
    if (VALID_FAV.has(v)) { filter.favorite = v; hasAny = true; }
  }
  if (sp.has('folder_id')) {
    const n = parseInt(sp.get('folder_id'), 10);
    if (Number.isFinite(n)) { filter.folder_id = n; hasAny = true; }
  }
  if (sp.has('recursive')) { filter.recursive = coerceBool(sp.get('recursive')); hasAny = true; }
  const tags = sp.getAll('tag').filter(Boolean);
  if (tags.length) { filter.tag_tokens = tags; hasAny = true; }
  const prompts = sp.getAll('prompt').filter(Boolean);
  if (prompts.length) { filter.positive_tokens = prompts; hasAny = true; }
  if (sp.has('date_after')) { filter.date_after = sp.get('date_after') || ''; hasAny = true; }
  if (sp.has('date_before')) { filter.date_before = sp.get('date_before') || ''; hasAny = true; }
  if (sp.has('metadata_presence')) {
    const v = (sp.get('metadata_presence') || '').trim().toLowerCase();
    if (VALID_METADATA_PRESENCE.has(v)) { filter.metadata_presence = v; hasAny = true; }
  }
  if (sp.has('prompt_match_mode')) {
    const v = (sp.get('prompt_match_mode') || '').trim().toLowerCase();
    if (VALID_PROMPT_MATCH_MODE.has(v)) { filter.prompt_match_mode = v; hasAny = true; }
  }
  if (sp.has('media_kind')) {
    const v = (sp.get('media_kind') || '').trim().toLowerCase();
    if (VALID_MEDIA_KIND.has(v)) {
      filter.show_images = v !== 'video';
      filter.show_videos = v !== 'image';
      hasAny = true;
    }
  }
  if (sp.has('sort')) {
    const v = sp.get('sort');
    if (VALID_SORT_KEY.has(v)) { sort.key = v; hasAny = true; }
  }
  if (sp.has('dir')) {
    const v = sp.get('dir');
    if (VALID_SORT_DIR.has(v)) { sort.dir = v; hasAny = true; }
  }
  return hasAny ? { filter, sort, view_mode: DEFAULT_VIEW_MODE } : null;
}

function _readLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    const { filter, sort } = cloneDefaults();
    const f = obj.filter || {};
    if (typeof f.name === 'string') filter.name = f.name;
    if (typeof f.model === 'string') filter.model = f.model;
    if (VALID_FAV.has(f.favorite)) filter.favorite = f.favorite;
    if (typeof f.folder_id === 'number' || f.folder_id === null) filter.folder_id = f.folder_id;
    if (typeof f.recursive === 'boolean') filter.recursive = f.recursive;
    if (Array.isArray(f.tag_tokens)) filter.tag_tokens = f.tag_tokens.map(String).filter(Boolean);
    if (Array.isArray(f.positive_tokens)) filter.positive_tokens = f.positive_tokens.map(String).filter(Boolean);
    if (typeof f.date_after === 'string') filter.date_after = f.date_after;
    if (typeof f.date_before === 'string') filter.date_before = f.date_before;
    const mp = f.metadata_presence;
    if (typeof mp === 'string' && VALID_METADATA_PRESENCE.has(mp)) filter.metadata_presence = mp;
    const pmm = f.prompt_match_mode;
    if (typeof pmm === 'string' && VALID_PROMPT_MATCH_MODE.has(pmm)) filter.prompt_match_mode = pmm;
    if (typeof f.show_images === 'boolean') filter.show_images = f.show_images;
    if (typeof f.show_videos === 'boolean') filter.show_videos = f.show_videos;
    const s = obj.sort || {};
    if (VALID_SORT_KEY.has(s.key)) sort.key = s.key;
    if (VALID_SORT_DIR.has(s.dir)) sort.dir = s.dir;
    let view_mode = DEFAULT_VIEW_MODE;
    const vm = obj.view_mode;
    if (typeof vm === 'string' && VALID_VIEW_MODE.has(vm)) view_mode = vm;
    return { filter, sort, view_mode };
  } catch {
    return null;
  }
}

/**
 * URL query wins for filter/sort (FR-4); ``view_mode`` is not in the URL and is
 * merged from the same localStorage blob so deep links keep layout preference
 * (T45 / ARCHITECTURE §7.6 single preference plane with filters store).
 */
function _initialState() {
  const url = _readURL();
  const loc = _readLocal();
  if (url) {
    if (loc && VALID_VIEW_MODE.has(loc.view_mode)) {
      url.view_mode = loc.view_mode;
    } else {
      url.view_mode = DEFAULT_VIEW_MODE;
    }
    return url;
  }
  return loc || cloneDefaults();
}

const _init = _initialState();

export const filterState = reactive({
  filter: _init.filter,
  sort: _init.sort,
  view_mode: VALID_VIEW_MODE.has(_init.view_mode) ? _init.view_mode : DEFAULT_VIEW_MODE,
});

export function setViewMode(mode) {
  const m = String(mode || '').toLowerCase();
  if (VALID_VIEW_MODE.has(m)) filterState.view_mode = m;
}

export const panelCollapsed = reactive({
  filters: (() => {
    try { return localStorage.getItem(COLLAPSE_KEY) === 'true'; }
    catch { return false; }
  })(),
});

export function setPanelCollapsed(v) {
  panelCollapsed.filters = !!v;
  try { localStorage.setItem(COLLAPSE_KEY, panelCollapsed.filters ? 'true' : 'false'); }
  catch { /* storage unavailable — memory state still works */ }
}

// Layout state — T13 cards-per-row slider (FR-9a). SPEC §8.6 lists
// "cards-per-row" as a persisted UI preference alongside filters/sort,
// but it is **not** part of the /images wire query (changing it must
// not refetch). Clamped to [2, 12] per FR-9a and validated on read so
// corrupted localStorage falls back to the default instead of crashing.
function _readCardsPerRow() {
  try {
    const raw = localStorage.getItem(CARDS_PER_ROW_KEY);
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n >= CARDS_PER_ROW_MIN && n <= CARDS_PER_ROW_MAX) return n;
  } catch { /* storage unavailable */ }
  return CARDS_PER_ROW_DEFAULT;
}

export const layoutState = reactive({
  cardsPerRow: _readCardsPerRow(),
});

export function setCardsPerRow(n) {
  const parsed = parseInt(n, 10);
  const v = Math.max(
    CARDS_PER_ROW_MIN,
    Math.min(CARDS_PER_ROW_MAX, Number.isFinite(parsed) ? parsed : CARDS_PER_ROW_DEFAULT),
  );
  layoutState.cardsPerRow = v;
  try { localStorage.setItem(CARDS_PER_ROW_KEY, String(v)); }
  catch { /* storage unavailable */ }
}

// Build the query object passed to api.get('/images', { query: ... }).
// Only includes entries that differ from defaults, to keep wire & URL
// clean and match routes._parse_filter semantics (missing key = no
// filter, 'all' favorite = no favorite filter).
export function apiQueryObject() {
  const f = filterState.filter;
  const s = filterState.sort;
  const fv = filterVisibility;
  const q = {};
  if (fv.name && f.name) q.name = f.name;
  if (fv.model && f.model) q.model = f.model;
  if (fv.favorite && f.favorite && f.favorite !== 'all') q.favorite = f.favorite;
  if (f.folder_id !== null && f.folder_id !== undefined) q.folder_id = f.folder_id;
  if (f.recursive) q.recursive = 'true';
  if (fv.tags && Array.isArray(f.tag_tokens) && f.tag_tokens.length) {
    q.tag = f.tag_tokens;
  }
  if (fv.prompt_tokens && Array.isArray(f.positive_tokens) && f.positive_tokens.length) {
    q.prompt = f.positive_tokens;
  }
  if (fv.dates && f.date_after) q.date_after = f.date_after;
  if (fv.dates && f.date_before) q.date_before = f.date_before;
  if (fv.metadata_presence && f.metadata_presence && f.metadata_presence !== 'all') {
    q.metadata_presence = f.metadata_presence;
  }
  if (fv.prompt_mode && f.prompt_match_mode && f.prompt_match_mode !== 'prompt') {
    q.prompt_match_mode = f.prompt_match_mode;
  }
  if (fv.media_kind !== false) {
    const mk = mediaKindOf(f);
    if (mk !== 'all') q.media_kind = mk;
  }
  q.sort = s.key;
  q.dir = s.dir;
  return q;
}

function _syncURL() {
  const q = apiQueryObject();
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (Array.isArray(v)) for (const item of v) sp.append(k, String(item));
    else sp.append(k, String(v));
  }
  // Sort defaults (time/desc) are kept in the URL so that shared links
  // fully describe the view; FR-4 says URL mirrors the FilterSpec, and
  // SPEC §7.3 lists sort/dir as first-class query params.
  const qs = sp.toString();
  const newURL = window.location.pathname + (qs ? '?' + qs : '') + (window.location.hash || '');
  try { history.replaceState(null, '', newURL); } catch { /* ignore */ }
}

function _persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      filter: filterState.filter,
      sort: filterState.sort,
      view_mode: filterState.view_mode,
    }));
  } catch { /* storage unavailable */ }
}

watch(
  () => [filterState.filter, filterState.sort, filterState.view_mode],
  () => { _syncURL(); _persist(); },
  { deep: true }
);

watch(
  filterVisibility,
  () => { _syncURL(); },
  { deep: true },
);

/** Reset name/tags/dates/model/favorite/sort etc. to defaults; keep folder tree context. */
export function resetFilter() {
  const folderId = filterState.filter.folder_id;
  const recursive = filterState.filter.recursive;
  const { filter, sort } = cloneDefaults();
  Object.assign(filterState.filter, filter);
  Object.assign(filterState.sort, sort);
  filterState.filter.folder_id = folderId;
  filterState.filter.recursive = recursive;
}

// Test / debug hook — lets the semi-automated test harness pretend
// storage was cleared without touching the real user state.
export const _internals = {
  STORAGE_KEY, COLLAPSE_KEY, CARDS_PER_ROW_KEY,
  CARDS_PER_ROW_MIN, CARDS_PER_ROW_MAX, CARDS_PER_ROW_DEFAULT,
  _readURL, _readLocal, _readCardsPerRow,
};
