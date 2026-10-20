# 终端设置

默认终端、Shell 选择和终端偏好。

## 放置边界

这里维护设置界面；终端显示、复制粘贴和会话操作留在 tools/terminal。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [terminal-settings.tsx](terminal-settings.tsx)
- [default-terminal-shell-control.tsx](default-terminal-shell-control.tsx)
- [resolve-selected-terminal-shell.ts](resolve-selected-terminal-shell.ts)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
