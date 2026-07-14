# PLv3 demo — a workflow that exercises everything

Three files:

| File | What it is |
|---|---|
| `plv3_demo_workflow.json` | a runnable ComfyUI workflow (drag it onto the canvas) |
| `plv3_demo_positive.txt` | the positive node's text — every piece of PLv3 syntax |
| `plv3_demo_negative.txt` | the negative node's text |

The library groups the demo text refers to live in the **library database**, so seed
them first:

```bash
python test/seed_plv3_demo.py --reset
```

Everything it creates lives under one top-level folder, `demo`, and never mixes
with your own library.  `--reset` deletes and rebuilds just that folder.

---

## 1. The library (spec §5) — `test/seed_plv3_demo.py`

```
demo/
  quality/
    scores                      score_9, score_8_up, score_7_up
    anima                       masterpiece, best quality, … + a REF to scores
  characters/
    illya                       illyasviel von einzbern (weight 1.15), blonde hair, …
      accessories               ← a TRUE SUBGROUP: owned by illya, deleted with her
      outfit                    ← another one, with .set{random_select: 1}
    miyu                        miyu edelfelt (weight 1.15), black hair, …
  styles/
    wlop                        artist:wlop (weight 1.2), <lora:add_detail:0.6>
  scenes/
    duo                         2girls, yuri + REFS to illya and miyu
  bad                           (negative) worst quality, watermark, …
```

This is the part worth poking at, because it is where v3 differs most from v2:

* **A true subgroup is ownership; a reference is sharing.**  `illya.accessories` is
  owned by illya (delete illya and it goes too).  `duo` merely *references* illya
  and miyu — they are independent groups that other groups can reference as well.
* **References nest.**  Expanding `demo.scenes.duo` inlines illya, which inlines
  her accessories — three levels, each keeping its own `[path]:` header so the
  compiler and the detail page still know whose text it is.
* **The library is never read at execution time** (spec §4.7).  A block in the
  document is *fully expanded*: content and settings are all there in the text.
  Delete the whole library and the workflow still renders exactly the same image.
* **Presets** (spec §5.4) are on `demo.characters.illya` (`minimal` / `full`) and on
  `demo.scenes.duo` (`solo-illya`, which embeds a snapshot of illya's own state).

### Things to try in the Library window (📚 in the PLv3 window)

1. Right-click the tree: create / rename / **move** a folder or group.  Try moving
   `illya` *under* `miyu` — it becomes a true subgroup and its path changes.  Try
   moving a group into its own subtree: the server refuses it.
2. Select `demo.scenes.duo` → **insert into editor**.  The whole nested block lands
   in the document, expanded.
3. Add a reference from `duo` back to `duo` (or to `scenes` via a loop): refused
   with `E02` — the library can never contain a cycle (spec §5.5).
4. Select a preset in the middle column: the editor below it re-renders that
   preset's view of the group, and editing it re-snapshots the preset on blur.

### Things to try in the document

5. Delete `absurdres` from the `[demo.quality.anima]` block in the editor.  The
   detail page immediately lists it as a **disabled** chip — because "disabled"
   is not a stored flag, it is `the group's items` minus `what is in the text`
   (spec §5.2).  Click the chip to put it back.
6. Type a new tag into that block and click away.  On blur it is **appended to the
   library group** (spec §5.3).  Nothing is ever deleted by editing the text.
7. Rewrite an item's text: you get a new item, and the old one simply becomes
   disabled.  That is the whole "edit = add + disable" rule, with no dialog.

---

## 2. The document (spec §3, §4) — `plv3_demo_positive.txt`

| Line | Exercises |
|---|---|
| `masterpiece, best quality,` | plain items |
| `(artist:wlop:1.1)` | weight — note the colon inside the tag needs **no escape** |
| `<lora:add_detail:0.6>` | a LoRA item |
| `smile \(cat\)` | escaped parens |
| `[demo.quality.anima]: { … }` | a library block, with a **nested** library block |
| `.set{random_select: 2-3, shuffle: true, seed: 7}` | randomisation, with the group's own seed |
| `.set{format: "($p:1.05)", dropout: 0.2}` | `$p` formatting + dropout |
| `[@schedule]: { [0, 0.3]: … }` | scheduling sugar |
| `[@region]: { base / imask / fill }` | regions, feather, `include_in_base` |
| `.set{schedule: {0.15, 1}}` on one region | a region that only exists in a time window |

The **ambient-text rule** (spec §4.2) is what to watch: everything outside a region
group — the quality tags, the artist, the LoRA, the scheduled eyes — is copied into
*every* region segment.  That is the whole point of the design: you write the shared
prompt once.

Flip the node's `region_mode` between `couple` and `mask` and watch the compiled
output in the detail page: the same segments come out as `COUPLE …` or as
`AND MASK(…)`, and in `mask` mode the compiler synthesises `fill` by subtracting the
other masks (W12).

---

## 3. The workflow — `plv3_demo_workflow.json`

```
SolidMask ×2 ─→ MaskComposite ×2 ─→ PC: Attach Mask (multi) ─→ CLIP
                  (left half)          (mask1 → imask 0)
                  (right half)         (mask2 → imask 1)

XYZ Prompt Library V3 Positive ─→ PC: Schedule prompt ─→ KSampler ─→ … ─→ SaveImage
XYZ Prompt Library V3 Negative ─→ PC: Schedule prompt ─┘
                               └─→ PC: Show Prompt   (see the compiled string)
```

**`imask: i` is the ATTACH order, not a slot number.**  `mask1` on *PC: Attach Mask*
is `imask: 0`, `mask2` is `imask: 1`.  Nothing validates this for you — it is the one
thing in the whole system that only your wiring knows.

The checkpoint is set to `waiIllustriousSDXL_v140`; change it to whatever you have.
The demo's two masks are the left and right halves of the canvas, so illya should
come out on the left and miyu on the right.

> The PLv3 node's output must go to **PC: Schedule prompt** (or *Schedule LoRAs*).
> `PC: Text Encode` does **not** understand schedule syntax (spec §2.3).
