"""PLv3 validation — the checks of spec §6 that need a whole-tree view.

    E01  a region group nested inside another region group
    E02  circular library-group reference (structurally impossible in a parsed
         text tree; the guard stays here as the compiler's last line of defence
         once P4 lets the library expand refs)
    W06  the same prompt written twice inside one library block
    W13  a region declared in a Negative node -> region stripped, content merged
         into the main segment

Everything else is caught by the parser (E03, W01–W04, W07, W08, W10, W14) or by
the IR / backends (W05, W11, W12).
"""
from __future__ import annotations

from .diagnostics import E01, W06, W13, Diagnostics, PLv3Error
from .parser import Group, Item, Lora, Node, Text


def validate(root: Group, diags: Diagnostics, allow_region: bool = True,
             src: str | None = None) -> None:
    """Check the tree and apply the in-place degradations.  Raises on E-codes."""
    if not allow_region:
        _strip_regions(root, diags)
    _check_region_nesting(root, in_region=False)
    if src is not None:
        _check_block_duplicates(root, diags, src)


def _check_block_duplicates(node: Node, diags: Diagnostics, src: str) -> None:
    """W06 — the same prompt twice in one `[path]: { … }` block.

    A library group holds an item at most once (UNIQUE(group_id, text)), so a block
    that names the same prompt twice is saying something the library cannot mean.  It
    is not an error — the text still compiles, and the tag is simply emitted twice —
    but it must not pass unremarked: a preset saved off that block used to record the
    item once per occurrence, and the duplicate then bred on every save.

    Only the block's OWN items count.  A nested block is a different group, and a
    prompt may of course appear in both (the user's rule: uniqueness is per group).
    """
    if not isinstance(node, Group):
        return
    if node.header:
        seen: dict[str, int] = {}
        for child in node.children:
            if isinstance(child, Group) and child.header:
                continue                      # a nested block: a different group
            text = _item_key(child, src)
            if text is None:
                continue
            if text in seen:
                diags.warn(W06, f"'{text}' is already in [{node.header}]", child.pos)
            else:
                seen[text] = child.pos
    for child in node.children:
        _check_block_duplicates(child, diags, src)


def _item_key(child: Node, src: str) -> str | None:
    """What the row would be stored as: the prompt text, with any `(…:w)` peeled off —
    the weight lives on the row, not in the text (§5.3)."""
    if isinstance(child, (Text, Lora, Item)):
        return src[child.pos : child.end].strip() or None
    if (
        isinstance(child, Group)
        and child.paren
        and len(child.children) == 1
        and isinstance(child.children[0], (Text, Lora))
    ):
        inner = child.children[0]
        return src[inner.pos : inner.end].strip() or None
    return None


def _strip_regions(node: Node, diags: Diagnostics) -> None:
    if isinstance(node, Group):
        if node.settings.region is not None:
            diags.warn(W13, pos=node.pos)
            node.settings.region = None
        for child in node.children:
            _strip_regions(child, diags)
    elif isinstance(node, Item):
        for atom in node.atoms:
            _strip_regions(atom, diags)


def _check_region_nesting(node: Node, in_region: bool) -> None:
    if isinstance(node, Group):
        here = node.settings.region is not None
        if here and in_region:
            raise PLv3Error(E01, pos=node.pos)
        for child in node.children:
            _check_region_nesting(child, in_region or here)
    elif isinstance(node, Item):
        for atom in node.atoms:
            _check_region_nesting(atom, in_region)
