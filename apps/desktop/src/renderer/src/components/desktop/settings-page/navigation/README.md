# 设置导航与搜索

设置分类定义、导航和搜索匹配。

## 放置边界

这里维护分类与搜索行为；侧栏布局在 layout/settings-layout，具体表单留在各分类。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [settings-navigation.ts](settings-navigation.ts)
- [settings-search.ts](settings-search.ts)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
