"""Repair and extend ONLY the isolated, converted Folder-pool acceptance copies.

The Class-era originals and personal libraries are never written. Existing
converted copies receive a dated backup before the explicitly requested update.
"""
from copy import deepcopy
from datetime import datetime
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from prompt_library_v4.assets import AssetLibrary, disambiguate_library_names, bump, encode, renumber, block_name, reusable
from prompt_library_v4.hierarchy import set_header
from prompt_library_v4.model import EditorState
from prompt_library_v4._v3 import Document, DocNode, render
from prompt_library_v4.compiler import compile_document
from prompt_library_v4.migrate_v3 import readonly
ROOT = Path(__file__).resolve().parents[5] / 'XYZNodes-Test'


class RepairNames:
    def apply(self, conn):
        warnings = disambiguate_library_names(conn); bump(conn); return warnings


def add_examples(library, parent_id):
    def asset(kind, name, parent, **body):
        existing = next((a for a in library.read()['assets'] if a['kind'] == kind and a['name'] == name and a['parent_id'] == parent), None)
        if existing: return library.read('get', id=existing['id'])
        return library.mutate({'action': 'save_' + kind, 'name': name, 'parent_id': parent, **body})['asset']
    demo = asset('folder', '05-池绑定示例', parent_id, data={'autocomplete': False})
    artist = asset('folder', '画师池', demo['id'], data={'autocomplete': True})
    thick = asset('folder', '厚涂', artist['id'], data={'autocomplete': False})
    accessories = asset('folder', '配饰池', demo['id'], data={'autocomplete': True})
    for folder, texts in [(artist, ['artist_alpha', 'artist_beta']), (thick, ['painterly', 'brush strokes']), (accessories, ['earrings', 'bow', 'hair ornament'])]:
        for text in texts:
            if not any(a['kind'] == 'tag' and a['parent_id'] == folder['id'] and a['name'] == text for a in library.read()['assets']):
                library.mutate({'action': 'save_tag', 'parent_id': folder['id'], 'text': text})
    root = EditorState.create(text='{ artist_alpha, { painterly }, { soft lighting }, { earrings, bow } }').doc.root.children[0]
    root.meta.update(pool=artist['id'])
    root.children[1].meta.update(name='厚涂子 block（独立绑定）', pool=thick['id'])
    root.children[2].meta.update(name='未绑定子 block（由父池收录）')
    root.children[3].meta.update(name='配饰子 block（独立绑定）', pool=accessories['id'])
    root.children[3].children[1].enabled = False
    combo = asset('block', '画师组合（绑定画师池）', demo['id'], snapshot=root.to_json())
    accessory_node = EditorState.create(text='{ earrings, hair ornament }').doc.root.children[0]
    accessory_node.meta['pool'] = accessories['id']
    accessory_combo = asset('block', '配饰组合（绑定配饰池）', demo['id'], snapshot=accessory_node.to_json())
    doc = EditorState.create(text='').doc
    doc.root.children = [DocNode.from_json(library.read('expand', id=a['id'])['snapshot']) for a in [combo, accessory_combo]]
    doc.root.children[0].sep = ', '
    renumber(doc.root); doc.next_id = len(list(doc.root.walk())) + 1
    doc.root.meta['compiler'] = 'plv4'
    text = render(doc)
    return {'title': '05 · Folder 绑定、候选与子 block 收录', 'type': 'XYZ Prompt Library V4', 'doc': doc.to_json(), 'text': text}, {
        'pool_demo': demo['id'], 'artist_pool': artist['id'], 'thick_pool': thick['id'], 'accessory_pool': accessories['id'],
        'bound_artist_combo': combo['id'], 'bound_accessory_combo': accessory_combo['id'],
    }


def refresh_labels(value, assets):
    """Refresh labels by source ID, never replace or reorder prompt content."""
    if isinstance(value, str) and value.lstrip().startswith(('{', '[')):
        try: parsed = json.loads(value)
        except ValueError: return value
        return encode(refresh_labels(parsed, assets)) if isinstance(parsed, (dict, list)) else value
    if isinstance(value, list): return [refresh_labels(item, assets) for item in value]
    if not isinstance(value, dict): return value
    value = {key: refresh_labels(item, assets) for key, item in value.items()}
    source = value.get('meta', {}).get('source', {})
    asset = assets.get(source.get('id'))
    if asset and value.get('kind') == 'group' and asset['kind'] == 'block':
        def relabel_children(node, parent_path):
            for child in node.get('children', []):
                meta = child.get('meta', {}); path = parent_path
                if meta.get('source'): continue  # Already refreshed independently by ID.
                if reusable(child) and meta.get('full_path'):
                    path = parent_path + '.' + block_name(child); set_header(child, path)
                relabel_children(child, path)
        relabel_children(value, asset['path'])
        source.update(version=asset['version'], path=asset['path'])
        value['meta']['name'] = asset['name']; set_header(value, asset['path'])
    return value


def update_samples(root=ROOT):
    root = Path(root).resolve()
    if root != ROOT.resolve(): raise ValueError('Only the isolated XYZNodes-Test root is authorized')
    pack = root / 'custom_nodes/ComfyUI-XYZNodes/prompt_library_v4_data'
    target = pack / 'plv4-pools.db'
    manifest_path = root / 'sample-content-pools.json'
    workflow_path = root / 'XYZNodes-PLv4-Folder池示例.json'
    installed = root / 'user/default/workflows/XYZNodes-PLv4-Folder池示例.json'
    original_paths = [pack / 'plv4.db', root / 'sample-content.json', root / 'XYZNodes-PLv4-验收示例.json', root / 'user/default/workflows/XYZNodes-PLv4-验收示例.json']
    originals = {path: path.read_bytes() for path in original_paths}
    manifest = json.loads(manifest_path.read_text(encoding='utf-8-sig'))
    workflow = json.loads(workflow_path.read_text(encoding='utf-8-sig'))
    prior = deepcopy(manifest['samples'])
    backup = root / 'pool-example-backups' / datetime.now().strftime('%Y%m%d-%H%M%S-%f'); backup.mkdir(parents=True)
    source = readonly(target); destination = sqlite3.connect(backup / target.name)
    try: source.backup(destination)
    finally: source.close(); destination.close()
    for path in [manifest_path, workflow_path, installed]: (backup / (path.name if path != installed else 'installed-workflow.json')).write_bytes(path.read_bytes())
    library = AssetLibrary(target)
    try:
        warnings = library.writer.enqueue(RepairNames()).result()
        parent = next(a['id'] for a in library.read()['assets'] if a['kind'] == 'folder' and a['name'] == '验收示例' and not a['parent_id'])
        sample, keys = add_examples(library, parent)
        assets = {a['id']: a for a in library.read()['assets']}
        for old in manifest['samples']:
            old['doc'] = refresh_labels(old['doc'], assets); old['text'] = render(Document.from_json(old['doc']))
        if not any(s['title'] == sample['title'] for s in manifest['samples']): manifest['samples'].append(sample)
        manifest['key_assets'].update(keys); manifest['assets'] = list(assets.values())
        for node in workflow['nodes']:
            if not node['type'].startswith('XYZ Prompt Library V4'): continue
            values = node['widgets_values']
            for index, value in enumerate(values):
                if not isinstance(value, str): continue
                try: doc = json.loads(value)
                except ValueError: continue
                if isinstance(doc, dict) and 'root' in doc:
                    doc = refresh_labels(doc, assets); values[index] = encode(doc); values[0] = render(Document.from_json(doc))
            node['properties'] = refresh_labels(node.get('properties', {}), assets)
            if isinstance(node['properties'].get('doc'), str):
                node['properties']['text'] = render(Document.from_json(json.loads(node['properties']['doc'])))
        if not any(n.get('title') == sample['title'] for n in workflow['nodes']):
            node = deepcopy(next(n for n in workflow['nodes'] if n['type'] == sample['type']))
            node['id'] = max(n['id'] for n in workflow['nodes']) + 1; node['title'] = sample['title']; node['pos'] = [430, 1120]
            node['order'] = len(workflow['nodes'])
            for port in node.get('inputs', []): port['link'] = None
            for port in node.get('outputs', []): port['links'] = None
            node['widgets_values'] = [sample['text'], 123456, 'fixed', 'couple', encode(sample['doc'])]
            node['properties'].pop('text', None); node['properties'].pop('doc', None)
            workflow['nodes'].append(node); workflow['last_node_id'] = node['id']
        manifest['pool_examples_update'] = {'backup': str(backup), 'name_repairs': warnings, 'key_assets': keys}
        comparisons = 0
        for before, after in zip(prior, manifest['samples']):
            for mode in ['couple', 'mask']:
                for seed in [0, 42, 123456]:
                    a = compile_document(EditorState.create(doc=before['doc']), seed=seed, region_mode=mode)
                    b = compile_document(EditorState.create(doc=after['doc']), seed=seed, region_mode=mode)
                    assert (a['prompt'], a['plain']) == (b['prompt'], b['plain']); comparisons += 1
        for mode in ['couple', 'mask']: compile_document(EditorState.create(doc=sample['doc']), seed=123456, region_mode=mode)
        for a in assets.values():
            if a['kind'] == 'block':
                assert library.read('resolve', path=a['path'])['id'] == a['id']
                library.read('expand', id=a['id'])
    finally: library.close()
    for path, value in [(manifest_path, manifest), (workflow_path, workflow), (installed, workflow)]:
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    assert all(path.read_bytes() == content for path, content in originals.items()), 'Original samples changed'
    return {'backup': str(backup), 'name_repairs': warnings, 'comparisons': comparisons, 'demo_path': '验收示例.05-池绑定示例', 'key_assets': keys}


if __name__ == '__main__': print(json.dumps(update_samples(), ensure_ascii=False, indent=2))
