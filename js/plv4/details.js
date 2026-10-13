import { element, button, input, check, report } from './ui.js';
import { dualSlider, fmt } from '../plv3/theme.js';
import { settings } from '../plv3/settings.js';
import { libraryRequest } from './asset_client.js';
import { inlinePrompt, cleanPromptInput } from './prompt_text.js';
import { attachPromptAutocomplete, attachPromptPreview } from '../tagac_host.js';
import { DetailsPreferences } from './details_preferences.js';
import { assetIcon } from './asset_icons.js';
import { compactFolders, compareNames } from './folder_tree.js';
import { regionMasks } from './mask_region.js';

export const isBlock = row => row.kind === 'group' && row.form !== 'paren' && !inlinePrompt(row);
export function indexTree(tree) { const map = new Map(); const visit = n => { if (!n) return; map.set(n.id, n); n.children.forEach(visit); }; visit(tree); return map; }
export const nameOf = row => row.meta?.name || row.ast?.header || ({ schedule: 'Schedule', region: 'Region', avg: 'AVG', avg_entry: 'AVG entry', schedule_entry: 'Schedule', region_entry: 'Region' }[row.form]) || '';
const textOf = node => node.source ?? (node.kind !== 'group' || node.opaque ? node.raw || '' : (node.open || '') + (node.lead || '') + (node.children || []).map(child => textOf(child) + (child.sep || '')).join('') + (node.close || ''));
const peerCandidate = (owner, candidate) => !!owner.meta?.pool && candidate.kind === 'block' && candidate.snapshot?.meta?.pool === owner.meta.pool && !candidate.snapshot?.meta?.lora;

export function promptKey(node) {
  while (node.kind === 'group' && node.children?.length === 1 && (node.form === 'paren' || node.meta?.presentation === 'prompt') && !node.settings?.region) node = node.children[0];
  const text = textOf(node).trim();
  if (node.kind === 'lora') return text.replace(/:([-+\d.eE]+)>$/, '>');
  return text.replace(/_/g, ' ').replace(/\s+/g, ' ');
}

export class DetailsPane {
  constructor(container, host) {
    this.container = container; this.host = host; this.sections = {}; this.promptStates = new WeakMap(); this.poolViews = new WeakMap(); this.scrollStates = new WeakMap(); this.poolFilters = new WeakMap(); this.poolPending = new WeakMap(); this.commandsPending = new WeakMap();
    this.preferences = new DetailsPreferences(host);
    container.addEventListener('pointerdown', event => this.retainClickTarget(event), true);
  }
  retainClickTarget(event) {
    if (event.button !== 0) return;
    this.releasePointer?.();
    const gesture = this.pointerGesture = { id: event.pointerId };
    const release = event => {
      if (event && event.pointerId !== gesture.id) return;
      document.removeEventListener('pointerup', release, true);
      document.removeEventListener('pointercancel', release, true);
      // Native mouseup/click must finish before a blur or completed command
      // replaces the pressed control. Draft change/blur still happen normally.
      setTimeout(() => {
        if (this.pointerGesture !== gesture) return;
        this.pointerGesture = null; this.releasePointer = null;
        const mount = this.pendingMount; this.pendingMount = null; mount?.();
      }, 0);
    };
    this.releasePointer = release;
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
  }
  rememberScroll() {
    if (!this.mountedSession) return;
    let states = this.scrollStates.get(this.mountedSession); if (!states) { states = new Map(); this.scrollStates.set(this.mountedSession, states); }
    states.set(this.mountedOwner, { outer: this.container.scrollTop || 0, inner: this.container.querySelector('.plv4-details')?.scrollTop || 0 });
  }
  render(session, { keepOwner = false } = {}) {
    for(const controller of this.maskControllers||[])controller.abort();this.maskControllers?.clear();
    if (session && this.commandsPending.get(session)) return;
    this.rememberScroll();
    const token = this.token = (this.token || 0) + 1;
    if (!session) { this.mountGuard?.field.removeEventListener('blur', this.mountGuard.listener); this.mountGuard = null; this.container.replaceChildren(); this.mountedSession = null; this.ownerId = null; return; }
    if (this.host.context?.generalSettings && this.host.context.session === session) { this.renderGeneral(session); return; }
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
      if (row.meta?.lora) {
        const section = this.section('LoRA');
        const match = row.children[0]?.source?.trim().match(/^<lora:[^:<>]+:([-+\d.eE]+)(?::([-+\d.eE]+))?>$/);
        const model = Number(match?.[1] ?? 1), clip = Number(match?.[2] ?? match?.[1] ?? 1);
        section.append(element('div', 'pool-help', row.meta.lora.relative),
          this.field('Model strength', this.weightControl(model, value => this.command('SetLoraStrength', row, { model: value }), { title: 'Model strength' })),
          this.field('CLIP strength', this.weightControl(clip, value => this.command('SetLoraStrength', row, { clip: value }), { title: 'CLIP strength' })),
          this.folderBinding(row, true),
          button('打开 LoRA 详情', '浏览此 LoRA 的预览图和触发词 Class', () => this.host.openLoraDetails(row.meta.lora.id), 'detail-open-lora'));
        page.append(section);
      }
      const common = this.section('GENERAL');
      common.append(this.field('Enable', check(row.enabled, enabled => this.command('SetEnabled', row, { enabled }))),
        row.form === 'avg_entry'
          ? this.field('AVG weight', this.weightControl(row.settings?.avg_weight ?? 1, value => this.command('SetAvgWeight', row, { value }), { min: 0, title: '相对混合权重；各 entry 按比例归一化，0 不参与' }))
          : this.field('Weight', this.weightControl(row.settings?.weight ?? 1, value => this.setting(row, 'weight', value), { min: 0 })));
      page.append(common);
      if (!['schedule', 'region', 'avg', 'avg_entry'].includes(row.form)) {
        const field = this.field('Format', input(row.settings?.format || '', value => this.setting(row, 'format', value || null), { title: '对直接子项套用格式，subblock 作为整体；$p 为该项内容' }));
        field.querySelector('input').classList.add('format-input');
        common.append(this.field('Shuffle', check(!!row.settings?.shuffle, value => this.setting(row, 'shuffle', value))), field);
        const random = this.section('RANDOM');
        random.append(this.randomSelect(row), this.dropout(row)); page.append(random);
      }
      if (!['schedule', 'region', 'avg'].includes(row.form)) {
        const timing = this.section('TIMING & REGION');
        if (row.form === 'schedule_entry') this.interval(timing, row.settings.schedule, (value, side) => this.command('SetScheduleBoundary', row, { side, value }));
        else {
          timing.append(this.field('Schedule', check(!!row.settings?.schedule, enabled => this.setting(row, 'schedule', enabled ? [0, 1] : null))));
          if (row.settings?.schedule) this.interval(timing, row.settings.schedule, interval => this.setting(row, 'schedule', interval));
        }
        if (row.form !== 'region_entry') timing.append(this.field('Region', check(!!row.settings?.region, enabled => this.setting(row, 'region', enabled ? { kind: 'base' } : null))));
        if (row.settings?.region || row.form === 'region_entry') {
          const region = element('div'); this.region(region, row, row.form === 'region_entry');
          timing.append(...region.querySelectorAll('.plv4-field,.mask-coordinates,.mask-region-control'));
        }
        page.append(timing);
      }
      if (!row.meta?.lora && !['schedule', 'region', 'avg'].includes(row.form)) {
        const pool = this.section('池绑定');
        pool.append(this.folderBinding(row)); page.append(pool);
      }
      if (row.meta?.source?.kind === 'block' && !['schedule_entry', 'region_entry', 'avg_entry'].includes(row.form)) {
        const status = element('div', 'plv4-row');
        status.append(button('覆盖回库', '显式覆盖来源 block', () => this.host.saveBlock(row))); page.append(status);
        this.sourceStatus(row, status, token).catch(error => { if (token === this.token) status.append(element('span', 'plv4-badge', error.message)); });
      }
    }
    if (row.form === 'region') this.regionTiming(page, row);
    if (['schedule', 'region', 'avg'].includes(row.form)) {
      const entries = this.section({ schedule: 'Schedule entries', region: 'Region entries', avg: 'AVG entries' }[row.form]);
      if (row.form === 'region') {
        const enabled = row.meta?.region_enabled !== false;
        const toggle = check(enabled, async value => {
          await this.command('SetRegionEnabled', row, { enabled: value });
          await new Promise(requestAnimationFrame);
          if (this.session === session && this.ownerId === row.id && this.host.context?.session === session &&
              (document.activeElement === document.body || document.activeElement === toggle)) {
            this.container.querySelector('input[data-field="region-enabled"]')?.focus({ preventScroll: true });
          }
        }, 'Enable region splitting for this container');
        toggle.setAttribute('aria-label', 'Enable Region functionality'); toggle.dataset.field = 'region-enabled';
        entries.append(this.field('Region', toggle));
        if (!enabled) entries.append(element('p', 'setting-help', 'Region is off. Enabled entries merge into the prompt.'));
      }
      const regionTree = row.form === 'region' ? element('div', 'detail-contents-tree detail-region-tree') : null;
      if (regionTree) entries.append(regionTree);
      for (const [index, entry] of row.children.entries()) {
        if (regionTree) { this.regionEntry(regionTree, row, entry, session, index); continue; }
        const line = element('div', 'plv4-row');
        line.append(check(entry.enabled, value => this.command('SetEnabled', entry, { enabled: value })), button(nameOf(entry), nameOf(entry), () => this.host.locate(entry.id)), button('×', '删除 entry', () => this.command('Delete', entry)));
        entries.append(line);
        if (row.form === 'schedule') this.interval(entries, entry.settings.schedule, (value, side) => this.command('SetScheduleBoundary', entry, { side, value }));
        if (row.form === 'avg') entries.append(this.field('Weight', this.weightControl(entry.settings?.avg_weight ?? 1, value => this.command('SetAvgWeight', entry, { value }), { min: 0, title: '相对混合权重' })));
      }
      entries.append(button('+', '添加 entry', () => this.host.addBlock(row.id, true))); page.append(entries);
    }
    const prompts = this.section('Content');
    prompts.classList.add('detail-content-section');
    const contentTree = element('div', 'detail-contents-tree'); contentTree.dataset.depth = 0; prompts.append(contentTree);
    this.localContents(row.children.filter(child => !child.meta?.lora_invocation), contentTree, session, row);
    const folder = row.meta?.pool && this.host.library?.data?.assets?.find(asset => asset.id === row.meta.pool);
    let pending = null;
    if (!['schedule', 'region', 'avg'].includes(row.form)) prompts.append(button('＋ 添加 prompt', '添加 prompt', () => this.host.addPrompt(row), 'small-add'));
    page.append(prompts);
    if (row.meta?.pool && !['schedule', 'region', 'avg'].includes(row.form)) {
      const poolSection = this.section('Pool'), poolTree = element('div', 'plv4-candidates pool-tree');
      poolSection.classList.add('detail-pool-section');
      poolSection.append(poolTree); page.append(poolSection);
      if (folder) pending = this.candidates(session, row, row.meta.pool, poolTree, token).catch(error => {
        if (token === this.token) poolTree.replaceChildren(element('p', 'pool-help', `池读取失败：${error.message}`));
      });
      else poolTree.append(element('p', 'pool-help', 'Class 已删除 / 不在本机。当前内容仍可在 Content 编辑。'));
    }
    const poolSectionKey = `${row.id}:${row.meta?.pool || ''}:section`, sectionKey = `${row.id}:Pool`;
    const views = this.preferences.map(session, 'views');
    if (views.has(poolSectionKey)) this.sections[sectionKey] = views.get(poolSectionKey);
    else delete this.sections[sectionKey];
    XYZPLv4Design.foldSections(page, { id: row.id, type: ['schedule', 'region', 'avg'].includes(row.form) ? row.form : 'normal', schedule: row.settings?.schedule, region: row.settings?.region }, this.sections);
    const poolDetails = page.querySelector('.pool-tree')?.closest('details.section');
    poolDetails?.addEventListener('toggle', () => { views.set(poolSectionKey, poolDetails.open); this.preferences.save(session); });
    const mount = () => {
      if (token !== this.token) return;
      if (this.pointerGesture) { this.pendingMount = mount; return; }
      const focused = document.activeElement;
      const regionKind = this.container.contains(focused) && focused?.matches('select[data-region-kind]') ? focused.dataset.regionKind : null;
      if (focused && this.mountedSession === session && this.mountedOwner === row.id && this.container.contains(focused) && focused.matches('input:not([type="checkbox"]):not([type="radio"]),textarea,select:not([data-region-kind]),[contenteditable="true"],[contenteditable="plaintext-only"]')) {
        // Pool reads may finish after the user starts a new draft. Replacing
        // that field would discard its focus, caret and uncommitted value.
        this.mountGuard?.field.removeEventListener('blur', this.mountGuard.listener);
        const listener = () => queueMicrotask(mount);
        this.mountGuard = { field: focused, listener };
        focused.addEventListener('blur', listener, { once: true });
        return;
      }
      if (this.mountGuard) { this.mountGuard.field.removeEventListener('blur', this.mountGuard.listener); this.mountGuard = null; }
      // The old tree stays mounted while pool data loads, so its scroll extent
      // never collapses to an empty placeholder between toggle and redraw.
      this.rememberScroll();
      const scroll = this.scrollStates.get(session)?.get(row.id) || { outer: 0, inner: 0 };
      this.container.replaceChildren(page); page.scrollTop = scroll.inner; this.container.scrollTop = scroll.outer;
      this.mountedSession = session; this.mountedOwner = row.id;
      // Kind changes are already committed; show their controls immediately and
      // retain keyboard focus without waiting for the select to lose focus.
      if (regionKind !== null) [...page.querySelectorAll('select[data-region-kind]')].find(select => select.dataset.regionKind === regionKind)?.focus({ preventScroll: true });
    };
    if (pending) {
      if (this.mountedSession !== session || this.mountedOwner !== row.id) {
        this.container.replaceChildren(element('div', 'plv4-empty', '正在读取池内容…')); this.mountedSession = null;
      }
      this.pendingRender = pending.then(mount);
    } else { mount(); this.pendingRender = Promise.resolve(); }
  }
  renderGeneral(session) {
    this.pendingMount = null;
    this.mountGuard?.field.removeEventListener('blur', this.mountGuard.listener); this.mountGuard = null;
    this.session = session; this.ownerId = null;
    const control = this.host.regionModeControl; control.update();
    if (this.mountedSession === session && this.mountedOwner === '@general' && this.container.contains(this.generalPage)) return;
    const page = element('div', 'plv4-scroll plv4-details plv4-general-page');
    const top = element('div', 'inspector-head');
    top.append(element('span', 'detail-name', 'General Settings'), button('×', '关闭 Settings', () => this.host.toggleDetails(false), 'tiny-button')); page.append(top);
    const section = this.section('Region');
    section.append(this.field('Region algorithm', control.element)); page.append(section);
    this.container.replaceChildren(page);
    const scroll = this.scrollStates.get(session)?.get('@general');
    page.scrollTop = scroll?.inner || 0; this.container.scrollTop = scroll?.outer || 0;
    this.generalPage = page; this.mountedSession = session; this.mountedOwner = '@general';
    this.pendingRender = Promise.resolve();
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
    const remove = button('×', '删除 prompt', async () => {
      const expanded = !panel.hidden;
      remove.disabled = true; line.hidden = true; panel.hidden = true;
      try { return await this.command('Delete', item); }
      catch (error) { line.hidden = false; panel.hidden = !expanded; remove.disabled = !active; throw error; }
    }, 'tiny-button'); remove.dataset.deletePrompt = id; remove.hidden = !local; remove.disabled = !active;
    const toggle = check(!!local?.enabled, value => {
      line.classList.toggle('detail-content-disabled', !value || !active);
      return onToggle(value);
    }); toggle.disabled = !active;
    toggle.setAttribute('aria-label', `启用 / 关闭 prompt：${textOf(textItem)}`);
    line.append(toggle, text, this.promptPreview(item), fold, remove);
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
  command(type, row, extra = {}) { return this.applyCommand({ type, id: row.id, ...extra }); }
  async applyCommand(command, session = this.session) {
    const selectionEpoch = session.selectionEpoch;
    this.commandsPending.set(session, (this.commandsPending.get(session) || 0) + 1);
    this.token = (this.token || 0) + 1;
    try { return await this.host.command(command); }
    finally {
      const count = this.commandsPending.get(session) - 1;
      if (count) this.commandsPending.set(session, count); else this.commandsPending.delete(session);
      if (!count && this.host.context?.session === session && !this.host.shell?.details.hidden) this.render(session, { keepOwner: session.selectionEpoch === selectionEpoch });
    }
  }
  randomSelect(row) {
    const value = row.settings?.random_select;
    const bounds = Array.isArray(value) ? value : Number.isInteger(value) ? [value, value] : ['', ''];
    const control = element('div', 'detail-random-range');
    const fields = bounds.map((value, index) => {
      const field = input(value, () => apply(), { type: 'number', min: 0, step: 1, title: index ? '上限 b：整数，b ≥ a；两个框留空关闭' : '下限 a：整数，0 ≤ a ≤ b；两个框留空关闭' });
      field.min = '0'; field.step = '1'; field.placeholder = index ? 'b' : 'a';
      field.setAttribute('aria-label', index ? 'Random select 最大数量 b' : 'Random select 最小数量 a');
      field.oninput = () => fields.forEach(input => input.setCustomValidity?.(''));
      return field;
    });
    const apply = () => {
      fields.forEach(field => field.setCustomValidity?.(''));
      if (fields.some(field => field.validity?.badInput)) return;
      if (fields.every(field => field.value === '')) return this.setting(row, 'random_select', null);
      if (fields.some(field => field.value === '')) return;
      const [a, b] = fields.map(field => Number(field.value));
      if (![a, b].every(value => Number.isSafeInteger(value) && value >= 0) || a > b) {
        const field = fields.find(field => !Number.isSafeInteger(Number(field.value)) || Number(field.value) < 0) || fields[1];
        field.setCustomValidity?.('需要满足 0 ≤ a ≤ b，且 a、b 都为整数'); field.reportValidity?.(); return;
      }
      return this.setting(row, 'random_select', [a, b]);
    };
    control.append(fields[0], element('span', '', '–'), fields[1]);
    return this.field('Random select', control);
  }
  dropout(row) {
    const control = element('div', 'detail-dropout-control');
    const slider = input(row.settings?.dropout ?? 0, value => this.setting(row, 'dropout', value), { type: 'range', min: 0, max: 1, step: .05, title: 'Dropout' });
    slider.setAttribute('aria-label', 'Dropout 概率');
    const value = element('span', 'detail-dropout-value', Number(slider.value).toFixed(2));
    slider.oninput = () => { value.textContent = Number(slider.value).toFixed(2); };
    control.append(slider, value);
    return this.field('Dropout', control);
  }
  folderBinding(row, fixed = false) {
    const poolId = row.meta?.pool;
    const folder = this.host.library.data?.assets?.find(asset => asset.kind === 'class' && asset.id === poolId);
    const name = folder ? folder.name : poolId ? 'Class 已删除 / 不在本机' : '未绑定';
    const controls = element('div', 'detail-folder-control'); controls.dataset.folderBinding = fixed ? 'fixed' : 'editable';
    const label = fixed ? element('span', 'detail-folder-name', name)
      : button(`${name} ▾`, folder ? this.host.library.path(folder) : '绑定 Class 池', () => this.host.libraryAction('pool', row), 'pool-setting');
    label.title = folder ? this.host.library.path(folder) : name;
    controls.append(label);
    if (poolId) {
      const open = button('↗', '打开绑定的 Class 设置', () => this.host.openClass(poolId), 'detail-open-folder');
      open.setAttribute('aria-label', `打开 ${name} 的 Class 设置`); open.disabled = !folder;
      controls.append(open);
    }
    return this.field('Class', controls);
  }
  async sourceStatus(row, container, token) {
    const source = row.meta.source; const expected = { ...source.dependencies, [source.id]: source.version };
    const latest = await libraryRequest('versions', { ids: Object.keys(expected) }); if (token !== this.token) return;
    if (!(source.id in latest.versions)) { container.append(element('span', 'plv4-badge', '来源已删除 · 本地快照保留')); return; }
    container.append(button('从库更新', '用最新来源更新此副本', () => this.host.updateSource(row)));
    if (Object.entries(expected).some(([id, version]) => latest.versions[id] !== version)) container.append(element('span', 'plv4-badge', '来源有更新'));
  }
  treeIcon(kind) { return assetIcon(kind, 'pool-kind-icon', 15); }
  promptPreview(node) {
    const slot = element('span', 'detail-tag-preview');
    // Only a single literal prompt may resolve to a Danbooru tag. Unwrap
    // attention/Settings shells, retaining literal escaped tag parentheses.
    while (node.kind === 'group' && node.children?.length === 1 && (node.form === 'paren' || node.meta?.presentation === 'prompt')) node = node.children[0];
    if (node.kind === 'text') attachPromptPreview(slot, textOf(node).trim()).catch(report);
    return slot;
  }
  treeBranch(session, owner, kind, key, name, depth) {
    const views = this.preferences.map(session, 'views'); this.poolViews.set(session, views);
    const box = element('details', `pool-branch detail-tree-branch pool-${kind}`); box.dataset.depth = depth;
    const prefix = `${owner.id}:${owner.meta?.pool || ''}:`, stateKey = prefix + key;
    box.open = views.get(stateKey) ?? (String(key).startsWith('local:') ? undefined : views.get(prefix + 'default')) ?? (kind === 'class' && depth === 0);
    box.ontoggle = () => { views.set(stateKey, box.open); this.preferences.save(session); };
    const head = element('summary', `pool-branch-head pool-${kind}-head`), body = element('div', 'pool-branch-body'); body.dataset.depth = depth + 1;
    head.title = `第 ${depth + 1} 层 · ${kind === 'class' ? 'Class' : 'block'} · ${name}`;
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
    for (const item of children.filter(child => !child.meta?.lora_invocation)) {
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
      const matched = matches.find(match => match.active) || matches[0];
      if (matched) return matched;
      if (peerCandidate(owner, candidate)) {
        let first = null;
        for (const child of candidate.snapshot.children || []) {
          const occurrence = JSON.stringify([...(candidate.occurrence || []), child.id]);
          const found = isBlock(child)
            ? blocks.find(({node}) => JSON.stringify(node.meta?.occurrence) === occurrence || (child.meta?.source?.id && node.meta?.source?.id === child.meta.source.id))
            : prompts.find(({node}) => promptKey(node) === promptKey(child));
          if (!found) return null;
          first ||= found;
        }
        return first || { node: owner, active: owner.effective !== false };
      }
      return null;
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
      if (['schedule', 'region', 'avg'].includes(current.form)) return;
      const entry = await this.host.entryTarget(current, target); if (entry === false || this.host.context?.session !== session) return;
      return this.applyCommand({ type: peerCandidate(current, candidate) ? 'MergeLibraryBlock' : 'EnableCandidate', ...target, snapshot: candidate.snapshot, source: candidate.source, occurrence: candidate.occurrence, ...(entry ? { entry } : {}) }, session);
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
        line.append(this.treeIcon('tag'), element('span', 'pool-prompt-text', textOf(node).trim()), this.promptPreview(node)); container.append(line);
        if (node.enabled === false) line.classList.add('pool-preview-off');
      }
    }
  }
  async candidates(session, owner, pool, container, token) {
    const exclude = this.host.context?.asset?.id || owner.meta?.source?.id;
    const revision = this.host.library?.data?.revision;
    if (this.poolCacheRevision !== revision) { this.poolCache = new Map(); this.poolCacheRevision = revision; }
    this.poolCache ??= new Map();
    const key = JSON.stringify([pool, exclude || null]);
    let read = this.poolCache.get(key);
    if (!read) {
      read = libraryRequest('candidates', { pool, exclude_block: exclude });
      this.poolCache.set(key, read);
      read.catch(() => { if (this.poolCache.get(key) === read) this.poolCache.delete(key); });
    }
    const data = await read; if (token !== this.token || this.host.context?.session !== session) return;
    const filters = this.preferences.map(session, 'filters'); this.poolFilters.set(session, filters);
    const filterKey = `${owner.id}:${pool}`;
    if (!filters.has(filterKey)) filters.set(filterKey, { kind: 'all', usage: 'all' });
    const filter = filters.get(filterKey), controls = element('div', 'pool-controls'), tree = element('div', 'detail-contents-tree pool-candidate-tree');
    if (!['all', 'tag', 'block'].includes(filter.kind)) filter.kind = 'all';
    if (!['all', 'unused'].includes(filter.usage)) filter.usage = 'all';
    const legend = element('div', 'pool-legend'); legend.setAttribute('aria-label', 'Pool 条目类型');
    for (const [kind, label] of [['class','Class'],['block','Block'],['tag','Prompt']]) {
      const item = element('span', 'pool-legend-item'); item.dataset.kind = kind;
      item.append(this.treeIcon(kind), element('span', '', label)); legend.append(item);
    }
    controls.append(legend);
    const select = (key, title, options) => {
      const label = element('label', 'pool-filter-row', title), field = element('select', `pool-filter-${key}`);
      for (const [value, text] of options) { const option = element('option', '', text); option.value = value; field.append(option); }
      field.value = filter[key]; field.setAttribute('aria-label', title);
      field.onchange = () => { filter[key] = field.value; this.preferences.save(session); paint(); };
      label.append(field); controls.append(label);
    };
    select('kind', '类型', [['all','全部'],['tag','Prompt'],['block','Block']]);
    select('usage', '加入状态', [['all','全部'],['unused','未加入']]);
    const folding = element('div', 'pool-fold-controls');
    for (const [open, title] of [[true,'全部展开'],[false,'全部折叠']]) folding.append(button(title, title, () => {
      const views = this.preferences.map(session, 'views'), prefix = `${owner.id}:${owner.meta?.pool || ''}:`;
      for (const key of views.keys()) if (key.startsWith(prefix) && key !== prefix + 'section' && !key.startsWith(prefix + 'local:')) views.delete(key);
      views.set(prefix + 'default', open); this.preferences.save(session);
      for (const branch of tree.querySelectorAll('details')) { branch.open = open; branch.ontoggle?.(); }
    }, 'pool-fold-all'));
    controls.append(folding); container.append(controls, tree);
    const shortName = (candidate, parentPath) => this.host.library?.data?.assets?.find(a => a.id === candidate.id)?.name || (parentPath && candidate.name.startsWith(parentPath + '.') ? candidate.name.slice(parentPath.length + 1) : candidate.name);
    const paint = () => {
      const current = session.projection?.tree ? indexTree(session.projection.tree).get(owner.id) || owner : owner;
      const match = this.poolMatches(current), active = current.enabled !== false && current.effective !== false;
      const filtered = filter.kind !== 'all' || filter.usage !== 'all';
      const choose = nodes => nodes.flatMap(candidate => {
        if (candidate.kind === 'class') {
          const children = choose(candidate.children);
          // Filtering must not turn a real branch or a nonempty Class into a compact chain.
          const compactChild = candidate.children.length === 1 && candidate.children[0].kind === 'class' ? candidate.children[0].id : null;
          return children.length || !filtered ? [{...candidate, children, compactChild}] : [];
        }
        return (filter.kind === 'all' || candidate.kind === filter.kind) && (filter.usage === 'all' || !match(candidate)) ? [candidate] : [];
      });
      const decorate = (line, candidate, selected, name) => {
        line.dataset.candidateKind = candidate.kind; line.dataset.poolCandidate = candidate.source?.id || candidate.id || '';
        line.dataset.poolState = selected ? 'joined' : 'unused';
        if (selected) line.classList.add('pool-joined');
        const add = button('＋', selected ? '已加入：提示当前位置，不重复添加' : peerCandidate(current, candidate) ? `添加 ${name} 的内容` : `添加 ${name} 到 Content 末尾`, () => this.addPoolCandidate(session, current, candidate), 'pool-add');
        add.dataset.action = 'add-pool-candidate'; add.disabled = !active || ['schedule', 'region', 'avg'].includes(current.form); add.setAttribute('aria-label', `添加 ${name}`);
        line.append(add);
      };
      const status = (line, selected) => line.append(element('small', 'pool-usage', selected ? '已添加' : '未添加'));
      const order = { class: 0, block: 1, tag: 2 };
      const walk = (nodes, parent, depth = 0, parentPath = '', actualDepth = depth) => [...nodes].sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3) || compareNames({ name: shortName(a, parentPath) }, { name: shortName(b, parentPath) })).forEach(candidate => {
        const name = shortName(candidate, parentPath);
        if (candidate.kind === 'class') {
          const chain = compactFolders(candidate, folder => folder.children, (folder, child) => folder.compactChild === child.id);
          const terminal = chain.at(-1);
          let previousPath = parentPath;
          const label = chain.map(folder => { const local = shortName(folder, previousPath); previousPath = folder.name; return local; }).join(' / ');
          const key = filtered ? `${candidate.id}:filter:${filter.kind}:${filter.usage}` : candidate.id;
          const {box, head, body} = this.treeBranch(session, owner, 'class', key, label, depth);
          box.dataset.folderChain = JSON.stringify(chain.map(folder => folder.id)); box.dataset.actualDepth = actualDepth;
          if (filtered) {
            const states = this.poolViews.get(session), stateKey = `${owner.id}:${owner.meta?.pool || ''}:${key}`;
            box.open = states.get(stateKey) ?? states.get(`${owner.id}:${owner.meta?.pool || ''}:default`) ?? true;
          }
          head.title = `第 ${actualDepth + 1}${chain.length > 1 ? `–${actualDepth + chain.length}` : ''} 层 · Class · ${terminal.name}`;
          head.append(this.treeIcon('class'), element('span', 'pool-branch-name', label));
          if (terminal.id !== pool) {
            const insert = button('＋子 block', '作为 sub block 插入：本层全部散装 tag，默认启用', async () => {
              const source = await libraryRequest('class_block', { id: terminal.id, fill: true });
              const target = { parent_id: current.id, edge: 'end' };
              const entry = await this.host.entryTarget(current, target); if (entry === false) return;
              return this.host.command({ type: 'InsertLibraryBlock', ...target, snapshot: source.snapshot, source: source.source, ...(entry ? { entry } : {}) });
            }, 'pool-insert');
            insert.disabled = !active || ['schedule', 'region', 'avg'].includes(current.form); insert.dataset.action = 'insert-folder-block'; head.append(insert);
          }
          parent.append(box); walk(terminal.children, body, depth + 1, terminal.name, actualDepth + chain.length);
          if (!terminal.children.length) body.append(element('span', 'pool-empty', '空Class')); return;
        }
        const selected = match(candidate);
        if (candidate.kind === 'tag') {
          const line = element('div', 'detail-prompt-row pool-candidate-prompt'); line.dataset.tagText = textOf(candidate.snapshot).trim();
          decorate(line, candidate, selected, name);
          line.append(this.treeIcon('tag'), element('span', 'pool-prompt-text', textOf(candidate.snapshot).trim()), this.promptPreview(candidate.snapshot)); status(line, selected); parent.append(line); return;
        }
        const key = JSON.stringify(candidate.occurrence), branch = this.treeBranch(session, owner, 'block', key, name, depth);
        branch.head.title = candidate.source?.path || candidate.name;
        decorate(branch.head, candidate, selected, name);
        branch.head.append(this.treeIcon('block'), element('span', 'pool-branch-name', name), element('small', 'pool-type', 'block')); status(branch.head, selected);
        parent.append(branch.box);
        let previewed = false;
        const preview = () => { if (!previewed && branch.box.open) { previewed = true; this.previewContents(candidate.snapshot.children, branch.body, session, owner, depth + 1, key); } };
        const toggle = branch.box.ontoggle;
        branch.box.ontoggle = event => { toggle?.(event); preview(); };
        preview();
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
  // A Region container's two windows on one rail. The handles have no identity:
  // after every drag the four positions are sorted, the outer two are `schedule`
  // (outside: the container is gone) and the inner two `region_window` (between
  // inner and outer: entries merge into ordinary prompt text).
  regionTiming(page, row) {
    const section = this.section('Timing');
    const outer = row.settings?.schedule || [0, 1], inner = row.settings?.region_window || outer;
    const rail = element('div', 'plv4-quad');
    const plain = element('div', 'plv4-quad-plain'), split = element('div', 'plv4-quad-split');
    rail.append(element('div', 'plv4-quad-track'), plain, split);
    const step = String(settings().scheduleStep);
    const handles = [outer[0], inner[0], inner[1], outer[1]].map((value, index) => {
      const handle = element('input'); Object.assign(handle, { type: 'range', min: '0', max: '1', step, value: String(value) });
      handle.setAttribute('aria-label', `Region timing handle ${index + 1}`);
      return handle;
    });
    rail.append(...handles);
    const label = element('div', 'plv4-quad-label');
    const sorted = () => handles.map(handle => Number(handle.value)).sort((a, b) => a - b);
    // Native thumb centres travel from half a thumb to width minus half a thumb.
    const place = (bar, a, b) => {
      bar.style.left = `calc(${a * 100}% + ${6.5 - a * 13}px)`;
      bar.style.width = `calc(${(b - a) * 100}% - ${(b - a) * 13}px)`;
    };
    const paint = () => {
      const [a, b, c, d] = sorted();
      place(plain, a, d); place(split, b, c);
      label.textContent = `生效 ${fmt(a)}–${fmt(d)} · 分区 ${fmt(b)}–${fmt(c)}`;
    };
    const commit = () => {
      const [a, b, c, d] = sorted();
      const patch = { schedule: a === 0 && d === 1 ? null : [a, d], region_window: a === b && c === d ? null : [b, c] };
      if (JSON.stringify(patch) === JSON.stringify({ schedule: row.settings?.schedule || null, region_window: row.settings?.region_window || null })) return paint();
      return this.command('SetSettings', row, { patch }).catch(report);
    };
    handles.forEach(handle => { handle.oninput = paint; handle.onchange = commit; });
    paint();
    if (row.meta?.region_enabled === false) {
      rail.classList.add('disabled'); handles.forEach(handle => { handle.disabled = true; });
    }
    section.append(rail, label, element('p', 'setting-help', '外侧两点之外：整个 Region 不生效。外侧与内侧之间：不分区，条目合并成普通提示词。内侧之间：分区。'));
    page.append(section);
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
    this.regionFields(body, value, region => this.command('SetRegion', entry, { region }), false, false, entry);
    if (!active) body.querySelectorAll('input,button,select').forEach(control => { control.disabled = true; });
    container.append(box);
  }
  region(page, row, entry) {
    const section = this.section('Region');
    const value = row.settings?.region || { kind: 'base' };
    const apply = region => entry ? this.command('SetRegion', row, { region }) : this.setting(row, 'region', region);
    this.regionFields(section, value, apply, !entry, !row.settings?.region && !entry, row);
    page.append(section);
  }
  regionFields(section, value, apply, allowNone = false, none = false, row = null) {
    const select = element('select');
    select.dataset.regionKind = row?.id || '';
    for (const kind of [...(allowNone ? ['none'] : []), 'base', 'mask', 'imask', 'fill']) { const option = element('option', '', kind); option.value = kind; select.append(option); }
    select.value = none ? 'none' : value.kind;
    select.onchange = () => this.host.run(() => apply(select.value === 'none' ? null : { ...value, kind: select.value, mask: select.value === 'mask' ? value.mask || [0, 1, 0, 1] : null, imask: select.value === 'imask' ? value.imask ?? 0 : null }));
    section.append(this.field('Kind', select));
    if (select.value === 'none') return;
    if (row) regionMasks(section, row, this.host, value, apply);
    const keys = [...(['mask','imask'].includes(value.kind) ? ['feather'] : []), ...(value.kind !== 'fill' ? ['mask_weight'] : []), 'cond_weight'];
    for (const key of keys) {
      const change = number => apply({ ...value, [key]: number });
      section.append(this.field(key, key === 'feather' ? input(value[key] ?? 0, change, { type: 'number', step: 1 }) : this.weightControl(value[key] ?? 1, change, { title: key })));
    }
    if (value.kind !== 'base') section.append(this.field('Include base', check(!!value.include_in_base, included => apply({ ...value, include_in_base: included }))));
  }
}
