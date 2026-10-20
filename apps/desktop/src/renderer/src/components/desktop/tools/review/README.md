# 差异评审

补丁加载、差异展示、改动导航、选区和已审阅标记。

## 放置边界

补丁相关的模型与组件相邻，不把当前文件编辑草稿放入评审模块。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [review-tool.tsx](review-tool.tsx)
- [review-diff-preview.tsx](review-diff-preview.tsx)
- [reviewed-files.ts](reviewed-files.ts)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
