/**
 * XYZ Tag Autocomplete (tagac) — Danbooru/Gelbooru tag autocomplete for ComfyUI.
 *
 * Hooks every multiline STRING textarea (ComfyWidgets.STRING override +
 * MutationObserver fallback). Debounces input → queries /xyz/tagdb/search →
 * shows a dropdown at the caret position.
 *
 * Guard flag: element._xyzTagACHooked — prevents double-attachment alongside
 * the PLv2 hook (_plv2Hooked) or other extensions.
 *
 * Category colors (danbooru convention):
 *   0 general → #aaddff   1 artist  → #ffaacc
 *   3 copyright → #dd88ff  4 character → #aaffaa   5 meta → #ffee88
 */

import { app } from '../../../scripts/app.js';
import { ComfyWidgets } from '../../../scripts/widgets.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const EXT_ID   = 'XYZNodes.TagAutocomplete';
const EXT_NAME = 'XYZ Tag Autocomplete';

const DEBOUNCE_MS = 70;

const CATEGORY_COLORS = {
  0: '#aaddff',  // general
  1: '#ffaacc',  // artist
  3: '#dd88ff',  // copyright
  4: '#aaffaa',  // character
  5: '#ffee88',  // meta
};

const CATEGORY_NAMES = {
  0: 'general', 1: 'artist', 3: 'copyright', 4: 'character', 5: 'meta',
};

// Default delimiter used when the textarea has no custom one.
const DEFAULT_DELIM = ', ';

// ─── Settings ─────────────────────────────────────────────────────────────────

const settings = {
  enabled: true,
  maxSuggestions: 15,
  replaceUnderscore: true,
  autoInsertComma: true,
  escapeParens: true,      // escape ( ) in inserted tags (prompt weight syntax)
  enableRelated: false,
  minPostCount: 0,         // client-side: hide suggestions below this post count
  relatedMaxAgeDays: 30,   // related cache freshness window
  showArtistPreview: false, // show 🖼 artist works popup on hover
  showTagPreview: false,    // show preview image for any tag on hover
  previewCount: 1,          // how many preview images to show (1–10)
  halfwidth: false,        // full-width （） → half-width on insert
  // Prompt Library sources
  useLibrary: true,        // suggest prompts from the Prompt Library (tag mode)
  maxLibrary: 10,          // cap on library suggestions shown
  useRefs: true,           // suggest entry/trigger refs after "[" or "/"
  maxRefs: 10,             // cap on ref suggestions
  // Dataset
  scrapeMin: 50,           // default scrape threshold (count >= N)
  // Tag sources feeding autocomplete (gelbooru only contributes if installed).
  sourceDanbooru: true,
  sourceGelbooru: true,
  // Anima "@artist" syntax: typing "@name" suggests artist tags (inserted as "@name"),
  // and clicking an "@name" prompt resolves it to the artist for its detail/related view.
  animaArtist: false,
};

// Single shared settings object. The unified settings page (xyz_settings.js)
// mutates this; we persist it to localStorage and load it back on startup.
const _SETTINGS_KEY = 'xyzAcSettings_v1';
try { Object.assign(settings, JSON.parse(localStorage.getItem(_SETTINGS_KEY) || '{}')); } catch {}
settings.save = function () {
  try {
    const { save, ...plain } = settings;
    localStorage.setItem(_SETTINGS_KEY, JSON.stringify(plain));
  } catch {}
};
window.xyzAcSettings = settings;

// ─── API ─────────────────────────────────────────────────────────────────────

// Small LRU-ish cache so re-typing / deleting doesn't re-hit the server.
const _searchCache = new Map();
const _SEARCH_CACHE_MAX = 300;

// Comma-joined enabled sources for the ?source= filter. Read lazily (settings can
// change at runtime). gelbooru is silently ignored server-side if not installed.
function _enabledSourcesParam() {
  const s = [];
  if (settings.sourceDanbooru !== false) s.push('danbooru');
  if (settings.sourceGelbooru !== false) s.push('gelbooru');
  return s.join(',');
}

async function searchTags(q, limit, category) {
  const src = _enabledSourcesParam();
  const catKey = category == null ? '' : String(category);
  const key = `${limit}|${src}|${catKey}|${q}`;   // include sources/category so toggling re-queries
  const hit = _searchCache.get(key);
  if (hit) return hit;
  try {
    const catParam = category == null ? '' : `&category=${encodeURIComponent(category)}`;
    const r = await fetch(`/xyz/tagdb/search?q=${encodeURIComponent(q)}&limit=${limit}&source=${encodeURIComponent(src)}${catParam}`);
    if (!r.ok) return [];
    const data = await r.json();
    if (_searchCache.size >= _SEARCH_CACHE_MAX) _searchCache.clear();
    _searchCache.set(key, data);
    return data;
  } catch {
    return [];
  }
}

// Cache tag preview metadata in memory: {tag: {posts, fetched_at}}
const _previewCache = new Map();
const _PREVIEW_CACHE_MAX = 200;

async function fetchTagPreview(name, limit) {
  const cached = _previewCache.get(name);
  if (cached && cached.posts.length >= limit) {
    return cached.posts.slice(0, limit);
  }
  const url = `/xyz/tagdb/tag_preview?name=${encodeURIComponent(name)}&limit=${limit}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const data = await r.json();
    const posts = data.posts || [];
    if (posts.length) {
      if (_previewCache.size >= _PREVIEW_CACHE_MAX) {
        const oldest = _previewCache.keys().next().value;
        _previewCache.delete(oldest);
      }
      _previewCache.set(name, { posts, fetched_at: Date.now() });
    }
    return posts.slice(0, limit);
  } catch { return []; }
}

async function fetchRelated(tag, limit) {
  try {
    const r = await fetch(`/xyz/tagdb/related?q=${encodeURIComponent(tag)}&limit=${limit}&max_age_days=${settings.relatedMaxAgeDays}`);
    if (!r.ok) return [];
    const data = await r.json();
    // Related tags are computed by danbooru → tag them as danbooru-sourced so the row
    // shows the clickable D token (→ danbooru wiki), consistent with all other rows.
    return (data.related || []).map((x) => ({
      kind: 'tag', name: x.name, category: x.category, aliases: [],
      post_count: x.post_count, frequency: x.frequency, overlap: x.overlap,
      sources: ['danbooru'],
    }));
  } catch {
    return [];
  }
}

function _applyMinCount(results) {
  if (!settings.minPostCount) return results;
  return results.filter((r) => (r.post_count ?? Infinity) >= settings.minPostCount);
}

// Library prompts matching q → candidates {kind:'library', name, entry}.
// Pure [ref] entries (e.g. "[toki.official_custome]") are filtered out —
// ref autocomplete is only shown after typing "[" or "/".
async function fetchLibraryPrompts(q, limit) {
  try {
    const r = await fetch(`/xyz/plv2/ac/prompts?q=${encodeURIComponent(q)}&limit=${limit}`);
    if (!r.ok) return [];
    const data = await r.json();
    const pureRef = /^\[[^\]]+\]$/;
    return (data.prompts || [])
      .filter((p) => !pureRef.test((p.content || '').trim()))
      .map((p) => ({
        kind: 'library', name: p.content, entry: p.entry_name || p.full_path || '',
      }));
  } catch { return []; }
}

// Entry/trigger refs matching q.
// Entry names and their alias triggers are merged into one option per entry.
// Each merged candidate has {kind:'ref', refKind, names:[...], selIdx, definition}.
async function fetchRefs(q, limit, refKind) {
  try {
    const r = await fetch(`/xyz/plv2/ac/refs?q=${encodeURIComponent(q)}&limit=${limit}`);
    if (!r.ok) return [];
    const data = await r.json();
    const raw = (data.refs || []);

    // Group triggers by their owning entry's full_path
    const triggersByEntry = new Map();
    const entries = [];

    // Track node ID and auto_trigger per full_path
    const idByPath = new Map();
    const autoByPath = new Map();

    for (const x of raw) {
      if (x.kind === 'entry') {
        entries.push({ name: x.name, definition: x.definition, id: x.id, auto_trigger: x.auto_trigger });
        if (x.id != null) idByPath.set(x.name, x.id);
        if (x.auto_trigger) autoByPath.set(x.name, x.auto_trigger);
      } else {
        const fp = x.definition;
        if (!triggersByEntry.has(fp)) triggersByEntry.set(fp, []);
        triggersByEntry.get(fp).push(x.name);
        if (x.id != null && !idByPath.has(fp)) idByPath.set(fp, x.id);
      }
    }

    // Merge: each entry + its triggers into one row.
    const merged = [];
    const seenPaths = new Set();

    for (const e of entries) {
      const fp = e.name;
      if (seenPaths.has(fp)) continue;
      seenPaths.add(fp);
      const trigs = triggersByEntry.get(fp) || [];
      const allNames = [fp];
      for (const t of trigs) { if (!allNames.includes(t)) allNames.push(t); }
      const auto = e.auto_trigger || autoByPath.get(fp) || null;
      merged.push({
        kind: 'ref', refKind,
        names: allNames,
        definition: e.definition,
        auto_trigger: auto,
        id: e.id || idByPath.get(fp) || null,
      });
    }

    // Orphan triggers (entry not in results)
    for (const [fp, trigs] of triggersByEntry) {
      if (!seenPaths.has(fp) && trigs.length) {
        seenPaths.add(fp);
        merged.push({
          kind: 'ref', refKind,
          names: trigs,
          definition: fp,
          auto_trigger: autoByPath.get(fp) || null,
          id: idByPath.get(fp) || null,
        });
      }
    }

    return merged.slice(0, limit);
  } catch { return []; }
}

// Resolve an entry ref to its shallow text (for "/entry" insertion).
async function resolveShallow(ref) {
  try {
    const r = await fetch('/xyz/plv2/resolve_shallow', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.found ? (d.text || '') : null;
  } catch { return null; }
}

// Entries whose prompts contain q → {id, name, full_path, pos_neg, delimiter, auto_trigger}.
async function fetchEntriesByPrompt(q, limit) {
  try {
    const r = await fetch(`/xyz/plv2/ac/entries_by_prompt?q=${encodeURIComponent(q)}&limit=${limit}`);
    if (!r.ok) return [];
    const data = await r.json();
    return (data.entries || []).map((e) => ({
      kind: 'plv2_entry',
      id: e.id,
      name: e.name,
      full_path: e.full_path,
      pos_neg: e.pos_neg,
      delimiter: e.delimiter,
      auto_trigger: e.auto_trigger,
      has_prompts: true,
    }));
  } catch { return []; }
}

// Fetch an entry's prompt text for preview.
async function fetchEntryPreview(nodeId) {
  try {
    const r = await fetch(`/xyz/plv2/nodes/${nodeId}/preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seed: 0 }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.text || '';
  } catch { return null; }
}

// Resolve a ref and return the entry node.
async function resolveRefEntry(refInner) {
  try {
    const r = await fetch('/xyz/plv2/resolve_ref', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: refInner }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.node || null;
  } catch { return null; }
}

// Extract the inner text of a [ref] at caret position.
function _refAtCaret(text, pos) {
  const re = /\[([^\[\]\n]*)\]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (pos >= m.index && pos <= m.index + m[0].length) return m[1];
  }
  return null;
}

// Normalise a prompt/tag name to canonical underscore form for dedup comparison.
// Strips backslash escapes and weight parens, then spaces → underscores.
function _canonicalName(name) {
  return (name || '')
    .replace(/\\([()])/g, '$1')       // unescape \( → (, \) → )
    .replace(/^\s*[\(\<]+/, '').replace(/[\)\>]+\s*$/, '')  // strip weight wrappers
    .trim()
    .replace(/\s+/g, '_')
    .toLowerCase();
}

// Merge tag + library candidates for tag mode: library first, drop a library prompt
// whose text matches a danbooru tag (canonical underscore form comparison).
function _mergeTagSources(tags, library) {
  const tagNames = new Set(tags.map((t) => _canonicalName(t.name)));
  const lib = library
    .filter((p) => !tagNames.has(_canonicalName(p.name)))
    .slice(0, settings.maxLibrary);
  return [...lib, ...tags];
}

// ─── Artist works popup ─────────────────────────────────────────────────────────

let _artistWin = null;

async function showArtistWorks(name) {
  if (!_artistWin) {
    _artistWin = document.createElement('div');
    Object.assign(_artistWin.style, {
      position: 'fixed', top: '60px', left: '50%', transform: 'translateX(-50%)',
      width: '600px', maxWidth: '90vw', maxHeight: '80vh', overflowY: 'auto',
      background: '#1a1a2e', border: '1px solid #444', borderRadius: '8px',
      boxShadow: '0 8px 32px rgba(0,0,0,.6)', zIndex: '100000', padding: '10px',
      color: '#ddd', font: '13px sans-serif',
    });
    document.body.appendChild(_artistWin);
  }
  const win = _artistWin;
  win.style.display = 'block';
  const display = settings.replaceUnderscore ? name.replace(/_/g, ' ') : name;
  win.innerHTML = '';
  const bar = document.createElement('div');
  Object.assign(bar.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' });
  bar.innerHTML = `<b>Recent works — ${display}</b>`;
  const close = document.createElement('span');
  close.textContent = '✕'; close.style.cursor = 'pointer'; close.style.padding = '0 6px';
  close.addEventListener('click', () => { win.style.display = 'none'; });
  bar.appendChild(close);
  win.appendChild(bar);
  const status = document.createElement('div');
  status.textContent = 'Loading…';
  win.appendChild(status);

  let posts = [];
  try {
    const r = await fetch(`/xyz/tagdb/artist_posts?name=${encodeURIComponent(name)}&limit=24`);
    posts = (await r.json()).posts || [];
  } catch { /* ignore */ }

  if (!posts.length) { status.textContent = 'No works found (or fetch failed).'; return; }
  status.remove();
  const grid = document.createElement('div');
  Object.assign(grid.style, { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px' });
  for (const p of posts) {
    const a = document.createElement('a');
    a.href = `https://danbooru.donmai.us/posts/${p.id}`;
    a.target = '_blank';
    const img = document.createElement('img');
    img.src = p.preview_url;
    img.loading = 'lazy';
    Object.assign(img.style, { width: '100%', borderRadius: '4px', display: 'block' });
    if (p.rating && p.rating !== 'g' && p.rating !== 's') img.style.filter = 'blur(0px)';
    a.appendChild(img);
    grid.appendChild(a);
  }
  win.appendChild(grid);
}

// ─── Shared tag preview popup ──────────────────────────────────────────────────

let _tagPvPop = null;
let _tagPvTimer = null;
let _tagPvTag = null;       // which tag the popup was built for
let _tagPvIsGrid = false;

async function _showTagPreviewPopup(anchor, tagName, limit) {
  // If already showing for this tag, just reposition
  if (_tagPvPop && _tagPvTag === tagName) {
    clearTimeout(_tagPvTimer);
    _tagPvPop.style.display = _tagPvIsGrid ? 'flex' : 'block';
    _positionPvPop(anchor);
    return;
  }
  // Clear any pending hide
  clearTimeout(_tagPvTimer);

  // Remove old popup if switching to a different tag
  if (_tagPvPop) { _tagPvPop.remove(); _tagPvPop = null; }

  // Create popup immediately with loading state
  _tagPvPop = document.createElement('div');
  _tagPvPop.className = 'xyz-tagac-preview-pop';
  Object.assign(_tagPvPop.style, {
    position: 'fixed', zIndex: '100020', background: '#1e1e2e',
    border: '1px solid #45475a', borderRadius: '6px',
    boxShadow: '0 4px 16px rgba(0,0,0,.6)',
    padding: '8px 12px', fontSize: '12px', color: '#fff',
    minWidth: '80px', minHeight: '24px', display: 'block',
  });
  _tagPvPop.textContent = 'Loading…';
  _tagPvIsGrid = false;
  _tagPvTag = tagName;
  document.body.appendChild(_tagPvPop);
  _tagPvPop.addEventListener('mouseenter', () => clearTimeout(_tagPvTimer));
  _tagPvPop.addEventListener('mouseleave', () => _hideTagPreviewPopup());
  _positionPvPop(anchor);
  // Fetch and update
  const posts = await fetchTagPreview(tagName, limit);
  if (_tagPvTag !== tagName) return;
  _tagPvPop.innerHTML = '';
  if (!posts.length) {
    Object.assign(_tagPvPop.style, {
      maxWidth: '', padding: '8px 12px', display: 'block',
      fontSize: '12px', color: '#888', minWidth: '80px', minHeight: '24px',
    });
    _tagPvPop.textContent = 'No preview available';
    _tagPvIsGrid = false;
  } else {
    Object.assign(_tagPvPop.style, {
      width: 'fit-content', maxWidth: '90vw', maxHeight: '70vh',
      padding: '4px', display: 'flex', gap: '4px',
      alignItems: 'flex-start', minWidth: '', minHeight: '',
      overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: '#45475a transparent',
    });
    _tagPvIsGrid = true;
    for (const p of posts) {
      const a = document.createElement('a');
      a.href = `https://danbooru.donmai.us/posts/${p.id}`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = `Post #${p.id} (rating: ${p.rating || '?'})`;
      Object.assign(a.style, { display: 'block', cursor: 'pointer' });
      a.addEventListener('mousedown', (e) => { e.stopPropagation(); });
      const img = document.createElement('img');
      img.src = `/xyz/tagdb/preview_image?url=${encodeURIComponent(p.preview_url)}`;
      img.loading = 'lazy';
      Object.assign(img.style, {
        height: '180px', borderRadius: '4px', display: 'block',
      });
      a.appendChild(img);
      _tagPvPop.appendChild(a);
    }
    // Reposition after first image loads
    const firstImg = _tagPvPop.querySelector('img');
    if (firstImg) firstImg.addEventListener('load', () => _positionPvPop(anchor), { once: true });
  }
  _positionPvPop(anchor);
}

function _positionPvPop(anchor) {
  if (!_tagPvPop) return;
  const r = anchor.getBoundingClientRect();
  const gap = 6;
  // Prefer right side; fall back to left
  let left = r.right + gap;
  if (left + 200 > window.innerWidth - 10) left = r.left - 200 - gap;
  if (left < 4) left = 4;
  // Available width and height
  const availW = Math.min(window.innerWidth - left - 10, window.innerWidth - 10);
  const availH = window.innerHeight - r.top - 20;
  // Column layout if narrow space; row + wrap otherwise
  const useColumn = availW < 350;
  _tagPvPop.style.flexDirection = useColumn ? 'column' : 'row';
  _tagPvPop.style.flexWrap = useColumn ? 'nowrap' : 'wrap';
  _tagPvPop.style.maxWidth = availW + 'px';
  _tagPvPop.style.maxHeight = Math.min(availH, window.innerHeight * 0.7) + 'px';
  _tagPvPop.style.top = Math.max(4, r.top) + 'px';
  _tagPvPop.style.left = left + 'px';
}

function _hideTagPreviewPopup() {
  _tagPvTimer = setTimeout(() => {
    if (_tagPvPop) { _tagPvPop.style.display = 'none'; }
  }, 250);
}

// ─── Caret position helper ────────────────────────────────────────────────────
// Based on https://github.com/component/textarea-caret-position (MIT)

const _CARET_PROPS = [
  'direction', 'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'borderStyle', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize',
  'fontSizeAdjust', 'lineHeight', 'fontFamily',
  'textAlign', 'textTransform', 'textIndent', 'textDecoration',
  'letterSpacing', 'wordSpacing', 'tabSize',
];

function getCaretCoordinates(el) {
  const computed = window.getComputedStyle(el);
  const div = document.createElement('div');
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = 'pre-wrap';
  div.style.wordWrap = 'break-word';
  for (const p of _CARET_PROPS) div.style[p] = computed[p];
  div.style.overflow = 'hidden';
  document.body.appendChild(div);

  div.textContent = el.value.substring(0, el.selectionStart);
  const span = document.createElement('span');
  span.textContent = el.value.substring(el.selectionStart) || '.';
  div.appendChild(span);

  const rect = el.getBoundingClientRect();
  const lineH = parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) * 1.2;
  // Viewport caret position = textarea's viewport top/left + the caret's offset
  // inside the (unscrolled) mirror content, MINUS the textarea's own scroll. The
  // scroll term must be subtracted; adding it pushed the dropdown far off in a
  // scrolled multiline box, where the flip-above fallback then covered the line.
  const coords = {
    top:  rect.top  - el.scrollTop  + span.offsetTop  + (parseInt(computed.borderTopWidth)  || 0),
    left: rect.left - el.scrollLeft + span.offsetLeft + (parseInt(computed.borderLeftWidth) || 0),
    lineHeight: lineH,
  };
  document.body.removeChild(div);
  return coords;
}

// ─── Partial-tag extraction ───────────────────────────────────────────────────

function _tokenStart(text, pos) {
  // Token boundaries: comma, newline, and ". " (period+space) to match the
  // Prompt Library's delimiter handling.
  const lastComma   = text.lastIndexOf(',', pos - 1);
  const lastNewline = text.lastIndexOf('\n', pos - 1);
  let start = Math.max(lastComma, lastNewline) + 1;
  const lastDotSpace = text.lastIndexOf('. ', pos - 1);
  if (lastDotSpace !== -1) start = Math.max(start, lastDotSpace + 2);
  return start;
}

function _tokenEnd(text, pos) {
  let end = text.length;
  for (const idx of [text.indexOf(',', pos), text.indexOf('\n', pos), text.indexOf('. ', pos)]) {
    if (idx !== -1) end = Math.min(end, idx);
  }
  return end;
}

function getPartialTag(el) {
  const text = el.value;
  const pos  = el.selectionStart;

  const start = _tokenStart(text, pos);
  const segment = text.substring(start, pos);

  // Don't trigger inside weight modifiers like :1.2
  const colonIdx = segment.lastIndexOf(':');
  if (colonIdx !== -1) {
    const after = segment.substring(colonIdx + 1);
    if (/^\d*\.?\d+$/.test(after.trim())) return '';
  }

  // Don't trigger inside [ref] brackets (PLv2 references)
  const lastOpen  = text.lastIndexOf('[', pos - 1);
  const lastClose = text.lastIndexOf(']', pos - 1);
  if (lastOpen > lastClose) return '';

  // Don't trigger inside {choice} braces
  const lastBrace  = text.lastIndexOf('{', pos - 1);
  const lastClosed = text.lastIndexOf('}', pos - 1);
  if (lastBrace > lastClosed) return '';

  // Strip leading paren/angle-bracket weight wrappers and spaces
  const partial = segment.replace(/^\s*[\(\<]+/, '').trim();

  // Canonical search form: danbooru tag names use underscores, so normalise the
  // user's spaces → underscores (e.g. "yd (orange maru" → "yd_(orange_maru").
  return partial.replace(/\s+/g, '_');
}

// Full tag token surrounding the caret (both directions), canonical underscore
// form — used for "click a prompt → related tags".
// Unescapes \( → ( and \) → ) before canonicalising.
// Only strips paired wrapping parens, not parens that are part of the tag name.
function getTokenAtCaret(el) {
  const text = el.value;
  const pos  = el.selectionStart;
  const start = _tokenStart(text, pos);
  const end = _tokenEnd(text, pos);
  let tok = text.substring(start, end).trim();

  // Drop a trailing weight suffix like ":1.1" but KEEP any close-wrapper that followed it,
  // so "(wlop:1.1)" → "(wlop)" (not "(wlop", which would leave the leading "(" unbalanced
  // and unstripped). The number is always at the token end; the captured ) / > is restored
  // for the paired strip below. Escaped \( \) inside a name aren't ":num", so untouched.
  tok = tok.replace(/:\s*\d*\.?\d+\s*([\)\>]*)\s*$/, '$1').trim();

  // Strip balanced wrapping emphasis: "(tag)" / "<tag>" / "((tag))" → "tag". The loop only
  // peels a wrapper when BOTH ends have one, and escaped parens start with a backslash (so
  // they never sit at the leading edge) — thus "(yd \(orange maru\):1.1)" → "yd \(orange maru\)".
  while (/^[\(\<]/.test(tok) && /[\)\>]$/.test(tok)) {
    tok = tok.replace(/^[\(\<]/, '').replace(/[\)\>]$/, '').trim();
  }

  // Unescape backslash-escaped parens before canonicalising to underscore form
  tok = tok.replace(/\\([()])/g, '$1');
  return tok.replace(/\s+/g, '_');
}

// Token end position (for insertion after a clicked tag).
function getTokenEnd(el) {
  const text = el.value;
  const pos  = el.selectionStart;
  return _tokenEnd(text, pos);
}

// ─── Token mode analysis ────────────────────────────────────────────────────
// Decides tag mode vs ref mode from the current token's leading char.
//   unclosed "[…"  → ref/bracket (insert [name])
//   "/…" at token start → ref/slash (insert resolved text)
//   otherwise       → tag mode (tags + library prompts)

function _analyzeToken(el) {
  const text = el.value;
  const pos  = el.selectionStart;

  const lastOpen  = text.lastIndexOf('[', pos - 1);
  const lastClose = text.lastIndexOf(']', pos - 1);
  if (lastOpen > lastClose) {
    return { mode: 'ref', refKind: 'bracket',
             query: text.substring(lastOpen + 1, pos).trim(), rangeStart: lastOpen };
  }
  const start = _tokenStart(text, pos);
  const seg = text.substring(start, pos);
  const sm = seg.match(/^(\s*)\/(.*)$/);
  if (sm) {
    return { mode: 'ref', refKind: 'slash',
             query: sm[2].trim(), rangeStart: start + sm[1].length };
  }
  return { mode: 'tag', query: getPartialTag(el), rangeStart: start };
}

// ─── Insertion text builders ──────────────────────────────────────────────────

function _normalizeTagInsert(name) {
  if (settings.replaceUnderscore) name = name.replace(/_/g, ' ');
  if (settings.escapeParens) name = name.replace(/([()])/g, '\\$1');
  return name;
}

// Replace text[start, end) in `el` with `toInsert` (undo-safe via execCommand).
function _spliceInsert(el, start, end, toInsert) {
  el.focus();
  el.setSelectionRange(start, end);
  const ok = document.execCommand('insertText', false, toInsert);
  if (!ok) {
    const v = el.value;
    el.value = v.substring(0, start) + toInsert + v.substring(end);
    const np = start + toInsert.length;
    el.setSelectionRange(np, np);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// ─── Highlight match ─────────────────────────────────────────────────────────

function _highlightMatch(text, query) {
  if (!query) return text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(re, '<b style="color:#f9e2af">$1</b>');
}

// ─── Autocomplete UI ──────────────────────────────────────────────────────────

class TagAutocompleteUI {
  constructor() {
    this._root = document.createElement('div');
    this._root.id = 'xyz-tagac-root';
    Object.assign(this._root.style, {
      position:        'fixed',
      zIndex:          '99999',
      display:         'none',
      backgroundColor: '#1a1a2e',
      border:          '1px solid #444',
      borderRadius:    '4px',
      boxShadow:       '0 4px 16px rgba(0,0,0,0.5)',
      maxHeight:       '360px',
      overflowY:       'auto',
      minWidth:        '260px',
      maxWidth:        '560px',
      fontFamily:      'sans-serif',
      fontSize:        '15px',
    });

    document.body.appendChild(this._root);

    this._target     = null;
    this._candidates = [];
    this._selIndex   = -1;

    this._rangeStart = 0;
    this._isRelated  = false;  // true when showing related tags
    this._isInfo     = false;  // true = info panel (side), false = autocomplete (below)
    this._lastQuery  = '';     // for highlight matching in refs

    // Click-to-insert
    this._root.addEventListener('mousedown', (e) => {
      const row = e.target.closest('[data-tagac-index]');
      if (row) {
        const idx = parseInt(row.dataset.tagacIndex, 10);
        const cand = this._candidates[idx];
        // Skip header rows (tag itself / entry itself) — they are info only
        if (cand && this._target && !cand._isSelf) this._insert(this._target, cand);
        e.preventDefault();
        e.stopPropagation();
      }
    });
  }

  isVisible() {
    return this._root.style.display !== 'none';
  }

  // Tag mode: danbooru/gelbooru tags + library prompts (library first, deduped).
  async showTags(el, info) {
    this._isRelated = false;
    this._isInfo    = false;
    this._lastQuery = info.query || '';
    // Anima "@artist" syntax: "@xxx" → real tags containing the literal "@xxx" PLUS
    // artist tags matching "xxx" (inserted with the "@").
    if (settings.animaArtist && (info.query || '').startsWith('@')) {
      return this._showAtTags(el, info);
    }
    const [tagsRaw, libRaw] = await Promise.all([
      searchTags(info.query, settings.maxSuggestions),
      settings.useLibrary ? fetchLibraryPrompts(info.query, settings.maxLibrary) : [],
    ]);
    const tags = _applyMinCount(tagsRaw).map((t) => ({ ...t, kind: 'tag' }));
    const results = _mergeTagSources(tags, libRaw);
    if (!results.length) { this.hide(); return; }
    // Exact match first: if a candidate's name equals what the user typed, surface
    // it as the top option (e.g. typing "iumu" puts the "iumu" tag first, ahead of
    // higher-post-count tags like "maki_(natoriumu)" that merely contain it).
    const qc = _canonicalName(info.query);
    if (qc) {
      const i = results.findIndex((c) => _canonicalName(c.name) === qc);
      if (i > 0) results.unshift(results.splice(i, 1)[0]);
    }
    this._open(el, results, info.rangeStart);
  }

  // Anima "@artist" suggestions for a query that starts with "@".
  //   1) real tags whose name contains the literal "@xxx" (e.g. the "@_@" expression)
  //   2) artist tags (danbooru category 1) matching the part after "@" by name / alias /
  //      old-name — inserted WITH the leading "@" (marked `_atArtist`).
  async _showAtTags(el, info) {
    const q = info.query;                  // includes leading "@"
    const bare = q.replace(/^@+/, '');     // the part after "@"
    const [literalRaw, artistsRaw] = await Promise.all([
      searchTags(q, settings.maxSuggestions),
      bare.length >= 2 ? searchTags(bare, settings.maxSuggestions, 1) : [],
    ]);
    const literal = _applyMinCount(literalRaw).map((t) => ({ ...t, kind: 'tag' }));
    const artists = _applyMinCount(artistsRaw).map((t) => ({ ...t, kind: 'tag', _atArtist: true }));
    // Dedupe an artist that already appears as a literal "@name" tag (compare inserted form).
    const seen = new Set(literal.map((t) => _canonicalName(t.name)));
    const results = [...artists.filter((a) => !seen.has(_canonicalName('@' + a.name))), ...literal];
    if (!results.length) { this.hide(); return; }
    this._open(el, results, info.rangeStart);
  }

  // Ref mode: entry names + trigger names (after "[" or "/").
  async showRefs(el, info) {
    this._isRelated = false;
    this._isInfo    = false;
    this._lastQuery = info.query || '';
    const results = await fetchRefs(info.query, settings.maxRefs, info.refKind);
    if (!results.length) { this.hide(); return; }
    this._open(el, results, info.rangeStart);
  }

  _open(el, candidates, rangeStart) {
    this._target = el;
    this._candidates = candidates;
    this._hasNavigated = false;
    // Info panel mode: start with no selection, so Enter inserts a newline
    // instead of auto-selecting the first row. Navigation (arrow keys) enables
    // selection mode and skips header rows (tag itself / entry itself).
    this._selIndex = this._isInfo ? -1 : 0;
    this._rangeStart = rangeStart;
    this._render();
    this._position(el);
    this._root.style.display = 'block';
    this._highlight();
  }

  hide() {
    // Remove all popups (they'll be recreated on next render)
    document.querySelectorAll('.xyz-tagac-preview-pop').forEach(p => p.remove());
    _tagPvPop = null;
    _tagPvTag = null;
    clearTimeout(_tagPvTimer);
    this._root.style.display = 'none';
    this._candidates = [];
    this._selIndex   = -1;
    this._target     = null;
    this._hasNavigated = false;
  }

  navigate(dir) {
    if (!this._candidates.length) return;
    // No selectable rows (e.g. a tag-detail panel with only a header + "no related"
    // note) — keep no selection and bail, so the header-skipping loops below can't spin.
    if (!this._candidates.some((c) => !c._isSelf)) { this._selIndex = -1; return; }
    if (!this._hasNavigated && this._selIndex < 0) {
      // First navigation from a "no selection" state (info panels: related tags /
      // clicked-tag detail). Land ON the first selectable item rather than advancing
      // past it. Typing-triggered autocomplete starts with _selIndex = 0 (first row
      // already highlighted), so it skips this branch and navigates normally below —
      // the first Down press then moves to the second option.
      this._hasNavigated = true;
      // Find the first selectable index (skip header rows: _isSelf tags / entry refs)
      let first = 0;
      while (first < this._candidates.length && this._candidates[first]._isSelf) {
        first++;
      }
      if (first >= this._candidates.length) {
        // No selectable items — keep no selection, Enter will just close the panel
        this._selIndex = -1;
        return;
      }
      this._selIndex = first;
      // Apply the direction from this starting point
      if (dir > 0) {
        this._selIndex = (this._selIndex + dir - 1 + this._candidates.length) % this._candidates.length;
        // Re-skip headers
        while (this._candidates[this._selIndex]._isSelf) {
          this._selIndex = (this._selIndex + 1) % this._candidates.length;
        }
      }
    } else {
      this._hasNavigated = true;
      // Normal wrap-around navigation, skipping headers
      do {
        this._selIndex = (this._selIndex + dir + this._candidates.length) % this._candidates.length;
      } while (this._candidates[this._selIndex]._isSelf);
    }
    this._highlight();
  }

  confirmSelected() {
    if (this._selIndex >= 0 && this._selIndex < this._candidates.length && this._target) {
      this._insert(this._target, this._candidates[this._selIndex]);
      return true;
    }
    return false;
  }

  // Get the delimiter for the target element. If the element has a custom
  // getDelimiter function (set via attachTo opts), use it; otherwise DEFAULT_DELIM.
  _getDelimiter() {
    try {
      if (typeof this._target?._xyzGetDelimiter === 'function') {
        return this._target._xyzGetDelimiter() || DEFAULT_DELIM;
      }
    } catch {}
    return DEFAULT_DELIM;
  }

  // Insert a candidate by kind: tag/library → normalized text + delim; ref/bracket
  // → [name]; ref/slash → the entry's resolved-shallow text.
  async _insert(el, cand) {
    const text = el.value;
    const delim = this._getDelimiter();
    let core;

    if (cand.kind === 'ref' && cand.refKind === 'slash') {
      const refName = (cand.names && cand.names[0]) || cand.definition || cand.name;
      const resolved = await resolveShallow(refName);
      if (resolved == null) { this.hide(); return; }
      core = resolved;
    } else if (cand.kind === 'ref') {
      const refName = (cand.names && cand.names[0]) || cand.definition || cand.name;
      core = `[${refName}]`;
    } else if (cand.kind === 'library') {
      core = cand.name;
    } else if (cand.kind === 'plv2_entry') {
      const ref = cand.auto_trigger || cand.full_path || cand.name;
      core = `[${ref}]`;
    } else {
      core = _normalizeTagInsert(cand.name);
      if (cand._atArtist) core = '@' + core;   // Anima artist syntax: insert as "@name"
    }

    // The splice below dispatches a trusted `input` event; tell the handler to
    // ignore that one so the dropdown doesn't reopen on what we just inserted.
    if (this._handler) this._handler._suppressInput = true;

    if (this._isRelated && cand.kind === 'tag' && !cand._isSelf) {
      // Related-tag insertion: insert AFTER the original clicked token.
      const end = this._rangeStart;
      const after = text.substring(end, end + delim.length);
      const before = text.substring(Math.max(0, end - delim.length), end);
      const needLeading  = before !== delim && end > 0 && before[before.length - 1] !== ',';
      const needTrailing = after !== delim && end < text.length && after[0] !== ',' && after[0] !== '\n';
      const toInsert = (needLeading ? delim : '') + core + (needTrailing ? delim : '');
      _spliceInsert(el, end, end, toInsert);
    } else {
      const start = this._rangeStart;
      const pos = el.selectionStart;
      const afterCursor = text[pos];
      const beforeStart = text[start - 1];
      let toInsert;
      if (cand.kind === 'ref' && cand.refKind === 'bracket') {
        const wantComma = settings.autoInsertComma
          && afterCursor !== ',' && afterCursor !== ':' && afterCursor !== ']';
        toInsert = core + (wantComma ? delim : '');
      } else if (cand.kind === 'ref' && cand.refKind === 'slash') {
        toInsert = core + (settings.autoInsertComma && afterCursor !== ',' ? delim : '');
      } else {
        const wantComma = settings.autoInsertComma && afterCursor !== ',' && afterCursor !== ':';
        toInsert = core + (wantComma ? delim : '');
      }
      // If the char just before start is already a delimiter, prepend a space
      if (beforeStart === ',') toInsert = ' ' + toInsert;
      _spliceInsert(el, start, pos, toInsert);
    }
    this.hide();
  }

  _render() {
    this._root.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < this._candidates.length; i++) {
      const cand = this._candidates[i];
      const row = document.createElement('div');
      row.dataset.tagacIndex = i;
      Object.assign(row.style, {
        display: 'flex', alignItems: 'center', padding: '4px 8px',
        cursor: 'pointer', gap: '6px', borderBottom: '1px solid #2a2a3e',
      });
      if (cand.kind === 'ref') this._fillRefRow(row, cand);
      else if (cand.kind === 'library') this._fillLibraryRow(row, cand);
      else if (cand.kind === 'plv2_entry') this._fillEntryRow(row, cand);
      else if (cand.kind === 'note') this._fillNoteRow(row, cand);
      else this._fillTagRow(row, cand);
      frag.appendChild(row);
    }
    this._root.appendChild(frag);
  }

  _badge(label, bg) {
    const b = document.createElement('span');
    b.textContent = label;
    Object.assign(b.style, {
      background: bg, color: '#111', borderRadius: '3px', padding: '0 5px',
      fontSize: '11px', fontWeight: 'bold', flexShrink: '0',
    });
    return b;
  }

  _nameSpan(text) {
    const s = document.createElement('span');
    Object.assign(s.style, {
      flexGrow: '1', color: '#e0e0e0', overflow: 'hidden',
      textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    });
    s.textContent = text;
    return s;
  }

  // A non-selectable informational row (e.g. "no related tags" under a tag header).
  _fillNoteRow(row, cand) {
    row.style.cursor = 'default';
    const s = document.createElement('span');
    Object.assign(s.style, { color: '#888', fontSize: '12px', fontStyle: 'italic', padding: '2px 0' });
    s.textContent = cand.name;
    row.appendChild(s);
  }

  _fillTagRow(row, tag) {
    if (tag._isSelf) {
      // Header row for the source tag in the related list — full info, distinct background.
      row.style.background = '#252542';
      row.style.borderBottom = '2px solid #444';
      row.style.padding = '6px 8px';
    }
    const dot = document.createElement('span');
    Object.assign(dot.style, {
      width: '7px', height: '7px', borderRadius: '50%',
      backgroundColor: CATEGORY_COLORS[tag.category] || '#aaddff', flexShrink: '0',
    });
    dot.title = CATEGORY_NAMES[tag.category] || 'general';
    row.appendChild(dot);
    const dispName = settings.replaceUnderscore ? tag.name.replace(/_/g, ' ') : tag.name;
    row.appendChild(this._nameSpan(tag._atArtist ? '@' + dispName : dispName));

    // Source info is shown via the jump affordance below (the D/G badge IS the link),
    // so there's no separate badge row here.
    const srcs = Array.isArray(tag.sources) ? tag.sources : null;

    if (tag._isSelf) {
      // Show category + post count inline (header style)
      const infoSpan = document.createElement('span');
      Object.assign(infoSpan.style, { color: '#aaa', fontSize: '12px', flexShrink: '0' });
      infoSpan.textContent = `${CATEGORY_NAMES[tag.category] || 'general'} · ${_fmtCount(tag.post_count)}`;
      row.appendChild(infoSpan);
    } else {
      const aliasSpan = document.createElement('span');
      Object.assign(aliasSpan.style, {
        color: '#888', fontSize: '13px', flexShrink: '0', maxWidth: '120px',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      });
      // The FTS index folds in aliases/translations, so a tag can be in the list because
      // an ALIAS matched the query, not its name (e.g. typing "indoor", `nude` matched via
      // its `indoor_nudity` alias). Showing aliases[0] ("naked") is then baffling. When the
      // name itself doesn't contain the query, surface the alias/translation that DID match.
      const norm = (s) => (s || '').replace(/_/g, ' ').toLowerCase();
      const q = norm(this._lastQuery).trim();
      const nameMatches = !q || norm(tag.name).includes(q);
      let matched = null;
      if (q && !this._isRelated && !nameMatches) {
        matched = (tag.aliases || []).find((a) => norm(a).includes(q))
               || (tag.translations || []).find((t) => norm(t).includes(q));
      }
      if (matched) {
        aliasSpan.textContent = matched;
        aliasSpan.title = `matched alias: ${matched}` +
          (tag.aliases && tag.aliases.length ? `\nall: ${tag.aliases.join(', ')}` : '');
        aliasSpan.style.color = '#a6c98f';
      } else if (tag.aliases && tag.aliases.length) {
        aliasSpan.textContent = tag.aliases[0]; aliasSpan.title = tag.aliases.join(', ');
      } else if (tag.translations && tag.translations.length) {
        aliasSpan.textContent = tag.translations[0]; aliasSpan.title = tag.translations.join(', ');
        aliasSpan.style.color = '#caa';
      }
      row.appendChild(aliasSpan);
    }

    if (!tag._isSelf) {
      const infoSpan = document.createElement('span');
      Object.assign(infoSpan.style, { color: '#888', fontSize: '11px', flexShrink: '1', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '130px' });
      const cat = CATEGORY_NAMES[tag.category] || 'general';
      // Show post_count for autocomplete, frequency/overlap for related tags
      const countText = tag.post_count != null ? _fmtCount(tag.post_count)
        : tag.frequency != null ? _fmtCount(tag.frequency)
        : tag.overlap != null ? `${(tag.overlap * 100).toFixed(0)}%`
        : '';
      infoSpan.textContent = countText ? `${cat} · ${countText}` : cat;
      infoSpan.title = infoSpan.textContent;
      row.appendChild(infoSpan);
    }

    // Jump-to-site affordance: the D/G token IS the link (D → danbooru wiki, G → gelbooru
    // posts). EVERY source the tag belongs to gets its own clickable token — uniform for
    // single-source (just its own token) and merged rows alike. Related-list rows carry no
    // `sources`, so they keep the plain danbooru-wiki ↗.
    const _danbooruWiki = `https://danbooru.donmai.us/wiki_pages/${encodeURIComponent(tag.name)}`;
    const _gelbooruSearch = `https://gelbooru.com/index.php?page=post&s=list&tags=${encodeURIComponent(tag.name)}`;
    const _open = (e, url) => { e.preventDefault(); e.stopPropagation(); window.open(url, '_blank'); };
    const _jumpBadge = (label, bg, title, url) => {
      const b = this._badge(label, bg);
      b.title = title; b.style.cursor = 'pointer';
      b.addEventListener('mousedown', (e) => _open(e, url));
      row.appendChild(b);
    };
    if (srcs) {
      if (srcs.includes('danbooru')) _jumpBadge('D', '#6ca6e0', 'danbooru — open wiki', _danbooruWiki);
      if (srcs.includes('gelbooru')) _jumpBadge('G', '#6cc080', 'gelbooru — open posts', _gelbooruSearch);
    } else {
      const j = document.createElement('span');
      j.textContent = '↗'; j.title = 'Open danbooru wiki';
      Object.assign(j.style, { color: '#7af', fontSize: '13px', flexShrink: '0', cursor: 'pointer', padding: '0 2px' });
      j.addEventListener('mousedown', (e) => _open(e, _danbooruWiki));
      row.appendChild(j);
    }

    // Preview icon (header + regular rows): showArtistPreview → artist tags only; showTagPreview → all tags
    if (!tag._isSelf || settings.showTagPreview || (settings.showArtistPreview && tag.category === 1)) {
      const wantTagPv = settings.showTagPreview;
      const wantArtistPv = !wantTagPv && settings.showArtistPreview && tag.category === 1;
      if (wantTagPv || wantArtistPv) {
        const pvIcon = document.createElement('span');
        pvIcon.textContent = '🖼';
        pvIcon.title = wantArtistPv ? 'Show recent works' : 'Preview';
        Object.assign(pvIcon.style, { fontSize: '13px', flexShrink: '0', cursor: 'help', padding: '0 2px', color: '#89b4fa' });
        const limit = Math.max(1, Math.min(settings.previewCount || 1, 10));
        pvIcon.addEventListener('mouseenter', () => {
          _showTagPreviewPopup(pvIcon, tag.name, limit);
        });
        pvIcon.addEventListener('mouseleave', () => {
          _hideTagPreviewPopup();
        });
        if (wantArtistPv) {
          pvIcon.addEventListener('mousedown', (e) => {
            e.preventDefault(); e.stopPropagation(); showArtistWorks(tag.name);
          });
        }
        row.appendChild(pvIcon);
      }
    }
  }

  _fillLibraryRow(row, cand) {
    row.appendChild(this._badge('library', '#ffd479'));
    row.appendChild(this._nameSpan(cand.name));
    if (cand.entry) {
      const src = document.createElement('span');
      Object.assign(src.style, { color: '#888', fontSize: '12px', flexShrink: '0', maxWidth: '160px',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
      src.textContent = cand.entry; src.title = 'from entry: ' + cand.entry;
      row.appendChild(src);
    }
  }

  _fillRefRow(row, cand) {
    const names = cand.names || [cand.name || ''];
    const def = cand.definition || names[0] || '';
    const auto = cand.auto_trigger || def;
    const q = this._lastQuery || '';
    const ql = q.toLowerCase();

    row.appendChild(this._badge('entry', '#ffd479'));

    // Primary name: default trigger name (auto_trigger), fallback to definition
    const nameEl = document.createElement('span');
    nameEl.style.cssText = 'flex:1;color:#e0e0e0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    nameEl.innerHTML = _highlightMatch(auto, q);
    nameEl.title = `[${auto}] — ${names.join(', ')}`;
    row.appendChild(nameEl);

    // Show alias if: query matched the definition but we're showing auto_trigger, OR matched a custom trigger
    const autoMatched = auto.toLowerCase().includes(ql);
    if (!autoMatched) {
      const matched = names.find(n => n !== auto && n.toLowerCase().includes(ql));
      if (matched) {
        const aliasSpan = document.createElement('span');
        aliasSpan.style.cssText = 'color:#888;font-size:13px;flex-shrink:0;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        aliasSpan.textContent = matched;
        aliasSpan.title = names.join(', ');
        row.appendChild(aliasSpan);
      }
    }

    // ℹ info icon — hover to preview prompt text
    const info = document.createElement('span');
    info.textContent = 'ℹ';
    info.style.cssText = 'color:#89b4fa;font-size:14px;cursor:help;flex-shrink:0;padding:0 2px;';
    let _previewPop = null;
    let _previewTimer = null;
    const nodeId = cand.id;
    info.addEventListener('mouseenter', async () => {
      if (!nodeId) return;
      if (_previewPop && _previewPop.isConnected) { _previewPop.style.display = 'block'; return; }
      if (_previewPop) _previewPop = null;  // was removed from DOM
      _previewPop = document.createElement('div');
      _previewPop.className = 'xyz-tagac-preview-pop';
      Object.assign(_previewPop.style, {
        position: 'fixed', zIndex: '100020', maxWidth: '420px', maxHeight: '200px',
        overflowY: 'auto', background: '#1e1e2e', border: '1px solid #45475a',
        borderRadius: '6px', boxShadow: '0 4px 16px rgba(0,0,0,.6)',
        padding: '8px 10px', fontSize: '12px', color: '#cdd6f4',
        fontFamily: '"Fira Code",Consolas,monospace', whiteSpace: 'pre-wrap',
        wordBreak: 'break-word', lineHeight: '1.5', scrollbarWidth: 'thin',
        scrollbarColor: '#45475a transparent',
      });
      _previewPop.textContent = 'Loading…';
      document.body.appendChild(_previewPop);
      const text = await fetchEntryPreview(nodeId);
      _previewPop.textContent = (text || '').trim() || '(empty)';
      const r = info.getBoundingClientRect();
      _previewPop.style.top = Math.max(4, r.top) + 'px';
      _previewPop.style.left = Math.min(r.right + 6, window.innerWidth - 434) + 'px';
    });
    info.addEventListener('mouseleave', () => {
      clearTimeout(_previewTimer);
      _previewTimer = setTimeout(() => { if (_previewPop && _previewPop.isConnected) { _previewPop.style.display = 'none'; } }, 150);
    });
    row.appendChild(info);

    // 📂 open in entry detail button
    if (nodeId) {
      const openBtn = document.createElement('span');
      openBtn.textContent = '📂';
      openBtn.style.cssText = 'color:#a6e3a1;font-size:14px;cursor:pointer;flex-shrink:0;padding:0 2px;';
      openBtn.title = 'Open in entry detail';
      openBtn.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        const node = { id: nodeId, name: def, full_path: names[0] || def, has_prompts: true };
        document.dispatchEvent(new CustomEvent('plv2:open-entry', { detail: { node } }));
        this.hide();
      });
      row.appendChild(openBtn);
    }
  }

  _fillEntryRow(row, cand) {
    // Badge
    row.appendChild(this._badge('entry', '#ffd479'));

    // Entry definition name (full_path) — click to insert [ref]
    const nameEl = document.createElement('span');
    nameEl.style.cssText = 'flex:1;color:#e0e0e0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    const q = this._lastQuery || '';
    nameEl.innerHTML = _highlightMatch(cand.full_path || cand.name, q);
    nameEl.title = cand.full_path || cand.name;
    row.appendChild(nameEl);

    // ℹ info icon — hover to preview prompt text
    const info = document.createElement('span');
    info.textContent = 'ℹ';
    info.style.cssText = 'color:#89b4fa;font-size:14px;cursor:help;flex-shrink:0;padding:0 2px;';
    let _previewPop = null;
    let _previewTimer = null;
    info.addEventListener('mouseenter', async () => {
      if (_previewPop && _previewPop.isConnected) { _previewPop.style.display = 'block'; return; }
      if (_previewPop) _previewPop = null;  // was removed from DOM
      _previewPop = document.createElement('div');
      _previewPop.className = 'xyz-tagac-preview-pop';
      Object.assign(_previewPop.style, {
        position: 'fixed', zIndex: '100020', maxWidth: '420px', maxHeight: '200px',
        overflowY: 'auto', background: '#1e1e2e', border: '1px solid #45475a',
        borderRadius: '6px', boxShadow: '0 4px 16px rgba(0,0,0,.6)',
        padding: '8px 10px', fontSize: '12px', color: '#cdd6f4',
        fontFamily: '"Fira Code",Consolas,monospace', whiteSpace: 'pre-wrap',
        wordBreak: 'break-word', lineHeight: '1.5', scrollbarWidth: 'thin',
        scrollbarColor: '#45475a transparent',
      });
      _previewPop.textContent = 'Loading…';
      document.body.appendChild(_previewPop);
      const text = await fetchEntryPreview(cand.id);
      _previewPop.textContent = (text || '').trim() || '(empty)';
      const r = info.getBoundingClientRect();
      _previewPop.style.top = Math.max(4, r.top) + 'px';
      _previewPop.style.left = Math.min(r.right + 6, window.innerWidth - 434) + 'px';
    });
    info.addEventListener('mouseleave', () => {
      clearTimeout(_previewTimer);
      _previewTimer = setTimeout(() => { if (_previewPop && _previewPop.isConnected) { _previewPop.style.display = 'none'; } }, 150);
    });
    row.appendChild(info);

    // 📂 open in entry detail button
    const openBtn = document.createElement('span');
    openBtn.textContent = '📂';
    openBtn.style.cssText = 'color:#a6e3a1;font-size:14px;cursor:pointer;flex-shrink:0;padding:0 2px;';
    openBtn.title = 'Open in entry detail';
    openBtn.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      // Ensure the candidate has has_prompts so the event listener accepts it
      const node = { ...cand, has_prompts: true };
      document.dispatchEvent(new CustomEvent('plv2:open-entry', { detail: { node } }));
      this.hide();
    });
    row.appendChild(openBtn);
  }

  // Show the resolved entry for a clicked [ref].
  async showEntryForRef(el, refInner) {
    const node = await resolveRefEntry(refInner);
    if (!node) { this.hide(); return; }
    const candidate = {
      kind: 'plv2_entry',
      id: node.id,
      name: node.name,
      full_path: node.full_path,
      pos_neg: node.pos_neg,
      delimiter: node.delimiter,
      has_prompts: true,
      _isSelf: true,   // entry itself is a header, not selectable for insertion
    };
    this._isRelated = false;
    this._isInfo    = true;
    this._lastQuery = refInner;
    this._open(el, [candidate], el.selectionStart);
  }

  // Show entries whose prompts contain the clicked token text.
  // If the token is also a danbooru tag, prefer related tags over library entries.
  async showEntriesByPrompt(el, name) {
    // Check if this token exists in the tag dataset — if so, go to related tags.
    if (settings.enableRelated) {
      const tagResults = await searchTags(name, 1);
      if (tagResults.some(t => t.name === name)) {
        this.showRelatedFor(el, name);
        return;
      }
    }
    const entries = await fetchEntriesByPrompt(name, settings.maxSuggestions);
    if (!entries.length) {
      // Fallback: try related tags if enabled
      if (settings.enableRelated) {
        this.showRelatedFor(el, name);
      } else {
        this.hide();
      }
      return;
    }
    this._isRelated = false;
    this._isInfo    = true;
    this._lastQuery = name;
    this._open(el, entries, el.selectionStart);
  }

  // Open the dropdown showing related tags for a clicked token in the textarea.
  async showRelatedFor(el, name) {
    this._isRelated = true;
    this._isInfo    = true;
    const tokEnd = getTokenEnd(el);
    this._rangeStart = tokEnd;

    // Self-tag (the header) from the merged search. A few results so we can match the
    // exact name even when a higher-count substring match would otherwise rank first.
    // `lookupName` is what related tags are fetched for (may differ from the clicked
    // token when an "@artist" token resolves to a differently-named artist tag).
    let lookupName = name;
    let selfTag = (await searchTags(name, 5)).find(t => t.name === name);

    // Anima "@artist": if the literal "@xxx" isn't itself a tag, treat "xxx" as an
    // artist tag / alias / old-name and show THAT artist's detail + related tags.
    if (!selfTag && settings.animaArtist && name.startsWith('@')) {
      const bare = name.replace(/^@+/, '');
      if (bare) {
        const cand = await searchTags(bare, 15, 1);   // artists only (category 1)
        selfTag = cand.find(t => t.name === bare)
               || cand.find(t => (t.aliases || []).includes(bare))
               || cand[0] || null;
        if (selfTag) lookupName = selfTag.name;
      }
    }
    if (!selfTag) { this.hide(); return; }  // tag not in any active dataset → nothing to show

    const sources = Array.isArray(selfTag.sources) ? selfTag.sources : ['danbooru'];
    const results = [{ ...selfTag, kind: 'tag', _isSelf: true }];

    // Show the header immediately (tag detail), then fill related below it.
    this._open(el, [...results], tokEnd);

    // Related tags are computed by danbooru only. A gelbooru-only tag has none, so we
    // skip the (useless) danbooru fetch and just show its info — the user's request.
    if (sources.includes('danbooru')) {
      const relatedResults = await fetchRelated(lookupName, settings.maxSuggestions);
      for (const r of relatedResults) {
        if (r.name !== lookupName) results.push(r);
      }
    }

    // Always keep the panel open showing the tag's detail. If there are no related
    // tags, add a non-selectable note rather than hiding (esp. gelbooru-only tags).
    if (results.length === 1) {
      results.push({
        kind: 'note', _isSelf: true,
        name: sources.includes('danbooru')
          ? 'No related tags found'
          : 'Gelbooru-only tag — no related tags',
      });
    }
    this._candidates = results;
    if (!this._hasNavigated) this._selIndex = -1;
    this._render();
    this._highlight();
  }

  _highlight() {
    const rows = this._root.querySelectorAll('[data-tagac-index]');
    rows.forEach((r, i) => {
      if (i === this._selIndex && this._selIndex >= 0) {
        r.style.backgroundColor = '#2a2a5e';
        r.scrollIntoView({ block: 'nearest' });
      } else {
        r.style.backgroundColor = '';
      }
    });
  }

  // Position the dropdown.
  // Autocomplete mode: below the textarea (near where the user is typing).
  // Info mode (related/entries/ref): to the right/left of the textarea.
  //
  // IMPORTANT: ComfyUI's canvas applies a CSS transform scale on the node container.
  // getBoundingClientRect() already accounts for this transform (viewport coords),
  // but getCaretCoordinates uses a mirror div in document.body (un-transformed),
  // so its span.offsetTop/offsetLeft are in LOCAL (unscaled) space. We must scale
  // the local caret offset to match the viewport – otherwise the dropdown drifts
  // and covers the text being typed when the canvas is zoomed in/out.
  //
  // But not every host textarea lives inside the zoomed canvas: the PLv2 Text
  // Editor is a standalone floating window that is NOT affected by the canvas
  // transform. Using the global canvas zoom there would re-introduce the drift.
  // So derive the *effective* transform scale from the element itself — the ratio
  // of its rendered (viewport) width to its layout (local/unscaled) width. This is
  // ~canvas-scale for in-canvas widgets and exactly 1 for an un-transformed window.
  _position(el) {
    const rect = el.getBoundingClientRect();
    const rootH = this._root.offsetHeight || 200;
    const rootW = this._root.offsetWidth  || 240;
    const vH = window.innerHeight;
    const vW = window.innerWidth;
    const gap = 4;
    const scale = el.offsetWidth ? (rect.width / el.offsetWidth) : 1.0;
    let t, l;

    if (this._isInfo) {
      // Info panel: to the right (or left) of the textarea
      l = rect.right + gap;
      if (l + rootW > vW - 8) l = rect.left - rootW - gap;
      if (l < 4) l = 4;
      t = rect.top;
      if (t + rootH > vH - 8) t = Math.max(4, vH - rootH - 8);
    } else {
      // Autocomplete: below the text cursor (caret), aligned to caret horizontal.
      // getCaretCoordinates mixes viewport element position with local caret
      // offset (from an un-transformed mirror div), so decompose and re-scale.
      const { top: ct, left: cl, lineHeight: clh } = getCaretCoordinates(el);
      const localY = ct - rect.top;   // caret offset from element top (unscaled)
      const localX = cl - rect.left;  // caret offset from element left (unscaled)
      const sy = localY * scale;
      const sx = localX * scale;
      const slh = clh * scale;
      t = rect.top + sy + slh + gap;
      l = rect.left + sx;
      if (t + rootH > vH - 8) t = rect.top + sy - rootH - gap;
      if (t < 4) t = 4;
      if (l + rootW > vW - 8) l = vW - rootW - 8;
      if (l < 4) l = 4;
    }

    this._root.style.top  = `${t}px`;
    this._root.style.left = `${l}px`;
  }
}

function _fmtCount(n) {
  if (n == null) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ─── Event handler ────────────────────────────────────────────────────────────

class TagACHandler {
  constructor() {
    this.ui        = new TagAutocompleteUI();
    this._timer    = null;
    this._keyMods  = new Map();  // key → had-modifier
    // Set by the UI just before an insertion. Committing a candidate dispatches a
    // trusted `input` event (execCommand insertText); without this guard that event
    // would re-open the dropdown right after a selection (and after a related-tag
    // insert). One-shot: consumed by the input event the insertion itself fires.
    this._suppressInput = false;
  }

  _debounce(el) {
    clearTimeout(this._timer);
    this._timer = setTimeout(async () => {
      if (!settings.enabled) return;
      const info = _analyzeToken(el);
      if (info.mode === 'ref') {
        if (settings.useRefs && info.query !== null) await this.ui.showRefs(el, info);
        else this.ui.hide();
      } else if (info.query.length >= 1) {
        await this.ui.showTags(el, info);
      } else {
        this.ui.hide();
      }
    }, DEBOUNCE_MS);
  }

  handleInput(e) {
    if (!settings.enabled || !e.isTrusted) return;
    // A just-committed insertion fired this event — swallow it so the dropdown
    // doesn't reopen on the candidate we just chose.
    if (this._suppressInput) {
      this._suppressInput = false;
      clearTimeout(this._timer);
      return;
    }
    this._debounce(e.target);
  }

  // Click a token in the textarea.
  // Priority: [ref] → show entry info → entries by prompt → related tags.
  // Clicking empty space / non-triggering position dismisses any open info panel.
  handleClick(e) {
    if (!settings.enabled) return;
    // 1) Check for [ref] at click position
    const refInner = _refAtCaret(e.target.value, e.target.selectionStart);
    if (refInner) {
      this.ui.showEntryForRef(e.target, refInner);
      return;
    }
    // 2) Check for token
    const name = getTokenAtCaret(e.target);
    if (!name || name.length < 2) {
      // Clicked empty area / non-triggering position — dismiss info panel
      if (this.ui.isVisible() && this.ui._isInfo) this.ui.hide();
      return;
    }
    // 3) Entries by prompt (library) → related tags (danbooru)
    if (settings.useLibrary) {
      this.ui.showEntriesByPrompt(e.target, name);
    } else if (settings.enableRelated) {
      this.ui.showRelatedFor(e.target, name);
    }
  }

  handleKeyDown(e) {
    if (!settings.enabled) return;
    this._keyMods.set(e.key.toLowerCase(), e.ctrlKey || e.altKey || e.metaKey);

    if (!this.ui.isVisible()) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        this.ui.navigate(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.ui.navigate(-1);
        break;
      case 'Enter':
      case 'Tab': {
        const mod = e.shiftKey || e.ctrlKey || e.altKey || e.metaKey;
        if (!mod && this.ui.confirmSelected()) {
          e.preventDefault();
        } else if (e.key === 'Enter' && this.ui._isInfo && !this.ui._hasNavigated) {
          // Info panel, not yet navigating: let Enter insert a newline in the textarea
          this.ui.hide();
        } else {
          this.ui.hide();
        }
        break;
      }
      case 'Escape':
        e.preventDefault();
        this.ui.hide();
        break;
    }
  }

  handleKeyUp(e) {
    if (!settings.enabled) return;

    const key = e.key.toLowerCase();
    if (this._keyMods.get(key)) { this._keyMods.delete(key); return; }
    if (e.ctrlKey || e.altKey || e.metaKey) return;

    if (this.ui.isVisible()) {
      if (['arrowdown', 'arrowup'].includes(key)) return;
    } else {
      if (e.key.length > 1 && !['Delete', 'Backspace', 'Process'].includes(e.key)) return;
    }

    if (!e.defaultPrevented) this._debounce(e.target);
  }

  handleBlur(e) {
    // Short delay so mousedown on the list fires first
    setTimeout(() => {
      if (!this.ui._root.contains(document.activeElement)) {
        this.ui.hide();
      }
    }, 160);
  }
}

// ─── Extension registration ───────────────────────────────────────────────────

const handler = new TagACHandler();
handler.ui._handler = handler;   // let the UI suppress the re-trigger after a commit

// opts.related  — this textarea supports click-a-token → related tags
// opts.getDelimiter — function returning the delimiter to use for insertions
function attachTo(el, opts = {}) {
  if (opts.related) el._xyzRelated = true;
  if (typeof opts.getDelimiter === 'function') el._xyzGetDelimiter = opts.getDelimiter;
  if (el._xyzTagACHooked) return;
  el._xyzTagACHooked = true;

  el.addEventListener('input',   (e) => handler.handleInput(e));
  el.addEventListener('keydown', (e) => handler.handleKeyDown(e));
  el.addEventListener('keyup',   (e) => handler.handleKeyUp(e));
  el.addEventListener('blur',    (e) => handler.handleBlur(e));
  el.addEventListener('click',   (e) => handler.handleClick(e));
}

// Public API so PLv2 windows can attach their bespoke textareas.
window.xyzTagAC = { attach: attachTo };

app.registerExtension({
  id:   EXT_ID,
  name: EXT_NAME,

  setup() {
    // Primary hook: ComfyWidgets.STRING override
    if (ComfyWidgets?.STRING) {
      const orig = ComfyWidgets.STRING;
      ComfyWidgets.STRING = function(node, inputName, inputData, appInstance) {
        const result = orig.apply(this, arguments);
        const ta = result?.widget?.inputEl;
        if (ta && ta.tagName === 'TEXTAREA' && !ta.readOnly) {
          attachTo(ta);
        }
        return result;
      };
    }

    // Fallback: MutationObserver for dynamically added textareas
    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== Node.ELEMENT_NODE) continue;
          if (n.matches?.('.comfy-multiline-input')) attachTo(n);
          n.querySelectorAll?.('.comfy-multiline-input').forEach(attachTo);
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    // Attach to any already-existing textareas
    document.querySelectorAll('.comfy-multiline-input').forEach(attachTo);
  },
});
