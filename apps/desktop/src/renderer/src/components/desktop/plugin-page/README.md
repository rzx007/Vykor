# 扩展管理页面

插件、Skill 和 MCP 的管理入口。

## 放置边界

根目录保留页面入口，三类扩展分别放入子目录。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [index.ts](index.ts)
- [plugin-page.tsx](plugin-page.tsx)

## 子分类

- [MCP 管理](mcp/README.md)：MCP 配置、编辑表单和管理列表。
- [插件管理](plugins/README.md)：插件列表、详情、编辑、模板和快速开始。
- [扩展共享展示](shared/README.md)：扩展目录和多个界面复用的图标展示。
- [Skill 管理](skills/README.md)：Skill 列表、详情、导出与相关控件。

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../AGENTS.md)。
