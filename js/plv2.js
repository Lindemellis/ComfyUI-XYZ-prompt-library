/**
 * Prompt Library V2 — base framework (two-window architecture)
 *
 * Two independent floating windows:
 *   • Text Editor  — the prompt textarea (built by plv2_editor.js)
 *   • Library      — folder tree + entry detail (built by plv2_tree.js / plv2_entry.js)
 *
 * Each window drags / resizes / closes on its own. When both are open and you
 * drag one so its vertical edge nears the other's opposite edge, the touching
 * edges highlight blue; releasing "magnetically" snaps them side-by-side into a
 * composite that:
 *   • keeps each window's width and their left/right relative order
 *   • adopts the *stationary* window's height (the one not being dragged)
 *   • keeps both top bars (title + close); each gets a drag-handle to tear off
 *   • dragging a top bar moves the whole composite; the handle detaches one window
 *   • a top bar's close button detaches + closes that window, the other survives
 *
 * Only horizontal (left/right) snapping is supported.
 *
 * Public surface:
 *   window.plv2.windows.editor   — { show, hide, toggle, isVisible, onShow, onHide, el, body }
 *   window.plv2.windows.library  — { ..., treePanel, detailPanel }
 *   window.plv2.panel            — back-compat getters used by the render modules
 */

import { app } from '../../../scripts/app.js';
import { ComfyButton }      from '../../../scripts/ui/components/button.js';
import { ComfyButtonGroup } from '../../../scripts/ui/components/buttonGroup.js';

// ─── API client ───────────────────────────────────────────────────────────────

async function _req(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(url, opts);
  const j = await r.json();
  // Any path-changing op may report custom triggers it removed because a new/renamed
  // path now shadows them — surface that to the user (centralised so all callers warn).
  if (j && Array.isArray(j.removed_triggers) && j.removed_triggers.length) {
    const list = j.removed_triggers.map(t => `"${t.trigger_text}" (shadowed by ${t.shadowed_by})`).join(', ');
    try { app.extensionManager.toast.add({ severity: 'warn', summary: 'Removed shadowed trigger(s)', detail: list, life: 6000 }); }
    catch { console.warn('[PLv2] removed shadowed triggers:', list); }
  }
  return j;
}

const api = {
  getNodes:       ()           => _req('GET',    '/xyz/plv2/nodes'),
  createNode:     (body)       => _req('POST',   '/xyz/plv2/nodes', body),
  updateNode:     (id, body)   => _req('PATCH',  `/xyz/plv2/nodes/${id}`, body),
  deleteNode:     (id)         => _req('DELETE', `/xyz/plv2/nodes/${id}`),
  moveNode:       (id, body)   => _req('POST',   `/xyz/plv2/nodes/${id}/move`, body),

  getPrompts:     (nid)        => _req('GET',    `/xyz/plv2/nodes/${nid}/prompts`),
  createPrompt:   (nid, body)  => _req('POST',   `/xyz/plv2/nodes/${nid}/prompts`, body),
  updatePrompt:   (id, body)   => _req('PATCH',  `/xyz/plv2/prompts/${id}`, body),
  deletePrompt:   (id)         => _req('DELETE', `/xyz/plv2/prompts/${id}`),
  reorderPrompts: (nid, order) => _req('POST',   `/xyz/plv2/nodes/${nid}/prompts/reorder`, { order }),

  getTriggers:    (nid)        => _req('GET',    `/xyz/plv2/nodes/${nid}/triggers`),
  createTrigger:  (nid, body)  => _req('POST',   `/xyz/plv2/nodes/${nid}/triggers`, body),
  deleteTrigger:  (id)         => _req('DELETE', `/xyz/plv2/triggers/${id}`),

  previewNode:     (id, seed)       => _req('POST', `/xyz/plv2/nodes/${id}/preview`, { seed }),
  resolveTemplate: (template, seed) => _req('POST', '/xyz/plv2/resolve', { template, seed }),
  resolveRef:      (ref)            => _req('POST', '/xyz/plv2/resolve_ref', { ref }),

  getFormats:    () => _req('GET', '/xyz/plv2/common/formats'),
  getDelimiters: () => _req('GET', '/xyz/plv2/common/delimiters'),

  getTemplateSlots:   (fid)       => _req('GET',    `/xyz/plv2/nodes/${fid}/template_slots`),
  createTemplateSlot: (fid, body) => _req('POST',   `/xyz/plv2/nodes/${fid}/template_slots`, body),
  updateTemplateSlot: (id, body)  => _req('PATCH',  `/xyz/plv2/template_slots/${id}`, body),
  deleteTemplateSlot: (id)        => _req('DELETE', `/xyz/plv2/template_slots/${id}`),
  getSlotPrompts:     (sid)       => _req('GET',    `/xyz/plv2/template_slots/${sid}/prompts`),
  createSlotPrompt:   (sid, body) => _req('POST',   `/xyz/plv2/template_slots/${sid}/prompts`, body),
  updateSlotPrompt:   (id, body)  => _req('PATCH',  `/xyz/plv2/template_prompts/${id}`, body),
  deleteSlotPrompt:   (id)        => _req('DELETE', `/xyz/plv2/template_prompts/${id}`),
};

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  activeNode:        null,   // LiteGraph node owning the editor
  selectedLibNodeId: null,   // lib node id selected in tree
  activeTab:         'pos',  // 'pos' | 'neg'
};

// ─── Persistence ────────────────────────────────────────────────────────────

const EDITOR_KEY  = 'plv2_win_editor_v1';
const LIBRARY_KEY = 'plv2_win_library_v1';
const SNAP_KEY    = 'plv2_snap_v1';

const EDITOR_DEFS  = { x: 60,  y: 80, w: 520, h: 560 };
const LIBRARY_DEFS = { x: 600, y: 80, w: 620, h: 560, treeW: 250 };

function _loadGeom(key, defs) {
  try { return { ...defs, ...JSON.parse(localStorage.getItem(key) || '{}') }; }
  catch { return { ...defs }; }
}
function _saveGeom(key, el, extra = {}) {
  if (!el) return;
  try {
    localStorage.setItem(key, JSON.stringify({
      x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, ...extra,
    }));
  } catch {}
}
function _winKey(w) { return w === libraryWin ? 'library' : w === previewWin ? 'preview' : null; }
function _winFromKey(k) { return k === 'library' ? libraryWin : k === 'preview' ? previewWin : null; }
function _saveSnap() {
  try { localStorage.setItem(SNAP_KEY, JSON.stringify({ left: _winKey(attach.left), right: _winKey(attach.right) })); }
  catch {}
}
function _loadSnap() {
  try { return JSON.parse(localStorage.getItem(SNAP_KEY) || '{}'); }
  catch { return {}; }
}

// ─── Small DOM helpers ──────────────────────────────────────────────────────

function _div(css = '') { const d = document.createElement('div'); if (css) d.style.cssText = css; return d; }
function _span(text, css = '') { const s = document.createElement('span'); s.textContent = text; if (css) s.style.cssText = css; return s; }

function _iconBtn(label, title, onClick, extraStyle = {}) {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = title;
  Object.assign(b.style, {
    background: 'none', border: 'none', color: '#a6adc8',
    cursor: 'pointer', fontSize: '13px', padding: '2px 6px',
    borderRadius: '4px', lineHeight: '1', flexShrink: '0',
    ...extraStyle,
  });
  b.addEventListener('mouseenter', () => { b.style.background = '#313244'; b.style.color = '#cdd6f4'; });
  b.addEventListener('mouseleave', () => { b.style.background = 'none'; b.style.color = extraStyle.color ?? '#a6adc8'; });
  b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
  return b;
}

function _safe(fn) { try { fn(); } catch (e) { console.error('[PLv2]', e); } }

// ─── Z-order ────────────────────────────────────────────────────────────────

let _zTop = 9000;

// ─── Snap manager (editor is the hub) ───────────────────────────────────────
//
// The editor window is the hub; the library and preview windows can each attach
// to one side of it (but never to each other). `attach.left` / `attach.right`
// hold the window glued to that side of the editor, forming a composite that
// drags / resizes / shadows as a single window.

const attach = { left: null, right: null };
function _attachedWins() { return [attach.left, attach.right].filter(Boolean); }
function _orderedComposite() { return [attach.left, editorWin, attach.right].filter(Boolean); }
function _snapActive() { return _attachedWins().length > 0; }
function _isSnapped(w) { return w === editorWin ? _snapActive() : (w === attach.left || w === attach.right); }

const SNAP_THRESHOLD = 20;  // px proximity to trigger highlight/snap
const MIN_V_OVERLAP  = 40;  // px vertical overlap required for a side snap
const VIEW_MARGIN    = 64;  // min px of a window kept on-screen so it stays grabbable

let _snapHL = null;         // blue highlight bar
let _composBg = null;       // shared backdrop that casts the composite's unified shadow
let _reflowing = false;     // guard against ResizeObserver feedback loops

// ── Viewport clamping (keep windows reachable) ──────────────────────────────

function _xBounds(w) { return [-(w - VIEW_MARGIN), window.innerWidth  - VIEW_MARGIN]; }
function _yBounds()  { return [0,                  window.innerHeight - VIEW_MARGIN]; }

/** Clamp a raw (dx,dy) so none of `items` ({el,x0,y0}) leaves the grabbable zone. */
function _clampDelta(items, dx, dy) {
  let loX = -Infinity, hiX = Infinity, loY = -Infinity, hiY = Infinity;
  for (const it of items) {
    const [minX, maxX] = _xBounds(it.el.offsetWidth);
    const [minY, maxY] = _yBounds();
    loX = Math.max(loX, minX - it.x0); hiX = Math.min(hiX, maxX - it.x0);
    loY = Math.max(loY, minY - it.y0); hiY = Math.min(hiY, maxY - it.y0);
  }
  if (loX <= hiX) dx = Math.min(Math.max(dx, loX), hiX);
  else            dx = Math.min(Math.max(dx, _xBounds(items[0].el.offsetWidth)[0] - items[0].x0),
                                          _xBounds(items[0].el.offsetWidth)[1] - items[0].x0);
  if (loY <= hiY) dy = Math.min(Math.max(dy, loY), hiY);
  return { dx, dy };
}

/** Shift a single window back into the grabbable zone. */
function _clampWindow(win) {
  if (!win.el) return;
  const [minX, maxX] = _xBounds(win.el.offsetWidth);
  const [minY, maxY] = _yBounds();
  win.el.style.left = Math.min(Math.max(win.el.offsetLeft, minX), maxX) + 'px';
  win.el.style.top  = Math.min(Math.max(win.el.offsetTop,  minY), maxY) + 'px';
}

/** Shift the whole composite as a rigid unit back into the grabbable zone. */
function _clampComposite() {
  if (!_snapActive()) return;
  const items = _orderedComposite().map(w => ({ el: w.el, x0: w.el.offsetLeft, y0: w.el.offsetTop }));
  const { dx, dy } = _clampDelta(items, 0, 0);
  for (const it of items) { it.el.style.left = (it.x0 + dx) + 'px'; it.el.style.top = (it.y0 + dy) + 'px'; }
}

// ── Composite cohesion (unified shadow + flattened seams) ───────────────────

function _ensureComposBg() {
  if (_composBg) return _composBg;
  _composBg = _div('position:fixed;background:#1e1e2e;border:1px solid #45475a;border-radius:8px;box-shadow:0 8px 32px rgba(0,0,0,.65);pointer-events:none;display:none;');
  document.body.appendChild(_composBg);
  return _composBg;
}
function _updateComposBg() {
  const comp = _orderedComposite();
  if (comp.length < 2) { if (_composBg) _composBg.style.display = 'none'; return; }
  const bg = _ensureComposBg();
  const first = comp[0].el, last = comp[comp.length - 1].el;
  const left = first.offsetLeft, right = last.offsetLeft + last.offsetWidth;
  const zMin = Math.min(...comp.map(w => parseInt(w.el.style.zIndex) || _zTop));
  Object.assign(bg.style, {
    left: left + 'px', top: editorWin.el.offsetTop + 'px',
    width: (right - left) + 'px', height: editorWin.el.offsetHeight + 'px',
    zIndex: String(zMin - 1), display: 'block',
  });
}
function _applySnapStyles() {
  // Reset every window to its standalone look first.
  for (const w of [editorWin, libraryWin, previewWin]) {
    if (!w || !w.el) continue;
    w.el.style.boxShadow = '0 8px 32px rgba(0,0,0,.65)';
    w.el.style.borderRadius = '8px';
    w.el.style.borderRight = '1px solid #45475a';
  }
  const comp = _orderedComposite();
  if (comp.length < 2) { if (_composBg) _composBg.style.display = 'none'; _setHandles(); return; }
  comp.forEach((w, i) => {
    const s = w.el.style;
    s.boxShadow = 'none';
    const first = i === 0, last = i === comp.length - 1;
    s.borderTopLeftRadius = s.borderBottomLeftRadius = first ? '8px' : '0';
    s.borderTopRightRadius = s.borderBottomRightRadius = last ? '8px' : '0';
    if (!last) s.borderRight = 'none';
  });
  _updateComposBg();
  _setHandles();
}

/** Raise a window to the top; when snapped, raise the whole composite together. */
function _focus(win) {
  if (_isSnapped(win)) {
    const z = ++_zTop;
    if (_composBg) _composBg.style.zIndex = String(z);
    for (const w of _orderedComposite()) w.el.style.zIndex = String(z + 1);
    _zTop = z + 1;
  } else if (win.el) {
    win.el.style.zIndex = String(++_zTop);
  }
}

/** Attach `w` (library/preview) to the editor on `side`, then reflow. */
function _attach(w, side) {
  if (w === editorWin) return;
  // A window can only occupy one side; clear it from the other first.
  if (attach.left === w) attach.left = null;
  if (attach.right === w) attach.right = null;
  attach[side] = w;
  _reflowComposite(true);
  _applySnapStyles();
  _clampComposite(); _updateComposBg(); _focus(editorWin);
  _saveSnap();
  for (const x of _orderedComposite()) x.save();
  if (previewWin && previewWin.isVisible()) _renderPreview();
}

/** Detach `w` from the editor (or, if `w` is the editor, detach everything). */
function _detach(w) {
  if (w === editorWin) { attach.left = null; attach.right = null; }
  else { if (attach.left === w) attach.left = null; if (attach.right === w) attach.right = null; }
  _applySnapStyles();
  for (const x of [editorWin, libraryWin, previewWin]) if (x && x.el && x.isVisible() && !_isSnapped(x)) _clampWindow(x);
  _saveSnap();
  if (previewWin && previewWin.isVisible()) _renderPreview();
}

/** Re-impose composite geometry: editor anchors, attached windows flush + locked. */
// `src` is the window that was just resized (its height becomes the shared
// height); the editor stays the horizontal anchor. So resizing ANY snapped
// window adjusts the whole composite's height (#1).
function _reflowComposite(src) {
  if (!_snapActive()) return;
  _reflowing = true;
  const ev = editorWin.el;
  const top = ev.offsetTop;
  const H = ((src && src.el) ? src.el : ev).offsetHeight;
  for (const w of _orderedComposite()) { w.el.style.top = top + 'px'; w.el.style.height = H + 'px'; }
  if (attach.left)  attach.left.el.style.left  = (ev.offsetLeft - attach.left.el.offsetWidth) + 'px';
  if (attach.right) attach.right.el.style.left = (ev.offsetLeft + ev.offsetWidth) + 'px';
  _updateComposBg();
  requestAnimationFrame(() => { _reflowing = false; });
}

/** Pick the side opposite the library (or a free side) for an auto-snap. */
function _sideOppositeLibrary() {
  if (attach.left === libraryWin) return 'right';
  if (attach.right === libraryWin) return 'left';
  if (libraryWin.isVisible() && editorWin.isVisible()) {
    const lr = libraryWin.el.getBoundingClientRect(), er = editorWin.el.getBoundingClientRect();
    return (lr.left + lr.width / 2 >= er.left + er.width / 2) ? 'left' : 'right';
  }
  return attach.right ? 'left' : 'right';
}

/** Auto-snap `w` (library/preview) to the editor, opening the editor if needed. */
function _autoSnap(w) {
  if (!editorWin.isVisible()) editorWin.show();
  if (!w.isVisible()) w.show();
  const other = w === libraryWin ? previewWin : libraryWin;
  let side;
  if (w === previewWin) {
    side = _sideOppositeLibrary();                          // preview goes opposite the library (#5)
  } else {                                                  // library: snap to whichever side it sits on
    const lr = w.el.getBoundingClientRect(), er = editorWin.el.getBoundingClientRect();
    side = (lr.left + lr.width / 2) < (er.left + er.width / 2) ? 'left' : 'right';
  }
  if (attach[side] === other) side = side === 'left' ? 'right' : 'left';   // don't collide with the other window
  _attach(w, side);
}

/** Editor's "open the other window" button → open + snap that window. */
function _openOther(fromWin) {
  const other = fromWin === editorWin ? libraryWin : editorWin;
  if (!fromWin.isVisible()) fromWin.show();
  if (!other.isVisible())   other.show();
  _autoSnap(other === editorWin ? fromWin : other);
}

function _ensureHighlight() {
  if (_snapHL) return _snapHL;
  _snapHL = _div('position:fixed;width:4px;background:#74c7ec;box-shadow:0 0 10px 2px #74c7ecaa;border-radius:2px;pointer-events:none;display:none;z-index:99999;');
  document.body.appendChild(_snapHL);
  return _snapHL;
}
function _showHighlight(cand) {
  const hl = _ensureHighlight();
  hl.style.left   = (cand.seamX - 2) + 'px';
  hl.style.top    = cand.top + 'px';
  hl.style.height = cand.height + 'px';
  hl.style.display = 'block';
}
function _hideHighlight() { if (_snapHL) _snapHL.style.display = 'none'; }

/**
 * Snap candidate for dragging `moving`. Only editor↔(library|preview) pairs are
 * allowed (library and preview never snap to each other). Returns the non-editor
 * window to attach + which side of the editor + seam geometry, or null.
 */
function _snapCandidate(moving) {
  const partners = moving === editorWin ? [libraryWin, previewWin] : [editorWin];
  for (const partner of partners) {
    if (!partner || !partner.isVisible()) continue;
    const attached = moving === editorWin ? partner : moving;   // the non-editor window
    if (attached === editorWin || !editorWin.isVisible()) continue;
    const a = attached.el.getBoundingClientRect();
    const h = editorWin.el.getBoundingClientRect();
    const top = Math.max(a.top, h.top), bot = Math.min(a.bottom, h.bottom);
    if (bot - top < MIN_V_OVERLAP) continue;
    // attached's right edge ≈ editor's left edge → attach LEFT
    if (Math.abs(a.right - h.left) <= SNAP_THRESHOLD && (!attach.left || attach.left === attached))
      return { attached, side: 'left', seamX: h.left, top, height: bot - top };
    // attached's left edge ≈ editor's right edge → attach RIGHT
    if (Math.abs(a.left - h.right) <= SNAP_THRESHOLD && (!attach.right || attach.right === attached))
      return { attached, side: 'right', seamX: h.right, top, height: bot - top };
  }
  return null;
}

/** Commit a drag-snap: attach the candidate window to the editor. */
function _commitSnap(cand) { _attach(cand.attached, cand.side); }

function _setHandles() {
  if (editorWin.dragHandle) editorWin.dragHandle.style.display = 'none';   // the hub is never detached
  for (const w of [libraryWin, previewWin]) {
    if (w && w.dragHandle) w.dragHandle.style.display = _isSnapped(w) ? 'inline-block' : 'none';
  }
}

/** Re-attach any previously-saved windows once the relevant windows are visible. */
function _maybeRestoreSnap() {
  if (!editorWin.isVisible()) return;
  const s = _loadSnap();
  for (const side of ['left', 'right']) {
    const w = _winFromKey(s[side]);
    if (w && w.isVisible() && !_isSnapped(w) && attach[side] == null) attach[side] = w;
  }
  if (_snapActive()) { _reflowComposite(); _applySnapStyles(); _clampComposite(); _updateComposBg(); }
}

function _closeWin(win) {
  _detach(win);          // close detaches only this window; the rest stay snapped
  win.hide();
}

// ─── Window dragging ────────────────────────────────────────────────────────

function _startDrag(win, e) {
  if (e.button !== 0) return;
  e.preventDefault();
  _focus(win);

  if (_isSnapped(win)) {
    // Composite drag — move the whole composite as one rigid unit, clamped together.
    const comp = _orderedComposite();
    const items = comp.map(w => ({ el: w.el, x0: w.el.offsetLeft, y0: w.el.offsetTop }));
    const sx = e.clientX, sy = e.clientY;
    const move = ev => {
      const { dx, dy } = _clampDelta(items, ev.clientX - sx, ev.clientY - sy);
      for (const it of items) { it.el.style.left = (it.x0 + dx) + 'px'; it.el.style.top = (it.y0 + dy) + 'px'; }
      _updateComposBg();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      for (const w of comp) w.save();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    return;
  }

  // Single drag — clamped, with live snap detection (only against the editor hub).
  const ox = e.clientX - win.el.offsetLeft;
  const oy = e.clientY - win.el.offsetTop;
  const canSnap = win.snappable;
  let cand = null;

  const move = ev => {
    const item = [{ el: win.el, x0: ev.clientX - ox, y0: ev.clientY - oy }];
    const { dx, dy } = _clampDelta(item, 0, 0);
    win.el.style.left = (item[0].x0 + dx) + 'px';
    win.el.style.top  = (item[0].y0 + dy) + 'px';
    cand = canSnap ? _snapCandidate(win) : null;
    if (cand) _showHighlight(cand); else _hideHighlight();
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    _hideHighlight();
    if (cand) _commitSnap(cand);
    else win.save();
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

// ─── Resize handle (between tree & detail inside the library window) ──────────

function _makeResizeHandle(getTarget, onDone) {
  const handle = _div('width:4px;flex-shrink:0;cursor:col-resize;background:#313244;transition:background 0.1s;');
  handle.addEventListener('mouseenter', () => { handle.style.background = '#45475a'; });
  handle.addEventListener('mouseleave', () => { handle.style.background = '#313244'; });
  handle.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const { el, startW } = getTarget();
    const startX = e.clientX;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const move = ev => { el.style.width = Math.max(120, startW + (ev.clientX - startX)) + 'px'; };
    const up = () => {
      document.body.style.cursor = ''; document.body.style.userSelect = '';
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      if (onDone) onDone();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  return handle;
}

// ─── Floating window factory ──────────────────────────────────────────────────

function _makeWindow({ key, title, defs, minW, buildBody, openOtherLabel, openOtherTitle, showSettings, topbarExtra, snappable = true }) {
  const win = {
    key, title, snappable, el: null, body: null, dragHandle: null,
    _built: false, _show: [], _hide: [],
    onShow(fn) { this._show.push(fn); },
    onHide(fn) { this._hide.push(fn); },
    isVisible() { return !!this.el && this.el.style.display !== 'none'; },
    save() { _saveGeom(key, this.el, this._extra ? this._extra() : {}); },
    show(node) {
      _ensureBuilt(this);
      if (node != null) _applyNode(node);
      this.el.style.display = 'flex';
      _clampWindow(this);
      _focus(this);
      this._show.forEach(_safe);
      _maybeRestoreSnap();
    },
    hide() {
      if (!this.el) return;
      _detach(this);
      this.el.style.display = 'none';
      this._hide.forEach(_safe);
    },
    toggle(node) { this.isVisible() && (node == null || state.activeNode === node) ? this.hide() : this.show(node); },
  };

  function _ensureBuilt(w) {
    if (w._built) return;
    w._built = true;
    const g = _loadGeom(key, defs);

    const el = _div();
    Object.assign(el.style, {
      position: 'fixed', left: g.x + 'px', top: g.y + 'px',
      width: g.w + 'px', height: g.h + 'px',
      display: 'none', flexDirection: 'column', zIndex: String(++_zTop),
      background: '#1e1e2e', border: '1px solid #45475a', borderRadius: '8px',
      boxShadow: '0 8px 32px rgba(0,0,0,.65)', overflow: 'hidden', resize: 'both',
      fontFamily: 'ui-sans-serif,system-ui,sans-serif', fontSize: '13px', color: '#cdd6f4',
      minWidth: (minW || 320) + 'px', minHeight: '320px',
    });
    el.addEventListener('mousedown', () => _focus(win), true);

    // Top bar
    const bar = _div('display:flex;align-items:center;gap:6px;padding:6px 10px;background:#181825;border-bottom:1px solid #313244;cursor:grab;user-select:none;flex-shrink:0;');
    const handle = _span('⠿', 'display:none;cursor:grab;color:#6c7086;font-size:13px;padding:0 2px;');
    handle.className = 'plv2-winhandle';
    handle.title = 'Drag to detach this window';
    handle.addEventListener('mousedown', ev => {
      ev.stopPropagation();
      _detach(win);            // tear this window off the composite, then drag it alone
      _startDrag(win, ev);
    });
    const titleEl = _span(title, 'font-weight:600;font-size:13px;color:#cba6f7;flex:1;');
    const closeBtn = _iconBtn('×', 'Close', () => _closeWin(win), { fontSize: '18px', lineHeight: '1', padding: '0 4px', color: '#6c7086' });
    bar.append(handle);
    if (openOtherLabel) {
      bar.append(_iconBtn(openOtherLabel, openOtherTitle || 'Open the other window (snapped)', () => _openOther(win), { fontSize: '13px', padding: '1px 4px' }));
    }
    bar.append(titleEl);
    if (topbarExtra) topbarExtra(bar, win);
    if (showSettings) {
      const gear = _iconBtn('⚙', 'Settings', () => _openSettings(), { fontSize: '14px', padding: '1px 4px' });
      bar.append(gear);
    }
    bar.append(closeBtn);
    bar.addEventListener('mousedown', ev => {
      if (ev.target.closest('button,.plv2-winhandle,select,input')) return;
      _startDrag(win, ev);
    });

    // Body
    const body = _div('display:flex;flex:1;overflow:hidden;min-height:0;');
    el.append(bar, body);
    document.body.appendChild(el);

    win.el = el; win.body = body; win.dragHandle = handle;
    if (buildBody) buildBody(body, win);

    // Persist + keep composite glued on resize.
    win._ro = new ResizeObserver(() => {
      if (_reflowing) return;
      win.save();
      if (_isSnapped(win)) _reflowComposite(win);   // resized window drives the shared height (#1)
    });
    win._ro.observe(el);
  }

  return win;
}

// ─── The two windows ──────────────────────────────────────────────────────────

// Editor: plv2_editor.js renders into win.body directly.
const editorWin = _makeWindow({
  key: EDITOR_KEY, title: 'Text Editor', defs: EDITOR_DEFS, minW: 320,
  openOtherLabel: '📚', openOtherTitle: 'Open Library (snapped to this window)',
  buildBody(body) { body.style.flexDirection = 'column'; },
});

// Library: tree (left, resizable) + detail (right, flex).
let _treePanel = null, _detailPanel = null, _treeW = LIBRARY_DEFS.treeW;
const libraryWin = _makeWindow({
  key: LIBRARY_KEY, title: 'Prompt Library', defs: LIBRARY_DEFS, minW: 560,
  openOtherLabel: '📝', openOtherTitle: 'Open Text Editor (snapped to this window)',
  showSettings: true,
  buildBody(body, win) {
    const g = _loadGeom(LIBRARY_KEY, LIBRARY_DEFS);
    _treeW = g.treeW || LIBRARY_DEFS.treeW;

    _treePanel = _div('display:flex;flex-direction:column;flex-shrink:0;min-width:0;overflow:hidden;border-right:1px solid #313244;');
    _treePanel.id = 'plv2-tree-col';
    _treePanel.style.width = _treeW + 'px';
    _treePanel.dataset.width = _treeW;

    const handle = _makeResizeHandle(
      () => ({ el: _treePanel, startW: _treePanel.offsetWidth }),
      () => { _treeW = _treePanel.offsetWidth; _treePanel.dataset.width = _treeW; win.save(); },
    );

    _detailPanel = _div('display:flex;flex-direction:column;flex:1;min-width:280px;background:#181825;overflow:hidden;');
    _detailPanel.id = 'plv2-detail';
    _detailPanel.appendChild(_span('Select an entry in the tree to view its details.',
      'display:block;padding:24px 16px;color:#6c7086;text-align:center;font-size:12px;'));

    body.append(_treePanel, handle, _detailPanel);
    win._extra = () => ({ treeW: _treePanel ? _treePanel.offsetWidth : _treeW });
  },
});

// Preview: live, read-only render of the resolved output (#10). It can snap to
// the editor like the library (but never to the library). Source is either the
// node (always single) or the editor (orientation always follows the editor).
let _previewBody = null;
let _pvSource = 'editor';   // 'editor' | 'node'
let _pvNodeId = null;
let _pvLayoutKey = '';      // current DOM layout signature (rebuild only when it changes — #6)
let _pvOuts = {};           // section key → output <div> (reused in place to avoid flicker)

const previewWin = _makeWindow({
  key: 'plv2_win_preview_v1', title: 'Preview', defs: { x: 1180, y: 80, w: 380, h: 520 }, minW: 240,
  buildBody(body) {
    body.style.flexDirection = 'column';
    _previewBody = _div('flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden;');
    body.appendChild(_previewBody);
  },
});

const PREVIEW_OUT_CSS = 'flex:1;overflow:auto;padding:10px 14px;white-space:pre-wrap;word-break:break-word;font-family:"Fira Code","Cascadia Code",Consolas,monospace;font-size:13px;line-height:1.6;color:#cdd6f4;scrollbar-width:thin;scrollbar-color:#45475a transparent;';

function _nodeTemplate(nodeId) {
  const n = (app.graph?.nodes ?? []).find(x => x.id === nodeId);
  return n?.widgets?.find(w => w.name === 'prompt_template')?.value ?? null;
}

/** Resolve `text` and write it into `out` only when it actually changed (no flicker). */
function _pvResolveInto(out, text) {
  api.resolveTemplate(text || '', 0)
    .then(r => { const t = (r?.text ?? '').trim() || '(empty)'; if (out.textContent !== t) out.textContent = t; })
    .catch(() => { if (out.textContent !== '(preview failed)') out.textContent = '(preview failed)'; });
}

function _renderPreview() {
  if (!_previewBody) return;
  if (_isSnapped(previewWin)) _pvSource = 'editor';   // snapped → always mirror the editor
  const data = window.plv2Editor?.getPreviewData?.() ?? null;

  // Decide the section list (orientation always follows the source: node→single, editor→its orientation).
  let sections;   // [{ key, label, color, text }]
  if (_pvSource === 'node') {
    sections = [{ key: 'node', label: null, color: '', text: _nodeTemplate(_pvNodeId) }];
  } else if (!data) {
    sections = null;   // placeholder
  } else if (data.orientation === 'split') {
    sections = [
      { key: 'pos', label: 'Positive', color: '#a6e3a1', text: data.pos ?? '' },
      { key: 'neg', label: 'Negative', color: '#f38ba8', text: data.neg ?? '' },
    ];
  } else {
    const tab = data.activeTab === 'neg' ? 'neg' : 'pos';
    sections = [{ key: 'single', label: null, color: '', text: tab === 'neg' ? (data.neg ?? '') : (data.pos ?? '') }];
  }

  const layoutKey = sections ? _pvSource + '|' + sections.map(s => s.key).join(',') : 'empty';

  // Rebuild the DOM only when the layout changes; otherwise reuse the output divs.
  if (layoutKey !== _pvLayoutKey) {
    _pvLayoutKey = layoutKey;
    _previewBody.innerHTML = '';
    _pvOuts = {};
    if (!sections) {
      _previewBody.appendChild(_span('Open the Text Editor to see a preview.', 'display:block;padding:24px 16px;color:#6c7086;text-align:center;font-size:12px;'));
    } else {
      for (const s of sections) {
        const sec = _div('flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden;border-top:1px solid #313244;');
        if (s.label) sec.appendChild(_span(s.label, `padding:3px 12px;font-size:11px;font-weight:600;background:#181825;border-bottom:1px solid #313244;color:${s.color};`));
        const out = _div(PREVIEW_OUT_CSS);
        sec.appendChild(out);
        _previewBody.appendChild(sec);
        _pvOuts[s.key] = out;
      }
    }
  }
  if (sections) for (const s of sections) { if (_pvOuts[s.key]) _pvResolveInto(_pvOuts[s.key], s.text); }
}

/** Position the preview adjacent to the editor, on the side away from the library. */
function _positionPreview() {
  if (!previewWin.el || !editorWin.isVisible()) return;
  const side = _sideOppositeLibrary();
  const er = editorWin.el.getBoundingClientRect();
  const w = previewWin.el.offsetWidth;
  let x = side === 'left' ? er.left - w - 8 : er.right + 8;
  if (x < 0) x = er.right + 8;
  previewWin.el.style.left = Math.max(0, x) + 'px';
  previewWin.el.style.top  = er.top + 'px';
}

// Editor's Preview button: toggle — if already open & snapped, close it (#3);
// otherwise mirror the editor, snapped to it.
previewWin.showEditor = () => {
  if (previewWin.isVisible() && _isSnapped(previewWin)) { _closeWin(previewWin); return; }
  _pvSource = 'editor';
  previewWin.show();
  if (!_isSnapped(previewWin)) _autoSnap(previewWin);
  _renderPreview();
};
// Node's Preview button: that one node, single orientation, standalone (#4).
previewWin.showNode = (nodeId) => {
  _pvSource = 'node'; _pvNodeId = nodeId;
  previewWin.show();
  _positionPreview();
  _renderPreview();
};

previewWin.onShow(() => { if (!_isSnapped(previewWin) && _pvSource !== 'node') _positionPreview(); _renderPreview(); });

let _previewTimer = null;
document.addEventListener('plv2:editor-changed', e => {
  if (!previewWin.isVisible() || _pvSource !== 'editor') return;
  if (e.detail && e.detail.immediate) { clearTimeout(_previewTimer); _renderPreview(); return; }  // structural change → no lag (#5)
  clearTimeout(_previewTimer);
  _previewTimer = setTimeout(_renderPreview, 150);
});
// A node-sourced preview tracks edits to that node's textbox (debounced, in place — #6).
document.addEventListener('plv2:node-edited', e => {
  if (!previewWin.isVisible() || _pvSource !== 'node' || e.detail?.nodeId !== _pvNodeId) return;
  clearTimeout(_previewTimer);
  _previewTimer = setTimeout(_renderPreview, 150);
});

// ─── Context menu (shared, no browser dialogs; supports submenus) ────────────
//
// Item shape: { label, action } | { separator: true } | { label, danger } |
//             { label, submenu: [items] | () => items | () => Promise<items> }

let _menuEls = [];

function _closeMenus(fromDepth = 0) {
  while (_menuEls.length > fromDepth) { const m = _menuEls.pop(); m.remove(); }
}

function _positionMenu(menu, x, y, flipLeftOf = null) {
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) {
      menu.style.left = (flipLeftOf != null ? flipLeftOf - r.width : x - r.width) + 'px';
    }
    if (r.bottom > window.innerHeight) menu.style.top = Math.max(4, window.innerHeight - r.height - 4) + 'px';
  });
}

function _renderMenu(items, depth) {
  const menu = _div('position:fixed;background:#1e1e2e;border:1px solid #45475a;border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.6);padding:4px 0;min-width:160px;max-height:72vh;overflow-y:auto;font-family:ui-sans-serif,system-ui,sans-serif;font-size:12px;scrollbar-width:thin;scrollbar-color:#45475a transparent;');
  menu.className = 'plv2-ctx-menu';
  menu.style.zIndex = String(100001 + depth);

  for (const item of items) {
    if (item.separator) { menu.appendChild(_div('height:1px;background:#313244;margin:3px 0;')); continue; }

    const hasSub = item.submenu != null;
    const opt = _div(`display:flex;align-items:center;gap:10px;padding:5px 14px;color:${item.danger ? '#f38ba8' : '#cdd6f4'};cursor:pointer;user-select:none;border-radius:3px;margin:1px 4px;`);
    const lbl = _span(item.label, 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');
    opt.appendChild(lbl);
    if (hasSub) opt.appendChild(_span('▸', 'color:#6c7086;flex-shrink:0;'));

    opt.addEventListener('mouseenter', async () => {
      opt.style.background = '#313244';
      _closeMenus(depth + 1);
      if (!hasSub) return;
      let sub = item.submenu;
      if (typeof sub === 'function') { try { sub = await sub(); } catch { sub = []; } }
      if (!Array.isArray(sub) || !sub.length) return;
      const r = opt.getBoundingClientRect();
      const child = _renderMenu(sub, depth + 1);
      document.body.appendChild(child);
      _menuEls.push(child);
      _positionMenu(child, r.right - 2, r.top, r.left);
    });
    opt.addEventListener('mouseleave', () => { opt.style.background = 'transparent'; });
    opt.addEventListener('mousedown', e => { e.preventDefault(); e.stopPropagation(); });
    if (!hasSub && item.action) {
      opt.addEventListener('click', () => { item.action(); _closeMenus(0); });
    }
    menu.appendChild(opt);
  }
  return menu;
}

function showContextMenu(x, y, items) {
  _closeMenus(0);
  const menu = _renderMenu(items, 0);
  document.body.appendChild(menu);
  _menuEls.push(menu);
  _positionMenu(menu, x, y);

  const close = e => {
    if (!_menuEls.some(m => m.contains(e.target))) {
      _closeMenus(0);
      document.removeEventListener('mousedown', close);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', close), 0);
}

// ─── Shared smart-insert planning (editor + entry prompt box) ────────────────
//
// Analyses where to drop an insert: at the end of the prompt the caret is in
// (so a prompt is never split), preserving newlines as structural separators.

function _planInsert(s, pos) {
  const lastDelimBefore = Math.max(
    s.lastIndexOf(',', pos - 1), s.lastIndexOf('|', pos - 1), s.lastIndexOf('\n', pos - 1),
  );
  const leftFrag = s.slice(lastDelimBefore + 1, pos).trim();
  let b;
  if (leftFrag === '') {
    b = pos;                                              // caret at a boundary
  } else {
    const k = s.slice(pos).search(/[,|\n]/);
    b = k === -1 ? s.length : pos + k;                   // caret inside a prompt → after it
  }
  // Strip only spaces/tabs/commas/pipes adjacent to the seam — NEVER newlines.
  const beforeContent = s.slice(0, b).replace(/[ \t,|]*$/, '');
  const afterContent  = s.slice(b).replace(/^[ \t,|]*/, '');
  // Separate the structural whitespace (newlines) at the seam from the prompt text,
  // so delimiters can be placed against the prompt *before* the newline.
  const beforeNL = (beforeContent.match(/\s*$/) || [''])[0];
  const beforeCore = beforeContent.slice(0, beforeContent.length - beforeNL.length);
  const afterNL = (afterContent.match(/^\s*/) || [''])[0];
  const afterCore = afterContent.slice(afterNL.length);
  const li = Math.max(beforeCore.lastIndexOf(','), beforeCore.lastIndexOf('|'), beforeCore.lastIndexOf('\n'));
  return {
    beforeCore, beforeNL, afterCore, afterNL,
    precedingToken: beforeCore.slice(li + 1).trim(),
  };
}

// Reconstruct around the insert. The delimiter attaches to the *preceding* prompt
// (before any newlines), and a trailing delimiter is added whenever real content
// follows — even across a blank line — but NOT at the very end of the whole text.
function _assembleInsert(plan, ins, leadDelim, D) {
  const lead  = plan.beforeCore === '' ? '' : leadDelim;
  const trail = plan.afterCore  === '' ? '' : D;
  return {
    value: plan.beforeCore + lead + plan.beforeNL + ins + trail + plan.afterNL + plan.afterCore,
    caret: (plan.beforeCore + lead + plan.beforeNL + ins).length,
  };
}

// ─── Shared inline prompt (small naming dialog) ──────────────────────────────

function inlinePrompt(title, defaultValue = '') {
  return new Promise(resolve => {
    const box = _div('position:fixed;z-index:100050;left:50%;top:40%;transform:translate(-50%,-50%);background:#252526;border:1px solid #454545;border-radius:6px;padding:12px 14px;box-shadow:0 4px 20px rgba(0,0,0,.7);display:flex;flex-direction:column;gap:8px;min-width:280px;font-family:ui-sans-serif,system-ui,sans-serif;');
    const lbl = _div('font-size:12px;color:#cdd6f4;font-weight:600;');
    lbl.textContent = title;
    const inp = document.createElement('input');
    inp.value = defaultValue;
    inp.style.cssText = 'background:#3c3c3c;border:1px solid #454545;border-radius:3px;color:#ccc;font-size:12px;padding:5px 8px;outline:none;';
    const btns = _div('display:flex;gap:6px;justify-content:flex-end;');
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'background:none;border:1px solid #454545;color:#a6adc8;font-size:11px;padding:3px 10px;border-radius:3px;cursor:pointer;';
    const ok = document.createElement('button');
    ok.textContent = 'OK';
    ok.style.cssText = 'background:#7c3aed;border:none;color:#fff;font-size:11px;padding:3px 10px;border-radius:3px;cursor:pointer;';
    btns.append(cancel, ok);
    box.append(lbl, inp, btns);
    document.body.appendChild(box);
    let done = false;
    const finish = v => { if (done) return; done = true; box.remove(); resolve(v); };
    cancel.addEventListener('click', () => finish(null));
    ok.addEventListener('click', () => finish(inp.value.trim() || null));
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); finish(inp.value.trim() || null); }
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    });
    requestAnimationFrame(() => { inp.focus(); inp.select(); });
  });
}

// ─── Prompt normalisation settings ───────────────────────────────────────────
//
// Three opt-in transforms applied to literal prompt text (NOT to [refs] or
// {patterns}), wherever prompts are entered / inserted / stored:
//   • escape     — escape non-weight "()" → "\(\)" and lone "\" → "\\"
//   • halfwidth  — convert full-width punctuation to ASCII
//   • underscore — replace "_" with a space

const SETTINGS_KEY = 'plv2_settings_v1';
const _settings = (() => {
  const defs = { escape: false, halfwidth: false, underscore: false };
  try { return { ...defs, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { ...defs }; }
})();
function _saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(_settings)); } catch {} }

const _FW_MAP = {
  '，': ',', '、': ',', '。': '.', '（': '(', '）': ')', '〈': '<', '〉': '>',
  '《': '<', '》': '>', '［': '[', '］': ']', '【': '[', '】': ']', '｛': '{', '｝': '}',
  '‘': "'", '’': "'", '“': '"', '”': '"',
  '；': ';', '：': ':', '！': '!', '？': '?', '　': ' ', '～': '~',
};
const _FW_RE = new RegExp('[' + Object.keys(_FW_MAP).join('') + ']', 'g');
function _toHalfwidth(s) { return s.replace(_FW_RE, c => _FW_MAP[c] ?? c); }

function _escapePrompt(seg) {
  // Protect weight groups "(content:number)" so their parens stay unescaped.
  const prot = new Set();
  const wre = /\(([^()]*:\s*-?[\d.]+)\s*\)/g;
  let m;
  while ((m = wre.exec(seg))) { prot.add(m.index); prot.add(m.index + m[0].length - 1); }
  let out = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '\\') {
      const n = seg[i + 1];
      if (n === '(' || n === ')' || n === '\\') { out += '\\' + n; i++; }  // keep existing escape unit
      else out += '\\\\';                                                  // lone backslash → double
    } else if ((c === '(' || c === ')') && !prot.has(i)) {
      out += '\\' + c;                                                     // non-weight paren → escape
    } else {
      out += c;
    }
  }
  return out;
}

function _normSeg(seg) {
  if (_settings.halfwidth)  seg = _toHalfwidth(seg);
  if (_settings.underscore) seg = seg.replace(/_/g, ' ');
  if (_settings.escape)     seg = _escapePrompt(seg);   // last: after full-width "（）" became "()"
  return seg;
}

/** Apply the enabled transforms to literal prompt text, skipping [refs]/{patterns}. */
function normalizePrompt(text) {
  if (typeof text !== 'string' || !text) return text;
  if (!_settings.escape && !_settings.halfwidth && !_settings.underscore) return text;
  const parts = text.split(/(\[[^\]\n]*\]|\{[^}\n]*\})/);   // odd indices = refs/patterns (kept)
  for (let i = 0; i < parts.length; i++) if (i % 2 === 0) parts[i] = _normSeg(parts[i]);
  return parts.join('');
}

// A single entry prompt must not end with a delimiter (#5) — unless it is made
// entirely of symbols (e.g. a prompt that *is* punctuation).
function _stripTrailingDelim(content) {
  if (typeof content !== 'string' || !content) return content;
  if (!/[\p{L}\p{N}]/u.test(content)) return content;          // all symbols → leave as-is
  return content.replace(/[\s,.;:、，。；：｜|/]+$/u, '');
}

/** Full cleaning for a stored entry prompt: normalise (settings) + trailing-delimiter trim. */
function cleanPrompt(content) {
  return _stripTrailingDelim(normalizePrompt(content));
}

// ─── Settings panel + "apply to existing library" ───────────────────────────

function _openSettings() {
  const old = document.getElementById('plv2-settings');
  if (old) { old.remove(); return; }

  const box = _div('position:fixed;z-index:100050;left:50%;top:50%;transform:translate(-50%,-50%);background:#1e1e2e;border:1px solid #45475a;border-radius:8px;padding:16px 18px;box-shadow:0 8px 32px rgba(0,0,0,.7);display:flex;flex-direction:column;gap:10px;min-width:420px;max-width:520px;font-family:ui-sans-serif,system-ui,sans-serif;color:#cdd6f4;');
  box.id = 'plv2-settings';

  const head = _div('display:flex;align-items:center;');
  head.append(_span('Prompt Normalisation', 'flex:1;font-weight:600;font-size:14px;color:#cba6f7;'));
  const x = _iconBtn('×', 'Close', () => box.remove(), { fontSize: '18px', color: '#6c7086' });
  head.append(x);
  box.append(head);

  const opt = (key, label, desc) => {
    const row = _div('display:flex;gap:10px;align-items:flex-start;padding:6px 4px;border-top:1px solid #313244;cursor:pointer;');
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = !!_settings[key];
    cb.style.cssText = 'margin-top:2px;accent-color:#cba6f7;cursor:pointer;flex-shrink:0;';
    const txt = _div('display:flex;flex-direction:column;gap:2px;');
    txt.append(_span(label, 'font-size:12px;font-weight:600;'), _span(desc, 'font-size:11px;color:#6c7086;'));
    row.append(cb, txt);
    const toggle = () => { _settings[key] = cb.checked; _saveSettings(); };
    cb.addEventListener('change', toggle);
    row.addEventListener('click', e => { if (e.target !== cb) { cb.checked = !cb.checked; toggle(); } });
    return row;
  };
  box.append(
    opt('escape',     'Escape brackets / backslashes', 'Non-weight "()" → "\\(\\)", and lone "\\" → "\\\\".'),
    opt('halfwidth',  'Full-width → half-width punctuation', 'Convert ，。（）《》［］ "" ；：！？ etc. to ASCII.'),
    opt('underscore', 'Underscores → spaces', 'Replace every "_" with a space.'),
  );

  const note = _span('Applies to new input / inserts everywhere. Use the button below to rewrite the existing library.',
    'font-size:11px;color:#6c7086;border-top:1px solid #313244;padding-top:8px;');
  box.append(note);

  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply to existing library';
  applyBtn.style.cssText = 'background:#7c3aed;border:none;border-radius:4px;color:#fff;font-size:12px;padding:7px 10px;cursor:pointer;';
  applyBtn.addEventListener('mouseenter', () => applyBtn.style.background = '#6d28d9');
  applyBtn.addEventListener('mouseleave', () => applyBtn.style.background = '#7c3aed');
  applyBtn.addEventListener('click', async () => {
    if (!_settings.escape && !_settings.halfwidth && !_settings.underscore) { _settingsToast('Enable at least one transform first.'); return; }
    applyBtn.disabled = true; applyBtn.textContent = 'Processing…';
    try { const report = await _applyToExistingLibrary(); _showApplyReport(report); }
    finally { applyBtn.disabled = false; applyBtn.textContent = 'Apply to existing library'; }
  });
  box.append(applyBtn);

  document.body.appendChild(box);
}

function _settingsToast(msg) {
  try { app.extensionManager.toast.add({ severity: 'warn', summary: 'Prompt Library V2', detail: msg, life: 3000 }); }
  catch { console.warn('[PLv2]', msg); }
}

async function _applyToExistingLibrary() {
  const nodes = (await api.getNodes())?.nodes ?? [];
  const entries = nodes.filter(n => n.has_prompts);
  const report = [];
  for (const e of entries) {
    let prompts = [];
    try { prompts = (await api.getPrompts(e.id))?.prompts ?? []; } catch { continue; }
    for (const p of prompts) {
      const nc = cleanPrompt(p.content);
      if (nc !== p.content && nc.trim()) {
        try { await api.updatePrompt(p.id, { content: nc }); report.push({ path: e.full_path, before: p.content, after: nc }); }
        catch (err) { console.error('[PLv2] apply failed', err); }
      }
    }
  }
  return report;
}

function _showApplyReport(report) {
  const old = document.getElementById('plv2-apply-report');
  if (old) old.remove();
  const box = _div('position:fixed;z-index:100051;left:50%;top:50%;transform:translate(-50%,-50%);background:#1e1e2e;border:1px solid #45475a;border-radius:8px;padding:14px 16px;box-shadow:0 8px 32px rgba(0,0,0,.7);display:flex;flex-direction:column;gap:8px;width:560px;max-width:90vw;max-height:70vh;font-family:ui-sans-serif,system-ui,sans-serif;color:#cdd6f4;');
  box.id = 'plv2-apply-report';
  const head = _div('display:flex;align-items:center;');
  head.append(_span(`Normalised ${report.length} prompt${report.length === 1 ? '' : 's'}`, 'flex:1;font-weight:600;font-size:13px;color:#cba6f7;'));
  head.append(_iconBtn('×', 'Close', () => box.remove(), { fontSize: '18px', color: '#6c7086' }));
  box.append(head);

  const list = _div('flex:1;overflow:auto;display:flex;flex-direction:column;gap:6px;border-top:1px solid #313244;padding-top:8px;scrollbar-width:thin;scrollbar-color:#45475a transparent;');
  if (!report.length) {
    list.append(_span('No prompts needed changes.', 'color:#6c7086;font-size:12px;padding:12px;text-align:center;'));
  }
  for (const r of report) {
    const row = _div('display:flex;flex-direction:column;gap:2px;font-size:11px;border-bottom:1px solid #25253a;padding-bottom:5px;');
    row.append(_span(r.path, 'color:#6c7086;'));
    const before = _span(r.before, 'color:#f38ba8;white-space:pre-wrap;word-break:break-word;');
    const after  = _span(r.after,  'color:#a6e3a1;white-space:pre-wrap;word-break:break-word;');
    row.append(before, _span('↓', 'color:#6c7086;'), after);
    list.append(row);
  }
  box.append(list);
  document.body.appendChild(box);
}

// ─── Node dropdown (shared, used by plv2_editor.js) ──────────────────────────

function populateNodeDropdown(sel) {
  if (!sel) return;
  const typeStr = state.activeTab === 'pos'
    ? 'XYZ Prompt Library V2 Positive'
    : 'XYZ Prompt Library V2 Negative';
  const graphNodes = (app.graph?.nodes ?? []).filter(n => n.comfyClass === typeStr);
  const prevId = state.activeNode?.id;

  sel.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = graphNodes.length ? '— select node —' : '(no nodes in workflow)';
  sel.appendChild(blank);

  let found = false;
  for (const n of graphNodes) {
    const o = document.createElement('option');
    o.value = String(n.id);
    o.textContent = `[${n.id}] ${n.title || (state.activeTab === 'pos' ? 'Positive' : 'Negative')}`;
    if (n.id === prevId) { o.selected = true; found = true; }
    sel.appendChild(o);
  }
  if (!found) state.activeNode = null;
  if (!found && graphNodes.length === 1) {
    sel.value = String(graphNodes[0].id);
    state.activeNode = graphNodes[0];
  }
}

// ─── Active node helper ───────────────────────────────────────────────────────

function _applyNode(litegraphNode) {
  if (litegraphNode.comfyClass === 'XYZ Prompt Library V2 Positive')      state.activeTab = 'pos';
  else if (litegraphNode.comfyClass === 'XYZ Prompt Library V2 Negative') state.activeTab = 'neg';
  state.activeNode = litegraphNode;
}

// ─── Tab-change listeners (editor pos/neg) ────────────────────────────────────

const _tabChangeCbs = [];

// ─── Public surface ───────────────────────────────────────────────────────────

window.plv2 = {
  api,
  state,
  showContextMenu,
  populateNodeDropdown,
  inlinePrompt,
  insert: { plan: _planInsert, assemble: _assembleInsert },
  settings: _settings,
  normalizePrompt,
  cleanPrompt,
  openSettings: _openSettings,

  windows: {
    editor:  editorWin,
    library: libraryWin,
    preview: previewWin,
  },

  // Back-compat surface consumed by the render modules.
  panel: {
    fireTabChange: (t) => {
      state.activeTab = t;
      state.activeNode = null;
      _tabChangeCbs.forEach(fn => _safe(() => fn(t)));
    },
    onTabChange: fn => _tabChangeCbs.push(fn),
    get el()        { return libraryWin.el; },           // dialogs center on the library window
    get editorCol() { return editorWin.body; },
    get tree()      { return _treePanel; },
    get detail()    { return _detailPanel; },
  },
};

// ─── Node extension (two buttons) + topbar (two buttons) ──────────────────────

const PLV2_TYPES = new Set([
  'XYZ Prompt Library V2 Positive',
  'XYZ Prompt Library V2 Negative',
]);

function _nodeBtn(label) {
  const b = document.createElement('button');
  b.textContent = label;
  Object.assign(b.style, {
    flex: '1', height: '28px', padding: '0 6px', margin: '0',
    background: '#7c3aed', border: 'none', borderRadius: '4px',
    color: '#fff', fontSize: '12px', cursor: 'pointer', boxSizing: 'border-box',
    lineHeight: '28px', fontFamily: 'inherit', whiteSpace: 'nowrap',
  });
  b.addEventListener('mouseenter', () => { b.style.background = '#6d28d9'; });
  b.addEventListener('mouseleave', () => { b.style.background = '#7c3aed'; });
  return b;
}

const PLV2_BTN_CLASS = 'xyz-plv2-top-menu-group';
const MAX_ATTACH     = 120;

function _attachTopBarButtons(attempt = 0) {
  if (document.querySelector(`.${PLV2_BTN_CLASS}`)) return;

  const settingsGroup = app.menu?.settingsGroup;
  if (!settingsGroup?.element?.parentElement) {
    if (attempt >= MAX_ATTACH) {
      console.warn('[PLv2] Unable to locate ComfyUI settings group; topbar buttons skipped.');
      return;
    }
    requestAnimationFrame(() => _attachTopBarButtons(attempt + 1));
    return;
  }

  const edBtn = new ComfyButton({
    icon: 'note-edit-outline', tooltip: 'Open Prompt Library V2 — Text Editor', app, enabled: true,
    classList: 'comfyui-button comfyui-menu-mobile-collapse primary',
  });
  edBtn.element.title = 'PLv2 Text Editor';
  edBtn.element.addEventListener('click', () => editorWin.show(null));

  const libBtn = new ComfyButton({
    icon: 'book-open-variant', tooltip: 'Open Prompt Library V2 — Library', app, enabled: true,
    classList: 'comfyui-button comfyui-menu-mobile-collapse primary',
  });
  libBtn.element.title = 'PLv2 Library';
  libBtn.element.addEventListener('click', () => libraryWin.show());

  const group = new ComfyButtonGroup(edBtn, libBtn);
  group.element.classList.add(PLV2_BTN_CLASS);
  settingsGroup.element.before(group.element);
}

app.registerExtension({
  name: 'XYZNodes.PromptLibraryV2',

  async nodeCreated(node) {
    if (!PLV2_TYPES.has(node.comfyClass)) return;
    node.serialize_widgets = true;

    const wrap = _div('display:flex;gap:6px;width:100%;box-sizing:border-box;');
    const edBtn  = _nodeBtn('📝 Editor');
    const libBtn = _nodeBtn('📚 Library');
    const pvBtn  = _nodeBtn('👁 Preview');
    edBtn.addEventListener('click',  () => editorWin.toggle(node));
    libBtn.addEventListener('click', () => libraryWin.toggle());
    pvBtn.addEventListener('click',  () => previewWin.showNode(node.id));   // #7
    wrap.append(edBtn, libBtn, pvBtn);

    const w = node.addDOMWidget('plv2_open_btns', 'custom', wrap, {
      getValue: () => '', setValue: () => {}, serialize: false,
    });
    w.computeSize = () => [node.size[0], 34];

    // Hook the node's prompt_template textbox (#9): live sync to the editor + blur
    // normalisation. inputEl may appear a frame or two after nodeCreated.
    const hook = (tries = 0) => {
      const tw = node.widgets?.find(x => x.name === 'prompt_template');
      const ta = tw?.inputEl;
      if (!ta) { if (tries < 60) requestAnimationFrame(() => hook(tries + 1)); return; }
      if (ta._plv2Hooked) return;
      ta._plv2Hooked = true;
      // user typing in the node box → mirror into the editor pane showing this node
      ta.addEventListener('input', () => {
        document.dispatchEvent(new CustomEvent('plv2:node-edited', { detail: { nodeId: node.id, value: ta.value } }));
      });
      // normalise on blur (skips [refs]/{patterns}); programmatic value sets don't fire 'input'
      ta.addEventListener('blur', () => {
        const v = normalizePrompt(ta.value);
        if (v !== ta.value) {
          ta.value = v;
          if (tw) tw.value = v;
          try { app.graph.setDirtyCanvas(true, true); } catch {}
          document.dispatchEvent(new CustomEvent('plv2:node-edited', { detail: { nodeId: node.id, value: v } }));
        }
      });
    };
    hook();
  },

  async setup() {
    _attachTopBarButtons();
  },
});
