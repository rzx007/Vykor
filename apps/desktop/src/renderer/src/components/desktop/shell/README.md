# 桌面全局行为

会话事件桥接、全局快捷键和通知宿主。

## 放置边界

放置贯穿桌面生命周期的事件接入；页面自己的交互放回页面分类。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [desktop-session-event-bridge.tsx](desktop-session-event-bridge.tsx)
- [use-desktop-shortcuts.ts](use-desktop-shortcuts.ts)
- [desktop-toast-host.tsx](desktop-toast-host.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../AGENTS.md)。

- [plugin-apps](plugin-apps/README.md)：根节点拥有 MCP Apps 常驻 iframe，侧栏只提供位置；Main 保留原会话、后台和操作权限。
