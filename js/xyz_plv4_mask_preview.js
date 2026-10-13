import {app} from '../../../scripts/app.js';
import {api} from '../../../scripts/api.js';
import {maskRequest,MASK_EVENT,maskStyles} from './plv4/mask_library.js';

let epoch=0;
const live=new Set();
function watchGraph(graph) {
  if(!graph||graph.__xyzMaskWatch)return;graph.__xyzMaskWatch=true;
  const changed=graph.onConnectionChange;
  graph.onConnectionChange=function(){const result=changed?.apply(this,arguments);for(const state of live)if(state.node.graph===this&&!state.node.__maskSync)state.refresh();return result;};
}
function widget(node,name){return node.widgets?.find(w=>w.name===name);}
export function upstream(node) {
  const graph=node.graph;let input=node.inputs?.find(i=>i.name==='mask_bundle'),link=input?.link,seen=new Set();
  while(link!=null&&!seen.has(link)){seen.add(link);const edge=graph.links?.[link]||graph._links?.get?.(link);if(!edge)return null;const source=graph.getNodeById(edge.origin_id);if(!source)return null;
    if(source.comfyClass?.includes('Library V4'))return {node:source,link:input.link};
    if(!source.comfyClass?.includes('Reroute')&&source.type!=='Reroute')return null;link=source.inputs?.[0]?.link;
  }return null;
}
export function syncMaskOutputs(node,items) {
  if(node.__maskSync)return;node.__maskSync=true;
  try {
    const graph=node.graph, old=(node.outputs||[]).slice(1),connections=new Map();
    old.forEach(slot=>{const key=slot.mask_key;if(!key)return;const links=(slot.links||[]).map(id=>graph?.links?.[id]||graph?._links?.get?.(id)).filter(Boolean).map(link=>({target:graph.getNodeById(link.target_id),slot:link.target_slot}));connections.set(key,links);});
    const rows=items.map(i=>({key:i.key,label:i.label,unused:false}));
    for(const slot of old)if(slot.mask_key&&!rows.some(r=>r.key===slot.mask_key)&&connections.get(slot.mask_key)?.length)rows.push({key:slot.mask_key,label:slot.name.replace(/ · (?:Unused|未使用)$/, ''),unused:true});
    const same=rows.length===old.length&&rows.every((r,i)=>r.key===old[i].mask_key);
    if(!node.outputs?.length)node.addOutput('preview','IMAGE');
    if(!same){while(node.outputs.length>1)node.removeOutput(node.outputs.length-1);for(const row of rows){node.addOutput(row.label+(row.unused?' · Unused':''),'MASK');node.outputs.at(-1).mask_key=row.key;}rows.forEach((row,i)=>{for(const connection of connections.get(row.key)||[])if(connection.target?.graph===graph)node.connect(i+1,connection.target,connection.slot);});}
    else rows.forEach((row,i)=>{node.outputs[i+1].name=row.label+(row.unused?' · Unused':'');});
    const keys=widget(node,'slot_keys');if(keys)keys.value=JSON.stringify(rows.map(r=>r.key));graph?.setDirtyCanvas(true,true);
  }finally{node.__maskSync=false;}
}

function install(node) {
  watchGraph(node.graph||app.graph);
  if(node.__maskLive)return;maskStyles();const box=document.createElement('div');box.className='xyz-plv4-mask-node';const image=document.createElement('img'),status=document.createElement('span');image.alt='Current mask preview';image.hidden=true;status.textContent='Connect a PLV4 mask_bundle';box.append(image,status);
  const dom=node.addDOMWidget('plv4_mask_preview','custom',box,{serialize:false,getValue:()=>'',setValue:()=>{}});dom.computeSize=()=>[220,230];dom.computeLayoutSize=undefined;
  const keys=widget(node,'slot_keys');if(keys){keys.hidden=true;keys.computeSize=()=>[0,-4];if(keys.inputEl)keys.inputEl.style.display='none';}
  const state=node.__maskLive={node,image,status,token:0,controller:null,pending:false};live.add(state);
  state.refresh=()=>{
    if(state.pending||node.__maskSync)return;state.pending=true;
    queueMicrotask(async()=>{state.pending=false;const token=++state.token;state.controller?.abort();const source=upstream(node),graph=node.graph,graphEpoch=epoch;state.controller=new AbortController();
      const valid=()=>live.has(state)&&node.graph===graph&&epoch===graphEpoch&&token===state.token&&upstream(node)?.node===source?.node&&upstream(node)?.link===source?.link;
      if(!source){image.hidden=true;status.textContent='No connected PLV4 node';syncMaskOutputs(node,[]);return;}
      try{let context=window.plv4?.window?.sessions.contexts.get(source.node),snapshot=context?.session.state;
        if(!snapshot){const doc=widget(source.node,'doc')?.value;const opened=await fetch('/xyz/plv4/document/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(doc?{doc:JSON.parse(doc)}:{text:widget(source.node,'text')?.value||''}),signal:state.controller.signal}).then(r=>r.json());if(!opened.ok)throw new Error(opened.error);snapshot=opened.state;}
        if(context?.raw!=null&&context.raw!==context.session.text)throw new Error('Finish editing the prompt to update its mask preview.');
        const result=await maskRequest('preview',{state:snapshot},state.controller.signal);if(!valid())return;
        image.src=result.preview;image.hidden=false;status.textContent=`${result.bundle.items.length} active masks · Geometry preview`;syncMaskOutputs(node,result.bundle.items);
      }catch(error){if(valid()&&error.name!=='AbortError'){image.hidden=true;status.textContent=error.message;}}
    });
  };
  const resize=node.onResize;node.onResize=function(){const result=resize?.apply(this,arguments);box.style.height=`${Math.max(180,this.size[1]-90-(this.outputs?.length||1)*20)}px`;return result;};
  const connected=node.onConnectionsChange;node.onConnectionsChange=function(){const result=connected?.apply(this,arguments);if(!this.__maskSync)state.refresh();return result;};
  const configure=node.onConfigure;node.onConfigure=function(){const result=configure?.apply(this,arguments);const saved=JSON.parse(widget(this,'slot_keys')?.value||'[]');this.outputs?.slice(1).forEach((slot,i)=>{slot.mask_key??=saved[i];});state.refresh();return result;};
  const removed=node.onRemoved;node.onRemoved=function(){live.delete(state);++state.token;state.controller?.abort();box.remove();return removed?.apply(this,arguments);};
  state.refresh();
}

app.registerExtension({name:'XYZNodes.PLV4Masks',nodeCreated(node){
  if(node.comfyClass==='XYZ PLV4 Mask Preview')install(node);
  if(node.comfyClass==='XYZ PLV4 Attach Masks'){
    const box=document.createElement('div');box.style.cssText='font:12px sans-serif;white-space:pre-wrap;color:#edb98b';const dom=node.addDOMWidget('mask_warning','custom',box,{serialize:false});dom.computeSize=()=>[220,box.textContent?55:18];dom.computeLayoutSize=undefined;
    const executed=node.onExecuted;node.onExecuted=function(message){const result=executed?.apply(this,arguments);box.textContent=message.mask_warning?.[0]||'';return result;};
  }
},beforeConfigureGraph(){++epoch;for(const state of live){++state.token;state.controller?.abort();}},afterConfigureGraph(){watchGraph(app.graph);for(const state of live)state.refresh();},setup(){
  watchGraph(app.graph);
  const refresh=()=>{for(const state of live)state.refresh();};window.addEventListener(MASK_EVENT,refresh);window.addEventListener('xyz-plv4-document-changed',refresh);document.addEventListener('plv3:node-edited',refresh);
  api.addEventListener('graphChanged',refresh);
}});
