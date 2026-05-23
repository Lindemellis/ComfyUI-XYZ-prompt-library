/**
 * Prompt Library V2 — text editor window
 *
 * Two-row top bar:
 *   row 1: [Edit ▾]  [A──slider──A]  [Preview]
 *   row 2: [orientation]  (single: [Positive][Negative]  [node ▾])
 *
 * Orientation:
 *   • single — one pane; the pos/neg tabs switch which polarity it edits.
 *   • split  — positive pane on top, negative pane on bottom, draggable divider;
 *              each pane has its own header (label + node selector).
 *
 * Each pane mirrors a Prompt Library V2 node's `prompt_template` widget, with
 * [entry] syntax highlighting, its own undo/redo history, and live node-list
 * refresh. Find/Replace, undo/redo, smart-insert and the right-click menu all
 * act on the focused ("active") pane.
 */

import { app } from '../../../scripts/app.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const FONT = '"Fira Code","Cascadia Code",Consolas,monospace';
const PAD  = '10px 14px';
const LH   = '1.6';
const POS_TYPE = 'XYZ Prompt Library V2 Positive';
const NEG_TYPE = 'XYZ Prompt Library V2 Negative';
const ORIENT_KEY = 'plv2_editor_orientation_v1';
const SPLIT_KEY  = 'plv2_editor_split_v1';
const _REF_RE = /^\[([^\]]*)\]$/;

// ─── State ────────────────────────────────────────────────────────────────────

let _built       = false;
let _editorBody  = null;     // container that holds the pane(s)
let _row2        = null;     // rebuilt per orientation
let _orientBtn   = null;     // orientation toggle (row 1)
let _orientation = localStorage.getItem(ORIENT_KEY) === 'split' ? 'split' : 'single';
let _splitRatio  = parseFloat(localStorage.getItem(SPLIT_KEY) || '0.5') || 0.5;
let _fontSz      = 13;
let _singleTab   = 'pos';
let _savedNodes  = { pos: null, neg: null };

let _panes  = [];
let _active = null;
let _textarea = null, _backdrop = null;   // pointers to the active pane's elements

// Find / replace
let _findPanel = null, _findCountEl = null, _findSel = null;
const _findState = { query: '', replace: '', matchCase: false, wholeWord: false, inSelection: false };

// Live node-list refresh (#3)
let _nodeSig = '', _pollTimer = null;

// ─── Syntax highlight ─────────────────────────────────────────────────────────

function _hlInner(text) {
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\[([^\]\n]*)\]/g, '<span style="background:#2d1b5e;color:#cba6f7;border-radius:2px">[$1]</span>');
}
function _highlight(text) { return _hlInner(text) + '\n'; }

// Highlight + mark a selection range (the "find in selection" scope — #2).
function _highlightWithSel(text, s, e) {
  if (s == null || e == null || e <= s) return _highlight(text);
  return _hlInner(text.slice(0, s))
    + '<span style="background:#3a4a63">' + _hlInner(text.slice(s, e)) + '</span>'
    + _hlInner(text.slice(e)) + '\n';
}

// ─── Graph node helpers ─────────────────────────────────────────────────────

const _typeForTab  = tab => (tab === 'pos' ? POS_TYPE : NEG_TYPE);
const _graphNodes  = tab => (app.graph?.nodes ?? []).filter(n => n.comfyClass === _typeForTab(tab));

function _toast(detail, severity = 'warn') {
  try { app.extensionManager.toast.add({ severity, summary: 'Prompt Library V2', detail, life: 3500 }); }
  catch { console.warn('[PLv2]', detail); }
}

// ─── Pane ─────────────────────────────────────────────────────────────────────

function _makePane(tab, withHeader) {
  const pane = { tab, node: null, ckpt: [], ckptIdx: 0, ckptTimer: null, applying: false };

  const el = document.createElement('div');
  el.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden;';

  // Optional header (split mode): polarity label + node selector.
  if (withHeader) {
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 10px;background:#181825;border-bottom:1px solid #313244;flex-shrink:0;';
    const lbl = document.createElement('span');
    lbl.textContent = tab === 'pos' ? 'Positive' : 'Negative';
    lbl.style.cssText = `font-size:12px;font-weight:600;color:${tab === 'pos' ? '#a6e3a1' : '#f38ba8'};`;
    const spacer = document.createElement('div'); spacer.style.flex = '1';
    const sel = _makeNodeSelect();
    header.append(lbl, spacer, sel);
    el.appendChild(header);
    pane.nodeSel = sel;
    _wireNodeSel(pane);
  }

  // Editor area: highlighted backdrop + transparent textarea overlay.
  const area = document.createElement('div');
  area.style.cssText = 'flex:1;position:relative;overflow:hidden;';
  _injectStyleOnce();

  const backdrop = document.createElement('div');
  backdrop.className = 'plv2-bd';
  Object.assign(backdrop.style, {
    position: 'absolute', inset: '0', padding: PAD,
    fontFamily: FONT, fontSize: _fontSz + 'px', lineHeight: LH,
    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    color: '#cdd6f4', background: 'transparent', pointerEvents: 'none',
    overflowY: 'auto', overflowX: 'hidden', boxSizing: 'border-box', scrollbarWidth: 'none',
  });

  const textarea = document.createElement('textarea');
  Object.assign(textarea.style, {
    position: 'absolute', inset: '0', width: '100%', height: '100%', padding: PAD,
    fontFamily: FONT, fontSize: _fontSz + 'px', lineHeight: LH,
    background: 'transparent', color: 'transparent', caretColor: '#cdd6f4',
    border: 'none', outline: 'none', resize: 'none', boxSizing: 'border-box',
    overflowY: 'auto', wordBreak: 'break-word',
  });
  textarea.setAttribute('spellcheck', 'false');
  textarea.placeholder = 'e.g. [toki], {smile|laugh}, solo';

  textarea.addEventListener('focus', () => _setActive(pane));
  textarea.addEventListener('scroll', () => { backdrop.scrollTop = textarea.scrollTop; });
  textarea.addEventListener('input', () => { pane.updateBackdrop(); pane.syncToNode(); pane.ckptRecord(); _emitChanged(); });
  textarea.addEventListener('keydown', _onKeydown);
  textarea.addEventListener('contextmenu', _onContextMenu);
  // Normalise the template when editing finishes (skips [refs]/{patterns}).
  textarea.addEventListener('blur', () => {
    const v = window.plv2.normalizePrompt(textarea.value);
    if (v !== textarea.value) {
      textarea.value = v;
      pane.updateBackdrop(); pane.syncToNode(); pane.ckptRecord(true); _emitChanged();
    }
  });

  area.append(backdrop, textarea);
  el.appendChild(area);

  pane.el = el; pane.backdrop = backdrop; pane.textarea = textarea;

  // ── methods ──
  pane.widget = () => pane.node?.widgets?.find(w => w.name === 'prompt_template') ?? null;

  pane.resolveNode = () => {
    const nodes = _graphNodes(pane.tab);
    let n = _savedNodes[pane.tab];
    if (!n || !nodes.some(x => x.id === n.id)) n = nodes[0] ?? null;
    pane.node = n;
    if (n) _savedNodes[pane.tab] = n;
  };

  pane.populate = () => {
    const sel = pane.nodeSel;
    if (!sel) return;
    const nodes = _graphNodes(pane.tab);
    sel.innerHTML = '';
    if (!nodes.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = '(no nodes in workflow)'; o.disabled = true; o.selected = true;
      sel.appendChild(o);
      return;
    }
    for (const n of nodes) {
      const o = document.createElement('option');
      o.value = String(n.id);
      o.textContent = `[${n.id}] ${n.title || (pane.tab === 'pos' ? 'Positive' : 'Negative')}`;
      if (pane.node && n.id === pane.node.id) o.selected = true;
      sel.appendChild(o);
    }
  };

  pane.syncFromNode = () => {
    const val = pane.widget()?.value ?? '';
    if (pane.textarea.value !== val) pane.textarea.value = val;
    pane.updateBackdrop();
    pane.ckptReset();
    pane.setDisabled(!pane.node);
  };

  pane.syncToNode = () => {
    const w = pane.widget();
    if (!w) return;
    w.value = pane.textarea.value;
    if (w.inputEl && w.inputEl.value !== pane.textarea.value) w.inputEl.value = pane.textarea.value;  // node box live update (#9)
    try { app.graph.setDirtyCanvas(true, true); } catch {}
  };

  pane.updateBackdrop = () => {
    if (pane === _active && _findState.inSelection && _findSel) {
      pane.backdrop.innerHTML = _highlightWithSel(pane.textarea.value, _findSel.start, _findSel.end);
    } else {
      pane.backdrop.innerHTML = _highlight(pane.textarea.value);
    }
  };

  pane.setFont = px => { pane.backdrop.style.fontSize = px + 'px'; pane.textarea.style.fontSize = px + 'px'; };

  pane.setDisabled = b => {
    pane.textarea.disabled = b;
    pane.textarea.style.opacity = b ? '0.4' : '1';
    pane.textarea.style.cursor  = b ? 'not-allowed' : '';
    pane.textarea.placeholder   = b ? '(no nodes of this type in workflow)' : 'e.g. [toki], {smile|laugh}, solo';
  };

  // Per-pane undo/redo checkpoint history.
  pane.ckptReset = () => { pane.ckpt = [{ value: pane.textarea.value, caret: pane.textarea.value.length }]; pane.ckptIdx = 0; clearTimeout(pane.ckptTimer); };
  pane.ckptRecord = (immediate = false) => {
    clearTimeout(pane.ckptTimer);
    const commit = () => {
      if (pane.applying) return;
      const v = pane.textarea.value;
      if (pane.ckpt[pane.ckptIdx] && pane.ckpt[pane.ckptIdx].value === v) return;
      pane.ckpt = pane.ckpt.slice(0, pane.ckptIdx + 1);
      pane.ckpt.push({ value: v, caret: pane.textarea.selectionStart ?? v.length });
      if (pane.ckpt.length > 300) pane.ckpt.shift();
      pane.ckptIdx = pane.ckpt.length - 1;
    };
    if (immediate) commit(); else pane.ckptTimer = setTimeout(commit, 350);
  };
  pane.applyCkpt = () => {
    pane.applying = true;
    const c = pane.ckpt[pane.ckptIdx];
    pane.textarea.value = c.value;
    const caret = Math.min(c.caret, c.value.length);
    pane.textarea.selectionStart = pane.textarea.selectionEnd = caret;
    pane.updateBackdrop(); pane.syncToNode();
    pane.applying = false; pane.textarea.focus();
  };
  pane.undo = () => { pane.ckptRecord(true); if (pane.ckptIdx <= 0) return; pane.ckptIdx--; pane.applyCkpt(); };
  pane.redo = () => { if (pane.ckptIdx >= pane.ckpt.length - 1) return; pane.ckptIdx++; pane.applyCkpt(); };

  return pane;
}

function _makeNodeSelect() {
  const sel = document.createElement('select');
  sel.style.cssText = 'background:#313244;border:1px solid #45475a;border-radius:4px;color:#cdd6f4;font-size:12px;padding:3px 6px;min-width:150px;max-width:240px;cursor:pointer;';
  return sel;
}

function _wireNodeSel(pane) {
  pane.nodeSel.addEventListener('change', () => {
    const id = parseInt(pane.nodeSel.value);
    pane.node = isNaN(id) ? null : (_graphNodes(pane.tab).find(n => n.id === id) ?? null);
    if (pane.node) _savedNodes[pane.tab] = pane.node;
    _setActive(pane);
    pane.syncFromNode();
    _emitChanged();
  });
}

function _injectStyleOnce() {
  if (document.getElementById('plv2-editor-style')) return;
  const s = document.createElement('style');
  s.id = 'plv2-editor-style';
  s.textContent = `
    .plv2-bd::-webkit-scrollbar { display: none; }
    #plv2-editor-col textarea::placeholder { color: #45475a; }
    #plv2-editor-col textarea { scrollbar-width: thin; scrollbar-color: #45475a transparent; }
  `;
  document.head.appendChild(s);
}

// ─── Active pane ────────────────────────────────────────────────────────────

function _setActive(pane) {
  if (!pane) return;
  _active = pane;
  _textarea = pane.textarea;
  _backdrop = pane.backdrop;
  window.plv2.state.activeTab  = pane.tab;
  window.plv2.state.activeNode = pane.node;
  for (const p of _panes) p.el.style.boxShadow = (_orientation === 'split' && p === pane) ? 'inset 0 0 0 1px #45475a' : 'none';
  _emitChanged();    // active polarity changed → snapped single preview follows (#3)
}

function _paneForPolarity(posNeg) {
  const tab = posNeg === 'negative' ? 'neg' : 'pos';
  return _panes.find(p => p.tab === tab) ?? null;
}

// ─── Build ────────────────────────────────────────────────────────────────────

function _build(col) {
  if (_built) return;
  _built = true;
  col.id = col.id || 'plv2-editor-col';

  // ── Top bar, row 1: Edit / font / preview ──
  const row1 = document.createElement('div');
  row1.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 10px;background:#181825;border-bottom:1px solid #313244;flex-shrink:0;';

  const editBtn = _flatBtn('Edit ▾');
  editBtn.addEventListener('click', () => {
    const r = editBtn.getBoundingClientRect();
    window.plv2.showContextMenu(r.left, r.bottom + 2, [
      { label: 'Undo            Ctrl+Z', action: () => { _textarea?.focus(); _active?.undo(); } },
      { label: 'Redo            Ctrl+Y', action: () => { _textarea?.focus(); _active?.redo(); } },
      { separator: true },
      { label: 'Find / Replace  Ctrl+F', action: () => _openFind() },
    ]);
  });
  row1.appendChild(editBtn);

  // Font slider
  const fontWrap = document.createElement('div');
  fontWrap.style.cssText = 'display:flex;align-items:center;gap:4px;';
  fontWrap.appendChild(_span('A', 'font-size:10px;color:#6c7086;'));
  const fontSlider = document.createElement('input');
  fontSlider.type = 'range'; fontSlider.min = '10'; fontSlider.max = '20'; fontSlider.step = '1'; fontSlider.value = String(_fontSz);
  fontSlider.style.cssText = 'width:64px;cursor:pointer;accent-color:#cba6f7;';
  fontSlider.addEventListener('input', () => { _fontSz = parseInt(fontSlider.value); _applyFont(); });
  fontWrap.appendChild(fontSlider);
  fontWrap.appendChild(_span('A', 'font-size:14px;color:#6c7086;font-weight:600;'));
  row1.appendChild(fontWrap);

  const spacer1 = document.createElement('div'); spacer1.style.flex = '1'; row1.appendChild(spacer1);

  // Orientation toggle (#8 — lives in row 1 with edit/preview).
  _orientBtn = _flatBtn('');
  _orientBtn.title = 'Toggle orientation (single / split positive+negative)';
  _orientBtn.addEventListener('click', _toggleOrientation);
  row1.appendChild(_orientBtn);

  const previewBtn = _flatBtn('👁 Preview');
  previewBtn.title = 'Open a live preview window';
  previewBtn.addEventListener('click', () => window.plv2.windows.preview.showEditor());
  row1.appendChild(previewBtn);

  // ── Top bar, row 2: orientation + (single: tabs + node select) ──
  _row2 = document.createElement('div');
  _row2.style.cssText = 'display:flex;align-items:center;gap:6px;padding:4px 10px;background:#181825;border-bottom:1px solid #313244;flex-shrink:0;';

  // ── Pane body ──
  _editorBody = document.createElement('div');
  _editorBody.style.cssText = 'flex:1;display:flex;flex-direction:column;min-height:0;overflow:hidden;';

  col.append(row1, _row2, _editorBody);
  _renderPanes();
}

function _syncOrientBtn() {
  if (_orientBtn) _orientBtn.textContent = _orientation === 'split' ? '⊟ Split' : '▭ Single';
}

function _buildRow2() {
  _row2.innerHTML = '';
  _syncOrientBtn();

  if (_orientation === 'single') {
    // pos / neg tabs
    for (const t of ['pos', 'neg']) {
      const b = document.createElement('button');
      b.textContent = t === 'pos' ? 'Positive' : 'Negative';
      b.dataset.tab = t;
      b.style.cssText = 'padding:3px 10px;border:1px solid transparent;border-radius:4px;font-size:12px;font-weight:500;cursor:pointer;background:none;';
      b.addEventListener('click', () => _switchSingleTab(t));
      _row2.appendChild(b);
    }
    const spacer = document.createElement('div'); spacer.style.flex = '1'; _row2.appendChild(spacer);
    // node selector bound to the single pane
    const sel = _makeNodeSelect();
    _panes[0].nodeSel = sel;
    _wireNodeSel(_panes[0]);
    _row2.appendChild(sel);
    _applySingleTabStyle();
  } else {
    _row2.appendChild(_span('Positive (top) · Negative (bottom)', 'font-size:11px;color:#6c7086;flex:1;'));
  }
}

function _applySingleTabStyle() {
  for (const b of _row2.querySelectorAll('[data-tab]')) {
    const active = b.dataset.tab === _singleTab;
    b.style.background  = active ? '#313244' : 'none';
    b.style.color       = active ? (b.dataset.tab === 'pos' ? '#a6e3a1' : '#f38ba8') : '#6c7086';
    b.style.borderColor = active ? '#45475a' : 'transparent';
  }
}

function _switchSingleTab(tab) {
  if (_singleTab === tab) return;
  _singleTab = tab;
  const pane = _panes[0];
  pane.tab = tab;
  pane.resolveNode();
  pane.populate();
  pane.syncFromNode();
  _setActive(pane);
  _applySingleTabStyle();
  _emitChanged(true);   // polarity switch → snapped single preview follows immediately (#5)
}

function _renderPanes() {
  _editorBody.innerHTML = '';
  if (_orientation === 'single') {
    const pane = _makePane(_singleTab, false);
    _panes = [pane];
    _editorBody.appendChild(pane.el);
  } else {
    const pos = _makePane('pos', true);
    const neg = _makePane('neg', true);
    pos.el.style.flex = String(_splitRatio);
    neg.el.style.flex = String(1 - _splitRatio);
    _panes = [pos, neg];
    _editorBody.append(pos.el, _makeDivider(pos, neg), neg.el);
  }
  _buildRow2();
  for (const p of _panes) { p.resolveNode(); p.populate(); p.syncFromNode(); }
  _setActive(_panes[0]);
  _applyFont();
}

function _toggleOrientation() {
  _orientation = _orientation === 'single' ? 'split' : 'single';
  try { localStorage.setItem(ORIENT_KEY, _orientation); } catch {}
  if (_orientation === 'single') _singleTab = _active?.tab ?? _singleTab;
  _renderPanes();
  _emitChanged(true);   // structural change → preview updates with no lag (#5)
}

function _makeDivider(top, bottom) {
  const d = document.createElement('div');
  d.style.cssText = 'height:5px;flex-shrink:0;cursor:row-resize;background:#313244;transition:background 0.1s;';
  d.addEventListener('mouseenter', () => { d.style.background = '#45475a'; });
  d.addEventListener('mouseleave', () => { d.style.background = '#313244'; });
  d.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = _editorBody.getBoundingClientRect();
    document.body.style.cursor = 'row-resize'; document.body.style.userSelect = 'none';
    const move = ev => {
      let r = (ev.clientY - rect.top) / rect.height;
      r = Math.min(0.85, Math.max(0.15, r));
      _splitRatio = r;
      top.el.style.flex = String(r);
      bottom.el.style.flex = String(1 - r);
    };
    const up = () => {
      document.body.style.cursor = ''; document.body.style.userSelect = '';
      try { localStorage.setItem(SPLIT_KEY, String(_splitRatio)); } catch {}
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  return d;
}

function _applyFont() {
  for (const p of _panes) p.setFont(_fontSz);
}

// ─── Live node-list refresh (#3) ─────────────────────────────────────────────

function _nodeSignature() {
  return ['pos', 'neg'].map(t => _graphNodes(t).map(n => n.id + ':' + (n.title || '')).join(',')).join('|');
}
function _refreshNodes() {
  const sig = _nodeSignature();
  if (sig === _nodeSig) return;
  _nodeSig = sig;
  for (const p of _panes) {
    if (p.node && !_graphNodes(p.tab).some(n => n.id === p.node.id)) {
      p.node = null; _savedNodes[p.tab] = null;
      p.resolveNode();
      p.syncFromNode();
    }
    p.populate();
    p.setDisabled(!p.node);
  }
  if (_active) window.plv2.state.activeNode = _active.node;
}
function _startPoll() { _stopPoll(); _nodeSig = ''; _refreshNodes(); _pollTimer = setInterval(_refreshNodes, 700); }
function _stopPoll()  { if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; } }

// ─── Smart insert ───────────────────────────────────────────────────────────

async function _resolveRefDelim(inner) {
  try { return (await window.plv2.api.resolveRef(inner))?.node?.delimiter ?? null; } catch { return null; }
}

async function _computeInsert(s, pos, ins, D) {
  const plan = window.plv2.insert.plan(s, pos);
  let leadDelim = D;
  if (plan.beforeCore !== '') {
    const m = plan.precedingToken.match(_REF_RE);
    if (m) leadDelim = (await _resolveRefDelim(m[1])) ?? D;   // entry2's own delimiter
  }
  return window.plv2.insert.assemble(plan, ins, leadDelim, D);
}

/** Insert at the caret of a specific pane. */
async function _insertIntoPane(pane, text, D) {
  const pos = pane.textarea.selectionStart ?? pane.textarea.value.length;
  const { value, caret } = await _computeInsert(pane.textarea.value, pos, text, D);
  pane.textarea.value = value;
  pane.textarea.selectionStart = pane.textarea.selectionEnd = caret;
  pane.textarea.focus();
  pane.updateBackdrop(); pane.syncToNode(); pane.ckptRecord(true);
  _emitChanged();
}

/** Plain caret insert into the active pane (back-compat, no delimiter logic). */
function insertText(text) {
  if (!_active) return;
  text = window.plv2.normalizePrompt(text);
  const t = _active.textarea;
  const start = t.selectionStart ?? t.value.length, end = t.selectionEnd ?? start;
  t.value = t.value.slice(0, start) + text + t.value.slice(end);
  t.selectionStart = t.selectionEnd = start + text.length;
  t.focus();
  _active.updateBackdrop(); _active.syncToNode(); _active.ckptRecord(true);
  _emitChanged();
}

/** Insert a [ref] / prompt block into the node matching `posNeg`. */
async function insertRef(posNeg, text, delimiter) {
  const tab     = posNeg === 'negative' ? 'neg' : 'pos';
  const nodes   = _graphNodes(tab);
  if (!nodes.length) { _toast(`No ${posNeg} Prompt Library V2 node in this workflow.`); return; }
  text = window.plv2.normalizePrompt(text);   // [refs] are skipped; plain prompt blocks normalised
  const D = delimiter || ', ';

  // A visible pane that already shows the right polarity → caret insert there.
  const pane = _paneForPolarity(posNeg);
  if (pane && pane.node) { await _insertIntoPane(pane, text, D); return; }

  // Otherwise resolve a target node and append to its widget (offscreen).
  let target = (_savedNodes[tab] && nodes.some(n => n.id === _savedNodes[tab].id)) ? _savedNodes[tab] : nodes[0];
  _savedNodes[tab] = target;
  const widget = target.widgets?.find(w => w.name === 'prompt_template');
  if (!widget) return;
  const { value } = await _computeInsert(widget.value ?? '', (widget.value ?? '').length, text, D);
  widget.value = value;
  try { app.graph.setDirtyCanvas(true, true); } catch {}
  _toast(`Inserted into ${posNeg} node [${target.id}].`, 'success');
  _emitChanged();
}

// ─── Keyboard shortcuts (#4 undo/redo/find) ──────────────────────────────────

function _onKeydown(e) {
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey)     { e.preventDefault(); _active?.undo(); }
  else if (k === 'y')               { e.preventDefault(); _active?.redo(); }
  else if (k === 'z' && e.shiftKey) { e.preventDefault(); _active?.redo(); }
  else if (k === 'f')               { e.preventDefault(); _openFind(); }
}

// ─── Find / Replace ───────────────────────────────────────────────────────────

function _afterEdit() { _active.updateBackdrop(); _active.syncToNode(); _active.ckptRecord(true); _emitChanged(); }

function _findRegex() {
  if (!_findState.query) return null;
  let pat = _findState.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (_findState.wholeWord) pat = `\\b${pat}\\b`;
  try { return new RegExp(pat, _findState.matchCase ? 'g' : 'gi'); } catch { return null; }
}
function _findScope() {
  if (_findState.inSelection && _findSel && _findSel.end > _findSel.start) {
    return { text: _textarea.value.slice(_findSel.start, _findSel.end), offset: _findSel.start };
  }
  return { text: _textarea.value, offset: 0 };
}
function _findMatches() {
  const re = _findRegex(); if (!re) return [];
  const scope = _findScope();
  return [...scope.text.matchAll(re)].map(m => ({ start: m.index + scope.offset, end: m.index + m[0].length + scope.offset }));
}
function _updateFindCount(cur = 0) {
  if (!_findCountEl) return;
  const total = _findMatches().length;
  _findCountEl.textContent = total ? `${cur || 0}/${total}` : '0/0';
}
function _doFindNext(backwards = false) {
  const matches = _findMatches();
  if (!matches.length) { _updateFindCount(0); return; }
  let idx;
  if (backwards) {
    idx = -1;
    for (let i = 0; i < matches.length; i++) if (matches[i].end <= (_textarea.selectionStart ?? 0)) idx = i;
    if (idx === -1) idx = matches.length - 1;
  } else {
    idx = matches.findIndex(m => m.start >= (_textarea.selectionEnd ?? 0));
    if (idx === -1) idx = 0;
  }
  const m = matches[idx];
  _textarea.focus();
  _textarea.setSelectionRange(m.start, m.end);
  _updateFindCount(idx + 1);
}
function _doReplace() {
  const re = _findRegex(); if (!re) return;
  const s = _textarea.selectionStart, e = _textarea.selectionEnd;
  const sel = _textarea.value.slice(s, e);
  if (sel && new RegExp('^(?:' + re.source + ')$', _findState.matchCase ? '' : 'i').test(sel)) {
    _textarea.value = _textarea.value.slice(0, s) + _findState.replace + _textarea.value.slice(e);
    const caret = s + _findState.replace.length;
    _textarea.setSelectionRange(caret, caret);
    _afterEdit();
  }
  _doFindNext();
}
function _doReplaceAll() {
  const re = _findRegex(); if (!re) return;
  const scope = _findScope();
  const replaced = scope.text.replace(re, _findState.replace);
  _textarea.value = _textarea.value.slice(0, scope.offset) + replaced + _textarea.value.slice(scope.offset + scope.text.length);
  _afterEdit(); _updateFindCount(0);
}
function _findToggle(label, title, key) {
  const b = document.createElement('button');
  b.textContent = label; b.title = title;
  b.style.cssText = 'border:1px solid;border-radius:3px;font-size:11px;padding:2px 6px;cursor:pointer;flex-shrink:0;';
  const sync = () => {
    b.style.background  = _findState[key] ? '#7c3aed' : '#313244';
    b.style.color       = _findState[key] ? '#fff' : '#a6adc8';
    b.style.borderColor = _findState[key] ? '#7c3aed' : '#45475a';
  };
  sync();
  b.addEventListener('click', () => {
    _findState[key] = !_findState[key];
    if (key === 'inSelection') {
      _findSel = _findState[key] ? { start: _textarea.selectionStart ?? 0, end: _textarea.selectionEnd ?? 0 } : null;
      _active?.updateBackdrop();    // #2 — show/clear the selection highlight
    }
    sync(); _updateFindCount(0);
  });
  return b;
}
function _buildFindPanel() {
  const panel = document.createElement('div');
  panel.style.cssText = 'position:absolute;top:6px;right:6px;z-index:6;background:#252536;border:1px solid #45475a;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.55);padding:7px;display:none;flex-direction:column;gap:5px;width:320px;font-family:ui-sans-serif,system-ui,sans-serif;';
  const mkInput = ph => { const i = document.createElement('input'); i.type = 'text'; i.placeholder = ph; i.style.cssText = 'flex:1;min-width:0;background:#1e1e2e;border:1px solid #45475a;border-radius:3px;color:#cdd6f4;font-size:12px;padding:3px 6px;outline:none;'; return i; };
  const mkBtn = (l, t) => { const b = document.createElement('button'); b.textContent = l; b.title = t || l; b.style.cssText = 'background:#313244;border:1px solid #45475a;border-radius:3px;color:#cdd6f4;font-size:11px;padding:2px 7px;cursor:pointer;flex-shrink:0;'; b.addEventListener('mouseenter', () => b.style.background = '#45475a'); b.addEventListener('mouseleave', () => b.style.background = '#313244'); return b; };

  const row1 = document.createElement('div'); row1.style.cssText = 'display:flex;align-items:center;gap:4px;';
  const findIn = mkInput('Find'); findIn.value = _findState.query;
  _findCountEl = document.createElement('span'); _findCountEl.style.cssText = 'font-size:10px;color:#6c7086;min-width:36px;text-align:center;flex-shrink:0;';
  const prevB = mkBtn('▲', 'Previous (Shift+Enter)'), nextB = mkBtn('▼', 'Next (Enter)'), closeB = mkBtn('✕', 'Close (Esc)');
  findIn.addEventListener('input', () => { _findState.query = findIn.value; _updateFindCount(0); });
  findIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); _doFindNext(e.shiftKey); } if (e.key === 'Escape') { e.preventDefault(); _closeFind(); } });
  prevB.addEventListener('click', () => _doFindNext(true));
  nextB.addEventListener('click', () => _doFindNext(false));
  closeB.addEventListener('click', () => _closeFind());
  row1.append(findIn, _findCountEl, prevB, nextB, closeB);

  const row2 = document.createElement('div'); row2.style.cssText = 'display:flex;align-items:center;gap:4px;flex-wrap:wrap;';
  row2.append(_findToggle('Aa', 'Match case', 'matchCase'), _findToggle('W', 'Match whole word', 'wholeWord'), _findToggle('In selection', 'Find/replace only within the selection', 'inSelection'));

  const row3 = document.createElement('div'); row3.style.cssText = 'display:flex;align-items:center;gap:4px;';
  const repIn = mkInput('Replace'); repIn.value = _findState.replace;
  repIn.addEventListener('input', () => { _findState.replace = repIn.value; });
  repIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); _doReplace(); } });
  const repB = mkBtn('Replace'), repAllB = mkBtn('Replace All');
  repB.addEventListener('click', () => _doReplace());
  repAllB.addEventListener('click', () => _doReplaceAll());
  row3.append(repIn, repB, repAllB);

  panel.append(row1, row2, row3);
  panel._findInput = findIn;
  return panel;
}
function _openFind() {
  if (!_active) return;
  // The find panel lives in the active pane's area so it tracks the focused editor.
  if (_findPanel) _findPanel.remove();
  _findPanel = _buildFindPanel();
  _active.textarea.parentElement.appendChild(_findPanel);   // the pane's editor area
  const s = _textarea.selectionStart ?? 0, e = _textarea.selectionEnd ?? 0;
  if (e > s) { _findState.query = _textarea.value.slice(s, e); _findPanel._findInput.value = _findState.query; }
  _findPanel.style.display = 'flex';
  _updateFindCount(0);
  requestAnimationFrame(() => { _findPanel._findInput?.focus(); _findPanel._findInput?.select(); });
}
function _closeFind() {
  if (_findPanel) _findPanel.style.display = 'none';
  if (_findState.inSelection) { _findState.inSelection = false; _findSel = null; _active?.updateBackdrop(); }
  _textarea?.focus();
}

// ─── Right-click context menu (#5/#8) ────────────────────────────────────────

/**
 * Build a recursive context-menu mirroring the folder/entry tree.
 *   pickable(node)  — may this node be chosen?  (folders + entries for "create",
 *                     entries only for "add to entry")
 *   onPick(node|null) — called with the chosen node, or null for the root option.
 * Branches with no pickable node anywhere inside are pruned.
 */
function _buildTreeMenu(nodes, pickable, onPick, rootLabel) {
  const byParent = new Map();
  for (const n of nodes) {
    const k = n.parent_id ?? null;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(n);
  }
  const sortN = arr => [...arr].sort((a, b) => a.name.localeCompare(b.name));
  const hasPickDesc = node => (byParent.get(node.id) ?? []).some(k => pickable(k) || hasPickDesc(k));

  const build = node => {
    const icon = node.has_prompts ? '📝 ' : '📁 ';
    const kids = sortN(byParent.get(node.id) ?? []).filter(k => pickable(k) || hasPickDesc(k));
    if (!kids.length) return pickable(node) ? { label: icon + node.name, action: () => onPick(node) } : null;
    const sub = [];
    if (pickable(node)) sub.push({ label: '＋ select this', action: () => onPick(node) });
    for (const k of kids) { const it = build(k); if (it) sub.push(it); }
    return sub.length ? { label: icon + node.name, submenu: sub } : null;
  };

  const top = [];
  if (rootLabel) top.push({ label: rootLabel, action: () => onPick(null) });
  for (const r of sortN(byParent.get(null) ?? []).filter(n => pickable(n) || hasPickDesc(n))) {
    const it = build(r);
    if (it) top.push(it);
  }
  return top;
}

const _CTX_DELIM = /[,|\n]/;
function _tokenAt(s, pos) {
  let start = pos, end = pos;
  while (start > 0 && !_CTX_DELIM.test(s[start - 1])) start--;
  while (end < s.length && !_CTX_DELIM.test(s[end])) end++;
  return { start, end, text: s.slice(start, end).trim() };
}
/**
 * The inner text of the [ref] the caret sits in/adjacent to (#4, solution A).
 * Matches by bracket pairing, not delimiter tokens, so trailing punctuation like
 * "[a.b]." or "[a.b]，" still counts. The caret may also be right after the "]".
 */
function _refAtCaret(s, pos) {
  const re = /\[([^\[\]\n]*)\]/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const start = m.index, end = m.index + m[0].length;
    if (pos >= start && pos <= end) return m[1];   // inside, or just before '[' / just after ']'
  }
  return null;
}
async function _onContextMenu(e) {
  const ta = e.currentTarget;
  const s = ta.value;
  const selStart = ta.selectionStart ?? 0, selEnd = ta.selectionEnd ?? 0;
  const tok = _tokenAt(s, selStart);
  const text = (selEnd > selStart) ? s.slice(selStart, selEnd).trim() : tok.text;
  const refInner = _refAtCaret(s, selStart);
  if (!text && refInner == null) return;
  e.preventDefault();

  let nodes = [];
  try { nodes = (await window.plv2.api.getNodes())?.nodes ?? []; } catch {}
  const items = [];
  if (text) {
    // Recursive submenus mirroring the folder/entry tree (#B).
    const addSub = _buildTreeMenu(nodes, n => n.has_prompts, n => _ctxAddToEntry(n, text), null);
    items.push({ label: 'Add to entry…', submenu: addSub.length ? addSub : [{ label: '(no entries)', action: () => {} }] });
    items.push({ label: 'Create new entry…', submenu: _buildTreeMenu(nodes, () => true, n => _ctxCreateEntry(n ? n.id : null, text), '(root)') });
  }
  if (refInner != null) {
    if (items.length) items.push({ separator: true });
    items.push({ label: 'Open in entry detail', action: () => _ctxOpenInDetail(refInner) });
  }
  window.plv2.showContextMenu(e.clientX, e.clientY, items);
}
async function _ctxAddToEntry(node, text) {
  try {
    const prs = (await window.plv2.api.getPrompts(node.id))?.prompts ?? [];
    if (prs.some(p => (p.content || '').trim() === text.trim())) {
      _toast(`Already in "${node.full_path}".`, 'info');
    } else {
      const r = await window.plv2.api.createPrompt(node.id, { content: text, enabled: true, weight: 1.0, order_index: prs.length });
      if (r?.error) { _toast(r.error.message || 'Failed to add to entry.'); return; }
      _toast(`Added to "${node.full_path}".`, 'success');
    }
    document.dispatchEvent(new CustomEvent('plv2:entry-changed', { detail: { nodeId: node.id } }));
  } catch (err) { console.error('[PLv2]', err); _toast('Failed to add to entry.'); }
}
async function _ctxCreateEntry(parentId, text) {
  const name = await window.plv2.inlinePrompt('New entry — name:');
  if (!name) return;
  const body = { name, has_prompts: true };
  if (parentId != null) body.parent_id = parentId;
  if (name.endsWith('_neg')) body.pos_neg = 'negative';
  try {
    const res = await window.plv2.api.createNode(body);
    if (res?.error) { _toast(res.error.message || 'Create failed.'); return; }
    const node = res?.node;
    if (node && text) await window.plv2.api.createPrompt(node.id, { content: text, enabled: true, weight: 1.0, order_index: 0 });
    _toast(`Created "${node?.full_path ?? name}".`, 'success');
    window.plv2Tree?.reload?.();
  } catch (err) { console.error('[PLv2]', err); _toast('Failed to create entry.'); }
}
async function _ctxOpenInDetail(refInner) {
  let node = null;
  try { node = (await window.plv2.api.resolveRef(refInner))?.node; } catch {}
  if (!node) { _toast('No entry matches this reference.'); return; }
  window.plv2.windows.library.show();
  requestAnimationFrame(() => document.dispatchEvent(new CustomEvent('plv2:open-entry', { detail: { node } })));
}

// ─── Misc helpers ─────────────────────────────────────────────────────────────

function _flatBtn(label) {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = 'background:#313244;border:1px solid #45475a;border-radius:4px;color:#cdd6f4;font-size:11px;padding:3px 8px;cursor:pointer;flex-shrink:0;';
  b.addEventListener('mouseenter', () => b.style.background = '#45475a');
  b.addEventListener('mouseleave', () => b.style.background = '#313244');
  return b;
}
function _span(text, css) { const s = document.createElement('span'); s.textContent = text; if (css) s.style.cssText = css; return s; }

let _changeTimer = null;
function _emitChanged(immediate = false) {
  clearTimeout(_changeTimer);
  if (immediate) { document.dispatchEvent(new CustomEvent('plv2:editor-changed', { detail: { immediate: true } })); return; }
  _changeTimer = setTimeout(() => document.dispatchEvent(new CustomEvent('plv2:editor-changed')), 120);
}

// ─── Public surface ───────────────────────────────────────────────────────────

function getEditorText() { return _panes.map(p => p.textarea.value).join('\n'); }

/** Data for the preview window (#10): orientation, active polarity, and the pos
 *  and neg templates (from panes if shown, else the saved nodes' widgets). */
function getPreviewData() {
  const out = { orientation: _orientation, activeTab: _active?.tab ?? 'pos', pos: null, neg: null };
  for (const p of _panes) { if (p.tab === 'pos') out.pos = p.textarea.value; else out.neg = p.textarea.value; }
  const w = n => n?.widgets?.find(x => x.name === 'prompt_template')?.value ?? null;
  if (out.pos == null) out.pos = w(_savedNodes.pos);
  if (out.neg == null) out.neg = w(_savedNodes.neg);
  return out;
}

function _refresh() {
  const col = window.plv2?.panel?.editorCol;
  if (!col) return;
  _build(col);
  // Re-resolve / re-sync on every show (graph may have changed).
  for (const p of _panes) { p.resolveNode(); p.populate(); p.syncFromNode(); }
  if (_orientation === 'single') _applySingleTabStyle();
  _setActive(_active && _panes.includes(_active) ? _active : _panes[0]);
  _startPoll();
}

// ─── Register ─────────────────────────────────────────────────────────────────

app.registerExtension({
  name: 'XYZNodes.PromptLibraryV2.Editor',

  async setup() {
    const wait = () => new Promise(r => setTimeout(r, 50));
    for (let i = 0; i < 20 && !window.plv2; i++) await wait();
    if (!window.plv2) { console.warn('[PLv2 Editor] window.plv2 not found'); return; }

    window.plv2.windows.editor.onShow(_refresh);
    window.plv2.windows.editor.onHide(_stopPoll);
    window.plv2.panel.onTabChange(() => { /* handled per-pane now */ });

    document.addEventListener('plv2:insert', e => {
      const d = e.detail || {};
      if (d.posNeg) insertRef(d.posNeg, d.text ?? '', d.delimiter);
      else          insertText(d.text ?? '');
    });

    // Node's multiline textbox edited on canvas → mirror into the matching pane (#9).
    document.addEventListener('plv2:node-edited', e => {
      const { nodeId, value } = e.detail || {};
      let touched = false;
      for (const p of _panes) {
        if (p.node && p.node.id === nodeId && p.textarea.value !== value) {
          p.textarea.value = value ?? '';
          p.updateBackdrop();
          p.ckptRecord();
          touched = true;
        }
      }
      if (touched) _emitChanged();
    });

    window.plv2Editor = { getEditorText, insertText, insertRef, getPreviewData };
  },
});
