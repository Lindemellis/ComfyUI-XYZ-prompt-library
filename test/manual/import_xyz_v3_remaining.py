"""Explicit remaining V3 import into the test Library, preserving prior assets."""
import argparse
from copy import deepcopy
import json
from pathlib import Path
from random import Random
from unittest.mock import patch
from urllib.request import Request, urlopen

from import_xyz_artist_library import backup, dump, logical_digest, state_for
from prompt_library_v4.migrate_v3 import SnapshotReader
from prompt_library_v3.library import expand, _item_text
from prompt_library_v4.assets import AssetLibrary, reusable, tag_key, name_snapshot
from prompt_library_v4.model import EditorState
from prompt_library_v4.compiler import compile_document
from prompt_library_v4._v3 import Document, compile_text, render

TEST_DB = Path('E:/AI/ComfyUI-aki-v2/XYZNodes-Test/custom_nodes/ComfyUI-XYZNodes/prompt_library_v4_data/plv4-pools.db')
FORMAL_DB = Path(__file__).resolve().parents[2] / 'prompt_library_v4_data/plv4-pools.db'


def build_plan(source):
    reader = SnapshotReader(source)
    group_ids = {gid for gid in reader.groups if reader.group_path(gid).split('.')[0] != 'artists'}
    groups = {gid:reader.groups[gid] for gid in group_ids}
    # Keep empty folders too, except the entire already imported artists branch.
    def artist_folder(fid):
        while fid:
            value = reader.folders[fid]
            if value['parent_id'] is None:
                return value['name']=='artists'
            fid = value['parent_id']
        return False
    folders = {fid:f for fid,f in reader.folders.items() if not artist_folder(fid)}
    pools = {}
    source_rows = 0
    for gid in groups:
        pool = pools[gid] = {}
        for item in reader.list_items(gid):
            if item['kind']=='ref':
                if item['ref_group_id'] not in group_ids:
                    raise ValueError('Remaining group references an excluded artist group')
                continue
            source_rows += 1
            state = EditorState.create(text=_item_text(item)); state.check()
            for node in state.doc.root.children:
                if reusable(node.to_json()):
                    raise ValueError('Library item contains an unexpected structural block')
                pool.setdefault(tag_key(node), node.to_json())
    for gid in groups:
        ancestors = []
        parent = groups[gid]['parent_group_id']
        while parent:
            ancestors.append(parent); parent=groups[parent]['parent_group_id']
        for ancestor in ancestors:
            for key in pools[gid]:
                pools[ancestor].pop(key, None)

    blocks = []
    for gid,g in sorted(groups.items()):
        versions = [(None, '全部内容', None)] + [(p['body'],p['name'],p['id']) for p in reader.presets.values() if p['group_id']==gid]
        for body,name,pid in versions:
            expected = expand(gid, body=body, reader=reader)
            state=EditorState.create(text=expected); state.check()
            snapshot=state.doc.root.children[0].to_json()
            snapshot.setdefault('meta',{}).update(name=name,import_v3={'group_id':gid,'preset_id':pid,'path':reader.group_path(gid),'weight_memory':(body or {}).get('weight_memory',{})})
            blocks.append({'name':name,'group_id':gid,'snapshot':name_snapshot(snapshot,disambiguate=True),'expected_source':expected,'disabled':0})
    documents = []
    for value in reader.tables.get('documents',[]):
        doc=Document.from_json(json.loads(value['doc_json'])) if value.get('doc_json') else EditorState.create(text=value['text']).doc
        assert render(doc)==value['text'], 'Saved Document differs from its stored source'
        root=deepcopy(doc.root)
        root.form='brace';root.open='{\n';root.close='\n}';root.header=None;root.opaque=False
        root.meta.update(name=value['name'],import_v3={'document_id':value['id']})
        documents.append({'name':value['name'],'snapshot':name_snapshot(root.to_json(),disambiguate=True),'expected_source':value['text'],'disabled':sum(not n.enabled for n in doc.root.walk()),'document_id':value['id']})
    artist_headers={reader.group_path(gid):('$tentacle' if 'tentacle' in reader.group_path(gid).lower() else '$artist') for gid in reader.groups if gid not in group_ids}
    return {'groups':[{'id':gid,'name':g['name'],'path':reader.group_path(gid),'folder_id':g['folder_id'],'parent_group_id':g['parent_group_id']} for gid,g in sorted(groups.items())], 'folders':list(folders.values()),'tags':{str(gid):list(pool.values()) for gid,pool in pools.items()},'blocks':blocks,'documents':documents,'source_prompt_rows':source_rows,'artist_headers':artist_headers}


def check_block(snapshot, spec):
    state=state_for(snapshot)
    assert sum(not n.enabled for n in state.doc.root.walk())==spec['disabled']
    for seed in (0,42):
        for mode in ('couple','mask'):
            result=compile_document(state,seed=seed,region_mode=mode)
            for key,plain in (('prompt',False),('plain',True)):
                expected=compile_text(spec['expected_source'],seed=seed,region_mode=mode,ignore_regions=plain,ignore_group_seeds=True,centralize_loras=True).text
                if 'document_id' not in spec:
                    assert result[key]==expected, (spec['name'],seed,mode,key)
            if 'document_id' in spec:
                # Saving a whole Document adds a parent, changing the existing
                # path-based RNG. Control that RNG only in this comparison to
                # check body/settings semantics; runtime policy stays unchanged.
                with patch('prompt_shared.language.ir._rng', side_effect=lambda group, ctx: Random(ctx.seed)):
                    controlled=compile_document(state,seed=seed,region_mode=mode)
                    for key,plain in (('prompt',False),('plain',True)):
                        expected=compile_text(spec['expected_source'],seed=seed,region_mode=mode,ignore_regions=plain,ignore_group_seeds=True,centralize_loras=True).text
                        assert controlled[key]==expected, (spec['name'],seed,mode,key)


def install(plan, mutate, read, staging_name):
    ids={}
    def save(key,kind,name,parent=None,**extra):
        value=mutate({'action':'save_'+kind,'name':name,'parent_id':ids.get(parent),**extra})['asset'];ids[key]=value['id'];return value
    save('root','folder',staging_name)
    folder_records={f['id']:f for f in plan['folders']}
    def folder(fid):
        key='f:'+str(fid)
        if key not in ids:
            value=folder_records[fid];parent=folder(value['parent_id']) if value['parent_id'] else 'root'
            save(key,'folder',value['name'],parent)
        return key
    for fid in folder_records:folder(fid)
    groups={g['id']:g for g in plan['groups']}
    def storage(gid):
        key='s:'+str(gid)
        if key not in ids:
            value=groups[gid];parent=storage(value['parent_group_id']) if value['parent_group_id'] else folder(value['folder_id']) if value['folder_id'] else 'root'
            save(key,'folder',value['name'],parent)
        return key
    def pool(gid):
        key='c:'+str(gid)
        if key not in ids:
            value=groups[gid];parent=pool(value['parent_group_id']) if value['parent_group_id'] else storage(gid)
            save(key,'class',value['name'],parent,data={'autocomplete':False})
        return key
    for gid in groups:storage(gid);pool(gid)
    for gid,items in plan['tags'].items():
        for snapshot in items:mutate({'action':'save_tag','parent_id':ids[pool(int(gid))],'snapshot':snapshot})

    tree=read('tree')['assets']
    artist=next(a for a in tree if a['kind']=='class' and a['path']=='artist.artist')
    tentacle=next(a for a in tree if a['kind']=='class' and a['parent_id']==artist['id'] and a['name']=='tentacle')
    bindings={g['path']:ids[pool(g['id'])] for g in plan['groups']}
    bindings.update({header:artist['id'] if target=='$artist' else tentacle['id'] for header,target in plan['artist_headers'].items()})
    def bind(node):
        if node.get('header') in bindings and reusable(node):
            node.setdefault('meta',{})['pool']=bindings[node['header']]
        for child in node.get('children',[]):bind(child)
    saved=[]
    save('documents','folder','完整提示词','root')
    for index,spec in enumerate(plan['blocks']+plan['documents']):
        snapshot=deepcopy(spec['snapshot']);bind(snapshot)
        destination=storage(spec['group_id']) if 'group_id' in spec else 'documents'
        asset=save('b:'+str(index),'block',spec['name'],destination,snapshot=snapshot)
        check_block(read('expand',id=asset['id'])['snapshot'],spec)
        saved.append({'id':asset['id'],'name':spec['name'],'group_id':spec.get('group_id'),'document_id':spec.get('document_id')})
    return {'ids':ids,'blocks':saved,'classes':len(groups),'tags':sum(len(tags) for tags in plan['tags'].values()),'group_blocks':len(plan['blocks']),'document_blocks':len(plan['documents']),'source_prompt_rows':plan['source_prompt_rows'],'exact_group_output_comparisons':len(plan['blocks'])*8,'controlled_rng_document_comparisons':len(plan['documents'])*8,'disabled_original_document_nodes':sum(spec['disabled'] for spec in plan['documents'])}


def prepare(source,output):
    output=Path(output).resolve();output.mkdir(parents=True,exist_ok=False)
    backup(source,output/'plv3-source.db');backup(TEST_DB,output/'test-before.db')
    plan=build_plan(output/'plv3-source.db')
    plan.update(original_source=str(Path(source).resolve()),source_digest=logical_digest(source),formal_digest=logical_digest(FORMAL_DB))
    dump(output/'plan.json',plan)
    backup(output/'test-before.db',output/'rehearsal.db')
    library=AssetLibrary(output/'rehearsal.db')
    try:
        result=install(plan,library.mutate,library.read,'plv3-rehearsal')
        dump(output/'rehearsal.json',result)
    finally:library.close()
    print(json.dumps({k:v for k,v in result.items() if k not in ('ids','blocks')},ensure_ascii=False))


def apply(output):
    output=Path(output).resolve()
    if (output/'live-journal.json').exists():raise ValueError('Inspect existing application journal before retrying')
    plan=json.loads((output/'plan.json').read_text(encoding='utf-8'))
    assert logical_digest(plan['original_source'])==plan['source_digest']
    def request(operation,body):
        value=json.load(urlopen(Request('http://127.0.0.1:8190/xyz/plv4/library/'+operation,data=json.dumps(body,ensure_ascii=False).encode(),headers={'Content-Type':'application/json'}),timeout=30))
        assert value.get('ok'),value
        return value
    journal=[]
    def mutate(body):
        value=request('mutate',body);journal.append({'request':body,'id':value.get('id'),'revision':value['revision']});dump(output/'live-journal.json',journal);return value
    def read(action,**extra):return request('read',{'action':action,**extra})
    tree=read('tree')
    assert not tree.get('legacy_pools')
    assert not any(a['parent_id'] is None and a['name']=='plv3' for a in tree['assets']), 'plv3 destination already exists'
    result=install(plan,mutate,read,'plv3-import-'+output.name)
    root=read('get',id=result['ids']['root'])
    mutate({'action':'rename','id':root['id'],'version':root['version'],'name':'plv3'})
    dump(output/'live-result.json',result)
    print(json.dumps({k:v for k,v in result.items() if k not in ('ids','blocks')},ensure_ascii=False))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('command',choices=['prepare','apply']);parser.add_argument('output',type=Path);parser.add_argument('--source',type=Path,default=Path('prompt_library_v3_data/plv3.db'))
    args=parser.parse_args()
    prepare(args.source,args.output) if args.command=='prepare' else apply(args.output)
