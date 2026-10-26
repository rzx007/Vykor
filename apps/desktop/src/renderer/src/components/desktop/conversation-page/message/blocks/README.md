# 消息块与交互

集中维护一条消息的展示、编辑和操作，以及会话中的权限确认与提问。组件与直接使用的展示辅助代码放在本目录。

## 文件与入口

| 文件                                                                                                 | 职责                                     |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| [message-block.tsx](message-block.tsx)                                                               | 按角色选择用户、助手或系统消息展示       |
| [user-message.tsx](user-message.tsx)、[user-message-bubble.tsx](user-message-bubble.tsx)             | 用户正文、附件、编辑表单和长文本折叠     |
| [user-display-items.ts](user-display-items.ts)、[plugin-mention-icon.tsx](plugin-mention-icon.tsx)   | 用户输入项展示和插件目录图标             |
| [assistant-message.tsx](assistant-message.tsx)                                                       | 助手正文、推理、工具调用和结果的组合     |
| [message-actions.tsx](message-actions.tsx)、[format-message-time.ts](format-message-time.ts)         | 工具栏、时间、复制、编辑和回复分叉操作   |
| [content-entrance.tsx](content-entrance.tsx)                                                         | 消息内容入场状态                         |
| [permission-card.tsx](permission-card.tsx)、[permission-presentation.ts](permission-presentation.ts) | 权限确认卡片、人工回复判断和审查信息解析 |
| [ask-user-card.tsx](ask-user-card.tsx)、[ask-user-payload.ts](ask-user-payload.ts)                   | 提问内容、回答表单和请求类型识别         |

## 调用流程与状态

对话记录调用 `MessageBlock`，由它选择 `UserMessage`、`AssistantMessage` 或已有系统通知。用户内容准备与编辑组件保留原有边界，内部草稿更新不会重新创建准备文档。编辑开关和草稿由内部组件保存，编辑期间通过上层 transcript 的 `useRetainTranscriptRow` 保留所在列表行；长文本展开状态归气泡，复制反馈归复制按钮。

主会话和侧聊用 `requiresPermissionReply` 筛选请求，再展示权限或提问卡片。自动审查进行中、已经自动决定或请求结束时不显示人工批准卡片。卡片通过原回调返回操作；提交状态、错误、会话记录和实际授权由宿主管理。权限批准仍使用 `once`，仅针对当前请求。

新增消息组合和交互放在本目录，通用数据整理放 [models](../models/README.md)，完整工具内容的读取放 [tool-details](../tool-details/README.md)。测试放同层 [测试目录](__test__/)，涉及虚拟滚动或输入框的完整场景继续在 transcript、composer 中验证。返回[消息展示导航](../README.md)。
