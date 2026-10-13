// Compact only actual single-child Folder chains. Hidden tags still stop a
// chain, and filtered views can veto compaction using the original children.
const alphabetical = new Intl.Collator('en', { sensitivity: 'base', ignorePunctuation: true });
export const compareNames = (a, b) => alphabetical.compare(a.name || '', b.name || '');

export function compactFolders(folder, childrenOf, allow = () => true) {
  const chain = [folder], seen = new Set([folder.id]);
  while (['folder','class'].includes(chain.at(-1).kind)) {
    const current = chain.at(-1), children = childrenOf(current) || [];
    if (children.length !== 1 || children[0].kind !== current.kind || seen.has(children[0].id) || !allow(current, children[0])) break;
    seen.add(children[0].id); chain.push(children[0]);
  }
  return chain;
}
