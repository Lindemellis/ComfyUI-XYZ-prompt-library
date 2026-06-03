/**
 * Prompt Library V2 — backend glue for the rich editor's inline ref-expansion islands.
 *
 * Produces the three callbacks the generic rich editor (plv2_richedit.js) needs, bound
 * to the live PLv2 API + the shared raw_text reconciliation (plv2_raw_sync.js). Keeping
 * this separate keeps the editor component pure/testable; here is where the islands
 * actually talk to the library and where an island edit is committed the SAME way the
 * entry detail window commits a text-box edit (single source of truth).
 *
 *   resolveRef(name)      → Promise<boolean>  is this ref expandable? (caches its node id)
 *   loadEntry(name)       → Promise<string>   the referenced entry's editable text
 *                                             (raw_text, or rebuilt — exactly the entry box)
 *   saveEntry(name, text) → Promise<void>     reconcile prompts/overrides + persist raw_text,
 *                                             then notify the entry window + preview
 *   nodeIdForRef(name)    → number|undefined  last-resolved node id (for entry-changed → refresh)
 *   openRefsForNode(...)  helper left to the editor (it tracks open islands)
 */

export function createIslandBackend(deps = {}) {
  // Resolve window.plv2.* LAZILY (at call time, not construction) — this factory may
  // run at module load, before plv2.js has created window.plv2.
  const _api            = () => deps.api            || window.plv2.api;
  const _rawSync        = () => deps.rawSync        || window.plv2.rawSync;
  const _cleanPrompt    = () => deps.cleanPrompt    || window.plv2.cleanPrompt;
  const _normalizePrompt = () => deps.normalizePrompt || window.plv2.normalizePrompt;
  const dispatch        = deps.dispatch || ((name, detail) => document.dispatchEvent(new CustomEvent(name, { detail })));

  const nodeIdByRef = new Map();   // ref name → resolved node id (refreshed on every resolve)

  async function _resolveNode(name) {
    try {
      const node = (await _api().resolveRef(name))?.node;
      if (node) nodeIdByRef.set(name, node.id); else nodeIdByRef.delete(name);
      return node || null;
    } catch { return null; }
  }

  async function _fetchPrompts(node) {
    const [pr, inh] = await Promise.all([_api().getPrompts(node.id), _api().getInherited(node.id)]);
    return { ownPrompts: pr?.prompts ?? [], tplPrompts: inh?.prompts ?? [] };
  }

  return {
    nodeIdForRef: (name) => nodeIdByRef.get(name),

    resolveRef: async (name) => !!(await _resolveNode(name)),

    loadEntry: async (name) => {
      const node = await _resolveNode(name);
      if (!node) return '';
      const { ownPrompts, tplPrompts } = await _fetchPrompts(node);
      return _rawSync().initialText({
        rawText: node.raw_text || '', ownPrompts, tplPrompts,
        delimiter: node.delimiter || ', ', cleanPrompt: _cleanPrompt(),
      });
    },

    // Sub-entry names of the entry `name` (own children + inherited template children) —
    // the [this.x] autocomplete candidates inside that entry's island. Mirrors the entry
    // detail box's getThisRefs (own _children + _tplChildren).
    loadThisRefs: async (name) => {
      const node = await _resolveNode(name);
      if (!node) return [];
      const [nodesRes, inh] = await Promise.all([_api().getNodes(), _api().getInherited(node.id)]);
      const own = (nodesRes?.nodes ?? []).filter(n => n.parent_id === node.id && n.has_prompts).map(n => n.name);
      const tpl = (inh?.children ?? []).map(c => c.name);
      return [...own, ...tpl];
    },

    // Commit an island edit exactly like the entry detail text box does: re-fetch the
    // entry's current prompts (avoids stale state), reconcile via the shared pipeline,
    // persist raw_text, then notify so the entry window / preview follow.
    saveEntry: async (name, text) => {
      const node = await _resolveNode(name);
      if (!node) return;
      const { ownPrompts, tplPrompts } = await _fetchPrompts(node);
      try {
        await _rawSync().syncRawText({
          api: _api(), cleanPrompt: _cleanPrompt(), normalizePrompt: _normalizePrompt(), nodeId: node.id,
          delimiter: node.delimiter || ', ', rawText: text, ownPrompts, tplPrompts,
        });
        await _api().updateNode(node.id, { raw_text: text });
      } catch (e) { console.error('[PLv2] island saveEntry failed', e); return; }
      dispatch('plv2:entry-changed', { nodeId: node.id });
      dispatch('plv2:entry-content-changed', { nodeId: node.id });
      dispatch('plv2:editor-changed', { immediate: true });
    },
  };
}
