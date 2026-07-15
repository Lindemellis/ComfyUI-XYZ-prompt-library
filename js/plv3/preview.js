// PLv3 — the preview panel: what the node will actually hand to prompt-control.
//
// Sits at the bottom of the text editor, collapsed by default. When the document
// compiles to more than one segment, each region gets its own tab — a segment is
// a separate prompt, so showing them concatenated would be lying about what runs.

import { T, collapsible, div, iconButton, tabs } from './theme.js';

const OPEN_KEY = 'xyz.plv3.preview.open';
const H_KEY = 'xyz.plv3.preview.h';

function segLabel(seg) {
  if (seg.kind === 'base') return 'base';
  if (seg.kind === 'fill') return 'fill';
  // `imask: i` is the index the user wrote — never the segment's position.
  if (seg.kind === 'imask') return `imask ${seg.imask ?? 0}`;
  if (seg.mask) {
    const [x1, x2, y1, y2] = seg.mask;
    return `mask ${x1}–${x2} · ${y1}–${y2}`;
  }
  return 'mask';
}

export class PreviewPanel {
  constructor() {
    this.result = null;
    this.active = 0;

    const open = localStorage.getItem(OPEN_KEY) === '1';
    this.panel = collapsible({
      title: 'Preview',
      open,
      onToggle: (v) => {
        localStorage.setItem(OPEN_KEY, v ? '1' : '0');
        this.render();
      },
    });

    this.count = div(`font-size:${T.fs.micro};color:${T.muted};font-family:${T.mono};`);
    const copy = iconButton('⧉', 'Copy the active segment', () => {
      const seg = this.result?.segments?.[this.active];
      const text = seg ? seg.text : this.result?.text || '';
      navigator.clipboard?.writeText(text);
    });
    this.panel.tail.append(this.count, copy);

    const h = Number(localStorage.getItem(H_KEY)) || 170;
    this.panel.body.style.height = `${h}px`;
    this.panel.body.style.flexShrink = '0';

    this.tabsHost = div('flex-shrink:0;');
    this.out = div(`flex:1;min-height:0;overflow:auto;padding:8px 10px;white-space:pre-wrap;
      word-break:break-word;font-family:${T.mono};font-size:12px;line-height:1.6;
      color:${T.text};background:${T.bg0};`);
    this.panel.body.append(this.tabsHost, this.out);

    this.el = this.panel.wrap;
  }

  /** The window mounts a splitter above the panel; it needs the body to size. */
  get resizeTarget() {
    return this.panel.body;
  }

  get heightKey() {
    return H_KEY;
  }

  setResult(result) {
    // A document that does not parse is what a document looks like halfway through
    // being typed — and sometimes for much longer than that. The server compiles in
    // recovering mode, so an error usually still comes back WITH output: the broken
    // construct is skipped and the rest is compiled. Show that output and put the error
    // above it. Replacing the panel with an error message tells the user what they
    // already know (there is a squiggle in the editor) and hides what they came for.
    const error = result
      ? (result.diagnostics || []).find((d) => d.severity === 'error') || null
      : null;
    const usable = !!result && (!!result.text || (result.segments || []).length > 0);

    if (result === null) {
      this.result = null;
      this.broken = null;
    } else if (usable) {
      this.result = result;      // partial output is still output
      this.partial = error;
      this.broken = null;
    } else {
      // Nothing compiled at all — only now is the last good output the best we have.
      this.partial = null;
      this.broken = error;
    }

    if (this.active >= (this.result?.segments?.length || 1)) this.active = 0;
    this.render();
  }

  render() {
    const segs = this.result?.segments || [];
    this.count.textContent = segs.length > 1 ? `${segs.length} segments` : '';
    if (!this.panel.isOpen()) return;

    this.tagsHost = null;
    this.tabsHost.replaceChildren();
    this.out.replaceChildren();

    // No error banner here: the editor's own squiggle already marks the broken line,
    // and a banner that appears and disappears on every keystroke shoved the whole
    // panel up and down. The preview just shows whatever compiled (partial or last-good).

    if (!this.result) {
      this.out.textContent = '';
      return;
    }
    this.out.style.color = T.text;

    if (segs.length > 1) {
      this.tabsHost.append(
        tabs(
          segs.map((s, i) => ({ id: i, label: segLabel(s) })),
          this.active,
          (id) => { this.active = id; this.render(); },
        ),
      );
      this.out.textContent = segs[this.active]?.text || '';
      return;
    }

    // A single segment is the whole output; no tab strip to look at.
    this.out.textContent = this.result.text || '';
  }
}
