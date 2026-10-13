// Run only against the disposable real-ComfyUI fixture, with a fresh Chrome profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const base = process.env.PLV4_BASE_URL;
if (!base) throw new Error('Set PLV4_BASE_URL to a disposable ComfyUI fixture');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const info = await fetch(base + '/object_info').then(r => r.json());
  assert.ok(info['PLv4 Fixture Capture'], 'Disposable fixture only');
  const kinds = ['XYZ Prompt Library V3', 'XYZ Prompt Library V3 Monaco', 'XYZ Prompt Library V4', 'XYZ Prompt Library V4 Monaco'];
  for (const kind of kinds) assert.equal(!!info[kind].deprecated, kind.includes('V3'));
  assert.equal((await fetch(base + '/xyz/plv3/library/tree')).status, 404);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xyz-retirement-browser-'));
  const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--window-size=1600,1000', base], { windowsHide: true, stdio: 'ignore' });
  let ws, rpc;
  const requests = [], exceptions = [];
  let checks = 0;
  const check = (label, value) => { assert.ok(value, label); checks++; };
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await pause(25);
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const pages = await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json());
    ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let sequence = 0; const pending = new Map();
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
      if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
      const request = pending.get(message.id);
      if (request) { pending.delete(message.id); message.error ? request.reject(message.error) : request.resolve(message.result); }
    };
    rpc = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 30000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: value => { clearTimeout(timer); reject(value); } });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    await rpc('Network.enable'); await rpc('Runtime.enable'); await rpc('Page.bringToFront');
    await pause(12000); // ComfyUI bootstrap replaces the initial page context.
    await evaluate(`(async()=>{for(let i=0;i<800&&(!window.plv4||!window.plv4.window.app.graph);i++)await new Promise(r=>setTimeout(r,25));if(!window.plv4)throw new Error('V4 failed to load');window.editor=plv4.window;window.app=editor.app;app.graph.clear();window.nodes=[];window.waitUntil=async test=>{for(let i=0;i<400&&!test();i++)await new Promise(r=>setTimeout(r,25));if(!test())throw new Error('State did not settle')};})()`);
    check('No global standalone V3 UI', await evaluate('!window.plv3'));
    await evaluate(`document.querySelector('[aria-label="XYZ Tools"]').click()`);
    check('Tools menu contains only V4 prompt entries', await evaluate(`document.body.innerText.includes('Prompt Library V4 — Editor')&&!document.body.innerText.includes('Prompt Library V3 — Editor')&&!document.body.innerText.includes('Prompt Library V3 — Library')`));
    await evaluate(`document.querySelector('[aria-label="XYZ Tools"]').click()`);
    // Give untouched V3 nodes a parked item and verify merely mounting never adopts V4 policy.
    for (const kind of kinds) {
      await evaluate(`(async()=>{await waitUntil(()=>LiteGraph.registered_node_types[${JSON.stringify(kind)}]);const response=await fetch('/xyz/plv3/doc/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'{ red, blue }'})}).then(r=>r.json());const parked=await fetch('/xyz/plv3/doc/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({doc:response.doc,id:response.doc.root.children[0].children[0].id,enabled:false})}).then(r=>r.json());const node=LiteGraph.createNode(${JSON.stringify(kind)});node.widgets.find(w=>w.name==='doc').value=JSON.stringify(parked.doc);node.widgets.find(w=>w.name==='text').value=parked.text;app.graph.add(node);nodes.push(node);if(node.comfyClass.endsWith('Monaco'))await waitUntil(()=>!!node.__plv3Embed?.pe.editor);})()`);
    }
    await pause(800);
    check('Untouched V3 Monaco retains old compiler policy and its parked item', await evaluate(`(()=>{const node=nodes[1],doc=JSON.parse(node.widgets.find(w=>w.name==='doc').value);return !editor.sessions.contexts.has(node)&&doc.root.meta?.compiler!=='plv4'&&doc.root.children[0].children[0].enabled===false})()`));
    for (let i = 0; i < kinds.length; i++) {
      await evaluate(`(async()=>{window.node=nodes[${i}];if(editor.visible)await editor.hide();node.widgets.find(w=>w.name==='plv3_open_btns').element.querySelector('button').click();await waitUntil(()=>editor.visible&&editor.context?.node===node);await editor.context.session.whenIdle();})()`);
      check(kinds[i] + ' Editor button opens V4', await evaluate('editor.context.node===node&&editor.visible'));
      check(kinds[i] + ' adopts V4 without losing disabled items', await evaluate(`editor.context.session.state.doc.root.meta.compiler==='plv4'&&editor.context.session.state.doc.root.children[0].children[0].enabled===false`));
      await evaluate(`editor.setView('syntax')`);
      check(kinds[i] + ' Source shares the authoritative session', await evaluate('editor.pane.editSession===editor.context.session'));
      if (kinds[i].endsWith('Monaco')) check(kinds[i] + ' embedded and window models match', await evaluate('node.__plv3Embed.pe.model()===editor.pane.model()'));
      await evaluate(`(async()=>{const s=editor.context.session;await s.replaceText('{ blue, green }');await s.undo();})()`);
      check(kinds[i] + ' undo restores source and parked item', await evaluate(`editor.context.session.text.includes('blue')&&!editor.context.session.text.includes('green')&&editor.context.session.state.doc.root.children[0].children[0].enabled===false`));
      await evaluate(`(async()=>{await editor.setView('preview');await editor.preview();})()`);
      check(kinds[i] + ' Preview compiles with no V3 Library', await evaluate(`editor.output.textContent.includes('blue')&&!editor.output.textContent.includes('red')`));
    }
    await evaluate(`(async()=>{window.client=await import('/extensions/plv4_fixture/plv4/asset_client.js');const tree=await client.libraryRequest('tree');if(!tree.assets.some(a=>a.name==='Retirement Pool'))await client.libraryRequest('save_class',{name:'Retirement Pool'},true);await editor.setView('syntax');await editor.context.session.replaceText('[');const {provideCompletions}=await import('/extensions/plv4_fixture/plv3/complete.js');window.suggestions=(await provideCompletions(editor.pane.monaco,editor.pane.model(),{lineNumber:1,column:2},{onInsertBlock:true})).suggestions;})()`);
    check('Source uses V4 Library path completion', await evaluate(`suggestions.some(value=>value.label==='Retirement Pool')`));
    check('Incomplete Source remains a serializable draft', await evaluate(`JSON.parse(node.widgets.find(w=>w.name==='doc').value).draft==='['`));
    await evaluate(`(async()=>{await editor.context.session.undo();await editor.setView('block');await plv4.loras.open(node);await waitUntil(()=>!!plv4.loras.grid.querySelector('[data-lora-send]'));plv4.loras.grid.querySelector('[data-lora-send]').click();await waitUntil(()=>editor.context.session.text.includes('<lora:'));await editor.context.session.whenIdle();})()`);
    check('LoRA Browser Send writes a V4 block', await evaluate(`editor.context.session.text.includes('<lora:')&&editor.context.session.text.includes('Native Demo')`));
    await evaluate(`(async()=>{await editor.context.session.undo();plv4.loras.hide();window.savedGraph=app.graph.serialize();window.savedDocs=nodes.map(n=>JSON.parse(n.widgets.find(w=>w.name==='doc').value));await app.loadGraphData(savedGraph);await waitUntil(()=>app.graph._nodes.length===4);window.restored=app.graph._nodes;await editor.sessions.flush();})()`);
    check('Workflow reload retains all four node identities', await evaluate(`restored.every((n,i)=>n.comfyClass===savedGraph.nodes[i].type)`));
    check('Workflow reload keeps disabled nodes and stable IDs', await evaluate(`restored.every((n,i)=>{const doc=JSON.parse(n.widgets.find(w=>w.name==='doc').value);const a=savedDocs[i].root.children[0].children[0],b=doc.root.children[0].children[0];return a.id===b.id&&a.enabled===b.enabled})`));
    await evaluate(`(async()=>{const n=restored[3];await editor.open(n);await waitUntil(()=>!!n.__plv3Embed?.pe.model());})()`);
    check('Replacement workflow object shares its new embedded model', await evaluate(`editor.pane.model()===restored[3].__plv3Embed.pe.model()`));
    check('Old workflow objects have been released', await evaluate(`nodes.every(n=>!editor.sessions.contexts.has(n))`));
    check('No active frontend request to retired V3 Library', !requests.some(url => url.includes('/xyz/plv3/library/')));
    check('No uncaught prompt editor exceptions', !exceptions.some(detail => JSON.stringify(detail).includes('/extensions/plv4_fixture/')));
    console.log('PASS ' + checks + ' PLv3 retirement checks (real ComfyUI, no V3 Library)');
  } finally {
    if (rpc) await rpc('Browser.close').catch(() => {});
    ws?.close(); chrome.kill(); await pause(250);
    // This directory was created by this script and contains only this browser session.
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
