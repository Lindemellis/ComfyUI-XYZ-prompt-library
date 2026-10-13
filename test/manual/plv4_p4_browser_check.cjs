// ARCHIVED 2026-10-07: this historical Class-model browser check is obsolete.
// Current Folder-pool acceptance uses the offline t70-t77/Node suites; do not run this script against the new Library.
// V4 identities, global seed execution and explicit migration in the scratch app.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const BASE = process.env.PLV4_BASE_URL || 'http://127.0.0.1:8191';

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  let checks = 0; const check = (name, value) => { assert.ok(value, name); checks++; console.log('PASS', name); };
  try {
    await page.goto(BASE); const fixtureInfo = await page.request.get(`${BASE}/object_info`).then(r => r.json()); assert.ok(fixtureInfo['PLv4 Fixture Capture'], 'Run only against the disposable fixture, never the user test instance'); await page.bringToFront();
    await page.waitForFunction(() => window.app?.graph && window.plv4, { timeout: 60000 });
    await page.evaluate(async () => {
      app.graph.clear(); const node = LiteGraph.createNode('XYZ Prompt Library V4 Monaco'); app.graph.add(node);
      node.widgets.find(w => w.name === 'text').value = '{ a, b, c, d }.set{shuffle:true, random_select:2, seed:1}, [@schedule]: { 0 - 0.5: { <lora:cloth:0.7>, early }, 0.5 - 1: { late } }, [@region]: { [base]: { scene }, [imask:0]: { figure }, [fill]: { mist } }';
      const sink = LiteGraph.createNode('PLv4 Fixture Capture'); app.graph.add(sink); node.connect(0, sink, 0); node.connect(1, sink, 1);
      window.p4 = { node, sink, win: plv4.window };
      await p4.win.open(node);
    });
    await page.waitForFunction(() => p4.node.__plv3Embed?.pe?.editSession === p4.win.context.session);
    check('V4 Monaco node mounts the existing embedded editor and shared session', true);
    check('fresh-node initialization preserves text written while opening', await page.evaluate(() => p4.win.context.session.text.includes('random_select:2')));
    await page.evaluate(async () => {
      const { convertToInput } = await import('/extensions/core/widgetInputs.js'); convertToInput(p4.node, p4.node.widgets.find(w => w.name === 'seed'));
      const seed = LiteGraph.createNode('PrimitiveNode'); app.graph.add(seed); seed.connect(0, p4.node, p4.node.inputs.findIndex(i => i.name === 'seed'));
      seed.widgets.find(w => w.type === 'number').value = 987654; seed.applyToGraph?.(); p4.seed = seed;
    });
    check('new V4 node uses the connected global ComfyUI seed', await page.evaluate(async () => (await p4.win.inputs()).seed === 987654));
    for (const mode of ['couple', 'mask']) {
      const queued = await page.evaluate(async mode => {
        p4.node.widgets.find(w => w.name === 'region_mode').value = mode; await p4.win.sessions.flush();
        const expected = await p4.win.context.session.compile(await p4.win.inputs()); const graph = await app.graphToPrompt();
        const response = await fetch('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: graph.output, client_id: 'plv4-p4-test' }) });
        const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return { id: result.prompt_id, expected };
      }, mode);
      let history;
      for (let attempt = 0; attempt < 80; attempt++) { history = await (await page.request.get(`${BASE}/history/${queued.id}`)).json(); if (history[queued.id]) break; await new Promise(r => setTimeout(r, 100)); }
      const result = Object.values(history[queued.id]?.outputs || {})[0];
      check(`V4 ${mode} actual execution matches prompt/plain preview`, result?.prompt[0] === queued.expected.prompt && result?.plain[0] === queued.expected.plain);
      check(`${mode} retains scheduled LoRA and IMASK attach index`, queued.expected.prompt.includes('IMASK(0') && queued.expected.prompt.includes('cloth'));
    }
    const restored = await page.evaluate(async () => {
      const session = p4.win.context.session, item = session.state.doc.root.children[0].children[1];
      await p4.win.command({ type: 'SetEnabled', id: item.id, enabled: false }); await p4.win.sessions.flush(); const id = p4.node.id;
      const graph = app.graph.serialize(); await app.loadGraphData(graph); p4.node = app.graph.getNodeById(id); await p4.win.open(p4.node);
      return p4.win.context.session.state.doc.root.children[0].children[1].enabled === false;
    });
    check('V4 workflow reload retains off nodes during automatic session initialization', restored);
    const original = await page.request.get(`${BASE}/xyz/plv3/library/tree`).then(r => r.json());
    await page.evaluate(async () => { p4.win.shell.toggle('library', true); await p4.win.library.reload(); p4.pending = p4.win.library.migrate(); });
    await page.getByRole('button', { name: '备份并迁移', exact: true }).click();
    const report = await page.evaluate(() => p4.pending);
    check('explicit migration backs up V3 and creates visible V4 classes and instances', report.counts.classes >= 1 && report.backup.endsWith('.db'));
    const after = await page.request.get(`${BASE}/xyz/plv3/library/tree`).then(r => r.json());
    check('migration preserves the original V3 Library', JSON.stringify(original) === JSON.stringify(after));
    const repeated = await page.request.post(`${BASE}/xyz/plv4/library/migrate`, { data: {} }).then(r => r.json());
    check('repeating migration reports existing import without duplicate assets', repeated.repeated);
    const loaded = await page.evaluate(async report => {
      const source = Object.values(report.mapping.groups)[0];
      await p4.win.library.reload(); const asset = p4.win.library.data.assets.find(a => a.id === source.block);
      await p4.win.locate(p4.win.context.session.state.doc.root.id);
      await p4.win.library.insertAsset(asset, false);
      return p4.win.context.session.state.doc.root.children.some(n => n.meta?.source?.id === source.block && n.children.some(c => c.raw === 'library red'));
    }, report);
    check('migrated Library block inserts a portable full snapshot', loaded);
    check('no page runtime errors', errors.length === 0);
    console.log(JSON.stringify({ checks, errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
