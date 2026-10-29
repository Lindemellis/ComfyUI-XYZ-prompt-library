import { documentRequest, SessionError } from './document_session.js';

export async function libraryRequest(action, body = {}, mutation = false) {
  const response = await fetch(`/xyz/plv4/library/${mutation ? 'mutate' : 'read'}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, action }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new SessionError(result.code, result.error || 'Library 操作失败');
  if (mutation && result.library_changed !== false) window.dispatchEvent(new CustomEvent('xyz-plv4-library-changed', { detail: result.revision }));
  return result;
}

function associated(node) {
  return !!node.meta?.pool || (node.children || []).some(associated);
}
const hasPaths = node => !!node.header || (node.children || []).some(hasPaths);

// Only commands which can affect pool tags need a Library transaction.
// Compilation always stays on the pure document endpoint.
export async function libraryDocumentRequest(operation, body) {
  if (operation !== 'command') return documentRequest(operation, body);
  // These commands introduce no pool tag identities or unresolved paths.
  // Deleted observation rows were never removed by observe; parked tags are
  // already included in the baseline. Keep them off the Library writer.
  if (['LocateDetails', 'SetEnabled', 'SetContentEnabled', 'Delete'].includes(body.command.type)) return documentRequest(operation, body);
  const command = body.command;
  // Block controls change the group's header, never its atomic pool tags.
  // Attention parentheses are themselves tags, so their weights still collect
  // through the Library path (as do SetPromptSettings and all content edits).
  const find = node => node.id === command.id ? node : node.children?.map(find).find(Boolean);
  const target = command.type === 'SetSettings' ? find(body.state.doc.root) : null;
  const blockSettings = target?.kind === 'group' && !target.opaque && target.form !== 'paren' &&
    Object.keys(command.patch || {}).every(key => ['weight', 'schedule', 'region_window', 'region', 'format', 'shuffle', 'random_select', 'dropout'].includes(key));
  if (blockSettings || ['SetAvgWeight', 'SetScheduleBoundary', 'SetRegionEnabled'].includes(command.type)) return documentRequest(operation, body);
  const emptyBlock = command.type === 'InsertBlock' && !command.snapshot &&
    (command.form ? ['schedule', 'region', 'avg'].includes(command.form) : !command.text || /^\s*\{\s*\}\s*$/.test(command.text));
  const emptyEntry = command.type === 'InsertEntry' && !command.snapshot && !command.text && !command.form;
  if (emptyBlock || emptyEntry) return documentRequest(operation, body);
  if (body.command.defer_pool && !body.library_asset_id) return documentRequest(operation, body);
  const owner = body.state.doc.root.meta?.owner;
  if (body.command.type === 'SaveLibrary') return libraryRequest('save_instance', { ...body, owner }, true);
  if (body.library_asset_id || hasPaths(body.state.doc.root) || associated(body.state.doc.root) || Object.hasOwn(body.command.patch || {}, 'pool') || associated(body.command.snapshot || {}) || body.command.type === 'ExpandLibraryReference') {
    return libraryRequest('edit', { ...body, owner }, true);
  }
  return documentRequest(operation, body);
}

libraryDocumentRequest.flush = body => associated(body.state.doc.root) || hasPaths(body.state.doc.root) ? libraryRequest('sync_pool', { ...body, owner: body.state.doc.root.meta.owner }, true) : null;
libraryDocumentRequest.observe = session => session.valid && associated(session.state.doc.root) ? libraryRequest('observe', { state: session.state, owner: session.state.doc.root.meta.owner }, true) : null;

export function ensureOwner(session) {
  session.state.doc.root.meta ??= {};
  session.state.doc.root.meta.owner ??= crypto.randomUUID();
}

export function libraryContextRequest(id) {
  const request = (operation, body) => libraryDocumentRequest(operation, { ...body, library_asset_id: id });
  request.flush = body => libraryRequest('sync_pool', { ...body, owner: body.state.doc.root.meta.owner, library_asset_id: id }, true);
  request.observe = libraryDocumentRequest.observe;
  return request;
}
