# 对话会话控制

新对话入口、会话菜单、摘要和任务定位。

## 放置边界

会话级操作与弹层放在这里；全局会话事件桥接留在 shell。

组件、模型、类型和 hook 按本功能共同维护。测试、测试辅助文件和基准测试统一放在同级 `__test__`，沿用被测功能的文件名。

## 主要文件

- [new-conversation-start.tsx](new-conversation-start.tsx)：新对话输入及项目、分支、模型选择入口；挂载时创建随机头像身份，复用 [AoraAvatar](../../shared/aora-bot/README.md) 展示，输入和选项变化保持当前头像。
- [session-more-menu.tsx](session-more-menu.tsx)
- [session-summary-popover.tsx](session-summary-popover.tsx)
- [session-summary-work.tsx](session-summary-work.tsx)：展示当前聊天的应用、工作流和终端；点击沿用原面板。后台命令及其历史不进入工作摘要，也不触发摘要自动弹出，执行与记录保持不变。
- [session-summary-attention.ts](session-summary-attention.ts)：每次进入聊天按事项身份提醒一次，跳过已加载的应用和迟到历史任务；手动收起不清空记录。
- [use-session-summary-terminals.ts](use-session-summary-terminals.ts)：在消息行外读取和订阅当前聊天的真实终端，摘要收起时继续跟踪；不执行命令。

新事项优先展开右上角工作摘要，不自动打开右侧面板，也不抢编辑焦点。应用权限确认期间延后提醒；只有用户点击应用才定位原页面。变更、子智能体和资料来源继续使用原入口，消息列表保持原样。

摘要采用紧凑列表，只展示已有内容或真实错误；空分组、零计数和“暂无”占位不渲染，分隔线只出现在实际分组之间。顶部图标保留应用目录入口，不依赖已有应用。

## 维护约定

新增独立子功能时同步补充 README 和父级导航。移动文件时更新导入、动态导入与测试 mock，不保留旧路径转发文件。完整规则见 [Desktop 协作约定](../../AGENTS.md)。
