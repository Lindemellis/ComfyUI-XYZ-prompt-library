# Krita 联动

从正在运行的 Krita 里把图层和遮罩直接拉进工作流。

这是 krita-ai-diffusion 的**反过来**:那边是 Krita 为主、ComfyUI 当后端;**这里 ComfyUI 是主
工作台**,Krita 只是你需要画草稿、手绘分区、精确抠遮罩时才打开的画板。

| 节点 | 分类 | 用途 |
|---|---|---|
| **XYZ Krita Fetch Image** | `XYZNodes/Krita` | 图层(或整个文档)→ `IMAGE` + `width`/`height` |
| **XYZ Krita Fetch Mask** | `XYZNodes/Krita` | 图层 → `MASK` |

尚未实现:Send To Krita、Fetch Color Masks、Cache Slot。

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
