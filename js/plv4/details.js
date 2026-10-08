import { element, button, input, check, report } from './ui.js';
import { dualSlider } from '../plv3/theme.js';
import { settings } from '../plv3/settings.js';
import { libraryRequest } from './asset_client.js';
import { inlinePrompt, cleanPromptInput } from './prompt_text.js';
import { attachPromptAutocomplete } from '../tagac_host.js';
import { compactFolders } from './folder_tree.js';

export const isBlock = row => row.kind === 'group' && row.form !== 'paren' && !inlinePrompt(row);
export function indexTree(tree) { const map = new Map(); const visit = n => { if (!n) return; map.set(n.id, n); n.children.forEach(visit); }; visit(tree); return map; }
export const nameOf = row => row.meta?.name || row.ast?.header || ({ schedule: 'Schedule', region: 'Region', schedule_entry: 'Schedule', region_entry: 'Region' }[row.form]) || '';
const textOf = node => node.source ?? (node.kind !== 'group' || node.opaque ? node.raw || '' : (node.open || '') + (node.lead || '') + (node.children || []).map(child => textOf(child) + (child.sep || '')).join('') + (node.close || ''));

export function promptKey(node) {
  while (node.kind === 'group' && node.children?.length === 1 && (node.form === 'paren' || node.meta?.presentation === 'prompt') && !node.settings?.region) node = node.children[0];
  const text = textOf(node).trim();
  if (node.kind === 'lora') return text.replace(/:([-+\d.eE]+)>$/, '>');
  return text.replace(/_/g, ' ').replace(/\s+/g, ' ');
}

export class DetailsPane {
  constructor(container, host) { this.container = container; this.host = host; this.sections = {}; this.promptStates = new WeakMap(); this.poolViews = new WeakMap(); this.scrollStates = new WeakMap(); this.poolFilters = new WeakMap(); this.poolPending = new WeakMap(); }
  rememberScroll() {
    if (!this.mountedSession) return;
    let states = this.scrollStates.get(this.mountedSession); if (!states) { states = new Map(); this.scrollStates.set(this.mountedSession, states); }
    states.set(this.mountedOwner, { outer: this.container.scrollTop || 0, inner: this.container.querySelector('.plv4-details')?.scrollTop || 0 });
  }
  render(session, { keepOwner = false } = {}) {
    this.rememberScroll();
    const token = this.token = (this.token || 0) + 1;
    if (!session) { this.container.replaceChildren(); this.mountedSession = null; this.ownerId = null; return; }
    const previousSession = this.session;
    this.session = session;
    if (!this.promptStates.has(session)) this.promptStates.set(session, new Set());
    this.expandedPrompts = this.promptStates.get(session);
    const byId = indexTree(session.projection.tree);
    const selection = session.state.selection;
    const row = (keepOwner && previousSession === session && byId.get(this.ownerId)) || byId.get(selection.block_id || selection.node_id) || session.projection.tree;
    if (!row) { this.container.replaceChildren(element('div', 'plv4-empty', '原稿尚未完成，先在 PLv3 中修复。')); return; }
    this.ownerId = row.id;
    const page = element('div', 'plv4-scroll plv4-details');
    const top = element('div', 'inspector-head');
    const name = input(row.meta?.name || '', value => this.command('SetMetadata', row, { patch: { name: value } }), { title: 'Block 名称' }); name.placeholder = 'Block 名称'; name.dataset.field = 'name';
    name.classList.add('detail-name'); top.append(name, button('×', '关闭 Details', () => this.host.toggleDetails(false), 'tiny-button')); page.append(top);
    if (row.form !== 'root') {
      const field = this.field('Format', input(row.settings?.format || '', value => this.setting(row, 'format', value || null)));
      field.querySelector('input').classList.add('format-input');
      const common = this.section('GENERAL');
      common.append(this.field('Enable', check(row.enabled, enabled => this.command('SetEnabled', row, { enabled }))),
        this.field('Weight', this.weightControl(row.settings?.weight ?? 1, value => this.setting(row, 'weight', value), { min: 0 })),
        this.field('Shuffle', check(!!row.settings?.shuffle, value => this.setting(row, 'shuffle', value))), field);
      const random = this.section('RANDOM');
      random.append(this.field('Random select', input(row.settings?.random_select?.join('-') || '', value => {
          const numbers = value.trim() ? value.split('-').map(Number) : null;
          if (numbers?.some(n => !Number.isInteger(n))) throw new Error('Random select 使用整数或整数范围');
          return this.setting(row, 'random_select', numbers?.length === 1 ? numbers[0] : numbers);
        })), this.field('Dropout', input(row.settings?.dropout ?? 0, value => this.setting(row, 'dropout', value), { type: 'number', min: 0, max: 1, step: .05 })));
      page.append(common, random);
      if (!['schedule', 'region'].includes(row.form)) {
        const timing = this.section('TIMING & REGION');
        if (row.form === 'schedule_entry') this.interval(timing, row.settings.schedule, (value, side) => this.command('SetScheduleBoundary', row, { side, value }));
        else {
          timing.append(this.field('Schedule', check(!!row.settings?.schedule, enabled => this.setting(row, 'schedule', enabled ? [0, 1] : null))));
          if (row.settings?.schedule) this.interval(timing, row.settings.schedule, interval => this.setting(row, 'schedule', interval));
        }
        if (row.form !== 'region_entry') timing.append(this.field('Region', check(!!row.settings?.region, enabled => this.setting(row, 'region', enabled ? { kind: 'base' } : null))));
        if (row.settings?.region || row.form === 'region_entry') {
          const region = element('div'); this.region(region, row, row.form === 'region_entry');
          timing.append(...region.querySelectorAll('.plv4-field'));
        }
        page.append(timing);
      }
      const pool = this.section('池绑定');
      const poolId = row.meta?.pool;
      const folder = this.host.library.data?.assets?.find(a => a.id === poolId);
      pool.append(this.field('文件夹', button(`${folder ? folder.name : poolId ? '池已删除 / 不在本机' : '未绑定'} ▾`, folder ? this.host.library.path(folder) : '绑定 Folder 池', () => this.host.libraryAction('pool', row), 'pool-setting')));
      page.append(pool);
      if (row.meta?.source?.kind === 'block') {
        const status = element('div', 'plv4-row');
        status.append(button('覆盖回库', '显式覆盖来源 block', () => this.host.saveBlock(row))); page.append(status);
        this.sourceStatus(row, status, token).catch(error => { if (token === this.token) status.append(element('span', 'plv4-badge', error.message)); });
      }
    }
    if (row.form === 'schedule' || row.form === 'region') {
      const entries = this.section(row.form === 'schedule' ? 'Schedule entries' : 'Region entries');
      const regionTree = row.form === 'region' ? element('div', 'detail-contents-tree detail-region-tree') : null;
      if (regionTree) entries.append(regionTree);
      for (const [index, entry] of row.children.entries()) {
        if (regionTree) { this.regionEntry(regionTree, row, entry, session, index); continue; }
        const line = element('div', 'plv4-row');
        line.append(check(entry.enabled, value => this.command('SetEnabled', entry, { enabled: value })), button(nameOf(entry), nameOf(entry), () => this.host.locate(entry.id)), button('×', '删除 entry', () => this.command('Delete', entry)));
        entries.append(line);
        if (row.form === 'schedule') this.interval(entries, entry.settings.schedule, (value, side) => this.command('SetScheduleBoundary', entry, { side, value }));
      }
      entries.append(button('+', '添加 entry', () => this.host.addBlock(row.id, true))); page.append(entries);
    }
    const prompts = this.section('Content');
    prompts.classList.add('detail-content-section');
    const contentTree = element('div', 'detail-contents-tree'); contentTree.dataset.depth = 0; prompts.append(contentTree);
    this.localContents(row.children, contentTree, session, row);
    const folder = row.meta?.pool && this.host.library?.data?.assets?.find(asset => asset.id === row.meta.pool);
    let pending = null;
    const add = button('＋ 添加 prompt', '添加 prompt', () => this.host.addPrompt(row), 'small-add'); prompts.append(add);
    page.append(prompts);
    if (row.meta?.pool) {
      const poolSection = this.section('Pool'), poolTree = element('div', 'plv4-candidates pool-tree');
      poolSection.classList.add('detail-pool-section');
      poolSection.append(poolTree); page.append(poolSection);
      if (folder) pending = this.candidates(session, row, row.meta.pool, poolTree, token).catch(error => {
        if (token === this.token) poolTree.replaceChildren(element('p', 'pool-help', `池读取失败：${error.message}`));
      });
      else poolTree.append(element('p', 'pool-help', 'Folder 已删除 / 不在本机。当前内容仍可在 Content 编辑。'));
    }
    XYZPLv4Design.foldSections(page, { id: row.id, type: ['schedule', 'region'].includes(row.form) ? row.form : 'normal', schedule: row.settings?.schedule, region: row.settings?.region }, this.sections);
    const mount = () => {
      if (token !== this.token) return;
      // The old tree stays mounted while pool data loads, so its scroll extent
      // never collapses to an empty placeholder between toggle and redraw.
      this.rememberScroll();
      const scroll = this.scrollStates.get(session)?.get(row.id) || { outer: 0, inner: 0 };
      this.container.replaceChildren(page); page.scrollTop = scroll.inner; this.container.scrollTop = scroll.outer;
      this.mountedSession = session; this.mountedOwner = row.id;
    };
    if (pending) {
      if (this.mountedSession !== session || this.mountedOwner !== row.id) {
        this.container.replaceChildren(element('div', 'plv4-empty', '正在读取池内容…')); this.mountedSession = null;
      }
      this.pendingRender = pending.then(mount);
    } else { mount(); this.pendingRender = Promise.resolve(); }
  }
  promptInfo(item) {
    const textItem = (item.meta?.presentation === 'prompt' || item.form === 'paren') && item.children?.length === 1 ? item.children[0] : item;
    const values = { ...textItem.settings, ...item.settings };
    if (textItem.kind === 'lora') values.weight = this.weight(textItem);
    return { textItem, values };
  }
  promptRow(container, item, selection = {}, { local = item, onToggle = value => this.command('SetEnabled', item, { enabled: value }), active = true } = {}) {
    const { textItem, values } = this.promptInfo(item), id = textItem.id;
    // Library snapshots omit children on leaves; projections include an empty array.
    const containsSelection = n => n.id === selection.node_id || (n.children || []).some(containsSelection);
    const line = element('div', `plv4-item-row item-row detail-prompt-row${containsSelection(item) ? ' target active' : ''}`); line.dataset.promptId = item.id; line.dataset.candidateKind = 'tag'; line.dataset.tagText = textOf(item).trim();
    if (local && (!local.enabled || !active)) line.classList.add('detail-content-disabled');
    const text = input(textOf(textItem), value => this.command('ReplaceItem', textItem, { text: cleanPromptInput(value) }), { title: 'Prompt' });
    text.readOnly = !local || !active;
    if (!text.readOnly) attachPromptAutocomplete(text).catch(report);
    const panel = element('div', 'prompt-extra'); panel.dataset.promptSettings = id;
    const fold = button('', '展开 / 收起 prompt 设置', () => {
      if (this.expandedPrompts.has(id)) this.expandedPrompts.delete(id); else this.expandedPrompts.add(id);
      paint();
    }, 'tiny-button prompt-fold');
    const paint = () => {
      const open = this.expandedPrompts.has(id);
      panel.hidden = !open; fold.textContent = open ? '▾' : '▸'; fold.setAttribute('aria-expanded', String(open));
    }; paint();
    const remove = button('×', '删除 prompt', () => this.command('Delete', item), 'tiny-button'); remove.dataset.deletePrompt = id; remove.hidden = !local; remove.disabled = !active;
    const toggle = check(!!local?.enabled, onToggle); toggle.disabled = !active;
    toggle.setAttribute('aria-label', `启用 / 关闭 prompt：${textOf(textItem)}`);
    line.append(toggle, text, fold, remove);
    this.promptSetting(panel, textItem, { ...values, weight: values.weight ?? this.weight(textItem) }, 'weight');
    this.promptSetting(panel, textItem, values, 'schedule');
    if (!local || !active) panel.querySelectorAll('input,button,select').forEach(control => { control.disabled = true; });
    container.append(line, panel);
  }
  promptSetting(container, item, values, kind) {
    const card = element('div', 'prompt-setting'); card.dataset.settingKind = kind;
    const title = kind[0].toUpperCase() + kind.slice(1);
    const head = element('div', 'prompt-setting-head'); head.append(element('label', '', title));
    const apply = value => this.command('SetPromptSettings', item, { patch: { [kind]: value } });
    if (kind === 'weight') head.append(this.weightControl(values.weight, apply));
    const reset = button(kind === 'weight' ? '↺' : '×', kind === 'weight' ? '重置 Weight' : '清除 Schedule 区间', () => apply(kind === 'weight' ? 1 : null), 'tiny-button');
    if (kind === 'schedule') reset.disabled = !values.schedule;
    head.append(reset); card.append(head);
    if (kind === 'schedule') this.interval(card, values.schedule, apply);
    container.append(card);
  }
  command(type, row, extra = {}) { return this.host.command({ type, id: row.id, ...extra }); }
  async sourceStatus(row, container, token) {
    const source = row.meta.source; const expected = { ...source.dependencies, [source.id]: source.version };
    const latest = await libraryRequest('versions', { ids: Object.keys(expected) }); if (token !== this.token) return;
    if (!(source.id in latest.versions)) { container.append(element('span', 'plv4-badge', '来源已删除 · 本地快照保留')); return; }
    container.append(button('从库更新', '用最新来源更新此副本', () => this.host.updateSource(row)));
    if (Object.entries(expected).some(([id, version]) => latest.versions[id] !== version)) container.append(element('span', 'plv4-badge', '来源有更新'));
  }
  treeIcon(kind) {
    const node = element('span', 'pool-kind-icon'); node.setAttribute('aria-hidden', 'true');
    const paths = {
      folder: 'M3 7V5h6l2 2h10v13H3V7Z M3 10h18',
      block: 'm12 3 9 5v9l-9 5-9-5V8l9-5Z M3 8l9 5 9-5 M12 13v9',
      tag: 'M4 4h7l9 9-7 7-9-9V4Z M8 8h.01',
    };
    node.dataset.iconKind = kind;
    node.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"><path d="${paths[kind]}"/></svg>`;
    return node;
  }
  treeBranch(session, owner, kind, key, name, depth) {
    let views = this.poolViews.get(session); if (!views) { views = new Map(); this.poolViews.set(session, views); }
    const box = element('details', `pool-branch detail-tree-branch pool-${kind}`); box.dataset.depth = depth;
    const stateKey = `${owner.id}:${owner.meta?.pool || ''}:${key}`; box.open = views.get(stateKey) ?? (kind === 'folder' && depth === 0);
    box.ontoggle = () => views.set(stateKey, box.open);
    const head = element('summary', `pool-branch-head pool-${kind}-head`), body = element('div', 'pool-branch-body'); body.dataset.depth = depth + 1;
    head.title = `第 ${depth + 1} 层 · ${kind === 'folder' ? '文件夹' : 'block'} · ${name}`;
    head.dataset.candidateKind = kind;
    box.append(head, body); return {box, head, body};
  }
  blockRow(container, node, session, owner, { local = node, depth = 0, key = node.id, active = true, onToggle = value => this.command('SetEnabled', node, { enabled: value }), name = nameOf(node) || 'Block' } = {}) {
    const {box, head, body} = this.treeBranch(session, owner, 'block', key, name, depth);
    if (local) box.dataset.localBlockId = local.id;
    if (local && (!local.enabled || !active)) head.classList.add('detail-content-disabled');
    const toggle = check(!!local?.enabled, onToggle); toggle.disabled = !active;
    toggle.onclick = event => event.stopPropagation(); toggle.setAttribute('aria-label', `启用 / 关闭整个 block：${name}`);
    head.append(toggle, this.treeIcon('block'), element('span', 'pool-branch-name', name), element('small', 'pool-type', 'block'));
    if (local) {
      head.append(button('⚙', '打开此 block 的设置', () => this.host.locate(local.id), 'detail-block-settings'));
      const remove = button('×', '从 Content 删除此 block', () => this.command('Delete', local), 'tiny-button');
      remove.dataset.deleteBlock = local.id; remove.disabled = !active; head.append(remove);
    }
    container.append(box);
    if (!local) body.append(element('p', 'pool-help', '尚未加入。勾选上方 block 可整体加入。'));
    this.localContents(local?.children || node.children || [], body, session, owner, depth + 1, active && !!local?.enabled, !!local);
    return {box, head, body};
  }
  localContents(children, container, session, owner, depth = 0, active = owner.enabled !== false && owner.effective !== false, present = true) {
    if (!this.promptStates.has(session)) this.promptStates.set(session, new Set()); this.expandedPrompts = this.promptStates.get(session);
    for (const item of children) {
      if (isBlock(item)) this.blockRow(container, item, session, owner, { local: present ? item : null, depth, key: `local:${item.id}`, active });
      else this.promptRow(container, item, session.state?.selection || {}, { local: present ? item : null, active });
    }
  }
  poolMatches(owner) {
    const prompts = [], blocks = [];
    const scan = (node, parentActive) => {
      const active = parentActive && node.enabled !== false;
      if (node !== owner) {
        if (isBlock(node)) blocks.push({ node, active }); else { prompts.push({ node, active }); return; }
        if (node.meta?.pool) return;
      }
      for (const child of node.children || []) scan(child, active);
    };
    scan(owner, owner.effective !== false || owner.enabled === false);
    return candidate => {
      const matches = candidate.kind === 'tag' ? prompts.filter(({node}) => promptKey(node) === promptKey(candidate.snapshot)) : blocks.filter(({node}) =>
        (candidate.source?.id && node.meta?.source?.kind === 'block' && node.meta.source.id === candidate.source.id) ||
        (candidate.occurrence && JSON.stringify(node.meta?.occurrence) === JSON.stringify(candidate.occurrence)));
      return matches.find(match => match.active) || matches[0] || null;
    };
  }
  highlightJoined(id) {
    for (const node of this.container.querySelectorAll('[data-prompt-id],[data-local-block-id]')) {
      if (node.dataset.promptId === id || node.dataset.localBlockId === id) node.classList.add('pool-highlight');
    }
  }
  addPoolCandidate(session, owner, candidate) {
    const task = (this.poolPending.get(session) || Promise.resolve()).then(async () => {
      if (this.host.context?.session !== session) return;
      const current = session.projection?.tree ? indexTree(session.projection.tree).get(owner.id) : owner;
      if (!current) return;
      const match = this.poolMatches(current)(candidate);
      if (match) { this.highlightJoined(match.node.id); return; }
      if (current.enabled === false || current.effective === false) return;
      const target = { parent_id: current.id, edge: 'end' };
      const entry = await this.host.entryTarget(current, target); if (entry === false || this.host.context?.session !== session) return;
      return this.host.command({ type: 'EnableCandidate', ...target, snapshot: candidate.snapshot, source: candidate.source, occurrence: candidate.occurrence, ...(entry ? { entry } : {}) });
    });
    this.poolPending.set(session, task.catch(() => {})); return task;
  }
  previewContents(children, container, session, owner, depth, key) {
    for (const node of children || []) {
      if (isBlock(node)) {
        const branch = this.treeBranch(session, owner, 'block', `preview:${key}:${node.id}`, nameOf(node) || node.meta?.name || node.header || 'Block', depth);
        branch.head.append(this.treeIcon('block'), element('span', 'pool-branch-name', nameOf(node) || node.header || 'Block'), element('small', 'pool-type', 'block'));
        container.append(branch.box); this.previewContents(node.children, branch.body, session, owner, depth + 1, key);
      } else {
        const line = element('div', 'detail-prompt-row pool-preview-prompt');
        line.append(this.treeIcon('tag'), element('span', 'pool-prompt-text', textOf(node).trim())); container.append(line);
        if (node.enabled === false) line.classList.add('pool-preview-off');
      }
    }
  }
  async candidates(session, owner, pool, container, token) {
    const data = await libraryRequest('candidates', { pool }); if (token !== this.token || this.host.context?.session !== session) return;
    let filters = this.poolFilters.get(session); if (!filters) { filters = new Map(); this.poolFilters.set(session, filters); }
    const filterKey = `${owner.id}:${pool}`;
    if (!filters.has(filterKey)) filters.set(filterKey, { kind: 'all', usage: 'all' });
    const filter = filters.get(filterKey), controls = element('div', 'pool-controls'), tree = element('div', 'detail-contents-tree pool-candidate-tree');
    const legend = element('div', 'pool-legend'); legend.setAttribute('aria-label', 'Pool 条目类型');
    for (const [kind, label] of [['folder','Folder'],['block','Block'],['tag','Prompt']]) {
      const item = element('span', 'pool-legend-item'); item.dataset.kind = kind;
      item.append(this.treeIcon(kind), element('span', '', label)); legend.append(item);
    }
    controls.append(legend);
    const select = (key, title, options) => {
      const label = element('label', 'pool-filter-row', title), field = element('select', `pool-filter-${key}`);
      for (const [value, text] of options) { const option = element('option', '', text); option.value = value; field.append(option); }
      field.value = filter[key]; field.setAttribute('aria-label', title);
      field.onchange = () => { filter[key] = field.value; paint(); };
      label.append(field); controls.append(label);
    };
    select('kind', '类型', [['all','全部'],['tag','Prompt'],['block','Block']]);
    select('usage', '加入状态', [['all','全部'],['unused','未加入']]);
    const folding = element('div', 'pool-fold-controls');
    for (const [open, title] of [[true,'全部展开'],[false,'全部折叠']]) folding.append(button(title, title, () => {
      for (const branch of tree.querySelectorAll('details')) { branch.open = open; branch.ontoggle?.(); }
    }, 'pool-fold-all'));
    controls.append(folding); container.append(controls, tree);
    const shortName = (candidate, parentPath) => this.host.library?.data?.assets?.find(a => a.id === candidate.id)?.name || (parentPath && candidate.name.startsWith(parentPath + '.') ? candidate.name.slice(parentPath.length + 1) : candidate.name);
    const paint = () => {
      const current = session.projection?.tree ? indexTree(session.projection.tree).get(owner.id) || owner : owner;
      const match = this.poolMatches(current), active = current.enabled !== false && current.effective !== false;
      const filtered = filter.kind !== 'all' || filter.usage !== 'all';
      const choose = nodes => nodes.flatMap(candidate => {
        if (candidate.kind === 'folder') {
          const children = choose(candidate.children);
          // Filtering must not turn a real branch or a nonempty Folder into a compact chain.
          const compactChild = candidate.children.length === 1 && candidate.children[0].kind === 'folder' ? candidate.children[0].id : null;
          return children.length || !filtered ? [{...candidate, children, compactChild}] : [];
        }
        return (filter.kind === 'all' || candidate.kind === filter.kind) && (filter.usage === 'all' || !match(candidate)) ? [candidate] : [];
      });
      const decorate = (line, candidate, selected, name) => {
        line.dataset.candidateKind = candidate.kind; line.dataset.poolCandidate = candidate.source?.id || candidate.id || '';
        line.dataset.poolState = selected ? 'joined' : 'unused';
        if (selected) line.classList.add('pool-joined');
        const add = button('＋', selected ? '已加入：提示当前位置，不重复添加' : `添加 ${name} 到 Content 末尾`, () => this.addPoolCandidate(session, current, candidate), 'pool-add');
        add.dataset.action = 'add-pool-candidate'; add.disabled = !active; add.setAttribute('aria-label', `添加 ${name}`);
        line.append(add);
      };
      const status = (line, selected) => line.append(element('small', 'pool-usage', selected ? '已添加' : '未添加'));
      const walk = (nodes, parent, depth = 0, parentPath = '', actualDepth = depth) => nodes.forEach(candidate => {
        const name = shortName(candidate, parentPath);
        if (candidate.kind === 'folder') {
          const chain = compactFolders(candidate, folder => folder.children, (folder, child) => folder.compactChild === child.id);
          const terminal = chain.at(-1);
          let previousPath = parentPath;
          const label = chain.map(folder => { const local = shortName(folder, previousPath); previousPath = folder.name; return local; }).join(' / ');
          const key = filtered ? `${candidate.id}:filter:${filter.kind}:${filter.usage}` : candidate.id;
          const {box, head, body} = this.treeBranch(session, owner, 'folder', key, label, depth);
          box.dataset.folderChain = JSON.stringify(chain.map(folder => folder.id)); box.dataset.actualDepth = actualDepth;
          if (filtered) {
            const states = this.poolViews.get(session), stateKey = `${owner.id}:${owner.meta?.pool || ''}:${key}`;
            box.open = states.get(stateKey) ?? true;
          }
          head.title = `第 ${actualDepth + 1}${chain.length > 1 ? `–${actualDepth + chain.length}` : ''} 层 · 文件夹 · ${terminal.name}`;
          head.append(this.treeIcon('folder'), element('span', 'pool-branch-name', label));
          if (terminal.id !== pool) {
            const insert = button('＋子 block', '作为 sub block 插入：本层全部散装 tag，默认启用', async () => {
              const source = await libraryRequest('folder_block', { id: terminal.id, fill: true });
              const target = { parent_id: current.id, edge: 'end' };
              const entry = await this.host.entryTarget(current, target); if (entry === false) return;
              return this.host.command({ type: 'InsertLibraryBlock', ...target, snapshot: source.snapshot, source: source.source, ...(entry ? { entry } : {}) });
            }, 'pool-insert');
            insert.disabled = !active; insert.dataset.action = 'insert-folder-block'; head.append(insert);
          }
          parent.append(box); walk(terminal.children, body, depth + 1, terminal.name, actualDepth + chain.length);
          if (!terminal.children.length) body.append(element('span', 'pool-empty', '空文件夹')); return;
        }
        const selected = match(candidate);
        if (candidate.kind === 'tag') {
          const line = element('div', 'detail-prompt-row pool-candidate-prompt'); line.dataset.tagText = textOf(candidate.snapshot).trim();
          decorate(line, candidate, selected, name);
          line.append(this.treeIcon('tag'), element('span', 'pool-prompt-text', textOf(candidate.snapshot).trim())); status(line, selected); parent.append(line); return;
        }
        const key = JSON.stringify(candidate.occurrence), branch = this.treeBranch(session, owner, 'block', key, name, depth);
        branch.head.title = candidate.source?.path || candidate.name;
        decorate(branch.head, candidate, selected, name);
        branch.head.append(this.treeIcon('block'), element('span', 'pool-branch-name', name), element('small', 'pool-type', 'block')); status(branch.head, selected);
        parent.append(branch.box); this.previewContents(candidate.snapshot.children, branch.body, session, owner, depth + 1, key);
      });
      tree.replaceChildren(); const visible = choose(data.candidates); walk(visible, tree);
      if (!visible.length) tree.append(element('p', 'pool-empty', '没有符合筛选的条目'));
    };
    paint();
  }
  setting(row, key, value) { return this.command('SetSettings', row, { patch: { [key]: value } }); }
  section(title) { const node = element('section', 'plv4-section section'); node.append(element('div', 'section-title', title)); return node; }
  field(label, control) { const line = element('div', 'plv4-field setting-row'); line.append(element('label', '', label), control); return line; }
  weightControl(value, apply, { min, title = 'Weight' } = {}) {
    const box = element('div', 'detail-weight-control');
    const field = input(value, apply, { type: 'number', step: .05, min, title });
    const nudge = delta => {
      const current = field.value === '' ? 1 : Number(field.value);
      if (!Number.isFinite(current)) return;
      const next = Number((Math.max(min ?? -Infinity, current + delta)).toFixed(12));
      field.value = String(next); return apply(next);
    };
    const minus = button('−', `${title} −0.05`, () => nudge(-.05), 'tiny-button');
    const plus = button('+', `${title} +0.05`, () => nudge(.05), 'tiny-button');
    minus.setAttribute('aria-label', `${title} 减少 0.05`); plus.setAttribute('aria-label', `${title} 增加 0.05`);
    box.append(minus, field, plus); return box;
  }
  weight(item) {
    if (item.settings?.weight != null) return item.settings.weight;
    const match = /<lora:[^>]*:([-+\d.eE]+)>/.exec(item.source); return match ? Number(match[1]) : 1;
  }
  interval(container, range, change) {
    const current = range || [0, 1];
    const line = dualSlider(current, next => {
      return Promise.resolve().then(async () => {
        if (change.length < 2) return change(next);
        // When handles cross, expand the old interval before moving its other
        // boundary. Each command also moves the adjoining schedule entry.
        const order = next[0] > current[1] ? [1, 0] : [0, 1];
        for (const side of order) if (next[side] !== current[side]) await change(next[side], side ? 'end' : 'start');
      }).catch(report);
    }, { color: 'var(--time)', step: settings().scheduleStep });
    line.classList.add('plv4-interval');
    const handles = line.querySelectorAll('input[type=range]');
    handles[0].setAttribute('aria-label', 'Schedule start'); handles[1].setAttribute('aria-label', 'Schedule end');
    line.lastElementChild.style.fontSize = '13px';
    container.append(line);
  }
  schedule(page, row) { const section = this.section('Schedule boundary'); this.interval(section, row.settings.schedule, (value, side) => this.command('SetScheduleBoundary', row, { side, value })); page.append(section); }
  regionEntry(container, owner, entry, session, index) {
    const value = entry.settings?.region || { kind: 'base' };
    const name = entry.meta?.name || entry.ast?.header || `Region ${index + 1}`;
    const key = `region-entry:${entry.id}`, {box, head, body} = this.treeBranch(session, owner, 'block', key, name, 0);
    const stateKey = `${owner.id}:${owner.meta?.pool || ''}:${key}`;
    box.open = this.poolViews.get(session).get(stateKey) ?? true;
    box.classList.add('detail-region-entry'); box.dataset.regionEntryId = entry.id;
    head.title = `${name} · ${value.kind}`;
    const active = owner.enabled !== false && owner.effective !== false;
    const toggle = check(entry.enabled, enabled => this.command('SetEnabled', entry, { enabled }));
    toggle.disabled = !active; toggle.setAttribute('aria-label', `启用 / 关闭 ${name}`);
    const remove = button('×', `删除 ${name}`, () => this.command('Delete', entry), 'tiny-button'); remove.disabled = !active;
    head.append(toggle, this.treeIcon('block'), button(name, `打开 ${name} 的内容与详情`, () => this.host.locate(entry.id), 'pool-branch-name detail-region-name'),
      element('small', 'pool-type', value.kind), remove);
    if (!entry.enabled || !active) head.classList.add('detail-content-disabled');
    this.regionFields(body, value, region => this.command('SetRegion', entry, { region }));
    if (!active) body.querySelectorAll('input,button,select').forEach(control => { control.disabled = true; });
    container.append(box);
  }
  region(page, row, entry) {
    const section = this.section('Region');
    const value = row.settings?.region || { kind: 'base' };
    const apply = region => entry ? this.command('SetRegion', row, { region }) : this.setting(row, 'region', region);
    this.regionFields(section, value, apply, !entry, !row.settings?.region && !entry);
    page.append(section);
  }
  regionFields(section, value, apply, allowNone = false, none = false) {
    const select = element('select');
    for (const kind of [...(allowNone ? ['none'] : []), 'base', 'mask', 'imask', 'fill']) { const option = element('option', '', kind); option.value = kind; select.append(option); }
    select.value = none ? 'none' : value.kind;
    select.onchange = () => this.host.run(() => apply(select.value === 'none' ? null : { kind: select.value, ...(select.value === 'mask' ? { mask: [0, 0, 1, 1] } : select.value === 'imask' ? { imask: 0 } : {}) }));
    section.append(this.field('Kind', select));
    if (select.value === 'none') return;
    if (value.kind === 'imask') section.append(this.field('IMASK', input(value.imask ?? 0, imask => apply({ ...value, imask }), { type: 'number', min: 0, step: 1 })));
    if (value.kind === 'mask') section.append(this.field('Rectangle', input(value.mask?.join(', ') || '', text => apply({ ...value, mask: text.split(',').map(Number) }))));
    const keys = [...(['mask','imask'].includes(value.kind) ? ['feather'] : []), ...(value.kind !== 'fill' ? ['mask_weight'] : []), 'cond_weight'];
    for (const key of keys) {
      const change = number => apply({ ...value, [key]: number });
      section.append(this.field(key, key === 'feather' ? input(value[key] ?? 0, change, { type: 'number', step: 1 }) : this.weightControl(value[key] ?? 1, change, { title: key })));
    }
    if (value.kind !== 'base') section.append(this.field('Include base', check(!!value.include_in_base, included => apply({ ...value, include_in_base: included }))));
  }
}
