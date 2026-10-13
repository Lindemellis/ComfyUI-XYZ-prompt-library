import {element,button,input} from './ui.js';
import {maskRequest,maskStyles,cleanCanvas} from './mask_library.js';
import {MaskEditor} from './mask_editor.js';
import {maskIconButton} from './mask_ui.js';

let closeSelector=null;
export function closeMaskSelector(){closeSelector?.();}
export async function maskSelector(anchor,kind,onSelect) {
  closeSelector?.();maskStyles();
  const box=element('div','plv4 mask-selector');box.role='menu';const parents=element('div','mask-selector-canvases'),children=element('div','mask-selector-items');box.append(parents,children);document.body.append(box);
  const controller=new AbortController();
  const close=()=>{controller.abort();box.remove();document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',key,true);if(closeSelector===close)closeSelector=null;};
  const outside=e=>{if(!box.contains(e.target)&&e.target!==anchor)close();};
  const key=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();anchor.focus({preventScroll:true});}else if(box.contains(e.target)&&['ArrowDown','ArrowUp'].includes(e.key)){e.preventDefault();const buttons=[...e.target.parentElement.querySelectorAll('button')];const i=buttons.indexOf(e.target);buttons[(i+(e.key==='ArrowDown'?1:buttons.length-1))%buttons.length]?.focus();}else if(box.contains(e.target)&&e.key==='ArrowLeft'){e.preventDefault();parents.querySelector('button[aria-expanded=true]')?.focus();}else if(box.contains(e.target)&&e.key==='ArrowRight'){e.preventDefault();children.querySelector('button')?.focus();}};
  closeSelector=close;document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',key,true);
  const r=anchor.getBoundingClientRect(),width=Math.min(480,innerWidth-16),height=Math.min(480,Math.floor(innerHeight*.65));
  box.style.width=`${width}px`;box.style.height=`${height}px`;
  box.style.left=`${Math.max(8,Math.min(innerWidth-width-8,r.left-240))}px`;box.style.top=`${Math.max(8,Math.min(innerHeight-height-8,r.bottom+4))}px`;
  parents.append(element('small','mask-empty','Loading canvases…'));children.append(element('small','mask-empty','Choose a canvas to preview its masks.'));
  try {
    const data=await maskRequest('tree',{},controller.signal);if(controller.signal.aborted)return;parents.replaceChildren(element('div','mask-selector-heading','Canvas'));
    for(const canvas of data.canvases.filter(c=>c.kind===kind)) {
      const branch=button(canvas.name,canvas.error || canvas.name,()=>expand());branch.dataset.canvasId=canvas.id;branch.setAttribute('aria-haspopup','menu');branch.setAttribute('aria-expanded','false');const img=element('img','mask-thumb');if(canvas.preview)img.src=canvas.preview;img.alt=canvas.name;branch.prepend(img);
      const expand=()=>{parents.querySelectorAll('button').forEach(b=>b.setAttribute('aria-expanded','false'));branch.setAttribute('aria-expanded','true');children.replaceChildren(element('div','mask-selector-heading','Mask'));
        if(canvas.error)children.append(element('small','mask-error',canvas.error));
        for(const mask of canvas.masks){const choice=button(mask.name,mask.name,async()=>{close();await onSelect(canvas,mask);});choice.dataset.maskId=mask.id;const image=element('img');image.src=mask.preview;image.alt=mask.name;choice.prepend(image);children.append(choice);}
        if(!canvas.masks.length&&!canvas.error)children.append(element('small','','This canvas has no masks.'));
      };branch.onpointerenter=expand;branch.onfocus=expand;parents.append(branch);
    }
    if(!parents.querySelector('button'))parents.append(element('small','mask-empty','Create a canvas or refresh images in Mask Library.'));
  }catch(error){if(error.name!=='AbortError'){parents.replaceChildren(element('small','mask-error',error.message));}}
  return box;
}

export function regionMasks(section,row,host,value,apply) {
  if(!['mask','imask'].includes(value.kind))return;maskStyles();
  const session=host.context?.session,context=host.context,ref=row.meta?.mask_library;
  const valid=()=>host.context===context&&!session?._disposed;
  const run=action=>{if(!valid())throw new Error('The editing target has changed.');return host.run(action);};
  const command=data=>host.details.applyCommand(data,session);
  if(value.kind==='mask'){
    const coords=element('div','mask-coordinates');
    ['x1','x2','y1','y2'].forEach((name,i)=>{
      const label=element('label','',name),number=input(value.mask?.[i]??[0,1,0,1][i],v=>{
        if(ref)return;const mask=[...(value.mask||[0,1,0,1])];mask[i]=v;return apply({...value,mask});
      },{type:'number',min:0,max:1,step:.001,title:ref?'Linked coordinates · Edit the canvas to change them':name});
      number.readOnly=!!ref;number.setAttribute('aria-label',name);label.append(number);coords.append(label);
    });section.append(coords);
  }else if(!ref){
    const field=element('label','plv4-field setting-row'),index=input(value.imask??0,imask=>apply({...value,imask}),{type:'number',min:0,step:1,title:'IMASK index (zero-based)'});
    index.required=true;const change=index.onchange;index.onchange=()=>{if(index.reportValidity())return change();};
    index.setAttribute('aria-label','IMASK index');field.append(element('span','','IMASK'),index);section.append(field);
  }
  const controls=element('div','mask-region-control'),image=element('img');image.alt='Region mask preview';
  const info=element('div','mask-region-info'),actions=element('div','mask-region-actions');
  info.append(element('span','mask-region-state',ref?'Linked to Mask Library':'Independent mask'));
  if(value.kind==='mask'){
    const canvas=document.createElement('canvas');canvas.width=canvas.height=64;const ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,64,64);
    const[a,b,c,d]=value.mask||[0,1,0,1];ctx.fillStyle=ref?.fallback?.color||'#77a8f3';ctx.fillRect(a*64,c*64,(b-a)*64,(d-c)*64);image.src=canvas.toDataURL();controls.append(image);
  }
  if(ref){
    const canvasName=ref.canvas_name||ref.fallback?.path||'Canvas',maskName=ref.kind==='picture'?(ref.fallback?.presentation?.[ref.mask_id]?.name||(ref.mask_id==='alpha'?'Alpha':ref.mask_id.replace('rgb:','RGB #'))):ref.fallback?.name||ref.mask_id;
    const label=element('span','mask-link-label',`${canvasName} / ${maskName}`);info.append(label);
    if(ref.kind==='picture'){
      image.hidden=true;controls.append(image);const controller=new AbortController(),revision=session.revision;host.details.maskControllers??=new Set();host.details.maskControllers.add(controller);
      maskRequest('preview',{state:session.state},controller.signal).then(async result=>{
        if(!valid()||!controls.isConnected||session.revision!==revision)return;
        let item=result.bundle.items.find(item=>item.key===`picture:${ref.canvas_id}:${ref.mask_id}`);
        if(!item){
          // A bypassed Region keeps its link; its inspector can still show
          // the resource without adding it to the execution mask bundle.
          const data=await maskRequest('tree',{},controller.signal);
          if(!valid()||!controls.isConnected||session.revision!==revision)return;
          item=data.canvases.find(canvas=>canvas.id===ref.canvas_id)?.masks.find(mask=>mask.id===ref.mask_id);
        }
        if(item){image.src=item.preview;image.hidden=false;}
      }).catch(error=>{if(error.name!=='AbortError'&&valid()&&controls.isConnected)label.textContent=error.message;}).finally(()=>host.details.maskControllers.delete(controller));
    }
  }
  if(ref?.kind==='picture')actions.append(button('View canvas','Open linked image canvas',()=>run(async()=>{
    const data=await maskRequest('tree');if(!valid())return;
    const canvas=data.canvases.find(c=>c.id===ref.canvas_id);
    if(!canvas)throw new Error('The linked image canvas was removed.');
    host.masks.openCanvas(canvas,ref.mask_id);
  })));
  if(value.kind==='mask')actions.append(button(ref?'Edit canvas':'Edit rectangle',ref?'Edit linked canvas':'Edit rectangle',()=>run(async()=>{
    await host.flushEditor();if(!valid())return;
    if(ref){
      const data=await maskRequest('tree');if(!valid())return;const canvas=data.canvases.find(c=>c.id===ref.canvas_id);
      if(!canvas)throw new Error('The linked canvas was deleted. Unlink to edit the retained rectangle.');
      new MaskEditor({canvas:cleanCanvas(canvas),id:canvas.id,version:canvas.version,selected:ref.mask_id,request:maskRequest}).open();
    }else new MaskEditor({title:`${context.node?.title||context.asset?.name||'Block'} / ${row.meta?.name||'Region'}`,canvas:{name:'Region',kind:'rectangle',masks:[{id:'single',name:row.meta?.name||'Region',color:'#77a8f3',coordinates:value.mask||[0,1,0,1]}]},onCommit:coordinates=>{
      if(!valid())throw new Error('The editing target has changed.');return command({type:'SetRegion',id:row.id,region:{...value,mask:coordinates}});
    }}).open();
  })));
  const choose=button(ref?'Change mask':'Choose mask','Choose a Library mask',()=>maskSelector(choose,value.kind==='mask'?'rectangle':'picture',(canvas,mask)=>run(async()=>{
    await host.flushEditor();if(!valid())return;await command({type:'BindMaskLibrary',id:row.id,canvas_id:canvas.id,mask_id:mask.id,color:mask.color});
  })));
  // Keep the selector target intact while the native field commits on blur.
  choose.onpointerdown=e=>{if(e.button===0)e.preventDefault();};actions.append(choose);
  if(ref)actions.append(maskIconButton('unlink',ref.kind==='picture'?'Unlink and restore manual IMASK':'Unlink and keep coordinates',()=>run(()=>command({type:'UnbindMaskLibrary',id:row.id}))));
  info.append(actions);controls.append(info);section.append(controls);
}
