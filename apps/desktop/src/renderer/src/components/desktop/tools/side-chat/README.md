# 侧边聊天

临时侧边会话、引用选区和独立草稿交互。

## 放置边界

保留侧边会话的生命周期和作用域边界，复用主对话组件而不复制输入器。

消息图片与待发送图片分别使用本侧聊的记录和输入框作用域提供图库，不混入主聊天。图库携带 `canUseSideChatImageScope` 的只读检查：复用当前面板已校验的目标、草稿作用域和销毁状态，失效、卸载或正在销毁时拒绝旧图片反馈；不新增会话订阅或目标记录。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [side-chat-panel.tsx](side-chat-panel.tsx)
- [side-chat-selection-actions.tsx](side-chat-selection-actions.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
