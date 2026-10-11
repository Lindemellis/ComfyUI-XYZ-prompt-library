// Native Blocks use the Source provider's context and grammar, with a small
// text/position adapter. TagAC remains the sole popup and keyboard owner.
import { provideCompletions, braceContextsText } from '../plv3/complete.js';
import { indexTree } from './details.js';
import { canInsertContainer } from './drop_preview.js';

export function textModel(text, session) {
  const lines = text.split('\n');
  const getOffsetAt = ({ lineNumber, column }) => lines.slice(0, lineNumber - 1).reduce((n, line) => n + line.length + 1, 0) + column - 1;
  return { __plv4Session: session, getLineContent: n => lines[n - 1] || '', getOffsetAt,
    getValueInRange: r => text.slice(getOffsetAt({ lineNumber: r.startLineNumber, column: r.startColumn }), getOffsetAt({ lineNumber: r.endLineNumber, column: r.endColumn })) };
}

export async function nativeCompletions(text, caret, session) {
  const prefix = session.parent.text.slice(0, session.contentStart), full = prefix + text;
  const before = full.slice(0, prefix.length + caret), line = before.slice(before.lastIndexOf('\n') + 1);
  // Plain prompt completions stay with TagAC. Escaped/quoted brackets are text.
  const open = line.lastIndexOf('[');
  if (open < 0 || line.slice(open).includes(']') || ((line.slice(0, open).match(/\\+$/)?.[0].length || 0) % 2)) return null;
  let quoted = false;
  for (let i = 0; i < before.length; i++) { if (before[i] === '\\') i++; else if (before[i] === '"') quoted = !quoted; }
  if (quoted) return null;
  const model = textModel(full, session.parent);
  const position = { lineNumber: before.split('\n').length, column: line.length + 1 };
  const monaco = { languages: { CompletionItemKind: { Struct: 1, Module: 2 }, CompletionItemInsertTextRule: { InsertAsSnippet: 4 } } };
  const result = await provideCompletions(monaco, model, position, { onInsertBlock: true });
  const map = indexTree(session.parent.projection.tree), owner = map.get(session.owner);
  return result.suggestions.filter(item => {
    if (item.label === '@region' && (braceContextsText(before).includes('region') || session.canInsertRegion === false || (owner && !canInsertContainer(owner, 'region', map)))) return false;
    return !item.command || typeof item.command.arguments[0] === 'object';
  }).map(item => {
    const defaults = new Map();
    const insertText = item.insertText.replace(/\$\{(\d+)(?::([^}]*))?\}|\$(\d+)/g, (_, n, value, bare) => {
      const key = n || bare; if (value != null) defaults.set(key, value); return value ?? defaults.get(key) ?? '';
    });
    const { range } = item;
    return { name: item.label, kind: 'syntax', detail: item.detail, insertText,
      start: model.getOffsetAt({ lineNumber: range.startLineNumber, column: range.startColumn }) - prefix.length,
      end: model.getOffsetAt({ lineNumber: range.endLineNumber, column: range.endColumn }) - prefix.length,
      asset: item.command?.arguments[0] };
  });
}
