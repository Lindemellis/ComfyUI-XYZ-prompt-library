import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';

const extension=await readFile(new URL('../../js/xyz_plv4_mask_preview.js',import.meta.url),'utf8');
const source=extension.replace(/^import .*;\r?\n/gm,'');
const module=await import('data:text/javascript;base64,'+Buffer.from('const app={registerExtension(){}};\n'+source).toString('base64'));
const sessionSource=await readFile(new URL('../../js/plv4/document_session.js',import.meta.url),'utf8');
const {DocumentSession}=await import('data:text/javascript;base64,'+Buffer.from(sessionSource).toString('base64'));
const colorSource=(await readFile(new URL('../../js/plv4/mask_ui.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'');
const {nextMaskColor}=await import('data:text/javascript;base64,'+Buffer.from(colorSource).toString('base64'));

test('new masks maximize color separation and remain unique beyond the palette',()=>{
  const masks=[];
  for(let i=0;i<40;i++){
    const color=nextMaskColor(masks);
    assert.match(color,/^#[0-9a-f]{6}$/);
    assert.ok(!masks.some(mask=>mask.color===color));
    masks.push({color});
  }
  // The first added mask after blue comes from the opposite warm color family.
  const rgb=masks[1].color.match(/[0-9a-f]{2}/g).map(v=>parseInt(v,16));
  assert.ok(rgb[0]>rgb[2]);
  assert.equal(nextMaskColor(masks),nextMaskColor([...masks].reverse()));
});

test('manual colors participate in automatic selection regardless of hex case',()=>{
  const used=[{color:'#77A8F3'},{color:'#FFFFFF'},{color:'#ED786E'}];
  assert.ok(!used.some(mask=>mask.color.toLowerCase()===nextMaskColor(used)));
});

function graphFixture(){
  const sink={id:2,inputs:[{link:null}]};
  const graph={links:{},getNodeById(id){return id===2?sink:null;},setDirtyCanvas(){}};sink.graph=graph;
  let sequence=0;
  const node={id:1,graph,outputs:[{name:'preview',type:'IMAGE',links:[]}],widgets:[{name:'slot_keys',value:'[]'}],
    addOutput(name,type){this.outputs.push({name,type,links:[]});},
    removeOutput(index){for(const id of this.outputs[index].links){const link=graph.links[id];if(link)sink.inputs[link.target_slot].link=null;delete graph.links[id];}this.outputs.splice(index,1);},
    connect(index,target,slot){const id=++sequence;graph.links[id]={origin_id:1,origin_slot:index,target_id:target.id,target_slot:slot};this.outputs[index].links.push(id);target.inputs[slot].link=id;}}
  return {node,sink,graph};
}

test('resource reorder restores each link by key; temporary removal emits an unused slot',()=>{
  const {node,sink,graph}=graphFixture();const a={key:'rectangle:one:a',label:'A'},b={key:'picture:two:rgb:ff0000',label:'B'};
  module.syncMaskOutputs(node,[a,b]);node.connect(2,sink,0);
  module.syncMaskOutputs(node,[b,a]);
  assert.equal(graph.links[sink.inputs[0].link].origin_slot,1);
  assert.equal(node.outputs[1].mask_key,b.key);
  module.syncMaskOutputs(node,[a]);
  assert.equal(node.outputs[2].mask_key,b.key);assert.match(node.outputs[2].name,/Unused/);
  assert.equal(graph.links[sink.inputs[0].link].origin_slot,2);
  module.syncMaskOutputs(node,[a,b]);
  assert.equal(node.outputs[2].name,'B');
  assert.deepEqual(JSON.parse(node.widgets[0].value),[a.key,b.key]);
  assert.equal(node.outputs[0].type,'IMAGE');
});

test('an unlinked removed resource cannot transfer identity to its replacement',()=>{
  const {node}=graphFixture();module.syncMaskOutputs(node,[{key:'old',label:'Old'}]);
  module.syncMaskOutputs(node,[{key:'new',label:'New'}]);assert.deepEqual(node.outputs.slice(1).map(s=>s.mask_key),['new']);
});

test('external resource refresh advances revision but preserves both undo stacks',async()=>{
  const opened={state:{doc:{root:{id:'i1',meta:{}},next_id:2},text:'old',revision:2,valid:true,selection:{}},projection:{revision:2,tree:null}};
  const session=new DocumentSession(opened);session.past.push(structuredClone(opened));session.future.push(structuredClone(opened));
  const request=async(_,body)=>{const state=structuredClone(body.state);state.text='new';state.doc.root.meta.resolved='new';return{state,projection:{revision:state.revision,tree:null}};};
  await session.resolveMasks(request);assert.equal(session.revision,3);assert.equal(session.text,'new');assert.equal(session.past.length,1);assert.equal(session.future.length,1);
  await session.resolveMasks(request);assert.equal(session.revision,3);
});

test('disposed sessions reject queued resource refreshes',async()=>{
  const session=new DocumentSession({state:{doc:{next_id:2},revision:0},projection:{}});session.dispose();
  await assert.rejects(session.resolveMasks(()=>{throw new Error('must not run');}),/disposed/);
});
