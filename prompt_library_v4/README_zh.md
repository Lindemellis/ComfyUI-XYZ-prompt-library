# Prompt Library V4

[English](README.md) | **中文**

用嵌套 Block 编辑提示词，保存常用组合，并把新标签收录进 Class 池。V4 沿用 [PLv3 语言](../prompt_library_v3/README.md)，最终编译为 [comfyui-prompt-control](https://github.com/asagi4/comfyui-prompt-control) 语法。

## 开始使用

1. 安装 comfyui-prompt-control，更新节点包后重启 ComfyUI。
2. 在 `XYZNodes/Prompt` 添加 **XYZ Prompt Library V4** 或 **XYZ Prompt Library V4 Monaco**。Monaco 版本在节点内嵌源码编辑器；两者的编译器和输出相同。
3. 点击节点 **Editor**，或通过 **XYZ Tools → Prompt Library V4 — Editor** 打开窗口，再选择节点标签。
4. 在 **Blocks** 编辑内容，在 **Source** 编辑完整语法，在 **Preview** 查看编译结果。三种视图共用文档和撤销历史。

更新节点包后重启正式 ComfyUI，再按 **Ctrl+F5** 刷新页面即可使用新功能；现有个人库、模型和 workflow 继续保留。

V3 独立 Editor／Library 已退役，旧 Library 不再自动打开或写入。旧 V3 节点作为兼容节点保留，Editor 按钮统一打开 V4；仅加载旧 workflow 保持原编译规则，在 V4 打开节点后采用节点 seed 和 V4 LoRA 规则，并保留关闭项和稳定 ID。旧 Library 数据保留，仍可明确备份导入 V4。

`prompt` 输出保留编译后的区域；`plain` 把区域内容合成一段提示词，仍保留权重、Schedule 和 LoRA。V4 的全部随机选择使用节点 seed，也支持连接的 seed；忽略组内 seed 覆盖。

点击 PLV4 中间栏 header 的 **⚙ General Settings**，右侧 Settings 显示整个节点的设置。在 **Region algorithm** 下拉中选择 **Attention Couple (COUPLE)**（默认 `couple`）或 **Latent Mask (AND)**（`mask`）；同一节点的所有区域共用该算法。画布节点不显示该控件，值仍随 workflow 保存，旧 `mask` 工作流保持原值，连接上游 region_mode 时禁止手动覆盖。点击 Block 的设置入口会返回该 Block 的 Settings；Library 页面不提供节点级设置。其他区域算法及新 MODEL patch 尚未接入。

选中 **Region 组 Block** 后，Settings 的 **Region entries** 顶部有 **Region** 开关，默认开启。关闭时按文档顺序合并启用 entry 的内容，忽略这些 entry 的区域参数；普通权重、Schedule、随机选择和 LoRA 保留，其他 Region 组照常工作。容器、entry、各项 Enable、坐标及库引用都保留，仍只能放 Region entry，不能在容器直接写提示词。重新开启恢复区域功能；关闭期间，编译和执行不读取、不挂载这组的图片遮罩，已连线输出保留为 **Unused**。

此开关独立于整个 Block 的 **Enable**，支持 Undo/Redo，随 workflow、Document、保存的 Block 和 metadata 保存。Source 保留原 `[@region]` 结构；单独复制 Source 不携带此开关状态。

### Region 与时间

- **schedule 设在 region 本身或它外层的 block 上**：决定这个 region 存不存在。时间窗外，输出里完全没有它的区域语法，只剩共同文字。Base、Fill 条目同样适用。
- **schedule 设在 region 里面的子 block 上**：只限时那部分内容，region 一直都在。
- Region 容器的 **Timing** 滑条有四个滑块，不区分身份：每次拖动后按位置排序，最外两个是容器的 schedule（外侧之外整个容器不生效），里面两个是 **region window**（外侧与内侧之间不分区，所有条目合并成普通提示词，与 `plain` 输出相同）。内外重合表示一直分区。Source 写法：`.set{schedule: {0, 0.8}, region_window: {0, 0.4}}`。Region 开关关闭时滑条不可用。
- 有 region 但 Base、Fill 都没有文字时，没被 region 覆盖的区域由共同文字来画：COUPLE 以 `FILL() <共同文字>` 开头（否则 prompt-control 会生成一个空的全图 base，平分每个 region 的一半）；AND 会加一段"全图减去所有 region"，除非矩形能证明铺满整张图（否则那块的正面预测是 0）。

## Mask Library

主窗口左侧标题行的 **Library / Mask Library** 图标切换同一面板；也可以通过 **XYZ Tools → Prompt Library V4 — Mask Library** 单独打开。Mask Library 独立存放在 `prompt_library_v4_data/masks.db`，不会转换提示词库。

- **矩形画布**：新建画布后在空白处拖动绘制；上方 **添加 mask** 创建中心矩形。列表与画板双向选中，重叠时优先命中最上层。选中后可移动或用八个 handle resize，只有列表拖动柄用于排序。名称、颜色和连接跟随稳定 ID；松开一次提交一次，画布自有 Undo/Redo。版本冲突保留草稿并显示错误。
- **图片画布**：Refresh images 只读扫描 `input/xyz_masks/`；画布列表项直接提供 View masks、Rename canvas、Extraction settings、Relocate image、Delete canvas，面板顶部可更改 input 相对子目录。PNG/WebP/JPEG/BMP 使用静态第一帧。Alpha 默认 `1-alpha`，可反转；无 Alpha 时不提供该项。RGB 默认取面积前 4 色（最多 32），并列按 RGB 升序，黑白和不连通同色块均参与；默认容差 0.05。透明度保留，预览颜色独立于分割目标。修改或删除库条目不会改原图片。
- **Region mask**：四个数依次为 x1/x2/y1/y2。独立矩形可以直接输入，或用 **编辑** 打开单矩形窗口；选库矩形后坐标只读，编辑打开所属画布。库修改共享刷新；解除保留当前坐标。删除矩形或画布后，旧 workflow 使用最后坐标转成独立副本。
- **Region imask**：可以继续输入非负、0 基手动编号；也可从二级缩略图菜单选择图片 Alpha 或确切 RGB。绑定后显示路径、提取项和预览，解除恢复之前的手动编号。文件或已引用颜色消失时明确报错，不自动替换。

V4 在 prompt/plain/metadata 后追加第四个 **mask_bundle** 输出，旧插槽位置及连接保持。矩形仍编译成 MASK；启用图片引用按文档首次出现顺序去重，从 IMASK(0) 自动编号，手动编号保持原值。Schedule/随机选择不重排挂载身份。

```text
PLV4.prompt → PC Schedule LoRAs.text / PC Schedule Prompt.text
CLIP → PC Schedule LoRAs → XYZ PLV4 Attach Masks → PC Schedule Prompt.clip
PLV4.mask_bundle → XYZ PLV4 Attach Masks.mask_bundle
PLV4.mask_bundle → XYZ PLV4 Mask Preview.mask_bundle
```

**Mask Preview** 不用运行即可读取上游当前 Document，输出彩色 IMAGE 和按稳定资源 key 排列的单独 MASK。输出统一为 512×512，图片直接拉伸，不补边；Region feather 不计入几何预览。关闭或移除已接线资源时保留“未使用”插槽，运行输出同尺寸零 MASK；重新启用恢复原连接。

**Attach Masks** clone CLIP，只追加图片遮罩。输入 CLIP 已有 masks 导致实际编号与 prompt 预期不同，会显示并记录 warning，仍继续追加；不会重编号、覆盖或修复手动编号冲突。仅复制 Source 不携带库引用或图片，metadata 也不嵌入遮罩像素；跨机器使用图片引用需要提供 input 文件并登记受控目录。分享普通无图片提示词及矩形 fallback 仍可独立执行。

更新后需要用户重启 ComfyUI 并 Ctrl+F5，才能加载新路由和节点。图片绘画、新建/覆盖/另存为及视频逐帧遮罩不在第一版范围内。

## 图片 Source 与 XYZ Gallery

V4 / Monaco 的第三个 **metadata** 输出保存本次运行的 Source、完整 Document（含关闭项）、prompt、plain、节点 seed 和有效 LoRA。将正向 metadata、可选负向 metadata 接入 **XYZ PLV4 Image Metadata**，把输出接到 Aaalice **💾 条件保存图像 → metadata**。需要已安装 Lora Manager，并更新 Aaalice 节点包；不需要再放 Metadata Overwrite 节点。

合并节点的 **positive_output / negative_output** 应与编码链实际连接的 `prompt / plain` 插槽一致，默认 `prompt`。**lora_syntax** 可补充其他加载链的 LoRA 调用，如 `<lora:style:0.8>`；需要时间区间时使用 PLV3 Source Schedule 语法。最终汇总排除负向 LoRA，保留正向及额外调用的 model/clip strength、顺序和 Schedule，跨来源相同调用消重；原负向文档不改。

保存时开启 **save_with_metadata**，推荐 **PNG**。PLV4 快照通过 `additional_data` 存入图片 `parameters`，关闭 **embed_workflow** 也能使用；不影响采样 seed、模型和其他生成参数。此数据包保留精确输出，因此不会再次把兼容 LoRA 文本追加到正向提示词。

Gallery 图片详情的正负提示词提供 **Source / Prompt / Plain**，默认 Source，支持只读语法高亮和复制；LoRA 区显示最终汇总。PLV4 seed 与图片采样 seed 分开显示。历史图片读取自身快照，不依赖当前 Library。已索引图片可点 **Re-read metadata** 重新读取该文件；没有保存 Source 的旧图不能凭空恢复它。第一阶段仅支持 PNG 在 Gallery 的读取闭环；JPEG/WebP 的 EXIF Source 展示尚未支持。

隐藏 Document 随 workflow 保存，包括关闭项、名称、池绑定和库来源。关闭内容保留原位，再开启即可恢复；普通提示词和矩形 fallback 不需要提示词 Library 数据库，图片引用另需文件及受控目录。非法 Source 草稿保留供修正，生成时报告语法错误。

## Block 和设置栏

连续子 Block 之间和最后一个子 Block 后，正文入口默认收起为细分隔缝。悬停显示 **＋ 正文**，点击展开并聚焦输入；空着离开会收起，输入后成为同一父 Block 的普通正文。用户自己输入的空行保留，空 Block 仍直接显示输入框。

正文按普通多行输入框编辑：逗号、空格和空行保留，Enter 换行并把光标留在新行，Backspace / Delete 使用正常的删除行为。首次输入及进入、离开输入框时，文字字号、颜色和位置保持一致。添加 Block 后，其他 Header 的 **更多（⋯）** 菜单仍可单击打开，正文会正常保存。

Blocks 正文使用 Source 的右键菜单和编辑规则。选中文本后输入 `{`、`[`、`(` 会包裹选区并保留选中；自动配对按 Source 的规则处理。Tab / Shift+Tab 调整缩进，普通文字编辑命令和快捷键使用同一编辑引擎，中文输入与正常换行、删除保持原有行为。

Settings 关闭时，点击 Block 或正文只更新选中，不打开 Settings；打开时则显示对应内容。右键菜单的「定位详细设置」或「详细设置」可以主动打开。

正文输入框支持 Source 语法：输入 `{…}` 或 `[@region]: {…}` 等结构，离开输入框后显示为对应 Block；编辑过程中保持文字与焦点。未闭合或不合法的结构保留为草稿，可以返回继续修补。需要原样输出语法字符时使用 PLv3 的引用字符串或转义。直接输入空容器保持为空；选择 Schedule / Region / AVG 补全会插入两个阶段 / 四个区域 / 两个等权 entry 的模板。

输入 `[` 可补全特殊 Block 和 Library 路径；路径插入会展开为文档内的副本。输入 `<` 或 `<lora:` 可补全本地 LoRA 路径，默认权重 1，替换已有调用的名称时保留已有权重；此操作只插入调用语法。需要触发词 Class 和完整 LoRA block 时使用浏览器 **Send**。

**XYZ Settings → Autocomplete** 可独立开关 LoRA 语法、Source 语法、D/G dataset 和 Library prompt 补全。一个 prompt 同时来自 D/G 与 Library 时保留 D/G 链接、alias 和预览，并增加 **L**；只来自 Library 时在 alias 位置显示 Class 路径。点击 L 打开所属 Class；属于多个 Class 时先选择目标。

PLv4、LoRA 浏览器和 XYZ Settings 窗口按点击或聚焦顺序置顶。

Block 按顺序包含 prompt 和 subblock。可以折叠、启停、直接编辑文字或打开设置；选中文字后用 **Create as block** 原位分组。拖拽移动时，插入线标明目标位置和层级。

Header 的同级 / 子级添加按钮仍直接创建普通 Block。在 **更多（⋯）** 中悬停 **添加同级 Block / 添加子 Block**，即可展开普通 Block、Schedule、Region、AVG 的二级菜单；选择 **Schedule 容器 / Region 容器** 创建特殊容器；不合法的嵌套不提供菜单项。Schedule 默认两个空阶段，区间为 **0–0.5 / 0.5–1**；Region 默认四个空区域：**Base / Mask 1 / Mask 2 / Fill**，两个矩形 mask 初始为左半图 / 右半图。创建后聚焦第一个 entry 正文，整次创建可以一次撤销。

Blocks 底部的 **添加 block** 直接创建普通 Block，旁边的 **▾** 提供普通 / Region / Schedule / AVG 选项，空文档同样可用。聚焦特殊容器时底部只添加 entry；Library 页面添加到保存 Block 的内部。菜单遵循同样的嵌套限制。

Schedule / Region 容器的第一层只放阶段 / 区域 entry；从容器的添加按钮新建 entry。entry 只能在所属容器内排序，不能拖出或移到其他容器，也不能单独保存到 Library。Schedule 排序保留各位置的时间区间，内容采用新位置的区间；Region 排序保留各 entry 的区域参数。普通 Block、Library Block 和 Class 插入的绑定 Block 可以拖进已有 entry 的正文，成为 subblock，并可再次移出；不能拖到容器第一层变成 entry。可以保存完整容器或 entry 正文中的普通 subblock。

每个 Block 都有 **Content**：按文档实际顺序显示 prompt / subblock，可递归编辑，关闭项原位灰显或划掉。开关负责启停，**×** 删除当前副本的内容。权重输入框左右的 **− / +** 每次增减 **0.05**，也可直接输入。

Region 和 Schedule 设置默认展开，并记住手动折叠状态。Region 父 Block 的设置也包含各 Region 子 Block 的区域参数。PLv3 Region / Schedule 语法不变。

Schedule / Region **容器**不提供 Shuffle、Dropout、Random select 或 Format 设置，这些选项用于 entry 或正文 Block。Format 对直接子项逐项套用，subblock 的完整输出作为一项，保留它自己的权重 / 时间包装。Dropout 为 **0–1、步长 0.05** 的滑条，拖动显示数值，松开记一次撤销。Random select 的两个框分别为 **a / b**，要求非负整数且 **a ≤ b**：先在闭区间内随机数量 c，再无放回选择 c 个直接子项；不足 c 个时全部保留。两个框留空关闭该设置，**0 / 0** 表示不选择任何子项。

名称前依次显示连接图标、绑定 Class 的名称标签；点击图标或 Class 名称打开与 Library 相同的 Class 设置标签页。设置栏的 Class 名称旁也有 **↗** 打开按钮。名称后的灰字是保存 Block 的 Library 路径；只有池绑定的临时 Block 不显示库来源路径。

Schedule / Region / AVG 容器不能绑定 Class；各 entry 及正文 subblock 可独立绑定。旧容器的无效绑定在打开时移除，正文、关闭项及子级绑定保留。LoRA 的触发词 Class 为固定绑定，在设置栏的 **LoRA** 区域显示并提供打开按钮，不能更换或解除；Class 内容仍可编辑。

在 Blocks 按 **Ctrl+F / Ctrl+H** 搜索或替换显示出来的 prompt 内容；Source 搜索完整源码，包含配置字段。**Enter** 与下箭头都跳转并高亮下一项；**Shift+Enter** 与上箭头跳转上一项。在 Block 正文输入 Enter 正常换行；设置栏开关保留空行。

输入沿用 PLv3 拆分规则：逗号分隔条目；后面是空白或文本末尾的句号也分隔，但句号保留。编辑普通 prompt 时中文逗号先转英文逗号，再拆分。引用字符串、LoRA 名称、库路径和 `.set` 配置保留各自语法。打开已有数据不自动整理它。

## AVG Block

通过 Header 的 **⋯ → 添加同级 Block / 添加子 Block → AVG 容器**创建，默认两个等权空 entry。Header 使用与 Schedule、Region、LoRA 相同的类型标签，AVG 为淡粉色。容器只能直接包含 AVG entry，不能直接写 prompt 或绑定 Class。AVG 容器和 entry 都不提供 Shuffle、Dropout、Random select、Format；需要随机正文时放进普通 subblock。

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
- LoRA block 绑定自己的触发词 Class。在详情页展开 **触发词 Class** 即可编辑；各子 Class 可独立折叠。触发词默认作为 **Pool 候选**，从 Pool 的 ＋ 选择需要的内容，也可以直接输入或修改正文。Class 支持增删改 tag、外观等子 Class；Pool 编辑不覆盖已有 workflow 内容。
- 在 block 设置中编辑 **Model strength / CLIP strength**。调用项从 Blocks 和 Content 隐藏，完整调用仍在 Source。block 的 Schedule 同时作用于 LoRA 和正文；父 block 的随机选择以整个 LoRA block 为单位。LoRA block 自身的随机设置只影响正文，保留调用。
- Blocks 的 header 使用统一类型标签：Schedule 为暖黄色、Region 为蓝色、LoRA 为淡紫色，顶层卡片使用对应底色。LoRA 的时间范围可与 LoRA 标签同时显示；折叠或关闭后仍保留类型标识。
- header 的类型标签在名称前；**Schedule · 起止时间 / Region · 区域参数**等设置标签在名称后。
- 点击 header 的 **LoRA** 标签，或设置栏 LoRA 区域的 **打开 LoRA 详情**，直接打开该模型在 LoRA 浏览器中的详情。

首次编辑或发送一个 LoRA 时才创建触发词池。预览和资料优先读取模型旁的 `.metadata.json` / `.civitai.info`、本地图片及资料中的 Civitai 图片地址；**获取 Civitai 资料**按需查询当前文件，缓存在 XYZ 数据目录。已有池不会因浏览或发送恢复删掉的 tag；需要时显式点击 **导入资料中的触发词**。缺少资料或联网失败时仍可发送模型并手动编辑池。

触发词分组优先保留 Civitai / 本地资料中作者提供的组合条目：多套角色、外观或服装分别装入子 Class，各套可以完全没有共同词。仅包含独立短 tag 的数组仍放在本层；旧式 `,,` 分隔的组合也支持。每套保留完整触发词和权重，同一套内去重，兄弟 Class 可重复共同词。优先用角色名命名；识别到服装时使用女仆装等名称，否则编号，可自行修改。再次导入复用原子 Class，保留改名和自定义词。详情按原条目分别显示资料中的触发词；已平铺导入的词只有显式导入或明确整理旧池时才归入子 Class。

左侧目录树反映磁盘位置；可编辑的 Class 是触发词池，不移动模型文件。池保存在 PLv4 数据库，独立于普通 Library 树，通过 LoRA 浏览器访问。相同相对文件名在多个模型根目录中重复时，只允许发送 ComfyUI 优先目录中的文件，避免加载到另一个模型。

V4 编译把实际选中的 `<lora:...>` 调用集中到输出末尾，保留有效 Schedule，并避免 Region 复制环境文字时重复输出同一个调用；用户显式写出的不同调用仍各自保留。将同一份 `prompt` 输出连接到 **PC: Schedule LoRAs** 和 **PC: Schedule Prompt**，模型加载和文字编码才会一起生效。workflow / 保存的 Library block 保留 LoRA block 身份和正文；单独复制 Source 只携带 PLv3 语法。生成不依赖触发词数据库。

LoRA 本身作用于整个模型；放入 Region 时，区域限制的是其触发词和正文。

## Library：Folder、Class 和保存的 Block

树中每层固定按 **Class → Folder → Block** 排列，同类型内按名称字母排序，忽略大小写。移动和绑定选择器采用同样的顺序。

**Folder** 只整理资产，容纳子 Folder、Class 和保存的 Block；不能存放散装 prompt，也不能绑定为池。Folder 保留文件夹图标。

**Class** 是分层候选池，容纳散装 prompt 和 Subclass，不存放 Block。Class 使用叠层图标，点击后编辑本层及子 Class 的 prompt；每层先显示 Subclass，再显示本层 prompt，两组各按字母顺序排列，忽略大小写。补全开关位于 Class 页面。

**Block** 保存有序的 prompt / subblock 组合，点击后使用与节点相同的 Blocks 编辑器。存放在哪个 Folder，与绑定哪个 Class 相互独立。

Library 树显示 Folder、Class、保存 Block 及其内部 subblock；散装 prompt 在 Class 页面编辑。点击 Folder 名称直接折叠 / 展开，不打开详情页或标签页；新建、重命名和移动等操作从右键菜单进行。Class 页面编辑 prompt，提供添加 Subclass / prompt。Block 的内部子块不自动成为独立保存资产。

Class 和每个 Subclass 都有页内输入框：输入多个 tag 后点击 **Add**，英文或中文逗号按提示词语法分隔，括号和 LoRA 调用保留。添加失败保留输入。移动和 Block 绑定 Class 使用同一套目录树、图标列表和路径导航；绑定窗口支持解除绑定。删除确认只有 **取消 / 删除**，删除 Folder 或 Class 会连同其中内容一起删除。展开、折叠和刷新 Library 保持滚动位置。

LoRA 的触发词池是 Class，包含的 Subclass 同样属于该 LoRA。暂不在普通 Library 树、搜索、目的地选择和 Source Library 路径补全中显示它们；保存的 LoRA Block 也隐藏。LoRA 浏览器仍可编辑触发词 Class，节点的固定绑定和 Pool 正常使用。

同级 Folder / Class / Block 和同级 subblock 名称不能重复，完整路径唯一。只压缩同类型的空单子层级，不跨 Folder / Class 边界合并。Class / Block 单击共用一个斜体临时标签；编辑或双击固定标签。Class 的 prompt 编辑即时保存；Block 的正文修改显式保存才写回库。

旧 Folder 池从 **Library ＋ 菜单 → 转换旧 Folder 池** 显式升级，转换前保存 SQLite 备份。含 prompt、补全或已有绑定的池及其祖先转为 Class，保留原 ID；整理用目录保留 Folder。混合目录增加外层 Folder，Block 移到整理目录。绑定的稳定 ID、正文、关闭项和编译规则保留。启动不会自动执行这项内容转换。

## 绑定 Class 和使用 Pool

在 Block 设置中最多绑定一个 Class，随后 **Pool** 列出该 Class 及 Subclass 的散装 prompt，以及绑定这些 Class 的已保存 Library Block；每层按 **Subclass → Block → Prompt** 排列，同类型按名称字母排序，忽略大小写，Content 仍保持实际正文顺序。Block 可以存放在任意 Folder。子 Block 不继承父 Block 的候选列表。

Pool 的类型、加入状态筛选和折叠状态按当前 Block 与绑定 Class 保存在浏览器中；重开 Settings / Window、刷新页面或重启 ComfyUI 后仍保留（同一浏览器与访问地址）。这些显示偏好不改变正文、编译结果或编辑历史。

Content、Pool prompt 及候选 Block 的展开预览共用自动补全 / related tags 的 **🖼** 图片预览。XYZ Settings 只开启 artist preview 时仅画师 tag 显示图标；开启 all tag preview 时所有可识别的 Danbooru tag 显示图标；普通文本与 Gelbooru-only tag 不显示。预览数量、缓存、图片接口和悬浮弹窗均共用现有设置。

- 点击 prompt 或保存 Block 前的 **+**，追加到当前 Content 末尾。已有内容不重复加入、不重新启用、不改变顺序。
- 与当前 Block 绑定同一个 Class 的保存 Block，**+** 加入它的 prompt 和子 Block，不增加外层 Block；已有 prompt 跳过，内部子 Block 与关闭项保留，可整体撤销。独立绑定的子 Block 和特殊容器保留自己的内容规则。
- 已添加项持续显著标记，包括关闭的项；Class、Block、Prompt 仍有各自明确的样式。
- 支持**全部展开 / 折叠**，以及可组合的独立筛选：类型（全部 / Prompt / Block）与使用状态（全部 / 未添加）。
- 展开候选 Block 只读预览；加入后的副本从 Content 编辑。
- Subclass 的 **+ subblock** 新建临时子 Block，绑定该子 Class，放入其本层全部散装 tag，默认启用，不自动保存到库。

从 Class 的专用插入 handle 拖到编辑器，会在目标位置新建**绑定该 Class 的空 Block**；拖到 Block 内部则创建子 Block。已有 Block 的绑定从设置显式修改。保存 Block 保留**保留结构**和**只插 prompts**两种插入方式。

完成编辑时，新 tag 收录到绑定 Class 本层。收录递归经过未绑定子 Block，遇到自有绑定的子 Block 停止；只收 tag，不收结构。加入前只检查整个 Class 子树的散装 prompt；候选 Block 内容不阻止收录。关闭或删除 workflow 内容不回删池；打开已有 workflow 只建立基线，不恢复用户手动删除的池 tag。

同一祖先链的散装 tag 不能重复：向子 Class 添加祖先已有 tag，会从祖先移下来；向父 Class 添加子孙已有 tag，会提示并拒绝。兄弟分支允许重复；保存 Block 内的 tag 不受限制。Class 补全开关把子树 tag 递归加入现有补全候选，不复制另一份数据。

Pool 只展示已保存的 Library Block，工作流临时块和未单独保存的内部 subblock 不作为独立候选。编辑 Library Block 时排除它自身；添加仍复制快照，保留内部绑定和关闭项。候选列表随保存、更换绑定、移动、删除自动更新。

## 副本、更新和保存

中间栏顶部的 **保存为 Block** 将当前节点的全部内容保存到 Library。只有一个完整 Block 时直接保存；散装 prompt、多个 Block 或空节点会先包成一个 Block，保留子项 ID、顺序和关闭状态。取消保存不改变结构；包裹和保存可一步撤销。已有库来源可选择覆盖或另存，完整 Document 仍使用原有独立保存入口。

Library 插入的是带来源标记的独立副本。**从库更新**采用保存内容；**覆盖回库**显式保存本地修改。其他副本不自动变化。库内子 Block 是真实包含的快照，不自动单独持久化、不互相引用。并发保存的版本冲突会报错，避免静默覆盖。

路径用点号连接，如 `画师.厚涂.暖色组合`；Source 沿用 `[完整路径]: { ... }`。来源通过稳定 ID 识别，重命名后显示当前路径；编译只读取文档里已经展开的内容，不查库。

## V3 兼容和迁移

V3 节点保留兼容身份并标为已退役，独立 Editor / Library 已撤下。节点 Editor 按钮打开 V4；经 V4 编辑的文档使用 V4 节点 seed 策略，未改动的 V3 文档保留原行为。

选择 **Library 菜单 → 从 V3 迁移（保留原库）**，确认后先创建 SQLite 备份，再导入独立 V4 库，不替换 V3 原库。

| V3 数据 | V4 结果 |
|---|---|
| group | Class，配套 Folder 存放组合 |
| 子 group / 引用 | Subclass，配套整理目录 |
| 原子条目 | 本层散装 tag |
| preset | Folder 下保存的 Block，绑定对应 Class |
| group 自身设置 | 有需要时额外保存“全部内容”Block |
| 保存的文档 | 完整 Document，保留关闭项 |

旧引用展开成副本；重复导入同一未变化来源会被识别。个人资料库不会自动迁移。早期实验 V4 Class 库需使用独立[副本转换器](DEVELOPMENT.md#迁移与样例)。

V4 数据在 Git 忽略的 `prompt_library_v4_data/plv4-pools.db`，V3 原库仍在 `prompt_library_v3_data/`。早期 `plv4.db` 不自动升级、不覆盖。移动安装目录前请备份运行数据库。
