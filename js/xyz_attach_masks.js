// XYZ Attach Masks — dynamic mask inputs, always exactly one spare slot.
//
// The backend declares mask_1..mask_16 as optional and appends the non-empty
// ones in slot order, so the attach order (= the IMASK index) is the visible
// order of the connected inputs. This file keeps that order gapless: unplugging
// a middle mask pulls the ones below it up, rather than leaving a hole that
// silently renumbers everything after it.

import { app } from '../../../scripts/app.js';

const NODE_TYPE = 'XYZ Attach Masks';
const MAX_MASKS = 16; // must match MAX_ATTACH_MASKS in mask_nodes/nodes.py

const isMask = (input) => input?.name?.startsWith('mask_');

// The label IS the IMASK index — `mask 0` is what you write as `imask: 0`. The
// underlying slot name stays mask_1.. (1-based) because that is what the backend
// reads; only the label is 0-based.
function relabel(node) {
  let i = 0;
  for (const input of node.inputs || []) {
    if (!isMask(input)) continue;
    input.label = `mask ${i}`;
    i++;
  }
}

function refresh(node) {
  if (node.__xyzBusy) return;
  node.__xyzBusy = true;
  try {
    // Where each connected mask comes from, in the order the backend will read it.
    const origins = [];
    for (const input of node.inputs || []) {
      if (!isMask(input) || input.link == null) continue;
      const link = app.graph.links[input.link];
      if (link) origins.push({ node: link.origin_id, slot: link.origin_slot });
    }

    for (let i = (node.inputs?.length || 0) - 1; i >= 0; i--) {
      if (isMask(node.inputs[i])) node.removeInput(i);
    }

    const wanted = Math.min(origins.length + 1, MAX_MASKS);
    for (let i = 1; i <= wanted; i++) node.addInput(`mask_${i}`, 'MASK');

    origins.forEach((origin, i) => {
      const source = app.graph.getNodeById(origin.node);
      if (source) source.connect(origin.slot, node, i + 1); // slot 0 is `clip`
    });

    relabel(node);
    // The node def declares all 16 optional slots, so LiteGraph sized the node
    // for 17 rows. Re-fit it to the slots that actually exist, keeping whatever
    // width the user has dragged it to.
    node.setSize([node.size[0], node.computeSize()[1]]);
    node.setDirtyCanvas(true, true);
  } finally {
    node.__xyzBusy = false;
  }
}

app.registerExtension({
  name: 'XYZNodes.AttachMasks',

  async nodeCreated(node) {
    if (node.comfyClass !== NODE_TYPE) return;

    // The node def carries all 16 optional slots; collapse them down to one
    // spare. A graph load re-adds whatever it needs via onConfigure -> refresh.
    refresh(node);

    const onConnectionsChange = node.onConnectionsChange;
    node.onConnectionsChange = function (type, index, connected, link, ioSlot) {
      const r = onConnectionsChange?.apply(this, arguments);
      if (!this.__xyzBusy) {
        // The link table is only consistent once LiteGraph finishes this event.
        setTimeout(() => refresh(this), 0);
      }
      return r;
    };

    const onConfigure = node.onConfigure;
    node.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);
      setTimeout(() => refresh(this), 0);
      return r;
    };
  },
});
