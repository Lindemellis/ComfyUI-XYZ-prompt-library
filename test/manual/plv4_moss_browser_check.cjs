// Real classic-canvas check, restricted to a disposable PLV4 fixture.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawn } = require('node:child_process');
const base = process.env.PLV4_BASE_URL;
if (!base) throw new Error('PLV4_BASE_URL must identify a disposable fixture');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const literal = '春日, 花店.\n"iPhone"';
(async () => {
  const info = await fetch(base + '/object_info').then(r => r.json());
  assert.ok(info['PLv4 Fixture Capture'] && info['XYZ PLV4 MOSS Upsample']);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xyz-moss-browser-'));
  const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--window-size=1600,1000', base], { windowsHide: true, stdio: 'ignore' });
  let ws, rpc, checks = 0;
  try {
    for (let i = 0; i < 240 && !fs.existsSync(path.join(profile, 'DevToolsActivePort')); i++) await pause(25);
    const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
    const pages = await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json());
    ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let seq = 0; const pending = new Map();
    ws.onmessage = event => { const value = JSON.parse(event.data), p = pending.get(value.id); if (p) { pending.delete(value.id); value.error ? p.reject(value.error) : p.resolve(value.result); } };
    rpc = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 20000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const wait = async expression => { for (let i = 0; i < 600; i++) { if (await evaluate(expression)) return; await pause(50); } throw new Error('Not ready: ' + expression); };
    const idle = () => evaluate('(async()=>{await editor.flushEditor();await editor.context.session.whenIdle();await new Promise(requestAnimationFrame)})()');
    const click = async expression => {
      const point = await evaluate(`(async()=>{const el=(${expression});if(!el)throw new Error('Missing target');el.scrollIntoView({block:'nearest'});await new Promise(requestAnimationFrame);const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      await pause(80);
    };
    const key = async (key, code) => { await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key, code }); await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key, code }); };
    const check = async (label, expression) => {
      const ok=await evaluate(expression);
      if(!ok) console.log(await evaluate(`(async()=>JSON.stringify({output:window.editor?.output.textContent,status:window.editor?.status.textContent,inputs:window.node?.inputs,resolved:await editor.inputs(),apiInputs:(await editor.app.graphToPrompt()).output[String(node.id)]?.inputs,seedNodeIsNode:editor.seedNode===node,hostMode:editor.sessions.contexts.get(editor.seedNode)?.session.state.doc.root.meta?.output_mode,primitiveWidgets:[window.widthPrimitive,window.heightPrimitive].map(n=>n?.widgets?.map(w=>({name:w.name,value:w.value}))),errors:window.errors}))()`));
      assert.ok(ok,label);checks++;
    };
    await wait('!!window.plv4 && !!window.LiteGraph');
    // Let ComfyUI finish restoring the initial (disposable) graph before adding nodes.
    await pause(12000);
    await evaluate(`(async()=>{
      window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));
      window.editor=plv4.window;
      await editor.app.extensionManager.setting.set('Comfy.VueNodes.Enabled',false);
      editor.app.graph.clear();
      window.upsampler=LiteGraph.createNode('XYZ PLV4 MOSS Upsample');editor.app.graph.add(upsampler);
    })()`);
    await check('Upsampler exposes native generation controls in Nodes 1.0', `['sampling_mode','temperature','top_k','top_p','min_p','repetition_penalty','presence_penalty','seed','max_length','thinking','use_default_template','mtp','system_prompt','prompt'].every(name=>upsampler.widgets.some(w=>w.name===name))`);
    await check('Upsampler retains output positions and appends thinking', `upsampler.outputs.map(o=>o.name).join(',')==='prompt,plain,metadata,thinking'`);
    await check('Upsampler metadata is optional', `!${JSON.stringify(info['XYZ PLV4 MOSS Upsample'].input.required)}.metadata&&!!upsampler.inputs.find(i=>i.name==='metadata')`);
    const sampleLayout = JSON.stringify({summary:{caption:'a shop.'},items:[{label:'text',caption:'a sign.',text:'MOSS',bbox:[-64,-64,64,64]}]});
    await evaluate(`upsampler.widgets.find(w=>w.name==='prompt').value=${JSON.stringify(sampleLayout)}`);
    await check('Layout braces survive frontend graph serialization', `(async()=>{const graph=await editor.app.graphToPrompt();return graph.output[String(upsampler.id)].inputs.prompt===${JSON.stringify(sampleLayout)}})()`);
    await evaluate(`(async()=>{
      window.node=LiteGraph.createNode('XYZ Prompt Library V4');editor.app.graph.add(node);await editor.open(node);
      await editor.command({type:'ReplaceText',text:'an illustration. [@region]: { [mask: [0, 0.5, 0, 1]]: { a woman. } [mask: [0.5, 1, 0, 1]]: { a cat. } } [@avg]: { 1: { red }, 1: { blue } }'});
      window.originalEnabled=JSON.stringify([...function* walk(n){yield [n.id,n.enabled];for(const c of n.children||[])yield*walk(c)}(editor.context.session.state.doc.root)]);
      editor.context.generalSettings=true;editor.details.render(editor.context.session);
    })()`);
    await click(`editor.details.container.querySelector('[aria-label="Output mode"]')`);
    await key('ArrowDown', 'ArrowDown'); await key('Enter', 'Enter'); await idle();
    await check('Mode persisted by native select', `editor.context.session.state.doc.root.meta.output_mode==='moss'`);
    await check('Classic renderer', `editor.app.extensionManager.setting.get('Comfy.VueNodes.Enabled')===false`);
    await check('Optional dimension sockets appended', `node.inputs.some(i=>i.name==='width')&&node.inputs.some(i=>i.name==='height')&&node.widgets.slice(0,2).map(w=>w.name).join(',')==='text,seed'`);
    await evaluate(`(()=>{const saved=node.serialize();saved.inputs=saved.inputs.filter(i=>!['width','height'].includes(i.name));window.legacy=LiteGraph.createNode('XYZ Prompt Library V4');legacy.configure(saved)})()`);
    await check('Old workflow gains optional sockets after configure', `legacy.inputs.some(i=>i.name==='width')&&legacy.inputs.some(i=>i.name==='height')&&legacy.widgets[0].name==='text'`);
    await check('AVG is visibly unavailable', `!!editor.blocks.querySelector('.moss-unavailable')`);
    await check('No destructive enabled changes', `JSON.stringify([...function* walk(n){yield [n.id,n.enabled];for(const c of n.children||[])yield*walk(c)}(editor.context.session.state.doc.root)])===originalEnabled`);
    await evaluate(`(async()=>{await editor.setView('preview');await editor.preview()})()`);
    await check('Preview remains available without dimensions', `editor.output.textContent.includes('an illustration.')&&editor.output.textContent.includes('a woman.')&&editor.output.textContent.includes('normalized')&&!editor.output.querySelector('.plv4-error')`);
    await check('Provisional coordinate notice is visible', `editor.output.textContent.includes('比例坐标')&&editor.status.textContent.includes('坐标待换算')`);
    await evaluate(`(async()=>{
      window.resolution=LiteGraph.createNode('PLv4 Fixture Resolution');editor.app.graph.add(resolution);
      resolution.connect(0,node,node.inputs.findIndex(i=>i.name==='width'));
      resolution.connect(1,node,node.inputs.findIndex(i=>i.name==='height'));
      await editor.preview();
    })()`);
    await check('Connected backend dimensions do not block Preview', `editor.output.textContent.includes('an illustration.')&&editor.output.textContent.includes('normalized')&&!editor.output.querySelector('.plv4-error')`);
    await evaluate(`(async()=>{
      // Known numeric input values exercise the display branch; actual backend
      // links above intentionally stay unresolved in the frontend.
      window.readInputs=editor.sessions.inputs.bind(editor.sessions);
      editor.sessions.inputs=async()=>({seed:42,region_mode:'couple',width:1024,height:768});
      try{await editor.preview()}finally{editor.sessions.inputs=readInputs}
    })()`);
    await check('Resolved dimensions preview final pixel coordinates', `editor.output.textContent.includes('abs_centralized')&&editor.output.textContent.includes('[-384,-512,384,0]')&&!editor.status.textContent.includes('坐标待换算')`);
    await evaluate(`(async()=>{await editor.setView('block');editor.context.generalSettings=false;window.region=editor.context.session.projection.tree.children.find(r=>r.form==='region');window.first=region.children[0];await editor.locate(first.id)})()`);
    await click(`editor.details.container.querySelector('[aria-label="MOSS element type"]')`);
    await key('End', 'End'); await key('Enter', 'Enter'); await idle();
    await wait(`!!editor.details.container.querySelector('[aria-label="MOSS visible text"]')`);
    await check('Type refreshes literal field', `editor.context.session.state.doc.root.children[1].children[0].meta.moss.type==='text'`);
    await click(`[...editor.details.container.querySelectorAll('.plv4-field')].find(el=>el.firstElementChild?.textContent==='Upsample caption').querySelector('input')`); await idle();
    await check('Caption upsample toggle preserves type', `editor.context.session.state.doc.root.children[1].children[0].meta.moss.upsample===true&&!!editor.details.container.querySelector('[aria-label="MOSS visible text"]')`);
    await click(`editor.details.container.querySelector('[aria-label="MOSS visible text"]')`);
    await rpc('Input.insertText', { text: literal });
    await click(`editor.blocks.querySelector('[data-block-menu]')`); await idle();
    await check('Native literal field preserves punctuation and newlines', `editor.context.session.state.doc.root.children[1].children[0].meta.moss.text===${JSON.stringify(literal)}`);
    await evaluate(`document.querySelector('.plv4-popover')?.remove()`);
    await check('Schedule / AVG creation entries hidden', `!JSON.stringify(editor.blockView.menuItems(editor.context.session.projection.tree.children[1])).includes('Schedule 容器')&&!JSON.stringify(editor.blockView.menuItems(editor.context.session.projection.tree.children[1])).includes('AVG 容器')`);
    await evaluate(`(async()=>{window.compiled=await editor.context.session.compile({seed:42,region_mode:'couple',width:1024,height:768});window.layout=JSON.parse(compiled.prompt)})()`);
    await check('Layout exact coordinates', `JSON.stringify(layout.items[0].bbox)==='[-384,-512,384,0]'`);
    await check('Region caption is isolated', `layout.items[0].caption==='a woman.'&&layout.summary.caption==='an illustration.'`);
    await check('Literal text in JSON', `layout.items[0].text===${JSON.stringify(literal)}`);
    await evaluate(`(async()=>{editor.context.generalSettings=true;editor.details.render(editor.context.session)})()`);
    await click(`editor.details.container.querySelector('[aria-label="Output mode"]')`);
    await key('Home', 'Home'); await key('Enter', 'Enter'); await idle();
    await check('Switch back restores AVG', `!editor.blocks.querySelector('.moss-unavailable')`);
    await evaluate(`(async()=>{await editor.command({type:'SetMetadata',id:editor.context.session.projection.tree.id,patch:{output_mode:'moss',sentence_case:true}});await editor.command({type:'ReplaceText',text:'a cat, blue eyes. she smiles.'});window.simple=await editor.context.session.compile({seed:42,region_mode:'couple',width:1024,height:768})})()`);
    await check('Simple output with sentence casing', `simple.prompt==='A cat, blue eyes. She smiles.'`);
    await evaluate(`(async()=>{await editor.hide();await editor.open(node)})()`);
    await check('Reopen retains output settings', `editor.context.session.state.doc.root.meta.output_mode==='moss'&&editor.context.session.state.doc.root.meta.sentence_case===true`);
    await evaluate(`(async()=>{await editor.context.session.loadDocument({text:'loaded. [@avg]: { 1: { red }, 1: { blue } }'})})()`);
    await check('Document loading preserves mode and capability projection', `editor.context.session.state.doc.root.meta.output_mode==='moss'&&!!editor.blocks.querySelector('.moss-unavailable')`);
    await evaluate(`(async()=>{await editor.undo();editor.context.generalSettings=true;editor.details.render(editor.context.session)})()`);
    await check('No browser errors', 'errors.length===0');
    await evaluate(`(async()=>{
      await editor.hide();
      window.maskClient=await import('/extensions/plv4_fixture/plv4/mask_library.js');
      const {MaskEditor}=await import('/extensions/plv4_fixture/plv4/mask_editor.js');
      window.overlap=(await maskClient.maskRequest('mutate',{action:'save',canvas:{kind:'rectangle',name:'Selected overlap '+Date.now(),masks:[
        {id:'front',name:'Front',coordinates:[0.1,0.9,0.1,0.9],color:'#ff0000'},
        {id:'back',name:'Back',coordinates:[0.25,0.65,0.25,0.65],color:'#0000ff'}]}})).result;
      window.drawing=new MaskEditor({canvas:maskClient.cleanCanvas(overlap),id:overlap.id,version:overlap.version,request:maskClient.maskRequest}).open();
      window.beforeSelection=JSON.stringify(drawing.canvas);window.selectionVersion=drawing.version;
    })()`);
    await check('Unselected overlap initially follows saved order', `drawing.board.getContext('2d').getImageData(200,200,1,1).data[0]===255`);
    await click(`drawing.list.querySelectorAll('.mask-rect-row img')[1]`);
    await check('Selecting a covered mask paints it on top', `drawing.selected==='back'&&drawing.board.getContext('2d').getImageData(200,200,1,1).data[2]===255`);
    await check('Selection does not change saved data or version', `JSON.stringify(drawing.canvas)===beforeSelection&&drawing.version===selectionVersion`);
    const boardPoint = (x,y) => evaluate(`(()=>{const r=drawing.board.getBoundingClientRect();return{x:r.x+r.width*${x},y:r.y+r.height*${y}}})()`);
    const dragMask = async (a,b) => {
      await rpc('Input.dispatchMouseEvent',{type:'mousePressed',...a,button:'left',clickCount:1});
      await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',...b,buttons:1,button:'left'});
      await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',...b,button:'left',clickCount:1});
      await wait('!drawing.pending');
    };
    await dragMask(await boardPoint(.45,.45), await boardPoint(.55,.50));
    await check('Drag inside overlap moves the selected mask', `drawing.selected==='back'&&Math.abs(drawing.canvas.masks[1].coordinates[0]-.35)<.005&&Math.abs(drawing.canvas.masks[1].coordinates[2]-.30)<.005&&JSON.stringify(drawing.canvas.masks[0].coordinates)==='[0.1,0.9,0.1,0.9]'`);
    await check('Dragging preserves output order and writes one revision', `drawing.canvas.masks.map(m=>m.id).join(',')==='front,back'&&drawing.version===selectionVersion+1`);
    await evaluate(`(async()=>{const stored=(await maskClient.maskRequest('tree')).canvases.find(c=>c.id===overlap.id);window.persistedOrder=stored.masks.map(m=>m.id).join(',')})()`);
    await check('Persisted mask order remains unchanged', `persistedOrder==='front,back'`);
    await dragMask(await boardPoint(.75,.70), await boardPoint(.80,.75));
    await check('Selected resize handles work over the covering mask', `Math.abs(drawing.canvas.masks[1].coordinates[1]-.80)<.005&&Math.abs(drawing.canvas.masks[1].coordinates[3]-.75)<.005&&drawing.canvas.masks.map(m=>m.id).join(',')==='front,back'`);
    await check('No mask editor browser errors', 'errors.length===0');
    const screenshot = await rpc('Page.captureScreenshot', { format: 'png' });
    const destination = process.env.MOSS_SCREENSHOT || path.join(profile, 'moss.png');
    fs.writeFileSync(destination, Buffer.from(screenshot.data, 'base64'));
    console.log(JSON.stringify({ checks, screenshot: destination, profile }));
  } finally { if (rpc) await rpc('Browser.close').catch(() => {}); ws?.close(); chrome.kill(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
