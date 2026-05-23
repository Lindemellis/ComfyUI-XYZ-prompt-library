"""
PLv2 完整测试数据种子脚本
==========================
覆盖所有功能：folder/entry层级、auto trigger、custom trigger、
positive/negative、delimiter、format、random modes、prompt weight、
跨entry引用([ref])、_neg sub-entry、_template继承、sub-folder模板继承+override、shuffle

用法（ComfyUI-XYZNodes 根目录下）：
    python test/seed_plv2_testdata.py          # 追加模式（不删旧数据）
    python test/seed_plv2_testdata.py --clean  # 清空重建
"""

from __future__ import annotations

import sys
import io
from pathlib import Path
from typing import Optional

# Force UTF-8 output on Windows
if sys.platform == "win32":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")

ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(ROOT))

from prompt_library_v2.db import connect_write, migrate
from prompt_library_v2 import repo
from prompt_library_v2.repo import (
    CreateNodeOp, UpdateNodeOp, UpsertPromptOp, UpsertTriggerOp,
    DeleteNodeOp, HIGH,
)
from prompt_library_v2.trigger import rebuild_auto_triggers

DATA_DIR = ROOT / "prompt_library_v2_data"
DB_PATH  = DATA_DIR / "plv2.db"

# ══════════════════════════════════════════════════════════════════════════════
# Helpers
# ══════════════════════════════════════════════════════════════════════════════

def _create(parent_id: Optional[int], name: str, has_prompts: bool = True,
            pos_neg: str = "positive", **kw) -> int:
    """Create a node via WriteQueue. full_path is auto-computed."""
    parent = repo.get_node(parent_id) if parent_id is not None else None
    full_path = (parent["full_path"] + "." + name) if parent else name
    op = CreateNodeOp(parent_id=parent_id, name=name, full_path=full_path,
                      has_prompts=has_prompts, pos_neg=pos_neg, **kw)
    return repo.enqueue_write(HIGH, op).result(10)


def _update(nid: int, **kw) -> None:
    repo.enqueue_write(HIGH, UpdateNodeOp(node_id=nid, **kw)).result(10)


def _prompts(nid: int, items: list) -> None:
    """Add prompts with auto order_index. Skips if node already has prompts."""
    if repo.get_prompts(nid):
        return
    for i, item in enumerate(items):
        content, weight = (item, 1.0) if isinstance(item, str) else (item[0], item[1])
        repo.enqueue_write(HIGH, UpsertPromptOp(
            node_id=nid, content=content, weight=weight,
            enabled=True, order_index=i, source="custom",
        )).result(10)


def _trigger(nid: int, text: str) -> None:
    """Add custom trigger. Ignore if already exists."""
    existing = {t["trigger_text"] for t in repo.get_triggers(nid)}
    if text in existing:
        return
    try:
        repo.enqueue_write(HIGH, UpsertTriggerOp(
            node_id=nid, trigger_text=text, is_auto=False,
        )).result(10)
    except ValueError:
        pass  # trigger_text taken by other node


def _delete_all() -> None:
    for n in repo.get_tree():
        if n["parent_id"] is None:
            try:
                repo.enqueue_write(HIGH, DeleteNodeOp(node_id=n["id"])).result(10)
            except Exception:
                pass


# ══════════════════════════════════════════════════════════════════════════════
# Seed data
# ══════════════════════════════════════════════════════════════════════════════

def seed():
    # ─── quality (folder) ────────────────────────────────────────────────────
    Q = _create(None, "quality", has_prompts=False)

    qp = _create(Q, "positive", pos_neg="positive")
    _prompts(qp, ["masterpiece", "best quality", "high resolution", "absurdres", "intricate detail"])
    _trigger(qp, "qp")

    qn = _create(Q, "negative", pos_neg="negative")
    _prompts(qn, [("worst quality", 1.4), ("low quality", 1.4), "bad anatomy", "watermark", "signature"])
    _trigger(qn, "qn")

    # ─── artist (folder) ─────────────────────────────────────────────────────
    A = _create(None, "artist", has_prompts=False)

    ac = _create(A, "compilation")
    _prompts(ac, ["artist_a", "artist_b", "artist_c", "artist_d", "artist_e", "artist_f"])
    _update(ac, shuffle=True, random_mode="select", select_min=2, select_max=4)
    _trigger(ac, "artists")
    _trigger(ac, "art")

    # ─── background (folder) ─────────────────────────────────────────────────
    B = _create(None, "background", has_prompts=False)

    bl = _create(B, "living_room")
    _prompts(bl, ["living room", "modern living room", "cozy living room"])
    _update(bl, format="art by {p}")

    bb = _create(B, "bedroom")
    _prompts(bb, ["bedroom", "modern bedroom", "messy bedroom"])
    _update(bb, format="{p}", delimiter=". ")

    # ─── pose (folder) ───────────────────────────────────────────────────────
    P = _create(None, "pose", has_prompts=False)

    ps = _create(P, "sitting")
    _prompts(ps, ["sitting", ("sitting on chair", 1.2), "cross-legged", "sitting on sofa"])
    _update(ps, random_mode="dropout", dropout_rate=0.3)

    pc = _create(P, "cowboy_shot")
    _prompts(pc, ["cowboy shot", ("from below", 1.1)])
    _update(pc, delimiter=".")

    pst = _create(P, "standing")
    _prompts(pst, ["standing", "full body"])

    # ─── character (folder, nested templates!) ───────────────────────────────
    C = _create(None, "character", has_prompts=False)

    # character._template ──────────────────────────────────────────────────────
    CT = _create(C, "_template")
    _prompts(CT, ["1girl", "solo"])

    # template sub-entries
    CT_name = _create(CT, "name")
    _prompts(CT_name, ["[character's name]", "the protagonist"])

    CT_app = _create(CT, "appearance")
    _prompts(CT_app, ["[character's basic look]"])

    CT_oc = _create(CT, "official_custome")
    _prompts(CT_oc, ["[character's uniform]"])

    # character.toki ───────────────────────────────────────────────────────────
    T = _create(C, "toki")
    _prompts(T, ["blue archive", "sumomo, toki"])
    _trigger(T, "tk")

    # toki.name (OVERRIDES _template/name)
    TN = _create(T, "name")
    _prompts(TN, ["toki", "rabbit of the Millennium Science School"])

    # toki.appearance (same name as template → override)
    TA = _create(T, "appearance")
    _prompts(TA, ["white hair", "rabbit ears", "red eyes"])

    # toki.official_custome (same name as template → override)
    TO = _create(T, "official_custome")
    _prompts(TO, [("robot costume", 1.2), "futuristic armor"])

    # toki._neg
    TNEG = _create(T, "_neg", pos_neg="negative")
    _prompts(TNEG, [("nsfw", 1.4), ("nude", 1.4)])

    # toki._v1 (convenience composition)
    TV1 = _create(T, "_v1")
    _prompts(TV1, ["[toki.name], [character.toki.appearance]"])

    # character.rio ────────────────────────────────────────────────────────────
    R = _create(C, "rio")
    _prompts(R, ["blue archive"])

    RN = _create(R, "name")  # OVERRIDES _template/name
    _prompts(RN, ["rio", "Millennium Science School student council president"])

    RA = _create(R, "appearance")  # same name as template → override
    _prompts(RA, ["blonde hair", "long hair", ("drill hair", 1.1)])

    # ─── character.blue_archive (sub-folder) ──────────────────────────────────
    BA = _create(C, "blue_archive", has_prompts=False)

    # BA._template (inherits from character._template + adds more)
    BAT = _create(BA, "_template")
    _prompts(BAT, ["blue archive character"])

    # BA._template.name (OVERRIDES parent template)
    BATN = _create(BAT, "name")
    _prompts(BATN, ["[student name]", "Blue Archive student"])

    # BA._template.school_uniform (ADDITIONAL — not in parent template)
    BATSU = _create(BAT, "school_uniform")
    _prompts(BATSU, ["school uniform", "blue archive uniform"])

    # BA._template.appearance (INHERITED from parent, but has own content)
    BATA = _create(BAT, "appearance")
    _prompts(BATA, ["[their basic appearance]"])

    # BA.toki ──────────────────────────────────────────────────────────────────
    BATK = _create(BA, "toki")
    _prompts(BATK, ["toki in Blue Archive"])

    # BA.toki.name (OVERRIDES BA._template/name)
    BATKN = _create(BATK, "name")
    _prompts(BATKN, ["toki (Blue Archive)", "rabbit of Millennium"])

    # BA.toki.school_uniform (same name as BA._template entry → overrides)
    BATKSU = _create(BATK, "school_uniform")
    _prompts(BATKSU, [("school uniform with rabbit motif", 1.1)])

    # BA.toki.appearance (same name → own definition)
    BATKA = _create(BATK, "appearance")
    _prompts(BATKA, ["white hair", "rabbit ears", ("red eyes", 1.1)])

    # BA.toki._neg
    BATKNEG = _create(BATK, "_neg", pos_neg="negative")
    _prompts(BATKNEG, [("nsfw", 1.4), ("nude", 1.4), ("low quality", 1.2)])

    # ─── clothing (folder) ────────────────────────────────────────────────────
    CL = _create(None, "clothing", has_prompts=False)

    # clothing._template
    CLT = _create(CL, "_template")
    _prompts(CLT, ["clothing template"])

    CLT_B = _create(CLT, "bunnysuit")
    _prompts(CLT_B, ["bunny suit", ("bunny ears", 1.2), "leotard", "fishnet tights"])

    CLT_BI = _create(CLT, "bikini")
    _prompts(CLT_BI, ["bikini", "swimwear"])

    # clothing.bunnysuit
    CLB = _create(CL, "bunnysuit")
    _prompts(CLB, ["bunny suit", ("bunny ears", 1.2), "leotard"])

    # clothing.bunnysuit._neg
    CLBNEG = _create(CLB, "_neg", pos_neg="negative")
    _prompts(CLBNEG, [("nude", 1.4), ("nsfw", 1.4)])

    # ─── compound (folder) — cross-entry references ──────────────────────────
    CM = _create(None, "compound", has_prompts=False)

    # compound.toki_full — pulls from multiple entries via [ref]
    CMF = _create(CM, "toki_full")
    _prompts(CMF, [
        "[quality.positive]",
        "[artist.compilation]",
        "[toki.name], [toki.appearance]",
        "[toki.official_custome]",
        "[clothing.bunnysuit]",
        "[pose.cowboy_shot]",
    ])
    _trigger(CMF, "tkfull")

    # compound.toki_simple — using custom triggers
    CMS = _create(CM, "toki_simple")
    _prompts(CMS, [
        "[qp], [quality.negative]",
        "[tk.name], [tk.appearance]",
        "[pose.standing]",
    ])

    # ─── _ui_test (folder) — many custom triggers to stress the insert-row layout ──
    UT = _create(None, "_ui_test", has_prompts=False)
    UTM = _create(UT, "many_triggers")
    _prompts(UTM, ["ui layout test prompt", "second prompt", "third"])
    # A spread of short/medium/long trigger names to check button wrapping & ellipsis.
    for tg in [
        "x", "ab", "tag", "toki", "short", "medium_tag", "another_one",
        "a_fairly_long_trigger_name", "yet.another.dotted.trigger",
        "super_duper_extra_long_custom_trigger_name_for_wrapping",
        "q", "qq", "qqq", "alpha", "beta", "gamma", "delta_tag",
        "this_is_also_quite_a_long_one", "mid", "tiny", "wrap_me_please_thanks",
    ]:
        _trigger(UTM, tg)

    print("Seed data created.")


# ══════════════════════════════════════════════════════════════════════════════
# Verification
# ══════════════════════════════════════════════════════════════════════════════

def verify():
    tree = repo.get_tree()
    triggers = repo.get_all_triggers()
    node_map = {n["id"]: n for n in tree}

    print("\n" + "=" * 64)
    print("  NODE TREE")
    print("=" * 64)
    for n in sorted(tree, key=lambda x: x["full_path"]):
        indent = "  " * n["full_path"].count(".")
        kind = "[F]" if not n["has_prompts"] else "[E]"
        pn = "NEG" if n["pos_neg"] == "negative" else "pos"
        mode = n["random_mode"]
        fmode = ""
        if mode == "select":
            fmode = f" select({n['select_min']}-{n['select_max']})"
        elif mode == "dropout":
            fmode = f" dropout({n['dropout_rate']})"
        shuffle = " shfl" if n["shuffle"] else ""
        delim = f" delim={n['delimiter']!r}" if n["delimiter"] != ", " else ""
        fmt = f" fmt={n['format']!r}" if n["format"] else ""
        extra = f"{shuffle}{fmode}{fmt}{delim}"
        print(f"  {indent}{kind} [{n['id']:4d}] {n['name']:24s} ({pn})  {n['full_path']}{extra}")

        # Show prompts for entry nodes
        if n["has_prompts"]:
            prs = repo.get_prompts(n["id"])
            for p in sorted(prs, key=lambda x: (not x["enabled"], x["order_index"])):
                state = "✓" if p["enabled"] else "✗"
                w = f" :{p['weight']}" if abs(p["weight"] - 1.0) > 0.001 else ""
                print(f"  {indent}      {state} {p['content']}{w}  (ord={p['order_index']})")

    print("\n" + "=" * 64)
    print("  TRIGGERS")
    print("=" * 64)
    for t in sorted(triggers, key=lambda x: (x["node_id"], x["trigger_text"])):
        n = node_map.get(t["node_id"], {})
        tag = "AUTO" if t["is_auto"] else "custom"
        print(f"  [{tag}] {t['trigger_text']!r:24s} → {n.get('full_path', '?')}")

    print("\n" + "=" * 64)
    print("  TEMPLATE INHERITANCE CHECKS")
    print("=" * 64)

    # For each non-template entry, check if parent folder has _template
    for n in sorted(tree, key=lambda x: x["full_path"]):
        if not n["has_prompts"] or n["name"] == "_template":
            continue
        if n["parent_id"] is None:
            continue
        parent = node_map.get(n["parent_id"])
        if not parent or parent["has_prompts"]:
            continue  # parent is entry, not folder

        tpl = next((x for x in tree if x["parent_id"] == n["parent_id"] and x["name"] == "_template" and x["has_prompts"]), None)
        if not tpl:
            continue

        tpl_children = [x for x in tree if x["parent_id"] == tpl["id"] and x["has_prompts"]]
        own_children = [x for x in tree if x["parent_id"] == n["id"] and x["has_prompts"]]
        own_names = {x["name"] for x in own_children}

        inherited = [x for x in tpl_children if x["name"] not in own_names]
        overrides = [x for x in tpl_children if x["name"] in own_names]

        print(f"\n  {n['full_path']}")
        print(f"    Template: {tpl['full_path']}")
        if inherited:
            print(f"    Inherited: {[x['name'] for x in inherited]}")
        if overrides:
            print(f"    Overridden: {[x['name'] for x in overrides]}")
        if own_children:
            own_non_overrides = [x for x in own_children if x["name"] not in {y["name"] for y in tpl_children}]
            if own_non_overrides:
                print(f"    Own only: {[x['name'] for x in own_non_overrides]}")


# ══════════════════════════════════════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════════════════════════════════════

def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--clean", action="store_true", help="Delete all nodes and rebuild")
    args = parser.parse_args()

    DATA_DIR.mkdir(exist_ok=True)

    # Init DB
    conn = connect_write(DB_PATH)
    migrate(conn)
    conn.close()
    repo.init(str(DB_PATH))
    print(f"DB: {DB_PATH}")

    if args.clean:
        _delete_all()
        print("Cleaned all nodes.")

    seed()
    rebuild_auto_triggers().result(15)

    verify()

    repo.stop()
    print("\nDone.")


if __name__ == "__main__":
    main()
