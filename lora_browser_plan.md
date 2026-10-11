# PLv4 独立 LoRA 浏览器

## 已确认行为

- 不依赖 LoRA Manager。独立窗口从 XYZ Tools 和 PLv4 Editor 打开。
- 左侧按 ComfyUI 配置的全部 LoRA 根目录展示真实目录树；名称/路径搜索、分页卡片。
- 卡片封面和 Send；详情展示多图、civitai.red 模型/版本链接、触发词池编辑和 Send。
- 磁盘目录用于浏览；可编辑 Folder 是触发词池，支持子 Folder，不移动模型文件。
- 首次编辑/发送才创建池，不批量建库。资料优先读取模型旁已有 sidecar；缺失资料可按需用 SHA256 查询 Civitai，缓存在 XYZ 数据目录。
- 多套触发词组合按 Civitai / sidecar 作者条目自动装入兄弟子 Folder，保留每套完整提示词和权重；共享角色词允许在兄弟 Folder 重复，组合不要求共享词。原子短 tag 数组仍在本层，顶层 `,,` 只作旧格式兼容；优先角色名、之后服装名 / 编号。再次导入保持身份与自定义内容；旧平铺池只在显式导入或明确修复时归类，修复保留已删除 / 改写的词。
- 目标仅当前 workflow 的 PLv4 节点，默认当前编辑节点；Send 顶层末尾插入，一次撤销。同一模型重复发送定位已有 block，必要时启用祖先和 block，保留权重/内容/位置。
- LoRA block 拥有真实调用项与 prompt 内容、单个池绑定、独立 model/CLIP strength；Schedule 同时作用于调用和触发词。父级随机选择以整个 block 为单位。
- 调用项是该 block 的固定内容，Blocks/Content 隐藏调用文本，以专用设置编辑。Source 仍是完整 PLv3；Source 显式移除调用即解除特殊 block 身份。
- 文档及 Library 快照保留 LoRA 结构，不需要 Library 或浏览器才能编译。Pool 删除不删除已有 workflow 内容。
- V4 输出将选中的 LoRA 引用集中到末尾；按来源语法节点去除 Region ambient 复制，不合并用户显式写出的不同调用。V3 未编辑文档保持旧行为。

## 执行顺序

1. 已完成：模型目录/本地 sidecar/多图、安全媒体路由、按需 Civitai 查询；独立窗口和可直接 Send 的卡片。
2. 已完成：单写者池创建、沿用 Folder 页编辑；LoRA 文档命令、设置、节点会话和撤销。
3. 已完成：语义编译、Schedule/随机/区域去复制，离线 Python/Node 回归；更新用户与维护文档。

## 当前验证边界

2026-10-10 用户确认后续功能与输入 / 菜单修复完成，授权更新文档、GitHub 和正式 ComfyUI。最新全量离线回归 **909 passed / 3 skipped**，覆盖 LoRA / AVG / 共享补全及 V3 兼容；正式安装与最新浏览器结果统一记录于 [DEVELOPMENT.md](prompt_library_v4/DEVELOPMENT.md)。以下数字是各实现步骤当时的记录，不代表当前完整浏览器验收。

2026-10-10 初版：独立 headless Chrome、真实 DOM 和临时库 API 共 20 项通过。当时完整离线回归 855 passed / 3 skipped；节点默认选择的小修复由 7 项 Node 测试复核。外部 Civitai 查询失败恢复已有测试，真实模型采样不在本轮收尾验证范围。

同日触发词自动分组更新：用户提供的三套完整 outfit、两种 metadata 表达、旧平铺池显式整理、共同词/局部去重、改名/删除/手工追加保留、同名避让、literal/attention 边界均通过；完整离线回归 **861 passed / 3 skipped**，未操作个人数据库。此前浏览器验证覆盖现有 Folder 页与子 Folder，本次只修改后台导入。

后续多角色修正：Civitai 官方版本 API 3058459 与本地 sidecar 确认作者已提供五个独立数组条目；废除“共享至少两个词才分组”的猜测，保留作者组合边界，并覆盖无重叠 / 括号 attention / 混合原子替代项 / 角色命名。最终 **865 passed / 3 skipped** 和 **32 项实际浏览器检查**通过。按用户修复请求，快照后通过实例 API 整理当前四个错误平铺的池，原资产 ID 全部保留、手工删改不恢复；实例已更新并重启。

## 验收

- 多根目录、同名文件冲突、缺失预览/损坏元数据、越界路径、按需查询失败可恢复。
- 卡片无需打开详情发送；多节点选择正确，异步期间切换 workflow/移除节点不写错目标。
- 重复发送、关闭祖先、编辑权重、Undo/Redo、Library 保存/载入、删除池和无需数据库编译。
- model/CLIP strength、继承 Schedule、父随机选 m/n、LoRA block 自身随机只影响正文、ambient 区域复制只产生一次调用；原 V3 回归不改变。
- 不改个人模型/sidecar/Library 数据；不重启或重建用户的持久测试实例。
