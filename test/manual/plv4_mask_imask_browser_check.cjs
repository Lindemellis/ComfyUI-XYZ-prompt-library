// Physical mouse/keyboard check. Accepts only the disposable mask fixture.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const base=process.env.PLV4_BASE_URL;
if(!base)throw new Error('PLV4_BASE_URL must identify a disposable fixture');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const info=await fetch(base+'/object_info').then(r=>r.json());assert.ok(info['PLv4 Fixture Capture']&&info['XYZ PLV4 Mask Preview']);
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'xyz-mask-browser-'));
  const chrome=spawn('C:/Program Files/Google/Chrome/Application/chrome.exe',['--headless=new','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+profile,'--window-size=1440,960',base],{windowsHide:true,stdio:'ignore'});
  let ws,rpc,checks=0;
  try{
    for(let i=0;i<240&&!fs.existsSync(path.join(profile,'DevToolsActivePort'));i++)await pause(25);
    const port=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];const pages=await fetch('http://127.0.0.1:'+port+'/json/list').then(r=>r.json());
    ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});let seq=0;const pending=new Map();
    ws.onmessage=e=>{const v=JSON.parse(e.data),p=pending.get(v.id);if(p){pending.delete(v.id);v.error?p.reject(v.error):p.resolve(v.result);}};
    rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,t=setTimeout(()=>{pending.delete(id);reject(new Error('Timeout: '+method));},20000);pending.set(id,{resolve:v=>{clearTimeout(t);resolve(v);},reject:v=>{clearTimeout(t);reject(v);}});ws.send(JSON.stringify({id,method,params}));});
    const evaluate=async expression=>{const r=await rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
    const wait=async expression=>{for(let i=0;i<160;i++){if(await evaluate(expression))return;await pause(50);}throw new Error('Condition not met: '+expression);};
    const point=selector=>evaluate(`(async()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw new Error('No element '+${JSON.stringify(selector)}+' '+JSON.stringify({selector:document.querySelector('.mask-selector')?.innerText,children:document.querySelector('.mask-selector-items')?.innerHTML,asset:window.asset?.id,errors:window.errors}));el.scrollIntoView({block:'nearest'});await new Promise(requestAnimationFrame);const r=el.getBoundingClientRect();window.lastPoint={selector:${JSON.stringify(selector)},r:r.toJSON(),actual:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,200),box:document.querySelector('.mask-selector')?.getBoundingClientRect().toJSON()};return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    const idle=()=>wait('!window.drawing?.pending');
    const click=async selector=>{await idle();const p=await point(selector);await rpc('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});await pause(40);await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1});await pause(150);await idle();};
    const drag=async(a,b)=>{await idle();await rpc('Input.dispatchMouseEvent',{type:'mousePressed',...a,button:'left',clickCount:1});await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',...b,buttons:1,button:'left'});await pause(80);await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',...b,button:'left',clickCount:1});await pause(220);await idle();};
    const check=async(expression,label)=>{const ok=await evaluate(expression);if(!ok){console.log(await evaluate('JSON.stringify({canvas:window.drawing?.canvas,past:window.drawing?.past.length,version:window.drawing?.version,pending:window.drawing?.pending,rect:window.drawing?.board.getBoundingClientRect().toJSON(),errors:window.errors})'));if(process.env.PLV4_SCREENSHOT){const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(process.env.PLV4_SCREENSHOT,Buffer.from(shot.data,'base64'));}}assert.ok(ok,label);checks++;console.log('PASS '+label);};
    await rpc('Page.bringToFront');await pause(12000);await wait('!!window.plv4');
    const templateClose=await evaluate(`(()=>{const el=document.querySelector('.p-dialog-close-button');if(!el)return null;const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    if(templateClose){await rpc('Input.dispatchMouseEvent',{type:'mousePressed',...templateClose,button:'left',clickCount:1});await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',...templateClose,button:'left',clickCount:1});await pause(250);}

    const key=async(name,code,number,modifiers=0)=>{await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:name,code,windowsVirtualKeyCode:number,modifiers});await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:name,code,windowsVirtualKeyCode:number,modifiers});};
    await evaluate(`(async()=>{window.errors=[];addEventListener('error',e=>errors.push(e.message));addEventListener('unhandledrejection',e=>errors.push(String(e.reason)));window.editor=plv4.window;window.app=editor.app;window.maskClient=await import('/extensions/plv4_fixture/plv4/mask_library.js');const node=LiteGraph.createNode('XYZ Prompt Library V4');app.graph.add(node);node.widgets.find(w=>w.name==='text').value='[@region]: { [imask: 6]: { manual } }';await editor.open(node);window.rowID=editor.context.session.state.doc.root.children[0].children[0].id;await editor.locate(editor.context.session.state.doc.root.children[0].id,{reveal:true});})()`);
    const editIndex=async(value)=>{await click('.inspector input[aria-label="IMASK index"]');await key('a','KeyA',65,2);await rpc('Input.insertText',{text:value});await key('Tab','Tab',9);await evaluate('editor.context.session.whenIdle()');};
    await check('[...editor.shell.details.querySelectorAll("input")].some(i=>i.title==="IMASK index (zero-based)"&&i.value==="6")','manual IMASK is visible in Region parent');
    await editIndex('-1');await check('editor.context.session.text.includes("imask: 6")','negative manual IMASK does not change Document');
    await editIndex('7.5');await check('editor.context.session.text.includes("imask: 6")','fractional manual IMASK does not change Document');
    await editIndex('8');await check('editor.context.session.text.includes("imask: 8")','valid manual IMASK commits its integer');
    await evaluate(`(async()=>{await maskClient.maskRequest('tree',{refresh:true});})()`);await click('.inspector button[title="Choose a Library mask"]');await wait('!!document.querySelector(".mask-selector-canvases button")');await click('.mask-selector-canvases button');await click('.mask-selector-items button[data-mask-id="alpha"]');
    await check('![...editor.shell.details.querySelectorAll("input")].some(i=>i.title==="IMASK index (zero-based)")','Library image binding hides manual index in parent view');
    await click('.inspector button[title="Unlink and restore manual IMASK"]');await check('[...editor.shell.details.querySelectorAll("input")].some(i=>i.title==="IMASK index (zero-based)"&&i.value==="8")','Unlink restores editable manual index in parent view');
    await evaluate(`(async()=>{window.asset=(await maskClient.maskRequest('mutate',{action:'save',canvas:{kind:'rectangle',name:'Final dialog '+Date.now(),masks:[]}})).result;})()`);
    await click('.mask-nav button[aria-label="Mask Library"]');await wait('editor.masks.list.querySelectorAll(".mask-canvas-row").length>0');
    const renameSelector='.mask-canvas-row[data-canvas-id="'+await evaluate('asset.id')+'"] button[title="Rename canvas"]';await wait('!!document.querySelector('+JSON.stringify(renameSelector)+')');
    await click(renameSelector);await wait('!!document.querySelector(".mask-dialog")');
    await click('.mask-dialog input');await key('a','KeyA',65,2);await rpc('Input.insertText',{text:'Renamed canvas'});await click('.mask-dialog button[type="submit"]');await wait('!document.querySelector(".mask-dialog")');await wait('[...editor.masks.list.querySelectorAll(".mask-canvas-name")].some(e=>e.textContent==="Renamed canvas")');
    await check('editor.masks.data.canvases.some(c=>c.id===asset.id&&c.name==="Renamed canvas")','direct Rename form saves and refreshes canvas row');
    await check('errors.length===0','final IMASK and dialog browser has no errors');
    console.log('MASK_FINAL_CHECKS='+checks);
  }finally{try{if(rpc)await rpc('Browser.close');}catch{}ws?.close();if(!chrome.killed)chrome.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
