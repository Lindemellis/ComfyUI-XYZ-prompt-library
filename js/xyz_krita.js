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
const KRITA_NODES = new Set([IMAGE_NODE, MASK_NODE]);

const PLACEHOLDER = '(click Refresh layers)';
const ROW_H = 30;

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
    node.comfyClass === IMAGE_NODE ? data.image_entries : data.mask_entries;

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
  },
});
