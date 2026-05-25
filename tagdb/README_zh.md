# 标签数据库

ComfyUI 的 Danbooru 风格标签自动补全。通过全面的标签词汇表提供快速子串搜索，支持分类颜色、关联标签、画师预览，并采用预构建数据集分发模型，用户无需自行爬取 Danbooru。

## 设计理念

**绝不静默爬取。** 首次运行时，插件从 GitHub Release 下载预构建数据集。如果下载失败，用户可以从 Tag DB Manager 面板重试，或选择输入 Danbooru 凭据来自己爬取数据集。爬虫功能是主动选择的，始终需要用户明确操作。

## 架构

```
tagdb/                         ← 包目录（提交到 git）
├── official_manifest.json     ←   预构建数据集元数据

tagdb_data/                    ← 运行时数据（gitignored）
├── tagdb.sqlite               ←   可变工作数据库（自动补全读取此文件）
├── settings.json              ←   Danbooru 凭据（可选）、manifest URL
└── snapshots/
    ├── official/              ←   来自 GitHub Release 的不可变预构建数据集
    └── local/                 ←   用户导出的快照检查点
```

- **工作数据库** — 可变的，保存用于自动补全的活跃数据集
- **官方快照** — 只读，下载的预构建数据集
- **本地快照** — 用户导出的工作数据库检查点
- **Manifest** — `tagdb/official_manifest.json`（已提交）或远程 URL（可在设置中配置）
- **设置** — 可选的 Danbooru 凭据、活跃快照选择、manifest URL

## 快速开始

### 自动（推荐）

1. 安装插件并重启 ComfyUI。
2. 首次启动时，预构建数据集自动在后台下载（约 300 MB zip）。
3. 下载完成后，数据集经过校验（SHA-256）、解压并种子为工作数据库。
4. 标签自动补全立即可在所有多行 STRING 组件中使用。

### 手动

从 ComfyUI 侧边栏打开 **Tag DB Manager** 面板。可以从此处：
- 检查是否有更新的官方数据集版本
- 下载并安装官方数据集
- 下载可选的翻译 DLC（日/中搜索）
- 输入 Danbooru 凭据并运行全量或增量爬取
- 在工作数据库和快照数据库之间切换
- 将当前工作数据库导出为本地快照
- 重构指定日期之前的历史词汇快照

## 搜索功能

### 两级搜索策略

| 查询类型 | 方法 | 说明 |
|------------|--------|--------|
| 3+ 字符（英文） | FTS5 三元组 | 通过 contentless FTS5 三元组分词器对 `tags.name`、`aliases` 和 `translations` 进行快速子串匹配 |
| < 3 字符 | LIKE 前缀 | `LIKE 'q%'` 匹配标签名，对顶部结果补充别名和翻译 |
| CJK/假名/韩文 | LIKE 子串 | 在所有三个文本源上进行更广泛的 `LIKE '%q%'` 扫描（查询频率较低，较慢的扫描可接受） |

### 结果增强

每个搜索结果包含：
- **分类**——以不同颜色显示：general（蓝色）、artist（粉色）、copyright（紫色）、character（绿色）、meta（黄色）
- **作品计数**——Danbooru 使用次数
- **别名**——逗号分隔的替代名称
- **翻译**——日/中文名称（需安装翻译 DLC）
- **画师预览**——悬停显示最近作品缩略图（画师标签）
- **标签图片预览**——任意标签的缓存示例图片（10 分钟 TTL）

## 数据库模式（V2）

### 核心表

| 表 | 用途 |
|-------|---------|
| `tags` | 规范标签词汇表：`name`、`category`、`post_count`、`is_deprecated`、`danbooru_id` |
| `aliases` | 同义词映射：`alias → canonical` |
| `translations` | 多语言名称：`tag, lang, text` |
| `tags_fts` | FTS5 contentless 三元组索引（虚拟表） |

### 版本表（仅追加事件日志）

| 表 | 用途 |
|-------|---------|
| `tag_versions` | 标签分类/弃用变更事件 |
| `artist_versions` | 画师条目变更事件（名称变更、封禁、删除） |

### 派生数据

| 表 | 用途 |
|-------|---------|
| `related_tags` | 懒加载缓存的关联标签结果：`query_tag → related_tag`，含 cosine/jaccard/overlap 分数 |
| `meta` | 溯源水印：`structure_synced_through`、`full_count_synced_at`、`aliases_synced_through` |

### 水印（溯源时钟）

三个独立的时间追踪列支持增量更新：

- `tags.post_count_synced_at` — 每标签：此标签的 post_count 上次刷新时间
- `meta.full_count_synced_at` — 全局：上次完整 post_count 刷新完成时间
- `meta.structure_synced_through` — tag_versions/aliases 增量同步的事件时间水印

## 分发模式

### 预构建数据集

作者将数据集发布为 GitHub Release 资产。每个发布版本在 `official_manifest.json` 中描述（提交到 git 或从远程 URL 获取）：

```json
{
  "latest": "v2025.01.01",
  "datasets": [{
    "version": "v2025.01.01",
    "url": "https://github.com/.../releases/download/.../tagdb_v2025.01.01.zip",
    "sha256": "abc123...",
    "size_bytes": 314572800,
    "tag_count": 450000
  }]
}
```

`distribution.py` 模块处理：
1. 加载 manifest（本地 git → 远程 URL 回退）
2. 以 1 MB 块流式下载（可取消）
3. SHA-256 校验
4. 解压（针对 `.zip` 数据集）
5. 从校验通过的 `.sqlite` 种子化工作数据库

### 翻译 DLC

可选的附加数据集，包含日文、中文和其他语言名称。通过 `ATTACH DATABASE` + `INSERT OR REPLACE` 下载并合并到工作数据库中，然后触发 FTS 索引重建以包含新名称。

### 官方更新检查

`GET /xyz/tagdb/official/check` 比较已安装的官方快照版本与 manifest 的 `latest` 版本。当有新数据集可用时，Tag DB Manager 面板显示"有更新"横幅。

## 爬取（主动选择）

爬虫使用 `curl_cffi`（配合 `impersonate="chrome"`）绕过 Danbooru 的 Cloudflare JS 挑战。这是唯一的外部依赖（`curl_cffi>=0.7.0`）。

### 为什么用 curl_cffi？

Danbooru 基于 TLS 握手指纹（JA3/JA4）而非 IP 阻止标准 Python HTTP 库（urllib、requests）。`curl_cffi` 精确复现 Chrome 的 TLS + HTTP/2 指纹，无需代理即可通过挑战。

### 爬取能力

| 函数 | 端点 | 分页方式 |
|----------|----------|------------|
| `scrape_tags(min_post_count)` | `/tags.json` | ID 游标 `page=a{id}`（绕过 1000 页限制） |
| `scrape_tags_since(after_epoch)` | `/tags.json` | ID 游标 |
| `scrape_aliases()` / `scrape_aliases_since()` | `/tag_aliases.json` | 页码 |
| `scrape_tag_versions_since()` | `/tag_versions.json` | 页码 |
| `scrape_artist_versions_since()` | `/artist_versions.json` | 页码 |
| `fetch_related(query_tag, limit)` | `/related_tag.json` | 每标签单次请求 |
| `fetch_artist_posts(name, limit)` | `/posts.json` | 单次请求 |
| `scrape_wiki_other_names()` | Wiki 页面 | 每标签一页 |

频率限制：页面之间 1.0 秒延迟，每页最多 1000 条。

### 更新模式

**全量更新**（`run_full_update`）：
- 爬取所有 `post_count >= min_post_count` 的标签
- 爬取所有活跃别名
- 批量 upsert 所有数据
- 为每个标签标记 `post_count_synced_at = now`
- 将水印设为当前时间
- 可选获取翻译和 tag_versions 事件日志

**增量更新**（`run_incremental_update`）：
- 读取 `structure_synced_through` 水印
- 仅爬取该时间戳之后创建的标签和别名
- 仅应用结构更新（不刷新现有标签的 post_count）
- 将水印推进到实际消费的最大事件时间戳
- 比全量更新快得多（分钟 vs 小时）

## 前端集成

### 标签自动补全 (`js/tagac.js`)

为 ComfyUI 中每个多行 STRING 文本区提供自动补全：

- **激活**：在任何提示词文本区中输入 → 下拉框出现在光标处
- **去抖** 70ms 输入处理
- **LRU 缓存** 300 个最近查询
- **分类颜色**建议（行内 DOM 样式）
- **关联标签**显示在搜索结果下方（可配置 `relatedMaxAgeDays`）
- **标签预览图片**悬停显示（200 条目 LRU 缓存）
- **PLv2 集成**——提示词库条目与标签一起出现在下拉框中
- **可配置**通过设置面板（持久化到 localStorage）

### Tag DB Manager 面板 (`js/tagdb_panel.js`)

独立的浮动窗口，提供：

- **凭据**——Danbooru 登录名 + API 密钥管理
- **官方数据集**——检查版本、下载、安装
- **翻译 DLC**——检查、下载、合并
- **手动维护**——启动全量/增量爬取并实时日志
- **快照管理**——列出、激活、导出
- **过期横幅**——从水印数据显示 `full_count_age_days`
- **重构**——构建指定日期之前的历史词汇表

## HTTP API

所有端点位于 `/xyz/tagdb/` 下：

| 方法 | 路径 | 用途 |
|--------|------|---------|
| GET | `/search?q=&limit=` | 标签自动补全（FTS5 → LIKE 回退） |
| GET | `/related?q=&limit=&max_age_days=` | 获取/同步关联标签 |
| GET | `/artist_posts?name=&limit=` | 画师标签的最近作品 |
| GET | `/tag_preview?name=&limit=` | 缓存的标签预览图片（10分钟 TTL） |
| GET | `/preview_image?url=` | 通过后端代理 CDN 图片 |
| GET | `/snapshots` | 列出所有快照数据库 |
| GET/POST | `/snapshots/active` | 获取/设置活跃快照 |
| POST | `/snapshots/export` | 导出工作数据库到本地快照 |
| GET/POST | `/settings` | 获取/更新 Danbooru 凭据 |
| GET | `/official/check` | 比较最新版本与已安装版本 |
| POST | `/official/download` | 下载 + 安装官方数据集 |
| GET/POST | `/translations/check` + `/translations/download` | 管理翻译 DLC |
| POST | `/maintain` | 启动全量或增量爬取 |
| GET | `/maintain/status` | 轮询爬取进度 |
| POST | `/maintain/cancel` | 取消正在运行的维护任务 |
| POST | `/reconstruct` | 构建指定日期之前的历史快照 |

## 数据集维护者指南

`build_dataset.py` 模块是用于构建和发布官方数据集的独立 CLI 工具：

```bash
python -m tagdb.build_dataset --full --min-post-count 10 --with-versions --zip \
    --login myuser --api-key abc123
```

生成一个 `.sqlite` 文件（可选 `.zip`），计算 SHA-256，并打印可直接粘贴的 manifest 条目。凭据也可以从 `tagdb_data/settings.json` 读取。

---

[English Version](README.md)
