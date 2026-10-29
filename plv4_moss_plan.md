# PLV4 MOSS 适配方案

发布记录：2026-10-29 用户授权将当前第三版实现随本地累积改动提交并推送；下文「未提交 / 推送」为历史状态。当前行为以第三版、源码与双语 README 为准，验证范围见 DEVELOPMENT.md 的同日发布条目。

状态：2026-10-19 首版已实现并完成定向验证，未提交 / 推送，正式 ComfyUI 未重启。下列实现定案优先于后面的设计记录。

同日后续修正：Preview 缺尺寸或接后端尺寸节点时返回比例坐标草稿，运行仍按真实尺寸转换；无实际 Region 时连执行 / metadata 保存也不要求尺寸。Mask Library 选中矩形临时在画布置顶且优先命中，保存顺序 / 输出不变。最新 Python 273 pass / 1 skip、Session 13 + Window 定向 2、浏览器 34 检查；真实队列空 / 纯文本无尺寸和后端尺寸连接三例成功。数字可读显示分支用 reader 注入验证，不算 Primitive 集成测试；Window 全量尚有六项桩依赖缺失，见 DEVELOPMENT / HANDOFF。

## 第二版：严格 MOSS 结构（用户决定 2026-10-20，进行中）

覆盖下文首版中与之冲突的部分（Region 容器、visible text 文本框、无区域时输出纯字符串）。

- **输出**：只有 caption（没有 region / meta / canvas / palette，例如负向节点）时输出纯文本（用户 2026-10-20 追加决定）；其余输出 JSON，没有 region 时只有 `{"summary": {...}}`，不写 `items` / `bbox_*`。字段没有内容就不写。bbox 继续向外取整。
- **顶层只允许**：caption block（普通 `{}` 或直接写的条目）、`[@region …]` block、`[@palette]` block，外加开头一行 `[@moss]: { meta: {…}, canvas: single|multi_panel|collage }`（都可省略；Settings 改的也是这一行）。
- **region 下只允许**：caption、`[@tag]`、`[@palette]`；`type: text` 的 region 还允许 `[@text]`。
- **caption block** 只能含 caption subblock，层数不限；**tag block** 只能含 tag subblock。二者唯一区别：Sentence case 只影响 caption。**palette block** 不允许 subblock。
- **语法**：`[@region mask: [x0, x1, y0, y1], type: object|character|text]: { … }`、`[@tag]: { … }`、`[@text]: { … }`、`[@palette]: { … }`。Upsample 仍是 Settings 里的元数据，不进语法。
- **汇总**：同一层的 caption 按文档顺序用 `, ` 连接；tag 每个条目一个数组元素；palette 每个条目一个颜色，多个 palette block 按顺序拼接并去重（tag 同理）；text 保留原文换行，多个 text block 用换行连接，只在 type=text 时输出。顶层 palette → `summary.palette`，region 内 palette → `items[].palette`。
- **取消 Region 容器**：节点本身就是 region 容器。Region 的统一设置（Region 开关、region 列表与遮罩编辑）放进节点 Settings，界面沿用原 Region 容器。
- **不合法结构直接不允许**：新建 subblock 只提供合法类型，拖放不能放进不合法的位置。手写 Source 写出的不合法结构灰显并给出诊断，不进输出。
- 原「MOSS visible text」文本框删除，旧值迁移成该 region 下的一个 `[@text]` block。
- Prompt-control 模式下：`[@tag]` / `[@text]` 当普通 block，`[@region …]` 等价于带 `.set{region}` 的 block，`[@moss]` / `[@palette]` 不输出。

实现（2026-10-20，未提交）：解析器 `parse_typed_block` / `parse_moss_block` / `parse_moss_region_block`（Group.block_type / moss_type / moss_config，document form 同名）；结构规则 `output_policy.MOSS_CHILDREN` + `model.mode_reasons`（projection 灰显、编译排除、Mask 资源解析三处共用）；`commands.apply_checked` 拒绝任何新增不合法结构的结构命令（Source 输入不拒绝）；新命令 SetMossSettings / SetMossType / ConvertRegionContainer，SetRegionEnabled 在 MOSS 下作用于根；前端 `output_mode.js` 镜像同一张表（新建菜单、拖放、补全）。Monarch 坑：正则里的 `@region` 会被当作属性引用，要写 `@(?:region)`。验证：t87 93 项通过，全量其余失败与改动前一致（9 个 JS 套件 + t75/t76/t80/t81/t82 共 10 项）；隔离 8199 fixture + 内置浏览器实测：切 MOSS 自动出现 `[@moss]`、meta/canvas 写回、Region 列表新建、菜单只列合法类型、tag/text 输入（含真实回车）、Preview JSON、Source 高亮无诊断、拖放判定、旧容器一键转换。面板处于隐藏状态，Tag/Text 新建走的是菜单项调用的同一个 `addBlock` 入口。

## 第三版（用户决定 2026-10-20，已实现）

覆盖第二版的块类型部分：type 写在普通 block 的 `.set{type: …}` 里（`[@tag]`/`[@text]`/`[@palette]` 块头删除，因为 Library block 自带 `[路径]` 头）。顶层可选 caption / meta / palette，region 内 caption / tag / palette（text region 加 text），subblock 继承不能选。`[@moss]` 只剩 canvas，是 Blocks 顶部的固定 block（不可删 / 关 / 移，Prompt Control 下隐藏）；meta 改为 meta 类型的 block。只有 caption 时输出纯文本。

## 实现定案与验证

- 同一 PLV4，General Settings 选择 Prompt Control / MOSS Image。输出设置保存在当前节点的 Document root meta 中，进入 workflow / history / metadata；加载 Library 文档保留当前节点设置。旧 workflow 配置后追加 width / height，不移动已有 inputs / outputs。
- 两个尺寸为 optional 强制连接插槽，没有默认 widget 值；仅实际输出矩形时执行要求宽高。无有效矩形时输出普通字符串，空节点 / 普通正文 / 区域关闭或被排除时均无需尺寸，metadata 允许无区域快照缺少尺寸。Preview 缺尺寸或尺寸来自后端上游时显示原比例坐标的 Layout + 提示；有可解析尺寸则显示最终中心像素坐标，临时坐标不返回保存 metadata。
- 原比例矩形转换成中心像素 yxyx；已有像素坐标按画布校验。每个 Region 独立 caption，不注入祖先 / 外部正文。支持 object / character / text，字面 Visible text 独立保存。
- Schedule / AVG 容器、带时间设置的普通 Block、Base / Fill / IMASK、包含 conditioning 操作的 format 整棵子树暂时排除，原 enabled 不改；UI 灰显并说明。MOSS 新建 Region 默认只有两个 mask entry。Region 功能关闭后，有效 mask 条目合并为普通正文，其他不支持条目仍排除。
- 普通随机 / shuffle / dropout 复用共享随机算法，忽略 group seed，使用 V4 节点 seed；先抽选再汇总 caption / items / 有效 LoRA 记录。
- 扩写开关通过现有 metadata 旁路传递，最终 JSON 始终无控制参数。XYZ PLV4 MOSS Upsample 对标原生 TextGenerate，直接复用 execute 并暴露完整采样 / thinking / template / MTP / system_prompt 和可选多模态输入；Nodes 1.0 参数平铺。支持 prompt + CLIP 独立使用（普通文本一次调用，Layout 默认逐 caption 扩写）；可选 metadata 选择区域并记录保存快照，两种输入同时提供必须匹配。输出原 prompt / plain / 更新 metadata 三槽不动，末尾追加 thinking；Layout 推理按 ID 隔离。普通文本和 summary 使用原 seed，区域稳定 ID 派生种子；128 项弱引用有界缓存覆盖所有生成参数，多模态输入不缓存。失败不返回部分修改结果。
- Sentence case 是默认关闭的节点选项，处理最终 caption，保留原文和 Visible text；保护常见缩写、URL、下划线 tag 和混合大小写名称。标签 / 专名不能被完整自动识别，这不是通用语言断句器。
- 普通权重默认不输出，可通过 NegPip weights 显式启用并外接 CLIP NegPip。LoRA 仅提取调用记录、保留触发词，不通过原生文本编码器加载；MOSS 下 LoRA strength 控件禁用，实际加载由外部节点负责。
- 定向 Python：t87 / t70 / t84 / t85 Region / t86 / t62 合计 **260 passed，1 skipped**，其中 t87 为 65 项。跳过的 torch case 已用 ComfyUI Python 借用开发 pytest、禁用无关插件自动加载单独补跑 **1 passed**。Session Node suite **13 passed**。
- 额外检查 t82 的两项旧失败：fake folder_paths 缺 get_input_directory；fake mask_nodes 不是 package。已在只含 HEAD Python 源码的独立 TEMP baseline 原样复现两项失败，未据此改生产代码或测试桩。
- 一次性真实 CPU ComfyUI + 独立 Chrome（Nodes 2.0 明确关闭）**23 项检查通过**：原 19 项真实键鼠 / 模式与恢复检查，新增扩写节点全部控件、输出位置、可选 metadata 和 Layout 序列化保护，errors=[]。普通字符串与 Layout 两次无模型 PLV4 节点执行 success；另两次真实队列通过新增扩写节点 + 实际原生 TextGenerate（合成 CLIP），验证 prompt / Layout / thinking。
- 原生 TextGenerate 接口以合成 CLIP 在 ComfyUI Python 中调用，sampling on/off / seed / reasoning / template / system_prompt / MTP 通过；扩写字段隔离、完整参数缓存及最终图片 metadata 有定向覆盖。**未运行真实 MOSS 模型采样，也未用实际 Qwen 权重验收扩写质量**。
- fixture：`C:/Users/XYZ/AppData/Local/Temp/xyz-moss-comfy-athshjwb`，最终截图 moss.png；个人库、原工作流、正式 / 持久 8190 未改。使用需重启正式 ComfyUI + Ctrl+F5。

## 已确认决定

1. 沿用现有 PLV4 节点和窗口，通过节点设置切换原模式 / MOSS 模式，不新增独立 PLV4 MOSS 节点。
2. width / height 直接接入 PLV4，但属于 optional 输入。原模式不要求连接；MOSS 模式缺少任一尺寸时明确提示，不默默采用默认尺寸。
3. MOSS 下不支持的 Schedule / Average 容器：整棵子树暂时不参与输出，切回原模式恢复。不得为此修改 Document 的 enabled 状态，不得丢失正文、设置或稳定 ID。

## 用户提出的目标

- 复用现有矩形 mask Region 和绑定的正文，为每个区域指定 character / object / text。
- 根据实际生成尺寸，将矩形转换成 MOSS 标准 Layout JSON。
- 提供独立的逐 caption AI 扩写节点，各区域在 PLV4 设置是否扩写。
- MOSS 首版不使用 IMASK，暂不提供 Schedule / CAT / Average 等编码阶段功能。
- 每个区域只使用自己 Block 内的正文；不自动把外部提示词复制到各区域。

## 源码核对

- `prompt_library_v4/compiler.py` 当前仅接受 couple / mask，并分别编译 prompt / plain；MOSS 应增加独立 adapter，不把最终 JSON 交给旧 COUPLE / AND 后端。
- Document v2 的稳定 ID / enabled / meta、Library 保存快照、原生正文与共享 Source 编辑器应继续复用。编译不读取 Class Library。
- 原来的 `region_mode` 是 Prompt Control 内部区域算法，不等于模型输出模式；新增输出模式不能重新解释旧 workflow 的 couple / mask 值。
- PLV4 矩形顺序为 `[x0, x1, y0, y1]`；MOSS bbox 顺序为 `[y0, x0, y1, x1]`，以画布中心为原点，单位为像素。
- `prompt_shared/image_metadata.py` 当前对 region_mode / compiler_policy 有严格校验；MOSS 需要兼容扩展，并同步 Gallery / 图片 metadata 的读取和保存路径。
- 原生 `TextGenerate` 可以复用现有 Qwen3.5-9B 编码器执行扩写；不得直接套用模板中明确禁止 JSON / 坐标的整段 caption 扩写系统提示词处理完整 Layout。

官方参考：

- <https://github.com/OpenMOSS/MOSS-Image/blob/main/USERGUIDE_ZH.md>
- <https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_moss_image.py>
- <https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_textgen.py>

## 节点和数据职责（设计记录，状态以上文为准）

### 输出模式与尺寸

- 原模式可标为 Prompt Control（Anima 等），其下仍保留 COUPLE / AND；MOSS 模式编译 Layout。
- 新增输入应追加，保留原节点身份、已有 widgets / sockets 的顺序与值。
- width / height 作为 optional INT 连接输入，不用一个有默认值的 widget 掩盖“没有连接”。
- 原模式不依赖尺寸；MOSS 模式缺失 width / height 时，编辑可继续，Preview 显示具体缺项。建议执行报可操作的错误，不生成猜测尺寸的 JSON，也不复用旧的成功结果。
- 尺寸需正整数、16 的倍数；上下游由同一分辨率来源供值。
- Preview 应区分编辑器已知的尺寸与运行时上游实际值；不能假装在不执行上游节点的情况下知道任意 INT 节点的输出。
- 尺寸、输出模式都必须进入执行缓存键和 metadata。

### 区域与整体描述

- 不属于有效 Region 的正文汇集为 `summary.caption`。
- 每个有效矩形 Region 生成一个独立 item，caption 仅来自该 Region 的内容（包括内部普通子 Block），不注入外部或祖先正文。
- 新字段绑定 DocNode 的稳定 ID，不能依靠区域序号识别。建议默认 label 为 object。
- character / object 的区域正文就是 caption。
- text 需要独立的“要画出的文字”字段；区域正文用来描述字体、颜色、材质和排版。字面文字的换行、标点和语言必须原样保存。
- 保留实际 Document 顺序，不按类型或名称重新排序；MOSS Layout 仍属于模型布局提示，不是硬遮罩。
- Region 功能开关关闭时，有效 mask 条目按普通正文展开；不能将其与整个 Block 的 enabled 混为一谈。

### 坐标

对比例矩形 `[x0, x1, y0, y1]`，宽 W、高 H：

```text
bbox = [
  floor(y0 * H) - H/2,
  floor(x0 * W) - W/2,
  ceil(y1 * H) - H/2,
  ceil(x1 * W) - W/2
]
```

- 最小边向下、最大边向上取整，处理浮点边界误差；不必先量化成 0–1000，避免额外精度损失。
- 最终固定 `bbox_coord_space=abs_centralized`、`bbox_format=yxyx`。
- 不直接改写文档中保存的比例；同一文档改变生成尺寸后重新求 bbox。
- 原有像素矩形、越界或退化矩形必须有明确校验 / 转换行为，不能混用比例与像素。

### 逐 caption 扩写

- 独立节点接受 Layout、CLIP、种子 / 扩写配置以及区域扩写选择信息。
- 只扩写标记为需要扩写的 item.caption。summary 是否扩写用独立开关。
- 每次只提交该区域的描述，使用区域描述专用 system prompt，避免生成另一张完整图片的描述。
- JSON 解析后逐字段更新，再序列化；不能让 LLM 重写整份 JSON。
- label、bbox、text、palette 和 item 顺序保持原值；text 的字面内容不交给扩写器改写。
- 用户提出“JSON 中携带临时参数，下游 strip”。建议评估复用现有 metadata 作为旁路信息：最终 prompt 始终是纯 MOSS JSON，不接扩写节点也可直接编码；如选择扩展 JSON，必须区分中间格式与最终格式。
- 按稳定 Region ID 对应扩写标记 / 派生随机种子，支持有界缓存，避免每次随机选词或改动其他区域都重新生成全部 caption。
- 扩写节点应输出更新后的 metadata，记录实际用于编码的最终 JSON；保存图片时接这一份，保留原始 Source / Document，避免 Gallery 仅记录扩写前提示词。
- 扩写模型、配置、种子参与缓存。失败不输出不合法 JSON 或部分修改结果。

### 功能范围

| 功能 | 首版建议 |
| --- | --- |
| 普通 Block / Pool / Library / enabled | 保留 |
| 随机选择 / shuffle / dropout | 保留，在输出 JSON 前使用节点 seed 求值 |
| 普通字符串拼接 | 保留 |
| 矩形 mask Region | 支持，映射为 Layout item |
| IMASK | 暂不支持 |
| Schedule / Average 容器 | 按已确认规则整棵子树暂时排除 |
| 时间设置在普通 Block / Region 上 | 同样排除对应子树 |
| CAT / AVG conditioning 操作 | 首版不输出，不能把操作符放进 caption 伪装成支持 |
| feather / mask_weight / cond_weight / include_in_base | 不直接映射到 Layout，保留原数据，MOSS 下禁用这些设置 |
| Base / Fill | 暂时排除，切回原模式恢复 |
| 普通提示词权重 | 可选 NegPip weights，需外接兼容节点 |
| LoRA | 保留触发词和调用记录；由外部 LoRA Loader 实际加载 |

Schedule / CAT / AVG 是编码或采样阶段的操作，不属于 MOSS 原生 Layout JSON。首版暂不提供这些功能，不应表述为 MOSS 永远不能通过其他节点实现。

## 自然语言分隔与输出大小写（2026-10-19 讨论）

源码与纯函数探针确认：现有共享语言已经把英文逗号、后接空白或文本末尾的英文句号作为分隔。逗号不属于 item；句号保留在 item 内。Document 另存 sep，`render(from_text(source))` 保留原文；编译 join 遇到句号结尾不补逗号。无需为 MOSS 再造一套同义规则。

当前边界：

- `a cat, blue eyes. it sits on a mat.` → 三个 item，Document / 编译输出均保留原内容。
- `0.35` / `a.b` 不分隔；`a cat.It sits.` 也不会在中间分隔。
- `Dr. Smith` 会拆成两个 item；中文句号 `。` 当前不分隔；完整引用字符串中的标点受引用语法保护。
- 自然语言句内逗号仍拆 item，常规重新组合可以还原，但 shuffle / random_select / dropout 按 item 操作时可能拆散一句话。以普通子 Block 包裹整句可提供外层操作的整体单位；内部随机设置仍需谨慎。
- 不应仅凭末尾有无句号推断原始全部分隔和空白；需要继续保存 sep。不要把字符分隔规则当成完整的自然语言断句器。

用户提出新增可开关的输出句首大写，已作为节点选项实现：

- 作为会影响编译结果的 Node Setting，默认关闭，随 workflow / metadata 保存并进入缓存键；XYZ 全局设置至多提供新节点默认值。
- 只处理最终 caption 的句首，不是每个以逗号分隔的 item 首字母；不把其余字符转为小写。
- 分别处理 summary.caption 与各 item.caption，不处理 label / bbox / JSON key / text 字面文字 / LoRA 调用等字段。
- 保留 Source / Document / Library 原始大小写。避免破坏画师名、标签、品牌、标识符、URL 等大小写敏感内容。
- 仅改输出的功能应放在最终输出链上；启用下游扩写时需统一其执行顺序与 metadata，不能在 Preview / 原输出上重复实施一套不一致规则。
- 缩写、引号、`!` / `?` / `。` 后的句首识别需单独确定；不能直接借用条目分隔器或用逗号判断句首。

## 后续验证范围（实现后）

- 原模式旧 workflow 的 sockets / widgets / 编译结果和 seed 策略不变。
- 切换模式不写 enabled，切回完整恢复；不支持结构在 UI / Source / 后端使用相同能力规则。
- 非正方形画布、左右 / 上下框、浮点边界及 dimensions 缺项。
- 3 种 label，中文 / 换行 / 引号，字面 text 不被分隔或扩写破坏。
- 区域不继承外部正文，随机结果一致，已关闭 / 无效区域不误输出。
- 启用扩写 / 不扩写、区域重排 / 删除、不同节点副本及最终 metadata 一致性。
- 使用一次性隔离实例验证 Node 1.0 窗口，不写个人数据库 / 工作流，不重启正式服务或持久 8190。
