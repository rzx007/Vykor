# 消息工具详情

Read、Shell 等工具调用的详情、结果和展开行。

## 放置边界

按工具类型维护消息内详情；通用消息组合留在 message，真实工具执行与独立面板分别留在服务层和 tools。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [index.tsx](index.tsx)
- [read-tool-row.tsx](read-tool-row.tsx)
- [shell-tool-details.tsx](shell-tool-details.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../../AGENTS.md)。
