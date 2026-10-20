# 权限设置

权限偏好和审批管理界面。

## 放置边界

只维护权限设置交互；权限判断与审批执行仍由原有服务负责。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [permission-settings.tsx](permission-settings.tsx)
- [permission-approvals-dialog.tsx](permission-approvals-dialog.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
