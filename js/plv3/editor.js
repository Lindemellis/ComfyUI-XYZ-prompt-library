// PLv3 — the main window's editor pane: one Monaco model per node, blur-sync to the
// node's widget.
//
// Everything that is *editing PLv3 text* — grammar, autocomplete, tag lookup, markers,
// span edits, library blur-sync — lives in PromptEditor (editor_core.js), because the
// library window edits the same kind of text and must behave identically. What is left
// here is the part that is genuinely about nodes: which document is open, and pushing
// it back into the graph.

import { PromptEditor } from './editor_core.js';

export function nodePolarity(node) {
  return node?.comfyClass?.endsWith('Negative') ? 'negative' : 'positive';
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
      entry = { model: this.createModel(nodeText(node)), node };
      this.models.set(id, entry);
    } else {
      entry.node = node;
    }

    this.activeId = id;
    this.setModel(entry.model);
    this.focus();
    this.scheduleLint();
  }

  close(id) {
    id = String(id);
    const entry = this.models.get(id);
    if (!entry) return;
    this.syncToNode(id);
    entry.model.dispose();
    this.models.delete(id);
    if (this.activeId === id) {
      this.activeId = null;
      this.setModel(null);
    }
  }

  /** The node's own widget changed (typed into the node, undo, workflow load). */
  pushFromNode(id, value) {
    const entry = this.models.get(String(id));
    if (!entry) return;
    if (entry.model.getValue() === value) return;
    entry.model.setValue(value ?? '');
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
