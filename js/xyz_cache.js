// XYZ Cache Slot nodes — a preview on Read, a slot browser, and Create on Write.
//
// The slot list is on local disk, so it is cheap to re-read and we do it often:
// ComfyUI builds the combo's values once at startup, and a slot written or created
// during the session would otherwise be invisible until you reloaded the page.

import { app } from '../../../scripts/app.js';
import { api } from '../../../scripts/api.js';

const READ_NODE = 'XYZ Cache Slot Read';
const WRITE_NODE = 'XYZ Cache Slot Write';
const CACHE_NODES = new Set([READ_NODE, WRITE_NODE]);

const NO_SLOTS = '(no slots yet — write one first)';

// The preview grows with the node. The one rule that must not be broken: **the
// height the widget REPORTS may never be derived from the node's height.** A
// node's height is the sum of its widgets' heights, so a widget that reports back
// what it was given is a feedback loop — that is how the Mask Editor once reached
// 1,100,044 px. So computeSize returns a constant FLOOR, and the height is derived
// from the node's WIDTH and the picture's shape — never from the node's height.
//
// The preview is also the LAST widget on purpose: a DOM element that grows past
// the row it was given would otherwise sit on top of whatever came after it (it
// used to overlap 'Browse slots').
const MIN_PREVIEW = 90;
const MAX_PREVIEW = 1400;
const PREVIEW_PAD = 8;
//: Horizontal padding ComfyUI leaves around a DOM widget.
const PREVIEW_INSET = 20;
//: What to assume before we know the picture's shape.
const DEFAULT_ASPECT = 4 / 3;

//: Everything above the preview: the title, the output slots, and the two widget
//: rows (the slot combo and the Browse button).
function spaceAbovePreview(node) {
  const rows = 2 * (LiteGraph.NODE_WIDGET_HEIGHT + 4);
  return (
    LiteGraph.NODE_TITLE_HEIGHT +
    (node.outputs?.length ?? 0) * LiteGraph.NODE_SLOT_HEIGHT +
    rows +
    PREVIEW_PAD
  );
}

//: The shape of the picture in the chosen slot, from the slot list — no need to
//: wait for the <img> to decode.
function slotAspect(node) {
  const slot = node.widgets?.find((w) => w.name === 'slot')?.value;
  const record = (node.__xyzSlots ?? []).find((s) => s.name === slot);
  if (!record?.has_image || !record.width || !record.height) return DEFAULT_ASPECT;
  return record.width / record.height;
}

// The preview box takes the SHAPE of the picture, so the image fills it edge to
// edge — `object-fit: contain` in a box of the wrong shape just grows the black
// bars, which is what made a wide picture look tiny in a tall node.
//
// Width drives height, and the node's height follows. That direction matters:
// width is the user's, height is derived, and nothing derived is ever fed back
// into what it was derived from. (A widget that reports back the height it was
// given is the feedback loop that once blew the Mask Editor up to 1,100,044 px.)
function previewHeight(node) {
  const width = Math.max(1, node.size[0] - PREVIEW_INSET);
  return Math.round(
    Math.min(MAX_PREVIEW, Math.max(MIN_PREVIEW, width / slotAspect(node))),
  );
}

// The image at a slot is REPLACED in place, so its URL never changes. Without the
// mtime the browser would keep showing the picture from three runs ago.
const slotImageUrl = (slot, mtime) =>
  api.apiURL(`/xyz/cache/image?slot=${encodeURIComponent(slot)}&t=${mtime ?? Date.now()}`);

async function fetchSlots() {
  const response = await api.fetchApi('/xyz/cache/slots');
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || 'could not list the slots');
  return data.slots;
}

// ---------------------------------------------------------------- combo refresh

function applySlots(node, slots) {
  const widget = node.widgets?.find((w) => w.name === 'slot');
  if (!widget) return;

  // Read can only read a slot that holds an image; Write may target an empty one
  // it has just created.
  const usable =
    node.comfyClass === READ_NODE ? slots.filter((s) => s.has_image) : slots;
  const names = usable.map((s) => s.name);

  widget.options.values = names.length ? names : [NO_SLOTS];
  if (!widget.options.values.includes(widget.value)) {
    // Don't silently repoint at another slot — keep the choice and let the run
    // say "cache slot 'x' is empty".
    if (widget.value && widget.value !== NO_SLOTS) {
      widget.options.values.unshift(widget.value);
    } else {
      widget.value = widget.options.values[0];
    }
  }
  node.__xyzSlots = slots;
  node.__xyzUpdatePreview?.();
  node.setDirtyCanvas(true, true);
}

async function refreshAll() {
  let slots;
  try {
    slots = await fetchSlots();
  } catch (err) {
    console.error('[XYZ Cache]', err);
    return;
  }
  for (const node of app.graph?._nodes ?? []) {
    if (CACHE_NODES.has(node.comfyClass)) applySlots(node, slots);
  }
  return slots;
}

// ---------------------------------------------------------------- live polling
//
// A slot's image can change with ComfyUI none the wiser — you edit it in Krita and
// save over it, or another tool writes it. Watch the folder so the preview keeps
// up with what is actually on disk.

const POLL_MS = 2000;
let lastSeen = '';

const cacheNodesOnCanvas = () =>
  (app.graph?._nodes ?? []).filter((n) => CACHE_NODES.has(n.comfyClass));

async function poll() {
  // Nothing to update, or nobody looking: don't hit the disk.
  if (document.hidden || cacheNodesOnCanvas().length === 0) return;

  let slots;
  try {
    slots = await fetchSlots();
  } catch {
    return; // a blip is not worth a console full of noise
  }

  // Compare on name + mtime: only redraw when the folder really moved.
  const fingerprint = slots
    .map((s) => `${s.name}:${s.has_image ? s.mtime : '-'}`)
    .join('|');
  if (fingerprint === lastSeen) return;
  lastSeen = fingerprint;

  for (const node of cacheNodesOnCanvas()) applySlots(node, slots);
}

// ---------------------------------------------------------------- the browser

function openBrowser(target) {
  const existing = document.getElementById('xyz-cache-browser');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'xyz-cache-browser';
  overlay.style.cssText = `position:fixed;inset:0;z-index:10000;display:flex;
    align-items:center;justify-content:center;background:rgba(0,0,0,.55);
    font-family:ui-sans-serif,system-ui,sans-serif;`;
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) overlay.remove();
  });

  const panel = document.createElement('div');
  panel.style.cssText = `width:min(900px,90vw);height:min(640px,85vh);display:flex;
    flex-direction:column;background:#1e1e2e;color:#cdd6f4;border:1px solid #45475a;
    border-radius:10px;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.5);`;
  overlay.append(panel);

  const bar = document.createElement('div');
  bar.style.cssText = `display:flex;align-items:center;gap:10px;padding:12px 14px;
    border-bottom:1px solid #313244;flex:0 0 auto;`;
  const title = document.createElement('div');
  title.textContent = 'Cache slots';
  title.style.cssText = 'font-weight:600;font-size:14px;flex:1 1 auto;';
  const hint = document.createElement('div');
  hint.textContent = 'click an image to select it';
  hint.style.cssText = 'color:#7f849c;font-size:12px;';
  const close = document.createElement('button');
  close.textContent = '✕';
  close.style.cssText = `width:26px;height:26px;border-radius:5px;border:1px solid #45475a;
    background:#313244;color:#cdd6f4;cursor:pointer;flex:0 0 auto;`;
  close.onclick = () => overlay.remove();
  bar.append(title, hint, close);
  panel.append(bar);

  const grid = document.createElement('div');
  grid.style.cssText = `flex:1 1 auto;overflow-y:auto;padding:14px;display:grid;
    grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;align-content:start;`;
  panel.append(grid);

  const render = (slots) => {
    grid.replaceChildren();
    const withImages = slots.filter((s) => s.has_image);
    if (!withImages.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No slots hold an image yet. Run an "XYZ Cache Slot Write" first.';
      empty.style.cssText = 'color:#7f849c;grid-column:1/-1;padding:20px;';
      grid.append(empty);
      return;
    }

    for (const slot of withImages) {
      const card = document.createElement('div');
      const chosen = slot.name === target?.widgets?.find((w) => w.name === 'slot')?.value;
      card.style.cssText = `display:flex;flex-direction:column;gap:6px;padding:8px;
        border-radius:8px;cursor:pointer;background:#252537;
        border:2px solid ${chosen ? '#89b4fa' : 'transparent'};`;
      card.onclick = () => {
        const widget = target?.widgets?.find((w) => w.name === 'slot');
        if (widget) {
          if (!widget.options.values.includes(slot.name)) {
            widget.options.values.push(slot.name);
          }
          widget.value = slot.name;
          widget.callback?.(slot.name);
          target.__xyzUpdatePreview?.();
          target.setDirtyCanvas(true, true);
        }
        overlay.remove();
      };

      const img = document.createElement('img');
      img.src = slotImageUrl(slot.name, slot.mtime);
      img.style.cssText = `width:100%;height:150px;object-fit:contain;border-radius:5px;
        background:#11111b;`;
      card.append(img);

      const label = document.createElement('div');
      label.textContent = slot.name;
      label.style.cssText = 'font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;';
      const meta = document.createElement('div');
      meta.textContent = `${slot.width}x${slot.height}`;
      meta.style.cssText = 'font-size:11px;color:#7f849c;';
      card.append(label, meta);

      grid.append(card);
    }
  };

  document.body.append(overlay);
  // Live: read the folder now, not the list ComfyUI built at startup.
  refreshAll().then((slots) => render(slots ?? []));
}

// ---------------------------------------------------------------- extension

app.registerExtension({
  name: 'XYZNodes.Cache',

  async nodeCreated(node) {
    if (!CACHE_NODES.has(node.comfyClass)) return;

    const slotWidget = node.widgets?.find((w) => w.name === 'slot');

    if (node.comfyClass === READ_NODE) {
      // BEFORE the preview: the preview is the one that stretches, so nothing may
      // come after it.
      node.addWidget('button', 'Browse slots', null, () => openBrowser(node));
      // No Refresh button: the folder is polled, so there is nothing to refresh.

      const wrap = document.createElement('div');
      wrap.style.cssText = `display:flex;align-items:center;justify-content:center;
        width:100%;height:${MIN_PREVIEW}px;border-radius:6px;border:1px solid #45475a;
        background:#11111b;overflow:hidden;`;
      // width/height 100%, NOT max-width/max-height. The max-* pair only CAPS the
      // image — it never grows it — so a 400x200 picture in a 700x500 box drew at
      // its natural 400x200 with black on all four sides, and the bars just got
      // fatter as the node grew. object-fit keeps the aspect ratio.
      const img = document.createElement('img');
      img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:none;';
      const empty = document.createElement('div');
      empty.style.cssText = 'color:#585b70;font:12px ui-sans-serif,system-ui,sans-serif;';
      empty.textContent = 'no image';
      wrap.append(img, empty);

      const preview = node.addDOMWidget('xyz_cache_preview', 'custom', wrap, {
        getValue: () => '',
        setValue: () => {},
        serialize: false,
      });
      // A CONSTANT floor. Reporting back the height we just handed the element is
      // the feedback loop; LiteGraph only needs a minimum from us.
      preview.computeSize = () => [node.size[0], MIN_PREVIEW];
      preview.computeLayoutSize = undefined;

      // Drag the node WIDER and the picture grows. Height is not the user's to
      // set: it is whatever the picture's shape needs, so there are no black bars.
      const fit = () => {
        if (node.__xyzFitting) return;
        node.__xyzFitting = true;

        const height = previewHeight(node);
        if (Math.round(parseFloat(wrap.style.height)) !== height) {
          wrap.style.height = `${height}px`;
        }
        const wanted = spaceAbovePreview(node) + height;
        if (Math.round(node.size[1]) !== wanted) {
          node.setSize([node.size[0], wanted]);
        }

        node.__xyzFitting = false;
      };
      node.__xyzFitPreview = fit;

      const onResize = node.onResize;
      node.onResize = function (size) {
        const result = onResize?.apply(this, arguments);
        fit();
        return result;
      };

      const onConfigure = node.onConfigure;
      node.onConfigure = function (info) {
        const result = onConfigure?.apply(this, arguments);
        fit();
        return result;
      };

      node.__xyzUpdatePreview = () => {
        const slot = slotWidget?.value;
        const record = (node.__xyzSlots ?? []).find((s) => s.name === slot);
        if (!slot || slot === NO_SLOTS || !record?.has_image) {
          img.style.display = 'none';
          img.removeAttribute('src');
          empty.style.display = '';
          empty.textContent = slot && slot !== NO_SLOTS ? `'${slot}' is empty` : 'no image';
          node.__xyzShowing = null;
          return;
        }
        // Only touch src when the picture ACTUALLY changed. The poller runs every
        // couple of seconds, and reassigning src every time makes the preview
        // flicker as the browser re-decodes the same image.
        const showing = `${slot}@${record.mtime}`;
        if (node.__xyzShowing !== showing) {
          img.src = slotImageUrl(slot, record.mtime);
          node.__xyzShowing = showing;
        }
        img.style.display = '';
        empty.style.display = 'none';
        // A different slot is a different shape — reshape the box, or the new
        // picture gets bars the old one did not have.
        node.__xyzFitPreview?.();
      };

      if (slotWidget) {
        const original = slotWidget.callback;
        slotWidget.callback = function (...args) {
          const result = original?.apply(this, args);
          node.__xyzUpdatePreview();
          return result;
        };
      }

      node.setSize([Math.max(300, node.size[0]), node.size[1]]);
      fit();
    }

    if (node.comfyClass === WRITE_NODE) {
      const create = node.addWidget('button', 'Create slot', null, async () => {
        const name = window.prompt(
          'New cache slot name (letters, digits, dot, dash, underscore):',
          'base',
        );
        if (!name) return;
        try {
          const response = await api.fetchApi('/xyz/cache/slot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          const data = await response.json();
          if (!response.ok || !data.ok) throw new Error(data.error || 'could not create the slot');
          await refreshAll();
          const widget = node.widgets?.find((w) => w.name === 'slot');
          if (widget) {
            widget.value = data.slot;
            node.setDirtyCanvas(true, true);
          }
        } catch (err) {
          console.error('[XYZ Cache]', err);
          create.name = String(err.message).slice(0, 34);
          setTimeout(() => {
            create.name = 'Create slot';
            node.setDirtyCanvas(true, true);
          }, 4000);
          node.setDirtyCanvas(true, true);
        }
      });
    }

    // Read the folder now rather than trusting the startup list.
    refreshAll();
  },

  setup() {
    // A Write that just ran created or replaced an image; the Read node next to it
    // should show the new picture without anyone pressing anything.
    api.addEventListener('execution_success', () => refreshAll());

    setInterval(poll, POLL_MS);
    // Coming back to the tab: catch up at once rather than waiting for the tick.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) poll();
    });
  },
});
