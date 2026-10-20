# 消息活动状态

工具调用、智能体活动、终端卡片和耗时展示。

## 放置边界

活动展示和计时模型相邻；实际执行工具的逻辑不进入消息组件。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [agent-activity-message.tsx](agent-activity-message.tsx)
- [terminal-activity-card.tsx](terminal-activity-card.tsx)
- [task-duration.tsx](task-duration.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../../AGENTS.md)。
