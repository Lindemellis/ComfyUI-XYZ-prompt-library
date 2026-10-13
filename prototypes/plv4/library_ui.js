// P0 Library views share the same block editor and local undo history.
const libraryBaseTabs=renderTabs,libraryBaseNotebook=renderNotebook;
const libraryBaseInspector=renderInspector,libraryBaseFitTabs=fitTabs;
const libraryBaseMenu=openBlockMenu;

function libraryNavigate(view){
  state.workflowSelection??={selected:state.selected,prompt:state.prompt,focus:state.focus,mode:state.mode};
  state.view=view;state.focus=null;state.prompt=null;state.extra=null;
  if(view.kind==='class'){state.selected=null;state.mode='blocks'}
  else{state.selected=root().id;if(view.assetId)state.asset=view.assetId}
  render();$('#notebook').scrollTop=0;
}
function returnToWorkflow(){
  state.view=null;const previous=state.workflowSelection;
  state.selected=previous?.selected&&find(previous.selected)?previous.selected:root().children.find(c=>c.kind==='block')?.id;
  state.prompt=previous?.prompt&&find(previous.prompt)?previous.prompt:null;
  state.focus=previous?.focus&&find(previous.focus)?previous.focus:null;
  state.mode=previous?.mode||state.mode;state.workflowSelection=null;render();
}
function librarySource(){return state.view?.kind==='class'?'library-class':isLibraryBlockView()?'library-block':'workflow'}

renderTabs=function(){
  const source=librarySource();$('#text-editor').dataset.editorSource=source;$('#toggle-details').disabled=source==='library-class';
  let nameControl=$('#class-name-setting');
  if(!nameControl){$('.modebar').insertAdjacentHTML('afterbegin','<div id="class-name-setting" hidden><span>Name</span><input type="text" aria-label="Class name"></div>');nameControl=$('#class-name-setting')}
  nameControl.hidden=source!=='library-class';
  if(source==='library-class'){const cls=classById(state.view.classId);nameControl.querySelector('input').value=cls?.name||'';nameControl.querySelector('input').dataset.className=cls?.id||''}
  if(source==='workflow'){libraryBaseTabs();return}
  const cls=source==='library-class'?classById(state.view.classId):null;
  const label=cls?.name||node().name;
  $('#node-tabs').innerHTML=`<div class="library-source-tab"><span class="source-kind">LIBRARY ${cls?'CLASS':'BLOCK'}</span><span class="source-name" title="${esc(label)}">${esc(label)}</span>${state.view.classId&&state.view.kind==='block'?`<button data-open-class="${state.view.classId}" title="返回 Class">↩ Class</button>`:''}<button data-return-workflow title="返回 workflow">↩ Workflow</button></div>`;
  $('#overflow').hidden=true;
  document.querySelectorAll('[data-mode]').forEach(b=>{b.classList.toggle('active',b.dataset.mode===state.mode);b.setAttribute('aria-pressed',String(b.dataset.mode===state.mode))});
};
fitTabs=function(){if(librarySource()==='workflow')libraryBaseFitTabs();else{$('#overflow').hidden=true;$('.workspace').classList.toggle('narrow-editor',$('.workspace').clientWidth<360)}};

function libraryClassEntries(){
  const entries=new Map();
  function collect(item,folder){
    if(item.kind==='class'&&item.classRef)return;
    const ownFolder=item.folder||folder;
    if(item.kind==='class'&&!entries.has(item.id))entries.set(item.id,{cls:item,folder:ownFolder});
    for(const child of item.children||[])collect(child,ownFolder);
  }
  for(const cls of state.classes)collect(cls,cls.folder||(cls.id==='Environment'?'scene':'characters'));
  return [...entries.values()];
}

const libraryBaseAssetBy=assetBy;
assetBy=function(id){
  if(id?.startsWith('class-block:')){
    const [,classId,blockId]=id.split(':'),cls=classById(classId),block=cls?.children.find(c=>c.id===blockId&&c.kind==='block');
    return block?{id,name:block.name,block}:null;
  }
  if(id?.startsWith('asset-block:')){
    const [,assetId,blockId]=id.split(':'),asset=state.assets.find(a=>a.id===assetId),block=asset?find(blockId,asset.block)?.item:null;
    return block?{id,name:block.name,block}:null;
  }
  return libraryBaseAssetBy(id);
};
function libraryBlockRow(asset,block=asset.block,owner=null){
  const name=block.id===asset.block.id?asset.name:block.name;
  const target=owner?`data-open-block-attribute="${block.id}" data-class-owner="${owner.id}"`:`data-asset="${asset.id}" data-library-block-id="${block.id}"`;
  const active=isLibraryBlockView()&&root().id===block.id,instance=block.className?' · class instance':'';
  const dragId=owner?`class-block:${owner.id}:${block.id}`:block.id!==asset.block.id?`asset-block:${asset.id}:${block.id}`:asset.id;
  return `<div class="asset library-tree-block ${active?'active':''}"><span class="asset-icon">▤</span><button class="asset-label" ${target} title="${esc(name+instance)}">${esc(name||'未命名 block')}</button><button class="tiny-button" ${target} title="编辑 block" aria-label="编辑 ${esc(name)}">⚙</button><button draggable="false" class="library-handle" data-library-drag="${dragId}" data-kind="asset" title="作为 block 拖入" aria-label="作为 block 拖入 ${esc(name)}">▣</button><button draggable="false" class="library-handle" data-library-drag="${dragId}" data-kind="prompts" title="仅拖入 prompts" aria-label="仅拖入 prompts ${esc(name)}">≡</button></div>`;
}
function libraryBlockEntries(){
  const entries=new Map();
  function add(asset,block,folder,owner=null){
    const id=block._assignedSource||block.id;
    if(!entries.has(id))entries.set(id,{asset,block,folder:block.folder||folder,owner,name:block.id===asset.block.id?asset.name:block.name});
  }
  for(const asset of state.assets){
    add(asset,asset.block,asset.folder);
    for(const block of walk(asset.block).slice(1).filter(b=>b.kind==='block'&&b.className))add(asset,block,asset.folder);
  }
  for(const {cls,folder} of libraryClassEntries())for(const block of cls.children.filter(c=>c.kind==='block')){
    const source=block._assignedSource||block.id;
    const asset=state.assets.find(a=>walk(a.block).some(b=>b.kind==='block'&&b.id===source));
    if(asset)add(asset,find(source,asset.block).item,asset.folder);
    else add({name:block.name,block},block,folder,cls);
  }
  return [...entries.values()];
}
renderLibrary=function(){
  const query=$('#search').value.toLowerCase(),sort=$('#sort').value;
  for(const {cls} of libraryClassEntries())state.folders['class:'+cls.id]??=true;
  const matches=block=>[block.name,...walk(block).map(c=>c.name||c.text)].join(' ').toLowerCase().includes(query);
  const ordered=items=>sort==='name'?[...items].sort((a,b)=>(a.name||'').localeCompare(b.name||'')):items;
  const catalog=libraryBlockEntries(),classCatalog=libraryClassEntries();
  const classTree=cls=>{
    const owned=ordered(catalog.filter(entry=>entry.block.className===cls.name));
    const matched=cls.name.toLowerCase().includes(query),whole=matched||!query;
    const ownedRows=owned.filter(entry=>whole||matches(entry.block)||entry.name.toLowerCase().includes(query)).map(entry=>libraryBlockRow(entry.asset,entry.block,entry.owner)).join('');
    if(query&&!matched&&!ownedRows)return '';
    const key='class:'+cls.id,open=!!query||state.folders[key];
    return `<div class="library-class-branch" data-library-class="${cls.id}"><div class="asset library-class-row ${state.view?.kind==='class'&&state.view.classId===cls.id?'active':''}"><button class="library-class-fold" data-folder="${key}" aria-expanded="${open}" aria-label="${open?'折叠':'展开'} ${esc(cls.name)}">${open?'▾':'▸'}</button><span class="asset-icon">▱</span><button class="asset-label" data-open-class="${cls.id}" title="${esc(cls.name)}">${esc(cls.name)}</button><button class="tiny-button" data-open-class="${cls.id}" title="编辑 Class" aria-label="编辑 ${esc(cls.name)}">⚙</button></div><div class="library-class-children" aria-label="${esc(cls.name)} class instance" ${open?'':'hidden'}>${ownedRows}</div></div>`;
  };
  $('#assets').innerHTML=[['characters','人物 / Characters'],['scene','场景与光线 / Scenes']].map(([folder,name])=>{
    const classes=ordered(classCatalog.filter(entry=>entry.folder===folder).map(entry=>entry.cls));
    const blocks=ordered(catalog.filter(entry=>entry.folder===folder&&!classCatalog.some(({cls})=>cls.name===entry.block.className)));
    const classRows=classes.map(c=>classTree(c)).join(''),blockRows=blocks.filter(entry=>matches(entry.block)||entry.name.toLowerCase().includes(query)).map(entry=>libraryBlockRow(entry.asset,entry.block,entry.owner)).join('');
    if(query&&!classRows&&!blockRows)return '';
    return `<button class="folder-label" data-folder="${folder}" aria-expanded="${state.folders[folder]}">${state.folders[folder]?'▾':'▸'} ▱ ${name}<small>${classes.length+blocks.length}</small></button><div ${state.folders[folder]||query?'':'hidden'}>${classRows}${blockRows}</div>`;
  }).join('')||'<p class="setting-help">没有匹配的内容</p>';
  const asset=assetBy(state.asset),preview=$('#asset-preview');preview.hidden=librarySource()!=='workflow'||!asset;
  if(asset)preview.innerHTML=`<div class="eyebrow">BLOCK PREVIEW</div><h3>${esc(asset.name)}</h3><p>${esc(join(leaves(asset.block).map(text)))}</p><button class="outline-button" data-insert-asset="${asset.id}" style="width:100%;margin-top:8px">＋ 插入到选中 block 下方</button>`;
};

function attributeDeleteButton(cls,attr){return `<button class="tiny-button attribute-delete" data-remove-attribute="${attr.id}" data-class-owner="${cls.id}" title="删除 attribute" aria-label="删除 ${esc(attr.name||attr.text)}">×</button>`}
function classSection(title,body,kind){return XYZPLv4Design.classSection(title,body,kind)}

function renderClassPage(){
  const cls=classById(state.view.classId);if(!cls){returnToWorkflow();return}
  $('#monaco-root').hidden=true;$('#notebook').hidden=false;$('#breadcrumb').hidden=true;
  $('#notebook').innerHTML=XYZPLv4Design.classPageHTML(cls,state.classes.flatMap(walk).filter(c=>c.kind==='class'),esc);
}
renderNotebook=function(){if(state.view?.kind==='class')renderClassPage();else libraryBaseNotebook()};
renderInspector=function(){
  if(state.view?.kind==='class'){$('#inspector').hidden=true;$('#layout').classList.add('no-panel');updateWindowPanes();return}
  libraryBaseInspector();
};
openBlockMenu=function(id,button){
  libraryBaseMenu(id,button);
  if(isLibraryBlockView()&&id===root().id){$('#context [data-delete]').dataset.deleteLibraryRoot='true'}
};


function renameClass(id,name){
  const cls=classById(id),old=cls.name;cls.name=name;
  for(const b of [...state.nodes.flatMap(n=>walk(n.root)),...state.assets.flatMap(a=>walk(a.block)),...state.classes.flatMap(walk)].filter(n=>n.kind==='block')){
    if(b.className===old)b.className=name;
    if(b.loadedClasses)b.loadedClasses=b.loadedClasses.map(c=>c===old?name:c);
  }
}
function addClassAttribute(kind){
  const cls=classById(state.view.classId);
  if(kind==='prompt'){commit(()=>cls.children.push(P('new prompt')));return}
  if(kind==='block'){const block=B('新 block');commit(()=>cls.children.push(block));libraryNavigate({kind:'block',classId:cls.id,attributeId:block.id});return}
  const choices=libraryClassEntries().map(entry=>entry.cls).filter(c=>!classReaches(c,cls.id));
  openModal('添加 Class attribute','','添加',()=>{const selectedId=$('#attribute-class-choice').value,target=classById(selectedId);if(!target)return;commit(()=>cls.children.push({id:uid(),kind:'class',classRef:target.id,name:target.name,children:[]}))});
  $('#modal .modal-actions').insertAdjacentHTML('beforebegin',`<select id="attribute-class-choice" aria-label="Class attribute">${choices.map(c=>`<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>`);
}
function classReaches(cls,id,seen=new Set()){
  if(cls.id===id)return true;if(seen.has(cls.id))return false;seen.add(cls.id);
  return cls.children.filter(c=>c.kind==='class').some(c=>{const target=c.classRef?classById(c.classRef):c;return target&&classReaches(target,id,seen)});
}

document.addEventListener('click',async e=>{
  const t=e.target.closest('button');if(!t)return;
  const navigation=t.dataset.asset||t.dataset.openClass||t.dataset.openBlockAttribute||t.hasAttribute('data-return-workflow');
  const local=t.dataset.removeAttribute||t.dataset.addAttribute||t.dataset.deleteLibraryRoot;
  if(!navigation&&!local)return;e.preventDefault();e.stopImmediatePropagation();
  if(state.mode==='syntax'&&window.prototypeFlush&&!await prototypeFlush())return;
  if(t.hasAttribute('data-return-workflow'))returnToWorkflow();
  else if(t.dataset.asset)libraryNavigate({kind:'block',assetId:t.dataset.asset,blockId:t.dataset.libraryBlockId||null});
  else if(t.dataset.openClass)libraryNavigate({kind:'class',classId:t.dataset.openClass});
  else if(t.dataset.openBlockAttribute)libraryNavigate({kind:'block',classId:t.dataset.classOwner,attributeId:t.dataset.openBlockAttribute});
  else if(t.dataset.removeAttribute)commit(()=>{const cls=classById(t.dataset.classOwner);cls.children.splice(cls.children.findIndex(c=>c.id===t.dataset.removeAttribute),1)});
  else if(t.dataset.addAttribute)addClassAttribute(t.dataset.addAttribute);

  else if(t.dataset.deleteLibraryRoot)commit(()=>{
    const v=state.view;
    if(v.assetId){const asset=assetBy(v.assetId);if(!v.blockId||v.blockId===asset.block.id)state.assets.splice(state.assets.indexOf(asset),1);else{const f=find(v.blockId,asset.block);f.parent.children.splice(f.parent.children.indexOf(f.item),1)}}
    else{const cls=classById(v.classId),f=find(v.attributeId,cls);f.parent.children.splice(f.parent.children.indexOf(f.item),1)}
    state.view=v.classId?{kind:'class',classId:v.classId}:null;state.selected=v.classId?null:root().children.find(c=>c.kind==='block')?.id;state.prompt=null;if(v.classId)state.mode='blocks';
  });
},true);

document.addEventListener('change',e=>{
  const t=e.target;
  if(t.dataset.className){const name=t.value.trim();if(name)commit(()=>renameClass(t.dataset.className,name));return}
  if(t.dataset.blockName){
    const block=find(t.dataset.blockName)?.item;if(!block)return;
    commit(()=>{block.name=t.value.trim();if(isLibraryBlockView()&&state.view.assetId){const asset=assetBy(state.view.assetId);if(asset.block.id===block.id)asset.name=block.name}});return;
  }
  const id=t.dataset.attributeText||t.dataset.attributeWeight;if(!id)return;
  const attr=classById(t.dataset.classOwner).children.find(c=>c.id===id);if(!attr)return;
  commit(()=>{if(t.dataset.attributeText)attr.text=t.value;else attr.weight=Math.max(0,Number(t.value)||0)});
});

if(state.view?.kind==='block'&&!libraryBlockRef()||state.view?.kind==='class'&&!classById(state.view.classId))state.view=null;
render();
