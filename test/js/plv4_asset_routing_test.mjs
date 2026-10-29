import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const code = (await readFile(new URL('../../js/plv4/asset_client.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const { libraryDocumentRequest } = await import('data:text/javascript;base64,' + Buffer.from(`
const documentRequest = async () => 'document';
class SessionError extends Error {}
${code}`).toString('base64'));

test('Block header settings bypass the Library writer while atomic prompt changes still collect', async () => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, library_changed: false, route: 'library' }) });
  try {
    const node = { id: 'block', kind: 'group', form: 'brace', children: [], meta: { pool: 'class' } };
    const body = command => ({ state: { doc: { root: { id: 'root', kind: 'group', children: [node], meta: {} } } }, command });
    for (const patch of [{ weight: 1.2 }, { shuffle: true }, { schedule: [0, .5] }, { region: { kind: 'base' } }]) {
      assert.equal(await libraryDocumentRequest('command', body({ type: 'SetSettings', id: 'block', patch })), 'document');
    }
    for (const type of ['SetAvgWeight', 'SetScheduleBoundary', 'SetRegionEnabled']) {
      assert.equal(await libraryDocumentRequest('command', body({ type, id: 'block' })), 'document');
    }
    for (const command of [
      { type: 'SetPromptSettings', id: 'block', patch: { weight: 1.2 } },
      { type: 'SetSettings', id: 'block', patch: { type: 'text' } },
      { type: 'SetMetadata', id: 'block', patch: { pool: 'other' } },
    ]) assert.equal((await libraryDocumentRequest('command', body(command))).route, 'library');
    node.form = 'paren';
    assert.equal((await libraryDocumentRequest('command', body({ type: 'SetSettings', id: 'block', patch: { weight: 1.2 } }))).route, 'library');
    node.form = 'brace'; node.opaque = true;
    assert.equal((await libraryDocumentRequest('command', body({ type: 'SetSettings', id: 'block', patch: { weight: 1.2 } }))).route, 'library');
  } finally { globalThis.fetch = oldFetch; }
});
