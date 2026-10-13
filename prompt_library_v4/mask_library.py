"""Independent versioned mask canvases; input images are always read-only."""
from copy import deepcopy
import json
from pathlib import Path, PurePosixPath
import re
import uuid

from .mask_images import coordinates, settings
from .model import CommandError
if '.' in __package__:
    from ..prompt_shared.storage import WriteQueue, connect_read
else:
    from prompt_shared.storage import WriteQueue, connect_read

_default = None


def current():
    return _default


def set_current(library):
    global _default
    _default = library


def relative(value):
    if not isinstance(value, str) or not value or '\\' in value or ':' in value:
        raise ValueError('Choose a relative subdirectory or file inside input.')
    p = PurePosixPath(value)
    if p.is_absolute() or any(part in ('..', '.') for part in value.split('/')):
        raise ValueError('The path must stay inside the registered input directory.')
    return str(p)


def color(value):
    if not isinstance(value, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', value):
        raise ValueError('Preview colors must use six-digit RGB hex values.')
    return value.lower()


def validate_canvas(value):
    value = deepcopy(value)
    if value.get('kind') not in ('rectangle', 'picture') or not isinstance(value.get('name'), str) or not value['name'].strip():
        raise ValueError('A canvas name and type are required.')
    value['name'] = value['name'].strip()
    if value['kind'] == 'rectangle':
        value.setdefault('masks', [])
        if not isinstance(value['masks'], list): raise ValueError('Canvas rectangles must be a list.')
        ids = set()
        for mask in value.get('masks', []):
            mask.setdefault('id', uuid.uuid4().hex)
            if not isinstance(mask['id'], str) or not mask['id'] or mask['id'] in ids:
                raise ValueError('Rectangle IDs must be unique.')
            ids.add(mask['id'])
            mask['coordinates'] = coordinates(mask['coordinates'])
            mask['color'] = color(mask.get('color', '#75a5df'))
            if not isinstance(mask.get('name'), str) or not mask['name'].strip():
                raise ValueError('A rectangle name is required.')
    else:
        value['path'] = relative(value['path'])
        value['settings'] = settings(value.get('settings'))
        presentation = value.setdefault('presentation', {})
        if not isinstance(presentation, dict): raise ValueError('Invalid image mask presentation settings.')
        for key, item in presentation.items():
            if key != 'alpha' and not re.fullmatch(r'rgb:[0-9a-f]{6}', key): raise ValueError('Invalid image extraction ID.')
            item['color'] = color(item.get('color', '#75a5df'))
            if 'name' in item and not isinstance(item['name'], str): raise ValueError('Invalid mask name.')
    return value


class Operation:
    def __init__(self, action, body): self.action, self.body = action, deepcopy(body)
    def apply(self, conn):
        if self.action == 'schema':
            conn.execute('CREATE TABLE IF NOT EXISTS canvases (id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0)')
            conn.execute('CREATE TABLE IF NOT EXISTS tombstones (canvas_id TEXT NOT NULL, mask_id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(canvas_id,mask_id))')
            conn.execute('CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
            conn.execute("INSERT OR IGNORE INTO config VALUES ('directories', '[\"xyz_masks\"]')")
            return
        if self.action == 'directory':
            directories = json.loads(conn.execute("SELECT value FROM config WHERE key='directories'").fetchone()[0])
            path = relative(self.body['directory'])
            directories = [d for d in directories if d != path] + [path]
            conn.execute("UPDATE config SET value=? WHERE key='directories'", (json.dumps(directories),))
            return dict(directory=path)
        identity = self.body.get('id') or uuid.uuid4().hex
        row = conn.execute('SELECT * FROM canvases WHERE id=?', (identity,)).fetchone()
        expected = self.body.get('version', 0)
        if type(expected) is not int or expected != (row['version'] if row else 0):
            raise CommandError('stale_version', 'This canvas changed in another window. Refresh and try again.')
        if self.action == 'delete':
            if not row or row['deleted']: raise ValueError('The canvas does not exist.')
            old = json.loads(row['data'])
            for mask in old.get('masks', []):
                conn.execute('INSERT OR REPLACE INTO tombstones VALUES (?,?,?)', (identity, mask['id'], json.dumps(mask)))
            conn.execute('UPDATE canvases SET deleted=1,version=version+1 WHERE id=?', (identity,))
            return dict(id=identity, version=expected+1, deleted=True)
        if self.action != 'save': raise ValueError('Unknown Mask Library operation.')
        if row and row['deleted']: raise ValueError('The canvas was deleted.')
        value = validate_canvas(self.body['canvas'])
        if value['kind'] == 'picture' and not row:
            for existing in conn.execute('SELECT * FROM canvases'):
                other = json.loads(existing['data'])
                if other['kind'] == 'picture' and other['path'] == value['path']:
                    if existing['deleted']: raise ValueError('This image entry was deleted. Relocate it explicitly.')
                    return other
        if row:
            old = json.loads(row['data'])
            if old['kind'] != value['kind']: raise ValueError('The canvas type cannot be changed.')
            existing = {m['id'] for m in value.get('masks', [])}
            for mask in old.get('masks', []):
                if mask['id'] not in existing:
                    conn.execute('INSERT OR REPLACE INTO tombstones VALUES (?,?,?)', (identity, mask['id'], json.dumps(mask)))
            for mask in value.get('masks', []):
                conn.execute('DELETE FROM tombstones WHERE canvas_id=? AND mask_id=?', (identity, mask['id']))
        value.update(id=identity, version=expected+1)
        conn.execute('INSERT OR REPLACE INTO canvases VALUES (?,?,?,0)', (identity, expected+1, json.dumps(value, ensure_ascii=False)))
        return value


class MaskLibrary:
    def __init__(self, path, input_root):
        self.path, self.input_root = Path(path), Path(input_root).resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.writer = WriteQueue(self.path); self.writer.start()
        self.writer.enqueue(Operation('schema', {})).result(10)
    def close(self): self.writer.stop(5)
    def snapshot(self):
        conn = connect_read(self.path)
        try:
            conn.execute('BEGIN')
            canvases = [json.loads(row['data']) | dict(version=row['version'], deleted=bool(row['deleted'])) for row in conn.execute('SELECT * FROM canvases')]
            tombstones = {(row['canvas_id'], row['mask_id']): json.loads(row['data']) for row in conn.execute('SELECT * FROM tombstones')}
            directories = json.loads(conn.execute("SELECT value FROM config WHERE key='directories'").fetchone()[0])
            return dict(canvases=canvases, tombstones=tombstones, directories=directories, directory=directories[-1])
        finally: conn.close()
    def path_for(self, name, directories=None):
        name = relative(name)
        directories = directories or self.snapshot()['directories']
        path = (self.input_root / name).resolve()
        if not path.is_relative_to(self.input_root) or not any(path.is_relative_to((self.input_root / d).resolve()) and (self.input_root / d).resolve().is_relative_to(self.input_root) for d in directories):
            raise ValueError('The image must be inside a registered input subdirectory.')
        return path
    def mutate(self, action, **body):
        if action == 'directory': self.path_for(relative(body['directory']) + '/.check', [body['directory']])
        if action == 'save' and body['canvas'].get('kind') == 'picture':
            self.path_for(body['canvas']['path'])
        return self.writer.enqueue(Operation(action, body)).result(10)
    def discover(self):
        snapshot = self.snapshot()
        directory = self.path_for(snapshot['directory'] + '/.scan', snapshot['directories']).parent
        known = {c.get('path') for c in snapshot['canvases'] if c['kind'] == 'picture'}
        if directory.exists():
            for path in sorted(directory.rglob('*')):
                if path.is_file() and path.suffix.lower() in ('.png', '.webp', '.jpg', '.jpeg', '.bmp'):
                    name = path.relative_to(self.input_root).as_posix()
                    if name not in known:
                        self.path_for(name)
                        self.mutate('save', canvas=dict(kind='picture', name=path.stem, path=name, settings={}))
        return self.snapshot()
