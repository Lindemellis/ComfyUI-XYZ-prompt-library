// ARCHIVED 2026-10-07: this historical Class-model browser check is obsolete.
// Current Folder-pool acceptance uses the offline t70-t77/Node suites; do not run this script against the new Library.
// Real keyboard history must keep the active page and editor binding intact.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const BASE = process.env.PLV4_BASE_URL || 'http://127.0.0.1:8191';
(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  let count = 0; const check = (name, value) => { assert.ok(value, name); count++; console.log('PASS', name); };
  const settle = () => page.evaluate(async () => { const win = undoCheck.win; await win._transition; await win.flushEditor(); });
  const shortcut = async key => { await page.keyboard.press(key); await settle(); };
  const finishInline = async () => { await page.evaluate(() => undoCheck.win.blockView.inline?.element.blur()); await settle(); await page.waitForFunction(() => !undoCheck.win.blockView.inline); };
  const open = text => page.evaluate(async text => {
    const node = LiteGraph.createNode('XYZ Prompt Library V4'); app.graph.add(node);
    node.widgets.find(w => w.name === 'text').value = text;
    undoCheck.node = node; await undoCheck.win.open(node); await undoCheck.win.setView('block');
  }, text);
  let cleanup = false;
  try {
    await page.goto(BASE); const info = await page.request.get(`${BASE}/object_info`).then(r => r.json()); assert.ok(info['PLv4 Fixture Capture'], 'Disposable fixture required');
    await page.waitForFunction(() => window.app?.graph && window.plv4); await page.bringToFront();
    await page.evaluate(async () => { app.graph.clear(); window.undoCheck = { win: plv4.window, client: await import('/extensions/plv4_fixture/plv4/asset_client.js'), assets: [] }; });
    await open('{ original prompt }, { untouched prompt }');
    const nodeIds = await page.evaluate(() => app.graph._nodes.map(n => n.id));
    await page.locator('.plv4-prompt').first().fill('edit one'); await settle();
    await page.locator('.plv4-prompt').first().fill('edit two'); await settle();
    await shortcut('Control+z');
    check('Ctrl+Z restores text without clearing the active node editor', await page.evaluate(() => undoCheck.win.blocks.querySelector('.plv4-prompt')?.innerText === 'edit one' && undoCheck.win.context.node === undoCheck.node && !!undoCheck.win.pane.model()));
    check('undo restores native input focus', await page.evaluate(() => document.activeElement?.dataset.prompt && undoCheck.win.blockView.inline?.element === document.activeElement));
    await shortcut('Control+z');
    check('consecutive Ctrl+Z returns to original text without reopening a tab', await page.locator('.plv4-prompt').first().innerText() === 'original prompt');
    check('editor undo leaves the ComfyUI graph and node objects intact', await page.evaluate(ids => JSON.stringify(app.graph._nodes.map(n => n.id)) === JSON.stringify(ids) && app.graph._nodes.includes(undoCheck.node), nodeIds));
    await shortcut('Control+y'); check('Ctrl+Y restores the next edit in place', await page.locator('.plv4-prompt').first().innerText() === 'edit one');
    await shortcut('Control+Shift+z'); check('Ctrl+Shift+Z also restores text without losing the editor', await page.locator('.plv4-prompt').first().innerText() === 'edit two');
    await page.evaluate(() => { const field = document.activeElement; const range = document.createRange(); range.setStart(field.firstChild, 3); range.collapse(true); getSelection().removeAllRanges(); getSelection().addRange(range); });
    await shortcut('Control+z');
    check('undo retains the caret offset inside the restored input', await page.evaluate(() => document.activeElement?.dataset.prompt && getSelection().anchorOffset === 3));
    await page.keyboard.insertText('!'); await settle();
    check('typing immediately after undo updates the same node document', await page.evaluate(() => undoCheck.win.context.session.text.includes('edi!t one') && undoCheck.node.widgets.find(w => w.name === 'text').value.includes('edi!t one')));
    await open('{ }'); await page.locator('[data-empty]').fill('base'); await finishInline();
    await page.locator('.plv4-prompt').fill('base, split'); await finishInline();
    await page.locator('.plv4-prompt').nth(1).fill('split edited'); await settle();
    await shortcut('Control+z'); await shortcut('Control+z');
    check('undo removing the focused split item focuses the surviving block input', await page.locator('.plv4-prompt').count() === 1 && await page.evaluate(() => document.activeElement?.innerText === 'base'));
    await shortcut('Control+z');
    check('undo to an empty block keeps its empty input focused and editor visible', await page.locator('[data-empty]').count() === 1 && await page.evaluate(() => !!document.activeElement?.dataset.empty && !!undoCheck.win.pane.model()));
    await shortcut('Control+y');
    check('redo from an empty input focuses the restored prompt', await page.evaluate(() => document.activeElement?.innerText === 'base' && undoCheck.win.context.session.text.includes('base')));
    await page.evaluate(async () => { const w = undoCheck.win; await w.setView('syntax'); w.pane.model().setValue('{ syntax edit }'); await w.context.session.whenIdle(); w.pane.editor.focus(); });
    await shortcut('Control+z');
    check('floating Monaco keyboard undo preserves its model and current tab', await page.evaluate(() => undoCheck.win.pane.text().includes('base') && undoCheck.win.pane.editor.hasTextFocus() && undoCheck.win.context.node === undoCheck.node));
    await shortcut('Control+y'); check('floating Monaco keyboard redo restores the syntax edit', await page.evaluate(() => undoCheck.win.pane.text() === '{ syntax edit }'));
    await page.evaluate(async () => { const w = undoCheck.win; await w.setView('block'); await w.locate(w.context.session.projection.tree.children[0].id); });
    const weight = page.locator('.plv4-details .setting-row').filter({ has: page.locator('label').filter({ hasText: /^Weight$/ }) }).locator('input');
    await weight.fill('1.25'); await weight.press('Tab'); await settle(); await weight.focus();
    await shortcut('Control+z');
    check('Details keyboard undo keeps its rebuilt input focused', await page.evaluate(() => undoCheck.win.context.session.projection.tree.children[0].settings.weight == null && document.activeElement?.closest('.setting-row')?.querySelector('label')?.textContent === 'Weight'));
    await page.locator('[title="重做"]').click(); await settle();
    check('toolbar redo restores settings and keeps the document visible', await page.evaluate(() => undoCheck.win.context.session.projection.tree.children[0].settings.weight === 1.25 && undoCheck.win.blocks.querySelector('.plv4-prompt')));
    await page.evaluate(async () => {
      const t = undoCheck;
      const block = (await t.client.libraryRequest('create_block', { name: `Undo block ${Date.now()}` }, true)).asset; t.assets.push(block.id);
      await t.win.library.reload(); await t.win.library.openAsset(block);
    }); cleanup = true;
    await page.locator('[data-empty]').fill('library edit'); await settle(); await shortcut('Control+z');
    check('Library block keyboard undo keeps the Library tab and empty input active', await page.evaluate(() => !!undoCheck.win.context.asset && !!document.activeElement?.dataset.empty && !!undoCheck.win.pane.model()));
    await shortcut('Control+y'); check('Library block keyboard redo keeps its native editor active', await page.evaluate(() => document.activeElement?.innerText === 'library edit'));
    await page.evaluate(async () => {
      const t = undoCheck; const snapshot = (await t.win.classPage.parsePrompt('class original'));
      const cls = (await t.client.libraryRequest('save_class', { name: `Undo class ${Date.now()}`, data: { autocomplete: false, attributes: [{ kind: 'prompt', snapshot }] } }, true)).asset; t.assets.push(cls.id);
      await t.win.library.reload(); await t.win.openClass(cls.id);
      await t.win.classPage.replacePrompt(t.win.classPage.asset.data.attributes[0].id, 'class edited');
    });
    await page.locator('[data-attribute-text]').focus(); await shortcut('Control+z');
    check('Class keyboard undo preserves its attribute page and input focus', await page.locator('[data-attribute-text]').inputValue() === 'class original' && await page.evaluate(() => !!document.activeElement?.dataset.attributeText && !!undoCheck.win.classContext));
    await shortcut('Control+y'); check('Class keyboard redo restores its attribute in place', await page.locator('[data-attribute-text]').inputValue() === 'class edited');
    const outside = await page.evaluate(() => {
      const w = undoCheck.win, previous = w.undo; let called = false; w.undo = () => { called = true; };
      try { const input = document.createElement('input'); document.body.append(input); input.focus(); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true })); input.remove(); return !called; } finally { w.undo = previous; }
    }); check('keyboard undo outside the plugin is not redirected to its history', outside);
    check('no page runtime errors', errors.length === 0);
    console.log(JSON.stringify({ checks: count, errors }));
  } finally {
    if (cleanup) await page.evaluate(async () => { for (const id of undoCheck.assets.reverse()) { const asset = await undoCheck.client.libraryRequest('get', { id }); await undoCheck.client.libraryRequest('delete', { id, version: asset.version }, true); } }).catch(console.error);
    await browser.close();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
