import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

// A small offline host exercises the production detail renderer and dualSlider.
// It runs no browser and sends no requests to the user's ComfyUI or Library.
class Node {
  constructor(tag) {
    this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.attributes = {};
    this.style = { setProperty(key, value) { this[key] = value; } }; this.className = ''; this.hidden = false;
    this.classList = { add: (...names) => { this.className += ' ' + names.join(' '); } };
  }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  get lastElementChild() { return this.children.at(-1); }
  get textContent() { return this.text || this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this.text = value; this.children = []; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener() {}
  matches(selector) {
    if (selector.includes(',')) return selector.split(',').some(part => this.matches(part.trim()));
    if (/^\[data-[\w-]+\]$/.test(selector)) return selector.slice(6,-1).replace(/-([a-z])/g,(_,c)=>c.toUpperCase()) in this.dataset;
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
    if (selector === 'input[type=range]') return this.tagName === 'INPUT' && this.type === 'range';
    if (selector === 'input[type=checkbox]') return this.tagName === 'INPUT' && this.type === 'checkbox';
    return this.tagName.toLowerCase() === selector;
  }
  querySelectorAll(selector) {
    const nodes = [];
    const visit = node => { for (const child of node.children) { if (child.matches(selector)) nodes.push(child); visit(child); } };
    visit(this); return nodes;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
globalThis.document = { createElement: tag => new Node(tag), head: new Node('head') };
globalThis.XYZPLv4Design = { foldSections() {} };
globalThis.window = { xyzTagAC: { attach(element, options) { element._xyzTagACHooked = true; element._xyzRelated = options.related; } } };
const hostSource = await readFile(new URL('../../js/tagac_host.js', import.meta.url), 'utf8');
globalThis.tagacHosts = await import('data:text/javascript;base64,' + Buffer.from(hostSource).toString('base64'));
const themeSource = await readFile(new URL('../../js/plv3/theme.js', import.meta.url), 'utf8');
const theme = await import('data:text/javascript;base64,' + Buffer.from(themeSource + '\n//# sourceURL=plv3-theme-under-test.js').toString('base64'));
globalThis.detailTheme = theme;
globalThis.promptTextHelpers = await import('data:text/javascript;base64,' + Buffer.from(await readFile(new URL('../../js/plv4/prompt_text.js', import.meta.url), 'utf8')).toString('base64'));
globalThis.folderTreeHelpers = await import('data:text/javascript;base64,' + Buffer.from(await readFile(new URL('../../js/plv4/folder_tree.js', import.meta.url), 'utf8')).toString('base64'));
const iconSource=(await readFile(new URL('../../js/plv4/asset_icons.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
globalThis.assetIconFactory=(await import('data:text/javascript;base64,'+Buffer.from("const element=(tag,cls='')=>{const n=document.createElement(tag);n.className=cls;return n;};\n"+iconSource).toString('base64'))).assetIcon;
const detailSource = (await readFile(new URL('../../js/plv4/details.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const dependencies = `
const dualSlider = globalThis.detailTheme.dualSlider;
const fmt = globalThis.detailTheme.fmt;
const assetIcon=globalThis.assetIconFactory;
const libraryRequest = (...args) => globalThis.poolRequest(...args);
const { inlinePrompt, cleanPromptInput } = globalThis.promptTextHelpers;
const { compactFolders, compareNames } = globalThis.folderTreeHelpers;
const { attachPromptAutocomplete } = globalThis.tagacHosts;
const settings = () => ({ scheduleStep: 0.05 });
const element = (tag, cls = '', text = '') => { const node = document.createElement(tag); node.className = cls; if (text) node.textContent = text; return node; };
const button = (text, title, action, cls) => { const node = element('button', cls, text); node.title = title; node.onclick = () => action({ currentTarget: node }); return node; };
const input = (value, action, options = {}) => { const node = element('input'); node.value = String(value ?? ''); node.type = options.type || 'text'; node.onchange = () => action(['number','range'].includes(node.type) ? Number(node.value) : node.value); return node; };
const check = (value, action) => { const node = input('', action, { type: 'checkbox' }); node.checked = value; node.onchange = () => action(node.checked); return node; };
const menu = (anchor, items) => { globalThis.settingMenu = items; };
const report = error => { throw error; };
`;
const { DetailsPane, isBlock } = await import('data:text/javascript;base64,' + Buffer.from(dependencies + detailSource + '\n//# sourceURL=plv4-details-under-test.js').toString('base64'));

test('random selection requires both ordered non-negative integer bounds and can be cleared', async () => {
  const calls = [], row = { id: 'block', settings: {} };
  const pane = new DetailsPane(new Node('div'), { command: command => calls.push(command) });
  const fields = pane.randomSelect(row).querySelectorAll('input');
  assert.deepEqual(fields.map(field => field.value), ['', '']);
  fields[0].value = '2'; await fields[0].onchange(); assert.equal(calls.length, 0);
  fields[1].value = '4'; await fields[1].onchange(); assert.deepEqual(calls.at(-1).patch.random_select, [2, 4]);
  for (const [a, b] of [['-1','4'], ['1.5','4'], ['5','4'], ['0','1.5']]) {
    fields[0].value = a; fields[1].value = b; await fields[1].onchange();
    assert.equal(calls.length, 1, 'invalid drafts must not mutate the document');
  }
  fields[0].value = '0'; fields[1].value = '0'; await fields[1].onchange();
  assert.deepEqual(calls.at(-1).patch.random_select, [0, 0], 'zero means choose no children, distinct from unset');
  fields[0].value = ''; fields[1].value = ''; await fields[1].onchange();
  assert.equal(calls.at(-1).patch.random_select, null);
  const fixed = pane.randomSelect({ ...row, settings: { random_select: [3, 3] } });
  assert.deepEqual(fixed.querySelectorAll('input').map(field => field.value), ['3', '3']);
});

test('dropout slider previews while dragging and commits once on change', async () => {
  const calls = [], row = { id: 'block', settings: { dropout: .2 } };
  const pane = new DetailsPane(new Node('div'), { command: command => calls.push(command) });
  const control = pane.dropout(row), slider = control.querySelector('input[type=range]');
  for (const value of ['0.25', '0.3', '0.35']) { slider.value = value; slider.oninput(); }
  assert.equal(control.querySelector('.detail-dropout-value').textContent, '0.35');
  assert.equal(calls.length, 0);
  await slider.onchange(); assert.deepEqual(calls, [{ type: 'SetSettings', id: 'block', patch: { dropout: .35 } }]);
});

function fixture() {
  const leaf = { id: 'prompt', kind: 'item', source: '1girl', form: 'item', enabled: true, children: [] };
  const root = { id: 'root', kind: 'group', form: 'root', children: [leaf] };
  const session = { state: { selection: { block_id: 'root', node_id: 'prompt' } }, projection: { tree: root } };
  const container = new Node('div'), commands = [];
  const pane = new DetailsPane(container, { run: action => action(), async command(command) {
    commands.push(command);
    if (command.type === 'SetPromptSettings') {
      let item = root.children[0];
      if (item === leaf) { item = { id: 'wrapper', kind: 'group', form: 'brace', meta: { presentation: 'prompt' }, children: [leaf], enabled: true, settings: {} }; root.children = [item]; }
      for (const [key, value] of Object.entries(command.patch)) { if (value == null) delete item.settings[key]; else item.settings[key] = value; }
    }
    pane.render(session);
  } });
  pane.render(session);
  const extra = () => container.querySelector('.prompt-extra');
  const fold = () => container.querySelector('.prompt-fold');
  const add = async name => {
    assert.equal(name, 'Schedule');
    const lo = container.querySelectorAll('input[type=range]')[0];
    lo.value = '0.2'; await lo.onchange();
  };
  return { pane, container, session, leaf, commands, extra, fold, add };
}

function regionFixture() {
  const entries=[
    {kind:'base',mask_weight:0.5,cond_weight:1.1},
    {kind:'mask',mask:[0,0,0.5,1],feather:8,mask_weight:0.8,cond_weight:1.2,include_in_base:true},
    {kind:'imask',imask:2,feather:4,mask_weight:0.7,cond_weight:1.3},
    {kind:'fill',cond_weight:0.9,include_in_base:false},
  ].map(region=>({id:region.kind,kind:'group',form:'region_entry',enabled:true,effective:true,settings:{region},children:[]}));
  const owner={id:'regions',kind:'group',form:'region',enabled:true,effective:true,settings:{},children:entries};
  const root={id:'root',kind:'group',form:'root',children:[owner],enabled:true};
  const session={state:{selection:{block_id:owner.id}},projection:{tree:root}}, commands=[], located=[];
  const host={library:{data:{assets:[]}},run:action=>action(),locate:id=>located.push(id),context:{session},addPrompt(){},addBlock(){},toggleDetails(){},async command(command){
    commands.push(command);const entry=entries.find(entry=>entry.id===command.id);
    if(command.type==='SetRegion') entry.settings.region=structuredClone(command.region);
    if(command.type==='SetEnabled') entry.enabled=command.enabled;
    session.state.selection={block_id:entry.id};pane.render(session,{keepOwner:true});await pane.pendingRender;
  }};
  const container=new Node('div'),pane=new DetailsPane(container,host);pane.render(session);
  const panels=()=>container.querySelectorAll('.detail-region-entry');
  const panel=id=>panels().find(node=>node.dataset.regionEntryId===id);
  const labels=id=>panel(id).querySelectorAll('.plv4-field').map(node=>node.querySelector('label').textContent);
  const control=(id,label)=>panel(id).querySelectorAll('.plv4-field').find(node=>node.querySelector('label').textContent===label).querySelector('input,select');
  const edit=async(id,label,value)=>{const field=control(id,label);if(field.type==='checkbox') field.checked=value;else field.value=value;await field.onchange();};
  return {pane,container,owner,session,entries,commands,located,panels,panel,labels,control,edit};
}

test('Region container exposes each subregion settings with applicable PLv3 fields',()=>{
  const f=regionFixture();assert.deepEqual(f.panels().map(n=>n.dataset.regionEntryId),['base','mask','imask','fill']);
  assert.ok(f.panels().every(n=>n.open),'subregion settings start visible');
  assert.deepEqual(f.labels('base'),['Kind','mask_weight','cond_weight']);
  assert.deepEqual(f.labels('mask'),['Kind','Rectangle','feather','mask_weight','cond_weight','Include base']);
  assert.deepEqual(f.labels('imask'),['Kind','IMASK','feather','mask_weight','cond_weight','Include base']);
  assert.deepEqual(f.labels('fill'),['Kind','cond_weight','Include base']);
  assert.deepEqual(f.control('imask','Kind').children.map(n=>n.value),['base','mask','imask','fill']);
  assert.equal(f.control('imask','IMASK').value,'2');assert.equal(f.control('mask','Rectangle').value,'0, 0, 0.5, 1');
  assert.deepEqual(f.commands,[],'reading settings does not mutate a region header');
});

test('Editing subregion fields targets its own header while preserving parent detail, scroll and folds',async()=>{
  const f=regionFixture(),original=structuredClone(f.entries[0].settings.region);
  f.container.scrollTop=234;f.panel('mask').open=false;f.panel('mask').ontoggle();
  await f.edit('imask','IMASK','7');
  assert.deepEqual(f.commands.at(-1),{type:'SetRegion',id:'imask',region:{kind:'imask',imask:7,feather:4,mask_weight:0.7,cond_weight:1.3}});
  assert.equal(f.pane.ownerId,'regions');assert.equal(f.container.scrollTop,234);assert.equal(f.panel('mask').open,false);
  await f.edit('mask','Rectangle','0.1, 0.2, 0.4, 0.5');assert.deepEqual(f.commands.at(-1).region.mask,[0.1,0.2,0.4,0.5]);
  await f.edit('mask','feather','12');assert.equal(f.commands.at(-1).region.feather,12);
  await f.edit('fill','cond_weight','0.75');assert.equal(f.commands.at(-1).id,'fill');assert.equal(f.commands.at(-1).region.cond_weight,0.75);
  await f.edit('fill','Include base',true);assert.equal(f.commands.at(-1).region.include_in_base,true);
  await f.edit('imask','Kind','mask');assert.deepEqual(f.commands.at(-1),{type:'SetRegion',id:'imask',region:{kind:'mask',mask:[0,0,1,1]}});
  assert.ok(f.labels('imask').includes('Rectangle'));assert.ok(!f.labels('imask').includes('IMASK'));
  assert.deepEqual(f.entries[0].settings.region,original,'other region headers stay untouched');
  assert.equal(f.pane.ownerId,'regions');assert.equal(f.container.scrollTop,234);
  await f.panel('fill').querySelector('.detail-region-name').onclick();assert.deepEqual(f.located,['fill'],'explicit navigation remains available');
});

test('Off subregions retain editable settings, while an off Region ancestor disables child controls',async()=>{
  const f=regionFixture();const toggle=f.panel('imask').querySelector('input[type=checkbox]');toggle.checked=false;await toggle.onchange();
  assert.equal(f.entries[2].enabled,false);assert.equal(f.control('imask','IMASK').disabled,undefined);
  await f.edit('imask','IMASK','8');assert.equal(f.entries[2].enabled,false);assert.equal(f.entries[2].settings.region.imask,8);
  f.owner.enabled=false;f.owner.effective=false;f.pane.render(f.session,{keepOwner:true});
  for(const panel of f.panels()) {
    assert.ok(panel.querySelectorAll('.plv4-field').every(field=>field.querySelector('input,select').disabled));
    assert.equal(panel.querySelector('input[type=checkbox]').disabled,true);
  }
  assert.equal(f.pane.ownerId,'regions');
});

test('Details prompt fields attach shared autocomplete and related tags; numeric/name fields do not', () => {
  const { container } = fixture();
  const prompt = container.querySelector('.plv4-item-row').querySelectorAll('input').find(input => input.type === 'text');
  assert.equal(prompt._xyzTagACHooked, true);
  assert.equal(prompt._xyzRelated, true);
  assert.equal(container.querySelector('.detail-name')._xyzTagACHooked, undefined);
  assert.equal(container.querySelector('.prompt-setting-head').querySelector('input')._xyzTagACHooked, undefined);
});

test('each prompt has fold/delete controls and always shows Weight/Schedule without an add-setting menu', async () => {
  const { container, fold, extra, commands } = fixture();
  assert.equal(extra().hidden, true);
  assert.equal(container.querySelector('.plv4-item-row').querySelectorAll('button').length, 2);
  fold().onclick(); assert.equal(extra().hidden, false);
  assert.equal(container.querySelector('.prompt-add-setting'), null);
  assert.deepEqual(container.querySelectorAll('.prompt-setting').map(card => card.dataset.settingKind), ['weight', 'schedule']);
  assert.deepEqual(container.querySelectorAll('input[type=range]').map(node => node.value), ['0', '1']);
  assert.equal(extra().querySelector('.prompt-setting-head').querySelector('input').value, '1');
  assert.deepEqual(commands, [], 'opening the default Weight must not modify the document');
});

test('adding and dragging a prompt Schedule keeps it expanded across the settings wrapper and redraws', async () => {
  const { container, fold, extra, add, commands } = fixture();
  fold().onclick(); await add('Schedule');
  assert.equal(extra().hidden, false);
  assert.equal(container.querySelectorAll('.prompt-setting-head')[1].querySelector('label').textContent, 'Schedule');
  const [lo] = container.querySelectorAll('input[type=range]');
  lo.value = '0.35'; lo.oninput(); assert.equal(extra().hidden, false);
  await lo.onchange();
  assert.deepEqual(commands.at(-1).patch.schedule, [0.35, 1]);
  assert.equal(extra().hidden, false);
  assert.equal(container.querySelectorAll('input[type=range]')[0].value, '0.35');
  fold().onclick(); assert.equal(extra().hidden, true);
  fold().onclick(); assert.equal(extra().hidden, false);
});

test('Weight and Schedule have aligned labelled cards; single-prompt Region is unavailable', async () => {
  const { container, fold, add } = fixture(); fold().onclick();
  await add('Schedule');
  const cards = container.querySelectorAll('.prompt-setting');
  assert.deepEqual(cards.map(card => card.querySelector('label').textContent), ['Weight', 'Schedule']);
  assert.equal(cards[1].querySelector('button').textContent, '×');
  assert.equal(container.querySelector('.prompt-add-setting'), null);
});

test('legacy prompt Region shells and multi-prompt shells are actual block cards, not raw inline syntax', () => {
  const row = { kind: 'group', form: 'brace', meta: { presentation: 'prompt' }, children: [{ enabled: true }], settings: { schedule: [.2, .8] } };
  assert.equal(isBlock(row), false);
  assert.equal(isBlock({ ...row, settings: { ...row.settings, region: { kind: 'base' } } }), true);
  assert.equal(isBlock({ ...row, children: [{ enabled: true }, { enabled: true }] }), true);
  assert.equal(isBlock({ ...row, children: [{ enabled: false }] }), true);
});

test('clearing Schedule preserves Weight and leaves its full-range slider visible and expanded', async () => {
  const { container, fold, add, extra, commands } = fixture(); fold().onclick();
  const weight = container.querySelector('.prompt-setting-head').querySelector('input');
  weight.value = '1.2'; await weight.onchange(); await add('Schedule');
  const schedule = container.querySelectorAll('.prompt-setting').find(card => card.dataset.settingKind === 'schedule');
  await schedule.querySelector('button').onclick();
  assert.equal(extra().hidden, false);
  assert.deepEqual(commands.at(-1).patch, { schedule: null });
  assert.deepEqual(container.querySelectorAll('input[type=range]').map(node => node.value), ['0', '1']);
  assert.equal(container.querySelector('.prompt-setting-head').querySelector('input').value, '1.2');
});

test('prompt expansion is retained per document and does not leak to another tab with the same IDs', () => {
  const { pane, container, session, fold } = fixture(); fold().onclick();
  pane.render({ ...session }); assert.equal(container.querySelector('.prompt-extra').hidden, true);
  pane.render(session); assert.equal(container.querySelector('.prompt-extra').hidden, false);
});

test('a settings redraw preserves the detail page scroll', async () => {
  const { container, fold, add } = fixture(); fold().onclick();
  container.querySelector('.plv4-details').scrollTop = 127;
  await add('Schedule'); assert.equal(container.querySelector('.plv4-details').scrollTop, 127);
});

test('crossing schedule handles updates both boundaries in a valid order', async () => {
  const { pane } = fixture(), node = new Node('div'), calls = [];
  pane.interval(node, [0.2, 0.4], async (value, side) => calls.push([value, side]));
  const [lo, hi] = node.querySelectorAll('input[type=range]');
  lo.value = '0.8'; hi.value = '0.9'; await lo.onchange();
  assert.deepEqual(calls, [[0.9, 'end'], [0.8, 'start']]);
});

function pixels(expression, width) {
  const parts = expression.match(/^calc\(([-\d.]+)% ([+-]) ([-\d.]+)px\)$/);
  assert.ok(parts, expression);
  return Number(parts[1]) * width / 100 + (parts[2] === '+' ? 1 : -1) * Number(parts[3]);
}
test('the selected rail ends coincide with native thumb centres at every interval and width', () => {
  for (const [a, b] of [[0, 1], [0, 0.35], [0.35, 0.85], [0.85, 1], [0.5, 0.5]]) {
    const slider = theme.dualSlider([a, b], () => {});
    const fill = slider.querySelector('.plv3-dual-fill');
    for (const width of [60, 140, 260]) {
      const left = pixels(fill.style.left, width), right = left + pixels(fill.style.width, width);
      assert.ok(Math.abs(left - (6.5 + (width - 13) * a)) < 1e-8);
      assert.ok(Math.abs(right - (6.5 + (width - 13) * b)) < 1e-8);
    }
  }
});

function poolFixture() {
  const leaf = (raw, id = raw) => ({ id, kind: 'text', form: 'item', source: raw, raw, enabled: true, children: [] });
  const tag = (folder, id, raw) => ({ kind: 'tag', name: raw, snapshot: leaf(raw,id), occurrence: [folder,id], source: { kind: 'tag', id } });
  const combo = { id: 'combo', kind: 'group', form: 'brace', enabled: true, children: [leaf('x'), { id: 'sub', kind: 'group', enabled: true, children: [leaf('y')] }] };
  const candidate = { kind: 'block', name: 'Combo', snapshot: combo, occurrence: ['L','combo'], source: { kind: 'block', id: 'combo', version: 1 } };
  const tree = [{ kind: 'class', id: 'P', name: 'P', children: [
    { kind: 'class', id: 'L', name: 'P.L', children: [tag('L','one','same'),candidate] },
    { kind: 'class', id: 'R', name: 'P.R', children: [tag('R','two','same')] },
  ] }];
  const owner = { id: 'owner', kind: 'group', form: 'brace', enabled: true, children: [{ id:'unbound', kind:'group', form:'brace', enabled:true, children:[leaf('same','local')] }] };
  const commands = [], requests = []; const session = {};
  const host = { context: { session }, entryTarget: async () => null, openFolder: async id => commands.push({open:id}), command: async command => commands.push(command) };
  const pane = new DetailsPane(new Node('div'),host); pane.token = 1;
  globalThis.poolRequest = async (action, args) => { requests.push({action,args}); return action === 'class_block' ? {snapshot:{...combo, meta:{pool:args.id}},source:{kind:'class',id:args.id}} : {candidates:tree}; };
  return {pane,owner,commands,requests,session,tree,container:new Node('div')};
}

test('Pool candidates persistently mark shared joined prompts without toggling existing content', async () => {
  const f=poolFixture(); await f.pane.candidates(f.session,f.owner,'P',f.container,1);
  assert.deepEqual(f.requests[0],{action:'candidates',args:{pool:'P',exclude_block:undefined}});
  const rows=f.container.querySelectorAll('.pool-candidate-prompt');
  assert.equal(rows.length,2);assert.ok(rows.every(row=>row.dataset.poolState==='joined'&&row.matches('.pool-joined')));
  assert.ok(rows.every(row=>row.querySelector('.pool-usage').textContent==='已添加'));
  await rows[1].querySelector('.pool-add').onclick();assert.deepEqual(f.commands,[]);
  assert.equal(f.container.querySelectorAll('input').length,0);
});

test('Folder subblock button uses the direct-layer fill endpoint and existing insertion command', async () => {
  const f=poolFixture(); await f.pane.candidates(f.session,f.owner,'P',f.container,1);
  const buttons=f.container.querySelectorAll('.pool-insert');
  assert.equal(buttons.length,2); await buttons[0].onclick();
  assert.deepEqual(f.requests.at(-1),{action:'class_block',args:{id:'L',fill:true}});
  assert.equal(f.commands[0].type,'InsertLibraryBlock'); assert.equal(f.commands[0].snapshot.meta.pool,'L'); assert.equal(f.commands[0].parent_id,'owner');
});

test('Pool saved blocks add as a whole and nested previews have no enable or edit controls', async () => {
  const f=poolFixture();await f.pane.candidates(f.session,f.owner,'P',f.container,1);
  const block=f.container.querySelector('.pool-block');
  assert.equal(block.querySelectorAll('input').length,0);
  assert.deepEqual(block.querySelectorAll('.pool-prompt-text').map(n=>n.textContent),['x','y']);
  assert.equal(block.querySelectorAll('.pool-add').length,1);
  await block.querySelector('.pool-add').onclick();
  assert.equal(f.commands[0].type,'EnableCandidate');assert.deepEqual(f.commands[0].occurrence,['L','combo']);
  assert.equal(f.commands[0].edge,'end');assert.equal(f.commands[0].parent_id,'owner');
});

test('A child with its own pool is excluded from parent prompt matching', async () => {
  const f=poolFixture();f.owner.children[0].meta={pool:'another'};
  await f.pane.candidates(f.session,f.owner,'P',f.container,1);
  const rows=f.container.querySelectorAll('.pool-candidate-prompt');assert.equal(rows.length,2);
  assert.ok(rows.every(row=>row.dataset.poolState==='unused'));
});

test('A stale candidate reply never renders into a different session', async () => {
  const f=poolFixture(); f.pane.host.context.session={};
  await f.pane.candidates(f.session,f.owner,'P',f.container,1); assert.equal(f.container.children.length,0);
});


test('A disabled owner block gates all Pool add actions while retaining joined status', async () => {
  const f=poolFixture();f.owner.enabled=false;
  await f.pane.candidates(f.session,f.owner,'P',f.container,1);
  const buttons=f.container.querySelectorAll('.pool-add');assert.equal(buttons.length,3);
  assert.ok(buttons.every(n=>n.disabled));assert.ok(f.container.querySelectorAll('.pool-insert').every(n=>n.disabled));
  assert.ok(f.container.querySelectorAll('.pool-candidate-prompt').every(n=>n.dataset.poolState==='joined'));
});

test('Details commits PLv3 clean items and normalizes Chinese prompt separators before parsing', async () => {
  const {container,commands}=fixture();
  const field=container.querySelector('.detail-prompt-row').children[1];
  field.value=' ， solo， blonde hair, ';await field.onchange();
  assert.deepEqual(commands.at(-1),{type:'ReplaceItem',id:'prompt',text:'solo, blonde hair'});
  field.value='solo, ';await field.onchange();
  assert.equal(commands.at(-1).text,'solo');
});

test('Pool folders and saved blocks have distinct types and vertical read-only prompt rows', async () => {
  const f=poolFixture();await f.pane.candidates(f.session,f.owner,'P',f.container,1);
  const folders=f.container.querySelectorAll('.pool-class');
  assert.deepEqual(folders.map(n=>n.querySelector('.pool-branch-name').textContent),['P','L','R']);
  assert.deepEqual(folders.map(n=>n.dataset.depth),[0,1,1]);assert.deepEqual(folders.map(n=>n.open),[true,false,false]);
  const combo=f.container.querySelector('.pool-block');assert.equal(combo.open,false);
  assert.equal(combo.querySelector('.pool-type').textContent,'block');
  assert.equal(f.container.querySelectorAll('.detail-prompt-row').length,4);
  assert.equal(f.container.querySelectorAll('input').length,0);assert.equal(f.container.querySelectorAll('.pool-add').length,3);
});

test('Pool keeps Folder, Block and Prompt identity distinct across joined and unused candidates', async () => {
  const f=poolFixture(),branch=f.tree[0].children[0],combo=branch.children[1];
  const other=structuredClone(combo);other.name='Other';other.source.id='other';other.occurrence=['L','other'];
  const unused=structuredClone(branch.children[0]);unused.name=unused.snapshot.raw=unused.snapshot.source='new prompt';unused.source.id='new';unused.occurrence=['L','new'];
  branch.children.push(unused,other);
  const copy=structuredClone(combo.snapshot);copy.meta={source:combo.source,occurrence:combo.occurrence};f.owner.children.push(copy);
  await f.pane.candidates(f.session,f.owner,'P',f.container,1);
  assert.deepEqual(f.container.querySelectorAll('.pool-legend-item').map(n=>[n.dataset.kind,n.textContent]),[['class','Class'],['block','Block'],['tag','Prompt']]);
  for(const folder of f.container.querySelectorAll('.pool-class-head')) {
    assert.equal(folder.querySelector('.pool-kind-icon').dataset.iconKind,'class');
    assert.equal(folder.dataset.poolState,undefined);assert.equal(folder.querySelector('.pool-add'),null);
  }
  const blocks=f.container.querySelectorAll('.pool-block-head').filter(n=>n.dataset.poolCandidate);
  assert.deepEqual(blocks.map(n=>n.dataset.poolState),['joined','unused']);
  assert.ok(blocks.every(n=>n.querySelector('.pool-kind-icon').dataset.iconKind==='block'&&n.querySelector('.pool-type').textContent==='block'));
  const prompts=f.container.querySelectorAll('.pool-candidate-prompt');
  assert.ok(prompts.some(n=>n.dataset.poolState==='joined')&&prompts.some(n=>n.dataset.poolState==='unused'));
  assert.ok(prompts.every(n=>n.querySelector('.pool-kind-icon').dataset.iconKind==='tag'&&n.querySelector('.pool-type')===null));
  for(const row of [...blocks,...prompts]) {
    assert.equal(row.querySelector('.pool-usage').textContent,row.dataset.poolState==='joined'?'已添加':'未添加');
    assert.ok(row.querySelector('.pool-add'),'both types retain their add action');
  }
  assert.notEqual(blocks[0].querySelector('.pool-kind-icon').innerHTML,prompts[0].querySelector('.pool-kind-icon').innerHTML);
});

test('prompt and LoRA weight steppers keep direct editing and reset, with exact 0.05 steps', async () => {
  const f=fixture(); f.fold().onclick();
  const control=()=>f.container.querySelector('.detail-weight-control');
  assert.deepEqual(control().children.map(n=>n.tagName),['BUTTON','INPUT','BUTTON']);
  await control().children[2].onclick(); assert.deepEqual(f.commands.at(-1),{type:'SetPromptSettings',id:'prompt',patch:{weight:1.05}});
  await control().children[0].onclick(); assert.equal(f.commands.at(-1).patch.weight,1);
  control().querySelector('input').value='0.333'; await control().children[2].onclick(); assert.equal(f.commands.at(-1).patch.weight,0.383);
  const stale=control(); await Promise.all([stale.children[2].onclick(),stale.children[2].onclick()]);
  assert.deepEqual(f.commands.slice(-2).map(n=>n.patch.weight),[0.433,0.483]);
  const reset=f.container.querySelector('.prompt-setting-head').children.at(-1); await reset.onclick(); assert.equal(f.commands.at(-1).patch.weight,1);
  f.leaf.kind='lora';f.leaf.source='<lora:model:0.7>';f.session.projection.tree.children=[f.leaf];f.pane.render(f.session);
  assert.equal(control().querySelector('input').value,'0.7');
  await control().children[0].onclick();assert.equal(f.commands.at(-1).patch.weight,0.65);
});

test('block weight steppers honor the existing zero minimum without rounding typed precision',async()=>{
  const f=regionFixture();
  const control=f.container.querySelector('.detail-weight-control');
  f.pane.host.command=async command=>f.commands.push(command);
  await control.children[2].onclick(); assert.deepEqual(f.commands.at(-1),{type:'SetSettings',id:'regions',patch:{weight:1.05}});
  control.querySelector('input').value='0.02'; await control.children[0].onclick();assert.equal(f.commands.at(-1).patch.weight,0);
  await control.children[0].onclick();assert.equal(f.commands.at(-1).patch.weight,0);
  control.querySelector('input').value='1.234'; await control.querySelector('input').onchange();assert.equal(f.commands.at(-1).patch.weight,1.234);
});

test('both region weights have shared steppers, targeting only the chosen subregion',async()=>{
  const f=regionFixture();
  const control=(id,key)=>f.control(id,key).parentElement;
  for(const entry of f.entries) for(const key of ['mask_weight','cond_weight']) {
    if(entry.settings.region[key]==null) continue;
    const before=entry.settings.region[key], original=structuredClone(entry.settings.region);
    await control(entry.id,key).children[2].onclick();
    assert.deepEqual(f.commands.at(-1),{type:'SetRegion',id:entry.id,region:{...original,[key]:Number((before+.05).toFixed(12))}});
    await control(entry.id,key).children[0].onclick();assert.equal(f.commands.at(-1).region[key],before);
  }
  assert.equal(f.control('mask','feather').parentElement.className,'plv4-field setting-row','feather is a length, not a weight');
  assert.equal(f.pane.ownerId,'regions');
  f.owner.enabled=false;f.pane.render(f.session,{keepOwner:true});
  assert.ok(f.panels().every(panel=>panel.querySelectorAll('.detail-weight-control').every(control=>control.children.every(n=>n.disabled))));
});

test('Pool folding survives redraws for the same block and stays separate across sessions', async () => {
  const f=poolFixture(); await f.pane.candidates(f.session,f.owner,'P',f.container,1);
  const folder=f.container.querySelectorAll('.pool-class')[1];folder.open=true;folder.ontoggle();
  const combo=f.container.querySelector('.pool-block');combo.open=true;combo.ontoggle();
  f.container.replaceChildren();await f.pane.candidates(f.session,f.owner,'P',f.container,1);
  assert.equal(f.container.querySelectorAll('.pool-class')[1].open,true);
  assert.equal(f.container.querySelector('.pool-block').open,true);
  const other={};f.pane.host.context.session=other;f.container.replaceChildren();
  await f.pane.candidates(other,f.owner,'P',f.container,1);
  assert.equal(f.container.querySelectorAll('.pool-class')[1].open,false);
  assert.equal(f.container.querySelector('.pool-block').open,false);
});

test('Pool compacts empty Folder chains and inserts the terminal Folder without changing binding', async () => {
  const f=poolFixture(),items=f.tree[0].children[0].children;
  f.owner.meta={pool:'P'};
  f.tree[0].children=[{id:'M',kind:'class',name:'P.Middle',children:[{id:'L',kind:'class',name:'P.Middle.Leaf',children:items}]}];
  const before=structuredClone(f.tree);
  await f.pane.candidates(f.session,f.owner,'P',f.container,1);
  const folders=f.container.querySelectorAll('.pool-class');assert.equal(folders.length,1);
  assert.equal(folders[0].querySelector('.pool-branch-name').textContent,'P / Middle / Leaf');assert.equal(folders[0].open,true);
  assert.deepEqual(JSON.parse(folders[0].dataset.folderChain),['P','M','L']);assert.equal(folders[0].dataset.actualDepth,0);
  assert.equal(folders[0].querySelector('.pool-class-head').title,'第 1–3 层 · Class · P.Middle.Leaf');
  assert.equal(f.container.querySelectorAll('.pool-add').length,2);
  await f.container.querySelector('.pool-insert').onclick();assert.deepEqual(f.requests.at(-1),{action:'class_block',args:{id:'L',fill:true}});
  assert.equal(f.commands[0].snapshot.meta.pool,'L');assert.equal(f.owner.meta.pool,'P');assert.deepEqual(f.tree,before);
  const folds=f.container.querySelectorAll('.pool-fold-all');await folds[1].onclick();assert.ok(f.container.querySelectorAll('details').every(n=>!n.open));
  await folds[0].onclick();assert.ok(f.container.querySelectorAll('details').every(n=>n.open));
});

test('Pool filters do not compact Folders whose hidden candidates or branches make them nonempty', async () => {
  const f=poolFixture();
  const combo=f.tree[0].children[0].children[1];f.tree[0].children.push(combo);
  await f.pane.candidates(f.session,f.owner,'P',f.container,1);
  const kind=f.container.querySelector('.pool-filter-kind');kind.value='tag';kind.onchange();
  assert.deepEqual(f.container.querySelectorAll('.pool-class').map(n=>n.querySelector('.pool-branch-name').textContent),['P','L','R']);
  const usage=f.container.querySelector('.pool-filter-usage');usage.value='unused';usage.onchange();assert.equal(f.container.querySelectorAll('.pool-class').length,0);
  kind.value='block';kind.onchange();
  assert.deepEqual(f.container.querySelectorAll('.pool-class').map(n=>n.querySelector('.pool-branch-name').textContent),['P','L']);
});

function boundFixture() {
  const f=poolFixture();f.owner.meta={name:'Owner',pool:'P'};
  f.session.state={selection:{node_id:'owner',block_id:'owner'}};
  f.session.projection={tree:{id:'doc',kind:'group',form:'root',enabled:true,children:[f.owner]}};
  f.pane.host.library={data:{assets:[{id:'P',kind:'class',name:'Pool'}]},path:()=> 'Library.Pool'};
  f.container=f.pane.container;f.pane.render(f.session);return f;
}

test('bound blocks separate Content and Pool, while Content retains identical local order and controls', async () => {
  const f=boundFixture();await f.pane.pendingRender;
  const titles=()=>f.container.querySelectorAll('.section-title').map(n=>n.textContent);
  assert.equal(titles().filter(n=>n==='Content').length,1);assert.equal(titles().filter(n=>n==='Pool').length,1);
  const content=f.container.querySelector('.detail-content-section');
  const rowClass=content.querySelector('.detail-prompt-row').className, blockClass=content.querySelector('.pool-block-head').className;
  assert.equal(f.container.querySelector('.detail-pool-section').querySelectorAll('input').length,0);
  delete f.owner.meta.pool;f.pane.render(f.session,{keepOwner:true});
  assert.equal(titles().filter(n=>n==='Content').length,1);assert.ok(!titles().includes('Pool'));
  assert.equal(f.container.querySelector('.detail-prompt-row').className,rowClass);assert.equal(f.container.querySelector('.pool-block-head').className,blockClass);
  const child=f.container.querySelector('.detail-prompt-row');child.children[0].checked=false;await child.children[0].onchange();
  assert.deepEqual(f.commands.at(-1),{type:'SetEnabled',id:'local',enabled:false});
  const text=child.children[1];assert.equal(text.readOnly,false);text.value='edited child';await text.onchange();
  assert.deepEqual(f.commands.at(-1),{type:'ReplaceItem',id:'local',text:'edited child'});
});

test('outer sidebar and inner scroll survive toggles and delayed pool redraw without replacing the old tree early', async () => {
  const f=boundFixture();await f.pane.pendingRender;
  f.container.scrollTop=219;f.container.querySelector('.plv4-details').scrollTop=73;
  const old=f.container.children[0];let release;
  globalThis.poolRequest=()=>new Promise(resolve=>{release=resolve;});
  f.pane.render(f.session,{keepOwner:true});
  assert.equal(f.container.children[0],old,'loading must retain the existing scroll extent');
  f.container.scrollTop=245;old.scrollTop=91;
  release({candidates:f.tree});await f.pane.pendingRender;
  assert.notEqual(f.container.children[0],old);assert.equal(f.container.scrollTop,245);
  assert.equal(f.container.querySelector('.plv4-details').scrollTop,91);
});

test('enabling a pool block retains the detail owner and renders the actual edited copy with all its subcontent', async () => {
  const f=boundFixture();await f.pane.pendingRender;f.container.scrollTop=320;
  f.pane.host.command=async command=>{
    f.commands.push(command);
    if(command.type==='EnableCandidate') {
      const copy=structuredClone(command.snapshot);copy.id='added';copy.meta={name:'My copy',occurrence:command.occurrence};
      copy.children.push({id:'extra',kind:'text',form:'item',source:'local edit',raw:'local edit',enabled:true,children:[]});
      f.owner.children.push(copy);f.session.state.selection={node_id:'added',block_id:'added'};
    }
    f.pane.render(f.session,{keepOwner:true});await f.pane.pendingRender;
  };
  const block=f.container.querySelector('.detail-pool-section').querySelectorAll('.pool-block-head').find(head=>head.querySelector('.pool-branch-name').textContent==='Combo');
  await block.querySelector('.pool-add').onclick();
  assert.equal(f.pane.ownerId,'owner');assert.equal(f.container.scrollTop,320);
  assert.equal(f.container.querySelector('input').value,'Owner');
  assert.equal(f.container.querySelectorAll('.detail-prompt-row').filter(row=>row.dataset.tagText==='local edit').length,1);
  assert.ok(f.container.querySelectorAll('.pool-branch-name').some(n=>n.textContent==='My copy'));
  f.pane.render(f.session);await f.pane.pendingRender;assert.equal(f.pane.ownerId,'added','explicit navigation may follow selection');
});

test('an existing disabled prompt stays persistently marked and closed when Pool add is clicked', async () => {
  const f=poolFixture(),leaf=f.owner.children[0].children[0];leaf.enabled=false;leaf.effective=false;
  await f.pane.candidates(f.session,f.owner,'P',f.container,1);
  const rows=f.container.querySelectorAll('.pool-candidate-prompt');assert.equal(rows.length,2);
  assert.ok(rows.every(n=>n.dataset.poolState==='joined'&&n.matches('.pool-joined')));
  assert.ok(rows.every(n=>n.querySelector('.pool-usage').textContent==='已添加'));
  await rows[0].querySelector('.pool-add').onclick();assert.deepEqual(f.commands,[]);assert.equal(leaf.enabled,false);
});

test('pool read failure leaves separate Content and its local subblocks editable', async () => {
  const f=boundFixture();await f.pane.pendingRender;
  globalThis.poolRequest=async()=>{throw new Error('offline');};
  f.pane.render(f.session,{keepOwner:true});await f.pane.pendingRender;
  assert.ok(f.container.querySelectorAll('.pool-help').some(n=>n.textContent.includes('池读取失败')));
  assert.equal(f.container.querySelector('.detail-prompt-row').children[1].value,'same');
  assert.equal(f.container.querySelector('.detail-prompt-row').children[1].readOnly,false);
});

test('Pool type and joined-state filters combine, preserve ancestors and restore fold state per owner', async () => {
  const f=boundFixture();await f.pane.pendingRender;
  const pool=()=>f.container.querySelector('.detail-pool-section');
  const set=(key,value)=>{const select=pool().querySelector('.pool-filter-'+key);select.value=value;select.onchange();};
  const used=f.owner.children[0].children[0];used.enabled=false;
  f.pane.render(f.session,{keepOwner:true});await f.pane.pendingRender;
  const folder=pool().querySelectorAll('.pool-class')[1];folder.open=true;folder.ontoggle();
  set('kind','tag');assert.equal(pool().querySelectorAll('.pool-add').length,2);assert.equal(pool().querySelectorAll('.pool-block').length,0);
  set('usage','unused');assert.equal(pool().querySelectorAll('.pool-add').length,0,'parked items are already joined');
  set('kind','block');assert.equal(pool().querySelectorAll('.pool-add').length,1);
  assert.deepEqual(pool().querySelectorAll('.pool-class').map(n=>n.querySelector('.pool-branch-name').textContent),['Pool','L']);
  assert.ok(pool().querySelectorAll('.pool-class').every(n=>n.open),'matching ancestors start expanded');
  set('usage','all');set('kind','all');assert.equal(pool().querySelectorAll('.pool-class')[1].open,true);
  set('kind','block');f.pane.render(f.session,{keepOwner:true});await f.pane.pendingRender;
  assert.equal(pool().querySelector('.pool-filter-kind').value,'block');
  assert.equal(pool().querySelectorAll('.pool-add').length,1);
  const buttons=pool().querySelectorAll('.pool-fold-all');await buttons[0].onclick();
  assert.ok(pool().querySelectorAll('details').every(n=>n.open));await buttons[1].onclick();
  assert.ok(pool().querySelectorAll('details').every(n=>!n.open));
});

test('Content order and Pool persistent state follow toggles and deletion without changing the detail owner', async () => {
  const f=boundFixture();await f.pane.pendingRender;
  const before={id:'before',kind:'text',source:'before',enabled:true,children:[]};
  const after={id:'after',kind:'text',source:'after',enabled:false,children:[]};
  f.owner.children.unshift(before);f.owner.children.push(after);
  const paint=async()=>{f.pane.render(f.session,{keepOwner:true});await f.pane.pendingRender;};await paint();
  const content=()=>f.container.querySelector('.detail-content-section');
  assert.deepEqual(content().querySelectorAll('.detail-prompt-row').map(n=>n.dataset.promptId),['before','local','after']);
  assert.ok(content().querySelectorAll('.detail-prompt-row')[2].matches('.detail-content-disabled'));
  const deleteBlock=content().querySelectorAll('button').find(n=>n.dataset.deleteBlock);
  await deleteBlock.onclick();assert.deepEqual(f.commands.at(-1),{type:'Delete',id:f.owner.children[1].id});
  f.owner.children[1].children[0].enabled=false;await paint();
  const rows=()=>f.container.querySelector('.detail-pool-section').querySelectorAll('.pool-candidate-prompt');
  assert.ok(rows().every(n=>n.dataset.poolState==='joined'&&n.matches('.pool-joined')));
  const prior=f.commands.length;await rows()[0].querySelector('.pool-add').onclick();assert.equal(f.commands.length,prior);
  assert.ok(content().querySelectorAll('.detail-prompt-row').find(n=>n.dataset.promptId==='local').matches('.pool-highlight'));
  f.owner.children[1].children=[];await paint();assert.ok(rows().every(n=>n.dataset.poolState==='unused'));
  assert.equal(f.pane.ownerId,'owner');
});

test('Prompt matching ignores local attention and Schedule while block matching uses source identity across moves', async () => {
  const f=poolFixture();
  const leaf=f.owner.children[0].children[0];
  f.owner.children[0].children=[{id:'weighted',kind:'group',form:'paren',enabled:true,settings:{weight:1.5},children:[leaf]}];
  const block=structuredClone(f.tree[0].children[0].children[1].snapshot);
  block.meta={source:{kind:'block',id:'combo'},occurrence:['different-folder','combo']};f.owner.children.push(block);
  await f.pane.candidates(f.session,f.owner,'P',f.container,1);
  assert.ok(f.container.querySelectorAll('.pool-candidate-prompt').every(n=>n.dataset.poolState==='joined'));
  const head=f.container.querySelector('.pool-block-head');assert.equal(head.dataset.poolState,'joined');
  await head.querySelector('.pool-add').onclick();assert.deepEqual(f.commands,[]);
  const joinedClass=head.className, joinedLabel=head.querySelector('.pool-usage').textContent;
  block.enabled=false;f.container.replaceChildren();
  await f.pane.candidates(f.session,f.owner,'P',f.container,1);
  const closedHead=f.container.querySelector('.pool-block-head');
  assert.equal(closedHead.dataset.poolState,'joined');assert.equal(closedHead.className,joinedClass);
  assert.equal(closedHead.querySelector('.pool-usage').textContent,joinedLabel);assert.equal(joinedLabel,'已添加');
  await closedHead.querySelector('.pool-add').onclick();assert.deepEqual(f.commands,[]);assert.equal(block.enabled,false);
});

test('queued Pool adds recheck the live tree and cannot duplicate the same prompt from sibling folders', async () => {
  const f=boundFixture();await f.pane.pendingRender;
  for(const folder of f.tree[0].children) { const tag=folder.children.find(n=>n.kind==='tag');tag.snapshot.raw=tag.snapshot.source=tag.name='new prompt'; }
  f.pane.host.command=async command=>{
    f.commands.push(command);const copy=structuredClone(command.snapshot);copy.id='added';copy.meta={source:command.source,occurrence:command.occurrence};f.owner.children.push(copy);
  };
  f.pane.render(f.session,{keepOwner:true});await f.pane.pendingRender;
  const rows=f.container.querySelector('.detail-pool-section').querySelectorAll('.pool-candidate-prompt');
  await Promise.all(rows.map(row=>row.querySelector('.pool-add').onclick()));
  assert.equal(f.commands.length,1);assert.equal(f.commands[0].edge,'end');
  assert.equal(f.owner.children.filter(n=>n.source==='new prompt').length,1);
});

test('serialized pool leaves without children render as candidates, including nested saved block prompts', async () => {
  const f=boundFixture();await f.pane.pendingRender;
  const compact=node=>{
    delete node.source;
    if(node.kind!=='group') delete node.children;
    else node.children.forEach(compact);
  };
  const visit=candidate=>{if(candidate.snapshot) compact(candidate.snapshot);else candidate.children.forEach(visit);};
  f.tree.forEach(visit);
  f.pane.render(f.session,{keepOwner:true});await f.pane.pendingRender;
  assert.ok(!f.container.querySelectorAll('.pool-help').some(node=>node.textContent.includes('池读取失败')));
  const block=f.container.querySelector('.detail-pool-section').querySelectorAll('.pool-block-head').find(head=>head.querySelector('.pool-branch-name').textContent==='Combo');
  assert.ok(block);
  const rows=block.parentElement.querySelectorAll('.detail-prompt-row');
  assert.deepEqual(rows.map(row=>row.querySelector('.pool-prompt-text').textContent),['x','y']);
  assert.equal(block.parentElement.querySelectorAll('input').length,0);
  await block.querySelector('.pool-add').onclick();
  assert.equal(f.commands.at(-1).type,'EnableCandidate');
  assert.equal(f.commands.at(-1).snapshot.children[0].children,undefined,'rendering must not rewrite the saved snapshot');
});

test('real offline Library candidates render loose prompts and nested block leaves without pool fallback', {skip:!process.env.PLV4_TEST_PYTHON}, async () => {
  const script=`
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from prompt_library_v4.assets import AssetLibrary
from prompt_library_v4.model import EditorState
with TemporaryDirectory() as directory:
    library=AssetLibrary(Path(directory)/'pool.db')
    try:
        pool=library.mutate({'action':'save_class','name':'Pool'})['id']
        library.mutate({'action':'save_tag','parent_id':pool,'text':'cat'})
        library.mutate({'action':'save_tag','parent_id':pool,'text':'(fox:1.2)'})
        snapshot=EditorState.create(text='{ dog, { bird }, <lora:model:0.7> }').doc.root.children[0].to_json()
        library.mutate({'action':'save_block','name':'Animals','snapshot':{**snapshot,'meta':{'pool':pool}}})
        print(json.dumps(library.read('candidates',pool=pool)))
    finally:
        library.close()
`;
  const result=spawnSync(process.env.PLV4_TEST_PYTHON,['-c',script],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const data=JSON.parse(result.stdout), pool=data.candidates[0].id;
  assert.equal(data.candidates[0].children.find(node=>node.name==='cat').snapshot.children,undefined);
  const f=boundFixture();await f.pane.pendingRender;
  f.owner.meta.pool=pool;f.pane.host.library.data.assets=[{id:pool,kind:'class',name:'Pool'}];
  globalThis.poolRequest=async()=>data;
  f.pane.render(f.session,{keepOwner:true});await f.pane.pendingRender;
  assert.ok(!f.container.querySelectorAll('.pool-help').some(node=>node.textContent.includes('池读取失败')));
  assert.ok(f.container.querySelectorAll('.pool-branch-name').some(node=>node.textContent==='Animals'));
  const values=f.container.querySelectorAll('.pool-prompt-text').map(row=>row.textContent);
  for(const value of ['cat','(fox:1.2)','dog','bird','<lora:model:0.7>']) assert.ok(values.includes(value),JSON.stringify(values));
});
