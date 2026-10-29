# 设置共享组件

设置行、帮助信息、状态与错误展示。

## 放置边界

仅抽取多个设置分类共同使用的界面约定；单项设置的校验留在所属分类。

`SettingsRow` 的 `description` 用于需要直接看到的作用范围、风险或状态；可选的 `help` 复用 `FieldHelp`，仅收纳必要的补充解释，支持悬停和键盘聚焦查看。名称和控件已能表达的内容直接省略，不为每行添加帮助入口。设置值及保存状态仍由各设置控件维护。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [settings-group.tsx](settings-group.tsx)
- [settings-status.tsx](settings-status.tsx)
- [field-help.tsx](field-help.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
