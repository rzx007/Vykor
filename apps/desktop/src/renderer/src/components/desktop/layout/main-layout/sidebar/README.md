# 主界面侧栏

项目和会话列表、项目菜单、展开状态与侧栏宽度。

## 放置边界

侧栏专属的展示和状态转换放在一起；对话正文和工具内容不要放入这里。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [sidebar.tsx](sidebar.tsx)
- [sidebar-controls.tsx](sidebar-controls.tsx)
- [sidebar-session-groups.tsx](sidebar-session-groups.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../../AGENTS.md)。

项目分组、默认展开和运行提示共用会话归属判断：有 `projectId` 时按项目 ID 归属，旧记录没有 ID 才回退目录比较。工作树目录不同也仍显示在原项目内；项目外和渠道会话继续留在各自分区。
