# Prompt Library V4

[English](README.md) | **中文**

用嵌套 Block 编辑提示词，保存常用组合，并把新标签收录进 Folder 池。V4 沿用 [PLv3 语言](../prompt_library_v3/README.md)，最终编译为 [comfyui-prompt-control](https://github.com/asagi4/comfyui-prompt-control) 语法。

## 开始使用

1. 安装 comfyui-prompt-control，更新节点包后重启 ComfyUI。
2. 在 `XYZNodes/Prompt` 添加 **XYZ Prompt Library V4** 或 **XYZ Prompt Library V4 Monaco**。Monaco 版本在节点内嵌源码编辑器；两者的编译器和输出相同。
3. 点击节点 **Editor**，或通过 **XYZ Tools → Prompt Library V4 — Editor** 打开窗口，再选择节点标签。
4. 在 **Blocks** 编辑内容，在 **Source** 编辑完整语法，在 **Preview** 查看编译结果。三种视图共用文档和撤销历史。

`prompt` 输出保留编译后的区域；`plain` 把区域内容合成一段提示词，仍保留权重、Schedule 和 LoRA。V4 的全部随机选择使用节点 seed，也支持连接的 seed；忽略组内 seed 覆盖。

隐藏 Document 随 workflow 保存，包括关闭项、名称、池绑定和库来源。关闭内容保留原位，再开启即可恢复；分享 workflow 不需要 Library 数据库。非法 Source 草稿保留供修正，生成时报告语法错误。

## Block 和设置栏

Block 按顺序包含 prompt 和 subblock。可以折叠、启停、直接编辑文字或打开设置；选中文字后用 **Create as block** 原位分组。拖拽移动时，插入线标明目标位置和层级。

每个 Block 都有 **Content**：按文档实际顺序显示 prompt / subblock，可递归编辑，关闭项原位灰显或划掉。开关负责启停，**×** 删除当前副本的内容。权重输入框左右的 **− / +** 每次增减 **0.05**，也可直接输入。

Region 和 Schedule 设置默认展开，并记住手动折叠状态。Region 父 Block 的设置也包含各 Region 子 Block 的区域参数。PLv3 Region / Schedule 语法不变。

名称前的连接图标表示该 Block 自身绑定 Folder；名称后的灰字是保存 Block 的 Library 路径。只有池绑定的临时 Block 不显示库来源路径。

在 Blocks 按 **Ctrl+F / Ctrl+H** 搜索或替换显示出来的 prompt 内容；Source 搜索完整源码，包含配置字段。**Enter** 与下箭头都跳转并高亮下一项；**Shift+Enter** 与上箭头跳转上一项。在 Block 正文输入 Enter 正常换行；设置栏开关保留空行。

输入沿用 PLv3 拆分规则：逗号分隔条目；后面是空白或文本末尾的句号也分隔，但句号保留。编辑普通 prompt 时中文逗号先转英文逗号，再拆分。引用字符串、LoRA 名称、库路径和 `.set` 配置保留各自语法。打开已有数据不自动整理它。

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
