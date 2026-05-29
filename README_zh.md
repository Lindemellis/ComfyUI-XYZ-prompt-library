# ComfyUI-XYZNodes

[English](README.md) | **中文**

一个 ComfyUI 自定义节点包，包含三个较大的工具——**Danbooru（+ 可选 Gelbooru）标签自动补全**、**分层提示词库（V2）**、**图片画廊**。

每个工具都有独立手册：

- 📖 [标签自动补全与数据集](tagdb/README_zh.md)
- 📖 [提示词库 V2](prompt_library_v2/README_zh.md)
- 📖 [图片画廊](gallery/README_zh.md)

## 安装

1. 进入 ComfyUI 的 `custom_nodes` 目录：
   ```bash
   cd ComfyUI/custom_nodes/
   ```
2. 克隆本仓库：
   ```bash
   git clone https://github.com/Lindemellis/ComfyUI-XYZ-prompt-library.git
   ```
3. *（可选）* 安装 `curl_cffi`——**仅当**你想自己从 Danbooru 抓取/更新标签数据集时才需要。下载预构建数据集不需要它：
   ```bash
   pip install curl_cffi>=0.7.0
   ```
4. 重启 ComfyUI。

**首次运行**时，会在后台自动下载预构建的 Danbooru 标签数据集（约 66 MB，约 11.8 万个 post_count ≥ 50 的标签）。下载完成后标签自动补全即可用。不会自动抓取——如果下载失败（离线等），可在「标签数据集」面板手动重试。

## 功能

| 工具 | 作用 | 手册 |
|---|---|---|
| **标签自动补全** | 在任意提示词框输入时给出 Danbooru 标签建议；带有版本化的本地数据集、增量/全量更新、快照，以及按日期回溯的「时间机器」重建。 | [tagdb](tagdb/README_zh.md) |
| **提示词库 V2** | 基于 SQLite 的分层提示词库，支持 `[ref]` 引用、触发别名、权重、随机模式，以及浮动文本编辑器。由两个节点在执行时解析。 | [plv2](prompt_library_v2/README_zh.md) |
| **图片画廊** | 浏览与管理 ComfyUI 的 output/input 图片——筛选、标签、批量操作、元数据查看。 | [gallery](gallery/README_zh.md) |

## 入口在哪里

重启 ComfyUI 后，顶栏会出现两个按钮：

- **Open XYZ Gallery**（图片图标）——打开画廊。
- **XYZ Tools**（菜单）——打开：
  - *Prompt Library V2 — Library*（库）
  - *Prompt Library V2 — Text Editor*（文本编辑器）
  - *Prompt Library V1 Manager*（旧版）
  - *XYZ Prompt Tools Settings*（设置）

**设置窗口**（也可从 ComfyUI 命令面板的 *"Open XYZ Prompt Tools settings"* 打开）包含以下标签页：

| 标签页 | 控制项 |
|---|---|
| Autocomplete | 总开关、最大建议条数、隐藏冷门标签、**Danbooru / Gelbooru 来源** |
| Insertion | 下划线→空格、自动逗号、转义括号、全角→半角 |
| Library | 把你的提示词库作为补全来源；条目引用建议 |
| Related | 点击标签查相关标签 + 缓存有效期 |
| Preview | 悬停显示画师作品 / 标签预览图（默认均**关闭**） |
| Tag dataset | **Danbooru / Gelbooru 两个分页**：凭据、预构建数据集、更新、快照、重建 |
| About | 版本 / 信息 |

每个 Prompt Library V2 节点上也有各自的 **Library / Editor / Preview** 按钮。

## 节点

| 节点 | 分类 | 用途 |
|---|---|---|
| XYZ Prompt Library V2 Positive | `XYZNodes/Prompt` | 针对库解析正向提示词模板 |
| XYZ Prompt Library V2 Negative | `XYZNodes/Prompt` | 针对库解析负向提示词模板 |
| XYZ Prompt Library | `XYZNodes/Prompt` | 旧版 V1 提示词库节点（保留以兼容） |

## 常见问题

**输入日文/中文找不到标签？**
数据集不包含 wiki 翻译。搜索只匹配英文标签名和画师曾用名。

**需要 Danbooru 账号吗？**
下载预构建数据集不需要。只有自己跑增量/全量更新或构建数据集时，才需要（免费的登录名 + API key）。

**标签数量和 Release 写的对不上？**
Release 以 `min_post_count = 50` 构建。如果你用更低阈值自己更新，会得到更多标签。

**标签数量突然变少？**
可能是切换了活动快照。在 *Tag dataset → Snapshots* 里，点工作库（`danbooru.sqlite`）那一行的 **Use** 切回去。

**Gelbooru 来源是什么？**
可选的第二套标签集。在 *设置 → Autocomplete → Gelbooru tags* 启用，在 *Tag dataset → Gelbooru* 安装数据集。两个来源都开启时，建议会合并去重，每行显示可点击的 **D**/**G** 角标（Danbooru wiki / Gelbooru 帖子）。冲突时以 Danbooru 为准；Gelbooru 仅当前快照（无时间回溯）。详见[标签手册](tagdb/README_zh.md#gelbooru第二来源)。

---

数据目录（`tagdb_data/`、`prompt_library_v2_data/`、`gallery_data/`、`prompt_library/`）在运行时创建，且已被 gitignore。
