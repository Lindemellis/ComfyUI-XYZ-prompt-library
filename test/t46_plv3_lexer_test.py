# T46 — PLv3 lexer: escapes, structural tokens, LoRA, strings (spec §3.1)
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from prompt_library_v3 import lexer as lx


def kinds(src):
    return [t.kind for t in lx.tokenize(src)]


def test_structural_chars_each_get_a_token():
    assert kinds("{a,(b:1)}") == [
        lx.LBRACE, lx.TEXT, lx.COMMA, lx.LPAREN, lx.TEXT, lx.COLON,
        lx.TEXT, lx.RPAREN, lx.RBRACE, lx.EOF,
    ]


def test_escaped_reserved_chars_stay_inside_text():
    toks = lx.tokenize(r"a\(b\{c\}")
    assert [t.kind for t in toks] == [lx.TEXT, lx.EOF]
    assert toks[0].raw == r"a\(b\{c\}"


def test_comma_cannot_be_escaped_it_always_separates():
    # `\,` is not an escape pair: a subgroup `{a, b}` is how you keep two tags as
    # one unit, so a comma never needs to hide inside an item
    toks = lx.tokenize(r"a\, b")
    assert [t.kind for t in toks] == [lx.TEXT, lx.COMMA, lx.TEXT, lx.EOF]


def test_set_token_only_when_a_brace_follows():
    assert lx.SET in kinds("{a}.set{weight: 1}")
    assert lx.SET not in kinds("some.setting, tag")
    # whitespace between `.set` and `{` is allowed
    assert lx.SET in kinds("{a}.set {weight: 1}")


def test_lora_is_one_token():
    toks = lx.tokenize("1girl, <lora:my_lora:1.0:0.8>, 2girls")
    lora = [t for t in toks if t.kind == lx.LORA]
    assert len(lora) == 1
    assert lora[0].raw == "<lora:my_lora:1.0:0.8>"


def test_lone_angle_bracket_is_plain_text():
    assert lx.LORA not in kinds("a < b, c > d")


def test_string_token_needs_a_closing_quote_on_the_same_line():
    assert lx.STRING in kinds('.set{format: "masterpiece $p"}')
    # an unterminated quote is just text, so a stray `"` cannot eat the document
    assert lx.STRING not in kinds('a " b')


def test_apostrophes_are_plain_text():
    toks = lx.tokenize("girls' frontline, sailor's uniform")
    assert [t.kind for t in toks] == [lx.TEXT, lx.COMMA, lx.TEXT, lx.EOF]


def test_unescape_out_matches_prompt_controls_escape_table():
    # prompt-control unescapes `\\ \[ \] \: \#` to the bare character and hands
    # `\( \)` on to the weight parser with the backslash intact
    assert lx.unescape_out(r"smile \(cat\)") == r"smile \(cat\)"
    assert lx.unescape_out(r"a\\b") == r"a\\b"
    # `{` `}` are only reserved by PLv3 -> emit the bare character
    assert lx.unescape_out(r"\{x\}") == "{x}"


def test_a_backslash_before_a_non_escapable_char_is_a_literal_backslash():
    # `\,` is not an escape, so the backslash is text — and a literal backslash
    # must go out as `\\` or prompt-control would eat it
    assert lx.unescape_out(r"a\ b") == r"a\\ b"
    assert lx.unescape_out(r"\<x\>") == r"\\<x\\>"


def test_bare_colon_and_hash_are_escaped_on_the_way_out():
    # the user never escapes these, but a bare `:` inside a `[text, :s,e]` wrapper
    # would be read as a schedule separator, and a bare `#` starts a PC comment
    assert lx.unescape_out("artist:wlop") == r"artist\:wlop"
    assert lx.unescape_out("tag #1") == r"tag \#1"


def test_text_out_collapses_whitespace_but_keeps_the_edges():
    assert lx.text_out("  blonde   hair\n") == " blonde hair "


def test_ident_and_unquote():
    assert lx.ident("  weight ") == "weight"
    assert lx.unquote('"masterpiece $p"') == "masterpiece $p"
    assert lx.unquote(r'"a \"b\""') == 'a "b"'


def test_positions_are_source_offsets():
    toks = lx.tokenize("ab,cd")
    assert toks[1].kind == lx.COMMA and toks[1].pos == 2
