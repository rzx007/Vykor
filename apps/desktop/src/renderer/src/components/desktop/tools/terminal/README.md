# 终端工具

终端展示、会话输入、偏好、主题和链接处理。

## 放置边界

界面适配与终端展示模型放在这里；底层进程和终端服务留在原有服务模块。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [terminal-tool.tsx](terminal-tool.tsx)
- [terminal-context-menu.tsx](terminal-context-menu.tsx)
- [terminal-preferences.ts](terminal-preferences.ts)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
