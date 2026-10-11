# 隔离 PLv4 样例与测试辅助

这些脚本不属于默认 pytest 离线测试入口。日常回归见 [V4 内部维护说明](../../prompt_library_v4/DEVELOPMENT.md#验证与后续边界)。t78/t79 只调用辅助函数并使用临时数据库，不操作个人库或已运行的实例。

| 脚本 | 用途和边界 |
|---|---|
| prepare_xyz_test_comfy.py | 向独立 root 复制代码，不复制个人凭据；本地 TagDB 以 SQLite backup 独立复制，已有非空测试库不替换 |
| start_xyz_test_comfy.ps1 | Windows 整合包布局的 XYZNodes-only 实例启动/重启/停止；默认 CPU、8190，停止前核验 PID/命令行 |
| seed_xyz_test_samples.py | 从本机隔离实例的旧实验 V4 原件转换到新 Folder 池库和 workflow；新目标存在则不覆盖 |
| update_xyz_pool_examples.py | 仅修整已转换的隔离副本并补池绑定示例；先备份，保留稳定 ID、关闭项和用户编辑 |
| plv4_regroup_lora_pools.py | 明确修复旧平铺 LoRA 池：默认只读规划；--apply 必须指定新的 --snapshot 文件；通过实例单写者归类现存词，不恢复已删 / 改写词、跳过已有生成分组 |
| plv4_comfy_fixture.py / plv4_edit_browser_check.cjs | 一次性真实 ComfyUI fixture 和独立 Chrome profile，验证焦点、Source、D/G/L、LoRA 补全及窗口顺序；要求 object_info 含 Fixture Capture，拒绝长期实例 |
| plv4_separator_browser_check.cjs | 一次性真实 ComfyUI（PLV4_BASE_URL）或 LoRA fixture（LORA_TEST_URL）；独立 Chrome 验证中英文逗号、Enter、重开续写与 Undo / Redo，覆盖普通 / 空 Block 和三种容器 entry；Pillow 只读截图检查行中 / 行尾 / 逗号后 / 空格后 / 连续 Enter 的真实光标位置，验证空行单次 Backspace / Delete、重开与纯文本粘贴尾部换行；PLV4_TEST_PYTHON 可指定 Python。真实 Comfy fixture 准备和启动必须设置相同 PLV4_FIXTURE_ROOT |
| plv4_menu_browser_check.cjs | 独立浏览器验证 Header 更多菜单悬停展开、移入子菜单、切换分组、同级 / 子级真实添加、entry 边界、窗口边缘翻转及外侧关闭；实际鼠标按下 / 松开验证添加后及正文编辑后单击另一个更多菜单，并核对正文保存 |
| plv4_input_layout_browser_check.cjs | 一次性真实 ComfyUI 或 LoRA fixture；检查空正文首次输入与 blur / 重绘后的字号、颜色、行高和 padding，以及反复 focus / blur 的逐字位置，覆盖普通正文和三类容器 entry。独立 Chrome profile 自动清理 |
| plv4_lora_fixture.py / plv4_avg_browser_check.cjs | 一次性模型 / Library fixture，设置 LORA_TEST_URL 后验证 AVG 创建、权重、撤销、entry 边界、库保存和正文 Source blur；独立浏览器 session 自动关闭 |
| plv4_avg_promptcontrol_check.py | 用 ComfyUI Python 运行实际 Prompt Control 解析 / 编码管线，合成 CLIP 提供微型已知张量；验证 AVG 权重、pooled、时间 / 区域 / LoRA 组合，不加载模型或采样 |

样例创建和更新脚本是本机既有样例的维护工具，不是新安装的通用个人库迁移命令。V3 用户迁移使用 Library 的明确确认入口；早期 V4 数据迁移使用要求新目标的副本转换器。没有旧样例时不需要运行样例维护工具。

8190 是用户长期保留的验收实例，不能当一次性浏览器 fixture。不要为离线检查启动、停止或重置它。旧 Class-era browser scripts / 原型截图仅为本地历史遗留，不随本阶段发布，也不作为当前 Folder 模型入口。
