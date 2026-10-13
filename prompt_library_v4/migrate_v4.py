"""Explicit conversion of the retired V4 model into a NEW Folder-pool copy.

Never invoked by setup. The source is read-only, including committed WAL data.
Legacy pointers are expanded here only; the new runtime has no reference graph.
"""
from copy import deepcopy
from dataclasses import dataclass
import json
from pathlib import Path
import sqlite3
from .assets import AssetLibrary, store, save_block, add_tag, bump, encode, identity, renumber, name_snapshot, disambiguate_library_names
from .migrate_v3 import readonly
from .model import CommandError, EditorState
from ._v3 import DocNode


def convert_document(doc, folder_mapping):
    doc = deepcopy(doc)
    used = set()
    def ids(node):
        used.add(node['id'])
        for child in node.get('children', []): ids(child)
    ids(doc['root'])
    def fresh():
        while True:
            value = identity()
            if value not in used: used.add(value); return value
    def visit(node):
        meta = node.setdefault('meta', {}); assoc = meta.pop('association', {})
        meta.pop('class_saved', None)
        source = meta.get('source', {})
        if source.get('kind') == 'class': meta.pop('source', None)
        source.pop('dependencies', None)
        source.pop('class_id', None); source.pop('attribute_id', None)
        if assoc.get('mode') == 'belongs': meta['pool'] = folder_mapping.get(assoc['class_id'], assoc['class_id'])
        elif assoc.get('mode') == 'loads':
            # Multiple pools become independent temporary subblocks. Existing
            # selections with a known candidate path move with their own pool.
            for cid in dict.fromkeys(assoc.get('class_ids', [])):
                child = EditorState.create(text='{ }').doc.root.children[0].to_json(); child['id'] = fresh()
                child['meta'] = {'pool': folder_mapping.get(cid, cid), 'name': '池'}
                child['sep'] = ', '
                selected = [n for n in node.get('children', []) if cid in n.get('meta', {}).get('occurrence', []) or n.get('meta', {}).get('source', {}).get('class_id') == cid]
                child['children'] = selected
                node['children'] = [n for n in node.get('children', []) if n not in selected]
                node['children'].append(child)
        for child in node.get('children', []): visit(child)
    visit(doc['root'])
    doc['next_id'] = max(doc.get('next_id', 1), len(used) + 1)
    return doc


def convert_workflow(value, mapping):
    """Copy workflow JSON, transform hidden doc widgets, preserve everything else."""
    value = deepcopy(value)
    def visit(item):
        if isinstance(item, dict):
            if isinstance(item.get('root'), dict) and item['root'].get('kind') == 'group':
                return convert_document(item, mapping)
            return {k: visit(v) for k, v in item.items()}
        if isinstance(item, list): return [visit(v) for v in item]
        if isinstance(item, str):
            try: parsed = json.loads(item)
            except (ValueError, TypeError): return item
            if isinstance(parsed, dict) and isinstance(parsed.get('root'), dict): return encode(convert_document(parsed, mapping))
        return item
    return visit(value)


@dataclass
class ConvertOp:
    rows: dict
    def apply(self, conn):
        conn.execute('UPDATE library_structure SET version=1')
        rows = self.rows; mapping = {}; warnings = []; active = set()
        def folder(old_id):
            if not old_id: return None
            if old_id in mapping: return mapping[old_id]
            if old_id in active: raise CommandError('legacy_cycle', '旧存放层级有环')
            active.add(old_id); old = rows[old_id]
            if old['kind'] not in ('folder', 'class'): raise CommandError('invalid_parent','旧 Folder 的父级不是 Folder/Class')
            parent = folder(old.get('parent_id') or old.get('class_id') or old.get('folder_id'))
            # Preserve identity so saved workflow bindings have a stable mapping.
            conn.execute('INSERT INTO assets(id,kind,name,parent_id,position,version,data_json) VALUES(?,?,?,?,?,?,?)', (old_id,'folder',old['name'],parent,old['position'],old['version'],encode({'autocomplete':bool(old['data'].get('autocomplete',False))})))
            mapping[old_id]=old_id; active.remove(old_id); return old_id
        for old_id, old in rows.items():
            if old['kind'] in ('folder','class'): folder(old_id)
        def snapshot(asset_id, stack=()):
            if asset_id in stack or len(stack)>64: raise CommandError('legacy_cycle','旧 block 指针有环')
            old = rows[asset_id]
            def expand(node):
                if 'ref' in node:
                    result=snapshot(node['ref'],(*stack,asset_id)); result['enabled']=node.get('enabled',True); result['sep']=node.get('sep','')
                    result.setdefault('meta',{}).update(deepcopy(node.get('instance_meta',{}))); return result
                result=deepcopy(node)
                if 'children' in result: result['children']=[expand(c) for c in result['children']]
                return result
            result=expand(old['data']['snapshot'])
            result=convert_document({'root':result,'version':2,'next_id':1},mapping)['root']
            result.setdefault('meta',{})['name']=old['name']; node=DocNode.from_json(result); renumber(node); return node.to_json()
        def insert_block(old, target=None, copied=False):
            node=name_snapshot(snapshot(old['id']), disambiguate=True); asset_id=save_block(conn,node,old['name'],parent_id=target)
            if not copied:
                conn.execute('UPDATE assets SET id=?,version=?,position=? WHERE id=?',(old['id'],old['version'],old['position'],asset_id)); asset_id=old['id']
            return asset_id
        for old_id, old in rows.items():
            parent=old.get('parent_id') or old.get('class_id') or old.get('folder_id')
            if old['kind']=='block' and (not parent or rows[parent]['kind'] in ('folder','class')): insert_block(old,mapping.get(parent))
            elif old['kind']=='document':
                data={'doc':convert_document(old['data']['doc'],mapping)}
                new_id=store(conn,None,'document',old['name'],data,parent_id=mapping.get(parent))
                conn.execute('UPDATE assets SET id=?,version=?,position=? WHERE id=?',(old_id,old['version'],old['position'],new_id))
        def contents(old_id, target, stack=()):
            if old_id in stack or len(stack)>64: raise CommandError('legacy_cycle','旧 Class 属性有环')
            old=rows[old_id]
            for attr in old['data'].get('attributes',[]):
                if attr['kind']=='prompt':
                    converted=convert_document({'root':attr['snapshot'],'version':2},mapping)['root']
                    try: add_tag(conn,target,converted)
                    except CommandError as error:
                        if error.code!='duplicate_tag': raise
                        warnings.append(str(error))
                elif attr['kind']=='block':
                    ref=rows[attr['ref_id']]; placed=ref.get('parent_id') or ref.get('class_id') or ref.get('folder_id')
                    if placed!=old_id: insert_block(ref,target,copied=True)
                elif attr['kind']=='class':
                    ref=rows[attr['ref_id']]; placed=ref.get('parent_id') or ref.get('folder_id')
                    if placed==old_id: continue
                    new=store(conn,None,'folder',ref['name'],{'autocomplete':bool(ref['data'].get('autocomplete',False))},parent_id=target)
                    # Expand former references as actual containment, with no pointer.
                    clone_folder(ref['id'],new,(*stack,old_id))
        def clone_folder(old_id,target,stack):
            contents(old_id,target,stack)
            for child in rows.values():
                if (child.get('parent_id') or child.get('class_id') or child.get('folder_id'))!=old_id: continue
                if child['kind']=='block': insert_block(child,target,copied=True)
                elif child['kind'] in ('folder','class'):
                    new=store(conn,None,'folder',child['name'],{'autocomplete':bool(child['data'].get('autocomplete',False))},parent_id=target)
                    clone_folder(child['id'],new,(*stack,old_id))
        # Ancestors first: duplicate tags are classified downwards consistently.
        for old in rows.values():
            if old['kind']=='class': contents(old['id'],mapping[old['id']])
        warnings.extend(disambiguate_library_names(conn))
        bump(conn)
        return {'mapping':mapping,'warnings':warnings,'counts':dict(conn.execute('SELECT kind,COUNT(*) FROM assets GROUP BY kind'))}


def convert(source, target):
    source=Path(source).resolve(); target=Path(target).resolve()
    if source==target or target.exists(): raise CommandError('copy_required','转换必须使用尚不存在的新副本路径')
    conn=readonly(source)
    try:
        conn.execute('BEGIN')
        rows={r['id']:{**dict(r),'data':json.loads(r['data_json'])} for r in conn.execute('SELECT * FROM assets ORDER BY position,id')}
    finally: conn.close()
    library=AssetLibrary(target)
    try:
        result=library.writer.enqueue(ConvertOp(rows)).result()
        separated=library.mutate({'action':'separate_types','revision':library.read()['revision']})
        result['structure']=separated; result['counts']=separated['counts']
    finally: library.close()
    return {'source':str(source),'target':str(target),**result}


if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser(); parser.add_argument('source'); parser.add_argument('target')
    args=parser.parse_args(); print(json.dumps(convert(args.source,args.target),ensure_ascii=False,indent=2))
