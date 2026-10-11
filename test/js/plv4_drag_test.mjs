import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function load(file, dependencies = '') {
  const source = (await readFile(new URL(`../../js/plv4/${file}`, import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  return import('data:text/javascript;base64,' + Buffer.from(dependencies + source).toString('base64'));
}
globalThis.dragHelpers = await load('drop_preview.js');
globalThis.detailHelpers = await load('details.js');
const { BlockView } = await load('block_view.js', 'const {blockPlacement,nearestBlockBoundary,dropLocation,isEntry,isContainer,canInsertContainer,canDropBlock}=globalThis.dragHelpers; const {indexTree,nameOf}=globalThis.detailHelpers;');
const { dropLocation } = globalThis.dragHelpers;

function fixture({ library = false } = {}) {
  const group = (id, name, parent_id, children = []) => ({id,kind:'group',form:'brace',meta:{name},parent_id,children});
  const child = group('child', 'Sub', 'parent'), parent = group('parent', 'Outer', 'root', [child]);
  const root = {...group('root', '', null, [parent]),form:'root'};
  const map = globalThis.detailHelpers.indexTree(root);
  const node = (dataset, top, bottom, left = 0, kind = 'box', owner = null) => ({
    dataset, kind, classList: {contains: name => name === 'inline' && kind === 'inline'},
    getBoundingClientRect: () => ({top,bottom,left,right:300,width:300-left,height:bottom-top}),
    closest(selector) {
      if (selector === '[data-block-id]') return kind === 'box' ? this : owner;
      if (selector === '.boundary[data-parent]') return ['slot','inline'].includes(kind) ? this : null;
      if (selector === '[data-prompt-id]') return kind === 'prompt' ? this : null;
      if (selector === '.plv4-run') return kind === 'run' ? this : null;
      return null;
    },
  });
  const outer = node({blockId:'parent'}, 20, 108), inner = node({blockId:'child'}, 50, 102, 20);
  // Last-child end, parent's end, and after-parent line lie in vertical order.
  const childEnd = node({parent:'child',before:''},98,100,40,'slot',inner);
  const parentEnd = node({parent:'parent',before:''},104,106,20,'slot',outer);
  const rootEnd = node({parent:'root',before:''},112,114,0,'slot');
  let hit = outer;
  const container = {contains: () => true,querySelectorAll: selector => selector === '[data-block-id]' ? [outer,inner] : [childEnd,parentEnd,rootEnd]};
  const view = Object.create(BlockView.prototype);
  Object.assign(view,{container,map,context:{asset:library ? {} : null,session:{projection:{tree:root}}}});
  globalThis.document = {elementFromPoint: () => hit};
  return {view,node,outer,inner,parent,child,childEnd,parentEnd,rootEnd,setHit(value){hit=value;}};
}

test('nested bottom destinations follow insertion-line order even when hit ownership alternates', () => {
  const f = fixture(), actual = [];
  for (let y = 96; y <= 115; y++) {
    f.setHit(y % 2 ? f.outer : f.inner);
    actual.push(f.view.dropTarget(100,y).parent.id);
  }
  const order = actual.map(id => ['child','parent','root'].indexOf(id));
  assert.ok(order.every((level,i) => !i || level >= order[i-1]), actual.join(','));
  assert.deepEqual([...new Set(actual)],['child','parent','root']);
});

test('a child insertion line wins above the parent ending and the line shown matches the command', () => {
  const f = fixture();f.setHit(f.outer);
  const child = f.view.dropTarget(100,99);
  assert.deepEqual(child.command,{parent_id:'child',edge:'end'});
  assert.equal(f.view.dropBoundary(child.parent.id,child.command),f.childEnd);
  assert.equal(dropLocation(child),'Document / Outer / Sub · 末尾');
  f.setHit(f.inner);
  const parent = f.view.dropTarget(100,105);
  assert.deepEqual(parent.command,{parent_id:'parent',edge:'end'});
  assert.equal(f.view.dropBoundary(parent.parent.id,parent.command),f.parentEnd);
  assert.equal(dropLocation(parent),'Document / Outer · 末尾');
});

test('bottom targeting still rejects own descendants and preserves the Library single-root constraint', () => {
  const f = fixture();
  assert.equal(f.view.dropTarget(100,99,new Set(['child'])),null);
  const lib = fixture({library:true});lib.setHit(lib.rootEnd);
  assert.deepEqual(lib.view.dropTarget(100,113).command,{parent_id:'parent',edge:'end'});
});

test('inline prompt boundaries and folded-card edges remain distinct from structural endings', () => {
  const f = fixture();
  const inline = f.node({parent:'child',before:'prompt'},97,114,80,'inline',f.inner);
  f.setHit(inline);
  assert.equal(f.view.dropTarget(80,99).placement,'inline');
  const collapsed = f.node({blockId:'child'},50,75,20);f.setHit(collapsed);
  assert.deepEqual(f.view.dropTarget(100,73).command,{parent_id:'parent',after_id:'child'});
});

for (const form of ['schedule', 'region']) {
  test(`${form} first-level boundaries reject external blocks but accept their own entry reorder`, () => {
    const f = fixture(); f.parent.form = form; f.child.form = `${form}_entry`;
    f.setHit(f.parentEnd);
    assert.equal(f.view.dropTarget(100,105), null, 'Library insert has no entry source');
    assert.equal(f.view.dropTarget(100,105,new Set(),{id:'external',form:'brace'}),null);
    assert.equal(f.view.dropTarget(100,105,new Set(),f.child).parent.id,'parent');
    assert.equal(f.view.dropTarget(100,105,new Set(),{...f.child,parent_id:'other'}),null);
    f.setHit(f.rootEnd);
    assert.equal(f.view.dropTarget(100,113,new Set(),f.child),null,'entry cannot leave its container');
    f.setHit(f.childEnd);
    assert.equal(f.view.dropTarget(100,99,new Set(),f.child),null,'entry cannot move into an entry body');
    assert.equal(f.view.dropTarget(100,99).parent.id,'child','Library blocks enter the entry body');
    assert.equal(f.view.dropTarget(100,99,new Set(),{id:'external',form:'brace'}).parent.id,'child');
  });
}

test('More offers grouped sibling/child containers, omits entry Save and invalid Region nesting', async () => {
  const f = fixture(), calls=[]; f.view.host={addBlock:(...args)=>calls.push(args)};
  const items=f.view.menuItems(f.child);
  assert.deepEqual(items.filter(([,action])=>Array.isArray(action)).map(([label])=>label),['添加同级 Block','添加子 Block']);
  const flatten=items=>items.flatMap(([label,action])=>Array.isArray(action)?action:[[label,action]]);
  for (const [label,action] of flatten(items)) if (['Schedule 容器','Region 容器'].includes(label)) await action();
  assert.deepEqual(calls,[['child',false,'schedule'],['child',false,'region'],['child',true,'schedule'],['child',true,'region']]);
  assert.equal(flatten(f.view.menuItems(f.parent,true)).filter(([label])=>label==='Schedule 容器').length,1,'Library root has no sibling creation');
  f.parent.form='region'; f.child.form='region_entry';
  const entry=f.view.menuItems(f.child);
  assert.ok(!entry.some(([label])=>['Save','添加同级 Block'].includes(label)));
  assert.ok(flatten(entry).some(([label])=>label==='Schedule 容器'));
  const normal={...f.child,form:'brace',settings:{region:{kind:'base'}}};
  assert.ok(!flatten(f.view.menuItems(normal)).some(([label])=>label==='Region 容器'));
});

test('AVG entries cannot move, outside blocks enter only their body, and More respects their boundary', () => {
  const f = fixture(); f.parent.form = 'avg'; f.child.form = 'avg_entry';
  f.setHit(f.parentEnd);
  assert.equal(f.view.dropTarget(100,105), null);
  assert.equal(f.view.dropTarget(100,105,new Set(),f.child), null);
  f.setHit(f.rootEnd);
  assert.equal(f.view.dropTarget(100,113,new Set(),f.child), null);
  f.setHit(f.childEnd);
  assert.equal(f.view.dropTarget(100,99).parent.id, 'child');
  const entryMenu = f.view.menuItems(f.child);
  assert.ok(!entryMenu.some(([label]) => ['Save','添加同级 Block'].includes(label)));
  assert.ok(entryMenu.some(([,action]) => Array.isArray(action)&&action.some(([label])=>label==='AVG 容器')));
  assert.ok(!f.view.menuItems(f.parent).some(([label]) => label === '绑定池'));
});
