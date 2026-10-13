// Block UI uses familiar attention and Prompt Control interval syntax. The
// document remains PLv3; mappings keep native caret/selection offsets accurate.
const number = value => String(Number(Number(value).toPrecision(12)));
const numeric = '[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?';
const intervalTail = new RegExp(`(?:,\\s*)?:\\s*(${numeric})\\s*,\\s*(${numeric})\\s*$`);
const attentionTail = new RegExp(`:(${numeric})\\s*$`);

// Input convenience only: the PLv3 parser/compiler still owns item splitting.
// Protect literal strings, LoRA names, block headers and .set configuration.
export function normalizePromptInput(value) {
  const text = String(value); let out = '';
  for (let i = 0; i < text.length;) {
    if (text[i] === '\\' && i + 1 < text.length) { out += text.slice(i, i + 2); i += 2; continue; }
    if (text[i] === '"') {
      let end = i + 1;
      while (end < text.length) { if (text[end] === '\\') end += 2; else if (text[end++] === '"') break; }
      out += text.slice(i, end); i = end; continue;
    }
    const settings = text.startsWith('.set', i) && /^\.set\s*\{/.exec(text.slice(i));
    const start = settings ? i + settings[0].length - 1 : i;
    if (settings || text[i] === '<' || text[i] === '[') {
      const end = closeAt(text, start);
      if (end >= 0 && (settings || text[i] === '<' || /^\s*:/.test(text.slice(end + 1)))) {
        out += text.slice(i, end + 1); i = end + 1; continue;
      }
    }
    out += text[i] === '，' ? ',' : text[i]; i++;
  }
  return out;
}

// Same cleanItem rule as the PLv3 node window: autocomplete's trailing comma
// and pasted leading/trailing separators never belong to an individual prompt.
export const cleanPromptInput = value => normalizePromptInput(value).replace(/^[\s,]+/, '').replace(/[\s,]+$/, '');

export const inlinePrompt = row => row.form === 'brace' && row.meta?.presentation === 'prompt' &&
  row.children.length === 1 && row.children[0].enabled && !row.settings?.region &&
  (row.children[0].kind !== 'group' || row.children[0].form === 'paren') &&
  !row.settings?.shuffle && !row.settings?.random_select && !row.settings?.dropout &&
  !row.settings?.format && row.settings?.seed == null;

export function promptDisplay(row, source) {
  const start = row.span?.[0] ?? 0;
  const raw = row.span ? source.slice(...row.span) : row.source;
  const literal = { text: raw, offsets: Array.from({ length: raw.length + 1 }, (_, i) => start + i) };
  const settings = row.settings || {};
  // Legacy single-prompt Regions are real block cards now. Never discard their
  // settings, nor flatten user-created blocks or parked children into raw text.
  if (!inlinePrompt(row)) return literal;
  const child = row.children[0];
  let body = promptDisplay(child, source), text = body.text, offsets = [...body.offsets];
  const wrap = (head, tail) => {
    offsets = [...Array(head.length).fill(start), ...offsets, ...Array(tail.length).fill(row.span?.[1] ?? start + raw.length)];
    text = head + text + tail;
    offsets[0] = start; offsets[offsets.length - 1] = row.span?.[1] ?? start + raw.length;
  };
  if (settings.weight != null && (settings.weight !== 1 || !settings.schedule)) wrap('(', `:${number(settings.weight)})`);
  if (settings.schedule) wrap('[', `:${settings.schedule.map(number).join(',')}]`);
  return { text, offsets };
}

export function separatorDisplay(source, start, end) {
  const raw = source.slice(start, end);
  // Indentation belongs to the PLv3 block layout, already represented by cards.
  // Generated indentation is a tab or at least two spaces; a newline followed by
  // one space is a native Enter typed before an existing separator space
  // (`skinny,| long`). Treating that as layout hid the typed blank line.
  if (!/^[\s,]*$/.test(raw) || !/(?:\r\n|[\r\n])(?:\t| {2})/.test(raw)) {
    return { text: raw, offsets: Array.from({ length: raw.length + 1 }, (_, i) => start + i) };
  }
  let text = '', offsets = [start];
  const layout = /[ \t]*(?:\r\n|[\r\n])(?:\t| {2})[ \t]*/y;
  for (let i = 0; i < raw.length;) {
    layout.lastIndex = i;
    const match = layout.exec(raw);
    const next = i + (match?.[0].length || 1);
    text += match ? ' ' : raw[i];
    offsets.push(start + next); i = next;
  }
  return { text, offsets };
}

export function displayRun(rows, source, start, end) {
  const live = rows.filter(row => row.effective && row.span);
  let text = '', offsets = [start], cursor = start;
  const originals = [], separators = [];
  const appendGap = (next, trailing = false) => {
    const gap = trailing ? { text: source.slice(cursor, next), offsets: Array.from({ length: next - cursor + 1 }, (_, i) => cursor + i) } : separatorDisplay(source, cursor, next), at = text.length;
    if (gap.text !== source.slice(cursor, next)) separators.push({ start: at, end: at + gap.text.length,
      text: gap.text, source: source.slice(cursor, next), offsets: gap.offsets.map(offset => offset - cursor) });
    offsets.push(...gap.offsets.slice(1)); text += gap.text;
  };
  for (const row of live) {
    if (row.span[0] < start || row.span[1] > end) continue;
    appendGap(row.span[0]);
    const piece = promptDisplay(row, source);
    offsets[offsets.length - 1] = piece.offsets[0];
    offsets.push(...piece.offsets.slice(1)); text += piece.text;
    const raw = source.slice(...row.span);
    if (piece.text !== raw) originals.push({ text: piece.text, source: raw,
      offsets: piece.offsets.map(at => at - row.span[0]), prompt: row.meta?.presentation === 'prompt' });
    cursor = row.span[1];
  }
  appendGap(end, true);
  return { text, offsets, originals, separators };
}

export function runEnd(rows, parent, source) {
  const last = rows.filter(row => row.effective && row.span).at(-1);
  if (!last) return null;
  const end = last.span[1], children = parent?.children || [];
  const next = children.slice(children.findIndex(row => row.id === last.id) + 1).find(row => row.effective && row.span);
  const content = parent?.ast?.spans?.content;
  const limit = next?.span[0] ?? content?.[1] ?? end;
  // A trailing separator is an unfinished next prompt, owned by this run.
  // Dropping it from the display/range on blur makes the next edit fuse tags.
  // Before another block, its separating comma still belongs to the layout.
  let gap = (next ? /^\s*/ : /^[\s,]*/).exec(source.slice(end, limit))[0];
  // Closing-brace layout is already represented by the card. Remove only its
  // single layout line, leaving additional Enter/blank lines editable on reopen.
  if (!next && parent?.form !== 'root' && content && /^\s*\n[ \t]+/.test(source.slice(content[0], children.find(row => row.effective && row.span)?.span[0] ?? content[0]))) {
    gap = gap.replace(/\r?\n[ \t]*$/, '');
  }
  return /[,\r\n]/.test(gap) ? end + gap.length : end;
}

// Balanced constructs, escaped punctuation and LoRA names must survive intact.
function closeAt(text, start) {
  const stack = [], pairs = { '[': ']', '(': ')', '{': '}', '<': '>' };
  for (let i = start; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '"') {
      while (++i < text.length) { if (text[i] === '\\') i++; else if (text[i] === '"') break; }
      continue;
    }
    if (pairs[text[i]]) stack.push(pairs[text[i]]);
    else if (stack.at(-1) === text[i]) { stack.pop(); if (!stack.length) return i; }
  }
  return -1;
}

export function autocompleteText(text) {
  // TagAC suppresses tags inside Library-path brackets. Hide only PC range
  // punctuation from its token reader, keeping the exact UTF-16 DOM offsets.
  const masked = text.split('');
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] !== '[') continue;
    const end = closeAt(text, i);
    if (end < 0) continue;
    const tail = intervalTail.exec(text.slice(i + 1, end));
    if (!tail) continue;
    masked[i] = ' ';
    const start = i + 1 + tail.index;
    for (let at = start; at <= end; at++) masked[at] = at === start ? '\n' : ' ';
  }
  return masked.join('');
}

export function scheduleSource(text, originals = [], previous = null) {
  let source = '';
  const offsets = Array(text.length + 1), promptSpans = [];
  // Preserve source layout around the actual text edit. Projected commas/spaces
  // have different source lengths; copying the display back would reformat them.
  const separators = [];
  if (previous?.separators?.length) {
    let prefix = 0, suffix = 0;
    const old = previous.text, limit = Math.min(old.length, text.length);
    while (prefix < limit && old[prefix] === text[prefix]) prefix++;
    while (suffix < limit - prefix && old[old.length - 1 - suffix] === text[text.length - 1 - suffix]) suffix++;
    for (const gap of previous.separators) {
      const at = gap.end <= prefix ? gap.start : gap.start >= old.length - suffix ? gap.start + text.length - old.length : null;
      if (at != null) separators.push({ ...gap, start: at, end: at + gap.text.length });
    }
  }
  const literal = (value, a, b) => {
    const start = source.length; source += value;
    for (let i = a; i <= b; i++) offsets[i] = start + Math.round((i - a) * value.length / Math.max(1, b - a));
  };
  const walk = (a, b) => {
    for (let i = a; i < b;) {
      const gap = separators.find(gap => gap.start === i && gap.end <= b);
      if (gap) {
        const start = source.length; source += gap.source;
        for (let at = 0; at <= gap.text.length; at++) offsets[i + at] = start + gap.offsets[at];
        i = gap.end; continue;
      }
      const original = originals.find(piece => piece.text && text.startsWith(piece.text, i) && i + piece.text.length <= b &&
        (/[\])}]$/.test(piece.text) || /^(?:\s*[,\.]|\s*$)/.test(text.slice(i + piece.text.length, b))));
      if (original) {
        const start = source.length; source += original.source;
        for (let at = 0; at <= original.text.length; at++) offsets[i + at] = start + original.offsets[at];
        if (original.prompt) promptSpans.push([start, source.length]);
        i += original.text.length; continue;
      }
      if (text[i] === '\\' && i + 1 < b) { literal(text.slice(i, i + 2), i, i + 2); i += 2; continue; }
      if (text[i] === '<') {
        const end = closeAt(text, i);
        if (end >= 0 && end < b) { literal(text.slice(i, end + 1), i, end + 1); i = end + 1; continue; }
      }
      if (text[i] === '[') {
        const end = closeAt(text, i), inner = text.slice(i + 1, end);
        const tail = end >= 0 && end < b ? intervalTail.exec(inner) : null;
        if (tail) {
          const range = tail.slice(1).map(Number);
          if (!(0 <= range[0] && range[0] <= range[1] && range[1] <= 1)) throw new Error('Schedule 区间需要满足 0 ≤ start ≤ end ≤ 1');
          let bodyStart = i + 1, bodyEnd = bodyStart + tail.index, weight = null;
          while (/\s/.test(text[bodyStart] || '') && bodyStart < bodyEnd) bodyStart++;
          while (/\s/.test(text[bodyEnd - 1] || '') && bodyEnd > bodyStart) bodyEnd--;
          if (text[bodyStart] === '(' && closeAt(text, bodyStart) === bodyEnd - 1) {
            const attention = attentionTail.exec(text.slice(bodyStart + 1, bodyEnd - 1));
            if (attention) { weight = Number(attention[1]); bodyEnd = bodyStart + 1 + attention.index; bodyStart++; }
          }
          const start = source.length;
          literal('{ ', i, bodyStart); walk(bodyStart, bodyEnd);
          literal(` }.set{${weight == null ? '' : `weight: ${number(weight)}, `}schedule: {${range.map(number).join(', ')}}}`, bodyEnd, end + 1);
          promptSpans.push([start, source.length]); i = end + 1; continue;
        }
      }
      literal(text[i], i, i + 1); i++;
    }
  };
  walk(0, text.length); offsets[0] = 0; offsets[text.length] = source.length;
  return { source, offsets, promptSpans };
}
