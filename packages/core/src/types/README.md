# Core 接口与配置类型

`runtime.ts` 描述 core 需要调用方提供什么，以及查询引擎对调用方开放哪些操作。

| 类型 | 用途 |
| --- | --- |
| `QueryEngine` | 引擎接口，公开入口以 `IQueryEngine` 导出，区分具体实现类 |
| `QueryEngineOptions` | 构造参数，包括模型、工具、权限检查、回调和执行环境 |
| `QueryRequestConfiguration` | 单次请求边界采用的模型、提示词、工具与限制配置 |
| `MemoryRetriever` | 向查询引擎提供相关记忆的接口 |

这里描述接口，不保存运行状态。`engine/query-engine.ts` 实现引擎接口，`session/` 和外部调用方依赖这些约定。

`QueryRequestConfiguration.replyStyle` 记录本次请求已采用的表达偏好，供 Node 层为子 Agent 推导当前配置；具体提示词内容仍由 prompts 包生成。

只把 core 自身的配置和接口放在这里。跨包共用的消息、事件与工具定义放在 `@vykor/agent-contracts`，本机配置放在 `@vykor/host-config`。类型相关测试放在同层 `__test__/`，包括推理内容的事件与消息约定检查。
