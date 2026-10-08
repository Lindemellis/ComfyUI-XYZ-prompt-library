// Bind the existing PromptEditor to a DocumentSession; never fork its grammar,
// completion providers, weight shortcuts or Monaco lifecycle.
import { normalizePromptInput } from './prompt_text.js';
const bindings = new WeakMap();

export function bindPromptEditor(pane, session, { onError = console.error, onDraft = () => {} } = {}) {
  const model = pane.model();
  if (!model || pane.editSession) throw new Error('bind one initialized PromptEditor model at a time');
  const existing = bindings.get(model);
  if (existing) {
    if (existing.session !== session) throw new Error('one model cannot edit different documents');
    const blur = pane.editor?.onDidBlurEditorText?.(() => session.commitPool?.().catch(onError));
    pane.editSession = session;
    existing.panes.add(pane);
    return { dispose() { blur?.dispose(); existing.panes.delete(pane); if (pane.editSession === session) pane.editSession = null; if (!existing.panes.size) existing.dispose(); } };
  }
  pane.editSession = session;
  const blur = pane.editor?.onDidBlurEditorText?.(() => session.commitPool?.().catch(onError));
  const panes = new Set([pane]);
  const oldSession = model.__plv4Session;
  model.__plv4Session = session;
  let writing = false;
  let typing = 0;
  let disposed = false;
  const currentPane = () => [...panes].find(p => p.model() === model && p.editSession === session);
  const matches = () => !disposed && !!currentPane();

  const sync = () => {
    if (!matches() || typing) return;
    writing = true;
    try {
      currentPane().setText(session.text);
      for (const view of panes) view.setDoc(session.state.doc);
    } finally { writing = false; }
  };
  sync();
  // The shared model can have a node and window view; one listener creates one edit.
  const change = (model.onDidChangeContent ?? pane.editor.onDidChangeModelContent).call(model.onDidChangeContent ? model : pane.editor, () => {
    if (!matches() || writing) return;
    const text = normalizePromptInput(model.getValue());
    onDraft(text);
    typing++;
    session.replaceText(text, { deferPool: true }).then(() => {
      typing--;
      sync();
      if (matches()) for (const view of panes) view.scheduleLint();
    }, error => { typing--; onError(error); });
  });
  const unsubscribe = session.subscribe(({ reason }) => {
    if (!matches() || reason === 'View') return;
    sync();
    for (const view of panes) view.scheduleLint();
  });

  // Monaco's keyboard shortcuts, context menu and UndoCommand all call these
  // public model methods. Route them to the same document history used by Block
  // UI, including invisible switches that generate no text edit at all.
  const ownUndo = Object.hasOwn(model, 'undo');
  const ownRedo = Object.hasOwn(model, 'redo');
  const oldUndo = model.undo;
  const oldRedo = model.redo;
  const undo = () => session.undo().catch(onError);
  const redo = () => session.redo().catch(onError);
  model.undo = undo;
  model.redo = redo;

  const shared = {
    session, panes,
    dispose() {
      if (disposed) return;
      disposed = true;
      change.dispose();
      unsubscribe();
      if (model.undo === undo) { if (ownUndo) model.undo = oldUndo; else delete model.undo; }
      if (model.redo === redo) { if (ownRedo) model.redo = oldRedo; else delete model.redo; }
      if (model.__plv4Session === session) { if (oldSession) model.__plv4Session = oldSession; else delete model.__plv4Session; }
      for (const view of panes) if (view.editSession === session) view.editSession = null;
      panes.clear(); bindings.delete(model);
    },
  };
  bindings.set(model, shared);
  return { dispose() { blur?.dispose(); panes.delete(pane); if (pane.editSession === session) pane.editSession = null; if (!panes.size) shared.dispose(); } };
}
