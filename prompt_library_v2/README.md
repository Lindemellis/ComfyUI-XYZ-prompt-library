# Prompt Library V2

A SQLite-backed hierarchical prompt library for ComfyUI. Replaces the legacy V1 JSON-file-based system with a proper database, a template engine, a trigger alias system, and a rich floating-window editor.

## Architecture

```
plv2.db (SQLite, WAL mode)
    └── nodes        ← Folder & entry tree (parent_id self-ref)
    └── prompts      ← Per-entry prompt strings with weights
    └── triggers     ← Auto-generated + custom alias names
```

- **Single-writer** via `WriteQueue` (priority queue with HIGH/MID/LOW lanes)
- **Short-lived reads** — every read API opens its own `connect_read()`, closes immediately
- **SQLite WAL** — concurrent reads never blocked by a write
- **Triggers rebuilt automatically** after every node create/rename/move/delete

## Nodes

Two ComfyUI nodes under the **XYZNodes/Prompt** category:

| Node | Polarity Filter |
|------|----------------|
| **Prompt Library V2 Positive** | Only positive (`pos_neg = 'positive'` or `'both'`) entries |
| **Prompt Library V2 Negative** | Only negative (`pos_neg = 'negative'` or `'both'`) entries |

### Inputs & Outputs

| Port | Type | Detail |
|------|------|--------|
| `prompt_template` | STRING | Multiline text with `[ref]` / `{a\|b}` / syntax |
| `seed` | INT (0..0xFFFFFFFFFFFFFFFF) | Controls random mode outcomes |
| `resolved_prompt` | STRING | Fully resolved output |
| `raw_template` | STRING | Original template text (for chaining) |

The node **always re-executes** (`IS_CHANGED` returns NaN) because library database content can change between runs.

## Template Syntax

### `[entry_ref]` — Entry References

Resolves to the prompt text of a library entry. The reference is looked up through the trigger system:

```
[character]              ← shortest unique trigger
[character.expression]   ← dot-path to sub-entry
```

Resolution order: exact `full_path` match → longest trigger prefix → sub-path remainder.

References are **cycle-safe**: max recursion depth 50, with frozenset-based cycle detection. Unknown references are silently removed.

### `{a|b|c}` — Alternation

For multi-output prompting. The output index (controlled by ComfyUI's queue system) selects which option appears:

```
{masterpiece|sketch|doodle}
```

If `output_index = 0` → `masterpiece`, `output_index = 1` → `sketch`, etc. Out-of-range → empty string.

### `(text:weight)` — Weight Wrapping

When a prompt in the library has `weight ≠ 1.0`, the engine wraps it:

```
(glowing eyes:1.3)
```

### Cleanup Rules

After resolution, the engine applies:
- Collapse adjacent/mixed delimiters (e.g. `, .` → `, `, `,,` → `, `)
- Strip leading delimiters from each line
- Strip trailing delimiters
- Collapse 2+ spaces into 1

## Database Schema

### `nodes`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `parent_id` | FK → nodes(id) | NULL = root, CASCADE delete |
| `name` | TEXT NOT NULL | Single path segment |
| `full_path` | TEXT UNIQUE | Denormalized dot-joined path |
| `has_template` | INTEGER | Folder-like node (contains sub-entries) |
| `has_prompts` | INTEGER | Entry node (has prompt text) |
| `pos_neg` | CHECK('positive','negative','both') | Polarity |
| `shuffle` | INTEGER | Randomize prompt order |
| `random_mode` | TEXT | `'none'` / `'select'` / `'dropout'` |
| `select_min` / `select_max` | INTEGER | For select mode |
| `dropout_rate` | REAL | For dropout mode |
| `format` | TEXT | `{prompt}` / `{p}` template per prompt |
| `delimiter` | TEXT | Joiner between prompts |
| `order_index` | INTEGER | Sibling ordering |
| `created_at` / `updated_at` | INTEGER | Unix timestamps |

### `prompts`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `node_id` | FK → nodes(id) | CASCADE delete |
| `content` | TEXT NOT NULL | The prompt string |
| `weight` | REAL DEFAULT 1.0 | Weight multiplier |
| `enabled` | INTEGER DEFAULT 1 | |
| `order_index` | INTEGER | Sort position |
| `source` | TEXT DEFAULT 'custom' | `'template'` (locked) or `'custom'` (editable) |

### `triggers`

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `node_id` | FK → nodes(id) | CASCADE delete |
| `trigger_text` | TEXT UNIQUE | Alias name for `[...]` references |
| `is_auto` | INTEGER | 0 = user-defined, 1 = auto-generated |

## Trigger System

### Auto-triggers

After every structural change, the system regenerates auto-triggers for all entries:

1. **Shortest unique name** — entry name only (ancestor folders dropped)
2. **Disambiguation** — if two entries share a name, progressively reintroduce parent folder names
3. **Full_path fallback** — guaranteed unique; used when shorter forms conflict with other triggers

### Custom Triggers

Users can add custom alias names. These block other entries from generating an auto-trigger with that text. On creation, the system checks for conflicts against:
- All existing trigger texts
- All `full_path` values
- All entry default names

### Conflict Resolution

When node A's trigger shadows node B's path, B's custom triggers that now match a different node's `full_path` are **pruned** (removed as shadowed). This maintains the invariant: `full_path` always beats any trigger.

## Frontend

The frontend is a set of floating windows that snap together magnetically:

### Text Editor (`plv2_editor.js`)

- **Two modes**: single pane (tab-switched pos/neg) or split (pos top, neg bottom, draggable divider)
- **Reference highlighting**: valid `[refs]` get purple background; invalid get red wavy underline
- **Per-pane undo/redo** (300 checkpoints)
- **Find/replace** with case-sensitive, whole-word, in-selection modes
- **Smart insert** — delimiter-aware insertion that handles cursor context
- **Right-click menu** — add-to-entry, create-entry, open-in-detail
- **Live sync** — changes in the library are reflected in the editor in real-time

### Library Window (`plv2_tree.js` + `plv2_entry.js`)

**Tree panel:**
- Folder/entry tree with collapse/expand all
- Filters: all / positive / negative / in-use
- Sort: by name or creation time, ascending or descending
- Context menu: insert ref, rename, move, new folder/entry, delete (with usage analysis)

**Entry detail panel:**
- Inline name editing, polarity toggle
- Trigger aliases with insert buttons and conflict checking
- Delimiter selector, format input, shuffle toggle
- Random mode: off / select (min-max count) / dropout (rate %)
- **Bidirectional prompt sync** — textarea ↔ structured prompt list (vertical or compact chip mode)
- Sub-entry panel with `_template` inheritance and `_neg` auto-insert toggle
- Navigation history (back button)

### Preview Window

Read-only live rendering of the resolved template. Shows what the node will output at execution time.

### Window Snapping

Library and Preview windows snap to the Editor's left or right edge. The compound shares a unified shadow and synchronized height. Drag handles detach individual windows.

## HTTP API

All endpoints under `/xyz/plv2/`:

### Nodes
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/nodes` | Full node tree |
| POST | `/nodes` | Create node |
| PATCH | `/nodes/{id}` | Update node fields / rename |
| DELETE | `/nodes/{id}` | Delete node + subtree |
| POST | `/nodes/{id}/move` | Reparent + optional rename |

### Prompts
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/nodes/{id}/prompts` | List prompts |
| POST | `/nodes/{id}/prompts` | Add prompt |
| PATCH | `/prompts/{id}` | Update prompt |
| DELETE | `/prompts/{id}` | Delete prompt |
| POST | `/nodes/{id}/prompts/reorder` | Bulk reorder |

### Triggers
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/nodes/{id}/triggers` | Get triggers (auto + custom) |
| POST | `/nodes/{id}/triggers` | Add custom trigger |
| DELETE | `/triggers/{id}` | Delete custom trigger |

### Resolution & Search
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/nodes/{id}/preview` | Generate entry text (no recursive expansion) |
| POST | `/resolve` | Full template resolution |
| POST | `/resolve_ref` | Resolve a reference string to a node |
| POST | `/resolve_shallow` | Resolve ref but leave nested `[refs]` |
| POST | `/nodes/{id}/refs/replace` | Replace old paths with new in all prompts |
| GET | `/nodes/{id}/usages` | Find all references to this node's subtree |
| POST | `/nodes/{id}/strip_refs` | Remove specific refs from library prompts |

### Autocomplete
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/ac/prompts?q=&limit=` | Search library prompts (deduplicated) |
| GET | `/ac/refs?q=&limit=` | Search entry paths and triggers |
| GET | `/ac/entries_by_prompt?q=&limit=` | Find entries containing prompt text |

### Common Lists
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/common/formats` | Frequently used format strings |
| GET | `/common/delimiters` | Frequently used delimiters |

## Naming Rules

- **Node names**: cannot contain `.` `,` `|` `/` `\` `[` `]`
- **Trigger text**: cannot contain spaces `,` `|` `/` `\` `[` `]`

## Normalization Settings

The editor supports configurable prompt normalization applied on-the-fly:
- **Escape parentheses**: `()` → `\(\)` (preserves ComfyUI weight syntax)
- **Half-width**: full-width punctuation → ASCII (`，` → `,`)
- **Underscore to space**: `_` → ` `
- **Trim trailing delimiters**: removes `,`, `.`, `|` etc. from line ends
- All normalization skips text inside `[...]` references and `{...}` patterns

## Data Directory

```
prompt_library_v2_data/
└── plv2.db    ← SQLite database (WAL mode, 256 MiB mmap)
```

Fully gitignored — each ComfyUI instance maintains its own library.

---

[中文版 (Chinese)](README_zh.md)
