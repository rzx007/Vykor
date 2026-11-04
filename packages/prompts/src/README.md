# 系统提示词组装

公开入口为 `@vykor/prompts` 的 [index.ts](index.ts)，宿主通常调用 `buildRuntimeSystemPrompt()` 或 `buildPromptLayers()`。

| 文件 | 用途 |
| --- | --- |
| [index.ts](index.ts) | 默认提示词、环境和权限说明、项目规则发现、分层构建及公开导出 |
| [prompt-segments-assembly.ts](prompt-segments-assembly.ts) | 带来源分类的片段组装及层次转换 |
| [ledger-segments.ts](ledger-segments.ts) | `buildPromptLedgerSegments()`，为上下文用量估算提供片段 |
| [personal-prompt-files.ts](personal-prompt-files.ts) | 个人提示词检查、初始化、加载和用户资料更新 |
| [reply-styles.ts](reply-styles.ts) | 统一的回复沟通规则 |
| [__test__](__test__) | 提示词组装、文件行为和分类统计测试 |

构建时读取身份、环境、权限与技能清单，向上发现项目规则，再加载用户资料与项目事实，形成 `stable`、`context`、`volatile` 三层。`buildPromptLayers()` 追加调用方传入的项目记忆，`renderPromptLayers()` 按层拼成最终文本。用量估算片段使用同一组装来源，按设计排除完整项目记忆预览，可另加当轮记忆提醒。

默认回复语言通过 `@vykor/agent-contracts` 的 `buildResponseLanguageInstruction()` 在每次构建时取得，语言段放入稳定层的系统说明，并计入用量；旧构建入口同样动态生成，不在模块常量里固定语言。用户当前请求、个人资料和自定义指令中的明确语言偏好优先，后续指令内容保持原文。完整系统提示词覆盖的边界由运行时保留。

构建函数不保存会话。`SOUL.md`、`USER.md` 和 `user_profile_pending/*.json` 保存在配置目录，用户资料追加写入通过模块内队列串行执行。项目规则由项目文件提供，环境事实由 personalization 包保存，项目记忆由宿主管理。

后台工作指导要求独立外部检查各自设置请求时限并保存结果：短检查用独立 Shell 调用，较长检查才分别创建后台任务。等待到期只停止观察，代理应只处理受影响的任务并复用已完成结果；已有逐项超时、错误隔离和结果保存的批处理可以保留。快速模式要求一起发起独立工具调用，不把独立服务拼成共用时限的一条脚本。这些是模型执行指导，不增加任务超时字段或运行状态。

新增提示词段接入 `prompt-segments-assembly.ts`，文件相关行为放 `personal-prompt-files.ts`，对外 API 经 `index.ts` 导出。测试放同层 `__test__/`。返回[包说明](../README.md)。

`buildReplyStyleSection()` 生成统一表达规则，`buildWorkStyleSection()` 生成任务开场和进度规则。项目规则和用户明确偏好仍可调整表达。完整系统提示词覆盖由运行时处理。
