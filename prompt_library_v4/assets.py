"""Folder storage, Class pools and block copies. Writes use one transaction."""
from __future__ import annotations
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
import hashlib
import json
import uuid
import sqlite3
from urllib.parse import quote
from ._v3 import DocNode, Document, render
from .model import CommandError, EditorState, full_document, projection, refresh_document, normalise_metadata
from .commands import apply_command, text_edit
from .hierarchy import UNSET, asset_path, ancestors, placement_check, set_header, legacy_pools, pool_asset
from .lora_triggers import trigger_groups
if '.' in __package__:
    from ..prompt_shared.storage import WriteQueue, connect_read
else:
    from prompt_shared.storage import WriteQueue, connect_read

def encode(value): return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
def identity(): return uuid.uuid4().hex

def validate_snapshot(snapshot):
    node = DocNode.from_json(snapshot)
    if node.kind != 'group' or node.form == 'paren':
        raise CommandError('invalid_asset', 'SavedBlock 必须是完整 block')
    if node.form in ('schedule_entry', 'region_entry', 'avg_entry'):
        raise CommandError('entry_asset', 'entry 不能单独保存，请保存完整容器')
    doc = Document(DocNode('asset-root', 'group', '', opaque=False, children=[node], form='root'))
    normalise_metadata(doc)
    ids = [n.id for n in doc.root.walk()]
    if len(ids) != len(set(ids)):
        raise CommandError('invalid_asset', 'block 实例 ID 重复')
    state = EditorState.create(doc=doc.to_json(), scope='block')
    state.check()
    # Also validate parked descendants before committing the snapshot.
    EditorState.create(text=render(full_document(doc)), scope='block').check()
    return node.to_json()


def reusable(snapshot):
    return snapshot['kind'] == 'group' and snapshot.get('form') not in ('paren', 'schedule_entry', 'region_entry', 'avg_entry') and snapshot.get('meta', {}).get('presentation') != 'prompt'


def block_name(node):
    meta = node.meta if isinstance(node,DocNode) else node.get('meta',{})
    header = node.header if isinstance(node,DocNode) else node.get('header')
    if meta.get('name'): return meta['name']
    # A previously generated full path is not a local child name. Otherwise
    # saving an expanded snapshot turns Root.Block into Root.Root.Block.
    if header and meta.get('full_path') == header: return header.rsplit('.',1)[-1]
    return header or 'Block'


def check_name(name):
    if not str(name).strip() or any(c in name for c in '[]\\\n\r') or name.startswith('@'):
        raise CommandError('invalid_name', '名称不能为空或包含方括号、反斜线、换行，不能以 @ 开头')


def name_snapshot(snapshot, disambiguate=False):
    """Assign distinct names to unnamed children; explicit sibling clashes fail.

    Special entry scaffolding has no Library row, so children across entries
    share the enclosing container's namespace. Conversion alone may suffix
    explicit legacy names, while retaining every content node and ID.
    """
    def visible(nodes):
        return [part for node in nodes for part in ([node] if reusable(node) else visible(node.get('children', [])))]
    def visit(parent):
        children = visible(parent.get('children', [])); occupied = set()
        explicit = lambda child: child.get('meta', {}).get('name') or (child.get('header') if child.get('header') != child.get('meta', {}).get('full_path') else None)
        for child in children:
            name = explicit(child)
            if name:
                check_name(name)
                if name in occupied and not disambiguate: raise CommandError('duplicate_name', f'同一父级已有名称“{name}”')
                occupied.add(name)
        assigned = set()
        for child in children:
            meta = child.setdefault('meta', {}); original = str(block_name(child)).strip(); name = original
            if disambiguate or not explicit(child):
                index = 2
                while name in assigned or (not explicit(child) and name in occupied):
                    name = f'{original} {index}'; index += 1
            check_name(name); meta['name'] = name; assigned.add(name); visit(child)
    visit(snapshot)
    return snapshot


def names_check(conn):
    siblings, paths = {}, {}
    for asset in catalog(conn):
        if asset['kind'] not in ('folder', 'class', 'block'): continue
        name = asset['name']; check_name(name)
        key = (asset['parent_id'], name)
        if key in siblings or asset['path'] in paths:
            raise CommandError('duplicate_name', f'Library 已有同名对象或完整路径：{asset["path"]}')
        siblings[key] = asset['id']; paths[asset['path']] = asset['id']


def disambiguate_library_names(conn):
    """Explicit copy conversion only. Never run while opening a user's library."""
    warnings = []
    for value in list(conn.execute("SELECT id,data_json FROM assets WHERE kind='block'")):
        data = json.loads(value['data_json']); before = encode(data)
        name_snapshot(data['snapshot'], disambiguate=True)
        if encode(data) != before:
            conn.execute('UPDATE assets SET data_json=?,version=version+1 WHERE id=?', (encode(data), value['id']))
    while True:
        siblings, paths = set(), set(); conflict = None
        for asset in catalog(conn):
            if asset['kind'] not in ('folder', 'class', 'block'): continue
            key = (asset['parent_id'], asset['name'])
            if key in siblings or asset['path'] in paths: conflict = asset; break
            siblings.add(key); paths.add(asset['path'])
        if conflict is None: break
        original = conflict['name']; index = 2; name = f'{original} {index}'
        namespace = {(a['parent_id'], a['name']) for a in catalog(conn) if a['kind'] in ('folder', 'class', 'block')}
        full_paths = {a['path'] for a in catalog(conn) if a['kind'] in ('folder', 'class', 'block')}
        prefix = conflict['path'][:-len(original)]
        while (conflict['parent_id'], name) in namespace or prefix + name in full_paths:
            index += 1; name = f'{original} {index}'
        if conflict.get('owner_id'):
            owner = row(conn, conflict['owner_id']); data = owner['data']
            target = next(n for n in DocNode.from_json(data['snapshot']).walk() if n.id == conflict['node_id'])
            def rename(node):
                if node['id'] == target.id: node.setdefault('meta', {})['name'] = name
                for child in node.get('children', []): rename(child)
            rename(data['snapshot']); owner_id = owner['id']
        else:
            owner_id = conflict['id']; data = conflict['data']
            if conflict['kind'] == 'block': data['snapshot'].setdefault('meta', {})['name'] = name
            conn.execute('UPDATE assets SET name=? WHERE id=?', (name, owner_id))
        conn.execute('UPDATE assets SET data_json=?,version=version+1 WHERE id=?', (encode(data), owner_id))
        warnings.append(f'副本路径去重：{conflict["path"]} → {name}')
    names_check(conn)
    return warnings


def tags(node, stop_pools=False):
    """Atomic prompt nodes, including parked content; structural wrappers stay out."""
    if node.meta.get('lora_invocation'): return
    if node.kind != 'group' or node.opaque or node.form == 'paren':
        if render(node).strip(): yield node
        return
    for child in node.children:
        if stop_pools and child.meta.get('pool'): continue
        yield from tags(child, stop_pools)


def tag_key(node):
    # Item identity includes attention/LoRA, but not its placement delimiter.
    value = deepcopy(node); value.enabled = True; value.sep = ''
    return render(value).strip()


def tag_snapshot(snapshot):
    node = DocNode.from_json(snapshot)
    text = tag_key(node)
    parsed = EditorState.create(text=text); parsed.check()
    if len(parsed.doc.root.children) != 1 or reusable(parsed.doc.root.children[0].to_json()):
        raise CommandError('invalid_tag', '请输入一条 tag，结构请保存为 block')
    return parsed.doc.root.children[0].to_json()


def row(conn, entity_id, kind=None):
    # Embedded blocks have addressable views, never independent database rows.
    if '/' in entity_id:
        owner_id, node_id = entity_id.split('/', 1); owner = row(conn, owner_id, 'block')
        root = DocNode.from_json(owner['data']['snapshot']); chain = []
        def find(node, parents):
            if node.id == node_id: return node, parents
            for child in node.children:
                found = find(child, [*parents, node])
                if found: return found
        found = find(root, [])
        if not found or not reusable(found[0].to_json()): raise CommandError('missing_asset', '子 block 不存在')
        node, chain = found
        names = [block_name(n) for n in [*chain[1:], node] if reusable(n.to_json())]
        visible_parent = next(n for n in reversed(chain) if reusable(n.to_json()))
        parent_id = owner_id if visible_parent is root else owner_id + '/' + visible_parent.id
        value = {**owner, 'id': entity_id, 'name': names[-1], 'parent_id': parent_id,
                 'owner_id': owner_id, 'node_id': node_id, 'path': '.'.join([owner['path'], *names]), 'data': {'snapshot': node.to_json()}}
    else:
        found = conn.execute('SELECT * FROM assets WHERE id=?', (entity_id,)).fetchone()
        if found is None: raise CommandError('missing_asset', 'Library 对象不存在')
        value = dict(found); value['data'] = json.loads(value.pop('data_json')); value['path'] = asset_path(conn, entity_id)
    if kind and value['kind'] != kind: raise CommandError('missing_asset', 'Library 对象类型不符')
    return value


def catalog(conn):
    for record in conn.execute('SELECT id FROM assets ORDER BY position,id'):
        asset = row(conn, record['id'])
        yield asset
        if asset['kind']=='block':
            for node in list(DocNode.from_json(asset['data']['snapshot']).walk())[1:]:
                if reusable(node.to_json()): yield row(conn, asset['id']+'/'+node.id)


@dataclass
class SchemaOp:
    def apply(self, conn):
        conn.execute('CREATE TABLE IF NOT EXISTS library_meta(revision INTEGER NOT NULL)')
        existing = conn.execute("SELECT sql FROM sqlite_master WHERE name='assets'").fetchone()
        conn.execute('CREATE TABLE IF NOT EXISTS library_structure(version INTEGER NOT NULL)')
        if not conn.execute('SELECT 1 FROM library_structure').fetchone():
            old = bool(existing and conn.execute('SELECT 1 FROM assets').fetchone())
            conn.execute('INSERT INTO library_structure VALUES(?)', (1 if old else 2,))
        schema = "CREATE TABLE {table}(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('folder','class','tag','block','document')),name TEXT NOT NULL,parent_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,position INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,data_json TEXT NOT NULL)"
        if existing and "'class'" not in existing['sql']:
            # Extend the CHECK without changing data. Deferred DROP bookkeeping
            # is cleared only after checking every real foreign key explicitly.
            indexes = [r['sql'] for r in conn.execute("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='assets' AND sql IS NOT NULL")]
            conn.execute('PRAGMA defer_foreign_keys=ON')
            conn.execute(schema.format(table='assets_new'))
            conn.execute('INSERT INTO assets_new SELECT * FROM assets')
            conn.execute('DROP TABLE assets')
            conn.execute('ALTER TABLE assets_new RENAME TO assets')
            for statement in indexes: conn.execute(statement)
            if conn.execute('PRAGMA foreign_key_check').fetchone(): raise CommandError('invalid_library', 'Library 外键检查失败')
            conn.execute('PRAGMA defer_foreign_keys=OFF')
        elif not existing:
            conn.execute(schema.format(table='assets'))
        conn.execute('CREATE INDEX IF NOT EXISTS assets_parent ON assets(parent_id,position)')
        conn.execute('CREATE TABLE IF NOT EXISTS pool_observations(owner TEXT NOT NULL,node_id TEXT NOT NULL,pool TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(owner,node_id,pool))')
        if not conn.execute('SELECT 1 FROM library_meta').fetchone(): conn.execute('INSERT INTO library_meta VALUES(0)')


def bump(conn): conn.execute('UPDATE library_meta SET revision=revision+1')


def store(conn, asset_id, kind, name, data, folder_id=None, expected=None, parent_id=UNSET):
    name = str(name).strip()
    if not name or (kind != 'tag' and (any(c in name for c in '[]\\\n\r') or name.startswith('@'))):
        raise CommandError('invalid_name', '名称不能为空或包含方括号、反斜线、换行，不能以 @ 开头')
    previous = row(conn, asset_id, kind) if asset_id else None
    if previous and expected != previous['version']: raise CommandError('asset_conflict', '来源已变化，请重新读取')
    if parent_id is UNSET: parent_id = previous['parent_id'] if previous else folder_id
    if parent_id: row(conn, parent_id) # placement_check owns type rules
    if kind == 'tag' and not parent_id: raise CommandError('invalid_parent', '散装 prompt 必须放在 Class 中')
    if previous:
        conn.execute('UPDATE assets SET name=?,data_json=?,parent_id=?,version=version+1 WHERE id=?', (name, encode(data), parent_id, asset_id))
    else:
        asset_id = identity()
        conn.execute('INSERT INTO assets(id,kind,name,parent_id,position,data_json) VALUES(?,?,?,?,?,?)', (asset_id,kind,name,parent_id,conn.execute('SELECT COALESCE(MAX(position),-1)+1 FROM assets').fetchone()[0],encode(data)))
    placement_check(conn)
    return asset_id


def save_block(conn, snapshot, name, folder_id=None, asset_id=None, expected=None, parent_id=UNSET):
    name = str(name).strip()
    snapshot = deepcopy(snapshot); snapshot.setdefault('meta', {})['name'] = str(name).strip()
    snapshot = validate_snapshot(name_snapshot(snapshot))
    for part in DocNode.from_json(snapshot).walk():
        if part.meta.get('association') or part.meta.get('class_saved'):
            raise CommandError('legacy_metadata', '旧关联请先通过副本转换工具转换')
    if asset_id and '/' in asset_id:
        selected = row(conn, asset_id, 'block'); owner = row(conn, selected['owner_id'], 'block')
        if expected != owner['version']: raise CommandError('asset_conflict', '父 block 已变化')
        root = DocNode.from_json(owner['data']['snapshot'])
        target = next(n for n in root.walk() if n.id == selected['node_id'])
        replacement = DocNode.from_json(snapshot); replacement.id = target.id; replacement.sep = target.sep
        occupied = {n.id for n in root.walk() if n.id not in {p.id for p in target.walk()}}
        occupied.add(replacement.id)
        for part in list(replacement.walk())[1:]:
            if part.id in occupied: part.id = identity()
            occupied.add(part.id)
        replacement.meta['name'] = name
        target.__dict__.update(replacement.__dict__)
        save_block(conn, root.to_json(), owner['name'], asset_id=owner['id'], expected=expected)
        return asset_id
    snapshot.setdefault('meta', {}).pop('source', None)
    snapshot['meta']['name'] = name
    return store(conn, asset_id, 'block', name, {'snapshot': snapshot}, folder_id, expected, parent_id)


def renumber(node):
    for index, part in enumerate(node.walk(), 1): part.id = f'i{index}'


def expand(conn, asset_id, versions=None):
    asset = row(conn, asset_id, 'block'); result = deepcopy(asset['data']['snapshot'])
    result.setdefault('meta', {})['name'] = asset['name']
    result['meta']['source'] = {'kind':'block','id':asset_id,'version':asset['version'],'path':asset['path']}
    def paths(node, path):
        if reusable(node): set_header(node, path)
        for child in node.get('children', []):
            child_path = path + '.' + block_name(child) if reusable(child) else path
            paths(child, child_path)
    paths(result, asset['path'])
    if versions is not None: versions[asset_id] = asset['version']
    return result


def descendants(conn, folder_id):
    kind = pool_asset(conn, folder_id)['kind']
    return {r[0] for r in conn.execute('WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT a.id FROM assets a JOIN tree t ON a.parent_id=t.id WHERE a.kind=?) SELECT id FROM tree', (folder_id, kind))}


def pool_keys(conn, folder_id):
    folders = descendants(conn, folder_id); result = set()
    for value in conn.execute("SELECT parent_id,data_json FROM assets WHERE kind='tag'"):
        if value['parent_id'] in folders:
            result.update(tag_key(n) for n in tags(DocNode.from_json(json.loads(value['data_json'])['snapshot'])))
    return result


def add_tag(conn, folder_id, snapshot, asset_id=None, expected=None, automatic=False):
    pool_asset(conn, folder_id); snapshot = tag_snapshot(snapshot); key = tag_key(DocNode.from_json(snapshot))
    if asset_id and row(conn, asset_id, 'tag')['version'] != expected: raise CommandError('asset_conflict', 'tag 已变化')
    existing = [dict(r) for r in conn.execute("SELECT * FROM assets WHERE kind='tag' AND id IS NOT ?", (asset_id,)) if tag_key(DocNode.from_json(json.loads(r['data_json'])['snapshot'])) == key]
    subtree = descendants(conn, folder_id)
    conflict = next((r for r in existing if r['parent_id'] in subtree), None)
    if conflict: raise CommandError('duplicate_tag', f'已在 {asset_path(conn, conflict["parent_id"])} 中')
    if automatic and key in pool_keys(conn, folder_id): return None
    chain = ancestors(conn, folder_id)[1:]
    ancestor = next((r for r in existing if r['parent_id'] in chain), None)
    if ancestor:
        if asset_id: conn.execute('DELETE FROM assets WHERE id=?',(asset_id,))
        return store(conn, ancestor['id'], 'tag', key, {'snapshot':snapshot}, expected=ancestor['version'], parent_id=folder_id)
    return store(conn, asset_id, 'tag', key, {'snapshot':snapshot}, expected=expected, parent_id=folder_id)


def loose_check(conn):
    seen = []
    for value in conn.execute("SELECT id,parent_id,data_json FROM assets WHERE kind='tag'"):
        key = tag_key(DocNode.from_json(json.loads(value['data_json'])['snapshot']))
        lineage = set(ancestors(conn, value['parent_id']))
        for other, parent, chain in seen:
            if key == other and (parent in lineage or value['parent_id'] in chain):
                raise CommandError('duplicate_tag', '移动后同一祖先链出现重复 tag，请先整理')
        seen.append((key, value['parent_id'], lineage))


def move_into_block(conn, previous, destination, expected):
    """Move contained content atomically; no new pointer or shared child asset."""
    source_id = previous.get('owner_id', previous['id'])
    destination_id = destination.get('owner_id', destination['id'])
    source = row(conn, source_id, 'block'); dest = row(conn, destination_id, 'block')
    if expected != dest['version']: raise CommandError('asset_conflict', '目标 block 已变化')
    source_root = DocNode.from_json(source['data']['snapshot'])
    target = next(n for n in source_root.walk() if n.id == previous['node_id']) if previous.get('node_id') else source_root
    if source_id == destination_id:
        if not previous.get('node_id') or destination.get('node_id') in {n.id for n in target.walk()}:
            raise CommandError('placement_cycle', '不能移入自己或自己的后代')
        dest_root = source_root
    else: dest_root = DocNode.from_json(dest['data']['snapshot'])
    if previous.get('node_id'):
        next(n for n in source_root.walk() if target in n.children).children.remove(target)
    selected = next(n for n in dest_root.walk() if n.id == destination['node_id']) if destination.get('node_id') else dest_root
    if selected.form in ('schedule','region','avg'):
        if not selected.children: raise CommandError('invalid_parent', '请先创建 entry')
        selected = selected.children[-1]
    if source_id != destination_id:
        used = {n.id for n in dest_root.walk()}
        for part in target.walk():
            if part.id in used: part.id = identity()
            used.add(part.id)
    target.meta['name'] = previous['name']; target.sep = ', '; selected.children.append(target)
    save_block(conn, dest_root.to_json(), dest['name'], asset_id=dest['id'], expected=dest['version'])
    if source_id != destination_id:
        if previous.get('node_id'): save_block(conn, source_root.to_json(), source['name'], asset_id=source['id'], expected=source['version'])
        else: conn.execute('DELETE FROM assets WHERE id=?', (source['id'],))
    return dest['id'] + '/' + target.id


def folder_block(conn, folder_id, fill=False, recursive=False):
    pool_asset(conn, folder_id); asset = row(conn, folder_id)
    node = EditorState.create(text='{ }').doc.root.children[0]
    node.meta = {'name':asset['name'], 'pool':folder_id}
    if fill:
        seen = set()
        def collect(pool_id):
            for value in conn.execute("SELECT id,kind,data_json FROM assets WHERE parent_id=? ORDER BY position,id",(pool_id,)):
                if recursive and value['kind'] in ('class', 'folder'):
                    collect(value['id'])
                elif value['kind'] == 'tag':
                    child = DocNode.from_json(json.loads(value['data_json'])['snapshot'])
                    key = tag_key(child)
                    if recursive and key in seen: continue
                    seen.add(key)
                    child.enabled = True; child.sep = ', '; node.children.append(child)
        collect(folder_id)
    renumber(node); set_header_dict = set_header(node.to_json(), asset['path'])
    return {'snapshot':set_header_dict, 'source':{'kind':'class','id':folder_id,'version':asset['version'],'path':asset['path']}}


def bind_paths(conn, state):
    if not state.valid: return
    pending = [node for node in state.doc.root.walk()
               if node.form not in ('schedule', 'region', 'avg') and not node.meta.get('lora')
               and node.header and not node.meta.get('source') and not node.meta.get('pool')
               and node.meta.get('full_path') != node.header]
    if not pending: return
    lookup = {}
    for asset in catalog(conn):
        if asset['kind'] in ('class','block') or (asset['kind']=='folder' and legacy_pools(conn)): lookup.setdefault(asset['path'],[]).append(asset)
    for node in pending:
        matches = lookup.get(node.header, [])
        if len(matches)>1: raise CommandError('ambiguous_path', 'Library 路径不唯一')
        if matches:
            target = matches[0]
            if target['kind'] in ('folder','class'): node.meta['pool']=target['id']
            else: node.meta['source']={'kind':'block','id':target['id'],'version':target['version'],'path':node.header}


def observe(conn, state, owner, collect=False, suppress=False):
    if not isinstance(owner,str) or not owner: raise CommandError('invalid_owner', '需要稳定文档身份')
    changed = False
    for block in state.doc.root.walk():
        if block.form in ('schedule', 'region', 'avg'): continue
        pool = block.meta.get('pool')
        if not pool: continue
        # A portable or deleted pool never prevents editing/compilation.
        value = conn.execute('SELECT kind FROM assets WHERE id=?', (pool,)).fetchone()
        if not value or (value['kind'] != 'class' and not (value['kind']=='folder' and legacy_pools(conn))): continue
        known = None
        for node in tags(block, stop_pools=True):
            key = tag_key(node); digest = hashlib.sha256(key.encode()).hexdigest()
            found = conn.execute('SELECT fingerprint FROM pool_observations WHERE owner=? AND node_id=? AND pool=?',(owner,node.id,pool)).fetchone()
            if found and found[0] == digest: continue
            if collect and not suppress:
                if known is None: known = pool_keys(conn, pool)
                if key not in known:
                    changed = bool(add_tag(conn,pool,node.to_json(),automatic=True)) or changed
                    known.add(key)
            conn.execute('INSERT OR REPLACE INTO pool_observations VALUES(?,?,?,?)',(owner,node.id,pool,digest))
    return changed


@dataclass
class MutationOp:
    body: dict
    def apply(self, conn):
        body=self.body; action=body['action']; response={}; asset_id=None
        library_changed = action not in ('edit', 'sync_pool', 'observe')
        if legacy_pools(conn) and action in ('save_class', 'ensure_lora'):
            raise CommandError('library_upgrade_required', '请先在 Library 菜单执行“转换旧 Folder 池”，备份后再使用 Class')
        if action=='save_block':
            asset_id=save_block(conn,body['snapshot'],body['name'],body.get('folder_id'),body.get('id'),body.get('version'),body.get('parent_id',UNSET))
        elif action=='ensure_lora':
            lora = body['lora']
            if not isinstance(lora, dict) or not isinstance(lora.get('id'), str) or len(lora['id']) != 64:
                raise CommandError('invalid_lora', '无效 LoRA 身份')
            existing = next((asset for asset in catalog(conn) if asset['kind'] == 'class' and asset['data'].get('lora', {}).get('id') == lora['id']), None)
            if existing:
                asset_id = existing['id']
            else:
                name = 'LoRA · ' + ''.join(char if char not in '[]\\\n\r' else '_' for char in str(lora.get('name', 'LoRA'))) + ' (' + lora['id'][:12] + ')'
                asset_id = store(conn, None, 'class', name, {'autocomplete': False, 'lora': deepcopy(lora)})
            if not existing or body.get('import_triggers') or body.get('regroup_existing'):
                groups = trigger_groups(body.get('triggers', []))
                allowed = None
                if existing and body.get('regroup_existing') and not body.get('import_triggers'):
                    # Explicit repair of old flat imports only. Never refill a
                    # deleted tag, touch an already grouped pool or move custom
                    # edits whose wording no longer matches source metadata.
                    children = [child for child in catalog(conn) if child['parent_id'] == asset_id]
                    if any(child['kind'] == 'class' and child['data'].get('lora_trigger_group') for child in children):
                        groups = []
                    allowed = {tag_key(DocNode.from_json(child['data']['snapshot'])) for child in children if child['kind'] == 'tag'}
                    groups = [group for group in groups if group['key']]
                for group in groups:
                    items = {key: item for key, item in group['nodes'].items() if allowed is None or key in allowed}
                    if not items: continue
                    destination = asset_id
                    if group['key']:
                        marker = {'lora_id': lora['id'], 'key': group['key']}
                        children = [child for child in catalog(conn) if child['parent_id'] == asset_id]
                        matched = next((child for child in children if child['kind'] == 'class' and child['data'].get('lora_trigger_group') == marker), None)
                        if matched:
                            destination = matched['id']
                        else:
                            occupied = {child['name'] for child in children if child['kind'] in ('folder', 'class', 'block')}
                            name, suffix = group['name'], 2
                            while name in occupied:
                                name = f'{group["name"]} {suffix}'; suffix += 1
                            destination = store(conn, None, 'class', name, {'autocomplete': False, 'lora_trigger_group': marker}, parent_id=asset_id)
                    present = pool_keys(conn, destination)
                    for key, item in items.items():
                        if key not in present:
                            add_tag(conn, destination, item.to_json(), automatic=True)
                            present.add(key)
        elif action=='save_tag':
            snapshot=body.get('snapshot')
            if snapshot is None:
                parsed=EditorState.create(text=body.get('text',body.get('name',''))); parsed.check()
                snapshots=[node.to_json() for node in parsed.doc.root.children]
                if not snapshots: raise CommandError('invalid_tag','请输入 tag')
            else: snapshots=[snapshot]
            # The shared PLv3 parse owns commas/sentences and nested attention;
            # never store a pasted list as one opaque tag. One transaction keeps
            # edits and chain-dedupe failures from leaving a partially split row.
            saved=[]
            for index, snapshot in enumerate(snapshots):
                saved.append(add_tag(conn,body.get('parent_id') or body.get('folder_id'),snapshot,body.get('id') if index==0 else None,body.get('version') if index==0 else None))
            asset_id=saved[0]
            response['assets']=[row(conn,ident) for ident in saved]
        elif action in ('save_folder','save_class','save_document'):
            kind=action[5:]; data=body.get('data',{})
            if kind=='class' or (kind=='folder' and legacy_pools(conn)):
                data={'autocomplete':bool(data.get('autocomplete',False))}
                previous = row(conn, body['id'], kind) if body.get('id') else None
                if previous and previous['data'].get('lora'): data['lora'] = previous['data']['lora']
                if previous and previous['data'].get('lora_trigger_group'): data['lora_trigger_group'] = previous['data']['lora_trigger_group']
            elif kind=='folder': data={}
            else: EditorState.create(doc=data['doc']).check()
            asset_id=store(conn,body.get('id'),kind,body['name'],data,body.get('folder_id'),body.get('version'),body.get('parent_id',UNSET))
        elif action=='create_block':
            parent= row(conn,body['parent_id']) if body.get('parent_id') else None
            node=EditorState.create(text='{ }').doc.root.children[0]; node.meta['name']=body['name']
            if parent and parent['kind']=='block':
                if parent['version']!=body.get('version'): raise CommandError('asset_conflict','父 block 已变化')
                whole=DocNode.from_json(parent['data']['snapshot']); node.sep=', '
                target=whole
                if whole.form in ('region','schedule','avg'):
                    if not whole.children: raise CommandError('invalid_parent','请先创建 entry')
                    target=whole.children[-1]
                for part in node.walk(): part.id=identity()
                target.children.append(node)
                asset_id=save_block(conn,whole.to_json(),parent['name'],asset_id=parent['id'],expected=body['version'])
            else: asset_id=save_block(conn,node.to_json(),body['name'],parent_id=body.get('parent_id'))
        elif action in ('rename','move','delete'):
            previous=row(conn,body['id'])
            if previous['version']!=body.get('version'): raise CommandError('asset_conflict','对象版本已变化')
            destination = row(conn,body['parent_id']) if action=='move' and body.get('parent_id') else None
            if previous['kind']=='block' and destination and destination['kind']=='block':
                asset_id = move_into_block(conn, previous, destination, body.get('parent_version'))
            elif previous.get('owner_id'):
                owner=row(conn,previous['owner_id'],'block'); root=DocNode.from_json(owner['data']['snapshot'])
                target=next(n for n in root.walk() if n.id==previous['node_id'])
                if action=='rename': target.meta['name']=body['name']
                else:
                    parent=next(n for n in root.walk() if target in n.children); parent.children.remove(target)
                    if action=='move':
                        save_block(conn,target.to_json(),previous['name'],parent_id=body.get('parent_id'))
                asset_id=save_block(conn,root.to_json(),owner['name'],asset_id=owner['id'],expected=owner['version'])
                if action=='rename': asset_id=previous['id']
            elif action=='delete':
                # Keep the RESTRICT foreign key: explicitly delete children first,
                # in the same writer transaction as the version check.
                descendants = list(conn.execute('''WITH RECURSIVE subtree(id,depth) AS (
                    SELECT id,0 FROM assets WHERE id=?
                    UNION ALL SELECT a.id,s.depth+1 FROM assets a JOIN subtree s ON a.parent_id=s.id
                ) SELECT id FROM subtree ORDER BY depth DESC''', (previous['id'],)))
                for item in descendants:
                    conn.execute('DELETE FROM assets WHERE id=?', (item['id'],))
            elif previous['kind']=='tag': asset_id=add_tag(conn,body.get('parent_id',previous['parent_id']),body.get('snapshot') or tag_snapshot(EditorState.create(text=body.get('name',previous['name'])).doc.root.children[0].to_json()),previous['id'],body['version'])
            else: asset_id=store(conn,previous['id'],previous['kind'],body.get('name',previous['name']),previous['data'],expected=body['version'],parent_id=body.get('parent_id',previous['parent_id']))
        elif action in ('edit','sync_pool','observe','save_instance'):
            previous=EditorState.from_json(body['state']); state=deepcopy(previous); command=body.get('command',{})
            if action=='edit':
                requested = command.get('patch', {}).get('pool')
                if command.get('type') == 'SetMetadata' and requested:
                    pool_asset(conn, requested)
                state=apply_command(previous,command); bind_paths(conn,state)
            if action=='save_instance':
                state.check()
                if command['revision']!=state.revision: raise CommandError('stale_revision','文档已变化')
                if command.get('document'): asset_id=store(conn,command.get('asset_id'),'document',command['name'],{'doc':state.doc.to_json()},command.get('folder_id'),command.get('version'))
                else:
                    if command.get('whole_block'):
                        children = state.doc.root.children
                        single = children[0] if len(children) == 1 else None
                        if single and single.kind == 'group' and single.form not in ('paren', 'schedule_entry', 'region_entry', 'avg_entry') and (single.meta.get('presentation') != 'prompt' or command.get('id') == single.id):
                            command = {**command, 'id': single.id}
                        else:
                            # Wrap and save in the same writer transaction and undo step.
                            wrap = {'type': 'WrapSelection', 'ids': [child.id for child in children]} if children else {'type': 'InsertBlock', 'parent_id': state.doc.root.id, 'edge': 'end'}
                            state = apply_command(state, {**wrap, 'revision': state.revision})
                            state.revision = previous.revision
                            command = {**command, 'id': state.selection['block_id']}
                    node=state.doc.find(command['id'])
                    if not node: raise CommandError('unknown_node','目标 block 已移除')
                    asset_id=save_block(conn,node.to_json(),command['name'],command.get('folder_id'),command.get('asset_id'),command.get('version'),command.get('parent_id',UNSET))
                    saved=row(conn,asset_id); node.meta['name']=command['name']; node.meta['source']={'kind':'block','id':asset_id,'version':saved['version'],'path':saved['path']}
                    node.__dict__.update(DocNode.from_json(set_header(node.to_json(),saved['path'])).__dict__); state.doc=refresh_document(state.doc)
                state.revision+=1
            if state.valid and not command.get('defer_pool'):
                library_changed = observe(conn,state,body.get('owner'),collect=action!='observe',suppress=command.get('type') in ('Delete','SetEnabled','SetContentEnabled','LocateDetails')) or library_changed
            if action=='sync_pool': state.revision+=1
            if action!='observe': response={'state':state.to_json(),'projection':projection(state),'edit':text_edit(previous.text,state.text)}
        else: raise CommandError('invalid_action','未知 Library 操作')
        if library_changed:
            placement_check(conn); loose_check(conn)
        if action in ('save_block', 'save_folder', 'save_class', 'create_block', 'rename', 'move', 'save_instance', 'ensure_lora'): names_check(conn)
        # Observations are bookkeeping, not autocomplete data changes.
        if library_changed: bump(conn)
        return {'id':asset_id,'revision':conn.execute('SELECT revision FROM library_meta').fetchone()[0],'library_changed':library_changed,**response,**({'asset':row(conn,asset_id)} if asset_id else {})}


class AssetLibrary:
    def __init__(self,path):
        self.path=Path(path); self.path.parent.mkdir(parents=True,exist_ok=True)
        if self.path.exists():
            conn=sqlite3.connect(f'file:{quote(self.path.resolve().as_posix(), safe="/:")}?mode=ro', uri=True)
            conn.row_factory=sqlite3.Row
            try:
                columns={r['name'] for r in conn.execute('PRAGMA table_info(assets)')}
                if 'class_id' in columns: raise CommandError('legacy_library','旧 V4 库需显式转换到新副本；原库不会自动改写')
            finally: conn.close()
        self.writer=WriteQueue(self.path); self.writer.start(); self.writer.enqueue(SchemaOp()).result(); self._completion_cache=None
    def close(self): self.writer.stop(timeout=3)
    def mutate(self,body):
        if body.get('action') == 'separate_types':
            from .class_migration import SeparateTypesOp
            return self.writer.enqueue(SeparateTypesOp(self.path, body.get('revision'))).result()
        return self.writer.enqueue(MutationOp(deepcopy(body))).result()
    def read(self,action='tree',**args):
        conn=connect_read(self.path)
        try:
            conn.execute('BEGIN'); revision=conn.execute('SELECT revision FROM library_meta').fetchone()[0]
            if action=='get': return row(conn,args['id'])
            if action=='structure_plan':
                from .class_migration import structure_plan
                return structure_plan(conn)
            if action=='tree':
                assets=[]; documents=[]
                entries = list(catalog(conn)); lookup = {a['id']:a for a in entries}
                hidden = {}
                def hidden_from_library(asset):
                    if asset['id'] not in hidden:
                        own = (asset['kind'] == 'class' and bool(asset['data'].get('lora'))) or (asset['kind'] == 'block' and bool(asset['data'].get('snapshot', {}).get('meta', {}).get('lora')))
                        parent = lookup.get(asset['parent_id'])
                        hidden[asset['id']] = bool(own or (parent and hidden_from_library(parent)))
                    return hidden[asset['id']]
                for asset in entries:
                    lora_root = asset['kind'] == 'class' and bool(asset['data'].get('lora'))
                    library_hidden = hidden_from_library(asset)
                    asset={k:v for k,v in asset.items() if k!='data'}; asset['folder_id']=asset['parent_id']
                    if lora_root: asset['lora_root'] = True
                    if library_hidden: asset['library_hidden'] = True
                    if asset['kind']=='document': documents.append(asset); continue
                    assets.append(asset)
                return {'revision':revision,'assets':assets,'saved_documents':documents,'legacy_pools':legacy_pools(conn)}
            if action=='resolve':
                matches=[a['id'] for a in catalog(conn) if a['kind']==args.get('kind','block') and a['path']==args['path']]
                if len(matches)!=1: raise CommandError('ambiguous_path' if matches else 'missing_asset','Library 路径不存在或不唯一')
                return row(conn,matches[0])
            if action=='versions':
                result={}
                for asset_id in args.get('ids',[]):
                    try: result[asset_id]=row(conn,asset_id)['version']
                    except CommandError: pass
                return {'revision':revision,'versions':result}
            if action in ('class_block','folder_block'): return {**folder_block(conn,args['id'],args.get('fill',False),args.get('recursive',False)),'revision':revision}
            if action=='expand':
                snapshot=expand(conn,args['id']); validate_snapshot(snapshot)
                return {'snapshot':snapshot,'source':snapshot['meta']['source'],'revision':revision}
            if action in ('candidates','complete'):
                all_classes = action == 'complete' and (args.get('all_classes') is True or args.get('all_folders') is True)
                legacy = legacy_pools(conn)
                kind = 'folder' if legacy else 'class'
                if action=='complete' and not all_classes and self._completion_cache and self._completion_cache['revision']==revision: return deepcopy(self._completion_cache)
                pools = ([args['pool']] if action=='candidates' else
                         [r['id'] for r in conn.execute('SELECT a.id FROM assets a LEFT JOIN assets p ON p.id=a.parent_id WHERE a.kind=? AND (p.kind IS NULL OR p.kind<>?) ORDER BY a.position,a.id', (kind,kind))] if all_classes else
                         [r['id'] for r in conn.execute('SELECT id,data_json FROM assets WHERE kind=? ORDER BY position,id', (kind,)) if json.loads(r['data_json']).get('autocomplete')])
                excluded = args.get('exclude_block')
                excluded_owner = str(excluded).split('/')[0] if excluded else None
                bindings = {}
                if action == 'candidates':
                    # Only explicitly saved assets enter the reverse binding index.
                    # Contained projections are not independently saved assets.
                    for record in conn.execute("SELECT id FROM assets WHERE kind='block' ORDER BY position,id"):
                        if record['id'] == excluded_owner: continue
                        item = row(conn, record['id']); pool = item['data']['snapshot'].get('meta', {}).get('pool')
                        if pool: bindings.setdefault(pool, []).append(item)
                def walk(pool_id):
                    pool_asset(conn, pool_id); pool=row(conn,pool_id); children=[]
                    for record in conn.execute('SELECT id FROM assets WHERE parent_id=? ORDER BY position,id',(pool_id,)):
                        item=row(conn,record['id'])
                        if item['kind']==kind: children.append(walk(item['id']))
                        elif item['kind']=='tag':
                            children.append({'kind':'tag','id':item['id'],'name':item['name'],'snapshot':deepcopy(item['data']['snapshot']),'occurrence':[pool_id,item['id']], 'source':{'kind':'tag','id':item['id'],'version':item['version'],'path':item['path']}})
                    for item in bindings.get(pool_id, []):
                        children.append({'kind':'block','id':item['id'],'name':item['path'],'snapshot':expand(conn,item['id']),'occurrence':[pool_id,item['id']], 'source':{'kind':'block','id':item['id'],'version':item['version'],'path':item['path']}})
                    return {'kind':'class','id':pool_id,'name':pool['path'],'autocomplete':bool(pool['data'].get('autocomplete')),'children':children}
                result={'revision':revision,'candidates':[walk(pool) for pool in pools]}
                if action=='complete' and not all_classes: self._completion_cache=result
                return deepcopy(result)
            raise CommandError('invalid_action','未知读取操作')
        finally: conn.close()
