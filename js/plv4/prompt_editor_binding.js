// Bind the existing PromptEditor to a DocumentSession; never fork its grammar,
// completion providers, weight shortcuts or Monaco lifecycle.
import { normalizePromptInput } from './prompt_text.js';
import { draftCompletions } from './text_draft.js';
const bindings = new WeakMap();

export function bindPromptEditor(pane, session, { onError = console.error, onDraft = () => {} } = {}) {
  const model = pane.model();
  if (!model || pane.editSession) throw new Error('bind one initialized PromptEditor model at a time');
  const existing = bindings.get(model);
  if (existing) {
    if (existing.session !== session) throw new Error('one model cannot edit different documents');
    const blur = pane.editor?.onDidBlurEditorText?.(() => existing.flush().then(() => session.commitPool?.()).catch(onError));
    pane.editSession = session;
    pane.flushDraft = existing.flush;
    existing.panes.add(pane);
    return { flush: existing.flush, dispose() { blur?.dispose(); existing.panes.delete(pane); if (pane.flushDraft === existing.flush) delete pane.flushDraft; if (pane.editSession === session) pane.editSession = null; if (!existing.panes.size) existing.dispose(); } };
  }
  pane.editSession = session;
  const panes = new Set([pane]);
  const oldSession = model.__plv4Session;
  model.__plv4Session = session;
  let writing = false;
  let typing = 0;
  let disposed = false;
  let draft = null, completions = [], observed = normalizePromptInput(model.getValue()), pending = Promise.resolve();
  const currentPane = () => [...panes].find(p => p.model() === model && p.editSession === session);
  const matches = () => !disposed && !!currentPane();

  const sync = () => {
    if (!matches() || typing || draft != null) return;
    writing = true;
    try {
      currentPane().setText(session.text);
      observed = normalizePromptInput(model.getValue());
      for (const view of panes) view.setDoc(session.state.doc);
    } finally { writing = false; }
  };
  sync();
  const flush = () => {
    pending = pending.then(async () => {
      while (!disposed && draft != null) {
        const text = draft, provenance = completions;
        typing++;
        try {
          await session.replaceText(text, { deferPool: true, completion: provenance.length ? provenance : null });
          if (draft === text) { draft = null; completions = []; }
        } finally { typing--; }
      }
      sync();
      if (matches()) for (const view of panes) view.scheduleLint();
    });
    const result = pending; pending = result.catch(() => {}); return result;
  };
  session.draftFlushers.add(flush);
  pane.flushDraft = flush;
  const blur = pane.editor?.onDidBlurEditorText?.(() => flush().then(() => session.commitPool?.()).catch(onError));
  // The shared model can have a node and window view; one listener creates one edit.
  const change = (model.onDidChangeContent ?? pane.editor.onDidChangeModelContent).call(model.onDidChangeContent ? model : pane.editor, () => {
    if (!matches() || writing) return;
    const text = normalizePromptInput(model.getValue());
    completions = draftCompletions(observed, text, completions, model.__plv4TagCompletion);
    observed = text; draft = text;
    onDraft(text);
  });
  const unsubscribe = session.subscribe(({ reason }) => {
    if (!matches() || reason === 'View' || reason === 'LocateDetails') return;
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
  const undo = () => flush().then(() => session.undo()).catch(onError);
  const redo = () => flush().then(() => session.redo()).catch(onError);
  model.undo = undo;
  model.redo = redo;

  const shared = {
    session, panes, flush,
    dispose() {
      if (disposed) return;
      disposed = true;
      change.dispose();
      session.draftFlushers.delete(flush);
      unsubscribe();
      if (model.undo === undo) { if (ownUndo) model.undo = oldUndo; else delete model.undo; }
      if (model.redo === redo) { if (ownRedo) model.redo = oldRedo; else delete model.redo; }
      if (model.__plv4Session === session) { if (oldSession) model.__plv4Session = oldSession; else delete model.__plv4Session; }
      for (const view of panes) { if (view.editSession === session) view.editSession = null; if (view.flushDraft === flush) delete view.flushDraft; }
      panes.clear(); bindings.delete(model);
    },
  };
  bindings.set(model, shared);
  return { flush, dispose() { blur?.dispose(); panes.delete(pane); if (pane.flushDraft === flush) delete pane.flushDraft; if (pane.editSession === session) pane.editSession = null; if (!panes.size) shared.dispose(); } };
}
