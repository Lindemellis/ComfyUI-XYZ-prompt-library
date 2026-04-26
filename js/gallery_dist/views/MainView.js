// views/MainView.js — T12 sidebar + T13 toolbar/grid host.
//
// T12 already landed the left sidebar (Filters + FolderTree) and the
// single-shot /images + /images/count fetch. T13 replaces the simple
// filename preview list that used to sit in .mv-main with:
//
//   * a toolbar on top of the grid (cards-per-row slider for FR-9a,
//     sort dropdown for FR-9b);
//   * the VirtualGrid component — windowed DOM + IntersectionObserver
//     pagination driven by next_cursor from /images;
//   * ThumbCard instances inside the grid (loading=lazy etc. per
//     SPEC §8.6);
//   * right-click context menu: Open detail, Move… (T24), Delete… (T25);
//   * hash-router navigation to /image/:id on card left-click (FR-12 —
//     detail view is T14, but the *trigger* is T13).
//
// Deliberately out of scope (AI_RULES R1.2 / R1.3 / R6.5):
//   * Bulk selection / checkbox overlay (T23).
//   * Real favorite PATCH (T19); we keep an optimistic local flip and
//     emit intent that T19 will convert into an api.patch(/image/:id).
//   * Line view (FR-9c / T45) — ``LineVirtualGrid`` + ``filterState.view_mode``.
//   * T21: Autocomplete for prompt/tag filters + /vocab/models for model list.
//   * T22: api.patch + WS (stores/connection.js) + /index/status focus
//     reconciliation.
import { defineComponent, ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import * as api from '../api.js';
import { executeImageDownload } from '../stores/downloadHelper.js';
import { subscribeGalleryEvent, subscribeReconcile, EV } from '../stores/connection.js';
import { progressMainFrozen, setIndexJobUiSyncHandler } from '../stores/galleryProgress.js';
import { FolderTree } from '../components/FolderTree.js';
import { VirtualGrid } from '../components/VirtualGrid.js';
import { LineVirtualGrid } from '../components/LineVirtualGrid.js';
import { BulkBar } from '../components/BulkBar.js';
import { MovePicker } from '../components/MovePicker.js';
import { ConfirmModal } from '../components/ConfirmModal.js';
import { Autocomplete } from '../components/Autocomplete.js';
import { ModelFilterPick } from '../components/ModelFilterPick.js';
import {
  filterState, panelCollapsed, setPanelCollapsed,
  apiQueryObject, resetFilter,
  layoutState, setCardsPerRow,
  setViewMode,
} from '../stores/filters.js';
import { toggleCardInSelection, resetSelection } from '../stores/selection.js';
import { vocabCacheClear } from '../stores/vocab.js';
import {
  LS_SIDEBAR_W,
  LS_FILTERS_H,
  DEFAULT_SIDEBAR_WIDTH_PX,
  DEFAULT_FILTERS_PANE_HEIGHT_PX,
  vocabAutocompleteMatch,
  filterVisibility,
  developerMode,
  filtersPaneFitRequest,
} from '../stores/gallerySettings.js';

const PAGE_SIZE = 120;

/**
 * T43 — registered root id that owns `folderId` in the current `/folders` tree
 * (top-level node id). Used to skip gratuitous `resetAndFetch` on `folder.changed`
 * from another root (NFR-20 / SPEC §12.3).
 *
 * @param {unknown} nodes
 * @param {number} folderId
 * @returns {number|null}
 */
function rootIdContainingFolderId(nodes, folderId) {
  if (typeof folderId !== 'number' || !Array.isArray(nodes)) return null;
  function contains(n, fid) {
    if (!n || typeof n !== 'object') return false;
    if (n.id === fid) return true;
    const ch = n.children;
    if (!Array.isArray(ch)) return false;
    for (let i = 0; i < ch.length; i += 1) {
      if (contains(ch[i], fid)) return true;
    }
    return false;
  }
  for (let i = 0; i < nodes.length; i += 1) {
    const root = nodes[i];
    if (contains(root, folderId)) {
      return typeof root.id === 'number' ? root.id : null;
    }
  }
  return null;
}

function readLayoutNum(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  } catch { /* ignore */ }
  return fallback;
}

function fmtBytesCtx(n) {
  const x = Number(n) || 0;
  if (x < 1024) return `${x} B`;
  if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KiB`;
  if (x < 1024 * 1024 * 1024) return `${(x / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(x / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

// T14 Back-button contract: sessionStorage holds the scroll position
// (and the id the user opened) so DetailView → "#/" round-trips land
// the user back on the same viewport. Using sessionStorage (not
// localStorage) means the state dies with the tab, matching TASKS
// T14's "暂存" wording and avoiding cross-tab surprises.
const MAIN_SCROLL_KEY = 'xyz_gallery.main_scroll.v1';

function _readPendingRestore() {
  try {
    const raw = sessionStorage.getItem(MAIN_SCROLL_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(MAIN_SCROLL_KEY);
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    let scrollTop = Number(obj.scrollTop);
    if (!Number.isFinite(scrollTop) || scrollTop < 0) scrollTop = null;
    let folderTreeScrollTop = Number(obj.folderTreeScrollTop);
    if (!Number.isFinite(folderTreeScrollTop) || folderTreeScrollTop < 0) {
      folderTreeScrollTop = null;
    }
    const lastId = obj.lastId != null ? obj.lastId : null;
    if (scrollTop == null && folderTreeScrollTop == null && lastId == null) {
      return null;
    }
    return {
      scrollTop,
      lastId,
      folderTreeScrollTop,
    };
  } catch {
    return null;
  }
}

export const MainView = defineComponent({
  name: 'MainView',
  components: {
    FolderTree, VirtualGrid, LineVirtualGrid, BulkBar, MovePicker, ConfirmModal,
    Autocomplete, ModelFilterPick,
  },
  setup() {
    const folders = ref([]);
    const foldersLoading = ref(true);
    const foldersError = ref(null);

    const images = ref([]);
    const imagesLoading = ref(true);
    const loadingMore = ref(false);
    const imagesError = ref(null);
    const totalCount = ref(0);
    const approximate = ref(false);
    const nextCursor = ref(null);
    const hasMore = ref(false);

    const knownModels = ref([]);

    const promptInput = ref((filterState.filter.positive_tokens || []).join(', '));
    const tagInput = ref((filterState.filter.tag_tokens || []).join(', '));
    const nameInput = ref(filterState.filter.name || '');

    const contextMenu = ref({ open: false, x: 0, y: 0, id: null });
    const movePickerOpen = ref(false);
    const movePickerSel = ref(null);
    const deleteCtxOpen = ref(false);
    const deleteCtxId = ref(null);
    const deleteCtxBusy = ref(false);
    const deleteCtxErr = ref('');

    let nameTimer = null;
    let vocabClearTimer = null;
    function scheduleVocabCacheClearTags() {
      if (vocabClearTimer) clearTimeout(vocabClearTimer);
      vocabClearTimer = setTimeout(() => {
        vocabClearTimer = null;
        vocabCacheClear();
      }, 160);
    }

    let pendingAborter = null;
    let unsubEvent = null;
    let unsubRecon = null;
    // Monotonic token so a late-returning abort doesn't resurrect an
    // obsolete page (e.g. user changes sort while page-1 is mid-flight).
    let fetchToken = 0;
    // T14: one-shot restore from sessionStorage (grid + folder tree scroll).
    // Grid target cleared after first non-empty /images fetch; folder tree
    // applies when ``.mv-folders-scroll`` exists (may lag folders GET).
    const _pr = _readPendingRestore();
    let pendingGridScrollRestore = _pr && _pr.scrollTop != null
      ? { scrollTop: _pr.scrollTop, lastId: _pr.lastId ?? null }
      : null;
    let pendingFolderTreeScrollRestore = _pr && _pr.folderTreeScrollTop != null
      ? _pr.folderTreeScrollTop
      : null;
    // Highlight hint for the card we came back from (FR-19 "selection"
    // restore). T23 bulk checkbox overlay.
    const lastOpenedId = ref(_pr != null ? (_pr.lastId ?? null) : null);
    const bulkMode = ref(false);
    const movePickerSelectionHint = computed(() => {
      const s = movePickerSel.value;
      if (s && s.mode === 'explicit' && Array.isArray(s.ids)) {
        return s.ids.length;
      }
      return null;
    });
    // Only increments on full first-page list replace (reset / filter) — not on favorite/WS
    // patches — so VirtualGrid can scroll to top *only* then, never on in-place item edits.
    const gridListGen = ref(0);
    const folderTreeScrollEl = ref(null);
    const sidebarStackEl = ref(null);

    const sidebarWidthPx = ref(readLayoutNum(LS_SIDEBAR_W, DEFAULT_SIDEBAR_WIDTH_PX));
    const filtersPaneHeightPx = ref(readLayoutNum(LS_FILTERS_H, DEFAULT_FILTERS_PANE_HEIGHT_PX));

    let fsUpsertRefreshTimer = null;
    function scheduleGridRefreshAfterFsUpsert() {
      if (fsUpsertRefreshTimer) clearTimeout(fsUpsertRefreshTimer);
      fsUpsertRefreshTimer = setTimeout(() => {
        fsUpsertRefreshTimer = null;
        resetAndFetch();
      }, 420);
    }

    function persistLayoutDims() {
      try {
        localStorage.setItem(LS_SIDEBAR_W, String(Math.round(sidebarWidthPx.value)));
        localStorage.setItem(LS_FILTERS_H, String(Math.round(filtersPaneHeightPx.value)));
      } catch { /* ignore */ }
    }

    const mvGridStyle = computed(() => ({
      display: 'grid',
      gridTemplateColumns: `${Math.round(sidebarWidthPx.value)}px 8px 1fr`,
      alignItems: 'stretch',
      columnGap: '0',
    }));

    const filtersPaneStyle = computed(() => {
      if (panelCollapsed.filters) {
        return {
          flex: '0 0 auto',
          height: 'auto',
          minHeight: 0,
          overflow: 'visible',
        };
      }
      // Fixed height so the filter↔folder splitter always reserves space; extra
      // room below short filter content is non-scrollable slack (see .mv-filters-slack).
      return {
        flex: '0 0 auto',
        height: `${Math.round(filtersPaneHeightPx.value)}px`,
        minHeight: '120px',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      };
    });

    /** Sidebar cap for filter pane height (same rule as horizontal splitter). */
    function filtersPaneHeightCapPx() {
      const aside = sidebarStackEl.value;
      if (!aside) return 800;
      const h = aside.clientHeight;
      const reserved = 200;
      return Math.max(140, h - reserved);
    }

    function clampFiltersPaneHeight() {
      if (panelCollapsed.filters) return;
      const maxH = filtersPaneHeightCapPx();
      const minH = 120;
      if (filtersPaneHeightPx.value > maxH) filtersPaneHeightPx.value = maxH;
      if (filtersPaneHeightPx.value < minH) filtersPaneHeightPx.value = minH;
    }

    /**
     * After Settings → Save: shrink/grow filter pane to visible fields, capped by
     * sidebar layout max and by the user's current height (drag handle ceiling).
     */
    function fitFiltersPaneHeightToContent() {
      if (panelCollapsed.filters) return;
      const aside = sidebarStackEl.value;
      if (!aside) return;
      const head = aside.querySelector('.mv-filters-pane .mv-sec-head');
      const body = aside.querySelector('.mv-filters-pane .mv-filters-body');
      if (!head || !body) return;
      const cap = filtersPaneHeightCapPx();
      const minH = 120;
      const userMax = Math.max(minH, Math.round(filtersPaneHeightPx.value));
      const fudge = 8;
      const natural = Math.ceil(head.offsetHeight + body.scrollHeight + fudge);
      const target = Math.min(cap, userMax, Math.max(minH, natural));
      filtersPaneHeightPx.value = target;
      persistLayoutDims();
    }

    watch(
      filtersPaneFitRequest,
      (n) => {
        if (n < 1) return;
        nextTick(() => {
          requestAnimationFrame(() => {
            fitFiltersPaneHeightToContent();
            filtersPaneFitRequest.value = 0;
          });
        });
      },
      { immediate: true },
    );

    let splitVActive = false;
    let splitVStartX = 0;
    let splitVStartW = 0;
    function onSplitVDown(ev) {
      splitVActive = true;
      splitVStartX = ev.clientX;
      splitVStartW = sidebarWidthPx.value;
      window.addEventListener('mousemove', onSplitVMove, true);
      window.addEventListener('mouseup', onSplitVUp, true);
      document.body.classList.add('mv-dragging-col');
    }
    function onSplitVMove(ev) {
      if (!splitVActive) return;
      const dx = ev.clientX - splitVStartX;
      let nw = splitVStartW + dx;
      nw = Math.max(200, Math.min(560, nw));
      sidebarWidthPx.value = nw;
    }
    function onSplitVUp() {
      if (!splitVActive) return;
      splitVActive = false;
      window.removeEventListener('mousemove', onSplitVMove, true);
      window.removeEventListener('mouseup', onSplitVUp, true);
      document.body.classList.remove('mv-dragging-col');
      persistLayoutDims();
    }

    let splitHActive = false;
    let splitHStartY = 0;
    let splitHStartH = 0;
    function onSplitHDown(ev) {
      if (panelCollapsed.filters) return;
      splitHActive = true;
      splitHStartY = ev.clientY;
      splitHStartH = filtersPaneHeightPx.value;
      window.addEventListener('mousemove', onSplitHMove, true);
      window.addEventListener('mouseup', onSplitHUp, true);
      document.body.classList.add('mv-dragging-row');
    }
    function onSplitHMove(ev) {
      if (!splitHActive) return;
      const dy = ev.clientY - splitHStartY;
      let nh = splitHStartH + dy;
      nh = Math.max(120, nh);
      const aside = sidebarStackEl.value;
      if (aside) {
        nh = Math.min(nh, filtersPaneHeightCapPx());
      }
      filtersPaneHeightPx.value = nh;
    }
    function onSplitHUp() {
      if (!splitHActive) return;
      splitHActive = false;
      window.removeEventListener('mousemove', onSplitHMove, true);
      window.removeEventListener('mouseup', onSplitHUp, true);
      document.body.classList.remove('mv-dragging-row');
      clampFiltersPaneHeight();
      persistLayoutDims();
    }

    let sidebarResizeObs = null;
    /** Coalesce burst ``GET /folders`` (WS / bulk) so FolderTree DOM is not repainted dozens of times per second. */
    let foldersSilentDebounceTimer = null;

    async function fetchFolders(opts = {}) {
      const silent = !!opts.silent;
      if (silent) {
        return new Promise((resolve) => {
          if (foldersSilentDebounceTimer) clearTimeout(foldersSilentDebounceTimer);
          foldersSilentDebounceTimer = setTimeout(async () => {
            foldersSilentDebounceTimer = null;
            try {
              await fetchFoldersBody({ silent: true });
            } finally {
              resolve();
            }
          }, 100);
        });
      }
      await fetchFoldersBody(opts);
    }

    async function fetchFoldersBody(opts = {}) {
      const silent = !!opts.silent;
      if (!silent) {
        foldersLoading.value = true;
      }
      foldersError.value = null;
      let scrollBeforeTreeAssign = null;
      try {
        const resp = await api.get('/folders', { query: { include_counts: 'true' } });
        // Snapshot scroll **after** network wait, immediately before replacing ``folders``
        // (capturing at request start fights user scroll during await → scrollbar "snaps back").
        if (silent && folderTreeScrollEl.value) {
          scrollBeforeTreeAssign = folderTreeScrollEl.value.scrollTop;
        }
        folders.value = Array.isArray(resp) ? resp : [];
      } catch (e) {
        if (!silent) {
          foldersError.value = e;
        }
      } finally {
        if (!silent) {
          foldersLoading.value = false;
        }
        if (scrollBeforeTreeAssign != null) {
          await nextTick();
          requestAnimationFrame(() => {
            const el = folderTreeScrollEl.value;
            if (el) el.scrollTop = scrollBeforeTreeAssign;
          });
        }
      }
    }

    async function fetchVocabModels() {
      try {
        const arr = await api.get('/vocab/models');
        if (!Array.isArray(arr)) {
          knownModels.value = [];
          return;
        }
        knownModels.value = arr.map((row) => {
          if (row && typeof row === 'object' && row.model != null) {
            return {
              model: String(row.model),
              label: row.label != null ? String(row.label) : String(row.model),
              usage_count: Number(row.usage_count) || 0,
            };
          }
          if (typeof row === 'string') {
            return { model: row, label: row, usage_count: 0 };
          }
          return null;
        }).filter(Boolean);
      } catch {
        knownModels.value = [];
      }
    }

    async function resetAndFetch() {
      if (pendingAborter) pendingAborter.abort();
      pendingAborter = new AbortController();
      const signal = pendingAborter.signal;
      const token = ++fetchToken;

      imagesLoading.value = true;
      loadingMore.value = false;
      imagesError.value = null;
      images.value = [];
      nextCursor.value = null;
      hasMore.value = false;

      const baseQ = apiQueryObject();
      try {
        const [page, count] = await Promise.all([
          api.get('/images', { query: { ...baseQ, limit: PAGE_SIZE }, signal }),
          api.get('/images/count', { query: baseQ, signal }),
        ]);
        if (signal.aborted || token !== fetchToken) return;
        const items = Array.isArray(page.items) ? page.items : [];
        images.value = items;
        gridListGen.value += 1;
        nextCursor.value = page.next_cursor || null;
        hasMore.value = !!page.next_cursor;
        totalCount.value = typeof count.total === 'number' ? count.total : 0;
        approximate.value = !!count.approximate;
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        if (token !== fetchToken) return;
        imagesError.value = e;
      } finally {
        if (token === fetchToken) imagesLoading.value = false;
      }
    }

    async function loadMore() {
      if (!hasMore.value || loadingMore.value || imagesLoading.value) return;
      if (!nextCursor.value) return;
      loadingMore.value = true;
      const token = fetchToken;
      const baseQ = apiQueryObject();
      try {
        const page = await api.get('/images', {
          query: { ...baseQ, limit: PAGE_SIZE, cursor: nextCursor.value },
        });
        if (token !== fetchToken) return;
        const items = Array.isArray(page.items) ? page.items : [];
        images.value = images.value.concat(items);
        nextCursor.value = page.next_cursor || null;
        hasMore.value = !!page.next_cursor;
      } catch (e) {
        if (token !== fetchToken) return;
        imagesError.value = e;
        hasMore.value = false;
      } finally {
        if (token === fetchToken) loadingMore.value = false;
      }
    }

    /**
     * Watcher re-indexes a file (favicon PATCH → metadata write → fs change) and
     * broadcasts `image.upserted` — a full `resetAndFetch` would clear `images` and
     * scroll to the top, so we only merge the single row.
     */
    async function mergeRowFromIndexUpsert(imageId) {
      if (typeof imageId !== 'number') return;
      const idx = images.value.findIndex((x) => x && x.id === imageId);
      if (idx < 0) {
        try {
          const c = await api.get('/images/count', { query: apiQueryObject() });
          if (c && typeof c.total === 'number') totalCount.value = c.total;
        } catch { /* ignore */ }
        return;
      }
      const row = images.value[idx];
      try {
        const rec = await api.get(`/image/${imageId}`);
        if (!rec || typeof rec !== 'object') return;
        Object.assign(row, rec);
      } catch { /* 404/500 — leave list as-is */ }
    }

    function removeImageRowById(imageId) {
      if (typeof imageId !== 'number') return;
      const i = images.value.findIndex((x) => x && x.id === imageId);
      if (i < 0) {
        void (async () => {
          try {
            const c = await api.get('/images/count', { query: apiQueryObject() });
            if (c && typeof c.total === 'number') totalCount.value = c.total;
          } catch { /* ignore */ }
        })();
        return;
      }
      images.value.splice(i, 1);
      if (totalCount.value > 0) totalCount.value -= 1;
    }

    watch(
      () => panelCollapsed.filters,
      () => {
        nextTick(() => { clampFiltersPaneHeight(); });
      },
    );

    function onFoldersExternalRefresh() {
      void fetchFolders({ silent: true });
      resetAndFetch();
    }

    onMounted(() => {
      fetchFolders();
      fetchVocabModels();
      resetAndFetch();
      window.addEventListener('click', closeContextMenu);
      window.addEventListener('scroll', closeContextMenu, true);
      window.addEventListener('xyz-gallery-folders-refresh', onFoldersExternalRefresh);

      nextTick(() => {
        clampFiltersPaneHeight();
        const el = sidebarStackEl.value;
        if (el && typeof ResizeObserver !== 'undefined') {
          sidebarResizeObs = new ResizeObserver(() => {
            clampFiltersPaneHeight();
          });
          sidebarResizeObs.observe(el);
        }
      });

      unsubRecon = subscribeReconcile(() => {
        if (progressMainFrozen.value) {
          return;
        }
        resetAndFetch();
      });
      // --- T43 / SPEC §12.3 / NFR-20 — `subscribeGalleryEvent` list vs tree policy ---
      //  type                      | images[] / grid        | GET /folders
      //  -------------------------|------------------------|------------------
      //  index.drift_detected      | FULL (resetAndFetch)   | silent refresh
      //  folder.changed            | FULL only if needed * | silent refresh
      //  bulk.completed            | FULL                   | silent refresh
      //  image.upserted            | MERGE or debounced FULL| silent refresh
      //  image.deleted             | row splice + count     | silent refresh
      //  image.updated             | PATCH; FULL if moved_to | silent if moved
      //  image.sync_status_changed | PATCH sync fields      | —
      //  index.progress            | ignored                | —
      //  * folder.changed: `ReconcileFoldersUnderRootOp` only mutates `folder` rows.
      //    Skip FULL when no folder filter, or when `data.root_id` is not the root
      //    that owns the current `folder_id` (tree-only update for other roots).
      //  subscribeReconcile (focus): FULL — server `last_event_ts` ahead of client.
      function onResumeAfterProgressModal() {
        void fetchFolders({ silent: true });
        void resetAndFetch();
      }
      window.addEventListener('xyz-gallery-resume-after-modal', onResumeAfterProgressModal);

      setIndexJobUiSyncHandler(async () => {
        await Promise.all([
          fetchFolders({ silent: true }),
          resetAndFetch(),
        ]);
        await nextTick();
        await nextTick();
      });

      unsubEvent = subscribeGalleryEvent((env) => {
        if (progressMainFrozen.value) {
          return;
        }
        const t = env && env.type;
        const d = (env && env.data) || {};
        if (t === EV.DRIFT) {
          void fetchFolders({ silent: true });
          resetAndFetch();
          return;
        }
        if (t === EV.FOLDER_CHANGED) {
          void fetchFolders({ silent: true });
          const rid = typeof d.root_id === 'number' ? d.root_id : Number(d.root_id);
          const fid = filterState.filter.folder_id;
          if (fid == null) {
            return;
          }
          if (Number.isFinite(rid)) {
            const selRoot = rootIdContainingFolderId(folders.value, fid);
            if (selRoot != null && selRoot !== rid) {
              return;
            }
          }
          resetAndFetch();
          return;
        }
        if (t === EV.BULK_DONE) {
          void fetchFolders({ silent: true });
          resetAndFetch();
          return;
        }
        if (t === EV.UPSERTED) {
          void fetchFolders({ silent: true });
          const iid = typeof d.id === 'number' ? d.id : Number(d.id);
          if (!Number.isFinite(iid)) return;
          const idx = images.value.findIndex((x) => x && x.id === iid);
          if (idx >= 0) {
            void mergeRowFromIndexUpsert(iid);
          } else {
            /* New id or row not on current page (OS add/rename): merge cannot insert. */
            scheduleGridRefreshAfterFsUpsert();
          }
          return;
        }
        if (t === EV.DELETED) {
          void fetchFolders({ silent: true });
          const iid = typeof d.id === 'number' ? d.id : Number(d.id);
          if (Number.isFinite(iid)) {
            removeImageRowById(iid);
          }
          return;
        }
        if (t === EV.INDEX_PROGRESS) {
          return;
        }
        if (t === EV.UPDATED && typeof d.id === 'number') {
          if (Array.isArray(d.tags)) scheduleVocabCacheClearTags();
          if (d.moved_to) {
            void fetchFolders({ silent: true });
            resetAndFetch();
            return;
          }
          const idx = images.value.findIndex((x) => x && x.id === d.id);
          if (idx < 0) return;
          const it = images.value[idx];
          if (!it.gallery) it.gallery = {};
          if (d.version != null) it.gallery.version = d.version;
          if (d.favorite !== undefined) it.gallery.favorite = !!d.favorite;
          if (Array.isArray(d.tags)) it.gallery.tags = d.tags.slice();
          return;
        }
        if (t === EV.SYNC && typeof d.id === 'number') {
          const idx = images.value.findIndex((x) => x && x.id === d.id);
          if (idx < 0) return;
          const it = images.value[idx];
          if (!it.gallery) it.gallery = {};
          if (d.sync_status != null) it.gallery.sync_status = d.sync_status;
          if (d.version != null) it.gallery.version = d.version;
        }
      });
    });

    onBeforeUnmount(() => {
      if (foldersSilentDebounceTimer) {
        clearTimeout(foldersSilentDebounceTimer);
        foldersSilentDebounceTimer = null;
      }
      if (fsUpsertRefreshTimer) {
        clearTimeout(fsUpsertRefreshTimer);
        fsUpsertRefreshTimer = null;
      }
      if (splitVActive) onSplitVUp();
      if (splitHActive) onSplitHUp();
      if (sidebarResizeObs) {
        try {
          sidebarResizeObs.disconnect();
        } catch { /* ignore */ }
        sidebarResizeObs = null;
      }
      if (pendingAborter) pendingAborter.abort();
      if (nameTimer) clearTimeout(nameTimer);
      if (vocabClearTimer) {
        clearTimeout(vocabClearTimer);
        vocabClearTimer = null;
      }
      if (unsubEvent) { unsubEvent(); unsubEvent = null; }
      if (unsubRecon) { unsubRecon(); unsubRecon = null; }
      setIndexJobUiSyncHandler(null);
      window.removeEventListener('xyz-gallery-resume-after-modal', onResumeAfterProgressModal);
      window.removeEventListener('click', closeContextMenu);
      window.removeEventListener('scroll', closeContextMenu, true);
      window.removeEventListener('xyz-gallery-folders-refresh', onFoldersExternalRefresh);
    });

    // Any FilterSpec or SortSpec change resets pagination and refetches
    // page 1. cardsPerRow is intentionally NOT in this watcher — it's
    // a pure client-side layout knob and must not trigger a refetch.
    watch(
      () => JSON.stringify(apiQueryObject()),
      () => resetAndFetch(),
    );

    watch(bulkMode, (on) => {
      if (!on) resetSelection();
    });

    function onNameInput(e) {
      nameInput.value = e.target.value;
      if (nameTimer) clearTimeout(nameTimer);
      nameTimer = setTimeout(() => {
        filterState.filter.name = nameInput.value;
      }, 250);
    }

    function clearNameFilter() {
      if (nameTimer) clearTimeout(nameTimer);
      nameTimer = null;
      nameInput.value = '';
      filterState.filter.name = '';
    }

    function clearPromptFilter() {
      promptInput.value = '';
      filterState.filter.positive_tokens = [];
      scheduleVocabCacheClearTags();
    }

    function clearTagFilter() {
      tagInput.value = '';
      filterState.filter.tag_tokens = [];
      scheduleVocabCacheClearTags();
    }

    function commitPromptTokens() {
      filterState.filter.positive_tokens = promptInput.value
        .split(',').map(s => s.trim()).filter(Boolean);
    }
    function commitTagTokens() {
      filterState.filter.tag_tokens = tagInput.value
        .split(',').map(s => s.trim()).filter(Boolean);
    }

    function setPromptInput(v) {
      promptInput.value = v;
    }
    function setTagInput(v) {
      tagInput.value = v;
    }

    function onToggleDateBound(which, enabled) {
      if (!enabled) {
        filterState.filter[which] = '';
      } else if (!filterState.filter[which]) {
        filterState.filter[which] = new Date().toISOString().slice(0, 10);
      }
    }

    function onSelectFolder(id) {
      filterState.filter.folder_id = id;
    }

    function onToggleBulk(id) {
      toggleCardInSelection(id);
    }
    function onToggleRecursive(v) {
      filterState.filter.recursive = !!v;
    }

    function toggleCollapse() {
      setPanelCollapsed(!panelCollapsed.filters);
    }

    function onResetClick() {
      resetFilter();
      nameInput.value = '';
      promptInput.value = '';
      tagInput.value = '';
    }

    watch(() => filterState.filter.name, (v) => {
      if (v !== nameInput.value) nameInput.value = v;
    });
    watch(() => filterState.filter.positive_tokens, (v) => {
      const s = Array.isArray(v) ? v.join(', ') : '';
      if (s !== promptInput.value) promptInput.value = s;
    });
    watch(() => filterState.filter.tag_tokens, (v) => {
      const s = Array.isArray(v) ? v.join(', ') : '';
      if (s !== tagInput.value) tagInput.value = s;
    });

    watch(
      () => filterState.filter.prompt_match_mode,
      (_nv, ov) => {
        if (ov === undefined) return;
        promptInput.value = '';
        filterState.filter.positive_tokens = [];
      },
    );

    const hasDateAfter = computed(() => !!filterState.filter.date_after);
    const hasDateBefore = computed(() => !!filterState.filter.date_before);

    /** T32 — §11 F04 string / word / phrase (wire: fetch-kind + suggestions-off). */
    const promptFilterPlaceholder = computed(() => {
      const m = filterState.filter.prompt_match_mode;
      if (m === 'string') {
        return 'All typed fragments must appear; underscores count as spaces (not case-sensitive)';
      }
      if (m === 'word') {
        return 'Words or short phrases, comma- or space-separated; suggestions as you type';
      }
      return 'Comma-separated prompt phrases; all must match; suggestions as you type';
    });
    const promptFetchKind = computed(() => (
      filterState.filter.prompt_match_mode === 'word' ? 'words' : 'prompts'
    ));

    // Toolbar — cards-per-row slider + sort dropdown. The slider writes
    // through setCardsPerRow so the clamp/localStorage sink in the
    // store stays the single source of truth.
    function onCardsPerRowInput(e) {
      setCardsPerRow(e.target.value);
    }

    const SORT_KEY_OPTIONS = [
      { value: 'time', label: 'Time' },
      { value: 'name', label: 'Name' },
      { value: 'size', label: 'Size' },
      { value: 'folder', label: 'Folder' },
    ];

    function toggleSortDir() {
      filterState.sort.dir = filterState.sort.dir === 'asc' ? 'desc' : 'asc';
    }

    const galleryViewMode = computed(() => filterState.view_mode);

    function onOpenImage(id) {
      if (typeof id !== 'number' && !(typeof id === 'string' && id.length)) return;
      // T14: stash grid scroll + folder-tree scroll + opened id so Back
      // restores the same viewport. Grid: .vg / .lv-scroller; tree:
      // ``folderTreeScrollEl`` (``.mv-folders-scroll``).
      try {
        const payload = { lastId: id };
        const vg = document.querySelector('.lv-scroller') || document.querySelector('.vg');
        if (vg) payload.scrollTop = vg.scrollTop;
        const ft = folderTreeScrollEl.value;
        if (ft) payload.folderTreeScrollTop = ft.scrollTop;
        sessionStorage.setItem(MAIN_SCROLL_KEY, JSON.stringify(payload));
      } catch { /* sessionStorage unavailable — navigation still works */ }
      window.location.hash = `#/image/${id}`;
    }

    function _tryRestoreFolderTreeScroll() {
      if (pendingFolderTreeScrollRestore == null) return;
      const el = folderTreeScrollEl.value;
      if (!el) return;
      el.scrollTop = pendingFolderTreeScrollRestore;
      pendingFolderTreeScrollRestore = null;
    }

    // Restore grid scroll once the first post-mount fetch lands. We run in
    // nextTick so VirtualGrid’s listGen watcher (which resets
    // scrollTop=0 on a new first page) has already flushed.
    function _tryRestoreScroll() {
      if (!pendingGridScrollRestore) {
        if (pendingFolderTreeScrollRestore != null) {
          nextTick(() => {
            requestAnimationFrame(() => {
              _tryRestoreFolderTreeScroll();
            });
          });
        }
        return;
      }
      if (!images.value.length) return;
      const target = pendingGridScrollRestore.scrollTop;
      pendingGridScrollRestore = null;
      nextTick(() => {
        const vg = document.querySelector('.lv-scroller') || document.querySelector('.vg');
        if (vg) vg.scrollTop = target;
        requestAnimationFrame(() => {
          _tryRestoreFolderTreeScroll();
        });
      });
    }
    watch(() => images.value.length, _tryRestoreScroll);
    watch(
      () => [foldersLoading.value, folders.value.length],
      () => {
        if (pendingFolderTreeScrollRestore == null) return;
        nextTick(() => {
          requestAnimationFrame(() => {
            _tryRestoreFolderTreeScroll();
          });
        });
      },
    );

    async function onToggleFavorite(id) {
      if (typeof id !== 'number') return;
      const idx = images.value.findIndex((x) => x && x.id === id);
      if (idx < 0) return;
      const it = images.value[idx];
      const cur = !!(it.gallery && it.gallery.favorite);
      const next = !cur;
      const prevFav = cur;
      const prevSync = it.gallery && it.gallery.sync_status;
      if (!it.gallery) it.gallery = {};
      it.gallery.favorite = next;
      it.gallery.sync_status = 'pending';
      try {
        const u = await api.patch(`/image/${id}`, { favorite: next });
        if (u && u.gallery) {
          Object.assign(it.gallery, u.gallery);
        }
        // Do not set thumb_url — ?v= changes reload the <img> and cause visible flash;
        // favorite is DB-only and the raster thumb is unchanged.
      } catch (e) {
        it.gallery.favorite = prevFav;
        it.gallery.sync_status = prevSync;
      }
    }

    function onContext({ id, x, y }) {
      contextMenu.value = { open: true, x, y, id };
    }
    function closeContextMenu() {
      if (contextMenu.value.open) contextMenu.value = { open: false, x: 0, y: 0, id: null };
    }
    function onCtxOpenDetail() {
      const id = contextMenu.value.id;
      closeContextMenu();
      if (id != null) onOpenImage(id);
    }
    function onCtxMove() {
      const id = contextMenu.value.id;
      closeContextMenu();
      if (typeof id !== 'number') return;
      movePickerSel.value = { mode: 'explicit', ids: [id] };
      movePickerOpen.value = true;
    }
    function closeMovePicker() {
      movePickerOpen.value = false;
      movePickerSel.value = null;
    }

    const deleteCtxLines = computed(() => {
      const id = deleteCtxId.value;
      const err = deleteCtxErr.value;
      if (id == null) return ['Delete this image?'];
      const it = images.value.find((x) => x && x.id === id);
      const head = !it
        ? ['Permanently delete image #' + String(id) + '?']
        : (() => {
          const bytes = it.size && it.size.bytes != null ? it.size.bytes : 0;
          return [
            'Permanently delete "' + String(it.filename || '') + '" (#' + String(id) + ')?',
            'Approx. size: ' + fmtBytesCtx(bytes) + ' — removed from disk and index.',
          ];
        })();
      if (err) head.push('Error: ' + String(err));
      return head;
    });

    function onCtxDelete() {
      const id = contextMenu.value.id;
      closeContextMenu();
      if (typeof id !== 'number') return;
      deleteCtxErr.value = '';
      deleteCtxId.value = id;
      deleteCtxOpen.value = true;
    }

    function closeDeleteCtx() {
      if (!deleteCtxBusy.value) {
        deleteCtxOpen.value = false;
        deleteCtxId.value = null;
        deleteCtxErr.value = '';
      }
    }

    async function onDeleteCtxConfirmed() {
      const id = deleteCtxId.value;
      if (typeof id !== 'number') return;
      deleteCtxErr.value = '';
      deleteCtxBusy.value = true;
      try {
        await api.del(`/image/${id}`);
        removeImageRowById(id);
        deleteCtxOpen.value = false;
        deleteCtxId.value = null;
      } catch (e) {
        deleteCtxErr.value = (e && e.message) ? String(e.message) : String(e);
      } finally {
        deleteCtxBusy.value = false;
      }
    }

    const ctxDownloadBusy = ref(false);
    async function onCtxDownload() {
      const id = contextMenu.value.id;
      closeContextMenu();
      if (typeof id !== 'number') return;
      ctxDownloadBusy.value = true;
      try {
        await executeImageDownload(id);
      } catch {
        /* ignore — user may cancel or network blip */
      } finally {
        ctxDownloadBusy.value = false;
      }
    }

    return {
      folders, foldersLoading, foldersError,
      images, imagesLoading, loadingMore, imagesError,
      totalCount, approximate, hasMore, knownModels,
      filter: filterState.filter,
      sort: filterState.sort,
      panelCollapsed, layoutState,
      promptInput, tagInput, nameInput,
      hasDateAfter, hasDateBefore, promptFilterPlaceholder, promptFetchKind,
      vocabAutocompleteMatch,
      contextMenu, movePickerOpen, movePickerSel, movePickerSelectionHint,
      deleteCtxOpen, deleteCtxBusy, deleteCtxErr, deleteCtxLines,
      onCtxDelete, closeDeleteCtx, onDeleteCtxConfirmed,
      SORT_KEY_OPTIONS, toggleSortDir,
      clearNameFilter, clearPromptFilter, clearTagFilter,
      galleryViewMode, setViewMode,
      lastOpenedId,
      onNameInput, commitPromptTokens, commitTagTokens, setPromptInput, setTagInput,
      onToggleDateBound, onSelectFolder, onToggleRecursive,
      toggleCollapse, onResetClick,
      onCardsPerRowInput,
      onOpenImage, onToggleFavorite, onContext,
      closeContextMenu, onCtxOpenDetail, onCtxMove, onCtxDownload, ctxDownloadBusy,
      closeMovePicker,
      loadMore, bulkMode, onToggleBulk, gridListGen, folderTreeScrollEl,
      sidebarStackEl, mvGridStyle, filtersPaneStyle, onSplitVDown, onSplitHDown,
      fetchFolders, resetAndFetch,
      filterVisibility,
      developerMode,
    };
  },
  template: `
    <div class="mv" :style="mvGridStyle">
      <aside class="mv-sidebar" ref="sidebarStackEl">
        <div class="mv-filters-pane" :style="filtersPaneStyle">
          <section class="mv-filters mv-filters--stack">
            <div class="mv-sec-head">
              <button type="button" class="mv-collapse" @click="toggleCollapse">
                <span class="mv-chevron">{{ panelCollapsed.filters ? '▶' : '▼' }}</span>
                Filters
              </button>
              <button type="button"
                      class="mv-reset"
                      :disabled="panelCollapsed.filters"
                      @click="onResetClick">Reset</button>
            </div>
            <div v-show="!panelCollapsed.filters" class="mv-filters-scroll">
              <div class="mv-filters-body">
                <div v-show="filterVisibility.name" class="mv-field mv-field--with-clear">
                  <div class="mv-field-labelrow">
                    <span class="mv-field-title">name filter:</span>
                  </div>
                  <div class="mv-field-inputrow">
                    <input type="text"
                           :value="nameInput"
                           @input="onNameInput"
                           placeholder="Type part of a filename (not case-sensitive)" />
                    <button type="button"
                            class="mv-field-clear"
                            title="Clear name filter"
                            aria-label="Clear name filter"
                            @click="clearNameFilter">
                      <span class="mv-field-clear-x" aria-hidden="true">×</span>
                    </button>
                  </div>
                </div>
                <label v-show="filterVisibility.metadata_presence" class="mv-field">
                  <span>Comfy metadata (indexed PNG):</span>
                  <select v-model="filter.metadata_presence">
                    <option value="all">any</option>
                    <option value="yes">has metadata</option>
                    <option value="no">no metadata</option>
                  </select>
                </label>
                <label v-show="filterVisibility.prompt_mode" class="mv-field">
                  <span>prompt match mode:</span>
                  <select v-model="filter.prompt_match_mode">
                    <option value="prompt">Match phrase</option>
                    <option value="word">Match word</option>
                    <option value="string">Match string</option>
                  </select>
                </label>
                <div v-show="filterVisibility.prompt_tokens" class="mv-field mv-field--with-clear">
                  <div class="mv-field-labelrow">
                    <span class="mv-field-title">positive prompt filter:</span>
                  </div>
                  <div class="mv-field-inputrow mv-field-inputrow--ac">
                    <Autocomplete :fetch-kind="promptFetchKind"
                                  :vocab-match-mode="vocabAutocompleteMatch"
                                  :placeholder="promptFilterPlaceholder"
                                  :suggestions-off="filter.prompt_match_mode === 'string'"
                                  :model-value="promptInput"
                                  @update:model-value="setPromptInput"
                                  @commit="commitPromptTokens" />
                    <button type="button"
                            class="mv-field-clear"
                            title="Clear prompt filter"
                            aria-label="Clear prompt filter"
                            @click="clearPromptFilter">
                      <span class="mv-field-clear-x" aria-hidden="true">×</span>
                    </button>
                  </div>
                </div>
                <div v-show="filterVisibility.tags" class="mv-field mv-field--with-clear">
                  <div class="mv-field-labelrow">
                    <span class="mv-field-title">tag filter:</span>
                  </div>
                  <div class="mv-field-inputrow mv-field-inputrow--ac">
                    <Autocomplete fetch-kind="tags"
                                  :vocab-match-mode="vocabAutocompleteMatch"
                                  placeholder="Tags, comma-separated; suggestions as you type"
                                  :model-value="tagInput"
                                  @update:model-value="setTagInput"
                                  @commit="commitTagTokens" />
                    <button type="button"
                            class="mv-field-clear"
                            title="Clear tag filter"
                            aria-label="Clear tag filter"
                            @click="clearTagFilter">
                      <span class="mv-field-clear-x" aria-hidden="true">×</span>
                    </button>
                  </div>
                </div>
                <label v-show="filterVisibility.favorite" class="mv-field">
                  <span>favorite filter:</span>
                  <select v-model="filter.favorite">
                    <option value="all">all</option>
                    <option value="yes">favorite</option>
                    <option value="no">not favorite</option>
                  </select>
                </label>
                <label v-show="filterVisibility.model" class="mv-field">
                  <span>model filter:</span>
                  <ModelFilterPick v-model="filter.model"
                                   :options="knownModels"
                                   :disabled="panelCollapsed.filters" />
                </label>
                <fieldset v-show="filterVisibility.dates" class="mv-field mv-date">
                  <legend>date filter:</legend>
                  <label class="mv-date-row">
                    <input type="checkbox"
                           :checked="hasDateAfter"
                           @change="(e)=>onToggleDateBound('date_after', e.target.checked)" />
                    after:
                    <input type="date"
                           v-model="filter.date_after"
                           :disabled="!hasDateAfter" />
                  </label>
                  <label class="mv-date-row">
                    <input type="checkbox"
                           :checked="hasDateBefore"
                           @change="(e)=>onToggleDateBound('date_before', e.target.checked)" />
                    before:
                    <input type="date"
                           v-model="filter.date_before"
                           :disabled="!hasDateBefore" />
                  </label>
                </fieldset>
              </div>
              <div class="mv-filters-slack" aria-hidden="true"></div>
            </div>
          </section>
        </div>
        <div v-show="!panelCollapsed.filters"
             class="mv-splitter-h"
             role="separator"
             aria-orientation="horizontal"
             title="Drag to resize filter vs folder area"
             @mousedown.prevent="onSplitHDown"></div>
        <section class="mv-folders">
          <div class="mv-folders-title-row">
            <h3>Folders</h3>
            <button type="button"
                    class="ft-recursive"
                    :aria-pressed="filter.recursive ? 'true' : 'false'"
                    title="Include subfolders when a folder is selected"
                    @click="onToggleRecursive(!filter.recursive)">
              Recursive: {{ filter.recursive ? 'on' : 'off' }}
            </button>
          </div>
          <div v-if="foldersLoading && !folders.length" class="muted">Loading folders…</div>
          <div v-else-if="foldersError && !folders.length" class="error">
            <strong>{{ foldersError.code || 'error' }}</strong>: {{ foldersError.message }}
          </div>
          <div v-else class="mv-folders-scroll" ref="folderTreeScrollEl">
            <FolderTree :nodes="folders"
                        :selected-id="filter.folder_id"
                        :recursive="filter.recursive"
                        :show-recursive-button="false"
                        @select="onSelectFolder"
                        @update:recursive="onToggleRecursive"
                        @folders-changed="() => fetchFolders({ silent: true })" />
          </div>
        </section>
      </aside>
      <div class="mv-splitter-v"
           role="separator"
           aria-orientation="vertical"
           title="Drag to resize sidebar"
           @mousedown.prevent="onSplitVDown"></div>
      <section class="mv-main">
        <header class="mv-main-head">
          <span class="mv-count">
            <strong>{{ totalCount }}</strong>
            image<span v-if="totalCount !== 1">s</span>
            <span v-if="approximate" class="muted"> (approximate)</span>
          </span>
          <span v-show="developerMode" class="muted mv-sep">·</span>
          <span v-show="developerMode" class="muted">
            folder =
            <code v-if="filter.folder_id === null">all</code>
            <code v-else>#{{ filter.folder_id }}{{ filter.recursive ? ' (recursive)' : '' }}</code>
          </span>
        </header>

        <div class="mv-toolbar">
          <label class="mv-bulk">
            <input type="checkbox" v-model="bulkMode" />
            <span>Bulk edit</span>
          </label>
          <span class="mv-sep muted">·</span>
          <label class="mv-cpr">
            <span class="muted">Thumbs per row</span>
            <input type="range"
                   min="2" max="12" step="1"
                   :value="layoutState.cardsPerRow"
                   @input="onCardsPerRowInput" />
            <span class="mv-cpr-val">{{ layoutState.cardsPerRow }}</span>
          </label>
          <div class="mv-sort-group muted" role="group" aria-label="Sort images">
            <label class="mv-sort">
              <span>Sort by</span>
              <select v-model="sort.key" class="mv-sort-key">
                <option v-for="o in SORT_KEY_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </label>
            <button type="button"
                    class="mv-sort-dir"
                    :title="sort.dir === 'asc' ? 'Ascending' : 'Descending'"
                    :aria-label="sort.dir === 'asc' ? 'Ascending' : 'Descending'"
                    @click="toggleSortDir">{{ sort.dir === 'asc' ? '↑' : '↓' }}</button>
          </div>
          <span class="mv-sep muted">·</span>
          <span class="mv-view-toggle muted" role="group" aria-label="Gallery layout">
            <span class="mv-view-label">View</span>
            <button type="button"
                    class="mv-view-btn"
                    :class="{ 'mv-view-btn--on': galleryViewMode === 'compact' }"
                    :aria-pressed="galleryViewMode === 'compact' ? 'true' : 'false'"
                    @click="setViewMode('compact')">Compact</button>
            <button type="button"
                    class="mv-view-btn"
                    :class="{ 'mv-view-btn--on': galleryViewMode === 'line' }"
                    :aria-pressed="galleryViewMode === 'line' ? 'true' : 'false'"
                    @click="setViewMode('line')">Line</button>
          </span>
        </div>
        <BulkBar v-if="bulkMode" @moved="resetAndFetch" />

        <div v-if="imagesError" class="error">
          <strong>{{ imagesError.code || 'error' }}</strong>: {{ imagesError.message }}
        </div>
        <LineVirtualGrid v-else-if="galleryViewMode === 'line'"
                         :items="images"
                         :list-gen="gridListGen"
                         :cards-per-row="layoutState.cardsPerRow"
                         :total-estimate="totalCount"
                         :has-more="hasMore"
                         :loading="imagesLoading"
                         :loading-more="loadingMore"
                         :bulk-mode="bulkMode"
                         :sort-key="sort.key"
                         :sort-dir="sort.dir"
                         @load-more="loadMore"
                         @open="onOpenImage"
                         @toggle-bulk="onToggleBulk"
                         @toggle-favorite="onToggleFavorite"
                         @context="onContext" />
        <VirtualGrid v-else
                     :items="images"
                     :list-gen="gridListGen"
                     :cards-per-row="layoutState.cardsPerRow"
                     :total-estimate="totalCount"
                     :has-more="hasMore"
                     :loading="imagesLoading"
                     :loading-more="loadingMore"
                     :bulk-mode="bulkMode"
                     @load-more="loadMore"
                     @open="onOpenImage"
                     @toggle-bulk="onToggleBulk"
                     @toggle-favorite="onToggleFavorite"
                     @context="onContext" />

        <div v-if="contextMenu.open"
             class="mv-ctx"
             :style="{ left: contextMenu.x + 'px', top: contextMenu.y + 'px' }"
             @click.stop>
          <button type="button" @click="onCtxOpenDetail">Open detail</button>
          <button type="button" :disabled="ctxDownloadBusy" @click="onCtxDownload">
            {{ ctxDownloadBusy ? 'Downloading…' : 'Download image' }}
          </button>
          <button type="button" @click="onCtxMove">Move…</button>
          <button type="button" @click="onCtxDelete">Delete…</button>
        </div>
        <ConfirmModal
          v-if="deleteCtxOpen"
          title="Delete image"
          :lines="deleteCtxLines"
          confirm-label="Delete"
          cancel-label="Cancel"
          :danger="true"
          :busy="deleteCtxBusy"
          @cancel="closeDeleteCtx"
          @confirm="onDeleteCtxConfirmed"
        />
        <MovePicker v-if="movePickerOpen"
                    :forced-selection="movePickerSel"
                    :selection-count-hint="movePickerSelectionHint != null ? movePickerSelectionHint : undefined"
                    @close="closeMovePicker"
                    @done="resetAndFetch" />
      </section>
    </div>
  `,
});

export default MainView;
