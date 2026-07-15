// PLv3 — the main window (spec §8.2): node list | editor + preview | detail.
//
// Every boundary in here is draggable, and the window itself resizes from all four
// edges and corners. See theme.js for the chrome and the design tokens.

import { app } from '../../../scripts/app.js';
import { DetailPane } from './detail.js';
import { EditorPane } from './editor.js';
import { libraryWindow } from './library.js';
import { PreviewPanel } from './preview.js';
import { T, button, div, iconButton, makeWindow, splitter, tabs, treeRow } from './theme.js';

export const PLV3_TYPES = new Set([
  'XYZ Prompt Library V3',
  'XYZ Prompt Library V3 Monaco',
]);

/** The Monaco node carries its own embedded editor; the plain one uses a textarea. */
export function isMonacoNode(node) {
  return node?.comfyClass?.endsWith('Monaco') ?? false;
}

const GEOM = { x: 120, y: 90, w: 1280, h: 700 };

class PLv3Window {
  constructor() {
    this.win = null;
    this.open = []; // node ids, in tab order
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
      title: 'Prompt Library V3',
      defaults: GEOM,
      minW: 820,
      minH: 420,
      onResize: () => this.pane?.relayout(),
    });

    const libBtn = button('📚 Library', { variant: 'ghost', size: 'sm' });
    libBtn.onclick = () => {
      libraryWindow.onInsert = (text) => this.pane.insertAtCursor(text);
      libraryWindow.toggle().catch((err) => console.error('[PLv3] library', err));
    };
    const close = iconButton('✕', 'Close', () => this.hide());
    this.win.bar.append(libBtn, close);

    // --- 1) node list ---
    this.listEl = div(`width:200px;flex-shrink:0;overflow-y:auto;background:${T.bg2};
      padding:8px 6px;min-width:0;`);

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

    this.win.body.append(
      this.listEl,
      splitter(this.listEl, { dir: 'x', key: 'xyz.plv3.list.w', min: 140, max: 420 }),
      mid,
      splitter(this.detailEl, { dir: 'x', key: 'xyz.plv3.detail.w', min: 300, max: 720, invert: true }),
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
    this.detail = new DetailPane(this.detailEl, { pane: this.pane });
    this.detail.clear();
    await this.pane.init();

    this.win.el.addEventListener('plv3:resized', () => this.pane.relayout());
  }

  // --- node list ---
  plv3Nodes() {
    return (app.graph?._nodes || []).filter((n) => PLV3_TYPES.has(n.comfyClass));
  }

  refreshNodeList() {
    if (!this.listEl) return;
    this.listEl.replaceChildren();
    const nodes = this.plv3Nodes();

    if (!nodes.length) {
      this.listEl.append(div(
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
        label: node.title || `Node ${node.id}`,
        selected: String(node.id) === this.pane?.activeId,
        tail: div(`font-size:${T.fs.micro};color:${T.muted};font-family:${T.mono};`, `#${node.id}`),
      });
      row.onclick = () => this.openNode(node);
      this.listEl.append(row);
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
