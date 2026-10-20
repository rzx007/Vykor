# 消息展示

用户与助手消息的组合、展示模型和交互。

## 放置边界

消息内部复杂功能按子目录分类；不要在这里接管整段对话的虚拟滚动。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [assistant-message.tsx](assistant-message.tsx)
- [message-block.tsx](message-block.tsx)
- [message-render-model.ts](message-render-model.ts)

## 子分类

- [消息活动状态](activity/README.md)：工具调用、智能体活动、终端卡片和耗时展示。
- [消息附件](attachments/README.md)：消息附件、图片结果及读取图片的展示。
- [Markdown 消息渲染](markdown/README.md)：Markdown、代码块、图表和流式渲染适配。
- [消息提示通知](notices/README.md)：重试、模型切换、用量、压缩和错误提示。
- [消息工具详情](tool-details/README.md)：Read、Shell 等工具调用的详情、结果和展开行。

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
