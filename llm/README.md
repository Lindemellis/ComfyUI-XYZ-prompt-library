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
2. Choose a **Provider**, paste its **API key**, and adjust the **Model** if needed (the
   field is editable with suggestions).
3. Click **Test connection** to verify the key/model with a tiny live request.
4. *(Optional)* Set **Temperature** / **top_p** (shared across providers).

## Tab 1 — Blocks

The system prompt is composed from reorderable **blocks**. Each block has an enable toggle,
a **saved-variant dropdown** (keep several versions of a block and switch between them), a
collapse toggle, and a resizable text box. Drag the **⠿** handle to reorder; blocks are
assembled top-to-bottom.

Default blocks (seeded on first run, fully editable):

| Block | Role |
|---|---|
| History chats | Replays the last *N* turns of the conversation (`all` or a number). |
| Header | Who the model is. |
| Jailbreak | Mature/NSFW permission (a restrained starter — strengthen it yourself). |
| Task description | How a txt2img prompt should be structured; **English-only** output. |
| Format reference | An example prompt showing the expected output style. |
| Danbooru lookup tool | Tells the model how to use the tag-lookup tool. |
| Base prompt | *Placeholder* — filled at send time with the bound node's resolved prompt. |
| User request | *Placeholder* — filled at send time with your chat input. |

`Base prompt`, `User request` and `History chats` are special placeholders (no text box).
Add your own custom blocks with **＋ Add block**.

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
  template.

## Tag lookup (keeping tags real)

When **tag lookup** is enabled (*Settings → LLM*), the model can call a tool that searches
your local danbooru/gelbooru database. The workflow (driven by the *Danbooru lookup tool*
block): the model brainstorms English candidate tags for a concept, looks them up, and only
uses tags that exist — preferring higher post counts. You can write your request in Chinese
or Japanese; the model translates concepts to English itself (the database only verifies
existence + post count). Toggle the **danbooru** / **gelbooru** sources independently; a
source whose database isn't installed shows as unavailable.

When lookup is **off**, the model relies only on its own knowledge (no tool calls).

## Notes

- Non-streaming: a request runs the full tool loop server-side, then returns. A clear
  loading state shows while it works; **Stop** cancels the in-flight request (nothing partial
  is kept).
- Errors surface inline (a red bubble); a missing API key sends you to *Settings → LLM*.
- The optimized prompt is a flat tag string. **Apply** overwrites the bound node's template
  with it (the curated `[ref]` structure of that node is replaced — by design).
