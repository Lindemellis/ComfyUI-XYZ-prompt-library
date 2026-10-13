# PLV3 退役记录

开始日期：2026-10-11。当前源码状态：**V3 独立 Editor / Library 入口和自动运行服务已退役；旧节点作为兼容节点保留。** 正式 ComfyUI 重启及浏览器强制刷新后加载这次修改。

这里的退役对象是 V3 独立 Editor / Library 和旧版运行服务。PLv3 语言是 V4 Source 的语言，解析、Document、Schedule / Region / AVG、LoRA 编译和 Monaco 编辑器必须保留为共享能力。不能通过删除 `prompt_library_v3/`、`js/plv3/` 来完成退役。

## 兼容边界

- 保留 `XYZ Prompt Library V3` / `XYZ Prompt Library V3 Monaco` 节点身份，已有 workflow 能加载和执行。两种 V4 节点继续提供相同的输入顺序及 prompt / plain 输出。
- 未经 V4 编辑的 V3 Document 保留组 seed、LoRA 编译和错误回退策略。V4 使用节点 seed、集中 LoRA；不能把所有 V3 节点简单别名到 V4 执行类。
- 保留 Document 的稳定 ID、关闭项、原位顺序和非法草稿；不通过只保存 Source 迁移工作流。
- 个人 V2/V3/V4 数据库不自动迁移或删除。V3→V4 仍是显式备份导入；实验 V4 转换仍要求新副本。
- 复用同一 PromptEditor、语法、TagAC 和文本编辑操作，不复制实现。
- Attach Masks 继续只负责向 CLIP 挂载遮罩；LoRA Schedule / IMASK 的接线和编译语义不受退役影响。

## 第一步：启动与节点定义（已完成）

1. 根 `__init__.py` 分别调用 V4 与 V3 setup，先注册 V4。V3 数据库初始化失败不再跳过 V4 服务。
2. `prompt_library_v4/setup.py` 自己注册 Document、Library、LoRA 路由及共享 Monaco 静态资源，不经 V3 setup 或 V3 route register。
3. `prompt_shared/routes.py` 接管 Monaco，保留 `/xyz/plv3/monaco/` URL 和 `plv3_monaco` route name，按 server 去重。V3 单独注册仍可加载 Monaco；两种注册顺序均可用。
4. `prompt_shared/node_schema.py` 提供两代节点共用的输入/输出定义；V4 不再继承 `_PLv3Base`。V3 执行和缓存逻辑仍归兼容节点所有，V4 仍归 V4 所有。
5. `test/t82_plv3_retirement_test.py` 使用临时库和真实 aiohttp 请求检查独立 V4 启动、两种注册顺序及根初始化遇到 V3 setup 故障。无个人数据库、模型或常驻实例写入。

验证：定向 43 passed；完整离线 913 passed / 3 skipped in 61.08s（开发解释器缺 torch / PyAV）。12 个 Python 文件语法和 diff --check 通过；对照 Git HEAD 核实两代节点 inputs / outputs / category / function / tooltips 完全一致。本轮无前端变化，未重跑真实 ComfyUI 浏览器或实际采样。

第一步当时尚未移走语言或停用旧入口；之后第二步完成这些分离及产品退役。部署后端修改需要重启 ComfyUI；开发验证不自动重启正式 8188 或持久 8190，不提交或推送。

## 第二步：共享能力分离及产品退役（已实现）

1. `prompt_shared/language/` 是 PLv3 语言的唯一后端实现：lexer / parser / diagnostics / Document / AST JSON / validate / IR / compile 逐文件搬迁，不改随机、Schedule / Region / AVG / LoRA 语义。旧 V3 import 路径用模块别名指向同一对象，兼容类身份、纯函数和既有 monkeypatch。
2. `prompt_shared/storage.py` 接管通用 SQLite PRAGMA、connections 和 WriteQueue。V4 直接使用共享存储；V3 历史库保留兼容导出及自己的 schema / repo ops。V4 `_v3.py` 与触发词直接读取共享语言，不导入 V3 产品模块。
3. `prompt_shared/language_routes.py` 接管纯 compile / ast / doc sync / toggle，保留原 URL、回复和 Monaco 静态资源。根初始化和 V4 setup 都能独立注册，不打开 V3 DB；旧 V3 routes 只转发语言 handlers，并保留显式历史 Library registration 供测试/工具使用。
4. `js/prompt_shared/node_host.js` 安装所有四种节点的 Editor、隐藏 doc、嵌入 Monaco 和文本同步。`js/plv3.js` 仅导入共享宿主，`js/plv4.js` 也导入，ESM 保证注册一次。复用原 PromptEditor / text_editing / grammar / TagAC，不复制编辑器。保留旧 widget / event / action IDs。
5. V4 Monaco/native 路径补全只使用 V4 Library；未经 V4 打开的旧节点只保留语言语法补全。共用编辑器不再 blur-sync V3 Library，撤下旧“保存选中内容为 V3 库组”右键动作，展开只接受 V4 session。停止旧库后的使用路径已明确。
6. V3 Tools 的 Editor / Library 入口和 `window.plv3` 撤下。V3 两种节点保留原 identity / sockets / widgets / execute / cache，并标 DEPRECATED，供旧 workflow 继续加载执行。所有 Editor 按钮打开 V4；仅加载旧 V3 workflow 不转换规则，显式 V4 打开采用 V4 policy 并保留 ID 和关闭项。
7. Monaco 模型改用节点对象，编辑事件附带节点对象；旧数字 ID 事件仍兼容。不同 workflow 复用同一 ID 不共享模型，嵌入与窗口仍共享同一个模型并按引用数释放。
8. 根不再调用 V3 setup，V3 Library routes 不注册，V3 DB / writer 不自动创建、升级或打开。只在显式备份导入时由迁移 adapter 读取旧 Library；迁移不需要重启旧产品。所有个人资料、历史源码和持久 8190 原样保留。

## 保留的路径与维护边界

第二步验证：完整离线 **927 passed / 3 skipped in 59.71s**；V3/V4/共享语法及 diff --check 通过，11 个搬迁纯语言实现与发布 HEAD 逐字一致（换行归一化），所有旧 import 与共享实现保持 module identity。一次性真实 ComfyUI 的退役专门检查 **34 项**及实际鼠标 Header 菜单 **25 项**通过；原生 focus、Source 结构和非法草稿、Schedule/Library 补全、D/G/L 合并、IME Shift 默认、LoRA 语法和三窗口层级/设置通过。实际 Prompt Control + synthetic CLIP 的 AVG / pooled / schedule / region / LoRA 验证通过；ComfyUI Python 的量化 hook 2 tests OK。

完整测试发现历史 V3 保存文档 op 仍依赖 `time`，提取 WriteQueue 时保留该 import 后，迁移 suite 与最终全量通过。浏览器脚本对 D/G/L 合并采用有上限的完成等待，避免同时跑其他浏览器时固定 120ms 过早读取；实际所有候选断言保留。未加载个人模型、采样、自动迁移或启动/停止正式实例及持久 8190。最终开发实例和独立浏览器已关闭，验收记录在 `E:/AI/ComfyUI-aki-v2/.codex-backups/plv3-retirement-check-20261011-122903/`。

原生编辑套件最终在全新 `E:/AI/ComfyUI-aki-v2/.codex-backups/plv3-retirement-edit-check-20261011-124829/` 独立复核通过，初次 workflow restoration 等待和异步候选等待保留。反复写入 Catalog 的重试库曾出现候选 / Folder chooser 时序失败，最终基线使用新临时库；两个实例均已关闭。

| 路径 | 当前用途 |
|---|---|
| `prompt_shared/language/`、`language_routes.py`、`storage.py` | 当前共享后台能力；没有旧 Library 生命周期 |
| `prompt_library_v3/node.py` 与语言 alias | 老 workflow 节点和 import 兼容；不能直接别名到 V4 execute |
| `prompt_library_v3/{db,repo,library,routes,migrate_v2}` | 历史 schema、资料转换及显式工具；默认启动不注册 Library |
| `js/prompt_shared/`、`js/plv3.js` | 共用节点宿主及历史 extension URL adapter |
| `js/plv3/{editor_core,text_editing,complete,language,monaco,theme,ui,settings,tagac_monaco}` | 单一共享前端实现，V4 正在使用；文件名不要求重命名 |
| `js/plv3/{window,library,detail,editor,preview}` | 保留的历史 UI 代码，当前产品不暴露独立窗口 |
| V4 `migrate_v3.py` / `migrate_v4.py` | 显式备份导入及实验库副本转换；禁止自动同步个人资料 |

## 验收范围

- 没有 V3 Library DB / setup / Library 路由时，V4 的 Editor 按钮、嵌入 Monaco、Source、Blocks、Preview、LoRA 浏览器仍工作；V4 操作不请求旧 Library。
- 普通与 Monaco 节点、workflow 重载、节点对象重用、doc 序列化、开关及跨视图 Undo/Redo 不回归。
- 检查原生输入 / caret、IME 边界、Blocks Find、More 真实鼠标点击、Library Pool / 保存 / 补全以及 LoRA Send 的真实浏览器流程。
- 保留 V3 / V4 编译回归，涵盖随机 seed 区别、Schedule、Region、IMASK、AVG、LoRA 调度、prompt/plain 和非法草稿。
- 用实际 Prompt Control 的解析 / synthetic CLIP 验证调度和区域；不向正式库或 workflow 部署 fixture，不加载个人模型或采样。
- 迁移工具使用临时数据库验证备份与旧 Library 展开；个人资料迁移需单独明确请求。
- 更新根 README、V4/V3 README、DEVELOPMENT、AGENTS 和 manual 入口，准确区分“兼容节点”“共享语言”和“已退役 UI”。

## 历史代码与资料保留

同日按后续“文档保存为block”请求，将导入的 5 份 Document 另存为同名普通 Block，原 Document 保留，内部内容 / 节点 ID / enabled / 顺序完整保存。正式库现在为 53 Folder / 608 tag / 45 Block / 5 Document。包装带来的 Shuffle 路径变化已告知用户；随机配置本身未改。备份及 Document→Block 对照位于 `E:/AI/ComfyUI-aki-v2/.codex-backups/plv4-documents-as-blocks-20261011-121515-c4d69f/`。

2026-10-11 用户随后明确要求导入个人 V3 Library，已完成**正式安装**的显式迁移：15 Folder / 38 group / 629 item（610 prompt + 19 ref）/ 38 preset / 5 document → V4 新增 53 Folder / 608 tag / 40 Block / 5 Document。先备份两边 SQLite（包含 WAL）并在副本试导入，再经现有 migrate_v3 和 WriteQueue 正式导入。610 条原 prompt 全部覆盖，全部预设映射存在，5 份文档内容 / ID / 关闭项保留；V3 原库逻辑摘要不变，目标 integrity / foreign_key 检查通过，无迁移警告。备份和报告位于 `E:/AI/ComfyUI-aki-v2/.codex-backups/plv3-library-import-20261011-120850-6cd654/`。当时正式 8188 与持久 8190 均未运行，本次未启动/重启它们；8190 测试资料未迁移。此次导入当时尚未退役 V3 入口；后续第二步完成源码中的产品退役。此次导入不授权自动同步其他资料库。

- V1 / V2 完整源码在 Git 历史：V1 删除提交 `0d42797` 的父提交、V2 退役提交 `f7797fc` 的父提交可恢复。无需把旧运行代码重新装回当前节点目录。
- 当前根 `__pycache__/` 还有 `prompt_library_node.cpython-311.pyc`、`prompt_library_node.cpython-312.pyc`、`prompt_library_v2_node.cpython-311.pyc`。它们是缓存而非完整源码备份，不参与本次准备工作。
- `prompt_library_v2_data/` 是个人 V2 数据，`prompt_library_v3_data/_old_demo/` 是旧示例库，均保留。
- `prototypes/plv4/` 和未跟踪的旧 Class-era manual 脚本是本地历史原型，保留且不发布。
- 持久 8190 安装还保留实验 `plv4.db` 等历史数据；不因退役准备而停止实例、清库或转换这些文件。
