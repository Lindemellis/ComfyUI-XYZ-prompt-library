// PLv3 — the main window's editor pane: one Monaco model per node, blur-sync to the
// node's widget.
//
// Everything that is *editing PLv3 text* — grammar, autocomplete, tag lookup, markers,
// span edits, library blur-sync — lives in PromptEditor (editor_core.js), because the
// library window edits the same kind of text and must behave identically. What is left
// here is the part that is genuinely about nodes: which document is open, and pushing
// it back into the graph.

import {
  PromptEditor,
  acquireNodeModel,
  releaseNodeModel,
  replaceTextPreservingFolding,
} from './editor_core.js';

// There is no positive/negative split any more (both compile identically), so this is
// always 'positive'. Kept because the compile params still carry a polarity field and
// the pure compiler still honours it — a document with a region simply must not be
// wired to a negative conditioning (documented, not enforced).
export function nodePolarity() {
  return 'positive';
}

function widget(node, name) {
  return node?.widgets?.find((w) => w.name === name);
}

export function nodeText(node) {
  return widget(node, 'text')?.value ?? '';
}

export class EditorPane extends PromptEditor {
  constructor(container, { onCompiled, onAst, onLibrarySynced } = {}) {
    super(container, {
      params: () => {
        const node = this.activeNode();
        return {
          seed: Number(widget(node, 'seed')?.value ?? 0),
          region_mode: widget(node, 'region_mode')?.value ?? 'couple',
          polarity: nodePolarity(node),
        };
      },
      onCompiled: (result) => onCompiled?.(result, this.activeNode()),
      onAst: (payload, meta) => onAst?.(payload, this.activeNode(), meta),
      onLibrarySynced: (paths) => onLibrarySynced?.(paths),
      // A detail-page control rewrote the text: the node's widget must not lag behind it.
      onEdited: () => this.syncActiveToNode(),
      // Spec §8.2: text is pushed back to the node on blur, not on every keystroke.
      onBlur: () => this.syncActiveToNode(),
    });
    this.models = new Map(); // nodeId -> { model, node }
    this.activeId = null;
  }

  activeNode() {
    return this.models.get(this.activeId)?.node ?? null;
  }

  open(node) {
    const id = String(node.id);
    let entry = this.models.get(id);

    if (!entry) {
      // The SHARED model: if the node's embedded Monaco editor already made one, the
      // window edits the very same document (live sync, folding never reset). For a
      // plain node the window is the first to ask, so it is created from the widget.
      entry = { model: acquireNodeModel(this.monaco, id, nodeText(node)), node };
      this.models.set(id, entry);
    } else {
      entry.node = node;
    }

    // Save the outgoing node's folding before the single window editor changes model,
    // then adopt the new node's folding. Keyed apart from the node's own editor.
    this.saveViewState();
    this.activeId = id;
    this.setModel(entry.model);
    this.bindViewState(`window:${id}`);
    this.focus();
    this.scheduleLint();
  }

  close(id) {
    id = String(id);
    const entry = this.models.get(id);
    if (!entry) return;
    this.syncToNode(id);
    releaseNodeModel(id);   // shared — dispose only when the embedded editor lets go too
    this.models.delete(id);
    if (this.activeId === id) {
      this.activeId = null;
      this.setModel(null);
    }
  }

  /** The node's own widget changed (typed into the plain node, undo, workflow load).
   *  A diff-edit rather than setValue so the window's own folding is not reset. When the
   *  model is shared with an embedded editor the change already IS in the model, so the
   *  equality guard inside makes this a no-op. */
  pushFromNode(id, value) {
    const entry = this.models.get(String(id));
    if (!entry) return;
    replaceTextPreservingFolding(entry.model, value ?? '');
  }

  syncActiveToNode() {
    if (this.activeId) this.syncToNode(this.activeId);
  }

  syncToNode(id) {
    const entry = this.models.get(String(id));
    if (!entry) return;
    const w = widget(entry.node, 'text');
    if (!w) return;
    const value = entry.model.getValue();
    if (w.value === value) return;
    w.value = value;
    // Route through the widget's callback so both node renderers (classic textarea and
    // the ComfyUI v2.0 Vue widget) see the change.
    w.callback?.call(entry.node, value);
    entry.node.graph?.setDirtyCanvas(true, true);
  }
}
