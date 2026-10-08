// Native editable runs contain prompt decoration and parked (disabled) items.
// Value and caret offsets use the same visible source, including commas/spaces.
function pieces(root) {
  const result = []; let text = '';
  const append = (value, start, end) => {
    if (!value) return;
    result.push({ text: value, offset: text.length, start, end }); text += value;
  };
  const visit = node => {
    if (node.nodeType === 3) { append(node.data, [node, 0], [node, node.data.length]); return; }
    if (node.matches?.('[data-parked],[data-editor-decoration]')) return;
    if (node.nodeName === 'BR') {
      const parent = node.parentNode, index = [...parent.childNodes].indexOf(node);
      append('\n', [parent, index], [parent, index + 1]); return;
    }
    let previousBlock = false;
    for (const [index, child] of [...node.childNodes].entries()) {
      if (child.matches?.('[data-parked],[data-editor-decoration]')) continue;
      const block = ['DIV', 'P'].includes(child.nodeName);
      if ((block || previousBlock) && text && !text.endsWith('\n')) append('\n', [node, index], [child, 0]);
      visit(child); previousBlock = block;
    }
  };
  visit(root); return { text, pieces: result };
}

export function inlineText(field) {
  // Hosts in the offline queue tests need no DOM implementation.
  return field.childNodes ? pieces(field).text : field.innerText;
}

// Keep Enter inside the shared text host: native insertParagraph can clone its
// prompt/decorative spans into new paragraphs. A literal newline owns no markup.
export function insertInlineNewline(field) {
  const selection = getSelection();
  if (!selection?.rangeCount) return false;
  const range = selection.getRangeAt(0);
  if (!field.contains(range.startContainer) || !field.contains(range.endContainer)) return false;
  range.deleteContents();
  const newline = document.createTextNode('\n'); range.insertNode(newline);
  range.setStart(newline, 1); range.collapse(true);
  selection.removeAllRanges(); selection.addRange(range);
  syncInlineEnd(field);
  field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak', data: '\n' }));
  return true;
}

// Delete source newlines rather than the trailing BR used to display the last
// empty line. Native deletion can remove that decoration and leave the source
// untouched, after which syncInlineEnd would put the same blank line back.
export function deleteInlineNewline(field, inputType) {
  const selection = getSelection();
  if (!selection?.rangeCount) return false;
  const range = selection.getRangeAt(0);
  if (!field.contains(range.startContainer) || !field.contains(range.endContainer)) return false;
  const value = pieces(field);
  let start = inlineOffset(field, range.startContainer, range.startOffset);
  let end = inlineOffset(field, range.endContainer, range.endOffset);
  if (start === end) {
    const match = inputType === 'deleteContentBackward'
      ? /\r?\n[ \t]*$/.exec(value.text.slice(0, start))
      : /^[ \t]*\r?\n/.exec(value.text.slice(end));
    if (!match) return false;
    if (inputType === 'deleteContentBackward') start -= match[0].length;
    else end += match[0].length;
  }
  if (!/[\r\n]/.test(value.text.slice(start, end))) return false;
  const edits = value.pieces.filter(part => part.offset < end && part.offset + part.text.length > start);
  // Old pasted DIV/P line boundaries still belong to the browser. Literal
  // newlines and BRs can be changed without deleting parked prompt decoration.
  if (edits.some(part => part.start[0].nodeType !== 3 &&
    part.start[0].childNodes[part.start[1]]?.nodeName !== 'BR')) return false;
  for (const part of edits.reverse()) {
    const node = part.start[0], from = Math.max(0, start - part.offset), to = Math.min(part.text.length, end - part.offset);
    if (node.nodeType === 3) node.data = node.data.slice(0, from) + node.data.slice(to);
    else node.childNodes[part.start[1]].remove();
  }
  syncInlineEnd(field);
  const caret = document.createRange(); caret.setStart(...inlinePoint(field, start)); caret.collapse(true);
  selection.removeAllRanges(); selection.addRange(caret);
  field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType, data: null }));
  return true;
}

export function syncInlineEnd(field) {
  const fillers = [...field.querySelectorAll('[data-inline-end]')];
  // A terminal newline needs a visual last line in contenteditable. The filler
  // is decoration only; it must never add a second newline to text/caret offsets.
  if (inlineText(field).endsWith('\n')) {
    const last = fillers.find(node => node === field.lastChild);
    for (const filler of fillers) if (filler !== last) filler.remove();
    if (!last) {
      const filler = document.createElement('br');
      filler.dataset.inlineEnd = ''; filler.dataset.editorDecoration = ''; field.append(filler);
    }
  } else for (const filler of fillers) filler.remove();
}
export function inlineOffset(field, node, offset) {
  const range = document.createRange(); range.selectNodeContents(field); range.setEnd(node, offset);
  return inlineText(range.cloneContents()).length;
}
export function inlinePoint(field, offset) {
  for (const part of pieces(field).pieces) {
    if (offset <= part.offset + part.text.length) {
      if (part.start[0].nodeType === 3) return [part.start[0], Math.max(0, offset - part.offset)];
      return offset <= part.offset ? part.start : part.end;
    }
  }
  return [field, field.childNodes.length];
}
