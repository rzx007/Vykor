# 消息块与交互

集中维护一条消息的展示、编辑和操作，以及会话中的权限确认与提问。组件与直接使用的展示辅助代码放在本目录。

消息复制沿用共用操作按钮：处理中显示加载并禁止重复点击，成功保留短暂勾选并通过现有通知反馈，失败通知后可手动重试。助手复制反馈按消息 ID 隔离，卸载时清理计时器。消息分叉按钮只打开会话控制模块的确认弹窗，确认后才创建分支。

## 文件与入口

| 文件                                                                                                 | 职责                                     |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| [message-block.tsx](message-block.tsx)                                                               | 按角色选择用户、助手或系统消息展示       |
| [user-message.tsx](user-message.tsx)、[user-message-bubble.tsx](user-message-bubble.tsx)             | 用户正文、附件、编辑表单和长文本折叠     |
| [user-message-annotations.tsx](user-message-annotations.tsx)                                       | 已发送批注的数量入口和只读详情           |
| [user-display-items.ts](user-display-items.ts)、[plugin-mention-icon.tsx](plugin-mention-icon.tsx)   | 用户输入项展示和插件目录图标             |
| [assistant-message.tsx](assistant-message.tsx)                                                       | 助手正文、推理、工具调用和结果的组合     |
| [message-actions.tsx](message-actions.tsx)、[format-message-time.ts](format-message-time.ts)         | 工具栏、时间、复制、编辑和回复分叉操作   |
| [content-entrance.tsx](content-entrance.tsx)                                                         | 消息内容入场状态                         |
| [permission-card.tsx](permission-card.tsx)、[permission-presentation.ts](permission-presentation.ts) | 权限确认卡片、人工回复判断和审查信息解析 |
| [permission-stack.tsx](permission-stack.tsx) | 主聊天和侧边聊天共用的待处理卡堆与翻页操作 |
| [ask-user-card.tsx](ask-user-card.tsx)、[ask-user-payload.ts](ask-user-payload.ts)                   | 提问内容、回答表单和请求类型识别         |

## 调用流程与状态

对话记录调用 `MessageBlock`，由它选择 `UserMessage`、`AssistantMessage` 或已有系统通知。用户内容准备与编辑组件保留原有边界，内部草稿更新不会重新创建准备文档。编辑开关和草稿由内部组件保存，编辑期间通过上层 transcript 的 `useRetainTranscriptRow` 保留所在列表行；长文本展开状态归气泡，复制反馈归复制按钮。

用户消息通过浏览器分类的 `readBrowserAnnotationContext` 读取末尾完整、字段有效的批注快照。正文、复制和编辑初值均去掉自动追加的快照，保留插件等输入引用；原消息条目不变，供发送入口编辑重发时使用。`UserMessageAnnotations` 在独立正文气泡上方显示“n 条批注”，悬停或点击后通过已有 `Popover` 查看页面目标和意见。批注详情始终只读；编辑历史消息时沿用同一入口查看原批注，只允许修改正文。仅含批注时不显示空正文气泡。用于页面内搜索高亮的正文节点不含批注原始数据；无效或不在末尾的示例块仍按原文显示。

主聊天和侧边聊天用 `requiresPermissionReply` 筛出需要人工回复的请求，和当前会话的电脑应用授权一起交给 `PermissionStack`。输入框上方一次展示一张卡。多项待处理时，卡边和页码提示还有其他请求，用户可用前后按钮翻看。卡堆按请求 ID 记住当前项，新请求到达时保留阅读位置。当前项从队列移除后，优先展示它后面仍待处理的一项。翻页保留问卷中的答案，只在用户提交时回复该请求。提交状态、错误和授权结果由原请求的宿主提供。

权限卡片的标题说明要做什么，并保留工具原名。命令、文件路径等操作参数取自实际请求，审批原因和回复错误直接显示。长命令先展示开头，通过「展开完整命令」可查看原文和换行。「查看详情」另行提供开发检查范围和原始请求，过长的原始请求带截断提示。摘要解析放在 `permission-presentation.ts`。普通工具的「允许本次」只批准当前请求。

错误提示通过 `userActions.editing` 与 `onEditingChange` 控制最新用户消息的原编辑表单，不重建编辑器；重复打开保留未提交修改。打开和取消都不发送请求，只有用户明确提交才调用 `onEdit`。

新增消息组合和交互放在本目录，通用数据整理放 [models](../models/README.md)，完整工具内容的读取放 [tool-details](../tool-details/README.md)。测试放同层 [测试目录](__test__/)，涉及虚拟滚动或输入框的完整场景继续在 transcript、composer 中验证。返回[消息展示导航](../README.md)。

工具组标题不重复展示实时状态文案，运行中的状态只由 `TaskDuration` 展示；仍有工具进行中且未显示完成摘要时，标题文字保留原有流光效果，工具结束后停止，不加回 `LoadingState` 或 orb。未到汇总时机时，标题只显示最后一条工具的名称和参数；整轮结束或下一条 assistant 消息不含工具调用时，才切换为去重的“编辑了文件”“运行了命令”或两者组合，只读组显示“查看了内容”，不统计调用次数。单条工具行和已有诊断标记保留。

工具组标题、操作行与命令摘要统一使用正文的 `text-chat` 字号与字体，继承外观设置，只通过文字颜色区分层次。

空助手消息不渲染“正在生成回复...”占位文案，等待响应、生成回复和耗时统一由 transcript 中的 `TaskDuration` 展示。

工具组与单条工具详情的展开偏好复用 transcript 的会话内 `turnExpansion`，只保存是否展开，不保存完整结果。标题在最新工具与完成摘要之间切换时不重置展开；主动展开后按需读取历史详情，虚拟行重挂载不会丢失选择，也不会触发工具执行。
