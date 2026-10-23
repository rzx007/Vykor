# 协调模式与通知

负责判断协调模式、生成该模式的提示词与用户上下文，以及格式化任务通知。

| 文件 | 用途 |
| --- | --- |
| [coordinator-mode.ts](coordinator-mode.ts) | 模式恢复、工具清单、系统提示词和 worker 上下文 |
| [mode-state.ts](mode-state.ts) | `COORDINATOR_MODE_ENV` 与 `isCoordinatorMode()` |
| [system-prompt.ts](system-prompt.ts) | `COORDINATOR_SYSTEM_PROMPT` 静态提示词 |
| [task-notification.ts](task-notification.ts) | `formatTaskNotification()`、`parseTaskNotification()` |
| [types.ts](types.ts) | `TaskNotification` 类型 |
| [__test__](__test__) | 协调模式行为测试 |

宿主通过 `@vykor/coordinator` 的 [`../index.ts`](../index.ts) 调用上述 API；模式辅助函数还可以从 `@vykor/coordinator/coordinator-mode` 导入。恢复会话时，`matchSessionMode()` 将模式同步到进程环境变量；随后按简单模式和宿主工具上限生成提示词上下文。任务完成后，通知函数把结构化结果转为可传递的文本，接收方再解析。

本目录只修改进程环境中的模式状态，提示词和通知转换不保存会话。会话模式的长期保存由宿主负责。新增模式、提示词和任务通知逻辑放在本目录，测试放同层 `__test__/`。返回[源码导航](../README.md)。
