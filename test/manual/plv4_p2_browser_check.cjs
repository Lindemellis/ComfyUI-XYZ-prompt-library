// Requires the isolated fixture prepared by plv4_comfy_fixture.py on port 8191.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const BASE = process.env.PLV4_BASE_URL || 'http://127.0.0.1:8191';
const SAMPLE = 'ambient, { before, duplicate, { child prompt, <lora:cloth:0.7> }, duplicate, after }.set{shuffle: true, seed: 123}, [@schedule]: { 0 - 0.4: { early }, 0.4 - 1: { late } }, [@region]: { [base]: { landscape }, [imask: 0]: { blue sky }, [fill]: { fog } }';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => { errors.push(error.message); console.log('PAGE ERROR', error.stack); });
  const checks = [];
  const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log('PASS', name); };
  try {
    await page.goto(BASE); const fixtureInfo = await page.request.get(`${BASE}/object_info`).then(r => r.json()); assert.ok(fixtureInfo['PLv4 Fixture Capture'], 'Run only against the disposable fixture, never the user test instance');
    await page.waitForFunction(() => window.app?.graph && window.plv4, { timeout: 60000 });
    await page.bringToFront();
    await page.evaluate(async source => {
      const app = window.app; app.graph.clear();
      const a = LiteGraph.createNode('XYZ Prompt Library V3'); a.title = 'Fixture A'; app.graph.add(a);
      a.widgets.find(w => w.name === 'text').value = source;
      a.widgets.find(w => w.name === 'seed').value = 42;
      const b = LiteGraph.createNode('XYZ Prompt Library V3'); b.title = 'Fixture B'; app.graph.add(b);
      b.widgets.find(w => w.name === 'text').value = '{ other node }';
      const sink = LiteGraph.createNode('PLv4 Fixture Capture'); app.graph.add(sink); a.connect(0, sink, 0); a.connect(1, sink, 1);
      window.p2 = { app, a, b, sink, win: window.plv4.window };
      await p2.win.open(a);
    }, SAMPLE);
    check('real ComfyUI window and actual Monaco loaded', await page.evaluate(() => p2.win.pane.model() && p2.win.context.session.valid));
    const result = await page.evaluate(async () => {
      const win = p2.win; const session = win.context.session; const results = [];
      const check = (name, value) => { if (!value) throw new Error(name); results.push(name); };
      const outer = session.state.doc.root.children[1]; const firstDuplicate = outer.children[1].id; const secondDuplicate = outer.children[3].id;
      await win.locate(secondDuplicate);
      check('duplicate prompt locates exact occurrence', session.state.selection.node_id === secondDuplicate && win.shell.details.querySelector('.plv4-item-row.active').dataset.promptId === secondDuplicate);
      await win.command({ type: 'SetEnabled', id: firstDuplicate, enabled: false });
      check('disabled item stays at original index and syncs node', session.state.doc.root.children[1].children[1].id === firstDuplicate && JSON.parse(p2.a.widgets.find(w => w.name === 'doc').value).root.children[1].children[1].enabled === false);
      await win.setView('syntax');
      check('syntax shares document rendering', win.pane.text() === session.text);
      await win.pane.model().undo();
      check('Monaco undo restores UI switch', session.state.doc.root.children[1].children[1].enabled);
      await win.command({ type: 'SetMetadata', id: outer.id, patch: { name: '人物' } });
      await win.command({ type: 'SetSettings', id: outer.id, patch: { format: '<{prompt}>', weight: 1.2 } });
      check('details metadata and source settings persisted', session.state.doc.root.children[1].meta.name === '人物' && session.text.includes('format:'));
      const schedule = session.state.doc.root.children[2];
      await win.command({ type: 'SetScheduleBoundary', id: schedule.children[0].id, side: 'end', value: .6 });
      const ast = session.projection.tree.children[2];
      check('shared schedule boundary updates both entries', ast.children[0].settings.schedule[1] === .6 && ast.children[1].settings.schedule[0] === .6);
      const region = session.state.doc.root.children[3].children[1];
      await win.command({ type: 'SetRegion', id: region.id, region: { kind: 'imask', imask: 2, feather: .1, cond_weight: .7 } });
      check('region edits preserve external head and siblings', session.text.includes('[imask: 2') && session.projection.tree.children[3].children[2].settings.region.kind === 'fill');
      const old = session.text;
      win.pane.model().setValue('😀, { invalid .set{'); await session.whenIdle();
      await win.setView('block'); await win.setView('syntax');
      check('invalid draft survives view changes and node save', win.pane.text() === '😀, { invalid .set{' && JSON.parse(p2.a.widgets.find(w => w.name === 'doc').value).draft === win.pane.text());
      await win.undo(); check('draft undo returns full document', session.valid && session.text === old);
      const viewContext = win.context; viewContext.folded.add(outer.id); viewContext.focus = outer.id;
      await win.setView('preview'); const output = await session.compile(await win.inputs());
      await win.open(p2.b); await win.command({ type: 'SetMetadata', id: win.context.session.state.doc.root.children[0].id, patch: { name: 'B' } }); await win.open(p2.a);
      check('node switching preserves per-node view selection folds and history', win.context === viewContext && win.context.focus === outer.id && win.context.folded.has(outer.id) && win.context.session.view === 'preview' && win.context.session.canUndo);
      await win.preview();
      check('prompt and plain preview use node seed', win.output.querySelectorAll('pre').length === 2 && win.output.querySelector('pre').textContent === output.prompt && output.seed === 42);
      await win.setView('block'); viewContext.focus = null; viewContext.folded.clear(); win.blockView.render(viewContext);
      return { results, prompt: output.prompt, plain: output.plain };
    });
    result.results.forEach(name => check(name, true));
    // Real UI details input, not just command API.
    await page.evaluate(async () => { await p2.win.locate(p2.win.context.session.state.doc.root.children[1].id); });
    await page.locator('.plv4-details input[data-field="name"]').fill('UI name');
    await page.locator('.plv4-details input[data-field="name"]').press('Tab');
    await page.waitForFunction(() => p2.win.context.session.state.doc.root.children[1].meta.name === 'UI name', null, { timeout: 5000 }).catch(async error => {
      console.log(await page.evaluate(() => ({ selection: p2.win.context.session.state.selection, meta: p2.win.context.session.state.doc.root.children[1].meta, input: p2.win.shell.details.innerHTML, errors: [...document.querySelectorAll('.plv3-toast')].map(n => n.textContent) })));
      throw error;
    });
    check('details input writes shared command history', true);
    // Native selection + keyboard history across details and syntax.
    await page.evaluate(async () => { await p2.win.setView('syntax'); p2.win.pane.focus(); });
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => p2.win.context.session.state.doc.root.children[1].meta.name === '人物');
    check('real Ctrl+Z undoes details change', true);
    await page.evaluate(async () => {
      const win = p2.win; await win.setView('block'); win.shell.toggle('library', true); await win.library.reload();
    });
    check('read-only Library tree loads fixture DB', await page.locator('.plv4-library-row').count() > 0);
    await page.evaluate(async () => {
      const win = p2.win; const group = win.library.data.groups[0]; const source = await win.library.context(group, null);
      const original = source.session.text; await win.locate(win.context.session.state.doc.root.id);
      await win.library.insert(group, null, false); await win.library.insert(group, null, true);
      if (source.session.text !== original) throw new Error('source mutated');
    });
    check('Library inserts structure and ordered prompts without changing asset', await page.evaluate(() => p2.win.context.session.text.includes('library blue')));
    await page.evaluate(async () => { const win = p2.win; await win.library.open(win.library.data.groups[0], null); });
    check('Library block uses same editor with isolated history', await page.evaluate(() => p2.win.context.session.state.scope === 'block' && p2.win.tablist.querySelector('[data-tab-kind="block"][aria-selected="true"]')?.title.includes('LIBRARY BLOCK')));
    await page.evaluate(async () => { const win = p2.win; await win.setView('syntax'); win.pane.model().setValue('outside, { bad single root }'); await win.context.session.whenIdle(); });
    const guard = await page.evaluate(async () => { try { await p2.win.open(p2.a); return false; } catch { return true; } });
    check('invalid Library draft retained and blocks context navigation', guard);
    await page.evaluate(async () => { await p2.win.undo(); await p2.win.open(p2.a); await p2.win.setView('block'); p2.win.shell.toggle('library', false); p2.win.toggleDetails(false); });
    // The accepted prototype's native input, without a dialog/double-click.
    await page.locator('.plv4-prompt').first().click();
    await page.locator('.plv4-prompt').first().fill('edited ambient');
    await page.evaluate(() => p2.win.flushEditor());
    check('focused TextRun updates parent document without a new AST group', await page.evaluate(() => p2.win.context.session.state.doc.root.children[0].kind === 'text' && p2.win.context.session.text.startsWith('edited ambient')));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !p2.win.blockView.inline);
    check('leaving native input releases its binding without an extra editor', true);
    await page.locator('.plv4-prompt').first().click();
    await page.waitForFunction(() => p2.win.blockView.inline?.run);
    await page.evaluate(async () => {
      const element = p2.win.blockView.inline.element;
      const type = async text => { element.innerText = text; element.dispatchEvent(new Event('input', { bubbles: true })); await p2.win.flushEditor(); };
      await type('first item, { subblock }, final item');
      await type('first item, { subblock, deeper text }, final item.');
      await type('😀 unfinished {');
      if (p2.win.context.session.valid || !JSON.parse(p2.a.widgets.find(w => w.name === 'doc').value).draft.startsWith('😀 unfinished {')) throw new Error('TextRun draft lost');
      await type('edited ambient');
    });
    await page.keyboard.press('Escape'); await page.waitForFunction(() => !p2.win.blockView.inline);
    check('TextRun supports item splitting nested syntax and invalid drafts', await page.evaluate(() => p2.win.context.session.valid && p2.win.context.session.text.startsWith('edited ambient')));
    const specialIds = await page.evaluate(() => p2.win.context.session.state.doc.root.children.slice(2, 4).map(n => n.id));
    await page.locator(`[data-block-id="${specialIds[0]}"] > .plv4-header button[title="添加子 block"]`).click();
    const scheduleDialog = page.getByText('Schedule entry', { exact: true }).locator('..');
    await scheduleDialog.locator('input').nth(0).fill('0.8'); await scheduleDialog.locator('input').nth(1).fill('1');
    await scheduleDialog.getByRole('button', { name: 'OK', exact: true }).click();
    await page.waitForFunction(() => p2.win.context.session.state.doc.root.children[2].children.length === 3);
    check('schedule add dialog creates continuous shared boundaries', await page.evaluate(() => p2.win.context.session.projection.tree.children[2].children[1].settings.schedule[1] === .8));
    await page.evaluate(async () => { await p2.win.undo(); });
    await page.locator(`[data-block-id="${specialIds[1]}"] > .plv4-header button[title="添加子 block"]`).click();
    const regionDialog = page.getByText('Region entry', { exact: true }).locator('..');
    await regionDialog.locator('select').selectOption('imask'); await regionDialog.getByRole('button', { name: 'OK', exact: true }).click();
    await page.waitForFunction(() => p2.win.context.session.state.doc.root.children[3].children.length === 4);
    check('region add dialog emits correct IMASK entry syntax', await page.evaluate(() => p2.win.context.session.projection.tree.children[3].children.at(-1).settings.region.imask === 0));
    await page.evaluate(async () => { await p2.win.undo(); await p2.win.locate(p2.win.context.session.state.doc.root.children[1].id); });
    const parentId = await page.evaluate(() => p2.win.context.session.state.doc.root.children[1].id);
    const lastPrompt = page.locator(`[data-block-id="${parentId}"] > .block-content > .block-body > .plv4-run > .plv4-prompt[contenteditable="true"]`).last();
    const lastText = await lastPrompt.innerText(); await lastPrompt.click(); await lastPrompt.fill(`${lastText}, direct prompt`);
    await page.evaluate(() => p2.win.flushEditor()); await page.keyboard.press('Escape');
    await page.waitForFunction(() => p2.win.context.session.text.includes('direct prompt'));
    check('typing after the last prompt appends at the chosen block without a dialog', true);
    await page.evaluate(async () => { await p2.win.undo(); });
    await page.locator('.plv4-details .plv4-item-row button[title="单条 Schedule / Region"]').first().click();
    await page.locator('.plv4-popover button').filter({ hasText: /^Weight$/ }).click();
    await page.locator('.plv4-details .plv4-item-weight').first().fill('1.45'); await page.locator('.plv4-details .plv4-item-weight').first().press('Tab');
    await page.waitForFunction(() => p2.win.context.session.state.doc.root.children[1].children[0].meta?.presentation === 'prompt');
    await page.locator('.plv4-details .plv4-item-row input[type="text"]').first().fill('weighted edit');
    await page.locator('.plv4-details .plv4-item-row input[type="text"]').first().press('Tab');
    await page.waitForFunction(() => p2.win.context.session.text.includes('weighted edit'));
    check('weighted prompt remains editable and the default content row matches the prototype', await page.locator('.plv4-details .plv4-item-row').first().evaluate(n => !n.querySelector('.plv4-item-weight')));
    await page.evaluate(async () => { await p2.win.undo(); await p2.win.undo(); p2.win.toggleDetails(false); });
    const dragIds = await page.evaluate(() => {
      const outer = p2.win.context.session.projection.tree.children[1];
      return { child: outer.children.find(n => n.form === 'brace').id, target: outer.children.at(-1).id, parent: outer.id };
    });
    const handle = page.locator(`[data-block-id="${dragIds.child}"] > .plv4-content > .plv4-handle`);
    const target = page.locator(`.plv4-prompt[data-prompt-id="${dragIds.target}"]`);
    await handle.scrollIntoViewIfNeeded(); const sourceRect = await handle.boundingBox(); const targetRect = await target.boundingBox();
    await page.mouse.move(sourceRect.x + 3, sourceRect.y + 10); await page.mouse.down();
    await page.mouse.move(targetRect.x + targetRect.width * .8, targetRect.y + targetRect.height / 2, { steps: 8 });
    check('drag preview identifies parent and exact prompt boundary', await page.evaluate(parent => p2.win.shell.win.el.contains(document.querySelector('.plv4-drop')) === false && !document.querySelector('.plv4-drop')?.hidden && document.querySelector('.plv4-drop').textContent.includes(parent), '人物'));
    await page.mouse.up();
    await page.waitForFunction(ids => p2.win.context.session.state.doc.root.children[1].children.at(-1).id === ids.child, dragIds);
    check('actual edge drag moves complete subtree to previewed boundary', true);
    await page.evaluate(async () => { await p2.win.undo(); });
    const afterUndo = await page.locator(`[data-block-id="${dragIds.child}"] > .plv4-content > .plv4-handle`).boundingBox();
    const sourceBeforeCancel = await page.evaluate(() => p2.win.context.session.text);
    await page.mouse.move(afterUndo.x + 3, afterUndo.y + 10); await page.mouse.down(); await page.mouse.move(afterUndo.x + 40, afterUndo.y + 60, { steps: 6 });
    await page.keyboard.press('Escape'); await page.mouse.up();
    check('canceling drag leaves document and history unchanged', await page.evaluate(text => p2.win.context.session.text === text && !document.querySelector('.plv4-drop'), sourceBeforeCancel));
    // Wrap a real DOM selection between repeated prompts, including parked rows.
    await page.evaluate(async () => {
      const win = p2.win; const outer = win.context.session.state.doc.root.children[1];
      const first = outer.children[0].id; const last = outer.children[1].id;
      const start = win.blocks.querySelector(`[data-prompt-id="${first}"]`); const end = win.blocks.querySelector(`[data-prompt-id="${last}"]`);
      const range = document.createRange(); range.setStart(start.firstChild, 0); range.setEnd(end.firstChild, end.firstChild.length); getSelection().removeAllRanges(); getSelection().addRange(range);
      window.wrapIds = [first, last];
    });
    await page.locator('.plv4-prompt').filter({ hasText: /^duplicate$/ }).first().click({ button: 'right' });
    await page.getByRole('button', { name: '选区原位包组', exact: true }).click();
    await page.waitForFunction(() => p2.win.context.session.state.doc.root.children[1].children[0].children?.[0]?.id === wrapIds[0]);
    check('right-click preserves selected prompts and wraps them in place', true);
    await page.evaluate(async () => { await p2.win.undo(); });
    // Two views sharing a model must create one history item per keystroke.
    const shared = await page.evaluate(async () => {
      const node = LiteGraph.createNode('XYZ Prompt Library V3 Monaco'); p2.app.graph.add(node); node.title = 'Embedded fixture';
      node.widgets.find(w => w.name === 'text').value = '{ shared, tail }';
      window.embeddedFixture = node;
      await p2.win.open(node);
    });
    await page.waitForFunction(() => embeddedFixture.__plv3Embed?.pe.model() && p2.win.context.bindings.size === 2);
    const sharedResult = await page.evaluate(async () => {
      const win = p2.win; const session = win.context.session; const before = session.past.length;
      const embedded = embeddedFixture.__plv3Embed.pe;
      embedded.model().setValue('{ shared edit, tail }'); await session.whenIdle();
      const count = session.past.length - before;
      const same = embedded.model() === win.pane.model() && embedded.text() === session.text;
      await win.hide(); embedded.model().setValue('{ editing while window closed }'); await session.whenIdle();
      await win.open(embeddedFixture); const reopened = win.pane.text() === '{ editing while window closed }';
      await win.open(p2.a); p2.app.graph.remove(embeddedFixture);
      return { count, same, reopened };
    });
    check('embedded and floating Monaco share one model and one history edit', sharedResult.count === 1 && sharedResult.same && sharedResult.reopened);
    // Rapid context requests are serialized and cannot bind the wrong model.
    check('rapid node tabs end on requested node with matching source', await page.evaluate(async () => {
      await Promise.all([p2.win.open(p2.b), p2.win.open(p2.a), p2.win.open(p2.b), p2.win.open(p2.a)]);
      return p2.win.context.node === p2.a && p2.win.pane.text() === p2.win.context.session.text;
    }));
    const linkedSeed = await page.evaluate(async () => {
      const { convertToInput } = await import('/extensions/core/widgetInputs.js');
      convertToInput(p2.a, p2.a.widgets.find(w => w.name === 'seed'));
      const globalSeed = LiteGraph.createNode('PrimitiveNode'); p2.app.graph.add(globalSeed); globalSeed.title = 'Global seed';
      globalSeed.connect(0, p2.a, p2.a.inputs.findIndex(i => i.name === 'seed'));
      const seedWidget = globalSeed.widgets.find(w => w.type === 'number');
      if (!seedWidget) throw new Error(JSON.stringify({ inputs: p2.a.inputs, outputs: globalSeed.outputs, widgets: globalSeed.widgets.map(w => ({ name: w.name, type: w.type })) }));
      seedWidget.value = 987654;
      globalSeed.applyToGraph?.();
      window.globalSeedFixture = globalSeed;
      const actual = await p2.win.inputs(); const output = await p2.win.context.session.compile(actual);
      return { actual: actual.seed, seed: output.seed };
    });
    check('connected global seed resolves through ComfyUI prompt serialization', linkedSeed.actual === 987654 && linkedSeed.seed === 987654);
    const modes = await page.evaluate(async () => {
      const win = p2.win; const mode = p2.a.widgets.find(w => w.name === 'region_mode');
      const couple = await win.context.session.compile(await win.inputs()); mode.value = 'mask'; mode.callback?.call(p2.a, 'mask');
      const mask = await win.context.session.compile(await win.inputs()); await win.setView('preview'); await win.preview(); await win.setView('block');
      return { different: couple.prompt !== mask.prompt, samePlain: couple.plain === mask.plain, mode: mask.region_mode };
    });
    check('both region backends preserve the same plain output and node seed', modes.different && modes.samePlain && modes.mode === 'mask');
    // Density and side-pane resize, including keyboard separator.
    for (const [width, height] of [[960, 640], [720, 500]]) {
      await page.evaluate(([w, h]) => { const shell = p2.win.shell; shell.win.el.style.width = `${w}px`; shell.win.el.style.height = `${h}px`; shell.layout(); }, [width, height]);
      const bounds = await page.evaluate(() => [...p2.win.blocks.querySelectorAll('.plv4-header')].every(n => n.scrollWidth <= n.clientWidth + 1));
      check(`headers fit ${width}×${height}`, bounds);
    }
    await page.evaluate(() => { p2.win.toggleDetails(true); p2.win.shell.toggle('library', true); });
    const before = await page.evaluate(() => ({ window: p2.win.shell.win.el.getBoundingClientRect().toJSON(), pane: p2.win.shell.details.offsetWidth }));
    await page.locator('.plv4-split[aria-label="details"]').focus(); await page.keyboard.press('ArrowLeft');
    const after = await page.evaluate(() => ({ window: p2.win.shell.win.el.getBoundingClientRect().toJSON(), pane: p2.win.shell.details.offsetWidth }));
    check('keyboard splitter redistributes panes without resizing window', before.window.width === after.window.width && before.window.x === after.window.x && after.pane > before.pane);
    // Execute the actual graph and compare compiler output to preview.
    const execution = await page.evaluate(async () => {
      const win = p2.win; await win.sessions.flush(); const expected = await win.context.session.compile(await win.inputs());
      const graph = await p2.app.graphToPrompt();
      const response = await fetch('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graph.output, client_id: 'plv4-p2-test' }) });
      const queued = await response.json(); if (!response.ok) throw new Error(JSON.stringify(queued));
      return { expected, id: queued.prompt_id };
    });
    let history;
    for (let i = 0; i < 80; i++) { history = await (await page.request.get(new URL(`/history/${execution.id}`, page.url()).href)).json(); if (history[execution.id]) break; await new Promise(r => setTimeout(r, 100)); }
    const captured = history[execution.id]?.outputs;
    assert.ok(captured, JSON.stringify(history));
    const capture = Object.values(captured)[0];
    check('actual execution matches preview with group seed overrides ignored', capture.prompt[0] === execution.expected.prompt && capture.plain[0] === execution.expected.plain);
    const performanceResults = await page.evaluate(async () => {
      const win = p2.win; win.toggleDetails(false); win.shell.toggle('library', false);
      const original = win.context.session.text; const results = [];
      for (const count of [100, 500]) {
        const source = Array.from({ length: count }, (_, i) => `{ tag_${i}, { nested_${i} }, after_${i} }`).join(', ');
        const started = performance.now(); await win.context.session.replaceText(source); await win.setView('block');
        const rendered = performance.now(); const editors = win.pane.monaco.editor.getEditors().length;
        const ids = win.context.session.state.doc.root.children; const first = ids[0].id;
        await win.command({ type: 'MoveBlock', id: first, parent_id: win.context.session.state.doc.root.id, after_id: ids.at(-1).id });
        results.push({ blocks: count * 2, openMs: Math.round(rendered - started), moveMs: Math.round(performance.now() - rendered), editors, domBlocks: win.blocks.querySelectorAll('[data-block-id]').length });
      }
      // Restore the exact snapshot, including names/parked items, rather than
      // round-tripping a stress document through raw reconciliation.
      for (let i = 0; i < 4; i++) await win.undo(); return results;
    });
    check('100/500 top-level blocks use static rows and one floating editor', performanceResults.every(r => r.editors === 1 && r.domBlocks === r.blocks));
    console.log('PERFORMANCE', JSON.stringify(performanceResults));
    check('node tabs and view switches restore scroll and syntax cursor', await page.evaluate(async () => {
      const win = p2.win;
      await win.context.session.replaceText(Array.from({ length: 30 }, (_, i) => `{ scroll_${i}, tail }`).join('\n, ')); await win.setView('block');
      win.blocks.scrollTop = 520; await new Promise(requestAnimationFrame); const expected = win.blocks.scrollTop;
      await win.setView('syntax'); win.pane.editor.setPosition({ lineNumber: 20, column: 4 }); await win.setView('block');
      const modeScroll = win.blocks.scrollTop; await win.open(p2.b); await win.open(p2.a); const nodeScroll = win.blocks.scrollTop;
      await win.setView('syntax'); const cursor = win.pane.editor.getPosition(); await win.setView('block'); await win.undo();
      return expected > 0 && modeScroll === expected && nodeScroll === expected && cursor.lineNumber === 20 && cursor.column === 4;
    }));
    await page.evaluate(async () => {
      const win = p2.win; win.shell.win.el.style.width = '960px'; win.shell.win.el.style.height = '640px'; win.shell.layout();
      await win.locate(win.context.session.state.doc.root.children[1].id); win.shell.toggle('library', true); await win.library.reload();
    });
    await page.screenshot({ path: process.env.PLV4_SCREENSHOT || `${process.env.TEMP}/plv4-p2-final.png` });
    const restored = await page.evaluate(async () => {
      const win = p2.win; const item = win.context.session.state.doc.root.children[1].children[0].id;
      await win.command({ type: 'SetEnabled', id: item, enabled: false });
      await win.sessions.flush(); const originalDoc = p2.a.widgets.find(w => w.name === 'doc').value;
      const id = p2.a.id; const graph = p2.app.graph.serialize();
      await p2.app.loadGraphData(graph); const newNode = p2.app.graph.getNodeById(id); await win.open(newNode);
      const stored = JSON.parse(newNode.widgets.find(w => w.name === 'doc').value);
      p2.a = newNode; p2.b = p2.app.graph._nodes.find(n => n.title === 'Fixture B');
      return stored.root.children[1].children[0].enabled === false && stored.root.meta.compiler === 'plv4' && win.context.node === newNode;
    });
    check('workflow reload restores disabled items and creates fresh node session', restored);
    // Reopen and node removal must release sessions and models.
    await page.evaluate(async () => { const win = p2.win; await win.hide(); await win.open(p2.a); p2.app.graph.remove(p2.a); });
    await page.waitForFunction(() => !p2.win.sessions.contexts.has(p2.a));
    check('node removal releases document bindings', true);
    check('no page runtime errors', errors.length === 0);
    console.log(JSON.stringify({ checks: checks.length, errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
