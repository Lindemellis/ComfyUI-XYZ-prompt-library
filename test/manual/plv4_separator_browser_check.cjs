// Native keyboard regression against the disposable PLv4 fixture only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
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
    const read = () => evaluate(`(async()=>{await editor.flushEditor(false);const {inlineText,inlineOffset}=await import('${modules}text_input.js');const s=getSelection(),r=s.rangeCount?s.getRangeAt(0):null,c=r?.getBoundingClientRect();return {text:editor.context.session.text,value:inlineText(field),html:field.innerHTML,connected:field.isConnected,focused:document.activeElement===field,caret:r?{offset:inlineOffset(field,r.startContainer,r.startOffset),x:c.x,y:c.y,height:c.height,node:r.startContainer.nodeName,parent:r.startContainer.parentElement?.className}:null,lineHeight:parseFloat(getComputedStyle(field).lineHeight),errors:window.errors};})()`);
    let checks = 0;
    const check = (name, value) => { assert.ok(value, name); checks++; };
    const visibleCaret = async () => {
      const clip = await evaluate(`(()=>{const r=field.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height+25,scale:1};})()`);
      const screenshot = await rpc('Page.captureScreenshot', {format:'png',clip});
      // Inspect the actual painted caret, including blank lines where a DOM
      // collapsed Range has no rectangle. Pillow only reads the screenshot.
      const scan = spawnSync(process.env.PLV4_TEST_PYTHON || 'python', ['-c',
        "import base64,io,json,sys\nfrom PIL import Image\nim=Image.open(io.BytesIO(base64.b64decode(sys.stdin.read()))).convert('RGB')\npoints=[(i%im.width,i//im.width) for i,(r,g,b) in enumerate(im.getdata()) if r>220 and g<40 and b<40]\nprint(json.dumps([min(p[0] for p in points),min(p[1] for p in points)] if points else None))"], {input:screenshot.data,encoding:'utf8'});
      assert.equal(scan.status,0,scan.stderr);const point=JSON.parse(scan.stdout);
      assert.ok(point,'The screenshot must contain the visible red caret: '+JSON.stringify(await read()));return point;
    };
    const reopen = () => evaluate(`(async()=>{field.blur();await editor.blockView.finishInline(field);const next=editor.blocks.querySelector('[data-run-input],[data-empty]');next.focus();await editor.blockView.inline.ready;const {inlinePoint,inlineText}=await import('${modules}text_input.js');const r=document.createRange();r.setStart(...inlinePoint(next,inlineText(next).length));r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);window.field=next;})()`);
    for (const source of process.env.PLV4_REPRO_ONLY ? [] : ['alpha', '{ alpha}', '{\n  alpha\n}', '{ }', '[@schedule]: { 0 - 1: { alpha } }', '[@region]: { [base]: { alpha } }', '[@avg]: { 1: { alpha } }']) {
      for (const suffix of [',', '，', '\n', '\n\n']) {
        await reset(source);
        const before = (await read()).value;
        if (suffix.includes('\n')) {
          for (const newline of suffix) {
            await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
            await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
          }
        } else await rpc('Input.insertText', { text: suffix });
        await pause(150);
        const expected = before + suffix.replace('，', ',');
        let result = await read();
        check('typing retains punctuation and focus: ' + JSON.stringify({source,suffix,result}), result.connected && result.focused && result.value === before + suffix && result.text.includes(expected));
        // Non-empty parsed runs must keep unfinished separators on redraw too.
        if (before) {
          await reopen(); result = await read();
          check('blur/reopen retains draft: ' + JSON.stringify({source,suffix,result}), result.focused && result.value.startsWith(expected));
        }
        await rpc('Input.insertText', { text: 'beta' }); await pause(150);
        result = await read();
        check('continued typing stays after separator: ' + JSON.stringify({source,suffix,expected,result}), result.connected && result.focused && result.value.replace('，', ',').startsWith(expected) && result.value.endsWith('beta'));
        const typed = result.text;
        await evaluate('editor.undo()');
        check('undo preserves punctuation draft', (await evaluate('editor.context.session.text')).includes(expected));
        await evaluate('editor.redo()');
        check('redo restores continued text', await evaluate('editor.context.session.text') === typed);
      }
    }
    for (const [source, offset] of process.env.PLV4_REPRO_ONLY ? [] : [['1girl, 2girls',6],['1girl, 2girls',7],['{ alpha }',5],['{ alpha, beta }',5],['{ alpha, beta }',2],['{ alpha, beta }',11],['{ }',0],['[@schedule]: { 0 - 1: { alpha } }',5],['[@region]: { [base]: { alpha } }',5],['[@avg]: { 1: { alpha } }',5]]) {
      await reset(source);
      await evaluate(`(async()=>{xyzTagAC.hide();field.style.caretColor='red';field.style.caretAnimation='manual';const {inlinePoint}=await import('${modules}text_input.js');const r=document.createRange();r.setStart(...inlinePoint(field,${offset}));r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);})()`);
      const before=await read(), point=await visibleCaret();
      for(let count=1;count<=3;count++) {
        await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
        await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await pause(80);
        const after=await read(), caret=await visibleCaret();
        check('Enter caret source offset: '+JSON.stringify({source,offset,count,after}),after.caret.offset===offset+count);
        // An empty host initially uses its placeholder's baseline. Its first
        // real blank line can have a different font ascent, but must move down.
        check('Enter painted caret moves to the next line: '+JSON.stringify({source,offset,count,point,caret,lineHeight:before.lineHeight}),before.value?Math.abs(caret[1]-point[1]-count*before.lineHeight)<3:caret[1]>point[1]+(count-1)*before.lineHeight+8);
      }
      await rpc('Input.insertText',{text:'X'});await pause(100);
      const continued=await read();
      check('typing after Enter uses the new line: '+JSON.stringify({source,offset,before,continued}),continued.value===before.value.slice(0,offset)+'\n\n\nX'+before.value.slice(offset));
    }
    // The reported document must also work after an actual pointer click into
    // its prompt span; programmatic end-of-host ranges use a different DOM seam.
    for (const source of process.env.PLV4_SCREENSHOT_REPRO ? ['1girl,\n2girls, yuri, ', '{ 1girl,\n2girls, yuri, }', '{\n  1girl,\n2girls, yuri, \n}'] : ['1girl,  2girls, yuri', '{ 1girl,  2girls, yuri }', '{\n  1girl,  2girls, yuri\n}', '{ { 1girl,  2girls, yuri } }']) {
      for (const mode of process.env.PLV4_PASTE_REPRO ? ['paste-end','legacy-paste'] : process.env.PLV4_SCREENSHOT_REPRO ? ['text-end', 'blank-end', 'keyboard-end'] : ['text-end', 'blank-end', 'middle', 'typed-end']) {
      await reset(source);
      if(['typed-end','paste-end','legacy-paste'].includes(mode)) {
        await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
        await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
        if(mode==='paste-end')await evaluate(`(()=>{const d=new DataTransfer();d.setData('text/plain',${JSON.stringify('1girl,\n2girls, yuri, ')});field.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:d}));})()`);
        else if(mode==='legacy-paste')await evaluate(`document.execCommand('insertHTML',false,'<b style="white-space:normal">1girl,<br>2girls, yuri,&nbsp;</b>')`);
        else await rpc('Input.insertText',{text:'1girl,  2girls, yuri'});await pause(200);
      }
      const hit = await evaluate(`(()=>{const spans=[...field.querySelectorAll('[data-prompt-id]')];const span=${JSON.stringify(mode)}==='middle'?spans[0]:spans.at(-1);const r=(span||field).getBoundingClientRect();field.style.caretColor='red';field.style.caretAnimation='manual';return {x:r.right+(${JSON.stringify(mode)}==='blank-end'?25:-1),y:r.top+r.height/2};})()`);
      if(!['typed-end','paste-end','legacy-paste'].includes(mode)) {
      for(const type of ['mouseMoved','mousePressed','mouseReleased']) await rpc('Input.dispatchMouseEvent',{type,...hit,button:type==='mouseMoved'?'none':'left',clickCount:type==='mouseMoved'?0:1});
      }
      if(mode==='keyboard-end') {
        await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End',windowsVirtualKeyCode:35});
        await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'End',code:'End',windowsVirtualKeyCode:35});
      }
      await pause(500);
      // The fixture's dummy search always returns blue_eyes. Enter confirming
      // that real candidate is expected completion, outside this newline check.
      if(['typed-end','paste-end','legacy-paste'].includes(mode))await evaluate('xyzTagAC.hide()');
      const before=await read(), point=await visibleCaret();
      for(let count=1;count<=(process.env.PLV4_SCREENSHOT_REPRO?1:3);count++) {
        await rpc('Input.dispatchKeyEvent',{type:process.env.PLV4_NATIVE_KEYS?'rawKeyDown':'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
        if(process.env.PLV4_NATIVE_KEYS)await rpc('Input.dispatchKeyEvent',{type:'char',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
        await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});await pause(150);
        const after=await read(), caret=await visibleCaret();
        check('clicked prompt Enter logical position: '+JSON.stringify({source,mode,count,before,after}),after.caret.offset===before.caret.offset+count);
        check('clicked prompt Enter painted caret: '+JSON.stringify({source,mode,count,point,caret,before,after}),Math.abs(caret[1]-point[1]-count*before.lineHeight)<3);
      }
      }
    }
    for (const source of ['1girl, 2girls', '{ 1girl, 2girls }', '{ }']) {
      await reset(source);
      await evaluate("xyzTagAC.hide();field.style.caretColor='red';field.style.caretAnimation='manual'");
      const before = await read(), point = await visibleCaret();
      for (let i=0;i<3;i++) {
        await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
        await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      }
      await pause(100);
      for (let remaining=2;remaining>=0;remaining--) {
        await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
        await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
        await pause(100);const after=await read(),caret=await visibleCaret();
        check('one Backspace removes one empty line: '+JSON.stringify({source,remaining,after}),after.value===before.value+'\n'.repeat(remaining));
        check('Backspace painted caret returns one line: '+JSON.stringify({source,remaining,point,caret,after}),!before.value||remaining===0||Math.abs(caret[1]-point[1]-remaining*before.lineHeight)<3);
      }
    }
    for (const source of ['1girl, 2girls\n', '1girl, 2girls\n\n', '{\n  1girl, 2girls\n\n}']) {
      await reset(source);
      const before=await read();
      await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
      await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Backspace',code:'Backspace',windowsVirtualKeyCode:8});
      await pause(100);
      const after=await read();
      check('one Backspace removes a reopened blank line: '+JSON.stringify({source,before,after}),after.value===before.value.slice(0,-1));
    }
    for (const offset of [3,6,7]) {
      await reset('1girl, 2girls');
      await evaluate(`(async()=>{xyzTagAC.hide();const {inlinePoint}=await import('${modules}text_input.js');const r=document.createRange();r.setStart(...inlinePoint(field,${offset}));r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);})()`);
      const before=await read();
      for(let i=0;i<3;i++){
        await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
        await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      }
      await pause(100);
      await evaluate(`(async()=>{const {inlinePoint}=await import('${modules}text_input.js');const r=document.createRange();r.setStart(...inlinePoint(field,${offset}));r.collapse(true);getSelection().removeAllRanges();getSelection().addRange(r);})()`);
      for(let remaining=2;remaining>=0;remaining--){
        await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Delete',code:'Delete',windowsVirtualKeyCode:46});
        await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Delete',code:'Delete',windowsVirtualKeyCode:46});
        await pause(100);const after=await read();
        check('one Delete removes one following newline: '+JSON.stringify({offset,remaining,after}),after.value===before.value.slice(0,offset)+'\n'.repeat(remaining)+before.value.slice(offset));
      }
    }
    for(const value of ['1girl,\n2girls, yuri, ', '1girl,\n', '1girl,\n\n']) {
      await reset('{ }');
      await rpc('Input.insertText',{text:value});await pause(100);
      const pasted=await read();
      check('multiline plain text insertion preserves final blank lines: '+JSON.stringify({value,pasted}),pasted.value===value);
    }
    await reset('1girl, 2girls');
    const markerState=await evaluate(`(async()=>{const marker=field.querySelector('.boundary.inline');const editing=marker.getBoundingClientRect().width;const {DropPreview}=await import('${modules}drop_preview.js');const preview=new DropPreview(editor);const dragging=marker.getBoundingClientRect().width;preview.destroy();const restored=marker.getBoundingClientRect().width;return {editing,dragging,restored};})()`);
    check('inline drag markers leave editing layout and return for drag targets',markerState.editing===0&&markerState.dragging>0&&markerState.restored===0);
    console.log('PASS ' + checks + ' native separator checks (' + (realComfy ? 'real ComfyUI' : 'isolated PLv4') + ')');
  } finally {
    if (rpc) await rpc('Browser.close').catch(() => {});
    ws?.close(); chrome.kill();
    await pause(250);
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
