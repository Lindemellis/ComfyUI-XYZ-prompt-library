# Agent

An agent that sits in a ComfyUI sidebar, reads the graph you actually have open, and
writes prompts for the model that graph actually runs.

The chat panel and its brain are [artokun's comfyui-mcp][mcp] (MIT). This package adds
the parts that pack cannot ship: a launch button, one place for your API keys, standing
rules the agent follows on every turn, and an **Apply** button that puts a reply into a
node instead of letting the agent edit your canvas behind your back.

[mcp]: https://github.com/artokun/comfyui-mcp

## Setup

1. Install the panel (`comfyui-mcp-panel`) into `custom_nodes/`, and put the
   orchestrator somewhere — `E:\AI\forks\comfyui-mcp` is the default guess.
2. Put your provider keys in **`~/.pi/agent/auth.json`**, one entry each:

   ```json
   {
     "google":        { "type": "api_key", "key": "…" },
     "zai":           { "type": "api_key", "key": "…" },
     "moonshotai-cn": { "type": "api_key", "key": "…" },
     "dashscope":     { "type": "api_key", "key": "…" }
   }
   ```

   That is the **only** key store. Everything the orchestrator needs is derived from
   it, under whatever variable name each backend expects.
3. ComfyUI top bar → **XYZ Tools → Agent Orchestrator**, press **启动**. It waits for
   the bridge to answer, not merely for the process to exist.
4. Sidebar → **Agent Panel → Connect**.

## The launcher window

- **Custom lane 端点** — pick a provider (Gemini / Kimi / GLM / Qwen / DeepSeek), pick
  a model from the list the endpoint really serves, press 切换. It rewrites the
  configuration and restarts the orchestrator for you. Providers with no key in
  `auth.json` are shown greyed out rather than hidden, so a missing key looks like a
  missing key.
- **破限提示词常驻** — a switch plus a picker over `agent_data/unlock/*.md`. One file
  per note; the dropdown shows each file's first heading. Takes effect on the next
  message, no restart.
- **常驻规则** — `agent_data/house_rules.md`, always on. Edit it freely; it is re-read
  every turn.

## What the agent will and will not do

The standing rules are not decoration — they are what make the thing usable:

- **Your canvas is read-only unless you ask for a change.** Asked for a prompt, it
  hands you the text; it does not install it.
- **It reads the model's skill before writing that model's prompt.** Anima gets tags,
  Krea 2 gets prose, MiniMax H3 gets its structured fields, and a CharacterSheet LoRA
  gets its fixed template — because each of those is written down, not remembered.
- **Bypassed and muted nodes do not run**, and it is told to check before naming the
  model a graph uses.
- **It reads pictures without touching the graph** — a `@node:` mention, a LoadImage's
  filename, or an `XYZ Cache Slot Read`'s file on disk. It is told not to add a preview
  node to see something.

## Getting a reply into a node

Every code block the agent prints gets a small bar underneath: a dropdown of every text
widget on the canvas, and **Apply →**. Right-click a node → *📌 设为 Agent 默认输出端*
to pre-select one; the per-block dropdown still overrides it.

## Files

| Path | What |
|---|---|
| `launcher.py` | Finds and starts the orchestrator; turns `auth.json` into its environment |
| `routes.py` | `/xyz/agent/{status,start,log,unlock,providers,models,provider}` |
| `house_rules.default.md` | Shipped copy of the standing rules, seeded into `agent_data/` on first run |
| `../js/xyz_agent_launcher.js` | The launcher window |
| `../js/xyz_agent_output.js` | The per-code-block target picker + Apply |

`agent_data/` (gitignored) holds this machine's settings, the active content note, and
the orchestrator log.

## Notes

- **Model capability is per model, and worth checking.** Vision and tool-calling do not
  come together: `qwen-vl-max` sees but cannot call tools; `qwen3.7-max` refuses images;
  `glm-4.1v-thinking-flash` sees and never emits a tool call. Anything that cannot call
  tools is useless here — the agent lives on them.
- **An endpoint's model list is not always complete.** Z.AI serves `glm-4.6v` and
  `glm-4.5v` without listing them; the provider preset names them explicitly so the
  picker can offer them.
- **Keys are region-bound.** A Moonshot key from the China console 401s on the
  international host and vice versa; same for Qwen (qwencloud.com issues keys for the
  `-intl` endpoint). The presets carry the right host for each.
