# 设置页面布局

设置页框架、导航侧栏和内容区域排列。

## 放置边界

负责布局与导航展示，具体设置表单放在 settings-page。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [index.ts](index.ts)
- [settings-layout.tsx](settings-layout.tsx)
- [settings-sidebar.tsx](settings-sidebar.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
