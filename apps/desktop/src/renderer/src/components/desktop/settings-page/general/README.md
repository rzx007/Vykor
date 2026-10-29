# 常规设置

对话显示、常用偏好、自动启动、编辑器和快捷键设置。

## 放置边界

适合轻量的常规偏好；形成独立复杂功能后移入专门分类，避免重新变成大杂烩。

编辑器偏好属于低频选项，放在常规设置的“高级选项”内，默认折叠。设置行使用统一的标题和分隔线，不重复解释名称或当前控件已经表达的含义。工作风格和思考过程的补充说明通过标题旁的帮助入口查看；生效范围、风险、草稿保留和保存状态仍直接显示。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [general-settings.tsx](general-settings.tsx)
- [general-display-controls.tsx](general-display-controls.tsx)
- [editor-settings.tsx](editor-settings.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
