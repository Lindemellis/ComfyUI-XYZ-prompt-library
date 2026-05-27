# 标签数据库（Tag Database）

Danbooru 标签自动补全。用户使用说明见[主 README](../README_zh.md#标签自动补全tag-database)。

## 架构

```
tagdb/                     ← 包代码（提交到 git）
├── official_manifest.json ← 预构建数据集清单

tagdb_data/                ← 运行时数据（gitignored）
├── tagdb.sqlite           ← 工作数据库（可写）
├── settings.json          ← Danbooru 凭据
└── snapshots/
    ├── official/          ← 从 GitHub Release 下载的只读副本
    └── local/             ← 备份和重建快照
```

## HTTP API

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/xyz/tagdb/search?q=&limit=` | 标签自动补全 |
| GET | `/xyz/tagdb/related?q=&limit=&max_age_days=` | 关联标签 |
| GET | `/xyz/tagdb/artist_posts?name=&limit=` | 画师作品 |
| GET | `/xyz/tagdb/tag_preview?name=&limit=` | 标签预览图 |
| GET | `/xyz/tagdb/preview_image?url=` | 代理 CDN 图片 |
| GET | `/xyz/tagdb/snapshots` | 列出快照 |
| GET `/` POST | `/xyz/tagdb/snapshots/active` | 获取/设置活跃快照 |
| POST | `/xyz/tagdb/snapshots/export` | 导出工作 DB |
| DELETE | `/xyz/tagdb/snapshots` | 删除快照文件 |
| GET `/` POST | `/xyz/tagdb/settings` | Danbooru 凭据 |
| GET | `/xyz/tagdb/official/check` | 检查预构建更新 |
| POST | `/xyz/tagdb/official/download` | 下载预构建数据集 |
| POST | `/xyz/tagdb/maintain` | 启动维护（full / incremental） |
| GET | `/xyz/tagdb/maintain/status` | 维护进度 |
| POST | `/xyz/tagdb/maintain/cancel` | 取消维护 |
| POST | `/xyz/tagdb/reconstruct` | 时间机器重建 |

## 构建数据集

作者侧 CLI 工具：

```bash
python -m tagdb.build_dataset --full --min-post-count 50 --with-versions --with-artists --zip \
    --login myuser --api-key abc123
```

生成 `.sqlite` + `.zip` 到 `dist/`，输出 manifest 条目。

## 维护者参考

- `db.py` — SQLite schema + FTS5 索引
- `scraper.py` — Danbooru API 客户端（curl_cffi 过 Cloudflare）
- `updater.py` — 全量/增量更新 + 时间重建逻辑
- `distribution.py` — 预构建数据集下载/校验/种子化
- `repo.py` — 搜索和数据访问
- `routes.py` — HTTP API

详见项目根目录的 `CLAUDE.md`。

[English Version](README.md)
