# 消息块与交互

集中维护一条消息的展示、编辑和操作，以及会话中的权限确认与提问。组件与直接使用的展示辅助代码放在本目录。

消息复制沿用共用操作按钮：处理中显示加载并禁止重复点击，成功保留短暂勾选并通过现有通知反馈，失败通知后可手动重试。助手复制反馈按消息 ID 隔离，卸载时清理计时器。消息分叉按钮只打开会话控制模块的确认弹窗，确认后才创建分支。

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

权限卡片从请求的 `payload.input` 提取实际命令、工作目录、文件路径、网址、目标或操作，并显示 `payload.reason`；未提供的信息不补猜。操作文案只精确匹配真实内置名称，第三方大小写变体使用中性的“运行工具”，始终保留请求中的工具原名。默认收起的“原始详情”保留请求内容，使用纯文本和有界显示，过长时提示截断。摘要解析和长度限制放在 `permission-presentation.ts`，展开状态由原生 `details` 控件管理，不触发授权回复。

错误提示通过 `userActions.editing` 与 `onEditingChange` 控制最新用户消息的原编辑表单，不重建编辑器；重复打开保留未提交修改。打开和取消都不发送请求，只有用户明确提交才调用 `onEdit`。

新增消息组合和交互放在本目录，通用数据整理放 [models](../models/README.md)，完整工具内容的读取放 [tool-details](../tool-details/README.md)。测试放同层 [测试目录](__test__/)，涉及虚拟滚动或输入框的完整场景继续在 transcript、composer 中验证。返回[消息展示导航](../README.md)。

工具组标题不重复展示实时状态文案，运行中的状态只由 `TaskDuration` 展示；仍有工具进行中且未显示完成摘要时，标题文字保留原有流光效果，工具结束后停止，不加回 `LoadingState` 或 orb。未到汇总时机时，标题只显示最后一条工具的名称和参数；整轮结束或下一条 assistant 消息不含工具调用时，才切换为去重的“编辑了文件”“运行了命令”或两者组合，只读组显示“查看了内容”，不统计调用次数。单条工具行和已有诊断标记保留。

工具组标题、操作行与命令摘要统一使用正文的 `text-chat` 字号与字体，继承外观设置，只通过文字颜色区分层次。

空助手消息不渲染“正在生成回复...”占位文案，等待响应、生成回复和耗时统一由 transcript 中的 `TaskDuration` 展示。

工具组与单条工具详情的展开偏好复用 transcript 的会话内 `turnExpansion`，只保存是否展开，不保存完整结果。标题在最新工具与完成摘要之间切换时不重置展开；主动展开后按需读取历史详情，虚拟行重挂载不会丢失选择，也不会触发工具执行。
