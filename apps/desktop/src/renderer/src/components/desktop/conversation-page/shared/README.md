# 对话共享代码

对话内跨功能复用的类型、文字操作和展示偏好。

## 放置边界

先确认至少两个对话功能需要复用；消息专属模型或输入插件不要为方便导入放入 shared。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [types.ts](types.ts)
- [conversation-text-actions.ts](conversation-text-actions.ts)
- [use-show-reasoning.ts](use-show-reasoning.ts)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
