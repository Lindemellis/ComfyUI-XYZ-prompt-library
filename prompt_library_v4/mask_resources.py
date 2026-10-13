"""V4-only resource adapter. The shared language/compiler never reads assets."""
from copy import deepcopy
import hashlib
import json

from .mask_images import SIZE, composite, extract, rectangle, png_url
from .mask_library import current
from .model import CommandError, EditorState, full_index

BUNDLE_SCHEMA = 'xyz.plv4.mask-bundle'


def region_value(doc, node_id):
    _, index = full_index(doc)
    value = index[node_id].settings.region
    if value is None: return None
    return {key: deepcopy(getattr(value, key)) for key in ('kind', 'mask', 'imask', 'feather', 'mask_weight', 'cond_weight', 'include_in_base')}


def signature(value):
    if not value: return None
    # Older references stored raw pointer floats while SetRegion wrote .12g.
    # Compare their expected projection at the actual V4 writer precision.
    from .commands import _number
    return (value['kind'], tuple(float(_number(v)) for v in value.get('mask') or ()) if value['kind'] == 'mask' else value.get('imask') if value['kind'] == 'imask' else None)


def detach_changed(doc):
    if not any(node.meta.get('mask_library') for node in doc.root.walk()): return
    _, index = full_index(doc)
    for node in doc.root.walk():
        ref = node.meta.get('mask_library')
        if not ref: continue
        value = getattr(getattr(index[node.id], 'settings', None), 'region', None)
        actual = None if value is None else (value.kind, tuple(value.mask or ()) if value.kind == 'mask' else value.imask if value.kind == 'imask' else None)
        if actual != signature(ref.get('projection')):
            node.meta.pop('mask_library', None)


def _set_region(state, node_id, value):
    from .commands import apply_command
    state = apply_command(state, dict(type='SetRegion', id=node_id, region=value, revision=state.revision, resource_update=True))
    return state


def resolve(state, library=None, *, binding_id=None):
    state.check()
    original_revision = state.revision
    state = deepcopy(state)
    items, keys, images, diagnostics = [], {}, {}, []
    _, index = full_index(state.doc)
    rows = []
    def visit(node, active=True, regional=True):
        active = active and node.enabled
        regional = regional and not (node.form == 'region' and node.meta.get('region_enabled') is False)
        region = getattr(getattr(index[node.id], 'settings', None), 'region', None)
        if region and (regional or node.id == binding_id): rows.append((node.id, active and regional))
        for child in node.children: visit(child, active, regional)
    visit(state.doc.root)
    referenced = {node_id for node_id, _ in rows}
    library = (library or current()) if any(n.id in referenced and n.meta.get('mask_library') for n in state.doc.root.walk()) else None
    snap = library.snapshot() if library else dict(canvases=[], tombstones={}, directories=[])
    canvases = {canvas['id']: canvas for canvas in snap['canvases']}
    picture_index = 0
    for node_id, active in rows:
        node = next(n for n in state.doc.root.walk() if n.id == node_id)
        value = region_value(state.doc, node_id)
        ref = deepcopy(node.meta.get('mask_library'))
        canvas = canvases.get(ref.get('canvas_id')) if ref else None
        try:
            item = None
            if ref and ref['kind'] == 'rectangle':
                mask = next((m for m in (canvas or {}).get('masks', []) if m['id'] == ref['mask_id']), None) if canvas and not canvas['deleted'] else None
                deleted = not mask
                mask = mask or snap['tombstones'].get((ref['canvas_id'], ref['mask_id'])) or ref.get('fallback')
                if not mask: raise ValueError('The rectangle is missing and has no retained coordinates.')
                value.update(kind='mask', mask=mask['coordinates'], imask=None)
                ref.update(fallback=deepcopy(mask), version=canvas['version'] if canvas else ref.get('version', 0), projection=deepcopy(value))
                state = _set_region(state, node_id, value)
                node = next(n for n in state.doc.root.walk() if n.id == node_id)
                ref['projection'] = region_value(state.doc, node_id)
                ref['canvas_name'] = canvas['name'] if canvas else ref.get('canvas_name', '')
                if deleted: node.meta.pop('mask_library', None)
                else: node.meta['mask_library'] = ref
                item = dict(key=f"rectangle:{ref['canvas_id']}:{ref['mask_id']}", kind='rectangle', canvas_id=ref['canvas_id'], mask_id=ref['mask_id'], label=mask['name'], color=mask['color'], coordinates=mask['coordinates'], version=ref['version'], mask=rectangle(mask['coordinates']))
            elif ref and ref['kind'] == 'picture':
                source = canvas if canvas and not canvas['deleted'] else ref.get('fallback')
                if not source or not library: raise ValueError('The image is missing. Relocate the input file.')
                # Read bytes once per source within the consistent execution snapshot.
                image_key = (source['path'], json.dumps(source['settings'], sort_keys=True))
                if image_key not in images:
                    images[image_key] = extract(library.path_for(source['path'], snap['directories']).read_bytes(), source['settings'])
                image = images[image_key]
                mask = image['masks'].get(ref['mask_id'])
                if mask is None: raise ValueError('The referenced alpha or RGB mask no longer exists. Choose another mask.')
                key = f"picture:{ref['canvas_id']}:{ref['mask_id']}"
                expected = keys[key]['expected_imask'] if key in keys else picture_index
                if active and key not in keys: picture_index += 1
                value.update(kind='imask', imask=expected, mask=None)
                state = _set_region(state, node_id, value)
                node = next(n for n in state.doc.root.walk() if n.id == node_id)
                ref.update(fallback={k: deepcopy(source[k]) for k in ('path', 'settings', 'name')}, version=canvas['version'] if canvas else ref.get('version', 0), fingerprint=image['fingerprint'], projection=deepcopy(value))
                ref['projection'] = region_value(state.doc, node_id)
                ref['canvas_name'] = source['name']
                ref['fallback']['presentation'] = deepcopy(source.get('presentation', {}))
                node.meta['mask_library'] = ref
                presentation = source.get('presentation', {}).get(ref['mask_id'], {})
                item = dict(key=key, kind='picture', canvas_id=ref['canvas_id'], mask_id=ref['mask_id'], label=source['name'] + ' · ' + presentation.get('name', ref['mask_id']), color=presentation.get('color', ref.get('color', '#75a5df')), path=source['path'], settings=source['settings'], version=ref['version'], fingerprint=image['fingerprint'], expected_imask=expected, mask=mask)
            elif value['kind'] == 'mask':
                item = dict(key=f"document:{state.doc.root.meta.get('owner', state.doc.root.id)}:{node_id}", kind='rectangle', label=node.meta.get('name', node_id), color='#75a5df', coordinates=value['mask'], mask=rectangle(value['mask']))
            if active and item and item['key'] not in keys:
                keys[item['key']] = item; items.append(item)
        except (ValueError, OSError) as exc:
            diagnostics.append(dict(id=node_id, error=str(exc), active=active))
            if active: raise CommandError('missing_mask_resource', f'{node.meta.get("name", node_id)}: {exc}') from exc
    state.revision = original_revision
    bundle = dict(schema=BUNDLE_SCHEMA, version=1, width=SIZE, height=SIZE, document=state.doc.root.meta.get('owner', state.doc.root.id), revision=original_revision, items=items)
    return state, bundle, diagnostics


def metadata(bundle):
    return {key: deepcopy(value) for key, value in bundle.items() if key != 'items'} | dict(items=[{key: deepcopy(value) for key, value in item.items() if key != 'mask'} for item in bundle['items']])


def preview(state, library=None):
    state, bundle, diagnostics = resolve(state, library)
    summary = metadata(bundle)
    for row, item in zip(summary['items'], bundle['items']): row['preview'] = png_url(item['mask'])
    return dict(ok=True, state=state.to_json(), bundle=summary, preview=png_url(composite(bundle['items'])), diagnostics=diagnostics)


def fingerprint(state, library=None):
    _, bundle, _ = resolve(state, library)
    return hashlib.sha256(json.dumps(metadata(bundle), sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def binding_command(state, command):
    """Bind/unbind is one existing Document command/history transaction."""
    node = next((n for n in state.doc.root.walk() if n.id == command['id']), None)
    if not node: raise CommandError('unknown_node', 'The region was removed.')
    value = region_value(state.doc, node.id)
    if not value: raise CommandError('invalid_mask_reference', 'Select a mask or imask region.')
    if command['type'] == 'UnbindMaskLibrary':
        ref = node.meta.pop('mask_library', None)
        if ref and ref['kind'] == 'picture': value.update(kind='imask', imask=ref.get('manual_imask', 0), mask=None)
        return _set_region(state, node.id, value)
    library = current()
    if not library: raise CommandError('mask_library_unavailable', 'Mask Library is unavailable.')
    canvas = next((c for c in library.snapshot()['canvases'] if c['id'] == command['canvas_id'] and not c['deleted']), None)
    if not canvas: raise CommandError('invalid_mask_reference', 'The canvas was removed.')
    if value['kind'] != ('mask' if canvas['kind'] == 'rectangle' else 'imask'):
        raise CommandError('invalid_mask_reference', 'The canvas type does not match the region.')
    if canvas['kind'] == 'rectangle' and not any(m['id'] == command['mask_id'] for m in canvas['masks']):
        raise CommandError('invalid_mask_reference', 'The rectangle was removed.')
    if canvas['kind'] == 'picture':
        image = extract(library.path_for(canvas['path']).read_bytes(), canvas['settings'])
        if command['mask_id'] not in image['masks']:
            raise CommandError('missing_mask_resource', 'The selected extraction mask does not exist.')
    from .mask_library import color
    preview_color = color(command.get('color', '#75a5df'))
    node.meta['mask_library'] = dict(kind=canvas['kind'], canvas_id=canvas['id'], mask_id=command['mask_id'], manual_imask=node.meta.get('mask_library', {}).get('manual_imask', value.get('imask') or 0), color=preview_color)
    # Resolve validates the actual ID and creates a trusted fallback snapshot.
    result, _, _ = resolve(state, library, binding_id=node.id)
    return result
