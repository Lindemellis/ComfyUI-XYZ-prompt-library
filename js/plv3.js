// PLv3 — ComfyUI extension entry: the node's Editor button + node->editor sync.

import { app } from '../../../scripts/app.js';
import { libraryWindow } from './plv3/library.js';
import { PLV3_TYPES, plv3Window } from './plv3/window.js';

// The top-bar menu (gallery_topbar.js) opens these without importing the modules —
// the same handle PLv2 exposes as `window.plv2`.
window.plv3 = {
  window: plv3Window,
  library: libraryWindow,
};

const BTN_H = 32;   // the button itself
const ROW_H = 40;   // the widget row it sits in, with a little breathing room

function button(label) {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = `flex:1;height:${BTN_H}px;padding:0 10px;border-radius:5px;
    border:1px solid #45475a;background:#313244;color:#cdd6f4;cursor:pointer;
    font-size:13px;font-weight:600;letter-spacing:.02em;line-height:1;
    font-family:ui-sans-serif,system-ui,sans-serif;transition:background .12s;`;
  b.onmouseenter = () => (b.style.background = '#3d3d52');
  b.onmouseleave = () => (b.style.background = '#313244');
  return b;
}

app.registerExtension({
  name: 'XYZNodes.PromptLibraryV3',

  async nodeCreated(node) {
    if (!PLV3_TYPES.has(node.comfyClass)) return;
    node.serialize_widgets = true;

    const wrap = document.createElement('div');
    wrap.style.cssText = `display:flex;align-items:center;gap:6px;width:100%;
      height:${ROW_H}px;box-sizing:border-box;`;
    const edit = button('Editor');
    edit.addEventListener('click', () => {
      // Without this the window's async failures become silent unhandled
      // rejections and the button simply does nothing. Report on the button
      // itself — never alert(), which blocks ComfyUI's whole main thread.
      plv3Window.toggle(node).catch((err) => {
        console.error('[PLv3] could not open the editor', err);
        edit.textContent = 'Editor failed — see console';
        setTimeout(() => (edit.textContent = 'Editor'), 4000);
      });
    });
    wrap.append(edit);

    const w = node.addDOMWidget('plv3_open_btns', 'custom', wrap, {
      getValue: () => '',
      setValue: () => {},
      serialize: false,
    });
    w.computeSize = () => [node.size[0], ROW_H];
    // ComfyUI v2.0 (Vue) lays out every widget whose computeLayoutSize is a
    // function in a stretchable grid row, which leaves a big gap under a
    // fixed-height button bar. Shadowing it with a non-function makes the new
    // renderer treat the widget as min-content; the classic renderer ignores
    // this and keeps using computeSize.
    w.computeLayoutSize = undefined;

    // node -> editor. The text widget fires its `callback` on every edit in BOTH
    // renderers; listening on `inputEl` only works in the classic one (in the Vue
    // renderer inputEl is an orphan element that is never mounted).
    const tw = node.widgets?.find((x) => x.name === 'text');
    if (tw) {
      const orig = tw.callback;
      tw.callback = function (v) {
        const r = orig ? orig.apply(this, arguments) : undefined;
        const value = typeof v === 'string' ? v : tw.value;
        document.dispatchEvent(
          new CustomEvent('plv3:node-edited', { detail: { nodeId: node.id, value } }),
        );
        return r;
      };
    }
  },
});
