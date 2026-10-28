# Markdown 消息渲染

Markdown、代码块、图表和流式渲染适配。

## 放置边界

渲染插件、修复逻辑与基准测试归此类；独立文件编辑器放在 tools/editor。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [assistant-markdown.tsx](assistant-markdown.tsx)
- [incremental-markdown.ts](incremental-markdown.ts)
- [markdown-emphasis.ts](markdown-emphasis.ts)：在本次解析的 `<em>` 内标记中文片段，保留英文、链接、嵌套强调及原始文字；跳过代码、键盘输入、公式和 SVG。
- [mermaid-diagram.tsx](mermaid-diagram.tsx)

正文排版统一由 `src/renderer/src/assets/main.css` 的 `.assistant-markdown` 规则负责：普通段落最多 `40em`，代码块和表格沿用外层消息列宽；支持时开启中英自动间距，代码、文件引用和表格显式排除。排版不改写消息或复制内容，也不随流式状态切换；回合高度继续由 transcript 的虚拟列表测量并处理滚动补偿。辅助文字使用的共享小字号变量保留 `12px` 下限。

`streamdown-plugins.ts` 在默认内容清理后接入中文强调处理，只给 `<em>` 内的中文及全角标点增加显示节点。外层 `<em>` 保留，中文通过 CSS 直立并加重，英文继续使用斜体；汉字与异体字选择符保持完整。`streamdown-components.tsx` 用语义化的 `<strong>` 展示加粗，保留原有样式标记。行内代码和文件引用不继承斜体；正文约束中文标点换行，技术内容沿用原规则。处理不增加组件状态或流式定时器，稳定段落继续由原有分块缓存复用。

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../../AGENTS.md)。
