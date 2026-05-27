# Prompt Library V2

Hierarchical prompt library with templates, references, and trigger aliases. Edited via floating windows inside ComfyUI.

## Quick Start

1. Add **XYZ Prompt Library V2 Positive** (or **Negative**) node to your workflow
2. Click the **Library** button on the node to open the library window
3. Click the **Editor** button to open the template editor
4. Type template text — the node resolves it on execution

### Node I/O

| Port | Type | Description |
|---|---|---|
| `prompt_template` | STRING | Template text with the syntax below |
| `seed` | INT | Controls random mode outcomes |
| `resolved_prompt` | STRING | Fully resolved output |
| `raw_template` | STRING | Raw template (for chaining) |

## Template Syntax

### `[ref]` — Entry References

Reference existing library entries:

```
[character_name]           ← shortest unique trigger
[character_name.expression] ← dot-path to child entry
```

### `{a|b|c}` — Alternation

Works with ComfyUI batch count — each execution picks the next option:

```
{masterpiece|sketch|doodle}
```

Batch 0 → `masterpiece`, batch 1 → `sketch`, out of range → empty.

### `(text:1.3)` — Weight Wrapping

Prompts with weight ≠ 1.0 are auto-wrapped: `(glowing eyes:1.3)`.

### Auto-Cleanup

After resolution: merges duplicate commas, strips leading/trailing delimiters, collapses extra whitespace.

## Library Window

### Folder Tree

- Create folders and entries
- Drag to reorder
- Right-click menu: rename, move, delete, new
- Filter: positive / negative / all
- Collapse/expand all

### Entry Editor

- Name and polarity (positive / negative / both)
- Trigger aliases — shortcut names for `[ref]`
- Prompt list: add, edit, drag-reorder
- Random mode: none / select N / dropout
- Prompt format: `{prompt}` or custom
- Inter-prompt delimiter

### Child Entries

Entries can have children. Child prompts are inherited. `_neg` children auto-insert into negative output.

## Text Editor Window

- **Single / Split panes**: tabs or top-bottom split for editing positive and negative together
- **Syntax highlighting**: valid `[ref]` in purple, invalid with red underline
- **Undo/redo** per pane
- **Find/replace** with case, word, selection modes
- **Smart insert** — cursor-context-aware delimiter insertion
- **Right-click menu** — add to entry, create entry, open in detail

## Normalization Settings

Configured in **XYZ Prompt Tools → Insertion**:

| Setting | Effect |
|---|---|
| Replace `_` with space | `blue_eyes` → `blue eyes` |
| Auto comma | Append `, ` after insert |
| Escape brackets | `()` → `\(\)` |
| Full-width → half-width | `，` → `,` |

## Common Tasks

**Switch between positive/negative editing?** Click tabs at the top of the editor, or use the split button.

**Insert an entry reference in the editor?** Type `[` to trigger entry autocomplete, or right-click in the tree → insert reference.

**Save text to the library?** Select text in the editor → right-click → add to entry / create entry.

**Inherit child entries?** `_neg` children auto-insert. `_template` children define the entry's default template. No manual reference needed.

## Naming Rules

- Entry/folder names cannot contain: `.` `,` `|` `/` `\` `[` `]`
- Trigger names cannot contain: space `,` `|` `/` `\` `[` `]`

[中文版 (Chinese)](README_zh.md)
