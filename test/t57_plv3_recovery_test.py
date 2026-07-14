"""PLv3 — parser error recovery (the editor's parse mode).

Two modes, two contracts:

  strict     the node.  A document that does not parse must RAISE, because rendering
             an image from a document nobody could read is worse than failing.

  recovering the editor.  A broken construct must not take the document down with it:
             what parses is returned, the break is reported as E03, and the detail page
             and preview keep working on the rest.
"""
import pytest

from prompt_library_v3.compile import compile_text
from prompt_library_v3.diagnostics import PLv3Error
from prompt_library_v3.parser import Group, Text, parse


def texts(root):
    """Every plain item in the tree, flattened — 'what survived'."""
    out = []
    for c in root.children:
        if isinstance(c, Text):
            out.append(c.text.strip())
        elif isinstance(c, Group):
            out.extend(texts(c))
        elif hasattr(c, "atoms"):
            out.extend(a.text.strip() for a in c.atoms if isinstance(a, Text))
    return [t for t in out if t]


def errors(diags):
    return [d for d in diags if d.is_error]


# --- strict mode still refuses -------------------------------------------------

@pytest.mark.parametrize("src", [
    "a, { b",              # unclosed brace
    "a, (b:1.2",           # unclosed paren
    "a, [demo.x",          # unclosed bracket
    "a, } b",              # stray closer
])
def test_strict_mode_raises(src):
    with pytest.raises(PLv3Error):
        parse(src)
    with pytest.raises(PLv3Error):
        compile_text(src)


# --- recovering mode keeps the document ----------------------------------------

def test_unclosed_brace_keeps_what_is_inside_and_around():
    root, diags = parse("quality, { score_9, score_8\n\nmasterpiece", recover=True)
    assert errors(diags), "the break must still be reported"
    # An unclosed `{` runs to the end of the document — that is what it literally says.
    # What matters is that nothing is DROPPED: before, inside and after all survive.
    blob = " ".join(texts(root))
    assert "quality" in blob and "score_9" in blob and "masterpiece" in blob


def test_stray_closer_is_dropped_not_fatal():
    root, diags = parse("a, } b, c", recover=True)
    assert errors(diags)
    assert texts(root) == ["a", "b", "c"]


def test_broken_line_does_not_eat_the_next_one():
    """An unclosed paren is contained to its own line — it must not swallow the rest of
    the document, or every item below a half-typed `(` disappears from the panel."""
    root, diags = parse("1girl,\n(blonde hair:1.2\nsmile, closed eyes", recover=True)
    assert errors(diags)
    blob = " ".join(texts(root))
    assert "1girl" in blob and "blonde hair" in blob
    assert "smile" in blob and "closed eyes" in blob


def test_a_document_that_never_parsed_still_compiles_something():
    """The point of the whole change: the preview is not blank for a doc that has
    never been valid — not just for one that used to be."""
    res = compile_text("masterpiece, { detailed\n\n[@region base] {\n  1girl", recover=True)
    assert errors(res.diagnostics)
    assert res.ast is not None
    assert "masterpiece" in res.text
    assert "1girl" in res.text


def test_library_block_after_a_break_survives():
    src = "a, ( b\n\n[demo.scores]: {\n  score_9, score_8\n}\n\nz"
    root, diags = parse(src, recover=True)
    assert errors(diags)
    heads = [c.header for c in root.children if isinstance(c, Group) and c.header]
    assert "demo.scores" in heads
    assert "z" in texts(root)


def test_recovery_does_not_hang_on_pathological_input():
    for src in ["{" * 200, "}" * 200, "[" * 100, "(" * 100, "{[(" * 50]:
        root, diags = parse(src, recover=True)
        assert root is not None


def test_valid_documents_are_identical_in_both_modes():
    src = "masterpiece, {a, b}.set{weight: 1.2}, <lora:x:0.8>"
    strict, _ = parse(src)
    loose, diags = parse(src, recover=True)
    assert not errors(diags)
    assert texts(strict) == texts(loose)
    assert compile_text(src).text == compile_text(src, recover=True).text
