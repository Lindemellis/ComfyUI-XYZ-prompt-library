import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
const load = source => import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const source = file => readFile(new URL('../../js/' + file, import.meta.url), 'utf8');
globalThis.window = { xyzPLv4LibraryPaths: async () => [{ id: 'f1', path: 'Characters.Alice', assetKind: 'folder', v4: true }] };
// Any implicit access to the retired V3 Library must fail this suite.
globalThis.fetch = async url => { throw new Error('Unexpected legacy Library request: ' + url); };
globalThis.sourceProvider = await load(await source('plv3/complete.js'));
globalThis.dropHelpers = await load((await source('plv4/drop_preview.js')).replace(/^import .*;\r?\n/gm, ''));
const { nativeCompletions } = await load(`const {provideCompletions,braceContextsText}=globalThis.sourceProvider; const {canInsertContainer}=globalThis.dropHelpers;
const indexTree=tree=>{const map=new Map();const visit=row=>{if(!row)return;map.set(row.id,row);row.children?.forEach(visit)};visit(tree);return map;};
` + (await source('plv4/native_completion.js')).replace(/^import .*;\r?\n/gm, ''));
const run = (prefix = '{ ', owner = { id: 'owner', form: 'brace', children: [] }) => ({ contentStart: prefix.length, owner: owner.id,
  parent: { text: prefix, projection: { tree: { id: 'root', form: 'root', children: [owner] } } } });

test('native Source completion offers V4 schedule/region defaults and Library references', async () => {
  const values = await nativeCompletions('[', 1, run());
  assert.deepEqual(values.map(value => value.name), ['@schedule', '@region', '@avg', 'Characters.Alice']);
  assert.equal(values[0].insertText, '@schedule]: { 0 - 0.5: { }, 0.5 - 1: { } }');
  assert.ok(values[1].insertText.includes('[mask: [0, 0.5, 0, 1]]'));
  assert.deepEqual(values[3].asset, { id: 'f1', kind: 'folder', path: 'Characters.Alice' });
  assert.equal(values[2].insertText, '@avg]: { 1: { }, 1: { } }');
  assert.equal(values[0].start, 1);
});
test('untouched compatibility models offer language syntax without reading either Library', async () => {
  const model = { getLineContent: () => '[', getValueInRange: () => '[' };
  const values = await sourceProvider.provideCompletions({ languages: { CompletionItemKind: { Keyword: 1, Module: 2 }, CompletionItemInsertTextRule: { InsertAsSnippet: 4 } } }, model,
    { lineNumber: 1, column: 2 }, { onInsertBlock: true });
  assert.ok(values.suggestions.some(value => value.label === '@schedule'));
  assert.ok(!values.suggestions.some(value => value.label === 'Characters.Alice'));
});
test('native completion respects Region headers, rectangle parameters, settings and literal brackets', async () => {
  assert.deepEqual((await nativeCompletions('[', 1, run('[@region]: { '))).map(value => value.name), ['base', 'mask', 'imask', 'fill']);
  assert.deepEqual(await nativeCompletions('[', 1, run('[@region]: { [mask: ')), []);
  assert.deepEqual(await nativeCompletions('[', 1, run('{ }.set{ ')), []);
  assert.equal(await nativeCompletions('\\[', 2, run()), null);
  assert.equal(await nativeCompletions('"[', 2, run()), null);
});
test('Region cannot be offered inside an existing Region entry but Schedule and Library remain available', async () => {
  const values = await nativeCompletions('[', 1, run('[@region]: { [base]: { ', { id: 'owner', form: 'region_entry', children: [] }));
  assert.deepEqual(values.map(value => value.name), ['@schedule', '@avg', 'Characters.Alice']);
  const invalid=run('[@region]: { [base]: { ');invalid.parent.projection.tree=null;
  assert.deepEqual((await nativeCompletions('[',1,invalid)).map(value=>value.name),['@schedule','@avg','Characters.Alice']);
});
