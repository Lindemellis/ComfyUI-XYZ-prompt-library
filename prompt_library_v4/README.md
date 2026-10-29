# Prompt Library V4

**English** | [中文](README_zh.md)

Edit prompts as nested blocks, reuse saved combinations, and collect tags into Class pools. V4 uses the [PLv3 language](../prompt_library_v3/README.md) and outputs either [comfyui-prompt-control](https://github.com/asagi4/comfyui-prompt-control) syntax or MOSS Image prompts.

## MOSS Image

Select **General Settings → Output mode → MOSS Image** in the existing editor (classic Nodes 1.0 supported). The optional **width / height** sockets are required at execution only when MOSS actually emits rectangle regions (positive multiples of 16). Prompt Control does not require these sockets.

With nothing but a caption (no region, meta, canvas or palette — a negative prompt, say) MOSS outputs plain text with the escapes as typed; anything else is Layout JSON (`{"summary": {...}}` alone when there is no region), empty fields left out. MOSS documents have a strict block structure:

```text
[@moss]: { canvas: single }
{ poster, anime illustration }.set{type: meta}
a shop interior, warm light.
[@region mask: [0, 0.5, 0, 1], type: character]: {
    a girl, school uniform.
    { saber \(fate\), 1girl, { solo } }.set{type: tag}
    { red, white }.set{type: palette}
}
[@region mask: [0.5, 1, 0, 0.3], type: text]: { bold red sign. { OPEN
NOW }.set{type: text} }
```

- **Top level:** ordinary blocks, `[@region …]` blocks and the `[@moss]` line. A top-level block picks its **Type** in Details: caption / meta / palette (default caption), written `.set{type: …}`.
- **Inside a region:** ordinary blocks typed caption / tag / palette, plus text in a `type: text` region. Subblocks pick no type: they inherit it, at any depth.
- Library Classes and Blocks import as they are and take a Type afterwards; a Library block keeps its `[path]` head and `.set{format}`.
- Captions join into `caption`; every meta / tag / palette item is one array entry (`summary.meta`, `summary.palette`, `items[].tags`, `items[].palette`), concatenated without duplicates. Text keeps its line breaks (`\n` counts) and fills `text` for text regions. Sentence case touches captions only.
- **The MOSS block:** in MOSS mode the top of Blocks holds the one `[@moss]` block with a canvas dropdown (single / multi_panel / collage, empty to omit). It appears on switching to MOSS, cannot be deleted, switched off or moved, and is hidden in Prompt Control. General Settings shows canvas too.
- Menus only offer what may stand there and drops refuse anything else; hand-written violations in Source are greyed out with a reason and left out.
- There are no Region containers: the node is the container, and General Settings carries its Region switch and region list. With Region off, region captions, tags and palettes merge into the summary. An old `[@region]` container is greyed out in MOSS; **转换为 Region blocks** in Details converts it.
- `\(` is written as a bare paren in the JSON (the encoder reads the JSON source, where ComfyUI's escape pass would leave one backslash). `plain` keeps the source escapes.
- In Prompt Control, `[@region …]` reads as a block with that region; `[@moss]` and meta / palette blocks are not output; other types read as ordinary blocks.

Rectangles retain their original coordinates; output uses centered pixel `yxyx` coordinates, rounded outward.

**Upsample caption** on each region and **Summary upsample** in General Settings default to off. Connect PLV4 **metadata** and the MOSS **CLIP** to **XYZ PLV4 MOSS Upsample**. Its `prompt` goes to native CLIP Text Encode; its updated `metadata` goes to XYZ PLV4 Image Metadata for saving. Flags travel through metadata, not the final JSON. Only selected captions are rewritten; boxes, types, text, tags, palettes and order are retained. It reuses the existing text encoder and has a bounded caption cache. Disable any whole-prompt template upsampler after this node.

Generation delegates to native **TextGenerate** with sampling on/off, temperature, top-k/top-p/min-p, repetition/presence penalties, seed, max_length (1–32768 per caption), thinking, template control, MTP, editable system_prompt and optional image/video/audio (encoder support required). Sampling controls remain flat for Nodes 1.0; off uses native greedy defaults. The default system prompt provides visual-caption expansion instructions and can be replaced or cleared; it applies to each selected caption.

Standalone `prompt` + CLIP also works: prose calls TextGenerate once; Layout JSON expands the summary and every item.caption. Optional PLV4 metadata applies individual flags and produces updated saving metadata; leave prompt blank when using metadata alone, or connect matching prompt and metadata. Plain prompts retain the native seed, while regions derive independent seeds. The appended fourth `thinking` output contains native reasoning separately (keyed JSON for Layouts). JSON braces are protected from frontend dynamic prompt expansion. No PLV4 snapshot is fabricated without input metadata.

**Sentence case** defaults to off and only changes output sentence starts, preserving Source, Document, Library, tags and visible text. It is a conservative character rule, protecting common abbreviations, URLs, underscore tags and mixed-case names, not a language model. Output settings survive loading saved Library documents.

Schedule / AVG containers, timed blocks, IMASK, Base / Fill and conditioning format operations are excluded as entire subtrees in MOSS mode, with visible notices. Their original enabled flags/data remain intact and switching back restores them. Ordinary blocks, pools, random selection, shuffle and dropout remain available. Feather, mask/conditioning strengths and include-in-base do not map to Layout. **NegPip weights** optionally preserves prompt weighting syntax and requires an external MOSS-compatible CLIP NegPip node. LoRAs still require external model loaders; native text encoding does not load them from prompt syntax or metadata.

Preview remains available without dimensions, including when connected backend nodes cannot yet resolve them. Captions and the complete Layout are shown with provisional normalized `yxyx` coordinates and a visible notice; legacy pixel rectangles retain explicit units. Resolved sizes produce final centered pixel coordinates. Provisional coordinates never enter execution or saved image metadata; executing actual regions still requires dimensions. `plain` provides flattened description text.

In the Mask Library rectangle editor, the selected mask is displayed above other rectangles and receives overlapping drag/resize gestures first. Selection changes neither saved mask order nor output slots; use the list's drag handle to reorder masks.

V3's standalone Editor / Library are retired and its Library writer no longer starts. Saved V3 nodes remain compatible and their Editor buttons open V4. Loading an old workflow preserves V3 compiler policy; opening its node in V4 adopts V4's node seed and LoRA behavior while retaining IDs and disabled items. V3 data remains intact and can still be explicitly imported with a backup.

## Getting started

1. Install comfyui-prompt-control and restart ComfyUI after updating this node pack.
2. Add **XYZ Prompt Library V4** or **XYZ Prompt Library V4 Monaco** from `XYZNodes/Prompt`. The Monaco variant embeds the source editor; both have the same compiler and outputs.
3. Click **Editor**, or open **XYZ Tools → Prompt Library V4 — Editor** and select a node tab.
4. Write in **Blocks**, edit complete syntax in **Source**, and check compiled output in **Preview**. All views share the document and undo history.

After updating the node pack, restart your regular ComfyUI instance and refresh the browser with **Ctrl+F5**. Existing personal Libraries, models and workflows are preserved.

The `prompt` output preserves compiled regions. The `plain` output combines region content into one prompt while retaining weights, schedules and LoRAs. All V4 random choices use the node's seed, including a linked seed; inline group seed overrides are ignored in V4.

Click **⚙ General Settings** in the middle pane header to show node-wide settings in the right Settings pane. **Region algorithm** selects **Attention Couple (COUPLE)** (`couple`, default) or **Latent Mask (AND)** (`mask`) for every region in that node. The canvas widget remains hidden and its existing workflow value stays authoritative; old mask workflows keep their mode, and a linked region_mode input disables manual changes. A Block settings action returns to that Block's settings. Library pages do not expose node-wide settings. Additional regional algorithms and a new MODEL patch are not connected yet.

A **Region** switch appears at the top of **Region entries** in Settings for a Region container. It defaults to on. Off merges enabled entries in document order and ignores their region declarations, preserving ordinary weights, schedules, random choices and LoRAs. Other Region containers stay active. The container, entry structure, individual Enable states, coordinates and Library references stay intact; it still accepts only Region entries and cannot contain direct prompt text. Reenable restores region functionality. During compilation, bypassed picture references are neither read nor attached; connected mask outputs remain **Unused**.

This switch is independent of the block's **Enable** and shares Undo/Redo. Workflows, Documents, saved Blocks and metadata retain it. Source keeps its original `[@region]` structure; copying Source alone does not retain the switch state.

### Regions and time

- A **schedule on a region, or on a block above it**, decides whether the region exists: outside the window the output has no region syntax for it at all, only the shared text. This applies to Base and Fill entries too.
- A **schedule on a subblock inside a region** only times that content; the region stays.
- A Region container's **Timing** slider has four handles. They have no identity: after each drag the outer two are the container's schedule (outside it the whole container is gone) and the inner two are the **region window** (between inner and outer the entries stop splitting and merge into ordinary prompt text, like the `plain` output). Inner on outer means "always split". Source: `.set{schedule: {0, 0.8}, region_window: {0, 0.4}}`. With the Region switch off the slider is disabled.
- When regions exist but no Base or Fill has text, the area no region covers is drawn by the shared text: COUPLE starts with `FILL() <shared text>` (prompt-control otherwise adds an empty full-image base that takes half of every region), and AND adds a "whole image minus every region" chunk unless the rectangles provably cover the image (otherwise that area's positive prediction is zero).

## Mask Library

Switch the editor's left pane through the **Library / Mask Library** icons in its title row, or open **XYZ Tools → Prompt Library V4 — Mask Library**. Canvases use the independent `prompt_library_v4_data/masks.db`; the prompt Library is not converted. Canvas rows expose their Edit/View, Rename and Delete actions directly; picture rows also expose Extraction settings and Relocate image.

- **Rectangle canvases:** draw on blank space, or use **Add mask** for a central rectangle. Select through the list or board, move, and resize through eight handles. The first rectangle is on top. Only the list handle reorders; names, colors and identity follow stable IDs. Each completed gesture commits once. Canvas Undo/Redo writes new versions; a conflict preserves the draft and reports the error.
- **Picture canvases:** refresh scans `input/xyz_masks/` without changing files. Settings allow another relative input subdirectory, color count and tolerance. PNG/WebP/JPEG/BMP use their first frame. Alpha defaults to `1-alpha`, with inversion available; images without alpha omit that choice. RGB extraction defaults to the four largest colors (maximum 32), with RGB ascending for area ties. Black, white and disconnected areas of the same RGB participate. Default tolerance is 0.05; original alpha preserves soft edges. Preview colors do not change extraction RGB. Deleting an entry leaves its input file intact.
- **Region mask:** coordinates are x1/x2/y1/y2. Edit independent coordinates directly or open the single-rectangle editor. Library-bound coordinates are read-only; Edit opens the owning canvas. Shared changes refresh references; unlink retains the latest coordinates. Deleted rectangles/canvases leave a final-coordinate fallback, including when older workflows are opened later.
- **Region imask:** manual nonnegative, zero-based indices remain available. The two-level thumbnail selector binds Alpha or an exact RGB, showing the path and preview. Unlink restores the previous manual number. Missing files/colors raise errors rather than changing identity.

V4 appends **mask_bundle** as its fourth output, preserving prompt/plain/metadata socket positions and existing links. Rectangles compile to MASK. Enabled picture references are deduplicated in first-document-occurrence order and receive IMASK indices starting at zero. Manual indices remain unchanged; schedules and random selection do not reorder attachment identities.

```text
PLV4.prompt → PC Schedule LoRAs.text / PC Schedule Prompt.text
CLIP → PC Schedule LoRAs → XYZ PLV4 Attach Masks → PC Schedule Prompt.clip
PLV4.mask_bundle → XYZ PLV4 Attach Masks.mask_bundle
PLV4.mask_bundle → XYZ PLV4 Mask Preview.mask_bundle
```

**Mask Preview** reads the upstream current Document without executing the workflow. It outputs a colored IMAGE and individual MASKs keyed by stable resources. All masks are 512×512; pictures stretch directly without padding. The geometric preview excludes Region feather. Connected resources that become inactive keep an “unused” output returning a zero mask; re-enabling restores the original connection.

**Attach Masks** clones CLIP and appends picture masks only. Existing input masks may shift actual indices away from the prompt's expected indices: the node logs/displays a warning and continues, without renumbering or overwriting masks. It cannot detect every manual-index conflict. Copying Source carries neither resource references nor images; metadata records references/rules/fingerprints without embedding mask pixels. Image workflows shared across machines need their input files and registered directories. Ordinary prompts and rectangle fallbacks remain independently runnable.

Restart ComfyUI and refresh with Ctrl+F5 after updating to load the new routes/nodes. Image painting, new images, overwrite/save-as, and video frame masks are outside this first version.

## Image Source snapshots and XYZ Gallery

The third **metadata** output captures the execution's Source, full Document including disabled items, prompt, plain, node seed and effective LoRAs. Connect positive and optional negative metadata to **XYZ PLV4 Image Metadata**, then connect its output to Aaalice **Conditional Save Image → metadata**. Install Lora Manager and update Aaalice Nodes; a Metadata Overwrite node is no longer needed.

Set **positive_output / negative_output** to match the `prompt / plain` sockets actually used by your encoders (default: prompt). **lora_syntax** adds calls from other loaders, such as `<lora:style:0.8>`, with optional PLV3 Source schedules. The final list excludes negative LoRAs and preserves positive/additional calls, dual strengths, order and schedules. Matching calls are deduplicated across the two sources; the original negative document remains intact.

Enable **save_with_metadata** and use **PNG**. The snapshot travels in `parameters` through `additional_data`, independently of **embed_workflow**. Sampler seed/model/settings remain collected as before. The exact output snapshot disables redundant appending of the legacy LoRA representation to the positive prompt.

Gallery detail offers **Source / Prompt / Plain** for each prompt, defaulting to Source with read-only syntax highlighting and copy. The LoRA section uses the merged records; PLV4 seed is separate from sampler seed. Historical images use their own snapshots without consulting Library. **Re-read metadata** refreshes one indexed file without rewriting it; old images without a saved Source cannot recover it automatically. This first stage supports PNG in Gallery; JPEG/WebP EXIF Source display is not yet supported.

The hidden document is saved with the workflow, including disabled items, names, pool bindings and Library sources. Disabling content keeps its position; enabling it restores it there. Ordinary prompts and rectangle fallbacks do not require your prompt Library database; picture references also need their files and registered directories. Invalid source drafts remain editable, but generation reports the syntax error.

## Blocks and settings

Between consecutive subblocks and after the last subblock, text entries collapse to a thin seam. Hover to show **＋ 正文**, then click to open and focus the input. Leaving it empty collapses it; entered text belongs to the same parent block. User-entered blank lines remain, and empty blocks still show their input directly.

The body behaves as a normal multiline input: commas, spaces and blank lines are retained, Enter moves the caret onto the new line, and Backspace / Delete use native deletion behavior. Text size, color and position stay consistent on first input and when entering or leaving the field. After adding a block, another header's **More (⋯)** menu still opens with one click and saves the body normally.

Blocks text uses Source's context menu and editing rules. Typing `{`, `[` or `(` around a selection wraps it and retains the selection; automatic pairs follow Source's rules. Tab / Shift+Tab indent or outdent, and ordinary text commands and shortcuts use the same editing engine. IME, native line breaks and deletion retain their existing behavior.

Clicking a Block or its text keeps Settings closed when it is closed, and updates the corresponding settings when it is open. The explicit details command in the context menu can open it.

Native block text accepts Source constructs such as `{…}` and `[@region]: {…}`. They appear as structured blocks on blur; typing retains its text and focus. Incomplete or invalid constructs remain editable drafts. Use PLv3 quoted strings or escapes for literal syntax characters. A directly typed empty container stays empty; Schedule/Region completion inserts the two-stage/four-region template.

Type `[` for Source headers and Library paths; inserting a Library path expands a document copy. Type `<` or `<lora:` for local LoRA paths, with strength 1 by default and existing strengths preserved when replacing a call's name. This inserts source syntax only; use browser **Send** for a LoRA block and its trigger Class.

**XYZ Settings → Autocomplete** independently controls LoRA syntax, Source syntax, D/G datasets and Library prompts. A tag belonging to both D/G and Library retains dataset links, aliases and previews with an added **L**. Library-only tags show their Class path in the alias slot. L opens the owning Class, offering a choice for multiple memberships.

PLv4, the LoRA browser and XYZ Settings bring the clicked or focused window to the front.

Blocks contain prompts and subblocks in order. Fold, enable, disable or edit them; select prompts and use **Create as block** to group them in place. Drag blocks to move them; the insertion line identifies the destination and nesting level.

The header's sibling/child buttons still create ordinary blocks directly. Hover **Add sibling Block / Add child Block** in **More (⋯)** to open a submenu with ordinary Block, Schedule, Region and AVG choices; choose **Schedule container / Region container** to create a special container; invalid nesting options are omitted. Schedule starts with two empty stages, **0–0.5 / 0.5–1**. Region starts with four empty entries: **Base / Mask 1 / Mask 2 / Fill**, with left-half / right-half rectangles for the two masks. Creation focuses the first entry's body and takes one undo step.

Schedule/Region containers contain only stage/region entries at their first level; use their add buttons to create entries. An entry can be reordered only within its own container, cannot be dragged out or into another container, and cannot be saved separately to the Library. Schedule reordering keeps the time intervals at their positions and moves content between them; Region reordering retains each entry's region parameters. Ordinary blocks, Library blocks and Class-bound blocks may be dropped into an existing entry's body as subblocks and moved out again, but cannot be dropped at the container's first level to become entries. Save the whole container or an ordinary subblock inside an entry.

Every block has **Content** in the settings pane. It follows actual document order, including disabled items, and lets you edit prompts and nested subblocks. Switches enable or disable; **×** removes content from this copy. Weight controls use **− / +** in steps of **0.05** and also accept direct input.

**Disable all / Enable all** at the top of Content switches all content, including nested blocks and prompts, preserving content and order. The current block's own switch stays unchanged. Each action takes one undo/redo step. The buttons are unavailable while the current block or an ancestor is disabled.

Region and Schedule settings open expanded by default and remember folding choices. A Region parent's settings include region controls for its subblocks. PLv3 Region/Schedule syntax is unchanged.

Schedule and Region containers omit Shuffle, Dropout, Random select and Format controls; use them on entries or body blocks. Format applies to direct children, treating each subblock's complete output as one item while preserving its own weight/schedule wrappers. Dropout is a 0–1 slider with a 0.05 step and one undo step per release. Random select has integer bounds **a / b**, with **0 ≤ a ≤ b**: draw c from the inclusive range, then select c direct children without replacement, capped at the available count. Leave both fields empty to disable it; **0 / 0** selects none. Header type badges precede the block name; Schedule interval and Region setting badges follow it.

Bound blocks show a link icon and a Class name badge before the block name. Click either to open the same Class settings tab used by Library; the Class row in block settings also has an **↗** button. Schedule, Region and AVG containers cannot bind Classes, while their entries and body subblocks can. Opening an old container removes its invalid binding while preserving content, disabled items and child bindings. A LoRA block's trigger Class is fixed and displayed inside its **LoRA** settings section, with a button to open its editable Class page.

A connection icon before a block's name means it has its own Class binding. A saved block's Library path appears in gray after its name. Class-only temporary blocks do not display a Library source path.

**Ctrl+F / Ctrl+H** in Blocks searches/replaces displayed prompt text. Source searches complete syntax, including configuration fields. **Enter** and the down arrow select and highlight the next result; **Shift+Enter** and the up arrow go back. Enter in block text creates a newline. Settings switches preserve blank lines.

Prompt input follows PLv3 splitting: commas separate items; a full stop followed by whitespace or the end separates items and stays with its prompt. Chinese commas become English commas when editing ordinary prompt input. Quoted literals, LoRA names, Library paths and `.set` configuration retain their syntax. Opening existing data does not normalize it.

## AVG blocks

The bottom **添加 block** button directly adds an ordinary block; its **▾** menu offers ordinary, Region, Schedule and AVG blocks, including in an empty document. When focused on a special container, the footer adds entries only. In Library pages, it inserts inside the saved block. The menu respects nesting restrictions.

Create **AVG 容器** from a header's **⋯ → sibling / child** menu or the bottom **▾** menu. It starts with two empty entries of weight 1, with the same badge layout as Schedule/Region/LoRA. The container only accepts AVG entries, has no direct prompt editor or Class binding, and omits randomization, shuffle and format controls. AVG entries omit those controls too; put random content in ordinary body subblocks.

Each entry's **AVG weight** is a non-negative relative mixture weight, normalized across active entries: 1:3 means 25%:75%. It is separate from prompt emphasis. Zero/disabled entries do not participate; if none participates, outside content remains once. An enabled empty entry still participates. Entries cannot be dragged, reordered or saved independently. Outside/Library blocks can enter entry bodies as subblocks; the whole AVG container can be saved.

Source and native `[` completion support `[@avg]: { 1: { b }, 3: { c } }`. With ambient `a, d`, output is `a, b, d AVG(0.25) a, c, d`. N-way means use cumulative left weights; multiple/nested averages combine local proportions. Expansion is limited to 256 alternatives per region/time interval.

Schedules compile per active interval and renormalize entries whose own schedule is active. Regions average independently, keeping AVG inside each COUPLE/AND operand. Regions inside AVG use the active entries' combined region set; identical masks merge, and an entry without matching region content contributes ambient content. Plain output removes regions while retaining AVG. Parent randomization treats AVG as one direct child and keeps the selection fixed across time intervals.

AVG mixes encoded conditioning before denoising. LoRA references are centralized, deduplicated by source invocation and keep their schedules. Mixture weights do not change LoRA Model/CLIP strengths or isolate model patches to a vector branch: LoRAs in participating entries load together. Current Prompt Control rounds AVG coefficients to two decimal places, so some proportions have small errors and tiny shares may round to zero. PLv4 emits the correct cumulative ratios without patching Prompt Control.

## LoRA browser

Open **XYZ Tools → Prompt Library V4 — LoRA Browser**, or **LoRA** in the Editor / Library. It is independent of LoRA Manager and does not load model weights.

- The directory tree reflects all configured ComfyUI LoRA roots, including extra model paths. Search names/paths and browse paginated cards.
- Each preview card has **Send**, without opening details. Details show multiple previews and a Civitai link, defaulting to **civitai.red** with the model version when known.
- Choose a PLv4 node in the current workflow; the current editor node is the default. Send appends a **LoRA block** at document root, with one undo step. Sending the same model locates its existing block and enables it and its ancestors while preserving strengths, content and position.
- A LoRA block binds its own trigger Class. Expand **触发词 Class** in browser details to edit tags and appearance Subclasses, each independently collapsible. Triggers are optional **Pool candidates**, selected with ＋ or edited as block text. Pool edits do not replace workflow content.
- Block settings expose **Model strength / CLIP strength**. The fixed invocation stays in Source and is hidden in Blocks / Content. Schedule applies to both the invocation and prompt content. Parent random selection picks whole LoRA blocks; a LoRA block's own random settings affect its prompt content while keeping the invocation.
- Click the **LoRA** header badge or **打开 LoRA 详情** in LoRA settings to open that model's browser detail page.

Trigger pools are created only on first edit/send. Read local model-side `.metadata.json` / `.civitai.info`, local previews and Civitai image URLs first. **Fetch Civitai metadata** queries the current file on demand and caches results under XYZ's data directory. Reopening/sending does not restore manually deleted pool tags; **Import metadata triggers** explicitly appends them. Models with missing metadata remain usable with manually edited triggers.

Trigger combinations preserve the author's Civitai/sidecar array entries before their contents are parsed. Multiple character, appearance or outfit combinations become separate Subclasses even when they share no tags. Arrays of only short atomic tags stay flat; legacy `,,` combinations are also supported. Complete prompts and attention weights survive, with deduplication within each combination and shared tags allowed in sibling Classes. Character names take priority, followed by recognized outfits or numbered names. Reimport reuses Classes and preserves custom names/tags. Details display the original entries separately; previously flattened tags are regrouped only on explicit import or an explicitly requested repair.

The disk tree is for browsing; editable Classes are trigger pools stored in the PLv4 database, accessed through the LoRA browser separately from the ordinary Library tree. No model files are moved. When identical relative filenames exist in several model roots, only ComfyUI's preferred file can be sent, avoiding a different model being loaded.

V4 emits selected `<lora:...>` calls at the end, preserving effective schedules and removing only copies caused by Region ambient injection. Explicitly authored separate calls remain separate. Connect the same **prompt** to **PC: Schedule LoRAs** and **PC: Schedule Prompt**. LoRA patches affect the whole model; Regions constrain trigger/prompt text. Workflows and saved Library blocks preserve LoRA identity and content without a database at execution; copying Source alone carries PLv3 syntax.

## Library: Folders, Classes and saved Blocks

Each tree level lists **Classes → Folders → Blocks**, with names alphabetized within each type, ignoring case. Move and binding selectors use the same order.

A **Folder** organizes subfolders, Classes and saved Blocks. It cannot contain loose prompts or serve as a pool. It keeps the existing folder icon.

A **Class** is a hierarchical prompt pool containing loose prompts and Subclasses, with a new layered icon. Its page edits those prompts and controls autocomplete. Each layer shows Subclasses first, then its local prompts; both groups are alphabetical, ignoring case. Classes do not store Blocks.

A **Block** stores ordered prompts and subblocks and uses the same editor as workflow nodes. Its storage Folder and its bound Class are independent.

The Library tree displays Folders, Classes, saved Blocks and contained subblocks. Loose prompts are edited on Class pages. Clicking a Folder name folds or expands its contents without opening a page or tab; its context menu provides creation, rename and move actions. Class pages create Subclasses / prompts. Contained subblocks are not automatically saved as separate assets.

Each Class and Subclass has an inline input and **Add** button. Paste multiple tags separated by English or Chinese commas; prompt syntax keeps attention groups and LoRA calls intact. Failed additions retain the input. Move destinations and block Class bindings share a directory tree, icons and path navigation; the binding dialog also supports unbinding. Deletion offers **Cancel / Delete** and removes all contained items in a Folder or Class. Expanding, collapsing and refreshing Library retain its scroll position.

LoRA trigger Classes, their Subclasses and saved LoRA Blocks are currently hidden from the ordinary Library tree, storage pages, search, destination selectors and Source Library path completion. Their data remains available to the LoRA browser and fixed block Pool bindings.

Sibling Folder / Class / Block names and sibling subblock names must be unique, with unique full paths. Compact chains stay within one type. Single-click browsing of Classes and Blocks shares one italic temporary tab; editing or double-clicking pins it. Class prompt edits save immediately; Block content is saved explicitly.

Upgrade old Folder pools explicitly through **Library ＋ → 转换旧 Folder 池**. A SQLite backup precedes conversion. Pools with prompts, autocomplete or known bindings, and their ancestors, become Classes with the same IDs. Storage-only directories remain Folders; mixed directories receive outer storage Folders. Bindings, content, disabled items and compilation behavior survive. Startup does not perform this content conversion automatically.

## Binding a Class and using Pool

Bind at most one Class in a block's settings. **Pool** lists loose prompts from that Class subtree and saved Library Blocks bound to those Classes, regardless of their storage Folder. Each layer lists **Subclasses → Blocks → Prompts**, alphabetized within each type, ignoring case; Content keeps its actual document order. Child blocks do not inherit the parent's candidate list.

Pool type/usage filters and folding preferences persist per Block and bound Class in the browser, across Settings/Window reopening, page refresh and ComfyUI restart at the same address. Display preferences do not change the document, compilation or undo history.

Content, Pool prompts and expanded candidate Block previews use the same **🖼** Danbooru preview as autocomplete and related tags. XYZ Settings controls artist-only versus all-tag previews and image count. Ordinary text and Gelbooru-only tags have no icon. All hosts share the popup, cache and image endpoints.

- Click **+** on a prompt or saved block to append it to Content. Existing content is not added again, enabled again or moved.
- For a saved block bound to the same Class as the current block, **+** adds its prompts and child blocks without an outer wrapper. Existing prompts are skipped; child blocks and disabled items survive, with one undo step. Independently bound children and special containers keep their own content semantics.
- Added entries remain visibly marked, even when disabled. Class, block and prompt styles stay distinct.
- Use **expand all / collapse all**, a type filter (**All / Prompt / Block**) and an independent usage filter (**All / Unused**). Filters can be combined.
- Expand candidate blocks for read-only previews; edit inserted copies in Content.
- A Subclass's **＋内容** merges loose tags from its entire subtree into the current Block, using the saved-Block deduplication rules and preserving existing items' positions and enabled states. **＋子 block** inserts those tags in a new child bound to that Subclass, enabled by default. Neither action includes candidate Block contents or automatically saves a Library Block. Each insertion takes one undo step.

Drag a Class's dedicated insertion handle into the editor to create an **empty block bound to that Class**. Dropping inside a block creates a child. Change an existing block's binding explicitly in settings. Saved blocks support **keep structure** and **prompts only** insertion.

Completing an edit collects new tags into the bound Class's own layer. Collection includes unbound descendants and stops at children with their own binding. It collects tags, never structure, checking loose prompts in the Class subtree; candidate Block contents do not suppress collection. Deleting or disabling workflow content does not delete pool tags. Opening existing workflows establishes a baseline and does not restore manually removed pool tags.

Loose tags cannot repeat along an ancestor chain. Adding a tag to a child moves an ancestor's loose tag down; adding it to a parent when a descendant already contains it is rejected. Sibling branches may share tags. Tags inside saved blocks are exempt. A Class's autocomplete switch contributes recursively collected tags to existing autocomplete without copying another dataset.

Only saved Library Blocks enter the bound-Block list. Workflow-only blocks and contained subblocks without their own saved asset are excluded. A Library Block excludes itself while being edited. Adding copies its snapshot, nested bindings and disabled items. Membership follows explicit saves, rebinding, movement and deletion.

## Copies, updates and saving

**保存为 Block** in the center header saves all content of the current workflow node to Library. A single complete Block is saved directly; loose prompts, multiple Blocks or an empty node are wrapped in one Block, retaining child IDs, order and disabled content. Cancel leaves the structure unchanged; wrapping and saving share one undo step. Existing sources support overwrite or save as new. Whole Document saving remains a separate entry.

Insertion creates an independent copy with a source marker. **Update from Library** adopts saved content; **Overwrite Library** explicitly writes the edited copy back. Other copies do not change automatically. Embedded Library subblocks are contained snapshots, without shared-child persistence. Concurrent edits report version conflicts rather than silently overwrite.

Library paths use dots, such as `Artists.Painterly.Warm palette`; Source labels use `[full.path]: { ... }`. Stable source IDs preserve identity after renaming; current paths are displayed when available. Compilation reads the expanded document, never the database.

## V3 compatibility and migration

V3 nodes retain compatibility identities and are deprecated; standalone V3 Editor / Library entries are retired. The node Editor button opens V4. Documents edited with V4 use its node-seed policy; untouched V3 documents retain V3 behavior.

Choose **Library menu → 从 V3 迁移（保留原库）** to import V3 data. Confirmation creates a SQLite backup and imports into the separate V4 Library without replacing V3.

| V3 data | V4 destination |
|---|---|
| Group | Class with a storage Folder |
| Child group/reference | Subclass with a storage directory |
| Atomic item | Loose tag |
| Preset | Saved Block in a Folder, bound to its Class |
| Group settings | Additional `全部内容` saved block when needed |
| Saved document | Complete Document, including disabled content |

References become copies. Repeating an unchanged import is detected. Personal libraries are never migrated automatically. Earlier experimental V4 Class databases require the [copy converter](DEVELOPMENT.md#迁移与样例).

V4 data lives in gitignored `prompt_library_v4_data/plv4-pools.db`; V3 stays in `prompt_library_v3_data/`. Earlier `plv4.db` files are not automatically upgraded or overwritten. Back up runtime databases before moving an installation.
