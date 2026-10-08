import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
const load = code => import('data:text/javascript;base64,' + Buffer.from(code + '\n//# sourceURL=text-editing-under-test.js').toString('base64'));
const { showEditorContextMenu, showEditorFind } = await load(await readFile(new URL('../../js/plv3/text_editing.js', import.meta.url), 'utf8'));
globalThis.document = { activeElement: null };
function events(target) {
  target.handlers={};
  target.addEventListener=(name,handler)=>{target.handlers[name]=handler;};
  target.removeEventListener=(name,handler)=>{assert.equal(target.handlers[name],handler);delete target.handlers[name];};
  return target;
}

test('Block UI uses the actual syntax menu actions, order, labels and keybindings', async () => {
  class Submenu { constructor(actions) { this.id = 'submenu'; this.label = 'Submenu'; this.actions = actions; } }
  const actions = [{ id: 'undo', label: 'Undo', enabled: true }, { id: 'separator', label: '' }, new Submenu([{ id: 'copy', label: 'Copy', enabled: true }])];
  let menu, invoked = [];
  const controller = { _getMenuActions(model, id) { assert.equal(model, 'shared model'); assert.equal(id, 'syntax menu'); return actions; },
    _keybindingFor(action) { return action.id === 'undo' ? 'Ctrl+Z' : null; }, _contextMenuService: { showContextMenu(value) { menu = value; } } };
  const pane = { model: () => 'shared model', editor: { contextMenuId: 'syntax menu', getContribution: id => { assert.equal(id, 'editor.contrib.contextmenu'); return controller; } } };
  showEditorContextMenu(pane, { x: 10, y: 20 }, action => action.id === 'separator' ? null : { enabled: true, run: () => invoked.push(action.id) });
  const result = menu.getActions();
  assert.deepEqual(result.map(action => [action.id, action.label]), actions.map(action => [action.id, action.label]));
  assert.equal(result[1], actions[1]);
  assert.ok(result[2] instanceof Submenu, 'Monaco submenu dispatch relies on its action type');
  await result[0].run(); await result[2].actions[0].run();
  assert.deepEqual(invoked, ['undo', 'copy']);
  assert.equal(menu.getKeyBinding(result[0]), 'Ctrl+Z');
  assert.deepEqual(menu.getAnchor(), { x: 10, y: 20 });
});

test('Find and replace mounts the same Monaco widget/controller and restores it when leaving Block UI', async () => {
  const parent = {}, node = { parentNode: parent, nextSibling: null };
  let cursor, change, focused, disposed = 0;
  const state = { isRevealed: true, onFindReplaceStateChange(fn) { change = fn; return { dispose() { disposed++; } }; } };
  const controller = { async start(options) { assert.equal(options.forceRevealReplace, true); }, getState: () => state,
    _widget: { getDomNode: () => node, focusReplaceInput() { focused = 'replace'; }, focusFindInput() { focused = 'find'; } } };
  let overlay=controller._widget,layouts=0;
  const pane = { editor: { getContribution: () => controller, getSelection: () => 'match', onDidChangeCursorSelection(fn) { cursor = fn; return { dispose() { disposed++; } }; },
    removeOverlayWidget(widget){assert.equal(widget,overlay);overlay=null;node.parentNode=null;},
    addOverlayWidget(widget){assert.equal(overlay,null);overlay=widget;node.parentNode=parent;},
    layoutOverlayWidget(widget){assert.equal(widget,overlay);layouts++;} } };
  const container = events({ contains: () => false, replaceChildren(child) { this.node = child; child.parentNode = this; }, hidden: true }), matches = [];
  const binding = await showEditorFind(pane, container, true, match => matches.push(match));
  assert.equal(container.node, node); assert.equal(container.hidden, false); assert.equal(focused, 'replace');
  // Monaco rebuilds its view from registered overlays on model changes. A DOM
  // move alone would cause this search widget to return to hidden Source.
  const rebuildSourceView=()=>{if(overlay)node.parentNode=parent;};
  rebuildSourceView();assert.equal(node.parentNode,container);assert.equal(overlay,null);
  cursor(); assert.deepEqual(matches, ['match', 'match']);
  state.isRevealed = false; change(); assert.equal(container.hidden, true);
  binding.dispose(); assert.equal(node.parentNode, parent); assert.equal(disposed, 2);assert.equal(overlay,controller._widget);assert.equal(layouts,1);
});

test('borrowed Find stays visible with Monaco hiddenEditor while Source Find retains its hidden rule',async()=>{
  const css=await readFile(new URL('../../js/plv4/design.css',import.meta.url),'utf8');
  const monaco=await readFile(new URL('../../web/monaco/vs/editor/editor.main.css',import.meta.url),'utf8');
  const classNames=new Set(['find-widget','hiddenEditor','visible']);
  const display=(host)=>{
    let result;
    for(const sheet of [monaco,css]) for(const [,selectors,body] of sheet.replace(/\/\*[\s\S]*?\*\//g,'').matchAll(/([^{}]+)\{([^{}]*)\}/g)){
      const value=body.match(/(?:^|;)\s*display\s*:\s*([^;]+)/)?.[1];if(!value)continue;
      for(const selector of selectors.split(',')){
        const levels=selector.trim().split(/\s+/);if(levels.length!==2)continue;
        const classes=levels[1].match(/\.[\w-]+/g)?.map(s=>s.slice(1))||[];
        if(host.has(levels[0].slice(1))&&classes.length&&classes.every(c=>classNames.has(c)))result=value.trim();
      }
    }
    return result;
  };
  assert.equal(display(new Set(['monaco-editor'])),'none','Monaco hides Find for zero-width Source');
  assert.equal(display(new Set(['monaco-editor','plv4-find-host'])),'block','a visible Blocks host must not inherit Source visibility');
});

test('showing Block matches retains the Find query/replace caret when native selection steals input focus',async()=>{
  let cursor,focused=0;
  const input={selectionStart:2,selectionEnd:4,selectionDirection:'backward',isConnected:true,
    matches:selector=>selector==='input,textarea',focus(){focused++;document.activeElement=this;},
    setSelectionRange(start,end,direction){this.selectionStart=start;this.selectionEnd=end;this.selectionDirection=direction;}};
  const widget={getDomNode:()=>({}),focusFindInput(){document.activeElement=input;},focusReplaceInput(){document.activeElement=input;}};
  const state={isRevealed:true,onFindReplaceStateChange:()=>({dispose(){}})};
  const controller={start:async()=>{},_widget:widget,getState:()=>state};
  const container=events({hidden:true,contains:node=>node===input,replaceChildren(){}});
  const pane={editor:{getContribution:()=>controller,getSelection:()=>({}),removeOverlayWidget(){},addOverlayWidget(){},layoutOverlayWidget(){},
    onDidChangeCursorSelection(listener){cursor=listener;return {dispose(){}};}}};
  const binding=await showEditorFind(pane,container,false,()=>{document.activeElement={};input.selectionStart=0;input.selectionEnd=0;});
  assert.equal(document.activeElement,input);assert.deepEqual([input.selectionStart,input.selectionEnd,input.selectionDirection],[2,4,'backward']);
  cursor();assert.equal(document.activeElement,input);assert.equal(focused,2);
  binding.dispose();document.activeElement=null;
});

test('borrowed query Enter/Shift+Enter navigates matches without inserting a textarea newline',async()=>{
  let next=0,previous=0,shown=0;const actions=[];
  const controller={start:async()=>{},moveToNextMatch(){assert.fail('use the arrow action');},moveToPrevMatch(){assert.fail('use the arrow action');},
    getState:()=>({isRevealed:true,onFindReplaceStateChange:()=>({dispose(){}})}),
    _widget:{getDomNode:()=>({}),focusFindInput(){},focusReplaceInput(){}}};
  const container=events({hidden:true,contains:()=>false,replaceChildren(){}});
  const pane={editor:{getContribution:()=>controller,getSelection:()=>({}),removeOverlayWidget(){},addOverlayWidget(){},layoutOverlayWidget(){},onDidChangeCursorSelection:()=>({dispose(){}}),
    getAction(id){actions.push(id);return{async run(){if(id==='editor.action.nextMatchFindAction')next++;else if(id==='editor.action.previousMatchFindAction')previous++;else assert.fail(id);}};}}};
  const binding=await showEditorFind(pane,container,false,()=>shown++);
  const target={value:'cl',closest:selector=>selector==='.find-part'?{}:null};
  for(const shiftKey of [false,true]){
    let prevented=false,stopped=false;
    await container.handlers.keydown({key:'Enter',target,shiftKey,preventDefault(){prevented=true;},stopImmediatePropagation(){stopped=true;}});
    assert.equal(prevented,true);assert.equal(stopped,true);assert.equal(target.value,'cl');
  }
  assert.equal(next,1);assert.equal(previous,1);assert.equal(shown,3);
  assert.deepEqual(actions,['editor.action.nextMatchFindAction','editor.action.previousMatchFindAction']);
  for(const options of [{isComposing:true},{keyCode:229},{ctrlKey:true},{metaKey:true},{altKey:true},{target:{closest:()=>null}}]){
    container.handlers.keydown({key:'Enter',target,...options,preventDefault(){assert.fail('composition, modified Enter and Replace stay native');}});
  }
  binding.dispose();assert.equal(container.handlers.keydown,undefined);
});

test('borrowed Find enforces live prompt scopes even when Monaco focus toggles selection scope, and restores Source scope',async()=>{
  const original=[{startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:100}];
  let desired=[{startLineNumber:1,startColumn:20,endLineNumber:1,endColumn:25}],listener;
  const state={isRevealed:true,searchScope:original,change(patch){Object.assign(this,patch);listener?.(patch);},
    onFindReplaceStateChange(fn){listener=fn;return{dispose(){listener=null;}};}};
  const controller={async start(options,patch){state.change(patch);},getState:()=>state,
    _widget:{getDomNode:()=>({}),focusFindInput(){state.change({searchScope:original});},focusReplaceInput(){}}};
  const container=events({hidden:true,contains:()=>false,replaceChildren(){}});
  const pane={editor:{getContribution:()=>controller,getSelection:()=>({}),removeOverlayWidget(){},addOverlayWidget(){},layoutOverlayWidget(){},onDidChangeCursorSelection:()=>({dispose(){}})}};
  const binding=await showEditorFind(pane,container,false,()=>{}, {searchScope:()=>desired});
  assert.deepEqual(state.searchScope,desired);
  state.change({searchScope:null});assert.deepEqual(state.searchScope,desired,'Source-only fields cannot be admitted by turning off selection scope');
  desired=[{startLineNumber:2,startColumn:8,endLineNumber:2,endColumn:15}];binding.refreshScope();assert.deepEqual(state.searchScope,desired);
  binding.dispose();assert.equal(state.searchScope,original,'Source regains its original Find scope');
});

const python=process.env.PLV4_TEST_PYTHON;
test('the reported Region/Schedule document searches three prompt cl matches and excludes include_in_base', {skip:!python},async()=>{
  const source=`cinematic illustration, fine details,
,,
[@region]: {
    [base]: {
        fantasy landscape,
        detailed illustration,


    }
    [mask: [0, 0.5, 0, 1], feather: 12, mask_weight: 1, cond_weight: 1, include_in_base: false]: {
        1girl,
        emerald cloak
    }
    [mask: [0.5, 1, 0, 1], feather: 12]: {
        ancient stone gate,
        climbing ivy
    }
    [fill]: {
        distant mountains,
        soft mist
    }
},
[@schedule]: {
    0 - 0.35: {
        {
            sunrise colors
        }.set{region: [base]},
        (soft golden light:1.1)
    },
    0.35 - 0.85: {
        bright daylight,
        clear sky
    },
    0.85 - 1: {
        dusk colors,
        soft evening light
    }
},
{
}`;
  const result=spawnSync(python,['-c',`import sys,json
from prompt_library_v4.model import EditorState,projection
state=EditorState.create(text=json.load(sys.stdin))
print(json.dumps(projection(state),ensure_ascii=True))`],{input:JSON.stringify(source),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const helpers=await load(await readFile(new URL('../../js/plv4/prompt_text.js',import.meta.url),'utf8'));
  globalThis.findPromptHelpers=helpers;
  const {blockFindSpans}=await load('const {inlinePrompt,promptDisplay}=globalThis.findPromptHelpers;\n'+(await readFile(new URL('../../js/plv4/block_find.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,''));
  const spans=blockFindSpans(JSON.parse(result.stdout).tree,source);
  assert.equal([...source.matchAll(/cl/g)].length,4);
  assert.equal(spans.reduce((count,span)=>count+[...source.slice(...span).matchAll(/cl/g)].length,0),3);
  const admitted=at=>spans.some(([a,b])=>a<=at&&at<b);
  for(const hidden of ['include_in_base','mask_weight','feather','region: [base]','0 - 0.35'])assert.equal(admitted(source.indexOf(hidden)),false,hidden);
  for(const text of ['emerald cloak','climbing ivy','clear sky','soft golden light'])assert.equal(admitted(source.indexOf(text)),true,text);
  assert.ok(spans.every(span=>!/[\r\n]/.test(source.slice(...span))),'scopes cannot expand to include complete Source lines');
});

test('the production Block window passes prompt scopes to Find and an empty block cannot fall back to all Source',async()=>{
  const helpers=await load(await readFile(new URL('../../js/plv4/prompt_text.js',import.meta.url),'utf8'));
  globalThis.windowFindHelpers=helpers;
  const {blockFindSpans,clearBlockFindHighlight,highlightBlockFindMatch}=await load('const {inlinePrompt,promptDisplay}=globalThis.windowFindHelpers;\n'+(await readFile(new URL('../../js/plv4/block_find.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,''));
  const container=events({hidden:true,contains:()=>false,replaceChildren(){}});
  globalThis.windowFindIntegration={blockFindSpans,clearBlockFindHighlight,highlightBlockFindMatch,showEditorFind,element:()=>container};
  const code=(await readFile(new URL('../../js/plv4/window.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
  const {PLv4Window}=await load('const {blockFindSpans,clearBlockFindHighlight,highlightBlockFindMatch,showEditorFind,element}=globalThis.windowFindIntegration;\n'+code);
  let listener;
  const state={isRevealed:true,searchScope:null,change(patch){Object.assign(this,patch);listener?.(patch);},onFindReplaceStateChange(fn){listener=fn;return{dispose(){listener=null;}};}};
  const controller={async start(options,patch){state.change(patch);},getState:()=>state,
    _widget:{getDomNode:()=>({}),focusFindInput(){},focusReplaceInput(){}}};
  const text='[include_in_base]: { cloak }',start=text.indexOf('cloak');
  const root={kind:'group',form:'root',span:[0,text.length],effective:true,children:[{kind:'item',effective:true,span:[start,start+5],children:[]}]};
  const win=Object.create(PLv4Window.prototype);
  win.context={session:{view:'block',text,projection:{tree:root}}};
  win.shell={center:{append(){}}};win.blockView={closeEditor(){}};
  win.setTextSelection=()=>{};win.showBlockMatch=()=>{};
  win.pane={model:()=>({getPositionAt:at=>({lineNumber:1,column:at+1})}),monaco:{Range:{fromPositions:(a,b)=>({startLineNumber:a.lineNumber,startColumn:a.column,endLineNumber:b.lineNumber,endColumn:b.column})}},
    editor:{getContribution:()=>controller,getSelection:()=>({}),removeOverlayWidget(){},addOverlayWidget(){},layoutOverlayWidget(){},onDidChangeCursorSelection:()=>({dispose(){}})}};
  await win.openBlockFind(false,{span:[start,start]});
  assert.deepEqual(state.searchScope,[{startLineNumber:1,startColumn:start+1,endLineNumber:1,endColumn:start+6}]);
  assert.equal(win.context.session.view,'block');
  win.context.session.projection.tree={...root,children:[]};win.findBinding.refreshScope();
  assert.deepEqual(state.searchScope,[{startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:1}]);
  win.findBinding.dispose();assert.equal(state.searchScope,null);
});

test('Enter and the actual arrow action highlight the same Block text while the query keeps focus, and closing clears it',async()=>{
  const oldCSS=globalThis.CSS,oldHighlight=globalThis.Highlight,oldRange=document.createRange;
  globalThis.CSS={highlights:new Map()};globalThis.Highlight=class{constructor(...ranges){this.ranges=ranges;}};
  document.createRange=()=>({setStart(node,offset){this.startContainer=node;this.startOffset=offset;},setEnd(node,offset){this.endContainer=node;this.endOffset=offset;}});
  try{
    const helpers=await load(await readFile(new URL('../../js/plv4/prompt_text.js',import.meta.url),'utf8'));
    const inputHelpers=await load(await readFile(new URL('../../js/plv4/text_input.js',import.meta.url),'utf8'));
    globalThis.highlightPromptHelpers=helpers;
    const highlightHelpers=await load('const {inlinePrompt,promptDisplay}=globalThis.highlightPromptHelpers;\n'+(await readFile(new URL('../../js/plv4/block_find.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,''));
    const indexTree=root=>{const map=new Map();const visit=n=>{map.set(n.id,n);n.children.forEach(visit);};visit(root);return map;};
    globalThis.highlightWindowHelpers={...highlightHelpers,displayRun:helpers.displayRun,inlinePoint:inputHelpers.inlinePoint,indexTree};
    const code=(await readFile(new URL('../../js/plv4/window.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
    const {PLv4Window}=await load('const {clearBlockFindHighlight,highlightBlockFindMatch,displayRun,inlinePoint,indexTree}=globalThis.highlightWindowHelpers;\n'+code);
    const source='cloak, clear',textNode={nodeType:3,data:source};
    let scrolls=0;
    const field={nodeType:1,nodeName:'DIV',childNodes:[textNode],dataset:{runIds:'a,b'},scrollIntoView(){scrolls++;}};
    const children=[{id:'a',source:'cloak',span:[0,5]},{id:'b',source:'clear',span:[7,12]}].map(row=>({...row,parent_id:'root',form:'item',kind:'text',effective:true,children:[]}));
    const root={id:'root',form:'root',children};
    const win=Object.create(PLv4Window.prototype);
    win.context={session:{view:'block',text:source,projection:{tree:root}},folded:new Set(['root'])};
    win.blocks={querySelectorAll:()=>[field]};win.blockView={render(){}};
    let selected=[0,2],cursor,stateChanged;
    const selection=()=>({getStartPosition:()=>({lineNumber:1,column:selected[0]+1}),getEndPosition:()=>({lineNumber:1,column:selected[1]+1})});
    const input={value:'cl',selectionStart:2,selectionEnd:2,isConnected:true,matches:()=>true,closest:()=>({}),focus(){document.activeElement=this;},setSelectionRange(a,b){this.selectionStart=a;this.selectionEnd=b;}};
    const state={isRevealed:true,matchesCount:2,onFindReplaceStateChange(fn){stateChanged=fn;return{dispose(){}};}};
    const controller={async start(){},getState:()=>state,_widget:{getDomNode:()=>({}),focusFindInput(){input.focus();},focusReplaceInput(){input.focus();}}};
    const container=events({hidden:true,contains:node=>node===input,replaceChildren(){}});
    const nextAction={async run(){selected=[7,9];cursor();}};
    const editor={getContribution:()=>controller,getSelection:selection,removeOverlayWidget(){},addOverlayWidget(){},layoutOverlayWidget(){},
      onDidChangeCursorSelection(fn){cursor=fn;return{dispose(){}};},getAction(id){assert.equal(id,'editor.action.nextMatchFindAction');return nextAction;}};
    win.pane={model:()=>({getOffsetAt:position=>position.column-1}),editor};
    const binding=await showEditorFind(win.pane,container,false,s=>win.showBlockMatch(s),{onClearMatch:highlightHelpers.clearBlockFindHighlight});
    const current=()=>[...CSS.highlights.values()][0]?.ranges[0];
    const enter={key:'Enter',target:input,preventDefault(){},stopImmediatePropagation(){}};
    await container.handlers.keydown(enter);
    const afterEnter=current();assert.deepEqual([afterEnter.startOffset,afterEnter.endOffset],[7,9]);
    assert.equal(document.activeElement,input);input.setSelectionRange(0,2);assert.equal(current(),afterEnter,'query selection cannot erase the Block highlight');
    selected=[0,2];await nextAction.run();
    assert.deepEqual([current().startOffset,current().endOffset],[afterEnter.startOffset,afterEnter.endOffset]);
    assert.ok(scrolls>=3);assert.equal(win.context.folded.size,0);
    const css=await readFile(new URL('../../js/plv4/design.css',import.meta.url),'utf8');
    assert.ok(css.includes(`::highlight(${[...CSS.highlights.keys()][0]})`),'the registered range has a visible CSS style');
    state.matchesCount=0;stateChanged();assert.equal(CSS.highlights.size,0,'no results must clear stale highlights');
    win.showBlockMatch(selection());assert.equal(CSS.highlights.size,0,'document redraws cannot restore a match when the query has no results');
    state.matchesCount=2;selected=[0,2];await nextAction.run();assert.equal(CSS.highlights.size,1);
    state.isRevealed=false;stateChanged();assert.equal(CSS.highlights.size,0);
    binding.dispose();assert.equal(CSS.highlights.size,0);
  } finally {globalThis.CSS=oldCSS;globalThis.Highlight=oldHighlight;document.createRange=oldRange;document.activeElement=null;}
});

test('the vendored Monaco provides the exact reused menu and Find APIs', async () => {
  const source = await readFile(new URL('../../web/monaco/vs/editor/editor.main.js', import.meta.url), 'utf8');
  for (const name of ['_getMenuActions(', '_keybindingFor(', 'editor.contrib.findController', 'focusFindInput()', 'focusReplaceInput()', 'onFindReplaceStateChange']) assert.ok(source.includes(name), name);
});

test('Create as block preserves a collapsed cursor target and passes a partial string selection unchanged', async () => {
  const code = (await readFile(new URL('../../js/plv4/window.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  const deps = `const indexTree = tree => { const map = new Map(); const visit = row => { map.set(row.id, row); row.children.forEach(visit); }; visit(tree); return map; };`;
  const { PLv4Window } = await load(deps + code);
  const row = { id: 'prompt', form: 'item', span: [10, 25], children: [] }, root = { id: 'root', form: 'root', children: [row] };
  const context = { session: { projection: { tree: root } } }, calls = [];
  const win = Object.create(PLv4Window.prototype); win.context = context; win.command = async command => calls.push(command);
  await win.createAsBlock({ context, row, span: [14, 14] });
  await win.createAsBlock({ context, row, span: [14, 18] });
  assert.deepEqual(calls, [{ type: 'WrapSelection', ids: ['prompt'] }, { type: 'CreateAsBlock', span: [14, 18] }]);
});
