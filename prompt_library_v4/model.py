"""Lossless document projection for both PLv4 editing views.

Offsets on the public boundary are UTF-16, as used by Monaco. Internal parser
offsets remain Python code points. TextRun is a view over adjacent items, never
an extra AST Group (which would change random paths and selection units).
"""
from __future__ import annotations

from copy import copy, deepcopy
from dataclasses import dataclass, field
from typing import Any

from ._v3 import ast_json, PLv3Error, Diagnostics, Document, DocNode, from_text, reconcile, render, Group, parse, validate


class CommandError(ValueError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def js_offset(source: str, offset: int) -> int:
    return len(source[:offset].encode("utf-16-le", errors="surrogatepass")) // 2


def python_offset(source: str, offset: int) -> int:
    if isinstance(offset, bool) or not isinstance(offset, int) or offset < 0:
        raise CommandError("invalid_span", "offset must be a non-negative UTF-16 integer")
    units = 0
    for index, char in enumerate(source):
        if units == offset:
            return index
        units += 2 if ord(char) > 0xFFFF else 1
        if units > offset:
            raise CommandError("invalid_span", "offset splits a Unicode surrogate pair")
    if units == offset:
        return len(source)
    raise CommandError("invalid_span", "offset is outside the source")


def js_ast(value: Any, source: str, key: str = "") -> Any:
    span_keys = {"span", "node", "content", "header", "set_block", "set_body",
                 "region_decl", "region_body", "value", "entry", "body"}
    if isinstance(value, dict):
        return {k: js_ast(v, source, k) for k, v in value.items()}
    if isinstance(value, list):
        if key in span_keys and len(value) == 2 and all(isinstance(v, int) for v in value):
            return [js_offset(source, v) for v in value]
        return [js_ast(v, source) for v in value]
    return value


def diagnostics(source: str) -> tuple[Group, list[dict]]:
    root, diags = parse(source, recover=True)
    try:
        validate(root, diags, src=source)
    except PLv3Error as exc:
        diags.items.append(exc.diag)
    return root, [dict(code=d.code, message=d.message, pos=js_offset(source, d.pos),
                       severity="error" if d.is_error else "warning") for d in diags]


def full_document(doc: Document) -> Document:
    full = deepcopy(doc)
    full.draft = None
    for node in full.root.walk():
        node.enabled = True
    return full


def pair_tree(doc_node: DocNode, ast_node: Any, out: dict, *, visible: bool = False):
    out[doc_node.id] = ast_node
    if doc_node.kind != "group" or doc_node.opaque:
        return
    children = [c for c in doc_node.children if c.enabled or not visible]
    ast_children = list(getattr(ast_node, "children", []))
    if len(children) != len(ast_children):
        raise CommandError("shape_mismatch", "document children do not match the PLv3 parse")
    for child, parsed in zip(children, ast_children):
        if child.kind != ast_json(parsed)["kind"]:
            raise CommandError("shape_mismatch", "document item kind does not match the PLv3 parse")
        pair_tree(child, parsed, out, visible=visible)


def full_index(doc: Document) -> tuple[str, dict]:
    source = render(full_document(doc))
    root, _ = parse(source)
    result = {}
    pair_tree(doc.root, root, result)
    return source, result


def normalise_metadata(doc: Document):
    from .lora_block import normalise
    normalise(doc)
    for node in doc.root.walk():
        if node.form in ('schedule', 'region', 'avg'):
            node.meta.pop('pool', None)


def refresh_document(doc: Document) -> Document:
    """Re-slice after a command, retaining identity, metadata and every switch."""
    source, complete = full_index(doc)
    # A moved/inserted disabled region must not hide an illegal nested region
    # that only becomes apparent when switched on later.
    validate(complete[doc.root.id], Diagnostics(), src=source)
    fresh = from_text(source, recover=False)

    def transfer(old, new):
        new.id, new.enabled, new.meta = old.id, old.enabled, deepcopy(old.meta)
        if len(old.children) != len(new.children):
            raise CommandError("shape_mismatch", "command changed unowned document structure")
        for a, b in zip(old.children, new.children):
            transfer(a, b)
    transfer(doc.root, fresh.root)
    fresh.next_id = doc.next_id
    normalise_metadata(fresh)
    return fresh


@dataclass
class EditorState:
    doc: Document
    revision: int = 0
    selection: dict = field(default_factory=dict)
    scope: str = "document"  # Library block editing has exactly one root Group.

    @property
    def text(self) -> str:
        return render(self.doc)

    @property
    def valid(self) -> bool:
        return self.doc.draft is None

    def to_json(self) -> dict:
        return dict(doc=self.doc.to_json(), text=self.text, revision=self.revision,
                    selection=deepcopy(self.selection), scope=self.scope, valid=self.valid)

    @classmethod
    def create(cls, text: str | None = None, doc: dict | None = None, scope: str = "document"):
        if scope not in ("document", "block"):
            raise CommandError("invalid_scope", "unknown editing scope")
        state = cls(Document.from_json(doc) if doc else from_text("", recover=False), scope=scope)
        # With a supplied snapshot the document wins unless text was explicitly supplied.
        state.replace_text(state.text if text is None else text)
        return state

    @classmethod
    def from_json(cls, value: dict):
        state = cls(Document.from_json(value["doc"]), int(value["revision"]),
                    deepcopy(value.get("selection", {})), value.get("scope", "document"))
        if state.revision < 0 or state.scope not in ("document", "block"):
            raise CommandError("invalid_state", "invalid revision or editing scope")
        ids = [n.id for n in state.doc.root.walk()]
        if len(ids) != len(set(ids)):
            raise CommandError("invalid_state", "document IDs must be unique")
        state.doc.next_id = max(state.doc.next_id, 1 + max(
            (int(i[1:]) for i in ids if i.startswith("i") and i[1:].isdigit()), default=0))
        if "text" in value and state.text != value["text"]:
            raise CommandError("invalid_state", "text differs from the document projection")
        normalise_metadata(state.doc)
        if state.valid:
            state.check()
        return state

    def replace_text(self, text: str):
        if not isinstance(text, str):
            raise CommandError("invalid_text", "source must be a string")
        _, diags = diagnostics(text)
        if any(d["severity"] == "error" for d in diags):
            self.doc.draft = text
            return
        previous = deepcopy(self.doc)
        previous.draft = None
        merged = reconcile(previous, text, recover=False)
        # A library draft with extra roots is kept verbatim, never silently sliced.
        if self.scope == "block" and not self.single_root(merged):
            self.doc.draft = text
            return
        if render(merged) != text:
            raise CommandError("roundtrip_mismatch", "reconciliation changed the original source")
        self.doc = merged
        normalise_metadata(self.doc)

    @staticmethod
    def single_root(doc: Document) -> bool:
        # Disabled sibling roots still count: a Library block is one complete tree.
        children = doc.root.children
        return len(children) == 1 and children[0].kind == "group" and children[0].form != "paren"

    def check(self):
        if not self.valid:
            raise CommandError("invalid_draft", "repair the raw draft before structural editing")
        root, diags = parse(self.text)
        validate(root, diags, src=self.text)
        pair_tree(self.doc.root, root, {}, visible=True)
        if self.scope == "block" and not self.single_root(self.doc):
            raise CommandError("single_root", "a Library block must retain exactly one root block")


def projection(state: EditorState) -> dict:
    """Full ordered tree, visible UTF-16 spans, TextRuns, and a recoverable draft."""
    text = state.text
    recovered, diags = diagnostics(text)
    if not state.valid:
        if state.scope == "block" and not any(d["severity"] == "error" for d in diags):
            diags.append(dict(code="single_root", severity="error", pos=0,
                              message="a Library block must retain exactly one root block"))
        return dict(valid=False, revision=state.revision, raw=text,
                    ast=js_ast(ast_json(recovered), text), tree=None, diagnostics=diags)
    _, complete = full_index(state.doc)
    visible = {}
    pair_tree(state.doc.root, recovered, visible, visible=True)

    def visit(node, parent=None, active=True):
        effective = active and node.enabled
        ast = complete[node.id]
        current = visible.get(node.id) if effective else None
        info = ast_json(ast)
        span = None
        if current is not None:
            start, end = current.pos, current.end
            if isinstance(current, Group):
                if current.spans.region_decl:
                    start = min(start, current.spans.region_decl[0])
                if current.spans.schedule_form == "block":
                    start = min(start, current.spans.fields["schedule"]["value"][0])
                if current.spans.avg_form == 'block':
                    start = min(start, current.spans.fields['avg_weight']['value'][0])
            span = [js_offset(text, start), js_offset(text, end)]
        out = dict(id=node.id, parent_id=parent, kind=node.kind, form=node.form,
                   enabled=node.enabled, effective=effective, span=span,
                   meta=deepcopy(node.meta), source=render(full_document(Document(node))),
                   settings=info.get("settings"), implicit=info.get("implicit", False))
        if current is not None:
            # Root carries the complete AST once for the shared PromptEditor.
            # Per-row ASTs only need their own fields/spans, not another copy
            # of every descendant (quadratic payloads for deep documents).
            row_ast = current
            if parent is not None and isinstance(current, Group):
                row_ast = copy(current)
                row_ast.children = []
            out["ast"] = js_ast(ast_json(row_ast), text)
        children = [visit(c, node.id, effective) for c in node.children]
        out["children"] = children
        runs = []
        for child in children:
            if child["kind"] == "group" and child["form"] != "paren":
                runs.append(dict(kind="block", id=child["id"]))
            else:
                if not runs or runs[-1]["kind"] != "text_run":
                    runs.append(dict(kind="text_run", ids=[]))
                runs[-1]["ids"].append(child["id"])
        out["runs"] = runs
        return out
    return dict(valid=True, revision=state.revision, tree=visit(state.doc.root), diagnostics=diags)


def text_edit(before: str, after: str) -> dict:
    head, tail = 0, 0
    limit = min(len(before), len(after))
    while head < limit and before[head] == after[head]:
        head += 1
    while tail < limit - head and before[-1-tail] == after[-1-tail]:
        tail += 1
    return dict(span=[js_offset(before, head), js_offset(before, len(before)-tail)],
                insert=after[head:len(after)-tail])
