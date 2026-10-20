# 诊断设置

诊断信息、日志查看与展示格式。

## 放置边界

诊断页面及格式转换集中维护；日志采集和写入不放在设置组件。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [diagnostics-settings.tsx](diagnostics-settings.tsx)
- [diagnostics-log-viewer.tsx](diagnostics-log-viewer.tsx)
- [diagnostics-presentation.ts](diagnostics-presentation.ts)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
