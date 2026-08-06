"""Prompt Library V3 — the library service (spec §5).

Two directions:

  expand()      library -> text.  A group becomes a `[path]: { ... }` block with its
                contents laid out inline and its identity kept in the header, which
                is how "pointer semantics" survive in plain text (spec §3.6).
  sync_text()   text -> library.  On blur, items written in a block that the group
                does not have are appended to it (spec §5.3).  Nothing is deleted,
                and nothing is marked disabled — "disabled" just means "not in the
                text", which the DB deliberately does not store (spec §5.2).

Cycle guard: expansion carries a stack, so even a library that somehow contains a
loop cannot hang the editor (spec §5.5, layer 2).
"""
from __future__ import annotations

from . import repo
from .diagnostics import E02, PLv3Error
from .parser import Group, Item, Lora, Text, parse

INDENT = "    "
MAX_EXPAND_DEPTH = 32


# --- library -> text --------------------------------------------------------


def _fmt_value(key: str, value) -> str | None:
    if value is None:
        return None
    if key == "format":
        return '"' + str(value).replace('"', '\\"') + '"'
    if key == "schedule":
        a, b = value
        return f"{{{_num(a)}, {_num(b)}}}"
    if key == "random_select":
        lo, hi = value if isinstance(value, (list, tuple)) else (value, value)
        return f"{lo}" if lo == hi else f"{lo}-{hi}"
    if key == "region":
        if isinstance(value, str):
            return value
        inner = ", ".join(
            f"{k}: {_fmt_region(k, v)}" for k, v in value.items() if v is not None
        )
        return "{" + inner + "}"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _num(value)
    return str(value)


def _fmt_region(key: str, value) -> str:
    if key == "mask" and isinstance(value, (list, tuple)):
        return "[" + ", ".join(_num(v) for v in value) + "]"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _num(value)
    return str(value)


def _num(v) -> str:
    return f"{float(v):g}"


def _ends_sentence(text: str) -> bool:
    """An item that already ends in a full stop carries its own separator (spec update
    2026-08-05): the period splits items and stays with the one it ends."""
    return text.rstrip().endswith(".")


def join_items(parts: list[str]) -> str:
    """Write a list of items back out as prompt text.

    `, ` between them — except after one that ends in a full stop, which would give
    `a cat., on a mat.` The period IS the separator there, so a space is all that is
    needed, and re-parsing the result gives back exactly these items.
    """
    out: list[str] = []
    for i, p in enumerate(parts):
        if i:
            out.append(" " if _ends_sentence(parts[i - 1]) else ", ")
        out.append(p)
    return "".join(out)


def render_settings(settings: dict) -> str:
    parts = []
    for key, value in (settings or {}).items():
        rendered = _fmt_value(key, value)
        if rendered is not None:
            parts.append(f"{key}: {rendered}")
    return ".set{" + ", ".join(parts) + "}" if parts else ""


def _item_text(item: dict, weight_override=None) -> str:
    text = item["text"]
    weight = weight_override if weight_override is not None else item.get("weight")
    if weight is not None and abs(float(weight) - 1.0) > 1e-9:
        return f"({text}:{_num(weight)})"
    return text


def expand(group_id: int, preset_id: int | None = None, body: dict | None = None,
           indent: str = "", stack: tuple[int, ...] = ()) -> str:
    """Render a library group as a `[path]: { ... }` block, refs expanded inline.

    `body` is a preset body applied directly — that is how §5.4's *embedded*
    snapshots reach a nested group, which has no preset row of its own.
    """
    if group_id in stack:
        raise PLv3Error(E02, f"circular library reference at group {group_id}")
    if len(stack) >= MAX_EXPAND_DEPTH:
        raise PLv3Error(E02, "library references nested too deep")

    group = repo.get_group(group_id)
    if group is None:
        raise ValueError(f"no such group: {group_id}")
    path = repo.group_path(group_id)
    items = repo.list_items(group_id)
    settings = dict(group["settings"])

    if body is None and preset_id is not None:
        preset = repo.get_preset(preset_id)
        if preset and int(preset["group_id"]) == group_id:
            body = preset["body"]

    if body is not None:
        settings = dict(body.get("settings") or settings)
        items = _apply_whitelist(items, body.get("items") or [])

    children_spec = (body or {}).get("children") or {}
    # A weight written in a block is the PRESET's, not the library's: re-weighting an
    # item in one document must not silently re-weight it in every other document that
    # references the same group.  The library item keeps its own default weight.
    weights = {str(k): v for k, v in ((body or {}).get("weights") or {}).items()}

    inner = indent + INDENT
    chunks: list[str] = []
    run: list[str] = []  # consecutive plain items, waiting to share a line

    def flush() -> None:
        # A run of prompts goes on ONE line: a 35-item group with one item per line is
        # a page of scrolling for something you read as a single list. A nested block
        # breaks the run, and the items after it start a fresh one — so the text still
        # shows, at a glance, which prompts sit either side of a group.
        if run:
            chunks.append(inner + join_items(run) + ("" if _ends_sentence(run[-1]) else ","))
            run.clear()

    for item in items:
        if item["kind"] == "ref" and item["ref_group_id"]:
            flush()
            # Spec §3.6: a nested library group is expanded inline but keeps its own
            # header, so the compiler and the detail page still know whose it is.
            child = children_spec.get(str(item["id"])) or {}
            mode = child.get("mode")
            chunks.append(
                expand(
                    int(item["ref_group_id"]),
                    preset_id=child.get("preset_id") if mode == "preset" else None,
                    body=child if mode == "snapshot" else None,
                    indent=inner,
                    stack=stack + (group_id,),
                )
            )
        else:
            run.append(_item_text(item, weights.get(str(item["id"]))))
    flush()

    tail = render_settings(settings)
    if not chunks:
        return f"{indent}[{path}]: {{}}{tail}"
    body_text = "\n".join(chunks)
    return f"{indent}[{path}]: {{\n{body_text}\n{indent}}}{tail}"


def _apply_whitelist(items: list[dict], whitelist: list) -> list[dict]:
    """Spec §5.4: a preset is a whitelist *and* an order.  Items added to the group
    after the preset was saved are not in it, so they load off — a preset is a strict
    snapshot and library edits never leak into it.

    An id can only mean "this item is on", so it appears at most once.  A whitelist that
    somehow holds it twice (a preset saved off text that had the item written twice)
    renders the item twice, and the copy then survives every future save.  Deduping here
    heals those presets on load instead of leaving them to breed.
    """
    by_id = {int(i["id"]): i for i in items}
    out = []
    seen: set[int] = set()
    for raw in whitelist:
        item_id = int(raw)
        if item_id in seen:
            continue
        item = by_id.get(item_id)
        if item is not None:
            seen.add(item_id)
            out.append(item)
    return out


# --- text -> library --------------------------------------------------------


def _source(src: str, node) -> str:
    return src[node.pos : node.end]


def _is_blank(src: str, node) -> bool:
    """A child that is only whitespace or separators — not something the user wrote."""
    return isinstance(node, Text) and not _source(src, node).strip(" \t\r\n,")


def block_entries(src: str, group: Group) -> list[dict]:
    """What a `[path]: { ... }` block contains, in text order.

    Prompts and nested library blocks are interleaved, and their order changes the
    image, so they are enumerated together rather than as two lists.

    A `(tag:1.2)` in the text is one item at weight 1.2 — the weight belongs to the
    row, not to the item's text, or `UNIQUE(group_id, text)` could not find the item
    again after a re-weight.
    """
    out: list[dict] = []
    for child in group.children:
        if isinstance(child, (Text, Lora, Item)):
            text = _source(src, child).strip()
            if text:
                out.append({"kind": "item", "text": text, "weight": None})
        elif isinstance(child, Group):
            if child.header:
                out.append({"kind": "ref", "header": child.header, "block": child})
            elif (
                child.paren
                and len(child.children) == 1
                and isinstance(child.children[0], (Text, Lora))
                and child.settings.weight is not None
            ):
                text = _source(src, child.children[0]).strip()
                if text:
                    out.append({"kind": "item", "text": text, "weight": child.settings.weight})
            else:
                # An inline group written inside a block — `{a, b}.set{random_select: 1}`,
                # which is what PLv2's `{a|b}` migrates to. It is one item whose text
                # happens to be a group; storing it verbatim keeps it round-tripping.
                text = _source(src, child).strip()
                if text:
                    out.append({"kind": "item", "text": text, "weight": None})
    return out


def block_items(src: str, group: Group) -> list[tuple[str, float | None]]:
    """Just the prompt/lora items of a block — what blur-sync appends."""
    return [(e["text"], e["weight"]) for e in block_entries(src, group) if e["kind"] == "item"]


def find_blocks(src: str) -> list[Group]:
    """Every `[path]: { ... }` block in a document, outermost first."""
    root, _ = parse(src)
    found: list[Group] = []

    def walk(node):
        if isinstance(node, Group):
            if node.header:
                found.append(node)
            for child in node.children:
                walk(child)
        elif isinstance(node, Item):
            for atom in node.atoms:
                walk(atom)

    walk(root)
    return found


def sync_text(src: str) -> dict:
    """Blur-sync (spec §5.3): append items written in a block but missing from its
    group.  Returns what happened, per block.

    A nested `[other]: { … }` block is an item too — a ref.  Pasting one into a group's
    block and having the library quietly not know about it is the same silent loss §5.3
    exists to prevent: the block would then vanish from any preset saved off that text,
    because a preset is a whitelist of the group's item ids and it had no id.
    """
    report: list[dict] = []
    for block in find_blocks(src):
        group_id = repo.find_by_path(block.header)
        if group_id is None:
            # W09: an unknown path is not an error — the block still compiles, it
            # just has no library behind it.
            report.append({"path": block.header, "found": False, "added": 0})
            continue
        texts = [t for t, _w in block_items(src, block)]
        added = repo.write(repo.AppendNewItemsOp(group_id=group_id, texts=texts))
        refs_added, ref_errors = _sync_refs(src, block, group_id)
        entry = {
            "path": block.header,
            "found": True,
            "group_id": group_id,
            "added": len(added) + len(refs_added),
            "refs_added": len(refs_added),
        }
        if ref_errors:
            entry["ref_errors"] = ref_errors
        report.append(entry)
    return {"blocks": report}


def _sync_refs(src: str, block: Group, group_id: int) -> tuple[list[int], list[str]]:
    """Add a ref item for every nested library block the group does not already have."""
    have = {
        int(i["ref_group_id"])
        for i in repo.list_items(group_id)
        if i["kind"] == "ref" and i["ref_group_id"]
    }
    added: list[int] = []
    errors: list[str] = []
    for entry in block_entries(src, block):
        if entry["kind"] != "ref":
            continue
        target = repo.find_by_path(entry["header"])
        if target is None or target in have:
            continue  # unknown path = W09, already handled by the block's own report
        try:
            added.append(repo.write(
                repo.AddItemOp(group_id=group_id, kind="ref", ref_group_id=target)))
            have.add(target)
        except Exception as exc:  # a cycle (§5.5 layer 1) — refuse the ref, keep the text
            errors.append(f"{entry['header']}: {exc}")
    return added, errors


# --- a selection -> a new group ---------------------------------------------


def create_group_from_text(name: str, text: str, folder_id: int | None = None,
                           parent_group_id: int | None = None) -> dict:
    """Turn a chunk of a document into a NEW library group.

    The chunk is parsed as a document and its top-level entries become the group's
    items — prompts, loras, and a nested `[path]: { … }` block as a ref — read out by
    exactly the same `block_entries` the blur-sync uses, so a selection lands in the
    library the way the same text would have landed had it been written inside a block.

    What this CANNOT represent faithfully: a group is a flat list of items, and a
    region or schedule block is a tree.  One of those in the selection is stored as a
    single item whose text happens to be the whole construct — it round-trips and it
    compiles, but it is one row rather than a list you can switch parts of on and off.
    Saving the *document* (the `documents` table) is what keeps that structure whole.
    """
    root, _diags = parse(text, recover=True)

    # Selecting exactly one group — `{a, b}.set{schedule: {0, 0.5}}` — means "save THAT",
    # so descend into it and adopt its settings. Otherwise the settings would be dropped
    # on the floor and the group would come back as a bare list, which is the one thing
    # `groups.settings_json` exists to prevent. (Nothing else in the UI writes that
    # column, so this is the only way a group gets a region or a schedule of its own.)
    settings: dict = {}
    inner = [c for c in root.children if not _is_blank(text, c)]
    if len(inner) == 1 and isinstance(inner[0], Group) and not inner[0].header:
        settings = _settings_of(inner[0])
        if settings:
            root = inner[0]

    entries = block_entries(text, root)
    if not entries:
        raise ValueError("nothing to save — that selection has no items in it")

    group_id = repo.write(repo.CreateGroupOp(
        name=name, folder_id=folder_id, parent_group_id=parent_group_id,
        settings=settings))

    seen: set[str] = set()
    refs: set[int] = set()
    for entry in entries:
        if entry["kind"] == "ref":
            target = repo.find_by_path(entry["header"])
            if target is not None and target not in refs:
                try:
                    repo.write(repo.AddItemOp(
                        group_id=group_id, kind="ref", ref_group_id=target))
                    refs.add(target)
                    continue
                except repo.CycleError:
                    pass  # a loop (§5.5 layer 1) — fall through and keep the text
            elif target in refs:
                continue
            # W09, or a ref refused: keep the block as verbatim text rather than
            # dropping it. Losing part of a selection the user asked to save is worse
            # than storing it as a plain item.
            body = _source(text, entry["block"]).strip()
            if body and body not in seen:
                seen.add(body)
                repo.write(repo.AddItemOp(group_id=group_id, text=body))
            continue

        item_text = entry["text"]
        # The same prompt twice in one selection is still ONE item — `UNIQUE(group_id,
        # text)` says so, and inserting it twice would fail the whole save.
        if item_text in seen:
            continue
        seen.add(item_text)
        repo.write(repo.AddItemOp(
            group_id=group_id,
            kind="lora" if item_text.startswith("<lora:") else "prompt",
            text=item_text,
            weight=entry["weight"],
        ))

    return {"id": group_id, "path": repo.group_path(group_id)}


# --- presets ----------------------------------------------------------------


def links_of(body: dict | None) -> dict[str, int]:
    """The links a stored preset body holds: `{nested path: preset id}`.

    A link is `children[ref] = {mode: 'preset', preset_id}` (§5.4) — "this nested group
    follows that named preset of its own, and keeps following it".  The DB keys children
    by ref-item id; the UI thinks in paths, so translate once, here.
    """
    out: dict[str, int] = {}
    for ref_id, child in ((body or {}).get("children") or {}).items():
        if child.get("mode") != "preset" or child.get("preset_id") is None:
            continue
        item = repo.get_item(int(ref_id))
        if item and item["ref_group_id"]:
            out[repo.group_path(int(item["ref_group_id"]))] = int(child["preset_id"])
    return out


def write_through(src: str, block: Group, links: dict[str, int],
                  established: dict[str, int] | None = None) -> list[str]:
    """A linked block is not this preset's to keep — it is a window onto another one.

    So an edit made inside it is an edit to THAT preset, and saving writes it there
    (the user's call).  The link survives; the shared preset changes, and so does every
    other preset and document that follows it.  That is what a link is for, and it is
    why the UI has to say "shared" where the edit is made.

    `established` is the set of links this preset ALREADY had.  A link that is being made
    right now is not written through, and that is not a detail: at the moment you link a
    block, what is on screen is still the OLD contents, and writing them through would
    overwrite the very preset you just chose to follow.  Linking ADOPTS the preset's
    contents; only edits made afterwards flow back into it.

    Returns the paths written through, for the report.
    """
    established = established or {}
    written: list[str] = []
    for entry in block_entries(src, block):
        if entry["kind"] != "ref":
            continue
        preset_id = links.get(entry["header"])
        if preset_id is None:
            continue
        if established.get(entry["header"]) != preset_id:
            continue   # a link made just now: adopt, never clobber
        preset = repo.get_preset(preset_id)
        if preset is None:
            continue   # a dangling link: expansion already falls back to the group
        child_block = entry["block"]
        # ...and the linked preset may itself hold links. They are its own business, so
        # they are read from what it stored, not from what this document says — and they
        # are all established, by definition.
        child_links = links_of(preset["body"])
        write_through(src, child_block, child_links, established=child_links)
        body = build_preset_body(src, child_block, links=child_links)
        repo.write(repo.SavePresetOp(
            group_id=int(preset["group_id"]), name=preset["name"], body=body))
        written.append(entry["header"])
    return written


def build_preset_body(src: str, block: Group, links: dict[str, int] | None = None) -> dict:
    """Snapshot a block as a preset body (spec §5.4).

    `items` is the enable whitelist *and* the order — refs live in it too, because a
    ref sits between prompts in the text and moving it changes the image.  `children`
    then says what state each ref was in: an embedded snapshot, or — when the ref is
    LINKED — a pointer to the nested group's own named preset, which keeps following it.
    """
    links = links or {}
    group_id = repo.find_by_path(block.header)
    if group_id is None:
        raise ValueError(f"unknown library path: {block.header}")

    rows = {r["text"]: r for r in repo.list_items(group_id)}
    ids: list[int] = []
    children: dict[str, dict] = {}
    weights: dict[str, float] = {}

    for entry in block_entries(src, block):
        if entry["kind"] == "item":
            row = rows.get(entry["text"])
            if row is None:
                continue
            item_id = int(row["id"])
            if item_id in ids:
                # The same prompt written twice in one block is still ONE item of the
                # group (that is what UNIQUE(group_id, text) means).  Recording it twice
                # would make the preset render it twice — and since the preset is then
                # saved back off its own expansion, the duplicate would breed (W06).
                continue
            ids.append(item_id)
            # A weight written in the block belongs to THIS preset (the user's call):
            # the library item keeps its own default, so re-weighting an item here does
            # not reach into every other document that references the group.
            if entry["weight"] is not None:
                weights[str(item_id)] = entry["weight"]
            continue
        ref_id = _ref_item_id(group_id, entry["header"])
        if ref_id is None:
            continue
        ids.append(ref_id)
        linked = links.get(entry["header"])
        if linked is not None:
            # LINKED: this preset does not carry the nested block's contents at all, it
            # carries the name of the preset to ask. Storing a snapshot alongside would
            # be a second, stale answer to the same question.
            children[str(ref_id)] = {"mode": "preset", "preset_id": int(linked)}
        else:
            children[str(ref_id)] = {"mode": "snapshot", **build_preset_body(src, entry["block"])}

    return {
        "items": ids,
        "weights": weights,
        "settings": _settings_of(block),
        "children": children,
    }


def _ref_item_id(group_id: int, target_path: str) -> int | None:
    target = repo.find_by_path(target_path)
    if target is None:
        return None
    for item in repo.list_items(group_id):
        if item["kind"] == "ref" and item["ref_group_id"] == target:
            return int(item["id"])
    return None


def _settings_of(group: Group) -> dict:
    s = group.settings
    out: dict = {}
    if s.weight is not None:
        out["weight"] = s.weight
    if s.format:
        out["format"] = s.format
    if s.shuffle:
        out["shuffle"] = True
    if s.random_select:
        out["random_select"] = list(s.random_select)
    if s.dropout:
        out["dropout"] = s.dropout
    if s.seed is not None:
        out["seed"] = s.seed
    if s.schedule:
        out["schedule"] = list(s.schedule)
    if s.region:
        r = s.region
        region: dict = {"kind": r.kind}
        if r.mask:
            region["mask"] = list(r.mask)
        if r.imask is not None:
            region["imask"] = r.imask
        if r.feather:
            region["feather"] = r.feather
        if r.mask_weight != 1.0:
            region["mask_weight"] = r.mask_weight
        if r.cond_weight != 1.0:
            region["cond_weight"] = r.cond_weight
        if r.include_in_base:
            region["include_in_base"] = True
        out["region"] = region
    return out
