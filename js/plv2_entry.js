/**
 * Prompt Library V2 — entry detail panel
 *
 * Renders into window.plv2.panel.detail when a tree entry is selected.
 * Bidirectional sync: prompt text view ↔ prompt list (via delimiter parsing).
 */

import { app } from '../../../scripts/app.js';

// ─── State ────────────────────────────────────────────────────────────────────

let _history     = [];   // navigation stack (prev lib nodes)
let _node        = null; // current library node
let _prompts     = [];   // [{id, content, weight, enabled, order_index}]
let _triggers    = [];   // [{id, trigger_text, is_auto}]
let _children    = [];   // direct child entries (own)
let _tplChildren = [];   // inherited from parent folder's _template entry
let _formats     = [];
let _delimiters  = [];

let _activePanel = 'prompts';   // 'prompts' | 'subentries'
let _layout      = 'vertical';  // 'vertical' | 'compact'
let _activeFirst = true;
let _negAutoInsert = true;       // also insert the _neg sub-entry when inserting this entry
let _syncLock    = false;

// DOM refs
let _detail         = null;
let _nameInput      = null;
let _backBtn        = null;
let _triggerWrap    = null;
let _delimSel       = null;
let _promptTextarea = null;
let _modeButtons    = {};
let _selectWrap     = null;
let _dropoutWrap    = null;
let _tabPrompts     = null;
let _tabSub         = null;
let _promptsPanel   = null;
let _subPanel       = null;
let _listBody       = null;

const _api = () => window.plv2.api;

// ─── Public API ───────────────────────────────────────────────────────────────

async function showEntry(node, pushHistory = true) {
  if (!node || !node.has_prompts) return;
  _detail = window.plv2.panel.detail;
  if (pushHistory && _node && _node.id !== node.id) _history.push(_node);
  _node = node;
  await _loadData();
  _render();
}

function closeDetail() {
  if (_detail) _detail.innerHTML = '';
  _node = null;
  _history = [];
}

// ─── Data ─────────────────────────────────────────────────────────────────────

async function _loadData() {
  _negAutoInsert = true;        // default the _neg auto-insert toggle on per entry
  const nid = _node.id;
  const [pr, tr, nr] = await Promise.all([
    _api().getPrompts(nid),
    _api().getTriggers(nid),
    _api().getNodes(),
  ]);
  _prompts  = pr?.prompts  ?? [];
  _triggers = tr?.triggers ?? [];
  const all = nr?.nodes ?? [];
  _children = all.filter(n => n.parent_id === nid && n.has_prompts);

  // Template inheritance: find parent folder's _template entry
  _tplChildren = [];
  if (_node.parent_id) {
    const tpl = all.find(n =>
      n.parent_id === _node.parent_id &&
      n.name === '_template' &&
      n.has_prompts
    );
    if (tpl && tpl.id !== nid) {
      _tplChildren = all.filter(n => n.parent_id === tpl.id && n.has_prompts);
    }
  }

  if (!_formats.length)    { const r = await _api().getFormats();    _formats    = r?.formats    ?? []; }
  if (!_delimiters.length) { const r = await _api().getDelimiters(); _delimiters = r?.delimiters ?? []; }
}

// ─── Sync helpers ─────────────────────────────────────────────────────────────

function _delim() { return _node?.delimiter ?? ', '; }

function _parsePromptPart(raw) {
  const m = raw.match(/^\(\s*(.+?)\s*:([\d.]+)\s*\)$/);
  if (m) return { content: m[1], weight: parseFloat(m[2]) || 1.0 };
  return { content: raw.trim(), weight: 1.0 };
}

function _buildText() {
  return [..._prompts]
    .filter(p => p.enabled)
    .sort((a, b) => (a.order_index ?? 0) - (b.order_index ?? 0))
    .map(p => {
      const w = p.weight ?? 1.0;
      return Math.abs(w - 1.0) < 0.001 ? p.content : `(${p.content}:${parseFloat(w.toFixed(2))})`;
    })
    .join(_delim());
}

async function _syncTextToList() {
  if (_syncLock || !_promptTextarea || !_node) return;
  const raw   = _promptTextarea.value.split(_delim()).map(s => s.trim()).filter(Boolean);

  // Normalise (skip refs/patterns) + drop duplicates (#6), keeping first occurrence.
  const seen = new Set();
  const parts = [];
  let changed = false;
  for (const part of raw.map(_parsePromptPart)) {
    const norm = window.plv2.cleanPrompt(part.content);
    if (norm !== part.content) changed = true;
    part.content = norm;
    if (!part.content) { changed = true; continue; }
    if (seen.has(part.content)) { changed = true; continue; }
    seen.add(part.content);
    parts.push(part);
  }

  const byContent = new Map(_prompts.map(p => [p.content.trim(), p]));
  const inText    = new Set(parts.map(p => p.content));

  // Create new prompts
  let nextOrder = Math.max(-1, ..._prompts.map(p => p.order_index ?? -1)) + 1;
  for (const { content, weight } of parts.filter(({ content }) => !byContent.has(content))) {
    try {
      const r = await _api().createPrompt(_node.id, { content, enabled: true, weight, order_index: nextOrder++ });
      const created = r?.prompt ?? { id: Date.now() + Math.random(), content, enabled: true, order_index: nextOrder - 1, weight };
      _prompts.push(created);
      byContent.set(content, created);
    } catch(e) { console.error('[PLv2]', e); }
  }

  // Update enabled + order + weight
  const ops = [];
  let idx = 0;
  for (const { content, weight } of parts) {
    const p = byContent.get(content);
    if (!p) continue;
    const upd = {};
    if (!p.enabled)              { upd.enabled = true;  p.enabled = true; }
    if (p.order_index !== idx)   { upd.order_index = idx; p.order_index = idx; }
    if (Math.abs((p.weight ?? 1) - weight) > 0.001) { upd.weight = weight; p.weight = weight; }
    if (Object.keys(upd).length) ops.push({ id: p.id, ...upd });
    idx++;
  }
  for (const p of _prompts) {
    if (p.enabled && !inText.has(p.content.trim())) {
      ops.push({ id: p.id, enabled: false });
      p.enabled = false;
    }
  }
  await Promise.all(ops.map(o => _api().updatePrompt(o.id, o)));

  _syncLock = true;
  _renderListBody();
  if (changed) _syncListToText();   // rewrite the textarea without dupes / with normalised text
  _syncLock = false;
}

function _syncListToText() {
  if (_syncLock || !_promptTextarea) return;
  _syncLock = true;
  _promptTextarea.value = _buildText();
  _syncLock = false;
}

// ─── Delimiter change ─────────────────────────────────────────────────────────

async function _onDelimChange() {
  const newDelim = _delimSel.value;
  if (newDelim === _node.delimiter) return;
  await _api().updateNode(_node.id, { delimiter: newDelim });
  _node.delimiter = newDelim;
  // Re-join the existing prompt list with the new delimiter. (Do NOT re-parse the
  // current text — it was joined with the *old* delimiter, so splitting by the new
  // one would corrupt the list.)
  _syncListToText();
}

// ─── Render ───────────────────────────────────────────────────────────────────

function _render() {
  if (!_detail) return;
  _detail.innerHTML = '';
  _detail.style.cssText = 'flex:1;min-width:280px;display:flex;flex-direction:column;background:#181825;overflow:hidden;font-size:12px;color:#cdd6f4;font-family:ui-sans-serif,system-ui,sans-serif;';

  // ── Row 1: header ──
  const hdr = _row('6px 12px');
  _backBtn = _iconBtn('←', 'Go back', _goBack);
  if (!_history.length) { _backBtn.disabled = true; _backBtn.style.opacity = '0.35'; }
  // Header title shows the entry's full path (#1).
  const titleEl = _span(_node.full_path || _node.name,
    'flex:1;font-weight:600;font-size:13px;color:#cba6f7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');
  titleEl.title = _node.full_path || _node.name;
  const closeBtn = _iconBtn('×', 'Close', closeDetail, { fontSize: '17px' });
  hdr.append(_backBtn, titleEl, closeBtn);

  // ── Row 2: name + pos/neg + insert ──
  const nameRow = _row('4px 12px');
  nameRow.style.gap = '6px';
  nameRow.style.flexWrap = 'wrap';

  _nameInput = document.createElement('input');
  _nameInput.value = _node.name;
  _nameInput.style.cssText = 'flex:1;min-width:80px;background:#313244;border:1px solid #45475a;border-radius:4px;color:#cdd6f4;font-size:12px;padding:3px 7px;';
  _nameInput.addEventListener('change', _saveName);

  const isPos = (_node.pos_neg ?? 'positive') === 'positive';
  const badge = document.createElement('button');
  badge.textContent = isPos ? 'positive' : 'negative';
  Object.assign(badge.style, {
    padding: '2px 10px', border: '1px solid', borderRadius: '10px', cursor: 'pointer',
    fontSize: '11px', fontWeight: '600', background: 'none',
    color: isPos ? '#a6e3a1' : '#f38ba8',
    borderColor: isPos ? '#a6e3a1' : '#f38ba8',
  });
  badge.addEventListener('click', async () => {
    const newPn = _node.pos_neg === 'positive' ? 'negative' : 'positive';
    await _api().updateNode(_node.id, { pos_neg: newPn });
    _node.pos_neg = newPn;
    badge.textContent = newPn;
    badge.style.color = newPn === 'positive' ? '#a6e3a1' : '#f38ba8';
    badge.style.borderColor = badge.style.color;
  });

  nameRow.append(_nameInput, badge);

  // ── Row 3: insert-into-editor buttons (emphasised — #2) ──
  const insertRow = _row('6px 12px');
  insertRow.style.flexWrap = 'wrap';
  insertRow.style.gap = '6px';
  insertRow.style.alignItems = 'flex-start';
  insertRow.style.background = '#1a1426';
  insertRow.style.borderTop = '1px solid #313244';
  insertRow.style.borderBottom = '1px solid #313244';
  insertRow.appendChild(_span('trigger name:', 'font-size:11px;color:#6c7086;flex-shrink:0;align-self:center;'));
  _triggerWrap = document.createElement('div');
  _triggerWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;flex:1;align-items:center;';
  _renderInsertRow();
  insertRow.appendChild(_triggerWrap);

  // ── Row 4: delimiter / format / shuffle ──
  const cfgRow = _row('4px 12px');
  cfgRow.style.gap = '10px';
  cfgRow.style.flexWrap = 'wrap';
  cfgRow.style.borderTop = '1px solid #313244';

  const delimGrp = _labelGrp('Delimiter');
  _delimSel = document.createElement('select');
  _styleSelect(_delimSel);
  const builtinDelims = [{ delimiter: ', ' }, { delimiter: ' | ' }, { delimiter: '\n' }];
  const delimOpts = (_delimiters.length ? _delimiters : builtinDelims)
    .map(d => {
      const v = typeof d === 'string' ? d : d.delimiter;
      return { value: v, label: JSON.stringify(v) };
    });
  for (const { value, label } of delimOpts) {
    const o = document.createElement('option');
    o.value = value; o.textContent = label;
    if (value === (_node.delimiter ?? ', ')) o.selected = true;
    _delimSel.appendChild(o);
  }
  _delimSel.addEventListener('change', _onDelimChange);
  delimGrp.appendChild(_delimSel);

  const fmtGrp = _labelGrp('Format');
  const fmtIn = document.createElement('input');
  fmtIn.type = 'text';
  fmtIn.value = _node.format ?? '';
  fmtIn.placeholder = 'e.g. art by {prompt}';
  fmtIn.setAttribute('list', 'plv2-fmt-datalist');
  Object.assign(fmtIn.style, {
    background: '#313244', border: '1px solid #45475a', borderRadius: '3px',
    color: '#cdd6f4', fontSize: '11px', padding: '2px 6px', width: '140px', cursor: 'text',
  });
  const fmtList = document.createElement('datalist');
  fmtList.id = 'plv2-fmt-datalist';
  for (const f of _formats) {
    const v = typeof f === 'string' ? f : f.format;
    if (v) { const o = document.createElement('option'); o.value = v; fmtList.appendChild(o); }
  }
  fmtIn.addEventListener('change', () => {
    _api().updateNode(_node.id, { format: fmtIn.value }).then(() => { _node.format = fmtIn.value; });
  });
  fmtGrp.append(fmtList, fmtIn);

  const shuffleGrp = _labelGrp('Shuffle');
  const shuffleChk = document.createElement('input');
  shuffleChk.type = 'checkbox'; shuffleChk.checked = !!_node.shuffle;
  shuffleChk.style.cssText = 'cursor:pointer;accent-color:#cba6f7;margin:0;';
  shuffleChk.addEventListener('change', () => _api().updateNode(_node.id, { shuffle: shuffleChk.checked }).then(() => { _node.shuffle = shuffleChk.checked; }));
  shuffleGrp.appendChild(shuffleChk);
  cfgRow.append(delimGrp, fmtGrp, shuffleGrp);

  // ── Row 5: random mode ──
  const modeRow = _row('4px 12px');
  modeRow.style.gap = '8px';
  modeRow.style.flexWrap = 'wrap';
  modeRow.appendChild(_span('Mode:', 'color:#6c7086;'));

  const modeSeg = document.createElement('div');
  modeSeg.style.cssText = 'display:flex;gap:1px;background:#313244;border-radius:4px;padding:1px;';
  _modeButtons = {};
  for (const m of ['off', 'select', 'dropout']) {
    const mb = document.createElement('button');
    mb.textContent = m[0].toUpperCase() + m.slice(1);
    Object.assign(mb.style, { padding: '2px 10px', border: 'none', borderRadius: '3px', fontSize: '11px', cursor: 'pointer', background: 'none', color: '#a6adc8' });
    mb.addEventListener('click', () => _setMode(m));
    _modeButtons[m] = mb;
    modeSeg.appendChild(mb);
  }
  modeRow.appendChild(modeSeg);

  _selectWrap = document.createElement('div');
  _selectWrap.style.cssText = 'display:none;align-items:center;gap:4px;';
  _selectWrap.appendChild(_span('Count:', 'color:#6c7086;'));
  const selMin = _numIn(_node.select_min ?? 1, 0, 999, 40);
  const selMax = _numIn(_node.select_max ?? 3, 0, 999, 40);
  selMin.addEventListener('change', () => _api().updateNode(_node.id, { select_min: +selMin.value }).then(() => { _node.select_min = +selMin.value; }));
  selMax.addEventListener('change', () => _api().updateNode(_node.id, { select_max: +selMax.value }).then(() => { _node.select_max = +selMax.value; }));
  _selectWrap.append(selMin, _span('–', 'color:#6c7086;'), selMax);
  modeRow.appendChild(_selectWrap);

  _dropoutWrap = document.createElement('div');
  _dropoutWrap.style.cssText = 'display:none;align-items:center;gap:4px;';
  _dropoutWrap.appendChild(_span('Rate:', 'color:#6c7086;'));
  const drIn = _numIn(Math.round((_node.dropout_rate ?? 0.5) * 100), 0, 100, 50);
  drIn.addEventListener('change', () => {
    const rate = Math.min(1, Math.max(0, +drIn.value / 100));
    _api().updateNode(_node.id, { dropout_rate: rate }).then(() => { _node.dropout_rate = rate; });
  });
  _dropoutWrap.append(drIn, _span('%', 'color:#6c7086;'));
  modeRow.appendChild(_dropoutWrap);
  _applyMode(_node.random_mode ?? 'off');

  // ── Prompt textarea ──
  const textSection = document.createElement('div');
  textSection.style.cssText = 'padding:6px 12px;display:flex;flex-direction:column;height:150px;flex-shrink:0;border-top:1px solid #313244;';
  _promptTextarea = document.createElement('textarea');
  _promptTextarea.value = _buildText();
  Object.assign(_promptTextarea.style, {
    flex: '1', background: '#313244', border: '1px solid #45475a', borderRadius: '4px',
    color: '#cdd6f4', fontSize: '12px', lineHeight: '1.5', padding: '6px 8px',
    resize: 'none', boxSizing: 'border-box', overflowY: 'auto',
    fontFamily: '"Fira Code","Cascadia Code",Consolas,monospace',
    scrollbarWidth: 'thin', scrollbarColor: '#45475a transparent',
  });
  _promptTextarea.setAttribute('spellcheck', 'false');
  _promptTextarea.placeholder = 'Active prompts joined by delimiter…';
  _promptTextarea.addEventListener('blur', _syncTextToList);
  textSection.appendChild(_promptTextarea);

  // ── Tab toggle ──
  const tabBar = document.createElement('div');
  tabBar.style.cssText = 'display:flex;flex-shrink:0;border-top:1px solid #313244;border-bottom:1px solid #313244;background:#1e1e2e;';
  _tabPrompts = _tabBtn('Prompts',     () => _switchPanel('prompts'));
  _tabSub     = _tabBtn('Sub Entries', () => _switchPanel('subentries'));
  tabBar.append(_tabPrompts, _tabSub);
  _applyTabStyle();

  // ── Panel area ──
  const panelArea = document.createElement('div');
  panelArea.style.cssText = 'flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0;';
  _promptsPanel = _buildPromptsPanel();
  _subPanel     = _buildSubPanel();
  panelArea.append(_promptsPanel, _subPanel);
  _switchPanel(_activePanel, false);

  _detail.append(hdr, nameRow, insertRow, cfgRow, modeRow, textSection, tabBar, panelArea);
}

// ─── Insert row (plain / triggers) ──────────────────────────────────────────

function _posNeg() { return _node?.pos_neg ?? 'positive'; }

/**
 * Insert a reference using `triggerText`. If a _neg sub-entry exists and its
 * auto-insert toggle is on, also insert the _neg using the SAME alias (#3) — e.g.
 * inserting [tk] also inserts [tk._neg], so the negative ref tracks the alias.
 */
function _insertTriggerRef(triggerText) {
  _emitInsert(`[${triggerText}]`, _posNeg(), _delim());
  const negChild = _children.find(c => c.name.endsWith('_neg'));
  if (negChild && _negAutoInsert) {
    _emitInsert(`[${triggerText}.${negChild.name}]`, 'negative', negChild.delimiter ?? _delim());
  }
}

/** A larger, emphasised "insert into the text editor" button (#2). */
function _insBtn(label, title, onClick, { bg = '#3a1d6e', color = '#e0d4ff', border = '#7c3aed' } = {}) {
  const b = document.createElement('button');
  b.style.cssText = `display:inline-flex;align-items:center;max-width:260px;padding:5px 12px;border-radius:7px;font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:${bg};color:${color};border:1px solid ${border};box-shadow:0 1px 3px rgba(0,0,0,.35);`;
  b.textContent = label;
  b.title = title;
  b.addEventListener('mouseenter', () => { b.style.filter = 'brightness(1.2)'; });
  b.addEventListener('mouseleave', () => { b.style.filter = ''; });
  b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
  return b;
}

/** A custom-trigger pill: click to insert into the editor, × to delete. */
function _customTriggerPill(t) {
  const pill = document.createElement('div');
  pill.style.cssText = 'display:inline-flex;align-items:center;gap:5px;max-width:260px;padding:5px 8px 5px 12px;border-radius:7px;font-size:12px;font-weight:600;background:#3a1d6e;color:#e0d4ff;border:1px solid #7c3aed;box-shadow:0 1px 3px rgba(0,0,0,.35);';

  const lbl = _span(t.trigger_text, 'cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');
  lbl.title = `Insert [${t.trigger_text}] into the text editor`;
  lbl.addEventListener('click', () => _insertTriggerRef(t.trigger_text));

  const del = _span('×', 'cursor:pointer;color:#f38ba8;font-size:13px;line-height:1;flex-shrink:0;');
  del.title = 'Delete trigger';
  del.addEventListener('click', async e => {
    e.stopPropagation();
    await _api().deleteTrigger(t.id);
    _triggers = _triggers.filter(x => x.id !== t.id);
    _renderInsertRow();
  });

  pill.append(lbl, del);
  return pill;
}

function _renderInsertRow() {
  if (!_triggerWrap) return;
  _triggerWrap.innerHTML = '';

  // 1) Plain — insert this entry's prompt text verbatim (no [ref], non-recursive).
  _triggerWrap.appendChild(_insBtn(
    'plain', "Insert this entry's prompt text (not a reference)",
    () => _emitInsert(_buildText(), _posNeg(), _delim()),
    { bg: 'none', color: '#a6adc8', border: '#45475a' },
  ));

  // 2) Default trigger — the auto trigger (falls back to full_path). When a _neg
  //    sub-entry exists and its auto-insert toggle is on, also insert it into the
  //    negative node (the toggle lives in the Sub Entries list — #2c/#2d).
  const auto = _triggers.find(t => t.is_auto);
  const defText = auto?.trigger_text ?? _node.full_path;
  const negChild = _children.find(c => c.name.endsWith('_neg'));
  _triggerWrap.appendChild(_insBtn(
    defText, `Insert [${defText}]` + (negChild ? ' (+ _neg if enabled)' : ''),
    () => _insertTriggerRef(defText),
  ));

  // 3) Custom triggers (click=insert, ×=delete).
  for (const t of _triggers.filter(t => !t.is_auto)) {
    _triggerWrap.appendChild(_customTriggerPill(t));
  }

  // 4) Add a new custom trigger.
  _triggerWrap.appendChild(_addAliasBtn());
}

function _addAliasBtn() {
  const addAlias = document.createElement('button');
  addAlias.textContent = '+ alias';
  addAlias.style.cssText = 'background:none;border:1px dashed #45475a;border-radius:10px;color:#6c7086;font-size:11px;padding:2px 8px;cursor:pointer;flex-shrink:0;';
  addAlias.addEventListener('mouseenter', () => { addAlias.style.borderColor = '#cba6f7'; addAlias.style.color = '#cba6f7'; });
  addAlias.addEventListener('mouseleave', () => { addAlias.style.borderColor = '#45475a'; addAlias.style.color = '#6c7086'; });
  addAlias.addEventListener('click', () => {
    addAlias.style.display = 'none';
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = 'alias…';
    inp.style.cssText = 'background:#313244;border:1px solid #7c3aed;border-radius:10px;color:#cdd6f4;font-size:11px;padding:2px 8px;width:100px;outline:none;';
    // `closed` guards against the keydown→blur double-fire that removed `inp`
    // twice (NotFoundError). close() and confirm() are both idempotent.
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      if (inp.parentNode) inp.remove();
      addAlias.style.display = '';
    };
    const confirm = async () => {
      if (closed) return;
      const v = inp.value.trim();
      close();
      if (!v) return;
      try {
        const r = await _api().createTrigger(_node.id, { trigger_text: v });
        if (r?.error) {                                   // conflict / invalid → tell the user, don't add (#1/#2)
          try { app.extensionManager.toast.add({ severity: 'warn', summary: 'Trigger name', detail: r.error.message || 'Could not add trigger', life: 4000 }); }
          catch { console.warn('[PLv2]', r.error); }
          return;
        }
        _triggers = r?.triggers ?? _triggers;
        _renderInsertRow();
      } catch(e) { console.error('[PLv2]', e); }
    };
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); confirm(); }
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    inp.addEventListener('blur', () => { confirm(); });
    _triggerWrap.insertBefore(inp, addAlias);
    requestAnimationFrame(() => inp.focus());
  });
  return addAlias;
}

// ─── Mode ─────────────────────────────────────────────────────────────────────

function _setMode(mode) {
  _api().updateNode(_node.id, { random_mode: mode }).then(() => { _node.random_mode = mode; _applyMode(mode); });
}

function _applyMode(mode) {
  for (const [m, btn] of Object.entries(_modeButtons)) {
    btn.style.background = m === mode ? '#7c3aed' : 'none';
    btn.style.color      = m === mode ? '#fff'    : '#a6adc8';
  }
  if (_selectWrap)  _selectWrap.style.display  = mode === 'select'  ? 'flex' : 'none';
  if (_dropoutWrap) _dropoutWrap.style.display = mode === 'dropout' ? 'flex' : 'none';
}

// ─── Prompt list panel ────────────────────────────────────────────────────────

function _buildPromptsPanel() {
  const panel = document.createElement('div');
  panel.style.cssText = 'flex:1;display:flex;flex-direction:column;overflow:hidden;';

  // Toolbar
  const toolbar = _row('4px 12px');
  toolbar.style.cssText += 'gap:6px;flex-wrap:wrap;flex-shrink:0;border-bottom:1px solid #313244;';

  const layoutBtn = document.createElement('button');
  layoutBtn.textContent = _layout === 'vertical' ? '☰ Vertical' : '⊞ Compact';
  _styleToggleBtn(layoutBtn);
  layoutBtn.addEventListener('click', () => {
    _layout = _layout === 'vertical' ? 'compact' : 'vertical';
    layoutBtn.textContent = _layout === 'vertical' ? '☰ Vertical' : '⊞ Compact';
    _renderListBody();
  });

  const afBtn = document.createElement('button');
  afBtn.textContent = _activeFirst ? '⬆ Active first' : '⬆ By order';
  _styleToggleBtn(afBtn);
  afBtn.addEventListener('click', () => {
    _activeFirst = !_activeFirst;
    afBtn.textContent = _activeFirst ? '⬆ Active first' : '⬆ By order';
    _renderListBody();
  });
  toolbar.append(layoutBtn, afBtn);

  // Add row
  const addRow = _row('4px 12px');
  addRow.style.cssText += 'gap:6px;border-bottom:1px solid #313244;flex-shrink:0;';
  const addInput = document.createElement('input');
  addInput.placeholder = 'New prompt content…';
  addInput.style.cssText = 'flex:1;background:#313244;border:1px solid #45475a;border-radius:4px;color:#cdd6f4;font-size:12px;padding:3px 7px;';
  const addBtn = _miniBtn('Add', async () => {
    const content = window.plv2.cleanPrompt(addInput.value.trim());
    if (!content) return;
    // #6 — no duplicate prompts.
    const dup = _prompts.find(p => p.content.trim() === content);
    if (dup) {
      addInput.value = '';
      if (!dup.enabled) {                       // re-enable an existing disabled one instead
        dup.enabled = true;
        dup.order_index = Math.max(-1, ..._prompts.filter(p => p.enabled && p.id !== dup.id).map(p => p.order_index ?? -1)) + 1;
        await _api().updatePrompt(dup.id, { enabled: true, order_index: dup.order_index });
        _syncListToText(); _renderListBody();
      }
      return;
    }
    const maxIdx = Math.max(-1, ..._prompts.filter(p => p.enabled).map(p => p.order_index ?? -1)) + 1;
    try {
      const r = await _api().createPrompt(_node.id, { content, enabled: true, weight: 1.0, order_index: maxIdx });
      const created = r?.prompt ?? { id: Date.now(), content, enabled: true, order_index: maxIdx, weight: 1.0 };
      _prompts.push(created);
      addInput.value = '';
      _syncListToText();
      _renderListBody();
    } catch(e) { console.error('[PLv2]', e); }
  });
  addRow.append(addInput, addBtn);

  _listBody = document.createElement('div');
  _listBody.style.cssText = 'flex:1;overflow-y:auto;min-height:0;scrollbar-width:thin;scrollbar-color:#45475a transparent;';
  _renderListBody();

  panel.append(toolbar, addRow, _listBody);
  return panel;
}

function _renderListBody() {
  if (!_listBody) return;
  _listBody.innerHTML = '';
  const sorted = _sortedPrompts();
  if (!sorted.length) {
    _listBody.appendChild(_span('No prompts yet. Add one above.', 'display:block;padding:20px;color:#6c7086;text-align:center;font-size:12px;'));
    return;
  }
  if (_layout === 'vertical') {
    for (const p of sorted) _listBody.appendChild(_verticalRow(p));
  } else {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:5px;padding:8px 12px;';
    for (const p of sorted) wrap.appendChild(_compactChip(p));
    _listBody.appendChild(wrap);
  }
}

function _sortedPrompts() {
  const copy = [..._prompts];
  if (_activeFirst) {
    copy.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      if (a.enabled)  return (a.order_index ?? 999) - (b.order_index ?? 999);
      return a.content.localeCompare(b.content);  // inactive: alphabetical
    });
  } else {
    copy.sort((a, b) => (a.order_index ?? 999) - (b.order_index ?? 999));
  }
  return copy;
}

function _verticalRow(p) {
  const row = document.createElement('div');
  row.style.cssText = `display:flex;align-items:center;gap:4px;padding:3px 10px;opacity:${p.enabled ? '1' : '0.45'};`;

  const toggle = document.createElement('input');
  toggle.type = 'checkbox'; toggle.checked = p.enabled;
  toggle.style.cssText = 'cursor:pointer;accent-color:#cba6f7;flex-shrink:0;';
  toggle.addEventListener('change', async () => {
    p.enabled = toggle.checked;
    row.style.opacity = p.enabled ? '1' : '0.45';
    let newOrder = p.order_index;
    if (p.enabled) {
      newOrder = Math.max(-1, ..._prompts.filter(q => q.enabled && q.id !== p.id).map(q => q.order_index ?? -1)) + 1;
      p.order_index = newOrder;
    }
    await _api().updatePrompt(p.id, { enabled: p.enabled, order_index: newOrder });
    _syncListToText();
    _renderListBody();
  });

  const contentIn = document.createElement('input');
  contentIn.value = p.content;
  contentIn.style.cssText = 'flex:1;background:#1e1e2e;border:1px solid #313244;border-radius:3px;color:#cdd6f4;font-size:11px;padding:2px 5px;min-width:0;';
  contentIn.addEventListener('change', async () => {
    const v = window.plv2.cleanPrompt(contentIn.value.trim());
    if (!v || v === p.content) { contentIn.value = p.content; return; }
    // #6 — avoid creating a duplicate via editing.
    if (_prompts.some(q => q.id !== p.id && q.content.trim() === v)) { contentIn.value = p.content; return; }
    p.content = v;
    contentIn.value = v;
    await _api().updatePrompt(p.id, { content: v });
    _syncListToText();
  });

  const weightIn = document.createElement('input');
  weightIn.type = 'number'; weightIn.value = +(p.weight ?? 1).toFixed(2);
  weightIn.min = '0.1'; weightIn.max = '2'; weightIn.step = '0.05';
  weightIn.style.cssText = 'width:52px;background:#1e1e2e;border:1px solid #313244;border-radius:3px;color:#cdd6f4;font-size:11px;padding:2px 4px;flex-shrink:0;';
  weightIn.addEventListener('change', async () => {
    p.weight = parseFloat(weightIn.value) || 1;
    await _api().updatePrompt(p.id, { weight: p.weight });
  });

  const delBtn = _iconBtn('×', 'Delete prompt', async () => {
    await _api().deletePrompt(p.id);
    _prompts = _prompts.filter(q => q.id !== p.id);
    _syncListToText();
    _renderListBody();
  }, { color: '#f38ba8', fontSize: '14px' });

  row.append(toggle, contentIn, weightIn, delBtn);
  return row;
}

function _compactChip(p) {
  // Compact chips are quick enable/disable toggles only — edit/delete live in the
  // vertical layout. (Hover-revealed icons here caused the chip to resize/jitter.)
  const chip = document.createElement('div');
  chip.style.cssText = `display:inline-flex;align-items:center;padding:3px 9px;border-radius:12px;cursor:pointer;font-size:11px;user-select:none;background:${p.enabled ? '#2d1b5e' : '#252536'};color:${p.enabled ? '#cba6f7' : '#6c7086'};border:1px solid ${p.enabled ? '#7c3aed55' : '#313244'};`;
  chip.title = p.enabled ? 'Click to disable' : 'Click to enable';
  chip.appendChild(_span(p.content));

  chip.addEventListener('click', async () => {
    p.enabled = !p.enabled;
    let newOrder = p.order_index;
    if (p.enabled) {
      newOrder = Math.max(-1, ..._prompts.filter(q => q.enabled && q.id !== p.id).map(q => q.order_index ?? -1)) + 1;
      p.order_index = newOrder;
    }
    await _api().updatePrompt(p.id, { enabled: p.enabled, order_index: newOrder });
    _syncListToText(); _renderListBody();
  });
  return chip;
}

// ─── Sub entry panel ──────────────────────────────────────────────────────────

function _buildSubPanel() {
  const panel = document.createElement('div');
  panel.style.cssText = 'flex:1;overflow-y:auto;min-height:0;scrollbar-width:thin;scrollbar-color:#45475a transparent;';

  // Build map of own children by name for override detection
  const ownNames = new Set(_children.map(c => c.name));

  // Inherited entries (from _template) that are NOT overridden
  const inherited = _tplChildren.filter(t => !ownNames.has(t.name));

  if (!_children.length && !inherited.length) {
    panel.appendChild(_span('No sub entries.', 'display:block;padding:20px;color:#6c7086;text-align:center;font-size:12px;'));
    return panel;
  }

  // Own sub-entries (with override indicator if applicable)
  for (const child of _children) {
    const overrides = _tplChildren.some(t => t.name === child.name);
    panel.appendChild(_subEntryRow(child, overrides ? 'override' : 'own'));
  }

  // Inherited sub-entries
  for (const child of inherited) {
    panel.appendChild(_subEntryRow(child, 'inherited'));
  }

  return panel;
}

function _subEntryRow(child, kind = 'own') {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'border-bottom:1px solid #313244;';

  const hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;align-items:center;gap:6px;padding:6px 12px;cursor:pointer;';
  hdr.addEventListener('mouseenter', () => { hdr.style.background = '#1e1e2e'; });
  hdr.addEventListener('mouseleave', () => { hdr.style.background = 'none'; });

  const arrow = _span('▶', 'font-size:9px;color:#6c7086;flex-shrink:0;transition:transform 0.15s;');
  const nameEl = _span(child.name, 'flex:1;font-size:12px;');

  // Badge for inherited or override
  if (kind === 'inherited') {
    const badge = _span('↳ tpl', 'font-size:9px;color:#6c7086;background:#252538;border-radius:3px;padding:0 4px;flex-shrink:0;');
    nameEl.style.color = '#a6adc8';
    nameEl.style.fontStyle = 'italic';
    hdr.append(arrow, nameEl, badge);
  } else if (kind === 'override') {
    const badge = _span('✎ ovr', 'font-size:9px;color:#cba6f7;background:#2d1b5e;border-radius:3px;padding:0 4px;flex-shrink:0;');
    hdr.append(arrow, nameEl, badge);
  } else {
    hdr.append(arrow, nameEl);
  }

  const childRef = `[${child.full_path}]`;

  // (#2c) _neg sub-entry: toggle whether inserting the parent entry also inserts it.
  if (child.name.endsWith('_neg')) {
    const tgl = document.createElement('button');
    tgl.style.cssText = 'background:none;border:1px solid;border-radius:10px;font-size:10px;padding:1px 7px;cursor:pointer;flex-shrink:0;';
    tgl.title = 'When on, inserting the parent entry also inserts this _neg sub-entry into the negative node';
    const sync = () => {
      tgl.textContent = _negAutoInsert ? 'auto-neg: on' : 'auto-neg: off';
      tgl.style.color       = _negAutoInsert ? '#a6e3a1' : '#6c7086';
      tgl.style.borderColor = _negAutoInsert ? '#a6e3a1' : '#45475a';
    };
    sync();
    tgl.addEventListener('click', e => { e.stopPropagation(); _negAutoInsert = !_negAutoInsert; sync(); });
    hdr.append(tgl);
  }

  // ⤴ — add reference to THIS entry's prompt list (uses this entry's delimiter)
  hdr.append(_iconBtn('⤴', "Add reference to this entry's prompts",
    () => _addRefToPromptBox(childRef)));
  // ＋ — insert reference into the text editor (routed by the sub-entry's polarity)
  hdr.append(_iconBtn('＋', 'Insert reference into the text editor',
    () => _emitInsert(childRef, child.pos_neg ?? 'positive', child.delimiter)));
  // open the sub-entry's own detail page
  hdr.append(_iconBtn('→', `Open ${child.name}`, () => showEntry(child)));

  const body = document.createElement('div');
  body.style.cssText = 'display:none;padding:6px 12px 10px;font-size:11px;color:#a6adc8;white-space:pre-wrap;word-break:break-word;background:#181825;border-top:1px solid #313244;';

  let loaded = false;
  hdr.addEventListener('click', async e => {
    if (e.target.closest('button')) return;
    const open = body.style.display !== 'none';
    body.style.display = open ? 'none' : 'block';
    arrow.style.transform = open ? '' : 'rotate(90deg)';
    if (!open && !loaded) {
      loaded = true;
      body.textContent = 'Loading…';
      try {
        const r = await _api().previewNode(child.id, 0);
        body.textContent = r?.text || '(empty)';
      } catch { body.textContent = '(could not load preview)'; }
    }
  });

  wrap.append(hdr, body);
  return wrap;
}

// ─── Panel switch ─────────────────────────────────────────────────────────────

function _switchPanel(panel, updateTabs = true) {
  _activePanel = panel;
  if (_promptsPanel) _promptsPanel.style.display = panel === 'prompts'    ? 'flex'  : 'none';
  if (_subPanel)     _subPanel.style.display     = panel === 'subentries' ? 'block' : 'none';
  if (updateTabs) _applyTabStyle();
}

function _applyTabStyle() {
  for (const [btn, key] of [[_tabPrompts, 'prompts'], [_tabSub, 'subentries']]) {
    if (!btn) continue;
    const active = _activePanel === key;
    btn.style.color = active ? '#cba6f7' : '#6c7086';
    btn.style.borderBottomColor = active ? '#cba6f7' : 'transparent';
  }
}

// ─── Misc actions ─────────────────────────────────────────────────────────────

function _goBack() {
  if (!_history.length) return;
  showEntry(_history.pop(), false);
}

async function _saveName() {
  const newName = _nameInput?.value?.trim();
  if (!newName || newName === _node.name) return;
  try {
    const r = await _api().updateNode(_node.id, { name: newName });
    _node.name      = r?.node?.name      ?? newName;
    _node.full_path = r?.node?.full_path ?? _node.full_path;
  } catch(e) {
    console.error('[PLv2]', e);
    if (_nameInput) _nameInput.value = _node.name;
  }
}

function _emitInsert(text, posNeg, delimiter) {
  document.dispatchEvent(new CustomEvent('plv2:insert', { detail: { text, posNeg, delimiter } }));
}

/** Add `ref` to the current entry's prompt textarea at the caret (#2b). */
function _addRefToPromptBox(ref) {
  if (!_promptTextarea) return;
  const D = _delim();
  const pos = _promptTextarea.selectionStart ?? _promptTextarea.value.length;
  const plan = window.plv2.insert.plan(_promptTextarea.value, pos);
  const { value, caret } = window.plv2.insert.assemble(plan, ref, D, D);
  _promptTextarea.value = value;
  _promptTextarea.selectionStart = _promptTextarea.selectionEnd = caret;
  _promptTextarea.focus();
  _syncTextToList();
}

// ─── DOM helpers ──────────────────────────────────────────────────────────────

function _row(padding) {
  const div = document.createElement('div');
  div.style.cssText = `display:flex;align-items:center;padding:${padding};flex-shrink:0;`;
  return div;
}

function _span(text, css = '') {
  const s = document.createElement('span');
  s.textContent = text;
  if (css) s.style.cssText = css;
  return s;
}

function _iconBtn(label, title, onClick, extraStyle = {}) {
  const b = document.createElement('button');
  b.textContent = label; b.title = title;
  Object.assign(b.style, { background: 'none', border: 'none', color: '#a6adc8', cursor: 'pointer', fontSize: '13px', padding: '2px 5px', borderRadius: '4px', lineHeight: '1', flexShrink: '0', ...extraStyle });
  b.addEventListener('mouseenter', () => { if (!b.disabled) b.style.background = '#313244'; });
  b.addEventListener('mouseleave', () => { b.style.background = 'none'; });
  b.addEventListener('click', e => { e.stopPropagation(); if (!b.disabled) onClick(); });
  return b;
}

function _miniBtn(label, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  Object.assign(b.style, { background: '#7c3aed', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '11px', padding: '3px 8px', borderRadius: '4px', flexShrink: '0' });
  b.addEventListener('mouseenter', () => { b.style.background = '#6d28d9'; });
  b.addEventListener('mouseleave', () => { b.style.background = '#7c3aed'; });
  b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
  return b;
}

function _styleToggleBtn(btn) {
  Object.assign(btn.style, { background: 'none', border: '1px solid #45475a', color: '#a6adc8', cursor: 'pointer', fontSize: '11px', padding: '2px 8px', borderRadius: '4px' });
  btn.addEventListener('mouseenter', () => { btn.style.background = '#313244'; btn.style.color = '#cdd6f4'; });
  btn.addEventListener('mouseleave', () => { btn.style.background = 'none'; btn.style.color = '#a6adc8'; });
}

function _styleSelect(sel) {
  Object.assign(sel.style, { background: '#313244', border: '1px solid #45475a', borderRadius: '3px', color: '#cdd6f4', fontSize: '11px', padding: '2px 4px', cursor: 'pointer' });
}

function _labelGrp(label) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;align-items:center;gap:4px;';
  wrap.appendChild(_span(label + ':', 'color:#6c7086;font-size:11px;flex-shrink:0;'));
  return wrap;
}

function _numIn(val, min, max, width) {
  const inp = document.createElement('input');
  inp.type = 'number'; inp.value = val;
  inp.min = String(min); inp.max = String(max);
  inp.style.cssText = `width:${width}px;background:#313244;border:1px solid #45475a;border-radius:3px;color:#cdd6f4;font-size:11px;padding:2px 4px;`;
  return inp;
}

function _tabBtn(label, onClick) {
  const btn = document.createElement('button');
  btn.textContent = label;
  Object.assign(btn.style, { flex: '1', padding: '5px', border: 'none', borderBottom: '2px solid transparent', background: 'none', color: '#6c7086', cursor: 'pointer', fontSize: '12px' });
  btn.addEventListener('click', onClick);
  return btn;
}

// ─── Register ─────────────────────────────────────────────────────────────────

app.registerExtension({
  name: 'XYZNodes.PromptLibraryV2.Entry',

  async setup() {
    const wait = () => new Promise(r => setTimeout(r, 50));
    for (let i = 0; i < 40 && !window.plv2; i++) await wait();
    if (!window.plv2) { console.warn('[PLv2 Entry] window.plv2 not found'); return; }

    _detail = window.plv2.panel.detail;
    window.plv2.windows.library.onHide(closeDetail);

    const tryReg = () => {
      if (window.plv2Tree?.onSelectEntry) {
        window.plv2Tree.onSelectEntry(node => showEntry(node));
      } else {
        setTimeout(tryReg, 100);
      }
    };
    tryReg();

    // Open an entry's detail from elsewhere (e.g. editor right-click → "open in entry detail").
    document.addEventListener('plv2:open-entry', e => {
      const node = e.detail?.node;
      if (node && node.has_prompts) showEntry(node);
    });

    // An entry's prompts changed elsewhere (e.g. editor "add to entry") — refresh if open.
    document.addEventListener('plv2:entry-changed', async e => {
      if (_node && e.detail?.nodeId === _node.id) { await _loadData(); _render(); }
    });

    // Expose for programmatic opening.
    window.plv2Entry = { showEntry };
  },
});
