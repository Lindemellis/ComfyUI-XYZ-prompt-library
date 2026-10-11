// Shared by TagAC's native and Monaco hosts. Syntax insertion is an ordinary
// source edit; browsing suggestions never imports triggers or creates a pool.
const cache = new Map();
export async function loraCompletions(text, caret, limit = 30, enabled = true) {
  const before = text.slice(0, caret), start = before.lastIndexOf('<');
  if (start < 0 || before.slice(start).includes('>')) return null;
  let quoted = false;
  for (let i = 0; i < start; i++) { if (before[i] === '\\') i++; else if (before[i] === '"') quoted = !quoted; }
  if (quoted || ((before.slice(0, start).match(/\\+$/)?.[0].length || 0) % 2)) return null;
  const fragment = before.slice(start + 1);
  const match = /^(?:lora:([^:<>\r\n]*))?$/i.exec(fragment);
  const prefix = !fragment || 'lora:'.startsWith(fragment.toLowerCase());
  if (!match && !prefix) return [];
  if (!enabled) return [];
  const query = match?.[1] || '';
  const key = `${limit}|${query.toLowerCase()}`, hit = cache.get(key);
  let items;
  if (hit && Date.now() - hit.at < 5000) items = hit.items;
  else {
    try {
      const response = await fetch('/xyz/plv4/loras/complete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, limit }) });
      if (!response.ok) return [];
      const data = await response.json(); if (!data.ok) return [];
      items = data.items || [];
      if (cache.size >= 100) cache.clear();
      cache.set(key, { at: Date.now(), items });
    } catch { return []; }
  }
  const tail = /^[^<>:\r\n]*(?:(:[-+\d.eE]+(?::[-+\d.eE]+)?))?>/.exec(text.slice(caret));
  const existing = /^<lora:[^<>:\r\n]*(?:(:[-+\d.eE]+(?::[-+\d.eE]+)?))?>/i.exec(text.slice(start));
  const end = existing ? start + existing[0].length : caret + (tail?.[0].length || 0), strengths = existing?.[1] || tail?.[1] || ':1';
  return items.map(item => ({ name: item.relative, kind: 'syntax', detail: 'LoRA', start, end, insertText: `<lora:${item.relative}${strengths}>` }));
}
