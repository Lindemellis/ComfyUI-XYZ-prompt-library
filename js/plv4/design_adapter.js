import './design_components.js';

// These are selector aliases for existing data/command adapters, not another
// design. The accepted prototype owns design.css and component HTML.
const aliases = {
  'plv4-center': 'workspace', 'plv4-tabs': 'nodebar', 'plv4-tablist': 'node-tabs',
  'plv4-tab': 'node-tab', 'plv4-modes': 'modebar', 'plv4-blocks': 'notebook',
  'plv4-run': 'run', 'plv4-prompt': 'prompt', 'plv4-path': 'breadcrumb',
  'plv4-popover': 'context-menu block-options', 'plv4-output': 'preview-text',
};
export function designClasses(classes) {
  return classes.split(' ').flatMap(name => [name, ...(aliases[name]?.split(' ') || [])]).join(' ');
}
export async function mountDesign(style, onReady) {
  const response = await fetch(new URL('./design.css', import.meta.url));
  if (!response.ok) throw new Error('无法加载已定稿的 PLv4 样式');
  // The prototype's page-level rules stay inside this plugin's window/popovers.
  const css = (await response.text()).replace(/:root/g, ':scope')
    .replace(/(^|[\s,{])body\b/g, '$1:scope')
    .replace(/\.floating-shell\b/g, ':scope.floating-shell')
    .replace(/\.context-menu\b/g, ':scope.context-menu')
    // The preview is itself a .plv4 scope root, mounted directly under body.
    .replace(/\.library-tag-preview\b/g, ':scope.library-tag-preview')
    .replace(/\.library-dialog-overlay\b/g, ':scope.library-dialog-overlay')
    .replace(/:scope\.cards\s+:scope\.floating-shell/g, ':scope.floating-shell.cards');
  style.textContent = `@scope (.plv4) { ${css} }` + ADAPTER;
  onReady?.();
}
export function blockLibraryPath(row, library) {
  if (row.meta?.source?.kind === 'block') {
    const source = row.meta.source, asset = library?.data?.assets?.find(asset => asset.id === source.id);
    return asset ? asset.path || library.path(asset) : source.path || row.meta?.full_path || '';
  }
  // Only saved block paths belong here. A Class binding is not a block asset.
  return row.meta?.full_path && !['folder','class'].includes(row.meta?.source?.kind) ? row.meta.full_path : '';
}

export function blockFrame(row, depth, folded, selected, libraryRoot, libraryPath = '', folder = null) {
  const settings = row.settings || {};
  const b = { ...row, name: row.meta?.name || row.ast?.header || '', libraryPath, collapsed: folded,
    type: ['schedule', 'region', 'avg'].includes(row.form) ? row.form : row.meta?.lora ? 'lora' : 'normal',
    avgWeight: settings.avg_weight,
    poolName: folder?.name || 'Class 不在本机', poolPath: folder?.path || '', poolAvailable: !!folder,
    schedule: !!settings.schedule, start: settings.schedule?.[0], end: settings.schedule?.[1],
    region: !!settings.region, regionKind: settings.region?.kind, mask: settings.region?.imask };
  const leaves = (node, enabled = true) => enabled && node.enabled ? (node.children || []).filter(child => !child.meta?.lora_invocation).flatMap(child =>
    child.kind === 'group' && child.form !== 'paren' ? leaves(child) : child.enabled ? [child] : []) : [];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const template = document.createElement('template');
  template.innerHTML = XYZPLv4Design.blockHTML(b, depth, !row.effective && row.enabled, {
    state: { selected }, root: () => ({ id: libraryRoot ? row.id : null }), isLibraryBlockView: () => libraryRoot,
    childrenHTML: () => '', join: list => list.join(', '), leaves, text: node => node.source, esc,
  });
  const box = template.content.firstElementChild;
  if (row.form === 'region' && row.meta?.region_enabled === false) {
    const label = box.querySelector('.block-type[data-kind="region"]');
    if (label) { label.textContent = 'Region · Off'; label.title = 'Region functionality is off. Enabled entries render as ordinary prompt content.'; label.style.color = 'var(--muted)'; }
  }
  const map = { block: 'plv4-block', 'block-head': 'plv4-header', fold: 'plv4-fold',
    'block-title': 'plv4-name', 'block-content': 'plv4-content', 'drag-handle': 'plv4-handle' };
  for (const node of [box, ...box.querySelectorAll('*')]) for (const [from, to] of Object.entries(map)) if (node.classList.contains(from)) node.classList.add(to);
  box.dataset.blockId = row.id;
  box.querySelector('.block-content').dataset.parentId = row.id;
  return box;
}

const ADAPTER = `
.plv4 .plv4-menu-group{padding:6px 8px 2px;color:var(--muted);font-size:11px;pointer-events:none}
.plv4 .plv4-menu-separator{margin:4px 0;border:0;border-top:1px solid var(--line)}
.plv4 .plv4-tab.preview-tab .plv4-tab-label{font-style:italic}
.plv4 .plv4-tab{display:flex;align-items:center;gap:5px;cursor:pointer}.plv4 .plv4-tab-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.plv4 .plv4-tab-close{display:grid;place-items:center;flex:0 0 20px;width:20px;height:20px;padding:0;border-radius:3px;font-size:14px;color:#a9bcb1}.plv4 .plv4-tab-close:hover{color:#e8f5ef;background:#ffffff16}
.plv4.floating-shell{z-index:1200;font:12px var(--ui);color:var(--text);background:var(--bg);border-color:#58645f;box-shadow:0 24px 85px #000a,0 0 0 1px #0009}
.plv4 .layout{display:grid;overflow:hidden}.plv4 .plv4-column{min-width:0;min-height:0;overflow:hidden}.plv4 .workspace{display:flex;flex-direction:column}.plv4 .plv4-scroll{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}
.plv4 .plv4-tabs,.plv4 .plv4-modes{flex:none}.plv4 .plv4-row{display:flex;align-items:center;gap:4px;min-width:0}.plv4 .node-tabs{min-width:0}.plv4 .plv4-name{min-width:0}.plv4 .plv4-item-row{display:flex;align-items:center;gap:3px;margin-bottom:2px}.plv4 .plv4-item-row>input[type=text]{flex:1;min-width:0}.plv4 .plv4-item-weight{width:48px;flex:0 0 48px}
.plv4 .plv4-field{display:flex;align-items:center;justify-content:space-between;gap:4px;min-height:22px;font-size:10px}.plv4 .plv4-field>label{flex:1}.plv4 .plv4-field>input:not([type=checkbox]){width:80px}.plv4 .plv4-details{overflow:auto}.plv4 .plv4-badge{font-size:9px;color:var(--muted)}
.plv4 input[type=checkbox]{appearance:none;width:23px;height:13px;padding:0;margin:0;border:0;border-radius:20px;background:#4c565f;position:relative;flex:0 0 23px;cursor:pointer}.plv4 input[type=checkbox]:after{content:'';position:absolute;width:7px;height:7px;left:3px;top:3px;border-radius:50%;background:#c1c9ce}.plv4 input[type=checkbox]:checked{background:var(--accent)}.plv4 input[type=checkbox]:checked:after{transform:translateX(10px);background:#244c3e}
.plv4 #folder-name-setting input[type=checkbox]{flex:0 0 23px;width:23px;height:13px;padding:0;border:0;background:#4c565f}.plv4 #folder-name-setting input[type=checkbox]:checked{background:var(--accent)}
.plv4 .plv4-status{flex:none;min-height:19px;padding:3px 12px;background:#202825;border-top:1px solid #3b4740;color:#7c9186;font-size:8px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.plv4 .plv4-error{color:#f1a6a6}.plv4 .plv4-empty{padding:7px;color:var(--muted);font:11px var(--mono)}
.plv4 .plv4-run-editor{height:130px;border:1px solid var(--line);margin:4px 0}.plv4 .plv4-output{white-space:pre-wrap;font:13px/1.6 var(--mono);margin:0;padding:12px}.plv4 .plv4-output-label{font-size:10px;color:var(--muted);padding:6px 12px;border-bottom:1px solid var(--line)}
.plv4 .plv4-library-head{padding:0 0 8px}.plv4 .plv4-library-head input{width:100%;font-size:11px}.plv4 .plv4-library-row{display:flex;align-items:center;gap:3px;min-height:27px;margin:1px 0;border:1px solid transparent;border-radius:4px;font-size:10px}.plv4 .plv4-library-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;text-align:left}.plv4 .plv4-library-row button{flex:none}.plv4 .plv4-library-row:hover{background:#ffffff08}.plv4 .plv4-library-row[data-kind=folder]{color:var(--text)}
.plv4 .plv4-section>summary{font-size:8px;letter-spacing:1px;color:var(--muted)}.plv4 .plv4-child-link{font-size:10px;text-align:left}.plv4 .plv4-candidates .plv4-row{min-height:22px;font-size:10px}
.plv4.plv4-popover.context-menu{z-index:1600;position:fixed;display:flex;flex-direction:column;width:max-content;min-width:120px;padding:5px;background:#2a3234;border:1px solid #53615b;border-radius:6px;box-shadow:0 10px 35px #0006;text-align:left}
.plv4.plv4-popover.context-menu>button,.plv4.plv4-popover.context-menu>.plv4-menu-branch>button{display:block;width:100%;padding:8px 11px;border:0;border-radius:4px;background:transparent;color:#d4dfda;text-align:left;font:13px/1.4 var(--ui);cursor:pointer}
.plv4.plv4-popover.context-menu>button:hover,.plv4.plv4-popover.context-menu>.plv4-menu-branch>button:hover{background:#394841}
.plv4.plv4-drop.drop-hint{z-index:1500;position:fixed;pointer-events:none;color:#d6eee0;font:12px/1.4 var(--ui);background:#294437;border:1px solid #82b69c;padding:7px 10px;border-radius:5px;max-width:320px}
.plv4.plv4-drop-mark{z-index:1500;position:fixed;pointer-events:none;width:2px;background:#93d9c1;box-shadow:0 0 0 1px #93d9c133}
.plv4 .drop-inside{outline:2px solid #93d9c1;outline-offset:-2px;background-color:#93d9c110}
.plv4 .block.dragging{opacity:.4}.plv4 .drag-handle,.plv4 .library-handle{touch-action:none}
.plv4 .plv4-interval{margin:7px 0;min-height:28px}.plv4 .inspector .plv3-dual input[type=range]{position:absolute;width:100%;height:20px;padding:0;margin:0;border:0;background:transparent;appearance:none;pointer-events:none}
`;
