import { assetIcon } from './asset_icons.js';
import { libraryRequest } from './asset_client.js';
import { element, button, input, check, menu, report } from './ui.js';
import { cleanPromptInput } from './prompt_text.js';
import { compareNames } from './folder_tree.js';

// Reuses the Library window, controls and tab lifecycle for Folder/Class pages.
export class FolderPage {
  constructor(container, host) { this.container = container; this.host = host; this.views = new Map(); this.pending = Promise.resolve(); this.histories = new Map(); this.collapsed = new Set(); this.tagDrafts = new Map(); }
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
      const result = await libraryRequest(`save_${asset.kind}`, { id, version: asset.version, name: next.name, parent_id: next.parent_id, data: next.data }, true);
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
  addTags(folder, text) {
    const pageId = this.asset.id;
    const task = this.pending.then(async () => {
      await libraryRequest('save_tag', { parent_id: folder.id, text: cleanPromptInput(text) }, true);
      if (this.tagDrafts.get(folder.id) === text) this.tagDrafts.delete(folder.id);
      this.host.pinLibraryTab?.(`folder:${pageId}`);
      await this.host.library.reload();
      if (this.asset?.id === pageId) { this.render(); this.focusTagInput(folder.id, false); }
    });
    this.pending = task.catch(() => {}); return task;
  }
  focusTagInput(id, reveal = true) {
    const field = [...this.container.querySelectorAll('.folder-tag-add-input')].find(node => node.dataset.classId === id);
    if (reveal) field?.scrollIntoView?.({ block: 'nearest' });
    field?.focus?.({ preventScroll: true });
  }
  tagAdder(folder) {
    const form = element('form', 'folder-tag-add');
    const field = input(this.tagDrafts.get(folder.id) || '', () => {}, { title: '添加 tag' });
    field.classList.add('folder-tag-add-input'); field.dataset.classId = folder.id;
    field.placeholder = 'tag1, tag2, tag3'; field.setAttribute('aria-label', `添加 tag 到 ${folder.name}`);
    field.oninput = () => { this.tagDrafts.set(folder.id, field.value); add.disabled = busy || !field.value.trim(); };
    let busy = false;
    const submit = async () => {
      if (busy || !field.value.trim()) return;
      busy = true; add.disabled = true;
      try { await this.addTags(folder, field.value); } finally { busy = false; add.disabled = !field.value.trim(); }
    };
    const add = button('Add', '添加 tag', submit, 'primary'); add.disabled = !field.value.trim();
    form.onsubmit = event => { event.preventDefault(); submit().catch(report); };
    form.append(field, add); return form;
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
    const isPool = asset.kind === 'class' || this.host.library.data.legacy_pools;
    this.host.folderNameControl.replaceChildren(element('span', '', isPool ? 'Class' : 'Folder'), input(asset.name, name => this.edit(next => { next.name = name; }), { title: `${isPool ? 'Class' : 'Folder'} 名称` }));
    if (isPool) this.host.folderNameControl.append(check(!!asset.data.autocomplete, value => this.edit(next => { next.data.autocomplete = value; }), '加入全局补全（包含 Subclass）'));
    const page = element('div', 'folder-page');
    if (!isPool) {
      const tools = element('div', 'folder-page-tools');
      for (const kind of ['folder','class','block']) tools.append(button(`＋ ${kind === 'folder' ? 'Folder' : kind === 'class' ? 'Class' : 'Block'}`, `新建 ${kind}`, () => this.host.library.create(kind, asset)));
      page.append(tools);
      const children = this.host.library.data.assets.filter(item => item.parent_id === asset.id && item.kind !== 'tag' && !item.library_hidden && !item.lora_root);
      for (const item of children) {
        const row = element('div', 'folder-storage-row');
        row.append(assetIcon(item.kind), button(item.name, this.host.library.path(item), () => this.host.library.openAsset(item)), button('⋯', '对象操作', event => menu(event.currentTarget, this.host.library.assetMenu(item)))); page.append(row);
      }
      if (!children.length) page.append(element('div', 'folder-empty', '暂无 Folder、Class 或 Block'));
      this.container.replaceChildren(page); this.restoreView(); this.host.onFolderRender?.(this); return;
    }
    const children = new Map();
    const ownHiddenPool = this.host.library.data.assets.find(item => item.id === asset.id)?.library_hidden;
    for (const item of this.host.library.data.assets) {
      if (!['class','tag'].includes(item.kind)) continue;
      if (!ownHiddenPool && (item.library_hidden || item.lora_root)) continue;
      if (!children.has(item.parent_id)) children.set(item.parent_id, []);
      children.get(item.parent_id).push(item);
    }
    const tools = element('div', 'folder-page-tools');
    tools.append(button('＋ Class', '添加 Subclass', () => this.host.library.create('class', asset)));
    page.append(tools);
    const contents = element('div', 'folder-tree-body'); page.append(contents);
    this.renderFolder(asset, contents, new Set(), children);
    if (!children.get(asset.id)?.length) page.append(element('div', 'folder-empty', '暂无散装 prompt 或 Subclass'));
    this.rememberView(); this.container.replaceChildren(page); this.restoreView();
    if (this.host.folderContext === asset.id) this.host.renderTabs();
    this.host.onFolderRender?.(this);
  }
  renderFolder(folder, container, ancestors, children) {
    if (ancestors.has(folder.id)) return;
    const next = new Set(ancestors).add(folder.id);
    const list = [...(children.get(folder.id) || [])].sort(compareNames);
    const local = element('div', 'folder-local-tags'); local.dataset.folderId = folder.id;
    const ownTags = list.filter(item => item.kind === 'tag').length;
    if (!ancestors.size && ownTags) local.append(element('div', 'folder-layer-label', `本层 · ${ownTags} tag`));
    local.append(this.tagAdder(folder));
    for (const item of list.filter(a => a.kind === 'tag')) {
      const line = element('div', 'folder-tag-row'); line.dataset.assetId = item.id; line.dataset.depth = ancestors.size + 1; line.title = `第 ${ancestors.size + 2} 层 · tag`;
      line.append(input(item.name, text => this.saveTag(item, text), { title: 'Tag' }));
      const actions = element('span', 'folder-row-actions');
      const handle = button('↕', '移动 prompt 到 Class', () => this.host.library.organize(item, 'move')); handle.onpointerdown = e => this.host.library.startTagDrag(e, item);
      actions.append(handle, button('×', '删除 tag', async () => { await this.host.library.deleteAsset(item); await this.open(this.asset.id); }));
      line.append(actions); local.append(line);
    }
    for (const item of list.filter(a => a.kind === 'class')) {
      const branch = element('details', 'folder-branch'); branch.dataset.folderId = item.id;
      branch.dataset.depth = ancestors.size + 1;
      branch.open = !this.collapsed.has(item.id);
      branch.ontoggle = () => { if (branch.open) this.collapsed.delete(item.id); else this.collapsed.add(item.id); };
      const head = element('summary', 'folder-branch-head');
      head.title = `第 ${ancestors.size + 2} 层 · Class`;
      const icon = assetIcon('class', 'folder-branch-icon', 16);
      head.append(icon, element('span', 'folder-branch-name', item.name));
      const count = (children.get(item.id) || []).filter(a => a.kind === 'tag').length;
      head.append(element('small', 'folder-tag-count', `${count} tag`));
      const actions = element('span', 'folder-row-actions');
      actions.append(button('＋', '添加 tag', event => { event.preventDefault(); branch.open = true; this.collapsed.delete(item.id); this.focusTagInput(item.id); }),
        button('⋯', 'Class 操作', event => { event.preventDefault(); menu(event.currentTarget, this.host.library.assetMenu(item)); }));
      head.append(actions);
      const body = element('div', 'folder-branch-body'); this.renderFolder(item, body, next, children);
      branch.append(head, body); container.append(branch);
    }
    if (local.childNodes.length) container.append(local);
  }
}
