"""P1: identity, lossless mapping, atomic commands, draft and compiler consistency."""
from __future__ import annotations

from copy import deepcopy
import re
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from prompt_library_v3 import compile_text
from prompt_library_v3.document import Document, from_text, render
from prompt_library_v3.node import source_text
from prompt_library_v4.commands import apply_command, selection_ids
from prompt_library_v4.compiler import compile_document
from prompt_library_v4.model import CommandError, EditorState, full_index, js_offset, projection, python_offset


SOURCES = [
    "", " \n ", "a, b. c.", "a,\n  (b:1.2), <lora:x:0.7>, tail",
    "head, { before, { inside }, after }.set{shuffle: true}, tail",
    "[characters.same]: { a, a }.set{format: \"@$p\", weight: 1.1}",
    "[@schedule]: { 0 - 0.3: closed eyes, 0.3 - 1: { open eyes, <lora:x:0.8> } }",
    "ambient, [@region]: { base: { a } [imask: 0]: { b } fill: { c } }, tail",
    "(a, b:1.3), foo (bar:1.2) baz, { }.set{dropout: 0.35}",
    "😀, { 中文, (🎨:0.8), { café. next. } }, 𐐀",
    "[@region]: { [base, cond_weight: 0.9]: { a } [mask: [0, 0.5, 0, 1], feather: 12, include_in_base: true]: { b } [fill, cond_weight: 0.8]: { c } }",
]


def run(state, kind, **args):
    return apply_command(state, dict(type=kind, revision=state.revision, **args))


def find_raw(state, raw):
    return next(n for n in state.doc.root.walk() if n.raw == raw)


def ids(state):
    return [n.id for n in state.doc.root.walk()]


@pytest.mark.parametrize("text", SOURCES)
def test_roundtrip_projection_and_serialization(text):
    state = EditorState.create(text)
    assert state.valid and state.text == text
    assert render(Document.from_json(state.doc.to_json())) == text
    assert projection(state)["valid"]
    assert ids(state) == ids(EditorState.from_json(state.to_json()))
    assert len(ids(state)) == len(set(ids(state)))


@pytest.mark.parametrize("text", SOURCES)
@pytest.mark.parametrize("mode", ["mask", "couple"])
def test_compiler_is_the_existing_compiler_with_one_node_seed(text, mode):
    state = EditorState.create(text)
    for seed in (0, 42, 987):
        result = compile_document(state, seed=seed, region_mode=mode)
        assert result["prompt"] == compile_text(text, seed=seed, region_mode=mode, centralize_loras=True).text
        assert result["plain"] == compile_text(text, seed=seed, region_mode=mode, ignore_regions=True, centralize_loras=True).text
    assert state.text == text


def test_group_seed_is_ignored_even_inside_item_atoms():
    a = "{ a, b, c, d, e }.set{shuffle: true, seed: 77}, before ({ x, y, z }.set{shuffle: true, seed: 91}:1.2) after"
    b = a.replace(", seed: 77", "").replace(", seed: 91", "")
    state = EditorState.create(a)
    outputs = []
    for seed in range(12):
        out = compile_document(state, seed=seed, region_mode="couple")
        assert out["prompt"] == compile_text(b, seed=seed).text
        outputs.append(out["prompt"])
    assert len(set(outputs)) > 1
    assert state.text == a  # no migration/reformatting of source
    with pytest.raises(CommandError, match="seed"):
        run(state, "SetSettings", id=state.doc.root.children[0].id, patch={"seed": 7})


def test_disabled_subtrees_keep_every_setting_id_and_metadata():
    state = EditorState.create("{ a, { b, c }.set{weight: 1.2}, d }, tail")
    block = state.doc.root.children[0]
    inner = block.children[1]
    state = run(state, "SetMetadata", id=inner.id, patch={"name": "Inner", "source": {"block_id": "saved"}})
    state = run(state, "SetEnabled", id=inner.children[1].id, enabled=False)
    state = run(state, "SetEnabled", id=block.id, enabled=False)
    assert state.text == "tail"
    with pytest.raises(CommandError, match="parent"):
        run(state, "SetEnabled", id=inner.children[0].id, enabled=False)
    restored = run(state, "SetEnabled", id=block.id, enabled=True)
    assert "b" in restored.text and "c" not in restored.text
    assert ids(restored) == ids(state)
    assert restored.doc.find(inner.id).meta["source"] == {"block_id": "saved"}


def test_text_run_mapping_adds_no_ast_groups():
    state = EditorState.create("a, (b:1.2), { c }, d, e")
    before = ids(state)
    tree = projection(state)["tree"]
    assert [r["kind"] for r in tree["runs"]] == ["text_run", "block", "text_run"]
    assert len(tree["runs"][0]["ids"]) == 2
    assert ids(state) == before
    assert tree["children"][1]["form"] == "paren"


def test_empty_block_accepts_insertion_with_readable_generated_layout():
    state = EditorState.create("head, {\n  }, tail")
    block = state.doc.root.children[1]
    state = run(state, "InsertBlock", parent_id=block.id, text="{ child }")
    assert state.text == "head, {\n  {\n        child\n    }, }, tail"
    assert state.doc.find(block.id).children[0].kind == "group"


@pytest.mark.parametrize('source', SOURCES[2:])
def test_generated_layout_preserves_compilation_identity_and_parked_children(source):
    state = EditorState.create(source)
    item = next(n for n in state.doc.root.walk() if n.kind != 'group')
    state = run(state, 'SetEnabled', id=item.id, enabled=False)
    before = state.to_json()
    # An empty settings patch changes layout only, through the same command path
    # used by Details. Compare both backends and several node seeds.
    changed = run(state, 'SetSettings', id=state.doc.root.id, patch={})
    assert ids(changed) == ids(state) and not changed.doc.find(item.id).enabled
    assert state.to_json() == before
    for mode in ('couple', 'mask'):
        for seed in (0, 42, 987):
            a = compile_document(state, seed=seed, region_mode=mode)
            b = compile_document(changed, seed=seed, region_mode=mode)
            assert (a['prompt'], a['plain']) == (b['prompt'], b['plain'])
    restored = run(changed, 'SetEnabled', id=item.id, enabled=True)
    assert ids(restored) == ids(state)
    assert EditorState.from_json(restored.to_json()).text == restored.text


def test_manual_typing_remains_verbatim_after_a_generated_block():
    state = EditorState.create('a, b')
    state = run(state, 'WrapSelection', ids=[n.id for n in state.doc.root.children])
    typed = '{ a,\n b }.set{format: "line { $p }"}'
    state = run(state, 'ReplaceText', text=typed)
    assert state.text == typed


@pytest.mark.parametrize('source', [
    '{ a,\n\nb, tail\n\n }',
    '{\n    a,\n\n    b,\n    tail\n\n}',
    '{ { a,\n\nb, tail\n\n }, outside }',
    '[@region]: { [base]: { a,\n\nb, tail\n\n } [fill]: { mist } }',
    '[@schedule]: { 0 - 0.4: { a,\n\nb, tail\n\n }, 0.4 - 1: { night } }',
])
def test_prompt_switch_preserves_typed_newlines_with_legacy_layout_flag(source):
    state = EditorState.create(source)
    state.doc.root.meta['_layout_indent'] = 4
    before = deepcopy(state.doc.to_json())
    item = find_raw(state, 'a')
    off = run(state, 'SetEnabled', id=item.id, enabled=False)
    expected = deepcopy(state.doc)
    expected.find(item.id).enabled = False
    assert off.text == render(expected), 'a switch must not regenerate separators or brace layout'
    assert state.doc.to_json() == before
    restored = run(off, 'SetEnabled', id=item.id, enabled=True)
    assert restored.text == source
    assert restored.doc.to_json() == before
    assert EditorState.from_json(restored.to_json()).text == source


def test_switching_the_last_and_all_prompts_retains_parked_newlines():
    source = '{\n    a,\n\n    b\n\n}'
    state = EditorState.create(source)
    state.doc.root.meta['_layout_indent'] = 4
    names = [find_raw(state, raw).id for raw in ('a', 'b')]
    before = deepcopy(state.doc.to_json())
    for item in reversed(names):
        state = run(state, 'SetEnabled', id=item, enabled=False)
    for item in names:
        state = run(state, 'SetEnabled', id=item, enabled=True)
    assert state.text == source
    assert state.doc.to_json() == before


def test_revision_and_rejection_are_atomic():
    state = EditorState.create("a, { b }, c")
    before = deepcopy(state.to_json())
    with pytest.raises(CommandError, match="changed"):
        apply_command(state, dict(type="Delete", id=state.doc.root.children[1].id, revision=9))
    with pytest.raises(CommandError):
        run(state, "MoveBlock", id=state.doc.root.children[1].id, parent_id=state.doc.root.children[1].id)
    assert state.to_json() == before


def test_wrap_visible_selection_carries_invisible_siblings_in_place():
    state = EditorState.create("a, b, off, c, d")
    off = state.doc.root.children[2].id
    state = run(state, "SetEnabled", id=off, enabled=False)
    b, c = state.doc.root.children[1].id, state.doc.root.children[3].id
    state = run(state, "WrapSelection", ids=[b, c])
    assert state.text == "a, {\n    b, c\n}, d"
    group = state.doc.root.children[1]
    assert [n.id for n in group.children] == [b, off, c]
    assert not group.children[1].enabled
    state = run(state, "SetEnabled", id=off, enabled=True)
    assert state.text == "a, {\n    b, off, c\n}, d"
    assert state.selection["block_id"] == group.id


def test_wrap_can_include_complete_child_block_but_not_partial_or_cross_parent():
    state = EditorState.create("a, { b, { c }, d }, e")
    inner = state.doc.root.children[1].children[1]
    original = inner.id
    parent = state.doc.root.children[1]
    state = run(state, "WrapSelection", ids=[parent.children[0].id, inner.id])
    assert state.doc.find(original).id == original
    assert state.doc.root.children[1].children[0].children[1].id == original
    with pytest.raises(CommandError):
        selection_ids(state, [1, state.text.index("c")+1])


def test_unicode_selection_and_repeated_prompt_details_use_identity():
    state = EditorState.create("😀, { 同名, 同名, last }")
    block = state.doc.root.children[1]
    rows = projection(state)["tree"]["children"][1]["children"]
    assert rows[0]["span"] == [6, 8]
    assert selection_ids(state, [6, 12]) == [block.children[0].id, block.children[1].id]
    selected = run(state, "LocateDetails", id=block.children[1].id)
    assert selected.selection == dict(node_id=block.children[1].id, block_id=block.id, prompt_id=block.children[1].id)
    assert selected.text == state.text
    assert python_offset("😀x", 2) == 1 and js_offset("😀x", 1) == 2
    with pytest.raises(CommandError, match="surrogate"):
        python_offset("😀x", 1)


def test_move_keeps_ids_disabled_items_and_metadata_and_uses_adjacent_id():
    state = EditorState.create("{ a, { b, off }, c }, { d, e }, tail")
    first, second = state.doc.root.children[:2]
    block = first.children[1]
    state = run(state, "SetEnabled", id=block.children[1].id, enabled=False)
    state = run(state, "SetMetadata", id=block.id, patch={"pool": "C"})
    old_ids = set(ids(state))
    state = run(state, "MoveBlock", id=block.id, parent_id=second.id, before_id=second.children[1].id)
    assert state.text == "{ a, c }, { d, { b, }, e }, tail"
    assert set(ids(state)) == old_ids
    assert state.doc.find(block.id).meta["pool"] == "C"
    assert state.doc.find(block.id).children[1].enabled is False
    state = run(state, "MoveBlock", id=block.id, parent_id=state.doc.root.id, after_id=first.id)
    assert [n.id for n in state.doc.root.children][:3] == [first.id, block.id, second.id]


def test_library_block_insertion_is_a_snapshot_with_new_ids():
    source = EditorState.create("{ a, { b, off }.set{weight: 1.2} }")
    off = source.doc.root.children[0].children[1].children[1]
    source = run(source, "SetEnabled", id=off.id, enabled=False)
    snapshot = source.doc.root.children[0].to_json()
    before = deepcopy(snapshot)
    target = EditorState.create("left, right")
    target = run(target, "InsertLibraryBlock", parent_id=target.doc.root.id,
                 before_id=target.doc.root.children[1].id, snapshot=snapshot, source={"block_id": "B", "revision": 2})
    block = target.doc.root.children[1]
    assert block.meta["source"]["block_id"] == "B"
    assert not block.children[1].children[1].enabled
    assert len(ids(target)) == len(set(ids(target)))
    assert snapshot == before
    assert "left, {\n    a,\n    {\n        b,\n    }.set{weight: 1.2}\n}" in target.text


def test_library_prompt_insertion_removes_group_settings_not_item_weights():
    source = EditorState.create("{ a, (b:1.3), { c, off }.set{weight: 2, schedule: {0, 0.4}}, <lora:x:0.7> }.set{shuffle: true, format: \"@$p\"}")
    off = find_raw(source, "off")
    source = run(source, "SetEnabled", id=off.id, enabled=False)
    snapshot = source.doc.root.children[0].to_json()
    target = EditorState.create("tail")
    target = run(target, "InsertLibraryPrompts", parent_id=target.doc.root.id, edge="start", snapshot=snapshot)
    assert target.text == "a, (b:1.3), c, <lora:x:0.7>, tail"
    assert not any(n.meta for n in target.doc.root.walk())


def test_candidate_occurrence_is_local_and_reenable_restores_subtree():
    state = EditorState.create("{ existing }")
    parent_id = state.doc.root.children[0].id
    args = dict(parent_id=parent_id, text="{ a, b }", source={"block_id": "B"}, occurrence=["C", "attr", "B"])
    state = run(state, "EnableCandidate", **args)
    part = state.doc.find(parent_id).children[-1]
    state = run(state, "SetEnabled", id=part.children[1].id, enabled=False)
    state = run(state, "SetEnabled", id=part.id, enabled=False)
    state = run(state, "EnableCandidate", **args)
    assert len(state.doc.find(parent_id).children) == 2
    assert state.doc.find(part.id).enabled and not state.doc.find(part.children[1].id).enabled


def test_draft_survives_serialization_view_projection_and_strict_execution():
    state = EditorState.create("{ a, off }, tail")
    block = state.doc.root.children[0]
    state = run(state, "SetEnabled", id=block.children[1].id, enabled=False)
    bad = "{ a, broken .set{, 😀"
    draft = run(state, "ReplaceText", text=bad)
    assert not draft.valid and draft.text == bad
    assert projection(draft)["raw"] == bad and projection(draft)["tree"] is None
    serialized = draft.to_json()
    loaded = EditorState.from_json(serialized)
    assert loaded.text == bad
    assert source_text("stale", __import__("json").dumps(serialized["doc"])) == bad
    with pytest.raises(CommandError):
        compile_document(loaded, seed=0, region_mode="couple")
    with pytest.raises(CommandError):
        run(loaded, "Delete", id=block.id)
    repaired = run(loaded, "ReplaceText", text="{ a, }, tail, extra")
    assert repaired.valid and repaired.doc.find(block.children[1].id).enabled is False


def test_library_draft_keeps_extra_roots_and_root_commands_are_atomic():
    state = EditorState.create("{ a }", scope="block")
    bad = run(state, "ReplaceText", text="{ a }, { extra }")
    assert not bad.valid and bad.text == "{ a }, { extra }"
    assert projection(bad)["diagnostics"][-1]["code"] == "single_root"
    before = state.to_json()
    with pytest.raises(CommandError):
        run(state, "Delete", id=state.doc.root.children[0].id)
    assert state.to_json() == before


def test_settings_edit_preserves_disabled_children_and_unknown_source_fields():
    state = EditorState.create("head, { a, off }.set{ custom: 7, weight: 1.2 }, tail")
    group = state.doc.root.children[1]
    state = run(state, "SetEnabled", id=group.children[1].id, enabled=False)
    state = run(state, "SetSettings", id=group.id, patch={"weight": 1.5, "shuffle": True})
    assert "custom: 7" in state.text and "weight: 1.5" in state.text and "shuffle: true" in state.text
    assert not state.doc.find(group.children[1].id).enabled
    state = run(state, "SetSettings", id=group.id, patch={"weight": None})
    assert "weight:" not in state.text


def test_text_run_edit_preserves_parked_items_and_mixed_order():
    state = EditorState.create("{ before, off, next, { inside }, after }")
    group = state.doc.root.children[0]
    state = run(state, "SetEnabled", id=group.children[1].id, enabled=False)
    state = run(state, "EditTextRun", ids=[group.children[0].id, group.children[2].id], text="changed, next")
    assert state.text == "{ changed, next, { inside }, after }"
    assert not state.doc.find(group.children[1].id).enabled


def test_region_head_changes_keep_mask_and_reject_move_out():
    state = EditorState.create("ambient, [@region]: { base: { a } [imask: 0]: { red } [imask: 1]: { blue } }, tail")
    region = state.doc.root.children[1]
    red = region.children[1]
    state = run(state, "SetRegion", id=red.id, region={"kind": "imask", "imask": 3, "feather": 12})
    assert "[imask: 3, feather: 12]: {\n        red\n    }" in state.text
    before = state.to_json()
    with pytest.raises(CommandError, match="所属容器"):
        run(state, "MoveBlock", id=red.id, parent_id=state.doc.root.id, edge="end")
    assert state.to_json() == before
    _, index = full_index(state.doc)
    assert index[red.id].settings.region.imask == 3
    assert index[region.children[2].id].settings.region.imask == 1


def test_schedule_boundary_updates_both_raw_heads_and_disabled_slots():
    state = EditorState.create("[@schedule]: { 0 - 0.3: a, 0.3 - 0.6: { b }, 0.6 - 1: c }")
    schedule = state.doc.root.children[0]
    middle = schedule.children[1]
    state = run(state, "SetEnabled", id=middle.id, enabled=False)
    state = run(state, "SetScheduleBoundary", id=middle.id, side="start", value=0.4)
    full, index = full_index(state.doc)
    assert "0 - 0.4:" in full and "0.4 - 0.6:" in full
    assert index[middle.id].settings.schedule == (0.4, 0.6)
    state = run(state, "SetEnabled", id=middle.id, enabled=True)
    assert "0 - 0.4:" in state.text and "0.4 - 0.6:" in state.text
    leaf_id = schedule.children[0].children[0].id
    expected = deepcopy(state.doc)
    expected.find(leaf_id).enabled = False
    state = run(state, "SetEnabled", id=leaf_id, enabled=False)
    assert state.text == render(expected)  # preserve the existing empty entry shell/layout
    assert not full_index(state.doc)[1][schedule.children[0].id].implicit


def test_schedule_entry_cannot_move_out_but_new_entry_can_be_created():
    state = EditorState.create("[@schedule]: { 0 - 0.3: a, 0.3 - 1: { b } }, { tail }")
    schedule, target = state.doc.root.children
    first = schedule.children[0]
    before = state.to_json()
    with pytest.raises(CommandError, match="所属容器"):
        run(state, "MoveBlock", id=first.id, parent_id=target.id, edge="start")
    assert state.to_json() == before
    state = run(state, "InsertEntry", parent_id=schedule.id, after_id=first.id, entry={"schedule": [0.15, 0.3]})
    created = state.doc.find(schedule.id).children[1]
    assert created.form == 'schedule_entry' and not created.children
    assert full_index(state.doc)[1][created.id].settings.schedule == (0.15, 0.3)


def test_illegal_latent_region_move_and_special_drop_are_rejected():
    state = EditorState.create("{ a }.set{region: [imask: 0]}, { { b }.set{region: [imask: 1]} }, [@schedule]: { 0 - 1: c }")
    a, b, schedule = state.doc.root.children
    before = state.to_json()
    with pytest.raises(Exception, match="region"):
        run(state, "MoveBlock", id=b.id, parent_id=a.id)
    with pytest.raises(CommandError, match="entry"):
        run(state, "MoveBlock", id=b.id, parent_id=schedule.id)
    assert state.to_json() == before


def test_legacy_version_one_upgrades_without_losing_raw_source():
    doc = from_text("{ a, b }").to_json()
    doc["version"] = 1
    for node in doc["root"]["children"]:
        node.pop("form", None)
    state = EditorState.create(doc=doc)
    assert state.doc.version == 2 and state.text == "{ a, b }"
    assert state.doc.root.children[0].form == "brace"
    doc["version"] = 99
    with pytest.raises(ValueError, match="version"):
        Document.from_json(doc)


def test_prompt_settings_use_explicit_wrappers_and_lora_internal_weight():
    state = EditorState.create("a, <lora:x:0.7>, b")
    a, lora, b = state.doc.root.children
    state = run(state, "SetPromptSettings", id=lora.id, patch={"weight": -0.5})
    assert "<lora:x:-0.5>" in state.text
    state = run(state, "SetPromptSettings", id=a.id, patch={"weight": 1.3})
    assert state.text.startswith("(a:1.3), ")
    assert state.doc.find(a.id).raw == "a"
    state = run(state, "SetPromptSettings", id=b.id, patch={"schedule": [0.2, 0.8]})
    wrapper = state.doc.root.children[-1]
    assert wrapper.meta["presentation"] == "prompt" and wrapper.children[0].id == b.id
    state = run(state, "SetPromptSettings", id=b.id, patch={"region": {"kind": "imask", "imask": 2}})
    assert state.doc.root.children[-1].id == wrapper.id
    assert state.doc.find(b.id).raw == "b"


def test_manually_typed_attention_weight_and_schedule_reuse_the_same_prompt():
    state = EditorState.create("(a:1.2), tail")
    wrapper = state.doc.root.children[0]
    leaf = wrapper.children[0]
    state = run(state, "SetPromptSettings", id=leaf.id, patch={"weight": 1.3})
    assert state.text == "(a:1.3), tail"
    assert state.doc.root.children[0].id == wrapper.id
    state = run(state, "SetPromptSettings", id=leaf.id, patch={"schedule": [0.2, 0.8]})
    assert state.doc.root.children[0].id == wrapper.id
    assert state.doc.find(leaf.id).raw == "a"
    assert state.doc.root.children[0].meta['presentation'] == 'prompt'
    assert "[(a:1.3), :0.2,0.8]" in compile_document(state, seed=3, region_mode='couple')['prompt']


def test_block_ui_prompt_span_marks_only_exact_shells_and_preserves_utf16_identity():
    state = EditorState.create("head, 😀")
    leaf = state.doc.root.children[-1]
    text = "head, { 😀 }.set{weight: 1.2, schedule: {0.2, 0.8}}"
    span = [js_offset(text, text.index('{')), js_offset(text, len(text))]
    state = run(state, "ReplaceText", text=text, prompt_spans=[span])
    shell = state.doc.root.children[-1]
    assert shell.meta['presentation'] == 'prompt'
    # Adding a shell is a shape change; the resulting leaf keeps its identity
    # through subsequent text/settings edits within that shell.
    child_id = shell.children[0].id
    edited = text.replace('😀', '😀 sunrise')
    state = run(state, "ReplaceText", text=edited,
                prompt_spans=[[span[0], js_offset(edited, len(edited))]])
    assert state.doc.root.children[-1].id == shell.id
    assert state.doc.root.children[-1].children[0].id == child_id
    assert state.doc.root.children[0].raw == 'head'


@pytest.mark.parametrize('spans', [[[0, 1]], [[True, 1]], [[0]], 'invalid', [[0, 3]]])
def test_block_ui_prompt_spans_cannot_mark_items_or_partial_shells(spans):
    state = EditorState.create("a, { b }")
    before = state.to_json()
    with pytest.raises(CommandError, match='span'):
        run(state, 'ReplaceText', text=state.text, prompt_spans=spans)
    assert state.to_json() == before


def test_legacy_prompt_region_is_located_as_a_block_and_is_not_erased():
    state = EditorState.create('a')
    leaf = state.doc.root.children[0]
    state = run(state, 'SetPromptSettings', id=leaf.id, patch={'region': {'kind': 'base'}})
    shell = state.doc.root.children[0]
    state = run(state, 'LocateDetails', id=shell.id)
    assert state.selection['block_id'] == shell.id
    assert 'region: [base]' in state.text


def test_new_block_does_not_reformat_existing_source_even_with_legacy_layout_flag():
    original = '  head,  {old,\n  spaced},\t tail  '
    state = EditorState.create(original)
    state.doc.root.meta['_layout_indent'] = 4
    old = state.doc.root.children[1]
    state = run(state, 'InsertBlock', parent_id=state.doc.root.id, after_id=old.id, text='{ new }')
    new = state.doc.root.children[2]
    assert '{\n    new\n}' in state.text
    assert state.text.startswith('  head,  {old,\n  spaced},\t ')
    assert state.text.endswith(' tail  ')
    assert state.doc.find(old.id).raw == '{old,\n  spaced}'


@pytest.mark.parametrize('legacy_layout', [False, True])
@pytest.mark.parametrize('cross_parent', [False, True])
def test_move_keeps_user_newlines_in_mixed_text_and_block_runs(legacy_layout, cross_parent):
    original = '{ first,\n\nsecond, { inner,\n\nbody }, middle,\nlast }, { target,\n\nend }'
    state = EditorState.create(original)
    if legacy_layout: state.doc.root.meta['_layout_indent'] = 4
    owner, target = state.doc.root.children
    block = owner.children[2]
    bodies = {n.id:n.raw for n in state.doc.root.walk() if n.kind != 'group'}
    gaps = {n.id:n.sep for n in state.doc.root.walk() if n.kind != 'group'}
    moved = run(state, 'MoveBlock', id=block.id, parent_id=(target if cross_parent else owner).id, edge='end')
    assert {n.id:n.raw for n in moved.doc.root.walk() if n.kind != 'group'} == bodies
    assert moved.doc.find(owner.children[0].id).sep == gaps[owner.children[0].id]
    assert moved.doc.find(target.children[0].id).sep == gaps[target.children[0].id]
    assert moved.doc.find(block.id).raw == block.raw
    assert 'first,\n\nsecond' in moved.text
    assert 'inner,\n\nbody' in moved.text
    assert 'target,\n\nend' in moved.text


def test_text_entry_anchor_places_new_items_before_a_parked_subblock():
    state = EditorState.create('{ { left }, { parked }, { right } }')
    parent = state.doc.root.children[0]
    parked = parent.children[1]
    parked.enabled = False
    old_ids = set(ids(state))
    anchor = {'parent_id':parent.id, 'before_id':parked.id}
    text = state.text.replace('{ right }', 'middle, next, { right }')
    state = run(state, 'ReplaceText', text=text, insert_anchor=anchor)
    children = state.doc.find(parent.id).children
    assert [n.raw for n in children] == ['{ left }','middle','next','{ parked }','{ right }']
    assert state.doc.find(parked.id).enabled is False
    assert old_ids <= set(ids(state))
    assert state.text == text
    text = state.text.replace('next, ', 'next, third, ')
    state = run(state, 'ReplaceText', text=text, insert_anchor=anchor)
    assert [n.raw for n in state.doc.find(parent.id).children][1:5] == ['middle','next','third','{ parked }']


@pytest.mark.parametrize('source, selected', [
    ('before, soft golden light, after', 'golden'),
    ('before, 中文 😀 sunrise, after', '😀 sunrise'),
    ('before, first prompt, second prompt, after', 'prompt, second'),
])
def test_create_as_block_wraps_arbitrary_selected_string_in_place(source, selected):
    state = EditorState.create(source)
    a = source.index(selected); b = a + len(selected)
    state = run(state, 'CreateAsBlock', span=[js_offset(source, a), js_offset(source, b)])
    assert state.text[:a] == source[:a]
    assert state.text.endswith(source[b:])
    assert '{\n    ' + selected + '\n}' in state.text
    assert state.doc.find(state.selection['block_id']).form == 'brace'
    state.check()


def test_create_as_block_rejects_an_empty_selection_without_changing_the_document():
    state = EditorState.create('(a:1.2), tail')
    before = state.to_json()
    with pytest.raises(CommandError, match='non-empty'):
        run(state, 'CreateAsBlock', span=[3, 3])
    assert state.to_json() == before


def test_enable_prompt_candidate_retains_occurrence_identity():
    state = EditorState.create("{ a }")
    parent = state.doc.root.children[0]
    args = dict(parent_id=parent.id, text="(new:1.2)", source={"attribute_id": "P"}, occurrence=["C", "P"])
    state = run(state, "EnableCandidate", **args)
    item = state.doc.find(parent.id).children[-1]
    state = run(state, "SetEnabled", id=item.id, enabled=False)
    state = run(state, "EnableCandidate", **args)
    assert len(state.doc.find(parent.id).children) == 2
    assert state.doc.find(item.id).enabled


def test_special_same_parent_reorder_keeps_time_slots_and_region_heads():
    state = EditorState.create("[@schedule]: { 0 - 0.3: a, 0.3 - 0.6: b, 0.6 - 1: c }")
    container = state.doc.root.children[0]
    a, b, c = container.children
    state = run(state, "MoveBlock", id=c.id, parent_id=container.id, before_id=a.id)
    _, index = full_index(state.doc)
    assert [n.id for n in state.doc.find(container.id).children] == [c.id, a.id, b.id]
    assert index[c.id].settings.schedule == (0, 0.3)
    assert index[a.id].settings.schedule == (0.3, 0.6)
    assert index[b.id].settings.schedule == (0.6, 1)
    region = EditorState.create("[@region]: { [imask: 0]: { red } [imask: 1]: { blue } }")
    container = region.doc.root.children[0]
    red, blue = container.children
    region = run(region, "MoveBlock", id=blue.id, parent_id=container.id, before_id=red.id)
    _, index = full_index(region.doc)
    assert index[red.id].settings.region.imask == 0 and index[blue.id].settings.region.imask == 1


@pytest.mark.parametrize('form', ['schedule', 'region'])
def test_new_special_container_defaults_are_atomic_and_preserve_surrounding_content(form):
    state = EditorState.create('before,\n\n{ old },\n\nend')
    old = state.doc.root.children[1]
    before = state.to_json()
    created = run(state, 'InsertBlock', parent_id=state.doc.root.id, after_id=old.id, form=form)
    container = created.doc.root.children[2]
    assert created.revision == state.revision + 1 and state.to_json() == before
    assert container.form == form
    assert all(entry.enabled and not entry.children for entry in container.children)
    assert len(ids(created)) == len(set(ids(created)))
    assert created.text.startswith('before,\n\n{ old },\n\n') and created.text.endswith('end')
    _, index = full_index(created.doc)
    if form == 'schedule':
        assert [index[n.id].settings.schedule for n in container.children] == [(0, .5), (.5, 1)]
    else:
        assert [index[n.id].settings.region.kind for n in container.children] == ['base', 'mask', 'mask', 'fill']
        assert index[container.children[1].id].settings.region.mask == (0, .5, 0, 1)
        assert index[container.children[2].id].settings.region.mask == (.5, 1, 0, 1)
        assert [n.meta['name'] for n in container.children] == ['Base', 'Mask 1', 'Mask 2', 'Fill']
    restored = EditorState.from_json(created.to_json())
    assert restored.doc.to_json() == created.doc.to_json()
    for mode in ('mask', 'couple'):
        assert compile_document(restored, seed=42, region_mode=mode)['plain'] == 'before, old, end'


@pytest.mark.parametrize('form', ['schedule', 'region'])
def test_entry_cannot_move_between_containers_or_into_an_entry_body(form):
    state = EditorState.create('')
    for _ in range(2):
        state = run(state, 'InsertBlock', parent_id=state.doc.root.id, form=form)
    a, b = state.doc.root.children
    entry = a.children[0]
    before = state.to_json()
    for target in (b, b.children[0], state.doc.root):
        with pytest.raises(CommandError, match='所属容器'):
            run(state, 'MoveBlock', id=entry.id, parent_id=target.id,
                entry={'schedule': [0, .25], 'region': {'kind': 'base'}})
    assert state.to_json() == before


@pytest.mark.parametrize('form', ['schedule', 'region'])
@pytest.mark.parametrize('command', ['MoveBlock', 'InsertBlock', 'InsertLibraryBlock', 'EnableCandidate', 'InsertLibraryPrompts'])
def test_external_blocks_cannot_be_promoted_to_entries_even_with_entry_settings(form, command):
    state = EditorState.create('{ external }')
    external = state.doc.root.children[0]
    state = run(state, 'InsertBlock', parent_id=state.doc.root.id, form=form)
    container = state.doc.root.children[1]
    before = state.to_json()
    args = dict(parent_id=container.id, entry={'schedule': [0, .25], 'region': {'kind': 'base'}})
    if command == 'MoveBlock':
        args['id'] = external.id
    elif command != 'InsertBlock':
        args.update(snapshot=external.to_json(), source={'kind': 'block', 'id': 'external'}, occurrence={})
    with pytest.raises(CommandError, match='entry'):
        run(state, command, **args)
    assert state.to_json() == before


@pytest.mark.parametrize('form', ['schedule', 'region'])
def test_external_and_library_subblocks_can_enter_and_leave_entry_bodies(form):
    state = EditorState.create('{ external }.set{weight: 1.2}')
    external = state.doc.root.children[0]
    state = run(state, 'InsertBlock', parent_id=state.doc.root.id, form=form)
    container = state.doc.root.children[1]
    entry = container.children[0]
    state = run(state, 'MoveBlock', id=external.id, parent_id=entry.id)
    assert state.doc.find(entry.id).children[0].id == external.id
    assert full_index(state.doc)[1][external.id].settings.weight == 1.2
    source = EditorState.create('{ library, { nested } }').doc.root.children[0].to_json()
    state = run(state, 'InsertLibraryBlock', parent_id=entry.id, snapshot=source,
                source={'kind': 'block', 'id': 'saved', 'version': 1})
    inserted = state.doc.find(entry.id).children[1]
    assert inserted.meta['source']['id'] == 'saved'
    state = run(state, 'MoveBlock', id=inserted.id, parent_id=state.doc.root.id)
    assert state.doc.root.children[-1].id == inserted.id
    assert state.doc.find(entry.id).children[0].id == external.id


def test_insert_entry_only_creates_empty_entries_in_special_containers():
    state = EditorState.create('[@region]: { [base]: { } }, { ordinary }')
    container, ordinary = state.doc.root.children
    before = state.to_json()
    for extra in ({'text': '{ existing }'}, {'snapshot': ordinary.to_json()}, {'form': 'schedule'}):
        with pytest.raises(CommandError, match='不能由外部'):
            run(state, 'InsertEntry', parent_id=container.id, entry={'region': {'kind': 'fill'}}, **extra)
    with pytest.raises(CommandError, match='新建 entry'):
        run(state, 'InsertEntry', parent_id=ordinary.id, entry={'region': {'kind': 'fill'}})
    assert state.to_json() == before
    state = run(state, 'InsertEntry', parent_id=container.id, entry={'region': {'kind': 'fill'}})
    assert state.doc.find(container.id).children[-1].form == 'region_entry'


def test_new_region_container_rejects_disabled_region_ancestry_atomically():
    state = EditorState.create('{ outer }.set{region: [imask: 0]}')
    outer = state.doc.root.children[0]
    state = run(state, 'SetEnabled', id=outer.id, enabled=False)
    before = state.to_json()
    with pytest.raises(Exception, match='region'):
        run(state, 'InsertBlock', parent_id=outer.id, form='region')
    assert state.to_json() == before


def test_library_insertion_ids_are_fresh_even_in_an_empty_document():
    source = EditorState.create("{ a, { b } }")
    snapshot = source.doc.root.children[0].to_json()
    old = {n.id for n in source.doc.root.children[0].walk()}
    target = EditorState.create("")
    target = run(target, "InsertLibraryBlock", parent_id=target.doc.root.id, snapshot=snapshot, source={"block_id": "B"})
    assert not old.intersection(n.id for n in target.doc.root.children[0].walk())


def test_disabled_region_cannot_hide_an_illegal_move():
    state = EditorState.create("{ outer }.set{region: [imask: 0]}, { { hidden }.set{region: [imask: 1]} }")
    outer, moving = state.doc.root.children
    state = run(state, "SetEnabled", id=moving.children[0].id, enabled=False)
    before = state.to_json()
    with pytest.raises(Exception, match="region"):
        run(state, "MoveBlock", id=moving.id, parent_id=outer.id)
    assert state.to_json() == before


def test_deep_structure_and_parser_limit_are_preserved_by_commands():
    state = EditorState.create("{ " * 64 + "leaf" + " }" * 64)
    assert state.valid and projection(state)["valid"]
    before = state.to_json()
    deepest = next(n for n in state.doc.root.walk() if n.kind == "group" and n.children and n.children[0].raw == "leaf")
    with pytest.raises(Exception, match="deep"):
        run(state, "WrapSelection", ids=[deepest.children[0].id])
    assert state.to_json() == before


@pytest.mark.parametrize("count", [100, 500])
def test_large_document_move_and_wrap_do_not_drop_nodes(count):
    state = EditorState.create(", ".join("{ p%d, { q%d } }" % (i, i) for i in range(count)))
    before = set(ids(state))
    moving = state.doc.root.children[-1]
    state = run(state, "MoveBlock", id=moving.id, parent_id=state.doc.root.id, before_id=state.doc.root.children[0].id)
    assert set(ids(state)) == before and state.doc.root.children[0].id == moving.id
    state = run(state, "WrapSelection", ids=[n.id for n in state.doc.root.children[:3]])
    assert len(ids(state)) == len(before) + 1


@pytest.mark.parametrize('enabled', [True, False])
def test_detail_pasted_items_use_plv3_splitting_and_preserve_identity_and_parked_siblings(enabled):
    state = EditorState.create('{ before, solo, parked, after }')
    parent = state.doc.root.children[0]
    target, parked = parent.children[1:3]
    state = run(state, 'SetEnabled', id=parked.id, enabled=False)
    state = run(state, 'SetEnabled', id=target.id, enabled=enabled)
    before = state.to_json()
    updated = run(state, 'ReplaceItem', id=target.id, text='solo, blonde hair, a cat. on a mat.')
    children = updated.doc.root.children[0].children
    assert [node.raw for node in children] == ['before', 'solo', 'blonde hair', 'a cat.', 'on a mat.', 'parked', 'after']
    assert children[1].id == target.id
    assert all(node.enabled is enabled for node in children[1:5])
    assert children[5].id == parked.id and not children[5].enabled
    assert len(ids(updated)) == len(set(ids(updated)))
    assert state.to_json() == before
    assert projection(updated)['valid']


def test_detail_item_empty_edit_removes_only_its_owned_prompt():
    state = EditorState.create('before, solo, after')
    updated = run(state, 'ReplaceItem', id=state.doc.root.children[1].id, text='')
    assert [node.raw for node in updated.doc.root.children] == ['before', 'after']
    assert updated.text == 'before, after'


@pytest.mark.parametrize('text', ['(solo:1.2), after', '{ solo }.set{weight: 1.2, schedule: {0.1, 0.8}}, after'])
def test_detail_list_edit_keeps_owned_weight_and_schedule_like_plv3_span_edit(text):
    state = EditorState.create(text)
    target = find_raw(state, 'solo')
    updated = run(state, 'ReplaceItem', id=target.id, text='solo, blonde hair')
    expected = text.replace('solo', 'solo, blonde hair')
    assert updated.text == expected
    assert compile_document(updated, seed=7, region_mode='couple')['prompt'] == compile_text(expected, seed=7, region_mode='couple').text


@pytest.mark.parametrize('form', ['schedule', 'region'])
def test_container_pool_is_rejected_while_entry_pool_remains_editable(form):
    state = EditorState.create('')
    state = run(state, 'InsertBlock', parent_id=state.doc.root.id, form=form)
    container = state.doc.root.children[0]
    before = state.to_json()
    with pytest.raises(CommandError) as error:
        run(state, 'SetMetadata', id=container.id, patch={'pool': 'folder'})
    assert error.value.code == 'container_pool'
    assert state.to_json() == before
    entry = container.children[0]
    updated = run(state, 'SetMetadata', id=entry.id, patch={'pool': 'folder'})
    assert updated.doc.find(entry.id).meta['pool'] == 'folder'
    assert not updated.doc.find(container.id).meta.get('pool')


@pytest.mark.parametrize('form', ['schedule', 'region'])
def test_opening_old_container_binding_preserves_source_ids_and_entry_binding(form):
    state = EditorState.create('')
    state = run(state, 'InsertBlock', parent_id=state.doc.root.id, form=form)
    container = state.doc.root.children[0]
    container.meta['pool'] = 'obsolete-container-pool'
    container.children[0].meta['pool'] = 'entry-pool'
    container.children[-1].enabled = False
    before = state.to_json()
    restored = EditorState.create(doc=before['doc'])
    assert restored.text == before['text']
    assert [node.id for node in restored.doc.root.walk()] == [node.id for node in state.doc.root.walk()]
    assert not restored.doc.find(container.id).meta.get('pool')
    assert restored.doc.find(container.children[0].id).meta['pool'] == 'entry-pool'
    assert not restored.doc.find(container.children[-1].id).enabled
    assert state.to_json() == before


@pytest.mark.parametrize('form', ['schedule', 'region'])
@pytest.mark.parametrize('patch', [{'shuffle': True}, {'dropout': .35}, {'random_select': [0, 1]}, {'format': '@$p'}])
def test_container_rejects_random_and_format_settings_while_entry_accepts_them(form, patch):
    state = EditorState.create('')
    state = run(state, 'InsertBlock', parent_id=state.doc.root.id, form=form)
    container = state.doc.root.children[0]
    before = state.to_json()
    with pytest.raises(CommandError) as error:
        run(state, 'SetSettings', id=container.id, patch=patch)
    assert error.value.code == 'container_setting'
    assert state.to_json() == before
    updated = run(state, 'SetSettings', id=container.children[0].id, patch=patch)
    key, value = next(iter(patch.items()))
    assert projection(updated)['tree']['children'][0]['children'][0]['settings'][key] == value


@pytest.mark.parametrize('source', [
    '{ a,\nb, c\n }, { other }',
    '{\n    a,\n    b\n}, { other }',
    'a,\nb, c\n, { other }',
    '[@schedule]: { 0 - 0.5: { a,\nb\n\n }, 0.5 - 1: { other } }',
])
@pytest.mark.parametrize('command', ['settings', 'delete'])
def test_whole_document_layout_keeps_typed_line_breaks(source, command):
    # SetSettings / Delete / Region / Library updates re-lay-out the whole
    # document. Enter between prompts and at the end of a block is content.
    state = EditorState.create(source)
    state.doc.root.meta['_layout_indent'] = 4
    other = find_raw(state, 'other')
    if command == 'settings':
        state = run(state, 'SetSettings', id=state.doc.root.id, patch={})
    else:
        owner = next(n for n in state.doc.root.walk() if other in n.children)
        state = run(state, 'Delete', id=owner.id if owner.form != 'root' else other.id)
    text = state.text
    if not source.startswith('{\n'):
        assert 'a,\nb' in text
    for _ in range(3):
        state = run(state, 'SetSettings', id=state.doc.root.id, patch={})
    assert state.text == text, 'layout must be stable across repeated commands'
    if source.startswith('{ a') or source.startswith('[@'):
        assert re.search(r'[bc]\n\n\s*}', text), text


def test_layout_keeps_a_trailing_enter_but_adds_none():
    state = EditorState.create('{ a, b\n }, x')
    state.doc.root.meta['_layout_indent'] = 4
    state = run(state, 'SetSettings', id=state.doc.root.id, patch={})
    assert state.text == '{\n    a, b\n\n},\nx'
    state = run(state, 'SetSettings', id=state.doc.root.id, patch={})
    assert state.text == '{\n    a, b\n\n},\nx'
    plain = run(EditorState.create('{ a, b }'), 'SetSettings', id=EditorState.create('{ a, b }').doc.root.id, patch={})
    assert plain.text == '{\n    a, b\n}'


def test_layout_treats_enter_before_a_separator_space_as_typed():
    # Enter at `skinny,| long legs` yields `,\n\n long`: one space after a
    # newline is the old separator space, not generated indentation.
    for gap in ('\n\n ', '\n '):
        state = EditorState.create('{ grey hair, skinny,' + gap + 'long legs }, { other }')
        state = run(state, 'SetSettings', id=state.doc.root.id, patch={})
        assert 'skinny,' + gap + 'long legs' in state.text


def test_windows_line_ends_are_normalised_on_open_commands_and_typing():
    # A CR left in the source is an invisible character in the Blocks view's
    # native text: a blank line made of `CR LF` + `LF` cannot take the caret.
    crlf = '{\r\n    full body, \r\n\nkafka, upper body\r\n},\r\n{ x }'
    state = EditorState.create(crlf)
    assert '\r' not in state.text and 'full body, \n\nkafka' in state.text
    legacy = EditorState.create(None, doc=from_text(crlf).to_json())
    assert legacy.text == state.text
    payload = legacy.to_json()
    payload['doc'] = from_text(crlf).to_json(); payload['text'] = crlf
    assert EditorState.from_json(payload).text == state.text
    typed = run(state, 'ReplaceText', text=state.text.replace('upper body', 'upper body,\r\ncowboy shot'))
    assert '\r' not in typed.text and 'upper body,\ncowboy shot' in typed.text
