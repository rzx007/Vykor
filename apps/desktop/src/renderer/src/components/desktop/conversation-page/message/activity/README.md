# 消息活动状态

工具调用、智能体活动、终端卡片和耗时展示。

## 放置边界

活动展示和计时模型相邻；实际执行工具的逻辑不进入消息组件。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [agent-activity-message.tsx](agent-activity-message.tsx)
- [terminal-activity-card.tsx](terminal-activity-card.tsx)
- [task-duration.tsx](task-duration.tsx)

子智能体条目复用 [AgentAvatar](../../../shared/agent-avatar/README.md)，派发结果中的任务 ID 与列表、详情保持一致；尚无任务 ID 时保留通用图标。头像本地生成，任务状态与等待处理提示仍单独展示。

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../../AGENTS.md)。

子任务已关联 Task 时，活动行复用 agents/agent-task-model 的展示计算，预算耗尽不使用普通执行错误样式，tooltip 不放完整错误或报告。未取得 Task 的派出状态、活跃任务等待处理和原有会话打开行为保持；新 Run 的运行状态优先于旧失败元数据。
