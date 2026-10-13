"""Focused Mask Library contract checks; every resource lives in tmp_path."""
import io
import json
from copy import deepcopy
from pathlib import Path
import sys

import numpy as np
from PIL import Image
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from prompt_library_v4.mask_library import MaskLibrary, current, set_current
from prompt_library_v4.mask_images import extract, rectangle
from prompt_library_v4.mask_resources import resolve, fingerprint
from prompt_library_v4.mask_nodes import preview_arrays, PLV4AttachMasks, PLV4MaskPreview
from prompt_library_v4.model import EditorState, CommandError
from prompt_library_v4.commands import apply_command
from prompt_library_v4.compiler import compile_document
from prompt_library_v4.node import PromptLibraryV4Node
from prompt_library_v4.mask_routes import dispatch


@pytest.fixture
def library(tmp_path):
    lib = MaskLibrary(tmp_path / 'masks.db', tmp_path / 'input')
    previous = current(); set_current(lib)
    yield lib
    set_current(previous); lib.close()


def command(state, kind, **kw):
    return apply_command(state, dict(type=kind, revision=state.revision, **kw))


def canvas(library):
    return library.mutate('save', canvas=dict(kind='rectangle', name='Layout', masks=[
        dict(id='left', name='Left', coordinates=[0, .5, 0, 1], color='#ff0000'),
        dict(id='right', name='Right', coordinates=[.5, 1, 0, 1], color='#0000ff')]))


def picture(library, rgba=None, mode='RGBA'):
    path = library.input_root / 'xyz_masks' / 'sample.png'; path.parent.mkdir(parents=True, exist_ok=True)
    pixels = rgba if rgba is not None else np.array([[[0,0,0,255], [255,255,255,128], [0,0,0,255], [255,0,0,0]]], np.uint8)
    Image.fromarray(pixels, mode).save(path)
    library.discover()
    return next(c for c in library.snapshot()['canvases'] if c['kind'] == 'picture'), path


def regions(text='[@region]: { [mask: [0, 1, 0, 1]]: { cat } }'):
    s = EditorState.create(text=text)
    return s, s.doc.root.children[0].children


def test_versions_identity_tombstones_and_monotonic_restore(library):
    c = canvas(library); initial = deepcopy(c)
    c['masks'].reverse(); c['masks'][0]['name'] = 'Renamed'
    c = library.mutate('save', id=c['id'], version=1, canvas=c)
    assert c['version'] == 2 and c['masks'][0]['id'] == 'right'
    with pytest.raises(CommandError, match='another window'):
        library.mutate('save', id=c['id'], version=1, canvas=initial)
    c['masks'] = c['masks'][:1]
    c = library.mutate('save', id=c['id'], version=2, canvas=c)
    assert library.snapshot()['tombstones'][c['id'], 'left']['coordinates'] == [0,.5,0,1]
    restored = library.mutate('save', id=c['id'], version=3, canvas=initial)
    assert restored['version'] == 4 and (c['id'],'left') not in library.snapshot()['tombstones']


@pytest.mark.parametrize('path', ['../outside.png', '/xyz_masks/a.png', 'C:/xyz_masks/a.png', 'xyz_masks/../x.png', 'other/a.png', 'xyz_masks\\a.png'])
def test_path_escape_rejected(library, path):
    with pytest.raises(ValueError): library.path_for(path)


def test_extraction_alpha_area_rgb_black_white_and_soft_edges(library):
    c, path = picture(library)
    image = extract(path.read_bytes())
    assert list(image['masks']) == ['alpha','rgb:000000','rgb:ffffff']
    assert image['has_alpha']
    assert image['masks']['alpha'][0, -1] == 1
    assert image['masks']['rgb:000000'][0, 0] == 1
    assert image['masks']['rgb:000000'][0, 319] > .99
    assert 0 < image['masks']['rgb:ffffff'][0, 190] < 1
    inverted = extract(path.read_bytes(), {'invert_alpha':True})
    np.testing.assert_allclose(image['masks']['alpha'] + inverted['masks']['alpha'], 1)
    rgba = np.array([[[0,0,0,255],[255,255,255,255],[255,0,0,255],[255,0,0,255]]], np.uint8)
    _, path = picture(library, rgba)
    assert list(extract(path.read_bytes())['masks'])[1:] == ['rgb:ff0000','rgb:000000','rgb:ffffff']


def test_no_alpha_tolerance_and_conservative_assignment(library):
    rgb = np.array([[[0,0,0],[0,0,0],[10,0,0],[40,0,0],[255,255,255]]], np.uint8)
    _, path = picture(library, rgb, mode='RGB')
    image = extract(path.read_bytes(), {'count':1,'tolerance':.05})
    assert not image['has_alpha'] and 'alpha' not in image['masks']
    assert image['masks']['rgb:000000'][0, 230] == 1
    assert image['masks']['rgb:000000'][0, 390] == 0


def test_bound_update_delete_fallback_source_and_cache(library):
    c=canvas(library);state,entries=regions();row=entries[0].id
    state=command(state,'BindMaskLibrary',id=row,canvas_id=c['id'],mask_id='left')
    original = deepcopy(state)
    before=fingerprint(state); cache=PromptLibraryV4Node.IS_CHANGED(doc=json.dumps(state.doc.to_json()))
    c['masks'][0]['coordinates']=[.1,.4,.2,.8]
    c=library.mutate('save',id=c['id'],version=1,canvas=c)
    result=compile_document(state,seed=4,region_mode='mask',include_metadata=True)
    assert 'MASK(0.1 0.4, 0.2 0.8' in result['prompt']
    assert result['mask_bundle']['items'][0]['coordinates']==[.1,.4,.2,.8]
    assert result['metadata']['mask_resources']['items'][0]['version']==2
    assert fingerprint(state)!=before and PromptLibraryV4Node.IS_CHANGED(doc=json.dumps(state.doc.to_json()))!=cache
    assert state.doc.to_json()==original.doc.to_json(), 'resolver must not mutate the caller'
    current_fingerprint=fingerprint(state)
    library.mutate('save',canvas=dict(kind='rectangle',name='Unused',masks=[]))
    assert fingerprint(state)==current_fingerprint
    library.mutate('delete',id=c['id'],version=c['version'])
    restored,bundle,_=resolve(state)
    assert not restored.doc.find(row).meta.get('mask_library') and '[0.1, 0.4, 0.2, 0.8]' in restored.text
    assert bundle['items'][0]['coordinates']==[.1,.4,.2,.8]
    set_current(None)
    independent,_,_=resolve(original)
    assert not independent.doc.find(row).meta.get('mask_library') and '[0, 0.5, 0, 1]' in independent.text


def test_source_body_retains_binding_coordinates_detach(library):
    c=canvas(library);s,entries=regions();row=entries[0].id
    s=command(s,'BindMaskLibrary',id=row,canvas_id=c['id'],mask_id='left')
    s=command(s,'ReplaceText',text=s.text.replace('cat','dog'))
    assert s.doc.find(row).meta.get('mask_library')
    s=command(s,'ReplaceText',text=s.text.replace('[0, 0.5, 0, 1]','[0.2, 0.7, 0, 1]'))
    assert not s.doc.find(row).meta.get('mask_library')


@pytest.mark.parametrize('entry', [False, True])
def test_drawn_precision_binding_survives_source_reconcile_settings_and_reopen(library, entry):
    c = canvas(library)
    c['masks'][0]['coordinates'] = [.09999999403953552, .3999999761581421, .11367186903953552, .2359374761581421]
    c = library.mutate('save', id=c['id'], version=c['version'], canvas=c)
    if entry:
        s, entries = regions(); ident = entries[0].id
    else:
        s = EditorState.create(text='{ cat }'); ident = s.doc.root.children[0].id
        s = command(s, 'SetSettings', id=ident, patch={'region': {'kind':'mask','mask':[0,1,0,1]}})
    s = command(s, 'BindMaskLibrary', id=ident, canvas_id=c['id'], mask_id='left')
    s = command(s, 'ReplaceText', text=s.text)
    assert s.doc.find(ident).meta.get('mask_library'), 'identical source cannot unlink a drawn rectangle'
    s = command(s, 'SetSettings', id=ident, patch={'weight':.9})
    assert s.doc.find(ident).meta.get('mask_library'), 'unrelated settings retain the binding'
    reopened = EditorState.create(doc=s.doc.to_json())
    assert reopened.doc.find(ident).meta['mask_library']['mask_id'] == 'left'
    ref = reopened.doc.find(ident).meta['mask_library']
    # Older snapshots may have recorded raw pointer precision. Read them using
    # the writer's projection precision without migrating a personal database.
    ref['projection']['mask'] = c['masks'][0]['coordinates']
    reopened = EditorState.create(doc=reopened.doc.to_json())
    assert reopened.doc.find(ident).meta.get('mask_library')


def test_picture_dedup_manual_restore_disabled_and_content_cache(library):
    c,path=picture(library)
    state,entries=regions('[@region]: { [imask: 7]: { a } [imask: 3]: { b } [imask: 9]: { c } }')
    first,second,manual=[e.id for e in entries]
    for row in [first,second]: state=command(state,'BindMaskLibrary',id=row,canvas_id=c['id'],mask_id='rgb:000000')
    result=compile_document(state,seed=1,region_mode='mask',include_metadata=True)
    assert len(result['mask_bundle']['items'])==1 and 'IMASK(9' in result['prompt']
    assert result['prompt'].count('IMASK(0, 1)')==1 # equal regions merge in shared IR
    restored=command(state,'UnbindMaskLibrary',id=first)
    assert 'imask: 7' in restored.text
    disabled=command(command(state,'SetEnabled',id=first,enabled=False),'SetEnabled',id=second,enabled=False)
    assert not resolve(disabled)[1]['items']
    before=fingerprint(state);Image.new('RGBA',(2,1),(0,0,0,255)).save(path)
    assert fingerprint(state)!=before
    Image.new('RGBA',(2,1),(255,255,255,255)).save(path)
    with pytest.raises(CommandError, match='no longer exists'): resolve(state)
    assert np.isnan(PromptLibraryV4Node.IS_CHANGED(doc=json.dumps(state.doc.to_json())))


def test_registered_old_directory_and_deleted_picture_fallback(library):
    c,path=picture(library)
    s,entries=regions('[@region]: { [imask: 8]: { a } }')
    s=command(s,'BindMaskLibrary',id=entries[0].id,canvas_id=c['id'],mask_id='alpha')
    before=path.read_bytes();library.mutate('directory',directory='new_masks')
    assert len(resolve(s)[1]['items'])==1
    library.mutate('delete',id=c['id'],version=c['version'])
    assert len(resolve(s)[1]['items'])==1 and path.read_bytes()==before
    path.unlink()
    with pytest.raises(CommandError): resolve(s)


def test_slot_history_zero_mask_and_actual_square_returns(library):
    state,_=regions();bundle=resolve(state)[1];key=bundle['items'][0]['key']
    arrays=preview_arrays(bundle,[key,'retired:key'])
    assert arrays[0].shape==(1,512,512,3) and arrays[1].shape==arrays[2].shape==(1,512,512)
    assert arrays[1].sum()==512*512 and not arrays[2].any()
    quantised=rectangle([.001,.499,.002,.998])
    assert quantised.sum()==(int(.499*512)-int(.001*512))*(int(.998*512)-int(.002*512))
    assert quantised[1,0]==1 and quantised[0,0]==quantised[511,0]==0
    # The shared compiler emits six significant digits before PC int quantises.
    assert rectangle([1/512,.5,0,1])[0,0]==1


def test_routes_are_json_safe_and_compile_without_resources_is_unchanged(library):
    from prompt_library_v4._v3 import compile_text
    state=EditorState.create(text='{ .set shuffle: true; alpha, beta, <lora:x:0.7> }')
    result=compile_document(state,seed=1,region_mode='couple')
    assert result['prompt']==compile_text(state.text,seed=1,region_mode='couple',ignore_group_seeds=True,centralize_loras=True).text
    json.dumps(dispatch(library,'preview',{'state':state.to_json()}))
    json.dumps(dispatch(library,'tree',{}))


def test_no_reference_execution_does_not_read_mask_store_and_output_prefix_is_stable():
    class Unavailable:
        def snapshot(self): raise AssertionError('an unrelated store must not be read')
    state=EditorState.create(text='{ a, b }')
    result=compile_document(state,seed=3,region_mode='couple',mask_library=Unavailable())
    outputs=PromptLibraryV4Node().execute(text=state.text,seed=3)
    assert outputs[:2]==(result['prompt'],result['plain']) and len(outputs)==4
    assert PromptLibraryV4Node.RETURN_TYPES[:3]==('STRING','STRING','PLV4_METADATA')


def test_picture_preview_color_does_not_change_source_rgb_or_mask(library):
    c,_=picture(library);s,entries=regions('[@region]: { [imask: 0]: { a } }')
    s=command(s,'BindMaskLibrary',id=entries[0].id,canvas_id=c['id'],mask_id='rgb:000000')
    original=resolve(s)[1]['items'][0]
    c['presentation']={'rgb:000000':{'color':'#cc33aa','name':'Dark'}}
    library.mutate('save',id=c['id'],version=c['version'],canvas=c)
    changed=resolve(s)[1]['items'][0]
    assert changed['color']=='#cc33aa' and changed['mask_id']=='rgb:000000'
    np.testing.assert_array_equal(changed['mask'],original['mask'])


def test_attach_clone_warning_and_dynamic_backend_outputs(library):
    pytest.importorskip('torch')
    from types import SimpleNamespace
    class Clip:
        def __init__(self): self.patcher=SimpleNamespace(model_options={'x-promptcontrol.masks':['existing']})
        def clone(self):
            other=Clip();other.patcher.model_options=dict(self.patcher.model_options);return other
    c,_=picture(library);s,entries=regions('[@region]: { [imask: 0]: { a } }')
    s=command(s,'BindMaskLibrary',id=entries[0].id,canvas_id=c['id'],mask_id='alpha');bundle=resolve(s)[1]
    clip=Clip();result=PLV4AttachMasks().execute(clip,bundle)
    assert clip.patcher.model_options['x-promptcontrol.masks']==['existing']
    assert len(result['result'][0].patcher.model_options['x-promptcontrol.masks'])==2
    assert 'expected IMASK(0), actual IMASK(1)' in result['ui']['mask_warning'][0]
    outputs=PLV4MaskPreview().execute(bundle,json.dumps([bundle['items'][0]['key'],'unused']))
    assert len(outputs['result'])==3 and outputs['result'][2].sum()==0
