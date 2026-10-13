# PLV4 P0 视觉原型

UI 设计已于 2026-10-06 确认结束。此版本作为后续实现的视觉与交互基准，下一阶段进入 P1；P0 适配层和本地示例仍不等于正式实现。

2026-10-07：原型的完整样式已原样移至 `js/plv4/design.css`，Block 框架、Class 属性页及详情折叠逻辑提取至 `js/plv4/design_components.js`。本原型与正式 PLv4 窗口直接共用这些代码；外观修改应修改共用文件。原型本地状态仍用于演示，正式窗口使用文档命令与数据库适配层。

Prompt 和空 block 的原始 contenteditable 组件及焦点事件也已提取到共用文件。正式版保留单击直接输入、新 block 自动聚焦的原交互，数据写入由正式文档命令接管；不使用额外的添加 prompt 弹窗或双击编辑入口。

双击 `start-preview.cmd`，打开 `http://127.0.0.1:8766/prototypes/plv4/nested.html`。这是当前的嵌套设计实验；`index.html` 保留此前的平铺布局实验。也可在仓库根目录运行 `python prototypes/plv4/serve.py`。直接打开 `nested.html` 仍可使用 Block UI，完整 Monaco 需要本地预览地址。

初始示例包含人物 → 服饰 → 配饰的三层嵌套，以及父级在子 block 前后的文本、Schedule 和 Region 容器。默认以细层级线显示，可以在顶部切换为嵌套卡片比较空间占用。

当前版本模拟 ComfyUI 画布上的浮动窗口，默认约 960×640，支持拖动标题栏移动、拖动边缘缩放。顶部可以选择 720×500 等窗口尺寸。Library/Details 均可收起，打开时向窗口外侧添加各自的宽度，空间足够时保持编辑区宽度及位置；触及浏览器边缘时整体调整位置和宽度，两侧始终占用独立列，不变成覆盖编辑区的抽屉。 Library / Text editor、Text editor / Details 之间各有 6 px 的全高分隔拖拽柄，悬停高亮；拖动只重新分配相邻栏宽度，保持整个浮动窗口的位置和大小。宽度有最小值保护，并保存在本地；关闭 / 打开面板恢复所选宽度，窗口缩小时自动压缩以保留编辑空间。分隔柄聚焦后也可用左右键调整。

每个 block 都有固定 Header。最左是 26×22 px 的折叠按钮，使用 16 px 箭头；后面显示名称（无名称则留空）、Schedule / Region 类型及参数标记。Header 直接显示 Enable、详细设置、添加同级 block、添加子 block 和“更多操作”。“更多操作”包含 Save、Delete、Assign class、Load class，按文字自适应宽度（当前约 84 px），紧贴按钮右边缘展开。Schedule / Region 只显示类型标记；Shuffle、随机、Schedule、Region 的功能设置留在详情面板。Header 高 23 px，按钮保持单行，名称过长时省略并保留悬停完整名称。子 block 的拖拽边缘与父级间距约 7 px；prompt 字号仍为 13 px。只压缩 Header；单行正文区域至少 36 px（约为 Header 的 1.6 倍），文字上下各留 7 px，以正文作为视觉主体。

Header 下方，block 内容区整条左侧边缘是 6 px 宽的 drag handle，覆盖内容或折叠摘要的完整高度。鼠标进入时整条边缘发光并显示抓取光标，可拖动整个 block，保留移入、移出和完整 prompt 之间的落点。没有额外的右侧浮动工具栏。

详情顶部仅一行可编辑的 Block 名称和关闭按钮；Format 与输入框同一行，无重复路径及说明段落。每条 prompt 的行末有删除按钮，包含关闭的 prompt，可撤销 / 重做。Class 设置栏也提供 Assign class 和 Load class。Schedule 容器直接显示时间段、启用和范围编辑，共用边界同步相邻段；Region 容器直接显示各区域的 kind、IMASK / 矩形、feather、mask / cond weight、include in base。新增 / 删除时间段维持连续边界，新增区域使用正确区域结构。普通视图移除节点路径与数量行，仅聚焦子树时显示返回路径。

单击 block 空白处直接打开该 block 的详情；子 block 空白处定位子级，不误选父级。单击 prompt 仍定位对应 prompt 的详情。

横向分栏拖拽截图为 `pane-resize-preview.png`。当前截图为 `header-preview.png`，展示压缩后的 Header 和缩进；`class-menu-preview.png` 展示更多操作菜单；`schedule-details.png` / `region-details.png` 展示专用详情。Monaco 截图为 `monaco-preview.png`；其余截图保留旧方案供比较。

已检查 960×640 / 720×500、两种嵌套样式、各示例 block 展开/折叠共 104 种布局：Header 控件没有重叠或横向溢出，文字位于 Header 下方，drag handle 从 Header 底部覆盖内容完整高度。另检查了大折叠按钮、Enable、父子关闭状态、详情及直接操作按钮、空白点击、边缘发光、block 移入/移出，以及实际 Monaco 的加载和语法解析。

Library 编辑页面：

- 点击 Library block，在中间打开紫色的 Library block 编辑区，并在右侧显示设置。保留 Block UI / 真实 Monaco / 输出示意模式。根 block 不显示同级新增，不能拖动整个根 block；子 block 的结构操作照常使用。Monaco 原稿必须保持一个根 group，额外根内容会保留为未完成草稿并阻止切走。
- Library 中 Class 可展开 / 折叠，归属它的 Library blocks 称为 class instance，只在 Library 中固定显示于 Class 下，不再平级列出；Class attributes / Block attributes 是引用，不决定存放位置：被引用对象按自己的 folder 或 Class 归属显示，在 Class 详情页提供打开入口。Class 名称打开属性页，箭头只展开树；搜索保留匹配项的祖先路径，全部展开 / 折叠包含 Class。
- 点击 Library class，在中间打开金棕色的 Class 属性页，隐藏 Block UI / PLv3 模式及右侧 block 设置。三组列表依次是 Block attributes、Class attributes、Prompt attributes；不列出 class instance。属性支持编辑、删除及新增；Block attribute 的名称只作为打开入口，在该 Block 自己的详细设置中改名。Class instance 可从 Library 打开，通过自身 Assign class 设置解除归属。
- 顶部在原有节点页签位置标识 LIBRARY BLOCK / LIBRARY CLASS，支持返回 Class 或 Workflow。Class 名称直接在紧凑的原模式栏编辑。Library 修改、撤销与本地存储使用现有原型状态，node 示例内容不会因编辑 Library block 而改变。
- 本地 Class 的自动收录按源内容变更更新；手动编辑、删除 attribute 后，不会被无关的保存覆盖或立即补回。正式共享引用、数据库同步和并发冲突仍留待实装。
- 截图：`library-block-preview.png`、`library-class-preview.png`。

可操作内容：

- 节点分页及溢出菜单、Library 搜索/排序/折叠。
- block 折叠、开关、详情；关闭父级不改写子项自己的开关。
- 右击 block 后选择“聚焦这个 block”，通过面包屑返回。
- Header 显示名称、类型、Enable 和设置，直接提供新增同级 / 子 block；Save / Delete / Assign class / Load class 放在“更多操作”。点击空白处打开对应详情。
- 普通 block 通过 Header 下方的整条左侧边缘移动到 prompt 之间、其他 block 前后或另一父级；落点提示显示目标父级。
- Library 的 ▣ 插入完整 block，≡ 递归展开启用 prompts 并保留单条权重。插入不改变来源资产。
- 右击 prompt/block 定位详情；选择同父级连续 prompts 后右击组成 block。
- PLv3 模式直接复用 `js/plv3/editor_core.js` 的 `PromptEditor`，使用仓库内的 Monaco、PLv3 高亮、配色、行号、折叠和调权重命令。完整文本编辑同步回 Block UI；语法未完成时保留原稿，阻止切换视图丢失内容。
- 两种 Library handle 可拖入 Monaco 的完整 prompt 边界。Monaco 右击菜单可打开详情、将同父级连续完整 prompts 用 `{}` 包成 block。
- Block UI 支持结构操作和文本修改的撤销/重做；Monaco 内使用自身的编辑撤销栈。
- 修改与本原型 Library 存在浏览器 localStorage 中；顶部可重置示例。

当前边界：

- 不连接 ComfyUI、个人资料库或现有 PLv3 数据。
- `serve.py` 只服务原型、现有编辑器资源，以及无状态的 PLv3 解析/编译/文档同步。不会注册正式节点或连接个人资料库。原型适配层把 Monaco worker 地址转换为绝对地址，未修改正式编辑器。
- Block UI 与 Monaco 的映射仍为 P0 适配层；复杂原稿、关闭项随跨父级移动、所有语法形式的无损往返和统一跨视图撤销，仍需 P1 正式命令层验证。Monaco 编辑期间保留原始排版；通过 Block UI 修改结构时重新生成文本。
- 输出预览明确是启用文本示意，不执行随机、Format、Schedule、Region 编译。
- Class 使用浏览器本地示例：Assign 单选、Load 多选且互斥；Assign 的内容会自动写入本地 Class 候选，Load 展开各 Class 的候选树；attribute class 逐条选 prompt，attribute block 启用后才可操作子项。关联与候选操作支持本地持久化和撤销。正式资料库指针、事务、全局同步及补全留待实装。
- 特殊 Schedule/Region 容器及其直属 entry 的拖拽暂时限制；下一轮验证时间边界和特殊头的移动规则。普通子组仍可在合法的普通组间移动。
- 当前主要验证短文本及两三层布局；深层、长文本、100/500 block 压力测试和完整无损语法往返留待正式实现阶段验证。

本轮已用浏览器检查面板开合保持编辑区宽度、操作栏位置、父子开关、折叠、普通 block 移入/移出、真实 Monaco 全文编辑与回切、右击详情和分组、未完成语法保留、两种 Library 拖入 Monaco、Unicode 文本定位、节点分页切换、720×500 窗口及 760 px 浏览器宽度、窗口移动与缩放。页面无运行时错误。

本轮验证了更多操作菜单、两处 Class 入口、单选 / 多选与模式切换、Assign 内容进入候选、嵌套候选的父子开关、关联刷新后保持、关闭 prompt 删除及撤销 / 重做，以及 960×640 / 720×500 下正文高度与 Header 的比例。

已验证左右分隔柄实际拖动、悬停提示、键盘调整、相邻栏宽度变化、窗口位置及大小保持、宽度刷新后保持、面板开合后的宽度恢复、最小宽度约束、720×500 及 760 px 浏览器宽度下无栏目覆盖，以及 Monaco 随栏宽更新。

本轮验证 Library block 的设置、嵌套插入、文本修改、撤销 / 重做、真实 Monaco 往返、单根约束及未完成稿保留；Class 的三组 attribute 顺序、各类属性编辑 / 删除、刷新后保持及返回 Workflow；并回归检查节点编辑、Class 候选、分栏拖拽及 720 px 窗口。
