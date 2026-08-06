// stores/selection.js — T23 Selection envelope (SPEC §6.2) for bulk API bodies.
import { reactive, toRaw, watch } from 'vue';
import { filterState } from './filters.js';

/**
 * @returns {Record<string, unknown>}
 */
function filterWire() {
  const f = filterState.filter;
  return {
    name: f.name || '',
    positive_tokens: Array.isArray(f.positive_tokens) ? [...f.positive_tokens] : [],
    tag_tokens: Array.isArray(f.tag_tokens) ? [...f.tag_tokens] : [],
    favorite: f.favorite || 'all',
    model: f.model || '',
    date_after: f.date_after || '',
    date_before: f.date_before || '',
    folder_id: f.folder_id,
    recursive: !!f.recursive,
    metadata_presence: f.metadata_presence || 'all',
    prompt_match_mode: f.prompt_match_mode || 'prompt',
  };
}

/**
 * - ``explicit`` — hand-picked id map
 * - ``all_except`` — filter snapshot + ``excluded`` deselected ids
 */
export const selectionState = reactive({
  mode: 'explicit', // 'explicit' | 'all_except'
  /** @type {Record<number, true>} */
  explicit: {},
  allExceptFilters: null,
  /** @type {Record<number, true>} */
  excluded: {},
});

function _filterWireJson() {
  return JSON.stringify(filterWire());
}

/** True when ``all_except`` rowset snapshot no longer matches the live filter bar. */
export function allExceptSelectionIsStale() {
  if (selectionState.mode !== 'all_except') return false;
  if (selectionState.allExceptFilters == null) return false;
  return JSON.stringify(selectionState.allExceptFilters) !== _filterWireJson();
}

watch(
  () => _filterWireJson(),
  (_json, oldJson) => {
    if (oldJson === undefined) return;
    if (allExceptSelectionIsStale()) resetSelection();
  },
);

export function filterSnapshotForAllExcept() {
  return filterWire();
}

export function resetSelection() {
  selectionState.mode = 'explicit';
  selectionState.explicit = {};
  selectionState.allExceptFilters = null;
  selectionState.excluded = {};
}

export function setSelectAllInView() {
  selectionState.mode = 'all_except';
  selectionState.allExceptFilters = filterWire();
  selectionState.explicit = {};
  selectionState.excluded = {};
}

export function toggleCardInSelection(id) {
  const n = Number(id);
  if (!Number.isFinite(n) || n < 1) return;
  if (allExceptSelectionIsStale()) {
    resetSelection();
  }
  if (selectionState.mode === 'explicit') {
    if (selectionState.explicit[n]) delete selectionState.explicit[n];
    else selectionState.explicit[n] = true;
  } else {
    if (selectionState.excluded[n]) delete selectionState.excluded[n];
    else selectionState.excluded[n] = true;
  }
}

export function isCardSelectedInBulk(id) {
  const n = Number(id);
  if (selectionState.mode === 'explicit') return !!selectionState.explicit[n];
  if (allExceptSelectionIsStale()) return false;
  return !selectionState.excluded[n];
}

/**
 * @returns {object | null} wire ``Selection`` or null when explicit and nothing picked
 */
export function buildWireSelection() {
  if (selectionState.mode === 'explicit') {
    const raw = toRaw(selectionState.explicit);
    const ids = Object.keys(raw || {})
      .map((k) => Number(k))
      .filter((x) => x >= 1);
    if (!ids.length) return null;
    return { mode: 'explicit', ids };
  }
  if (allExceptSelectionIsStale()) return null;
  return {
    mode: 'all_except',
    filters: selectionState.allExceptFilters || filterWire(),
    excluded_ids: Object.keys(selectionState.excluded).map((k) => Number(k)),
  };
}

/** The explicitly ticked ids, ascending.
 *
 *  Empty in ``all_except`` mode ON PURPOSE: that mode means "everything matching the
 *  filter", which can be thousands of rows and is only ever sent to the server as a
 *  filter, never as a list. An action that needs actual ids (sending images to Krita
 *  as layers, say) must not silently turn into eight thousand of them.
 */
export function selectedExplicitIds() {
  if (selectionState.mode !== 'explicit') return [];
  return Object.keys(selectionState.explicit).map(Number).sort((a, b) => a - b);
}

export function selectedExplicitCount() {
  return Object.keys(selectionState.explicit).length;
}
