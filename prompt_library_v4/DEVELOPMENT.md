# PLv4 内部维护说明

阶段收束：Folder 池阶段 **2026-10-08**；LoRA / AVG / 原生输入和菜单后续 **2026-10-10**。用户确认当前工作完成，并要求更新内部文档、用户 README、GitHub 和正式 ComfyUI 安装。P1–P4 及后续试用修正已经落地；旧“本次不改 README / 不提交”的限制仅适用于此前开发轮次。本文件描述当前实现。

## 文档入口与优先级

- 用户手册：[中文](README_zh.md)、[English](README.md)。
- 需求记录：[plv4.md](../plv4.md) 末尾“新的block架构设定”及其后续明确更正，优先于早期 Class 方案。
- 实施记录：[plv4_plan.md](../plv4_plan.md)，P0 原型仅为历史设计依据，不是运行契约。
- 仓库维护规则：[AGENTS.md](../AGENTS.md)。本机 HANDOFF.md 是忽略提交的接续记录。
- PLv3 语言：[设计文档](../prompt_library_v3_design.md)、[手册](../prompt_library_v3/README.md)。V4 不另建语言或编译器。

当前运行模型只有 Tag、Block、Folder（池）。完整 Document 是独立保存入口，不是第四种 Library 树节点。Class 实体/属性页、attribute、belong/load、dummy、class instance、库间 block 指针、内部子 block 自动持久化和跨类型引用环检测均已删除。旧名称只允许出现在明确标注的需求历史或只读迁移代码中。

### 2026-10-09 后续：特殊容器创建和 entry 边界

- Header 不增加控件：原同级 / 子级按钮仍创建普通 Block；既有更多菜单用悬停二级菜单按同级 / 子级提供普通 Block 和 Schedule / Region / AVG 容器，Library 根不提供同级操作，区域祖先内不提供 Region 容器。
- `InsertBlock {form: schedule|region}` 原子创建默认容器。Schedule 两个空阶段 0–0.5 / 0.5–1；Region 四个空区域 Base / Mask 1 / Mask 2 / Fill，矩形默认左右半图。名称只在 metadata，创建后定位第一项正文，复用同一 history。
- `InsertEntry` 是新建空 entry 的独立命令，只接受特殊容器父级和显式 entry 参数，不接受 text / snapshot / form。普通及 Library 插入命令不能通过 entry 参数把外部内容转换到第一层。
- `MoveBlock` 的 entry 只能同父排序。Schedule 继续保留时间槽，Region 继续保留区域声明；原同父拖拽交互不改。外部 Block / Folder 副本只能进入 entry 正文；正文内普通 subblock 可移出。前端命中 / 预览与后端拒绝同时约束，Source 的 Library 拖入也禁止容器第一层。
- entry 不单独保存：更多菜单不显示 Save，保存入口提前拒绝；assets 原有快照校验仍保留。完整容器和正文普通 subblock 可保存。Content / Pool 的添加入口不绕过容器边界。
- Source 语言、普通 Block 的 Schedule / Region 属性、全局 fill 语义和个人数据不变；特殊容器入口与后续 LoRA / AVG 功能一并纳入 2026-10-10 收尾发布。
- Header 更多菜单的“添加同级 Block / 添加子 Block”悬停立即展开，移动到子菜单保持展开，切换分组关闭上一组；右侧空间不足向左打开，垂直位置约束在 viewport 内。ui.menu 的 tuple 第二项可为子菜单列表，普通 action / 分组 / 分隔线仍兼容；选叶子动作或点击外侧关闭整组，Escape 关闭并恢复触发按钮焦点，ArrowRight / Left 可进出子菜单。
- 正文聚焦时，Header 更多按钮在左键 pointerdown 保留输入焦点，click 打开菜单后再 blur 提交。否则 finishInline 的重绘会在按下和松开之间移除按钮，吞掉第一次 click。菜单回归必须用实际 pointer 按下 / 松开覆盖添加后的自动聚焦和未提交正文，不能先 blur 或只用 DOM `.click()`。

## 模块与路由

### 2026-10-10：原生输入、共享补全和窗口顺序

- `native_completion.js` 是 PLv3 `complete.js` 的文本模型适配，不另建 parser；复用 brace stack、Region slot 检查、Library snapshot 展开。V4 Schedule/Region snippet 使用当前 2/4 默认项，V3 snippet 不变。Run 在 blur 后投影结构；非法草稿不销毁输入宿主。外部文本 rebase 保留焦点书签，历史/加载仍按既有策略。
- Details 异步 Pool mount 遇到当前 session/owner 内聚焦字段，延至 blur；最新 token 和字段 listener 防止旧 mount 删除输入草稿。整块选择聚焦正文但保留块 selection；Shift 只隔离 Comfy 页面快捷键，不 preventDefault。TagAC 原生和 Monaco composition 不接管 IME Enter。
- Library `read('complete', all_folders=True)` 是只读所属 Folder 索引，独立于 enabled-only completion cache；前端只从开启 autocomplete 的 Folder 添加独立候选，同时向 D/G 匹配补充所有所属 Folder 的 L。D/G 展示字段优先，Library-only 使用 path，无合成 D/G 预览。多所属关系通过 L 选择目标，不插入文字。
- `js/lora_completion.js` 复用 TagAC native/Monaco adapter，调用 POST `/xyz/plv4/loras/complete` 只读文件索引，不读 sidecar/hash/触发词、不创建池；排除 shadowed 和不可表示名称。默认权重 1，名称替换保留已有 strength，5 秒查询缓存，版本/值/光标守卫拒绝迟到弹窗。
- `xyzAcSettings` 保留旧 enabled 作为 dataset 开关，新增 sourceCompletion / loraCompletion / libraryCompletion，默认开启；Source 的两个 Monaco provider 和原生 adapter 都遵守开关。关闭 LoRA 不发索引请求。设置保存清理补全弹层。
- theme `registerWindow` 统一 makeWindow / XYZ Settings 激活顺序，pointerdown capture 和 focusin 置顶；紧凑 z-index 保持窗口在菜单、预览和对话框下方。
- 实际 ComfyUI disposable fixture 覆盖正文/绑定/保存/Monaco 节点输入与 Delete、Settings 异步重绘、Source blur/非法恢复、Library 展开、D/G/L 合并与多 Folder 跳转、Shift 默认、LoRA 独立开关和三个窗口顺序。系统 IME 实际语言切换仍需用户本机验收。另通过现有 66 项 LoRA fixture 检查。8190 为长期用户实例，不用于自动写入测试。

### 2026-10-10：独立 LoRA 浏览器

- 设计与验收：[lora_browser_plan.md](../lora_browser_plan.md)。LoRA 是带 metadata 的 Block 子类型，不增加资产类型、Document 版本或 Library schema。
- `loras.py` / `lora_routes.py` 注册 POST `/xyz/plv4/loras/{list,detail,send,fetch}` 和 GET `image/{id}/{index}`。全部扫描、资料读取、hash、网络及图片定位在线程执行；只使用服务端索引 ID，图片验证真实路径在已配置根内。根和扩展来自 `folder_paths`，支持配置变化、搜索分页、损坏 sidecar、同相对路径优先顺序。媒体只读，外部图片限制 Civitai HTTPS 主机。
- 本地模型旁 `.metadata.json` / `.civitai.info` 和同 stem 图片优先；无 plugin 导入 / 事件 hook。显式按 SHA256 请求 Civitai 官方 `/api/v1/model-versions/by-hash`，资料缓存在库旁 `lora-metadata/`，浏览跳转固定 civitai.red。外部 API 说明见 [Civitai 官方文档入口](https://developer.civitai.com/site/reference)。LoRA Manager 的集中 sidecar / 私有图片目录不自动发现。
- `ensure_lora` 经既有 WriteQueue 原子创建带 `data.lora` 身份的 Folder 和初始触发词；只在首次编辑 / Send 时调用，已有池不恢复删掉的 tag。显式 `import_triggers` 才追加；改 Folder 设置保留身份。树投影 `lora_root` 隐藏普通 Library 中的入口，Pool 仍使用完整资产数据。Browser 的 FolderPage 复用现有编辑器及数据事务。
- `lora_triggers.py` 优先保留 Civitai / sidecar `trainedWords` 数组的作者条目边界，再用共享 PLv3 parser 解析内部 tag/attention；**不要求条目共享词**。多个条目中有复合提示词 / 多项 attention / 长描述时分别建 Folder；仅短原子 tag 数组仍平铺。顶层 `,,` 是兼容旧拼接资料的 fallback，literal / attention / angle token 内不拆。每套完整词和权重在兄弟子 Folder 中存储，局部去重，不传播其他条目到各组合。角色 heading / attention 首项用于默认名称，之后服装 cue / 编号；仅命名、不重写提示词。`data.lora_trigger_group` 模型 ID + 原组合规范词集 hash 保持身份，显式重复导入保留改名，自定义同名 Folder 数字后缀避让。详情逐条展示原 metadata，不再 join(', ') 破坏视觉边界。
- 默认 Send / 展开仍不改已有池。明确修正旧平铺池时 `ensure_lora.regroup_existing` 仅归类本层现存、仍与 metadata 匹配的 loose tag；删除 / 改写的原词不会恢复，已有生成组合的池跳过。既有 `add_tag` 向下归类保留 ID，重复词只在兄弟 Folder 复制。手动工具 `test/manual/plv4_regroup_lora_pools.py` 默认只读规划，--apply 必须指定不存在的 --snapshot JSON 文件，经运行实例 WriteQueue 写入，不读写模型 / 第三方 sidecar。
- `InsertLora` 默认根末尾、按模型 ID 复用已有实例，启用关闭祖先；`SetLoraStrength` 改真实首项引用。`meta.lora` 绑定 `relative` 和模型身份；首项 `meta.lora_invocation` 是固定调用，禁止单项开关 / 删除 / 正文编辑 / 分组，不收录到触发词池。Source 移除 / 改成其他调用解除特殊身份；Library 快照复制保留。Source 只有语法，独立复制不能携带专用身份。
- `lora_block.py` 对齐调用与 metadata；Blocks / Content / 折叠正文隐藏固定项，Details 专用权重栏默认展开。调用之外的实际 children 仍是原树，不为 UI 新增随机容器。
- `design_adapter.blockFrame` 根据已校验的 `meta.lora` 显示 LoRA 类型，复用 Schedule / Region 的 `.block-type` 标签与 special 卡片规则；LoRA 使用淡紫色 token 和顶层底色，不增加 header 操作按钮。身份标签与 Schedule / Region 属性标签可共存，折叠、关闭、Library 保存 Block 都沿用同一模板。
- Header 的 Folder icon / 同样式名称标签调用既有 openFolder，设置栏名称旁有独立打开按钮；LoRA 类型标签与设置按钮经 openLoraDetails 提交正文后打开对应模型。Header cache 纳入 Folder 名称 / 路径，Library reload 更新可见绑定；有绑定的节点在 Library 隐藏时也读取资产显示名称。LoRA 固定绑定放 LoRA 区，不提供通用绑定菜单 / 选择器；SetMetadata 拒绝更换和解除。Schedule / Region 容器 UI 与 SetMetadata 拒绝绑定；model.normalise_metadata 清理旧容器绑定，snapshot 校验 / bind_paths / observe 保持同一规则，保留 entry / 正文绑定、内容、ID 和关闭状态。无个人数据库批量迁移。
- V3 IR 增加 **默认关闭** 的 `centralize_loras`：Part 携带调用语法节点身份、引用文字和有效区间，在每一层的原随机决定中一起流转；按来源节点+区间去除 ambient 复制，保留不同语法节点的显式重复。只集中 `<lora:...>`，其他尖括号语法不动。特殊 Block 位置由 enabled Document / AST 配对提供，首调用不参加该 Block 的随机选择。Schedule 交集随 Part 保存，最后统一输出；没有文本也能输出纯 LoRA。
- V4 节点及被 V4 编辑的 V3 文档采用该策略；未编辑 V3 默认保持原输出。专用身份影响自身随机语义，所以执行缓存含特殊 Block 的源码位置；名称 / Pool 等其他 metadata 不影响执行。编译不读取模型目录 / Library / 浏览器缓存。
- `lora_browser.js` 独立窗口、卡片 Send、多图详情、节点选择及触发词 Folder。Send 捕获节点对象、graph 和 workflow epoch；串行并复查，避免异步期间 graph restore 重用对象写错 workflow。复用 NodeSessions / DocumentSession，一次插入一个 history。
- 详情里的触发词 Folder 使用默认折叠的原生 details/summary，首次展开才 ensure / 读取池；折叠保留 FolderPage 与设置历史，切换模型 / 重开详情通过 token 丢弃旧加载。导入入口在展开区内，复用原 Page 保持设置撤销。FolderPage 可选 onFolderRender hook 为浏览器排列两行控件：名称独立一行，补全与撤销/重做同一行，编辑重绘后仍保留布局与历史。仅浏览器覆盖 padding / 行高，不改变主 Library 布局。
- 验证：t80 模型 / 元数据 / 路径 / pool / compiler / snapshot，t72 新 Node suite 覆盖卡片 Send / 并发 / 节点失效。`test/manual/plv4_lora_fixture.py` 只创建临时库和合成模型，`plv4_lora_browser_check.cjs` 使用独立 headless Chrome，实际 DOM 和真实 API 覆盖 20 项；不操作 ComfyUI 进程或个人数据。外部 Civitai 联网和实际采样仍未实测。
- 最终完整离线回归：**855 passed / 3 skipped**（缺 torch / PyAV），之后默认节点选择由新 Node suite **7 passed** 复核；9 个修改的 ESM 语法检查和 `git diff --check` 通过。测试窗口和临时服务已关闭。
- 后续 Folder / LoRA 导航与绑定规则验收：完整离线 **872 passed / 3 skipped**（同上依赖），独立真实浏览器 **54 项**覆盖按钮跳转、同一 Folder 标签页、固定绑定、容器隐藏入口、entry 独立绑定、改名刷新及缺失 Folder。六个修改 ESM 语法通过；运行实例通过 stateless document API 复核容器与 LoRA 绑定拒绝，不改 workflow 或 Library 数据。
- 同日 settings 调整：blockHTML 将类型标签与属性标签分开，类型前置、Schedule / Region 参数跟在名称后。容器 Details 仅保留 Enable / Weight 等结构设置，隐藏 Shuffle / Format / RANDOM；SetSettings 拒绝容器新写上述选项，允许 null 清理，已有 Source 的语言 / 编译语义不变。Format 与随机仍沿用 PLv3 的 direct-children Part 语义；没有修改 IR。randomSelect 两个 number 控件校验非负安全整数及 a≤b，半填 / 非法范围不提交，两框空为 null、0/0 保留。dropout 原生 range 的 input 仅更新读数，change 写一次 history。ui.input 对 range 使用数字、min/max/step，并在设置范围后赋 value，避免原生默认 step=1 抹掉小数。完整离线 **880 passed / 3 skipped**，实际浏览器 **66 项**通过。

| 模块 | 当前职责 |
|---|---|
| model.py / commands.py | EditorState、Document v2、稳定 ID、projection、revision 校验及原位命令 |
| formatting.py | 新结构的局部格式化，普通编辑和开关不能触发全文排版 |
| _v3.py / compiler.py / node.py | 复用 PLv3 解析/编译，V4 节点 seed 策略与 prompt/plain |
| assets.py / hierarchy.py | SQLite 资产、快照、路径、名称唯一、版本冲突、pool observation、收录和祖先链去重 |
| setup.py / asset_routes.py | 独立库生命周期、Library 适配；阻塞操作移到线程 |
| migrate_v3.py / migrate_v4.py | V3 备份导入、旧实验 V4 新副本转换 |
| js/plv4/document_session.js | 串行命令、同一撤销历史、旧异步写入失效 |
| host_sessions.js / prompt_editor_binding.js | 节点对象身份、Library 会话、隐藏 doc 与共享 Monaco 模型 |
| window.js / history_shortcuts.js | 标签/视图、输入提交、跨视图历史与 workflow undo 隔离 |
| block_view.js / text_input.js / prompt_text.js | native TextRun、DOM 读值/选区、语法展示与 UTF-16 映射 |
| block_find.js / js/plv3/text_editing.js | 可见 prompt 搜索范围、借用 Monaco Find、跳转与高亮 |
| details.js / folder_page.js / library_panel.js | Content/Pool、Folder tag 编辑、Library 树/副本操作 |
| folder_tree.js / library_preview.js / drop_preview.js | 空目录链压缩、紧凑预览、层级明确的插入预览 |
| design.css / design_components.js / design_adapter.js | 共用正式样式/控件，Node 与 Library Block 同一界面 |
| completion.js / inline_input.js / js/tagac_host.js | Folder 候选补全、native 与 Monaco 共用 TagAC |

文档路由都是 POST：`/xyz/plv4/document/open`、`command`、`compile`。请求携带完整 state，命令携带 revision；服务端不持有浏览器撤销栈。非法请求与语法错误返回明确错误，过期 revision 拒绝应用。

Library 路由为 POST `/xyz/plv4/library/read`、`mutate`、`migrate`；读 action 包括 tree、expand、candidates、complete，写操作包含 folder/tag/block/document 保存、移动/删除、观察/收录及副本保存。所有数据库写入经 WriteQueue 单写者，同一事务校验名称、层级、散装 tag 和快照；失败不留下半次收录或移动。

## Document 和编译边界

1. Document 是真相。Document v2 继续兼容 v1，保存每项 ID、enabled、结构及元数据。Source 是 enabled 投影；关闭项原位保留，不能从 Source 缺席推断为应删除。
2. 非法草稿原文保留，strict 节点执行必须报错，不能退回旧树运行。恢复模式仅供编辑诊断。
3. pool、来源和展示名称随 Document 保存，不参与语法编译。LoRA block 身份用于保护调用的随机语义，真实引用和强度仍在语法里。Library 不存在时已有 workflow 仍能编译。
4. V4 全部随机使用已解析的节点 seed，忽略组 seed。V3 未改动文档保留默认组 seed；经 V4 编辑且带 compiler=plv4 元数据的 V3 节点使用 V4 策略。
5. prompt/plain 仍调用同一个 PLv3 编译器。Region ambient/include_in_base、mask/couple、Schedule 区间及 dropout → random_select → shuffle 顺序保持。V4 LoRA 引用集中输出并去除区域复制，专用 Block 首调用保留；普通 V3 的默认行为不变。
6. 不为了 UI 占位增加 Group，避免改变随机单位。移动/分组后以新语法树为编译基准，不保证等于操作前随机结果。
7. Region 子项头和 Schedule 共享边界不全在普通 node span 内，沿用已有 span/命令处理，不能只切 body。
8. Preview 解析链接 seed 时共享 graphToPrompt promise，callback 用 resolvingInputs 阻止递归。后端计算型输入无法离线解析时明确报告，不能猜 seed。

## Folder 池和副本

一个 Block 最多有一个 `meta.pool`，子项不继承候选列表。Folder 内为散装 tag、保存 Block 和子 Folder；嵌入 subblock 是 owning snapshot 内的真实子树，不是独立指针。稳定来源 ID 与版本用于显式更新/覆盖，完整路径用于展示和 Source 标签。

同一父 Folder 的 Folder/Block，以及同一 Block 的 subblock，名称唯一；不同父级允许同名。新增、重命名、移动和保存冲突均拒绝并回滚。未命名 subblock 保存时获唯一默认名；迁移中的显式消歧保留原内容和 ID。不能靠首次路径匹配掩盖重名。

自动收录只收 tag，且只增不减。在完成输入后提交，写到绑定本层；递归经过未绑定子 Block，遇到自有 pool 的子 Block 停止。查重扫描整棵绑定子树，含保存 Block 内关闭 tag。打开 workflow、载入 Document、Undo/Redo 只建立 observation 基线，不恢复用户手工删掉的池 tag。

散装 tag 的相同祖先链不能重复：添加到子 Folder 时从祖先移下；子孙已有时父 Folder 添加拒绝；不同分支可重复；保存 Block 内容不受此约束。Folder 移动造成祖先链冲突时事务拒绝，非空删除保持保守拒绝。Library tag 身份是原子文本身份，不与候选展示匹配混为一谈。

Content/Pool 分离是最终方案，早期合并单区设计作废：

- Content 始终按实际顺序递归编辑，关闭项原位灰显，× 仅删当前副本。
- Pool 的 ＋ 追加到 Content 末尾；已有项一直标记“已添加”，关闭也算，不重新启用、不移动、不切换详情对象。
- prompt 候选匹配忽略外层 Weight/Schedule，并按展示统一空格/下划线；Block 按来源 ID 匹配。扫描未绑定子树，遇到其他池绑定停止。这只是加入状态和防重复，不改变库的 tag 去重。
- 保存 Block 候选后代仅可折叠只读预览；加入后从 Content 编辑。poolPending 串行提交 ＋，在提交时重读 projection，防连续点击同文候选产生重复。
- 类型筛选与未使用筛选独立；全部展开/折叠、滚动和筛选按文档/目标保留。
- 子 Folder ＋ subblock：绑定该层，填充本层散装 tag，默认 enabled，不自动保存。Folder 插入 handle 则创建空的绑定 Block；不再拖入直接改目标绑定。
- Folder 灰色目录，Block 立方体/蓝色框，Prompt 标签/轻量竖排；加入状态统一绿色侧标与徽标，不区分已添加项的启停。

## 窗口、输入和搜索的易错点

### 2026-10-10：Blocks 逗号、回车与空行删除

- 正文使用浏览器 `contenteditable="plaintext-only"`。不要重新加入 Enter / Backspace / Delete 的 `beforeinput` 拦截、人工选区回设或 input 后的 DOM 占位修补；这些逻辑在逗号分隔处与带样式的粘贴正文中会干扰浏览器的光标归属。曾经的 136 / 198 项检查漏掉了逗号后、分隔空格后与空行删除，不能作为该问题已解决的证据。
- 空拖放 marker 在聚焦和失焦时都不参与排版，否则非编辑 span 会将分隔符两侧变成两个浏览器编辑区域，产生额外换行。DropPreview 暂时恢复 marker 排版，结束时恢复编辑状态；关闭的 prompt 仍保留原位、排除在源码和光标映射外。
- Chromium 在最终空行后维护一个显示用换行；`text_input.js` 的值和偏移映射排除它，初始 render 用相同的纯文本终止符，不插入人工 BR。用户键入时只读取 DOM、排队更新 Document，不改变选区或 DOM。renderInlineEnd 只用于初次显示。
- `runEnd` 保留尾部逗号和空白，只去掉闭括号的一条结构布局换行。TagAC 仅允许当前宿主消费 Enter，同 DOM 更换 RunSession 时丢弃旧候选。无效的 Pool 候选静默拒绝并放行 Enter，不再弹出“请在一条完整 prompt 上使用 池补全”。有效补全仍走 CompleteLibrary 与共享历史。
- `plv4_separator_browser_check.cjs` 使用独立 Chrome + 真实后端，检查文字、逻辑偏移、红色 caret 截图及续写，覆盖 `1girl, 2girls` 逗号后 / 空格后、行中文字、用户截图形状、连续空行、重开后的单次 Backspace、向前 Delete、粘贴尾部换行、Undo / Redo 和三种容器 entry。`PLV4_REPRO_ONLY=1 PLV4_SCREENSHOT_REPRO=1 PLV4_PASTE_REPRO=1` 可跑截图和粘贴定向检查；真实 Comfy fixture 准备和启动使用相同 PLV4_FIXTURE_ROOT。仅使用 disposable fixture，不操作持久 8190 的 Library / workflow。
- 临时 input_trace 已完全移除，诊断服务和输入记录已清理，不要求用户再配合捕获。浏览器验证记录及运行实例同步见本地 HANDOFF。
- 空正文与已解析 TextRun 共享 13px 字号、正文色、行高和 padding；只让空输入的 placeholder 灰显。不要用 :focus 改变 marker 的 display，否则每次聚焦都会改变正文缩进和 tag 之间的距离。`plv4_input_layout_browser_check.cjs` 测量第一次键入、blur 重绘以及反复聚焦前后的每个可见字符几何与实际字体 / 颜色，允许小于 0.1px 的浏览器字形舍入差异。

Library 仅显示 Folder/Block/subblock，散装 tag 隐藏于树但搜索可定位其 Folder。Folder 页只编辑本层和子 Folder 的散装 tag，不显示保存/绑定 Block 列表。Library Block 复用 Node 的完整 Blocks 编辑器，中性主题；预览为连续逗号文本、自动换行、限制高度，不为每项显示路径。

单击 Folder/Block 共用一个临时斜体标签；编辑、双击条目或标签固定。切换请求串行并先 flush；不能将未提交草稿替换掉。浏览、定位和视图切换不固定。保留树行/标签 DOM，否则重绘会吞掉双击。

Library/Pool 的空单子 Folder 链压缩只看实际数据：本层有任何 tag/Block 都阻止合并，不能用过滤后可见项判空。只改展示，不改 ID/路径/绑定；各段名称可操作，handle/预览及子 Block 按钮作用于末端 Folder。树行用连续祖先引导线，不只留空白缩进。

连续文本段共用 native RunSession。装饰 marker 必须 contenteditable=false，DOM 文本/选区映射排除装饰。用 break-spaces 保留空格；中文逗号仅在用户输入提交时清理，保护 literal、LoRA、路径和 .set，随后由 PLv3 解析拆条。首尾逗号不存入原子 tag，句号分隔保留句号。禁止打开库自动清洗历史数据。

尾部原生显示换行不计入正文/光标；runEnd 只去掉一条结构性闭括号布局换行，不吞用户尾部换行。Enter、Backspace、Delete 均由浏览器原生编辑，不手动改正文或选区；粘贴只接收纯文本。SetEnabled 不允许根据 _layout_indent 触发整段格式化，必须保留空行。queued write 在父队列内再次检查有效性；Undo/dispose 使旧任务失效，flush 排空字段队列。

Blocks 借用原 PromptEditor 的 Monaco Find controller/widget，不创建第二个编辑器。借用时 removeOverlayWidget 解除 Source 登记，退出时重新登记/布局，防 Source 重建把搜索框收走。Source 零宽会附 hiddenEditor；CSS 仅覆盖可见 Blocks 搜索宿主。Monaco 是 vendored 0.52.2，私有 contribution 接口升级须复核。

block_find 仅建立可见 prompt 字符的逐行源码范围；不包含 Region/Schedule 声明、.set 或其他隐藏字段。多行范围会被 Monaco 扩为整行，必须分行。空范围用零长度 sentinel，不能传 []（会成为全文搜索）。更新、聚焦和范围变更都强制同步；离开 Blocks 恢复 Source 原范围并隐藏借用时的范围开关。

查询框 Enter/Shift+Enter 调用与下/上箭头完全相同的 Monaco editor action。CSS Custom Highlight 把 source match 映射回 native Range，搜索框保持焦点时结果仍可见；无支持时回退 native selection。零结果、关闭、dispose、标签/视图切换均清理高亮。用户提供的 Region/Schedule 原稿搜 cl，Blocks 有 3 个 prompt 命中，不能计入 include_in_base。

所有详情权重含 Region mask/cond 都用 − / 输入 / ＋，步长 .05。Region 父级列出每个 Region 子项设置；Region/Schedule 区默认展开，尊重后续手动折叠。开关、编辑、加入后保留设置对象和滚动位置。

## 迁移与样例

### V3 导入

Library 菜单显式确认后调用 migrate_v3.migrate。只读原库，SQLite backup 包含已提交 WAL，备份存到目标库旁 backups。来源路径和备份摘要防重复：同一快照重复导入返回已有报告；已导入来源变动拒绝继续混入，需新库副本核对。

| 旧模型 | 当前映射 |
|---|---|
| group | Folder |
| 子 group/ref | 真实包含的子 Folder |
| 原子 items | 本层散装 tag |
| preset | Folder 下保存的完整 Block |
| preset 内 ref/snapshot | 展开的包含副本 |
| group 自身 settings | 额外“全部内容”Block；无设置不制造默认 Block |
| saved documents | 独立完整 Document，含关闭项 |

导入内置 seed 42、couple/mask × plain 的编译核对，使用 V4 节点 seed 策略。migrate_v3 是库/API，不提供独立模块 CLI。

### 早期实验 V4 副本转换

`python -m prompt_library_v4.migrate_v4 SOURCE TARGET`；TARGET 必须不存在且不同于 SOURCE。源库只读，默认运行新库是 prompt_library_v4_data/plv4-pools.db，旧 plv4.db 从不隐式升级。

Folder/Class → Folder；string attribute → tag；block attribute / 内部指针 → 包含快照；Class attribute → 真正子 Folder；belong → 单个 pool；多个 load → 各绑池的临时子 Block。仅转换器识别旧术语，不恢复运行模型。多个 load 拆成子 Block 会改变旧随机树单位，不能宣称对任意旧文档随机等价，需按具体副本核对。

### 隔离示例

test/manual/seed_xyz_test_samples.py 只转换独立测试根目录的库/workflow，新副本和报告不覆盖原件。update_xyz_pool_examples.py 拒绝其他 root，先备份转换后库、workflow/manifest 到 pool-example-backups，再修整重名并追加池绑定示例；保留 ID、关闭项和用户修改，来源按 ID 更新。当前示例包含父池、独立绑定/未绑定子 Block 和关闭项。prepare_xyz_test_comfy.py 的 tag 数据备份保留 WAL，不替换已有非空测试库。

旧 Class-era manual browser scripts 和原型仅作本地历史保留，不是当前验收入口。不得用其重建示例。个人 V2/V3/V4 库均未迁移；本次收束没有运行迁移或改写样例原件。

## 验证与后续边界

### 2026-10-10 收尾与正式安装

用户确认 LoRA / AVG 和正文、样式、菜单后续修复完成；本轮更新 README、工程记录并随代码发布。后续按新发现的具体 bug 修复，不另起设计阶段。

- 最新全量离线回归：**909 passed / 3 skipped in 46.23s**。跳过原因是开发解释器缺 torch / PyAV；用 ComfyUI 自带 Python 补跑 t69 量化兼容 **2 passed**。
- 同一 ComfyUI Python 通过实际 Prompt Control 解析 / 编码和 ConditioningAverage 检查 AVG 比例、pooled、时间 / 区域 / LoRA 组合；使用合成 CLIP，不加载个人模型或采样。
- 最新菜单 disposable 真实 ComfyUI **25 项**通过，包含实际鼠标按下 / 松开、自动聚焦的新 Block、正文未提交时单击另一个 More，以及保存完成。此前同版本输入定向 **46 项**、样式 **40 项**、AVG 浏览器 **36 项**的结果见各回归说明；这些是独立用例，不是一个累计浏览器总数。
- 正式 ComfyUI 使用已有 `ComfyUI/custom_nodes/ComfyUI-XYZNodes` 仓库，正常 GPU / 模型 / 其他 custom nodes 配置；不使用 fixture、测试 base-directory 或 XYZNodes-only whitelist。正式 `8188/object_info` 已注册 V4 / Monaco 和 Prompt Control，**27 个**修改或新增的前端文件实际 HTTP 响应与安装源码 SHA256 一致；stateless open / compile 在 couple / mask 均可编译 AVG + LoRA，LoRA complete 路由只读检查通过。
- README 中英文、AGENTS、实施计划与 manual 测试入口统一更新。个人库不迁移、不用测试数据库覆盖正式库、不创建合成 workflow；持久 8190 验收实例保留。版本更新后重启正式 ComfyUI，浏览器 Ctrl+F5 加载前端。
- GitHub 常规代码更新使用主分支提交 / 推送。不要创建没有 TagDB 数据资产的新 latest release；不要发布本地原型、历史 Class-era 脚本或运行数据。

### 2026-10-08 Folder 池阶段记录

2026-10-08 收束离线回归：**513 pytest passed**，包含 t70–t79、10 个 Node 前端套件、t46–t62 的 PLv3 测试、t68 窗口兼容和 TagDB；ComfyUI Python 的 t69 CPU unittest **2 passed**。t69 直接核对虚拟 scale 解析，兼容不同 ComfyUI state_dict 是否枚举 sidecar。最新搜索/换行由真实 Python projection、Node 模拟宿主和 vendored Monaco 语义覆盖。38 个 Python、44 个 ESM 文件语法检查通过；维护/用户文档的本地链接逐项检查。

~~~powershell
python -m pytest test/t70_plv4_document_test.py test/t71_plv4_routes_test.py test/t72_plv4_frontend_test.py test/t73_plv4_node_test.py test/t74_plv4_assets_test.py test/t75_plv4_migration_test.py test/t76_plv4_asset_routes_test.py test/t77_plv4_hierarchy_test.py test/t78_plv4_test_tag_data_test.py test/t79_plv4_pool_examples_test.py -q
Get-Content -Raw js/plv4/window.js | node --input-type=module --check
# t69 需要真实 ComfyUI/torch 的 Python；不要求安装 pytest：
python -m unittest discover -s test -p t69_quantized_hook_compat_test.py -v
~~~

pytest.ini 限定离线 test/t*_test.py；manual 和网络诊断不属该范围。2026-10-08 收束采用离线检查；当前原生输入、样式与菜单已有 disposable 浏览器验证，见下方最新收尾记录。

用户已确认本阶段结束。未来工作仍须按具体请求处理：大文档浏览器性能、个人资料库副本迁移、旧多 load 随机结构取舍，以及更广泛的 tag 身份规范化。现有精确 tag 身份不在本轮扩展。

GitHub release 的 latest 由 TagDB 数据集下载使用；常规代码发布通过 Git 提交/推送，不创建缺少数据资产的 release。避免破坏自动下载。


## 2026-10-10：AVG Block

新增共享 Source 语法 `[@avg]: { 1: { ... }, 3: { ... } }`，Group.average / Settings.avg_weight / Spans.avg_form 保留真实头权重。Document v2 追加 avg / avg_entry form，不升级 schema；Builder / full_index / projection 把 entry 头计入自身 span，SetAvgWeight 精确替换字段并保留关闭项 / ID。More 和共享 Native / Monaco Source 补全提供两个等权空 entry。统一 badge 样式，名称后显示 Weight；容器无正文 / Pool / Random / Format，entry 无 Random / Format，不可拖拽（含内排序）或独立保存，正文可收普通 / Library subblock。父 AVG settings 可改各 entry 权重，整容器 Library 快照保留结构。

IR Part.variants 让 AVG 始终作为一个 direct child；普通 join / format / emphasis 在全量分支上运行，直到 segment 才生成累积比例 AVG 链。多个 / 嵌套混合组合局部概率，去重相同完整文字；每个区域 / 时间段最多 256 个替代。0 / disabled 忽略，enabled empty 参与，全零只保留外部内容。仅含 AVG 的文档按有效时间段渲染并重新归一化 active entry，AVG 留在一个 COUPLE / AND 操作数内。Region 在 AVG 内按有效区域并集、同 mask 合并；缺该区域的 entry 贡献 ambient。random_plan 在完整树各 segment 和潜在 implicit base 预先冻结源 child 身份，保证时间切换不重抽，尤其 timed region 消失后不能误把未规划 base 当空选择。无 AVG 文档仍走原路径。

LoRA 在 AVG 文档中也统一 provenance 去重、合并连续有效区间；保留两个显式同名调用，不复制 ambient 引用。AVG weight 仅混合 conditioning，不乘 Model / CLIP strength，不提供每分支独立模型 patch。实测本机 Prompt Control utils.safe_float 将 AVG 系数 round(...,2)：三等分累积 2/3 实际 .67，不能声称最终等权精确；未改 upstream。AVG 提示词 / pooled tensors 已用真实 ConditioningAverage 验证。

验证：全量离线 909 passed / 3 skipped（开发解释器缺 torch / PyAV），末次补充 implicit-base 边界的 t81 + t48 / t49 72 passed。独立临时 LoRA fixture / own browser session 的 23 项通过，含创建 / 权重 / undo redo / 全部 entry 边界 / 整容器 Library / 原生 Source blur，无浏览器错误，并查看实际 screenshot 对齐。ComfyUI Python 跑 test/manual/plv4_avg_promptcontrol_check.py，真实 PC schedule / region / encode 管线 + 合成微型 CLIP 验证 N-way AVG、pooled、schedule / region / LoRA 和每区域一个平均 conditioning；不载模型 / 不采样。9 生产 ESM syntax / diff --check 通过。

同日补齐 Blocks 底部创建入口：主按钮直接添加普通 Block，▾ 菜单提供普通 / Region / Schedule / AVG，空文档一致；聚焦特殊容器只添加 entry，Region entry 内排除 Region，Library wrapper 目标仍为内部唯一保存 Block。沿用 canInsertContainer / host.addBlock 和 4 / 2 / 2 默认 entry。扩充 disposable AVG 浏览器检查至 36 项，t72 的 12 个前端套件通过，ESM syntax / diff --check 通过。仅同步 block_view.js / design.css 到现有 8190，并核验实际静态响应，未重启或写入个人数据。
