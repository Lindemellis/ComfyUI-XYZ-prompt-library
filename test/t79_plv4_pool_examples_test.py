"""Offline coverage for the explicitly isolated examples and copy-only repair."""
from copy import deepcopy
import importlib.util
from pathlib import Path
import sys
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from prompt_library_v4.assets import AssetLibrary, catalog, disambiguate_library_names, encode
from prompt_library_v4.model import EditorState
from prompt_library_v4.compiler import compile_document
from prompt_library_v4._v3 import DocNode

spec = importlib.util.spec_from_file_location('pool_examples', Path(__file__).parent / 'manual/update_xyz_pool_examples.py')
examples = importlib.util.module_from_spec(spec); spec.loader.exec_module(examples)


def test_examples_have_visible_root_and_nested_pool_bindings_and_collection_boundaries(tmp_path):
    library = AssetLibrary(tmp_path / 'test.db')
    try:
        root = library.mutate({'action': 'save_folder', 'name': 'Samples'})['id']
        sample, keys = examples.add_examples(library, root)
        state = EditorState.create(doc=sample['doc']); state.check()
        combo, accessory = state.doc.root.children
        assert combo.meta['pool'] == keys['artist_pool']
        assert accessory.meta['pool'] == keys['accessory_pool']
        assert combo.children[1].meta['pool'] == keys['thick_pool']
        assert not combo.children[2].meta.get('pool')
        assert combo.children[3].meta['pool'] == keys['accessory_pool']
        assert not combo.children[3].children[1].enabled
        ids = [n.id for n in state.doc.root.walk()]; assert len(ids) == len(set(ids))
        for mode in ('couple', 'mask'): compile_document(state, seed=42, region_mode=mode)
        library.mutate({'action': 'observe', 'state': state.to_json(), 'owner': 'test-example'})
        def edit(node, text):
            nonlocal state
            result = library.mutate({'action': 'edit', 'state': state.to_json(), 'owner': 'test-example', 'command': {'type': 'ReplaceItem', 'revision': state.revision, 'id': node.id, 'text': text}})
            state = EditorState.from_json(result['state'])
        edit(combo.children[2].children[0], 'new parent tag')
        edit(state.doc.root.children[0].children[3].children[0], 'new accessory tag')
        tags = {(a['parent_id'], a['name']) for a in library.read()['assets'] if a['kind'] == 'tag'}
        assert (keys['artist_pool'], 'new parent tag') in tags
        assert (keys['accessory_pool'], 'new accessory tag') in tags
        assert (keys['artist_pool'], 'new accessory tag') not in tags
        before = library.read()['assets']; examples.add_examples(library, root)
        assert library.read()['assets'] == before, 'rerun never resets edited existing example assets'
    finally: library.close()


def test_copy_name_repair_preserves_ids_content_and_original_input(tmp_path):
    library = AssetLibrary(tmp_path / 'copy.db')
    snapshot = EditorState.create(text='{ { a }, { b, off } }').doc.root.children[0].to_json()
    for child in snapshot['children']: child.setdefault('meta', {})['name'] = 'Child'
    snapshot['children'][1]['children'][1]['enabled'] = False
    original = deepcopy(snapshot)
    class SeedAndRepair:
        def apply(self, conn):
            for key in ('A', 'B'):
                conn.execute('INSERT INTO assets(id,kind,name,data_json) VALUES(?,?,?,?)', (key, 'block', 'Root', encode({'snapshot': snapshot})))
            return disambiguate_library_names(conn)
    try:
        warnings = library.writer.enqueue(SeedAndRepair()).result(); assert warnings
        assert snapshot == original
        assets = library.read()['assets']; assert len({a['path'] for a in assets}) == len(assets)
        for key in ('A', 'B'):
            result = library.read('expand', id=key)['snapshot']
            assert result['children'][0]['children'][0]['raw'] == 'a'
            assert not result['children'][1]['children'][1]['enabled']
            assert [n.id for n in DocNode.from_json(result).walk()] == [n.id for n in DocNode.from_json(original).walk()]
        for asset in assets: assert library.read('resolve', path=asset['path'])['id'] == asset['id']
    finally: library.close()


def test_update_refuses_any_other_root_before_writing(tmp_path):
    with pytest.raises(ValueError, match='Only the isolated'): examples.update_samples(tmp_path)
    assert not list(tmp_path.iterdir())
