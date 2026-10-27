# 工具面板容器

工具标签、打开请求、面板状态和运行时缓存。

## 放置边界

这里管理工具如何被打开与保留；工具本身的业务实现放在 tools 对应分类。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [utility-panel.tsx](utility-panel.tsx)
- [use-utility-panel-controller.ts](use-utility-panel-controller.ts)
- [use-utility-panel-runtime.ts](use-utility-panel-runtime.ts)：缓存标签快照，统一计算普通标签关闭后的标签、文件与当前选择。
- [use-utility-panel-close.ts](use-utility-panel-close.ts)：接收单关、Ctrl+W、关闭其他和关闭右侧请求，按文件、侧聊、普通标签、应用的顺序推进确认与关闭。

## 补充说明

- [UTILITY_PANEL.md](UTILITY_PANEL.md)

空白起始页不再列出应用和编排；新建菜单仍可打开这两项。右上角工作摘要聚合当前聊天的应用、工作流和长任务，明确点击后才通过原打开请求定位面板。

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../../AGENTS.md)。

MCP Apps 的“应用”入口显示当前会话可打开的应用，打开后生成独立页签。聊天中的具名入口也只打开或定位此处的页签。`PluginAppAnchor` 仅提供右侧面板内容区的位置；实际 iframe 始终挂在根路由的 `PluginAppsProvider`。切标签、折叠或切换会话都不卸载页面。关闭应用需确认未保存草稿风险，并走明确的服务端 close；旧 Native UI 入口已移除，其历史结果仅显示文字与停用提示。

旧 Native UI 已退役，历史记录只显示文字与停用提示；所有活页面由 `shell/plugin-apps` 使用官方 AppBridge 承载。

关闭请求只保存目标 ID、显式保留的目标、确认阶段、错误、忙碌状态及所属界面实例，不复制标签、页面和草稿。一次只处理一批关闭；切换会话或项目、离开返回、卸载后，旧请求不能再修改界面或推进下一项。具体文件保存、侧聊销毁和应用生命周期继续由原有业务入口处理。
