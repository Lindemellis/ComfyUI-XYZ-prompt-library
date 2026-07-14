// PLv3 — the design system: tokens, window chrome, splitters, primitives.
//
// One place decides how PLv3 looks. The three windows (main, library) and every
// pane inside them build out of these, so nothing drifts.
//
// The type scale is deliberate: 13px is the reading size, 12px is for labels, and
// 11px is reserved for genuine micro-metadata (counts, badges). A label is a real
// part of the interface — it gets readable contrast, not a whisper.

export const T = {
  // surfaces, from deepest to highest
  bg0: '#11111b',   // inputs, wells — recessed
  bg1: '#181825',   // window body
  bg2: '#1e1e2e',   // panels, cards
  bg3: '#262637',   // hover
  bg4: '#313244',   // selected, pressed

  line: '#2a2a3c',  // hairlines between areas
  edge: '#3d3d52',  // control borders

  text: '#cdd6f4',  // primary content
  label: '#9399b2', // labels — readable, not a whisper
  muted: '#6c7086', // genuinely secondary metadata

  accent: '#89b4fa',
  accentDim: '#5b7ec4',
  good: '#a6e3a1',
  warn: '#f9e2af',
  bad: '#f38ba8',
  lib: '#f5c2e7',   // library groups
  region: '#cba6f7',
  time: '#fab387',  // schedule / numbers
  rand: '#94e2d5',  // the settings that make a group non-deterministic

  fs: { micro: '11px', label: '12px', body: '13px', head: '13px' },
  radius: '5px',
  radiusSm: '3px',
  row: '26px',
  font: 'ui-sans-serif, system-ui, "Segoe UI", sans-serif',
  mono: 'ui-monospace, "Cascadia Code", Consolas, monospace',
  shadow: '0 10px 40px rgba(0,0,0,.55)',
};

export function el(tag, style = '', text = '') {
  const e = document.createElement(tag);
  if (style) e.style.cssText = style;
  if (text) e.textContent = text;
  return e;
}
export const div = (s, t) => el('div', s, t);

// --- primitives -------------------------------------------------------------

/** A section header. Used sparingly — it is a divider, not decoration. */
export function sectionLabel(text) {
  return div(
    `font-size:${T.fs.micro};font-weight:600;letter-spacing:.06em;text-transform:uppercase;
     color:${T.muted};padding:6px 2px 4px;`,
    text,
  );
}

/** A form row: label on the left, control filling the rest. */
export function field(label, control, { width = 92 } = {}) {
  const r = div('display:flex;align-items:center;gap:10px;min-width:0;min-height:24px;');
  r.append(div(
    `width:${width}px;flex-shrink:0;font-size:${T.fs.label};color:${T.label};`,
    label,
  ));
  control.style.flex = '1';
  control.style.minWidth = '0';
  r.append(control);
  return r;
}

export function button(text, { variant = 'ghost', size = 'md' } = {}) {
  const pad = size === 'sm' ? '2px 8px' : '5px 12px';
  const styles = {
    ghost: `background:transparent;border:1px solid ${T.edge};color:${T.text};`,
    primary: `background:${T.accent};border:1px solid ${T.accent};color:${T.bg0};font-weight:600;`,
    danger: `background:transparent;border:1px solid ${T.bad};color:${T.bad};`,
    quiet: `background:transparent;border:1px solid transparent;color:${T.label};`,
  };
  const b = el('button', `${styles[variant]}padding:${pad};border-radius:${T.radiusSm};
    font-family:${T.font};font-size:${T.fs.label};cursor:pointer;line-height:1.4;
    transition:background .12s,border-color .12s;`, text);
  b.onmouseenter = () => { if (variant === 'ghost' || variant === 'quiet') b.style.background = T.bg3; };
  b.onmouseleave = () => { if (variant === 'ghost' || variant === 'quiet') b.style.background = 'transparent'; };
  return b;
}

export function iconButton(glyph, title, onClick) {
  const b = div(`width:20px;height:20px;display:flex;align-items:center;justify-content:center;
    border-radius:${T.radiusSm};color:${T.muted};cursor:pointer;font-size:${T.fs.label};
    flex-shrink:0;user-select:none;`, glyph);
  b.title = title;
  b.onmouseenter = () => { b.style.background = T.bg3; b.style.color = T.text; };
  b.onmouseleave = () => { b.style.background = 'transparent'; b.style.color = T.muted; };
  b.onclick = (e) => { e.stopPropagation(); onClick(e); };
  return b;
}

export function input(value = '', { mono = false, placeholder = '' } = {}) {
  const i = el('input', `background:${T.bg0};border:1px solid ${T.edge};border-radius:${T.radiusSm};
    color:${T.text};padding:4px 8px;font-size:${T.fs.body};font-family:${mono ? T.mono : T.font};
    flex:1;width:0;min-width:0;box-sizing:border-box;outline:none;`);
  i.value = value;
  if (placeholder) i.placeholder = placeholder;
  i.onfocus = () => (i.style.borderColor = T.accent);
  i.onblur = () => (i.style.borderColor = T.edge);
  return i;
}

export function numberInput(value, { step = 1, min = null, placeholder = '' } = {}) {
  const i = input(value ?? '', { placeholder });
  i.type = 'number';
  i.step = String(step);
  if (min !== null) i.min = String(min);
  i.style.padding = '3px 6px';
  return i;
}

export function toggle(on, onChange) {
  const track = div(`width:34px;height:18px;border-radius:9px;flex-shrink:0;cursor:pointer;
    position:relative;transition:background .15s;background:${on ? T.good : T.bg4};`);
  const knob = div(`position:absolute;top:2px;left:${on ? 18 : 2}px;width:14px;height:14px;
    border-radius:7px;background:${on ? T.bg0 : T.label};transition:left .15s;`);
  track.append(knob);

  // Flip on click, not when the round trip that re-renders the row eventually lands.
  // The switch is the user's own gesture; making it wait on the server for a quarter
  // of a second reads as "the click did not register".
  track.onclick = () => {
    const next = !on;
    track.style.background = next ? T.good : T.bg4;
    knob.style.left = next ? '18px' : '2px';
    knob.style.background = next ? T.bg0 : T.label;
    onChange(next);
  };
  return track;
}

/** An interval on ONE track: two thumbs, and the span between them filled.
 *
 *  Two range inputs side by side are two sliders — the left one's right end and the
 *  right one's left end are different pixels, and nothing about them says they are the
 *  two ends of one thing. So: both inputs are stretched over the same track and made
 *  transparent, only their thumbs take the pointer, and a filled bar underneath shows
 *  the interval itself. The thumbs cannot be styled inline (they are pseudo-elements),
 *  so this is the one place in the file that needs a stylesheet.
 */
let _dualCss = false;
function dualCss() {
  if (_dualCss) return;
  _dualCss = true;
  const st = document.createElement('style');
  st.textContent = `
    .plv3-dual { position: relative; height: 20px; flex: 1; min-width: 0; }
    .plv3-dual .plv3-dual-track,
    .plv3-dual .plv3-dual-fill {
      position: absolute; top: 8px; height: 4px; border-radius: 2px; pointer-events: none;
    }
    .plv3-dual .plv3-dual-track { left: 0; right: 0; background: ${T.bg4}; }
    .plv3-dual .plv3-dual-fill  { background: var(--plv3-dual-color); }
    .plv3-dual input[type=range] {
      position: absolute; top: 0; left: 0; width: 100%; height: 20px; margin: 0;
      -webkit-appearance: none; appearance: none; background: transparent;
      pointer-events: none; outline: none;
    }
    .plv3-dual input[type=range]::-webkit-slider-runnable-track {
      height: 20px; background: transparent; border: none;
    }
    .plv3-dual input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none; pointer-events: auto; cursor: grab;
      width: 13px; height: 13px; margin-top: 3px; border-radius: 50%;
      background: var(--plv3-dual-color); border: 2px solid ${T.bg0};
      box-shadow: 0 1px 3px rgba(0,0,0,.5);
    }
    .plv3-dual input[type=range]::-webkit-slider-thumb:active { cursor: grabbing; }
    .plv3-dual input[type=range]::-moz-range-track { height: 20px; background: transparent; }
    .plv3-dual input[type=range]::-moz-range-thumb {
      pointer-events: auto; cursor: grab;
      width: 13px; height: 13px; border-radius: 50%;
      background: var(--plv3-dual-color); border: 2px solid ${T.bg0};
    }
  `;
  document.head.appendChild(st);
}

export function dualSlider([a, b], onCommit, { color = T.accent, step = 0.05, min = 0, max = 1 } = {}) {
  dualCss();
  const wrap = div('display:flex;align-items:center;gap:8px;min-width:0;');
  const rail = div('');
  rail.className = 'plv3-dual';
  rail.style.setProperty('--plv3-dual-color', color);

  const track = div('');
  track.className = 'plv3-dual-track';
  const fillEl = div('');
  fillEl.className = 'plv3-dual-fill';
  rail.append(track, fillEl);

  const mk = (v) => {
    const s = el('input', '');
    s.type = 'range';
    s.min = String(min); s.max = String(max); s.step = String(step);
    s.value = String(v);
    return s;
  };
  const lo = mk(a);
  const hi = mk(b);
  rail.append(lo, hi);

  const out = div(`min-width:64px;text-align:right;font-size:${T.fs.label};color:${color};
    font-family:${T.mono};flex-shrink:0;`, `${fmt(a)}–${fmt(b)}`);

  const span = max - min || 1;
  const paint = () => {
    let x = Number(lo.value);
    let y = Number(hi.value);
    if (x > y) [x, y] = [y, x];
    fillEl.style.left = `${((x - min) / span) * 100}%`;
    fillEl.style.width = `${((y - x) / span) * 100}%`;
    out.textContent = `${fmt(x)}–${fmt(y)}`;
    // Whichever thumb is on top must be the one you can grab when they meet — otherwise
    // an interval that has closed to zero can never be opened again.
    lo.style.zIndex = Number(lo.value) >= Number(hi.value) ? '3' : '2';
    hi.style.zIndex = Number(lo.value) >= Number(hi.value) ? '2' : '3';
  };
  const commit = () => {
    let x = Number(lo.value);
    let y = Number(hi.value);
    if (x > y) [x, y] = [y, x];   // dragging past each other flips, never inverts
    onCommit([x, y]);
  };
  lo.oninput = hi.oninput = paint;
  lo.onchange = hi.onchange = commit;
  paint();

  wrap.append(rail, out);
  return wrap;
}

export function slider(value, { min, max, step }, { onInput, onCommit } = {}) {
  const wrap = div('display:flex;align-items:center;gap:8px;min-width:0;');
  const s = el('input', `flex:1;width:0;min-width:0;accent-color:${T.accent};`);
  s.type = 'range';
  s.min = String(min); s.max = String(max); s.step = String(step);
  s.value = String(value);
  const out = div(`min-width:34px;text-align:right;font-size:${T.fs.label};color:${T.time};
    font-family:${T.mono};`, fmt(value));
  s.oninput = () => { out.textContent = fmt(Number(s.value)); onInput?.(Number(s.value)); };
  s.onchange = () => onCommit?.(Number(s.value));
  wrap.append(s, out);
  return wrap;
}

export function fmt(v) {
  return Number.isInteger(v) ? String(v) : String(Number(Number(v).toFixed(4)));
}

/** A tab strip. `items` = [{ id, label, badge? }]. */
export function tabs(items, active, onSelect) {
  const bar = div(`display:flex;gap:2px;align-items:flex-end;min-height:28px;
    border-bottom:1px solid ${T.line};padding:0 4px;overflow-x:auto;flex-shrink:0;`);
  for (const it of items) {
    const on = it.id === active;
    const tab = div(`display:flex;align-items:center;gap:6px;padding:5px 12px;cursor:pointer;
      font-size:${T.fs.label};white-space:nowrap;border-radius:${T.radiusSm} ${T.radiusSm} 0 0;
      color:${on ? T.text : T.label};background:${on ? T.bg2 : 'transparent'};
      border-bottom:2px solid ${on ? T.accent : 'transparent'};margin-bottom:-1px;`);
    tab.append(div('', it.label));
    if (it.badge) {
      tab.append(div(`font-size:${T.fs.micro};color:${T.muted};font-family:${T.mono};`, it.badge));
    }
    if (it.onClose) {
      const x = iconButton('✕', 'Close', (e) => { e.stopPropagation(); it.onClose(); });
      x.style.width = '16px'; x.style.height = '16px';
      tab.append(x);
    }
    tab.onclick = () => onSelect(it.id);
    bar.append(tab);
  }
  return bar;
}

/** A tree row: indent guides, an optional chevron, an icon, a label, a tail. */
export function treeRow({ depth = 0, chevron = null, icon = null, iconColor = T.label,
                          label = '', tail = null, selected = false, dim = false }) {
  const row = div(`display:flex;align-items:center;gap:6px;height:${T.row};padding-right:6px;
    border-radius:${T.radiusSm};cursor:pointer;user-select:none;min-width:0;
    background:${selected ? T.bg4 : 'transparent'};`);

  // Indent guides make depth readable without counting pixels.
  const rail = div(`display:flex;flex-shrink:0;height:100%;`);
  for (let i = 0; i < depth; i++) {
    rail.append(div(`width:12px;height:100%;border-left:1px solid ${T.line};margin-left:5px;`));
  }
  row.append(rail);

  const chev = div(`width:14px;flex-shrink:0;text-align:center;color:${T.muted};
    font-size:10px;transition:transform .12s;`);
  if (chevron === 'open') chev.textContent = '▾';
  else if (chevron === 'closed') chev.textContent = '▸';
  row.append(chev);

  if (icon !== null) {
    row.append(div(`flex-shrink:0;color:${iconColor};font-size:${T.fs.label};width:14px;
      text-align:center;`, icon));
  }

  row.append(div(`flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
    font-size:${T.fs.body};color:${dim ? T.muted : T.text};unicode-bidi:plaintext;`, label));

  if (tail) row.append(tail);

  if (!selected) {
    row.onmouseenter = () => (row.style.background = T.bg3);
    row.onmouseleave = () => (row.style.background = 'transparent');
  }
  return row;
}

// --- splitter ---------------------------------------------------------------

/** A draggable divider between two flex siblings.  `dir` is 'x' or 'y'; `target`
 *  is the pane whose size the drag changes (it must have a fixed basis). */
export function splitter(target, { dir = 'x', key = null, min = 120, max = 900, invert = false }) {
  const horiz = dir === 'x';
  const bar = div(`flex-shrink:0;position:relative;z-index:2;
    ${horiz ? `width:5px;margin:0 -2px;cursor:col-resize;` : `height:5px;margin:-2px 0;cursor:row-resize;`}`);
  const line = div(`position:absolute;background:transparent;transition:background .12s;
    ${horiz ? 'top:0;bottom:0;left:2px;width:1px;' : 'left:0;right:0;top:2px;height:1px;'}`);
  bar.append(line);
  bar.onmouseenter = () => (line.style.background = T.accent);
  bar.onmouseleave = () => (line.style.background = 'transparent');

  const saved = key && Number(localStorage.getItem(key));
  if (saved && saved >= min && saved <= max) {
    if (horiz) target.style.width = `${saved}px`;
    else target.style.height = `${saved}px`;
  }

  bar.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const start = horiz ? e.clientX : e.clientY;
    const base = horiz ? target.offsetWidth : target.offsetHeight;
    const move = (ev) => {
      const now = horiz ? ev.clientX : ev.clientY;
      const delta = (now - start) * (invert ? -1 : 1);
      const size = Math.max(min, Math.min(max, base + delta));
      if (horiz) target.style.width = `${size}px`;
      else target.style.height = `${size}px`;
      target.dispatchEvent(new CustomEvent('plv3:resized', { bubbles: true }));
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
      if (key) {
        localStorage.setItem(key, String(horiz ? target.offsetWidth : target.offsetHeight));
      }
    };
    document.body.style.cursor = horiz ? 'col-resize' : 'row-resize';
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
  return bar;
}

// --- window chrome ----------------------------------------------------------

const EDGES = [
  ['n',  'top:0;left:8px;right:8px;height:5px;cursor:ns-resize;'],
  ['s',  'bottom:0;left:8px;right:8px;height:5px;cursor:ns-resize;'],
  ['w',  'left:0;top:8px;bottom:8px;width:5px;cursor:ew-resize;'],
  ['e',  'right:0;top:8px;bottom:8px;width:5px;cursor:ew-resize;'],
  ['nw', 'left:0;top:0;width:10px;height:10px;cursor:nwse-resize;'],
  ['ne', 'right:0;top:0;width:10px;height:10px;cursor:nesw-resize;'],
  ['sw', 'left:0;bottom:0;width:10px;height:10px;cursor:nesw-resize;'],
  ['se', 'right:0;bottom:0;width:10px;height:10px;cursor:nwse-resize;'],
];

/** A floating window with a drag bar and resize handles on ALL FOUR edges and
 *  corners — not just the bottom-right nub CSS `resize` gives you. */
export function makeWindow({ key, title, defaults, minW = 640, minH = 360, onResize }) {
  let g = { ...defaults };
  try { g = { ...g, ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch {}

  const win = div(`position:fixed;left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px;
    display:none;flex-direction:column;z-index:1200;background:${T.bg1};
    border:1px solid ${T.edge};border-radius:8px;box-shadow:${T.shadow};overflow:hidden;
    box-sizing:border-box;color:${T.text};font-family:${T.font};font-size:${T.fs.body};`);

  const save = () => {
    if (win.style.display === 'none' || !win.offsetWidth) return;
    localStorage.setItem(key, JSON.stringify({
      x: parseInt(win.style.left, 10), y: parseInt(win.style.top, 10),
      w: win.offsetWidth, h: win.offsetHeight,
    }));
  };

  const bar = div(`display:flex;align-items:center;gap:10px;padding:8px 12px;background:${T.bg2};
    border-bottom:1px solid ${T.line};cursor:grab;user-select:none;flex-shrink:0;`);
  bar.append(div(`font-size:${T.fs.head};font-weight:600;letter-spacing:.01em;`, title));
  const spacer = div('flex:1;');
  bar.append(spacer);

  bar.addEventListener('mousedown', (e) => {
    if (e.target.closest('button') || e.target.dataset?.noDrag) return;
    e.preventDefault();
    const ox = e.clientX - win.offsetLeft;
    const oy = e.clientY - win.offsetTop;
    const move = (ev) => {
      win.style.left = `${Math.max(0, ev.clientX - ox)}px`;
      win.style.top = `${Math.max(0, ev.clientY - oy)}px`;
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      bar.style.cursor = 'grab';
      save();
    };
    bar.style.cursor = 'grabbing';
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });

  const body = div('display:flex;flex:1;min-height:0;min-width:0;');
  win.append(bar, body);

  for (const [side, css] of EDGES) {
    const h = div(`position:absolute;z-index:5;${css}`);
    h.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const x0 = e.clientX, y0 = e.clientY;
      const L = win.offsetLeft, Tp = win.offsetTop;
      const W = win.offsetWidth, H = win.offsetHeight;
      const move = (ev) => {
        const dx = ev.clientX - x0, dy = ev.clientY - y0;
        let l = L, t = Tp, w = W, h2 = H;
        if (side.includes('e')) w = Math.max(minW, W + dx);
        if (side.includes('s')) h2 = Math.max(minH, H + dy);
        if (side.includes('w')) { w = Math.max(minW, W - dx); l = L + (W - w); }
        if (side.includes('n')) { h2 = Math.max(minH, H - dy); t = Tp + (H - h2); }
        win.style.left = `${l}px`; win.style.top = `${t}px`;
        win.style.width = `${w}px`; win.style.height = `${h2}px`;
        onResize?.();
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        document.body.style.cursor = '';
        save();
        onResize?.();
      };
      document.body.style.cursor = getComputedStyle(h).cursor;
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    win.append(h);
  }

  document.body.appendChild(win);

  return {
    el: win,
    bar,
    body,
    titleActions: spacer, // append buttons before this to right-align them
    save,
    show() { win.style.display = 'flex'; onResize?.(); },
    hide() { save(); win.style.display = 'none'; },
    isVisible() { return win.style.display !== 'none'; },
  };
}

/** A collapsible section — used for the editor's preview panel. */
export function collapsible({ title, open = false, onToggle }) {
  const wrap = div('display:flex;flex-direction:column;min-height:0;flex-shrink:0;');
  const head = div(`display:flex;align-items:center;gap:8px;padding:5px 10px;cursor:pointer;
    background:${T.bg2};border-top:1px solid ${T.line};user-select:none;flex-shrink:0;`);
  const chev = div(`color:${T.muted};font-size:10px;width:10px;`, open ? '▾' : '▸');
  const label = div(`font-size:${T.fs.label};font-weight:600;color:${T.label};`, title);
  const tail = div('flex:1;display:flex;justify-content:flex-end;gap:6px;');
  head.append(chev, label, tail);

  const body = div(`display:${open ? 'flex' : 'none'};flex-direction:column;min-height:0;
    background:${T.bg1};`);

  head.onclick = () => {
    const nowOpen = body.style.display === 'none';
    body.style.display = nowOpen ? 'flex' : 'none';
    chev.textContent = nowOpen ? '▾' : '▸';
    onToggle?.(nowOpen);
  };

  wrap.append(head, body);
  return { wrap, head, body, tail, label,
           isOpen: () => body.style.display !== 'none',
           setOpen: (v) => { if (v !== (body.style.display !== 'none')) head.onclick(); } };
}
