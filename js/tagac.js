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

const DEBOUNCE_MS = 150;

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
  enableRelated: false,
  minPostCount: 0,         // client-side: hide suggestions below this post count
  relatedMaxAgeDays: 30,   // related cache freshness window
};

// ─── API ─────────────────────────────────────────────────────────────────────

async function searchTags(q, limit) {
  try {
    const r = await fetch(`/xyz/tagdb/search?q=${encodeURIComponent(q)}&limit=${limit}`);
    if (!r.ok) return [];
    return await r.json();
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
      name: x.name, category: x.category, aliases: [], post_count: undefined,
    }));
  } catch {
    return [];
  }
}

function _applyMinCount(results) {
  if (!settings.minPostCount) return results;
  return results.filter((r) => (r.post_count ?? Infinity) >= settings.minPostCount);
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

function getPartialTag(el) {
  const text = el.value;
  const pos  = el.selectionStart;

  // Find last comma or newline before cursor
  const lastComma   = text.lastIndexOf(',', pos - 1);
  const lastNewline = text.lastIndexOf('\n', pos - 1);
  const start = Math.max(lastComma, lastNewline) + 1;

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

  return partial.replace(/_/g, settings.replaceUnderscore ? ' ' : '_');
}

function getTagRangeStart(el) {
  const text = el.value;
  const pos  = el.selectionStart;
  const lastComma   = text.lastIndexOf(',', pos - 1);
  const lastNewline = text.lastIndexOf('\n', pos - 1);
  return Math.max(lastComma, lastNewline) + 1;
}

// ─── Tag insertion ────────────────────────────────────────────────────────────

function insertTag(el, tagData) {
  const text      = el.value;
  const cursorPos = el.selectionStart;
  const rangeStart = getTagRangeStart(el);

  let tagName = tagData.name;
  if (settings.replaceUnderscore) tagName = tagName.replace(/_/g, ' ');

  const needsSpaceBefore = text[rangeStart - 1] === ',';
  const prefix = needsSpaceBefore ? ' ' : '';

  const afterCursor = text[cursorPos];
  const needsSuffix = afterCursor !== ',' && afterCursor !== ':';
  const suffix = (needsSuffix && settings.autoInsertComma) ? ', ' : '';

  const toInsert = prefix + tagName + suffix;

  el.focus();
  el.setSelectionRange(rangeStart, cursorPos);

  const ok = document.execCommand('insertText', false, toInsert);
  if (!ok) {
    const before = text.substring(0, rangeStart);
    const after  = text.substring(cursorPos);
    el.value = before + toInsert + after;
    const newPos = rangeStart + toInsert.length;
    el.setSelectionRange(newPos, newPos);
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
      maxHeight:       '320px',
      overflowY:       'auto',
      minWidth:        '220px',
      maxWidth:        '480px',
      fontFamily:      'monospace',
      fontSize:        '12px',
    });

    document.body.appendChild(this._root);

    this._target     = null;
    this._candidates = [];
    this._selIndex   = -1;

    // Click-to-insert
    this._root.addEventListener('mousedown', (e) => {
      const row = e.target.closest('[data-tagac-index]');
      if (row) {
        const idx = parseInt(row.dataset.tagacIndex, 10);
        const tag = this._candidates[idx];
        if (tag && this._target) {
          insertTag(this._target, tag);
          this.hide();
        }
        e.preventDefault();
        e.stopPropagation();
      }
    });
  }

  isVisible() {
    return this._root.style.display !== 'none';
  }

  async show(el, q) {
    const results = _applyMinCount(await searchTags(q, settings.maxSuggestions));
    if (!results.length) { this.hide(); return; }

    this._target     = el;
    this._candidates = results;
    this._selIndex   = 0;

    this._render(q);
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
      insertTag(this._target, this._candidates[this._selIndex]);
      this.hide();
      return true;
    }
    return false;
  }

  _render(q) {
    this._root.innerHTML = '';
    const frag = document.createDocumentFragment();

    for (let i = 0; i < this._candidates.length; i++) {
      const tag = this._candidates[i];
      const row = document.createElement('div');
      row.dataset.tagacIndex = i;
      Object.assign(row.style, {
        display:    'flex',
        alignItems: 'center',
        padding:    '3px 8px',
        cursor:     'pointer',
        gap:        '6px',
        borderBottom: '1px solid #2a2a3e',
      });

      // Category dot
      const dot = document.createElement('span');
      const color = CATEGORY_COLORS[tag.category] || '#aaddff';
      Object.assign(dot.style, {
        width:        '6px',
        height:       '6px',
        borderRadius: '50%',
        backgroundColor: color,
        flexShrink:   '0',
      });
      dot.title = CATEGORY_NAMES[tag.category] || 'general';

      // Tag name (highlight matching part)
      const nameSpan = document.createElement('span');
      nameSpan.style.flexGrow   = '1';
      nameSpan.style.color      = '#e0e0e0';
      nameSpan.style.overflow   = 'hidden';
      nameSpan.style.textOverflow = 'ellipsis';
      nameSpan.style.whiteSpace = 'nowrap';
      const displayName = settings.replaceUnderscore ? tag.name.replace(/_/g, ' ') : tag.name;
      nameSpan.textContent = displayName;

      // Alias hint (first alias)
      const aliasSpan = document.createElement('span');
      aliasSpan.style.color     = '#888';
      aliasSpan.style.fontSize  = '11px';
      aliasSpan.style.flexShrink = '0';
      aliasSpan.style.maxWidth  = '120px';
      aliasSpan.style.overflow  = 'hidden';
      aliasSpan.style.textOverflow = 'ellipsis';
      aliasSpan.style.whiteSpace   = 'nowrap';
      if (tag.aliases && tag.aliases.length) {
        aliasSpan.textContent = tag.aliases[0];
        aliasSpan.title = tag.aliases.join(', ');
      }

      // Post count
      const countSpan = document.createElement('span');
      countSpan.style.color     = '#666';
      countSpan.style.fontSize  = '11px';
      countSpan.style.flexShrink = '0';
      countSpan.textContent = _fmtCount(tag.post_count);

      row.appendChild(dot);
      row.appendChild(nameSpan);
      row.appendChild(aliasSpan);
      row.appendChild(countSpan);

      // Optional related-tags affordance (default off; one request per click).
      if (settings.enableRelated) {
        const rel = document.createElement('span');
        rel.textContent = '⋯rel';
        rel.title = 'Show related tags';
        Object.assign(rel.style, {
          color: '#7af', fontSize: '11px', flexShrink: '0', cursor: 'pointer',
          padding: '0 2px',
        });
        rel.addEventListener('mousedown', (e) => {
          e.preventDefault();
          e.stopPropagation();  // do not trigger row insert
          this._showRelated(tag.name);
        });
        row.appendChild(rel);
      }

      frag.appendChild(row);
    }

    this._root.appendChild(frag);
  }

  async _showRelated(name) {
    const results = await fetchRelated(name, settings.maxSuggestions);
    if (!results.length || !this._target) return;
    this._candidates = results;
    this._selIndex = 0;
    this._render(name);
    this._highlight();
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
      const q = getPartialTag(el);
      if (q.length >= 2) {
        await this.ui.show(el, q);
      } else {
        this.ui.hide();
      }
    }, DEBOUNCE_MS);
  }

  handleInput(e) {
    if (!settings.enabled || !e.isTrusted) return;
    this._debounce(e.target);
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

function attachTo(el) {
  if (el._xyzTagACHooked) return;
  el._xyzTagACHooked = true;

  el.addEventListener('input',   (e) => handler.handleInput(e));
  el.addEventListener('keydown', (e) => handler.handleKeyDown(e));
  el.addEventListener('keyup',   (e) => handler.handleKeyUp(e));
  el.addEventListener('blur',    (e) => handler.handleBlur(e));
}

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

    // Prefill the native "Danbooru login" setting from the backend (source of truth).
    fetch('/xyz/tagdb/settings').then((r) => r.json()).then((s) => {
      if (s.danbooru_login) {
        try { app.extensionManager?.setting?.set(EXT_ID + '.DanbooruLogin', s.danbooru_login); } catch {}
      }
    }).catch(() => {});
  },

  settings: [
    {
      id:           EXT_ID + '.Enable',
      name:         'Enable tag autocomplete',
      type:         'boolean',
      defaultValue: true,
      category:     [EXT_NAME, 'General', 'Enable'],
      onChange:     (v) => { settings.enabled = v; if (!v) handler.ui.hide(); },
    },
    {
      id:           EXT_ID + '.MaxSuggestions',
      name:         'Max suggestions',
      type:         'slider',
      attrs:        { min: 5, max: 50, step: 5 },
      defaultValue: 15,
      category:     [EXT_NAME, 'General', 'Max suggestions'],
      onChange:     (v) => { settings.maxSuggestions = v; },
    },
    {
      id:           EXT_ID + '.ReplaceUnderscore',
      name:         "Replace '_' with space",
      type:         'boolean',
      defaultValue: true,
      category:     [EXT_NAME, 'General', 'Replace underscore'],
      onChange:     (v) => { settings.replaceUnderscore = v; },
    },
    {
      id:           EXT_ID + '.AutoComma',
      name:         'Auto-insert comma after tag',
      type:         'boolean',
      defaultValue: true,
      category:     [EXT_NAME, 'General', 'Auto comma'],
      onChange:     (v) => { settings.autoInsertComma = v; },
    },
    {
      id:           EXT_ID + '.MinPostCount',
      name:         'Hide suggestions below this post count',
      type:         'number',
      attrs:        { min: 0, step: 10 },
      defaultValue: 0,
      category:     [EXT_NAME, 'General', 'Min post count'],
      onChange:     (v) => { settings.minPostCount = Number(v) || 0; },
    },
    {
      id:           EXT_ID + '.EnableRelated',
      name:         'Show related-tags affordance (1 request per click)',
      type:         'boolean',
      defaultValue: false,
      category:     [EXT_NAME, 'Related', 'Enable'],
      onChange:     (v) => { settings.enableRelated = v; },
    },
    {
      id:           EXT_ID + '.RelatedMaxAgeDays',
      name:         'Related tags cache freshness (days)',
      type:         'number',
      attrs:        { min: 1, step: 1 },
      defaultValue: 30,
      category:     [EXT_NAME, 'Related', 'Cache age'],
      onChange:     (v) => { settings.relatedMaxAgeDays = Number(v) || 30; },
    },
    {
      id:           EXT_ID + '.DanbooruLogin',
      name:         'Danbooru login (api key is set in the Tag DB Manager)',
      type:         'text',
      defaultValue: '',
      category:     [EXT_NAME, 'Danbooru account', 'Login'],
      onChange:     (v) => {
        // Persist the (non-secret) login to the backend settings.
        fetch('/xyz/tagdb/settings', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ danbooru_login: (v || '').trim() }),
        }).catch(() => {});
      },
    },
  ],
});
