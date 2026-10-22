# Vykor 产品组装落地页实现范围

目标：在独立 Vite 页面中，用六个真实 DOM 部件逐步组成可操作的 Vykor 工作台。保留首屏暖白品牌模型、vgpu 光效和下载入口，移除产品截图及其独立大图章节。

技术：Vite、GSAP 3、ScrollTrigger（将滚动位置映射到动画进度）、Lenis（平滑桌面滚轮）、Three.js（渲染品牌模型与纸墙），以及已安装的 `vgpu@0.6.0`、`@vgpu/wgsl@0.6.0`（通过 WebGPU 绘制独立光效）。

- index.html / src/style.css：首屏、组装舞台、跳过入口、文字降级与下载章节。导航顶端右侧只显示 GitHub 图标，滚动后由最大 1280px 收至 1180px，显示暖色毛玻璃条、描边 GitHub 按钮和白色 Download 分体按钮。
- src/story-state.js：将 `0–1` 进度采样成五阶段文案与六个部件的姿态。阶段依次是输入、对话、项目、文件/工具、完整工作台；`0.80–0.92` 归位，`0.92` 起所有部件回到最终坐标并允许交互。状态由当前进度直接计算，可反向采样。
- src/main.js：一条 GSAP ScrollTrigger 驱动整段叙事，应用部件变换、文案切换和交互门槛；没有额外引入 Anime.js。保留锚点、桌面 Lenis、导航与下载菜单的键盘/焦点处理。低高度窗口和减少动态效果模式直接渲染完整工作台，无脚本时使用文字说明。
- src/product-demo.js / src/product-demo.css：构建外壳、标题栏、侧栏、对话区、输入区、工具区六个 DOM 部件。完成后可切换示例会话、折叠项目、切换文件/终端/浏览器和保留当前页面草稿；只更新本地状态，不发起模型、文件系统或终端请求。
- 小屏将界面比例调整为 4:5，增加输入和对话的纵向空间；桌面保持 16:10。Lenis 开启 allowNestedScroll，内部面板有剩余内容时原生滚动，到边界后继续滚动页面。
- src/optical.js / src/framing.js：品牌 GLB 只采样前 `5.5%` 动画作为首屏引子；Three.js 保留玻璃、纸墙、双眼底衬、按需绘制与静态图降级，主叙事不再由 GLB 镜头承担。
- src/render-quality.js：按交互和静止状态分配渲染分辨率；保留原生抗锯齿，停止输入后补绘高质量帧。scripts/framing.test.mjs 与 scripts/render-quality.test.mjs 纳入 npm run check。
- src/vgpu-light.js / src/vgpu-light-shader.js：通过 vgpu 在首屏叠加透明 WebGPU 光效画布，执行 12 波长折射与曲面聚光近似。光效随首屏退场；WebGPU 不可用或失败时仅关闭光效，模型继续显示。
- scripts/vgpu-light.test.mjs：纳入 npm run check，用 Dawn 原生 WebGPU 读取实际像素，检查局部光效、滚动变化、交接消失及无 WebGPU 时的降级；无可用原生适配器时明确跳过像素测试。
- scripts/build-paper.mjs：生成本地纸纹，供页面背景及三维纸墙使用。
- scripts/story-state.test.mjs：纳入 npm run check，覆盖五阶段、组装终态、边界、反向采样及 GLB 前 `5.5%` 的采样范围。资源检查同时确认产品叙事未引用旧截图。
- design-seed.json、scripts/new-design-seed.ps1、concepts/：保留原随机结果、生成器与历史冷色概念图；出处与视觉取舍见 DESIGN.md。

Anatomy 仅借鉴拆解归位原则，未安装或复制套件；[官方 SKILL.md](https://github.com/wheresryan22/anatomy/blob/main/SKILL.md) 与 [motion 说明](https://github.com/wheresryan22/anatomy/blob/main/references/motion.md) 的来源边界记录在 DESIGN.md。

用户已要求本地预览及实际浏览器检查。验证结果统一记录在 CHECKS.md。项目作为独立页面由 `.github/workflows/pages.yml` 发布到仓库的 GitHub Pages，部署路径见 README.md。

下载维护：Download 主按钮使用最新发布页；菜单内的 Windows `.exe`、Linux `.AppImage` 和 `.deb` 指向已核对的 v1.2.22 固定资产。后续发布时同步更新 index.html 中这三个地址。
