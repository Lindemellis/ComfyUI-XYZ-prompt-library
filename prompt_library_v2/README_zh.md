# Prompt Library V2

基于 SQLite 的分层提示词库，用于 ComfyUI。用完善的数据库存储、模板引擎、触发器别名系统和丰富的浮动窗口编辑器替代了旧版 V1 基于 JSON 文件的方案。

## 架构

```
plv2.db (SQLite, WAL 模式)
    └── nodes        ← 文件夹与条目树（parent_id 自引用）
    └── prompts      ← 每个条目的提示词字符串及权重
    └── triggers     ← 自动生成 + 用户自定义别名
```

- **单写入器**——通过 `WriteQueue`（HIGH/MID/LOW 优先级队列）
- **短周期读取**——每次读取 API 打开自己的 `connect_read()`，用完即关
- **SQLite WAL**——写入不会阻塞并发读取
- **触发器自动重建**——每次节点创建/重命名/移动/删除后自动触发

## 节点

ComfyUI 中 **XYZNodes/Prompt** 分类下的两个节点：

| 节点 | 极性过滤 |
|------|----------------|
| **Prompt Library V2 Positive** | 仅正面（`pos_neg = 'positive'` 或 `'both'`）条目 |
| **Prompt Library V2 Negative** | 仅负面（`pos_neg = 'negative'` 或 `'both'`）条目 |

### 输入与输出

| 端口 | 类型 | 说明 |
|------|------|--------|
| `prompt_template` | STRING | 包含 `[ref]` / `{a\|b}` / 语法的多行文本 |
| `seed` | INT (0..0xFFFFFFFFFFFFFFFF) | 控制随机模式结果 |
| `resolved_prompt` | STRING | 完全解析后的输出 |
| `raw_template` | STRING | 原始模板文本（用于链式连接） |

节点**始终重新执行**（`IS_CHANGED` 返回 NaN），因为库数据库内容可能在两次运行之间发生变化。

## 模板语法

### `[entry_ref]` — 条目引用

解析为库条目的提示词文本。引用通过触发器系统查找：

```
[角色名]                  ← 最短唯一触发器
[角色名.表情]             ← 点路径指向子条目
```

解析顺序：精确 `full_path` 匹配 → 最长触发器前缀 → 子路径余部。

**循环安全**：最大递归深度 50，通过 frozenset 检测循环。未知引用静默移除。

### `{a|b|c}` — 多选项

用于多输提示词。由 ComfyUI 队列系统的输出索引控制选择哪个选项：

```
{大师作品|草图|涂鸦}
```

`output_index = 0` → `大师作品`，`output_index = 1` → `草图`，依此类推。超出范围 → 空字符串。

### `(text:weight)` — 权重包装

当库中的提示词 `weight ≠ 1.0` 时，引擎自动包装：

```
(发光眼睛:1.3)
```

### 清理规则

解析后引擎自动执行：
- 合并相邻/混合定界符（如 `, .` → `, `，`,,` → `, `）
- 去除每行前导的定界符
- 去除字符串末尾的定界符
- 将 2 个以上空格折叠为 1 个

## 数据库模式

### `nodes`

| 列 | 类型 | 说明 |
|--------|------|-------|
| `id` | INTEGER PK | |
| `parent_id` | FK → nodes(id) | NULL = 根级，级联删除 |
| `name` | TEXT NOT NULL | 单个路径段 |
| `full_path` | TEXT UNIQUE | 去规范化点号连接路径 |
| `has_template` | INTEGER | 类文件夹节点（含子条目） |
| `has_prompts` | INTEGER | 条目节点（含提示词文本） |
| `pos_neg` | CHECK('positive','negative','both') | 极性 |
| `shuffle` | INTEGER | 随机打乱提示词顺序 |
| `random_mode` | TEXT | `'none'` / `'select'` / `'dropout'` |
| `select_min` / `select_max` | INTEGER | 选择模式 |
| `dropout_rate` | REAL | 丢弃模式 |
| `format` | TEXT | 每个提示词的格式模板（`{prompt}` / `{p}`） |
| `delimiter` | TEXT | 提示词之间的连接符 |
| `order_index` | INTEGER | 兄弟节点排序 |
| `created_at` / `updated_at` | INTEGER | Unix 时间戳 |

### `prompts`

| 列 | 类型 | 说明 |
|--------|------|-------|
| `id` | INTEGER PK | |
| `node_id` | FK → nodes(id) | 级联删除 |
| `content` | TEXT NOT NULL | 提示词字符串 |
| `weight` | REAL DEFAULT 1.0 | 权重乘数 |
| `enabled` | INTEGER DEFAULT 1 | 是否启用 |
| `order_index` | INTEGER | 排序位置 |
| `source` | TEXT DEFAULT 'custom' | `'template'`（锁定）或 `'custom'`（可编辑） |

### `triggers`

| 列 | 类型 | 说明 |
|--------|------|-------|
| `id` | INTEGER PK | |
| `node_id` | FK → nodes(id) | 级联删除 |
| `trigger_text` | TEXT UNIQUE | `[...]` 引用的别名 |
| `is_auto` | INTEGER | 0 = 用户定义，1 = 自动生成 |

## 触发器系统

### 自动触发器

每次结构变更后，系统为所有条目重新生成自动触发器：

1. **最短唯一名称**——仅条目名（去掉祖先文件夹）
2. **消歧义**——如果两个条目同名，逐步引入父文件夹名
3. **full_path 回退**——保证唯一，当较短形式与其他触发器冲突时使用

### 自定义触发器

用户可以添加自定义别名。这些会阻止其他条目生成相同文本的自动触发器。创建时系统检查以下冲突：
- 所有现有触发器文本
- 所有 `full_path` 值
- 所有条目默认名称

### 冲突解决

当节点 A 的触发器遮蔽了节点 B 的路径时，B 的自定义触发器中那些现在匹配了其他节点 `full_path` 的会被**修剪**（作为被遮蔽项移除）。这保持了不变性：`full_path` 永远优先于任何触发器。

## 前端

前端是一组可磁吸在一起的浮动窗口：

### 文本编辑器 (`plv2_editor.js`)

- **两种模式**：单面板（标签页切换正/负面）或分屏（顶部正面、底部负面，可拖动分隔线）
- **引用高亮**：有效的 `[refs]` 以紫色背景显示；无效的以红色波浪下划线显示
- **每面板撤销/重做**（300 个检查点）
- **查找/替换**，支持大小写、全词、选区模式
- **智能插入**——分析光标上下文，定界符感知插入
- **右键菜单**——添加到条目、创建条目、在详情中打开
- **实时同步**——库中的更改会即时反映到编辑器中

### 库窗口 (`plv2_tree.js` + `plv2_entry.js`)

**树面板：**
- 文件夹/条目树，支持全部折叠/展开
- 过滤器：全部 / 正面 / 负面 / 使用中
- 排序：按名称或创建时间，升序/降序
- 右键菜单：插入引用、重命名、移动、新建文件夹/条目、删除（含使用分析）

**条目详情面板：**
- 行内名称编辑、极性切换
- 触发器别名及插入按钮和冲突检查
- 定界符选择器、格式输入、打乱复选框
- 随机模式：关闭 / 选择（最小-最大数量） / 丢弃（百分比）
- **双向提示词同步**——文本区 ↔ 结构化提示词列表（垂直或紧凑芯片模式）
- 子条目面板，含 `_template` 继承和 `_neg` 自动插入切换
- 导航历史（后退按钮）

### 预览窗口

只读实时渲染解析后的模板。显示节点在执行时将输出的内容。

### 窗口磁吸

库窗口和预览窗口可磁吸到编辑器窗口的左侧或右侧。组合体共享统一阴影和同步高度。拖动手柄可分离单个窗口。

## HTTP API

所有端点位于 `/xyz/plv2/` 下：

### 节点
| 方法 | 路径 | 用途 |
|--------|------|---------|
| GET | `/nodes` | 完整节点树 |
| POST | `/nodes` | 创建节点 |
| PATCH | `/nodes/{id}` | 更新节点字段/重命名 |
| DELETE | `/nodes/{id}` | 删除节点及子树 |
| POST | `/nodes/{id}/move` | 更改父节点 + 可选重命名 |

### 提示词
| 方法 | 路径 | 用途 |
|--------|------|---------|
| GET | `/nodes/{id}/prompts` | 列出提示词 |
| POST | `/nodes/{id}/prompts` | 添加提示词 |
| PATCH | `/prompts/{id}` | 更新提示词 |
| DELETE | `/prompts/{id}` | 删除提示词 |
| POST | `/nodes/{id}/prompts/reorder` | 批量重排序 |

### 触发器
| 方法 | 路径 | 用途 |
|--------|------|---------|
| GET | `/nodes/{id}/triggers` | 获取触发器（自动 + 自定义） |
| POST | `/nodes/{id}/triggers` | 添加自定义触发器 |
| DELETE | `/triggers/{id}` | 删除自定义触发器 |

### 解析与搜索
| 方法 | 路径 | 用途 |
|--------|------|---------|
| POST | `/nodes/{id}/preview` | 生成条目文本（不递归展开） |
| POST | `/resolve` | 完整模板解析 |
| POST | `/resolve_ref` | 将引用字符串解析为节点 |
| POST | `/resolve_shallow` | 解析引用但保留嵌套的 `[refs]` |
| POST | `/nodes/{id}/refs/replace` | 在所有提示词中用新路径替换旧路径 |
| GET | `/nodes/{id}/usages` | 查找对此节点子树的所有引用 |
| POST | `/nodes/{id}/strip_refs` | 从库提示词中移除特定引用 |

### 自动补全
| 方法 | 路径 | 用途 |
|--------|------|---------|
| GET | `/ac/prompts?q=&limit=` | 搜索库提示词（去重） |
| GET | `/ac/refs?q=&limit=` | 搜索条目路径和触发器 |
| GET | `/ac/entries_by_prompt?q=&limit=` | 查找包含提示词文本的条目 |

### 常用列表
| 方法 | 路径 | 用途 |
|--------|------|---------|
| GET | `/common/formats` | 常用格式字符串 |
| GET | `/common/delimiters` | 常用定界符 |

## 命名规则

- **节点名称**：不能包含 `.` `,` `|` `/` `\` `[` `]`
- **触发器文本**：不能包含空格 `,` `|` `/` `\` `[` `]`

## 规范化设置

编辑器支持可配置的提示词规范化，实时应用：
- **转义括号**：`()` → `\(\)`（保留 ComfyUI 权重语法）
- **半角**：全角标点 → ASCII（`，` → `,`）
- **下划线→空格**：`_` → ` `
- **修剪末尾定界符**：从行末移除 `,`、`.`、`|` 等
- 所有规范化跳过 `[...]` 引用和 `{...}` 模式内的文本

## 数据目录

```
prompt_library_v2_data/
└── plv2.db    ← SQLite 数据库（WAL 模式，256 MiB mmap）
```

完全 gitignored——每个 ComfyUI 实例维护自己的库。

---

[English Version](README.md)
