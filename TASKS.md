# XYZ Image Gallery — TASKS

> 基于 `PROJECT_SPEC.md` 与 `ARCHITECTURE.md` 拆解的开发任务清单。
> 每个任务粒度 1–2 小时，定义清晰的输入 / 输出与可独立测试的验收标准，
> 标注依赖、优先级（P0 / P1 / P2）和是否属于 MVP。
>
> **MVP 范围 = `MVP-L0` + `MVP-L1` + `MVP-L2` + `MVP-L3`**（共 25 个任务标记为 ✅ MVP）。
> **Pre-L4 stabilization（v1.1）**：`T29–T37`（按 **后端 → 列表过滤 → 目录 → 网格 → 下载 → 设置/主题 → 详情** 分层，见 **§ Pre-L4**）；**阻塞 L4 的理由**见 `PROJECT_SPEC §11.2` / `PROJECT_STATE.md`。
> **Updated due to v1.2**：`T38+`（**§ v1.2 — Design & system polish**）在 **v1.1 QA 通过** 后执行；**以** `PROJECT_SPEC §12` **与** `ARCHITECTURE` §7 **为规格**，**不** 改写本文 **T01–T37** 已闭合条目。
> L4（性能与长尾）任务在文末以 P2 列出，**非 MVP**；**v1.1 起默认在 Pre-L4 完成或并行策略落地后再启动**（此前队列冻结）。
>
> 图例：
> - 优先级：**P0** 阻塞下游 / 不做就没法继续；**P1** 必做但可短暂滞后；**P2** 体验或规模优化
> - MVP：✅ 必须完成 / ❌ 非必须
> - 依赖：列出**直接前置**任务 ID

---

## 总览（MVP 关键路径）

```
L0  ─►  L1（只读回路 + WriteQueue 底座）  ─►  L2（编辑 + 实时 + 异步同步）  ─►  L3（批量 + 心跳）
                                                                  │
                                                                  ▼
                                                    Pre-L4（T29–T37，见 § Pre-L4 分层）─►（其后）L4（T26–T28）
```

| 阶段 | 任务 ID | 名称 | 优先级 | MVP |
| --- | --- | --- | --- | --- |
| L0 | T01 | gallery 包骨架 + 数据目录引导 | P0 | ✅ |
| L0 | T02 | 顶栏按钮 + 占位路由 | P0 | ✅ |
| L1 | T03 | `db.py` Schema v1 + 迁移框架 + PRAGMA | P0 | ✅ |
| L1 | T04 | `repo.WriteQueue` + Single Writer | P0 | ✅ |
| L1 | T05 | `paths.py` + `folders.py` + 配置持久化 | P0 | ✅ |
| L1 | T06 | `metadata.py` PNG 读路径 | P0 | ✅ |
| L1 | T07 | `indexer.py` 冷启动扫描 + 指纹短路 | P0 | ✅ |
| L1 | T08 | `thumbs.py` 按需生成 + `thumbnail_cache` 表 | P0 | ✅ |
| L1 | T09 | `repo.py` 读 API + 游标分页 + 过滤 SQL | P0 | ✅ |
| L1 | T10 | `routes.py` 只读端点（页 / 图 / 缩略图 / 原图 / 目录） | P0 | ✅ |
| L1 | T11 | SPA shell + 路由 + `api.js` | P0 | ✅ |
| L1 | T12 | `MainView`：`FolderTree` + 过滤器面板 | P0 | ✅ |
| L1 | T13 | `VirtualGrid` + `ThumbCard` | P0 | ✅ |
| L1 | T14 | `DetailView` + 缩放 + `/neighbors` | P0 | ✅ |
| L2 | T15 | `vocab.normalize_prompt` + Schema v2 词表 | P0 | ✅ |
| L2 | T16 | Schema v3 迁移：`metadata_sync_*` 列 + 部分索引 | P0 | ✅ |
| L2 | T17 | `metadata.py` 写路径 + `metadata_sync.py` Worker + 重试 | P0 | ✅ |
| L2 | T18 | `ws_hub.py` + WebSocket 路由 | P0 | ✅ |
| L2 | T19 | `PATCH /image/{id}` + `/resync` + `service.update_image` | P0 | ✅ |
| L2 | T20 | `watcher.py` Observer + `Coalescer` | P0 | ✅ |
| L2 | T21 | `/vocab/*` 端点 + `Autocomplete` + tag / prompt 过滤 | P1 | ✅ |
| L2 | T22 | 前端：编辑 UI + 同步徽标 + WS 订阅 + 焦点对账 | P0 | ✅ |
| L3 | T23 | `Selection` 包络 + `/bulk/favorite` + `/bulk/tags` + `BulkBar` | P1 | ✅ |
| L3 | T24 | 两阶段 bulk move + `MovePicker` + 增量提交 | P1 | ✅ |
| L3 | T25 | bulk delete + `ConfirmModal` + 审计日志 + `HeartbeatThread` | P1 | ✅ |
| Pre-L4 | T29 | **索引卫生**：衍生物路径排除 + 误入库清理；仅 `gallery_data` 侧画廊缓存 | P0 | ✅ |
| Pre-L4 | T30 | **词表 v1.1**：`normalize_prompt` 第 4 步废弃 + 全库 `prompt_token` 再衍生 | P0 | ✅ |
| Pre-L4 | T31 | **列表过滤（后端）**：`FilterSpec` / SQL / wire 参数；metadata 三元；prompt 三模式；`_`→空格 | P1 | ✅ |
| Pre-L4 | T32 | **列表过滤（前端）**：MainView 控件、URL 镜像、三模式 Autocomplete 策略 | P1 | ✅ |
| Pre-L4 | T33 | **目录（全栈）**：文件夹 HTTP 变更 + 树折叠/右键/OS 打开（可选） | P1 | ✅ |
| Pre-L4 | T34 | **网格交互**：框选/Shift、拖放到目录、缩略图上下文菜单 | P1 | ❌ |
| Pre-L4 | T35 | **下载（全栈）**：服务端导出变体 + 统一客户端触发（默认策略，不依赖 Settings） | P1 | ✅ |
| Pre-L4 | T36 | **设置与偏好**：子页、dev 模式、过滤器可见性、tag/root 管理、**主题与全局视觉** | P1/P2 | ✅ |
| Pre-L4 | T37 | **详情页**：元数据置顶、positive 原文/归一化切换、内联文件名/tag/favorite | P1 | ✅ |
| L4 | T26 | `thumbs.Scheduler` LIFO 视口优先 + 取消 + LRU 淘汰 | P2 | ❌ |
| L4 | T27 | `indexer` 元数据解析 ProcessPool 化 | P2 | ❌ |
| L4 | T28 | FTS5 显式分词器 + tag-AND / prompt-AND 自适应查询 | P2 | ❌ |
| v1.2 | T38 | **Design system + Dark 全页控件**（Main/Detail/Settings 滚动条/输入） | P0 | ✅ |
| v1.2 | T39 | **FolderTree 图式**（icon、层级、悬停/选中） | P1 | ✅ |
| v1.2 | T40 | **统一 IconButton** + 替换 `← Back` 待办视觉 | P1 | ✅ |
| v1.2 | T41 | **[x]** **`?` 浮层说明**（**descoped · 已关闭**，见 §T41） | P1 | ❌ |
| v1.2 | T42 | **清理 dev 文案/占位**（name filter 等）+ 审计全页 | P0 | ✅ |
| v1.2 | T43 | **抗闪烁 + 对账审计**（WS 门控、减少无因 `resetAndFetch`） | P0 | ✅ |
| v1.2 | T44 | **ProgressModal** + **统一 Job 模型**（`bulk.*` / `index.progress` / `job.*`）+ **`GET /jobs/active`** + **批量 metadata 审计**（对齐 T43） | P0 | ✅ |
| v1.2 | T45 | **Line view** + section 规则 + folder 非递归分桶 + compact 切换 | P1 | ✅ |

---

## L0 — 骨架可联通

### T01 · gallery 包骨架 + 数据目录引导  ✅ MVP · P0

**输入**：现有 `ComfyUI-XYZNodes/__init__.py`；`PROJECT_SPEC §6.3`、`ARCHITECTURE §1 / §3.1 / §4.1`。

**输出**：
- 新建 `gallery/__init__.py`（装配入口，幂等），导入即：
  - 创建 `gallery_data/` 目录（不存在则建），含 `thumbs/` 子目录；
  - 创建空 `gallery.sqlite` 占位（不建表，留给 T03）；
  - 暴露 `setup(app)` / `start_background_services()` 钩子函数（先空实现，后续任务填充）；
- `ComfyUI-XYZNodes/__init__.py` 在加载现有节点之后调用 `gallery.setup(...)`，**异常被捕获并记日志**，绝不阻断现有节点。

**依赖**：无

**测试**：
1. 重启 ComfyUI，主界面节点全部可用；
2. `gallery_data/`、`gallery_data/thumbs/`、`gallery.sqlite` 自动出现；
3. 第二次启动是幂等的（无重复创建错误）；
4. 故意让 `gallery.setup` 抛错，ComfyUI 仍正常启动，日志可见错误。

---

### T02 · 顶栏按钮 + 占位路由  ✅ MVP · P0

**输入**：`PROJECT_SPEC FR-1 / FR-2`；`ARCHITECTURE §1 / §2.2`。

**输出**：
- `js/gallery_topbar.js`：通过 `app.registerExtension` 在顶栏注入按钮，标签 `Gallery`，带图标（用现成的 SVG 即可）；点击 `window.open('/xyz/gallery')`；
- `gallery/routes.py`：注册 `GET /xyz/gallery` 返回最简 HTML，文本 `Hello Gallery`；
- `gallery/__init__.setup()` 调用 `routes.register(PromptServer.instance)`。

**依赖**：T01

**测试**：
1. ComfyUI 顶栏出现 `Gallery` 按钮；
2. 点击后新 Tab 打开，URL 为 `/xyz/gallery`，页面显示 `Hello Gallery`；
3. `curl /xyz/gallery` 返回 200。

---

## L1 — 最小只读回路 + 写入底座

### T03 · `db.py` Schema v1 + 迁移框架 + PRAGMA  ✅ MVP · P0

**输入**：`PROJECT_SPEC §6.1`；`ARCHITECTURE §2.1 / §5.1`；约束 C-4。

**输出**：
- `gallery/db.py`：
  - `connect_read(path)` / `connect_write(path)`：统一应用 `journal_mode=WAL`、`synchronous=NORMAL`、`temp_store=MEMORY`、`mmap_size=256MiB`、`busy_timeout=5000`；
  - 版本化 `migrate(conn)`：读 `PRAGMA user_version`，按 `MIGRATIONS` 列表前向执行；
  - `MIGRATIONS[1]` 创建 `image`、`folder` 两张表 + 全部 `INDEX(...)`（按 §6.1）。
- `gallery/__init__` 在启动时调用一次 `db.migrate(...)`。

**依赖**：T01

**测试**：
1. 首次启动 → `user_version=1`，表结构与索引正确（`PRAGMA index_list`）；
2. 删除 DB 文件再启动 → 自动重建；
3. 手动把 `user_version` 改为 0 再启动 → 重新跑迁移成功；
4. 并发开两个只读连接 + 一个写连接 → 不报 `database is locked`。

---

### T04 · `repo.WriteQueue` + Single Writer  ✅ MVP · P0

**输入**：`ARCHITECTURE §2.1 / §4.6 / 附录 C.1`。

**输出**：
- `gallery/repo.py`：
  - `class WriteQueue` 内嵌 `PriorityQueue<(priority, seq, op, future)>`；优先级 `HIGH=0/MID=1/LOW=2`；同优先级 FIFO（单调 `seq`）；
  - `enqueue_write(priority, op) -> Future` 公共 API；
  - **## UPDATED** — 守护线程 `_writer_loop` 改为 **"一 op 一事务"** 模型：每次从队列取出 **1 条** op，严格按 `BEGIN → op.apply(conn) → COMMIT` 执行；失败则 `ROLLBACK` + `future.set_exception(...)`，**绝不**与其他 op 共享事务；废弃原先"drain 64 条 / 5 ms 单事务 + `SAVEPOINT` 包装"的批事务模型，避免任何 op 部分成功 / 部分回滚导致的数据不一致；
  - **## UPDATED** — 优先级队列、单调 `seq` FIFO、饥饿防护等调度逻辑保持不变（仅事务边界从"一批"收紧为"一条"）；
  - 饥饿防护：处理 LOW 累计 ≥ 200 条且队列内有 HIGH/MID 时让出；
  - `start()` / `stop()` 由 `gallery/__init__` 控制；线程崩溃自动重启 + 错误日志；
  - 提供基础 op 工厂：`UpsertImageOp`、`UpdateImagePathOp`、`DeleteImageOp`（占位空实现，T07/T19/T24 填 SQL）。

**依赖**：T03

**测试**：
1. 单元：1000 个 LOW + 10 个 HIGH 混入 → HIGH 平均出队延迟 < 20 ms；
2. **## UPDATED** — 单元：op.apply 抛异常 → 仅该 op 自身事务 `ROLLBACK`、对应 future 拿到异常；其前后相邻 op 各自独立 `BEGIN/COMMIT`，**不存在**"同批回滚"或"部分提交"中间态（用 `pragma data_version` 或显式断点验证事务边界）；
3. 单元：同优先级 1000 条按 enqueue 顺序拿到结果（验证 FIFO）；
4. 关停信号：`stop()` 后写线程在 200 ms 内退出。

---

### T05 · `paths.py` + `folders.py` + 配置持久化  ✅ MVP · P0

**输入**：`PROJECT_SPEC FR-5/6/7、NFR-19、C-5、C-10、§10 Q5`；`ARCHITECTURE §2.1`。

**输出**：
- `gallery/paths.py`：`assert_inside_root(path, roots) -> Path`，做 `Path.resolve()` + 落点校验；非法抛 `SandboxError`。
- `gallery/folders.py`：
  - 启动时确保 `output/` 与 `input/`（取自 `folder_paths`）作为 `kind in ('output','input')` 写入 `folder` 表（`removable=0`）；
  - 自定义根 CRUD：`add_root(path)` 校验目录可读、不与已有根**互为祖先 / 后代**（默认禁止重叠）；
  - `gallery_data/gallery_config.json` 读写（人类可读，含 `roots`、`prompt_stopwords`、`vocab_version`）。

**依赖**：T03

**测试**：
1. 首启自动注册 `output` / `input`；
2. 加同一路径两次 → 第二次报冲突；
3. 加 `output` 的子目录 → 拒绝（重叠）；
4. `paths.assert_inside_root('../etc/passwd', roots)` 抛 `SandboxError`。

---

### T06 · `metadata.py` PNG 读路径  ✅ MVP · P0

**输入**：`PROJECT_SPEC FR-23 / §10 Q3`；`ARCHITECTURE §2.1`。

**输出**：
- `gallery/metadata.py`：纯函数 `read_comfy_metadata(path) -> ComfyMeta`，从 PNG `tEXt` / `iTXt` 抽取 `prompt` / `workflow` / `parameters` 等；
- 派生 `positive_prompt / negative_prompt / model / seed / cfg / sampler / scheduler / has_workflow`（来源优先级：`workflow` JSON > `parameters` 文本 > 空）；
- 同时返回原始 `xyz_gallery.tags` / `xyz_gallery.favorite`（若存在），供 T07 mirror 回 DB；
- 失败容忍：损坏 / 非 PNG 返回部分字段 + `errors` 列表，不抛。

**依赖**：T01

**测试**：
1. 喂 ComfyUI 生成的 PNG（含 workflow）→ 解析齐全；
2. 喂只含 `parameters`（A1111 风格）的 PNG → 仍能解析关键字段；
3. 喂普通 JPG / 损坏 PNG → 返回空字段 + 错误列表，不抛；
4. 函数无副作用（多次调用结果完全一致）。

---

### T07 · `indexer.py` 冷启动扫描 + 指纹短路  ✅ MVP · P0

**输入**：`PROJECT_SPEC §8.1 / NFR-1 / NFR-8 / C-3`；`ARCHITECTURE §2.1 / §3.1 / §4.7`。

**输出**：
- `gallery/indexer.py`：
  - **## UPDATED** — 模块内维护 `_inflight: set[str]` + `_inflight_lock`，作为 **inflight 去重屏障**：所有进入索引流水线的入口（`cold_scan` 内单文件处理、`delta_scan` 触发的 `index_one`、以及 T20 watcher 回调）在调度前必须先把 **规范化后的绝对路径**（`os.path.realpath` + `os.path.normcase`）尝试加入 `_inflight`；若已存在 → **直接跳过本次请求**（不入队、不解析）；处理完成后必须在 `finally` 中移除该路径，**无论成功、异常、还是指纹短路跳过**，确保不残留；
  - `cold_scan(root)`：在后台线程 `os.walk` 注册根，每文件先 `stat()`；如 `(size, mtime_ns)` 与 DB 行匹配 → 跳过；否则调用 `metadata.read_comfy_metadata` → 组装 `UpsertImageOp` → `repo.enqueue_write(LOW, op)`；
  - 第一版**单线程解析**（ProcessPool 留给 T27）；批次 500 条文件触发一次进度统计；
  - `delta_scan(root, mode='light')`：仅 `(size, mtime_ns)` 比对，发现差异调用 `index_one(path)`；
  - `UpsertImageOp.apply(conn)` 实现：写 `image` 行（含 mirror 回的 favorite/tags_csv），并维护 `folder_id` / `relative_path`；
- 启动时 `gallery/__init__` 为每个根调度一次 `cold_scan`（不阻塞）。

**依赖**：T04, T05, T06

**测试**：
1. 5000 张图的 `output/` 首启全量索引 < 60 s（单核），ComfyUI 主循环不卡；
2. 重启 → 几乎 0 写入（指纹短路），DB 行数不变；
3. 替换 1 张图 → 下次 `delta_scan` 只重写 1 行；
4. 整个过程无 `database is locked`；
5. **## UPDATED** — 对同一文件并发触发 50 次 `index_one(path)` → `_inflight` 内同一 path 至多出现一次，实际 `UpsertImageOp` 入队仅 1 次；处理结束后 `_inflight` 不残留该路径；故意让 `metadata.read_comfy_metadata` 抛异常，`_inflight` 仍被 `finally` 清理（下一次同 path 请求可以正常进入）。

---

### T08 · `thumbs.py` 按需生成 + `thumbnail_cache` 表  ✅ MVP · P0

**输入**：`PROJECT_SPEC §8.3 / §6.1 thumbnail_cache`；`ARCHITECTURE §2.1`（LIFO 留给 T26）。

**输出**：
- `db.MIGRATIONS[2]`：建 `thumbnail_cache(hash_key PK, image_id, size_bytes, created_at, last_accessed)` + 两个索引；
- `gallery/thumbs.py`：
  - `request(image_id) -> bytes | path`：缓存命中直接返回路径；未命中 → Pillow 生成 WebP（最长边 320，q=78，cover 裁剪）→ 落盘到 `thumbs/<2 字符分片>/<sha1(path+mtime_ns)>.webp` → `enqueue_write(LOW, InsertThumbCacheOp)`；
  - `touch(hash_key)`：把 hash_key 加入内存 set，**10 s 周期 flush** 一次 `UPDATE thumbnail_cache SET last_accessed=...`（合并为单条 `executemany`）；
  - 第一版生成是阻塞的（在 `run_in_executor` 内），**FIFO** 调度器留待 T26；
- LRU 淘汰阈值留 TODO（T26 实现）。

**依赖**：T03, T04, T07

**测试**：
1. 首次请求 → 生成 + 落盘；同一 mtime_ns 二次请求 → 命中磁盘；
2. `last_accessed` 在 10 s 内被 flush 一次（不是每次请求都写）；
3. 修改原图（mtime_ns 改变）→ hash_key 改变 → 重新生成；
4. 1000 次并发请求同一 id → 不发生重复生成（同 key 串行）。

---

### T09 · `repo.py` 读 API + 游标分页 + 过滤 SQL  ✅ MVP · P0

**输入**：`PROJECT_SPEC §6.2 / §7.3 / §8.4`；`ARCHITECTURE §2.1 / §4.2`。

**输出**：
- `gallery/repo.py` 增量增加（**只读连接**，不进 WriteQueue）：
  - `get_image(id) -> ImageRecord`；
  - `folder_tree(include_counts) -> [FolderNode]`；
  - `list_images(filter, sort, cursor, limit) -> (items, next_cursor, total_estimate)`：
    - 支持 `name`（`filename_lc` 字面子串 ``instr``，全长度；长查询留 FTS5 给 T28）、`favorite`、`model`、`date_after/before`、`folder_id + recursive`；
    - `tag` / `prompt` AND 过滤本任务先用最简 `EXISTS`（rarest-first 留 T28）；
    - 排序键 `name|time|size|folder` 配合稳定 `(sort_key, id)` 游标；
    - `total_estimate`：25 ms 预算内做 `COUNT(*)`，超时返回近似标志。
  - `neighbors(id, filter, sort) -> {prev_id, next_id}`。

**依赖**：T03, T07

**测试**：
1. 单元：构造 1 万行假数据，所有过滤维度组合 P95 < 100 ms；
2. 翻页 50 次 → 不出现重复 / 缺失 id；
3. 中途插入新行 → 游标仍稳定；
4. `neighbors` 在结果集首尾正确返回 `null`（不环绕，`PROJECT_SPEC FR-16` 的 wrap 由前端做）。

---

### T10 · `routes.py` 只读端点（页 / 图 / 缩略图 / 原图 / 目录）  ✅ MVP · P0

**输入**：`PROJECT_SPEC §7.1 / §7.2 / §7.3 / §7.4 / §7.10`；`ARCHITECTURE §2.1 / §4.2`。

**输出**：
- `gallery/routes.py` 增加：
  - `GET /xyz/gallery` → 返回 `gallery_dist/index.html`（T11 才有真内容，先返回占位也行）；
  - `GET /xyz/gallery/static/*` → 静态文件；
  - `GET /xyz/gallery/folders[?include_counts=true]`；
  - `GET /xyz/gallery/images?...`、`GET /xyz/gallery/images/count`；
  - `GET /xyz/gallery/image/{id}` + `GET /xyz/gallery/image/{id}/neighbors`；
  - `GET /xyz/gallery/thumb/{id}?v=...` 设 `Cache-Control: public, max-age=31536000, immutable`；
  - `GET /xyz/gallery/raw/{id}` 支持 HTTP `Range` + `Content-Disposition: inline`；同时 `/raw/{id}/download` 用 `attachment`；
  - `GET /xyz/gallery/image/{id}/workflow.json` 提取 PNG 中的 workflow，404 if absent；
- 统一错误信封 `{ "error": { code, message, details? } }`；
- 任何 > 5 ms 的工作走 `loop.run_in_executor`（C-2）。

**依赖**：T08, T09

**测试**：
1. `curl` 跑通所有端点；
2. `Range: bytes=0-1023` 返回 206 + `Content-Range`；
3. 并发 50 个 `/thumb` 请求 → 不阻塞 `/folders`；
4. 请求不存在 id → 404 且响应体符合错误信封；
5. ComfyUI 主功能（出图）在并发请求下无明显抖动（事件循环健康）。

---

### T11 · SPA shell + 路由 + `api.js`  ✅ MVP · P0

**输入**：`PROJECT_SPEC §7.1 / NFR-16 / C-9`；`ARCHITECTURE §2.2`。

**输出**：
- `js/gallery_dist/index.html`：HTML shell + importmap（Vue 3 ESM）+ `<script type="module" src="/xyz/gallery/static/app.js">`；
- `js/gallery_dist/app.js`：挂载根组件、初始化 hash 路由（`#/`、`#/image/:id`）、装配 stores；
- `js/gallery_dist/api.js`：`get/post/patch/delete` 封装、错误信封解析、`AbortController` 支持；`openWS()` 建立 `/xyz/gallery/ws`（T18 之前可先 stub）；
- `routes.serve_spa` 改为返回真实 `index.html`。

**依赖**：T10

**测试**：
1. 打开 `/xyz/gallery` → SPA 加载，浏览器无 404、无 console 错误；
2. 切换 `#/image/123` 与 `#/` → 视图切换；
3. `api.get('/folders')` 拿到 JSON；非法响应抛友好错误；
4. 不依赖任何 `npm install`（全部 ESM CDN / 本地 js）。

---

### T12 · `MainView`：`FolderTree` + 过滤器面板  ✅ MVP · P0

**输入**：`PROJECT_SPEC FR-3a~f / FR-5~8`；`ARCHITECTURE §2.2`。

**输出**：
- `views/MainView.*`：左侧栏 + 右侧网格容器；
- `components/FolderTree.*`：树形渲染、选择、递归切换（FR-7 第一项）；
- 过滤器面板：name / favorite (`all|favorite|not favorite`) / model 下拉 / 日期 before-after 双开关；
- prompt / tag 输入先做最简 `<input>`（autocomplete 留 T21）；
- `stores/filters.*`：`FilterSpec + SortSpec`；filter 状态写 URL query（FR-4）+ `localStorage` 持久化；
- 折叠状态持久化（FR-2.2.1）。

**依赖**：T11

**测试**：
1. 选择 / 取消选择目录 → 网格内容改变（哪怕暂时只改 query 字符串）；
2. `localStorage` 清空再刷新 → 默认状态；
3. URL 直接带 `?favorite=yes` 进入 → 过滤器面板复现；
4. 折叠 / 展开过滤面板，刷新仍保持。

---

### T13 · `VirtualGrid` + `ThumbCard`  ✅ MVP · P0

**输入**：`PROJECT_SPEC FR-9a/b/c / FR-11~13 / NFR-5/6`；`ARCHITECTURE §2.2 / §3.2`。

**输出**：
- `components/VirtualGrid.*`：基于 `IntersectionObserver` 的虚拟滚动；可视视口 ± 2 屏；总高度 = 估算总数 × 卡片高；按需 `api.get('/images', cursor)` 续翻；
- `components/ThumbCard.*`：`<img loading="lazy" decoding="async">`、`object-fit: cover`、文件名截断 + tooltip、右上角收藏切换（先调用 `PATCH` 由 T19 实现，没就先桩函数）、左键打开详情（hash 路由）、右键菜单占位（菜单项 T24/T25 接）；
- 顶部工具栏：每行卡片数滑块（FR-9a）、排序下拉（FR-9b）；timeline 布局（FR-9c）留 P2（T28 之后）。

**依赖**：T11, T12

**测试**：
1. 50 000 行假数据下滚动顺畅，DOM 节点数稳定在视口 × 3；
2. 改每行数量 → 网格立即重排；
3. 改排序键 → 重新拉数据，游标重置；
4. 左键卡片 → 跳详情；右键 → 出菜单（哪怕先空）。

---

### T14 · `DetailView` + 缩放 + `/neighbors`  ✅ MVP · P0

**输入**：`PROJECT_SPEC FR-16 / FR-17 / FR-19`；`ARCHITECTURE §2.2`。

**输出**：
- `views/DetailView.*`：左图右元数据 2 栏；
- 左：原图 + 缩放（fit / 1:1 / + / -）+ 平移；上一张 / 下一张按钮调用 `/image/{id}/neighbors`，**保持当前 filter+sort**；首尾 wrap（前端做）；
- 右：只读元数据列表 + 各字段 copy-to-clipboard 按钮（positive / negative / seed）；
- 底部按钮：`Download image`（链接 `/raw/{id}/download`）、`Download workflow`（点击调 `/image/{id}/workflow.json`，无则 disable）、`Back`（恢复列表滚动位置 + 选中态：用 `sessionStorage` 暂存）；
- `Delete` 按钮先桩（待 T19 / T25）。

**依赖**：T11, T12, T10

**测试**：
1. 进入详情、按上一张 / 下一张能在当前 filter+sort 内循环；
2. Back 回到主视图，滚动位置与选中卡片复位；
3. 复制按钮把对应字段写入剪贴板；
4. 无 workflow 的 PNG 详情页，下载 workflow 按钮置灰。

---

## L2 — 可编辑 + 实时 + 异步同步

### T15 · `vocab.normalize_prompt` + Schema v2 词表  ✅ MVP · P0

**输入**：`PROJECT_SPEC §8.8 / §6.1 tag* / prompt_token*`；`ARCHITECTURE §2.1`。

**输出**：
- `gallery/vocab.py`：纯函数 `normalize_prompt(text, extra_stopwords) -> [str]`，按 §8.8 8 步流水线实现；
- 暴露 `normalize_tag(text) -> str`（复用流水线，空 stopword 集合）；
- `db.MIGRATIONS[3]` 增表：`tag(id, name UNIQUE NOCASE, usage_count)`、`image_tag(image_id, tag_id, PK)`、`prompt_token(id, token UNIQUE, usage_count)`、`image_prompt_token(image_id, token_id, PK)` + 反向索引；
- `repo` op：`UpsertVocabAndLinksOp`（解析后由 `indexer` 入队 LOW，在写 `image` 同事务里维护 vocab 与连接表）；
- `indexer.cold_scan` 调整：解析阶段同时产出 prompt tokens / 已有 `xyz_gallery.tags`，写入对应 op。

**依赖**：T07

**测试**：
1. `normalize_prompt('(masterpiece:1.2), <lora:foo:0.7>, BREAK, masterpiece.')` → `['masterpiece']`；
2. 单元：50 个语料样本与期望表对齐；
3. 5000 张图重建索引后，`tag.usage_count` 与人工抽样一致；
4. token 总数远小于 `split(',')` 的朴素值（量级证据）。

---

### T16 · Schema v3 迁移：`metadata_sync_*` 列 + 部分索引  ✅ MVP · P0

**输入**：`ARCHITECTURE §4.8 / 附录变更清单`。

**输出**：
- `db.MIGRATIONS[4]` 在 `image` 表增加 4 列：`metadata_sync_status TEXT DEFAULT 'ok'`、`metadata_sync_retry_count INT DEFAULT 0`、`metadata_sync_next_retry_at INT NULL`、`metadata_sync_last_error TEXT NULL`；
- **## UPDATED** — 同一迁移再增加一列：`version INT NOT NULL DEFAULT 0`，作为 image 元数据的**单调版本号**；所有 PATCH / 内部业务更新都必须 `+1`（实现见 T19），用于 `metadata_sync` 的乱序保护与文件单调写（实现见 T17）；老 DB 升级时所有现有行回填 `version=0`；
- 部分索引：`CREATE INDEX idx_image_sync ON image(metadata_sync_status) WHERE metadata_sync_status != 'ok'`；
- `ImageRecord` DTO 增加 `gallery.sync_status` 字段并在 `repo.list_images` / `get_image` 一并选出；**## UPDATED** — DTO 同时增加 `version: int` 字段（一并 SELECT），供 sync worker 与前端做版本对账。

**依赖**：T03

**测试**：
1. 老 DB 升级后 `user_version=4`，所有现有行 `sync_status='ok'`；
2. 部分索引在 `EXPLAIN QUERY PLAN` 中被使用；
3. 列表 / 详情 API 返回新字段；
4. **## UPDATED** — 老 DB 升级后所有现有行 `version=0`；新 INSERT 行默认 `version=0`；列表 / 详情 API 返回 `version` 字段。

---

### T17 · `metadata.py` 写路径 + `metadata_sync.py` Worker + 重试  ✅ MVP · P0

**输入**：`PROJECT_SPEC FR-23 / FR-24 / NFR-12`；`ARCHITECTURE §2.1 / §4.8`。

**输出**：
- `metadata.write_xyz_chunks(path, tags, favorite)`：write-temp + `os.replace`，**只增删 `xyz_gallery.*` 前缀块**，原 ComfyUI 块原样保留（C-6）；
- `gallery/metadata_sync.py`：
  - 启动时拉一个守护线程；
  - **## UPDATED** — 任务模型携带 `version`：`notify(image_id, version)` 由 service 调用时把当前最新的 `image.version` 一起传入；周期巡检改为 `SELECT id, version FROM image WHERE metadata_sync_status='pending' OR (='failed' AND retry_count<3 AND next_retry_at<=now)`，巡检读到的 `version` 直接放进 sync 任务对象；
  - **## UPDATED** — **写盘前必须做版本对账**：在调用 `metadata.write_xyz_chunks(...)` 之前，重新 `SELECT version, favorite, tags_csv FROM image WHERE id=?`；若 `task.version != current_db_version` → **直接跳过本次写**（不视为失败、不增加 retry_count、不更新 sync_status），让对应"最新 version"的 sync 任务接管；该规则保证文件写是**单调**的，**永远不会用旧数据覆盖新数据**；
  - 成功：`enqueue_write(LOW, SetSyncStatusOp(id, 'ok', expected_version=task.version))`；**## UPDATED** — `SetSyncStatusOp.apply` 内附带 `WHERE id=? AND version=?` 守卫，避免在 sync 期间发生新一轮 PATCH 后被旧任务把状态错误地标成 `ok`；
  - 失败：`retry_count+=1, next_retry_at = now + 5*2^n`，`enqueue_write(LOW, SetSyncFailedOp(...))`；超过 3 次留 `failed` 待用户重试。

**依赖**：T04, T16, T06

**测试**：
1. 写完后 PNG 用 `metadata.read_comfy_metadata` 重读，原字段不变 + 新 `xyz_gallery.tags / favorite` 出现；
2. 故意把目标文件设只读 → status 走 `pending → failed`，retry_count 增长到 3 后停；
3. 恢复写权限 → 调 `/resync` 后下一轮成功；
4. 进程崩溃后重启，pending 项被周期巡检自动捡起；
5. **## UPDATED** — 连发两次 PATCH（v1→v2），人为 sleep 让 v1 sync 任务执行晚于 v2 完成 → v1 任务在写盘前发现 `task.version(1) != db.version(2)`，**跳过文件写**且不修改 sync 状态；最终磁盘内容 == v2，最终 DB `sync_status='ok'` 且 `version=2`，**不可能**出现 v1 覆盖 v2 的退化结果。

---

### T18 · `ws_hub.py` + WebSocket 路由  ✅ MVP · P0

**输入**：`PROJECT_SPEC §7.9`；`ARCHITECTURE §2.1 / §4.4`。

**输出**：
- `gallery/ws_hub.py`：连接池（`set[WebSocketResponse]`）、`broadcast(type, data)` 包装事件信封 `{type, data, ts}`、断连清理；
- `routes.ws_handler`：`GET /xyz/gallery/ws` 升级为 WS，注册到 hub，处理 ping/pong；
- 事件类型常量：`image.upserted / image.updated / image.deleted / folder.changed / index.progress / vocab.changed / image.sync_status_changed / bulk.progress / bulk.completed / index.drift_detected`（数据形状由后续任务填）。

**依赖**：T10

**测试**：
1. 浏览器 console 直接 `new WebSocket('/xyz/gallery/ws')` 能连上；
2. 服务端 `ws_hub.broadcast('test', {...})` → 所有连接收到；
3. 客户端断开 → hub 内引用清理；
4. 服务端发 1000 条事件无丢失（弱要求：单机本地）。

---

### T19 · `PATCH /image/{id}` + `/resync` + `service.update_image`  ✅ MVP · P0

**输入**：`PROJECT_SPEC §7.5`；`ARCHITECTURE §3.2 / §4.3`。

**输出**：
- `gallery/service.py`：`update_image(id, patch)` 流程：
  1. `repo.get_image(id)` + `paths.assert_inside_root`；
  2. `vocab.normalize_tag` 整理 tag 列表；
  3. **## UPDATED** — `repo.enqueue_write(HIGH, UpdateImageOp(id, patch, also_set={'metadata_sync_status':'pending'}, bump_version=True))` `await`；`UpdateImageOp.apply` 在**同一事务**内执行 `UPDATE image SET ..., version = version + 1 WHERE id = ? RETURNING version`，把新版本号回传给 service；
  4. `ws_hub.broadcast('image.updated', {..., version: new_version})` 立即返回 200；
  5. **## UPDATED** — `metadata_sync.notify(id, version=new_version)` 异步推送，**必须把刚刚写入的 `version`** 一并交给 sync worker（与 T17 的版本对账配对）。
- `routes.patch_image`、`routes.delete_image`（先桩）、`routes.resync_image`（`POST /image/{id}/resync` 把 retry_count 清零、status 改回 `pending`、唤醒 worker）；**## UPDATED** — `/resync` **不**修改业务字段、**不**递增 `version`，仅复位重试状态，避免假版本扰乱对账。
- `UpdateImageOp.apply`：更新 `image.favorite/tags_csv` + 维护 `image_tag` diff；**## UPDATED** — 同事务内执行 `version = version + 1`，并 `RETURNING version` 给上层。

**依赖**：T04, T15, T17, T18

**测试**：
1. PATCH `{favorite:true}` → 200 < 50 ms（DB 快路径）；
2. 同步广播 `image.updated`；
3. 几秒内自动广播 `image.sync_status_changed` 为 `ok`；
4. PNG 块被改写、原 ComfyUI 块完整无损；
5. **## UPDATED** — 对同一 id 连续 PATCH N 次 → DB 中 `version` 严格 `+N`；每次 `image.updated` / `image.sync_status_changed` 广播均带最新 `version`；调用 `/resync` 前后 `version` 不变。

---

### T20 · `watcher.py` Observer + `Coalescer`  ✅ MVP · P0

**输入**：`PROJECT_SPEC FR-20 / §8.2`；`ARCHITECTURE §2.1 / §3.1`。

**输出**：
- `gallery/watcher.py`：
  - 每个注册根挂一个 `watchdog.Observer`；
  - `class Coalescer`：dict 合并、250 ms debounce、批 50 / 事务、HIGH_WATERMARK=500 溢出 → 清空 buffer + 调度该根的 `delta_scan(light)`；
  - 事件合并规则：`created+modified→upserted`、`created+deleted→drop`、`moved(a→b)→deleted(a)+upserted(b)`；
  - **## UPDATED** — 每条 upserted / deleted 调用 `indexer.index_one` 或 `indexer.delete_one` → 走 WriteQueue；写完由 service 包一层广播 `image.upserted / image.deleted`；watcher **不**自行维护去重表，统一复用 T07 在 `indexer` 模块内的 `_inflight` 屏障：同一路径若已在处理中，watcher 这次回调会被 indexer 直接跳过（避免事件抖动 / 多 Observer 重叠 / cold_scan 与 watcher 并发触发同一文件造成的重复索引与写放大）；inflight 的释放由 indexer 在 `finally` 中统一负责，watcher 不需感知。

**依赖**：T07, T18

**测试**：
1. 往 `output/` 拖入 1 张图 → ≤ 2 s 出现在前端；
2. unzip 一个 1000 文件包 → 不丢、UI 平滑（高水位降级到 delta_scan）；
3. 改名 `a.png → b.png` → 前端先消失再出现（id 可能不同，由 indexer 决定）；
4. 整个过程无 `database is locked` 与 OOM；
5. **## UPDATED** — 对同一文件在 1 s 内连发 100 次 modified 事件 → 实际只触发 **1 次** `UpsertImageOp` 入队（其余被 indexer 的 `_inflight` 跳过）；该次完成后再发新事件可正常处理（即 `_inflight` 已被正确释放，未死锁）。

---

### T21 · `/vocab/*` 端点 + `Autocomplete` + tag / prompt 过滤  ✅ MVP · P1

**输入**：`PROJECT_SPEC §7.7 / FR-3b / FR-3c / NFR-4`；`ARCHITECTURE §2.2`。

**输出**：
- `routes`：`GET /xyz/gallery/vocab/tags?prefix=&limit=20`、`GET /xyz/gallery/vocab/prompts?prefix=&limit=20`、`GET /xyz/gallery/vocab/models`；
- `repo`：`vocab_lookup(table, prefix, limit)`（`COLLATE NOCASE` + `ORDER BY usage_count DESC, name ASC`）；
- `components/Autocomplete.*`：debounce 150 ms、键盘上下选择、Tab/Enter 完成、按当前 token 切片完成（FR-3b 语义）；
- `stores/vocab.*`：前缀 → 结果 LRU；
- `MainView` 把 prompt / tag / model 过滤接入 `Autocomplete`，filter SQL 已在 T09，本任务只补"用户输入 → token 解析（`vocab.normalize_prompt`）→ 调 list_images"。

**依赖**：T15, T12

**测试**：
1. 输入 `mast` → 200 ms 内出现 `masterpiece` 等候选；
2. `/vocab/tags?prefix=&limit=20` P95 < 30 ms（万级词表）；
3. tag AND 过滤：`a, b, c` 选 3 个 → 结果集与人工 SQL 一致。

---

### T22 · 前端：编辑 UI + 同步徽标 + WS 订阅 + 焦点对账  ✅ MVP · P0

**输入**：`PROJECT_SPEC §7.9 注 / FR-13 / FR-18`；`ARCHITECTURE §2.2 / §4.4 / §3.2`。

**输出**：
- `ThumbCard`：收藏按钮接 `PATCH /image/{id}`；右上角同步状态徽标（`pending` 黄、`failed` 红、`ok` 不显示）；
- `DetailView`：标签编辑（共用 T21 `Autocomplete`）、收藏 toggle、`failed` 时显示"重试同步"按钮 → `POST /resync`；
- `stores/connection.*`：建立 WS 后订阅 `image.updated / image.upserted / image.deleted / image.sync_status_changed / index.progress`，patch 本地状态；指数回退重连；
- `window.onfocus` + WS reconnect → `GET /index/status`，若 `last_event_ts > localLast` 则重拉当前可视窗的 `/images`，**包含** `sync_status`。

**依赖**：T19, T18, T21

**测试**：
1. 在 Tab A 点收藏 → Tab B 1 s 内打勾；
2. 拔网线 5 s 再插回 → 自动重连且过滤结果与服务端一致；
3. 强制让 PNG 写失败 → 卡片角出现红徽，点击重试后变绿；
4. 切到别的 Tab 再切回 → 焦点对账触发一次 `/index/status` 请求。

---

## L3 — 批量操作 + 心跳兜底

### T23 · `Selection` 包络 + `/bulk/favorite` + `/bulk/tags` + `BulkBar`  ✅ MVP · P1

**输入**：`PROJECT_SPEC §6.2 Selection / §7.6 / FR-10a/b/c`；`ARCHITECTURE §3.3`。

**输出**：
- `repo.resolve_selection(sel) -> SQL subquery`：`explicit` 直接 `id IN (...)`；`all_except` 用同 `list_images` 的子查询 `WHERE id NOT IN (excluded)`；**绝不在 Python 里 expand 成大列表**；
- `routes`：`POST /bulk/favorite`、`POST /bulk/tags`、`POST /bulk/resolve_selection`；
- `service`：每条受影响 id 入队 HIGH（小批）或 MID（大批）`UpdateImageOp`，每条 `also_set={'metadata_sync_status':'pending'}` + 进度广播；
- `stores/selection.*`：`{ mode:'explicit', ids:Set } | { mode:'all_except', filters, excludedIds:Set }`；
- `components/BulkBar.*`：`Select all in current view` / `Clear` / 收藏 / 取消收藏 / 增减标签；进度条由 WS 计数驱动。

**依赖**：T19, T15, T22

**测试**：
1. 在 5 万图视图点 `Select all` → 网络包 < 1 KB；
2. 批量收藏 1000 张 → DB 全 commit 且 metadata_sync 后续追平；
3. 批量加 3 个 tag → vocab `usage_count` 正确加 3 × N；
4. 批量进行中用户单条 PATCH 不被饿死（HIGH 优先级生效）。

---

### T24 · 两阶段 bulk move + `MovePicker` + 增量提交  ✅ MVP · P1

**输入**：`PROJECT_SPEC §7.6 / §8.7 / FR-22`；`ARCHITECTURE §3.3 / §4.5 / 附录 C.2`。

**输出**：
- `service.preflight_move(sel, target)`：解析 selection、`paths.assert_inside_root`、`shutil.disk_usage` 校验、target `listdir` + 同批内 `_next_free_name` 解决冲突、生成 `MovePlan` 入 `PLAN_STORE`（TTL 5 min）；返回 `plan_id` + mappings；
- `service.execute_move(plan_id, overrides)`：**逐条**物理 `os.replace`（跨盘 fallback `copy2 + verify_size + unlink`），每条成功立即 `enqueue_write(MID, MoveImageOp(id, new_path, also_set='pending'))`，每条广播 `bulk.progress`；批末 `bulk.completed` + 审计；
- `routes`：`POST /bulk/move/preflight`、`POST /bulk/move/execute`、`POST /image/{id}/move`（单条复用同一路径）；
- `components/MovePicker.*`：目录选择 + 冲突 / 重命名预览 + 单条覆盖 + 提交。

**依赖**：T23, T17, T20

**测试**：
1. 1000 张目标无冲突 → 全部移动 + DB 路径全部更新；
2. 制造 50 条冲突 → preflight 给出 `(1).png` / `(2).png` 候选，UI 可单独覆盖；
3. 移动到目标盘空间不足 → preflight 拦截，无任何文件被动；
4. **中途 kill 进程**：磁盘已移动条数 = DB 已更新条数，30 s 内心跳兜底（T25）补齐剩余漂移。

---

### T25 · bulk delete + `ConfirmModal` + 审计日志 + `HeartbeatThread`  ✅ MVP · P1

**输入**：`PROJECT_SPEC §7.6 / FR-21 / NFR-13 / C-11`；`ARCHITECTURE §3.3 / §4.10`。

**输出**：
- `service.bulk_delete(sel)`：preflight 仅 sandbox + 计数；execute 逐条 `os.unlink` 成功 → `enqueue_write(MID, DeleteImageOp(id))` → 广播 `bulk.progress`；批末 `bulk.completed` + 审计；
- `components/ConfirmModal.*`：所有破坏性操作（单 / 批 删除、批 move 覆盖）共用；展示文件数 + 总大小（来自 `/bulk/resolve_selection`）；
- `gallery_audit.log`：滚动 30 天；记录每次破坏性操作的 actor=`ws_client_id` / 时间 / 摘要；
- `gallery/watcher.HeartbeatThread`：守护线程，每 30 s 对每个 root 触发一次 `indexer.delta_scan(root, mode='light')`；发现差异 broadcast `index.drift_detected`；自检日志每 5 min 写入审计文件（events_seen / coalesced / scans_done / drifts_found）。

**依赖**：T23, T20

**测试**：
1. 批量删 100 张 → 模态展示总大小，确认后磁盘 + DB 同步消失；
2. 中途 kill → 重启后 30 s 内心跳删掉 DB 中已无对应文件的行；
3. 在不可靠的网络盘上拔网 → 心跳触发 `index.drift_detected`，前端调试面板可见；
4. `gallery_audit.log` 正确轮转、`tail` 可见每次破坏性操作记录。

---

## Pre-L4 — v1.1 收口（**非 MVP**，**默认先于 L4**）

> 设计锚点：`PROJECT_SPEC §11`、`ARCHITECTURE.md` §6、`docs/gallery_update_description.md`。  
> **分层原则**：后端索引/词表 → 列表过滤（先 API 后 UI）→ 目录全栈 → 网格交互 → 下载 → 设置与视觉 → 详情页；**避免** filter Settings 与 filter SQL 互相前置（过滤器可见性只依赖「控件是否存在」，见 T36）。

### 依赖 DAG（无环）

```
T29                    T33 ──► T34
T30 ──┬──► T31 ──► T32 ──┬──► T36
      │                  │
      └──► T37           └──（另轨）T35 ──► T36

说明：T36 同时依赖 T32（过滤器控件已存在）与 T35（下载配置键语义）；T37 仅依赖 T30，可与 T31/T32 并行。
```

---

### T29 · 索引卫生（扫描排除 + 误入库清理） ✅ · P0

**Scope**：仅 **`indexer` / `watcher` / 一次性维护脚本`**：定义衍生物目录黑名单（至少 `…/output/_thumbs`）；冷扫与 delta 跳过；可选 CLI/脚本删除误索引行；**不包含**任何 SPA。画廊 WebP 仍只写入 `gallery_data/thumbs/`（§11 F11）。

**依赖**：T07, T08, T20

**阻塞 L4**：是（T26 LRU 口径）。

**验收测试**：
1. **离线**：临时目录搭 output + `_thumbs` 下 PNG → 冷扫后 `image` 表无对应 path / 或计数断言为 0。
2. **回归**：`/thumb/{id}` 仍生成 `gallery_data/**.webp`；`thumbnail_cache` 行为与 T08 一致。
3. **既有库**：文档化的一次性清理路径（脚本 dry-run → 执行）使 `_thumbs` 不再出现在列表 API 抽样中。

---

### T30 · 词表流水线 v1.1 + 全库再衍生 ✅ · P0

**Scope**：仅 **`vocab.py` / `indexer` 调用链 / `repo` 词表 UPSERT / `gallery_config.json` `vocab_version`**：废除 §8.8 第 4 步对 token 的实际影响；触发全库 `prompt_token` / `image_prompt_token` 重建；**无** HTTP/UI。

> **Implementation note**（*Updated due to runtime implementation / QA feedback*）：除废除第 4 步外，**权重括号展开**仅当内层含 **`:数字` 权重** 或 **内层无 ASCII 空白** 时执行，否则保留字面 `(...)`，以使过滤器与 `prompt_token` 行一致；SD 转义 `\(` `\)` 经 shield/unshield 后以字面括号进入词表。`RebuildPromptVocabFullOp`、`maybe_rebuild_prompt_vocab_from_config`、`PROMPT_VOCAB_PIPELINE_VERSION=2`、默认 `vocab_version=2` 已落地。

**依赖**：T15

**阻塞 L4**：是（T27/T28 语义）。

**验收测试**：
1. **单元**：`normalize_prompt('yd \\(orange maru\\)')`（或等价）保留括号语义所需 token；与旧行为对照表可查。
2. **集成**：再衍生后指定样本 id 的 `image_prompt_token` 与 `/vocab/prompts` 抽样一致。
3. **`vocab_version`** bump 与重启幂等文档化。

---

### T31 · 列表过滤（后端：`repo` + routes） ✅ · P1

**Scope**：**仅 Python**：扩展 `FilterSpec`、`_parse_filter`、`list_images` SQL；wire 参数（命名实现自定）：`metadata_presence`、`prompt_match_mode`、`prompt`/`prompt_*`；`_`→空格落在 **查询归一化层**（与 §11 F05 一致）；**不包含** Vue。

**依赖**：T09, T21, **T30**

**阻塞 L4**：部分（T28 需与此语义对齐）。

**验收测试**：
1. **`pytest`**：`/images` + `/images/count` 组合矩阵（metadata 三元 × 至少两种 prompt 模式 × 含 `_` 字符串）。
2. **`EXPLAIN`** 或日志断言：无意外全表退化（允许后续 T28 优化）。
3. **错误输入**：非法 query → 400 `invalid_query` 信封。

---

### T32 · 列表过滤（前端：`filters` + MainView） ✅ · P1

**Scope**：仅 **`stores/filters.js`、`MainView.js`、Autocomplete 行为**：接线 T31 wire 参数；URL/localStorage；**Match phrase / word / string** 三模式下 Autocomplete：**phrase** → **`/vocab/prompts`**，**word** → **`/vocab/words`**，**string** 关闭联想（§11 F04）。

**依赖**：T12, T21, **T31**

**阻塞 L4**：否。

**验收测试**：
1. **手工 / Playwright 可选**：改过滤 → URL 可分享刷新还原；三模式联想行为符合 §11。
2. **合并门槛**：集成合并前 **T31** 离线测试已绿；同轮 Pre-L4 若含 **word** 词表 HTTP/DB（见下），以联合 QA 清单为准。

> **Scope supplement**（*Updated due to runtime implementation / QA feedback*）：**word** 模式依赖 **`word_token` / `image_word_token`**（`db` v6）、`vocab.split_positive_prompt_words`（索引与查询侧 **`_`→空格** 对齐 F05）、`repo.FilterSpec.words_and`、**`GET /xyz/gallery/vocab/words`**、`indexer` 写入 **`word_tokens`** 与孤儿词清理；与 T32 同一验收批次 **QA passed**。手工回归：`test/manual/e2e_phrase_word_vocab_1_seed_offline.py`、`e2e_phrase_word_vocab_2_verify_runtime.py`（支持 **`--latest-manifest`**）；E2E 合成标记避免在 **word** 语义下依赖含 **`_`** 的单一 lexeme（`_` 会先变空格再分词）。

---

### T33 · 目录操作（HTTP + `FolderTree`） ✅ · P1

**Scope**：**全栈但单一域「文件夹」**：`routes`/`service`/`repo`/`folders` 暴露 mkdir / rename / delete（空目录语义）/ 必要时 move folder；`FolderTree` 折叠持久化、右键菜单、可选「在资源管理器中打开」。与 **图片** move（T24）区分清晰。

> **Scope supplement**（*Updated due to runtime implementation / QA feedback*）：**【T33 已交付】** 先行落地的 `repo.ReconcileFoldersUnderRootOp` + `indexer.reconcile_folders_under_root`（`cold_scan` / `delta_scan` 每根末尾入队 LOW；`watcher` 对目录 create/delete/move 经 Coalescer **250ms** 去抖入队）继续将注册根下 **子 `folder` 行与磁盘目录** 对齐；有变更时 `ws_hub` 广播 `folder.changed` **`{"root_id": <int>}`**；`MainView` 订阅后重拉 `GET /folders`。**HTTP**：`POST /xyz/gallery/folders`（自定义根）、`GET …/delete-preview`、`DELETE …/folders/{id}`、`POST …/mkdir`、`PATCH …/folders/{id}`、`POST …/move`、`POST …/open`、`POST …/rescan` 等与 `gallery/service.py` / `repo` 写路径经 **WriteQueue** 一致；**前端** `FolderTree.js` 等与任务 Scope 对齐并已 **QA passed**（见 `PROJECT_STATE.md` §2 **T33**）。**仍属可选 UX 收口**：`MovePicker` 仅在打开时请求 `/folders`（**未**订阅 `folder.changed`），长开对话框可与主视图树短暂不同步——关闭重开即可；可留 **T34** 或后续小步优化。

**依赖**：T05, T10, T24（沙箱与路径惯例）

**阻塞 L4**：否。

**验收测试**：
1. **HTTP**：`pytest` 或 `curl` 脚本覆盖成功与沙箱外 403。
2. **WS**：目录变更后树与列表最终一致（事件或刷新）。
3. **UI**：折叠状态跨刷新保持（localStorage 键版本化）。

---

### T34 · 网格交互（框选 / Shift / 拖放 / 上下文） ❌ · P1

**Scope**：仅 **前端**：`VirtualGrid`/`ThumbCard`/`MainView`/`BulkBar` — 矩形框选、Shift 连续选、拖到 **T33** 树节点触发 **既有** `move`/`DELETE`/`PATCH` API；右键菜单补全改名/移动/删除（§11 F06–F09）。**不新增**后端批量协议除非缺囗。

**依赖**：T13, T23, T24, **T33**

**阻塞 L4**：否。

**验收测试**：
1. **交互脚本或清单**：多选 N≥20 仅发预期数量 move 请求。
2. **性能**：5 万行 DOM 预算下框选不长时间阻塞主线程（或文档化限制）。
3. **与 BulkBar**：选中集合与 resolve_selection 一致。

---

### T35 · 下载管线（服务端变体 + 客户端统一入口） ✅ · P1

**Scope**：**下载域全栈**：`routes`/`metadata`/`service` 提供 ≥3 种 PNG 字节流（全 metadata / 无 workflow / clean）；`api.js` 单一 `downloadImage(id, options)`；BulkBar / 右键 / Detail **调用同一 helper**；默认策略与目标路径**写死或 `gallery_config` 默认值**，**不依赖** Settings 页（§11 F16 + F15 下载条款的基础能力）。

**依赖**：T10, T19, T17（PNG 写边界）, T23（bulk 入口可选）

**阻塞 L4**：否。

**验收测试**：
1. **字节抽检**：三种策略下 workflow chunk / xyz 块存在性符合定义。
2. **集成**：同 id 三种下载体积或哈希差异可记录 fixture。
3. **无 Settings**：偏好键可有默认值；T36 仅覆盖持久化编辑。

> ***Scope supplement — Updated due to runtime implementation / QA feedback***：`clean` 变体同时剔除 A1111 风格 **`parameters`** tEXt 块（与 `prompt`/`workflow`/`xyz_gallery.*` 一并），避免仅删 JSON 块仍残留 seed/sampler 等可读元数据。客户端 **`downloadImage`** 对程序化下载**始终**附带显式 **`?variant=`**（与 `setDownloadVariant` 默认同步），与仅依赖服务端默认 query 省略时的行为对齐。可选 **`download_prompt_each_time`**（T36 持久化）由 **`stores/downloadHelper.js`** + **`DownloadPickModal`** 在每笔下载前弹窗选变体（与「仅用 Settings 里保存的 variant」二选一）。

---

### T36 · 设置中心（偏好 + tag/root 管理 + 主题与视觉） ✅ · P1 / P2

**Scope**：**偏好与运维 UI**：Hash 子路由或 overlay；**开发者模式**（隐藏 id 等）；过滤器可见性 checkbox（读 **当前 MainView 已有** 控件 id，**不依赖** T31 完成即可存配置）；下载路径与策略**编辑**（读 T35 写入的配置键）；自定义根目录管理（output/input 锁定）；tag 搜索/删除/清 usage=0/重命名级联（需 **后端小端点** 时在本任务内追加）；**Light/Dark + 全局滚动条/色板**（§11 F02、F17）与 §11 F15 合并，避免单独「纯皮肤」任务。

**依赖**：T05, T10, **T32**（过滤器控件已存在才可「显示/隐藏」）, **T35**（下载键语义）

**阻塞 L4**：否。

**验收测试**：
1. **配置往返**：`gallery_config.json` 字段与 UI 双向一致。
2. **Dev off**：界面无内部 row id / bulk mode 调试串（依 SPEC）。
3. **主题**：切换后 MainView + Detail 无裸白滚动条破坏对比度（截图或 checklist）。

> ***Scope supplement — Updated due to runtime implementation / QA feedback***：Settings 为 **hash 浮层**（`#/settings`、`#/image/{id}/settings`），**不**再占用独立 `route.name === 'settings'`；**顶栏**在设置打开时保持可见；**点击遮罩**关闭设置（`hash` 回到 `#/` 或 `#/image/{id}`）。**Save preferences** 成功后有短时按钮色反馈。**`GET /xyz/gallery/admin/tags`** 响应为 **`{ "tags": [...], "total": int }`**，支持 **`limit`/`offset`**（默认 **`limit=10`**）与 Settings 内 **First/Prev/Next/Last/页码跳转**；种子数据脚本 **`test/manual/seed_gallery_admin_tags_for_pagination.py`**。Detail 顶栏/侧栏 **不**重复放置与全局顶栏/Back 重复的 Settings/Back 控件（UX 收敛）。
>
> ***Scope supplement — Updated due to QA 2026-04-24（MainView / Settings 连贯）***：**过滤器可见性** 勾选列表与 **MainView** 筛选项 **顺序一致**，纵向列表（**`.gs-fv-list`**）。主视图 **筛选区 / 目录树** 横向分割：**`.mv-filters-pane`** 固定持久化高度以便拖动手柄始终有效；**`.mv-filters-body`** 内滚动、其下 **`.mv-filters-slack`** 吸收筛选项下方多余空间（避免「滚入空白」）。**Save preferences** 成功后触发 **`stores/gallerySettings.js`** 的 **`filtersPaneFitRequest`**，`MainView` **watch** 后以 **`fitFiltersPaneHeightToContent()`** **一次**将 **`filters_pane_height_px`** 收束到可见内容自然高度（上界：**`filtersPaneHeightCapPx()`** 与当前 stored 高度之 **min**），并 **`persistLayoutDims`**；与 **`clampFiltersPaneHeight`** / 横向分割拖动 **共享** cap 逻辑。属 **T32+ / T36** 工程延伸，**非**新 `TASKS` ID。

---

### T37 · 详情页（布局与只读/编辑） ✅ · P1

**Scope**：**`DetailView.js`（+ `index.html` CSS）**：右栏分块（**Image** / **Gallery** / **ComfyUI** / **Operations**）；gallery 元数据**置顶**；**positive**「PNG 原文」/「**DB 归一化**（与 T30 `normalize_prompt` + `prompt_stopwords` 一致）」切换；内联 **filename** / **tag** / **favorite**；详情内 **←/→** 邻居导航、**滚轮**缩放（可编辑区不抢方向键）；**PATCH** / **单图 `POST /image/{id}/move`（重命名）**；Gallery 区**不**再放 **Version** / **Sync** 行、**不**再放侧栏 **`doResync`**（与设置页无循环依赖）。

> ***Scope supplement — Updated due to runtime implementation / QA feedback***：**V1.1-F12** 的「归一化」在 wire 上由 **`GET /image/{id}`**（及列表项同源序列化）嵌套字段 **`metadata.positive_prompt_normalized`** 提供，值为对 **`positive_prompt`** 经 **`normalize_prompt`** + `gallery_config.json` 的 **`prompt_stopwords`** 后 token 的 **逗号+空格** 拼接（与 indexer 词表派生一致）；**`routes._serialize_image`** 少量追加，**非**「仅纯前端」可完整实现的契约。**Tags** 行 UI：chips + Autocomplete + Apply **同一行**。**测试**：`test/t37_test.py`；回归 **`test/t10_test.py` / `test/t14_test.py`**；**`test/manual/t37_detail_json_probe.py`** 需运行中 ComfyUI。

**依赖**：T14, T19, **T30**

**阻塞 L4**：否。

**验收测试**：
1. **E2E 或手工**：toggle 与 PATCH 后刷新一致。
2. **边界**：无 Comfy metadata 时 toggle 不报错。

---

## v1.2 — Design & system polish（**post v1.1 QA**）

> 规格来源：`PROJECT_SPEC` **§12**；架构蓝图：`ARCHITECTURE` **§7**。依赖 **C-1 / Single Writer / `ws_hub`** 不变。下列任务**只增不改** T01–T37 的既有结论。

| ID | 名称 | 优先级 | 依赖 |
| --- | --- | --- | --- |
| T38 | Design system + 全页 Dark 控件 | P0 | T36, T37 |
| T39 | FolderTree 图式 | P1 | T12, T33 |
| T40 | IconButton 与统一返回/导航 | P1 | T38（样式基线） |
| T41 | 上下文 `?` 帮助（**descoped · 已关闭**） | P1 | T32, T36 |
| T42 | 清理 dev 占位与文案 | P0 | T12 |
| T43 | 抗闪烁与对账 | P0 | T20, T22, T32 |
| T44 | ProgressModal 与进展事件 | P0 | T24, T25, T36（Settings 长作业） |
| T45 | Line view 与分桶 | P1 | T13, T29–T32 |

### T38 · Design system 与全页 **Dark 控件/滚动条**一致性 ✅ · P0

**输入**：`PROJECT_SPEC` §12.1 / §12.5；`ARCHITECTURE` §7.2；现有 `index.html` CSS 变量与 `SettingsView`/`DetailView`/`MainView` 已落地主题。

**输出**：
- **在既有 token 上扩展**（`--xyz-*` 体系统一），**Detail** 与 **Settings** 的 `input/textarea/select` 与**滚动条** 在 **Dark** 下与主网格**对比度曲线一致**（**无**未设 `color-scheme` 的#fff 槽；具体对照 `index.html` 中 Main 区样式）。
- **不** 重写路由或 `VirtualGrid` 算法；仅类名/CSS 与必要 `html` 属性级改动。

**依赖**：T36（主题开关与全局变量已存在）, T37

**阻塞 L4**：否。

**验收测试**：
1. 手动 / 截图：三视图（Main / Detail / Settings）在 Dark 下**无**突兀白底滚动条或白底输入；Light 回归**无**回归级色差。
2. 浏览器 DevTools：`color-scheme` 在 gallery 根上一致；无 inline `#ffffff` 作为**默认**输入背景的新增项。

> ***Scope supplement — Updated due to runtime implementation / QA feedback***：交付在 **`js/gallery_dist/index.html`** 全局 **`style`** — **`html { color-scheme: dark }`** / **`html[data-xyz-gallery-theme="light"] { color-scheme: light }`**；**`--xyz-*` 别名**与 **`--xyz-on-accent`**；WebKit **滚动条**选择器扩展至 **`.dv-right`**、**`.gs-win-side` / `.gs-win-main`**、**`.mp-panel`**、浮动列表等 + Firefox **`scrollbar-color: var(--border) var(--panel)`**；**`#app` checkbox/radio `accent-color: var(--accent)`**；Detail **`.dv-tagac` 输入** 显式 **`var(--bg)`/`var(--fg)`**；accent 上文字 **`var(--xyz-on-accent)`**。**测试**：**`test/t38_test.py`**；**`test/manual/t38_static_theme_probe.py`**。**状态**：**QA passed**（见 `PROJECT_STATE.md` §2 **T38**）。

---

### T39 · **FolderTree** 图式化（icon + 缩进 + 状态） ✅ · P1

**输入**：`PROJECT_SPEC` §12.1；`js/gallery_dist/components/FolderTree.js` 现有数据（`T33` QA 通过树）。

**输出**：
- 每节点 **可辨认为目录** 的**视觉**（`folder`/`chevron`/`expand` 等 **内联 SVG**，风格与 T40 图标库同宽同线粗）。
- **缩进/展开线** 或**等效**层级留白；`hover` / `active` 状态与 **Main 侧**列表项一致化。

**依赖**：T12, T33

**阻塞 L4**：否。

**验收测试**：
1. 3 级嵌套目录取证：单屏内可理解**父子**关系，无**纯文本**冒充树。
2. 键盘/指针：选中态与**当前 folder filter** 对应关系不断裂（`stores/filters` 不变）。

> ***Scope supplement — Updated due to runtime implementation / QA feedback (T39 收口)***：目录行 **不** 展示 `folder.kind` 前缀（`[input]` / `[output]` / `[custom]` 等）——`kind` 为写入时**登记用途**，移动后可能未与当前父级重算，作列表前缀会误导。 **「All folders」** 行与根级目录行同用 **`ft-row-inner` + 外链内仅图标+标题** 结构，与 depth-0 行左对齐。 **Recursive on/off** 自 **`MainView` 的 `mv-folders-title-row`** 与 **「Folders」** 标题**同一行**；**`FolderTree`** 在主页通过 **` :show-recursive-button="false"`** 隐去组件内建 **`ft-toolbar`**。 **`test/t39_test.py`**、**`test/manual/t39_gallery_static_folder_tree_probe.py`**、**`test/t12_test.py`** 契约与静态探针。 **状态**：**QA passed**（见 `PROJECT_STATE.md` §2 **T39**）。

---

### T40 · **IconButton** 与「返回」/导航**统一** ✅ · P1

**输入**：`PROJECT_SPEC` §12.5 *Anti-patterns*；`DetailView` / `SettingsView` 中 `&larr; Back` 文本链。

**输出**：
- 新增**薄** 组件或 **pattern**（如 `components/IconButton.js` + 共享 SVG `chevron`/`arrow`）替换各页 **Back** 与**同类** 主导航；**不** 删除 hash 路由语义；带 `href="#/…"` 的**链接** 可保留，**仅**将呈现换为 **icon + 可选 sr-only 文案**。
- 与 T38 的 token **对齐** 颜色/悬停。

**依赖**：T38

**阻塞 L4**：否。

**验收测试**：
1. Main→Detail→Settings 往返：无**裸蓝色文字链** 作为**唯一**返回手段（`PROJECT_SPEC` §12.5）。
2. 可访问性：每按钮保留 **`aria-label` 或可视标题** 之一（英文或随 UI 语）。

> ***Scope supplement — Updated due to T40 落地***：实现为 **`js/gallery_dist/components/IconButton.js`**（`chevronLeft` / `chevronRight`、1.5 stroke、24 视口与 **FolderTree** 同网格）+ **`index.html`** 中 **`.ib` / `.ib-ico` / `.ib-sr-only` / `.ib--nav`**；**`DetailView`**（Back、Previous/Next）、**`SettingsView`**（Back，`:href="backHref"`）、**`app.js` `NotFoundView`**（Home）已替换；**`app.js` 顶栏** `XYZ Image Gallery` / `Settings` **不**属本任务必迁（仍为文字链，与 §12.5「全应用」表述的收口边界：核心返回路径已 **IconButton** 化）。**测试**：**`test/t40_test.py`**、**`test/manual/t40_gallery_static_iconbutton_probe.py`**。**状态**：**QA passed**（见 `PROJECT_STATE.md` §2 **T40**）。

---

### T41 · **`?` 帮助浮层**（**非**替代标签） ✅ · P1 — **descoped · 已关闭**

**输入**：`PROJECT_SPEC` §12.1 item 2；`Settings` 中复杂项（如 prompt match 三模式、layout reset、vocab 开关）。

**输出（产品决策 / 2026-04-24）**：**不交付** 本任务原列的 **`HelpTip` / `?` 浮层** 实现；已自代码库移除相关组件、文案表、样式与专用测（若有）。**文档**：`PROJECT_SPEC` §12.1 **v1.1 patch** 覆盖 item 2 中对「可选 `?`」的**实现义务**；可发现性由标签、Settings、§12.1 其余项及 **T39** 等承担。

**依赖**：T32, T36（均已满足；本任务以 **closed** 结案，**非**「待实现」）

**阻塞 L4**：否。

**验收测试**（结案型）：
1. **无** 仓库内 **`HelpTip`** / **`helpTexts`** 等残留依赖路径（与 QA 通过快照一致）。
2. 若未来重开 **`?` 帮助**，须**新任务**引用更新后的 §12.1 与本文档，**不得**默示本条目仍为 open。

---

### T42 · **清理 dev 文案/占位**（name filter 等） ✅ · P0

**输入**：`PROJECT_SPEC` §12.1 item 3；`MainView.js` 现 `placeholder`（*substring (debounced 250 ms)*）；全目录 `js/gallery_dist` grep **debounce/WS/debug** 面向用户的串。

**输出**：
- **用户向** 占位/提示（可留「Search by name」类短句）；**不** 暴露毫秒、内部队列名、WS 名。
- **不** 改**过滤语义**（FR-3a / T32 SQL 仍成立）。

**依赖**：T12

**阻塞 L4**：否。

**验收测试**：
1. 手工：dev 关 + dev 开 各扫一遍，Settings「developer」关时**无** 内部名。
2. `rg "debounced|WriteQueue|bulk\." js/gallery_dist` 的**用户可见** 残留=0（评论除外）。

> ***Scope supplement — QA 2026-04-24（同轮对话工程，无独立 TASK ID）***：**`test/t42_test.py`** + **`test/manual/t42_gallery_user_copy_probe.py`**；**`gallery/vocab.normalize_tag`** 对 **纯数字/小数** 标签的保留（`PROJECT_SPEC` §8.8 *Gallery tag* v1.2 patch）；**`DetailView`** 标签行布局、**去掉 Apply** 后 **即时 PATCH**、**`image.upserted` 静默 `fetchRecord`**、**图/元数据 `dv-splitter`**（**`localStorage` `xyz_gallery.detail_aside_width_px.v1`**）；**`index.html`** **`.tc-fav` / `.dv-fav`** 爱心视觉对齐。**状态**：**QA passed**（用户确认，本轮）。

---

### T43 · **抗闪烁**与 **WS/对账** 路径审计 ✅ · P0

**输入**：`PROJECT_SPEC` §3.5 **NFR-20**、§12.3；`ARCHITECTURE` §7.3–7.4；`MainView.js` 现 `resetAndFetch` / `mergeRowFromIndexUpsert` / `scheduleGridRefreshAfterFsUpsert`。

**输出**：
- 文档化（**短** 注释+`PROJECT_STATE` 可摘）**每种** `subscribeGalleryEvent` 分支是 **patch** / **全量** / **仅目录** 的**判定表**；在**不改** 后端合同下，**减少** `folder.changed` 等路径上**可证明多余** 的**列表** 清空；若必须全量，**在 Progress 或 T44 中** 记录用户可见原因**可选**（不强制 popover）。
- **不** 删除 420 ms 防抖的**存在**；可调优数值须附**前后** 对比**笔记**于 PR。

**依赖**：T20, T22, T32

**阻塞 L4**：否。

**验收测试**：
1. 手测：在 **同页** 连续 toggle favorite 50 次，**不** 出现**整表白屏**闪动（录屏 60 fps 可接受偶发 layout）。
2. `index.drift_detected` 或 人工改 OS 名：列表**终态** 正确，**且** 滚动在**可恢复** 场景不无故归零（若不可恢复须在注释说明**为何** OK）。

> ***Scope supplement — QA 2026-04-24（T43 交付 + 同轮工程加固）***：**`js/gallery_dist/views/MainView.js`** — `subscribeGalleryEvent` 上 **T43 / SPEC §12.3** **判定表注释**（`index.drift_detected` / `folder.changed` / `bulk.completed` / `image.*` 等）；**`folder.changed`**：先 **`fetchFolders({ silent: true })`**（**100 ms** 静默去抖 + **`fetchFoldersBody`**），**`root_id`** 与当前 **`folder_id` 所属根**（**`rootIdContainingFolderId`**）不一致时 **跳过** **`resetAndFetch`**；无 `folder_id` 时仅刷新树。**静默** 树刷新在 **`folders.value =`** 前快照 **`scrollTop`**，`nextTick`+**`rAF`** 恢复（防批量移动后滚动条跳顶）。**`gallery/service.py`**：**`execute_move` / `move_single_image`** 对 **`UpdateImagePathOp`** 使用 **`refresh_sync=False`**，纯路径移动**不**再 **`metadata_sync.notify`**（减 PNG 镜像写与 mtime 搅动；**PATCH**/元数据编辑路径仍 **`refresh_sync=True`**）。**`gallery/metadata.py`** / **`metadata_sync.py`** / **`paths.py`**：**`write_xyz_chunks`** 原子 staging（**`.xyz_gallery_atomic`** 等）与指纹 **`SetSyncStatusOp`** 行为保持与 **T17** 一致；**`gallery/watcher.py`**：**`on_deleted`** 跳过衍生物路径。**测试**：**`test/t43_test.py`**、**`test/manual/t43_comfyui_folder_changed_ws_probe.py`**；相关 **T17 / T24 / T29** 回归。**状态**：**QA passed**（用户确认，本轮）。

---

### T44 · **ProgressModal** + **统一 Job 模型** + 晚到会话 + **批量 metadata 审计** ✅ · P0

> **完成勾选**：`[x]`（与 `PROJECT_STATE` §1 / §3 同步，QA 2026-04-25）。

**输入**：`PROJECT_SPEC` §12.4（**FR-Prog-1…6**）、§3.5 **NFR-21**、§7.9（WS 表 + **`GET /jobs/active`**）；`ARCHITECTURE` §7.5、§3.3、§4.5；现 `ws_hub`：`BULK_PROGRESS` / `BULK_COMPLETED`、`INDEX_PROGRESS`；`service`：`execute_move` / `bulk_*` / `execute_delete` / `folder_*` / `tag_admin_*` / `folder_schedule_rescan`；**T43** 已落地之 **`UpdateImagePathOp(refresh_sync=False)`** 与 **免逐图 `notify`** 为性能对标。

**输出**：

**A — 前端 ProgressModal**
- **单一** 模态（`components/ProgressModal` 或 `composables/progressModal`）：**进度**（determinate **或** indeterminate + 文案）、**kind/phase**、**当前对象摘要**、**ok/fail 计数**；主画廊 **冻结** 策略与 `PROJECT_SPEC` **FR-Prog-1** 一致（与 **NFR-20** 协调：见 **§12.4**）。
- **统一订阅**：`subscribeGalleryEvent`（或薄封装）消费 **`bulk.progress` / `bulk.completed`**、**`index.progress`**、及实现时新增的 **`job.progress` / `job.completed`**（`ws_hub.py` **常量** + `PROJECT_SPEC` §7.9 **补行**）；**映射到同一套** 内部 **Job 状态机**（`job_id`、`kind`、`done`、`total`、`phase`、`terminal`）。
- **可见性阈值（FR-Prog-6）**：在代码中**常量化**（建议默认：**耗时 > 300–500 ms** 仍无完成 **或** 影响行数 ≥ **`T44_BULK_MODAL_MIN_ROWS`**（建议默认 **8–20** 区间择一并注释理由）→ 显式 `ProgressModal`；低于阈值则 **仅** `BulkBar` 内联或静默，避免「进度条一闪而过」）。数值可配时写入 **Settings** 或 **module 常量** 二选一（PR 内定稿）。

**B — 晚到 Web 会话（FR-Prog-5）**
- 新增 **`GET /xyz/gallery/jobs/active`**（路径以 `routes.py` 为准，须与 `PROJECT_SPEC` §7.9 脚注一致）：返回进程内 **running / queued** 的 Job 摘要数组（含与 WS **`bulk_id`/`plan_id`** 可对齐的 **`job_id`**）。
- Gallery **首屏**：在 WS **已连接或可连接之前**，**一次**拉取 `jobs/active`；若非空 → **立即** 显示 `ProgressModal` + 冻结，与「本 Tab 发起」一致；WS 连通后继续收**同一** `job_id` 的增量。
- **WS 重连**：复用同一快照逻辑（**先 HTTP 快照** 再订阅），避免漏进度。

**C — 后端统一 Job registry（FR-Prog-4）**
- **进程内 registry**（或等价）：`bulk` execute、`index` 长扫、`folder_schedule_rescan` / Settings 多阶段等**登记** / **更新** / **清除** Job；**`jobs/active`** 只读该 registry。
- **仅** 在现有 **`ws_hub.broadcast`** 路径增事件；**禁止** 第二 `WriteQueue`、禁止为进度新开 TCP 端口。
- **`index.progress`** 与 **`bulk.*`** 在 registry 中**可**指向同一 Job 的不同阶段（`phase` 字段区分），或分 Job — PR 内**文档化**选择。

**D — 批量路径与 metadata 优化（对齐 T43 精神）**
- **审计并实现（在不变 C-1、不破坏 DB→PNG 语义下尽量）**：
  1. **`bulk_set_favorite`** / **`bulk_edit_tags`**：是否可 **减少** 逐图 **`metadata_sync.notify`**（改为一轮结束 **`notify` 一次** 或**仅**依赖 `pending` + patrol）；是否可 **合并** 用户可见 WS（例如进度仍逐条，但 **`image.updated` 节流** — 须评估与 **NFR-20** 兼容性）。
  2. **`tag_admin_rename`** / **`tag_admin_delete`**：`_broadcast_image_updated_tags` 循环内 **`notify`** 是否可收敛。
  3. **`RelocateFolderSubtreeDbOp`**：确认**无**逐图读 PNG；**不** 在纯子树重定位中把行级 **`metadata_sync_*` 标为 `pending`**（`PROJECT_SPEC` §12.4 v1.1、*Scope supplement*）；服务层若对子树迁移有**冗余** `notify`/`index`，移除或合并。
  4. **`execute_delete`**：文档化 **unlink** 为固有成本；**禁止**「为删而整文件读入再写出」类反模式。
  5. **custom root 注册/移除** + **`folder_schedule_rescan`** / **`indexer.delta_scan`**：与 **`index.progress`** + Job registry **合流**，确保大规模 OS 变更在后端处理时 **jobs/active** 非空。
- 每项优化在 PR 描述中**一句**说明取舍；**回归** `test/t24_test.py` / `test/t43_test.py` 等与 metadata 相关测。

**依赖**：T24, T25, T36

**阻塞 L4**：否。

**验收测试**：
1. **本 Tab 发起**：bulk move / favorite / tags，**行数**超过 **`T44_BULK_MODAL_MIN_ROWS`** 或**人为延迟**超过阈值：`ProgressModal` 与 `BulkBar`（若仍显示）**计数不矛盾**；正常完成后 **≤1 s** 自关或按 **FR-Prog-3**。
2. **晚到会话**：在文件管理器大改图或触发长索引后、**后端仍在跑**时**新打开** Gallery 页：应在 **≤1 次** `jobs/active` 往返内出现 `ProgressModal`，且 WS 连通后进度**连续**直至 `completed`。
3. **二选一** 深度手测：**tag 重命名** 影响 ≥50 图 **或** **增删 custom root** 触发 rescan：有**可辨**进度（含 **`index.progress`** 合流）**或** PR 内**明确文档化**的「原子不可分」**例外**（不得静默误导用户）。
4. **metadata 审计**：对 **favorite bulk** 前后采样（进程 CPU /  Wall time / 磁盘写入量 三选二做**前后笔记**），证明无**回归**；若仅文档化「不可优化」须给出**原因**（如单写者事务粒度）。

> ***Scope supplement — QA 2026-04-25（T44 交付 + 同轮工程加固，v1.1 overrides 见 `PROJECT_SPEC` §12.4 补丁、`ARCHITECTURE` §7.5 *Updated*）***  
> **A — 前端**：**`js/gallery_dist/stores/galleryProgress.js`**（`T44_BULK_MODAL_MIN_ROWS`、**`initGalleryProgress`** 订阅 `bulk.*` / `index.progress` / `job.*`、**`get /jobs/active`** 引导、`**setIndexJobUiSyncHandler**` 与冷扫结束 UI 同步、**`progressMainFrozen`** 门控、**`delta` 段**与主 **index** 模态的防串台规则）；**`js/gallery_dist/components/ProgressModal.js`** — 固定**布局槽位**（`pm-line` / 始终占位的**进度条**轨道、有 `total` 时 **determinate** 否则 **indeterminate** 脉冲、文案 **nbsp** 防高度抖动）、避免 **`v-if`** 在「条/文案」间切换；**`js/gallery_dist/index.html`** 配套 **`.pm-line` / `.pm-bar-indet`** 等样式。 **B — 后端/目录**：**`RelocateFolderSubtreeDbOp`**（**`repo.py`**）在批量改写 `image.path` 时**不**将 **`metadata_sync_*` 置为 `pending`**，与 **T24** **`UpdateImagePathOp(refresh_sync=False)`** 纯磁盘子树重定位语义一致，避免 **`metadata_sync`** 无意义整 PNG 回写；**`service.folder_move` / `folder_rename`**：在 **Relocate + Reconcile** 之后**不再**追加 **`folder_schedule_rescan`（全根 `delta_scan`）**；**`watcher.register_moved_subtree_bypass`**：在短 TTL 内对**预计算**的旧/新**精确路径集**的 **`d`/`u`** 监视器事件**旁路**（与 bulk 减少冗余索引一致）。 **C — UX 修复（同批 QA）**：**`FolderTree.js`** **`onDeleteConfirm`** 成功路径在 **`closeDeleteModal()` 前**将 **`deleteBusy=false`**，避免与 **`closeDeleteModal`** 的 `busy` 门控**死锁**。 **D 审计**：§12.4 所列 **`bulk_set_favorite` / `bulk_edit_tags` / `tag_admin_*` 的逐图 `notify`** 等**仍可**按后续 PR 收紧，**不**作为本段 closure 的阻塞项。 **状态**：**QA passed**（用户确认，2026-04-25）。

---

### T45 · **Line view** + **section 规则** + **compact/line 切换** ✅ · P1

**输入**：`PROJECT_SPEC` §12.2；`ARCHITECTURE` §7.6；`SortSpec` wire；`ImageRecord` 的 `folder` / `relative_path` 字段；`VirtualGrid` **现状** 仅 flat。

**输出**：
- `view_mode` **状态**（`localStorage`+首选项 合并策略与 T36 **单源** 决策）；Main **toolbar** **切换** compact ⇄ line。
- **Line**：对**当前** `items` 客户端 **groupBy(sectionKey)**（**四** 种 `SortSpec.key` 规则**严格** 按表）；`folder` **非递归**（仅含**直接** 子文件）；`size` **bin 边界** 在代码**常量化**+一条注释**举例**；首屏不阻塞 **load-more**（仍走 **底部** sentinel）。
- **不** 在首版 增加 `GET /images/sections`（*除非* T45 中测得 P95 违约再**子任务**）。

**依赖**：T13, T29–T32

**阻塞 L4**：否。

**验收测试**：
1. **纯前端** 单测/手工：对假 `ImageRecord` 路径集合，**folder** 下 **a/b/c.png** 与 **a/d.png** 的 section **互斥** 正确；**不** 在 `output` 节 看见 **仅** 在 `output/t` 下的子文件（除非**文件** 就在 `output/` 根）。  
2. 切换 `SortSpec` 时 section 头**随之** 变；**不** 重复 `resetAndFetch` **除** 必要**sort 变更**（与现 Main 行为一致）。  
3. 性能：`view_mode=line`、20k **库** 用**同** 分页 仍 **滚动** 流畅（NFR-5/6 目标下；若**不如** compact，文档化**限制**）。

> ***Scope supplement — QA 2026-04-25（T45 交付；`PROJECT_SPEC` §12.2 v1.1 patch、`ARCHITECTURE` §7.6 *Updated*）***  
> **前端**：**`js/gallery_dist/components/LineVirtualGrid.js`** + **`sectionKeys.js`**（`partitionItemsIntoSections` / **`partitionItemsForLineView`**；folder 模式**按列表首次出现顺序**合并同 section key，**不** 在追加页后再 `localeCompare` 全局重排 section，避免与游标顺序冲突闪烁）；**`stores/filters.js`** **`view_mode`**；**`MainView.js`** 接线、**sort 键 + ↑/↓** 控件；筛选 **name / prompt / tag** 的 **×** 与 **输入框同一行**（**`mv-field-inputrow`**，见 **`index.html`**）。**测试**：**`test/t45_section_keys_runner.mjs`**、**`test/t45_test.py`**、**`test/t13_test.py`** 契约。  
> **后端**：**`gallery/folder_header.py`**（与 UI **folder section 标签** 同规则的字符串）；**`gallery/db.py`** 在 **`connect_read` / `connect_write`** 注册 SQLite UDF **`xyz_folder_line_header`**；**`gallery/repo.py`** **`list_images` / 游标 / `neighbors`** 在 **`sort.key=folder`** 时 **`ORDER BY`** 使用该标签的 **`lower(...)`**（SELECT 别名 **`folder_line_header`**），**不** 再以 **`image.path`** 作为 folder 排序键（与 §12.2「与 header 一致」对齐）。**`test/t09_test.py`** 增 **`test_folder_line_header_sort_order`**。  
> **状态**：**QA passed**（用户确认，2026-04-25）。

---

## L4 — 性能与长尾（**非 MVP**）

### T26 · `thumbs.Scheduler` LIFO 视口优先 + 取消 + LRU 淘汰  ❌ · P2

> **## v1.1 队列冻结**：在 **T29**（磁盘/索引口径）与 **T30**（词表语义）完成前**禁止**启动本任务，以免 LRU/janitor 对错误文件集合操作。见 `PROJECT_SPEC §11.2`。

**输入**：`PROJECT_SPEC §8.3 / NFR-7`；`ARCHITECTURE §4.9`。

**输出**：
- `thumbs.Scheduler`：双队列 `stack[VIEWPORT]`(LIFO) + `queue[BACKGROUND]`(FIFO)；同 image_id 去重保留最新；`AbortController` 取消；ProcessPool 中固定 1 slot 保留给 VIEWPORT；
- LRU 淘汰：基于 `thumbnail_cache` 表 `ORDER BY last_accessed ASC`，越界 2 GB 时降到 80%；事务内 `unlink + DELETE`；30 s 节流；
- 每日 janitor 双向对账（孤儿文件 / 孤儿行）。

**依赖**：T08

**测试**：缩略图目录被人工填到 2.2 GB → 5 min 内回落到 ~1.6 GB；用户快速滚动时视口 P95 < 200 ms。

---

### T27 · `indexer` 元数据解析 ProcessPool 化  ❌ · P2

> **## v1.1 队列冻结**：**T29**（扫描路径稳定）与 **T30**（normalize 冻结）未完成前暂缓。

**输入**：`PROJECT_SPEC §8.1 / NFR-2`；`ARCHITECTURE §4.7`。

**输出**：把 `metadata.read_comfy_metadata` 的调用从主线程移入 `ProcessPoolExecutor(max_workers=min(4, cpu_count-1))`；主线程汇总 `as_completed` 后统一通过 `WriteQueue(LOW)` 入队；in-flight 上限 256 做背压。

**依赖**：T07

**测试**：5 万张冷启动时间相比 T07 单线程版本下降 ≥ 50%；常驻内存仍 ≤ 300 MB（NFR-7）。

---

### T28 · FTS5 显式分词器 + tag-AND / prompt-AND 自适应查询  ❌ · P2

> **## v1.1 队列冻结**：依赖 **T30** 完成后的 token 语义；建议与 **T31** 联合验收查询口径。

**输入**：`PROJECT_SPEC §8.4`；`ARCHITECTURE §4.7.2`。

**输出**：
- `db.MIGRATIONS[5]`：`image_fts` 用显式 `tokenize='unicode61 remove_diacritics 2 tokenchars ''_-+.()[]{}<>:/\\@#'' separators '', \t\n'''` 重建 + 触发器；首启检测分词器哈希变化 → 排队 LOW 全量 reindex；
- `repo.build_tag_and_query`：基于 `tag.usage_count` 选 rarest 驱动，N≥4 且密集时切 INTERSECT 形式；
- 同样套到 prompt token AND；
- 名字过滤 ≥ 3 字符走 FTS5 `MATCH 'x*'`。

**依赖**：T15, T09

**测试**：5 万图、10 个 tag AND 过滤 P95 < 100 ms；搜 `lora:foo` 能命中。

---

## 附录：依赖图

```
T01 ──► T02
   └──► T03 ──┬─► T04 ──┬─► T07 ──┬─► T08 ──► T10
              │         │         │
              ├─► T05 ──┘         │
              │                   │
              ├─► T09 ────────────┤
              │                   ├─► T15 ──┬─► T19 ─► T22 ─► T23 ─► T24
              ├─► T16 ────────────┘         │                  │
              │                   T18 ◄─────┤                  ├─► T25
              ├─► T17 ◄── T06 ◄── T15       │                  │
              │                             │                  │
              T11 ──► T12 ──► T13 / T14     │                  │
                       └──► T21 ◄───────────┘                  │
                                                                │
              T20 ◄── T07 ───────────────────────────────────────┘
              T20 ──► T22

  Pre-L4（无环）:
    T29 ◄ T07+T08+T20
    T30 ◄ T15
    T31 ◄ T09+T21+T30
    T32 ◄ T12+T21+T31
    T33 ◄ T05+T10+T24
    T34 ◄ T13+T23+T24+T33
    T35 ◄ T10+T19+T17 (+T23 可选)
    T36 ◄ T05+T10+T32+T35
    T37 ◄ T14+T19+T30
  L4: T26 ◄ T08+T29 ;  T27 ◄ T07+T29+T30 ;  T28 ◄ T15+T09+T30
  v1.2（T38–T45 无环有向）:
    T38 ◄ T36+T37
    T39 ◄ T12+T33
    T40 ◄ T38
    T41 ◄ T32+T36
    T42 ◄ T12
    T43 ◄ T20+T22+T32
    T44 ◄ T24+T25+T36
    T45 ◄ T13+T29–T32  （T29..T32 为区间依赖意）
```

> 所有 P0 + P1 任务（T01–T25）构成 MVP；按上图自上而下并适度并行，单人约 3–4 周可达 MVP。  
> **v1.1**：Pre-L4 推荐关键路径 **T29 → T30 → T31 → T32**；并行轨 **T33→T34**、**T35→T36**；**T37** 可与 T32+ 并行（仅依赖 T30）。  
> **v1.2（Updated due to gallery_update_description v1.2 / `PROJECT_SPEC` §12）**：**T38** ✅、**T42** ✅、**T43** ✅、**T44** ✅（P0 视觉/文案/稳定性 + **WS/对账抗闪烁** + **ProgressModal**/长作业）；**T40** 在 **T38** 后；**T41** 已 **descoped · closed**（见 §T41、`PROJECT_SPEC` §12.1 v1.1 patch）。**T45** ✅（**Line view** / section / **`view_mode`** / folder 排序与 UI header 对齐；见 §T45 *Scope supplement*、**`PROJECT_SPEC` §12.2** v1.1 patch）。**T45** 与 **L4** 无硬依赖。
