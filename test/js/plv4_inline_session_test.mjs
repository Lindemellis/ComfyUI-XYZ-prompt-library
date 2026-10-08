import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const sessionCode = await readFile(new URL('../../js/plv4/document_session.js', import.meta.url), 'utf8');
const { DocumentSession } = await import('data:text/javascript;base64,' + Buffer.from(sessionCode).toString('base64'));
const textCode = await readFile(new URL('../../js/plv4/text_input.js', import.meta.url), 'utf8');
globalThis.inlineTextHelpers = await import('data:text/javascript;base64,' + Buffer.from(textCode).toString('base64'));
globalThis.promptTextHelpers = await import('data:text/javascript;base64,' + Buffer.from(await readFile(new URL('../../js/plv4/prompt_text.js', import.meta.url), 'utf8')).toString('base64'));
const viewCode = (await readFile(new URL('../../js/plv4/block_view.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace('class RunSession', 'export class RunSession');
const dependencies = `export const reported = [];
const { inlineText, inlineOffset, inlinePoint } = globalThis.inlineTextHelpers;
const { promptDisplay, displayRun, scheduleSource, normalizePromptInput, runEnd } = globalThis.promptTextHelpers;
const report = error => reported.push(error);
const indexTree = tree => { const map = new Map(); const visit = row => { if (!row) return; map.set(row.id, row); row.children.forEach(visit); }; visit(tree); return map; };
const attachInlineAutocomplete = async () => {};\n`;
const { RunSession, BlockView, reported } = await import('data:text/javascript;base64,' + Buffer.from(dependencies + viewCode + '\n//# sourceURL=plv4-inline-under-test.js').toString('base64'));

function snapshot(text, revision = 0) {
  const parts = text.split(', '), nodes = []; let offset = 0;
  parts.forEach((source, i) => { nodes.push({ id: `i${i + 2}`, source, enabled: true, effective: true, children: [], parent_id: 'i1', span: [offset, offset + source.length] }); offset += source.length + 2; });
  const tree = { id: 'i1', children: nodes };
  return { state: { doc: { root: tree, next_id: 10 }, text, revision, valid: true }, projection: { tree, diagnostics: [], revision } };
}
function fixture() {
  const session = new DocumentSession(snapshot('first, second'), { request: async (op, body) => snapshot(body.command.text, body.state.revision + 1) });
  const writes = [], context = { session, node: {} };
  const view = Object.create(BlockView.prototype);
  const host = { context, blockView: view, sessions: { persist(context, text) { writes.push(text); } } };
  Object.assign(view, { host, context, cache: new Map(), inlineEditors: new Set() });
  return { session, context, view, host, writes };
}

test('a queued input from the closed pre-undo text segment cannot overwrite restored text or report a stale source', async () => {
  const { session, context, view, host, writes } = fixture();
  await session.replaceText('edited, second');
  const run = new RunSession(session, ['i2'], host);
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const field = { innerText: 'edited!', contentEditable: 'true' };
  const active = { element: field, context, run, ready: Promise.resolve(run), pending: waiting };
  view.inline = active; view.inlineEditors.add(active);
  const before = reported.length;
  view.typeInline(field); view.closeEditor(); await session.undo(); release();
  await active.pending.catch(() => {});
  assert.equal(session.text, 'first, second');
  assert.equal(reported.length, before, 'a retired text segment should be discarded rather than asking to reopen it');
  assert.deepEqual(writes, [], 'stale text must not be persisted to the node widget before the command guard');
});

test('disposing a run also cancels a write already queued in the parent document', async () => {
  const { session, host } = fixture();
  const run = new RunSession(session, ['i2'], host);
  let release; const waiting = new Promise(resolve => { release = resolve; });
  session._enqueue(() => waiting);
  let drafts = 0;
  const write = run.replaceText('stale', { onDraft: () => drafts++ });
  run.dispose(); release(); await write;
  assert.equal(session.text, 'first, second');
  assert.equal(drafts, 0);
  assert.equal(session.past.length, 0);
});

test('closing before initialization does not attach an old run to the restored input', async () => {
  const { session, view } = fixture();
  let release; const waiting = new Promise(resolve => { release = resolve; });
  session._enqueue(() => waiting);
  const field = { dataset: { prompt: 'i2' }, contentEditable: 'true' };
  view.beginInline(field); const active = view.inline;
  view.closeEditor(); release(); await active.ready;
  assert.equal(active.run, undefined);
  assert.equal(view.inline, null);
});

test('typing immediately after undo uses a fresh run and preserves the neighbouring prompt', async () => {
  const { session, context, view, host } = fixture();
  await session.replaceText('edited, second');
  const old = new RunSession(session, ['i2'], host);
  view.inline = { run: old, context }; view.inlineEditors.add(view.inline);
  view.closeEditor(); await session.undo();
  const field = { innerText: 'first!', contentEditable: 'true', dataset: { prompt: 'i2' } };
  view.beginInline(field); view.typeInline(field); await view.flush();
  assert.equal(session.text, 'first!, second');
  assert.equal(old.disposed, true);
  assert.equal(session.future.length, 0);
});

test('an input request failure does not poison subsequent typing in the same field', async () => {
  const { session, view } = fixture();
  const request = session.request; let fail = true;
  session.request = async (...args) => { if (fail) { fail = false; throw new Error('temporary request failure'); } return request(...args); };
  const field = { innerText: 'failed', contentEditable: 'true', dataset: { prompt: 'i2' } };
  view.beginInline(field); view.typeInline(field); await view.flush();
  assert.equal(session.text, 'first, second');
  field.innerText = 'retry'; view.typeInline(field); await view.flush();
  assert.equal(session.text, 'retry, second');
});

test('native Block typing converts Chinese separators before persistence and shared document parsing', async () => {
  const {session,view,writes}=fixture();
  const field={innerText:'solo， blonde hair',contentEditable:'true',dataset:{prompt:'i2'}};
  view.beginInline(field);view.typeInline(field);await view.flush();
  assert.equal(session.text,'solo, blonde hair, second');
  assert.equal(writes.at(-1),session.text);
  assert.ok(!session.text.includes('，'));
});

test('native newlines survive queued typing, persistence and document undo/redo',async()=>{
  const {session,view,writes}=fixture();
  const field={innerText:'first\n',contentEditable:'true',dataset:{runIds:'i2,i3',runInput:''}};
  view.beginInline(field);view.typeInline(field);await view.flush();
  assert.equal(session.text,'first\n');assert.equal(writes.at(-1),session.text);
  field.innerText='first\n\nsecond';view.typeInline(field);await view.flush();
  assert.equal(session.text,'first\n\nsecond');assert.equal(writes.at(-1),session.text);
  view.closeEditor();await session.undo();assert.equal(session.text,'first\n');
  await session.redo();assert.equal(session.text,'first\n\nsecond');
});

test('rapid focus transfer drains both text segments before history or navigation', async () => {
  const { session, view } = fixture();
  const first = { innerText: 'changed', contentEditable: 'true', dataset: { prompt: 'i2' } };
  const second = { innerText: 'other', contentEditable: 'true', dataset: { prompt: 'i3' } };
  const before = reported.length;
  view.beginInline(first); view.typeInline(first);
  view.beginInline(second); view.typeInline(second); await view.flush();
  assert.equal(session.text, 'changed, other');
  assert.equal(reported.length, before);
  view.closeEditor(); await session.undo();
  assert.equal(session.text, 'changed, second');
});

test('a cached autocomplete field uses the new run and discards an old delayed suggestion', async () => {
  const code = (await readFile(new URL('../../js/plv4/inline_input.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  const setup = `export const environment = { xyzTagAC: {}, xyzPLv4Suggestions: (query, context) => [context.__plv4Pane.editSession.name] }; const window = environment;\n`;
  const { attachInlineAutocomplete } = await import('data:text/javascript;base64,' + Buffer.from(setup + code + '\n//# sourceURL=plv4-autocomplete-under-test.js').toString('base64'));
  const field = { _xyzTagACHooked: true, isConnected: true };
  let release; const waiting = new Promise(resolve => { release = resolve; });
  const old = { name: 'old', whenIdle: () => waiting };
  await attachInlineAutocomplete(field, old);
  const delayed = field._xyzPoolSuggestions('prompt');
  old.disposed = true;
  await attachInlineAutocomplete(field, { name: 'new', whenIdle: async () => {} });
  release(); assert.deepEqual(await delayed, []);
  assert.deepEqual(await field._xyzPoolSuggestions('prompt'), ['new']);
});

test('one editable run replaces multiple prompts as one document edit and shares undo', async () => {
  const { session, view } = fixture();
  const field = { innerText: 'changed, other', contentEditable: 'true', dataset: { runIds: 'i2,i3', runInput: '' } };
  view.beginInline(field); view.typeInline(field); await view.flush();
  assert.deepEqual(view.inline.run.ids, ['i2', 'i3']);
  assert.equal(session.text, 'changed, other');
  view.closeEditor(); await session.undo(); assert.equal(session.text, 'first, second');
  await session.redo(); assert.equal(session.text, 'changed, other');
});
