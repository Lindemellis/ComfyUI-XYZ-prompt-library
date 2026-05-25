# 图片浏览器

内嵌于 ComfyUI 的功能完整的图片浏览器。自动索引您的输出图片，提取 ComfyUI 元数据，生成缩略图，并通过 WebSocket 实时更新提供丰富的筛选和浏览体验。

## 架构

```
gallery_data/
├── gallery.sqlite       ← 索引的图片元数据（SQLite, WAL, 256 MiB mmap）
├── gallery_config.json  ← 根文件夹与偏好设置
└── thumbs/              ← 分片 .webp 缩略图（xx/hash.webp）
```

- **单写入器**——通过 `WriteQueue`（优先级队列，HIGH/MID/LOW）
- **短周期读取**——每次查询打开新 `connect_read()`
- **SQLite WAL**——模式 v1–v6，仅向前迁移
- **Vue 3 SPA 前端**，通过 `/xyz/gallery` 访问
- **WebSocket 中心**用于跨标签页实时同步

## 生命周期

ComfyUI 启动时，图片浏览器：

1. 创建数据目录布局（`gallery_data/thumbs/`）
2. 运行所有待执行的 SQLite 迁移
3. 在 `/xyz/gallery/` 下注册 69 个 HTTP 端点
4. 从 ComfyUI 的 `output` 和 `input` 目录种子默认根文件夹
5. 如果流水线版本变更，重建提示词词汇表
6. 启动所有根文件夹的后台冷扫描
7. 启动文件系统监控（watchdog）和定期心跳扫描

## 核心功能

### 图片索引

三种扫描策略协同工作：

| 策略 | 何时 | 内容 |
|----------|------|------|
| **冷扫描** | 启动时 | 完整遍历每个根文件夹 |
| **增量扫描** | 心跳/手动重新扫描 | 指纹比对，仅索引变更的文件 |
| **文件监控** | 实时 | 每个根文件夹一个 watchdog 观察者 |

指纹为 `(file_size, mtime_ns)`——热重启几乎瞬间完成，因为未变更的文件完全跳过元数据提取。

识别的扩展名：`.png`、`.jpg`、`.jpeg`、`.webp`。

### 元数据提取

对于每张索引的图片，浏览器读取 ComfyUI PNG chunk：
- 正面提示词
- 负面提示词
- 模型（去除检查点扩展名以获得规范名称）
- 种子、CFG 值、采样器、调度器
- 完整工作流 JSON（可通过 API 提取）

### 游标分页浏览

`GET /xyz/gallery/images` 支持丰富的筛选和排序：

**筛选器：**
- `folder_id` + `recursive`——浏览文件夹，可选包含或不包含子文件夹
- `name`——文件名子串搜索
- `favorite`——仅收藏的图片
- `model`——精确模型名称
- `tag`——可重复，图片必须包含所有指定标签
- `prompt`——可重复，配合 `prompt_match_mode`：
  - `prompt`——规范化提示词分词匹配
  - `word`——F04 词模式词素匹配（按空格/下划线/标点分割）
  - `string`——提示词文本原始子串匹配
- `metadata_presence`——按元数据是否存在筛选
- `date_after` / `date_before`——文件修改时间范围

**排序：** 按时间（默认）、文件名、文件大小或文件夹，升序或降序。

**分页：** 基于游标（并发插入下稳定），可配置 `limit`。

每张图片结果包含：`id`、`path`、`filename`、`ext`、`width`/`height`、`file_size`、`created_at`、元数据块、画廊字段（favorite、tags、sync_status），以及预计算的 `thumb_url` / `raw_url`。

### 缩略图系统

- **按需生成**：首次请求触发 Pillow LANCZOS 缩放至 320×320 居中裁剪 WebP（质量 78）
- **内容寻址缓存**：以 `SHA1(path + mtime_ns)` 为键——文件变更时自动失效
- **分片存储**：`thumbs/{hash[:2]}/{hash}.webp` 避免单目录瓶颈
- **不可变缓存**：`Cache-Control: public, max-age=31536000, immutable`
- **并发去重**：对同一 hash 的同时请求共享单次生成
- **访问合并**：`last_accessed` 时间戳缓冲，每 10 秒批量写入

### 标签管理

- 单张或批量添加/删除标签
- 规范化标签词汇表（小写化、去重、2-64 字符分词）
- 管理面板：列出所有标签、重命名、从所有图片删除、清除零使用
- 含标签使用次数的自动补全组件

### 批量操作

所有批量操作遵循**两阶段**模式：

1. **预检**——验证约束条件、模拟名称冲突、检查磁盘空间、返回 `plan_id`（5 分钟有效）
2. **执行**——应用计划，通过 WebSocket 广播进度/完成

支持的批量操作：**移动**、**删除**、**设置收藏**、**添加/删除标签**。

### WebSocket 实时同步

向所有连接的 SPA 标签页广播的事件类型：

| 事件 | 触发条件 |
|-------|---------|
| `image.upserted` | 新图片已索引 |
| `image.updated` | 元数据已变更（收藏、标签、移动） |
| `image.deleted` | 图片已删除 |
| `folder.changed` | 文件夹树已修改 |
| `index.progress` | 扫描进度更新 |
| `vocab.changed` | 词汇表已重建 |
| `image.sync_status_changed` | 元数据写回状态变更 |
| `bulk.progress` / `bulk.completed` | 批量操作生命周期 |
| `job.progress` / `job.completed` | 后台作业生命周期 |

前端 WebSocket 管理器处理自动重连（指数退避，1s–30s 上限）并在窗口获得焦点时重新同步。

### 元数据写回

异步后台工作线程将画廊元数据（`favorite`、`tags`）写回源文件的 PNG chunk：

- 由 PATCH/批量操作和定期巡查未同步行触发
- 每次最多处理 32 张图片，轮询间隔 1 秒
- 写入失败最多重试 3 次，指数退避
- 原子暂存写入以避免损坏 PNG
- 非 PNG 文件立即标记为硬失败

### 文件夹管理

- **根文件夹**：`output` 和 `input`（内建，不可删除），外加用户添加的 `custom` 根
- 重叠防护：新根不能等于、包含或位于现有根内
- 子文件夹操作：创建、重命名、移动（通过复制+删除支持跨设备）、删除
- 在操作系统文件管理器中打开（跨平台）
- 配置持久化于人类可读的 `gallery_config.json`

### 前端视图

- **主网格**——侧边栏筛选面板 + 虚拟滚动图片网格
- **紧凑视图**——密集缩略图卡片
- **行视图**——分区分组的行项目（按大小区间、日期、首字母或文件夹）
- **详情视图**——单张图片含完整元数据、工作流 JSON 下载、标签编辑器
- **设置覆盖层**——偏好设置（主题、下载方式、筛选可见性）、标签管理

## HTTP API 摘要

| 组 | 端点 |
|-------|-----------|
| **文件夹** | GET 树, POST 创建, DELETE, PATCH 重命名, POST 移动, POST 重新扫描, POST 创建子文件夹, POST 在操作系统中打开, GET 删除预览 |
| **图片** | GET 列表（游标分页）, GET 计数, GET 详情, GET 相邻, PATCH 更新, POST 重新同步, POST 移动, DELETE |
| **二进制** | GET 缩略图, GET 原图, GET 原图/下载（含 `?variant=` 选项） |
| **批量** | POST 解析选择, POST 收藏/标签/移动/预检/执行, POST 删除/预检/执行 |
| **词汇表** | GET 标签, GET 提示词分词, GET 单词, GET 模型 |
| **管理** | GET 标签列表, POST 标签删除/重命名/清除零使用 |
| **监控** | GET 索引/状态, GET 活跃作业 |
| **偏好** | GET, PATCH |
| **WebSocket** | GET /ws 升级 |

所有变更端点遵循 WriteQueue 模式。错误响应使用一致的 `{"error": {"code": ..., "message": ..., "details": ...}}` 格式。

## 配置

```json
// gallery_data/gallery_config.json（人类可读）
{
  "roots": [
    {"path": "ComfyUI/output", "kind": "output"},
    {"path": "ComfyUI/input", "kind": "input"},
    {"path": "/my/custom/folder", "kind": "custom"}
  ],
  "download_variant": "full",
  "theme": "dark",
  "developer_mode": false,
  ...
}
```

偏好设置也可以通过 `/xyz/gallery/preferences` API 和设置 UI 编辑。

---

[English Version](README.md)
