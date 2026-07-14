// XYZ Mask Editor — a 512x512 rectangle canvas with one MASK output per rect.
//
// Slot layout (fixed by the backend):  0 = base, 1 = fill, 2.. = the rects.
// Rectangles are stored normalised (0..1) in the hidden `rects` widget, which is
// the single source of truth — the canvas, the list and the output slots are all
// views onto it.

import { app } from '../../../scripts/app.js';

const NODE_TYPE = 'XYZ Mask Editor';
const CANVAS = 512;      // the backing store; also the unit `feather` is in
const FIXED_OUTPUTS = 3; // preview (IMAGE), base, fill

const COLORS = [
  '#f38ba8', '#89b4fa', '#a6e3a1', '#f9e2af', '#cba6f7',
  '#94e2d5', '#fab387', '#74c7ec', '#eba0ac', '#b4befe',
];
const colorOf = (i) => COLORS[i % COLORS.length];

const HANDLES = [
  ['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0],
  ['w', 0, 0.5], ['e', 1, 0.5],
  ['sw', 0, 1], ['s', 0.5, 1], ['se', 1, 1],
];
const HANDLE_PX = 8;   // hit radius, in canvas units
const MIN_SIZE = 0.02; // a rect may not be dragged smaller than this

// Node geometry.
//
// The node is freely resizable and the canvas grows into whatever room it is
// given. The one rule that must never be broken: **nothing that feeds the node's
// height may itself be derived from the node's height or from a measured element
// size.** A node's height is the sum of its widgets' heights, so a widget that
// reports back what it was given is a feedback loop — that is how this node once
// reached 1,100,044 px. So:
//
//   node height  -> element height -> canvas size     (a ResizeObserver, one-way)
//   rect count   -> the widget's MINIMUM height       (computeSize, one-way)
//
// The ResizeObserver only ever writes to the canvas, never to node.size.
const DEFAULT_WIDTH = 360;
const MIN_CANVAS = 160;      // how far the node may be shrunk
const DEFAULT_CANVAS = 320;  // on-screen size at creation; the backing store is always 512
const CANVAS_MARGIN = 24;    // horizontal padding ComfyUI leaves around a DOM widget
const MAX_SANE_HEIGHT = 4000;
const HINT_H = 16;
const ROW_H = 26;
const ROW_GAP = 4;
const GAP = 6;
const EMPTY_LIST_H = 20;

const listHeight = (n) => (n ? n * ROW_H + (n - 1) * ROW_GAP : EMPTY_LIST_H);
// The list grows with the rects instead of scrolling — a scrollbar hides the
// masks you are trying to compare.
const chromeHeight = (n) => GAP + HINT_H + GAP + listHeight(n) + 6;
const minWidgetHeight = (n) => MIN_CANVAS + chromeHeight(n);

let nextId = 1;
const freshId = () => `r${Date.now().toString(36)}${nextId++}`;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// A rect has no name: the slot name IS its IMASK index, counted from 0, derived
// from its position in the list. Delete one and the rest renumber themselves.
const slotName = (i) => `mask_${i}`;

// ---------------------------------------------------------------- state <-> widget

function readRects(node) {
  const w = node.widgets?.find((x) => x.name === 'rects');
  let data;
  try {
    data = JSON.parse(w?.value || '[]');
  } catch {
    data = [];
  }
  if (!Array.isArray(data)) data = [];
  return data
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      id: String(r.id || freshId()),
      x: clamp01(Number(r.x) || 0),
      y: clamp01(Number(r.y) || 0),
      w: clamp01(Number(r.w) || 0),
      h: clamp01(Number(r.h) || 0),
      feather: Math.max(0, Number(r.feather) || 0),
    }))
    .filter((r) => r.w > 0 && r.h > 0);
}

function writeRects(node, rects) {
  const w = node.widgets?.find((x) => x.name === 'rects');
  if (!w) return;
  w.value = JSON.stringify(rects);
  w.callback?.(w.value);
}

// ---------------------------------------------------------------- output slots

// Rebuild the mask outputs to match `rects`, carrying every link with its
// rectangle. ComfyUI links are addressed by slot index, so deleting rect #2
// would otherwise silently re-point rect #3's link at rect #2's mask.
function syncOutputs(node, rects) {
  const ids = rects.map((r) => r.id);
  const prev = node.__xyzSlotIds || [];
  const sameShape =
    prev.length === ids.length &&
    prev.every((id, i) => id === ids[i]) &&
    (node.outputs?.length || 0) === FIXED_OUTPUTS + ids.length;

  if (sameShape) return;  // slot names are positional, so nothing to refresh

  // Remember where each rect's links went, keyed by rect id rather than slot.
  const saved = new Map();
  const outputs = node.outputs || [];
  for (let i = FIXED_OUTPUTS; i < outputs.length; i++) {
    const id = prev[i - FIXED_OUTPUTS];
    const links = outputs[i].links || [];
    if (!id || !links.length) continue;
    const targets = [];
    for (const lid of links) {
      const link = app.graph.links[lid];
      if (link) targets.push({ node: link.target_id, slot: link.target_slot });
    }
    if (targets.length) saved.set(id, targets);
  }

  while ((node.outputs?.length || 0) > FIXED_OUTPUTS) {
    node.removeOutput(node.outputs.length - 1);
  }
  rects.forEach((_, i) => node.addOutput(slotName(i), 'MASK'));
  node.__xyzSlotIds = ids;

  rects.forEach((r, i) => {
    const targets = saved.get(r.id);
    if (!targets) return;
    for (const t of targets) {
      const target = app.graph.getNodeById(t.node);
      if (target) node.connect(FIXED_OUTPUTS + i, target, t.slot);
    }
  });

  node.setDirtyCanvas(true, true);
}

// ---------------------------------------------------------------- canvas

function draw(ctx, rects, selectedId) {
  ctx.clearRect(0, 0, CANVAS, CANVAS);

  ctx.fillStyle = '#1e1e2e';
  ctx.fillRect(0, 0, CANVAS, CANVAS);

  ctx.strokeStyle = 'rgba(205, 214, 244, 0.08)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const p = (CANVAS / 4) * i;
    ctx.beginPath();
    ctx.moveTo(p, 0); ctx.lineTo(p, CANVAS);
    ctx.moveTo(0, p); ctx.lineTo(CANVAS, p);
    ctx.stroke();
  }

  rects.forEach((r, i) => {
    const x = r.x * CANVAS, y = r.y * CANVAS;
    const w = r.w * CANVAS, h = r.h * CANVAS;
    const color = colorOf(i);
    const selected = r.id === selectedId;

    ctx.fillStyle = color + '38';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = color;
    ctx.lineWidth = selected ? 3 : 2;
    ctx.strokeRect(x, y, w, h);

    // The feather ramp reaches 1 here — everything outside it is a gradient.
    const f = Math.min(r.feather, Math.min(w, h) / 2);
    if (f > 0) {
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.strokeRect(x + f, y + f, w - 2 * f, h - 2 * f);
      ctx.setLineDash([]);
    }

    // The index is the whole label — it is what you write as `imask: i`.
    ctx.fillStyle = color;
    ctx.font = 'bold 15px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(String(i), x + 6, y + 19);

    if (selected) {
      ctx.fillStyle = color;
      for (const [, hx, hy] of HANDLES) {
        ctx.fillRect(x + w * hx - HANDLE_PX / 2, y + h * hy - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
      }
    }
  });
}

function handleAt(rect, cx, cy) {
  const x = rect.x * CANVAS, y = rect.y * CANVAS;
  const w = rect.w * CANVAS, h = rect.h * CANVAS;
  for (const [name, hx, hy] of HANDLES) {
    const px = x + w * hx, py = y + h * hy;
    if (Math.abs(cx - px) <= HANDLE_PX && Math.abs(cy - py) <= HANDLE_PX) return name;
  }
  return null;
}

const inside = (r, cx, cy) =>
  cx >= r.x * CANVAS && cx <= (r.x + r.w) * CANVAS &&
  cy >= r.y * CANVAS && cy <= (r.y + r.h) * CANVAS;

// ---------------------------------------------------------------- the widget

// Keep the node inside sane bounds without taking its height away from the user.
// The upper clamp is a repair path: a workflow saved while the runaway-growth bug
// was live carries a serialised height of ~1.1 million px, and without this it
// would restore that forever.
function clampNode(node, rectCount) {
  if (node.__xyzFitting) return;
  node.__xyzFitting = true;
  const min = node.computeSize()[1];
  const h = node.size[1];
  const height = h > MAX_SANE_HEIGHT || h < min
    ? Math.min(Math.max(h, min), MAX_SANE_HEIGHT)
    : h;
  node.setSize([Math.max(MIN_CANVAS + 40, node.size[0]), height]);
  node.__xyzFitting = false;
}

function buildUI(node) {
  const root = document.createElement('div');
  root.style.cssText = `display:flex;flex-direction:column;align-items:center;
    gap:${GAP}px;width:100%;box-sizing:border-box;
    font-family:ui-sans-serif,system-ui,sans-serif;font-size:12px;color:#cdd6f4;`;

  // Sized by the ResizeObserver below — it grows into whatever room the node has.
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS;
  canvas.height = CANVAS;
  canvas.tabIndex = 0;
  canvas.style.cssText = `width:${DEFAULT_CANVAS}px;height:${DEFAULT_CANVAS}px;
    flex:0 0 auto;border-radius:6px;border:1px solid #45475a;cursor:crosshair;
    touch-action:none;outline:none;`;
  root.append(canvas);

  const hint = document.createElement('div');
  hint.style.cssText = `color:#7f849c;height:${HINT_H}px;line-height:${HINT_H}px;
    flex:0 0 auto;white-space:nowrap;`;
  hint.textContent = 'Drag to draw · click to select · Delete to remove';
  root.append(hint);

  const list = document.createElement('div');
  list.style.cssText = `display:flex;flex-direction:column;gap:${ROW_GAP}px;
    flex:0 0 auto;width:100%;box-sizing:border-box;`;
  root.append(list);

  const ctx = canvas.getContext('2d');
  let rects = readRects(node);
  let selectedId = null;
  let rows = [];  // one entry per rect, kept in step with `rects`

  // Fit the canvas to the room the node currently gives us.
  //
  // This reads node.size and writes ONLY to the canvas — one-way, so it is not
  // the feedback loop. It cannot measure the DOM instead: this ComfyUI never
  // gives the dom-widget wrapper a height (it is position:fixed and 0px tall,
  // the content simply overflows it), so every element here measures 0.
  function sizeCanvas() {
    const header =
      LiteGraph.NODE_TITLE_HEIGHT +
      (FIXED_OUTPUTS + rects.length) * LiteGraph.NODE_SLOT_HEIGHT +
      GAP;
    const spare = node.size[1] - header - chromeHeight(rects.length);
    const side = Math.max(
      MIN_CANVAS,
      Math.floor(Math.min(node.size[0] - CANVAS_MARGIN, spare)),
    );
    if (Math.round(parseFloat(canvas.style.width)) === side) return;
    canvas.style.width = `${side}px`;
    canvas.style.height = `${side}px`;
  }
  node.__xyzSizeCanvas = sizeCanvas;

  // Adding a rect makes the list taller. Give the node that extra height rather
  // than letting the list eat the canvas. rect count -> node height, one-way.
  let lastListH = listHeight(rects.length);
  function layout() {
    node.__xyzMinH = minWidgetHeight(rects.length);
    const delta = listHeight(rects.length) - lastListH;
    lastListH = listHeight(rects.length);
    if (delta && !node.__xyzFitting) {
      node.__xyzFitting = true;
      node.setSize([node.size[0], node.size[1] + delta]);
      node.__xyzFitting = false;
    }
    clampNode(node, rects.length);
    sizeCanvas();
  }

  const commit = ({ outputs = true, rebuild = true } = {}) => {
    writeRects(node, rects);
    if (outputs) syncOutputs(node, rects);
    if (rebuild) rebuildList();
    draw(ctx, rects, selectedId);
  };

  // Selection is a style change, NOT a rebuild. Rebuilding here is what made the
  // name and feather boxes uneditable: clicking one selected the row, the row
  // rebuilt, and the input you had just focused was destroyed mid-click.
  function paintSelection() {
    rows.forEach(({ row, rect }, i) => {
      const on = rect.id === selectedId;
      row.style.background = on ? '#313244' : '#252537';
      row.style.borderColor = on ? colorOf(i) : 'transparent';
    });
  }

  // An <input> inside a DOM widget still sits over LiteGraph's canvas, which
  // treats pointerdown as "start dragging the node" and keydown as a shortcut.
  function keepEventsLocal(el) {
    for (const type of ['pointerdown', 'mousedown', 'keydown', 'keyup', 'wheel']) {
      el.addEventListener(type, (e) => e.stopPropagation());
    }
  }

  function rebuildList() {
    list.replaceChildren();
    rows = [];

    rects.forEach((r, i) => {
      const row = document.createElement('div');
      row.style.cssText = `display:flex;align-items:center;gap:6px;padding:0 6px;
        height:${ROW_H}px;box-sizing:border-box;border-radius:5px;
        border:1px solid transparent;cursor:pointer;`;
      // Only the inert parts of the row select it; clicks on the inputs and the
      // delete button are theirs alone.
      row.addEventListener('pointerdown', (e) => {
        if (e.target !== row && e.target !== dot && e.target !== idx) return;
        selectedId = r.id;
        paintSelection();
        draw(ctx, rects, selectedId);
      });

      const dot = document.createElement('span');
      dot.style.cssText = `width:10px;height:10px;border-radius:2px;flex:0 0 auto;
        background:${colorOf(i)};`;
      row.append(dot);

      const idx = document.createElement('span');
      idx.textContent = slotName(i);
      idx.title = 'The IMASK index this rect gets — provided you wire the masks into ' +
        'XYZ Attach Masks in order and leave base/fill unconnected.';
      idx.style.cssText = `color:#cdd6f4;flex:1 1 auto;min-width:0;
        font-variant-numeric:tabular-nums;`;
      row.append(idx);

      const featherLabel = document.createElement('span');
      featherLabel.textContent = 'feather';
      featherLabel.style.cssText = 'color:#7f849c;flex:0 0 auto;';
      row.append(featherLabel);

      const feather = document.createElement('input');
      feather.type = 'number';
      feather.min = '0';
      feather.step = '1';
      feather.value = String(r.feather);
      feather.title = 'Feather, in pixels of the 512 canvas. Fades inwards from the edge.';
      feather.style.cssText = `width:52px;flex:0 0 auto;height:20px;background:#1e1e2e;
        color:#cdd6f4;border:1px solid #45475a;border-radius:4px;padding:0 5px;
        font:inherit;box-sizing:border-box;`;
      keepEventsLocal(feather);
      feather.addEventListener('input', () => {
        r.feather = Math.max(0, Number(feather.value) || 0);
        writeRects(node, rects);
        draw(ctx, rects, selectedId);
      });
      row.append(feather);

      const del = document.createElement('button');
      del.textContent = '×';
      del.title = 'Delete';
      del.style.cssText = `flex:0 0 auto;width:20px;height:20px;line-height:1;padding:0;
        border-radius:4px;border:1px solid #45475a;background:#313244;color:#f38ba8;
        cursor:pointer;font-size:14px;`;
      keepEventsLocal(del);
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        rects = rects.filter((x) => x.id !== r.id);
        if (selectedId === r.id) selectedId = null;
        commit();
      });
      row.append(del);

      list.append(row);
      rows.push({ row, rect: r });
    });

    if (!rects.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No rectangles yet.';
      empty.style.cssText = `color:#585b70;height:${EMPTY_LIST_H}px;padding:0 6px;`;
      list.append(empty);
    }

    paintSelection();
    layout();
  }

  function render() {
    draw(ctx, rects, selectedId);
    rebuildList();
  }

  // -------------------------------------------------- pointer

  const toCanvas = (e) => {
    const box = canvas.getBoundingClientRect();
    return [
      ((e.clientX - box.left) / box.width) * CANVAS,
      ((e.clientY - box.top) / box.height) * CANVAS,
    ];
  };

  let drag = null;

  canvas.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    canvas.focus();
    const [cx, cy] = toCanvas(e);

    const sel = rects.find((r) => r.id === selectedId);
    const grip = sel ? handleAt(sel, cx, cy) : null;
    if (sel && grip) {
      drag = { mode: 'resize', grip, rect: sel, start: { ...sel } };
    } else {
      // Topmost first: the last-drawn rect wins an overlap.
      const hit = [...rects].reverse().find((r) => inside(r, cx, cy));
      if (hit) {
        selectedId = hit.id;
        drag = { mode: 'move', rect: hit, start: { ...hit }, ox: cx, oy: cy };
      } else {
        const rect = {
          id: freshId(),
          x: cx / CANVAS, y: cy / CANVAS, w: 0, h: 0,
          feather: 0,
        };
        rects.push(rect);
        selectedId = rect.id;
        drag = { mode: 'create', rect, ox: cx, oy: cy };
      }
    }
    // Throws NotFoundError if the pointer is not active (a synthetic event, or
    // a pointer that vanished mid-gesture). The drag still works without it.
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {}
    render();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    e.stopPropagation();
    const [cx, cy] = toCanvas(e);
    const r = drag.rect;

    if (drag.mode === 'create') {
      const x0 = Math.min(drag.ox, cx), x1 = Math.max(drag.ox, cx);
      const y0 = Math.min(drag.oy, cy), y1 = Math.max(drag.oy, cy);
      r.x = clamp01(x0 / CANVAS); r.y = clamp01(y0 / CANVAS);
      r.w = clamp01(x1 / CANVAS) - r.x; r.h = clamp01(y1 / CANVAS) - r.y;
    } else if (drag.mode === 'move') {
      const dx = (cx - drag.ox) / CANVAS, dy = (cy - drag.oy) / CANVAS;
      r.x = Math.min(1 - drag.start.w, Math.max(0, drag.start.x + dx));
      r.y = Math.min(1 - drag.start.h, Math.max(0, drag.start.y + dy));
    } else {
      const s = drag.start;
      let x0 = s.x, y0 = s.y, x1 = s.x + s.w, y1 = s.y + s.h;
      const nx = clamp01(cx / CANVAS), ny = clamp01(cy / CANVAS);
      if (drag.grip.includes('w')) x0 = Math.min(nx, x1 - MIN_SIZE);
      if (drag.grip.includes('e')) x1 = Math.max(nx, x0 + MIN_SIZE);
      if (drag.grip.includes('n')) y0 = Math.min(ny, y1 - MIN_SIZE);
      if (drag.grip.includes('s')) y1 = Math.max(ny, y0 + MIN_SIZE);
      r.x = x0; r.y = y0; r.w = x1 - x0; r.h = y1 - y0;
    }
    draw(ctx, rects, selectedId);
  });

  const endDrag = (e) => {
    if (!drag) return;
    e?.stopPropagation();
    const r = drag.rect;
    const born = drag.mode === 'create';
    drag = null;

    if (r.w < MIN_SIZE || r.h < MIN_SIZE) {
      if (born) {
        // A click on empty space, not a drag — don't leave a sliver behind.
        rects = rects.filter((x) => x.id !== r.id);
        selectedId = null;
        writeRects(node, rects);
        render();
        return;
      }
      r.w = Math.max(r.w, MIN_SIZE);
      r.h = Math.max(r.h, MIN_SIZE);
    }
    // Only a create/delete changes the slot count; a move/resize just redraws.
    commit({ outputs: born });
  };

  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('keydown', (e) => {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (!selectedId) return;
    e.preventDefault();
    e.stopPropagation();
    rects = rects.filter((r) => r.id !== selectedId);
    selectedId = null;
    commit();
  });

  // ComfyUI listens for copy/cut/paste on the window and would hijack them into
  // its node clipboard while the user is editing a rect's name.
  for (const type of ['copy', 'cut', 'paste']) {
    root.addEventListener(type, (e) => e.stopPropagation());
  }

  node.__xyzSlotIds = rects.map((r) => r.id);
  // A graph load rewrites the `rects` widget behind our back; the closure's copy
  // is stale until we re-read it.
  node.__xyzReload = () => {
    rects = readRects(node);
    selectedId = null;
    node.__xyzSlotIds = rects.map((r) => r.id);
    render();
  };
  render();

  return root;
}

// ---------------------------------------------------------------- extension

app.registerExtension({
  name: 'XYZNodes.MaskEditor',

  async nodeCreated(node) {
    if (node.comfyClass !== NODE_TYPE) return;
    node.serialize_widgets = true;

    const rectsWidget = node.widgets?.find((w) => w.name === 'rects');
    if (rectsWidget) {
      rectsWidget.hidden = true;
      rectsWidget.type = 'converted-widget';
      rectsWidget.computeSize = () => [0, -4];
    }

    // The backend declares slot 0 only (ByPassTypeTuple stands in for the rest);
    // the real slots and their real types are added here.
    const FIXED = [
      ['preview', 'IMAGE'],
      ['base', 'MASK'],
      ['fill', 'MASK'],
    ];
    for (let i = node.outputs?.length ?? 0; i < FIXED.length; i++) {
      node.addOutput(FIXED[i][0], FIXED[i][1]);
    }

    const ui = buildUI(node);
    const w = node.addDOMWidget('xyz_mask_canvas', 'custom', ui, {
      getValue: () => '',
      setValue: () => {},
      serialize: false,
    });
    // The MINIMUM, from the rect count alone — never from the node's own size.
    // LiteGraph treats computeSize as the floor, so the user can drag the node
    // taller and the canvas grows into the space (see sizeCanvas).
    w.computeSize = (width) => [
      width || node.size[0],
      node.__xyzMinH ?? minWidgetHeight(0),
    ];
    // Let the Vue renderer stretch this widget to fill the node — that is what
    // makes the drag-to-resize actually reach the canvas.
    w.computeLayoutSize = () => ({
      minHeight: node.__xyzMinH ?? minWidgetHeight(0),
      minWidth: MIN_CANVAS,
    });

    // Open at DEFAULT_CANVAS rather than the MIN_CANVAS floor computeSize reports.
    node.setSize([
      DEFAULT_WIDTH,
      node.computeSize()[1] + (DEFAULT_CANVAS - MIN_CANVAS),
    ]);
    node.__xyzSizeCanvas?.();

    // A graph load restores widget values after nodeCreated; re-read then.
    const onConfigure = node.onConfigure;
    node.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);
      // The saved graph already carries the right output slots and links — only
      // the canvas needs catching up, so don't call syncOutputs here.
      this.__xyzReload?.();
      clampNode(this);
      this.__xyzSizeCanvas?.();
      return r;
    };

    // Dragging the node's corner resizes the canvas with it. This handler only
    // READS node.size and writes to the canvas — it must never write node.size
    // back, which is the loop that blew the node up to 1.1 million pixels.
    const onResize = node.onResize;
    node.onResize = function (size) {
      const r = onResize?.apply(this, arguments);
      this.__xyzSizeCanvas?.();
      return r;
    };
  },
});
