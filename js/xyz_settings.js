/** XYZ Prompt Tools — settings for TagDB autocomplete and Prompt Library V3. */

import { app } from '../../../scripts/app.js';
import { registerWindow } from './plv3/theme.js';
import { manager as tagdbManager } from './tagdb_panel.js';
import { reset as plv3Reset, set as plv3Set, settings as plv3 } from './plv3/settings.js';

const EXT_ID = 'XYZNodes.PromptTools';
const C = {
  text: '#cdd6f4', sub: '#9399b2', accent: '#89b4fa', bg: '#1e1e2e',
  panel: '#181825', border: '#313244', input: '#11111b', hover: '#313244',
};

function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'style') Object.assign(node.style, value);
    else if (key === 'class') node.className = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value != null) node.setAttribute(key, value);
  }
  for (const child of kids) {
    if (child != null) node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function saveAutocomplete() { try { window.xyzAcSettings?.save?.(); } catch {} }

function row(label, helper, control) {
  return el('div', { style: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px',
    padding: '10px 0', borderBottom: `1px solid ${C.border}`,
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
  const input = el('input', { type: 'checkbox', style: { opacity: '0', width: '0', height: '0' } });
  input.checked = Boolean(get());
  const track = el('span', { style: {
    position: 'absolute', inset: '0', borderRadius: '11px', transition: '.15s',
    background: input.checked ? C.accent : '#45475a',
  }});
  const knob = el('span', { style: {
    position: 'absolute', top: '3px', left: input.checked ? '21px' : '3px', width: '16px',
    height: '16px', borderRadius: '50%', background: '#fff', transition: '.15s',
  }});
  input.addEventListener('change', () => {
    track.style.background = input.checked ? C.accent : '#45475a';
    knob.style.left = input.checked ? '21px' : '3px';
    set(input.checked);
  });
  wrap.append(input, track, knob);
  return wrap;
}

function numberCtrl(get, set, { min = 0, max = 9999, step = 1, width = '70px' } = {}) {
  const input = el('input', { type: 'number', min, max, step, style: {
    width, background: C.input, color: C.text, border: `1px solid ${C.border}`,
    borderRadius: '6px', padding: '5px 8px', fontSize: '13px',
  }});
  input.value = get();
  input.addEventListener('change', () => set(Number(input.value)));
  return input;
}

function sliderCtrl(get, set, { min, max, step }) {
  const output = el('span', { style: {
    color: C.accent, fontSize: '13px', width: '28px', display: 'inline-block', textAlign: 'right',
  }}, String(get()));
  const input = el('input', { type: 'range', min, max, step, value: get(), style: {
    width: '160px', verticalAlign: 'middle',
  }});
  input.addEventListener('input', () => {
    output.textContent = input.value;
    set(Number(input.value));
  });
  return el('span', {}, input, ' ', output);
}

function sectionTitle(text, desc) {
  return el('div', { style: { marginBottom: '6px' } },
    el('div', { style: { color: C.text, fontSize: '17px', fontWeight: '600' } }, text),
    desc ? el('div', { style: { color: C.sub, fontSize: '12px', marginTop: '3px' } }, desc) : null);
}

const NAV = [
  ['autocomplete', '🔍', 'Autocomplete'], ['insertion', '✎', 'Insertion'],
  ['related', '🔗', 'Related'], ['preview', '🖼', 'Preview'],
  ['plv3', '⬡', 'Prompt Library V3'], ['dataset', '🗄', 'Tag dataset'], ['about', 'ⓘ', 'About'],
];

class SettingsPage {
  constructor() {
    this.root = null; this.panes = {}; this.navBtns = {}; this.active = null;
  }

  toggle() { this.root && this.root.style.display !== 'none' ? this.hide() : this.show(); }
  show() {
    if (!this.root) this.build();
    this.root.style.display = 'flex';
    this.activate();
    this.select(this.active || 'autocomplete');
  }
  hide() {
    if (this.root) this.root.style.display = 'none';
    tagdbManager.detach?.();
  }

  build() {
    const win = el('div', { style: {
      position: 'fixed', top: '8vh', left: '50%', transform: 'translateX(-50%)',
      width: '760px', maxWidth: '94vw', height: '78vh', background: C.bg, color: C.text,
      border: `1px solid ${C.border}`, borderRadius: '12px', zIndex: '10001', display: 'flex',
      flexDirection: 'column', boxShadow: '0 16px 48px rgba(0,0,0,.6)',
      font: '14px "Segoe UI",system-ui,sans-serif', overflow: 'hidden',
    }});
    const bar = el('div', { style: {
      cursor: 'move', padding: '12px 16px', background: C.panel,
      borderBottom: `1px solid ${C.border}`, display: 'flex',
      justifyContent: 'space-between', alignItems: 'center',
    }},
    el('b', { style: { fontSize: '15px' } }, 'XYZ Prompt Tools'),
    el('span', { style: { cursor: 'pointer', fontSize: '18px', color: C.sub, padding: '0 4px' },
      onclick: () => this.hide() }, '✕'));
    this.bindDrag(win, bar);

    const nav = el('div', { style: {
      width: '180px', flexShrink: '0', background: C.panel, borderRight: `1px solid ${C.border}`,
      padding: '8px', display: 'flex', flexDirection: 'column', gap: '2px', overflowY: 'auto',
    }});
    for (const [key, icon, label] of NAV) {
      const button = el('div', { style: {
        padding: '9px 12px', borderRadius: '8px', cursor: 'pointer', display: 'flex',
        alignItems: 'center', gap: '10px', fontSize: '14px', color: C.text, userSelect: 'none',
      }, onclick: () => this.select(key) },
      el('span', { style: { width: '18px', textAlign: 'center' } }, icon), label);
      button.onmouseenter = () => { if (this.active !== key) button.style.background = C.hover; };
      button.onmouseleave = () => { if (this.active !== key) button.style.background = 'transparent'; };
      this.navBtns[key] = button;
      nav.append(button);
    }
    this.content = el('div', { style: { flex: '1', overflowY: 'auto', padding: '20px 24px' } });
    win.append(bar, el('div', { style: { display: 'flex', flex: '1', minHeight: '0' } }, nav, this.content));
    document.body.append(win);
    this.root = win;
    this.activate = registerWindow(win);
  }

  select(key) {
    if (this.active === 'dataset' && key !== 'dataset') tagdbManager.detach?.();
    this.active = key;
    for (const [navKey] of NAV) {
      const button = this.navBtns[navKey];
      button.style.background = navKey === key ? C.accent : 'transparent';
      button.style.color = navKey === key ? '#11111b' : C.text;
    }
    if (key === 'dataset') delete this.panes.dataset;
    if (!this.panes[key]) this.panes[key] = this.buildPane(key);
    this.content.replaceChildren(this.panes[key]);
  }

  buildPane(key) {
    const settings = window.xyzAcSettings || {};
    const wrap = el('div');
    const update = (name) => (value) => { settings[name] = value; saveAutocomplete(); };

    if (key === 'autocomplete') {
      wrap.append(
        sectionTitle('Autocomplete', 'Choose which suggestions appear while you type.'),
        row('LoRA syntax', 'Complete <lora:…> from local LoRA model paths.', toggle(() => settings.loraCompletion !== false, update('loraCompletion'))),
        row('Source syntax', 'Complete Source block headers and Library paths.', toggle(() => settings.sourceCompletion !== false, update('sourceCompletion'))),
        row('Danbooru / Gelbooru dataset', 'Suggest tags from the installed datasets.', toggle(() => settings.enabled !== false, update('enabled'))),
        row('Library prompts', 'Suggest prompts from enabled Library Folders.', toggle(() => settings.libraryCompletion !== false, update('libraryCompletion'))),
        row('Max suggestions', 'How many results the dropdown shows.',
          sliderCtrl(() => settings.maxSuggestions ?? 15, update('maxSuggestions'), { min: 5, max: 50, step: 5 })),
        row('Hide rare tags', 'Skip tags below this post count (0 = show all).',
          numberCtrl(() => settings.minPostCount ?? 0, update('minPostCount'), { min: 0, step: 10 })),
        row('Danbooru tags', 'Include the Danbooru dataset.',
          toggle(() => settings.sourceDanbooru !== false, update('sourceDanbooru'))),
        row('Gelbooru tags', 'Include Gelbooru when its dataset is installed.',
          toggle(() => settings.sourceGelbooru !== false, update('sourceGelbooru'))),
        row('Anima "@artist" syntax', 'Typing @name suggests artist tags.',
          toggle(() => Boolean(settings.animaArtist), update('animaArtist'))));
    } else if (key === 'insertion') {
      wrap.append(
        sectionTitle('Insertion & normalization', 'How selected English tags are written into prompts.'),
        row('Replace "_" with space', 'Insert "blue eyes" instead of "blue_eyes".',
          toggle(() => settings.replaceUnderscore, update('replaceUnderscore'))),
        row('Auto comma', 'Add ", " after an inserted tag.',
          toggle(() => settings.autoInsertComma, update('autoInsertComma'))),
        row('Escape parentheses', 'Escape literal parentheses used in tag names.',
          toggle(() => settings.escapeParens, update('escapeParens'))),
        row('Full-width → half-width', 'Normalize full-width punctuation before insertion.',
          toggle(() => settings.halfwidth, update('halfwidth'))));
    } else if (key === 'related') {
      wrap.append(
        sectionTitle('Related tags', 'Click a tag in a prompt box or PLv3 editor to see related tags.'),
        row('Enable related tags', 'A cache miss sends one request to Danbooru.',
          toggle(() => settings.enableRelated, update('enableRelated'))),
        row('Cache freshness (days)', 'Reuse related results for this many days.',
          numberCtrl(() => settings.relatedMaxAgeDays ?? 30, update('relatedMaxAgeDays'), { min: 1, max: 365 })));
    } else if (key === 'preview') {
      wrap.append(
        sectionTitle('Preview images', 'On-demand Danbooru previews; no image files are stored locally.'),
        row('Show artist preview', 'Show recent works for artist tags.',
          toggle(() => settings.showArtistPreview, update('showArtistPreview'))),
        row('Show all tag preview', 'Show an image preview for any Danbooru tag.',
          toggle(() => settings.showTagPreview, update('showTagPreview'))),
        row('Preview image count', 'Number of thumbnails to show.',
          numberCtrl(() => settings.previewCount ?? 1,
            (value) => update('previewCount')(Math.max(1, Math.min(value || 1, 10))),
            { min: 1, max: 10, width: '60px' })));
    } else if (key === 'plv3') {
      this.buildPlv3Pane(wrap);
    } else if (key === 'dataset') {
      wrap.append(
        sectionTitle('Tag dataset', 'Danbooru/Gelbooru datasets, credentials, updates and snapshots.'),
        row('Scrape threshold', 'Only include tags with at least this many posts.',
          numberCtrl(() => settings.scrapeMin ?? 50, update('scrapeMin'), { min: 0, step: 5 })));
      const host = el('div', { style: { marginTop: '6px' } });
      wrap.append(host);
      try { tagdbManager.renderInto(host); }
      catch (error) { host.append(el('div', { style: { color: '#f88' } }, `manager failed: ${error.message}`)); }
    } else {
      wrap.append(sectionTitle('About'),
        el('div', { style: { color: C.sub, fontSize: '13px', lineHeight: '1.7' } },
          'XYZ Prompt Tools — Prompt Library V3 and English Danbooru/Gelbooru autocomplete.',
          el('br'), 'Settings are stored locally in your browser.'));
    }
    return wrap;
  }

  buildPlv3Pane(wrap) {
    wrap.append(
      sectionTitle('Prompt Library V3', 'Editor, slider and library-window preferences.'),
      row('Prompt weight step', 'Ctrl + ↑/↓ adjustment for attention syntax such as (tag:1.2).',
        numberCtrl(() => plv3().weightStep, (value) => plv3Set('weightStep', value),
          { min: 0.01, max: 1, step: 0.01, width: '62px' })),
      row('LoRA weight step', 'Ctrl + ↑/↓ adjustment for LoRA syntax such as <lora:name:0.8>.',
        numberCtrl(() => plv3().loraStep, (value) => plv3Set('loraStep', value),
          { min: 0.01, max: 1, step: 0.01, width: '62px' })),
      row('Schedule step', 'Resolution of schedule sliders.',
        numberCtrl(() => plv3().scheduleStep, (value) => plv3Set('scheduleStep', value),
          { min: 0.01, max: 0.5, step: 0.01 })),
      row('Font size', null,
        sliderCtrl(() => plv3().fontSize, (value) => plv3Set('fontSize', value), { min: 10, max: 22, step: 1 })),
      row('Word wrap', 'Wrap long lines in the editor.',
        toggle(() => plv3().wordWrap, (value) => plv3Set('wordWrap', value))),
      row('Refresh delay (ms)', 'Delay before lint, preview and detail refresh.',
        numberCtrl(() => plv3().lintDelayMs, (value) => plv3Set('lintDelayMs', value),
          { min: 0, max: 2000, step: 50, width: '80px' })),
      row('Autosave delay (ms)', 'Delay before a library preset saves.',
        numberCtrl(() => plv3().autosaveDelayMs, (value) => plv3Set('autosaveDelayMs', value),
          { min: 0, max: 5000, step: 100, width: '80px' })),
      row('Reset to defaults', 'Only settings on this PLv3 page.',
        el('button', { style: {
          background: C.input, color: C.text, border: `1px solid ${C.border}`,
          borderRadius: '6px', padding: '5px 12px', fontSize: '13px', cursor: 'pointer',
        }, onclick: () => {
          plv3Reset(); wrap.replaceChildren(); this.buildPlv3Pane(wrap);
        }}, 'Reset')));
  }

  bindDrag(win, handle) {
    let startX = 0; let startY = 0; let originX = 0; let originY = 0; let dragging = false;
    handle.addEventListener('mousedown', (event) => {
      if (event.target.tagName === 'SPAN') return;
      dragging = true; startX = event.clientX; startY = event.clientY;
      const rect = win.getBoundingClientRect(); originX = rect.left; originY = rect.top;
      win.style.transform = 'none'; win.style.left = `${originX}px`; win.style.top = `${originY}px`;
      event.preventDefault();
    });
    window.addEventListener('mousemove', (event) => {
      if (!dragging) return;
      win.style.left = `${originX + event.clientX - startX}px`;
      win.style.top = `${originY + event.clientY - startY}px`;
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  }
}

const page = new SettingsPage();
window.xyzSettingsPage = page;

app.registerExtension({
  id: EXT_ID,
  name: 'XYZ Prompt Tools',
  settings: [{
    id: `${EXT_ID}.open`, name: 'XYZ Prompt Tools — open settings',
    category: ['XYZ Prompt Tools', 'Settings', 'Open'],
    type: () => {
      const button = document.createElement('button');
      button.textContent = 'Open XYZ Prompt Tools';
      Object.assign(button.style, {
        background: C.accent, color: '#11111b', border: 'none', fontWeight: '600',
        borderRadius: '6px', padding: '6px 14px', cursor: 'pointer',
      });
      button.addEventListener('click', () => page.show());
      return button;
    },
  }],
  commands: [{
    id: `${EXT_ID}.openCmd`, label: 'Open XYZ Prompt Tools settings',
    icon: 'pi pi-sliders-h', function: () => page.toggle(),
  }],
  menuCommands: [{ path: ['Extensions', 'XYZ Nodes'], commands: [`${EXT_ID}.openCmd`] }],
});

export { page };
