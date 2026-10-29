# PLv4 内部维护说明

阶段收束：Folder 池阶段 **2026-10-08**；LoRA / AVG / 原生输入和菜单后续 **2026-10-10**。此前收尾已发布；**2026-10-11** 用户新增 Folder/Class 分离需求，当前实现及验证见下节。**2026-10-12** 用户验收两批 PLv3 导入并授权替换正式 Library，已安装新的 Class 结构数据，详见下节；未重新发布代码或启动正式 ComfyUI。本文件描述当前实现。

## 文档入口与优先级

### 2026-10-29：本地累积改动发布

- 用户授权将当前本地改动提交并推送 GitHub：包含 MOSS 输出与扩写节点、Blocks 输入和提交性能、重复空 Block 身份、LoRA 子目录路径及 Pool 追加换行修复。下方历史条目的「未提交 / 无 commit/push」指各轮实施当时状态。
- 本次发布前定向 Python（t70/t74/t83/t87/t59/t60/t47/t48/t49）**406 passed**；DocumentSession 与 asset routing 两个 Node 文件 **14 passed**。沿用各功能条目记录的浏览器验证范围，不将其当作本次重新执行的验收。
- 不发布个人数据库、workflow、HANDOFF 或临时资产，不重启正式 ComfyUI / 持久 8190；更新生效需重启 ComfyUI 后 Ctrl+F5。

### 2026-10-28：Class Pool 添加 prompt 偶发多出换行

- `EnableCandidate` 追加 prompt 时，原末项的 sep 仍含闭括号排版换行；句号项无需自动补逗号、已有逗号项也不改 sep，因此该换行进入两个 prompt 之间，在 Blocks 中成为可见换行。纯词尾的自动补逗号路径恰好覆盖空白，故表现为偶发；候选快照本身不含换行。
- `commands._append_pool_prompt` 只在已排版 Block 的 prompt 末尾追加时，把最后一条闭括号布局换行移给新末项，其余用户换行原位保留，并显式补齐旧末项分隔。`EnableCandidate` 与 Pool 内容合并复用；不重排其他 Block，不改变关闭项/ID/绑定。尾部匹配使用 `\Z`，不能用会匹配最终换行之前的 `$`。
- 回归先复现失败再修复；t70/t74/t83 **192 passed**，覆盖句号/逗号/普通末项、用户换行、连续添加/序列化、权重、两类内容合并、关闭末项和无关源码。独立临时 Library + Chrome **31 项真实鼠标/DOM 检查**通过，包含 Pool 加入、Source/Blocks 往返、Undo/Redo，errors=[]。不是完整 ComfyUI 工作流或模型执行验收；临时脚本 `%TEMP%/xyz-pool-newline-check.cjs`。未改个人数据/正式服务/持久8190，无 commit/push；需重启 ComfyUI 后 Ctrl+F5。

### 2026-10-27：Blocks 提交卡顿与相同空 AVG entry 串写

- Chrome 156 / CDP 在独立真实 CPU ComfyUI（8197）复现：新建 AVG 后向第一个空 entry 输入，再点击第二个，两个位置都显示同文。共享 reconcile 的相同源码优先匹配把未编辑的第二项匹配到第一项 ID，编辑项获得另一个 ID；缓存中的旧输入 DOM 随该 ID 一起搬移。普通相同空 Block / 多层相同祖先也有同一风险。
- Native RunSession 的所有空输入都携带 `insert_anchor.parent_id`。V4 在核对 parent body 以外源码不变后，为 reconcile 提供 enabled-child ordinal path，固定 owner 及祖先身份；owner 内仍用原 matching / parked 规则。共享 Source / V3 不传 path，默认行为不变；不修改 AST 缓存。t70 新增 AVG、普通与多层相同空 Block 的三项回归，关闭 path 的进程内对照全部失败，修复后通过。
- `BlockView.closeEditor` 只使已编辑 body 及祖先的 cache key 失效，不再 clear 整页。框架 / header / body 分别复用；正文未变时保留 native field，子项变化只在原父框架里对齐 DOM。折叠摘要仍随内容刷新。工作流副本节点 861 的同一路径，提交后整页重绘约 73ms → 约 6ms；这是隔离页面的一次对照，不是所有工作流/整机响应保证。打开窗口后 idle 预热共享 `NativeEditorInput`，仍复用 Monaco 的输入、配对和权重操作。
- Settings 的非 opaque / 非 paren Block 普通 header 设置与 AVG weight / Schedule boundary / Region switch 走 stateless Document，不占 Library writer；原子 prompt / attention 权重、内容、类型与 pool 绑定仍走原收录路径。来源版本按 Library revision 和 IDs 共用请求，库事件清理缓存。只改 owner header 时，Details 保持未变的 Content / Pool 原 DOM；内容、enabled、模式、绑定或 Library revision 改变时重建。实际权重点击确认只有一次 Document command、无 Library mutate / 重复 versions read，保留的 Content 批量按钮仍更新当前文档。
- 验证：t70 / t59 / t60 / t81 定向 **203 passed / 1 deselected**；被排除的既有 t81 节点测试仍硬编码 V4 只有两个输出（现有实现为四个），与本修复无关。Session / 新增 asset routing 两个 Node 文件 **14 passed**。独立真实 Chrome **20 专项键鼠检查 + 原有 16 Content checks**，errors=[]，覆盖 AVG 三种 blur 目的地、独立续写、Undo/Redo/Source 往返、重复 Ctrl+↑/↓ 不逐键提交、关闭项/空行、新建自动聚焦、Content/Pool/正文 DOM 身份、折叠摘要、实际 More click 与 hover submenu。另试跑的旧 inline suite 有缺 `draftCompletions` 等桩依赖和旧 suggestion 断言；旧 drag suite 有 Region/Schedule 菜单顺序断言，未为这些既有桩修改产品。四个生产 ESM、三个 Python AST 与定向 diff 检查通过。
- 工作流 `My_workflow/anima_workflow_3.json` 只读加载到 scratch；Library 用 SQLite readonly backup 副本，无模型执行。浏览器扩展未连接、用户 Chrome 未开放 9222，使用独立 Chrome；未停止用户 Chrome、正式服务或持久 8190，未写个人 workflow / DB，无 commit/push。临时脚本、CPU profiles、截图与日志在 `%TEMP%/xyz-oct27-*`；临时服务和独立 Chrome 于结束时关闭。**本轮需重启正式 ComfyUI，再 Ctrl+F5，不能仅刷新来加载后端身份修复。**

### 2026-10-23：Content / Subclass 功能发布

- 用户随后授权更新 GitHub 和 README。本次提交仅含 Content 批量启停、Pool Subclass 两种插入及对应中英文说明；根 README 移除已退役的 V3 独立 Editor / Library 菜单入口描述。此前实施条目中的「无 commit/push」指当时状态。
- 从已发布 HEAD b204244 独立检出并提取本轮改动，发布版本通过 t70/t74/t83 **175 passed**、独立临时 Library + Chrome **46 真实鼠标检查**（Content 34、Subclass 12），errors=[]；ESM / Python 语法、定向 diff 检查通过。未依赖本地待发布的 MOSS、性能、LoRA 等其他改动，这些改动保留本地；不包含个人数据库、workflow 或测试资产。更新后重启 ComfyUI + Ctrl+F5。

### 2026-10-23：Pool Subclass 两种插入

- 用户明确包含全部后代 Subclass 的 tag。Subclass 行提供「＋内容 / ＋子 block」；`class_block {fill:true,recursive:true}` 只递归散装 tag，兄弟重复去重，不读候选 Block；未传 recursive 的其他 Class 插入入口保持原本本层读取规则。
- `MergeClassTags` 复用 `MergeLibraryBlock` 的 `_merge_pool_block`，保留当前绑定，已有 prompt（含关闭项）不重新启用 / 排序；未绑定后代参与查重，自有绑定的子 Block 保留既有边界。全重复时原快照不变，不多记 Undo。subblock 插入继续走 InsertLibraryBlock，绑定所选 Subclass，内容默认启用。Details 两个入口共用 poolPending 串行及 session / 当前 owner 守卫。两个悬停按钮放入同一个 flex 工具条，避免旧 absolute-right 样式把两者叠在一起。
- 验证：t70/t74/t83 **175 passed**；独立临时 Library fixture + 独立 Chrome **12 真实鼠标 checks**，覆盖两入口、整树 tag、候选 Block 排除、关闭项/绑定保留、重复 no-op、单步 Undo/Redo，errors=[]。直接检查默认本层读取和 recursive 兄弟去重通过；ESM/Python 语法及定向 diff 检查通过。未操作正式 / 持久 8190 / 个人数据，无 commit/push。临时脚本 `%TEMP%/xyz-subclass-pool-check.cjs`；需重启 ComfyUI + Ctrl+F5。

### 2026-10-23：Settings Content 批量启停

- Content 顶部增加 Disable all / Enable all；`SetContentEnabled` 单条原子命令递归改变当前 Block 的全部后代 enabled，保留当前 Block、自身以外的兄弟、稳定 ID、内容和顺序，排除固定 LoRA invocation / MOSS settings。当前 Block 或祖先关闭时拒绝；裸特殊 entry 沿用 `_explicit` 补括号以保证空正文可解析。
- 复用窗口 flush / FIFO、Session 历史及 Details pointer guard，一次批量操作一个撤销步骤；走 stateless Document，不收集 Pool、不占 Library writer。按钮提交中禁用，空 Content 不可用。
- 验证：t70 **142 passed**；临时独立 LoRA fixture + 独立 Chrome **34 真实鼠标 checks**（nested/root/Schedule/Region/AVG、一次 Undo/Redo、ID/空行、正文失焦后单击、空列表），errors=[]；另直接 API 检查固定 LoRA、范围、boolean、关闭祖先和裸 entry。生产 ESM 语法及定向 diff 检查通过。非完整 ComfyUI / 模型执行验证；未操作个人库、正式实例或持久 8190，无 commit/push。临时脚本 `%TEMP%/xyz-content-batch-check.cjs`；需重启 ComfyUI + Ctrl+F5。

### 2026-10-21：恢复被 Git reset 撤掉的 LoRA 子目录路径修复

- 用户报告近期 PLV4 LoRA 不生效，并指出 Claude 之前已修复。核对历史会话与真实 Git 对象：2026-10-18 的 `fe86f79` 已在共享 IR 的 `native_lora` / Lora render 分支修正 Windows 路径，且提交了 `t80::test_lora_folder_separators_follow_this_machine`。reflog 记录 2026-10-19 17:45:35 -0400 reset 到 `b204244`，这两处在当前工作区均缺失。reflog 能证实回退，不能据此断言是谁或为何执行。不是 prompt-control 新改了格式，也不是本轮 Blocks 性能改动删除了路径处理。
- 原样恢复该提交的两处实现及既有回归测试，保留当前 IR 的 MOSS 排除分支和其他未提交改动；没有整体 cherry-pick / reset / 自动迁移个人数据。Document / Source 仍存 `/`，仅编译出的 LoRA 名称按 `os.sep` 输出，供 PC 与本机 `folder_paths.get_filename_list` 精确匹配。恢复前，真实 PC resolver + 8188 文件列表对 `anima/clothing/Anima_Harem_Outfit.safetensors` 返回 None；反斜杠全路径和无扩展名 basename 均找到真实文件。
- 只读检查近期 history / PNG metadata：00:52:16 成功图的所有 PLV4 LoRA Block 均关闭且外部 Loader 无 active；后续三次启用 Anima_Harem_Outfit（model=.5 / clip=1）的尝试均在 KSampler 被中断，但编译调用确实因路径未匹配而被 PC 丢弃。01:00:04 成功图的 PLV4 LoRA 仍全关闭，改由外部 LoRA Manager 以 1 / 1 加载该 LoRA。metadata 记录调用不等于模型实际应用。
- 验证：恢复的 t80 路径回归先失败（native_lora 不存在），恢复后通过；t80 共 **30 passed / 1 既有失败**。既有失败为 invalid draft 的 IS_CHANGED 返回 NaN 而旧测试要求 hash 长度；进程内将 native_lora 置为 identity、关闭本修复后仍同样失败，未为此扩改缓存。ComfyUI Python / CPU 下用三次真实 API 提交文档，经过 V4 compile → 当前安装 PC parser → consolidate_schedule → PCLazyLoraLoader.execute 的 **17 项断言通过**，确认生成真实文件路径的 LoraLoader 图、输入链与 .5 / 1 权重，并确认关闭项不输出 LoRA。不加载实际权重、不采样，不声称已验收修后画面。Python AST / 定向 diff 检查通过。
- **需重启正式 ComfyUI 才能载入恢复的后端实现，Ctrl+F5 不能替代重启。** 未重启/停止正式实例、未提交队列、未改个人 workflow / DB、无 commit/push。证据与只读快照在 TEMP `xyz-lora-diagnosis-61_qg691`；本轮未启动持久测试服务。

### 2026-10-21：Blocks 大段粘贴 / 全选删除响应

- 约 3,080 字符的森林场景正文在真实隔离 ComfyUI Monaco 节点中，全选删除原耗时约 330–430ms；Chromium 逐一删除 prompt span / 拖放 decoration，触发约 148 次布局和 220 次样式计算，后端失焦提交并非主要瓶颈。局部 CSS containment 无明显改善，单一原生文本节点对照约 24ms。
- `block_view.js`：超过 16 个有效叶子的 TextRun 合并连续启用正文为原生文本节点，仅关闭项保留 parked span。显示 / Source offsets 继续复用 `displayRun`；点击和右键按源映射定位 prompt，缓存 card 前序正文长度变化时以当前 projection 校正偏移。CSS Custom Highlight 保留选中反馈（低于 Find 的优先级）；拖放按字符位置解析同一 before/after 命令，以独立 caret marker 显示插入点。未改变 Document、解析器、顺序、关闭项、历史或原生 Backspace / Delete / Enter 行为；无 Highlight API 时保留原渲染。
- `design_components.js` 删除 plaintext-only 上多余的 paste → execCommand(insertText) 转发：原一次多段粘贴触发 16 个 input，现浏览器原生一次 input，保留准确段落与尾部空行。`typeInline` 合并同一轮等待 ready 的草稿持久化。
- 同场景关闭项验收发现 Blocks 草稿回写共享 Monaco 被当作第二份 Source 草稿，重复 ReplaceText，Undo 先撤掉无效重复提交。`NodeSessions.bind` 给 binding 传入现有 writing guard；宿主同步只更新 observed，不建立 Source 草稿，真正 Source 输入仍按原历史提交。不要仅用 text===session.text 判草稿来源：原生 run 输入与 reconcile 后 parked 分隔空白可能不同。
- 定向验证：独立 CPU ComfyUI（8197）+ 独立 Chrome、Monaco 节点 / Nodes 1.0，25 项真实剪贴板 / 键鼠检查通过，覆盖逐项选中与高亮、右键、实际拖放、缓存偏移、Source 输入 / 往返 / Undo、关闭项批量删除与单步 Undo、尾部空行和原生 Backspace；errors=[]。原有 Content click 16 项通过；Session Node suite 13 项通过。六个改动 ESM 语法与定向 diff 检查通过。额外旧 menu suite 在修前 / 修后均因预期 Schedule 在 Region 前的顺序断言失败（实际 submenu 已正确打开，现有 insertForms 顺序为 Region / Schedule / AVG），未改其测试或产品菜单以迎合旧断言。
- 最终版本三轮相同正文：删除键鼠往返 32 / 32 / 46ms；原生粘贴 74–96ms（自动化另含固定 50ms 等待），每次只有一个 input / persist；粘贴失焦提交 58–72ms。以上是该隔离页面的操作耗时，非帧率或所有工作流的保证。
- 仅前端，Ctrl+F5 生效，不需重启后端。正式进程、个人 Library / workflow、持久 8190 未操作，无 commit/push。临时观察脚本 / profile / fixture 在 TEMP `xyz-bulk-input-zkrjfmzk`，不放入正式安装或个人库。自有 CPU fixture PID8504 / port8197 和轻量 fixture PID34204 已按完整命令行核对关闭，独立 Chrome 均由脚本 finally 关闭。

### 2026-10-19：MOSS 输出模式与逐区域扩写

同一 V4 节点 General Settings 新增 Output mode / Sentence case；MOSS 复用矩形 Region，支持 character / object / text 和独立 literal text。可选 width / height 直接输入，仅执行实际矩形时缺项报错；没有有效矩形时输出 simple prompt，无需宽高，有矩形时输出原生 Layout JSON。编译走独立 `moss.py`，不经 COUPLE / AND、无 ambient 注入；共享语言 AST 只读，复制后求值。随机复用 `_randomise`，V4 忽略 group seed。`output_policy.py` 同步 projection / resource resolve / 编译排除规则，MOSS 不读取被排除的 IMASK 图片资源。

同日修复用户实报 Preview 已接宽高仍报错及空 Monaco 执行要求尺寸：`host_sessions.inputs` 不再因后端尺寸 link 数组中断，保留未连接 seed/mode widget；Session compile 显式 preview=true，后端默认仍是执行严格模式。先完成随机选择，再对实际 items 做坐标换算 / 尺寸校验；Preview 缺宽高返回 normalized yxyx（旧像素 / 混合空间明确单位）+ preview_notice / preview_only，不产出 metadata。零 items 的空 / 纯文本 / 区域关闭 / 排除输出无需尺寸；version1 metadata 对无 items 快照允许缺尺寸，区域快照仍必须有画布。不要重新在 compiler 入口无条件校验尺寸。

Mask Library `mask_editor.js`：选中矩形在局部绘制序列最后画，命中先判断选中矩形内部 / handles，再查其他矩形；不改变 canvas.masks 数据顺序 / stable ID / 输出映射。仅显式拖动列表 handle 才排序。

上述修正验证：t87 78 项、同组 Python 合计 273 passed / 1 torch skip；Session 13 和 Window 预览定向 2 passed。全量 Window suite 六项现有桩依赖缺失（window / maskBindings / folderNameControl / containerForms），未扩改生产代码以迎合桩。真实 Nodes 1.0 浏览器 34 检查通过，覆盖实际后端尺寸连线的比例预览、注入已知数值的最终坐标显示、重叠矩形真实鼠标选中 / 移动 / resize 及持久顺序；已知数值路径不是 Primitive 集成验收。真实队列三例：空 / 普通 MOSS Monaco 无尺寸执行成功、后端 Resolution 连接输出最终像素 Layout 成功。临时 fixture 与截图仍在 TEMP xyz-moss-comfy-athshjwb，无模型推理或正式数据写入。

输出设置保存在 Document root meta，SetMetadata 和历史共用；加载 Library 文档先保留当前节点设置再重建 projection。旧 workflow 的 width / height 在 onConfigure 追加，绝不能重排旧输入和四个输出。旧模式默认值与编译结果保持；region_mode 继续只存 couple / mask，不能用 moss 重解释它。MOSS 的类型 / literal / upsample 位于区域 meta.moss；部分字段命令必须合并，不能在正文 blur 与 checkbox 连续提交时覆盖 type。原文分隔规则已支持逗号 / 保留句号，本次不改 lexer。

新增 XYZ PLV4 MOSS Upsample，输入 metadata + 原有 CLIP，逐 caption 调原生 TextGenerate；临时控制经 metadata 旁路，不污染最终 JSON。输出新 metadata 必须沿保存链传给 Image Metadata，否则记录的是扩写前提示词。缓存以模型 patch UUID / 身份和稳定区域 ID、内容、seed、生成配置区分，有界且不强持模型；未选区域、bbox、type、literal 不交给模型改写。普通权重需显式 NegPip weights + 外接节点；LoRA strength 在 MOSS UI 禁用，外部 Loader 才负责实际加载。

同日用户明确扩写应对标 TextGenerate：现已补齐全部原生生成控制（含采样开关、所有 sampling 参数、thinking、template、MTP、自定义 system_prompt、可选 image/video/audio）。继续 V1 INPUT_TYPES 平铺以兼容 Nodes 1.0，不复制原生推理实现。prompt 为普通文本 / Layout，metadata 改 optional；metadata 单独输入时 prompt 留空，两者有值必须匹配。未连接 metadata 默认处理所有 caption；连接时遵守原开关，输出更新快照。第四槽追加 thinking（Layout 按稳定 ID 的 JSON）。普通文本 / summary 保留原 seed，区域派生；缓存包含全部参数与推理，多模态禁缓存；prompt dynamicPrompts=False 保护 JSON。max_length 与原生一致 1–32768，按每个 caption 计算。后续验证 260 passed / 1 torch skip、JS 13、一次性真实 Nodes 1.0 浏览器 23 检查；新增两次真实队列调用实际 TextGenerate + 合成 CLIP 成功，另 ComfyUI Python 原生 on/off / MTP / 模板 / reasoning 验证通过。未进行真实权重推理。

验证与边界：定向 Python 241 passed / 1 torch skip（ComfyUI Python 补跑 1 passed），Session Node 13 passed；一次性真实 CPU ComfyUI + 独立 Chrome、明确 Nodes 1.0，共 19 真实键鼠检查，errors=[]，两次无模型节点执行 success。额外 t82 两项桩失败已在 HEAD TEMP baseline 原样复现（folder_paths.get_input_directory、mask_nodes package）。变更 Python / ESM 语法检查通过。未用真实 Qwen 权重扩写、未采样 MOSS，不宣称验证生成质量。细节与用法见 `../plv4_moss_plan.md` / README；fixture TEMP `xyz-moss-comfy-athshjwb`。个人库、原 workflow、正式 / 持久 8190 未改，无 commit/push；生效需重启正式 ComfyUI + Ctrl+F5。

### 2026-10-14：Blocks 开关响应（假草稿 / 后端深拷贝与重复解析 / 整页重挂）

- 现象：Settings 里 enable 一个 prompt 很快，随后 disable 明显变慢。实际与方向无关，是“上一次命令之后的下一次命令”慢。宿主把每次提交写回节点 `text` widget，节点内嵌 Monaco 与窗口共用同一 model，这次写入在 binding 的 `sync()` 之外，被当成用户输入记成一份与文档完全相同的草稿；下一条命令前 `flushEditor` 先提交它：`ReplaceText` + `sync_pool` 两次往返和两次 Blocks/Details 整页重绘。修复：`prompt_editor_binding.js` 中，内容等于 `session.text` 且无未提交草稿时不算草稿（同时不再无谓设置 `context.raw`，后者会跳过 mask 刷新）。
- 后端：`projection` 对每个节点 `render(full_document(Document(node)))`，即每个节点深拷贝一次子树；一条命令还会把同一文本严格解析 8 次。新增共享 `render_all(node, memo)`（按全部启用渲染，无拷贝；projection 内同一 memo），`model.strict_parse` 按源文本缓存严格 AST（上限 32、加锁、错误不缓存），`full_index`、`check()`、`refresh_document`（改用 `from_ast` 复用同一 AST）共享。约定：AST 消费方只读，需要修改先复制。用 anima_workflow_3 节点 861 文档对比，命令响应 JSON 修改前后逐字节一致。
- 前端：`BlockView.render` 原先 `replaceChildren()` 后重挂全部卡片，约 600 个节点在 1 万余条 CSS 规则下整体重新计算样式和布局，结束处读取 `scrollTop` 强制同步布局 60–140ms。改为收集新的顶层节点后 `place()` 就地对齐：未变化的缓存卡片保持挂载，只插入/移动/删除变化部分。注意 `place()` 必须先跳过并删除不在新列表中的旧节点，否则每个新分隔节点会把其后所有卡片“移动”一次（初版即如此，599 个节点照样全挂）。
- 结果（隔离 8191 fixture，个人 Library 只读 backup 副本 + 节点 861 文档，Details 真实鼠标点击 10 个 block）：Blocks 显示变化 约 430ms → 约 85ms，开关方向一致；后端单条命令 约 26ms → 约 11ms（合成 15×20 文档 约 70 → 25ms）；每次重挂节点 599 → 约 180（只剩开关所在 block）。
- 验证：`test/js/plv4_session_test.mjs` 修复过时的 import 替换（binding 新增 `text_draft.js` import 后重复声明，整条用例从未运行）与“改动即提交”的旧假设，加入外部回写不产生草稿的回归，11/11；回退修复时该回归失败。PLv4 Python 398 passed，8 个失败与改动前一致（既有）；其余 JS suite 前后一致；mixed 23、Content click 16、menu 25 真实浏览器检查前后均通过（inline 检查缺 playwright，前后均未运行）。正式服务/8188/个人数据未改；需重启正式 ComfyUI 并 Ctrl+F5。

### 2026-10-13：关闭子 Block 前输入跳位 / 启用与删除响应

- anima_workflow_3 节点 861 的 i173，i305 关闭时，2girls 后新 prompt 在 blur 后越过该子 Block。真实文档副本精确复现：`i174(off), i175(2girls), i305(off), newprompt, i475`。共享 reconcile 按旧数字 index 恢复 parked block，已有 TextRun 却没有结构 anchor。
- Native RunSession 的 ReplaceText 给整个 TextRun 带 `insert_anchor.run_ids` + before_id/edge；后端把此 run 的旧/新增 prompt 和原有关闭项一起放回实际结构间隙，保留内部顺序。不能只移动新 ID，否则多 prompt run 的旧 tag 同样可能越过关闭 Block。提交后刷新 run_ids 支持再次 flush/续写。共享 Source/V3 reconcile 不改。
- SetEnabled/Delete 不新增 pool tag 身份，观察记录原本也不会删除，现走纯 Document，不占 Library single-writer；blur 的必要收集及手删 tag 不补回仍保留。Node/Library 按绑定、effective、Region 功能开关/参数及资源顺序的 signature 判断 Mask resolve；无关正文/开关/删除不刷新。库事件仍强制刷新，raw draft 期间标记 maskDirty，blur 后补处理。masks/resolve 仅返回 state/projection/metadata，省去 PNG 预览和二次 from_json；preview 图片接口不变。
- Header enable 即时更新 aria-pressed/灰显，处理中屏蔽重复提交与正文操作；按 context 保存 pending state，重绘期间不闪回，失败恢复当前权威状态。Settings Delete 即时隐藏 row/extra，失败恢复。Window command FIFO 的默认 revision 在执行时计算，显式 guard 保留；flushEditor/导航/history/执行等待已接受命令，命令内部 flush 不等自身。
- 隔离 Chrome + 真实文档/个人 Library 与 Masks 只读 backup 副本：**12 个**位置/一次 blur/Undo-Redo/重开/慢请求反馈/兄弟连续点击/拒绝恢复检查，**6 个**Mask event 延后/真实资源 subtree 开关/resolve-preview 一致/手删 pool tag 不补回检查，另 enabled subblock 情况通过。600ms 人工提交延迟下真正鼠标 click 后 UI attribute/hidden 改变约 **0–0.2ms**，只是反馈时延，不是后端总耗时或 FPS。后端两个直接检查覆盖多 prompt run 中间插入、关闭 Block 后尾段插入。最后无意外 errors；拒绝用例的 console 日志是刻意注入。
- 同场景修前 Header/Delete 文档更新约 61/75ms，随后还有 95–96ms Mask resolve；修后各约 62ms，仅有一个 stateless command，无 Library mutate / Mask resolve。没有声称后端计算显著提速。观察脚本先修正底部窗口边缘截住按钮的坐标、删除 API version，并以新 Document 清除用例残留的 parked nodes；未据脚本状态误改生产行为。
- 5 ESM / 2 Python 语法与定向 diff 检查通过，未新增 repo 测试文件或扩跑 suite。TEMP 脚本 `xyz-response-{baseline,check,resources}.cjs`；前/后副本根 `xyz-block-stall-gy3po8or` / `xyz-block-stall-bgfa8glk`。保留另一对话的 General Settings / 区域算法文档修改。原 workflow/个人库未写，正式/8190未重启，无 commit/push。后端 run anchor 与 resolve 改动需重启 ComfyUI，前端 Ctrl+F5。
- 本轮独立 Chrome session 与自有 fixture Python（PID 29548 / 20208，已核对完整命令行）均已关闭；观察材料保留，未操作其他进程。

### 2026-10-13：Region × Schedule 语义统一、空 base 修复、Region 容器四滑块

用户决定（逐条拍板）：schedule 在 region 本身或外层 → 决定 region 存不存在（窗外无区域语法，Base/Fill 同样）；在 region 内部子 block → 只限时内容；Region 容器一条滑条四个滑块，按排序取角色（外=schedule，内=`region_window`，内外之间变 plain）；无 base/fill 文字时空隙由共同文字画；含不含 AVG 同一语义。
- 共享编译器 `prompt_shared/language`：只要有 region 随时间出现/消失（`ir.region_timing`），就走 AVG 已有的按时间切片路径；`plain_regions_for` 让窗外的 region 条目按普通组渲染（不再改写 AST）。切片内 W05 不再误报（全树 pass 报真的），W11 不再比较 schedule（各片各自处理），诊断去重。随机：切片里遇到全树 pass 没见过的 (组, 段) 组合时复用该组任一处的抽取（`("any", id)`）。
- 空 base：prompt-control 把第一个 `COUPLE` 前的文字当 base，空也算，且全图；mask 按像素归一化 → 每个 region 被空提示词平分一半。现在无 base/fill 文字时加合成 fill（`Segment.synthetic`，不进 `CompileResult.segments`）：COUPLE 输出 `FILL() 共同文字`；AND 依 ComfyUI `_calc_cond_batch` 空隙正面预测为 0、CFG 后为 `uncond*(1-cfg)`，故加"全图减各 region"块，除非纯分数矩形可证明铺满（`mask._covers_image`）。
- `region_window`：parser 字段 + `Group.region_block`；非 `[@region]` 上 W08 并忽略。PLv4 `SetSettings` 只允许在 Region 容器上写它。前端 `details.js regionTiming`。
- 旧测试按新语义更新（t48/t49/t51/t53/t80/t84），新增 t48 若干与 `t86_plv4_region_timing_test.py`。全量 pytest 剩 19 个失败均为既有、与本改动无关（节点多返回两项、JS 测试桩缺 window/draftCompletions/DetailsPreferences、loader 命名空间）。`plv4_details_test.mjs` 本身因缺 `DetailsPreferences` 桩已坏，仅补了 `fmt` 桩；四滑块用临时 harness 5 项通过。未在真实浏览器中拖过四滑块。
- **出图验证（同日，隔离实例 8199：只加载 prompt-control + Anima-2.9B，不加载本包，anima29B_v10_int8，512²/10 步/euler/cfg4，同 seed，左红右蓝）**：10 种情况 + region_window 4 种 + 对照，COUPLE/AND 共 40 余张全部成功。空 base 旧输出右边蓝色整个丢失、新输出正确；AND 空隙旧输出出现噪点条（证实空隙预测为 0）。w1/w3 证明切片时间对：前 40% 有分区即按分区、无分区即同无 region 对照。0.15 边界的 case 7 证明后续阶段内容进入 region 离开的区域。
- **出图时发现 prompt-control 的参数坑**：`MASK(x, y, w, subtract)` 的参数按逗号切开但不 strip，op 以 `" subtract"` 传给 `MaskComposite`，按相等比较全不中 → 原样返回全图 mask（日志 `op= subtract` 多一个空格）。所以 AND 模式下合成的 fill（含用户写的 Fill，**这是既有 bug**）一直是全图、稀释所有区域。`compile/common._op` 改为逗号后不加空格（`MASK(0 0.4, 0 1, 1,subtract)`），探针确认 mask 只剩中间条。可考虑报上游。

### 2026-10-13：区域算法讨论归档，等待另一对话修 bug

用户指定先完成节点统一的 COUPLE／AND 切换，再尝试 Sen-sou Anima 注意力遮罩；随后要求暂停实现，先归档讨论，等另一对话修完 bug 再继续。完整记录在 [`../plv4_regional_algorithms_plan.md`](../plv4_regional_algorithms_plan.md)，包含已确定 UI／现有验证、六类算法区别、来源参数、`base_ratio=0` 的默认建议、未选定的编码／MODEL hook 接口及恢复前检查点。General Settings 的两个选项已实现；第三种模式、MODEL patch 和实际采样尚未实现。此前“新增算法范围待讨论”条目的状态以本节及新文档为准。本次仅文档更新，不继续改算法代码，不操作运行实例／个人数据或提交推送。

### 2026-10-13：节点 General Settings 入口（新增算法范围待讨论）

- 中间栏 header 的 ⚙ 打开右侧 General Settings；原 toolbar Region select 移入 Region algorithm，显示 Attention Couple (COUPLE) / Latent Mask (AND)，继续写既有 region_mode widget，保留旧 workflow 值与上游连接只读策略。仅界面调整，不新增算法、自定义语法、执行计划或 MODEL patch。
- General 页状态按当前 node context 保留，Block 定位（含已选中同一 Block）返回对象 Settings；Library 页面隐藏齿轮。pointerdown 保留正文焦点，click 后先 flushEditor 再切页，避免 blur 重绘吞掉点击或丢正文；General 页复用 select，不随正文异步刷新删除聚焦控件，旧 Pool mount 由 token 隔离。
- 隔离 LoRA fixture（临时 Library、合成节点）＋独立 headless Chrome：真实鼠标齿轮／原生 select 键盘、编译 Preview、正文提交、Block 定位、节点切换、关闭重开、上游只读、Library 来回和下拉可见宽度 **17 checks passed**，errors=[]。不是实际模型采样或完整 ComfyUI workflow 验证。既有 window suite 首次运行有 3 个 mock 失败（NodeSessions 的 window 缺失两项、renderTabs fixture 缺 folderNameControl），失败所在代码本轮未改；本轮相关 history/settings 4 项定向通过。三份 ESM 和 diff 检查通过；未新增测试文件或扩跑全量。
- 原调研“六类”已从用户明确引用的本机聊天记录核对：PC Mask、attention 输出混合、分数遮罩/偏置、Dense 分数重标定、逐区域采样、RAG。后两类改变采样过程，不承诺仅 MODEL patch 可支持。用户正在询问流程与难度，新增后端范围尚未确定。
- 仅前端 Ctrl+F5 生效；保留其他修改，不操作个人数据／正式实例／持久8190，不 commit/push。临时观察脚本及截图在 C:/Users/XYZ/AppData/Local/Temp/xyz-general-settings-check.cjs 和 xyz-general-settings.png。

### 2026-10-13：恢复正文失焦后一次同步，补全与关闭不等待逐字提交

- 用户重申原有规则：Blocks / Source 输入期间只保留草稿，点击其他位置失焦后才一次同步到 Settings Content。旧 `BlockView.typeInline` / `bindPromptEditor` 每次 input 都发 ReplaceText，慢请求下 Content 逐字追赶；native Source/Pool suggestions 又等编辑队列，窗口 hide 等 detach/flush，三个症状共用此等待链。正式 stateless 请求只读检查能返回（节点 861 open 约 50–68ms、command 52–87ms、Mask resolve 173–195ms），没有据此断言整个正式进程死锁。
- Blocks 原生正文、IME/paste 和 Source/共享 Monaco model 保留本地完整草稿，workflow widget 同步 raw draft 供保存；输入期间不改 session Document / Settings / history。blur、切视图/节点、结构操作、关闭或执行显式 flush 才提交。普通 TagAC 与 native grammar suggestions 读取草稿，不等正文保存队列。Ctrl+↑/↓ 与普通文本动作借用共享 Monaco / PromptEditor 在 native draft 上操作，不为映射选区提前提交。
- `text_draft.js` 随后续文本修改平移/退休 Library 补全的 UTF-16 spans；ReplaceText 兼容原来的单一 completion，并支持同一次草稿内的 completion list，来源与 snapshot 在同一历史步附上。Source binding 提供显式 flush、共享 model 单一监听、blur/history/执行入口，Blocks Find replacement 与结构动作显式提交隐藏模型。输入期间到达的 Mask resolve 不覆盖 node raw draft；失败的原生提交保留草稿供重试。
- 关闭按钮先隐藏窗口，后台 drain/保存完整草稿；不会丢弃队列或中断保存。实际鼠标 Close 在人为 2s 保存延迟下即时隐藏，随后唯一 ReplaceText 保留 closexyz。
- **定向验证**：临时 standalone LoRA fixture / 真实 Document 与 Library routes + 独立 Chrome，共 13 个延迟输入/补全/blur/无效 Source/Undo/关闭检查；只读 backup 的个人 Library / Masks 副本 + anima_workflow_3 节点 861 文档，共 9 个输入/Source/真实遮罩引用/多 Library provenance 检查；6 个连续权重/结构正文/Source 来源偏移/Blocks Find replace 检查，最终 errors=[]。额外真实关闭按钮检查如上。观察中先纠正了脚本的单参数 type、Monaco 自动闭括号、只读 window.closed 以及被窗口遮挡的外侧点击；最终用置顶的隔离 Outside editor button 做真实失焦。不是完整 ComfyUI 图执行/采样或用户已打开浏览器的原位验收，未新增测试文件或扩跑 suite。
- 生产 Python / 9 个 ESM 语法与定向 diff 检查通过。scratch 脚本在 TEMP `xyz-block-stall-{check,workflow,actions}.cjs`，库副本根 `xyz-block-stall-znqig5h9`；不修改原工作流/个人库，正式与持久 8190 未重启、未写入。后端 completion list 需用户重启 ComfyUI，前端 Ctrl+F5；未 commit/push。
- 本轮独立 Chrome session 与已核验的三个自有 fixture Python（24044 / 2724 / 50728）均已关闭，临时观察材料保留。

### 2026-10-13：图片 View masks 单窗口

- `mask_library.js` 在模块内共用一个图片查看窗口；同图重开、不同 Library panel 和 Region 的 `openCanvas` 入口均复用，替换标题/遮罩列表并保留窗口位置与大小。传入 mask ID 仍高亮对应项；Close 清除引用，随后可重新打开。矩形编辑器不属于此图片查看窗口。
- 独立 LoRA fixture + Chrome，Mask tree 使用合成响应，真实鼠标点击两个面板的 View masks / Close，检查同图重复、跨面板换图、位置大小、指定 mask 高亮、关闭后重开及 errors=[]，**8 项通过**。仅前端交互检查，不是实际图片读取或完整 ComfyUI 工作流验证；未新增测试文件或扩跑 suite。ESM/定向 diff 检查通过，Ctrl+F5 生效；未操作正式/8190/个人数据或 commit/push。

### 2026-10-13：Settings Region 类型选择立即刷新

- 根因：`DetailsPane.render` 的草稿保护把仍聚焦的 Region Kind select 一并延迟到 blur 才挂载；命令已更新 Document，但 mask 坐标、IMASK 输入和其他参数仍显示旧类型。
- `details.js` 为 Region Kind select 标记所属稳定 ID，仅此类已立即提交的控件跳过草稿保护；保留 pointer 手势保护，重绘后恢复同一 Region select 的焦点。其他输入的未提交草稿保护保持原行为。
- 独立 LoRA fixture（临时 Library / 合成模型）与独立 headless Chrome 修前复现 Document 已为 mask、坐标仍不显示且 mountGuard 等待 blur；修后真实鼠标打开原生下拉、键盘确认，普通 Block / entry 独立页 / Region 父页各连续切换 mask、imask、fill、base、mask，无外侧点击即可刷新。含 Undo/Redo 共 **17 项通过**，errors=[]。不是完整 ComfyUI 工作流验收；未新增测试文件或扩跑 suite。ESM 语法、定向 diff 检查通过。
- 仅前端，Ctrl+F5 生效，无需后端重启；未操作正式/持久8190、个人数据或提交推送。临时观察脚本在 `C:/Users/XYZ/AppData/Local/Temp/xyz-region-kind-20261013/`。

### 2026-10-13：Blocks 换行、关闭项旁输入、include in base、Ctrl+↑ 连按

用户报告五个问题，均已修复（未提交、未部署；Python 部分需重启 ComfyUI，前端 Ctrl+F5）。

- **换行“神秘消失” / Block 末尾换行消失（同一根因）**：`formatting.format_document` 在 SetSettings / Delete / SetRegion / SetScheduleBoundary / CompleteLibrary / UpdateLibraryBlock 以及 ExpandLibraryReference、`_layout_indent` 下的 EnableCandidate 后对**整份文档**重排，旧实现把每个 sep 改写成 `,\n` + 缩进、把最后一项 sep 清空。Blocks 的 `separatorDisplay` 又把“换行 + 缩进”显示成空格，于是逗号后的 Enter 看似被吞，块末 Enter 直接丢失；表现为“在别处删个 Block，这里的换行就没了”。现规则：**换行不会拆 item**（`b\nc` 是一个 item，本就安全），用户换行只出现在 sep 里；裸换行（后面不跟空格/Tab）是用户 Enter，带缩进的是生成布局。两个 prompt 之间含裸换行的 sep 原样保留；最后一项 sep 保留 `(旧 sep + close 前导空白)` 中的换行数，已布局（lead 为换行+缩进）的块再减去闭括号自己那一行。必须同时数 close：pretty 路径是 format → refresh → format，第一次之后闭括号换行在 `close` 里，第二次之后才回到 sep，只数 sep 会在第二遍丢掉或在重复命令中逐次多出换行。测试：t70 `test_whole_document_layout_keeps_typed_line_breaks` / `test_layout_keeps_a_trailing_enter_but_adds_none`（重复 SetSettings 文本必须不变）。
- **关闭项旁输入落在它前面**：关闭项在值里没有字符，它前后两侧是同一个偏移。`text_input.inlinePoint` 旧实现在交界处取上游（前一个文本节点末尾），`applyNativeEdit` 用它放回插入点，所以 `tag1, [tag2 关], tag3` 在 tag3 前键入会显示到 tag2 前，失焦重绘再跳到后面；而 reconcile 始终把关闭项放回原 index，即**新文字在它之后**。现在 `pieces()` 给紧跟关闭项的片段标 `afterParked`，交界一律取下游。IME 不经过 `applyNativeEdit`，所以 `BlockView.caretPastParked()` 在 pointerup 后和输入首键（可打印字符 / `Process` / keyCode 229）的 capture keydown 中，把落在关闭项上游的折叠光标挪到下游；**不能挂 selectionchange**，否则方向键在关闭项前被反复弹回、无法左移。
- **Ctrl+↑/↓ 连按乱套**（`((((seductive smil:1.05)e:1.15:1.05)),:1.05)`）：每次按键都直接异步 `runTextAction`，第二次在第一次写回、重绘前读 DOM 选区，把旧偏移映射到新源码。现经 `PLv4Window.queueTextAction` 串行（Ctrl+↑/↓ 与 `nativeKey` 的所有 Monaco 动作）。去掉队列的对照组精确复现用户报告形态。
- **include in base**：用户决定——只有同一个 enclosing group（`[@region]` 容器或内联写法的父组）里有**启用的 base region**，启用且开了 include_in_base 的 region 才复制进 base；没有 base 或 base 已关闭（关闭即不在文本里）时开关无效，**也不再凭空生成 base 段**。实现在共享 `prompt_shared/language/ir.py`：`_collect_regions` 记录每个 region 的父组，`build_segments` 算出 `included_in_base` id 集合经 `RenderCtx` 传给 `_belongs`；删除了旧的 `wants_base`。V3 文本同样按此规则编译。t48 两个旧用例按新语义更新，并新增“不造 base”“base 必须在同组”用例。
- **Source 生成排版统一（用户要求：不要一行一个 prompt）**：`format_document` 旧规则是根层 prompt 用 `, ` 同行、Block 内每个 prompt 各占一行，同一份 Source 混着两种形态且很占地方。现规则在任意深度都是：prompt 之间 `, ` 同行，只有子 Block / 容器 entry 独占一行并缩进；用户的裸换行与块末 Enter 仍原样保留。只影响之后被结构命令重排的部分，手打原稿仍逐字保留。t70 中两条断言旧文本的用例已更新。
- **空行进不去 / 回车被吞（第二轮）**：光标常落在 `skinny,` 与其后分隔空格之间，连按两次 Enter 得到 `,\n\n long`。旧 `separatorDisplay` 把“换行 + 任意空白”当布局缩进显示成空格，失焦重绘后第二个换行从 DOM 消失：源码有空行但界面没有，方向键进不去，看起来像回车被吞。生成缩进永远是 Tab 或 ≥2 空格，故布局判定收紧为 `\n(?:\t| {2})`；`formatting._USER_BREAK` 用同一规则（`\n(?!\t| {2})`），否则下一次结构命令仍会把 `,\n long` 当布局改掉。两边必须一起改。
- **空行点不中（第三轮，真正根因）**：用户 anima_workflow_3 的文档是 **CRLF 与 LF 混用**（缩进全是 `,\r\n    `，空行处 sep 为 `, \r\n\n`——前半来自 Monaco/Source，后半是 Blocks 里的 Enter）。`\r` 留在原生可编辑正文里是不可见字符，Chrome 在这一行算不出光标：点空行任意位置都落到下一行开头，↑ 进不去，← 直接跨过。合成测试全是 `\n` 所以前两轮复现不出；拿真实文档在隔离 fixture 里做对照（关闭规整→复现，开启→点中/↑/← 都落在空行）。修复：`model.lf()` / `normalise_newlines()` 在 `EditorState.create`、`from_json`（含 text 比对）和 `replace_text` 入口把 `\r\n`/`\r` 统一为 `\n`，旧文档打开即自愈；`editor_core.lfModel()` 与 `text_editing` 的临时模型 `setEOL(LF)`，否则以 CRLF 初始化的 Monaco 模型会让之后每次 Enter/粘贴继续写 CR（单元测试的 Monaco 替身没有 `EndOfLineSequence`，所以写成有才设置）。测试：t70 `test_windows_line_ends_are_normalised_on_open_commands_and_typing`。**排查原生输入问题先看真实文档有没有 `\r`。**
- **related tags 面板抢方向键**（用户决定）：点击 tag 弹出的 info 面板（`_isInfo`）在未进入前不接管 ↑/↓——方向键照常移动光标并关闭面板；Tab 进入列表（第一项），之后 ↑/↓ 导航、Enter/Tab 插入。Tab 在面板里始终 preventDefault（related 行仍在加载时也不让焦点跳走）。打字补全弹窗仍是 Enter 确认第一项。**陷阱**：`handleKeyUp` 原本在列表可见时对 ↑↓ 以外的任何键抬起都重新查询，Tab 抬起就用补全替换掉刚进入的 related 面板。现在只有改动文字的键（单字符、Backspace、Delete、Process）以及列表可见时的 ←/→/Home/End 才重新查询。
- **关闭的 Block 不显示换行**：整段都关闭时每个 prompt 都是 parked 装饰，项间分隔写死 `, `。projection 行新增 `sep`（文档节点自己的分隔符），`textRun` 在 `lastLive < 0` 时用 `separatorDisplay(row.sep)` 画；含换行才采用，否则仍是 `, `，布局缩进照样折叠为空格。混合（部分关闭）段落的 parked 装饰规则不变。
- 验证：离线全量 952 passed，17 failed 均为本轮之前已有（Mask Library 第四输出、`NodeSessions` 用 `window` 等），与此无关。隔离 LoRA fixture + 独立 headless Chrome：separator 336、input layout 40、AVG 36 全过；另以真实键鼠/IME 合成复现并验证上述 3 个前端问题与 Delete / SetSettings 后的换行。

### 2026-10-13：PLV4 Mask Library（A–E，源码完成，未部署实例）

用户已确认 `plv4_mask_library_plan.md`，授权分阶段实施；保留其他修改、不操作个人数据/正式 ComfyUI/持久 8190、不 commit/push，仅本功能定向验证。

- A：`mask_library.py` 使用独立 `masks.db` / shared WriteQueue。画布 ID、矩形 ID、版本与顺序分离；删除保存最后坐标 tombstone，画布 Undo/Redo 写新版本。图片只读发现当前 input 相对子目录；已登记旧目录可继续解析旧引用。真实路径/符号链接不得离开 input/登记根；不自动创建 input 图片目录、不删除原文件。
- A：`mask_images.py` 纯 numpy/Pillow，复用 Krita `split_colors`，保留其原 hex 排序契约。主色按 alpha>=128 的面积降序、RGB 升序破同分，黑白/不连通同色合并；最近颜色/容差分配后乘原 alpha，共同拉伸到 512×512。Alpha 默认 1-alpha。图片 `presentation` 预览颜色与确切 RGB 身份分离。
- B：`mask_resources.py` 一次库快照、同图片一次字节读取，经既有 SetRegion/SetSettings 更新后调用共享纯 compiler。`meta.mask_library` 携引用、fallback、最近投影和原手动 IMASK。Source 坐标/kind/imask 显式改变解除不匹配关联，正文/其他参数改变保留。关闭引用不挂载；启用图片首次出现顺序去重、自动编号，随机/Schedule 不改身份，手动编号保持。缺文件/颜色明确报错；无引用文档不读 Mask Library。
- B：V4 追加第四 `PLV4_MASK_BUNDLE`，前三插槽不变、旧描述只追加。bundle v1 含执行 mask；metadata 仅含引用/规则/坐标/fingerprint，同次解析产生全部结果。IS_CHANGED 纳入使用资源版本/图片内容，未使用资产不影响缓存；坏资源 NaN 指纹阻止复用旧成功输出。矩形使用共享 compiler `num()` 表示后按 PC `int(size*coordinate)` 量化，覆盖六位有效数字边界。V3 历史 sockets/policy 不变。
- C：Library/Masks icon 切同一左栏并保留状态，不写 Document history；独立 Tools 窗口共用服务。`mask_editor.js` 复用多矩形/单矩形组件，双向选择/最上层命中、handle-only 排序、八 resize、Escape 取消、一次松开一次提交/Undo、版本冲突保留草稿。颜色/连接随 ID，Undo/Redo 不倒退版本。
- C：`mask_region.js` 二级菜单 hover/focus/click、Esc/外侧关闭，固定尺寸受视口限制、两列独立滚动，pointerdown 保留正文焦点。绑定坐标只读，编辑打开所属画布/选中 ID；单矩形无增加/删除/排序。图片显示路径/提取项/预览，解除恢复手动编号。Details 原只搬 `.plv4-field`，现在同时搬坐标/mask controls；异步预览检查实际 controls，而非被拆开的临时 section。
- C/D：DocumentSession.resolveMasks 串行外部刷新、提升 revision但不改 past/future。Node 和打开的 Library Block 刷新同一关联；正文草稿提交后再刷新。MaskResources 不固定临时 Library tab/不标记普通编辑。Panel、Region、selector 与 preview 清理/abort 请求；节点对象、graph epoch、连接身份、token 拒绝迟到响应。
- D：`mask_nodes.py` 在 execute 边界转 torch；Preview 输出彩色 IMAGE，再按隐藏 slot_keys 返回 MASK，缺 key 输出同尺寸零 MASK。frontend 按 key 重建连接，已连线不活跃项保留“未使用”，未接线旧项可删。实时预览从当前上游 Document（含 Reroute）读取，监听文档/库/连接/恢复，不轮询 graph，不需要执行或求值 seed。computeSize 固定最小尺寸；编辑器 ResizeObserver 在 rAF 写画板，不反写 node.size。几何不包含 Region feather/conditioning 权重。
- D：Attach clone CLIP、复制已有列表后只追加图片；actual=已有数量+k，与 expected 不同只汇总日志和 UI warning，继续，不修 prompt/覆盖/偏移。原 Attach Masks 保留。
- E：双语 V4/root README、AGENTS、方案和内部记录已更新；需用户之后自行重启 ComfyUI、Ctrl+F5，未部署到运行中的正式/持久实例。

定向验证：ComfyUI Python（其 torch，复用开发环境已有 pytest，无安装）t84 **18 项**＋既有节点兼容 t73 **6 项**，**24 passed**；新插槽/外部 history 和既有 DocumentSession 两个 Node 文件共 **15 checks passed**。全新 disposable real-ComfyUI / CPU / 临时 DB、input、user、output，独立 Chrome **31 项真实键鼠检查通过**：绘制、移动、八 resize、Escape 取消、handle 排序、画布 Undo/Redo、二级菜单/Escape、绑定只读、共享刷新无 history、打开所属 ID、解除/单矩形、Alpha/手动恢复、实时预览/未使用连线、断开清空、旧两输出追加四输出并保留链接；errors=[]。另 **2 次实际合成工作流执行**检查 512×512 IMAGE/MASK、半图像素、未使用零 MASK、CLIP 初始 0/1 → 追加后 1/2（上游仍 0/1），编号冲突 warning 后成功。Python AST、ESM/CJS 和 diff 检查通过。

未扩跑全量、未载模型/采样；OS 原生颜色选择器、触摸、全部 Nodes 2.0/Subgraph 组合及跨机器文件携带未实测；颜色与 RGB 分离由纯测试覆盖。初次新实例模板弹窗挡住画板，fixture 实鼠标关闭后通过；重复 fixture 暴露菜单屏幕下沿问题并修复，最终用独立新目录。自有实例和浏览器收尾关闭，临时记录保留；个人数据/持久 8190/正式实例未操作。

### 2026-10-13：Library 与 Danbooru tag 共用插入行为

- 这是独立于下节 stale_revision 的新问题：Library 候选原先走 CompleteLibrary 结构替换，绕过 TagAC 的 delimiter/caret，并全局排版/重绘；Danbooru/Gelbooru 走原生文字插入，所以两者的逗号、空格和光标不一致。
- completion.js 不再为 tag 候选提供专用 insert/canInsert。所有 tag 共用 TagAC `_insert`/`_spliceInsert`，按同一 autoInsertComma、已有分隔符、拼写规范化和 related 规则插入并移动光标。Library 的结构化权重/LoRA 用 tagText 保留语法，不作为普通 tag 转义；普通 Library tag 与 D/G 共用拼写规则。
- Native 与共享 Monaco adapter 只在同步 splice/input 期间携带 completion（已插入 prompt span、snapshot、source），随后清除。RunSession 和 DocumentSession 将其带入同一个 ReplaceText；后端在精确匹配的 prompt 上附来源，正文与 snapshot 相同时恢复快照的 metadata/关闭子项，保留当前 ID、separator。文字规范化不同则保留插入文字；部分 prompt 不误附来源。无额外命令/history、全局格式化或焦点恢复；历史 CompleteLibrary API 保留但 tag 补全不调用。
- 未新增测试文件或跑 suite。既有 disposable ComfyUI fixture 与独立 headless Chrome 对照：D/G 与 D/G/L 合并候选均得 `{ blue eyes,  }`，正文 `blue eyes, `、caret=11、同一原生输入；Library 来源保存。Library-only 鼠标插入后立即输入 next 得 `{ library only tag, next }`；Source 同样插入并保存来源，caret=13。已有逗号、autoInsertComma 关闭时两种来源一致，不重复分隔符；带权重 Library tag 保留 `(weighted library:1.2), `，一次 Undo 恢复 weig、Redo 恢复补全。上述观察 errors=[]；首次 Library-only 等待误用未规范化的下划线名称，改为观察实际显示名后继续，未据此修改产品。
- 七个生产 ESM/Python AST/diff 检查通过。该来源随输入保存的后端扩展需正式 ComfyUI 重启，前端 Ctrl+F5。未操作正式/持久8190进程、个人 Library/workflow 或提交推送。

### 2026-10-13：Blocks 回车补全与正文保存竞态

- Native TextRun 先在 active.pending 排队，再进入 DocumentSession 队列。RunSession.whenIdle 原先只等待后者，CompleteLibrary 因而可能在最后字符尚未入队时读取旧目标/revision；该字符随后提交导致 `document changed; recompute the target`，另一些时序会提前关闭 RunSession 而跳过余下草稿。
- RunSession 持有所属 input，whenIdle 循环等待正文 pending 与 Document 队列均稳定；Pool 补全通过 session.whenIdle 等待两层队列，再按当前 projection/source offsets 计算目标。保留 Document revision guard、共享 TagAC 和原有历史，不吞掉 stale_revision、不强行重试旧 span。
- 未新增测试文件或运行 suite。复用既有 disposable ComfyUI fixture，在新临时根和独立 headless Chrome 观察：修前通过原生 insertText、一次 microtask 间隔与补全 Enter 精确复现上述 SessionError；修后相同操作、真实快速按键与 150ms 延迟保存先保留全部字符再完成补全，Undo 恢复完整 `bluexyz`，Redo、Library 路径补全、D/G 普通补全与原生换行通过。最后 D/G/延迟复核 errors=[]。早期连续切换观察一次 Monaco `Illegal value for lineNumber`；一次路径观察等待不足时菜单未出现，延长等待并确认可见后回车成功，不据此修改产品或宣称所有场景无错误。
- 两个生产 ESM 语法与 diff 检查通过。仅前端 Ctrl+F5 生效，无需后端重启；未修改正式/持久8190进程、个人 Library/workflow 或提交推送。

### 2026-10-12：PLV4 图片 metadata 与 Gallery 第一阶段

- V4 / Monaco 在原 prompt/plain 后追加 PLV4_METADATA 快照；包含有效 Source、Document v2 全量副本（关闭项保留）、精确输出、节点 seed 和 Region backend。IS_CHANGED 纳入完整 Document，防止关闭项等 metadata 更新命中旧输出。V3 身份/两个输出/编译策略保持。
- 共享 CompileResult 暴露已有随机化 IR 的有效 LoRA token / interval，不另抽随机。XYZ PLV4 Image Metadata 明确合并正负快照及额外固定 LoRA Source syntax（可用 PLV3 Schedule），选择 prompt/plain，跨来源按完整调用与区间一对一消重；排除负向贡献但保留负向原文。双强度和 Schedule 留在结构化汇总；Lora Manager legacy loras 字段仅作兼容哈希查找表示。
- `prompt_shared/image_metadata.py` owns v1 schema/validation/transport；additional_data 的 XYZ PLV4 字段使用 UTF-8 JSON/base64url，不含传输包 overrides 自身，最大 JSON 8 MiB。图片快照不读取 Library。Aaalice `nodes/_lib/plv4_image_metadata.py` 为本次保存创建局部 adapter，合并明确覆盖（包括空值）、原采样数据及其他 additional_data；文件名和 recipe 共用合并视图，禁重复追加兼容 LoRA 文本。无 XYZ import、全局 hook 或落盘后补写；Lora Manager 源码未改。
- Gallery 独立读取 parameters 扩展，不被 workflow 优先分支跳过；generation.plv4 沿既有 generation_data_json 存储，保留 NovelAI 来源。列表仅返回 has_plv4 摘要；详情给出完整快照。PLV4Prompt 只读组件复用共享 Monaco tokenizer，Source/Prompt/Plain 默认 Source，复制原文，LoRA 显示双强度/时间区间。importmap 由 Gallery shell 按当前安装目录生成共享模块地址，不把相对路径误解为 gallery/static 的邻目录。
- POST `/xyz/gallery/image/{id}/reread` 对一个已注册根内文件显式重新索引，仍由 WriteQueue 写入，不回写文件、不全库扫描；详情按钮与收藏/标签同步操作避开重叠。PNG no_gen/clean 下载模式随 parameters 移除快照，no_workflow 保留。
- V4 region_mode widget 保留原序列化但隐藏；窗口节点级 Region select 修改同一个值。旧两输出描述恢复时补 metadata，旧 mask 值保持。连接上游时禁止手改，Preview 使用 graphToPrompt 解析同一 mode；后端上游尚未求值时明确提示。嵌入 Monaco 高度按 V4 只剩一行常规 widget 计算。
- 遵守不新增/扩跑 suite：仅 Python AST、ESM、三份 Aaalice locale JSON、正常 Git diff 检查及有限隔离链路观察；t80 的既有双字符串输出断言改为取前两插槽，适配新增第三输出，未增用例或运行 suite。真实 ComfyUI 8191 使用当前 XYZ/Aaalice/Lora Manager 副本和合成 EmptyImage，无模型/采样：两个 PLV4 → merge → Aaalice → Preview 实际完成，输出 PNG 仅有 parameters；Source/关闭项/负向排除/双强度保持。单图 reread、标签/收藏镜像、no_gen/no_workflow 下载实际读回符合预期；列表无完整快照。Gallery 实鼠标切换 Source/Prompt/Plain、共用 tokenizer 与 LoRA 显示，浏览器 errors=[]；Region 原生 select 键盘变更同步 widget/Preview/serialized，旧两输出恢复补三输出、mask 保持、V3 widget 未隐藏。
- 局部纯观察确认关闭项 metadata 变化更新缓存而 prompt 不变；用安装版 formatter 的原函数核对空正负/空 LoRA 明确覆盖及 seed/steps/CFG/其他 additional_data 保留。未验证模型采样、recipe 实际保存、Subgraph/Nodes 2.0 全链、JPEG/WebP EXIF Gallery 或浅色主题实截图；第一阶段 Gallery 保证 PNG 路径。早期隔离副本漏 LM static 目录导致其导入失败，补齐副本后实际链路成功；首次浏览器被启动模板层遮挡/延迟恢复图影响，按既有启动等待后复核，未据此加产品时序补丁。最后导航/截图驱动未返回，已关闭本轮拥有的浏览器驱动及8191；不计作浅色/额外截图验收。
- 本机两包源码已更新，需重启正式 ComfyUI 并 Ctrl+F5。未操作正式进程、个人 Library/workflow 或持久8190，未提交/推送。设计与接口见根 `plv4_gallery_metadata_plan.md`，用户用法见双语 README。


### 2026-10-12：正文花括号结构提交与不可见右键菜单

- 真实鼠标复现：alpha 包裹 {} 后点击 Header，Source 已有子 Block 而 DOM 仍旧两块；Header 重新聚焦旧 run DOM `{alpha}, beta`，新 RunSession 却只负责 beta，再输入 x 写成 `{ {alpha}, {alpha}, betax }`。finishInline 共用每个 active 的 finishing Promise，后续 focus 等待退休；Header 等待 pointer click 与重绘后再聚焦。直接切另一正文时提交完重绘前一区域，保留目标原生 DOM、草稿和选区；空正文 bookmark 同时记录两侧 Block，避免重定位到另一空插入口。flush 同时等待正在结束的 blur。
- 右键实际已创建 Monaco menu，但 ContextView 位于 display:none 的 Source container，宽高为 0。共用 showEditorContextMenu 在同步 show 期间为 Monaco ContextView 提供可见 center host，并立即恢复原服务方法；仍用原菜单 actions/keybindings/service，不维护另一套菜单。Source 原生菜单使用 Shadow DOM，验证需读实际 ContextView，document.querySelector 不会找到它。私有服务接口需在 Monaco 升级时复核。
- 遵守不新增/扩跑 suite，未添加测试文件。独立既有隔离服务 + Chrome 实际键鼠：修前复现重复和宽高0菜单；修后 Header、另一 Header、同父另一 run、窗口外点击均立即显示单份子 Block，Source 往返不变；快速切换并输入 tailx 没有复制或丢失文字；选区 alpha 右键菜单尺寸375×320并截图确认可见，Create as block 可执行，Source 原菜单375×312仍可见，errors=[]。生产 ESM / diff 检查通过；不是完整 ComfyUI 工作流验收。
- 仅前端，Ctrl+F5 生效；未操作正式进程、持久8190、个人 Library/workflow 或提交/推送。



### 2026-10-12：整节点保存、Pool 偏好与 Settings tag 图片预览

- 中间 modebar 新增「保存为 Block」，仅 workflow Node 显示。SaveLibrary whole_block 在同一 single-writer 事务内复用 WrapSelection / InsertBlock 后保存；单一完整 Block 直接保存，空节点可建空壳。取消不包裹、失败回滚，一次文档历史；子项 ID/order/enabled 保留，原 Document 保存入口保留。
- details_preferences.js 将 filters / views 按 document root.meta.owner（Library 页按 asset ID）及 block ID / pool ID 保存在 localStorage。类型/unused 筛选、Pool section、候选树及全树折叠默认均可恢复；Pool 全树折叠不改 Content 折叠。UI 偏好不写 Library 或 Document，不产生 undo。
- TagAC 公共 attachPreview / createPreviewIcon 与自动补全 / related tags 使用同一 icon、showTagPreview/showArtistPreview/previewCount、metadata cache、popup、tag_preview 和 preview_image。Settings prompt 只解包单项 attention / prompt shell；按实际 Danbooru tag/alias 精确匹配，保留转义括号及 Anima @artist。XYZ Settings save 即时刷新已显示图标。新增只读 POST /xyz/tagdb/lookup 批量索引查询活动 Danbooru DB，最多 500 名；前端合并查询、缓存身份，关闭预览时不查，图片仅 hover/focus 加载。
- 遵守既有不新增/扩跑 suite 约束。生产 ESM/Python AST/diff 检查；独立 Chrome + 既有隔离 Window/Document/Library 服务实际鼠标验证：取消不改、整节点包裹并保留 ID、单步 undo/redo、覆盖 version=2 不再包裹、关闭项/空节点保留；Pool type/usage 在重开及刷新后恢复，全树展开/折叠在重开后保留；artist-only/all/关闭的图标范围，普通文本无图标，转义 tag 和 alias 识别，共用 popup / preview_image 图片加载。图片使用隔离 fixture，不是实时 Danbooru 网络验收；不是完整 ComfyUI 工作流或实际服务重启验收。早期刷新观察曾只恢复 doc 而漏 text，及移除仍在用的 session；纠正为重载后完整 doc/text workflow 快照再观察，没有按该脚本错误修改产品。
- 本轮后端新增保存分支/TagDB 路由需重启正式 ComfyUI，前端 Ctrl+F5。未修改个人 Library/workflow、持久 8190 或正式进程，未提交/推送。


### 2026-10-12：PLv4 窗口剪贴板事件泄漏到工作流

- 当前 ComfyUI shouldIgnoreCopyPaste 只检查 input / textarea / 非空文本选区，未识别 plaintext-only；Blocks paste 的原生插入完成后仍冒泡到 document，无选区时触发画布 pasteFromClipboard。Window 根在 bubble 隔离 copy / cut / paste，保留浏览器和已有正文 paste 默认处理；window capture 隔离非 Monaco 控件的 Ctrl/Cmd+C/X/V（keydown/keyup），不 preventDefault。Monaco 保留自身 target 键盘处理，窗口外事件照常传播。
- 无新增测试文件或运行 suite。隔离 Chrome 加载实际 PLv4Window / BlockView / DocumentSession，使用本机 ComfyUI 的 shouldIgnoreCopyPaste 函数和画布操作计数监听：修前一次正文粘贴同时触发一次画布粘贴；修后真实 Ctrl+C/X/V、无选区复制、TextRun 剪切后粘贴均仅编辑正文，画布 copy/cut/paste 为 0，焦点留正文。隐藏窗口后画布 copy / paste 各收到一次事件。浏览器 errors=[]；不是完整 ComfyUI 工作流验收。ESM / diff 检查通过，Ctrl+F5 生效，未操作用户工作流或个人数据。

### 2026-10-12：删空 TextRun 后继续输入与鼠标选区保持

- TextRun 保存前后 Block 边界，重新聚焦时按当前 Document 解析该正文段的 IDs；删光正文时按原 owner / 相邻 Block 位置建立插入会话，已有逗号不重复添加。关闭项不自动启用，LoRA 固定调用不加入正文编辑范围；已退休/脱离 DOM 的异步初始化不再创建 RunSession。
- 缓存正文节点重挂载时保存并恢复浏览器原生选区及方向；Block 定位不折叠已有正文选区。源变化时的焦点恢复等待当前 pointer gesture 完成，并优先使用拖选完成后的选区。
- 无新增测试文件或运行 suite。独立 Chrome 页面加载实际 BlockView / DocumentSession，命令使用真实 Python Document 服务函数：先复现旧 ID 报错及只读正文选区刷新后清空，再观察修复后的子 Block 尾部删空/重新输入、正文 ID 替换后重聚焦、拖选/延迟重绘和只读正文选区刷新保持；浏览器 errors=[]。不是完整 ComfyUI 浏览器验收；ESM / diff 检查通过。仅前端 Ctrl+F5 生效，未操作个人 Library、workflow 或运行实例。

### 2026-10-12：Settings prompt 权重恢复 1 时去除包裹

- SetPromptSettings 将普通 prompt 的 Weight=1 视为清除权重；已有 attention 包裹直接展开，保留子项 ID、正文顺序、空白和有效 enabled 状态。已有 Schedule/Region prompt shell 仅清除 weight；LoRA strength 仍写调用语法中的显式 1。未加权 prompt 重置不创建 `(prompt:1)`。
- 没有新增测试或运行 suite。局部真实命令观察覆盖手写/界面创建的 attention、多项 attention、原空白、Schedule、关闭 prompt 和 LoRA，结果符合预期；Python AST / diff 检查通过。需重启正式 ComfyUI 加载后端修改；未操作个人数据或运行实例。

### 2026-10-12：Blocks 共用 Source 输入与 Settings 开关状态

- shared text_editing.NativeEditorInput 每个 Window 复用一个隐藏的 Monaco model/editor，沿用 Source 的语言与编辑选项。beforeinput 的非 IME insertText 交给原生 Monaco keyboard/type；surround/auto-close/overtype不复制配对表，必须使用 source='keyboard'，普通程序化type会关闭surround。结果以最小替换通过浏览器insertText写回当前TextRun，保持DOM选区、Document历史与RunSession；Enter/Backspace/Delete/IME继续走浏览器，TagAC/nativeCompletions沿用既有共享适配，隐藏引擎不另起补全。
- Tab/outdent和内置文字命令在当前正文run的同一引擎执行；快捷键从 Source 的现有supported actions/standaloneKeybindingService动态读取。PLv3权重/创建Block等文档命令仍用原PromptEditor，Find/Menu沿用原共用服务，不另维护菜单条目。正文contextmenu捕获统一入口涵盖prompt span和空正文；右击保留选区。
- window.locate默认只改变selection，不自动打开Settings；仅显式右键「详细设置」/Source「定位详细设置」传reveal=true。已打开Details仍按原selection更新。文字动作执行后恢复当前正文焦点/选区。
- 无新增测试文件或suite。隔离8191真实鼠标/键盘观察：三种括号包裹alpha、选区保持、Document结果正确；右键为同一Source菜单且保留alpha；Uppercase ALPHA、Ctrl+L选本行、之后括号包整行、Undo恢复ALPHA，焦点留正文，无浏览器异常；关闭Settings时Header/正文/Tab不打开，打开后定位i3/owner i2。语法/diff检查通过，正式进程/Library未改；本次仅前端Ctrl+F5生效。

### 2026-10-12：Settings 开关闪回与 Pool 添加延迟

- Details 的共用命令入口在提交期间保留现有页面，取消早先尚未挂载的页面，完成后使用当前 session 重绘；期间切换选择按 selectionEpoch 保留新目标。checkbox 捕获点击值、防止重复提交，失败恢复；prompt 行即时显示对应启用状态。
- Library 的 edit/sync_pool 仅在实际新增/修改资产时提升 Library revision、执行全库 placement/loose 检查并通知刷新。observe 保留指纹基线和删除后不自动补回的规则，已观察且未改变的 prompt 不重复写；需要收集新指纹时才读取 Class tag keys。bind_paths 没有未解析路径时不构建全库 catalog。保存/移动/删除等实际 Library 写入仍完整校验并通知。
- 未新增测试文件或运行 suite。独立 8191、Library 副本的真实鼠标观察：修前 prompt/Shuffle 各 2 次整页挂载并发出 edit/tree/candidates；Pool prompt Add edit 329.5ms。修后开关无回跳、每项仅 1 次最终整页挂载/1次edit，无tree/candidates刷新；prompt edit31.7ms、Shuffle15ms、Pool Add18.3ms。数字是此场景的请求耗时，非全窗口性能指标。正式服务/数据未改；需重启正式 ComfyUI 并 Ctrl+F5 加载前后端。

### 2026-10-12：选中含子 Block 的 Block 不展开空正文

- selectBlock 仅聚焦已有、未隐藏的正文输入，不创建或展开空正文；容器入口的后备聚焦同样跳过隐藏输入。显式「＋ 正文」、添加 Block 和编辑焦点恢复仍沿用原有按需展开行为。
- 仅做 ESM 语法与 diff 检查，未新增或运行测试。前端 Ctrl+F5 生效，无需重启或修改 Library 数据。

### 2026-10-12：选中、标签切换与添加的响应延迟

- DocumentSession.locate 只更新本地 selection，不改 doc/revision/history，也不请求服务；按已有 projection 判断 prompt 所属 Block。selectionEpoch 防止正在返回的编辑响应覆盖后来的选择。Node persist 和 Monaco sync/lint 跳过纯选中；移除 Block 边框 120ms 过渡，Details 已打开时不再重复 layout。
- Node 标签点击立即反馈 active；打开目标只在 activate/detach 保存旧编辑一次，Library 已有索引时在内容显示后后台刷新。晚到的标签请求会被取消检查挡住；取消后已解绑的当前 context 必须重新绑定，不能误走 same-node early return。命令/flush 捕获原 context，添加结束若已改选或切换节点不夺回焦点。
- 空 InsertBlock（普通、Schedule/Region/AVG）及空 InsertEntry 走 stateless Document；已有内容编辑仍先正常 flush/commitPool，快照插入和非空结构编辑沿用 Library 服务。不新增临时 Doc 节点或 fork parser。
- 无新增/扩跑测试。正式 Library 只读 backup 至独立 8191，实鼠标单次观察：Block 选中 2.9ms/0请求/transition=0；缓存 Node 标签反馈0.4ms、内容15.1ms，Library read59.4ms在后台；添加Block23.2ms、唯一InsertBlock请求4.3ms；另一个Node反馈0.2ms、内容12.7ms。只代表此处DOM反馈，不代表所有工作流耗时。首个旧版本观察因 ComfyUI 启动后又恢复工作流导致节点移除而中止，没有拿其数据做前后耗时比例。当前修改只在前端，Ctrl+F5即可，正式进程/个人数据未改。

### 2026-10-12：Pool 同级 Block 合并与窗口重复工作

- Settings Pool 每层固定 Subclass / Block / Prompt，各组 compareNames 排序。与 owner 绑定同一 Class 的普通保存 Block 使用 stateless MergeLibraryBlock，一次复制 source.children，不套 root 外壳。promptKey 风格去重涵盖已有关闭项和未绑定普通后代；独立子池、LoRA 与特殊容器保留语义。child occurrence=[pool,source block ID,source child ID] 用于反复加入去重；不改变现有 ID、顺序或 enabled。根配置不转移，子 Block 的绑定/配置/关闭项保留；选中 owner，一次 Undo / Redo。
- 真实鼠标已复现先点 i2、再点 i6 后仍选中 i2。Blocks 加 capture pointer gesture，重绘延迟到原生 click 完成；不挡拖动 handle，以保留拖动自动展开。无改动正文 blur 只退休自身 RunSession，保留 DOM/cache；有改动照常保存并重绘。
- LocateDetails 原先在有关联的文档中走 Library edit，产生写事务、全库 revision/event 和刷新。现在走纯 Document 服务；window.locate 打开 Details 后由 changed 只渲染一次，已选同一 ID 直接返回。Library revision 未变不重绘；Pool read 按 revision/pool/excluded source 缓存并共用 in-flight，候选 Block 展开时才生成预览。
- 用户禁止新增/扩跑测试，本轮仅语法/diff、实际隔离界面与 API 观察。正式库只读在线 backup 到独立 8191 fixture，个人源未写。相同双点击场景修前 3 Settings render / 1 Library reload / 5 Library requests，第二次 click 丢失；修后选中 i6，1 render / 0 reload / 1 Document request。Settings DOM 3099→1365；这是该样例的导航/DOM工作量，不代表全窗口耗时同比缩减。正文输入后切换保存 beta changed，一次点击生效。
- 实际 Pool 检查显示 Class、18 Block、Prompt 分组；关闭 alpha 已存在、未绑定子块已有 delta，加入同 Class 来源 alpha/gamma/{delta,zeta}/关闭 parked 后仅加 gamma、保留子块 {zeta}、关闭 parked，原 alpha/delta 不变。重复 + 仍 5 child；Undo 2 / Redo 5，owner 仍 i2；候选预览展开可读。没有新增测试用例/脚本、个人 workflow 修改、模型采样、commit/push 或正式服务重启。新的后端合并命令需正式 ComfyUI 重启加载。

### 2026-10-12：Library 删除、移动、滚动与 Class 页内添加

- 后续排序要求：Library 每层固定 Class / Folder / Block，同类型沿用 compareNames 字母排序；移除顶部名称/position 切换及运行时 sort 状态。移动/绑定目录选择器同步顺序，仅显示排序，不写 DB position 或正文顺序。本轮仅语法/diff 检查，未新增或运行测试。

- 删除 Folder / Class 在 single-writer 的同一事务内按后代优先删除实际 containment；不改 RESTRICT FK，不沿 meta.pool 删除存放在外部的 Block。确认使用独立取消 / 删除按钮并默认聚焦取消，删除后清理受影响 Library 标签与 session。
- `library_dialogs.js` 提供带图标的目录树 / 内容列表 / breadcrumb / 上一级移动框，沿用 parentOptions 的类型限制、源/子孙排除和 LoRA 隐藏。design_adapter 必须把 overlay 根选择器转成 :scope.library-dialog-overlay，否则 @scope 中的普通选择器无法匹配根，窗口会落到页面底部。
- Settings 的 Block 绑定 Class 复用同一个 destination dialog，只列 Folder / Class，Folder 负责浏览、Class 可选，支持解除绑定；普通选择仍隐藏 LoRA Class，LoRA 固定绑定限制不改。隔离真实界面物理点击 Settings 入口、选 Folder 内 Class、确认绑定与解除绑定均生效，没有 dropdown。
- renderTree 保存并恢复 inner tree / Library pane scrollTop，恢复替换行焦点时 preventScroll；关闭 browser scroll anchoring。常规 Library 底部操作说明删除。
- Class / Subclass 页内输入＋Add，菜单/标题＋聚焦对应输入，不再用 showForm 添加 tag。save_tag 单事务解析多个 prompt，cleanPromptInput 支持中文逗号、现有解析器保留权重和 LoRA；输入草稿按 Class ID 保留，成功只清除已提交草稿，失败保留。添加后的焦点恢复不滚动。
- 用户明确要求停止新增和扩跑测试，已撤回本轮新增 Python 用例；既有 JS suite 仅调整入口 mock 和新增输入框后的旧查询。之后只做语法/diff 与隔离真实界面检查：物理鼠标展开时 scrollTop 230→230、移动到目标 Folder、页内四项批量添加、取消/递归删除及活动 Class 标签清理，无 editor exception。未操作用户 Library / workflow，正式 8188 未重启；后端删除改动需正式 ComfyUI 下次重启加载。

### 2026-10-12：启动与 anima_workflow_3 画布性能排查

- 正式启动历史日志约 82–131 秒（Manager 记录起点到 GUI），XYZ 自身 0.3–0.4 秒。一次独立冷启动 importtime 的 transformers 约 28.6 秒、torch 13 秒；随后单独暖缓存 transformers 总导入约 3.84 秒，不能据此归因到 XYZ。其他较重插件及 Manager prestartup 占其余时间。
- `js/xyz_canvas_performance.js` 通过标准 extension setup 安装单次绘制范围的 slot palette 转换缓存；共享 helper 在 `js/prompt_shared/canvas_performance.js`。Frontend 1.53.6 每条连线重复转换同一表，234 节点 / 270 连线副本低负载 A/B 完整重绘中位数约 10.1 → 9.1 ms。每次绘制结束（包括异常）恢复原 converter，下一次重新读 palette；支持不同 palette、renderer 更换和接口缺失。没有改 ComfyUI 核心或 site-packages；升级移除内部 adapter 时直接走原 draw。该优化不代表整个拖拽耗时减少 10%。
- 本机另外两处修复在其他 custom_nodes 中：Prompt Assistant 的 imageCaption 缩放轮询只在 scale / threshold / collapsed / graph / image / feature 状态变化时刷新；Aaalice Pack-Unpack 的初始化撤去每次启动的 pip，安装仍由 Manager / requirements.txt 管理。这两处属于对应插件，核心更新不会覆盖，但更新对应插件自身可能覆盖；原件与复核脚本保存在 `.codex-backups/comfy-performance-20261012`（整合包根）。用户自行启动的正式日志确认 Pack-Unpack 导入 0.0 秒、GUI 约 65 秒，不能把全部时间差归因于该修改。
- 验证：t72 共 14 个 Node suites 通过；canvas cache 7 项断言、外部轮询复现由旧代码 101 次更新降为 1 次并通过 8 项检查；一次性真实 ComfyUI 使用工作流副本，物理鼠标平移、234 节点 / 4 Monaco、每次绘制 1 次转换、缩放/折叠/真实 Image 出现和隐藏通过。fixture 的 RMBG 因未复制 SAM3 资产未注册，因此其中 AILab_ICLoRAConcat 为 placeholder；未做执行/采样验证。后续系统可用内存约 380 MB 且出现磁盘换页，重绘数据明显恶化，不能与前面低负载 A/B 合并。仅关闭本轮拥有的 8191/Chrome，释放后可用内存约 3.5 GB；用户正式进程未重启，个人 workflow/Library 未写。

2026-10-12 测试实例启动修复：`test/manual/prepare_xyz_test_comfy.py` 的 PACK_DIRS 必须包含 `prompt_shared`。遗漏会让旧 V3 alias 导入失败，整个 XYZ 包不注册，前端统一提示缺少节点/安装 Manager。t78 新增真实 prepare 调用检查共享 backend/frontend 复制与既有 Library/workflow/settings 保留；4 tests passed。持久测试 8190 修复后 14 个 XYZ 节点及两份保存示例的节点均可用，已有 assets 不变、旧池 mode=1 未转换。不要为此安装 Manager 或重建工作流。

- 用户手册：[中文](README_zh.md)、[English](README.md)。
- 需求记录：[plv4.md](../plv4.md) 末尾“新的block架构设定”及其后续明确更正，以最新 2026-10-11 Folder/Class 分离要求为准。
- 实施记录：[plv4_plan.md](../plv4_plan.md)，P0 原型仅为历史设计依据，不是运行契约。
- 仓库维护规则：[AGENTS.md](../AGENTS.md)。本机 HANDOFF.md 是忽略提交的接续记录。
- PLv3 语言：[设计文档](../prompt_library_v3_design.md)、[手册](../prompt_library_v3/README.md)。V4 不另建语言或编译器。

当前运行模型是 Folder / Class / Block，Tag 为 Class 内的叶子。Document 保持独立保存入口。2026-10-11 的 Class 只接管原 Folder 的候选池职责，不恢复历史 attribute、belong/load、dummy、class instance 或共享 Block 指针。

### 2026-10-12：验收后正式 Library 替换

- 用户明确授权将两批 PLv3 导入部分实装正式库、清空上一版 V4 导入，排除测试资产，并保留其移动的 copyright Folder。导入日志标识 722 条资产，读取测试库当前内容与位置后构建全新正式库：51 Folder / 35 Class / 556 Tag / 80 Block；根为 artist / plv3 / copyright，copyright 保持根目录。72 个旧测试资产及测试 LoRA 不带入；完整提示词仍为 plv3/完整提示词内五个 Block。
- 新目标在独立路径通过 AssetLibrary / WriteQueue 单事务填充，Class/Block 引用完整。只保留经核对的导入资产稳定 ID，因此其所有 pool UUID 在新正式库都有对应 Class；未裸拷贝整个测试数据库。80 Block × 2 seed × 2 mode × 2 output 共 640 对照与验收内容完全一致；行数据逐条核对、所有 Class candidates 可读、schema=2、integrity/FK 通过。
- 正式 8188 与常规 ComfyUI 进程均未运行，安装前再次核验停止状态及源/目标摘要；在线备份旧正式库后保留旧 DB/WAL/SHM 原件，安装验证后的新库。测试 8190 与 PLv3 源库均不变，未启动/重启服务、改 workflow/model 或 commit/push。显式个人辅助 `test/manual/publish_xyz_v3_imports.py`；备份/明细见本机 HANDOFF。此授权只覆盖当前验收安装，不变成后续自动转换许可。

### 2026-10-12：Header 添加、移动换行和混合正文

- Library 行底轻量区分（用户后续更正 Block 为基础灰）：Block 中性灰 `#25292c`、Class 灰蓝 `#243039`、Folder 灰棕 `#302c26`；每种设低饱和 hover/active 色，active 加同系 2px 左侧内线，名称保持统一浅色。默认分隔线改中性低对比灰，避免大量彩色框；图标颜色独立保留。最亮 active 状态名称对比度最低 7.78:1、次级控件最低 3.32:1；本地静态 Chrome 预览检查普通/hover/active，非实际 ComfyUI 浏览器套件。仅同步 8190 design.css，无重启或数据修改。

- Library 图标颜色区分（用户后续交换 Block/Folder）：Class 浅蓝 `#8fc7f0`、Block 灰色 `#8c989f`、Folder 琥珀 `#e2b878`，分别由 `--library-class-icon` / `--library-block-icon` / `--library-folder-icon` 管理；Class 页 Subclass 图标跟随 Class 色。仅同步 8190 design.css，保留 SVG 形状，未改数据/服务。diff check 与实际 HTTP 文件一致核验通过。

- Class 详情后续调整：每层先显示 Subclass，再显示本层 prompt，各组维持字母排序；本层 tag 数量标题随本层 prompt 一起放在 Subclass 后。只调整 FolderPage 的 DOM 排列，Settings Pool、Block Content 和数据顺序不改。定向 t72 Library suite 通过，ESM/diff 检查通过；仅同步 8190 folder_page.js，无重启。

- Library 简化：Folder 名称/压缩链段/键盘/右键首项都折叠或展开树，不打开详情或标签；_openFolder 的历史宿主调用同样转向树操作。搜索时有独立折叠状态，不污染正常浏览；Folder 创建/重命名/移动等仍用既有右键菜单。Class 页面每层 tag 与 Subclass、Settings Pool 每层 tag/Class/候选 Block 采用共享英语 Collator（忽略大小写与标点）显示排序，复制数组后排序，不重写 DB position、Class 内容或 Block Content；候选 Block 内部预览仍跟正文顺序。t72 **13 passed**；更新真实 Class fixture，**36 项通过**，含 Folder 物理点击/搜索、Class/Subclass tag 排序、Settings Pool 排序、Content 原顺序及既有加入/Undo/LoRA 隐藏。仅同步 8190 五个前端文件，无重启/数据导入。

- Settings Content 连续单击修复：真实鼠标两轮复现前一 prompt 输入/勾选后，另一删除按钮在 press/release 之间被 mount 替换，Delete 未发出；正文编辑后另一勾选也会丢效果。DetailsPane 在 capture pointerdown 持有本次 gesture，mount 暂存最新回调，document pointerup/cancel 后等原生 click 完成再放行；change/blur 继续正常保存。焦点草稿保护排除 checkbox/radio，保留文本/数值/select/原生正文，避免 checkbox 聚焦时界面滞后。`plv4_content_click_browser_check.cjs` 使用独立真实 ComfyUI、真实鼠标，覆盖三种前序操作 × 启用/删除、UI 状态和草稿保存，**16 项通过**；t72 **13 passed**。8190 仅同步 details.js，无需重启，未操作个人库/工作流。

- 后续用户要求按需展开正文：连续子 Block/尾部 emptyInput 包装为 6px seam，悬停「＋ 正文」点击展开原 plaintext-only 输入；空着 blur（包括直接切换到另一文本段）收起。零高度 seam 的内外层尾部按钮会重叠并插到错误父级，因此保留细缝，未增加正文空行。focusInput/restoreFocus 可展开入口；空 Block、特殊容器/Library 边界、RunSession/insert_anchor/原生 Enter 规则保留。定向 t72 **13 passed**（13 Node suites），独立真实 ComfyUI 混排浏览器 **23 项通过**，含多层尾部实际鼠标定位。8190 只同步两个前端文件，无需重启；Ctrl+F5 生效，未更新工作流/Library。

- Header 同级/子级添加及 Footer 添加保留 pointerdown 时的正文焦点，click 后由既有 addBlock 正常提交；避免 blur 重绘吞 click。More 共用同一方法，保留其悬停菜单。
- MoveBlock 不再全文 format_document；Schedule/Region entry 移动也保留正文排版。_separate 补逗号时保留原 whitespace；旧 _layout_indent 不再强制所有 metadata 命令全文重排。原位 raw、用户空行、关闭项和 ID 保留。
- 普通 Block 的末尾及连续子 Block 之间提供临时原生文本入口，复用 RunSession；未输入不创建节点，输入属于同一父级。可维护前后分隔符，句号/已有逗号不重复追加逗号。insert_anchor 把新项放到实际 children 的相邻 ID 前或末尾，保住未启用子块的位置；Source/Blocks/history 同一个 Document，无新类型。Library 单根 Block 不提供根外入口，特殊容器第一层不提供正文入口。
- 回归先复现两次真实 Header 单击失败、MoveBlock 空行丢失及入口缺失；修复后定向 **176 tests passed**，真实一次性 ComfyUI 混合编辑 **16 项通过**。正式测试 8190 三份工作流共 **21 个节点 / 42 次编译**通过；新增第 06/07 个混合正文示例。仅测试实例同步并重启，Library assets 未变、正式个人库未动。没有扩跑全量或采样。

### 2026-10-12：重建测试 Library 与 LoRA 隐藏范围

- 用户明确要求重写持久测试 Library；此授权只适用于 XYZNodes-Test，不改变“正式个人库暂不转换”。build_xyz_class_library.py 在新目标构建并验证，安装前独立在线备份旧库、保留原文件；只在停止指定测试实例后替换 plv4-pools.db。旧工作流保留，新增独立 Folder-Class-Block 示例工作流和 manifest。
- 新样例含 10 Folder / 15 Class / 15 saved Block / 31 Tag，其中 6 Class 是两组本地 LoRA 的根及测试 Subclass。artist 示例展示 azurlane / 厚涂的分类和 anima / illustrious 的跨目录绑定、独立子池、关闭项；另有服装兄弟重复、场景、full prompt、Schedule/Region/AVG 和空容器。LoRA 身份及原触发词来自只读索引，不写模型、sidecar 或联网获取资料。
- tree 保留完整资产供池与身份使用，library_hidden 标记 LoRA Class/其后代及 LoRA snapshot Block/内部投影；lora_root 保留兼容。Library 树/搜索/链压缩、整理页、普通目的地和绑定选择器及 Source Library 路径过滤隐藏项；直接 LoRA 页保留后代编辑，固定绑定和候选 Pool 不过滤。
- t80 覆盖移动 LoRA Class 到 Folder 后全部后代仍隐藏及 saved LoRA Block；Node Library suite 覆盖搜索、选择器和空链。全量 **939 passed / 3 skipped in 45.03s**，之后新增 saved LoRA 断言由 t80 **30 passed** 复核；一次性真实 ComfyUI **30 项通过**，含存放页、Source 路径、选择器和隐藏 Subclass 编辑。实际 8190 新库/API及五组文档 **20 次编译**、两组固定 LoRA 绑定另 **2 次编译**通过；已有工作流/settings 与正式个人库逻辑摘要不变。没有采样。

### 2026-10-11：Folder / Class / Block 分离

- Folder 只容纳 Folder / Class / saved Block；Class 只容纳 Subclass / Tag。Class 沿用旧池编辑、观察基线、自动收录和祖先链去重；散装 tag 查重不包含候选 Block 内容。每个 Block 仍只有一个 meta.pool，稳定 ID 和 Document v2 不变，compiler 不读库。
- candidates 按 Class 树列 prompt，并反查 assets 中顶层保存 Block 的 snapshot.meta.pool；不按 parent_id 找组合，不收工作流临时块、内嵌投影或引用边。exclude_block 按 owner ID 排除正在编辑的来源。加入仍用 EnableCandidate / InsertLibraryBlock，快照复制、关闭项、来源标记和 Content / Pool 行为沿用。
- save_class / class_block 复用原存储/池函数；folder_block 保留 API alias，仅 Class 可用。complete/all_classes 仅索引 Class 散装 prompt，保留多所属 L 与补全开关，不把绑定组合的词伪装成 Class 散装 prompt。
- asset_icons.js 集中 Folder 原文件夹 / Class 叠层 / Block 立方体图标。FolderPage 内部宿主名称保留，按 asset.kind 显示整理页或 Class 编辑页；tabs / openFolder / data-open-folder 宿主兼容名保留，不复制编辑器。handle / Source 路径补全 / 绑定选择器只提供 Class（保存 Block 仍可展开）。同类型空链才压缩，不跨 Folder/Class 边界。
- LoRA 触发词根和分组改为 Class/Subclass，身份、固定绑定、浏览器隐藏规则与显式导入保留。V3 import 的 group 创建 Class 和对应存放 Folder，preset 保存在 Folder 并绑定 Class；历史 V4 转换先完成旧快照展开，再显式执行类型分离。
- library_structure.version：新库 2；旧非空 Folder 池库 1。SchemaOp 只扩展 assets CHECK 支持 class，单事务替换表，保留数据/索引并核对 FK，不自动改资产类型。旧库 save_class/ensure_lora 及 V3 import 提示先转换。
- structure_plan 为只读预览；separate_types 经 WriteQueue / revision guard 执行，开始持有写锁后用另一只读连接在线备份已提交 WAL，随后一事务转换。已知 prompt / autocomplete / pool 绑定 / LoRA 身份及祖先成为 Class，原 ID 保留；无池内容的整理目录保留 Folder。根 Class 外加同名 Folder，存储子目录及 Block 分离到对应 Folder，快照不改。仅保存到外部 workflow 的未知空池绑定无法从本库推断；当前预览不可人工追加 Class ID，存在这类池时应先扩展明确映射入口再转换。个人库转换必须有明确请求。
- t83 覆盖 storage/binding 独立、反向候选、子 Class、contained 子块不独立、来源自身排除、去重、放置/名称/环、显式备份转换与原 CHECK 升级；t74/t75/t76/t77/t80 和 Node suites 更新为 Class 契约。以下 2026-10-08/10 的 Folder 池说明保留为历史阶段记录，冲突以本节和更新后的 README 为准。
- 本轮完整离线 **937 passed / 3 skipped in 41.84s**（开发 Python 缺 torch / PyAV），包括 t72 的 13 个 Node suites。一次性真实 ComfyUI 的 plv4_class_browser_check **25 项通过**；原生编辑浏览器回归通过，覆盖焦点、Source blur、Settings 重绘、D/G/L、LoRA 独立开关及窗口顺序。Python / ESM / CJS 语法与 diff --check 通过；未加载真实模型或采样。
- 个人库只读在线备份后的副本预演：54 旧 Folder → 41 Folder / 52 Class，608 Tag / 45 Block / 5 Document 保留，全部 Block/Document JSON 快照不变；45 Block × 2 seed × couple/mask 共 **180 次编译对照一致**。备份、报告与截图在本机 .codex-backups/plv4-class-upgrade-20261011-144413。正式数据库未转换，正式 8188 未重启，8190 持久实例未操作。

### 2026-10-11：PLV3 退役准备，第一步后端解耦

退役清单与验收：[plv3_retirement_plan.md](../plv3_retirement_plan.md)。本次仅准备，V3 独立 Editor / Library 和兼容节点仍启用；PLv3 语言仍是 V4 Source / compiler 的共享语言。

- 根初始化独立启动 V4，再启动 V3；V3 数据库 setup 失败不阻断 V4。V4 setup 自己注册 Document / Library / LoRA，不再由 V3 setup / routes 间接注册。
- `prompt_shared/routes.py` 统一注册 Monaco，保留 `/xyz/plv3/monaco/` 及 route name，按 server 去重。V3 独立使用和两种 setup 顺序兼容。
- `prompt_shared/node_schema.py` 统一 sockets / widgets；V4 不再继承 V3 执行基类。V3 与 V4 分别保留缓存和执行策略，组 seed / 节点 seed、doc fallback、LoRA 与非法 draft 语义不改。
- 剩余 frontend host / completion、语言核心、WriteQueue / SQLite 与旧 UI 依赖明确记录，不能直接删除 `prompt_library_v3/` 或 `js/plv3/`。本轮未改前端、个人数据或运行实例。
- t82 在临时库和真实 aiohttp 上覆盖独立 V4 的 Document / Library / LoRA / Monaco、重复注册、V3-first / V4-first、真实根初始化遭遇 V3 setup 故障；定向含现有 V3 / V4 节点与路由 **43 passed**。完整离线回归 **913 passed / 3 skipped in 61.08s**（开发解释器缺 torch / PyAV），12 Python syntax 与 diff --check 通过；两代节点 schema 与已发布 HEAD 精确一致。未运行真实 ComfyUI 浏览器或采样，前端未修改。

### 2026-10-11 后续：V3 产品入口退役

- 根启动不再调用 V3 setup；V4 setup 与根兜底都使用 `prompt_shared/language_routes.py`，保留旧 compile / ast / doc URLs 和 Monaco URL，仅提供无状态共享服务。V3 Library routes 不注册、DB 不打开、旧 writer 不启动。历史 setup / Library adapter 保留供显式工具调用。
- `prompt_shared/language/` 接管 lexer / parser / diagnostics / Document / AST JSON / validate / IR / compile，原实现逐文件搬迁，语义不变；V3 旧模块通过 `sys.modules` 别名指向同一模块，保持类身份和 monkeypatch 一致。V4 `_v3.py` / LoRA 触发词直接引用共享语言。`prompt_shared/storage.py` 接管 PRAGMA / connections / WriteQueue，V3 旧导出兼容、V4 直接引用；共享模块无 Library 生命周期。
- `js/prompt_shared/node_host.js` 提供四种节点按钮、隐藏 doc 和嵌入 Monaco；V3/V4 entry 同时加载也只注册一次。继续使用同一个 `js/plv3/editor_core.js` / text_editing / grammar / TagAC。取消旧 Library补全、blur-sync 和“保存为库组”动作，保留 V4 Folder 补全及展开。
- V3 独立 Tools 菜单和 `window.plv3` 已撤下，V3 节点标为 DEPRECATED 并保留全部 workflow identity、sockets、widgets、execute / cache 规则。加载未经 V4 编辑的 V3 节点仍走原政策；显式在 V4 打开时保留 ID / enabled 并采用 V4 政策。Monaco 模型和新版编辑事件使用节点对象，避免跨 workflow 重用数字 ID 串写。
- 一次性 real-Comfy fixture 不再创建 V3 DB 或服务；`plv3_retirement_browser_check.cjs` 验证四种节点按钮、嵌入/窗口模型一致、关闭项、Undo、Preview、V4 路径补全、草稿、LoRA Send、workflow reload 与请求记录。旧共享前端文件名和历史 V3 adapters 保留，不能直接删除两个 V3 目录。个人数据和持久 8190 均不参与验收。
- 验证：完整离线 **927 passed / 3 skipped in 59.71s**（开发解释器缺 torch / PyAV）；t82 覆盖 V4 单独启动、旧服务从不初始化、两种注册顺序、11 个语言模块 alias identity、共享存储 identity 及纯 V4 import 不载入 V3 产品模块。11 个搬迁实现与发布 HEAD 逐字一致（仅归一化换行）。真实 ComfyUI 退役 **34 项**、Header 鼠标菜单 **25 项**通过；原生 focus、Source 草稿/结构、Schedule/Library 补全、D/G/L 合并、LoRA 语法、窗口层级/设置及 IME Shift 默认通过。浏览器套件的合并候选检查改为等待异步完成，保留所有 badge 断言。
- ComfyUI Python 补跑量化 hook **2 tests OK**；实际 Prompt Control 解析/编码配合 synthetic CLIP 的 AVG / pooled / scheduled Region / LoRA 检查通过，未加载模型或采样。44 Python / 12 ESM 语法和 diff --check 通过。正式 V3 源库逻辑 SHA 保持 `32ed3e978f82aa35bae1201736679388539efced83569e6859cd381abe475529`，V4 仍为 53 Folder / 608 tag / 45 Block / 5 Document；未写个人数据、重启正式实例或提交推送。
- 原生编辑 suite 最终在新的 `plv3-retirement-edit-check-20261011-124829` 临时库独立复核并全部通过；脚本启动等待覆盖 ComfyUI 初次 workflow restoration，D/G/L 合并等待有上限的异步完成。复用已经多次新增 Catalog 的旧 fixture 曾出现候选 / Folder chooser 时序失败，不把这种重试库作为最终验收基线。两个一次性实例和所有独立浏览器均已关闭；两份修改的 CJS 语法检查通过。

### 2026-10-09 后续：特殊容器创建和 entry 边界

- Header 不增加控件：原同级 / 子级按钮仍创建普通 Block；既有更多菜单用悬停二级菜单按同级 / 子级提供普通 Block 和 Schedule / Region / AVG 容器，Library 根不提供同级操作，区域祖先内不提供 Region 容器。
- `InsertBlock {form: schedule|region}` 原子创建默认容器。Schedule 两个空阶段 0–0.5 / 0.5–1；Region 四个空区域 Base / Mask 1 / Mask 2 / Fill，矩形默认左右半图。名称只在 metadata，创建后定位第一项正文，复用同一 history。
- `InsertEntry` 是新建空 entry 的独立命令，只接受特殊容器父级和显式 entry 参数，不接受 text / snapshot / form。普通及 Library 插入命令不能通过 entry 参数把外部内容转换到第一层。
- `MoveBlock` 的 entry 只能同父排序。Schedule 继续保留时间槽，Region 继续保留区域声明；原同父拖拽交互不改。外部 Block / Folder 副本只能进入 entry 正文；正文内普通 subblock 可移出。前端命中 / 预览与后端拒绝同时约束，Source 的 Library 拖入也禁止容器第一层。
- entry 不单独保存：更多菜单不显示 Save，保存入口提前拒绝；assets 原有快照校验仍保留。完整容器和正文普通 subblock 可保存。Content / Pool 的添加入口不绕过容器边界。
- Source 语言、普通 Block 的 Schedule / Region 属性、全局 fill 语义和个人数据不变；特殊容器入口与后续 LoRA / AVG 功能一并纳入 2026-10-10 收尾发布。
- Header 更多菜单的“添加同级 Block / 添加子 Block”悬停立即展开，移动到子菜单保持展开，切换分组关闭上一组；右侧空间不足向左打开，垂直位置约束在 viewport 内。ui.menu 的 tuple 第二项可为子菜单列表，普通 action / 分组 / 分隔线仍兼容；选叶子动作或点击外侧关闭整组，Escape 关闭并恢复触发按钮焦点，ArrowRight / Left 可进出子菜单。
- 正文聚焦时，Header 更多按钮在左键 pointerdown 保留输入焦点，click 打开菜单后再 blur 提交。否则 finishInline 的重绘会在按下和松开之间移除按钮，吞掉第一次 click。菜单回归必须用实际 pointer 按下 / 松开覆盖添加后的自动聚焦和未提交正文，不能先 blur 或只用 DOM `.click()`。

## 模块与路由

### 2026-10-10：原生输入、共享补全和窗口顺序

- `native_completion.js` 是 PLv3 `complete.js` 的文本模型适配，不另建 parser；复用 brace stack、Region slot 检查、Library snapshot 展开。V4 Schedule/Region snippet 使用当前 2/4 默认项，V3 snippet 不变。Run 在 blur 后投影结构；非法草稿不销毁输入宿主。外部文本 rebase 保留焦点书签，历史/加载仍按既有策略。
- Details 异步 Pool mount 遇到当前 session/owner 内聚焦字段，延至 blur；最新 token 和字段 listener 防止旧 mount 删除输入草稿。整块选择聚焦正文但保留块 selection；Shift 只隔离 Comfy 页面快捷键，不 preventDefault。TagAC 原生和 Monaco composition 不接管 IME Enter。
- Library `read('complete', all_folders=True)` 是只读所属 Folder 索引，独立于 enabled-only completion cache；前端只从开启 autocomplete 的 Folder 添加独立候选，同时向 D/G 匹配补充所有所属 Folder 的 L。D/G 展示字段优先，Library-only 使用 path，无合成 D/G 预览。多所属关系通过 L 选择目标，不插入文字。
- `js/lora_completion.js` 复用 TagAC native/Monaco adapter，调用 POST `/xyz/plv4/loras/complete` 只读文件索引，不读 sidecar/hash/触发词、不创建池；排除 shadowed 和不可表示名称。默认权重 1，名称替换保留已有 strength，5 秒查询缓存，版本/值/光标守卫拒绝迟到弹窗。
- `xyzAcSettings` 保留旧 enabled 作为 dataset 开关，新增 sourceCompletion / loraCompletion / libraryCompletion，默认开启；Source 的两个 Monaco provider 和原生 adapter 都遵守开关。关闭 LoRA 不发索引请求。设置保存清理补全弹层。
- theme `registerWindow` 统一 makeWindow / XYZ Settings 激活顺序，pointerdown capture 和 focusin 置顶；紧凑 z-index 保持窗口在菜单、预览和对话框下方。
- 实际 ComfyUI disposable fixture 覆盖正文/绑定/保存/Monaco 节点输入与 Delete、Settings 异步重绘、Source blur/非法恢复、Library 展开、D/G/L 合并与多 Folder 跳转、Shift 默认、LoRA 独立开关和三个窗口顺序。系统 IME 实际语言切换仍需用户本机验收。另通过现有 66 项 LoRA fixture 检查。8190 为长期用户实例，不用于自动写入测试。

### 2026-10-10：独立 LoRA 浏览器

- 设计与验收：[lora_browser_plan.md](../lora_browser_plan.md)。LoRA 是带 metadata 的 Block 子类型，不增加资产类型、Document 版本或 Library schema。
- `loras.py` / `lora_routes.py` 注册 POST `/xyz/plv4/loras/{list,detail,send,fetch}` 和 GET `image/{id}/{index}`。全部扫描、资料读取、hash、网络及图片定位在线程执行；只使用服务端索引 ID，图片验证真实路径在已配置根内。根和扩展来自 `folder_paths`，支持配置变化、搜索分页、损坏 sidecar、同相对路径优先顺序。媒体只读，外部图片限制 Civitai HTTPS 主机。
- 本地模型旁 `.metadata.json` / `.civitai.info` 和同 stem 图片优先；无 plugin 导入 / 事件 hook。显式按 SHA256 请求 Civitai 官方 `/api/v1/model-versions/by-hash`，资料缓存在库旁 `lora-metadata/`，浏览跳转固定 civitai.red。外部 API 说明见 [Civitai 官方文档入口](https://developer.civitai.com/site/reference)。LoRA Manager 的集中 sidecar / 私有图片目录不自动发现。
- `ensure_lora` 经既有 WriteQueue 原子创建带 `data.lora` 身份的 Folder 和初始触发词；只在首次编辑 / Send 时调用，已有池不恢复删掉的 tag。显式 `import_triggers` 才追加；改 Folder 设置保留身份。树投影 `lora_root` 隐藏普通 Library 中的入口，Pool 仍使用完整资产数据。Browser 的 FolderPage 复用现有编辑器及数据事务。
- `lora_triggers.py` 优先保留 Civitai / sidecar `trainedWords` 数组的作者条目边界，再用共享 PLv3 parser 解析内部 tag/attention；**不要求条目共享词**。多个条目中有复合提示词 / 多项 attention / 长描述时分别建 Folder；仅短原子 tag 数组仍平铺。顶层 `,,` 是兼容旧拼接资料的 fallback，literal / attention / angle token 内不拆。每套完整词和权重在兄弟子 Folder 中存储，局部去重，不传播其他条目到各组合。角色 heading / attention 首项用于默认名称，之后服装 cue / 编号；仅命名、不重写提示词。`data.lora_trigger_group` 模型 ID + 原组合规范词集 hash 保持身份，显式重复导入保留改名，自定义同名 Folder 数字后缀避让。详情逐条展示原 metadata，不再 join(', ') 破坏视觉边界。
- 默认 Send / 展开仍不改已有池。明确修正旧平铺池时 `ensure_lora.regroup_existing` 仅归类本层现存、仍与 metadata 匹配的 loose tag；删除 / 改写的原词不会恢复，已有生成组合的池跳过。既有 `add_tag` 向下归类保留 ID，重复词只在兄弟 Folder 复制。手动工具 `test/manual/plv4_regroup_lora_pools.py` 默认只读规划，--apply 必须指定不存在的 --snapshot JSON 文件，经运行实例 WriteQueue 写入，不读写模型 / 第三方 sidecar。
- `InsertLora` 默认根末尾、按模型 ID 复用已有实例，启用关闭祖先；`SetLoraStrength` 改真实首项引用。`meta.lora` 绑定 `relative` 和模型身份；首项 `meta.lora_invocation` 是固定调用，禁止单项开关 / 删除 / 正文编辑 / 分组，不收录到触发词池。Source 移除 / 改成其他调用解除特殊身份；Library 快照复制保留。Source 只有语法，独立复制不能携带专用身份。
- `lora_block.py` 对齐调用与 metadata；Blocks / Content / 折叠正文隐藏固定项，Details 专用权重栏默认展开。调用之外的实际 children 仍是原树，不为 UI 新增随机容器。
- `design_adapter.blockFrame` 根据已校验的 `meta.lora` 显示 LoRA 类型，复用 Schedule / Region 的 `.block-type` 标签与 special 卡片规则；LoRA 使用淡紫色 token 和顶层底色，不增加 header 操作按钮。身份标签与 Schedule / Region 属性标签可共存，折叠、关闭、Library 保存 Block 都沿用同一模板。
- Header 的 Folder icon / 同样式名称标签调用既有 openFolder，设置栏名称旁有独立打开按钮；LoRA 类型标签与设置按钮经 openLoraDetails 提交正文后打开对应模型。Header cache 纳入 Folder 名称 / 路径，Library reload 更新可见绑定；有绑定的节点在 Library 隐藏时也读取资产显示名称。LoRA 固定绑定放 LoRA 区，不提供通用绑定菜单 / 选择器；SetMetadata 拒绝更换和解除。Schedule / Region 容器 UI 与 SetMetadata 拒绝绑定；model.normalise_metadata 清理旧容器绑定，snapshot 校验 / bind_paths / observe 保持同一规则，保留 entry / 正文绑定、内容、ID 和关闭状态。无个人数据库批量迁移。
- V3 IR 增加 **默认关闭** 的 `centralize_loras`：Part 携带调用语法节点身份、引用文字和有效区间，在每一层的原随机决定中一起流转；按来源节点+区间去除 ambient 复制，保留不同语法节点的显式重复。只集中 `<lora:...>`，其他尖括号语法不动。特殊 Block 位置由 enabled Document / AST 配对提供，首调用不参加该 Block 的随机选择。Schedule 交集随 Part 保存，最后统一输出；没有文本也能输出纯 LoRA。
- V4 节点及被 V4 编辑的 V3 文档采用该策略；未编辑 V3 默认保持原输出。专用身份影响自身随机语义，所以执行缓存含特殊 Block 的源码位置；名称 / Pool 等其他 metadata 不影响执行。编译不读取模型目录 / Library / 浏览器缓存。
- `lora_browser.js` 独立窗口、卡片 Send、多图详情、节点选择及触发词 Folder。Send 捕获节点对象、graph 和 workflow epoch；串行并复查，避免异步期间 graph restore 重用对象写错 workflow。复用 NodeSessions / DocumentSession，一次插入一个 history。
- 详情里的触发词 Folder 使用默认折叠的原生 details/summary，首次展开才 ensure / 读取池；折叠保留 FolderPage 与设置历史，切换模型 / 重开详情通过 token 丢弃旧加载。导入入口在展开区内，复用原 Page 保持设置撤销。FolderPage 可选 onFolderRender hook 为浏览器排列两行控件：名称独立一行，补全与撤销/重做同一行，编辑重绘后仍保留布局与历史。仅浏览器覆盖 padding / 行高，不改变主 Library 布局。
- 验证：t80 模型 / 元数据 / 路径 / pool / compiler / snapshot，t72 新 Node suite 覆盖卡片 Send / 并发 / 节点失效。`test/manual/plv4_lora_fixture.py` 只创建临时库和合成模型，`plv4_lora_browser_check.cjs` 使用独立 headless Chrome，实际 DOM 和真实 API 覆盖 20 项；不操作 ComfyUI 进程或个人数据。外部 Civitai 联网和实际采样仍未实测。
- 最终完整离线回归：**855 passed / 3 skipped**（缺 torch / PyAV），之后默认节点选择由新 Node suite **7 passed** 复核；9 个修改的 ESM 语法检查和 `git diff --check` 通过。测试窗口和临时服务已关闭。
- 后续 Folder / LoRA 导航与绑定规则验收：完整离线 **872 passed / 3 skipped**（同上依赖），独立真实浏览器 **54 项**覆盖按钮跳转、同一 Folder 标签页、固定绑定、容器隐藏入口、entry 独立绑定、改名刷新及缺失 Folder。六个修改 ESM 语法通过；运行实例通过 stateless document API 复核容器与 LoRA 绑定拒绝，不改 workflow 或 Library 数据。
- 同日 settings 调整：blockHTML 将类型标签与属性标签分开，类型前置、Schedule / Region 参数跟在名称后。容器 Details 仅保留 Enable / Weight 等结构设置，隐藏 Shuffle / Format / RANDOM；SetSettings 拒绝容器新写上述选项，允许 null 清理，已有 Source 的语言 / 编译语义不变。Format 与随机仍沿用 PLv3 的 direct-children Part 语义；没有修改 IR。randomSelect 两个 number 控件校验非负安全整数及 a≤b，半填 / 非法范围不提交，两框空为 null、0/0 保留。dropout 原生 range 的 input 仅更新读数，change 写一次 history。ui.input 对 range 使用数字、min/max/step，并在设置范围后赋 value，避免原生默认 step=1 抹掉小数。完整离线 **880 passed / 3 skipped**，实际浏览器 **66 项**通过。

| 模块 | 当前职责 |
|---|---|
| model.py / commands.py | EditorState、Document v2、稳定 ID、projection、revision 校验及原位命令 |
| formatting.py | 新结构的局部格式化，普通编辑和开关不能触发全文排版 |
| _v3.py / compiler.py / node.py | 复用 PLv3 解析/编译，V4 节点 seed 策略与 prompt/plain |
| ../prompt_shared/ | 两代节点 schema、共享纯语言/编译、stateless routes / Monaco、通用 WriteQueue；不初始化 V3 Library |
| assets.py / hierarchy.py | SQLite 资产、快照、路径、名称唯一、版本冲突、pool observation、收录和祖先链去重 |
| setup.py / asset_routes.py | 独立库生命周期、Library 适配；阻塞操作移到线程 |
| migrate_v3.py / migrate_v4.py | V3 备份导入、旧实验 V4 新副本转换 |
| js/plv4/document_session.js | 串行命令、同一撤销历史、旧异步写入失效 |
| host_sessions.js / prompt_editor_binding.js | 节点对象身份、Library 会话、隐藏 doc 与共享 Monaco 模型 |
| window.js / history_shortcuts.js | 标签/视图、输入提交、跨视图历史与 workflow undo 隔离 |
| block_view.js / text_input.js / prompt_text.js | native TextRun、DOM 读值/选区、语法展示与 UTF-16 映射 |
| block_find.js / js/plv3/text_editing.js | 可见 prompt 搜索范围、借用 Monaco Find、跳转与高亮 |
| details.js / folder_page.js / library_panel.js | Content/Pool、Folder tag 编辑、Library 树/副本操作 |
| folder_tree.js / library_preview.js / drop_preview.js | 空目录链压缩、紧凑预览、层级明确的插入预览 |
| design.css / design_components.js / design_adapter.js | 共用正式样式/控件，Node 与 Library Block 同一界面 |
| completion.js / inline_input.js / js/tagac_host.js | Folder 候选补全、native 与 Monaco 共用 TagAC |

文档路由都是 POST：`/xyz/plv4/document/open`、`command`、`compile`。请求携带完整 state，命令携带 revision；服务端不持有浏览器撤销栈。非法请求与语法错误返回明确错误，过期 revision 拒绝应用。

Library 路由为 POST `/xyz/plv4/library/read`、`mutate`、`migrate`；读 action 包括 tree、expand、candidates、complete，写操作包含 folder/tag/block/document 保存、移动/删除、观察/收录及副本保存。所有数据库写入经 WriteQueue 单写者，同一事务校验名称、层级、散装 tag 和快照；失败不留下半次收录或移动。

## Document 和编译边界

1. Document 是真相。Document v2 继续兼容 v1，保存每项 ID、enabled、结构及元数据。Source 是 enabled 投影；关闭项原位保留，不能从 Source 缺席推断为应删除。
2. 非法草稿原文保留，strict 节点执行必须报错，不能退回旧树运行。恢复模式仅供编辑诊断。
3. pool、来源和展示名称随 Document 保存，不参与语法编译。LoRA block 身份用于保护调用的随机语义，真实引用和强度仍在语法里。Library 不存在时已有 workflow 仍能编译。
4. V4 全部随机使用已解析的节点 seed，忽略组 seed。V3 未改动文档保留默认组 seed；经 V4 编辑且带 compiler=plv4 元数据的 V3 节点使用 V4 策略。
5. prompt/plain 仍调用同一个 PLv3 编译器。Region ambient/include_in_base、mask/couple、Schedule 区间及 dropout → random_select → shuffle 顺序保持。V4 LoRA 引用集中输出并去除区域复制，专用 Block 首调用保留；普通 V3 的默认行为不变。
6. 不为了 UI 占位增加 Group，避免改变随机单位。移动/分组后以新语法树为编译基准，不保证等于操作前随机结果。
7. Region 子项头和 Schedule 共享边界不全在普通 node span 内，沿用已有 span/命令处理，不能只切 body。
8. Preview 解析链接 seed 时共享 graphToPrompt promise，callback 用 resolvingInputs 阻止递归。后端计算型输入无法离线解析时明确报告，不能猜 seed。

## Folder 池和副本

一个 Block 最多有一个 `meta.pool`，子项不继承候选列表。Folder 内为散装 tag、保存 Block 和子 Folder；嵌入 subblock 是 owning snapshot 内的真实子树，不是独立指针。稳定来源 ID 与版本用于显式更新/覆盖，完整路径用于展示和 Source 标签。

同一父 Folder 的 Folder/Block，以及同一 Block 的 subblock，名称唯一；不同父级允许同名。新增、重命名、移动和保存冲突均拒绝并回滚。未命名 subblock 保存时获唯一默认名；迁移中的显式消歧保留原内容和 ID。不能靠首次路径匹配掩盖重名。

自动收录只收 tag，且只增不减。在完成输入后提交，写到绑定本层；递归经过未绑定子 Block，遇到自有 pool 的子 Block 停止。查重扫描整棵绑定子树，含保存 Block 内关闭 tag。打开 workflow、载入 Document、Undo/Redo 只建立 observation 基线，不恢复用户手工删掉的池 tag。

散装 tag 的相同祖先链不能重复：添加到子 Folder 时从祖先移下；子孙已有时父 Folder 添加拒绝；不同分支可重复；保存 Block 内容不受此约束。Folder 移动造成祖先链冲突时事务拒绝，非空删除保持保守拒绝。Library tag 身份是原子文本身份，不与候选展示匹配混为一谈。

Content/Pool 分离是最终方案，早期合并单区设计作废：

- Content 始终按实际顺序递归编辑，关闭项原位灰显，× 仅删当前副本。
- Pool 的 ＋ 追加到 Content 末尾；已有项一直标记“已添加”，关闭也算，不重新启用、不移动、不切换详情对象。
- prompt 候选匹配忽略外层 Weight/Schedule，并按展示统一空格/下划线；Block 按来源 ID 匹配。扫描未绑定子树，遇到其他池绑定停止。这只是加入状态和防重复，不改变库的 tag 去重。
- 保存 Block 候选后代仅可折叠只读预览；加入后从 Content 编辑。poolPending 串行提交 ＋，在提交时重读 projection，防连续点击同文候选产生重复。
- 类型筛选与未使用筛选独立；全部展开/折叠、滚动和筛选按文档/目标保留。
- 子 Folder ＋ subblock：绑定该层，填充本层散装 tag，默认 enabled，不自动保存。Folder 插入 handle 则创建空的绑定 Block；不再拖入直接改目标绑定。
- Folder 灰色目录，Block 立方体/蓝色框，Prompt 标签/轻量竖排；加入状态统一绿色侧标与徽标，不区分已添加项的启停。

## 窗口、输入和搜索的易错点

### 2026-10-10：Blocks 逗号、回车与空行删除

- 正文使用浏览器 `contenteditable="plaintext-only"`。不要重新加入 Enter / Backspace / Delete 的 `beforeinput` 拦截、人工选区回设或 input 后的 DOM 占位修补；这些逻辑在逗号分隔处与带样式的粘贴正文中会干扰浏览器的光标归属。曾经的 136 / 198 项检查漏掉了逗号后、分隔空格后与空行删除，不能作为该问题已解决的证据。
- 空拖放 marker 在聚焦和失焦时都不参与排版，否则非编辑 span 会将分隔符两侧变成两个浏览器编辑区域，产生额外换行。DropPreview 暂时恢复 marker 排版，结束时恢复编辑状态；关闭的 prompt 仍保留原位、排除在源码和光标映射外。
- Chromium 在最终空行后维护一个显示用换行；`text_input.js` 的值和偏移映射排除它，初始 render 用相同的纯文本终止符，不插入人工 BR。用户键入时只读取 DOM、排队更新 Document，不改变选区或 DOM。renderInlineEnd 只用于初次显示。
- `runEnd` 保留尾部逗号和空白，只去掉闭括号的一条结构布局换行。TagAC 仅允许当前宿主消费 Enter，同 DOM 更换 RunSession 时丢弃旧候选。无效的 Pool 候选静默拒绝并放行 Enter，不再弹出“请在一条完整 prompt 上使用 池补全”。有效补全仍走 CompleteLibrary 与共享历史。
- `plv4_separator_browser_check.cjs` 使用独立 Chrome + 真实后端，检查文字、逻辑偏移、红色 caret 截图及续写，覆盖 `1girl, 2girls` 逗号后 / 空格后、行中文字、用户截图形状、连续空行、重开后的单次 Backspace、向前 Delete、粘贴尾部换行、Undo / Redo 和三种容器 entry。`PLV4_REPRO_ONLY=1 PLV4_SCREENSHOT_REPRO=1 PLV4_PASTE_REPRO=1` 可跑截图和粘贴定向检查；真实 Comfy fixture 准备和启动使用相同 PLV4_FIXTURE_ROOT。仅使用 disposable fixture，不操作持久 8190 的 Library / workflow。
- 临时 input_trace 已完全移除，诊断服务和输入记录已清理，不要求用户再配合捕获。浏览器验证记录及运行实例同步见本地 HANDOFF。
- 空正文与已解析 TextRun 共享 13px 字号、正文色、行高和 padding；只让空输入的 placeholder 灰显。不要用 :focus 改变 marker 的 display，否则每次聚焦都会改变正文缩进和 tag 之间的距离。`plv4_input_layout_browser_check.cjs` 测量第一次键入、blur 重绘以及反复聚焦前后的每个可见字符几何与实际字体 / 颜色，允许小于 0.1px 的浏览器字形舍入差异。

Library 仅显示 Folder/Block/subblock，散装 tag 隐藏于树但搜索可定位其 Folder。Folder 页只编辑本层和子 Folder 的散装 tag，不显示保存/绑定 Block 列表。Library Block 复用 Node 的完整 Blocks 编辑器，中性主题；预览为连续逗号文本、自动换行、限制高度，不为每项显示路径。

单击 Folder/Block 共用一个临时斜体标签；编辑、双击条目或标签固定。切换请求串行并先 flush；不能将未提交草稿替换掉。浏览、定位和视图切换不固定。保留树行/标签 DOM，否则重绘会吞掉双击。

Library/Pool 的空单子 Folder 链压缩只看实际数据：本层有任何 tag/Block 都阻止合并，不能用过滤后可见项判空。只改展示，不改 ID/路径/绑定；各段名称可操作，handle/预览及子 Block 按钮作用于末端 Folder。树行用连续祖先引导线，不只留空白缩进。

连续文本段共用 native RunSession。装饰 marker 必须 contenteditable=false，DOM 文本/选区映射排除装饰。用 break-spaces 保留空格；中文逗号仅在用户输入提交时清理，保护 literal、LoRA、路径和 .set，随后由 PLv3 解析拆条。首尾逗号不存入原子 tag，句号分隔保留句号。禁止打开库自动清洗历史数据。

尾部原生显示换行不计入正文/光标；runEnd 只去掉一条结构性闭括号布局换行，不吞用户尾部换行。Enter、Backspace、Delete 均由浏览器原生编辑，不手动改正文或选区；粘贴只接收纯文本。SetEnabled 不允许根据 _layout_indent 触发整段格式化，必须保留空行。queued write 在父队列内再次检查有效性；Undo/dispose 使旧任务失效，flush 排空字段队列。

Blocks 借用原 PromptEditor 的 Monaco Find controller/widget，不创建第二个编辑器。借用时 removeOverlayWidget 解除 Source 登记，退出时重新登记/布局，防 Source 重建把搜索框收走。Source 零宽会附 hiddenEditor；CSS 仅覆盖可见 Blocks 搜索宿主。Monaco 是 vendored 0.52.2，私有 contribution 接口升级须复核。

block_find 仅建立可见 prompt 字符的逐行源码范围；不包含 Region/Schedule 声明、.set 或其他隐藏字段。多行范围会被 Monaco 扩为整行，必须分行。空范围用零长度 sentinel，不能传 []（会成为全文搜索）。更新、聚焦和范围变更都强制同步；离开 Blocks 恢复 Source 原范围并隐藏借用时的范围开关。

查询框 Enter/Shift+Enter 调用与下/上箭头完全相同的 Monaco editor action。CSS Custom Highlight 把 source match 映射回 native Range，搜索框保持焦点时结果仍可见；无支持时回退 native selection。零结果、关闭、dispose、标签/视图切换均清理高亮。用户提供的 Region/Schedule 原稿搜 cl，Blocks 有 3 个 prompt 命中，不能计入 include_in_base。

所有详情权重含 Region mask/cond 都用 − / 输入 / ＋，步长 .05。Region 父级列出每个 Region 子项设置；Region/Schedule 区默认展开，尊重后续手动折叠。开关、编辑、加入后保留设置对象和滚动位置。

## 迁移与样例

### V3 导入

Library 菜单显式确认后调用 migrate_v3.migrate。只读原库，SQLite backup 包含已提交 WAL，备份存到目标库旁 backups。来源路径和备份摘要防重复：同一快照重复导入返回已有报告；已导入来源变动拒绝继续混入，需新库副本核对。

| 旧模型 | 当前映射 |
|---|---|
| group | Folder |
| 子 group/ref | 真实包含的子 Folder |
| 原子 items | 本层散装 tag |
| preset | Folder 下保存的完整 Block |
| preset 内 ref/snapshot | 展开的包含副本 |
| group 自身 settings | 额外“全部内容”Block；无设置不制造默认 Block |
| saved documents | 独立完整 Document，含关闭项 |

导入内置 seed 42、couple/mask × plain 的编译核对，使用 V4 节点 seed 策略。migrate_v3 是库/API，不提供独立模块 CLI。

### 早期实验 V4 副本转换

`python -m prompt_library_v4.migrate_v4 SOURCE TARGET`；TARGET 必须不存在且不同于 SOURCE。源库只读，默认运行新库是 prompt_library_v4_data/plv4-pools.db，旧 plv4.db 从不隐式升级。

Folder/Class → Folder；string attribute → tag；block attribute / 内部指针 → 包含快照；Class attribute → 真正子 Folder；belong → 单个 pool；多个 load → 各绑池的临时子 Block。仅转换器识别旧术语，不恢复运行模型。多个 load 拆成子 Block 会改变旧随机树单位，不能宣称对任意旧文档随机等价，需按具体副本核对。

### 隔离示例

test/manual/seed_xyz_test_samples.py 只转换独立测试根目录的库/workflow，新副本和报告不覆盖原件。update_xyz_pool_examples.py 拒绝其他 root，先备份转换后库、workflow/manifest 到 pool-example-backups，再修整重名并追加池绑定示例；保留 ID、关闭项和用户修改，来源按 ID 更新。当前示例包含父池、独立绑定/未绑定子 Block 和关闭项。prepare_xyz_test_comfy.py 的 tag 数据备份保留 WAL，不替换已有非空测试库。

旧 Class-era manual browser scripts 和原型仅作本地历史保留，不是当前验收入口。不得用其重建示例。个人 V2/V3/V4 库均未迁移；本次收束没有运行迁移或改写样例原件。

## 验证与后续边界

### 2026-10-10 收尾与正式安装

用户确认 LoRA / AVG 和正文、样式、菜单后续修复完成；本轮更新 README、工程记录并随代码发布。后续按新发现的具体 bug 修复，不另起设计阶段。

- 最新全量离线回归：**909 passed / 3 skipped in 46.23s**。跳过原因是开发解释器缺 torch / PyAV；用 ComfyUI 自带 Python 补跑 t69 量化兼容 **2 passed**。
- 同一 ComfyUI Python 通过实际 Prompt Control 解析 / 编码和 ConditioningAverage 检查 AVG 比例、pooled、时间 / 区域 / LoRA 组合；使用合成 CLIP，不加载个人模型或采样。
- 最新菜单 disposable 真实 ComfyUI **25 项**通过，包含实际鼠标按下 / 松开、自动聚焦的新 Block、正文未提交时单击另一个 More，以及保存完成。此前同版本输入定向 **46 项**、样式 **40 项**、AVG 浏览器 **36 项**的结果见各回归说明；这些是独立用例，不是一个累计浏览器总数。
- 正式 ComfyUI 使用已有 `ComfyUI/custom_nodes/ComfyUI-XYZNodes` 仓库，正常 GPU / 模型 / 其他 custom nodes 配置；不使用 fixture、测试 base-directory 或 XYZNodes-only whitelist。正式 `8188/object_info` 已注册 V4 / Monaco 和 Prompt Control，**27 个**修改或新增的前端文件实际 HTTP 响应与安装源码 SHA256 一致；stateless open / compile 在 couple / mask 均可编译 AVG + LoRA，LoRA complete 路由只读检查通过。
- README 中英文、AGENTS、实施计划与 manual 测试入口统一更新。个人库不迁移、不用测试数据库覆盖正式库、不创建合成 workflow；持久 8190 验收实例保留。版本更新后重启正式 ComfyUI，浏览器 Ctrl+F5 加载前端。
- GitHub 常规代码更新使用主分支提交 / 推送。不要创建没有 TagDB 数据资产的新 latest release；不要发布本地原型、历史 Class-era 脚本或运行数据。

### 2026-10-08 Folder 池阶段记录

2026-10-08 收束离线回归：**513 pytest passed**，包含 t70–t79、10 个 Node 前端套件、t46–t62 的 PLv3 测试、t68 窗口兼容和 TagDB；ComfyUI Python 的 t69 CPU unittest **2 passed**。t69 直接核对虚拟 scale 解析，兼容不同 ComfyUI state_dict 是否枚举 sidecar。最新搜索/换行由真实 Python projection、Node 模拟宿主和 vendored Monaco 语义覆盖。38 个 Python、44 个 ESM 文件语法检查通过；维护/用户文档的本地链接逐项检查。

~~~powershell
python -m pytest test/t70_plv4_document_test.py test/t71_plv4_routes_test.py test/t72_plv4_frontend_test.py test/t73_plv4_node_test.py test/t74_plv4_assets_test.py test/t75_plv4_migration_test.py test/t76_plv4_asset_routes_test.py test/t77_plv4_hierarchy_test.py test/t78_plv4_test_tag_data_test.py test/t79_plv4_pool_examples_test.py -q
Get-Content -Raw js/plv4/window.js | node --input-type=module --check
# t69 需要真实 ComfyUI/torch 的 Python；不要求安装 pytest：
python -m unittest discover -s test -p t69_quantized_hook_compat_test.py -v
~~~

pytest.ini 限定离线 test/t*_test.py；manual 和网络诊断不属该范围。2026-10-08 收束采用离线检查；当前原生输入、样式与菜单已有 disposable 浏览器验证，见下方最新收尾记录。

用户已确认本阶段结束。未来工作仍须按具体请求处理：大文档浏览器性能、个人资料库副本迁移、旧多 load 随机结构取舍，以及更广泛的 tag 身份规范化。现有精确 tag 身份不在本轮扩展。

GitHub release 的 latest 由 TagDB 数据集下载使用；常规代码发布通过 Git 提交/推送，不创建缺少数据资产的 release。避免破坏自动下载。


## 2026-10-10：AVG Block

新增共享 Source 语法 `[@avg]: { 1: { ... }, 3: { ... } }`，Group.average / Settings.avg_weight / Spans.avg_form 保留真实头权重。Document v2 追加 avg / avg_entry form，不升级 schema；Builder / full_index / projection 把 entry 头计入自身 span，SetAvgWeight 精确替换字段并保留关闭项 / ID。More 和共享 Native / Monaco Source 补全提供两个等权空 entry。统一 badge 样式，名称后显示 Weight；容器无正文 / Pool / Random / Format，entry 无 Random / Format，不可拖拽（含内排序）或独立保存，正文可收普通 / Library subblock。父 AVG settings 可改各 entry 权重，整容器 Library 快照保留结构。

IR Part.variants 让 AVG 始终作为一个 direct child；普通 join / format / emphasis 在全量分支上运行，直到 segment 才生成累积比例 AVG 链。多个 / 嵌套混合组合局部概率，去重相同完整文字；每个区域 / 时间段最多 256 个替代。0 / disabled 忽略，enabled empty 参与，全零只保留外部内容。仅含 AVG 的文档按有效时间段渲染并重新归一化 active entry，AVG 留在一个 COUPLE / AND 操作数内。Region 在 AVG 内按有效区域并集、同 mask 合并；缺该区域的 entry 贡献 ambient。random_plan 在完整树各 segment 和潜在 implicit base 预先冻结源 child 身份，保证时间切换不重抽，尤其 timed region 消失后不能误把未规划 base 当空选择。无 AVG 文档仍走原路径。

LoRA 在 AVG 文档中也统一 provenance 去重、合并连续有效区间；保留两个显式同名调用，不复制 ambient 引用。AVG weight 仅混合 conditioning，不乘 Model / CLIP strength，不提供每分支独立模型 patch。实测本机 Prompt Control utils.safe_float 将 AVG 系数 round(...,2)：三等分累积 2/3 实际 .67，不能声称最终等权精确；未改 upstream。AVG 提示词 / pooled tensors 已用真实 ConditioningAverage 验证。

验证：全量离线 909 passed / 3 skipped（开发解释器缺 torch / PyAV），末次补充 implicit-base 边界的 t81 + t48 / t49 72 passed。独立临时 LoRA fixture / own browser session 的 23 项通过，含创建 / 权重 / undo redo / 全部 entry 边界 / 整容器 Library / 原生 Source blur，无浏览器错误，并查看实际 screenshot 对齐。ComfyUI Python 跑 test/manual/plv4_avg_promptcontrol_check.py，真实 PC schedule / region / encode 管线 + 合成微型 CLIP 验证 N-way AVG、pooled、schedule / region / LoRA 和每区域一个平均 conditioning；不载模型 / 不采样。9 生产 ESM syntax / diff --check 通过。

同日补齐 Blocks 底部创建入口：主按钮直接添加普通 Block，▾ 菜单提供普通 / Region / Schedule / AVG，空文档一致；聚焦特殊容器只添加 entry，Region entry 内排除 Region，Library wrapper 目标仍为内部唯一保存 Block。沿用 canInsertContainer / host.addBlock 和 4 / 2 / 2 默认 entry。扩充 disposable AVG 浏览器检查至 36 项，t72 的 12 个前端套件通过，ESM syntax / diff --check 通过。仅同步 block_view.js / design.css 到现有 8190，并核验实际静态响应，未重启或写入个人数据。


### 2026-10-13：Mask Library 绑定与交互修正（覆盖同日初版验收遗漏）

- 用户指出初版绑定、布局、操作入口、排序和英文标签问题；在保留并行修改的前提下仅改 Mask Library 相关代码。未操作个人数据、正式 ComfyUI 或持久 8190，未提交/推送。
- **实际绑定丢失根因**：绘制产生长浮点坐标，SetRegion 的 `_number` 写 Source 时使用 `.12g`，初版 ref.projection 留着原始浮点。精确比较把正常 Source 重读/重开或改其他设置误判为用户改坐标，移除了 meta.mask_library。现在每次解析保存真正的已解析投影，旧引用的预期坐标按同一个 writer 精度规范化；真正的 Source 坐标/kind/imask 修改仍解除引用。t84 新增普通 Block 与 Region entry 的真实精度、同文重读、其他设置、重开、旧 projection 回归，先复现失败再修复。
- **绑定界面**：四坐标只读，显示画布名/遮罩名；绑定与解除经 DetailsPane.applyCommand 重绘，Edit canvas 打开所属完整画布并选中稳定 mask ID。图片 View canvas 打开所属提取页并高亮 Alpha/RGB；解除保持矩形坐标或恢复原手动整数。更新 canvas_name 来自解析快照，不查询共享 parser/compiler。
- **手动 IMASK 漏项根因**：初版把数字 input 裸放在 region section，Region 父页面只汇集 .plv4-field 等设置行，因而漏掉它。现在有独立带 IMASK 标签的设置行，普通 Block、entry、父页都保留；min=0/step=1/required 加原生有效性校验。绑定图片后隐藏手动输入，解除恢复原整数。
- **交互与样式**：Library/Mask Library 两个 SVG icon 并入各自标题行，Mask Library 有明确标题；各画布 item 直接展示 Edit/View、Rename、Delete，图片再有 Extraction settings、Relocate，不再用操作选择下拉。新增 labels、提示和错误统一英文，原生表单对话框沿用 PLV4 tokens。矩形拖动捕获 DOM 保持固定，只显示插入线/Move here；松开跨任意多位一次提交，边缘自动滚动，Escape 可取消。新 mask 自动按 OKLab 感知距离选择未用颜色，调色板用完后生成颜色；名称取空闲 Mask n。点击名称/颜色同步坐标属性，保存期间禁用修改并显示 Saving。
- **定向验证**：ComfyUI Python/torch + 借用已装开发 pytest，t84 **20 passed**；Mask outputs/colors + DocumentSession 两个 Node 文件 **17 passed**。独立 disposable CPU ComfyUI（port 51643）+ 独立 Chrome：修复专用 **56 真实键鼠 checks**（3 类绑定、父页、图片、长列表跨屏排序、直接操作、英文界面）；原有 Mask 浏览器回归 **31 checks**（八 resize、Preview、未使用连线、共享更新、旧 sockets）；最终手动 IMASK/表单脚本另见下方结果。两次无模型真实执行均 success，验证 IMAGE/MASK 512×512、未使用零 MASK、CLIP 克隆和 append 警告。截图查看 canvas、sorting、library、rename；生产 Mask ESM/Python、CJS 与定向 whitespace 检查通过。
- **旧离线 UI 测试限制（未改并行代码）**：额外运行既有 Details/Window 两个脚本为 22 pass / 41 fail；38 个缺 DetailsPreferences 注入、2 个缺 window、1 个旧窗口 mock 缺 saveNodeButton。测试夹具未跟随现有接口；没有据此修改生产的偏好/窗口逻辑，也未扩跑全量。真实 Mask UI 场景检查 errors=[]。该记录不能被概括成“全部测试通过”。
- 新后端需要用户之后自行重启 ComfyUI；前端 Ctrl+F5。本次一次性实例根 C:/Users/XYZ/AppData/Local/Temp/xyz-mask-repair-be42d859cc7741c19bce21cc8f4454e8，PID 10356 / port 51643；代码与资产均在 scratch，Chrome 在脚本 finally 关闭。不会复制 fixture 到正式安装。

本次补查最终结果：`plv4_mask_imask_browser_check.cjs` **8 checks** 全过（非法整数不提交、父页输入、绑定隐藏/解除恢复、Rename 实际 Save）；与修复 56 / 回归 31 合计 **95 真实键鼠检查**。本轮 PID 10356 / port 51643 已按完整命令行核验并关闭；未操作其他进程。临时测试资产、截图、日志和 process.json 保留在上述 scratch。


### 2026-10-13：Region 容器功能开关（用户新增，未提交/部署）

- Settings → Region entries 顶部新增英文 Region 开关，缺省开启，与整个 Block 的 Enable 独立。关闭时保留容器/entry forms、稳定 ID、顺序、各自 enabled、所有参数和 Mask Library 引用，继续限制只能放 Region entry，不能直接写 prompt、插普通 Block 或嵌套 Region。Block badge 显示 Region · Off，entry 内容仍正常可编辑/启用。开关重绘后恢复该控件焦点，真实 Ctrl+Z/Ctrl+Y 留在 Document history；不会把键盘交回 Comfy workflow undo。
- `SetRegionEnabled` 仅允许 Region 容器和布尔值，原子改 `meta.region_enabled=false`；开启移除此标记恢复缺省。命令不重排 Source；Document、Library Block snapshot、workflow、metadata 保存开关。Source 继续保留 Region scaffold，单独复制 Source 不携带此开关。显式 Source 改成非 Region 后清理不适用的 flag。
- V4 adapter 从实际可见 AST 配对求出关闭容器的 paths，传给纯共享 `compile_text(..., bypass_region_paths=...)`。只清除目标容器直接 entry 的 Region 参数，不删 Group 或重新编号随机 paths；普通权重/Schedule/随机/有效 LoRA 保留。其余 Region 保持有效；不用 source pos 判容器，避免根和首个容器同时在 offset 0 时误清相邻 Region。
- `mask_resources.resolve` 排除功能关闭的整个 Region 子树：编译/fingerprint 不读取其图像/资源库、不挂载、不自动换号，保留原引用/坐标快照。显式绑定时仅强制解析目标 entry，保障关闭期间新绑定也有可信 projection/fallback。Inspector 仍可按库缩略图显示关闭 Region 的图片，不把它加回执行 bundle。连接过的输出标记 Unused 并保留零 MASK/原连线；开启后恢复。Window 在 SetRegionEnabled 后调用既有 resolveMasks，让关闭期间库改动在重新开启时及时刷新到 Source，不写额外 Undo。
- 验证严格定向：新增 t85 **14 cases**，加既有 t84 **20** 和共享 plain-region t61 **17**，合计 **51 passed**；DocumentSession/Mask outputs 两个 Node 文件 **17 passed**。新一次性 CPU Mask fixture + 独立 Chrome **19 真实键鼠 checks**：开关/默认/结构和 Source、关闭项与引用保留、one Undo、焦点、Ctrl+Z/Ctrl+Y、关闭重开、Source/Blocks、Unused 连线、设置图片预览、关闭期间改库与开启刷新；errors=[]。两次无模型实际执行：Region off 输出 image content / Attach count=0，on 输出 IMASK(0,1) image content / count=1，均 success。Python/生产 ESM/CJS/diff/whitespace 定向检查通过，未扩跑全量或改旧 UI mocks。
- 保留 Claude 和其他修改；未修改个人数据/正式实例/持久 8190，未 commit/push。本轮 fixture 根 C:/Users/XYZ/AppData/Local/Temp/xyz-region-enabled-59af32eae5d84cc88106590fd7f6f40c，PID17708 / port59607；独立 Chrome 均在 finally 关闭。后端需用户之后自行重启 ComfyUI，前端 Ctrl+F5。

Region 功能开关验证实例 PID17708 / port59607 已核对完整命令行并关闭。临时库、合成输入图、on/off/before 截图和日志保留在上述 scratch；未操作其他服务。
