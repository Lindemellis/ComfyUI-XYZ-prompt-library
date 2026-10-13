import {element, button} from './ui.js';

const paths = {
  library: 'M3 5h18v14H3z M7 5v14 M10 9h7 M10 13h7',
  masks: 'M5 3h14v18H5z M8 7h8v10H8z M3 7h2 M19 17h2',
  add: 'M12 5v14 M5 12h14',
  refresh: 'M20 7v5h-5 M4 17v-5h5 M5 8a7 7 0 0 1 12-3l3 3 M19 16a7 7 0 0 1-12 3l-3-3',
  edit: 'm14 5 5 5 M4 20l4-1L20 7l-4-4L4 15v5z',
  rename: 'M5 5h14 M12 5v14 M9 19h6',
  delete: 'M4 7h16 M9 7V4h6v3 M6 7l1 14h10l1-14 M10 10v7 M14 10v7',
  settings: 'M4 6h16 M4 12h16 M4 18h16 M8 3v6 M16 9v6 M10 15v6',
  folder: 'M3 7V5h6l2 2h10v13H3z M3 10h18',
  open: 'M14 3h7v7 M21 3l-11 11 M10 5H4v15h15v-6',
  unlink: 'm9 15-2 2a4 4 0 0 1-6-6l4-4 M15 9l2-2a4 4 0 0 1 6 6l-4 4 M3 3l18 18',
  close: 'M6 6l12 12 M18 6 6 18',
  grip: 'M8 5h.01 M16 5h.01 M8 12h.01 M16 12h.01 M8 19h.01 M16 19h.01',
};

export function maskIcon(kind) {
  const icon = element('span', 'mask-icon');
  icon.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[kind] || paths.masks}"/></svg>`;
  return icon;
}

export function maskIconButton(kind, title, action, cls = '') {
  const control = button('', title, action, `mask-icon-button ${cls}`);
  control.append(maskIcon(kind)); control.setAttribute('aria-label', title);
  return control;
}

export function showMaskForm(title, fields, {okLabel='Save', message='', danger=false}={}) {
  return new Promise(resolve=>{
    const previous=document.activeElement,dialog=element('dialog','plv4 mask-dialog'),form=element('form');
    const heading=element('h2','',title);heading.id=`mask-dialog-${crypto.randomUUID()}`;dialog.setAttribute('aria-labelledby',heading.id);form.append(heading);
    if(message)form.append(element('p','',message));
    const controls=new Map();
    for(const field of fields){
      const label=element('label','mask-dialog-field'),control=element('input');control.type=field.type||'text';
      if(control.type==='checkbox'){control.checked=!!field.value;label.append(control,element('span','',field.label));}
      else{control.value=field.value??'';control.required=true;for(const key of ['min','max','step'])if(field[key]!=null)control[key]=field[key];label.append(element('span','',field.label),control);}
      controls.set(field.key,control);form.append(label);
    }
    let closed=false;
    const finish=value=>{if(closed)return;closed=true;dialog.close();dialog.remove();if(previous?.isConnected)previous.focus({preventScroll:true});resolve(value);};
    const actions=element('div','mask-dialog-actions'),cancel=button('Cancel','Cancel',()=>finish(null));
    const submit=element('button',danger?'mask-dialog-danger':'mask-dialog-submit',okLabel);submit.type='submit';actions.append(cancel,submit);form.append(actions);dialog.append(form);
    form.onsubmit=event=>{event.preventDefault();finish(Object.fromEntries([...controls].map(([key,control])=>[key,control.type==='checkbox'?control.checked:control.value])));};
    dialog.oncancel=event=>{event.preventDefault();finish(null);};
    dialog.onclick=event=>{const r=dialog.getBoundingClientRect();if(event.target===dialog&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom))finish(null);};
    document.body.append(dialog);dialog.showModal();(controls.values().next().value||cancel).focus();
  });
}

export function showMaskConfirm(message){return showMaskForm('Delete canvas',[],{okLabel:'Delete',message,danger:true}).then(result=>result!==null);}

const palette = ['#77a8f3', '#ed786e', '#76cba2', '#e5bb65', '#af8ee6', '#62c5d0', '#e486b8', '#a9c96a'];
function rgb(hex) { return [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)); }
function lab(hex) {
  const [r,g,b] = rgb(hex).map(c => { c/=255; return c<=.04045 ? c/12.92 : ((c+.055)/1.055)**2.4; });
  const l=Math.cbrt(.4122214708*r+.5363325363*g+.0514459929*b), m=Math.cbrt(.2119034982*r+.6806995451*g+.1073969566*b), s=Math.cbrt(.0883024619*r+.2817188376*g+.6299787005*b);
  return [.2104542553*l+.793617785*m-.0040720468*s,1.9779984951*l-2.428592205*m+.4505937099*s,.0259040371*l+.7827717662*m-.808675766*s];
}
function hueColor(h,s,l) {
  const c=(1-Math.abs(2*l-1))*s,x=c*(1-Math.abs((h/60)%2-1)),m=l-c/2;
  const triples=[[c,x,0],[x,c,0],[0,c,x],[0,x,c],[x,0,c],[c,0,x]];
  return '#'+triples[Math.floor(h/60)].map(v=>Math.round((v+m)*255).toString(16).padStart(2,'0')).join('');
}

export function nextMaskColor(masks) {
  const used=new Set(masks.map(m=>m.color.toLowerCase())), existing=[...used].map(lab);
  if (!used.size) return palette[0];
  let candidates=palette.filter(color=>!used.has(color));
  if (!candidates.length) candidates=Array.from({length:256},(_,i)=>hueColor((i*137.508)%360,i%2?.78:.9,i%3?.58:.68)).filter(color=>!used.has(color));
  let best=null, score=-1;
  for (const color of candidates) {
    const value=lab(color), distance=Math.min(...existing.map(other=>value.reduce((sum,v,i)=>sum+(v-other[i])**2,0)));
    if(distance>score){score=distance;best=color;}
  }
  // More colors than the palette: keep exact identity distinct as well.
  for(let i=1;best===null;i++){const candidate='#'+((i*2654435761)>>>0).toString(16).slice(-6).padStart(6,'0');if(!used.has(candidate))best=candidate;}
  return best;
}
