"""PLv2 -> PLv3 one-shot migration (spec §9).

    python -m prompt_library_v3.migrate_v2 [--v2 path] [--v3 path] [--dry-run]

What maps to what:

    PLv2                        PLv3
    ------------------------    ----------------------------------------------
    folder node (has_prompts=0) folder
    entry node  (has_prompts=1) library group
    entry's prompts             the group's items
    sub-entry                   true subgroup (owned by its parent group)
    [ref] / [this.x]            a ref item, rewritten to the full path
    _template                   an ordinary group; the entries that inherited it
                                get a ref to it as their first item
    trigger word                dropped — v3 refs always spell the full path
    {a|b}                       {a, b}.set{random_select: 1}
    {p} / {prompt} in format    $p
    node random/shuffle/dropout the group's settings_json
    prompt.enabled              a per-group preset named `imported` — v3's library has
                                no `enabled` column (an item is on iff it appears in the
                                text, §5.2), so the only place the state can live is a
                                preset, which IS a whitelist plus an order (§5.4)

Triggers are dropped, but they are still *read* during the migration: a PLv2
`[ref]` may be written with a trigger name, and it has to resolve to something.

Nothing is destroyed: the v2 DB is opened read-only and the v3 DB is written
through the normal WriteQueue ops, so the migration obeys the same invariants
(cycle checks included) as any other library write.
"""
from __future__ import annotations

import argparse
import re
import sqlite3
import sys
from dataclasses import dataclass, field
from pathlib import Path

from . import repo
from .db import connect_write, migrate as migrate_schema

# `{a|b|c}` — PLv2's choice pattern.
_CHOICE = re.compile(r"\{([^{}]*\|[^{}]*)\}")
# A prompt whose whole content is a single reference.  The inner text must look like
# a *path*: a v2 library also contains prompts that merely start with a bracket —
# raw prompt-control scheduling such as `[(tag:2.5)::0.3]` — and those are text, not
# references.  PLv2 forbids `. , | / \ [ ]` in definition names, so a path never has
# a colon, a paren or a pipe in it.
_ONLY_REF = re.compile(r"^\[([^\[\]:()|]+)\]$")


@dataclass
class Report:
    folders: int = 0
    groups: int = 0
    items: int = 0
    refs: int = 0
    template_refs: int = 0
    choices: int = 0
    presets: int = 0
    disabled: int = 0
    unresolved_refs: list[str] = field(default_factory=list)
    duplicates: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "folders": self.folders,
            "groups": self.groups,
            "items": self.items,
            "refs": self.refs,
            "template_refs": self.template_refs,
            "choices": self.choices,
            "presets": self.presets,
            "disabled": self.disabled,
            "unresolved_refs": self.unresolved_refs,
            "duplicates": self.duplicates,
        }


# --- v2 reading -------------------------------------------------------------


def _read_v2(path: Path) -> tuple[list[dict], dict[int, list[dict]], dict[str, int]]:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        nodes = [dict(r) for r in conn.execute("SELECT * FROM nodes ORDER BY id")]
        prompts: dict[int, list[dict]] = {}
        for r in conn.execute("SELECT * FROM prompts ORDER BY node_id, order_index, id"):
            prompts.setdefault(int(r["node_id"]), []).append(dict(r))
        triggers = {
            str(r["trigger_text"]): int(r["node_id"])
            for r in conn.execute("SELECT node_id, trigger_text FROM triggers")
        }
    finally:
        conn.close()
    return nodes, prompts, triggers


# --- content rewriting ------------------------------------------------------


def rewrite_choices(content: str, report: Report) -> str:
    """`{a|b}` -> `{a, b}.set{random_select: 1}` (spec §9).

    v3 has no `{a|b}`: a group with `random_select: 1` *is* the choice.  The result
    is stored as the item's text — an item whose text happens to be a group, which
    the library block round-trips verbatim."""

    def sub(m: re.Match) -> str:
        options = [o.strip() for o in m.group(1).split("|") if o.strip()]
        if len(options) < 2:
            return m.group(0)
        report.choices += 1
        return "{" + ", ".join(options) + "}.set{random_select: 1}"

    return _CHOICE.sub(sub, content)


def rewrite_format(fmt: str) -> str:
    """PLv2's `{p}` / `{prompt}` placeholder becomes `$p` (spec §9, decision 23)."""
    return (fmt or "").replace("{prompt}", "$p").replace("{p}", "$p")


def settings_of(node: dict) -> dict:
    """The v2 node's own knobs become the v3 group's default `.set{}`."""
    out: dict = {}
    if node.get("shuffle"):
        out["shuffle"] = True
    mode = node.get("random_mode") or "none"
    if mode == "select":
        lo = max(1, int(node.get("select_min") or 1))
        hi = max(lo, int(node.get("select_max") or lo))
        out["random_select"] = [lo, hi]
    elif mode == "dropout":
        rate = float(node.get("dropout_rate") or 0.0)
        if rate > 0:
            out["dropout"] = rate
    fmt = rewrite_format(node.get("format") or "")
    if fmt:
        out["format"] = fmt
    return out


# --- ref resolution ---------------------------------------------------------


class Resolver:
    """PLv2's `[ref]` rules, just enough of them: `full_path` wins over a trigger
    name, and a multi-segment ref takes the longest prefix that resolves, then
    walks the rest as a sub-path."""

    def __init__(self, nodes: list[dict], triggers: dict[str, int]) -> None:
        self.nodes = nodes
        self.by_id = {int(n["id"]): n for n in nodes}
        self.by_path = {str(n["full_path"]): int(n["id"]) for n in nodes}
        self.triggers = triggers
        self.children: dict[int, dict[str, int]] = {}
        for n in nodes:
            parent = n["parent_id"]
            if parent is None:
                continue
            self.children.setdefault(int(parent), {})[str(n["name"])] = int(n["id"])

    def resolve(self, ref: str, owner_path: str) -> int | None:
        ref = ref.strip()
        if not ref:
            return None
        # `[this(.x)]` rebinds to the owning entry (PLv2's own rule).
        if ref == "this":
            return self.by_path.get(owner_path)
        if ref.startswith("this."):
            tail = ref[5:]
            found = self._path(f"{owner_path}.{tail}")
            if found is not None:
                return found
            # PLv2 falls back to the *inherited* template's sub-entry: `[this.x]` in
            # an entry that has no own `x` means the `x` of the `_template` it
            # inherits.  v3 has no inheritance, so it has to become a ref to that
            # template's subgroup — resolve it here or the ref is lost.
            owner = self.by_id.get(self.by_path.get(owner_path, -1))
            if owner is not None:
                tpl = _nearest_template(owner, self.by_id, self.nodes)
                if tpl is not None:
                    found = self._path(f"{tpl['full_path']}.{tail}")
                    if found is not None:
                        return found
            return None

        if ref in self.by_path:
            return self.by_path[ref]
        if ref in self.triggers:
            return self.triggers[ref]

        parts = ref.split(".")
        for cut in range(len(parts) - 1, 0, -1):
            head = ".".join(parts[:cut])
            node = self.by_path.get(head) or self.triggers.get(head)
            if node is None:
                continue
            for name in parts[cut:]:
                node = self.children.get(node, {}).get(name)
                if node is None:
                    break
            if node is not None:
                return node
        return None

    def _path(self, full_path: str) -> int | None:
        return self.by_path.get(full_path)


# --- the migration ----------------------------------------------------------


def migrate(v2_path: Path, v3_path: Path, dry_run: bool = False) -> Report:
    nodes, prompts, triggers = _read_v2(Path(v2_path))
    report = Report()
    if dry_run:
        return _plan(nodes, prompts, triggers, report)

    conn = connect_write(v3_path)
    try:
        migrate_schema(conn)
    finally:
        conn.close()
    repo.init(v3_path)

    by_id = {int(n["id"]): n for n in nodes}
    is_group = {int(n["id"]): bool(n["has_prompts"]) for n in nodes}
    resolver = Resolver(nodes, triggers)

    # A node under an entry is a true subgroup, whatever it calls itself.
    def owner_is_group(node: dict) -> bool:
        parent = node["parent_id"]
        return parent is not None and is_group.get(int(parent), False)

    folder_ids: dict[int, int] = {}  # v2 node id -> v3 folder id
    group_ids: dict[int, int] = {}   # v2 node id -> v3 group id

    # Depth order, so a parent always exists before its children.
    def depth(node: dict) -> int:
        d, p = 0, node["parent_id"]
        while p is not None:
            d += 1
            p = by_id[int(p)]["parent_id"] if int(p) in by_id else None
        return d

    for node in sorted(nodes, key=depth):
        nid = int(node["id"])
        parent = node["parent_id"]
        parent_id = int(parent) if parent is not None else None

        if is_group[nid] or owner_is_group(node):
            if parent_id is not None and parent_id in group_ids:
                gid = repo.write(repo.CreateGroupOp(
                    name=node["name"],
                    parent_group_id=group_ids[parent_id],
                    polarity=node["pos_neg"] or "positive",
                    settings=settings_of(node),
                ))
            else:
                gid = repo.write(repo.CreateGroupOp(
                    name=node["name"],
                    folder_id=folder_ids.get(parent_id) if parent_id else None,
                    polarity=node["pos_neg"] or "positive",
                    settings=settings_of(node),
                ))
            group_ids[nid] = gid
            report.groups += 1
        else:
            fid = repo.write(repo.CreateFolderOp(
                name=node["name"],
                parent_id=folder_ids.get(parent_id) if parent_id else None,
            ))
            folder_ids[nid] = fid
            report.folders += 1

    # A library group referencing the same target twice is a meaningless duplicate,
    # and v3's schema says so.  v2 allowed it, so collapse them.
    seen_refs: set[tuple[int, int]] = set()

    # v3's library has no `enabled` column — an item is on iff it appears in the text
    # (§5.2).  v2's on/off flags therefore have nowhere to live except a PRESET, which
    # is exactly a whitelist plus an order (§5.4).  Record, per group and in v2's own
    # order, every item we create and whether v2 had it switched on.
    #
    # `ref_targets` is what lets a parent's preset LINK a ref to the child's own
    # preset.  It has to: a ref with no entry under `children` expands the target with
    # all of its items (library.py:125), which would switch back on everything the
    # child had switched off.
    order: dict[int, list[tuple[int, bool]]] = {}   # v3 group id -> [(item id, on)]
    ref_targets: dict[int, int] = {}                # v3 ref item id -> target group id

    def record(gid: int, item_id: int, enabled: bool) -> None:
        order.setdefault(gid, []).append((int(item_id), bool(enabled)))

    def add_ref(gid: int, target_gid: int, where: str, enabled: bool = True) -> bool:
        if (gid, target_gid) in seen_refs:
            report.duplicates.append(f"{where}: duplicate reference, collapsed")
            return False
        try:
            item_id = repo.write(
                repo.AddItemOp(group_id=gid, kind="ref", ref_group_id=target_gid)
            )
        except repo.CycleError:
            report.unresolved_refs.append(f"{where} (would create a cycle)")
            return False
        seen_refs.add((gid, target_gid))
        record(gid, item_id, enabled)
        ref_targets[int(item_id)] = int(target_gid)
        return True

    # Items, once every group exists (a ref can point forward).
    for nid, gid in group_ids.items():
        node = by_id[nid]
        seen: set[str] = set()
        for prompt in prompts.get(nid, []):
            content = (prompt["content"] or "").strip()
            if not content:
                continue

            enabled = bool(prompt["enabled"])

            only_ref = _ONLY_REF.match(content)
            if only_ref:
                target = resolver.resolve(only_ref.group(1), str(node["full_path"]))
                target_gid = group_ids.get(target) if target is not None else None
                if target_gid is None:
                    report.unresolved_refs.append(f"{node['full_path']} -> {content}")
                    # Keep it as literal text rather than silently dropping it.
                else:
                    if add_ref(
                        gid, target_gid, f"{node['full_path']} -> {content}", enabled
                    ):
                        report.refs += 1
                    continue

            text = rewrite_choices(content, report)
            if text in seen:
                report.duplicates.append(f"{node['full_path']}: {text}")
                continue
            seen.add(text)

            weight = prompt["weight"]
            item_id = repo.write(repo.AddItemOp(
                group_id=gid,
                kind="lora" if text.startswith("<lora:") else "prompt",
                text=text,
                weight=float(weight) if weight not in (None, 1.0) else None,
            ))
            record(gid, item_id, enabled)
            report.items += 1

    # `_template` inheritance becomes an explicit ref (spec §9, decision 28).
    for nid, gid in group_ids.items():
        node = by_id[nid]
        if node["name"] == "_template":
            continue
        if (node["pos_neg"] or "positive") != "positive":
            continue  # negative entries never inherited a template in v2
        if "._template." in f".{node['full_path']}." or str(node["full_path"]).endswith("._template"):
            continue  # already inside a template subtree

        tpl = _nearest_template(node, by_id, nodes)
        if tpl is None or int(tpl["id"]) not in group_ids:
            continue
        # A v2 template always applied — the entry could switch its individual prompts
        # off, but never the inheritance itself. So the ref is always on.
        if add_ref(gid, group_ids[int(tpl["id"])], f"{node['full_path']} -> _template"):
            report.template_refs += 1

    _write_presets(group_ids, order, ref_targets, report)
    return report


PRESET_NAME = "imported"


def _write_presets(
    group_ids: dict[int, int],
    order: dict[int, list[tuple[int, bool]]],
    ref_targets: dict[int, int],
    report: Report,
) -> None:
    """v2's on/off state, as one preset per group (spec §5.4).

    Two passes, because a parent's preset has to name the id of its child's preset and
    that row does not exist yet on the first pass. `SavePresetOp` upserts on
    `(group_id, name)`, so the second pass rewrites the same rows rather than piling up
    duplicates.
    """
    preset_of: dict[int, int] = {}
    for gid in group_ids.values():
        preset_of[gid] = repo.write(
            repo.SavePresetOp(group_id=gid, name=PRESET_NAME, body={})
        )

    for gid in group_ids.values():
        seq = order.get(gid, [])
        whitelist = [item_id for item_id, on in seq if on]

        # LINK every ref that survived to the target's own preset. Without this the
        # child expands with all of its items and everything v2 had switched off in it
        # comes back on.
        children = {}
        for item_id in whitelist:
            target = ref_targets.get(item_id)
            if target is not None and target in preset_of:
                children[str(item_id)] = {
                    "mode": "preset",
                    "preset_id": preset_of[target],
                }

        repo.write(repo.SavePresetOp(
            group_id=gid,
            name=PRESET_NAME,
            # Weights and settings already live on the item and group rows — a preset
            # that repeated them would be a second, divergeable copy.
            body={"items": whitelist, "weights": {}, "settings": {}, "children": children},
        ))
        report.presets += 1
        off = len(seq) - len(whitelist)
        if off:
            report.disabled += off


def _nearest_template(node: dict, by_id: dict, nodes: list[dict]) -> dict | None:
    """The `_template` of the nearest ancestor folder — PLv2's folder climb."""
    children_of: dict[int | None, list[dict]] = {}
    for n in nodes:
        children_of.setdefault(
            int(n["parent_id"]) if n["parent_id"] is not None else None, []
        ).append(n)

    parent = node["parent_id"]
    while parent is not None:
        for child in children_of.get(int(parent), []):
            if child["name"] == "_template" and int(child["id"]) != int(node["id"]):
                return child
        parent = by_id[int(parent)]["parent_id"] if int(parent) in by_id else None
    return None


def _plan(nodes, prompts, triggers, report: Report) -> Report:
    """Count what a real run would do, touching nothing."""
    is_group = {int(n["id"]): bool(n["has_prompts"]) for n in nodes}
    for n in nodes:
        parent = n["parent_id"]
        owner_group = parent is not None and is_group.get(int(parent), False)
        if is_group[int(n["id"])] or owner_group:
            report.groups += 1
        else:
            report.folders += 1
    for node_id, rows in prompts.items():
        if not is_group.get(int(node_id)):
            continue
        for p in rows:
            content = (p["content"] or "").strip()
            if not content:
                continue
            if _ONLY_REF.match(content):
                report.refs += 1
            else:
                report.items += 1
                rewrite_choices(content, report)
    return report


def main(argv: list[str] | None = None) -> int:
    here = Path(__file__).parent.parent
    ap = argparse.ArgumentParser(description="Migrate a PLv2 library into PLv3.")
    ap.add_argument("--v2", default=str(here / "prompt_library_v2_data" / "plv2.db"))
    ap.add_argument("--v3", default=str(here / "prompt_library_v3_data" / "plv3.db"))
    ap.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    args = ap.parse_args(argv)

    v2 = Path(args.v2)
    v3 = Path(args.v3)
    if not v2.is_file():
        print(f"no PLv2 database at {v2}", file=sys.stderr)
        return 1
    if v3.exists() and not args.dry_run:
        print(
            f"{v3} already exists.  Migration only ever writes into a fresh library — "
            f"move the existing one aside first.",
            file=sys.stderr,
        )
        return 1
    v3.parent.mkdir(parents=True, exist_ok=True)

    report = migrate(v2, v3, dry_run=args.dry_run)
    for key, value in report.as_dict().items():
        if isinstance(value, list):
            if value:
                print(f"{key}:")
                for line in value:
                    print(f"  - {line}")
        else:
            print(f"{key}: {value}")
    if not args.dry_run:
        repo.shutdown()
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
