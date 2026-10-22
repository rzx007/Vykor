# Vykor 产品组装版检查记录

日期：2026-10-23。独立预览：http://127.0.0.1:4173/ 。用户已明确要求本地预览及实际浏览器检查。

## 当前实现

- 首屏暖纸背景、品牌模型和导航保留。导航顶端最大 1280px，滚动后最大 1180px；GitHub 和 Download 分体按钮保留圆角与暖色毛玻璃。
- GLB 只采样其动画的前 5.5%，随首屏淡出，不再随整段滚动大幅转动。产品叙事由输入、对话、项目、文件/工具、完整工作台五阶段承接。
- 六个 HTML/CSS 部件共用最终布局：外壳、标题栏、侧栏、对话区、输入区、工具区。0.80–0.92 归位，0.92 起完整可交互。没有使用产品截图，没有额外引入 Anime.js。
- 一条 GSAP ScrollTrigger 将滚动位置交给纯状态函数，再应用部件姿态；反向滚动使用同一计算。低高度窗口与减少动态效果模式直接显示完成态，无脚本时有文字说明。
- 当前演示的会话与代码明确标为示例；输入只保留在当前页面内存，不发起模型请求，终端不执行命令。

## 本轮浏览器检查

通过 Codex 的浏览器工具操作已有本地标签页，未运行额外浏览器或 inspect.mjs/scenes.mjs。

- 1440×900：首屏、输入层、对话层、项目侧栏、工具层及完整组装均实际查看；桌面最终界面约 829×518px，六部件归位，无水平溢出。
- 点击首屏入口到进度 0.2301；点击跳过入口到 0.9600。返回输入阶段恢复非交互状态，仍只有一个界面实例及六个部件。
- 通过原生点击及按键验证：选择示例会话、切换终端、Right 切到浏览器、Tab 进入文件面板、输入中文并以 Enter 保留草稿。草稿状态和文字均更新。
- 修复内部面板截住页面滚动的问题：删除 data-lenis-prevent 与 overscroll contain，启用 allowNestedScroll。实测文件内部 scrollTop 从 0 到 29 时页面保持 4147px，再次滚动后页面到 4605px，能够继续进入下载区。
- 390×844：完整工作台使用 4:5 比例，约 324×405px；增加纵向空间，侧栏文本正确省略，无水平溢出。
- 390×740：进入自然滚动模式，工作台已组装且可操作；跳过入口可定位界面。此模式与减少动态效果共用完成态代码，但浏览器工具没有媒体偏好模拟能力，未声称完成该偏好的实机切换测试。
- 1024×768：输入层完整显示，标题与说明避开固定导航，无水平溢出。
- 章节与工作台锚点不再给整个视窗画出黑色焦点框；实际按钮、标签和输入框仍保留键盘焦点提示。

关键帧位于 .taste-skill/after/：product-code-top-desktop.png、product-code-prompt.png、product-code-conversation.png、product-code-tools.png、product-code-assembled-desktop.png、product-code-assembled-mobile.png、product-code-compact-mobile.png、product-code-prompt-tablet.png。截图是手动检查证据，没有生成视觉评分。

## vgpu 与抗锯齿

Three.js 渲染首屏模型与实体纸墙，独立透明画布通过 vgpu 0.6.0 和 @vgpu/wgsl 0.6.0 绘制 12 波长光谱与焦散近似。它是实际 GPU 光效，不是对 GLB 做完整物理光线追踪。

本轮 1440×900 浏览器读取到 renderer=webgl、lightRenderer=vgpu、光效 canvas engine=vgpu；光效 frameCount 从 1 增至 2。原生抗锯齿采样为 4，稳定后 renderQuality=settled、renderScale=1.750。首屏退场后使用同一模型姿态，不再随产品组装持续改变。

保留纸墙 400×400、相机 far=200 的接缝修复和原世界纸纹密度；覆盖测试仍检查普通桌面、2560 和 4K 的视野四角。无 WebGPU 或设备失效时只关闭光效；无 WebGL 时保留品牌静态图。未进行真实手机 GPU 性能测试。

## 代码检查与审阅

- npm run check：5 个源码资源引用与内部锚点有效，产品叙事未引用旧截图；61 项测试通过、0 失败、0 跳过。包含 8 项可逆组装状态测试、21 项模型取景、7 项质量预算、23 项纸墙覆盖、2 项光效测试。本轮 Dawn GPU 像素测试实际执行。
- npm run build：Vite 7.3.7 编译 124 个模块；入口 JavaScript 约 158kB，gzip 60kB；延迟加载的 vgpu 约 210kB、光学模块约 621kB。保留既有 500kB 体积提示，没有调整阈值隐藏提醒。
- JavaScript 语法检查与 git diff --check 通过。
- design-taste-frontend：页面源码检查 0 FAIL、0 WARN；产品界面按 app 模式检查 0 FAIL、2 WARN。两项为真实项目侧栏的“项目”标签与窗口落影，保留实际界面用途，不作为营销装饰。
- 独立只读审阅发现内部滚动链问题，已修复并实测；复核未发现剩余阻塞问题。空间变换承载层保留 preserve-3d，交互前通过 inert 隔离，原生焦点移动使用 preventScroll。

Anatomy 仅借鉴拆解归位原则，未安装或复制其套件。来源与限制见 DESIGN.md。随机种子 1155377807 保留；旧冷色概念图只是历史素材。以上为本地版本检查记录；GitHub Pages 部署流程见 README.md。预先存在的 skills-lock.json 改动未触碰。
