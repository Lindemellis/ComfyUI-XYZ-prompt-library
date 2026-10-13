// Physical Content clicks after another prompt edit/toggle; disposable fixture only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const base = process.env.PLV4_BASE_URL;
if (!base) throw new Error('Set PLV4_BASE_URL to a disposable real ComfyUI fixture');
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

    let checks=0;const failures=[];
    const check=(label,value)=>{checks++;if(!value)failures.push(label);console.log((value?'OK ':'FAIL ')+label)};
    const click=async expression=>{
      await evaluate(`(${expression}).scrollIntoView({block:'nearest'})`);
      const point=await evaluate(`(()=>{const r=(${expression}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await rpc('Input.dispatchMouseEvent',{type:'mouseMoved',...point});
      await rpc('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
      await pause(80);await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});await pause(180);
    };
    const reset=async text=>{
      await evaluate(`document.activeElement.blur()`);await pause(120);
      await evaluate(`(async()=>{editor.blockView.inline?.element.blur();await editor.flushEditor();await editor.command({type:'ReplaceText',text:${JSON.stringify(text)}});await editor.setView('block');})()`);
    };
    for (const prior of ['text', 'toggle', 'body']) {
      for (const action of ['toggle', 'delete']) {
        await reset('{ alpha, beta, gamma }');
        await evaluate(`editor.locate(editor.context.session.state.doc.root.children[0].id)`);
        await evaluate(`(async()=>{await editor.details.pendingRender;})()`);
        const first=`editor.details.container.querySelector('.detail-contents-tree .detail-prompt-row')`;
        const second=`editor.details.container.querySelectorAll('.detail-contents-tree .detail-prompt-row')[1]`;
        const targetId=await evaluate(`(${second}).dataset.promptId`);
        if (prior==='text') {
          await click(`(${first}).querySelector('input[type=text]')`);
          await evaluate('document.activeElement.select()');
          await rpc('Input.insertText',{text:'alpha edited'});
        } else if (prior==='toggle') {
          await click(`(${first}).querySelector('input[type=checkbox]')`);
          await evaluate('editor.context.session.whenIdle()');
        } else {
          await click(`editor.blocks.querySelector('[data-run-input]')`);
          await evaluate(`(async()=>{await editor.blockView.inline.ready;const r=document.createRange();r.selectNodeContents(document.activeElement);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);})()`);
          await rpc('Input.insertText',{text:', body edit'});
          await evaluate('editor.blockView.inline.pending');
        }
        await click(`(${second}).querySelector(${JSON.stringify(action==='toggle'?'input[type=checkbox]':'[data-delete-prompt]')})`);
        await evaluate(`(async()=>{await editor.flushEditor();await editor.context.session.whenIdle();await new Promise(r=>setTimeout(r,100));})()`);
        const ok=await evaluate(`(()=>{const p=editor.context.session.state.doc.root.children[0];const target=p.children.find(n=>n.id===${JSON.stringify(targetId)});return ${action==='toggle'?'target && !target.enabled':'!target'}})()`);
        check('Single Content '+action+' click after '+prior,ok);
        check('Content row reflects '+action+' after '+prior,await evaluate(`(()=>{const row=[...editor.details.container.querySelectorAll('.detail-contents-tree .detail-prompt-row')].find(n=>n.dataset.promptId===${JSON.stringify(targetId)});return ${action==='toggle'?"row && !row.querySelector('input[type=checkbox]').checked":'!row'}})()`));
        if (prior==='text') check('Prior prompt draft is saved',await evaluate(`editor.context.session.text.includes('alpha edited')`));
        if (prior==='body') check('Body draft is saved',await evaluate(`editor.context.session.text.includes('body edit')`));
      }
    }
    assert.deepEqual(failures,[],'Content click regressions');console.log('PASS '+checks+' Content click checks');
  } finally {
    if (rpc) await rpc('Browser.close').catch(() => {});
    ws?.close(); chrome.kill();
    await pause(250);
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
