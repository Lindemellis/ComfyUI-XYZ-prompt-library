"""PLv3 AST -> JSON, for the detail page (spec §8.3).

Every node carries its source span, because the detail page edits by *rewriting
the few characters a control owns* rather than regenerating the document.  That
is what keeps the user's layout — blank lines, indentation, comment-ish spacing —
intact across an edit, and it is why PLv2's whole content-keyed reconciliation
(normalise, dedupe, sep_after) has no counterpart here: a span is already a
unique, unambiguous handle.
"""
from __future__ import annotations

from .parser import Group, Item, Lora, Node, Region, Settings, Spans, Text


def _span(s) -> list[int] | None:
    return None if s is None else [int(s[0]), int(s[1])]


def _fields(d: dict) -> dict:
    return {
        k: {kk: _span(vv) for kk, vv in v.items() if kk in ("value", "entry", "body")}
        for k, v in (d or {}).items()
    }


def _region(r: Region | None) -> dict | None:
    if r is None:
        return None
    return {
        "kind": r.kind,
        "mask": list(r.mask) if r.mask else None,
        "imask": r.imask,
        "feather": r.feather,
        "mask_weight": r.mask_weight,
        "cond_weight": r.cond_weight,
        "include_in_base": r.include_in_base,
    }


def _settings(s: Settings) -> dict:
    return {
        "weight": s.weight,
        "format": s.format,
        "shuffle": s.shuffle,
        "random_select": list(s.random_select) if s.random_select else None,
        "dropout": s.dropout,
        "seed": s.seed,
        "schedule": list(s.schedule) if s.schedule else None,
        "region": _region(s.region),
    }


def _spans(s: Spans) -> dict:
    return {
        "node": _span(s.node),
        "content": _span(s.content),
        "header": _span(s.header),
        "set_block": _span(s.set_block),
        "set_body": _span(s.set_body),
        "fields": _fields(s.fields),
        "region_decl": _span(s.region_decl),
        "region_body": _span(s.region_body),
        "region_fields": _fields(s.region_fields),
        "region_form": s.region_form,
        "schedule_form": s.schedule_form,
    }


def to_json(node: Node) -> dict:
    if isinstance(node, Text):
        return {"kind": "text", "text": node.text.strip(), "span": [node.pos, node.end]}

    if isinstance(node, Lora):
        return {"kind": "lora", "text": node.text, "span": [node.pos, node.end]}

    if isinstance(node, Item):
        return {
            "kind": "item",
            "span": [node.pos, node.end],
            "children": [to_json(a) for a in node.atoms],
        }

    if isinstance(node, Group):
        return {
            "kind": "group",
            "span": [node.pos, node.end],
            "path": list(node.path),
            "header": node.header,
            "paren": node.paren,
            # No braces in the text: the group is the parser's, not the user's.
            "implicit": node.implicit,
            "settings": _settings(node.settings),
            "spans": _spans(node.spans),
            "children": [to_json(c) for c in node.children],
        }

    raise TypeError(f"unknown node {node!r}")  # pragma: no cover
