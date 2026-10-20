# 桌面更新

桌面更新状态与更新提示控件。

## 放置边界

更新展示及状态接入集中维护，下载和安装流程留在对应主进程服务。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [update-status-capsule.tsx](update-status-capsule.tsx)
- [use-desktop-update-state.ts](use-desktop-update-state.ts)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../AGENTS.md)。
