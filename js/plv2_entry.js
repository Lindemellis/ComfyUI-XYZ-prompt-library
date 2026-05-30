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
let _tplChildren = [];   // inherited sub-entries (the template's direct children)
let _tplPrompts  = [];   // inherited template prompts (effective enable/weight after overrides)
let _formats     = [];
let _delimiters  = [];
let _entryFormats = [];  // distinct non-empty formats used by other entries (autocomplete)

let _activePanel = 'prompts';   // 'prompts' | 'subentries'
let _layout      = 'vertical';  // 'vertical' | 'compact'
let _negAutoInsert = true;       // also insert the _neg sub-entry when inserting this entry
let _syncLock    = false;
let _blurTimer    = null;  // debounce timer for blur-triggered sync
let _caretBeforeClick = null; // textarea caret captured at pointerdown (capture phase),
                              // before the click can move focus to a button; null when the
                              // textarea wasn't focused as the click began (clicked elsewhere)
let _dragSrcId   = null;         // prompt id being dragged
let _previewPop  = null;         // floating resolved-preview popup (feature #2)
let _previewHideTimer = null;    // grace-delay timer before hiding the popup
let _nlCount     = 0;            // newline count in the text box (live-sync trigger, #3)
let _panelRatio  = (() => { const v = parseFloat(localStorage.getItem('plv2_panel_ratio') || ''); return (v >= 0.15 && v <= 0.85) ? v : 0.62; })();  // Prompts:Sub split (#1)

// DOM refs
let _detail         = null;
let _nameInput      = null;
let _titleEl        = null;
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

const LAST_ENTRY_KEY = 'plv2_last_entry_v1';

async function showEntry(node, pushHistory = true) {
  if (!node || !node.has_prompts) return;
  _detail = window.plv2.panel.detail;
  if (pushHistory && _node && _node.id !== node.id) _history.push(_node);
  _node = node;
  // Remember last opened entry
  try { localStorage.setItem(LAST_ENTRY_KEY, String(node.id)); } catch {}
  await _loadData();
  _render();
  // Reveal this entry in the folder tree: expand its path, select + scroll (#7).
  window.plv2Tree?.reveal?.(node.id);
}

function getLastEntryId() {
  try { return parseInt(localStorage.getItem(LAST_ENTRY_KEY) || '', 10); } catch { return null; }
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
  // Formats already used by other entries → format-input autocomplete (feature #1).
  _entryFormats = [...new Set(
    all.filter(n => n.has_prompts && n.id !== nid && n.format && n.format.trim())
       .map(n => n.format))];

  // Template inheritance (backend-resolved: chain-aware prompts + sub-entries).
  _tplPrompts = [];
  _tplChildren = [];
  try {
    const inh = await _api().getInherited(nid);
    _tplPrompts  = inh?.prompts  ?? [];
    _tplChildren = inh?.children ?? [];
  } catch (e) { console.error('[PLv2]', e); }

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
  // Enabled OWN + enabled INHERITED template prompts, interleaved by the unified
  // order_index (= text box position) so template prompts appear in the box (#2/#3).
  const enabled = [
    ..._prompts.filter(p => p.enabled).map(p => ({ content: p.content, weight: p.weight, order_index: p.order_index, sep_after: p.sep_after })),
    ..._tplPrompts.filter(p => p.enabled).map(p => ({ content: p.content, weight: p.weight, order_index: p.order_index, sep_after: 0 })),
  ].sort((a, b) => (a.order_index ?? 1e9) - (b.order_index ?? 1e9));
  const D = _delim();
  const Dtrim = D.replace(/[ \t]+$/, '');   // drop trailing space before a newline
  let out = '';
  for (let i = 0; i < enabled.length; i++) {
    const p = enabled[i];
    const w = p.weight ?? 1.0;
    out += Math.abs(w - 1.0) < 0.001 ? p.content : `(${p.content}:${parseFloat(w.toFixed(2))})`;
    const sep = p.sep_after ?? 0;          // newlines after this prompt (feature B)
    if (i < enabled.length - 1) out += sep > 0 ? Dtrim + '\n'.repeat(sep) : D;
    else if (sep > 0)           out += '\n'.repeat(sep);
  }
  return out;
}

// Parse the text box into prompt parts, recording how many newlines follow each
// prompt (sepAfter) so the layout survives list-ops and resolve (feature B).
function _parseRawParts(text, delim) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  let last = null;
  for (let li = 0; li < lines.length; li++) {
    for (const seg of lines[li].split(delim)) {
      const s = seg.trim();
      if (!s) continue;
      const p = _parsePromptPart(s);
      last = { content: p.content, weight: p.weight, sepAfter: 0 };
      out.push(last);
    }
    if (li < lines.length - 1 && last) last.sepAfter += 1;  // newline ends this line
  }
  return out;
}

async function _syncTextToList() {
  if (_syncLock || !_promptTextarea || !_node) return;
  // Structured parse: prompt parts + the newline count after each (feature B).
  const rawParts = _parseRawParts(_promptTextarea.value, _delim());

  // Normalise (skip refs/patterns) + drop duplicates (#6), keeping first occurrence.
  const seen = new Set();
  const parts = [];
  let changed = false;
  for (const part of rawParts) {
    const norm = window.plv2.cleanPrompt(part.content);
    if (norm !== part.content) changed = true;
    part.content = norm;
    if (!part.content) { changed = true; continue; }
    if (seen.has(part.content)) { changed = true; continue; }
    seen.add(part.content);
    parts.push(part);   // { content, weight, sepAfter }
  }

  const ownByContent = new Map(_prompts.map(p => [p.content.trim(), p]));
  const tplByContent = new Map(_tplPrompts.map(p => [p.content.trim(), p]));
  const inText       = new Set(parts.map(p => p.content));

  // Create brand-new OWN prompts (parts that match neither an own nor a template prompt)
  for (const { content, weight } of parts) {
    if (ownByContent.has(content) || tplByContent.has(content)) continue;
    try {
      const r = await _api().createPrompt(_node.id, { content, enabled: true, weight, order_index: 0, sep_after: 0 });
      const created = r?.prompt ?? { id: Date.now() + Math.random(), content, enabled: true, order_index: 0, weight, sep_after: 0 };
      _prompts.push(created);
      ownByContent.set(content, created);
    } catch(e) { console.error('[PLv2]', e); }
  }

  // Walk parts in order, assigning a UNIFIED position (idx) to own + template
  // prompts alike; template prompts persist via per-entry overrides (#2/#3).
  const ops = [];     // own prompt PATCHes
  const ov  = [];     // template override POSTs
  const seenTpl = new Set();
  let idx = 0;
  for (const { content, weight, sepAfter } of parts) {
    const tp = tplByContent.get(content);
    if (tp) {
      seenTpl.add(tp.id);
      const body = {};
      if (!tp.enabled)              { body.enabled = true; tp.enabled = true; }
      if (tp.order_index !== idx)   { body.order_index = idx; tp.order_index = idx; }
      if (Math.abs((tp.weight ?? 1) - weight) > 0.001) { body.weight = weight; tp.weight = weight; }
      if (Object.keys(body).length) ov.push(_api().setOverride(_node.id, tp.id, body));
      idx++;
      continue;
    }
    const p = ownByContent.get(content);
    if (!p) continue;
    const upd = {};
    if (!p.enabled)              { upd.enabled = true;  p.enabled = true; }
    if (p.order_index !== idx)   { upd.order_index = idx; p.order_index = idx; }
    if (Math.abs((p.weight ?? 1) - weight) > 0.001) { upd.weight = weight; p.weight = weight; }
    if ((p.sep_after ?? 0) !== sepAfter) { upd.sep_after = sepAfter; p.sep_after = sepAfter; }
    if (Object.keys(upd).length) ops.push(_api().updatePrompt(p.id, upd));
    idx++;
  }
  // Own prompts removed from the text → disable.
  for (const p of _prompts) {
    if (p.enabled && !inText.has(p.content.trim())) { p.enabled = false; ops.push(_api().updatePrompt(p.id, { enabled: false })); }
  }
  // Template prompts removed from the text → disable via override.
  for (const tp of _tplPrompts) {
    if (tp.enabled && !seenTpl.has(tp.id)) { tp.enabled = false; ov.push(_api().setOverride(_node.id, tp.id, { enabled: false })); }
  }
  await Promise.all([...ops, ...ov]);

  _syncLock = true;
  _renderListBody();
  // Legacy normalise/dedupe rewrite ONLY when the user has no manual newline layout
  // — otherwise we would erase their line breaks (feature a).
  if (changed && !_promptTextarea.value.includes('\n')) _syncListToText();
  _syncLock = false;
  _persistRawText();
  _notifyEditorIfReferenced();
}

function _syncListToText() {
  if (_syncLock || !_promptTextarea) return;
  _syncLock = true;
  _promptTextarea.value = _buildText();
  _syncLock = false;
  _persistRawText();
}

// Persist the text box content verbatim so the user's newline layout round-trips
// (feature a). raw_text is the editing surface; prompts are derived from it.
function _persistRawText() {
  if (!_node || !_promptTextarea) return;
  const v = _promptTextarea.value;
  if (v === (_node.raw_text ?? '')) return;
  _node.raw_text = v;
  _api().updateNode(_node.id, { raw_text: v }).catch(e => console.error('[PLv2]', e));
}

// Choose the text box's initial content: prefer the stored raw layout, but fall
// back to a rebuild when it has drifted from the actual enabled prompts (e.g. a
// prompt was added from the editor while this entry was closed).
function _initialText() {
  const raw = _node?.raw_text || '';
  if (!raw) return _buildText();
  const rawSet = new Set(
    raw.split(/\r?\n/).flatMap(l => l.split(_delim()))
       .map(s => s.trim()).filter(Boolean)
       .map(s => window.plv2.cleanPrompt(_parsePromptPart(s).content)).filter(Boolean));
  const enabledSet = new Set([
    ..._prompts.filter(p => p.enabled).map(p => String(p.content).trim()),
    ..._tplPrompts.filter(p => p.enabled).map(p => String(p.content).trim()),
  ]);
  const matches = rawSet.size === enabledSet.size && [...enabledSet].every(c => rawSet.has(c));
  return matches ? raw : _buildText();
}

// ─── Format auto-detect (feature d) ───────────────────────────────────────────

/** Longest common prefix + suffix across all prompt contents → "<prefix>{p}<suffix>". */
function _detectCommonFormat() {
  const contents = _prompts.map(p => String(p.content)).filter(c => c.length);
  if (!contents.length) return { format: '{p}', prefix: '', suffix: '' };

  let prefix = contents[0];
  for (const c of contents) {
    let i = 0;
    while (i < prefix.length && i < c.length && prefix[i] === c[i]) i++;
    prefix = prefix.slice(0, i);
    if (!prefix) break;
  }
  let suffix = contents[0];
  for (const c of contents) {
    let i = 0;
    while (i < suffix.length && i < c.length &&
           suffix[suffix.length - 1 - i] === c[c.length - 1 - i]) i++;
    suffix = suffix.slice(suffix.length - i);
    if (!suffix) break;
  }
  // Keep at least one char of {p} for the shortest content (no prefix/suffix overlap).
  const minLen = Math.min(...contents.map(c => c.length));
  while (prefix.length + suffix.length >= minLen && (prefix.length || suffix.length)) {
    if (suffix.length >= prefix.length) suffix = suffix.slice(1);
    else prefix = prefix.slice(0, -1);
  }
  return { format: `${prefix}{p}${suffix}`, prefix, suffix };
}

/** Split a format string into the literal text before/after the {p}|{prompt} token. */
function _splitFormat(fmt) {
  const m = String(fmt).match(/^([\s\S]*?)\{(?:p|prompt)\}([\s\S]*)$/);
  if (!m) return null;
  return { prefix: m[1], suffix: m[2] };
}

function _openFormatDetect(fmtIn) {
  const detected = _detectCommonFormat();

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;';
  const box = document.createElement('div');
  box.style.cssText = 'background:#1e1e2e;border:1px solid #45475a;border-radius:8px;padding:16px;min-width:380px;max-width:520px;display:flex;flex-direction:column;gap:10px;box-shadow:0 8px 32px rgba(0,0,0,0.5);';

  box.appendChild(_span('Detected common format', 'font-weight:600;font-size:13px;color:#cba6f7;'));
  box.appendChild(_span('Apply sets this as the entry format and strips it from every prompt. Use {p} as the placeholder.',
    'font-size:11px;color:#6c7086;line-height:1.4;'));

  const input = document.createElement('input');
  input.type = 'text';
  input.value = detected.format;
  input.style.cssText = 'background:#313244;border:1px solid #45475a;border-radius:4px;color:#cdd6f4;font-size:12px;padding:6px 8px;font-family:"Fira Code",Consolas,monospace;';
  box.appendChild(input);

  const preview = _span('', 'font-size:11px;color:#a6adc8;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto;');
  box.appendChild(preview);

  const refreshPreview = () => {
    const split = _splitFormat(input.value);
    if (!split) { preview.textContent = '⚠ format must contain {p} or {prompt}'; preview.style.color = '#f9e2af'; return; }
    preview.style.color = '#a6adc8';
    const affected = _prompts.filter(p => {
      const c = String(p.content);
      return c.startsWith(split.prefix) && c.endsWith(split.suffix) &&
             c.length > split.prefix.length + split.suffix.length;
    });
    preview.textContent = `${affected.length}/${_prompts.length} prompts will be stripped.`;
  };
  input.addEventListener('input', refreshPreview);
  refreshPreview();

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:4px;';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  Object.assign(cancelBtn.style, { background:'#313244',border:'1px solid #45475a',borderRadius:'4px',color:'#cdd6f4',cursor:'pointer',padding:'5px 14px',fontSize:'12px' });
  cancelBtn.addEventListener('click', () => overlay.remove());
  const applyBtn = document.createElement('button');
  applyBtn.textContent = 'Apply';
  Object.assign(applyBtn.style, { background:'#a6e3a1',border:'none',borderRadius:'4px',color:'#1e1e2e',cursor:'pointer',padding:'5px 14px',fontSize:'12px',fontWeight:'600' });
  applyBtn.addEventListener('click', () => _applyDetectedFormat(input.value, fmtIn, overlay));
  btnRow.append(cancelBtn, applyBtn);
  box.appendChild(btnRow);

  overlay.appendChild(box);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  input.focus(); input.select();
}

async function _applyDetectedFormat(fmt, fmtIn, overlay) {
  const split = _splitFormat(fmt);
  if (!split) return;
  overlay.querySelectorAll('button').forEach(b => { b.disabled = true; });

  const { prefix, suffix } = split;
  const ops = [];
  for (const p of _prompts) {
    const c = String(p.content);
    if (c.startsWith(prefix) && c.endsWith(suffix) && c.length > prefix.length + suffix.length) {
      const stripped = c.slice(prefix.length, c.length - suffix.length);
      p.content = stripped;
      ops.push(_api().updatePrompt(p.id, { content: stripped }));
    }
  }
  ops.push(_api().updateNode(_node.id, { format: fmt }));
  await Promise.all(ops);
  _node.format = fmt;
  if (fmtIn) fmtIn.value = fmt;
  overlay.remove();
  _syncListToText();
  _renderListBody();
  _notifyEditorIfReferenced();
}

// ─── Move / create sub-entry from a text selection (feature c) ─────────────────

async function _createSubentryFromSelection(selText, start, end) {
  const name = await window.plv2.inlinePrompt('New sub-entry — name:');
  if (!name || !name.trim()) return;
  const clean = name.trim();
  if (/[.,|/\\[\]]/.test(clean)) { alert('Sub-entry name must not contain . , | / \\ [ ]'); return; }
  let created;
  try {
    const r = await _api().createNode({
      name: clean, has_prompts: true, parent_id: _node.id, pos_neg: _node.pos_neg ?? 'positive',
    });
    if (r?.error) { console.error('[PLv2]', r.error); alert(r.error.message || 'Create failed.'); return; }
    created = r?.node;
  } catch (err) { console.error('[PLv2]', err); return; }
  if (created) await _moveSelectionToSubentry(created, selText, start, end);
}

async function _moveSelectionToSubentry(child, selText, start, end) {
  // 1) Parse the selection into prompt parts and append them to the sub-entry.
  const parts = selText.split(_delim()).map(s => s.trim()).filter(Boolean).map(_parsePromptPart);
  const moved = [];
  let order = 0;
  try {
    const existing = (await _api().getPrompts(child.id))?.prompts ?? [];
    order = Math.max(-1, ...existing.map(p => p.order_index ?? -1)) + 1;
  } catch {}
  for (const part of parts) {
    const content = window.plv2.cleanPrompt(part.content);
    if (!content) continue;
    moved.push(content);
    try { await _api().createPrompt(child.id, { content, enabled: true, weight: part.weight ?? 1.0, order_index: order++ }); }
    catch (err) { console.error('[PLv2]', err); }
  }

  // 2) Replace the selection with a [this.<rel>] self-ref. Remove the selection
  //    first, then re-insert at the join via the shared smart-insert so delimiters
  //    around the ref are recomputed (no doubled/missing comma where text was).
  const rel = (child.full_path && _node.full_path && child.full_path.startsWith(_node.full_path + '.'))
    ? child.full_path.slice(_node.full_path.length + 1) : child.name;
  const D = _delim();
  const joined = _promptTextarea.value.slice(0, start) + _promptTextarea.value.slice(end);
  const plan = window.plv2.insert.plan(joined, start);
  const newText = window.plv2.insert.assemble(plan, `[this.${rel}]`, D, D).value;

  // 3) Delete the moved prompts from THIS entry — but only those no longer present
  //    in the remaining text (handles duplicates that the user did not select).
  const remaining = new Set(newText.split(_delim()).map(s => _parsePromptPart(s).content));
  const movedSet = new Set(moved);
  const dels = [];
  for (const p of [..._prompts]) {
    const c = String(p.content).trim();
    if (movedSet.has(c) && !remaining.has(c)) {
      dels.push(_api().deletePrompt(p.id).catch(err => console.error('[PLv2]', err)));
      _prompts = _prompts.filter(q => q.id !== p.id);
    }
  }
  await Promise.all(dels);

  // 4) Apply the new text + reconcile + refresh children/sub-entry panel.
  _promptTextarea.value = newText;
  await _syncTextToList();
  await _loadData();
  _render();
  window.plv2Tree?.reload?.();
}

function _isReferencedByEditor() {
  const data = window.plv2Editor?.getPreviewData?.();
  if (!data || !_node) return false;
  const templates = [data.pos, data.neg].filter(Boolean);
  if (!templates.length) return false;
  const refs = new Set();
  if (_node.full_path) refs.add(_node.full_path);
  if (_node.auto_trigger) refs.add(_node.auto_trigger);
  if (_node.name) refs.add(_node.name);
  for (const t of _triggers) { if (t.trigger_text) refs.add(t.trigger_text); }
  for (const ref of refs) {
    for (const tpl of templates) {
      if (tpl.includes(`[${ref}]`) || tpl.includes(`[${ref}.`)) return true;
    }
  }
  return false;
}

function _notifyEditorIfReferenced() {
  if (_isReferencedByEditor()) {
    document.dispatchEvent(new CustomEvent('plv2:editor-changed', { detail: { immediate: true } }));
  }
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
  _notifyEditorIfReferenced();
}

// ─── Render ───────────────────────────────────────────────────────────────────

function _render() {
  if (!_detail) return;
  clearTimeout(_previewHideTimer); _previewHideTimer = null;
  if (_previewPop) { _previewPop.remove(); _previewPop = null; }
  _detail.innerHTML = '';
  _detail.style.cssText = 'flex:1;min-width:280px;display:flex;flex-direction:column;background:#181825;overflow:hidden;font-size:12px;color:#cdd6f4;font-family:ui-sans-serif,system-ui,sans-serif;';

  // A _template entry is a stripped-down format tool: always positive, no
  // trigger/delimiter/format/shuffle/random UI (#5).
  const isTpl = _node.name === '_template';

  // ── Row 1: header ──
  const hdr = _row('6px 12px');
  _backBtn = _iconBtn('←', 'Go back', _goBack);
  if (!_history.length) { _backBtn.disabled = true; _backBtn.style.opacity = '0.35'; }
  // Header title shows the entry's full path (#1).
  _titleEl = _span(_node.full_path || _node.name,
    'flex:1;font-weight:600;font-size:13px;color:#cba6f7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;');
  _titleEl.title = _node.full_path || _node.name;
  const closeBtn = _iconBtn('×', 'Close', closeDetail, { fontSize: '17px' });
  hdr.append(_backBtn, _titleEl, closeBtn);

  // ── Row 2: name + pos/neg + insert ──
  const nameRow = _row('4px 12px');
  nameRow.style.gap = '6px';
  nameRow.style.flexWrap = 'wrap';

  _nameInput = document.createElement('input');
  _nameInput.value = isTpl ? 'template' : _node.name;
  _nameInput.style.cssText = 'flex:1;min-width:80px;background:#313244;border:1px solid #45475a;border-radius:4px;color:#cdd6f4;font-size:12px;padding:3px 7px;';
  if (isTpl) { _nameInput.readOnly = true; _nameInput.style.opacity = '0.7'; _nameInput.style.cursor = 'default'; }
  else _nameInput.addEventListener('change', _saveName);

  const isPos = (_node.pos_neg ?? 'positive') === 'positive';
  const badge = document.createElement('button');
  badge.textContent = isTpl ? 'positive (locked)' : (isPos ? 'positive' : 'negative');
  Object.assign(badge.style, {
    padding: '2px 10px', border: '1px solid', borderRadius: '10px',
    cursor: isTpl ? 'default' : 'pointer',
    fontSize: '11px', fontWeight: '600', background: 'none',
    color: isPos ? '#a6e3a1' : '#f38ba8',
    borderColor: isPos ? '#a6e3a1' : '#f38ba8',
  });
  if (!isTpl) badge.addEventListener('click', async () => {
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
  Object.assign(fmtIn.style, {
    background: '#313244', border: '1px solid #45475a', borderRadius: '3px',
    color: '#cdd6f4', fontSize: '11px', padding: '2px 6px', width: '140px', cursor: 'text',
  });
  // Suggest formats from other entries first, then the shared common-formats.
  const fmtSuggestions = [...new Set([
    ..._entryFormats,
    ..._formats.map(f => typeof f === 'string' ? f : f.format),
  ].filter(Boolean))];
  const _saveFmt = () => _api().updateNode(_node.id, { format: fmtIn.value })
    .then(() => { _node.format = fmtIn.value; _notifyEditorIfReferenced(); });
  fmtIn.addEventListener('change', _saveFmt);
  _attachAutocomplete(fmtIn, fmtSuggestions, _saveFmt);   // custom themed dropdown (#1)
  const fmtDetect = document.createElement('button');
  fmtDetect.textContent = '⌖ auto';
  fmtDetect.title = 'Auto-detect the common format across all prompts';
  Object.assign(fmtDetect.style, {
    background: '#313244', border: '1px solid #45475a', borderRadius: '3px',
    color: '#a6adc8', fontSize: '11px', padding: '2px 7px', cursor: 'pointer', flexShrink: '0',
  });
  fmtDetect.addEventListener('mouseenter', () => { fmtDetect.style.borderColor = '#cba6f7'; fmtDetect.style.color = '#cba6f7'; });
  fmtDetect.addEventListener('mouseleave', () => { fmtDetect.style.borderColor = '#45475a'; fmtDetect.style.color = '#a6adc8'; });
  fmtDetect.addEventListener('click', () => _openFormatDetect(fmtIn));
  fmtGrp.append(fmtIn, fmtDetect);

  const shuffleGrp = _labelGrp('Shuffle');
  const shuffleChk = document.createElement('input');
  shuffleChk.type = 'checkbox'; shuffleChk.checked = !!_node.shuffle;
  shuffleChk.style.cssText = 'cursor:pointer;accent-color:#cba6f7;margin:0;';
  shuffleChk.addEventListener('change', () => _api().updateNode(_node.id, { shuffle: shuffleChk.checked }).then(() => { _node.shuffle = shuffleChk.checked; _notifyEditorIfReferenced(); }));
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
  const savedTextH = parseInt(localStorage.getItem('plv2_entry_textHeight') || '', 10);
  const textH = (savedTextH >= 60 && savedTextH <= 600) ? savedTextH : 150;
  textSection.style.cssText = `padding:6px 12px;display:flex;flex-direction:column;height:${textH}px;flex-shrink:0;border-top:1px solid #313244;position:relative;`;
  _promptTextarea = document.createElement('textarea');
  _promptTextarea.value = _initialText();
  Object.assign(_promptTextarea.style, {
    flex: '1', background: '#313244', border: '1px solid #45475a', borderRadius: '4px',
    color: '#cdd6f4', fontSize: '12px', lineHeight: '1.5', padding: '6px 8px',
    resize: 'none', boxSizing: 'border-box', overflowY: 'auto',
    fontFamily: '"Fira Code","Cascadia Code",Consolas,monospace',
    scrollbarWidth: 'thin', scrollbarColor: '#45475a transparent',
  });
  _promptTextarea.setAttribute('spellcheck', 'false');
  _promptTextarea.placeholder = 'Active prompts joined by delimiter…';
  // Entry text view = related-capable (req #1), uses entry's own delimiter.
  // getThisRefs feeds [this.<subentry>] autocomplete into the shared tag dropdown —
  // entry text box ONLY (#3): own + inherited template sub-entries.
  window.xyzTagAC?.attach(_promptTextarea, {
    related: true,
    getDelimiter: () => _delim(),
    getThisRefs: () => [..._children.map(c => c.name), ..._tplChildren.map(c => c.name)],
  });
  _promptTextarea.addEventListener('blur', () => {
    clearTimeout(_blurTimer);
    _blurTimer = setTimeout(_syncTextToList, 80);
  });
  // Adding/removing a line break is a structural layout change — sync promptly so
  // the (snapped) preview window reflects it without waiting for blur (#3). Plain
  // content typing stays blur-only to avoid creating half-typed prompts.
  _nlCount = (_promptTextarea.value.match(/\n/g) || []).length;
  _promptTextarea.addEventListener('input', () => {
    const nl = (_promptTextarea.value.match(/\n/g) || []).length;
    if (nl === _nlCount) return;
    _nlCount = nl;
    clearTimeout(_blurTimer);
    _blurTimer = setTimeout(_syncTextToList, 250);
  });
  // Right-click a selection → move/create a sub-entry (feature c).
  _promptTextarea.addEventListener('contextmenu', (e) => {
    const start = _promptTextarea.selectionStart, end = _promptTextarea.selectionEnd;
    if (end <= start) return;                       // no selection → native menu
    e.preventDefault();
    const selText = _promptTextarea.value.slice(start, end);
    const subItems = _children.map(c => ({
      label: c.name, action: () => _moveSelectionToSubentry(c, selText, start, end),
    }));
    if (subItems.length) subItems.push({ separator: true });
    subItems.push({ label: '＋ New sub-entry…', action: () => _createSubentryFromSelection(selText, start, end) });
    window.plv2.showContextMenu(e.clientX, e.clientY, [
      { label: 'Move to sub-entry', submenu: subItems },
      { label: 'Create sub-entry from selection…', action: () => _createSubentryFromSelection(selText, start, end) },
    ]);
  });
  textSection.appendChild(_promptTextarea);

  // ── Hover icon → floating fully-resolved preview of THIS entry (feature #2) ──
  const previewIcon = document.createElement('div');
  previewIcon.textContent = '⦿';
  // No `title` — a native tooltip would cover the resolved-preview popup (#4).
  previewIcon.style.cssText = 'position:absolute;top:11px;right:18px;z-index:5;width:18px;height:18px;display:flex;align-items:center;justify-content:center;border-radius:4px;background:#313244;color:#a6adc8;font-size:11px;cursor:help;opacity:0.55;transition:opacity .12s;';
  // Keep the popup alive while the mouse is over EITHER the icon or the popup, so
  // its scrollbar is reachable; hide after a short grace period otherwise.
  const _pvCancelHide = () => { clearTimeout(_previewHideTimer); _previewHideTimer = null; };
  const _pvScheduleHide = () => {
    clearTimeout(_previewHideTimer);
    _previewHideTimer = setTimeout(() => {
      previewIcon.style.opacity = '0.55';
      if (_previewPop) { _previewPop.remove(); _previewPop = null; }
    }, 220);
  };
  previewIcon.addEventListener('mouseenter', async () => {
    _pvCancelHide();
    previewIcon.style.opacity = '1';
    if (_previewPop) return;                          // already open
    const pop = document.createElement('div');
    _previewPop = pop;
    pop.style.cssText = 'position:fixed;z-index:100001;min-width:160px;max-width:420px;max-height:320px;overflow:auto;background:#11111b;border:1px solid #585b70;border-radius:6px;padding:8px 10px;font-size:11px;line-height:1.55;color:#cdd6f4;white-space:pre-wrap;word-break:break-word;box-shadow:0 6px 24px rgba(0,0,0,0.55);scrollbar-width:thin;';
    pop.textContent = 'Resolving…';
    pop.addEventListener('mouseenter', _pvCancelHide);
    pop.addEventListener('mouseleave', _pvScheduleHide);
    document.body.appendChild(pop);
    const r = previewIcon.getBoundingClientRect();
    const place = () => {
      pop.style.top = (r.bottom + 4) + 'px';
      pop.style.left = Math.max(8, r.right - pop.offsetWidth) + 'px';
    };
    place();
    try {
      // Fully resolve THIS entry, expanding any [refs] it contains (feature #2).
      const ref = _node.full_path ? `[${_node.full_path}]` : '';
      const res = ref ? await _api().resolveTemplate(ref, 0) : await _api().previewNode(_node.id, 0);
      if (_previewPop === pop) { pop.textContent = res?.text || '(empty)'; place(); }
    } catch { if (_previewPop === pop) { pop.textContent = '(could not resolve)'; place(); } }
  });
  previewIcon.addEventListener('mouseleave', _pvScheduleHide);
  textSection.appendChild(previewIcon);

  // ── Drag handle: resize the text section vertically (feature b) ──
  const dragHandle = document.createElement('div');
  dragHandle.style.cssText = 'height:7px;flex-shrink:0;cursor:ns-resize;background:#1e1e2e;border-top:1px solid #313244;position:relative;';
  const grip = document.createElement('div');
  grip.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:34px;height:2px;border-radius:2px;background:#585b70;';
  dragHandle.appendChild(grip);
  dragHandle.addEventListener('mouseenter', () => { grip.style.background = '#cba6f7'; });
  dragHandle.addEventListener('mouseleave', () => { grip.style.background = '#585b70'; });
  dragHandle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = textSection.offsetHeight;
    grip.style.background = '#cba6f7';
    const onMove = (ev) => {
      const h = Math.min(600, Math.max(60, startH + (ev.clientY - startY)));
      textSection.style.height = h + 'px';
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      localStorage.setItem('plv2_entry_textHeight', String(textSection.offsetHeight));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // ── Stacked, independently collapsible panels: Prompts on top, Sub Entries
  //    below (#6 — no more left/right tab switching). ──
  const panelArea = document.createElement('div');
  panelArea.style.cssText = 'flex:1;overflow:hidden;display:flex;flex-direction:column;min-height:0;';
  _promptsPanel = _buildPromptsPanel();
  _subPanel     = _buildSubPanel();

  // Draggable divider between the two panels; split persists; collapsing either
  // gives the other all the space (#1).
  const panelDivider = document.createElement('div');
  panelDivider.style.cssText = 'height:7px;flex-shrink:0;cursor:ns-resize;background:#1e1e2e;border-top:1px solid #313244;border-bottom:1px solid #313244;position:relative;';
  const pdGrip = document.createElement('div');
  pdGrip.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:34px;height:2px;border-radius:2px;background:#585b70;';
  panelDivider.appendChild(pdGrip);
  panelDivider.addEventListener('mouseenter', () => { pdGrip.style.background = '#cba6f7'; });
  panelDivider.addEventListener('mouseleave', () => { pdGrip.style.background = '#585b70'; });

  const applySplit = () => {
    const pOpen = promptsSection.__isOpen(), sOpen = subSection.__isOpen();
    if (pOpen && sOpen) {
      promptsSection.style.flex = `${_panelRatio} 1 0`;
      subSection.style.flex     = `${1 - _panelRatio} 1 0`;
      panelDivider.style.display = 'block';
    } else {
      promptsSection.style.flex = pOpen ? '1 1 0' : '0 0 auto';
      subSection.style.flex     = sOpen ? '1 1 0' : '0 0 auto';
      panelDivider.style.display = 'none';
    }
  };
  panelDivider.addEventListener('mousedown', (e) => {
    e.preventDefault();
    pdGrip.style.background = '#cba6f7';
    const rect = panelArea.getBoundingClientRect();
    const onMove = (ev) => {
      _panelRatio = Math.min(0.85, Math.max(0.15, (ev.clientY - rect.top) / rect.height));
      promptsSection.style.flex = `${_panelRatio} 1 0`;
      subSection.style.flex     = `${1 - _panelRatio} 1 0`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      localStorage.setItem('plv2_panel_ratio', String(_panelRatio));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  const promptsSection = _collapsibleSection('Prompts', _promptsPanel, 'plv2_sec_prompts', () => applySplit());
  const subSection     = _collapsibleSection('Sub Entries', _subPanel, 'plv2_sec_subs', () => applySplit());
  panelArea.append(promptsSection, panelDivider, subSection);
  applySplit();

  // Assemble — template entries drop the trigger/config/mode rows (#5).
  const rows = [hdr, nameRow];
  if (!isTpl) rows.push(insertRow, cfgRow, modeRow);
  rows.push(textSection, dragHandle, panelArea);
  _detail.append(...rows);
}

// A header bar that collapses/expands its body; state persisted in localStorage.
// Flex sizing is owned by the caller's applySplit() (#1); we only toggle visibility.
function _collapsibleSection(title, body, key, onToggle, defaultOpen = true) {
  const saved = localStorage.getItem(key);
  let open = saved === null ? defaultOpen : saved === '1';

  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;min-height:0;border-top:1px solid #313244;overflow:hidden;';
  const header = document.createElement('div');
  header.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px 12px;cursor:pointer;background:#1e1e2e;flex-shrink:0;user-select:none;';
  const caret = _span('▼', 'font-size:9px;color:#6c7086;flex-shrink:0;');
  header.append(caret, _span(title, 'font-size:11px;font-weight:600;color:#a6adc8;flex:1;'));

  const apply = () => { caret.textContent = open ? '▼' : '▶'; body.style.display = open ? 'flex' : 'none'; };
  header.addEventListener('click', () => { open = !open; localStorage.setItem(key, open ? '1' : '0'); apply(); onToggle?.(); });
  wrap.append(header, body);
  wrap.__isOpen = () => open;
  apply();
  return wrap;
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
    await _deleteTriggerWithUsageCheck(t);
  });

  pill.append(lbl, del);
  return pill;
}

async function _deleteTriggerWithUsageCheck(t) {
  const autoTrigger = _triggers.find(x => x.is_auto)?.trigger_text ?? _node.full_path;
  const triggerText = t.trigger_text;

  // Gather usages
  const usages = [];

  // 1) Library prompts
  try {
    const u = await _api().getUsages(_node.id);
    if (u?.usages) {
      for (const item of u.usages) {
        if (item.matched_ref === triggerText || item.matched_ref.startsWith(triggerText + '.')) {
          usages.push({ source: item.entry_full_path, ref: item.matched_ref, snippet: item.content_snippet });
        }
      }
    }
  } catch {}

  // 2) Text editor
  try {
    const data = window.plv2Editor?.getPreviewData?.();
    const templates = [data?.pos, data?.neg].filter(Boolean);
    const re = new RegExp(`\\[${triggerText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.[^\\]]+)?\\]`, 'g');
    for (const tpl of templates) {
      for (const m of tpl.matchAll(re)) {
        usages.push({ source: 'Text Editor', ref: m[0].slice(1, -1), snippet: tpl.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20) });
      }
    }
  } catch {}

  // 3) Workflow nodes
  try {
    const types = ['XYZ Prompt Library V2 Positive', 'XYZ Prompt Library V2 Negative'];
    const re = new RegExp(`\\[${triggerText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.[^\\]]+)?\\]`, 'g');
    for (const gn of (app.graph?._nodes ?? [])) {
      if (!types.includes(gn.comfyClass)) continue;
      const w = gn.widgets?.find(x => x.name === 'prompt_template');
      if (!w?.value) continue;
      for (const m of w.value.matchAll(re)) {
        usages.push({ source: `Node ${gn.id} (${gn.title || gn.comfyClass})`, ref: m[0].slice(1, -1), snippet: w.value.slice(Math.max(0, m.index - 20), m.index + m[0].length + 20) });
      }
    }
  } catch {}

  // Deduplicate by source+ref
  const seen = new Set();
  const unique = usages.filter(u => { const k = u.source + '|' + u.ref; if (seen.has(k)) return false; seen.add(k); return true; });

  if (unique.length === 0) {
    // No usages — delete immediately
    await _api().deleteTrigger(t.id);
    _triggers = _triggers.filter(x => x.id !== t.id);
    _renderInsertRow();
    return;
  }

  // Show dialog
  _showTriggerDeleteDialog(t, triggerText, autoTrigger, unique);
}

function _showTriggerDeleteDialog(t, triggerText, autoTrigger, usages) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;';
  const box = document.createElement('div');
  box.style.cssText = 'background:#1e1e2e;border:1px solid #45475a;border-radius:8px;padding:16px;min-width:420px;max-width:560px;max-height:75vh;display:flex;flex-direction:column;gap:10px;box-shadow:0 8px 32px rgba(0,0,0,0.5);';

  const title = document.createElement('div');
  title.style.cssText = 'font-size:14px;font-weight:600;color:#cdd6f4;';
  title.innerHTML = `Delete custom trigger "<b style="color:#f38ba8">${triggerText}</b>" ?`;

  const body = document.createElement('div');
  body.style.cssText = 'font-size:12px;color:#a6adc8;line-height:1.5;overflow-y:auto;max-height:250px;';
  body.innerHTML = `<div style="color:#f38ba8;margin-bottom:6px;">⚠ This trigger is referenced in ${usages.length} place(s):</div>`;

  const maxShow = 6;
  for (const u of usages.slice(0, maxShow)) {
    const item = document.createElement('div');
    item.style.cssText = 'margin-bottom:3px;padding:3px 8px;background:#1a1426;border:1px solid #313244;border-radius:3px;font-size:11px;';
    item.innerHTML = `<span style="color:#cba6f7">${u.source}</span>  <span style="color:#6c7086">[${u.ref}]</span>`;
    body.appendChild(item);
  }
  if (usages.length > maxShow) {
    const more = document.createElement('div');
    more.style.cssText = 'color:#6c7086;font-size:11px;padding:2px 8px;';
    more.textContent = `… and ${usages.length - maxShow} more`;
    body.appendChild(more);
  }

  const question = document.createElement('div');
  question.style.cssText = 'color:#cdd6f4;font-size:12px;margin-top:4px;';
  question.textContent = 'What should happen to these references?';

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:4px;';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = 'Cancel';
  Object.assign(cancelBtn.style, { background:'#313244',border:'1px solid #45475a',borderRadius:'4px',color:'#cdd6f4',cursor:'pointer',padding:'5px 14px',fontSize:'12px' });
  cancelBtn.addEventListener('click', () => overlay.remove());

  const removeBtn = document.createElement('button');
  removeBtn.textContent = `🗑 Remove all & delete trigger`;
  Object.assign(removeBtn.style, { background:'#f38ba8',border:'none',borderRadius:'4px',color:'#1e1e2e',cursor:'pointer',padding:'5px 14px',fontSize:'12px',fontWeight:'600' });
  removeBtn.addEventListener('click', () => _executeTriggerDelete(t, triggerText, null, usages, overlay));

  const replaceBtn = document.createElement('button');
  replaceBtn.textContent = `Replace → [${autoTrigger}] & delete`;
  Object.assign(replaceBtn.style, { background:'#a6e3a1',border:'none',borderRadius:'4px',color:'#1e1e2e',cursor:'pointer',padding:'5px 14px',fontSize:'12px',fontWeight:'600' });
  replaceBtn.addEventListener('click', () => _executeTriggerDelete(t, triggerText, autoTrigger, usages, overlay));

  btnRow.append(cancelBtn, removeBtn, replaceBtn);
  box.append(title, body, question, btnRow);
  overlay.appendChild(box);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

async function _executeTriggerDelete(t, oldTrigger, newTrigger, usages, overlay) {
  overlay.querySelectorAll('button').forEach(b => { b.disabled = true; b.textContent = '…'; });

  try {
    if (newTrigger) {
      // Replace: [oldTrigger] → [newTrigger], [oldTrigger.sub] → [newTrigger.sub]
      await _api().replaceRefs(_node.id, { replacements: [{ old: oldTrigger, new: newTrigger }] });
      _updateWorkflowRefs([{ old: oldTrigger, new: newTrigger }]);
    } else {
      // Remove: strip [oldTrigger] and [oldTrigger.sub] from library + workflow
      await _api().stripRefs(_node.id, { refs: [oldTrigger] });
      _stripWorkflowRefs([oldTrigger]);
    }
  } catch(e) { console.error('[PLv2] trigger delete cleanup failed', e); }

  // Delete the trigger
  await _api().deleteTrigger(t.id);
  _triggers = _triggers.filter(x => x.id !== t.id);
  _renderInsertRow();

  // Update editor/preview
  document.dispatchEvent(new CustomEvent('plv2:editor-changed', { detail: { immediate: true } }));

  overlay.remove();
}

function _stripWorkflowRefs(refs) {
  if (!app?.graph) return;
  const types = ['XYZ Prompt Library V2 Positive', 'XYZ Prompt Library V2 Negative'];
  for (const gn of (app.graph?._nodes ?? [])) {
    if (!types.includes(gn.comfyClass)) continue;
    const w = gn.widgets?.find(x => x.name === 'prompt_template');
    if (!w) continue;
    let v = w.value;
    let changed = false;
    for (const ref of refs) {
      const re = new RegExp(`\\[${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\.[^\\]]+)?\\]`, 'g');
      const before = v;
      v = v.replace(re, '');
      if (v !== before) {
        v = v.replace(/,\s*,/g, ', ').replace(/\|\s*\|/g, '|').replace(/^\s*[,|]\s*/, '').replace(/\s*[,|]\s*$/, '').trim();
        changed = true;
      }
    }
    if (changed) {
      w.value = v;
      if (w.inputEl && w.inputEl.value !== v) w.inputEl.value = v;
      gn.onWidgetChanged?.(w.name, v, v, w);
      app.graph.setDirtyCanvas(true, true);
      document.dispatchEvent(new CustomEvent('plv2:node-edited', { detail: { nodeId: gn.id, value: v } }));
    }
  }
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

  toolbar.append(layoutBtn);

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
        _notifyEditorIfReferenced();
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
      _notifyEditorIfReferenced();
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

    // Drag-and-drop reorder for compact mode — caret indicator between chips
    const caret = document.createElement('div');
    caret.style.cssText = 'display:none;position:absolute;width:2px;height:24px;background:#cba6f7;border-radius:1px;pointer-events:none;z-index:10;';
    wrap.style.position = 'relative';
    wrap.appendChild(caret);

    let _dragTgtIdx = -1;
    wrap.addEventListener('dragover', e => {
      e.preventDefault();
      const chip = e.target.closest('.plv2-chip');
      if (!chip || !chip.dataset.promptId) { caret.style.display = 'none'; return; }
      const targetId = parseInt(chip.dataset.promptId);
      if (targetId === _dragSrcId) { caret.style.display = 'none'; return; }
      const enabled = _sortedPrompts().filter(p => p.enabled);   // merged own + template
      const chipIdx = enabled.findIndex(p => p.id === targetId);
      if (chipIdx < 0) { caret.style.display = 'none'; return; }

      // Determine insertion side based on cursor position relative to chip center
      const rect = chip.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const insertBefore = e.clientX < midX;
      _dragTgtIdx = insertBefore ? chipIdx : chipIdx + 1;
      // Clamp to enabled range
      if (_dragTgtIdx < 0) _dragTgtIdx = 0;
      if (_dragTgtIdx > enabled.length) _dragTgtIdx = enabled.length;

      // Position caret
      caret.style.display = 'block';
      const wrapRect = wrap.getBoundingClientRect();
      if (_dragTgtIdx >= enabled.length) {
        // After last enabled chip
        const lastChip = wrap.querySelectorAll('.plv2-chip[data-prompt-id]');
        const lastEnabled = [...lastChip].filter(c => {
          const pid = parseInt(c.dataset.promptId);
          return enabled.some(p => p.id === pid);
        }).pop();
        if (lastEnabled) {
          const lr = lastEnabled.getBoundingClientRect();
          caret.style.left = (lr.right - wrapRect.left + 3) + 'px';
          caret.style.top = (lr.top - wrapRect.top) + 'px';
        }
      } else {
        const targetChip = [...wrap.querySelectorAll('.plv2-chip[data-prompt-id]')].find(c => parseInt(c.dataset.promptId) === enabled[_dragTgtIdx]?.id);
        if (targetChip) {
          const tr = targetChip.getBoundingClientRect();
          if (insertBefore) {
            caret.style.left = (tr.left - wrapRect.left - 3) + 'px';
          } else {
            caret.style.left = (tr.right - wrapRect.left + 3) + 'px';
          }
          caret.style.top = (tr.top - wrapRect.top) + 'px';
        }
      }
    });
    wrap.addEventListener('dragleave', () => {
      caret.style.display = 'none';
      _dragTgtIdx = -1;
    });
    wrap.addEventListener('drop', async e => {
      e.preventDefault();
      caret.style.display = 'none';
      if (!_dragSrcId || _dragTgtIdx < 0) { _dragSrcId = null; _dragTgtIdx = -1; return; }

      const enabled = _sortedPrompts().filter(p => p.enabled);   // merged own + template
      const srcIdx = enabled.findIndex(p => p.id === _dragSrcId);
      if (srcIdx < 0) { _dragSrcId = null; _dragTgtIdx = -1; return; }

      // Adjust target if source was before target
      let tgt = _dragTgtIdx;
      if (srcIdx < tgt) tgt--;

      if (srcIdx !== tgt) {
        const [moved] = enabled.splice(srcIdx, 1);
        enabled.splice(tgt, 0, moved);
        await _renumberFrom(enabled);     // reassign unified order_index (own + template)
        _syncListToText();
        _renderListBody();
        _notifyEditorIfReferenced();
      }
      _dragSrcId = null;
      _dragTgtIdx = -1;
    });

    for (const p of sorted) wrap.appendChild(_compactChip(p));
    _listBody.appendChild(wrap);
  }
}

function _sortedPrompts() {
  // Merge own prompts with inherited template prompts (tagged __tpl). Order:
  //   enabled (own by text order, then inherited by template order)
  //   → local disabled (alpha) → template-inherited disabled (alpha).
  // `enabled` is a MIX of 1/0 (server) and true/false (in-memory); normalise to bool.
  const all = [
    ..._prompts.map(p => ({ ...p, __tpl: false })),
    ..._tplPrompts.map(p => ({ ...p, __tpl: true })),
  ];
  all.sort((a, b) => {
    const ea = !!a.enabled, eb = !!b.enabled;
    if (ea !== eb) return ea ? -1 : 1;                                 // enabled first
    if (ea) return (a.order_index ?? 1e9) - (b.order_index ?? 1e9);    // enabled → unified text order
    if (a.__tpl !== b.__tpl) return a.__tpl ? 1 : -1;                  // disabled: own before inherited
    return String(a.content).localeCompare(String(b.content));        // disabled → alphabetical
  });
  return all;
}

// Reassign sequential order_index (0..N) to a given ordered list of prompts,
// persisting own via updatePrompt and template via setOverride. Unifies the two
// order scales so own + inherited interleave cleanly (#2).
async function _renumberFrom(ordered) {
  const ops = [];
  ordered.forEach((p, i) => {
    if (p.__tpl) {
      const tp = _tplPrompts.find(q => q.id === p.id);
      if (tp && tp.order_index !== i) { tp.order_index = i; ops.push(_api().setOverride(_node.id, p.id, { order_index: i })); }
    } else {
      const real = _prompts.find(q => q.id === p.id);
      if (real && real.order_index !== i) { real.order_index = i; ops.push(_api().updatePrompt(p.id, { order_index: i })); }
    }
  });
  await Promise.all(ops);
}
const _renumberEnabled = () => _renumberFrom(_sortedPrompts().filter(p => p.enabled));

// Enable/disable a prompt. Both own and inherited prompts live in the text box
// (unified order); template prompts persist enable/order via a per-entry override.
// After the flag flips we renumber ALL enabled prompts so order_index stays a clean
// 0..N sequence (fixes messy interleaving when enabling a template prompt, #2).
async function _setPromptEnabled(p, enabled) {
  if (p.__tpl) {
    const tp = _tplPrompts.find(q => q.id === p.id);
    if (!tp) return;
    tp.enabled = enabled;
    if (enabled) tp.order_index = 2e6;               // temporarily last; renumber fixes
    try { await _api().setOverride(_node.id, p.id, { enabled }); } catch (e) { console.error('[PLv2]', e); }
  } else {
    const real = _prompts.find(q => q.id === p.id);
    if (!real) return;
    real.enabled = enabled;
    if (enabled) real.order_index = 2e6;
    await _api().updatePrompt(real.id, { enabled });
  }
  await _renumberEnabled();
  _syncListToText();
  _renderListBody();
  document.dispatchEvent(new CustomEvent('plv2:editor-changed', { detail: { immediate: true } }));
}

async function _setPromptWeight(p, weight) {
  if (p.__tpl) {
    const tp = _tplPrompts.find(q => q.id === p.id);
    if (tp) tp.weight = weight;
    try { await _api().setOverride(_node.id, p.id, { weight }); } catch (e) { console.error('[PLv2]', e); }
    _syncListToText();   // reflect the new weight wrapper in the text box
    _notifyEditorIfReferenced();
    return;
  }
  const real = _prompts.find(q => q.id === p.id);
  if (!real) return;
  real.weight = weight;
  await _api().updatePrompt(real.id, { weight });
  _syncListToText();
  _notifyEditorIfReferenced();
}

function _verticalRow(p) {
  const row = document.createElement('div');
  // Inherited (template) prompts get a clearly distinct tint + bold left accent (#3a).
  const bg = p.__tpl ? 'background:#2a1f48;border-left:3px solid #a87fff;' : 'border-left:3px solid transparent;';
  row.style.cssText = `display:flex;align-items:center;gap:4px;padding:3px 10px 3px 7px;${bg}opacity:${p.enabled ? '1' : '0.45'};`;

  const toggle = document.createElement('input');
  toggle.type = 'checkbox'; toggle.checked = p.enabled;
  toggle.style.cssText = 'cursor:pointer;accent-color:#cba6f7;flex-shrink:0;';
  toggle.addEventListener('change', () => _setPromptEnabled(p, toggle.checked));

  const contentIn = document.createElement('input');
  contentIn.value = p.content;
  contentIn.style.cssText = `flex:1;background:#1e1e2e;border:1px solid #313244;border-radius:3px;color:${p.__tpl ? '#a6adc8' : '#cdd6f4'};font-size:11px;padding:2px 5px;min-width:0;`;
  if (p.__tpl) {
    // Inherited content is locked (override the template entry to change it).
    contentIn.readOnly = true;
    contentIn.title = `Inherited from ${p.origin_full_path || 'template'} — content is locked`;
    contentIn.style.cursor = 'default';
  } else {
    window.xyzTagAC?.attach(contentIn);  // autocomplete only (no related), per req #1
    contentIn.addEventListener('change', async () => {
      const v = window.plv2.cleanPrompt(contentIn.value.trim());
      if (!v || v === p.content) { contentIn.value = p.content; return; }
      if (_prompts.some(q => q.id !== p.id && q.content.trim() === v)) { contentIn.value = p.content; return; }   // #6
      const real = _prompts.find(q => q.id === p.id); if (real) real.content = v;
      contentIn.value = v;
      await _api().updatePrompt(p.id, { content: v });
      _syncListToText();
      _notifyEditorIfReferenced();
    });
  }

  const weightIn = document.createElement('input');
  weightIn.type = 'number'; weightIn.value = +(p.weight ?? 1).toFixed(2);
  weightIn.min = '0.1'; weightIn.max = '2'; weightIn.step = '0.05';
  weightIn.style.cssText = 'width:52px;background:#1e1e2e;border:1px solid #313244;border-radius:3px;color:#cdd6f4;font-size:11px;padding:2px 4px;flex-shrink:0;';
  weightIn.addEventListener('change', () => _setPromptWeight(p, parseFloat(weightIn.value) || 1));

  row.append(toggle, contentIn, weightIn);
  if (p.__tpl) {
    // No delete; a small "tpl" tag marks the origin instead.
    row.appendChild(_span('tpl', 'font-size:9px;color:#7c3aed;background:#2d1b5e;border-radius:3px;padding:1px 4px;flex-shrink:0;'));
  } else {
    row.appendChild(_iconBtn('×', 'Delete prompt', async () => {
      await _api().deletePrompt(p.id);
      _prompts = _prompts.filter(q => q.id !== p.id);
      _syncListToText();
      _renderListBody();
      _notifyEditorIfReferenced();
    }, { color: '#f38ba8', fontSize: '14px' }));
  }
  return row;
}

function _compactChip(p) {
  const chip = document.createElement('div');
  chip.className = 'plv2-chip';
  chip.dataset.promptId = p.id;
  // Distinct palettes: template chips = brighter violet + dashed border + ↳ marker;
  // own chips = the standard purple (#3a). Both reorderable when enabled (#3b).
  const bg = p.__tpl ? (p.enabled ? '#3b2a6b' : '#241a3a') : (p.enabled ? '#2d1b5e' : '#252536');
  const fg = p.__tpl ? (p.enabled ? '#d9c7ff' : '#7c7396') : (p.enabled ? '#cba6f7' : '#6c7086');
  const bd = p.__tpl ? `1px dashed ${p.enabled ? '#a87fff' : '#4a3f6e'}`
                     : `1px solid ${p.enabled ? '#7c3aed55' : '#313244'}`;
  chip.style.cssText = `display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:12px;cursor:pointer;font-size:11px;user-select:none;background:${bg};color:${fg};border:${bd};`;
  chip.title = (p.__tpl ? `Inherited from ${p.origin_full_path || 'template'} — ` : '') + (p.enabled ? 'click to disable' : 'click to enable');

  // Drag handle for enabled prompts — own AND template (unified reorder, #3b).
  if (p.enabled) {
    const handle = document.createElement('span');
    handle.textContent = '⋮⋮';
    handle.style.cssText = `cursor:grab;color:${p.__tpl ? '#a87fff' : '#7c3aed'};font-size:11px;line-height:1;letter-spacing:-2px;flex-shrink:0;`;
    handle.addEventListener('mousedown', e => { e.stopPropagation(); });
    chip.appendChild(handle);
    chip.draggable = true;
    let _dragged = false;
    chip.addEventListener('dragstart', e => {
      _dragSrcId = p.id; _dragged = true; chip.style.opacity = '0.5';
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(p.id));
    });
    chip.addEventListener('dragend', () => { _dragSrcId = null; chip.style.opacity = '1'; setTimeout(() => { _dragged = false; }, 0); });
    chip.addEventListener('click', () => { if (!_dragged) _setPromptEnabled(p, !p.enabled); });
  } else {
    chip.addEventListener('click', () => _setPromptEnabled(p, !p.enabled));
  }

  if (p.__tpl) chip.appendChild(_span('↳', 'font-size:10px;flex-shrink:0;opacity:0.85;'));
  chip.appendChild(_span(p.content));
  return chip;
}

// ─── Sub entry panel ──────────────────────────────────────────────────────────

function _buildSubPanel() {
  const panel = document.createElement('div');
  panel.style.cssText = 'flex:1;display:flex;flex-direction:column;overflow-y:auto;min-height:0;scrollbar-width:thin;scrollbar-color:#45475a transparent;';

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

async function _overrideSubentry(tplChild) {
  // Create a local same-named sub-entry; the structural name-match rule makes it
  // inherit the template sub-entry automatically (an "inheritable override").
  if (_children.some(c => c.name === tplChild.name)) return;   // already overridden
  try {
    const r = await _api().createNode({
      name: tplChild.name, has_prompts: true, parent_id: _node.id,
      pos_neg: tplChild.pos_neg ?? _node.pos_neg ?? 'positive',
    });
    if (r?.error) { console.error('[PLv2]', r.error); alert(r.error.message || 'Override failed.'); return; }
  } catch (e) { console.error('[PLv2]', e); return; }
  await _loadData();
  _render();
  window.plv2Tree?.reload?.();
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
  // Relative self-ref for inserting into THIS entry's own prompts (feature e):
  // [this.<path under this entry>], rebound to full_path at generation time.
  let thisRef = childRef;
  if (_node.full_path && child.full_path && child.full_path.startsWith(_node.full_path + '.')) {
    thisRef = `[this.${child.full_path.slice(_node.full_path.length + 1)}]`;
  }

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

  if (kind === 'inherited') {
    // Inherited sub-entry: refs work via the engine's inherited-subpath fallback
    // ([this.name] / [entry.name] resolve to the template sub-entry). Plus an
    // "override" that materialises a local same-named child (keeps inheriting).
    const auto = _triggers.find(t => t.is_auto);
    const entryRef = auto?.trigger_text ?? _node.full_path;
    hdr.append(_iconBtn('⤴', "Add reference to this entry's prompts",
      () => _addRefToPromptBox(`[this.${child.name}]`, child)));
    hdr.append(_iconBtn('＋', 'Insert reference into the text editor',
      () => _emitInsert(`[${entryRef}.${child.name}]`, _posNeg(), child.delimiter)));
    hdr.append(_iconBtn('⎘', 'Override — create a local copy that still inherits this template sub-entry',
      () => _overrideSubentry(child), { color: '#cba6f7' }));
    hdr.append(_iconBtn('→', `Open template's ${child.name}`, () => showEntry(child)));
  } else {
    // ⤴ — add reference to THIS entry's prompt list (uses this entry's delimiter)
    hdr.append(_iconBtn('⤴', "Add reference to this entry's prompts",
      () => _addRefToPromptBox(thisRef, child)));
    // ＋ — insert reference into the text editor (routed by the sub-entry's polarity)
    hdr.append(_iconBtn('＋', 'Insert reference into the text editor',
      () => _emitInsert(childRef, child.pos_neg ?? 'positive', child.delimiter)));
    // open the sub-entry's own detail page
    hdr.append(_iconBtn('→', `Open ${child.name}`, () => showEntry(child)));
  }

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

// ─── Custom autocomplete dropdown (themed; replaces native <datalist>) ─────────

function _attachAutocomplete(input, options, onPick) {
  let menu = null, items = [], active = -1;

  const onDocDown = (e) => { if (menu && e.target !== input && !menu.contains(e.target)) close(); };
  function close() {
    if (menu) { menu.remove(); menu = null; }
    items = []; active = -1;
    document.removeEventListener('mousedown', onDocDown, true);
  }
  const setActive = (i) => { active = i; items.forEach((it, idx) => it.style.background = idx === i ? '#313244' : 'none'); };
  const pick = (o) => { input.value = o; close(); onPick && onPick(); };
  const position = () => {
    if (!menu) return;
    const r = input.getBoundingClientRect();
    menu.style.minWidth = r.width + 'px';
    menu.style.left = r.left + 'px';
    menu.style.top = (r.bottom + 3) + 'px';
    const mh = menu.offsetHeight;
    if (r.bottom + 3 + mh > window.innerHeight && r.top - mh - 3 > 0) menu.style.top = (r.top - mh - 3) + 'px';
  };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const matches = options.filter(o => o && o !== input.value && (!q || o.toLowerCase().includes(q))).slice(0, 12);
    if (!matches.length) { close(); return; }
    if (!menu) {
      menu = document.createElement('div');
      menu.style.cssText = 'position:fixed;z-index:100002;background:#1e1e2e;border:1px solid #45475a;border-radius:5px;padding:3px;box-shadow:0 6px 22px rgba(0,0,0,0.5);max-height:240px;overflow:auto;scrollbar-width:thin;scrollbar-color:#45475a transparent;';
      document.body.appendChild(menu);
      document.addEventListener('mousedown', onDocDown, true);
    }
    menu.innerHTML = ''; items = []; active = -1;
    for (const o of matches) {
      const it = document.createElement('div');
      it.textContent = o;
      it.style.cssText = 'padding:4px 9px;border-radius:3px;font-size:11px;color:#cdd6f4;cursor:pointer;white-space:nowrap;font-family:"Fira Code",Consolas,monospace;';
      it.addEventListener('mouseenter', () => setActive(items.indexOf(it)));
      it.addEventListener('mousedown', (e) => { e.preventDefault(); pick(o); });
      menu.appendChild(it); items.push(it);
    }
    position();
  };

  input.addEventListener('focus', render);
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (!menu) return;
    if (e.key === 'ArrowDown')      { e.preventDefault(); setActive(Math.min(active + 1, items.length - 1)); items[active]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setActive(Math.max(active - 1, 0));               items[active]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter')     { if (active >= 0) { e.preventDefault(); pick(items[active].textContent); } }
    else if (e.key === 'Escape')    { e.stopPropagation(); close(); }
  });
  input.addEventListener('blur', () => setTimeout(close, 120));
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
  const oldFullPath = _node.full_path;
  const oldAutoTrigger = _triggers.find(t => t.is_auto)?.trigger_text ?? null;
  let r;
  try {
    r = await _api().updateNode(_node.id, { name: newName });
    _node.name      = r?.node?.name      ?? newName;
    _node.full_path = r?.node?.full_path ?? _node.full_path;
  } catch(e) {
    console.error('[PLv2]', e);
    if (_nameInput) _nameInput.value = _node.name;
    return;
  }
  // Pass the backend's ref_replacements (includes cascaded template-override
  // renames) so graph widgets + in-memory prompts mirror ALL of them (#2).
  await _afterPathChange(_node, oldFullPath, oldAutoTrigger, true, r?.ref_replacements);
}

/**
 * Called after a node's full_path or auto_trigger may have changed (rename / move).
 * @param node  The node object (must have id, full_path fields)
 * @param oldFullPath   The full_path before the change
 * @param oldAutoTrigger  The auto_trigger before the change (null if unknown)
 * @param updateDetailUI  Whether to refresh the entry detail if this node is open
 */
async function _afterPathChange(node, oldFullPath, oldAutoTrigger, updateDetailUI = true, backendReps = null) {
  const tr = await _api().getTriggers(node.id);
  const newTriggers = tr?.triggers ?? [];
  const newAutoTrigger = newTriggers.find(t => t.is_auto)?.trigger_text ?? null;
  const newFullPath = node.full_path;

  const reps = [];
  if (oldFullPath && newFullPath && oldFullPath !== newFullPath) {
    reps.push({ old: oldFullPath, new: newFullPath });
  }
  if (oldAutoTrigger && newAutoTrigger && oldAutoTrigger !== newAutoTrigger) {
    reps.push({ old: oldAutoTrigger, new: newAutoTrigger });
  }
  // Merge backend replacements (cascaded template-override renames, etc.) so the
  // open entry's in-memory prompts and live node widgets reflect them too (#2).
  for (const rp of (backendReps || [])) {
    if (rp && rp.old && rp.new && !reps.some(x => x.old === rp.old && x.new === rp.new)) reps.push(rp);
  }

  if (reps.length) {
    try { await _api().replaceRefs(node.id, { replacements: reps }); } catch(e) { console.error('[PLv2] replaceRefs failed', e); }
    _updateWorkflowRefs(reps);
    _notifyEditorIfReferenced();
  }

  if (updateDetailUI && _node && _node.id === node.id) {
    // Apply ref replacements to in-memory prompts before syncing to textarea
    for (const { old: o, new: n } of reps) {
      const ob = `[${o}]`; const nb = `[${n}]`;
      const od = `[${o}.`; const nd = `[${n}.`;
      for (const p of _prompts) {
        while (p.content.includes(od)) p.content = p.content.replace(od, nd);
        while (p.content.includes(ob)) p.content = p.content.replace(ob, nb);
      }
    }
    _node = { ..._node, full_path: newFullPath };
    _triggers = newTriggers;
    // Refresh the header path, name field, and trigger row (#2).
    if (_titleEl)   { _titleEl.textContent = _node.full_path || _node.name; _titleEl.title = _titleEl.textContent; }
    if (_nameInput && _nameInput.value !== _node.name) _nameInput.value = _node.name;
    if (_triggerWrap) _renderInsertRow();
    _syncListToText();
  }
}

function _updateWorkflowRefs(reps) {
  if (!app?.graph) return;
  const types = ['XYZ Prompt Library V2 Positive', 'XYZ Prompt Library V2 Negative'];
  for (const node of app.graph._nodes) {
    if (!types.includes(node.comfyClass)) continue;
    const w = node.widgets?.find(x => x.name === 'prompt_template');
    if (!w) continue;
    let v = w.value;
    let changed = false;
    for (const { old: o, new: n } of reps) {
      const ob = `[${o}]`; const nb = `[${n}]`;
      const od = `[${o}.`; const nd = `[${n}.`;
      while (v.includes(od)) { v = v.replace(od, nd); changed = true; }
      while (v.includes(ob)) { v = v.replace(ob, nb); changed = true; }
    }
    if (changed) {
      w.value = v;
      if (w.inputEl && w.inputEl.value !== v) w.inputEl.value = v;
      node.onWidgetChanged?.(w.name, v, v, w);
      app.graph.setDirtyCanvas(true, true);
      document.dispatchEvent(new CustomEvent('plv2:node-edited', { detail: { nodeId: node.id, value: v } }));
    }
  }
}

function _emitInsert(text, posNeg, delimiter) {
  document.dispatchEvent(new CustomEvent('plv2:insert', { detail: { text, posNeg, delimiter } }));
}

/** Add `ref` to the current entry's prompt textarea (#2b). */
function _addRefToPromptBox(ref, child) {
  if (!_promptTextarea) return;

  // Cancel the blur-triggered sync — we sync ourselves after inserting.
  clearTimeout(_blurTimer);

  // Guard: skip if a reference to this child already exists in the textarea.
  const childPath = child?.full_path;
  const childAuto = child?.auto_trigger;
  // Relative "this." form of the child path, so [this.x] dedups against itself.
  let childThis = null;
  if (_node?.full_path && childPath && childPath.startsWith(_node.full_path + '.')) {
    childThis = 'this.' + childPath.slice(_node.full_path.length + 1);
  }
  const refRe = /\[([^\]]+)\]/g;
  let m;
  while ((m = refRe.exec(_promptTextarea.value)) !== null) {
    const inner = m[1];
    if (childPath && (inner === childPath || inner.startsWith(childPath + '.'))) return;
    if (childAuto && (inner === childAuto || inner.startsWith(childAuto + '.'))) return;
    if (childThis && (inner === childThis || inner.startsWith(childThis + '.'))) return;
  }

  // Insert position:
  //   still focused                    → current selectionStart
  //   focused when this click began    → caret captured at pointerdown (before focus left)
  //   blurred earlier (clicked elsewhere first) → append to end
  const D = _delim();
  const pos = document.activeElement === _promptTextarea
    ? (_promptTextarea.selectionStart ?? _promptTextarea.value.length)
    : (_caretBeforeClick != null
        ? Math.min(_caretBeforeClick, _promptTextarea.value.length)
        : _promptTextarea.value.length);

  const plan = window.plv2.insert.plan(_promptTextarea.value, pos);
  const { value, caret } = window.plv2.insert.assemble(plan, ref, D, D);
  _promptTextarea.value = value;
  _promptTextarea.selectionStart = _promptTextarea.selectionEnd = caret;
  _promptTextarea.focus();

  // Sync to prompt list. The blur-debounce timer was cancelled above, so there
  // is no race — this is the only sync that will run for this change.
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

    // Capture the prompt textarea's caret at the START of every click, before the
    // click can shift focus to a button. `_addRefToPromptBox` reads this so the "⤴"
    // sub-entry buttons insert at the caret when the textarea was focused, and append
    // to the end when it wasn't (user clicked elsewhere first). Capture phase runs
    // before the focus shift, so document.activeElement is still the textarea here.
    document.addEventListener('pointerdown', () => {
      _caretBeforeClick = (_promptTextarea && document.activeElement === _promptTextarea)
        ? _promptTextarea.selectionStart
        : null;
    }, true);

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
      if (!node || !node.has_prompts) return;
      // Ensure the library window is open so the detail is visible
      try { window.plv2?.windows?.library?.show(); } catch {}
      showEntry(node);
    });

    // An entry's prompts changed elsewhere (e.g. editor "add to entry") — refresh if open.
    document.addEventListener('plv2:entry-changed', async e => {
      if (_node && e.detail?.nodeId === _node.id) { await _loadData(); _render(); }
    });

    // A node was renamed elsewhere (e.g. the tree). If it's the open entry, fully
    // refresh it; otherwise the open entry may have been ref-affected by a cascade
    // (e.g. a template sub-entry rename rewrote its [this.x] refs) — reload from DB.
    document.addEventListener('plv2:node-renamed', async e => {
      if (!_node) return;
      const { nodeId, node } = e.detail || {};
      if (node && _node.id === nodeId) { showEntry(node, false); return; }
      await _loadData(); _render();
    });

    // Expose for programmatic opening + cross-window ref maintenance.
    window.plv2Entry = { showEntry, getLastEntryId, afterPathChange: _afterPathChange, applyWorkflowRefs: _updateWorkflowRefs };
  },
});
