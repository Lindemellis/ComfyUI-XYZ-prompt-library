"""LLM prompt templates — seeding, switching, the derived tool gate, and user templates.

A template is a named variant set (llm/templates.py). The load-bearing claims tested here:
  - seeding is additive and never changes which variant is active;
  - applying a template switches every managed block's variant AND its enabled flag;
  - krea2 disables `tooldoc`, which is what withholds the danbooru lookup tool;
  - the assembled system prompt actually changes with the template;
  - a user template round-trips the on/off picture it was saved with.
"""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from prompt_library_v2.db import connect_write, migrate
from prompt_library_v2 import repo
import llm.store as store
import llm.settings as settings
import llm.templates as templates
import llm.assembly as assembly
from llm.defaults import TEMPLATES, H3_BLOCKS, KREA2_BLOCKS, MANAGED_KINDS, reflow


def _fresh_repo():
    tmp = tempfile.mkdtemp(prefix="llm_tmpl_")
    db_path = Path(tmp) / "plv2.db"
    c = connect_write(db_path); migrate(c); c.close()
    settings._DATA_DIR = Path(tmp)
    settings._SETTINGS_PATH = Path(tmp) / "llm_settings.json"
    settings._TAGDB_DIR = Path(tmp) / "tagdb_data"
    repo.init(db_path)
    store.seed_defaults_if_needed()
    for tid in TEMPLATES:
        store.seed_template_variants_if_needed(tid)
    return db_path


def _by_kind():
    return {b["kind"]: b for b in repo.get_llm_blocks()}


def test_seeding_is_additive_and_idempotent():
    _fresh_repo()
    try:
        blocks = _by_kind()
        for kind, text in KREA2_BLOCKS.items():
            names = [v["variant_name"] for v in repo.get_block_variants(blocks[kind]["id"])]
            assert "krea2" in names, kind
            assert names.count("krea2") == 1, kind
            # seeding must NOT activate anything — the user (or apply_template) does that
            assert blocks[kind]["variant_name"] == "default", kind
        # tooldoc has no krea2 variant on purpose (the template disables the block)
        assert "krea2" not in [v["variant_name"] for v in repo.get_block_variants(blocks["tooldoc"]["id"])]

        for tid in TEMPLATES:
            store.seed_template_variants_if_needed(tid)
        hdr = _by_kind()["header"]
        names = [v["variant_name"] for v in repo.get_block_variants(hdr["id"])]
        assert names.count("krea2") == 1 and names.count("anima") == 1
        print("ok: template seeding is additive, opt-in and idempotent")
    finally:
        repo.stop()


def test_apply_krea2_switches_variants_enable_and_tool_gate():
    _fresh_repo()
    try:
        assert templates.tool_gate() == {"lookup": True, "web_search": True}

        res = templates.apply_template("krea2")
        assert res["active"] == "krea2"
        assert settings.get_active_template() == "krea2"

        blocks = _by_kind()
        for kind in KREA2_BLOCKS:
            assert blocks[kind]["variant_name"] == "krea2", kind
            assert blocks[kind]["enabled"], kind
        # the danbooru tool doc is off, and that is what withholds the tool
        assert not blocks["tooldoc"]["enabled"]
        assert templates.tool_gate()["lookup"] is False
        assert templates.tool_gate()["web_search"] is True
        assert res["missing"] == []

        # the system prompt really changed
        msgs = assembly.build_messages(None, "", "a cat")
        system = msgs[0]["content"]
        assert "Krea 2" in system
        assert "lookup_danbooru_tags" not in system      # the tool doc block is off
        assert "Organize tags in this order" not in system  # the default task block is gone

        # ...and switching back restores the danbooru template
        templates.apply_template("default")
        blocks = _by_kind()
        for kind in MANAGED_KINDS:
            assert blocks[kind]["variant_name"] == "default", kind
            assert blocks[kind]["enabled"], kind
        assert templates.tool_gate()["lookup"] is True
        assert "lookup_danbooru_tags" in assembly.build_messages(None, "", "a cat")[0]["content"]
        print("ok: krea2 switches variants + disables tooldoc + closes the lookup gate")
    finally:
        repo.stop()


def test_apply_h3_closes_both_tool_gates():
    """H3 is the first template that withholds BOTH tools, so both doc blocks go off.

    It is also the only one whose prompt is a structured multi-field document, so the
    field names the official format mandates must actually reach the system prompt —
    a template that seeds but loses `integrated_multimodal_description` is useless.
    """
    _fresh_repo()
    try:
        res = templates.apply_template("h3")
        assert res["active"] == "h3"
        assert res["missing"] == []

        blocks = _by_kind()
        for kind in H3_BLOCKS:
            assert blocks[kind]["variant_name"] == "h3", kind
            assert blocks[kind]["enabled"], kind
        # neither tool is offered, because neither doc block is on
        assert not blocks["tooldoc"]["enabled"]
        assert not blocks["web_search"]["enabled"]
        assert templates.tool_gate() == {"lookup": False, "web_search": False}

        system = assembly.build_messages(None, "", "a girl on a train")[0]["content"]
        assert "MiniMax H3" in system
        assert "lookup_danbooru_tags" not in system
        assert "web_search(queries" not in system
        # the five modes and every mandated field name survive seeding + reflow
        for token in ("T2VA", "I2VA", "FL2VA", "L2VA", "Ref2VA",
                      "integrated_multimodal_description", "overall_soundscape",
                      "non_diegetic_music", "subject_definitions", "retention_analysis",
                      "detailed_description", "fully_preserved", "fully_copy",
                      "<scenetrans>", "<cutoff>"):
            assert token in system, token

        # switching away restores both tools
        templates.apply_template("default")
        assert templates.tool_gate() == {"lookup": True, "web_search": True}
        print("ok: h3 switches variants, closes BOTH tool gates, keeps its field names")
    finally:
        repo.stop()


def test_apply_anima_leaves_tooldoc_on():
    _fresh_repo()
    try:
        templates.apply_template("anima")
        blocks = _by_kind()
        assert blocks["header"]["variant_name"] == "anima"
        assert blocks["tooldoc"]["enabled"] and blocks["tooldoc"]["variant_name"] == "anima"
        assert templates.tool_gate()["lookup"] is True
        print("ok: anima keeps the danbooru lookup")
    finally:
        repo.stop()


def test_user_template_round_trips_the_on_off_picture():
    _fresh_repo()
    try:
        # a hand-made setup: krea2 texts but with web_search switched off
        templates.apply_template("krea2")
        ws = _by_kind()["web_search"]
        repo.enqueue_write(repo.MID, repo.UpdateLlmBlockOp(block_id=ws["id"], enabled=False)).result(timeout=5)
        assert templates.tool_gate()["web_search"] is False

        templates.save_as_template("mine")
        assert settings.get_active_template() == "mine"
        names = [t["id"] for t in templates.list_templates()["templates"]]
        assert "mine" in names and names[:3] == ["default", "anima", "krea2"]

        # wander off, then come back — both the texts and the on/off picture return
        templates.apply_template("default")
        assert templates.tool_gate() == {"lookup": True, "web_search": True}
        templates.apply_template("mine")
        blocks = _by_kind()
        assert blocks["header"]["variant_name"] == "mine"
        assert "Krea 2" in blocks["header"]["text"]
        assert not blocks["tooldoc"]["enabled"] and not blocks["web_search"]["enabled"]
        assert templates.tool_gate() == {"lookup": False, "web_search": False}

        templates.delete_template("mine")
        assert "mine" not in [t["id"] for t in templates.list_templates()["templates"]]
        assert settings.get_active_template() == "default"
        print("ok: a user template round-trips text + enable state, and deletes cleanly")
    finally:
        repo.stop()


def test_active_template_is_derived_from_the_blocks():
    """An install that predates templates stores active_template='default' while sitting on
    anima variants — the blocks are the truth, so the derivation must win."""
    _fresh_repo()
    try:
        blocks = _by_kind()
        # hand-switch every managed block to its anima variant, WITHOUT apply_template
        for kind in MANAGED_KINDS:
            v = next(v for v in repo.get_block_variants(blocks[kind]["id"])
                     if v["variant_name"] == "anima")
            repo.enqueue_write(repo.MID, repo.SetActiveVariantOp(
                block_id=blocks[kind]["id"], variant_id=v["id"])).result(timeout=5)
        assert settings.get_active_template() == "default"          # the stale stored name
        assert templates.active_template() == {"active": "anima", "mixed": False}

        # one block hand-picked off-template ⇒ mixed, and we don't claim a template
        hdr = _by_kind()["header"]
        v = next(v for v in repo.get_block_variants(hdr["id"]) if v["variant_name"] == "krea2")
        repo.enqueue_write(repo.MID, repo.SetActiveVariantOp(
            block_id=hdr["id"], variant_id=v["id"])).result(timeout=5)
        assert templates.active_template()["mixed"] is True

        # krea2 reads as krea2 even though the tooldoc block it disabled holds another variant
        templates.apply_template("krea2")
        assert _by_kind()["tooldoc"]["variant_name"] != "krea2"      # no krea2 variant exists
        assert templates.active_template() == {"active": "krea2", "mixed": False}
        print("ok: the active template is derived from the enabled blocks, not the stored name")
    finally:
        repo.stop()


def test_preset_sync_refreshes_unedited_variants_only():
    """Bumping a preset's version must rewrite the variants still holding a KNOWN prior
    authored form, and leave anything the user typed alone."""
    _fresh_repo()
    priors = TEMPLATES["krea2"]["prior_hashes"]["task"]
    added = None
    try:
        desired = reflow(TEMPLATES["krea2"]["blocks"]["task"])
        stale, edited = "OLD AUTHORED TEXT", "my own hand-written task block"
        added = store._hash16(stale)
        priors.add(added)                       # pretend `stale` was a shipped form

        task = _by_kind()["task"]
        v_stale = next(v for v in repo.get_block_variants(task["id"]) if v["variant_name"] == "krea2")
        repo.enqueue_write(repo.MID, repo.UpsertLlmVariantOp(
            block_id=task["id"], text=stale, variant_name="krea2",
            variant_id=v_stale["id"])).result(timeout=5)
        # a second block the user edited by hand — same template, must survive untouched
        fmt = _by_kind()["format"]
        v_edit = next(v for v in repo.get_block_variants(fmt["id"]) if v["variant_name"] == "krea2")
        repo.enqueue_write(repo.MID, repo.UpsertLlmVariantOp(
            block_id=fmt["id"], text=edited, variant_name="krea2",
            variant_id=v_edit["id"])).result(timeout=5)

        assert settings.get_preset_version("krea2") == 0
        store.sync_template_if_outdated("krea2")

        texts = {v["id"]: v["text"] for v in repo.get_block_variants(task["id"])}
        assert texts[v_stale["id"]] == desired          # recognised → refreshed
        assert next(v["text"] for v in repo.get_block_variants(fmt["id"])
                    if v["id"] == v_edit["id"]) == edited   # unknown → left alone
        assert settings.get_preset_version("krea2") == TEMPLATES["krea2"]["version"]

        # idempotent: a second pass is a no-op even if the text drifts again
        store.sync_template_if_outdated("krea2")
        print("ok: a version bump refreshes only the variants still on a known authored form")
    finally:
        if added:
            priors.discard(added)
        repo.stop()


def test_builtin_template_cannot_be_overwritten_or_deleted():
    _fresh_repo()
    try:
        for bad in ("save", "delete"):
            try:
                (templates.save_as_template if bad == "save" else templates.delete_template)("krea2")
                raise AssertionError(f"{bad} on a built-in should have raised")
            except ValueError:
                pass
        try:
            templates.apply_template("nope")
            raise AssertionError("unknown template should have raised")
        except ValueError:
            pass
        print("ok: built-ins are read-only, unknown ids rejected")
    finally:
        repo.stop()


if __name__ == "__main__":
    test_seeding_is_additive_and_idempotent()
    test_apply_krea2_switches_variants_enable_and_tool_gate()
    test_apply_anima_leaves_tooldoc_on()
    test_user_template_round_trips_the_on_off_picture()
    test_active_template_is_derived_from_the_blocks()
    test_preset_sync_refreshes_unedited_variants_only()
    test_builtin_template_cannot_be_overwritten_or_deleted()
