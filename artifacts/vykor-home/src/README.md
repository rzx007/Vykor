# 页面源码

- `main.js`：页面入口，管理导航、下载菜单、滚动进度、焦点及窗口尺寸变化。滚动状态来自 [story/](story/README.md)。
- `story/`：纯状态计算和对应测试。新增叙事阶段放在这里。
- `product-demo.js` / `product-demo.css`：同一个可操作的示例工作台及六个可组装部件。示例会话、工具选择和草稿只保存在页面内存。
- `optical.js` / `framing.js` / `render-quality.js`：首屏品牌模型、取景和渲染清晰度。模型不是产品叙事主体。
- `vgpu-light.js` / `vgpu-light-shader.js`：首屏透明 WebGPU 光效。失败时仅关闭该层。
- `style.css`：暖纸背景、公共排版、首屏、故事舞台与页脚。界面自身样式放在 product-demo.css。

入口将浏览器滚动交给 story 的计算函数，再更新文字与部件变换；结束时显示下载入口，下载链接直接进入 GitHub 发布页。新增逻辑按上述职责放置，避免将模型渲染和界面交互混在一起。
