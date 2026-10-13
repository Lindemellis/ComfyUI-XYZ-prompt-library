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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xyz-class-browser-'));
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
    const click = async expression => {
      await evaluate(`(${expression}).scrollIntoView({block:'nearest'})`);
      const point = await evaluate(`(()=>{const r=(${expression}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await rpc('Input.dispatchMouseEvent', {type:'mouseMoved',...point});
      await rpc('Input.dispatchMouseEvent', {type:'mousePressed',...point,button:'left',clickCount:1});
      await pause(80);await rpc('Input.dispatchMouseEvent', {type:'mouseReleased',...point,button:'left',clickCount:1});await pause(150);
    };
    await rpc('Network.enable'); await rpc('Runtime.enable'); await rpc('Page.bringToFront');
    await pause(15000); // ComfyUI bootstrap replaces the initial page context.
    await evaluate(`(async()=>{for(let i=0;i<800&&(!window.plv4||!window.plv4.window.app.graph);i++)await new Promise(r=>setTimeout(r,25));if(!window.plv4)throw new Error('V4 failed to load');window.editor=plv4.window;window.app=editor.app;app.graph.clear();window.nodes=[];window.waitUntil=async test=>{for(let i=0;i<400&&!test();i++)await new Promise(r=>setTimeout(r,25));if(!test())throw new Error('State did not settle')};})()`);

    await evaluate(`(async()=>{
      window.client=await import('/extensions/plv4_fixture/plv4/asset_client.js');
      window.write=(action,body)=>client.libraryRequest(action,body,true);
      window.artist=(await write('save_folder',{name:'artist '+Date.now()})).asset;
      window.pool=(await write('save_class',{name:'artists',parent_id:artist.id,data:{autocomplete:true}})).asset;
      window.azure=(await write('save_class',{name:'azurlane',parent_id:pool.id})).asset;
      window.anima=(await write('save_folder',{name:'anima',parent_id:artist.id})).asset;
      window.ill=(await write('save_folder',{name:'illustrious',parent_id:artist.id})).asset;
      await write('save_tag',{parent_id:pool.id,text:'artist_alpha'});await write('save_tag',{parent_id:azure.id,text:'azure_artist'});
      const opened=await fetch('/xyz/plv4/document/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:'{ artist_alpha, { azure_artist, parked } }'})}).then(r=>r.json());
      const snap=opened.state.doc.root.children[0];snap.meta={name:'anima1',pool:pool.id};snap.children[1].meta={name:'Azure child',pool:azure.id};snap.children[1].children[1].enabled=false;
      window.combo=(await write('save_block',{name:'anima1',parent_id:anima.id,snapshot:snap})).asset;
      window.azureCombo=(await write('save_block',{name:'azure1',parent_id:ill.id,snapshot:snap.children[1]})).asset;
      const unbound=structuredClone(snap);delete unbound.meta.pool;
      window.unbound=(await write('save_block',{name:'unbound',parent_id:anima.id,snapshot:unbound})).asset;
      window.node=LiteGraph.createNode('XYZ Prompt Library V4');app.graph.add(node);node.widgets.find(w=>w.name==='text').value='{ existing }';await editor.open(node);
      editor.shell.library.hidden=false;editor.shell.library.style.display='';await editor.library.reload();
    })()`);
    check('Folder keeps the existing folder icon',await evaluate(`document.querySelector('[data-asset-id="'+artist.id+'"] [data-icon-kind="folder"] svg path').getAttribute('d').includes('M3 7V5')`));
    check('Class uses a distinct layered icon',await evaluate(`document.querySelector('[data-asset-id="'+pool.id+'"] [data-icon-kind="class"] svg path').getAttribute('d')!==document.querySelector('[data-asset-id="'+artist.id+'"] [data-icon-kind="folder"] svg path').getAttribute('d')`));
    check('Folder has no pool insertion handle',await evaluate(`!document.querySelector('[data-asset-id="'+artist.id+'"] [data-insert-mode]')`));
    check('Class has an empty bound-block insertion handle',await evaluate(`!!document.querySelector('[data-asset-id="'+pool.id+'"] [data-insert-mode="class"]')`));
    check('Storage Folder does not offer a prompt preview',await evaluate(`!document.querySelector('[data-asset-id="'+artist.id+'"] .library-preview-icon')`));
    const animaName = `editor.library.tree.querySelector('[data-asset-id="'+anima.id+'"] .plv4-library-name')`;
    await click(animaName);
    check('Folder name click folds children without opening a page or tab',await evaluate(`!editor.library.tree.querySelector('[data-asset-id="'+combo.id+'"]')&&editor.context.node===node&&!editor.folderContext&&!editor.tabEntries().some(t=>t.id===anima.id)`));
    await click(animaName);
    check('Folder name click expands children again',await evaluate(`!!editor.library.tree.querySelector('[data-asset-id="'+combo.id+'"]')`));
    await evaluate(`editor.library.query='anima1';editor.library.renderTree()`);
    await click(animaName);
    check('Folder click can fold matching children during search',await evaluate(`!editor.library.tree.querySelector('[data-asset-id="'+combo.id+'"]')`));
    await evaluate(`editor.library.query='';editor.library.renderTree()`);
    check('Search folding leaves the normal browsing fold state intact',await evaluate(`!!editor.library.tree.querySelector('[data-asset-id="'+combo.id+'"]')`));
    await evaluate(`(async()=>{await write('save_tag',{parent_id:pool.id,text:'Zulu artist'});await write('save_tag',{parent_id:pool.id,text:'Beta artist'});await write('save_tag',{parent_id:azure.id,text:'Zulu child'});await write('save_tag',{parent_id:azure.id,text:'Alpha child'});await editor.library.reload();})()`);
    await evaluate(`editor.openFolder(pool.id)`);
    check('Class page edits prompts and Subclasses',await evaluate(`editor.folderContainer.querySelector('.folder-local-tags[data-folder-id="'+pool.id+'"] .folder-tag-row input').value==='artist_alpha'&&!!editor.folderContainer.querySelector('[data-icon-kind="class"]')&&!!editor.folderNameControl.querySelector('input[type="checkbox"]')`));
    check('Class tab reports its actual asset type',await evaluate(`editor.tabEntries().find(t=>t.id===pool.id).title.includes('LIBRARY CLASS')`));
    check('Class page does not own bound Block storage',await evaluate(`!editor.folderContainer.innerText.includes('anima1')`));
    check('Class tags are alphabetical in each layer',await evaluate(`JSON.stringify([...editor.folderContainer.querySelector('[data-folder-id="'+pool.id+'"].folder-local-tags').querySelectorAll('input')].map(n=>n.value))===JSON.stringify(['artist_alpha','Beta artist','Zulu artist'])`));
    check('Subclass tags are independently alphabetical',await evaluate(`JSON.stringify([...editor.folderContainer.querySelector('[data-folder-id="'+azure.id+'"].folder-local-tags').querySelectorAll('input')].map(n=>n.value))===JSON.stringify(['Alpha child','azure_artist','Zulu child'])`));
    await evaluate(`(async()=>{await editor.open(node);const s=editor.context.session;window.owner=s.state.doc.root.children[0].id;await editor.command({type:'SetMetadata',id:owner,patch:{pool:pool.id}});await editor.locate(owner);await editor.details.pendingRender;})()`);
    check('Pool contains a bound Block stored in another Folder',await evaluate(`!!editor.shell.details.querySelector('[data-pool-candidate="'+combo.id+'"]')`));
    check('Pool includes Subclass bound Blocks',await evaluate(`!!editor.shell.details.querySelector('[data-pool-candidate="'+azureCombo.id+'"]')`));
    check('Storage membership alone does not make a Block a candidate',await evaluate(`!editor.shell.details.querySelector('[data-pool-candidate="'+unbound.id+'"]')`));
    check('Pool uses Class icons and keeps Block type badges',await evaluate(`!!editor.shell.details.querySelector('.pool-class-head [data-icon-kind="class"]')&&!!editor.shell.details.querySelector('[data-pool-candidate="'+combo.id+'"] [data-icon-kind="block"]')`));
    check('Settings Pool sorts names without reordering Content',await evaluate(`(()=>{const root=editor.shell.details.querySelector('.pool-candidate-tree > .pool-class > .pool-branch-body');const names=[...root.children].map(n=>n.querySelector('.pool-prompt-text,.pool-branch-name')?.textContent);return JSON.stringify(names)===JSON.stringify(['anima1','artist_alpha','azurlane','Beta artist','existing','Zulu artist'])&&editor.context.session.state.doc.root.children[0].children[0].raw.trim()==='existing'})()`));
    await evaluate(`(async()=>{editor.shell.details.querySelector('[data-pool-candidate="'+combo.id+'"] .pool-add').click();await waitUntil(()=>editor.context.session.text.includes('azure_artist'));await editor.context.session.whenIdle();await editor.details.pendingRender;})()`);
    check('Adding a Block copies its nested Class binding and parked prompt',await evaluate(`(()=>{const n=editor.context.session.state.doc.root.children[0].children.find(n=>n.meta?.source?.id===combo.id);return n.meta.pool===pool.id&&n.children[1].meta.pool===azure.id&&n.children[1].children[1].enabled===false})()`));
    const afterAdd=await evaluate(`editor.context.session.text`);
    await evaluate(`(async()=>{editor.shell.details.querySelector('[data-pool-candidate="'+combo.id+'"] .pool-add').click();await editor.context.session.whenIdle();})()`);
    check('Repeated add does not duplicate or re-enable content',await evaluate(`editor.context.session.text===${JSON.stringify(afterAdd)}`));
    check('Added Block keeps a persistent joined badge',await evaluate(`editor.shell.details.querySelector('[data-pool-candidate="'+combo.id+'"] .pool-usage').textContent==='已添加'`));
    await evaluate(`editor.context.session.undo()`);
    check('Undo removes the inserted copy without changing Library',await evaluate(`!editor.context.session.text.includes('azure_artist')`));
    await evaluate(`(async()=>{await editor.library.openAsset(combo);await editor.details.pendingRender;})()`);
    check('Editing a saved Block excludes itself from its own Pool',await evaluate(`!editor.shell.details.querySelector('[data-pool-candidate="'+combo.id+'"]')&&!!editor.shell.details.querySelector('[data-pool-candidate="'+azureCombo.id+'"]')`));
    await evaluate(`(async()=>{await write('move',{id:combo.id,version:combo.version,parent_id:ill.id});await editor.library.reload();await editor.open(node);await editor.locate(owner);await editor.details.pendingRender;})()`);
    check('Moving a Block changes storage but retains Pool membership',await evaluate(`!!editor.shell.details.querySelector('[data-pool-candidate="'+combo.id+'"]')`));
    await evaluate(`(async()=>{window.completion=await window.xyzPLv4Memberships('artist_alpha');await editor.setView('syntax');await editor.context.session.replaceText('[');const {provideCompletions}=await import('/extensions/plv4_fixture/plv3/complete.js');window.paths=(await provideCompletions(editor.pane.monaco,editor.pane.model(),{lineNumber:1,column:2},{onInsertBlock:true})).suggestions.map(n=>n.label);})()`);
    check('Autocomplete memberships point to Classes',await evaluate(`completion.some(n=>n.folders.some(f=>f.id===pool.id))`));
    check('Source paths include Class and Block, excluding storage Folder',await evaluate(`paths.includes(pool.path)&&!paths.includes(artist.path)`));
    await evaluate(`(async()=>{await editor.context.session.undo();await editor.setView('block');await plv4.loras.open(node);await waitUntil(()=>!!plv4.loras.grid.querySelector('[data-lora-send]'));plv4.loras.grid.querySelector('[data-lora-send]').click();await waitUntil(()=>editor.context.session.text.includes('<lora:'));await editor.context.session.whenIdle();await editor.library.reload();})()`);
    check('LoRA Send creates a fixed Class binding',await evaluate(`(()=>{const n=editor.context.session.state.doc.root.children.find(n=>n.meta?.lora);return !!n&&editor.library.data.assets.find(a=>a.id===n.meta.pool)?.kind==='class'})()`));
    check('LoRA trigger Classes remain hidden from ordinary Library',await evaluate(`!editor.library.tree.querySelector('[data-asset-id="'+editor.context.session.state.doc.root.children.find(n=>n.meta?.lora).meta.pool+'"]')`));
    await evaluate(`(async()=>{window.loraPool=editor.context.session.state.doc.root.children.find(n=>n.meta?.lora).meta.pool;const current=await client.libraryRequest('get',{id:loraPool});await write('move',{id:loraPool,version:current.version,parent_id:artist.id});window.loraChild=(await write('save_class',{name:'Hidden outfit',parent_id:loraPool})).asset;await write('save_tag',{parent_id:loraChild.id,text:'white dress'});await editor.library.reload();})()`);
    check('Moved LoRA Class and its Subclass remain hidden from the Library tree',await evaluate(`!editor.library.tree.querySelector('[data-asset-id="'+loraPool+'"]')&&!editor.library.tree.querySelector('[data-asset-id="'+loraChild.id+'"]')`));
    await evaluate(`editor.openFolder(artist.id)`);
    check('Direct Folder open folds the tree and preserves the active node',await evaluate(`!editor.library.tree.querySelector('[data-asset-id="'+pool.id+'"]')&&editor.context.node===node&&!editor.folderContext`));
    check('LoRA Classes stay out of ordinary Class destination lists',await evaluate(`!editor.library.parentOptions('class').some(a=>a.value===loraPool||a.value===loraChild.id)`));
    check('LoRA Classes stay out of Source Library paths',await evaluate(`(async()=>{const rows=await window.xyzPLv4LibraryPaths({__plv4Session:true});return !rows.some(a=>a.id===loraPool||a.id===loraChild.id)})()`));
    await evaluate(`editor.openFolder(loraPool)`);
    check('LoRA trigger page retains access to its editable hidden Subclass',await evaluate(`!!editor.folderContainer.querySelector('[data-folder-id="'+loraChild.id+'"]')&&editor.folderContainer.innerText.includes('Hidden outfit')`));
    if (process.env.PLV4_SCREENSHOT_DIR) {
      await evaluate(`(async()=>{plv4.loras.hide();await editor.open(node);await editor.locate(owner);await editor.details.pendingRender;editor.library.query=artist.name;editor.library.renderTree();})()`);
      const shot=await rpc('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(process.env.PLV4_SCREENSHOT_DIR,'class-library.png'),Buffer.from(shot.data,'base64'));
    }
    check('No active frontend request to retired V3 Library', !requests.some(url => url.includes('/xyz/plv3/library/')));
    check('No uncaught prompt editor exceptions', !exceptions.some(detail => JSON.stringify(detail).includes('/extensions/plv4_fixture/')));
    console.log('PASS ' + checks + ' Folder / Class / Block checks (real ComfyUI)');
  } finally {
    if (rpc) await rpc('Browser.close').catch(() => {});
    ws?.close(); chrome.kill(); await pause(250);
    // This directory was created by this script and contains only this browser session.
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
