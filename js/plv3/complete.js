// PLv3 — autocomplete (spec §8.1): danbooru tags, library paths, `.set{}` fields.
//
// Three sources, one provider, chosen by what the caret is sitting in:
//
//   inside `[`            -> library group paths, which insert the fully expanded
//                            block (a document never holds a bare pointer, §3.6)
//   inside `.set{ … }`    -> the field names (see language.js)
//   plain prompt text     -> NOT here: danbooru tags come from js/tagac.js, the same
//                            autocomplete PLv2 uses (see tagac_monaco.js). It brings
//                            the wiki links, preview images, artist works and related
//                            tags, which a Monaco suggest item cannot render.

let _tree = null;
let _treeAt = 0;

async function libraryPaths() {
  // Cheap cache: the tree only changes when the library window writes to it.
  if (_tree && Date.now() - _treeAt < 5000) return _tree;
  try {
    const res = await fetch('/xyz/plv3/library/tree');
    const data = await res.json();
    _tree = data.groups || [];
    _treeAt = Date.now();
  } catch {
    _tree = [];
  }
  return _tree;
}

export function invalidateLibraryCache() {
  _tree = null;
}

/** What is the caret in?  The Monarch state is not exposed, so read the line. */
function contextAt(model, position) {
  const line = model.getLineContent(position.lineNumber);
  const before = line.slice(0, position.column - 1);

  // A `[` that is still open on this line: a library path is being typed.
  const open = before.lastIndexOf('[');
  if (open !== -1 && !before.slice(open).includes(']')) {
    return { kind: 'path', from: open + 1, word: before.slice(open + 1) };
  }

  // Anything after the last separator is the tag being typed.
  const start = Math.max(
    before.lastIndexOf(','),
    before.lastIndexOf('{'),
    before.lastIndexOf('('),
    before.lastIndexOf('}'),
    before.lastIndexOf(')'),
  );
  return { kind: 'tag', from: start + 1, word: before.slice(start + 1).trimStart() };
}

/** True when the caret sits inside a `.set{ … }` — those are language.js's job. */
function inSetBlock(model, position) {
  const upto = model.getValueInRange({
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  });
  const set = upto.lastIndexOf('.set{');
  if (set === -1) return false;
  const after = upto.slice(set);
  let depth = 0;
  for (const c of after) {
    if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  return depth > 0;
}

/** Is the caret inside the body of a `[@region] { … }`?  A `[` means something else in
 *  there: it opens a region segment (`[imask: 0]: { … }`), not a library path. */
function inRegionBlock(model, position) {
  const upto = model.getValueInRange({
    startLineNumber: 1, startColumn: 1,
    endLineNumber: position.lineNumber, endColumn: position.column,
  });
  const at = upto.lastIndexOf('[@region]');
  if (at === -1) return false;
  let depth = 0;
  let opened = false;
  for (const c of upto.slice(at)) {
    if (c === '{') { depth++; opened = true; }
    else if (c === '}') depth--;
  }
  return opened && depth > 0;
}

/** The `[@schedule]` / `[@region]` blocks, and — inside a region — its segments.
 *
 *  These are snippets, not plain text: the block's shape is the whole point, and typing
 *  it from memory is where the syntax errors come from. The `]` the editor auto-closed
 *  is swallowed by the range, so the completion writes the whole `…]: { … }` itself
 *  instead of leaving a stray bracket behind. */
function specialBlocks(monaco, model, position, range, needle) {
  const line = model.getLineContent(position.lineNumber);
  const closer = line[position.column - 1] === ']';   // the auto-closed `]` sits there
  const r = closer ? { ...range, endColumn: position.column + 1 } : range;
  const indent = (line.match(/^\s*/) || [''])[0];
  const I = `${indent}    `;

  const items = inRegionBlock(model, position)
    ? [
      ['@imask', 'region segment · an attached mask',
        'imask: i is the CLIP ATTACH ORDER, not the Mask Editor’s output slot number',
        `imask: \${1:0}, feather: \${2:12}]: {\n${I}    \${3:red dress},\n${I}}`],
      ['@mask', 'region segment · a rectangle',
        'mask: [x1, x2, y1, y2] — 0–1 fractions or pixels',
        `mask: [\${1:0}, \${2:0.5}, \${3:0}, \${4:1}], feather: \${5:12}]: {\n${I}    \${6:red dress},\n${I}}`],
    ]
    : [
      ['@schedule', 'schedule block',
        'Each entry lives in its own slice of the run: `0 - 0.3: closed eyes`',
        `@schedule]: {\n${I}\${1:0} - \${2:0.3}: \${3:closed eyes},\n${I}\${2:0.3} - 1: \${4:open eyes},\n${indent}}`],
      ['@region', 'region block',
        'base is everything; each segment adds the ambient text plus its own content',
        `@region]: {\n${I}base: { \${1:2girls} }\n\n${I}[imask: 0, feather: 12]: {\n${I}    \${2:red dress},\n${I}}\n\n${I}fill: { \${3:detailed background} }\n${indent}}`],
    ];

  return items
    .filter(([label]) => label.toLowerCase().includes(needle.toLowerCase().replace(/^@/, '')))
    .map(([label, detail, doc, insertText]) => ({
      label,
      kind: monaco.languages.CompletionItemKind.Struct,
      detail,
      documentation: doc,
      insertText,
      insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
      range: r,
      sortText: `0${label}`,   // above the library paths: they are what `[` is FOR here
    }));
}

export async function provideCompletions(monaco, model, position, { onInsertBlock } = {}) {
  if (inSetBlock(model, position)) return { suggestions: [] };

  const ctx = contextAt(model, position);
  const range = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: ctx.from + 1,
    endColumn: position.column,
  };

  if (ctx.kind === 'path') {
    const groups = await libraryPaths();
    const needle = ctx.word.toLowerCase();
    return {
      suggestions: [
        // `[` opens three different things, and until now it only offered one of them.
        // The two special blocks are the hardest syntax in PLv3 to type from memory —
        // exactly what a completion is for.
        ...specialBlocks(monaco, model, position, range, needle),
        ...groups
        .filter((g) => g.path.toLowerCase().includes(needle))
        .slice(0, 40)
        .map((g) => ({
          label: g.path,
          kind: monaco.languages.CompletionItemKind.Module,
          detail: 'library group',
          // A bare `[path]` is a pointer, and a PLv3 document never holds one: what
          // lands in the text is the fully expanded block (spec §3.6, §4.7). Monaco
          // cannot insert text asynchronously, so the completion writes the path and
          // then fires a command that swaps it for the real block.
          // NOT `path]`: the editor auto-closes `[`, so the `]` is already sitting
          // after the caret. Writing another one leaves `[path]]` behind, and the
          // stray bracket is a syntax error the moment the block is expanded.
          insertText: g.path,
          range,
          command: onInsertBlock && {
            id: 'plv3.expandLibraryBlock',
            title: 'expand',
            arguments: [g.id],
          },
        })),
      ],
    };
  }

  // Prompt text belongs to tagac (js/tagac.js, bridged in tagac_monaco.js): it has the
  // D/G wiki links, the preview images, the artist-works popup and the related-tag
  // lookup — none of which Monaco's suggest widget can render. Two dropdowns fighting
  // over the same caret is worse than one good one.
  return { suggestions: [] };
}

export function registerCompletions(monaco, langId, opts = {}) {
  monaco.languages.registerCompletionItemProvider(langId, {
    triggerCharacters: ['[', ',', ' '],
    provideCompletionItems: (model, position) =>
      provideCompletions(monaco, model, position, opts),
  });
}
