// PLv3 — in-page UI primitives: context menu, prompt, confirm, toast.
//
// Nothing here may use window.prompt / alert / confirm. A browser dialog is a
// separate OS window: it steals focus from the canvas, cannot be themed, and on
// top of a floating window it looks like the app broke. Same rule as PLv2.

const C = {
  bg: '#1e1e2e',
  panel: '#252526',
  line: '#313244',
  edge: '#45475a',
  text: '#cdd6f4',
  dim: '#a6adc8',
  hover: '#313244',
  accent: '#7c3aed',
  danger: '#f38ba8',
};

const Z = 100000;

function el(tag, style = '', text = '') {
  const e = document.createElement(tag);
  e.style.cssText = style;
  if (text) e.textContent = text;
  return e;
}
const div = (s, t) => el('div', s, t);

// --- context menu -----------------------------------------------------------

let _menus = [];

function closeMenus(fromDepth = 0) {
  for (let i = _menus.length - 1; i >= fromDepth; i--) _menus[i]?.remove();
  _menus.length = Math.max(0, fromDepth);
}

function place(menu, x, y, flipLeftOf = null) {
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  requestAnimationFrame(() => {
    const r = menu.getBoundingClientRect();
    if (r.right > window.innerWidth) {
      menu.style.left = `${(flipLeftOf != null ? flipLeftOf : x) - r.width}px`;
    }
    if (r.bottom > window.innerHeight) {
      menu.style.top = `${Math.max(4, window.innerHeight - r.height - 4)}px`;
    }
  });
}

/** One menu row.  An item may carry, besides `label`:
 *
 *    icon / iconColor   a glyph in its own fixed-width column, so the labels line up
 *                       whether or not a given row has one;
 *    hint               what the thing DOES, in its own column — dim, and aligned with
 *                       every other hint in the menu.
 *
 *  A menu of eight settings rendered as eight identical grey strings of
 *  "name — description" is a wall of text you have to read linearly. Two columns and a
 *  glyph turn it into something you scan.
 */
function renderMenu(items, depth) {
  // max-width, because the labels are user data: a preset named "illya - casual - summer
  // - v3 (final)" would otherwise stretch the menu across the screen. The rows ellipsize.
  const menu = div(`position:fixed;background:${C.bg};border:1px solid ${C.edge};border-radius:6px;
    box-shadow:0 6px 20px rgba(0,0,0,.6);padding:4px 0;min-width:170px;max-width:420px;
    max-height:72vh;overflow-y:auto;
    font-family:ui-sans-serif,system-ui,sans-serif;font-size:12px;z-index:${Z + depth};`);

  // The name column is as wide as the widest name, so every hint starts at the same x —
  // but capped, because a label can be user data (a preset name), and one long one must
  // not push every hint in the menu off to the right. Past the cap the name ellipsizes.
  const NAME_CAP = 200;
  const rich = items.some((i) => i.hint || i.icon);
  const nameW = rich
    ? Math.min(NAME_CAP,
      Math.max(...items.filter((i) => !i.separator).map((i) => (i.label || '').length)) * 7 + 8)
    : 0;

  for (const item of items) {
    if (item.separator) {
      menu.append(div(`height:1px;background:${C.line};margin:3px 0;`));
      continue;
    }
    const hasSub = item.submenu != null;
    const opt = div(`display:flex;align-items:center;gap:10px;padding:5px 14px;cursor:pointer;
      user-select:none;border-radius:3px;margin:1px 4px;color:${item.danger ? C.danger : C.text};`);

    if (rich) {
      opt.style.gap = '8px';
      opt.append(div(`width:14px;flex-shrink:0;text-align:center;
        color:${item.iconColor || C.dim};`, item.icon || ''));
      const name = div(`flex-shrink:0;${nameW ? `min-width:${nameW}px;max-width:${nameW}px;` : ''}
        font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`, item.label);
      name.title = item.label;   // the full name is one hover away
      opt.append(name);
      if (item.hint) {
        opt.append(div(`flex:1;min-width:0;color:${C.dim};font-size:11px;
          overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`, item.hint));
      }
    } else {
      opt.append(div('flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', item.label));
    }
    if (hasSub) opt.append(div('color:#6c7086;flex-shrink:0;', '▸'));

    opt.addEventListener('mouseenter', async () => {
      opt.style.background = C.hover;
      closeMenus(depth + 1);
      if (!hasSub) return;
      let sub = item.submenu;
      if (typeof sub === 'function') {
        try { sub = await sub(); } catch { sub = []; }
      }
      if (!Array.isArray(sub) || !sub.length) return;
      const r = opt.getBoundingClientRect();
      const child = renderMenu(sub, depth + 1);
      document.body.append(child);
      _menus.push(child);
      place(child, r.right - 2, r.top, r.left);
    });
    opt.addEventListener('mouseleave', () => (opt.style.background = 'transparent'));
    opt.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); });
    if (!hasSub && item.action) {
      opt.addEventListener('click', () => { closeMenus(0); item.action(); });
    }
    menu.append(opt);
  }
  return menu;
}

export function showContextMenu(x, y, items) {
  closeMenus(0);
  const menu = renderMenu(items, 0);
  document.body.append(menu);
  _menus.push(menu);
  place(menu, x, y);

  const away = (e) => {
    if (!_menus.some((m) => m.contains(e.target))) {
      closeMenus(0);
      document.removeEventListener('mousedown', away);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', away), 0);
}

// --- modal dialogs ----------------------------------------------------------

function modal(build) {
  return new Promise((resolve) => {
    const back = div(`position:fixed;inset:0;z-index:${Z + 49};background:rgba(0,0,0,.35);`);
    const box = div(`position:fixed;z-index:${Z + 50};left:50%;top:38%;transform:translate(-50%,-50%);
      background:${C.panel};border:1px solid ${C.edge};border-radius:6px;padding:14px 16px;
      box-shadow:0 4px 20px rgba(0,0,0,.7);display:flex;flex-direction:column;gap:10px;
      min-width:300px;max-width:460px;font-family:ui-sans-serif,system-ui,sans-serif;color:${C.text};`);

    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      back.remove();
      box.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    };

    const focus = build(box, finish);
    document.body.append(back, box);
    back.addEventListener('mousedown', () => finish(null));
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => focus?.focus?.());
  });
}

function buttons(box, finish, { okLabel = 'OK', danger = false, onOk }) {
  const row = div('display:flex;gap:6px;justify-content:flex-end;margin-top:2px;');
  const cancel = el('button', `background:none;border:1px solid ${C.edge};color:${C.dim};font-size:11px;
    padding:4px 12px;border-radius:3px;cursor:pointer;`, 'Cancel');
  cancel.onclick = () => finish(null);
  const ok = el('button', `background:${danger ? C.danger : C.accent};border:none;
    color:${danger ? '#11111b' : '#fff'};font-size:11px;font-weight:600;padding:4px 12px;
    border-radius:3px;cursor:pointer;`, okLabel);
  ok.onclick = () => onOk(finish);
  row.append(cancel, ok);
  box.append(row);
  return ok;
}

/** One text field.  Resolves to the trimmed string, or null on cancel. */
export function showPrompt(message, initial = '', { okLabel = 'OK' } = {}) {
  return modal((box, finish) => {
    box.append(div('font-size:12px;line-height:1.5;white-space:pre-wrap;', message));
    const input = el('input', `background:${C.bg};border:1px solid ${C.edge};border-radius:4px;
      color:${C.text};padding:5px 8px;font-size:12px;width:100%;box-sizing:border-box;`);
    input.value = initial;
    box.append(input);
    const submit = (f) => {
      const v = input.value.trim();
      f(v || null);
    };
    buttons(box, finish, { okLabel, onOk: submit });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(finish); }
    });
    requestAnimationFrame(() => input.select());
    return input;
  });
}

/** Several labelled fields.  Resolves to { key: value }, or null on cancel. */
export function showForm(message, fields, { okLabel = 'OK' } = {}) {
  return modal((box, finish) => {
    box.append(div('font-size:12px;line-height:1.5;', message));
    const inputs = {};
    for (const f of fields) {
      const row = div('display:flex;flex-direction:column;gap:3px;');
      row.append(div(`font-size:11px;color:${C.dim};`, f.label));
      const input = el('input', `background:${C.bg};border:1px solid ${C.edge};border-radius:4px;
        color:${C.text};padding:5px 8px;font-size:12px;width:100%;box-sizing:border-box;`);
      input.value = f.value ?? '';
      if (f.placeholder) input.placeholder = f.placeholder;
      row.append(input);
      box.append(row);
      inputs[f.key] = input;
    }
    const submit = (f) => {
      const out = {};
      for (const [k, i] of Object.entries(inputs)) out[k] = i.value;
      f(out);
    };
    buttons(box, finish, { okLabel, onOk: submit });
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(finish); }
    });
    return Object.values(inputs)[0];
  });
}

/** Resolves true / false. */
export function showConfirm(message, { okLabel = 'OK', danger = false } = {}) {
  return modal((box, finish) => {
    box.append(div('font-size:12px;line-height:1.5;white-space:pre-wrap;', message));
    const ok = buttons(box, finish, { okLabel, danger, onOk: (f) => f(true) });
    return ok;
  }).then((v) => v === true);
}

/** A non-blocking notice.  Uses ComfyUI's own toast when it is available. */
export function toast(message, severity = 'info') {
  try {
    window.app?.extensionManager?.toast?.add?.({
      severity,
      summary: 'PLv3',
      detail: message,
      life: 4000,
    });
    return;
  } catch {}
  console.log(`[PLv3] ${message}`);
}
