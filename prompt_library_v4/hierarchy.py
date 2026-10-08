"""Folder containment paths; blocks own their nested content."""
from .model import CommandError

UNSET = object()


def asset_path(conn, asset_id):
    names, seen = [], set()
    while asset_id:
        if asset_id in seen or len(seen) >= 64:
            raise CommandError('placement_cycle', 'Library 存放层级形成环或超过深度上限')
        seen.add(asset_id)
        value = conn.execute('SELECT name,parent_id FROM assets WHERE id=?', (asset_id,)).fetchone()
        if value is None: raise CommandError('missing_asset', 'Library 路径不存在')
        names.append(value['name']); asset_id = value['parent_id']
    return '.'.join(reversed(names))


def ancestors(conn, asset_id):
    result = []
    while asset_id:
        if asset_id in result or len(result) >= 64:
            raise CommandError('placement_cycle', 'Library 存放层级形成环或超过深度上限')
        result.append(asset_id)
        value = conn.execute('SELECT parent_id FROM assets WHERE id=?', (asset_id,)).fetchone()
        if value is None: raise CommandError('missing_asset', 'Library 父级不存在')
        asset_id = value['parent_id']
    return result


def placement_check(conn):
    for value in conn.execute('SELECT id,kind,parent_id FROM assets'):
        parent = value['parent_id']
        if parent:
            target = conn.execute('SELECT kind FROM assets WHERE id=?', (parent,)).fetchone()
            allowed = {'folder': ('folder',), 'tag': ('folder',), 'block': ('folder',), 'document': ('folder',)}
            if target is None or target['kind'] not in allowed[value['kind']]:
                raise CommandError('invalid_parent', '此对象不能存放在所选父级下')
        ancestors(conn, value['id'])


def set_header(node, path):
    # The PLv3 path head is legal for brace blocks. Special containers retain
    # their @schedule/@region heads; wrapping them would change random units.
    node.setdefault('meta', {})['full_path'] = path
    if node.get('kind') == 'group' and node.get('form') == 'brace' and not node.get('opaque', True):
        opening = node.get('open', '{')
        node['open'] = f'[{path}]: ' + opening[opening.index('{'):]
        node['header'] = path
    return node
