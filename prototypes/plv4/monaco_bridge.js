// P0 adapter only. Reuse PromptEditor, Monaco bootstrap, grammar, theme and commands.
// The preview server delegates parsing/compilation to the unchanged PLv3 backend.
let prototypeEditorPromise=null,prototypeEditorNode=null;
const prototypeModels=new Map();
let prototypeSyncing=false,prototypeAccepted='',prototypeAstReady=false;

function prototypeSource(){
  const n=node(),canonical=serialize(isLibraryBlockView()?{...n.root,enabled:true}:n.root);
  return n.syntaxBase===canonical&&typeof n.syntaxText==='string'?n.syntaxText:canonical;
}

function prototypeApplyAst(ast,source,previous,isRoot=false){
  const span=ast.spans?.node||ast.span;
  const raw=source.slice(...span).trim();
  const weighted=ast.kind==='group'&&ast.paren&&ast.children.length===1&&ast.children[0].kind==='text';
  if(ast.kind!=='group'||ast.paren||ast.implicit){
    const p={...(previous?.kind==='prompt'?previous:P('')),
      text:weighted?ast.children[0].text:raw,weight:weighted?(ast.settings.weight??1):1,
      enabled:true,_span:span,_source:raw};
    return p;
  }
  const old=previous?.kind==='block'?previous:B('新 block');
  const type=/^\[@schedule\]/.test(raw)?'schedule':/^\[@region\]/.test(raw)?'region':'normal';
  const config=ast.settings||{},r=config.region;
  const b={...old,enabled:true,type:isRoot?'normal':type,_span:span,_content:ast.spans?.content,_source:raw,
    weight:config.weight??1,format:config.format??'$p',shuffle:!!config.shuffle,
    pick:!!config.random_select,pickMin:config.random_select?.[0]??1,pickMax:config.random_select?.[1]??1,
    dropout:!!config.dropout,probability:config.dropout||.2,seedLock:config.seed!==null,seed:config.seed??0,
    schedule:!!config.schedule,start:config.schedule?.[0]??0,end:config.schedule?.[1]??1,
    region:!!r,regionKind:r?.kind??'imask',mask:r?.imask??0,rect:r?.mask??[0,.5,0,1],
    feather:r?.feather??0,maskWeight:r?.mask_weight??1,condWeight:r?.cond_weight??1,includeBase:!!r?.include_in_base};
  const enabled=old.children.filter(c=>c.enabled),available=new Set(enabled);
  const oldKey=c=>c._source??(c.kind==='prompt'?text(c):serialize(c));
  b.children=ast.children.map((c,index)=>{
    const kind=c.kind==='group'&&!c.paren&&!c.implicit?'block':'prompt';
    const rawChild=source.slice(...(c.spans?.node||c.span)).trim();
    let match=[...available].find(p=>p.kind===kind&&oldKey(p)===rawChild);
    if(!match&&available.has(enabled[index])&&enabled[index]?.kind===kind)match=enabled[index];
    if(match)available.delete(match);
    return prototypeApplyAst(c,source,match);
  });
  // Disabled content stays at its remembered index; a disabled subtree is never reparsed.
  old.children.forEach((c,index)=>{if(!c.enabled)b.children.splice(Math.min(index,b.children.length),0,c)});
  return b;
}

function prototypeAccept(payload,{version,text:source}){
  const pane=window.plv3Prototype,model=pane?.model();
  if(!model||model.getVersionId()!==version||model._plv4Node!==editorKey())return;
  const message=payload.diagnostics?.find(d=>d.severity==='error');
  const libraryRoot=isLibraryBlockView(),enabledChildren=payload.ast?.children?.filter(c=>c.kind==='group')||[];
  const singleRoot=!libraryRoot||payload.ast?.children?.length===1&&enabledChildren.length===1&&!enabledChildren[0].paren;
  prototypeAstReady=!!payload.ok&&!!payload.ast&&singleRoot;
  $('#syntax-status')?.remove();
  $('#editor-status').innerHTML='';
  $('#editor-status').insertAdjacentHTML('beforeend',`<span class="syntax-status" id="syntax-status">${prototypeAstReady?'Monaco · PLv3':esc(!singleRoot?'Library block 只能有一个根 block':message?.message||'语法尚未完整 · 内容已保留')}</span>`);
  const n=node();n.syntaxText=source;
  if(!prototypeAstReady){n.syntaxBase=serialize(libraryRoot?{...n.root,enabled:true}:n.root);save();return}
  const next=prototypeApplyAst(libraryRoot?enabledChildren[0]:payload.ast,source,n.root,!libraryRoot);
  if(libraryRoot)next.enabled=n.root.enabled;
  if(source!==prototypeAccepted&&!prototypeSyncing){history.push(clone(state));future=[]}
  n.root=next;n.syntaxBase=serialize(libraryRoot?{...next,enabled:true}:next);n.syntaxText=source;prototypeAccepted=source;
  if(state.selected&&!find(state.selected)){state.selected=null;state.prompt=null}
  $('#undo').disabled=false;$('#redo').disabled=false;
  renderInspector();save();
}

async function prototypeFlush(){
  const pane=window.plv3Prototype;if(!pane||prototypeEditorNode!==editorKey())return true;
  const model=pane.model(),source=model.getValue();
  const response=await fetch('/xyz/plv3/ast',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:source})});
  const payload=await response.json();
  prototypeAccept(payload,{version:model.getVersionId(),text:source});
  if(!prototypeAstReady){toast(isLibraryBlockView()?'Library block 需保留一个完整的根 block。':'语法尚未完整，先完成当前编辑再切换视图。内容已保留。');return false}
  return true;
}

window.mountPLV3=async function(){
  const container=$('#monaco-root');
  if(location.protocol==='file:'){
    container.innerHTML='<div class="monaco-loading">完整 Monaco 预览：<a href="http://127.0.0.1:8766/prototypes/plv4/nested.html">打开本地预览</a><br>若尚未启动，运行此目录的 start-preview.cmd。</div>';return;
  }
  if(!prototypeEditorPromise){
    container.innerHTML='<div class="monaco-loading">正在加载 PLv3 Monaco…</div>';
    prototypeEditorPromise=(async()=>{
      const {PromptEditor}=await import('/js/plv3/editor_core.js');
      const {loadMonaco}=await import('/js/plv3/monaco.js');
      await loadMonaco();
      // A blob worker has no URL base for a root-relative importScripts path.
      // Keep this preview adjustment here; do not alter the production bootstrap.
      const vendor=new URL('/xyz/plv3/monaco/',location.href).href;
      window.MonacoEnvironment.getWorkerUrl=()=>URL.createObjectURL(new Blob([
        `self.MonacoEnvironment={baseUrl:${JSON.stringify(vendor)}};importScripts(${JSON.stringify(vendor+'vs/base/worker/workerMain.js')});`
      ],{type:'text/javascript'}));
      container.innerHTML='';
      const pane=new PromptEditor(container,{syncOnBlur:false,onAst:prototypeAccept,params:()=>({seed:241720,region_mode:'couple'})});
      window.plv3Prototype=pane;await pane.init();
      // Save in this mock Library; never open a production library window.
      pane.selectionToGroup=()=>prototypeWrapSelection(true);
      pane.editor.addAction({id:'plv4.details',label:'PLv4: 打开详细设置',contextMenuGroupId:'navigation',contextMenuOrder:1,
        run:()=>{const m=pane.model(),at=m.getOffsetAt(pane.editor.getPosition());const hit=walk(root()).filter(c=>c._span&&c.id!==root().id&&at>=c._span[0]&&at<=c._span[1]).sort((a,b)=>(a._span[1]-a._span[0])-(b._span[1]-b._span[0]))[0];if(hit)detail(hit.id)}});
      pane.editor.addAction({id:'plv4.wrap',label:'PLv4: 选中 prompts 组成新 block',contextMenuGroupId:'modification',contextMenuOrder:1,
        run:()=>prototypeWrapSelection()});
      pane.editor.onDidChangeModelContent(()=>{
        if(prototypeSyncing)return;
        node().syntaxText=pane.text();node().syntaxBase=serialize(root());save();
      });
      return pane;
    })().catch(error=>{prototypeEditorPromise=null;container.innerHTML=`<div class="monaco-loading">Monaco 加载失败：${esc(error.message)}</div>`;throw error});
  }
  const pane=await prototypeEditorPromise;
  if(state.mode!=='syntax')return;
  let model=prototypeModels.get(editorKey());
  const source=prototypeSource();
  prototypeSyncing=true;
  if(prototypeEditorNode!==editorKey()){
    pane.setDoc(null);prototypeEditorNode=editorKey();
    if(!model){model=pane.createModel(source);model._plv4Node=editorKey();prototypeModels.set(editorKey(),model)}
    pane.setModel(model);
  }
  if(model.getValue()!==source)pane.setText(source);
  prototypeAccepted=source;prototypeSyncing=false;prototypeAstReady=false;
  requestAnimationFrame(()=>pane.editor.layout());pane.scheduleLint();
};

async function prototypeWrapSelection(saveToLibrary=false){
  const pane=window.plv3Prototype;
  if(!await prototypeFlush())return;
  const model=pane.model(),sel=pane.editor.getSelection();if(!sel||sel.isEmpty()){toast('请先选择完整 prompts');return}
  const start=model.getOffsetAt(sel.getStartPosition()),end=model.getOffsetAt(sel.getEndPosition());
  const candidates=walk(root()).filter(c=>c.kind==='prompt'&&c.enabled&&c._span&&c._span[0]>=start&&c._span[1]<=end);
  const parent=candidates.length?find(candidates[0].id)?.parent:null;
  if(!parent||candidates.some(c=>find(c.id).parent!==parent)){toast('请选择同一父级内连续的完整 prompts');return}
  const indices=candidates.map(c=>parent.children.indexOf(c));
  const between=parent.children.slice(indices[0],indices.at(-1)+1).filter(c=>c.enabled);
  if(between.length!==candidates.length||model.getValueInRange(sel).trim()!==model.getValue().slice(candidates[0]._span[0],candidates.at(-1)._span[1]).trim()){toast('选区需只包含连续的完整 prompts');return}
  const a=candidates[0]._span[0],z=candidates.at(-1)._span[1];
  pane.editor.pushUndoStop();pane.editor.executeEdits('plv4-wrap',[{range:pane.monaco.Range.fromPositions(model.getPositionAt(a),model.getPositionAt(z)),text:'{ '+model.getValue().slice(a,z)+' }'}]);pane.editor.pushUndoStop();
  await prototypeFlush();
  const block=walk(root()).find(c=>c.kind==='block'&&c._span?.[0]===a);
  if(block){detail(block.id);if(saveToLibrary)openSave(block.id)}
}

// Finish parsing before navigation; incomplete text is retained in Monaco.
document.addEventListener('click',async e=>{
  const target=e.target.closest('[data-mode],[data-node],#undo,#redo');
  if(!target||state.mode!=='syntax'||!window.plv3Prototype)return;
  if(target.id==='undo'||target.id==='redo'){
    e.preventDefault();e.stopImmediatePropagation();window.plv3Prototype.editor.trigger('toolbar',target.id,null);return;
  }
  if(target.dataset.mode==='syntax')return;
  e.preventDefault();e.stopImmediatePropagation();
  if(!await prototypeFlush())return;
  if(target.dataset.mode)state.mode=target.dataset.mode;
  else{state.view=null;state.workflowSelection=null;state.node=Number(target.dataset.node);state.selected=node().root.children.find(c=>c.kind==='block')?.id;state.focus=null;state.prompt=null}
  render();
},true);
document.addEventListener('change',async e=>{
  if(e.target.id!=='overflow'||state.mode!=='syntax'||!window.plv3Prototype)return;
  e.stopImmediatePropagation();const next=Number(e.target.value);
  if(next&&await prototypeFlush()){state.view=null;state.workflowSelection=null;state.node=next;state.selected=node().root.children[0]?.id;state.focus=null;state.prompt=null;render()}
},true);

// Library insertion uses Monaco's actual caret hit testing, not a fake text layout.
const originalShowPointerTarget=showPointerTarget,originalFinishPointer=finishPointer;
let prototypeDropPosition=null;
showPointerTarget=function(x,y){
  if(state.mode!=='syntax'||!window.plv3Prototype){originalShowPointerTarget(x,y);return}
  const pane=window.plv3Prototype,hit=pane.editor.getTargetAtClientPoint(x,y);
  const rect=$('#monaco-root').getBoundingClientRect();
  prototypeDropPosition=hit?.position&&x>=rect.left&&x<=rect.right&&y>=rect.top&&y<=rect.bottom?hit.position:null;
  if(prototypeDropPosition){pane.editor.setPosition(prototypeDropPosition);pane.editor.revealPosition(prototypeDropPosition)}
  $('#drop-hint').textContent=prototypeDropPosition?'插入到 Monaco 光标位置':'拖到 Monaco 编辑器内';$('#drop-hint').hidden=false;
  $('#drop-hint').style.left=Math.min(innerWidth-210,x+16)+'px';$('#drop-hint').style.top=Math.min(innerHeight-45,y+16)+'px';
};
finishPointer=function(cancel=false){
  if(state.mode!=='syntax'||!pointerDrag?.active||!window.plv3Prototype){originalFinishPointer(cancel);return}
  const payload=drag,position=prototypeDropPosition,pane=window.plv3Prototype;
  originalFinishPointer(true);prototypeDropPosition=null;
  if(cancel||!position||!['asset','prompts'].includes(payload?.kind))return;
  const asset=assetBy(payload.id),model=pane.model(),at=model.getOffsetAt(position);
  const body=payload.kind==='prompts'?join(leaves(asset.block).map(text)):serialize(asset.block);
  const left=model.getValue().slice(0,at).trimEnd(),right=model.getValue().slice(at).trimStart();
  // Reject a character inside a prompt or syntax header; whole-item boundaries only.
  const containing=walk(root()).filter(c=>c.enabled&&c._span&&at>c._span[0]&&at<c._span[1]);
  if(!prototypeAstReady||containing.some(c=>c.kind==='prompt'||c.kind==='block'&&c._content&&(at<c._content[0]||at>c._content[1]))){toast('请选择完整 prompt 之间的位置');return}
  const prefix=left&&!/[,{\n]$/.test(left)?(/\.$/.test(left)?' ':', '):'';
  const suffix=right&&!/^[,}]/.test(right)?(/\.$/.test(body)?' ':', '):'';
  pane.editor.pushUndoStop();pane.editor.executeEdits('plv4-library',[{range:new pane.monaco.Range(position.lineNumber,position.column,position.lineNumber,position.column),text:prefix+body+suffix}]);pane.editor.pushUndoStop();pane.editor.focus();toast('已插入 Monaco · 可撤销');
};
if(state.mode==='syntax')window.mountPLV3();
