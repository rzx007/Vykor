# 文件浏览

文件树、面包屑、搜索、文件预览和文件类型图标。

## 放置边界

管理文件如何被浏览与选择；代码编辑由 editor 提供，评审由 review 提供。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [files-tool.tsx](files-tool.tsx)
- [file-viewer.tsx](file-viewer.tsx)
- [project-file-tree.tsx](project-file-tree.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
