// Data/caret adapter for the prototype's native contenteditable fields. The
// existing TagAC owns its popup, searches, previews and pool suggestions.
import { inlineText, inlineOffset, inlinePoint } from './text_input.js';
import { autocompleteText } from './prompt_text.js';
import { tagacReady } from '../tagac_host.js';
export async function attachInlineAutocomplete(element, session) {
  // Cached DOM fields may be focused again with a fresh run after undo. The
  // autocomplete hook is shared, but its document/caret session must be current.
  element._xyzInlineSession = session;
  element._xyzPoolSuggestions = async query => {
    const current = element._xyzInlineSession;
    if (!current || current.disposed || !element.isConnected) return [];
    await current.whenIdle();
    if (current.disposed || element._xyzInlineSession !== current || !element.isConnected) return [];
    return window.xyzPLv4Suggestions?.(query, { __plv4Pane: { editSession: current } }) || [];
  };
  const api = window.xyzTagAC || await tagacReady();
  if (!api || session.disposed || element._xyzInlineSession !== session || element.isConnected === false) return;
  if (element._xyzTagACHooked) return;
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
    splice(start, end, text) {
      const range = document.createRange(); range.setStart(...point(start)); range.setEnd(...point(end));
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.execCommand('insertText', false, text);
    },
    caretCoords() {
      const selection = getSelection(); const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : element.getBoundingClientRect();
      const fallback = element.getBoundingClientRect(); return { top: rect.height ? rect.top : fallback.top, left: rect.height ? rect.left : fallback.left, lineHeight: parseFloat(getComputedStyle(element).lineHeight) || 21 };
    },
  };
  api.attach(element, { adapter, related: true, getDelimiter: () => ', ' });
}
