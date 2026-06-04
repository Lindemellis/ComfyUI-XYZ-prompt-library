# LLM 提示词助手

[English](README.md) | **中文**

一个浮动窗口，调用大语言模型来**生成或优化文生图提示词**，并能把 danbooru 风格的 tag 拿到
你的**本地标签数据库**里验真，让模型只用真实存在的 tag。

它与 文本编辑器 / 库 / 预览 窗口并列，可从节点上的 **🤖 LLM** 按钮、顶栏菜单
（*Prompt Library V2 — LLM Prompt*）、或文本编辑器的 **🤖 LLM** 按钮打开。

## 模型提供方

在 *设置 → LLM* 里选择提供方。每家各自保存自己的 API key 和模型，可随意切换无需重填。
key 存在**服务端**（`prompt_library_v2_data/llm_settings.json`），绝不进入浏览器或
`localStorage`。

| 提供方 | 协议 | 默认端点 |
|---|---|---|
| DeepSeek | OpenAI 兼容 | `https://api.deepseek.com` |
| OpenAI (GPT) | OpenAI 兼容 | `https://api.openai.com/v1` |
| Claude | Anthropic | `https://api.anthropic.com` |
| Grok (xAI) | OpenAI 兼容 | `https://api.x.ai/v1` |
| **自定义** | OpenAI 兼容 **或** Anthropic | 你的端点 |

**自定义**选项可指向任意 OpenAI 兼容端点（Ollama、LM Studio、vLLM、OpenRouter…）或
Anthropic 兼容端点——自行设置 base URL、模型 id 和 API 格式。

### 配置步骤

1. 打开 *设置 → LLM*（窗口里的齿轮、顶栏菜单，或命令面板）。
2. 选择**提供方**，粘贴**API key**，从下拉里选**模型**——点 **↻** 会拉取该提供方的实时模型
   列表（例如 DeepSeek 返回 `deepseek-v4-pro` 和 `deepseek-v4-flash`），选「Custom model id…」
   可手动输入任意 id。
3. 点 **Test connection** 验证 key/模型——结果以 toast 弹出显示。
4. *（可选）* 设置 **Temperature** / **top_p** 和 **Thinking**（各提供方共用）。

### 思考强度（Thinking / reasoning effort）

DeepSeek V4 模型（`deepseek-v4-pro` 和 `deepseek-v4-flash`，都支持工具调用）有**思考**控制，
在 *设置 → LLM → Sampling → Thinking* 里：

| 档位 | 效果 |
|---|---|
| **Off** | 不思考——最快、最省。 |
| **High** *（默认）* | 正常推理。 |
| **Max** | 全力推理——留给难题。 |

它对应 DeepSeek 的 `thinking` / `reasoning_effort` 参数，**只发送给 DeepSeek 提供方**（其它
OpenAI 兼容端点会忽略）。开启思考后，模型的推理会流入可折叠的 **💭 思维链** 区（见对话）。

## 标签页 1 — 板块（Blocks）

系统提示词由可重排的**板块**拼接而成。每个板块有启用开关、**存档变体下拉**（为一个板块保存
多个版本并切换）、折叠按钮、可调高度的文本框，以及一个 **⊞** 按钮——点开会在一个可拖动/缩放
的**浮动编辑器**里编辑当前变体（双向实时同步）。拖动 **⠿** 手柄重排；板块自上而下拼接。

默认板块（首次运行时种入，均可编辑）：

| 板块 | 作用 |
|---|---|
| History chats | 回放对话最近 *N* 轮（`all` 或一个数字）。 |
| Header | 模型的角色设定。 |
| Jailbreak | 成人/NSFW 许可（克制的起步版，请自行加强）。 |
| Task description | 文生图提示词的结构规范；强制**英文**输出。 |
| Format reference | 如何用围栏包裹最终提示词（正面放 ```prompt；负面仅在被要求时才出）。 |
| Danbooru lookup tool | 何时/如何使用查表工具。 |
| Web search tool | 何时/如何使用网络搜索工具（默认关闭）。 |
| Base prompt | *占位符*——发送时填入绑定节点的 resolved 提示词。 |
| User request | *占位符*——发送时填入你的聊天输入。 |

`Base prompt`、`User request`、`History chats` 是特殊占位板块（无文本框）。
用 **＋ Add block** 添加自定义板块。

### Anima 预设

每个文本板块都附带第二个 **`anima`** 变体，针对 [Anima](https://huggingface.co/circlestone-labs/Anima)
模型调校（Qwen3-0.6B text encoder；danbooru/gelbooru tag + 自然语言 + 二者结合；优先 gelbooru
拼写；画师加 `@` 前缀；权重更高 ~1.4+）。把任意板块的**变体**下拉切到 `anima` 即可启用。该预设：

- 除非你要求，否则不写负面提示词；
- 只查证**它自己引入**且不确定的 tag——绝不重新核对**你已经写好**的 tag（你的质量/画师/角色
  tag 原样保留）；
- 按你的意图调整回答：完整提示词、优化、**只给某一个元素的 tag**、或纯聊天——你只是提问时
  不会硬塞一整段提示词。

预设会随新版本自动更新（仅限你未手动编辑过的变体）。

## 标签页 2 — 对话（Chat）

- **Base prompt**（顶部）：绑定一个 Prompt Library V2 节点，让它的 **resolved** 提示词成为
  优化对象（实时重新解析、只读），或脱钩为*自由编辑*。折叠按钮和拖柄可控制该区域高度。
- **对话列表**（左侧）：新建、重命名（双击）、删除。对话是全局的，不绑定任何节点。
- **消息区**（右侧）：对话记录。输入需求（任意语言）后点 **Send**（回车=换行）。生成期间可
  **Stop**；最后一条回复带 **↻ regenerate**。当模型把结果放进 ```prompt 围栏块时，会出现
  **Copy** 和 **Apply** 按钮——**Apply** 直接写入绑定节点的提示词模板。绑定的 base prompt 会在
  你编辑节点、文本编辑器、或它引用的任意库条目时实时重新解析。
- **流式** 开关（Send 旁边）：开启后回复逐 token 流式显示，模型的推理实时出现在可折叠的
  **💭 思维链** 框里（历史回复若带推理也会显示）。关闭则一次性返回非流式结果。

## 标签查表（让 tag 真实可靠）

启用**标签查表**后（*设置 → LLM*），模型可以调用一个工具搜索你的本地 danbooru/gelbooru
数据库。工作流（由 *Danbooru lookup tool* 板块驱动）：模型为**它自己要引入**的概念头脑风暴出
英文候选 tag，查表，只使用真实存在的 tag——优先 post_count 高的。你可以用中文或日文写需求，
模型会自己把概念翻成英文（数据库只负责验真 + post_count）。它**不会**浪费查询去重新核对你已经
提供的 tag。可独立开关 **danbooru** / **gelbooru** 两个来源；未安装对应数据库的来源会显示为
不可用。

查表**关闭**时，模型只靠自身知识（不调工具）。

## 网络搜索（可选，默认关闭）

在 *设置 → LLM* 里开启**网络搜索**，给模型一个免 key 的网络搜索工具（DuckDuckGo），用于标签
数据库回答不了的事实——某个陌生概念的正式名、角色的外观、或用某种画风的画师。它是查表之后的
兜底；提示词会让模型优先用 `danbooru …` 这样的查询，并在使用前用查表确认名称。结果可能不稳定
（是网页抓取）且增加延迟，所以默认关闭，需要时再开。

## 说明

- 工具循环（查表 + 网络搜索）在服务端运行，有上限以保证总能产出最终答案。**Stop** 取消正在
  进行的请求。流式会实时转发 token + 推理；非流式则在结束时一次性返回。
- 某些 DeepSeek 模型会把工具调用以正文标记的形式输出（而非结构化调用）；这会被透明地解析并
  执行，不会泄漏进展示的回答里。
- 错误就地显示（红色气泡）；缺少 API key 会引导你到 *设置 → LLM*。
- 优化结果是一段扁平的 tag 字符串。**Apply** 会用它覆盖绑定节点的模板（该节点原有的
  `[ref]` 结构会被替换——这是设计如此）。
