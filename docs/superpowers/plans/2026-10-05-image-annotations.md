# 图片查看与区域批注实现计划

**目标：** 图片附件和项目图片共用查看器，支持缩放、框选评论、批注草稿恢复和加入聊天，由用户确认发送。

**实现边界：** 复用已有 Dialog、Button、ButtonGroup、附件上传和聊天草稿。区域交互由 Annotorious 核心包提供，缩放由 react-zoom-pan-pinch 提供；不创建通用编辑器、绘图工具注册系统或新后台服务。原图保持不变，批注按原图内容摘要保存；聊天保存编号标记图和文字意见的快照。

**执行：** 在当前工作区内联完成，保留已有未提交改动，不自动提交。按现有 AGENTS.md 仅做代码检查，样式由用户查看反馈。

## 1. 图片批注数据和聊天草稿

文件：
- `apps/desktop/src/renderer/src/components/desktop/image-viewer/image-annotations.ts`：区域评论、内容摘要、草稿读写、编号文字及标记图导出。
- 同目录 `image-annotations.test.ts`：坐标、损坏草稿和内容版本隔离。
- `stores/desktop-session/attachment-actions.ts`、`types.ts`、`attachment-actions.test.ts`：将反馈追加到指定草稿，保留已有富文本与附件，不自动调用发送。

- [x] 先测试：反向拖动/缩放后的区域仍对应原图；空评论不进入发送快照；损坏存储不造成崩溃；不同图片摘要不能读取同一批注。
- [x] 测试聊天衔接：现有草稿含上下文引用时，追加反馈不能将它扁平化为纯文本；附件关闭支持时不修改草稿；异步导出过程中切换聊天不能写入另一聊天。
- [x] 用现有上传入口接入标记图，追加编号意见，保留上传失败后的重试入口。

草稿保持项目已有结构：
```ts
composerDocument([...current.document.items, { type: 'text', text: '\n\n' + feedback }])
```

## 2. 共用图片查看器

文件：
- `components/desktop/image-viewer/image-viewer.tsx`：图片、缩放、框选、编号评论列表和工具栏。
- `image-viewer-provider.tsx`：复用项目 Dialog，打开附件/图片，捕获目标聊天草稿，关闭后释放 Blob URL。
- `image-viewer.test.tsx`：使用实际 Annotorious 和 React 组件测试评论编辑与键盘操作，不测试样式截图。

- [x] 验证已安装库的类型和框选坐标方式，不实现第二套矩形拖动引擎。
- [x] 图片和批注层放在同一缩放容器，框选模式关闭拖动平移；查看模式允许平移。
- [x] 复用工具栏圆形/胶囊按钮与暖色批注状态，支持适应窗口、100%、缩放、撤销重做、复制和下载。
- [x] 评论编辑使用现有 Textarea；评论列表编号与导出图片编号对应，删除/修改通过同一 Annotorious 状态完成。
- [x] 关闭、切图、加载失败都释放资源；存储失败给出提示但保留当前草稿。
- [x] 加入聊天捕获点击时的图、评论与草稿目标，成功后只关闭查看器，不发送消息。

## 3. 接入现有入口与验证

文件：
- `App.tsx`：安装共用查看器 Provider。
- `tools/file-image-preview.tsx`、`tools/file-viewer.tsx`：项目图片点击进入查看器并传来源路径。
- `conversation-page/composer/attachment-image-preview.tsx`、`composer-attachments.tsx`：待发送图片点击预览。
- `conversation-page/message/message-attachment.tsx`：历史附件和生成图片共用入口。

- [x] 接入三个入口，不增加跨布局传递回调。
- [x] 运行新测试与现有文件图片/附件渲染测试。
- [x] 运行桌面 web/node 类型检查与改动文件 lint。
- [x] 检查差异和依赖改动，确认原有工作不被覆盖；不主动运行预览或截图。

验证命令：
```powershell
.\node_modules\.bin\vitest.CMD run --config apps/desktop/vitest.config.ts
.\node_modules\.bin\tsc.CMD --noEmit -p apps/desktop/tsconfig.web.json --composite false
.\node_modules\.bin\tsc.CMD --noEmit -p apps/desktop/tsconfig.node.json --composite false
```
测试执行时指定本功能文件及受影响的已有测试，不运行完整套件。

最终验证：7 个相关测试文件共 40 项通过，改动文件 ESLint 无错误和警告。前端全局类型检查最后一次被工作区内同时进行的会话搜索改动挡住（`SearchSessionsOptions` / `SessionSearchResult` 导出未对齐），未改动这些搜索接口文件。视觉样式按约定交由用户查看。
