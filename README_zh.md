# ComfyUI-XYZNodes

一个 ComfyUI 自定义节点包，集成了 **提示词工程工具**、**图片浏览器** 和 **Danbooru 标签自动补全** 系统。

## 功能概览

| 模块 | 说明 |
|--------|-------------|
| [**Prompt Library V2**](prompt_library_v2/) | 基于 SQLite 的分层提示词库，包含模板引擎、触发器别名系统和浮动窗口编辑器。 |
| [**图片浏览器**](gallery/) | 功能完整的图片浏览器，支持元数据提取、标签管理、缩略图生成、WebSocket 实时同步和批量操作。 |
| [**标签数据库**](tagdb/) | Danbooru 风格标签自动补全，FTS5 三元组搜索，分类颜色，关联标签，画师预览。预构建数据集下载，无需爬虫。 |

外加 4 个轻量级工具节点，用于字符串拼接、文本替换、CLIP 编码和随机选择。

## 安装

1. 进入 ComfyUI 的 `custom_nodes` 目录：
   ```bash
   cd ComfyUI/custom_nodes/
   ```

2. 克隆本仓库：
   ```bash
   git clone https://github.com/zhupeter010903/ComfyUI-XYZ-prompt-library.git
   ```

3. 安装依赖：
   ```bash
   pip install -r ComfyUI-XYZ-prompt-library/requirements.txt
   ```
   唯一依赖为 `curl_cffi>=0.7.0`——仅当您需要自己爬取 Danbooru 构建标签数据库时才需要。使用预构建数据集则**不需要**。

4. 重启 ComfyUI。

首次启动时，标签数据库会自动在后台下载预构建数据集。图片浏览器和 Prompt Library V2 会自动初始化数据库——无需手动配置。

## 核心节点

所有节点位于 ComfyUI 的 **XYZ Node** 或 **XYZNodes/Prompt** 分类下。

| 显示名称 | 分类 | 说明 |
|---|---|---|
| **XYZ Multi Text Concatenate** | XYZ Node | 使用可配置的分隔符、前缀和后缀拼接多个字符串输入。可动态接收任意数量的额外字符串输入。 |
| **XYZ Multi Text Replace** | XYZ Node | 基于 `[N]` 占位符的模板替换。输入模板和任意数量的 `[1] value` 映射字符串。 |
| **XYZ Multi Clip Encoder** | XYZ Node | 在单个节点中批量 CLIP 编码多个正面/负面提示词。 |
| **XYZ Random String Picker** | XYZ Node | 从分号分隔的标记项中随机选择。支持 `:1`（必选）/ `:0`（排除）标签、可配置的选择数量范围和种子控制。 |
| **XYZ Prompt Library** | XYZNodes/Prompt | **旧版 V1**——基于 JSON 文件的分层提示词库，支持 `{a\|b}` 模式、`[[tag]]` 解析和 `[entry]` 引用。 |
| **XYZ Prompt Library V2 Positive** | XYZNodes/Prompt | 当前 V2 版本，基于 SQLite。解析 `[ref]`、`{a\|b}`、加权 `(text:wt)` 语法。过滤正面极性条目。 |
| **XYZ Prompt Library V2 Negative** | XYZNodes/Prompt | 同 V2 Positive，过滤负面极性条目。 |

## 子模块

### [Prompt Library V2](prompt_library_v2/) → [完整文档](prompt_library_v2/README_zh.md)

基于 SQLite 的分层提示词库，提供：
- **模板引擎**——`[entry_ref]` 展开、`{a|b}` 选择、`(text:1.2)` 权重包装、随机模式（选择/丢弃/洗牌）
- **触发器别名系统**——自动最短唯一名称触发器、用户自定义别名、冲突解决
- **浮动窗口编辑器**——分屏正/负面面板、语法高亮、撤销/重做、查找/替换、定界符感知智能插入
- **文件夹树 & 条目详情**——极性/使用中过滤、拖拽排序提示词、`_neg` 自动插入、`_template` 继承
- **规范化设置**——转义括号、全角→半角、下划线→空格、自动修剪定界符
- **循环安全解析**——最大深度 50，通过 frozenset 追踪检测循环

### [图片浏览器](gallery/) → [完整文档](gallery/README_zh.md)

适用于 ComfyUI 输出的功能完整的图片浏览器：
- **自动索引**——启动时冷扫描、增量对账、文件系统监控（watchdog）
- **游标分页浏览**——按文件夹、标签、模型、提示词（F04 词模式匹配）、收藏、日期范围过滤
- **缩略图生成**——320×320 WebP 按需生成，基于 SHA-1 内容缓存，不可变缓存头
- **丰富元数据提取**——正/负面提示词、模型、种子、CFG、采样器、调度器、工作流 JSON
- **标签系统**——通过 UI 添加/删除标签，规范化标签词汇表自动补全，批量标签操作
- **批量操作**——两阶段（预检+执行）的移动、删除、收藏、标签操作
- **WebSocket 实时同步**——所有连接的标签页即时看到变化（新增、删除、文件夹变更、索引进度）
- **元数据写回**——PNG chunk 同步（收藏、标签）回源文件
- **虚拟网格 + 行视图**——紧凑网格或分区分组行布局，均支持虚拟滚动

### [标签数据库](tagdb/) → [完整文档](tagdb/README_zh.md)

Danbooru 标签自动补全，预构建分发模型：
- **FTS5 三元组搜索**——标签名 + 别名 + 翻译的快速子串匹配
- **两级回退**——3+ 字符查询使用三元组，短查询/CJK 查询使用 LIKE 回退
- **预构建数据集**——首次运行从 GitHub Release 下载，无需爬虫
- **增量更新**——基于事件水印的增量同步，仅获取新数据
- **全量重建**——按可配置的 `min_post_count` 重新爬取所有标签
- **关联标签**——从 Danbooru API 懒加载缓存，可配置新鲜度窗口
- **画师预览**——悬停显示最近作品缩略图网格
- **标签图片预览**——任意标签的缓存示例图片（10 分钟 TTL）
- **分类颜色**——general、artist、copyright、character、meta 标签以不同颜色渲染
- **翻译 DLC**——可选的多语言（日/中）搜索支持
- **快照管理**——在工作数据库、官方发布版本和本地导出检查点之间切换
- **前端集成**——`tagac.js` 为 ComfyUI 中每个多行 STRING 组件提供行内自动补全
- **PLv2 交叉集成**——在下拉框中同时显示提示词库条目和标签建议

## 项目结构

```
ComfyUI-XYZNodes/
├── __init__.py                  # 节点注册、V1 API 路由、子模块启动
├── node.py                      # 核心工具节点
├── prompt_library_node.py       # 旧版 V1 Prompt Library 节点
│
├── prompt_library_v2/           # V2 Prompt Library（基于 SQLite）
│   ├── node.py                  #   节点类
│   ├── db.py                    #   数据库模式与迁移
│   ├── engine.py                #   模板解析引擎
│   ├── trigger.py               #   触发器别名系统
│   ├── repo.py                  #   数据访问（WriteQueue）
│   ├── routes.py                #   HTTP API
│   └── README_zh.md             #   完整文档
│
├── gallery/                     # 图片浏览器子系统
│   ├── indexer.py               #   图片索引与扫描
│   ├── watcher.py               #   文件系统监控（watchdog）
│   ├── vocab.py                 #   提示词/标签分词规范化
│   ├── thumbs.py                #   缩略图生成与缓存
│   ├── metadata.py              #   PNG 元数据提取
│   ├── metadata_sync.py         #   元数据写回文件
│   ├── service.py               #   业务逻辑（批量操作等）
│   ├── routes.py                #   HTTP API（69 个端点）
│   ├── ws_hub.py                #   WebSocket 广播中心
│   ├── repo.py                  #   数据访问（WriteQueue）
│   ├── db.py                    #   数据库模式与迁移（v1-v6）
│   └── README_zh.md             #   完整文档
│
├── tagdb/                       # 标签数据库子系统
│   ├── db.py                    #   数据库模式（V2，FTS5 三元组）
│   ├── repo.py                  #   搜索与数据访问
│   ├── scraper.py               #   Danbooru 爬虫（curl_cffi）
│   ├── updater.py               #   全量与增量更新逻辑
│   ├── distribution.py          #   预构建数据集下载/校验
│   ├── build_dataset.py         #   作者构建官方数据集的 CLI 工具
│   ├── routes.py                #   HTTP API
│   └── README_zh.md             #   完整文档
│
├── js/                          # 前端 JavaScript
│   ├── plv2.js                  #   PLv2 窗口管理与磁吸
│   ├── plv2_editor.js           #   PLv2 文本编辑器
│   ├── plv2_tree.js             #   PLv2 文件夹树
│   ├── plv2_entry.js            #   PLv2 条目详情
│   ├── tagac.js                 #   全局标签自动补全
│   ├── tagdb_panel.js           #   TagDB 管理面板
│   ├── xyz_topbar.js            #   顶部栏扩展
│   ├── xyz_settings.js          #   设置面板
│   └── gallery_dist/            #   图片浏览器 SPA（Vue 3）
│
├── test/                        # 测试套件
├── node_definition.json         # ComfyUI V2 节点定义 JSON Schema
├── requirements.txt             # curl_cffi >= 0.7.0
├── README.md                    # 英文版
├── README_zh.md                 # 本文件
└── CLAUDE.md                    # Claude Code 项目说明
```

## 配置

每个子模块管理各自的数据和配置：

| 模块 | 数据目录 | 配置 |
|--------|---------------|--------|
| Prompt Library V2 | `prompt_library_v2_data/plv2.db` | 规范化设置（localStorage） |
| 图片浏览器 | `gallery_data/`（数据库、缩略图、配置） | `gallery_config.json`，UI 偏好通过 API 设置 |
| 标签数据库 | `tagdb_data/`（工作库、快照） | `settings.json`（凭据）、`tagdb/official_manifest.json`（已提交） |

## 开发

测试文件位于 `test/` 目录，命名为 `t*_test.py`。运行：

```bash
python -m pytest test/ -v
```

仓库根目录的 `CLAUDE.md` 文件包含详细的架构说明、编码规范和注意事项，供贡献者参考。

## 兼容性

- ComfyUI（较新版本，支持 V2 节点 API）
- Python 3.10+
- 可选：`curl_cffi` 用于 TagDB 爬取（使用预构建数据集则不需要）

---

[English Version](README.md)
