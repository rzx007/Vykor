# Agent 运行与事件接口

定义一次 Agent 运行需要的宿主能力、控制句柄，以及父子 Agent 交换的输入、结果和事件。

| 文件 | 用途 |
| --- | --- |
| [execution.ts](execution.ts) | 运行上下文、工具绑定、准备与释放、模型尝试准入和结算接口 |
| [children.ts](children.ts) | 子 Agent 预算、创建输入、控制句柄、结果及终止错误 |
| [events.ts](events.ts) | 模型流事件和带会话、运行、顺序号的 Agent 事件 |

经 [../index.ts](../index.ts) 从 `@vykor/agent-contracts` 导出。宿主实现这些接口后，运行方可申请准备资源、调用模型与工具、发布事件，再通过 `AgentRunHandle.result` 返回结果。这里仅约定交互形式；它不实现这些运行步骤。

运行句柄、子 Agent 目录、预算计数、事件顺序和模型尝试记录都由消费方管理。错误类只保存失败原因或限制值。新增运行相关定义放本目录，测试建议放同层 `__test__/`；跨分类测试放 [../__test__](../__test__/)。
