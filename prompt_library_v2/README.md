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
- **Prompt list** — vertical or compact layout. Toggle each prompt on/off, set a weight, drag to reorder. Enabled prompts come first in prompt-text order; disabled prompts are listed alphabetically.
- **Mode** — `off`, `select` (a random count between min/max), or `dropout` (drop each prompt at a probability), plus a **Shuffle** toggle. All driven by the node `seed`.
- **Format** — wrap each prompt, e.g. `art by {prompt}` (`{prompt}` and `{p}` are placeholders).
- **Delimiter** — what joins this entry's prompts (`, `, ` | `, newline, …).
- **Sub-entries** — child entries (own / inherited from a `_template` / overriding). A `_neg` child can be auto-inserted into the negative node when you insert the parent. Each sub-entry row has: **⤴** add a reference into *this* entry's prompts, **＋** insert a reference into the text editor, **→** open it.

## Text editor window

- **Single / split** panes — edit positive and negative together with a draggable divider.
- `[ref]` **highlighting** — valid references are tinted; the backdrop tracks the text.
- **Undo / redo** per pane, **find / replace** (case / word / selection), and **smart insert** that adds delimiters based on the cursor context.
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

## Naming rules

- **Entry / folder names** may not contain: `.` `,` `|` `/` `\` `[` `]`
- **Trigger names** may not contain spaces or `,` `|` `/` `\` `[` `]` (a `.` is allowed — it acts as a path separator)
