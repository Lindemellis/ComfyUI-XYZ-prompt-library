import { libraryRequest } from './asset_client.js';
import { indexTree } from './details.js';

let index = [], loading = null, generation = 0;
const textOf = node => node.kind !== 'group' || node.opaque ? node.raw : (node.open || '') + (node.lead || '') + (node.children || []).map(n => textOf(n) + (n.sep || '')).join('') + (node.close || '');

async function refresh() {
  const token = generation;
  const data = await libraryRequest('complete', { all_folders: true }); const next = [];
  const addPrompts = (node, source, folder, suggest) => {
    if (node.kind !== 'group' || node.form === 'paren' || node.opaque) {
      next.push({ name: textOf(node), kind: 'poolTag', snapshot: node, source, path: folder.path, folders: [folder], suggest }); return;
    }
    node.children?.forEach(child => { addPrompts(child, source, folder, suggest); });
  };
  const walk = (nodes, folder = null, suggest = false) => nodes.forEach(node => {
    if (node.kind === 'folder') walk(node.children, { id: node.id, path: node.name, open: () => window.xyzPLv4OpenFolder?.(node.id) }, suggest || node.autocomplete);
    else {
      addPrompts(node.snapshot, node.source, folder, suggest);
    }
  }); walk(data.candidates);
  if (token === generation) index = next;
  return index;
}

window.addEventListener('xyz-plv4-library-changed', () => { generation++; loading = null; });
// A manual Library refresh also sees writes made in another browser session.
window.addEventListener('xyz-plv4-library-index', () => { generation++; loading = null; });

export async function libraryMatches(query) {
  if (!loading) loading = refresh().catch(() => { loading = null; return []; });
  await loading;
  const needle = query.toLocaleLowerCase().replace(/_/g, ' '), matches = new Map();
  for (const value of index) {
    const key = value.name.toLocaleLowerCase().replace(/_/g, ' ');
    if (!key.includes(needle)) continue;
    const existing = matches.get(key);
    if (!existing) matches.set(key, { ...value, folders: [...value.folders] });
    else {
      if (value.suggest && !existing.suggest) Object.assign(existing, { snapshot: value.snapshot, source: value.source, path: value.path });
      existing.suggest ||= value.suggest;
      for (const folder of value.folders) if (!existing.folders.some(old => old.id === folder.id)) existing.folders.push(folder);
    }
  }
  return [...matches.values()].sort((a,b) => Number(b.suggest) - Number(a.suggest)).slice(0, 80);
}

function completionTarget(session, start, end) {
  const parent = session.parent || session;
  if (!session.valid || session.disposed || !parent.projection?.tree ||
      (session.parent && session.source !== parent.text)) return null;
  const base = session.parent ? (session.contentStart ?? session.range[0]) : 0;
  const a = session.sourceOffset ? session.sourceOffset(start) : start + base;
  const b = session.sourceOffset ? session.sourceOffset(end) : end + base;
  const rows = [...indexTree(parent.projection.tree).values()].filter(n => n.span && n.span[0] >= a && n.span[1] <= b);
  const target = rows.find(n => n.kind !== 'group' || n.form === 'paren');
  if (!target || rows.some(n => n.parent_id === target.parent_id && n.id !== target.id)) return null;
  return { parent, target, span: [a, b] };
}

export async function poolSuggestions(query, editor) {
  const session = editor.__plv4Pane?.editSession;
  if (!session?.valid) return [];
  return (await libraryMatches(query)).map(value => ({ ...value,
    canInsert: (start, end) => !!completionTarget(session, start, end),
    insert: async (start, end) => {
      const parent = session.parent || session; await parent.whenIdle();
      const match = completionTarget(session, start, end);
      // In-progress typing and stale candidates are ordinary editor states.
      // Decline them without interrupting input with an instructional toast.
      if (!match) return false;
      await parent.dispatch({ type: 'CompleteLibrary', id: match.target.id, span: match.span, snapshot: value.snapshot, source: value.source });
    },
  }));
}

window.xyzPLv4Suggestions = poolSuggestions;
window.xyzPLv4Memberships = libraryMatches;

window.xyzPLv4LibraryPaths = async model => {
  if (!model.__plv4Session) return [];
  const result = await libraryRequest('tree');
  return result.assets.filter(a => ['block', 'folder'].includes(a.kind)).map(a => ({ id: a.id, path: a.path, assetKind: a.kind, preset: null, v4: true }));
};

window.xyzPLv4ExpandReference = async (pane, asset) => {
  const session = pane.editSession;
  const model = pane.model(), position = pane.editor.getPosition();
  const line = model.getLineContent(position.lineNumber);
  const open = line.lastIndexOf('[', position.column - 1), close = line.indexOf(']', open);
  if (open < 0 || close < 0 || line.slice(open + 1, close) !== asset.path) throw new Error('请选择完整 Library 路径');
  const start = model.getOffsetAt({ lineNumber: position.lineNumber, column: open + 1 }), end = start + close - open + 1;
  await session.whenIdle(); const revision = session.revision;
  const source = await libraryRequest(asset.kind === 'folder' ? 'folder_block' : 'expand', { id: asset.id });
  if (pane.editSession !== session || pane.model() !== model) return;
  // TextRun sessions use offsets relative to their parent document.
  const parent = session.parent || session, base = session.parent ? session.range[0] : 0;
  const span = session.sourceOffset ? [session.sourceOffset(start), session.sourceOffset(end)] : [start + base, end + base];
  await parent.dispatch({ type: 'ExpandLibraryReference', span, path: asset.path, snapshot: source.snapshot, source: source.source }, revision);
};
