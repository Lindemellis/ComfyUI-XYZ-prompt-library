// ARCHIVED 2026-10-07: Class-era browser fixture; do not run for Folder pools.
// Use seed_xyz_test_samples.py for offline conversion to a separate sample copy.
// Prepare a saved user workflow without replacing any open user's browser graph.
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const ROOT = 'E:/AI/ComfyUI-aki-v2/XYZNodes-Test';
const BASE = 'http://127.0.0.1:8190';

(async () => {
  const samples = JSON.parse(await fs.readFile(`${ROOT}/sample-content.json`, 'utf8'));
  assert.equal(samples.base_url, BASE);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(BASE); await page.bringToFront();
    await page.waitForFunction(() => window.app?.graph && window.plv4, { timeout: 45000 });
    const graph = await page.evaluate(async samples => {
      app.graph.clear(); const positions = [[430, 80], [430, 650], [1010, 80], [1010, 790]];
      const seed = LiteGraph.createNode('PrimitiveNode'); seed.title = '全局 seed · 统一控制'; seed.pos = [70, 90]; app.graph.add(seed);
      const { convertToInput } = await import('/extensions/core/widgetInputs.js');
      const nodes = [];
      for (const [index, sample] of samples.samples.entries()) {
        const node = LiteGraph.createNode(sample.type); node.title = sample.title; node.pos = positions[index];
        app.graph.add(node); node.widgets.find(w => w.name === 'text').value = sample.text;
        node.widgets.find(w => w.name === 'doc').value = JSON.stringify(sample.doc);
        node.widgets.find(w => w.name === 'region_mode').value = 'couple';
        convertToInput(node, node.widgets.find(w => w.name === 'seed'));
        seed.connect(0, node, node.inputs.findIndex(input => input.name === 'seed'));
        node.setSize([500, sample.type.endsWith('Monaco') ? 630 : 460]); nodes.push(node);
      }
      seed.widgets.find(w => w.type === 'number').value = 123456; seed.applyToGraph?.();
      const noteType = LiteGraph.registered_node_types.MarkdownNote ? 'MarkdownNote' : 'Note';
      if (LiteGraph.registered_node_types[noteType]) {
        const note = LiteGraph.createNode(noteType); note.title = '测试顺序'; note.pos = [70, 300]; app.graph.add(note);
        note.widgets[0].value = '1. 打开任意 PLv4 节点的 Editor。\n2. Library → 验收示例：查看完整路径、Class 和子 block。\n3. Class 拖到空白处新建 block，拖到未关联 block 则加载。\n4. 将 block 拖进 Library block 或 Class 页面。\n5. 开关、包组、切换 PLv3 / Block UI、撤销。\n6. 打开 A-晨雾，把 B-山谷拖进去，应报循环引用。\n7. 修改左上全局 seed，查看随机结果。'; note.setSize([310, 270]);
      }
      window.demo = { nodes, win: plv4.window };
      await demo.win.open(nodes[0]); await demo.win.setView('block');
      await demo.win.locate(demo.win.context.session.state.doc.root.children.find(n => n.meta?.name === '森林旅行者').id);
      await demo.win.sessions.flush();
      return app.graph.serialize();
    }, samples);
    const filename = 'XYZNodes-PLv4-验收示例.json';
    const saved = await page.request.post(`${BASE}/userdata/${encodeURIComponent(`workflows/${filename}`)}?overwrite=false`, { data: JSON.stringify(graph), headers: { 'Content-Type': 'application/json' } });
    assert.ok(saved.ok() || saved.status() === 409, `Save failed: ${saved.status()} ${await saved.text()}`);
    if (saved.ok()) await fs.writeFile(`${ROOT}/${filename}`, JSON.stringify(graph, null, 2), 'utf8');
    await page.screenshot({ path: `${ROOT}/示例-节点编辑器.png` });
    const facts = await page.evaluate(async samples => {
      const win = demo.win;
      const seed = (await win.inputs()).seed;
      await win.openClass(samples.key_assets.traveler);
      return { seed, sections: [...win.classContainer.querySelectorAll('summary')].map(n => n.textContent), source: win.shell.center.dataset.editorSource,
        closedItems: demo.nodes.some(n => JSON.parse(n.widgets.find(w => w.name === 'doc').value).root.children.some(b => b.children?.some(c => !c.enabled))) };
    }, samples);
    assert.equal(facts.seed, 123456); assert.equal(facts.sections.length, 3); assert.equal(facts.source, 'library-class'); assert.ok(facts.closedItems);
    await page.screenshot({ path: `${ROOT}/示例-Class属性页.png` });
    await page.evaluate(async id => { const win = demo.win; await win.library.openAsset(win.library.data.assets.find(a => a.id === id)); }, samples.key_assets.traveler_block);
    await page.screenshot({ path: `${ROOT}/示例-LibraryBlock.png` });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ workflow: `${ROOT}/${filename}`, documents: samples.samples.length, assets: samples.assets.length, ...facts, errors }));
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
