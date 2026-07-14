# T56 — PLv2 -> PLv3 migration (spec §9), against a synthetic v2 database.
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from prompt_library_v3 import library, migrate_v2, repo
from prompt_library_v3.compile import compile_text

V2_SCHEMA = """
CREATE TABLE nodes (
    id INTEGER PRIMARY KEY, parent_id INTEGER, name TEXT, full_path TEXT,
    has_template INTEGER DEFAULT 0, has_prompts INTEGER DEFAULT 0,
    pos_neg TEXT DEFAULT 'positive', shuffle INTEGER DEFAULT 0,
    random_mode TEXT DEFAULT 'none', select_min INTEGER DEFAULT 1,
    select_max INTEGER DEFAULT 1, dropout_rate REAL DEFAULT 0.0,
    format TEXT DEFAULT '', delimiter TEXT DEFAULT ', ', order_index INTEGER DEFAULT 0,
    raw_text TEXT DEFAULT ''
);
CREATE TABLE prompts (
    id INTEGER PRIMARY KEY, node_id INTEGER, content TEXT, weight REAL DEFAULT 1.0,
    enabled INTEGER DEFAULT 1, order_index INTEGER DEFAULT 0, sep_after INTEGER DEFAULT 0
);
CREATE TABLE triggers (id INTEGER PRIMARY KEY, node_id INTEGER, trigger_text TEXT);
"""


def build_v2(path: Path) -> None:
    """A v2 library with everything the migration has to handle."""
    conn = sqlite3.connect(path)
    conn.executescript(V2_SCHEMA)
    node = lambda i, p, name, full, **kw: conn.execute(  # noqa: E731
        "INSERT INTO nodes(id, parent_id, name, full_path, has_prompts, pos_neg, shuffle, "
        "random_mode, select_min, select_max, dropout_rate, format) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (i, p, name, full, kw.get("prompts", 0), kw.get("pos_neg", "positive"),
         kw.get("shuffle", 0), kw.get("mode", "none"), kw.get("lo", 1), kw.get("hi", 1),
         kw.get("dropout", 0.0), kw.get("format", "")),
    )
    prompt = lambda i, n, c, **kw: conn.execute(  # noqa: E731
        "INSERT INTO prompts(id, node_id, content, weight, enabled, order_index) "
        "VALUES (?,?,?,?,?,?)",
        (i, n, c, kw.get("weight", 1.0), kw.get("enabled", 1), kw.get("order", 0)),
    )

    node(1, None, "quality", "quality")                                   # folder
    node(2, 1, "anima", "quality.anima", prompts=1, shuffle=1,
         mode="select", lo=2, hi=4, format="@{prompt}")                   # entry
    node(3, 2, "scores", "quality.anima.scores", prompts=1)               # sub-entry
    node(4, None, "characters", "characters")                             # folder
    node(5, 4, "illya", "characters.illya", prompts=1)                    # entry
    node(6, None, "neg", "neg", prompts=1, pos_neg="negative")            # negative entry
    node(7, 4, "_template", "characters._template", prompts=1)            # template
    node(8, 4, "miyu", "characters.miyu", prompts=1, mode="dropout", dropout=0.3)

    prompt(1, 2, "masterpiece", order=0)
    prompt(2, 2, "[quality.anima.scores]", order=1)   # ref by full path
    prompt(12, 2, "switched off", enabled=0, order=2)  # a DISABLED prompt
    prompt(3, 3, "score_9", order=0)
    prompt(13, 3, "score_8_up", enabled=0, order=1)    # disabled inside the sub-entry
    prompt(4, 5, "illya", order=0)
    prompt(5, 5, "blonde hair", weight=1.3, order=1)
    prompt(6, 5, "{smile|grin|laugh}", order=2)       # choice pattern
    prompt(7, 5, "[anima_trigger]", enabled=0, order=3)  # a DISABLED ref
    prompt(8, 6, "worst quality", order=0)
    prompt(9, 7, "best quality", order=0)             # the template's prompt
    prompt(10, 8, "miyu", order=0)
    prompt(11, 8, "[nowhere.missing]", order=1)       # unresolvable

    conn.execute("INSERT INTO triggers(node_id, trigger_text) VALUES (2, 'anima_trigger')")
    conn.commit()
    conn.close()


@pytest.fixture
def migrated(tmp_path):
    v2 = tmp_path / "plv2.db"
    v3 = tmp_path / "plv3.db"
    build_v2(v2)
    report = migrate_v2.migrate(v2, v3)
    yield report
    repo.shutdown()


def path_of(name):
    return next(g for g in repo.list_groups() if g["name"] == name)


def texts(group_name):
    g = path_of(group_name)
    return [i["text"] for i in repo.list_items(int(g["id"])) if i["kind"] != "ref"]


# --- structure --------------------------------------------------------------


def test_folders_become_folders_and_entries_become_groups(migrated):
    assert {f["name"] for f in repo.list_folders()} == {"quality", "characters"}
    assert {g["name"] for g in repo.list_groups()} == {
        "anima", "scores", "illya", "neg", "_template", "miyu",
    }


def test_a_sub_entry_becomes_a_true_subgroup(migrated):
    scores = path_of("scores")
    anima = path_of("anima")
    assert scores["parent_group_id"] == anima["id"]
    assert repo.group_path(int(scores["id"])) == "quality.anima.scores"


def test_a_negative_entry_keeps_its_polarity(migrated):
    assert path_of("neg")["polarity"] == "negative"


# --- settings ---------------------------------------------------------------


def test_node_knobs_become_the_groups_settings(migrated):
    anima = path_of("anima")
    assert anima["settings"] == {
        "shuffle": True,
        "random_select": [2, 4],
        "format": "@$p",  # spec §9: {prompt} -> $p
    }


def test_dropout_mode_migrates(migrated):
    assert path_of("miyu")["settings"] == {"dropout": 0.3}


# --- items ------------------------------------------------------------------


def test_prompts_become_items_with_their_weight(migrated):
    illya = path_of("illya")
    rows = {i["text"]: i for i in repo.list_items(int(illya["id"]))}
    assert rows["blonde hair"]["weight"] == 1.3
    assert rows["illya"]["weight"] is None  # weight 1 is not stored


def test_a_choice_pattern_becomes_a_random_select_group(migrated):
    # spec §9: {a|b} -> {a, b}.set{random_select: 1}
    assert "{smile, grin, laugh}.set{random_select: 1}" in texts("illya")


def test_the_migrated_choice_still_compiles_to_one_option(migrated):
    text = library.expand(int(path_of("illya")["id"]))
    out = compile_text(text, seed=3).text
    picked = [o for o in ("smile", "grin", "laugh") if o in out]
    assert len(picked) == 1


# --- refs -------------------------------------------------------------------


def test_a_full_path_ref_becomes_a_ref_item(migrated):
    anima = path_of("anima")
    refs = [i for i in repo.list_items(int(anima["id"])) if i["kind"] == "ref"]
    assert [repo.group_path(int(r["ref_group_id"])) for r in refs] == ["quality.anima.scores"]


def test_a_ref_written_with_a_trigger_name_still_resolves(migrated):
    # v3 drops trigger words, but a v2 ref may be *written* with one, so the
    # migration reads the trigger table to rewrite it as a full path
    illya = path_of("illya")
    refs = [i for i in repo.list_items(int(illya["id"])) if i["kind"] == "ref"]
    paths = [repo.group_path(int(r["ref_group_id"])) for r in refs]
    assert "quality.anima" in paths


def test_an_unresolvable_ref_is_reported_and_kept_as_text(migrated):
    assert any("nowhere.missing" in u for u in migrated.unresolved_refs)
    assert "[nowhere.missing]" in texts("miyu")  # not silently dropped


# --- templates --------------------------------------------------------------


def test_a_template_becomes_an_ordinary_group_that_inheritors_reference(migrated):
    # spec §9 / decision 28
    tpl = path_of("_template")
    assert texts("_template") == ["best quality"]

    for name in ("illya", "miyu"):
        refs = [i for i in repo.list_items(int(path_of(name)["id"])) if i["kind"] == "ref"]
        assert tpl["id"] in [r["ref_group_id"] for r in refs], name
    assert migrated.template_refs == 2


def test_a_negative_entry_does_not_inherit_the_template(migrated):
    # v2's rule: negative entries never inherited
    refs = [i for i in repo.list_items(int(path_of("neg")["id"])) if i["kind"] == "ref"]
    assert refs == []


def test_the_whole_thing_expands_and_compiles(migrated):
    text = library.expand(int(path_of("illya")["id"]))
    result = compile_text(text)
    assert "illya" in result.text
    assert "best quality" in result.text  # via the migrated template ref
    assert not [d for d in result.diagnostics if d.is_error]


# --- dry run ----------------------------------------------------------------


def test_dry_run_writes_nothing(tmp_path):
    v2 = tmp_path / "plv2.db"
    v3 = tmp_path / "plv3.db"
    build_v2(v2)
    report = migrate_v2.migrate(v2, v3, dry_run=True)
    assert report.groups == 6 and report.folders == 2
    assert not v3.exists()


# --- v2's on/off state -> presets (§5.2 / §5.4) -------------------------------
#
# v3's library has no `enabled` column: an item is on iff it appears in the text. So
# the only place v2's flags can live is a preset, which IS a whitelist plus an order.


def preset_of(group_name: str) -> dict:
    g = path_of(group_name)
    ps = [p for p in repo.list_presets(int(g["id"])) if p["name"] == migrate_v2.PRESET_NAME]
    assert ps, f"{group_name} has no '{migrate_v2.PRESET_NAME}' preset"
    return ps[0]


def item_texts(group_name: str, ids: list[int]) -> list[str]:
    g = path_of(group_name)
    by_id = {int(i["id"]): i for i in repo.list_items(int(g["id"]))}
    return [by_id[i]["text"] if by_id[i]["kind"] != "ref" else "<ref>" for i in ids]


def test_every_group_gets_an_imported_preset(migrated):
    groups = repo.list_groups()
    assert migrated.presets == len(groups)
    for g in groups:
        names = [p["name"] for p in repo.list_presets(int(g["id"]))]
        assert migrate_v2.PRESET_NAME in names


def test_the_preset_leaves_out_what_v2_had_switched_off(migrated):
    body = preset_of("anima")["body"]
    assert "switched off" not in item_texts("anima", body["items"])
    assert "masterpiece" in item_texts("anima", body["items"])


def test_the_item_itself_still_exists_in_the_library(migrated):
    # A disabled prompt is not deleted — it is simply not in the whitelist, so you can
    # switch it back on from the detail page.
    assert "switched off" in texts("anima")


def test_a_disabled_ref_is_left_out_too(migrated):
    body = preset_of("illya")["body"]
    items = repo.list_items(int(path_of("illya")["id"]))
    anima_gid = int(path_of("anima")["id"])

    # `illya` has TWO refs: the disabled `[anima_trigger]`, and the `_template` ref the
    # migration adds — a v2 template ALWAYS applied, so that one stays on.
    to_anima = next(i for i in items if i["kind"] == "ref" and i["ref_group_id"] == anima_gid)
    to_template = next(
        i for i in items
        if i["kind"] == "ref" and int(i["ref_group_id"]) == int(path_of("_template")["id"])
    )

    assert int(to_anima["id"]) not in body["items"]      # v2 had it switched off
    assert int(to_template["id"]) in body["items"]       # inheritance was never optional


def test_the_preset_keeps_v2s_order(migrated):
    body = preset_of("illya")["body"]
    kept = [t for t in item_texts("illya", body["items"]) if t != "<ref>"]
    assert kept[:2] == ["illya", "blonde hair"]


def test_disabled_is_counted(migrated):
    # 'switched off', 'score_8_up' and the disabled ref.
    assert migrated.disabled == 3


def test_a_ref_LINKS_to_the_targets_own_preset(migrated):
    # The trap: a ref with no `children` entry expands the target with ALL its items,
    # which would switch back on everything the child had switched off.
    body = preset_of("anima")["body"]
    ref = next(
        i for i in repo.list_items(int(path_of("anima")["id"])) if i["kind"] == "ref"
    )
    child = body["children"][str(int(ref["id"]))]
    assert child["mode"] == "preset"
    assert child["preset_id"] == int(preset_of("scores")["id"])


def test_expanding_the_preset_honours_the_child_groups_own_off_state(migrated):
    # The whole point, end to end: `score_8_up` is off inside `scores`, and expanding
    # the PARENT's preset must not bring it back.
    text = library.expand(
        int(path_of("anima")["id"]), preset_id=int(preset_of("anima")["id"])
    )
    assert "masterpiece" in text
    assert "score_9" in text
    assert "switched off" not in text
    assert "score_8_up" not in text


def test_expanding_WITHOUT_the_preset_shows_everything(migrated):
    # No preset = the whole group. The disabled items are still there to switch on.
    text = library.expand(int(path_of("anima")["id"]))
    assert "switched off" in text
    assert "score_8_up" in text
