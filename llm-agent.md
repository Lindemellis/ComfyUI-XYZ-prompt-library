我想把现在的llm功能升级为一个agent

我设想中的功能：
可以直接读取并修改当前工作流，以及读取input、output folder，以实现以下流程：
- 我说帮我生成提示词，agent自动读取工作流中当前载入并active的模型（我有可能载入多个模型，但是其他模型的node被bypass、mute、或者通过true false node切换），然后读取对应模型的skills，如果有必要的话，进行网络搜索或danbooru database搜索，然后生成提示词
- 我在ui界面里选择一个node的一个textbox作为输出端。当agent生成提示词后，提供一个apply按钮，让我可以直接输入到该text box。我希望的是可以适配所有带有textbox的node，以及我们自己的plv3 monoca node
- 我在ui界面里选择一个或多个text、image、video、audio node作为输入端，或者手动上传文件。在对话时，agent自动读取这些node加载的媒体。
    - 例如：输入图片和提示词，我告诉ai根据图片优化提示词。ai根据workflow node判断这是minimax h3提示词，读取对应的skill，然后识图，生成符合minimax h3格式的提示词。如果生成的结果令我不满意，我可以告诉ai去看视频，然后修改提示词。ai看视频的途径可能可以是
        - 一般各种save video、save image图片都会有preview功能，ai是否能直接读取这些预览
        - 根据save video、save image node的存储路径，自己去对应的文件夹里找
    - 需要考虑的问题：怎么读取比如说load image、load video node加载的图片，是run一下这些node，还是可以读取到它们载入的temp file。如果需要运行node，如何区分单纯的加载资源node，和生成节点。运行生成节点不是我们期望的目标。

考虑使用的ai：
现在用的deepseek没有多模态，所以我需要一个能识图、识别视频的多模态llm模型，帮我检索各家模型最新公布的能力和api价格，包括：
- gpt
- claude
- gemini
- qwen
- glm
- grok
- qwen

不要重复造轮子：
我需求的功能有没有已经被实现，或者有类似的项目可以参考

使用架构：
考虑使用开源的pi作为agent harness架构，我已经下载了pi
