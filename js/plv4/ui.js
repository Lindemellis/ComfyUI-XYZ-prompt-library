// Compact chrome shared by the PLv4 window and its two side panes.
import { makeWindow } from '../plv3/theme.js';
import { designClasses, mountDesign } from './design_adapter.js';
import { toast } from '../plv3/ui.js';

export function element(tag, cls = '', text = '') {
  const node = document.createElement(tag);
  node.className = designClasses(cls);
  if (text) node.textContent = text;
  return node;
}
export function button(text, title, action, cls = '') {
  const node = element('button', cls, text);
  node.type = 'button'; node.title = title;
  node.onclick = e => { e.stopPropagation(); Promise.resolve().then(() => action(e)).catch(report); };
  return node;
}
export function report(error) { toast(error.message || String(error), 'error'); console.error('[PLv4]', error); }
export function input(value, action, { type = 'text', step = 'any', min, max, title = '' } = {}) {
  const node = element('input'); node.type = type; node.value = value ?? ''; node.title = title;
  if (type === 'number') { node.step = step; if (min != null) node.min = min; if (max != null) node.max = max; }
  node.onchange = () => Promise.resolve().then(() => action(type === 'number' ? (node.value === '' ? null : Number(node.value)) : node.value)).catch(report);
  return node;
}
export function check(value, action, title = '') {
  const node = element('input'); node.type = 'checkbox'; node.checked = value; node.title = title;
  node.onclick = e => e.stopPropagation();
  node.onchange = () => Promise.resolve().then(() => action(node.checked)).catch(report);
  return node;
}
export function menu(anchor, items) {
  document.querySelectorAll('.plv4-popover').forEach(n => n.remove());
  const box = element('div', 'plv4 plv4-popover');
  const close = e => { if (!box.contains(e.target)) { box.remove(); document.removeEventListener('pointerdown', close, true); } };
  for (const [label, action] of items) box.append(button(label, label, async () => { box.remove(); document.removeEventListener('pointerdown', close, true); await action(); }));
  document.body.append(box);
  const r = anchor.getBoundingClientRect();
  box.style.left = `${Math.min(innerWidth - box.offsetWidth - 8, Math.max(8, r.right - box.offsetWidth))}px`;
  box.style.top = `${Math.min(innerHeight - box.offsetHeight - 8, r.bottom + 2)}px`;
  queueMicrotask(() => document.addEventListener('pointerdown', close, true));
}


export class WindowShell {
  constructor(onResize) {
    let style = document.getElementById('plv4-css');
    if (!style) { style = element('style'); style.id = 'plv4-css'; document.head.append(style); }
    this.designReady = mountDesign(style, () => this.layout());
    this.resize = onResize;
    this.widths = { library: 220, details: 244 };
    try { Object.assign(this.widths, JSON.parse(localStorage.getItem('xyz-plv4-panes') || '{}')); } catch {}
    this.win = makeWindow({ key: 'xyz-plv4-window', title: 'Prompt Library V4', defaults: { x: 100, y: 70, w: 960, h: 640 }, minW: 480, minH: 360, chromeTag: 'header', onResize: () => this.layout() });
    this.win.el.classList.add('plv4', 'floating-shell');
    Object.assign(this.win.el.style, { background: 'var(--bg)', color: 'var(--text)', fontFamily: 'var(--ui)', fontSize: '12px', borderColor: '#58645f' });
    this.win.el.style.removeProperty('box-shadow');
    this.win.bar.style.cssText = ''; this.win.bar.firstElementChild.className = 'brand';
    this.win.bar.firstElementChild.textContent = 'XYZ / PLV4';
    this.win.body.className = 'layout'; this.win.body.style.display = 'grid';
    this.library = element('aside', 'plv4-column library'); this.details = element('aside', 'plv4-column inspector'); this.center = element('main', 'plv4-column plv4-center');
    this.library.hidden = this.details.hidden = false;
    this.lsplit = this.split('library'); this.rsplit = this.split('details');
    this.win.body.append(this.library, this.lsplit, this.center, this.rsplit, this.details);
    this._viewport = () => this.layout(); addEventListener('resize', this._viewport);
    this.layout();
  }
  toggle(which, force) {
    const pane = this[which]; const open = force ?? pane.hidden;
    if (open === !pane.hidden) return;
    const extra = this.widths[which] + 6;
    const w = this.win.el.offsetWidth || parseInt(this.win.el.style.width);
    const x = parseInt(this.win.el.style.left);
    pane.hidden = !open;
    this.win.el.style.width = `${w + (open ? extra : -extra)}px`;
    if (which === 'library') this.win.el.style.left = `${x + (open ? -extra : extra)}px`;
    this.layout(); this.win.save();
  }
  layout() {
    const el = this.win.el;
    const width = Math.max(350, Math.min(parseInt(el.style.width), innerWidth - 12));
    el.style.width = `${width}px`; el.style.height = `${Math.min(parseInt(el.style.height), innerHeight - 12)}px`;
    el.style.left = `${Math.max(6, Math.min(parseInt(el.style.left), innerWidth - width - 6))}px`;
    el.style.top = `${Math.max(6, Math.min(parseInt(el.style.top), innerHeight - parseInt(el.style.height) - 6))}px`;
    let available = Math.max(0, width - 322);
    const open = ['library', 'details'].filter(k => !this[k].hidden);
    const wanted = open.reduce((sum, k) => sum + this.widths[k], 0);
    for (const key of ['library', 'details']) {
      this[key].style.display = this[key].hidden ? 'none' : 'flex';
      this[key === 'library' ? 'lsplit' : 'rsplit'].style.display = this[key].hidden ? 'none' : 'block';
      const paneWidth = Math.min(this.widths[key], available * this.widths[key] / Math.max(1, wanted));
      this[key].style.width = `${paneWidth}px`;
      this.win.body.style.setProperty(key === 'library' ? '--library-width' : '--detail-width', `${paneWidth}px`);
      this[key].style.flex = 'none';
    }
    this.win.body.classList.toggle('no-library', this.library.hidden);
    this.win.body.classList.toggle('no-panel', this.details.hidden);
    this.resize?.();
  }
  split(key) {
    const node = element('div', 'plv4-split panel-divider'); node.tabIndex = 0; node.role = 'separator'; node.setAttribute('aria-orientation', 'vertical'); node.setAttribute('aria-label', key);
    const adjust = delta => {
      const sign = key === 'library' ? 1 : -1;
      const other = ['library', 'details'].find(k => k !== key && !this[k].hidden);
      const max = this.win.el.offsetWidth - 320 - (other ? this[other].offsetWidth + 6 : 0) - 6;
      this.widths[key] = Math.max(140, Math.min(max, this[key].offsetWidth + delta * sign));
      localStorage.setItem('xyz-plv4-panes', JSON.stringify(this.widths)); this.layout();
    };
    node.onkeydown = e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); adjust(e.key === 'ArrowLeft' ? -10 : 10); } };
    node.onpointerdown = e => { e.preventDefault(); node.setPointerCapture(e.pointerId); let x = e.clientX;
      node.onpointermove = ev => { adjust(ev.clientX - x); x = ev.clientX; };
      node.onpointerup = node.onpointercancel = () => { node.onpointermove = null; node.onpointerup = node.onpointercancel = null; };
    }; return node;
  }
}
