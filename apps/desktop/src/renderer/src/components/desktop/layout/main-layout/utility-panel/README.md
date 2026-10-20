# 工具面板容器

工具标签、打开请求、面板状态和运行时缓存。

## 放置边界

这里管理工具如何被打开与保留；工具本身的业务实现放在 tools 对应分类。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [utility-panel.tsx](utility-panel.tsx)
- [use-utility-panel-controller.ts](use-utility-panel-controller.ts)
- [use-utility-panel-runtime.ts](use-utility-panel-runtime.ts)

## 补充说明

- [UTILITY_PANEL.md](UTILITY_PANEL.md)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../../AGENTS.md)。
