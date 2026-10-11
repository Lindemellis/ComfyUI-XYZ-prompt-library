"""Scoped weighted conditioning mixtures: structure, portability and combinations."""
from pathlib import Path
import json
import re
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from prompt_library_v3 import compile_text
from prompt_library_v3.document import from_text, render
from prompt_library_v3.diagnostics import PLv3Error
from prompt_library_v4.assets import AssetLibrary
from prompt_library_v4.commands import apply_command
from prompt_library_v4.compiler import compile_document
from prompt_library_v4.model import CommandError, EditorState, projection
from prompt_library_v4.node import PromptLibraryV4Node


def command(state, kind, **args):
    return apply_command(state, {'type': kind, 'revision': state.revision, **args})


def output(source, mode='couple', seed=42):
    state = source if isinstance(source, EditorState) else EditorState.create(source)
    return compile_document(state, seed=seed, region_mode=mode)


def coefficients(text):
    chunks = re.split(r' AVG\(([^)]+)\) ', text)
    weights = [1.0]
    prompts = [chunks[0]]
    for ratio, prompt in zip(chunks[1::2], chunks[2::2]):
        ratio = float(ratio)
        weights = [value * ratio for value in weights] + [1 - ratio]
        prompts.append(prompt)
    return dict(zip(prompts, weights))


def test_scoped_pair_retains_surrounding_text_in_both_operands():
    assert output('a, [@avg]: { 1: { b }, 1: { c } }, d')['prompt'] == 'a, b, d AVG(0.5) a, c, d'


@pytest.mark.parametrize('weights', [(1, 1, 1), (1, 3, 6), (1e308, 1e308, 1e308)])
def test_n_way_average_uses_cumulative_left_weights(weights):
    src = 'a, [@avg]: { ' + ', '.join(f'{w}: {{ {p} }}' for w, p in zip(weights, 'bce')) + ' }, d'
    observed = coefficients(output(src)['prompt'])
    scaled = [w / max(weights) for w in weights]
    assert list(observed) == ['a, b, d', 'a, c, d', 'a, e, d']
    assert list(observed.values()) == pytest.approx([w / sum(scaled) for w in scaled])


def test_zero_empty_disabled_and_all_zero_entries():
    src = 'a, [@avg]: { 0: { gone, <lora:gone:1> }, 1: { }, 3: { c } }, d'
    assert output(src)['prompt'] == 'a, d AVG(0.25) a, c, d'
    state = EditorState.create(src)
    entry = state.doc.root.children[1].children[2]
    state = command(state, 'SetEnabled', id=entry.id, enabled=False)
    assert output(state)['prompt'] == 'a, d'
    restored = command(state, 'SetEnabled', id=entry.id, enabled=True)
    assert output(restored)['prompt'] == output(src)['prompt']
    assert output('a, [@avg]: { 0: { b }, 0: { c } }, d')['prompt'] == 'a, d'
    assert output('a, [@avg]: { }, d')['prompt'] == 'a, d'


def test_multiple_and_nested_averages_use_products_of_local_ratios():
    text = output('a, [@avg]: { 1: { b }, 3: { c } }, [@avg]: { 1: { d }, 1: { e } }, f')['prompt']
    assert coefficients(text) == pytest.approx({'a, b, d, f': .125, 'a, b, e, f': .125,
                                              'a, c, d, f': .375, 'a, c, e, f': .375})
    nested = output('a, [@avg]: { 1: { b, [@avg]: { 1: { d }, 3: { e } } }, 1: { c } }, f')['prompt']
    assert coefficients(nested) == pytest.approx({'a, b, d, f': .125, 'a, b, e, f': .375, 'a, c, f': .5})


def test_ancestor_weight_and_format_apply_inside_each_alternative():
    text = output('a, { x, [@avg]: { 1: { b }, 3: { c } } }.set{weight: 1.2, format: "@$p"}, d')['prompt']
    assert text == 'a, (@x, @b:1.2), d AVG(0.25) a, (@x, @c:1.2), d'
    empty = output('a, { [@avg]: { 1: { }, 1: { b } } }.set{format: "@$p"}, d')['prompt']
    assert empty == 'a, d AVG(0.5) a, @b, d'


def test_schedule_entries_renormalise_and_preserve_context():
    text = output('a, [@avg]: { 1: { b }.set{schedule:{0,0.5}}, 3: { c } }, d')['prompt']
    assert text == '[a, b, d AVG(0.25) a, c, d, :0,0.5] [a, c, d, :0.5,1]'
    text = output('a, [@schedule]: { 0-0.5: { [@avg]: { 1: { b }, 1: { c } } }, 0.5-1: { e } }, d')['prompt']
    assert text == '[a, b, d AVG(0.5) a, c, d, :0,0.5] [a, e, d, :0.5,1]'


@pytest.mark.parametrize('mode,separator', [('couple', '\nCOUPLE '), ('mask', '\nAND ')])
def test_region_then_avg_keeps_the_whole_mixture_inside_one_region(mode, separator):
    source = 'a, [@region]: { [base]: { sky }, [mask:[0,0.5,0,1]]: { [@avg]: { 1: { b }, 3: { c } } } }, d'
    text = output(source, mode)['prompt']
    base, region = text.split(separator)
    assert base == 'a, sky, d'
    assert region == 'MASK(0 0.5, 0 1, 1) a, b, d AVG(0.25) a, c, d'
    assert output(source, mode)['plain'] == 'a, sky, b, d AVG(0.25) a, sky, c, d'


@pytest.mark.parametrize('mode', ['couple', 'mask'])
def test_avg_then_regions_mixes_per_geometry_and_shares_external_regions(mode):
    source = 'a, [@avg]: { 1: { [@region]: { [base]: { sky }, [imask:0]: { b } } }, 3: { [@region]: { [base]: { sea }, [imask:0]: { c } } } }, [@region]: { [fill]: { fill }, [imask:1]: { fixed } }, d'
    text = output(source, mode)['prompt']
    assert 'a, sky, d AVG(0.25) a, sea, d' in text
    assert 'IMASK(0, 1) a, b, d AVG(0.25) a, c, d' in text
    assert text.count('a, fixed, d') == 1 and text.count('a, fill, d') == 1


@pytest.mark.parametrize('mode', ['couple', 'mask'])
def test_complex_schedule_region_avg_lora_combination(mode):
    source = 'a, <lora:ambient:0.8>, [@schedule]: { 0-0.5: { [@region]: { [base]: { sky }, [imask:0]: { [@avg]: { 1: { b, <lora:left:0.4> }, 3: { c, <lora:right:0.7> } } }, [fill]: { bg } } }, 0.5-1: { [@avg]: { 1: { e }, 1: { f } } } }, d'
    text = output(source, mode)['prompt']
    assert 'IMASK(0, 1) a, b, d AVG(0.25) a, c, d' in text
    assert '[a, e, d AVG(0.5) a, f, d, :0.5,1]' in text
    assert text.count('<lora:ambient:0.8>') == 1
    assert text.count('<lora:left:0.4>') == 1 and text.count('<lora:right:0.7>') == 1
    assert '[<lora:left:0.4>, :0,0.5]' in text and '[<lora:right:0.7>, :0,0.5]' in text


def test_same_lora_source_is_collapsed_but_explicit_duplicates_remain():
    text = output('<lora:x:1>, [@avg]: { 1: { b, <lora:x:1> }, 1: { c } }')['prompt']
    assert text.count('<lora:x:1>') == 2


def test_random_select_treats_avg_as_one_direct_child_and_freezes_across_time():
    source = '{ [@avg]: { 1: { b }, 1: { c } }, { chosen }.set{schedule:{0,0.5}} }.set{random_select:1}'
    for seed in range(20):
        text = output(source, seed=seed)['prompt']
        assert text in ('b AVG(0.5) c', '[chosen, :0,0.5]')
    source = '{ p, q }.set{random_select:1}, [@avg]: { 1: { [@region]: { [imask:0]: { b } } }.set{schedule:{0,0.5}} }'
    for seed in range(10):
        text = output(source, seed=seed)['prompt']
        assert text.endswith(('[p, :0.5,1]', '[q, :0.5,1]')), 'ambient random content survives when the timed region disappears'


def test_source_roundtrip_entry_heads_and_disabled_ids_survive_weight_edit():
    source = 'a, [@avg]: {\n 1.0: { b },\n 3: { c }\n}, d'
    assert render(from_text(source, recover=False)) == source
    state = EditorState.create(source)
    first, second = state.doc.root.children[1].children
    state = command(state, 'SetEnabled', id=first.id, enabled=False)
    state = command(state, 'SetAvgWeight', id=first.id, value=2.5)
    assert not state.doc.find(first.id).enabled
    assert state.doc.find(second.id).open.strip() == '3: {'
    state = command(state, 'SetEnabled', id=first.id, enabled=True)
    assert '2.5: { b }' in state.text
    row = projection(state)['tree']['children'][1]['children'][0]
    assert row['settings']['avg_weight'] == 2.5
    assert state.text[row['span'][0]:row['span'][1]].startswith('2.5:')


def test_creation_add_entry_and_invalid_operations_are_atomic():
    state = command(EditorState.create(''), 'InsertBlock', parent_id='i1', form='avg')
    container = state.doc.root.children[0]
    assert [n.form for n in container.children] == ['avg_entry', 'avg_entry']
    state = command(state, 'InsertEntry', parent_id=container.id, entry={'avg_weight': 3})
    entry = state.doc.find(container.id).children[-1]
    frozen = state.to_json()
    bad = [('InsertBlock', {'parent_id': container.id, 'text': '{ b }'}),
           ('InsertEntry', {'parent_id': container.id, 'entry': {'schedule': [0, 1]}}),
           ('MoveBlock', {'id': entry.id, 'parent_id': 'i1'}),
           ('MoveBlock', {'id': entry.id, 'parent_id': container.id, 'edge': 'start'}),
           ('SetMetadata', {'id': container.id, 'patch': {'pool': 'f'}})]
    bad += [('SetSettings', {'id': node.id, 'patch': {key: value}})
            for node in [container, entry] for key, value in [('shuffle', True), ('dropout', .5), ('random_select', [1, 2]), ('format', '@$p')]]
    bad += [('SetAvgWeight', {'id': entry.id, 'value': value}) for value in [-1, True, float('nan'), float('inf'), '2']]
    for kind, args in bad:
        with pytest.raises(CommandError):
            command(state, kind, **args)
        assert state.to_json() == frozen
    state = command(state, 'InsertBlock', parent_id=entry.id, text='{ body }')
    child = state.doc.find(entry.id).children[0]
    moved = command(state, 'MoveBlock', id=child.id, parent_id='i1')
    assert moved.doc.root.children[-1].id == child.id


def test_library_container_is_portable_and_entry_is_not_an_asset(tmp_path):
    state = EditorState.create('[@avg]: { 1: { b }, 3: { c } }')
    container = state.doc.root.children[0]
    library = AssetLibrary(tmp_path / 'avg.db')
    try:
        with pytest.raises(CommandError, match='完整容器'):
            library.mutate({'action': 'save_block', 'name': 'Entry', 'snapshot': container.children[0].to_json()})
        saved = library.mutate({'action': 'save_block', 'name': 'Mean', 'snapshot': container.to_json()})['asset']
        loaded = command(EditorState.create('a, d'), 'InsertLibraryBlock', parent_id='i1',
                         snapshot=saved['data']['snapshot'], source={'kind': 'block', 'id': saved['id']})
        assert output(loaded)['prompt'] == 'a, d, b AVG(0.25) a, d, c'
        assert [n.form for n in loaded.doc.root.children[-1].children] == ['avg_entry', 'avg_entry']
    finally:
        library.close()


@pytest.mark.parametrize('source', ['[@avg]: { prompt }', '[@avg]: { -1: { b } }', '[@avg]: { nan: { b } }', '[@avg]: { 1: b }', '[@avg]: { 1: { b }.set{shuffle:true} }'])
def test_invalid_source_is_a_preserved_draft(source):
    state = command(EditorState.create('{ previous }'), 'ReplaceText', text=source)
    assert not state.valid and state.text == source
    with pytest.raises(CommandError):
        output(state)


def test_node_execution_cache_and_shared_v3_compiler():
    source = 'a, [@avg]: { 1: { b }, 3: { c } }, d'
    state = EditorState.create(source)
    node = PromptLibraryV4Node()
    before = node.IS_CHANGED(doc=json.dumps(state.doc.to_json()))
    assert node.execute(doc=json.dumps(state.doc.to_json())) == ('a, b, d AVG(0.25) a, c, d',) * 2
    entry = state.doc.root.children[1].children[0]
    changed = command(state, 'SetAvgWeight', id=entry.id, value=3)
    assert node.IS_CHANGED(doc=json.dumps(changed.doc.to_json())) != before
    assert compile_text(source).text == output(source)['prompt']


def test_alternative_expansion_has_a_bound():
    source = ', '.join('[@avg]: { 1: { b }, 1: { c } }' for _ in range(9))
    with pytest.raises(PLv3Error, match='256'):
        output(source)
