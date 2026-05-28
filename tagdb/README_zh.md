# 标签自动补全与数据集

[English](README.md) | **中文** · [← 返回主 README](../README_zh.md)

由版本化的本地 SQLite 数据集驱动的 Danbooru 标签自动补全。在任意提示词框输入时，会按 post 数排序给出标签建议；数据集以预构建形式下载，可更新、做快照、并回溯到过去某个日期。

## 获取数据集

首次运行时，会在后台下载作者的预构建数据集（约 66 MB，约 11.8 万个 post_count ≥ 50 的标签）——下载完成后自动补全即可用。不会自动抓取。

若下载失败（离线、尚未发布等），打开 **XYZ Prompt Tools → Tag dataset**，点 **Download / Update** 重试，或自己构建（需要免费的 Danbooru 登录名 + API key）。

### 数据布局（`tagdb_data/`，已 gitignore）

```
tagdb_data/
├── danbooru.sqlite       ← Danbooru 工作库（自动补全默认读它）
├── gelbooru.sqlite       ← 可选的第二来源库（仅在安装后存在）
├── settings.json         ← Danbooru/Gelbooru 凭据 + 偏好
└── snapshots/
    ├── official/         ← 从 GitHub Release 下载的预构建副本（只读）
    └── local/            ← 你的导出 + 重建结果（只读）
```

## 使用自动补全

- 在任意 ComfyUI 提示词框（以及提示词库编辑器）里输入。↑/↓ 移动，Enter/Tab 接受，Esc 关闭。
- 标签名以下划线存储；开启 **下划线替换为空格** 后会以空格插入。
- 相关设置（**XYZ Prompt Tools → …**）：
  - **Autocomplete**：总开关、最大建议数（默认 15）、隐藏冷门标签（低于某 post 数则跳过；默认 0 = 全显示）。
  - **Insertion**：下划线→空格、自动逗号、转义括号、全角→半角。
  - **Library**：同时建议你自己的提示词库条目 / 引用。
  - **Related**：在富文本编辑器 / 条目文本视图里点击某标签，查看相关标签（每次查询一个请求；有缓存）。
  - **Preview**：悬停 🖼 图标可弹出画师作品或标签预览图。**两者默认关闭**；按需从 Danbooru 获取，缓存在内存中。

## 标签数据集管理器

**XYZ Prompt Tools → Tag dataset**：

| 操作 | 作用 |
|---|---|
| **Download / Update** | 从 GitHub Release 下载作者的预构建数据集。会替换工作库。 |
| **Incremental** | 应用上次同步以来新增/变更的标签事件并刷新 post 数。需要 Danbooru 登录名 + API key。 |
| **Full re-scrape** | 从零开始从 Danbooru 重建数据集。需要凭据；耗时较长。 |
| **Snapshots → Use** | 让自动补全指向某快照，**不改动**工作库。 |
| **Snapshots → Export / Delete** | 把工作库存为本地检查点，或删除某快照文件。 |
| **Reconstruct & use** | 「时间机器」——把标签词表重建为过去某日期的状态。 |

### Danbooru 凭据

你的登录名和 API key 以明文存放在 `tagdb_data/settings.json`（已 gitignore），仅用于你自己的增量/全量更新。免费 Danbooru 账号可在个人资料设置里生成 API key。

### 时间机器（Reconstruct）

把标签的存在性、分类、名称重建为所选日期的状态——包括沿画师改名历史回滚名称，因此搜索任意历史名都能找到该画师。需要官方 Release 自带的版本历史。结果保存到 `snapshots/local/` 并激活；要切回，在 **Snapshots → Use** 点 `danbooru.sqlite`。

## Gelbooru（第二来源）

Gelbooru 是**可选的第二套标签集**，存放在独立文件 `tagdb_data/gelbooru.sqlite`，与 Danbooru 工作库并存。它独立且**仅当前快照**——没有时间回溯（其 API 不提供版本历史）。Gelbooru 的 deprecated 标签（拼写/重定向标签）已被排除在数据集之外。

**启用：** *设置 → Autocomplete → Gelbooru tags*。在 *Tag dataset → **Gelbooru** 分页*安装/管理。

**两个来源如何合并** —— 同时启用 Danbooru 与 Gelbooru 时，建议会**按名称合并去重**，每行显示可点击的来源角标：

- **`D`** → 打开该标签的 Danbooru wiki · **`G`** → 在 gelbooru.com 打开该标签的帖子。
- 两边都有的显示 **`D G`**；只在一边的只显示对应角标。
- 出现分歧（如分类不同）时**以 Danbooru 为准**。Danbooru 已改名但 Gelbooru 仍保留的活标签会以 `G` 单源行出现。
- 点击标签显示详情面板。Gelbooru 没有相关标签 API，因此 **Gelbooru 独有标签只显示其自身信息**（无相关列表）。

**获取数据集**（*Tag dataset → Gelbooru*）：

| 操作 | 作用 |
|---|---|
| **Download dataset** | 从 GitHub Release 下载作者预构建的 Gelbooru DLC（无需凭据）。 |
| **Build from gelbooru** | 直接从 Gelbooru 抓取到 `gelbooru.sqlite`。需要免费的 Gelbooru `api_key` + `user_id`（无凭据时标签 API 返回 HTTP 401）。 |
| **Gelbooru snapshots → Use** | 在不同日期抓取的 Gelbooru 数据集之间切换（下载的 + 导出的检查点）。 |
| **Remove** | 删除 `gelbooru.sqlite`，回退到仅 Danbooru。 |

**Gelbooru 凭据：** 注册免费账号 → *My Account → Options → API Access Credentials* 获取 `api_key` + `user_id`。存于 `tagdb_data/settings.json`（gitignore），仅用于直接构建/更新——下载预构建 DLC 无需凭据。

## 常见问题

**输入日文/中文搜不到。** 数据集没有 wiki 翻译——搜索只匹配英文标签名和画师曾用名。

**标签数量和 Release 对不上。** Release 用 `min_post_count = 50`。你用更低阈值自己更新会得到更多标签。

**标签数量变少了。** 多半是切换了活动快照——在 **Snapshots → Use** 点 `danbooru.sqlite` 切回。

---

## 自己构建数据集（进阶）

作者 CLI 独立运行（不依赖 ComfyUI），需要 `curl_cffi` 和 Danbooru 凭据：

```bash
python -m tagdb.build_dataset --full --min-post-count 50 --with-versions --with-artists --zip \
    --login 你的登录名 --api-key 你的APIKEY
```

它会在 `dist/` 写出一个 `.sqlite`（加 `--zip` 时还有 `.zip`）并打印一条 manifest 条目。`--with-versions` 启用时间机器重建；`--with-artists` 加入画师数据。发布时，把 `.zip` 上传到 GitHub Release 并更新 `tagdb/official_manifest.json`。

**Gelbooru** 构建用同一 CLI 加 `--gelbooru`（凭据取自 `settings.json`，或传 `--api-key` + `--user-id`）：

```bash
python -m tagdb.build_dataset --gelbooru --min-post-count 50 --zip
```

它会写出 `dist/gelbooru_<date>.sqlite(.zip)` 并打印一条 `datasets_gelbooru[]` 条目（记得设 `latest_gelbooru`）。要审计两个完整数据集之间的跨源同名碰撞：`python -m tagdb.audit_sources`（默认读 `tagdb_data/danbooru.sqlite` + `tagdb_data/gelbooru.sqlite`）。

后端/架构说明见项目根目录的 `CLAUDE.md`。
