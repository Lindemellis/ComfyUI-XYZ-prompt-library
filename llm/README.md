# LLM Prompt Assistant

**English** | [中文](README_zh.md)

A floating window that calls a large language model to **generate or optimize txt2img
prompts**, and can ground danbooru-style tags against your **local tag database** so the
model only uses tags that actually exist.

It lives next to the Text Editor / Library / Preview windows and is opened from the node's
**🤖 LLM** button, the top-bar menu (*Prompt Library V2 — LLM Prompt*), or the Text Editor's
**🤖 LLM** button.

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

### Anima preset

Each text block ships a second **`anima`** variant, tuned for the [Anima](https://huggingface.co/circlestone-labs/Anima)
model (Qwen3-0.6B text encoder; danbooru/gelbooru tags + natural language + combinations;
gelbooru-preferred spellings; `@artist` prefix; higher prompt weights ~1.4+). Switch any
block's **variant** dropdown to `anima` to use it. The anima preset:

- never writes a negative prompt unless you ask;
- only looks up tags **it introduces** and is unsure of — it never re-verifies tags **you**
  already wrote (your quality/artist/character tags are taken as-is);
- adapts its answer to your intent: a full prompt, an optimization, **just one element's
  tags**, or plain conversation — it won't force a full prompt when you only asked a question.

The preset auto-updates on new releases (only for variants you haven't hand-edited).

## Tab 2 — Chat

- **Base prompt** (top): bind a Prompt Library V2 node so its **resolved** prompt becomes the
  optimization target (re-resolved live, read-only), or detach to *Free edit*. A
  collapse button and a drag handle control the section's height.
- **Conversations** (left): create, rename (double-click), delete. Conversations are global
  and not tied to any node.
- **Messages** (right): the conversation log. Type a request (any language) and click
  **Send** (Enter = newline). While generating you can **Stop**; the last reply has a
  **↻ regenerate**. When the model wraps its result in a ```prompt fenced block, **Copy** and
  **Apply** buttons appear — **Apply** writes it straight into the bound node's prompt
  template, first running your normalization settings over it (underscore→space, bracket
  escaping, full-width→half-width, comma spacing). The bound base prompt re-resolves live when
  you edit the node, the Text Editor, or any library entry it references.
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

When lookup is **off**, the model relies only on its own knowledge (no tool calls).

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
- The optimized prompt is a flat tag string. **Apply** overwrites the bound node's template
  with it (the curated `[ref]` structure of that node is replaced — by design).
