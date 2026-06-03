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
  getInherited:   (nid)        => _req('GET',    `/xyz/plv2/nodes/${nid}/inherited`),
  setOverride:    (nid, pid, body) => _req('POST', `/xyz/plv2/nodes/${nid}/override/${pid}`, body),

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

  replaceRefs:       (nid, body) => _req('POST',  `/xyz/plv2/nodes/${nid}/refs/replace`, body),
  getUsages:         (nid)       => _req('GET',   `/xyz/plv2/nodes/${nid}/usages`),
  stripRefs:          (nid, body) => _req('POST',  `/xyz/plv2/nodes/${nid}/strip_refs`, body),

  // LLM Prompt Assistant (/xyz/llm/...). Chat itself uses a raw fetch (AbortController).
  llm: {
    getSettings:        ()              => _req('GET',    '/xyz/llm/settings'),
    saveSettings:       (body)          => _req('POST',   '/xyz/llm/settings', body),
    testConnection:     ()              => _req('POST',   '/xyz/llm/test', {}),
    listModels:         ()              => _req('POST',   '/xyz/llm/models', {}),
    getBlocks:          ()              => _req('GET',    '/xyz/llm/blocks'),
    createBlock:        (body)          => _req('POST',   '/xyz/llm/blocks', body),
    updateBlock:        (id, body)      => _req('PATCH',  `/xyz/llm/blocks/${id}`, body),
    deleteBlock:        (id)            => _req('DELETE', `/xyz/llm/blocks/${id}`),
    reorderBlocks:      (order)         => _req('POST',   '/xyz/llm/blocks/reorder', { order }),
    getVariants:        (id)            => _req('GET',    `/xyz/llm/blocks/${id}/variants`),
    createVariant:      (id, body)      => _req('POST',   `/xyz/llm/blocks/${id}/variants`, body),
    updateVariant:      (id, vid, body) => _req('PATCH',  `/xyz/llm/blocks/${id}/variants/${vid}`, body),
    deleteVariant:      (id, vid)       => _req('DELETE', `/xyz/llm/blocks/${id}/variants/${vid}`),
    setActiveVariant:   (id, vid)       => _req('POST',   `/xyz/llm/blocks/${id}/active-variant`, { variant_id: vid }),
    getConversations:   ()              => _req('GET',    '/xyz/llm/conversations'),
    createConversation: (title)         => _req('POST',   '/xyz/llm/conversations', { title }),
    renameConversation: (id, title)     => _req('PATCH',  `/xyz/llm/conversations/${id}`, { title }),
    deleteConversation: (id)            => _req('DELETE', `/xyz/llm/conversations/${id}`),
    getMessages:        (id)            => _req('GET',    `/xyz/llm/conversations/${id}/messages`),
    deleteLastAssistant:(id, inclUser)  => _req('DELETE', `/xyz/llm/conversations/${id}/last-assistant${inclUser ? '?include_user=1' : ''}`),
  },
};

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  activeNode:        null,   // LiteGraph node owning the editor
  selectedLibNodeId: null,   // lib node id selected in tree
  activeTab:         'pos',  // 'pos' | 'neg'
  focusNode:         null,   // node whose 📝 Editor button was just clicked — the editor
                             // consumes this on show to focus that node/polarity (one-shot)
};

// ─── Persistence ────────────────────────────────────────────────────────────

// v2: v1 entries may hold corrupted {0,0,0,0} geometry saved while a window was hidden
// (see _saveGeom guard). Bumping the keys gives those users a clean default on first launch.
const EDITOR_KEY  = 'plv2_win_editor_v2';
const LIBRARY_KEY = 'plv2_win_library_v2';
const PREVIEW_KEY = 'plv2_win_preview_v2';
const SNAP_KEY    = 'plv2_snap_v2';

const EDITOR_DEFS  = { x: 60,  y: 80, w: 520, h: 560 };
const LIBRARY_DEFS = { x: 600, y: 80, w: 620, h: 560, treeW: 250 };

function _loadGeom(key, defs) {
  try { return { ...defs, ...JSON.parse(localStorage.getItem(key) || '{}') }; }
  catch { return { ...defs }; }
}
function _saveGeom(key, el, extra = {}) {
  if (!el || !key) return;
  // A hidden (display:none) window reports offsetWidth/Height/Left/Top = 0. The
  // ResizeObserver fires on the hide transition, so without this guard closing a window
  // would persist {0,0,0,0} and clobber the real geometry — the window then "forgets"
  // its position/size on the next launch. Only persist a laid-out, non-zero box.
  if (el.offsetWidth === 0 || el.offsetHeight === 0) return;
  try {
    localStorage.setItem(key, JSON.stringify({
      x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight, ...extra,
    }));
  } catch {}
}

function _hasSavedGeom(key) {
  try { return !!localStorage.getItem(key); } catch { return false; }
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
// Composite resize model: internal seams are draggable splitters (reallocate width
// between the two adjacent windows); only the rightmost window has a corner resize
// handle, which scales ALL snapped windows proportionally + the shared height.
let _seamHandles = [];      // vertical splitter handles, one per internal seam
let _compResize = null;     // bottom-right corner handle on the rightmost composite window

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
  if (comp.length < 2) { if (_composBg) _composBg.style.display = 'none'; _hideCompHandles(); return; }
  const bg = _ensureComposBg();
  const first = comp[0].el, last = comp[comp.length - 1].el;
  const left = first.offsetLeft, right = last.offsetLeft + last.offsetWidth;
  const zs = comp.map(w => parseInt(w.el.style.zIndex) || _zTop);
  const zMin = Math.min(...zs), zMax = Math.max(...zs);
  Object.assign(bg.style, {
    left: left + 'px', top: editorWin.el.offsetTop + 'px',
    width: (right - left) + 'px', height: editorWin.el.offsetHeight + 'px',
    zIndex: String(zMin - 1), display: 'block',
  });
  // Seam splitters + the rightmost corner handle ride above the composite windows.
  _positionCompHandles(comp, zMax);
}
function _applySnapStyles() {
  // Reset every window to its standalone look first (incl. its own native resize grip).
  for (const w of [editorWin, libraryWin, previewWin]) {
    if (!w || !w.el) continue;
    w.el.style.boxShadow = '0 8px 32px rgba(0,0,0,.65)';
    w.el.style.borderRadius = '8px';
    w.el.style.borderRight = '1px solid #45475a';
    w.el.style.resize = 'both';
  }
  const comp = _orderedComposite();
  if (comp.length < 2) { if (_composBg) _composBg.style.display = 'none'; _hideCompHandles(); _setHandles(); return; }
  comp.forEach((w, i) => {
    const s = w.el.style;
    s.boxShadow = 'none';
    s.resize = 'none';   // snapped: sized via seam splitters + the rightmost corner handle
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
    _updateComposBg();   // keep seam/corner handles above the freshly-raised composite
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
  _reflowComposite();
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

/** Lay the ordered composite out flush from `left`/`top`, applying per-window `widths`
 *  and a shared `height`. The single source of truth for composite geometry. */
function _applyWidths(comp, widths, left, top, height) {
  _reflowing = true;
  let x = left;
  comp.forEach((w, i) => {
    const s = w.el.style;
    s.width = Math.round(widths[i]) + 'px';
    s.height = Math.round(height) + 'px';
    s.top = Math.round(top) + 'px';
    s.left = Math.round(x) + 'px';
    x += Math.round(widths[i]);
  });
  _updateComposBg();
  requestAnimationFrame(() => { _reflowing = false; });
}

/** Re-impose composite geometry keeping the EDITOR anchored horizontally (used on
 *  attach / snap-restore). Each window keeps its current width; height = editor's. */
function _reflowComposite() {
  if (!_snapActive()) return;
  const comp = _orderedComposite();
  const ev = editorWin.el;
  const left = ev.offsetLeft - (attach.left ? attach.left.el.offsetWidth : 0);
  _applyWidths(comp, comp.map(w => w.el.offsetWidth), left, ev.offsetTop, ev.offsetHeight);
}

function _minW(w) { return parseInt(w.el.style.minWidth) || 320; }

/** Drag a seam splitter at internal-seam index `i` (between comp[i] and comp[i+1]):
 *  reallocate width between the two neighbours; total composite width is unchanged. */
function _startSeamDrag(e, i) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  _focus(editorWin);
  const comp = _orderedComposite();
  if (i + 1 >= comp.length) return;
  const a = comp[i], b = comp[i + 1];
  const wa0 = a.el.offsetWidth, wb0 = b.el.offsetWidth;
  const minA = _minW(a), minB = _minW(b);
  const left0 = comp[0].el.offsetLeft, top0 = editorWin.el.offsetTop, H = editorWin.el.offsetHeight;
  const sx = e.clientX;
  document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none';
  const move = ev => {
    let dx = ev.clientX - sx;
    dx = Math.max(dx, minA - wa0);   // keep a ≥ minA
    dx = Math.min(dx, wb0 - minB);   // keep b ≥ minB
    const widths = comp.map(w => w.el.offsetWidth);
    widths[i] = wa0 + dx; widths[i + 1] = wb0 - dx;
    _applyWidths(comp, widths, left0, top0, H);
  };
  const up = () => {
    document.body.style.cursor = ''; document.body.style.userSelect = '';
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    for (const w of comp) w.save();
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

/** Drag the rightmost window's corner handle: scale ALL widths proportionally and set
 *  the shared height. The composite's top-left stays fixed; bottom-right follows. */
function _startCompResize(e) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  _focus(editorWin);
  const comp = _orderedComposite();
  const widths0 = comp.map(w => w.el.offsetWidth);
  const W0 = widths0.reduce((a, b) => a + b, 0);
  const H0 = editorWin.el.offsetHeight;
  const left0 = comp[0].el.offsetLeft, top0 = editorWin.el.offsetTop;
  const minRatio = Math.max(...comp.map((w, i) => _minW(w) / widths0[i]));
  const sx = e.clientX, sy = e.clientY;
  document.body.style.cursor = 'nwse-resize'; document.body.style.userSelect = 'none';
  const move = ev => {
    const ratio = Math.max(minRatio, (W0 + (ev.clientX - sx)) / W0);
    const widths = widths0.map(w => w * ratio);
    const H = Math.max(320, H0 + (ev.clientY - sy));
    _applyWidths(comp, widths, left0, top0, H);
  };
  const up = () => {
    document.body.style.cursor = ''; document.body.style.userSelect = '';
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    for (const w of comp) w.save();
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

function _hideCompHandles() {
  for (const h of _seamHandles) h.style.display = 'none';
  if (_compResize) _compResize.style.display = 'none';
}

/** Position the seam splitters + the rightmost corner handle over the composite. */
function _positionCompHandles(comp, zMax) {
  const top = editorWin.el.offsetTop, H = editorWin.el.offsetHeight;
  const z = String((zMax || _zTop) + 1);
  const nSeams = comp.length - 1;
  let x = comp[0].el.offsetLeft;
  for (let i = 0; i < nSeams; i++) {
    x += comp[i].el.offsetWidth;
    let h = _seamHandles[i];
    if (!h) {
      h = _div('position:fixed;width:9px;cursor:col-resize;z-index:100000;');
      const idx = i;
      h.addEventListener('mousedown', ev => _startSeamDrag(ev, idx));
      document.body.appendChild(h);
      _seamHandles[i] = h;
    }
    Object.assign(h.style, { left: (x - 4) + 'px', top: top + 'px', height: H + 'px', display: 'block', zIndex: z });
  }
  for (let i = nSeams; i < _seamHandles.length; i++) _seamHandles[i].style.display = 'none';

  if (!_compResize) {
    _compResize = _div('position:fixed;width:18px;height:18px;cursor:nwse-resize;z-index:100000;'
      + 'background:linear-gradient(135deg,transparent 45%,#6c7086 45%,#6c7086 55%,transparent 55%,transparent 70%,#6c7086 70%,#6c7086 80%,transparent 80%);');
    _compResize.addEventListener('mousedown', _startCompResize);
    document.body.appendChild(_compResize);
  }
  const last = comp[comp.length - 1].el;
  Object.assign(_compResize.style, {
    left: (last.offsetLeft + last.offsetWidth - 18) + 'px',
    top: (last.offsetTop + last.offsetHeight - 18) + 'px',
    display: 'block', zIndex: z,
  });
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

function _makeWindow({ key, title, defs, minW, buildBody, openOtherLabel, openOtherTitle, showSettings, snappable = true }) {
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
      boxSizing: 'border-box',   // so style.width === offsetWidth for exact composite math
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
    bar.append(titleEl);
    if (openOtherLabel) {
      const otherBtn = _iconBtn(openOtherLabel, openOtherTitle || 'Open the other window (snapped)', () => _openOther(win), { fontSize: '11px', padding: '3px 8px' });
      bar.append(otherBtn);
    }
    if (showSettings) {
      const gear = _iconBtn('⚙', 'Open XYZ Prompt Tools settings', () => {
        try { window.xyzSettingsPage?.show(); } catch {}
      }, { fontSize: '14px', padding: '1px 4px' });
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

    // Persist geometry on native (standalone) resize. While snapped, native resize is
    // disabled and the composite is sized via the seam/corner handles, so this only
    // fires for free-floating windows (and is guarded against the programmatic reflow).
    win._ro = new ResizeObserver(() => {
      if (_reflowing) return;
      win.save();
    });
    win._ro.observe(el);
  }

  return win;
}

// ─── The two windows ──────────────────────────────────────────────────────────

// Editor: plv2_editor.js renders into win.body directly.
const editorWin = _makeWindow({
  key: EDITOR_KEY, title: 'Text Editor', defs: EDITOR_DEFS, minW: 320,
  openOtherLabel: 'Library', openOtherTitle: 'Open Library (snaps to this window)',
  buildBody(body) { body.style.flexDirection = 'column'; },
});

// Library: tree (left, resizable) + detail (right, flex).
let _treePanel = null, _detailPanel = null, _treeW = LIBRARY_DEFS.treeW;
const libraryWin = _makeWindow({
  key: LIBRARY_KEY, title: 'Prompt Library', defs: LIBRARY_DEFS, minW: 560,
  openOtherLabel: 'Editor', openOtherTitle: 'Open Text Editor (snaps to this window)',
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
let _pvDeps = new Set();    // node_ids the last resolution walked through (see previewDeps)

const previewWin = _makeWindow({
  key: PREVIEW_KEY, title: 'Preview', defs: { x: 1180, y: 80, w: 380, h: 520 }, minW: 240,
  buildBody(body) {
    body.style.flexDirection = 'column';
    _previewBody = _div('flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden;');
    body.appendChild(_previewBody);
  },
});

// LLM Prompt Assistant — the 4th window. Body is rendered by js/plv2_llm.js on first
// show (it hooks windows.llm.onShow), so here we only build the empty column container.
const LLM_KEY  = 'plv2_win_llm_v2';
const LLM_DEFS = { x: 1240, y: 80, w: 480, h: 640 };
const llmWin = _makeWindow({
  key: LLM_KEY, title: '🤖 LLM Prompt', defs: LLM_DEFS, minW: 400, showSettings: true,
  buildBody(body) {
    body.style.flexDirection = 'column';
    body.dataset.plv2Llm = '1';   // plv2_llm.js renders into this body
  },
});

const PREVIEW_OUT_CSS = 'flex:1;overflow:auto;padding:10px 14px;white-space:pre-wrap;word-break:break-word;font-family:"Fira Code","Cascadia Code",Consolas,monospace;font-size:13px;line-height:1.6;color:#cdd6f4;scrollbar-width:thin;scrollbar-color:#45475a transparent;';

function _nodeTemplate(nodeId) {
  const n = (app.graph?.nodes ?? []).find(x => x.id === nodeId);
  return n?.widgets?.find(w => w.name === 'prompt_template')?.value ?? null;
}

/** Resolve `text` and write it into `out` only when it actually changed (no flicker).
 *  Also folds the resolution's dependency node_ids into `_pvDeps` (union across the
 *  pos/neg sections of one render) so entry edits know whether to re-resolve. */
function _pvResolveInto(out, text) {
  api.resolveTemplate(text || '', 0)
    .then(r => {
      if (Array.isArray(r?.node_ids)) for (const id of r.node_ids) _pvDeps.add(id);
      const t = (r?.text ?? '').trim() || '(empty)'; if (out.textContent !== t) out.textContent = t;
    })
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
  // Recompute the dependency set on every render; each section's resolve unions in.
  _pvDeps = new Set();
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

previewWin.onShow(() => {
  // Auto-place next to the editor only on first use; once a geometry has been saved
  // (user moved/resized it, or a prior auto-placement), respect the remembered one.
  if (!_isSnapped(previewWin) && _pvSource !== 'node' && !_hasSavedGeom(PREVIEW_KEY)) {
    _positionPreview();
  }
  _renderPreview();
});

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
// A node-sourced preview also tracks edits to any *entry* it resolves through (an
// indirectly referenced library entry). Gated by the recorded dependency set so it
// only re-resolves when the edited entry actually contributes. (The editor-sourced
// case is handled above via plv2:editor-changed + previewDeps.)
document.addEventListener('plv2:entry-content-changed', e => {
  if (!previewWin.isVisible() || _pvSource !== 'node') return;
  const id = e.detail?.nodeId;
  if (id == null || !_pvDeps.has(id)) return;
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
  // Split the seam (run of whitespace + delimiters around the insertion point)
  // from the prompt cores. Keep ONLY newlines as structural layout and drop the
  // stray spaces/commas/pipes, so we never emit a doubled delimiter — e.g. a caret
  // after "prompt, \n" must NOT become "prompt,, \n[ref]" (the comma sits before
  // the newline and was previously left in beforeCore).
  const beforeRaw = s.slice(0, b);
  const afterRaw  = s.slice(b);
  const seamBefore = (beforeRaw.match(/[\s,|]*$/) || [''])[0];
  const seamAfter  = (afterRaw.match(/^[\s,|]*/)  || [''])[0];
  const beforeCore = beforeRaw.slice(0, beforeRaw.length - seamBefore.length);
  const afterCore  = afterRaw.slice(seamAfter.length);
  const beforeNL = '\n'.repeat((seamBefore.match(/\n/g) || []).length);
  const afterNL  = '\n'.repeat((seamAfter.match(/\n/g)  || []).length);
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

// In-page confirm dialog (replaces window.confirm so it layers above the floating
// windows and matches the app theme). Resolves true (OK) / false (Cancel/Escape).
function inlineConfirm(message, { okLabel = 'OK', danger = false } = {}) {
  return new Promise(resolve => {
    const bg = _div('position:fixed;inset:0;z-index:100049;background:rgba(0,0,0,.35);');
    const box = _div('position:fixed;z-index:100050;left:50%;top:40%;transform:translate(-50%,-50%);background:#252526;border:1px solid #454545;border-radius:6px;padding:14px 16px;box-shadow:0 4px 20px rgba(0,0,0,.7);display:flex;flex-direction:column;gap:12px;min-width:280px;max-width:420px;font-family:ui-sans-serif,system-ui,sans-serif;');
    const lbl = _div('font-size:12px;color:#cdd6f4;line-height:1.5;white-space:pre-wrap;');
    lbl.textContent = message;
    const btns = _div('display:flex;gap:6px;justify-content:flex-end;');
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.style.cssText = 'background:none;border:1px solid #454545;color:#a6adc8;font-size:11px;padding:4px 12px;border-radius:3px;cursor:pointer;';
    const ok = document.createElement('button');
    ok.textContent = okLabel;
    ok.style.cssText = `background:${danger ? '#f38ba8' : '#7c3aed'};border:none;color:${danger ? '#11111b' : '#fff'};font-size:11px;font-weight:600;padding:4px 12px;border-radius:3px;cursor:pointer;`;
    btns.append(cancel, ok);
    box.append(lbl, btns);
    document.body.append(bg, box);
    let done = false;
    const finish = v => { if (done) return; done = true; bg.remove(); box.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = e => {
      if (e.key === 'Enter')  { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    };
    cancel.addEventListener('click', () => finish(false));
    ok.addEventListener('click', () => finish(true));
    bg.addEventListener('mousedown', () => finish(false));
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => ok.focus());
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
  const defs = { escape: false, halfwidth: false, underscore: false, commaSpace: false };
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

// Comma spacing: collapse "," + any run of spaces/tabs into ", " (exactly one space).
// Never touches line breaks — a comma at end of line keeps its newline and gains no
// trailing space ("a,\n", "a,  \n" → "a,\n"); inline commas get exactly one space.
function _normCommaSpace(seg) {
  return seg.replace(/,[ \t]*(\r?\n)?/g, (_m, nl) => (nl ? ',' + nl : ', '));
}

function _normSeg(seg) {
  if (_settings.halfwidth)  seg = _toHalfwidth(seg);
  if (_settings.underscore) seg = seg.replace(/_/g, ' ');
  if (_settings.commaSpace) seg = _normCommaSpace(seg);  // after half-width "，"→","
  if (_settings.escape)     seg = _escapePrompt(seg);   // last: after full-width "（）" became "()"
  return seg;
}

/** Apply the enabled transforms to literal prompt text, skipping [refs]/{patterns}. */
function normalizePrompt(text) {
  if (typeof text !== 'string' || !text) return text;
  if (!_settings.escape && !_settings.halfwidth && !_settings.underscore && !_settings.commaSpace) return text;
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


// ─── Active node helper ───────────────────────────────────────────────────────

function _applyNode(litegraphNode) {
  if (litegraphNode.comfyClass === 'XYZ Prompt Library V2 Positive')      state.activeTab = 'pos';
  else if (litegraphNode.comfyClass === 'XYZ Prompt Library V2 Negative') state.activeTab = 'neg';
  state.activeNode = litegraphNode;
  // Signal the editor's onShow handler to focus THIS specific node (and switch the
  // single-mode polarity tab to match). Consumed + cleared by the editor's _refresh.
  state.focusNode = litegraphNode;
}

// ─── Public surface ───────────────────────────────────────────────────────────

window.plv2 = {
  api,
  state,
  showContextMenu,
  inlinePrompt,
  inlineConfirm,
  insert: { plan: _planInsert, assemble: _assembleInsert },
  // Node ids the live preview last resolved through (entry detail uses this to
  // decide whether an edit must re-resolve the preview — handles indirect refs).
  previewDeps: () => _pvDeps,
  settings: _settings,
  saveSettings: _saveSettings,   // persist normalize flags (used by unified settings page)
  normalizePrompt,
  cleanPrompt,
  // Normalisation settings now live in the XYZ Prompt Tools unified settings page.
  openSettings: () => { try { window.xyzSettingsPage?.show(); } catch {} },

  windows: {
    editor:  editorWin,
    library: libraryWin,
    preview: previewWin,
    llm:     llmWin,
  },

  // Back-compat surface consumed by the render modules (containers + dialog anchor).
  panel: {
    get el()        { return libraryWin.el; },           // dialogs center on the library window
    get editorCol() { return editorWin.body; },
    get tree()      { return _treePanel; },
    get detail()    { return _detailPanel; },
  },
};

// ─── Node extension (three per-node buttons) ──────────────────────────────────────

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

app.registerExtension({
  name: 'XYZNodes.PromptLibraryV2',

  async nodeCreated(node) {
    if (!PLV2_TYPES.has(node.comfyClass)) return;
    node.serialize_widgets = true;

    const wrap = _div('display:flex;gap:6px;width:100%;box-sizing:border-box;flex-wrap:wrap;');
    const edBtn  = _nodeBtn('📝 Editor');
    const libBtn = _nodeBtn('📚 Library');
    const pvBtn  = _nodeBtn('👁 Preview');
    const llmBtn = _nodeBtn('🤖 LLM');
    edBtn.addEventListener('click',  () => editorWin.toggle(node));
    libBtn.addEventListener('click', () => libraryWin.toggle());
    pvBtn.addEventListener('click',  () => previewWin.showNode(node.id));   // #7
    llmBtn.addEventListener('click', () => {
      llmWin.show();
      document.dispatchEvent(new CustomEvent('plv2:llm-bind', { detail: { nodeId: node.id } }));
    });
    wrap.append(edBtn, libBtn, pvBtn, llmBtn);

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
    // Topbar buttons are now consolidated into the XYZ dropdown (gallery_topbar.js).
  },
});
