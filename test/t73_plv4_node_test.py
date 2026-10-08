"""P2 persisted editor policy and node execution agree with preview."""
import json
from pathlib import Path
import sys

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from prompt_library_v3.compile import compile_text
from prompt_library_v3.diagnostics import PLv3Error
from prompt_library_v3.node import PromptLibraryV3Node, uses_node_seed
from prompt_library_v4.commands import apply_command
from prompt_library_v4.compiler import compile_document
from prompt_library_v4.model import EditorState


SOURCE = "{ a, b, c, d, e, f, g, h }.set{shuffle: true, random_select: 3, seed: 999}"


@pytest.mark.parametrize("mode", ["couple", "mask"])
def test_saved_plv4_snapshot_executes_with_node_seed_and_two_outputs(mode):
    state = EditorState.create(SOURCE)
    state.doc.root.meta["compiler"] = "plv4"
    preview = compile_document(state, seed=42, region_mode=mode)
    doc = json.dumps(state.doc.to_json())
    assert uses_node_seed(doc)
    assert PromptLibraryV3Node().execute("stale textarea", seed=42, region_mode=mode, doc=doc) == (
        preview["prompt"], preview["plain"]
    )
    assert preview["prompt"] != compile_text(SOURCE, seed=42, region_mode=mode).text


def test_existing_v3_workflow_and_cache_keep_distinct_policy():
    state = EditorState.create(SOURCE)
    node = PromptLibraryV3Node()
    original = json.dumps(state.doc.to_json())
    assert node.execute(SOURCE, seed=42, doc=original)[0] == compile_text(SOURCE, seed=42).text
    state.doc.root.meta["compiler"] = "plv4"
    marked = json.dumps(state.doc.to_json())
    assert node.IS_CHANGED(SOURCE, seed=42, doc=original) != node.IS_CHANGED(SOURCE, seed=42, doc=marked)
    assert not any(uses_node_seed(value) for value in ("", "{broken", "null", "[]"))


def test_saved_invalid_draft_does_not_execute_last_valid_tree():
    state = EditorState.create("{ valid }")
    state.doc.root.meta["compiler"] = "plv4"
    state.replace_text("{ unfinished .set{")
    with pytest.raises(PLv3Error):
        PromptLibraryV3Node().execute("{ valid }", doc=json.dumps(state.doc.to_json()))


def test_prompt_setting_shells_locate_the_actual_owning_block():
    state = EditorState.create("{ first, duplicate, duplicate }")
    block = state.doc.root.children[0]
    item = block.children[2].id
    state = apply_command(state, {"type": "LocateDetails", "id": item, "revision": state.revision})
    state = apply_command(state, {"type": "SetPromptSettings", "id": item,
                                 "patch": {"schedule": [.2, .8]}, "revision": state.revision})
    assert state.selection == {"node_id": item, "block_id": block.id, "prompt_id": item}
    shell = state.doc.root.children[0].children[2]
    assert shell.meta["presentation"] == "prompt"
    state = apply_command(state, {"type": "LocateDetails", "id": shell.id, "revision": state.revision})
    assert state.selection["block_id"] == block.id
    assert state.selection["prompt_id"] == shell.id


def test_weight_then_schedule_and_region_keep_one_prompt_shell_and_original_id():
    state = EditorState.create("{ prompt, tail }")
    item = state.doc.root.children[0].children[0].id
    for patch in ({"weight": 1.45}, {"schedule": [.2, .8]}, {"region": {"kind": "imask", "imask": 0}}):
        state = apply_command(state, {"type": "SetPromptSettings", "id": item,
                                     "patch": patch, "revision": state.revision})
    shell = state.doc.root.children[0].children[0]
    assert shell.form == "brace" and shell.children[0].id == item
    assert shell.meta["presentation"] == "prompt"
    assert "weight: 1.45" in state.text and "schedule:" in state.text and "imask: 0" in state.text
    state.check()
