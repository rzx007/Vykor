# Vykor 产品组装落地页

独立 Vite 项目。首页用真实 DOM（浏览器中的文字、按钮和输入框）组成可操作的 Vykor 工作台，不使用产品截图。GSAP 的一条 ScrollTrigger 将滚动映射到组装进度，Lenis 平滑桌面滚轮；Three.js 与 vgpu 保留首屏品牌模型和真实 GPU 光效。

## 本机运行

在 PowerShell 中执行：

```powershell
cd E:\code\openharness-ts\artifacts\vykor-home
npm ci --workspaces=false
npm run dev
```

安装过依赖后只需运行 `npm run dev`。打开 http://127.0.0.1:4173 ，Ctrl+C 停止。

```powershell
npm run check
npm run build
npm run preview
```

生产文件在 dist/。通过 HTTP 访问，不双击 index.html。

## GitHub Pages

线上地址：[rzx007.github.io/Vykor](https://rzx007.github.io/Vykor/)。`.github/workflows/pages.yml` 会在 main 分支的页面源码或工作流更新后独立构建并发布，也支持从 Actions 手动运行。

工作流使用 Node.js 24，在本目录执行 `npm ci --workspaces=false`、`npm run check`，再按 GitHub Pages 提供的子路径构建并上传 dist。只发布构建产物。GLB 与纸纹理通过 Vite 的 BASE_URL 加载，支持 `/Vykor/` 路径；本地开发仍使用 `/`。

可在本机检查同样的部署路径：

```powershell
npm run build -- --base /Vykor/
```

发布后执行 `node scripts/check.mjs https://rzx007.github.io/Vykor/`，检查页面、脚本、样式和动态模型资源的 HTTP 返回。

## 体验

- 五阶段依次为输入请求、展开对话、整理项目、打开文件与工具、完整工作台。六个独立部件是外壳、标题栏、侧栏、对话区、输入区和工具区；它们从分离的位置归位。
- 组装进度达到 `0.92` 后，部件全部归位并开放交互：切换示例会话、折叠项目、在文件/终端/浏览器间切换，以及输入和保留页面草稿。工具标签支持方向键、Home、End；Enter 保留草稿，Shift + Enter 换行。
- 退回 `0.92` 前会禁用界面操作，滚动停止则保持当前姿态。可用“直接查看完整工作台”跳过叙事；手机低高度窗口和减少动态效果模式直接显示完整工作台。
- 输入只保存在当前页面内存，刷新后不保留；示例终端不会执行命令，也不会向模型发送请求。无 JavaScript 时显示文字说明和下载链接。
- 首屏品牌模型只采样 GLB 动画的前 `5.5%`，作为简短引子。Three.js 渲染模型和纸墙，`vgpu@0.6.0` 与 `@vgpu/wgsl@0.6.0` 绘制透明光谱层；不支持 WebGPU 时仅关闭光效，不支持 WebGL 时保留品牌静态图。
- 顶部保留品牌与 GitHub 图标；滚动后由最大 1280px 收至 1180px，显示暖色毛玻璃条、GitHub 描边按钮和白色 Download 分体按钮。

主叙事由 `story-state.js` 采样姿态、`main.js` 应用变换、`product-demo.js` 管理界面交互。没有额外引入 Anime.js。Anatomy 仅提供“拆解、说明、归位”的设计参考，未安装或复制其套件，来源见 DESIGN.md。

下载菜单的 `.exe`、`.AppImage`、`.deb` 固定指向已核对的 v1.2.22 资产；后续发版时需同步更新 `index.html` 中这三个地址。Download 主按钮使用 `/releases/latest`，随最新发布版本跳转。

## 设计来源

- design-seed.json：本次 shell 生成的 384 位随机字符串、SHA-256、重复字母和数字段。
- scripts/new-design-seed.ps1：可重用生成器。默认只输出新种子，不改本次结果；传入 -OutputPath 可另存。
- .taste-skill/direction.json：The product performs，方向种子 1155377807。
- concepts/optical-continuity.png：早期冷色光学概念图，仅保留作历史对照，不代表当前产品组装叙事。
- concepts/generation-prompt.txt：生成概念图的完整提示词。
- DESIGN.md：具体文案、种子解释、视觉取舍和素材边界。
- scripts/build-paper.mjs：生成当前纸面纹理，执行 node scripts/build-paper.mjs 可重建。
- src/story-state.js / src/product-demo.js / src/product-demo.css：五阶段姿态与六个 DOM 界面部件。
- src/vgpu-light.js / src/vgpu-light-shader.js：首屏 WebGPU 光效与光谱计算。
- IMPLEMENTATION.md：当前实现范围。
- CHECKS.md：验证记录；浏览器结果以其中的实际记录为准。

工作台由 HTML、CSS 和 JavaScript 实现，内容明确标为示例，不是模型实际执行记录。三维 GLB 和品牌静态图来自 ../website-media；当前页面不加载原来的四张产品截图。

`npm run check` 检查资源、锚点、产品叙事未使用截图、可逆组装状态、模型取景、纸墙覆盖、渲染质量和 WebGPU 光效。光效测试通过 Dawn 读取实际 GPU 像素；没有原生适配器时明确跳过该项。实际结果及浏览器检查见 CHECKS.md。
