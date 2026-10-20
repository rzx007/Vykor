# 笔记页面

笔记列表、详情、编辑、保存协调和恢复。

## 放置边界

笔记相关的组件与模型放在一起；通用文件预览留在 tools/files。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [notes-page.tsx](notes-page.tsx)
- [use-notes-controller.ts](use-notes-controller.ts)
- [note-save-coordinator.ts](note-save-coordinator.ts)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../AGENTS.md)。
