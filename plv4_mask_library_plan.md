# PLV4 Mask Library 实施方案

2026-10-13。依据本聊天最新设计与五项修正整理。

**当前状态：用户已确认方案，2026-10-13 按 A–E 实施。** 独立资源库、V4 适配、编辑界面、节点消费者与双语说明已加入工作区；验证记录见下方。此前「PLV4 内置 drawn mask 列表」设计由本文替代。

用户已经明确的产品规则与本文采用的工程默认值分开记录；默认值无需新增需求即可落地，但后续用户修正优先。

## 已确定的产品行为

- 独立 Mask Library，以画布为一级资产：矩形画布、图片画布。入口位于 PLV4 主窗口左侧 Library / Masks 切换栏，并提供独立库窗口。
- 矩形画布保存多个矩形；形状为 `[x1, x2, y1, y2]` 归一化四数，另存稳定 ID、名称、预览颜色与顺序。
- 矩形编辑窗口左侧列表（预览、颜色、删除、拖动排序、点击选中、添加），右侧画板（空白拖动创建、选中拖动、四角与四边 resize）。添加按钮解决整图已被覆盖时无法绘制的问题。
- 独立 Region mask 四数仍可编辑；编辑按钮打开只有一个矩形的同一编辑组件。
- 从库选择矩形后显示关联与预览，四数只读；编辑按钮打开所属库画布并选中该矩形。修改库共享更新引用；解除连接保留副本；删除库矩形时 Region 转为独立副本。
- 图片画布读取 `input/xyz_masks/`（可在库中设置 input 下相对目录），不写入原图片。第一期仅读取、刷新、提取和展示，不集成原生图片编辑器。
- 图片 alpha 默认 `1-alpha`，可反转。颜色分割将同色所有区域合为一个 mask，黑白参与；选面积前 n，面积并列 RGB 升序。默认颜色容差 0.05（RGB 欧氏距离 / sqrt(3)/255）；主色只统计 alpha>=128 的像素，分配到容差内最近主色，透明处为零。n 默认 4，最大 32。
- Region imask 保留手动数字；选择图片库项后显示只读路径及提取项、预览，× 解除连接并恢复上次手动数字。
- 图片库项以文件相对路径 + 提取项（alpha / RGB）稳定识别，排名和显示顺序不是身份。
- PLV4 在现有 prompt/plain/metadata 后追加 `PLV4_MASK_BUNDLE`，原插槽不变。矩形编译成 MASK，图片映射到 IMASK；同一图片提取项挂一次。手动编号不改。
- 新 `XYZ PLV4 Mask Preview` 接 bundle；默认 512×512，直接拉伸为 1:1，不补边；输出彩色 IMAGE 和动态单独 MASK，并在不运行工作流时显示编辑预览。
- 新 `XYZ PLV4 Attach Masks` 接 CLIP 与 bundle，仅挂图片遮罩。遇到预期 / 实际 IMASK 索引不一致只汇总 warning，继续追加，不纠正 prompt、不覆盖已有 mask。原 `XYZ Attach Masks` 保留。
- 矩形、图片列表使用自定义二级预览选择器，支持 hover 与点击展开。

## 数据及执行边界

- Mask Library 使用独立 `prompt_library_v4_data/masks.db`，沿用 shared WriteQueue；不扩展现有 Folder/Class 资产约束，不转换个人库。
- 画布写入检查版本，稳定 mask ID 跟随重排；图片文件只允许位于配置的 input 子目录，拒绝目录逃逸。
- Region `meta.mask_library` 存资产引用、最近解析快照、原手动 imask；普通 prompt Library Block 仍维持快照规则，新的共享关系只属于 Mask Library。
- 资源解析位于 V4 adapter，纯 `compile_text` 不读取库。Document/Source 编辑继续走同一 history。资源替换使用已有 SetRegion/SetSettings 命令，不手写另一套 grammar。
- 每次执行一次解析资源，再产生 prompt / bundle / metadata，防止版本撕裂；IS_CHANGED 纳入使用资源版本与图片内容指纹。删除矩形保留 tombstone，以便未打开的旧 workflow 解析最终坐标后解除引用。
- 未引用库的旧文档走原编译路径；V3 输出/执行语义不改，现有手写坐标保留。
- bundle 顺序以启用 Document 的首次引用顺序固定，不按随机结果重排；关闭祖先不参与。随机与 Schedule 只影响 prompt，不改变挂载槽身份。编辑预览为启用引用的几何，不宣称模型执行效果。
- 矩形颜色只用于预览；不改变实际 MASK 区域。Region feather/weights 不写入库矩形。预览输出为几何遮罩，Region 的 PC 参数继续编译；图片原始柔边保留，不额外羽化。
- 多尺寸图片在 bundle 中按共同 512×512 解析，保持挂载与预览一致；图片提取配置与文件内容变化使缓存失效。
- 前端预览读取上游当前 Document 与只读资源解析接口；不把上次执行输出冒充编辑预览。动态连接按稳定资源 key 保存，不因删除/排序指向另一 mask。
- 保存/复制 Block 保留引用及快照，矩形缺库可独立执行；图片缺文件明确报错，不自动变空白或全图。

## 实施顺序与验收

1. 资源库、路径约束、图片提取、bundle、V4 编译与节点注册。
2. Mask Library 面板、复用矩形编辑器、Region 二级选择/预览/引用与共享更新。
3. 节点实时编辑预览、动态 MASK 插槽与稳定连接。
4. 定向隔离检查：坐标/图片提取、删除 fallback、缓存失效、IMASK warning、真实键鼠绘制/resize/选择/排序/关联与刷新。不扩跑历史全量 suite，不操作持久 8190、正式实例或个人数据。
5. 更新中英文使用说明、DEVELOPMENT 与本文件实施状态。未授权 commit/push 或正式实例重启。

## 入口与窗口生命周期

### Mask Library

- PLV4 主窗口最左侧提供 Library / Mask Library 两个 icon，放进面板标题行，切换同一左侧面板；保持中间 Blocks / Source / Preview 与右侧 Settings。新增界面标签统一英文并沿用 PLV4 样式。
- 每个面板独立保留滚动、展开和选择状态；切换不提交虚假的文档修改、不新增 Undo 步骤。
- Mask Library 面板有明确标题，按 Rectangles / Images 分组。画布 item 直接显示编辑/查看、重命名、删除操作；图片另有提取设置和重新定位入口，不再先点齿轮选择操作。
- 图像目录默认为 `input/xyz_masks/`，用户可更换 input 下相对子目录。只读扫描，不自动创建、复制、改名或删除输入图片。
- 提供手动刷新；同一页面内完成的库修改即时广播。外部程序改图由刷新或下次执行重新读取，不引入持续全目录轮询。
- XYZ Tools 可打开独立 Mask Library 窗口，便于没有打开 PLV4 编辑器时管理资产。面板与窗口共用同一个数据服务。

### 矩形编辑器

- Library 模式标题显示画布名称；单矩形模式标题显示所属节点/Region，避免编辑错目标。
- 列表和画板双向选中。点击重叠位置优先命中显示最上层矩形；被遮挡的矩形仍可从列表选中。
- 拖动 handle 才排序；一次拖动可以跨越任意多个位置，显示目标插入线与 Move here 提示，长列表靠边自动滚动。拖动期间不移动捕获 pointer 的 DOM 行，松开后提交一次；Escape 取消。点击缩略图/名称选中并同步坐标属性，不触发排序。颜色修改跟随 mask ID，不跟随列表排名。
- 顶部 Add mask 默认创建中心矩形 `[0.25, 0.75, 0.25, 0.75]`，并选中。添加/绘制时从现有预览颜色中选择感知距离最大的未用颜色，调色板耗尽后生成新的不同颜色；名称使用第一个空闲的 Mask n。独立模式没有添加、删除、排序功能，始终恰好一个矩形。
- resize 支持八个 handle，夹到画布 0–1；最小有效宽高，反向拖动归一化，不生成负宽高或零面积。
- 按下/拖动期间只更新本地预览；松开时提交一次修改和一次 Undo。取消手势恢复原数据；提交失败显示错误并保留可恢复草稿。
- 库画布支持自己的 Undo/Redo，恢复操作产生新版本，不倒退版本号；检查被撤销项仍是预期版本，避免撤销覆盖另一窗口的新改动。
- 窗口关闭清理 pointer listeners、订阅与未完成的预览请求；过期响应不能修改其他节点/新工作流。

## Region 交互细则

| 状态 | 输入框 | 编辑按钮 | 预览 | 解除按钮 |
|---|---|---|---|---|
| 独立 mask | 四个坐标可编辑，顺序 x1/x2/y1/y2 | 单矩形窗口 | 当前几何 | 无 |
| Library mask | 四个坐标只读 | 所属库画布，选中目标矩形 | 已解析矩形 | 保留坐标，转独立 |
| 手动 imask | 单独带 IMASK 标签的非负整数输入框，0 基；普通 Block、Region 父页面和 entry 页面均显示 | 无图片编辑 | 无，不能猜外部数据 | 无 |
| Library imask | 只读路径 + Alpha/RGB 提取项，隐藏手动整数输入框 | View canvas 打开所属图片画布并高亮提取项，无绘画入口 | 提取出的 mask | 恢复先前手动整数 |

- 切换 kind 不删除正文。离开 mask/imask 类型时移除不适用的库关联，保持其他合法 Region 参数。
- selector 使用自定义二级菜单；一级画布整体缩略图，二级 mask 缩略图与名称。hover、键盘 focus 或点击都可以展开，Esc/点击外部关闭。
- 菜单必须在正文 blur 导致重绘之前保留当前 pointer 目标，沿用窗口已有事件/提交处理，不新增 Monaco 或语言实现。
- 绑定坐标的更新来自库；Region 设置只编辑其自身权重、feather、include base 等配置。删除库矩形后，关联标签消失，最后快照成为可编辑独立矩形。
- Source 手动改变绑定 Region 的坐标、类型或 IMASK 选择时，按显式内容编辑解除不再匹配的关联，不能在下一次刷新时覆盖用户输入。只改正文不解除。
- Source 为可运行语法投影；仅复制 Source 不携带 Library 引用、图片或预览颜色。需要完整恢复时使用 workflow / Document / metadata。

## 图片提取细则与默认值

| 配置 | 第一版默认 | 说明 |
|---|---|---|
| 目录 | `input/xyz_masks/` | 可配置 input 内相对子目录 |
| 格式 | PNG / WebP / JPEG / BMP 的静态第一帧 | 优先使用无损平涂图片；不提供动画逐帧输出 |
| Alpha | `1-alpha`，可反转 | 与 ComfyUI 原生遮罩图方向兼容；无 alpha 的文件标明不可提取 alpha |
| 颜色数量 n | 4，范围 1–32 | 少于 n 个主色时输出实际数量 |
| 主色面积 | alpha >= 128 像素计数 | 黑白都参与，同 RGB 的不连通块合并 |
| 并列面积 | RGB 数值升序 | 确定性排序 |
| 颜色容差 | 0.05，范围 0–1 | 欧氏 RGB 距离除以 sqrt(3)×255，默认阈值约 22 |
| 边缘分配 | 容差内最近入选颜色 | 超出容差为零；原 alpha 可作为输出透明度，颜色 mask 不互相抢同一个像素 |
| 输出尺寸 | 512×512 | 直接拉伸，不补边；预览与挂载采用相同数据 |

- 前 n 大只决定哪些颜色可选择及显示顺序；引用键采用确切 RGB，不能使用“第 1 大”这样的排名。
- 调整 n 或修改图片导致已引用颜色消失时，Region 明确显示缺失，执行报资源缺失，不自动换成别的颜色。
- Alpha / 彩色提取都不改原文件。图片刷新后重算提取项，内容指纹同时更新。
- 预览颜色和用于分割的源 RGB 分开存放，避免调整预览颜色改变提取目标。
- 抗锯齿默认属于保守归类，不承诺所有边缘无缝；容差可调。分割同一图片只进行一次，复用到各 Region 和缩略图。
- 目录变更后旧引用仍保留原相对 input 路径：只要文件位于先前登记的受控目录且仍存在，已有引用可继续使用；新发现只扫描当前目录。重定位文件是显式操作。

## 引用、删除与资源历史

- RectangleMask 的稳定 ID 与显示名称、顺序分离。PictureMask 的稳定身份为登记图片画布 ID + alpha/RGB key，文件路径只作来源属性。
- 库修改推送使打开的引用刷新；这种刷新是外部资产更新，不向每个文档添加普通编辑 Undo。用户绑定/解除仍进入本 Document 的 history。
- 关闭的 Region 保留关联和快照，稍后启用可重新解析；disabled 不是删除。
- 删除矩形/画布写入 tombstone，保存删除前最后坐标；未打开旧 workflow 下次解析时也能解除关联并保留最终副本。
- 删除图片库条目不删除 input 文件。只要原文件还存在，可保留文件/提取规则副本；实际文件缺失则要求重新定位。不能用一个 PNG 路径声称工作流已经自包含。
- Library Block/Document 保存引用 + fallback；普通 Prompt Library 的 Class/Pool/Block 关系不因这项功能变为共享指针。
- 图片原生编辑、新建空白图片、覆盖/另存为全部延期；不为复用原生编辑器而向个人 workflow 插入临时节点。

## bundle 契约与执行顺序

bundle 是执行资源快照，带独立 schema/version，不是一个可变数据库对象引用。第一版计划字段：

```text
schema / version
source document identity + revision（诊断用，不作为节点数值 ID 身份）
width / height = 512 / 512
items[]:
  stable key / kind / canvas identity / mask identity / display label
  preview color
  rectangle coordinates 或解析后的图片 mask
  图片来源、提取设置、内容 fingerprint
  仅图片项携带 expected_imask
```

- 资源 resolver 在一次执行内获得一个一致快照；所有 Region 引用解析完成，再调用现有纯编译器。不能 prompt 使用旧版本、bundle 使用新版本。
- 启用 Document 的首次引用顺序决定条目顺序；相同资源 key 去重。关闭祖先下的引用不挂载；Schedule、Dropout、Random select 不重新排列槽位。无法求值 seed 时编辑预览仍展示启用引用的几何。
- 矩形在 prompt 中输出 MASK 坐标；其栅格 MASK 输出按 PC 相同坐标量化生成。现有 Region feather 不迁入库，也不宣称几何预览等于羽化后的 conditioning。
- 图片在 prompt 中使用自动 IMASK，按图片项顺序从 0 编号。手动 IMASK 仍使用用户值，不参与自动重编号。
- 读取库、图片、指纹不进入共享 parser/IR/compiler；通过 V4 专用资源 adapter 实现。V3 历史执行路径保持。
- 追加 output 为第四插槽，前三插槽的身份和位置不变；恢复旧节点输出布局时只追加缺失插槽，不能重新建立已有链接。
- IS_CHANGED 纳入被引用资产的版本和图片内容；未引用资产修改不影响该节点执行缓存。损坏资源明确执行失败，不使用缓存的旧 mask 掩盖问题。
- mask bundle 与 metadata 分开；metadata 记录引用、解析规则、坐标与文件指纹，不默认塞入大尺寸遮罩像素。

建议连接：

```text
PLV4.prompt ───────────────→ PC Schedule LoRAs.text
PLV4.prompt ──────────────────────────────────────→ PC Schedule Prompt.text
CLIP → PC Schedule LoRAs → XYZ PLV4 Attach Masks → PC Schedule Prompt.clip
PLV4.mask_bundle ─────────→ XYZ PLV4 Attach Masks.mask_bundle
PLV4.mask_bundle ─────────→ XYZ PLV4 Mask Preview.mask_bundle
```

### 警告而不修正的 IMASK 策略

- 挂载节点 clone CLIP，复制已有 mask 列表后追加，不修改上游 CLIP。
- 第 k 张 Library 图片 mask 的 actual index = 输入 CLIP 已有数量 + k。
- actual 与 expected 不同，仅在本次执行汇总日志及节点可见 warning，继续追加；不改 prompt、不覆盖已有 mask、不新增偏移设置。
- 手动项可能与自动项重号但输入 CLIP 为空时，单凭实际追加数量无法识别这种用户语义冲突；这是用户明确接受的边界，不宣称 warning 能检测所有错配。
- 独立挂载节点是第一版确定采用的工程方案；PLV4 不新增 CLIP input/output，不复制 PC Schedule LoRAs。以后如需简化连线另考虑组合节点。

## 实时预览和动态输出的约定

- 不运行 workflow 的预览沿 bundle 输入连接找到上游 PLV4 当前 Document，调用只读资源预览接口；不会读取上次执行缓存作为当前编辑状态。
- 同时监听上游文档提交、库资产更新、连接变更、workflow 恢复、Undo/Redo；断开输入清空预览。没有可解析上游或正在编辑非法草稿时显示原因。
- 请求按最新状态合并，晚到响应以节点对象、graph epoch、连接身份和请求 token 检查后丢弃，不持续轮询 graph。
- 第一插槽为彩色 IMAGE，随后是按 bundle 顺序的 MASK。每个动态 slot 另保存 stable resource key；重排按 key 恢复连接。
- 原资源被删除/不再启用时，不把它的链接移给其他资源。为避免短暂关闭导致接线丢失，已接线但暂时不在 bundle 的项保留标为“未使用”的插槽并输出同尺寸零 MASK；未接线的旧项可移除。重新启用恢复原 key。
- 这意味着 bundle 还需描述 preview node 保留的输出契约：frontend 隐藏 widget 只存 slot key，不存运行遮罩真相；execute 依据 slot key 取 bundle mask，缺失项输出零并标记状态。不能仅靠前端 slot 数量改变 backend 返回长度。
- 同一 bundle 接到多个预览节点时，各节点可有自己的历史插槽，但 mask 身份和数据一致。
- 节点 DOM widget computeSize 只给固定最小尺寸，不读取 node.size 反写，避免既有高度反馈问题。绘图跟随节点尺寸，不新增每帧全图扫描。

## 文件与模块落点（计划）

| 模块 | 职责 |
|---|---|
| `prompt_library_v4/mask_library.py` | 画布存储、稳定 ID、版本写入、删除记录、input 路径管理 |
| `prompt_library_v4/mask_images.py` | 纯图片提取/栅格/预览计算、内容指纹，不依赖 ComfyUI 或 torch |
| `prompt_library_v4/mask_resources.py` | Document 引用解析、fallback、bundle 与 IMASK 映射 |
| `prompt_library_v4/mask_routes.py` | tree/mutate/resolve/preview 的异步 HTTP adapter |
| `prompt_library_v4/mask_nodes.py` | Preview 与 Attach 两个消费者，边界转换 torch |
| `compiler.py / node.py / setup.py / commands.py` | V4 adapter、追加 output、资源 setup、绑定/解除命令 |
| `js/plv4/mask_library.js` | 面板/独立窗口、图库预览、资源选择与更新通知 |
| `js/plv4/mask_editor.js` | 多矩形/单矩形共用编辑组件 |
| `js/plv4/mask_region.js` | Region 引用控件、自定义二级缩略图菜单 |
| `js/xyz_plv4_mask_preview.js` | 实时 preview 与动态插槽、链接按 key 保留 |
| `ui.js / window.js / details.js / plv4.js` | 入口、面板切换及 host/session 集成 |

只新增 mask 专属资源，不 fork PromptEditor、TagAC、语法或 PC 实现。图片提取优先复用既有 Krita 分色的纯函数，必要时抽出共享模块，保留原 Krita 输出排序契约。

## 分阶段完成条件

| 阶段 | 完成条件 |
|---|---|
| A：后端资源 | 临时 DB 下矩形 CRUD/version/tombstone 正确；图片 alpha、黑白、同色合并、面积/RGB 排序、容差可验证；路径只读且受控 |
| B：执行适配 | 已绑定矩形更新、删除 fallback；图片索引/去重/手动数值保持；prompt/bundle/metadata 同版本；资源缓存更新；旧无引用编译一致 |
| C：编辑界面 | Library/Masks icon 切换；真实鼠标新增/拖动/八方向 resize/排序/颜色；关联只读和打开所属画布；单矩形模式；图片选择/预览与解除 |
| D：节点消费者 | Square IMAGE/MASK 实际返回；无需执行的预览；稳定 slot 连接；CLIP clone 不污染上游；编号冲突 warning 后继续 |
| E：文档与验收 | 中英文用法、安装刷新说明、内部维护和实施状态更新；记录实际通过项目及未覆盖范围 |

关键场景采用临时目录、独立 DB 和 disposable 浏览器/ComfyUI；不使用持久 8190 或正式 input 的合成数据。只执行与本功能相关的定向检查，不扩跑全量 suite。测试不加载真实模型或采样，除非后续用户另行要求。

## 不在第一版范围内

- ComfyUI 原生图片绘画/遮罩编辑器接入，新建图片、覆盖和另存为。
- 多边形、画笔、批量/视频逐帧 masks。
- 自动修复手动 IMASK 编号、已有 CLIP masks 的替换或隐式偏移。
- 将 LoRA 调度或 CLIP 挂载合进 PLV4 节点。
- 自动复制外部图片进 workflow 或 metadata；跨机器携带文件需要显式资产导出能力。
- 启动正式 ComfyUI、修改个人工作流/Library、commit/push。

## 实施状态

- [x] 方案落盘。
- [x] 用户审阅方案（本次请求明确确认并授权实施）。
- [x] 资源/执行后端。
- [x] Library 与 Region 前端。
- [x] 节点预览与动态输出。
- [x] 隔离验证与文档。

实现使用独立 `masks.db` / shared WriteQueue，图片只读，文档以 `meta.mask_library` 携带关联及 fallback。现有纯语言及 Prompt Library Class/Pool 关系未改变。主窗口、独立库窗口及 Region 复用同一个矩形编辑组件；资源外部刷新不增加普通 Document Undo。

定向验证：临时 DB 的 t84（18 项）和节点兼容 t73（6 项）使用 ComfyUI Python / torch 通过；Node 插槽和会话检查 15 项通过。全新 disposable real-ComfyUI 真实键鼠覆盖绘制、八方向 resize、排序、画布 Undo/Redo、Region 绑定/解除、图片 Alpha、实时预览、已接线关闭保留、共享刷新与断开清空。两次无模型合成工作流实际输出 512×512 IMAGE/MASK，未使用槽为零；已有 CLIP masks 的编号 warning 后继续，输入 CLIP 保持原状。最终浏览器数量及补充检查见 DEVELOPMENT。

矩形栅格采用共享 compiler 的数值表示，再按 PC 的整数像素边界量化；不把 feather/conditioning 权重画进几何预览。图片 preview color 与 exact RGB key 分离。窗口异步请求、graph epoch、连接及节点对象守卫拒绝迟到响应；历史已连线 slot key 由隐藏 widget 保存，后端按 key 返回同尺寸零 mask。

未扩跑全量 suite，未加载模型/采样，未验证 OS 原生颜色选择器、系统触摸输入或所有 Nodes 2.0/Subgraph 链。只改源码和文档，未创建正式 masks.db、改个人数据、操作正式 ComfyUI 或持久 8190；未 commit/push。后端/节点需要用户之后自行重启 ComfyUI，前端 Ctrl+F5。


## 2026-10-13 用户新增：Region 容器功能开关

Region 组 Block 的 Settings → Region entries 顶部提供 Region 开关，默认开启。关闭只忽略本容器各 entry 的 Region 参数，将启用 entry 内容按顺序放进 prompt；普通权重/Schedule/随机/LoRA 保留，其他 Region 组不受影响。容器和 Region entry 架构不变，仍不能直接写 prompt 或容纳普通 Block，entry 各自 Enable 和参数/库引用都保留。整个 Block 的 Enable 仍是独立开关。关闭的容器不向 mask_bundle 挂载资源，编译不读取其图片；旧连线保留 Unused 零遮罩输出。重新开启按当前库内容刷新引用。开关使用 Document 的 meta.region_enabled=false（缺省开启），随 workflow/保存 Block/metadata 保留，Source 继续保留 Region 结构；只有 Source 的拷贝不包含此开关。共享 parser/语法不新增标记，纯编译器仅接收 V4 明确提供的容器 AST paths。
