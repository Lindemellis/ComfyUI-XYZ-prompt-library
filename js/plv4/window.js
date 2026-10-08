import { PromptEditor, acquireNodeModel, releaseNodeModel } from '../plv3/editor_core.js';
import { showForm, toast, showConfirm } from '../plv3/ui.js';
import { bindPromptEditor } from './prompt_editor_binding.js';
import { NodeSessions, NODE_TYPES } from './host_sessions.js';
import { WindowShell, element, button, menu, report } from './ui.js';
import { DetailsPane, indexTree } from './details.js';
import { BlockView } from './block_view.js';
import { LibraryPanel } from './library_panel.js';
import { FolderPage } from './folder_page.js';
import { libraryRequest } from './asset_client.js';
import './completion.js';
import { ownHistoryKey, installWorkflowUndoGuard } from './history_shortcuts.js';
import { showEditorContextMenu, showEditorFind } from '../plv3/text_editing.js';
import { inlineText, inlineOffset, inlinePoint } from './text_input.js';
import { displayRun } from './prompt_text.js';
import { blockFindSpans, highlightBlockFindMatch, clearBlockFindHighlight } from './block_find.js';

export class PLv4Window {
  constructor(app) { this.app = app; this.sessions = new NodeSessions(app); this.generation = 0; this.visible = false; this.context = null; this.seedNode = null; this.libraryTabs = new Map(); this.closedNodes = new Set(); }
  build() {
    if (this.shell) return;
    this.shell = new WindowShell(() => this.pane?.relayout());
    this.shell.win.el.tabIndex = -1;
    const bar = this.shell.win.bar;
    bar.append(button('☷ Library', '展开 / 收起 Library', () => { this.shell.toggle('library'); if (!this.shell.library.hidden) this.library.reload(); }, 'window-pane-button'),
      button('▥ Details', '展开 / 收起 Details', () => this.toggleDetails(), 'window-pane-button'), button('×', '关闭窗口', () => this.hide(), 'tiny-button'));
    this.tabs = element('div', 'plv4-row plv4-tabs'); this.tablist = element('div', 'plv4-tablist');
    this.tabs.append(this.tablist, button('▾', '全部标签', e => menu(e.currentTarget, this.tabEntries().map(tab => [tab.title, () => this.selectTab(tab)])), 'overflow'));
    this.tablist.setAttribute('role', 'tablist');
    this.modes = element('div', 'plv4-row plv4-modes');
    this.folderNameControl = element('div'); this.folderNameControl.id = 'folder-name-setting'; this.folderNameControl.hidden = true; this.modes.append(this.folderNameControl);
    for (const [mode, label] of [['block', 'Blocks'], ['syntax', 'Source'], ['preview', 'Preview']]) this.modes.append(button(label, label, () => this.setView(mode), `mode plv4-mode-${mode}`));
    const right = element('div', 'modebar-right');
    right.append(button('↶', '撤销', () => this.undo(), 'tiny-button'), button('↷', '重做', () => this.redo(), 'tiny-button')); this.modes.append(right);
    this.syntax = element('div', 'plv4-scroll'); this.syntax.style.position = 'relative';
    this.blocks = element('div', 'plv4-scroll plv4-blocks');
    this.blocks.onscroll = () => { if (this.context?.session.view === 'block') this.context.scroll = this.blocks.scrollTop; };
    this.output = element('div', 'plv4-scroll'); this.status = element('div', 'plv4-status');
    this.shell.center.append(this.tabs, this.modes, this.syntax, this.blocks, this.output);
    this.status.classList.add('window-statusbar'); this.shell.win.el.insertBefore(this.status, this.shell.win.body.nextSibling);
    this.details = new DetailsPane(this.shell.details, this); this.blockView = new BlockView(this.blocks, this); this.library = new LibraryPanel(this.shell.library, this);
    this.folderContainer = element('div', 'plv4-scroll notebook'); this.folderContainer.hidden = true; this.shell.center.append(this.folderContainer);
    this.folderPage = new FolderPage(this.folderContainer, this);
    window.addEventListener('keydown', e => {
      // ComfyUI handles shortcuts during document capture. Handle this window's
      // history first, including contenteditable fields and floating Monaco.
      if (!this.visible || !this.shell.win.el.contains(e.target) || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y') {
        installWorkflowUndoGuard(window.comfyAPI?.changeTracker?.ChangeTracker); ownHistoryKey(e);
        if (e.target.closest?.('.find-widget')) return;
        // PLv3's PromptEditor already owns Monaco keyboard/context-menu undo.
        // Let that working route reach the shared model's document binding.
        if (this.syntax.contains(e.target) && this.pane?.editor?.hasTextFocus()) return;
        e.preventDefault(); e.stopImmediatePropagation(); this.run(() => e.key.toLowerCase() === 'y' || e.shiftKey ? this.redo() : this.undo());
      }
    }, true);
    window.addEventListener('keydown', e => {
      if (!this.visible || this.context?.session.view !== 'block' || !this.shell.win.el.contains(e.target)) return;
      const ctrl = (e.ctrlKey || e.metaKey) && !e.altKey, key = e.key.toLowerCase();
      if (ctrl && ['f', 'h'].includes(key)) {
        e.preventDefault(); e.stopImmediatePropagation();
        this.run(() => key === 'h' && e.shiftKey ? this.runTextAction('plv3.replaceInTags') : this.openBlockFind(key === 'h'));
      } else if (key === 'f3') {
        e.preventDefault(); e.stopImmediatePropagation();
        const find = this.pane?.editor.getContribution('editor.contrib.findController');
        if (find?.getState().isRevealed) e.shiftKey ? find.moveToPrevMatch() : find.moveToNextMatch();
        else this.run(() => this.openBlockFind(false));
      } else if (ctrl && ['arrowup', 'arrowdown'].includes(key) && this.blocks.contains(e.target)) {
        e.preventDefault(); e.stopImmediatePropagation();
        this.run(() => this.runTextAction(key === 'arrowup' ? 'plv3.weightUp' : 'plv3.weightDown'));
      }
    }, true);
  }
  nodes() { return (this.app.graph?._nodes || []).filter(n => NODE_TYPES.has(n.comfyClass)); }
  async toggle(node) { if (this.visible && (!node || node === this.context?.node)) return this.hide(); return this.open(node); }
  transition(action) {
    const run = (this._transition || Promise.resolve()).then(action);
    this._transition = run.catch(() => {}); return run;
  }
  open(node = null) { return this.transition(() => this._open(node)); }
  async _open(node = null) {
    this.build(); await this.shell.designReady; this.sessions.prune();
    node ??= this.context?.node && this.nodes().includes(this.context.node) ? this.context.node : this.nodes()[0];
    if (!node) { this.visible = true; this.shell.win.show(); this.status.textContent = '工作流中暂无 Prompt Library 节点'; return; }
    if (this.context?.asset && !this.context.session.valid) throw new Error('Library block 原稿必须保留一个有效根 block；请先修复');
    const token = ++this.generation; await this.flushEditor();
    const context = await this.sessions.get(node); if (token !== this.generation) return;
    this.closedNodes.delete(node);
    this.seedNode = node; await this.activate(context);
  }
  async activate(context) {
    this.build(); await this.shell.designReady;
    await this.detach(); this.context = context;
    this.folderContext = null; this.folderContainer.hidden = true; this.folderContainer.style.display = 'none'; this.modes.style.display = 'flex';
    this.visible = true; this.shell.win.show();
    if (!this.pane) {
      this.pane = new PromptEditor(this.syntax, { params: () => this.inputs(), syncOnBlur: false });
      // Document commands already return parser/validation markers. Compile on
      // demand in Output preview, not after every keystroke in a hidden editor.
      this.pane.lintCompile = false;
      await this.pane.init(); const initial = this.pane.model(); this.pane.setModel(null); initial?.dispose();
      this.pane.onCreateBlock = () => this.createAsBlock();
      this.pane.onFindText = replace => this.context?.session.view === 'block' ? this.openBlockFind(replace) : this.pane.editor.getAction(replace ? 'editor.action.startFindReplaceAction' : 'actions.find').run();
      this.pane.editor.addAction({ id: 'plv4.locateDetails', label: 'PLv4: 定位详细设置', contextMenuGroupId: 'navigation', run: () => {
        const offset = this.pane.model().getOffsetAt(this.pane.editor.getPosition());
        const rows = [...indexTree(this.context.session.projection.tree).values()].filter(n => n.span && n.span[0] <= offset && n.span[1] >= offset);
        const row = rows.at(-1); if (row) return this.locate(row.id);
      } });
    }
    if (context.node) {
      this.pane.setModel(acquireNodeModel(this.pane.monaco, context.node.id, context.session.text));
      this.modelNode = context.node; this.sessions.bind(context, this.pane);
    } else {
      this.libraryModel = this.pane.createModel(context.session.text); this.pane.setModel(this.libraryModel);
      this.libraryBinding = bindPromptEditor(this.pane, context.session, { onError: report });
    }
    if (context.syntaxState) this.pane.editor.restoreViewState(context.syntaxState);
    this.unsubscribe = context.session.subscribe(({ reason }) => this.changed(reason));
    if (!this.shell.library.hidden) await this.library.reload();
    this.renderTabs(); this.renderView(true); this.details.render(context.session); this.pane.scheduleLint();
  }
  async detach() {
    this.findBinding?.dispose(); this.findBinding = null;
    if (this.folderContext) { await this.folderPage.whenIdle(); this.folderPage.rememberView(); }
    if (!this.context) return;
    await this.flushEditor(); this.context.scroll = this.blocks.scrollTop; this.context.syntaxState = this.pane?.editor.saveViewState();
    this.unsubscribe?.(); this.unsubscribe = null; this.blockView?.closeEditor();
    if (this.modelNode) { this.sessions.unbind(this.context, this.pane); this.pane.setModel(null); releaseNodeModel(this.modelNode.id); this.modelNode = null; }
    if (this.libraryModel) { this.libraryBinding.dispose(); this.pane.setModel(null); this.libraryModel.dispose(); this.libraryBinding = null; this.libraryModel = null; }
  }
  hide() { return this.transition(async () => { await this.detach(); this.library.preview?.close(); this.visible = false; this.generation++; this.shell.win.hide(); }); }
  async setView(mode) {
    this.findBinding?.dispose(); this.findBinding = null;
    await this.flushEditor(); this.blockView.closeEditor();
    if (this.context?.session.view === 'block') this.context.scroll = this.blocks.scrollTop;
    if (this.context?.session.view === 'syntax') this.context.syntaxState = this.pane.editor.saveViewState();
    this.context?.session.setView(mode);
  }
  changed(reason) {
    if (!this.visible || !this.context) return;
    if (this.context.asset && !['View', 'LocateDetails', 'SyncPool'].includes(reason)) {
      this.context.edited = true; this.pinLibraryTab(`block:${this.context.key}`);
    }
    if (reason !== 'LocateDetails') this.renderView(reason === 'View');
    else for (const node of this.blocks.querySelectorAll('[data-block-id],[data-prompt-id]')) {
      const id = node.dataset.blockId || node.dataset.promptId; node.classList.toggle('selected', id === this.context.session.state.selection.node_id || (node.dataset.blockId && id === this.context.session.state.selection.block_id));
    }
    if (reason !== 'View' && !this.shell.details.hidden) this.details.render(this.context.session, {
      keepOwner: !['LocateDetails', 'InsertBlock', 'InsertLibraryBlock', 'InsertLibraryPrompts', 'WrapSelection', 'CreateAsBlock', 'MoveBlock', 'LoadDocument'].includes(reason),
    });
    if (this.findBinding && this.context.session.view === 'block' && this.pane.editor.getContribution('editor.contrib.findController').getState().isRevealed) {
      this.findBinding.refreshScope(); this.showBlockMatch(this.pane.editor.getSelection());
    }
  }
  renderTabs() {
    this.tabNodes ??= new Map(); const rendered = [];
    this.shell.center.dataset.editorSource = this.folderContext ? 'library-folder' : this.context?.asset ? 'library-block' : 'workflow';
    this.folderNameControl.hidden = !this.folderContext;
    for (const mode of this.modes.querySelectorAll('.mode')) mode.hidden = !!this.folderContext;
    this.shell.win.bar.querySelector('[title="展开 / 收起 Details"]').disabled = !!this.folderContext;
    if (this.folderContext && this.folderPage.asset) {
      const tab = this.libraryTabs.get(`folder:${this.folderContext}`);
      if (tab) Object.assign(tab, { name: this.library.path(this.folderPage.asset), labelName: this.folderPage.asset.name });
    } else if (this.context?.asset) {
      const tab = this.libraryTabs.get(`block:${this.context.key}`);
      if (tab) tab.context = this.context;
    }
    this.shell.center.classList.toggle('plv4-library-context', !!(this.folderContext || this.context?.asset));
    let active;
    for (const tab of this.tabEntries()) {
      const key = `${tab.kind}:${tab.id}`;
      let node = this.tabNodes.get(key);
      if (!node) {
        node = element('div', 'plv4-tab'); node.tabIndex = 0;
        node.append(element('span', 'plv4-tab-label'), button('×', '', () => this.closeTab(node.tab), 'plv4-tab-close'));
        node.onclick = () => { if (!node.tab.active) this.run(() => this.selectTab(node.tab)); };
        node.ondblclick = e => { if (!e.target.closest?.('button')) this.pinLibraryTab(node.tab); };
        node.onkeydown = e => { if (e.target !== node) return; if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.run(() => this.selectTab(node.tab)); } };
        this.tabNodes.set(key, node);
      }
      node.tab = tab; node.title = tab.title;
      node.classList.toggle('active', tab.active); node.classList.toggle('preview-tab', !!tab.preview);
      const label = node.querySelector('.plv4-tab-label'); if (label.textContent !== tab.label) label.textContent = tab.label;
      const close = node.querySelector('button'); close.title = `关闭标签 ${tab.label}`; close.setAttribute('aria-label', close.title);
      node.dataset.tabKind = tab.kind; node.dataset.tabId = tab.id;
      node.setAttribute('role', 'tab'); node.setAttribute('aria-selected', String(tab.active));
      rendered.push(node); if (tab.active) active = node;
    }
    const current = [...this.tablist.childNodes];
    if (current.length !== rendered.length || current.some((node, i) => node !== rendered[i])) this.tablist.replaceChildren(...rendered);
    const keys = new Set(rendered.map(node => `${node.tab.kind}:${node.tab.id}`));
    for (const key of this.tabNodes.keys()) if (!keys.has(key)) this.tabNodes.delete(key);
    if (active) { const bounds = this.tablist.getBoundingClientRect(), tab = active.getBoundingClientRect(); if (tab.left < bounds.left) this.tablist.scrollLeft -= bounds.left - tab.left; else if (tab.right > bounds.right) this.tablist.scrollLeft += tab.right - bounds.right; }
  }
  libraryTabKey(tab) { return typeof tab === 'string' ? tab : tab?.kind === 'folder' ? `folder:${tab.id}` : tab?.kind === 'block' ? `block:${tab.context.key}` : null; }
  registerLibraryTab(tab, permanent = false) {
    this.libraryTabs ??= new Map();
    const key = this.libraryTabKey(tab), previous = this.libraryTabs.get(key);
    const preview = previous ? previous.preview === true && !permanent : !permanent;
    // Closing a browsing tab keeps its cached session, just like explicit close.
    for (const [otherKey, other] of this.libraryTabs) if (otherKey !== key && other.preview) this.libraryTabs.delete(otherKey);
    this.libraryTabs.set(key, { ...previous, ...tab, preview });
  }
  pinLibraryTab(tab) {
    const entry = this.libraryTabs?.get(this.libraryTabKey(tab));
    if (!entry?.preview) return;
    entry.preview = false; this.renderTabs();
  }
  tabEntries() {
    return [
      ...this.nodes().filter(node => !this.closedNodes.has(node)).map(node => ({ kind: 'node', id: String(node.id), node, label: node.title || `Node ${node.id}`, title: node.title || `Node ${node.id}`, active: !this.folderContext && node === this.context?.node })),
      ...[...this.libraryTabs.values()].map(tab => {
        const name = tab.kind === 'folder' ? tab.name : tab.context.name;
        const label = tab.kind === 'folder' ? tab.labelName : tab.context.asset.name || name;
        return { ...tab, id: tab.kind === 'folder' ? tab.id : tab.context.key, label: `${tab.kind === 'folder' ? '▱' : '▤'} ${label}`, title: `LIBRARY ${tab.kind.toUpperCase()} · ${name}`, active: tab.kind === 'folder' ? this.folderContext === tab.id : !this.folderContext && this.context === tab.context };
      }),
    ];
  }
  selectTab(tab) { return tab.kind === 'node' ? this.open(tab.node) : tab.kind === 'folder' ? this.openFolder(tab.id) : this.openLibrary(tab.context); }
  closeTab(tab) { return this.transition(async () => {
    const entries = this.tabEntries(), index = entries.findIndex(entry => entry.kind === tab.kind && entry.id === tab.id);
    if (index < 0) return;
    const active = entries[index].active;
    if (active) { await this.folderPage?.whenIdle(); await this.detach(); }
    if (tab.kind === 'node') this.closedNodes.add(tab.node);
    else this.libraryTabs.delete(tab.kind === 'folder' ? `folder:${tab.id}` : `block:${tab.context.key}`);
    if (!active) { this.renderTabs(); return; }
    this.context = null; this.folderContext = null;
    const remaining = this.tabEntries(), next = remaining[Math.min(index, remaining.length - 1)];
    // Closing a tab leaves its session/draft in the node or Library context cache.
    if (next?.kind === 'node') await this._open(next.node);
    else if (next?.kind === 'folder') await this._openFolder(next.id);
    else if (next) await this._openLibrary(next.context);
    else this.clearPage('暂无打开的标签。点击节点的 Editor 或 Library 内容重新打开。');
  }); }
  clearPage(message) {
    this.context = null; this.folderContext = null;
    this.folderContainer.hidden = true; this.folderContainer.style.display = 'none';
    this.blocks.replaceChildren(element('div', 'plv4-empty', message));
    this.blocks.style.display = 'block'; this.syntax.style.display = this.output.style.display = 'none';
    this.details.render(null); this.renderTabs(); this.status.textContent = message;
  }
  beginGraphRestore() {
    this._graphRestoring = true;
    return this.transition(async () => {
      const identity = node => node && ({ id: String(node.id), type: node.comfyClass });
      const context = this.context;
      this._graphRestore = { visible: this.visible, node: identity(context?.node), seed: identity(this.seedNode),
        view: context?.session.view, folded: new Set(context?.folded), focus: context?.focus, scroll: this.blocks?.scrollTop ?? context?.scroll,
        syntaxState: this.pane?.editor?.saveViewState(), closed: [...this.closedNodes].map(identity) };
      // Release the old model before replacement nodes acquire a model with the
      // same ID. Never carry the old editing document into restored widget values.
      if (context?.node) { await this.detach(); this.context = null; }
    });
  }
  endGraphRestore() { return this.transition(async () => {
    const saved = this._graphRestore; this._graphRestore = null;
    try {
      this.sessions.prune();
      if (!saved) return;
      const match = identity => identity && this.nodes().find(node => String(node.id) === identity.id && node.comfyClass === identity.type);
      this.closedNodes = new Set(saved.closed.map(match).filter(Boolean));
      this.seedNode = match(saved.seed) || this.nodes()[0] || null;
      if (!saved.visible || !this.visible) return;
      if (!saved.node) { this.renderTabs(); return; }
      const node = match(saved.node) || this.nodes().find(node => !this.closedNodes.has(node));
      if (!node) { this.clearPage('当前工作流中没有打开的 Prompt Library 节点。'); return; }
      const context = await this.sessions.get(node);
      context.session.view = saved.view || 'block'; context.folded = saved.folded; context.focus = saved.focus;
      context.scroll = saved.scroll || 0; context.syntaxState = saved.syntaxState;
      this.closedNodes.delete(node); this.seedNode = node; await this.activate(context);
    } finally { this._graphRestoring = false; }
  }); }
  renderView(restore = false) {
    const session = this.context?.session; if (!session) return;
    for (const [mode, container] of [['syntax', this.syntax], ['block', this.blocks], ['preview', this.output]]) container.style.display = session.view === mode ? 'block' : 'none';
    for (const mode of ['syntax', 'block', 'preview']) this.modes.querySelector(`.plv4-mode-${mode}`).classList.toggle('active', session.view === mode);
    const errors = session.projection.diagnostics.filter(d => d.severity === 'error');
    this.status.classList.toggle('plv4-error', errors.length > 0);
    this.status.textContent = errors.length ? errors.map(d => `[${d.code}] ${d.message}`).join(' · ') : this.context.asset ? 'Library block 本地编辑 · Save 保存共享修改' : '所有随机使用 ComfyUI 节点 seed';
    if (session.view === 'block') { this.blockView.render(this.context); if (restore) this.blocks.scrollTop = this.context.scroll || 0; }
    if (session.view === 'syntax') {
      if (restore && this.context.syntaxState) this.pane.editor.restoreViewState(this.context.syntaxState);
      requestAnimationFrame(() => this.pane?.relayout());
    }
    if (session.view === 'preview') this.preview().catch(report);
  }
  async preview() {
    const context = this.context; const token = this.previewToken = (this.previewToken || 0) + 1;
    this.output.replaceChildren(element('div', 'plv4-empty', '正在编译…'));
    try {
      await context.session.whenIdle(); const inputs = await this.inputs(); const revision = context.session.revision;
      const result = await context.session.compile(inputs);
      if (this.context !== context || token !== this.previewToken || revision !== context.session.revision || context.session.view !== 'preview') return;
      this.output.replaceChildren();
      for (const key of ['prompt', 'plain']) this.output.append(element('div', 'plv4-output-label', key), element('pre', 'plv4-output', result[key]));
      this.status.textContent = `节点 seed: ${inputs.seed} · ${inputs.region_mode}`;
    } catch (error) { if (context === this.context && token === this.previewToken) this.output.replaceChildren(element('div', 'plv4-empty plv4-error', error.message)); }
  }
  async inputs() { if (!this.seedNode) throw new Error('请选择工作流节点，以使用其 seed 输入'); return this.sessions.inputs(this.seedNode); }
  async flushEditor(syncPool = true) { await this.folderPage?.whenIdle(); await this.blockView?.flush(); await this.context?.session.whenIdle(); if (syncPool) await this.context?.session.commitPool(); }
  async command(command, revision) {
    if (!this.context) throw new Error('请先选择节点');
    await this.flushEditor(!(command.type === 'SetMetadata' && Object.hasOwn(command.patch || {}, 'pool'))); if (command.type !== 'LocateDetails') this.blockView.closeEditor();
    return this.context.session.dispatch(command, revision ?? this.context.session.revision);
  }
  run(action) { return Promise.resolve().then(action).catch(report); }
  async textTarget(row = null) {
    const context = this.context, selection = getSelection();
    const field = (selection?.anchorNode?.nodeType === 3 ? selection.anchorNode.parentElement : selection?.anchorNode)?.closest?.('[data-run-input],[data-empty]');
    const active = this.blockView.inline?.element === field ? this.blockView.inline : null;
    const bookmark = this.blockView.captureFocus(field || document.activeElement);
    let offsets = null;
    if (field && selection?.rangeCount) {
      const range = selection.getRangeAt(0);
      if (field.contains(range.startContainer) && field.contains(range.endContainer)) offsets = [inlineOffset(field, range.startContainer, range.startOffset), inlineOffset(field, range.endContainer, range.endOffset)];
    }
    const copied = field && offsets ? inlineText(field).slice(...offsets) : '';
    await this.flushEditor(false);
    if (context !== this.context) throw new Error('编辑标签已切换');
    const map = indexTree(context.session.projection.tree), run = await active?.ready;
    let span;
    if (field && offsets) {
      const rows = run?.owner && run.source === context.session.text ? map.get(run.owner)?.children.filter(n => n.span && n.span[0] >= run.contentStart && n.span[1] <= run.range[1]) || [] : field.dataset.runIds?.split(',').map(id => map.get(id)).filter(n => n?.span) || [];
      const display = rows.length ? displayRun(rows, context.session.text, rows[0].span[0], rows.at(-1).span[1]) : null;
      span = offsets.map(at => run && run.source === context.session.text ? run.sourceOffset(at) : display?.offsets[at]);
      if (offsets[0] === offsets[1]) row = rows.find(n => n.span[0] <= span[0] && n.span[1] >= span[0]) || rows.find(n => n.span[0] >= span[0]) || rows.at(-1) || row;
    }
    if (!span) {
      const model = this.pane.model(), selected = this.pane.editor.getSelection();
      span = [model.getOffsetAt(selected.getStartPosition()), model.getOffsetAt(selected.getEndPosition())];
      if (span[0] === span[1] && !row) {
        row = [...map.values()].filter(n => n.span && n.form !== 'root' && n.span[0] <= span[0] && n.span[1] >= span[1]).find(n => n.kind !== 'group' || n.form === 'paren');
      }
    }
    if (span.some(at => at == null)) throw new Error('请先输入或选择 prompt');
    return { context, span, row: row && map.get(row.id), bookmark, copied, offsets };
  }
  setTextSelection(span) {
    const model = this.pane.model();
    this.pane.editor.setSelection(this.pane.monaco.Range.fromPositions(model.getPositionAt(span[0]), model.getPositionAt(span[1])));
  }
  async createAsBlock(target = null) {
    target ||= await this.textTarget();
    if (target.context !== this.context) return;
    const span = target.span[0] === target.span[1] ? target.row?.span : target.span;
    if (!span || span[0] === span[1]) throw new Error('请选择文字，或把光标放到 prompt 中');
    // Whole prompt selections preserve parked descendants and instance metadata.
    const map = indexTree(this.context.session.projection.tree);
    const exact = [...map.values()].filter(n => n.form !== 'root' && n.span && n.span[0] === span[0] && n.span[1] === span[1]).find(n => n.id === target.row?.id) || null;
    return this.command(exact ? { type: 'WrapSelection', ids: [exact.id] } : { type: 'CreateAsBlock', span });
  }
  async runTextAction(id, target = null) {
    target ||= await this.textTarget();
    if (target.context !== this.context) return;
    if (id === 'plv3.createAsBlock' || id === 'plv4.wrapSelection') return this.createAsBlock(target);
    if (['plv3.findText', 'plv3.replaceText', 'actions.find', 'editor.action.startFindReplaceAction'].includes(id)) return this.openBlockFind(id === 'plv3.replaceText' || id === 'editor.action.startFindReplaceAction', target);
    this.setTextSelection(target.span);
    this.blockView.closeEditor();
    const action = this.pane.editor.getAction(id);
    if (action) await action.run(); else this.pane.editor.trigger('block-ui', id, null);
    await this.context.session.whenIdle();
  }
  async textContextMenu(event, row) {
    const target = await this.textTarget(row);
    this.setTextSelection(target.span);
    const native = async id => {
      if (target.bookmark) this.blockView.restoreFocus(target.bookmark);
      if (id === 'undo' || id === 'redo') return this[id]();
      if (id === 'editor.action.clipboardCopyAction' || id === 'editor.action.clipboardCutAction') {
        await this.pane.editor.getContribution('editor.contrib.findController')._clipboardService.writeText(target.copied);
        if (id.endsWith('CutAction')) document.execCommand('insertText', false, '');
      } else if (id === 'editor.action.clipboardPasteAction') document.execCommand('insertText', false, await this.pane.editor.getContribution('editor.contrib.findController')._clipboardService.readText());
      else if (id === 'editor.action.selectAll') {
        const field = document.activeElement;
        if (this.blocks.contains(field)) { const range = document.createRange(); range.selectNodeContents(field); const selected = getSelection(); selected.removeAllRanges(); selected.addRange(range); }
      }
    };
    const ids = new Set(['undo', 'redo', 'editor.action.clipboardCopyAction', 'editor.action.clipboardCutAction', 'editor.action.clipboardPasteAction', 'editor.action.selectAll']);
    let invoked = false;
    showEditorContextMenu(this.pane, { x: event.clientX, y: event.clientY }, action => ({
      enabled: ids.has(action.id) ? action.id === 'undo' ? this.context.session.canUndo : action.id === 'redo' ? this.context.session.canRedo : ['editor.action.clipboardCopyAction', 'editor.action.clipboardCutAction'].includes(action.id) ? !!target.copied : true : action.enabled,
      run: () => { invoked = true; return this.run(() => ids.has(action.id) ? native(action.id) : this.runTextAction(action.id, target)); },
    }), () => { if (!invoked && target.bookmark && this.context === target.context) this.run(async () => { await this.flushEditor(false); this.blockView.restoreFocus(target.bookmark); }); });
  }
  async openBlockFind(replace, target = null) {
    target ||= await this.textTarget();
    this.findBinding?.dispose(); this.findBinding = null;
    this.setTextSelection(target.span); this.blockView.closeEditor();
    if (!this.findHost) {
      this.findHost = element('div', 'monaco-editor plv4-find-host');
      this.shell.center.append(this.findHost);
    }
    this.findBinding = await showEditorFind(this.pane, this.findHost, replace, selection => this.showBlockMatch(selection), {
      onClearMatch: clearBlockFindHighlight,
      searchScope: () => {
        const model = this.pane.model(), session = this.context.session;
        const spans = blockFindSpans(session.projection.tree, session.text);
        // An empty scope array makes Monaco fall back to the whole model.
        return (spans.length ? spans : [[0, 0]]).map(([start, end]) =>
          this.pane.monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(end)));
      },
    });
  }
  showBlockMatch(selection) {
    clearBlockFindHighlight();
    if (this.context?.session.view !== 'block' || !selection ||
      this.pane.editor.getContribution('editor.contrib.findController').getState().matchesCount === 0) return;
    const model = this.pane.model(), a = model.getOffsetAt(selection.getStartPosition()), b = model.getOffsetAt(selection.getEndPosition());
    const map = indexTree(this.context.session.projection.tree);
    const matched = [...map.values()].find(n => n.span && n.form !== 'root' && n.span[0] <= a && n.span[1] >= b && (n.kind !== 'group' || n.form === 'paren' || n.meta?.presentation === 'prompt'));
    if (!matched) return;
    for (let node = matched; node; node = map.get(node.parent_id)) this.context.folded.delete(node.id);
    this.context.focus = null; this.blockView.render(this.context);
    const field = [...this.blocks.querySelectorAll('[data-run-input]')].find(n => n.dataset.runIds.split(',').includes(matched.id));
    if (!field) return;
    const rows = field.dataset.runIds.split(',').map(id => map.get(id)).filter(n => n?.span);
    const display = displayRun(rows, this.context.session.text, rows[0].span[0], rows.at(-1).span[1]);
    const start = display.offsets.findIndex(at => at >= a), end = display.offsets.findIndex(at => at >= b);
    const range = document.createRange(); range.setStart(...inlinePoint(field, start)); range.setEnd(...inlinePoint(field, end));
    highlightBlockFindMatch(range);
    field.scrollIntoView({ block: 'nearest' });
  }
  undo() { return this.transition(() => this.history('undo')); }
  redo() { return this.transition(() => this.history('redo')); }
  async history(action) {
    const context = this.context, folderId = this.folderContext;
    const active = document.activeElement, inside = this.shell.win.el.contains(active);
    const bookmark = this.blockView.captureFocus();
    const controlKey = node => ({ tag: node.tagName, type: node.type, title: node.title,
      field: node.dataset.field,
      prompt: node.closest('.plv4-item-row')?.dataset.promptId,
      label: node.closest('.setting-row')?.querySelector('label')?.textContent });
    const control = inside && active.matches('input,textarea,select') ? controlKey(active) : null;
    const range = control && active.selectionStart != null ? [active.selectionStart, active.selectionEnd] : null;
    await this.flushEditor();
    let result;
    if (folderId) result = await this.folderPage[action]();
    else { this.blockView.closeEditor(); result = await context?.session[action](); }
    await this.details.pendingRender;
    if (inside && this.context === context && this.folderContext === folderId) {
      if (bookmark) this.blockView.restoreFocus(bookmark);
      else {
        const replacement = control && [...this.shell.win.el.querySelectorAll('input,textarea,select')].find(node => JSON.stringify(controlKey(node)) === JSON.stringify(control));
        const target = active.isConnected ? active : replacement || this.shell.win.el;
        target.focus({ preventScroll: true });
        if (range && target.setSelectionRange) target.setSelectionRange(...range);
      }
    }
    return result;
  }
  async locate(id) { await this.command({ type: 'LocateDetails', id }); this.toggleDetails(true); }
  toggleDetails(force) { this.shell.toggle('details', force); this.details.render(this.context?.session); }
  async addBlock(id, child) {
    const map = indexTree(this.context.session.projection.tree); const row = map.get(id);
    const parent = child ? row : map.get(row.parent_id); const target = { parent_id: parent.id, ...(child ? { edge: 'end' } : { after_id: row.id }) };
    const entry = await this.entryTarget(parent, target); if (entry === false) return;
    const result = await this.command({ type: 'InsertBlock', text: '{ }', ...target, ...(entry ? { entry } : {}) });
    await this.locate(result.state.selection.node_id);
    this.blockView.focusInput(result.state.selection.node_id);
  }
  async entryTarget(parent, target) {
    if (parent.form === 'region') {
      const result = await showForm('Region entry', [{ key: 'kind', label: 'Kind', value: 'base', options: ['base', 'mask', 'imask', 'fill'].map(value => ({ value, label: value })) }]);
      if (!result) return false;
      return { region: { kind: result.kind, ...(result.kind === 'mask' ? { mask: [0, 0, 1, 1] } : result.kind === 'imask' ? { imask: 0 } : {}) } };
    }
    if (parent.form === 'schedule') {
      const map = indexTree(this.context.session.projection.tree); const after = map.get(target.after_id);
      const before = map.get(target.before_id);
      const lower = after?.settings.schedule[0] ?? (before ? (parent.children[parent.children.findIndex(n => n.id === before.id) - 1]?.settings.schedule[0] ?? 0) : parent.children.at(-1)?.settings.schedule[0] ?? 0);
      const upper = before?.settings.schedule[0] ?? (after ? (parent.children[parent.children.findIndex(n => n.id === after.id) + 1]?.settings.schedule[0] ?? 1) : 1);
      const result = await showForm('Schedule entry', [{ key: 'start', label: 'Start', value: (lower + upper) / 2 }, { key: 'end', label: 'End', value: upper }]);
      if (!result) return false;
      return { schedule: [Number(result.start), Number(result.end)] };
    }
    return null;
  }
  async addPrompt(row) {
    if (row.form === 'schedule' || row.form === 'region') throw new Error('先选择一个 entry，再添加 prompt');
    await this.setView('block'); await this.locate(row.id); this.blockView.focusInput(row.id);
  }
  openLibrary(context, permanent = false) { return this.transition(() => this._openLibrary(context, permanent)); }
  openLibraryAsset(asset, permanent = false) { return this.transition(async () => this._openLibrary(await this.library.assetContext(asset), permanent)); }
  async _openLibrary(context, permanent = false) {
    if (this.context?.asset && !this.context.session.valid) throw new Error('请先修复当前 Library block 原稿');
    await this.flushEditor();
    this.registerLibraryTab({ kind: 'block', context }, permanent || context.edited === true);
    await this.activate(context);
    // Every Library click opens the same complete Blocks view used by nodes.
    context.focus = null; context.folded.clear(); context.session.setView('block');
    const clean = context.savedRevision === context.session.revision;
    await this.locate(context.session.state.selection.block_id || context.session.state.doc.root.children[0].id);
    if (clean) context.savedRevision = context.session.revision;
  }
  async insertSnapshot(snapshot, source, promptsOnly) {
    const map = indexTree(this.context.session.projection.tree); const selected = this.context.session.state.selection;
    let parent = map.get(selected.block_id) || this.context.session.projection.tree;
    if (parent.form === 'schedule' || parent.form === 'region') throw new Error('请先选择 entry 的内容区');
    const current = map.get(selected.node_id); const target = { parent_id: parent.id, ...(current && current.id !== parent.id ? { after_id: current.id } : { edge: 'end' }) };
    return this.command({ type: promptsOnly ? 'InsertLibraryPrompts' : 'InsertLibraryBlock', snapshot, source, ...target });
  }
  async loadDocument(data) {
    if (!this.context?.node) throw new Error('请先选择工作流节点');
    await this.flushEditor();
    await this.context.session.loadDocument({ ...(typeof data.text === 'string' ? { text: data.text } : {}), doc: data.doc_json ? JSON.parse(data.doc_json) : null });
  }
  openFolder(id, permanent = false) { return this.transition(() => this._openFolder(id, permanent)); }
  async _openFolder(id, permanent = false) {
    this.build(); await this.shell.designReady;
    if (this.context?.asset && !this.context.session.valid) throw new Error('请先修复当前 Library block 原稿');
    await this.flushEditor(); await this.detach(); this.context = null; this.folderContext = null;
    await this.folderPage.open(id); this.folderContext = id;
    this.registerLibraryTab({ kind: 'folder', id, name: this.library.path(this.folderPage.asset), labelName: this.folderPage.asset.name }, permanent);
    this.visible = true; this.shell.win.show(); this.folderContainer.hidden = false; this.folderContainer.style.display = 'block';
    this.folderPage.restoreView();
    this.syntax.style.display = this.blocks.style.display = this.output.style.display = 'none'; this.modes.style.display = 'flex';
    this.shell.toggle('details', false);
    this.details.render(null); this.renderTabs(); this.status.textContent = 'Folder 池 · 修改即时保存';
  }
  async libraryAction(action, row) {
    await this.flushEditor(action === 'save'); if (!this.context) throw new Error('请先选择 block');
    row ||= this.context.session.projection.tree.children[0];
    row = indexTree(this.context.session.projection.tree).get(row.id) || row;
    if (action === 'save') return this.saveBlock(row);
    if (row.form === 'root') throw new Error('请选择一个 block');
    await this.library.reload();
    const folders = this.library.data.assets.filter(a => a.kind === 'folder');
    const result = await showForm('绑定池', [{ key: 'id', label: 'Folder', value: row.meta?.pool || '', options: [{ value: '', label: '不绑定' }, ...folders.map(a => ({ value: a.id, label: this.library.path(a) }))] }]);
    if (result) return this.command({ type: 'SetMetadata', id: row.id, patch: { pool: result.id || null } });
  }

  async saveBlock(row) {
    await this.flushEditor(); row = indexTree(this.context.session.projection.tree).get(row.id) || row;
    if (row.form === 'root') return this.saveDocument();
    await this.library.reload(); const source = row.meta?.source;
    const linked = source?.kind === 'block' && this.library.data.assets.some(a => a.id === source.id);
    const modes = linked ? [{ value: 'overwrite', label: '覆盖来源' }, { value: 'new', label: '另存为新 block' }] : [{ value: 'new', label: '保存为新 block' }];
    const folder = linked ? this.library.data.assets.find(a => a.id === source.id).folder_id : '';
    const result = await showForm('保存 block', [{ key: 'mode', label: '保存方式', value: linked ? 'overwrite' : 'new', options: modes }, { key: 'name', label: '名称', value: row.meta?.name || this.context.name || 'Block' }, { key: 'folder', label: '位置', value: folder || '', options: this.library.folderOptions() }]); if (!result) return;
    const response = await this.command({ type: 'SaveLibrary', id: row.id, name: result.name, folder_id: result.folder || null, ...(linked && result.mode === 'overwrite' ? { asset_id: source.id, version: source.version } : {}) });
    if (this.context.asset && row.id === this.context.session.state.doc.root.children[0].id) {
      this.context.asset = response.asset; this.context.name = response.asset.path; this.context.savedRevision = this.context.session.revision; this.renderTabs();
    }
    await this.library.reload(); toast('Block 已保存'); return response;
  }
  async saveDocument() {
    if (!this.context?.session) throw new Error('请选择工作流节点');
    await this.flushEditor(); await this.library.reload();
    const result = await showForm('保存完整 Document', [{ key: 'name', label: '名称', value: this.context.node?.title || 'Document' }, { key: 'folder', label: '位置', value: '', options: this.library.folderOptions() }]); if (!result) return;
    const response = await this.command({ type: 'SaveLibrary', document: true, name: result.name, folder_id: result.folder || null });
    await this.library.reload(); return response;
  }
  async updateSource(row) {
    if (!await showConfirm('用最新来源替换此 block 的本地内容和开关状态？', { okLabel: '更新来源' })) return;
    const latest = await libraryRequest('expand', { id: row.meta.source.id });
    return this.command({ type: 'UpdateLibraryBlock', id: row.id, snapshot: latest.snapshot, source: latest.source });
  }
  libraryDropTarget(x, y) {
    if (this.folderContext) return null;
    const session = this.context?.session; if (!session?.valid) return null;
    if (session.view === 'block') {
      return this.blockView.dropTarget(x, y);
    }
    if (session.view !== 'syntax') return null;
    if (!this.syntax.contains(document.elementFromPoint(x, y))) return null;
    const hit = this.pane.editor.getTargetAtClientPoint(x, y); if (!hit?.position) return null;
    const model = this.pane.model(), offset = model.getOffsetAt(hit.position);
    const map = indexTree(session.projection.tree);
    const rows = [...map.values()].filter(n => n.span && n.span[0] <= offset && offset <= n.span[1]);
    const item = rows.at(-1); if (!item) return null;
    let parent, command, at;
    if (item.kind !== 'group' || item.form === 'paren' || item.meta?.presentation === 'prompt') {
      parent = map.get(item.parent_id); const before = offset < (item.span[0] + item.span[1]) / 2;
      command = { parent_id: parent.id, [before ? 'before_id' : 'after_id']: item.id }; at = item.span[before ? 0 : 1];
    } else {
      parent = item; const start = offset <= item.span[0] + item.source.indexOf('{') + 1;
      command = { parent_id: item.id, edge: start ? 'start' : 'end' }; at = item.ast?.spans.content?.[start ? 0 : 1] ?? offset;
    }
    if (this.context.asset && parent.form === 'root') {
      parent = session.projection.tree.children[0]; command = { parent_id: parent.id, edge: 'end' }; at = parent.ast.spans.content[1];
    }
    const position = model.getPositionAt(at), coords = this.pane.editor.getScrolledVisiblePosition(position);
    if (!coords) return null;
    const rect = this.pane.editor.getDomNode().getBoundingClientRect();
    const caret = { x: rect.left + coords.left, y: rect.top + coords.top, height: coords.height };
    return { parent, command, placement: 'inline', caret };
  }
  remove(node) {
    if (this._graphRestoring) { this.sessions.remove(node); return; }
    this.transition(async () => {
      if (this.context?.node === node) {
        await this.detach(); this.context = null; this.renderTabs(); this.blocks.replaceChildren();
        this.syntax.style.display = this.output.style.display = 'none'; this.details.render(null); this.status.textContent = '节点已移除';
      }
      this.sessions.remove(node);
    }).catch(report);
  }
}
