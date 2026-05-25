/**
 * Prompt Library V2 — folder tree (middle column)
 *
 * Builds #plv2-tree-col with:
 *   [◀ collapse] [Library] [+folder] [+entry] [↻]
 *   [filter: All | Pos | Neg | In Use]
 *   [sort: Name | Created] [↑↓]
 *   [scrollable tree — 📁 folders, 📝 entries, right-click menu]
 *
 * Right-click uses window.plv2.showContextMenu — no browser dialogs.
 * Fires window.plv2Tree.onSelectEntry(fn) / onSelectFolder(fn).
 *
 * Depends on window.plv2 (plv2.js).
 */

import { app } from '../../../scripts/app.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function el(tag, styles = {}, text = '') {
  const e = document.createElement(tag);
  Object.assign(e.style, styles);
  if (text) e.textContent = text;
  return e;
}
function css(e, s) { Object.assign(e.style, s); return e; }

function iconBtn(label, title, onClick, extra = {}) {
  const b = el('button', {
    background: 'none', border: 'none', color: '#a6adc8',
    cursor: 'pointer', fontSize: '13px', padding: '2px 5px',
    borderRadius: '3px', lineHeight: '1', flexShrink: '0',
    ...extra,
  }, label);
  b.title = title;
  b.addEventListener('mouseenter', () => { b.style.background = '#313244'; b.style.color = '#cdd6f4'; });
  b.addEventListener('mouseleave', () => { b.style.background = 'none'; b.style.color = extra.color ?? '#a6adc8'; });
  b.addEventListener('click', e => { e.stopPropagation(); onClick(); });
  return b;
}

function _panelCenter() {
  const r = window.plv2?.panel?.el?.getBoundingClientRect();
  return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

function _showInlinePrompt(title, defaultValue = '') {
  return new Promise(resolve => {
    const c = _panelCenter();
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'fixed', zIndex: '10002',
      left: (c.x - 140) + 'px', top: (c.y - 56) + 'px',
      background: '#252526', border: '1px solid #454545', borderRadius: '6px',
      padding: '12px 14px', boxShadow: '0 4px 20px rgba(0,0,0,.7)',
      display: 'flex', flexDirection: 'column', gap: '8px', minWidth: '280px',
      fontFamily: 'ui-sans-serif,system-ui,sans-serif',
    });
    const lbl = document.createElement('div');
    lbl.textContent = title;
    Object.assign(lbl.style, { fontSize: '12px', color: '#cdd6f4', fontWeight: '600' });
    const inp = document.createElement('input');
    inp.value = defaultValue;
    Object.assign(inp.style, {
      background: '#3c3c3c', border: '1px solid #454545', borderRadius: '3px',
      color: '#cccccc', fontSize: '12px', padding: '5px 8px', outline: 'none',
    });
    inp.addEventListener('focus', () => { inp.style.borderColor = '#7c3aed'; });
    inp.addEventListener('blur',  () => { inp.style.borderColor = '#454545'; });
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    Object.assign(cancel.style, { background: 'none', border: '1px solid #454545', color: '#a6adc8', fontSize: '11px', padding: '3px 10px', borderRadius: '3px', cursor: 'pointer' });
    const ok = document.createElement('button');
    ok.textContent = 'OK';
    Object.assign(ok.style, { background: '#7c3aed', border: 'none', color: '#fff', fontSize: '11px', padding: '3px 10px', borderRadius: '3px', cursor: 'pointer' });
    btns.append(cancel, ok);
    box.append(lbl, inp, btns);
    document.body.appendChild(box);
    const done = val => { box.remove(); resolve(val); };
    cancel.addEventListener('click', () => done(null));
    ok.addEventListener('click',     () => done(inp.value.trim() || null));
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); done(inp.value.trim() || null); }
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
    });
    requestAnimationFrame(() => { inp.focus(); inp.select(); });
  });
}

function _showInlineConfirm(message) {
  return new Promise(resolve => {
    const c = _panelCenter();
    const box = document.createElement('div');
    Object.assign(box.style, {
      position: 'fixed', zIndex: '10002',
      left: (c.x - 140) + 'px', top: (c.y - 48) + 'px',
      background: '#252526', border: '1px solid #454545', borderRadius: '6px',
      padding: '12px 14px', boxShadow: '0 4px 20px rgba(0,0,0,.7)',
      display: 'flex', flexDirection: 'column', gap: '10px', minWidth: '280px',
      fontFamily: 'ui-sans-serif,system-ui,sans-serif',
    });
    const msg = document.createElement('div');
    msg.textContent = message;
    msg.style.cssText = 'font-size:12px;color:#cdd6f4;line-height:1.5;';
    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;';
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    Object.assign(cancel.style, { background: 'none', border: '1px solid #454545', color: '#a6adc8', fontSize: '11px', padding: '3px 10px', borderRadius: '3px', cursor: 'pointer' });
    const ok = document.createElement('button');
    ok.textContent = 'Delete';
    Object.assign(ok.style, { background: '#c0392b', border: 'none', color: '#fff', fontSize: '11px', padding: '3px 10px', borderRadius: '3px', cursor: 'pointer' });
    btns.append(cancel, ok);
    box.append(msg, btns);
    document.body.appendChild(box);
    const done = val => { box.remove(); resolve(val); };
    cancel.addEventListener('click', () => done(false));
    ok.addEventListener('click',     () => done(true));
    box.addEventListener('keydown', e => { if (e.key === 'Escape') done(false); });
  });
}

// ─── State ────────────────────────────────────────────────────────────────────

let _nodes      = [];
let _expanded   = new Set();
let _polarity   = 'all';      // 'all' | 'pos' | 'neg'   (independent of in-use)
let _inUse      = false;      // in-use filter toggle (independent)
let _sortBy     = 'name';     // 'name' | 'created'
let _sortAsc    = true;

let _listEl        = null;
let _toolbarInner  = null;
let _filterBar     = null;
let _sortBar       = null;

const TREE_W      = () => window.plv2?.panel?.tree?.dataset?.width ?? '250';
const TREE_COLL_W = '28px';

const _selectEntryCbs  = [];
const _selectFolderCbs = [];

function onSelectEntry(fn)  { _selectEntryCbs.push(fn); }
function onSelectFolder(fn) { _selectFolderCbs.push(fn); }

function _fireSelectEntry(nodeOrId) {
  const node = typeof nodeOrId === 'object' ? nodeOrId : _nodes.find(n => n.id === nodeOrId) ?? null;
  window.plv2.state.selectedLibNodeId = node?.id ?? null;
  _selectEntryCbs.forEach(fn => { try { fn(node); } catch(e) { console.error('[PLv2 Tree]', e); } });
}
function _fireSelectFolder(nodeOrId) {
  const node = typeof nodeOrId === 'object' ? nodeOrId : _nodes.find(n => n.id === nodeOrId) ?? null;
  window.plv2.state.selectedLibNodeId = node?.id ?? null;
  _selectFolderCbs.forEach(fn => { try { fn(node); } catch(e) { console.error('[PLv2 Tree]', e); } });
}

// ─── Filter & sort helpers ────────────────────────────────────────────────────

function _inUseText() {
  // Both the positive and negative editor templates (whichever exist), so the
  // in-use set spans both polarities — independent of the pos/neg filter (#1).
  const d = window.plv2Editor?.getPreviewData?.();
  if (d) return (d.pos || '') + '\n' + (d.neg || '');
  return window.plv2Editor?.getEditorText?.() ?? '';
}

let _inUseSet = new Set();   // node ids referenced by the editors (resolved like the engine)

// Resolve every [ref] in the pos+neg templates to a node id, using the same
// trigger/full-path resolution the engine uses (so short auto-triggers like
// "rio" match too — they aren't equal to the node's full_path). Async.
async function _recomputeInUse() {
  const text = _inUseText();
  const refs = [...new Set([...text.matchAll(/\[([^\]\n]+)\]/g)].map(m => m[1].trim()).filter(Boolean))];
  const ids = new Set();
  await Promise.all(refs.map(async ref => {
    try { const node = (await window.plv2.api.resolveRef(ref))?.node; if (node) ids.add(node.id); }
    catch (e) { /* ignore unresolved refs */ }
  }));
  _inUseSet = ids;
}

/** Recompute the in-use set (if the filter is on) then re-render the tree. */
function _refreshInUse() {
  if (_inUse) _recomputeInUse().then(_rerender);
  else _rerender();
}

// ─── Tree builder ─────────────────────────────────────────────────────────────

function _buildTreeMap(nodes) {
  const map = new Map();
  for (const n of nodes) {
    const k = n.parent_id ?? null;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(n);
  }
  return map;
}

function _renderTree(container, treeMap, parentId, depth, filteredIds) {
  const children = treeMap.get(parentId) ?? [];
  // Apply sort to children
  const sorted = [...children].sort((a, b) => {
    const cmp = _sortBy === 'name' ? a.name.localeCompare(b.name) : (a.id - b.id);
    return _sortAsc ? cmp : -cmp;
  });

  for (const node of sorted) {
    // When a filter is active (filteredIds set): only show matching nodes or those with matching descendants.
    if (filteredIds && !filteredIds.has(node.id) && !_hasMatchingDescendant(node.id, treeMap, filteredIds)) continue;

    const isFolder = !node.has_prompts;
    const hasKids  = treeMap.has(node.id);
    const isExp    = _expanded.has(node.id);
    const isSel    = window.plv2.state.selectedLibNodeId === node.id;

    // Distinct backgrounds for folders vs entries (#3).
    const baseBg  = isFolder ? '#242438' : '#191926';
    const hoverBg = isFolder ? '#2e2e48' : '#23233a';

    const row = el('div', {
      display: 'flex', alignItems: 'center', gap: '5px',
      padding: `5px 6px 5px ${6 + depth * 10}px`,   // larger rows (#3), smaller indent (#2)
      cursor: 'pointer', borderRadius: '4px',
      borderLeft: `3px solid ${isFolder ? '#7c3aed' : '#45475a'}`,
      background: isSel ? '#313244' : baseBg,
      userSelect: 'none',
    });

    const toggle = el('span', {
      width: '15px', textAlign: 'center', color: '#6c7086',
      fontSize: '11px', flexShrink: '0',
      cursor: hasKids && !isFolder ? 'pointer' : 'default',   // entry triangle clickable; folder triangle is decorative
    }, hasKids ? (isExp ? '▼' : '▶') : '');

    const icon = el('span', { flexShrink: '0', fontSize: '15px' },
      isFolder ? '📁' : '📝');

    const nameEl = el('span', {
      flex: '1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      color: isSel ? '#cba6f7' : '#cdd6f4', fontSize: '13.5px',
    }, node.name);

    row.append(toggle, icon, nameEl);

    // Hover highlight
    row.addEventListener('mouseenter', () => { if (!isSel) row.style.background = hoverBg; });
    row.addEventListener('mouseleave', () => { if (!isSel) row.style.background = baseBg; });

    if (isFolder) {
      // Issue 5: Click folder row anywhere to expand/collapse
      row.addEventListener('click', () => {
        if (hasKids) {
          _expanded.has(node.id) ? _expanded.delete(node.id) : _expanded.add(node.id);
        }
        _rerender();
      });
    } else {
      // Issue 6: Entry triangle toggles sub-entry expand/collapse
      if (hasKids) {
        toggle.addEventListener('click', e => {
          e.stopPropagation();
          e.preventDefault();
          _expanded.has(node.id) ? _expanded.delete(node.id) : _expanded.add(node.id);
          _rerender();
        });
      }
      // Issue 6b: Click entry row
      row.addEventListener('click', () => {
        if (isSel && hasKids) {
          // Already selected: toggle expand/collapse
          _expanded.has(node.id) ? _expanded.delete(node.id) : _expanded.add(node.id);
        } else {
          // Not selected: select + expand sub-entries
          if (hasKids) _expanded.add(node.id);
          _fireSelectEntry(node);
        }
        _rerender();
      });
    }

    // Right click: context menu
    row.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      _showNodeMenu(e.clientX, e.clientY, node, isFolder);
    });

    container.appendChild(row);
    if (hasKids && isExp) _renderTree(container, treeMap, node.id, depth + 1, filteredIds);
  }
}

function _hasMatchingDescendant(nodeId, treeMap, filteredIds) {
  const kids = treeMap.get(nodeId) ?? [];
  for (const k of kids) {
    if (filteredIds.has(k.id) || _hasMatchingDescendant(k.id, treeMap, filteredIds)) return true;
  }
  return false;
}

// ─── Context menu ─────────────────────────────────────────────────────────────

function _showNodeMenu(x, y, node, isFolder) {
  const items = [];

  // Insert into text editor
  items.push({
    label: 'Insert [reference]',
    action: () => _insertIntoEditor(node),
  });

  items.push({ separator: true });

  items.push({
    label: 'Rename',
    action: () => _renameNode(node),
  });

  if (isFolder) {
    items.push({ label: 'Add sub-folder', action: () => _createNode(node.id, false) });
    items.push({ label: 'Add entry',      action: () => _createNode(node.id, true)  });
  } else {
    items.push({ label: 'Add sub-entry',  action: () => _createNode(node.id, true)  });
  }

  items.push({ separator: true });

  items.push({
    label: 'Delete',
    danger: true,
    action: () => _deleteNode(node),
  });

  window.plv2.showContextMenu(x, y, items);
}

function _insertIntoEditor(node) {
  // Insert [trigger_name] into the editor node matching this entry's polarity.
  const trigger = node.auto_trigger ?? node.name;
  const event = new CustomEvent('plv2:insert', {
    detail: { text: `[${trigger}]`, posNeg: node.pos_neg ?? 'positive', delimiter: node.delimiter },
  });
  document.dispatchEvent(event);
}

// ─── CRUD (using ComfyUI dialogs, no browser dialogs) ────────────────────────

async function _createNode(parentId, hasPrompts) {
  const name = await _showInlinePrompt(hasPrompts ? 'New Entry — name:' : 'New Folder — name:');
  if (!name?.trim()) return;

  const body = { name: name.trim(), has_prompts: hasPrompts };
  if (parentId != null) body.parent_id = parentId;
  // Entries named "*_neg" default to the negative polarity.
  if (hasPrompts && body.name.endsWith('_neg')) body.pos_neg = 'negative';

  const res = await window.plv2.api.createNode(body);
  if (res?.error) {
    try { app.extensionManager.toast.add({ severity: 'error', summary: 'PLv2', detail: res.error.message, life: 4000 }); } catch {}
    return;
  }
  if (parentId != null) _expanded.add(parentId);
  await _load();
  if (res?.node?.id) {
    if (hasPrompts) _fireSelectEntry(res.node);
    else            _fireSelectFolder(res.node);
  }
}

async function _renameNode(node) {
  const name = await _showInlinePrompt(`Rename "${node.name}":`, node.name);
  if (!name?.trim() || name.trim() === node.name) return;
  const res = await window.plv2.api.updateNode(node.id, { name: name.trim() });
  if (res?.error) {
    try { app.extensionManager.toast.add({ severity: 'error', summary: 'PLv2', detail: res.error.message, life: 4000 }); } catch {}
    return;
  }
  await _load();
}

async function _deleteNode(node) {
  const ok = await _showInlineConfirm(`Delete "${node.full_path}" and all its children?`);
  if (!ok) return;
  const res = await window.plv2.api.deleteNode(node.id);
  if (res?.error) {
    try { app.extensionManager.toast.add({ severity: 'error', summary: 'PLv2', detail: res.error.message, life: 4000 }); } catch {}
    return;
  }
  if (window.plv2.state.selectedLibNodeId === node.id) {
    window.plv2.state.selectedLibNodeId = null;
    _fireSelectEntry(null);
  }
  await _load();
}

// ─── Load + render ────────────────────────────────────────────────────────────

async function _load() {
  const res = await window.plv2.api.getNodes();
  _nodes = res?.nodes ?? [];
  // Auto-select first entry on initial load
  if (!_initialLoadDone) {
    _initialLoadDone = true;
    _initExpandEntries();
    _autoSelectEntry();
  }
  _refreshInUse();   // recomputes the in-use set (if active) then re-renders
}

let _initialLoadDone = false;

// Default: all entries with sub-entries start expanded (issue 6c).
function _initExpandEntries() {
  for (const n of _nodes) {
    if (n.has_prompts) {
      const hasSubs = _nodes.some(c => c.parent_id === n.id && c.has_prompts);
      if (hasSubs) _expanded.add(n.id);
    }
  }
}

// Auto-select: last opened entry, or fall back to first entry (issue 4).
function _autoSelectEntry() {
  if (window.plv2.state.selectedLibNodeId) return;   // already selected via other path
  let entry = null;
  try {
    const lastId = window.plv2Entry?.getLastEntryId?.();
    if (lastId) entry = _nodes.find(n => n.id === lastId && n.has_prompts);
  } catch {}
  if (!entry) {
    // Default: first entry by current sort order
    const sorted = [..._nodes].filter(n => n.has_prompts).sort((a, b) => {
      const cmp = _sortBy === 'name' ? a.name.localeCompare(b.name) : (a.id - b.id);
      return _sortAsc ? cmp : -cmp;
    });
    entry = sorted[0] || null;
  }
  if (entry) {
    window.plv2.state.selectedLibNodeId = entry.id;
    _fireSelectEntry(entry);
  }
}

function _rerender() {
  if (!_listEl) return;
  _listEl.innerHTML = '';

  const treeMap   = _buildTreeMap(_nodes);
  let filteredIds = null;

  if (_polarity !== 'all' || _inUse) {
    filteredIds = new Set();
    for (const n of _nodes) {
      const polOk = _polarity === 'all'
        || (_polarity === 'pos' && n.pos_neg === 'positive')
        || (_polarity === 'neg' && n.pos_neg === 'negative');
      const useOk = !_inUse || _inUseSet.has(n.id);
      if (polOk && useOk) filteredIds.add(n.id);
    }
  }

  _renderTree(_listEl, treeMap, null, 0, filteredIds);

  if (_nodes.length === 0) {
    _listEl.appendChild(el('div', {
      padding: '16px', color: '#6c7086', fontSize: '12px',
      textAlign: 'center', whiteSpace: 'pre',
    }, 'No entries yet.\nClick + to create one.'));
  }
}

// ─── DOM construction ─────────────────────────────────────────────────────────

let _builtDOM = false;

function _buildDOM(container) {
  if (_builtDOM) return;
  _builtDOM = true;

  Object.assign(container.style, {
    display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden',
  });

  // ── Toolbar ──────────────────────────────────────────────────────────────
  const toolbar = el('div', {
    display: 'flex', alignItems: 'center',
    borderBottom: '1px solid #313244', flexShrink: '0', overflow: 'hidden',
  });

  _toolbarInner = el('div', {
    display: 'flex', alignItems: 'center', gap: '1px',
    flex: '1', padding: '3px 4px', overflow: 'hidden',
  });

  _toolbarInner.appendChild(el('span', {
    flex: '1', fontWeight: '600', fontSize: '11px',
    color: '#a6adc8', textTransform: 'uppercase', letterSpacing: '0.05em',
    overflow: 'hidden', whiteSpace: 'nowrap',
  }, 'Library'));

  const addFolderBtn = iconBtn('📁+', 'New root folder', () => _createNode(null, false));
  const addEntryBtn  = iconBtn('📝+', 'New root entry',  () => _createNode(null, true));
  const collapseBtn  = iconBtn('⊟',   'Collapse all',    () => { _expanded.clear(); _rerender(); });
  const expandBtn    = iconBtn('⊞',   'Expand all',      () => {
    _expanded = new Set(_nodes.map(n => n.parent_id).filter(p => p != null));
    _rerender();
  });
  const refreshBtn   = iconBtn('↻',   'Refresh',          _load);
  _toolbarInner.append(addFolderBtn, addEntryBtn, collapseBtn, expandBtn, refreshBtn);
  toolbar.appendChild(_toolbarInner);

  // ── Filter bar ────────────────────────────────────────────────────────────
  _filterBar = el('div', {
    display: 'flex', gap: '2px', padding: '4px 6px',
    borderBottom: '1px solid #313244', flexShrink: '0', flexWrap: 'wrap',
  });

  // Polarity filter (radio: All / Pos / Neg) — independent of the In-Use toggle.
  const polBtns = {};
  const syncPol = () => {
    for (const [v, b] of Object.entries(polBtns)) {
      const a = _polarity === v;
      b.style.background = a ? '#313244' : 'none';
      b.style.color = a ? '#cdd6f4' : '#6c7086';
      b.style.borderColor = a ? '#45475a' : 'transparent';
    }
  };
  for (const [val, label] of [['all', 'All'], ['pos', 'Pos'], ['neg', 'Neg']]) {
    const btn = el('button', {
      padding: '2px 7px', borderRadius: '10px', border: '1px solid transparent',
      fontSize: '10px', cursor: 'pointer', fontWeight: '500',
    }, label);
    btn.addEventListener('click', () => { _polarity = val; syncPol(); _rerender(); });
    polBtns[val] = btn;
    _filterBar.appendChild(btn);
  }
  syncPol();

  _filterBar.appendChild(el('span', { flex: '0 0 8px' }));   // small gap

  // In-Use toggle — independent; combines (AND) with the polarity filter.
  const useBtn = el('button', {
    padding: '2px 9px', borderRadius: '10px', border: '1px solid transparent',
    fontSize: '10px', cursor: 'pointer', fontWeight: '500',
  }, '◉ In Use');
  const syncUse = () => {
    useBtn.style.background  = _inUse ? '#2d1b5e' : 'none';
    useBtn.style.color       = _inUse ? '#cba6f7' : '#6c7086';
    useBtn.style.borderColor = _inUse ? '#7c3aed' : 'transparent';
  };
  useBtn.title = 'Show only entries referenced by the positive/negative editors';
  useBtn.addEventListener('click', () => { _inUse = !_inUse; syncUse(); _refreshInUse(); });
  syncUse();
  _filterBar.appendChild(useBtn);

  // ── Sort bar ──────────────────────────────────────────────────────────────
  _sortBar = el('div', {
    display: 'flex', alignItems: 'center', gap: '3px',
    padding: '3px 6px', borderBottom: '1px solid #313244',
    flexShrink: '0',
  });
  _sortBar.appendChild(el('span', { fontSize: '10px', color: '#6c7086' }, 'Sort:'));

  const sorts = [['name', 'Name'], ['created', 'Created']];
  for (const [val, label] of sorts) {
    const btn = el('button', {
      padding: '1px 6px', borderRadius: '3px', border: '1px solid transparent',
      fontSize: '10px', cursor: 'pointer',
      background: _sortBy === val ? '#313244' : 'none',
      color:      _sortBy === val ? '#cdd6f4' : '#6c7086',
    }, label);
    btn.dataset.sort = val;
    btn.addEventListener('click', () => {
      if (_sortBy === val) { _sortAsc = !_sortAsc; }
      else { _sortBy = val; _sortAsc = true; }
      for (const b of _sortBar.querySelectorAll('[data-sort]')) {
        const active = b.dataset.sort === _sortBy;
        b.style.background  = active ? '#313244' : 'none';
        b.style.color       = active ? '#cdd6f4' : '#6c7086';
        b.style.borderColor = active ? '#45475a' : 'transparent';
      }
      dirBtn.textContent = _sortAsc ? '↑' : '↓';
      _rerender();
    });
    _sortBar.appendChild(btn);
  }

  const spacer = el('div', { flex: '1' });
  const dirBtn = el('button', {
    padding: '1px 5px', borderRadius: '3px', border: 'none',
    fontSize: '11px', cursor: 'pointer', background: 'none', color: '#6c7086',
  }, _sortAsc ? '↑' : '↓');
  dirBtn.title = 'Toggle sort direction';
  dirBtn.addEventListener('click', () => {
    _sortAsc = !_sortAsc;
    dirBtn.textContent = _sortAsc ? '↑' : '↓';
    _rerender();
  });
  _sortBar.append(spacer, dirBtn);

  // ── Tree list ─────────────────────────────────────────────────────────────
  _listEl = el('div', { flex: '1', overflowY: 'auto', padding: '4px 0' });

  // Right-click on empty list space → add a root folder/entry (#9). Row context
  // menus stopPropagation, so this only fires on the blank area.
  _listEl.addEventListener('contextmenu', e => {
    e.preventDefault();
    window.plv2.showContextMenu(e.clientX, e.clientY, [
      { label: 'Add folder', action: () => _createNode(null, false) },
      { label: 'Add entry',  action: () => _createNode(null, true)  },
    ]);
  });

  container.append(toolbar, _filterBar, _sortBar, _listEl);
}

// ─── Register ─────────────────────────────────────────────────────────────────

window.plv2Tree = { onSelectEntry, onSelectFolder, reload: _load };

app.registerExtension({
  name: 'XYZNodes.PromptLibraryV2.Tree',

  async setup() {
    const wait = () => new Promise(r => setTimeout(r, 50));
    for (let i = 0; i < 20 && !window.plv2; i++) await wait();
    if (!window.plv2) { console.warn('[PLv2 Tree] window.plv2 not found'); return; }

    window.plv2.windows.library.onShow(() => {
      const col = window.plv2.panel.tree;
      if (!col) return;
      _buildDOM(col);
      _load();
    });

    // Keep the In-Use filter live as the editors change (debounced).
    let _useTimer = null;
    document.addEventListener('plv2:editor-changed', () => {
      if (!_inUse || !_listEl) return;
      clearTimeout(_useTimer);
      _useTimer = setTimeout(_refreshInUse, 250);
    });
  },
});
