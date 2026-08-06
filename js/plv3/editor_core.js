// PLv3 — one prompt editor, used in two places.
//
// The main window edits a NODE's document; the library window edits a PRESET's block.
// They are the same object: a piece of PLv3 text. So they get the same editor — the
// Monarch grammar, the danbooru autocomplete (js/tagac.js, wiki links / preview images
// / related tags), the `[` library-path completion that expands to a real block, the
// squiggles and glyph markers, and the span-based two-way sync with the detail page.
//
// What differs between the two is only: where the text comes from, where it goes back
// to, and what `(seed, region_mode, polarity)` to compile it with. Those are hooks.
//
// This file owns NO text of its own. Whoever constructs it owns the model.

import { registerCompletions } from './complete.js';
import { LANG_ID, registerLanguage, replaceInTagsOnly } from './language.js';
import { loadMonaco } from './monaco.js';
import { settings } from './settings.js';
import { attachTagAC } from './tagac_monaco.js';
import { T, tint } from './theme.js';
import { showForm, toast } from './ui.js';

// The library-path completion fires a Monaco *command* to swap the `[path]` it wrote
// for the expanded block, and a command is registered globally, once. With two editors
// alive it must act on the one the user is actually typing in — hence the focus latch.
let _completionsReady = false;
let _focused = null;

// One Monaco model per node, SHARED by the embedded editor (the Monaco node) and the
// floating window. Two editors on one model means an edit in either is instantly in the
// other, and — crucially — neither ever setValue()s the other's content. A setValue
// rebuilds the whole model and blows away that editor's folding, which is exactly the
// "click away and the other side loses its collapsed groups" bug. Ref-counted: the model
// outlives any single editor and is disposed only when the last one lets go.
const _nodeModels = new Map(); // nodeId -> { model, refs }

export function acquireNodeModel(monaco, nodeId, initialText) {
  const key = String(nodeId);
  let entry = _nodeModels.get(key);
  if (!entry || entry.model.isDisposed()) {
    entry = { model: monaco.editor.createModel(initialText ?? '', LANG_ID), refs: 0 };
    _nodeModels.set(key, entry);
  }
  entry.refs += 1;
  return entry.model;
}

export function releaseNodeModel(nodeId) {
  const key = String(nodeId);
  const entry = _nodeModels.get(key);
  if (!entry) return;
  entry.refs -= 1;
  if (entry.refs <= 0) {
    entry.model.dispose();
    _nodeModels.delete(key);
  }
}

/** Put `next` into `model` WITHOUT setValue, so folding on every editor showing it
 *  survives. A single whole-document replace still resets folding, so diff down to the
 *  changed middle (common prefix + common suffix) and replace only that. This is the
 *  path a plain-textarea node uses to reach the window's model. */
export function replaceTextPreservingFolding(model, next) {
  const cur = model.getValue();
  if (cur === next) return;
  const max = Math.min(cur.length, next.length);
  let s = 0;
  while (s < max && cur[s] === next[s]) s += 1;
  let e1 = cur.length;
  let e2 = next.length;
  while (e1 > s && e2 > s && cur[e1 - 1] === next[e2 - 1]) { e1 -= 1; e2 -= 1; }
  const range = window.monaco.Range.fromPositions(
    model.getPositionAt(s), model.getPositionAt(e1));
  model.applyEdits([{ range, text: next.slice(s, e2) }]);
}

/** Round to 3 decimals and clamp — kills the 1.2000000004 that plain float adds give. */
function clampRound(v, min, max) {
  return Math.min(max, Math.max(min, Math.round(v * 1000) / 1000));
}

/** A number as short source text: 1.1 not 1.100, 0.95 not 0.9500. */
function fmtNum(v) {
  return String(parseFloat(v.toFixed(3)));
}

/** One Ctrl+↑/↓ step on a piece of prompt text. Returns the rewritten text.
 *
 *   - `<lora:name:0.8>`  -> bump the LoRA weight (its own range; may go negative)
 *   - `(tag:1.1)`        -> bump the attention weight; back to bare `tag` at exactly 1.0
 *   - `tag`              -> wrap it: `(tag:1.05)`
 *
 * The LAST `:number` before `)` is the weight (PLv3 does not escape `:`), so an inner
 * `a:b` is left intact. */
function bumpWeight(text, dir, s) {
  const lora = text.match(/^<([^:<>]+):([^:<>]+):(-?\d*\.?\d+)(?::(-?\d*\.?\d+))?>$/);
  if (lora) {
    const w = clampRound(parseFloat(lora[3]) + dir * s.loraStep, s.loraMin, s.loraMax);
    const clip = lora[4] !== undefined ? `:${lora[4]}` : '';
    return `<${lora[1]}:${lora[2]}:${fmtNum(w)}${clip}>`;
  }

  const att = text.match(/^\(\s*([\s\S]*?)\s*:\s*(-?\d*\.?\d+)\s*\)$/);
  const inner = att ? att[1] : text;
  const weight = att ? parseFloat(att[2]) : 1.0;
  const nw = clampRound(weight + dir * s.weightStep, s.weightMin, s.weightMax);
  if (Math.abs(nw - 1.0) < 1e-9) return inner;   // neutral again — drop the parens
  return `(${inner}:${fmtNum(nw)})`;
}

let _cssInjected = false;
function injectCss() {
  if (_cssInjected) return;
  _cssInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .plv3-line-error  { background: ${tint(T.bad, 0.10)}; }
  `;
  document.head.appendChild(style);
}

async function post(route, body) {
  const res = await fetch(`/xyz/plv3/${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${route} failed: ${res.status}`);
  return res.json();
}

export class PromptEditor {
  /**
   * @param container      where Monaco mounts
   * @param params()       -> { seed, region_mode, polarity } for the compile call
   * @param onCompiled(result)            the compile result (preview)
   * @param onAst(payload, { version })   the AST snapshot (detail page)
   * @param onLibrarySynced(paths)        blur-sync appended items to these groups
   * @param onEdited()                    a DETAIL-PAGE control rewrote the text
   *                                      (typing does not come through here)
   * @param onBlur()                      the text lost focus — time to persist
   * @param syncOnBlur                    run the library blur-sync (spec §5.3)
   * @param docStore   { get(): string|null, set(json) } — where the structured
   *                   document lives. The document is the source of truth: it holds
   *                   every item WITH its on/off switch, and the text is what its
   *                   enabled items render to. The main window backs this with the
   *                   node's hidden `doc` widget so it travels with the workflow;
   *                   without a store it lives for the session only.
   */
  constructor(container, {
    params, onCompiled, onAst, onLibrarySynced, onEdited, onBlur,
    syncOnBlur = true, options = {}, docStore = null,
  } = {}) {
    this.container = container;
    this.params = params || (() => ({}));
    this.onCompiled = onCompiled || (() => {});
    this.onAst = onAst || (() => {});
    this.onLibrarySynced = onLibrarySynced || (() => {});
    this.onEdited = onEdited || (() => {});
    this.onBlur = onBlur || (() => {});
    this.syncOnBlur = syncOnBlur;
    this.options = options;
    this.docStore = docStore;
    this._doc = null;          // the session fallback when there is no store
    this.monaco = null;
    this.editor = null;
    this._lintTimer = null;
    this._decorations = [];
  }

  /** The structured document as JSON text, or '' when there is none yet. */
  docJson() {
    const raw = this.docStore ? this.docStore.get() : this._doc;
    return typeof raw === 'string' ? raw : '';
  }

  doc() {
    const raw = this.docJson();
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;   // a corrupt store must not take the editor down with it
    }
  }

  setDoc(doc) {
    const json = doc ? JSON.stringify(doc) : '';
    if (this.docStore) this.docStore.set(json);
    else this._doc = json;
  }

  init() {
    if (!this._init) this._init = this._doInit();
    return this._init;
  }

  async _doInit() {
    const monaco = await loadMonaco();
    this.monaco = monaco;
    registerLanguage(monaco);
    injectCss();

    if (!_completionsReady) {
      _completionsReady = true;
      // A document never holds a bare `[path]` pointer — it holds the expanded block
      // (spec §3.6, §4.7). Monaco cannot insert text asynchronously, so the completion
      // writes the path and then fires this, which swaps it for the real thing.
      // `presetId` is null for the whole group, and an id when the user picked one of
      // its presets — the block that lands is then the preset's whitelist and order.
      monaco.editor.registerCommand('plv3.expandLibraryBlock', async (_acc, groupId, presetId) => {
        const target = _focused;
        if (!target) return;
        try {
          const { text } = await post('library/expand', {
            group_id: groupId,
            preset_id: presetId || null,
          });
          if (text) target.replaceRefAtCursor(text);
        } catch (err) {
          console.warn('[PLv3] could not expand the library block', err);
        }
      });
      registerCompletions(monaco, LANG_ID, { onInsertBlock: true });
    }

    this.editor = monaco.editor.create(this.container, {
      language: LANG_ID,
      theme: 'plv3-dark',
      automaticLayout: true,
      fontSize: settings().fontSize,
      lineNumbers: 'on',
      // No glyph margin: it reserves a whole line-height-wide blank column left of the
      // line numbers for an error dot that only duplicates the squiggle, the overview-
      // ruler tick and the whole-line error background. The space is not worth it.
      glyphMargin: false,
      lineNumbersMinChars: 3,   // a 5-digit-wide number column on a short prompt is wasteful
      folding: true,
      foldingStrategy: 'auto',
      showFoldingControls: 'always',
      wordWrap: settings().wordWrap ? 'on' : 'off',
      minimap: { enabled: false },
      autoIndent: 'full',
      scrollBeyondLastLine: false,
      renderWhitespace: 'none',
      tabSize: 4,
      ...this.options,
    });

    // The danbooru autocomplete PLv2 already has — wiki links, preview images, artist
    // works, related tags — driven straight from this editor (see tagac_monaco.js).
    attachTagAC(this.editor, this.container).catch((err) =>
      console.warn('[PLv3] could not attach the tag autocomplete', err));

    this.editor.onDidFocusEditorText(() => { _focused = this; });

    // A settings change must land without a reload: the panel is a floating window and
    // "restart ComfyUI to see the new font size" is not an acceptable answer.
    document.addEventListener('plv3:settings-changed', () => {
      this.editor?.updateOptions({
        fontSize: settings().fontSize,
        wordWrap: settings().wordWrap ? 'on' : 'off',
      });
    });
    this.editor.onDidBlurEditorText(() => {
      this.onBlur();
      if (this.syncOnBlur) this.syncLibrary();
      this._saveViewState();   // capture folding/scroll when the user leaves
    });
    this.editor.onDidChangeModelContent(() => this.scheduleLint());
    // Folding is view state (per editor), so it dies with the editor on a page refresh.
    // Persist it (see bindViewState) whenever it changes.
    this.editor.onDidChangeHiddenAreas?.(() => {
      this._scheduleViewSave();
      // ...and re-measure. Folding changes the content height, and this editor is often
      // folded — or has its folding restored — while its window is display:none or has
      // just been resized. When that happens the hidden lines' vertical space stays
      // reserved: the line numbers skip the collapsed range, but a blank band is left
      // where it was. layout() recomputes the whole view and repairs it.
      this._relayoutSoon();
    });

    // Spec §8.1: the built-in replace would happily rewrite `.set` or a library path.
    // This one only touches prompt text.
    this.editor.addAction({
      id: 'plv3.replaceInTags',
      label: 'PLv3: Replace in prompt text only',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyH],
      contextMenuGroupId: 'modification',
      run: () => this.promptReplaceInTags(),
    });

    // Ctrl+↑ / Ctrl+↓ — adjust the weight of the selection (or the tag at the cursor),
    // like ComfyUI's prompt boxes: `tag` -> `(tag:1.05)` -> `(tag:1.1)` …, back to bare
    // `tag` at 1.0. A `<lora:…>` gets its own weight bumped instead. Overrides Monaco's
    // default Ctrl+↑/↓ (scroll one line), which nobody reaches for in a prompt.
    this.editor.addAction({
      id: 'plv3.weightUp',
      label: 'PLv3: Increase weight',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.UpArrow],
      run: () => this.adjustWeight(+1),
    });
    this.editor.addAction({
      id: 'plv3.weightDown',
      label: 'PLv3: Decrease weight',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.DownArrow],
      run: () => this.adjustWeight(-1),
    });

    // Right-click a selection -> it becomes a library group, and the selection is
    // replaced by a reference to it. Without this the only way into the library is to
    // create a group in the other window and retype what you already wrote.
    this.editor.addAction({
      id: 'plv3.selectionToGroup',
      label: 'PLv3: Save selection as a library group…',
      contextMenuGroupId: 'modification',
      contextMenuOrder: 2,
      run: () => this.selectionToGroup(),
    });
  }

  /** The selection -> a new library group -> a `[path]: { … }` block in its place.
   *
   *  Replacing the text is the point: a document never points back at the library except
   *  through a block header, so a selection left as it was would be a copy that starts
   *  drifting from the group the moment either is edited. */
  async selectionToGroup() {
    const model = this.model();
    const sel = this.editor?.getSelection();
    if (!model || !sel || sel.isEmpty()) {
      toast('Select the part of the prompt you want to save first.', 'error');
      return;
    }
    // Imported here, not at the top: library.js imports this module, and a static cycle
    // between the two would leave one of them half-initialised at load time.
    const { libraryWindow } = await import('./library.js');
    const block = await libraryWindow.saveSelectionAsGroup(model.getValueInRange(sel));
    if (!block) return;

    // The selection may have moved while the dialog was open (the detail page rewrites
    // spans). Re-read it, and bail rather than overwrite whatever is there now.
    const now = this.editor.getSelection();
    if (!now || !now.equalsRange(sel)) {
      toast(`Created the group, but the selection moved — the text was left alone.`, 'warn');
      return;
    }
    this.editor.executeEdits('plv3-to-group', [{ range: sel, text: block }]);
    this.editor.pushUndoStop();
    this.onEdited();
    this.scheduleLint();
  }

  // --- weight nudging (Ctrl+↑/↓) ---------------------------------------------

  /** The range Ctrl+↑/↓ acts on: the selection if there is one, else the tag around the
   *  cursor — the run between item separators (`,` newline, or a group's `{ }`), trimmed. */
  weightTarget() {
    const model = this.model();
    const sel = this.editor.getSelection();
    if (sel && !sel.isEmpty()) return this.trimRange(model, sel);

    const text = model.getValue();
    const off = model.getOffsetAt(this.editor.getPosition());
    // A sentence-ending `.` ends an item too, so it bounds the tag the same way a comma
    // does — otherwise Ctrl+↑ on `tag3.` would grab `tag2. tag3.` and weight both.
    // `0.5` and `a.b` are NOT boundaries: the period must have blank after it.
    const stopAt = (i) => text[i] === '.' && (i + 1 >= text.length || /\s/.test(text[i + 1]));
    const isBoundary = (c) => c === ',' || c === '\n' || c === '{' || c === '}';
    let s = off;
    let e = off;
    while (s > 0 && !isBoundary(text[s - 1]) && !stopAt(s - 1)) s -= 1;
    while (e < text.length && !isBoundary(text[e]) && !stopAt(e)) e += 1;
    if (e <= s) return null;
    return this.trimRange(model,
      this.monaco.Range.fromPositions(model.getPositionAt(s), model.getPositionAt(e)));
  }

  /** Shrink a range past leading/trailing whitespace, so the wrap sits tight on the tag. */
  trimRange(model, range) {
    const text = model.getValueInRange(range);
    const lead = text.length - text.trimStart().length;
    const trail = text.length - text.trimEnd().length;
    const s = model.getOffsetAt(range.getStartPosition()) + lead;
    const e = model.getOffsetAt(range.getEndPosition()) - trail;
    if (e <= s) return null;
    return this.monaco.Range.fromPositions(model.getPositionAt(s), model.getPositionAt(e));
  }

  adjustWeight(dir) {
    const model = this.model();
    if (!model) return;
    const range = this.weightTarget();
    if (!range) return;
    const before = model.getValueInRange(range);
    const after = bumpWeight(before, dir, settings());
    if (after == null || after === before) return;

    this.editor.executeEdits('plv3-weight', [{ range, text: after }]);
    // Keep the tag selected so a run of presses keeps acting on the same thing (and the
    // user can see what moved). executeEdits already put the change on the undo stack.
    const s = model.getOffsetAt(range.getStartPosition());
    this.editor.setSelection(this.monaco.Range.fromPositions(
      model.getPositionAt(s), model.getPositionAt(s + after.length)));
  }

  // --- model ---
  createModel(text) {
    return this.monaco.editor.createModel(text ?? '', LANG_ID);
  }

  setModel(model) {
    this.editor.setModel(model);
  }

  model() {
    return this.editor?.getModel() ?? null;
  }

  text() {
    return this.model()?.getValue() ?? '';
  }

  setText(text) {
    const model = this.model();
    if (!model || model.getValue() === text) return;
    // A diff-edit, not setValue: this editor's folding must survive an external update.
    replaceTextPreservingFolding(model, text ?? '');
  }

  /** The model's version at this instant. The detail page stamps its AST snapshot with
   *  it and hands it back on every edit: a span computed against older text points at
   *  the wrong characters, so a stale edit must be dropped, not applied. */
  version() {
    return this.model()?.getVersionId() ?? 0;
  }

  focus() { this.editor?.focus(); }

  /** Monaco is created while its window is still display:none, and automaticLayout does
   *  not reliably recover from that 0x0 first measure. Re-measure when we become visible. */
  relayout() { this.editor?.layout(); }

  /** relayout on the next frame, coalescing a burst into one.
   *
   *  Next frame rather than now: the callers are Monaco's own view events, and calling
   *  layout() from inside one re-enters the view code mid-update. */
  _relayoutSoon() {
    cancelAnimationFrame(this._relayoutRaf);
    this._relayoutRaf = requestAnimationFrame(() => this.editor?.layout());
  }

  // --- folding persistence ---------------------------------------------------
  //
  // Monaco's collapsed regions are VIEW state, not model state: they live on the editor
  // and vanish when it is recreated (a page refresh, or the window switching to another
  // node). We save the whole view state (folding + cursor + scroll) to localStorage under
  // a caller-chosen key and restore it. The node keys on `node:<id>`, the window on
  // `window:<id>`, so each remembers its own folding.

  /** Persist this editor's view state under `key` and restore whatever was last saved.
   *  Call AFTER setModel. Re-callable with a new key (the window reuses one editor across
   *  nodes) — flush the outgoing key first with saveViewState(). */
  bindViewState(key) {
    this._viewKey = key;
    this._restoreViewState();
  }

  saveViewState() { this._saveViewState(); }

  _scheduleViewSave() {
    clearTimeout(this._viewTimer);
    this._viewTimer = setTimeout(() => this._saveViewState(), 250);
  }

  _saveViewState() {
    if (!this._viewKey || !this.editor) return;
    try {
      const state = this.editor.saveViewState();
      if (state) localStorage.setItem(`xyz.plv3.view.${this._viewKey}`, JSON.stringify(state));
    } catch { /* private mode / quota */ }
  }

  _restoreViewState() {
    let state;
    try {
      const raw = localStorage.getItem(`xyz.plv3.view.${this._viewKey}`);
      if (!raw) return;
      state = JSON.parse(raw);
    } catch { return; }
    // Folding is computed asynchronously by the folding provider after the model is set,
    // so a same-tick restore would find no regions to collapse. Restore next frame.
    const key = this._viewKey;
    requestAnimationFrame(() => {
      // The frame may have carried us to another node (two quick tab switches). Restoring
      // node A's scroll and folding onto node B is not a repair, it is a second bug.
      if (this._viewKey !== key) return;
      try { this.editor?.restoreViewState(state); } catch { return; /* editor gone */ }
      // Collapsing regions here changes the content height, and this often runs while the
      // window is still hidden — the same stale-layout blank band as above.
      this._relayoutSoon();
    });
  }

  // --- edits ---
  /** Rewrite the exact source ranges a detail-page control owns.
   *  `edits` is [{ span: [start, end], text }]. Returns false if the model moved on
   *  since `expectVersion` — the caller re-renders instead of corrupting the text. */
  applyEdits(edits, expectVersion) {
    const model = this.model();
    if (!model) return false;
    if (expectVersion != null && model.getVersionId() !== expectVersion) return false;
    if (!edits.length) return true;

    const ops = edits.map((e) => ({
      range: this.monaco.Range.fromPositions(
        model.getPositionAt(e.span[0]),
        model.getPositionAt(e.span[1]),
      ),
      text: e.text,
    }));
    // Through the editor, not the model, so the change joins Monaco's undo stack:
    // Ctrl+Z undoes a slider drag exactly like it undoes typing.
    this.editor.executeEdits('plv3-detail', ops);
    this.onEdited();
    return true;
  }

  /** Swap the `[path]` the completion just wrote for its expanded block. */
  replaceRefAtCursor(text) {
    const model = this.model();
    if (!model) return;
    const pos = this.editor.getPosition();
    const line = model.getLineContent(pos.lineNumber);

    const open = line.lastIndexOf('[', pos.column - 1);
    if (open === -1) return;
    let close = line.indexOf(']', open);
    if (close === -1) close = pos.column - 2;

    const range = new this.monaco.Range(pos.lineNumber, open + 1, pos.lineNumber, close + 2);
    this.editor.executeEdits('plv3-complete', [{ range, text }]);
    this.editor.focus();
    this.onEdited();
  }

  /** Drop a library block in at the caret, on its own lines. */
  insertAtCursor(text) {
    const model = this.model();
    if (!model) return;
    const pos = this.editor.getPosition();
    const line = model.getLineContent(pos.lineNumber);
    const before = line.slice(0, pos.column - 1).trim() ? '\n' : '';
    const after = line.slice(pos.column - 1).trim() ? '\n' : '';
    this.editor.executeEdits('plv3-library', [
      { range: this.monaco.Range.fromPositions(pos, pos), text: before + text + after },
    ]);
    this.editor.focus();
    this.onEdited();
  }

  async promptReplaceInTags() {
    const values = await showForm('Replace in prompt text only — the syntax vocabulary ' +
      '(.set, field names, [@schedule], library paths) is never touched.', [
      { key: 'find', label: 'Find', placeholder: 'blonde hair' },
      { key: 'replace', label: 'Replace with', placeholder: 'white hair' },
    ], { okLabel: 'Replace all' });
    if (!values || !values.find) return;
    const n = replaceInTagsOnly(this.monaco, this.editor, values.find, values.replace ?? '');
    toast(n ? `Replaced ${n} occurrence(s).` : 'Nothing to replace.');
  }

  /** Spec §5.3 — blur-sync: items typed into a `[path]: { … }` block that the library
   *  group does not have get appended to it. Nothing is ever deleted: "disabled" just
   *  means "not in the text", which the DB does not store. */
  async syncLibrary() {
    const text = this.text();
    if (!text.includes(']: {')) return; // no library block in sight
    try {
      const report = await post('library/sync', { text });
      // The group just grew. Anyone holding a picture of it — the detail page's
      // enable/disable list above all — is now looking at a stale library, and an item
      // it does not know about simply VANISHES when you delete it from the text instead
      // of moving to "disabled".
      const changed = (report.blocks || [])
        .filter((b) => b.found && b.added > 0)
        .map((b) => b.path);
      if (changed.length) this.onLibrarySynced(changed);
    } catch (err) {
      console.warn('[PLv3] library sync failed', err);
    }
  }

  // --- lint ---
  scheduleLint() {
    clearTimeout(this._lintTimer);
    this._lintTimer = setTimeout(() => this.lint(), settings().lintDelayMs);
  }

  /** Lint right now, no debounce.
   *
   *  The debounce exists to not hammer the server while someone is TYPING. A control in
   *  the detail page is one discrete action — waiting 250 ms before the panel catches up
   *  with a click is a quarter second of "did that work?". */
  lintNow() {
    clearTimeout(this._lintTimer);
    return this.lint();
  }

  async lint() {
    const model = this.model();
    if (!model) return;

    const text = model.getValue();
    const version = model.getVersionId();
    const body = { text, ...this.params() };

    let result;
    let ast;
    let sync;
    try {
      // The document rides along with the lint rather than on a round trip of its
      // own: it has to be folded forward through the same text the AST was parsed
      // from, or a switched-off item would be reconciled against stale text.
      [result, ast, sync] = await Promise.all([
        post('compile', body),
        post('ast', body),
        post('doc/sync', { text, doc: this.doc() }),
      ]);
    } catch (err) {
      console.warn('[PLv3] lint failed', err);
      return;
    }
    if (this.model() !== model) return; // the user switched documents mid-flight

    if (sync?.doc) this.setDoc(sync.doc);
    this.setMarkers(model, result.diagnostics || []);
    this.onCompiled(result);
    // The AST snapshot is only usable against the text it was parsed from.
    this.onAst(ast, { version, text, doc: sync?.doc ?? null });
  }

  setMarkers(model, diagnostics) {
    const markers = diagnostics.map((d) => {
      const start = model.getPositionAt(Math.max(0, d.pos));
      const word = model.getWordAtPosition(start);
      // A marker on a single punctuation character — an unbalanced `[`, say — is a
      // squiggle two pixels wide that nobody will ever see. When the position is not on
      // a word, underline the rest of the line instead.
      const eol = model.getLineMaxColumn(start.lineNumber);
      const endColumn = word ? word.endColumn : Math.max(start.column + 1, eol);
      return {
        severity: d.severity === 'error'
          ? this.monaco.MarkerSeverity.Error
          : this.monaco.MarkerSeverity.Warning,
        message: `[${d.code}] ${d.message}`,
        source: 'PLv3',
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: start.lineNumber,
        endColumn,
      };
    });
    this.monaco.editor.setModelMarkers(model, 'plv3', markers);

    // Monaco puts markers in the overview ruler and the squiggle, and nowhere else. A
    // document is long and the ruler is thin, so tint the error LINE as well. (No glyph-
    // margin dot — the glyph margin is off, and the dot only repeated the squiggle.)
    this._decorations = this.editor.deltaDecorations(this._decorations || [],
      markers
        .filter((m) => m.severity === this.monaco.MarkerSeverity.Error)
        .map((m) => ({
          range: new this.monaco.Range(m.startLineNumber, 1, m.startLineNumber, 1),
          options: { isWholeLine: true, className: 'plv3-line-error' },
        })));
  }
}
