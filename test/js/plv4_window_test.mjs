import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Exercise the production window lifecycle without opening a browser. ComfyUI
// workflow undo replaces node objects, keeping their numeric IDs and tabs.
const source = (await readFile(new URL('../../js/plv4/window.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const dependencies = `const report = error => { throw error; };
const NODE_TYPES = new Set(['XYZ Prompt Library V4']);
const element = (tag, cls, text) => globalThis.tabElement ? globalThis.tabElement(tag, cls, text) : ({ tag, className: cls, textContent: text });
const button = (text, title, action, cls) => { const node=element('button',cls,text);node.onclick=action;return node; };\n`;
const { PLv4Window } = await import('data:text/javascript;base64,' + Buffer.from(dependencies + source + '\n//# sourceURL=plv4-window-under-test.js').toString('base64'));
const shortcutSource = await readFile(new URL('../../js/plv4/history_shortcuts.js', import.meta.url), 'utf8');
const { ownHistoryKey, installWorkflowUndoGuard } = await import('data:text/javascript;base64,' + Buffer.from(shortcutSource).toString('base64'));

test('an earlier ComfyUI capture listener cannot execute queued workflow undo for an editor key', async () => {
  let workflowUndos = 0, editorUndos = 0;
  class ChangeTracker {
    async undoRedo(event) { if (event.ctrlKey && event.key === 'z') { workflowUndos++; return true; } return false; }
  }
  installWorkflowUndoGuard(ChangeTracker);
  const tracker = new ChangeTracker();
  const event = { key: 'z', ctrlKey: true, defaultPrevented: false };
  // Same ordering as ChangeTracker.init in the installed ComfyUI: capture
  // queues an animation-frame callback before PLv4 owns/prevents the key.
  const frame = () => tracker.undoRedo(event);
  ownHistoryKey(event); event.defaultPrevented = true; editorUndos++;
  await frame();
  assert.equal(editorUndos, 1);
  assert.equal(workflowUndos, 0, 'preventing propagation later must also suppress the queued workflow action');
  await tracker.undoRedo({ key: 'z', ctrlKey: true });
  assert.equal(workflowUndos, 1, 'keys outside the editor still use workflow history');
});

function fixture() {
  const node = { id: 17, comfyClass: 'XYZ Prompt Library V4', title: 'Prompt' };
  const graph = { _nodes: [node] }; node.graph = graph;
  const context = { node, session: { view: 'syntax', text: 'edited' }, folded: new Set(), focus: 'i2', scroll: 25 };
  const win = Object.create(PLv4Window.prototype);
  const container = () => ({ style: {}, children: ['editor content'], replaceChildren(...children) { this.children = children; } });
  Object.assign(win, { app: { graph }, context, seedNode: node, visible: true, generation: 0, libraryTabs: new Map(), closedNodes: new Set(),
    blocks: container(), syntax: container(), output: container(), status: {}, details: { render() {} },
    shell: { win: { hide() {} }, designReady: Promise.resolve() }, folderPage: { whenIdle: async () => {} }, folderContainer: container(),
    blockView: { closeEditor() {}, clearDrop() {} },
    flushEditor: async () => {},
    build() {},
    async detach() { this.context?.bindings?.clear(); },
    renderTabs() { this.labels = this.app.graph._nodes.map(n => n.title); },
    sessions: {
      contexts: new Map([[node, context]]),
      remove(node) { this.contexts.delete(node); },
      prune() { for (const n of this.contexts.keys()) if (!graph._nodes.includes(n)) this.remove(n); },
      async get(node) { if (this.contexts.has(node)) return this.contexts.get(node); const context = { node, session: { view: 'block', text: 'restored' }, folded: new Set(), scroll: 0 }; this.contexts.set(node, context); return context; },
    },
    async activate(context) { this.context = context; this.blocks.children = ['restored editor']; this.renderTabs(); },
  });
  return { win, node, graph, context };
}

test('Preview resolves a linked seed once without virtual widget callbacks recursively restarting compilation',async()=>{
  const load=code=>import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
  const {NodeSessions}=await load((await readFile(new URL('../../js/plv4/host_sessions.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,''));
  const {DocumentSession}=await load(await readFile(new URL('../../js/plv4/document_session.js',import.meta.url),'utf8'));
  const {win,node,context}=fixture();node.inputs=[{name:'seed',link:1}];node.widgets=[{name:'seed',value:42},{name:'region_mode',value:'couple'}];
  const compiled=[],pending=[];let reads=0,lint=0;
  context.session=new DocumentSession({state:{revision:0,text:'cat',valid:true,doc:{next_id:3,root:{id:'root'}}},projection:{tree:{},diagnostics:[]}},{request:async(operation,body)=>{
    assert.equal(operation,'compile');compiled.push(body);return {revision:body.state.revision,prompt:`cat ${body.seed}`,plain:'cat'};
  }});context.session.view='preview';
  win.output.append=(...nodes)=>win.output.children.push(...nodes);win.pane={scheduleLint(){lint++;}};
  win.app.registerExtension=extension=>{win.extension=extension;};
  // Installed ComfyUI graphToPrompt calls virtual applyToGraph, which propagates
  // the seed value and calls the destination widget callback even if unchanged.
  win.app.graphToPrompt=async()=>{
    if(++reads>6) throw new Error('recursive seed resolution');
    node.widgets[0].callback.call(node.widgets[0],node.widgets[0].value);
    return {output:{[node.id]:{inputs:{seed:node.widgets[0].value}}}};
  };
  win.sessions=new NodeSessions(win.app);
  const preview=win.preview.bind(win);win.preview=()=>{const task=preview();pending.push(task);return task;};
  const environment={app:win.app,PLv4Window:class{constructor(){return win;}},NODE_TYPES:new Set(['XYZ Prompt Library V4']),widget:(node,name)=>node.widgets.find(w=>w.name===name),window:{},report:error=>{throw error;}};
  globalThis.previewHookEnvironment=environment;
  const entry=(await readFile(new URL('../../js/plv4.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
  await load('const {app,PLv4Window,NODE_TYPES,widget,window,report}=globalThis.previewHookEnvironment;\n'+entry);
  win.extension.nodeCreated(node);
  await win.preview();for(let i=0;i<pending.length;i++) await pending[i];
  assert.equal(reads,1);assert.equal(compiled.length,1);assert.equal(lint,0);
  assert.ok(win.output.children.some(n=>n.textContent==='cat 42'));assert.equal(context.session.past.length,0);
  node.widgets[0].value=43;node.widgets[0].callback.call(node.widgets[0],43);
  for(let i=0;i<pending.length;i++) await pending[i];
  assert.equal(reads,2);assert.equal(compiled.length,2);assert.equal(lint,1,'actual user seed changes still refresh lint and Preview');
  assert.ok(win.output.children.some(n=>n.textContent==='cat 43'));
});

test('linked input readers share one graph resolution, clear the guard on failure, and can retry',async()=>{
  const host=(await readFile(new URL('../../js/plv4/host_sessions.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
  const {NodeSessions}=await import('data:text/javascript;base64,'+Buffer.from(host).toString('base64'));
  let release,reads=0;
  const sessions=new NodeSessions({graphToPrompt:async()=>{reads++;return new Promise(resolve=>{release=resolve;});}});
  const node={id:17,inputs:[{name:'seed',link:1}],widgets:[{name:'seed',value:7},{name:'region_mode',value:'mask'}]};
  const a=sessions.inputs(node),b=sessions.inputs(node);assert.equal(sessions.resolvingInputs,true);
  await Promise.resolve();assert.equal(reads,1);release({output:{17:{inputs:{seed:55}}}});
  assert.deepEqual(await Promise.all([a,b]),[{seed:55,region_mode:'mask'},{seed:55,region_mode:'mask'}]);assert.equal(sessions.resolvingInputs,false);
  sessions.app.graphToPrompt=async()=>{throw new Error('cannot resolve seed');};
  await assert.rejects(sessions.inputs(node),/cannot resolve seed/);assert.equal(sessions.resolvingInputs,false);
  sessions.app.graphToPrompt=async()=>({output:{17:{inputs:{seed:['upstream',0]}}}});
  await assert.rejects(sessions.inputs(node),/seed 由上游节点计算/);assert.equal(sessions.resolvingInputs,false);
  sessions.app.graphToPrompt=async()=>({output:{17:{inputs:{seed:99}}}});
  assert.deepEqual(await sessions.inputs(node),{seed:99,region_mode:'mask'});
});

test('Preview replaces its loading message with input/compile errors and permits a later successful preview',async()=>{
  const {win,context}=fixture();context.session.view='preview';context.session.revision=0;context.session.whenIdle=async()=>{};
  win.output.append=(...nodes)=>win.output.children.push(...nodes);
  win.inputs=async()=>{throw new Error('cannot resolve seed');};
  await win.preview();assert.equal(win.output.children[0].textContent,'cannot resolve seed');
  win.inputs=async()=>({seed:42,region_mode:'couple'});context.session.compile=async()=>{throw new Error('invalid draft');};
  await win.preview();assert.equal(win.output.children[0].textContent,'invalid draft');
  context.session.compile=async()=>({prompt:'cat',plain:'cat'});await win.preview();
  assert.ok(win.output.children.some(n=>n.textContent==='cat'));assert.ok(!win.output.children.some(n=>n.textContent==='正在编译…'));
});

test('opening a Library block resets source/focused views to the node Blocks editor with subblocks visible',async()=>{
 const win=Object.create(PLv4Window.prototype);
 const context={focus:'nested',folded:new Set(['nested']),savedRevision:4,session:{valid:true,revision:4,view:'syntax',state:{selection:{},doc:{root:{children:[{id:'i1'}]}}},setView(view){this.view=view;}}};
 const calls=[];Object.assign(win,{flushEditor:async()=>{},activate:async current=>{win.context=current;calls.push('activate');},locate:async id=>calls.push(id)});
 await win._openLibrary(context);
 assert.equal(win.context,context);assert.equal(context.session.view,'block');assert.equal(context.focus,null);assert.equal(context.folded.size,0);assert.deepEqual(calls,['activate','i1']);
});

function libraryContext(key) {
 return {key,asset:{id:key,name:key},name:key,focus:null,folded:new Set(),savedRevision:0,
  session:{valid:true,revision:0,view:'block',state:{selection:{},doc:{root:{children:[{id:'i1'}]}}},setView(view){this.view=view;}}};
}

test('Library browsing has one preview shared by folders and blocks, preserving permanent tabs',()=>{
 const {win,node}=fixture();const a=libraryContext('a'),b=libraryContext('b');
 win.registerLibraryTab({kind:'folder',id:'f',name:'f',labelName:'f'});
 win.registerLibraryTab({kind:'block',context:a});assert.deepEqual([...win.libraryTabs.keys()],['block:a']);
 win.pinLibraryTab('block:a');
 win.registerLibraryTab({kind:'folder',id:'g',name:'g',labelName:'g'});
 win.registerLibraryTab({kind:'block',context:b});
 assert.deepEqual([...win.libraryTabs.keys()],['block:a','block:b']);
 assert.equal(win.libraryTabs.get('block:a').preview,false);assert.equal(win.libraryTabs.get('block:b').preview,true);
 assert.ok(win.tabEntries().some(t=>t.node===node));
 win.registerLibraryTab({kind:'block',context:b},true);assert.ok(!win.libraryTabs.get('block:b').preview);
 win.registerLibraryTab({kind:'block',context:a});assert.ok(!win.libraryTabs.get('block:a').preview,'single click never demotes a permanent tab');
});

test('Block editing pins a preview but viewing and locating details keep it temporary',()=>{
 const {win}=fixture();const context=libraryContext('edited');win.context=context;
 win.registerLibraryTab({kind:'block',context});win.renderView=()=>{};
 win.shell.details={hidden:true};win.blocks.querySelectorAll=()=>[];
 win.changed('View');win.changed('LocateDetails');win.changed('SyncPool');
 assert.equal(win.libraryTabs.get('block:edited').preview,true);
 win.changed('ReplaceText');assert.equal(win.libraryTabs.get('block:edited').preview,false);assert.equal(context.edited,true);
});

test('settings mutations retain the detail owner while explicit LocateDetails follows the requested object',()=>{
  const {win,context}=fixture(),renders=[];
  win.renderView=()=>{};win.shell.details={hidden:false};win.blocks.querySelectorAll=()=>[];
  win.details.render=(...args)=>renders.push(args);
  win.changed('SetEnabled');win.changed('EnableCandidate');win.changed('LocateDetails');win.changed('InsertLibraryBlock');
  assert.deepEqual(renders.map(args=>args[1].keepOwner),[true,true,false,false]);
  assert.ok(renders.every(args=>args[0]===context.session));
});

test('Switching previews flushes typing first so the edited tab remains open',async()=>{
 const {win}=fixture();const a=libraryContext('a'),b=libraryContext('b');win.context=a;
 win.registerLibraryTab({kind:'block',context:a});win.renderView=()=>{};win.shell.details={hidden:true};
 win.flushEditor=async()=>{if(win.context===a)win.changed('ReplaceText');};win.locate=async()=>{};
 await win._openLibrary(b);
 assert.deepEqual([...win.libraryTabs.keys()],['block:a','block:b']);
 assert.equal(win.libraryTabs.get('block:a').preview,false);assert.equal(win.libraryTabs.get('block:b').preview,true);
});

test('Double-click opening pins the target and subsequent browsing replaces only the remaining preview',async()=>{
 const {win}=fixture();win.locate=async()=>{};const a=libraryContext('a'),b=libraryContext('b'),c=libraryContext('c');
 await win._openLibrary(a,true);await win._openLibrary(b);await win._openLibrary(c);
 assert.deepEqual([...win.libraryTabs.keys()],['block:a','block:c']);
 assert.equal(win.libraryTabs.get('block:a').preview,false);assert.equal(win.libraryTabs.get('block:c').preview,true);
});

test('Library asset reads follow click order even when a request is delayed',async()=>{
 const {win}=fixture();win.locate=async()=>{};let release;
 const a=libraryContext('a'),b=libraryContext('b');const reads=[];
 win.library={assetContext:async asset=>{reads.push(asset.id);if(asset.id==='a')await new Promise(resolve=>release=resolve);return asset.id==='a'?a:b;}};
 const first=win.openLibraryAsset({id:'a'}),second=win.openLibraryAsset({id:'b'},true);
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(reads,['a']);release();await Promise.all([first,second]);
 assert.equal(win.context,b);assert.deepEqual([...win.libraryTabs.keys()],['block:b']);assert.equal(win.libraryTabs.get('block:b').preview,false);
});

test('Tab DOM survives activation and double click makes an inactive preview permanent',async()=>{
 class TabNode {
  constructor(tag,cls='',text=''){
   Object.assign(this,{tag,className:cls,textContent:text,children:[],dataset:{},style:{},scrollLeft:0});
   this.classList={toggle:(name,on)=>{const classes=new Set(this.className.split(' '));if(on)classes.add(name);else classes.delete(name);this.className=[...classes].join(' ');}};
  }
  append(...nodes){this.children.push(...nodes);} replaceChildren(...nodes){this.children=nodes;}
  get childNodes(){return this.children;} setAttribute(key,value){this[key]=value;}
  querySelector(selector){return this.children.find(n=>selector==='button'?n.tag==='button':n.className===selector.slice(1));}
  getBoundingClientRect(){return{left:0,right:100};}
 }
 globalThis.tabElement=(tag,cls,text)=>new TabNode(tag,cls==='plv4-tab'?'plv4-tab node-tab':cls,text);
 try{
  const {win}=fixture();const context=libraryContext('preview');
  win.registerLibraryTab({kind:'block',context});win.tablist=new TabNode('div');win.folderNameControl={};
  win.modes={querySelectorAll:()=>[]};win.shell.center=new TabNode('div');win.shell.win.bar={querySelector:()=>({})};
  win.renderTabs=PLv4Window.prototype.renderTabs;win.renderTabs();
  const tab=win.tablist.children.find(n=>n.dataset.tabKind==='block');const label=tab.querySelector('.plv4-tab-label');
  win.selectTab=async()=>{win.context=context;win.renderTabs();};tab.onclick();await new Promise(r=>setImmediate(r));
  assert.equal(win.tablist.children.find(n=>n.dataset.tabKind==='block'),tab);
  assert.equal(tab.querySelector('.plv4-tab-label'),label);
  assert.ok(tab.className.split(' ').includes('node-tab'),'reuse retains shared design aliases');
  tab.ondblclick({target:label});assert.equal(win.libraryTabs.get('block:preview').preview,false);
  assert.equal(win.tablist.children.find(n=>n.dataset.tabKind==='block'),tab);
 }finally{delete globalThis.tabElement;}
});

test('workflow keyboard undo rebinds the visible page to the replacement node', async () => {
  const { win, node, graph, context } = fixture();
  await win.beginGraphRestore?.();
  win.remove(node); node.graph = null;
  const replacement = { id: node.id, title: node.title, comfyClass: node.comfyClass, graph };
  graph._nodes = [replacement];
  await win._transition;
  await win.endGraphRestore?.();
  assert.equal(win.context?.node, replacement, 'active editor must follow the restored node instead of becoming blank');
  assert.notEqual(win.context, context, 'restored widget values must not inherit the old document session');
  assert.equal(win.context.session.text, 'restored');
  assert.equal(win.context.session.view, 'syntax');
  assert.ok(win.blocks.children.length);
});

test('repeated workflow undo/redo retains the page and updates the seed node reference', async () => {
  const { win, graph } = fixture();
  for (let i = 0; i < 4; i++) {
    const old = graph._nodes[0];
    await win.beginGraphRestore(); win.remove(old); old.graph = null;
    const replacement = { id: old.id, title: old.title, comfyClass: old.comfyClass, graph };
    graph._nodes = [replacement];
    await win.endGraphRestore();
    assert.equal(win.context.node, replacement);
    assert.equal(win.seedNode, replacement);
    assert.equal(win.context.session.view, 'syntax');
    assert.equal(win._graphRestoring, false);
    assert.equal(win.sessions.contexts.size, 1);
  }
});

test('workflow restore while the window is hidden does not reopen it', async () => {
  const { win, node, graph } = fixture(); win.visible = false;
  await win.beginGraphRestore(); win.remove(node); node.graph = null;
  graph._nodes = [{ id: node.id, title: node.title, comfyClass: node.comfyClass, graph }];
  await win.endGraphRestore();
  assert.equal(win.visible, false);
  assert.equal(win.context, null);
  assert.equal(win._graphRestoring, false);
});

test('closing a Folder tab waits for queued pool edits and switches to the workflow tab', async () => {
  const { win, node } = fixture(); win.context = null; win.folderContext = 'folder-a';
  win.libraryTabs.set('folder:folder-a', { kind: 'folder', id: 'folder-a', name: 'Folder A', labelName: 'Folder A' });
  let completed = false;
  win.folderPage.whenIdle = async () => { completed = true; };
  await win.closeTab(win.tabEntries().find(tab => tab.kind === 'folder'));
  assert.ok(completed);
  assert.equal(win.context.node, node);
  assert.equal(win.folderContext, null);
  assert.equal(win.libraryTabs.size, 0);
});

test('closing an inactive node tab keeps its node and editing session', async () => {
  const { win, graph, context } = fixture();
  const other = { id: 18, title: 'Other', comfyClass: 'XYZ Prompt Library V4', graph };
  graph._nodes.push(other);
  await win.closeTab(win.tabEntries().find(tab => tab.node === other));
  assert.equal(win.context, context);
  assert.ok(graph._nodes.includes(other));
  assert.ok(win.closedNodes.has(other));
  assert.equal(win.tabEntries().length, 1);
});

test('closing an active node tab switches to its neighbour and reopening retains its draft', async () => {
  const { win, graph, node, context } = fixture();
  const other = { id: 18, title: 'Other', comfyClass: 'XYZ Prompt Library V4', graph };
  graph._nodes.push(other);
  await win.closeTab(win.tabEntries()[0]);
  assert.equal(win.context.node, other);
  assert.ok(win.sessions.contexts.has(node));
  await win.open(node);
  assert.equal(win.context, context);
  assert.equal(win.context.session.text, 'edited');
  assert.equal(win.closedNodes.has(node), false);
});

test('closing the last tab shows an explicit empty state and leaves the workflow node intact', async () => {
  const { win, node, graph } = fixture();
  await win.closeTab(win.tabEntries()[0]);
  assert.equal(win.context, null);
  assert.equal(win.tabEntries().length, 0);
  assert.equal(graph._nodes[0], node);
  assert.ok(win.blocks.children[0].textContent.includes('暂无打开的标签'));
});

test('closing a Library block tab preserves its cached unsaved draft', async () => {
  const { win, context } = fixture();
  const library = { key: 'v4:saved', name: 'Saved', asset: { name: 'Saved' }, session: { text: 'unsaved draft' } };
  win.library = { contexts: new Map([[library.key, library]]) };
  win.libraryTabs.set(`block:${library.key}`, { kind: 'block', context: library });
  await win.closeTab(win.tabEntries().find(tab => tab.kind === 'block'));
  assert.equal(win.context, context);
  assert.equal(win.library.contexts.get(library.key).session.text, 'unsaved draft');
  assert.equal(win.libraryTabs.size, 0);
});


test('Folder drag creates a child at the block centre and preserves sibling insertion without rebinding', () => {
  const {win,context}=fixture(); context.session.valid=true; context.session.view='block';
  const owner={id:'block',meta:{pool:'old'}}; const box={dataset:{blockId:'block'}};
  win.blocks.querySelectorAll=()=>[box];
  win.blockView.dropTarget=()=>({owner,parent:owner,placement:'inside',command:{parent_id:'block',edge:'end'}});
  const bound=win.libraryDropTarget(10,10);assert.equal(bound.kind,undefined);assert.equal(bound.parent,owner);
  assert.deepEqual(bound.command,{parent_id:'block',edge:'end'});assert.equal(owner.meta.pool,'old');
  win.blockView.dropTarget=()=>({owner,parent:owner,placement:'between',command:{parent_id:'root',after_id:'block'}});
  const insert=win.libraryDropTarget(10,10);assert.equal(insert.kind,undefined);assert.deepEqual(insert.command,{parent_id:'root',after_id:'block'});
});

test('Source drop preserves its insertion command instead of replacing the containing block pool', async t => {
  const helperSource=(await readFile(new URL('../../js/plv4/details.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
  const {indexTree}=await import('data:text/javascript;base64,'+Buffer.from(helperSource).toString('base64'));
  const oldDocument=globalThis.document,oldIndex=globalThis.indexTree;
  globalThis.indexTree=indexTree;globalThis.document={elementFromPoint:()=>({})};
  t.after(()=>{globalThis.document=oldDocument;globalThis.indexTree=oldIndex;});
  const {win,context}=fixture();context.session.valid=true;context.session.view='syntax';
  const owner={id:'block',kind:'group',form:'brace',meta:{pool:'old'},children:[],span:[0,9],source:'{ old }',ast:{spans:{content:[1,8]}}};
  context.session.projection={tree:{id:'root',kind:'group',form:'root',span:[0,9],children:[owner]}};
  win.syntax={contains:()=>true};
  win.pane={editor:{getTargetAtClientPoint:()=>({position:{}}),getScrolledVisiblePosition:()=>({left:10,top:10,height:18}),getDomNode:()=>({getBoundingClientRect:()=>({left:0,top:0})})},model:()=>({getOffsetAt:()=>6,getPositionAt:at=>({column:at})})};
  const target=win.libraryDropTarget(10,10);
  assert.equal(target.kind,undefined);assert.equal(target.parent,owner);
  assert.deepEqual(target.command,{parent_id:'block',edge:'end'});assert.equal(owner.meta.pool,'old');
});
