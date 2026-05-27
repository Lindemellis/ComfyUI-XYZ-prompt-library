# ComfyUI-XYZNodes

ComfyUI 自定义节点包 — **Danbooru 标签自动补全**、**分层提示词库**、**图片浏览器**，再加 4 个轻量文本处理节点。

## 安装

1. 进入 ComfyUI 的 `custom_nodes` 目录：
   ```bash
   cd ComfyUI/custom_nodes/
   ```
2. 克隆仓库：
   ```bash
   git clone https://github.com/Lindemellis/ComfyUI-XYZ-prompt-library.git
   ```
3. 可选依赖（仅当需要自己从 Danbooru 抓取数据时才需要）：
   ```bash
   pip install curl_cffi>=0.7.0
   ```
4. 重启 ComfyUI。

首次启动时，插件会在后台自动下载预构建的标签数据集。下载完成后即可使用。

## 标签自动补全（Tag Database）

在任何 ComfyUI 的提示词输入框中输入文字，自动弹出标签补全下拉框。

### 数据集管理

插件需要一份 Danbooru 标签数据才能工作。打开 **XYZ Prompt Tools → Tag dataset** 面板管理：

| 操作 | 按钮 | 说明 |
|---|---|---|
| 下载官方数据集 | Download / Update | 从 GitHub Release 下载作者预构建的数据集（约 65 MB，118K tags，post_count ≥ 50） |
| 本地增量更新 | Incremental | 同步 Danbooru 上的新增/变更标签 + 刷新所有标签的 post_count（约 3-5 分钟，需 Danbooru 账号） |
| 本地全量重建 | Full | 从 Danbooru 完全重建数据集（约 90 分钟，需 Danbooru 账号） |
| 时间回溯 | Reconstruct | 重建某个历史日期的标签词汇表，支持画师改名回溯 |

### 数据集文件说明

```
tagdb_data/
├── tagdb.sqlite        ← 工作数据库（可写，autocomplete 默认读这里）
├── snapshots/
│   ├── official/       ← 从 Release 下载的预构建副本（只读）
│   └── local/          ← 本地备份和时间机器快照（只读）
```

- **tagdb.sqlite**：你的本地数据集。Incremental/Full 维护都写到这里。下载 Release 时勾 replace 也会覆盖这里。
- **official/**：下载的预构建冻结副本。"Use" 按钮可以切换 autocomplete 去读它，不修改工作 DB。
- **local/**：维护前自动备份、时间机器重建结果。

**常见问题**：切换到一个 prebuilt snapshot 后，工作 DB 的 tag 数量不变 —— 这是正常的。"Use" 只切换读取源，不修改数据。

### 数据集来源选择

| 来源 | 数据量 | 时效性 | 网络要求 | 操作 |
|---|---|---|---|---|
| 下载 Release（推荐） | 118K tags | 随 Release 更新 | 仅需下载一次 | Download / Update |
| 自己 Incremental 维护 | 取决于你的 scrape threshold | 实时 | 需 Danbooru 凭据，每次约 3 分钟 | Incremental |
| 自己 Full 重建 | 取决于你的 scrape threshold | 实时 | 需 Danbooru 凭据，约 90 分钟 | Full |

### 时间机器（Reconstruct）

重建某个历史日期的标签状态，支持画师改名回溯。

- 需要数据集包含 `tag_versions` 和 `artist_versions` 数据（官方 Release 已包含）
- 重建结果保存到 `local/recon_YYYY-MM-DD.sqlite`，自动激活
- 画师曾用名按改名时间线回溯：如 `range_murata → murata_renji → murata_range`，回溯到 2015 年会显示 `murata_renji`，搜索任意曾用名都能找到

### 设置

打开 **XYZ Prompt Tools → Autocomplete** 面板：

| 设置 | 说明 | 默认值 |
|---|---|---|
| Enable autocomplete | 全局开关 | 开 |
| Max suggestions | 下拉框最大条目数 | 15 |
| Hide rare tags | 隐藏 post_count 低于此值的 tag（0 = 显示全部） | 0 |
| Show artist preview | 悬停画师标签时显示近期作品 | 开 |
| Show tag preview | 悬停标签时显示示例图片 | 开 |
| Scrape threshold | 维护时只抓取 post_count ≥ 此值的 tag | 50 |

### 设置（Insertion / Library / Related / Preview）

打开 **XYZ Prompt Tools** 对应面板，覆盖插入行为、提示词库来源、关联标签缓存等。设置自动保存到浏览器 localStorage。

## 提示词库 V2（Prompt Library V2）

分层提示词库，支持模板和引用。两个节点：

- **XYZ Prompt Library V2 Positive** — 正面提示词
- **XYZ Prompt Library V2 Negative** — 负面提示词

### 基本用法

1. 添加节点到工作流
2. 点击节点上的 **Library** 按钮打开提示词库
3. 在文件夹树中浏览、创建条目
4. 条目支持语法：`[ref]` 引用、`{a|b}` 随机选择、`(text:1.2)` 权重
5. 双击条目或输入 `/trigger_name` 将内容插入编辑器

详见 [Prompt Library V2 文档](prompt_library_v2/README_zh.md)。

## 图片浏览器（Gallery）

管理 ComfyUI 输出图片的浏览器。支持标签、批量操作、元数据查看。

详见 [Gallery 文档](gallery/README_zh.md)。

## 核心节点

| 节点 | 分类 | 用途 |
|---|---|---|
| XYZ Multi Text Concatenate | XYZ Node | 拼接多个文本，支持自定义分隔符、前缀、后缀 |
| XYZ Multi Text Replace | XYZ Node | 模板替换，用 `[N]` 占位符对应第 N 个输入 |
| XYZ Multi Clip Encoder | XYZ Node | 批量 CLIP 编码多条正/负面提示词 |
| XYZ Random String Picker | XYZ Node | 从 `;` 分隔的标记项中随机选择，支持必选/排除标记 |

## 常见问题

**Q: 输入中文/日文找不到标签？**
插件不包含 wiki 翻译数据。搜索只匹配标签的英文名和画师曾用名。

**Q: 怎么回到工作数据库？**
Tag dataset → Snapshots → 点 tagdb.sqlite 那行的 "Use"。

**Q: 需要 Danbooru 账号吗？**
下载 Release 不需要。自己维护（Incremental/Full）需要免费 Danbooru 账号的 API key。

**Q: 标签数量和 Release 描述不一致？**
Release 的 min_post_count=50。你自己维护时 scrape threshold 设得低就会得到更多标签。

**Q: 标签数量变少了？**
检查你是否激活了一个 snapshot（列表里显示 "active"）。点 working DB 的 "Use" 切回来。

---

[English Version](README.md)
