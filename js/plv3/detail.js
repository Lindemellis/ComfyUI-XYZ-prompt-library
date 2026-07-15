// PLv3 — the detail page (spec §8.3): the document as a tree of controls.
//
// Every control edits by rewriting *exactly the source range it owns* (the span the
// backend parser handed us), so the user's blank lines and indentation survive an
// edit. That is why PLv2's reconciliation machinery — normalise, dedupe, sep_after,
// content-keyed matching — has no counterpart here: the text is the only store, and
// a span is an unambiguous handle into it.
//
// The one hazard a span brings is staleness. Each AST snapshot is stamped with the
// Monaco version it was parsed from; an edit computed against older text is dropped
// rather than applied to characters that have since moved.

import {
  T, button, div, dualSlider, el, field, fmt, iconButton, input, numberInput,
  sectionLabel, slider, splitter, toggle, treeRow,
} from './theme.js';
import { loraRange, settings, weightRange } from './settings.js';
import { showConfirm, showContextMenu, showPrompt, toast } from './ui.js';

// Which group cards the user has folded shut, remembered across reloads.
//
// Only the LIBRARY blocks are persisted: a `lib:<header>` key names the same group
// wherever it turns up, so restoring it is always right. A `doc:<path>` key is just a
// position in one document's tree, and a group typed in above it would inherit the
// state — so those live for the session and no longer.
const COLLAPSE_KEY = 'xyz.plv3.collapsed';

function loadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function saveCollapsed(set) {
  try {
    const stable = [...set].filter((k) => k.startsWith('lib:'));
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(stable));
  } catch { /* private mode */ }
}

const SETTING_KEYS = [
  'weight', 'format', 'shuffle', 'random_select', 'dropout', 'seed', 'schedule', 'region',
];

const SETTING_HELP = {
  weight: 'wrap the group in (…:w)',
  format: 'rewrite each item; $p is the item',
  shuffle: 'shuffle the items every run',
  random_select: 'keep n (or a–b) items at random',
  dropout: 'drop each item with probability p',
  seed: 'lock this group’s random source',
  schedule: 'only live in a time window',
  region: 'make this group its own region segment',
};

// The same glyphs and colours the group headers use — a schedule is ◷ wherever you meet
// it. The three that change WHAT the group is (time, place, randomness) are coloured;
// the ones that only tune it stay muted, so the menu has a shape instead of being eight
// identical grey lines.
const SETTING_ICON = {
  weight: ['◐', T.accent],
  format: ['❯', T.muted],
  shuffle: ['⇄', T.rand],
  random_select: ['⚄', T.rand],
  dropout: ['⚀', T.rand],
  seed: ['⚿', T.muted],
  schedule: ['◷', T.time],
  region: ['◧', T.region],
};

// Adding a setting writes a value that already does something, so the control has a
// meaningful starting point.
const SETTING_DEFAULT = {
  weight: '1.1', format: '"$p"', shuffle: 'true',
  random_select: '1', dropout: '0.1', seed: '0',
};

/** The settings this group declares — read from the spans, i.e. from what is
 *  literally written, never from the parsed values (a bad value degrades to the
 *  default (W08), and a value-based test would call the field absent and offer it
 *  in the "+" menu again). */
function presentSettings(group) {
  const spans = group.spans || {};
  const fields = spans.fields || {};
  const out = [];
  for (const key of SETTING_KEYS) {
    if (key === 'region') { if (spans.region_decl) out.push(key); }
    else if (key === 'schedule') { if (fields.schedule || spans.schedule_form) out.push(key); }
    else if (fields[key]) out.push(key);
  }
  return out;
}

/** A LoRA carries its weight inside the brackets: `<lora:name:0.6>` (an optional
 *  second number is the CLIP weight). The attention syntax `(…:w)` does not reach
 *  in there at all, so that is the number the slider must show and set. */
const LORA_RE = /^<([^:>]+):([^:>]+):([-\d.]+)(?::([-\d.]+))?>$/;

function loraWeight(src, node) {
  const m = src.slice(node.span[0], node.span[1]).match(LORA_RE);
  return m ? Number(m[3]) : 1;
}

/** A paren group that is really one prompt carrying a weight — `(tag:1.2)`. */
function weightedItem(node) {
  if (node.kind !== 'group' || !node.paren || node.header) return false;
  if (node.children.length !== 1 || node.children[0].kind === 'group') return false;
  const s = node.settings;
  return !s.region && !s.schedule && !s.format && !s.shuffle && !s.random_select
    && !s.dropout && s.seed == null;
}

/** What to call a group in the tree.
 *
 *  Never `{}`, and never its schedule range: a range is a *setting*, not a name, and
 *  showing it as one is what made `[0, 0.2]` read like an identifier in the first
 *  place. An anonymous group is named by what is in it. */
function groupLabel(group, src) {
  if (group.header) return group.header;
  const r = group.settings.region;
  if (r) {
    if (r.kind === 'imask') return `region · imask ${r.imask ?? 0}`;
    if (r.kind === 'mask') return 'region · mask';
    return `region · ${r.kind}`;
  }
  const preview = group.children
    .filter((c) => c.kind !== 'group')
    .map((c) => src.slice(c.span[0], c.span[1]).trim())
    .filter(Boolean);
  if (preview.length) {
    const head = preview.slice(0, 2).join(', ');
    return preview.length > 2 ? `${head} …` : head;
  }

  // A `[@schedule]` / `[@region]` wrapper holds only groups. Say what it IS —
  // "3 groups" tells the reader nothing they cannot already see.
  const subs = group.children.filter((c) => c.kind === 'group');
  if (subs.length && subs.every((c) => c.settings.schedule)) {
    return `schedule · ${subs.length} steps`;
  }
  if (subs.length && subs.every((c) => c.settings.region)) {
    return `regions · ${subs.length}`;
  }
  return subs.length ? `${subs.length} groups` : 'empty group';
}

function groupIcon(group) {
  if (group.header) return { icon: '▤', color: T.lib };
  if (group.settings.region) return { icon: '◧', color: T.region };
  if (group.settings.schedule) return { icon: '◷', color: T.time };
  return { icon: '❯', color: T.muted };
}

// --- controls ---------------------------------------------------------------

function textbox(value, onCommit) {
  const i = input(value);
  i.onchange = () => onCommit(i.value);
  return i;
}

/** A label and a control side by side, sized to their content — for a row of small
 *  things (feather, weight, a switch) that each wasted a whole line of their own. */
function chip(label, control) {
  const c = div(`display:flex;align-items:center;gap:6px;min-width:0;`);
  c.append(div(`font-size:${T.fs.micro};color:${T.label};flex-shrink:0;`, label));
  control.style.flex = '0 0 auto';
  c.append(control);
  return c;
}

// --- the pane ---------------------------------------------------------------

export class DetailPane {
  /** `outline: false` drops the left-hand jump list. It earns its width in a document,
   *  which is long and full of groups; a library preset is ONE block, and an outline of
   *  one entry is a column of empty space next to the thing it points at. */
  constructor(container, {
    pane, outline = true, presetBar = true, links = null, emptyText = 'Open a node.',
  }) {
    this.container = container;
    this.pane = pane; // the PromptEditor — owns the model and the undo stack
    this.outline = outline;
    // `presetBar: false` — the caller IS a preset (the library window). Its root block
    // does not get a "load a preset / save as preset" bar; nested blocks still do.
    this.presetBar = presetBar;
    // `links` — { get(path), set(path, presetId), clear(path) } — supplied by the library
    // window only. A link lives in a PRESET's body; a document has nowhere to put it.
    this.links = links;
    this.emptyText = emptyText;
    this.ast = null;
    this.version = 0;
    this.polarity = 'positive';
    this.compiled = null;
    this.library = new Map();   // path -> group (undefined = loading, null = absent)
    // path -> preset id the user last LOADED into that block. Only consulted once the
    // block no longer matches any preset's text (see presetState): the text wins.
    this.loaded = new Map();
    // Keyed on the group's stable tree path, never on its span: an edit shifts every
    // span after it, and the panel would slam shut on every change.
    this.expanded = new Set();
    // Which group cards are folded shut. Survives a reload — see collapseKey for what
    // a group is keyed on and why only some of them are worth remembering.
    this.collapsed = loadCollapsed();
    this.built = false;
  }

  /** What identifies a group across renders — and across sessions.
   *
   *  A LIBRARY BLOCK has a real identity: its header (`quality.anima`) is the same group
   *  in every document that references it, so folding it shut is worth remembering.
   *
   *  A plain `{...}` group has nothing but its position in the tree, and that shifts the
   *  moment you type a group above it. Its state is keyed on the path anyway — good
   *  enough within one editing session — but it is NOT persisted: restoring it after a
   *  reload would fold whatever group had drifted into that slot. */
  collapseKey(group) {
    return group.header ? `lib:${group.header}` : `doc:${group.path.join('.')}`;
  }

  toggleCollapsed(group) {
    const key = this.collapseKey(group);
    if (this.collapsed.has(key)) this.collapsed.delete(key);
    else this.collapsed.add(key);
    saveCollapsed(this.collapsed);
    this.render();
  }

  setCompiled(result) { this.compiled = result; }

  setAst(payload, node, { version }) {
    // No negative node any more: regions are always offered (a region simply must not be
    // wired to a negative conditioning — documented, not enforced).
    this.polarity = 'positive';
    this.diagnostics = payload?.diagnostics || [];
    const error = this.diagnostics.find((d) => d.severity === 'error') || null;

    // The server parses in RECOVERING mode for the editor: a broken construct is
    // reported and skipped, and the rest of the document still comes back as a tree.
    // So an error does not mean "nothing to show" — it means "show what parsed, and
    // say what didn't". These spans were measured against THIS text, so the controls
    // stay live: you can keep editing the parts that are fine while one line is broken.
    if (payload?.ast) {
      this.ast = payload.ast;
      this.version = version;
      this.partial = error;   // a banner, not a wall
      this.broken = null;
      this.render();
      return;
    }

    // No tree at all (a hard error, or the request failed). Only now fall back to the
    // last good tree — and freeze it, because its spans belong to older text.
    this.partial = null;
    this.broken = error;
    this.render();
  }

  clear() {
    this.ast = null;
    this.buildShell();
    this.body.replaceChildren(div(
      `color:${T.muted};font-size:${T.fs.label};padding:12px;`, this.emptyText));
    this.nav?.replaceChildren();
  }

  buildShell() {
    if (this.built) return;
    this.built = true;
    this.body = div('flex:1;min-width:0;overflow-y:auto;overflow-x:hidden;padding:10px 12px;');
    const split = div('display:flex;flex:1;min-width:0;min-height:0;overflow:hidden;');

    if (this.outline) {
      this.nav = div(`width:190px;flex-shrink:0;overflow-y:auto;background:${T.bg2};
        padding:6px 4px;min-width:0;`);
      split.append(
        this.nav,
        splitter(this.nav, { dir: 'x', key: 'xyz.plv3.detailnav.w', min: 110, max: 280 }),
      );
    }
    split.append(this.body);
    this.container.replaceChildren(split);
  }

  // --- editing primitives ---
  edit(edits) {
    if (this.broken) {
      // The spans in hand describe the last text that parsed, not the one on screen.
      console.warn('[PLv3] detail edit refused: the document does not parse');
      return;
    }
    if (!this.pane.applyEdits(edits, this.version)) {
      console.warn('[PLv3] detail edit dropped: the text changed under it');
      this.pane.scheduleLint();
      return;
    }
    // The snapshot is now one edit behind the model and the fresh AST is a round trip
    // away; rebase the spans we hold so two quick commits do not lose the second.
    for (const e of [...edits].sort((x, y) => y.span[0] - x.span[0])) {
      rebase(this.ast, e.span, e.text.length);
    }
    this.version = this.pane.version();
    // A control click is one discrete action, not typing: refresh at once instead of
    // sitting out the typing debounce.
    this.pane.lintNow();
  }

  setField(group, name, value) {
    const s = group.spans;
    const f = s.fields[name];
    if (f) return this.edit([{ span: f.value, text: value }]);
    if (s.set_body) {
      const empty = s.set_body[0] === s.set_body[1];
      const at = s.set_body[0];
      return this.edit([{ span: [at, at], text: empty ? `${name}: ${value}` : `${name}: ${value}, ` }]);
    }
    const end = s.node[1];
    this.edit([{ span: [end, end], text: `.set{${name}: ${value}}` }]);
  }

  clearField(group, name) {
    const s = group.spans;
    const f = s.fields[name];
    if (!f) return;
    if (Object.keys(s.fields).length === 1 && s.set_block) {
      return this.edit([{ span: s.set_block, text: '' }]);
    }
    // `entry` covers `name: value` plus a *trailing* comma. The last field has none,
    // so deleting it would leave the previous field's comma dangling: `.set{a: 1, }`.
    let [start, end] = f.entry;
    const src = this.pane.text();
    if (!src.slice(start, end).trimEnd().endsWith(',')) {
      while (start > 0 && /[\s,]/.test(src[start - 1])) start--;
    }
    this.edit([{ span: [start, end], text: '' }]);
  }

  setRegionField(group, name, value) {
    const s = group.spans;
    const f = s.region_fields[name];
    if (f) return this.edit([{ span: f.value, text: value }]);
    if (s.region_body) {
      const empty = s.region_body[0] === s.region_body[1];
      const at = s.region_body[0];
      return this.edit([{ span: [at, at], text: empty ? `${name}: ${value}` : `${name}: ${value}, ` }]);
    }
    // `region: base` is a bare word with nowhere to put a field — promote it to a block
    // that can hold one, keeping the kind it already had. `kind` is written only when it
    // cannot be inferred: an explicit `kind: base` next to a `mask:` would OVERRIDE the
    // inference and pin the region to base, which is exactly the bug that made the kind
    // dropdown impossible to change.
    const kind = group.settings.region?.kind || 'base';
    const head = kind === 'base' ? '' : `kind: ${kind}, `;
    if (s.region_decl) {
      const open = s.region_form === 'block' ? '[' : '{';
      const close = s.region_form === 'block' ? ']' : '}';
      return this.edit([
        { span: s.region_decl, text: `${open}${head}${name}: ${value}${close}` },
      ]);
    }
    this.setField(group, 'region', `{${head}${name}: ${value}}`);
  }

  /** Change WHAT KIND of region this is.
   *
   *  Not a field edit — a rewrite of the whole declaration. `base`/`fill` are bare words
   *  with nowhere to hang a mask, `mask` and `imask` are exclusive of each other, and the
   *  kind of the last two is INFERRED from which of them is present. Adding `mask: […]`
   *  next to the old `kind: base` therefore changed nothing at all: the dropdown snapped
   *  straight back, because the text still said base.
   *
   *  The fields that still mean something (feather, region weight, in-base) are carried
   *  across; the ones that do not (a rectangle, on an `imask`) are dropped. */
  setRegionKind(group, kind) {
    this.expanded.add(group.path.join('.'));
    const r = group.settings.region || {};
    const s = group.spans;

    const parts = [];
    if (kind === 'mask') {
      const m = r.mask || [0, 0.5, 0, 1];
      parts.push(`mask: [${m.map(fmt).join(', ')}]`);
    }
    if (kind === 'imask') parts.push(`imask: ${Math.trunc(r.imask ?? 0)}`);
    if (kind !== 'base' && r.feather) parts.push(`feather: ${Math.trunc(r.feather)}`);
    if (kind !== 'base' && r.region_weight != null && r.region_weight !== 1) {
      parts.push(`region_weight: ${fmt(r.region_weight)}`);
    }
    if ((kind === 'mask' || kind === 'imask') && r.include_in_base) {
      parts.push('include_in_base: true');
    }

    // `fill` with extra fields still needs to say so — there is nothing to infer it from.
    if (kind === 'fill' && parts.length) parts.unshift('kind: fill');

    const block = s.region_form === 'block';
    const open = block ? '[' : '{';
    const close = block ? ']' : '}';
    const text = parts.length ? `${open}${parts.join(', ')}${close}` : kind;

    if (s.region_decl) return this.edit([{ span: s.region_decl, text }]);
    this.setField(group, 'region', text);
  }

  /** Re-weight one prompt. Already wrapped: rewrite the number in place (or unwrap
   *  at 1). Not wrapped: wrap it. Either way the nesting never grows. */
  itemWeight(node, weight) {
    const src = this.pane.text();

    // A LoRA's weight is INSIDE the angle brackets. `(<lora:x:1>:1.2)` is not a
    // weighted LoRA — it is a LoRA with a meaningless paren around it, because the
    // attention syntax does not reach into `<…>` at all.
    if (node.kind === 'lora') {
      const m = src.slice(node.span[0], node.span[1]).match(LORA_RE);
      if (!m) return;
      const clip = m[4] !== undefined ? `:${m[4]}` : '';
      return this.edit([
        { span: node.span, text: `<${m[1]}:${m[2]}:${fmt(weight)}${clip}>` },
      ]);
    }

    if (weightedItem(node)) {
      const inner = src.slice(node.children[0].span[0], node.children[0].span[1]);
      if (weight === 1) return this.edit([{ span: node.span, text: inner }]);
      const f = node.spans.fields.weight;
      if (f) return this.edit([{ span: f.value, text: fmt(weight) }]);
      return this.edit([{ span: node.span, text: `(${inner}:${fmt(weight)})` }]);
    }
    if (weight === 1) return;
    const raw = src.slice(node.span[0], node.span[1]);
    this.edit([{ span: node.span, text: `(${raw}:${fmt(weight)})` }]);
  }

  // A control sets a value; the ✕ removes the setting. Dragging to the default must
  // not delete the row out from under the cursor.
  groupWeight(group, weight) { this.setField(group, 'weight', fmt(weight)); }

  /** A `[@schedule]` entry's range.
   *
   *  The number between two entries is ONE boundary written twice: `0 - 0.3` then
   *  `0.3 - 1`. Spec §3.4 makes that explicit — each entry's start wins, and the
   *  previous entry's end is rewritten to it, so gaps and overlaps cannot survive.
   *
   *  Which means an entry's END is not its own. Rewriting only this entry's head put
   *  `0 - 0.5` in the text while the parser kept reading the end as the next entry's
   *  start (0.3) — the text changed and the slider snapped back to where it was. Both
   *  sides of the boundary have to move together, and then nothing can disagree. */
  scheduleEdit(group, [a, b]) {
    const s = group.spans;
    if (s.schedule_form !== 'block') {
      this.setField(group, 'schedule', `{${fmt(a)}, ${fmt(b)}}`);
      return;
    }

    const edits = [{ span: s.fields.schedule.value, text: `${fmt(a)} - ${fmt(b)}` }];
    const [prev, next] = this.scheduleNeighbours(group);
    // `a` is the boundary with the previous entry; `b` the boundary with the next one.
    if (prev?.settings.schedule) {
      edits.push({
        span: prev.spans.fields.schedule.value,
        text: `${fmt(prev.settings.schedule[0])} - ${fmt(a)}`,
      });
    }
    if (next?.settings.schedule) {
      edits.push({
        span: next.spans.fields.schedule.value,
        text: `${fmt(b)} - ${fmt(next.settings.schedule[1])}`,
      });
    }
    this.edit(edits);
  }

  /** The entries either side of this one inside its `[@schedule]` block. */
  scheduleNeighbours(group) {
    const parent = this.parentOf(group);
    const entries = (parent?.children || []).filter(
      (c) => c.kind === 'group' && c.spans?.schedule_form === 'block');
    const i = entries.indexOf(group);
    if (i === -1) return [null, null];
    return [entries[i - 1] || null, entries[i + 1] || null];
  }

  parentOf(node, from = this.ast) {
    for (const child of from?.children || []) {
      if (child === node) return from;
      const found = this.parentOf(node, child);
      if (found) return found;
    }
    return null;
  }

  // --- rendering ---
  render() {
    this.buildShell();
    const scroll = this.body.scrollTop;
    this.body.replaceChildren();
    this.nav?.replaceChildren();

    // No error banner: the editor already squiggles the broken line, and a banner that
    // blinks in and out on every keystroke shoved the whole page down. When the parse is
    // fully broken the tree below is greyed and inert (see `this.broken` further down),
    // which says "this is stale" without moving anything.

    if (!this.ast) {
      this.body.append(div(
        `color:${T.muted};font-size:${T.fs.label};padding:6px;`,
        'Nothing to show yet.',
      ));
      return;
    }

    // Render the LAST GOOD tree against the text it was parsed from, not the broken
    // text on screen — slicing spans out of text they do not describe would show
    // gibberish in every box.
    const src = this.broken ? (this.lastGoodText ?? this.pane.text()) : this.pane.text();
    if (!this.broken) this.lastGoodText = src;

    const tree = div(`min-width:0;${this.broken ? 'opacity:.45;pointer-events:none;' : ''}`);
    if (this.nav) this.renderNav(src);
    for (const child of this.ast.children) this.renderNode(child, tree, 0, src, true);
    if (!this.ast.children.length) {
      tree.append(div(`color:${T.muted};font-size:${T.fs.label};padding:6px;`,
        'Empty — type something in the editor.'));
    }
    this.body.append(tree);
    this.body.scrollTop = scroll;
  }

  renderNav(src) {
    this.nav.append(sectionLabel('outline'));
    const walk = (node, depth, ancestors = []) => {
      for (const child of node.children || []) {
        if (child.kind !== 'group' || weightedItem(child)) continue;
        const { icon, color } = groupIcon(child);
        const full = groupLabel(child, src);
        const row = treeRow({ depth, icon, iconColor: color, label: full });
        row.style.height = '24px';
        row.title = full;
        // A path is identified by its TAIL (`…characters.illya`), so it must be
        // clipped from the left — a head-clipped `demo.qualit…` identifies nothing.
        const text = row.children[row.children.length - 1];
        if (child.header) {
          text.style.direction = 'rtl';
          text.style.textAlign = 'left';
        }
        row.onclick = () => {
          // A card nested inside a folded ancestor is not in the DOM at all, so the jump
          // would land nowhere. Unfold the way in first.
          const shut = ancestors.filter((a) => this.collapsed.has(this.collapseKey(a)));
          if (shut.length) {
            for (const a of shut) this.collapsed.delete(this.collapseKey(a));
            saveCollapsed(this.collapsed);
            this.render();
          }
          this.body
            .querySelector(`[data-path="${child.path.join('.')}"]`)
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        };
        this.nav.append(row);
        walk(child, depth + 1, [...ancestors, child]);
      }
    };
    walk(this.ast, 0);
  }

  /** `depth` is how far to INDENT this row — nothing more. It restarts at 0 inside
   *  every group card (the card is the nesting), so it says nothing about where the node
   *  sits in the tree. `root` is the fact that actually matters to a library block: is
   *  this one of the document's own top-level blocks, or is it nested inside another? */
  renderNode(node, host, depth, src, root = false) {
    // A `[@schedule]` entry is a time range and a thing that lives in it — not a group.
    // `0.65 - 1: open eyes` has no braces at all; the Group around it is the parser's,
    // built because a Group is where a schedule setting can hang. Drawing it as a group
    // card gave it a name ("open eyes") it does not have and a gear that writes
    // `open eyes.set{…}` — which does not parse.
    if (node.kind === 'group' && node.spans?.schedule_form === 'block') {
      return this.renderScheduleEntry(node, host, depth, src);
    }
    if (node.kind === 'group' && !weightedItem(node)) {
      return this.renderGroup(node, host, depth, src, root);
    }
    return this.renderItem(node, host, depth, src);
  }

  /** One entry of a `[@schedule]`: the range, then what is in it.
   *
   *  What is in it may well BE a group — `0.3 - 1: { open eyes, smile }.set{shuffle}` —
   *  and then it gets a real group card, gear and all. It is the implicit wrapper around
   *  a bare item that must not become one. */
  renderScheduleEntry(entry, host, depth, src) {
    const wrap = div(`margin:6px 0;margin-left:${depth * 14}px;border:1px solid ${T.line};
      border-radius:${T.radius};background:${T.bg2};overflow:hidden;`);
    wrap.dataset.path = entry.path.join('.');

    const bar = div(`display:flex;align-items:center;gap:8px;padding:5px 10px;
      background:${T.bg2};border-bottom:1px solid ${T.line};`);
    bar.append(div(`font-size:${T.fs.micro};color:${T.time};flex-shrink:0;`, '◷'));
    const sl = dualSlider(entry.settings.schedule || [0, 1],
      (iv) => this.scheduleEdit(entry, iv), { color: T.time, step: settings().scheduleStep });
    sl.style.flex = '1';
    bar.append(sl);
    wrap.append(bar);

    const body = div('padding:6px 8px;min-width:0;');
    if (entry.implicit) {
      // The braces are not in the text: render what IS there — the item(s).
      for (const child of entry.children) this.renderItem(child, body, 0, src);
      if (!entry.children.length) {
        body.append(div(`color:${T.muted};font-size:${T.fs.label};`, 'empty'));
      }
    } else {
      // The user wrote a group here, so it is a group: card, settings, the lot. Its own
      // schedule bar is suppressed — the range is right above it.
      this.renderGroup(entry, body, 0, src, false, { scheduleBar: false });
    }
    wrap.append(body);
    host.append(wrap);
  }

  /** One prompt row: the source text, and the weight it is wrapped in. */
  renderItem(node, host, depth, src) {
    const paren = weightedItem(node);
    const body = paren ? node.children[0] : node;
    const weight = node.kind === 'lora'
      ? loraWeight(src, node)
      : (paren ? node.settings.weight ?? 1 : 1);

    // The *source*, not the AST's compiled value: the value is escaped for
    // prompt-control (`artist\:wlop`), which is neither what the user wrote nor what
    // we want to write back. Editing source text round-trips exactly.
    const text = src.slice(body.span[0], body.span[1]);

    const row = div(`display:flex;gap:8px;align-items:center;min-width:0;padding:2px 0 2px ${depth * 14}px;`);
    const box = textbox(text, (v) => this.edit([{ span: body.span, text: v.trim() }]));
    if (body.kind === 'lora') { box.style.color = '#94e2d5'; box.style.fontFamily = T.mono; }

    const w = div('width:132px;flex-shrink:0;');
    // A LoRA's weight is not a prompt weight: it lives inside `<…>` and may go negative
    // (subtracting a style), so it gets its own range.
    const range = node.kind === 'lora' ? loraRange() : weightRange();
    w.append(slider(weight, range, { onCommit: (v) => this.itemWeight(node, v) }));

    row.append(box, w);
    host.append(row);
  }

  renderGroup(group, host, depth, src, root = false, { scheduleBar = true } = {}) {
    const key = group.path.join('.');
    const open = this.expanded.has(key);
    const active = presentSettings(group);
    const { icon, color } = groupIcon(group);

    const card = div(`margin:6px 0;margin-left:${depth * 14}px;border:1px solid ${T.line};
      border-radius:${T.radius};background:${T.bg2};overflow:hidden;`);
    card.dataset.path = key;

    const folded = this.collapsed.has(this.collapseKey(group));

    const head = div(`display:flex;align-items:center;gap:8px;padding:6px 8px;
      background:${T.bg2};min-width:0;` + (folded ? '' : `border-bottom:1px solid ${T.line};`));
    head.append(iconButton(folded ? '▸' : '▾', folded ? 'Expand' : 'Collapse',
      () => this.toggleCollapsed(group)));
    head.append(div(`color:${color};flex-shrink:0;`, icon));
    const title = div(`flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
      font-size:${T.fs.body};font-weight:600;color:${group.header ? T.lib : T.text};
      cursor:pointer;user-select:none;`, groupLabel(group, src));
    // The whole title bar folds it — a 20px chevron is a small target for something you
    // do constantly.
    title.onclick = () => this.toggleCollapsed(group);
    head.append(title);

    // Folded, the header has to say what is inside, or you are picking blind.
    if (folded) {
      const n = group.children.length;
      head.append(div(`font-size:${T.fs.micro};color:${T.muted};flex-shrink:0;`,
        n === 1 ? '1 item' : `${n} items`));
    }

    if (active.length) {
      head.append(div(`font-size:${T.fs.micro};color:${T.muted};font-family:${T.mono};
        flex-shrink:0;`, active.join(' · ')));
    }
    const gear = iconButton('⚙', open ? 'Hide settings' : 'Settings', () => {
      if (open) this.expanded.delete(key); else this.expanded.add(key);
      // A collapsed card cannot show its settings panel — opening one implies opening
      // the card.
      this.collapsed.delete(this.collapseKey(group));
      saveCollapsed(this.collapsed);
      this.render();
    });
    if (open) gear.style.color = T.accent;
    head.append(gear);
    card.append(head);

    if (folded) {
      host.append(card);
      return;
    }

    // A `[@schedule]` entry's range is its defining property — it gets a slider right
    // in the header, not buried behind the gear. It is a setting, never a name.
    if (scheduleBar && group.spans.schedule_form === 'block' && group.settings.schedule) {
      const bar = div(`display:flex;align-items:center;gap:8px;padding:4px 10px;
        background:${T.bg1};border-bottom:1px solid ${T.line};`);
      bar.append(div(`font-size:${T.fs.micro};color:${T.time};flex-shrink:0;`, '◷'));
      const sl = dualSlider(group.settings.schedule, (iv) => this.scheduleEdit(group, iv),
        { color: T.time, step: settings().scheduleStep });
      sl.style.flex = '1';
      bar.append(sl);
      card.append(bar);
    }

    if (open) {
      const panel = div(`padding:8px 10px;background:${T.bg1};border-bottom:1px solid ${T.line};`);
      this.renderSettings(group, panel, active);
      card.append(panel);
    }

    if (group.header) this.renderLibraryPanel(group, card, src, root);

    const kids = div('padding:6px 8px;min-width:0;');
    if (group.header && this.library.get(group.header)) {
      // A library block gets ONE list with a switch on every row: the group's items
      // that are in the text, then the ones that are not (spec §5.6). Rendering the
      // enabled ones as plain rows and the disabled ones as a separate strip below
      // gave the enabled ones no way to be turned off at all.
      this.renderLibraryItems(group, kids, src);
    } else {
      for (const child of group.children) this.renderNode(child, kids, 0, src);
      if (!group.children.length) {
        kids.append(div(`color:${T.muted};font-size:${T.fs.label};`, 'empty'));
      }
    }
    card.append(kids);
    host.append(card);
  }

  /** The unified enable/disable list of a library block (spec §5.2, §5.6).
   *
   *  "Enabled" is not a stored flag — an item is enabled iff it appears in the text.
   *  So the switch does not toggle a flag: turning it off DELETES the item from the
   *  document, turning it on WRITES it back. The text stays the only truth. */
  renderLibraryItems(group, host, src) {
    const info = this.library.get(group.header);

    const enabledTexts = new Set();
    const enabledRefs = new Set();

    // In text order — the block's own children.
    for (const child of group.children) {
      if (child.kind === 'group' && child.header) {
        // A nested library block IS an item of this group (a ref).  It gets a switch
        // like any other item; turning it off deletes the whole block.
        enabledRefs.add(child.header);
        const wrap = div('display:flex;gap:8px;align-items:flex-start;min-width:0;');
        const sw = toggle(true, () =>
          this.edit([{ span: this.removalSpan(child.span, src), text: '' }]));
        sw.style.transform = 'scale(.8)';
        sw.style.marginTop = '10px';
        wrap.append(sw);
        const box = div('flex:1;min-width:0;');
        this.renderNode(child, box, 0, src);
        wrap.append(box);
        host.append(wrap);
        continue;
      }
      if (child.kind === 'group' && !weightedItem(child)) {
        this.renderNode(child, host, 0, src); // a plain inline group, not a library item
        continue;
      }
      const body = weightedItem(child) ? child.children[0] : child;
      const text = src.slice(body.span[0], body.span[1]).trim();
      enabledTexts.add(text);
      host.append(this.libraryItemRow(group, { node: child, body, text }, src, true));
    }

    // Spec §5.6: disabled after enabled, sorted by kind then alphabetically —
    // prompts first, groups (refs) last.
    const off = info.items
      .filter((i) => (i.kind === 'ref'
        ? !enabledRefs.has(i.ref_path)
        : !enabledTexts.has(i.text)))
      .sort((a, b) => {
        const rank = (x) => (x.kind === 'ref' ? 1 : 0);
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        return (a.text || a.ref_path || '').localeCompare(b.text || b.ref_path || '');
      });

    for (const item of off) {
      host.append(this.libraryItemRow(group, { item, text: item.text }, src, false));
    }

    if (!group.children.length && !off.length) {
      host.append(div(`color:${T.muted};font-size:${T.fs.label};`, 'empty'));
    }
  }

  /** What to delete when an item is disabled.
   *
   *  The item plus its trailing comma — or `a, , b` — and, when the item had a line
   *  to itself, that line as well: leaving the bare indent behind is a blank line the
   *  user never typed. */
  removalSpan([s, e], src) {
    while (e < src.length && /[ \t,]/.test(src[e])) e++;

    const lineStart = src.lastIndexOf('\n', s - 1) + 1;
    const aloneOnLine =
      /^[ \t]*$/.test(src.slice(lineStart, s)) && (e >= src.length || src[e] === '\n');
    if (!aloneOnLine) return [s, e];

    if (lineStart > 0) return [lineStart - 1, e];   // swallow the newline in front
    return [lineStart, Math.min(e + 1, src.length)]; // first line: take the one after
  }

  /** Where a re-enabled item goes back into a block, and how it is laid out.
   *
   *  Two rules, and they are about what is ALREADY there, not about the block:
   *    - a group always starts its own line;
   *    - a prompt joins the line of the prompt before it, but starts a new line when
   *      what came before it is a group.
   *
   *  So the document keeps reading the way the user was writing it. */
  insertionPoint(group, src, text, { isGroup = false } = {}) {
    const [c0, c1] = group.spans.content;
    let at = c1;
    while (at > c0 && /\s/.test(src[at - 1])) at--;   // back over the run before `}`

    const kids = group.children;
    const last = kids.length ? kids[kids.length - 1] : null;
    const lastIsGroup = !!last && last.kind === 'group' && !weightedItem(last);
    const multiline = src.slice(c0, c1).includes('\n');

    if (!last) {
      // Empty block: match its own shape.
      const indent = this.childIndent(group, src);
      return [at, multiline ? `\n${indent}${text},\n` : ` ${text},`];
    }

    if (!isGroup && !lastIsGroup) {
      // prompt after prompt — same line
      return [at, ` ${text},`];
    }

    // a group, or a prompt after a group — its own line, at the indent of the line
    // the last item lives on
    const lineStart = src.lastIndexOf('\n', at - 1) + 1;
    let indent = (src.slice(lineStart, at).match(/^[ \t]*/) || [''])[0];
    if (!multiline) indent = this.childIndent(group, src);
    return [at, `\n${indent}${text},`];
  }

  /** The indent one level inside the block, from the block's own line. */
  childIndent(group, src) {
    const start = group.span[0];
    const lineStart = src.lastIndexOf('\n', start - 1) + 1;
    const base = (src.slice(lineStart, start).match(/^[ \t]*/) || [''])[0];
    return `${base}    `;
  }

  libraryItemRow(group, entry, src, on) {
    const isRef = !on && entry.item?.kind === 'ref';
    const row = div(`display:flex;gap:8px;align-items:center;min-width:0;padding:2px 0;
      ${on ? '' : 'opacity:.6;'}`);

    const sw = toggle(on, async () => {
      if (on) {
        return this.edit([{ span: this.removalSpan(entry.node.span, src), text: '' }]);
      }
      if (isRef) {
        // Enabling a reference writes its whole expanded block — a document never
        // holds a bare pointer (spec §3.6, §4.7). A group always gets its own line.
        const res = await fetch('/xyz/plv3/library/expand', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ group_id: entry.item.ref_group_id }),
        });
        const { text } = await res.json();
        if (!text) return;
        const indent = this.childIndent(group, src);
        const block = text.split('\n').join(`\n${indent}`); // re-indent into the block
        const [at, laid] = this.insertionPoint(group, src, block, { isGroup: true });
        return this.edit([{ span: [at, at], text: laid.replace(/,$/, '') }]);
      }
      const [at, text] = this.insertionPoint(group, src, entry.text);
      this.edit([{ span: [at, at], text }]);
    });
    sw.style.transform = 'scale(.8)';
    row.append(sw);

    if (on) {
      const box = textbox(entry.text, (v) =>
        this.edit([{ span: entry.body.span, text: v.trim() }]));
      if (entry.body.kind === 'lora') { box.style.color = '#94e2d5'; box.style.fontFamily = T.mono; }
      row.append(box);
      const weight = entry.node.kind === 'lora'
        ? loraWeight(src, entry.node)
        : (weightedItem(entry.node) ? entry.node.settings.weight ?? 1 : 1);
      const w = div('width:132px;flex-shrink:0;');
      const range = entry.node.kind === 'lora' ? loraRange() : weightRange();
      w.append(slider(weight, range, { onCommit: (v) => this.itemWeight(entry.node, v) }));
      row.append(w);
    } else {
      const label = isRef ? `→ [${entry.item.ref_path}]` : entry.text;
      row.append(div(`flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        font-size:${T.fs.body};color:${isRef ? T.lib : T.label};padding:4px 0;`, label));
      row.append(div('width:132px;flex-shrink:0;'));
    }
    return row;
  }

  // --- settings ---
  renderSettings(group, host, active) {
    for (const key of active) {
      // A region is not one value with a control — it is a thing with settings of its
      // own (kind, extent, feather, weight, in-base). Listing those flat, next to
      // `weight` and `shuffle`, says they are the same kind of thing. They are not: they
      // belong TO the region. So it gets a panel, and they sit inside it.
      if (key === 'region') {
        host.append(this.renderRegionPanel(group));
        continue;
      }
      const control = this.settingControl(group, key);
      if (!control) continue;
      const line = div('display:flex;align-items:center;gap:6px;min-width:0;margin:2px 0;');
      control.style.flex = '1';
      control.style.minWidth = '0';
      line.append(control);

      // A schedule/region written in a `[@schedule]` / `[@region]` block head is part
      // of that block's structure; you remove it by deleting the entry, not by
      // clearing a field that is not there.
      const inBlock =
        (key === 'schedule' && group.spans.schedule_form === 'block') ||
        (key === 'region' && group.spans.region_form === 'block');

      if (inBlock) {
        line.append(div(`font-size:${T.fs.micro};color:${T.muted};padding:0 4px;`, 'in block'));
      } else {
        line.append(iconButton('✕', `Remove ${key} — back to the default`,
          () => this.removeSetting(group, key)));
      }
      host.append(line);
    }

    const addable = SETTING_KEYS.filter(
      (k) => !active.includes(k) && !(k === 'region' && this.polarity === 'negative'),
    );
    if (!addable.length) return;

    const add = button('+ setting', { variant: 'quiet', size: 'sm' });
    add.style.marginTop = '6px';
    add.onclick = (e) => {
      showContextMenu(e.clientX, e.clientY, addable.map((k) => {
        const [icon, color] = SETTING_ICON[k] || ['', T.muted];
        return {
          icon,
          iconColor: color,
          label: k,
          hint: SETTING_HELP[k],
          action: () => this.addSetting(group, k),
        };
      }));
    };
    host.append(add);
  }

  settingControl(group, key) {
    const s = group.settings;
    switch (key) {
      case 'weight':
        return field('weight', slider(s.weight ?? 1, weightRange(),
          { onCommit: (v) => this.groupWeight(group, v) }));
      case 'format':
        return field('format', textbox(s.format ?? '', (v) =>
          this.setField(group, 'format', `"${v.replace(/"/g, '\\"')}"`)));
      case 'shuffle':
        return field('shuffle', toggle(s.shuffle, (v) =>
          this.setField(group, 'shuffle', v ? 'true' : 'false')));
      case 'random_select': {
        const [lo, hi] = s.random_select || [1, 1];
        const rs = div('display:flex;gap:6px;align-items:center;min-width:0;');
        const commit = (a, b) => {
          const from = Math.max(0, a ?? b ?? 1);
          const to = Math.max(from, b ?? a ?? from);
          this.setField(group, 'random_select', from === to ? `${from}` : `${from}-${to}`);
        };
        const a = numberInput(lo, { min: 0 });
        const b = numberInput(hi, { min: 0 });
        a.onchange = () => commit(Number(a.value), hi);
        b.onchange = () => commit(lo, Number(b.value));
        rs.append(a, div(`color:${T.muted};font-size:${T.fs.label};`, '–'), b);
        return field('random select', rs);
      }
      case 'dropout':
        return field('dropout', slider(s.dropout ?? 0, { min: 0, max: 1, step: 0.05 },
          { onCommit: (v) => this.setField(group, 'dropout', fmt(v)) }));
      case 'seed': {
        const n = numberInput(s.seed ?? 0, {});
        n.onchange = () => this.setField(group, 'seed', String(Math.trunc(Number(n.value) || 0)));
        return field('seed', n);
      }
      case 'schedule':
        return field('schedule', dualSlider(s.schedule || [0, 1],
          (iv) => this.scheduleEdit(group, iv),
          { color: T.time, step: settings().scheduleStep }));
      default:
        return null;
    }
  }

  addSetting(group, key) {
    this.expanded.add(group.path.join('.'));
    if (key === 'region') return this.setField(group, 'region', 'base');
    if (key === 'schedule') return this.setField(group, 'schedule', '{0, 1}');
    this.setField(group, key, SETTING_DEFAULT[key]);
  }

  removeSetting(group, key) {
    this.expanded.add(group.path.join('.'));
    if (key === 'weight' && group.paren && group.spans.fields.weight) {
      const inner = this.pane.text().slice(group.spans.content[0], group.spans.content[1]);
      return this.edit([{ span: group.span, text: inner.trim() }]);
    }
    this.clearField(group, key);
  }

  /** The region panel — a thing with settings of its own, drawn as one.
   *
   *  Everything in here used to be a full-width row: the kind, the four mask numbers, the
   *  feather, the weight, and an `in base` switch all alone on a line of its own. Five
   *  rows to say what fits on two, in a panel that has to share a 440 px column with the
   *  whole document. */
  renderRegionPanel(group) {
    const r = group.settings.region;
    const kind = r?.kind ?? 'base';
    const inBlock = group.spans.region_form === 'block';

    const panel = div(`margin:4px 0;border:1px solid ${T.region}40;border-left:2px solid ${T.region};
      border-radius:${T.radiusSm};background:${T.region}0d;padding:6px 8px;min-width:0;`);

    // head: ◧ region   [kind ▾]   ✕
    const head = div('display:flex;align-items:center;gap:8px;min-width:0;');
    head.append(div(`color:${T.region};font-size:${T.fs.label};flex-shrink:0;`, '◧'));
    head.append(div(`font-size:${T.fs.label};font-weight:600;color:${T.region};flex-shrink:0;`,
      'region'));

    const sel = el('select', `background:${T.bg0};border:1px solid ${T.edge};
      border-radius:${T.radiusSm};color:${T.text};padding:2px 6px;font-size:${T.fs.label};
      flex:1;min-width:0;`);
    for (const k of ['base', 'fill', 'mask', 'imask']) {
      const o = el('option', '', k);
      o.value = k;
      if (kind === k) o.selected = true;
      sel.append(o);
    }
    sel.onchange = () => this.setRegionKind(group, sel.value);
    head.append(sel);

    if (inBlock) {
      head.append(div(`font-size:${T.fs.micro};color:${T.muted};flex-shrink:0;`, 'in block'));
    } else {
      head.append(iconButton('✕', 'Remove region — back to the default',
        () => this.removeSetting(group, 'region')));
    }
    panel.append(head);
    if (!r || kind === 'base') return panel;   // base has nothing else to say

    // --- extent -------------------------------------------------------------
    if (kind === 'mask') {
      const m = r.mask || [0, 1, 0, 1];
      // Spec: a mask may be given in pixels as well as in fractions. A 0–1 slider cannot
      // express 512, so a pixel mask keeps numbers — but LABELLED ones, which is what the
      // four bare boxes were missing in the first place.
      const fractional = m.every((v) => v >= 0 && v <= 1);
      if (fractional) {
        // Two intervals, not four numbers: the mask is "this much of the width, this much
        // of the height". Four anonymous boxes made you guess which was which — and the
        // guess (x1 x2 y1 y2, not x1 y1 x2 y2) is not the obvious one.
        const put = (i, j, [a, b]) => {
          const next = [...m];
          next[i] = a; next[j] = b;
          this.setRegionField(group, 'mask', `[${next.map(fmt).join(', ')}]`);
        };
        panel.append(div('height:4px;'));
        panel.append(field('width', dualSlider([m[0], m[1]], (iv) => put(0, 1, iv),
          { color: T.region, step: 0.05 }), { width: 46 }));
        panel.append(field('height', dualSlider([m[2], m[3]], (iv) => put(2, 3, iv),
          { color: T.region, step: 0.05 }), { width: 46 }));
      } else {
        const grid = div('display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-top:4px;');
        ['x1', 'x2', 'y1', 'y2'].forEach((label, i) => {
          const n = numberInput(m[i], { step: 1, placeholder: label });
          n.title = `${label} (pixels)`;
          n.onchange = () => {
            const next = [...m];
            next[i] = Number(n.value) || 0;
            this.setRegionField(group, 'mask', `[${next.map(fmt).join(', ')}]`);
          };
          grid.append(chip(label, n));
        });
        panel.append(grid);
      }
    }

    // --- the small stuff, on ONE line ---------------------------------------
    const row = div(`display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:6px;`);

    if (kind === 'imask') {
      // Decision 32: a plain number, never validated. `imask: i` is the order the mask
      // was attached to the CLIP — only the wiring knows it.
      const n = numberInput(r.imask ?? 0, { min: 0 });
      n.style.width = '58px';
      n.onchange = () => this.setRegionField(group, 'imask', String(Math.trunc(Number(n.value) || 0)));
      row.append(chip('imask', n));
    }

    const f = numberInput(r.feather ?? 0, { min: 0 });
    f.style.width = '58px';
    f.onchange = () => this.setRegionField(group, 'feather', String(Math.trunc(Number(f.value) || 0)));
    row.append(chip('feather', f));

    const w = div('width:110px;flex-shrink:0;');
    w.append(slider(r.region_weight ?? 1, weightRange(),
      { onCommit: (v) => this.setRegionField(group, 'region_weight', fmt(v)) }));
    row.append(chip('weight', w));

    if (kind === 'mask' || kind === 'imask') {
      row.append(chip('in base', toggle(r.include_in_base, (v) =>
        this.setRegionField(group, 'include_in_base', String(v)))));
    }
    panel.append(row);
    return panel;
  }

  // --- library block panel (spec §5.2, §5.6) ---
  renderLibraryPanel(group, card, src, root) {
    const info = this.library.get(group.header);
    if (info === undefined) { this.loadLibrary(group.header); return; }

    const bar = div(`display:flex;align-items:center;gap:6px;padding:5px 8px;
      background:${T.bg1};border-bottom:1px solid ${T.line};flex-wrap:wrap;`);

    if (info === null) {
      bar.append(div(`font-size:${T.fs.micro};color:${T.warn};`,
        'W09 — not in the library; the text still compiles'));
      card.append(bar);
      return;
    }

    // In the library window, the outermost block IS the preset being edited. Offering
    // to load a preset into it is a circle, and "save as preset" duplicates the list
    // sitting right next to it — the edits go back into this preset by themselves.
    // A NESTED block is a different matter: picking a preset for it is §5.4's `children`
    // and is worth having, so only the root loses the bar.
    if (this.presetBar === false && root) return;

    // A nested block inside a preset can FOLLOW a preset of the nested group instead of
    // holding a copy of it (§5.4). Only the library window offers this — a document is
    // plain text and has nowhere to keep the link (§4.7: compiling never reads the DB).
    if (this.links && !root) {
      this.renderLinkBar(group, card, bar, info);
      if (this.links.get(group.header) != null) return;   // a linked block IS its preset
    }

    const { preset: current, dirty } = this.presetState(group, src, info);

    const presets = el('select', `background:${T.bg0};border:1px solid ${T.edge};
      border-radius:${T.radiusSm};color:${T.text};font-size:${T.fs.label};padding:2px 6px;
      max-width:150px;`);
    presets.append(el('option', '', current ? `◆ ${current.name}` : 'preset…'));
    for (const p of info.presets) {
      const o = el('option', '', p.name);
      o.value = String(p.id);
      presets.append(o);
    }
    presets.onchange = async () => {
      if (!presets.value) return;
      const res = await fetch('/xyz/plv3/library/expand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group_id: info.group.id, preset_id: Number(presets.value) }),
      });
      const { text } = await res.json();
      if (!text) return;
      // Remember what was loaded. The document does not store it — the text is all there
      // is — so after an edit the only way to still know which preset this block came
      // FROM is to have watched it happen.
      this.loaded.set(group.header, Number(presets.value));
      this.edit([{ span: group.span, text }]);   // rewrites this block only
    };
    bar.append(presets);

    if (current) {
      bar.append(div(`font-size:${T.fs.micro};padding:2px 6px;border-radius:${T.radiusSm};
        color:${dirty ? T.warn : T.good};background:${dirty ? 'rgba(249,226,175,.12)' : 'rgba(166,227,161,.10)'};
        flex-shrink:0;`, dirty ? 'modified' : 'unchanged'));

      // The whole point: you loaded a preset, you changed the block, and putting the
      // change back is one click — not a menu, not retyping the preset's name.
      //
      // The name does NOT go on the button. It is already on the dropdown two elements
      // to the left, and a preset called "illya - casual - summer - v3" would push the
      // rest of the bar off the panel. The button says what it DOES; the tooltip and the
      // confirmation say what it does it to.
      if (dirty) {
        const over = button('overwrite', { variant: 'primary', size: 'sm' });
        over.title = `Overwrite the preset “${current.name}” with this block`;
        over.onclick = () => this.savePreset(group, current);
        bar.append(over);
      }
    }

    // Saving is two different intentions and they must not share one text box: typing
    // the name of a preset that already exists overwrites it (the backend upserts by
    // name), so "new preset" and "overwrite that one" have to be separate choices —
    // otherwise the only warning you get that you destroyed a preset is that it is gone.
    const save = button('save as preset', { variant: 'quiet', size: 'sm' });
    save.onclick = (e) => {
      const items = [
        { label: '+ New preset…', action: () => this.savePreset(group, null) },
      ];
      if (info.presets.length) {
        items.push({ separator: true });
        for (const p of info.presets) {
          items.push({
            label: `Overwrite “${p.name}”`,
            action: () => this.savePreset(group, p),
          });
        }
      }
      showContextMenu(e.clientX, e.clientY, items);
    };
    bar.append(save);
    card.append(bar);

    // The enable/disable list itself lives with the items (renderLibraryItems) — one
    // list with a switch per row, not a strip of "the rest" bolted underneath.
  }

  /** The link bar of a nested block: copied, or following a preset of its own.
   *
   *  Two states, and the difference has to be legible at a glance, because editing a
   *  LINKED block edits something SHARED — the preset it follows, and therefore every
   *  other preset and document that follows it too. */
  renderLinkBar(group, card, bar, info) {
    const linkedId = this.links.get(group.header);
    const linked = linkedId != null && info.presets.find((p) => p.id === linkedId);

    if (linked) {
      bar.append(div(`font-size:${T.fs.micro};color:${T.lib};flex-shrink:0;`, '🔗'));
      bar.append(div(`font-size:${T.fs.label};color:${T.text};flex:1;min-width:0;
        overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`,
      `editing ${group.header} / ${linked.name}`));
      // Not decoration: the user is about to change a thing other presets rely on.
      bar.append(div(`font-size:${T.fs.micro};color:${T.warn};background:rgba(249,226,175,.12);
        padding:2px 6px;border-radius:${T.radiusSm};flex-shrink:0;`, 'shared'));

      const unlink = button('unlink', { variant: 'quiet', size: 'sm' });
      unlink.title = 'Stop following it. The block keeps what is on screen, as a copy.';
      unlink.onclick = () => this.links.clear(group.header);
      bar.append(unlink);
      card.append(bar);
      return;
    }

    if (info.presets.length) {
      const link = button('🔗 link to preset', { variant: 'quiet', size: 'sm' });
      link.title = 'Follow one of this group’s presets. Edits here then go into it.';
      link.onclick = (e) => {
        showContextMenu(e.clientX, e.clientY, info.presets.map((p) => ({
          icon: '◆',
          iconColor: T.accent,
          label: p.name,
          hint: 'this block follows it from now on',
          action: () => this.links.set(group.header, p.id),
        })));
      };
      bar.append(link);
    }
  }

  /** Which preset is this block showing, and has it been touched since?
   *
   *  A document never records where a block came from — the text is all there is
   *  (§5.2). So the question is answered from the text itself: if the block IS what
   *  some preset expands to, that is the preset, and it is unchanged. That survives a
   *  reload, a reopened window, a workflow shared with someone else.
   *
   *  Once the block is edited it no longer equals anything, and the text cannot say
   *  what it used to be. That is the one case a memory is needed, and `this.loaded`
   *  (set when a preset is picked from the dropdown) is exactly that memory — nothing
   *  more: it never overrides what the text says, it only speaks when the text cannot. */
  presetState(group, src, info) {
    const block = sig(src.slice(group.span[0], group.span[1]));
    const match = info.presets.find((p) => p.text && sig(p.text) === block);
    if (match) return { preset: match, dirty: false };

    const loadedId = this.loaded.get(group.header);
    const loaded = loadedId != null && info.presets.find((p) => p.id === loadedId);
    return loaded ? { preset: loaded, dirty: true } : { preset: null, dirty: false };
  }

  /** Store this block as a preset — a new one, or over an existing one.
   *  `existing` is the preset row being replaced, or null for a new one. */
  async savePreset(group, existing) {
    let name = existing?.name;
    if (!existing) {
      name = await showPrompt(`New preset for [${group.header}] — the block as it is now:`);
      if (!name) return;
      if (this.library.get(group.header)?.presets.some((p) => p.name === name)) {
        const ok = await showConfirm(
          `[${group.header}] already has a preset called “${name}”.\n\nSaving replaces it.`,
          { okLabel: 'Replace', danger: true });
        if (!ok) return;
      }
    } else {
      const ok = await showConfirm(
        `Overwrite the preset “${existing.name}” with the block as it is now?`,
        { okLabel: 'Overwrite' });
      if (!ok) return;
    }

    const res = await fetch('/xyz/plv3/library/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: this.pane.text(), path: group.header, name }),
    });
    if (!res.ok) {
      toast(`Could not save the preset — ${(await res.json().catch(() => ({}))).error || res.status}`, 'error');
      return;
    }
    toast(existing ? `Preset “${name}” overwritten.` : `Preset “${name}” saved.`);
    // Saving takes the text into the library (new items get rows), so the cached
    // picture of the group — which is what the enable/disable list is drawn from — is
    // now one item behind.
    this.invalidateLibrary([group.header]);
  }

  /** The library changed under us (a blur-sync appended items, a preset was saved, a
   *  link was written through).  Refresh the cached picture of those groups.
   *
   *  What this must NOT do is drop the old picture first. The panel is drawn from it:
   *  without it, the library bar disappears and the unified enable/disable list falls
   *  back to plain rows — for the ~50 ms the fetch takes. Every save then makes the
   *  whole panel flinch and snap back, which is what "the UI twitches" is. So the old
   *  picture stays on screen and is swapped only when the new one has actually landed. */
  invalidateLibrary(paths) {
    for (const path of paths) this.fetchLibrary(path);
  }

  /** First sight of this path: nothing to keep on screen, so mark it loading. */
  loadLibrary(path) {
    if (this.library.has(path)) return;
    this.library.set(path, undefined);
    this.fetchLibrary(path);
  }

  async fetchLibrary(path) {
    // One flight per path. Saving fires several invalidations in a row (the group, then
    // whatever a link wrote through), and each landing response would re-render.
    this._inflight ||= new Map();
    if (this._inflight.has(path)) return this._inflight.get(path);

    const flight = (async () => {
      let value = null;
      try {
        const tree = await (await fetch('/xyz/plv3/library/tree')).json();
        const group = (tree.groups || []).find((g) => g.path === path);
        if (group) {
          value = await (await fetch(`/xyz/plv3/library/groups/${group.id}`)).json();
        }
      } catch (err) {
        console.warn('[PLv3] library lookup failed', err);
      }
      this.library.set(path, value);
      this._inflight.delete(path);
      this.render();
    })();

    this._inflight.set(path, flight);
    return flight;
  }
}

/** A block's identity for comparison: what it says, not how it is laid out.
 *
 *  The same preset expands to a different string depending on how deep the block sits
 *  (the expander indents by nesting level), and a user may have re-wrapped the lines.
 *  Neither changes the prompt, so neither may make a block look "modified". */
function sig(text) {
  return (text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
}

/** Shift every span in the snapshot to account for one applied edit: replacing
 *  [s, e) with `len` characters moves everything at or after `e` by delta, and
 *  collapses the edited range itself to end at s + len. */
function rebase(node, [s, e], len) {
  const delta = len - (e - s);
  if (!delta || !node) return;
  const move = (pos) => (pos >= e ? pos + delta : pos > s ? s + len : pos);
  const fix = (span) => {
    if (Array.isArray(span) && span.length === 2 && typeof span[0] === 'number') {
      span[0] = move(span[0]); span[1] = move(span[1]);
      return true;
    }
    return false;
  };
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    if (fix(value)) return;
    for (const v of Object.values(value)) walk(v);
  };
  walk(node.span);
  walk(node.spans);
  for (const child of node.children || []) rebase(child, [s, e], len);
}
