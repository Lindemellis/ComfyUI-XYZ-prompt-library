/**
 * Prompt Library V2 — rich contentEditable editor with inline ref expansion.
 *
 * A reusable editor that renders a prompt TEMPLATE string with:
 *   • editable, live-highlighted [ref] tokens (arrow/click INTO them; newly-typed
 *     [xxx] is recognised as you type),
 *   • a chevron next to every RESOLVABLE ref that expands the referenced entry's
 *     text inline, in a non-editable "island" whose inner editor is itself a full
 *     rich editor (nested refs expand recursively, tinted by depth),
 *   • caret-stable live re-highlighting ("re-render the current level + restore the
 *     caret by char-offset", IME-guarded — validated in the Phase 0 spike).
 *
 * The braces/islands are NEVER part of the template string: serialisation walks the
 * top level and SKIPS islands, so the node output is unaffected by what's expanded.
 *
 * Backend is injected (so the core is pure + testable):
 *   resolveRef(name)         → Promise<boolean>  — is this ref expandable?
 *   loadEntry(name)          → Promise<string>   — the referenced entry's editable text
 *   saveEntry(name, text)    → void              — persist an island edit (debounced)
 *   normalize(text)          → string            — optional display normalisation on blur
 *
 * Public surface (consumed by plv2_editor.js in Phase 2c):
 *   el, getValue(), setValue(str), focus(), getCaret(), setCaret(n),
 *   insert(str), setFont(px), undo(), redo(), onChange(cb), refreshIsland(name,text),
 *   destroy().
 */

const REF_RE = /\[([^\[\]\n]*)\]/g;

function injectStyleOnce() {
  if (document.getElementById('plv2-rich-style')) return;
  const s = document.createElement('style');
  s.id = 'plv2-rich-style';
  s.textContent = `
    .plv2-rich { outline:none; white-space:pre-wrap; word-break:break-word; line-height:2.0; caret-color:#cdd6f4; }
    .plv2-rich:empty:before { content:attr(data-placeholder); color:#45475a; }
    .plv2-rich .ref { background:#2d1b5e; color:#cba6f7; border-radius:3px; padding:1px 1px; }
    .plv2-rich .ref.bad { background:#3d1520; color:#f38ba8; text-decoration:underline wavy #f38ba888; }
    .plv2-rich .chev { display:inline-block; cursor:pointer; user-select:none; color:#6c7086;
      font-size:.8em; width:14px; text-align:center; transition:transform .12s,color .12s; vertical-align:middle; }
    .plv2-rich .chev:hover { color:#cba6f7; }
    .plv2-rich .chev.open { transform:rotate(180deg); color:#cba6f7; }
    .plv2-rich .island { display:inline; border-radius:4px; padding:0 2px; margin:0 1px; user-select:none; }
    .plv2-rich .island-edit { display:inline; outline:none; padding:0 3px; border-radius:3px; user-select:text; }
    .plv2-rich .brace { user-select:none; font-weight:700; }
    .plv2-rich .d0 { background:rgba(137,180,250,.10); } .plv2-rich .d0 > .brace { color:#89b4fa; }
    .plv2-rich .d1 { background:rgba(203,166,247,.12); } .plv2-rich .d1 > .brace { color:#cba6f7; }
    .plv2-rich .d2 { background:rgba(148,226,213,.12); } .plv2-rich .d2 > .brace { color:#94e2d5; }
    .plv2-rich .d3 { background:rgba(250,179,135,.12); } .plv2-rich .d3 > .brace { color:#fab387; }
  `;
  document.head.appendChild(s);
}

export function createRichEditor(opts = {}) {
  injectStyleOnce();
  const {
    resolveRef = async () => false,
    loadEntry  = async () => '',
    saveEntry  = () => {},
    loadThisRefs = null,   // (name) → Promise<string[]> : the entry's sub-entry names for [this.x] AC
    normalize  = null,
    placeholder = '',
  } = opts;

  // ── Root ──
  const root = document.createElement('div');
  root.className = 'plv2-rich';
  root.contentEditable = 'true';
  root.spellcheck = false;
  root.dataset.placeholder = placeholder;

  let composing = false;                 // IME guard
  let onChangeCb = null;
  const validCache = new Map();          // ref name → boolean (expandable?)
  let pendingValidation = new Set();     // names being validated
  const islands = new Map();             // ref name → Set<island element> (for refresh)
  const undoStack = [];                  // { value, caret }
  let undoIdx = -1, undoTimer = null;

  // ─── Char-offset caret model, scoped to ONE level ───────────────────────────
  // A level's string = its text incl. text inside .ref spans (editable), but
  // SKIPPING nested .chev / .island subtrees (chrome / deeper levels).

  function isSkipped(node, scope) {
    for (let p = node.parentNode; p && p !== scope; p = p.parentNode) {
      if (p.classList && (p.classList.contains('chev') || p.classList.contains('island'))) return true;
    }
    return false;
  }
  // Ordered editable "atoms" of a level: text nodes + <br> elements (each <br> = one
  // "\n"). Skips chev/island subtrees. The string + caret math run on this, so a newline
  // rendered as a <br> (buildLevel renders a TRAILING "\n" as <br> so the caret can reach
  // past it before an island's "}") is counted wherever it ends up — not only when it is
  // the last child (otherwise typing after a leading newline would silently drop it).
  function levelAtoms(scope) {
    const atoms = [];
    (function walk(node) {
      for (const ch of node.childNodes) {
        if (ch.nodeType === 3) atoms.push({ br: false, node: ch });
        else if (ch.nodeType === 1) {
          if (ch.classList && (ch.classList.contains('chev') || ch.classList.contains('island'))) continue;
          if (ch.tagName === 'BR') atoms.push({ br: true, node: ch });
          else walk(ch);
        }
      }
    })(scope);
    return atoms;
  }
  const _atomLen = a => (a.br ? 1 : a.node.textContent.length);
  function levelString(scope) {
    return levelAtoms(scope).map(a => (a.br ? '\n' : a.node.textContent)).join('');
  }

  // Char offset of a DOM point (node, off) within `scope`'s level, or null if the
  // point isn't in this level (e.g. inside a nested island).
  function pointOffset(scope, node, off) {
    if (node.nodeType === 1) {
      if (node === scope && off === 0) return 0;
      const before = node.childNodes[off - 1];   // node just before the caret
      if (before && before.nodeType === 1 && before.tagName === 'BR') {
        if (isSkipped(before, scope)) return null;
        let acc = 0;   // caret right after a <br> → chars up to and incl. that <br>
        for (const a of levelAtoms(scope)) { acc += _atomLen(a); if (a.node === before) return acc; }
        return acc;
      }
      if (before && before.nodeType === 3) { node = before; off = before.textContent.length; }
      else if (!before) {
        const first = node.childNodes[0];
        if (first && first.nodeType === 3) { node = first; off = 0; } else return 0;
      } else return null;
    }
    if (!scope.contains(node) || isSkipped(node, scope)) return null;
    let acc = 0;
    for (const a of levelAtoms(scope)) {
      if (!a.br && a.node === node) return acc + off;
      acc += _atomLen(a);
    }
    return null;
  }
  // The DOM point for a char offset within `scope`'s level. `off` may be 'before'/'after'
  // (for a <br>) instead of a numeric text offset.
  function locate(scope, target) {
    const atoms = levelAtoms(scope);
    let acc = 0;
    for (const a of atoms) {
      const len = _atomLen(a);
      if (a.br) {
        if (target <= acc)      return { node: a.node, off: 'before' };
        if (target === acc + 1) return { node: a.node, off: 'after' };
      } else if (target <= acc + len) {
        return { node: a.node, off: Math.max(0, target - acc) };
      }
      acc += len;
    }
    const last = atoms[atoms.length - 1];
    if (!last) return null;
    return last.br ? { node: last.node, off: 'after' } : { node: last.node, off: last.node.textContent.length };
  }
  function caretOffsetIn(scope) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    return pointOffset(scope, r.endContainer, r.endOffset);
  }
  function setCaretIn(scope, target) {
    const loc = locate(scope, target);
    if (!loc) { scope.focus(); return; }
    const r = document.createRange();
    if (loc.off === 'after') r.setStartAfter(loc.node);
    else if (loc.off === 'before') r.setStartBefore(loc.node);
    else r.setStart(loc.node, loc.off);
    r.collapse(true);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  }
  // TOP-level selection → { start, end, text } (collapsed at caret if the selection
  // crosses an island boundary). Used by find/replace + the context menu.
  function getSelection() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return { start: 0, end: 0, text: '' };
    const r = sel.getRangeAt(0);
    const a = pointOffset(root, r.startContainer, r.startOffset);
    const b = pointOffset(root, r.endContainer, r.endOffset);
    if (a == null || b == null) { const c = caretOffsetIn(root) ?? 0; return { start: c, end: c, text: '' }; }
    const start = Math.min(a, b), end = Math.max(a, b);
    return { start, end, text: levelString(root).slice(start, end) };
  }
  // Select [start, end) in the top level (find-match highlight). Skips islands.
  function selectRange(start, end) {
    const a = locate(root, start), b = locate(root, end);
    if (!a || !b) return;
    const r = document.createRange();
    r.setStart(a.node, a.off); r.setEnd(b.node, b.off);
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
    root.focus();
  }
  // Replace the whole top-level template (find/replace, autocomplete, normalisation)
  // recording one undo step + firing change, while PRESERVING open islands (rebuild via
  // rerenderLevel, which re-attaches them by ref-occurrence).
  function applyEdit(newValue, caret) {
    rerenderLevel(root, 0, newValue, caret == null ? undefined : caret);
    recordUndo(true);
    emitChange();
  }
  // Replace the top-level char range [start, end) with `text` (used by autocomplete).
  function replaceRange(start, end, text) {
    const v = levelString(root);
    applyEdit(v.slice(0, start) + text + v.slice(end), start + text.length);
  }
  // Viewport rect of the caret (for positioning the autocomplete dropdown). Falls back
  // to the editor box when a collapsed range has no measurable rect.
  function caretRect() {
    const sel = window.getSelection();
    const lh = parseFloat(getComputedStyle(root).lineHeight) || 18;
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0).cloneRange(); r.collapse(false);
      const rect = r.getBoundingClientRect();
      if (rect && (rect.top || rect.left || rect.height)) {
        return { top: rect.top, left: rect.left, lineHeight: rect.height || lh };
      }
    }
    const er = root.getBoundingClientRect();
    return { top: er.top, left: er.left, lineHeight: lh };
  }

  // ── Scope-aware accessors: autocomplete drives whichever level the caret is in —
  //    the top editor OR the island the caret sits inside (so [this.x] + tag AC work
  //    inside an expanded ref). `activeScope`/`depthOf`/`toggleIsland` are hoisted decls. ──
  function scopeValue() { return levelString(activeScope()); }
  function scopeCaret() { return caretOffsetIn(activeScope()); }
  function spliceActive(start, end, text) {
    const scope = activeScope();
    const v = levelString(scope);
    const nv = v.slice(0, start) + text + v.slice(end);
    if (scope === root) applyEdit(nv, start + text.length);             // top: island-preserving + undo
    else rerenderLevel(scope, depthOf(scope), nv, start + text.length); // island: rerender (blur saves)
  }
  // Sub-entry names ([this.x] candidates) for the island the caret is in; [] at top level.
  function activeThisRefs() {
    const scope = activeScope();
    return (scope !== root && Array.isArray(scope._xyzThisRefs)) ? scope._xyzThisRefs : [];
  }
  // The full inline-expansion tree of a level: [{ ref, children:[...] }, ...] in document
  // order. Used to remember/restore expansions (incl. NESTED) across node switches.
  function getExpansionTree(scope) {
    scope = scope || root;
    const out = [];
    for (const ch of scope.childNodes) {
      if (ch.nodeType === 1 && ch.classList && ch.classList.contains('island')) {
        const inner = ch.querySelector(':scope > .island-edit');
        out.push({ ref: ch.dataset.ref, children: inner ? getExpansionTree(inner) : [] });
      }
    }
    return out;
  }
  // Expand `ref`'s first not-open island in `scope` (silent — no focus steal), await its
  // content load, and return the island's inner element (so children can be expanded into it).
  async function _expandIn(scope, ref, depth) {
    for (const node of scope.childNodes) {
      if (node.nodeType === 1 && node.classList && node.classList.contains('ref') && node.dataset.ref === ref) {
        const chev = node.nextSibling;
        if (chev && chev.classList && chev.classList.contains('chev') && !chev.classList.contains('open')) {
          await toggleIsland(chev, ref, depth, true);
          const island = chev.nextSibling;
          return (island && island.classList && island.classList.contains('island'))
            ? island.querySelector(':scope > .island-edit') : null;
        }
      }
    }
    return null;
  }
  async function applyExpansionTree(tree, scope, depth) {
    if (!Array.isArray(tree) || !tree.length) return;
    scope = scope || root; depth = depth || 0;
    // Expand siblings in PARALLEL: each toggleIsland creates its island SHELL synchronously
    // (before its async content load), so all shells at a level are in the DOM within the
    // same tick — the collapsed state is never painted, so there's no collapse→expand flash
    // on node switch. (toggleIsland sets chev.open synchronously, so a duplicate ref's later
    // occurrence is still found correctly.)
    await Promise.all(tree.map(async item => {
      const inner = await _expandIn(scope, item.ref, depth);
      if (inner && item.children && item.children.length) await applyExpansionTree(item.children, inner, depth + 1);
    }));
  }

  // ─── Rendering ──────────────────────────────────────────────────────────────

  function makeChevron(name, depth) {
    const chev = document.createElement('span');
    chev.className = 'chev'; chev.textContent = '⌄';
    chev.contentEditable = 'false';
    chev.title = 'Expand / collapse this entry inline';
    chev.addEventListener('mousedown', e => { e.preventDefault(); toggleIsland(chev, name, depth); });
    return chev;
  }

  // Build a level string into `target`: text + editable ref spans + chevrons. A single
  // TRAILING "\n" is rendered as a <br> anchor (so the caret can reach/delete a newline
  // typed right before an island's "}"); inner newlines stay as "\n" text under pre-wrap,
  // so there's no double line break. See levelAtoms/levelString/locate.
  function buildLevel(target, text, depth) {
    let trailNL = false;
    if (text.endsWith('\n')) { text = text.slice(0, -1); trailNL = true; }
    let last = 0, m; REF_RE.lastIndex = 0;
    while ((m = REF_RE.exec(text)) !== null) {
      if (m.index > last) target.appendChild(document.createTextNode(text.slice(last, m.index)));
      const name = m[1].trim();
      // `[this(.x)]` is a self-reference resolved relative to the owning entry at generation
      // time — always valid (never red), and not directly expandable here. Inside an island
      // its sub-entry names also power [this.x] autocomplete (activeThisRefs).
      const isThis = /^this(\.|$)/.test(name);
      const known = isThis ? true : validCache.get(name);
      const span = document.createElement('span');
      span.className = 'ref' + (known === false ? ' bad' : '');
      span.textContent = '[' + m[1] + ']';
      span.dataset.ref = name;
      target.appendChild(span);
      // Optimistically show the chevron for any resolvable ref that isn't KNOWN-invalid, so
      // its expand affordance is present the instant it's typed — no async layout shift when
      // background validation later confirms it. A [this.x] ref gets a chevron only INSIDE an
      // island (depth>0), where `this` resolves to that island's entry; at the top level
      // `this` is meaningless so it has none.
      if (name && known !== false && (!isThis || depth > 0)) {
        target.appendChild(makeChevron(name, depth));
        if (!isThis && known === undefined) queueValidation(name);
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) target.appendChild(document.createTextNode(text.slice(last)));
    if (trailNL) target.appendChild(document.createElement('br'));   // trailing-newline caret anchor
  }

  // Re-render ONE level, preserving caret + re-attaching open islands by occurrence.
  // overrideText/overrideCaret let callers (insert, find/replace, newline) rebuild from a
  // MODIFIED string while STILL keeping the open islands — the key to not collapsing an
  // expanded ref when you insert a tag / autocomplete / replace text.
  function rerenderLevel(scope, depth, overrideText, overrideCaret) {
    const off = overrideCaret !== undefined ? overrideCaret : caretOffsetIn(scope);
    // Snapshot open islands by ref-occurrence index at this level.
    const openByIndex = new Map();
    let idx = -1;
    for (const ch of scope.childNodes) {
      if (ch.nodeType !== 1) continue;
      if (ch.classList.contains('ref')) idx++;
      if (ch.classList.contains('island')) openByIndex.set(idx, ch);
    }
    const text = overrideText !== undefined ? overrideText : levelString(scope);
    scope.innerHTML = '';
    buildLevel(scope, text, depth);
    // Re-attach islands whose ref (by occurrence) is unchanged + still expandable. A
    // [this.x] ref is valid-by-syntax (never in validCache) but IS expandable inside an
    // island, so accept it too — otherwise a nested [this.x] island would collapse here.
    let occ = -1;
    for (const node of [...scope.childNodes]) {
      if (node.nodeType === 1 && node.classList.contains('ref')) {
        occ++;
        const island = openByIndex.get(occ);
        const ref = node.dataset.ref;
        const expandable = /^this(\.|$)/.test(ref) || validCache.get(ref) === true;
        if (island && expandable && island.dataset.ref === ref) {
          const chev = node.nextSibling;
          if (chev && chev.classList && chev.classList.contains('chev')) {
            chev.classList.add('open'); chev.after(island);
          }
        }
      }
    }
    if (off != null) setCaretIn(scope, off);
  }

  // ─── Async ref validation ─────────────────────────────────────────────────────

  let validateTimer = null;
  function queueValidation(name) {
    if (validCache.has(name) || pendingValidation.has(name)) return;
    pendingValidation.add(name);
    clearTimeout(validateTimer);
    validateTimer = setTimeout(flushValidation, 200);
  }
  async function flushValidation() {
    const names = [...pendingValidation]; pendingValidation = new Set();
    if (!names.length) return;
    const results = await Promise.all(names.map(async n => {
      try { return [n, !!(await resolveRef(n))]; } catch { return [n, false]; }
    }));
    let dirty = false;
    for (const [n, ok] of results) {
      const prev = validCache.get(n);
      validCache.set(n, ok);
      // The optimistic chevron already shows for unknown refs, so undefined→true is a
      // visual no-op and needs no re-render (this is what removes the first-load jank).
      // Only transitions that change the DOM — a ref becoming invalid, or a previously
      // invalid ref becoming valid again — warrant a re-render.
      if (prev !== ok && (ok === false || prev === false)) dirty = true;
    }
    if (dirty) {
      // Re-render the top level + every open island's inner so red/chevrons update.
      rerenderTopPreservingCaret();
    }
  }
  function rerenderTopPreservingCaret() {
    // Only the level holding the caret can safely keep it; re-render all levels but the
    // caret restore inside rerenderLevel is a no-op where the caret isn't.
    rerenderLevel(root, 0);
    for (const inner of root.querySelectorAll('.island-edit')) {
      rerenderLevel(inner, depthOf(inner));
    }
  }
  // The build-depth of an .island-edit = how many island ancestors it has (a top-level
  // island's inner was built at depth 1 and has exactly 1 island ancestor).
  function depthOf(el) {
    let d = 0;
    for (let p = el.parentNode; p && p !== root; p = p.parentNode) {
      if (p.classList && p.classList.contains('island')) d++;
    }
    return d;
  }

  // ─── Islands (inline ref expansion) ───────────────────────────────────────────

  // Cache the loaded entry text + this-refs per RESOLVED ref. Re-expanding (notably when
  // restoring expansions on a node switch) then renders SYNCHRONOUSLY from cache — no "…"
  // placeholder, so no flash — while a background reload keeps it fresh.
  const entryTextCache = new Map();   // resolved ref → entry text
  const thisRefsCache  = new Map();   // resolved ref → sub-entry names

  function trackIsland(name, island) {
    if (!islands.has(name)) islands.set(name, new Set());
    islands.get(name).add(island);
  }
  function untrackIsland(name, island) {
    islands.get(name)?.delete(island);
  }

  async function toggleIsland(chev, name, depth, silent) {
    const next = chev.nextSibling;
    if (next && next.classList && next.classList.contains('island') && next.dataset.ref === name) {
      untrackIsland(name, next);
      next.remove(); chev.classList.remove('open'); emitChange(); return;
    }
    // Resolve [this(.x)] relative to the ENCLOSING island's entry (this is only meaningful
    // inside an island). Other refs use their name as-is; a known-invalid one is ignored.
    let target = name;
    if (/^this(\.|$)/.test(name)) {
      const baseRef = chev.closest('.island-edit')?.dataset.ref;
      if (!baseRef) return;
      target = name === 'this' ? baseRef : baseRef + name.slice(4);   // "this.x" → "<baseRef>.x"
    } else if (validCache.get(name) === false) {
      return;   // optimistic chevron clicked before validation marked it invalid
    }
    const island = document.createElement('span');
    island.className = 'island d' + (depth % 4);
    island.contentEditable = 'false';
    island.dataset.ref = name;          // displayed ref (collapse-toggle + tracking)
    const lb = document.createElement('span'); lb.className = 'brace'; lb.textContent = '{';
    const rb = document.createElement('span'); rb.className = 'brace'; rb.textContent = '}';
    const inner = document.createElement('span');
    inner.className = 'island-edit'; inner.contentEditable = 'true'; inner.dataset.ref = target;  // RESOLVED entry

    // If we've loaded this entry before, render its content SYNCHRONOUSLY from cache (no
    // "…" flash). Otherwise show a brief placeholder while loadEntry fetches it.
    const cachedText = entryTextCache.get(target);
    const haveCache = cachedText != null;
    if (haveCache) {
      if (thisRefsCache.has(target)) inner._xyzThisRefs = thisRefsCache.get(target);
      buildLevel(inner, cachedText, depth + 1);
      wireIslandInner(inner, target, depth);
    } else {
      inner.textContent = '…';
    }
    island.append(lb, inner, rb);
    chev.after(island);
    chev.classList.add('open');
    trackIsland(name, island);
    if (haveCache && !silent) { setCaretIn(inner, levelString(inner).length); inner.focus(); }
    emitChange();

    if (haveCache) {
      // Warm cache: refresh in the BACKGROUND (not awaited) — the content (and any nested
      // refs) is already rendered from cache, so a caller restoring nested expansions can
      // proceed synchronously with no "…"/collapse flash.
      _loadIslandContent(inner, target, depth, true, cachedText, silent);
    } else {
      // Cold cache (first load, e.g. after a page refresh): AWAIT the load so the inner's
      // content — and the nested ref nodes inside it — EXISTS before a caller
      // (applyExpansionTree) tries to restore nested expansions into it.
      await _loadIslandContent(inner, target, depth, false, null, silent);
    }
  }

  // Background: load (or refresh) an island's entry text + this-refs and cache them.
  async function _loadIslandContent(inner, target, depth, haveCache, cachedText, silent) {
    let text = '';
    try { text = await loadEntry(target); } catch { text = ''; }
    entryTextCache.set(target, text || '');
    if (loadThisRefs) {
      try { const r = await loadThisRefs(target); inner._xyzThisRefs = r; thisRefsCache.set(target, r); }
      catch { if (!inner._xyzThisRefs) inner._xyzThisRefs = []; }
    }
    if (inner.dataset.ref !== target || !inner.isConnected) return;   // island closed/changed meanwhile
    if (!haveCache) {
      // First load → render the fetched content now.
      inner.textContent = '';
      buildLevel(inner, text || '', depth + 1);
      wireIslandInner(inner, target, depth);   // edits commit to the RESOLVED entry
      emitChange();
      if (!silent) { setCaretIn(inner, levelString(inner).length); inner.focus(); }
    } else if ((text || '') !== cachedText &&
               document.activeElement !== inner && !inner.contains(document.activeElement)) {
      // Cache was stale & the user isn't editing here → refresh (preserving nested islands).
      rerenderLevel(inner, inner._plv2depth ?? (depth + 1), text || '', undefined);
      emitChange();
    }
  }

  function wireIslandInner(inner, entryRef, depth) {
    const onInput = () => {
      if (composing) return;
      rerenderLevel(inner, depth + 1);   // live highlight only — NO save while typing
    };
    inner.addEventListener('input', onInput);
    inner.addEventListener('compositionstart', () => { composing = true; });
    inner.addEventListener('compositionend', () => { composing = false; onInput(); });
    // Commit the entry edit on BLUR, exactly like the entry detail text box (a typing
    // debounce would create a partial prompt per slow keystroke). The full text — including
    // the user's leading/trailing/inner newlines — is saved verbatim, so the layout survives
    // and round-trips to the entry's raw_text / detail box.
    inner.addEventListener('blur', () => {
      const content = levelString(inner);
      // Only save if the content ACTUALLY changed. Merely placing the caret in an island
      // and clicking away (e.g. to the entry detail box) must not fire a save → entry-changed
      // → entry-detail full reload, which would destroy the box the user just clicked (#3).
      if (content === entryTextCache.get(entryRef)) return;
      entryTextCache.set(entryRef, content);   // keep the cache in sync with the just-saved text
      saveEntry(entryRef, content);
    });
    inner._plv2depth = depth + 1;
  }

  /** External update (entry edited elsewhere): refresh open islands for `name`,
   *  unless the user is currently editing inside one. */
  function refreshIsland(name, text) {
    const set = islands.get(name); if (!set) return;
    const activeInner = document.activeElement;
    for (const island of set) {
      const inner = island.querySelector(':scope > .island-edit');
      if (!inner || inner === activeInner || inner.contains(activeInner)) continue;
      entryTextCache.set(inner.dataset.ref, text || '');   // keep cache fresh
      // Rebuild from the new text but PRESERVE nested expanded islands (rerenderLevel
      // re-attaches them by ref-occurrence) — a plain buildLevel would collapse a ref
      // that was expanded INSIDE this one.
      rerenderLevel(inner, inner._plv2depth ?? 1, text || '', undefined);
    }
  }

  // ─── Top-level editing ────────────────────────────────────────────────────────

  function onTopInput() {
    if (composing) return;
    if (caretOffsetIn(root) == null) return;   // caret is inside an island → handled there
    rerenderLevel(root, 0);
    recordUndo();
    emitChange();
  }
  root.addEventListener('input', onTopInput);
  root.addEventListener('compositionstart', () => { composing = true; });
  root.addEventListener('compositionend', () => { composing = false; onTopInput(); });
  root.addEventListener('blur', () => {
    if (!normalize) return;
    const v = levelString(root); const nv = normalize(v);
    if (nv !== v) { setValue(nv); emitChange(); }
  });
  root.addEventListener('keydown', e => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
  });
  // The editable level (root, or the island inner) the caret is in.
  function activeScope() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return root;
    let n = sel.getRangeAt(0).startContainer;
    if (n.nodeType === 3) n = n.parentNode;
    for (let p = n; p; p = p.parentNode) {
      if (p === root) return root;
      if (p.classList && p.classList.contains('island-edit')) return p;
    }
    return root;
  }
  // Enter inserts a literal "\n" kept in the flat-text model (white-space:pre-wrap renders
  // it). contentEditable's default Enter would create <div>/<br> and corrupt the model. When
  // autocomplete confirms a suggestion it preventDefaults the keydown, which stops this
  // beforeinput from firing — so Enter both confirms AC and (when AC is closed) breaks the line.
  root.addEventListener('beforeinput', e => {
    if (e.inputType !== 'insertParagraph' && e.inputType !== 'insertLineBreak') return;
    if (composing) return;   // let the IME handle Enter (commit) during composition
    e.preventDefault();
    const scope = activeScope();
    const off = caretOffsetIn(scope);
    if (off == null) return;
    const v = levelString(scope);
    rerenderLevel(scope, depthOf(scope), v.slice(0, off) + '\n' + v.slice(off), off + 1);
    if (scope === root) { recordUndo(true); emitChange(); }
    // island: the next blur commits the newline (consistent with typed edits)
  });

  // ─── Undo / redo (value + caret snapshots; native undo breaks under re-render) ──

  function recordUndo(immediate = false) {
    clearTimeout(undoTimer);
    const commit = () => {
      const v = levelString(root);
      if (undoStack[undoIdx] && undoStack[undoIdx].value === v) return;
      undoStack.splice(undoIdx + 1);
      undoStack.push({ value: v, caret: caretOffsetIn(root) ?? v.length });
      if (undoStack.length > 300) undoStack.shift();
      undoIdx = undoStack.length - 1;
    };
    if (immediate) commit(); else undoTimer = setTimeout(commit, 350);
  }
  function applyUndo() {
    const s = undoStack[undoIdx]; if (!s) return;
    setValue(s.value);
    setCaretIn(root, Math.min(s.caret, s.value.length));
    root.focus(); emitChange();
  }
  function undo() { recordUndo(true); if (undoIdx <= 0) return; undoIdx--; applyUndo(); }
  function redo() { if (undoIdx >= undoStack.length - 1) return; undoIdx++; applyUndo(); }

  // ─── Public API ────────────────────────────────────────────────────────────────

  function emitChange() { onChangeCb && onChangeCb(getValue()); }
  function getValue() { return levelString(root); }
  function setValue(str) {
    root.innerHTML = '';
    buildLevel(root, String(str ?? ''), 0);
  }
  function focus() { root.focus(); }
  function getCaret() { return caretOffsetIn(root); }
  function setCaret(n) { setCaretIn(root, n); }
  function insert(str) {
    const off = caretOffsetIn(root); if (off == null) return;
    const v = levelString(root);
    applyEdit(v.slice(0, off) + str + v.slice(off), off + str.length);   // island-preserving
    root.focus();
  }
  function setFont(px) { root.style.fontSize = px + 'px'; }
  function onChange(cb) { onChangeCb = cb; }
  function destroy() { root.remove(); islands.clear(); validCache.clear(); }
  // Ref names that currently have at least one open island (for external refresh).
  function openIslandRefs() {
    const out = [];
    for (const [name, set] of islands) if (set && set.size) out.push(name);
    return out;
  }

  return {
    el: root,
    getValue, setValue, focus, getCaret, setCaret, insert, setFont,
    getSelection, selectRange, applyEdit, replaceRange, caretRect,
    scopeValue, scopeCaret, spliceActive, activeThisRefs,
    getExpansionTree, applyExpansionTree,
    undo, redo, onChange, refreshIsland, openIslandRefs, destroy,
    // expose for tests / advanced callers
    _validCache: validCache, _rerender: rerenderTopPreservingCaret,
  };
}
