// PLv3 — drive the EXISTING tag autocomplete (js/tagac.js) from the Monaco editor.
//
// tagac already carries everything worth having: danbooru + gelbooru search, the D/G
// badges that ARE the links to the wiki / posts, hover preview images, the artist's
// recent works popup, related-tag ("联想") lookup, aliases, translations, category
// colours, the min-post-count filter, and the shared settings panel. Reimplementing
// that on top of Monaco's suggest widget would be a worse copy — and Monaco's widget
// cannot host an image or a clickable badge anyway.
//
// tagac was already written against a host ABSTRACTION (`el._xyzAcc`) so that PLv2's
// contentEditable editor could reuse it. So all PLv3 needs is a second implementation
// of that interface:
//
//     getValue()  getCaret()  getSelEnd()  splice(s, e, text)  caretCoords()
//
// plus a bridge for the four events tagac listens to. Monaco does not bubble what it
// needs, so its own event API is translated into synthetic DOM events on a proxy
// element, and a key tagac consumed (it calls preventDefault) is withheld from Monaco.
//
// `[` and `.set{}` completions stay with PLv3's own Monaco provider (complete.js) —
// tagac is attached with `tagsOnly`, so it never offers PLv2's library refs here.

import { braceContextText } from './complete.js';

const NAV_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape']);

/** Wait for tagac to have registered itself (it is a separate ComfyUI extension). */
function tagacReady(timeoutMs = 8000) {
  if (window.xyzTagAC) return Promise.resolve(window.xyzTagAC);
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (window.xyzTagAC) return resolve(window.xyzTagAC);
      if (Date.now() - started > timeoutMs) return resolve(null);
      setTimeout(tick, 50);
    };
    tick();
  });
}

export async function attachTagAC(editor, container) {
  const api = await tagacReady();
  if (!api) {
    console.warn('[PLv3] tag autocomplete not available (js/tagac.js did not load)');
    return null;
  }

  // A proxy element for tagac to hang its listeners on. It overlays the editor so its
  // bounding rect is the editor's (tagac uses it to place the info panel), and it is
  // click-through so it never eats a real interaction.
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
  host.dataset.plv3TagacHost = '1';
  container.style.position = container.style.position || 'relative';
  container.appendChild(host);

  const model = () => editor.getModel();

  const adapter = {
    getValue: () => model()?.getValue() ?? '',
    getCaret: () => {
      const p = editor.getPosition();
      return p && model() ? model().getOffsetAt(p) : 0;
    },
    getSelEnd: () => {
      const s = editor.getSelection();
      return s && model() ? model().getOffsetAt(s.getEndPosition()) : 0;
    },
    /** Replace [start, end) with `text` and put the caret after it. */
    splice: (start, end, text) => {
      const m = model();
      if (!m) return;
      const range = window.monaco.Range.fromPositions(
        m.getPositionAt(start),
        m.getPositionAt(end),
      );
      // The edit we are about to make is tagac's own insertion. The content-change
      // bridge below must not report it back to tagac, or the dropdown reopens on the
      // candidate that was just chosen.
      suppressNext = true;
      editor.executeEdits('plv3-tagac', [{ range, text, forceMoveMarkers: true }]);
      const at = m.getPositionAt(start + text.length);
      editor.setPosition(at);
      editor.focus();
    },
    /** Viewport coordinates of the caret — where the dropdown anchors. */
    caretCoords: () => {
      const p = editor.getPosition();
      const vis = p && editor.getScrolledVisiblePosition(p);
      const rect = container.getBoundingClientRect();
      const lineHeight = editor.getOption(window.monaco.editor.EditorOption.lineHeight) || 19;
      if (!vis) return { top: rect.top, left: rect.left, lineHeight };
      return {
        top: rect.top + vis.top,
        left: rect.left + vis.left,
        lineHeight: vis.height || lineHeight,
      };
    },
  };

  api.attach(host, {
    adapter,
    tagsOnly: true,          // `[` and `.set{}` belong to PLv3's own completion
    synthetic: true,         // this host has no trusted DOM events of its own
    related: true,           // click a tag in the text -> related tags
    getDelimiter: () => ', ',
  });

  // PLv3's `{ }` is a group body (prompt text — tags belong here), unlike PLv2's
  // `{choice}`. Only a `.set{ … }` or a region container should withhold danbooru
  // tags; the same brace-stack complete.js uses decides it, so the two never disagree.
  host._xyzSuppressTags = (text, pos) => braceContextText(text.slice(0, pos)) !== 'text';

  // --- events -------------------------------------------------------------
  //
  // NOTHING here bubbles. tagac's listeners sit on `host` itself, so bubbling buys
  // nothing — and a synthetic keydown escaping to the document reaches ComfyUI's
  // global shortcuts, which is how a fake Delete could remove the selected node.
  let suppressNext = false;

  editor.onDidChangeModelContent(() => {
    if (suppressNext) { suppressNext = false; return; }
    host.dispatchEvent(new Event('input'));
  });

  editor.onKeyDown((e) => {
    const ev = new KeyboardEvent('keydown', {
      key: e.browserEvent.key,
      code: e.browserEvent.code,
      ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
      bubbles: false, cancelable: true,
    });
    host.dispatchEvent(ev);
    // tagac calls preventDefault on the keys it consumed (arrows / Enter / Tab /
    // Escape while its dropdown is open). Withhold exactly those from Monaco, or the
    // caret moves under the dropdown and Enter inserts a newline behind it.
    if (ev.defaultPrevented && NAV_KEYS.has(e.browserEvent.key)) {
      e.preventDefault();
      e.stopPropagation();
    }
  });

  editor.onKeyUp((e) => {
    host.dispatchEvent(new KeyboardEvent('keyup', {
      key: e.browserEvent.key, code: e.browserEvent.code,
      ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey,
      bubbles: false, cancelable: true,
    }));
  });

  editor.onDidBlurEditorText(() => {
    host.dispatchEvent(new FocusEvent('blur', { bubbles: false }));
  });

  // Clicking a tag in the text opens its related-tags panel (tagac's `related` mode).
  editor.onMouseUp(() => {
    host.dispatchEvent(new MouseEvent('click'));
  });

  return host;
}
