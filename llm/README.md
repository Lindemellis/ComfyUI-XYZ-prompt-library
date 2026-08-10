# LLM Prompt Assistant

**English** | [中文](README_zh.md)

A floating window that calls a large language model to **generate or optimize txt2img
prompts**. It ships **prompt templates** for different image models — a booru-tag default,
**Anima**, and **Krea 2** — and can ground danbooru-style tags against your **local tag
database** so the model only uses tags that actually exist.

It binds to a **Prompt Library V3** node and is opened from that node's **🤖 LLM** button,
from the top-bar menu (*XYZ Tools → LLM Prompt Assistant*), or from the PLv2 Text Editor's
**🤖 LLM** button (which opens it without binding anything).

## Providers

Pick a provider in *Settings → LLM*. Each keeps its own API key + model, so you can switch
freely without re-entering anything. Keys are stored **server-side** (in
`prompt_library_v2_data/llm_settings.json`) and never touch the browser or `localStorage`.

| Provider | Protocol | Default endpoint |
|---|---|---|
| DeepSeek | OpenAI-compatible | `https://api.deepseek.com` |
| OpenAI (GPT) | OpenAI-compatible | `https://api.openai.com/v1` |
| Claude | Anthropic | `https://api.anthropic.com` |
| Grok (xAI) | OpenAI-compatible | `https://api.x.ai/v1` |
| **Custom** | OpenAI-compatible **or** Anthropic | your endpoint |

The **Custom** option lets you point at any OpenAI-compatible endpoint (Ollama, LM Studio,
vLLM, OpenRouter, …) or an Anthropic-compatible one — set the base URL, model id, and API
format yourself.

### Setup

1. Open *Settings → LLM* (gear icon in the window, top-bar menu, or the command palette).
2. Choose a **Provider**, paste its **API key**, and pick a **Model** from the dropdown
   — **↻** pulls the provider's live model list (e.g. DeepSeek returns both
   `deepseek-v4-pro` and `deepseek-v4-flash`), and *Custom model id…* lets you type any id.
3. Click **Test connection** to verify the key/model — the result shows as a toast.
4. *(Optional)* Set **Temperature** / **top_p** and **Thinking** (shared across providers).

### Thinking / reasoning effort

DeepSeek V4 models (`deepseek-v4-pro` and `deepseek-v4-flash`, both tool-capable) support a
**thinking** control, exposed in *Settings → LLM → Sampling → Thinking*:

| Mode | Effect |
|---|---|
| **Off** | No chain-of-thought — fastest, cheapest. |
| **High** *(default)* | Normal reasoning. |
| **Max** | Full reasoning depth — for hard problems. |

It maps to DeepSeek's `thinking` / `reasoning_effort` parameters and is **only sent to the
DeepSeek provider** (other OpenAI-compatible endpoints ignore it). With thinking on, the
model's reasoning streams into a collapsible **💭 思维链** section (see Chat).

## Tab 1 — Blocks

The system prompt is composed from reorderable **blocks**. Each block has an enable toggle,
a **saved-variant dropdown** (keep several versions of a block and switch between them), a
collapse toggle, a resizable text box, and an **⊞** button that opens the current variant in
a draggable/resizable **floating editor** (two-way live-synced). Drag the **⠿** handle to
reorder; blocks are assembled top-to-bottom.

Default blocks (seeded on first run, fully editable):

| Block | Role |
|---|---|
| History chats | Replays the last *N* turns of the conversation (`all` or a number). |
| Header | Who the model is. |
| Jailbreak | Mature/NSFW permission (a restrained starter — strengthen it yourself). |
| Task description | How a txt2img prompt should be structured; **English-only** output. |
| Format reference | How to fence the final prompt (positive in ```prompt; negative only if asked). |
| Danbooru lookup tool | When/how to use the tag-lookup tool. |
| Web search tool | When/how to use the web-search tool (off by default). |
| Base prompt | *Placeholder* — filled at send time with the bound node's resolved prompt. |
| User request | *Placeholder* — filled at send time with your chat input. |

`Base prompt`, `User request` and `History chats` are special placeholders (no text box).
Add your own custom blocks with **＋ Add block**.

### Templates — switching the whole system prompt

Different image models want completely different prompts, so the **Template** dropdown at the
top of the Blocks tab (and of the Chat tab) switches every block at once:

| Template | For | What it does |
|---|---|---|
| **Danbooru (default)** | SDXL / Illustrious / Pony and friends | Comma-separated lowercase booru tags, tag lookup on. |
| **Anima** | [Anima](https://huggingface.co/circlestone-labs/Anima) | Tags **+** natural language mixed; gelbooru-preferred spellings; `@artist` prefix; higher weights (~1.4+). Tag lookup on. |
| **Krea 2** | [krea-ai/krea-2](https://github.com/krea-ai/krea-2) | Plain descriptive English, **no tags, no weights, no negative prompt**. Tag lookup **off**. |
| **MiniMax H3** | MiniMax H3 (video **+** audio) | A structured multi-field prompt in MiniMax's official format, covering all five input modes. **Both** tools off. |

**MiniMax H3** is the one template that isn't txt2img. H3 generates picture and sound
together, and its prompt is a small structured document rather than a line of tags: named
fields, a shot-by-shot timeline with `[Shot N] At MM:SS.mmm` cut times, camera motion as
`type + amplitude + speed`, speaker IDs `(S1)` with dialogue in `<d>[Language] …</d>`, and
two separate sound fields. The template covers every input mode:

| Mode | You supply | Skeleton |
|---|---|---|
| **T2VA** | text only | `integrated_multimodal_description` + `overall_soundscape` + `non_diegetic_music` |
| **I2VA** | a first frame | the three fields, after a first-frame instruction line |
| **FL2VA** | first **and** last frame | the three fields, after a two-picture alignment line |
| **L2VA** | a last frame | the three fields, after a one-picture alignment line |
| **Ref2VA** | reference images / videos / audio | six sections: `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, `non_diegetic_music` |

The first four go to ComfyUI's `MiniMax H3 Image to Video` (fill `first_frame` /
`last_frame` or leave them empty); Ref2VA goes to `MiniMax H3 Reference to Video`. The
model is told the real timing facts — 24 fps, the node's default `length` of 124 frames is
5.17 s — so the timestamps it writes land inside the clip you actually render.

A template **is** a variant name: switching to `krea2` points every block at its `krea2`
variant and sets which blocks are on. That is the same thing the per-block **variant**
dropdown does — the two are two views of one list, so you can still fine-tune a single block
after switching.

**A disabled block also withholds its tool.** Krea 2 turns the *Danbooru lookup tool* block
off, so the danbooru tool isn't attached to the request at all — the model is never handed a
tool its system prompt never mentioned. MiniMax H3 turns off *both* doc blocks, so it runs
with no tools at all: there is no tag vocabulary to verify against, and its prompts are
written from the request rather than researched. (Your global *Settings → LLM* toggles still apply on
top; a template can only take a tool away, never grant one.)

- **Save as…** snapshots every block's current text **and** its on/off state as your own
  template — the way to add a preset for a model that isn't bundled.
- **🗑** deletes the selected user template (the bundled three can't be deleted).
- **— mixed —** means the blocks are on variants of several different names (you hand-picked
  them). Pick a template to line them all up again.

The active template is **derived from the blocks**, not remembered separately, so it never
claims a template you aren't actually on.

Both bundled presets:

- adapt to your intent — a full prompt, an optimization, **just one element**, or plain
  conversation; they won't force a full prompt when you only asked a question;
- never write a negative prompt unless you ask (Krea 2 never writes one at all — the model
  has no negative prompt; it tells you the positive fix instead);
- keep explanations short, in prose or a dash list, never markdown tables.

Krea 2 additionally weighs **two or three** style / medium / lighting options in its head
before committing to one — otherwise every request drifts to the same "cinematic, highly
detailed" default — and keeps that weighing internal, so you get the finished prompt rather
than a tour of the options it rejected. Its first authoring rule, outranking the rest, is
faithfulness: detail must be drawn out of what you said, never invented alongside it.

The bundled presets auto-update on new releases — only for variants you haven't hand-edited.

## Tab 2 — Chat

- **Template** (top): the same switcher as the Blocks tab, so changing target model is one
  click away without leaving the conversation.
- **Base prompt**: bind a **Prompt Library V3** node so its **compiled** output — what the
  sampler would actually receive, with library groups expanded — becomes the optimization
  target (re-compiled live, read-only), or detach to *Free edit*. A collapse button and a
  drag handle control the section's height.
- **Conversations** (left): create, rename (double-click), delete. Conversations are global
  and not tied to any node.
- **Messages** (right): the conversation log. Type a request (any language) and click
  **Send** (Enter = newline). While generating you can **Stop**; the last reply has a
  **↻ regenerate**. When the model wraps its result in a ```prompt fenced block, **Copy** and
  **Apply** buttons appear — **Apply** writes it straight into the bound node's `text`, and
  the embedded Monaco editor and the floating PLv3 window both pick it up immediately. The
  text is written **verbatim** (no PLv2-style normalization: escaping the parentheses of a
  Krea 2 sentence or of a `(tag:1.2)` weight would corrupt it). The base prompt re-compiles
  live whenever you edit that node anywhere.
- **流式 (streaming)** toggle (next to Send): when on, the reply streams in token-by-token and
  the model's reasoning appears live in a collapsible **💭 思维链** box (which also shows on
  past replies that have reasoning). Turn it off for a single non-streaming response.

## Tag lookup (keeping tags real)

When **tag lookup** is enabled (*Settings → LLM*), the model can call a tool that searches
your local danbooru/gelbooru database. The workflow (driven by the *Danbooru lookup tool*
block): the model brainstorms English candidate tags for a concept **it is introducing**,
looks them up, and only uses tags that exist — preferring higher post counts. You can write
your request in Chinese or Japanese; the model translates concepts to English itself (the
database only verifies existence + post count). It does **not** waste lookups re-verifying
tags you already provided. Toggle the **danbooru** / **gelbooru** sources independently; a
source whose database isn't installed shows as unavailable.

When lookup is **off** — globally, or because the active template disabled the *Danbooru
lookup tool* block (Krea 2 does) — the model relies only on its own knowledge. That is
correct for Krea 2: it takes any words at all, so there is nothing to verify.

## Web search (optional, off by default)

Enable **Web search** in *Settings → LLM* to give the model a keyless web-search tool
(DuckDuckGo) for facts the tag database can't answer — an unfamiliar concept's proper name,
a character's appearance, or artists who draw in a requested style. It's a fallback after a
tag lookup, and the prompt tells the model to prefer `danbooru …` queries and to confirm any
name with a tag lookup before using it. Results can be flaky (it's a scrape) and add latency,
so it stays off unless you turn it on.

## Notes

- The tool loop runs server-side (tag lookup + web search), capped so it always produces a
  final answer. **Stop** cancels the in-flight request. Streaming relays tokens + reasoning
  live; non-streaming returns once at the end.
- Some DeepSeek models emit tool calls as in-text markup instead of structured calls; this is
  parsed and executed transparently, and never leaks into the displayed answer.
- Errors surface inline (a red bubble); a missing API key sends you to *Settings → LLM*.
- The optimized prompt is a flat string. **Apply** overwrites the bound node's whole document
  with it — a PLv3 document that used library groups, regions or schedules is flattened by the
  round trip. That is by design (plain comma-separated text is valid PLv3); copy instead of
  applying if you want to keep the structure.
- The *Web search tool* block works in every template except MiniMax H3, which switches it
  off; Krea 2's version tells the model to search for what something **looks like** and then
  describe it, since there is no tag to verify.
- **With the H3 template, use Copy — not Apply.** Apply writes into a *PLv3* node, and PLv3
  then compiles that text: it escapes every colon (`integrated_multimodal_description\:`,
  `00\:03.500`), collapses the blank lines that separate the fields into one long line, and
  warns `W14` on each `[Shot N]`. The result still compiles, but it is no longer a valid H3
  prompt. Copy the block and paste it into the H3 node's own `prompt` widget instead.
