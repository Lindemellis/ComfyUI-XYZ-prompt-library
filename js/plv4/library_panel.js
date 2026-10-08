import { DocumentSession } from './document_session.js';
import { DropPreview, dropLocation } from './drop_preview.js';
import { element, button, input, menu, report } from './ui.js';
import { showForm, showConfirm, toast } from '../plv3/ui.js';
import { libraryRequest, libraryDocumentRequest, libraryContextRequest, ensureOwner } from './asset_client.js';
import { LibraryPreview } from './library_preview.js';
import { cleanPromptInput } from './prompt_text.js';
import { compactFolders } from './folder_tree.js';

function assetIcon(kind) {
  const paths = {
    folder: 'M3 7V5h6l2 2h10v13H3V7Z M3 10h18',
    tag: 'M4 4h7l9 9-7 7-9-9V4Z M8 8h.01',
    block: 'm12 3 9 5v9l-9 5-9-5V8l9-5Z M3 8l9 5 9-5 M12 13v9',
    document: 'M5 3h10l4 4v14H5V3Z M14 3v5h5 M8 12h8 M8 16h8',
  };
  const icon = element('span', 'asset-icon'); icon.dataset.iconKind = kind;
  icon.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" aria-hidden="true"><path d="${paths[kind] || paths.block}"/></svg>`;
  return icon;
}

// Folder-pool Library, using the existing snapshot/editor boundary.
export class LibraryPanel {
  constructor(container, host) {
    this.container = container; this.host = host; this.query = ''; this.collapsed = new Set(); this.contexts = new Map(); this.sort = 'name';
    const head = element('div', 'plv4-library-head');
    head.insertAdjacentHTML('afterbegin', '<div class="library-title">Library <span class="eyebrow">LOCAL</span></div>');
    const search = input('', value => { this.query = value; this.renderTree(); }, { title: '搜索 Library' }); search.placeholder = '搜索 Library';
    search.oninput = () => { this.query = search.value; this.renderTree(); };
    search.type = 'search';
    const ops = element('div', 'plv4-row library-tools');
    ops.append(button('A↕', '按名称 / 原顺序排序', () => { this.sort = this.sort === 'name' ? 'position' : 'name'; this.renderTree(); }),
      button('▾', '全部展开', () => { this.collapsed.clear(); this.renderTree(); }), button('▸', '全部折叠', () => { this.data?.assets.filter(f => f.kind === 'folder').forEach(f => this.collapsed.add(f.id)); this.renderTree(); }), button('↻', '刷新 Library', () => this.reload()));
    ops.append(button('+', '新建 Folder / Block / Tag / Document', e => menu(e.currentTarget, [
      ['新建 Folder', () => this.create('folder')], ['添加 tag', () => this.create('tag')], ['新建 Block', () => this.create('block')], ['保存完整 Document', () => this.host.saveDocument()], ['加载已存 Document', () => this.loadSavedDocument()],
      ['从 V3 迁移（保留原库）', () => this.migrate()],
    ])));
    ops.querySelector('[title="全部折叠"]').onclick = () => { this.data?.assets.filter(f => f.kind === 'folder').forEach(f => this.collapsed.add(f.id)); this.data?.assets.filter(a => ['folder'].includes(a.kind)).forEach(a => this.collapsed.add(a.id)); this.renderTree(); };
    for (const control of ops.querySelectorAll('button')) control.classList.add('tiny-button');
    head.append(search, ops); this.tree = element('div', 'plv4-scroll'); this.tree.setAttribute('role', 'tree');
    const note = element('div', 'library-note'); note.innerHTML = '左边缘拖动 block<br>▣ 保留结构插入 · ≡ 仅插入 prompts<br>关闭父级后，子项设置仍被保留。';
    container.append(head, this.tree, note);
    window.addEventListener('xyz-plv4-library-changed', () => {
      clearTimeout(this.refreshTimer); this.refreshTimer = setTimeout(() => { if (!container.hidden) this.reload(); }, 150);
    });
  }
  async reload() {
    clearTimeout(this.refreshTimer);
    const token = this.reloadToken = (this.reloadToken || 0) + 1;
    try { const current = await libraryRequest('tree');
      if (token !== this.reloadToken) return;
      if (this.data?.revision !== current.revision) window.dispatchEvent(new CustomEvent('xyz-plv4-library-index', { detail: current.revision }));
      this.data = current; this.renderTree();
    } catch (error) { if (token === this.reloadToken) this.tree.replaceChildren(element('div', 'plv4-empty', error.message)); }
  }
  renderTree() {
    if (!this.data) { this.tree.replaceChildren(); return; }
    if (this.previewRevision !== this.data.revision) this.preview?.close();
    this.previewRevision = this.data.revision;
    this.treeRows ??= new Map(); this.nextRows = [];
    this.renderAssets(this.query.toLocaleLowerCase());
    if (!this.nextRows.length) this.nextRows.push(element('div', 'plv4-empty', this.query ? '没有匹配内容' : 'Library 暂无内容'));
    const current = [...this.tree.childNodes];
    if (current.length !== this.nextRows.length || current.some((row, i) => row !== this.nextRows[i])) {
      this.preview?.close(); this.tree.replaceChildren(...this.nextRows);
    }
    const ids = new Set(this.nextRows.map(row => row.dataset.assetId));
    for (const id of this.treeRows.keys()) if (!ids.has(id)) this.treeRows.delete(id);
    this.nextRows = null;
  }
  path(asset) {
    if (asset.path) return asset.path;
    const names = [asset.name]; let parent = asset.parent_id ?? asset.folder_id; const seen = new Set([asset.id]);
    while (parent && !seen.has(parent)) { seen.add(parent); const row = this.data?.assets.find(a => a.id === parent); if (!row) break; names.unshift(row.name); parent = row.parent_id ?? row.folder_id; }
    return names.join('.');
  }
  folderOptions() { return [{ value: '', label: 'Library 根目录' }, ...(this.data?.assets || []).filter(a => a.kind === 'folder').map(a => ({ value: a.id, label: this.path(a) }))]; }
  parentOptions(kind, asset = null) {
    const allowed = { folder: ['folder'], tag: ['folder'], block: ['folder', 'block'], document: ['folder'] }[kind];
    const isDescendant = row => { const seen = new Set(); while (row && !seen.has(row.id)) { if (row.id === asset?.id) return true; seen.add(row.id); row = this.data.assets.find(a => a.id === row.parent_id); } return false; };
    return [...(kind === 'tag' ? [] : [{ value: '', label: 'Library 根目录' }]), ...(this.data?.assets || []).filter(a => allowed.includes(a.kind) && !isDescendant(a)).map(a => ({ value: a.id, label: this.path(a) }))];
  }
  async create(kind, parent = null) {
    await this.reload();
    const current = parent ? await libraryRequest('get', { id: parent.id }) : null;
    const local = current?.kind === 'block' ? this.contexts.get(`v4:${current.id}`) : null;
    if (local && local.session.revision !== local.savedRevision) throw new Error('请先保存父 block 的本地修改，再新建 subblock');
    const form = await showForm(`新建 ${kind}`, [{ key: 'name', label: '名称', value: '' }, ...(current ? [] : [{ key: 'parent', label: '位置', value: '', options: this.parentOptions(kind) }])]);
    if (!form) return;
    const parentId = current?.id || form.parent || null;
    const selected = parentId ? await libraryRequest('get', { id: parentId }) : null;
    const result = await libraryRequest(kind === 'block' ? 'create_block' : `save_${kind}`, { name: kind === 'tag' ? cleanPromptInput(form.name) : form.name, parent_id: parentId, ...(selected?.kind === 'block' ? { version: selected.version } : {}), data: { autocomplete: false } }, true);
    if (this.host.folderContext) this.host.pinLibraryTab?.(`folder:${this.host.folderContext}`);
    await this.reload(); await this.openAsset(result.asset);
    return result.asset;
  }
  renderAssets(query) {
    const assets = this.data.assets || [];
    const byParent = new Map();
    for (const asset of assets) { const parent = asset.parent_id ?? null; if (!byParent.has(parent)) byParent.set(parent, []); byParent.get(parent).push(asset); }
    const children = parent => (byParent.get(parent) || []).filter(a => a.kind !== 'tag');
    const tagMatches = parent => assets.some(a => a.kind === 'tag' && a.parent_id === parent && a.name.toLocaleLowerCase().includes(query));
    const matches = (asset, stack = new Set()) => {
      if (stack.has(asset.id)) return false; const next = new Set(stack).add(asset.id);
      return this.path(asset).toLocaleLowerCase().includes(query) || tagMatches(asset.id) || children(asset.id).some(a => matches(a, next));
    };
    const walk = (parent, depth, ancestorMatch = false, actualDepth = depth) => {
      const list = children(parent).sort((a, b) => this.sort === 'name' ? a.name.localeCompare(b.name) : a.position - b.position);
      for (const first of list) {
        if (query && !ancestorMatch && !matches(first)) continue;
        const chain = compactFolders(first, folder => byParent.get(folder.id));
        const asset = chain.at(-1), label = chain.map(folder => folder.name).join(' / ');
        const active = chain.some(folder => this.host.folderContext === folder.id || this.host.context?.asset?.id === folder.id);
        const closed = !query && chain.some(folder => this.collapsed.has(folder.id));
        const childMatch = ancestorMatch || chain.some(folder => folder.name.toLocaleLowerCase().includes(query));
        const branch = children(asset.id).length;
        const signature = JSON.stringify([chain.map(folder => [folder.id, folder.name, this.path(folder), folder.version]), depth, actualDepth, branch, closed]);
        const previous = this.treeRows.get(asset.id);
        if (previous?.signature === signature) {
          previous.row.classList.toggle('active', active); this.nextRows.push(previous.row);
          if (branch && !closed) walk(asset.id, depth + 1, childMatch, actualDepth + chain.length);
          continue;
        }
        const row = element('div', `plv4-library-row asset${asset.kind === 'folder' ? ' library-folder-row' : ' library-tree-block'}${active ? ' active' : ''}`); row.dataset.assetId = asset.id; row.dataset.kind = asset.kind; row.dataset.depth = depth; row.style.paddingLeft = '6px';
        row.dataset.folderChain = JSON.stringify(chain.map(folder => folder.id)); row.dataset.actualDepth = actualDepth;
        row.tabIndex = 0; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(actualDepth + 1)); row.setAttribute('aria-label', `打开 ${label}`);
        row.title = `第 ${actualDepth + 1}${chain.length > 1 ? `–${actualDepth + chain.length}` : ''} 层 · ${this.path(asset)}`;
        const selectedAsset = event => chain.find(folder => folder.id === (event.target.closest?.('.compact-folder-segment') || event.target).dataset?.folderId) || asset;
        row.onclick = event => {
          if (event.defaultPrevented || event.target.closest?.('button')) return;
          return this.openAsset(selectedAsset(event)).catch(report);
        };
        row.ondblclick = event => {
          if (event.defaultPrevented || event.target.closest?.('button')) return;
          return this.openAsset(selectedAsset(event), true).catch(report);
        };
        row.onkeydown = event => {
          if ((event.target !== row && !event.target.dataset?.folderId) || !['Enter', ' '].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation?.(); return this.openAsset(selectedAsset(event)).catch(report);
        };
        if (depth) {
          const guides = element('span', 'tree-guides'); guides.title = `第 ${actualDepth + 1} 层`; guides.setAttribute('aria-hidden', 'true');
          for (let level = 0; level < depth; level++) guides.append(element('i', 'tree-guide'));
          row.append(guides);
        }
        if (branch) row.append(button(closed ? '▸' : '▾', '展开 / 折叠', () => { for (const folder of chain) { if (closed) this.collapsed.delete(folder.id); else this.collapsed.add(folder.id); } this.renderTree(); }));
        else row.append(element('span', 'library-fold-spacer'));
        row.append(assetIcon(asset.kind));
        const name = element('span', 'plv4-library-name', chain.length === 1 ? asset.name : ''); name.title = this.path(asset); row.append(name);
        if (chain.length > 1) chain.forEach((folder, index) => {
          if (index) name.append(element('span', 'compact-folder-separator', ' / '));
          const segment = element('span', 'compact-folder-segment', folder.name); segment.dataset.folderId = folder.id;
          segment.title = this.path(folder); segment.tabIndex = 0; segment.setAttribute('role', 'link'); segment.setAttribute('aria-label', `打开 ${this.path(folder)}`); name.append(segment);
        });
        if (asset.kind === 'block') { name.style.touchAction = 'none'; name.onpointerdown = event => this.startInsertDrag(event, asset, false, name); }
        const showPreview = () => { this.preview ??= new LibraryPreview(); return this.preview.show(preview, asset); };
        const preview = button('', '预览 tag', showPreview, 'tiny-button library-preview-icon');
        preview.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
        preview.setAttribute('aria-label', `预览 ${asset.name} 中的 tag`); preview.setAttribute('aria-expanded', 'false');
        preview.onpointerenter = showPreview; preview.onfocus = showPreview;
        preview.onpointerleave = () => { if (document.activeElement !== preview) this.preview?.scheduleClose(); };
        preview.onblur = () => this.preview?.close();
        preview.onkeydown = event => { if (event.key === 'Escape') this.preview?.close(); };
        row.append(preview);
        if (asset.kind === 'folder') {
          const handle = button('▣', '拖入：新建绑定此 Folder 的 block', () => {}, 'library-handle');
          handle.dataset.insertMode = 'folder';
          handle.setAttribute('aria-label', `拖入 ${asset.name}：新建绑定池的 block`);
          handle.onpointerdown = event => this.startInsertDrag(event, asset, false, handle); row.append(handle);
        }
        if (asset.kind === 'block') for (const [only, glyph, label] of [[false, '▣', '插入完整 block'], [true, '≡', '只插入 prompts']]) {
          const handle = button(glyph, label, () => this.insertAsset(asset, only), 'library-handle'); handle.dataset.insertMode = only ? 'prompts' : 'block';
          handle.onpointerdown = event => this.startInsertDrag(event, asset, only, handle); row.append(handle);
        }
        row.oncontextmenu = event => { event.preventDefault(); menu({ getBoundingClientRect: () => ({ right: event.clientX, bottom: event.clientY }) }, this.assetMenu(selectedAsset(event))); };
        this.treeRows.set(asset.id, { signature, row }); this.nextRows.push(row);
        if (branch && !closed) walk(asset.id, depth + 1, childMatch, actualDepth + chain.length);
      }
    }; walk(null, 0);
  }
  async assetContext(asset) {
    const key = `v4:${asset.id}`; let context = this.contexts.get(key);
    const latest = await libraryRequest('get', { id: asset.id });
    if (context && context.savedRevision === context.session.revision && (context.asset.version !== latest.version || context.asset.path !== latest.path)) {
      context.session.dispose(); this.contexts.delete(key); context = null;
    }
    if (!context) {
      const expanded = await libraryRequest('expand', { id: asset.id });
      expanded.snapshot.meta.source = expanded.source;
      const opened = await DocumentSession.open({ text: '{ }', scope: 'block' });
      const doc = opened.state.doc; doc.root.children = [expanded.snapshot];
      const ids = []; const collect = n => { ids.push(Number(n.id.slice(1)) || 0); n.children?.forEach(collect); }; collect(doc.root); doc.root.id = 'library-root'; doc.next_id = Math.max(...ids) + 1; opened.dispose();
      const session = await DocumentSession.open({ doc, scope: 'block' }, { request: libraryContextRequest(asset.id) }); ensureOwner(session); await libraryDocumentRequest.observe(session);
      context = { key, session, asset: latest, name: latest.path, folded: new Set(), focus: null, scroll: 0, syntaxState: null, savedRevision: session.revision };
      this.contexts.set(key, context);
    }
    return context;
  }
  async openAsset(asset, permanent = false) {
    if (asset.kind === 'folder') return this.host.openFolder(asset.id, permanent);
    if (asset.kind === 'tag') { const current = await libraryRequest('get', { id: asset.id }); return this.host.openFolder(current.parent_id); }
    if (asset.kind === 'document') { const value = await libraryRequest('get', { id: asset.id }); return this.host.loadDocument({ doc_json: JSON.stringify(value.data.doc) }); }
    if (this.host.openLibraryAsset) return this.host.openLibraryAsset(asset, permanent);
    return this.host.openLibrary(await this.assetContext(asset), permanent);
  }
  async insertAsset(asset, promptsOnly) {
    const expanded = await libraryRequest('expand', { id: asset.id });
    return this.host.insertSnapshot(expanded.snapshot, expanded.source, promptsOnly);
  }
  assetMenu(asset) {
    const children = { folder: [['添加 subfolder', 'folder'], ['添加 Block', 'block'], ['添加 tag', 'tag']], block: [['添加 subblock', 'block']] };
    return [['打开', () => this.openAsset(asset)], ['重命名', () => this.organize(asset, 'rename')], ...(children[asset.kind] || []).map(([label, kind]) => [label, () => this.create(kind, asset)]), ['移动', () => this.organize(asset, 'move')], ['Delete', () => this.deleteAsset(asset)]];
  }
  async organize(asset, action = 'rename') {
    await this.reload(); const current = await libraryRequest('get', { id: asset.id });
    const form = await showForm(action === 'rename' ? '重命名' : '移动', action === 'rename' ? [{ key: 'name', label: '名称', value: current.name }] : [{ key: 'parent', label: '位置', value: current.parent_id || '', options: this.parentOptions(current.kind, current) }]); if (!form) return;
    const parent = action === 'move' && form.parent ? await libraryRequest('get', { id: form.parent }) : null;
    await libraryRequest(action, { id: current.id, version: current.version, ...(action === 'rename' ? { name: form.name } : { parent_id: form.parent || null, ...(parent?.kind === 'block' ? { parent_version: parent.version } : {}) }) }, true); await this.reload();
    if (this.host.folderContext) this.host.pinLibraryTab?.(`folder:${this.host.folderContext}`);
    if (this.host.folderContext) await this.host.folderPage.open(this.host.folderContext);
  }
  async deleteAsset(asset) {
    const current = await libraryRequest('get', { id: asset.id });
    const form = await showForm('删除 Library 对象', [{ key: 'decision', label: `删除 ${this.path(current)}${current.kind === 'block' ? ' 及其所属 subblocks' : ''}`, value: 'cancel', options: [{ value: 'cancel', label: '保留' }, { value: 'delete', label: '删除' }] }]);
    if (form?.decision !== 'delete') return;
    await libraryRequest('delete', { id: current.id, version: current.version }, true); await this.reload();
    if (this.host.folderContext) this.host.pinLibraryTab?.(`folder:${this.host.folderContext}`);
  }
  async loadSavedDocument() {
    await this.reload(); const documents = this.data.saved_documents || []; if (!documents.length) throw new Error('暂无保存的 Document');
    const form = await showForm('加载 Document', [{ key: 'id', label: 'Document', value: documents[0].id, options: documents.map(d => ({ value: d.id, label: d.path })) }]);
    if (form) { const value = await libraryRequest('get', { id: form.id }); await this.host.loadDocument({ doc_json: JSON.stringify(value.data.doc) }); }
  }
  async migrate() {
    if (this.migrating) return;
    if (!await showConfirm('先备份 V3，再导入独立 V4 库。原组转为 Folder，预设转为 block；保留关闭项、嵌套和完整 Document。原库保持完整。', { okLabel: '备份并迁移' })) return;
    this.migrating = true;
    try {
      const response = await fetch('/xyz/plv4/library/migrate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.error || '迁移失败');
      window.dispatchEvent(new CustomEvent('xyz-plv4-library-changed'));
      await this.reload(); toast(result.repeated ? '此 V3 快照已经导入' : `已导入 ${result.counts.folders} 个 Folder、${result.counts.blocks} 个 block、${result.counts.documents} 个 Document。备份：${result.backup}`);
      return result;
    } finally { this.migrating = false; }
  }
  startTagDrag(event, asset) {
    if (event.button !== 0) return; event.preventDefault(); event.stopPropagation();
    let target = null, moved = false;
    const move = e => { moved ||= Math.hypot(e.clientX-event.clientX,e.clientY-event.clientY)>5; const hit = document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-asset-id]'); target = this.data.assets.find(a => a.id === hit?.dataset.assetId && a.kind === 'folder'); };
    const cancel = () => { document.removeEventListener('pointermove',move); document.removeEventListener('pointerup',up); document.removeEventListener('pointercancel',cancel); };
    const up = e => { move(e); cancel(); if (moved && target) this.host.run(async () => { await libraryRequest('move',{id:asset.id,version:asset.version,parent_id:target.id},true); await this.reload(); if(this.host.folderContext) { this.host.pinLibraryTab?.(`folder:${this.host.folderContext}`); await this.host.folderPage.open(this.host.folderContext); } }); };
    document.addEventListener('pointermove',move); document.addEventListener('pointerup',up); document.addEventListener('pointercancel',cancel);
  }
  startInsertDrag(event, asset, promptsOnly, handle) {
    if (event.button !== 0 || (!this.host.context?.session && !this.host.folderContext)) return;
    event.preventDefault(); event.stopPropagation();
    const context = this.host.context;
    const prepared = this.host.flushEditor().then(() => {
      if (this.host.context !== context) throw new Error('编辑上下文已变化，请重新拖拽');
      return context?.session.revision;
    }); prepared.catch(() => {});
    const folderId = this.host.folderContext;
    const preview = new DropPreview(this.host);
    let trackPointer = () => {};
    const expanded = asset.kind === 'folder' ? libraryRequest('folder_block', { id: asset.id }) : libraryRequest('expand', { id: asset.id }); expanded.catch(() => {});
    let count = null;
    const countPrompts = (node, active = true) => {
      if (!active || !node.enabled) return 0;
      return node.kind === 'group' && node.form !== 'paren' && node.meta?.presentation !== 'prompt' ? (node.children || []).reduce((sum, child) => sum + countPrompts(child), 0) : 1;
    };
    expanded.then(value => { count = countPrompts(value.snapshot); }).catch(() => {});
    let destination = null, moved = false;
    const move = ev => {
      if (Math.hypot(ev.clientX - event.clientX, ev.clientY - event.clientY) < 5 && !moved) return;
      moved = true; trackPointer(ev); handle.dataset.dragged = 'true'; destination = this.host.libraryDropTarget(ev.clientX, ev.clientY);
      if (promptsOnly && ['schedule', 'region'].includes(destination?.parent.form)) destination = null;
      const action = promptsOnly ? `插入 prompts${count == null ? '' : ` (${count})`}` : asset.kind === 'folder' ? '新建绑定池的 block' : '插入 block';
      const place = destination ? ` · ${dropLocation(destination)}` : '';
      preview.show(destination, action + place, ev.clientX, ev.clientY);
    };
    const clear = () => {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); document.removeEventListener('pointercancel', cancel); document.removeEventListener('keydown', key); preview.destroy();
      if (moved) { const click = handle.onclick; handle.onclick = e => e.preventDefault(); setTimeout(() => { handle.onclick = click; delete handle.dataset.dragged; }, 0); }
    };
    const cancel = () => { destination = null; clear(); };
    const key = ev => { if (ev.key === 'Escape') cancel(); };
    const up = async ev => {
      if (moved && ev?.clientX != null) move(ev);
      const target = destination; clear(); if (!moved || !target || this.host.context !== context || this.host.folderContext !== folderId) return;
      try {
        const revision = await prepared;
        const source = await expanded;
        const entry = await this.host.entryTarget(target.parent, target.command); if (entry === false) return;
        await this.host.command({ type: promptsOnly ? 'InsertLibraryPrompts' : 'InsertLibraryBlock', snapshot: source.snapshot, source: source.source, ...target.command, ...(entry ? { entry } : {}) }, revision);
      } catch (error) { report(error); }
    };
    trackPointer = preview.autoScroll(this.host.folderContext ? this.host.folderContainer : this.host.blocks, move);
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up); document.addEventListener('pointercancel', cancel); document.addEventListener('keydown', key);
  }
}
