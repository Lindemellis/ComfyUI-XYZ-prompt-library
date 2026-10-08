import { inlinePrompt, promptDisplay } from './prompt_text.js';

// Use the same prompt projection as BlockView. Find keeps the shared Source
// model, but never searches card headers, region declarations or hidden .set
// fields. Single-line scopes avoid Monaco expanding multiline scopes to whole
// source lines (which would admit settings beside a prompt again).
export function blockFindSpans(tree, source) {
  const spans = [];
  const visit = row => {
    if (!row.effective || !row.span) return;
    if (row.kind === 'group' && row.form !== 'paren' && !inlinePrompt(row)) {
      row.children.forEach(visit); return;
    }
    const display = promptDisplay(row, source);
    let start = null, end = null;
    const flush = () => { if (start != null) spans.push([start, end]); start = end = null; };
    for (let i = 0; i < display.text.length; i++) {
      const at = display.offsets[i], next = display.offsets[i + 1], char = display.text[i];
      if (char === '\n' || char === '\r' || next !== at + 1 || source[at] !== char) { flush(); continue; }
      if (end !== at) flush();
      start ??= at; end = next;
    }
    flush();
  };
  if (tree) visit(tree);
  return spans;
}

const highlightName = 'xyz-plv4-find-current';
export function clearBlockFindHighlight() {
  globalThis.CSS?.highlights?.delete(highlightName);
}
export function highlightBlockFindMatch(range) {
  // DOM selection belongs to the query textarea while searching. A CSS range
  // highlight remains visible without moving that selection or its input focus.
  if (globalThis.CSS?.highlights && globalThis.Highlight) {
    globalThis.CSS.highlights.set(highlightName, new globalThis.Highlight(range));
  } else {
    const selected = getSelection(); selected.removeAllRanges(); selected.addRange(range);
  }
}
