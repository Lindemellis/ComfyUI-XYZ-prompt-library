// T36 — Settings overlay: prefs, nav, tag admin (sort / inline rename / purge).
import {
  defineComponent, ref, reactive, onMounted, watch, computed,
} from 'vue';
import * as api from '../api.js';
import { Autocomplete } from '../components/Autocomplete.js';
import { describeVariant, fromVariant, toVariant } from '../stores/downloadVariant.js';
import { ConfirmModal } from '../components/ConfirmModal.js';
import { IconButton } from '../components/IconButton.js';
import {
  setVocabAutocompleteMatch,
  vocabAutocompleteMatch,
  resetLayoutToDefaults,
  applyServerPreferences,
  applyThemeToDocument,
  filtersPaneFitRequest,
  videoPrefs,
  setVideoPref,
} from '../stores/gallerySettings.js';

/** Same order as MainView sidebar filters (top → bottom). */
const FV_LABELS = [
  ['name', 'Name filter'],
  ['metadata_presence', 'Comfy metadata (indexed PNG)'],
  ['prompt_mode', 'Prompt match mode'],
  ['prompt_tokens', 'Positive prompt filter'],
  ['tags', 'Tag filter'],
  ['favorite', 'Favorite filter'],
  ['model', 'Model filter'],
  ['dates', 'Date filter'],
  ['media_kind', 'Media filter (images / videos)'],
];

function _fireFoldersRefresh() {
  try {
    window.dispatchEvent(new Event('xyz-gallery-folders-refresh'));
  } catch { /* ignore */ }
}

export const SettingsView = defineComponent({
  name: 'SettingsView',
  components: { Autocomplete, ConfirmModal, IconButton },
  props: {
    backHref: { type: String, default: '#/' },
  },
  setup(props) {
    const mainScrollEl = ref(null);
    const loading = ref(true);
    const saving = ref(false);
    const err = ref('');
    const form = reactive({
      downloadVariant: 'full',
      downloadPromptEachTime: false,
      downloadBasenamePrefix: '',
      developerMode: false,
      theme: 'dark',
      filterVisibility: {
        name: true,
        metadata_presence: true,
        prompt_mode: true,
        prompt_tokens: true,
        tags: true,
        favorite: true,
        model: true,
        dates: true,
        media_kind: true,
      },
    });

    // The stored preference is one variant string; the UI is the two questions it
    // answers. Proxying rather than storing two booleans keeps the wire format, the
    // `?variant=` links and the old saved value all working untouched.
    const dlKeepWorkflow = computed({
      get: () => fromVariant(form.downloadVariant).workflow,
      set: (v) => { form.downloadVariant = toVariant(!!v, dlKeepGen.value); },
    });
    const dlKeepGen = computed({
      get: () => fromVariant(form.downloadVariant).gen,
      set: (v) => { form.downloadVariant = toVariant(dlKeepWorkflow.value, !!v); },
    });
    const dlSummary = computed(() => describeVariant(form.downloadVariant));

    const vocabMatchLocal = ref(
      vocabAutocompleteMatch.value === 'contains' ? 'contains' : 'prefix',
    );
    watch(vocabMatchLocal, (v) => {
      setVocabAutocompleteMatch(v === 'contains' ? 'contains' : 'prefix');
    });

    const TAG_PAGE_SIZE = 10;

    const tagSearch = ref('');
    const tagRows = ref([]);
    const tagTotal = ref(0);
    const tagPage = ref(1);
    const tagBusy = ref(false);
    const tagMsg = ref('');
    const tagSortKey = ref('usage');
    const tagSortDir = ref('desc');
    const tagSearchDebounce = ref(null);

    const tagTotalPages = computed(() =>
      Math.max(1, Math.ceil((tagTotal.value || 0) / TAG_PAGE_SIZE)),
    );

    /** Page number shown in the jump box; kept in sync with ``tagPage`` (pager + load). */
    const tagJumpInput = ref('1');

    watch(tagPage, (p) => {
      tagJumpInput.value = String(p);
    }, { immediate: true });

    const editingFor = ref('');
    const editDraft = ref('');

    const purgeOpen = ref(false);
    const delOpen = ref(false);
    const delTarget = ref('');
    const delUsage = ref(0);
    const delBusy = ref(false);

    const roots = ref([]);
    const rootsBusy = ref(false);
    const newRootPath = ref('');
    const rootsErr = ref('');

    function scrollTo(anchor) {
      const root = mainScrollEl.value;
      const el = root && root.querySelector(`#${anchor}`);
      if (!root || !el) return;
      root.scrollTo({ top: Math.max(0, el.offsetTop - 10), behavior: 'smooth' });
    }

    async function load() {
      loading.value = true;
      err.value = '';
      try {
        const p = await api.fetchGalleryPreferences();
        if (p && typeof p === 'object') {
          if (typeof p.download_variant === 'string') {
            form.downloadVariant = p.download_variant;
          }
          if (typeof p.download_prompt_each_time === 'boolean') {
            form.downloadPromptEachTime = p.download_prompt_each_time;
          }
          form.downloadBasenamePrefix = String(p.download_basename_prefix || '');
          form.developerMode = !!p.developer_mode;
          form.theme = p.theme === 'light' ? 'light' : 'dark';
          if (p.filter_visibility && typeof p.filter_visibility === 'object') {
            Object.keys(form.filterVisibility).forEach((k) => {
              if (Object.prototype.hasOwnProperty.call(p.filter_visibility, k)) {
                form.filterVisibility[k] = !!p.filter_visibility[k];
              }
            });
          }
          applyServerPreferences(p);
          applyThemeToDocument();
        }
      } catch (e) {
        err.value = (e && e.message) ? String(e.message) : String(e);
      } finally {
        loading.value = false;
      }
    }

    async function loadRoots() {
      rootsBusy.value = true;
      rootsErr.value = '';
      try {
        const tree = await api.get('/folders', { query: { include_counts: 'false' } });
        roots.value = Array.isArray(tree) ? tree : [];
      } catch (e) {
        rootsErr.value = (e && e.message) ? String(e.message) : String(e);
        roots.value = [];
      } finally {
        rootsBusy.value = false;
      }
    }

    async function loadTagRows() {
      tagBusy.value = true;
      tagMsg.value = '';
      try {
        const off = (tagPage.value - 1) * TAG_PAGE_SIZE;
        const data = await api.get('/admin/tags', {
          query: {
            q: tagSearch.value.trim(),
            limit: String(TAG_PAGE_SIZE),
            offset: String(off),
            sort: tagSortKey.value,
            dir: tagSortDir.value,
          },
        });
        const rows = data && Array.isArray(data.tags) ? data.tags : [];
        const total = data && typeof data.total === 'number' ? data.total : rows.length;
        tagTotal.value = total;
        const maxPage = Math.max(1, Math.ceil(total / TAG_PAGE_SIZE) || 1);
        if (tagPage.value > maxPage) {
          tagPage.value = maxPage;
          tagBusy.value = false;
          return loadTagRows();
        }
        tagRows.value = rows;
      } catch (e) {
        tagMsg.value = (e && e.message) ? String(e.message) : String(e);
        tagRows.value = [];
        tagTotal.value = 0;
      } finally {
        tagBusy.value = false;
      }
    }

    function scheduleTagSearch() {
      if (tagSearchDebounce.value) clearTimeout(tagSearchDebounce.value);
      tagSearchDebounce.value = setTimeout(() => {
        tagSearchDebounce.value = null;
        tagPage.value = 1;
        void loadTagRows();
      }, 280);
    }

    function tagFirstPage() {
      if (tagPage.value !== 1) {
        tagPage.value = 1;
        void loadTagRows();
      }
    }
    function tagLastPage() {
      const lp = tagTotalPages.value;
      if (tagPage.value !== lp) {
        tagPage.value = lp;
        void loadTagRows();
      }
    }
    function tagPrevPage() {
      if (tagPage.value > 1) {
        tagPage.value -= 1;
        void loadTagRows();
      }
    }
    function tagNextPage() {
      if (tagPage.value < tagTotalPages.value) {
        tagPage.value += 1;
        void loadTagRows();
      }
    }
    function tagGoToPageFromInput() {
      const raw = parseInt(String(tagJumpInput.value).trim(), 10);
      const maxP = tagTotalPages.value;
      let p = Number.isFinite(raw) ? raw : 1;
      p = Math.min(maxP, Math.max(1, p));
      tagJumpInput.value = String(p);
      if (p !== tagPage.value) {
        tagPage.value = p;
        void loadTagRows();
      }
    }

    onMounted(() => {
      void load();
      void loadRoots();
      void loadTagRows();
      void loadBackfillCount();
    });

    watch([tagSortKey, tagSortDir], () => {
      tagPage.value = 1;
      void loadTagRows();
    });
    watch(tagSearch, () => { scheduleTagSearch(); });

    const saveFlashOk = ref(false);
    let saveFlashTimer = null;

    async function saveServerPrefs() {
      if (saveFlashTimer != null) {
        clearTimeout(saveFlashTimer);
        saveFlashTimer = null;
      }
      saveFlashOk.value = false;
      saving.value = true;
      err.value = '';
      try {
        const out = await api.patchGalleryPreferences({
          download_variant: form.downloadVariant,
          download_prompt_each_time: form.downloadPromptEachTime,
          download_basename_prefix: form.downloadBasenamePrefix,
          developer_mode: form.developerMode,
          theme: form.theme,
          filter_visibility: { ...form.filterVisibility },
        });
        applyServerPreferences(out);
        applyThemeToDocument();
        filtersPaneFitRequest.value += 1;
        saveFlashOk.value = true;
        saveFlashTimer = window.setTimeout(() => {
          saveFlashOk.value = false;
          saveFlashTimer = null;
        }, 850);
      } catch (e) {
        err.value = (e && e.message) ? String(e.message) : String(e);
      } finally {
        saving.value = false;
      }
    }

    function setTagSearchInput(v) {
      tagSearch.value = v;
    }
    function onTagSearchCommit() {
      tagPage.value = 1;
      void loadTagRows();
    }

    function startEdit(row) {
      if (!row || !row.name) return;
      editingFor.value = String(row.name);
      editDraft.value = String(row.name);
    }
    function cancelEdit() {
      editingFor.value = '';
      editDraft.value = '';
    }
    async function commitEdit() {
      const oldN = editingFor.value.trim();
      const newN = editDraft.value.trim();
      if (!oldN || !newN) {
        cancelEdit();
        return;
      }
      tagBusy.value = true;
      tagMsg.value = '';
      try {
        await api.post('/admin/tags/rename', { old_name: oldN, new_name: newN });
        tagMsg.value = 'Tag renamed.';
        cancelEdit();
        await loadTagRows();
      } catch (e) {
        tagMsg.value = (e && e.message) ? String(e.message) : String(e);
      } finally {
        tagBusy.value = false;
      }
    }

    function clickDelete(row) {
      if (!row) return;
      delTarget.value = String(row.name);
      delUsage.value = Number(row.usage_count) || 0;
      delOpen.value = true;
    }
    function closeDel() {
      delOpen.value = false;
      delTarget.value = '';
      delUsage.value = 0;
    }
    async function confirmDel() {
      delBusy.value = true;
      tagMsg.value = '';
      try {
        await api.post('/admin/tags/delete', { name: delTarget.value });
        tagMsg.value = `Removed tag “${delTarget.value}”.`;
        closeDel();
        await loadTagRows();
      } catch (e) {
        tagMsg.value = (e && e.message) ? String(e.message) : String(e);
      } finally {
        delBusy.value = false;
      }
    }

    const delLines = () => {
      const u = delUsage.value;
      if (u > 0) {
        return [
          `Delete tag “${delTarget.value}” (${u} image(s))?`,
          'This removes the tag from the vocabulary and from every image that uses it.',
        ];
      }
      return [`Delete unused tag “${delTarget.value}”?`];
    };

    async function confirmPurge() {
      tagBusy.value = true;
      tagMsg.value = '';
      try {
        const r = await api.post('/admin/tags/purge_zero', {});
        const n = r && typeof r.removed === 'number' ? r.removed : 0;
        tagMsg.value = `Removed ${n} unused tag row(s).`;
        purgeOpen.value = false;
        await loadTagRows();
      } catch (e) {
        tagMsg.value = (e && e.message) ? String(e.message) : String(e);
      } finally {
        tagBusy.value = false;
      }
    }

    // Metadata backfill. `steps` only started being recorded in schema v7, so images
    // indexed before it have none — and the value is in the PNG, not in the database.
    // Re-reading the library is minutes of disk, so it is a button, never automatic.
    const backfillBusy = ref(false);
    const backfillMsg = ref('');
    const backfillMissing = ref(null);

    async function loadBackfillCount() {
      try {
        const r = await api.get('/admin/backfill_steps');
        backfillMissing.value = (r && typeof r.missing === 'number') ? r.missing : null;
      } catch {
        backfillMissing.value = null;
      }
    }

    async function runBackfill() {
      backfillBusy.value = true;
      backfillMsg.value = '';
      try {
        const r = await api.post('/admin/backfill_steps', {});
        const n = (r && typeof r.queued === 'number') ? r.queued : 0;
        backfillMsg.value = n === 0
          ? 'Nothing to re-read — every image already has its metadata.'
          : `Queued ${n} image(s). The sync worker reads them in the background; `
            + 'reopen an image to see the result.';
        await loadBackfillCount();
      } catch (e) {
        backfillMsg.value = (e && e.message) ? String(e.message) : String(e);
      } finally {
        backfillBusy.value = false;
      }
    }

    async function addCustomRoot() {
      rootsBusy.value = true;
      rootsErr.value = '';
      try {
        await api.post('/folders', { path: newRootPath.value.trim() });
        newRootPath.value = '';
        await loadRoots();
        _fireFoldersRefresh();
      } catch (e) {
        rootsErr.value = (e && e.message) ? String(e.message) : String(e);
      } finally {
        rootsBusy.value = false;
      }
    }

    async function removeRoot(node) {
      if (!node || !node.removable) return;
      rootsBusy.value = true;
      rootsErr.value = '';
      try {
        await api.del(`/folders/${node.id}`);
        await loadRoots();
        _fireFoldersRefresh();
      } catch (e) {
        rootsErr.value = (e && e.message) ? String(e.message) : String(e);
      } finally {
        rootsBusy.value = false;
      }
    }

    function onLayoutReset() {
      resetLayoutToDefaults();
      window.location.hash = '#/';
      window.location.reload();
    }

    function toggleSortDir() {
      tagSortDir.value = tagSortDir.value === 'asc' ? 'desc' : 'asc';
    }

    const tagAcMatch = ref('contains');

    const backHref = computed(() => props.backHref);

    return {
      backHref,
      mainScrollEl,
      loading,
      saving,
      err,
      form,
      vocabMatchLocal,
      saveServerPrefs,
      saveFlashOk,
      FV_LABELS,
      videoPrefs,
      setVideoPref,
      scrollTo,
      tagSearch,
      tagRows,
      tagTotal,
      tagPage,
      tagTotalPages,
      tagFirstPage,
      tagLastPage,
      tagPrevPage,
      tagNextPage,
      tagJumpInput,
      tagGoToPageFromInput,
      tagBusy,
      tagMsg,
      dlKeepWorkflow,
      dlKeepGen,
      dlSummary,
      backfillBusy,
      backfillMsg,
      backfillMissing,
      runBackfill,
      loadBackfillCount,
      tagSortKey,
      tagSortDir,
      toggleSortDir,
      setTagSearchInput,
      onTagSearchCommit,
      editingFor,
      editDraft,
      startEdit,
      cancelEdit,
      commitEdit,
      purgeOpen,
      delOpen,
      delBusy,
      clickDelete,
      closeDel,
      confirmDel,
      delLines,
      confirmPurge,
      roots,
      rootsBusy,
      rootsErr,
      newRootPath,
      addCustomRoot,
      removeRoot,
      onLayoutReset,
      tagAcMatch,
    };
  },
  template: `
    <div class="gs-window-inner">
      <header class="gs-win-toolbar">
        <IconButton :href="backHref" class="ib" text="Back" title="Close settings" />
        <h1 id="gs-dialog-title" class="gs-toolbar-title">Settings</h1>
        <button type="button"
                class="gs-btn primary gs-toolbar-save"
                :class="{ 'gs-toolbar-save--ok': saveFlashOk }"
                :disabled="saving || loading" @click="saveServerPrefs">
          {{ saving ? 'Saving…' : 'Save preferences' }}
        </button>
      </header>
      <p v-if="loading" class="muted gs-win-loading">Loading preferences…</p>
      <p v-if="err" class="error gs-toolbar-err">{{ err }}</p>
      <div v-if="!loading" class="gs-win-body">
        <nav class="gs-win-side" aria-label="Settings sections">
          <a href="#gs-appearance" @click.prevent="scrollTo('gs-appearance')">Appearance</a>
          <a href="#gs-filters" @click.prevent="scrollTo('gs-filters')">Filter visibility</a>
          <a href="#gs-video" @click.prevent="scrollTo('gs-video')">Video</a>
          <a href="#gs-download" @click.prevent="scrollTo('gs-download')">Download</a>
          <a href="#gs-autocomplete" @click.prevent="scrollTo('gs-autocomplete')">Autocomplete</a>
          <a href="#gs-tags" @click.prevent="scrollTo('gs-tags')">Tags</a>
          <a href="#gs-roots" @click.prevent="scrollTo('gs-roots')">Custom roots</a>
          <a href="#gs-layout" @click.prevent="scrollTo('gs-layout')">Layout</a>
        </nav>
        <div class="gs-win-main" ref="mainScrollEl">
          <section id="gs-appearance" class="gs-sec">
            <h2>Appearance</h2>
            <label class="gs-row">
              <input type="radio" name="th" value="dark" v-model="form.theme" />
              <span>Dark</span>
            </label>
            <label class="gs-row">
              <input type="radio" name="th" value="light" v-model="form.theme" />
              <span>Light</span>
            </label>
            <label class="gs-row">
              <input type="checkbox" v-model="form.developerMode" />
              <span>Developer mode (show internal ids in list/detail)</span>
            </label>
          </section>
          <section id="gs-filters" class="gs-sec gs-sec--fv">
            <h2>Main view — filter visibility</h2>
            <p class="muted gs-hint">Hidden filters are not sent to the server until shown again.</p>
            <div class="gs-fv-list">
              <label class="gs-fv-item" v-for="([key, lbl]) in FV_LABELS" :key="key">
                <input type="checkbox" v-model="form.filterVisibility[key]" />
                <span>{{ lbl }}</span>
              </label>
            </div>
          </section>
          <section id="gs-video" class="gs-sec">
            <h2>Video</h2>
            <p class="muted gs-hint">
              These are remembered in this browser only — they describe how this
              machine should play clips, not what the library contains.
            </p>
            <label class="gs-row">
              <input type="checkbox"
                     :checked="videoPrefs.hoverPreview"
                     @change="(e)=>setVideoPref('hoverPreview', e.target.checked)" />
              <span>Play a muted preview when the pointer rests on a video card</span>
            </label>
            <label class="gs-row">
              <input type="checkbox"
                     :checked="videoPrefs.autoplay"
                     @change="(e)=>setVideoPref('autoplay', e.target.checked)" />
              <span>Start playing as soon as a video is opened</span>
            </label>
            <p v-if="videoPrefs.autoplay && !videoPrefs.muted" class="muted gs-hint">
              With "start muted" off, the browser may refuse to autoplay until you
              interact with the page — the clip then waits on its first frame.
            </p>
            <label class="gs-row">
              <input type="checkbox"
                     :checked="videoPrefs.loop"
                     @change="(e)=>setVideoPref('loop', e.target.checked)" />
              <span>Loop by default on the detail page</span>
            </label>
            <label class="gs-row">
              <input type="checkbox"
                     :checked="videoPrefs.muted"
                     @change="(e)=>setVideoPref('muted', e.target.checked)" />
              <span>Start muted</span>
            </label>
            <p class="muted gs-hint">
              Volume is remembered separately, from wherever you last left the slider.
            </p>
          </section>
          <section id="gs-download" class="gs-sec">
            <h2>Download (PNG)</h2>
            <label class="gs-row">
              <input type="checkbox" v-model="form.downloadPromptEachTime" />
              <span>Ask every time (bulk, thumbnail menu, detail) which metadata to include</span>
            </label>
            <p v-if="form.downloadPromptEachTime" class="muted gs-hint">
              The dialog starts with whatever you ticked last; these two are that memory.
            </p>
            <p v-else class="muted gs-hint">What every download carries, with no dialog.</p>
            <label class="gs-row">
              <input type="checkbox" v-model="dlKeepWorkflow" />
              <span>Workflow — the editor graph, so the image can be dragged back into ComfyUI</span>
            </label>
            <label class="gs-row">
              <input type="checkbox" v-model="dlKeepGen" />
              <span>Generation data — prompt, seed, steps, sampler</span>
            </label>
            <p class="muted gs-hint">{{ dlSummary }}</p>
            <p class="muted gs-hint">
              Applies to PNG only — stripping these rewrites PNG text chunks. Videos,
              JPEGs and WebPs always download exactly as they are on disk.
            </p>
            <label class="gs-row gs-row--select">
              <span>Download filename prefix (optional)</span>
              <input type="text" class="gs-input" v-model="form.downloadBasenamePrefix"
                     maxlength="64" placeholder="e.g. batch1" />
            </label>
          </section>
          <section id="gs-autocomplete" class="gs-sec">
            <h2>Autocomplete</h2>
            <label class="gs-row gs-row--select">
              <span>Suggestion match</span>
              <select v-model="vocabMatchLocal" class="gs-select">
                <option value="prefix">Prefix only</option>
                <option value="contains">Substring</option>
              </select>
            </label>
          </section>
          <section id="gs-tags" class="gs-sec">
            <h2>Tag management</h2>
            <div class="gs-tag-toolbar">
              <Autocomplete fetch-kind="tags"
                            class="gs-tag-ac"
                            :vocab-match-mode="tagAcMatch"
                            placeholder="Search tag names…"
                            :model-value="tagSearch"
                            @update:model-value="setTagSearchInput"
                            @commit="onTagSearchCommit" />
              <div class="gs-tag-sort-group">
                <span class="gs-tag-sort-label">Sort</span>
                <select v-model="tagSortKey" class="gs-select gs-select--toolbar">
                  <option value="name">Name</option>
                  <option value="usage">Usage</option>
                </select>
                <button type="button" class="gs-icon-btn"
                        :title="tagSortDir === 'asc' ? 'Ascending' : 'Descending'"
                        @click="toggleSortDir">{{ tagSortDir === 'asc' ? '↑' : '↓' }}</button>
              </div>
              <button type="button" class="gs-btn" :disabled="tagBusy" @click="purgeOpen = true">
                Remove all unused tags…
              </button>
            </div>
            <div class="gs-table-wrap">
              <table class="gs-table gs-tag-table">
                <thead>
                  <tr>
                    <th class="gs-th-tag">Tag</th>
                    <th class="gs-th-usage">Usage</th>
                    <th class="gs-th-edit"></th>
                    <th class="gs-th-del"></th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in tagRows" :key="row.name">
                    <td>
                      <template v-if="editingFor === row.name">
                        <input type="text" class="gs-input gs-input--inline" v-model="editDraft" />
                        <button type="button" class="gs-icon-btn gs-ok" title="Save rename" @click="commitEdit">✓</button>
                        <button type="button" class="gs-icon-btn" title="Cancel" @click="cancelEdit">×</button>
                      </template>
                      <template v-else>
                        <code class="gs-tag-name" @dblclick="startEdit(row)">{{ row.name }}</code>
                      </template>
                    </td>
                    <td>{{ row.usage_count }}</td>
                    <td>
                      <button type="button" class="gs-icon-btn" title="Rename" :disabled="tagBusy"
                              @click="startEdit(row)">✎</button>
                    </td>
                    <td>
                      <button type="button" class="gs-btn gs-btn-danger-text" :disabled="tagBusy"
                              @click="clickDelete(row)">Delete</button>
                    </td>
                  </tr>
                </tbody>
              </table>
              <p v-if="!tagRows.length && !tagBusy" class="muted gs-hint">No tags match the current search.</p>
            </div>
            <div v-if="tagTotal > 0" class="gs-tag-pager">
              <button type="button" class="gs-btn" :disabled="tagBusy || tagPage <= 1"
                      @click="tagFirstPage">First</button>
              <button type="button" class="gs-btn" :disabled="tagBusy || tagPage <= 1"
                      @click="tagPrevPage">Previous</button>
              <span class="gs-tag-pager-jump muted gs-tag-pager-meta">
                <span>Page</span>
                <input type="number" class="gs-input gs-tag-page-input" :min="1" :max="tagTotalPages"
                       v-model="tagJumpInput" @keyup.enter="tagGoToPageFromInput" />
                <span>/ {{ tagTotalPages }}</span>
                <button type="button" class="gs-btn gs-btn--compact" :disabled="tagBusy"
                        @click="tagGoToPageFromInput">Go</button>
              </span>
              <span class="muted gs-tag-pager-meta gs-tag-pager-count">{{ tagTotal }} tag(s)</span>
              <button type="button" class="gs-btn" :disabled="tagBusy || tagPage >= tagTotalPages"
                      @click="tagNextPage">Next</button>
              <button type="button" class="gs-btn" :disabled="tagBusy || tagPage >= tagTotalPages"
                      @click="tagLastPage">Last</button>
            </div>
            <p v-if="tagMsg" class="gs-tagmsg">{{ tagMsg }}</p>
          </section>
          <section id="gs-backfill" class="gs-sec">
            <h2>Image metadata</h2>
            <p class="muted gs-hint">
              Some images show blank generation data — either they were indexed before
              a field existed, or their workflow used nodes the reader has since learned
              to follow. This re-reads them in the background. It never touches the
              files, and it is safe to run again.
            </p>
            <div class="gs-row">
              <button type="button" class="gs-btn" :disabled="backfillBusy"
                      @click="runBackfill">
                {{ backfillBusy ? 'Queueing…' : 'Re-read missing metadata' }}
              </button>
              <span v-if="backfillMissing != null" class="muted">
                {{ backfillMissing }} image(s) have incomplete generation data
              </span>
            </div>
            <p v-if="backfillMsg" class="gs-tagmsg">{{ backfillMsg }}</p>
          </section>
          <section id="gs-roots" class="gs-sec">
            <h2>Custom image roots</h2>
            <p class="muted gs-hint">Output/input are fixed. Add a readable directory path.</p>
            <p v-if="rootsErr" class="error">{{ rootsErr }}</p>
            <ul class="gs-roots">
              <li v-for="n in roots" :key="n.id">
                <code>{{ n.display_name || n.path }}</code>
                <span class="muted">({{ n.kind }})</span>
                <button v-if="n.removable" type="button" class="gs-btn" :disabled="rootsBusy"
                        @click="removeRoot(n)">Remove</button>
              </li>
            </ul>
            <div class="gs-row gs-row--select">
              <input type="text" class="gs-input" v-model="newRootPath" placeholder="Absolute folder path" />
              <button type="button" class="gs-btn" :disabled="rootsBusy" @click="addCustomRoot">Add root</button>
            </div>
          </section>
          <section id="gs-layout" class="gs-sec">
            <h2>Layout</h2>
            <button type="button" class="gs-btn" @click="onLayoutReset">Reset layout to default</button>
          </section>
        </div>
      </div>
      <ConfirmModal
        v-if="purgeOpen"
        title="Remove all unused tags"
        :lines="['Delete every tag row with usage_count = 0?', 'This cannot be undone.']"
        confirm-label="Remove all"
        cancel-label="Cancel"
        :danger="true"
        :busy="tagBusy"
        @cancel="purgeOpen = false"
        @confirm="confirmPurge"
      />
      <ConfirmModal
        v-if="delOpen"
        title="Delete tag"
        :lines="delLines()"
        confirm-label="Delete"
        cancel-label="Cancel"
        :danger="true"
        :busy="delBusy"
        @cancel="closeDel"
        @confirm="confirmDel"
      />
    </div>
  `,
});

export default SettingsView;
