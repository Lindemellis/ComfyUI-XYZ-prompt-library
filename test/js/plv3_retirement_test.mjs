import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = file => readFile(new URL('../../js/' + file, import.meta.url), 'utf8');
const load = code => import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const { acquireNodeModel, releaseNodeModel, PromptEditor } = await load(
  "const LANG_ID = 'plv3';\n" + (await source('plv3/editor_core.js')).replace(/^import .*;\r?\n/gm, ''));

test('replacement workflow nodes with identical IDs never share a live Monaco model', () => {
  const monaco = { editor: { createModel(text) {
    return { text, disposed: false, isDisposed() { return this.disposed; }, dispose() { this.disposed = true; } };
  } } };
  const first = { id: 17 }, next = { id: 17 };
  const one = acquireNodeModel(monaco, first, 'first workflow');
  assert.equal(acquireNodeModel(monaco, first, 'ignored'), one);
  const two = acquireNodeModel(monaco, next, 'next workflow');
  assert.notEqual(one, two);
  assert.equal(two.text, 'next workflow');
  releaseNodeModel(first); assert.equal(one.disposed, false);
  releaseNodeModel(first); assert.equal(one.disposed, true);
  assert.equal(two.disposed, false);
  releaseNodeModel(next); assert.equal(two.disposed, true);
  const legacy = acquireNodeModel(monaco, 17, 'legacy tooling');
  assert.equal(acquireNodeModel(monaco, '17', 'ignored'), legacy);
  releaseNodeModel(17); releaseNodeModel('17'); assert.equal(legacy.disposed, true);
});

test('historical blur sync never reads or writes the retired Library', async () => {
  globalThis.fetch = () => { throw new Error('Legacy Library request'); };
  await PromptEditor.prototype.syncLibrary.call({ text: () => '[legacy]: { extra tag }' });
});

test('both extension URLs install the same host without importing the retired windows', async () => {
  const v3 = await source('plv3.js'), v4 = await source('plv4.js'), host = await source('prompt_shared/node_host.js');
  assert.ok(v3.includes("import './prompt_shared/node_host.js'"));
  assert.ok(v4.includes("import './prompt_shared/node_host.js'"));
  assert.ok(!host.includes('plv3/window.js') && !host.includes('plv3/library.js'));
  const registered = [];
  globalThis.retirementApp = { registerExtension: value => registered.push(value) };
  const types = await load(await source('prompt_shared/node_types.js'));
  globalThis.retirementTypes = types;
  await load('const app=globalThis.retirementApp; const {NODE_TYPES,isMonacoNode}=globalThis.retirementTypes;\n' +
    host.replace(/^import .*;\r?\n/gm, ''));
  assert.equal(registered.length, 1);
  assert.equal(types.NODE_TYPES.size, 4);
  assert.equal(types.isMonacoNode({ comfyClass: 'XYZ Prompt Library V3 Monaco' }), true);
  assert.equal(types.isMonacoNode({ comfyClass: 'XYZ Prompt Library V4' }), false);
});
