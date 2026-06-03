"""Prompt Library V2 — folder-template inheritance.

A template is a folder's child entry literally named ``_template`` (one per folder,
always positive). Entries inherit the template's PROMPTS (this affects generation)
and — for the UI only — its sub-entries.

Two inheritance rules, unified in ``template_for``:

  * base entry  (parent is a folder) → climb ancestor folders, take the nearest
    folder that has a ``_template`` child.
  * sub-entry   (parent is an entry) → structural: if the parent's own template
    has a same-named child, that child is this node's template. This makes
    same-named sub-entries (manual or "override") inherit automatically, and
    recurses to any depth.

``effective_prompts`` flattens the chain with a cascade of per-entry overrides
(nearest wins) and dedupes by content (own / nearer template wins).
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from . import repo as _repo

TEMPLATE_NAME = "_template"

# Inherited prompts with no per-entry position sort after the entry's own prompts.
_UNPOSITIONED = 1_000_000


def is_template_node(node: Dict[str, Any]) -> bool:
    return bool(node.get("has_prompts")) and node.get("name") == TEMPLATE_NAME


# ---------------------------------------------------------------------------
# Tree context
# ---------------------------------------------------------------------------

class _Ctx:
    """Prebuilt lookups over the whole node tree (one DB read per resolution)."""
    __slots__ = ("by_id", "tmpl_by_parent", "children_by_parent", "_ov_cache")

    def __init__(self, nodes: List[Dict[str, Any]]):
        self.by_id: Dict[int, Dict[str, Any]] = {}
        self.tmpl_by_parent: Dict[int, Dict[str, Any]] = {}
        self.children_by_parent: Dict[Optional[int], List[Dict[str, Any]]] = {}
        self._ov_cache: Dict[int, Dict[int, Dict[str, Any]]] = {}
        for n in nodes:
            self.by_id[n["id"]] = n
            pid = n.get("parent_id")
            self.children_by_parent.setdefault(pid, []).append(n)
            if pid is not None and is_template_node(n):
                self.tmpl_by_parent[pid] = n

    def overrides(self, node_id: int) -> Dict[int, Dict[str, Any]]:
        if node_id not in self._ov_cache:
            self._ov_cache[node_id] = _repo.get_prompt_overrides(node_id)
        return self._ov_cache[node_id]


def _build_ctx() -> _Ctx:
    return _Ctx(_repo.get_tree())


# ---------------------------------------------------------------------------
# Template resolution
# ---------------------------------------------------------------------------

def _nearest_template_climb(node: Dict[str, Any], ctx: _Ctx) -> Optional[Dict[str, Any]]:
    """Nearest ancestor folder's _template, climbing from `node`'s folder upward.
    If `node` IS a template, skip its own folder (a template can't inherit itself)."""
    if is_template_node(node):
        folder = ctx.by_id.get(node.get("parent_id"))
        cur = ctx.by_id.get(folder.get("parent_id")) if folder else None
    else:
        cur = ctx.by_id.get(node.get("parent_id"))
    while cur is not None:
        t = ctx.tmpl_by_parent.get(cur["id"])
        if t is not None and t["id"] != node["id"]:
            return t
        pid = cur.get("parent_id")
        cur = ctx.by_id.get(pid) if pid is not None else None
    return None


def template_for(node: Dict[str, Any], ctx: _Ctx, _seen: frozenset = frozenset()) -> Optional[Dict[str, Any]]:
    """The template entry `node` inherits from, or None."""
    if node["id"] in _seen:
        return None
    # Templates are always positive; negative entries never inherit (point 2).
    if node.get("pos_neg") == "negative":
        return None
    parent = ctx.by_id.get(node.get("parent_id")) if node.get("parent_id") is not None else None
    if parent is None:
        return None
    if not parent.get("has_prompts"):
        # parent is a folder → base-entry folder-climb rule
        return _nearest_template_climb(node, ctx)
    # parent is an entry → structural same-name rule
    tp = template_for(parent, ctx, _seen | {node["id"]})
    if tp is None:
        return None
    for c in ctx.children_by_parent.get(tp["id"], []):
        if c.get("has_prompts") and c["name"] == node["name"]:
            return c
    return None


def _collect(node_id: int, ctx: _Ctx, _seen: frozenset = frozenset()) -> List[Dict[str, Any]]:
    """Ordered prompt items for `node_id`: own first, then inherited (with this
    node's overrides cascaded onto every inherited item). No dedup yet."""
    if node_id in _seen:
        return []
    seen2 = _seen | {node_id}
    node = ctx.by_id.get(node_id)
    if node is None:
        return []

    items: List[Dict[str, Any]] = []
    for p in _repo.get_prompts(node_id):
        items.append({
            "id": p["id"],
            "content": p["content"],
            "weight": float(p["weight"]),
            "enabled": bool(p["enabled"]),
            "order_index": p["order_index"],
            "sep_after": int(p["sep_after"] or 0),
            "is_inherited": False,
            "origin_id": node_id,
            "origin_full_path": node.get("full_path") if node else None,
        })

    tmpl = template_for(node, ctx)   # template_for has its own parent-chain guard
    if tmpl is not None:
        ov = ctx.overrides(node_id)
        for seq, it in enumerate(_collect(tmpl["id"], ctx, seen2)):
            o = ov.get(it["id"])
            enabled = it["enabled"]
            weight = it["weight"]
            sep_after = it["sep_after"]
            # Position on the OWNER's scale: this entry's override order if set,
            # else after the owner's own prompts (UNPOSITIONED + template order).
            order = _UNPOSITIONED + seq
            if o is not None:
                if o.get("enabled") is not None:
                    enabled = bool(o["enabled"])
                if o.get("weight") is not None:
                    weight = float(o["weight"])
                if o.get("order_index") is not None:
                    order = int(o["order_index"])
                if o.get("sep_after") is not None:
                    sep_after = int(o["sep_after"])
            items.append({**it, "enabled": enabled, "weight": weight,
                          "order_index": order, "sep_after": sep_after, "is_inherited": True})
    return items


def effective_prompts(node_id: int, ctx: Optional[_Ctx] = None) -> List[Dict[str, Any]]:
    """Full ordered prompt list for an entry: own + inherited (cascaded overrides),
    deduped by content (own / nearer template wins). Each item:
        {id, content, weight, enabled, order_index, sep_after, is_inherited, origin_id}
    """
    ctx = ctx or _build_ctx()
    out: List[Dict[str, Any]] = []
    seen_content = set()
    for it in _collect(node_id, ctx):
        key = it["content"].strip()
        if key in seen_content:
            continue
        seen_content.add(key)
        out.append(it)
    return out


def effective_enabled_prompts(node_id: int) -> List[Dict[str, Any]]:
    """Enabled effective prompts in generation order — own + inherited interleaved
    by their unified order_index (the entry text box position)."""
    items = [it for it in effective_prompts(node_id) if it["enabled"]]
    items.sort(key=lambda it: it["order_index"] if it["order_index"] is not None else _UNPOSITIONED)
    return items


def inherited_prompts(node_id: int, ctx: Optional[_Ctx] = None) -> List[Dict[str, Any]]:
    """Only the inherited (template) items of an entry, after own-content dedup."""
    return [it for it in effective_prompts(node_id, ctx) if it["is_inherited"]]


def resolve_inherited_target(base_id: int, sub_path: str, ctx: Optional[_Ctx] = None) -> Optional[int]:
    """Navigate `sub_path` under `base_id`, preferring own children but falling back
    to the entry's template's same-named child at each step. Returns the target node
    id (which may live under a `_template`) or None. Lets `[entry.sub]` reach an
    inherited template sub-entry that has no local override (#1)."""
    ctx = ctx or _build_ctx()
    node = ctx.by_id.get(base_id)
    if node is None or not sub_path:
        return None
    for seg in sub_path.split("."):
        nxt = next((c for c in ctx.children_by_parent.get(node["id"], [])
                    if c.get("has_prompts") and c["name"] == seg), None)
        if nxt is None:
            t = template_for(node, ctx)
            if t is None:
                return None
            nxt = next((c for c in ctx.children_by_parent.get(t["id"], [])
                        if c.get("has_prompts") and c["name"] == seg), None)
        if nxt is None:
            return None
        node = nxt
    return node["id"]


def template_children(node_id: int, ctx: Optional[_Ctx] = None) -> List[Dict[str, Any]]:
    """Direct child sub-entries of the entry's template (for the sub-entry panel).
    Empty when the entry inherits no template."""
    ctx = ctx or _build_ctx()
    node = ctx.by_id.get(node_id)
    if node is None:
        return []
    tmpl = template_for(node, ctx)
    if tmpl is None:
        return []
    return [c for c in ctx.children_by_parent.get(tmpl["id"], []) if c.get("has_prompts")]


def template_node_ids(nodes: List[Dict[str, Any]]) -> set:
    """Set of node ids that are a _template entry OR live under one (to hide them
    from triggers / ref resolution / listings). Given a full node list."""
    by_id = {n["id"]: n for n in nodes}
    out: set = set()
    for n in nodes:
        cur: Optional[Dict[str, Any]] = n
        while cur is not None:
            if is_template_node(cur):
                out.add(n["id"])
                break
            pid = cur.get("parent_id")
            cur = by_id.get(pid) if pid is not None else None
    return out


def is_template_path(node_id: int, ctx: Optional[_Ctx] = None) -> bool:
    """True if node_id is a _template entry or lives under one (used to hide it)."""
    ctx = ctx or _build_ctx()
    cur = ctx.by_id.get(node_id)
    while cur is not None:
        if is_template_node(cur):
            return True
        pid = cur.get("parent_id")
        cur = ctx.by_id.get(pid) if pid is not None else None
    return False
