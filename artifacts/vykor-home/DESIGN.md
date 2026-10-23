# Vykor · 产品部件，组成工作台

## 当前方向

用户在 2026-10-22 明确否定上一版的冷黑冰青，选择 vgpu.sh 首屏所呈现的自然纸面、柔光、透明玻璃与落影作为参考。本版以用户这次选择为准，不再把随机种子解释为配色约束。

方向：纸白 #eeebe4、石墨 #2b2d27、次文字 #66685d、浅苔绿 #748264。首屏、产品组装、下载收尾与页脚共用暖纸背景；深色工作台是画面的主要实体。主要按钮石墨填充、纸白文字，滚动后的顶部导航使用暖色毛玻璃。

**想法：先看清每个工具做什么，再看它们如何组成同一个 Vykor。**

保留 The product performs 的内容原则：用可操作的界面说明产品。工作台由 DOM（浏览器中的真实文字、按钮和输入框）实现，不使用产品截图。首屏仍保留 Vykor 自己的 GLB 括号、连接杆和双眼机器人。

## 首屏与产品叙事

导航居中，顶端最大 1280px，滚动后以 450ms 过渡收至最大 1180px。首屏文字与品牌模型使用居中构图，暖纸材质覆盖整个流程。收尾继续围绕刚刚组装完成的工作台，不再另开一个视觉场景。

导航：顶部保留品牌标识、名称，右侧仅显示 GitHub 猫图标。滚动后显示暖色毛玻璃悬浮条、描边 GitHub 胶囊按钮与白色 Download 分体按钮。Download 主按钮打开最新发布页，旁边用原生 details 展开 Windows 和 Linux 资产链接，支持键盘、Escape 和点击外部关闭。首屏与完成态各保留下载入口。

主按钮采用胶囊圆角。组装中的界面部件各自有边界，最终归位后消除部件间的圆角接缝，成为一个完整窗口。

首屏：衬线 Vykor 字标；副题“你的 AI 工作台。让工作，继续发生。”；正文“对话、代码、资料，在同一个项目里继续。”；行动“下载 Vykor”。Georgia/Times New Roman 用于品牌字，中文与其余内容保留系统无衬线。窄手机将文字、模型、底部提示依次纵向排列，低高度窗口使用自然滚动。

首屏文字与品牌模型分开退场：文字先让出阅读位置，模型继续提供空间参照；输入区先在模型所在区域接过画面，再向最终工作台的位置归位。品牌模型的转动幅度继续受限，衔接由内容的交接承担。

五阶段为“先说说，要做什么”→“把事情，讨论清楚”→“让工作，有个归处”→“打开文件，接着做”→“这就是，你的 Vykor”。输入区出现后，对话、项目侧栏和工具区依次补足，最后外壳与标题栏一起归位。每个新部件都保留前一阶段已经出现的内容，避免重新切一张画面。

六个真实 DOM 部件分别是外壳 `shell`、标题栏 `chrome`、侧栏 `sidebar`、对话区 `conversation`、输入区 `composer` 和工具区 `tools`。它们一直使用最终窗口坐标布局，滚动只改变平移、空间深度、旋转、缩放和透明度。

整段由一条 GSAP ScrollTrigger 提供 `0–1` 进度，`src/story/state.js` 每次从进度直接计算姿态，`src/main.js` 应用到部件和文案。`0.80–0.92` 将所有部件收拢；达到 `0.92` 后全部归位并开放交互，反向滚动可回到拆解状态。没有额外引入 Anime.js。

完整工作台支持会话切换、项目折叠、文件/终端/浏览器工具切换和页面草稿。工具标签支持方向键、Home、End；Enter 保留草稿，Shift + Enter 换行，中文输入法选字不触发提交。草稿只留在当前页面内存，示例命令不执行，也不发送模型请求。

组装完成前，界面禁用鼠标和键盘操作；提供“直接查看完整工作台”的跳过入口。低高度窗口和减少动态效果模式直接显示完成状态，下载内容自然排列在工作台旁或之后；无脚本时显示文字说明与下载链接。

完成后的 `0.93–0.985` 进度只把故事文案交给下载内容：“下一件事，从这里开始。”工作台保持原位、原尺度和可操作状态，让下载成为刚才组装过程的结果。标题延续故事标题的尺度，配一段简短说明、一个胶囊下载按钮及低强调源码链接；不新增大幅背景换色或放大的品牌装饰。

`#download` 位于工作台场景内，访问该锚点直接进入最后的下载状态。结束后只接同一暖纸底的简洁页脚，沿用内容网格和品牌字，保留文档、源码与回顶部入口。手机采用纵向排列和适合拇指的按钮高度，不为收尾再次缩小工作台。

## 目录与状态归属

- [src/story/README.md](src/story/README.md)：滚动叙事分类说明；`state.js` 管理阶段、姿态和过渡，`__test__/state.test.mjs` 检查该状态计算。
- `src/main.js`：页面入口，负责把滚动进度应用到模型、部件、文案与下载内容，管理锚点、焦点和动态效果降级。
- `src/product-demo.js` 与 `src/product-demo.css`：产品界面及交互；会话、工具选择和草稿状态留在当前页面内存。
- [README.md](README.md)：运行、部署和文件导航；[IMPLEMENTATION.md](IMPLEMENTATION.md) 记录实现边界，[CHECKS.md](CHECKS.md) 记录实际验证结果。

## 材质与动效

纸纹由 scripts/build-paper.mjs 使用种子 1155377807 生成：多个尺度的连续噪声与细纤维，输出 480×480 的透明 PNG，本地平铺。它是原创程序纹理，不是 vgpu 的墙纹理副本。

Three.js 继续实际渲染模型。中性玻璃配暖白环境灯和宽反光面；连接杆为柔和银色，机器人为暖白陶瓷，关闭原模型的绿色夹层。双眼孔后增加凹入的深色底衬，保留眼睛轮廓。

首屏 GLB 仅采样自身动画的前 `5.5%`，随开场退场；产品组装由 DOM 承担。Three.js 继续绘制玻璃、纸墙和阴影，纸纹进入实体纸墙供玻璃透射。镜头按当前模型范围与可用区域取景。

独立的透明 WebGPU 画布叠在首屏 Three.js 场景上，由 `vgpu@0.6.0` 与 `@vgpu/wgsl@0.6.0` 实际执行本页的 WGSL 着色代码。光效分别计算 12 个波长，用 Cauchy 关系按波长求折射率，再用曲面折叠近似形成焦散（折射光聚成的亮带）。它随首屏一起退场，是与品牌模型同步的屏幕光学近似，没有对完整 GLB 做物理光线追踪。

Three.js 继续负责模型材质和纸墙。设备不支持 WebGPU、着色代码编译失败或 GPU 设备丢失时，只关闭光效层；不影响 Three.js 模型。减少动态效果模式使用静态品牌图。

模型保留原生多重采样抗锯齿，停止输入 160ms 后补绘更高分辨率的一帧，最高 2 倍。整屏画布在硬件允许时不低于原生尺寸；稳定画面的透射使用完整分辨率。具体浏览器读数见 CHECKS.md。

## vgpu 官网源码核对

官网代码存在于 vercel-labs/vgpu 的 canary 分支。核对提交：773351f8c96d1cbec28155c0e36ae3efd1cba135。

- [首屏入口 hero.tsx](https://github.com/vercel-labs/vgpu/blob/canary/apps/docs/app/%5Blang%5D/(home)/components/hero.tsx)
- [prism-background 场景说明](https://github.com/vercel-labs/vgpu/blob/canary/apps/docs/app/%5Blang%5D/(home)/components/prism-background/README.md)
- [浅色渲染流程](https://github.com/vercel-labs/vgpu/blob/canary/apps/docs/app/%5Blang%5D/(home)/components/prism-background/pipelines/light/render.ts)
- [石膏纹理生成器](https://github.com/vercel-labs/vgpu/blob/canary/apps/docs/app/%5Blang%5D/(home)/components/prism-background/pipelines/light/assets/generate-wall.ts)
- [MIT 许可](https://github.com/vercel-labs/vgpu/blob/canary/LICENSE)

参考的温暖感来自矿物纸底、漫射柔光、透明中性玻璃和落影。当前已接入 vgpu 及其 WGSL 工具执行独立光效，光学计算在本页的 `src/vgpu-light-shader.js` 中。材质与照明借鉴官网，没有复制官网纹理、三角形模型或整套渲染流程；GSAP、ScrollTrigger、Lenis 和 Three.js 继续承担原有职责。

## Anatomy 参考边界

参考 Anatomy 的“拆解、解释、归位”原则：每个部件先独立说明用途，最终回到同一个可操作窗口。未安装 Anatomy，未复制其套件或实现，也未额外引入 Anime.js；当前叙事由项目现有 GSAP 与本页 DOM 代码完成。

- [官方 SKILL.md](https://github.com/wheresryan22/anatomy/blob/main/SKILL.md)
- [官方 motion 说明](https://github.com/wheresryan22/anatomy/blob/main/references/motion.md)
- [官方 walkthrough 说明](https://github.com/wheresryan22/anatomy/blob/main/references/walkthrough.md)
- [MIT 许可](https://github.com/wheresryan22/anatomy/blob/main/LICENSE)

## 随机种子与素材

上版 PowerShell 生成的 384 位字母数字字符串仍在 design-seed.json，SHA-256 为 44ddaa8f01f298b362965be06f318f70fa1cf68de9998f307a6190b696dbbc98，方向种子为 1155377807。成对字符 ss / oo / tt / ii 仍可对应双括号与双光源；3906 的配色联想已被用户新的暖色要求替代。没有重抽方向或改写随机结果。

concepts/optical-continuity.png 是早期冷色光学构图参考，仅保留作历史对照。当前暖纸材质参考 vgpu 首屏，产品叙事采用部件拆解归位。

工作台由 HTML、CSS 和 JavaScript 构建，内容明确标为示例；当前页面不加载旧产品截图。GLB 与静态品牌图来自 ../website-media，没有模型实际执行录屏、客户证明、价格或效果统计。

## 检查边界

用户已明确要求本地预览及实际浏览器检查。`npm run check` 包含原生 Dawn WebGPU 像素测试，检查光效局部绘制、随滚动变化和交接消失；无原生适配器时会明确跳过该项。测试结果、浏览器中的光效状态和实际绘制记录统一保存在 CHECKS.md，不据此编造视觉分数。
