// ARCHIVED 2026-10-07: this historical Class-model browser check is obsolete.
// Current Folder-pool acceptance uses the offline t70-t77/Node suites; do not run this script against the new Library.
// Runs only against the isolated real-ComfyUI fixture on 8191.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const BASE = process.env.PLV4_BASE_URL || 'http://127.0.0.1:8191';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.error(error); });
  let count = 0; const check = (name, value) => { assert.ok(value, name); count++; console.log('PASS', name); };
  const dialog = title => page.getByText(title, { exact: true }).last().locator('..');
  try {
    await page.goto(BASE); const fixtureInfo = await page.request.get(`${BASE}/object_info`).then(r => r.json()); assert.ok(fixtureInfo['PLv4 Fixture Capture'], 'Run only against the disposable fixture, never the user test instance');
    await page.waitForFunction(() => window.app?.graph && window.plv4, { timeout: 60000 }); await page.bringToFront();
    await page.evaluate(async () => {
      app.graph.clear(); const node = LiteGraph.createNode('XYZ Prompt Library V3'); app.graph.add(node);
      node.widgets.find(w => w.name === 'text').value = '{ red dress, <lora:cloth:0.7>, { nested one, nested two } }, { target }';
      node.widgets.find(w => w.name === 'seed').value = 987654;
      window.p3 = { node, win: window.plv4.window };
      p3.client = await import('/extensions/plv4_fixture/plv4/asset_client.js');
      await p3.win.open(node); p3.win.shell.toggle('library', true); await p3.win.library.reload();
      p3.first = p3.win.context.session.state.doc.root.children[0].id;
      p3.target = p3.win.context.session.state.doc.root.children[1].id;
    });
    await page.evaluate(() => { p3.pending = p3.win.library.create('class'); });
    await dialog('新建 class').locator('input').fill(`Browser Class ${Date.now()}`); await dialog('新建 class').getByRole('button', { name: 'OK', exact: true }).click();
    const cid = await page.evaluate(async () => { const a = await p3.pending; p3.cid = a.id; return a.id; });
    check('new Class opens independent attribute page with exactly three sections', await page.locator('.plv4-attribute').count() === 0 && await page.locator('[data-attribute-kind]').count() === 3);
    check('Class page has no instance list or PLv3 editor', await page.evaluate(() => p3.win.syntax.style.display === 'none' && p3.win.classContainer.textContent.includes('Block attributes') && !p3.win.classContainer.textContent.includes('instances')));
    await page.evaluate(async () => { await p3.win.open(p3.node); await p3.win.locate(p3.first); p3.pending = p3.win.libraryAction('assign', p3.win.context.session.projection.tree.children[0]); });
    await dialog('Assign class').locator('select').selectOption(cid); await dialog('Assign class').getByRole('button', { name: 'OK', exact: true }).click(); await page.evaluate(() => p3.pending);
    check('Assign class atomically appends prompts and promotes nested block', await page.evaluate(async () => { const a = await p3.client.libraryRequest('get', { id: p3.cid }); return a.data.attributes.filter(x => x.kind === 'prompt').length === 2 && a.data.attributes.filter(x => x.kind === 'block').length === 1; }));
    await page.evaluate(() => { p3.pending = p3.win.saveBlock(p3.win.context.session.projection.tree.children[0]); });
    await dialog('保存 block').locator('input').fill('Browser saved block'); await dialog('保存 block').getByRole('button', { name: 'OK', exact: true }).click();
    await page.evaluate(async () => { const result = await p3.pending; p3.asset = result.asset; p3.savedText = p3.win.context.session.text; });
    check('class instance appears only below its Class in Library', await page.evaluate(() => { const rows = [...p3.win.library.tree.querySelectorAll('[data-asset-id]')]; const matching = rows.filter(n => n.dataset.assetId === p3.asset.id); return matching.length === 1 && parseInt(matching[0].style.paddingLeft) === 16; }));
    await page.evaluate(async () => { const state = p3.win.context.session.state; const item = state.doc.root.children[0].children[0]; await p3.win.command({ type: 'SetEnabled', id: item.id, enabled: false }); p3.off = item.id; });
    check('toggle off keeps Class attributes and source snapshot unchanged', await page.evaluate(async () => { const a = await p3.client.libraryRequest('get', { id: p3.cid }); const saved = await p3.client.libraryRequest('expand', { id: p3.asset.id }); return a.data.attributes.length === 3 && saved.snapshot.children[0].enabled; }));
    await page.evaluate(async () => { await p3.win.openClass(p3.cid); await p3.win.classPage.replacePrompt(p3.win.classPage.asset.data.attributes.find(a => a.kind === 'prompt').id, 'new shared phrase'); });
    check('editing shared Class attribute leaves workflow snapshot intact', await page.evaluate(async () => { await p3.win.open(p3.node); return !p3.win.context.session.text.includes('new shared phrase') && !p3.win.context.session.state.doc.root.children[0].children[0].enabled; }));
    await page.evaluate(async () => { await p3.win.openClass(p3.cid); await p3.win.undo(); });
    check('shared Class undo saves against current version', await page.evaluate(() => p3.win.classPage.asset.data.attributes.some(a => a.kind === 'prompt' && a.snapshot.raw === 'red dress')));
    await page.evaluate(() => p3.win.redo());
    check('shared Class redo restores edited attribute', await page.evaluate(() => p3.win.classPage.asset.data.attributes.some(a => a.kind === 'prompt' && a.snapshot.raw === 'new shared phrase')));
    await page.evaluate(async () => { await p3.win.classPage.edit(next => { next.data.autocomplete = true; }); await p3.win.open(p3.node); await p3.win.locate(p3.target); p3.pending = p3.win.libraryAction('load', p3.win.context.session.projection.tree.children[1]); });
    const loads = dialog('Load classes'); const choices = loads.locator('input[type="checkbox"]'); await choices.first().waitFor(); const options = await choices.count();
    for (let i = 0; i < options; i++) await choices.nth(i).uncheck();
    const className = await page.evaluate(() => p3.win.classPage.asset.name);
    await loads.getByText(className, { exact: true }).click();
    await loads.getByRole('button', { name: 'OK', exact: true }).click(); await page.evaluate(() => p3.pending);
    await page.locator('.plv4-details summary').filter({ hasText: /^CLASS ATTRIBUTES/ }).click();
    await page.waitForFunction(() => document.querySelector('.plv4-candidates [data-candidate-kind="block"]'));
    check('candidate Class paths have no enable-entire-Class checkbox', await page.evaluate(() => [...document.querySelectorAll('.plv4-candidates [data-candidate-kind="class"]')].every(row => !row.querySelector('input'))));
    const candidateBlock = page.locator('.plv4-candidates [data-candidate-kind="block"]').first();
    await candidateBlock.locator('input').check();
    await page.waitForFunction(() => p3.win.context.session.state.doc.root.children[1].children.some(n => n.meta?.occurrence));
    check('enabling candidate materializes full snapshot and provenance', await page.evaluate(() => { const n = p3.win.context.session.state.doc.root.children[1].children.find(n => n.meta?.occurrence); p3.candidateId = n.id; return n.meta.source.id && n.children.length === 2; }));
    await page.evaluate(async () => { const target = p3.win.context.session.state.doc.root.children[1]; const n = target.children.find(n => n.id === p3.candidateId); await p3.win.command({ type: 'SetEnabled', id: n.children[1].id, enabled: false }); await p3.win.command({ type: 'SetEnabled', id: n.id, enabled: false }); await p3.win.command({ type: 'SetEnabled', id: n.id, enabled: true }); });
    check('candidate block off/on retains descendants and loads never write Class', await page.evaluate(async () => { const n = p3.win.context.session.state.doc.root.children[1].children.find(n => n.id === p3.candidateId); const c = await p3.client.libraryRequest('get', { id: p3.cid }); return !n.children[1].enabled && c.data.attributes.length === 3; }));
    // Existing tagAC list includes full-phrase and typed Block entries.
    await page.evaluate(async () => { await p3.win.setView('syntax'); const text = p3.win.context.session.text + ', new shared'; await p3.win.context.session.replaceText(text); p3.win.pane.editor.setPosition(p3.win.pane.model().getPositionAt(text.length)); p3.win.pane.editor.focus(); const api = await import('/extensions/plv4_fixture/plv4/completion.js'); const values = await api.classSuggestions('new shared', p3.win.pane.editor); p3.suggestions = values; return values.length; });
    check('global Class index returns full weighted phrases and block prompts', await page.evaluate(async () => { const api = await import('/extensions/plv4_fixture/plv4/completion.js'); const block = await api.classSuggestions('Block', p3.win.pane.editor); const nested = await api.classSuggestions('nested', p3.win.pane.editor); return p3.suggestions.some(c => c.name === 'new shared phrase') && nested.length >= 2 && block.some(c => c.kind === 'classBlock'); }));
    await page.evaluate(async () => { const end = p3.win.context.session.text.length; p3.chosenSource = p3.suggestions[0].source; await p3.suggestions[0].insert(end - 'new shared'.length, end); });
    check('Class phrase insertion is a document command with provenance', await page.evaluate(() => p3.win.context.session.text.endsWith('new shared phrase') && p3.win.context.session.state.doc.root.children.at(-1).meta.source.class_id === p3.chosenSource.class_id));
    await page.evaluate(() => p3.win.undo());
    check('completion undo restores draft phrase across views', await page.evaluate(() => p3.win.context.session.text.endsWith('new shared')));
    await page.evaluate(async () => { const session = p3.win.context.session; const text = session.text.slice(0, -'new shared'.length) + 'new shared phr'; await session.replaceText(text); p3.win.pane.editor.setPosition(p3.win.pane.model().getPositionAt(text.length)); p3.win.pane.editor.focus(); });
    await page.keyboard.type('a');
    await page.locator('#xyz-tagac-root').waitFor({ state: 'visible' });
    check('existing tagAC dropdown shows Class phrases even with TagDB disabled', await page.locator('#xyz-tagac-root').textContent().then(text => text.includes('new shared phrase') && text.includes('Class')));
    await page.locator('#xyz-tagac-root [data-tagac-index]').first().click();
    await page.waitForFunction(() => p3.win.context.session.text.endsWith('new shared phrase'));
    check('actual tagAC selection inserts full phrase through shared history', await page.evaluate(() => !!p3.win.context.session.state.doc.root.children.at(-1).meta.source.attribute_id));
    await page.evaluate(async () => { await p3.win.setView('block'); const asset = await p3.client.libraryRequest('get', { id: p3.asset.id }); await p3.win.library.openAsset(asset); });
    check('saved Library block uses same editor and carries source version', await page.evaluate(() => p3.win.context.asset.id === p3.asset.id && p3.win.context.session.state.doc.root.children[0].meta.source.version === p3.asset.version));
    await page.evaluate(async () => { await p3.win.open(p3.node); const current = p3.win.context.session.state.doc.root.children[0]; const expanded = await p3.client.libraryRequest('expand', { id: p3.asset.id }); expanded.snapshot.children[0].raw = 'upstream change'; await p3.client.libraryRequest('save_block', { id: p3.asset.id, version: p3.asset.version, name: p3.asset.name, snapshot: expanded.snapshot }, true); await p3.win.locate(current.id); });
    await page.waitForFunction(() => [...document.querySelectorAll('.plv4-details button')].some(b => b.textContent === '来源有更新'));
    check('source updates are indicated without replacing local snapshot', await page.evaluate(() => !p3.win.context.session.text.includes('upstream change')));
    await page.evaluate(() => { p3.pending = p3.win.saveBlock(p3.win.context.session.projection.tree.children[0]).catch(e => e.code); });
    await dialog('保存 block').getByRole('button', { name: 'OK', exact: true }).click();
    check('stale shared overwrite is rejected', await page.evaluate(() => p3.pending) === 'asset_conflict');
    await page.evaluate(() => { p3.pending = p3.win.saveDocument(); });
    await dialog('保存完整 Document').locator('input').fill('Browser document'); await dialog('保存完整 Document').getByRole('button', { name: 'OK', exact: true }).click();
    check('whole Document save preserves disabled nodes and owner metadata', await page.evaluate(async () => { const value = await p3.pending; p3.documentAsset = value.asset; return !value.asset.data.doc.root.children[0].children[0].enabled && value.asset.data.doc.root.meta.owner; }));
    await page.evaluate(async () => { await p3.win.context.session.replaceText('temporary'); await p3.win.library.openAsset(p3.documentAsset); });
    check('whole Document load restores parked contents', await page.evaluate(() => !p3.win.context.session.state.doc.root.children[0].children[0].enabled));
    // Both Library handles drag into both editing views, never moving the source.
    for (const mode of ['block', 'syntax']) for (const insertion of ['block', 'prompts']) {
      await page.evaluate(async mode => { await p3.win.setView(mode); await p3.win.locate(p3.win.context.session.state.doc.root.id); await p3.win.library.reload(); }, mode);
      const selector = `[data-asset-id="${await page.evaluate(() => p3.asset.id)}"] [data-insert-mode="${insertion}"]`;
      const handle = page.locator(selector); await handle.scrollIntoViewIfNeeded();
      const beforeRevision = await page.evaluate(() => p3.win.context.session.revision);
      const start = await handle.boundingBox();
      const target = mode === 'block' ? await page.locator(`[data-block-id="${await page.evaluate(() => p3.target)}"] > .plv4-content`).first().boundingBox() : await page.evaluate(() => { const pane = p3.win.pane; pane.editor.setPosition(pane.model().getPositionAt(pane.model().getValueLength())); pane.editor.revealPosition(pane.editor.getPosition()); const p = pane.editor.getScrolledVisiblePosition(pane.editor.getPosition()), r = p3.win.syntax.getBoundingClientRect(); return { x: r.left + p.left, y: r.top + p.top, width: 20, height: p.height }; });
      await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2); await page.mouse.down();
      await page.mouse.move(target.x + Math.min(30, target.width / 2), target.y + target.height / 2, { steps: 12 });
      await page.locator('.plv4-drop').waitFor({ state: 'visible' }); await page.mouse.up();
      await page.waitForFunction(before => p3.win.context.session.revision > before, beforeRevision);
      const stored = await page.evaluate(async () => (await p3.client.libraryRequest('get', { id: p3.asset.id })).version);
      check(`Library ${insertion} handle drags into ${mode} and preserves shared source`, stored === (await page.evaluate(() => p3.asset.version)) + 1);
      await page.evaluate(() => p3.win.undo());
      check(`Library ${insertion} drag is one undo in ${mode}`, await page.evaluate(() => p3.win.context.session.future.length === 1));
    }
    const typing = await page.evaluate(async () => {
      const win = p3.win; await win.command({ type: 'InsertBlock', parent_id: win.context.session.state.doc.root.id, edge: 'end', text: '{ typing base }' });
      const block = win.context.session.state.doc.root.children.at(-1);
      await win.command({ type: 'SetMetadata', id: block.id, patch: { association: { mode: 'belongs', class_id: p3.cid } } });
      await win.setView('syntax'); const text = win.pane.model().getValue(), at = text.lastIndexOf('typing base');
      win.pane.editor.setSelection(win.pane.monaco.Range.fromPositions(win.pane.model().getPositionAt(at), win.pane.model().getPositionAt(at + 'typing base'.length))); win.pane.editor.focus();
      const value = await p3.client.libraryRequest('get', { id: p3.cid }); return value.data.attributes.length;
    });
    await page.keyboard.type('typing complete', { delay: 15 }); await page.evaluate(() => p3.win.context.session.whenIdle());
    check('continuous typing keeps intermediate spellings out of Class', await page.evaluate(async () => (await p3.client.libraryRequest('get', { id: p3.cid })).data.attributes.length) === typing);
    await page.evaluate(() => p3.win.setView('block'));
    check('finishing editing appends the final Class phrase once', await page.evaluate(async before => { const value = await p3.client.libraryRequest('get', { id: p3.cid }); return value.data.attributes.length === before + 1 && value.data.attributes.at(-1).snapshot?.raw === 'typing complete'; }, typing));
    const deep = await page.evaluate(async () => {
      const node = LiteGraph.createNode('XYZ Prompt Library V4'); node.widgets.find(w => w.name === 'text').value = '{ '.repeat(64) + 'deep leaf' + ' }'.repeat(64); app.graph.add(node);
      await p3.win.open(node);
      await p3.win.setView('block'); const count = p3.win.blocks.querySelectorAll('[data-block-id]').length;
      await p3.win.open(p3.node); app.graph.remove(node); return count;
    });
    check('64-level Block UI renders without recursive cache expansion', deep === 64);
    check('Library refresh updates completion after another session changes Class', await page.evaluate(async () => {
      const win = p3.win; await win.setView('syntax');
      const api = await import('/extensions/plv4_fixture/plv4/completion.js');
      await api.classSuggestions('external refreshed phrase', win.pane.editor);
      const asset = await p3.client.libraryRequest('get', { id: p3.cid });
      const parsed = await fetch('/xyz/plv4/document/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'external refreshed phrase' }) }).then(r => r.json());
      asset.data.attributes.push({ kind: 'prompt', snapshot: parsed.state.doc.root.children[0] });
      // Raw fetch intentionally bypasses this page's mutation notification.
      const reply = await fetch('/xyz/plv4/library/mutate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save_class', id: asset.id, version: asset.version, name: asset.name, folder_id: asset.folder_id, data: asset.data }) }).then(r => r.json());
      if (!reply.ok) throw new Error(reply.error);
      await win.library.reload();
      return (await api.classSuggestions('external refreshed phrase', win.pane.editor)).some(value => value.name === 'external refreshed phrase');
    }));
    await page.screenshot({ path: process.env.TEMP + '/plv4-p3-final.png' });
    check('no page runtime errors', errors.length === 0);
    console.log(JSON.stringify({ checks: count, errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
