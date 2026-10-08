import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = await readFile(new URL('../../js/plv4/document_session.js', import.meta.url), 'utf8');
const { DocumentSession, SessionError } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const opened = () => ({ state: { doc: { version: 2, next_id: 3, root: { id: 'i1', enabled: true } }, text: 'a', valid: true, revision: 0, selection: {} }, projection: { revision: 0, tree: {} } });

test('committing deferred pool sources completes typing without another undo step', async () => {
  const session = sessionWith(); let commits = 0;
  session.request.flush = async body => {
    commits++; const state = structuredClone(body.state); state.doc.root.meta = { source: 'saved-child' }; state.revision++;
    return { state, projection: { revision: state.revision, tree: {} } };
  };
  await session.replaceText('ab', { deferPool: true });
  await session.replaceText('abc', { deferPool: true });
  const history = session.past.length;
  await Promise.all([session.commitPool(), session.commitPool()]);
  assert.equal(commits, 1); assert.equal(session.past.length, history); assert.equal(session.state.doc.root.meta.source, 'saved-child');
  await session.undo(); assert.equal(session.text, 'ab');
});

test('failed deferred pool commit keeps the final draft and can be retried', async () => {
  const session = sessionWith(); let fail = true;
  session.request.flush = async body => {
    if (fail) { fail = false; throw new SessionError('asset_conflict', 'Pool changed'); }
    const state = structuredClone(body.state); state.revision++;
    return { state, projection: { revision: state.revision, tree: {} } };
  };
  await session.replaceText('final phrase', { deferPool: true }); const before = structuredClone(session.state);
  await assert.rejects(session.commitPool()); assert.deepEqual(session.state, before);
  await session.commitPool(); assert.equal(session.text, 'final phrase'); assert.equal(session.past.length, 1);
});

function sessionWith(requestOverride) {
  const request = requestOverride ?? (async (operation, body) => {
    if (operation === 'compile') return { revision: body.state.revision, seed: body.seed, prompt: body.state.text, plain: body.state.text };
    const state = structuredClone(body.state);
    if (body.command.type === 'ReplaceText') { state.text = body.command.text; state.doc.draft = state.text; }
    else { state.doc.next_id++; state.doc.root.name = body.command.name; state.selection = { node_id: body.command.id }; }
    state.revision++;
    return { ok: true, state, projection: { revision: state.revision, tree: {} }, edit: {} };
  });
  return new DocumentSession(opened(), { request });
}

test('one history restores document, raw draft and selected instance across views', async () => {
  const session = sessionWith();
  await session.dispatch({ type: 'Rename', name: 'Block', id: 'i2' });
  session.setView('syntax');
  await session.replaceText('broken { 😀');
  session.setView('block', { top: 123 });
  await session.undo();
  assert.equal(session.text, 'a');
  assert.equal(session.state.doc.root.name, 'Block');
  assert.equal(session.state.selection.node_id, 'i2');
  const revision = session.revision;
  await session.undo();
  assert.equal(session.state.doc.root.name, undefined);
  assert.equal(session.revision, revision + 1);
  await session.redo();
  await session.redo();
  assert.equal(session.text, 'broken { 😀');
  assert.deepEqual(session.setView('syntax'), { top: 123 });
});

test('undo does not allow an ID to be reused by a new branch', async () => {
  const session = sessionWith();
  await session.dispatch({ type: 'Insert', name: 'First' });
  const floor = session.state.doc.next_id;
  await session.undo();
  assert.equal(session.state.doc.next_id, floor);
  await session.dispatch({ type: 'Insert', name: 'Second' });
  assert.equal(session.state.doc.next_id, floor + 1);
  assert.equal(session.canRedo, false);
});

test('a queued structural command rejects the old revision instead of applying stale IDs', async () => {
  const session = sessionWith();
  const a = session.dispatch({ type: 'Insert', name: 'A' });
  const b = session.dispatch({ type: 'Insert', name: 'B' });
  await a;
  await assert.rejects(b, error => error.code === 'stale_revision');
  assert.equal(session.state.doc.root.name, 'A');
});

test('rapid full-source typing is ordered and undoable', async () => {
  const session = sessionWith();
  await Promise.all([session.replaceText('b'), session.replaceText('bc'), session.replaceText('bcd')]);
  assert.equal(session.text, 'bcd');
  await session.undo();
  assert.equal(session.text, 'bc');
});

test('failed requests do not change history and do not poison later work', async () => {
  let fail = true;
  const good = sessionWith();
  const session = sessionWith(async (...args) => {
    if (fail) { fail = false; throw new SessionError('rejected', 'cannot edit'); }
    return good.request(...args);
  });
  await assert.rejects(session.replaceText('bad'));
  assert.equal(session.text, 'a');
  assert.equal(session.canUndo, false);
  await session.replaceText('good');
  assert.equal(session.text, 'good');
});

test('preview uses host seed and does not add an undo entry', async () => {
  const session = sessionWith();
  assert.equal((await session.compile({ seed: 876, region_mode: 'mask' })).seed, 876);
  assert.equal(session.canUndo, false);
  await assert.rejects(session.compile({ region_mode: 'mask' }), error => error.code === 'node_seed_only');
});

test('dispose rejects late response and releases subscribers', async () => {
  let release;
  const real = sessionWith();
  const session = sessionWith(async (...args) => { await new Promise(resolve => { release = resolve; }); return real.request(...args); });
  const pending = session.replaceText('late');
  await Promise.resolve();
  session.dispose();
  release();
  await assert.rejects(pending, error => error.code === 'disposed');
  assert.equal(session.text, 'a');
  assert.equal(session.listeners.size, 0);
});

test('embedded and floating editors share one model edit and release leases independently', async () => {
  globalThis.promptInputHelpers = await import('data:text/javascript;base64,' + Buffer.from(await readFile(new URL('../../js/plv4/prompt_text.js', import.meta.url), 'utf8')).toString('base64'));
  const source = (await readFile(new URL('../../js/plv4/prompt_editor_binding.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, 'const { normalizePromptInput } = globalThis.promptInputHelpers;\n');
  const { bindPromptEditor } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  const session = sessionWith(); const listeners = new Set();
  const nativeUndo = () => 'native';
  const model = {
    value: 'a', undo: nativeUndo, getValue() { return this.value; },
    onDidChangeContent(listener) { listeners.add(listener); return { dispose() { listeners.delete(listener); } }; },
    setValue(value) { this.value = value; for (const listener of listeners) listener(); },
  };
  const pane = () => ({ editSession: null, model: () => model, setDoc() {}, scheduleLint() {}, setText(value) { if (value !== model.value) model.setValue(value); } });
  const embedded = pane(); const floating = pane();
  const first = bindPromptEditor(embedded, session);
  const second = bindPromptEditor(floating, session);
  model.setValue('one edit'); await session.whenIdle();
  assert.equal(session.past.length, 1); assert.equal(listeners.size, 1);
  model.setValue('solo， blonde hair， '); await session.whenIdle();
  assert.equal(session.text,'solo, blonde hair, '); assert.equal(model.value,session.text);
  first.dispose(); assert.notEqual(model.undo, nativeUndo);
  model.setValue('after embedded removal'); await session.whenIdle(); assert.equal(session.text, 'after embedded removal');
  await model.undo(); assert.equal(session.text, 'solo, blonde hair, '); assert.equal(model.value, session.text);
  second.dispose(); assert.equal(model.undo, nativeUndo); assert.equal(listeners.size, 0); assert.equal(session.listeners.size, 0);
});

test('loading a saved document keeps disabled content and is one cross-view undo step', async () => {
  const saved = opened(); saved.state.text = 'saved'; saved.state.doc.root.children = [{ id: 'i2', enabled: false, raw: 'parked' }];
  const session = sessionWith(async operation => { assert.equal(operation, 'open'); return saved; });
  await session.loadDocument({ doc: saved.state.doc });
  assert.equal(session.text, 'saved'); assert.equal(session.past.length, 1); assert.equal(session.state.doc.root.children[0].enabled, false);
  session.setView('syntax'); await session.undo(); assert.equal(session.text, 'a');
  session.setView('block'); await session.redo(); assert.equal(session.state.doc.root.children[0].raw, 'parked'); assert.equal(session.revision, 3);
});
