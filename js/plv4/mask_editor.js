import {element,button,input,report} from './ui.js';
import {makeWindow} from '../plv3/theme.js';
import {maskStyles} from './mask_styles.js';
import {maskIconButton, maskIcon, nextMaskColor} from './mask_ui.js';
const copy=value=>JSON.parse(JSON.stringify(value));
const clamp=value=>Math.max(0,Math.min(1,value));
export function normaliseRect(value) {
  if (!Array.isArray(value) || value.length!==4 || value.some(v=>!Number.isFinite(v))) throw new Error('Enter four finite rectangle coordinates.');
  let [x1,x2,y1,y2]=value.map(clamp);[x1,x2]=[Math.min(x1,x2),Math.max(x1,x2)];[y1,y2]=[Math.min(y1,y2),Math.max(y1,y2)];
  const min=1/512;if(x2-x1<min){x1=Math.min(x1,1-min);x2=x1+min;}if(y2-y1<min){y1=Math.min(y1,1-min);y2=y1+min;}
  return [x1,x2,y1,y2];
}

export class MaskEditor {
  constructor({canvas,id=null,version=0,selected=null,request=null,onCommit=null,title=null}) {
    this.canvas=copy(canvas);this.id=id;this.version=version;this.selected=selected || canvas.masks[0]?.id;this.request=request;this.onCommit=onCommit;this.title=title || canvas.name;
    this.single=!id;this.past=[];this.future=[];this.alive=true;
  }
  open() {
    maskStyles();
    this.win=makeWindow({key:this.single?'xyz-mask-single':'xyz-mask-editor',title:this.title,defaults:{x:180,y:80,w:820,h:570},minW:460,minH:340,onResize:()=>this.draw()});
    this.win.el.classList.add('plv4','mask-editor');this.win.bar.append(maskIconButton('close','Close',()=>this.close()));
    this.layout=element('div','mask-editor-layout');this.side=element('div','mask-editor-side');this.boardWrap=element('div','mask-board-wrap');this.board=element('canvas','mask-board');this.board.width=this.board.height=512;this.board.tabIndex=0;
    this.board.setAttribute('aria-label','Rectangle canvas');
    const boardPanel=element('div','mask-board-panel'),boardLabel=element('div','mask-board-caption');
    boardLabel.append(element('span','','Canvas'),element('small','','Drag to draw · Eight handles to resize'));
    boardPanel.append(boardLabel,this.boardWrap);this.layout.append(this.side,boardPanel);this.boardWrap.append(this.board);this.win.body.append(this.layout);this.win.body.style.overflow='hidden';this.win.body.style.padding='0';
    this.observer=new ResizeObserver(()=>{cancelAnimationFrame(this.sizeFrame);this.sizeFrame=requestAnimationFrame(()=>{if(!this.alive)return;const r=this.boardWrap.getBoundingClientRect(),size=`${Math.max(1,Math.floor(Math.min(r.width,r.height)))}px`;if(this.board.style.width!==size)this.board.style.width=this.board.style.height=size;});});this.observer.observe(this.boardWrap);
    this.board.onpointerdown=e=>this.begin(e);this.board.onpointermove=e=>this.move(e);this.board.onpointerup=e=>this.end(e);this.board.onpointercancel=()=>this.cancel();
    this.keyboard=e=>{if(!this.win.el.contains(e.target)&&!this.gesture&&!this.sortCancel)return;e.stopPropagation();if(e.key==='Escape'){e.preventDefault();this.cancel();}if((e.ctrlKey||e.metaKey)&&['z','y'].includes(e.key.toLowerCase())){e.preventDefault();e.stopImmediatePropagation();(e.shiftKey||e.key.toLowerCase()==='y'?this.redo():this.undo()).catch(report);}};
    window.addEventListener('keydown',this.keyboard,true);this.render();this.win.show();return this;
  }
  async commit(before) {
    if(this.pending)return;
    this.pending=true;this.error.textContent='';this.render();
    const draft=copy(this.canvas),version=this.version;
    try {
      if(this.id){const result=await this.request('mutate',{action:'save',id:this.id,version,canvas:draft});this.version=result.result.version;}
      else await this.onCommit?.(draft.masks[0].coordinates);
      if(!this.alive)return;
      if(before){this.past.push(before);this.future=[];}
      this.failedBefore=null;
    } catch(error){if(this.alive){this.error.textContent=error.message;this.failedBefore=before;}throw error;}
    finally{this.pending=false;if(this.alive)this.render();}
  }
  async undo(){if(this.pending||!this.past.length)return;const target=this.past.at(-1),before=copy(this.canvas);this.canvas=copy(target);try{await this.commit(null);this.past.pop();this.future.push(before);this.render();}catch(error){this.canvas=before;this.render();throw error;}}
  async redo(){if(this.pending||!this.future.length)return;const target=this.future.at(-1),before=copy(this.canvas);this.canvas=copy(target);try{await this.commit(null);this.future.pop();this.past.push(before);this.render();}catch(error){this.canvas=before;this.render();throw error;}}
  mutate(action){if(this.pending)return;const before=copy(this.canvas);action();this.render();return this.commit(before);}
  add(coords=[.25,.75,.25,.75]){if(this.single)return;let number=1;while(this.canvas.masks.some(m=>m.name===`Mask ${number}`))number++;const mask={id:crypto.randomUUID(),name:`Mask ${number}`,coordinates:coords,color:nextMaskColor(this.canvas.masks)};this.canvas.masks.push(mask);this.selected=mask.id;}
  render() {
    if(!this.alive)return;const scrollTop=this.list?.scrollTop||0;this.side.replaceChildren();
    const bar=element('div','mask-editor-toolbar');
    if(!this.single){const add=button('Add mask','Add a centered rectangle',()=>this.mutate(()=>this.add()),'mask-add-button');add.disabled=this.pending;add.prepend(maskIcon('add'));bar.append(add);}
    else bar.append(element('span','mask-editor-section-title','Rectangle'));
    const history=element('div','mask-history');const undo=button('↶','Undo',()=>this.undo()),redo=button('↷','Redo',()=>this.redo());undo.disabled=this.pending||!this.past.length;redo.disabled=this.pending||!this.future.length;history.append(undo,redo);bar.append(history);this.side.append(bar);
    this.list=element('div','mask-rect-list');this.side.append(this.list);
    if(!this.canvas.masks.length)this.list.append(element('div','mask-empty','Draw on the canvas or add a mask.'));
    for(const mask of this.canvas.masks){
      const row=element('div','mask-rect-row');row.dataset.maskId=mask.id;row.classList.toggle('selected',mask.id===this.selected);
      if(!this.single){const handle=maskIconButton('grip','Drag to reorder',()=>{},'mask-drag');handle.onpointerdown=e=>this.sortBegin(e,mask.id,handle);row.append(handle);}
      const thumb=element('img');thumb.alt=mask.name;thumb.src=this.thumbnail(mask);thumb.onclick=()=>{this.selected=mask.id;this.render();};
      const name=input(mask.name,value=>this.mutate(()=>{mask.name=value;}));name.type='text';name.disabled=this.single||this.pending;name.onfocus=()=>this.select(mask.id);
      name.setAttribute('aria-label','Mask name');
      const color=input(mask.color,value=>this.mutate(()=>{mask.color=value;}),{type:'color',title:'Preview color'});color.disabled=this.pending;color.onfocus=()=>this.select(mask.id);color.setAttribute('aria-label','Preview color');
      row.append(thumb,name,color);
      if(!this.single){const remove=maskIconButton('delete','Delete mask',()=>this.mutate(()=>{this.canvas.masks=this.canvas.masks.filter(m=>m.id!==mask.id);this.selected=this.canvas.masks[0]?.id;}));remove.disabled=this.pending;row.append(remove);}
      row.onclick=e=>{if(e.target===row){this.selected=mask.id;this.render();}};this.list.append(row);
    }
    this.list.scrollTop=scrollTop;this.properties=element('div','mask-editor-properties');this.side.append(this.properties);this.renderCoordinates();
    const oldError=this.error?.textContent;this.error=element('div','mask-error',oldError || '');this.side.append(this.error);
    const retry=button('Retry save','Retry the current draft',()=>this.commit(this.failedBefore));retry.hidden=!this.failedBefore;this.side.append(retry);
    const footer=element('div','mask-editor-footer',this.pending?'Saving…':this.single?'Independent rectangle':`${this.canvas.masks.length} masks · Selected mask is shown on top`);this.side.append(footer);this.draw();
  }
  select(id){this.selected=id;this.side.querySelectorAll('.mask-rect-row').forEach(row=>row.classList.toggle('selected',row.dataset.maskId===id));this.renderCoordinates();this.draw();}
  renderCoordinates(){
    this.properties.replaceChildren();const selected=this.canvas.masks.find(m=>m.id===this.selected);this.properties.hidden=!selected;if(!selected)return;
    this.properties.append(element('div','mask-editor-section-title','Coordinates'));const coords=element('div','mask-coordinates');
    ['x1','x2','y1','y2'].forEach((name,i)=>{const label=element('label','',name),control=input(selected.coordinates[i],number=>this.mutate(()=>{const next=[...selected.coordinates];next[i]=number;selected.coordinates=normaliseRect(next);}),{type:'number',min:0,max:1,step:.001,title:`${name}: ${selected.coordinates[i]}`});control.disabled=this.pending;control.setAttribute('aria-label',name);label.append(control);coords.append(label);});this.properties.append(coords);
  }
  thumbnail(mask){const c=document.createElement('canvas');c.width=c.height=64;const ctx=c.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,64,64);const [x1,x2,y1,y2]=mask.coordinates;ctx.fillStyle=mask.color;ctx.fillRect(x1*64,y1*64,(x2-x1)*64,(y2-y1)*64);return c.toDataURL();}
  handles(mask){const [a,b,c,d]=mask.coordinates,x=(a+b)/2,y=(c+d)/2;return [[a,c,'nw'],[x,c,'n'],[b,c,'ne'],[b,y,'e'],[b,d,'se'],[x,d,'s'],[a,d,'sw'],[a,y,'w']];}
  draw(){if(!this.board)return;const ctx=this.board.getContext('2d');ctx.clearRect(0,0,512,512);ctx.fillStyle='white';ctx.fillRect(0,0,512,512);
    const selected=this.canvas.masks.find(m=>m.id===this.selected);
    const layers=this.canvas.masks.filter(m=>m!==selected).reverse();if(selected)layers.push(selected);
    for(const mask of layers){const [a,b,c,d]=mask.coordinates;ctx.fillStyle=mask.color;ctx.fillRect(a*512,c*512,(b-a)*512,(d-c)*512);}
    if(selected){const [a,b,c,d]=selected.coordinates;ctx.strokeStyle='#111';ctx.lineWidth=1;ctx.strokeRect(a*512,c*512,(b-a)*512,(d-c)*512);for(const [x,y]of this.handles(selected)){ctx.fillStyle='white';ctx.fillRect(x*512-4,y*512-4,8,8);ctx.strokeRect(x*512-4,y*512-4,8,8);}}}
  point(e){const r=this.board.getBoundingClientRect();return [clamp((e.clientX-r.left)/r.width),clamp((e.clientY-r.top)/r.height)];}
  begin(e){if(e.button!==0||this.pending)return;e.preventDefault();this.board.focus();const point=this.point(e),before=copy(this.canvas);let target=this.canvas.masks.find(m=>m.id===this.selected),mode=null;
    const tolerance=9/this.board.getBoundingClientRect().width;
    if(target)mode=this.handles(target).find(([x,y])=>Math.abs(x-point[0])<tolerance&&Math.abs(y-point[1])<tolerance)?.[2];
    if(!mode){const contains=m=>{const[a,b,c,d]=m.coordinates;return point[0]>=a&&point[0]<=b&&point[1]>=c&&point[1]<=d;};if(!target||!contains(target))target=this.canvas.masks.find(contains);mode=target?'move':'create';}
    if(!target){if(this.single)return;this.add(normaliseRect([point[0],point[0],point[1],point[1]]));target=this.canvas.masks.at(-1);}
    this.selected=target.id;this.gesture={point,before,mode,id:target.id,rect:[...target.coordinates],pointer:e.pointerId};this.board.setPointerCapture(e.pointerId);this.render();}
  move(e){const g=this.gesture;if(!g||g.pointer!==e.pointerId)return;e.preventDefault();const p=this.point(e),m=this.canvas.masks.find(m=>m.id===g.id),[a,b,c,d]=g.rect;let next=[a,b,c,d];
    if(g.mode==='create')next=[g.point[0],p[0],g.point[1],p[1]];
    else if(g.mode==='move'){const dx=Math.max(-a,Math.min(1-b,p[0]-g.point[0])),dy=Math.max(-c,Math.min(1-d,p[1]-g.point[1]));next=[a+dx,b+dx,c+dy,d+dy];}
    else{if(g.mode.includes('w'))next[0]=p[0];if(g.mode.includes('e'))next[1]=p[0];if(g.mode.includes('n'))next[2]=p[1];if(g.mode.includes('s'))next[3]=p[1];}
    m.coordinates=normaliseRect(next);this.draw();}
  end(e){const g=this.gesture;if(!g||e.pointerId!==g.pointer)return;this.move(e);this.gesture=null;this.board.releasePointerCapture(e.pointerId);if(JSON.stringify(g.before)!==JSON.stringify(this.canvas))this.commit(g.before).catch(report);else this.render();}
  cancel(){if(this.gesture){const g=this.gesture;this.canvas=g.before;this.gesture=null;if(this.board.hasPointerCapture(g.pointer))this.board.releasePointerCapture(g.pointer);this.render();}this.sortCancel?.();}
  sortBegin(e,id,handle){
    if(this.pending||e.button!==0)return;e.preventDefault();e.stopPropagation();handle.focus({preventScroll:true});
    const before=copy(this.canvas),row=handle.closest('.mask-rect-row'),marker=element('div','mask-sort-marker');
    marker.append(element('span','','Move here'));document.body.append(marker);marker.hidden=true;row.classList.add('sorting');handle.setPointerCapture(e.pointerId);
    let point={x:e.clientX,y:e.clientY},target=null,frame;
    const update=()=>{
      const bounds=this.list.getBoundingClientRect(),rows=[...this.list.querySelectorAll('.mask-rect-row')].filter(r=>r!==row);
      if(point.x<bounds.left-24||point.x>bounds.right+24){target=null;marker.hidden=true;return;}
      target=rows.findIndex(r=>{const rect=r.getBoundingClientRect();return point.y<rect.top+rect.height/2;});if(target<0)target=rows.length;
      const next=rows[target]?.getBoundingClientRect(),last=rows.at(-1)?.getBoundingClientRect();
      const y=next?next.top:last?last.bottom:bounds.top;
      marker.hidden=false;Object.assign(marker.style,{left:`${bounds.left+4}px`,width:`${Math.max(0,bounds.width-8)}px`,top:`${Math.max(bounds.top,Math.min(bounds.bottom,y))}px`});
    };
    const scroll=()=>{const r=this.list.getBoundingClientRect(),delta=point.y<r.top+26?-10:point.y>r.bottom-26?10:0;if(delta){this.list.scrollTop+=delta;update();}frame=requestAnimationFrame(scroll);};
    const move=ev=>{if(ev.pointerId!==e.pointerId)return;point={x:ev.clientX,y:ev.clientY};update();};
    const cleanup=()=>{cancelAnimationFrame(frame);marker.remove();row.classList.remove('sorting');handle.removeEventListener('pointermove',move);handle.removeEventListener('pointerup',end);handle.removeEventListener('pointercancel',cancel);if(handle.hasPointerCapture(e.pointerId))handle.releasePointerCapture(e.pointerId);this.sortCancel=null;};
    const end=ev=>{point={x:ev.clientX,y:ev.clientY};update();const index=target;cleanup();if(index==null)return;const from=this.canvas.masks.findIndex(m=>m.id===id);if(from===index)return;const [mask]=this.canvas.masks.splice(from,1);this.canvas.masks.splice(index,0,mask);this.selected=id;this.commit(before).catch(report);};
    const cancel=()=>{cleanup();this.render();};
    this.sortCancel=cancel;handle.addEventListener('pointermove',move);handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',cancel);frame=requestAnimationFrame(scroll);
  }
  close(){this.cancel();this.alive=false;this.observer?.disconnect();cancelAnimationFrame(this.sizeFrame);window.removeEventListener('keydown',this.keyboard,true);this.board.onpointerdown=this.board.onpointermove=this.board.onpointerup=this.board.onpointercancel=null;this.win.el.remove();}
}
