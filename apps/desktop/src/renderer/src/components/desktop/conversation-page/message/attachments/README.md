# 消息附件

消息附件、图片结果及读取图片的展示。

## 放置边界

只处理消息里的附件呈现；输入前的附件操作留在 composer，图片查看器留在 image-viewer。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [message-attachment.tsx](message-attachment.tsx)
- [image-generation-message.tsx](image-generation-message.tsx)
- [read-image-preview.tsx](read-image-preview.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../../AGENTS.md)。
