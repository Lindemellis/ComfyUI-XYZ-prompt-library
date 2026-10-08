import { element, button, check, menu, report } from './ui.js';
import { indexTree, isBlock, nameOf } from './details.js';
import { blockFrame, blockLibraryPath } from './design_adapter.js';
import { attachInlineAutocomplete } from './inline_input.js';
import { blockPlacement, nearestBlockBoundary, dropLocation, DropPreview } from './drop_preview.js';
import { inlineText, inlineOffset, inlinePoint, insertInlineNewline, deleteInlineNewline, syncInlineEnd } from './text_input.js';
import { promptDisplay, displayRun, scheduleSource, separatorDisplay, normalizePromptInput, runEnd } from './prompt_text.js';

// A focused TextRun is only a view into the parent session. Its IDs and history
// still belong to that document; this adapter never creates an AST container.
class RunSession {
  constructor(parent, ids, host, insertion = null) {
    this.parent = parent; this.ids = ids; this.host = host;
    const rows = this.rows().filter(n => n.span);
    if (!rows.length && !insertion) throw new Error('请先启用该文本段');
    const owner = indexTree(parent.projection.tree).get(rows[0]?.parent_id);
    this.range = insertion ? [insertion.at, insertion.at] : [rows[0].span[0], runEnd(rows, owner, parent.text)];
    this.prefix = insertion?.prefix || ''; this.activePrefix = '';
    this.source = parent.text; this.editing = false;
    this.owner = rows[0]?.parent_id;
    this.display = displayRun(rows, parent.text, this.contentStart, this.range[1]);
  }
  rows() { const map = indexTree(this.parent.projection.tree); return this.ids.map(id => map.get(id)).filter(Boolean); }
  get text() {
    return this.display.text;
  }
  sourceOffset(offset) { return this.display.offsets[Math.max(0, Math.min(offset, this.display.offsets.length - 1))] ?? this.contentStart; }
  get contentStart() { return this.range[0] + this.activePrefix.length; }
  replacement(text) { const insert = (text ? this.prefix : '') + text; return this.source.slice(0, this.range[0]) + insert + this.source.slice(this.range[1]); }
  get revision() { return this.parent.revision; }
  get state() { return this.parent.state; }
  get projection() { return { diagnostics: this.parent.projection.diagnostics.filter(d => d.pos >= this.range[0] && d.pos <= this.range[1]).map(d => ({ ...d, pos: d.pos - this.range[0] })) }; }
  get valid() { return !this.disposed && this.parent.valid; }
  dispose() { this.disposed = true; }
  whenIdle() { return this.parent.whenIdle(); }
  commitPool() { return this.parent.commitPool(); }
  replaceText(text, { deferPool = false, onDraft = () => {} } = {}) {
    return this.parent._enqueue(async () => {
      if (this.disposed) return false;
      if (this.parent.text !== this.source) throw new Error('文档已变化，请重新打开文本段');
      const decoded = scheduleSource(text, this.display.originals, this.display);
      const source = this.replacement(decoded.source);
      onDraft(source);
      this.editing = true;
      try {
        // Raw typing may split items or introduce braces. Reconcile the complete
        // document through the same command as syntax typing, keeping parked IDs.
        const start = this.range[0] + (text ? this.prefix.length : 0);
        const result = await this.parent._apply({ type: 'ReplaceText', text: source, prompt_spans: decoded.promptSpans.map(span => span.map(at => at + start)), revision: this.parent.revision, ...(deferPool ? { defer_pool: true } : {}) });
        this.activePrefix = text ? this.prefix : '';
        this.range[1] = this.contentStart + decoded.source.length; this.source = this.parent.text;
        const owner = indexTree(this.parent.projection.tree).get(this.owner);
        const current = owner ? displayRun(owner.children, this.source, this.contentStart, this.range[1]) : this.display;
        this.display = { text, offsets: decoded.offsets.map(at => at + this.contentStart), originals: current.originals,
          separators: current.text === text ? current.separators : [] };
        return result;
      } finally { this.editing = false; }
    });
  }
  subscribe(listener) { return this.parent.subscribe(event => {
    if (!this.editing && this.parent.text !== this.source) {
      this.host.blockView.closeEditor(); this.host.blockView.render(this.host.context); return;
    }
    listener(event);
  }); }
  undo() { return this.host.undo(); }
  redo() { return this.host.redo(); }
  compile(inputs) { return this.parent.compile(inputs); }
}

export class BlockView {
  constructor(container, host) {
    this.container = container; this.host = host; this.cache = new Map(); this.inlineEditors = new Set();
    container.addEventListener('beforeinput', event => {
      if (!event.cancelable || event.isComposing) return;
      const field = event.target.closest?.('[data-run-input],[data-empty]');
      if (field?.contentEditable !== 'true') return;
      const handled = ['insertParagraph', 'insertLineBreak'].includes(event.inputType) ? insertInlineNewline(field)
        : ['deleteContentBackward', 'deleteContentForward'].includes(event.inputType) && deleteInlineNewline(field, event.inputType);
      if (handled) event.preventDefault();
    });
    XYZPLv4Design.bindInlineInput(container, { capture: target => this.beginInline(target), input: (target, event) => { if (!event.isComposing) this.typeInline(target); }, commit: target => this.finishInline(target) });
    container.addEventListener('compositionend', event => this.typeInline(event.target.closest?.('[data-run-input],[data-empty]') || event.target));
    container.addEventListener('keydown', event => {
      if (!event.target.matches?.('[data-run-input],[data-prompt],[data-empty]') || event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); event.target.blur(); }
      else if (!(event.ctrlKey || event.metaKey) || !['z', 'y'].includes(event.key.toLowerCase())) event.stopPropagation();
    });
  }
  render(context) {
    if (this.context !== context) { this.cache.clear(); this.stamps = new Map(); }
    this.context = context;
    const session = context.session;
    const map = indexTree(session.projection.tree); this.map = map;
    this.signatures = new Map();
    const previous = this.stamps || new Map(), stamps = new Map();
    const stamp = row => {
      const children = row.children.map(stamp);
      // AST source offsets change when an unrelated sibling moves. They are
      // deliberately excluded from the DOM identity so unchanged rows survive.
      const signature = JSON.stringify([row.parent_id, row.form, row.enabled, row.effective, row.source, row.meta, context.folded.has(row.id), children]);
      // Children contribute stable tokens, never recursively escaped JSON strings.
      // This keeps deep trees linear in their source size instead of exponential.
      const old = previous.get(row.id);
      const token = old?.signature === signature ? old.token : this.stampNumber = (this.stampNumber || 0) + 1;
      stamps.set(row.id, { signature, token }); this.signatures.set(row.id, token); return token;
    };
    if (session.projection.tree) stamp(session.projection.tree);
    this.stamps = stamps;
    const scroll = this.container.scrollTop;
    if (this.inline?.element.isConnected) return;
    this.container.replaceChildren();
    if (!session.valid) {
      this.container.append(element('div', 'plv4-empty plv4-error', '原稿未完成。切换到 PLv3 修复；关闭项仍保存在文档中。')); return;
    }
    let root = map.get(context.focus) || session.projection.tree;
    if (context.focus && root.form !== 'root') {
      const path = element('div', 'plv4-path');
      const ancestors = []; for (let n = root; n; n = map.get(n.parent_id)) ancestors.unshift(n);
      for (const n of ancestors) path.append(button(n.form === 'root' ? 'Document' : nameOf(n) || 'Block', '返回父级', () => { context.focus = n.form === 'root' ? null : n.id; this.render(context); }));
      this.container.append(path);
    }
    if (root.form === 'root') this.contents(root, this.container, 0);
    else this.container.append(this.block(root, 0));
    if (root.children.length) {
      const target = this.context.asset && root.form === 'root' ? root.children[0] : root;
      this.container.append(button('＋ 添加 block', '添加 block', () => this.host.addBlock(target.id, true), 'small-add'));
    }
    if (!root.children.length) this.container.append(button('+ Block', '添加 block', () => this.host.addBlock(root.id, true)));
    this.container.scrollTop = scroll;
    for (const id of this.cache.keys()) if (!map.has(id)) this.cache.delete(id);
  }
  contents(row, container, depth) {
    let run = [];
    const flush = next => { if (!run.length) return; container.append(this.textRun(run, depth, next)); run = []; };
    for (const [index, child] of row.children.entries()) {
      if (isBlock(child)) {
        flush(child.id); container.append(this.boundary(row.id, child.id), this.block(child, depth));
        const next = row.children[index + 1]; if (next && !isBlock(next)) container.append(this.boundary(row.id, next.id));
      }
      else run.push(child);
    }
    flush();
    if (!['schedule', 'region'].includes(row.form) && !row.children.length) container.append(this.emptyInput(row));
    container.append(this.boundary(row.id));
  }
  block(row, depth) {
    const key = this.signatures.get(row.id);
    const libraryPath = blockLibraryPath(row, this.host.library);
    const cached = this.cache.get(row.id);
    if (cached?.key === key && cached.depth === depth && cached.libraryPath === libraryPath) {
      cached.box.classList.toggle('selected', this.context.session.state.selection.block_id === row.id);
      return cached.box;
    }
    const folded = this.context.folded.has(row.id);
    const libraryRoot = this.context.asset && row.parent_id === this.context.session.projection.tree.id;
    const box = blockFrame(row, depth, folded, this.context.session.state.selection.block_id, libraryRoot, libraryPath);
    const fold = box.querySelector('[data-fold]');
    fold.onclick = () => { if (folded) this.context.folded.delete(row.id); else this.context.folded.add(row.id); this.render(this.context); };
    box.querySelector('[data-header-toggle]').onclick = () => this.host.run(() => this.host.command({ type: 'SetEnabled', id: row.id, enabled: !row.enabled }));
    box.querySelector('[data-detail]').onclick = () => this.host.run(() => this.host.locate(row.id));
    const sibling = box.querySelector('[data-sibling]');
    if (sibling) { sibling.title = '添加同级 block'; sibling.onclick = () => this.host.run(() => this.host.addBlock(row.id, false)); }
    box.querySelector('[data-child]').onclick = () => this.host.run(() => this.host.addBlock(row.id, true));
    box.querySelector('[data-block-menu]').onclick = e => menu(e.currentTarget, [
      ['Save', () => this.host.libraryAction('save', row)], ['Delete', () => this.host.command({ type: 'Delete', id: row.id })],
      ['绑定池', () => this.host.libraryAction('pool', row)],
    ]);
    const handle = box.querySelector('.plv4-handle'); handle.dataset.dragId = row.id;
    if (!libraryRoot) handle.onpointerdown = e => this.startDrag(e, row, handle);
    const body = box.querySelector('.block-body');
    if (body) {
      this.contents(row, body, depth + 1);
    }
    box.onclick = e => { e.stopPropagation(); if (!e.target.closest('button,input,[contenteditable],.plv4-handle')) this.host.run(() => this.host.locate(row.id)); };
    box.oncontextmenu = e => {
      if (e.target.closest('.plv4-block') !== box || e.target.closest('.plv4-prompt')) return;
      e.preventDefault(); e.stopPropagation(); this.contextMenu(e, row);
    };
    this.cache.set(row.id, { key, depth, libraryPath, box }); return box;
  }
  boundary(parent, before = '', inline = false) {
    const template = document.createElement('template'); template.innerHTML = XYZPLv4Design.boundaryHTML(parent, before, inline);
    return template.content.firstElementChild;
  }
  dropBoundary(parent, command, inline = false) {
    const row = this.map.get(parent); if (!row) return null;
    const before = command.before_id || (command.after_id ? row.children[row.children.findIndex(n => n.id === command.after_id) + 1]?.id : command.edge === 'start' ? row.children[0]?.id : '') || '';
    const slots = [...this.container.querySelectorAll('.boundary[data-parent]')].filter(slot => slot.dataset.parent === parent && slot.dataset.before === before);
    return slots.find(slot => slot.classList.contains('inline') === inline) || slots[0] || null;
  }
  clearDrop() { this.container.querySelectorAll('.boundary.drop-active').forEach(slot => slot.classList.remove('drop-active')); }
  showDrop(parent, command, inline = false) { this.clearDrop(); const slot = this.dropBoundary(parent, command, inline); slot?.classList.add('drop-active'); return slot; }
  dropTarget(x, y, excluded = new Set()) {
    const hit = document.elementFromPoint(x, y);
    if (!hit || !this.container.contains(hit)) return null;
    const box = hit.closest('[data-block-id]');
    const owner = box ? this.map.get(box.dataset.blockId) : null;
    let parent, command, placement, highlight;
    let slot = hit.closest('.boundary[data-parent]');
    const prompt = hit.closest('[data-prompt-id]');
    const edge = box ? blockPlacement(box.getBoundingClientRect(), y) : null;
    // Resolve the shared bottom area against every visible structural line,
    // including the child's end and the parent's end below it. DOM hit ownership
    // and the parent's bottom band must not invert those vertical destinations.
    if (!slot?.classList.contains('inline') && (slot || edge !== 'inside' || (!prompt && !hit.closest('.plv4-run')))) {
      slot = nearestBlockBoundary(this.container, x, y) || slot;
    }
    if (slot) {
      parent = this.map.get(slot.dataset.parent);
      command = slot.dataset.before ? { before_id: slot.dataset.before } : { edge: 'end' };
      placement = slot.classList.contains('inline') ? 'inline' : 'between';
    } else if (owner && edge !== 'inside') {
      parent = this.map.get(owner.parent_id);
      command = { [edge === 'before' ? 'before_id' : 'after_id']: owner.id };
      placement = edge;
    } else if (prompt) {
      const item = this.map.get(prompt.dataset.promptId), rect = prompt.getBoundingClientRect();
      parent = this.map.get(item.parent_id);
      command = { [x < rect.left + rect.width / 2 ? 'before_id' : 'after_id']: item.id };
      placement = 'inline';
    } else if (hit.closest('.plv4-run')) {
      const run = hit.closest('.plv4-run'), nearest = XYZPLv4Design.nearestBoundary(run, x, y, Infinity);
      if (!nearest) return null;
      parent = this.map.get(nearest.dataset.parent);
      command = nearest.dataset.before ? { before_id: nearest.dataset.before } : { edge: 'end' };
      placement = 'inline';
    } else {
      parent = owner || this.map.get(this.context.focus) || this.context.session.projection.tree;
      command = { edge: 'end' }; placement = owner ? 'inside' : 'between'; highlight = box;
    }
    // Library blocks have a single root; its surrounding whitespace belongs to it.
    if (this.context.asset && parent?.form === 'root') {
      parent = this.context.session.projection.tree.children[0]; command = { edge: 'end' }; placement = 'inside';
      highlight = [...this.container.querySelectorAll('[data-block-id]')].find(n => n.dataset.blockId === parent.id);
    }
    if (!parent || excluded.has(parent.id) || excluded.has(command.before_id) || excluded.has(command.after_id)) return null;
    if (placement === 'inside' && !highlight && box) highlight = box;
    const names = []; for (let row = parent; row; row = this.map.get(row.parent_id)) names.unshift(nameOf(row) || (row.form === 'root' ? 'Document' : 'Block'));
    const anchor = this.map.get(command.before_id || command.after_id);
    return { parent, owner, command: { parent_id: parent.id, ...command }, placement, highlight, path: names.join(' / '), anchorName: anchor && (nameOf(anchor) || 'Block') };
  }
  textRun(rows, depth, next = '') {
    const run = element('div', 'plv4-run'); run.dataset.runIds = rows.map(n => n.id).join(','); run.dataset.depth = depth;
    run.dataset.runInput = ''; run.dataset.runParent = rows[0].parent_id;
    run.contentEditable = rows.some(row => row.effective) ? 'true' : 'false';
    run.setAttribute('role', 'textbox'); run.setAttribute('aria-multiline', 'true'); run.setAttribute('aria-label', 'Block prompt'); run.spellcheck = false;
    const live = rows.filter(row => row.effective && row.span), lastLive = rows.findLastIndex(row => row.effective);
    let liveIndex = 0;
    for (const [i, row] of rows.entries()) {
      const template = document.createElement('template');
      const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const source = promptDisplay(row, this.context.session.text).text;
      template.innerHTML = XYZPLv4Design.promptHTML({ id: row.id, enabled: row.enabled, text: source }, { state: { prompt: this.context.session.state.selection.node_id }, text: p => p.text, esc, sharedInput: true });
      const span = template.content.firstElementChild; span.classList.add('plv4-prompt'); span.dataset.promptId = row.id;
      if (!row.effective) {
        span.contentEditable = 'false'; span.dataset.parked = '';
        // Parked text is visible decoration, including its visual punctuation;
        // the editable value remains the document's enabled projection.
        const separator = value => value.trimEnd().endsWith('.') ? ' ' : ', ';
        if (lastLive >= 0 && i > lastLive && i > 0) span.prepend(document.createTextNode(separator(rows[i - 1].source)));
        else if (i < rows.length - 1) span.append(document.createTextNode(separator(row.source)));
      }
      if (this.context.session.state.selection.node_id === row.id) span.classList.add('selected');
      span.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); this.contextMenu(e, row); };
      run.append(this.boundary(row.parent_id, row.id, true), span);
      if (row.effective && row.span) {
        const following = live[++liveIndex];
        if (following) run.append(document.createTextNode(separatorDisplay(this.context.session.text, row.span[1], following.span[0]).text));
      }
    }
    const last = live.at(-1), tail = runEnd(rows, this.map.get(rows[0].parent_id), this.context.session.text);
    if (last && tail > last.span[1]) run.append(document.createTextNode(this.context.session.text.slice(last.span[1], tail)));
    run.append(this.boundary(rows[0].parent_id, next, true));
    syncInlineEnd(run);
    run.onclick = e => {
      e.stopPropagation(); if (!getSelection()?.isCollapsed) return;
      const id = e.target.closest?.('[data-prompt-id]')?.dataset.promptId || run.dataset.runParent;
      this.host.run(() => this.host.locate(id));
    };
    run.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); this.contextMenu(e, this.map.get(run.dataset.runParent)); };
    return run;
  }
  emptyInput(row) {
    const template = document.createElement('template'); template.innerHTML = XYZPLv4Design.emptyHTML(row.id);
    const field = template.content.firstElementChild;
    if (!row.effective) field.contentEditable = 'false';
    field.onclick = e => { e.stopPropagation(); this.host.run(() => this.host.locate(row.id)); };
    return field;
  }
  beginInline(element) {
    if (this.inline?.element === element || element.contentEditable !== 'true') return;
    const previous = this.inline;
    this.inline?.off?.();
    const context = this.context;
    const active = { element, context, pending: Promise.resolve(), changed: false };
    this.inlineEditors.add(active);
    this.inline = active;
    active.ready = (previous?.pending || Promise.resolve()).then(() => context.session.whenIdle()).then(() => {
      if (active.closed || this.context !== context) return null;
      const map = indexTree(context.session.projection.tree); let insertion = null;
      if (element.dataset.empty) {
        const row = map.get(element.dataset.empty); const content = row?.ast?.spans.content;
        if (!content) throw new Error('请先启用该 block');
        const last = row.children.filter(n => n.effective).at(-1);
        insertion = { at: content[1], prefix: last ? (last.source.trimEnd().endsWith('.') ? ' ' : ', ') : '' };
      }
      const ids = element.dataset.runIds?.split(',').filter(Boolean) || (element.dataset.prompt ? [element.dataset.prompt] : []);
      active.run = new RunSession(context.session, ids, this.host, insertion);
      if (this.inline === active) active.off = active.run.subscribe(() => {});
      attachInlineAutocomplete(element, active.run).catch(report);
      return active.run;
    });
    active.ready.catch(report);
  }
  typeInline(element) {
    const active = this.inline; if (!active || active.element !== element) return;
    if (element.childNodes) syncInlineEnd(element);
    const text = normalizePromptInput(inlineText(element)); active.changed = true;
    active.pending = active.pending.then(async () => {
      if (active.closed) return;
      const run = await active.ready;
      if (active.closed || !run || run.disposed) return;
      if (text === run.text) return;
      await run.replaceText(text, { deferPool: true, onDraft: source => {
        if (active.context.node) this.host.sessions.persist(active.context, source);
      } });
    }).catch(error => { if (!active.closed) report(error); });
  }
  async finishInline(element) {
    const active = this.inline; if (!active || active.element !== element) return;
    try {
      if (active.changed) this.typeInline(element);
      await active.pending;
      if (active.closed) return;
      await active.context.session.commitPool();
      if (this.inline === active) { this.closeEditor(); this.render(active.context); }
    } catch (error) { if (!active.closed) report(error); }
    finally { active.closed = true; active.off?.(); active.run?.dispose(); this.inlineEditors.delete(active); }
  }
  captureFocus(field = document.activeElement) {
    if (!this.container.contains(field) || !field.matches('[data-run-input],[data-prompt],[data-empty]')) return null;
    const selection = getSelection(); let offsets = null;
    if (selection?.rangeCount) {
      const range = selection.getRangeAt(0);
      if (field.contains(range.startContainer) && field.contains(range.endContainer)) {
        const offset = (node, at) => inlineOffset(field, node, at);
        offsets = [offset(range.startContainer, range.startOffset), offset(range.endContainer, range.endOffset)];
      }
    }
    const ids = field.dataset.runIds?.split(',') || [];
    const ancestors = []; for (let row = this.map.get(field.dataset.empty || field.dataset.prompt || ids[0]); row; row = this.map.get(row.parent_id)) ancestors.push(row.id);
    return { prompt: field.dataset.prompt, runIds: ids, empty: field.dataset.empty, offsets, ancestors };
  }
  restoreFocus(bookmark) {
    const fields = [...this.container.querySelectorAll('[data-run-input],[data-prompt],[data-empty]')];
    let field = fields.find(node => node.contentEditable === 'true' && (bookmark.runIds?.length ? node.dataset.runIds?.split(',').some(id => bookmark.runIds.includes(id)) : bookmark.prompt ? node.dataset.prompt === bookmark.prompt : node.dataset.empty === bookmark.empty));
    if (!field) {
      const map = indexTree(this.context.session.projection.tree);
      const parent = bookmark.ancestors.map(id => map.get(id)).find(row => row && (row.form === 'root' || isBlock(row)));
      if (parent) this.focusInput(parent.id);
      if (!this.container.contains(document.activeElement)) this.host.shell.win.el.focus({ preventScroll: true });
      return;
    }
    field.focus({ preventScroll: true }); this.beginInline(field);
    const point = offset => {
      return inlinePoint(field, offset);
    };
    const offsets = bookmark.offsets || [inlineText(field).length, inlineText(field).length];
    const range = document.createRange(); range.setStart(...point(offsets[0])); range.setEnd(...point(offsets[1]));
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }
  focusInput(id) {
    const box = [...this.container.querySelectorAll('[data-block-id]')].find(n => n.dataset.blockId === id) || this.container;
    let field = [...box.querySelectorAll('[data-empty],[data-run-input],[data-prompt]')].filter(n => n.closest('[data-block-id]') === (box === this.container ? null : box) && n.contentEditable === 'true').at(-1);
    if (!field) {
      const row = indexTree(this.context.session.projection.tree).get(id);
      if (!row?.effective || ['schedule', 'region'].includes(row.form)) return;
      const body = box === this.container ? box : box.querySelector(':scope > .block-content > .block-body');
      if (!body) return;
      field = this.emptyInput(row); body.append(field);
    }
    if (field) { field.focus(); const range = document.createRange(); range.selectNodeContents(field); range.collapse(false); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
  }
  contextMenu(e, row) {
    if (this.host.textContextMenu && e.target.closest?.('[data-run-input],[data-empty]')) { this.host.run(() => this.host.textContextMenu(e, row)); return; }
    const selection = getSelection(); let ids = [];
    let wrap = null;
    if (selection && !selection.isCollapsed && this.container.contains(selection.anchorNode) && this.container.contains(selection.focusNode)) {
      const range = selection.getRangeAt(0);
      ids = [...this.container.querySelectorAll('[data-prompt-id]')].filter(n => range.intersectsNode(n)).map(n => n.dataset.promptId);
      const field = (selection.anchorNode.nodeType === 3 ? selection.anchorNode.parentElement : selection.anchorNode)?.closest('[data-run-input]');
      if (field && field.contains(range.startContainer) && field.contains(range.endContainer)) {
        const offsets = [inlineOffset(field, range.startContainer, range.startOffset), inlineOffset(field, range.endContainer, range.endOffset)];
        const active = this.inline?.element === field ? this.inline : null;
        const context = this.context;
        wrap = async () => {
          // Typing may have split/merged prompt spans before a DOM redraw. Resolve
          // the selected instances against the completed document, not old chips.
          await this.host.flushEditor();
          if (this.context !== context) return;
          const run = await active?.ready;
          const map = indexTree(this.context.session.projection.tree), parent = map.get(field.dataset.runParent);
          const base = run?.contentStart ?? parent?.children.find(n => field.dataset.runIds.split(',').includes(n.id) && n.span)?.span[0];
          if (base == null || !parent) return;
          const mapping = run || displayRun(parent.children.filter(n => field.dataset.runIds.split(',').includes(n.id)), this.context.session.text, base, parent.children.findLast(n => field.dataset.runIds.split(',').includes(n.id) && n.span)?.span[1] ?? base);
          const positions = offsets.map(at => run ? run.sourceOffset(at) : mapping.offsets[at]);
          const selected = parent.children.filter(n => n.span && n.span[0] < positions[1] && n.span[1] > positions[0]).map(n => n.id);
          if (selected.length) return this.host.command({ type: 'WrapSelection', ids: selected });
        };
      }
    }
    const anchor = { getBoundingClientRect: () => ({ right: e.clientX, bottom: e.clientY }) };
    const blockId = isBlock(row) ? row.id : row.parent_id;
    menu(anchor, [['详细设置', () => this.host.locate(row.id)], ['聚焦这个 block', () => { this.context.focus = blockId; this.render(this.context); }],
      ...(ids.length || wrap ? [['选区原位包组', wrap || (() => this.host.command({ type: 'WrapSelection', ids }))]] : [])]);
  }
  async flush() {
    // A focus transfer can leave the previous field's blur save in flight.
    // Drain all captured inputs before history/navigation retires their runs.
    const editors = [...this.inlineEditors];
    for (const active of editors) {
      await active.ready;
      let pending;
      do { pending = active.pending; await pending; } while (pending !== active.pending);
      await active.context.session.whenIdle();
    }
  }
  closeEditor() {
    for (const active of this.inlineEditors) { active.closed = true; active.off?.(); active.run?.dispose(); }
    this.inlineEditors.clear();
    if (this.inline) this.cache.clear(); this.inline = null;
  }
  startDrag(e, row, handle) {
    if (e.button !== 0 || !this.context.session.valid) return;
    e.preventDefault(); e.stopPropagation();
    const context = this.context;
    const prepared = this.host.flushEditor().then(() => {
      if (this.context !== context) throw new Error('编辑上下文已变化，请重新拖拽');
      return context.session.revision;
    }); prepared.catch(() => {});
    const descendants = new Set(); const collect = n => { descendants.add(n.id); n.children.forEach(collect); }; collect(row);
    const preview = new DropPreview(this.host);
    const sourceBox = handle.closest('[data-block-id]');
    let destination = null, started = false, expandTimer = null, hoverId = null;
    let trackPointer = () => {};
    const move = ev => {
      if (!started && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 5) return;
      started = true; sourceBox.classList.add('dragging'); trackPointer(ev);
      destination = this.context === context ? this.dropTarget(ev.clientX, ev.clientY, descendants) : null;
      const label = destination ? `移动 block · ${dropLocation(destination)}` : '';
      preview.show(destination, label, ev.clientX, ev.clientY);
      const hover = destination?.placement === 'inside' && context.folded.has(destination.parent.id) ? destination.parent.id : null;
      if (hover !== hoverId) {
        clearTimeout(expandTimer); hoverId = hover;
        if (hover) expandTimer = setTimeout(() => { context.folded.delete(hover); this.render(context); move(ev); }, 650);
      }
    };
    trackPointer = preview.autoScroll(this.container, move);
    const cancel = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cancel); document.removeEventListener('keydown', key); clearTimeout(expandTimer); sourceBox.classList.remove('dragging'); preview.destroy(); };
    const key = ev => { if (ev.key === 'Escape') { destination = null; cancel(); } };
    const up = async ev => {
      if (started && ev?.clientX != null) move(ev);
      const target = destination; cancel(); if (!target || !started || this.context !== context) return;
      try {
        const revision = await prepared;
        const entry = ['schedule', 'region'].includes(target.parent.form) ? await this.host.entryTarget(target.parent, target.command) : null;
        if (entry === false) return;
        await this.host.command({ type: 'MoveBlock', id: row.id, ...target.command, ...(entry ? { entry } : {}) }, revision);
      } catch (error) { report(error); }
    };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', cancel); document.addEventListener('keydown', key);
  }
}
