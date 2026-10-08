// Compact only actual single-child Folder chains. Hidden tags still stop a
// chain, and filtered views can veto compaction using the original children.
export function compactFolders(folder, childrenOf, allow = () => true) {
  const chain = [folder], seen = new Set([folder.id]);
  while (chain.at(-1).kind === 'folder') {
    const current = chain.at(-1), children = childrenOf(current) || [];
    if (children.length !== 1 || children[0].kind !== 'folder' || seen.has(children[0].id) || !allow(current, children[0])) break;
    seen.add(children[0].id); chain.push(children[0]);
  }
  return chain;
}
