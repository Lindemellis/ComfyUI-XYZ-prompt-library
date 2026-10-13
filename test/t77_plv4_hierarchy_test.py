"""Containment paths, embedded block ownership, and explicit old-V4 copy conversion."""
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import sys
import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from prompt_library_v4.assets import AssetLibrary
from prompt_library_v4.model import EditorState, CommandError
from prompt_library_v4._v3 import DocNode, Document, render
from prompt_library_v4.compiler import compile_document
from prompt_library_v4.migrate_v4 import convert, convert_document, convert_workflow

@pytest.fixture
def lib(tmp_path):
    value=AssetLibrary(tmp_path/'pools.db'); yield value; value.close()

def mutate(lib,action,**kwargs): return lib.mutate({'action':action,**kwargs})
def create(lib,kind,name,parent=None): return mutate(lib,'create_block' if kind=='block' else 'save_'+kind,name=name,parent_id=parent['id'] if parent else None,**({'version':parent['version']} if parent else {}))['asset']
def snap(text): return EditorState.create(text=text).doc.root.children[0].to_json()


def test_open_edit_library_assigns_distinct_unnamed_subblock_paths(lib):
    block=snap('{ before, { first }, { second, off }, after }')
    block['children'][2]['children'][1]['enabled']=False
    saved=mutate(lib,'save_block',name='Root',snapshot=block)['asset']
    expanded=lib.read('expand',id=saved['id'])['snapshot']
    state=EditorState.create(doc=Document(DocNode('library-root','group','',opaque=False,children=[DocNode.from_json(expanded)],form='root')).to_json(),scope='block')
    def command(kind,**body):
        nonlocal state
        result=mutate(lib,'edit',state=state.to_json(),owner='library-test',library_asset_id=saved['id'],command={'type':kind,'revision':state.revision,**body})
        state=EditorState.from_json(result['state'])
    command('LocateDetails',id=expanded['id'])
    command('ReplaceItem',id=expanded['children'][2]['children'][0]['id'],text='edited')
    assert state.doc.root.children[0].children[2].children[0].raw=='edited'
    assert not state.doc.root.children[0].children[2].children[1].enabled
    assert not state.doc.root.children[0].children[1].meta.get('source')
    # Unnamed siblings receive stable names; Source resolves each unique path.
    children=[a for a in lib.read()['assets'] if a.get('owner_id')]
    assert [a['path'] for a in children]==['Root.Block','Root.Block 2']
    assert lib.read('resolve',path=children[0]['path'])['id']==children[0]['id']
    typed=EditorState.create(text='['+children[0]['path']+']: { literal }')
    result=mutate(lib,'edit',state=typed.to_json(),owner='typed-test',command={'type':'LocateDetails','revision':typed.revision,'id':typed.doc.root.children[0].id})
    assert result['state']['doc']['root']['children'][0]['meta']['source']['id']==children[0]['id']
    paths=[a['path'] for a in children]
    for _ in range(2):
        current=lib.read('get',id=saved['id'])
        mutate(lib,'save_block',id=saved['id'],version=current['version'],name='Root',snapshot=state.doc.root.children[0].to_json())
        assert [a['path'] for a in lib.read()['assets'] if a.get('owner_id')]==paths
        fresh=lib.read('expand',id=saved['id'])['snapshot']
        state=EditorState.create(doc=Document(DocNode('library-root','group','',opaque=False,children=[DocNode.from_json(fresh)],form='root')).to_json(),scope='block')


def test_library_sibling_names_and_paths_unique_across_mutations(lib):
    left=create(lib,'folder','L'); right=create(lib,'folder','R')
    a=create(lib,'block','Combo',left); b=create(lib,'block','Combo',right)
    before=lib.read()
    for action,body in [
        ('create_block',{'name':'Combo','parent_id':left['id']}),
        ('save_folder',{'name':'Combo','parent_id':left['id']}),
        ('move',{'id':b['id'],'version':b['version'],'parent_id':left['id']}),
        ('save_block',{'id':b['id'],'version':b['version'],'parent_id':left['id'],'name':'Combo','snapshot':snap('{ edited }')}),
        ('create_block',{'name':'L.Combo'}),
    ]:
        with pytest.raises(CommandError) as error: mutate(lib,action,**body)
        assert error.value.code=='duplicate_name' and lib.read()==before
    other=create(lib,'block','Other',left); before=lib.read()
    with pytest.raises(CommandError): mutate(lib,'rename',id=other['id'],version=other['version'],name='Combo')
    assert lib.read()==before
    assert lib.read('resolve',path='L.Combo')['id']==a['id']
    assert lib.read('resolve',path='R.Combo')['id']==b['id']


def test_embedded_sibling_collision_rejects_save_rename_and_move(lib):
    block=snap('{ { a }, { b } }')
    for node in block['children']: node.setdefault('meta', {})['name']='Repeated'
    with pytest.raises(CommandError): mutate(lib,'save_block',name='Root',snapshot=block)
    block['children'][1]['meta']['name']='Other'
    root=mutate(lib,'save_block',name='Root',snapshot=block)['asset']
    child=next(a for a in lib.read()['assets'] if a['name']=='Other'); before=lib.read()
    with pytest.raises(CommandError): mutate(lib,'rename',id=child['id'],version=child['version'],name='Repeated')
    assert lib.read()==before
    another=create(lib,'block','Repeated'); before=lib.read()
    with pytest.raises(CommandError): mutate(lib,'move',id=another['id'],version=another['version'],parent_id=root['id'],parent_version=root['version'])
    assert lib.read()==before


def test_entry_scaffolding_shares_visible_parent_namespace_and_rejects_invalid_child_names(lib):
    block=snap('[@schedule]: { 0 - 0.5: { { a } }, 0.5 - 1: { { b } } }')
    for entry in block['children']: entry['children'][0].setdefault('meta', {})['name']='Child'
    with pytest.raises(CommandError) as error: mutate(lib,'save_block',name='Timeline',snapshot=block)
    assert error.value.code=='duplicate_name'
    block['children'][1]['children'][0]['meta']['name']='Other'
    root=mutate(lib,'save_block',name='Timeline',snapshot=block)['asset']
    assert {a['path'] for a in lib.read()['assets'] if a.get('owner_id')==root['id']}=={'Timeline.Child','Timeline.Other'}
    changed=deepcopy(block);changed['children'][1]['children'][0]['meta']['name']='[invalid]'
    before=lib.read()
    with pytest.raises(CommandError) as error: mutate(lib,'save_block',name='Timeline',id=root['id'],version=root['version'],snapshot=changed)
    assert error.value.code=='invalid_name' and lib.read()==before

def test_embedded_subblock_paths_have_no_separate_assets(lib):
    folder=create(lib,'folder','人物'); child=create(lib,'folder','服装',folder); block=create(lib,'block','校服',child)
    response=mutate(lib,'create_block',name='丝带',parent_id=block['id'],version=block['version'])
    tree=lib.read()['assets']; embedded=next(a for a in tree if a.get('owner_id')==block['id'])
    assert embedded['path']=='人物.服装.校服.丝带'
    assert lib.read('expand',id=embedded['id'])['source']['path']==embedded['path']
    connection=sqlite3.connect(lib.path); assert connection.execute("SELECT COUNT(*) FROM assets WHERE kind='block'").fetchone()[0]==1; connection.close()
    mutate(lib,'rename',id=folder['id'],version=folder['version'],name='People')
    assert lib.read('get',id=embedded['id'])['path']=='People.服装.校服.丝带'

def test_embedded_edit_rename_delete_and_stale_versions(lib):
    saved=mutate(lib,'save_block',name='A',snapshot=snap('{ before, { x, off }, after }'))['asset']
    selected=next(a for a in lib.read()['assets'] if a.get('owner_id'))
    result=mutate(lib,'rename',id=selected['id'],version=selected['version'],name='Child')
    assert lib.read('get',id=selected['id'])['name']=='Child'
    latest=lib.read('get',id=selected['id']); changed=deepcopy(latest['data']['snapshot']); changed['children'][1]['enabled']=False
    mutate(lib,'save_block',id=selected['id'],version=latest['version'],name='Child',snapshot=changed)
    assert lib.read('get',id=selected['id'])['data']['snapshot']['children'][1]['enabled'] is False
    with pytest.raises(CommandError): mutate(lib,'delete',id=selected['id'],version=latest['version'])
    latest=lib.read('get',id=selected['id']); mutate(lib,'delete',id=selected['id'],version=latest['version'])
    assert [n['raw'] for n in lib.read('expand',id=saved['id'])['snapshot']['children']]==['before','after']

def test_folder_containment_cycle_and_chain_duplicate_move_rejected(lib):
    root=create(lib,'folder','R'); child=create(lib,'folder','C',root)
    before=lib.read()
    with pytest.raises(CommandError): mutate(lib,'move',id=root['id'],version=root['version'],parent_id=child['id'])
    assert lib.read()==before
    left=create(lib,'class','Left'); right=create(lib,'class','Right')
    mutate(lib,'save_tag',parent_id=left['id'],text='x'); mutate(lib,'save_tag',parent_id=right['id'],text='x')
    before=lib.read()
    with pytest.raises(CommandError): mutate(lib,'move',id=right['id'],version=right['version'],parent_id=left['id'])
    assert lib.read()==before

def test_source_marker_is_not_a_reference_and_deletion_keeps_copies(lib):
    a=mutate(lib,'save_block',name='A',snapshot=snap('{ a }'))['asset']
    node=lib.read('expand',id=a['id'])['snapshot']
    b=mutate(lib,'save_block',name='B',snapshot=snap('{ b }'))['asset']
    node['children'].append(DocNode.from_json(lib.read('expand',id=b['id'])['snapshot']).to_json())
    node['children'][-1]['id']='copy-b'; node['children'][-1]['children'][0]['id']='copy-tag'; node['children'][-1]['sep']=', '
    mutate(lib,'save_block',name='A',id=a['id'],version=a['version'],snapshot=node)
    mutate(lib,'delete',id=b['id'],version=b['version'])
    assert lib.read('expand',id=a['id'])['snapshot']['children'][1]['children'][0]['raw']=='b'

@pytest.fixture
def legacy(tmp_path):
    path=tmp_path/'old.db'; connection=sqlite3.connect(path)
    connection.execute('CREATE TABLE assets(id TEXT PRIMARY KEY,kind TEXT,name TEXT,folder_id TEXT,class_id TEXT,parent_id TEXT,position INT,version INT,data_json TEXT)')
    connection.execute('CREATE TABLE asset_edges(source_id TEXT,target_id TEXT)')
    def put(key,kind,name,parent,data):
        connection.execute('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?)',(key,kind,name,None,parent if kind=='block' else None,parent,connection.total_changes,1,json.dumps(data)))
    put('F','folder','Library',None,{})
    put('C','class','Quality','F',{'autocomplete':True,'attributes':[{'kind':'prompt','snapshot':snap('a')},{'kind':'block','ref_id':'B'},{'kind':'class','ref_id':'E'}]})
    put('D','class','Score','C',{'autocomplete':False,'attributes':[{'kind':'prompt','snapshot':snap('a')},{'kind':'prompt','snapshot':snap('b')}]})
    put('E','class','Light','F',{'autocomplete':False,'attributes':[{'kind':'prompt','snapshot':snap('light')}]})
    nested=snap('{ inside, parked }'); nested['children'][1]['enabled']=False
    put('SUB','block','Inner','B',{'snapshot':nested})
    block=snap('{ before }'); block['meta']={'association':{'mode':'belongs','class_id':'C'}}
    block['children'].append({'ref':'SUB','enabled':True,'sep':', ','instance_meta':{'name':'Inner'}})
    put('B','block','Combo','C',{'snapshot':block}); connection.commit(); connection.close(); return path

def test_explicit_v4_conversion_preserves_original_and_expands_only_in_copy(legacy,tmp_path):
    original=legacy.read_bytes(); target=tmp_path/'new.db'; report=convert(legacy,target)
    assert legacy.read_bytes()==original and report['mapping']['C']=='C'
    lib=AssetLibrary(target)
    try:
        assets=lib.read()['assets']; assert {a['kind'] for a in assets}=={'folder','class','tag','block'}
        assert lib.read('get',id='D')['parent_id']=='C'
        block=lib.read('expand',id='B')['snapshot']; assert block['meta']['pool']=='C'
        assert block['children'][1]['children'][1]['enabled'] is False
        assert 'ref' not in block['children'][1]
        assert not any(a['name']=='a' and a['parent_id']=='C' and a['kind']=='tag' for a in assets)
        assert any(a['name']=='a' and a['parent_id']=='D' and a['kind']=='tag' for a in assets)
        clones=[a for a in assets if a['kind']=='class' and a['name']=='Light' and a['parent_id']=='C']; assert len(clones)==1 and clones[0]['id']!='E'
    finally: lib.close()
    with pytest.raises(CommandError): convert(legacy,target)
    assert legacy.read_bytes()==original

def test_old_library_never_auto_migrates_on_open(legacy):
    original=legacy.read_bytes()
    with pytest.raises(CommandError) as error: AssetLibrary(legacy)
    assert error.value.code=='legacy_library' and legacy.read_bytes()==original

def test_legacy_multi_load_becomes_independent_bound_subblocks_and_keeps_selection():
    state=EditorState.create(text='{ x, y, other }'); root=state.doc.root.children[0]
    root.meta['association']={'mode':'loads','class_ids':['A','B']}
    root.children[0].meta['occurrence']=['A','tag-x']; root.children[1].meta['occurrence']=['B','tag-y']; root.children[1].enabled=False
    original=deepcopy(state.doc.to_json()); converted=convert_document(original,{'A':'FA','B':'FB'})
    block=converted['root']['children'][0]
    assert block['children'][0]['raw']=='other'
    assert [n['meta']['pool'] for n in block['children'][1:]]==['FA','FB']
    assert block['children'][1]['children'][0]['id']==root.children[0].id
    assert block['children'][2]['children'][0]['enabled'] is False
    assert original==state.doc.to_json()
    workflow={'nodes':[{'widgets_values':['plain',json.dumps(original)]}]}; result=convert_workflow(workflow,{'A':'FA','B':'FB'})
    assert 'association' not in result['nodes'][0]['widgets_values'][1] and workflow['nodes'][0]['widgets_values'][1]==json.dumps(original)


def test_legacy_conversion_failure_rolls_back_without_touching_source(legacy,tmp_path):
    connection=sqlite3.connect(legacy); block=json.loads(connection.execute("SELECT data_json FROM assets WHERE id='B'").fetchone()[0]); block['snapshot']['children'].append({'ref':'B'}); connection.execute("UPDATE assets SET data_json=? WHERE id='B'",(json.dumps(block),)); connection.commit(); connection.close()
    original=legacy.read_bytes(); target=tmp_path/'broken-copy.db'
    with pytest.raises(CommandError): convert(legacy,target)
    assert legacy.read_bytes()==original
    connection=sqlite3.connect(target); assert connection.execute('SELECT COUNT(*) FROM assets').fetchone()[0]==0; connection.close()


def test_move_library_block_into_other_block_is_real_containment(lib):
    a=mutate(lib,'save_block',name='A',snapshot=snap('{ a, { sub } }'))['asset']
    b=mutate(lib,'save_block',name='B',snapshot=snap('{ b }'))['asset']
    moved=mutate(lib,'move',id=a['id'],version=a['version'],parent_id=b['id'],parent_version=b['version'])['asset']
    assert moved['owner_id']==b['id'] and moved['name']=='A'
    assert not any(row['id']==a['id'] for row in lib.read()['assets'])
    assert lib.read('expand',id=b['id'])['snapshot']['children'][1]['children'][1]['children'][0]['raw']=='sub'
    with pytest.raises(CommandError): mutate(lib,'move',id=b['id'],version=moved['version'],parent_id=moved['id'],parent_version=moved['version'])


def test_move_embedded_block_between_owners_and_preserve_parked_content(lib):
    block=snap('{ a, { x, off }, z }'); block['children'][1]['children'][1]['enabled']=False
    a=mutate(lib,'save_block',name='A',snapshot=block)['asset']; b=mutate(lib,'save_block',name='B',snapshot=snap('{ b }'))['asset']
    child=next(row for row in lib.read()['assets'] if row.get('owner_id')==a['id'])
    moved=mutate(lib,'move',id=child['id'],version=child['version'],parent_id=b['id'],parent_version=b['version'])['asset']
    assert moved['owner_id']==b['id'] and moved['data']['snapshot']['children'][1]['enabled'] is False
    assert [n['raw'] for n in lib.read('expand',id=a['id'])['snapshot']['children']]==['a','z']


def test_special_entry_scaffolding_does_not_orphan_embedded_tree_rows(lib):
    saved=mutate(lib,'save_block',name='Timeline',snapshot=snap('[@schedule]: { 0 - 1: { a, { b } } }'))['asset']
    child=next(a for a in lib.read()['assets'] if a.get('owner_id'))
    assert child['parent_id']==saved['id']
    assert lib.read('resolve',path=child['path'])['id']==child['id']


def test_root_copy_edit_and_explicit_save_keep_embedded_source_addresses(lib):
    saved=mutate(lib,'save_block',name='Root',snapshot=snap('{ a, { inner } }'))['asset']
    original=next(a for a in lib.read()['assets'] if a.get('owner_id'))
    opened=lib.read('expand',id=saved['id'])['snapshot']
    assert opened['children'][1]['id']==original['node_id']
    opened['children'][0]['raw']='edited'
    mutate(lib,'save_block',id=saved['id'],version=saved['version'],name='Root',snapshot=opened)
    assert lib.read('get',id=original['id'])['data']['snapshot']['children'][0]['raw']=='inner'
