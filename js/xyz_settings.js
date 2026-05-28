/**
 * XYZ Prompt Tools — unified settings page.
 *
 * One window with a left-nav (Autocomplete / Insertion / Library / Related /
 * Tag dataset / About). Edits the single shared settings object
 * window.xyzAcSettings (persisted to localStorage by tagac.js), and mirrors the
 * shared normalization flags into window.plv2.settings so escape / underscore /
 * full-width apply to BOTH the Prompt Library and the tag dataset.
 *
 * ComfyUI's native settings page keeps only ONE entry: a button that opens this.
 */

import { app } from '../../../scripts/app.js';
import { manager as tagdbManager } from './tagdb_panel.js';

const EXT_ID = 'XYZNodes.PromptTools';

// ─── tiny DOM helpers ───────────────────────────────────────────────────────────

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'style') Object.assign(e.style, v);
    else if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v != null) e.setAttribute(k, v);
  }
  for (const c of kids) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

// Resolved lazily (when a pane is built on first open) so module load order vs
// tagac.js doesn't matter — tagac.js owns window.xyzAcSettings.
function save() { try { window.xyzAcSettings?.save?.(); } catch {} }
// Mirror a shared normalize flag into PLv2's settings + persist there too.
function syncPlv2(key, val) {
  try {
    if (window.plv2?.settings) { window.plv2.settings[key] = val; window.plv2.saveSettings?.(); }
  } catch {}
}

// ─── styled controls ────────────────────────────────────────────────────────────

const C = {
  text: '#cdd6f4', sub: '#9399b2', accent: '#89b4fa', bg: '#1e1e2e',
  panel: '#181825', border: '#313244', input: '#11111b', hover: '#313244',
};

function row(label, helper, control) {
  return el('div', { style: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    gap: '16px', padding: '10px 0', borderBottom: `1px solid ${C.border}`,
  }},
    el('div', { style: { minWidth: '0' } },
      el('div', { style: { color: C.text, fontSize: '14px' } }, label),
      helper ? el('div', { style: { color: C.sub, fontSize: '12px', marginTop: '2px' } }, helper) : null),
    el('div', { style: { flexShrink: '0' } }, control));
}

function toggle(get, set) {
  const wrap = el('label', { style: {
    position: 'relative', display: 'inline-block', width: '40px', height: '22px', cursor: 'pointer',
  }});
  const inp = el('input', { type: 'checkbox', style: { opacity: '0', width: '0', height: '0' } });
  inp.checked = !!get();
  const track = el('span', { style: {
    position: 'absolute', inset: '0', borderRadius: '11px', transition: '.15s',
    background: inp.checked ? C.accent : '#45475a',
  }});
  const knob = el('span', { style: {
    position: 'absolute', top: '3px', left: inp.checked ? '21px' : '3px', width: '16px', height: '16px',
    borderRadius: '50%', background: '#fff', transition: '.15s',
  }});
  inp.addEventListener('change', () => {
    track.style.background = inp.checked ? C.accent : '#45475a';
    knob.style.left = inp.checked ? '21px' : '3px';
    set(inp.checked);
  });
  wrap.append(inp, track, knob);
  return wrap;
}

function numberCtrl(get, set, { min = 0, max = 9999, step = 1, width = '70px' } = {}) {
  const inp = el('input', { type: 'number', min, max, step, style: {
    width, background: C.input, color: C.text, border: `1px solid ${C.border}`,
    borderRadius: '6px', padding: '5px 8px', fontSize: '13px',
  }});
  inp.value = get();
  inp.addEventListener('change', () => set(Number(inp.value)));
  return inp;
}

function sliderCtrl(get, set, { min = 5, max = 50, step = 1 } = {}) {
  const out = el('span', { style: { color: C.accent, fontSize: '13px', width: '28px', display: 'inline-block', textAlign: 'right' } }, String(get()));
  const inp = el('input', { type: 'range', min, max, step, value: get(), style: { width: '160px', verticalAlign: 'middle' } });
  inp.addEventListener('input', () => { out.textContent = inp.value; set(Number(inp.value)); });
  return el('span', {}, inp, ' ', out);
}

function sectionTitle(text, desc) {
  return el('div', { style: { marginBottom: '6px' } },
    el('div', { style: { color: C.text, fontSize: '17px', fontWeight: '600' } }, text),
    desc ? el('div', { style: { color: C.sub, fontSize: '12px', marginTop: '3px' } }, desc) : null);
}

// ─── the page ─────────────────────────────────────────────────────────────────

const NAV = [
  ['autocomplete', '🔍', 'Autocomplete'],
  ['insertion',    '✎',  'Insertion'],
  ['library',      '📚', 'Library'],
  ['related',      '🔗', 'Related'],
  ['preview',      '🖼', 'Preview'],
  ['dataset',      '🗄', 'Tag dataset'],
  ['about',        'ⓘ',  'About'],
];

class SettingsPage {
  constructor() { this.root = null; this.panes = {}; this.navBtns = {}; this._datasetBuilt = false; }

  toggle() { (this.root && this.root.style.display !== 'none') ? this.hide() : this.show(); }
  show() { if (!this.root) this._build(); this.root.style.display = 'flex'; this._select('autocomplete'); }
  hide() { if (this.root) this.root.style.display = 'none'; tagdbManager.detach?.(); }

  _build() {
    const win = el('div', { style: {
      position: 'fixed', top: '8vh', left: '50%', transform: 'translateX(-50%)',
      width: '760px', maxWidth: '94vw', height: '78vh', background: C.bg, color: C.text,
      border: `1px solid ${C.border}`, borderRadius: '12px', zIndex: '10001',
      display: 'flex', flexDirection: 'column', boxShadow: '0 16px 48px rgba(0,0,0,.6)',
      font: '14px "Segoe UI",system-ui,sans-serif', overflow: 'hidden',
    }});
    const bar = el('div', { style: {
      cursor: 'move', padding: '12px 16px', background: C.panel, borderBottom: `1px solid ${C.border}`,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    }},
      el('b', { style: { fontSize: '15px' } }, 'XYZ Prompt Tools'),
      el('span', { style: { cursor: 'pointer', fontSize: '18px', color: C.sub, padding: '0 4px' }, onclick: () => this.hide() }, '✕'));
    this._drag(win, bar);

    const nav = el('div', { style: {
      width: '180px', flexShrink: '0', background: C.panel, borderRight: `1px solid ${C.border}`,
      padding: '8px', display: 'flex', flexDirection: 'column', gap: '2px', overflowY: 'auto',
    }});
    for (const [key, icon, label] of NAV) {
      const b = el('div', { style: {
        padding: '9px 12px', borderRadius: '8px', cursor: 'pointer', display: 'flex',
        alignItems: 'center', gap: '10px', fontSize: '14px', color: C.text, userSelect: 'none',
      }, onclick: () => this._select(key) },
        el('span', { style: { width: '18px', textAlign: 'center' } }, icon), label);
      b.onmouseenter = () => { if (this._active !== key) b.style.background = C.hover; };
      b.onmouseleave = () => { if (this._active !== key) b.style.background = 'transparent'; };
      this.navBtns[key] = b;
      nav.append(b);
    }

    this.content = el('div', { style: { flex: '1', overflowY: 'auto', padding: '20px 24px' } });
    win.append(bar, el('div', { style: { display: 'flex', flex: '1', minHeight: '0' } }, nav, this.content));
    document.body.append(win);
    this.root = win;
  }

  _select(key) {
    this._active = key;
    for (const [k] of NAV) {
      const b = this.navBtns[k];
      b.style.background = (k === key) ? C.accent : 'transparent';
      b.style.color = (k === key) ? '#11111b' : C.text;
    }
    if (!this.panes[key]) this.panes[key] = this._buildPane(key);
    this.content.innerHTML = '';
    this.content.append(this.panes[key]);
  }

  _buildPane(key) {
    const S = window.xyzAcSettings || {};   // resolved after tagac.js has loaded
    const wrap = el('div', {});
    if (key === 'autocomplete') {
      wrap.append(
        sectionTitle('Autocomplete', 'Suggestions while you type in any prompt box.'),
        row('Enable autocomplete', 'Turn suggestions on or off everywhere.',
            toggle(() => S.enabled, (v) => { S.enabled = v; save(); })),
        row('Max suggestions', 'How many results the dropdown shows.',
            sliderCtrl(() => S.maxSuggestions ?? 15, (v) => { S.maxSuggestions = v; save(); }, { min: 5, max: 50, step: 5 })),
        row('Hide rare tags', 'Skip tags with fewer than this many posts (0 = show all).',
            numberCtrl(() => S.minPostCount ?? 0, (v) => { S.minPostCount = v || 0; save(); }, { min: 0, step: 10 })),
        row('Danbooru tags', 'Include danbooru tags in suggestions.',
            toggle(() => S.sourceDanbooru !== false, (v) => { S.sourceDanbooru = v; save(); })),
        row('Gelbooru tags', 'Include gelbooru tags (only if the gelbooru dataset is installed). When both sources are on, rows show D/G badges.',
            toggle(() => S.sourceGelbooru !== false, (v) => { S.sourceGelbooru = v; save(); })),
      );
    } else if (key === 'insertion') {
      const sync = (k, plv2Key) => (v) => { S[k] = v; if (plv2Key) syncPlv2(plv2Key, v); save(); };
      wrap.append(
        sectionTitle('Insertion & normalization', 'How tags/prompts are written in. These apply to BOTH the Prompt Library and the tag dataset.'),
        row('Replace "_" with space', 'Insert "blue eyes" instead of "blue_eyes".',
            toggle(() => S.replaceUnderscore, sync('replaceUnderscore', 'underscore'))),
        row('Auto comma', 'Add ", " after an inserted tag.',
            toggle(() => S.autoInsertComma, (v) => { S.autoInsertComma = v; save(); })),
        row('Escape brackets / backslash', 'Turn non-weight "()" into "\\(\\)" so they are literal.',
            toggle(() => S.escapeParens, sync('escapeParens', 'escape'))),
        row('Full-width → half-width', 'Convert "（）" and full-width characters to ASCII.',
            toggle(() => S.halfwidth, sync('halfwidth', 'halfwidth'))),
      );
    } else if (key === 'library') {
      wrap.append(
        sectionTitle('Prompt Library sources', 'Use your own Prompt Library as autocomplete sources.'),
        row('Suggest library prompts', 'Show your saved prompts alongside danbooru tags (listed first).',
            toggle(() => S.useLibrary, (v) => { S.useLibrary = v; save(); })),
        row('Max library suggestions', 'Cap on library prompts shown.',
            numberCtrl(() => S.maxLibrary ?? 10, (v) => { S.maxLibrary = v || 10; save(); }, { min: 1, max: 50 })),
        row('Suggest entry refs', 'After typing "[" or "/", suggest entry & trigger names.',
            toggle(() => S.useRefs, (v) => { S.useRefs = v; save(); })),
        row('Max ref suggestions', 'Cap on entry/trigger suggestions.',
            numberCtrl(() => S.maxRefs ?? 10, (v) => { S.maxRefs = v || 10; save(); }, { min: 1, max: 50 })),
        el('div', { style: { color: C.sub, fontSize: '12px', marginTop: '10px' } },
           'Tip: "[name]" inserts the reference; "/name" inserts the entry’s resolved text.'),
      );
    } else if (key === 'related') {
      wrap.append(
        sectionTitle('Related tags', 'Click a tag in the rich editor or entry text view to see related tags.'),
        row('Enable related tags', 'Each lookup is one request to danbooru.',
            toggle(() => S.enableRelated, (v) => { S.enableRelated = v; save(); })),
        row('Cache freshness (days)', 'Reuse cached related results for this many days.',
            numberCtrl(() => S.relatedMaxAgeDays ?? 30, (v) => { S.relatedMaxAgeDays = v || 30; save(); }, { min: 1, max: 365 })),
      );
    } else if (key === 'preview') {
      wrap.append(
        sectionTitle('Preview images', 'Control preview images shown on hover in autocomplete and related tags.'),
        row('Show artist preview', 'Show recent works popup when hovering the 🖼 icon on artist tags (category 1).',
            toggle(() => S.showArtistPreview, (v) => { S.showArtistPreview = v; save(); })),
        row('Show all tag preview', 'Show a preview image for any danbooru tag when hovering its preview icon.',
            toggle(() => S.showTagPreview, (v) => { S.showTagPreview = v; save(); })),
        row('Preview image count', 'How many preview thumbnails to show (1–10).',
            numberCtrl(() => S.previewCount ?? 1, (v) => { S.previewCount = Math.max(1, Math.min(v || 1, 10)); save(); }, { min: 1, max: 10, step: 1, width: '60px' })),
        el('div', { style: { color: C.sub, fontSize: '12px', marginTop: '10px' } },
           'Preview images are fetched on-demand from danbooru. Cached in memory (no local files).'),
      );
    } else if (key === 'dataset') {
      wrap.append(
        sectionTitle('Tag dataset', 'Danbooru credentials, the prebuilt dataset, updates and snapshots.'),
        row('Scrape threshold', 'When building/updating, only fetch tags with at least this many posts.',
            numberCtrl(() => S.scrapeMin ?? 50, (v) => { S.scrapeMin = v || 50; save(); }, { min: 0, step: 5 })),
      );
      const host = el('div', { style: { marginTop: '6px' } });
      wrap.append(host);
      try { tagdbManager.renderInto(host); } catch (e) { host.append(el('div', { style: { color: '#f88' } }, 'manager failed: ' + e.message)); }
    } else if (key === 'about') {
      wrap.append(
        sectionTitle('About'),
        el('div', { style: { color: C.sub, fontSize: '13px', lineHeight: '1.7' } },
           'XYZ Prompt Tools — danbooru tag autocomplete + Prompt Library integration.',
           el('br'), 'Settings are stored locally in your browser.',
           el('br'), el('a', { href: 'https://github.com/zhupeter010903/ComfyUI-XYZ-prompt-library', target: '_blank', style: { color: C.accent } }, 'GitHub repository')),
      );
    }
    return wrap;
  }

  _drag(win, handle) {
    let sx, sy, ox, oy, on = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'SPAN') return;
      on = true; sx = e.clientX; sy = e.clientY;
      const r = win.getBoundingClientRect(); ox = r.left; oy = r.top;
      win.style.transform = 'none'; win.style.left = ox + 'px'; win.style.top = oy + 'px';
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => { if (on) { win.style.left = (ox + e.clientX - sx) + 'px'; win.style.top = (oy + e.clientY - sy) + 'px'; } });
    window.addEventListener('mouseup', () => { on = false; });
  }
}

const page = new SettingsPage();
window.xyzSettingsPage = page;

app.registerExtension({
  id: EXT_ID,
  name: 'XYZ Prompt Tools',
  // The ONLY native ComfyUI setting: a button that opens the unified page.
  settings: [
    {
      id: EXT_ID + '.open',
      name: 'XYZ Prompt Tools — open settings',
      category: ['XYZ Prompt Tools', 'Settings', 'Open'],
      type: () => {
        const b = document.createElement('button');
        b.textContent = 'Open XYZ Prompt Tools';
        Object.assign(b.style, {
          background: '#89b4fa', color: '#11111b', border: 'none', fontWeight: '600',
          borderRadius: '6px', padding: '6px 14px', cursor: 'pointer',
        });
        b.addEventListener('click', () => page.show());
        return b;
      },
    },
  ],
  commands: [
    { id: EXT_ID + '.openCmd', label: 'Open XYZ Prompt Tools settings', icon: 'pi pi-sliders-h', function: () => page.toggle() },
  ],
  menuCommands: [
    { path: ['Extensions', 'XYZ Nodes'], commands: [EXT_ID + '.openCmd'] },
  ],
});

export { page };
