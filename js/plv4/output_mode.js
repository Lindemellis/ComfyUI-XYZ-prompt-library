// Output choices are part of each Document snapshot, never global preferences.
export function outputOptions(host) {
  let meta = host?.context?.session?.state.doc.root.meta || {};
  if ((host?.folderContext || host?.context?.asset) && host.seedNode) {
    try { meta = JSON.parse(host.seedNode.widgets?.find(w => w.name === 'doc')?.value || '{}').root?.meta || meta; } catch {}
  }
  return meta;
}
export const isMoss = host => outputOptions(host).output_mode === 'moss';
export const containerForms = host => isMoss(host) ? [] : ['region', 'schedule', 'avg'];

// MOSS block structure (mirrors prompt_library_v4/output_policy.py). The top level
// holds ordinary blocks, region blocks and the [@moss] line; a region holds
// ordinary blocks. Only a block directly at one of those levels picks a type.
export const MOSS_FIELDS = { root: ['caption', 'meta', 'palette'], moss_region: ['caption', 'tag', 'palette', 'text'] };
export const FIELD_LABELS = { caption: 'Caption', meta: 'Meta', palette: 'Palette', tag: 'Tag', text: 'Text' };
export const FORM_LABELS = { moss_region: 'Region block', region: 'Region 容器', schedule: 'Schedule 容器', avg: 'AVG 容器' };
const ordinary = form => ['brace', 'implicit'].includes(form);

// The types a block standing in `parent` may pick ([] = it inherits its type).
export function fieldsAt(parent) {
  if (parent?.form === 'root') return MOSS_FIELDS.root;
  if (parent?.form === 'moss_region') return MOSS_FIELDS.moss_region.filter(field => field !== 'text' || parent.moss_type === 'text');
  return [];
}

// May a block of `form` (with `field`, its own type) stand directly in `parent`?
export function mossAllows(parent, form, field = null) {
  if (!parent || parent.form === 'moss') return false;
  if (form === 'moss_region') return parent.form === 'root';
  if (!ordinary(form)) return false;
  return !field || fieldsAt(parent).includes(field);
}

// The typed blocks offered at `parent` (the ordinary block is offered separately).
export function insertForms(host, parent, map, canInsertContainer) {
  if (isMoss(host)) return parent?.form === 'root' ? ['moss_region'] : [];
  return containerForms(host).filter(form => canInsertContainer(parent, form, map));
}
export const plainAllowed = (host, parent) => !isMoss(host) || mossAllows(parent, 'brace');
