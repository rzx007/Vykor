# 外部打开方式

打开方式选择、图标、按钮和工作区打开动作。

## 放置边界

复用外部打开交互；不要加入文件树或终端本身的展示逻辑。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [index.ts](index.ts)
- [open-with-split-button.tsx](open-with-split-button.tsx)
- [use-workspace-openers.ts](use-workspace-openers.ts)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../AGENTS.md)。
