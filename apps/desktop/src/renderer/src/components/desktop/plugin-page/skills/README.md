# Skill 管理

Skill 列表、详情、导出与官方技能市场。「浏览市场」与「已安装」沿用插件页的标签样式。在市场标题旁选择个人或当前项目，用列表行的按钮安装或更新；卸载入口在已安装的技能详情里。后台缺少市场接口时，页面提供「安全重启并重试」。

## 放置边界

维护 Skill 管理交互，不复制插件或 MCP 的管理流程。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [skill-manager.tsx](skill-manager.tsx)
- [skill-marketplace.tsx](skill-marketplace.tsx)
- [skill-detail.tsx](skill-detail.tsx)
- [skill-quick-start.ts](skill-quick-start.ts) 校验技能在项目中可用，再把引用放进新对话草稿。
- [skill-controls.tsx](skill-controls.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
