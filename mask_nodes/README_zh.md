# 遮罩节点

两个节点，给 [提示词库 V3](../prompt_library_v3/README.md) 的 region 提供可指向的对象：你画矩形，
提示词里的 `imask: 0` 就指向第一个。

| 节点 | 分类 | 用途 |
|---|---|---|
| **XYZ Mask Editor** | `XYZNodes/Mask` | 在画布上画矩形；每个矩形输出一张 `MASK` |
| **XYZ Attach Masks** | `XYZNodes/Mask` | 把这些遮罩挂到 `CLIP` 上，供 `IMASK(i)` / `imask: i` 引用 |

这是遮罩方案的「矩形」那一半。另一半——从颜色分区图层取任意形状遮罩的 Krita 联动——已完成设计，
尚未实现。

---

## 唯一会咬人的地方

**`imask: i` 数的是遮罩被 attach 的顺序，不是输出槽位号。**

把 Mask Editor 的 `mask_0`、`mask_1`… **按顺序**接进 Attach Masks，并且 **不要接** `preview`、`base`
和 `fill`。接了其中任何一个，索引就整体后移——不报错、不警告，只是出图不对。

```
XYZ Mask Editor            XYZ Attach Masks         PLv3
  ├─ preview ─┐ （不要接——它是 IMAGE，不是遮罩）
  ├─ base    ─┤
  ├─ fill    ─┘
  ├─ mask_0  ─────────────→ mask 0    ───────────→  imask: 0
  ├─ mask_1  ─────────────→ mask 1    ───────────→  imask: 1
  └─ mask_2  ─────────────→ mask 2    ───────────→  imask: 2
```

有三处帮你对齐，显示的都是同一个数字：

- 画布上每个矩形左上角的索引号；
- 输出槽位名（`mask_0`、`mask_1`…）和 Attach Masks 的输入标签（`mask 0`…）；
- 每次运行时 Attach Masks 打到控制台的映射表：
  ```
  [XYZ Attach Masks] IMASK index -> input:
      IMASK(0)  <-  mask_1  (1, 512, 512)
      IMASK(1)  <-  mask_2  (1, 512, 512)
  ```

---

## XYZ Mask Editor

在空白处拖拽画矩形。点击选中，拖动移动，拖角柄缩放，按 <kbd>Delete</kbd> 删除。拖节点右下角可以
把画布放大。

### 输出

| 槽位 | 名称 | 类型 | 内容 |
|---|---|---|---|
| 0 | `preview` | `IMAGE` | 版面预览图：白底，每个矩形一种颜色 |
| 1 | `base` | `MASK` | 覆盖整个画布的全白遮罩 |
| 2 | `fill` | `MASK` | 所有矩形**未**覆盖到的区域 |
| 3… | `mask_0`、`mask_1`… | `MASK` | 每个矩形一张，按列表顺序 |

**`preview`** 就是画布上看到的样子，以图片形式输出——可以接 `PreviewImage`，或者和生成结果并排放着
核对构图。颜色和画布上的调色板一致，所以看起来是同一张。**id 小的画在上面**——两个矩形重叠时，
列表里靠前的那个盖住后面的，和编辑器里的叠放顺序一致。羽化边缘会像它的遮罩一样平滑淡出到白底。

`base` 和 `fill` 是**给别的节点用的**——区域条件类节点、inpaint 等等。PLv3 用不到它们：它的 base
区域隐含就是全图，fill 由编译器自己算。不管你用不用，它们都固定占据槽位 1 和 2。

矩形按画布比例存储，所以遮罩与分辨率无关——ComfyUI 会自动缩放到你实际生成的尺寸。

### 羽化（feather）

`feather` 让矩形边缘**向内**渐隐，单位是 512×512 遮罩上的像素：遮罩在矩形边界处为 0，向内在
`feather` 个像素内升到 1。所以矩形**永远不会**覆盖到你画的范围之外，两个边靠边的矩形也不会重叠。

`fill` 是实际输出的精确补集（含羽化）——所有遮罩加上 `fill` 在每个像素上都恰好等于 1，既不会有
地方被重复加权，也不会有地方被漏掉。

> **羽化只在一个地方设。** PLv3 的 region 自己也有 `feather:` 字段，它会编译成 prompt-control 的
> `FEATHER()`，而那是**叠加**在你传进去的遮罩张量之上的。两边都设就等于羽化了**两次**。二选一：
> 在这里设——你能直接看到矩形——然后 `imask:` region 上不要写 `feather:`。

### 删除矩形会让槽位前移

删掉三个里的中间那个，第三个的槽位会往前挪。ComfyUI 的连线是按槽位索引的，所以节点会替你重接线：
每条连线跟着**它自己的那个矩形**走，而不是留在原来的槽位号上。剩下的矩形会重新编号
（`mask_0`、`mask_1`），你提示词里的 `imask:` 索引也跟着变——所以删完记得回去检查提示词。

---

## XYZ Attach Masks

`clip` 进、`clip` 出，最多挂 **16** 张遮罩。输入槽位随着你接线自动增长，永远留一个空位。

拔掉中间的某张遮罩，后面的会自动上移补齐——因为留个空洞会让后面所有 `IMASK` 索引静默重编号。

这是整个节点包里**唯一**一处依赖 `comfyui-prompt-control` 内部实现的地方（它的
`model_options["x-promptcontrol.masks"]` 列表）。哪天 prompt-control 改了这个 key，只需要改这一个
节点——PLv3 本身自始至终只输出字符串。

---

## 一个完整例子

三个角色，从左到右：

1. **XYZ Mask Editor** —— 在画布上横向画三个矩形。
2. **XYZ Attach Masks** —— `clip` 来自 checkpoint；`mask_0` → `mask 0`，`mask_1` → `mask 1`，
   `mask_2` → `mask 2`。
3. **XYZ Prompt Library V3** —— 按这些索引写 region：
   ```
   masterpiece, best quality

   [@region]: {
       base: { 3girls, standing, side-by-side }

       [imask: 0]: { 1girl, red hair, red dress }
       [imask: 1]: { 1girl, blue hair, blue dress }
       [imask: 2]: { 1girl, green hair, green dress }

       fill: { detailed background, bokeh }
   }
   ```
   `masterpiece, best quality` 写在 region 组之外，所以它会被复制进**每一个**段落——见
   [环绕文本](../prompt_library_v3/README.md#regions)。
4. 把 V3 节点的输出和 Attach Masks 的 `clip` 一起接进 **PC: Schedule Prompt**。

跑一次，看控制台那行映射表，确认索引确实落在你以为的位置上。
