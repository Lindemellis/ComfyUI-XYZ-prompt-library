/**
 * Prompt Library V2 — LLM Prompt Assistant window (4th floating window).
 *
 * Rendered into window.plv2.windows.llm.body (the _makeWindow registration lives in
 * plv2.js). Two tabs:
 *   • Blocks — the system-prompt template: reorderable blocks, each with an enable
 *     switch, a saved-variant dropdown, and a resizable textarea. Special blocks
 *     (history / base_prompt / user_request) are placeholders.
 *   • Chat — bind a PLv2 node's resolved prompt as the base prompt, pick/seed a
 *     conversation, send a request → /xyz/llm/chat (tool loop) → render the reply,
 *     with Stop / Regenerate and Copy / Apply on the model's ```prompt block.
 *
 * All persistence is server-side (window.plv2.api.llm.*). Chat uses a raw fetch with
 * an AbortController so Stop can cancel an in-flight request.
 */

import { app } from '../../../scripts/app.js';

const PLV2_TYPES = new Set([
  'XYZ Prompt Library V2 Positive',
  'XYZ Prompt Library V2 Negative',
]);
const SPECIAL = new Set(['history', 'base_prompt', 'user_request']);
const BASE_H_KEY = 'plv2_llm_base_h';
const BASE_COLLAPSE_KEY = 'plv2_llm_base_collapsed';
const C = {
  bg: '#1e1e2e', panel: '#181825', border: '#313244', text: '#cdd6f4', sub: '#6c7086',
  accent: '#cba6f7', accent2: '#89b4fa', input: '#11111b', userBubble: '#313244',
  asstBubble: '#1e2030', danger: '#f38ba8', green: '#a6e3a1',
};

// ─── tiny DOM helpers ───────────────────────────────────────────────────────────
function el(tag, css, ...kids) {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  for (const k of kids) if (k != null) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
}
function btn(label, css, onclick) {
  const b = el('button', 'cursor:pointer;border:none;border-radius:5px;font-size:12px;padding:4px 9px;' +
    `background:${C.border};color:${C.text};` + (css || ''));
  b.textContent = label;
  if (onclick) b.addEventListener('click', onclick);
  return b;
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function api() { return window.plv2.api.llm; }
// In-page dialogs (never the browser's confirm/prompt — they ignore z-order + theme).
const askText = (title, def) => window.plv2.inlinePrompt(title, def ?? '');
const askConfirm = (msg, opts) => window.plv2.inlineConfirm(msg, opts);
function toast(severity, summary, detail) {
  try { app.extensionManager.toast.add({ severity, summary, detail, life: 4000 }); }
  catch { console.log(`[LLM ${severity}] ${summary}: ${detail || ''}`); }
}

// ─── module state ───────────────────────────────────────────────────────────────
let _built = false;
let _tabBlocks = null, _tabChat = null, _activeTab = 'chat';
let _blocksHost = null;
// chat
let _conv = [];            // conversations
let _activeConvId = null;
let _convListEl = null, _logEl = null, _composerEl = null;
let _boundNodeId = null;   // base-prompt binding (transient)
let _baseText = '';
let _baseTextEl = null, _nodeSelectEl = null;
let _sending = false, _abort = null;
let _sendBtn = null, _stopBtn = null;

// ─── top-level render ───────────────────────────────────────────────────────────
function _render(body) {
  if (!_built) {
    _built = true;
    body.innerHTML = '';
    // tab bar
    const tabbar = el('div', `display:flex;gap:2px;padding:6px 8px 0;background:${C.panel};border-bottom:1px solid ${C.border};flex-shrink:0;`);
    const mkTab = (id, label) => {
      const t = el('div', `padding:7px 16px;cursor:pointer;border-radius:6px 6px 0 0;font-size:13px;font-weight:600;`);
      t.textContent = label;
      t.addEventListener('click', () => _selectTab(id));
      t.dataset.tab = id;
      return t;
    };
    const tBlocks = mkTab('blocks', 'Blocks');
    const tChat = mkTab('chat', 'Chat');
    tabbar.append(tChat, tBlocks);

    _tabBlocks = el('div', 'flex:1;display:none;flex-direction:column;min-height:0;overflow:hidden;');
    _tabChat = el('div', 'flex:1;display:none;flex-direction:column;min-height:0;overflow:hidden;');
    body.append(tabbar, _tabChat, _tabBlocks);
    body._tabbar = tabbar;

    _buildBlocksTab(_tabBlocks);
    _buildChatTab(_tabChat);
    _selectTab(_activeTab);
  }
  // refresh data each show
  _loadBlocks();
  _loadConversations();
  _refreshNodeOptions();
}

function _selectTab(id) {
  _activeTab = id;
  _tabBlocks.style.display = id === 'blocks' ? 'flex' : 'none';
  _tabChat.style.display = id === 'chat' ? 'flex' : 'none';
  const bar = _tabBlocks.parentElement?._tabbar;
  if (bar) for (const t of bar.children) {
    const on = t.dataset.tab === id;
    t.style.background = on ? C.bg : 'transparent';
    t.style.color = on ? C.accent : C.sub;
  }
  if (id === 'blocks') _loadBlocks();
  if (id === 'chat') { _loadConversations(); _refreshNodeOptions(); }
}

// ════════════════════════════════════════════════════════════════════════════════
// TAB 1 — BLOCKS
// ════════════════════════════════════════════════════════════════════════════════
function _buildBlocksTab(host) {
  const scroll = el('div', 'flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px;');
  _blocksHost = el('div', 'display:flex;flex-direction:column;gap:8px;');
  const addBtn = btn('＋ Add block', `align-self:flex-start;background:${C.accent2};color:#11111b;font-weight:600;`, _addBlock);
  scroll.append(_blocksHost, addBtn);
  host.append(scroll);
}

async function _loadBlocks() {
  if (!_blocksHost) return;
  let blocks = [];
  try { blocks = (await api().getBlocks())?.blocks ?? []; } catch (e) { return; }
  _blocksHost.innerHTML = '';
  for (const b of blocks) _blocksHost.append(_blockCard(b));
}

function _blockCard(b) {
  const card = el('div', `background:${C.panel};border:1px solid ${C.border};border-radius:7px;overflow:hidden;`);
  card.dataset.blockId = b.id;
  card.draggable = false;

  const head = el('div', `display:flex;align-items:center;gap:6px;padding:6px 8px;background:#1b1b29;`);
  // drag handle
  const handle = el('span', `cursor:grab;color:${C.sub};font-size:14px;user-select:none;`, '⠿');
  handle.title = 'Drag to reorder';
  handle.addEventListener('mousedown', () => { card.draggable = true; });
  handle.addEventListener('mouseup', () => { card.draggable = false; });
  card.addEventListener('dragstart', (e) => { card.classList.add('_dragging'); e.dataTransfer.effectAllowed = 'move'; });
  card.addEventListener('dragend', () => { card.classList.remove('_dragging'); card.draggable = false; _persistOrder(); });

  // enable toggle
  const en = el('input'); en.type = 'checkbox'; en.checked = !!b.enabled; en.style.cssText = 'cursor:pointer;accent-color:' + C.accent + ';';
  en.title = 'Enable / disable this block';
  en.addEventListener('change', () => api().updateBlock(b.id, { enabled: en.checked }));

  const name = el('span', `flex:1;font-weight:600;font-size:12px;color:${C.text};`, b.name);
  name.title = 'Double-click to rename';
  name.addEventListener('dblclick', async () => {
    const nv = await askText('Rename block:', b.name);
    if (nv && nv.trim()) { await api().updateBlock(b.id, { name: nv.trim() }); name.textContent = nv.trim(); }
  });
  const kindTag = el('span', `font-size:10px;color:${C.sub};background:#11111b;border-radius:4px;padding:1px 5px;`, b.kind);

  head.append(handle, en, name, kindTag);

  // body — depends on kind
  let bodyEl;
  if (b.kind === 'history') {
    bodyEl = _historyBody(b);
  } else if (b.kind === 'base_prompt' || b.kind === 'user_request') {
    bodyEl = el('div', `padding:8px 10px;color:${C.sub};font-size:11px;font-style:italic;`,
      b.kind === 'base_prompt' ? '(filled at send time with the bound node\'s resolved prompt)'
                               : '(filled at send time with your chat input)');
  } else {
    bodyEl = _textBody(b, head);
  }

  // delete button (all blocks deletable per spec)
  const del = el('span', `cursor:pointer;color:${C.sub};font-size:14px;padding:0 2px;`, '🗑');
  del.title = 'Delete block';
  del.addEventListener('click', async () => {
    if (!await askConfirm(`Delete block "${b.name}"?`, { okLabel: 'Delete', danger: true })) return;
    await api().deleteBlock(b.id); card.remove();
  });
  head.append(del);

  card.append(head, bodyEl);
  return card;
}

function _historyBody(b) {
  const wrap = el('div', 'padding:8px 10px;display:flex;align-items:center;gap:8px;');
  wrap.append(el('span', `font-size:11px;color:${C.sub};`, 'Keep last'));
  const sel = el('select', `background:${C.input};color:${C.text};border:1px solid ${C.border};border-radius:5px;padding:3px 6px;font-size:12px;`);
  const opts = ['all', '0', '1', '2', '3', '5', '10'];
  for (const o of opts) { const op = el('option', '', o === 'all' ? 'all' : o); op.value = o; sel.append(op); }
  sel.value = (b.keep_turns == null) ? 'all' : String(b.keep_turns);
  if (!opts.includes(sel.value)) { const op = el('option', '', sel.value); op.value = sel.value; sel.append(op); }
  sel.addEventListener('change', () => {
    const v = sel.value === 'all' ? null : parseInt(sel.value);
    api().updateBlock(b.id, { keep_turns: v });
  });
  wrap.append(sel, el('span', `font-size:11px;color:${C.sub};`, 'turns of conversation'));
  return wrap;
}

function _textBody(b, head) {
  const wrap = el('div', 'display:flex;flex-direction:column;');
  // variant row
  const vrow = el('div', `display:flex;align-items:center;gap:5px;padding:5px 8px;border-top:1px solid ${C.border};`);
  const vsel = el('select', `flex:1;background:${C.input};color:${C.text};border:1px solid ${C.border};border-radius:5px;padding:3px 6px;font-size:11px;`);
  const ta = el('textarea',
    `width:100%;box-sizing:border-box;min-height:90px;resize:vertical;background:${C.input};color:${C.text};` +
    `border:none;border-top:1px solid ${C.border};padding:8px 10px;font-family:"Fira Code",Consolas,monospace;font-size:12px;line-height:1.5;outline:none;`);
  ta.value = b.text || '';
  ta.spellcheck = false;

  let activeVid = b.active_variant_id;
  const reloadVariants = async () => {
    let vs = [];
    try { vs = (await api().getVariants(b.id))?.variants ?? []; } catch {}
    vsel.innerHTML = '';
    for (const v of vs) { const op = el('option', '', v.variant_name); op.value = v.id; vsel.append(op); }
    if (activeVid) vsel.value = String(activeVid);
  };
  vsel.addEventListener('change', async () => {
    activeVid = parseInt(vsel.value);
    await api().setActiveVariant(b.id, activeVid);
    const vs = (await api().getVariants(b.id))?.variants ?? [];
    const v = vs.find(x => x.id === activeVid);
    ta.value = v ? (v.text || '') : '';
  });

  const saveVar = debounce(() => {
    if (activeVid) api().updateVariant(b.id, activeVid, { text: ta.value, variant_name: vsel.options[vsel.selectedIndex]?.text || 'default' });
  }, 500);
  ta.addEventListener('input', saveVar);

  const newVar = btn('＋', `padding:3px 7px;`, async () => {
    const nm = await askText('New variant name:', 'v' + (vsel.options.length + 1));
    if (!nm) return;
    const r = await api().createVariant(b.id, { text: ta.value, variant_name: nm, set_active: true });
    activeVid = r?.id;
    await reloadVariants();
  });
  newVar.title = 'Save current text as a new variant';
  const delVar = btn('🗑', `padding:3px 7px;`, async () => {
    if (vsel.options.length <= 1) { toast('warn', 'Cannot delete', 'A block needs at least one variant.'); return; }
    const r = await api().deleteVariant(b.id, activeVid);
    if (r?.error) { toast('warn', 'Cannot delete', r.error.message); return; }
    await reloadVariants();
    const vs = (await api().getVariants(b.id))?.variants ?? [];
    activeVid = vs[vs.length - 1]?.id;
    if (activeVid) { vsel.value = String(activeVid); ta.value = vs.find(x => x.id === activeVid)?.text || ''; }
  });
  delVar.title = 'Delete the current variant';

  vrow.append(el('span', `font-size:10px;color:${C.sub};`, 'variant'), vsel, newVar, delVar);
  reloadVariants();

  // collapse
  let collapsed = false;
  const collapseBtn = el('span', `cursor:pointer;color:${C.sub};font-size:12px;padding:0 2px;`, '▾');
  collapseBtn.title = 'Collapse / expand';
  collapseBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    vrow.style.display = collapsed ? 'none' : 'flex';
    ta.style.display = collapsed ? 'none' : 'block';
    collapseBtn.textContent = collapsed ? '▸' : '▾';
  });
  head.insertBefore(collapseBtn, head.children[head.children.length - 1]);

  wrap.append(vrow, ta);
  return wrap;
}

async function _addBlock() {
  const name = await askText('New block name:', 'Custom block');
  if (!name || !name.trim()) return;
  const count = _blocksHost.children.length;
  await api().createBlock({ kind: 'custom', name: name.trim(), text: '', enabled: true, order_index: count });
  _loadBlocks();
}

// drag reorder
function _persistOrder() {
  const order = {};
  [..._blocksHost.children].forEach((c, i) => { order[parseInt(c.dataset.blockId)] = i; });
  api().reorderBlocks(order);
}
// dragover insertion across cards
document.addEventListener('dragover', (e) => {
  if (!_blocksHost) return;
  const dragging = _blocksHost.querySelector('._dragging');
  if (!dragging) return;
  e.preventDefault();
  const after = _afterElement(_blocksHost, e.clientY);
  if (after == null) _blocksHost.append(dragging);
  else _blocksHost.insertBefore(dragging, after);
});
function _afterElement(container, y) {
  const els = [...container.querySelectorAll('[data-block-id]:not(._dragging)')];
  let closest = { offset: -Infinity, el: null };
  for (const child of els) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, el: child };
  }
  return closest.el;
}

// ════════════════════════════════════════════════════════════════════════════════
// TAB 2 — CHAT
// ════════════════════════════════════════════════════════════════════════════════
function _buildChatTab(host) {
  // base-prompt binding bar
  const bar = el('div', `display:flex;flex-direction:column;gap:5px;padding:7px 9px;background:${C.panel};border-bottom:1px solid ${C.border};flex-shrink:0;`);
  const r1 = el('div', 'display:flex;align-items:center;gap:6px;');
  // collapse / expand toggle for the whole base-prompt text section
  const collapseBtn = el('span', `cursor:pointer;color:${C.sub};font-size:12px;user-select:none;width:12px;`, '▾');
  collapseBtn.title = 'Collapse / expand the base prompt';
  r1.append(collapseBtn, el('span', `font-size:11px;color:${C.sub};`, 'Base prompt:'));
  _nodeSelectEl = el('select', `flex:1;background:${C.input};color:${C.text};border:1px solid ${C.border};border-radius:5px;padding:3px 6px;font-size:11px;`);
  _nodeSelectEl.addEventListener('change', () => _bindNode(_nodeSelectEl.value === '' ? null : parseInt(_nodeSelectEl.value)));
  r1.append(_nodeSelectEl);
  _baseTextEl = el('textarea', `width:100%;box-sizing:border-box;height:${localStorage.getItem(BASE_H_KEY) || '46px'};resize:none;background:${C.input};color:${C.text};border:1px solid ${C.border};border-radius:5px;padding:5px 8px;font-family:"Fira Code",Consolas,monospace;font-size:11px;outline:none;`);
  _baseTextEl.placeholder = '(optional) the txt2img prompt to optimize — bind a node or free-edit';
  _baseTextEl.addEventListener('input', () => { if (_boundNodeId == null) _baseText = _baseTextEl.value; });

  // vertical resize handle (drag to set the base-prompt textarea height)
  const resizeHandle = el('div', `height:8px;cursor:ns-resize;display:flex;align-items:center;justify-content:center;flex-shrink:0;`);
  const grip = el('div', `width:36px;height:3px;border-radius:2px;background:${C.sub};opacity:.45;transition:opacity .1s;`);
  resizeHandle.append(grip);
  resizeHandle.addEventListener('mouseenter', () => { grip.style.opacity = '0.9'; });
  resizeHandle.addEventListener('mouseleave', () => { grip.style.opacity = '0.45'; });
  resizeHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY, startH = _baseTextEl.offsetHeight;
    const onMove = (ev) => { _baseTextEl.style.height = Math.max(28, startH + (ev.clientY - startY)) + 'px'; };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      try { localStorage.setItem(BASE_H_KEY, _baseTextEl.style.height); } catch {}
    };
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // collapse state (persisted)
  let collapsed = localStorage.getItem(BASE_COLLAPSE_KEY) === '1';
  const applyCollapse = () => {
    _baseTextEl.style.display = collapsed ? 'none' : 'block';
    resizeHandle.style.display = collapsed ? 'none' : 'flex';
    collapseBtn.textContent = collapsed ? '▸' : '▾';
  };
  collapseBtn.addEventListener('click', () => {
    collapsed = !collapsed;
    try { localStorage.setItem(BASE_COLLAPSE_KEY, collapsed ? '1' : '0'); } catch {}
    applyCollapse();
  });

  bar.append(r1, _baseTextEl, resizeHandle);
  applyCollapse();

  // body: conversation list | active conversation
  const split = el('div', 'flex:1;display:flex;min-height:0;');
  // left
  const left = el('div', `width:140px;flex-shrink:0;display:flex;flex-direction:column;border-right:1px solid ${C.border};background:${C.panel};`);
  const newConvBtn = btn('＋ New chat', `margin:6px;background:${C.accent2};color:#11111b;font-weight:600;`, async () => {
    const r = await api().createConversation('');
    await _loadConversations();
    _selectConv(r.id);
  });
  _convListEl = el('div', 'flex:1;overflow-y:auto;');
  left.append(newConvBtn, _convListEl);
  // right
  const right = el('div', 'flex:1;display:flex;flex-direction:column;min-width:0;');
  _logEl = el('div', 'flex:1;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:8px;');
  _composerEl = _buildComposer();
  right.append(_logEl, _composerEl);

  split.append(left, right);
  host.append(bar, split);
}

function _buildComposer() {
  const wrap = el('div', `border-top:1px solid ${C.border};padding:7px;display:flex;gap:6px;align-items:flex-end;background:${C.panel};`);
  const ta = el('textarea', `flex:1;box-sizing:border-box;height:54px;resize:vertical;background:${C.input};color:${C.text};border:1px solid ${C.border};border-radius:6px;padding:7px 9px;font-size:12px;outline:none;`);
  ta.placeholder = 'Describe what to generate / how to optimize… (Enter = newline, click Send)';
  wrap._ta = ta;
  _sendBtn = btn('Send', `background:${C.accent};color:#11111b;font-weight:600;padding:7px 14px;`, () => _send(ta));
  _stopBtn = btn('Stop', `background:${C.danger};color:#11111b;font-weight:600;padding:7px 14px;display:none;`, _stop);
  wrap.append(ta, _sendBtn, _stopBtn);
  return wrap;
}

// ── conversations ──
async function _loadConversations() {
  if (!_convListEl) return;
  try { _conv = (await api().getConversations())?.conversations ?? []; } catch { return; }
  _convListEl.innerHTML = '';
  for (const c of _conv) _convListEl.append(_convRow(c));
  if (_activeConvId == null && _conv.length) _selectConv(_conv[0].id);
  else if (_activeConvId != null && !_conv.find(c => c.id === _activeConvId)) {
    _activeConvId = null; _logEl && (_logEl.innerHTML = '');
    if (_conv.length) _selectConv(_conv[0].id);
  } else _highlightConv();
}

function _convRow(c) {
  const row = el('div', `padding:7px 9px;cursor:pointer;font-size:11px;border-bottom:1px solid ${C.border};display:flex;align-items:center;gap:4px;`);
  row.dataset.convId = c.id;
  const title = el('span', 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', c.title || '(untitled)');
  title.addEventListener('dblclick', async (e) => {
    e.stopPropagation();
    const nv = await askText('Rename conversation:', c.title || '');
    if (nv != null) { await api().renameConversation(c.id, nv); title.textContent = nv || '(untitled)'; }
  });
  const del = el('span', `color:${C.sub};font-size:13px;`, '×');
  del.title = 'Delete conversation';
  del.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!await askConfirm(`Delete conversation "${c.title || '(untitled)'}"?`, { okLabel: 'Delete', danger: true })) return;
    await api().deleteConversation(c.id);
    if (_activeConvId === c.id) { _activeConvId = null; _logEl.innerHTML = ''; }
    _loadConversations();
  });
  row.append(title, del);
  row.addEventListener('click', () => _selectConv(c.id));
  return row;
}

function _highlightConv() {
  if (!_convListEl) return;
  for (const r of _convListEl.children) {
    const on = parseInt(r.dataset.convId) === _activeConvId;
    r.style.background = on ? C.bg : 'transparent';
    r.style.color = on ? C.accent : C.text;
  }
}

async function _selectConv(id) {
  _activeConvId = id;
  _highlightConv();
  await _loadMessages();
}

async function _loadMessages() {
  if (!_logEl) return;
  _logEl.innerHTML = '';
  if (_activeConvId == null) return;
  let msgs = [];
  try { msgs = (await api().getMessages(_activeConvId))?.messages ?? []; } catch { return; }
  const visible = msgs.filter(m => m.role === 'user' || m.role === 'assistant');
  visible.forEach((m, i) => {
    const isLastAsst = m.role === 'assistant' && i === visible.length - 1;
    _logEl.append(_msgBubble(m, isLastAsst));
  });
  _logEl.scrollTop = _logEl.scrollHeight;
}

function _msgBubble(m, isLastAsst) {
  const isUser = m.role === 'user';
  const wrap = el('div', `display:flex;flex-direction:column;gap:3px;align-items:${isUser ? 'flex-end' : 'flex-start'};`);
  const bubble = el('div', `max-width:88%;border-radius:9px;padding:8px 11px;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;` +
    `background:${isUser ? C.userBubble : C.asstBubble};color:${C.text};`);

  if (isUser) {
    bubble.textContent = m.content;
    wrap.append(bubble);
    return wrap;
  }

  // assistant — render trace + content with ```prompt extraction
  const meta = m.meta || {};
  if (Array.isArray(meta.trace) && meta.trace.length) {
    const n = meta.trace.reduce((s, t) => s + ((t.results || []).length), 0);
    const tr = el('div', `font-size:10px;color:${C.sub};cursor:pointer;`, `🔎 looked up ${n} tag(s) in ${meta.trace.length} call(s) — show`);
    const detail = el('div', `display:none;font-size:10px;color:${C.sub};background:#11111b;border-radius:5px;padding:5px 7px;margin-top:3px;white-space:pre-wrap;`);
    detail.textContent = meta.trace.map(t => `${t.name}(${JSON.stringify(t.args?.queries || [])}) → ${(t.results || []).map(r => r.name).join(', ')}`).join('\n');
    tr.addEventListener('click', () => { detail.style.display = detail.style.display === 'none' ? 'block' : 'none'; });
    wrap.append(tr, detail);
  }
  if (meta.capped) bubble.append(el('div', `font-size:10px;color:${C.danger};margin-bottom:4px;`, '⚠ tool loop hit its limit — answer forced'));

  _renderAssistantContent(bubble, m.content);
  wrap.append(bubble);

  if (isLastAsst) {
    const regen = el('span', `font-size:10px;color:${C.sub};cursor:pointer;margin-top:2px;`, '↻ regenerate');
    regen.addEventListener('click', _regenerate);
    wrap.append(regen);
  }
  return wrap;
}

// split content into text + ```prompt fenced blocks (with Copy/Apply)
function _renderAssistantContent(host, content) {
  const re = /```prompt\s*\n?([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = re.exec(content)) !== null) {
    if (m.index > last) host.append(el('span', '', content.slice(last, m.index)));
    host.append(_promptBox(m[1].trim()));
    last = re.lastIndex;
  }
  if (last < content.length) host.append(el('span', '', content.slice(last)));
  if (host.childNodes.length === 0) host.textContent = content;
}

function _promptBox(text) {
  const box = el('div', `margin:6px 0;border:1px solid ${C.accent};border-radius:6px;overflow:hidden;`);
  const code = el('div', `padding:8px 10px;background:#11111b;font-family:"Fira Code",Consolas,monospace;font-size:11.5px;line-height:1.5;color:${C.green};white-space:pre-wrap;word-break:break-word;`, text);
  const bar = el('div', `display:flex;gap:5px;padding:5px 7px;background:#1b1b29;`);
  const copy = btn('Copy', '', () => { navigator.clipboard.writeText(text); toast('success', 'Copied', ''); });
  const apply = btn('Apply', `background:${C.accent2};color:#11111b;font-weight:600;`, () => _applyToBoundNode(text));
  if (_boundNodeId == null) { apply.disabled = true; apply.style.opacity = '0.5'; apply.title = 'Bind a node first'; }
  bar.append(copy, apply);
  box.append(code, bar);
  return box;
}

// ── send / stop / regenerate ──
async function _send(ta) {
  if (_sending) return;
  const request = (ta?.value || '').trim();
  const base = _boundNodeId != null ? _baseText : (_baseTextEl?.value || '');
  if (!request && !base.trim()) { toast('warn', 'Empty', 'Type a request first.'); return; }

  // lazy-create a conversation on first send
  if (_activeConvId == null) {
    const title = request.slice(0, 24) || 'New chat';
    const r = await api().createConversation(title);
    _activeConvId = r.id;
    await _loadConversations();
  }
  if (ta) ta.value = '';
  await _doSend(request, base, '🤖 thinking…');
  _loadConversations();  // refresh titles/order
}

async function _doSend(request, base, pendingLabel) {
  _setSending(true);
  if (request) _logEl.append(_msgBubble({ role: 'user', content: request }, false));
  const pending = el('div', `align-self:flex-start;color:${C.sub};font-size:11px;padding:6px;`, pendingLabel);
  _logEl.append(pending);
  _logEl.scrollTop = _logEl.scrollHeight;

  _abort = new AbortController();
  try {
    const resp = await fetch('/xyz/llm/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation_id: _activeConvId, base_prompt: base, user_request: request }),
      signal: _abort.signal,
    });
    pending.remove();
    if (resp.status === 404) { _logEl.append(_errBubble('Chat endpoint not found — restart ComfyUI to load the LLM routes.')); return; }
    const j = await resp.json().catch(() => ({ error: { message: 'bad response from server (restart ComfyUI?)' } }));
    if (j.error) {
      if (j.error.code === 'no_api_key') {
        _logEl.append(_errBubble('No API key set. Open Settings → LLM.'));
        toast('warn', 'No API key', 'Set it in Settings → LLM.');
        try { window.xyzSettingsPage?.show(); } catch {}
      } else {
        _logEl.append(_errBubble(j.error.message || 'request failed'));
      }
    }
    await _loadMessages();  // reload from server (route persisted everything)
  } catch (e) {
    pending.remove();
    if (e.name === 'AbortError') _logEl.append(el('div', `align-self:flex-start;color:${C.sub};font-size:11px;`, '⏹ stopped'));
    else _logEl.append(_errBubble(String(e.message || e)));
  } finally {
    _setSending(false);
    _abort = null;
  }
}

function _errBubble(msg) {
  return el('div', `align-self:flex-start;max-width:88%;background:#3a1e26;border:1px solid ${C.danger};color:${C.danger};border-radius:9px;padding:8px 11px;font-size:11.5px;`, '⚠ ' + msg);
}

function _stop() { if (_abort) _abort.abort(); }

function _setSending(on) {
  _sending = on;
  if (_sendBtn) _sendBtn.style.display = on ? 'none' : 'block';
  if (_stopBtn) _stopBtn.style.display = on ? 'block' : 'none';
}

async function _regenerate() {
  if (_sending || _activeConvId == null) return;
  // find the last user message (text + its base_prompt), then drop that whole turn so
  // the resend re-persists it once (no duplicate) and regenerates the answer.
  let msgs = [];
  try { msgs = (await api().getMessages(_activeConvId))?.messages ?? []; } catch { return; }
  const lastUser = [...msgs].reverse().find(m => m.role === 'user');
  if (!lastUser) return;
  const base = lastUser.meta?.base_prompt || (_boundNodeId != null ? _baseText : (_baseTextEl?.value || ''));
  await api().deleteLastAssistant(_activeConvId, true);  // include_user
  await _loadMessages();
  await _doSend(lastUser.content, base, '🤖 regenerating…');
}

// ── base-prompt node binding ──
function _plv2Nodes() {
  return (app.graph?._nodes ?? app.graph?.nodes ?? []).filter(n => PLV2_TYPES.has(n.comfyClass));
}
function _refreshNodeOptions() {
  if (!_nodeSelectEl) return;
  const cur = _nodeSelectEl.value;
  _nodeSelectEl.innerHTML = '';
  const free = el('option', '', 'Free edit (no node)'); free.value = ''; _nodeSelectEl.append(free);
  for (const n of _plv2Nodes()) {
    const op = el('option', '', `#${n.id} ${n.title || n.comfyClass}`); op.value = n.id; _nodeSelectEl.append(op);
  }
  if (_boundNodeId != null && _plv2Nodes().find(n => n.id === _boundNodeId)) _nodeSelectEl.value = String(_boundNodeId);
  else _nodeSelectEl.value = cur && [..._nodeSelectEl.options].some(o => o.value === cur) ? cur : '';
}
function _nodeTemplate(nodeId) {
  const n = _plv2Nodes().find(x => x.id === nodeId);
  return n?.widgets?.find(w => w.name === 'prompt_template')?.value ?? null;
}
async function _bindNode(nodeId) {
  _boundNodeId = nodeId;
  if (nodeId == null) {
    _baseTextEl.readOnly = false;
    _baseTextEl.style.opacity = '1';
    return;
  }
  _baseTextEl.readOnly = true;
  _baseTextEl.style.opacity = '0.85';
  if (_nodeSelectEl) _nodeSelectEl.value = String(nodeId);
  await _resolveBase();
  // re-render apply buttons (now enabled)
  _loadMessages();
}
const _resolveBaseDebounced = debounce(() => _resolveBase(), 350);
async function _resolveBase() {
  if (_boundNodeId == null) return;
  const tmpl = _nodeTemplate(_boundNodeId);
  if (tmpl == null) { _baseText = ''; _baseTextEl.value = '(node not found)'; return; }
  try {
    const r = await window.plv2.api.resolveTemplate(tmpl, 0);
    _baseText = r?.text ?? '';
  } catch { _baseText = tmpl; }
  _baseTextEl.value = _baseText;
}
function _applyToBoundNode(text) {
  if (_boundNodeId == null) { toast('warn', 'No node bound', 'Bind a node in the Base prompt selector first.'); return; }
  const n = _plv2Nodes().find(x => x.id === _boundNodeId);
  const w = n?.widgets?.find(x => x.name === 'prompt_template');
  if (!w) { toast('warn', 'Node not found', ''); return; }
  w.value = text;
  if (w.inputEl) { w.inputEl.value = text; w.inputEl.dispatchEvent(new Event('input', { bubbles: true })); }
  try { app.graph.setDirtyCanvas(true, true); } catch {}
  document.dispatchEvent(new CustomEvent('plv2:node-edited', { detail: { nodeId: _boundNodeId, value: text } }));
  toast('success', 'Applied', `Wrote the prompt into node #${_boundNodeId}.`);
  _resolveBase();
}

// ─── extension registration ─────────────────────────────────────────────────────
app.registerExtension({
  name: 'XYZNodes.PromptLibraryV2.LLM',
  async setup() {
    const wait = () => new Promise(r => setTimeout(r, 50));
    for (let i = 0; i < 40 && !window.plv2?.windows?.llm; i++) await wait();
    const win = window.plv2?.windows?.llm;
    if (!win) { console.warn('[PLv2 LLM] window.plv2.windows.llm not found'); return; }

    win.onShow(() => _render(win.body));

    // node / editor "🤖 LLM" buttons → bind a node's resolved prompt as base.
    document.addEventListener('plv2:llm-bind', async (e) => {
      const nid = e.detail?.nodeId;
      if (nid == null) return;
      if (!win.isVisible()) win.show();
      _render(win.body);
      _selectTab('chat');
      _refreshNodeOptions();
      await _bindNode(nid);
    });

    // bound node edited on canvas → re-resolve the base prompt (debounced).
    document.addEventListener('plv2:node-edited', (e) => {
      if (_boundNodeId != null && e.detail?.nodeId === _boundNodeId) _resolveBaseDebounced();
    });
  },
});
