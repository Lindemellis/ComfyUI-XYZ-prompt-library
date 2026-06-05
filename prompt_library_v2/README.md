# Prompt Library V2

**English** | [中文](README_zh.md) · [← Back to main README](../README.md)

A SQLite-backed hierarchical prompt library. You build a tree of folders and entries in floating windows, then reference them from a node's template, which is resolved at execution time.

## The nodes

Two nodes (positive / negative variants — the polarity only filters which entries the folder tree shows):

- **XYZ Prompt Library V2 Positive**
- **XYZ Prompt Library V2 Negative**

| Port | Type | Description |
|---|---|---|
| `prompt_template` (input) | STRING (multiline) | Template text using the syntax below |
| `seed` (input) | INT | Drives entry random modes (select / dropout / shuffle) |
| `resolved_prompt` (output) | STRING | The fully resolved text |
| `raw_template` (output) | STRING | The unmodified template (handy for chaining/debugging) |

The node re-resolves on every run (the library in the DB may have changed between runs).

## Opening the windows

- Each node has **Library**, **Editor**, and **Preview** buttons.
- Or use the top-bar **XYZ Tools** menu → *Prompt Library V2 — Library* / *— Text Editor*.

## Template syntax

### `[ref]` — entry references

Insert the resolved text of another entry:

```
[character_name]            ← by trigger name (shortest unique alias) or full path
[character_name.expression] ← dot-path into a child entry
```

A reference resolves to exactly one entry: an exact full path wins over a trigger alias; multi-segment refs take the longest matching prefix and treat the rest as a sub-path. Unknown references resolve to empty. Cycles are detected and skipped.

### `[this.subentry]` — in-entry self reference

Inside an **entry's own prompts**, reference one of its sub-entries: at resolve time `this` is rebound to the entry's full path, so `[this.face]` inside `character.toki` equals `[character.toki.face]`. It only means anything inside the entry text box (`this` doesn't resolve in the editor / node template). If the entry has no `face` child but its inherited template does, it resolves to the template's one. Typing `[` in the entry text box surfaces `this.<subentry>` candidates in the same autocomplete dropdown as library refs.

### `(text:1.2)` — weights

Prompts whose weight ≠ 1.0 are emitted wrapped, e.g. `(glowing eyes:1.3)`.

### `{a|b|c}` — options

> **Current behaviour:** the node always resolves `{a|b|c}` to the **first** option (`a`). The per-batch selection is not wired into the node. For variation, use an entry's **random mode** (below) driven by the node's `seed` instead.

### Auto-cleanup

After resolving, the engine collapses runs of consecutive delimiters (e.g. left by an empty `[ref]`), drops delimiters stranded at the start of a line or the very end, and collapses repeated spaces. **Newlines are preserved** as your paragraph structure.

## Library window

### Folder tree

- Create / rename / move / delete folders and entries (right-click menu), drag to reorder.
- Independent **polarity** filter (positive / negative / all) and **in-use** filter.
- Collapse / expand all.

### Entry detail

- **Name** and a **positive / negative** badge.
- **Trigger aliases** — short names you can use in `[ref]`. Add your own with **+ alias**; each entry also has an automatic trigger (the shortest unique suffix of its path).
- **Prompt list** — vertical or compact layout. Toggle each prompt on/off, set a weight, drag to reorder. **Prompts inherited from the folder template** are merged into this list (tinted background, locked content, no delete); their enable/weight/order are stored per-entry. Order: enabled first (text order, own + template interleaved), then local disabled (alphabetical), then template-inherited disabled (alphabetical).
- **Mode** — `off`, `select` (a random count between min/max), or `dropout` (drop each prompt at a probability), plus a **Shuffle** toggle. All driven by the node `seed`.
- **Format** — wrap each prompt, e.g. `art by {prompt}` (`{prompt}` and `{p}` are placeholders). The **⌖ auto** button next to it detects the maximal common format across all prompts; the input autocompletes from formats used by other entries.
- **Delimiter** — what joins this entry's prompts (`, `, ` | `, newline, …).
- **Sub-entries** — a collapsible panel **below** the prompt list (draggable split between the two). Entries are own, **inherited from the template** (`↳ tpl`, with an **override** button that materialises a same-named local child that keeps inheriting), or **overriding** (`✎ ovr`). A `_neg` child can be auto-inserted into the negative node when you insert the parent. Each row has: **⤴** add a reference (`[this.x]`) into *this* entry's prompts, **＋** insert into the text editor, **→** open/jump.
- **Text box** — preserves your newline layout; a hover icon (top-right) previews this entry's **fully resolved** text; right-clicking a selection offers move/create sub-entry (leaving a `[this.x]` ref in place).

## Folder templates (`_template`)

Create a child entry named `_template` inside a folder and it becomes that folder's **template** (one per folder, always positive).

- Base entries in that folder **and all its subfolders** inherit the template's prompts (woven into the entry text box and the final output) and its sub-entries (display / insert only — they do not auto-enter output).
- **Negative entries never inherit.**
- **Chained inheritance:** a subfolder's own `_template` inherits its parent folder's `_template`; an entry inherits the nearest template and gets the upper levels through it.
- **Per-entry overrides:** an inherited prompt can be enabled/disabled, re-weighted, and reordered within a single entry without affecting the template or other entries.
- **Same-named sub-entries auto-inherit:** create a sub-entry whose name matches a template sub-entry and it inherits it (an "inheritable override"); the **override** button does the same.
- The template entry itself is a stripped-down editor (locked positive; no trigger/delimiter/format/random rows). It does **not** appear in trigger autocomplete, `[ref]` resolution, or normal entry lists (it shows as `⚙ template` in the tree and stays editable). **Renaming a template sub-entry** cascades the rename to every inheriting/overriding copy and updates their references.

## Text editor window

- **Single / split** panes — edit positive and negative together with a draggable divider.
- Opening the editor from a node's **📝 Editor** button focuses that node: in single mode it switches to the node's positive/negative tab and loads it; in split mode it just focuses the matching pane (no tab switch).
- `[ref]` **highlighting** — valid references are tinted; the backdrop tracks the text.
- **Undo / redo** per pane, **find / replace** (case / word / selection), and **smart insert** that adds delimiters based on the cursor context.
- **Ctrl+↑ / Ctrl+↓** — bump the weight of the selection (or the tag at the cursor) in `(text:1.2)` style, in steps of 0.1; stepping back to 1.0 removes the wrap.
- **Copy / cut / paste** stay inside the editor (paste is inserted as plain text) and no longer leak to ComfyUI's canvas — so pasting can't create a stray node.
- **Right-click** — add selection to an entry, create a new entry from it, or open the referenced entry in detail.

### Autocomplete in the editor

- Type `[` to get entry/trigger suggestions; choosing one inserts `[name]` (a reference).
- Type `/name` to insert the entry's **resolved text** instead of a reference.
- (Toggles live in **XYZ Prompt Tools → Library**.)

## Insertion / normalization

Configured in **XYZ Prompt Tools → Insertion** (these apply to both the library and tag autocomplete):

| Setting | Effect |
|---|---|
| Replace `_` with space | insert `blue eyes` instead of `blue_eyes` |
| Auto comma | append `, ` after an inserted tag |
| Escape brackets / backslash | turn non-weight `()` into `\(\)` so they are literal |
| Full-width → half-width | convert `（）`, `，` … to ASCII |
| Comma spacing | normalize a comma + any spaces into a single `, ` (line breaks are left untouched) |

## Naming rules

- **Entry / folder names** may not contain: `.` `,` `|` `/` `\` `[` `]`
- **Trigger names** may not contain spaces or `,` `|` `/` `\` `[` `]` (a `.` is allowed — it acts as a path separator)
