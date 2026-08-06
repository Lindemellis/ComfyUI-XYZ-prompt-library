# Prompt Library V3

A prompt language, an editor for it, and a library that feeds it.

PLv3 replaces [Prompt Library V2](../prompt_library_v2/README.md). Both can be installed at
the same time — they are separate nodes and separate databases — but a document written in
one means nothing to the other. There is a [migration tool](#migrating-from-v2).

**Requires [comfyui-prompt-control](https://github.com/asagi4/comfyui-prompt-control)**: PLv3
does not talk to CLIP itself. It compiles your text into prompt-control's syntax and hands it
over as a string.

---

## The one idea

**The text is the truth.**

A PLv3 document is a piece of text, and everything else — the detail page with its switches
and sliders, the library, the presets — is a view onto it. Nothing is stored twice. Turning a
switch off does not set an `enabled = false` somewhere; it deletes the item from the text.
Compilation is a pure function of `(text, seed, region_mode)` and **never reads the library**:
a workflow you send to someone else carries everything it needs, and it will render the same
image on their machine, with no database of yours.

That is the whole design. Most of what follows is a consequence of it.

---

## The nodes

| Node | Output |
|---|---|
| **XYZ Prompt Library V3** | `STRING` — prompt-control syntax (plain textarea) |
| **XYZ Prompt Library V3 Monaco** | `STRING` — same output; the text box is the full editor (library autocomplete, folding, tag lookup) |

Both nodes compile identically — pick the one whose editor you prefer. There is no
positive/negative split: a document renders the same either way. **Regions are for the
positive prompt only** — a region has no meaning on the negative side, and nothing stops
you writing one there, so just don't. Wire each node's output to the matching
(positive / negative) `PC: Schedule Prompt`.

Widgets: `text` (the document), `seed` (the random source for `shuffle` / `random_select` /
`dropout`), `region_mode` (`couple` or `mask` — see [Regions](#regions)).

Wire the output into prompt-control's text input. Press **Editor** on the node — or open
*XYZ Tools → Prompt Library V3 — Editor* in the top bar — for the real thing.

---

## Syntax

### Items

Comma-separated, like any prompt. Weights use the attention syntax:

```
masterpiece, best quality, (blonde hair:1.2), <lora:add_detail:0.6>
```

A LoRA's weight lives **inside** the brackets — `(<lora:x:0.6>:1.2)` does nothing, and the
editor's slider knows that.

**A full stop separates items too**, so a prose prompt breaks into sentences the same way a
tag list breaks into tags. The two separators differ in one way, and it is the point of
having both:

| | |
|---|---|
| `,` | punctuation *between* items — **dropped** |
| `.` | part of the item it *ends* — **kept** |

```
tag1, tag2. tag3. tag4, tag5
```

is five items: `tag1`, `tag2.`, `tag3.`, `tag4`, `tag5`. Each one gets its own row and its
own switch in the detail page, and each is stored in the library as written — with its
full stop.

A `.` separates **only when whitespace or the end of the text follows it**. That one rule
is what leaves the other four meanings of a dot alone:

```
[characters.illya]: { … }     a library path
{ … }.set{weight: 1.2}        a settings block
.set{dropout: 0.35}           a decimal
<lora:add_detail:0.6>         a LoRA's weight
```

Write `a.b` and you get one item; write `a. b` and you get two.

Joining works the same way in reverse: an item that already ends in a full stop is followed
by a space, never a comma — `a cat. on a mat.`, not `a cat., on a mat.`

### Groups

A group is `{ … }`, and `.set{ … }` gives it settings:

```
{
    depth of field, cinematic lighting, rim light, backlighting,
}.set{random_select: 2-3, shuffle: true, seed: 7}
```

| Setting | Meaning |
|---|---|
| `weight: 1.1` | wrap the whole group: `(…:1.1)` |
| `format: "($p:1.05)"` | rewrite each item; `$p` is the item |
| `shuffle: true` | shuffle the items on every run |
| `random_select: 2-3` | keep 2–3 of them at random |
| `dropout: 0.2` | drop each item with probability 0.2 |
| `seed: 7` | lock **this group's** random source |
| `schedule: {0.2, 0.8}` | the group only lives in that slice of the run |
| `region: {…}` | the group becomes its own region segment |

Groups nest. Randomness is seeded per group by its position in the tree, so an unrelated edit
elsewhere in the document does not reshuffle it.

### Schedules

`[@schedule]` is sugar for a group of groups, each with a time window:

```
[@schedule]: {
    0 - 0.3: closed eyes,
    0.3 - 1: { open eyes, looking at viewer },
}
```

An entry's content may be a bare item or a whole group. **The number between two entries is
one boundary**: each entry's start wins, and the previous entry's end is rewritten to match it,
so gaps and overlaps cannot exist. The editor's slider moves both sides at once.

### Regions

`[@region]` splits the prompt into spatial segments:

```
[@region]: {
    [base]: { 2girls, yuri, side-by-side }

    [imask: 0, feather: 12, include_in_base: true]: {
        (illyasviel von einzbern:1.15), blonde hair,
    }

    [mask: [0.5, 1, 0, 1], feather: 12]: {
        (miyu edelfelt:1.15), black hair,
    }

    [fill]: { detailed background, bokeh }
}
```

**The header is always `[<kind>, <params>]`, and the kind always comes first.** `base` and
`fill` are bare words (they carry no value of their own); `mask: [x1, x2, y1, y2]` and
`imask: i` are the kind and its value in one. Parameters follow, in any order:

```
[base, mask_weight: 0.5]        [fill, cond_weight: 0.8]
[imask: 0, feather: 12]         [mask: [0, 0.5, 0, 1], mask_weight: 0.4]
```

The bare forms `base: { … }` / `fill: { … }` still parse — old documents keep working — but
everything the detail page writes uses the bracketed shape, so a header no longer changes
form the moment you touch a slider.

Inside a `[@region]` block, typing `[` offers the four kinds — **base, mask, imask, fill** — and
completes the whole segment head for you. It only fires where a segment can actually start: not
inside a `mask: [ … ]` rectangle, and not inside a segment's body (where `[` means a library
path, as everywhere else).

Two rules that are easy to get wrong, and both are deliberate:

- **Ambient text is copied into every segment.** A segment is *everything outside any region
  group* (the ambient text of the document) **plus that group's own content**, spliced in text
  order. So `masterpiece` written at the top of the document appears in every segment — which
  is what you want, and what hand-writing region prompts usually gets wrong.
- **`imask: i` is the CLIP *attach order*, not the Mask Editor's output slot number.** Nothing
  can validate it for you; only your wiring knows.

`include_in_base: true` additionally copies a group's own content into the base segment, at its
position in the text — without leaking it into the *other* region segments. It works on any
region kind, `fill` included (a background written in the fill is often wanted in the full-image
base too); on a `base` group it would say nothing, so the detail page hides the switch there.
A region asking for it also *creates* the base segment when no `base` group was written.

`region_mode` on the node picks the backend: `couple` (attention couple) or `mask` (latent
mask, `AND` + `MASK`). When the kind is not stated it is *inferred* — a `mask:` field means a
mask region, an `imask:` field means an imask region, and nothing means `base`.

### The `plain` output

The node has a second output, **`plain`**: the same document with the region syntax **ignored**.
The base, every masked region and the fill all land in **one** prompt, in the order they were
written — no `COUPLE`, no `AND`, no `MASK` / `IMASK` / `FILL`. Everything else survives:
schedules, weights, shuffle, `random_select`, LoRAs.

```
prompt:  FILL() detailed background
         COUPLE 2girls
         COUPLE IMASK(0, 1) FEATHER(12 12 12 12) blonde hair
         COUPLE IMASK(1, 1) black hair

plain:   2girls, blonde hair, black hair, detailed background
```

This is **not** "the base region": a base region is one region among several, which you write
yourself and can weight and schedule like any other. `plain` has no regions in it at all. Use it
for whatever wants one ordinary prompt — a negative, a second pass, a refiner, a model with no
regional support — without keeping a second copy of the text in sync by hand.

Both outputs compile from the same document with the same seed, so a `shuffle` picks the same
words in both.

### Library blocks

A library group lands in a document as a **fully expanded block** that keeps its identity:

```
[demo.quality.anima]: {
    masterpiece,
    best quality,
    [demo.quality.scores]: {
        score_9,
        score_8_up,
    }
}.set{weight: 1.05}
```

The header is a name, not a pointer: the text already contains everything, and the compiler
never looks the path up. Delete the library and the document still renders.

### Escaping

`\` escapes `[ ] { } ( ) :` and itself. A colon inside a tag needs **no** escape in PLv3 source
— write `artist:wlop` — because only a trailing `:number` inside parentheses is a weight. On
*output*, PLv3 escapes what prompt-control's own parser needs (`\:`, `\#`), so what you type
survives to the sampler unchanged.

---

## The editor

Three panes, all resizable, all in a floating ComfyUI window.

**Node list · Editor + Preview · Detail page**

- **Editor** — Monaco, with syntax highlighting, folding, and the same danbooru autocomplete
  the rest of the pack uses (wiki links, preview images, artist works, related tags on click —
  see [Autocomplete](../tagdb/README.md)). Typing `[` offers the two special blocks
  (`@schedule`, `@region`) and every library path; picking a path inserts the **expanded block**,
  not a pointer. `Ctrl+Shift+H` is a find/replace that only touches prompt text — it will not
  rewrite `.set`, a field name, or a library path.
- **Preview** — the compiled prompt-control output, one tab per region segment. Collapsed by
  default.
- **Detail page** — the document as a tree of controls: a weight slider per item, a settings
  panel per group, a range slider for a schedule, a region panel, and a unified switch list for
  every library block. Each control rewrites **exactly the characters it owns**, so your blank
  lines and indentation survive an edit, and `Ctrl+Z` undoes a slider drag like it undoes typing.
  A group card's **⚙ gear and its fold arrow are independent** — you can read a region's mask
  settings without unrolling its whole prompt list.

### Switching items off

Every item has a switch: a tag, a LoRA, a nested group, a region segment, a schedule entry.
Switch one off and it **leaves the prompt but keeps its place** — it disappears from the text
(no marker, no commented-out line, nothing to trip over) and comes back **exactly where it was**
when you switch it on again. Nothing around it moves, and no other item is renumbered, so a
region's `imask` indices stay put.

That works because the text is not the whole story any more: the node also carries a
**document** — the same tree, plus a stable id and an on/off flag per item — in a hidden widget
that is saved with your workflow. The text is what the document's *enabled* items render to, and
it is still the thing that compiles, so a document you never touched is byte-for-byte the text
you typed.

> **Library blocks are the exception**, on purpose. An item inside a `[path]: { … }` block is
> enabled by *being in the block*, so its switch still removes it from the block and drops it
> into the group's disabled list at the bottom (§5.2). That is the behaviour described under
> [The library](#the-library), and it is unchanged.

**A broken document still works.** The editor parses in recovering mode: an unclosed brace is
reported (E03, with a squiggle and a glyph in the margin) and *skipped*, and everything around
it still compiles and still shows up in the detail page and the preview. The node, on the other
hand, parses strictly and refuses to run — silently rendering an image from a document nobody
could read is the one outcome worse than an error.

---

## The library

A creation-time aid, and nothing more. It is never on the execution path.

- **Groups** hold items. An item is a prompt, a LoRA, or a **ref** to another group — refs are
  how groups share (a group referenced by three others is one group, not three copies). Groups
  can also own **subgroups**; a subgroup is ownership, a ref is sharing. Both render as
  `[full.path]: { … }` in the text.
- **A group's items are unique by text.** The same prompt may of course appear in a subgroup, in
  a referenced group, and in the parent — the rule is per group. Writing it twice inside one
  block is a **W06** warning, not an error: the text is yours, and it is left exactly as written.
- **There is no `enabled` flag in the database.** An item is enabled *iff* it appears in the
  text. The disabled list you see in the detail page is computed: the group's items, minus the
  ones the text already has.
- **Blur-sync** (§5.3): items you typed into a `[path]: { … }` block that the group does not have
  get appended to it. Nothing is ever deleted — "disabled" is not a fact the database stores. So
  rewriting an item is automatically "add the new one, disable the old one", with no dialog.

### Presets

A preset is **which** of a group's items are on, **in what order**, with what settings. It is a
strict snapshot: items added to the group afterwards are not in it, so they load off, and a
library edit never leaks into a saved preset.

In a document, a block that *is* a preset's text says so (`◆ name`, `unchanged`); edit it and it
says `modified` and offers a one-click **overwrite**. That works from the text alone — it
survives a reload, a reopened window, a workflow shared with someone else.

### Links

A nested block inside a preset is either **copied** or **linked**:

| | |
|---|---|
| **copied** (default) | a snapshot. The nested group can change all it likes; this preset does not move. |
| **linked** 🔗 | it *follows* a named preset of the nested group, and keeps following it. |

Editing a linked block **edits the preset it follows** — which every other preset and document
that follows it will see. The panel says `shared` where you make the edit, because that is the
one thing about links you must not learn by surprise. Linking **adopts** the linked preset's
contents (the block's text is replaced by it); only edits made *afterwards* flow back.

Links live in a preset's body, so they exist only in the library window. A document is plain
text and has nowhere to keep one.

### Saving a selection as a group

Select part of a prompt in the editor, right-click → **PLv3: Save selection as a library group…**,
give it a name and a folder. The selection is **replaced by a reference to the new group**
(`[path]: { … }`) — because a copy that merely resembles the group would start drifting from it
the moment either one is edited, and a block header is the only thing in a document that points
back at the library. `Ctrl+Z` undoes the replacement.

If what you selected is exactly one group with settings — `{ closed eyes, smile }.set{schedule:
{0, 0.5}}` — the new group **keeps those settings**, region and schedule included. Select a bare
list of tags and you get a bare group.

What it cannot do faithfully: a group is a flat list of items, and a `[@region]` or `[@schedule]`
block is a tree. One of those inside the selection is stored as a **single item whose text is the
whole construct** — it round-trips and it compiles, but it is one row, not a list you can switch
parts of on and off. That is what saved documents are for.

### Saved documents

A group is a list of items. A **document** is the whole thing: several top-level constructs,
`[@region]` and `[@schedule]` blocks, the free text between them — a shape the group model
genuinely cannot hold. So a whole prompt is saved as its own kind of entry, shown in the library
tree as `▦ name` alongside the groups.

- **💾 Save** in the editor window's title bar stores the node's document under a name and a
  folder. Saving the same name in the same folder **replaces** it (it asks first).
- Both halves are stored: the text *and* the document JSON — so the items you **switched off**,
  which are by design nowhere in the text, come back with it. The detail page tells you how many
  there are.
- Clicking a saved document shows it read-only, with **⇥ load into the active node**. Loading
  **replaces** what is in the open node (`Ctrl+Z` in the editor undoes it). It is read-only on
  purpose: editing a snapshot in place would mean deciding whether the change belongs to the
  snapshot or to the node it came from, and there is no good answer — load it, edit it, save it
  again.
- A saved document is a snapshot, not a live reference. Deleting it leaves every group it
  mentions exactly where it was; changing a group does not change a document already saved.

---

## Settings

*XYZ Tools → XYZ Prompt Tools Settings → ⬡ Prompt Library V3*

Slider ranges for prompt weight and LoRA weight (separate — a LoRA weight may go negative, a
prompt weight may not), the schedule step, editor font/wrap, the refresh delay after you stop
typing, and the library's autosave delay.

The range is the resolution: a slider that reaches 4.0 makes 1.1 and 1.15 a pixel apart, and
nobody weights a tag at 4.0.

---

## Migrating from V2

```bash
python -m prompt_library_v3.migrate_v2 --dry-run     # report only
python -m prompt_library_v3.migrate_v2
```

Reads `prompt_library_v2_data/plv2.db`, writes `prompt_library_v3_data/plv3.db`. Folders,
entries and prompts become folders, groups and items; `{a|b}` choices become
`{a, b}.set{random_select: 1}`; `[ref]`s and trigger aliases are resolved into real refs.
Nothing in V2 is touched.

---

## Diagnostics

Errors abort the node. Warnings degrade and carry on — every one of them names what it did.

| | |
|---|---|
| **E01** | a region group nested inside another region group |
| **E02** | circular library reference |
| **E03** | cannot parse (unbalanced brackets, broken `.set{}`, bad number) |
| **W01–W04** | a `[@schedule]` / `[@region]` group *also* declares `.set{schedule}` / `.set{region}` — the block wins |
| **W05** | empty schedule intersection → the content is dropped |
| **W06** | the same prompt twice in one library block → the library keeps one; the text is untouched |
| **W07 / W08** | unknown `.set{}` field → ignored; bad value → the default |
| **W09** | library path not found → the text compiles as it stands |
| **W10** | a mask mixes fractions and pixels → passed through |
| **W11** | two groups merged into one mask segment disagree → the first wins |
| **W12** | `region: fill` under `region_mode: mask` → the fill is synthesised |
| **W13** | a region in a Negative node → ignored |
| **W14** | an unescaped reserved character whose intent is recoverable → treated as a literal |

---

## Files

| | |
|---|---|
| `lexer.py` / `parser.py` | text → tokens → AST, with source **spans** (what makes the detail page's surgical edits possible) |
| `ir.py` | AST → segments (schedule intervals, region splitting, ambient-text injection) |
| `compile/` | segments → prompt-control text (`couple` and `mask` backends) |
| `validate.py` | the checks that need a whole-tree view (E01, W06, W13) |
| `library.py` | expand (library → text), sync (text → library), presets, links |
| `db.py` / `repo.py` | SQLite; all writes through a single-writer `WriteQueue` |
| `routes.py` | `/xyz/plv3/…` |
| `node.py` | the two nodes |
| `../js/plv3/` | the windows: `editor_core` (one editor, used twice), `detail`, `preview`, `library`, `theme` |
| `../web/monaco/` | vendored Monaco 0.52.2 (served at `/xyz/plv3/monaco/…`) |

Tests: 234 of them, no ComfyUI needed —

```bash
python -m pytest test/t4*_plv3_*.py test/t5*_plv3_*.py -q
```
