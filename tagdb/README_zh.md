# 标签自动补全与数据集

[English](README.md) | **中文** · [← 返回主 README](../README_zh.md)

由版本化的本地 SQLite 数据集驱动的 Danbooru 标签自动补全。在任意提示词框输入时，会按 post 数排序给出标签建议；数据集以预构建形式下载，可更新、做快照、并回溯到过去某个日期。

## 获取数据集

首次运行时，会在后台下载作者的预构建数据集（约 66 MB，约 11.8 万个 post_count ≥ 50 的标签）——下载完成后自动补全即可用。不会自动抓取。

若下载失败（离线、尚未发布等），打开 **XYZ Prompt Tools → Tag dataset**，点 **Download / Update** 重试，或自己构建（需要免费的 Danbooru 登录名 + API key）。

### 数据布局（`tagdb_data/`，已 gitignore）

```
tagdb_data/
├── tagdb.sqlite          ← 工作库（自动补全默认读它）
├── settings.json         ← Danbooru 凭据 + 偏好
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

把标签的存在性、分类、名称重建为所选日期的状态——包括沿画师改名历史回滚名称，因此搜索任意历史名都能找到该画师。需要官方 Release 自带的版本历史。结果保存到 `snapshots/local/` 并激活；要切回，在 **Snapshots → Use** 点 `tagdb.sqlite`。

## 常见问题

**输入日文/中文搜不到。** 数据集没有 wiki 翻译——搜索只匹配英文标签名和画师曾用名。

**标签数量和 Release 对不上。** Release 用 `min_post_count = 50`。你用更低阈值自己更新会得到更多标签。

**标签数量变少了。** 多半是切换了活动快照——在 **Snapshots → Use** 点 `tagdb.sqlite` 切回。

---

## 自己构建数据集（进阶）

作者 CLI 独立运行（不依赖 ComfyUI），需要 `curl_cffi` 和 Danbooru 凭据：

```bash
python -m tagdb.build_dataset --full --min-post-count 50 --with-versions --with-artists --zip \
    --login 你的登录名 --api-key 你的APIKEY
```

它会在 `dist/` 写出一个 `.sqlite`（加 `--zip` 时还有 `.zip`）并打印一条 manifest 条目。`--with-versions` 启用时间机器重建；`--with-artists` 加入画师数据。发布时，把 `.zip` 上传到 GitHub Release 并更新 `tagdb/official_manifest.json`。

后端/架构说明见项目根目录的 `CLAUDE.md`。
