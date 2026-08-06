// PLv3 — Monaco bootstrap.
//
// The vendored AMD build lives in web/monaco/ and is served by our own static
// route, NOT from WEB_DIRECTORY: ComfyUI globs `**/*.js` under WEB_DIRECTORY and
// imports every hit as an ES module (server.py:353), which would drag Monaco's
// AMD bundle and its web worker into the main thread.
//
// Monaco's loader also installs a global AMD `require`, so it is loaded exactly
// once and handed back through a singleton promise.

import { T } from './theme.js';

const BASE = '/xyz/plv3/monaco/';
const VS = BASE + 'vs';

let _loading = null;

function _script(src) {
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error(`failed to load ${src}`));
    document.head.appendChild(el);
  });
}

export function loadMonaco() {
  if (_loading) return _loading;

  _loading = (async () => {
    // The worker is served from our extension path, which the page may consider
    // a different origin than the document. Monaco's documented workaround: hand
    // it a tiny same-origin blob that sets the base URL and importScripts the
    // real worker.
    window.MonacoEnvironment = {
      getWorkerUrl() {
        const shim = `self.MonacoEnvironment = { baseUrl: '${BASE}' };
                      importScripts('${VS}/base/worker/workerMain.js');`;
        return URL.createObjectURL(new Blob([shim], { type: 'text/javascript' }));
      },
    };

    await _script(`${VS}/loader.js`);
    const amdRequire = window.require;
    amdRequire.config({ paths: { vs: VS } });

    const monaco = await new Promise((resolve, reject) => {
      try {
        amdRequire(['vs/editor/editor.main'], () => resolve(window.monaco));
      } catch (err) {
        reject(err);
      }
    });

    // Every colour comes from theme.js. This used to be a hand-written copy of the same
    // palette, which meant the editor kept the old colours whenever the windows changed.
    // Monaco wants its token colours WITHOUT the leading '#'; the chrome colours WITH it.
    const hex = (c) => c.replace('#', '');
    monaco.editor.defineTheme('plv3-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'tag.plv3', foreground: hex(T.text) },               // plain prompt text
        { token: 'keyword.block.plv3', foreground: hex(T.bad), fontStyle: 'bold' }, // [@schedule] / [@region]
        { token: 'keyword.set.plv3', foreground: hex(T.region), fontStyle: 'bold' },   // .set
        { token: 'keyword.plv3', foreground: hex(T.region) },         // base / fill / true / false
        { token: 'attribute.name.plv3', foreground: hex(T.accent) },  // .set{} field names
        { token: 'path.plv3', foreground: hex(T.lib) },               // library group path
        { token: 'number.plv3', foreground: hex(T.time) },
        { token: 'number.weight.plv3', foreground: hex(T.time), fontStyle: 'bold' },
        { token: 'string.plv3', foreground: hex(T.good) },
        { token: 'escape.plv3', foreground: hex(T.warn) },
        { token: 'lora.plv3', foreground: hex(T.lora), fontStyle: 'italic' },
        { token: 'delimiter.plv3', foreground: hex(T.muted) },
      ],
      colors: {
        'editor.background': T.bg1,
        'editorGutter.background': T.bg1,
        'editorLineNumber.foreground': T.edge,
        'editor.lineHighlightBackground': T.bg2,
      },
    });

    return monaco;
  })();

  return _loading;
}
