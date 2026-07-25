// PLv3 — Monaco language: Monarch grammar, folding, indentation, completions.
//
// The grammar mirrors prompt_library_v3/lexer.py + parser.py. Keep the two in
// step: if a reserved character changes there, it changes here.

import { braceContext } from './complete.js';

export const LANG_ID = 'plv3';

const SET_FIELDS = [
  ['weight', 'number', 'Weight of the whole group -> (text:weight)'],
  ['format', 'string', 'Format each item; $p is the item -> "masterpiece $p"'],
  ['shuffle', 'boolean', 'Shuffle the items on every run'],
  ['random_select', 'a | a-b', 'Pick a (or a..b) items at random'],
  ['dropout', '0..1', 'Drop each item with this probability'],
  ['seed', 'int', 'Lock this group\'s random source'],
  ['schedule', '{start, end}', 'This group is only live in that time window'],
  ['region', '{...} | base | fill', 'This group becomes its own region segment'],
];

const REGION_FIELDS = [
  ['kind', 'base | fill | mask | imask', 'Region type (inferred if omitted)'],
  ['mask', '[x1, x2, y1, y2]', 'Rectangle, 0-1 or pixels'],
  ['imask', 'int', 'Index of an externally attached mask (= attach order!)'],
  ['feather', 'int', 'Edge feather, in pixels'],
  ['mask_weight', 'number', 'Mask weight — spatial share (base/mask/imask)'],
  ['cond_weight', 'number', 'Cond weight — semantic strength (all kinds)'],
  ['include_in_base', 'boolean', 'Also copy this content into the base segment'],
];

const ALL_FIELD_NAMES = [...SET_FIELDS, ...REGION_FIELDS].map(([n]) => n);

// --- Monarch ---------------------------------------------------------------

const MONARCH = {
  defaultToken: 'tag',
  // A Monarch `@name` inlined into a regex must be a *string* — an array is only
  // legal in a `cases` block. So the field set is an alternation, not a list.
  fields: `(?:${ALL_FIELD_NAMES.join('|')})`,

  tokenizer: {
    root: [
      [/\\./, 'escape'],
      [/\[@(schedule|region)\]/, 'keyword.block'],
      // a `[@schedule]` entry head: `0 - 0.2:`
      [/-?[\d.]+\s*-\s*-?[\d.]+(?=\s*:)/, 'number.weight'],
      [/\.set(?=\s*\{)/, 'keyword.set'],
      [/<[A-Za-z_]\w*:[^>\n]*>/, 'lora'],
      // the weight tail of a paren group: only a `: number` right before the `)`
      [/:(?=\s*[\d.]+\s*\))/, 'delimiter'],
      [/[\d.]+(?=\s*\))/, 'number.weight'],
      [/\{/, { token: 'delimiter', next: '@config_or_group' }],
      [/\[/, { token: 'delimiter', next: '@bracket' }],
      [/[}()]/, 'delimiter'],
      [/,/, 'delimiter'],
      [/[^\\[\]{}(),:<]+/, 'tag'],
      [/./, 'tag'], // a lone `:` or `<` is literal prompt text
    ],

    // A `{` in the body is a prompt group; inside `.set` it is a config block.
    // Monarch cannot look behind, so both live in the same state and the config
    // rules are simply written to not match ordinary prompt text.
    config_or_group: [
      [/\\./, 'escape'],
      // Whitespace must be its own token, or root's greedy tag rule below swallows
      // the indent together with the word after it and `base` never gets to match.
      [/[ \t]+/, 'white'],
      [/\}/, { token: 'delimiter', next: '@pop' }],
      [/@fields(?=\s*:)/, 'attribute.name'],
      [/"[^"\n]*"/, 'string'],
      [/\b(true|false|base|fill)\b/, 'keyword'],
      { include: '@root' },
    ],

    // `[...]` — a library path, a schedule interval, or a region param list.
    bracket: [
      [/\\./, 'escape'],
      [/[ \t]+/, 'white'],
      [/\]/, { token: 'delimiter', next: '@pop' }],
      [/\[/, { token: 'delimiter', next: '@bracket' }],
      [/@fields(?=\s*:)/, 'attribute.name'],
      [/\b(true|false|base|fill)\b/, 'keyword'],
      [/-?[\d.]+/, 'number'],
      [/[,:]/, 'delimiter'],
      [/[^\][,:\\]+/, 'path'],
    ],
  },
};

const CONFIG = {
  brackets: [
    ['{', '}'],
    ['[', ']'],
    ['(', ')'],
  ],
  autoClosingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
    { open: '"', close: '"' },
  ],
  surroundingPairs: [
    { open: '{', close: '}' },
    { open: '[', close: ']' },
    { open: '(', close: ')' },
  ],
};

// --- folding ---------------------------------------------------------------
//
// Monaco's default strategy is indentation-based, which folds nothing useful in
// a prompt document. Fold on balanced `{}` / `[]` instead — the same scan the
// lexer does, minus the semantics.

export function foldingRanges(model) {
  const ranges = [];
  const stack = [];
  const lineCount = model.getLineCount();

  for (let line = 1; line <= lineCount; line++) {
    const text = model.getLineContent(line);
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '\\') {
        i++; // escape pair — never structural
        continue;
      }
      if (c === '{' || c === '[') {
        stack.push(line);
      } else if (c === '}' || c === ']') {
        const start = stack.pop();
        if (start !== undefined && line > start) {
          ranges.push({ start, end: line - 1 });
        }
      }
    }
  }
  return ranges;
}

// --- completions -----------------------------------------------------------

function completions(monaco, model, position) {
  // Field names only make sense inside an open `.set{ … }`. A brace STACK (not a
  // lastIndexOf) is what tells a plain group `{ }` apart from a set block: after a
  // `.set{ … }` closes, the next `{` used to still read as "in a set block" and the
  // field list buried the tag completions over ordinary prompt text.
  if (braceContext(model, position) !== 'set') return { suggestions: [] };

  const upto = model.getValueInRange({
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  });

  // Which field set applies depends on whether this `.set{}` hangs off a region.
  const lastSet = upto.lastIndexOf('.set{');
  const lastRegion = upto.lastIndexOf('region');
  const inRegion = lastRegion > lastSet && !upto.slice(lastRegion).includes('}');
  const fields = inRegion ? REGION_FIELDS : SET_FIELDS;

  const word = model.getWordUntilPosition(position);
  const range = {
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: word.endColumn,
  };

  return {
    suggestions: fields.map(([name, type, doc]) => ({
      label: name,
      kind: monaco.languages.CompletionItemKind.Property,
      detail: type,
      documentation: doc,
      insertText: `${name}: `,
      range,
    })),
  };
}

// --- "replace in prompt text only" -----------------------------------------
//
// Spec §8.1: find/replace must not rewrite the syntax vocabulary (`.set`, field
// names, `[@schedule]`, library paths, …). Monaco's built-in find widget has no
// idea what a token is, so this walks the tokenizer and only touches runs that
// came out as prompt text.

export function replaceInTagsOnly(monaco, editor, find, replace, { matchCase = false } = {}) {
  const model = editor.getModel();
  if (!model || !find) return 0;

  const edits = [];
  const lineCount = model.getLineCount();
  const needle = matchCase ? find : find.toLowerCase();

  for (let line = 1; line <= lineCount; line++) {
    const text = model.getLineContent(line);
    const tokens = monaco.editor.tokenize(text, LANG_ID)[line - 1] || [];

    for (let t = 0; t < tokens.length; t++) {
      if (!tokens[t].type.startsWith('tag')) continue;
      const from = tokens[t].offset;
      const to = t + 1 < tokens.length ? tokens[t + 1].offset : text.length;
      const chunk = text.slice(from, to);
      const hay = matchCase ? chunk : chunk.toLowerCase();

      let at = hay.indexOf(needle);
      while (at !== -1) {
        edits.push({
          range: new monaco.Range(line, from + at + 1, line, from + at + find.length + 1),
          text: replace,
        });
        at = hay.indexOf(needle, at + find.length);
      }
    }
  }

  if (edits.length) editor.executeEdits('plv3-replace-tags', edits);
  return edits.length;
}

// --- registration ----------------------------------------------------------

let _registered = false;

export function registerLanguage(monaco) {
  if (_registered) return;
  _registered = true;

  monaco.languages.register({ id: LANG_ID });
  monaco.languages.setMonarchTokensProvider(LANG_ID, MONARCH);
  monaco.languages.setLanguageConfiguration(LANG_ID, CONFIG);

  monaco.languages.registerFoldingRangeProvider(LANG_ID, {
    provideFoldingRanges: (model) => foldingRanges(model),
  });

  monaco.languages.registerCompletionItemProvider(LANG_ID, {
    triggerCharacters: ['{', ',', ' '],
    provideCompletionItems: (model, position) => completions(monaco, model, position),
  });
}
