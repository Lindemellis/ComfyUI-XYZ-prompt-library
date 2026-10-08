// PLv3 — the main window (spec §8.2): node list | editor + preview | detail.
//
// Every boundary in here is draggable, and the window itself resizes from all four
// edges and corners. See theme.js for the chrome and the design tokens.

import { app } from '../../../scripts/app.js';
import { DetailPane } from './detail.js';
import { EditorPane } from './editor.js';
import { libraryWindow } from './library.js';
import { PreviewPanel } from './preview.js';
import { T, button, div, el, iconButton, makeWindow, splitter, tabs, treeRow } from './theme.js';
import { showConfirm, toast } from './ui.js';

export const PLV3_TYPES = new Set([
  'XYZ Prompt Library V3',
  'XYZ Prompt Library V3 Monaco',
  'XYZ Prompt Library V4',
  'XYZ Prompt Library V4 Monaco',
]);

function widget(node, name) {
  return node?.widgets?.find((w) => w.name === name);
}

/** The Monaco node carries its own embedded editor; the plain one uses a textarea. */
export function isMonacoNode(node) {
  return node?.comfyClass?.endsWith('Monaco') ?? false;
}

const GEOM = { x: 120, y: 90, w: 1280, h: 700 };
const NODE_SORT_KEY = 'xyz.plv3.nodes.sort';
const PANES_KEY = 'xyz.plv3.panes';
const RIGHT_WIDTHS_KEY = 'xyz.plv3.right.widths';
const DEFAULT_PANES = { nodes: true, outline: true, detail: true };

const ACTIVITY_ICONS = {
  nodes: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <rect x="4" y="4" width="6" height="6" rx="1"></rect>
    <rect x="14" y="4" width="6" height="6" rx="1"></rect>
    <rect x="4" y="14" width="6" height="6" rx="1"></rect>
    <rect x="14" y="14" width="6" height="6" rx="1"></rect>
  </svg>`,
  outline: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <path d="M7 5h13M7 12h13M7 19h13"></path>
    <circle cx="3.5" cy="5" r="1"></circle>
    <circle cx="3.5" cy="12" r="1"></circle>
    <circle cx="3.5" cy="19" r="1"></circle>
  </svg>`,
  detail: `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <path d="M4 6h8M16 6h4M4 12h3M11 12h9M4 18h10M18 18h2"></path>
    <circle cx="14" cy="6" r="2"></circle>
    <circle cx="9" cy="12" r="2"></circle>
    <circle cx="16" cy="18" r="2"></circle>
  </svg>`,
};

const nodeName = (node) => String(node.title || `Node ${node.id}`);

function loadPanes() {
  try {
    const saved = JSON.parse(localStorage.getItem(PANES_KEY) || '{}');
    return {
      nodes: saved.nodes !== false,
      outline: saved.outline !== false,
      detail: saved.detail !== false,
    };
  } catch {
    return { ...DEFAULT_PANES };
  }
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function loadRightWidths() {
  const legacyTotal = Number(localStorage.getItem('xyz.plv3.detail.w')) || 440;
  const legacyOutline = Number(localStorage.getItem('xyz.plv3.detailnav.w')) || 190;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(RIGHT_WIDTHS_KEY) || '{}'); } catch {}
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) saved = {};
  const outline = clamp(Number(saved.outline) || legacyOutline, 110, 280);
  return {
    outline,
    body: clamp(Number(saved.body) || (legacyTotal - outline - 1), 220, 720),
  };
}

function compareIds(a, b) {
  const ai = Number(a.id), bi = Number(b.id);
  if (Number.isFinite(ai) && Number.isFinite(bi) && ai !== bi) return ai - bi;
  return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
}

function sortNodes(nodes, mode) {
  const out = [...nodes];
  if (mode === 'name') {
    out.sort((a, b) => nodeName(a).localeCompare(nodeName(b), undefined, {
      numeric: true,
      sensitivity: 'base',
    }) || compareIds(a, b));
  } else {
    out.sort(compareIds);
  }
  return out;
}

function activityButton(icon, label, onClick) {
  const b = el('button', `width:42px;height:42px;display:flex;align-items:center;
    justify-content:center;padding:0;border:0;border-left:2px solid transparent;
    background:transparent;color:${T.muted};cursor:pointer;box-sizing:border-box;
    transition:color .12s,background .12s,border-color .12s;`);
  b.type = 'button';
  b.innerHTML = ACTIVITY_ICONS[icon];
  const svg = b.querySelector('svg');
  svg.style.fill = 'none';
  svg.style.stroke = 'currentColor';
  svg.style.strokeWidth = '1.6';
  svg.style.strokeLinecap = 'round';
  svg.style.strokeLinejoin = 'round';
  b.onclick = onClick;
  b.onmouseenter = () => { b.style.background = T.bg3; b.style.color = T.text; };
  b.onmouseleave = () => b.updateState(b._active);
  b.updateState = (active) => {
    b._active = active;
    b.style.background = active ? T.bg3 : 'transparent';
    b.style.color = active ? T.text : T.muted;
    b.style.borderLeftColor = active ? T.accent : 'transparent';
    b.title = `${active ? 'Hide' : 'Show'} ${label}`;
    b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-pressed', String(active));
  };
  return b;
}

/** Width an element occupies in its flex row, including possibly-negative margins.
 *  Splitters are 5 px hit targets with -2 px margins, so their visual footprint is 1 px. */
function flexWidth(element) {
  if (!element) return 0;
  const style = getComputedStyle(element);
  if (style.display === 'none') return 0;
  const marginLeft = Number.parseFloat(style.marginLeft) || 0;
  const marginRight = Number.parseFloat(style.marginRight) || 0;
  return element.getBoundingClientRect().width + marginLeft + marginRight;
}

class PLv3Window {
  constructor() {
    this.win = null;
    this.open = []; // node ids, in tab order
    this.nodeSort = localStorage.getItem(NODE_SORT_KEY) === 'name' ? 'name' : 'id';
    this.panes = loadPanes();
    this.rightWidths = loadRightWidths();
  }

  isVisible() {
    return !!this.win && this.win.isVisible();
  }

  async toggle(node) {
    if (this.isVisible() && (!node || String(node.id) === this.pane?.activeId)) {
      this.hide();
      return;
    }
    await this.show(node);
  }

  hide() {
    this.pane?.syncActiveToNode();
    this.pane?.saveViewState();   // persist the active node's folding on close
    this.win?.hide();
  }

  async show(node) {
    await this.build();
    this.win.show();
    this.pane.relayout();
    this.refreshNodeList();
    if (node) await this.openNode(node);
  }

  build() {
    if (!this._building) this._building = this._build();
    return this._building;
  }

  async _build() {
    this.win = makeWindow({
      key: 'xyz.plv3.window',
      title: 'PLv3 Prompt Editor',
      defaults: GEOM,
      minW: 820,
      minH: 420,
      onResize: () => this.pane?.relayout(),
    });

    const libBtn = button('📚 Library', { variant: 'ghost', size: 'sm' });
    libBtn.onclick = () => {
      this.bindLibrary();
      libraryWindow.toggle().catch((err) => console.error('[PLv3] library', err));
    };
    // Saving the WHOLE document — structure, regions, schedules and the items switched
    // off. The library's groups and presets can only hold a flat list of items, so this
    // is the only thing that keeps a prompt's shape.
    const saveBtn = button('💾 Save', { variant: 'ghost', size: 'sm' });
    saveBtn.title = 'Save this document to the library';
    // .catch, not a bare call: an async click handler that throws becomes an unhandled
    // rejection in the console and NOTHING on screen — "I clicked Save and nothing
    // happened" is the one failure mode a save button must never have.
    saveBtn.onclick = () => this.saveActiveDocument().catch((err) => {
      console.error('[PLv3] save document', err);
      toast(`Could not save — ${err.message}`, 'error');
    });
    const close = iconButton('✕', 'Close', () => this.hide());
    this.win.bar.append(saveBtn, libBtn, close);

    // VS Code-like activity bar: one stable place controls all optional columns.
    this.activityEl = div(`width:42px;flex:0 0 42px;display:flex;flex-direction:column;
      align-items:stretch;padding-top:4px;background:${T.bg0};border-right:1px solid ${T.line};`);
    this.activityButtons = {
      nodes: activityButton('nodes', 'node list', () => this.togglePane('nodes')),
      outline: activityButton('outline', 'outline', () => this.togglePane('outline')),
      detail: activityButton('detail', 'prompt details', () => this.togglePane('detail')),
    };
    this.activityEl.append(
      this.activityButtons.nodes,
      this.activityButtons.outline,
      this.activityButtons.detail,
    );

    // --- 1) node list ---
    this.listEl = div(`width:200px;flex-shrink:0;display:flex;flex-direction:column;
      overflow:hidden;background:${T.bg2};min-width:0;`);
    const listHead = div(`height:34px;display:flex;align-items:center;gap:7px;padding:0 8px 0 10px;
      border-bottom:1px solid ${T.line};flex-shrink:0;box-sizing:border-box;`);
    listHead.append(div(`flex:1;min-width:0;font-size:${T.fs.micro};font-weight:600;
      letter-spacing:.06em;color:${T.muted};`, 'NODES'));
    this.sortSelect = el('select', `min-width:82px;background:${T.bg0};color:${T.label};
      border:1px solid ${T.edge};border-radius:${T.radiusSm};padding:2px 5px;
      font-family:${T.font};font-size:${T.fs.micro};outline:none;cursor:pointer;`);
    for (const [value, label] of [['id', 'Node ID'], ['name', 'Name A–Z']]) {
      const option = el('option', '', label);
      option.value = value;
      this.sortSelect.append(option);
    }
    this.sortSelect.value = this.nodeSort;
    this.sortSelect.title = 'Sort PLv3 nodes';
    this.sortSelect.setAttribute('aria-label', 'Sort PLv3 nodes');
    this.sortSelect.onchange = () => {
      this.nodeSort = this.sortSelect.value === 'name' ? 'name' : 'id';
      localStorage.setItem(NODE_SORT_KEY, this.nodeSort);
      this.refreshNodeList();
    };
    listHead.append(this.sortSelect);
    this.listRows = div('flex:1;min-height:0;overflow-y:auto;padding:6px;');
    this.listEl.append(listHead, this.listRows);

    // --- 2) editor + preview ---
    const mid = div(`flex:1;min-width:0;display:flex;flex-direction:column;background:${T.bg1};`);
    this.tabsHost = div(`flex-shrink:0;background:${T.bg2};`);
    const host = div('flex:1;min-height:0;');
    this.preview = new PreviewPanel();
    mid.append(
      this.tabsHost,
      host,
      splitter(this.preview.resizeTarget, {
        dir: 'y', key: this.preview.heightKey, min: 90, max: 460, invert: true,
      }),
      this.preview.el,
    );

    // --- 3) detail ---
    this.detailEl = div(`width:440px;flex-shrink:0;min-height:0;display:flex;
      background:${T.bg1};min-width:0;`);

    this.listSplitter = splitter(
      this.listEl,
      { dir: 'x', key: 'xyz.plv3.list.w', min: 140, max: 420 },
    );
    this.detailSplitter = splitter(
      this.detailEl,
      // The target can be Outline alone, Details alone, or both. Their widths are stored
      // separately below, so this divider deliberately has no single persistence key.
      { dir: 'x', min: 180, max: 900, invert: true },
    );
    this.win.body.append(
      this.activityEl,
      this.listEl,
      this.listSplitter,
      mid,
      this.detailSplitter,
      this.detailEl,
    );

    this.pane = new EditorPane(host, {
      onCompiled: (result) => {
        this.preview.setResult(result);
        this.detail.setCompiled(result);
      },
      onAst: (payload, node, meta) => this.detail.setAst(payload, node, meta),
      onLibrarySynced: (paths) => this.detail.invalidateLibrary(paths),
    });
    this.detail = new DetailPane(this.detailEl, {
      pane: this.pane,
      // A disabled library item's weight lives on the node itself — `properties` is
      // serialised with the workflow, so it survives a reload, and it belongs to this one
      // node, so two documents remember their own weights for the same library item. It
      // never touches the library DB.
      memoryStore: {
        load: () => this.pane.activeNode()?.properties?.plv3_weights || {},
        save: (dump) => {
          const node = this.pane.activeNode();
          if (!node) return;
          node.properties = node.properties || {};
          node.properties.plv3_weights = dump;
          node.graph?.setDirtyCanvas(true, true);   // mark dirty so the workflow saves it
        },
      },
    });
    this.detail.clear();
    this.detailEl.addEventListener('plv3:resized', () => this.captureRightWidths());
    this.applyPaneVisibility(false);
    this.bindLibrary();   // the hooks must exist before the library window is ever opened
    await this.pane.init();

    this.win.el.addEventListener('plv3:resized', () => this.pane.relayout());
  }

  // --- the library's two hooks: only this window knows which node is open ---
  bindLibrary() {
    libraryWindow.onInsert = (text) => this.pane.insertAtCursor(text);
    libraryWindow.onLoadDocument = (row) => this.loadDocument(row);
  }

  togglePane(name) {
    this.captureRightWidths();
    const windowWidth = this.win.el.getBoundingClientRect().width;
    const before = this.optionalColumnsWidth();
    this.panes[name] = !this.panes[name];
    this.applyPaneVisibility(true);
    const after = this.optionalColumnsWidth();
    this.resizeWindowBy(after - before, windowWidth);
  }

  optionalColumnsWidth() {
    return flexWidth(this.listEl)
      + flexWidth(this.listSplitter)
      + flexWidth(this.detailSplitter)
      + flexWidth(this.detailEl);
  }

  resizeWindowBy(delta, baseWidth) {
    if (!this.win?.el || !Number.isFinite(delta) || Math.abs(delta) < 0.5) return;
    // Keep the left edge and the Monaco column fixed. Sidebars therefore behave like
    // attachments to the floating window: closing one removes its width from the window;
    // opening it adds exactly that width back.
    this.win.el.style.width = `${Math.max(1, Math.round(baseWidth + delta))}px`;
    this.win.save();
    this.pane?.relayout();
  }

  captureRightWidths() {
    if (!this.detailEl?.offsetWidth || !this.detail) return;
    const widths = this.detail.columnWidths();
    if (this.panes.outline && this.panes.detail) {
      if (widths.outline) {
        this.rightWidths.outline = clamp(widths.outline, 110, 280);
      }
      if (widths.body) {
        this.rightWidths.body = clamp(widths.body, 220, 720);
      }
    } else if (this.panes.outline) {
      this.rightWidths.outline = clamp(this.detailEl.offsetWidth, 110, 280);
    } else if (this.panes.detail) {
      this.rightWidths.body = clamp(this.detailEl.offsetWidth, 220, 720);
    }
    localStorage.setItem(RIGHT_WIDTHS_KEY, JSON.stringify(this.rightWidths));
  }

  applyPaneVisibility(persist = false) {
    if (!this.listEl || !this.detailEl || !this.detail) return;
    this.listEl.style.display = this.panes.nodes ? 'flex' : 'none';
    this.listSplitter.style.display = this.panes.nodes ? 'block' : 'none';

    this.detail.setOutlineWidth(this.rightWidths.outline);
    this.detail.setColumnVisibility({
      outline: this.panes.outline,
      body: this.panes.detail,
    });
    const rightVisible = this.panes.outline || this.panes.detail;
    const rightWidth = (this.panes.outline ? this.rightWidths.outline : 0)
      + (this.panes.detail ? this.rightWidths.body : 0)
      + (this.panes.outline && this.panes.detail ? 1 : 0);
    if (rightVisible) this.detailEl.style.width = `${rightWidth}px`;
    this.detailEl.style.display = rightVisible ? 'flex' : 'none';
    this.detailSplitter.style.display = rightVisible ? 'block' : 'none';

    for (const [name, b] of Object.entries(this.activityButtons)) {
      b.updateState(this.panes[name]);
    }
    if (persist) localStorage.setItem(PANES_KEY, JSON.stringify(this.panes));
    this.pane?.relayout();
  }

  /** Save the open node's document into the library. */
  async saveActiveDocument() {
    const node = this.pane?.activeNode();
    if (!node) {
      toast('Open a node first — a document is saved from the node it belongs to.', 'error');
      return;
    }
    // The editor is the truth while the window is open, and its text reaches the widget
    // only on blur. Push it first, or clicking Save straight after typing saves the text
    // as it was one edit ago.
    this.pane.syncActiveToNode();
    await libraryWindow.saveDocument({
      text: widget(node, 'text')?.value ?? '',
      doc: widget(node, 'doc')?.value ?? '',
      suggested: node.title || `Node ${node.id}`,
    });
  }

  /** Put a saved document into the open node, replacing what is there. */
  async loadDocument(row) {
    const node = this.pane?.activeNode();
    if (!node) {
      toast('Open a node first — a document is loaded into a node.', 'error');
      return;
    }
    const ok = await showConfirm(
      `Replace the contents of “${node.title || `Node ${node.id}`}” with the document `
      + `“${row.name}”?\n\nWhat is in the node now is overwritten. Ctrl+Z in the editor `
      + `undoes it.`,
      { okLabel: 'Replace', danger: true });
    if (!ok) return;

    // The doc FIRST: the text change triggers a lint, which posts the doc alongside it,
    // and a stale doc there would be reconciled against the new text — parking items the
    // snapshot never had and losing the ones it did.
    const dw = widget(node, 'doc');
    if (dw) dw.value = row.doc_json || '';
    const tw = widget(node, 'text');
    if (tw) {
      tw.value = row.text;
      tw.callback?.call(node, row.text);
    }
    node.graph?.setDirtyCanvas(true, true);
    // ...and into the open Monaco model. The widget callback usually gets here by itself
    // (plv3.js re-dispatches it), but that wrapper is not guaranteed to be installed.
    this.pane.pushFromNode(node.id, row.text);
    this.pane.scheduleLint();
    toast(`Loaded “${row.name}”.`);
  }

  // --- node list ---
  plv3Nodes() {
    return (app.graph?._nodes || []).filter((n) => PLV3_TYPES.has(n.comfyClass));
  }

  refreshNodeList() {
    if (!this.listRows) return;
    this.listRows.replaceChildren();
    const nodes = sortNodes(this.plv3Nodes(), this.nodeSort);

    if (!nodes.length) {
      this.listRows.append(div(
        `color:${T.muted};font-size:${T.fs.label};padding:8px 6px;line-height:1.5;`,
        'No PLv3 nodes in this workflow.',
      ));
      return;
    }

    for (const node of nodes) {
      const monaco = isMonacoNode(node);
      const row = treeRow({
        icon: monaco ? '📝' : '📄',
        iconColor: T.accent,
        label: nodeName(node),
        selected: String(node.id) === this.pane?.activeId,
        tail: div(`font-size:${T.fs.micro};color:${T.muted};font-family:${T.mono};`, `#${node.id}`),
      });
      row.onclick = () => this.openNode(node);
      this.listRows.append(row);
    }
  }

  async openNode(node) {
    const id = String(node.id);
    if (!this.open.includes(id)) this.open.push(id);
    this.pane.open(node);
    this.refreshTabs();
    this.refreshNodeList();
  }

  refreshTabs() {
    const nodes = this.plv3Nodes();
    const items = this.open
      .map((id) => {
        const node = nodes.find((n) => String(n.id) === id);
        if (!node) return null;
        return {
          id,
          label: node.title || `Node ${id}`,
          onClose: () => this.closeTab(id),
        };
      })
      .filter(Boolean);

    this.tabsHost.replaceChildren(
      tabs(items, this.pane.activeId, (id) => {
        const node = nodes.find((n) => String(n.id) === id);
        if (node) this.openNode(node);
      }),
    );
  }

  closeTab(id) {
    this.pane.close(id);
    this.open = this.open.filter((x) => x !== id);
    const next = this.open[this.open.length - 1];
    if (next) {
      const node = this.plv3Nodes().find((n) => String(n.id) === next);
      if (node) this.pane.open(node);
    } else {
      this.detail.clear();
      this.preview.setResult(null);
    }
    this.refreshTabs();
    this.refreshNodeList();
  }
}

export const plv3Window = new PLv3Window();

// The node's own text widget changed -> keep the open model in step.
document.addEventListener('plv3:node-edited', (e) => {
  plv3Window.pane?.pushFromNode(e.detail.nodeId, e.detail.value);
});
