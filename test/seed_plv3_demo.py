"""Seed the PLv3 library with a demo that exercises every library feature.

    python -m test.seed_plv3_demo          # from the repo root
    python -m test.seed_plv3_demo --reset  # wipe the `demo` folder first

Everything lands under a single top-level folder, `demo`, so it never mixes with
your own library.  What it covers (spec §5):

    folders / sub-folders          demo, demo.characters, ...
    library groups                 demo.quality.anima, demo.characters.illya, ...
    true subgroups (ownership)     demo.characters.illya.outfit — deleted with illya
    references (sharing)           demo.scenes.duo -> illya, miyu — shared entities
    nested references              duo -> illya -> illya.accessories
    item weights                   stored on the row, rendered as (tag:1.2)
    LoRA items                     <lora:add_detail:0.6>
    group settings                 weight / shuffle / random_select / format
    presets                        illya: "minimal" / "full"; duo: "solo-illya"
                                   (with an embedded snapshot of the nested ref)
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from prompt_library_v3 import library, repo  # noqa: E402
from prompt_library_v3.db import connect_write, migrate  # noqa: E402

DB = ROOT / "prompt_library_v3_data" / "plv3.db"


def folder(name, parent=None):
    return repo.write(repo.CreateFolderOp(name=name, parent_id=parent))


def group(name, folder_id=None, parent=None, settings=None, polarity="positive"):
    return repo.write(repo.CreateGroupOp(
        name=name, folder_id=folder_id, parent_group_id=parent,
        settings=settings or {}, polarity=polarity,
    ))


def items(gid, *texts, weights=None):
    weights = weights or {}
    for text in texts:
        repo.write(repo.AddItemOp(
            group_id=gid,
            kind="lora" if text.startswith("<lora:") else "prompt",
            text=text,
            weight=weights.get(text),
        ))


def ref(gid, target):
    return repo.write(repo.AddItemOp(group_id=gid, kind="ref", ref_group_id=target))


def preset(gid, name, item_texts, settings=None, children=None):
    """A preset is an enable whitelist *and* an order (spec §5.4)."""
    rows = {i["text"]: int(i["id"]) for i in repo.list_items(gid)}
    return repo.write(repo.SavePresetOp(
        group_id=gid, name=name,
        body={
            "items": [rows[t] for t in item_texts if t in rows],
            "settings": settings or {},
            "children": children or {},
        },
    ))


def wipe_demo():
    for g in repo.list_groups():
        if (repo.group_path(int(g["id"])) or "").startswith("demo."):
            try:
                repo.write(repo.DeleteGroupOp(group_id=int(g["id"])))
            except Exception:
                pass
    for f in repo.list_folders():
        if f["name"] == "demo" and f["parent_id"] is None:
            repo.write(repo.DeleteFolderOp(folder_id=int(f["id"])))


def seed() -> dict:
    demo = folder("demo")
    f_quality = folder("quality", demo)
    f_chars = folder("characters", demo)
    f_styles = folder("styles", demo)
    f_scenes = folder("scenes", demo)

    # --- quality: a group that references another group -----------------------
    scores = group("scores", folder_id=f_quality)
    items(scores, "score_9", "score_8_up", "score_7_up")

    anima = group("anima", folder_id=f_quality, settings={"weight": 1.05})
    items(anima, "masterpiece", "best quality", "amazing quality", "absurdres", "newest")
    ref(anima, scores)  # sharing: `scores` is its own entity, reused elsewhere

    # --- characters: true subgroups + weights + a LoRA ------------------------
    illya = group("illya", folder_id=f_chars)
    items(
        illya,
        "illyasviel von einzbern", "blonde hair", "red eyes", "long hair",
        weights={"illyasviel von einzbern": 1.15},
    )
    # A true subgroup: owned by illya, deleted with her, path illya.accessories.
    accessories = group("accessories", parent=illya)
    items(accessories, "hair ribbon", "x hair ornament")
    ref(illya, accessories)

    outfit = group("outfit", parent=illya, settings={"random_select": [1, 1]})
    items(outfit, "white dress", "magical girl", "kaleidostick")

    miyu = group("miyu", folder_id=f_chars)
    items(miyu, "miyu edelfelt", "black hair", "yellow eyes", weights={"miyu edelfelt": 1.15})

    # --- styles: weighted artist tags + a LoRA item ---------------------------
    wlop = group("wlop", folder_id=f_styles, settings={"weight": 1.1})
    items(wlop, "artist:wlop", "<lora:add_detail:0.6>", weights={"artist:wlop": 1.2})

    # --- scenes: a group built only out of references -------------------------
    duo = group("duo", folder_id=f_scenes)
    items(duo, "2girls", "yuri", "side-by-side")
    ref(duo, illya)   # nested: duo -> illya -> illya.accessories
    ref(duo, miyu)

    # --- negative ------------------------------------------------------------
    neg = group("bad", folder_id=demo and None, polarity="negative")
    repo.write(repo.MoveGroupOp(group_id=neg, folder_id=demo))
    items(neg, "worst quality", "low quality", "jpeg artifacts", "watermark", "signature")

    # --- presets -------------------------------------------------------------
    preset(illya, "minimal", ["illyasviel von einzbern", "blonde hair"])
    preset(illya, "full", ["illyasviel von einzbern", "blonde hair", "red eyes", "long hair"])

    # A preset on `duo` that keeps only illya, and embeds a snapshot of *her*
    # state — spec §5.4's nested snapshot, which does not follow later edits.
    duo_rows = {i["text"]: int(i["id"]) for i in repo.list_items(duo)}
    illya_ref_id = next(
        int(i["id"]) for i in repo.list_items(duo)
        if i["kind"] == "ref" and i["ref_group_id"] == illya
    )
    illya_rows = {i["text"]: int(i["id"]) for i in repo.list_items(illya)}
    repo.write(repo.SavePresetOp(
        group_id=duo, name="solo-illya",
        body={
            "items": [duo_rows["2girls"], illya_ref_id],
            "settings": {},
            "children": {
                str(illya_ref_id): {
                    "mode": "snapshot",
                    "items": [illya_rows["illyasviel von einzbern"], illya_rows["blonde hair"]],
                    "settings": {},
                    "children": {},
                },
            },
        },
    ))

    return {"anima": anima, "illya": illya, "duo": duo, "neg": neg, "wlop": wlop}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true", help="delete the demo folder first")
    args = ap.parse_args()

    DB.parent.mkdir(exist_ok=True)
    conn = connect_write(DB)
    try:
        migrate(conn)
    finally:
        conn.close()
    repo.init(DB)

    if args.reset:
        wipe_demo()
    if any(f["name"] == "demo" and f["parent_id"] is None for f in repo.list_folders()):
        print("A `demo` folder already exists — pass --reset to rebuild it.")
        repo.shutdown()
        return 1

    made = seed()
    print("seeded:")
    for g in repo.list_groups():
        path = repo.group_path(int(g["id"]))
        if path and path.startswith("demo"):
            n = len(repo.list_items(int(g["id"])))
            p = len(repo.list_presets(int(g["id"])))
            print(f"  {path:38s} {n:2d} items" + (f", {p} preset(s)" if p else ""))

    print("\n--- demo.scenes.duo expands to ---")
    print(library.expand(made["duo"]))
    repo.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
