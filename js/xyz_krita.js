// XYZ Krita nodes — fill the `layer` combo from the running Krita.
//
// The backend cannot populate this combo itself: INPUT_TYPES runs when ComfyUI
// builds /object_info, which happens at startup, and asking Krita there would
// hang the whole frontend load whenever Krita is closed. So the combo ships with
// a placeholder and this button fills it in on demand. The backend accepts the
// values because both nodes declare VALIDATE_INPUTS (see krita_nodes/nodes.py).

import { app } from '../../../scripts/app.js';
import { api } from '../../../scripts/api.js';

const IMAGE_NODE = 'XYZ Krita Fetch Image';
const MASK_NODE = 'XYZ Krita Fetch Mask';
const COLOR_NODE = 'XYZ Krita Fetch Color Masks';
const KRITA_NODES = new Set([IMAGE_NODE, MASK_NODE, COLOR_NODE]);

const PLACEHOLDER = '(click Refresh layers)';
const ROW_H = 30;

// Fetch Color Masks emits `count` masks, so its output slots follow that widget.
// Unlike the Mask Editor there is nothing to key a link to but its index — the
// masks are ordered by colour, and colour N stays colour N as long as count does
// not shrink past it. So: grow freely, and on shrink only the dropped tail loses
// its links.
function syncColorOutputs(node) {
  const count = node.widgets?.find((w) => w.name === 'count')?.value ?? 0;
  const wanted = Math.max(0, Math.round(count));

  while ((node.outputs?.length ?? 0) > wanted) {
    node.removeOutput(node.outputs.length - 1);
  }
  while ((node.outputs?.length ?? 0) < wanted) {
    node.addOutput(`mask_${node.outputs.length}`, 'MASK');
  }
  node.setDirtyCanvas(true, true);
}

// One fetch serves every Krita node on the canvas — clicking refresh on one
// should not leave the others stale.
async function loadLayers() {
  const response = await api.fetchApi('/xyz/krita/layers');
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `layer list failed (${response.status})`);
  }
  return data;
}

function applyLayers(node, data) {
  const widget = node.widgets?.find((w) => w.name === 'layer');
  if (!widget) return;

  const entries =
    node.comfyClass === IMAGE_NODE
      ? data.image_entries
      : node.comfyClass === COLOR_NODE
        ? data.paint_entries // a colour split only makes sense on a painted layer
        : data.mask_entries;

  widget.options.values = entries.length ? entries : [PLACEHOLDER];
  // Keep the current pick if that layer still exists — a refresh should not
  // silently repoint the node at a different layer.
  if (!widget.options.values.includes(widget.value)) {
    widget.value = widget.options.values[0];
  }
  node.setDirtyCanvas(true, true);
}

function refreshAll(data) {
  for (const node of app.graph?._nodes ?? []) {
    if (KRITA_NODES.has(node.comfyClass)) applyLayers(node, data);
  }
}

app.registerExtension({
  name: 'XYZNodes.Krita',

  async nodeCreated(node) {
    if (!KRITA_NODES.has(node.comfyClass)) return;

    const button = node.addWidget('button', 'Refresh layers', null, async () => {
      const original = button.name;
      button.name = 'Asking Krita…';
      node.setDirtyCanvas(true, true);
      try {
        const data = await loadLayers();
        refreshAll(data);
        const doc = data.document;
        // An imported/untitled document has an empty name — don't render a label
        // that is just whitespace and a size.
        const title = doc?.name?.trim() || 'untitled';
        button.name = doc
          ? `${title} — ${doc.width}x${doc.height}`
          : 'No document open';
        setTimeout(() => {
          button.name = original;
          node.setDirtyCanvas(true, true);
        }, 3000);
      } catch (err) {
        // Never alert() — it blocks ComfyUI's whole main thread. Report on the
        // button, where the user is already looking, and log the detail.
        console.error('[XYZ Krita]', err);
        button.name = 'Krita unreachable — see console';
        setTimeout(() => {
          button.name = original;
          node.setDirtyCanvas(true, true);
        }, 4000);
      }
      node.setDirtyCanvas(true, true);
    });
    button.computeSize = () => [node.size[0], ROW_H];
    button.computeLayoutSize = undefined;

    if (node.comfyClass !== COLOR_NODE) return;

    // The backend declares one MASK output (ByPassTypeTuple covers the rest);
    // `count` decides how many there really are.
    const countWidget = node.widgets?.find((w) => w.name === 'count');
    if (countWidget) {
      const original = countWidget.callback;
      countWidget.callback = function (...args) {
        const result = original?.apply(this, args);
        syncColorOutputs(node);
        return result;
      };
    }
    syncColorOutputs(node);

    const onConfigure = node.onConfigure;
    node.onConfigure = function (info) {
      const result = onConfigure?.apply(this, arguments);
      // A saved graph already carries the right slots and links; only rebuild if
      // they disagree with `count`.
      syncColorOutputs(this);
      return result;
    };
  },
});
