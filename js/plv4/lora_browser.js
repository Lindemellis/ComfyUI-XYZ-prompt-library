import { makeWindow } from '../plv3/theme.js';
import { showForm, showConfirm } from '../plv3/ui.js';
import { element, button, input, report } from './ui.js';
import { mountDesign } from './design_adapter.js';
import { libraryRequest } from './asset_client.js';
import { FolderPage } from './folder_page.js';

export async function loraRequest(operation, body) {
  const response = await fetch(`/xyz/plv4/loras/${operation}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(payload.error || 'LoRA 请求失败');
  return payload;
}

export const loraNodes = app => (app.graph?._nodes || []).filter(node => ['XYZ Prompt Library V4', 'XYZ Prompt Library V4 Monaco'].includes(node.comfyClass));

export class LoraBrowserWindow {
  constructor(app, editor, request = loraRequest) {
    this.app = app; this.editor = editor; this.request = request;
    this.query = ''; this.offset = 0; this.limit = 60; this.pending = Promise.resolve();
  }
  build() {
    if (this.win) return;
    this.editor.build();
    this.win = makeWindow({ key: 'xyz-plv4-loras', title: 'LoRA Browser', defaults: { x: 130, y: 85, w: 1050, h: 720 }, minW: 540, minH: 380, onResize: () => this.layout() });
    this.win.el.classList.add('plv4', 'lora-browser');
    const style = element('style'); document.head.append(style); mountDesign(style).catch(report);
    const css = element('link'); css.rel = 'stylesheet'; css.href = new URL('./lora_browser.css', import.meta.url).href; document.head.append(css);
    this.win.bar.append(button('×', '关闭 LoRA 浏览器', () => this.hide()));
    const toolbar = element('div', 'lora-toolbar');
    this.search = input('', () => {}, { title: '搜索 LoRA 名称或路径' }); this.search.type = 'search'; this.search.placeholder = '搜索 LoRA 名称或路径';
    this.search.oninput = () => { clearTimeout(this.searchTimer); this.searchTimer = setTimeout(() => { this.query = this.search.value; this.offset = 0; this.reload().catch(report); }, 180); };
    this.targets = element('select'); this.targets.title = 'Send 到当前 workflow 的 PLv4 节点'; this.targets.setAttribute('aria-label', this.targets.title);
    this.targets.onchange = () => { this.target = this.nodes[Number(this.targets.value)] || null; this.updateSendButtons(); };
    this.targets.onpointerdown = () => this.refreshTargets(); this.targets.onfocus = () => this.refreshTargets();
    toolbar.append(this.search, element('label', '', 'Send 到'), this.targets, button('↻', '刷新模型目录', () => this.reload(true)));
    const layout = element('div', 'lora-layout'); this.tree = element('aside', 'lora-tree'); this.tree.setAttribute('aria-label', 'LoRA 目录');
    this.grid = element('main', 'lora-grid'); this.details = element('aside', 'lora-details'); this.details.hidden = true;
    layout.append(this.tree, this.grid, this.details);
    this.status = element('div', 'lora-status'); this.pagination = element('div', 'lora-pagination');
    this.win.body.className = 'lora-browser-body'; this.win.body.append(toolbar, layout, this.pagination, this.status);
    addEventListener('resize', () => this.layout());
  }
  layout() {
    if (!this.win) return;
    const el = this.win.el;
    const width = Math.min(parseInt(el.style.width), innerWidth - 12), height = Math.min(parseInt(el.style.height), innerHeight - 12);
    el.style.width = `${width}px`; el.style.height = `${height}px`;
    el.style.left = `${Math.max(6, Math.min(parseInt(el.style.left), innerWidth - width - 6))}px`;
    el.style.top = `${Math.max(6, Math.min(parseInt(el.style.top), innerHeight - height - 6))}px`;
    el.classList.toggle('lora-narrow', width < 850);
  }
  async open(node = null, id = null) {
    this.build(); this.visible = true; this.win.show(); this.layout();
    const preferred = node || this.editor.context?.node || this.editor.seedNode;
    if (loraNodes(this.app).includes(preferred)) this.target = preferred;
    this.refreshTargets(); await this.reload();
    if (id) await this.openDetail(id);
    else if (this.detail && !this.details.hidden) await this.openDetail(this.detail.id);
  }
  hide() { this.visible = false; this.loadToken = (this.loadToken || 0) + 1; this.detailToken = (this.detailToken || 0) + 1; this.win.hide(); }
  refreshTargets() {
    this.nodes = loraNodes(this.app);
    if (!this.nodes.includes(this.target)) this.target = this.nodes[0] || null;
    this.targets.replaceChildren();
    if (!this.nodes.length) { const option = element('option', '', '当前 workflow 没有 PLv4 节点'); option.value = ''; this.targets.append(option); }
    this.nodes.forEach((node, index) => { const option = element('option', '', `${node.title || 'PLv4'} · #${node.id}`); option.value = String(index); this.targets.append(option); });
    this.targets.value = String(this.nodes.indexOf(this.target)); this.targets.disabled = !this.nodes.length; this.updateSendButtons();
  }
  updateSendButtons() { for (const control of this.win.el.querySelectorAll('[data-lora-send]')) control.disabled = !this.target || control.dataset.unavailable === 'true' || control.dataset.sending === 'true'; }
  async reload(refresh = false) {
    const token = this.loadToken = (this.loadToken || 0) + 1;
    this.status.textContent = '正在读取 LoRA…';
    try {
      const result = await this.request('list', { query: this.query, root_id: this.rootId || null, folder: this.folder ?? null, offset: this.offset, limit: this.limit, refresh });
      if (token !== this.loadToken || !this.visible) return;
      if (this.rootId && !result.roots.some(root => root.id === this.rootId)) { this.rootId = null; this.folder = null; this.offset = 0; return this.reload(); }
      if (this.offset >= result.total && this.offset) { this.offset = 0; return this.reload(); }
      this.data = result; this.renderTree(); this.renderCards(); this.refreshTargets();
      this.status.textContent = `${result.total} 个 LoRA`;
    } catch (error) { if (token === this.loadToken && this.visible) this.status.textContent = error.message; throw error; }
  }
  chooseFolder(rootId, folder) { this.rootId = rootId; this.folder = folder; this.offset = 0; return this.reload(); }
  renderTree() {
    this.tree.replaceChildren(button('全部 LoRA', '全部模型目录', () => this.chooseFolder(null, null)));
    for (const root of this.data.roots) {
      const branch = element('details', 'lora-root'); branch.open = true;
      const head = element('summary'); head.append(button(root.name, root.path, () => this.chooseFolder(root.id, '.'))); branch.append(head);
      const render = (parent, container) => {
        const children = root.folders.filter(folder => (folder.includes('/') ? folder.slice(0, folder.lastIndexOf('/')) : '') === parent);
        for (const folder of children) {
          const row = element('details', 'lora-directory'); row.open = this.rootId === root.id && (this.folder === folder || this.folder?.startsWith(folder + '/'));
          const label = element('summary'); label.append(button(folder.split('/').at(-1), folder, () => this.chooseFolder(root.id, folder)));
          row.append(label); render(folder, row); container.append(row);
        }
      };
      render('', branch); this.tree.append(branch);
    }
  }
  sendButton(info) {
    const control = button('Send', `发送 ${info.name} 到所选 PLv4 节点末尾`, () => this.send(info.id, control), 'lora-send');
    control.dataset.loraSend = info.id; control.dataset.unavailable = String(!!info.shadowed);
    control.disabled = !this.target || !!info.shadowed;
    if (info.shadowed) control.title = '同一路径在较优先的模型目录中存在，调整文件名后才能正确加载';
    return control;
  }
  renderCards() {
    this.grid.replaceChildren();
    for (const info of this.data.items) {
      const card = element('article', 'lora-card'); card.dataset.loraId = info.id;
      const cover = button('', `查看 ${info.name} 的预览和触发词`, () => this.openDetail(info.id), 'lora-cover');
      if (info.images.length) { const image = element('img'); image.src = info.images[0].url; image.alt = info.name; image.loading = 'lazy'; image.onerror = () => { image.remove(); cover.append(element('span', '', '暂无预览')); }; cover.append(image); }
      else cover.append(element('span', '', '暂无预览'));
      const foot = element('div', 'lora-card-footer'); const name = button(info.name, info.relative, () => this.openDetail(info.id), 'lora-card-name');
      foot.append(name, this.sendButton(info)); card.append(cover, foot, element('small', 'lora-card-path', info.relative)); this.grid.append(card);
    }
    if (!this.data.items.length) this.grid.append(element('p', 'lora-empty', '没有匹配的 LoRA'));
    const previous = button('上一页', '上一页', () => { this.offset = Math.max(0, this.offset - this.limit); return this.reload(); }); previous.disabled = !this.offset;
    const next = button('下一页', '下一页', () => { this.offset += this.limit; return this.reload(); }); next.disabled = this.offset + this.limit >= this.data.total;
    this.pagination.replaceChildren(previous, element('span', '', `${Math.floor(this.offset / this.limit) + 1} / ${Math.max(1, Math.ceil(this.data.total / this.limit))}`), next);
  }
  send(id, control) {
    const node = this.target, graph = this.app.graph, epoch = this.editor.graphEpoch || 0;
    if (!node || !loraNodes(this.app).includes(node)) return Promise.reject(new Error('请先选择当前 workflow 的 PLv4 节点'));
    if (control?.dataset.sending === 'true') return this.pending;
    if (control) { control.dataset.sending = 'true'; control.disabled = true; control.textContent = '发送中…'; }
    const task = this.pending.then(async () => {
      const info = await this.request('send', { id });
      await this.editor.sendLora(node, info, graph, epoch);
      if (this.visible) this.status.textContent = `已发送 ${info.name} → ${node.title || 'PLv4'} · #${node.id}`;
    }).finally(() => { if (control) { control.dataset.sending = 'false'; control.textContent = 'Send'; } if (this.win) this.updateSendButtons(); });
    this.pending = task.catch(() => {}); return task;
  }
  async openDetail(id) {
    const token = this.detailToken = (this.detailToken || 0) + 1;
    await this.folderPage?.whenIdle();
    const info = await this.request('detail', { id });
    if (token !== this.detailToken || !this.visible) return;
    this.folderPage = null; this.poolLoad = null;
    this.detail = info; this.details.hidden = false; this.details.replaceChildren();
    const tools = element('div', 'lora-detail-tools'); tools.append(element('strong', '', info.name), this.sendButton(info), button('×', '关闭详情', async () => { await this.folderPage?.whenIdle(); this.detailToken++; this.details.hidden = true; })); this.details.append(tools);
    this.details.append(element('small', 'lora-detail-path', info.relative));
    const gallery = element('div', 'lora-gallery');
    const image = element('img'); image.alt = info.name;
    if (info.images.length) {
      image.src = info.images[0].url; gallery.append(image);
      const thumbnails = element('div', 'lora-thumbnails');
      info.images.forEach((preview, index) => { const thumbnail = button('', `预览 ${index + 1}`, () => { image.src = preview.url; }); const small = element('img'); small.src = preview.url; small.alt = `预览 ${index + 1}`; small.loading = 'lazy'; thumbnail.append(small); thumbnails.append(thumbnail); });
      gallery.append(thumbnails);
    } else gallery.append(element('p', 'lora-empty', '暂无预览图'));
    this.details.append(gallery);
    const links = element('div', 'lora-detail-links');
    if (info.civitai_url) { const link = element('a', '', 'Open in Civitai ↗'); link.href = info.civitai_url; link.target = '_blank'; link.rel = 'noopener noreferrer'; links.append(link); }
    links.append(button('获取 Civitai 资料', '获取模型版本、预览图和触发词，保存在本地', async event => {
      const control = event.currentTarget; control.disabled = true; control.textContent = '获取中…';
      try { await this.request('fetch', { id }); if (this.visible && this.detail?.id === id) { await this.openDetail(id); await this.reload(); } }
      finally { control.disabled = false; control.textContent = '获取 Civitai 资料'; }
    })); this.details.append(links);
    if (info.base_model) this.details.append(element('p', '', info.base_model));
    if (info.triggers.length) {
      const triggers = element('div', 'lora-triggers');
      for (const text of info.triggers) triggers.append(element('p', 'lora-trigger-group', text));
      this.details.append(triggers);
    }
    const section = this.folderSection = element('details', 'lora-folder-section'); section.open = !!this.folderExpanded;
    section.append(element('summary', 'lora-folder-heading', '触发词 Folder'));
    const body = element('div', 'lora-folder-body');
    if (info.triggers.length) {
      const tools = element('div', 'lora-folder-tools');
      tools.append(button('导入资料中的触发词', '导入触发词组合，保留手工编辑', async event => {
        const control = event.currentTarget; control.disabled = true;
        try {
          await this.ensurePool(id, token); await this.folderPage?.whenIdle();
          if (token !== this.detailToken || !this.visible) return;
          const current = await this.request('detail', { id, ensure: true, import_triggers: true });
          if (token === this.detailToken && this.visible) await this.openPool(current.pool_id, token);
        } finally { control.disabled = false; }
      })); body.append(tools);
    }
    this.folderControls = element('div', 'lora-folder-controls'); this.folderContainer = element('div', 'lora-folder-page');
    body.append(this.folderControls, this.folderContainer); section.append(body); this.details.append(section);
    section.ontoggle = () => {
      if (token !== this.detailToken || !this.visible) return;
      this.folderExpanded = section.open;
      if (section.open) this.ensurePool(id, token).catch(report);
    };
  }
  ensurePool(id, token = this.detailToken) {
    if (token !== this.detailToken || !this.visible) return Promise.resolve();
    if (this.poolLoad) return this.poolLoad;
    if (this.folderPage?.asset && this.folderContainer.querySelector('.folder-page')) return Promise.resolve(this.folderPage);
    const container = this.folderContainer;
    container.replaceChildren(element('p', 'lora-empty', '正在读取触发词…'));
    const task = (async () => {
      try {
        const current = await this.request('detail', { id, ensure: true });
        if (token === this.detailToken && this.visible) await this.openPool(current.pool_id, token);
      } catch (error) {
        if (token === this.detailToken && this.visible) container.replaceChildren(element('p', 'lora-empty', error.message), button('重试', '重新读取触发词 Folder', () => this.ensurePool(id, token)));
        throw error;
      }
    })().finally(() => { if (this.poolLoad === task) this.poolLoad = null; });
    this.poolLoad = task; return task;
  }
  renderPoolControls(page) {
    const controls = page.host.folderNameControl;
    const [caption, name, toggle] = [...controls.children];
    const nameRow = element('label', 'lora-folder-name'); nameRow.append(caption, name);
    const options = element('div', 'lora-folder-options');
    const autocomplete = element('label', 'lora-folder-autocomplete'); autocomplete.append(toggle, element('span', '', '全局补全'));
    const history = element('div', 'lora-folder-history');
    const saved = page.histories.get(page.asset.id);
    const undo = button('↶', '撤销 Folder 设置', () => page.undo()), redo = button('↷', '重做 Folder 设置', () => page.redo());
    undo.disabled = !saved?.past.length; redo.disabled = !saved?.future.length;
    history.append(undo, redo); options.append(autocomplete, history); controls.replaceChildren(nameRow, options);
  }
  async openPool(id, token = this.detailToken) {
    if (token !== this.detailToken || !this.visible) return;
    if (this.folderPage?.asset?.id === id) { await this.folderPage.open(id); return; }
    const browser = this, editorLibrary = this.editor.library;
    const refresh = async () => { await editorLibrary.reload(); if (browser.folderPage) await browser.folderPage.open(id); };
    const library = {
      get data() { return editorLibrary.data; }, path: asset => editorLibrary.path(asset), reload: () => editorLibrary.reload(),
      async create(kind, parent) {
        const form = await showForm(`新建 ${kind}`, [{ key: 'name', label: kind === 'tag' ? '提示词' : '名称', value: '' }]); if (!form) return;
        await libraryRequest(`save_${kind}`, { name: form.name, parent_id: parent.id, data: { autocomplete: false } }, true); await refresh();
      },
      async deleteAsset(asset) {
        if (!await showConfirm(`删除“${asset.name}”？`, { okLabel: '删除', danger: true })) return;
        const current = await libraryRequest('get', { id: asset.id }); await libraryRequest('delete', { id: current.id, version: current.version }, true); await refresh();
      },
      async organize(asset, action) {
        const current = await libraryRequest('get', { id: asset.id });
        const options = editorLibrary.data.assets.filter(item => item.kind === 'folder');
        const form = await showForm(action === 'move' ? '移动到 Folder' : '重命名', [{ key: action === 'move' ? 'parent' : 'name', label: action === 'move' ? '位置' : '名称', value: action === 'move' ? current.parent_id : current.name, ...(action === 'move' ? { options: options.map(item => ({ value: item.id, label: editorLibrary.path(item) })) } : {}) }]); if (!form) return;
        await libraryRequest(action, { id: current.id, version: current.version, ...(action === 'move' ? { parent_id: form.parent } : { name: form.name }) }, true); await refresh();
      },
      assetMenu(asset) { return [['重命名', () => library.organize(asset, 'rename')], ['删除', () => library.deleteAsset(asset)]]; },
      startTagDrag() {},
    };
    const host = { library, folderNameControl: this.folderControls, folderContext: id, renderTabs() {}, pinLibraryTab() {}, onFolderRender: page => this.renderPoolControls(page) };
    const page = this.folderPage = new FolderPage(this.folderContainer, host);
    this.folderControls.replaceChildren(); await page.open(id);
    if (token !== this.detailToken || this.folderPage !== page || !this.visible) return;
  }
}
