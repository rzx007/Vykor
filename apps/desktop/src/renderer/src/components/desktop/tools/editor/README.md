# 代码编辑器

虚拟化代码展示、编辑草稿、保存和布局模型。

## 放置边界

编辑会话和保存逻辑放在一起；文件树和文件类型选择留在 files，补丁评审留在 review。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [virtualized-code-preview.tsx](virtualized-code-preview.tsx)
- [code-preview-drafts.ts](code-preview-drafts.ts)
- [code-preview-save.ts](code-preview-save.ts)

## 滚动与状态

文件预览从 files 的 `FileViewer` 进入 `VirtualizedCodePreview`。`CodeView` 根节点直接承载滚动，Pierre 根据同一节点的滚动位置和可见高度切换渲染行，并在内部保留完整文件的占位高度；不要在外层另套滚动容器。搜索结果和指定行也通过它的 `scrollTo` 定位。编辑内容与保存状态保存在 `code-preview-drafts.ts`，滚动不会重建文件或草稿。

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
