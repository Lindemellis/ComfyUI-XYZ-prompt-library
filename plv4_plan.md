# PLv4 分析与实施计划

依据：plv4.md 最终 Folder 池设定及后续明确更正、现有 PLv3 文档/解析器/IR/编译器和共享编辑器。2026-10-08 用户确认本阶段结束，并授权同步内部文档、面向用户 README、Git 与 GitHub；P1–P4 已实现。最新契约与离线验证见 prompt_library_v4/DEVELOPMENT.md，本机接续见 HANDOFF.md。旧原型与早期 Class 方案仅历史保留，不作为并行设计。

当前实现要点：标签为 Blocks / Source / Preview；Blocks 连续文本段共用一个 native 输入宿主，复用 Source 的菜单、Find/Replace 与文档历史。单条设置直接显示 Weight/Schedule，取消 + setting、单条 Region 和详情 Danbooru 眼睛按钮；attention/interval 以通常语法显示，新增 `{}` 仅局部格式化。三处 TagAC 共用开关/弹窗及就绪等待，8190 测试实例已补实际 tag 数据；Blocks 不再显示 Source 分隔符里的结构缩进。最近修复只做离线检查，不引用旧浏览器数量作为当前验证。

## 1. 结论与边界

普通 block 嵌套已实现；PLv3 的 Group、Document.children 和递归编译已有基础。混合文本/子 block 按真实顺序编辑；大文档浏览器性能仍需后续专门测量。

嵌套交互原型、数据及 UI 重构均已完成本阶段实施。编译规则继续以 PLv3 为准，尤其保留 region、schedule、随机及分隔符规则。

“三层等价”应解释为运行语义一致，而不是三个格式之间都能无损逆转换：

- Document 保存完整树、关闭内容、稳定 ID、资料库来源及 pool 绑定。
- Block UI 和 PLv3 文本页是同一个 Document 的两个编辑视图。
- 输出预览是 Document 经当前 seed、region_mode 编译的结果，不反向编辑。
- 普通 PLv3 文本不能保存关闭内容或尚未编码进语法的 pool 绑定。完整保存/导出必须携带 Document。

## 2. 当前嵌套视觉与编辑方案

用户补充的核心约束：主界面是 ComfyUI 画布上的 floating window，而非全屏应用。以约 960×640 的窗口为首要布局场景，再验证 720×500、1100×720；响应式依据窗口内容宽度，而不是浏览器视口宽度。保留拖动、缩放及可收起的 Library/详情面板。两侧面板为外侧附加列：打开时扩展窗口，关闭时收回宽度，空间足够时保留中间编辑区宽度及位置；窄窗口也不改成覆盖中间内容的抽屉。 Library / Text editor 和 Text editor / Details 之间分别提供全高拖拽分隔柄，调整相邻栏宽且保持浮动窗口位置及总宽；两侧栏设最小宽度，编辑区保留可用宽度，栏宽本地记忆。面板开合时保留已选宽度，窗口缩小时适配可用空间。

正式界面使用固定 block Header：最左放较大的折叠按钮，随后显示名称（如有）、Schedule / Region 特殊类型和开关。Header 直接显示 Enable、详细设置、新增同级 / 子 block 和“更多操作”；Save、Delete、绑定池 放在“更多操作”中，绑定池也出现在详情设置栏。Schedule / Region 仅显示类型标记，Shuffle、随机、Schedule、Region 的功能设置留在详情面板。Header 下方整条左侧边缘作为拖拽 handle，悬停发光；不再使用右侧浮动工具栏。文本与子 block 保留横线和背景色区分，嵌套边缘间距约 7 px。点击 block 空白处打开所属层级详情。PLv3 模式继续复用现有 PromptEditor/Monaco，已接入正式 ComfyUI 窗口。

采用紧凑树形 notebook：顶层 block 有轻边框，子 block 用少量缩进、左侧层级线、横向分隔线与不同背景色共同表达归属，避免每层再套完整卡片及宽工具栏。

示意：

```text
[⌄ 人物               ⏻ ⚙ ＋ ↳ ⋯]
│ 1girl, solo, green eyes
│ [⌄ 服饰             ⏻ ⚙ ＋ ↳ ⋯]
│ │ white shirt, silk ribbon
│ │ [⌄ 配饰           ⏻ ⚙ ＋ ↳ ⋯]
│ │ │ silver necklace
│ looking at viewer
```

竖线表示 Header 下方的整条拖拽边缘；鼠标进入时发光。

- 数据保持任意合法深度，沿用解析器现有 MAX_DEPTH=64 的边界。
- 当前每层边缘间距约 7 px；深层可用聚焦子树和面包屑展开，避免无限缩窄文本宽度。不另行限制数据深度。
- Header 下方左侧保留 6 px 的完整高度拖拽边缘，悬停发光；名称、折叠和开关放在 Header。
- 文本区域按内容增高，单行内容区至少 36 px，明显高于 23 px Header；正文保持 13 px 字号和上下间距，不产生每个 block 自己的滚动条。
- 无内容的 block 至少保留一个可定位、可输入的空行。
- 折叠后显示一行内容摘要和必要的设置标识。
- 点击文本时编辑该文本所属的最内层 block；点击 block 空白处直接打开所属层级的详情，不向父级错误冒泡。
- 每个 block 固定 Header：大折叠按钮、名称、特殊类型、Enable、设置、直接显示的新增按钮和更多操作菜单。Header 高 23 px，按钮单行显示，文本始终排在 Header 下方。
- 父 block 关闭时，后代有效状态随之关闭，但不改写后代自己的 enabled 值；再次打开父级会恢复原状态。关闭父级时，后代开关不可操作，符合候选 block 的要求。
- Setting 的启用开关只改变 enabled 投影，不因旧 `_layout_indent` 标记重新排版；保存的分隔符及手动换行保留，重新启用恢复原稿。必要的 bare Region / Schedule entry 括号仍按既有解析要求处理。
- 选中子 block 时用一条明显的选中线和详情面板单行名称标识它；各级 Header 和左侧拖拽边缘拥有独立点击区域，父子不误触。

详情顶部只保留单行名称和关闭按钮；Format 与输入框同一行，prompt / subblock 行末有删除按钮。普通 block 详情显示可递归编辑的 Content，绑定单个 Folder 后另显示只用于添加的 Pool。Schedule 共用边界、Region 的类型/IMASK/矩形/feather/weight/include in base 沿用现有控件。

Setting 所有权重（block、prompt / LoRA、Region mask_weight / cond_weight，含子区域）统一为 − / 数值输入 / ＋，按钮每次增减 0.05；保留直接输入、重置及原范围，不把长度、索引、概率字段当作权重。

Library block 与 node 继续复用同一套 Block UI、Monaco、设置和中性主题；Library 只允许一个根 block，子级是真实包含的内容。点击 block 默认打开完整 Blocks 界面并显示可编辑的 subblock。Folder 页只显示本层散装 tag 和可折叠子 Folder/tag，使用紧凑行，不显示保存 block 列表、重复空内容分区或大卡片；保存 block 从 Library 树打开。补全开关保留。

关键是顺序：一个 block 的内容必须是有序的“文本段 / 子 block / 文本段 / …”，不能实现为“一整个文本编辑器 + 后附的子 block 列表”。后一种方式不能表示 `{a, {b}, c}` 的原始位置关系。

连续的普通 prompt 可以合并成一段可编辑的 TextRun；TextRun 是视图对象，不自动添加 `{}`。UI 占位 block 也不能悄悄制造新 Group，否则会改变父级随机选择单位和随机树路径。

原生 Enter / Shift+Enter 在连续输入宿主中插入文本换行，不生成新的 prompt / 装饰段落；末尾空行在编辑与重开时保留，并参加同一 Document 的保存与撤销。结构关闭括号的一行布局不作为用户空行展示，中间分隔符的既有缩进投影保持不变。

Backspace / Delete 删除真实换行和选中的空行，末尾显示占位不参与文本或阻止删除；复用现有输入提交和历史。Blocks 的 Ctrl+F/H 借用同一个 Monaco Find controller/widget，同时转移 overlay 挂载登记，避免 Source 重建时把搜索框带走；退出 Blocks / 标签时归还登记和布局。

搜索框在 Blocks 中的可见性由当前宿主决定，不沿用 Source 零宽时的 `hiddenEditor` 隐藏规则；显示匹配选区时保持 Find / Replace 输入焦点及光标。

Blocks Find 限定于 prompt 正文的 Source 映射区间，不把只在 Source 中出现的 header / Region / Schedule 设置计为结果；范围跟随文档更新，退出时归还 Source 原范围。查询框 Enter / Shift+Enter 跳转到下一处 / 上一处，不输入新行。匹配、计数与替换沿用原 Monaco controller。

Enter / Shift+Enter 调用搜索框箭头使用的同一个 editor action；Block 匹配 Range 使用独立 CSS 高亮，查询框保持焦点 / 选区时仍可见。无结果、关闭或离开搜索视图时清除高亮。

PLv3 当前编辑器是 Monaco，提供语法高亮、补全和快捷调权重，而不是 HTML 粗体/斜体编辑器。正式实现应复用这些能力；实验 HTML 的 contenteditable 不作为提示词语义来源。

当前连续文本使用 native TextRun，并通过统一 Document 命令回写；Source 复用同一个 PromptEditor。不要为每个递归节点常驻一个完整 Monaco，亦不要在父级编辑器 DOM 内直接再塞子编辑器。

## 3. 特殊 block

### Schedule

- 普通 `.set{schedule}` block 显示紧凑时间范围标识，详细控制在右侧。
- `[@schedule]` 容器显示时间轴及按顺序排列的 entries。
- 点击 Schedule / Region block 时，Setting 对应的 Schedule entries / boundary、Region / Region entries 默认展开；用户手动折叠的同一 block 区域保留状态，设置修改重绘不强制打开。
- 共用边界是一个控制点，调整时同时更新左右两段，不独立维护两个冲突的数值。
- 嵌套 schedule 保留现有区间求交语义。
- schedule 容器的新增/删除/排序必须专门处理边界；不能直接复用普通 block 插入行为而遗漏时间头。

### Region

- `[@region]` 容器的子项标明 base / mask / imask / fill；`.set{region}` 的普通组也使用相同的 region 控件。
- 点击 Region 容器时，Setting 的 Region entries 默认展开，按实际顺序列出每个子区域的可折叠设置组；显示名称 / 顺序编号及类型，直接复用 `regionFields` 编辑 Kind、IMASK / Rectangle、feather、mask_weight、cond_weight、Include base，按下述类型规则隐藏无关字段。各组只向自身 entry ID 发 `SetRegion`，修改不跳转详情对象，保留父级滚动与各组折叠；保留开关、删除及显式跳转子区域详情。关闭自身仍可配置，关闭父 Region 时禁用子项编辑。不改 Region 编译、声明位置或命令语义。
- 可在 region 内嵌普通 block；region 内再嵌 region 仍是 E01，不因 UI 能套 block 就放开。
- 保留 ambient text 注入所有 region、include_in_base 仅额外复制到 base，以及同 key region 合并等现有规则。
- base 覆盖全图；mask_weight 是空间份额，cond_weight 是语义强度。
- fill 无 mask_weight；mask/imask 才有 feather；base 无 include_in_base 控件。
- imask 索引是 CLIP attach 顺序，不是 Mask Editor 输出 slot。
- COUPLE 模式中 fill 占 prompt-control 的 base slot，PLv3 base 作为 COUPLE 段；MASK 模式中 fill 是全图扣除其他 mask 的补集，继续使用现有后端。
- 裁切、关闭、删除或移动必须连同 region / schedule 的头一起处理，不能只使用 node span。

## 4. 三个编辑模式与统一状态

主窗口：左侧 Library，中央上方 node / Library Block / Folder 并列可关闭标签和溢出菜单，第二行 Blocks / Source / Preview 切换，右侧单个详情面板。

Library Folder / block 单击打开一个共用的临时预览标签（斜体），点击另一个库对象即替换；编辑内容/设置、双击顶部标签或 Library 条目后常驻。常驻标签不会被浏览替换，node 标签行为保留。打开请求串行，切换前提交编辑，查看/定位/切换视图不固定；保留树行和标签 DOM，避免单击重绘破坏双击事件。

共享以下状态：

- Document、revision、统一撤销栈。
- 每个节点独立的选中 block、视图模式、滚动/光标位置及折叠状态。
- Library 来源及 pool 绑定元数据，与编译内容分离。

所有操作由统一命令执行：修改文本段、切换开关、增删子节点、修改设置、添加 Pool 候选 tag/block。命令必须校验 revision，并生成文本及 Document 的一致变化。

文本页出现暂时不合法的输入时保留原稿，使用恢复解析显示错误。切换视图不能悄悄丢掉坏片段或退回旧稿；无法安全结构化的区域提供原文编辑入口。节点执行仍严格解析，不把部分恢复结果当成有效输出。

输出预览使用 ComfyUI 节点当前的 seed 输入、region_mode，并区分 prompt / plain；预览不修改 Document，不额外抽取一次随机结果。用户于 2026-10-06 明确取消组内独立 seed：PLv4 全部随机由节点 seed 控制，可接全局随机 seed 节点；历史 `.set{seed}` 原文保留但覆盖失效。未改动的有效语法往返保持原文，不靠格式化重写全文。

读取外接 seed 时共用同一次 ComfyUI graphToPrompt；此次 virtual widget 值传播产生的 callback 不递归触发 Preview / lint。读取结束或失败均解除标记，真实用户改 seed 继续刷新；无法解析的后端 seed 以及读取 / 编译错误直接显示，不以默认 seed 代替。

### 右击定位详细设置（已补充的用户要求）

- 在 PLv3 文本页和 Block UI 中，右击单个 prompt 或 block 都提供“打开详细设置”。
- 右击 prompt 时，打开它所属 block 的详情面板，定位、滚动并高亮该 prompt 的行；展开后直接显示 Weight / Schedule，不再提供单条 Region。右击 block 时直接定位该 block 的设置区域。
- 两种视图使用同一 Document 节点 ID 作为目标，不用 prompt 字符串匹配；重复文字也必须定位正确实例。
- 嵌套内容以实际右击的最内层对象为目标；父级 gutter 或父级边框定位父 block，避免事件冒泡误选父级。
- 菜单显示期间不清除已有选区。执行操作前检查目标和文档版本，不能在文本已经变化后使用过期 span。

### 将选中的 prompts 原位组成 block（已补充的用户要求）

- 右击选中的多个 prompt，提供“将选中内容组成 block”。它与已有的“保存选区为资料库组”是不同操作。
- PLv3 文本页将选中内容原位包裹在 `{ … }` 中；Block UI 在同一位置创建 Group，并把选中节点作为它的 children。两者走同一个文档命令。
- 例：`a, b, c, d` 选中 `b, c` 后得到 `a, { b, c }, d`，不在文档末尾追加、不复制原内容。
- 创建后的新 block 获得新 ID；移入的 prompt/子 block 保留自己的 ID、权重、内容、来源以及 enabled 状态。创建完成后选中新 block，并显示其详情。
- 包组作为一次可撤销操作；切换视图后撤销仍恢复原结构、文本和选择。
- 新 block 默认不绑定池；包组不自动保存到 Library。其 tag 由最近的绑定祖先收录，遇到自身绑定子 block 停止。
- 用户明确创建 Group 会改变父级 shuffle/random_select/dropout 的操作单位：选中的多条 prompt 此后作为一个子组参与父级随机。这是分组语义，不能为了维持旧结果再把新组展平；包组前后内部内容与顺序保持。

当前按连续、完整、同父级的节点范围处理。文本选区端点落在 prompt 内时可对齐到完整 prompt，并显示实际分组范围；跨文本段可以包含完整子 block。跨父级、半个子 block、region/schedule 头或多个不连续选区不能仅插入大括号，应给出明确不可执行原因，或在后续定义专门规则，不能悄悄移动未选内容。

语法页的可见选区还可能跨过关闭且不可见的节点。文档命令需显式计算可见节点与关闭节点的归属，不能通过重新解析选区丢掉关闭内容；这类场景在 P0/P1 中单独验证，不能靠字符串包裹代替结构编辑。

### Block 拖拽移动（已补充的用户要求）

- 每个 block 的窄 gutter 增加专用 drag handle。只有从 handle 发起拖拽，避免与选中文字、编辑光标、折叠或开关冲突。
- 支持同级上下排序、移入其他 block、移出父 block，包含顶层与嵌套实例。
- 合法落点是 Document 的子节点边界：完整 prompt 之间、完整 sub block 前后、内容开头/结尾及空 block 内。文本自动换行不创造新落点；不能插到单个 prompt、权重表达式或 LoRA 的内部。
- 最后一个子 block 下方的多层末尾落点按实际插入线的纵向顺序选择，从上往下是子 block 末尾、父 block 末尾、父 block 外侧。优先匹配附近结构插入线，避免父子卡片的底部判定区重叠造成反转；预览线保留对应缩进并标示目标层级路径。文字之间的插入光标及折叠卡片边缘规则保留。
- 文本段中的落点用短插入光标/高亮分隔位置表示，block 前后用横线；两者映射到相同的结构边界，不把整段文本当作唯一 drop zone。
- 拖入折叠 block 时可短暂悬停展开，并显示内部落点；接近主滚动区边缘时自动滚动。悬停只改变视图，不立即移动文档。
- 移动保留 block 及所有后代的实例 ID、enabled、设置、来源与子项顺序；源位置移除后只在目标出现一次。父级变更可能改变 schedule 求交、format/weight 包装与随机路径，继续按移动后的 PLv3 树计算。
- 禁止移入自己或自己的后代；禁止超过解析深度或产生 region 嵌套等非法结构。拖拽时显示不可落入状态，不在释放时静默改变设置来凑合法结构。
- region/schedule 子项的移动必须连同头部，并处理容器要求、时间共用边界及必要的等价语法转换；特殊容器提供专门落点规则，不直接套普通列表操作。
- 统一命令使用源 node ID、目标 parent ID、相邻节点 ID 和 revision 描述移动，避免“删除源后目标数组下标发生偏移”。单次 drop 是一次撤销操作，取消拖拽不修改内容。
- 移入绑定池的 block 后走统一 tag 收录；移动不自动改变该 block 自身的 pool，也不回删原池 tag。

### Library 的两种拖拽插入（已补充的用户要求）

Library block 行显示两个明确可辨的 handle，附 tooltip 和键盘操作入口：

| Handle | 目的 | 插入结果 |
|---|---|---|
| 拖入 block | 保留结构 | 在目标位置创建有来源信息的新实例，保留设置、子 block 和开关状态 |
| 拖入 prompts | 去掉 block 结构 | 在目标位置插入按顺序展开的 prompt 项，不建立来自源 block 的组结构 |

- Library -> workflow 是插入，不是从资料库搬走资产；每次插入创建新的实例 ID，源资产保持完整。
- 两个 handle 都支持 Block UI 和 PLv3 语法页，使用相同的合法结构落点。语法页通过编辑器坐标映射到 AST/Document 边界，显示插入光标；不能直接让浏览器默认 drop 写入路径或 JSON。
- 拖入 block 时，语法页插入完整 PLv3 block 源码，Document 同时携带关闭项、来源及关联元数据。不能仅插入可见文本而丢失关闭内容。
- 拖入 prompts 的首版语义（用户已于 2026-10-06 确认）：递归按源顺序展开有效启用的叶子 prompt，保留单条 attention/LoRA 权重，去掉源 block 的组级 weight、format、shuffle、random_select、dropout、schedule、region 及 pool/Library 来源。不执行一次编译来随机选取结果。
- 此操作不能与现有 `plain` 输出混淆（plain 仍保留 schedule、随机和权重语义）。
- drop 前显示插入方式、目标父级和预计插入数量；空内容不产生空组或占位字符。去结构后的内容仍受到目标父级设置影响。
- 内容解析使用现有解析器/文档树，不能简单按逗号或换行切分；遵守句号、括号组、LoRA 和嵌套项规则。
- 新实例的 tag 收录走与手写内容相同的事务，失败不留下半次文档插入；不自动创建持久化子 block。

## 5. Library：Folder 即池（2026-10-07，替代旧实体与实例方案）

以 `plv4.md` 末尾“新的block架构设定”为准。Library 只有 Folder、散装 Tag、保存的 Block。Folder 可包含子 Folder；Block 的子 block 是完整包含的内容，数据库不建立子 block 指针或独立资产。删除资产不影响已经插入的 workflow 副本。

一个 block 最多绑定一个 Folder，记录为 `meta.pool`（Folder ID 或 null），与 Document 一起保存，不进入 PLv3 设置、不影响编译。子 block 不继承候选；多个池使用分别绑定的子 block。

保存 block 存完整快照，包含关闭项、顺序、设置及嵌套内容。插入创建独立实例 ID 并保留来源标记；只有“从库更新”和版本匹配的“覆盖回库”改变副本或资产。不自动持久化临时子 block，没有互相引用或混合引用环检查；Folder 存放环仍须拒绝。

Library 树只显示 Folder 和 block/subblock，散装 tag 保留在数据模型中但不作为树行显示；搜索散装 tag 定位所属 Folder。Folder / block 点击整行打开，移除齿轮；预览、折叠和插入按钮独立操作。预览 icon 与其他按钮居中对齐，hover/聚焦/点击递归显示内部 tag（包含关闭项，不按 seed 抽取）。Folder 页用紧凑行显示和编辑本层、子文件夹的散装 tag，写回原 Folder；子文件夹以带底色和边框的标题、文件夹图标、缩进及竖线区分，tag 行有细分隔线。子文件夹可折叠且状态保留，不显示任何保存/绑定 block 列表，不重复展示空内容卡片。编辑页使用 Node 的中性主题。原 saved documents 使用独立保存/加载入口保留。Folder 右键重命名、添加 subfolder/block/tag、移动、Delete；Block 右键重命名、添加真实 subblock、移动、Delete。

Folder 条目新增与 block 同样样式的专用插入 handle，点击条目/名称只浏览；从 handle 拖到结构边界或 block 内部均创建绑定它的空 block，内部落点创建子 block，不修改目标 pool。拖入直接设置绑定的行为已删除（2026-10-08）；已有 block 从详情/菜单显式设置绑定。Library block 的两个 handle 继续保留完整结构 / 仅插 prompts。完整路径由 folder/block/subblock 层级用点号连接，语法沿用 `[完整路径]: { ... }`。

Folder / block 的 hover 预览采用逗号分隔且自动换行的连续文本，不显示逐条来源路径或每条一行。顶部汇总总数/关闭数，关闭项淡色划线，保留完整内容并限制弹层高度，超出滚动；候选树和 Folder 编辑页仍按层级显示。

同一父级的 Folder / block / subblock 名称不能重复，完整路径唯一，跨父级允许同名。创建、重命名、移动、保存检查并原子回滚冲突；未命名子 block 保存时获得不冲突的 `Block` / `Block 2` 名称。Source 按完整路径选取 Library 对象，副本及来源 ID 留在 Document；workflow 的本地副本不占 Library 名称空间。显式旧库转换只在新副本内为旧重名加编号，保留 ID、关闭项和内容并记录提示；启动不自动整理个人库。

## 6. 候选与自动补全

- Library / Pool 共用 `folder_tree.js` 的空 Folder 链压缩：实际本层仅含一个子 Folder 才合并，`父 / 子 / 末端` 同行显示。散装 tag 虽不显示于 Library 仍参与判断；Pool 按筛选前结构判定，不把筛掉的 prompt / block / 分支当成空目录。行首线按可见树绘制，提示保留实际层级范围。Library 中每段可独立浏览、双击固定、键盘打开或右键操作；预览 / Folder handle 和 Pool 子 block 插入指向末端 Folder，不改数据路径或绑定。折叠仍按 Folder ID 保存，Library 合并行展开时清除链内折叠；Folder 内容页与 Content 保留原逐层编辑。
- 候选按绑定 Folder 整棵子树和实际目录缩进。2026-10-08 更正：始终显示 Content，绑定后另显示 Pool，旧单一“内容”区作废。Content 递归编辑真实 prompt / subblock，保持实际顺序；关闭项原位灰色划线，× 只删本地副本。Pool prompt / 保存 block 前用 ＋，加入 Content 末尾；已有项不重复、不重新启用或改顺序。兄弟分支同文 prompt 显示相同加入状态。未绑定子 block 递归参与匹配，有自身绑定的子 block 截断；prompt 匹配忽略单条 Weight / Schedule，空格/下划线按 PLv3 展示一致；block 按来源 ID 匹配，不改变库中 tag 身份规则。
- Pool 类型外观在添加前后固定：Folder 灰色目录标题 / 文件夹图标；Block 立方体图标 / 蓝色边框卡片 / block 类型牌；Prompt 标签图标 / 轻量纵向文本行。顶部紧凑图例标明三种类型。已添加 block / prompt 统一加绿色左边线及“✓ 已添加”实色牌，未添加用淡色“未添加”，不区分启用与关闭。Pool 提供全部展开 / 折叠，类型（全部 / Prompt / Block）和加入状态（全部 / 未加入）独立组合；关闭项不归入“未加入”。保留匹配项的祖先目录，筛选不改变原折叠状态。保存 block 的内部内容只读预览，编辑在 Content 完成。Pool 读取失败不影响 Content。
- Block UI header 在名称前用连接 icon 标记自身 `meta.pool` 绑定；未绑定 / 仅父级绑定无标记，关闭或本机缺失 Folder 仍显示。沿用共享 `blockHTML` 和既有 metadata DOM signature，名称后的保存路径规则不变。
- Library 列表、Folder 内容页、Content 与 Pool 均使用连续祖先竖线和行首连接线，每层独立一列。prompt 纵向排列，block 共用标题背景、图标、类型和折叠设计；Content 有开关及编辑控件，Pool 用添加按钮。本层名称显示，全路径 tooltip；根 Folder 展开，子 Folder / block 默认折叠，按文档和当前 block 保留状态和筛选。开关、加入、编辑保留详情对象和滚动位置，主动定位才切换对象。Block UI header 在名称后以灰字显示保存 block 的 Library 完整路径，按来源 ID 查最新路径、缺失时沿用来源路径；只绑定 Folder 的临时 block 不显示路径。
- Prompt 输入提交沿用 PLv3 的清理和解析，首尾逗号不进单条内容，逗号列表分条显示/收录/入库。中文逗号只在用户编辑输入时转换为英文逗号（2026-10-08 确认），字符串、LoRA 名称、路径及 `.set` 配置保留。详情多条替换保留首项 ID、关闭状态和相邻内容，Folder 多条保存/编辑在同一事务完成，失败全部回滚；不开库自动整理历史条目，PLv3 编译不变。
- 保存 block 从 Pool 整体添加，展开只预览内部 tag 和 subblock；加入后在 Content 编辑。Content 的 block 可整体开关，关闭祖先时后代编辑控件禁用。候选不让编译查数据库。
- 子文件夹标题只提供“作为 sub block 插入”：临时新子 block 绑定该子文件夹，仅插入本层散装 tag，默认 enabled，不自动存库。
- Folder 补全开关决定全局补全来源；开启时递归计算其中散装 tag、所有保存 block 的 tag（含关闭内容）及子文件夹。祖先开启仍包含关闭补全的子文件夹。
- 沿用同一个 Danbooru/Gelbooru TagAC 的搜索、弹窗、Related 与图片预览；额外来源是池中的 tag，完整 block 仍从 Library 路径/handle 插入。计算结果按库 revision 缓存，不复制数据。

## 7. 收录、去重与实现边界

1. 只收 tag，不收结构；池只增不减。绑定 block 递归收录未绑定子 block 的 tag，遇到另有绑定的子 block 停止，由它负责自己的池。
2. 连续输入在完成编辑时提交。打开 workflow、载入 Document、Undo/Redo 建立观察基线，避免把池中手动删除的 tag 重新加入。开关/删除内容不回删池。
3. 自动收录只加入绑定的那一层，查重检查该 Folder 整棵子树，包含保存 block 内的 tag。祖先存在的散装 tag 自动下移。
4. 散装 tag 同一祖先链不重复；向子目录添加祖先已存在的条目是移动；向父目录添加子孙已有的条目提示其路径并拒绝。兄弟/不同分支允许重复，保存 block 内的内容不受此限制。移动 Folder 后造成祖先链重复时事务拒绝并提示先整理。
5. 单 prompt Weight/Schedule、TextRun、选区包组、拖拽、Region/Schedule、revision 和统一历史沿用 P1/P2，不重做 Block UI 或编译器。
6. 暂按完整原子 prompt 文本（保留 attention/LoRA、去除两端空白）判定 tag 同一性；大小写、下划线与空格、不同权重不自动归一。这就是当前精确身份规则；未来更广泛规范化需单独决定，不从旧设计推导。
7. 非空 Folder 的删除先要求移出/删除其内容；已删除或不在本机的 pool 保留 Document 元数据和本地内容，编辑/编译继续工作。

## 8. 实施阶段记录（2026-10-08 收束）

### P0：历史视觉实验

2026-10-06 用户确认视觉设计结束。正式 UI 复用了已确认的样式/控件，随后按试用反馈修正。早期 HTML 原型含旧 Class 数据和历史页面，仅本地保留，不作为当前数据、操作或验收契约，也不随正式功能发布。无需重新开展 UI 设计。

### P1：文档映射与命令层

已实现 Document v2、无状态路由、稳定 ID、projection/revision、原位命令与共享历史；正式窗口已接入。接口及边界见 `prompt_library_v4/DEVELOPMENT.md`，用户操作见中英文 README。保留错误草稿、关闭内容、Source 往返和跨视图撤销；V4 所有随机使用节点 seed。定位、选区分组、MoveBlock 和两种 Library 插入共用现有命令层，不另建编辑器。

### P2：正式窗口和 Block UI

已实现节点标签、Blocks/Source/Preview、设置、native TextRun、共享 PromptEditor/Find/TagAC、拖拽及历史。后续修正已包括：可输入/删除真实空行、开关不重排换行、详情滚动稳定、Region 子项设置、.05 权重按钮、Region/Schedule 默认展开、链接 seed Preview 防递归，以及 Blocks 可见 prompt 搜索/Enter 高亮。

最新验证只做离线 Node/pytest/语法检查，没有浏览器测试；旧浏览器记录不再列作当前版本的验收数字。用户确认本阶段结束不代表做过未运行的性能测量。

### P3：Folder 池 Library

已用 Tag/Block/Folder 替换旧 Class 实现。Folder 页递归编辑散装 tag；Library Block 共用 Node Blocks 页。树隐藏散装 tag，提供紧凑预览、连续层级线、空目录链压缩及专用插入 handle。单击浏览共用一个临时标签，编辑/双击固定。

Content 始终按真实顺序可递归编辑；绑定后另有 Pool，以 ＋ 追加候选，已加入项持续标记，不区分启停。类型/未使用筛选独立，支持全部折叠/展开。新增 pool 元数据、完成编辑收录、观察基线、祖先链去重、同级名称唯一及稳定来源 ID/版本。所有写入经单写者事务，没有 block 指针、子 block 自动持久化或跨类型引用环。

### P4：副本迁移、兼容与集成

V4/V4 Monaco 节点已注册，V3 节点和原窗口继续支持。新运行库为 `plv4-pools.db`，旧 `plv4.db` 不自动升级。

V3 group → Folder、子组 → 子 Folder、原子 items → 散装 tag、preset → 保存 Block；refs/snapshot 展开为包含副本。带 group settings 时额外保存“全部内容”Block，saved documents 经独立入口保留。先备份再导入，同一来源快照重复导入不改资产。

早期实验 V4：Folder/Class → Folder，string attribute → tag，block attribute / pointer → 包含快照，Class attribute → 子 Folder，belong → pool，多 load → 各绑池的临时子 Block。转换器只读原件，要求尚不存在的新目标。多 load 拆层可能改变随机树单位，不能保证所有旧文档随机等价。

测试转换和补充示例由 `test/manual/seed_xyz_test_samples.py` 与 `update_xyz_pool_examples.py` 限定独立根目录，保留原件、ID、关闭项和用户修改。样例已包含实际绑定的父/子池和未绑定子 Block；重名按来源 ID 修整全路径。个人库未迁移，本次收束不再改写样例。

阶段收束已同步内部维护指南、中英文用户手册与仓库入口；发布验证及具体范围见 DEVELOPMENT。

## 9. 必须锁住的回归

- `render(from_text(t)) == t`，未修改有效文本保持逐字往返。
- 关闭/开启后节点 ID、内容、相对顺序及后代选择不变。
- 父组随机把子组当作一个单位；dropout -> random_select -> shuffle 的现有顺序不变。
- 不为纯 UI 占位添加 Group，不因重新排版改变随机树路径。
- 全部 region、ambient/include_in_base、两种权重与两种后端语义保持一致。
- schedule 共用边界、嵌套区间相交、LoRA 特殊权重保持一致。
- 逗号丢弃、句号保留以及括号内分隔规则保持一致。
- Library/Folder 删除或更新不使已有 workflow 依赖数据库运行。
- Folder 存放环、散装 tag 祖先链冲突、独立副本保存和候选来源/补全开关有行为测试。
- 预览和执行对同一 Document / seed / region_mode 得到同一结果。
- 右击定位以实例 ID 为准，重复 prompt 和嵌套场景均不误选。
- 选区分组保留原位置、子项 ID/设置/关闭状态，PLv3 与 Block UI 映射一致，并支持一次跨视图撤销。
- 拖拽预览与实际落点的父级/位置一致；移动无重复、无丢失，源/目标相邻位置和关闭项不被错位。
- Library 两种插入方式在两个编辑模式下含义一致；来源资产不变，保结构时关闭项和来源信息不丢失，去结构规则可验证。

本阶段已结束。后续按具体需求处理更广泛的 tag 身份规范、旧多 load 随机树转换、大文档浏览器性能和个人 V3 副本迁移；这些不作为本次文档发布的隐含授权。
