// Native editable runs contain prompt decoration and parked (disabled) items.
// Value and caret offsets use the same visible source, including commas/spaces.
function pieces(root, nativeTerminator = true) {
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
  visit(root);
  // Chromium plaintext editing ends a blank final line with an extra newline.
  // That display terminator is not part of the user's value.
  if (nativeTerminator && root.contentEditable === 'plaintext-only' && text.endsWith('\n')) {
    text = text.slice(0, -1);
    const last = result.at(-1); last.text = last.text.slice(0, -1);
    if (!last.text) result.pop();
  }
  return { text, pieces: result };
}

export function inlineText(field) {
  // Hosts in the offline queue tests need no DOM implementation.
  return field.childNodes ? pieces(field).text : field.innerText;
}

// Initial rendered text needs the same display terminator that the browser
// maintains during native editing. Never rewrite it during an input event.
export function renderInlineEnd(field) {
  if (pieces(field, false).text.endsWith('\n')) field.append(document.createTextNode('\n'));
}
export function inlineOffset(field, node, offset) {
  const range = document.createRange(); range.selectNodeContents(field); range.setEnd(node, offset);
  return Math.min(pieces(range.cloneContents(), false).text.length, inlineText(field).length);
}
export function inlinePoint(field, offset) {
  const value = pieces(field);
  for (const [index, part] of value.pieces.entries()) {
    if (offset <= part.offset + part.text.length) {
      if (offset === part.offset + part.text.length && part.text.endsWith('\n')) {
        const next = value.pieces[index + 1];
        if (next) return next.start;
      }
      if (part.start[0].nodeType === 3) return [part.start[0], Math.max(0, offset - part.offset)];
      return offset <= part.offset ? part.start : part.end;
    }
  }
  return [field, field.childNodes.length];
}
