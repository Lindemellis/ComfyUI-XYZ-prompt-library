"""PLv3 lexer — escape-aware structural tokenizer (spec §3.1).

The token stream is *structural*: every character that PLv3 reserves gets its
own token, everything else piles up into TEXT runs.  Escape pairs (`\\x`) are
always swallowed into TEXT, so a `\\,` can never be mistaken for a separator.
The parser interprets TEXT differently depending on context (prompt body vs.
`.set{}` config), which is why the lexer stays context-free.

Reserved characters (all must be escaped to be used literally):

    [ ]   library refs, schedule intervals, region params
    { }   groups, .set{}
    ( )   weights
    :     weight separator — only as the last `: number` before a `)`
    \\     the escape character itself

`,` is NOT escapable: it always separates items, full stop.  A literal comma
inside one item would only have been useful to keep `a, b` as a single unit for
shuffle / random_select / dropout / format / weight — and a subgroup `{a, b}`
already does exactly that, without making the item count depend on a backslash.

`:` needs no escaping in practice: a colon only means "weight" when it is the
last `: number` before a `)`, so `(artist:wlop:1.1)` is the tag "artist:wlop" at
weight 1.1.  Every other colon is literal text.  `\\:` is still accepted to force
a literal in the one ambiguous spot (`(cat\\:1.5)`).

Output escaping follows comfyui-prompt-control's own escape table, see
`_PC_ESCAPABLE` below.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# --- token kinds ------------------------------------------------------------
LBRACE = "LBRACE"
RBRACE = "RBRACE"
LBRACKET = "LBRACKET"
RBRACKET = "RBRACKET"
LPAREN = "LPAREN"
RPAREN = "RPAREN"
COMMA = "COMMA"
COLON = "COLON"
SET = "SET"        # the literal `.set` immediately preceding a `{`
LORA = "LORA"      # <lora:name:1.0> — one opaque item
STRING = "STRING"  # "double quoted" — used by .set{format: "..."}
TEXT = "TEXT"      # anything else, including whitespace and escape pairs
EOF = "EOF"

_STRUCT = {
    "{": LBRACE,
    "}": RBRACE,
    "[": LBRACKET,
    "]": RBRACKET,
    "(": LPAREN,
    ")": RPAREN,
    ",": COMMA,
    ":": COLON,
}

CLOSERS = {LBRACE: RBRACE, LBRACKET: RBRACKET, LPAREN: RPAREN}

# The exact escape set comfyui-prompt-control understands (parser_parsy.py):
#
#     escape = (string("\\") >> char_from("\\[]:#") | string(r"\(") | string(r"\)"))
#
# `\:` `\[` `\]` `\\` `\#` are unescaped to the bare character before the text
# reaches the CLIP encoder; `\(` `\)` are handed on *with* their backslash for the
# weight parser downstream.  Anything else (`\<`, `\|`, `\"`, …) is NOT an escape
# there and would leak a literal backslash into the prompt.
_PC_ESCAPABLE = set("()[]:\\#")

# `:` and `#` reach us as bare characters — but prompt-control needs them escaped:
# a bare `:` inside one of our `[text, :s,e]` schedule wrappers would be read as an
# argument separator, and a bare `#` starts a comment that swallows the rest of the
# line.
_NEEDS_ESCAPE = set(":#")

# What a backslash may escape in PLv3 source — exactly the structural characters.
# `,` is absent on purpose: it is always an item separator.  A backslash in front
# of anything else is just a literal backslash.
_ESCAPABLE = set("[]{}():\\")

_LORA_RE = re.compile(r"<[A-Za-z_][A-Za-z0-9_]*:[^<>\n]*>")
_WS_RE = re.compile(r"\s+")


@dataclass
class Tok:
    kind: str
    raw: str
    pos: int

    def __repr__(self) -> str:  # pragma: no cover - debug aid
        return f"Tok({self.kind},{self.raw!r},{self.pos})"


def tokenize(src: str) -> list[Tok]:
    """Split `src` into structural tokens.  Never raises."""
    toks: list[Tok] = []
    n = len(src)
    i = 0
    run: int | None = None  # start offset of the TEXT run currently being built

    def flush(end: int) -> None:
        nonlocal run
        if run is not None and end > run:
            toks.append(Tok(TEXT, src[run:end], run))
        run = None

    while i < n:
        c = src[i]

        # Escape pair — always part of a TEXT run, never structural.  A backslash
        # in front of a non-escapable character (a comma, say) is just a literal
        # backslash, and the character keeps whatever meaning it had.
        if c == "\\" and i + 1 < n and src[i + 1] in _ESCAPABLE:
            if run is None:
                run = i
            i += 2
            continue

        # `.set` — only when a `{` actually follows (possibly after whitespace).
        if c == "." and src.startswith(".set", i):
            j = i + 4
            while j < n and src[j] in " \t\r\n":
                j += 1
            if j < n and src[j] == "{":
                flush(i)
                toks.append(Tok(SET, ".set", i))
                i += 4
                continue

        # LoRA item.
        if c == "<":
            m = _LORA_RE.match(src, i)
            if m:
                flush(i)
                toks.append(Tok(LORA, m.group(0), i))
                i = m.end()
                continue

        # Double-quoted string (only when it actually closes on the same line).
        if c == '"':
            j = i + 1
            while j < n and src[j] != '"' and src[j] != "\n":
                j += 2 if src[j] == "\\" else 1
            if j < n and src[j] == '"':
                flush(i)
                toks.append(Tok(STRING, src[i : j + 1], i))
                i = j + 1
                continue

        if c in _STRUCT:
            flush(i)
            toks.append(Tok(_STRUCT[c], c, i))
            i += 1
            continue

        if run is None:
            run = i
        i += 1

    flush(n)
    toks.append(Tok(EOF, "", n))
    return toks


def unescape_out(raw: str) -> str:
    """Resolve escape pairs for the *compiled output*.

    A PLv3 `\\x` always means "the literal character x".  It is re-emitted with a
    backslash only when prompt-control needs one to read it back as a literal
    (`\\,` -> `,`, but `\\(` stays `\\(`).  Bare `:` and `#` are escaped on the way
    out for the same reason, even though the user never had to escape them.
    """
    out: list[str] = []
    i = 0
    n = len(raw)
    while i < n:
        c = raw[i]
        if c == "\\" and i + 1 < n and raw[i + 1] in _ESCAPABLE:
            nxt = raw[i + 1]
            if nxt in _PC_ESCAPABLE:
                out.append("\\")
            out.append(nxt)
            i += 2
            continue
        if c == "\\":
            out.append("\\\\")  # a literal backslash, escaped for prompt-control
            i += 1
            continue
        if c in _NEEDS_ESCAPE:
            out.append("\\")
        out.append(c)
        i += 1
    return "".join(out)


def unescape_bare(raw: str) -> str:
    """Resolve escape pairs to bare characters — for identifiers and paths."""
    out: list[str] = []
    i = 0
    n = len(raw)
    while i < n:
        c = raw[i]
        if c == "\\" and i + 1 < n and raw[i + 1] in _ESCAPABLE:
            out.append(raw[i + 1])
            i += 2
            continue
        out.append(c)
        i += 1
    return "".join(out)


def text_out(raw: str) -> str:
    """TEXT run -> output text: escapes resolved, whitespace runs collapsed.

    Leading / trailing whitespace is deliberately *kept* — an item may be built
    from several atoms (`foo (bar:1.2) baz`) and the spacing between them lives
    in these runs.  Callers strip the assembled item.
    """
    return _WS_RE.sub(" ", unescape_out(raw))


def ident(raw: str) -> str:
    """TEXT run -> a `.set{}` key / scalar value: escapes gone, whitespace gone."""
    return unescape_bare(raw).strip()


def unquote(raw: str) -> str:
    """STRING token -> its content, with `\\"` resolved."""
    body = raw[1:-1] if len(raw) >= 2 else raw
    return body.replace('\\"', '"').replace("\\\\", "\\")
