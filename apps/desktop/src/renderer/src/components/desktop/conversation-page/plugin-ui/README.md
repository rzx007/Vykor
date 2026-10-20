# 对话插件界面

插件卡片、嵌入页面、桥接与显示生命周期。

## 放置边界

这里呈现会话内插件界面；安装和配置插件放在 plugin-page，主进程权限校验不移入界面层。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [plugin-ui-provider.tsx](plugin-ui-provider.tsx)
- [plugin-ui-card.tsx](plugin-ui-card.tsx)
- [plugin-ui-frame.tsx](plugin-ui-frame.tsx)

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
