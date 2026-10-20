# 代码上下文

代码选区的格式、元数据和添加到输入框的动作。

## 放置边界

这里只处理跨编辑器和评审复用的选区上下文，不接管编辑内容或补丁加载。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [code-selection-actions.ts](code-selection-actions.ts)
- [code-selection-context.ts](code-selection-context.ts)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
