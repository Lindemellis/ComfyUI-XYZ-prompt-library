// Run against prototypes/plv4/serve.py --port 8767. Requires Playwright + Chrome.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto((process.env.PLV4_BASE_URL || 'http://127.0.0.1:8767') + '/prototypes/plv4/p1.html');
    await page.waitForFunction(() => window.p1?.pane.model(), { timeout: 30000 });
    await page.bringToFront();
    const original = await page.evaluate(async () => {
      const { pane, model, session } = window.p1;
      const source = session.text;
      pane.focus();
      pane.editor.executeEdits('keyboard-test', [{ range: model.getFullModelRange(), text: 'keyboard check' }]);
      await session.whenIdle();
      return source;
    });
    await page.keyboard.press('Control+z');
    await page.waitForFunction(source => window.p1.session.text === source && window.p1.pane.text() === source, original);
    const checks = await page.evaluate(async () => {
      const { session, pane, model } = window.p1;
      const checks = [];
      const check = (name, condition) => { if (!condition) throw new Error(name); checks.push(name); };
      const command = (type, args) => session.dispatch({ type, ...args });
      const initial = session.text;
      const block = session.state.doc.root.children[1];
      const off = block.children[1].id;
      await command('SetEnabled', { id: off, enabled: false });
      check('switch updates real Monaco without losing parked item', !pane.text().includes('off') && session.state.doc.root.children[1].children[1].id === off);
      const b = block.children[2].id;
      const a = block.children[0].id;
      await command('WrapSelection', { ids: [a, b] });
      check('wrap includes invisible node with its ID', session.state.doc.root.children[1].children[0].children[1].id === off);
      check('Monaco and document share source', pane.text() === session.text);
      session.setView('syntax');
      await model.undo();
      check('Monaco undo restores Block UI structure', session.state.doc.root.children[1].children[0].id === a && !session.text.includes('off'));
      session.setView('block');
      await session.redo();
      check('Block UI redo reapplies same group instance', session.state.doc.root.children[1].children[0].kind === 'group');
      await session.undo();
      await session.undo();
      check('cross-view undo returns byte-exact original', pane.text() === initial);
      const bad = '😀, { invalid .set{';
      model.setValue(bad);
      await session.whenIdle();
      check('typing saves invalid raw source', session.text === bad && !session.valid);
      session.setView('block');
      session.setView('syntax');
      check('view switches preserve invalid original in Monaco', pane.text() === bad && session.projection.tree === null);
      await model.undo();
      check('invalid draft undo restores valid document', session.valid && pane.text() === initial);
      // Multiple content events while round trips are still pending must not
      // replace the newest input with the server's earlier accepted draft.
      model.setValue('😀, first'); model.setValue('😀, second'); model.setValue('😀, final');
      await session.whenIdle();
      check('rapid Unicode typing is not overwritten by old responses', pane.text() === '😀, final' && session.text === pane.text());
      await session.replaceText(initial);
      const selected = session.state.doc.root.children[1].children[2];
      await command('LocateDetails', { id: selected.id });
      check('details locate exact ID after reconcile', session.state.selection.prompt_id === selected.id);
      const snapshot = session.state.doc.root.children[1];
      await command('InsertLibraryBlock', { parent_id: session.state.doc.root.id, before_id: snapshot.id, snapshot, source: { block_id: 'B' } });
      check('Library block inserts expanded snapshot with new root ID', session.state.doc.root.children[1].id !== snapshot.id);
      await session.undo();
      await command('InsertLibraryPrompts', { parent_id: session.state.doc.root.id, edge: 'start', snapshot });
      check('Library prompt insertion removes grouping', session.state.doc.root.children[0].kind === 'text' && session.state.doc.root.children[0].raw === 'a');
      const beforePreview = session.state.doc;
      const revision = session.revision;
      const result = await session.compile(window.p1.nodeInputs);
      check('preview uses host node inputs without document mutation', result.seed === window.p1.nodeInputs.seed && session.state.doc === beforePreview && revision === session.revision);
      await pane.lintNow();
      check('existing PromptEditor lint uses PLv4 outputs', window.p1.lastCompiled?.prompt === result.prompt);
      check('no binding error', window.p1.errors.length === 0);
      window.p1.binding.dispose();
      check('binding detaches cleanly', !pane.editSession);
      return checks;
    });
    assert.equal(errors.length, 0, errors.join('\n'));
    checks.unshift('real Ctrl+Z keyboard shortcut uses the shared document history');
    console.log(JSON.stringify({ passed: checks.length, checks, pageErrors: errors }, null, 2));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
