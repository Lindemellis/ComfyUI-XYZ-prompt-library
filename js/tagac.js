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
  halfwidth: false,        // full-width （） → half-width on insert
  // Prompt Library sources
  useLibrary: true,        // suggest prompts from the Prompt Library (tag mode)
  maxLibrary: 10,          // cap on library suggestions shown
  useRefs: true,           // suggest entry/trigger refs after "[" or "/"
  maxRefs: 10,             // cap on ref suggestions
  // Dataset
  scrapeMin: 50,           // default scrape threshold (count >= N)
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

async function searchTags(q, limit) {
  const key = `${limit}|${q}`;
  const hit = _searchCache.get(key);
  if (hit) return hit;
  try {
    const r = await fetch(`/xyz/tagdb/search?q=${encodeURIComponent(q)}&limit=${limit}`);
    if (!r.ok) return [];
    const data = await r.json();
    if (_searchCache.size >= _SEARCH_CACHE_MAX) _searchCache.clear();
    _searchCache.set(key, data);
    return data;
  } catch {
    return [];
  }
}

async function fetchRelated(tag, limit) {
  try {
    const r = await fetch(`/xyz/tagdb/related?q=${encodeURIComponent(tag)}&limit=${limit}&max_age_days=${settings.relatedMaxAgeDays}`);
    if (!r.ok) return [];
    const data = await r.json();
    return (data.related || []).map((x) => ({
      kind: 'tag', name: x.name, category: x.category, aliases: [], post_count: undefined,
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
async function fetchLibraryPrompts(q, limit) {
  try {
    const r = await fetch(`/xyz/plv2/ac/prompts?q=${encodeURIComponent(q)}&limit=${limit}`);
    if (!r.ok) return [];
    const data = await r.json();
    return (data.prompts || []).map((p) => ({
      kind: 'library', name: p.content, entry: p.entry_name || p.full_path || '',
    }));
  } catch { return []; }
}

// Entry/trigger refs matching q → candidates {kind:'ref', name, refKind, entryKind, definition}.
async function fetchRefs(q, limit, refKind) {
  try {
    const r = await fetch(`/xyz/plv2/ac/refs?q=${encodeURIComponent(q)}&limit=${limit}`);
    if (!r.ok) return [];
    const data = await r.json();
    return (data.refs || []).map((x) => ({
      kind: 'ref', name: x.name, refKind, entryKind: x.kind, definition: x.definition || '',
    }));
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

// Merge tag + library candidates for tag mode: library first, drop a library prompt
// whose text exactly equals a danbooru tag name (req 2a: "not part of the dataset").
function _mergeTagSources(tags, library) {
  const tagNames = new Set(tags.map((t) => t.name));
  const lib = library.filter((p) => !tagNames.has(p.name)).slice(0, settings.maxLibrary);
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
  const coords = {
    top:  rect.top  + el.scrollTop  + span.offsetTop  + (parseInt(computed.borderTopWidth)  || 0),
    left: rect.left + el.scrollLeft + span.offsetLeft + (parseInt(computed.borderLeftWidth) || 0),
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

function getTagRangeStart(el) {
  return _tokenStart(el.value, el.selectionStart);
}

// Full tag token surrounding the caret (both directions), canonical underscore
// form — used for "click a prompt → related tags".
function getTokenAtCaret(el) {
  const text = el.value;
  const pos  = el.selectionStart;
  const start = _tokenStart(text, pos);
  let end = text.length;
  for (const idx of [text.indexOf(',', pos), text.indexOf('\n', pos), text.indexOf('. ', pos)]) {
    if (idx !== -1) end = Math.min(end, idx);
  }
  let tok = text.substring(start, end).trim()
    .replace(/^[\(\<\s]+/, '').replace(/[\)\>\s]+$/, '');
  const ci = tok.indexOf(':');           // drop a trailing :weight
  if (ci !== -1) tok = tok.substring(0, ci);
  return tok.trim().replace(/\s+/g, '_');
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

    // Click-to-insert
    this._root.addEventListener('mousedown', (e) => {
      const row = e.target.closest('[data-tagac-index]');
      if (row) {
        const idx = parseInt(row.dataset.tagacIndex, 10);
        const cand = this._candidates[idx];
        if (cand && this._target) this._insert(this._target, cand);
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
    const [tagsRaw, libRaw] = await Promise.all([
      searchTags(info.query, settings.maxSuggestions),
      settings.useLibrary ? fetchLibraryPrompts(info.query, settings.maxLibrary) : [],
    ]);
    const tags = _applyMinCount(tagsRaw).map((t) => ({ ...t, kind: 'tag' }));
    const results = _mergeTagSources(tags, libRaw);
    if (!results.length) { this.hide(); return; }
    this._open(el, results, info.rangeStart);
  }

  // Ref mode: entry names + trigger names (after "[" or "/").
  async showRefs(el, info) {
    const results = await fetchRefs(info.query, settings.maxRefs, info.refKind);
    if (!results.length) { this.hide(); return; }
    this._open(el, results, info.rangeStart);
  }

  _open(el, candidates, rangeStart) {
    this._target = el;
    this._candidates = candidates;
    this._selIndex = 0;
    this._rangeStart = rangeStart;
    this._render();
    this._position(el);
    this._root.style.display = 'block';
    this._highlight();
  }

  hide() {
    this._root.style.display = 'none';
    this._candidates = [];
    this._selIndex   = -1;
    this._target     = null;
  }

  navigate(dir) {
    if (!this._candidates.length) return;
    this._selIndex = (this._selIndex + dir + this._candidates.length) % this._candidates.length;
    this._highlight();
  }

  confirmSelected() {
    if (this._selIndex >= 0 && this._selIndex < this._candidates.length && this._target) {
      this._insert(this._target, this._candidates[this._selIndex]);
      return true;
    }
    return false;
  }

  // Insert a candidate by kind: tag/library → normalized text + comma; ref/bracket
  // → [name]; ref/slash → the entry's resolved-shallow text.
  async _insert(el, cand) {
    const text = el.value;
    const start = this._rangeStart;
    const pos = el.selectionStart;
    let core;
    if (cand.kind === 'ref' && cand.refKind === 'slash') {
      const resolved = await resolveShallow(cand.name);
      if (resolved == null) { this.hide(); return; }
      core = resolved;
    } else if (cand.kind === 'ref') {
      core = `[${cand.name}]`;
    } else if (cand.kind === 'library') {
      core = cand.name;                       // prompt text, inserted as-is
    } else {
      core = _normalizeTagInsert(cand.name);  // danbooru tag
    }
    const afterCursor = text[pos];
    const wantComma = settings.autoInsertComma && cand.refKind !== 'bracket'
                      && afterCursor !== ',' && afterCursor !== ':';
    let toInsert = core + (wantComma ? ', ' : '');
    if (text[start - 1] === ',') toInsert = ' ' + toInsert;
    _spliceInsert(el, start, pos, toInsert);
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

  _fillTagRow(row, tag) {
    const dot = document.createElement('span');
    Object.assign(dot.style, {
      width: '7px', height: '7px', borderRadius: '50%',
      backgroundColor: CATEGORY_COLORS[tag.category] || '#aaddff', flexShrink: '0',
    });
    dot.title = CATEGORY_NAMES[tag.category] || 'general';
    row.appendChild(dot);
    row.appendChild(this._nameSpan(settings.replaceUnderscore ? tag.name.replace(/_/g, ' ') : tag.name));

    const aliasSpan = document.createElement('span');
    Object.assign(aliasSpan.style, {
      color: '#888', fontSize: '13px', flexShrink: '0', maxWidth: '120px',
      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    });
    if (tag.aliases && tag.aliases.length) {
      aliasSpan.textContent = tag.aliases[0]; aliasSpan.title = tag.aliases.join(', ');
    } else if (tag.translations && tag.translations.length) {
      aliasSpan.textContent = tag.translations[0]; aliasSpan.title = tag.translations.join(', ');
      aliasSpan.style.color = '#caa';
    }
    row.appendChild(aliasSpan);

    const countSpan = document.createElement('span');
    Object.assign(countSpan.style, { color: '#666', fontSize: '13px', flexShrink: '0' });
    countSpan.textContent = _fmtCount(tag.post_count);
    row.appendChild(countSpan);

    const jump = document.createElement('span');
    jump.textContent = '↗'; jump.title = 'Open danbooru wiki';
    Object.assign(jump.style, { color: '#7af', fontSize: '13px', flexShrink: '0', cursor: 'pointer', padding: '0 2px' });
    jump.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      window.open(`https://danbooru.donmai.us/wiki_pages/${encodeURIComponent(tag.name)}`, '_blank');
    });
    row.appendChild(jump);

    if (tag.category === 1) {
      const works = document.createElement('span');
      works.textContent = '🖼'; works.title = 'Show recent works';
      Object.assign(works.style, { fontSize: '13px', flexShrink: '0', cursor: 'pointer', padding: '0 2px' });
      works.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation(); showArtistWorks(tag.name);
      });
      row.appendChild(works);
    }
    if (settings.enableRelated) {
      const rel = document.createElement('span');
      rel.textContent = '⋯rel'; rel.title = 'Show related tags';
      Object.assign(rel.style, { color: '#7af', fontSize: '13px', flexShrink: '0', cursor: 'pointer', padding: '0 2px' });
      rel.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation(); this._showRelated(tag.name);
      });
      row.appendChild(rel);
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
    const isTrigger = cand.entryKind === 'trigger';
    row.appendChild(this._badge(isTrigger ? 'trigger' : 'entry', isTrigger ? '#aaffaa' : '#aaddff'));
    row.appendChild(this._nameSpan((cand.refKind === 'bracket' ? '[' : '/') + cand.name +
                                   (cand.refKind === 'bracket' ? ']' : '')));
    if (cand.definition) {
      const def = document.createElement('span');
      Object.assign(def.style, { color: '#888', fontSize: '12px', flexShrink: '0', maxWidth: '180px',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
      def.textContent = cand.definition; def.title = cand.definition;
      row.appendChild(def);
    }
  }

  async _showRelated(name) {
    const results = await fetchRelated(name, settings.maxSuggestions);
    if (!results.length || !this._target) return;
    this._candidates = results;
    this._selIndex = 0;
    this._render();
    this._highlight();
  }

  // Open the dropdown showing related tags for a clicked token in the textarea.
  async showRelatedFor(el, name) {
    const results = await fetchRelated(name, settings.maxSuggestions);
    if (!results.length) { this.hide(); return; }
    this._open(el, results, el.selectionStart);  // selecting one inserts at caret
  }

  _highlight() {
    const rows = this._root.querySelectorAll('[data-tagac-index]');
    rows.forEach((r, i) => {
      if (i === this._selIndex) {
        r.style.backgroundColor = '#2a2a5e';
        r.scrollIntoView({ block: 'nearest' });
      } else {
        r.style.backgroundColor = '';
      }
    });
  }

  _position(el) {
    const { top, left, lineHeight } = getCaretCoordinates(el);
    const scale = window.app?.canvas?.ds?.scale ?? 1.0;

    let t = top + lineHeight * scale;
    let l = left;

    const rootH = this._root.offsetHeight || 200;
    const rootW = this._root.offsetWidth  || 240;
    const vH = window.innerHeight;
    const vW = window.innerWidth;

    if (t + rootH > vH - 8) t = top - rootH;
    if (t < 4) t = 4;
    if (l + rootW > vW - 8) l = vW - rootW - 8;
    if (l < 4) l = 4;

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
    this._debounce(e.target);
  }

  // Click a token in the textarea → show its related tags. Gated to textareas
  // flagged related-capable (the rich editor + entry text view only).
  handleClick(e) {
    if (!settings.enabled || !settings.enableRelated || !e.target._xyzRelated) return;
    const name = getTokenAtCaret(e.target);
    if (name && name.length >= 2) this.ui.showRelatedFor(e.target, name);
    else this.ui.hide();
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

// opts.related = this textarea supports click-a-token → related tags (the PLv2
// rich editor + entry text view set this; node/general boxes do not).
function attachTo(el, opts = {}) {
  if (opts.related) el._xyzRelated = true;   // allow upgrading an already-hooked box
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
  // All options now live in the unified "XYZ Prompt Tools" settings page
  // (xyz_settings.js), which edits window.xyzAcSettings. No native settings here.
});
