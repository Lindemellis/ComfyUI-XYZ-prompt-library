# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

> **Start here:** read `prompt_library_v4/DEVELOPMENT.md` and local `HANDOFF.md` (if present) for current state, hard-won gotchas
> (curl_cffi/Cloudflare, contentless-FTS5 delete, cursor pagination, etc.), how to test
> cheaply, and the likely-untested areas. Respond to the user in 简体中文.

## Project Overview

ComfyUI-XYZNodes is a ComfyUI custom node pack built around **Prompt Library V4** (PLv3 language/compiler and V3 compatibility), rectangle masks, a Krita bridge, cache slots, inpaint RGBA, an image/video gallery, English-only Danbooru/Gelbooru tag autocomplete, and a local comfyui-mcp agent integration.

> **PLv1 is gone.** The legacy JSON prompt library (`prompt_library_node.py`, its two windows, its five `/xyz/prompt_library/*` routes and the `prompt_library/` data dir) was deleted. Only `node.py`'s `ByPassTypeTuple` survives from it, and that is now a shared helper the mask and Krita nodes depend on for their variadic outputs.

## Prompt Library V4 (`prompt_library_v4/` + `js/plv4/`) — current editor and Library

Folder-pool stage closed on **2026-10-08**; LoRA / AVG / native-input and menu follow-up closed by the user on **2026-10-10**, with documentation, GitHub publication and installation in regular ComfyUI authorized. Read `prompt_library_v4/README_zh.md` for user behavior and `prompt_library_v4/DEVELOPMENT.md` for architecture, migration and validation. `plv4.md`'s final "新的block架构设定" and later explicit corrections supersede earlier Class designs; `plv4_plan.md` records the completed implementation. Historical local prototypes are not runtime contracts.

- **Folder / Class / Block, with Tag leaves.** Folder only contains Folder/Class/saved Block; Class only contains Class/Tag and provides a pool. Pool lists explicitly saved Blocks bound to each Class by inverse metadata lookup, independent of storage. No attribute, belong/load, dummy, class instance, shared Library block pointers or auto-persisted internal blocks. Documents have a separate save/load entry.
- **Document v2 is truth.** Stable IDs, enabled flags, metadata and invalid drafts survive editing. Source/Blocks/Preview share history. Compilation uses PLv3 and never reads Library. V4 uses node seed for all random choices, ignoring group overrides; untouched V3 documents retain V3 policy.
- **One meta.pool per block**, without candidate inheritance. Collect tags after completed edits; traverse unbound descendants, stop at independently bound children. Deduplicate loose tags against the Class subtree; candidate Block contents do not suppress collection. Opening/restoring workflows establishes baselines and must not re-add manually deleted pool tags.
- Loose tags cannot repeat on an ancestor chain; classify ancestor tags downward, reject parent additions when descendants contain them, allow sibling duplicates. Saved block tags are exempt. Sibling Folder/Class/block/subblock names must be unique; stable source IDs and versions support explicit update/overwrite.
- **Content and Pool stay separate.** Content follows actual order, edits descendants and retains disabled rows in place. Pool uses + to append, marks added regardless of enabled, offers independent type/unused filters and fold controls. Existing candidates are not re-enabled, reordered or made the active detail target.
- Class pages edit loose tags recursively, sorting each layer alphabetically; Folder clicks fold/expand the Library tree without opening pages/tabs. Settings Pool sorts peer tags/Classes/Blocks alphabetically, while Content and saved data retain actual order. Library blocks reuse Node Blocks UI. One temporary italic Library tab is replaced during Class/Block browsing and pinned by editing/double-click. Class insertion uses a dedicated handle to create an empty bound block; dropping does not change an existing block's binding.
- LoRA trigger pools are Classes. Hide LoRA Classes/their descendants and saved LoRA Blocks from ordinary Library tree/search/pages/selectors/Source Library paths using library_hidden; keep their full records for LoRA browser, fixed bindings and Pool. LoRA pages can edit their hidden Subclasses. Do not remove their data to hide them.
- model.py/commands.py own stateless POST /xyz/plv4/document/{open,command,compile}. assets.py/hierarchy.py own single-writer snapshots and /xyz/plv4/library/{read,mutate,migrate}. document_session.js owns queue/history; host_sessions.js keys nodes by object identity, not numeric ID.
- Reuse js/plv3/editor_core.js PromptEditor and text_editing.js; do not fork Monaco/TagAC/grammar. Native TextRun uses plaintext-only; Enter / Backspace / Delete are browser-native, with no manual newline edits or caret reset. Exclude decorations and the native terminal display newline from source offsets. Toggles preserve user blank lines; structural formatting is local. Empty/run typography is shared; boundaries only occupy layout during drag preview.
- Header More has hover sibling/child submenus for ordinary / Schedule / Region / AVG blocks, retaining entry and nesting restrictions. Opening it must precede native-input blur commit, so render cannot remove a pointer target between press/release. Test this with actual mouse events after auto-focus and body edits; DOM click alone misses the regression.
- Blocks Find borrows the same Monaco widget, removing/restoring Source overlay registration. block_find.js scopes to displayed prompt characters, excluding configuration. Enter and arrows use identical editor actions; CSS Custom Highlight keeps matches visible while search retains focus. Clear state on close/tab/view/dispose. Check private Monaco APIs on upgrade.
- New DB: prompt_library_v4_data/plv4-pools.db. Never silently upgrade plv4.db. V3 group→Class plus storage Folder, preset→saved Block bound to Class, child group→Subclass; backup import leaves source intact. Experimental V4 conversion requires a nonexistent new target. Personal migration needs a specific user request. Old Folder pools are explicitly converted by separate_types with a pre-write backup; preserve pool IDs, snapshots and disabled items. Schema CHECK extension alone must not convert asset kinds. See DEVELOPMENT.md’s 2026-10-11 Class section.
- Tests t70–t83 include 13 offline Node suites through t72, LoRA, AVG, retirement and Class coverage; t46–t62 protect PLv3. Disposable real-ComfyUI browser checks cover input/caret, typography, menus, Class pools and retirement without V3 Library services; current results are in DEVELOPMENT.md. Preserve local prototypes, personal data and the user's persistent 8190 test instance. Regular ComfyUI loads this repository under custom_nodes; never deploy a fixture database or synthetic workflow into it.
- **2026-10-11 V3 product retirement:** read `plv3_retirement_plan.md`. Root startup initializes V4 and shared stateless language routes; it never calls V3 setup or opens its Library writer. V4 setup owns Document / Library / LoRA and shared routes. `prompt_shared/language/` is the canonical parser / Document / IR / compiler; historical V3 modules alias the same module objects. `prompt_shared/storage.py` owns generic connections / WriteQueue; V4 does not import V3 storage. `js/prompt_shared/node_host.js` installs all four node hosts, keeping legacy widget / event names; `js/plv3.js` is a thin adapter. V4 completion never requests V3 Library; historical blur-sync and save-selection-to-V3 are retired. V3 Tools entries/global UI handle are removed, V3 nodes are DEPRECATED but keep identity/sockets/compiler policy; all Editor buttons open V4. Untouched V3 workflows retain V3 policy until opened in V4. t82 and the retirement browser fixture cover startup, alias identity and workflow compatibility. Keep V3 directories, historical adapters, personal databases and persistent 8190 intact; migration remains explicit.

## Prompt Library V3 (`prompt_library_v3/` + `js/plv3/`) — language/compiler and compatibility

**Current boundary:** pure backend implementations now live in `prompt_shared/language/`; the old paths below are module-identity aliases. Shared Monaco / grammar / TagAC remain in `js/plv3/` and must not be forked. V3 Library/window code below is historical tooling, never registered or exposed by pack startup. New changes go to shared language, V4 services or the common frontend host; do not reactivate the retired Library or auto-migrate data.

**Read `prompt_library_v3/README.md` first** (user-facing), then `prompt_library_v3_design.md`
(the locked spec, 36 recorded decisions — it is authoritative; do NOT infer semantics from PLv2,
they differ). `mask_krita_nodes_design.md` covers the mask + Krita nodes — **all of it is built**
(`mask_nodes/`, `krita_plugin/` + `krita_nodes/`, `cache_nodes/`).

PLv3 is its own prompt language compiled to comfyui-prompt-control syntax. The PLv2 runtime
is retired; only its personal data directory and the one-shot `migrate_v2.py` converter remain.

### The invariant everything hangs off
**The DOCUMENT is the truth** (`document.py`; supersedes §5.2's "the text is the truth", user
decision 2026-08-04). A document is the same tree with a stable `id` and an `enabled` flag on
every node; **the text is what its ENABLED nodes render to**. Switching an item off removes it
from the text with no marker of any kind, while the document keeps its content and its index —
so switching it back on restores it *in place* and nothing else moves. Guarantees, all under
test (`test/t59`, `t60`): `render(from_text(t)) == t` byte for byte; any single toggle still
parses; the document's enabled children pair up 1:1 with a reparse of the rendered text (that
pairing is what `indexDocument` in `detail.js` hangs every switch on).
**Original V3 Library-block items keep the old model** (enabled *iff* in the text, disabled ones sorted to
the bottom). This applies to the V3 window only; V4 Content retains actual order and Pool is a separate candidate view.
The node has a hidden `doc` STRING widget carrying the JSON; `execute` compiles the document
when it is there and falls back to `text` when it is not, so an old workflow still runs.
`compile_text(text, seed, region_mode, polarity)` is still a **pure function** of text and never
reads the library DB (§4.7): library groups are fully expanded into the text, so a shared
workflow renders identically without your database.

### Backend
### Separators: `,` drops, `.` stays (spec update 2026-08-05)
Both separate items. A **comma is punctuation between items and is dropped**; a **full
stop is part of the item it ends and is kept** — `tag1, tag2. tag3.` is `tag1`, `tag2.`,
`tag3.`. A `.` separates **only when whitespace or the end of the text follows it**, which
is the single rule that leaves `[a.b]`, `.set`, `0.35` and `<lora:x:0.8>` intact.
`lexer.is_stop()` is that rule and everything asks it: the `STOP` token, `split_sentences`
(used by migration v4), and the JS mirrors (`splitItems` in `library.js`, the Ctrl+↑/↓ tag
boundary in `editor_core.js`). Three joiners had to learn it or they weld a comma onto a
period (`a cat., on a mat.`): `ir._join`, `library.join_items`, and — the one that bit —
**`document._render_node`, which INJECTS a comma** into a separator that has none, to stop
two items fusing. A period-terminated body must skip that branch and only get a space when
the separator is empty. Migration **v4** splits the items already stored and rewrites every
preset whitelist that referenced them (recursively, incl. nested `children` snapshots;
weights follow every piece; a piece whose text a sibling row already has reuses that row,
because `UNIQUE(group_id, text)` is an item's identity). Tests: `test/t62_plv3_sentence_test.py`.

- **`lexer.py` / `parser.py`** — text → AST **with source spans** (`Spans`: node/content/header/
  set_block/fields/region_*/schedule_form). The spans are what let a detail-page control rewrite
  exactly the characters it owns. Two parse modes: **strict** (the node — an unparseable document
  must abort) and **recovering** (`recover=True`, the editor — a broken construct becomes an E03
  and is skipped; everything around it still parses). `Group.implicit` = "these braces are the
  parser's, not the user's" (a bare `0.3 - 1: open eyes` schedule entry).
- **`ir.py`** — AST → segments: schedule intervals, region splitting, **ambient-text injection**
  (a region segment = everything outside any region group + that group's own content).
- **`compile/`** — `couple` and `mask` backends. Output escaping follows prompt-control's own
  table (`\:`, `\#`); PLv3 *source* does not escape `:`.
- **`validate.py`** — whole-tree checks: E01 (nested regions), W06 (duplicate item in a library
  block), W13 (region in a Negative node).
- **`library.py`** — `expand()` (library → text), `sync_text()` (text → library: append what the
  text has and the group lacks — **including refs**; never delete), `build_preset_body()`,
  `write_through()` (a *linked* nested block's edits go into the preset it follows),
  `links_of()`.
- **`db.py` / `repo.py`** — SQLite, WriteQueue single-writer. `UNIQUE(group_id, text)` is a
  **partial** index (`WHERE kind <> 'ref'`) — a ref has no text. **Schema v3 adds `documents`**:
  a whole prompt stored verbatim (`text` + `doc_json`). A group is a flat list of items; a
  document is a tree (several top-level constructs, `[@region]`/`[@schedule]` blocks, free text
  between them) and has no container in the group model — the closest you get is one enormous
  opaque item. `doc_json` rides along because the items switched OFF are by design nowhere in
  the text, so a text-only snapshot loses them at the moment of saving. **`documents` has no
  `UNIQUE(folder_id, name)`** — SQLite treats NULLs as distinct, so it would silently not
  constrain the root folder; `SaveDocumentOp` enforces identity with an explicit `folder_id IS ?`
  lookup instead, which the single writer makes exact. (Same trap applies to `groups` at the
  root — `saveSelectionAsGroup` checks for the clash in the frontend.)
- **A group's own `settings_json` was dead until now**: the column, `CreateGroupOp(settings=)`
  and `PATCH /groups {settings}` all existed, but no frontend ever wrote it, so every group's
  settings were `{}` and only a *preset* could carry a region or a schedule (`build_preset_body`
  → `_settings_of`). `library.create_group_from_text` is the first writer: a selection that is
  exactly one settings-carrying group adopts its settings. Note the shape limit either way — a
  group setting is ONE region / ONE `schedule: {a, b}` interval, never a multi-entry
  `[@schedule]: { 0-0.3: {…}, … }` block.
- **`document.py`** — the document model: `from_text` / `render` / `reconcile` (a hand-edited
  text folded back in: match by identical source, then by ordinal, then a fresh id; parked nodes
  go back at their remembered index, **fail-open**) / `toggle_edit` (one switch → one `{span,
  insert}`, derived by diffing the render before and after so it can never disagree with it).
- **`routes.py`** — `/xyz/plv3/{compile,ast,doc/sync,doc/toggle,library/*,monaco/*}`. Library
  additions: `POST library/groups/from_text` (a selection → a new group, returns the expanded
  block that replaces it in the text) and `library/documents` (POST/GET/PATCH/DELETE); `/tree`
  now carries `documents` (name + size only — never the text). `/compile`
  and `/ast` parse in recovering mode and return partial results with `ok:false`; the node does
  not use them. `doc/sync` rides along with the editor's lint (one round trip, same text the AST
  was parsed from).

### Frontend (`js/plv3/`)
- **`editor_core.js`** — `PromptEditor`: THE editor, used twice (main window + library preset
  view). Monaco, Monarch grammar, tagac autocomplete bridge, `[` completion, markers, span edits,
  blur-sync. **Do not fork it.**
- **`detail.js`** — `DetailPane`, also used twice (`outline`, `presetBar`, `links` options). Spans
  + a version stamp: an edit computed against older text is dropped, not applied.
- **`library.js`** — the library window. A preset's view IS `DetailPane` over the preset's block
  text; the group's own view has no text editor (a group has no enable state to edit). The tree
  has **three** row kinds — `□` folder (foldable, state in localStorage), `▤` group, `▦` saved
  document (read-only page + "load into the active node"). Only `window.js` knows which node is
  open, so both hooks (`onInsert`, `onLoadDocument`) are set from there.
- **The destination dialog is a `showForm` with an `options` field, never a context menu**: a
  dismissed `showContextMenu` resolves nothing, so an `await` on one hangs for the rest of the
  session.
- **`preview.js` / `theme.js` / `settings.js` / `ui.js` / `complete.js` / `tagac_monaco.js`**.
- **`web/monaco/`** — vendored Monaco 0.52.2, served at `/xyz/plv3/monaco/…`. It must NOT live
  under `js/` (ComfyUI globs `js/**/*.js` and would import every file as an extension).

### The traps (all of these cost real time)
- **`depth` in `detail.js` is an INDENT, not tree depth** — it restarts at 0 inside every card.
  Use the `root` flag for "is this a top-level block".
- **A region segment's head is OUTSIDE its node span.** `[imask: 0]:` lives at
  `spans.region_decl`, which sits *before* `spans.node`; a schedule entry's `0 - 0.3:` has no
  span recorded at all. Slice a node by `spans.node` and the head stays behind — the next
  segment inherits it, so switching off `red dress` silently moves its mask onto `blue dress`.
  `document.py` extends every child's slice back to the first non-blank character after the
  separating comma; anything else that cuts nodes out of the text must do the same.
- **A schedule entry's END is not its own**: §3.4 rewrites the previous entry's end to the next
  entry's start. Editing one head alone makes the text and the AST disagree (the slider snaps
  back). Move both sides of the boundary.
- **A region header is `[<kind>, <params>]`, kind ALWAYS first** (2026-08-04). `base` / `fill`
  are bare words, `mask: […]` / `imask: i` carry their value. The kind is still *inferred* when
  absent, and an explicit `kind: base` next to a `mask:` still pins it to base — but the writer
  no longer emits that, because it puts the real kind in first position instead. Two bugs fixed
  with it: a new field was inserted at the START of the header (pushing the kind out of first
  place), and `parse_config_seq` **dropped positional entries as soon as one `key: value`
  joined them**, so `[fill, mask_weight: 0.3]` silently parsed as a BASE region. Positional
  entries now survive under the `POSITIONAL` sentinel key.
- **`imask: i` is the CLIP attach order**, not the Mask Editor's output slot.
- **`[` inside a region block opens a SEGMENT, not a library path.** `complete.js`'s
  `braceContext` only balances `{ }`, so it cannot tell the block's own level from inside a
  `mask: [ … ]` rectangle — both report 'region'. `regionSegmentSlot()` walks `[ ]` as well and
  requires the stack top to be a `[` sitting directly on the region's `{`; only there are the
  four kinds (base / mask / imask / fill) offered.
- **Linking a preset must ADOPT it** (replace the block's text with the linked preset's
  expansion) before any write-through, or the first save overwrites the preset you just linked.
- `node --check` does NOT reliably catch syntax errors in these ESM files. Use
  `node --input-type=module --check < file.js`.
- **PLv4 performance contracts (2026-10-14).** (1) `prompt_editor_binding.js`: the host
  mirrors every commit into the node's `text` widget, which rewrites the SHARED Monaco model
  outside `sync()`. An edit equal to `session.text` with no pending draft is an echo, not a
  draft — taking it for one made every following command pay a `ReplaceText` + `sync_pool`
  round trip and two full re-renders (the "second toggle is slow" bug). (2) `model.strict_parse`
  caches the strict AST by source text and `full_index` / `check` / `refresh_document`
  (`from_ast`) all share it: **every consumer must treat the AST as read-only** (copy before
  mutating, as `region_value` does). `render_all(node, memo)` renders a subtree as if every
  node were on, without the old `full_document(Document(node))` deep copy; the memo is only
  valid while the tree is not being edited (`formatting` mutates seps, so it passes none).
  (3) `BlockView.render` collects the new top level and `place()`s it in position; an
  unchanged cached card must stay attached. `replaceChildren` restyled all ~600 nodes under
  10k+ CSS rules (60–140 ms of forced layout per edit). Never re-introduce a full clear.

## Region × Schedule semantics (user decisions 2026-10-13, implemented + rendered)

All in the shared compiler `prompt_shared/language/` (PLv3 and PLv4 compile through it),
plus the Region container's Timing slider in `js/plv4/details.js`. Tests: `test/t48`
(region timing cases), `t49`, `test/t86_plv4_region_timing_test.py`. Verified by real
renders (isolated ComfyUI, Anima 2.9B int8, 512², 10 steps) in both COUPLE and AND.

- **The one rule.** A schedule ON a region, or on any block ABOVE it (an ordinary parent
  block, a `[@schedule]` stage, the Region container's outer window), decides whether the
  region EXISTS: outside the window the output has no region syntax for it at all, only
  the ambient text. Base and Fill entries obey it too (the old "BASE is never
  time-limited" rule is gone). A schedule on a subblock INSIDE a region only times that
  content; the region stays. (An earlier "region always stays" proposal was rejected by
  the user as counter-intuitive.)
- **Implementation = time slicing.** Whenever a region comes and goes over time
  (`ir.region_timing`) or a `[@region]` has a `region_window`, `compile_text` takes the
  path AVG already used: compile each interval between boundaries separately and emit
  `[slice text, :a,b]`. AVG and non-AVG documents therefore share ONE semantics (they used
  to differ: non-AVG left an empty prompt holding the mask outside the window). Inside a
  slice, W05 is suppressed (the full-tree pass reports real ones), W11 no longer compares
  schedules, diagnostics are de-duplicated, and a random group meeting a segment it never
  met in the full-tree pass reuses its draw from anywhere (`random_plan[("any", id)]`).
  LoRAs are centralised whenever slicing, as with AVG.
- **`region_window`** (`.set{schedule: {0, 0.8}, region_window: {0, 0.4}}`, `[@region]`
  only — `Group.region_block`; elsewhere W08 and ignored). Inside `schedule` but outside
  the window the block stops splitting: its entries render as ordinary groups
  (`plain_regions_for` → `RenderCtx.plain_regions`, the AST is NOT mutated), merged in
  document order like the `plain` output; include_in_base copies are not duplicated.
  PLv4 `SetSettings` accepts it on Region containers only. UI: ONE rail, FOUR handles with
  **no identity** — after each drag the positions are sorted, outer two = `schedule`,
  inner two = `region_window`; inner on outer → field omitted ("always split"); outer at
  0..1 → schedule omitted. Greyed out while the container's Region switch is off.
- **prompt-control's invisible empty base.** Text before the first `COUPLE` is PC's base
  prompt — an EMPTY one when nothing is there — and it is full-image unless it says
  `FILL()`; masks are normalised per pixel, so it took HALF of every region (render: the
  right character lost her colour entirely). Now, whenever regions have text but no
  base/fill has text, `build_segments` adds a synthetic fill (`Segment.synthetic`, kept
  OUT of `CompileResult.segments`) carrying the ambient text: COUPLE emits
  `FILL() <ambient>` first (bare `FILL()` if there is no ambient text).
- **AND-mode gaps predict ZERO.** ComfyUI `_calc_cond_batch` divides by
  `out_counts` initialised to 1e-37, so a pixel no mask covers gets a zero positive
  prediction and CFG turns it into `uncond * (1 - cfg)` — a noise band in the render. The
  mask backend emits the synthetic fill as "full image minus every region" unless plain
  fractional rectangles provably cover the image (`mask._covers_image`; IMASK, feather or
  pixel coords mean "unknown" → emit it).
- **PC trap: no space after the comma before a composite op.** PC splits `MASK(...)` /
  `IMASK(...)` arguments on commas WITHOUT stripping, and `MaskComposite` compares the op
  by equality: `MASK(0 0.4, 0 1, 1, subtract)` passes `" subtract"`, matches nothing, and
  returns the mask unchanged — the "minus every region" fill silently covered the whole
  image (a pre-existing bug for user-written Fill in AND mode too). `compile/common._op`
  writes `,subtract`. Check PC's log: `op= subtract` with a space is the symptom.
- Observed in renders (10 steps): whatever is active in roughly the first 40% decides
  colour and layout; late-stage content shows only weakly (a 0.15 boundary was needed to
  see it). A Base with include_in_base dilutes the OTHER regions (base is full-image) —
  existing behaviour, not a bug.
- How to render-test without touching the user's instance or gallery DB: start ComfyUI
  with `--disable-all-custom-nodes --whitelist-custom-nodes comfyui-prompt-control
  ComfyUI-Anima-2.9B` on another port with scratch user/output/temp/input dirs, compile
  the prompt outside, POST `/prompt` (UNETLoader → PCAnimaAttnCouplePatch → KSampler,
  PCLazyTextEncode). The user must close 8188 first: it holds most of the 8 GB VRAM.

## Node Types (registered in `__init__.py`)

> `node.py`'s own nodes (Concatenate / Replace / Clip Encoder / Random Picker) were
> **removed**; only `ByPassTypeTuple` (the variadic-output helper) survives there.

- **XYZ Mask Editor / XYZ Attach Masks** (`mask_nodes/nodes.py`) — see the Mask Nodes section below
- **XYZ Prompt Library V4 / V4 Monaco** (`prompt_library_v4/node.py`) — current Blocks/Source/Preview editor, Class pools, node-seed policy and pure PLv3 compiler; outputs prompt/plain/PLV4_METADATA plus appended PLV4_MASK_BUNDLE. V4-only mask_resources resolves one consistent snapshot before compilation; shared language never reads resource stores. Region backend is controlled in the V4 window; existing hidden widget remains its serialized truth.
- **PLV4 Mask Library / Preview / Attach** (`prompt_library_v4/mask_*.py`, `js/plv4/mask_*.js`, `js/xyz_plv4_mask_preview.js`) — independent masks.db / shared WriteQueue, versioned rectangles/tombstones and read-only registered input pictures. Region meta.mask_library carries references/fallback; explicit Source coordinate/type edits detach. Preview keys retain connected unused slots with zero MASKs; backend slot_keys owns the returned arity. Attach clones CLIP and appends only pictures, warning on index mismatch without repairing prompt. See plv4_mask_library_plan.md and DEVELOPMENT.md; t84 and disposable mask fixture are targeted checks, never personal/persistent-instance fixtures.
- **XYZ PLV4 Image Metadata** (`prompt_library_v4/image_metadata_node.py`) — merge positive/optional negative snapshots and extra fixed LoRA syntax into METADATA for the locally updated Aaalice Conditional Save Image. Versioned Source/Document/output data travels in parameters via additional_data; requires installed Lora Manager but no Metadata Overwrite node. Gallery reads image snapshots without Library; see `plv4_gallery_metadata_plan.md` and DEVELOPMENT.md. Do not scan Source or rerandomize to infer effective LoRAs; use shared CompileResult.loras. V3 still has two outputs.
- **XYZ Prompt Library V3 / V3 Monaco** (`prompt_library_v3/node.py`) — compatibility nodes: compiles a PLv3 document to comfyui-prompt-control syntax. **Two outputs**: `prompt` (regions compiled) and `plain` (`compile_text(..., ignore_regions=True)` — `strip_regions` drops every region declaration before validate, so base + every region + fill land in ONE prompt in document order, schedules/weights/loras intact). Both use the same seed, so a shuffle draws once. The two nodes differ ONLY in their editor (plain textarea vs embedded Monaco, a frontend concern in `js/plv3.js`); the backend is identical. **No positive/negative split any more** — both compile the same, `polarity` is dropped from the nodes (regions are always kept; a region must simply not be wired to a negative conditioning — documented in the README, not enforced). `compile_text` still accepts a `polarity` arg for the pure-function/validate tests. Never reads the library. See the PLv3 section above.

## Mask Nodes (`mask_nodes/` + `js/xyz_mask_editor.js`, `js/xyz_attach_masks.js`)

Part one of `mask_krita_nodes_design.md` (decisions 1–7). Feeds PLv3's `imask: i`.
The IMASK coupling is verified end-to-end with a control: remove `XYZ Attach Masks` and
prompt-control warns `IMASK requires you to attach custom masks`; put it back and the
warning is gone.

- **`XYZ Mask Editor`** — rectangles on a fixed 512×512 canvas. Slot layout is
  **`0 = preview (IMAGE)`, `1 = base`, `2 = fill`, `3.. = one MASK per rect`**;
  `RETURN_TYPES` is a `ByPassTypeTuple(("IMAGE",))` so the count can be variadic, and the JS
  adds the real slots with their real types. **A mixed-type variadic output works only
  because `TautologyStr.__ne__` returns False** — every slot reports the type of slot 0 and
  compares equal to anything, so an IMAGE slot validates against an IMAGE input and a MASK
  slot against a MASK input. `preview` is white paper with one palette colour per rect,
  **lower index painted on top**, blended by each mask (so a feathered edge fades to white);
  the colours match `js/xyz_mask_editor.js` exactly, or the preview would not look like the
  canvas you drew on. Rects live normalised (0..1) in the hidden `rects` JSON widget — **that widget
  is the truth**; the canvas, the list and the output slots are all views onto it.
  **A rect has no name.** The slot name is positional and 0-based (`mask_0`, `mask_1`, …)
  so it *is* the IMASK index you write as `imask: i`; delete one and the rest renumber.
  (An editable display name existed briefly and was cut — it bought nothing and it
  collided after a delete.)
  `feather` is an **inward** fade in px of the 512 canvas (edge = 0 → 1 over `feather`
  px), clamped to half the rect minus half a pixel so the centre actually saturates.
  `fill` = `1 − Σ masks` (clamped), i.e. the complement of what is *emitted*, not of the
  hard rectangles — so `Σ masks + fill == base` everywhere, feather included.
- **`XYZ Attach Masks`** — `clip` + dynamic `mask_1..mask_16` → `clip`. Appends the
  non-empty masks **in slot order** to `model_options["x-promptcontrol.masks"]`
  (`PC_MASKS_KEY`). This is the **only** place in the project that touches
  prompt-control's internals. It copies the list rather than `.extend()`-ing what
  `.get()` returned, so an upstream CLIP is never mutated.

### The traps
- **`imask: i` is the ATTACH ORDER, not the Mask Editor's slot number.** Wiring
  `base`/`fill` into Attach Masks shifts every index by 2 and fails silently. Mitigation:
  the input labels read `mask_1 · IMASK(0)`, the rect list shows `imask N`, and the node
  prints the mapping table on execute.
- **Deleting a rect shifts every slot after it**, and ComfyUI links are addressed by slot
  index. (`FIXED_OUTPUTS = 3` — preview/base/fill — so the masks start at slot 3.) `syncOutputs()` in `xyz_mask_editor.js` saves each link keyed by **rect id**,
  rebuilds the slots, then reconnects — a rebuild only happens when the id list actually
  changes (a rename is just a label edit).
- **Unplugging a middle mask** in Attach Masks would leave a hole and renumber every
  IMASK after it. `refresh()` compacts the links up and keeps exactly one spare slot.
- **The mask maths is numpy, not torch** — `build_masks()` is pure numpy and `execute()`
  converts at the boundary, because torch lives in ComfyUI's interpreter and pytest lives
  in the dev one. Test through `build_masks()`, not `execute()`.
- **A DOM widget's `computeSize` must NEVER read the node's own size.** A node's height is
  the sum of its widgets' heights, so `() => [w, node.size[1] - 90]` is a feedback loop:
  every layout pass adds another slice. The Mask Editor grew to **1,100,044 px** this way.
  The rule that keeps it resizable *and* stable — only ever go one way:
  `computeSize` reports a **minimum** derived from the rect count alone; `sizeCanvas()`
  reads `node.size` and writes **only** to the canvas element. Nothing reads a size and
  writes it back. `clampNode()` also repairs an absurd serialised height, or a workflow
  saved while the runaway bug was live would restore the giant node forever.
- **`sizeCanvas()` cannot measure the DOM.** This ComfyUI (frontend 1.45) never gives the
  `.dom-widget` wrapper a height — it is `position:fixed`, computes to `0px`, and the
  content just overflows it. Every element inside measures 0×0, so a ResizeObserver reads
  nothing. Derive the canvas size from `node.size` and `LiteGraph.NODE_TITLE_HEIGHT` /
  `NODE_SLOT_HEIGHT` instead.
- **`XYZ Attach Masks` has the mirror problem**: the node def declares all 16 optional
  slots, so LiteGraph sizes the node for 17 rows and `refresh()` must `setSize` back down.
- **Browser-testing this needs the tab in the FOREGROUND.** A background tab runs no rAF,
  so ComfyUI never positions its DOM widgets, they measure 0×0, and synthetic pointer
  coordinates come out NaN — the drags "work" but write garbage rects. Call
  `Page.bringToFront` before driving the canvas.

## Krita Bridge (`krita_nodes/` + `krita_plugin/` + `js/xyz_krita.js`)

Part two of `mask_krita_nodes_design.md` — **all of it is built**: the plugin, the installer,
the layer list, and `XYZ Krita Fetch Image` / `Fetch Mask` / `Fetch Color Masks` /
`Send To Krita`. The cache slots (§13) are `cache_nodes/` — they have nothing to do with
Krita. User manuals: `krita_nodes/README.md`, `cache_nodes/README.md`.

- **Fetch Color Masks** (§11) — the colour maths is pure numpy in `nodes.py`
  (`pick_colors` / `split_colors`), fed by the plugin's ordinary `/image` endpoint; the
  plugin knows nothing about it. The `count` largest colour regions, **ordered by hex value
  ascending** (not by area — that is what keeps a slot pointing at the same colour when you
  repaint). Every pixel joins its NEAREST colour within `tolerance` and none beyond it, so
  masks never overlap and never leave a seam on an anti-aliased edge. Only solid pixels
  (alpha ≥ 128) are counted when picking, or an AA smear would crowd out a real region.
  Dynamic outputs follow `count` (js).
- **`launcher.py`** — finds `krita.exe` (saved path → `XYZ_KRITA_EXE` → PATH → the usual
  install dirs), starts it **detached**, and **waits for the bridge to answer** (~20s; a
  caller that fired the moment the process existed would just time out). `krita_data/
  settings.json` holds a hand-set path. Every Krita node gets a **Launch Krita** button, and
  `Send To Krita` has `launch_krita` (default on). **`launch_krita` off is a real toggle, not a
  no-op:** when Krita is not running the node **quietly returns `{}`** instead of failing the run
  (best-effort send). It used to `ping` unconditionally and error with `KritaUnreachable`. On
  (default) it launches Krita; a freshly launched Krita has no document, so the ping-fallback below
  turns `new_layer` into `new_document`.
- **Send To Krita** (§12) — `mode: new_layer | new_document`. `new_document` (`POST
  /document`) is the FRONT of the workflow: `add_layer` cannot start one, it needs a document
  to add to. `createDocument` must be followed by `window.addView(doc)` or the document exists
  but is invisible and `activeDocument()` keeps returning the old one. `POST /layer` with the
  PNG as the body. **Size mismatches are the `fit` COMBO** (user decision 2026-08-05, replaced
  the old `scale_document` BOOLEAN outright — old workflows reset to the default):
  `keep` (own size, centred, canvas untouched, a bigger image overhangs — a paint layer may
  hold pixels outside the canvas), `fit` (scale to canvas **keeping the aspect ratio**, centred;
  the old code stretched with `Qt.IgnoreAspectRatio` and silently deformed anything of another
  shape), `grow_canvas` (bigger image → canvas grows, existing content scaled by **one** factor
  = `min(new/old)` so it fits whole and does not deform, image in 1:1; not bigger → same as
  `keep`). **All the maths is `krita_plugin/xyz_comfy/geometry.py` — pure ints, no Krita, no
  Qt**, because `ops.py` does `from krita import Krita` at module scope and cannot be imported
  by pytest (same split as `build_masks`). `ops.add_layer` only executes the plan:
  `scaleImage` (content) then `resizeImage` (frame, no scaling) then `setPixelData` at the
  plan's offset, **which may be negative**. Two invariants under test: the canvas only ever
  grows (so `grow_canvas` takes `max(image, canvas)` per axis, or a wide-but-short image would
  crop the document), and anything not filling the canvas is centred. `test/t63_krita_fit_test.py`.
  **Changing any of this needs the plugin REINSTALLED** — `installer.py` copytree's it into
  `pykrita`, and Krita runs that copy, not the repo.

- **`krita_plugin/xyz_comfy/`** — the Krita plugin (copied into `pykrita` by the installer).
  `server.py` runs an HTTP server on `127.0.0.1:8765` in a daemon thread; `ops.py` does the
  Krita work; `bridge.py` marshals it. **Design decision 10 in the spec says "temp PNG +
  HTTP" and describes the danbooru-gallery implementation — that description is WRONG.**
  The reference actually uses a temp-dir `.request`/`.response` file protocol. We chose a
  real HTTP server (user decision); PNG bytes come back in the response body, no temp files.
- **`krita_nodes/`** — `client.py` (urllib), `installer.py`, `nodes.py`, `routes.py`
  (`/xyz/krita/{ping,layers,plugin,plugin/install,plugin/uninstall}`).

### The traps (every one of these cost real time)
- **`kritarc` is NOT next to `pykrita`.** Plugins live in `%APPDATA%\krita\pykrita\`
  (Roaming) but the config Krita actually reads is `%LOCALAPPDATA%\kritarc` — different
  root, **no `krita\` folder**. ComfyUI-Danbooru-Gallery's installer writes to
  `%APPDATA%\krita\kritarc`, which Krita never reads; **do not copy that code.** Symptom:
  the plugin installs, Krita starts, and absolutely nothing happens — no error, no log.
- **`X-KDE-PluginInfo-EnabledByDefault=true` does nothing.** Krita only loads a Python
  plugin with an explicit `enable_<name>=true` under `[python]` in kritarc.
- **Krita rewrites kritarc when it EXITS**, from what it read at startup. Enabling a plugin
  while Krita is open is silently undone on quit. The installer detects a running Krita and
  says so.
- **Krita's API is main-thread only.** The HTTP handler must never touch a Document/Node;
  everything goes through `bridge.MainThread.call` (queued Qt signal + `threading.Event`).
- **8-bit RGBA out of Krita is BGRA**, which is exactly `QImage.Format_ARGB32` on a
  little-endian box — the bytes drop straight in. Only *float* formats are RGBA. And
  **`QImage` borrows the buffer**: `.copy()` or you get garbage/a crash.
- **A COMBO with dynamic values needs `VALIDATE_INPUTS`.** ComfyUI rejects a combo value
  that is not in the list `INPUT_TYPES` declared — unless the node defines `VALIDATE_INPUTS`
  with that input in its signature, which makes it skip the check (`execution.py:1007`).
  The layer list cannot be known at `INPUT_TYPES` time (that runs at `/object_info`, i.e. at
  startup, and asking Krita there would hang the frontend whenever Krita is closed).
- The combo entry is `"<short id>: <layer name>"` — **id first**, because a layer name may
  contain a colon. The plugin matches an id by prefix. Layer identity is
  `Node.uniqueId()`, so renames and duplicate names are both fine.
- **`doc.xRes()` returns a float but `doc.scaleImage()` wants ints** — passing it straight
  through is a `TypeError` that only fires on the `scale_document` path.
- `QImage.constBits().asstring(sizeInBytes())` is how you get the buffer back out for
  `setPixelData`. ARGB32's buffer is BGRA, which is the byte order Krita wants — the same
  identity as the read path, in reverse.

## Inpaint (`inpaint_nodes/`)

**`XYZ Inpaint Stitch To RGBA`** — the same two inputs as ComfyUI-Inpaint-CropAndStitch's
**Inpaint Stitch Improved**, but it returns the inpaint as a LAYER instead of a flat picture:
`rgb = inpainted, alpha = blend mask`, on a transparent image the size of the original, at the
right position. Stitch does `mask*inpainted + (1-mask)*original`; this omits the second term and
keeps the mask as alpha, so **compositing it over the original reproduces Stitch pixel for pixel**
— that identity is the whole spec and `test/t64_inpaint_rgba_test.py` asserts it. Built for
`XYZ Krita Send To Krita` with `fit: keep`: the inpaint lands as a layer over untouched artwork.

- **No dependency on that pack.** `STITCHER` is only a socket name and the stitcher is a plain
  dict, so the node loads either way; missing keys raise a sentence, not a `KeyError`.
- **Mirror `inpaint_stitch_single_image` exactly or the identity breaks**: the filter choice is
  `ctc_w > w or ctc_h > h` (upscale vs downscale), both crops are needed (`ctc_*` pastes onto the
  canvas, `cto_*` cuts back to the original — the canvas is NOT the original, outpainting extends
  it), and every per-image field is a **list**; a 1-entry stitcher legitimately drives a whole
  batch (Stitch's `override`).
- **The RGB is kept where alpha is 0.** The blend mask is feathered, so along its edge alpha is
  partial and `a*rgb + (1-a)*dst` needs the real colour; blanking it haloes every composite.
- `compose.py` is pure numpy (`place_rgba`), `nodes.py` converts at the boundary — same rule as
  `build_masks` and the Krita `geometry.plan_layer`.

## Gallery ↔ Krita, steps, downloads (2026-08-06)

- **`krita_nodes/send.py`** — `send_png()` is now the ONE place that knows the send
  sequence (launch-and-wait, then the **`new_layer` → `new_document` fallback** when
  Krita has nothing open, which is the usual state right after a launch). The node and
  the gallery both call it; two copies would drift on exactly that fallback.
- **Gallery "Send to Krita"** — `POST /xyz/gallery/images/send_to_krita {ids, mode, fit}`;
  the route lives in the gallery because it already owns id→path and `assert_inside_root`.
  Batch: one layer per image, and the per-image fallback means the first image creates
  the document and the rest land on top of it — that falls out, it is not special-cased.
  One failure never sinks the batch (the reply names what did not go). Non-PNG is
  re-encoded (`_png_bytes_for_krita`): the bridge decodes with an explicit PNG hint.
  **`all_except` selection sends nothing** — `selectedExplicitIds()` returns [] there on
  purpose, because "everything matching the filter" could be 8000 layers.
- **`image.steps`** — schema **v7**. It was never extracted at all, in either parser.
  Rows indexed before v7 stay NULL: the value is in the PNG, so filling it in means
  re-reading files, which a startup migration must not do. Settings → "Re-read missing
  metadata" marks those rows `pending` (`ResyncMissingStepsOp`, ONE transaction) and the
  existing sync worker picks them up on its own poll.
- **Download = two booleans, not three buttons.** A variant IS (keep workflow, keep
  generation data); `no_gen` was added so all four combinations exist. The stored/wire
  form stays the variant string so old prefs and `?variant=` links keep working;
  `stores/downloadVariant.js` is the only place the mapping is written down. `clean`
  (neither) is also the only one that strips `xyz_gallery.*` — asking for neither means
  asking for a bare raster.
- Three tests hardcoded `user_version == 6` and would fail on every future migration;
  they follow `db.SCHEMA_VERSION` now.

## Gallery detail page — layout (2026-08-10)

User decisions, after "the top bar wastes space and Previous/Next in the top-RIGHT is
backwards when the picture is on the left":

- **Operations moved into the top bar's right-hand group** (`.dv-ops`): Download /
  Workflow / Krita / Delete. They used to be an `Operations` block at the *bottom of the
  right pane*, so reaching Delete meant scrolling past the whole prompt. The pane's last
  section now ends cleanly because `.dv-sec-block:last-child` already killed the trailing
  border. Below 900 px the button labels drop and the icons stay — otherwise four buttons
  squeeze the filename to nothing.
- **Previous/Next moved onto the canvas** as left/right overlays (`.dv-cnav`), faint until
  the pointer enters the canvas. The eye never leaves the picture. `@pointerdown.stop` is
  required or the click starts the canvas pan drag underneath. `@media (hover: none)`
  keeps them visible where there is no hover event at all.
- The zoom row and the video control row are **centred** under the media.
- `IconButton` grew four Heroicons-24 glyphs (download / brush / braces / trash) and a
  `download` prop — the workflow link needs the HTML `download` attribute or the browser
  navigates to the JSON instead of saving it.
- **The trap that cost the most: a backtick inside a Vue template.** These templates are
  JS template literals, so ``` `` ``` in an HTML *comment* silently ends the string —
  and the result is still valid JS, so `node --input-type=module --check` **passes**. The
  page just dies at runtime with `"<template text>" is not a function`. Never put a
  backtick anywhere inside a `template:` literal, comments included.

## Gallery video (schema v8, 2026-08-10)

Videos are indexed, filtered, played and detailed by the **same** gallery as stills.
`gallery/video.py` is the only module that knows PyAV exists.

- **PyAV, never an `ffmpeg` binary.** ComfyUI already requires `av>=16.0.0`, so it is in
  the interpreter that runs this code; `ffmpeg` is very often *not* on PATH (it is not on
  the author's machine). The import is lazy and guarded — no `av` must mean "no videos
  indexed", never an import-time crash during ComfyUI startup.
- **An MP4 carries the SAME `workflow` / `prompt` JSON a PNG carries** (verified against
  a real MiniMax H3 output: container tags `workflow` 347 KB + `prompt` 12 KB). So
  `read_comfy_metadata` only swaps its *reader* (`_open_video_tags` for `_open_png_text`)
  and every derivation below it is shared verbatim. A writer that stashes the graph in
  `comment` is aliased — onto `workflow` when it looks like JSON, onto `parameters`
  otherwise, because aliasing unconditionally sets `has_workflow` on a clip whose comment
  is prose.
- **The audio-twin rule.** ComfyUI video workflows emit a silent `X.mp4` **and** a muxed
  `X-audio.mp4` for one generation — index both and every clip appears twice, and
  favourite/delete has to be done twice. `superseded_by_audio_twin` keeps the one with
  sound. Real-data check: 198 mp4 on disk → 99 indexed, all `-audio`. The suffix list is
  `video_audio_twin_suffixes` in `gallery_config.json`, not a constant — it is a
  convention of VideoHelperSuite / the H3 nodes, not of the format.
  **Write ORDER is why skipping is not enough**: the silent file lands first and the
  watcher indexes it before its twin exists, so `index_one` also *deletes* what
  `supersedes_paths` names, and `_reconcile_missing_disk_rows` drops a superseded row
  whose file is still on disk (that is also what self-heals a library indexed before the
  rule, and what reacts to the config being edited).
- **`media_kind` is a real column with an index**, not something derived from `ext` at
  query time: the grid's image/video filter is a `WHERE` on every page of a 2000+ row
  library and `ext` has no index. Unlike v7's `steps` it needs **no backfill** — every
  pre-v8 row was indexed under an image-only whitelist, so the `'image'` default is the
  answer, not a guess.
- **Two checkboxes, three states.** "Both ticked" and "neither ticked" must mean the same
  thing (an empty grid reads as a bug), so the UI stores two booleans and the wire carries
  one `media_kind` of `all|image|video`. `mediaKindOf()` in `stores/filters.js` is the one
  place that fold is written down. Mirrored to **both** URL and localStorage.
- **`watcher.py` keeps its OWN extension whitelist** — it had to learn video too or a
  fresh render would not appear until the next delta scan. It also **waits for the file
  size to settle** (bounded, 4 s) before indexing a video: an MP4 is muxed progressively
  and the 250 ms debounce can expire mid-write, and a row indexed then would keep its
  fingerprint and stay wrong forever.
- **Poster frames are not frame 0** — generated clips routinely open on black or a fade-in,
  which makes a whole grid page look empty. 10% in, capped at 1 s.
- **Rotation swaps the probed dimensions** (`rotate` tag *or* a `DISPLAYMATRIX` side-data
  entry, depending on muxer/ffmpeg version). ComfyUI output has neither; an imported
  phone clip does, and would letterbox wrongly.
- **Videos are excluded from Send to Krita** (no video layer exists) — hidden on the detail
  page, and `send_images_to_krita` skips them so a mixed batch still sends its stills.
  **Download is as-is only**: the two download checkboxes are PNG `tEXt` surgery and the
  MP4 equivalent would be a remux; `/raw/{id}/download` rejects a non-`full` variant for a
  non-PNG, and `executeImageDownload(id, {isVideo})` stops asking.
  **`api.downloadImage` always sends a variant** — an empty `opts` still falls back to the
  *stored* default — so "as-is" has to be spelled `variant: 'full'`, not omitted.
  `downloadHelper.downloadOne` retries a 400 as `full`: a bulk selection cannot know each
  file's type up front, and this is **not** video-only — a JPEG or WebP in the library has
  always hit the same refusal.
  Labels follow the media: "Download **video**", "Delete video", and the grid's
  "Send to Krita…" is absent on a clip (`ctxIsVideo`, resolved from the loaded row —
  the context menu itself only carries an id).
- **←/→ stay "previous / next item"** (user decision) — there is no seek keybinding, so the
  meaning does not change between a still and a clip. Navigation `pause()`es the outgoing
  clip, or holding ← through a folder stacks one soundtrack per item.
- Video prefs (hover preview / autoplay / default loop / default mute / volume) are
  **localStorage only**, not server prefs: they describe how *this machine* should play,
  and would be the wrong default on another one. **Autoplay defaults ON only because mute
  does too** — a browser refuses to autoplay audible media, and the refused `play()` is
  caught and ignored, leaving the clip on its first frame (i.e. the autoplay-off
  experience). Order matters: `el.muted` must be assigned **before** `play()`, or the
  refusal is judged against the element's audible state.
- Tests: `test/t65_gallery_video_test.py` (PyAV-dependent cases skip in the dev
  interpreter, same split as `build_masks` vs torch).

## Workflow metadata derivation (`metadata._derive_from_workflow`, fixed 2026-08-10)

Investigating why H3 videos showed no generation data turned up a bug that had been
silently costing a third of the *image* library the same fields. Measured on the author's
own 5,934 workflow-carrying images (random sample, old vs new on the same graphs):

| field | before | after |
|---|---|---|
| model | **11.2%** | **95.5%** |
| positive_prompt | **0%** | **56.3%** |
| seed / steps / scheduler | 77.1% | 87.7% |
| sampler | 77.1% | 86.9% |
| cfg | 77.1% | 81.3% |

- **The root cause was `_find_node` returning the FIRST class-name match.**
  `_CHECKPOINT_NODE_HINTS` contains the very broad `Loader` and `Model`, so `VAELoader`
  (only `vae_name`) and `ApplyFBCacheOnModel` beat the real `UNETLoader` and the model
  came out empty. Likewise `SamplerCustomAdvanced` matched `Sampler`, and since all five
  of its inputs are links the search stopped at a node that could never answer.
  The fix is **`_iter_nodes`**: hints are walked in priority order (specific → broad) and
  a candidate carrying none of the wanted fields is **skipped, not fatal**.
- **The advanced-sampler family keeps its scalars in sibling nodes**
  (`RandomNoise.noise_seed`, `BasicScheduler.steps/scheduler`,
  `KSamplerSelect.sampler_name`, `CFGGuider.cfg`) — `_ADVANCED_SAMPLER_SOURCES`. Not a
  pack-specific hack: that is the standard modern graph (Flux, Anima, H3).
- **`_trace_prompt_text` follows conditioning through pipes and guiders.** Impact Pack
  routes it `ToBasicPipe` → `FromBasicPipe` → the sampler's `basic_pipe`;
  `SamplerCustomAdvanced` routes it through a `guider`. The **role
  (positive/negative) is carried through every hop and tried before any generic input** —
  that is the one thing standing between this and confidently wrong metadata (reporting
  the positive prompt as the negative). Depth-capped and cycle-guarded.
- **Text is often a LINK, not a literal.** The walk had to follow `template`, and
  `ImpactWildcardProcessor` keeps the prompt in `populated_text` / `wildcard_text` —
  **`populated_text` first**, it is the resolved text that actually generated the picture.
- **Verified non-regressive on 794 real graphs**: every prompt the old code produced, the
  new code reproduces byte for byte (78/78 negatives; the old code produced zero
  positives). Tests: `test/t66_metadata_derive_test.py`.
- **The re-read button had to widen with it.** `_NEEDS_METADATA_REREAD_SQL` replaced
  `steps IS NULL`: rows fixed by this change often *have* steps, so the old predicate
  would never revisit them and they would stay wrong forever. Settings → "Re-read missing
  metadata" is still manual (a migration must not spend minutes of disk at startup).
- **Still missing for H3 specifically:** `cfg` (turbo-distilled graphs genuinely have
  none) and `steps` (`MiniMaxH3MultiRateSamplerEXPT8.video_steps` / `audio_steps` — two
  counts under names nothing else uses). Model, seed and the full prompt do come through.

## Cache Slots (`cache_nodes/`)

§13, and **not** Krita: a slot is `output/xyz_cache/<slot>/image.png`, one image per slot,
written by one run and read by a later one. `slot_path()` validates the name against
`[A-Za-z0-9._-]{1,64}` *and* re-checks the resolved path is inside the cache dir — it is
user input that becomes a filesystem path. `IS_CHANGED` keys on the file's mtime, so editing
a slot outside ComfyUI is picked up. The Read node's combo IS built in `INPUT_TYPES` (unlike
Krita's layer combo — listing local directories is instant and cannot hang startup), but it
still needs `VALIDATE_INPUTS`, because a slot written during the current session is not in
the list that was built at startup.

**Read outputs `image, mask, width, height`** and reuses ComfyUI's own **"Open in MaskEditor |
Image Canvas"** — nothing here re-implements the editor. The trick (`js/xyz_cache.js`): a node is
an *image node* (so the core menu appears and the editor loads its picture) when
`node.previewMediaType === 'image'` and `node.images[0]` points at a `/view`-servable ref — we set
`node.images = [{filename:'image.png', subfolder:'xyz_cache/<slot>', type:'output'}]` (or the painted
clipspace ref while an edit is live, so re-opening the editor continues the painting) and **never
touch `node.imgs`** (our opaque DOM preview is the only visible one) — core adds a
`$$canvas-image-preview` widget from `node.imgs` after a clipspace paste and never removes it again,
so `onDrawBackground` is wrapped to strip it, or a second picture peeks out from under our preview.
The editor writes its result into a hidden widget named **`image`**
(`clipspace/clipspace-painted-masked-<t>.png [input]` — painted RGB, mask in the alpha); the backend
reads it exactly like Load Image, and **painted beats parked**: with that ref set, `image`, `mask`
AND `width`/`height` all come out of that one file (`open_painted` → `to_image_tensor` / `read_mask`)
so they cannot disagree; with no ref it is the live slot. (This supersedes the old "option A: IMAGE
is always the live slot" — it made painting on the Image Canvas invisible.)
**`alpha: drop | keep`** on Read (default `drop`, = Load Image: three channels, alpha on the
`mask` output). `keep` gives four. It exists because **`convert("RGB")` DISCARDS alpha rather
than compositing it** — a transparent pixel keeps whatever RGB was under it, so a transparent
layer (an `XYZ Inpaint Stitch To RGBA` result on its way to Krita) came out of a slot black AND
opaque. Write always preserved alpha; only Read lost it. With a Mask Editor edit live, `keep`
emits an **opaque** image and says so: that file's alpha is the editor's MASK, not transparency,
and emitting it would make everything you painted invisible. The alpha decision is
`load_slot_image()` — torch-free on purpose, so `test/t61_krita_phase2_test.py` can pin it.

Edits are remembered **per slot** in `node.properties.xyz_slot_edits`
(`{image, mtime}`), bound by mtime: switch slots to park/restore, overwrite the slot (mtime moves) to
drop it. `node.configure` is wrapped so the workflow-load restore is not mistaken for a fresh paint
(which would null the saved mtime). See [[project_cache_read_maskeditor]].

## Agent (`agent_nodes/` + `js/xyz_agent_launcher.js` + `js/xyz_agent_output.js`)

An agent that reads and edits the LIVE graph, chats in a ComfyUI sidebar, and writes
prompts for whatever model the canvas actually runs. The chat UI and its brain are
**artokun's comfyui-mcp** (panel + orchestrator, MIT); this pack supplies the parts
that pack cannot: a launch button, one credential store, standing behaviour rules, and
an Apply path from the chat into a node.

### Where the code actually is
Most of the work lives in **two forks**, not here — `E:\AI\forks\comfyui-mcp`
(orchestrator, Node) and `E:\AI\forks\comfyui-mcp-panel` (frontend), both pushed to
`github.com/Lindemellis/comfyui-mcp{,-panel}` with `origin` still on artokun for
upstream sync. `agent_data/settings.json`'s `entry` points at the orchestrator fork's
`dist/index.js`: **reinstalling upstream silently replaces it and every skill with it.**

- **`launcher.py`** — finds node + entry, spawns detached, waits for the BRIDGE to
  answer (a live process is not a ready service). Also the single place that turns
  configuration into the orchestrator's environment.
- **`routes.py`** — `/xyz/agent/{status,start,entry,log,unlock,providers,models,provider}`.
- **`js/xyz_agent_launcher.js`** — the panel: status, 启动, 日志, the content-note
  switch + picker, and the **custom-lane endpoint switcher** (provider → live
  `/models` → switch, which rewrites settings and restarts).
- **`js/xyz_agent_output.js`** — a target picker + **Apply** under every code block the
  agent prints. Reads the panel's rendered DOM and appends to it; deliberately not a
  patch to the panel's 29k-line bundle, so a panel update degrades to "the bar stops
  appearing".

### Credentials: ONE store
Every provider key lives in **`~/.pi/agent/auth.json`** (pi's own file, `{"type":
"api_key","key":…}`). `launcher.keys_from_pi_auth()` translates each into the env var
the orchestrator's own backends read — `zai`→`GLM_API_KEY`, `moonshotai-cn`→
`MOONSHOT_API_KEY`, `dashscope`→`DASHSCOPE_API_KEY`, … Adding a provider means adding
a row there, never a second key file. `agent_data/settings.json` holds no keys at all.

### Standing notes (`agent_data/`, gitignored)
- **`house_rules.md`** — always on, seeded from `agent_nodes/house_rules.default.md`
  on first run. The canvas is READ-ONLY unless asked; read the model's skill before
  writing its prompt; how to identify the base model (bypassed nodes do not run); how
  to read a picture without adding a preview node; `/skill-name` invocation.
- **`unlock/*.md`** — content notes, one per file, chosen in a dropdown. The
  orchestrator reads ONE fixed path (`unlock_active.md`) whose contents the launcher
  rewrites, so both the switch and the picker take effect on the next turn with no
  restart. Switched separately from the house rules on purpose.

### The traps (each cost real time)
- **A system-prompt rule does not make the model read a skill.** Measured on
  gemini-2.5-pro: it read the graph, named the checkpoint, wrote the prompt from
  memory, and printed the line meant to certify it had read the skill. What works is
  `skill-hint.ts` in the fork — the pointer rides the `get_workflow` RESULT, where
  attention actually is. With it: `get_workflow → skill_read → danbooru_tags`.
- **Family detection must not search the whole workflow JSON.** Prompt text, notes and
  a PLv3 library block all mention family names. Search weight filenames + class types
  only, split camelCase first (`waiIllustriousSDXL` → `wai illustrious sdxl`), and
  require a boundary on the RIGHT only (the false friends are suffixes:
  anima/animation, pony/ponytail).
- **A LoRA can override its checkpoint's prompt format.** `krea2-charactersheet` is a
  rigid bracketed template while `krea2-txt2img` says to write prose; the hint names
  the LoRA first and says it wins on shape.
- **An endpoint's `/models` is not the whole contract.** Z.AI serves `glm-4.6v` /
  `glm-4.5v` and lists neither — `COMFYUI_MCP_CUSTOM_EXTRA_MODELS` adds them to the
  picker. Qwen's VL models likewise need checking one by one: `qwen-vl-max` sees but
  **cannot call tools**, `qwen3.7-max` refuses images; `qwen3.7-plus` and
  `qwen3-vl-plus` do both.
- **Verify through the FRONTEND.** Backend probes passed while the real path was
  broken, twice. There is no browser tool here — launch Chrome with
  `--remote-debugging-port=9222 --user-data-dir=<scratch>` and drive it over CDP.
  Synthetic DOM events do NOT reach this panel's handlers; use
  `Input.dispatchMouseEvent` / `insertText` / `dispatchKeyEvent`.
- **Never drive the user's own ComfyUI tab.** Create a scratch workflow and work
  there; their open workflow is autosaved and a stray node persists.

## Retired PLv2 and original LLM assistant

The PLv2 runtime and the in-repo LLM prompt assistant were deleted on 2026-08-16.
`prompt_library_v2_data/` remains untouched and `prompt_library_v3/migrate_v2.py` remains the
supported one-shot migration path. Do not restore old nodes, routes or frontend entry points.

## Gallery (`gallery/` package)

A full-featured image gallery for ComfyUI supporting 2000+ images. Architecture:

### Data Layer
- **`db.py`** — SQLite schema with forward-only migrations (v1–v8). WAL mode, 256 MiB mmap, 5 s busy timeout.
- **`video.py`** — the only PyAV consumer: probe (size/duration/fps/audio/codec), container
  tags, poster-frame decode, and the audio-twin rule. See the Gallery video section.
- **`repo.py`** — `WriteQueue` (single-writer pattern, priority queue), all read APIs open short-lived `connect_read` connections.

### Service Layer
- **`service.py`** — use-case orchestration: PATCH, resync, bulk ops, delete, metadata sync flows.
- **`folders.py`** — folder root management (output/input defaults + custom paths).
- **`indexer.py`** — image indexing and prompt vocabulary rebuild.
- **`metadata_sync.py`** — background metadata sync worker.
- **`watcher.py`** — filesystem watcher + heartbeat.

### API / Routing
- **`routes.py`** — HTTP routes: folder tree, images (cursor-paged), image detail, neighbors, thumbnails, raw image download, workflow JSON, bulk ops.
- **`ws_hub.py`** — WebSocket hub for real-time updates (index progress, bulk progress, folder changes).
- **`job_registry.py`** — job tracking for bulk operations.

### Supporting
- **`thumbs.py`** — on-demand thumbnail generation with LRU cache (.webp).
- **`vocab.py`** — tag / prompt-token / word-token vocabulary tables for autocomplete.
- **`paths.py`** — sandbox path validation (`assert_inside_root`).
- **`folder_header.py`** — folder line sort header computation.
- **`metadata.py`** — PNG metadata extraction (ComfyUI prompt/workflow chunks).
- **`audit.py`** — audit logging for gallery operations.

## Tag DB (`tagdb/` package)

Danbooru tag **autocomplete** with a versioned, time-aware local database. New
users download a prebuilt dataset from the author's GitHub Release; updates are
opt-in. **No auto-scrape on startup.** Data in `tagdb_data/` (gitignored):
`danbooru.sqlite` (mutable danbooru **working DB** that search reads; renamed from the
old `tagdb.sqlite` by a startup auto-migration), `gelbooru.sqlite` (optional second
source), `settings.json`, `snapshots/official/` (downloaded) + `snapshots/local/`.

**Gelbooru = optional second source** (`tagdb_data/gelbooru.sqlite`, same schema,
`source='gelbooru'`, current-only — no time machine). When installed AND enabled,
`/xyz/tagdb/search?source=...` merges both via `repo.search_tags_multi` (dedupe-by-name,
**danbooru authoritative on conflict**, D/G badges only when ≥2 sources). Gelbooru tags come
from the dapi (needs `gelbooru_api_key`+`gelbooru_user_id`; 401 without), aliases from HTML
(no alias API). `build_dataset --gelbooru`, `audit_sources.py`, manifest `datasets_gelbooru[]`,
routes `/xyz/tagdb/gelbooru/{check,download,build,delete}`. See HANDOFF "Gelbooru" + the plan.

- **`db.py`** — schema V2 (`migrate` forward-only, guarded `ADD COLUMN`). Tables:
  `tags` (+ `danbooru_id, created_at, post_count_synced_at, structure_synced_at`),
  `aliases` (+ `created_at, synced_at`), `tag_versions`, `artist_versions`,
  `related_tags`, `tags_fts` (FTS5 **contentless** trigram — use the `delete-all`
  directive, never plain DELETE), `meta` (watermark keys).
- **`scraper.py`** — `curl_cffi` (impersonate=chrome) to pass Cloudflare; **id-cursor
  pagination** `page=a{id}` (bypasses the 1000-page/410 cap); `search[post_count]=>=N`.
  Full scrapers + `*_since(after_epoch)` incrementals + `fetch_related` (one req/tag).
- **`updater.py`** — `run_full_update` (refresh all post_count → now) and
  `run_incremental_update` (apply only events since `structure_synced_through`; does
  NOT touch unchanged post_count/related). See provenance clocks below.
- **`distribution.py`** — download/verify(sha256)/unzip the official dataset from a
  Release per `official_manifest.json`; `seed_working_db_from_official`.
- **`build_dataset.py`** — author standalone CLI (no ComfyUI): full build → prints
  sha256 + a manifest entry. `python -m tagdb.build_dataset --full --zip`.
- **`repo.py`** — `search_tags` (FTS/LIKE), `list_snapshots` (working/official/local/
  legacy + kind), `get_meta_watermarks`, `get_cached_related`/`store_related`.
- **`routes.py`** — `/xyz/tagdb/{search, related, artist_posts, snapshots(/active|/export),
  settings, official/check, official/download, maintain(+mode)(/status|/cancel),
  reconstruct}`. Single `_maintain_lock` (no WriteQueue). `_active_db()` = working DB
  by default (or a reconstructed/imported read-only snapshot).
- **Extra danbooru features**: jump-to-wiki + artist-works popup (`fetch_artist_posts` →
  posts.json thumbnails) in the dropdown; **translations** (`scrape_wiki_other_names` →
  `translations` table, folded into FTS so JP/CN names are searchable; opt-in via
  `--with-translations`); **date reconstruction** (`updater.reconstruct_as_of` rebuilds
  existence/category/name as of a date from `tag_versions`+aliases — needs `--with-versions`).
- **`__init__.py`** — `setup()`: first run downloads official (no scrape fallback);
  `_migrate_legacy_layout` seeds the working DB from old flat snapshots.

**Provenance / time-binding (three independent clocks):** `meta.structure_synced_through`
(event-time watermark; full→now, incremental→max consumed event ≤ now),
`meta.full_count_synced_at` + per-row `tags.post_count_synced_at` (count freshness;
full→now-all, incremental→now-new-only), `related_tags.synced_at` (per-pair, on demand).

## Frontend (`js/`)

- `plv3.js` + `plv3/` — PLv3 windows (see the PLv3 section). `window.plv3 = { window, library }` is the handle the top bar opens.
- `gallery_topbar.js` — the gallery button + the **XYZ Tools dropdown** (PLv3, TagDB, Krita, agent, settings)
- `xyz_mask_editor.js` / `xyz_attach_masks.js` / `xyz_krita.js` / `xyz_cache.js` — the mask, Krita and cache nodes
- `node.py` — shared `ByPassTypeTuple` helper used by dynamic mixed-type outputs
- `tagac.js` — global English Danbooru/Gelbooru tag autocomplete for prompt textareas and PLv3 adapters.
- `tagdb_panel.js` — Tag DB Manager window (credentials, official dataset, incremental/full update + staleness, snapshot switching)

## Key Rules

- **All DB writes go through `WriteQueue`** (`repo.py`). Never write SQL directly from routes or service.
- **Short-lived read connections** — never hold a SQLite connection open across requests.
- Routes are registered on `PromptServer.instance` in `gallery/__init__.py:setup()`.
- Data directory is `gallery_data/` (gitignored), V2 SQLite DB is `prompt_library_v2_data/` (gitignored), **V3 SQLite DB is `prompt_library_v3_data/` (gitignored)**, the Krita launcher's saved `krita.exe` path is `krita_data/` (gitignored). The V2 internal spec `prompt_library_v2_requirements.md` is kept local (gitignored); the published docs are `prompt_library_v2/README.md` and `prompt_library_v3/README.md`.
- Background services: `WriteQueue`, thumbnail touch flusher, metadata sync worker, file watcher, heartbeat.

## Running Tests

Tests are in `test/` named `t*_test.py`. Run a specific test:

```
python -m pytest test/t06_test.py -v
```

Run all tests:

```
python -m pytest test/ -v
```

Some tests need ComfyUI running (`test/t45_test.py` etc.) — these are probe/integration tests in `test/manual/`.

## Key Files

| File | Purpose |
|---|---|
| `__init__.py` | Node registration + the setup() calls for every subsystem |
| `node.py` | Core node implementations (Concatenate, Replace, Clip Encode, Random Picker) |
| `prompt_library_v3/parser.py` | PLv3 text → AST **with source spans**; strict vs recovering modes |
| `prompt_library_v3/ir.py` | Schedule intervals, region splitting, ambient-text injection |
| `prompt_library_v3/compile/` | The two backends (`couple`, `mask`) → prompt-control text |
| `prompt_library_v3/library.py` | expand / blur-sync / presets / links (write-through) |
| `mask_nodes/nodes.py` | `XYZ Mask Editor` (rect → MASK, numpy) + `XYZ Attach Masks` (the one prompt-control coupling) |
| `js/xyz_mask_editor.js` | The rect canvas + dynamic MASK outputs with link-carrying rebuilds |
| `js/xyz_attach_masks.js` | Dynamic mask inputs, gapless attach order, `IMASK(i)` labels |
| `krita_plugin/xyz_comfy/` | The Krita plugin: HTTP server + main-thread bridge + layer/mask export |
| `krita_nodes/installer.py` | Copies the plugin into `pykrita` AND enables it in `%LOCALAPPDATA%\kritarc` |
| `krita_nodes/nodes.py` | `XYZ Krita Fetch Image` / `Fetch Mask`; dynamic combo via `VALIDATE_INPUTS` |
| `js/plv3/editor_core.js` | The ONE Monaco editor (main window + library preset view) |
| `js/plv3/detail.js` | The detail page: span-surgical controls over the same text |
| `agent_nodes/launcher.py` | Starts the comfyui-mcp orchestrator; derives every provider key from `~/.pi/agent/auth.json` |
| `agent_data/house_rules.md` | The agent's standing rules (always on; seeded from `agent_nodes/house_rules.default.md`) |
| `js/xyz_agent_output.js` | Target picker + Apply under every code block the agent prints |
| `gallery/__init__.py` | Gallery bootstrap, background services lifecycle |
| `gallery/db.py` | SQLite schema, connection factories, migrations |
| `gallery/repo.py` | WriteQueue + read APIs (the data access layer) |
| `gallery/routes.py` | All HTTP endpoints |
| `gallery/service.py` | Business logic orchestration |
| `gallery/vocab.py` | Vocabulary tables for autocomplete |
