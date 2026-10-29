# 主界面布局

主界面组合入口、上下文和面板切换。

## 放置边界

侧栏、会话状态和工具面板分别放入对应子目录，避免主入口继续膨胀。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [main-layout.tsx](main-layout.tsx)
- [main-layout-context.ts](main-layout-context.ts)
- [index.ts](index.ts)

## 子分类

- [会话状态提示](conversation-status/README.md)：主界面的会话运行状态及其展示模型。
- [主界面侧栏](sidebar/README.md)：项目和会话列表、项目菜单、展开状态与侧栏宽度。
- [工具面板容器](utility-panel/README.md)：工具标签、打开请求、面板状态和运行时缓存。

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。

全文搜索的消息定位目标由 MainLayout 短期保存，只包含目标聊天、消息 ID 和关键词；聊天加载完成后由 ConversationFind 消费。普通会话导航清除该目标，消息和持久化存储不保存查找状态。
