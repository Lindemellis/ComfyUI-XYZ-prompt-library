import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
class Node {
  constructor(tag) { this.tagName=tag; this.children=[]; this.dataset={}; this.style={}; this.className=''; this.classList={add:()=>{},toggle:()=>{}}; }
  get childNodes() { return this.children; }
  append(...nodes) { for(const n of nodes) { n.parentElement=this; this.children.push(n); } }
  replaceChildren(...nodes) { this.text=''; this.children=[]; this.append(...nodes); }
  get textContent() { return this.text || this.children.map(n=>n.textContent).join(''); }
  set textContent(v) { this.text=v; this.children=[]; }
  setAttribute(key,value) { this[key]=value; }
  removeAttribute(key) { delete this[key]; }
  addEventListener() {}
  remove() { if(this.parentElement) this.parentElement.children=this.parentElement.children.filter(n=>n!==this); }
  get isConnected() { return true; }
  get offsetWidth() { return 220; }
  get offsetHeight() { return 140; }
  getBoundingClientRect() { return {right:100,top:20}; }
  querySelector(kind) { return this.querySelectorAll(kind)[0]; }
  querySelectorAll(kind) { const result=[]; const visit=n=>{for(const c of n.children){if(c.tagName===kind||kind.startsWith('.')&&c.className.split(' ').includes(kind.slice(1))) result.push(c);visit(c);}};visit(this);return result; }
}
globalThis.document={createElement:tag=>new Node(tag),body:new Node('body')};
globalThis.innerWidth=1200;globalThis.innerHeight=800;
const deps=`
const element=(tag,cls='',text='')=>{const n=document.createElement(tag);n.className=cls;if(text)n.textContent=text;return n;};
const button=(text,title,action,cls='')=>{const n=element('button',cls,text);n.title=title;n.onclick=()=>action({currentTarget:n});return n;};
const input=(value,action,options={})=>{const n=element('input');n.value=value;n.type=options.type||'text';n.onchange=()=>action(n.value);return n;};
const check=(value,action)=>{const n=element('input');n.type='checkbox';n.checked=value;n.onchange=()=>action(n.checked);return n;};
const libraryRequest=(...args)=>globalThis.libraryMock(...args);
const report=e=>{throw e;}; const showForm=(...args)=>globalThis.formMock(...args);
const {cleanPromptInput}=globalThis.promptInputHelpers;
const {compactFolders}=globalThis.folderTreeHelpers;
const menu=(anchor,items)=>{globalThis.libraryMenu=items;};
`;
globalThis.promptInputHelpers=await import('data:text/javascript;base64,'+Buffer.from(await readFile(new URL('../../js/plv4/prompt_text.js',import.meta.url),'utf8')).toString('base64'));
globalThis.folderTreeHelpers=await import('data:text/javascript;base64,'+Buffer.from(await readFile(new URL('../../js/plv4/folder_tree.js',import.meta.url),'utf8')).toString('base64'));
async function module(path,extra=''){
 let source=(await readFile(new URL(path,import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
 if(path.endsWith('design_adapter.js')) source=source.replace("new URL('./design.css', import.meta.url)",JSON.stringify(new URL('../../js/plv4/design.css',import.meta.url).href));
 return import('data:text/javascript;base64,'+Buffer.from(deps+extra+source+'\n//# sourceURL='+path).toString('base64'));
}
const {LibraryPreview,previewTags,assetPreview}=await module('../../js/plv4/library_preview.js');
globalThis.libraryPreviewClass=LibraryPreview;
globalThis.dropHelpers=await module('../../js/plv4/drop_preview.js');
const {LibraryPanel}=await module('../../js/plv4/library_panel.js','const LibraryPreview=globalThis.libraryPreviewClass; const {DropPreview,dropLocation}=globalThis.dropHelpers;\n');
const {FolderPage}=await module('../../js/plv4/folder_page.js');
function panel(){const value=Object.create(LibraryPanel.prototype);Object.assign(value,{data:{assets:[]},tree:new Node('div'),collapsed:new Set(),query:'',sort:'name',host:{context:null,folderContext:null},contexts:new Map()});return value;}

test('Library tree hides loose tags and preserves nested blocks, previews and two insertion handles',()=>{
 const p=panel();p.data.assets=[{id:'P',kind:'folder',name:'Pool',parent_id:null},{id:'T',kind:'tag',name:'tag',parent_id:'P'},{id:'B',kind:'block',name:'Combo',parent_id:'P'},{id:'B/i4',kind:'block',name:'Child',parent_id:'B'}];
 p.renderTree(); assert.deepEqual(p.tree.children.map(n=>n.dataset.kind),['folder','block','block']);
 for(const row of p.tree.children.filter(n=>n.dataset.kind==='block')) assert.deepEqual(row.children.filter(n=>n.dataset.insertMode).map(n=>n.dataset.insertMode),['block','prompts']);
 assert.deepEqual(p.tree.children.map(n=>n.dataset.depth),[0,1,2]);
 assert.deepEqual(p.tree.children.map(n=>n.querySelector('.tree-guides')?.children.length||0),[0,1,2]);
 const folderRow=p.tree.children.find(n=>n.dataset.kind==='folder');
 const folderHandle=folderRow.children.find(n=>n.dataset.insertMode==='folder');
 assert.equal(folderHandle.textContent,'▣');assert.equal(folderHandle.className,'library-handle');
 assert.equal(folderRow.querySelector('.plv4-library-name').onpointerdown,undefined);
 const drags=[];p.startInsertDrag=(...args)=>drags.push(args);
 const event={button:0};folderHandle.onpointerdown(event);
 assert.deepEqual(drags,[[event,p.data.assets[0],false,folderHandle]]);
 assert.ok(p.tree.children.every(n=>n.children.some(n=>n.title==='预览 tag')));
 assert.ok(p.tree.children.every(n=>!n.children.some(n=>n.title==='编辑内容和设置'||n.textContent==='⚙')));
 p.query='tag';p.renderTree();assert.deepEqual(p.tree.children.map(n=>n.dataset.assetId),['P']);
});

test('Library rows open on click or keyboard, while tools and completed drags stay separate',async()=>{
 const p=panel();const asset={id:'P',kind:'folder',name:'Pool'};p.data.assets=[asset];
 const opened=[];p.openAsset=async (item,permanent=false)=>opened.push([item.id,permanent]);p.renderTree();const row=p.tree.children[0];
 await row.onclick({target:row});
 row.onclick({target:{closest:()=>({tagName:'button'})}});
 row.onclick({defaultPrevented:true,target:row});
 let prevented=false;await row.onkeydown({target:row,key:'Enter',preventDefault(){prevented=true;}});
 await row.ondblclick({target:row});
 assert.deepEqual(opened,[['P',false],['P',false],['P',true]]);assert.ok(prevented);assert.equal(row.role,'treeitem');
});

test('Library compacts empty single-child Folders while retaining real identities and tools',async()=>{
 const p=panel();p.data.assets=[
  {id:'A',kind:'folder',name:'人物',parent_id:null},
  {id:'B',kind:'folder',name:'旅行者',parent_id:'A'},
  {id:'C',kind:'folder',name:'光照',parent_id:'B'},
  {id:'T',kind:'tag',name:'sunlight',parent_id:'C'},
  {id:'D',kind:'block',name:'Combo',parent_id:'C'}];
 const original=structuredClone(p.data.assets),opened=[],drags=[];
 p.openAsset=async(asset,permanent=false)=>opened.push([asset.id,permanent]);p.startInsertDrag=(...args)=>drags.push(args);
 p.renderTree();const row=p.tree.children[0];
 assert.deepEqual(p.tree.children.map(n=>n.dataset.assetId),['C','D']);
 assert.equal(row.querySelector('.plv4-library-name').textContent,'人物 / 旅行者 / 光照');
 assert.deepEqual(JSON.parse(row.dataset.folderChain),['A','B','C']);assert.equal(row.title,'第 1–3 层 · 人物.旅行者.光照');
 assert.equal(p.tree.children[1].dataset.depth,1);assert.equal(p.tree.children[1].dataset.actualDepth,3);
 const segments=row.querySelectorAll('.compact-folder-segment');
 await row.onclick({target:segments[0]});await row.ondblclick({target:segments[1]});
 await row.onkeydown({target:segments[2],key:'Enter',preventDefault(){}});
 assert.deepEqual(opened,[['A',false],['B',true],['C',false]]);
 let context;p.assetMenu=asset=>{context=asset.id;return [];};row.oncontextmenu({target:segments[0],preventDefault(){},clientX:0,clientY:0});assert.equal(context,'A');
 const handle=row.children.find(n=>n.dataset.insertMode==='folder');handle.onpointerdown({button:0});assert.equal(drags[0][1].id,'C');
 assert.ok(row.children.some(n=>n.title==='预览 tag'));
 p.host.folderContext='A';p.renderTree();assert.equal(p.tree.children[0],row,'opening an intermediate Folder keeps the same label DOM');
 assert.deepEqual(p.data.assets,original,'compaction never changes stored parents or paths');
});

test('Compact Library folding honors hidden ancestor state and search still finds intermediate names',async()=>{
 const p=panel();p.data.assets=[{id:'A',kind:'folder',name:'Parent'},{id:'B',kind:'folder',name:'Child',parent_id:'A'},{id:'D',kind:'block',name:'Combo',parent_id:'B'}];
 p.collapsed.add('A');p.renderTree();assert.deepEqual(p.tree.children.map(n=>n.dataset.assetId),['B']);
 await p.tree.children[0].children.find(n=>n.title==='展开 / 折叠').onclick();assert.deepEqual(p.tree.children.map(n=>n.dataset.assetId),['B','D']);
 p.query='parent';p.renderTree();assert.equal(p.tree.children[0].querySelector('.plv4-library-name').textContent,'Parent / Child');
 assert.deepEqual(p.tree.children.map(n=>n.dataset.assetId),['B','D']);
});

test('Hidden loose tags, saved blocks and multiple child Folders stop Library compaction',()=>{
 const p=panel();const base=[{id:'A',kind:'folder',name:'A'},{id:'B',kind:'folder',name:'B',parent_id:'A'},{id:'C',kind:'folder',name:'C',parent_id:'B'}];
 for(const extra of [{id:'T',kind:'tag',name:'hidden',parent_id:'A'},{id:'D',kind:'block',name:'saved',parent_id:'A'},{id:'F',kind:'folder',name:'branch',parent_id:'A'}]){
  p.data.assets=[...base,extra];p.renderTree();assert.equal(p.tree.children[0].dataset.assetId,'A');assert.equal(p.tree.children[0].querySelector('.plv4-library-name').textContent,'A');
  assert.equal(p.tree.children[1].querySelector('.plv4-library-name').textContent,'B / C');
 }
});

test('Folder handle drops a new pool-bound block at the command position without rebinding its parent',async t=>{
 const p=panel(),asset={id:'P',kind:'folder',name:'Pool'};p.data.assets=[asset];p.renderTree();
 const handle=p.tree.children[0].children.find(n=>n.dataset.insertMode==='folder');
 const parent={id:'existing',meta:{name:'Existing',pool:'old'}},commands=[],requests=[],listeners=new Map();
 const previousDocument=globalThis.document,previousFrame=globalThis.requestAnimationFrame,previousCancel=globalThis.cancelAnimationFrame;
 globalThis.document={...previousDocument,addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:(key,fn)=>{if(listeners.get(key)===fn)listeners.delete(key);}};
 globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};
 t.after(()=>{globalThis.document=previousDocument;globalThis.requestAnimationFrame=previousFrame;globalThis.cancelAnimationFrame=previousCancel;});
 const snapshot={kind:'group',form:'brace',enabled:true,meta:{name:'Pool',pool:'P'},children:[]};
 globalThis.libraryMock=async(action,body)=>{requests.push([action,body]);return {snapshot,source:{id:'P',kind:'folder'}};};
 Object.assign(p.host,{context:{session:{view:'block',revision:7}},flushEditor:async()=>{},blocks:{hidden:true},blockView:{clearDrop(){},showDrop:()=>({dataset:{}})},
   libraryDropTarget:()=>({parent,command:{parent_id:'existing',edge:'end'},placement:'inside'}),entryTarget:async()=>null,command:async(...args)=>commands.push(args)});
 handle.onpointerdown({button:0,clientX:0,clientY:0,preventDefault(){},stopPropagation(){}});
 listeners.get('pointermove')({clientX:20,clientY:20});
 await listeners.get('pointerup')({clientX:20,clientY:20});
 assert.deepEqual(requests,[['folder_block',{id:'P'}]]);
 assert.equal(commands.length,1);assert.equal(commands[0][0].type,'InsertLibraryBlock');assert.equal(commands[0][1],7);
 assert.equal(commands[0][0].parent_id,'existing');assert.equal(commands[0][0].edge,'end');
 assert.equal(commands[0][0].snapshot.meta.pool,'P');assert.deepEqual(commands[0][0].snapshot.children,[]);
 assert.equal(parent.meta.pool,'old');assert.equal(listeners.size,0);
});

test('Folder and block menus expose the new contained model; Folder opens a pool page',async()=>{
 const p=panel();const folder={id:'P',kind:'folder'};const block={id:'B',kind:'block'};
 assert.deepEqual(p.assetMenu(folder).map(([name])=>name),['打开','重命名','添加 subfolder','添加 Block','添加 tag','移动','Delete']);
 assert.deepEqual(p.assetMenu(block).map(([name])=>name),['打开','重命名','添加 subblock','移动','Delete']);
 let opened;p.host.openFolder=async id=>opened=id;await p.openAsset(folder);assert.equal(opened,'P');
});

test('Library refresh retains row and label DOM so opening an item does not break its double click',()=>{
 const p=panel();p.data.assets=[{id:'P',kind:'folder',name:'Pool',version:1}];p.renderTree();
 const row=p.tree.children[0],label=row.querySelector('.plv4-library-name');
 p.host.folderContext='P';p.data.revision=2;p.renderTree();
 assert.equal(p.tree.children[0],row);assert.equal(row.querySelector('.plv4-library-name'),label);
 p.data.assets[0]={...p.data.assets[0],name:'Renamed',version:2};p.renderTree();assert.notEqual(p.tree.children[0],row);
});

test('Moving a block sends both source and destination versions in the existing menu flow',async()=>{
 const p=panel();p.reload=async()=>{};p.data.assets=[{id:'B',kind:'block',version:2,name:'From'},{id:'D',kind:'block',version:7,name:'To'}];
 const requests=[];globalThis.libraryMock=async(action,body)=>{requests.push({action,body});return p.data.assets.find(a=>a.id===body.id);};
 globalThis.formMock=async()=>({parent:'D'});
 await p.organize(p.data.assets[0],'move');assert.deepEqual(requests.at(-1),{action:'move',body:{id:'B',version:2,parent_id:'D',parent_version:7}});
});

test('Folder page recursively edits child folders tags in their original folder and toggles completion without copying data',async()=>{
 const asset={id:'P',kind:'folder',name:'Pool',version:1,data:{autocomplete:false}};
 const assets=[asset,{id:'T',kind:'tag',name:'a',parent_id:'P',version:1},{id:'B',kind:'block',name:'Combo',parent_id:'P'},{id:'C',kind:'folder',name:'Child',parent_id:'P'},{id:'DEEP',kind:'tag',name:'deep',parent_id:'C',version:3},{id:'G',kind:'folder',name:'Grandchild',parent_id:'C'},{id:'GT',kind:'tag',name:'grandchild tag',parent_id:'G',version:1},{id:'ELSE',kind:'tag',name:'elsewhere',parent_id:'OTHER'}];
 const requests=[];globalThis.libraryMock=async(action,body)=>{requests.push({action,body});if(action==='save_folder'){Object.assign(asset,{name:body.name,data:body.data,version:asset.version+1});return{asset:structuredClone(asset)};}return structuredClone(asset);};
 const pinned=[];const host={folderNameControl:new Node('div'),folderContext:'P',pinLibraryTab:key=>pinned.push(key),renderTabs(){},library:{data:{assets},reload:async()=>{},create(){},openAsset(){}}};
 const page=new FolderPage(new Node('div'),host);await page.open('P');
 assert.equal(page.container.querySelectorAll('.section-title').length,0);
 assert.equal(page.container.textContent.includes('Combo'),false);
 assert.equal(page.container.textContent.includes('保存的 block'),false);
 const branches=page.container.querySelectorAll('details');assert.deepEqual(branches.map(n=>n.dataset.folderId),['C','G']);
 assert.deepEqual(branches.map(n=>n.dataset.depth),[1,2]);
 assert.deepEqual(page.container.querySelectorAll('.folder-local-tags').map(n=>n.dataset.folderId),['P','C','G']);
 branches[0].open=false;branches[0].ontoggle();page.render();
 assert.equal(page.container.querySelectorAll('details')[0].open,false,'collapse survives rerender');
 assert.deepEqual(page.container.querySelectorAll('input').map(n=>n.value),['a','deep','grandchild tag']);
 const control=host.folderNameControl.children.find(n=>n.type==='checkbox');control.checked=true;await control.onchange();
 assert.equal(asset.data.autocomplete,true);assert.equal(requests.filter(r=>r.action==='save_folder').length,1);assert.ok(!requests.some(r=>r.action==='save_tag'||r.action==='save_block'));
 const childInput=page.container.querySelectorAll('input').find(n=>n.value==='deep');childInput.value=' solo， blonde hair， ';await childInput.onchange();
 assert.deepEqual(requests.find(r=>r.action==='save_tag').body,{id:'DEEP',version:3,parent_id:'C',text:'solo, blonde hair'});
 assert.equal(page.container.querySelectorAll('details')[0].open,false,'collapse survives an edit and data reload');
 assert.deepEqual(pinned,['folder:P','folder:P'],'both Folder options and nested tag edits make the preview permanent');
});

test('Folder previews recurse through folders and saved blocks, including parked atomic attention tags',async()=>{
 const atom=raw=>({kind:'text',raw,enabled:true});
 const weighted={kind:'group',form:'paren',open:'(',close:':1.2)',children:[atom('weighted')],enabled:true};
 const block={kind:'group',form:'brace',enabled:false,children:[weighted,{kind:'group',form:'brace',children:[atom('deep')]}]};
 assert.deepEqual(previewTags(block).map(n=>[n.text,n.enabled]),[['(weighted:1.2)',false],['deep',false]]);
 globalThis.libraryMock=async()=>({candidates:[{kind:'folder',name:'Pool',children:[{kind:'tag',snapshot:atom('loose')},{kind:'folder',name:'Child',children:[{kind:'block',name:'Combo',snapshot:block}]}]}]});
 assert.deepEqual((await assetPreview({kind:'folder',id:'P'})).map(n=>[n.text,n.enabled]),[['loose',true],['(weighted:1.2)',false],['deep',false]]);
});

test('Preview icon hover, focus and click share one request and display the fetched content',async()=>{
 let resolve;let reads=0;globalThis.libraryMock=()=>{reads++;return new Promise(r=>resolve=r);};
 const p=panel();p.data.assets=[{id:'B',kind:'block',name:'Combo'}];p.renderTree();
 const icon=p.tree.children[0].children.find(n=>n.title==='预览 tag');
 const pending=icon.onpointerenter();const popup=p.preview.popup;
 icon.onfocus();icon.onclick();assert.equal(reads,1);assert.equal(p.preview.popup,popup);
 resolve({snapshot:{kind:'text',raw:'blue eyes'}});await pending;
 assert.ok(popup.textContent.includes('blue eyes'));assert.equal(popup.style.left,'108px');
 assert.equal(icon['aria-describedby'],popup.id);p.preview.close();assert.equal(icon['aria-describedby'],undefined);
});

test('Large Folder previews flow as compact text without repeated paths or per-tag rows',async()=>{
 const raw=text=>({kind:'text',raw:text});const texts=Array.from({length:200},(_,i)=>`tag${i}`);
 globalThis.libraryMock=async()=>({candidates:[{kind:'folder',name:'验收示例.01-人物.人物.旅行者.光照',children:[
  ...texts.map(text=>({kind:'tag',snapshot:raw(text)})),
  {kind:'folder',name:'Nested',children:[{kind:'block',name:'Combo',snapshot:{kind:'group',enabled:false,children:[raw('parked')]}}]},
  {kind:'tag',snapshot:raw('A sentence.')},{kind:'tag',snapshot:raw('tail')},
 ]}]});
 const preview=new LibraryPreview();await preview.show(new Node('button'),{kind:'folder',id:'P',name:'Pool'});
 const list=preview.popup.querySelector('.preview-tags');
 assert.equal(list.textContent,texts.join(', ')+', parked, A sentence. tail');
 assert.ok(list.children.every(n=>n.tagName==='span'),'prompts share one text flow');
 assert.equal(list.querySelectorAll('small').length,0);
 assert.ok(!preview.popup.textContent.includes('验收示例.01-人物'));
 assert.equal(preview.popup.querySelector('.preview-count').textContent,'203 条 · 1 已关闭');
 assert.equal(list.querySelector('.parked').title,'已关闭');preview.close();
});

test('Mounted styles position the body-level preview and center all Library icon buttons',async()=>{
 const savedFetch=globalThis.fetch;
 globalThis.fetch=async url=>({ok:true,text:()=>readFile(new URL(url),'utf8')});
 try {
  const {mountDesign}=await module('../../js/plv4/design_adapter.js');const style=new Node('style');await mountDesign(style);
  assert.match(style.textContent,/:scope\.library-tag-preview\s*\{[^}]*position:fixed;[^}]*z-index:1500/);
  assert.match(style.textContent,/:scope\.library-tag-preview strong/);
  assert.match(style.textContent,/\.plv4-library-row>button\{[^}]*align-items:center;[^}]*height:24px/);
 } finally {globalThis.fetch=savedFetch;}
});

test('Leaving the preview while its request is pending cannot reopen stale content',async()=>{
 let resolve;globalThis.libraryMock=()=>new Promise(r=>resolve=r);
 const preview=new LibraryPreview();const anchor=new Node('button');
 const pending=preview.show(anchor,{kind:'block',id:'B',name:'Combo'});preview.close();
 resolve({snapshot:{kind:'text',raw:'stale'}});await pending;
 assert.equal(preview.popup,null);assert.equal(anchor['aria-expanded'],'false');
});

test('Pool completion calculates tags inside parked blocks and strips structural prompt shells', async () => {
  globalThis.window={addEventListener(){}};
  const completionSource=(await readFile(new URL('../../js/plv4/completion.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
  const {poolSuggestions}=await import('data:text/javascript;base64,'+Buffer.from(deps+completionSource+'\n//# sourceURL=plv4-completion-under-test.js').toString('base64'));
  const leaf=raw=>({kind:'text',raw,enabled:false});
  globalThis.libraryMock=async()=>({candidates:[{kind:'folder',name:'Parent',children:[{kind:'folder',name:'Child',children:[{kind:'block',name:'Combo',source:{kind:'block',id:'B'},snapshot:{kind:'group',form:'brace',enabled:false,children:[leaf('closed'),{kind:'group',form:'brace',meta:{presentation:'prompt'},open:'{',close:'}.set{schedule: [0.2, 0.8]}',children:[leaf('plain')]},{kind:'group',form:'paren',open:'(',close:':1.2)',children:[leaf('weighted')]}]}}]}]}]});
  const editor={__plv4Pane:{editSession:{valid:true}}};
  const suggestions=await poolSuggestions('',editor);
  assert.deepEqual(suggestions.map(n=>n.name),['closed','plain','(weighted:1.2)']);
  assert.ok(suggestions.every(n=>n.kind==='poolTag'));
});
