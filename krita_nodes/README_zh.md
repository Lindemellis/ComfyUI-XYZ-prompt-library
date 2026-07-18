# Krita 联动

从正在运行的 Krita 里把图层和遮罩直接拉进工作流。

这是 krita-ai-diffusion 的**反过来**:那边是 Krita 为主、ComfyUI 当后端;**这里 ComfyUI 是主
工作台**,Krita 只是你需要画草稿、手绘分区、精确抠遮罩时才打开的画板。

| 节点 | 分类 | 用途 |
|---|---|---|
| **XYZ Krita Fetch Image** | `XYZNodes/Krita` | 图层(或整个文档)→ `IMAGE` + `width`/`height` |
| **XYZ Krita Fetch Mask** | `XYZNodes/Krita` | 图层 → `MASK` |
| **XYZ Krita Fetch Color Masks** | `XYZNodes/Krita` | 一个 flat color 图层 → N 张**任意形状**的遮罩 |
| **XYZ Krita Send To Krita** | `XYZNodes/Krita` | `IMAGE` → Krita 新图层,或新文档 |
| **XYZ Krita Open File** | `XYZNodes/Krita` | 硬盘上的文件 → 在 Krita 里按原样打开 |

**不经过 Krita** 的跨运行图片交接,见 [Cache Slot](../cache_nodes/README_zh.md)。

---

## 安装

1. **装 Krita 插件。** 在 Krita **关闭**的状态下,POST `/xyz/krita/plugin/install`,或在仓库根目录:
   ```bash
   python -c "from krita_nodes import installer; print(installer.install())"
   ```
2. **启动 Krita。** 插件监听 `127.0.0.1:8765`。
3. 在 ComfyUI 里添加 Krita 节点,点 **Refresh layers**。

> **装之前一定要先关掉 Krita。** Krita 退出时会用它**启动时读到的**配置重写配置文件 —— 所以你在
> Krita 开着的时候启用插件,一关 Krita 这个改动就被悄悄抹掉了。结果是插件看着装好了,却永远不加载。
> 安装器会检测这种情况并提示你。这是这里最容易让人摸不着头脑的失败模式。

不离开 ComfyUI 就能自检:

| 路由 | 回答什么 |
|---|---|
| `GET /xyz/krita/plugin` | 插件装了吗?启用了吗? |
| `GET /xyz/krita/ping` | Krita 在跑吗?开着哪个文档? |
| `GET /xyz/krita/layers` | 图层树 |

---

## 工作原理

插件在 **Krita 内部**跑一个绑定 localhost 的小 HTTP server。工作流执行时,节点向 Krita 要图层并
阻塞等待(**pull**,不是 push)。Krita 没开就报错 —— 这是有意的,悄悄塞一张空图只会浪费一次生成。

Krita 的 API **只能在主线程调**,所以 HTTP 处理器从不直接碰文档:它通过 Qt 的队列信号把活儿交给
主线程再等结果(`bridge.py`)。这一步搞错会让 Krita 崩溃,而且往往不是当场崩。

---

## XYZ Krita Fetch Image

选一个图层 —— 或者 `document`,即整个文档拍平。

| 输入 | 作用 |
|---|---|
| `layer` | 由 **Refresh layers** 填充。只列出能当图像的图层。 |
| `resize_mode` | `none` / `by_width` / `by_height`。后两者都**保持原比例**。 |
| `size` | 目标宽度或高度。 |
| `round_to` | 对齐到 N 的倍数。**默认 8** —— 尺寸不对齐会被采样器静默裁切。 |
| `interpolation` | 默认 `lanczos`。 |
| `max_wait` | 等 Krita 的超时。 |

它同时输出**最终的** `width` / `height`,可以直接接空 latent,尺寸天然一致。

**只有这个节点有 resize**,这是刻意的:Krita 文档被放大之后,你仍然想按合理的分辨率**生成**,
直接设 `by_height: 1216` 就行,不用另接一串缩放节点。

**透明区域会被合成为白色。** Krita 的草稿图层大部分是透明的,而 ComfyUI 的 `IMAGE` 没有 alpha 通道。
直接丢掉 alpha 会让这些像素变成**黑色**;合成到白底上才是 lineart / depth ControlNet 真正想要的。

## XYZ Krita Fetch Mask

| 选中的图层 | 得到什么 |
|---|---|
| `transparencymask`、`selectionmask`(存下来的**局部选区**)等遮罩类 | 直读 —— 它本来就是单通道的 selectedness |
| `paintlayer`、`grouplayer` | 取它的 **alpha**:「画了东西的地方」 |

没有参数来选,由图层自己的类型决定。

**`reference`(可选的 `IMAGE`)。** 遮罩出来是 Krita 画布的尺寸,而你的图片可能已经被 Fetch Image
缩过。区域条件类节点会自动缩放遮罩,**但 inpaint 不会 —— 尺寸对不上直接报错**。把 Fetch Image 的
输出接到这里,遮罩就自动对齐了,一个参数都不用填。

## XYZ Krita Fetch Color Masks

**在 Krita 里把左边角色涂红、右边涂蓝、背景涂绿 —— 这个节点把它们拆成三张遮罩。** 这是
`XYZ Mask Editor` 做不到的:**任意形状**、贴合角色轮廓、一次出多张。

| 输入 | 作用 |
|---|---|
| `layer` | 绘画图层或图层组。只列出这两类。 |
| `count` | 出多少张遮罩。**输出槽位数跟着这个值走。** |
| `tolerance` | 像素离某个区域的颜色多远还算属于它。 |
| `reference` | 可选,同上。 |

取面积最大的 `count` 种颜色,按 **hex 值升序**排列 —— 决定哪种颜色落在哪个槽位的是 hex 而不是面积,
所以你重新涂色之后,槽位顺序不会乱跳。

每个像素归给 `tolerance` 范围内**最近**的那个颜色,超出容差的不归任何一张。所以遮罩之间既不重叠,
抗锯齿边缘上也不留缝。

> **区域丢了它不会告诉你。** 图层上的颜色比 `count` 多:面积最小的那些被忽略。比 `count` 少:多出来
> 的槽位输出**空遮罩**。两种情况都不报错 —— 所以你在 Krita 里加了第四种颜色却忘了调大 `count`,那个
> 区域就从提示词里**悄悄消失了**。看控制台:节点会打印每张遮罩的颜色和它占画布的比例。

## 从 ComfyUI 启动 Krita

每个 Krita 节点上都有一个 **Launch Krita** 按钮。它会自己找到 `krita.exe`、启动它,并**等到桥接
就绪为止** —— Krita 要 ~20 秒才起得来,进程一出现就发请求只会超时。Krita 已经在跑的话它会直接
告诉你,不会再开一个。

找不到 Krita 的话,设一次路径就行:

```bash
curl -X POST localhost:8188/xyz/krita/executable -d '{"path": "C:/Program Files/Krita (x64)/bin/krita.exe"}'
```
或者把 `XYZ_KRITA_EXE` 环境变量指向它。保存的路径在 `krita_data/settings.json`。

## XYZ Krita Send To Krita

把 `IMAGE` 推进 Krita。两种模式:

| `mode` | 作用 |
|---|---|
| `new_layer` | 插到已打开文档的最上面。**需要已有文档。** |
| `new_document` | 按图片尺寸新建一个 Krita 文档。这是工作流的**开头** —— Krita 还什么都没开的时候。 |

`launch_krita`(默认开)会在 Krita 没跑时先把它启动起来。所以「ComfyUI 冷启动 + Krita 没开 +
跑一次」就能直接得到一张打开的画布(刚启动的 Krita 什么都没开,所以不管 `mode` 是什么,图都会落到
一个新建文档里)。把 `launch_krita` **关掉**后,节点变成尽力而为:Krita 没开时就安静地什么都不做、
而不是让整条 run 报错 —— 只有 Krita 已经开着时才会把图送过去。

## fallback 输入

`Fetch Image`、`Fetch Mask`、`Fetch Color Masks` 各有一个可选的 **`fallback`**。Krita 没开、没有打开
文档、或者图层已经不在了 —— 这些情况下节点会改用 fallback,而不是中断整次运行。Fetch Color Masks 收的是
`IMAGE`,会用**完全相同**的颜色分割逻辑去拆它,所以各个槽位的含义不变。

**不是真需要就别接。** fallback 是「静默出错」最好的藏身处 —— Krita 关着,你没注意,整批图就对着替身
渲染出来了。所以它**只有在你真的接了东西时才启用**,而且一旦启用就会在控制台**大声喊**:

```
[XYZ Krita] !! could not reach the Krita plugin at http://127.0.0.1:8765 ...
[XYZ Krita] !! FALLING BACK to the connected image — this run is NOT using Krita
```

不接的话,这些情况仍然是**报错** —— 通常这才是你想要的。

只有 Krita 自己的失败会走 fallback。节点里的 bug 照样会暴露出来。

## XYZ Krita Open File

**按原样打开**硬盘上的文件,而不是把像素推给 Krita。

这个区别很重要。Send To Krita 交过去的是 `IMAGE` —— 一张扁平的像素网格 —— 所以一个 `.kra` 这样送过去,
到 Krita 里图层已经**拍平了**,而且没有文件名。Open File 交给 Krita 的是**路径**:`.kra` 会保留
**所有图层**,而且 Krita 知道文件从哪来,所以 **Ctrl+S 直接存回原文件**。

路径可以是绝对路径,也可以相对于 ComfyUI 的 `output/` 或 `input/` —— 你想打开的文件,十有八九
要么是 ComfyUI 刚生成的,要么是你自己丢进 `input/` 的。

**图片只存在于工作流里** → 用 Send To Krita。**图片在硬盘上,而且你在乎它的图层或路径** → 用 Open File。

### new_layer:尺寸很少刚好一致

所以:

| 图片… | 会发生什么 |
|---|---|
| 比画布小 | **放大**到画布尺寸。Krita 是 canvas of record,它不缩小。 |
| 比画布大,`scale_document` **关** | **缩小**到画布尺寸。 |
| 比画布大,`scale_document` **开** | 整个**文档**放大到图片尺寸(所有图层一起),图片 1:1 放进去。 |

`scale_document` 就是你的放大流程:2 倍生成,打开开关推回去,然后在新尺寸上继续手改和重绘。
草稿图层会在这个过程中变糊,但没关系 —— 走到放大这一步时草稿已经功成身退了。**画布只增不减。**
想回到生成分辨率,用 Fetch Image 的 `by_height`。

---

## 限制

- **只支持 8 位文档。** 16 位或浮点文档会给出明确报错,提示你去转换(*图像 ▸ 转换图像色彩空间 ▸ 8 位*)。
  Krita 的 Python API 给的是裸字节,只有 U8 的排布是无歧义的。
- **一次只处理一个文档** —— Krita 里当前活动的那个。
- 端口固定 **8765**;可以用环境变量 `XYZ_COMFY_PORT` 覆盖(两侧都读它)。
- 插件的命名空间和 ComfyUI-Danbooru-Gallery 的 `open_in_krita` 完全隔离(不同 id、端口、日志),
  两个可以同时装在一个 Krita 里。

## 连不上时

1. `GET /xyz/krita/plugin` —— `installed` 和 `enabled` 都是 true 吗?
2. `enabled` 是 false:关掉 Krita,重新跑一次安装,再启动 Krita。
3. 还是不行?*设置 ▸ 配置 Krita ▸ Python 插件管理器* —— 勾上 **XYZ ComfyUI Bridge**,重启 Krita。
4. 插件自己的日志:`%APPDATA%\krita\xyz_comfy.log`。
