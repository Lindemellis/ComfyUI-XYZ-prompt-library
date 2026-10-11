# Prompt Library V4

**English** | [中文](README_zh.md)

Edit prompts as nested blocks, reuse saved combinations, and collect tags into Folder pools. V4 uses the [PLv3 language](../prompt_library_v3/README.md) and compiles to [comfyui-prompt-control](https://github.com/asagi4/comfyui-prompt-control).

## Getting started

1. Install comfyui-prompt-control and restart ComfyUI after updating this node pack.
2. Add **XYZ Prompt Library V4** or **XYZ Prompt Library V4 Monaco** from `XYZNodes/Prompt`. The Monaco variant embeds the source editor; both have the same compiler and outputs.
3. Click **Editor**, or open **XYZ Tools → Prompt Library V4 — Editor** and select a node tab.
4. Write in **Blocks**, edit complete syntax in **Source**, and check compiled output in **Preview**. All views share the document and undo history.

After updating the node pack, restart your regular ComfyUI instance and refresh the browser with **Ctrl+F5**. Existing personal Libraries, models and workflows are preserved.

The `prompt` output preserves compiled regions. The `plain` output combines region content into one prompt while retaining weights, schedules and LoRAs. All V4 random choices use the node's seed, including a linked seed; inline group seed overrides are ignored in V4.

The hidden document is saved with the workflow, including disabled items, names, pool bindings and Library sources. Disabling content keeps its position; enabling it restores it there. Sharing the workflow does not require your Library database. Invalid source drafts remain editable, but generation reports the syntax error.

## Blocks and settings

The body behaves as a normal multiline input: commas, spaces and blank lines are retained, Enter moves the caret onto the new line, and Backspace / Delete use native deletion behavior. Text size, color and position stay consistent on first input and when entering or leaving the field. After adding a block, another header's **More (⋯)** menu still opens with one click and saves the body normally.

Native block text accepts Source constructs such as `{…}` and `[@region]: {…}`. They appear as structured blocks on blur; typing retains its text and focus. Incomplete or invalid constructs remain editable drafts. Use PLv3 quoted strings or escapes for literal syntax characters. A directly typed empty container stays empty; Schedule/Region completion inserts the two-stage/four-region template.

Type `[` for Source headers and Library paths; inserting a Library path expands a document copy. Type `<` or `<lora:` for local LoRA paths, with strength 1 by default and existing strengths preserved when replacing a call's name. This inserts source syntax only; use browser **Send** for a LoRA block and its trigger Folder.

**XYZ Settings → Autocomplete** independently controls LoRA syntax, Source syntax, D/G datasets and Library prompts. A tag belonging to both D/G and Library retains dataset links, aliases and previews with an added **L**. Library-only tags show their Folder path in the alias slot. L opens the owning Folder, offering a choice for multiple memberships.

PLv4, the LoRA browser and XYZ Settings bring the clicked or focused window to the front.

Blocks contain prompts and subblocks in order. Fold, enable, disable or edit them; select prompts and use **Create as block** to group them in place. Drag blocks to move them; the insertion line identifies the destination and nesting level.

The header's sibling/child buttons still create ordinary blocks directly. Hover **Add sibling Block / Add child Block** in **More (⋯)** to open a submenu with ordinary Block, Schedule, Region and AVG choices; choose **Schedule container / Region container** to create a special container; invalid nesting options are omitted. Schedule starts with two empty stages, **0–0.5 / 0.5–1**. Region starts with four empty entries: **Base / Mask 1 / Mask 2 / Fill**, with left-half / right-half rectangles for the two masks. Creation focuses the first entry's body and takes one undo step.

Schedule/Region containers contain only stage/region entries at their first level; use their add buttons to create entries. An entry can be reordered only within its own container, cannot be dragged out or into another container, and cannot be saved separately to the Library. Schedule reordering keeps the time intervals at their positions and moves content between them; Region reordering retains each entry's region parameters. Ordinary blocks, Library blocks and Folder-bound blocks may be dropped into an existing entry's body as subblocks and moved out again, but cannot be dropped at the container's first level to become entries. Save the whole container or an ordinary subblock inside an entry.

Every block has **Content** in the settings pane. It follows actual document order, including disabled items, and lets you edit prompts and nested subblocks. Switches enable or disable; **×** removes content from this copy. Weight controls use **− / +** in steps of **0.05** and also accept direct input.

Region and Schedule settings open expanded by default and remember folding choices. A Region parent's settings include region controls for its subblocks. PLv3 Region/Schedule syntax is unchanged.

Schedule and Region containers omit Shuffle, Dropout, Random select and Format controls; use them on entries or body blocks. Format applies to direct children, treating each subblock's complete output as one item while preserving its own weight/schedule wrappers. Dropout is a 0–1 slider with a 0.05 step and one undo step per release. Random select has integer bounds **a / b**, with **0 ≤ a ≤ b**: draw c from the inclusive range, then select c direct children without replacement, capped at the available count. Leave both fields empty to disable it; **0 / 0** selects none. Header type badges precede the block name; Schedule interval and Region setting badges follow it.

Bound blocks show a link icon and a Folder name badge before the block name. Click either to open the same Folder settings tab used by Library; the Folder row in block settings also has an **↗** button. Schedule, Region and AVG containers cannot bind Folders, while their entries and body subblocks can. Opening an old container removes its invalid binding while preserving content, disabled items and child bindings. A LoRA block's trigger Folder is fixed and displayed inside its **LoRA** settings section, with a button to open its editable Folder page.

A connection icon before a block's name means it has its own Folder binding. A saved block's Library path appears in gray after its name. Folder-only temporary blocks do not display a Library source path.

**Ctrl+F / Ctrl+H** in Blocks searches/replaces displayed prompt text. Source searches complete syntax, including configuration fields. **Enter** and the down arrow select and highlight the next result; **Shift+Enter** and the up arrow go back. Enter in block text creates a newline. Settings switches preserve blank lines.

Prompt input follows PLv3 splitting: commas separate items; a full stop followed by whitespace or the end separates items and stays with its prompt. Chinese commas become English commas when editing ordinary prompt input. Quoted literals, LoRA names, Library paths and `.set` configuration retain their syntax. Opening existing data does not normalize it.

## AVG blocks

The bottom **添加 block** button directly adds an ordinary block; its **▾** menu offers ordinary, Region, Schedule and AVG blocks, including in an empty document. When focused on a special container, the footer adds entries only. In Library pages, it inserts inside the saved block. The menu respects nesting restrictions.

Create **AVG 容器** from a header's **⋯ → sibling / child** menu or the bottom **▾** menu. It starts with two empty entries of weight 1, with the same badge layout as Schedule/Region/LoRA. The container only accepts AVG entries, has no direct prompt editor or Folder binding, and omits randomization, shuffle and format controls. AVG entries omit those controls too; put random content in ordinary body subblocks.

Each entry's **AVG weight** is a non-negative relative mixture weight, normalized across active entries: 1:3 means 25%:75%. It is separate from prompt emphasis. Zero/disabled entries do not participate; if none participates, outside content remains once. An enabled empty entry still participates. Entries cannot be dragged, reordered or saved independently. Outside/Library blocks can enter entry bodies as subblocks; the whole AVG container can be saved.

Source and native `[` completion support `[@avg]: { 1: { b }, 3: { c } }`. With ambient `a, d`, output is `a, b, d AVG(0.25) a, c, d`. N-way means use cumulative left weights; multiple/nested averages combine local proportions. Expansion is limited to 256 alternatives per region/time interval.

Schedules compile per active interval and renormalize entries whose own schedule is active. Regions average independently, keeping AVG inside each COUPLE/AND operand. Regions inside AVG use the active entries' combined region set; identical masks merge, and an entry without matching region content contributes ambient content. Plain output removes regions while retaining AVG. Parent randomization treats AVG as one direct child and keeps the selection fixed across time intervals.

AVG mixes encoded conditioning before denoising. LoRA references are centralized, deduplicated by source invocation and keep their schedules. Mixture weights do not change LoRA Model/CLIP strengths or isolate model patches to a vector branch: LoRAs in participating entries load together. Current Prompt Control rounds AVG coefficients to two decimal places, so some proportions have small errors and tiny shares may round to zero. PLv4 emits the correct cumulative ratios without patching Prompt Control.

## LoRA browser

Open **XYZ Tools → Prompt Library V4 — LoRA Browser**, or **LoRA** in the Editor / Library. It is independent of LoRA Manager and does not load model weights.

- The directory tree reflects all configured ComfyUI LoRA roots, including extra model paths. Search names/paths and browse paginated cards.
- Each preview card has **Send**, without opening details. Details show multiple previews and a Civitai link, defaulting to **civitai.red** with the model version when known.
- Choose a PLv4 node in the current workflow; the current editor node is the default. Send appends a **LoRA block** at document root, with one undo step. Sending the same model locates its existing block and enables it and its ancestors while preserving strengths, content and position.
- A LoRA block binds its own trigger Folder. Expand **触发词 Folder** in browser details to edit tags and appearance subfolders, each independently collapsible. Triggers are optional **Pool candidates**, selected with ＋ or edited as block text. Pool edits do not replace workflow content.
- Block settings expose **Model strength / CLIP strength**. The fixed invocation stays in Source and is hidden in Blocks / Content. Schedule applies to both the invocation and prompt content. Parent random selection picks whole LoRA blocks; a LoRA block's own random settings affect its prompt content while keeping the invocation.
- Click the **LoRA** header badge or **打开 LoRA 详情** in LoRA settings to open that model's browser detail page.

Trigger pools are created only on first edit/send. Read local model-side `.metadata.json` / `.civitai.info`, local previews and Civitai image URLs first. **Fetch Civitai metadata** queries the current file on demand and caches results under XYZ's data directory. Reopening/sending does not restore manually deleted pool tags; **Import metadata triggers** explicitly appends them. Models with missing metadata remain usable with manually edited triggers.

Trigger combinations preserve the author's Civitai/sidecar array entries before their contents are parsed. Multiple character, appearance or outfit combinations become separate subfolders even when they share no tags. Arrays of only short atomic tags stay flat; legacy `,,` combinations are also supported. Complete prompts and attention weights survive, with deduplication within each combination and shared tags allowed in sibling folders. Character names take priority, followed by recognized outfits or numbered names. Reimport reuses folders and preserves custom names/tags. Details display the original entries separately; previously flattened tags are regrouped only on explicit import or an explicitly requested repair.

The disk tree is for browsing; editable Folders are trigger pools stored in the PLv4 database, accessed through the LoRA browser separately from the ordinary Library tree. No model files are moved. When identical relative filenames exist in several model roots, only ComfyUI's preferred file can be sent, avoiding a different model being loaded.

V4 emits selected `<lora:...>` calls at the end, preserving effective schedules and removing only copies caused by Region ambient injection. Explicitly authored separate calls remain separate. Connect the same **prompt** to **PC: Schedule LoRAs** and **PC: Schedule Prompt**. LoRA patches affect the whole model; Regions constrain trigger/prompt text. Workflows and saved Library blocks preserve LoRA identity and content without a database at execution; copying Source alone carries PLv3 syntax.

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
