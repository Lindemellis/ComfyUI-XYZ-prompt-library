# 隔离 PLv4 样例与测试辅助

这些脚本不属于默认 pytest 离线测试入口。日常回归见 [V4 内部维护说明](../../prompt_library_v4/DEVELOPMENT.md#验证与后续边界)。t78/t79 只调用辅助函数并使用临时数据库，不操作个人库或已运行的实例。

| 脚本 | 用途和边界 |
|---|---|
| prepare_xyz_test_comfy.py | 向独立 root 复制代码，不复制个人凭据；本地 TagDB 以 SQLite backup 独立复制，已有非空测试库不替换 |
| start_xyz_test_comfy.ps1 | Windows 整合包布局的 XYZNodes-only 实例启动/重启/停止；默认 CPU、8190，停止前核验 PID/命令行 |
| seed_xyz_test_samples.py | 从本机隔离实例的旧实验 V4 原件转换到新 Folder 池库和 workflow；新目标存在则不覆盖 |
| update_xyz_pool_examples.py | 仅修整已转换的隔离副本并补池绑定示例；先备份，保留稳定 ID、关闭项和用户编辑 |
| build_xyz_class_library.py | 生成全新的 Folder/Class/Block 测试库、四组节点文档及可选第五组 LoRA 固定 Class 示例；要求 DB/manifest 目标不存在。不会自动安装或覆盖现有库；测试实例替换必须获用户明确请求、先备份并停止对应实例 |
| import_xyz_artist_library.py | 用户明确请求的个人 artist-only V3 导入：prepare 在线备份源/测试库并在副本预演，apply 仅允许 8190 HTTP 单写者，保留旧示例、新建 artist/Class/tentacle 和模型 Folder。完整组/预设只含启用内容，原始词去重进入 Class；不会自动转换或写正式库 |
| import_xyz_v3_remaining.py | 继续将非 artists 根子树导入测试 Library 的 plv3 Folder，保留原目录、组/Class 与预设；保存 Document 转成完整提示词子 Folder 的 Block，保留原 ID/开关。先备份/预演，再仅用 8190 HTTP 单写者新增；完整提示词外包 Block 会改变路径随机顺序，使用受控 RNG 核对内容语义，不修改运行编译器 |
| publish_xyz_v3_imports.py | 用户明确验收授权后，从两批 V3 导入记录选择资产并读取当前内容/位置；排除旧测试示例，构建新正式库，核对绑定、640输出、完整性。仅在正式服务停止且源/目标摘要未变时安装，旧正式 DB/WAL 保留备份；不复制整个测试库，不自动启动正式服务 |
| plv4_regroup_lora_pools.py | 明确修复旧平铺 LoRA 池：默认只读规划；--apply 必须指定新的 --snapshot 文件；通过实例单写者归类现存词，不恢复已删 / 改写词、跳过已有生成分组 |
| plv4_comfy_fixture.py / plv4_edit_browser_check.cjs | 一次性真实 ComfyUI fixture 和独立 Chrome profile，验证焦点、Source、D/G/L、LoRA 补全及窗口顺序；要求 object_info 含 Fixture Capture，拒绝长期实例 |
| plv4_mask_comfy_fixture.py / plv4_mask_browser_check.cjs | Mask Library 专用 disposable CPU ComfyUI；准备/启动使用相同 PLV4_FIXTURE_ROOT，浏览器使用 PLV4_BASE_URL，必须有 Fixture Capture/Mask Preview。临时 input 合成图片，独立 Chrome 真实绘制/resize/排序/取消/关联/共享刷新/实时预览/稳定连线，自动关闭浏览器 |
| plv4_mask_execution_check.py | 参数为上述 disposable URL，必须有 Mask Fixture Capture；无模型实际执行两次 preview/attach 链，检查 512×512、半图像素、未使用零遮罩、CLIP clone 和 IMASK warning；仅写 fixture temp |
| plv3_retirement_browser_check.cjs | 一次性真实 ComfyUI fixture，V3 Library endpoint 必须为 404；独立 Chrome 验证四种兼容/新节点的 Editor、嵌入模型、关闭项/ID、Undo、Preview、V4 库补全、非法草稿、LoRA Send 与 workflow reload，并检查无旧 Library 请求。无需个人模型或采样 |
| plv4_class_browser_check.cjs | 一次性真实 ComfyUI fixture（PLV4_BASE_URL），要求 object_info 含 Fixture Capture；独立 Chrome 验证 Folder/Class 图标、整理页/池页、绑定反查、子 Class、快照加入/撤销、自身排除、移动、补全和 LoRA Class。自动关闭独立浏览器，不接受长期实例 |
| plv4_separator_browser_check.cjs | 一次性真实 ComfyUI（PLV4_BASE_URL）或 LoRA fixture（LORA_TEST_URL）；独立 Chrome 验证中英文逗号、Enter、重开续写与 Undo / Redo，覆盖普通 / 空 Block 和三种容器 entry；Pillow 只读截图检查行中 / 行尾 / 逗号后 / 空格后 / 连续 Enter 的真实光标位置，验证空行单次 Backspace / Delete、重开与纯文本粘贴尾部换行；PLV4_TEST_PYTHON 可指定 Python。真实 Comfy fixture 准备和启动必须设置相同 PLV4_FIXTURE_ROOT |
| plv4_menu_browser_check.cjs | 独立浏览器验证 Header 更多菜单悬停展开、移入子菜单、切换分组、同级 / 子级真实添加、entry 边界、窗口边缘翻转及外侧关闭；实际鼠标按下 / 松开验证添加后及正文编辑后单击另一个更多菜单，并核对正文保存 |
| plv4_mixed_browser_check.cjs | 一次性真实 ComfyUI fixture；真实 Header 同级/子级单击、移动保留空行、子 Block 后及之间续写/撤销、四种文字与 Block 混合排列和 Source 往返。拒绝长期实例，独立 Chrome 自动关闭 |
| plv4_content_click_browser_check.cjs | 一次性真实 ComfyUI fixture；编辑 Content prompt、切换另一个 prompt 或编辑正文后，真实鼠标单击第二个 prompt 的 enable/删除，核对 Document 与 UI 状态及前序草稿保存。拒绝长期实例，独立 Chrome 自动关闭 |
| plv4_input_layout_browser_check.cjs | 一次性真实 ComfyUI 或 LoRA fixture；检查空正文首次输入与 blur / 重绘后的字号、颜色、行高和 padding，以及反复 focus / blur 的逐字位置，覆盖普通正文和三类容器 entry。独立 Chrome profile 自动清理 |
| plv4_lora_fixture.py / plv4_avg_browser_check.cjs | 一次性模型 / Library fixture，设置 LORA_TEST_URL 后验证 AVG 创建、权重、撤销、entry 边界、库保存和正文 Source blur；独立浏览器 session 自动关闭 |
| plv4_avg_promptcontrol_check.py | 用 ComfyUI Python 运行实际 Prompt Control 解析 / 编码管线，合成 CLIP 提供微型已知张量；验证 AVG 权重、pooled、时间 / 区域 / LoRA 组合，不加载模型或采样 |

样例创建和更新脚本是本机既有样例的维护工具，不是新安装的通用个人库迁移命令。V3 用户迁移使用 Library 的明确确认入口；早期 V4 数据迁移使用要求新目标的副本转换器。没有旧样例时不需要运行样例维护工具。

8190 是用户长期保留的验收实例，不能当一次性浏览器 fixture。不要为离线检查启动、停止或重置它。早期 attribute/belong/load Class-era browser scripts / 原型截图仅为本地历史遗留，不作为当前 Folder/Class 模型入口。

Mask Library 后续修复定向入口：`plv4_mask_repair_browser_check.cjs`（真实坐标精度、普通/绑定 Class/Region entry/父页的绑定和重开、只读、所属画布、一次跨位排序与长列表自动滚动、英文标题/导航/直接操作）；`plv4_mask_imask_browser_check.cjs`（手动 IMASK 的父页输入/整数校验/绑定隐藏/解除恢复，以及原生 Rename 表单实际提交）。两者沿用上述 disposable Mask fixture 和 PLV4_BASE_URL，独立 Chrome 在 finally 关闭。

`plv4_region_enabled_browser_check.cjs` 使用上述一次性 Mask fixture，真实鼠标切 Region 功能、真实 Ctrl+Z/Ctrl+Y、工作流重开、Source/Blocks 切换，验证 entry/ID/参数/库引用保留、Unused 连线、重新开启最新库坐标和图片设置预览。仅访问 PLV4_BASE_URL 指定且有 Fixture Capture 的一次性实例，独立 Chrome 自动关闭。
