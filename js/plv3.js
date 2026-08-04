// PLv3 — ComfyUI extension entry: the node's Editor button, the Monaco node's
// embedded editor, and node<->window sync.
//
// Two node types, differing only in their text box:
//   XYZ Prompt Library V3          — ComfyUI's plain multiline textarea (light)
//   XYZ Prompt Library V3 Monaco   — the SAME Monaco editor the floating window uses
//                                    (editor_core.js): library autocomplete, folding,
//                                    tag lookup, squiggles, mounted right in the node.
// Both also get an "Editor" button that opens the full three-pane floating window.

import { app } from '../../../scripts/app.js';
import { libraryWindow } from './plv3/library.js';
import { PLV3_TYPES, isMonacoNode, plv3Window } from './plv3/window.js';
import { PromptEditor, acquireNodeModel, releaseNodeModel } from './plv3/editor_core.js';
import { nodePolarity } from './plv3/editor.js';

// The top-bar menu (gallery_topbar.js) opens these without importing the modules —
// the same handle PLv2 exposes as `window.plv2`.
window.plv3 = {
  window: plv3Window,
  library: libraryWindow,
};

const BTN_H = 32;   // the button itself
const ROW_H = 40;   // the button row it sits in, with a little breathing room

// The embedded editor's sizing. MIN is the floor `computeSize` reports (the true
// minimum, so the node stays freely resizable — NEVER derived from node.size, which is
// the feedback loop that blew the Mask Editor to 1.1M px). DEFAULT is how tall it opens.
const MIN_EDITOR_H = 150;
const DEFAULT_EDITOR_H = 300;
const WIDGET_ROW = 26;   // seed / region_mode row height, approx
const GAP = 14;

function button(label) {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = `flex:1;height:${BTN_H}px;padding:0 10px;border-radius:5px;
    border:1px solid #45475a;background:#313244;color:#cdd6f4;cursor:pointer;
    font-size:13px;font-weight:600;letter-spacing:.02em;line-height:1;
    font-family:ui-sans-serif,system-ui,sans-serif;transition:background .12s;`;
  b.onmouseenter = () => (b.style.background = '#3d3d52');
  b.onmouseleave = () => (b.style.background = '#313244');
  return b;
}

function textWidget(node) {
  return node.widgets?.find((x) => x.name === 'text');
}

/** Hide ComfyUI's native text textarea for the Monaco node: it stays the backend's
 *  value store but must not also draw itself under the editor. */
function hideTextWidget(node) {
  const tw = textWidget(node);
  if (!tw) return;
  tw.hidden = true;
  tw.computeSize = () => [0, -4];
  if (tw.inputEl) tw.inputEl.style.display = 'none';
}

/** The structured document (spec §5.2 as rewritten): the same tree as `text`, plus a
 *  stable id and an on/off switch per item. It is the backend's source of truth, and
 *  it is where the items you switched OFF live — they are deliberately nowhere in the
 *  text, so without this widget they would not survive a save.
 *
 *  Hidden like the Monaco node's textarea: a one-line JSON blob is not something to
 *  draw on a node, but it must stay a real serialised widget. */
function hideDocWidget(node) {
  const dw = node.widgets?.find((x) => x.name === 'doc');
  if (!dw) return;
  dw.hidden = true;
  dw.computeSize = () => [0, -4];
  if (dw.inputEl) dw.inputEl.style.display = 'none';
}

/** editor text -> the node's `text` widget (the value the backend reads). Routed
 *  through the widget callback so an open floating window sees the change too. */
function pushToNode(node, pe) {
  const tw = textWidget(node);
  if (!tw) return;
  const v = pe.text();
  if (tw.value === v) return;
  tw.value = v;
  tw.callback?.call(node, v);
  node.graph?.setDirtyCanvas(true, false);
}

/** Fit the Monaco container to the room the node gives it. Reads node.size and writes
 *  ONLY to the container element — one-way, so it is never the resize feedback loop. */
function sizeEditor(node) {
  const emb = node.__plv3Embed;
  if (!emb) return;
  const T = window.LiteGraph?.NODE_TITLE_HEIGHT ?? 30;
  const S = window.LiteGraph?.NODE_SLOT_HEIGHT ?? 20;
  const header = T + (node.outputs?.length || 0) * S + 2 * WIDGET_ROW + ROW_H + GAP * 2;
  const h = Math.max(MIN_EDITOR_H, Math.floor(node.size[1] - header));
  if (Math.round(parseFloat(emb.container.style.height)) !== h) {
    emb.container.style.height = `${h}px`;
  }
  emb.pe.relayout();
}

/** Mount the embedded Monaco editor on the Monaco node. Lazy: Monaco is heavy, so it
 *  builds the first time the node exists rather than at extension-load time. */
async function mountEditor(node) {
  if (node.__plv3Embed) return;

  const container = document.createElement('div');
  container.style.cssText = `width:100%;height:${DEFAULT_EDITOR_H}px;box-sizing:border-box;
    border:1px solid #45475a;border-radius:6px;overflow:hidden;`;

  const w = node.addDOMWidget('plv3_editor', 'custom', container, {
    getValue: () => '',
    setValue: () => {},
    serialize: false,
  });
  // The MINIMUM height, a constant — never node.size (that is the feedback loop).
  w.computeSize = (width) => [width || node.size[0], MIN_EDITOR_H];
  // Let the Vue renderer stretch this row so a drag-to-resize reaches the editor.
  w.computeLayoutSize = () => ({ minHeight: MIN_EDITOR_H, minWidth: 240 });

  const pe = new PromptEditor(container, {
    params: () => ({
      seed: Number(node.widgets?.find((x) => x.name === 'seed')?.value ?? 0),
      region_mode: node.widgets?.find((x) => x.name === 'region_mode')?.value ?? 'couple',
      polarity: nodePolarity(node),
    }),
    // Same store as the floating window: the node's own hidden `doc` widget. Both
    // editors are views of ONE document, so an item switched off in the window is
    // still off here.
    docStore: {
      get: () => node.widgets?.find((x) => x.name === 'doc')?.value ?? '',
      set: (json) => {
        const dw = node.widgets?.find((x) => x.name === 'doc');
        if (!dw || dw.value === json) return;
        dw.value = json;
      },
    },
    onEdited: () => pushToNode(node, pe),
    onBlur: () => pushToNode(node, pe),
    syncOnBlur: true,
  });

  // An external edit (the floating window, or a workflow load) -> the embedded editor.
  // pushToNode fires this same event with the value already in the model, so the
  // equality guard stops the echo from looping.
  const onExternalEdit = (e) => {
    if (String(e.detail?.nodeId) !== String(node.id)) return;
    if (pe.text() === e.detail.value) return;
    pe.setText(e.detail.value);
  };
  document.addEventListener('plv3:node-edited', onExternalEdit);

  node.__plv3Embed = { pe, w, container, onExternalEdit };
  hideTextWidget(node);

  await pe.init();
  // The SHARED model: the floating window edits this very same document, so the two stay
  // in lock-step live and neither ever resets the other's folding. Released on removal.
  const model = acquireNodeModel(pe.monaco, node.id, textWidget(node)?.value ?? '');
  pe.setModel(model);
  // Live sync: the node's value store must be current the instant Run is pressed, not
  // only on blur. Idempotent (pushToNode no-ops when equal).
  pe.editor.onDidChangeModelContent(() => pushToNode(node, pe));

  // Remember this node's folding across a page refresh (keyed apart from the window's).
  pe.bindViewState(`node:${node.id}`);

  // Open tall enough to be usable; grow only if the node is currently too short.
  const openH = node.computeSize()[1] + (DEFAULT_EDITOR_H - MIN_EDITOR_H);
  node.setSize([Math.max(node.size[0], 360), Math.max(node.size[1], openH)]);
  sizeEditor(node);
  pe.relayout();
  node.setDirtyCanvas(true, true);
}

app.registerExtension({
  name: 'XYZNodes.PromptLibraryV3',

  async nodeCreated(node) {
    if (!PLV3_TYPES.has(node.comfyClass)) return;
    node.serialize_widgets = true;
    hideDocWidget(node);

    const wrap = document.createElement('div');
    wrap.style.cssText = `display:flex;align-items:center;gap:6px;width:100%;
      height:${ROW_H}px;box-sizing:border-box;`;

    const edit = button('Editor');
    edit.addEventListener('click', () => {
      // Without this the window's async failures become silent unhandled rejections
      // and the button simply does nothing. Report on the button itself — never
      // alert(), which blocks ComfyUI's whole main thread.
      plv3Window.toggle(node).catch((err) => {
        console.error('[PLv3] could not open the editor', err);
        edit.textContent = 'Editor failed — see console';
        setTimeout(() => (edit.textContent = 'Editor'), 4000);
      });
    });
    // The LLM Prompt Assistant (js/plv2_llm.js) binds to THIS node: it shows the node's
    // compiled output as the base prompt and Apply writes the model's prompt back into
    // the `text` widget. The window itself is hosted by plv2.js, hence the plv2 handle.
    const llm = button('🤖 LLM');
    llm.addEventListener('click', () => {
      const win = window.plv2?.windows?.llm;
      if (!win) {
        console.warn('[PLv3] the LLM window is not available');
        llm.textContent = 'LLM unavailable';
        setTimeout(() => (llm.textContent = '🤖 LLM'), 4000);
        return;
      }
      win.show();
      document.dispatchEvent(new CustomEvent('plv3:llm-bind', { detail: { nodeId: node.id } }));
    });
    wrap.append(edit, llm);

    const w = node.addDOMWidget('plv3_open_btns', 'custom', wrap, {
      getValue: () => '',
      setValue: () => {},
      serialize: false,
    });
    w.computeSize = () => [node.size[0], ROW_H];
    // ComfyUI v2.0 (Vue) lays out every widget whose computeLayoutSize is a function in
    // a stretchable grid row, leaving a big gap under a fixed-height button bar.
    // Shadowing it with a non-function makes the new renderer treat the widget as
    // min-content; the classic renderer ignores this and keeps using computeSize.
    w.computeLayoutSize = undefined;

    // node -> editor (the floating window). The text widget fires its `callback` on
    // every edit in BOTH renderers; listening on `inputEl` only works in the classic
    // one (in the Vue renderer inputEl is an orphan element that is never mounted).
    const tw = textWidget(node);
    if (tw) {
      const orig = tw.callback;
      tw.callback = function (v) {
        const r = orig ? orig.apply(this, arguments) : undefined;
        const value = typeof v === 'string' ? v : tw.value;
        document.dispatchEvent(
          new CustomEvent('plv3:node-edited', { detail: { nodeId: node.id, value } }),
        );
        return r;
      };
    }

    // The Monaco node IS the editor: mount it now, and again after a graph load (which
    // re-adds the widgets, so re-mount if it went missing).
    if (isMonacoNode(node)) {
      mountEditor(node).catch((err) =>
        console.error('[PLv3] could not mount the embedded editor', err));

      const onConfigure = node.onConfigure;
      node.onConfigure = function (info) {
        const r = onConfigure?.apply(this, arguments);
        if (!this.__plv3Embed) {
          mountEditor(this).catch((err) =>
            console.error('[PLv3] could not restore the embedded editor', err));
        }
        return r;
      };

      // Dragging the node's corner resizes the editor with it. Reads node.size and
      // writes only to the container — never node.size back.
      const onResize = node.onResize;
      node.onResize = function (size) {
        const r = onResize?.apply(this, arguments);
        sizeEditor(this);
        return r;
      };

      // Deleting the node lets go of its editor and its share of the model. The model is
      // ref-counted, so it only truly disposes once the window has closed the node too.
      const onRemoved = node.onRemoved;
      node.onRemoved = function () {
        const r = onRemoved?.apply(this, arguments);
        const emb = this.__plv3Embed;
        if (emb) {
          document.removeEventListener('plv3:node-edited', emb.onExternalEdit);
          emb.pe.editor?.dispose();
          emb.pe.editor = null;
          releaseNodeModel(this.id);
          this.__plv3Embed = null;
        }
        return r;
      };
    }
  },
});
