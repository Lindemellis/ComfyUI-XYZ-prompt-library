"""Seed a self-contained demo tree for manually testing the Template feature.

Creates ONE new top-level folder `zzz_tmpl_demo` plus a full hierarchy underneath.
It does NOT touch any existing folders/entries. Safe to run while ComfyUI is up
(refresh the library tree afterwards). Aborts if `zzz_tmpl_demo` already exists.

Run:
    python test/seed_template_demo.py

To re-seed: delete the `zzz_tmpl_demo` folder in the UI first, then run again.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from prompt_library_v2.db import connect_write, migrate
from prompt_library_v2 import repo
from prompt_library_v2.trigger import rebuild_auto_triggers

ROOT = "zzz_tmpl_demo"

_PKG = os.path.join(os.path.dirname(__file__), "..", "prompt_library_v2")
DB = os.path.normpath(os.path.join(_PKG, "..", "prompt_library_v2_data", "plv2.db"))


def main() -> None:
    if not os.path.exists(DB):
        print(f"[seed] DB not found at {DB} — start ComfyUI once to create it.")
        return

    conn = connect_write(DB)
    migrate(conn)            # ensure v4 (prompt_overrides) schema
    conn.close()
    repo.init(DB)
    H = repo.HIGH

    if any(n["full_path"] == ROOT or n["full_path"].startswith(ROOT + ".")
           for n in repo.get_tree()):
        print(f"[seed] '{ROOT}' already exists — delete it in the UI to re-seed. Aborting.")
        repo.stop()
        return

    def folder(parent, name, path, order=0):
        return repo.enqueue_write(H, repo.CreateNodeOp(parent, name, path, False, False, "positive", order)).result()

    def entry(parent, name, path, pn="positive", order=0):
        return repo.enqueue_write(H, repo.CreateNodeOp(parent, name, path, False, True, pn, order)).result()

    def prom(nid, content, w=1.0, en=True, o=0):
        repo.enqueue_write(H, repo.UpsertPromptOp(node_id=nid, content=content, weight=w, enabled=en, order_index=o)).result()

    # ── root folder + its template ──────────────────────────────────────────
    root = folder(None, ROOT, ROOT, order=999)
    tmpl = entry(root, "_template", f"{ROOT}._template", order=0)
    prom(tmpl, "masterpiece", 1.0, True, 0)
    prom(tmpl, "best quality", 1.0, True, 1)
    prom(tmpl, "ultra-detailed", 1.2, True, 2)          # weighted (test weight override)
    prom(tmpl, "lowres", 1.0, False, 3)                 # DISABLED template prompt (sorts last)

    # template sub-entry "quality" + recursive sub-sub-entry "extreme"
    tq = entry(tmpl, "quality", f"{ROOT}._template.quality", order=0)
    prom(tq, "high detail", 1.0, True, 0)
    prom(tq, "sharp focus", 1.0, True, 1)
    tqx = entry(tq, "extreme", f"{ROOT}._template.quality.extreme", order=0)
    prom(tqx, "8k", 1.0, True, 0)
    prom(tqx, "uhd", 1.0, True, 1)

    # ── base entries that inherit the root template ─────────────────────────
    hero = entry(root, "hero", f"{ROOT}.hero", order=1)
    prom(hero, "1boy", 1.0, True, 0)
    prom(hero, "silver armor", 1.0, True, 1)
    prom(hero, "ugly", 1.0, False, 2)                   # own DISABLED prompt (sorts before tpl-disabled)

    heroine = entry(root, "heroine", f"{ROOT}.heroine", order=2)
    prom(heroine, "1girl", 1.0, True, 0)
    prom(heroine, "long hair", 1.0, True, 1)
    prom(heroine, "blue eyes", 1.1, True, 2)
    # same-named sub-entry → auto-inherits the template's "quality" (+ its "extreme")
    hq = entry(heroine, "quality", f"{ROOT}.heroine.quality", order=0)
    prom(hq, "pretty face", 1.0, True, 0)

    # negative base entry → must NOT inherit (point 2)
    villain = entry(root, "villain_neg", f"{ROOT}.villain_neg", pn="negative", order=3)
    prom(villain, "bad anatomy", 1.0, True, 0)
    prom(villain, "extra fingers", 1.0, True, 1)

    # ── sub-folder WITHOUT its own template → inherits root template by climb ─
    beasts = folder(root, "beasts", f"{ROOT}.beasts", order=4)
    dragon = entry(beasts, "dragon", f"{ROOT}.beasts.dragon", order=0)
    prom(dragon, "dragon scales", 1.0, True, 0)
    prom(dragon, "huge wings", 1.0, True, 1)

    # ── sub-folder WITH its own template → chain (knight tmpl + root tmpl) ────
    knights = folder(root, "knights", f"{ROOT}.knights", order=5)
    ktmpl = entry(knights, "_template", f"{ROOT}.knights._template", order=0)
    prom(ktmpl, "detailed eyes", 1.0, True, 0)
    prom(ktmpl, "intricate armor", 1.0, True, 1)
    paladin = entry(knights, "paladin", f"{ROOT}.knights.paladin", order=1)
    prom(paladin, "holy sword", 1.0, True, 0)

    rebuild_auto_triggers()
    repo.stop()

    print(f"""[seed] Created '{ROOT}'. Refresh the PLv2 library tree to see it.

Manual test checklist:
 1. Tree shows the 'template' rows (gear icon, italic/tinted) under {ROOT} and
    {ROOT}/knights.
 2. Open '{ROOT}/hero' -> prompt list shows OWN (1boy, silver armor) + INHERITED
    (masterpiece, best quality, ultra-detailed) tinted/locked; disabled order =
    own 'ugly' then template 'lowres' at the very end.
 3. In hero, toggle an inherited prompt off, change ultra-detailed's weight ->
    only affects hero (per-entry override). Check 'villain_neg' is unaffected.
 4. '{ROOT}/villain_neg' (negative) -> NO inherited rows (point 2).
 5. hero -> Sub Entries tab -> 'quality' shows as inherited (tpl badge) with an
    override button; click it -> becomes a local 'ovr' child that still inherits
    high detail / sharp focus (and recursively 'extreme').
 6. '{ROOT}/heroine/quality' (same name as template's) already auto-inherits
    high detail + sharp focus on top of its own 'pretty face'.
 7. '{ROOT}/beasts/dragon' (sub-folder w/o template) inherits the ROOT template.
 8. '{ROOT}/knights/paladin' inherits BOTH knights template (detailed eyes,
    intricate armor) AND root template (masterpiece, best quality, ...) via chain.
 9. In a PLv2 node, type [{ROOT}.hero] -> resolves with inherited prompts merged.
    Type [{ROOT}._template] -> resolves to EMPTY (templates aren't [ref]-able).
10. Autocomplete for refs should NOT suggest any '_template' path.
""")


if __name__ == "__main__":
    main()
