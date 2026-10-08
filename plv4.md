> 当前状态（2026-10-08）：用户确认本阶段结束。本文保留需求演变记录；末尾“新的block架构设定”及后续明确更正是当前要求。前文关于 Class 的内容全部作废，不是另一套可选实现。当前 Content/Pool、临时标签、handle 插入和搜索/换行规则见 prompt_library_v4/DEVELOPMENT.md，实施记录见 plv4_plan.md。

经过了一段时间对plv3的使用，我打算升级为plv4，对痛点进行全方位改进，并对整体框架进行大规模的重构

我打算直接在plv3和plv3语法的基础上改。分为三层：block ui-plv3语法-具体用于t2i生成的提示词。三者之间是等价的。

# block ui

UI 设计已于 2026-10-06 定稿，P1–P4 的主要功能已有实现；2026-10-07 仍在根据用户试用修正，开发未结束、尚未统一验收。视觉基础为 `prototypes/plv4/nested.html`，正式共享模板与样式位于 `js/plv4/design_components.js`、`design.css`，直接复用设计好的代码，不按截图另做一套。最新实现、测试范围和交接见 `prompt_library_v4/DEVELOPMENT.md`；旧原型说明不覆盖后续明确决定。

核心设计思路：参考jupyter notebook的block设计。但是一个block里可以同时存在文本编辑器和sub block。

每个 block 都有固定 Header，高度约 23 px：
- 最左放较大的 collapse 按钮。
- 显示名字（如果有）和 Schedule / Region 特殊类型标识。
- 显示 Enable、详细设置、增加同级 block、增加 sub block、“更多操作”。
- “更多操作”包含 Save、Delete、Assign class、Load class；菜单按文字宽度收紧。
- Shuffle、随机、Schedule、Region 的功能设置留在详细设置栏，不放进 Header。

Header 下方整条左侧 edge 为 drag handle，悬停发光；可上下排序、移入或移出其他 block。合法落点包括完整 prompt 之间、已有 sub block 前后，以及内容起点和终点。

尽量减少缩进，当前每层左边缘间距约 7 px；用横线及不同背景色区分文本和 sub block。只压缩 Header，单行正文区至少 36 px，prompt 字号保持 13 px，正文是视觉主体。按钮不能覆盖相邻文字或导致悬停时的纵向位移。不使用额外的顶部 / 底部悬浮操作栏。

单击 block 空白处打开自己的详情；点击子 block 不误选父 block。Block 名称在自己的设置栏顶部一行输入框中编辑。

Blocks 中每个连续文本段使用一个 native contenteditable，prompt span 只作装饰，不拆成多个输入容器；原生选择可跨 prompt，逗号/空格可定位，空 block 直接输入。复用现有 PromptEditor 的菜单、查找替换、撤销重做与调权重，补全/Related 复用同一 TagAC 设置与弹窗。Source 仍使用唯一 PromptEditor/Monaco，不 fork。保存功能支持新命名保存、覆盖保存或 save as new。

Blocks 的单条 Weight 显示 `(tag:weight)`，Schedule 显示 Prompt Control interval；不要露出设置包装的 PLv3 原文。Source 的分隔符换行/缩进由显示映射处理，不能让后续 prompt 无故错位。新增 block 只格式化对应的新 `{}` 子树，不格式化已有外部文本。

# block ui 和 plv语法

规则如下：plv3里的一个{} group就等于一个block。

plv3语法里的特殊region group和schedule group，在block ui下也需要特殊的设计

2026-10-08：点开 Region block 的 Setting，Region entries 中按顺序显示各个 region sub block 的区域设置，默认展开、逐项可折叠。名称 / 编号及类型明确对应子区域；直接编辑 Kind、IMASK / Rectangle、feather、mask_weight、cond_weight、Include base。字段遵循 PLv3：只有 mask/imask 有 feather，fill 没有 mask_weight，base 没有 Include base。修改目标子区域不切换到它的详情页，保留父 Region 的滚动位置与各子项折叠；已有开关、删除及主动打开子项详情仍可用。复用现有控件与 SetRegion 命令，不改语法和编译。

# library（历史：Class 规定作废，见末节）

library需要如下重构。我会使用我最熟悉的计算机编程语言来描述

新语法下，存在三个结构：folder，class，block

folder就是单纯用来归纳、整理、分类的容器，可以包含subfolder、class、block。

每个class可以有很多attribute，每个attribute可以是string，可以是block，可以是其他class。除此之外，class不包含其他信息。

每个class有一个开关。开关开启后，class内的所有prompt，包括iterative attribute block内的prompt和attribute class内的prompt，都会加入现如今已经存在的基于danbooru和gelbooru database的prompt autocomplete列表。

Library 树中 Class 也表现为可折叠的 folder，只有归属它的 block 固定显示在该 Class 下。属于 Class 的 block 称为 class instance，只在 Library 中显示于对应 Class 下；Class 详情页只列出各类 attributes，不显示 class instance 列表。Attribute 是引用关系，不决定 Library 中的存放位置：block attribute 可以位于其他 folder 或归属其他 Class；class attribute 也不因被引用而移动到引用它的 Class 下。被引用的 block / class 本身仍要能在 Library 中找到并打开，同一实体不因引用而复制。


# 新功能（历史：Class 规定作废，见末节）

一个block（即一个plv3 group）可以属于一个class，或者可以加载多个class。

- block最多只能属于一个class
- block不能即属于class，又加载class
- 当block A属于Class C时，所有写进block A的prompt和block都会自动进入Class C变成attribute。
- 当block A属于Class C，或者加载了Class C，那么该class C的attribute会在block A的设置页面，作为候选选项出现，用户可以enable/disable这些选项。Class C的attribute class会以indented list的形式出现，用户可以选择该class内的prompt，而不是直接enable整个class。用户可以enable整个attribute block，只有在block enable时，才可以enable block里的prompt或subblock。

- 没有被save到library的block是临时的，被删掉就没了。
- 假如library里的class C或者block A里面有一个block B，那么block B也应该被视为save在library里，class C和block A实际上拥有的是指向该block的指针。

block A加载Class C, D, E的行为，可以看作我们创造了一个dummy class F，该class F同时有class CDE作为attribute，然后让block A属于class F。这也解释了为什么class A不能再属于别的class。


# plv主窗口的新设计：

整个主窗口是 ComfyUI 网页画布上的 floating window，通常不会占满屏幕。设计必须以浮动窗口自身的尺寸为依据，支持移动和缩放。Block UI 的主要纵向空间应留给 prompt 文本，尽量减少留白、独立标题行和嵌套工具栏累积的高度，避免频繁滚动。

左边放library，中间放文本。

左边的library按folder tree列出所有的folder、class、block。在顶部有搜索、排序、全部展开/折叠功能。点击 Library 中的 block 或 class，在中间 Text editor 栏打开对应的编辑页面。

Library block 页面复用 node 页面的文本编辑和右侧详细设置，但只编辑一个根 block，不能在根 block 旁添加同级 block；根 block 内仍可编辑 prompt、添加 / 编辑 / 移动 sub block。Text editor 栏的设计、颜色及背景颜色必须明显区分 workflow node 和 Library block，顶部明确标识内容来源。

Library class 详情也在 Text editor 栏显示，使用独立的属性列表页面，不采用 Block UI 或 PLv3 语法格式。从上到下依次为：
- Block attributes。
- Class attributes。
- Prompt attributes。

每个 attribute 都可编辑和删除。Block 名称在该 block 自己的详细设置中修改；Class 的 Block attributes 列表只显示名称和打开入口，不提供直接改名输入框。Block attribute 可进入 block 编辑及详细设置，Class attribute 可进入对应的 class 属性页，Prompt attribute 可在列表中直接编辑。Class instance 只显示在 Library，可打开自身编辑页面，通过自己的 Assign class 设置更改或解除归属。编辑在原型中支持撤销 / 重做和本地保存；正式实现沿用 Library 的共享引用关系。

Library 中的 block 提供两种 drag handle，可以拖入 Block UI 或 PLv3 editor 的目标位置：
- 作为 block 插入，保留 block 结构。
- 只插入 prompt，不保留 block 结构。

右边文本窗口顶部并列打开的 workflow node、Library Block 和 Library Class 标签，各有关闭 ×，可切换并保留独立状态。如果数量过多，就在最右边显示 dropdown menu。

下方的主体部位是文本编辑/浏览器。分为三个模式，开关在顶部第二行。分别是：

- Blocks：可视化 block 编辑。
- Source：PLv3 原稿编辑。
- Preview：编译后的 prompt / plain 输出预览。

Library、Text editor、Settings 之间提供可拖动的全高分隔柄，调整横向空间；两侧面板使用外侧独立列，不能覆盖中间编辑区。

点击plv3模式或者block模式下的一个block，会在窗口的右侧显示该block的详情页面，该详情页面从上到下依次是：
- 当前plv3语法规定的所有设置
- 该block内所有enabled/disabled prompt
- 来自该block所属的class，或者加载的class的所有attribute

详情页面里的每个prompt，应该显示：
- 同一行的enable开关和显示prompt内容的text input
- 一个折叠按钮；展开后直接显示 Weight 和 Schedule，不使用 + setting。
- Weight 默认显示 1；Schedule 共用一个轨道两个滑块，有清除 ×；单条 prompt 不再设置 Region，block 的 Region 保留。
- 同行最右侧提供 delete button。

详情顶部不重复显示标题、路径或解释段落；Format 标签和输入框放在同一行。Assign class、Load class 同时出现在 Block 的详情设置栏和“更多操作”菜单。

右击单个prompt或block时，右击菜单里应该新增一个选项，打开跳转到该prompt的详细设置

Blocks 与 Source 共用右击文本菜单，并增加 Create as block：有选区时把任意 string 在原地包成 block，无选区时使用光标所在 prompt。两者共享 Find/Replace 和 Undo/Redo；只格式化新生成的 `{}`，不改写已有外部文本。

# plv3 语法需要注意的部分

2026-10-06 补充确认：PLv4 不再设置 block 内独立 seed，全部随机统一使用 ComfyUI 节点的 seed 输入，以便接入全局随机 seed 节点。历史 `.set{seed: ...}` 保留原文但不再控制 PLv4 随机。Library “只插入 prompts”按原顺序递归插入启用内容，保留单条 attention/LoRA 权重，移除组级设置和 Class/Library 关联，不执行随机抽取。

我之前和region和schedule相关要求必须遵守，尤其是region部分，base、mask、fill区域怎么互动，怎么生成最终的提示词

region group和schedule group在block ui里也应该有相应的特殊设计。

# 重点

block ui本质上只是把plv3语法渲染成更适合操作、更美观便捷的样式。

# 2026-10-06 Library 补充要求（历史：Class 规定作废）

Library 中 Class 和 Block 的全名包含实际 folder / class / subclass / block / subblock 层级，使用点号连接；PLv3 引用普通 block 时沿用 `[完整路径]: { ... }`。Attribute 引用不改变对象的存放位置。

- Folder 右键：重命名、添加 subfolder、添加 Class、添加 Block、移动、Delete。
- Class 右键：重命名、添加 subclass、新建该 Class 的 block instance、移动、Delete。
- Block 右键：重命名、添加 subblock、移动、Delete。
- Block 的直接及间接循环引用必须检测并报错。
- 把 Class 拖到文本编辑器的目标位置，新建属于该 Class 的 block；拖到没有 Class 关联的 block 上，为该 block Load Class。
- 把 Library Block 拖到正在打开的 Library Block 的文本视图或 Block UI，像节点编辑器一样在目标位置插入实例。
- 把 Library Block 拖到正在打开的 Class 页面，作为 Block attribute 加入。

# 新的block架构设定

2026-10-07 确认：本节取代上文“library”“新功能”两节以及“2026-10-06 Library 补充要求”中所有关于 Class 的规定。Block UI、PLv3 语法、Region / Schedule、拖拽等其余设计不变。

## 需求来源

1. 常用 artist tag 很多，每次只用 1~20 个，需要一个池，使用时 enable / disable。
2. artist 多了需要分类放进不同子集。
3. 好用的 artist combo 需要记住，随时调用。
4. 常用提示词、组合、实验得来的好用提示词需要分门别类保存。
5. 角色提示词要能细分：姓名、外表、服装（可能多套）；能轻松切换服装，也能单独关掉某条外表 tag（如画闭眼时关掉 blue eyes）。
6. 在“属于 artist”的 block 里写新的 artist tag，它自动进入 artist 池，不用再单独打开池手动添加。

## 为什么取消 Class

旧方案的 Class 同时承担候选池、结构模板、引用容器三种职责；Block 同时承担“prompt 里的内容”和“Library 里的可复用资产”两种职责。两者互相引用，导致 belong / load 互斥、dummy class F、class instance、内部 block 自动持久化、跨类型环检测等大量特例。新方案把“结构”和“归类”拆开，各由一个概念负责。

## 三个概念

| 概念 | 是什么 | 只负责 |
|---|---|---|
| Tag | 一条 prompt，如 `artist_x`、`blue eyes` | 原子 |
| Block | 有序的 tag / 子 block 列表，每项有 enable 开关 | 结构：写什么、什么顺序、开哪些 |
| Folder（池） | Library 的文件夹，可有子文件夹 | 归类：存放散装 tag 和保存的 block |

- **不再有 Class。池就是 Library 的 Folder。** 子类 = 子文件夹（如 `artist/厚涂`、`artist/平涂`），只有包含关系，没有引用。
- Folder 里只放两种东西：**散装 tag**、**保存的 block**（即 combo / 角色 / 常用组合）。
- Folder 有补全开关：开启后，其中的散装 tag 和所有 block 内的 tag（递归，含子文件夹）进入现有 danbooru / gelbooru 补全列表。这是计算得来的视图，不复制数据。

## Block 的可选设置：绑定池 `pool`

一个 block 最多绑定一个 Folder。绑定同时具有读和写两个作用（取代旧的 Assign class / Load class）：

- **读（候选，2026-10-08 更正）**：block 详情的 Pool 把所绑 Folder 整棵子树（本层 + 所有层级的子文件夹）列成缩进树。例如绑定 `artist`，可从 `artist/`、`artist/厚涂`、`artist/平涂` 添加 tag。子文件夹标题提供“作为 sub block 插入”（见下文）。散装 tag 和保存 block 前用 ＋ 加入 Content 末尾，已加入项持续显示状态，不重复、不重新启用。保存 block 展开只读预览内部 tag / subblock，加入后从 Content 开关和编辑；原候选勾选开关设计作废。
- **写（自动收录）**：在该 block 中写入一个所绑 Folder 子树里还没有的 tag，它自动作为散装 tag 加入**所绑定的那一层** Folder（绑 `artist` 进 `artist/` 根目录，绑 `artist/厚涂` 直接进 `artist/厚涂`）。已存在于子树任何位置（散装或某个 block 内）的 tag 不重复加入。
- 需要同时使用多个池时，开多个子 block，各绑各的池。没有“加载多个池”。
- 子 block 不继承父 block 的绑定（候选列表只属于绑定它的那个 block），收录范围见下方“收录与删除规则”。

不设“互斥子项”之类的额外设置：多套服装等场景由用户手动开关各子 block。

### 子文件夹“作为 sub block 插入”

候选树中每个子文件夹标题旁提供“作为 sub block 插入”按钮（例：block 绑定 `quality`，在 `quality/score` 上点击）：

- 在当前 block 中新建一个子 block，**绑定到该子文件夹**（`quality/score`）。
- 把该子文件夹本层的散装 tag 全部插入这个子 block，默认全部 enabled，用户再手动关掉不要的。
- 新子 block 的候选列表就是该子文件夹；之后在其中写入的新 tag 收录进该子文件夹，而不是父 block 绑定的 `quality` 根目录。
- 新子 block 是临时 block，不自动保存到 Library。

如果常用的只是子文件夹里固定的一部分（例如 score 文件夹有 9~4，常用 9/8/7），在该子文件夹里保存一个 block（如“score 987”）作为 combo，在 Pool 点击其 ＋ 整体加入即可。两种方式并存：要整个文件夹用按钮，要固定子集用保存的 block。

## 收录与删除规则

1. **自动收录只收 tag，从不收结构。** 绑定池的 block 里即使有子 block（combo），也只是它里面的 tag 进入池；combo 本身要用户手动“保存到 Folder”才会成为池里的 block。不存在临时 block 被自动提升为持久化资产的情况。
2. **池只增不减。** 从 prompt 中删除或关闭 tag，不会从池中删除；要删只能在池里手动删。
3. 连续输入在完成编辑时提交，不收录中间拼写；打开已有 workflow 只建立基线，不重新加入用户在池里手动删掉的 tag。
4. 新收录的散装 tag 落在绑定层，之后用户可在 Library 中拖到子文件夹整理。
5. **收录范围：** 绑定了池的 block 负责收录自己的全部内容，**包括未绑定的子 block（递归）**；遇到**自己也绑定了池**的子 block，就停在那里，由该子 block 按自己的绑定收录。未绑定、且没有任何绑定祖先的 block 不参与收录。
6. **查重范围：** 收录前检查绑定 Folder 的整棵子树（本层、所有子文件夹、所有保存的 block 内的 tag），已存在就不加入。

例：`quality` 下有子文件夹 `score`；block A 绑定 `quality`，其子 block B 中写入 `score_9`：

| B 的状态 | 结果 |
|---|---|
| B 绑定 `quality/score` | 由 B 收录，进入 `quality/score`（已存在则不加） |
| B 未绑定，`score_9` 已在 `quality/score` | A 查重命中，不加入 |
| B 未绑定，`score_9` 是新 tag | 进入 `quality/` 本层（收件箱），用户之后再整理 |

## 散装 tag 去重规则

只约束 Folder 里的**散装 tag**，按祖先链约束：

1. **同一条祖先链上不重复。** 一个 Folder 和它的任何子孙 Folder 不能同时拥有同一个散装 tag。
   - 把散装 tag 从父 Folder 拖到子 Folder 是移动，不是复制。
   - 手动向子 Folder 添加一个其祖先 Folder 中已有的散装 tag：自动从祖先 Folder 移到该子 Folder（视为归类）。
   - 手动向父 Folder 添加一个其子孙 Folder 中已有的散装 tag：提示“已在 <路径> 中”，不添加。
2. **兄弟 Folder、不同分支的 Folder 之间允许重复**（如一个 artist 同时属于 `artist/厚涂` 和 `artist/日系`）。候选树的加入状态反映该 tag 是否在当前 block 中，多处出现时同步显示；再次添加不会制造重复副本。
3. **保存的 block 内的 tag 不受约束**（多个角色 block 都有 `blue eyes` 是正常的）。

自动收录加到绑定层，并对整棵子树查重；若该 tag 已作为散装 tag 存在于绑定层的某个祖先 Folder（例如绑定 `quality/score` 的 block 写入了已在 `quality/` 本层的 `score_9`），按第 1 条的手动添加规则处理：从祖先 Folder 移到绑定层。因此自动收录不会产生违反第 1 条的重复。

## Library 与 workflow 的关系

- 从 Library 插入到 workflow（或另一个 Library block）的是**副本**，带来源标记，提供“从库更新”和“覆盖回库”两个显式操作。实例可以自由本地编辑。
- Library 中的 block 之间**不互相引用**：block 里套的 block 就是真实包含的内容。暂不支持共享子 block，因此不需要指针和引用环检测。以后若确有需要，只增加一种“链接”引用。
- 编译只读 workflow 内的副本，不查询 Library。
- 没有保存到 Library 的 block 是临时的，删除就没了。保存是显式操作（新命名保存 / 覆盖保存 / save as new）。

## Library UI 调整

- Library 树只展示 Folder 和保存的 block（包括 subblock）；散装 tag 不作为树行展示。Folder / block 点击整行打开，不再提供齿轮按钮；折叠、预览和插入按钮各自执行对应操作。预览 icon 与其他按钮居中对齐，hover、聚焦或点击显示内部 tag；Folder 递归包含子文件夹及保存 block 的 tag，block 包含 subblock 的 tag。预览包含关闭项，不按随机设置抽取；隐藏散装 tag 后，搜索仍能定位其所在 Folder。
- 点击 Folder 打开池页面：只显示本层及 subfolder 的散装 tag，可直接编辑、删除、移动；子文件夹可折叠，折叠状态在编辑和重开后保留。使用紧凑行，不分成多块大卡片，不显示保存 block 或绑定 block 列表；block 从左侧 Library 打开。编辑子文件夹的 tag 保留原 ID 和存放层级。补全开关保留，Folder / block 编辑页使用与 Node 相同的中性主题。
- Folder 层级通过带底色和边框的紧凑标题、文件夹图标、缩进及竖向引导线区分；tag 行保留细分隔线，与文件夹标题区别显示。
- Library 列表、Folder 内容页、详情栏的候选树和内容子项都显示连续的祖先层级线及行首连接线，不只靠空白缩进；每层占一列，折叠后仍保留当前行的层级。Library 根行为第 1 层，聚焦 Folder / block 的内容页以当前对象为第 1 层。
- 2026-10-08：Library 和详情 Pool 的连续空中间 Folder 压缩成一行 `父 / 子 / 末端`。只有本层无 prompt / 保存 block、且恰好一个子 Folder 才能继续合并；隐藏的散装 tag 也会阻止合并，筛选后不按可见项误判。分支或有内容处停止。行首引导线按压缩后的可见层级显示，提示保留实际层级范围与完整路径。Library 各段名称仍可点击、双击固定标签、键盘打开及右键操作；预览 / 拖拽和 Pool“＋子 block”针对末端 Folder。只压缩显示，不修改真实层级、ID、绑定或路径。Folder 编辑页和 Content 不做此次压缩。
- 2026-10-08 更正：详情始终显示 Content，绑定 Folder 后另显示 Pool，取代先前合并为单一“内容”区的设计。Content 按 Document 实际顺序递归编辑 prompt / subblock；关闭项原位灰色划线，× 只删除当前副本，不删池。Pool 按目录显示候选，prompt 纵向排列；prompt / 保存 block 前用 ＋，加入当前 Content 末尾。已加入项持续变色并统一标明“已添加”，不区分启用与关闭；再次点击不重复添加、不重新启用、不改顺序。Pool 内保存 block 的子项只读预览，编辑在 Content 完成。提供全部展开 / 折叠，以及可组合的两种独立筛选：全部 / Prompt / Block 和全部 / 未加入。关闭项也算已加入。匹配递归查未绑定子 block，遇到另有池绑定的子 block 停止；prompt 匹配忽略单条 Weight / Schedule 并按 PLv3 展示统一空格/下划线，保存 block 按来源 ID 匹配。只用于候选状态和防重复，不改 Library tag 去重规则。目录和 block 共用图标、紧凑标题、折叠及层级线；本层名称显示，全路径放提示中。根 Folder 展开，子文件夹 / block 默认折叠，状态与筛选按文档和当前 block 保留。子 Folder“＋子 block”保留原语义。Pool 缺失或读取失败只显示错误，Content 继续可编辑。开关、加入及编辑保留详情对象和滚动位置，主动定位子 block 设置才切换对象。
- Block UI 的 header 在名称后用灰字显示保存 block 的 Library 完整路径，长路径省略显示并在提示中保留全文。来源 ID 优先查当前库路径，本机缺失时使用保存的来源路径；仅绑定 Folder 的临时 block 不显示池路径。
- Pool 类型与加入状态分别设计：Folder 是灰色目录标题及文件夹图标；未添加 / 已添加 Block 都保留立方体图标、蓝色边框标题和 block 类型牌；未添加 / 已添加 Prompt 都保留标签图标及轻量纵向文本行。已添加项统一使用绿色左侧标记和“✓ 已添加”实色标牌，未添加显示淡色“未添加”；不靠添加前后更换类型颜色来区分，仍不区分已添加项的开关状态。顶部紧凑图例显示 Folder / Block / Prompt。
- Block UI header 在名称前显示连接 icon，表示该 block 自身绑定 Folder；未绑定不显示，不从父 block 继承。它与名称后的保存 block Library 路径是独立信息；关闭或本机缺失 Folder 时仍保留绑定标记。
- Prompt 提交沿用 PLv3 node window 的条目处理：单条详情输入去掉首尾逗号和空白；逗号列表重新解析为独立 prompt，Library 分条存储，不把“solo, ”或“solo, blonde hair”存成额外条目。2026-10-08 确认输入便利：编辑时中文逗号先转成英文逗号再由 PLv3 拆分，literal 字符串、LoRA 名称、block 路径和 `.set` 配置保持原文；编译语法不改。句号分隔仍保留句号，attention / Schedule 的内部结构按 PLv3 处理。已有 Library / workflow 不在打开时自动改写，显式编辑提交才处理。
- Folder / block 的 hover 预览使用逗号分隔、自动换行的连续文本，不逐条占行、不附每条来源路径。标题只显示名称及条目总数/关闭数；关闭项淡色划线，内容多时在有高度上限的弹层内滚动，仍保留完整内容。
- 点击 block 打开与 node 共用的 Blocks 编辑界面，默认显示完整 block 和 subblock 内容，可直接编辑；Source / Preview、详情和原有保存流程仍沿用同一套实现。
- 单击 Library Folder / block 打开的中间标签是临时预览，名称用斜体标识；Folder 与 block 共用最多一个临时标签。点击另一个 Library 对象时替换原临时标签，常驻标签保留。编辑内容或设置、双击顶部标签、双击 Library 条目均使对应标签常驻；查看、切换视图和定位详情不会固定标签。切换前完成当前输入，已经编辑的草稿不得被替换丢失。工作流 node 标签保持原行为。
- Folder 右键：重命名、添加 subfolder、添加 Block、添加 tag、移动、Delete。Block 右键：重命名、添加 subblock、移动、Delete。
- Folder 条目提供与 Library block 同样样式的专用插入 handle（2026-10-08 更正）。从 handle 拖到编辑器目标位置，新建一个绑定该 Folder 的空 block；落在已有 block 内部时创建子 block，不修改目标原有绑定。删除拖入直接设置绑定的行为，已有 block 的绑定仍从详情/菜单显式设置。点击 Folder 名称或条目用于浏览，不发起插入拖拽。
- Block / 最后一个 subblock 的底部区域按实际插入线的纵向位置选择：从上往下依次是子 block 内部末尾、父 block 内部末尾、父 block 外侧；插入线和提示显示目标层级路径，避免重叠的卡片底部判定区导致顺序反转。
- Library block 的两种拖拽插入（保留结构 / 只插 prompts）保持不变。
- 全名路径用点号连接 folder / block / subblock 层级，PLv3 引用沿用 `[完整路径]: { ... }`。
- 同一父 Folder / block 下的 Folder、保存 block 和 subblock 不能重名，完整路径必须唯一；不同父级允许同名。创建、重命名、移动及保存出现冲突时拒绝并回滚。未命名子 block 在保存时获得 `Block`、`Block 2` 等不冲突的名称。workflow 的本地 block 副本按 Document ID 区分，不占 Library 的名称空间；Source 选取库对象使用完整路径，来源 ID 与 pool 仍随 Document 保存。

## 需求对照

| 需求 | 做法 |
|---|---|
| 1 artist 池 | Folder `artist/` 存散装 tag；prompt 中放一个绑定 `artist` 的 block，在 Pool 添加、Content 开关和编辑 |
| 2 分类 | 子文件夹 `artist/厚涂` 等 |
| 3 combo | 在 `artist/` 下保存一个 block，在 Pool 点击 ＋ 整体加入 |
| 4 常用提示词 | Folder + 散装 tag / 保存的 block |
| 5 角色 | 保存的 block，子 block 分姓名 / 外表 / 服装；换装时手动开关服装子 block；单条 tag 直接关开关 |
| 6 自动入池 | 绑定池的 block 写入新 tag 时自动收录 |

角色示例：

```
[角色: 星野]                    ← 保存在 characters/ 下
│ hoshino (blue archive)        ← 姓名
│ [外表]
│ │ pink hair, ahoge, ☐blue eyes   ← 单独关闭
│ [服装]
│ │ [☑ 校服] school uniform, ...
│ │ [☐ 泳装] swimsuit, ...
```

## 从现有实现中删除

- Class 实体、string / block / class 三类 attribute 及三段式 Class 详情页
- belong / load 的区分和互斥、dummy class F
- class instance 及其“只显示在 Class 下”的规则
- 写入 Class 的 block 自动持久化内部子 block、Class / block 之间的指针
- 跨类型引用环检测

## 对实施的影响

- 不受影响：Block UI、P1 文档与命令层、拖拽、Region / Schedule、PLv3 语法与编译。
- 需要改：P3 Library 数据模型（Class → Folder 池、block 增加 `pool` 设置、收录逻辑、候选树数据源、补全索引来源）；P4 迁移映射改为“旧 group → Folder，旧 preset → 该 Folder 下保存的 block，旧子组 → 子文件夹”。
- `pool` 属于 block 元数据，随 Document 保存；它只影响候选和收录，不影响编译结果。
