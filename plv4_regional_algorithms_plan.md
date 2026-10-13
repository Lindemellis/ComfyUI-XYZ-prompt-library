# PLV4 区域算法切换与 Anima 注意力遮罩讨论记录

日期：2026-10-13。

**当前状态：讨论已归档，算法实现暂停。** 用户要求先让另一个对话完成 bug 修复，之后再继续本功能。本记录不是新增后端已经完成或已通过采样验证的声明。

## 1. 用户已经确定的方向

1. 第一版采用 **一个 PLV4 节点统一一种区域算法**，不按单个 Region 或 Region 组合分别选择。
2. 设置入口在 **PLV4 window 中间栏 header**：增加 setting icon，点击后右侧 Settings 显示整个节点的 **General Settings**，其中提供算法 dropdown。
3. 先完成 **Attention Couple / AND** 两种语法的切换，然后尝试接入 **Anima 注意力遮罩**。
4. 保留 Prompt Control 的文字编码、LoRA 与时间调度能力。新增后端需要采样端执行代码，不能认为“把自定义语法／配置挂到 CLIP 上”就自动生效。
5. 逐区域采样、RAG 和 Dense 重标定没有在本次被选为首批实现目标。

用户最初允许在混用过于复杂时改成 XYZ Settings 全局选择；随后明确采用节点统一算法和窗口 General Settings 入口。以这个后续决定为准。

## 2. 当前已经完成的部分

现有两个编译后端早已存在，本次完成的是设置入口迁移与联动：

| General Settings 选项 | 保存值 | prompt 输出 |
| --- | --- | --- |
| Attention Couple (COUPLE) | `couple` | `COUPLE` 配合 MASK / IMASK / FILL |
| Latent Mask (AND) | `mask` | `AND` 配合 MASK / IMASK；Fill 按现有编译规则处理 |

- 中间栏 ⚙ 打开右侧 General Settings → Region algorithm；旧 toolbar select 已移入此页。
- 继续使用既有 `region_mode` widget 作为节点执行与 workflow 序列化的真值，保留旧 `mask` 工作流值；上游连接提供 mode 时禁止手动覆盖。
- Block 设置／定位返回对象 Settings，包括定位同一已选中 Block；Library 页面隐藏节点设置入口。
- 打开 General Settings 先提交当前正文草稿；pointerdown 保留点击目标，防止 blur 重绘吞掉点击。General 页复用 select，旧异步 Pool mount 不能覆盖新页。
- 相关文件：`js/plv4/window.js`、`details.js`、`region_mode.js`、`design.css`。用户说明与维护记录已更新。

验证：独立 LoRA fixture（临时 Library、合成节点）和独立 Chrome 共 **17 项真实鼠标／键盘、可见性和编译联动检查通过**，errors=[]。既有 history/settings 4 项定向测试通过，三份 ESM 与 diff 检查通过。首次完整 window 文件测试有 3 个 mock 失败，失败代码本轮未修改：NodeSessions 缺 window 两项、renderTabs fixture 缺 folderNameControl 一项。

验证范围不包括真实模型采样、完整 ComfyUI workflow 保存恢复或用户原位验收。界面更改仅需 Ctrl+F5。临时观察材料：`C:/Users/XYZ/AppData/Local/Temp/xyz-general-settings-check.cjs` 和 `xyz-general-settings.png`；本次自有 fixture 已核验关闭。

**尚未完成：** Anima dropdown 选项、对应编译输出、自定义编码适配、MODEL patch、参数保存／界面及模型采样验证。上一轮被打断时仅在读源码、研究接口，没有落盘上述新算法代码。

## 3. 原调研“六种”的准确含义

它们是按修改计算的位置划分的六类路线，不是六个可直接互换的 attention 插件。

| 类别 | 核心修改 | 与本次目标的关系 |
| --- | --- | --- |
| 完整模型预测混合 | 各区域分别计算模型预测，然后按 mask 合并 | PC Mask / AND；已有 |
| 注意力输出混合 | 各文本分支分别计算 attention，再混合其输出 | PC Couple；An1X3R 属于同家族 |
| 注意力分数遮罩／偏置 | 在 softmax 前限制图像与文本 token 连接；可限制图像 self-attention | Sen-sou／MoonNodes；本次下一目标 |
| 注意力分数重标定 | 在 softmax 前增加区域面积相关的分数缩放 | 本次所指是 Omost 版 DenseDiffusion；暂不实现 |
| 逐区域采样 | 在一个外层步骤中顺序执行区域采样与 latent 更新 | 需要采样流程适配；暂不实现 |
| RAG 复合方法 | 局部生成轨迹／特征，再注入全图生成并软细化 | 需要两阶段管线和模型特征注入；暂不实现 |

原调研对话：[01a1328c-5a29-7821-b2c9-59c8e5659db3](codex://threads/01a1328c-5a29-7821-b2c9-59c8e5659db3)。用户明确提供了该链接，本次只读核对对应本机 session。不要把 An1X3R 的 classic / global_mix 再计为两类全新底层算法。

## 4. 三种当前相关算法的区别

以下省略 CFG、batch、LoRA、调度及具体权重处理；公式仅用于说明核心控制位置。

PC Mask：完整模型预测 `y_i = F(x_t, t, c_i)`，再按空间权重合成预测。多个区域需要多份完整预测；合批不消除计算量。

PC Couple：`a = Σ_i w_i · softmax(S_i) V_i`。各提示词独立归一化，随后在 attention 输出端按 mask 混合；通常不按区域重跑完整模型。

Anima 分数遮罩：`a = softmax([S_0, S_1, …] + B) V`。区域文本 token 拼接，禁止连接施加负偏置，硬限制为负无穷。允许参与的 token 在同一个 softmax 中竞争；可进一步限制区域间 self-attention。

因此，Anima 遮罩在执行位置和计算路径上更接近 PC Couple，但二者不数学等价。硬分区减少直接跨区域文本关注，不保证人物边界或姿态绝对准确；self-attention 限制过强也可能降低整体连贯性。

Omost Dense 进一步使用 `softmax(γS + B)V`，其中区域面积补偿约为 `γ = 全图 token 数 / 区域 mask 面积`。这是 softmax 前的分数缩放，不等同于对最终输出乘权重，也不应保证“小区域一定更强”。现有节点主要面向 SD1.x／SDXL，不能直接声称已支持 Anima。

## 5. Anima 遮罩来源与可调参数

主要来源：[Sen-sou/Comfyui-Anima-Regional-Conditioning](https://github.com/Sen-sou/Comfyui-Anima-Regional-Conditioning)，[实现 nodes.py](https://github.com/Sen-sou/Comfyui-Anima-Regional-Conditioning/blob/main/nodes.py)。本机已安装在邻目录 `../Comfyui-Anima-Regional-Conditioning/`。MoonNodes 的 Anima patch 属于同一方法家族，但本次优先尝试复用 Sen-sou。

以下为来源实现可调项；**不表示它们已经加入 XYZ，也不是已确定的全部 UI／默认值。**

| 参数 | 作用 | 来源范围／选项与注意事项 |
| --- | --- | --- |
| `base_mode` | 全局／背景条件在哪些位置参与 | `uncovered_only`、`global`、`disabled` |
| `base_strength` | 背景 mask 强度 | 来源节点范围 0–10；不是简单的提示词 token 权重 |
| `start_percent` / `end_percent` | 区域 patch 生效区间 | 0–1；这是补丁时间，不自动等价于 PLV4 正文的 Schedule |
| `cross_mask_strength` | 图像位置对非所属区域文本 token 的限制 | 0–1；在有效强度满足条件时 1 为硬限制，更低值为软限制 |
| `self_mask_strength` | 不同图像区域之间 self-attention 的限制 | 0–1；过强可能割裂画面；具体效果也受 base_mode 影响 |
| `base_ratio` | 混合原始模型输出和区域模型输出 | 0–1；0 只算区域版本，介于 0 与 1 时额外计算完整原始前向，1 绕过区域 patch |
| `cross_inject_every_n_blocks` | 每隔 N 个模型 transformer block 注入 cross 限制 | 来源节点 1–100；这里的 block 是模型层，不是 PLV4 Block |
| `self_inject_every_n_blocks` | 每隔 N 个模型 transformer block 注入 self 限制 | 来源节点 1–100 |
| 每区域 `weight` | 区域的有效强度／参与 | 0 禁用区域；源码对强度存在内部钳制，不直接等价于 PC mask_weight |
| `background_conditioning` | 显式背景条件输入 | 可选；不连接时使用进入模型的原 context |

来源 README 的测试建议包括 `end_percent=0.35`、`cross_mask_strength=1`、`self_mask_strength=0.2`、`base_ratio=0.1`、注入间隔为 1。这些只是来源建议，不是 XYZ 的已验证最优值。

本次助手提出初版 **默认 `base_ratio=0`**，以避免默认引入额外整模型前向；用户尚未对其余默认值逐项确认。即使 base_ratio 为 0，长文本、self-attention 矩阵和 attention 后端仍可能增加耗时／显存，不能保证耗时增量很小。没有做 GPU 耗时测量。

## 6. 接入架构：已确定边界与尚未确定方案

### 已确定边界

- PLV4 负责 Document 编辑、seed 与随机选择、区域正文／遮罩／权重／时间信息。
- PC 继续负责它支持的语法和调度；不能让未知区域指令直接进入 tokenizer 当普通文本。
- Anima 后端需要模型内部执行支持。CLIP 可传递数据，CONDITIONING 可携带 hook，但还必须有对应 MODEL patch 消费它们。
- 同一有效分支不能叠加 PC Couple hook 和 Sen-sou patch 来冒充“切换后端”。
- 普通编译保持纯函数，不读取 Library；遮罩资源仍通过 V4 adapter 解析。
- 旧 V3 身份、插槽和编译策略必须保持；不为第三种后端自动扩展 V3 的模式集合。

### 讨论过的方案，尚未选定

1. **结构化区域执行计划＋统一适配节点**：从同一次随机化编译生成正文、遮罩和时间计划，节点内部复用 PC 编码／调度，再安装 MODEL patch。比从 final prompt 反向拆解可靠，但会新增执行接口。
2. **自定义区域语法＋PC `NODE(...)` 编码适配＋独立 MODEL patch**：PLV4 输出显式新语法，PC Schedule Prompt 先解析时间片，再调用自定义编码节点；CONDITIONING 携带区域数据／condition-scoped hook，模型补丁执行来源算法。源码接口已读，**尚未验证**。

第二项可能保留当前外部可见的 PC Schedule Prompt 节点，但涉及 `TransformerOptionsHook`、scheduled CLIP／LoRA 条件对齐，以及来源 patch 的 runtime API。没有确认自定义关键字、节点名字、输入输出或第五个 PLV4 插槽；不要把研究中的名字写成既成产品接口。

复用已安装来源实现可以避免再复制一份算法，但依赖私有函数／类有版本风险。继续时需确认接口和缺依赖的明确错误，不在 pack 启动时重新导入或写入第三方插件，也不能修改 ComfyUI 核心来接入。

## 7. 继续时必须解决的技术问题

- **Schedule**：PC 时间解析必须发生在区域条件构建之前，或统一按时间片生成区域计划；正文出现／消失与 patch 生效时间分别处理。已有调研指出相同遮罩不同时间、空区域残留问题，不能默认已修复。另一个对话是否涉及这些修复，需要继续时重新读最新文档／diff。
- **随机一致性**：区域正文、最终输出、metadata 共用实际编译结果，不重新解析后另抽随机或在时间片中重抽。
- **LoRA / CLIP hooks**：保留 PC 的时间窗和 WeightHook；区域 embedding 的 schedule 不能只取第一个 conditioning。不得丢失 Anima 的 t5xxl_ids / weights 等附带元数据。
- **Base / Fill**：多个组合当前按节点合并；Sen-sou base_mode 与 PC 的 base／fill 并非完全相同，必须显式规定映射，不能静默忽略 Fill。
- **权重与羽化**：PC mask_weight、cond_weight 与 Sen-sou 区域强度不等价；来源 membership／token-grid 投影并不自动保留全部羽化语义。需要明确映射或能力限制。
- **资源**：复用矩形和图片 mask、既有 IMASK 挂载顺序；保证缺资源明确报错，Region 功能关闭时不挂载／执行。
- **模型与批处理**：只在支持的 Anima 结构运行；检查 CFG 正负拆分、batch、不同文本长度、patch 开关与模型 clone 上游不变。
- **兼容与清理**：与已有 PC／第三方 attention patch 的冲突应明确处理；所有临时 attention 替换需 finally 恢复，不泄漏至下一步或另一个 MODEL。
- **UI 与持久化**：算法统一在 General Settings；算法专属参数的放置位置、保存方式尚未确定。不得为暂未实现的模式提供看似可运行的选项。

## 8. 工作暂停与下次启动位置

用户最新要求：先记录本次讨论，等待另一个对话修完 bug，再继续这里。当前只写此文档并加维护入口，不继续改代码或运行采样。

恢复后先读本记录、最新 `prompt_library_v4/DEVELOPMENT.md` 和 `HANDOFF.md`，核对另一对话的修改；保留并行改动。然后：

1. 复核 General Settings 的 couple/mask 切换、旧 workflow 值和编译联动，避免重复实现现有两个后端。
2. 锁定 Anima 的 Base／Fill、权重和时间映射，再选择一种编码／执行接口，形成可验证的最小接入。
3. 在临时 fixture 中验证真实 PC Schedule Prompt／LoRA 调度、condition hooks 与模型包装，不触碰正式或持久 8190。
4. 用合成／小型模型检查 attention 限制、生效时间、CFG、一次／两次整模型前向和 finally 恢复；真实模型画质／耗时另做明确验证，不能把 CPU 接口检查写成 GPU 实测。
5. 完成后记录确切版本、默认值、工作流接法与未覆盖范围。

不修改个人 Library／workflow／模型，不部署 fixture 到正式 ComfyUI，不 commit/push。用户另有明确授权时再按其范围执行。

## 9. 参考来源

- [Prompt Control 区域语法](https://github.com/asagi4/comfyui-prompt-control/blob/master/doc/regional_prompts.md)
- [Prompt Control Attention Couple 与 Anima MODEL patch 要求](https://github.com/asagi4/comfyui-prompt-control/blob/master/doc/attention_couple.md)
- [PC NODE 编码入口](https://github.com/asagi4/comfyui-prompt-control/blob/master/doc/node_function.md)
- [Sen-sou Anima 源码与参数](https://github.com/Sen-sou/Comfyui-Anima-Regional-Conditioning)
- [MoonNodes Anima 实现](https://github.com/m0rtus59/ComfyUI-MoonNodes/blob/main/py/nodes/anima_regional.py)
- [An1X3R 路由与兼容说明](https://github.com/An1X3R/ComfyUI-Anima-Regional/blob/main/docs/ADVANCED.md)
- [Omost 版 DenseDiffusion](https://github.com/huchenlei/ComfyUI_densediffusion/blob/main/densediffusion_node.py)
- [Impact RegionalSampler](https://github.com/ltdrdata/ComfyUI-Impact-Pack/blob/Main/modules/impact/special_samplers.py)
- [RAG FLUX 管线](https://github.com/NJU-PCALab/RAG-Diffusion/blob/main/RAG_pipeline_flux.py)

来源结论是源码／文档核对，不是同 seed 的实际画质或 GPU 性能比较。
