import { element, button } from './ui.js';
import { assetIcon } from './asset_icons.js';
import { compareNames } from './folder_tree.js';

function dialog(title, build, wide = false) {
  return new Promise(resolve => {
    const previous = document.activeElement;
    const overlay = element('div', 'plv4 library-dialog-overlay');
    const box = element('section', `library-dialog${wide ? ' library-move-dialog' : ''}`);
    box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    const heading = element('h2', '', title); heading.id = `library-dialog-${crypto.randomUUID()}`;
    box.setAttribute('aria-labelledby', heading.id); box.append(heading); overlay.append(box);
    let closed = false;
    const finish = value => {
      if (closed) return; closed = true;
      document.removeEventListener('keydown', key, true); overlay.remove();
      previous?.focus?.({ preventScroll: true }); resolve(value);
    };
    const key = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(null); }
      if (event.key === 'Tab') {
        const controls = [...box.querySelectorAll('button,input,[tabindex="0"]')].filter(n => !n.disabled && n.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || !box.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !box.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    };
    const focus = build(box, finish);
    overlay.onpointerdown = event => { if (event.target === overlay) finish(null); };
    document.body.append(overlay); document.addEventListener('keydown', key, true);
    focus?.focus?.({ preventScroll: true });
  });
}

export function showLibraryDelete(asset, path) {
  return dialog(`删除“${asset.name}”？`, (box, finish) => {
    box.append(element('div', 'library-dialog-path', path));
    const scope = ['folder', 'class'].includes(asset.kind) ? '及其中的所有内容' : asset.kind === 'block' ? '及其所有子 Block' : '';
    box.append(element('p', '', `将删除此${{ folder: '文件夹', class: ' Class', block: ' Block', tag: '条 prompt', document: ' Document' }[asset.kind] || '对象'}${scope}。此操作无法撤销。`));
    const actions = element('div', 'library-dialog-actions');
    const cancel = button('取消', '取消', () => finish(null));
    actions.append(cancel, button('删除', '删除', () => finish(true), 'library-dialog-danger')); box.append(actions);
    return cancel;
  }).then(value => value === true);
}

// Keep navigation folders even when only a Class/Block can receive the item.
// Pruning whole branches excludes the source, its descendants and hidden LoRAs.
export function moveTree(asset, assets, options) {
  const permitted = new Set(options.map(option => option.value));
  const byId = new Map(assets.map(item => [item.id, item]));
  const visible = item => {
    const seen = new Set();
    while (item && !seen.has(item.id)) {
      if (item.id === asset.id || item.library_hidden || item.lora_root) return false;
      seen.add(item.id); item = byId.get(item.parent_id);
    }
    return !item;
  };
  const entries = assets.filter(item => ['folder', 'class', 'block'].includes(item.kind) && visible(item));
  const children = parent => entries.filter(item => (item.parent_id || '') === parent)
    .sort((a, b) => (a.kind === 'class' ? 0 : a.kind === 'folder' ? 1 : 2) - (b.kind === 'class' ? 0 : b.kind === 'folder' ? 1 : 2) || compareNames(a, b));
  return { entries, byId, permitted, children };
}

export function showLibraryMove(asset, assets, options) {
  return showLibraryDestination(asset, assets, options);
}

export function showLibraryClass(current, assets) {
  const entries = assets.filter(item => ['folder', 'class'].includes(item.kind));
  const options = [{ value: '' }, ...entries.filter(item => item.kind === 'class' && !item.library_hidden && !item.lora_root).map(item => ({ value: item.id }))];
  return showLibraryDestination({ id: null, parent_id: current }, entries, options, {
    title: '绑定 Class', submitLabel: '绑定', rootLabel: '不绑定', invalidLabel: '请选择 Class',
  }).then(result => result ? { id: result.parent } : null);
}

function showLibraryDestination(asset, assets, options, config = {}) {
  const model = moveTree(asset, assets, options);
  return dialog(config.title || `移动“${asset.name}”`, (box, finish) => {
    let current = model.entries.some(item => item.id === asset.parent_id) ? asset.parent_id : '';
    let selected = current;
    const expanded = new Set(['']);
    const parents = id => {
      const result = []; const seen = new Set();
      while (id && !seen.has(id)) { seen.add(id); const item = model.byId.get(id); if (!item) break; result.unshift(item); id = item.parent_id; }
      return result;
    };
    parents(current).forEach(item => expanded.add(item.id));
    const toolbar = element('div', 'library-move-toolbar');
    const up = button('↑', '上一级', () => navigate(model.byId.get(current)?.parent_id || ''), 'library-move-up');
    const crumbs = element('nav', 'library-move-breadcrumb'); crumbs.setAttribute('aria-label', '当前位置'); toolbar.append(up, crumbs);
    const browser = element('div', 'library-move-browser');
    const tree = element('div', 'library-move-tree'); tree.setAttribute('role', 'tree'); tree.setAttribute('aria-label', '目录树');
    const pane = element('div', 'library-move-pane');
    const header = element('div', 'library-move-columns'); header.append(element('span', '', '名称'), element('span', '', '类型'));
    const list = element('div', 'library-move-list'); list.setAttribute('aria-label', '目录内容'); pane.append(header, list); browser.append(tree, pane);
    const footer = element('div', 'library-move-destination');
    const actions = element('div', 'library-dialog-actions');
    const cancel = button('取消', '取消', () => finish(null));
    const submit = button(config.submitLabel || '移动到这里', config.submitLabel || '移动到这里', () => { if (!submit.disabled) finish({ parent: selected }); }, 'primary');
    if (config.rootLabel && asset.parent_id) actions.append(button('解除绑定', '解除绑定', () => finish({ parent: '' }), 'library-dialog-unbind'));
    actions.append(cancel, submit);
    box.append(toolbar, browser, footer, actions);
    const displayPath = id => ['Library', ...parents(id).map(item => item.name)].join(' / ');
    const updateSelection = () => {
      const allowed = model.permitted.has(selected);
      submit.disabled = !allowed || selected === (asset.parent_id || '');
      footer.textContent = allowed ? `目标：${!selected && config.rootLabel ? config.rootLabel : displayPath(selected)}` : config.invalidLabel || '此位置不能接收该对象';
      if (config.rootLabel) submit.textContent = !selected && asset.parent_id ? '解除绑定' : config.submitLabel;
      for (const row of list.querySelectorAll('[data-destination-id]')) {
        row.classList.toggle('selected', row.dataset.destinationId === selected);
        row.setAttribute('aria-pressed', String(row.dataset.destinationId === selected));
      }
    };
    const renderTree = () => {
      const top = tree.scrollTop; tree.replaceChildren();
      const walk = (item, depth) => {
        const id = item?.id || '', children = model.children(id);
        const row = element('div', 'library-move-tree-row'); row.dataset.destinationId = id;
        row.style.paddingLeft = `${8 + depth * 16}px`; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-level', String(depth + 1)); row.setAttribute('aria-selected', String(current === id));
        if (children.length) {
          row.setAttribute('aria-expanded', String(expanded.has(id)));
          row.append(button(expanded.has(id) ? '▾' : '▸', '展开 / 折叠', () => { expanded.has(id) ? expanded.delete(id) : expanded.add(id); renderTree(); }, 'library-move-fold'));
        } else row.append(element('span', 'library-move-fold'));
        const label = button('', item?.name || 'Library', () => navigate(id), 'library-move-tree-name');
        label.append(assetIcon(item?.kind || 'folder'), element('span', '', item?.name || 'Library')); row.append(label); tree.append(row);
        if (expanded.has(id)) for (const child of children) walk(child, depth + 1);
      };
      walk(null, 0); tree.scrollTop = top;
    };
    const navigate = id => {
      current = id; selected = id; parents(id).forEach(item => expanded.add(item.id)); expanded.add(id);
      renderTree(); crumbs.replaceChildren(button('Library', 'Library', () => navigate('')));
      for (const item of parents(id)) crumbs.append(element('span', '', '›'), button(item.name, displayPath(item.id), () => navigate(item.id)));
      up.disabled = !id; list.replaceChildren(); list.scrollTop = 0;
      for (const item of model.children(id)) {
        const row = button('', displayPath(item.id), () => { selected = item.id; updateSelection(); }, 'library-move-item'); row.dataset.destinationId = item.id;
        row.append(assetIcon(item.kind), element('span', 'library-move-name', item.name), element('span', 'library-move-kind', { folder: 'Folder', class: 'Class', block: 'Block' }[item.kind]));
        row.ondblclick = () => navigate(item.id);
        row.onkeydown = event => { if (event.key === 'ArrowRight' || event.key === 'Enter') { event.preventDefault(); navigate(item.id); } };
        list.append(row);
      }
      if (!model.children(id).length) list.append(element('div', 'library-move-empty', '此目录为空'));
      updateSelection();
    };
    navigate(current); return cancel;
  }, true);
}
