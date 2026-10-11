# ComfyUI-XYZNodes

[English](README.md) | **中文**

一个围绕提示词创作、图片管理和 Krita 工作流整理过的 ComfyUI 自定义节点包。

## 现有功能

| 工具 | 作用 | 手册 |
|---|---|---|
| **Prompt Library V4** | 用 Blocks / Source / Preview 编辑提示词，复用 Folder 池；包含独立 LoRA 浏览器、Schedule / Region / AVG Block，沿用 PLv3 语言和 prompt-control 编译器。 | [PLv4](prompt_library_v4/README_zh.md) |
| **Prompt Library V3** | 提示词语言、嵌套组、时间调度、区域、预设、已保存文档、Monaco 编辑器和实时详情控制，最终编译为 [comfyui-prompt-control](https://github.com/asagi4/comfyui-prompt-control) 语法。 | [PLv3](prompt_library_v3/README.md) |
| **标签自动补全** | 仅英文的 Danbooru 标签和可选 Gelbooru 标签；本地数据集支持更新、快照和按日期回溯。 | [TagDB](tagdb/README_zh.md) |
| **XYZ Gallery** | 浏览和管理 ComfyUI 图片与视频，查看元数据、筛选、打标签、下载不同净化版本，并发送到 Krita。 | [画廊](gallery/README_zh.md) |
| **遮罩节点** | 画矩形遮罩并挂到 CLIP，供 PLv3 的 `imask: i` 区域使用。 | [遮罩](mask_nodes/README_zh.md) |
| **Krita 联动** | 从 Krita 获取图片或遮罩、拆分颜色区域、打开文件，以及把生成结果作为图层或文档送回 Krita。 | [Krita](krita_nodes/README_zh.md) |
| **Cache Slot** | 把图片写入命名槽，在之后的运行中读取。 | [Cache](cache_nodes/README_zh.md) |
| **Inpaint RGBA** | 把 Inpaint Crop and Stitch 的结果变成位置正确的透明 RGBA 图层。 | [源码](inpaint_nodes/) |
| **ComfyUI Agent 联动** | 为独立的 comfyui-mcp 面板/编排器提供本地启动器和安全边界。 | [Agent](agent_nodes/README.md) |

Prompt Library V2 和早期原创 LLM 提示词助手已经退役。个人 PLv2 数据目录不会被删除；[一次性 V2 → V3 迁移工具](prompt_library_v3/README.md#migrating-from-v2)继续保留。

向 PLv3 库组复制、新增或编辑标签时，未转义的下划线会转换为空格，权重语法之外的括号会
自动转义；外层 `(tag:weight)` 会保留其权重。

## 安装

1. 把本仓库克隆到 `ComfyUI/custom_nodes/`。
2. 使用 PLv3 或 PLv4 时安装 [comfyui-prompt-control](https://github.com/asagi4/comfyui-prompt-control)。
3. 只有在你要自行抓取或更新 Danbooru 时，才需要额外安装 `curl_cffi>=0.7.0`；下载预构建数据集不需要。
4. 重启 ComfyUI。

已有安装更新代码后，重启正式 ComfyUI，并在浏览器按 **Ctrl+F5** 加载新版界面。个人 Library、模型文件和 workflow 保留；无需复制测试环境的数据。

首次运行时，预构建 Danbooru 数据集会在后台下载。下载完成后自动补全即可使用。数据集只保存和搜索英文规范名与英文别名；不保存日文、中文 wiki 翻译，这是明确的设计选择。

## 节点

| 节点 | 分类 | 用途 |
|---|---|---|
| XYZ Prompt Library V4 | `XYZNodes/Prompt` | 编辑 Block 和 Folder 池，编译为 prompt / plain 输出 |
| XYZ Prompt Library V4 Monaco | `XYZNodes/Prompt` | 同一 V4 编译器，节点内嵌源码编辑器 |
| XYZ Prompt Library V3 | `XYZNodes/Prompt` | 用普通文本框编辑并编译 PLv3 文档 |
| XYZ Prompt Library V3 Monaco | `XYZNodes/Prompt` | 同一编译器，节点内嵌完整编辑器 |
| XYZ Mask Editor | `XYZNodes/Mask` | 画矩形并输出 base、fill 和逐矩形遮罩 |
| XYZ Attach Masks | `XYZNodes/Mask` | 按 PLv3 IMASK 顺序把遮罩挂到 CLIP |
| XYZ Krita Fetch Image | `XYZNodes/Krita` | 把 Krita 图层或文档取为 `IMAGE` |
| XYZ Krita Fetch Mask | `XYZNodes/Krita` | 把遮罩图层或绘画图层 alpha 取为 `MASK` |
| XYZ Krita Fetch Color Masks | `XYZNodes/Krita` | 把纯色区域拆成动态遮罩输出 |
| XYZ Krita Send To Krita | `XYZNodes/Krita` | 把图片发送为 Krita 新图层或新文档 |
| XYZ Krita Open File | `XYZNodes/Krita` | 在 Krita 打开图片或 `.kra` 文件 |
| XYZ Cache Slot Write / Read | `XYZNodes/Cache` | 在不同运行间保存和读取图片 |
| XYZ Inpaint Stitch To RGBA | `XYZNodes/Inpaint` | 输出位置正确的透明修补图层 |

## 界面入口

顶栏提供 XYZ Gallery，以及 **XYZ Tools** 菜单中的 V4 编辑器、原 V3 编辑器/库、TagDB 维护、设置、Krita 和可选 Agent 启动器。提示词节点的 **Editor** 按钮打开 V4 窗口，V3 节点继续兼容。

V4 将有序 **Content** 和可选 **Pool** 候选分开：用 **+** 添加，在 Content 编辑或关闭，显式保存常用 Block。单击 Library 浏览共用一个临时标签；编辑或双击后常驻。拖拽、搜索、Region / Schedule 设置和迁移见 [V4 手册](prompt_library_v4/README_zh.md)。

## 数据与隐私

运行数据位于 Git 忽略的 `tagdb_data/`、`prompt_library_v3_data/`、`prompt_library_v4_data/`、`gallery_data/`、`krita_data/`、`agent_data/`、`output/` 等目录。V4 使用独立 `plv4-pools.db`，不自动迁移个人 V3 数据；Library 迁移命令先备份，再导入，不替换原库。退役的 `prompt_library_v2_data/` 同样原样保留，用于迁移。

TagDB 接口不会把已保存 API key 返回给浏览器；Agent 控制接口只接受本机回环地址请求。
