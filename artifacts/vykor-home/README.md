# Vykor 首页本地预览

独立 Vite 项目，使用 Three.js、GSAP 3 + ScrollTrigger 和 Lenis。沿用已选的 taste-skill 暗色方向与滚动剧本。

```powershell
cd D:\code\personal-project\OpenHarness-ts\artifacts\vykor-home
npm install --workspaces=false
npm run dev
```

打开 http://127.0.0.1:4173 。按 Ctrl+C 停止。

```powershell
npm run build
npm run preview
```

生产文件输出到 `dist/`。这是需要通过 HTTP 预览的项目，不通过 file: 双击运行。

- 开场：镜片特写随滚动收拢，再缩小交给工作台界面；停下即稳定，可反向滚动。
- 后续：编程、带可展开来源的资料示例、保存的会话与文档、下载。
- 手机：更短的开场交接，独立裁图与导航菜单。
- 减少动态效果：静态标识和自然滚动；无 WebGL 时自动使用透明备用图。
- 下载、源代码和文档按钮连接真实项目的 GitHub 页面，未写死具体安装包。

`public/media` 从 `../website-media` 复制，包含四秒 GLB 动画、透明 WebP 和四张产品图。界面取自实际组件，内容是标明的示例数据，未当作模型实际执行记录。尚无真实录屏，不含虚构客户评价、统计或价格。

`DESIGN.md` 保留文案与动效说明。根据当前协作约定，不主动截图和验证样式，由用户在本地预览后反馈。构建与资源检查结果记录在 `CHECKS.md`。
