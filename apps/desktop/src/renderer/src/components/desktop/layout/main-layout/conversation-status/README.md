# 会话状态提示

主界面的会话运行状态及其展示模型。

## 放置边界

保持状态计算和展示相邻；消息内部的运行提示留在 conversation-page/message。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [conversation-status.tsx](conversation-status.tsx)
- [conversation-status-model.ts](conversation-status-model.ts)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../../AGENTS.md)。
