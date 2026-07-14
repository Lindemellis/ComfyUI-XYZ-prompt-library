"""PLv3 parser — token stream -> AST (spec §3).

The AST has four node kinds:

    Text    one plain prompt item ("blonde hair")
    Lora    <lora:name:1.0>
    Item    several atoms juxtaposed inside one comma-item ("foo (bar:1.2) baz")
    Group   { ... } with a Settings block

`[@schedule]` and `[@region]` are pure sugar: they are desugared here into plain
Groups carrying `.set{schedule}` / `.set{region}`, so nothing downstream ever
sees a special group (spec §3.4, §3.5).

A library reference block `[path.to.group]: { ... }` becomes a Group with
`header="path.to.group"` — the identity is kept for the detail page, but the
compiler treats the block as an ordinary group (spec §3.6, §4.7: compilation
never reads the library).
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Union

from . import lexer as lx
from .diagnostics import (
    E03,
    W01,
    W02,
    W03,
    W04,
    W07,
    W08,
    W10,
    W14,
    Diagnostics,
    PLv3Error,
)

MAX_DEPTH = 64

# --- AST --------------------------------------------------------------------

Node = Union["Text", "Lora", "Item", "Group"]


Span = tuple[int, int]


@dataclass
class Text:
    """A plain prompt item.  `text` keeps its edge whitespace (see lexer.text_out)."""

    text: str
    pos: int = 0
    end: int = 0


@dataclass
class Lora:
    text: str
    pos: int = 0
    end: int = 0


@dataclass
class Item:
    """Several atoms with no comma between them: `foo (bar:1.2) baz`."""

    atoms: list[Node]
    pos: int = 0
    end: int = 0


@dataclass
class Region:
    kind: str = "base"  # base | fill | mask | imask
    mask: tuple[float, float, float, float] | None = None
    imask: int | None = None
    feather: int = 0
    region_weight: float = 1.0
    include_in_base: bool = False

    def key(self) -> tuple:
        """Regions with equal keys are merged into one segment (spec §4.3)."""
        if self.kind == "mask":
            return ("mask",) + tuple(self.mask or (0.0, 1.0, 0.0, 1.0))
        if self.kind == "imask":
            return ("imask", self.imask or 0)
        return (self.kind,)


@dataclass
class Settings:
    weight: float | None = None
    format: str | None = None
    shuffle: bool = False
    random_select: tuple[int, int] | None = None
    dropout: float = 0.0
    seed: int | None = None
    schedule: tuple[float, float] | None = None
    region: Region | None = None


@dataclass
class Spans:
    """Where each piece of a group came from in the source.

    This is what lets the detail page edit one control and rewrite only the few
    characters behind it, instead of regenerating the document and flattening the
    user's layout.  Every span is a (start, end) pair of character offsets.
    """

    node: Span = (0, 0)  # the whole group, `.set{}` included
    content: Span | None = None  # between `{` and `}` — where new items go
    header: Span | None = None  # `[path.to.group]` of a library block
    set_block: Span | None = None  # `.set{ ... }`, or None when there is none
    set_body: Span | None = None  # between the `.set{` and its `}`
    # field -> {"value": Span, "entry": Span}.  `entry` covers `name: value` plus a
    # trailing comma, so removing a field is one deletion.
    fields: dict[str, dict[str, Span]] = field(default_factory=dict)
    # A region declared by `[@region]`'s block head lives outside `.set{}`, so its
    # spans are tracked separately and the two cases look the same to the frontend.
    region_decl: Span | None = None  # `[imask: 0, ...]` / `base` / `{ ... }`
    region_body: Span | None = None  # inside the region's brackets/braces
    region_fields: dict[str, dict[str, Span]] = field(default_factory=dict)
    # Where a region / schedule was written, because the two forms are not
    # interchangeable text: "block" = the `[@region]` / `[@schedule]` block head,
    # "set" = a field inside `.set{}`.
    region_form: str | None = None
    schedule_form: str | None = None


@dataclass
class Group:
    children: list[Node] = field(default_factory=list)
    settings: Settings = field(default_factory=Settings)
    header: str | None = None  # library group path, for `[path]: { ... }` blocks
    paren: bool = False  # came from `( ... )` rather than `{ ... }`
    # True when there are no braces in the text at all: `0.3 - 1: open eyes` is ONE item,
    # and the Group around it exists only because a Group is where a schedule/region
    # setting can hang.  The detail page must not draw it as a group — there is nowhere
    # to put a `.set{}` on it, and offering one writes `open eyes.set{…}`, which is a
    # syntax error.
    implicit: bool = False
    path: tuple[int, ...] = ()  # stable position in the tree — seeds the RNG
    pos: int = 0
    end: int = 0
    spans: Spans = field(default_factory=Spans)


_KNOWN_FIELDS = {
    "weight",
    "format",
    "shuffle",
    "random_select",
    "dropout",
    "seed",
    "schedule",
    "region",
}
_KNOWN_REGION_FIELDS = {
    "kind",
    "mask",
    "imask",
    "feather",
    "region_weight",
    "include_in_base",
}


# --- scalar coercion --------------------------------------------------------


def _as_float(v, diags: Diagnostics, pos: int, default=None):
    try:
        return float(str(v).strip())
    except (TypeError, ValueError):
        diags.warn(W08, f"expected a number, got {v!r}", pos)
        return default


def _as_int(v, diags: Diagnostics, pos: int, default=None):
    try:
        return int(float(str(v).strip()))
    except (TypeError, ValueError):
        diags.warn(W08, f"expected an integer, got {v!r}", pos)
        return default


def _as_bool(v, diags: Diagnostics, pos: int, default=False):
    s = str(v).strip().lower()
    if s in ("true", "1", "yes", "on"):
        return True
    if s in ("false", "0", "no", "off"):
        return False
    diags.warn(W08, f"expected true/false, got {v!r}", pos)
    return default


def _pair(v, diags: Diagnostics, pos: int) -> tuple[float, float] | None:
    """`{0.2, 0.5}` / `[0.2, 0.5]` -> (0.2, 0.5)."""
    if not isinstance(v, list) or len(v) != 2:
        diags.warn(W08, f"expected two numbers, got {v!r}", pos)
        return None
    a = _as_float(v[0], diags, pos)
    b = _as_float(v[1], diags, pos)
    if a is None or b is None:
        return None
    return (a, b)


# --- parser -----------------------------------------------------------------


class Parser:
    """The parser has two modes, and the difference is who is asking.

    strict (recover=False) — the NODE, at execution time.  An unparseable document
        must abort: silently rendering an image from a document nobody could read is
        the one outcome worse than an error (spec §6).

    recovering (recover=True) — the EDITOR.  A document that does not parse is not an
        exception there, it is Tuesday: half-typed, pasted, mid-refactor.  Blanking
        the detail page and the preview because one construct is broken makes them
        useless exactly when you need them.  So a broken construct is closed or
        skipped, an E03 is recorded, and everything the parser CAN understand is
        still handed back.
    """

    def __init__(self, src: str, diags: Diagnostics | None = None,
                 recover: bool = False) -> None:
        self.src = src
        self.toks = lx.tokenize(src)
        self.i = 0
        self.diags = diags if diags is not None else Diagnostics()
        self.stop: int | None = None  # hard token-index barrier (paren weights)
        self.depth = 0
        self.recover = recover

    # -- token helpers --
    def peek(self, off: int = 0) -> lx.Tok:
        j = self.i + off
        if self.stop is not None and j >= self.stop:
            return lx.Tok(lx.EOF, "", self.toks[min(j, len(self.toks) - 1)].pos)
        return self.toks[min(j, len(self.toks) - 1)]

    def at(self, kind: str) -> bool:
        return self.peek().kind == kind

    def advance(self) -> lx.Tok:
        t = self.peek()
        if t.kind != lx.EOF:
            self.i += 1
        return t

    def expect(self, kind: str) -> lx.Tok:
        t = self.peek()
        if t.kind != kind:
            raise PLv3Error(E03, f"expected {kind}, found {t.kind} {t.raw!r}", t.pos)
        return self.advance()

    def error(self, msg: str, pos: int) -> PLv3Error:
        return PLv3Error(E03, msg, pos)

    def fail(self, msg: str, pos: int) -> None:
        """Report a structural break.  Raises in strict mode; records it and carries
        on in recovering mode."""
        if not self.recover:
            raise self.error(msg, pos)
        self.diags.warn(E03, msg, pos)

    def resync(self, after: int) -> None:
        """Skip past a construct we could not read: everything up to the end of its
        line.  A line is where a prompt document's structure actually breaks."""
        nl = self.src.find("\n", after)
        target = len(self.src) if nl == -1 else nl + 1
        moved = False
        while self.i < len(self.toks) - 1 and self.toks[self.i].pos < target:
            self.i += 1
            moved = True
        if not moved and self.i < len(self.toks) - 1:
            self.i += 1   # always make progress, or the loop above never ends

    def prev_end(self) -> int:
        """End offset of the last token consumed."""
        if self.i == 0:
            return 0
        t = self.toks[self.i - 1]
        return t.pos + len(t.raw)

    # -- entry point --
    def parse(self) -> Group:
        if not self.recover:
            children = self.parse_items(lx.EOF)
            if not self.at(lx.EOF):
                t = self.peek()
                raise self.error(f"unexpected {t.raw!r}", t.pos)
        else:
            children = self.parse_items_recovering()

        root = Group(children=children, pos=0, end=len(self.src))
        root.spans = Spans(node=(0, len(self.src)), content=(0, len(self.src)))
        assign_paths(root)
        return root

    def parse_items_recovering(self) -> list[Node]:
        """Top-level items, one at a time.  Whatever a broken one takes down with it,
        it does not take down the ones around it."""
        children: list[Node] = []
        while not self.at(lx.EOF):
            if self.at(lx.COMMA):
                self.advance()
                continue
            before = self.i
            pos = self.peek().pos
            try:
                node = self.parse_item(lx.EOF)
                if node is not None:
                    children.append(node)
            except PLv3Error as exc:
                self.diags.warn(exc.diag.code, exc.diag.message, exc.diag.pos)
                self.i = max(self.i, before)
                self.resync(exc.diag.pos)
                continue
            if self.i == before:
                self.resync(pos)
        return children

    # -- item lists --
    def parse_items(self, end: str) -> list[Node]:
        children: list[Node] = []
        while True:
            t = self.peek()
            if t.kind == lx.EOF or t.kind == end:
                break
            if t.kind == lx.COMMA:
                self.advance()
                continue
            before = self.i
            node = self.parse_item(end)
            if node is not None:
                children.append(node)
            if self.i == before:  # pragma: no cover - safety net
                raise self.error(f"stuck at {t.raw!r}", t.pos)
        return children

    def parse_item(self, end: str) -> Node | None:
        atoms: list[Node] = []
        start = self.peek().pos

        while True:
            t = self.peek()
            if t.kind in (lx.EOF, lx.COMMA) or t.kind == end:
                break

            if t.kind == lx.LBRACE:
                if _has_content(atoms):
                    break  # a group after bare text starts a new item
                atoms = []
                return self.parse_group()

            if t.kind == lx.LBRACKET:
                kind = self.classify_bracket()
                if kind == "literal":
                    raw = self.consume_bracket_raw()
                    self.diags.warn(
                        W14, f"unrecognised bracket block {raw!r}; passed through", t.pos
                    )
                    atoms.append(Text(raw, t.pos, self.prev_end()))
                    continue
                if _has_content(atoms):
                    break
                atoms = []
                if kind == "schedule":
                    return self.parse_schedule_block()
                if kind == "region":
                    return self.parse_region_block()
                return self.parse_ref_block()

            if t.kind == lx.LPAREN:
                atoms.append(self.parse_paren())
                continue

            if t.kind == lx.LORA:
                self.advance()
                atoms.append(Lora(t.raw, t.pos, self.prev_end()))
                continue

            if t.kind in (lx.TEXT, lx.STRING):
                self.advance()
                # The span excludes the run's surrounding whitespace: the detail
                # page rewrites exactly this range, and swallowing the indent would
                # destroy the user's layout on every edit.  The *value* keeps its
                # edge spaces — an Item needs them to glue its atoms together.
                lead = len(t.raw) - len(t.raw.lstrip())
                trail = len(t.raw) - len(t.raw.rstrip())
                atoms.append(
                    Text(lx.text_out(t.raw), t.pos + lead, t.pos + len(t.raw) - trail)
                )
                continue

            if t.kind == lx.COLON:
                # A colon outside a weight / config position is simply part of the
                # tag: `(artist:wlop:1.1)` is "artist:wlop" at weight 1.1, because
                # the weight is the *last* `: number` before the `)`.  No escaping
                # is asked of the user; the compiler emits `\:` for prompt-control.
                self.advance()
                atoms.append(Text("\\:", t.pos, t.pos + 1))
                continue

            if t.kind == lx.SET:
                # `.set{}` with no group in front of it.
                self.advance()
                self.diags.warn(W14, "'.set' without a group; treated as text", t.pos)
                atoms.append(Text(".set", t.pos, t.pos + 4))
                continue

            # RBRACE / RPAREN / RBRACKET that closes nothing.
            self.fail(f"unbalanced {t.raw!r}", t.pos)
            self.advance()   # recovering: drop it and read on
            continue

        atoms = _trim_edges(_coalesce(atoms))
        if not atoms:
            return None
        if len(atoms) == 1:
            only = atoms[0]
            if isinstance(only, Text):
                stripped = only.text.strip()
                return Text(stripped, only.pos, only.end) if stripped else None
            return only
        # From the first atom, not from `start`: the token stream begins at the
        # whitespace run before the item, and a span that eats the indent would make
        # every detail-page edit re-flow the document.
        return Item(atoms, atoms[0].pos, node_end(atoms[-1]))

    # -- groups --
    def parse_group(self) -> Group:
        open_tok = self.expect(lx.LBRACE)
        self.depth += 1
        if self.depth > MAX_DEPTH:
            raise self.error("nesting too deep", open_tok.pos)
        children = self.parse_items(lx.RBRACE)
        if self.at(lx.RBRACE):
            content = (open_tok.pos + 1, self.peek().pos)
            self.advance()
        else:
            # Recovering: close it where it ran out. Everything already parsed inside
            # stays — a missing brace at the end of a file must not delete the file.
            self.fail("unclosed '{'", open_tok.pos)
            content = (open_tok.pos + 1, self.prev_end())
        self.depth -= 1
        settings, spans = self.maybe_set()

        group = Group(
            children=children, settings=settings, pos=open_tok.pos, end=self.prev_end()
        )
        spans.node = (open_tok.pos, self.prev_end())
        spans.content = content
        group.spans = spans
        return group

    def parse_paren(self) -> Group:
        open_tok = self.expect(lx.LPAREN)
        close, weight_at, closed = self._scan_paren(self.i - 1)
        outer_stop = self.stop
        self.depth += 1
        if self.depth > MAX_DEPTH:
            raise self.error("nesting too deep", open_tok.pos)
        self.stop = weight_at if weight_at is not None else close
        children = self.parse_items(lx.RPAREN)
        self.stop = outer_stop
        self.depth -= 1

        end_i = weight_at if weight_at is not None else close
        content = (open_tok.pos + 1, self.toks[min(end_i, len(self.toks) - 1)].pos)

        weight = None
        weight_span = None
        if weight_at is not None:
            self.i = weight_at
            colon = self.expect(lx.COLON)
            wt = self.expect(lx.TEXT)
            weight = _as_float(lx.ident(wt.raw), self.diags, wt.pos, 1.0)
            weight_span = {
                "value": (wt.pos, wt.pos + len(wt.raw)),
                "entry": (colon.pos, wt.pos + len(wt.raw)),
            }
        self.i = close
        if closed:
            self.expect(lx.RPAREN)

        settings, spans = self.maybe_set()
        if settings.weight is None:
            settings.weight = weight
            if weight_span is not None:
                spans.fields["weight"] = weight_span

        group = Group(
            children=children,
            settings=settings,
            paren=True,
            pos=open_tok.pos,
            end=self.prev_end(),
        )
        spans.node = (open_tok.pos, self.prev_end())
        spans.content = content
        group.spans = spans
        return group

    def _line_bound(self, pos: int) -> int:
        """Token index of the first token on a later line than `pos`.

        An unclosed `(` is contained to its own line.  A brace spans lines by design,
        but a weight paren does not — letting an unclosed one swallow the rest of the
        document would lose every item below it.
        """
        nl = self.src.find("\n", pos)
        if nl == -1:
            return len(self.toks) - 1
        j = self.i
        while j < len(self.toks) - 1 and self.toks[j].pos < nl:
            j += 1
        return j

    def _scan_paren(self, open_i: int) -> tuple[int, int | None, bool]:
        """Find the matching RPAREN, and the `: <number>` weight tail if present.

        Returns (close index, index of the weight COLON or None, closed?).  When
        recovering, `closed` is False and the close index is the end of the line.
        """
        depth = 0
        j = open_i
        limit = self.stop if self.stop is not None else len(self.toks)
        while j < limit:
            k = self.toks[j].kind
            if k == lx.LPAREN:
                depth += 1
            elif k == lx.RPAREN:
                depth -= 1
                if depth == 0:
                    break
            elif k == lx.EOF:
                break
            j += 1
        if j >= limit or self.toks[j].kind != lx.RPAREN:
            self.fail("unclosed '('", self.toks[open_i].pos)
            # Recovering: the paren ends where its line does.
            return self._line_bound(self.toks[open_i].pos), None, False
        close = j
        if (
            close - open_i >= 3
            and self.toks[close - 2].kind == lx.COLON
            and self.toks[close - 1].kind == lx.TEXT
            and _is_number(lx.ident(self.toks[close - 1].raw))
            and self._paren_depth_at(open_i, close - 2) == 1
        ):
            return close, close - 2, True
        return close, None, True

    def _paren_depth_at(self, open_i: int, target: int) -> int:
        depth = 0
        for j in range(open_i, target):
            k = self.toks[j].kind
            if k == lx.LPAREN:
                depth += 1
            elif k == lx.RPAREN:
                depth -= 1
        return depth

    def maybe_set(self) -> tuple[Settings, Spans]:
        """Parse a `.set{ ... }` block if one follows (whitespace allowed)."""
        save = self.i
        if self.at(lx.TEXT) and not lx.ident(self.peek().raw):
            self.advance()  # whitespace between `}` and `.set`
        if not self.at(lx.SET):
            self.i = save
            return Settings(), Spans()

        set_tok = self.advance()
        pos = self.peek().pos
        open_brace = self.expect(lx.LBRACE)
        raw, field_spans = self.parse_config_seq(lx.RBRACE)
        body = (open_brace.pos + 1, self.peek().pos)
        self.expect(lx.RBRACE)

        if not isinstance(raw, dict):
            if raw:
                self.diags.warn(W07, ".set{} expects key: value pairs", pos)
            raw = {}
            field_spans = {}

        spans = Spans(
            set_block=(set_tok.pos, self.prev_end()),
            set_body=body,
            fields=dict(field_spans),
        )
        settings = self.settings_from(raw, pos, spans)
        return settings, spans

    # -- bracket blocks --
    def classify_bracket(self) -> str:
        """Look at `[...]` and decide what it is, without consuming anything."""
        close = self._scan_bracket(self.i)
        inner = self.toks[self.i + 1 : close]
        head = lx.ident(inner[0].raw).lower() if len(inner) == 1 and inner[0].kind == lx.TEXT else ""
        after = close + 1
        # skip pure whitespace between `]` and `:`
        if after < len(self.toks) and self.toks[after].kind == lx.TEXT and not lx.ident(self.toks[after].raw):
            after += 1
        block = after < len(self.toks) and self.toks[after].kind == lx.COLON
        if not block:
            return "literal"
        if head == "@schedule":
            return "schedule"
        if head == "@region":
            return "region"
        # `[path]: {` — a library ref block.  A `[` that is followed by `:` but
        # not by a group is not a block at all.
        j = after + 1
        if j < len(self.toks) and self.toks[j].kind == lx.TEXT and not lx.ident(self.toks[j].raw):
            j += 1
        if j < len(self.toks) and self.toks[j].kind == lx.LBRACE and not head.startswith("@"):
            return "ref"
        return "literal"

    def _scan_bracket(self, open_i: int) -> int:
        depth = 0
        j = open_i
        limit = self.stop if self.stop is not None else len(self.toks)
        while j < limit:
            k = self.toks[j].kind
            if k == lx.LBRACKET:
                depth += 1
            elif k == lx.RBRACKET:
                depth -= 1
                if depth == 0:
                    return j
            elif k == lx.EOF:
                break
            j += 1
        self.fail("unclosed '['", self.toks[open_i].pos)
        return min(j, len(self.toks) - 1)

    def consume_bracket_raw(self) -> str:
        """Take an unrecognised `[...]` run verbatim (W14 escape hatch)."""
        open_tok = self.peek()
        close = self._scan_bracket(self.i)
        end = self.toks[close].pos + 1
        self.i = close + 1
        return self.src[open_tok.pos : end]

    def _skip_ws(self) -> None:
        while self.at(lx.TEXT) and not lx.ident(self.peek().raw):
            self.advance()

    def parse_ref_block(self) -> Group:
        open_tok = self.expect(lx.LBRACKET)
        parts: list[str] = []
        while not self.at(lx.RBRACKET) and not self.at(lx.EOF):
            parts.append(lx.unescape_bare(self.advance().raw))
        close = self.expect(lx.RBRACKET)
        self._skip_ws()
        self.expect(lx.COLON)
        self._skip_ws()
        group = self.parse_group()
        group.header = "".join(parts).strip()
        group.pos = open_tok.pos
        group.spans.header = (open_tok.pos, close.pos + 1)
        group.spans.node = (open_tok.pos, group.end)
        return group

    def parse_schedule_block(self) -> Group:
        open_tok = self.expect(lx.LBRACKET)
        self.advance()  # @schedule
        self.expect(lx.RBRACKET)
        self._skip_ws()
        self.expect(lx.COLON)
        self._skip_ws()
        brace = self.expect(lx.LBRACE)

        entries: list[Group] = []
        while not self.at(lx.RBRACE) and not self.at(lx.EOF):
            if self.at(lx.COMMA):
                self.advance()
                continue
            if self.at(lx.TEXT) and not lx.ident(self.peek().raw):
                self.advance()
                continue
            # `0 - 0.2: { … }` — NOT `[0, 0.2]: { … }`.  A bracketed head would have
            # exactly the shape of a library reference (`[characters.illya]: { … }`),
            # and two things that mean nothing alike must not look alike.
            head = self.expect(lx.TEXT)
            interval = _interval(lx.ident(head.raw))
            if interval is None:
                raise self.error(
                    f"expected a time range like `0 - 0.2`, found {lx.ident(head.raw)!r}",
                    head.pos,
                )
            self._skip_ws()
            self.expect(lx.COLON)
            self._skip_ws()
            body = self.parse_entry_body()
            if body.settings.schedule is not None:
                self.diags.warn(W02, pos=body.pos)
            body.settings.schedule = _clamp_interval(interval)
            # The range lives in the block head, not in a `.set{}` — record where, so
            # the detail page rewrites `0 - 0.2` rather than inventing a `.set{}`.
            head_span = _trim_span(head)
            body.spans.schedule_form = "block"
            body.spans.fields["schedule"] = {"value": head_span, "entry": head_span}
            entries.append(body)

        if self.at(lx.RBRACE):
            content = (brace.pos + 1, self.peek().pos)
            self.advance()
        else:
            self.fail("unclosed '{' after [@schedule]", open_tok.pos)
            content = (brace.pos + 1, self.prev_end())
        _normalise_intervals(entries)

        settings, spans = self.maybe_set()
        if settings.schedule is not None:
            self.diags.warn(W01, pos=open_tok.pos)
            settings.schedule = None
            spans.fields.pop("schedule", None)

        group = Group(
            children=list(entries), settings=settings, pos=open_tok.pos, end=self.prev_end()
        )
        spans.node = (open_tok.pos, self.prev_end())
        spans.content = content
        group.spans = spans
        return group

    def parse_region_block(self) -> Group:
        open_tok = self.expect(lx.LBRACKET)
        self.advance()  # @region
        self.expect(lx.RBRACKET)
        self._skip_ws()
        self.expect(lx.COLON)
        self._skip_ws()
        brace = self.expect(lx.LBRACE)

        entries: list[Group] = []
        while not self.at(lx.RBRACE) and not self.at(lx.EOF):
            if self.at(lx.COMMA):
                self.advance()
                continue
            if self.at(lx.TEXT) and not lx.ident(self.peek().raw):
                self.advance()
                continue
            head = self.peek()
            body_span = None
            field_spans: dict[str, dict[str, Span]] = {}
            if head.kind == lx.LBRACKET:
                self.advance()
                params, field_spans = self.parse_config_seq(lx.RBRACKET)
                body_span = (head.pos + 1, self.peek().pos)
                close = self.expect(lx.RBRACKET)
                if not isinstance(params, dict):
                    raise self.error("region params must be key: value pairs", head.pos)
                region = self.region_from(params, head.pos)
                decl = (head.pos, close.pos + 1)
            elif head.kind == lx.TEXT:
                self.advance()
                region = self.region_from({"kind": lx.ident(head.raw)}, head.pos)
                decl = _trim_span(head)  # the run carries the line's indent
            else:
                raise self.error(f"bad [@region] entry {head.raw!r}", head.pos)
            self._skip_ws()
            self.expect(lx.COLON)
            self._skip_ws()
            body = self.parse_entry_body()
            if body.settings.region is not None:
                self.diags.warn(W04, pos=body.pos)
                body.spans.region_decl = None
                body.spans.region_fields = {}
            body.settings.region = region
            # Same as [@schedule]: the region lives in the block head, so the detail
            # page must edit *that*, not conjure a `.set{region: ...}`.
            body.spans.region_form = "block"
            body.spans.region_decl = decl
            body.spans.region_body = body_span
            body.spans.region_fields = field_spans
            entries.append(body)

        if self.at(lx.RBRACE):
            content = (brace.pos + 1, self.peek().pos)
            self.advance()
        else:
            self.fail("unclosed '{' after [@region]", open_tok.pos)
            content = (brace.pos + 1, self.prev_end())

        settings, spans = self.maybe_set()
        if settings.region is not None:
            self.diags.warn(W03, pos=open_tok.pos)
            settings.region = None
            spans.fields.pop("region", None)

        group = Group(
            children=list(entries), settings=settings, pos=open_tok.pos, end=self.prev_end()
        )
        spans.node = (open_tok.pos, self.prev_end())
        spans.content = content
        group.spans = spans
        return group

    def parse_entry_body(self) -> Group:
        """The value side of a `[@schedule]` / `[@region]` entry.

        Either a group, or a bare item that gets wrapped in one.
        """
        if self.at(lx.LBRACE):
            return self.parse_group()
        pos = self.peek().pos
        node = self.parse_item(lx.RBRACE)
        children = [node] if node is not None else []
        group = Group(children=children, pos=pos, end=self.prev_end(), implicit=True)
        group.spans.node = (pos, self.prev_end())
        group.spans.content = (pos, self.prev_end())
        return group

    # -- .set{} / region params --
    def parse_config_seq(self, end: str):
        """Parse a config body up to `end`.

        Returns (data, spans): data is a dict (pairs) or a list (positional), and
        spans records where each key's value came from, so a control can rewrite
        just that value.  `entry` covers `name: value` plus a trailing comma, so
        removing a field is a single deletion.
        """
        pairs: dict[str, object] = {}
        items: list[object] = []
        spans: dict[str, dict[str, Span]] = {}
        while True:
            # Whitespace first, or a trailing comma before the closing brace —
            # `.set{a: 1, }` — leaves a blank run that then fails to parse as a value.
            self._skip_ws()
            if self.at(end) or self.at(lx.EOF):
                break
            if self.at(lx.COMMA):
                self.advance()
                continue
            key_tok = self.peek()
            value, key_meta = self.parse_config_value()
            self._skip_ws()
            if self.at(lx.COLON):
                self.advance()
                self._skip_ws()
                if not isinstance(value, str):
                    raise self.error("bad config key", key_tok.pos)
                val, meta = self.parse_config_value()
                pairs[value] = val
                entry_end = meta["span"][1]
                if self.at(lx.COMMA):
                    entry_end = self.peek().pos + 1
                spans[value] = {
                    "value": meta["span"],
                    "entry": (key_meta["span"][0], entry_end),
                    **{k: v for k, v in meta.items() if k in ("body", "sub")},
                }
            else:
                items.append(value)
        if not self.at(end):
            self.fail("unclosed config block", self.peek().pos)
        return (pairs, spans) if pairs else (items, spans)

    def parse_config_value(self):
        self._skip_ws()
        t = self.peek()
        if t.kind == lx.STRING:
            self.advance()
            return lx.unquote(t.raw), {"span": (t.pos, t.pos + len(t.raw))}
        if t.kind in (lx.LBRACE, lx.LBRACKET):
            closer = lx.RBRACE if t.kind == lx.LBRACE else lx.RBRACKET
            self.advance()
            value, sub = self.parse_config_seq(closer)
            body = (t.pos + 1, self.peek().pos)
            self.expect(closer)
            return value, {"span": (t.pos, self.prev_end()), "body": body, "sub": sub}
        if t.kind == lx.TEXT:
            self.advance()
            # A TEXT run carries its leading whitespace (` 1.2`); the span must not,
            # or a control would rewrite the space along with the value.
            lead = len(t.raw) - len(t.raw.lstrip())
            trail = len(t.raw) - len(t.raw.rstrip())
            return lx.ident(t.raw), {
                "span": (t.pos + lead, t.pos + len(t.raw) - trail)
            }
        raise self.error(f"bad config value {t.raw!r}", t.pos)

    def settings_from(self, raw: dict, pos: int, spans: Spans | None = None) -> Settings:
        s = Settings()
        for key, value in raw.items():
            if key not in _KNOWN_FIELDS:
                self.diags.warn(W07, f"unknown .set{{}} field {key!r}; ignored", pos)
                continue
            if key == "weight":
                s.weight = _as_float(value, self.diags, pos, None)
            elif key == "format":
                s.format = value if isinstance(value, str) else None
                if s.format is None:
                    self.diags.warn(W08, "format must be a string", pos)
            elif key == "shuffle":
                s.shuffle = _as_bool(value, self.diags, pos, False)
            elif key == "dropout":
                d = _as_float(value, self.diags, pos, 0.0)
                s.dropout = min(1.0, max(0.0, d if d is not None else 0.0))
            elif key == "seed":
                s.seed = _as_int(value, self.diags, pos, None)
            elif key == "random_select":
                s.random_select = self._random_select(value, pos)
            elif key == "schedule":
                iv = _pair(value, self.diags, pos)
                s.schedule = _clamp_interval(iv) if iv else None
                if spans is not None and s.schedule is not None:
                    spans.schedule_form = "set"
            elif key == "region":
                if isinstance(value, str):
                    s.region = self.region_from({"kind": value}, pos)
                elif isinstance(value, dict):
                    s.region = self.region_from(value, pos)
                else:
                    self.diags.warn(W08, "region must be a name or a block", pos)
                if spans is not None and s.region is not None:
                    meta = spans.fields.get("region", {})
                    spans.region_form = "set"
                    spans.region_decl = meta.get("value")
                    spans.region_body = meta.get("body")
                    spans.region_fields = meta.get("sub") or {}
        return s

    def _random_select(self, value, pos: int) -> tuple[int, int] | None:
        raw = str(value).strip()
        if "-" in raw[1:]:
            lo_s, _, hi_s = raw.partition("-")
            lo = _as_int(lo_s, self.diags, pos)
            hi = _as_int(hi_s, self.diags, pos)
        else:
            lo = hi = _as_int(raw, self.diags, pos)
        if lo is None or hi is None:
            return None
        lo = max(0, lo)
        hi = max(lo, hi)
        return (lo, hi)

    def region_from(self, raw: dict, pos: int) -> Region:
        r = Region()
        kind = None
        for key, value in raw.items():
            if key not in _KNOWN_REGION_FIELDS:
                self.diags.warn(W07, f"unknown region field {key!r}; ignored", pos)
                continue
            if key == "kind":
                k = str(value).strip().lower()
                if k not in ("base", "fill", "mask", "imask"):
                    self.diags.warn(W08, f"unknown region kind {value!r}; using base", pos)
                    k = "base"
                kind = k
            elif key == "mask":
                r.mask = self._mask(value, pos)
            elif key == "imask":
                r.imask = _as_int(value, self.diags, pos, 0)
            elif key == "feather":
                f = _as_int(value, self.diags, pos, 0)
                r.feather = max(0, f if f is not None else 0)
            elif key == "region_weight":
                w = _as_float(value, self.diags, pos, 1.0)
                r.region_weight = w if w is not None else 1.0
            elif key == "include_in_base":
                r.include_in_base = _as_bool(value, self.diags, pos, False)
        # `region: { imask: 0 }` — infer the kind from what was written (spec §3.3).
        if kind is None:
            if r.mask is not None:
                kind = "mask"
            elif r.imask is not None:
                kind = "imask"
            else:
                kind = "base"
        if kind == "mask" and r.mask is None:
            r.mask = (0.0, 1.0, 0.0, 1.0)
        if kind == "imask" and r.imask is None:
            r.imask = 0
        r.kind = kind
        return r

    def _mask(self, value, pos: int) -> tuple[float, float, float, float] | None:
        if not isinstance(value, list) or len(value) != 4:
            self.diags.warn(W08, "mask must be [x1, x2, y1, y2]", pos)
            return None
        nums = [_as_float(v, self.diags, pos, 0.0) for v in value]
        nums = [0.0 if n is None else n for n in nums]
        pct = [n for n in nums if 0.0 <= n <= 1.0]
        if pct and len(pct) != 4:
            self.diags.warn(W10, pos=pos)
        return (nums[0], nums[1], nums[2], nums[3])


# --- helpers ----------------------------------------------------------------


def node_end(node: Node) -> int:
    return node.end


_RANGE_RE = re.compile(r"^(-?[\d.]+)\s*-\s*(-?[\d.]+)$")


def _interval(text: str) -> tuple[float, float] | None:
    """`0 - 0.2` -> (0.0, 0.2).  The head of a `[@schedule]` entry."""
    m = _RANGE_RE.match(text.strip())
    if not m:
        return None
    try:
        return (float(m.group(1)), float(m.group(2)))
    except ValueError:
        return None


def _trim_span(tok: lx.Tok) -> Span:
    """A TEXT run carries the surrounding whitespace; its span must not."""
    lead = len(tok.raw) - len(tok.raw.lstrip())
    trail = len(tok.raw) - len(tok.raw.rstrip())
    return (tok.pos + lead, tok.pos + len(tok.raw) - trail)


def _is_number(s: str) -> bool:
    try:
        float(s)
        return True
    except ValueError:
        return False


def _coalesce(atoms: list[Node]) -> list[Node]:
    """Merge neighbouring Text atoms — `artist`, `\\:`, `wlop` is one tag, not three."""
    out: list[Node] = []
    for a in atoms:
        if isinstance(a, Text) and out and isinstance(out[-1], Text):
            out[-1] = Text(out[-1].text + a.text, out[-1].pos, a.end)
        else:
            out.append(a)
    return out


def _trim_edges(atoms: list[Node]) -> list[Node]:
    """Drop whitespace-only Text atoms at the edges of an item, so that
    `, <lora:x:1>` yields a bare Lora rather than an Item with a blank in front."""
    def blank(a: Node) -> bool:
        return isinstance(a, Text) and not a.text.strip()

    start, end = 0, len(atoms)
    while start < end and blank(atoms[start]):
        start += 1
    while end > start and blank(atoms[end - 1]):
        end -= 1
    return atoms[start:end]


def _has_content(atoms: list[Node]) -> bool:
    """True if the atoms collected so far are more than whitespace."""
    for a in atoms:
        if isinstance(a, Text):
            if a.text.strip():
                return True
        else:
            return True
    return False


def _clamp_interval(iv: tuple[float, float] | None) -> tuple[float, float] | None:
    if iv is None:
        return None
    a = min(1.0, max(0.0, iv[0]))
    b = min(1.0, max(0.0, iv[1]))
    return (a, b)


def _normalise_intervals(entries: list[Group]) -> None:
    """Spec §3.4: each entry's own `start` wins; the previous entry's `end` is
    rewritten to it.  Gaps and overlaps therefore cannot survive."""
    for prev, cur in zip(entries, entries[1:]):
        p = prev.settings.schedule
        c = cur.settings.schedule
        if p is None or c is None:
            continue
        prev.settings.schedule = (p[0], c[0])


def assign_paths(root: Group, prefix: tuple[int, ...] = ()) -> None:
    """Give every group a stable tree path — it seeds the group's RNG (spec §4.6)."""
    root.path = prefix
    for idx, child in enumerate(root.children):
        _assign(child, prefix + (idx,))


def _assign(node: Node, path: tuple[int, ...]) -> None:
    if isinstance(node, Group):
        assign_paths(node, path)
    elif isinstance(node, Item):
        for idx, atom in enumerate(node.atoms):
            _assign(atom, path + (idx,))


def parse(src: str, diags: Diagnostics | None = None,
          recover: bool = False) -> tuple[Group, Diagnostics]:
    """`recover=True` gives the editor a best-effort tree plus E03 diagnostics; the
    node always parses strictly (spec §6)."""
    p = Parser(src, diags, recover=recover)
    root = p.parse()
    return root, p.diags
