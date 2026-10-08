import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

async function load(file, dependencies = '') {
  const source = (await readFile(new URL(`../../js/plv4/${file}`, import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  return import('data:text/javascript;base64,' + Buffer.from(dependencies + source).toString('base64'));
}
globalThis.dragHelpers = await load('drop_preview.js');
globalThis.detailHelpers = await load('details.js');
const { BlockView } = await load('block_view.js', 'const {blockPlacement,nearestBlockBoundary,dropLocation}=globalThis.dragHelpers; const {indexTree,nameOf}=globalThis.detailHelpers;');
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
