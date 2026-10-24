# Agent 展示组件

这里保存通过 beUI 接入的回复、引用、活动展开和任务展示组件，页面按需组合使用。

- `streaming-response.tsx` 是回复容器，负责生成状态、完成操作和来源展示；`unstyled` 让现有 Markdown 渲染器继续管理文字样式。桌面聊天复用它，操作仍由消息层提供。
- `use-streaming-response-text.ts` 接入原组件示例的时间游标：`requestAnimationFrame` 按每秒 110 个字符推进；已有正文不重播，追上目标后停止，新增文字继续同一时钟。为真实输出限制最多 220 个待显示字符，避免积压；替换内容、减少动态效果和卸载会清理等待任务。
- `citations.tsx` 组合引用列表和网站图标；依赖 `lib/favicon.ts`、`lib/hooks/use-favicon.ts`。`agent-disclosure.tsx` 提供共享展开行为。
- `todo-list.tsx` 和 `task-rows.tsx` 展示任务与检查项。

调用入口为桌面消息的 `markdown/assistant-markdown.tsx`。模型输出和复制内容由会话层保存，这里只持有本地显示位置。长回复和代码继续由消息层限频或立即更新，避免逐帧解析大型文档。组件不接管会话请求和虚拟滚动；新增 beUI 展示组件及其适配放在这里，测试放入 `__test__/`。
