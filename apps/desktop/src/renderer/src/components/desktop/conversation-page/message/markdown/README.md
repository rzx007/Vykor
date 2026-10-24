# Markdown 消息渲染

Markdown、代码块、图表和流式渲染适配。

## 放置边界

渲染插件、修复逻辑与基准测试归此类；独立文件编辑器放在 tools/editor。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [assistant-markdown.tsx](assistant-markdown.tsx)
- 正文容器直接复用 [StreamingResponse](../../../../agents/streaming-response.tsx)，通过其示例的 [出字逻辑](../../../../agents/use-streaming-response-text.ts) 显示新增文字；不叠加 Streamdown 逐字淡入。消息层保留文件打开、复制和完成操作。
- [incremental-markdown.ts](incremental-markdown.ts)
- [mermaid-diagram.tsx](mermaid-diagram.tsx)

出字状态只保存在组件内，历史正文立即显示；短回复按示例每秒 110 个字符推进，积压上限约 2 秒，显示完即停止调度。大于 4096 字符的回复沿用现有 64ms 合并刷新，代码源码直接更新；减少动态效果时直接显示全文。模型输出完成后，回复容器等待已接收的文字显示完再进入完成状态。

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../../AGENTS.md)。
