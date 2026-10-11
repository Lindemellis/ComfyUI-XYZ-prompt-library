// Typography and focus layout regression against the disposable PLv4 fixture only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const base = process.env.LORA_TEST_URL || process.env.PLV4_BASE_URL;
if (!base) throw new Error('Set LORA_TEST_URL or PLV4_BASE_URL to a disposable fixture');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xyz-separator-browser-'));
  const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--user-data-dir=' + profile, '--window-size=1440,900', base], { windowsHide: true, stdio: 'ignore' });
  let ws, rpc;
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
    rpc = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: value => { clearTimeout(timer); reject(value); } });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expression => {
      const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    await rpc('Page.bringToFront');
    await pause(2500);
    const realComfy = !!process.env.PLV4_BASE_URL;
    const modules = realComfy ? '/extensions/plv4_fixture/plv4/' : '/js/plv4/';
    if (realComfy) {
      const info = await fetch(base + '/object_info').then(r => r.json());
      assert.ok(info['PLv4 Fixture Capture'], 'Disposable real ComfyUI only');
      await pause(12000);
      await evaluate(`(async()=>{for(let i=0;i<400&&!window.plv4;i++)await new Promise(r=>setTimeout(r,25));if(!window.plv4)throw new Error('fixture not ready');window.editor=plv4.window;const node=LiteGraph.createNode('XYZ Prompt Library V4');editor.app.graph.add(node);await editor.open(node);})()`);
    } else {
      await evaluate(`(async()=>{for(let i=0;i<400&&!window.ready;i++)await new Promise(r=>setTimeout(r,25));if(!window.ready)throw new Error('fixture not ready');if(document.title!=='PLv4 LoRA isolated check')throw new Error('Disposable fixture only');await editor.open(fixture.graph._nodes[0]);})()`);
    }
    const reset = async source => {
      await evaluate(`(async()=>{editor.blockView.inline?.element.blur();await editor.flushEditor();await editor.command({type:'ReplaceText',text:${JSON.stringify(source)}});const field=editor.blocks.querySelector('[data-run-input],[data-empty]');field.focus();await editor.blockView.inline.ready;const {inlinePoint,inlineText}=await import('${modules}text_input.js');const r=document.createRange();r.setStart(...inlinePoint(field,inlineText(field).length));r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);window.field=field;})()`);
    };
    let checks=0;
    const measure=()=>evaluate(`(()=>{
      const field=editor.blocks.querySelector('[data-run-input],[data-empty]');
      const style=getComputedStyle(field),origin=field.closest('[data-block-id]')?.getBoundingClientRect()||field.getBoundingClientRect();
      const walker=document.createTreeWalker(field,NodeFilter.SHOW_TEXT),glyphs=[];
      let node;while(node=walker.nextNode()){
        if(node.parentElement.closest('[data-editor-decoration],[data-parked]'))continue;
        const s=getComputedStyle(node.parentElement);
        for(let i=0;i<node.data.length;i++){
          if(/\\s/.test(node.data[i]))continue;
          const r=document.createRange();r.setStart(node,i);r.setEnd(node,i+1);const box=r.getBoundingClientRect();
          glyphs.push({char:node.data[i],x:box.x-origin.x,y:box.y-origin.y,width:box.width,height:box.height,font:s.font,color:s.color,spacing:s.letterSpacing});
        }
      }
      return {font:style.font,color:style.color,padding:style.padding,spacing:style.letterSpacing,glyphs};
    })()`);
    const blur=()=>evaluate(`(async()=>{const field=editor.blocks.querySelector('[data-run-input],[data-empty]');field.blur();await editor.blockView.finishInline(field);await editor.flushEditor();})()`);
    const focus=()=>evaluate(`(async()=>{editor.blocks.querySelector('[data-run-input],[data-empty]').focus();await editor.blockView.inline.ready;})()`);
    const equal=(before,after,name)=>{
      assert.deepEqual({...after,glyphs:undefined},{...before,glyphs:undefined},name+' typography');
      assert.equal(after.glyphs.length,before.glyphs.length,name+' glyph count');
      for(let i=0;i<before.glyphs.length;i++){
        const a=after.glyphs[i],b=before.glyphs[i];
        assert.deepEqual({...a,x:undefined,y:undefined,width:undefined,height:undefined},{...b,x:undefined,y:undefined,width:undefined,height:undefined},name+' glyph style');
        for(const key of ['x','y','width','height'])assert.ok(Math.abs(a[key]-b[key])<0.1,name+' '+key+' '+JSON.stringify({before:b,after:a}));
      }
      checks++;
    };
    for(const source of ['','{ }','[@schedule]: { 0 - 1: { } }','[@region]: { [base]: { } }','[@avg]: { 1: { } }']){
      await reset(source);await rpc('Input.insertText',{text:'1girl, 2girls'});await evaluate('editor.flushEditor(false)');
      const initial=await measure();await blur();equal(initial,await measure(),'First typed text retains typography and positions after blur: '+source);
      await focus();equal(initial,await measure(),'First typed text retains typography and positions on refocus: '+source);
    }
    for(const source of ['{ 1girl, 2girls, yuri }','{ 1girl,\n2girls, yuri, }','[@schedule]: { 0 - 1: { 1girl, 2girls } }','[@region]: { [base]: { 1girl, 2girls } }','[@avg]: { 1: { 1girl, 2girls } }']){
      await reset(source);await blur();const initial=await measure();
      for(let i=0;i<3;i++){await focus();equal(initial,await measure(),'Focus retains text geometry: '+source);await blur();equal(initial,await measure(),'Blur retains text geometry: '+source);}
    }
    console.log('PASS '+checks+' input typography / focus geometry checks ('+(realComfy?'real ComfyUI':'isolated PLv4')+')');
  } finally {
    if (rpc) await rpc('Browser.close').catch(() => {});
    ws?.close(); chrome.kill();
    await pause(250);
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
