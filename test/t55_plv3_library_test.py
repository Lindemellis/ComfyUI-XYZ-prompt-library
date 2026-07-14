# T55 — PLv3 library (spec §5): expansion, blur-sync, presets, cycle guards.
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from prompt_library_v3 import library, repo
from prompt_library_v3.compile import compile_text
from prompt_library_v3.db import connect_write, migrate
from prompt_library_v3.diagnostics import E02, PLv3Error


@pytest.fixture
def lib(tmp_path):
    db = tmp_path / "plv3.db"
    conn = connect_write(db)
    try:
        migrate(conn)
    finally:
        conn.close()
    repo.init(db)
    yield repo
    repo.shutdown()


def make_group(name, folder=None, parent=None, items=()):
    gid = repo.write(repo.CreateGroupOp(name=name, folder_id=folder, parent_group_id=parent))
    for text in items:
        repo.write(repo.AddItemOp(group_id=gid, text=text))
    return gid


# --- paths ------------------------------------------------------------------


def test_path_is_folders_then_group_then_subgroups(lib):
    chars = repo.write(repo.CreateFolderOp(name="characters"))
    fate = repo.write(repo.CreateFolderOp(name="fate", parent_id=chars))
    illya = make_group("illya", folder=fate)
    outfit = make_group("outfit", parent=illya)

    assert repo.group_path(illya) == "characters.fate.illya"
    assert repo.group_path(outfit) == "characters.fate.illya.outfit"
    assert repo.find_by_path("characters.fate.illya.outfit") == outfit
    assert repo.find_by_path("characters.fate.nobody") is None


# --- expansion (library -> text) --------------------------------------------


def test_expand_renders_a_block_with_the_identity_header(lib):
    folder = repo.write(repo.CreateFolderOp(name="characters"))
    gid = make_group("illya", folder=folder, items=["illya", "blonde hair"])
    repo.write(repo.UpdateGroupOp(group_id=gid, settings={"weight": 1.1}))

    assert library.expand(gid) == (
        "[characters.illya]: {\n"
        "    illya,\n"
        "    blonde hair,\n"
        "}.set{weight: 1.1}"
    )


def test_an_items_weight_lives_in_the_row_and_renders_as_parens(lib):
    gid = make_group("g", items=["illya"])
    item = repo.list_items(gid)[0]
    repo.write(repo.UpdateItemOp(item_id=int(item["id"]), weight=1.3))
    assert "(illya:1.3)," in library.expand(gid)


def test_a_ref_expands_inline_and_keeps_its_own_header(lib):
    # spec §3.6: nested library groups are laid out inline but stay identifiable
    inner = make_group("illya", items=["illya", "blonde hair"])
    outer = make_group("duo", items=["2girls"])
    repo.write(repo.AddItemOp(group_id=outer, kind="ref", ref_group_id=inner))

    assert library.expand(outer) == (
        "[duo]: {\n"
        "    2girls,\n"
        "    [illya]: {\n"
        "        illya,\n"
        "        blonde hair,\n"
        "    }\n"
        "}"
    )


def test_an_expanded_block_compiles_without_the_library(lib):
    # spec §4.7: the block carries everything; compilation never reads the DB
    inner = make_group("illya", items=["illya"])
    outer = make_group("duo", items=["2girls"])
    repo.write(repo.AddItemOp(group_id=outer, kind="ref", ref_group_id=inner))
    repo.write(repo.UpdateGroupOp(group_id=outer, settings={"weight": 1.2}))

    text = library.expand(outer)
    assert compile_text("masterpiece, " + text).text == "masterpiece, (2girls, illya:1.2)"


def test_settings_round_trip_through_expansion(lib):
    gid = make_group("g", items=["a"])
    repo.write(repo.UpdateGroupOp(group_id=gid, settings={
        "shuffle": True,
        "random_select": [1, 2],
        "dropout": 0.25,
        "schedule": [0.2, 0.5],
        "region": {"kind": "imask", "imask": 1, "feather": 10, "include_in_base": True},
        "format": "masterpiece $p",
    }))
    text = library.expand(gid)
    root = compile_text(text).ast.children[0]
    s = root.settings
    assert s.shuffle is True
    assert s.random_select == (1, 2)
    assert s.dropout == 0.25
    assert s.schedule == (0.2, 0.5)
    assert s.region.kind == "imask" and s.region.imask == 1 and s.region.feather == 10
    assert s.region.include_in_base is True
    assert s.format == "masterpiece $p"


# --- blur-sync (text -> library) --------------------------------------------


def test_items_written_into_a_block_are_appended_to_the_group(lib):
    gid = make_group("illya", items=["illya"])
    src = "[illya]: {\n    illya,\n    blonde hair,\n    blue eyes,\n}"

    report = library.sync_text(src)
    assert report["blocks"][0]["added"] == 2
    assert [i["text"] for i in repo.list_items(gid)] == ["illya", "blonde hair", "blue eyes"]


def test_removing_an_item_from_the_text_does_not_delete_it(lib):
    # spec §5.2: deleting in the editor only means "disabled", i.e. "not in the text"
    gid = make_group("illya", items=["illya", "blonde hair"])
    library.sync_text("[illya]: {\n    illya,\n}")
    assert [i["text"] for i in repo.list_items(gid)] == ["illya", "blonde hair"]


def test_rewriting_an_item_adds_the_new_one_and_leaves_the_old(lib):
    # spec §5.3: "edit an item" nets out as "a new item, and the old one disabled",
    # with no dialog interrupting the user
    gid = make_group("illya", items=["blonde hair"])
    library.sync_text("[illya]: {\n    blonde hairs,\n}")
    assert sorted(i["text"] for i in repo.list_items(gid)) == ["blonde hair", "blonde hairs"]


def test_a_weighted_item_syncs_as_the_bare_tag(lib):
    # the weight belongs to the row, or UNIQUE(group_id, text) could not find the
    # item again after a re-weight
    gid = make_group("illya", items=[])
    library.sync_text("[illya]: {\n    (illya:1.3),\n}")
    assert [i["text"] for i in repo.list_items(gid)] == ["illya"]


def test_duplicate_texts_in_one_block_collapse_to_one_row(lib):
    gid = make_group("g", items=[])
    library.sync_text("[g]: {\n    a,\n    a,\n}")
    assert [i["text"] for i in repo.list_items(gid)] == ["a"]


def test_an_unknown_path_is_reported_but_not_an_error(lib):
    # W09: the block still compiles, it just has no library behind it
    report = library.sync_text("[nope.missing]: {\n    a,\n}")
    assert report["blocks"] == [{"path": "nope.missing", "found": False, "added": 0}]


def test_a_nested_block_syncs_against_its_own_group(lib):
    inner = make_group("illya", items=[])
    outer = make_group("duo", items=[])
    src = "[duo]: {\n    2girls,\n    [illya]: {\n        illya,\n    }\n}"

    library.sync_text(src)
    # each block's prompts land in ITS OWN group...
    assert [i["text"] for i in repo.list_items(outer) if i["kind"] != "ref"] == ["2girls"]
    assert [i["text"] for i in repo.list_items(inner)] == ["illya"]
    # ...and the nested block itself becomes a ref item of the outer group (§5.3: it is
    # an item the group did not have). Without this it would have no item id, and any
    # preset saved off this text would silently drop the whole block.
    refs = [i for i in repo.list_items(outer) if i["kind"] == "ref"]
    assert [int(r["ref_group_id"]) for r in refs] == [inner]


# --- presets ----------------------------------------------------------------


def test_a_preset_is_a_whitelist_and_an_order(lib):
    gid = make_group("g", items=["a", "b", "c"])
    src = "[g]: {\n    c,\n    a,\n}"
    block = library.find_blocks(src)[0]
    body = library.build_preset_body(src, block)

    rows = {i["text"]: int(i["id"]) for i in repo.list_items(gid)}
    assert body["items"] == [rows["c"], rows["a"]]  # order preserved, b left out

    pid = repo.write(repo.SavePresetOp(group_id=gid, name="short", body=body))
    assert library.expand(gid, preset_id=pid) == "[g]: {\n    c,\n    a,\n}"


def test_a_preset_does_not_pick_up_items_added_to_the_group_later(lib):
    # spec §5.4: a preset is a strict snapshot; library edits never leak into it
    gid = make_group("g", items=["a", "b"])
    src = "[g]: {\n    a,\n    b,\n}"
    body = library.build_preset_body(src, library.find_blocks(src)[0])
    pid = repo.write(repo.SavePresetOp(group_id=gid, name="p", body=body))

    repo.write(repo.AddItemOp(group_id=gid, text="c"))
    assert "c," not in library.expand(gid, preset_id=pid)
    assert "c," in library.expand(gid)  # but the group itself has it


def test_a_preset_records_the_group_settings(lib):
    gid = make_group("g", items=["a"])
    src = "[g]: {\n    a,\n}.set{weight: 1.4, shuffle: true}"
    body = library.build_preset_body(src, library.find_blocks(src)[0])
    pid = repo.write(repo.SavePresetOp(group_id=gid, name="p", body=body))
    assert library.expand(gid, preset_id=pid).endswith(".set{weight: 1.4, shuffle: true}")


def test_a_preset_snapshots_nested_blocks_too(lib):
    inner = make_group("illya", items=["illya", "blonde hair"])
    outer = make_group("duo", items=["2girls"])
    repo.write(repo.AddItemOp(group_id=outer, kind="ref", ref_group_id=inner))

    src = "[duo]: {\n    2girls,\n    [illya]: {\n        illya,\n    }\n}"
    body = library.build_preset_body(src, library.find_blocks(src)[0])
    pid = repo.write(repo.SavePresetOp(group_id=outer, name="p", body=body))

    out = library.expand(outer, preset_id=pid)
    assert "illya," in out
    assert "blonde hair" not in out  # the nested snapshot left it out


def test_a_child_can_point_at_a_named_preset_of_the_referenced_group(lib):
    # spec §5.4's second mode: B's preset changes -> A's preset follows, which the
    # embedded-snapshot mode deliberately does not do
    inner = make_group("illya", items=["illya", "blonde hair"])
    outer = make_group("duo", items=["2girls"])
    ref_id = repo.write(repo.AddItemOp(group_id=outer, kind="ref", ref_group_id=inner))

    inner_rows = {i["text"]: int(i["id"]) for i in repo.list_items(inner)}
    inner_preset = repo.write(repo.SavePresetOp(
        group_id=inner, name="bare", body={"items": [inner_rows["illya"]], "settings": {}, "children": {}},
    ))
    outer_preset = repo.write(repo.SavePresetOp(
        group_id=outer, name="p",
        body={
            "items": [int(repo.list_items(outer)[0]["id"]), ref_id],
            "settings": {},
            "children": {str(ref_id): {"mode": "preset", "preset_id": inner_preset}},
        },
    ))

    out = library.expand(outer, preset_id=outer_preset)
    assert "illya," in out and "blonde hair" not in out

    # change B's preset -> A follows
    repo.write(repo.SavePresetOp(
        group_id=inner, name="bare",
        body={"items": [inner_rows["blonde hair"]], "settings": {}, "children": {}},
    ))
    assert "blonde hair," in library.expand(outer, preset_id=outer_preset)


# --- cycles (spec §5.5) -----------------------------------------------------


def test_the_library_refuses_a_self_reference(lib):
    gid = make_group("a", items=[])
    with pytest.raises(repo.CycleError):
        repo.write(repo.AddItemOp(group_id=gid, kind="ref", ref_group_id=gid))


def test_the_library_refuses_to_close_a_loop(lib):
    a = make_group("a", items=[])
    b = make_group("b", items=[])
    c = make_group("c", items=[])
    repo.write(repo.AddItemOp(group_id=a, kind="ref", ref_group_id=b))
    repo.write(repo.AddItemOp(group_id=b, kind="ref", ref_group_id=c))

    with pytest.raises(repo.CycleError):
        repo.write(repo.AddItemOp(group_id=c, kind="ref", ref_group_id=a))

    # ...and the legal, non-circular ref still goes through
    d = make_group("d", items=[])
    repo.write(repo.AddItemOp(group_id=c, kind="ref", ref_group_id=d))


def test_expansion_has_its_own_guard_and_cannot_hang(lib, monkeypatch):
    # Layer 2: even if a loop somehow existed, expanding must stop, not spin.
    a = make_group("a", items=[])
    b = make_group("b", items=[])
    repo.write(repo.AddItemOp(group_id=a, kind="ref", ref_group_id=b))
    # Forge the loop behind the write op's back.
    monkeypatch.setattr(repo, "_assert_no_cycle", lambda *args: None)
    repo.write(repo.AddItemOp(group_id=b, kind="ref", ref_group_id=a))

    with pytest.raises(PLv3Error) as exc:
        library.expand(a)
    assert exc.value.diag.code == E02
