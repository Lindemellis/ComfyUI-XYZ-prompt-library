"""Back up V3, then import a consistent snapshot into a separate V4 store.

No global V3 repo is replaced. Existing V4 assets are never overwritten. A repeat
of the same snapshot is a no-op; a changed source requires a new explicit import.
"""
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sqlite3
from urllib.parse import quote
import uuid

from .assets import store, save_block, bump, expand, encode, reusable, add_tag, tags, tag_key, name_snapshot, disambiguate_library_names
from ._v3 import DocNode, Document, render, compile_text
from .model import EditorState, CommandError

if '.' in __package__:
    from ..prompt_library_v3 import library as v3_library
else:
    from prompt_library_v3 import library as v3_library


def readonly(path):
    connection = sqlite3.connect(f'file:{quote(Path(path).resolve().as_posix(), safe="/:")}?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    return connection


class SnapshotReader:
    def __init__(self, path):
        connection = readonly(path)
        try:
            connection.execute('BEGIN')
            tables = {r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            if not {'folders', 'groups', 'items', 'presets'} <= tables: raise CommandError('invalid_v3', '不是 V3 Library 数据库')
            self.tables = {name: [dict(r) for r in connection.execute(f'SELECT * FROM {name} ORDER BY sort_index,id')] for name in ('folders', 'groups', 'items', 'presets', 'documents') if name in tables}
        finally: connection.close()
        self.groups = {r['id']: {**r, 'settings': json.loads(r['settings_json'] or '{}')} for r in self.tables['groups']}
        self.presets = {r['id']: {**r, 'body': json.loads(r['body_json'])} for r in self.tables['presets']}
        self.folders = {r['id']: r for r in self.tables['folders']}

    def get_group(self, gid): return self.groups.get(gid)
    def get_preset(self, pid): return self.presets.get(pid)
    def list_items(self, gid): return [r for r in self.tables['items'] if r['group_id'] == gid]
    def group_path(self, gid):
        names = []; group = self.groups[gid]; seen = set()
        while group:
            if group['id'] in seen: raise CommandError('reference_cycle', 'V3 子组形成环')
            seen.add(group['id']); names.append(group['name']); folder = group['folder_id']; group = self.groups.get(group['parent_group_id'])
        while folder:
            if ('folder', folder) in seen: raise CommandError('folder_cycle', 'V3 Folder 形成环')
            seen.add(('folder', folder)); value = self.folders[folder]; names.append(value['name']); folder = value['parent_id']
        return '.'.join(reversed(names))


def backup(source, directory):
    source = Path(source).resolve(); directory = Path(directory).resolve(); directory.mkdir(parents=True, exist_ok=True)
    if not source.is_file(): raise CommandError('missing_v3', 'V3 Library 尚不存在')
    target = directory / f'plv3-{datetime.now(timezone.utc):%Y%m%dT%H%M%S}-{uuid.uuid4().hex[:8]}.db'
    source_conn = readonly(source); target_conn = sqlite3.connect(target)
    try: source_conn.backup(target_conn)
    finally: target_conn.close(); source_conn.close()
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    return target, digest


@dataclass
class ImportOp:
    reader: SnapshotReader
    source_key: str
    digest: str
    backup_path: str

    def apply(self, conn):
        conn.execute('CREATE TABLE IF NOT EXISTS v3_imports(source_key TEXT PRIMARY KEY,digest TEXT NOT NULL,report_json TEXT NOT NULL)')
        existing = conn.execute('SELECT * FROM v3_imports WHERE source_key=?', (self.source_key,)).fetchone()
        if existing:
            if existing['digest'] != self.digest: raise CommandError('changed_v3', '此 V3 库已迁移且内容有变化；请保留原库与备份，使用新的 V4 库重新核对')
            return {**json.loads(existing['report_json']), 'repeated': True}
        counts_before = {r[0]: r[1] for r in conn.execute('SELECT kind,COUNT(*) FROM assets GROUP BY kind')}
        reader = self.reader; folder_ids, pool_ids, block_ids, preset_ids = {}, {}, {}, {}
        active = set()
        def folder(fid):
            if not fid: return None
            if fid in folder_ids: return folder_ids[fid]
            key = ('folder', fid)
            if key in active: raise CommandError('folder_cycle', 'V3 Folder 形成环')
            active.add(key); value = reader.folders[fid]
            result = store(conn, None, 'folder', value['name'], {}, folder(value['parent_id']))
            folder_ids[fid] = result; active.remove(key); return result
        for fid in reader.folders: folder(fid)
        # V3 groups and subgroups become containing Folder pools.
        def pool_folder(gid):
            if gid in pool_ids: return pool_ids[gid]
            key = ('placement', gid)
            if key in active: raise CommandError('reference_cycle', 'V3 子组形成环')
            active.add(key); value = reader.groups[gid]
            parent = pool_folder(value['parent_group_id']) if value['parent_group_id'] else folder(value['folder_id'])
            pool_ids[gid] = store(conn, None, 'folder', value['name'], {'autocomplete': False}, parent_id=parent)
            active.remove(key); return pool_ids[gid]
        for gid in reader.groups: pool_folder(gid)

        def make(gid, body=None, name=None, key=None):
            key = key or ('group', gid)
            cache = preset_ids if key[0] == 'preset' else block_ids
            if key in cache: return cache[key]
            if key in active: raise CommandError('reference_cycle', 'V3 引用形成环')
            active.add(key)
            items = reader.list_items(gid)
            ordered = v3_library._apply_whitelist(items, body.get('items') or []) if body is not None else list(items)
            selected = {item['id'] for item in ordered}
            all_items = [*ordered, *[item for item in items if item['id'] not in selected]]
            # Parse all rows to retain items omitted by a preset as parked nodes.
            full_body = {**(body or {}), 'items': [item['id'] for item in all_items]}
            full_body['children'] = {}
            for item in all_items:
                if item['kind'] == 'ref': full_body['children'][str(item['id'])] = {}
            source = v3_library.expand(gid, body=full_body, reader=reader)
            state = EditorState.create(text=source); state.check(); root = state.doc.root.children[0]
            root.meta['name'] = name or reader.groups[gid]['name']
            root.meta['pool'] = pool_ids[gid]
            offset = 0
            for item in all_items:
                if item['kind'] == 'ref' and item['ref_group_id']:
                    original = root.children[offset]; child_spec = (body or {}).get('children', {}).get(str(item['id']), {})
                    target_gid = int(item['ref_group_id']); target_body = None; target_key = None; target_name = None
                    if child_spec.get('mode') == 'preset':
                        preset = reader.get_preset(child_spec.get('preset_id'))
                        if preset and preset['group_id'] == target_gid: target_body, target_key, target_name = preset['body'], ('preset', preset['id']), preset['name']
                    elif child_spec.get('mode') == 'snapshot':
                        target_body = child_spec; target_key = ('snapshot', target_gid, hashlib.sha256(encode(child_spec).encode()).hexdigest())
                    child_copy = make(target_gid, target_body, target_name, target_key)
                    replacement = DocNode.from_json(deepcopy(child_copy['snapshot'])); replacement.sep = original.sep; replacement.enabled = item['id'] in selected
                    replacement.meta['legacy_item_id'] = item['id']; root.children[offset] = replacement; offset += 1
                else:
                    weights = (body or {}).get('weights', {})
                    raw = v3_library._item_text(item, weights.get(str(item['id'])))
                    count = len(EditorState.create(text=raw).doc.root.children)
                    for child in root.children[offset:offset + count]: child.enabled = item['id'] in selected; child.meta['legacy_item_id'] = item['id']
                    offset += count
            # Give every occurrence unique IDs after replacing shared children.
            for index, node in enumerate(root.walk(), 1): node.id = f'm{index}'
            state.doc.root.id = 'migration-root'
            state.check()
            expected = v3_library.expand(gid, body=body, reader=reader)
            for mode in ('couple', 'mask'):
                for plain in (False, True):
                    options = dict(seed=42, region_mode=mode, ignore_regions=plain, ignore_group_seeds=True)
                    if compile_text(render(state.doc), **options).text != compile_text(expected, **options).text:
                        raise CommandError('migration_mismatch', f'V3 组 {gid} 的迁移输出不一致')
            snapshot = root.to_json()
            asset_id = None
            if key[0] == 'preset' or (key[0] == 'group' and reader.groups[gid]['settings']):
                asset_id = save_block(conn, name_snapshot(snapshot, disambiguate=True), '全部内容' if key[0]=='group' else root.meta['name'], parent_id=pool_ids[gid])
                snapshot = expand(conn, asset_id)
            result = {'snapshot': snapshot, 'asset_id': asset_id}; cache[key] = result; active.remove(key)
            return result

        for gid in reader.groups: make(gid, name='全部内容')
        for pid, value in reader.presets.items(): make(value['group_id'], value['body'], value['name'], ('preset', pid))
        # Group items become loose tags on that group's Folder layer. Reference
        # items are already represented by child Folder/contained block snapshots.
        warnings = []
        for gid, pool_id in pool_ids.items():
            snapshot = block_ids[('group', gid)]['snapshot']
            for child in snapshot['children']:
                if child.get('meta', {}).get('pool') and child['meta']['pool'] != pool_id: continue
                for node in tags(DocNode.from_json(child)):
                    try: add_tag(conn, pool_id, node.to_json())
                    except CommandError as error:
                        if error.code != 'duplicate_tag': raise
                        warnings.append(str(error))
        documents = {}
        for value in reader.tables.get('documents', []):
            try: doc = Document.from_json(json.loads(value['doc_json'])) if value.get('doc_json') else EditorState.create(text=value['text']).doc
            except (ValueError, TypeError, KeyError, AttributeError): doc = EditorState.create(text=value['text']).doc
            doc.root.meta['compiler'] = 'plv4'
            documents[value['id']] = store(conn, None, 'document', value['name'], {'doc': doc.to_json()}, folder(value['folder_id']))
        warnings.extend(disambiguate_library_names(conn))
        bump(conn)
        added = {r[0]: r[1] - counts_before.get(r[0], 0) for r in conn.execute('SELECT kind,COUNT(*) FROM assets GROUP BY kind')}
        report = {'backup': self.backup_path, 'digest': self.digest, 'repeated': False,
                  'counts': {plural: added.get(kind, 0) for kind, plural in [('folder', 'folders'), ('tag', 'tags'), ('block', 'blocks'), ('document', 'documents')]},
                  'warnings': warnings, 'mapping': {'groups': {str(gid): {'folder': cid, **({'settings_block': block_ids[('group', gid)]['asset_id']} if block_ids[('group', gid)]['asset_id'] else {})} for gid, cid in pool_ids.items()}, 'presets': {str(key[1]): value['asset_id'] for key, value in preset_ids.items()}, 'documents': documents}}
        conn.execute('INSERT INTO v3_imports VALUES(?,?,?)', (self.source_key, self.digest, encode(report)))
        return report


def migrate(source, library, backup_directory=None):
    source = Path(source).resolve()
    if source == library.path.resolve(): raise CommandError('same_database', '迁移目标必须是独立 V4 库')
    saved, digest = backup(source, backup_directory or library.path.parent / 'backups')
    key = hashlib.sha256(str(source).casefold().encode()).hexdigest()
    return library.writer.enqueue(ImportOp(SnapshotReader(saved), key, digest, str(saved))).result()
