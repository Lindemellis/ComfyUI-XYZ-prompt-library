// views/DetailView.js — T14 scope: 2-pane detail page with zoom + pan
// (left) and read-only metadata + copy + download + nav (right).
//
// Contract per TASKS T14 / SPEC FR-16..19:
//   * Left pane: original image served by backend-injected `raw_url`
//     (SPEC §4 #39 — NEVER hand-crafted). Zoom: Fit / 1:1 / + / −,
//     pointer-drag pan, and wheel on the canvas (WHEEL_ZOOM_STEP). Prev/Next
//     also on ArrowLeft / ArrowRight when focus is not in an input.
//   * Previous / Next buttons call GET /image/{id}/neighbors with the
//     current FilterSpec + SortSpec so the traversal stays inside the
//     same result set (SPEC FR-16 wording "within the current
//     folder + filter + sort set"). Filter/sort come from the shared
//     store (stores/filters.js) — the same source MainView uses, which
//     is itself URL-mirrored per FR-4, so a direct #/image/:id link
//     still gives consistent neighbors.
//   * Wrap at ends is done FRONTEND-SIDE per TASKS T14: when
//     neighbors.prev_id === null we fetch GET /images with the sort
//     direction reversed + limit=1 to obtain the "last" element; when
//     neighbors.next_id === null we fetch GET /images with limit=1 to
//     obtain the "first" element. The extra round-trip only fires on
//     boundary clicks, so it's strictly cheaper than pre-fetching.
//   * Right pane: read-only metadata per FR-17 + copy-to-clipboard
//     buttons for positive / negative prompt / seed (FR-17 explicit).
//   * Bottom actions (FR-19):
//       - Download image → <a href="/raw/{id}/download"> (browser
//         handles the attachment disposition; routes.py emits both
//         filename= and filename*= per §4 #43).
//       - Download workflow → <a href="/image/{id}/workflow.json">
//         disabled (pointer-events: none + aria-disabled) when the
//         record says has_workflow=false (SPEC §4 #23 DB authority).
//       - Back → returns to #/ (hash router). MainView restores scroll
//         position from sessionStorage (T14 contract: onOpenImage
//         saves, onMounted restores).
//       - Delete → T25 ``ConfirmModal`` + ``DELETE /image/{id}``.
//
// T22: Autocomplete tag edit + favorite PATCH + resync + WS (connection store).
//   * Move — T24 ; bulk delete — BulkBar (T25)
import {
  defineComponent, ref, computed, watch,
  onMounted, onBeforeUnmount, nextTick,
} from 'vue';
import * as api from '../api.js';
import { executeImageDownload } from '../stores/downloadHelper.js';
import { apiQueryObject, filterState } from '../stores/filters.js';
import { BASE_URL } from '../api.js';
import { Autocomplete } from '../components/Autocomplete.js';
import { ConfirmModal } from '../components/ConfirmModal.js';
import { IconButton } from '../components/IconButton.js';
import { subscribeGalleryEvent, subscribeReconcile, EV } from '../stores/connection.js';
import { vocabCacheClear } from '../stores/vocab.js';
import { vocabAutocompleteMatch, developerMode } from '../stores/gallerySettings.js';

const MIN_SCALE = 0.05;
const MAX_SCALE = 20;
const ZOOM_STEP = 1.25;
/** Slightly gentler than toolbar +/- so trackpad + mouse wheel feel usable. */
const WHEEL_ZOOM_STEP = 1.12;

const DETAIL_ASIDE_LS = 'xyz_gallery.detail_aside_width_px.v1';
const DETAIL_ASIDE_DEFAULT = 360;
const DETAIL_ASIDE_MIN = 260;
const DETAIL_ASIDE_MAX_ABS = 560;

function fmtBytesDv(n) {
  const x = Number(n) || 0;
  if (x < 1024) return `${x} B`;
  if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KiB`;
  if (x < 1024 * 1024 * 1024) return `${(x / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(x / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

export const DetailView = defineComponent({
  name: 'DetailView',
  components: { Autocomplete, ConfirmModal, IconButton },
  props: { id: { type: Number, required: true } },
  setup(props) {
    const loading = ref(true);
    const error = ref(null);
    const record = ref(null);

    const prevId = ref(null);
    const nextId = ref(null);
    const neighborsLoading = ref(false);

    // Zoom / pan state — scale ≥ MIN_SCALE, translation in CSS px.
    // We do NOT persist across images: each image load re-runs fit()
    // so a huge 4K image doesn't bleed its last zoom onto a tiny one.
    const scale = ref(1);
    const tx = ref(0);
    const ty = ref(0);
    const imgNatural = ref({ w: 0, h: 0 });

    const canvasRef = ref(null);
    const canvasSize = ref({ w: 0, h: 0 });

    const tagDraft = ref(/** @type {string[]} */([]));
    const tagInput = ref('');
    /** True while a tag PATCH is in flight (UI disable + serial queue). */
    const gallerySaving = ref(false);
    /** Serialize tag PATCHes so rapid add/remove never races. */
    let tagPersistTail = Promise.resolve();
    const favSaving = ref(false);
    const delModal = ref(false);
    const delBusy = ref(false);
    const delErr = ref('');
    let unsubEvent = null;
    let unsubRecon = null;

    const copiedKey = ref(null);
    let copyTimer = null;

    /** T37 — §11 V1.1-F12: "原文" (PNG/DB 存证) vs "归一化" (§8.8 词表管线). */
    const posView = ref(/** @type {'raw' | 'norm'} */('raw'));

    const nameEditing = ref(false);
    const nameEditDraft = ref('');
    const renameBusy = ref(false);
    const renameErr = ref('');
    /** @type {import('vue').Ref<{ id: number, path: string }[] | null>} */
    const folderTreeFlat = ref(null);
    const fnameInputRef = ref(/** @type {HTMLInputElement | null} */(null));

    function syncTagDraft() {
      const g = record.value && record.value.gallery;
      if (!g || !Array.isArray(g.tags)) {
        tagDraft.value = [];
      } else {
        tagDraft.value = g.tags.slice();
      }
      tagInput.value = '';
    }

    function _readAsideWidthPx() {
      try {
        const n = parseInt(localStorage.getItem(DETAIL_ASIDE_LS) || '', 10);
        if (!Number.isFinite(n)) return DETAIL_ASIDE_DEFAULT;
        return Math.min(DETAIL_ASIDE_MAX_ABS, Math.max(DETAIL_ASIDE_MIN, n));
      } catch {
        return DETAIL_ASIDE_DEFAULT;
      }
    }
    function _clampAsideWidth(w) {
      const maxW = Math.min(
        DETAIL_ASIDE_MAX_ABS,
        Math.max(DETAIL_ASIDE_MIN + 40, Math.floor(window.innerWidth * 0.55)),
      );
      return Math.max(DETAIL_ASIDE_MIN, Math.min(maxW, Math.round(w)));
    }
    const asideWidthPx = ref(_readAsideWidthPx());

    let splitDrag = false;
    let splitStartX = 0;
    let splitStartW = 0;
    function onAsideSplitMove(e) {
      if (!splitDrag) return;
      /* Dragging the handle right narrows the metadata column (moves split into aside). */
      asideWidthPx.value = _clampAsideWidth(
        splitStartW - (e.clientX - splitStartX),
      );
    }
    function onAsideSplitUp() {
      if (!splitDrag) return;
      splitDrag = false;
      window.removeEventListener('mousemove', onAsideSplitMove, true);
      window.removeEventListener('mouseup', onAsideSplitUp, true);
      try {
        localStorage.setItem(DETAIL_ASIDE_LS, String(asideWidthPx.value));
      } catch { /* ignore */ }
      nextTick(() => _measureCanvas());
    }
    function onAsideSplitDown(e) {
      splitDrag = true;
      splitStartX = e.clientX;
      splitStartW = asideWidthPx.value;
      window.addEventListener('mousemove', onAsideSplitMove, true);
      window.addEventListener('mouseup', onAsideSplitUp, true);
    }

    async function fetchRecord(id, opts = {}) {
      const silent = !!(opts && opts.silent);
      if (!silent) {
        loading.value = true;
        error.value = null;
        record.value = null;
      }
      try {
        const next = await api.get(`/image/${id}`);
        if (Number(next.id) !== Number(id)) return;
        record.value = next;
        syncTagDraft();
      } catch (exc) {
        if (!silent) {
          error.value = exc;
          record.value = null;
        }
      } finally {
        if (!silent) loading.value = false;
      }
    }

    function onTagInput(v) { tagInput.value = v; }
    async function commitNewTag() {
      const s = String(tagInput.value || '').split(',').map((x) => x.trim())
        .filter(Boolean);
      if (!s.length) return;
      const set = new Set(tagDraft.value);
      const out = tagDraft.value.slice();
      for (const t of s) {
        if (!set.has(t)) {
          out.push(t);
          set.add(t);
        }
      }
      tagDraft.value = out;
      tagInput.value = '';
      await persistTags();
    }
    async function removeTag(idx) {
      if (idx < 0 || idx >= tagDraft.value.length) return;
      tagDraft.value = tagDraft.value.filter((_, i) => i !== idx);
      await persistTags();
    }

    async function persistTags() {
      const prevWait = tagPersistTail;
      let resolveNext = () => {};
      tagPersistTail = new Promise((r) => { resolveNext = r; });
      await prevWait;
      const id = props.id;
      gallerySaving.value = true;
      const prev = record.value;
      try {
        const out = await api.patch(`/image/${id}`, { tags: tagDraft.value.slice() });
        if (!out || Number(out.id) !== Number(id) || Number(out.id) !== Number(props.id)) {
          return;
        }
        record.value = out;
        syncTagDraft();
        vocabCacheClear();
      } catch (e) {
        if (prev && Number(prev.id) === Number(props.id)) {
          record.value = prev;
          syncTagDraft();
        }
      } finally {
        gallerySaving.value = false;
        resolveNext();
      }
    }

    async function toggleFavorite() {
      if (favSaving.value || !record.value) return;
      const g = record.value.gallery || {};
      const next = !g.favorite;
      favSaving.value = true;
      const prev = record.value;
      const optimistic = { ...record.value, gallery: { ...g, favorite: next, sync_status: 'pending' } };
      record.value = optimistic;
      try {
        record.value = await api.patch(`/image/${props.id}`, { favorite: next });
        syncTagDraft();
      } catch (e) {
        record.value = prev;
        syncTagDraft();
      } finally {
        favSaving.value = false;
      }
    }

    async function fetchNeighbors(id) {
      neighborsLoading.value = true;
      prevId.value = null;
      nextId.value = null;
      try {
        const q = apiQueryObject();
        const nb = await api.get(`/image/${id}/neighbors`, { query: q });
        prevId.value = (typeof nb.prev_id === 'number') ? nb.prev_id : null;
        nextId.value = (typeof nb.next_id === 'number') ? nb.next_id : null;
      } catch (exc) {
        // Non-fatal: leave prev/next null, user can still navigate
        // manually. We don't surface this error — the main load state
        // is the authoritative one.
        prevId.value = null;
        nextId.value = null;
      } finally {
        neighborsLoading.value = false;
      }
    }

    async function wrapTarget(mode) {
      // mode='first' → return the item that sort puts at the head
      // (i.e. what we'd wrap to when "next" is clicked at the tail).
      // mode='last'  → reverse the sort direction to grab the tail.
      const baseQ = apiQueryObject();
      const q = { ...baseQ, limit: 1 };
      if (mode === 'last') {
        const cur = filterState.sort.dir || 'desc';
        q.dir = cur === 'desc' ? 'asc' : 'desc';
      }
      try {
        const page = await api.get('/images', { query: q });
        const items = Array.isArray(page.items) ? page.items : [];
        return (items[0] && typeof items[0].id === 'number') ? items[0].id : null;
      } catch {
        return null;
      }
    }

    async function gotoPrev() {
      if (neighborsLoading.value) return;
      let target = prevId.value;
      if (target == null) {
        // Wrap: at head → jump to tail of current filter+sort set.
        target = await wrapTarget('last');
      }
      if (target != null) {
        window.location.hash = `#/image/${target}`;
      }
    }

    async function gotoNext() {
      if (neighborsLoading.value) return;
      let target = nextId.value;
      if (target == null) {
        target = await wrapTarget('first');
      }
      if (target != null) {
        window.location.hash = `#/image/${target}`;
      }
    }

    function fit() {
      const iw = imgNatural.value.w;
      const ih = imgNatural.value.h;
      const cw = canvasSize.value.w;
      const ch = canvasSize.value.h;
      if (iw > 0 && ih > 0 && cw > 0 && ch > 0) {
        const s = Math.min(cw / iw, ch / ih);
        scale.value = Math.max(MIN_SCALE, Math.min(MAX_SCALE, s || 1));
      } else {
        scale.value = 1;
      }
      tx.value = 0;
      ty.value = 0;
    }
    function actualSize() {
      scale.value = 1;
      tx.value = 0;
      ty.value = 0;
    }
    function zoomIn() {
      scale.value = Math.min(MAX_SCALE, scale.value * ZOOM_STEP);
    }
    function zoomOut() {
      scale.value = Math.max(MIN_SCALE, scale.value / ZOOM_STEP);
    }
    function zoomInWheel() {
      scale.value = Math.min(MAX_SCALE, scale.value * WHEEL_ZOOM_STEP);
    }
    function zoomOutWheel() {
      scale.value = Math.max(MIN_SCALE, scale.value / WHEEL_ZOOM_STEP);
    }

    /**
     * Skip image prev/next when user types in a field; tag Autocomplete
     * hosts an <input> inside .dv-tagac.
     * @param {EventTarget | null} t
     * @returns {boolean}
     */
    function isEditableKeyTarget(t) {
      if (!t || t.nodeType !== 1) return false;
      const el = /** @type {Element} */ (t);
      if (el.closest && el.closest('.dv-tagac')) return true;
      if (el.classList && el.classList.contains('dv-fname-input')) return true;
      const name = el.tagName;
      if (name === 'INPUT' || name === 'TEXTAREA' || name === 'SELECT') return true;
      return /** @type {HTMLElement} */ (el).isContentEditable === true;
    }

    function _normPathKey(/** @type {string} */ p) {
      return String(p).replace(/\\/g, '/');
    }
    function _dirnameFilePath(/** @type {string} */ p) {
      const s = _normPathKey(p);
      const i = s.lastIndexOf('/');
      return i < 0 ? s : s.slice(0, i);
    }
    function _walkFolderNodes(/** @type {unknown} */ nodes, /** @type {{ id: number, path: string }[]} */ out) {
      if (!Array.isArray(nodes)) return;
      for (const n of nodes) {
        if (n && typeof n === 'object' && n.id != null && n.path != null) {
          out.push({ id: Number(n.id), path: String(n.path) });
        }
        if (n && typeof n === 'object' && Array.isArray(n.children)) {
          _walkFolderNodes(n.children, out);
        }
      }
    }
    async function loadFolderTree() {
      const data = await api.get('/folders');
      const out = /** @type {{ id: number, path: string }[]} */ ([]);
      _walkFolderNodes(data, out);
      folderTreeFlat.value = out;
    }
    function findParentFolderId(/** @type {string} */ filePath) {
      const want = _normPathKey(_dirnameFilePath(filePath));
      const list = folderTreeFlat.value;
      if (!list || !list.length) return null;
      for (const f of list) {
        if (_normPathKey(f.path).toLowerCase() === want.toLowerCase()) return f.id;
      }
      return null;
    }
    function closeRenameErr() { renameErr.value = ''; }
    async function startRename() {
      if (!record.value || renameBusy.value) return;
      renameErr.value = '';
      try {
        if (!folderTreeFlat.value) await loadFolderTree();
      } catch {
        renameErr.value = '无法加载目录列表';
        return;
      }
      nameEditDraft.value = String(record.value.filename || '');
      nameEditing.value = true;
      nextTick(() => { fnameInputRef.value && fnameInputRef.value.focus(); });
    }
    function cancelRename() {
      if (renameBusy.value) return;
      nameEditing.value = false;
      nameEditDraft.value = String(record.value && record.value.filename ? record.value.filename : '');
    }
    async function applyRename() {
      if (!nameEditing.value || !record.value) return;
      const cur = String(record.value.filename || '');
      const next = String(nameEditDraft.value || '').trim();
      if (!next) { cancelRename(); return; }
      if (next.includes('/') || next.includes('\\')) {
        renameErr.value = '文件名不能包含路径分隔符';
        nameEditing.value = false;
        nameEditDraft.value = cur;
        return;
      }
      if (next === cur) {
        nameEditing.value = false;
        return;
      }
      const tid = findParentFolderId(String(record.value.path || ''));
      if (tid == null) {
        renameErr.value = '无法解析图片所在目录，请重试或刷新目录树';
        nameEditing.value = false;
        nameEditDraft.value = cur;
        return;
      }
      renameBusy.value = true;
      try {
        const out = await api.post(`/image/${props.id}/move`, {
          target_folder_id: tid,
          rename: next,
        });
        record.value = out;
        nameEditing.value = false;
      } catch (e) {
        let msg = (e && e.message) ? String(e.message) : String(e);
        const det = e && e.details;
        if (det && typeof det.suggested_name === 'string' && det.suggested_name) {
          msg += ' — 建议: ' + det.suggested_name;
        }
        renameErr.value = msg;
        nameEditing.value = false;
        nameEditDraft.value = cur;
      } finally {
        renameBusy.value = false;
      }
    }

    function onCanvasWheel(/** @type {WheelEvent} */ e) {
      if (e.deltaY < 0) zoomInWheel();
      else if (e.deltaY > 0) zoomOutWheel();
    }

    function onDetailKeydown(/** @type {KeyboardEvent} */ e) {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (nameEditing.value) {
          e.preventDefault();
          return;
        }
      }
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (delModal.value) return;
      if (isEditableKeyTarget(e.target)) return;
      if (neighborsLoading.value || !record.value) return;
      e.preventDefault();
      if (e.key === 'ArrowLeft') {
        void gotoPrev();
      } else {
        void gotoNext();
      }
    }

    function onImgLoad(ev) {
      const img = ev.target;
      imgNatural.value = {
        w: img.naturalWidth || 0,
        h: img.naturalHeight || 0,
      };
      fit();
    }

    // Pointer-based pan; we set setPointerCapture so drag-out-of-
    // canvas still tracks until pointerup, and we use pointer events
    // (not mousedown) so touch/stylus also work on Chromium ≥ 110.
    let dragging = false;
    let startX = 0, startY = 0, startTx = 0, startTy = 0;
    function onPointerDown(e) {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      startTx = tx.value;
      startTy = ty.value;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      e.preventDefault();
    }
    function onPointerMove(e) {
      if (!dragging) return;
      tx.value = startTx + (e.clientX - startX);
      ty.value = startTy + (e.clientY - startY);
    }
    function onPointerUp(e) {
      if (!dragging) return;
      dragging = false;
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    }

    async function copy(key, text) {
      const payload = text == null ? '' : String(text);
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(payload);
        } else {
          const ta = document.createElement('textarea');
          ta.value = payload;
          ta.style.position = 'fixed';
          ta.style.left = '-9999px';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand && document.execCommand('copy');
          document.body.removeChild(ta);
        }
        copiedKey.value = key;
        if (copyTimer) clearTimeout(copyTimer);
        copyTimer = setTimeout(() => { copiedKey.value = null; }, 1200);
      } catch {
        /* silent — the textarea fallback covers the common case; we
           don't want to spam the user if the browser blocks both. */
      }
    }

    // Canvas resize observer — keeps fit() honest when the user
    // resizes the window while staying on the detail page.
    let resizeObs = null;
    function _measureCanvas() {
      if (!canvasRef.value) return;
      canvasSize.value = {
        w: canvasRef.value.clientWidth,
        h: canvasRef.value.clientHeight,
      };
    }

    onMounted(() => {
      window.addEventListener('keydown', onDetailKeydown);
      fetchRecord(props.id);
      fetchNeighbors(props.id);
      nextTick(() => {
        _measureCanvas();
        if (typeof ResizeObserver !== 'undefined' && canvasRef.value) {
          resizeObs = new ResizeObserver(() => _measureCanvas());
          resizeObs.observe(canvasRef.value);
        }
      });
      unsubRecon = subscribeReconcile(() => {
        fetchRecord(props.id);
        fetchNeighbors(props.id);
      });
      unsubEvent = subscribeGalleryEvent((env) => {
        const t = env && env.type;
        const d = (env && env.data) || {};
        if (d.id != null && Number(d.id) !== Number(props.id)) return;
        if (t === EV.DELETED) {
          error.value = { code: 'not_found', message: 'Image was removed' };
          record.value = null;
          return;
        }
        if (t === EV.UPSERTED) {
          // Silent refresh: full fetch would set record=null and flash the canvas
          // (e.g. metadata_sync wrote PNG chunks → watcher upsert).
          void fetchRecord(props.id, { silent: true });
          return;
        }
        if (t === EV.UPDATED) {
          if (!record.value) return;
          const g = { ...record.value.gallery || {} };
          if (d.version != null) g.version = d.version;
          if (d.favorite !== undefined) g.favorite = d.favorite;
          if (Array.isArray(d.tags)) g.tags = d.tags.slice();
          record.value = { ...record.value, gallery: g };
          syncTagDraft();
          return;
        }
        if (t === EV.SYNC) {
          if (!record.value) return;
          const g = { ...record.value.gallery || {} };
          if (d.sync_status != null) g.sync_status = d.sync_status;
          if (d.version != null) g.version = d.version;
          record.value = { ...record.value, gallery: g };
        }
      });
    });

    onBeforeUnmount(() => {
      window.removeEventListener('keydown', onDetailKeydown);
      window.removeEventListener('mousemove', onAsideSplitMove, true);
      window.removeEventListener('mouseup', onAsideSplitUp, true);
      if (unsubEvent) { unsubEvent(); unsubEvent = null; }
      if (unsubRecon) { unsubRecon(); unsubRecon = null; }
      if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
      if (copyTimer) { clearTimeout(copyTimer); copyTimer = null; }
    });

    watch(() => props.id, (newId) => {
      posView.value = 'raw';
      nameEditing.value = false;
      renameErr.value = '';
      folderTreeFlat.value = null;
      fetchRecord(newId);
      fetchNeighbors(newId);
      // Reset zoom between images so the next image starts fit-to-
      // canvas rather than inheriting the previous image's zoom.
      scale.value = 1;
      tx.value = 0;
      ty.value = 0;
    });

    const meta = computed(() => (record.value && record.value.metadata) || {});
    const displayPositive = computed(() => {
      const m = meta.value;
      if (!m || typeof m !== 'object') return null;
      if (posView.value === 'norm') {
        const n = m.positive_prompt_normalized;
        if (n != null && String(n).length) return String(n);
        return null;
      }
      const p = m.positive_prompt;
      if (p != null && String(p).length) return String(p);
      return null;
    });
    // LoRA syntax is embedded in the raw positive prompt as
    // ``<lora:name:weight>`` (also ``<lyco:…>`` / ``<hypernet:…>``) — the §8.8
    // normalisation pipeline strips it, so we always parse the RAW prompt
    // (independent of the 原文/归一化 toggle) to surface it as its own row.
    const loras = computed(() => {
      const m = meta.value;
      const src = m && m.positive_prompt;
      if (!src) return [];
      const out = [];
      const re = /<(?:lora|lyco|hypernet):([^:>]+)(?::([^:>]+))?(?::([^>]+))?>/gi;
      let mm;
      while ((mm = re.exec(String(src))) !== null) {
        const name = (mm[1] || '').trim();
        if (!name) continue;
        const w = mm[2] != null ? String(mm[2]).trim() : '';
        out.push({ name, weight: w || null, raw: mm[0] });
      }
      return out;
    });
    const lorasText = computed(() => loras.value.map((l) => l.raw).join(', '));

    const gallery = computed(() => (record.value && record.value.gallery) || {});
    const size = computed(() => (record.value && record.value.size) || {});
    const folder = computed(() => (record.value && record.value.folder) || {});

    const hasWorkflow = computed(() => !!meta.value.has_workflow);

    const syncStatusBadge = computed(() => {
      const s = gallery.value.sync_status;
      if (s === 'pending') return 'pending';
      if (s === 'failed') return 'failed';
      return null;
    });
    const dlImageBusy = ref(false);
    const workflowUrl = computed(() =>
      record.value ? `${BASE_URL}/image/${record.value.id}/workflow.json` : '#');
    const scalePct = computed(() => Math.round(scale.value * 100));

    const imgStyle = computed(() => ({
      transform:
        `translate(-50%, -50%) translate(${tx.value}px, ${ty.value}px) scale(${scale.value})`,
      transformOrigin: 'center center',
      cursor: dragging ? 'grabbing' : 'grab',
    }));

    function onWorkflowClick(e) {
      // Defence-in-depth: aria-disabled + pointer-events:none already
      // block activation, but older browsers may still follow <a
      // href="#">, so guard at the event layer too.
      if (!hasWorkflow.value) {
        e.preventDefault();
        e.stopPropagation();
      }
    }

    function openDelModal() {
      delErr.value = '';
      delModal.value = true;
    }
    function closeDelModal() {
      if (!delBusy.value) delModal.value = false;
    }

    async function onDownloadImage() {
      if (!record.value) return;
      dlImageBusy.value = true;
      try {
        await executeImageDownload(record.value.id);
      } catch {
        /* ignore */
      } finally {
        dlImageBusy.value = false;
      }
    }

    async function onDeleteConfirmed() {
      if (!record.value) return;
      delErr.value = '';
      delBusy.value = true;
      try {
        await api.del(`/image/${props.id}`);
        delModal.value = false;
        window.location.hash = '#/';
      } catch (e) {
        delErr.value = (e && e.message) ? String(e.message) : String(e);
      } finally {
        delBusy.value = false;
      }
    }

    const deleteModalLines = computed(() => {
      const r = record.value;
      if (!r) return ['Delete this image?'];
      const bytes = size.value && size.value.bytes != null ? size.value.bytes : 0;
      return [
        'Permanently delete "' + String(r.filename) + '" (#' + String(r.id) + ')?',
        'Approx. size: ' + fmtBytesDv(bytes) + ' — disk file and index row are removed.',
      ];
    });

    return {
      loading, error, record, meta, gallery, size, folder,
      posView, displayPositive, loras, lorasText,
      prevId, nextId, neighborsLoading,
      scale, tx, ty, scalePct,
      asideWidthPx, onAsideSplitDown,
      canvasRef, imgStyle, copiedKey,
      hasWorkflow, workflowUrl, dlImageBusy, onDownloadImage,
      vocabAutocompleteMatch,
      developerMode,
      syncStatusBadge,
      tagDraft, tagInput, onTagInput, commitNewTag, removeTag,
      gallerySaving, toggleFavorite, favSaving,
      onImgLoad,
      onPointerDown, onPointerMove, onPointerUp,
      onCanvasWheel,
      fit, actualSize, zoomIn, zoomOut,
      gotoPrev, gotoNext, copy,
      onWorkflowClick,
      delModal, delBusy, delErr, openDelModal, closeDelModal, onDeleteConfirmed,
      fmtBytesDv,
      deleteModalLines,
      nameEditing, nameEditDraft, renameBusy, renameErr, fnameInputRef,
      startRename, cancelRename, applyRename, closeRenameErr,
    };
  },
  template: `
    <section class="dv">
      <header class="dv-head">
        <IconButton href="#/" class="ib" text="Back" title="Back to grid" />
        <h2 class="dv-title">
          <span v-if="record" class="dv-title-row">
            <span v-if="syncStatusBadge"
                  class="tc-sync"
                  :class="'tc-sync-'+syncStatusBadge"
                  :title="syncStatusBadge==='pending' ? 'Metadata sync: pending' : 'Metadata sync: failed'"
                  aria-label="metadata sync" />
            <template v-if="developerMode">#{{ record.id }} &mdash; </template>{{ record.filename }}
          </span>
          <span v-else-if="loading" class="muted">Loading…</span>
          <span v-else-if="error" class="error">
            {{ error.code || 'error' }}: {{ error.message }}
          </span>
        </h2>
        <nav class="dv-nav">
          <IconButton
            class="ib ib--nav"
            icon="chevronLeft"
            text="Previous"
            title="Previous (wraps)"
            :disabled="neighborsLoading || !record"
            @click="gotoPrev" />
          <IconButton
            class="ib ib--nav"
            icon="chevronRight"
            text="Next"
            title="Next (wraps)"
            :disabled="neighborsLoading || !record"
            @click="gotoNext" />
        </nav>
      </header>

      <div v-if="error && !loading" class="error dv-error">
        <strong>{{ error.code || 'error' }}</strong>: {{ error.message }}
      </div>

      <div v-else class="dv-body">
        <div class="dv-left">
          <div class="dv-canvas"
               ref="canvasRef"
               @pointerdown="onPointerDown"
               @pointermove="onPointerMove"
               @pointerup="onPointerUp"
               @pointercancel="onPointerUp"
               @wheel.prevent="onCanvasWheel">
            <img v-if="record && record.raw_url"
                 class="dv-img"
                 :src="record.raw_url"
                 :style="imgStyle"
                 draggable="false"
                 @load="onImgLoad"
                 alt="" />
            <div v-else-if="loading" class="muted dv-canvas-hint">Loading image…</div>
          </div>
          <div class="dv-zoom">
            <button type="button" @click="fit" title="Fit to screen">Fit</button>
            <button type="button" @click="actualSize" title="1:1 (actual size)">1:1</button>
            <button type="button" @click="zoomOut" title="Zoom out">−</button>
            <button type="button" @click="zoomIn" title="Zoom in">+</button>
            <span class="dv-zoom-pct muted">{{ scalePct }}%</span>
          </div>
        </div>
        <div class="dv-splitter"
             role="separator"
             aria-orientation="vertical"
             title="Drag to resize image vs details"
             @mousedown.prevent="onAsideSplitDown"></div>
        <aside class="dv-right" :style="{ flex: '0 0 ' + asideWidthPx + 'px', width: asideWidthPx + 'px' }">
          <template v-if="record">
            <section class="dv-sec-block" aria-label="image data">
              <h3 class="dv-sec">Image data</h3>
              <dl class="dv-meta">
                <dt>File name</dt>
                <dd class="dv-fname-wrap">
                  <template v-if="!nameEditing">
                    <code class="dv-fname-read"
                          :title="record.filename"
                          @dblclick="startRename">{{ record.filename }}</code>
                    <button type="button"
                            class="dv-fname-pencil"
                            :disabled="renameBusy"
                            title="Rename (or double-click name)"
                            aria-label="Rename file"
                            @click="startRename">✎</button>
                  </template>
                  <div v-else class="dv-fname-edit" role="group" aria-label="Rename file">
                    <input ref="fnameInputRef"
                           class="dv-fname-input"
                           v-model="nameEditDraft"
                           type="text"
                           :disabled="renameBusy"
                           autocomplete="off"
                           @keydown.enter.prevent="applyRename"
                           @keydown.esc.prevent="cancelRename" />
                    <button type="button" class="dv-fname-ok" :disabled="renameBusy" title="Save" @click="applyRename">✓</button>
                    <button type="button" class="dv-fname-x" :disabled="renameBusy" title="Cancel" @click="cancelRename">✕</button>
                  </div>
                </dd>
                <dt>Folder</dt>
                <dd>
                  <code>{{ folder.display_name || '—' }}</code>
                  <span v-if="folder.kind" class="muted"> ({{ folder.kind }})</span>
                </dd>
                <dt>Size</dt>
                <dd>
                  <template v-if="size.width && size.height">
                    {{ size.width }} &times; {{ size.height }}
                  </template>
                  <span v-else class="muted">—</span>
                  <span v-if="size.bytes" class="muted dv-bytes"> ({{ fmtBytesDv(size.bytes) }})</span>
                </dd>
                <dt>Created</dt>
                <dd>{{ record.created_at || '—' }}</dd>
              </dl>
            </section>

            <section class="dv-sec-block" aria-label="gallery data">
              <h3 class="dv-sec">Gallery data</h3>
              <dl class="dv-meta">
                <dt>Favorite</dt>
                <dd>
                  <button type="button"
                          class="dv-fav"
                          :class="{ active: gallery.favorite }"
                          :aria-pressed="gallery.favorite ? 'true' : 'false'"
                          :disabled="favSaving"
                          :title="gallery.favorite ? 'Unfavorite' : 'Favorite'"
                          @click="toggleFavorite">
                    <span class="dv-fav-icon" aria-hidden="true">{{ gallery.favorite ? '♥' : '♡' }}</span>
                  </button>
                </dd>
                <dt>Tags</dt>
                <dd class="dv-tags-block">
                  <div class="dv-tags-row">
                    <ul v-if="tagDraft && tagDraft.length" class="dv-tags dv-tags--chips">
                      <li v-for="(t, i) in tagDraft" :key="'tag-'+i+'-'+t" class="dv-tag">
                        <code>{{ t }}</code>
                        <button type="button"
                                class="dv-tag-x"
                                :disabled="gallerySaving"
                                @click="removeTag(i)"
                                :aria-label="'remove '+t">×</button>
                      </li>
                    </ul>
                    <span v-else class="dv-tags-empty muted" role="status">(none)</span>
                  </div>
                  <div class="dv-add-tag-row">
                    <span class="dv-add-tag-label">Add tag:</span>
                    <Autocomplete class="dv-tagac dv-tagac--detail"
                                  fetch-kind="tags"
                                  :vocab-match-mode="vocabAutocompleteMatch"
                                  :disabled="gallerySaving"
                                  placeholder="Type and press Enter"
                                  :model-value="tagInput"
                                  @update:model-value="onTagInput"
                                  @commit="commitNewTag" />
                  </div>
                </dd>
              </dl>
            </section>

            <section class="dv-sec-block" aria-label="comfyui data">
              <h3 class="dv-sec">ComfyUI data</h3>
              <dl class="dv-meta">
                <dt>Model</dt>
                <dd><code v-if="meta.model">{{ meta.model }}</code><span v-else class="muted">—</span></dd>
                <template v-if="loras.length">
                  <dt>
                    LoRA
                    <button type="button" class="dv-copy"
                            @click="copy('loras', lorasText)">
                      {{ copiedKey === 'loras' ? 'Copied!' : 'Copy' }}
                    </button>
                  </dt>
                  <dd>
                    <ul class="dv-loras">
                      <li v-for="(l, i) in loras" :key="'lora-'+i+'-'+l.name" class="dv-lora">
                        <code class="dv-lora-name" :title="l.raw">{{ l.name }}</code>
                        <span v-if="l.weight != null" class="dv-lora-w">{{ l.weight }}</span>
                      </li>
                    </ul>
                  </dd>
                </template>
                <dt>
                  Seed
                  <button type="button" class="dv-copy"
                          :disabled="meta.seed == null"
                          @click="copy('seed', meta.seed)">
                    {{ copiedKey === 'seed' ? 'Copied!' : 'Copy' }}
                  </button>
                </dt>
                <dd><code v-if="meta.seed != null">{{ meta.seed }}</code><span v-else class="muted">—</span></dd>
                <dt>CFG</dt>
                <dd><code v-if="meta.cfg != null">{{ meta.cfg }}</code><span v-else class="muted">—</span></dd>
                <dt>Sampler</dt>
                <dd><code v-if="meta.sampler">{{ meta.sampler }}</code><span v-else class="muted">—</span></dd>
                <dt>Scheduler</dt>
                <dd><code v-if="meta.scheduler">{{ meta.scheduler }}</code><span v-else class="muted">—</span></dd>
                <dt>
                  Positive prompt
                  <span class="dv-prompt-mode" role="group" aria-label="positive prompt view">
                    <button type="button"
                            class="dv-prompt-mode-btn"
                            :class="{ active: posView === 'raw' }"
                            :aria-pressed="posView === 'raw' ? 'true' : 'false'"
                            @click="posView = 'raw'">原文</button>
                    <button type="button"
                            class="dv-prompt-mode-btn"
                            :class="{ active: posView === 'norm' }"
                            :aria-pressed="posView === 'norm' ? 'true' : 'false'"
                            @click="posView = 'norm'">归一化</button>
                  </span>
                  <button type="button" class="dv-copy"
                          :disabled="!displayPositive"
                          @click="copy('positive', displayPositive)">
                    {{ copiedKey === 'positive' ? 'Copied!' : 'Copy' }}
                  </button>
                </dt>
                <dd>
                  <pre v-if="displayPositive" class="dv-prompt">{{ displayPositive }}</pre>
                  <span v-else class="muted">—</span>
                </dd>
                <dt>
                  Negative prompt
                  <button type="button" class="dv-copy"
                          :disabled="!meta.negative_prompt"
                          @click="copy('negative', meta.negative_prompt)">
                    {{ copiedKey === 'negative' ? 'Copied!' : 'Copy' }}
                  </button>
                </dt>
                <dd>
                  <pre v-if="meta.negative_prompt" class="dv-prompt">{{ meta.negative_prompt }}</pre>
                  <span v-else class="muted">—</span>
                </dd>
              </dl>
            </section>

            <section class="dv-sec-block" aria-label="operations">
              <h3 class="dv-sec">Operations</h3>
              <div class="dv-actions">
                <button type="button"
                        class="dv-btn"
                        :disabled="dlImageBusy || !record"
                        @click="onDownloadImage">
                  {{ dlImageBusy ? 'Preparing…' : 'Download image' }}
                </button>
                <a class="dv-btn"
                   :href="workflowUrl"
                   :aria-disabled="!hasWorkflow"
                   :class="{ 'dv-btn-disabled': !hasWorkflow }"
                   :tabindex="hasWorkflow ? 0 : -1"
                   @click="onWorkflowClick"
                   download>Download workflow</a>
                <button type="button"
                        class="dv-btn dv-btn-danger"
                        :disabled="delBusy || !record"
                        title="Permanently delete this image"
                        @click="openDelModal">Delete</button>
              </div>
            </section>
          </template>
          <div v-else-if="loading" class="dv-meta muted">Loading…</div>
        </aside>
      </div>
      <ConfirmModal
        v-if="delModal"
        title="Delete image"
        :lines="deleteModalLines"
        confirm-label="Delete"
        cancel-label="Cancel"
        :danger="true"
        :busy="delBusy"
        @cancel="closeDelModal"
        @confirm="onDeleteConfirmed"
      />
      <div v-if="renameErr" class="cm-overlay" @click.self="closeRenameErr">
        <div class="cm-panel" role="alertdialog">
          <header class="cm-head">
            <h2 class="cm-title">Rename</h2>
            <button type="button" class="cm-x" @click="closeRenameErr">×</button>
          </header>
          <div class="cm-body">
            <p class="cm-line">{{ renameErr }}</p>
          </div>
          <footer class="cm-foot cm-foot--single">
            <button type="button" class="cm-btn" @click="closeRenameErr">OK</button>
          </footer>
        </div>
      </div>
      <p v-if="delErr" class="error dv-del-err">{{ delErr }}</p>
    </section>
  `,
});

export default DetailView;
