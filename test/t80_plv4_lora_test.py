"""Independent LoRA browsing and self-contained document semantics."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from prompt_library_v4.assets import AssetLibrary
from prompt_library_v4.commands import apply_command
from prompt_library_v4.compiler import compile_document
from prompt_library_v4.loras import LoraBrowser, civitai_link, remote_image
from prompt_library_v4.lora_triggers import split_bundles, trigger_groups
from prompt_library_v4.model import CommandError, EditorState
from prompt_library_v4.node import PromptLibraryV4Node
from prompt_library_v3.node import PromptLibraryV3Node
from prompt_library_v3 import compile_text


def command(state, kind, **args):
    return apply_command(state, {'type': kind, 'revision': state.revision, **args})


def insert(state=None, name='demo', key='a' * 64):
    return command(state or EditorState.create('quality'), 'InsertLora', lora={'id': key, 'relative': name + '.safetensors', 'name': name, 'root_id': 'root'}, pool_id='offline-pool')


def test_lora_folder_binding_cannot_be_changed_or_removed():
    state = insert()
    block = state.doc.root.children[-1]
    before = state.to_json()
    for pool in ('other-folder', None):
        with pytest.raises(CommandError) as error:
            command(state, 'SetMetadata', id=block.id, patch={'pool': pool})
        assert error.value.code == 'fixed_lora_pool'
        assert state.to_json() == before
    renamed = command(state, 'SetMetadata', id=block.id, patch={'name': 'renamed', 'pool': 'offline-pool'})
    assert renamed.doc.find(block.id).meta['name'] == 'renamed'
    assert renamed.doc.find(block.id).meta['lora'] == block.meta['lora']
    assert renamed.text == state.text
    ordinary = command(state, 'ReplaceText', text=state.text.replace('<lora:demo.safetensors:1>', 'prompt'))
    rebound = command(ordinary, 'SetMetadata', id=block.id, patch={'pool': 'ordinary-folder'})
    assert rebound.doc.find(block.id).meta['pool'] == 'ordinary-folder'


@pytest.fixture
def browser(tmp_path):
    root = tmp_path / 'models'; (root / 'characters').mkdir(parents=True)
    (root / 'characters' / 'demo.safetensors').write_bytes(b'fake weights')
    (root / 'characters' / 'demo.metadata.json').write_text(json.dumps({'civitai': {'id': 7, 'modelId': 42, 'trainedWords': ['one', 'two', 'three'], 'images': [{'url': 'https://image.civitai.com/example.webp'}]}}))
    (root / 'characters' / 'demo.preview.png').write_bytes(b'local image')
    (root / 'characters' / 'demo.2.webp').write_bytes(b'second image')
    library = AssetLibrary(tmp_path / 'library.db')
    service = LoraBrowser(lambda: [root], library, tmp_path / 'metadata', fetch_json=lambda digest: {'id': 8, 'modelId': 42, 'trainedWords': ['new'], 'images': []})
    yield service, library, root
    library.close()


def test_read_only_lazy_multi_image_and_on_demand_pool(browser):
    service, library, root = browser
    result = service.list()
    assert result['total'] == 1 and result['roots'][0]['folders'] == ['characters']
    info = result['items'][0]
    assert len(info['images']) == 3 and info['civitai_url'] == 'https://civitai.red/models/42?modelVersionId=7'
    service.detail(info['id'])
    assert library.read()['assets'] == []
    before = (root / 'characters' / 'demo.metadata.json').read_bytes()
    sent = service.send(info['id'])
    assets = library.read()['assets']
    assert [row['name'] for row in assets if row['kind'] == 'tag'] == ['one', 'two', 'three']
    assert next(row for row in assets if row['id'] == sent['pool_id'])['lora_root']
    assert service.send(info['id'])['pool_id'] == sent['pool_id']
    assert (root / 'characters' / 'demo.metadata.json').read_bytes() == before
    assert service.image(info['id'], 0).is_relative_to(root)
    assert service.image(info['id'], 0).name == 'demo.preview.png'
    for index in (-1, 99):
        with pytest.raises(CommandError): service.image(info['id'], index)


def test_lora_classes_and_descendants_stay_hidden_after_moving_to_a_folder(browser):
    service, library, _ = browser
    model = service.list()['items'][0]
    root = library.read('get', id=service.send(model['id'])['pool_id'])
    folder = library.mutate({'action': 'save_folder', 'name': 'Storage'})['asset']
    library.mutate({'action': 'move', 'id': root['id'], 'version': root['version'], 'parent_id': folder['id']})
    child = library.mutate({'action': 'save_class', 'name': 'Outfit', 'parent_id': root['id']})['asset']
    tag = library.mutate({'action': 'save_tag', 'text': 'white dress', 'parent_id': child['id']})['asset']
    rows = {a['id']:a for a in library.read()['assets']}
    assert rows[root['id']]['kind'] == rows[child['id']]['kind'] == 'class'
    assert all(rows[ident]['library_hidden'] for ident in (root['id'],child['id'],tag['id']))
    assert not rows[folder['id']].get('library_hidden')
    assert library.read('candidates', pool=root['id'])['candidates'][0]['children']
    state = command(EditorState.create(text=''), 'InsertLora', lora=model, pool_id=root['id'])
    saved = library.mutate({'action':'save_block', 'name':'Saved LoRA', 'parent_id':folder['id'], 'snapshot':state.doc.root.children[0].to_json()})['asset']
    assert next(a for a in library.read()['assets'] if a['id']==saved['id'])['library_hidden']


def test_completion_reads_only_index_and_excludes_shadowed_or_invalid_paths(browser):
    service, library, root = browser
    (root / 'characters' / 'bad:name.safetensors').write_bytes(b'fixture')
    other = root.parent / 'other'; (other / 'characters').mkdir(parents=True)
    (other / 'characters' / 'demo.safetensors').write_bytes(b'shadowed')
    service.roots = lambda: [root, other]
    service.metadata = lambda *args: pytest.fail('Completion must not read metadata')
    values = service.complete('DEMO')['items']
    assert [row['relative'] for row in values] == ['characters/demo.safetensors']
    assert set(values[0]) == {'id', 'name', 'relative'}
    assert library.read()['assets'] == []
    assert not service.cache_dir.exists()
    for limit in (0, 101, True, 1.5):
        with pytest.raises(CommandError): service.complete(limit=limit)


def test_pool_manual_deletion_stays_deleted_and_explicit_import(browser):
    service, library, _ = browser
    info = service.send(service.list()['items'][0]['id'])
    tag = next(row for row in library.read()['assets'] if row['name'] == 'one')
    library.mutate({'action': 'delete', 'id': tag['id'], 'version': tag['version']})
    assert 'one' not in [row['name'] for row in library.read()['assets']]
    service.detail(info['id'], ensure=True)
    assert 'one' not in [row['name'] for row in library.read()['assets']]
    service.detail(info['id'], ensure=True, import_triggers=True)
    assert 'one' in [row['name'] for row in library.read()['assets']]
    pool = library.read('get', id=info['pool_id'])
    library.mutate({'action': 'save_class', 'id': pool['id'], 'version': pool['version'], 'name': 'custom triggers', 'data': {'autocomplete': True}})
    assert service.send(info['id'])['pool_id'] == pool['id']


OUTFITS = [
    '2d, 1girl, solo, blonde hair, bangs, side locks, single hair bun, french_braid, green eyes, maid_headdress, wearing glasses, round_eyewear, maid_dress, black_dress, frills, puffy_sleeves, long_sleeves, white wrist_cuffs, maid_apron, white bow, belt pouches, white knee socks, black_high_heels',
    '2d, 1girl, solo, blonde hair, bangs, side locks, single hair bun, french_braid, hair bow, green eyes, wearing glasses, round_eyewear, necklace, white_sweater, off_shoulder, brown jacket, belt, pleated skirt, short skirt, holding handbag, high_heel_boots',
    '2d, 1girl, solo, blonde hair, bangs, side locks, single hair bun, french_braid, green eyes, playboy_bunny, clover_hair_ornament, fake_rabbit_ears, black choker, black jacket, long_sleeves, white collared shirt, open shirt, white wrist_cuffs, white gloves, tailcoat, black leotard, black necktie, necktie_between_breasts, cleavage, navel cutout, white bunny_tail, fishnet_pantyhose, black_high_heels',
]

# Civitai version 3058459's authored array, also present in its local sidecar.
# The combinations deliberately have no requirement to share exact tags.
CHARACTERS = [
    'Sakayori Iroha12138 with green eyes and short black hair,  mole, mole under eye,no ahoge, sidelocks,  single hair bun',
    'Yachiyo Runami1991 is a blue-eyed character with bangs, featuring hair rings and very long, multicolored white hair with pink inner hair styled into twintails',
    'Liveer Iroha2050 features short multicolored black and purple hair with bangs, green eyes, a black choker, and animal traits including fox ears and a fox tail.',
    'Liveer Kaguya2077 is a character with very long, low-tied blonde hair, featuring a crescent hair ornament, rabbit animal ears, and a visible fang',
    'kaguya normal2028 with red eyes and long Creamy yellow hair,  bangs, blunt bangs, ahoge',
]


def test_character_metadata_entries_keep_boundaries_without_overlap(browser):
    service, library, root = browser
    (root / 'characters' / 'demo.metadata.json').write_text(json.dumps({'civitai': {'trainedWords': CHARACTERS}}))
    info = service.send(service.list()['items'][0]['id'])
    assert info['triggers'] == CHARACTERS
    assets = library.read()['assets']
    groups = [asset for asset in assets if asset['parent_id'] == info['pool_id']]
    assert [group['name'] for group in groups] == ['Sakayori Iroha12138', 'Yachiyo Runami1991', 'Liveer Iroha2050', 'Liveer Kaguya2077', 'kaguya normal2028']
    for group, text in zip(groups, CHARACTERS):
        expected = trigger_groups([text])[0]['nodes']
        assert [asset['name'] for asset in assets if asset['parent_id'] == group['id']] == list(expected)
        source = library.read('folder_block', id=group['id'], fill=True)
        state = EditorState.create('')
        selected = command(state, 'InsertLibraryBlock', parent_id=state.doc.root.id, edge='end', **{key: source[key] for key in ('snapshot', 'source')})
        output = compile_document(selected, seed=0, region_mode='mask')['plain']
        assert group['name'] in output
        assert all(other['name'] not in output for other in groups if other != group)
    before = {asset['id'] for asset in assets}
    service.detail(info['id'], ensure=True, import_triggers=True)
    assert {asset['id'] for asset in library.read()['assets']} == before


def test_unrelated_metadata_bundles_and_mixed_atomic_alternatives_are_not_merged():
    groups = trigger_groups(['Alice, blue eyes', 'Bob, brown hair', 'Charlie'])
    assert [group['name'] for group in groups] == ['Alice', 'Bob', 'Charlie']
    assert [list(group['nodes']) for group in groups] == [['Alice', 'blue eyes'], ['Bob', 'brown hair'], ['Charlie']]
    paragraphs = ['Alice is a cheerful character wearing a pretty red hat', 'Bob has a stern expression and wears a green coat']
    assert [group['name'] for group in trigger_groups(paragraphs)] == ['Alice', 'Bob']
    assert len(trigger_groups(['blue eyes', 'long hair', 'blonde hair'])) == 1


def test_character_bundles_inside_attention_keep_authored_names_and_weights():
    words = ['(Adachi Sakura, blue hair,blue eyes,medium hair)', '(Hino Akira,brown eyes, green hair, twintails:1.2)']
    groups = trigger_groups(words)
    assert [group['name'] for group in groups] == ['Adachi Sakura', 'Hino Akira']
    assert [list(group['nodes']) for group in groups] == [[words[0]], [words[1]]]
    assert len(trigger_groups(['(blue eyes:1.2)', '(brown hair:1.3)'])) == 1


def test_regroup_old_flat_pool_preserves_deleted_and_edited_tags(browser):
    service, library, _ = browser
    info = service.send(service.list()['items'][0]['id'])
    for text in CHARACTERS:
        for tag in trigger_groups([text])[0]['nodes']:
            if tag not in {asset['name'] for asset in library.read()['assets'] if asset['parent_id'] == info['pool_id']}:
                library.mutate({'action': 'save_tag', 'parent_id': info['pool_id'], 'text': tag})
    old = library.read()['assets']
    deleted = next(asset for asset in old if asset['name'] == 'no ahoge')
    edited = next(asset for asset in old if asset['name'] == 'mole')
    library.mutate({'action': 'delete', 'id': deleted['id'], 'version': deleted['version']})
    library.mutate({'action': 'save_tag', 'id': edited['id'], 'version': edited['version'], 'parent_id': info['pool_id'], 'text': 'custom beauty mark'})
    payload = {'action': 'ensure_lora', 'lora': {key: info[key] for key in ('id', 'name', 'relative', 'root_id')}, 'triggers': CHARACTERS, 'regroup_existing': True}
    library.mutate(payload)
    assets = library.read()['assets']
    assert len([asset for asset in assets if asset['parent_id'] == info['pool_id'] and asset['kind'] == 'class']) == 5
    assert not any(asset['name'] in ('no ahoge', 'mole') for asset in assets)
    assert next(asset for asset in assets if asset['id'] == edited['id'])['parent_id'] == info['pool_id']
    assert {asset['id'] for asset in old if asset['id'] != deleted['id']} <= {asset['id'] for asset in assets}
    library.mutate(payload)
    assert library.read()['assets'] == assets


@pytest.mark.parametrize('words', [[',, '.join(OUTFITS) + ','], OUTFITS])
def test_outfit_import_retains_complete_bundles_in_sibling_folders(browser, words):
    service, library, root = browser
    (root / 'characters' / 'demo.metadata.json').write_text(json.dumps({'trainedWords': words}))
    info = service.send(service.list()['items'][0]['id'])
    assets = library.read()['assets']
    groups = [asset for asset in assets if asset['parent_id'] == info['pool_id']]
    assert [group['name'] for group in groups] == ['女仆装', '日常装', '兔女郎装']
    assert all(group['kind'] == 'class' for group in groups)
    for group, text in zip(groups, OUTFITS):
        tags = [asset['name'] for asset in assets if asset['parent_id'] == group['id']]
        assert tags == text.split(', ')
        assert len(tags) == len(set(tags)) and '1girl' in tags
        # Each bound appearance inserts a complete prompt, independently.
        source = library.read('folder_block', id=group['id'], fill=True)
        state = EditorState.create('')
        rendered = command(state, 'InsertLibraryBlock', parent_id=state.doc.root.id, edge='end', snapshot=source['snapshot'], source=source['source'])
        output = compile_document(rendered, seed=0, region_mode='mask')['plain']
        assert '1girl' in output and text.split(', ')[-1] in output
    original_ids = {asset['id'] for asset in assets}
    service.detail(info['id'], ensure=True, import_triggers=True)
    assert {asset['id'] for asset in library.read()['assets']} == original_ids


def test_outfit_manual_edits_survive_send_and_rename_survives_reimport(browser):
    service, library, root = browser
    (root / 'characters' / 'demo.metadata.json').write_text(json.dumps({'trainedWords': [',,'.join(OUTFITS)]}))
    info = service.send(service.list()['items'][0]['id'])
    group = next(asset for asset in library.read()['assets'] if asset['name'] == '女仆装')
    library.mutate({'action': 'save_class', 'id': group['id'], 'version': group['version'], 'name': '我的女仆', 'data': {'autocomplete': True}})
    tag = next(asset for asset in library.read()['assets'] if asset['parent_id'] == group['id'] and asset['name'] == '1girl')
    library.mutate({'action': 'delete', 'id': tag['id'], 'version': tag['version']})
    library.mutate({'action': 'save_tag', 'parent_id': group['id'], 'text': 'custom trigger'})
    before = library.read()['assets']
    service.send(info['id'])
    assert library.read()['assets'] == before
    service.detail(info['id'], ensure=True, import_triggers=True)
    assets = library.read()['assets']
    assert len([asset for asset in assets if asset['kind'] == 'class']) == 4
    assert next(asset for asset in assets if asset['id'] == group['id'])['name'] == '我的女仆'
    assert {'1girl', 'custom trigger'} <= {asset['name'] for asset in assets if asset['parent_id'] == group['id']}


def test_explicit_import_reorganises_previously_flat_pool_without_losing_custom_tags(browser):
    service, library, root = browser
    info = service.send(service.list()['items'][0]['id'])
    for tag in dict.fromkeys(', '.join(OUTFITS).split(', ')):
        library.mutate({'action': 'save_tag', 'parent_id': info['pool_id'], 'text': tag})
    (root / 'characters' / 'demo.metadata.json').write_text(json.dumps({'trainedWords': [',,'.join(OUTFITS)]}))
    before = library.read()['assets']
    service.send(info['id'])
    assert library.read()['assets'] == before
    service.detail(info['id'], ensure=True, import_triggers=True)
    assets = library.read()['assets']
    assert {asset['name'] for asset in assets if asset['parent_id'] == info['pool_id'] and asset['kind'] == 'tag'} == {'one', 'two', 'three'}
    assert len([asset for asset in assets if asset['name'] == '1girl']) == 3


def test_outfit_group_name_collisions_are_disambiguated(browser):
    service, library, root = browser
    info = service.send(service.list()['items'][0]['id'])
    folder = library.mutate({'action': 'save_class', 'name': '女仆装', 'parent_id': info['pool_id']})['id']
    (root / 'characters' / 'demo.metadata.json').write_text(json.dumps({'trainedWords': ['1girl, solo, maid_dress,, 1girl, solo, maid_apron']}))
    service.detail(info['id'], ensure=True, import_triggers=True)
    assets = library.read()['assets']
    assert [asset['name'] for asset in assets if asset['kind'] == 'class' and asset['parent_id'] == info['pool_id']] == ['女仆装', '女仆装 2', '女仆装 3']
    assert not any(asset['parent_id'] == folder for asset in assets)


def test_bundle_boundaries_respect_literals_weights_and_source_entries():
    assert split_bundles('"literal,,text", (red,,blue:1.2), <lora:x,,y:1>') == ['"literal,,text", (red,,blue:1.2), <lora:x,,y:1>']
    assert split_bundles('one, , two,,, three,') == ['one', 'two', 'three,']
    groups = trigger_groups(['character', '1girl, solo, maid_dress, 1girl,, 1girl, solo, white_sweater'])
    assert len(groups) == 3
    assert list(groups[0]['nodes']) == ['character']
    assert all(list(group['nodes']).count('1girl') == 1 and 'character' not in group['nodes'] for group in groups[1:])
    assert len(trigger_groups(['a, b,, c'])) == 2
    assert len(trigger_groups(['one, two', 'three'])) == 2
    assert len(trigger_groups(['one', 'two', 'three'])) == 1


def test_fetch_caches_only_xyz_metadata_and_is_explicit(browser):
    service, library, root = browser
    info = service.list()['items'][0]
    digests = []
    def fetch(digest):
        digests.append(digest)
        return {'id': 8, 'modelId': 42, 'trainedWords': ['new']}
    service.fetch_json = fetch
    updated = service.fetch(info['id'])
    assert updated['triggers'] == ['new'] and digests == [hashlib.sha256(b'fake weights').hexdigest()]
    assert library.read()['assets'] == []
    (root / 'characters' / 'demo.safetensors').write_bytes(b'changed')
    assert service.detail(info['id'])['triggers'] == ['one', 'two', 'three']
    service.fetch_json = lambda _: (_ for _ in ()).throw(OSError('offline'))
    with pytest.raises(CommandError, match='仍可使用'): service.fetch(info['id'])


def test_multi_roots_duplicate_paths_search_and_corrupt_sidecar(browser, tmp_path):
    service, _, root = browser
    other = tmp_path / 'extra'; (other / 'characters').mkdir(parents=True)
    (other / 'characters' / 'demo.safetensors').write_bytes(b'other')
    (other / 'only.pt').write_bytes(b'only')
    (other / 'only.metadata.json').write_text('{bad')
    service.roots = lambda: [root, other]
    result = service.list(limit=1)
    assert result['total'] == 3 and len(result['roots']) == 2 and len(result['items']) == 1
    models = service.list(query='characters')['items']
    assert len(models) == 2 and len({model['id'] for model in models}) == 2
    with pytest.raises(CommandError, match='相同相对路径'): service.send(next(model['id'] for model in models if model['shadowed']))
    assert service.list(root_id=result['roots'][1]['id'], folder='characters')['total'] == 1
    assert service.list(query='only')['items'][0]['images'] == []
    for value in ('../../outside', 'missing'):
        with pytest.raises(CommandError): service.detail(value)
    for value in (-1, True):
        with pytest.raises(CommandError): service.list(offset=value)


def test_browser_rejects_preview_outside_configured_root(browser, tmp_path):
    service, _, root = browser
    outside = tmp_path / 'outside.png'; outside.write_bytes(b'secret')
    sidecar = root / 'characters' / 'demo.metadata.json'
    sidecar.write_text(json.dumps({'preview_url': str(outside), 'civitai': {'images': [{'url': 'http://localhost/private'}, {'url': 'javascript:alert(1)'}]}}))
    assert len(service.list()['items'][0]['images']) == 2
    assert not remote_image('https://image.civitai.com.evil.test/a')
    assert not civitai_link({'modelId': True})


def test_send_appends_owning_lora_block_and_protects_invocation():
    state = insert()
    block = state.doc.root.children[-1]
    assert block.meta['pool'] == 'offline-pool' and block.children[0].meta['lora_invocation']
    assert state.text.startswith('quality') and '<lora:demo.safetensors:1>' in state.text
    original = deepcopy(state.to_json())
    for kind, extra in [('Delete', {}), ('SetEnabled', {'enabled': False}), ('ReplaceItem', {'text': 'removed'})]:
        with pytest.raises(CommandError, match='整个 block'): command(state, kind, id=block.children[0].id, **extra)
    assert state.to_json() == original
    state = command(state, 'InsertBlock', parent_id=block.id, edge='start', text='{ trigger }')
    assert state.doc.root.children[-1].children[0].kind == 'lora'


def test_duplicate_send_enables_existing_ancestor_and_keeps_custom_values():
    state = insert(EditorState.create('{ outer }'))
    parent, block = state.doc.root.children
    state = command(state, 'SetLoraStrength', id=block.id, model=.7, clip=-.2)
    state = command(state, 'MoveBlock', id=block.id, parent_id=parent.id, edge='end')
    state = command(state, 'SetEnabled', id=parent.id, enabled=False)
    state = insert(state)
    assert len(state.doc.root.children) == 1
    assert state.doc.find(parent.id).enabled
    assert '<lora:demo.safetensors:0.7:-0.2>' in state.text
    assert state.doc.find(block.id).meta['pool'] == 'offline-pool'


@pytest.mark.parametrize('mode', ['mask', 'couple'])
def test_ambient_lora_emitted_once_explicit_repetitions_preserved(mode):
    text = '<lora:demo:0.6>, quality, [@region]: { [imask:0]: { a } [imask:1]: { b } }'
    output = compile_document(EditorState.create(text), seed=42, region_mode=mode)['prompt']
    assert output.count('<lora:demo:0.6>') == 1
    assert output.endswith('<lora:demo:0.6>')
    # raw compile copies ambient text into both regions and the compiler's fill
    assert compile_text(text, region_mode=mode).text.count('<lora:demo:0.6>') == 3
    output = compile_document(EditorState.create('<lora:demo:.6>, <lora:demo:.6>'), seed=42, region_mode=mode)['prompt']
    assert output.count('<lora:demo:.6>') == 2


@pytest.mark.parametrize('mode', ['mask', 'couple'])
def test_lora_and_trigger_share_inherited_schedule_and_random_block_unit(mode):
    state = insert(EditorState.create('{ }'))
    parent, block = state.doc.root.children
    state = command(state, 'MoveBlock', id=block.id, parent_id=parent.id, edge='end')
    state = command(state, 'InsertBlock', parent_id=block.id, text='{ one, two }')
    state = command(state, 'SetSettings', id=parent.id, patch={'schedule': [.2, .7]})
    state = command(state, 'SetSettings', id=block.id, patch={'dropout': 1})
    output = compile_document(state, seed=42, region_mode=mode)['prompt']
    assert output == '[<lora:demo.safetensors:1>, :0.2,0.7]'
    state = command(state, 'SetSettings', id=block.id, patch={'dropout': 0})
    output = compile_document(state, seed=42, region_mode=mode)['prompt']
    assert '[one, two, :0.2,0.7]' in output and output.endswith('[<lora:demo.safetensors:1>, :0.2,0.7]')
    state = command(state, 'SetSettings', id=parent.id, patch={'random_select': 0})
    assert compile_document(state, seed=42, region_mode=mode)['prompt'] == ''


def test_random_pick_loras_keeps_trigger_and_reference_together():
    state = EditorState.create('{ }')
    parent = state.doc.root.children[0]
    for name in ['alpha', 'beta', 'gamma']:
        state = insert(state, name, hashlib.sha256(name.encode()).hexdigest())
        block = state.doc.root.children[-1]
        state = command(state, 'InsertBlock', parent_id=block.id, text='{ ' + name + '_trigger }')
        state = command(state, 'MoveBlock', id=block.id, parent_id=parent.id, edge='end')
    state = command(state, 'SetSettings', id=parent.id, patch={'random_select': 1, 'shuffle': True})
    for seed in range(10):
        output = compile_document(state, seed=seed, region_mode='couple')['prompt']
        assert output.count('<lora:') == 1
        for name in ['alpha', 'beta', 'gamma']:
            assert (name + '_trigger' in output) == ('<lora:' + name + '.' in output)


def test_source_removing_reference_releases_special_block_and_cache_semantics():
    state = insert()
    state = command(state, 'InsertBlock', parent_id=state.doc.root.children[-1].id, text='{ trigger }')
    node = PromptLibraryV4Node()
    saved = json.dumps(state.doc.to_json())
    output = compile_document(state, seed=42, region_mode='couple')
    assert node.execute(doc=saved, seed=42)[:2] == (output['prompt'], output['plain'])
    state.doc.root.meta['compiler'] = 'plv4'
    assert PromptLibraryV3Node().execute(doc=json.dumps(state.doc.to_json()), seed=42) == (output['prompt'], output['plain'])
    before = node.IS_CHANGED(doc=saved)
    state.doc.root.children[-1].meta.pop('lora')
    assert node.IS_CHANGED(doc=json.dumps(state.doc.to_json())) != before
    state = EditorState.create(doc=json.loads(saved))
    state.replace_text(state.text.replace('<lora:demo.safetensors:1>', ''))
    assert not any(part.meta.get('lora') or part.meta.get('lora_invocation') for part in state.doc.root.walk())


def test_pool_observation_excludes_invocation_and_saved_parent_retains_lora(browser):
    _, library, _ = browser
    pool = library.mutate({'action': 'save_class', 'name': 'triggers'})['id']
    state = command(EditorState.create(''), 'InsertLora', lora={'id': 'a' * 64, 'name': 'demo', 'relative': 'demo.safetensors'}, pool_id=pool)
    state = command(state, 'InsertBlock', parent_id=state.doc.root.children[0].id, text='{ trigger }')
    library.mutate({'action': 'sync_pool', 'state': state.to_json(), 'owner': 'test'})
    assert [asset['name'] for asset in library.read()['assets'] if asset['kind'] == 'tag'] == ['trigger']
    saved = library.mutate({'action': 'save_block', 'name': 'saved', 'snapshot': state.doc.root.children[0].to_json()})['id']
    snapshot = library.read('expand', id=saved)['snapshot']
    empty = EditorState.create('')
    loaded = command(empty, 'InsertLibraryBlock', parent_id=empty.doc.root.id, snapshot=snapshot, source={'id': saved, 'kind': 'block'})
    assert '<lora:demo.safetensors:1>' in compile_document(loaded, seed=42, region_mode='couple')['prompt']


def test_abs_local_cover_and_dynamic_comfy_extensions(browser):
    service, _, root = browser
    cover = root / 'custom-cover.png'; cover.write_bytes(b'cover')
    (root / 'characters' / 'demo.metadata.json').write_text(json.dumps({'preview_url': str(cover)}))
    info = service.list()['items'][0]
    assert service.image(info['id'], 0) == cover
    (root / 'custom.adapter').write_bytes(b'model')
    service.extensions = lambda: {'.adapter'}
    assert service.list()['items'][0]['relative'] == 'custom.adapter'


def test_malformed_trigger_does_not_prevent_send_and_invalid_draft_cache_is_hashable(browser):
    service, library, root = browser
    (root / 'characters' / 'demo.metadata.json').write_text(json.dumps({'civitai': {'trainedWords': ['{ unfinished', '{ complete }', 'normal']}}))
    info = service.send(service.list()['items'][0]['id'])
    assert info['pool_id'] and len([asset for asset in library.read()['assets'] if asset['kind'] == 'tag']) == 3
    state = insert(); state.replace_text('{ broken')
    assert len(PromptLibraryV4Node.IS_CHANGED(doc=json.dumps(state.doc.to_json()))) == 64
    assert compile_document(EditorState.create('<other:x:1>, plain'), seed=42, region_mode='couple')['prompt'] == '<other:x:1>, plain'


def test_lora_http_read_send_and_media_boundaries(browser):
    import asyncio
    from types import SimpleNamespace
    from aiohttp import web, ClientSession
    from prompt_library_v4.lora_routes import register
    service, _, _ = browser
    async def check():
        server = SimpleNamespace(routes=web.RouteTableDef()); register(server, service)
        app = web.Application(); app.add_routes(server.routes)
        runner = web.AppRunner(app); await runner.setup()
        site = web.TCPSite(runner, '127.0.0.1', 0); await site.start()
        base = 'http://127.0.0.1:' + str(site._server.sockets[0].getsockname()[1])
        try:
            async with ClientSession() as client:
                response = await client.post(base + '/xyz/plv4/loras/list', json={})
                assert response.status == 200
                result = await response.json(); key = result['items'][0]['id']
                response = await client.post(base + '/xyz/plv4/loras/send', json={'id': key})
                assert response.status == 200 and (await response.json())['pool_id']
                assert (await client.get(base + '/xyz/plv4/loras/image/' + key + '/0')).status == 200
                assert (await client.get(base + '/xyz/plv4/loras/image/' + key + '/99')).status == 404
                assert (await client.post(base + '/xyz/plv4/loras/detail', json={'id': '../../private'})).status == 422
                assert (await client.post(base + '/xyz/plv4/loras/list', json=[])).status == 400
        finally: await runner.cleanup()
    asyncio.run(check())
