// "Send to Krita" — the modal's state, and the request behind it.
//
// The options are the same three the `XYZ Krita Send To Krita` node has, with the same
// names and the same meanings, because someone who has used one should not have to
// learn the other. They are remembered in localStorage: this is a per-machine habit
// ("I always send as a layer, keeping the size"), not something worth a server round
// trip or a place in gallery_config.json.
import { ref } from 'vue';
import * as api from '../api.js';

const KEY = 'xyz.gallery.krita.send';

export const SEND_MODES = ['new_layer', 'new_document'];
export const FIT_MODES = ['keep', 'fit', 'grow_canvas'];

export const sendModalOpen = ref(false);
export const sendIds = ref([]);
export const sendMode = ref('new_layer');
export const sendFit = ref('fit');
export const sendBusy = ref(false);
export const sendResult = ref(null);

(function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (SEND_MODES.includes(saved.mode)) sendMode.value = saved.mode;
    if (FIT_MODES.includes(saved.fit)) sendFit.value = saved.fit;
  } catch { /* first run, or private mode */ }
}());

function remember() {
  try {
    localStorage.setItem(KEY, JSON.stringify({
      mode: sendMode.value, fit: sendFit.value,
    }));
  } catch { /* private mode */ }
}

/** Open the dialog for these image ids. */
export function openKritaSend(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isFinite);
  if (!list.length) return;
  sendIds.value = list;
  sendResult.value = null;
  sendBusy.value = false;
  sendModalOpen.value = true;
}

export function closeKritaSend() {
  if (sendBusy.value) return;   // a send in flight is not cancellable; Krita is busy
  sendModalOpen.value = false;
  sendResult.value = null;
}

/** Do it. Leaves the dialog open on partial failure so the report can be read. */
export async function runKritaSend() {
  if (sendBusy.value || !sendIds.value.length) return;
  sendBusy.value = true;
  sendResult.value = null;
  remember();
  try {
    const out = await api.post('/images/send_to_krita', {
      ids: sendIds.value,
      mode: sendMode.value,
      fit: sendFit.value,
    });
    sendResult.value = out || { sent: [], failed: [], total: 0 };
    const failed = (sendResult.value.failed || []).length;
    if (!failed) {
      sendModalOpen.value = false;
    }
  } catch (e) {
    sendResult.value = {
      sent: [],
      failed: sendIds.value.map((id) => ({ id, error: (e && e.message) || String(e) })),
      total: sendIds.value.length,
    };
  } finally {
    sendBusy.value = false;
  }
}
