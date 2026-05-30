"""Prompt Library V2 — Trigger name engine.

Two responsibilities:

1. Auto trigger computation (rebuild_auto_triggers):
   For every entry node (has_prompts=True), compute the shortest dot-suffix
   of its full_path that is globally unique across all trigger names.

   Algorithm:
   - Each node tries candidates shortest-first: 'toki', 'ba.toki', 'character.ba.toki'
   - If two nodes want the same suffix → both advance to the next longer suffix
   - Custom triggers of OTHER nodes block a suffix from being used as auto trigger
   - A node's own custom triggers are skipped (redundant; custom already covers them)
   - The full_path is always the fallback (guaranteed unique by DB constraint)

2. Trigger lookup (resolve_trigger):
   Given user text like 'toki.name', find the best matching trigger prefix and
   return (node_id, sub_path). The caller appends sub_path to the resolved
   node's full_path to locate the target child node.

   Lookup order (longest prefix first):
   - Exact full_path match
   - Longest trigger prefix + remaining as sub_path
"""

from __future__ import annotations

from typing import Dict, List, Optional, Tuple

from . import repo as _repo


# ---------------------------------------------------------------------------
# Auto trigger computation
# ---------------------------------------------------------------------------

def _candidates(node: Dict, by_id: Dict[int, Dict]) -> List[str]:
    """Trigger-name candidates for `node`, shortest (most preferred) first.

    The base candidate is the dot-join of the names of `node` plus all of its
    **entry** ancestors (folders dropped) — i.e. it always carries every parent
    entry name, but no folder names. If that is ambiguous, folder ancestors are
    re-introduced one at a time, nearest to the node first, each placed at its
    correct path position. The final candidate is always the full_path (unique by
    DB constraint).

        chars(F)/toki(E)/face(E)   → ['toki.face', 'chars.toki.face']
        a(F)/b(E)/c(F)/d(E)        → ['b.d', 'b.c.d', 'a.b.c.d']
        quality(F)/positive(E)     → ['positive', 'quality.positive']
    """
    # Build root→node chain.
    chain: List[Dict] = []
    cur: Optional[Dict] = node
    while cur is not None:
        chain.append(cur)
        pid = cur.get("parent_id")
        cur = by_id.get(pid) if pid is not None else None
    chain.reverse()

    names = [c["name"] for c in chain]
    is_entry = [bool(c["has_prompts"]) for c in chain]
    n = len(chain)

    included = {i for i in range(n) if is_entry[i]}            # all entry segments (mandatory)
    folders_nearest_first = sorted((i for i in range(n) if not is_entry[i]), reverse=True)

    def join(inc: set) -> str:
        return ".".join(names[i] for i in sorted(inc))

    cands = [join(included)]
    for fi in folders_nearest_first:
        included = included | {fi}
        cands.append(join(included))

    full = node["full_path"]
    if not cands or cands[-1] != full:
        cands.append(full)

    # Drop consecutive duplicates, preserve order.
    out: List[str] = []
    for c in cands:
        if not out or out[-1] != c:
            out.append(c)
    return out


def compute_auto_triggers(
    nodes: List[Dict],
    custom_triggers: List[Dict],
    all_nodes: Optional[List[Dict]] = None,
) -> Dict[int, str]:
    """Compute the shortest unambiguous auto trigger for each entry node.

    Args:
        nodes: entry node dicts (has_prompts=True) to compute triggers for
        custom_triggers: all is_auto=False trigger dicts with 'trigger_text' and 'node_id'
        all_nodes: every node (folders + entries) — needed to walk parent chains.
                   Defaults to `nodes` for backward compatibility.

    Returns:
        {node_id: auto_trigger_text} — nodes whose auto trigger equals an existing
        custom trigger of the same node are excluded (custom already covers them).
    """
    by_id: Dict[int, Dict] = {n["id"]: n for n in (all_nodes if all_nodes is not None else nodes)}
    # custom_owner[text] = node_id that owns this custom trigger
    custom_owner: Dict[str, int] = {
        t["trigger_text"]: t["node_id"] for t in custom_triggers
    }
    # own_customs[node_id] = set of custom trigger texts for that node
    own_customs: Dict[int, set] = {}
    for t in custom_triggers:
        own_customs.setdefault(t["node_id"], set()).add(t["trigger_text"])

    # fullpath_owner[full_path] = node_id. A candidate that equals ANOTHER node's
    # full_path must be skipped: resolve_trigger gives full_path priority, so such
    # an auto trigger would be shadowed (dead). A node's own full_path is the final
    # fallback candidate and is never blocked for itself.
    fullpath_owner: Dict[str, int] = {n["full_path"]: n["id"] for n in by_id.values()}

    # Pre-compute candidate lists for each node (shortest/most-preferred first)
    suf_lists: Dict[int, List[str]] = {
        n["id"]: _candidates(n, by_id) for n in nodes
    }
    # Per-node pointer into its suffix list (advances on conflict or blocking)
    ptr: Dict[int, int] = {n["id"]: 0 for n in nodes}
    result: Dict[int, str] = {}
    unresolved: set = set(suf_lists.keys())

    # Worst case: all nodes share all path segments → O(max_depth) rounds
    max_rounds = max((len(v) for v in suf_lists.values()), default=0) + 2

    for _ in range(max_rounds):
        if not unresolved:
            break

        # For each unresolved node, advance past blocked candidates.
        # We never advance past the last candidate (full_path) — that's the fallback.
        for node_id in list(unresolved):
            suf_list = suf_lists[node_id]
            while ptr[node_id] < len(suf_list) - 1:
                suf = suf_list[ptr[node_id]]
                owner = custom_owner.get(suf)
                fp_owner = fullpath_owner.get(suf)
                blocked_by_other = owner is not None and owner != node_id
                blocked_by_path  = fp_owner is not None and fp_owner != node_id
                is_own_custom = suf in own_customs.get(node_id, set())
                if blocked_by_other or blocked_by_path or is_own_custom:
                    ptr[node_id] += 1
                else:
                    break

        # Collect each node's current candidate
        wanted: Dict[str, List[int]] = {}
        for node_id in unresolved:
            idx = min(ptr[node_id], len(suf_lists[node_id]) - 1)
            suf = suf_lists[node_id][idx]
            wanted.setdefault(suf, []).append(node_id)

        resolved_this_round: set = set()
        for suf, node_ids in wanted.items():
            if len(node_ids) == 1:
                # Unique — assign
                result[node_ids[0]] = suf
                resolved_this_round.add(node_ids[0])
            else:
                # Conflict: advance all, resolve those that hit the end
                for node_id in node_ids:
                    if ptr[node_id] >= len(suf_lists[node_id]) - 1:
                        # At full_path (guaranteed unique by DB) — must assign
                        result[node_id] = suf_lists[node_id][-1]
                        resolved_this_round.add(node_id)
                    else:
                        ptr[node_id] += 1

        unresolved -= resolved_this_round

    # Fallback for any remaining (should not occur given the max_rounds guarantee)
    for node_id in unresolved:
        result[node_id] = suf_lists[node_id][-1]

    # Exclude cases where the computed auto trigger equals the node's own custom
    # trigger (custom already provides coverage; inserting auto would hit UNIQUE)
    return {
        node_id: suf
        for node_id, suf in result.items()
        if suf not in own_customs.get(node_id, set())
    }


def trigger_name_conflict(text: str) -> Optional[str]:
    """Reason why `text` may NOT be used as a new custom trigger, or None if OK.

    A custom trigger must be globally unambiguous: it cannot equal any node's
    path, any entry's default (entry-only) auto name, or any existing trigger —
    otherwise `[text]` would be ambiguous or shadowed (#1).
    """
    nodes = _repo.get_tree()
    by_id = {n["id"]: n for n in nodes}
    for n in nodes:
        if n["full_path"] == text:
            return f"'{text}' is the path of an existing {'entry' if n['has_prompts'] else 'folder'}"
    for n in nodes:
        if n["has_prompts"] and _candidates(n, by_id) and _candidates(n, by_id)[0] == text:
            return f"'{text}' is already the default name of entry '{n['full_path']}'"
    for t in _repo.get_all_triggers():
        if t["trigger_text"] == text:
            return f"trigger '{text}' is already in use"
    return None


def prune_shadowed_triggers() -> List[Dict]:
    """Remove custom triggers that have become *shadowed* — i.e. whose text now
    equals a different node's full_path. resolve_trigger gives full_path priority,
    so such a trigger is dead. This can happen after a rename/move/create changes
    the set of full_paths. Returns a list describing what was removed (for warning):
        [{ "trigger_text", "owner", "shadowed_by" }, ...]
    """
    nodes = _repo.get_tree()
    fp_owner = {n["full_path"]: n["id"] for n in nodes}
    by_id = {n["id"]: n for n in nodes}
    removed: List[Dict] = []
    for t in _repo.get_all_triggers():
        if t["is_auto"]:
            continue
        owner_by_path = fp_owner.get(t["trigger_text"])
        if owner_by_path is not None and owner_by_path != t["node_id"]:
            try:
                _repo.enqueue_write(
                    _repo.HIGH, _repo.DeleteTriggerOp(trigger_id=t["id"]),
                ).result(timeout=5)
                removed.append({
                    "trigger_text": t["trigger_text"],
                    "owner": (by_id.get(t["node_id"]) or {}).get("full_path"),
                    "shadowed_by": (by_id.get(owner_by_path) or {}).get("full_path"),
                })
            except Exception:
                pass   # best-effort; keep pruning the rest
    return removed


def rebuild_auto_triggers() -> "concurrent.futures.Future":
    """Read current nodes + custom triggers from DB, compute new auto triggers,
    and enqueue a ReplaceAutoTriggersOp.

    Returns the Future from the enqueued write op so callers can await if needed.
    Call this after any node create / rename / delete / custom-trigger change.
    """
    # Read side — short-lived connections
    from .template import template_node_ids
    all_nodes = _repo.get_tree()
    tmpl_ids = template_node_ids(all_nodes)   # _template entries + their subtree (hidden, #11)
    entry_nodes = [n for n in all_nodes if n["has_prompts"] and n["id"] not in tmpl_ids]
    all_triggers = _repo.get_all_triggers()
    custom_triggers = [t for t in all_triggers if not t["is_auto"]]

    new_auto = compute_auto_triggers(entry_nodes, custom_triggers, all_nodes=all_nodes)

    return _repo.enqueue_write(
        _repo.HIGH,
        _repo.ReplaceAutoTriggersOp(new_auto=new_auto),
    )


# ---------------------------------------------------------------------------
# Trigger lookup (used by the text processing engine)
# ---------------------------------------------------------------------------

def resolve_trigger(text: str) -> Optional[Tuple[int, str]]:
    """Find the best-matching trigger for `text` and return (node_id, sub_path).

    `text` is the content inside [...] from the user's prompt template,
    e.g. 'toki', 'toki.name', 'ba.toki.appearance', 'character.ba.toki'.

    Resolution order (longest prefix wins):
    1. Exact full_path match (user typed the full dot path)
    2. Longest trigger prefix match, remaining becomes sub_path

    sub_path is a dot-joined suffix WITHOUT a leading dot, e.g. 'name'.
    The engine appends it to the resolved node's full_path:
        resolved.full_path + '.' + sub_path  →  target full_path

    Returns None if nothing matches.
    """
    from .template import template_node_ids
    all_triggers = _repo.get_all_triggers()
    all_nodes = _repo.get_tree()
    tmpl_ids = template_node_ids(all_nodes)   # _template subtree is not [ref]-able (#11)

    # Build lookup: text → node_id
    # Full paths have priority over trigger aliases in case of collision
    # (shouldn't occur, but full_path is definitive)
    lookup: Dict[str, int] = {}
    for t in all_triggers:
        if t["node_id"] in tmpl_ids:
            continue
        lookup[t["trigger_text"]] = t["node_id"]
    for n in all_nodes:
        if n["id"] in tmpl_ids:
            continue
        # Full path always overrides (direct reference beats trigger alias)
        lookup[n["full_path"]] = n["id"]

    # Try longest prefix first
    parts = text.split(".")
    for i in range(len(parts), 0, -1):
        prefix = ".".join(parts[:i])
        if prefix in lookup:
            sub_path = ".".join(parts[i:])  # empty string if exact match
            return lookup[prefix], sub_path

    return None
