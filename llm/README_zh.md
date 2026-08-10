# LLM 提示词助手

[English](README.md) | **中文**

一个浮动窗口，调用大语言模型来**生成或优化文生图提示词**。它内置面向不同出图模型的**提示词
模板**——booru tag 默认版、**Anima**、**Krea 2**——并能把 danbooru 风格的 tag 拿到你的**本地
标签数据库**里验真，让模型只用真实存在的 tag。

它绑定到 **Prompt Library V3** 节点，可从该节点上的 **🤖 LLM** 按钮、顶栏菜单
（*XYZ Tools → LLM Prompt Assistant*）、或 PLv2 文本编辑器的 **🤖 LLM** 按钮（只开窗、不绑定）
打开。

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

### 模板 —— 一键切换整套系统提示词

不同出图模型要的提示词完全不一样，所以 Blocks 标签页（以及 Chat 标签页）顶部的 **Template**
下拉可以一次切换所有板块：

| 模板 | 适用 | 做什么 |
|---|---|---|
| **Danbooru (default)** | SDXL / Illustrious / Pony 之流 | 逗号分隔的小写 booru tag，开启查表。 |
| **Anima** | [Anima](https://huggingface.co/circlestone-labs/Anima) | tag **+** 自然语言混写；优先 gelbooru 拼写；画师加 `@`；权重更高（~1.4+）。开启查表。 |
| **Krea 2** | [krea-ai/krea-2](https://github.com/krea-ai/krea-2) | 纯描述性英文，**不用 tag、不用权重、没有负面提示词**。**关闭**查表。 |
| **MiniMax H3** | MiniMax H3（画面 **+** 声音） | 按 MiniMax 官方格式写的结构化多字段提示词，覆盖全部五种输入模式。**两个工具都关**。 |

**MiniMax H3** 是唯一一个不是文生图的模板。H3 同时生成画面和声音，它的提示词是一份小型
结构化文档而不是一行 tag：具名字段、带 `[Shot N] At MM:SS.mmm` 切点的镜头时间线、
写成「运动类型 + 幅度 + 速度」的运镜、`(S1)` 说话人编号配 `<d>[语言] …</d>` 台词，
以及两个独立的声音字段。模板覆盖每一种输入模式：

| 模式 | 你给什么 | 骨架 |
|---|---|---|
| **T2VA** | 只有文字 | `integrated_multimodal_description` + `overall_soundscape` + `non_diegetic_music` |
| **I2VA** | 首帧图 | 三个字段，前面加一行首帧指令 |
| **FL2VA** | 首帧**和**尾帧 | 三个字段，前面加一行双图对齐说明 |
| **L2VA** | 尾帧图 | 三个字段，前面加一行单图对齐说明 |
| **Ref2VA** | 参考图 / 参考视频 / 参考音频 | 六个段落：`subject_definitions`、`summary`、`retention_analysis`、`detailed_description`、`overall_soundscape`、`non_diegetic_music` |

前四种走 ComfyUI 的 `MiniMax H3 Image to Video`（填或不填 `first_frame` / `last_frame`），
Ref2VA 走 `MiniMax H3 Reference to Video`。模板里写进了真实的时长换算——24 fps，节点默认
`length=124` 帧即 5.17 秒——所以模型写出的时间戳会落在你实际渲染的片长之内。

模板**就是**一个变体名：切到 `krea2` 会把每个板块指向它的 `krea2` 变体，并设定哪些板块启用。
这和每个板块的**变体**下拉做的是同一件事——两者是同一份数据的两个视图，所以切完之后你仍然
可以单独微调某一个板块。

**板块被关掉，它对应的工具也一并撤掉。** Krea 2 会关闭 *Danbooru lookup tool* 板块，于是这次
请求根本不会挂上 danbooru 工具——模型不会拿到一个系统提示词里从没提过的工具。MiniMax H3
把**两个**工具文档板块都关掉，于是它完全不带工具运行：没有 tag 词表需要验真，提示词是照着
你的需求写出来的，不是查出来的。（你在
*设置 → LLM* 里的全局开关仍然叠加生效；模板只能收走工具，不能凭空给出工具。）

- **Save as…** 把当前每个板块的文本**和**开关状态快照成你自己的模板——想给未内置的模型加预设
  就用它。
- **🗑** 删除选中的用户模板（内置那三个删不掉）。
- **— mixed —** 表示各板块当前挂在不同名字的变体上（你手动挑过）。选一个模板即可重新对齐。

当前模板是**从板块推导出来的**，不是单独记一份，所以它绝不会声称你并不在的模板。

两个内置预设都会：

- 按你的意图调整回答：完整提示词、优化、**只给某一个元素**、或纯聊天——你只是提问时不会硬塞
  一整段提示词；
- 除非你要求，否则不写负面提示词（Krea 2 则完全不写——该模型没有负面提示词，它会告诉你正面
  的改法）；
- 解释保持简短，用散文或短横线列表，绝不用 markdown 表格。

Krea 2 还会在心里先比较**两三个**风格/媒介/光照候选再定一个——否则所有请求都会漂到同一个
"cinematic, highly detailed"默认坑里——并且这个权衡过程不外泄，你拿到的是成品提示词，而不是
一份它否决了哪些方案的流水账。它的第一条写作规则（优先级高于其余各条）是忠实：细节必须从你
说的话里**抽出来**，不能在旁边凭空造。

内置预设会随新版本自动更新——仅限你未手动编辑过的变体。

## 标签页 2 — 对话（Chat）

- **Template**（顶部）：与 Blocks 标签页同一个切换器，换出图模型不必离开当前对话。
- **Base prompt**：绑定一个 **Prompt Library V3** 节点，让它的**编译输出**——也就是采样器真正
  会收到的那串、库分组已展开——成为优化对象（实时重新编译、只读），或脱钩为*自由编辑*。
  折叠按钮和拖柄可控制该区域高度。
- **对话列表**（左侧）：新建、重命名（双击）、删除。对话是全局的，不绑定任何节点。
- **消息区**（右侧）：对话记录。输入需求（任意语言）后点 **Send**（回车=换行）。生成期间可
  **Stop**；最后一条回复带 **↻ regenerate**。当模型把结果放进 ```prompt 围栏块时，会出现
  **Copy** 和 **Apply** 按钮——**Apply** 直接写入绑定节点的 `text`，节点内嵌的 Monaco 编辑器和
  PLv3 浮动窗口会立刻同步。文本是**原样**写入的（不做 PLv2 那套规范化：给 Krea 2 句子里的括号、
  或 `(tag:1.2)` 权重加转义只会写坏）。你在任何地方改动该节点，base prompt 都会实时重新编译。
- **流式** 开关（Send 旁边）：开启后回复逐 token 流式显示，模型的推理实时出现在可折叠的
  **💭 思维链** 框里（历史回复若带推理也会显示）。关闭则一次性返回非流式结果。

## 标签查表（让 tag 真实可靠）

启用**标签查表**后（*设置 → LLM*），模型可以调用一个工具搜索你的本地 danbooru/gelbooru
数据库。工作流（由 *Danbooru lookup tool* 板块驱动）：模型为**它自己要引入**的概念头脑风暴出
英文候选 tag，查表，只使用真实存在的 tag——优先 post_count 高的。你可以用中文或日文写需求，
模型会自己把概念翻成英文（数据库只负责验真 + post_count）。它**不会**浪费查询去重新核对你已经
提供的 tag。可独立开关 **danbooru** / **gelbooru** 两个来源；未安装对应数据库的来源会显示为
不可用。

查表**关闭**时——全局关掉，或当前模板关掉了 *Danbooru lookup tool* 板块（Krea 2 就是）——模型
只靠自身知识。对 Krea 2 而言这是对的：它接受任意词句，没什么可验真的。

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
- 优化结果是一段扁平字符串。**Apply** 会用它覆盖绑定节点的整篇文档——原本用到库分组、region
  或调度的 PLv3 文档会被这一趟往返拍平。这是设计如此（纯逗号文本本身就是合法 PLv3）；想保留
  结构就用 Copy 而不是 Apply。
- *Web search tool* 板块在除 MiniMax H3 外的所有模板下都可用（H3 把它关了）；Krea 2 版本让
  模型去搜"它长什么样"然后用文字描述出来，因为这里没有 tag 可验真。
- **用 H3 模板时请用 Copy，不要用 Apply。** Apply 是写进 *PLv3* 节点的，而 PLv3 会去编译这段
  文本：它会转义每一个冒号（`integrated_multimodal_description\:`、`00\:03.500`），把分隔各
  字段的空行压成一整行，还会对每个 `[Shot N]` 报 `W14`。编译不会失败，但出来的东西已经不是
  合法的 H3 提示词了。请复制那个块，粘进 H3 节点自己的 `prompt` 输入框。
