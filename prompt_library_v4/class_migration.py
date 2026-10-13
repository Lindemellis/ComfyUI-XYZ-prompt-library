"""Explicit, backed-up separation of old Folder pools and storage directories."""
from dataclasses import dataclass
from pathlib import Path
from datetime import datetime, timezone
import json
import sqlite3
import uuid
from .model import CommandError
from .hierarchy import legacy_pools, placement_check


def structure_plan(conn):
    rows = {r['id']: dict(r) for r in conn.execute('SELECT * FROM assets ORDER BY position,id')}
    classes = set()
    def bindings(node):
        pool = node.get('meta', {}).get('pool')
        if pool in rows and rows[pool]['kind'] == 'folder': classes.add(pool)
        for child in node.get('children', []): bindings(child)
    for value in rows.values():
        data = json.loads(value['data_json'])
        if value['kind'] == 'tag': classes.add(value['parent_id'])
        elif value['kind'] == 'folder' and (data.get('autocomplete') or data.get('lora')): classes.add(value['id'])
        elif value['kind'] == 'block': bindings(data['snapshot'])
        elif value['kind'] == 'document': bindings(data['doc']['root'])
    for asset_id in list(classes):
        parent = rows[asset_id]['parent_id']
        while parent:
            if rows[parent]['kind'] != 'folder': break
            classes.add(parent); parent = rows[parent]['parent_id']
    return {'legacy_pools': legacy_pools(conn), 'classes': len(classes),
            'class_ids': sorted(classes), 'retained_folders': sum(r['kind'] == 'folder' and r['id'] not in classes for r in rows.values())}


@dataclass
class SeparateTypesOp:
    path: Path
    revision: int

    def apply(self, conn):
        from .assets import row, encode, bump, names_check, loose_check
        if not legacy_pools(conn): return {'repeated': True, 'revision': conn.execute('SELECT revision FROM library_meta').fetchone()[0]}
        if conn.execute('SELECT revision FROM library_meta').fetchone()[0] != self.revision:
            raise CommandError('asset_conflict', 'Library 已变化，请重新读取转换预览')
        plan = structure_plan(conn)
        rows = {r['id']: dict(r) for r in conn.execute('SELECT * FROM assets ORDER BY position,id')}
        # The writer holds BEGIN IMMEDIATE before this read-only online backup,
        # so no queued mutation can change the snapshot between backup and apply.
        directory = self.path.parent / 'backups'; directory.mkdir(parents=True, exist_ok=True)
        saved = directory / f'folder-pools-{datetime.now(timezone.utc):%Y%m%dT%H%M%S}-{uuid.uuid4().hex[:8]}.db'
        source = sqlite3.connect(self.path.resolve().as_uri() + '?mode=ro', uri=True)
        target = sqlite3.connect(saved)
        try: source.backup(target)
        finally: source.close(); target.close()
        classes = set(plan['class_ids']); containers = {}; created = []
        def unique(name, parent):
            occupied = {r['name'] for r in conn.execute("SELECT name FROM assets WHERE parent_id IS ? AND kind IN ('folder','class','block')", (parent,))}
            original = name; suffix = 2
            while name in occupied: name = f'{original} {suffix}'; suffix += 1
            return name
        def add_folder(name, parent, allow_name=None):
            ident = uuid.uuid4().hex
            name = allow_name or unique(name, parent)
            position = conn.execute('SELECT COALESCE(MAX(position),-1)+1 FROM assets').fetchone()[0]
            conn.execute('INSERT INTO assets(id,kind,name,parent_id,position,data_json) VALUES(?,?,?,?,?,?)', (ident,'folder',name,parent,position,'{}'))
            created.append(ident); return ident
        # Root pools retain IDs, names and their complete Class subtree. The
        # outer Folder receives stored Blocks and storage-only subdirectories.
        for ident in rows:
            if ident not in classes: continue
            if rows[ident]['parent_id'] not in classes:
                old = rows[ident]; wrapper = add_folder(old['name'], old['parent_id'], old['name'])
                containers[ident] = wrapper
                conn.execute('UPDATE assets SET position=? WHERE id=?', (old['position'],wrapper))
                conn.execute('UPDATE assets SET parent_id=? WHERE id=?', (wrapper, ident))
        for ident in rows:
            if ident not in classes: continue
            conn.execute("UPDATE assets SET kind='class',version=version+1 WHERE id=?", (ident,))
        def storage(ident):
            if ident in containers: return containers[ident]
            old = rows[ident]
            parent = storage(old['parent_id']) if old['parent_id'] in classes else old['parent_id']
            containers[ident] = add_folder(old['name'], parent); return containers[ident]
        for value in rows.values():
            if value['id'] in classes or value['kind'] == 'tag': continue
            if value['parent_id'] in classes:
                destination = storage(value['parent_id'])
                conn.execute('UPDATE assets SET parent_id=?,version=version+1 WHERE id=?', (destination,value['id']))
        # Same local names were legal across the old parent/child boundary.
        # Resolve a new wrapper collision on the Class label, never its content.
        for ident, wrapper in list(containers.items()):
            if rows[ident]['parent_id'] not in classes:
                name = rows[ident]['name']
                clash = conn.execute("SELECT 1 FROM assets WHERE parent_id=? AND id<>? AND kind IN ('folder','class','block') AND name=?", (wrapper,ident,name)).fetchone()
                if clash: conn.execute('UPDATE assets SET name=? WHERE id=?', (unique(name + ' Pool', wrapper),ident))
        conn.execute('UPDATE library_structure SET version=2')
        placement_check(conn); names_check(conn); loose_check(conn)
        if conn.execute('PRAGMA foreign_key_check').fetchone(): raise CommandError('invalid_library', '转换后的 Library 外键检查失败')
        bump(conn)
        report = {'repeated': False, 'backup': str(saved), 'converted_classes': plan['class_ids'],
                  'created_folders': created, 'storage_mapping': containers,
                  'revision': conn.execute('SELECT revision FROM library_meta').fetchone()[0],
                  'counts': {r[0]:r[1] for r in conn.execute('SELECT kind,COUNT(*) FROM assets GROUP BY kind')}}
        conn.execute('CREATE TABLE IF NOT EXISTS library_conversions(report_json TEXT NOT NULL)')
        conn.execute('INSERT INTO library_conversions VALUES(?)', (encode(report),))
        return report
