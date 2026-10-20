# 运行环境设置

运行环境选项、任务偏好及设置模型。

## 放置边界

同一运行选项的展示和转换相邻，不在表单里实现后台任务执行。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [runtime-settings.tsx](runtime-settings.tsx)
- [runtime-setting-control.tsx](runtime-setting-control.tsx)
- [runtime-setting-model.ts](runtime-setting-model.ts)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
