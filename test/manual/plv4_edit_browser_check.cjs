// Disposable real-ComfyUI fixture only; an independent Chrome profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const base = process.env.PLV4_BASE_URL || 'http://127.0.0.1:8191';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const info = await fetch(base + '/object_info').then(r => r.json());
  assert.ok(info['PLv4 Fixture Capture'], 'Only a disposable fixture is allowed');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xyz-native-browser-'));
  const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--window-size=1440,900', base], { windowsHide: true, stdio: 'ignore' });
  let ws, closeBrowser;
  try {
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !fs.existsSync(portFile); i++) await pause(25);
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const pages = await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json());
    ws = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let sequence = 0; const pending = new Map();
    ws.onmessage = event => {
      const response = JSON.parse(event.data), request = pending.get(response.id);
      if (request) { pending.delete(response.id); response.error ? request.reject(response.error) : request.resolve(response.result); }
    };
    const rpc = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: value => { clearTimeout(timer); reject(value); } });
      ws.send(JSON.stringify({ id, method, params }));
    });
    closeBrowser = () => rpc('Browser.close');
    const evaluate = async expression => {
      const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    await rpc('Page.bringToFront');
    await pause(12000); // Wait through ComfyUI's initial workflow restoration.
    await evaluate(`(async()=>{for(let i=0;i<200&&!window.plv4;i++)await new Promise(r=>setTimeout(r,25));if(!window.plv4)throw new Error('PLv4 not loaded');window.editor=plv4.window;window.app=editor.app;const node=LiteGraph.createNode('XYZ Prompt Library V4');app.graph.add(node);node.widgets.find(w=>w.name==='text').value='{ alpha }';await editor.open(node);window.trace=[];editor.blocks.addEventListener('focusout',e=>trace.push(e.target.className));})()`);
    const rect = await evaluate(`(()=>{const r=editor.blocks.querySelector('[data-run-input]').getBoundingClientRect();return{x:r.x+10,y:r.y+r.height/2}})()`);
    await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
    await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
    await rpc('Input.insertText', { text: 'x' }); await pause(400);
    const result = await evaluate(`({text:editor.context.session.text,active:document.activeElement.className,inline:!!editor.blockView.inline,trace})`);
    console.log(JSON.stringify(result));
    assert.ok(result.inline && result.active.includes('plv4-run'), 'Typing must retain the native input focus');
    console.log('PASS real ComfyUI native focus');
    for (const kind of ['bound', 'saved', 'monaco']) {
      await evaluate(`(async()=>{await editor.hide();const client=await import('/extensions/plv4_fixture/plv4/asset_client.js');const node=LiteGraph.createNode(${JSON.stringify(kind === 'monaco' ? 'XYZ Prompt Library V4 Monaco' : 'XYZ Prompt Library V4')});app.graph.add(node);node.widgets.find(w=>w.name==='text').value='{ alpha, beta }';await editor.open(node);const s=editor.context.session,id=s.state.doc.root.children[0].id;
        if(${JSON.stringify(kind)}==='bound'){const f=await client.libraryRequest('save_class',{name:'Focus '+Date.now()},true);await editor.command({type:'SetMetadata',id,patch:{pool:f.id}});}
        if(${JSON.stringify(kind)}==='saved'){const result=await editor.command({type:'SaveLibrary',id,name:'Saved '+Date.now()});await editor.library.reload();const asset=editor.library.data.assets.find(a=>a.id===result.id);await editor.openLibrary(await editor.library.assetContext(asset));}
      })()`);
      const rect = await evaluate(`(()=>{const r=editor.blocks.querySelector('[data-run-input]').getBoundingClientRect();return{x:r.x+10,y:r.y+r.height/2}})()`);
      await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1 });
      await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1 });
      await rpc('Input.insertText', { text: 'x' }); await pause(400);
      const result = await evaluate(`({text:editor.context.session.text,active:document.activeElement.className,inline:!!editor.blockView.inline,trace})`);
      console.log(kind, JSON.stringify(result));
      assert.ok(result.inline && result.active.includes('plv4-run'), kind + ' typing keeps focus');
      await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
      await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
      await pause(150);
      assert.ok(await evaluate(`document.activeElement.className.includes('plv4-run')&&!!editor.blockView.inline`), kind + ' Delete keeps focus');
      if (kind === 'bound') {
        const status = await evaluate(`(async()=>{editor.blockView.inline.element.blur();await editor.flushEditor();await editor.locate(editor.context.session.state.doc.root.children[0].id);await editor.details.pendingRender;const field=editor.shell.details.querySelector('input[title="Prompt"]');editor.details.render(editor.context.session,{keepOwner:true});field.focus();field.value+='draft';await editor.details.pendingRender;return{connected:field.isConnected,focused:document.activeElement===field};})()`);
        console.log('Settings refresh', status);
        assert.ok(status.connected && status.focused, 'Library refresh must retain a focused Settings prompt draft');
      }
    }
    const reset = async () => evaluate(`(async()=>{editor.blockView.inline?.element.blur();await editor.flushEditor();await editor.command({type:'ReplaceText',text:'{ alpha, { neighbor } }'});})()`);
    const selectInput = async () => evaluate(`(async()=>{const field=editor.blocks.querySelector('[data-run-input]');field.focus();await editor.blockView.inline.ready;const range=document.createRange();range.selectNodeContents(field);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);window.field=field;})()`);
    const type = async text => { await rpc('Input.insertText', { text }); await pause(200); await evaluate('editor.blockView.flush()'); };
    const finish = async () => { await evaluate(`(async()=>{editor.blockView.inline?.element.blur();await editor.flushEditor();for(let i=0;i<100&&editor.blockView.inline&&editor.context.session.valid;i++)await new Promise(r=>setTimeout(r,10));})()`); };

    await reset(); await selectInput(); await type('{}, [@region]:{}');
    assert.ok(await evaluate('document.activeElement===field && field.isConnected'), 'Source typing keeps the native field');
    await finish();
    assert.ok(await evaluate(`(()=>{const children=editor.context.session.state.doc.root.children[0].children;return children[0].form==='brace'&&children[1].form==='region'&&children[1].children.length===0&&children[2].children[0].raw==='neighbor'})()`), 'Blur converts empty braces and Region into structure, preserving the neighbouring block');
    console.log('PASS Source structure on blur');
    await reset(); await selectInput(); await type('{'); await finish();
    assert.ok(await evaluate('!editor.context.session.valid && field.isConnected && editor.blockView.inline.element===field'), 'Invalid Source remains editable at its original location');
    await evaluate(`field.focus();const range=document.createRange();range.selectNodeContents(field);getSelection().removeAllRanges();getSelection().addRange(range);`);
    await type('{}'); await finish();
    assert.ok(await evaluate('editor.context.session.valid && editor.context.session.state.doc.root.children[0].children.length===2'), 'Completing a draft converts it without losing neighbours');
    console.log('PASS unfinished Source recovery');

    await reset(); await selectInput(); await type('[@sch'); await pause(120);
    assert.ok(await evaluate(`document.querySelector('#xyz-tagac-root').innerText.includes('@schedule')`), 'Native Source syntax popup appears');
    await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await pause(200); await finish();
    assert.ok(await evaluate(`editor.context.session.state.doc.root.children[0].children[0].form==='schedule'&&editor.context.session.state.doc.root.children[0].children[0].children.length===2`), 'Enter chooses a two-entry Schedule skeleton');
    console.log('PASS native Schedule completion');

    await evaluate(`(async()=>{const client=await import('/extensions/plv4_fixture/plv4/asset_client.js');const root=await client.libraryRequest('save_class',{name:'Catalog '+Date.now(),data:{autocomplete:true}},true);window.catalog=root.id;window.uniquePrompt='library unique '+Date.now();await client.libraryRequest('save_tag',{parent_id:root.id,text:'blue eyes'},true);await client.libraryRequest('save_tag',{parent_id:root.id,text:uniquePrompt},true);window.catalogAsset=(await client.libraryRequest('tree')).assets.find(asset=>asset.id===root.id);})()`);
    await reset(); await selectInput(); await type('[' + await evaluate('catalogAsset.path'));
    await evaluate(`(async()=>{const list=await field._xyzSourceSuggestions();const choice=list.find(item=>item.asset?.id===catalog);if(!choice)throw new Error('Folder reference absent');await choice.insert();})()`);
    assert.ok(await evaluate(`editor.context.session.valid&&editor.context.session.state.doc.root.children[0].children.some(item=>item.meta?.pool===catalog)&&document.activeElement.isContentEditable`), 'Native Library reference expands with binding and keeps typing focus');
    console.log('PASS native Library expansion');

    await reset(); await selectInput(); await evaluate('xyzAcSettings.showTagPreview=true'); await type('blue eyes'); await pause(120);
    // Dataset and Library results are asynchronous; wait for their merged row.
    await evaluate(`(async()=>{for(let i=0;i<80&&!document.querySelector('#xyz-tagac-root [data-tagac-index]')?.innerText.includes('L');i++)await new Promise(r=>setTimeout(r,25));})()`);
    const merged = await evaluate(`(()=>{const row=document.querySelector('#xyz-tagac-root [data-tagac-index]');return row.innerText})()`);
    for (const value of ['fixture alias', 'D', 'G', 'L', '🖼']) assert.ok(merged.includes(value), 'Merged tag retains ' + value);
    await evaluate(`(()=>{document.querySelector('#xyz-tagac-root [data-tagac-index]').querySelectorAll('span').forEach(span=>{if(span.textContent==='L')span.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));});})()`);
    await pause(200);
    if (!await evaluate('editor.folderContext===catalog')) {
      await evaluate(`(()=>{const row=[...document.querySelectorAll('#xyz-tagac-root [data-tagac-index]')].find(row=>row.innerText.includes(catalogAsset.path));if(!row)throw new Error('Folder chooser missing');row.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true}));})()`);
      await pause(200);
    }
    assert.ok(await evaluate('editor.folderContext===catalog'), 'L opens the belonging Folder tab');
    await evaluate('editor.open(editor.seedNode)');
    await reset(); await selectInput(); await type(await evaluate('uniquePrompt')); await pause(120);
    const only = await evaluate(`(()=>{const row=document.querySelector('#xyz-tagac-root [data-tagac-index]');return{text:row.innerText,badges:[...row.querySelectorAll('span')].map(span=>span.textContent)}})()`);
    assert.ok(only.text.includes(await evaluate('catalogAsset.path')) && only.badges.includes('L'));
    assert.ok(!only.badges.some(value=>['D','G','🖼'].includes(value)), 'Library-only has path and L without synthetic D/G data');
    console.log('PASS D/G/Library merging and Folder navigation');

    await finish();
    await evaluate(`editor.blocks.querySelector('[data-detail]').click()`); await pause(200);
    assert.ok(await evaluate(`document.activeElement.isContentEditable&&editor.context.session.state.selection.block_id===editor.context.session.state.doc.root.children[0].id`), 'Whole-block selection retains its selection and gives IME a native text host');
    await evaluate(`window.shiftPrevented=null;document.activeElement.addEventListener('keydown',event=>{if(event.key==='Shift')shiftPrevented=event.defaultPrevented},{once:true})`);
    await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16, modifiers: 8 });
    await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
    // Window capture deliberately stops delivery to page shortcuts, leaving the
    // native default untouched. Verify with a synthetic event at the same seam.
    assert.ok(await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Shift',bubbles:true,cancelable:true}))`), 'Shift default remains available to the IME');
    console.log('PASS whole-block IME focus and Shift default');

    await evaluate(`Object.assign(xyzAcSettings,{enabled:false,libraryCompletion:false,sourceCompletion:false,loraCompletion:true})`);
    await reset(); await selectInput(); await type('<lora:Native'); await pause(150);
    assert.ok(await evaluate(`document.querySelector('#xyz-tagac-root').innerText.includes('characters/Native Demo.safetensors')`));
    await rpc('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await rpc('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await pause(200); await finish();
    assert.ok(await evaluate(`editor.context.session.text.includes('<lora:characters/Native Demo.safetensors:1>')`));
    await evaluate(`xyzAcSettings.loraCompletion=false`);
    await reset(); await selectInput(); await type('<lora:Native'); await pause(150);
    assert.ok(await evaluate(`document.querySelector('#xyz-tagac-root').style.display==='none'`));
    await type(' Demo.safetensors:1>'); await finish();
    await evaluate(`Object.assign(xyzAcSettings,{enabled:true,libraryCompletion:true,sourceCompletion:true,loraCompletion:true})`);
    console.log('PASS LoRA syntax completion with other sources disabled');

    await evaluate(`(async()=>{window.settingsPage=(await import('/extensions/plv4_fixture/xyz_settings.js')).page;settingsPage.show();window.loraBrowser=plv4.loras;await loraBrowser.open(editor.seedNode);})()`);
    for (const target of ['settingsPage.root','editor.shell.win.el','loraBrowser.win.el','settingsPage.root']) {
      await evaluate(`${target}.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
      assert.ok(await evaluate(`(()=>{const target=${target};return[settingsPage.root,editor.shell.win.el,loraBrowser.win.el].every(other=>other===target||Number(target.style.zIndex)>Number(other.style.zIndex))})()`),target+' comes to front');
    }
    assert.ok(await evaluate(`['LoRA syntax','Source syntax','Danbooru / Gelbooru dataset','Library prompts'].every(label=>settingsPage.root.innerText.includes(label))`));
    console.log('PASS three-window activation order and four Settings switches');
  } finally { if(closeBrowser)await closeBrowser().catch(()=>{}); ws?.close(); chrome.kill(); await pause(250); fs.rmSync(profile,{recursive:true,force:true}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
