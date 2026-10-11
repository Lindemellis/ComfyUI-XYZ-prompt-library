"""Folder pools: recursive collection, chain dedupe, copies and portable compilation."""
from copy import deepcopy
from pathlib import Path
import sqlite3
import sys
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from prompt_library_v4.assets import AssetLibrary
from prompt_library_v4.model import EditorState, CommandError
from prompt_library_v4.commands import apply_command
from prompt_library_v4.compiler import compile_document
from prompt_library_v4._v3 import PLv3Error

@pytest.fixture
def lib(tmp_path):
    value=AssetLibrary(tmp_path/'pools.db'); yield value; value.close()

def write(lib, action, **body): return lib.mutate({'action':action,**body})
def folder(lib,name,parent=None,autocomplete=False): return write(lib,'save_folder',name=name,parent_id=parent,data={'autocomplete':autocomplete})['id']
def tag(lib,pool,text): return write(lib,'save_tag',parent_id=pool,text=text)['asset']
def snapshot(text): return EditorState.create(text=text).doc.root.children[0].to_json()
def edit(lib,state,kind,**body):
    return EditorState.from_json(write(lib,'edit',state=state.to_json(),owner='test',command={'type':kind,'revision':state.revision,**body})['state'])
def names(lib,pool): return [a['name'] for a in lib.read()['assets'] if a['kind']=='tag' and a['parent_id']==pool]
def bind(state,pool,index=0): state.doc.root.children[index].meta['pool']=pool; return state

def test_completion_memberships_include_opted_out_folders_without_polluting_enabled_cache(lib):
    hidden = folder(lib, 'Hidden')
    enabled = folder(lib, 'Enabled', hidden, autocomplete=True)
    tag(lib, hidden, 'blue eyes')
    tag(lib, enabled, 'green eyes')
    normal = lib.read('complete')
    assert [item['id'] for item in normal['candidates']] == [enabled]
    all_folders = lib.read('complete', all_folders=True)
    assert [item['id'] for item in all_folders['candidates']] == [hidden]
    root = all_folders['candidates'][0]
    assert root['autocomplete'] is False
    assert root['children'][0]['autocomplete'] is True
    assert root['children'][1]['snapshot']['raw'] == 'blue eyes'
    assert lib.read('complete') == normal


def test_class_api_and_metadata_removed(lib):
    with pytest.raises(CommandError): write(lib,'save_class',name='old')
    state=EditorState.create(text='{ a }')
    with pytest.raises(CommandError): apply_command(state,{'type':'SetMetadata','id':state.doc.root.children[0].id,'revision':0,'patch':{'association':{'mode':'none'}}})
    for pool in ([],{},'',1):
        with pytest.raises(CommandError): apply_command(state,{'type':'SetMetadata','id':state.doc.root.children[0].id,'revision':0,'patch':{'pool':pool}})


@pytest.mark.parametrize('form', ['schedule', 'region'])
def test_entry_cannot_be_saved_alone_but_container_and_body_subblock_can(lib, form):
    state = EditorState.create('')
    state = apply_command(state, {'type': 'InsertBlock', 'revision': 0, 'parent_id': state.doc.root.id, 'form': form})
    container = state.doc.root.children[0]
    entry = container.children[0]
    with pytest.raises(CommandError, match='完整容器'):
        write(lib, 'save_block', name='Entry', snapshot=entry.to_json())
    assert not lib.read()['assets']
    saved = write(lib, 'save_block', name='Container', snapshot=container.to_json())['asset']
    assert saved['data']['snapshot']['form'] == form
    state = apply_command(state, {'type': 'InsertBlock', 'revision': state.revision, 'parent_id': entry.id, 'text': '{ body }'})
    child = state.doc.find(entry.id).children[0]
    saved = write(lib, 'save_block', name='Body', snapshot=child.to_json())['asset']
    assert saved['data']['snapshot']['form'] == 'brace'

def test_recursive_collection_stops_at_own_pool_and_never_saves_structure(lib):
    parent=folder(lib,'quality'); child=folder(lib,'score',parent)
    state=bind(EditorState.create(text='{ a, { b, { c } }, { d, { e } } }'),parent)
    state.doc.root.children[0].children[2].meta['pool']=child
    state=edit(lib,state,'SetMetadata',id=state.doc.root.children[0].id,patch={'name':'Quality'})
    assert set(names(lib,parent))=={'a','b','c'} and set(names(lib,child))=={'d','e'}
    assert not [a for a in lib.read()['assets'] if a['kind']=='block']

def test_subtree_dedupe_includes_saved_blocks_and_parked_children(lib):
    parent=folder(lib,'P'); child=folder(lib,'C',parent)
    tag(lib,child,'a'); block=snapshot('{ b, { c } }'); block['children'][1]['children'][0]['enabled']=False
    write(lib,'save_block',name='combo',parent_id=child,snapshot=block)
    state=bind(EditorState.create(text='{ a, b, c, fresh }'),parent)
    edit(lib,state,'SetMetadata',id=state.doc.root.children[0].id,patch={'name':'P'})
    assert names(lib,parent)==['fresh']

def test_chain_dedupe_moves_ancestor_and_rejects_descendant(lib):
    parent=folder(lib,'P'); child=folder(lib,'C',parent); grand=folder(lib,'G',child)
    original=tag(lib,parent,'blue eyes'); moved=tag(lib,grand,'blue eyes')
    assert moved['id']==original['id'] and not names(lib,parent)
    with pytest.raises(CommandError,match='P.C.G'): tag(lib,parent,'blue eyes')
    assert names(lib,grand)==['blue eyes']

def test_sibling_and_different_branch_duplicates_allowed(lib):
    root=folder(lib,'R'); left=folder(lib,'L',root); right=folder(lib,'R2',root)
    assert tag(lib,left,'artist_x')['id']!=tag(lib,right,'artist_x')['id']
    with pytest.raises(CommandError): tag(lib,root,'artist_x')

def test_automatic_collection_classifies_ancestor_tag_downwards(lib):
    parent=folder(lib,'P'); child=folder(lib,'C',parent); old=tag(lib,parent,'score_9')
    state=bind(EditorState.create(text='{ score_9 }'),child)
    edit(lib,state,'SetMetadata',id=state.doc.root.children[0].id,patch={'name':'C'})
    assert not names(lib,parent) and lib.read('get',id=old['id'])['parent_id']==child

def test_drag_move_is_move_and_conflict_rolls_back(lib):
    root=folder(lib,'R'); left=folder(lib,'L',root); right=folder(lib,'R2',root)
    original=tag(lib,root,'x'); moved=write(lib,'move',id=original['id'],version=original['version'],parent_id=left)['asset']
    assert moved['id']==original['id'] and names(lib,left)==['x'] and not names(lib,root)
    tag(lib,right,'x'); before=lib.read()
    with pytest.raises(CommandError): write(lib,'move',id=moved['id'],version=moved['version'],parent_id=root)
    assert lib.read()==before

def test_open_baseline_does_not_restore_manually_deleted_tags(lib):
    pool=folder(lib,'P'); state=bind(EditorState.create(text='{ old }'),pool)
    write(lib,'observe',owner='test',state=state.to_json())
    state=edit(lib,state,'LocateDetails',id=state.doc.root.children[0].id)
    state=edit(lib,state,'SetMetadata',id=state.doc.root.children[0].id,patch={'name':'rename'})
    assert names(lib,pool)==[]
    state=edit(lib,state,'ReplaceItem',id=state.doc.root.children[0].children[0].id,text='new')
    assert names(lib,pool)==['new']
    saved=next(a for a in lib.read()['assets'] if a['kind']=='tag'); write(lib,'delete',id=saved['id'],version=saved['version'])
    write(lib,'observe',owner='test',state=state.to_json())
    edit(lib,state,'SetMetadata',id=state.doc.root.children[0].id,patch={'name':'again'})
    assert names(lib,pool)==[]

def test_continuous_typing_collects_only_completion(lib):
    pool=folder(lib,'P'); state=bind(EditorState.create(text='{ start }'),pool)
    write(lib,'observe',owner='test',state=state.to_json())
    for text in ['{ b }','{ blu }','{ blue eyes }']:
        state=edit(lib,state,'ReplaceText',text=text,defer_pool=True)
        assert names(lib,pool)==[]
    state=EditorState.from_json(write(lib,'sync_pool',owner='test',state=state.to_json())['state'])
    assert names(lib,pool)==['blue eyes']
    state=edit(lib,state,'SetEnabled',id=state.doc.root.children[0].children[0].id,enabled=False)
    state=edit(lib,state,'Delete',id=state.doc.root.children[0].children[0].id)
    assert names(lib,pool)==['blue eyes']


def test_detail_pasted_prompt_list_collects_separate_tags_without_separators(lib):
    pool=folder(lib,'P'); state=bind(EditorState.create(text='{ start }'),pool)
    write(lib,'observe',owner='test',state=state.to_json())
    state=edit(lib,state,'ReplaceItem',id=state.doc.root.children[0].children[0].id,text='solo, blonde hair, ')
    assert names(lib,pool)==['solo','blonde hair']
    assert [node.raw for node in state.doc.root.children[0].children]==['solo','blonde hair']


def test_folder_paste_and_edit_split_items_in_one_transaction_with_original_first_id(lib):
    pool=folder(lib,'P')
    result=write(lib,'save_tag',parent_id=pool,text='solo, blonde hair, a cat. on a mat.')
    assert [asset['name'] for asset in result['assets']]==['solo','blonde hair','a cat.','on a mat.']
    first=result['asset']; assert first['name']=='solo'
    edited=write(lib,'save_tag',parent_id=pool,id=first['id'],version=first['version'],text='1girl, blue eyes, ')
    assert edited['id']==first['id']
    assert [asset['name'] for asset in edited['assets']]==['1girl','blue eyes']
    before=lib.read()
    with pytest.raises(CommandError,match='已在'):
        write(lib,'save_tag',parent_id=pool,id=first['id'],version=edited['asset']['version'],text='changed, blonde hair')
    assert lib.read()==before, 'a later duplicate must roll back the first row edit too'

def test_candidates_include_recursive_folder_tags_and_whole_blocks(lib):
    root=folder(lib,'R'); child=folder(lib,'C',root); tag(lib,root,'a'); tag(lib,child,'b')
    saved=write(lib,'save_block',name='Combo',parent_id=child,snapshot=snapshot('{ c, { d } }'))['id']
    tree=lib.read('candidates',pool=root)['candidates'][0]
    assert tree['kind']=='folder' and tree['name']=='R'
    sub=next(n for n in tree['children'] if n['kind']=='folder')
    assert {n['kind'] for n in sub['children']}=={'tag','block'}
    assert next(n for n in sub['children'] if n['kind']=='block')['source']['id']==saved

def test_subfolder_button_inserts_only_direct_tags_as_temporary_block(lib):
    root=folder(lib,'R'); child=folder(lib,'C',root); deep=folder(lib,'D',child)
    tag(lib,child,'a'); tag(lib,child,'b'); tag(lib,deep,'c')
    write(lib,'save_block',name='Combo',parent_id=child,snapshot=snapshot('{ d }'))
    source=lib.read('folder_block',id=child,fill=True)
    assert source['snapshot']['meta']['pool']==child
    assert all(n['enabled'] for n in source['snapshot']['children'])
    assert [n['raw'] for n in source['snapshot']['children']]==['a','b']
    before=[a['id'] for a in lib.read()['assets'] if a['kind']=='block' and '/' not in a['id']]
    state=EditorState.create(text='{ before }'); state=edit(lib,state,'InsertLibraryBlock',parent_id=state.doc.root.children[0].id,edge='end',**{k:source[k] for k in ['snapshot','source']})
    assert [a['id'] for a in lib.read()['assets'] if a['kind']=='block' and '/' not in a['id']]==before
    assert state.doc.root.children[0].children[1].meta['pool']==child

def test_folder_drag_snapshot_empty_and_no_inheritance(lib):
    pool=folder(lib,'P'); tag(lib,pool,'a')
    source=lib.read('folder_block',id=pool)
    assert source['snapshot']['children']==[] and source['snapshot']['meta']['pool']==pool
    state=bind(EditorState.create(text='{ { b } }'),pool)
    assert not state.doc.root.children[0].children[0].meta.get('pool')
    other=folder(lib,'Existing pool')
    state.doc.root.children[0].meta['pool']=other
    parent_id=state.doc.root.children[0].id
    state=edit(lib,state,'InsertLibraryBlock',parent_id=parent_id,edge='end',snapshot=source['snapshot'],source=source['source'])
    parent=state.doc.root.children[0]
    assert parent.id==parent_id and parent.meta['pool']==other
    inserted=parent.children[-1]
    assert inserted.meta['pool']==pool and inserted.enabled and inserted.children==[]
    assert inserted.meta['source']['id']==pool
    assert not [a for a in lib.read()['assets'] if a['kind']=='block']

def test_completion_calculated_from_enabled_folders_without_data_copy(lib):
    root=folder(lib,'R',autocomplete=True); child=folder(lib,'C',root); tag(lib,child,'a')
    snap=snapshot('{ b, { parked } }'); snap['children'][1]['enabled']=False
    write(lib,'save_block',name='Combo',parent_id=child,snapshot=snap)
    before=lib.read(); result=lib.read('complete')
    assert result['candidates'][0]['children'][0]['children'][1]['snapshot']['children'][1]['enabled'] is False
    assert lib.read()==before and lib.read('complete')==result
    current=lib.read('get',id=root); write(lib,'save_folder',id=root,version=current['version'],name='R',data={'autocomplete':False})
    assert lib.read('complete')['candidates']==[]

def test_block_save_is_snapshot_with_no_internal_assets_and_overwrite_is_explicit(lib):
    pool=folder(lib,'P'); first=write(lib,'save_block',name='A',parent_id=pool,snapshot=snapshot('{ a, { b, off } }'))['asset']
    expanded=lib.read('expand',id=first['id']); second=write(lib,'save_block',name='B',parent_id=pool,snapshot=expanded['snapshot'])['asset']
    changed=deepcopy(expanded['snapshot']); changed['children'][0]['raw']='changed'
    write(lib,'save_block',name='A',id=first['id'],version=first['version'],snapshot=changed)
    assert lib.read('expand',id=second['id'])['snapshot']['children'][0]['raw']=='a'
    conn=sqlite3.connect(lib.path)
    assert conn.execute("SELECT COUNT(*) FROM assets WHERE kind='block'").fetchone()[0]==2
    assert not conn.execute("SELECT name FROM sqlite_master WHERE name='asset_edges'").fetchone(); conn.close()
    with pytest.raises(CommandError) as error: write(lib,'save_block',name='A',id=first['id'],version=first['version'],snapshot=changed)
    assert error.value.code=='asset_conflict'

def test_pool_metadata_does_not_change_compilation_or_require_library(lib):
    pool=folder(lib,'P'); state=EditorState.create(text='{ a, { b, c }.set{shuffle: true} }, [@schedule]: { 0 - 0.5: x, 0.5 - 1: y }')
    before=compile_document(state,seed=42,region_mode='couple')
    state.doc.root.children[0].meta['pool']=pool
    write(lib,'delete',id=pool,version=lib.read('get',id=pool)['version'])
    assert compile_document(state,seed=42,region_mode='couple')==before
    edit(lib,state,'SetMetadata',id=state.doc.root.children[0].id,patch={'name':'portable'})

def test_invalid_library_insert_rolls_back_tags_and_snapshot(lib):
    pool=folder(lib,'P'); state=bind(EditorState.create(text='[@region]: { [base]: { a } }'),pool); before=lib.read()
    with pytest.raises((CommandError,PLv3Error)): edit(lib,state,'InsertLibraryBlock',parent_id=state.doc.root.children[0].children[0].id,edge='end',snapshot=snapshot('[@region]: { [base]: { x } }'),source={'kind':'block','id':'none'})
    assert lib.read()==before


@pytest.mark.parametrize('form', ['schedule', 'region'])
def test_saved_container_drops_old_pool_binding_without_losing_entry_pool(lib, form):
    state = EditorState.create('')
    state = apply_command(state, {'type': 'InsertBlock', 'revision': 0, 'parent_id': state.doc.root.id, 'form': form})
    container = state.doc.root.children[0]
    container.meta['pool'] = 'old-container-pool'
    container.children[0].meta['pool'] = 'entry-pool'
    saved = write(lib, 'save_block', name='Container', snapshot=container.to_json())
    value = lib.read('get', id=saved['id'])['data']['snapshot']
    assert not value['meta'].get('pool')
    assert value['children'][0]['meta']['pool'] == 'entry-pool'
    assert container.meta['pool'] == 'old-container-pool'
