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
const SEND_NODE = 'XYZ Krita Send To Krita';
const OPEN_NODE = 'XYZ Krita Open File';

//: Nodes that pick a layer, and so need the layer list.
const LAYER_NODES = new Set([IMAGE_NODE, MASK_NODE, COLOR_NODE]);
//: Every node that talks to Krita — all of them get the Launch button.
const KRITA_NODES = new Set([...LAYER_NODES, SEND_NODE, OPEN_NODE]);

const PLACEHOLDER = '(click Refresh layers)';

// Fetch Color Masks emits `count` masks, so its output slots follow that widget.
// Unlike the Mask Editor there is nothing to key a link to but its index — the
// masks are ordered by colour, and colour N stays colour N as long as count does
// not shrink past it. So: grow freely, and on shrink only the dropped tail loses
// its links.
function colorCount(node) {
  return Math.max(0, Math.round(node.widgets?.find((w) => w.name === 'count')?.value ?? 0));
}

function syncColorOutputs(node) {
  const wanted = colorCount(node);

  while ((node.outputs?.length ?? 0) > wanted) {
    node.removeOutput(node.outputs.length - 1);
  }
  while ((node.outputs?.length ?? 0) < wanted) {
    node.addOutput(`mask_${node.outputs.length}`, 'MASK');
  }
  node.setDirtyCanvas(true, true);
}

const MAX_COLOR_MASKS = 16; // must match MAX_COLOR_MASKS in krita_nodes/nodes.py
const isFallback = (input) => input?.name?.startsWith('fallback_');

// One fallback MASK input per output slot, so a closed Krita can be stood in for
// slot by slot. The backend declares all 16 (ComfyUI validates connections), so
// LiteGraph builds 16; this trims them to `count`. Slots are POSITIONAL —
// fallback_i is output mask_i — so unlike Attach Masks there is no compaction: an
// index keeps its link across a resize, and shrinking past it drops only that tail.
function syncColorFallbackInputs(node) {
  if (node.__xyzBusy) return;
  node.__xyzBusy = true;
  try {
    const wanted = colorCount(node);

    // Remember each fallback link by its index, so a resize keeps the wiring.
    const saved = new Map();
    for (const input of node.inputs || []) {
      if (!isFallback(input) || input.link == null) continue;
      const m = /^fallback_(\d+)$/.exec(input.name);
      const link = app.graph.links[input.link];
      if (m && link) saved.set(Number(m[1]), link);
    }

    for (let i = (node.inputs?.length || 0) - 1; i >= 0; i--) {
      if (isFallback(node.inputs[i])) node.removeInput(i);
    }
    for (let i = 0; i < Math.min(wanted, MAX_COLOR_MASKS); i++) {
      node.addInput(`fallback_${i}`, 'MASK');
      node.inputs[node.inputs.length - 1].label = `fallback ${i}`;
    }

    for (const [idx, link] of saved) {
      if (idx >= wanted) continue; // its slot no longer exists
      const source = app.graph.getNodeById(link.origin_id);
      const slot = node.inputs.findIndex((inp) => inp.name === `fallback_${idx}`);
      if (source && slot >= 0) source.connect(link.origin_slot, node, slot);
    }

    // The node def declares all 16 fallback slots; re-fit the node to the ones that
    // now exist, keeping the width the user has dragged it to.
    node.setSize([node.size[0], node.computeSize()[1]]);
    node.setDirtyCanvas(true, true);
  } finally {
    node.__xyzBusy = false;
  }
}

// One fetch serves every Krita node on the canvas — clicking refresh on one
// should not leave the others stale.
async function loadLayers() {
  const response = await api.fetchApi('/xyz/krita/layers');
  const data = await response.json();
  if (!response.ok || !data.ok) {
    const error = new Error(data.error || `layer list failed (${response.status})`);
    // 503 means we never reached Krita; anything else means Krita answered and
    // said no ("no open document"). Telling the user Krita is not running when it
    // is sends them off fixing the wrong thing.
    error.unreachable = response.status === 503;
    throw error;
  }
  return data;
}

const BUTTON_LIMIT = 34;

function failureLabel(error) {
  if (error.unreachable) return 'Krita not running — see console';
  const message = String(error.message || 'failed');
  return message.length <= BUTTON_LIMIT
    ? message
    : `${message.slice(0, BUTTON_LIMIT - 1)}…`;
}

// The layer list comes from Krita, so it is NOT serialised with the graph — only
// the chosen value is. After a reload the combo would hold a valid value but
// offer nothing but the placeholder, and opening the dropdown would throw the
// user's choice away. Keep the current value in the list, always.
function keepCurrentValueListed(widget) {
  if (!widget) return;
  const values = widget.options.values;
  if (widget.value && widget.value !== PLACEHOLDER && !values.includes(widget.value)) {
    values.unshift(widget.value);
  }
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

  widget.options.values = entries.length ? [...entries] : [PLACEHOLDER];

  // If the chosen layer is gone from Krita, KEEP the dead value rather than
  // snapping to whatever is first. Silently generating against a different layer
  // is far worse than failing: the run will now stop with "layer ... is not in
  // this document", which says exactly what happened.
  keepCurrentValueListed(widget);
  node.setDirtyCanvas(true, true);
}

function refreshAll(data) {
  for (const node of app.graph?._nodes ?? []) {
    if (LAYER_NODES.has(node.comfyClass)) applyLayers(node, data);
  }
}

// A widget button whose label reports what happened, then goes back to normal.
// Never alert() — it blocks ComfyUI's whole main thread.
function transientLabel(node, button, text, ms = 4000) {
  const original = button.__xyzLabel;
  button.name = text;
  node.setDirtyCanvas(true, true);
  clearTimeout(button.__xyzTimer);
  button.__xyzTimer = setTimeout(() => {
    button.name = original;
    node.setDirtyCanvas(true, true);
  }, ms);
}

async function launchKrita() {
  const response = await api.fetchApi('/xyz/krita/launch', { method: 'POST' });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `could not start Krita (${response.status})`);
  }
  return data;
}

app.registerExtension({
  name: 'XYZNodes.Krita',

  async nodeCreated(node) {
    if (!KRITA_NODES.has(node.comfyClass)) return;

    // Krita takes ~20s to start, so this button waits for the bridge rather than
    // returning the moment the process exists.
    const launch = node.addWidget('button', 'Launch Krita', null, async () => {
      launch.name = 'Starting Krita…';
      node.setDirtyCanvas(true, true);
      try {
        const data = await launchKrita();
        const doc = data.document;
        transientLabel(
          node,
          launch,
          data.launched
            ? doc
              ? `Krita up — ${doc.width}x${doc.height}`
              : 'Krita up — no document'
            : 'Krita was already running',
        );
      } catch (err) {
        console.error('[XYZ Krita]', err);
        transientLabel(node, launch, failureLabel(err));
      }
    });
    launch.__xyzLabel = 'Launch Krita';

    if (!LAYER_NODES.has(node.comfyClass)) return;

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
        button.name = failureLabel(err);
        setTimeout(() => {
          button.name = original;
          node.setDirtyCanvas(true, true);
        }, 4000);
      }
      node.setDirtyCanvas(true, true);
    });
    // A graph load restores the widget's value after nodeCreated. Put it back in
    // the dropdown, or the user's saved layer vanishes the moment they open it.
    const onConfigureLayer = node.onConfigure;
    node.onConfigure = function (info) {
      const result = onConfigureLayer?.apply(this, arguments);
      keepCurrentValueListed(this.widgets?.find((w) => w.name === 'layer'));
      return result;
    };

    if (node.comfyClass !== COLOR_NODE) return;

    // The backend declares one MASK output (ByPassTypeTuple covers the rest);
    // `count` decides how many there really are.
    const countWidget = node.widgets?.find((w) => w.name === 'count');
    if (countWidget) {
      const original = countWidget.callback;
      countWidget.callback = function (...args) {
        const result = original?.apply(this, args);
        syncColorOutputs(node);
        syncColorFallbackInputs(node);
        return result;
      };
    }
    syncColorOutputs(node);
    syncColorFallbackInputs(node);

    const onConfigure = node.onConfigure;
    node.onConfigure = function (info) {
      const result = onConfigure?.apply(this, arguments);
      // A saved graph already carries the right slots and links; only rebuild if
      // they disagree with `count`.
      syncColorOutputs(this);
      // The saved graph restores its fallback links; rebuild after LiteGraph has
      // finished wiring them so this can carry them across the resize.
      setTimeout(() => syncColorFallbackInputs(this), 0);
      return result;
    };
  },
});
