"""Region functionality can be bypassed without changing the editor tree."""
from copy import deepcopy
import json
from pathlib import Path
import sys

import pytest
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from prompt_library_v4._v3 import compile_text, PLv3Error
from prompt_library_v4.assets import validate_snapshot
from prompt_library_v4.commands import apply_command
from prompt_library_v4.compiler import compile_document
from prompt_library_v4.mask_library import MaskLibrary, current, set_current
from prompt_library_v4.mask_resources import fingerprint, resolve
from prompt_library_v4.model import CommandError, EditorState
from prompt_library_v4.node import PromptLibraryV4Node


SOURCE = 'ambient, [@region]: { [base]: { base } [mask: [0, .5, 0, 1]]: { left } [imask: 6]: { right } [fill]: { fill } }'


def command(state, kind, **body):
    return apply_command(state, dict(type=kind, revision=state.revision, **body))


def toggle(state, enabled):
    owner = next(n for n in state.doc.root.walk() if n.form == 'region')
    return command(state, 'SetRegionEnabled', id=owner.id, enabled=enabled)


@pytest.fixture
def library(tmp_path):
    lib = MaskLibrary(tmp_path / 'masks.db', tmp_path / 'input')
    previous = current(); set_current(lib)
    yield lib
    set_current(previous); lib.close()


@pytest.mark.parametrize('mode', ['mask', 'couple'])
def test_off_merges_only_enabled_entries_and_preserves_entire_structure(mode):
    state = EditorState.create(SOURCE)
    owner = state.doc.root.children[1]
    state = command(state, 'SetEnabled', id=owner.children[2].id, enabled=False)
    before = state.doc.to_json()
    off = toggle(state, False)
    assert off.text == state.text
    expected = deepcopy(before)
    expected['root']['children'][1]['meta'] = {'region_enabled': False}
    assert off.doc.to_json() == expected
    assert off.doc.next_id == state.doc.next_id
    result = compile_document(off, seed=4, region_mode=mode, include_metadata=True)
    assert result['prompt'] == result['plain'] == 'ambient, base, left, fill'
    assert not result['mask_bundle']['items']
    assert result['metadata']['document'] == off.doc.to_json()
    assert result['metadata']['source'] == state.text
    restored = EditorState.create(doc=json.loads(json.dumps(off.doc.to_json())))
    assert compile_document(restored, seed=4, region_mode=mode)['prompt'] == result['prompt']
    on = toggle(restored, True)
    assert on.doc.to_json() == before
    assert compile_document(on, seed=4, region_mode=mode)['prompt'] == compile_document(state, seed=4, region_mode=mode)['prompt']


@pytest.mark.parametrize('mode', ['mask', 'couple'])
def test_bypass_at_source_offset_zero_does_not_disable_other_regions(mode):
    state = EditorState.create('[@region]: { [mask: [0,.5,0,1]]: { ordinary } }, [@region]: { [imask: 3]: { spatial } }, { inline }.set{region: [imask: 4]}')
    off = toggle(state, False)
    result = compile_document(off, seed=1, region_mode=mode)
    expected = compile_text('{ { ordinary } }, [@region]: { [imask: 3]: { spatial } }, { inline }.set{region: [imask: 4]}', seed=1, region_mode=mode, ignore_group_seeds=True, centralize_loras=True).text
    assert result['prompt'] == expected
    assert 'IMASK(3' in result['prompt'] and 'IMASK(4' in result['prompt']


@pytest.mark.parametrize('mode', ['mask', 'couple'])
@pytest.mark.parametrize('seed', [3, 17])
def test_bypass_keeps_weight_schedule_random_paths_and_effective_loras(mode, seed):
    state = EditorState.create('[@region]: { [mask: [0,.5,0,1]]: { { a, b, c }.set{shuffle:true,random_select:2}, <lora:test:0.7> }.set{weight:1.2,schedule:{.2,.8}} [fill]: { tail } }.set{weight:1.3}')
    on = compile_document(state, seed=seed, region_mode=mode, include_metadata=True)
    off = compile_document(toggle(state, False), seed=seed, region_mode=mode, include_metadata=True)
    assert off['prompt'] == on['plain'] == off['plain']
    assert off['metadata']['prompt_loras'] == on['metadata']['plain_loras']
    assert ':1.2' in off['prompt'] and ':1.3' in off['prompt']


def test_only_region_containers_accept_the_boolean_function_switch():
    state = EditorState.create('[@region]: { [base]: { text } }, { ordinary }')
    for target in [state.doc.root, state.doc.root.children[0].children[0], state.doc.root.children[1]]:
        with pytest.raises(CommandError): command(state, 'SetRegionEnabled', id=target.id, enabled=False)
    for value in [None, 0, 'false']:
        with pytest.raises(CommandError): toggle(state, value)
    off = toggle(state, False)
    with pytest.raises(CommandError): command(off, 'InsertBlock', parent_id=off.doc.root.children[0].id, text='{ illegal }')
    with pytest.raises(CommandError): command(off, 'SetSettings', id=off.doc.root.children[0].id, patch={'shuffle': True})
    with pytest.raises((CommandError, PLv3Error)): command(off, 'InsertBlock', parent_id=off.doc.root.children[0].children[0].id, form='region')
    added = command(off, 'InsertEntry', parent_id=off.doc.root.children[0].id, entry={'region': {'kind': 'mask', 'mask': [0,1,0,1]}})
    assert all(n.form == 'region_entry' for n in added.doc.root.children[0].children)


def test_bypass_survives_source_edits_and_node_execution_with_independent_enable():
    off = toggle(EditorState.create(SOURCE), False)
    owner = off.doc.root.children[1]
    off = command(off, 'ReplaceText', text=off.text.replace('left', 'changed'))
    assert off.doc.find(owner.id).meta['region_enabled'] is False
    result = compile_document(off, seed=4, region_mode='mask')
    node = PromptLibraryV4Node()
    assert node.execute(doc=json.dumps(off.doc.to_json()), seed=4, region_mode='mask')[0] == result['prompt']
    on = toggle(off, True)
    assert node.IS_CHANGED(doc=json.dumps(off.doc.to_json())) != node.IS_CHANGED(doc=json.dumps(on.doc.to_json()))
    muted = command(off, 'SetEnabled', id=owner.id, enabled=False)
    assert compile_document(muted, seed=4, region_mode='mask')['prompt'] == 'ambient'
    unmuted = command(muted, 'SetEnabled', id=owner.id, enabled=True)
    assert unmuted.doc.find(owner.id).meta['region_enabled'] is False
    assert compile_document(unmuted, seed=4, region_mode='mask')['prompt'] == result['prompt']


def test_saved_region_block_snapshot_retains_switch_and_entry_structure():
    off = toggle(EditorState.create('[@region]: { [base]: { a } [imask: 2]: { b } }'), False)
    snapshot = validate_snapshot(off.doc.root.children[0].to_json())
    assert snapshot['form'] == 'region' and snapshot['meta']['region_enabled'] is False
    saved = deepcopy(off.doc.to_json()); saved['root']['children'] = [snapshot]
    loaded = EditorState.create(doc=saved, scope='block')
    assert all(n.form == 'region_entry' for n in loaded.doc.root.children[0].children)
    assert compile_document(loaded, seed=1, region_mode='mask')['prompt'] == 'a, b'


def test_switch_preserves_user_line_breaks_and_source_conversion_clears_orphan_flag():
    source = '[@region]: {\n  [base]: { a,\n\nb\n\n }\n  [fill]: { mist }\n}'
    state = EditorState.create(source)
    off = toggle(state, False)
    assert off.text == source and toggle(off, True).text == source
    ordinary = command(off, 'ReplaceText', text='{ { a, b }, { mist } }')
    assert all('region_enabled' not in n.meta for n in ordinary.doc.root.walk())


def test_bypassed_picture_binding_is_retained_and_never_reads_or_mounts_image(library):
    path = library.input_root / 'xyz_masks' / 'sample.png'; path.parent.mkdir(parents=True)
    Image.new('RGBA', (2,2), (0,0,0,128)).save(path)
    library.discover(); canvas = library.snapshot()['canvases'][0]
    state = EditorState.create('[@region]: { [imask: 6]: { body } }')
    owner = state.doc.root.children[0]; entry = owner.children[0]
    bound = command(state, 'BindMaskLibrary', id=entry.id, canvas_id=canvas['id'], mask_id='alpha')
    off = toggle(bound, False)
    before = deepcopy(off.doc.to_json()); key = fingerprint(off)
    path.unlink()
    class Unreadable:
        def snapshot(self): raise AssertionError('bypassed regions must not read the resource store')
    result = compile_document(off, seed=1, region_mode='mask', mask_library=Unreadable())
    assert result['prompt'] == 'body' and not result['mask_bundle']['items']
    assert off.doc.to_json() == before and fingerprint(off) == key
    with pytest.raises(CommandError): compile_document(toggle(off, True), seed=1, region_mode='mask')


def test_binding_a_mask_while_bypassed_keeps_a_trusted_projection_and_fallback(library):
    canvas = library.mutate('save', canvas={'kind':'rectangle','name':'Layout','masks':[{'id':'mask','name':'Mask','color':'#77a8f3','coordinates':[.1,.5,.2,.8]}]})
    off = toggle(EditorState.create('[@region]: { [mask: [0,1,0,1]]: { body } }'), False)
    entry_id = off.doc.root.children[0].children[0].id
    bound = command(off, 'BindMaskLibrary', id=entry_id, canvas_id=canvas['id'], mask_id='mask')
    ref = bound.doc.find(entry_id).meta['mask_library']
    assert list(ref['projection']['mask']) == [.1,.5,.2,.8] and ref['fallback']['name'] == 'Mask'
    assert not resolve(bound)[1]['items']
    assert compile_document(toggle(bound, True), seed=1, region_mode='mask')['mask_bundle']['items'][0]['mask_id'] == 'mask'
