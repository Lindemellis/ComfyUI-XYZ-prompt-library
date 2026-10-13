// ARCHIVED 2026-10-07: this historical Class-model browser check is obsolete.
// Current Folder-pool acceptance uses the offline t70-t77/Node suites; do not run this script against the new Library.
// Native inputs copied from the accepted prototype; disposable fixture only.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const BASE = process.env.PLV4_BASE_URL || 'http://127.0.0.1:8191';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let count = 0; const check = (name, value) => { assert.ok(value, name); count++; console.log('PASS', name); };
  const open = text => page.evaluate(async text => {
    const node = LiteGraph.createNode('XYZ Prompt Library V4'); app.graph.add(node);
    node.widgets.find(w => w.name === 'text').value = text;
    window.inlineCheck = { node, win: plv4.window, client: await import('/extensions/plv4_fixture/plv4/asset_client.js') };
    await inlineCheck.win.open(node); await inlineCheck.win.setView('block');
  }, text);
  const finish = async () => {
    await page.evaluate(async () => { const win = inlineCheck.win; win.blockView.inline?.element.blur(); await win.flushEditor(); });
    await page.waitForFunction(() => !inlineCheck.win.blockView.inline);
  };
  try {
    await page.goto(BASE);
    const info = await page.request.get(`${BASE}/object_info`).then(r => r.json());
    assert.ok(info['PLv4 Fixture Capture'], 'Disposable fixture required');
    await page.waitForFunction(() => window.app?.graph && window.plv4); await page.bringToFront();
    await open('{ first block }, { second block }');
    await page.locator('.plv4-prompt').nth(0).click();
    await page.locator('.plv4-prompt').nth(1).click();
    check('one click transfers focus between unchanged blocks', await page.evaluate(() => document.activeElement?.innerText === 'second block' && document.activeElement === inlineCheck.win.blockView.inline?.element));
    await page.keyboard.insertText('SECOND'); await finish();
    check('typing after one click updates the destination block', await page.evaluate(() => inlineCheck.win.context.session.text.includes('SECOND')));
    await open('{ first block }, { second block }');
    await page.locator('.plv4-prompt').nth(0).click();
    await page.keyboard.insertText('FIRST');
    await page.locator('.plv4-prompt').nth(1).click();
    check('one click transfers focus while the previous block has unsaved typing', await page.evaluate(() => document.activeElement?.dataset.prompt === inlineCheck.win.blocks.querySelectorAll('.plv4-prompt')[1]?.dataset.prompt));
    await page.keyboard.insertText('SECOND'); await finish();
    check('switching inputs preserves both blocks edits', await page.evaluate(() => inlineCheck.win.context.session.text.includes('FIRST') && inlineCheck.win.context.session.text.includes('SECOND')));
    await open('{ first block }, { second block }');
    await page.locator('.plv4-prompt').nth(0).click();
    const blank = await page.locator('.plv4-run').nth(1).boundingBox();
    await page.mouse.move(blank.x + blank.width - 20, blank.y + blank.height / 2);
    check('blank space after a prompt has a text cursor', await page.evaluate(({ x, y }) => getComputedStyle(document.elementFromPoint(x, y)).cursor === 'text', { x: blank.x + blank.width - 20, y: blank.y + blank.height / 2 }));
    await page.mouse.click(blank.x + blank.width - 20, blank.y + blank.height / 2);
    check('one click in the destination blank space focuses its prompt', await page.evaluate(() => document.activeElement?.innerText === 'second block'));
    await page.keyboard.insertText(' at end'); await finish();
    check('blank space click puts the caret at the destination line end', await page.evaluate(() => inlineCheck.win.context.session.text.includes('second block at end')));
    await open('{ first block, { nested block } }, { }');
    await page.locator('.plv4-prompt').nth(0).click();
    await page.locator('.plv4-prompt').nth(1).click();
    check('one click focuses a nested block input', await page.evaluate(() => document.activeElement?.innerText === 'nested block'));
    await page.locator('[data-empty]').click();
    check('one click focuses an empty block with a text cursor', await page.evaluate(() => document.activeElement?.dataset.empty && getComputedStyle(document.activeElement).cursor === 'text'));
    await page.keyboard.insertText('empty destination'); await finish();
    check('typing immediately after switching to an empty block is retained', await page.evaluate(() => inlineCheck.win.context.session.text.includes('empty destination')));
    const slowCommand = async route => { await new Promise(resolve => setTimeout(resolve, 120)); await route.continue(); };
    await page.route('**/xyz/plv4/document/command', slowCommand);
    try {
      await open('{ first block }, { second block }');
      await page.locator('.plv4-prompt').nth(0).click(); await page.keyboard.insertText('FIRST');
      await page.locator('.plv4-prompt').nth(1).click(); await page.keyboard.insertText('SECOND');
      await page.evaluate(async () => { const win = inlineCheck.win; await win.flushEditor(); await win.context.session.whenIdle(); });
      check('delayed saving does not steal the destination focus', await page.evaluate(() => document.activeElement?.dataset.prompt === inlineCheck.win.blocks.querySelectorAll('.plv4-prompt')[1]?.dataset.prompt));
      await finish();
      check('immediate typing during delayed focus transfer preserves both edits', await page.evaluate(() => inlineCheck.win.context.session.text.includes('FIRST') && inlineCheck.win.context.session.text.includes('SECOND')));
    } finally { await page.unroute('**/xyz/plv4/document/command', slowCommand); }
    await open('{ }');
    await page.locator('[data-empty]').first().click();
    await page.locator('[data-empty]').first().fill('1girl, (white hair:1.2), <lora:cloth:0.7>');
    await finish();
    check('empty block accepts comma-separated weighted and LoRA prompts directly', await page.evaluate(() => inlineCheck.win.context.session.state.doc.root.children[0].children.length === 3));
    check('native input creates no dialog or extra Monaco', await page.locator('.plv4-run-editor').count() === 0 && await page.getByText('添加 prompt', { exact: true }).count() === 0);
    const first = page.locator('.plv4-prompt').first(); await first.click(); await first.fill('女孩 😀, blue eyes'); await finish();
    check('single-click native editing splits prompts and preserves Unicode', await page.evaluate(() => inlineCheck.win.context.session.text.includes('女孩 😀, blue eyes') && inlineCheck.win.context.session.valid));
    await page.evaluate(() => inlineCheck.win.undo());
    check('native text editing shares document undo', await page.locator('.plv4-prompt').first().innerText() === '1girl');
    await page.locator('.plv4-header [data-child]').first().click();
    await page.waitForFunction(() => document.activeElement?.dataset.empty && inlineCheck.win.context.session.state.doc.root.children[0].children.at(-1).id === document.activeElement.dataset.empty);
    await page.keyboard.insertText('new child prompt'); await finish();
    check('new child block focuses the prototype input immediately', await page.evaluate(() => inlineCheck.win.context.session.state.doc.root.children[0].children.at(-1).children[0].raw === 'new child prompt'));
    await open(''); await page.locator('[data-empty]').fill('ambient. next prompt'); await finish();
    check('empty document accepts typing and preserves sentence separators', await page.evaluate(() => inlineCheck.win.context.session.state.doc.root.children.length === 2 && inlineCheck.win.context.session.text.includes('ambient. next prompt')));
    await open('{ kept, parked }');
    const parked = await page.evaluate(async () => { const win = inlineCheck.win; const id = win.context.session.state.doc.root.children[0].children[1].id; await win.command({ type: 'SetEnabled', id, enabled: false }); return id; });
    await page.locator('.plv4-prompt[contenteditable="true"]').first().fill('kept, added'); await finish();
    check('direct append retains disabled prompt identity and state', await page.evaluate(id => { const children = inlineCheck.win.context.session.state.doc.root.children[0].children; return children.some(n => n.id === id && !n.enabled && n.raw === 'parked') && children.some(n => n.raw === 'added'); }, parked));
    await open('[@schedule]: { 0 - 0.4: { }, 0.4 - 1: { late } }');
    await page.locator('[data-empty]').first().fill('early, sunrise'); await finish();
    check('empty schedule entry typing keeps the shared time boundary', await page.evaluate(() => { const row = inlineCheck.win.context.session.projection.tree.children[0]; return row.children[0].settings.schedule[1] === .4 && row.children[1].settings.schedule[0] === .4 && row.children[0].children.length === 2; }));
    await open('{ }');
    await page.evaluate(async () => {
      inlineCheck.libraryAsset = (await inlineCheck.client.libraryRequest('create_block', { name: `Native Library ${Date.now()}` }, true)).asset;
      await inlineCheck.win.library.reload(); await inlineCheck.win.library.openAsset(inlineCheck.libraryAsset);
    });
    await page.locator('[data-empty]').first().fill('library direct, (weighted:1.15)'); await finish();
    check('Library block uses the same native input and keeps one root', await page.evaluate(() => inlineCheck.win.context.session.valid && inlineCheck.win.context.session.state.doc.root.children.length === 1 && inlineCheck.win.context.session.state.doc.root.children[0].children.length === 2));
    check('native Library editing saves the current text to its shared source', await page.evaluate(async () => {
      const win = inlineCheck.win, root = win.context.session.state.doc.root.children[0], asset = inlineCheck.libraryAsset;
      await win.command({ type: 'SaveLibrary', id: root.id, name: asset.name, asset_id: asset.id, version: root.meta.source.version });
      const expanded = await inlineCheck.client.libraryRequest('expand', { id: asset.id });
      const doc = JSON.parse(JSON.stringify(win.context.session.state.doc)); doc.root.children = [expanded.snapshot];
      const reopened = await fetch('/xyz/plv4/document/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ doc }) }).then(r => r.json());
      const latest = await inlineCheck.client.libraryRequest('get', { id: asset.id });
      await inlineCheck.client.libraryRequest('delete', { id: asset.id, version: latest.version }, true);
      return reopened.state.text.includes('library direct') && reopened.state.text.includes('(weighted:1.15)');
    }));
    await open('{ }');
    await page.evaluate(async () => {
      const win = inlineCheck.win; const parsed = await fetch('/xyz/plv4/document/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'native suggestion unique' }) }).then(r => r.json());
      inlineCheck.classAsset = (await inlineCheck.client.libraryRequest('save_class', { name: `Native input ${Date.now()}`, data: { autocomplete: true, attributes: [{ kind: 'prompt', snapshot: parsed.state.doc.root.children[0] }] } }, true)).asset;
      await win.library.reload();
    });
    await page.locator('[data-empty]').first().click(); await page.keyboard.type('native sugg', { delay: 15 });
    await page.locator('#xyz-tagac-root').waitFor({ state: 'visible', timeout: 5000 }).catch(async error => {
      console.log(await page.evaluate(async () => { const win = inlineCheck.win, active = win.blockView.inline, element = win.blocks.querySelector('[data-empty]'); return { text: win.context.session.text, focused: document.activeElement?.outerHTML, inline: !!active, hooked: element?._xyzTagACHooked, value: element?.innerText, suggestions: active?.run ? (await window.xyzPLv4Suggestions('native sugg', { __plv4Pane: { editSession: active.run } })).map(n => n.name) : null }; })); throw error;
    });
    check('prototype native input uses existing Class autocomplete popup', (await page.locator('#xyz-tagac-root').innerText()).includes('native suggestion unique'));
    await page.locator('#xyz-tagac-root [data-tagac-index]').filter({ hasText: 'native suggestion unique' }).first().click();
    await page.waitForFunction(() => inlineCheck.win.context.session.state.doc.root.children[0].children[0]?.meta.source?.attribute_id);
    check('native autocomplete inserts the shared phrase with provenance', await page.evaluate(() => inlineCheck.win.context.session.text.includes('native suggestion unique')));
    await page.evaluate(async () => { const asset = await inlineCheck.client.libraryRequest('get', { id: inlineCheck.classAsset.id }); await inlineCheck.client.libraryRequest('delete', { id: asset.id, version: asset.version }, true); });
    check('no page runtime errors', errors.length === 0);
    console.log(JSON.stringify({ checks: count, errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
