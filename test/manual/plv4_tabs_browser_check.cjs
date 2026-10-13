// ARCHIVED 2026-10-07: this historical Class-model browser check is obsolete.
// Current Folder-pool acceptance uses the offline t70-t77/Node suites; do not run this script against the new Library.
// Open Library pages alongside node tabs; disposable fixture only.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const BASE = process.env.PLV4_BASE_URL || 'http://127.0.0.1:8191';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let count = 0; const check = (name, value) => { assert.ok(value, name); count++; console.log('PASS', name); };
  let ids;
  const tab = (kind, id) => page.locator(`[role="tab"][data-tab-kind="${kind}"][data-tab-id="${id}"]`);
  const selected = (kind, id) => page.waitForFunction(({ kind, id }) => document.querySelector(`[role="tab"][data-tab-kind="${kind}"][data-tab-id="${id}"][aria-selected="true"]`), { kind, id });
  const click = async (kind, id) => { await tab(kind, id).click(); await selected(kind, id); };
  try {
    await page.goto(BASE);
    const info = await page.request.get(`${BASE}/object_info`).then(r => r.json());
    assert.ok(info['PLv4 Fixture Capture'], 'Disposable fixture required');
    await page.waitForFunction(() => window.app?.graph && window.plv4); await page.bringToFront();
    ids = await page.evaluate(async () => {
      app.graph.clear();
      const client = await import('/extensions/plv4_fixture/plv4/asset_client.js'), win = plv4.window;
      const a = LiteGraph.createNode('XYZ Prompt Library V4'); app.graph.add(a); a.title = 'Node A'; a.widgets.find(w => w.name === 'text').value = '{ node A }';
      const b = LiteGraph.createNode('XYZ Prompt Library V4'); app.graph.add(b); b.title = 'Node B'; b.widgets.find(w => w.name === 'text').value = '{ node B }';
      const folder = (await client.libraryRequest('save_folder', { name: `Tab checks ${Date.now()}`, data: {} }, true)).asset;
      const blockA = (await client.libraryRequest('create_block', { name: 'Block A', parent_id: folder.id }, true)).asset;
      const blockB = (await client.libraryRequest('create_block', { name: 'Block B', parent_id: folder.id }, true)).asset;
      const opened = await fetch('/xyz/plv4/document/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: Array.from({ length: 45 }, (_, i) => `attribute_${i}`).join(', ') }) }).then(r => r.json());
      const classA = (await client.libraryRequest('save_class', { name: 'Class A', parent_id: folder.id, data: { autocomplete: false, attributes: opened.state.doc.root.children.map(snapshot => ({ kind: 'prompt', snapshot })) } }, true)).asset;
      const classB = (await client.libraryRequest('save_class', { name: 'Class B', parent_id: folder.id, data: { autocomplete: false, attributes: [] } }, true)).asset;
      window.tabCheck = { win, client, a, b, folder, blockA, blockB, classA, classB };
      await win.open(a); await win.library.reload();
      for (const asset of [blockA, blockB, classA, classB]) await win.library.openAsset(asset);
      return { a: String(a.id), b: String(b.id), blockA: `v4:${blockA.id}`, blockB: `v4:${blockB.id}`, classA: classA.id, classB: classB.id };
    });
    check('Library pages and all workflow nodes remain in one tab row', await page.locator('[role="tablist"] [role="tab"]').count() === 6);
    check('tabs distinguish Library block and Class and retain full paths', await page.evaluate(() => { const tabs = tabCheck.win.tabEntries().filter(t => t.kind !== 'node'); return tabs.length === 4 && tabs.every(t => t.title.includes(tabCheck.folder.name + '.') && t.title.includes(`LIBRARY ${t.kind.toUpperCase()}`)); }));
    await click('block', ids.blockA); await page.locator('[data-empty]').fill('local draft A');
    await click('node', ids.a);
    check('node tab restores its own document after leaving a Library draft', await page.evaluate(() => tabCheck.win.context.node === tabCheck.a && tabCheck.win.context.session.text === '{ node A }'));
    await click('block', ids.blockB); await page.locator('[data-empty]').fill('local draft B');
    await click('block', ids.blockA);
    check('Library block tabs retain independent unsaved edits', await page.evaluate(() => tabCheck.win.context.session.text.includes('local draft A') && tabCheck.win.library.contexts.get(`v4:${tabCheck.blockB.id}`).session.text.includes('local draft B')));
    await page.evaluate(() => tabCheck.win.undo());
    check('Library block tab retains its own undo history', await page.evaluate(() => !tabCheck.win.context.session.text.includes('local draft A') && tabCheck.win.library.contexts.get(`v4:${tabCheck.blockB.id}`).session.text.includes('local draft B')));
    await page.evaluate(() => tabCheck.win.redo());
    await click('class', ids.classA);
    check('Class tab switches to the original attribute editor', await page.locator('[data-attribute-text]').count() === 45 && await page.evaluate(() => tabCheck.win.blocks.style.display === 'none'));
    check('Library Class name and attribute inputs use readable 14px text', await page.evaluate(() => getComputedStyle(tabCheck.win.classNameControl.querySelector('input')).fontSize === '14px' && getComputedStyle(tabCheck.win.classContainer.querySelector('[data-attribute-text]')).fontSize === '14px'));
    const slowSave = async route => { await new Promise(resolve => setTimeout(resolve, 100)); await route.continue(); };
    await page.route('**/xyz/plv4/library/save_class', slowSave);
    try {
      await page.locator('[data-attribute-text]').first().fill('edited attribute');
      await click('node', ids.b);
      await click('class', ids.classA);
      check('switching tabs waits for a Class input save', await page.locator('[data-attribute-text]').first().inputValue() === 'edited attribute');
    } finally { await page.unroute('**/xyz/plv4/library/save_class', slowSave); }
    await page.evaluate(() => { const win = tabCheck.win; win.classContainer.querySelector('[data-attribute-kind="block"]').open = false; win.classContainer.scrollTop = 250; });
    const scroll = await page.evaluate(() => tabCheck.win.classContainer.scrollTop);
    await click('class', ids.classB); await click('class', ids.classA);
    check('Class tabs restore section folds and scroll position', await page.evaluate(scroll => !tabCheck.win.classContainer.querySelector('[data-attribute-kind="block"]').open && scroll > 0 && tabCheck.win.classContainer.scrollTop === scroll, scroll));
    await page.evaluate(() => tabCheck.win.undo());
    check('Class tab retains shared attribute undo after switching pages', await page.locator('[data-attribute-text]').first().inputValue() === 'attribute_0');
    await page.evaluate(() => tabCheck.win.redo());
    await click('node', ids.a);
    const fonts = await page.evaluate(() => {
      const pane = tabCheck.win.shell.library;
      return { name: getComputedStyle(pane.querySelector('.plv4-library-name')).fontSize, search: getComputedStyle(pane.querySelector('input')).fontSize, note: getComputedStyle(pane.querySelector('.library-note')).fontSize, title: getComputedStyle(pane.querySelector('.library-title')).fontSize };
    });
    check('Library names/search are 14px, notes 12px and title 16px', fonts.name === '14px' && fonts.search === '14px' && fonts.note === '12px' && fonts.title === '16px');
    await page.locator('[title="全部标签"]').click();
    check('tab overflow menu includes all nodes and opened Library pages', await page.locator('.plv4-popover button').count() === 6);
    check('overflow menu uses the original styled surface above the editor', await page.locator('.plv4-popover').evaluate(node => getComputedStyle(node).backgroundColor !== 'rgba(0, 0, 0, 0)' && parseInt(getComputedStyle(node).zIndex) > 1200));
    await click('node', ids.a);
    await page.evaluate(async () => { const win = tabCheck.win; await Promise.all([win.openClass(tabCheck.classB.id), win.openLibrary(win.library.contexts.get(`v4:${tabCheck.blockB.id}`)), win.open(tabCheck.b)]); });
    check('rapid mixed tab switches finish at the last requested page', await page.evaluate(() => tabCheck.win.context.node === tabCheck.b && !tabCheck.win.classContext));
    check('reopening existing pages does not duplicate tabs', await page.locator('[role="tablist"] [role="tab"]').count() === 6);
    await page.screenshot({ path: `${process.env.TEMP}/plv4-tabs-final.png` });
    check('no page runtime errors', errors.length === 0);
    console.log(JSON.stringify({ checks: count, errors }));
  } finally {
    if (ids) await page.evaluate(async () => { const t = tabCheck; for (const asset of [t.classA, t.classB, t.blockA, t.blockB, t.folder]) { const latest = await t.client.libraryRequest('get', { id: asset.id }); await t.client.libraryRequest('delete', { id: latest.id, version: latest.version }, true); } }).catch(console.error);
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
