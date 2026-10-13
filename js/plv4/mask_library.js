import {element, button, input, report} from './ui.js';
import {makeWindow} from '../plv3/theme.js';
import {maskStyles} from './mask_styles.js';
export {maskStyles} from './mask_styles.js';
import {MaskEditor} from './mask_editor.js';
import {maskIconButton, maskIcon, showMaskForm, showMaskConfirm} from './mask_ui.js';

export const MASK_EVENT = 'xyz-plv4-masks-changed';
let pictureWindow=null;
export async function maskRequest(operation, body = {}, signal) {
  const response = await fetch(`/xyz/plv4/masks/${operation}`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body), signal});
  const result = await response.json();
  if (!response.ok || !result.ok) throw Object.assign(new Error(result.error || 'Mask Library request failed.'), {code:result.code});
  if (operation === 'mutate' || operation === 'tree' && body.refresh) window.dispatchEvent(new CustomEvent(MASK_EVENT));
  return result;
}

export function cleanCanvas(canvas) {
  const value = JSON.parse(JSON.stringify(canvas));
  for (const key of ['id','version','preview','fingerprint','error','has_alpha','deleted']) delete value[key];
  if (value.kind === 'picture') delete value.masks;
  else for (const mask of value.masks) delete mask.preview;
  return value;
}

export class MaskLibraryPanel {
  constructor(container) {
    maskStyles(); this.container=container; this.token=0; this.selected=null; this.folded=new Set();
    this.changed=()=>this.reload().catch(report); window.addEventListener(MASK_EVENT,this.changed);
    this.element=element('div','mask-library-panel'); container.append(this.element);
    const head=element('div','mask-library-head');this.title=element('div','library-title mask-library-title');
    this.title.append(element('span','mask-panel-title','Mask Library'));head.append(this.title);
    const tools=element('div','mask-library-tools');
    const create=button('New canvas','New rectangle canvas',()=>this.create(),'mask-new-canvas');create.prepend(maskIcon('add'));
    tools.append(create,maskIconButton('refresh','Refresh images',()=>this.reload(true)),maskIconButton('folder','Image directory',()=>this.directory()));head.append(tools);
    this.directoryLabel=element('button','mask-directory');this.directoryLabel.type='button';this.directoryLabel.title='Change image directory';this.directoryLabel.onclick=()=>this.directory().catch(report);head.append(this.directoryLabel);
    this.list=element('div','mask-library-list');this.element.append(head,this.list);
    this.reload().catch(report);
  }
  async reload(refresh=false) {
    const token=++this.token;this.controller?.abort();this.controller=new AbortController();
    let result;try{result=await maskRequest('tree',{refresh},this.controller.signal);}catch(error){if(error.name==='AbortError')return;throw error;}
    if(token!==this.token || this.disposed)return;
    this.data=result; const scroll=this.list.scrollTop || 0;this.list.replaceChildren();this.directoryLabel.textContent=`input/${result.directory}/`;
    for(const [kind,label] of [['rectangle','Rectangles'],['picture','Images']]) {
      const group=element('details','mask-group');group.open=!this.folded.has(kind);
      const canvases=result.canvases.filter(c=>c.kind===kind),summary=element('summary');summary.append(element('span','',label),element('small','mask-group-count',String(canvases.length)));group.append(summary);group.ontoggle=()=>{if(group.open)this.folded.delete(kind);else this.folded.add(kind);};
      for(const canvas of canvases) {
        const row=element('div','mask-canvas-row');row.dataset.canvasId=canvas.id;row.classList.toggle('selected',this.selected===canvas.id);
        const thumb=element('img','mask-thumb'); if(canvas.preview)thumb.src=canvas.preview;thumb.alt=canvas.name;
        const openCanvas=()=>{this.selected=canvas.id;this.list.querySelectorAll('.mask-canvas-row').forEach(r=>r.classList.toggle('selected',r.dataset.canvasId===canvas.id));return this.openCanvas(canvas);};
        const preview=button('',`Open ${canvas.name}`,openCanvas,'mask-canvas-preview');preview.append(thumb);
        const content=element('div','mask-canvas-info'),open=button(canvas.name,canvas.error || canvas.name,openCanvas,'mask-canvas-name');
        content.append(open,element('small','mask-canvas-description',canvas.error?'Unavailable':`${canvas.masks.length} ${canvas.masks.length===1?'mask':'masks'}`));
        const actions=element('div','mask-canvas-actions');
        actions.append(maskIconButton(kind==='rectangle'?'edit':'open',kind==='rectangle'?'Edit canvas':'View masks',openCanvas));
        actions.append(maskIconButton('rename','Rename canvas',()=>this.rename(canvas)));
        if(kind==='picture')actions.append(maskIconButton('settings','Extraction settings',()=>this.configure(canvas)),maskIconButton('folder','Relocate image',()=>this.relocate(canvas)));
        actions.append(maskIconButton('delete','Delete canvas',()=>this.remove(canvas)));content.append(actions);row.append(preview,content);group.append(row);
        if(canvas.error)group.append(element('small','mask-error',canvas.error));
      }
      if(!canvases.length)group.append(element('div','mask-empty',kind==='rectangle'?'Create a canvas to draw reusable masks.':'Add images to the directory, then refresh.'));
      this.list.append(group);
    }
    this.list.scrollTop=scroll;
  }
  async create() {
    let n=1;while(this.data?.canvases.some(c=>c.name===`Canvas ${n}`))n++;
    const form=await showMaskForm('New rectangle canvas',[{key:'name',label:'Name',value:`Canvas ${n}`}],{okLabel:'Create'}); if(!form)return;
    const result=await maskRequest('mutate',{action:'save',canvas:{kind:'rectangle',name:form.name,masks:[]}});
    this.selected=result.result.id; this.openCanvas(result.result);
  }
  async directory() {
    const form=await showMaskForm('Image directory',[{key:'directory',label:'Subdirectory in input',value:this.data.directory}]);if(!form)return;
    await maskRequest('mutate',{action:'directory',directory:form.directory});await this.reload(true);
  }
  async configure(canvas) {
    const form=await showMaskForm('Extraction settings',[{key:'count',label:'Color count',type:'number',min:1,max:32,step:1,value:canvas.settings.count},{key:'tolerance',label:'RGB tolerance',type:'number',min:0,max:1,step:.001,value:canvas.settings.tolerance},{key:'invert',label:'Invert alpha (use alpha)',type:'checkbox',value:canvas.settings.invert_alpha}]);if(!form)return;
    const value=cleanCanvas(canvas);value.settings={count:Number(form.count),tolerance:Number(form.tolerance),invert_alpha:form.invert};
    await maskRequest('mutate',{action:'save',id:canvas.id,version:canvas.version,canvas:value});
  }
  async rename(canvas){
    const form=await showMaskForm('Rename canvas',[{key:'name',label:'Name',value:canvas.name}]);if(!form)return;
    await maskRequest('mutate',{action:'save',id:canvas.id,version:canvas.version,canvas:{...cleanCanvas(canvas),name:form.name}});
  }
  async relocate(canvas){
    const form=await showMaskForm('Relocate image',[{key:'path',label:'Path relative to input',value:canvas.path}]);if(!form)return;
    await maskRequest('mutate',{action:'save',id:canvas.id,version:canvas.version,canvas:{...cleanCanvas(canvas),path:form.path}});
  }
  async remove(canvas){
    const message=canvas.kind==='picture'?`Remove “${canvas.name}” from Mask Library? The image file will stay in input.`:`Delete “${canvas.name}” and its rectangles? Linked regions will keep their final coordinates.`;
    if(await showMaskConfirm(message))await maskRequest('mutate',{action:'delete',id:canvas.id,version:canvas.version});
  }
  openCanvas(canvas, selected=null) {
    if(canvas.kind==='rectangle')return new MaskEditor({canvas:cleanCanvas(canvas),id:canvas.id,version:canvas.version,selected,request:maskRequest}).open();
    // Library panels and linked Region entries share one image viewer.
    if(!pictureWindow?.el.isConnected){
      const win=pictureWindow=makeWindow({key:'xyz-mask-picture',title:canvas.name,defaults:{x:180,y:90,w:580,h:480},minW:340,minH:280});
      win.el.classList.add('plv4','mask-picture-window');win.bar.append(maskIconButton('close','Close',()=>{win.el.remove();if(pictureWindow===win)pictureWindow=null;}));
      win.body.style.overflow='auto';
    }
    const win=pictureWindow;win.bar.firstElementChild.textContent=canvas.name;
    const grid=element('div','mask-picture-grid');win.body.replaceChildren(grid);win.body.scrollTop=0;
    for(const mask of canvas.masks){const row=element('div','mask-picture-item');row.dataset.maskId=mask.id;row.classList.toggle('selected',mask.id===selected);const image=element('img');image.src=mask.preview;image.alt=mask.name;
      const previewColor=input(mask.color,async value=>{const copy=cleanCanvas(canvas);copy.presentation??={};copy.presentation[mask.id]={...copy.presentation[mask.id],color:value};const saved=await maskRequest('mutate',{action:'save',id:canvas.id,version:canvas.version,canvas:copy});canvas={...saved.result,masks:canvas.masks};},{type:'color',title:'Preview color (keeps extraction RGB)'});
      const caption=element('div','mask-picture-caption');caption.append(element('span','',mask.name),previewColor);row.append(image,caption);grid.append(row);}win.show();
  }
  dispose(){this.disposed=true;++this.token;this.controller?.abort();window.removeEventListener(MASK_EVENT,this.changed);this.element.remove();}
}

export class MaskLibraryWindow {
  open() {
    maskStyles();if(this.win){this.win.show();return;}
    this.win=makeWindow({key:'xyz-mask-library',title:'Mask Library',defaults:{x:140,y:90,w:380,h:540},minW:260,minH:300});this.win.el.classList.add('plv4','mask-library-window');
    this.panel=new MaskLibraryPanel(this.win.body);this.win.bar.append(maskIconButton('close','Close',()=>{this.panel.dispose();this.win.el.remove();this.win=null;}));this.win.show();
  }
}
