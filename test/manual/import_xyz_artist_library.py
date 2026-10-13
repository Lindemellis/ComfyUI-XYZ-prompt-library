"""Explicit artist-only V3 import; prepare/rehearse before live HTTP writes.

This personal import does not use the general V3-to-V4 migration or change its
contract. Live writes go through the running test Library's single writer.
"""
import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from prompt_library_v4.migrate_v3 import SnapshotReader, readonly
from prompt_library_v3.library import expand, _item_text
from prompt_library_v4.assets import AssetLibrary, reusable, tag_key, renumber, name_snapshot
from prompt_library_v4.model import EditorState
from prompt_library_v4.compiler import compile_document
from prompt_library_v4._v3 import DocNode, Document, compile_text


def dump(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')


def backup(source, destination):
    import sqlite3
    if Path(destination).exists():
        raise ValueError('Backup destination already exists')
    src = readonly(source)
    dst = sqlite3.connect(destination)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()


def logical_digest(path):
    conn = readonly(path)
    try:
        names = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        records = {name: sorted([list(r) for r in conn.execute('SELECT * FROM "' + name.replace('"', '""') + '"')], key=repr) for name in names}
        return hashlib.sha256(json.dumps(records, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    finally:
        conn.close()


def build_plan(source):
    reader = SnapshotReader(source)
    groups = [g for g in reader.groups.values() if reader.group_path(g['id']).split('.')[0] == 'artists']
    if not groups:
        raise ValueError('No artists subtree in this V3 snapshot')
    items = [item for g in groups for item in reader.list_items(g['id']) if item['kind'] != 'ref']
    pool_tags = {'artist': {}, 'tentacle': {}}
    for g in groups:
        pool = 'tentacle' if 'tentacle' in reader.group_path(g['id']).lower() else 'artist'
        for item in reader.list_items(g['id']):
            if item['kind'] == 'ref':
                if item['ref_group_id'] not in {group['id'] for group in groups}:
                    raise ValueError('Artist reference leaves the selected subtree')
                continue
            state = EditorState.create(text=_item_text(item))
            state.check()
            for node in state.doc.root.children:
                if reusable(node.to_json()):
                    raise ValueError('An artist tag contains a structural block')
                pool_tags[pool].setdefault(tag_key(node), node.to_json())
    # An ancestor-chain duplicate belongs in the more specific Class.
    for key in pool_tags['tentacle']:
        pool_tags['artist'].pop(key, None)

    blocks = []
    def make(g, body, name, preset_id=None, standalone_tentacle=False):
        text = expand(g['id'], body=body, reader=reader)
        state = EditorState.create(text=text)
        state.check()
        root = state.doc.root.children[0]
        for node in root.walk():
            if not node.enabled:
                raise ValueError('Unexpected disabled source content')
            if reusable(node.to_json()):
                tentacle = 'tentacle' in (node.header or '').lower()
                node.meta.update(name='tentacle' if tentacle else (node.header or 'Block').rsplit('.', 1)[-1], pool='$tentacle' if tentacle else '$artist')
        if standalone_tentacle:
            wrapper = EditorState.create(text='{}').doc.root.children[0]
            wrapper.children = [root]
            root.sep = ''
            root = wrapper
        root.meta.update(name=name, pool='$artist', import_v3={'group_id': g['id'], 'preset_id': preset_id, 'path': reader.group_path(g['id']), 'weight_memory': (body or {}).get('weight_memory', {})})
        renumber(root)
        folder = 'novelai' if '.NAI.' in reader.group_path(g['id']) else 'illustrious' if g['name'] == 'illustrious' else 'anima'
        blocks.append({'name': name, 'folder': folder, 'snapshot': name_snapshot(root.to_json()), 'expected_source': text})

    for g in groups:
        is_tentacle = 'tentacle' in reader.group_path(g['id']).lower()
        if not is_tentacle:
            make(g, None, g['name'])
        for preset in reader.presets.values():
            if preset['group_id'] != g['id']:
                continue
            name = 'tentacle-' + preset['name'] if is_tentacle else g['name'] + '-' + preset['name'] if '.NAI.' in reader.group_path(g['id']) else preset['name']
            make(g, preset['body'], name, preset['id'], is_tentacle)
    return {'source': str(Path(source).resolve()), 'source_digest': logical_digest(source), 'source_groups': [{'id':g['id'], 'path':reader.group_path(g['id'])} for g in groups], 'source_prompt_rows':len(items), 'tags':{kind:list(tags.values()) for kind,tags in pool_tags.items()}, 'blocks':blocks}


def state_for(snapshot):
    root = DocNode('validation-root', 'group', '', opaque=False, children=[DocNode.from_json(snapshot)], form='root')
    return EditorState.create(doc=Document(root).to_json())


def check_block(snapshot, expected):
    state = state_for(snapshot)
    if any(not n.enabled for n in state.doc.root.walk()):
        raise AssertionError('Imported Block has disabled content')
    for seed in (0, 42):
        for mode in ('couple', 'mask'):
            result = compile_document(state, seed=seed, region_mode=mode)
            for name, plain in (('prompt', False), ('plain', True)):
                before = compile_text(expected, seed=seed, region_mode=mode, ignore_regions=plain, ignore_group_seeds=True, centralize_loras=True).text
                if result[name] != before:
                    raise AssertionError('Imported compilation differs: ' + name)


def install(plan, mutate, read, staging_name):
    ids = {}
    def save(key, kind, name, parent=None, **extra):
        value = mutate({'action':'save_' + kind, 'name':name, 'parent_id':ids.get(parent), **extra})['asset']
        ids[key] = value['id']
        return value
    save('folder', 'folder', staging_name)
    save('artist', 'class', 'artist', 'folder', data={'autocomplete':True})
    save('tentacle', 'class', 'tentacle', 'artist', data={'autocomplete':True})
    for key in ('anima', 'illustrious', 'novelai'):
        save(key, 'folder', key, 'folder')
    for key in ('tentacle', 'artist'):
        for snapshot in plan['tags'][key]:
            mutate({'action':'save_tag', 'parent_id':ids[key], 'snapshot':snapshot})
    saved = []
    for block in plan['blocks']:
        snapshot = deepcopy(block['snapshot'])
        def bind(node):
            if node.get('meta', {}).get('pool') in ('$artist', '$tentacle'):
                node['meta']['pool'] = ids[node['meta']['pool'][1:]]
            for child in node.get('children', []):
                bind(child)
        bind(snapshot)
        value = save('block:' + block['folder'] + ':' + block['name'], 'block', block['name'], block['folder'], snapshot=snapshot)
        expanded = read('expand', id=value['id'])['snapshot']
        check_block(expanded, block['expected_source'])
        state = state_for(expanded)
        for node in state.doc.root.walk():
            if reusable(node.to_json()) and node.form != 'root':
                expected_pool = ids['tentacle'] if node.meta.get('name') == 'tentacle' else ids['artist']
                if node.meta.get('pool') != expected_pool:
                    raise AssertionError('Incorrect Block binding')
        saved.append({'id':value['id'], 'folder':block['folder'], 'name':block['name']})
    return {'ids':ids, 'blocks':saved, 'tags':{key:len(tags) for key,tags in plan['tags'].items()}, 'compile_comparisons':len(saved)*8}


def prepare(source, test_db, output):
    output = Path(output).resolve()
    output.mkdir(parents=True, exist_ok=False)
    for original, name in ((source, 'plv3-source.db'), (test_db, 'test-before.db')):
        backup(original, output / name)
    plan = build_plan(output / 'plv3-source.db')
    plan.update(original_source=str(Path(source).resolve()), original_source_digest=logical_digest(source), test_before_digest=logical_digest(test_db))
    dump(output / 'plan.json', plan)
    backup(output / 'test-before.db', output / 'rehearsal.db')
    library = AssetLibrary(output / 'rehearsal.db')
    try:
        result = install(plan, library.mutate, library.read, 'artist-import-rehearsal')
        dump(output / 'rehearsal.json', result)
    finally:
        library.close()
    print(json.dumps({'output':str(output), 'groups':len(plan['source_groups']), 'blocks':len(plan['blocks']), 'tags':result['tags'], 'compile_comparisons':result['compile_comparisons']}, ensure_ascii=False))


def apply(output, url):
    if url.rstrip('/') != 'http://127.0.0.1:8190':
        raise ValueError('This import is authorized for the persistent test instance only')
    output = Path(output).resolve()
    if (output / 'live-journal.json').exists():
        raise ValueError('An application journal already exists; inspect it before retrying')
    plan = json.loads((output / 'plan.json').read_text(encoding='utf-8'))
    if logical_digest(plan['original_source']) != plan['original_source_digest']:
        raise ValueError('V3 source changed since preparation')
    journal = []
    def request(operation, body):
        data = json.dumps(body, ensure_ascii=False).encode()
        value = json.load(urlopen(Request(url + '/xyz/plv4/library/' + operation, data=data, headers={'Content-Type':'application/json'}), timeout=30))
        if not value.get('ok'):
            raise ValueError(value)
        return value
    def mutate(body):
        value = request('mutate', body)
        journal.append({'request':body, 'id':value.get('id'), 'revision':value['revision']})
        dump(output / 'live-journal.json', journal)
        return value
    def read(action, **extra):
        return request('read', {'action':action, **extra})
    before = read('tree')
    if before.get('legacy_pools'):
        raise ValueError('Target still uses old Folder pools')
    roots = [a for a in before['assets'] if a['parent_id'] is None]
    original = next((a for a in roots if a['kind']=='folder' and a['name']=='artist'), None)
    if any(a['name']=='artist-测试示例' for a in roots):
        raise ValueError('The retained sample destination already exists')
    result = install(plan, mutate, read, 'artist-import-' + output.name)
    if original:
        mutate({'action':'rename', 'id':original['id'], 'version':original['version'], 'name':'artist-测试示例'})
    root = request('read', {'action':'get', 'id':result['ids']['folder']})
    mutate({'action':'rename', 'id':root['id'], 'version':root['version'], 'name':'artist'})
    result['retained_sample_id'] = original['id'] if original else None
    dump(output / 'live-result.json', result)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest='command', required=True)
    prep = sub.add_parser('prepare')
    prep.add_argument('source', type=Path)
    prep.add_argument('test_db', type=Path)
    prep.add_argument('output', type=Path)
    live = sub.add_parser('apply')
    live.add_argument('output', type=Path)
    live.add_argument('--url', default='http://127.0.0.1:8190')
    args = parser.parse_args()
    if args.command == 'prepare':
        prepare(args.source, args.test_db, args.output)
    else:
        apply(args.output, args.url)
