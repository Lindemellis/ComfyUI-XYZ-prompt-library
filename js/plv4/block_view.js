import { element, button, check, menu, report } from './ui.js';
import { indexTree, isBlock, nameOf } from './details.js';
import { blockFrame, blockLibraryPath } from './design_adapter.js';
import { attachInlineAutocomplete } from './inline_input.js';
import { blockPlacement, nearestBlockBoundary, dropLocation, DropPreview, isEntry, isContainer, canInsertContainer, canDropBlock } from './drop_preview.js';
import { inlineText, inlineOffset, inlinePoint, renderInlineEnd } from './text_input.js';
import { promptDisplay, displayRun, scheduleSource, separatorDisplay, normalizePromptInput, runEnd } from './prompt_text.js';
import { draftCompletions } from './text_draft.js';

// A focused TextRun is only a view into the parent session. Its IDs and history
// still belong to that document; this adapter never creates an AST container.
class RunSession {
  constructor(parent, ids, host, insertion = null, input = null) {
    this.parent = parent; this.ids = ids; this.host = host; this.input = input;
    const rows = this.rows().filter(n => n.span);
    if (!rows.length && !insertion) throw new Error('请先启用该文本段');
    const owner = indexTree(parent.projection.tree).get(rows[0]?.parent_id);
    this.range = insertion ? [insertion.at, insertion.at] : [rows[0].span[0], runEnd(rows, owner, parent.text)];
    this.prefix = insertion?.prefix || ''; this.activePrefix = '';
    this.suffix = insertion?.suffix || ''; this.activeSuffix = ''; this.insertAnchor = insertion?.anchor;
    this.source = parent.text; this.editing = false;
    this.owner = rows[0]?.parent_id || insertion?.owner;
    const map = indexTree(parent.projection.tree);
    this.canInsertRegion = canInsertContainer(map.get(this.owner), 'region', map);
    this.display = displayRun(rows, parent.text, this.contentStart, this.range[1]);
  }
  rows() { const map = indexTree(this.parent.projection.tree); return this.ids.map(id => map.get(id)).filter(Boolean); }
  get text() {
    return this.display.text;
  }
  sourceOffset(offset) { return this.display.offsets[Math.max(0, Math.min(offset, this.display.offsets.length - 1))] ?? this.contentStart; }
  get contentStart() { return this.range[0] + this.activePrefix.length; }
  suffixFor(text) { return text && this.suffix ? (/[.,]\s*$/.test(text) ? ' ' : this.suffix) : ''; }
  replacement(text) { const insert = (text ? this.prefix : '') + text + this.suffixFor(text); return this.source.slice(0, this.range[0]) + insert + this.source.slice(this.range[1]); }
  get revision() { return this.parent.revision; }
  get state() { return this.parent.state; }
  get projection() { return { diagnostics: this.parent.projection.diagnostics.filter(d => d.pos >= this.range[0] && d.pos <= this.range[1]).map(d => ({ ...d, pos: d.pos - this.range[0] })) }; }
  get valid() { return !this.disposed && this.parent.valid; }
  dispose() { this.disposed = true; }
  async whenIdle() {
    // Native input first queues drafts on the field, then on the document.
    // Waiting only for the document can miss the last keystroke and let a
    // completion compute its target before that draft advances the revision.
    let pending, queue;
    do {
      pending = this.input?.pending; await pending;
      queue = this.parent.whenIdle(); await queue;
    } while (!this.disposed && (pending !== this.input?.pending || queue !== this.parent.whenIdle()));
  }
  commitPool() { return this.parent.commitPool(); }
  replaceText(text, { deferPool = false, onDraft = () => {}, completion = null } = {}) {
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
        const completions = completion ? (Array.isArray(completion) ? completion : [completion]).map(value => ({ ...value, span: value.span.map(at => decoded.offsets[at] + start) })) : [];
        const result = await this.parent._apply({ type: 'ReplaceText', text: source, prompt_spans: decoded.promptSpans.map(span => span.map(at => at + start)), revision: this.parent.revision, ...(completions.length ? { completion: completions } : {}), ...(this.insertAnchor ? { insert_anchor: this.insertAnchor } : {}), ...(deferPool ? { defer_pool: true } : {}) });
        this.activePrefix = text ? this.prefix : '';
        this.activeSuffix = this.suffixFor(decoded.source);
        this.range[1] = this.contentStart + decoded.source.length + this.activeSuffix.length; this.source = this.parent.text;
        const owner = indexTree(this.parent.projection.tree).get(this.owner);
        if (owner && this.insertAnchor?.run_ids) this.insertAnchor.run_ids = owner.children.filter(row => this.insertAnchor.run_ids.includes(row.id) || (row.span && row.span[0] >= this.contentStart && row.span[1] <= this.range[1] - this.activeSuffix.length)).map(row => row.id);
        const current = owner ? displayRun(owner.children, this.source, this.contentStart, this.range[1] - this.activeSuffix.length) : this.display;
        this.display = { text, offsets: decoded.offsets.map(at => at + this.contentStart), originals: current.originals,
          separators: current.text === text ? current.separators : [] };
        return result;
      } finally { this.editing = false; }
    });
  }
  subscribe(listener) { return this.parent.subscribe(event => {
    if (!this.editing && this.parent.text !== this.source) {
      const view = this.host.blockView;
      const bookmark = view.captureFocus();
      view.closeEditor(); view.render(this.host.context);
      if (bookmark && !['Undo', 'Redo', 'LoadDocument'].includes(event.reason)) {
        if (view.pointerGesture) view.pendingFocus = bookmark;
        else view.restoreFocus(bookmark);
      }
      return;
    }
    listener(event);
  }); }
  undo() { return this.host.undo(); }
  redo() { return this.host.redo(); }
  compile(inputs) { return this.parent.compile(inputs); }
}

export class BlockView {
  constructor(container, host) {
    this.container = container; this.host = host; this.cache = new Map(); this.inlineEditors = new Set(); this.pendingToggles = new WeakMap();
    container.addEventListener('pointerdown', event => this.retainClickTarget(event), true);
    XYZPLv4Design.bindInlineInput(container, { capture: target => this.beginInline(target), input: (target, event) => { if (!event.isComposing) this.typeInline(target); }, commit: target => this.finishInline(target) });
    container.addEventListener('compositionstart', () => { this.composing = true; });
    container.addEventListener('compositionend', event => { this.composing = false; this.typeInline(event.target.closest?.('[data-run-input],[data-empty]') || event.target); });
    // A disabled item has no value, so the caret just before it and just after
    // it are the same offset. Native input (IME included) would land before it
    // and then jump behind it on redraw. A click or the first key of an input
    // moves a collapsed caret to the far side; arrow keys still pass through.
    container.addEventListener('pointerup', () => setTimeout(() => this.caretPastParked(), 0));
    container.addEventListener('keydown', event => {
      if (event.key === 'Process' || event.keyCode === 229 || (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey)) this.caretPastParked();
    }, true);
    container.addEventListener('beforeinput', event => {
      const field = event.target.closest?.('[data-run-input],[data-empty]');
      if (field) this.host.nativeInput(event, field);
    });
    container.addEventListener('contextmenu', event => {
      const field = event.target.closest?.('[data-run-input],[data-empty]');
      if (!field || field.contentEditable !== 'plaintext-only') return;
      event.preventDefault(); event.stopPropagation();
      const id = event.target.closest?.('[data-prompt-id]')?.dataset.promptId || field.dataset.runParent || field.dataset.empty;
      this.host.run(() => this.host.textContextMenu(event, this.map.get(id)));
    }, true);
    container.addEventListener('keydown', event => {
      if (!event.target.matches?.('[data-run-input],[data-prompt],[data-empty]') || event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); event.target.blur(); }
      else if (!(event.ctrlKey || event.metaKey) || !['z', 'y'].includes(event.key.toLowerCase())) {
        this.host.nativeKey(event);
        if (!event.defaultPrevented) event.stopPropagation();
      }
    });
  }
  caretPastParked() {
    const selection = getSelection();
    if (this.composing || !selection?.rangeCount || !selection.isCollapsed) return;
    const node = selection.anchorNode, at = selection.anchorOffset;
    const field = (node?.nodeType === 3 ? node.parentElement : node)?.closest?.('[data-run-input]');
    if (!field || !this.container.contains(field) || field.contentEditable !== 'plaintext-only' || !field.querySelector('[data-parked]')) return;
    const point = inlinePoint(field, inlineOffset(field, node, at));
    if (point[0] === node && point[1] === at) return;
    const range = document.createRange(); range.setStart(node, at);
    try { range.setEnd(...point); } catch { return; }
    if (range.collapsed || ![...field.querySelectorAll('[data-parked]')].some(parked => range.intersectsNode(parked))) return;
    selection.setBaseAndExtent(...point, ...point);
  }
  retainClickTarget(event) {
    if (event.button !== 0 || event.target.closest?.('.plv4-handle,.drag-handle')) return;
    this.releasePointer?.();
    const gesture = this.pointerGesture = { id: event.pointerId };
    gesture.done = new Promise(resolve => { gesture.resolve = resolve; });
    const release = event => {
      if (event && event.pointerId !== gesture.id) return;
      document.removeEventListener('pointerup', release, true);
      document.removeEventListener('pointercancel', release, true);
      setTimeout(() => {
        if (this.pointerGesture !== gesture) { gesture.resolve(); return; }
        this.pointerGesture = null; this.releasePointer = null;
        const context = this.pendingRender; this.pendingRender = null;
        const bookmark = this.pendingFocus && (this.captureFocus() || this.pendingFocus); this.pendingFocus = null;
        if (context && this.host.context === context) {
          this.render(context);
          if (bookmark) this.restoreFocus(bookmark);
        }
        gesture.resolve();
      }, 0);
    };
    this.releasePointer = release;
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
  }
  render(context) {
    if (this.pointerGesture && this.context === context) { this.pendingRender = context; return; }
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
    const selection = getSelection();
    const range = selection && !selection.isCollapsed && this.container.contains(selection.anchorNode) && this.container.contains(selection.focusNode)
      ? [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset] : null;
    // Collect the new top level, then reconcile it into the container in place.
    // Emptying the container detached every cached card, and the browser then
    // restyled and laid out the whole notebook for a change to one block.
    const sink = { nodes: [], append(...nodes) { this.nodes.push(...nodes); } };
    if (!session.valid) {
      sink.append(element('div', 'plv4-empty plv4-error', '原稿未完成。切换到 PLv3 修复；关闭项仍保存在文档中。'));
      this.place(sink.nodes); return;
    }
    let root = map.get(context.focus) || session.projection.tree;
    if (context.focus && root.form !== 'root') {
      const path = element('div', 'plv4-path');
      const ancestors = []; for (let n = root; n; n = map.get(n.parent_id)) ancestors.unshift(n);
      for (const n of ancestors) path.append(button(n.form === 'root' ? 'Document' : nameOf(n) || 'Block', '返回父级', () => { context.focus = n.form === 'root' ? null : n.id; this.render(context); }));
      sink.append(path);
    }
    if (root.form === 'root') this.contents(root, sink, 0);
    else sink.append(this.block(root, 0));
    const target = context.asset && root.form === 'root' && root.children.length ? root.children[0] : root;
    sink.append(this.addFooter(target));
    this.place(sink.nodes);
    if (this.container.scrollTop !== scroll) this.container.scrollTop = scroll;
    // Reusing cached cards briefly detaches their text nodes. Browser ranges
    // collapse during that detach even when every character stays unchanged.
    if (range && this.container.contains(range[0]) && this.container.contains(range[2])) selection.setBaseAndExtent(...range);
    for (const id of this.cache.keys()) if (!map.has(id)) this.cache.delete(id);
  }
  // Make the container's children exactly `nodes`, leaving every node that is
  // already in position attached. Cached cards then keep their style and layout.
  place(nodes) {
    const keep = new Set(nodes);
    let at = this.container.firstChild;
    const drop = () => { while (at && !keep.has(at)) { const next = at.nextSibling; at.remove(); at = next; } };
    for (const node of nodes) {
      drop();
      if (node === at) { at = at.nextSibling; continue; }
      this.container.insertBefore(node, at);
    }
    while (at) { const next = at.nextSibling; at.remove(); at = next; }
  }
  addFooter(target) {
    const footer = element('div', 'block-add-footer');
    const entry = isContainer(target);
    footer.append(button(entry ? '＋ 添加 entry' : '＋ 添加 block', entry ? '添加 entry' : '添加普通 block',
      () => this.host.addBlock(target.id, true), 'small-add'));
    const forms = ['region', 'schedule', 'avg'].filter(form => canInsertContainer(target, form, this.map));
    if (forms.length) {
      const labels = { region: 'Region 容器', schedule: 'Schedule 容器', avg: 'AVG 容器' };
      const toggle = button('▾', '选择添加 block 的类型', () => menu(toggle,
        [['普通 block', () => this.host.addBlock(target.id, true)],
          ...forms.map(form => [labels[form], () => this.host.addBlock(target.id, true, form)])]), 'small-add block-add-types');
      toggle.setAttribute('aria-haspopup', 'menu');
      toggle.setAttribute('aria-label', '选择添加 block 的类型');
      footer.append(toggle);
    }
    for (const control of footer.querySelectorAll('button')) control.onpointerdown = event => this.retainInlineFocus(event);
    return footer;
  }
  retainInlineFocus(event) { if (event.button === 0 && this.inline?.element === document.activeElement) event.preventDefault(); }
  contents(row, container, depth) {
    const children = row.children.filter(child => !child.meta?.lora_invocation);
    let run = [];
    const flush = next => { if (!run.length) return; container.append(this.textRun(run, depth, next)); run = []; };
    for (const [index, child] of children.entries()) {
      if (isBlock(child)) {
        flush(child.id); container.append(this.boundary(row.id, child.id), this.block(child, depth));
        const next = children[index + 1]; if (next && !isBlock(next)) container.append(this.boundary(row.id, next.id));
        if ((!next || isBlock(next)) && !isContainer(row) && !(row.form === 'root' && this.context.asset)) container.append(this.emptyInput(row, child.id, next?.id));
      }
      else run.push(child);
    }
    flush();
    if (!['schedule', 'region', 'avg'].includes(row.form) && !children.length) container.append(this.emptyInput(row));
    container.append(this.boundary(row.id));
  }
  block(row, depth) {
    const key = this.signatures.get(row.id);
    const libraryPath = blockLibraryPath(row, this.host.library);
    const poolAsset = this.host.library.data?.assets?.find(asset => asset.kind === 'class' && asset.id === row.meta?.pool);
    const folder = poolAsset ? { name: poolAsset.name, path: this.host.library.path(poolAsset) } : null;
    const poolLabel = JSON.stringify(folder);
    const cached = this.cache.get(row.id);
    if (cached?.key === key && cached.depth === depth && cached.libraryPath === libraryPath && cached.poolLabel === poolLabel) {
      cached.box.classList.toggle('selected', this.context.session.state.selection.block_id === row.id);
      this.toggleFeedback(cached.box, row);
      return cached.box;
    }
    const folded = this.context.folded.has(row.id);
    const libraryRoot = this.context.asset && row.parent_id === this.context.session.projection.tree.id;
    const box = blockFrame(row, depth, folded, this.context.session.state.selection.block_id, libraryRoot, libraryPath, folder);
    for (const link of box.querySelectorAll('[data-open-folder]')) link.onclick = event => {
      event.stopPropagation(); this.host.run(() => this.host.openFolder(link.dataset.openFolder));
    };
    const lora = box.querySelector('[data-open-lora]');
    if (lora) lora.onclick = event => { event.stopPropagation(); this.host.run(() => this.host.openLoraDetails(lora.dataset.openLora)); };
    const fold = box.querySelector('[data-fold]');
    fold.onclick = () => { if (folded) this.context.folded.delete(row.id); else this.context.folded.add(row.id); this.render(this.context); };
    box.querySelector('[data-header-toggle]').onclick = () => this.host.run(() => this.toggleBlock(row));
    this.toggleFeedback(box, row);
    box.querySelector('[data-detail]').onclick = () => this.host.run(() => this.selectBlock(row.id));
    const sibling = box.querySelector('[data-sibling]');
    if (sibling) {
      sibling.title = sibling.ariaLabel = isEntry(row) ? ({ schedule_entry: '添加同级阶段', region_entry: '添加同级区域', avg_entry: '添加同级 AVG entry' }[row.form]) : '添加同级 block';
      sibling.onclick = () => this.host.run(() => this.host.addBlock(row.id, false));
      sibling.onpointerdown = event => this.retainInlineFocus(event);
    }
    const child = box.querySelector('[data-child]');
    child.title = child.ariaLabel = isContainer(row) ? ({ schedule: '添加阶段', region: '添加区域', avg: '添加 AVG entry' }[row.form]) : '添加子 block';
    child.onclick = () => this.host.run(() => this.host.addBlock(row.id, true));
    child.onpointerdown = event => this.retainInlineFocus(event);
    const more = box.querySelector('[data-block-menu]');
    // Blur can rebuild this header between pointerdown and click. Keep the
    // text host focused until the menu opens, then commit its blur normally.
    more.onpointerdown = event => this.retainInlineFocus(event);
    more.onclick = e => {
      menu(e.currentTarget, this.menuItems(row, libraryRoot));
      this.inline?.element.blur();
    };
    const handle = box.querySelector('.plv4-handle'); handle.dataset.dragId = row.id;
    if (!libraryRoot && row.form !== 'avg_entry') handle.onpointerdown = e => this.startDrag(e, row, handle);
    if (row.form === 'avg_entry') { handle.disabled = true; handle.hidden = true; }
    const body = box.querySelector('.block-body');
    if (body) {
      this.contents(row, body, depth + 1);
    }
    box.onclick = e => { e.stopPropagation(); if (!e.target.closest('button,input,[contenteditable],.plv4-handle')) this.host.run(() => this.selectBlock(row.id)); };
    box.oncontextmenu = e => {
      if (e.target.closest('.plv4-block') !== box || e.target.closest('.plv4-prompt')) return;
      e.preventDefault(); e.stopPropagation(); this.contextMenu(e, row);
    };
    this.cache.set(row.id, { key, depth, libraryPath, poolLabel, box }); return box;
  }
  toggleFeedback(box, row) {
    const pending = this.pendingToggles.get(this.context)?.get(row.id), active = !!pending;
    const parent = this.map.get(row.parent_id), parentOn = !parent || parent.effective;
    const toggle = box.querySelector('[data-header-toggle]');
    toggle.setAttribute('aria-pressed', String(active ? pending.enabled : row.enabled));
    toggle.disabled = active || !parentOn;
    box.classList.toggle('effectively-off', active ? !pending.enabled || !parentOn : !row.effective);
    box.toggleAttribute('data-pending-toggle', active);
    if (active) box.setAttribute('aria-busy', 'true'); else box.removeAttribute('aria-busy');
  }
  async toggleBlock(row) {
    const context = this.context;
    let toggles = this.pendingToggles.get(context);
    if (!toggles) { toggles = new Map(); this.pendingToggles.set(context, toggles); }
    if (toggles.has(row.id)) return;
    const enabled = !row.enabled;
    toggles.set(row.id, { enabled });
    const box = this.cache.get(row.id)?.box; if (box) this.toggleFeedback(box, row);
    try { return await this.host.command({ type: 'SetEnabled', id: row.id, enabled }); }
    finally {
      toggles.delete(row.id);
      if (this.context === context) {
        const current = this.cache.get(row.id)?.box, value = this.map.get(row.id);
        if (current && value) this.toggleFeedback(current, value);
      }
    }
  }
  menuItems(row, libraryRoot = false) {
    const items = [], parent = this.map.get(row.parent_id);
    for (const [label, child, target] of [['添加同级 Block', false, libraryRoot ? null : parent], ['添加子 Block', true, row]]) {
      const options = ['schedule', 'region', 'avg'].filter(form => canInsertContainer(target, form, this.map));
      if (!options.length) continue;
      items.push([label, [
        ['普通 Block', () => this.host.addBlock(row.id, child)],
        ...options.map(form => [{ schedule: 'Schedule 容器', region: 'Region 容器', avg: 'AVG 容器' }[form], () => this.host.addBlock(row.id, child, form)]),
      ]]);
    }
    if (items.length) items.push(['', null]);
    if (!isEntry(row)) items.push(['Save', () => this.host.libraryAction('save', row)]);
    items.push(['Delete', () => this.host.command({ type: 'Delete', id: row.id })]);
    if (!isContainer(row) && !row.meta?.lora) items.push(['绑定池', () => this.host.libraryAction('pool', row)]);
    return items;
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
  dropTarget(x, y, excluded = new Set(), moving = null) {
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
    if (!canDropBlock(parent, moving)) return null;
    if (placement === 'inside' && !highlight && box) highlight = box;
    const names = []; for (let row = parent; row; row = this.map.get(row.parent_id)) names.unshift(nameOf(row) || (row.form === 'root' ? 'Document' : 'Block'));
    const anchor = this.map.get(command.before_id || command.after_id);
    return { parent, owner, command: { parent_id: parent.id, ...command }, placement, highlight, path: names.join(' / '), anchorName: anchor && (nameOf(anchor) || 'Block') };
  }
  textRun(rows, depth, next = '') {
    const run = element('div', 'plv4-run'); run.dataset.runIds = rows.map(n => n.id).join(','); run.dataset.depth = depth;
    run.dataset.runInput = ''; run.dataset.runParent = rows[0].parent_id;
    const siblings = this.map.get(rows[0].parent_id).children;
    run.dataset.afterBlock = siblings.slice(0, siblings.findIndex(row => row.id === rows[0].id)).findLast(isBlock)?.id || '';
    run.dataset.beforeBlock = next;
    run.contentEditable = rows.some(row => row.effective) ? 'plaintext-only' : 'false';
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
        else if (i < rows.length - 1) {
          // A wholly disabled run (its block switched off) shows the document's
          // own separators, so typed line breaks stay visible; layout
          // indentation still collapses exactly as in the live view.
          const own = lastLive < 0 && row.sep ? separatorDisplay(row.sep, 0, row.sep.length).text : '';
          span.append(document.createTextNode(/\n/.test(own) ? own : separator(row.source)));
        }
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
    renderInlineEnd(run);
    run.onclick = e => {
      e.stopPropagation();
      const id = e.target.closest?.('[data-prompt-id]')?.dataset.promptId || run.dataset.runParent;
      this.host.run(() => this.host.locate(id));
    };
    run.oncontextmenu = e => { e.preventDefault(); e.stopPropagation(); this.contextMenu(e, this.map.get(run.dataset.runParent)); };
    return run;
  }
  emptyInput(row, after = '', before = '') {
    const template = document.createElement('template'); template.innerHTML = XYZPLv4Design.emptyHTML(row.id);
    const field = template.content.firstElementChild;
    if (after) {
      field.classList.add('plv4-text-slot'); field.dataset.textSlot = 'after'; field.dataset.afterBlock = after;
      if (before) field.dataset.beforeBlock = before;
      field.dataset.placeholder = before ? '在两个 Block 之间输入 prompt…' : '在此继续输入 prompt…';
      field.setAttribute('aria-label', before ? '在子 Block 之间输入正文' : '在子 Block 后继续输入正文');
    }
    if (!row.effective) field.contentEditable = 'false';
    field.onclick = e => { e.stopPropagation(); this.host.run(() => this.host.locate(row.id)); };
    if (!after) return field;
    const slot = element('div', 'plv4-text-insert');
    field.hidden = true;
    const add = button('＋ 正文', field.getAttribute('aria-label'), () => {
      this.expandTextInput(field); field.focus({ preventScroll: true });
    }, 'plv4-text-insert-button');
    add.disabled = !row.effective;
    add.setAttribute('aria-expanded', 'false');
    add.onpointerdown = event => this.retainInlineFocus(event);
    slot.append(add, field);
    return slot;
  }
  expandTextInput(field) {
    if (!field.hidden || !field.dataset.textSlot) return;
    field.hidden = false;
    const slot = field.parentElement;
    slot.classList.add('expanded');
    slot.querySelector('button').setAttribute('aria-expanded', 'true');
  }
  beginInline(element) {
    if (this.inline?.element === element || element.contentEditable !== 'plaintext-only') return;
    if (!this.context.session.valid && this.inline?.element.isConnected) { this.inline.element.focus({ preventScroll: true }); return; }
    const previous = this.inline;
    this.inline?.off?.();
    const context = this.context;
    const initialText = normalizePromptInput(inlineText(element));
    const active = { element, context, pending: Promise.resolve(), changed: false, initialText, draft: initialText, completions: [] };
    this.inlineEditors.add(active);
    this.inline = active;
    active.ready = (previous?.finishing || previous?.pending || Promise.resolve()).then(() => context.session.whenIdle()).then(async () => {
      if (active.closed || this.context !== context || !element.isConnected || this.inline !== active) return null;
      if (previous?.changed && previous.closed && context.session.valid) {
        // Moving directly into another run must also show the retired run's
        // new blocks. Keep the destination's native DOM/draft and selection.
        await this.pointerGesture?.done;
        if (active.closed || this.context !== context || this.inline !== active) return null;
        const bookmark = this.captureFocus(element);
        this.inline = null; this.render(context);
        const replacement = this.fieldFor(bookmark);
        if (!replacement || (replacement !== element && inlineText(replacement) !== active.initialText)) {
          active.closed = true; this.inlineEditors.delete(active);
          if (bookmark) this.restoreFocus(bookmark);
          return null;
        }
        if (replacement !== element) { Object.assign(element.dataset, replacement.dataset); replacement.replaceWith(element); }
        this.inline = active;
        element.focus({ preventScroll: true });
        if (bookmark?.offsets) getSelection().setBaseAndExtent(...inlinePoint(element, bookmark.offsets[0]), ...inlinePoint(element, bookmark.offsets[1]));
      }
      if (!context.session.valid && previous?.element.isConnected) {
        active.closed = true; this.inlineEditors.delete(active); this.inline = previous;
        previous.off = previous.run?.subscribe(() => {}); previous.element.focus({ preventScroll: true });
        return null;
      }
      const map = indexTree(context.session.projection.tree); let insertion = null;
      let ids = element.dataset.runIds?.split(',').filter(Boolean) || (element.dataset.prompt ? [element.dataset.prompt] : []);
      if (element.hasAttribute('data-run-input')) {
        // Typing can remove every old item or replace its IDs while the native
        // field stays mounted. Its structural neighbours still own this gap.
        const owner = map.get(element.dataset.runParent);
        const children = owner?.children || [];
        const after = element.dataset.afterBlock, before = element.dataset.beforeBlock;
        const start = after ? children.findIndex(row => row.id === after) + 1 : 0;
        const end = before ? children.findIndex(row => row.id === before) : children.length;
        ids = children.slice(start, end < 0 ? children.length : end).filter(row => !isBlock(row) && !row.meta?.lora_invocation).map(row => row.id);
        element.dataset.runIds = ids.join(',');
      }
      if (element.dataset.empty || (element.hasAttribute('data-run-input') && !ids.some(id => map.get(id)?.span))) {
        const row = map.get(element.dataset.empty || element.dataset.runParent); const content = row?.effective && row.ast?.spans.content;
        if (!content) throw new Error('请先启用该 block');
        const last = row.children.filter(n => n.effective).at(-1);
        const gap = context.session.text.slice(last?.span?.[1] ?? content[0], content[1]);
        insertion = { at: content[1], owner: row.id, prefix: last && !gap.includes(',') ? (last.source.trimEnd().endsWith('.') ? ' ' : ', ') : '' };
        if (element.dataset.textSlot || element.hasAttribute('data-run-input')) {
          const before = element.dataset.beforeBlock;
          if (before) {
            const index = row.children.findIndex(n => n.id === before);
            const right = row.children.slice(index).find(n => n.effective && n.span);
            const left = row.children.slice(0,index).filter(n => n.effective && n.span).at(-1);
            let at = left?.span[1] ?? content[0];
            const limit = right?.span[0] ?? content[1];
            while (at < limit && /[\s,]/.test(context.session.text[at])) at++;
            const gap = context.session.text.slice(left?.span[1] ?? content[0],at);
            insertion = { at, owner:row.id, prefix:left && !gap.includes(',') && !left.source.trimEnd().endsWith('.') ? ', ' : '', suffix:right ? ', ' : '', anchor:{parent_id:row.id,before_id:before} };
          } else insertion.anchor = {parent_id:row.id,edge:'end'};
        }
      }
      active.run = new RunSession(context.session, ids, this.host, insertion, active);
      if (element.hasAttribute('data-run-input') && !insertion) active.run.insertAnchor = { parent_id: active.run.owner, run_ids: ids, ...(element.dataset.beforeBlock ? { before_id: element.dataset.beforeBlock } : { edge: 'end' }) };
      if (this.inline === active) active.off = active.run.subscribe(() => {});
      attachInlineAutocomplete(element, active.run).catch(report);
      return active.run;
    });
    active.ready.catch(report);
  }
  typeInline(element) {
    const active = this.inline; if (!active || active.element !== element) return;
    const text = normalizePromptInput(inlineText(element)), completion = element._xyzTagCompletion; active.changed = true;
    active.completions = draftCompletions(active.draft, text, active.completions, completion);
    active.draft = text;
    // Persist the raw workflow draft without reconciling the Document or
    // refreshing Settings. Blur/navigation commits the whole field once.
    active.ready.then(run => {
      if (active.closed || !run || run.disposed || !active.context.node) return;
      const decoded = scheduleSource(active.draft, run.display.originals, run.display);
      this.host.sessions.persist(active.context, run.replacement(decoded.source));
    }).catch(report);
  }
  commitInline(active) {
    active.pending = active.pending.catch(() => {}).then(async () => {
      if (active.closed) return;
      const run = await active.ready;
      if (active.closed || !run || run.disposed) return;
      const text = active.draft, completion = active.completions;
      if (text === run.text) return;
      await run.replaceText(text, { deferPool: true, completion, onDraft: source => {
        if (active.context.node) this.host.sessions.persist(active.context, source);
      } });
      if (active.draft === text) active.completions = [];
    });
    return active.pending;
  }
  finishInline(element) {
    const active = this.inline; if (!active || active.element !== element) return Promise.resolve();
    // Header focus and the native blur must retire the same run once. A new
    // focus may only read ranges after this retirement/rebuild has completed.
    return active.finishing ||= this.finishCapturedInline(active);
  }
  async finishCapturedInline(active) {
    const element = active.element;
    let keepDraft = false;
    try {
      if (active.changed) this.typeInline(element);
      await this.commitInline(active);
      if (active.closed) return;
      // An unfinished construct stays editable in place. Switching to Source
      // still retires this run through the normal view/navigation lifecycle.
      if (!active.context.session.valid) { keepDraft = true; return; }
      if (element.dataset.textSlot && !inlineText(element)) {
        element.hidden = true;
        element.parentElement.classList.remove('expanded');
        element.parentElement.querySelector('button').setAttribute('aria-expanded', 'false');
      }
      await active.context.session.commitPool();
      if (this.inline === active) {
        if (active.changed) { this.closeEditor(); this.render(active.context); }
        else this.inline = null;
      }
    } catch (error) { keepDraft = true; if (!active.closed) report(error); }
    finally {
      if (keepDraft) active.finishing = null;
      else { active.closed = true; active.off?.(); active.run?.dispose(); this.inlineEditors.delete(active); }
    }
  }
  async selectBlock(id) {
    const context = this.context, active = this.inline, gesture = this.pointerGesture;
    await this.host.locate(id);
    if (active && document.activeElement !== active.element) await (active.finishing || this.finishInline(active.element));
    // Render is deferred until the pressed header receives its native click.
    // Refocusing the old DOM before that render pairs new ranges with old text.
    await gesture?.done;
    if (this.context !== context || context.session.state.selection.block_id !== id) return;
    const selection = getSelection();
    if (selection && !selection.isCollapsed && this.container.contains(selection.anchorNode) && this.container.contains(selection.focusNode)) return;
    this.focusInput(id, false);
    // Containers have no direct prompt: keep their selection while giving the
    // IME an actual text host in their first enabled entry.
    if (!this.container.contains(document.activeElement) || document.activeElement.contentEditable !== 'plaintext-only') {
      const box = [...this.container.querySelectorAll('[data-block-id]')].find(box => box.dataset.blockId === id);
      const field = [...(box?.querySelectorAll('[data-run-input],[data-empty]') || [])].find(field => field.contentEditable === 'plaintext-only' && !field.hidden);
      if (field) field.focus({ preventScroll: true });
    }
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
    return { prompt: field.dataset.prompt, runIds: ids, empty: field.dataset.empty, afterBlock: field.dataset.afterBlock || '', beforeBlock: field.dataset.beforeBlock || '', offsets, ancestors };
  }
  restoreTextSelection(span) {
    for (const field of this.container.querySelectorAll('[data-run-input]')) {
      if (field.contentEditable !== 'plaintext-only') continue;
      const rows = field.dataset.runIds.split(',').map(id => this.map.get(id)).filter(row => row?.effective && row.span);
      if (!rows.length) continue;
      const start = rows[0].span[0], end = runEnd(rows, this.map.get(rows[0].parent_id), this.context.session.text);
      if (span[0] < start || span[1] > end) continue;
      const display = displayRun(rows, this.context.session.text, start, end);
      const offsets = span.map(at => { const index = display.offsets.findIndex(offset => offset >= at); return index < 0 ? display.text.length : index; });
      this.restoreFocus({ runIds: rows.map(row => row.id), offsets });
      return;
    }
  }
  fieldFor(bookmark) {
    if (!bookmark) return null;
    const fields = [...this.container.querySelectorAll('[data-run-input],[data-prompt],[data-empty]')];
    return fields.find(node => node.contentEditable === 'plaintext-only' && (bookmark.runIds?.length ? node.dataset.runIds?.split(',').some(id => bookmark.runIds.includes(id)) : bookmark.prompt ? node.dataset.prompt === bookmark.prompt : node.dataset.empty === bookmark.empty &&
      (bookmark.afterBlock == null || (node.dataset.afterBlock || '') === bookmark.afterBlock) && (bookmark.beforeBlock == null || (node.dataset.beforeBlock || '') === bookmark.beforeBlock)));
  }
  restoreFocus(bookmark) {
    const field = this.fieldFor(bookmark);
    if (!field) {
      const map = indexTree(this.context.session.projection.tree);
      const parent = bookmark.ancestors.map(id => map.get(id)).find(row => row && (row.form === 'root' || isBlock(row)));
      if (parent) this.focusInput(parent.id);
      if (!this.container.contains(document.activeElement)) this.host.shell.win.el.focus({ preventScroll: true });
      return;
    }
    this.expandTextInput(field); field.focus({ preventScroll: true }); this.beginInline(field);
    const point = offset => {
      return inlinePoint(field, offset);
    };
    const offsets = bookmark.offsets || [inlineText(field).length, inlineText(field).length];
    const range = document.createRange(); range.setStart(...point(offsets[0])); range.setEnd(...point(offsets[1]));
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
  }
  focusInput(id, allowInsert = true) {
    const box = [...this.container.querySelectorAll('[data-block-id]')].find(n => n.dataset.blockId === id) || this.container;
    let field = [...box.querySelectorAll('[data-empty],[data-run-input],[data-prompt]')].filter(n => n.closest('[data-block-id]') === (box === this.container ? null : box) && n.contentEditable === 'plaintext-only' && (allowInsert || !n.hidden)).at(-1);
    if (!field) {
      if (!allowInsert) return;
      const row = indexTree(this.context.session.projection.tree).get(id);
      if (!row?.effective || ['schedule', 'region', 'avg'].includes(row.form)) return;
      const body = box === this.container ? box : box.querySelector(':scope > .block-content > .block-body');
      if (!body) return;
      field = this.emptyInput(row); body.append(field);
    }
    if (field) { this.expandTextInput(field); field.focus({ preventScroll: true }); const range = document.createRange(); range.selectNodeContents(field); range.collapse(false); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }
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
    menu(anchor, [['详细设置', () => this.host.locate(row.id, { reveal: true })], ['聚焦这个 block', () => { this.context.focus = blockId; this.render(this.context); }],
      ...(ids.length || wrap ? [['选区原位包组', wrap || (() => this.host.command({ type: 'WrapSelection', ids }))]] : [])]);
  }
  async flush() {
    // A focus transfer can leave the previous field's blur save in flight.
    // Drain all captured inputs before history/navigation retires their runs.
    const editors = [...this.inlineEditors];
    for (const active of editors) {
      await active.ready;
      do { await this.commitInline(active); } while (!active.closed && active.run && active.draft !== active.run.text);
      let pending;
      do { pending = active.pending; await pending; } while (pending !== active.pending);
      await active.finishing;
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
      destination = this.context === context ? this.dropTarget(ev.clientX, ev.clientY, descendants, row) : null;
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
        const entry = isContainer(target.parent) ? await this.host.entryTarget(target.parent, target.command, true) : null;
        if (entry === false) return;
        await this.host.command({ type: 'MoveBlock', id: row.id, ...target.command, ...(entry ? { entry } : {}) }, revision);
      } catch (error) { report(error); }
    };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', cancel); document.addEventListener('keydown', key);
  }
}
