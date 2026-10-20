# 对话记录与滚动

记录排列、虚拟列表、滚动定位、预览轨道和待提交提示。

## 放置边界

负责整段记录的显示与定位；单条消息的细节留在 message。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [transcript.tsx](transcript.tsx)
- [virtual-transcript.tsx](virtual-transcript.tsx)
- [conversation-scroller.tsx](conversation-scroller.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
