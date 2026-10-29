"""MOSS output contract, mode restoration, caption isolation and final snapshots."""
from copy import deepcopy
import json
from pathlib import Path
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from prompt_library_v4.commands import apply_command
from prompt_library_v4.compiler import compile_document
from prompt_library_v4.model import EditorState, CommandError, projection
from prompt_library_v4.node import PromptLibraryV4Node
from prompt_library_v4.moss_upsample_node import PLV4MOSSUpsample
from prompt_library_v4.sentence_case import sentence_case
from prompt_library_v4.image_metadata_node import PLV4ImageMetadataNode
from prompt_shared.image_metadata import check_prompt, decode_parameters

SOURCE = 'a shop. [@region mask: [0, 0.5, 0, 1]]: { a woman. } [@region mask: [0.5, 1, 0, 1]]: { a cat. }'


def moss(text=SOURCE):
    state = EditorState.create(text)
    state.doc.root.meta['output_mode'] = 'moss'
    return state


def compile(state, **kwargs):
    return compile_document(state, seed=17, region_mode='couple', width=1024, height=768, include_metadata=True, **kwargs)


def layout_of(source, **kwargs):
    return json.loads(compile(moss(source), **kwargs)['prompt'])


def command(state, **values):
    return apply_command(state, dict(values, revision=state.revision))


def regions(state):
    return [n for n in state.doc.root.children if n.form == 'moss_region']


def test_layout_coordinates_and_no_ambient_injection():
    state = moss(); before = state.to_json()
    result = compile(state)
    layout = json.loads(result['prompt'])
    assert layout['summary'] == {'caption': 'a shop.'}
    assert [i['caption'] for i in layout['items']] == ['a woman.', 'a cat.']
    assert [i['label'] for i in layout['items']] == ['object', 'object']
    assert [i['bbox'] for i in layout['items']] == [[-384, -512, 384, 0], [-384, 0, 384, 512]]
    assert layout['bbox_format'] == 'yxyx'
    assert state.to_json() == before
    assert check_prompt(result['metadata'])


@pytest.mark.parametrize('text', ['a woman, blue eyes. she smiles.', 'an empty street.', '', r'copyright:fate \(series\)'])
def test_caption_only_is_plain_text_with_escapes_as_typed(text):
    result = compile(moss(text))
    assert result['prompt'] == text
    assert result['metadata']['moss']['items'] == []


@pytest.mark.parametrize('source,summary', [
    ('{ red }.set{type: palette} a cat.', {'caption': 'a cat.', 'palette': ['red']}),
    ('{ poster }.set{type: meta} a cat.', {'meta': ['poster'], 'caption': 'a cat.'}),
    ('[@moss]: { canvas: collage }', {'canvas': 'collage'}),
])
def test_anything_beyond_a_caption_is_a_layout(source, summary):
    assert json.loads(compile(moss(source))['prompt']) == {'summary': summary}


@pytest.mark.parametrize('width,height,code', [(None,None,'missing_dimensions'), (1024,None,'missing_dimensions'),
    (None,768,'missing_dimensions'), (0,768,'invalid_dimensions'), (1023,768,'invalid_dimensions'),
    (True,768,'invalid_dimensions'), (1024,768.0,'invalid_dimensions')])
def test_dimensions(width, height, code):
    with pytest.raises(CommandError) as exc:
        compile_document(moss(), seed=1, region_mode='couple', width=width, height=height)
    assert exc.value.code == code


@pytest.mark.parametrize('width,height', [(None,None), (1024,None), (None,768)])
def test_moss_preview_without_resolved_dimensions_keeps_caption_and_fraction_box(width, height):
    state = moss(); before = state.to_json()
    result = compile_document(state, seed=17, region_mode='couple', preview=True,
                              width=width, height=height, include_metadata=True)
    layout = json.loads(result['prompt'])
    assert layout['summary']['caption'] == 'a shop.'
    assert layout['bbox_coord_space'] == 'normalized'
    assert layout['bbox_format'] == 'yxyx'
    assert [i['bbox'] for i in layout['items']] == [[0,0,1,0.5],[0,0.5,1,1]]
    assert result['plain'] == 'a shop. a woman. a cat.'
    assert result['preview_only'] and '比例坐标' in result['preview_notice']
    assert 'metadata' not in result
    assert state.to_json() == before
    with pytest.raises(CommandError, match='connect'):
        PromptLibraryV4Node().execute(doc=json.dumps(state.doc.to_json()),width=width,height=height)


def test_moss_preview_with_dimensions_matches_execution():
    state = moss()
    preview = compile(state, preview=True)
    actual = compile(state)
    assert {k:v for k,v in preview.items() if k != 'mask_bundle'} == {k:v for k,v in actual.items() if k != 'mask_bundle'}
    assert preview['preview_only'] is False and not preview['preview_notice']
    assert json.loads(preview['prompt'])['bbox_coord_space'] == 'abs_centralized'


def test_moss_plain_preview_does_not_need_dimensions():
    result = compile_document(moss('a cat.'),seed=0,region_mode='couple',preview=True)
    assert result['prompt'] == result['plain'] == 'a cat.'
    assert not result['preview_only'] and not result['preview_notice']


@pytest.mark.parametrize('source', ['', 'a cat.', '[@region mask: [0, 1, 0, 1]]: { }', '[@avg]: {1:{hidden}}'])
def test_moss_simple_execution_without_dimensions_and_saving_metadata(source):
    state = moss(source)
    result = compile_document(state,seed=0,region_mode='couple',include_metadata=True)
    assert not result['preview_only']
    assert result['metadata']['moss']['items'] == []
    assert check_prompt(result['metadata'])
    outputs = PromptLibraryV4Node().execute(doc=json.dumps(state.doc.to_json()))
    assert outputs[0] == result['prompt']
    saved = PLV4ImageMetadataNode().execute(outputs[2])[0]
    assert decode_parameters(saved['overrides']['additional_data'])['positive']['prompt'] == result['prompt']


def test_moss_region_off_needs_no_dimensions_and_merges_into_summary():
    state = moss('a shop. [@region mask: [0, 0.5, 0, 1], type: character]: { a woman. { 1girl }.set{type: tag} { red }.set{type: palette} }')
    state = command(state, type='SetRegionEnabled', id=state.doc.root.id, enabled=False)
    result = compile_document(state,seed=0,region_mode='couple',include_metadata=True)
    assert json.loads(result['prompt']) == {'summary': {'caption': 'a shop. a woman. 1girl', 'palette': ['red']}}
    assert check_prompt(result['metadata'])


def test_moss_preview_rejects_invalid_supplied_dimension():
    with pytest.raises(CommandError) as exc:
        compile_document(moss(),seed=0,region_mode='couple',preview=True,width=123)
    assert exc.value.code == 'invalid_dimensions'


def test_moss_preview_preserves_pixel_and_mixed_source_units():
    state = moss('[@region mask: [0, 512, 16, 640]]: { a cat. } [@region mask: [0.5, 1, 0, 1]]: { a woman. }')
    result = compile_document(state,seed=0,region_mode='couple',preview=True)
    layout = json.loads(result['prompt'])
    assert layout['bbox_coord_space'] == 'source_preview'
    assert layout['items'][0]['bbox'] == [16,0,640,512]
    assert layout['items'][0]['bbox_units'] == 'abs'
    assert layout['items'][1]['bbox_units'] == 'normalized'
    assert 'bbox_units' not in compile(state)['prompt']


def test_preview_endpoint_is_explicit_and_execution_stays_strict():
    from prompt_library_v4.routes import dispatch
    body = dict(state=moss().to_json(), seed=0, region_mode='couple')
    with pytest.raises(CommandError): dispatch('compile',body)
    result = dispatch('compile',dict(body,preview=True))
    assert result['ok'] and result['preview_only']


@pytest.mark.parametrize('source', ['[@schedule]: { 0-0.5: { hidden. }, 0.5-1: { also hidden. } }',
    '[@avg]: { 1: { hidden. }, 1: { also hidden. } }', '{ hidden. }.set{schedule: {0, 0.5}}',
    '{ hidden. }.set{region: {mask: [0, 1, 0, 1]}}', '{ hidden. }.set{region: {base}}',
    '[@region]: { [mask: [0, 1, 0, 1]]: { hidden. } }'])
def test_unsupported_subtrees_are_excluded_and_mode_restores(source):
    state = moss('visible. ' + source)
    before = deepcopy(state.doc.to_json())
    assert compile(state)['prompt'] == 'visible.'
    assert state.doc.to_json() == before
    rows = projection(state)['tree']['children']
    assert any(r.get('mode_disabled') for r in rows)
    state.doc.root.meta['output_mode'] = 'prompt_control'
    assert not any(r.get('mode_disabled') for r in projection(state)['tree']['children'])
    assert 'hidden.' in compile(state)['prompt']


def test_disabled_region_does_not_emit_item():
    state = moss(); regions(state)[0].enabled = False; regions(state)[1].enabled = False
    assert compile(state)['prompt'] == 'a shop.'


def test_types_text_and_controls_never_leak_into_layout():
    literal = '春日, 花店.\n"OPEN"'
    state = moss('[@region mask: [0, 0.5, 0, 1], type: character]: { a woman. } '
                 '[@region mask: [0.5, 1, 0, 1], type: text]: { a sign. { ' + literal + ' }.set{type: text} }')
    regions(state)[0].meta['moss'] = {'upsample': True}
    result = compile(state); layout = json.loads(result['prompt'])
    assert [i['label'] for i in layout['items']] == ['character', 'text']
    assert layout['items'][1]['text'] == literal
    assert 'upsample' not in result['prompt']
    assert result['metadata']['moss']['items'][0] == {'id': regions(state)[0].id, 'upsample': True}


def test_text_block_keeps_line_breaks_and_drops_layout_indent():
    layout = layout_of('[@region mask: [0, 1, 0, 1], type: text]: {\n    {\n        OPEN\n        NOW, 50% off\\nTODAY\n    }.set{type: text}\n    { 2nd }.set{type: text}\n}')
    assert layout['items'][0] == {'label': 'text', 'text': 'OPEN\nNOW, 50% off\nTODAY\n2nd', 'bbox': [-384, -512, 384, 512]}


def test_empty_caption_with_visible_text_is_an_item():
    layout = layout_of('[@region mask: [0, 1, 0, 1], type: text]: { { HELLO }.set{type: text} }')
    assert layout['items'][0]['text'] == 'HELLO' and 'caption' not in layout['items'][0]


def test_tags_and_palettes_fill_their_own_fields_concatenated_without_duplicates():
    layout = layout_of('{ cream, navy }.set{type: palette} a shop. { navy, gold }.set{type: palette} '
                       '[@region mask: [0, 1, 0, 1], type: character]: { a girl. { 1girl, saber \\(fate\\) }.set{type: tag} '
                       '{ 1girl, { solo } }.set{type: tag} { red }.set{type: palette} }')
    assert layout['summary'] == {'caption': 'a shop.', 'palette': ['cream', 'navy', 'gold']}
    assert layout['items'][0]['tags'] == ['1girl', 'saber (fate)', 'solo']
    assert layout['items'][0]['palette'] == ['red']


def test_moss_settings_block_writes_meta_and_canvas():
    assert layout_of('[@moss]: { canvas: multi_panel } { poster, { anime illustration } }.set{type: meta} a cat.')['summary'] == {
        'meta': ['poster', 'anime illustration'], 'canvas': 'multi_panel', 'caption': 'a cat.'}
    assert compile(moss('[@moss]: { } a cat.'))['prompt'] == 'a cat.'


@pytest.mark.parametrize('source,reason', [
    ('{ a { x }.set{type: tag} }', 'A subblock inherits its type from the block above it'),
    ('{ x }.set{type: tag}', 'Tag is not available at the top level'),
    ('{ x }.set{type: text}', 'Text is not available at the top level'),
    ('[@region mask: [0, 1, 0, 1]]: { { x }.set{type: meta} }', 'Meta is not available in a region'),
    ('[@region mask: [0, 1, 0, 1]]: { { x }.set{type: text} }', 'Text needs a region with type: text'),
    ('{ [@region mask: [0, 1, 0, 1]]: { x } }', 'A region block belongs at the top level'),
    ('[@moss]: { } [@moss]: { canvas: collage }', 'Only the first [@moss] settings block is used'),
])
def test_strict_structure_greys_out_hand_written_violations(source, reason):
    state = moss(source)
    reasons = []
    def walk(row):
        if row.get('mode_disabled'): reasons.append(row['mode_disabled'])
        for child in row['children']: walk(child)
    walk(projection(state)['tree'])
    assert reason in reasons
    prompt = compile(state)['prompt']
    caption = json.loads(prompt)['summary'].get('caption', '') if prompt.startswith('{') else prompt
    assert 'x' not in caption


def test_moss_syntax_round_trips_byte_for_byte_with_its_forms():
    from prompt_library_v4._v3 import from_text, render
    source = ('[@moss]: { canvas: collage }\n{ red }.set{type: palette}\na shop.\n'
              '[@region mask: [0, 0.5, 0, 1], type: text]: {\n    a sign.\n    { x }.set{type: tag}\n    { OPEN\nNOW }.set{type: text}\n}')
    doc = from_text(source)
    assert render(doc) == source
    assert [n.form for n in doc.root.children if n.kind == 'group'] == ['moss', 'brace', 'moss_region']


def test_nested_region_blocks_are_a_hard_error_as_before():
    view = projection(moss('[@region mask: [0, 1, 0, 1]]: { [@region mask: [0, 1, 0, 1]]: { x } }'))
    assert view['valid'] is False and any(d['code'] == 'E01' for d in view['diagnostics'])


def test_structural_commands_only_offer_legal_targets():
    state = moss('a shop. { caption { sub } }')
    caption = state.doc.root.children[1]
    sub = caption.children[-1]
    state = command(state, type='InsertBlock', parent_id=state.doc.root.id, form='moss_region')
    region = regions(state)[0]
    state = command(state, type='InsertBlock', parent_id=region.id, text='{ }')
    inner = state.doc.find(region.id).children[-1]
    for form in ('tag', 'region', 'avg'):
        with pytest.raises(CommandError):
            command(state, type='InsertBlock', parent_id=state.doc.root.id, form=form)
    with pytest.raises(CommandError):
        command(state, type='InsertBlock', parent_id=caption.id, form='moss_region')
    with pytest.raises(CommandError, match='inherits'):
        command(state, type='SetSettings', id=sub.id, patch={'type': 'tag'})
    with pytest.raises(CommandError, match='not available at the top level'):
        command(state, type='SetSettings', id=caption.id, patch={'type': 'tag'})
    with pytest.raises(CommandError, match='needs a region with type: text'):
        command(state, type='SetSettings', id=inner.id, patch={'type': 'text'})
    state = command(state, type='SetSettings', id=caption.id, patch={'type': 'meta'})
    state = command(state, type='SetSettings', id=inner.id, patch={'type': 'tag'})
    with pytest.raises(CommandError, match='belongs at the top level'):
        command(state, type='MoveBlock', id=region.id, parent_id=caption.id, edge='end')
    with pytest.raises(CommandError, match='not available at the top level'):
        command(state, type='MoveBlock', id=inner.id, parent_id=state.doc.root.id, edge='end')
    state = command(state, type='SetMossType', id=region.id, moss_type='text')
    state = command(state, type='SetSettings', id=inner.id, patch={'type': 'text'})
    with pytest.raises(CommandError, match='text blocks to another type'):
        command(state, type='SetMossType', id=region.id, moss_type='object')
    state = command(state, type='SetRegion', id=region.id, region={'kind': 'mask', 'mask': [0.1, 0.4, 0, 1]})
    assert '[@region mask: [0.1, 0.4, 0, 1], type: text]' in state.text
    assert '.set{type: meta}' in state.text and '.set{type: text}' in state.text


def test_library_blocks_take_a_type_in_moss():
    state = moss('[copyright.template]: { fate \\(series\\), fate/grand order }.set{format: "copyright:$p"}')
    block = state.doc.root.children[0]
    state = command(state, type='SetSettings', id=block.id, patch={'type': 'meta'})
    assert state.text.startswith('[copyright.template]: {') and state.text.endswith('}.set{format: "copyright:$p", type: meta}')
    assert json.loads(compile(state)['prompt']) == {'summary': {'meta': ['copyright:fate (series)', 'copyright:fate/grand order']}}


def test_moss_settings_line_cannot_be_switched_off_deleted_or_moved():
    state = moss('[@moss]: { canvas: single } { a }')
    line = state.doc.root.children[0]
    for kind, extra in (('SetEnabled', {'enabled': False}), ('Delete', {}), ('MoveBlock', {'parent_id': state.doc.root.children[1].id, 'edge': 'end'})):
        with pytest.raises(CommandError, match='cannot be switched off'):
            command(state, type=kind, id=line.id, **extra)


def test_switching_to_moss_shows_the_settings_line_and_settings_rewrite_it():
    state = EditorState.create('intro.')
    state = command(state, type='SetMetadata', id=state.doc.root.id, patch={'output_mode': 'moss'})
    assert state.text.startswith('[@moss]: { }')
    state = command(state, type='SetMossSettings', id=state.doc.root.id, canvas='collage')
    assert state.text.startswith('[@moss]: { canvas: collage }')
    state = command(state, type='SetMossSettings', id=state.doc.root.id, canvas=None)
    assert state.text.startswith('[@moss]: { }')
    with pytest.raises(CommandError):
        command(state, type='SetMossSettings', id=state.doc.root.id, canvas='grid')
    with pytest.raises(CommandError):
        command(state, type='InsertBlock', parent_id=state.doc.root.id, form='avg')


def test_region_container_converts_to_region_blocks_keeping_type_text_and_upsample():
    state = moss('a shop. [@region]: { [base]: { sky } [mask: [0, 0.5, 0, 1]]: { a woman } [mask: [0.5, 1, 0, 1]]: { a sign } }')
    container = state.doc.root.children[-1]
    container.children[1].meta['moss'] = {'type': 'character'}
    container.children[2].meta.update(name='Sign', moss={'type': 'text', 'text': 'OPEN {now}', 'upsample': True})
    sign = container.children[2].id
    state = command(state, type='ConvertRegionContainer', id=container.id)
    assert [n.form for n in state.doc.root.children] == [None, 'brace', 'moss_region', 'moss_region']
    assert state.doc.find(sign).meta == {'name': 'Sign', 'moss': {'upsample': True}}
    layout = json.loads(compile(state)['prompt'])
    assert layout['summary'] == {'caption': 'a shop. sky'}
    assert [(i['label'], i.get('text')) for i in layout['items']] == [('character', None), ('text', 'OPEN {now}')]


def test_prompt_control_mode_reads_moss_blocks_as_ordinary_text():
    state = EditorState.create('[@moss]: { canvas: single } { red }.set{type: palette} { poster }.set{type: meta} a shop. '
                               '[@region mask: [0, 0.5, 0, 1], type: character]: { a woman. { 1girl }.set{type: tag} }')
    prompt = compile(state)['prompt']
    assert 'red' not in prompt and 'single' not in prompt and 'poster' not in prompt
    assert 'MASK(0 0.5, 0 1, 1) a shop. a woman. 1girl' in prompt
    assert [r.get('mode_disabled') for r in projection(state)['tree']['children'][:2]] == [
        'MOSS only; not part of the Prompt Control output'] * 2


def test_random_regions_and_caption_selection_use_one_seed():
    state = moss('[@region mask: [0, 1, 0, 1]]: { { red, blue, green }.set{random_select: 1} }')
    before = state.to_json()
    result = compile(state)
    assert compile(state)['prompt'] == result['prompt']
    assert result['plain'] == json.loads(result['prompt'])['items'][0]['caption']
    assert result['plain'] in ('red','blue','green')
    assert state.to_json() == before


def test_random_tags_draw_from_the_node_seed():
    tags = layout_of('[@region mask: [0, 1, 0, 1]]: { { red, blue, green }.set{random_select: 1, type: tag} }')['items'][0]['tags']
    assert len(tags) == 1 and tags[0] in ('red', 'blue', 'green')


def test_dimensions_change_reprojects_fractional_box_without_editing_document():
    state = moss(); before = state.to_json()
    result = compile_document(state,seed=17,region_mode='couple',width=1536,height=1024)
    assert json.loads(result['prompt'])['items'][0]['bbox'] == [-512,-768,512,0]
    assert state.to_json() == before


def test_pixel_rectangle_uses_canvas_pixels():
    assert layout_of('[@region mask: [16, 512, 32, 640]]: { a cat. }')['items'][0]['bbox'] == [-352,-496,256,0]


@pytest.mark.parametrize('mask', ['0.5, 0.5, 0, 1', '0.8, 0.2, 0, 1', '-10, 512, 0, 768', '0, 2048, 0, 768'])
def test_invalid_box_is_not_silently_clamped(mask):
    with pytest.raises(CommandError): compile(moss('[@region mask: [' + mask + ']]: { a cat. }'))


def test_negpip_weights_are_an_explicit_output_choice():
    state = moss('(blue eyes:1.2)')
    assert compile(state)['prompt'] == 'blue eyes'
    state.doc.root.meta['moss_weights'] = True
    assert compile(state)['prompt'] == '(blue eyes:1.2)'


def test_lora_is_extracted_without_leaking_loading_syntax():
    result = compile(moss('a woman. <lora:demo:0.8>'))
    assert result['prompt'] == 'a woman.'
    assert result['metadata']['prompt_loras'][0]['name'] == 'demo'


def test_moss_keeps_typed_escapes_and_drops_compiler_escapes():
    source = r'copyright:fate \(series\), a\\b #x. [@region mask: [0, 1, 0, 1]]: { saber \(fate\). }'
    result = compile(moss(source))
    layout = json.loads(result['prompt'])
    # The encoder reads the JSON source, where a `\(` would reach the model as `\(`
    # (JSON's own backslash survives ComfyUI's escape pass): parens are written bare.
    assert layout['summary']['caption'] == r'copyright:fate (series), a\b #x.'
    assert layout['items'][0]['caption'] == 'saber (fate).'
    assert result['plain'].startswith(r'copyright:fate \(series\)')


@pytest.mark.parametrize('source,expected', [
    ('a cat, blue eyes. she smiles.', 'A cat, blue eyes. She smiles.'),
    ('a DNA sample. iPhone.', 'A DNA sample. iPhone.'),
    ('Dr. smith smiles. then sits.', 'Dr. smith smiles. Then sits.'),
    ('a value of 0.35. next.', 'A value of 0.35. Next.'),
    ('"a cat." she smiles!', '"A cat." She smiles!'),
    ('@foo_bar, blue_eyes. a cat.', '@foo_bar, blue_eyes. A cat.'),
    ('https://example.com a cat.', 'https://example.com a cat.'),
    ('中文。a cat.', '中文。A cat.'),
])
def test_sentence_case(source, expected): assert sentence_case(source) == expected


def test_sentence_case_only_changes_outputs_not_literal_or_document():
    state = moss('a shop. [@region mask: [0, 1, 0, 1], type: text]: { a sign. { iPhone, DNA. }.set{type: text} { tag_one }.set{type: tag} }')
    state.doc.root.meta['sentence_case'] = True
    before = state.to_json(); layout = json.loads(compile(state)['prompt'])
    assert layout['items'][0]['text'] == 'iPhone, DNA.'
    assert layout['items'][0]['caption'] == 'A sign.'
    assert layout['items'][0]['tags'] == ['tag_one']
    assert layout['summary']['caption'] == 'A shop.'
    assert state.to_json() == before


def test_schema_keeps_original_order_and_dimensions_are_optional_sockets():
    schema = PromptLibraryV4Node.INPUT_TYPES()
    assert list(schema['required']) == ['text','seed','region_mode']
    assert list(schema['optional']) == ['doc','width','height']
    assert schema['optional']['width'][1]['forceInput'] is True
    assert 'default' not in schema['optional']['width'][1]


def test_moss_metadata_keeps_upsample_only():
    state = moss(); target = regions(state)[0].id
    state = command(state, type='SetMetadata', id=target, patch={'moss': {'upsample': True}})
    assert state.doc.find(target).meta['moss'] == {'upsample': True}
    with pytest.raises(CommandError, match='written in the region block'):
        command(state, type='SetMetadata', id=target, patch={'moss': {'type': 'text'}})


def test_upsampler_only_changes_requested_caption_and_updates_saved_metadata(monkeypatch):
    state = moss('a shop. [@region mask: [0, 0.5, 0, 1], type: text]: { a woman. { 原文, iPhone. }.set{type: text} } '
                 '[@region mask: [0.5, 1, 0, 1]]: { a cat. }')
    regions(state)[0].meta['moss'] = {'upsample': True}
    metadata = compile(state)['metadata']; before = deepcopy(metadata)
    calls = []
    def generate(cls, clip, caption, options):
        calls.append((caption, options['sampling_mode']['seed'])); return 'expanded ' + caption, ''
    monkeypatch.setattr(PLV4MOSSUpsample, '_generate', classmethod(generate))
    clip = SimpleNamespace(patcher=SimpleNamespace(model=type('Model', (), {})()),tokenizer=type('Tokenizer', (), {})())
    prompt, plain, updated, thinking = PLV4MOSSUpsample().execute(metadata,clip)
    old, new = json.loads(metadata['prompt']), json.loads(prompt)
    assert len(calls) == 1
    assert new['items'][0]['caption'] == 'expanded a woman.'
    for key in ('label','text','bbox'): assert new['items'][0][key] == old['items'][0][key]
    assert new['items'][1] == old['items'][1]
    assert metadata == before
    PLV4MOSSUpsample().execute(metadata,clip)
    assert len(calls) == 1
    saved = PLV4ImageMetadataNode().execute(updated)[0]
    assert decode_parameters(saved['overrides']['additional_data'])['positive']['prompt'] == prompt


def test_upsample_plain_prompt_and_bypass(monkeypatch):
    state = moss('a cat.'); state.doc.root.meta['moss'] = {'upsample':True}
    metadata = compile(state)['metadata']
    monkeypatch.setattr(PLV4MOSSUpsample, '_generate', classmethod(lambda *args:('a detailed cat.', '')))
    clip = SimpleNamespace(patcher=SimpleNamespace(model=object()),tokenizer=object())
    result = PLV4MOSSUpsample().execute(metadata,clip)
    assert result[0] == result[1] == 'a detailed cat.'
    assert PLV4MOSSUpsample().execute(metadata,clip,enabled=False)[0] == 'a cat.'


def test_upsample_without_requested_captions_is_an_exact_passthrough():
    state = moss('[@region mask: [0, 1, 0, 1]]: { a cat. } a shop.')
    metadata = compile(state)['metadata']
    prompt, plain, result, thinking = PLV4MOSSUpsample().execute(metadata, None)
    assert (prompt, plain) == (metadata['prompt'], metadata['plain'])
    assert result == metadata


def textgen_clip():
    return SimpleNamespace(patcher=SimpleNamespace(model=type('Model', (), {})(), patches_uuid='test'),
                           tokenizer=type('Tokenizer', (), {})())


def test_upsample_standalone_matches_native_controls_and_thinking(monkeypatch):
    calls = []
    def generate(cls, clip, caption, options):
        calls.append((caption, options)); return '{"any output":"is allowed"}', 'native reasoning'
    monkeypatch.setattr(PLV4MOSSUpsample, '_generate', classmethod(generate))
    image, video, audio = object(), object(), object()
    output = PLV4MOSSUpsample().execute(clip=textgen_clip(), prompt='a cat.', seed=72,
        max_length=32768, temperature=0.3, top_k=17, top_p=0.8, min_p=0.1,
        repetition_penalty=1.2, presence_penalty=0.5, thinking=True,
        use_default_template=False, mtp='3', system_prompt='my instructions',
        image=image, video=video, audio=audio)
    assert output == ('{"any output":"is allowed"}', '{"any output":"is allowed"}', None, 'native reasoning')
    caption, opts = calls[0]
    assert caption == 'a cat.'
    assert opts == dict(max_length=32768, sampling_mode=dict(sampling_mode='on', temperature=0.3,
        top_k=17, top_p=0.8, min_p=0.1, repetition_penalty=1.2, presence_penalty=0.5, seed=72),
        thinking=True, use_default_template=False, mtp='3', system_prompt='my instructions',
        image=image, video=video, audio=audio)


def test_upsample_sampling_off_delegates_native_defaults(monkeypatch):
    calls = []
    def generate(cls, clip, caption, options):
        calls.append(options); return 'cat', ''
    monkeypatch.setattr(PLV4MOSSUpsample, '_generate', classmethod(generate))
    PLV4MOSSUpsample().execute(clip=textgen_clip(), prompt='cat', sampling_mode='off', seed=123)
    assert calls[0]['sampling_mode'] == {'sampling_mode':'off'}


def test_upsample_standalone_layout_preserves_structure_and_separates_thinking(monkeypatch):
    metadata = compile(moss())['metadata']; original = json.loads(metadata['prompt'])
    original['custom'] = {'unchanged':True}
    calls = []
    def generate(cls, clip, caption, options):
        calls.append((caption, options['sampling_mode']['seed']))
        return 'expanded ' + caption, 'thought: ' + caption
    monkeypatch.setattr(PLV4MOSSUpsample, '_generate', classmethod(generate))
    output = PLV4MOSSUpsample().execute(clip=textgen_clip(), prompt=json.dumps(original), seed=9)
    layout = json.loads(output[0]); reasoning = json.loads(output[3])
    assert len(calls) == 3 and calls[0][1] == 9
    assert len({seed for caption, seed in calls}) == 3
    assert set(reasoning) == {'summary','item:0','item:1'}
    for a, b in zip(original['items'], layout['items']):
        assert {k:v for k,v in a.items() if k != 'caption'} == {k:v for k,v in b.items() if k != 'caption'}
    assert layout['custom'] == original['custom']
    assert output[2] is None


def test_upsample_prompt_metadata_mismatch_fails_before_generation():
    with pytest.raises(ValueError, match='do not match'):
        PLV4MOSSUpsample().execute(metadata=compile(moss())['metadata'], prompt='different')


@pytest.mark.parametrize('change', [dict(top_k=2), dict(top_p=0.7), dict(min_p=0.1),
    dict(repetition_penalty=1.2), dict(presence_penalty=0.2), dict(thinking=True),
    dict(use_default_template=False), dict(mtp='off'), dict(system_prompt='new instructions'),
    dict(sampling_mode='off'), dict(image=object())])
def test_upsample_cache_respects_all_native_controls_and_media(monkeypatch, change):
    PLV4MOSSUpsample._cache.clear()
    calls = []
    def generate(cls, clip, caption, options):
        calls.append(options); return 'result', 'reasoning'
    monkeypatch.setattr(PLV4MOSSUpsample, '_generate', classmethod(generate))
    clip = textgen_clip(); node = PLV4MOSSUpsample()
    baseline = node.execute(clip=clip, prompt='cat')
    assert node.execute(clip=clip, prompt='cat') == baseline
    assert len(calls) == 1
    node.execute(clip=clip, prompt='cat', **change)
    assert len(calls) == 2
    node.execute(clip=clip, prompt='cat', **change)
    assert len(calls) == (3 if 'image' in change else 2)


def test_upsample_calls_native_textgenerate_instead_of_forking_generation(monkeypatch):
    import sys
    from types import ModuleType
    module = ModuleType('comfy_extras.nodes_textgen')
    calls = []
    class Native:
        @classmethod
        def execute(cls, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(args=('generated', 'thinking'))
    module.TextGenerate = Native
    monkeypatch.setitem(sys.modules, 'comfy_extras', ModuleType('comfy_extras'))
    monkeypatch.setitem(sys.modules, 'comfy_extras.nodes_textgen', module)
    clip = object(); options = dict(max_length=57, sampling_mode={'sampling_mode':'off'}, thinking=True)
    assert PLV4MOSSUpsample._generate(clip, 'caption', options) == ('generated', 'thinking')
    assert calls == [dict(clip=clip, prompt='caption', **options)]


@pytest.mark.parametrize('generated', ['', '```json\n{}\n```', '{"summary":{}}'])
def test_upsample_invalid_region_output_does_not_return_partial_layout(monkeypatch, generated):
    monkeypatch.setattr(PLV4MOSSUpsample, '_generate', classmethod(lambda *args:(generated, 'thinking')))
    with pytest.raises(ValueError, match='no valid plain caption'):
        PLV4MOSSUpsample().execute(clip=textgen_clip(), prompt=compile(moss())['prompt'])
