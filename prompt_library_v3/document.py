"""PLv3 document — the structured source of truth (supersedes spec §5.2).

Until now the *text* was the truth: an item was enabled iff it appeared in the
text, so turning one off meant deleting it, and turning it back on meant deciding
where to put it again (the library block's disabled strip, sorted, at the bottom).
That is why a toggle moved things around.

A **document** is that same tree with two things added to every node: a stable
`id`, and an `enabled` flag.  The text is no longer the truth — it is what you
get when you render the document's *enabled* nodes.  Switching an item off simply
stops rendering it; the document still holds its content and its position, so
switching it back on puts it back exactly where it was, and nothing else moves.

Round-trip fidelity is the property everything else rests on:

    render(from_text(t)) == t        for any t that parses

so a document that nobody has toggled is byte-for-byte the text the user typed —
no pretty-printer, no reflowed layout.  That works because every node keeps its
own slice of the source verbatim, plus `sep`, the separator that FOLLOWS it:

    { masterpiece, worst quality, 1girl }
      ^^^^^^^^^^^ raw
                 ^^ sep

Dropping a node drops its `raw` *and* its `sep`, which is what keeps the commas
right at either end — dropping the first item with a leading-separator model
would leave the text starting with a comma.

Editing the text is the hard direction (the text only ever shows the enabled
nodes, so a re-parse cannot see the disabled ones).  `reconcile` re-aligns a
freshly parsed tree with the previous document, carries the ids across, and puts
the disabled nodes back at the index they were remembered at.  See its docstring
for the matching rules and why they fail open.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterator

from .parser import Group, Item, Lora, Text, parse

DOC_VERSION = 1

#: Node kinds, mirroring the AST.  A `group` is the only one with children.
LEAF_KINDS = ("text", "lora", "item")


@dataclass
class DocNode:
    """One node of the document.

    `raw` is always the node's verbatim source slice, so a node can be rendered
    (or re-rendered after being switched back on) without regenerating anything.
    A group additionally splits that slice into `open` / `lead` / children /
    `close` so its children can be dropped individually.
    """

    id: str
    kind: str
    raw: str
    sep: str = ""
    enabled: bool = True
    # group only — `opaque` groups (no content span: an implicit group, a broken
    # construct recovered by the parser) keep `raw` and are never taken apart.
    opaque: bool = True
    open: str = ""
    lead: str = ""
    close: str = ""
    children: list["DocNode"] = field(default_factory=list)
    # Carried through for the frontend: it needs to know a library block from a
    # region segment without re-parsing.
    header: str | None = None

    # --- serialisation ------------------------------------------------------

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "id": self.id,
            "kind": self.kind,
            "raw": self.raw,
            "sep": self.sep,
            "enabled": self.enabled,
        }
        if self.header is not None:
            out["header"] = self.header
        if self.kind == "group":
            out["opaque"] = self.opaque
            if not self.opaque:
                out["open"] = self.open
                out["lead"] = self.lead
                out["close"] = self.close
                out["children"] = [c.to_json() for c in self.children]
        return out

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "DocNode":
        node = cls(
            id=str(data["id"]),
            kind=str(data["kind"]),
            raw=str(data.get("raw", "")),
            sep=str(data.get("sep", "")),
            enabled=bool(data.get("enabled", True)),
            opaque=bool(data.get("opaque", True)),
            open=str(data.get("open", "")),
            lead=str(data.get("lead", "")),
            close=str(data.get("close", "")),
            header=data.get("header"),
        )
        node.children = [cls.from_json(c) for c in data.get("children", [])]
        return node

    # --- tree ---------------------------------------------------------------

    def walk(self) -> Iterator["DocNode"]:
        yield self
        for child in self.children:
            yield from child.walk()


@dataclass
class Document:
    """A whole PLv3 document.  The root is a group without braces."""

    root: DocNode
    next_id: int = 1
    version: int = DOC_VERSION

    def to_json(self) -> dict[str, Any]:
        return {"version": self.version, "next_id": self.next_id, "root": self.root.to_json()}

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "Document":
        return cls(
            root=DocNode.from_json(data["root"]),
            next_id=int(data.get("next_id", 1)),
            version=int(data.get("version", DOC_VERSION)),
        )

    def find(self, node_id: str) -> DocNode | None:
        for node in self.root.walk():
            if node.id == node_id:
                return node
        return None

    def set_enabled(self, node_id: str, enabled: bool) -> bool:
        """Switch one node on or off.  Returns False when the id is unknown."""
        node = self.find(node_id)
        if node is None:
            return False
        node.enabled = bool(enabled)
        return True


# --- text -> document -------------------------------------------------------


def _kind_of(node: Any) -> str:
    if isinstance(node, Group):
        return "group"
    if isinstance(node, Lora):
        return "lora"
    if isinstance(node, Item):
        return "item"
    return "text"


def _bounds(node: Any) -> tuple[int, int]:
    return int(getattr(node, "pos", 0)), int(getattr(node, "end", 0))


class _Builder:
    def __init__(self, src: str) -> None:
        self.src = src
        self.counter = 0

    def new_id(self) -> str:
        self.counter += 1
        return f"i{self.counter}"

    def build(self, node: Any, sep: str = "") -> DocNode:
        pos, end = _bounds(node)
        kind = _kind_of(node)
        doc = DocNode(
            id=self.new_id(),
            kind=kind,
            raw=self.src[pos:end],
            sep=sep,
            header=getattr(node, "header", None) if kind == "group" else None,
        )
        if kind != "group":
            return doc

        content = getattr(node.spans, "content", None)
        # No content span: an implicit group (`0.3 - 1: open eyes` has no braces of
        # its own) or something the recovering parser patched up. Keep it whole —
        # there is no interior we could safely cut children out of.
        if content is None or not node.children:
            doc.opaque = not node.children
            if doc.opaque:
                return doc
            content = (pos, end)

        c_start, c_end = content
        doc.opaque = False
        doc.open = self.src[pos:c_start]
        doc.close = self.src[c_end:end]

        kids = list(node.children)
        # A child's slice must start at its HEAD, not at `spans.node`. A region
        # segment's `base` / `[imask: 0]:` lives at `spans.region_decl`, which sits
        # BEFORE the node, and a schedule entry's `0 - 0.3:` has no span recorded at
        # all — both would be left behind by a slice that started at `node.pos`, and
        # the next segment would silently inherit them (red dress's mask ending up
        # on blue dress). Everything from the previous sibling's separator up to the
        # first non-blank character belongs to this child.
        bounds = []
        cursor = c_start
        for child in kids:
            child_pos, child_end = _bounds(child)
            # The gap is `[blank] , [blank] head`. Everything up to and including the
            # separating comma is the PREVIOUS child's; the head is what follows it.
            # The first comma in the gap is always the separator: the part before it
            # can only be blank, since the gap starts where the previous node ended.
            gap = self.src[cursor:child_pos]
            after_comma = gap.find(",") + 1  # 0 when there is none (the first child)
            rest = gap[after_comma:]
            head_start = cursor + after_comma + (len(rest) - len(rest.lstrip()))
            bounds.append((head_start, child_end))
            cursor = child_end

        doc.lead = self.src[c_start : bounds[0][0]]
        for index, child in enumerate(kids):
            head_start, child_end = bounds[index]
            next_head = bounds[index + 1][0] if index + 1 < len(kids) else c_end
            built = self.build(child, self.src[child_end:next_head])
            head = self.src[head_start : _bounds(child)[0]]
            if head:
                built.raw = head + built.raw
                # A group renders from open/lead/children/close, never from `raw`,
                # so the head has to go on the front of `open` as well or an enabled
                # region segment would lose its `[imask: 0]:` on the way back out.
                if built.kind == "group" and not built.opaque:
                    built.open = head + built.open
            doc.children.append(built)
        return doc


def from_ast(src: str, root: Group) -> Document:
    builder = _Builder(src)
    doc_root = builder.build(root)
    # The root is the document itself: it is never switched off and has no
    # separator of its own.
    doc_root.sep = ""
    doc_root.enabled = True
    return Document(root=doc_root, next_id=builder.counter + 1)


def from_text(src: str, recover: bool = True) -> Document:
    """Parse `src` and wrap it as a document with every node enabled."""
    root, _ = parse(src or "", recover=recover)
    return from_ast(src or "", root)


# --- document -> text -------------------------------------------------------


def render(doc: Document | DocNode) -> str:
    """The text: the document's ENABLED nodes, verbatim.

    A disabled node contributes nothing at all — not a marker, not a blank line —
    which is the whole point: the text never shows that it is there.
    """
    root = doc.root if isinstance(doc, Document) else doc
    return _render_node(root, top=True)


def _top_level_comma(text: str) -> bool:
    """A comma outside any bracket — the thing that separates two items."""
    depth = 0
    for ch in text:
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth = max(0, depth - 1)
        elif ch == "," and depth == 0:
            return True
    return False


def _render_node(node: DocNode, top: bool = False) -> str:
    if not node.enabled and not top:
        return ""
    if node.kind != "group" or node.opaque:
        return node.raw

    on = [c for c in node.children if c.enabled]
    last = on[-1] if on else None
    bodies = [_render_node(c) for c in on]
    parts = []
    for index, child in enumerate(on):
        body = bodies[index]
        following = bodies[index + 1] if index + 1 < len(bodies) else ""
        # A node keeps the separator that followed it when it was parsed. A node that
        # was LAST back then has no comma in it — and if something later lands behind
        # it (a parked neighbour switched back on), the two would run together into a
        # single item: `a, b` + `c` renders as `a, bc`.
        #
        # A comma is only *needed* between two things the parser would otherwise read
        # as one item. A BRACE group always stands alone — `a { b }`, `{ a } b` and
        # `{ x }\n{ y }` all split without a comma, which is how a region block
        # separates its segments (it has no commas at all), so injecting one there
        # would rewrite the user's layout on every render. Parentheses and loras do
        # NOT: `a (b:1.2)` is a single item made of two atoms.
        sep = child.sep
        if (
            child is not last
            and not _top_level_comma(sep)
            and not body.rstrip().endswith("}")
            and following.lstrip()[:1] not in ("{", "[")
        ):
            sep = f"{sep.rstrip()}, " if sep.strip() else ", "
        parts.append(body + sep)
    return f"{node.open}{node.lead}{''.join(parts)}{node.close}"


# --- text edits -------------------------------------------------------------


def reconcile(doc: Document, new_text: str, recover: bool = True) -> Document:
    """Fold a hand-edited text back into the document.

    The text only ever showed the enabled nodes, so a fresh parse of it cannot see
    the disabled ones — they have to be carried over from `doc` and put back at the
    index they were remembered at.  Matching a new node to an old one is done per
    parent, in three passes of decreasing confidence:

      1. same kind AND identical source  -> certainly the same node, keep its id
      2. same kind, same ordinal among the still-unmatched -> edited in place
      3. anything left over               -> a new node, new id

    Unmatched OLD enabled nodes are simply gone: the user deleted them.  Old
    DISABLED nodes are re-inserted at their stored index, clamped to the new
    length — their neighbours may have moved, and a disabled node has no anchor in
    the text by construction.

    It **fails open**: when a disabled node's parent can no longer be found, the
    node is dropped rather than resurrected somewhere arbitrary. Losing an
    invisible off-switch is recoverable (the item is simply gone, like the text
    says); silently re-inserting content into someone's prompt is not.
    """
    fresh = from_text(new_text, recover=recover)
    counter = _Counter(max(doc.next_id, _max_id(doc.root) + 1))
    merged = _merge(doc.root, fresh.root, counter)
    merged.sep = ""
    merged.enabled = True
    return Document(root=merged, next_id=counter.value)


class _Counter:
    def __init__(self, start: int) -> None:
        self.value = start

    def take(self) -> str:
        node_id = f"i{self.value}"
        self.value += 1
        return node_id


def _max_id(node: DocNode) -> int:
    best = 0
    for child in node.walk():
        if child.id.startswith("i") and child.id[1:].isdigit():
            best = max(best, int(child.id[1:]))
    return best


def _merge(old: DocNode, new: DocNode, counter: _Counter) -> DocNode:
    """`new` is freshly parsed (all enabled, fresh ids); `old` holds ids + state."""
    new.id = old.id
    new.enabled = True  # it is in the text, so it is on
    if new.kind != "group" or new.opaque or old.kind != "group" or old.opaque:
        return new

    old_enabled = [c for c in old.children if c.enabled]
    disabled = [(i, c) for i, c in enumerate(old.children) if not c.enabled]

    matched: dict[int, DocNode] = {}
    used: set[int] = set()

    # Pass 1 — identical source.
    by_raw: dict[tuple[str, str], list[int]] = {}
    for i, child in enumerate(old_enabled):
        by_raw.setdefault((child.kind, child.raw), []).append(i)
    for j, child in enumerate(new.children):
        bucket = by_raw.get((child.kind, child.raw))
        while bucket:
            i = bucket.pop(0)
            if i not in used:
                matched[j] = old_enabled[i]
                used.add(i)
                break

    # Pass 2 — same ordinal among what is left: an item whose text was edited.
    leftovers = [i for i in range(len(old_enabled)) if i not in used]
    for j, child in enumerate(new.children):
        if j in matched or not leftovers:
            continue
        for pos, i in enumerate(leftovers):
            if old_enabled[i].kind == child.kind:
                matched[j] = old_enabled[i]
                used.add(i)
                leftovers.pop(pos)
                break

    children: list[DocNode] = []
    for j, child in enumerate(new.children):
        old_child = matched.get(j)
        if old_child is None:
            child.id = counter.take()
            _renumber(child, counter)
            children.append(child)
        else:
            children.append(_merge(old_child, child, counter))

    # Pass 3 — the disabled nodes, back at the index they were remembered at.
    for index, node in disabled:
        children.insert(min(index, len(children)), node)

    new.children = children
    return new


def _renumber(node: DocNode, counter: _Counter) -> None:
    for child in node.children:
        child.id = counter.take()
        _renumber(child, counter)


# --- compiling --------------------------------------------------------------


def toggle_edit(doc: Document, node_id: str, enabled: bool) -> dict[str, Any] | None:
    """Flip one node and describe the change as a single text edit.

    The detail page already owns a span-edit pipeline (version stamps, rebasing,
    Monaco's undo stack); a toggle goes through it as one more `{span, text}` rather
    than replacing the whole document and throwing the user's cursor away.

    The span is derived by DIFFING the render before and after, so it can never
    disagree with what `render` actually produces — exactly one contiguous run of
    characters changes, which is the definition of switching one node.

    Returns None when the id is unknown.
    """
    node = doc.find(node_id)
    if node is None:
        return None

    before = render(doc)
    node.enabled = bool(enabled)
    after = render(doc)

    head = 0
    limit = min(len(before), len(after))
    while head < limit and before[head] == after[head]:
        head += 1
    tail = 0
    while tail < limit - head and before[len(before) - 1 - tail] == after[len(after) - 1 - tail]:
        tail += 1

    return {
        "doc": doc.to_json(),
        "text": after,
        "span": [head, len(before) - tail],
        "insert": after[head : len(after) - tail],
    }


def compile_source(doc: Document) -> str:
    """What the node compiles: the rendered text.

    Nothing downstream has to learn about documents — a disabled node is simply
    not in the text that reaches the lexer, exactly as if the user had deleted it.
    """
    return render(doc)
