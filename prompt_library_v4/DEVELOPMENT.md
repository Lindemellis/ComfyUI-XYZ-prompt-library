# PLv4 内部维护说明

阶段收束：**2026-10-08**。用户确认本阶段结束，并要求更新内部文档、用户 README、Git 和 GitHub。P1–P4 及后续试用修正已经落地；旧“本次不改 README / 不提交”的限制仅适用于此前开发轮次。本文件描述当前实现，不再保留互相矛盾的逐轮补丁说明。

## 文档入口与优先级

- 用户手册：[中文](README_zh.md)、[English](README.md)。
- 需求记录：[plv4.md](../plv4.md) 末尾“新的block架构设定”及其后续明确更正，优先于早期 Class 方案。
- 实施记录：[plv4_plan.md](../plv4_plan.md)，P0 原型仅为历史设计依据，不是运行契约。
- 仓库维护规则：[AGENTS.md](../AGENTS.md)。本机 HANDOFF.md 是忽略提交的接续记录。
- PLv3 语言：[设计文档](../prompt_library_v3_design.md)、[手册](../prompt_library_v3/README.md)。V4 不另建语言或编译器。

当前运行模型只有 Tag、Block、Folder（池）。完整 Document 是独立保存入口，不是第四种 Library 树节点。Class 实体/属性页、attribute、belong/load、dummy、class instance、库间 block 指针、内部子 block 自动持久化和跨类型引用环检测均已删除。旧名称只允许出现在明确标注的需求历史或只读迁移代码中。

## 模块与路由

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
3. pool、来源和展示名称随 Document 保存，不参与语法编译。Library 不存在时已有 workflow 仍能编译。
4. V4 全部随机使用已解析的节点 seed，忽略组 seed。V3 未改动文档保留默认组 seed；经 V4 编辑且带 compiler=plv4 元数据的 V3 节点使用 V4 策略。
5. prompt/plain 仍调用同一个 PLv3 编译器。Region ambient/include_in_base、mask/couple、Schedule 区间、LoRA 和 dropout → random_select → shuffle 语义保持。
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

Library 仅显示 Folder/Block/subblock，散装 tag 隐藏于树但搜索可定位其 Folder。Folder 页只编辑本层和子 Folder 的散装 tag，不显示保存/绑定 Block 列表。Library Block 复用 Node 的完整 Blocks 编辑器，中性主题；预览为连续逗号文本、自动换行、限制高度，不为每项显示路径。

单击 Folder/Block 共用一个临时斜体标签；编辑、双击条目或标签固定。切换请求串行并先 flush；不能将未提交草稿替换掉。浏览、定位和视图切换不固定。保留树行/标签 DOM，否则重绘会吞掉双击。

Library/Pool 的空单子 Folder 链压缩只看实际数据：本层有任何 tag/Block 都阻止合并，不能用过滤后可见项判空。只改展示，不改 ID/路径/绑定；各段名称可操作，handle/预览及子 Block 按钮作用于末端 Folder。树行用连续祖先引导线，不只留空白缩进。

连续文本段共用 native RunSession。装饰 marker 必须 contenteditable=false，DOM 文本/选区映射排除装饰。用 break-spaces 保留空格；中文逗号仅在用户输入提交时清理，保护 literal、LoRA、路径和 .set，随后由 PLv3 解析拆条。首尾逗号不存入原子 tag，句号分隔保留句号。禁止打开库自动清洗历史数据。

尾部视觉 BR 不计入正文/光标；runEnd 只去掉一条结构性闭括号布局换行，不吞用户尾部换行。beforeinput 按真实逻辑选区处理换行 Backspace/Delete，忽略显示占位；旧粘贴 DIV/P 和普通字符仍走 native 编辑。SetEnabled 不允许根据 _layout_indent 触发整段格式化，必须保留空行。queued write 在父队列内再次检查有效性；Undo/dispose 使旧任务失效，flush 排空字段队列。

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

2026-10-08 收束离线回归：**513 pytest passed**，包含 t70–t79、10 个 Node 前端套件、t46–t62 的 PLv3 测试、t68 窗口兼容和 TagDB；ComfyUI Python 的 t69 CPU unittest **2 passed**。t69 直接核对虚拟 scale 解析，兼容不同 ComfyUI state_dict 是否枚举 sidecar。最新搜索/换行由真实 Python projection、Node 模拟宿主和 vendored Monaco 语义覆盖。38 个 Python、44 个 ESM 文件语法检查通过；维护/用户文档的本地链接逐项检查。

~~~powershell
python -m pytest test/t70_plv4_document_test.py test/t71_plv4_routes_test.py test/t72_plv4_frontend_test.py test/t73_plv4_node_test.py test/t74_plv4_assets_test.py test/t75_plv4_migration_test.py test/t76_plv4_asset_routes_test.py test/t77_plv4_hierarchy_test.py test/t78_plv4_test_tag_data_test.py test/t79_plv4_pool_examples_test.py -q
Get-Content -Raw js/plv4/window.js | node --input-type=module --check
# t69 需要真实 ComfyUI/torch 的 Python；不要求安装 pytest：
python -m unittest discover -s test -p t69_quantized_hook_compat_test.py -v
~~~

pytest.ini 限定离线 test/t*_test.py；manual 和网络诊断不属该范围。本轮没有浏览器或在线服务检查；早期浏览器数量不作为当前版本证据。

用户已确认本阶段结束。未来工作仍须按具体请求处理：大文档浏览器性能、个人资料库副本迁移、旧多 load 随机结构取舍，以及更广泛的 tag 身份规范化。现有精确 tag 身份不在本轮扩展。

GitHub release 的 latest 由 TagDB 数据集下载使用；常规代码发布通过 Git 提交/推送，不创建缺少数据资产的 release。避免破坏自动下载。
