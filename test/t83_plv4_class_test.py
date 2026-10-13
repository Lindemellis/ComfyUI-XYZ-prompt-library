"""Folder storage, Class pools, reverse bound-Block candidates and explicit upgrade."""
from copy import deepcopy
import json
import sqlite3
from pathlib import Path
import pytest
from prompt_library_v4.assets import AssetLibrary
from prompt_library_v4.model import EditorState, CommandError
from prompt_library_v4.compiler import compile_document


@pytest.fixture
def library(tmp_path):
    lib = AssetLibrary(tmp_path / 'library.db')
    try: yield lib
    finally: lib.close()


def create(lib, kind, name, parent=None, **body):
    return lib.mutate({'action': 'save_' + kind, 'name': name, 'parent_id': parent, **body})['asset']


def snapshot(text, pool=None):
    value = EditorState.create(text=text).doc.root.children[0].to_json()
    if pool: value.setdefault('meta', {})['pool'] = pool
    return value


def candidates(lib, pool, **args):
    return lib.read('candidates', pool=pool, **args)['candidates'][0]


def test_artist_storage_and_class_binding_are_independent(library):
    artist = create(library, 'folder', 'artist')['id']
    pool = create(library, 'class', 'artists', artist)['id']
    azure = create(library, 'class', 'azurlane', pool)['id']
    anima = create(library, 'folder', 'anima', artist)['id']
    other = create(library, 'folder', 'illustrious', artist)['id']
    root = snapshot('{ a, { azure, parked } }', pool)
    root['children'][1].setdefault('meta', {})['pool'] = azure
    root['children'][1]['children'][1]['enabled'] = False
    saved = create(library, 'block', 'anima1', anima, snapshot=root)
    tree = candidates(library, pool)
    assert [n['id'] for n in tree['children'] if n['kind'] == 'block'] == [saved['id']]
    assert candidates(library, azure)['children'] == [], 'contained subblocks are not separate saved assets'
    nested = create(library, 'block', 'azure1', other, snapshot=root['children'][1])
    assert candidates(library, azure)['children'][0]['id'] == nested['id']
    moved = library.mutate({'action':'move', 'id':saved['id'], 'version':saved['version'], 'parent_id':other})['asset']
    assert moved['data'] == saved['data']
    assert candidates(library, pool)['children'][-1]['source']['path'] == 'artist.illustrious.anima1'
    assert not any(n['kind']=='block' and n['id']==saved['id'] for n in candidates(library,pool,exclude_block=saved['id'])['children'])
    assert not any(n['kind']=='block' and n['id']==saved['id'] for n in candidates(library,pool,exclude_block=saved['id']+'/child')['children'])
    changed = deepcopy(moved['data']['snapshot']); changed['meta']['pool'] = azure
    create(library, 'block', moved['name'], other, id=moved['id'], version=moved['version'], snapshot=changed)
    assert not any(n['kind']=='block' for n in candidates(library,pool)['children'])
    assert {n['id'] for n in candidates(library,azure)['children']} == {saved['id'],nested['id']}


@pytest.mark.parametrize('child,parent', [('tag','folder'),('folder','class'),('block','class'),('document','class')])
def test_invalid_storage_placement_rolls_back(library, child, parent):
    destination = create(library,parent,'Destination')
    before = library.read()
    data = {'snapshot':snapshot('{ a }')} if child=='block' else {'text':'a'} if child=='tag' else {'data':{'doc':EditorState.create('{ a }').doc.to_json()}} if child=='document' else {}
    with pytest.raises(CommandError): create(library,child,'Child',destination['id'],**data)
    assert library.read() == before


def test_folders_do_not_bind_or_offer_source_expansion(library):
    folder = create(library,'folder','Storage')
    state = EditorState.create('{ a }')
    with pytest.raises(CommandError, match='Class'):
        library.mutate({'action':'edit','owner':'test','state':state.to_json(),'command':{'type':'SetMetadata','revision':0,'id':state.doc.root.children[0].id,'patch':{'pool':folder['id']}}})
    with pytest.raises(CommandError): library.read('class_block', id=folder['id'])
    typed = EditorState.create('[Storage]: { a }')
    result = library.mutate({'action':'edit','owner':'test','state':typed.to_json(),'command':{'type':'LocateDetails','revision':0,'id':typed.doc.root.children[0].id}})
    assert not result['state']['doc']['root']['children'][0].get('meta',{}).get('pool')


def test_block_contents_do_not_prevent_class_prompt_collection(library):
    pool = create(library,'class','Pool')['id']
    create(library,'block','Combo',snapshot=snapshot('{ a, b }',pool))
    state = EditorState.create('{ a, b }'); state.doc.root.children[0].meta['pool'] = pool
    library.mutate({'action':'edit','owner':'new','state':state.to_json(),'command':{'type':'SetMetadata','revision':0,'id':state.doc.root.children[0].id,'patch':{'name':'Edited'}}})
    assert {n['name'] for n in candidates(library,pool)['children'] if n['kind']=='tag'} == {'a','b'}
    completion = library.read('complete',all_classes=True)
    assert all(n['kind']=='tag' for n in completion['candidates'][0]['children'])


def test_class_sibling_names_and_cycles_are_guarded(library):
    folder = create(library,'folder','Storage')['id']
    pool = create(library,'class','Pool',folder)
    child = create(library,'class','Child',pool['id'])
    before = library.read()
    with pytest.raises(CommandError): create(library,'folder','Pool',folder)
    with pytest.raises(CommandError): library.mutate({'action':'move','id':pool['id'],'version':pool['version'],'parent_id':child['id']})
    assert library.read()==before


def old_library(path):
    lib = AssetLibrary(path)
    try:
        # A synthetic old Folder-pool store only. New stores never use this mode.
        class LegacyMode:
            def apply(self, conn): conn.execute('UPDATE library_structure SET version=1')
        lib.writer.enqueue(LegacyMode()).result()
        artist = create(lib,'folder','artist')['id']
        azure = create(lib,'folder','azure',artist)['id']
        anima = create(lib,'folder','anima',artist)['id']
        full = create(lib,'folder','full prompt')['id']
        create(lib,'tag','a',artist,text='a'); create(lib,'tag','azure',azure,text='azure')
        value = snapshot('{ a, { azure, off } }',artist)
        value['children'][1].setdefault('meta',{})['pool']=azure
        value['children'][1]['children'][1]['enabled']=False
        saved = create(lib,'block','anima1',anima,snapshot=value)
        create(lib,'block','Full',full,snapshot=snapshot('{ full }'))
        return lib, artist, azure, anima, full, saved
    except BaseException: lib.close(); raise


def test_explicit_conversion_preserves_pool_ids_snapshots_and_storage_only_folders(tmp_path):
    lib, artist, azure, anima, full, saved = old_library(tmp_path/'old.db')
    try:
        before = lib.read(); snapshot_before=deepcopy(saved['data'])
        stale = before['revision']-1
        with pytest.raises(CommandError): lib.mutate({'action':'separate_types','revision':stale})
        assert lib.read()==before
        report = lib.mutate({'action':'separate_types','revision':before['revision']})
        assert Path(report['backup']).is_file() and not lib.read()['legacy_pools']
        assert lib.read('get',id=artist)['kind']=='class'
        assert lib.read('get',id=azure)['parent_id']==artist
        assert lib.read('get',id=anima)['kind']=='folder'
        assert lib.read('get',id=full)['kind']=='folder'
        assert lib.read('get',id=saved['id'])['data']==snapshot_before
        assert lib.read('get',id=artist)['parent_id']==lib.read('get',id=anima)['parent_id']
        assert candidates(lib,artist)['children'][-1]['id']==saved['id']
        state = EditorState.create('{ a }'); state.doc.root.children[0].meta['pool']=artist
        output = compile_document(state,seed=42,region_mode='couple')
        state.doc.root.children[0].meta.pop('pool')
        assert compile_document(state,seed=42,region_mode='couple')==output
        assert lib.mutate({'action':'separate_types','revision':-1})['repeated']
        connection=sqlite3.connect(report['backup'])
        try: assert connection.execute('SELECT kind FROM assets WHERE id=?',(artist,)).fetchone()[0]=='folder'
        finally: connection.close()
    finally: lib.close()


def test_old_check_constraint_upgrade_keeps_data_without_automatic_conversion(tmp_path):
    path=tmp_path/'original.db'; connection=sqlite3.connect(path)
    try:
        connection.execute("CREATE TABLE assets(id TEXT PRIMARY KEY,kind TEXT CHECK(kind IN ('folder','tag','block','document')),name TEXT,parent_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,position INTEGER,version INTEGER,data_json TEXT)")
        connection.execute("INSERT INTO assets VALUES('R','folder','R',NULL,0,1,'{}'),('C','folder','C','R',1,1,'{}')")
        connection.commit()
    finally: connection.close()
    lib=AssetLibrary(path)
    try:
        assert lib.read()['legacy_pools'] and {r['kind'] for r in lib.read()['assets']}=={'folder'}
        assert lib.read('get',id='C')['parent_id']=='R'
    finally: lib.close()
