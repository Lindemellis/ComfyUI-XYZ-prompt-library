// Only the disposable LoRA fixture: synthetic models, workflow and Library DB.
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const binary = path.join(process.env.APPDATA, 'npm/node_modules/agent-browser/bin/agent-browser-win32-x64.exe');
const base = process.env.LORA_TEST_URL;
if (!base) throw new Error('Set LORA_TEST_URL to plv4_lora_fixture.py');
const session = 'xyz-avg-check';
function run(...args) {
  const result = spawnSync(binary, ['--session', session, '--json', ...args], { encoding: 'utf8', timeout: 45000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const response = JSON.parse(result.stdout); assert.ok(response.success, response.error);
  return response.data;
}
try {
  run('open', base);
  const result = run('eval', `(async()=>{
    const checks=[];
    const check=(name,value)=>{if(!value)throw new Error(name);checks.push(name);};
    const wait=async predicate=>{for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,25));}throw new Error('timeout');};
    await wait(()=>window.ready);
    check('isolated fixture',document.title==='PLv4 LoRA isolated check');
    await editor.open(fixture.graph._nodes[0]);
    await editor.command({type:'ReplaceText',text:''});
    const footer=()=>editor.blocks.querySelector(':scope > .block-add-footer');
    const options=async()=>{
      footer().querySelector('.block-add-types').click();
      await wait(()=>document.querySelector('.plv4-popover'));
      return [...document.querySelectorAll('.plv4-popover button')];
    };
    footer().querySelector('.small-add').click();
    await wait(()=>editor.context.session.state.doc.root.children.length===1);
    await wait(()=>document.activeElement?.dataset.empty===editor.context.session.state.doc.root.children[0].id);
    document.activeElement.blur();await editor.flushEditor();
    check('empty document ordinary footer adds directly',editor.context.session.state.doc.root.children[0].form==='brace');
    for(const [form,label,count] of [['region','Region 容器',4],['schedule','Schedule 容器',2],['avg','AVG 容器',2]]){
      const choices=await options();
      check(form+' footer includes all four types',choices.length===4&&choices.some(b=>b.textContent==='普通 block'));
      choices.find(b=>b.textContent===label).click();
      await wait(()=>editor.context.session.state.doc.root.children.some(n=>n.form===form));
      const created=editor.context.session.state.doc.root.children.find(n=>n.form===form);
      await wait(()=>document.activeElement?.dataset.empty===created.children[0].id);
      document.activeElement.blur();await editor.flushEditor();
      check(form+' footer defaults',created.children.length===count&&created.children.every(n=>n.form===form+'_entry'));
      editor.context.focus=created.id;editor.blockView.render(editor.context);
      check(form+' focused footer adds only entry',!footer().querySelector('.block-add-types')&&footer().textContent.includes('添加 entry'));
      if(form==='region'){
        editor.context.focus=created.children[0].id;editor.blockView.render(editor.context);
        const allowed=await options();
        check('region entry footer rejects nested Region',allowed.length===3&&!allowed.some(b=>b.textContent==='Region 容器')&&allowed.some(b=>b.textContent==='AVG 容器'));
        document.querySelector('.plv4-popover').remove();
      }
      editor.context.focus=null;editor.blockView.render(editor.context);
    }
    await editor.command({type:'ReplaceText',text:'{ footer library }'});
    const footerSaved=await editor.command({type:'SaveLibrary',id:editor.context.session.state.doc.root.children[0].id,name:'Footer browser '+Date.now()});
    await editor.library.reload();
    await editor.openLibrary(await editor.library.assetContext(editor.library.data.assets.find(a=>a.id===footerSaved.id)));
    (await options()).find(b=>b.textContent==='Schedule 容器').click();
    await wait(()=>editor.context.session.state.doc.root.children[0].children.some(n=>n.form==='schedule'));
    check('Library footer inserts inside its single saved root',editor.context.session.state.doc.root.children.length===1);
    await editor.open(fixture.graph._nodes[0]);
    await editor.command({type:'ReplaceText',text:'{ a }'});
    const parent=editor.context.session.state.doc.root.children[0].id;
    const items=editor.blockView.menuItems(editor.context.session.projection.tree.children[0]);
    const avg=items.find(([label])=>label==='添加子 Block')?.[1].find(([label])=>label==='AVG 容器');
    check('AVG available in More menu',!!avg);
    await editor.addBlock(parent,true,'avg');
    let container=editor.context.session.state.doc.root.children[0].children[1];
    window.avgId=container.id;
    check('two default entries',container.form==='avg'&&container.children.length===2&&container.children.every(n=>n.form==='avg_entry'));
    check('AVG type badge',editor.blocks.querySelector('[data-block-id="'+container.id+'"] .block-type[data-kind="avg"]').textContent==='AVG');
    check('container has no direct prompt editor',!editor.blocks.querySelector('[data-block-id="'+container.id+'"] > .block-content > .block-body > [contenteditable="true"]'));
    check('entries have no drag handles',[...editor.blocks.querySelectorAll('[data-block-id="'+container.id+'"] [data-drag]')].filter(h=>h.closest('[data-block-id]').dataset.blockId!==container.id).every(h=>h.hidden&&h.disabled));
    const first=container.children[0], second=container.children[1];
    const row=editor.blockView.map.get(first.id);
    check('entry has no Save menu',!editor.blockView.menuItems(row).some(([label])=>label==='Save'));
    const policy=await import('/js/plv4/drop_preview.js');
    check('entry cannot be dragged anywhere',!policy.canDropBlock(editor.context.session.projection.tree,row)&&!policy.canDropBlock(editor.blockView.map.get(container.id),row));
    check('outside block enters only entry body',!policy.canDropBlock(editor.blockView.map.get(container.id))&&policy.canDropBlock(row));
    await editor.locate(first.id);await editor.details.pendingRender;
    check('no random shuffle format controls on entry',!editor.shell.details.textContent.includes('Shuffle')&&!editor.shell.details.textContent.includes('RANDOM')&&!editor.shell.details.textContent.includes('Format'));
    const field=editor.shell.details.querySelector('input[title^="相对混合权重"]');
    check('relative weight field',field?.value==='1'&&field.min==='0');
    field.value='3';field.dispatchEvent(new Event('change',{bubbles:true}));
    await wait(()=>editor.context.session.text.includes('3: {'));
    check('weight badge updates',editor.blocks.querySelector('[data-block-id="'+first.id+'"] .header-settings').textContent.includes('3'));
    await editor.undo();check('undo weight restores value',editor.context.session.text.includes('1: {'));
    await editor.redo();check('redo weight restores value',editor.context.session.text.includes('3: {'));
    await editor.locate(container.id);await editor.details.pendingRender;
    check('container no Pool random shuffle format',!editor.shell.details.textContent.includes('Shuffle')&&!editor.shell.details.textContent.includes('RANDOM')&&!editor.shell.details.textContent.includes('Format')&&!editor.shell.details.textContent.includes('池绑定'));
    check('expanded AVG entries section',[...editor.shell.details.querySelectorAll('details')].some(d=>d.open&&d.querySelector('summary').textContent==='AVG entries'));
    await editor.addBlock(container.id,true);
    container=editor.context.session.state.doc.root.children[0].children[1];
    check('new equal-weight entry',container.children.length===3&&container.children[2].open.trim().startsWith('1:'));
    await editor.undo();check('undo add entry',editor.context.session.state.doc.root.children[0].children[1].children.length===2);
    await editor.command({type:'InsertBlock',parent_id:first.id,text:'{ b }'});
    await editor.command({type:'InsertBlock',parent_id:second.id,text:'{ c }'});
    const compiled=await editor.context.session.compile({seed:42,region_mode:'couple'});
    check('real route scoped weighted output',compiled.prompt==='a, b AVG(0.75) a, c');
    const saved=await editor.command({type:'SaveLibrary',id:container.id,name:'AVG browser '+Date.now()});
    await editor.library.reload();
    const asset=editor.library.data.assets.find(a=>a.id===saved.id);
    check('whole AVG saved in Library',asset?.kind==='block');
    await editor.openLibrary(await editor.library.assetContext(asset));
    check('Library shows same AVG UI',!!editor.blocks.querySelector('.block-type[data-kind="avg"]'));
    check('Library AVG footer offers only entry',!footer().querySelector('.block-add-types')&&footer().textContent.includes('添加 entry'));
    await editor.open(fixture.graph._nodes[0]);
    await editor.command({type:'ReplaceText',text:'{ alpha, { neighbor } }'});
    const input=editor.blocks.querySelector('[data-run-input]');input.focus();await editor.blockView.inline.ready;
    const range=document.createRange();range.selectNodeContents(input);getSelection().removeAllRanges();getSelection().addRange(range);
    document.execCommand('insertText',false,'[@avg]: { 1: { b }, 1: { c } }');
    await editor.blockView.flush();input.blur();await editor.flushEditor();
    await wait(()=>editor.context.session.state.doc.root.children[0].children[0].form==='avg');
    check('native Source blur builds AVG and preserves neighbor',editor.context.session.state.doc.root.children[0].children[1].children[0].raw==='neighbor');
    check('no browser errors',window.errors.length===0);
    return checks;
  })()`).result;
  console.log(JSON.stringify({passed:result.length,checks:result},null,2));
  if (process.env.AVG_SCREENSHOT) {
    run('eval', `(async()=>{const avg=editor.context.session.projection.tree.children[0].children[0];await editor.locate(avg.children[0].id);await editor.details.pendingRender;})()`);
    run('screenshot', process.env.AVG_SCREENSHOT);
  }
} finally {
  run('close');
}
