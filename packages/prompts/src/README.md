# 系统提示词组装

公开入口为 `@vykor/prompts` 的 [index.ts](index.ts)，宿主通常调用 `buildRuntimeSystemPrompt()` 或 `buildPromptLayers()`。

| 文件 | 用途 |
| --- | --- |
| [index.ts](index.ts) | 默认提示词、环境和权限说明、项目规则发现、分层构建及公开导出 |
| [prompt-segments-assembly.ts](prompt-segments-assembly.ts) | 带来源分类的片段组装及层次转换 |
| [ledger-segments.ts](ledger-segments.ts) | `buildPromptLedgerSegments()`，为上下文用量估算提供片段 |
| [personal-prompt-files.ts](personal-prompt-files.ts) | 个人提示词检查、初始化、加载和用户资料更新 |
| [reply-styles.ts](reply-styles.ts) | 共享沟通规则与协作、直接、讲解三档表达规则 |
| [__test__](__test__) | 提示词组装、文件行为和分类统计测试 |

构建时读取身份、环境、权限与技能清单，向上发现项目规则，再加载用户资料与项目事实，形成 `stable`、`context`、`volatile` 三层。`buildPromptLayers()` 追加调用方传入的项目记忆，`renderPromptLayers()` 按层拼成最终文本。用量估算片段使用同一组装来源，按设计排除完整项目记忆预览，可另加当轮记忆提醒。

构建函数不保存会话。`SOUL.md`、`USER.md` 和 `user_profile_pending/*.json` 保存在配置目录，用户资料追加写入通过模块内队列串行执行。项目规则由项目文件提供，环境事实由 personalization 包保存，项目记忆由宿主管理。

新增提示词段接入 `prompt-segments-assembly.ts`，文件相关行为放 `personal-prompt-files.ts`，对外 API 经 `index.ts` 导出。测试放同层 `__test__/`。返回[包说明](../README.md)。

`reply-styles.ts` 只拼接四条共用规则和选中档的简短表达偏好，不包含字数或段落配额、内部清单流程及校准示例。共用规则保留事实和限制，所选档只调整表达；判断、行动、验证继续遵循原有 Agent 规则。

`buildReplyStyleSection()` 每次只生成一套有效风格，放在通用指导之后、稳定层末尾，并计入上下文用量，不增加模型调用。`buildWorkStyleSection()` 单独规定进度消息时机。个人指令和当轮用户要求可以调整默认表达，完整系统提示词覆盖由运行时处理；真实遗漏与事实越界仍需实际评估。
