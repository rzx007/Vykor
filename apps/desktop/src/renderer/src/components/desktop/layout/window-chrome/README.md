# 窗口标题栏

标题栏及桌面窗口边框相关行为。

## 放置边界

窗口拖拽和平台差异放在这里；业务页面的工具栏不属于窗口标题栏。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [title-bar.tsx](title-bar.tsx)
- [use-desktop-window-chrome.ts](use-desktop-window-chrome.ts)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
