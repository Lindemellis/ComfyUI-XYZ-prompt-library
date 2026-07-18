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
const DEFAULT_PREVIEW = 180;
const PREVIEW_PAD = 8;

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

// The preview box fills whatever room the node gives it. The node's shape is the
// USER's — the box is not locked to the picture's aspect ratio.
//
// `object-fit: contain` then scales the picture to touch the box on its tighter
// axis, so it fills either the full width or the full height, and the leftover
// shows on ONE axis only. It never leaves a border on all four sides — that was a
// different bug (`max-width/max-height` caps a picture instead of growing it, so a
// small image just sat in the middle of a big box).
//
// Reads node.size, writes ONLY to the element. Never the other way round: a widget
// that reports back the height it was given is the feedback loop that once blew the
// Mask Editor up to 1,100,044 px.
function previewHeight(node) {
  return Math.max(MIN_PREVIEW, Math.floor(node.size[1] - spaceAbovePreview(node)));
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

// -------------------------------------------------- Mask Editor image-node glue
//
// ComfyUI's core "Open in MaskEditor | Image Canvas" menu appears for any node
// that is an *image node* (`previewMediaType === 'image'`), and the editor loads
// the picture from `node.images[0]` via `/view`. So we point that at the slot
// image (which lives in output/xyz_cache/<slot>/image.png) and the whole editor —
// menu, painting, clipspace save — comes for free. We drive image-node identity
// through `previewMediaType` and keep `node.imgs` cleared; our opaque DOM preview
// stays the visible one even if core momentarily draws onto the node body.
//
// The editor writes its result (a `clipspace/clipspace-painted-masked-<t>.png
// [input]` reference, mask in the alpha) into the node's hidden `image` widget.
// We remember that per slot so switching slots parks the edit and coming back
// restores it; if the slot's picture is later overwritten (its mtime moves) the
// edit is dropped — it belonged to a different image.

const slotRef = (slot) => ({
  filename: 'image.png',
  subfolder: `xyz_cache/${slot}`,
  type: 'output',
});

const currentMtime = (node, slot) =>
  (node.__xyzSlots ?? []).find((s) => s.name === slot)?.mtime ?? null;

function slotEdits(node) {
  node.properties = node.properties || {};
  if (!node.properties.xyz_slot_edits) node.properties.xyz_slot_edits = {};
  return node.properties.xyz_slot_edits;
}

// Make the node an image node pointing at `slot`, so the core menu shows up and
// the editor knows which picture to open. We rely on `previewMediaType` (not
// `node.imgs`) for image-node identity, and keep `node.imgs` cleared so core does
// not draw a second picture on the node body behind our (opaque) DOM preview.
function markImageNode(node, slot) {
  node.previewMediaType = 'image';
  node.images = slot && slot !== NO_SLOTS ? [slotRef(slot)] : undefined;
  node.imgs = undefined;
}

// Drop edits whose slot image was replaced, then load the current slot's surviving
// edit into the hidden `image` widget. Idempotent — safe to call on every refresh.
function refreshImageState(node) {
  const slot = node.widgets?.find((w) => w.name === 'slot')?.value;
  const imageWidget = node.widgets?.find((w) => w.name === 'image');
  const map = slotEdits(node);

  for (const [name, rec] of Object.entries(map)) {
    const mt = currentMtime(node, name);
    // Only when we actually know the current mtime AND it moved: a null mtime
    // means "slots not loaded yet" or "slot gone", neither of which is proof the
    // picture changed, so we keep the edit rather than lose it wrongly.
    if (mt != null && rec.mtime != null && mt !== rec.mtime) delete map[name];
  }

  const rec = slot && slot !== NO_SLOTS ? map[slot] : null;
  const want = rec ? rec.image : '';
  if (imageWidget && imageWidget.value !== want) {
    node.__xyzSettingImage = true;
    imageWidget.value = want;
    node.__xyzSettingImage = false;
  }
  markImageNode(node, slot);
}

// The editor just wrote a painted reference into the `image` widget. Record it
// under the current slot, then put node.images back to the live slot (the editor
// had pointed it at the clipspace file) so the on-node identity stays the slot.
function onImageEdited(node, value) {
  const slot = node.widgets?.find((w) => w.name === 'slot')?.value;
  if (!slot || slot === NO_SLOTS) return;
  const v = (value || '').trim();
  const map = slotEdits(node);
  if (v) map[slot] = { image: v, mtime: currentMtime(node, slot) };
  else delete map[slot];
  // Defer: let the editor's own save finish before we reclaim node.images.
  setTimeout(() => {
    node.imgs = undefined;
    markImageNode(node, slot);
    node.__xyzUpdatePreview?.();
    node.setDirtyCanvas(true, true);
  }, 0);
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
  // Now that we know each slot's mtime, drop stale edits and restore the current
  // slot's surviving one.
  node.__xyzRefreshImageState?.();
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

      // Drag the node any shape you like — the box follows it. Only the element is
      // touched here; the node's size stays the user's.
      const fit = () => {
        const height = previewHeight(node);
        if (Math.round(parseFloat(wrap.style.height)) !== height) {
          wrap.style.height = `${height}px`;
        }
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

      // --- core Mask Editor glue -------------------------------------------
      // The backend gives us a widget named `image` for the editor's clipspace
      // round-trip. Hide it (the repo idiom), and watch its value: when the editor
      // writes a painted reference into it, remember it under the current slot.
      const imageWidget = node.widgets?.find((w) => w.name === 'image');
      if (imageWidget) {
        imageWidget.hidden = true;
        imageWidget.type = 'converted-widget';
        imageWidget.computeSize = () => [0, -4];
        let stored = imageWidget.value;
        Object.defineProperty(imageWidget, 'value', {
          configurable: true,
          get() {
            return stored;
          },
          set(next) {
            const changed = next !== stored;
            stored = next;
            if (changed && !node.__xyzSettingImage) onImageEdited(node, next);
          },
        });
      }

      node.__xyzRefreshImageState = () => refreshImageState(node);

      // Guard the whole workflow-load restore: LiteGraph re-applies the saved
      // `image` value during configure, and that must NOT look like a fresh paint
      // (which would overwrite the edit's saved mtime with null and make it
      // un-droppable). Re-derive state from node.properties afterwards.
      const baseConfigure = node.configure;
      node.configure = function () {
        node.__xyzSettingImage = true;
        const result = baseConfigure?.apply(this, arguments);
        node.__xyzSettingImage = false;
        node.__xyzRefreshImageState?.();
        return result;
      };

      if (slotWidget) {
        const original = slotWidget.callback;
        slotWidget.callback = function (...args) {
          const result = original?.apply(this, args);
          // A different slot has its own parked edit (or none) — swap it in.
          node.__xyzRefreshImageState?.();
          node.__xyzUpdatePreview();
          return result;
        };
      }

      // Open with a reasonable picture area; after that the size is the user's.
      node.setSize([
        Math.max(300, node.size[0]),
        spaceAbovePreview(node) + DEFAULT_PREVIEW,
      ]);
      fit();
      // Be an image node from the start, so the "Open in MaskEditor | Image
      // Canvas" menu is there before the first slot poll returns.
      node.__xyzRefreshImageState?.();
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
