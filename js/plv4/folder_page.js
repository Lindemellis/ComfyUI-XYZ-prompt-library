import { libraryRequest } from './asset_client.js';
import { element, button, input, check, menu } from './ui.js';
import { cleanPromptInput } from './prompt_text.js';

// Reuses the Library window, controls and tab lifecycle. A pool is a Folder view.
export class FolderPage {
  constructor(container, host) { this.container = container; this.host = host; this.views = new Map(); this.pending = Promise.resolve(); this.histories = new Map(); this.collapsed = new Set(); }
  whenIdle() { return this.pending; }
  rememberView() { if (this.asset) this.views.set(this.asset.id, this.container.scrollTop); }
  restoreView() { this.container.scrollTop = this.views.get(this.asset.id) || 0; }
  async open(id) {
    await this.whenIdle(); this.rememberView();
    this.asset = await libraryRequest('get', { id });
    if (!this.histories.has(id)) this.histories.set(id, { past: [], future: [] });
    await this.host.library.reload(); this.render(); this.restoreView();
  }
  edit(change, record = true) {
    const id = this.asset.id;
    this.host.pinLibraryTab?.(`folder:${id}`);
    const task = this.pending.then(async () => {
      const asset = await libraryRequest('get', { id }); const next = structuredClone(asset); change(next);
      const result = await libraryRequest('save_folder', { id, version: asset.version, name: next.name, parent_id: next.parent_id, data: next.data }, true);
      if (record) { this.histories.get(id).past.push(asset); this.histories.get(id).future = []; }
      if (this.asset?.id === id) { this.asset = result.asset; this.render(); }
      await this.host.library.reload(); return result.asset;
    });
    this.pending = task.catch(() => {}); return task;
  }
  saveTag(item, text) {
    const folderId = this.asset.id;
    this.host.pinLibraryTab?.(`folder:${folderId}`);
    const task = this.pending.then(async () => {
      await libraryRequest('save_tag', { id: item.id, version: item.version, parent_id: item.parent_id, text: cleanPromptInput(text) }, true);
      await this.host.library.reload();
      if (this.asset?.id === folderId) { this.asset = await libraryRequest('get', { id: folderId }); this.render(); }
    });
    this.pending = task.catch(() => {}); return task;
  }
  undo() { return this.restore('past', 'future'); }
  redo() { return this.restore('future', 'past'); }
  async restore(from, to) {
    await this.whenIdle(); const history = this.histories.get(this.asset.id); const saved = history[from].at(-1); if (!saved) return;
    const current = structuredClone(this.asset);
    await this.edit(next => { next.name = saved.name; next.data = saved.data; }, false);
    history[from].pop(); history[to].push(current);
    this.render();
  }
  render() {
    const asset = this.asset; this.container.dataset.folderId = asset.id;
    this.host.folderNameControl.replaceChildren(element('span', '', 'Folder'), input(asset.name, name => this.edit(next => { next.name = name; }), { title: 'Folder 名称' }),
      check(!!asset.data.autocomplete, value => this.edit(next => { next.data.autocomplete = value; }), '加入全局补全（包含子文件夹）'));
    const page = element('div', 'folder-page');
    const children = new Map();
    for (const item of this.host.library.data.assets) {
      if (!['folder','tag'].includes(item.kind)) continue;
      if (!children.has(item.parent_id)) children.set(item.parent_id, []);
      children.get(item.parent_id).push(item);
    }
    const tools = element('div', 'folder-page-tools');
    tools.append(button('＋ tag', '添加本层 tag', () => this.host.library.create('tag', asset)),
      button('＋ Folder', '添加子文件夹', () => this.host.library.create('folder', asset)));
    page.append(tools);
    const ownTags = (children.get(asset.id) || []).filter(item => item.kind === 'tag').length;
    if (ownTags) page.append(element('div', 'folder-layer-label', `本层 · ${ownTags} tag`));
    const contents = element('div', 'folder-tree-body'); page.append(contents);
    this.renderFolder(asset, contents, new Set(), children);
    if (!children.get(asset.id)?.length) page.append(element('div', 'folder-empty', '暂无散装 tag 或子文件夹'));
    this.rememberView(); this.container.replaceChildren(page); this.restoreView();
    if (this.host.folderContext === asset.id) this.host.renderTabs();
    this.host.onFolderRender?.(this);
  }
  renderFolder(folder, container, ancestors, children) {
    if (ancestors.has(folder.id)) return;
    const next = new Set(ancestors).add(folder.id);
    const list = children.get(folder.id) || [];
    const local = element('div', 'folder-local-tags'); local.dataset.folderId = folder.id;
    for (const item of list.filter(a => a.kind === 'tag')) {
      const line = element('div', 'folder-tag-row'); line.dataset.assetId = item.id; line.dataset.depth = ancestors.size + 1; line.title = `第 ${ancestors.size + 2} 层 · tag`;
      line.append(input(item.name, text => this.saveTag(item, text), { title: 'Tag' }));
      const actions = element('span', 'folder-row-actions');
      const handle = button('↕', '移动 tag 到 Folder', () => this.host.library.organize(item, 'move')); handle.onpointerdown = e => this.host.library.startTagDrag(e, item);
      actions.append(handle, button('×', '删除 tag', async () => { await this.host.library.deleteAsset(item); await this.open(this.asset.id); }));
      line.append(actions); local.append(line);
    }
    if (local.childNodes.length) container.append(local);
    for (const item of list.filter(a => a.kind === 'folder')) {
      const branch = element('details', 'folder-branch'); branch.dataset.folderId = item.id;
      branch.dataset.depth = ancestors.size + 1;
      branch.open = !this.collapsed.has(item.id);
      branch.ontoggle = () => { if (branch.open) this.collapsed.delete(item.id); else this.collapsed.add(item.id); };
      const head = element('summary', 'folder-branch-head');
      head.title = `第 ${ancestors.size + 2} 层 · 文件夹`;
      const icon = element('span', 'folder-branch-icon'); icon.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 7V5h6l2 2h10v13H3V7Z M3 10h18"/></svg>';
      head.append(icon, element('span', 'folder-branch-name', item.name));
      const count = (children.get(item.id) || []).filter(a => a.kind === 'tag').length;
      head.append(element('small', 'folder-tag-count', `${count} tag`));
      const actions = element('span', 'folder-row-actions');
      actions.append(button('＋', '添加 tag', event => { event.preventDefault(); return this.host.library.create('tag', item); }),
        button('⋯', '文件夹操作', event => { event.preventDefault(); menu(event.currentTarget, this.host.library.assetMenu(item)); }));
      head.append(actions);
      const body = element('div', 'folder-branch-body'); this.renderFolder(item, body, next, children);
      branch.append(head, body); container.append(branch);
    }
  }
}
