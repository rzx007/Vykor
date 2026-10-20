# 桌面搜索

全局搜索对话框及结果交互。

## 放置边界

这里处理跨会话搜索入口；文件搜索与设置搜索分别留在 tools/files 和 settings-page/navigation。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [desktop-search-dialog.tsx](desktop-search-dialog.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../AGENTS.md)。
