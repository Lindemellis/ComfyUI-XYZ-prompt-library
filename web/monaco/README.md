# Monaco Editor (vendored)

**Version:** 0.52.2 — the last release with the classic AMD `min/vs` layout.
0.53+ switched to Vite-built hashed chunks whose `editor.main` entry hard-binds
every language, which cannot be trimmed cleanly.

**Source:** `npm install monaco-editor@0.52.2` -> `node_modules/monaco-editor/min/vs`.

**Trimmed** (all lazy-loaded, so nothing fetches them once they are gone — PLv3
registers its own `plv3` language and uses no other):

| Removed | Why |
|---|---|
| `vs/language/` (7.0 MB) | TypeScript / JSON / CSS / HTML language services |
| `vs/basic-languages/` (656 KB) | Monarch definitions for ~90 languages |
| `vs/nls.messages.*.js` (1.7 MB) | Non-English locales (English is built in) |

4.2 MB remains, in 6 files. There is no build step: to upgrade, re-run the npm
install above, re-copy `min/vs`, and delete the same three things.

Loaded through the AMD loader by `js/plv3/monaco.js`, which also points
`MonacoEnvironment` at `vs/base/worker/workerMain.js`.

MIT licensed — see LICENSE.
