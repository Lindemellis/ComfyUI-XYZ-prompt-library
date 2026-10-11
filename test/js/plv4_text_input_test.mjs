import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

class DomNode {
  constructor(name, data) {
    this.nodeName = name.toUpperCase(); this.nodeType = data == null ? 1 : 3;
    this.data = data; this.childNodes = []; this.dataset = {}; this.attributes = {}; this.className = '';
    this.handlers = {}; this.focusCount = 0;
    this.classList = { add: (...names) => { this.className += ' ' + names.join(' '); }, contains: name => this.className.split(' ').includes(name) };
  }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; node.parentElement = this; this.childNodes.push(node); } }
  prepend(node) { node.parentNode = this; node.parentElement = this; this.childNodes.unshift(node); }
  get textContent() { return this.nodeType === 3 ? this.data : this.childNodes.map(n => n.textContent).join(''); }
  get contentEditable() { return this.attributes.contenteditable || 'inherit'; }
  set contentEditable(value) { this.attributes.contenteditable = value; }
  setAttribute(name, value) {
    this.attributes[name] = value;
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    if (name === 'class') this.className = value;
  }
  matches(selectors) {
    return selectors.split(',').some(selector => {
      selector = selector.trim();
      if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
      const attrs = [...selector.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)];
      if (attrs.length) return attrs.every(([, key, value]) => {
        const current = key.startsWith('data-') ? this.dataset[key.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] : this.attributes[key];
        return current != null && (value == null || current === value);
      });
      return selector.toUpperCase() === this.nodeName;
    });
  }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  contains(node) { return node === this || this.childNodes.some(child => child.contains(node)); }
  querySelectorAll(selector) { return this.childNodes.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  addEventListener(name, handler) { this.handlers[name] = handler; }
  removeEventListener(name) { delete this.handlers[name]; }
  remove() { const parent=this.parentNode;if(parent) parent.childNodes.splice(parent.childNodes.indexOf(this),1); }
  dispatchEvent(event) { this.events??=[];this.events.push(event);this.handlers[event.type]?.(event); return true; }
  focus() { this.focusCount++; document.activeElement = this; }
  get innerText() { return this.textContent; }
  set innerHTML(html) {
    const match = html.match(/^<span\s+([^>]*)>([\s\S]*)<\/span>$/);
    assert.ok(match, html);
    const node = new DomNode('span');
    for (const [, name, value] of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) node.setAttribute(name, value);
    const decoded = match[2].replace(/&(amp|lt|gt|quot|#39);/g, (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[key]));
    if (decoded) node.append(new DomNode('#text', decoded));
    this.content = { firstElementChild: node };
  }
}
function clonePrefix(root, end, offset) {
  let stopped = false;
  const copy = node => {
    const clone = new DomNode(node.nodeName, node.nodeType === 3 ? node.data : undefined);
    clone.dataset = { ...node.dataset }; clone.attributes = { ...node.attributes };
    if (node === end && node.nodeType === 3) { clone.data = node.data.slice(0, offset); stopped = true; }
    if (node.nodeType !== 3) {
      for (const [i, child] of node.childNodes.entries()) {
        if (node === end && i >= offset) { stopped = true; break; }
        clone.append(copy(child)); if (stopped) break;
      }
      if (node === end) stopped = true;
    }
    return clone;
  };
  return copy(root);
}
globalThis.document = {
  activeElement: null,
  createElement: tag => new DomNode(tag), createTextNode: text => new DomNode('#text', text),
  createRange() { return { selectNodeContents(node) { this.root = node; }, setStart(node, offset) { this.startContainer=node;this.startOffset=offset; }, collapse() {this.endContainer=this.startContainer;this.endOffset=this.startOffset;}, setEnd(node, offset) { this.end = node; this.offset = offset; }, cloneContents() { return clonePrefix(this.root, this.end, this.offset); } }; },
};
let selection = { isCollapsed: true };
globalThis.getSelection = () => selection;
const source = async path => readFile(new URL(path, import.meta.url), 'utf8');
const load = code => import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
await load(await source('../../js/plv4/design_components.js'));
const adapter = await load((await source('../../js/plv4/design_adapter.js')).replace(/^import .*;\r?\n/gm,'').replace("new URL('./design.css', import.meta.url)",JSON.stringify(new URL('../../js/plv4/design.css',import.meta.url).href)));

test('saved block header paths follow source IDs, survive missing assets, and exclude Folder-only blocks',()=>{
  const library={data:{assets:[{id:'B',path:'Folder.New name'}]},path:()=> 'unused'};
  assert.equal(adapter.blockLibraryPath({meta:{source:{kind:'block',id:'B',path:'Folder.Old name'}}},library),'Folder.New name');
  assert.equal(adapter.blockLibraryPath({meta:{source:{kind:'block',id:'missing',path:'Original.Block'}}},library),'Original.Block');
  assert.equal(adapter.blockLibraryPath({meta:{full_path:'Folder.Block.Sub'}},library),'Folder.Block.Sub');
  assert.equal(adapter.blockLibraryPath({meta:{pool:'P'}},library),'');
  assert.equal(adapter.blockLibraryPath({meta:{full_path:'Folder',source:{kind:'folder',path:'Folder'},pool:'P'}},library),'');
  const b={id:'block',name:'Name',libraryPath:'Folder.<Block>',type:'normal',enabled:true,collapsed:true};
  const esc=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
  const html=XYZPLv4Design.blockHTML(b,0,false,{state:{},root:()=>({}),isLibraryBlockView:()=>false,childrenHTML:()=>'',join:()=>'',leaves:()=>[],text:n=>n.source,esc});
  assert.ok(html.indexOf('block-title')<html.indexOf('block-library-path'));
  assert.ok(html.indexOf('block-library-path')<html.indexOf('class="header-controls"'));
  assert.ok(html.includes('Folder.&lt;Block&gt;'));assert.ok(!html.includes('Folder.<Block>'));
});
test('shared block headers show Folder navigation before the name only for their own allowed binding',()=>{
  const block={id:'bound',name:'Character',type:'normal',enabled:true,collapsed:false,meta:{pool:'P'},poolName:'Triggers',poolPath:'Characters.Triggers',poolAvailable:true};
  const env={state:{},root:()=>({}),isLibraryBlockView:()=>false,childrenHTML:()=>'',join:()=>'',leaves:()=>[],text:n=>n.source,esc:value=>String(value)};
  const render=b=>XYZPLv4Design.blockHTML(b,0,false,env);
  const html=render(block);
  assert.ok(html.includes('class="block-pool-link"'));assert.ok(html.includes('aria-label="打开绑定的 Folder：Triggers"'));
  assert.ok(html.indexOf('block-pool-link')<html.indexOf('data-kind="folder"'));
  assert.ok(html.indexOf('data-kind="folder"')<html.indexOf('block-title'));
  assert.equal((html.match(/data-open-folder="P"/g)||[]).length,2);
  assert.ok(!html.includes('block-library-path'),'a Folder binding still does not create a saved Library path');
  for(const meta of [{},{pool:null},{source:{kind:'block',id:'saved'}}]) assert.ok(!render({...block,meta}).includes('block-pool-link'));
  const child=render({...block,id:'child',meta:{name:'Child'}});assert.ok(!child.includes('block-pool-link'),'an unbound child does not inherit the parent icon');
  assert.ok(render({...block,enabled:false}).includes('block-pool-link'),'binding is metadata, independent of enabled state');
  assert.ok(render({...block,meta:{pool:'missing-folder'}}).includes('block-pool-link'),'portable binding remains visible when the local Folder is absent');
  for(const type of ['schedule','region']) assert.ok(!render({...block,type}).includes('data-open-folder'),'containers cannot display Folder bindings');
  assert.ok(render({...block,type:'lora',meta:{pool:'P',lora:{id:'model'}}}).includes('data-open-lora="model"'));
});

const helpers = await load(await source('../../js/plv4/text_input.js'));
globalThis.textInputHelpers = helpers;
globalThis.promptTextHelpers = await load(await source('../../js/plv4/prompt_text.js'));
const dependencies = `
const { promptDisplay, displayRun, scheduleSource, separatorDisplay, runEnd } = globalThis.promptTextHelpers;
export const menus = [];
const { inlineText, inlineOffset, inlinePoint, renderInlineEnd } = globalThis.textInputHelpers;
const element = (tag, cls) => { const node = document.createElement(tag); node.className = cls + (cls === 'plv4-run' ? ' run' : ''); return node; };
const menu = (anchor, items) => menus.push(items);
const indexTree = root => { const map = new Map(); const visit = n => { map.set(n.id, n); n.children.forEach(visit); }; visit(root); return map; };
const isBlock = n => n.kind === 'group' && n.form !== 'paren' && n.meta?.presentation !== 'prompt';
`;
const { BlockView, menus } = await load(dependencies + (await source('../../js/plv4/block_view.js')).replace(/^import .*;\r?\n/gm, '') + '\n//# sourceURL=plv4-shared-input-under-test.js');

function fixture(text = 'cinematic illustration, fine details', rows) {
  if (!rows) {
    const comma = text.indexOf(', ');
    rows = [
      { id: 'a', source: text.slice(0, comma), span: [0, comma] },
      { id: 'b', source: text.slice(comma + 2), span: [comma + 2, text.length] },
    ];
  }
  rows = rows.map(row => ({ kind: 'item', children: [], parent_id: 'root', enabled: true, effective: true, ...row }));
  const root = { id: 'root', kind: 'group', form: 'root', children: rows };
  const session = { text, projection: { tree: root }, state: { selection: { node_id: 'a' } } };
  const view = Object.create(BlockView.prototype);
  const commands = [];
  Object.assign(view, { context: { session }, map: new Map([['root', root], ...rows.map(row => [row.id, row])]), host: { run: action => action(), locate() {}, flushEditor: async () => {}, command: async command => commands.push(command) } });
  const run = view.textRun(rows, 0); view.container = run;
  return { view, run, rows, session, commands };
}

test('adjacent prompts and their punctuation have one native editing host', () => {
  const { run } = fixture();
  assert.equal(run.contentEditable, 'plaintext-only');
  assert.equal(run.querySelectorAll('[contenteditable="true"]').length, 0);
  assert.equal(run.querySelectorAll('[data-prompt-id]').length, 2);
  assert.equal(run.textContent, 'cinematic illustration, fine details');
  assert.equal(helpers.inlineText(run), run.textContent);
});

test('insertion markers are protected decoration, never tiny editable islands for typed text', () => {
  const {run}=fixture('a, b');
  const boundaries=run.querySelectorAll('.boundary');assert.equal(boundaries.length,3);
  assert.ok(boundaries.every(n=>n.contentEditable==='false'&&n.dataset.editorDecoration===''));
  // Even decoration text accidentally added by another host cannot become prompt text.
  boundaries[1].append(document.createTextNode('ignored'));
  assert.equal(helpers.inlineText(run),'a, b');
  const tail=document.createTextNode('  字');run.append(tail);
  assert.equal(helpers.inlineText(run),'a, b  字');
  for(let offset=0;offset<=7;offset++) {
    const [node,at]=helpers.inlinePoint(run,offset);assert.ok(!node.closest?.('.boundary'));
    assert.equal(helpers.inlineOffset(run,node,at),offset);
  }
});

test('clicking comma/space background leaves native caret placement enabled', () => {
  const { run } = fixture(); const container = new DomNode('div'); container.append(run);
  XYZPLv4Design.bindInlineInput(container, { capture() {}, commit() {} });
  document.activeElement = null; let prevented = false;
  container.handlers.pointerdown({ target: run, button: 0, preventDefault() { prevented = true; } });
  assert.equal(document.activeElement, run);
  assert.equal(prevented, false);
  const comma = run.childNodes.find(n => n.nodeType === 3);
  const position = helpers.inlinePoint(run, 'cinematic illustration,'.length);
  assert.deepEqual(position, [comma, 1], 'the space between prompts is part of the editable value');
});

test('Shift-click and same-host mouse actions retain the selection anchor', () => {
  const { run } = fixture(); const container = new DomNode('div'); container.append(run);
  XYZPLv4Design.bindInlineInput(container, { capture() {}, commit() {} });
  document.activeElement = run;
  for (const shiftKey of [false, true]) container.handlers.pointerdown({ target: run, button: 0, shiftKey, preventDefault() { assert.fail('native selection must stay enabled'); } });
  assert.equal(run.focusCount, 0);
});

test('native input/focus from prompt decoration is routed to the whole run', () => {
  const { run } = fixture(); const container = new DomNode('div'); container.append(run);
  const events = [];
  XYZPLv4Design.bindInlineInput(container, { capture: node => events.push(node), input: node => events.push(node), commit: node => events.push(node) });
  const target = run.querySelectorAll('[data-prompt-id]')[1];
  for (const name of ['focusin', 'input', 'focusout']) container.handlers[name]({ target });
  assert.deepEqual(events, [run, run, run]);
});

test('parked prompts retain their position but cannot enter the editable document value', () => {
  for (const place of ['leading', 'middle', 'trailing']) {
    const a = { id: 'a', source: 'a', span: [0, 1] }, b = { id: 'b', source: 'b', span: [3, 4] };
    const parked = { id: 'off', source: 'parked', span: null, enabled: false, effective: false };
    const rows = place === 'leading' ? [parked, a, b] : place === 'middle' ? [a, parked, b] : [a, b, parked];
    const { run } = fixture('a, b', rows);
    assert.equal(helpers.inlineText(run), 'a, b');
    assert.equal(run.textContent, { leading: 'parked, a, b', middle: 'a, parked, b', trailing: 'a, b, parked' }[place]);
    const field = run.querySelectorAll('[data-parked]')[0]; assert.equal(field.contentEditable, 'false');
  }
});

test('PLv3 layout whitespace does not indent or split the Block UI prompt flow', () => {
  const text = 'fantasy landscape,\n        detailed illustration';
  const start = text.indexOf('detailed');
  const { run, session } = fixture(text, [{ id: 'a', source: 'fantasy landscape', span: [0, 17] }, { id: 'b', source: 'detailed illustration', span: [start, text.length] }]);
  assert.equal(helpers.inlineText(run), 'fantasy landscape, detailed illustration');
  assert.equal(session.text, text, 'rendering must not rewrite the document');
});

test('Unicode and punctuation survive projected separators and native caret round-trips', () => {
  const text = '😀 girl.\n  fine details.';
  const start = text.indexOf('fine');
  const { run } = fixture(text, [{ id: 'a', source: '😀 girl.', span: [0, 8] }, { id: 'b', source: 'fine details.', span: [start, text.length] }]);
  assert.equal(helpers.inlineText(run), '😀 girl. fine details.');
  for (let offset = 0; offset <= helpers.inlineText(run).length; offset++) {
    const [node, at] = helpers.inlinePoint(run, offset);
    assert.equal(helpers.inlineOffset(run, node, at), offset);
  }
});

test('paragraph/BR input and logical caret offsets share the same newlines', () => {
  const run = new DomNode('div'); run.append(document.createTextNode('first'));
  const line = new DomNode('div'); line.append(document.createTextNode('second')); run.append(line);
  const third = new DomNode('div'); third.append(document.createTextNode('third'), new DomNode('br')); run.append(third);
  assert.equal(helpers.inlineText(run), 'first\nsecond\nthird\n');
  for (let offset = 0; offset <= helpers.inlineText(run).length; offset++) {
    const [node, at] = helpers.inlinePoint(run, offset);
    assert.equal(helpers.inlineOffset(run, node, at), offset);
  }
});

test('reopening runs retains terminal Enter lines without exposing the closing-brace layout',()=>{
  for(const [text,expected] of [['{ cat\n }','cat\n '],['{\n    cat\n}','cat'],['{\n    cat\n\n}','cat\n'],['cat\n\n','cat\n\n']]){
    const start=text.indexOf('cat'),end=start+3;
    const {view,session,rows}=fixture(text,[{id:'a',source:'cat',span:[start,end]}]);
    const parent=session.projection.tree;parent.form=text.startsWith('{')?'brace':'root';parent.ast={spans:{content:[text.startsWith('{')?1:0,text.endsWith('}')?text.length-1:text.length]}};
    const run=view.textRun(rows,0);
    assert.equal(helpers.inlineText(run),expected,text);
    assert.equal(session.text,text,'displaying whitespace does not rewrite the document');
  }
});

test('rendered blank final lines use the native text terminator and keep logical caret offsets',()=>{
  const field=new DomNode('div');field.contentEditable='plaintext-only';
  const first=document.createTextNode('first\n');field.append(first);
  helpers.renderInlineEnd(field);
  assert.equal(helpers.inlineText(field),'first\n');
  assert.equal(field.textContent,'first\n\n');
  assert.equal(field.querySelectorAll('br').length,0);
  assert.equal(helpers.inlineOffset(field,...helpers.inlinePoint(field,6)),6);
});

test('Block input leaves Enter, Backspace and Delete to the browser',()=>{
  const container=new DomNode('div');new BlockView(container,{});
  assert.equal(container.handlers.beforeinput,undefined);
});

test('plaintext native terminal display newline is excluded from source and caret offsets',()=>{
  const field=new DomNode('div');field.contentEditable='plaintext-only';
  const text=document.createTextNode('1girl,\n\n');field.append(text);
  assert.equal(helpers.inlineText(field),'1girl,\n');
  assert.equal(helpers.inlineOffset(field,text,7),7);
  assert.equal(helpers.inlineOffset(field,text,8),7);
  assert.equal(helpers.inlineOffset(field,...helpers.inlinePoint(field,7)),7);
  text.data='1girl,\n2girls';
  assert.equal(helpers.inlineText(field),text.data,'only the terminal visual newline is excluded');
});

test('paste inserts plain text through the shared native input rather than nested editing islands', () => {
  const { run } = fixture(); const container = new DomNode('div'); container.append(run);
  XYZPLv4Design.bindInlineInput(container, { capture() {}, commit() {} });
  let inserted, prevented = false;
  document.execCommand = (...args) => { inserted = args; };
  container.handlers.paste({ target: run, clipboardData: { getData(type) { assert.equal(type, 'text/plain'); return 'new, prompts'; } }, preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.deepEqual(inserted, ['insertText', false, 'new, prompts']);
});

test('autocomplete reads the whole shared input and uses source offsets across parked decoration', async () => {
  const { run } = fixture('a, b', [
    { id: 'a', source: 'a', span: [0, 1] },
    { id: 'off', source: 'parked', span: null, effective: false, enabled: false },
    { id: 'b', source: 'b', span: [3, 4] },
  ]);
  let attached;
  globalThis.autocompleteEnvironment = { xyzTagAC: { attach(field, options) { attached = { field, ...options }; } } };
  const setup = 'const window = globalThis.autocompleteEnvironment; const { inlineText, inlineOffset, inlinePoint } = globalThis.textInputHelpers; const { autocompleteText } = globalThis.promptTextHelpers;\n';
  const code = (await source('../../js/plv4/inline_input.js')).replace(/^import .*;\r?\n/gm, '');
  const { attachInlineAutocomplete } = await load(setup + code + '\n//# sourceURL=plv4-shared-autocomplete-under-test.js');
  await attachInlineAutocomplete(run, { whenIdle: async () => {} });
  const text = run.querySelectorAll('[data-prompt-id]').at(-1).childNodes[0];
  selection = { rangeCount: 1, getRangeAt: () => ({ startContainer: text, startOffset: 0, endContainer: text, endOffset: 1 }) };
  assert.equal(attached.field, run); assert.equal(attached.related, true);
  assert.equal(attached.adapter.getValue(), 'a, b');
  assert.equal(attached.adapter.getCaret(), 3); assert.equal(attached.adapter.getSelEnd(), 4);
  selection = { isCollapsed: true };
});

test('right-click wrap resolves all selected prompts after pending edits, using current IDs', async () => {
  const { view, run, rows, session, commands } = fixture('a, b');
  const prompts = run.querySelectorAll('[data-prompt-id]');
  const start = prompts[0].childNodes[0], end = prompts[1].childNodes[0];
  selection = { isCollapsed: false, anchorNode: start, focusNode: end,
    getRangeAt: () => ({ startContainer: start, startOffset: 0, endContainer: end, endOffset: 1, intersectsNode: node => prompts.includes(node) }) };
  view.inline = { element: run, ready: Promise.resolve({ contentStart: 0, sourceOffset: offset => offset }) };
  view.host.flushEditor = async () => { session.projection.tree.children = rows.map((row, i) => ({ ...row, id: 'new' + i })); };
  view.contextMenu({ clientX: 0, clientY: 0 }, rows[0]);
  await menus.at(-1).find(([label]) => label === '选区原位包组')[1]();
  assert.deepEqual(commands, [{ type: 'WrapSelection', ids: ['new0', 'new1'] }]);
  selection = { isCollapsed: true };
});
