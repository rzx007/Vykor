# 消息提示通知

重试、模型切换、用量、压缩和错误提示。

## 放置边界

这里放属于消息流的提示；桌面全局 toast 和通知偏好各归 shell 与 settings-page/notifications。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [run-error-notice.tsx](run-error-notice.tsx)
- [model-retry-notice.tsx](model-retry-notice.tsx)
- [context-compaction-divider.tsx](context-compaction-divider.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../../AGENTS.md)。
