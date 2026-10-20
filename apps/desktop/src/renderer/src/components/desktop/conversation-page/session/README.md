# 对话会话控制

新对话入口、会话菜单、摘要和任务定位。

## 放置边界

会话级操作与弹层放在这里；全局会话事件桥接留在 shell。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [new-conversation-start.tsx](new-conversation-start.tsx)
- [session-more-menu.tsx](session-more-menu.tsx)
- [session-summary-popover.tsx](session-summary-popover.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
