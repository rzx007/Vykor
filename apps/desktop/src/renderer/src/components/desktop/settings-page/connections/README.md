# 外部连接设置

连接渠道、飞书连接详情和配置弹层。

## 放置边界

外部渠道的设置界面放在这里，运行时消息收发不放进设置组件。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [connections-settings.tsx](connections-settings.tsx)
- [connection-channel-row.tsx](connection-channel-row.tsx)
- [feishu-connection-dialog.tsx](feishu-connection-dialog.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
