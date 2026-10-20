# 图片查看与标注

图片来源、查看器、面板和标注状态。

## 放置边界

图片查看和标注的完整交互放在这里，消息附件与浏览器只负责调用入口。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [image-viewer.tsx](image-viewer.tsx)
- [image-viewer-provider.tsx](image-viewer-provider.tsx)
- [image-viewer-panel.tsx](image-viewer-panel.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../AGENTS.md)。
