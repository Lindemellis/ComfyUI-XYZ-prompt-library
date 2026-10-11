# Prompt Library V4

[English](README.md) | **中文**

用嵌套 Block 编辑提示词，保存常用组合，并把新标签收录进 Folder 池。V4 沿用 [PLv3 语言](../prompt_library_v3/README.md)，最终编译为 [comfyui-prompt-control](https://github.com/asagi4/comfyui-prompt-control) 语法。

## 开始使用

1. 安装 comfyui-prompt-control，更新节点包后重启 ComfyUI。
2. 在 `XYZNodes/Prompt` 添加 **XYZ Prompt Library V4** 或 **XYZ Prompt Library V4 Monaco**。Monaco 版本在节点内嵌源码编辑器；两者的编译器和输出相同。
3. 点击节点 **Editor**，或通过 **XYZ Tools → Prompt Library V4 — Editor** 打开窗口，再选择节点标签。
4. 在 **Blocks** 编辑内容，在 **Source** 编辑完整语法，在 **Preview** 查看编译结果。三种视图共用文档和撤销历史。

更新节点包后重启正式 ComfyUI，再按 **Ctrl+F5** 刷新页面即可使用新功能；现有个人库、模型和 workflow 继续保留。

`prompt` 输出保留编译后的区域；`plain` 把区域内容合成一段提示词，仍保留权重、Schedule 和 LoRA。V4 的全部随机选择使用节点 seed，也支持连接的 seed；忽略组内 seed 覆盖。

隐藏 Document 随 workflow 保存，包括关闭项、名称、池绑定和库来源。关闭内容保留原位，再开启即可恢复；分享 workflow 不需要 Library 数据库。非法 Source 草稿保留供修正，生成时报告语法错误。

## Block 和设置栏

正文按普通多行输入框编辑：逗号、空格和空行保留，Enter 换行并把光标留在新行，Backspace / Delete 使用正常的删除行为。首次输入及进入、离开输入框时，文字字号、颜色和位置保持一致。添加 Block 后，其他 Header 的 **更多（⋯）** 菜单仍可单击打开，正文会正常保存。

正文输入框支持 Source 语法：输入 `{…}` 或 `[@region]: {…}` 等结构，离开输入框后显示为对应 Block；编辑过程中保持文字与焦点。未闭合或不合法的结构保留为草稿，可以返回继续修补。需要原样输出语法字符时使用 PLv3 的引用字符串或转义。直接输入空容器保持为空；选择 Schedule / Region / AVG 补全会插入两个阶段 / 四个区域 / 两个等权 entry 的模板。

输入 `[` 可补全特殊 Block 和 Library 路径；路径插入会展开为文档内的副本。输入 `<` 或 `<lora:` 可补全本地 LoRA 路径，默认权重 1，替换已有调用的名称时保留已有权重；此操作只插入调用语法。需要触发词 Folder 和完整 LoRA block 时使用浏览器 **Send**。

**XYZ Settings → Autocomplete** 可独立开关 LoRA 语法、Source 语法、D/G dataset 和 Library prompt 补全。一个 prompt 同时来自 D/G 与 Library 时保留 D/G 链接、alias 和预览，并增加 **L**；只来自 Library 时在 alias 位置显示 Folder 路径。点击 L 打开所属 Folder；属于多个 Folder 时先选择目标。

PLv4、LoRA 浏览器和 XYZ Settings 窗口按点击或聚焦顺序置顶。

Block 按顺序包含 prompt 和 subblock。可以折叠、启停、直接编辑文字或打开设置；选中文字后用 **Create as block** 原位分组。拖拽移动时，插入线标明目标位置和层级。

Header 的同级 / 子级添加按钮仍直接创建普通 Block。在 **更多（⋯）** 中悬停 **添加同级 Block / 添加子 Block**，即可展开普通 Block、Schedule、Region、AVG 的二级菜单；选择 **Schedule 容器 / Region 容器** 创建特殊容器；不合法的嵌套不提供菜单项。Schedule 默认两个空阶段，区间为 **0–0.5 / 0.5–1**；Region 默认四个空区域：**Base / Mask 1 / Mask 2 / Fill**，两个矩形 mask 初始为左半图 / 右半图。创建后聚焦第一个 entry 正文，整次创建可以一次撤销。

Blocks 底部的 **添加 block** 直接创建普通 Block，旁边的 **▾** 提供普通 / Region / Schedule / AVG 选项，空文档同样可用。聚焦特殊容器时底部只添加 entry；Library 页面添加到保存 Block 的内部。菜单遵循同样的嵌套限制。

Schedule / Region 容器的第一层只放阶段 / 区域 entry；从容器的添加按钮新建 entry。entry 只能在所属容器内排序，不能拖出或移到其他容器，也不能单独保存到 Library。Schedule 排序保留各位置的时间区间，内容采用新位置的区间；Region 排序保留各 entry 的区域参数。普通 Block、Library Block 和 Folder 插入的绑定 Block 可以拖进已有 entry 的正文，成为 subblock，并可再次移出；不能拖到容器第一层变成 entry。可以保存完整容器或 entry 正文中的普通 subblock。

每个 Block 都有 **Content**：按文档实际顺序显示 prompt / subblock，可递归编辑，关闭项原位灰显或划掉。开关负责启停，**×** 删除当前副本的内容。权重输入框左右的 **− / +** 每次增减 **0.05**，也可直接输入。

Region 和 Schedule 设置默认展开，并记住手动折叠状态。Region 父 Block 的设置也包含各 Region 子 Block 的区域参数。PLv3 Region / Schedule 语法不变。

Schedule / Region **容器**不提供 Shuffle、Dropout、Random select 或 Format 设置，这些选项用于 entry 或正文 Block。Format 对直接子项逐项套用，subblock 的完整输出作为一项，保留它自己的权重 / 时间包装。Dropout 为 **0–1、步长 0.05** 的滑条，拖动显示数值，松开记一次撤销。Random select 的两个框分别为 **a / b**，要求非负整数且 **a ≤ b**：先在闭区间内随机数量 c，再无放回选择 c 个直接子项；不足 c 个时全部保留。两个框留空关闭该设置，**0 / 0** 表示不选择任何子项。

名称前依次显示连接图标、绑定 Folder 的名称标签；点击图标或 Folder 名称打开与 Library 相同的 Folder 设置标签页。设置栏的 Folder 名称旁也有 **↗** 打开按钮。名称后的灰字是保存 Block 的 Library 路径；只有池绑定的临时 Block 不显示库来源路径。

Schedule / Region / AVG 容器不能绑定 Folder；各 entry 及正文 subblock 可独立绑定。旧容器的无效绑定在打开时移除，正文、关闭项及子级绑定保留。LoRA 的触发词 Folder 为固定绑定，在设置栏的 **LoRA** 区域显示并提供打开按钮，不能更换或解除；Folder 内容仍可编辑。

在 Blocks 按 **Ctrl+F / Ctrl+H** 搜索或替换显示出来的 prompt 内容；Source 搜索完整源码，包含配置字段。**Enter** 与下箭头都跳转并高亮下一项；**Shift+Enter** 与上箭头跳转上一项。在 Block 正文输入 Enter 正常换行；设置栏开关保留空行。

输入沿用 PLv3 拆分规则：逗号分隔条目；后面是空白或文本末尾的句号也分隔，但句号保留。编辑普通 prompt 时中文逗号先转英文逗号，再拆分。引用字符串、LoRA 名称、库路径和 `.set` 配置保留各自语法。打开已有数据不自动整理它。

## AVG Block

通过 Header 的 **⋯ → 添加同级 Block / 添加子 Block → AVG 容器**创建，默认两个等权空 entry。Header 使用与 Schedule、Region、LoRA 相同的类型标签，AVG 为淡粉色。容器只能直接包含 AVG entry，不能直接写 prompt 或绑定 Folder。AVG 容器和 entry 都不提供 Shuffle、Dropout、Random select、Format；需要随机正文时放进普通 subblock。

entry 的 **AVG weight** 是非负相对权重，按比例归一化，例如 **1 / 3 → 25% / 75%**，与提示词强调权重不同。Header 名称后显示相对权重；父容器设置也可调整各 entry。关闭或权重为 0 的 entry 不参与；全部关闭或为 0 时只保留外部内容。启用且为空的 entry 仍参与平均。entry 不能拖动（包括内部排序），不能单独保存或从外部转换；其正文可接受外部 / Library block 作为 subblock，完整容器可保存到 Library。

Source 支持 `[@avg]: { 1: { b }, 3: { c } }`，Blocks 原生输入和 Source 的 `[` 补全也提供空模板。外部 `a, d` 保留在每个分支中，输出为 `a, b, d AVG(0.25) a, c, d`。三个及以上 entry 用累计比例生成 AVG 链，而非每次固定 0.5。多个 / 嵌套 AVG 组合各自的局部比例；每个区域 / 时间段最多展开 256 个组合，超过时报错。

可以与 Schedule、Region、LoRA 同时使用：按有效时间段编译，entry 自身的 Schedule 不在该时间段时重新归一化其余 entry；按区域分别平均，不让 AVG 跨越 COUPLE / AND。AVG 内的 Region 使用有效 entry 的区域集合，相同 mask 合并；某 entry 在该区域没有正文时，只贡献公共环境内容。`plain` 输出去掉区域声明后仍保留 AVG。父 Block 的随机选择把整个 AVG 当一个直接子项，同一次生成的选择不会因时间段切换而重抽。

AVG 平均的是文本编码结果，不产生 AND 那样的多路完整去噪。LoRA 调用集中到末尾并保留 Schedule；复制公共上下文不会重复加载同一个源调用。AVG weight 不改变 LoRA 的 Model / CLIP strength，也不把模型补丁隔离在某个向量分支中；多个有效 entry 的 LoRA 会共同加载。

当前 Prompt Control 的 `safe_float` 会将 AVG 系数四舍五入到两位小数，因此三等分等比例实际有小幅误差，极小的混合份额可能变为 0。PLv4 输出正确累计比例，未修改第三方实现。

## LoRA 浏览器

从 **XYZ Tools → Prompt Library V4 — LoRA Browser**，或 Editor / Library 的 **LoRA** 按钮打开。浏览器不依赖 LoRA Manager，也不会自行加载模型。

- 左侧显示 ComfyUI 配置的全部 LoRA 模型目录及子目录，包括额外模型路径。支持名称 / 路径搜索和分页。
- 卡片显示预览图，并提供 **Send**，无需打开详情。点击卡片查看多张预览图和触发词；**Open in Civitai** 默认打开 **civitai.red**，有版本资料时定位对应版本。
- 顶部选择当前 workflow 的 PLv4 节点，默认当前编辑节点。Send 在该节点顶层末尾追加 **LoRA block**，一次撤销；重复发送定位已有 block，重新启用关闭的祖先和 block，保留权重、内容和位置。
- LoRA block 绑定自己的触发词 Folder。在详情页展开 **触发词 Folder** 即可编辑；各子 Folder 可独立折叠。触发词默认作为 **Pool 候选**，从 Pool 的 ＋ 选择需要的内容，也可以直接输入或修改正文。Folder 支持增删改 tag、外观等子 Folder；Pool 编辑不覆盖已有 workflow 内容。
- 在 block 设置中编辑 **Model strength / CLIP strength**。调用项从 Blocks 和 Content 隐藏，完整调用仍在 Source。block 的 Schedule 同时作用于 LoRA 和正文；父 block 的随机选择以整个 LoRA block 为单位。LoRA block 自身的随机设置只影响正文，保留调用。
- Blocks 的 header 使用统一类型标签：Schedule 为暖黄色、Region 为蓝色、LoRA 为淡紫色，顶层卡片使用对应底色。LoRA 的时间范围可与 LoRA 标签同时显示；折叠或关闭后仍保留类型标识。
- header 的类型标签在名称前；**Schedule · 起止时间 / Region · 区域参数**等设置标签在名称后。
- 点击 header 的 **LoRA** 标签，或设置栏 LoRA 区域的 **打开 LoRA 详情**，直接打开该模型在 LoRA 浏览器中的详情。

首次编辑或发送一个 LoRA 时才创建触发词池。预览和资料优先读取模型旁的 `.metadata.json` / `.civitai.info`、本地图片及资料中的 Civitai 图片地址；**获取 Civitai 资料**按需查询当前文件，缓存在 XYZ 数据目录。已有池不会因浏览或发送恢复删掉的 tag；需要时显式点击 **导入资料中的触发词**。缺少资料或联网失败时仍可发送模型并手动编辑池。

触发词分组优先保留 Civitai / 本地资料中作者提供的组合条目：多套角色、外观或服装分别装入子 Folder，各套可以完全没有共同词。仅包含独立短 tag 的数组仍放在本层；旧式 `,,` 分隔的组合也支持。每套保留完整触发词和权重，同一套内去重，兄弟 Folder 可重复共同词。优先用角色名命名；识别到服装时使用女仆装等名称，否则编号，可自行修改。再次导入复用原子 Folder，保留改名和自定义词。详情按原条目分别显示资料中的触发词；已平铺导入的词只有显式导入或明确整理旧池时才归入子 Folder。

左侧目录树反映磁盘位置；可编辑的 Folder 是触发词池，不移动模型文件。池保存在 PLv4 数据库，独立于普通 Library 树，通过 LoRA 浏览器访问。相同相对文件名在多个模型根目录中重复时，只允许发送 ComfyUI 优先目录中的文件，避免加载到另一个模型。

V4 编译把实际选中的 `<lora:...>` 调用集中到输出末尾，保留有效 Schedule，并避免 Region 复制环境文字时重复输出同一个调用；用户显式写出的不同调用仍各自保留。将同一份 `prompt` 输出连接到 **PC: Schedule LoRAs** 和 **PC: Schedule Prompt**，模型加载和文字编码才会一起生效。workflow / 保存的 Library block 保留 LoRA block 身份和正文；单独复制 Source 只携带 PLv3 语法。生成不依赖触发词数据库。

LoRA 本身作用于整个模型；放入 Region 时，区域限制的是其触发词和正文。

## Library：Folder、tag 和保存的 Block

**Folder 就是池**，包含散装 tag、保存的 Block 和子 Folder。**Block** 保存有序的 prompt / subblock 组合。没有 Class 或共享子 Block 指针。

左侧树只显示 Folder、保存 Block 和其 subblock。点击 Folder 编辑本层及子 Folder 的散装 tag，子 Folder 可以折叠；点击 Block 打开与节点相同的 Blocks 编辑界面。预览图标显示逗号分隔、自动换行的紧凑内容，包含关闭项。散装 tag 在 Folder 页编辑，不占左侧树的每一行。

层级线标明嵌套深度；Library 和 Pool 把无本层内容、只有一个子 Folder 的连续目录压成一行路径，实际层级不变。同一父 Folder 下的 Folder / Block、同一 Block 下的 subblock 不能重名；不同父级允许同名，完整路径唯一。

单击浏览打开一个斜体的**临时标签**，再点另一个 Folder 或 Block 会替换它，最多一个。编辑、双击顶部标签或双击 Library 条目，会将其变为常驻。常驻标签不会被浏览替换。

通过 Library 菜单创建 Folder、tag、Block，或从独立入口保存 / 加载完整 Document。Folder 的 tag 修改即时保存；Library Block 修改先保留在编辑页，显式保存才写回库。保存 subblock 会更新它所属的库快照。

## 绑定 Folder 和使用 Pool

在 Block 设置中最多绑定一个 Folder，随后 **Pool** 列出该 Folder 整棵子树的候选。子 Block 不继承父 Block 的候选列表。

- 点击 prompt 或保存 Block 前的 **+**，追加到当前 Content 末尾。已有内容不重复加入、不重新启用、不改变顺序。
- 已添加项持续显著标记，包括关闭的项；Folder、Block、Prompt 仍有各自明确的样式。
- 支持**全部展开 / 折叠**，以及可组合的独立筛选：类型（全部 / Prompt / Block）与使用状态（全部 / 未添加）。
- 展开候选 Block 只读预览；加入后的副本从 Content 编辑。
- 子 Folder 的 **+ subblock** 新建临时子 Block，绑定该子 Folder，放入其本层全部散装 tag，默认启用，不自动保存到库。

从 Folder 的专用插入 handle 拖到编辑器，会在目标位置新建**绑定该 Folder 的空 Block**；拖到 Block 内部则创建子 Block。已有 Block 的绑定从设置显式修改。保存 Block 保留**保留结构**和**只插 prompts**两种插入方式。

完成编辑时，新 tag 收录到绑定 Folder 本层。收录递归经过未绑定子 Block，遇到自有绑定的子 Block 停止；只收 tag，不收结构。加入前检查整个池子树，包括保存 Block 的内容。关闭或删除 workflow 内容不回删池；打开已有 workflow 只建立基线，不恢复用户手动删除的池 tag。

同一祖先链的散装 tag 不能重复：向子 Folder 添加祖先已有 tag，会从祖先移下来；向父 Folder 添加子孙已有 tag，会提示并拒绝。兄弟分支允许重复；保存 Block 内的 tag 不受限制。Folder 补全开关把子树 tag 递归加入现有补全候选，不复制另一份数据。

## 副本、更新和保存

Library 插入的是带来源标记的独立副本。**从库更新**采用保存内容；**覆盖回库**显式保存本地修改。其他副本不自动变化。库内子 Block 是真实包含的快照，不自动单独持久化、不互相引用。并发保存的版本冲突会报错，避免静默覆盖。

路径用点号连接，如 `画师.厚涂.暖色组合`；Source 沿用 `[完整路径]: { ... }`。来源通过稳定 ID 识别，重命名后显示当前路径；编译只读取文档里已经展开的内容，不查库。

## V3 兼容和迁移

V3 节点及原编辑器 / Library 继续保留在 XYZ Tools。节点 Editor 按钮打开 V4；经 V4 编辑的文档使用 V4 节点 seed 策略，未改动的 V3 文档保留原行为。

选择 **Library 菜单 → 从 V3 迁移（保留原库）**，确认后先创建 SQLite 备份，再导入独立 V4 库，不替换 V3 原库。

| V3 数据 | V4 结果 |
|---|---|
| group | Folder |
| 子 group / 引用 | 包含的子 Folder |
| 原子条目 | 本层散装 tag |
| preset | 该 Folder 下保存的 Block |
| group 自身设置 | 有需要时额外保存“全部内容”Block |
| 保存的文档 | 完整 Document，保留关闭项 |

旧引用展开成副本；重复导入同一未变化来源会被识别。个人资料库不会自动迁移。早期实验 V4 Class 库需使用独立[副本转换器](DEVELOPMENT.md#迁移与样例)。

V4 数据在 Git 忽略的 `prompt_library_v4_data/plv4-pools.db`，V3 原库仍在 `prompt_library_v3_data/`。早期 `plv4.db` 不自动升级、不覆盖。移动安装目录前请备份运行数据库。
