// Header hover submenu regression against the disposable PLv4 fixture only.
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
    const check=(label,value)=>{assert.ok(value,label);checks++;};
    const pointer=async rect=>rpc('Input.dispatchMouseEvent',{type:'mouseMoved',x:rect.x,y:rect.y});
    const click=async expression=>{
      const rect=await evaluate(`(()=>{const r=(${expression}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await pointer(rect);
      await rpc('Input.dispatchMouseEvent',{type:'mousePressed',...rect,button:'left',clickCount:1});
      await pause(80);
      await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',...rect,button:'left',clickCount:1});
      await pause(120);
    };
    const open=async source=>{await reset(source);await evaluate(`(async()=>{field.blur();await editor.blockView.finishInline(field);editor.blocks.querySelector('[data-block-menu]').click();})()`);};
    const hover=async index=>{
      const rect=await evaluate(`(()=>{const row=document.querySelector('.plv4-popover:not(.plv4-submenu)').querySelectorAll(':scope>.plv4-menu-branch')[${index}];const r=row.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await pointer(rect);
    };
    const state=()=>evaluate(`(()=>{const root=document.querySelector('.plv4-popover:not(.plv4-submenu)'),visible=[...root.querySelectorAll('.plv4-submenu')].filter(n=>!n.hidden);return{count:root.querySelectorAll(':scope>button,:scope>.plv4-menu-branch>button').length,text:root.innerText,visible:visible.length,labels:visible[0]?[...visible[0].querySelectorAll(':scope>button')].map(b=>b.textContent):[],branches:[...root.querySelectorAll(':scope>.plv4-menu-branch>button')].map(b=>b.firstChild.textContent)}})()`);
    await open('{ alpha }');
    check('Header main menu has two collapsed Add branches and three actions',(await state()).count===5&&(await state()).visible===0);
    await hover(0);let result=await state();
    check('Pointer hover opens sibling submenu without clicking',result.visible===1&&result.labels.join('|')==='普通 Block|Schedule 容器|Region 容器|AVG 容器');
    const childRect=await evaluate(`(()=>{const r=document.querySelector('.plv4-submenu:not([hidden])').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+16}})()`);
    await pointer(childRect);
    check('Moving from parent to child keeps submenu open',(await state()).visible===1);
    await hover(1);check('Hovering another branch replaces the visible submenu',(await state()).visible===1);
    await evaluate(`document.querySelector('.plv4-submenu:not([hidden])').querySelector('button').click()`);
    await pause(200);await evaluate('editor.flushEditor()');
    check('Child ordinary Block action inserts inside the selected Block',await evaluate('editor.context.session.state.doc.root.children[0].children.some(n=>n.form===\'brace\')'));
    check('Choosing a child action closes the complete menu',await evaluate('!document.querySelector(\'.plv4-popover\')'));
    await open('{ alpha }');await hover(0);
    await evaluate(`[...document.querySelector('.plv4-submenu:not([hidden])').querySelectorAll('button')].find(b=>b.textContent==='Schedule 容器').click()`);
    await pause(200);await evaluate('editor.flushEditor()');
    check('Sibling Schedule action preserves same-level placement',await evaluate('editor.context.session.state.doc.root.children.some(n=>n.form===\'schedule\')'));
    await open('[@region]: { [base]: { alpha } }');
    check('Region container cannot offer direct child Blocks',!(await state()).branches.includes('添加子 Block'));
    await evaluate(`document.querySelector('.plv4-popover').remove();editor.blocks.querySelectorAll('[data-block-menu]')[1].click()`);
    result=await state();check('Region entry has child branch only',result.branches.join('|')==='添加子 Block');
    await hover(0);check('Region entry submenu excludes a nested Region',!(await state()).labels.includes('Region 容器'));
    await open('{ alpha }');
    await evaluate(`(()=>{const root=document.querySelector('.plv4-popover:not(.plv4-submenu)');root.style.left=(innerWidth-root.offsetWidth-8)+'px';root.style.top=(innerHeight-root.offsetHeight-8)+'px';})()`);
    await hover(1);
    const bounds=await evaluate(`(()=>{const root=document.querySelector('.plv4-popover:not(.plv4-submenu)').getBoundingClientRect(),sub=document.querySelector('.plv4-submenu:not([hidden])').getBoundingClientRect();return{left:sub.left,right:sub.right,top:sub.top,bottom:sub.bottom,rootLeft:root.left,w:innerWidth,h:innerHeight}})()`);
    check('Submenu flips left near the viewport right edge',bounds.right<=bounds.rootLeft+6);
    check('Submenu remains inside the viewport',bounds.left>=8&&bounds.right<=bounds.w-8&&bounds.top>=8&&bounds.bottom<=bounds.h-8);
    await rpc('Input.dispatchMouseEvent',{type:'mousePressed',x:1,y:1,button:'left',clickCount:1});
    await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',x:1,y:1,button:'left',clickCount:1});
    check('Outside click closes both menus',await evaluate('!document.querySelector(\'.plv4-popover\')'));
    await open('{ alpha }, { beta }');await hover(0);
    await click(`document.querySelector('.plv4-submenu:not([hidden])').querySelector('button')`);
    await evaluate('editor.context.session.whenIdle()');
    check('Adding a sibling focuses its empty native input',await evaluate(`document.activeElement.matches('[data-empty]')`));
    await click(`editor.blocks.querySelectorAll('[data-block-menu]')[0]`);
    check('After adding a Block, one physical click opens another header menu',await evaluate(`!!document.querySelector('.plv4-popover:not(.plv4-submenu)')`));
    check('Opening the menu still finishes the focused input',await evaluate('!editor.blockView.inline'));
    for(const [branch,label] of [[1,'普通 Block'],[0,'Schedule 容器'],[0,'Region 容器'],[0,'AVG 容器']]){
      await open('{ alpha }, { beta }');await hover(branch);
      await click(`[...document.querySelector('.plv4-submenu:not([hidden])').querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(label)})`);
      await evaluate(`(async()=>{for(let i=0;i<100&&!editor.blockView.inline;i++)await new Promise(r=>setTimeout(r,25));if(!editor.blockView.inline)throw new Error('New Block input was not focused');await editor.blockView.inline.ready;})()`);
      await rpc('Input.insertText',{text:'new content'});
      await evaluate('editor.blockView.inline.pending');
      await click(`editor.blocks.querySelector('[data-block-menu]')`);
      check(`One click opens another header after adding ${branch?'child':'sibling'} ${label}`,await evaluate(`!!document.querySelector('.plv4-popover:not(.plv4-submenu)')`));
      check(`Menu opening saves new ${label} content and ends editing`,await evaluate(`editor.context.session.state.text.includes('new content')&&!editor.blockView.inline`));
    }
    await reset('{ alpha }, { beta }');
    await rpc('Input.insertText',{text:', gamma'});
    await evaluate('editor.blockView.inline.pending');
    await click(`editor.blocks.querySelectorAll('[data-block-menu]')[1]`);
    check('An existing edited Block also opens another header on the first click',await evaluate(`!!document.querySelector('.plv4-popover:not(.plv4-submenu)')&&editor.context.session.state.text.includes('gamma')&&!editor.blockView.inline`));
    console.log('PASS '+checks+' header hover submenu checks ('+(realComfy?'real ComfyUI':'isolated PLv4')+')');
  } finally {
    if (rpc) await rpc('Browser.close').catch(() => {});
    ws?.close(); chrome.kill();
    await pause(250);
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
