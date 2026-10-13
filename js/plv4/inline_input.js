// Data/caret adapter for the prototype's native contenteditable fields. The
// existing TagAC owns its popup, searches, previews and pool suggestions.
import { inlineText, inlineOffset, inlinePoint } from './text_input.js';
import { autocompleteText } from './prompt_text.js';
import { tagacReady } from '../tagac_host.js';
import { nativeCompletions, textModel } from './native_completion.js';
export async function attachInlineAutocomplete(element, session) {
  // Cached DOM fields may be focused again with a fresh run after undo. The
  // autocomplete hook is shared, but its document/caret session must be current.
  const previous = element._xyzInlineSession;
  element._xyzInlineSession = session;
  element._xyzPoolSuggestions = async query => {
    const current = element._xyzInlineSession;
    if (!current || current.disposed || !element.isConnected) return [];
    if (current.disposed || element._xyzInlineSession !== current || !element.isConnected) return [];
    return window.xyzPLv4Suggestions?.(query, { __plv4Pane: { editSession: current } }) || [];
  };
  const api = window.xyzTagAC || await tagacReady();
  if (!api || session.disposed || element._xyzInlineSession !== session || element.isConnected === false) return;
  if (element._xyzTagACHooked) {
    // Undo/reopen can reuse the DOM field with a new run. Suggestions captured
    // by its retired run must not keep consuming Enter after their guards fail.
    if (previous !== session) api.hide?.();
    return;
  }
  const selectionOffset = end => {
    const selection = getSelection(); if (!selection?.rangeCount) return inlineText(element).length;
    const range = selection.getRangeAt(0); const node = end ? range.endContainer : range.startContainer;
    if (!element.contains(node)) return inlineText(element).length;
    return inlineOffset(element, node, end ? range.endOffset : range.startOffset);
  };
  const point = offset => {
    return inlinePoint(element, offset);
  };
  const adapter = {
    getValue: () => autocompleteText(inlineText(element)), getCaret: () => selectionOffset(false), getSelEnd: () => selectionOffset(true),
    splice(start, end, text, completion = null) {
      const range = document.createRange(); range.setStart(...point(start)); range.setEnd(...point(end));
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      element._xyzTagCompletion = completion;
      try { document.execCommand('insertText', false, text); }
      finally { delete element._xyzTagCompletion; }
    },
    caretCoords() {
      const selection = getSelection(); const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : element.getBoundingClientRect();
      const fallback = element.getBoundingClientRect(); return { top: rect.height ? rect.top : fallback.top, left: rect.height ? rect.left : fallback.left, lineHeight: parseFloat(getComputedStyle(element).lineHeight) || 21 };
    },
  };
  element._xyzSourceSuggestions = async () => {
    const current = element._xyzInlineSession, text = inlineText(element), caret = selectionOffset(false);
    if (!current || current.disposed || !element.isConnected) return null;
    const candidates = await nativeCompletions(autocompleteText(text), caret, current);
    if (current.disposed || element._xyzInlineSession !== current || !element.isConnected || inlineText(element) !== text || selectionOffset(false) !== caret) return [];
    return candidates?.map(candidate => ({ ...candidate, insert: async () => {
      if (current.disposed || element._xyzInlineSession !== current || inlineText(element) !== text || selectionOffset(false) !== caret) return;
      let end = candidate.end, insert = candidate.insertText;
      if (candidate.asset) {
        if (text[end] === ']') end++;
        insert += ']';
      }
      adapter.splice(candidate.start, end, insert);
      if (candidate.asset) {
        await current.host.blockView.flush();
        const value = inlineText(element), model = textModel(value, current);
        const at = candidate.start + insert.length, before = value.slice(0, at);
        const pane = { editSession: current, model: () => model, editor: { getPosition: () => ({ lineNumber: before.split('\n').length, column: at - before.lastIndexOf('\n') }) } };
        await window.xyzPLv4ExpandReference(pane, candidate.asset);
        current.host.blockView.focusInput(current.parent.state.selection.block_id || current.owner);
      }
    } }));
  };
  api.attach(element, { adapter, related: true, getDelimiter: () => ', ' });
}
