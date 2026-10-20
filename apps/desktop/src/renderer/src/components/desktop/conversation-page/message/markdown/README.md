# Markdown 消息渲染

Markdown、代码块、图表和流式渲染适配。

## 放置边界

渲染插件、修复逻辑与基准测试归此类；独立文件编辑器放在 tools/editor。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [assistant-markdown.tsx](assistant-markdown.tsx)
- [incremental-markdown.ts](incremental-markdown.ts)
- [mermaid-diagram.tsx](mermaid-diagram.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../../AGENTS.md)。
