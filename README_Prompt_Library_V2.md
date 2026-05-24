# ComfyUI-XYZNodes — Prompt Library V2

A SQLite-backed prompt library for ComfyUI. You build a reusable, hierarchical
library of prompt **entries**, then compose prompts in a text editor that
references them with `[brackets]`. Two graph nodes resolve those references at
run time.

> Supersedes the legacy JSON-based Prompt Library (V1). The V1 node and docs are
> kept for backward compatibility but are no longer the recommended workflow.

## Nodes

- **XYZ Prompt Library V2 Positive**
- **XYZ Prompt Library V2 Negative**

Each node has a `prompt_template` text box and a `seed`. At execution it resolves
the template against the library and outputs a `STRING`. The positive/negative
split lets the library tree and the editor target the right node automatically.

Each node shows three buttons: **📝 Editor**, **📚 Library**, **👁 Preview**.

## Windows

All three are floating windows. When two are open you can **drag one against the
other** to magnetically snap them into a single composite (the editor is the hub:
the Library and the Preview each snap to a side of it). A snapped window has a
drag-handle to tear it off again.

- **Text Editor** — where you write the prompt template. Single mode (a pos/neg
  tab switch) or split mode (positive on top, negative on bottom, draggable
  divider). `[entry]` references are highlighted. Includes undo/redo, find &
  replace, and a right-click menu to add the selection to an entry, create a new
  entry from it, or open a reference in the detail view.
- **Library** — folder tree (folders + entries, with positive/negative and
  "in use" filters) plus the **entry detail** panel.
- **Preview** — a read-only, live render of the resolved output. Opened from a
  node it previews that node; opened from the editor it mirrors the editor.

## Entries, prompts, references

- An **entry** holds a list of **prompts** (each with a weight and enabled flag),
  a delimiter, an optional `{p}`/`{prompt}` format, and a random mode
  (off / select N / dropout). Entries live in **folders** and can have
  **sub-entries**.
- A **reference** `[name]` in a template expands to that entry's resolved text.
  References can be the entry's auto name, a custom **trigger** alias, or a dotted
  path (`[toki.appearance]`). Every reference resolves to exactly one entry.
- A `_neg` sub-entry holds the negative counterpart; the entry detail has a
  toggle so inserting `[toki]` can also insert `[toki._neg]` into the negative node.

Template syntax: `[ref]` references, `{a|b}` multi-output choices, `(text:1.2)`
weights, the entry's delimiter between prompts.

## Trigger / reference rules

- Trigger names are globally unique and may not collide with any entry's path or
  default name (you'll get a clear message if they do).
- Definition names may not contain `. , | / \ [ ]`; trigger names may not contain
  `, | / \` (`.` is allowed as a path separator).
- Renaming/moving an entry that would shadow an existing custom trigger removes
  that trigger and warns you.

## Settings (⚙ in the Library window)

Optional prompt normalization applied wherever prompts are entered/inserted
(skips `[refs]` and `{patterns}`):

- escape non-weight `()` → `\(\)` and lone `\` → `\\`
- full-width punctuation → ASCII
- underscores → spaces

"Apply to existing library" rewrites all stored prompts and lists what changed.

## Storage

The library lives in `prompt_library_v2_data/plv2.db` (SQLite, gitignored — local
to your install).
