# Prompt Library V4

**English** | [中文](README_zh.md)

Edit prompts as nested blocks, reuse saved combinations, and collect tags into Folder pools. V4 uses the [PLv3 language](../prompt_library_v3/README.md) and compiles to [comfyui-prompt-control](https://github.com/asagi4/comfyui-prompt-control).

## Getting started

1. Install comfyui-prompt-control and restart ComfyUI after updating this node pack.
2. Add **XYZ Prompt Library V4** or **XYZ Prompt Library V4 Monaco** from `XYZNodes/Prompt`. The Monaco variant embeds the source editor; both have the same compiler and outputs.
3. Click **Editor**, or open **XYZ Tools → Prompt Library V4 — Editor** and select a node tab.
4. Write in **Blocks**, edit complete syntax in **Source**, and check compiled output in **Preview**. All views share the document and undo history.

The `prompt` output preserves compiled regions. The `plain` output combines region content into one prompt while retaining weights, schedules and LoRAs. All V4 random choices use the node's seed, including a linked seed; inline group seed overrides are ignored in V4.

The hidden document is saved with the workflow, including disabled items, names, pool bindings and Library sources. Disabling content keeps its position; enabling it restores it there. Sharing the workflow does not require your Library database. Invalid source drafts remain editable, but generation reports the syntax error.

## Blocks and settings

Blocks contain prompts and subblocks in order. Fold, enable, disable or edit them; select prompts and use **Create as block** to group them in place. Drag blocks to move them; the insertion line identifies the destination and nesting level.

Every block has **Content** in the settings pane. It follows actual document order, including disabled items, and lets you edit prompts and nested subblocks. Switches enable or disable; **×** removes content from this copy. Weight controls use **− / +** in steps of **0.05** and also accept direct input.

Region and Schedule settings open expanded by default and remember folding choices. A Region parent's settings include region controls for its subblocks. PLv3 Region/Schedule syntax is unchanged.

A connection icon before a block's name means it has its own Folder binding. A saved block's Library path appears in gray after its name. Folder-only temporary blocks do not display a Library source path.

**Ctrl+F / Ctrl+H** in Blocks searches/replaces displayed prompt text. Source searches complete syntax, including configuration fields. **Enter** and the down arrow select and highlight the next result; **Shift+Enter** and the up arrow go back. Enter in block text creates a newline. Settings switches preserve blank lines.

Prompt input follows PLv3 splitting: commas separate items; a full stop followed by whitespace or the end separates items and stays with its prompt. Chinese commas become English commas when editing ordinary prompt input. Quoted literals, LoRA names, Library paths and `.set` configuration retain their syntax. Opening existing data does not normalize it.

## Library: Folders, tags and saved blocks

A **Folder** is a pool containing loose tags, saved blocks and subfolders. A **Block** stores an ordered combination of prompts and subblocks. There is no Class or shared block pointer model.

The Library tree shows Folders and saved blocks, including subblocks. Click a Folder to edit its loose tags and subfolder tags; subfolders can be folded. Click a block to use the same Blocks editor as a node. Hover over the preview icon to read compact, wrapping prompt text, including disabled content. Loose tags appear on the Folder page rather than as tree rows.

Tree guides show nesting. Empty, single-child Folder chains display as one compact path in Library and Pool; their actual hierarchy stays intact. Names must be unique among siblings, including Folder/block names under one Folder and subblock names under one block. Different parents may contain the same name; full paths remain unique.

Single-click browsing opens one italic **temporary tab**. Browsing another Folder or block replaces it. Editing, double-clicking the tab or double-clicking the Library item makes it permanent. Permanent tabs stay open.

The Library menu creates Folders, tags and blocks, and saves/loads complete Documents through a separate entry. Folder tag edits save immediately. Library block edits are local until you save; saving a subblock updates its containing snapshot.

## Binding a Folder and using Pool

Bind at most one Folder in a block's settings. **Pool** lists candidates from that Folder and its entire subtree; child blocks do not inherit the parent's candidate list.

- Click **+** on a prompt or saved block to append it to Content. Existing content is not added again, enabled again or moved.
- Added entries remain visibly marked, even when disabled. Folder, block and prompt styles stay distinct.
- Use **expand all / collapse all**, a type filter (**All / Prompt / Block**) and an independent usage filter (**All / Unused**). Filters can be combined.
- Expand candidate blocks for read-only previews; edit inserted copies in Content.
- A subfolder's **+ subblock** creates a temporary child bound to that subfolder, filled with its local loose tags, enabled by default. It does not save a Library block.

Drag a Folder's dedicated insertion handle into the editor to create an **empty block bound to that Folder**. Dropping inside a block creates a child. Change an existing block's binding explicitly in settings. Saved blocks support **keep structure** and **prompts only** insertion.

Completing an edit collects new tags into the bound Folder's own layer. Collection includes unbound descendants and stops at children with their own binding. It collects tags, never structure, checking the whole subtree, including saved block content. Deleting or disabling workflow content does not delete pool tags. Opening existing workflows establishes a baseline and does not restore manually removed pool tags.

Loose tags cannot repeat along an ancestor chain. Adding a tag to a child moves an ancestor's loose tag down; adding it to a parent when a descendant already contains it is rejected. Sibling branches may share tags. Tags inside saved blocks are exempt. A Folder's autocomplete switch contributes recursively collected tags to existing autocomplete without copying another dataset.

## Copies, updates and saving

Insertion creates an independent copy with a source marker. **Update from Library** adopts saved content; **Overwrite Library** explicitly writes the edited copy back. Other copies do not change automatically. Embedded Library subblocks are contained snapshots, without shared-child persistence. Concurrent edits report version conflicts rather than silently overwrite.

Library paths use dots, such as `Artists.Painterly.Warm palette`; Source labels use `[full.path]: { ... }`. Stable source IDs preserve identity after renaming; current paths are displayed when available. Compilation reads the expanded document, never the database.

## V3 compatibility and migration

V3 nodes and their original editor/Library remain in XYZ Tools. The node Editor button opens V4. Documents edited with V4 use its node-seed policy; untouched V3 documents retain V3 behavior.

Choose **Library menu → 从 V3 迁移（保留原库）** to import V3 data. Confirmation creates a SQLite backup and imports into the separate V4 Library without replacing V3.

| V3 data | V4 destination |
|---|---|
| Group | Folder |
| Child group/reference | Contained subfolder |
| Atomic item | Loose tag |
| Preset | Saved block in that Folder |
| Group settings | Additional `全部内容` saved block when needed |
| Saved document | Complete Document, including disabled content |

References become copies. Repeating an unchanged import is detected. Personal libraries are never migrated automatically. Earlier experimental V4 Class databases require the [copy converter](DEVELOPMENT.md#迁移与样例).

V4 data lives in gitignored `prompt_library_v4_data/plv4-pools.db`; V3 stays in `prompt_library_v3_data/`. Earlier `plv4.db` files are not automatically upgraded or overwritten. Back up runtime databases before moving an installation.
