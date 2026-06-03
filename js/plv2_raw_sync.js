/**
 * Prompt Library V2 — shared raw_text ↔ prompt-list reconciliation.
 *
 * Extracted verbatim from plv2_entry.js so BOTH the entry detail window AND the
 * editor's inline ref-expansion islands drive the SAME reconciliation — single
 * source of truth, no drift. This is a PURE DATA layer: it parses a raw_text box
 * into prompt parts and reconciles a library node's own prompts + inherited
 * template overrides through the API. It does NO UI rendering and fires NO events;
 * the caller owns rendering + the plv2:entry-changed / editor-changed notifications.
 *
 * Exposed as window.plv2.rawSync = { parsePromptPart, parseRawParts, syncRawText }.
 */

// "(content:1.2)" → { content, weight }; bare text → weight 1.0
function parsePromptPart(raw) {
  const m = raw.match(/^\(\s*(.+?)\s*:([\d.]+)\s*\)$/);
  if (m) return { content: m[1], weight: parseFloat(m[2]) || 1.0 };
  return { content: raw.trim(), weight: 1.0 };
}

// Parse a text box into prompt parts, recording how many newlines follow each
// prompt (sepAfter) so the user's line layout survives list-ops and resolve.
function parseRawParts(text, delim) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  let last = null;
  for (let li = 0; li < lines.length; li++) {
    for (const seg of lines[li].split(delim)) {
      const s = seg.trim();
      if (!s) continue;
      const p = parsePromptPart(s);
      last = { content: p.content, weight: p.weight, sepAfter: 0 };
      out.push(last);
    }
    if (li < lines.length - 1 && last) last.sepAfter += 1;  // newline ends this line
  }
  return out;
}

/**
 * Reconcile a node's prompts/overrides to match `rawText`. Mutates `ownPrompts`
 * and `tplPrompts` IN PLACE (so the caller's arrays reflect the new state) and
 * performs the API writes. Returns { changed } — whether normalisation altered the
 * text (the caller may then choose to rewrite the box).
 *
 *   api         — window.plv2.api
 *   cleanPrompt — window.plv2.cleanPrompt (normalise + trailing-delim trim; skips refs)
 *   nodeId, delimiter, rawText
 *   ownPrompts  — this entry's own prompts  [{id,content,weight,enabled,order_index,sep_after}]
 *   tplPrompts  — inherited template prompts (effective enable/weight after overrides)
 */
async function syncRawText({ api, cleanPrompt, normalizePrompt, nodeId, delimiter, rawText, ownPrompts, tplPrompts }) {
  // Normalise separator characters BEFORE tokenising. Otherwise a separator that
  // isn't exactly the delimiter — a full-width comma "，" (which normalisation maps
  // to ", "), or a comma with no following space — fails to split, bundling several
  // prompts/refs into one malformed token (e.g. "（），[a.b]" → one token "\(\), [a.b]"
  // instead of "\(\)" + "[a.b]"). normalizePrompt skips [refs]/{patterns}, so ref
  // contents stay intact. Falls back to the raw text if no normaliser is supplied.
  const text = normalizePrompt ? normalizePrompt(rawText) : rawText;
  // Structured parse: prompt parts + the newline count after each.
  const rawParts = parseRawParts(text, delimiter);

  // Normalise (skip refs/patterns) + drop duplicates, keeping first occurrence.
  const seen = new Set();
  const parts = [];
  let changed = false;
  for (const part of rawParts) {
    const norm = cleanPrompt(part.content);
    if (norm !== part.content) changed = true;
    part.content = norm;
    if (!part.content) { changed = true; continue; }
    if (seen.has(part.content)) { changed = true; continue; }
    seen.add(part.content);
    parts.push(part);   // { content, weight, sepAfter }
  }

  const ownByContent = new Map(ownPrompts.map(p => [p.content.trim(), p]));
  const tplByContent = new Map(tplPrompts.map(p => [p.content.trim(), p]));
  const inText       = new Set(parts.map(p => p.content));

  // Create brand-new OWN prompts (parts that match neither an own nor a template prompt).
  for (const { content, weight } of parts) {
    if (ownByContent.has(content) || tplByContent.has(content)) continue;
    try {
      const r = await api.createPrompt(nodeId, { content, enabled: true, weight, order_index: 0, sep_after: 0 });
      const created = r?.prompt ?? { id: Date.now() + Math.random(), content, enabled: true, order_index: 0, weight, sep_after: 0 };
      ownPrompts.push(created);
      ownByContent.set(content, created);
    } catch (e) { console.error('[PLv2]', e); }
  }

  // Walk parts in order, assigning a UNIFIED position (idx) to own + template
  // prompts alike; template prompts persist via per-entry overrides.
  const ops = [];     // own prompt PATCHes
  const ov  = [];     // template override POSTs
  const seenTpl = new Set();
  let idx = 0;
  for (const { content, weight, sepAfter } of parts) {
    const tp = tplByContent.get(content);
    if (tp) {
      seenTpl.add(tp.id);
      const body = {};
      if (!tp.enabled)              { body.enabled = true; tp.enabled = true; }
      if (tp.order_index !== idx)   { body.order_index = idx; tp.order_index = idx; }
      if (Math.abs((tp.weight ?? 1) - weight) > 0.001) { body.weight = weight; tp.weight = weight; }
      // Persist the newline layout for an inherited prompt via its override (the only
      // per-entry storage it has) — otherwise a newline after a template prompt is lost.
      if ((tp.sep_after ?? 0) !== sepAfter) { body.sep_after = sepAfter; tp.sep_after = sepAfter; }
      if (Object.keys(body).length) ov.push(api.setOverride(nodeId, tp.id, body));
      idx++;
      continue;
    }
    const p = ownByContent.get(content);
    if (!p) continue;
    const upd = {};
    if (!p.enabled)              { upd.enabled = true;  p.enabled = true; }
    if (p.order_index !== idx)   { upd.order_index = idx; p.order_index = idx; }
    if (Math.abs((p.weight ?? 1) - weight) > 0.001) { upd.weight = weight; p.weight = weight; }
    if ((p.sep_after ?? 0) !== sepAfter) { upd.sep_after = sepAfter; p.sep_after = sepAfter; }
    if (Object.keys(upd).length) ops.push(api.updatePrompt(p.id, upd));
    idx++;
  }
  // Own prompts removed from the text → disable.
  for (const p of ownPrompts) {
    if (p.enabled && !inText.has(p.content.trim())) { p.enabled = false; ops.push(api.updatePrompt(p.id, { enabled: false })); }
  }
  // Template prompts removed from the text → disable via override.
  for (const tp of tplPrompts) {
    if (tp.enabled && !seenTpl.has(tp.id)) { tp.enabled = false; ov.push(api.setOverride(nodeId, tp.id, { enabled: false })); }
  }
  await Promise.all([...ops, ...ov]);

  return { changed };
}

// ─── Text rendering (raw_text view) ───────────────────────────────────────────
// The inverse of syncRawText's parse: render the enabled own + inherited template
// prompts into the editable text-box string, interleaved by the unified order_index,
// reproducing weights "(tag:1.2)" and the per-prompt trailing-newline layout
// (sep_after). Shared so an inline ref-expansion island shows EXACTLY what the entry
// detail text box shows.

function buildText({ ownPrompts, tplPrompts, delimiter }) {
  const enabled = [
    ...ownPrompts.filter(p => p.enabled).map(p => ({ content: p.content, weight: p.weight, order_index: p.order_index, sep_after: p.sep_after })),
    ...tplPrompts.filter(p => p.enabled).map(p => ({ content: p.content, weight: p.weight, order_index: p.order_index, sep_after: p.sep_after ?? 0 })),
  ].sort((a, b) => (a.order_index ?? 1e9) - (b.order_index ?? 1e9));
  const D = delimiter;
  const Dtrim = D.replace(/[ \t]+$/, '');   // drop trailing space before a newline
  let out = '';
  for (let i = 0; i < enabled.length; i++) {
    const p = enabled[i];
    const w = p.weight ?? 1.0;
    out += Math.abs(w - 1.0) < 0.001 ? p.content : `(${p.content}:${parseFloat(w.toFixed(2))})`;
    const sep = p.sep_after ?? 0;
    if (i < enabled.length - 1) out += sep > 0 ? Dtrim + '\n'.repeat(sep) : D;
    else if (sep > 0)           out += '\n'.repeat(sep);
  }
  return out;
}

// Choose a text box's initial content: prefer the stored raw layout, but fall back
// to a rebuild when it has drifted from the actual enabled prompts (e.g. a prompt was
// added elsewhere while this entry was closed).
function initialText({ rawText, ownPrompts, tplPrompts, delimiter, cleanPrompt }) {
  const raw = rawText || '';
  if (!raw) return buildText({ ownPrompts, tplPrompts, delimiter });
  const rawSet = new Set(
    raw.split(/\r?\n/).flatMap(l => l.split(delimiter))
       .map(s => s.trim()).filter(Boolean)
       .map(s => cleanPrompt(parsePromptPart(s).content)).filter(Boolean));
  const enabledSet = new Set([
    ...ownPrompts.filter(p => p.enabled).map(p => String(p.content).trim()),
    ...tplPrompts.filter(p => p.enabled).map(p => String(p.content).trim()),
  ]);
  const matches = rawSet.size === enabledSet.size && [...enabledSet].every(c => rawSet.has(c));
  return matches ? raw : buildText({ ownPrompts, tplPrompts, delimiter });
}

// Attach to the window.plv2 namespace as soon as it exists (load-order agnostic —
// window.plv2 is created at plv2.js module load, so this resolves immediately in
// practice; the retry only covers this file importing first).
(function attach() {
  if (window.plv2) { window.plv2.rawSync = { parsePromptPart, parseRawParts, syncRawText, buildText, initialText }; }
  else setTimeout(attach, 30);
})();
