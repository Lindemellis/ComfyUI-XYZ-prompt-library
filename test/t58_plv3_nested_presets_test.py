# T58 — PLv3 library under pressure: groups that reference groups, subgroups that
# reference their parents' siblings, and presets at every level (spec §5.4, §5.5).
#
# The scenarios here are the ones a real library falls into within a week:
#
#   quality  ─ref─> scores                 (a group referencing another group)
#   illya    ─ref─> accessories            (a group referencing its own SUBGROUP)
#   scene    ─ref─> illya, ─ref─> quality  (two refs, each with its own presets)
#
# and then a preset on each of them, at the same time. The questions a test has to
# answer, because the design's answers are not the obvious ones:
#
#   - a preset is a STRICT snapshot: items added to a group after it was saved load
#     OFF (§5.4), and that has to hold for nested groups too;
#   - a preset saved from a document embeds each nested block's state as a `children`
#     snapshot — so the nested group's OWN presets are irrelevant to it;
#   - "text is the truth" (§5.2), so a round trip expand -> save -> expand must be
#     idempotent all the way down;
#   - a cycle must be refused at write time (§5.5 layer 1) and, if one ever exists,
#     survived at expansion time (layer 2).
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from prompt_library_v3 import library, repo
from prompt_library_v3.compile import compile_text
from prompt_library_v3.db import connect_write, migrate
from prompt_library_v3.diagnostics import E02, PLv3Error
from prompt_library_v3.parser import parse


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


def group(name, folder=None, parent=None, items=()):
    gid = repo.write(repo.CreateGroupOp(name=name, folder_id=folder, parent_group_id=parent))
    for text in items:
        repo.write(repo.AddItemOp(group_id=gid, text=text))
    return gid


def ref(from_gid, to_gid):
    return repo.write(repo.AddItemOp(group_id=from_gid, kind="ref", ref_group_id=to_gid))


def item_id(gid, text):
    return next(int(i["id"]) for i in repo.list_items(gid) if i["text"] == text)


def save_preset(gid, name, text):
    """Save a preset the way the UI does: from the block's TEXT (§5.4)."""
    blocks = library.find_blocks(text)
    body = library.build_preset_body(text, blocks[0])
    pid = repo.write(repo.SavePresetOp(group_id=gid, name=name, body=body))
    return pid, body


@pytest.fixture
def nest(lib):
    """quality -> scores; illya -> illya.accessories; scene -> illya + quality."""
    scores = group("scores", items=["score_9", "score_8_up", "score_7_up"])
    quality = group("quality", items=["masterpiece", "absurdres"])
    ref(quality, scores)

    illya = group("illya", items=["illyasviel von einzbern", "blonde hair", "red eyes"])
    acc = group("accessories", parent=illya, items=["hair ribbon", "hairband"])
    ref(illya, acc)

    scene = group("scene", items=["outdoors"])
    ref(scene, illya)
    ref(scene, quality)

    return {"scores": scores, "quality": quality, "illya": illya, "acc": acc, "scene": scene}


# --- expansion of a nest ----------------------------------------------------


def test_a_ref_to_a_subgroup_expands_with_its_own_full_path(nest):
    text = library.expand(nest["illya"])
    assert "[illya]: {" in text
    # the subgroup keeps its identity — `illya.accessories`, not `accessories`
    assert "[illya.accessories]: {" in text
    assert "hair ribbon," in text


def test_two_levels_of_refs_expand_inline_and_stay_nested(nest):
    text = library.expand(nest["scene"])
    lines = [l.rstrip() for l in text.split("\n")]
    assert lines[0] == "[scene]: {"
    assert any(l.strip() == "[illya]: {" for l in lines)
    assert any(l.strip() == "[illya.accessories]: {" for l in lines)
    assert any(l.strip() == "[quality]: {" for l in lines)
    assert any(l.strip() == "[scores]: {" for l in lines)
    # indentation grows with depth — the block is readable, not a wall
    acc = next(l for l in lines if l.strip() == "[illya.accessories]: {")
    illya = next(l for l in lines if l.strip() == "[illya]: {")
    assert len(acc) - len(acc.lstrip()) > len(illya) - len(illya.lstrip())


def test_a_nest_compiles_to_a_flat_prompt(nest):
    text = library.expand(nest["scene"])
    out = compile_text(text).text
    for tag in ["outdoors", "illyasviel von einzbern", "hair ribbon", "masterpiece", "score_9"]:
        assert tag in out


# --- presets on nested groups -----------------------------------------------


def test_a_preset_on_the_outer_group_snapshots_the_nested_blocks(nest):
    """The preset saved from a document carries what the nested blocks looked like
    THERE — a `children` snapshot — not a pointer to the nested group's own preset."""
    full = library.expand(nest["scene"])
    # trim the nest down in the text: no accessories, no absurdres
    trimmed = "\n".join(
        l for l in full.split("\n")
        if "hair ribbon" not in l and "hairband" not in l and "absurdres" not in l
    )
    _pid, body = save_preset(nest["scene"], "trimmed", trimmed)

    # every ref is in `items` (it has a position among the prompts) and in `children`
    assert len(body["children"]) == 2
    for child in body["children"].values():
        assert child["mode"] == "snapshot"

    out = library.expand(nest["scene"], body=body)
    assert "outdoors" in out
    assert "blonde hair" in out          # kept
    assert "hair ribbon" not in out      # disabled in the nested subgroup's block
    assert "absurdres" not in out        # disabled in the nested quality block
    assert "score_9" in out              # untouched two levels down


def test_the_nested_groups_own_presets_do_not_leak_into_the_outer_one(nest):
    """`illya` has a preset of its own. A preset of `scene` snapshots what the block
    said in the document — it must not silently pick up illya's preset instead."""
    illya_text = library.expand(nest["illya"])
    minimal = "\n".join(l for l in illya_text.split("\n") if "red eyes" not in l)
    save_preset(nest["illya"], "minimal", minimal)

    scene_text = library.expand(nest["scene"])          # the FULL illya block
    _pid, body = save_preset(nest["scene"], "full", scene_text)

    out = library.expand(nest["scene"], body=body)
    assert "red eyes" in out, "scene's preset snapshotted the full block, not illya's preset"

    # and illya's own preset still means what it meant
    assert "red eyes" not in library.expand(
        nest["illya"], preset_id=repo.list_presets(nest["illya"])[0]["id"])


def test_a_child_can_point_at_the_nested_groups_preset_instead_of_a_snapshot(nest):
    """The other mode in §5.4: `children[ref] = {mode: 'preset', preset_id}` follows
    the nested group's preset, so editing that preset changes every document that
    referenced it this way."""
    illya_text = library.expand(nest["illya"])
    minimal = "\n".join(l for l in illya_text.split("\n") if "red eyes" not in l)
    pid, _ = save_preset(nest["illya"], "minimal", minimal)

    ref_item = next(i for i in repo.list_items(nest["scene"])
                    if i["kind"] == "ref" and i["ref_group_id"] == nest["illya"])
    body = {
        "items": [int(i["id"]) for i in repo.list_items(nest["scene"])],
        "settings": {},
        "children": {str(ref_item["id"]): {"mode": "preset", "preset_id": pid}},
    }
    out = library.expand(nest["scene"], body=body)
    assert "blonde hair" in out
    assert "red eyes" not in out, "the child did not follow illya's preset"


def test_a_preset_is_a_strict_snapshot_even_for_items_added_later(nest):
    """§5.4: a preset is a whitelist. Items added to the group afterwards are not in
    it, so they load OFF — a library edit never leaks into a saved preset."""
    _pid, body = save_preset(nest["quality"], "as-is", library.expand(nest["quality"]))
    repo.write(repo.AddItemOp(group_id=nest["quality"], text="very awa"))

    assert "very awa" in library.expand(nest["quality"])            # the group has it
    assert "very awa" not in library.expand(nest["quality"], body=body)  # the preset does not


def test_a_preset_keeps_the_order_the_text_had_refs_included(nest):
    """A ref sits BETWEEN prompts and moving it changes the image, so the whitelist is
    an order over items and refs together (§5.4)."""
    text = (
        "[scene]: {\n"
        "    [quality]: {\n"
        "        masterpiece,\n"
        "    }\n"
        "    outdoors,\n"
        "    [illya]: {\n"
        "        blonde hair,\n"
        "    }\n"
        "}"
    )
    _pid, body = save_preset(nest["scene"], "reordered", text)
    out = library.expand(nest["scene"], body=body)
    assert out.index("[quality]") < out.index("outdoors") < out.index("[illya]")


def test_round_trip_through_text_is_idempotent_all_the_way_down(nest):
    """expand -> save the text as a preset -> expand that preset == the same text.
    If this drifts, every save nudges the document and the user's layout dies."""
    first = library.expand(nest["scene"])
    _pid, body = save_preset(nest["scene"], "rt", first)
    second = library.expand(nest["scene"], body=body)
    assert second == first

    _pid2, body2 = save_preset(nest["scene"], "rt2", second)
    assert library.expand(nest["scene"], body=body2) == first


def test_settings_on_a_nested_block_survive_the_preset(nest):
    text = (
        "[scene]: {\n"
        "    outdoors,\n"
        "    [quality]: {\n"
        "        masterpiece,\n"
        "    }.set{weight: 1.15}\n"
        "}.set{shuffle: true}"
    )
    _pid, body = save_preset(nest["scene"], "weighted", text)
    out = library.expand(nest["scene"], body=body)
    assert "shuffle: true" in out
    assert "weight: 1.15" in out, "the nested block's own settings were dropped"


# --- blur-sync into a nest --------------------------------------------------


def test_blur_sync_appends_to_the_right_group_at_every_depth(nest):
    text = library.expand(nest["scene"])
    text = text.replace("    outdoors,", "    outdoors,\n    night,")
    text = text.replace("        blonde hair,", "        blonde hair,\n        twintails,")
    text = text.replace("            hair ribbon,", "            hair ribbon,\n            bow,")

    report = library.sync_text(text)
    by_path = {b["path"]: b for b in report["blocks"]}
    assert by_path["scene"]["added"] == 1
    assert by_path["illya"]["added"] == 1
    assert by_path["illya.accessories"]["added"] == 1

    assert "night" in [i["text"] for i in repo.list_items(nest["scene"])]
    assert "twintails" in [i["text"] for i in repo.list_items(nest["illya"])]
    assert "bow" in [i["text"] for i in repo.list_items(nest["acc"])]
    # nothing was added to the groups that were not typed into
    assert len(repo.list_items(nest["scores"])) == 3


def test_blur_sync_never_deletes_what_the_text_left_out(nest):
    """§5.2/§5.3: "disabled" is "not in the text". The DB is not told about it."""
    text = library.expand(nest["illya"])
    text = "\n".join(l for l in text.split("\n") if "red eyes" not in l)
    library.sync_text(text)
    assert "red eyes" in [i["text"] for i in repo.list_items(nest["illya"])]


def test_syncing_the_same_text_twice_adds_nothing_the_second_time(nest):
    text = library.expand(nest["scene"]).replace("    outdoors,", "    outdoors,\n    night,")
    library.sync_text(text)
    before = len(repo.list_items(nest["scene"]))
    report = library.sync_text(text)
    assert all(b["added"] == 0 for b in report["blocks"])
    assert len(repo.list_items(nest["scene"])) == before


# --- cycles (spec §5.5) -----------------------------------------------------


def test_a_cycle_is_refused_when_it_is_written(nest):
    # scene -> illya already exists; illya -> scene would close the loop
    with pytest.raises(Exception):
        ref(nest["illya"], nest["scene"])


def test_a_self_reference_is_refused(nest):
    with pytest.raises(Exception):
        ref(nest["quality"], nest["quality"])


def test_an_existing_cycle_cannot_hang_the_expander(lib):
    """Layer 2: even if a loop got into the DB some other way, expansion must stop."""
    a = group("a", items=["x"])
    b = group("b", items=["y"])
    ref(a, b)
    # force the loop past the write-time guard, the way a bad migration could
    conn = connect_write(repo._db_path)  # noqa: SLF001
    try:
        conn.execute(
            "INSERT INTO items(group_id, kind, ref_group_id, sort_index) VALUES (?, 'ref', ?, 99)",
            (b, a),
        )
        conn.commit()
    finally:
        conn.close()

    with pytest.raises(PLv3Error) as exc:
        library.expand(a)
    assert exc.value.diag.code == E02


# --- the whole thing still parses -------------------------------------------


def test_a_deep_nest_parses_and_every_block_is_found(nest):
    text = library.expand(nest["scene"])
    root, diags = parse(text)
    assert not [d for d in diags if d.is_error]
    paths = [b.header for b in library.find_blocks(text)]
    assert paths == ["scene", "illya", "illya.accessories", "quality", "scores"]


# --- the three silent-loss bugs (found by this file, fixed) ------------------


def test_a_pasted_nested_block_enters_the_group_as_a_ref(nest):
    """§5.3: an item written in a block that the group does not have gets appended —
    and a nested `[path]: { … }` block IS an item (a ref). Before this, pasting one in
    left the library none the wiser, and the block then vanished from any preset saved
    off that text: a preset is a whitelist of item ids, and it had no id."""
    # `quality` does not reference `illya` — pasting its block in is the new fact
    text = (
        "[quality]: {\n"
        "    masterpiece,\n"
        "    [illya]: {\n"
        "        blonde hair,\n"
        "    }\n"
        "}"
    )
    report = library.sync_text(text)
    quality = next(b for b in report["blocks"] if b["path"] == "quality")
    assert quality["refs_added"] == 1

    refs = [i for i in repo.list_items(nest["quality"]) if i["kind"] == "ref"]
    assert nest["illya"] in [int(r["ref_group_id"]) for r in refs]

    # and now it survives a preset
    _pid, body = save_preset(nest["quality"], "with-illya", text)
    assert "[illya]" in library.expand(nest["quality"], body=body)


def test_syncing_a_pasted_block_twice_does_not_duplicate_the_ref(nest):
    text = "[quality]: {\n    masterpiece,\n    [illya]: {\n        blonde hair,\n    }\n}"
    library.sync_text(text)
    library.sync_text(text)
    refs = [i for i in repo.list_items(nest["quality"])
            if i["kind"] == "ref" and int(i["ref_group_id"]) == nest["illya"]]
    assert len(refs) == 1


def test_a_ref_that_would_close_a_cycle_is_refused_not_crashed(nest):
    """scene -> illya already exists. Pasting `[scene]` into illya's block would close
    the loop: the library refuses the ref (§5.5 layer 1) and says so, and the text the
    user is typing is left alone."""
    text = "[illya]: {\n    blonde hair,\n    [scene]: {\n        outdoors,\n    }\n}"
    report = library.sync_text(text)
    illya = next(b for b in report["blocks"] if b["path"] == "illya")
    assert illya["refs_added"] == 0
    assert illya.get("ref_errors")
    assert not [i for i in repo.list_items(nest["illya"])
                if i["kind"] == "ref" and int(i["ref_group_id"]) == nest["scene"]]


def test_a_weight_written_in_a_block_is_the_presets_not_the_librarys(nest):
    """The user's call: a weight typed into a block is a preset-local override. The
    library item keeps its default, so re-weighting in one document does not silently
    re-weight the same item in every other document that references the group."""
    text = "[quality]: {\n    (masterpiece:1.3),\n    absurdres,\n}"
    _pid, body = save_preset(nest["quality"], "heavy", text)

    assert body["weights"] == {str(item_id(nest["quality"], "masterpiece")): 1.3}
    assert "(masterpiece:1.3)" in library.expand(nest["quality"], body=body)

    # the library item is untouched, so a plain expansion is unweighted
    assert "(masterpiece" not in library.expand(nest["quality"])
    library.sync_text(text)   # and a blur-sync does not smuggle the weight into the DB
    assert "(masterpiece" not in library.expand(nest["quality"])


def test_a_weight_in_a_nested_block_is_kept_by_the_outer_preset(nest):
    text = (
        "[scene]: {\n"
        "    outdoors,\n"
        "    [quality]: {\n"
        "        (masterpiece:1.25),\n"
        "    }\n"
        "}"
    )
    _pid, body = save_preset(nest["scene"], "nested-weight", text)
    out = library.expand(nest["scene"], body=body)
    assert "(masterpiece:1.25)" in out


def test_weights_round_trip_through_save_and_reload(nest):
    text = "[quality]: {\n    (masterpiece:1.3),\n    absurdres,\n}"
    _pid, body = save_preset(nest["quality"], "heavy", text)
    reloaded = library.expand(nest["quality"], body=body)
    _pid2, body2 = save_preset(nest["quality"], "heavy2", reloaded)
    assert body2["weights"] == body["weights"]
    assert library.expand(nest["quality"], body=body2) == reloaded


# --- no duplicate prompts inside one group (the user's rule) -----------------
#
# Uniqueness is PER GROUP and only over the group's OWN items. The same prompt may
# appear in a subgroup, in a referenced group, and in the parent — those are different
# groups. `UNIQUE(group_id, text)` says exactly that, and these tests hold the rest of
# the system to it.


def test_the_db_refuses_a_duplicate_but_allows_it_in_another_group(nest):
    import sqlite3

    with pytest.raises(sqlite3.IntegrityError):
        repo.write(repo.AddItemOp(group_id=nest["quality"], text="masterpiece"))

    # ... while a subgroup and an unrelated group may both hold the same prompt
    repo.write(repo.AddItemOp(group_id=nest["acc"], text="masterpiece"))
    repo.write(repo.AddItemOp(group_id=nest["scores"], text="masterpiece"))
    assert "masterpiece" in [i["text"] for i in repo.list_items(nest["acc"])]
    assert "masterpiece" in [i["text"] for i in repo.list_items(nest["scores"])]


def test_a_prompt_written_twice_in_a_block_is_not_recorded_twice_in_the_preset(nest):
    """The bug this test exists for: `build_preset_body` recorded one id per OCCURRENCE,
    so a block that said `1girl` three times produced a whitelist of [76, 76, 76]. The
    preset then rendered it three times, and because a preset is re-saved off its own
    expansion, the duplicate bred on every save."""
    text = (
        "[scores]: {\n"
        "    score_9,\n"
        "    1girl,\n"
        "    1girl,\n"
        "    1girl,\n"
        "}"
    )
    library.sync_text(text)                       # one row, not three
    assert [i["text"] for i in repo.list_items(nest["scores"])].count("1girl") == 1

    _pid, body = save_preset(nest["scores"], "dup", text)
    assert len(body["items"]) == len(set(body["items"]))

    out = library.expand(nest["scores"], body=body)
    assert out.count("1girl") == 1


def test_a_preset_that_is_already_corrupted_heals_when_it_is_loaded(nest):
    """Presets saved before the fix hold repeated ids. Loading one must not replay the
    duplicate — otherwise the only way out is to hand-edit the database."""
    one = item_id(nest["quality"], "masterpiece")
    body = {"items": [one, one, one], "settings": {}, "children": {}}
    out = library.expand(nest["quality"], body=body)
    assert out.count("masterpiece") == 1


def test_the_editor_warns_about_a_duplicate_instead_of_rewriting_the_text(nest):
    """W06. The text is the truth (§5.2) — silently deleting a line the user typed is
    worse than the duplicate. So: a squiggle on the repeat, and the text compiles as
    written."""
    src = "[scores]: {\n    score_9,\n    1girl,\n    1girl,\n}"
    res = compile_text(src)
    dups = [d for d in res.diagnostics if d.code == "W06"]
    assert len(dups) == 1
    assert "1girl" in dups[0].message
    assert res.text.count("1girl") == 2, "the user's text is left exactly as written"


def test_the_same_prompt_in_a_nested_block_is_not_a_duplicate(nest):
    """A nested block is a different group. `1girl` in both is two rows in two groups —
    the rule is per group, and the warning must not fire across that line."""
    src = (
        "[quality]: {\n"
        "    1girl,\n"
        "    [scores]: {\n"
        "        1girl,\n"
        "    }\n"
        "}"
    )
    res = compile_text(src)
    assert not [d for d in res.diagnostics if d.code == "W06"]


# --- linked nested presets (§5.4 `children.mode = "preset"`) -----------------
#
# The user's rule: a nested block is either COPIED (a snapshot — it stops following its
# source the moment it is saved) or LINKED (it follows a named preset of the nested
# group, and keeps following it). And editing a linked block edits THAT preset — which
# means the change is shared with everything else that follows it. That is the whole
# point, and it is also the thing a test has to pin down, because it is how a user can
# be surprised.


def linked_preset(nest):
    """`illya` gets a preset `minimal` (no red eyes); `scene` links its illya block."""
    illya_text = library.expand(nest["illya"])
    minimal = "\n".join(l for l in illya_text.split("\n") if "red eyes" not in l)
    pid, _ = save_preset(nest["illya"], "minimal", minimal)
    return pid


def save_with_links(gid, name, text, links, established=None):
    """What the route does: write through the links that already existed, then store."""
    library.sync_text(text)
    block = library.find_blocks(text)[0]
    prev = next((p for p in repo.list_presets(gid) if p["name"] == name), None)
    est = established if established is not None else (library.links_of(prev["body"]) if prev else {})
    library.write_through(text, block, links, established=est)
    body = library.build_preset_body(text, block, links=links)
    return repo.write(repo.SavePresetOp(group_id=gid, name=name, body=body)), body


def link_and_adopt(gid, name, links):
    """Linking ADOPTS the linked preset's contents — the UI rewrites the block's text to
    the preset's expansion at the moment you link it. Anything else would write the old
    contents through and destroy the preset you just chose to follow."""
    prev = next((p for p in repo.list_presets(gid) if p["name"] == name), None)
    text = library.expand(gid, preset_id=int(prev["id"])) if prev else library.expand(gid)
    # adopt: rebuild the text with the links in force
    body = library.build_preset_body(text, library.find_blocks(text)[0], links=links)
    pid = repo.write(repo.SavePresetOp(group_id=gid, name=name, body=body))
    return pid, library.expand(gid, preset_id=pid)


def test_a_linked_child_stores_a_pointer_not_a_snapshot(nest):
    pid = linked_preset(nest)
    text = library.expand(nest["scene"])
    _sid, body = save_with_links(nest["scene"], "linked", text, {"illya": pid})

    child = next(c for c in body["children"].values() if c.get("mode") == "preset")
    assert child["preset_id"] == pid
    assert "items" not in child, "a link must not carry a stale copy of the contents too"


def test_a_linked_child_follows_the_preset_when_it_changes(nest):
    """The difference that justifies the feature: change the nested group's preset, and
    every preset that LINKED it changes too — while a snapshot would not have moved."""
    pid = linked_preset(nest)
    text = library.expand(nest["scene"])
    sid, _ = save_with_links(nest["scene"], "linked", text, {"illya": pid})
    snap, _ = save_preset(nest["scene"], "copied", text)   # the other mode, for contrast

    # illya/minimal loses another item
    illya_now = library.expand(nest["illya"], preset_id=pid)
    trimmed = "\n".join(l for l in illya_now.split("\n") if "blonde hair" not in l)
    save_preset(nest["illya"], "minimal", trimmed)

    followed = library.expand(nest["scene"], preset_id=sid)
    copied = library.expand(nest["scene"], preset_id=snap)
    assert "blonde hair" not in followed, "the link did not follow"
    assert "blonde hair" in copied, "a snapshot must NOT follow"


def test_editing_a_linked_block_edits_the_preset_it_follows(nest):
    """The user's call: in the library, editing a linked block IS editing the preset it
    points at. Saving writes through to it — and the link survives."""
    pid = linked_preset(nest)
    text = library.expand(nest["scene"])
    sid, _ = save_with_links(nest["scene"], "linked", text, {"illya": pid})

    # turn an item off inside the linked block (this is what a switch in the detail
    # page does to the text: the line goes away)
    edited = "\n".join(l for l in library.expand(nest["scene"], preset_id=sid).split("\n")
                       if "blonde hair" not in l)
    _sid2, body = save_with_links(nest["scene"], "linked", edited, {"illya": pid})

    # the LINKED preset took the change...
    assert "blonde hair" not in library.expand(nest["illya"], preset_id=pid)
    # ...the link is still a link...
    child = next(c for c in body["children"].values() if c.get("mode") == "preset")
    assert child["preset_id"] == pid
    # ...and everyone else who follows that preset sees it, which is the shared cost
    assert "blonde hair" not in library.expand(nest["scene"], preset_id=sid)


def test_write_through_leaves_the_outer_preset_alone(nest):
    """The outer preset's own items are its own: writing through to a linked child must
    not smuggle the child's state into the parent, or the link is pointless."""
    pid = linked_preset(nest)
    text = library.expand(nest["scene"])
    sid, body = save_with_links(nest["scene"], "linked", text, {"illya": pid})
    assert "outdoors" in library.expand(nest["scene"], preset_id=sid)

    outer_items = body["items"]
    edited = "\n".join(l for l in library.expand(nest["scene"], preset_id=sid).split("\n")
                       if "red eyes" not in l)
    _sid2, body2 = save_with_links(nest["scene"], "linked", edited, {"illya": pid})
    assert body2["items"] == outer_items


def test_unlinking_freezes_the_current_contents_as_a_snapshot(nest):
    """Unlink = "stop following, keep what is on screen". The block must not revert to
    the group's full contents, and it must stop tracking the preset."""
    pid = linked_preset(nest)
    text = library.expand(nest["scene"])
    sid, _ = save_with_links(nest["scene"], "linked", text, {"illya": pid})

    # unlink: save the same text with no links at all
    frozen = library.expand(nest["scene"], preset_id=sid)
    sid2, body = save_preset(nest["scene"], "linked", frozen)
    assert all(c["mode"] == "snapshot" for c in body["children"].values())
    assert "red eyes" not in library.expand(nest["scene"], preset_id=sid2), "kept what was shown"

    # and it no longer follows illya/minimal
    save_preset(nest["illya"], "minimal", library.expand(nest["illya"]))   # give it everything back
    assert "red eyes" not in library.expand(nest["scene"], preset_id=sid2)


def test_a_dangling_link_does_not_crash_the_expansion(nest):
    """The preset a block follows can be deleted from under it."""
    pid = linked_preset(nest)
    text = library.expand(nest["scene"])
    sid, _ = save_with_links(nest["scene"], "linked", text, {"illya": pid})
    repo.write(repo.DeletePresetOp(preset_id=pid))

    out = library.expand(nest["scene"], preset_id=sid)
    # nothing to follow -> the group's own contents, which is the honest fallback
    assert "illyasviel von einzbern" in out
    assert "red eyes" in out


def test_making_a_link_never_overwrites_the_preset_you_linked_to(nest):
    """The trap: at the moment you link, the block on screen still shows the OLD
    contents. If saving wrote those through, the act of linking would destroy the preset
    you just chose to follow. Linking ADOPTS; only later edits flow back."""
    pid = linked_preset(nest)                       # illya/minimal: no red eyes
    full = library.expand(nest["scene"])            # the block shows illya IN FULL
    save_with_links(nest["scene"], "linked", full, {"illya": pid}, established={})

    assert "red eyes" not in library.expand(nest["illya"], preset_id=pid), \
        "linking wrote the on-screen contents through and clobbered the target preset"


def test_a_link_is_only_written_through_once_it_is_established(nest):
    pid = linked_preset(nest)
    text = library.expand(nest["scene"])
    sid, _ = save_with_links(nest["scene"], "linked", text, {"illya": pid}, established={})

    # now the link exists: an edit inside the block DOES reach the shared preset
    shown = library.expand(nest["scene"], preset_id=sid)
    assert "red eyes" not in shown                  # adopted illya/minimal
    edited = "\n".join(l for l in shown.split("\n") if "hair ribbon" not in l)
    save_with_links(nest["scene"], "linked", edited, {"illya": pid})
    assert "hair ribbon" not in library.expand(nest["illya"], preset_id=pid)
