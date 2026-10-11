// The accepted P0 templates, used by both the prototype and production adapters.
// Behaviour is supplied by the host; no sample state or Library writes live here.
(function(){
function promptHTML(p,env){
  const {state,text,esc}=env;
  const edit=env.sharedInput?'':' contenteditable="true" role="textbox"';
  return `<span class="prompt ${p.enabled?'':'off'} ${p.id===state.prompt?'selected-prompt':''}" data-prompt="${p.id}"${edit} aria-label="Prompt ${esc(p.text)}" spellcheck="false">${esc(text(p))}</span>`;
}
function emptyHTML(id){return `<div class="empty-text" contenteditable="plaintext-only" data-empty="${id}" role="textbox" aria-label="空 block 输入"></div>`}
function boundaryHTML(parent,before,inline=false){return `<span class="boundary ${inline?'inline':''}" data-parent="${parent}" data-before="${before||''}" data-editor-decoration="" contenteditable="false" aria-hidden="true"></span>`}
function nearestBoundary(container,x,y,distance=25){const hit=document.elementFromPoint(x,y)?.closest('.boundary[data-parent]');if(hit&&container.contains(hit))return hit;let best=null;for(const slot of container.querySelectorAll('.boundary[data-parent]')){const r=slot.getBoundingClientRect();if(!r.width||!r.height)continue;const dx=Math.max(r.left-x,0,x-r.right),dy=Math.max(r.top-y,0,y-r.bottom);const d=Math.hypot(dx,dy);if(d<distance){distance=d;best=slot}}return best}
function bindInlineInput(container,{capture,input,commit}){
  const target=e=>e.target.closest?.('[data-run-input],[data-empty]')||(e.target.matches?.('[data-prompt]')?e.target:null);
  const focusin=e=>{const t=target(e);if(t)capture(t)};
  const change=e=>{const t=target(e);if(t)input?.(t,e)};
  const focusout=e=>{const t=target(e);if(t)commit(t)};
  const paste=e=>{const t=target(e);if(!t?.matches('[data-run-input],[data-empty]')||t.contentEditable!=='plaintext-only'||!e.clipboardData)return;e.preventDefault();document.execCommand('insertText',false,e.clipboardData.getData('text/plain'))};
  const pointerdown=e=>{
    const selection=getSelection();
    if(e.button===2&&selection&&!selection.isCollapsed&&container.contains(selection.anchorNode)&&container.contains(selection.focusNode)){e.preventDefault();return}
    if(e.button!==0)return;
    const blank=e.target.matches?.('.run')?e.target:null;
    const field=e.target.closest?.('[data-run-input],[data-empty]')||e.target.closest?.('[data-prompt][contenteditable="true"]')||(blank?[...blank.querySelectorAll('[data-prompt][contenteditable="true"]')].at(-1):null);
    if(!field||!['true','plaintext-only'].includes(field.contentEditable))return;
    // Complete blur + focus in one call, before an async blur save can redraw
    // the destination. Native mousedown still places the caret within text.
    if(document.activeElement!==field&&!e.shiftKey)field.focus({preventScroll:true});
    if(blank&&!field.matches('[data-run-input]')){
      e.preventDefault();
      const range=document.createRange();range.selectNodeContents(field);range.collapse(false);
      selection.removeAllRanges();selection.addRange(range);
    }
  };
  container.addEventListener('focusin',focusin);container.addEventListener('input',change);container.addEventListener('focusout',focusout);
  container.addEventListener('pointerdown',pointerdown);
  container.addEventListener('paste',paste);
  return ()=>{container.removeEventListener('focusin',focusin);container.removeEventListener('input',change);container.removeEventListener('focusout',focusout);container.removeEventListener('pointerdown',pointerdown);container.removeEventListener('paste',paste)};
}
function blockHTML(b,depth=0,parentOff=false,env){
  const {state,root,isLibraryBlockView,childrenHTML,join,leaves,text,esc}=env;
  const off=parentOff||!b.enabled,name=b.name||'';
  const types=[],properties=[];
  if(b.type==='avg')types.push('<span class="block-type" data-kind="avg">AVG</span>');
  if(b.form==='avg_entry')types.push('<span class="block-type" data-kind="avg">AVG entry</span>');
  if(b.form==='avg_entry')properties.push(`<span class="block-type" data-kind="avg" title="相对混合权重">Weight · ${b.avgWeight ?? 1}</span>`);
  if(b.type==='lora')types.push(`<button type="button" class="block-type" data-kind="lora" data-open-lora="${esc(b.meta?.lora?.id||'')}" title="打开此 LoRA 的详情" aria-label="打开 ${esc(name||'LoRA')} 的 LoRA 详情">LoRA</button>`);
  if(b.type==='schedule')types.push('<span class="block-type" data-kind="schedule">Schedule</span>');
  else if(b.schedule)properties.push(`<span class="block-type" data-kind="schedule" title="Schedule · ${b.start}–${b.end}">Schedule · ${b.start}–${b.end}</span>`);
  if(b.type==='region')types.push('<span class="block-type" data-kind="region">Region</span>');
  else if(b.region)properties.push(`<span class="block-type" data-kind="region" title="Region · ${esc(b.regionKind)}${b.regionKind==='imask'?' '+b.mask:''}">Region · ${esc(b.regionKind)}${b.regionKind==='imask'?' '+b.mask:''}</span>`);
  const controls=`<button data-header-toggle="${b.id}" data-header-prop="enabled" aria-label="Enable ${esc(name||'block')}" aria-pressed="${b.enabled}" title="Enable" ${parentOff?'disabled':''}>⏻</button>
    <button data-detail="${b.id}" aria-label="详细设置 ${esc(name||'block')}" title="详细设置">⚙</button>
    ${isLibraryBlockView()&&b.id===root().id?'':`<button data-sibling="${b.id}" aria-label="在下方添加同级 block" title="在下方添加同级 block">＋</button>`}
    <button data-child="${b.id}" aria-label="添加子 block" title="添加子 block">↳</button>
    <button data-block-menu="${b.id}" aria-label="更多操作 ${esc(name||'block')}" title="更多操作" aria-haspopup="menu">⋯</button>`;
  const pool=b.meta?.pool&&!['schedule','region','avg'].includes(b.type)?`<button type="button" class="block-pool-link" data-open-folder="${esc(b.meta.pool)}" aria-label="打开绑定的 Folder：${esc(b.poolName)}" title="${esc(b.poolPath||b.poolName)}" ${b.poolAvailable?'':'disabled'}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.1 0l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7M14 11a5 5 0 0 0-7.1 0l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7"/></svg></button><button type="button" class="block-type" data-kind="folder" data-open-folder="${esc(b.meta.pool)}" aria-label="打开绑定的 Folder：${esc(b.poolName)}" title="${esc(b.poolPath||b.poolName)}" ${b.poolAvailable?'':'disabled'}>${esc(b.poolName)}</button>`:'';
  return `<article class="block ${b.id===state.selected?'selected':''} ${off?'effectively-off':''} ${b.type!=='normal'?'special':''}" data-block="${b.id}" data-depth="${depth}" data-tone="${depth%5}" data-type="${b.type}">
    <div class="block-head" data-select="${b.id}">
      <button class="fold" data-fold="${b.id}" aria-label="${b.collapsed?'展开':'折叠'} ${esc(name||'block')}" aria-expanded="${!b.collapsed}" title="${b.collapsed?'展开':'折叠'}"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="${b.collapsed?'M7 4l6 6-6 6':'M4 7l6 6 6-6'}"/></svg></button>
      ${types.length?`<span class="header-types">${types.join('')}</span>`:''}
      <span class="block-heading ${b.libraryPath?'has-library-path':''}">${pool}${name?`<span class="block-title" title="${esc(name)}">${esc(name)}</span>`:'<span class="block-title" aria-hidden="true"></span>'}${properties.length?`<span class="header-settings">${properties.join('')}</span>`:''}${b.libraryPath?`<span class="block-library-path" title="${esc(b.libraryPath)}">${esc(b.libraryPath)}</span>`:''}</span>
      <div class="header-controls" role="toolbar" aria-label="${esc(name||'block')} 操作">${controls}</div>
    </div>
    <div class="block-content">${b.collapsed?`<div class="summary">${esc(join(leaves({...b,enabled:true}).map(text)))||'空 block'}</div>`:`<div class="block-body">${childrenHTML(b,depth+1,off)}</div>`}<button class="drag-handle" draggable="false" ${isLibraryBlockView()&&b.id===root().id?'disabled':''} data-drag="${b.id}" aria-label="拖动 ${esc(name||'block')}" title="拖动整个 block"></button></div>
  </article>`;
}
function foldSections(panel,b,sections){
  for(const section of [...panel.querySelectorAll(':scope > .section')]){
    const title=section.querySelector('.section-title');if(!title)continue;
    const name=title.firstChild.textContent.trim(),kind=name.toUpperCase(),key=b.id+':'+name;
    const defaults=['LORA','POOL','SCHEDULE','SCHEDULE ENTRIES','SCHEDULE BOUNDARY','REGION','REGIONS','REGION ENTRIES','AVG ENTRIES','CONTENTS','CONTENT'];
    const detail=document.createElement('details');detail.className='section';
    detail.open=sections[key]??(defaults.includes(kind)||name==='池绑定'||name==='池中内容'||name==='内容'||kind==='GENERAL'&&b.type==='normal'||kind==='TIMING & REGION'&&!!(b.region||b.schedule));
    const summary=document.createElement('summary');summary.append(title);
    const content=document.createElement('div');content.className='section-body';
    while(section.firstChild)content.append(section.firstChild);
    detail.append(summary,content);section.replaceWith(detail);
    detail.addEventListener('toggle',()=>sections[key]=detail.open);
  }
}
  globalThis.XYZPLv4Design={promptHTML,emptyHTML,boundaryHTML,nearestBoundary,bindInlineInput,blockHTML,foldSections};
})();
