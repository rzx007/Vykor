# 存储设置

存储占用、附件清理、格式化和图形展示。

## 放置边界

存储设置的计算与展示相邻；实际文件读写留在主进程或原有服务。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [storage-settings.tsx](storage-settings.tsx)
- [attachment-storage-settings.tsx](attachment-storage-settings.tsx)
- [storage-visuals.tsx](storage-visuals.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
