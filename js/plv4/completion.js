import { libraryRequest } from './asset_client.js';
import { indexTree } from './details.js';

let index = [], loading = null, generation = 0;
const textOf = node => node.kind !== 'group' || node.opaque ? node.raw : (node.open || '') + (node.lead || '') + (node.children || []).map(n => textOf(n) + (n.sep || '')).join('') + (node.close || '');

async function refresh() {
  const token = generation;
  const data = await libraryRequest('complete'); const next = [];
  const addPrompts = (node, source, path) => {
    if (node.kind !== 'group' || node.form === 'paren' || node.opaque) {
      next.push({ name: textOf(node), kind: 'poolTag', snapshot: node, source, path }); return;
    }
    node.children?.forEach(child => { addPrompts(child, source, path); });
  };
  const walk = (nodes, path = []) => nodes.forEach(node => {
    if (node.kind === 'folder') walk(node.children, [...path, node.name]);
    else {
      addPrompts(node.snapshot, node.source, path.join(' / '));
    }
  }); walk(data.candidates);
  if (token === generation) index = next;
  return index;
}

window.addEventListener('xyz-plv4-library-changed', () => { generation++; loading = null; });
// A manual Library refresh also sees writes made in another browser session.
window.addEventListener('xyz-plv4-library-index', () => { generation++; loading = null; });

export async function poolSuggestions(query, editor) {
  const pane = editor.__plv4Pane; const session = pane?.editSession;
  if (!session?.valid) return [];
  if (!loading) loading = refresh().catch(() => { loading = null; return []; });
  await loading;
  const needle = query.toLocaleLowerCase().replace(/_/g, ' '); const seen = new Set();
  return index.filter(value => {
    const key = value.kind === 'poolBlock' ? JSON.stringify([value.source, value.path]) : value.name;
    if (seen.has(key) || !value.name.toLocaleLowerCase().replace(/_/g, ' ').includes(needle)) return false;
    seen.add(key); return true;
  }).slice(0, 40).map(value => ({ ...value, insert: async (start, end) => {
    const parent = session.parent || session; await parent.whenIdle();
    const base = session.parent ? (session.contentStart ?? session.range[0]) : 0;
    const a = session.sourceOffset ? session.sourceOffset(start) : start + base, b = session.sourceOffset ? session.sourceOffset(end) : end + base;
    const rows = [...indexTree(parent.projection.tree).values()].filter(n => n.span && n.span[0] >= a && n.span[1] <= b);
    const target = rows.find(n => n.kind !== 'group' || n.form === 'paren');
    if (!target || rows.some(n => n.parent_id === target.parent_id && n.id !== target.id)) throw new Error('请在一条完整 prompt 上使用 池补全');
    await parent.dispatch({ type: 'CompleteLibrary', id: target.id, span: [a, b], snapshot: value.snapshot, source: value.source });
  } }));
}

window.xyzPLv4Suggestions = poolSuggestions;

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
