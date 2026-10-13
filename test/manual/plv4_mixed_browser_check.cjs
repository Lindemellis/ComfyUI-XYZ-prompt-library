// Mixed native text/Block editing against the disposable PLv4 fixture only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const base = process.env.PLV4_BASE_URL;
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
      await evaluate(`(async()=>{editor.blockView.inline?.element.blur();await editor.flushEditor();await editor.command({type:'ReplaceText',text:${JSON.stringify(text)}});await editor.setView('block');})()`);
    };
    const type=async(expression,text)=>{
      await click(expression);await evaluate('(async()=>{await editor.blockView.inline.ready;})()');await rpc('Input.insertText',{text});await evaluate('(async()=>{await editor.blockView.inline.pending;})()');
    };
    const openSlot=async expression=>{
      await click(`(${expression}).parentElement.querySelector('.plv4-text-insert-button')`);
      await evaluate('(async()=>{await editor.blockView.inline.ready;})()');
    };
    for(const [selector,child] of [['[data-sibling]',false],['[data-child]',true]]){
      await reset('{ alpha }, { beta }');
      const input=`editor.blocks.querySelector('[data-run-input]')`;
      await click(input);
      await evaluate(`(async()=>{await editor.blockView.inline.ready;const f=document.activeElement;const r=document.createRange();r.selectNodeContents(f);r.collapse(false);getSelection().removeAllRanges();getSelection().addRange(r);})()`);
      await rpc('Input.insertText',{text:', edited'});await evaluate('editor.blockView.inline.pending');
      await click(`editor.blocks.querySelector('${selector}')`);await evaluate('editor.context.session.whenIdle()');
      check('Physical Header '+(child?'child':'sibling')+' click inserts with native draft focused',await evaluate(child?`editor.context.session.state.doc.root.children[0].children.some(n=>n.kind==='group'&&n.form==='brace')`:`editor.context.session.state.doc.root.children.length===3`));
      check('Header addition retains draft text',await evaluate(`editor.context.session.text.includes('edited')`));
    }
    await reset('{ first,\n\nsecond, { inner,\n\nbody }, middle,\nlast }, { target,\n\nend }');
    await evaluate(`(async()=>{const [a,b]=editor.context.session.state.doc.root.children;await editor.command({type:'MoveBlock',id:a.children[2].id,parent_id:b.id,edge:'end'});})()`);
    check('Moving a subblock preserves blank lines in its old parent',await evaluate('editor.context.session.text.includes('+JSON.stringify('first,\n\nsecond')+')'));
    check('Moving a subblock preserves its own native Enter',await evaluate('editor.context.session.text.includes('+JSON.stringify('inner,\n\nbody')+')'));
    check('Moving a subblock preserves other text runs',await evaluate('editor.context.session.text.includes('+JSON.stringify('target,\n\nend')+')'));
    await reset('{ { nested } }');
    const tail=`editor.blocks.querySelector('[data-text-slot="after"]')`;
    const hasTail=await evaluate(`!!${tail}`);check('A Block ending in a subblock has an on-demand continuation',hasTail);
    if(hasTail){
      check('Unused continuation is only a thin seam',await evaluate(`(${tail}).hidden && (${tail}).parentElement.getBoundingClientRect().height<=6`));
      check('Add text button is hidden until hover',await evaluate(`getComputedStyle((${tail}).parentElement.querySelector('button')).opacity==='0'`));
      await openSlot(tail);
      check('Click opens and focuses the native input',await evaluate(`!(${tail}).hidden && document.activeElement===(${tail}) && (${tail}).contentEditable==='plaintext-only'`));
      await evaluate(`(async()=>{document.activeElement.blur();await editor.flushEditor();await new Promise(r=>setTimeout(r,100));})()`);
      check('Leaving an untouched input collapses without changing the document',await evaluate(`(${tail}).hidden && (${tail}).parentElement.getBoundingClientRect().height<=6 && editor.context.session.text==='{ { nested } }'`));
      await openSlot(tail);await rpc('Input.insertText',{text:'trailing words'});await evaluate('editor.blockView.inline.pending');await evaluate(`(async()=>{document.activeElement.blur();await editor.flushEditor();})()`);
      check('Continuation is text after the subblock in the same parent',await evaluate(`(()=>{const p=editor.context.session.state.doc.root.children[0];return p.children.length===2&&p.children[0].kind==='group'&&p.children[1].raw==='trailing words'})()`));
      await evaluate(`editor.context.session.undo()`);check('One undo removes only newly typed continuation and collapses the entry',await evaluate(`editor.context.session.state.doc.root.children[0].children.length===1 && (${tail}).hidden`));
    }
    await reset('{ { left }, { right } }');
    const between=`editor.blocks.querySelector('[data-text-slot="after"][data-before-block]')`;
    const hasBetween=await evaluate(`!!${between}`);check('Adjacent subblocks have an intervening text entry',hasBetween);
    if(hasBetween){
      check('Adjacent Block text entry takes no text line',await evaluate(`(${between}).hidden && (${between}).parentElement.getBoundingClientRect().height<=6`));
      await openSlot(between);await rpc('Input.insertText',{text:'middle text'});await evaluate('editor.blockView.inline.pending');await evaluate(`(async()=>{document.activeElement.blur();await editor.flushEditor();})()`);
      check('Typing between Blocks retains their order',await evaluate(`(()=>{const p=editor.context.session.state.doc.root.children[0];return p.children.length===3&&p.children[0].kind==='group'&&p.children[1].raw==='middle text'&&p.children[2].kind==='group'})()`));
    }
    await reset('{ { { deepest } } }');
    const deepTail=`editor.blocks.querySelector('[data-text-slot="after"]')`;
    const owner=await evaluate(`(${deepTail}).dataset.empty`);
    await openSlot(deepTail);await rpc('Input.insertText',{text:'deep continuation'});await evaluate('editor.blockView.inline.pending');
    await evaluate(`(async()=>{document.activeElement.blur();await editor.flushEditor();})()`);
    check('Nested trailing seams target their own parent',await evaluate(`(()=>{const walk=n=>n.id===${JSON.stringify(owner)}?n:n.children.map(walk).find(Boolean);const p=walk(editor.context.session.state.doc.root);return p.children.at(-1).raw==='deep continuation'})()`));
    await reset('{ { left }, { right } }');
    await openSlot(between);
    await click(`editor.blocks.querySelector('[data-run-input]')`);
    check('Empty slot also collapses when focus moves directly to another text run',await evaluate(`(async()=>{await new Promise(r=>setTimeout(r,150));return (${between}).hidden && !(${between}).parentElement.classList.contains('expanded') && document.activeElement.matches('[data-run-input]')})()`));
    for(const text of ['before, { inner }, after','{ before, { inner }, middle, { second }, after }','{ a,\n\nb, { inner }, c,\nd }','{ { first }, { second }, { third } }']){
      await reset(text);check('Mixed text/Block layout survives open and Source return: '+text,await evaluate(`(async()=>{const before=editor.context.session.text;await editor.setView('syntax');await editor.setView('block');return editor.context.session.text===before})()`));
    }
    if(process.env.PLV4_SCREENSHOT_DIR){const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(process.env.PLV4_SCREENSHOT_DIR,'mixed-text-block.png'),Buffer.from(shot.data,'base64'));}
    assert.deepEqual(failures,[],'Mixed input regressions');console.log('PASS '+checks+' mixed input checks');
  } finally {
    if (rpc) await rpc('Browser.close').catch(() => {});
    ws?.close(); chrome.kill();
    await pause(250);
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
