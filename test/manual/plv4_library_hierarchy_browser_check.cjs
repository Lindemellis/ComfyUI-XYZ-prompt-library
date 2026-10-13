// ARCHIVED 2026-10-07: this historical Class-model browser check is obsolete.
// Current Folder-pool acceptance uses the offline t70-t77/Node suites; do not run this script against the new Library.
// Only run against the isolated real-ComfyUI fixture, never a personal Library.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const BASE = process.env.PLV4_BASE_URL || 'http://127.0.0.1:8191';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let count = 0;
  const check = (name, value) => { assert.ok(value, name); count++; console.log('PASS', name); };
  const dialog = title => page.getByText(title, { exact: true }).last().locator('..');
  const mutation = (action, field, value) => page.waitForResponse(response => response.url().endsWith('/xyz/plv4/library/mutate') && response.request().postDataJSON()?.action === action && response.request().postDataJSON()?.[field] === value);
  const row = id => page.locator(`.plv4-library-row[data-asset-id="${id}"]`);
  const menu = async (id, label) => { await row(id).scrollIntoViewIfNeeded(); await row(id).click({ button: 'right' }); await page.locator('.plv4-popover').getByRole('button', { name: label, exact: true }).click(); };
  const created = async (parentId, label, kind, name) => {
    if (parentId) await menu(parentId, label);
    else await page.evaluate(() => { h.pending = h.win.library.create('folder'); });
    await dialog(`新建 ${kind}`).locator('input').fill(name);
    const response = mutation(kind === 'block' ? 'create_block' : `save_${kind}`, 'name', name);
    await dialog(`新建 ${kind}`).getByRole('button', { name: 'OK', exact: true }).click();
    const result = await (await response).json(); assert.ok(result.ok, result.error);
    if (kind !== 'folder') await page.waitForFunction(([kind, id]) => kind === 'class' ? h.win.classContext === id : h.win.context?.asset?.id === id, [kind, result.asset.id]);
    await page.evaluate(() => h.win.library.reload());
    return result.asset;
  };
  const drag = async (source, target) => {
    await source.scrollIntoViewIfNeeded(); const start = await source.boundingBox();
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2); await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 12 });
    await page.locator('.plv4-drop').waitFor({ state: 'visible' });
    const text = await page.locator('.plv4-drop').textContent(); await page.mouse.up();
    return text;
  };
  try {
    await page.goto(BASE); const fixtureInfo = await page.request.get(`${BASE}/object_info`).then(r => r.json()); assert.ok(fixtureInfo['PLv4 Fixture Capture'], 'Run only against the disposable fixture, never the user test instance');
    await page.waitForFunction(() => window.app?.graph && window.plv4, { timeout: 60000 }); await page.bringToFront();
    await page.evaluate(async () => {
      app.graph.clear(); const node = LiteGraph.createNode('XYZ Prompt Library V4');
      node.widgets.find(w => w.name === 'text').value = 'ambient, { unclassified }'; app.graph.add(node);
      window.h = { node, win: plv4.window, client: await import('/extensions/plv4_fixture/plv4/asset_client.js') };
      await h.win.open(node); h.win.shell.toggle('library', true); await h.win.library.reload();
    });
    const stamp = Date.now();
    const folder = await created(null, '', 'folder', `Hierarchy ${stamp}`);
    await row(folder.id).click({ button: 'right' });
    check('folder menu offers all six requested operations', await page.locator('.plv4-popover').textContent().then(t => ['重命名', '添加 subfolder', '添加 Class', '添加 Block', '移动', 'Delete'].every(label => t.includes(label))));
    await page.keyboard.press('Escape'); await page.mouse.click(5, 5);
    const subfolder = await created(folder.id, '添加 subfolder', 'folder', `Subfolder ${stamp}`);
    const cls = await created(subfolder.id, '添加 Class', 'class', `Class ${stamp}`);
    await row(cls.id).click({ button: 'right' });
    check('Class menu offers subclass and owned instance creation', await page.locator('.plv4-popover').textContent().then(t => ['重命名', '添加 subclass', '新建该 Class 的 block instance', '移动', 'Delete'].every(label => t.includes(label))));
    await page.mouse.click(5, 5);
    const subclass = await created(cls.id, '添加 subclass', 'class', `Subclass ${stamp}`);
    const block = await created(subclass.id, '新建该 Class 的 block instance', 'block', `Block ${stamp}`);
    await row(block.id).click({ button: 'right' });
    check('block menu offers rename subblock move and delete', await page.locator('.plv4-popover').textContent().then(t => ['重命名', '添加 subblock', '移动', 'Delete'].every(label => t.includes(label))));
    await page.mouse.click(5, 5);
    const subblock = await created(block.id, '添加 subblock', 'block', `Subblock ${stamp}`);
    check('full name includes folder subfolder Class subclass block and subblock', subblock.path === [folder.name, subfolder.name, cls.name, subclass.name, block.name, subblock.name].join('.'));
    check('Library titles expose the complete PLv3 path', await row(subblock.id).locator('.plv4-library-name').getAttribute('title') === subblock.path);
    await page.evaluate(async id => { const a = await h.client.libraryRequest('get', { id }); await h.win.library.openAsset(a); await h.win.setView('syntax'); }, block.id);
    check('Library syntax references full paths for parent and child', await page.evaluate(([a, b]) => h.win.context.session.text.includes(`[${a}]: {`) && h.win.context.session.text.includes(`[${b}]: {`), [block.path, subblock.path]));
    await menu(folder.id, '重命名'); await dialog('重命名').locator('input').fill(`Renamed ${stamp}`); const renamed = mutation('rename', 'id', folder.id); await dialog('重命名').getByRole('button', { name: 'OK', exact: true }).click();
    assert.ok((await (await renamed).json()).ok);
    await page.evaluate(() => h.win.library.reload());
    const freshBlock = await page.evaluate(async id => h.client.libraryRequest('get', { id }), block.id);
    check('renaming ancestor updates complete names without moving references', freshBlock.path.startsWith(`Renamed ${stamp}.`) && freshBlock.parent_id === subclass.id);
    await menu(cls.id, '移动'); await dialog('移动').locator('select').selectOption(folder.id); const moved = mutation('move', 'id', cls.id); await dialog('移动').getByRole('button', { name: 'OK', exact: true }).click();
    assert.ok((await (await moved).json()).ok);
    await page.evaluate(() => h.win.library.reload());
    check('moving Class relocates its entire path hierarchy', await page.evaluate(async ([id, prefix]) => (await h.client.libraryRequest('get', { id })).path.startsWith(prefix), [subblock.id, `Renamed ${stamp}.${cls.name}.`]));
    await page.evaluate(async () => { await h.win.open(h.node); await h.win.setView('block'); });
    const area = await page.locator('.plv4-blocks').boundingBox();
    const marker = await drag(row(subclass.id).locator('.plv4-library-name'), { x: area.x + area.width / 2, y: area.y + area.height - 40 });
    await page.waitForFunction(id => h.win.context.session.state.doc.root.children.some(n => n.meta?.association?.mode === 'belongs' && n.meta.association.class_id === id), subclass.id);
    check('Class drag into empty space creates a belonging block at the target', marker.includes('新建属于 Class') && await page.evaluate(name => h.win.context.session.state.doc.root.children.at(-1).header.endsWith(name), subclass.name));
    await page.evaluate(() => h.win.undo());
    check('Class block insertion is one shared undo', await page.evaluate(() => h.win.context.session.state.doc.root.children.length === 2 && h.win.context.session.future.length === 1));
    await page.evaluate(() => h.win.setView('syntax'));
    const syntaxPoint = offset => page.evaluate(async offset => {
      const pane = h.win.pane; pane.relayout(); const position = pane.model().getPositionAt(offset);
      pane.editor.revealPosition(position);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const p = pane.editor.getScrolledVisiblePosition(position), r = pane.editor.getDomNode().getBoundingClientRect();
      const point = { x: r.left + p.left + 2, y: r.top + p.top + p.height / 2 };
      return point;
    }, offset);
    const syntaxMarker = await drag(row(subclass.id).locator('.plv4-library-name'), await syntaxPoint(1));
    await page.waitForFunction(id => h.win.context.session.state.doc.root.children[0].meta?.association?.class_id === id, subclass.id, { timeout: 5000 }).catch(async error => { console.log('SYNTAX DROP', syntaxMarker, await page.evaluate(() => ({ text: h.win.context.session.text, children: h.win.context.session.state.doc.root.children.map(n => ({ kind: n.kind, meta: n.meta })), toast: [...document.querySelectorAll('.plv3-toast')].map(n => n.textContent) }))); throw error; });
    check('Class drag into PLv3 syntax inserts a belonging block at the text position', await page.evaluate(() => h.win.context.session.state.doc.root.children.length === 3));
    await page.evaluate(() => h.win.undo());
    await drag(row(subclass.id).locator('.plv4-library-name'), await syntaxPoint(await page.evaluate(() => h.win.context.session.text.indexOf('unclassified') + 5)));
    await page.waitForFunction(id => h.win.context.session.state.doc.root.children[1].meta?.association?.class_ids?.includes(id), subclass.id);
    check('Class drop on an unclassified block in syntax loads Class in place', await page.evaluate(() => h.win.context.session.state.doc.root.children.length === 2));
    await page.evaluate(async () => { await h.win.undo(); await h.win.setView('block'); });
    const targetId = await page.evaluate(() => h.win.context.session.state.doc.root.children[1].id);
    const target = await page.locator(`[data-block-id="${targetId}"] > .plv4-content`).boundingBox();
    await drag(row(subclass.id).locator('.plv4-library-name'), { x: target.x + 50, y: target.y + target.height / 2 });
    await page.waitForFunction(id => h.win.context.session.state.doc.root.children[1].meta?.association?.class_ids?.includes(id), subclass.id);
    check('Class drop on an unclassified block loads it without replacing content', await page.evaluate(() => h.win.context.session.state.doc.root.children[1].children[0].raw === 'unclassified' && h.win.context.session.state.doc.root.children[1].meta.association.mode === 'loads'));
    await page.evaluate(async ([blockId, folderId]) => {
      const result = await h.client.libraryRequest('create_block', { name: `Target ${Date.now()}`, parent_id: folderId }, true); h.targetAsset = result.asset;
      const snapshot = (await h.client.libraryRequest('expand', { id: blockId })).snapshot;
      await h.win.library.reload(); await h.win.library.openAsset(h.targetAsset); await h.win.setView('block'); h.before = h.win.context.session.revision;
    }, [block.id, folder.id]);
    const rootId = await page.evaluate(() => h.win.context.session.state.doc.root.children[0].id);
    const body = await page.locator(`[data-block-id="${rootId}"] > .plv4-content`).boundingBox();
    await drag(row(block.id).locator('[data-insert-mode="block"]'), { x: body.x + 35, y: body.y + body.height / 2 });
    await page.waitForFunction(() => h.win.context.session.revision > h.before);
    check('block drag into an open Library block inserts a source instance', await page.evaluate(id => h.win.context.session.state.doc.root.children[0].children[0].meta.source.id === id, block.id));
    await page.evaluate(() => h.win.undo());
    check('Library block insertion uses its own one-step undo', await page.evaluate(() => h.win.context.session.state.doc.root.children[0].children.length === 0));
    await page.evaluate(async () => { const a = await h.client.libraryRequest('save_class', { name: `Attributes ${Date.now()}`, data: { attributes: [] } }, true); h.attributeClass = a.asset; await h.win.library.reload(); await h.win.openClass(a.id); });
    const attributes = await page.locator('[data-attribute-kind="block"]').boundingBox();
    await drag(row(block.id).locator('[data-insert-mode="block"]'), { x: attributes.x + attributes.width / 2, y: attributes.y + 20 });
    await page.waitForFunction(id => h.win.classPage.asset.data.attributes.some(a => a.kind === 'block' && a.ref_id === id), block.id);
    check('block drag into Class adds a shared Block attribute with its full path', await page.locator('.plv4-attribute .plv4-library-name').textContent().then(t => t.includes(cls.name) && t.includes(block.name)));
    await page.evaluate(() => h.win.undo());
    check('dragged Class attribute supports one shared undo', await page.evaluate(() => h.win.classPage.asset.data.attributes.length === 0));
    // Actual existing Monaco path provider and expansion command.
    const path = await page.evaluate(async id => (await h.client.libraryRequest('get', { id })).path, subblock.id);
    await page.evaluate(async path => { await h.win.open(h.node); await h.win.setView('syntax'); await h.win.context.session.replaceText(`before, [${path}], after`); const position = h.win.pane.model().getPositionAt(9 + path.length); h.win.pane.editor.setPosition(position); h.win.pane.editor.focus(); h.win.pane.editor.trigger('keyboard', 'editor.action.triggerSuggest', {}); }, path);
    const suggestion = page.locator('.suggest-widget.visible .monaco-list-row').filter({ hasText: path }).first();
    await suggestion.waitFor(); await suggestion.click();
    await page.waitForFunction(id => h.win.context.session.state.doc.root.children.some(n => n.meta?.source?.id === id), subblock.id);
    check('PLv3 bracket completion uses full paths and inserts an expanded snapshot', await page.evaluate(path => h.win.context.session.text.includes(`[${path}]: {`) && h.win.context.session.valid, path));
    // Self-reference drag must report and leave the Library draft unchanged.
    await page.evaluate(async () => { await h.win.library.openAsset(h.targetAsset); await h.win.setView('block'); h.beforeText = h.win.context.session.text; h.before = h.win.context.session.revision; });
    const selfId = await page.evaluate(() => h.win.context.session.state.doc.root.children[0].id);
    const selfBody = await page.locator(`[data-block-id="${selfId}"] > .plv4-content`).boundingBox();
    await drag(row(await page.evaluate(() => h.targetAsset.id)).locator('[data-insert-mode="block"]'), { x: selfBody.x + 35, y: selfBody.y + selfBody.height / 2 });
    await page.waitForFunction(() => document.body.textContent.includes('循环引用'));
    check('self-reference drag reports an error without changing the document', await page.evaluate(() => h.win.context.session.text === h.beforeText && h.win.context.session.revision === h.before));
    const indirect = await page.evaluate(async () => {
      const source = await h.client.libraryRequest('expand', { id: h.targetAsset.id });
      const opened = await fetch('/xyz/plv4/document/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '{ }' }) }).then(r => r.json());
      const snapshot = opened.state.doc.root.children[0]; snapshot.id = 'indirect-root'; snapshot.children = [source.snapshot];
      const result = await h.client.libraryRequest('save_block', { name: `Indirect ${Date.now()}`, snapshot }, true); await h.win.library.reload(); return result.asset;
    });
    const rejected = mutation('edit', 'library_asset_id', await page.evaluate(() => h.targetAsset.id));
    await drag(row(indirect.id).locator('[data-insert-mode="block"]'), { x: selfBody.x + 35, y: selfBody.y + selfBody.height / 2 });
    check('indirect A to B to A drag is rejected before shared writes', (await (await rejected).json()).code === 'reference_cycle' && await page.evaluate(() => h.win.context.session.text === h.beforeText));
    await menu(subblock.id, 'Delete'); await dialog('删除 Library 对象').locator('select').selectOption('delete'); const guarded = mutation('delete', 'id', subblock.id); await dialog('删除 Library 对象').getByRole('button', { name: 'OK', exact: true }).click();
    check('deleting a shared subblock reports its external Class reference', (await (await guarded).json()).code === 'asset_in_use');
    await page.evaluate(async ([id, ref]) => { const current = await h.client.libraryRequest('get', { id }); current.data.attributes = current.data.attributes.filter(a => a.ref_id !== ref); await h.client.libraryRequest('save_class', { id, version: current.version, parent_id: current.parent_id, name: current.name, data: current.data }, true); }, [subclass.id, subblock.id]);
    await menu(subblock.id, 'Delete'); await dialog('删除 Library 对象').locator('select').selectOption('delete'); const deleted = mutation('delete', 'id', subblock.id); await dialog('删除 Library 对象').getByRole('button', { name: 'OK', exact: true }).click();
    assert.ok((await (await deleted).json()).ok);
    check('subblock deletion unlinks its owner without deleting the parent', await page.evaluate(async id => (await h.client.libraryRequest('get', { id })).data.snapshot.children.length === 0, block.id));
    check('no page runtime errors', errors.length === 0);
    console.log(JSON.stringify({ checks: count, errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
