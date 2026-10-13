"""P4 readonly V3 backup, atomic import, parked presets and node compatibility."""
from copy import deepcopy
import json
from pathlib import Path
import sqlite3
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from prompt_library_v3 import db, repo
from prompt_library_v3.document import from_text, render, DocNode
from prompt_library_v3.compile import compile_text
from prompt_library_v3.library import expand as v3_expand
from prompt_library_v4.assets import AssetLibrary
from prompt_library_v4.migrate_v3 import migrate, SnapshotReader
from prompt_library_v4.model import EditorState, CommandError
from prompt_library_v4.node import PromptLibraryV4Node, PromptLibraryV4MonacoNode


@pytest.fixture
def stores(tmp_path):
    old = tmp_path / 'V3 中文 space.db'
    connection = db.connect_write(old); db.migrate(connection); connection.close()
    writer = repo.WriteQueue(old); writer.start()
    new = AssetLibrary(tmp_path / 'v4.db')
    yield old, writer, new
    writer.stop(timeout=3); new.close()


def write(writer, operation): return writer.enqueue(operation).result()


def test_import_presets_disabled_nodes_order_weights_and_shared_references(stores):
    old, writer, new = stores
    folder = write(writer, repo.CreateFolderOp('Characters'))
    child = write(writer, repo.CreateGroupOp('Child', folder_id=folder))
    a = write(writer, repo.AddItemOp(child, text='blue dress', weight=1.3))
    b = write(writer, repo.AddItemOp(child, kind='lora', text='<lora:cloth:0.7>'))
    child_preset = write(writer, repo.SavePresetOp(child, 'Selected', {'items': [b], 'settings': {'schedule': [0.2, 0.9]}}))
    parent = write(writer, repo.CreateGroupOp('Parent', folder_id=folder, settings={'shuffle': True}))
    before = write(writer, repo.AddItemOp(parent, text='before'))
    ref = write(writer, repo.AddItemOp(parent, kind='ref', ref_group_id=child))
    after = write(writer, repo.AddItemOp(parent, text='after'))
    body = {'items': [after, ref], 'children': {str(ref): {'mode': 'preset', 'preset_id': child_preset}}, 'weights': {str(after): 1.1}, 'settings': {'format': ['#'], 'shuffle': True}}
    parent_preset = write(writer, repo.SavePresetOp(parent, 'Linked', body))
    doc = from_text('a, [@region]: { [base]: { background }, [imask: 0]: { dress } }, z')
    doc.root.children[-1].enabled = False
    write(writer, repo.SaveDocumentOp('Whole document', render(doc), json.dumps(doc.to_json()), folder))
    baseline = SnapshotReader(old).tables
    report = migrate(old, new)
    assert report['counts']['folders'] == 3 and report['counts']['documents'] == 1
    assert SnapshotReader(old).tables == baseline
    assert Path(report['backup']).is_file()
    imported = new.read('expand', id=report['mapping']['presets'][str(parent_preset)])['snapshot']
    selected = imported['children']
    assert selected[0]['enabled'] and selected[1]['enabled'] and not selected[2]['enabled']
    child_snap = selected[1]
    assert not child_snap['children'][1]['enabled']
    assert child_snap['meta']['source']['id'] == report['mapping']['presets'][str(child_preset)]
    for mode in ('couple', 'mask'):
        expected = v3_expand(parent, body=body, reader=SnapshotReader(old))
        for plain in (False, True):
            args = dict(seed=42, region_mode=mode, ignore_regions=plain, ignore_group_seeds=True)
            assert compile_text(render(DocNode.from_json(imported)), **args).text == compile_text(expected, **args).text
    saved_doc = new.read('get', id=next(iter(report['mapping']['documents'].values())))['data']['doc']
    assert saved_doc['root']['children'][-1]['enabled'] is False
    assert render(EditorState.create(doc=saved_doc).doc) == render(doc)
    original_tree = new.read()
    repeated = migrate(old, new)
    assert repeated['repeated'] and new.read() == original_tree
    assert new.read('get', id=report['mapping']['groups'][str(parent)]['folder'])['data']['autocomplete'] is False
    write(writer, repo.AddItemOp(parent, text='changed after import'))
    with pytest.raises(CommandError) as error: migrate(old, new)
    assert error.value.code == 'changed_v3' and new.read() == original_tree


def test_nested_snapshot_preset_and_region_document_survive(stores):
    old, writer, new = stores
    outer = write(writer, repo.CreateGroupOp('Outer'))
    child = write(writer, repo.CreateGroupOp('Child', parent_group_id=outer))
    x = write(writer, repo.AddItemOp(child, text='x'))
    y = write(writer, repo.AddItemOp(child, text='y'))
    ref = write(writer, repo.AddItemOp(outer, kind='ref', ref_group_id=child))
    preset = write(writer, repo.SavePresetOp(outer, 'Snapshot', {'items': [ref], 'children': {str(ref): {'mode': 'snapshot', 'items': [y], 'weights': {str(y): .8}, 'settings': {'region': {'kind': 'imask', 'imask': 0}}}}}))
    report = migrate(old, new)
    snapshot = new.read('expand', id=report['mapping']['presets'][str(preset)])['snapshot']
    assert snapshot['children'][0]['children'][0]['enabled'] and not snapshot['children'][0]['children'][1]['enabled']
    assert len([a for a in new.read()['assets'] if a['kind'] == 'folder']) == 2
    parent_folder = report['mapping']['groups'][str(outer)]['folder']
    subfolder = new.read('get', id=report['mapping']['groups'][str(child)]['folder'])
    assert subfolder['parent_id'] == parent_folder and subfolder['path'] == 'Outer.Outer.Child'
    assert 'IMASK' in PromptLibraryV4Node().execute(render(DocNode.from_json(snapshot)), seed=3)[0]


def test_import_failure_rolls_back_new_objects_and_retains_backup(stores):
    old, writer, new = stores
    good = write(writer, repo.CreateGroupOp('First valid'))
    write(writer, repo.AddItemOp(good, text='good'))
    bad = write(writer, repo.CreateGroupOp('Later invalid'))
    write(writer, repo.AddItemOp(bad, text='{ invalid'))
    baseline = new.read()
    with pytest.raises(Exception): migrate(old, new)
    assert new.read() == baseline
    assert list((new.path.parent / 'backups').glob('*.db'))


@pytest.mark.parametrize('node_type', [PromptLibraryV4Node, PromptLibraryV4MonacoNode])
@pytest.mark.parametrize('mode', ['couple', 'mask'])
def test_v4_nodes_ignore_group_seeds_even_without_editor_doc(node_type, mode):
    source = '{ a, b, c, d }.set{shuffle:true, random_select:2, seed:1}, [@region]: { [base]: { scene }, [imask:0]: { figure } }'
    outputs = node_type().execute(source, seed=987654, region_mode=mode)
    expected = tuple(compile_text(source, seed=987654, region_mode=mode, ignore_group_seeds=True, ignore_regions=plain).text for plain in (False, True))
    assert outputs == expected
    assert node_type.INPUT_TYPES()['required']['seed'][1]['control_after_generate']


def test_v4_node_document_authority_drafts_and_cache_policy():
    node = PromptLibraryV4Node()
    state = EditorState.create(text='{ a, b }')
    state.doc.root.children[0].children[1].enabled = False
    saved = json.dumps(state.doc.to_json())
    assert node.execute('wrong stale text', seed=4, doc=saved) == ('a', 'a')
    before = node.IS_CHANGED(doc=saved)
    state.doc.root.children[0].meta['name'] = 'display metadata'
    assert node.IS_CHANGED(doc=json.dumps(state.doc.to_json())) == before
    state.doc.draft = '{ incomplete'
    with pytest.raises(CommandError): node.execute('fallback must not execute', doc=json.dumps(state.doc.to_json()))
    with pytest.raises(ValueError): node.execute('fallback must not execute', doc='{ invalid json')
