# Agent 运行与事件接口

定义一次 Agent 运行需要的宿主能力、控制句柄，以及父子 Agent 交换的输入、结果和事件。

| 文件 | 用途 |
| --- | --- |
| [execution.ts](execution.ts) | 运行上下文、工具绑定、准备与释放、模型尝试准入和结算接口 |
| [children.ts](children.ts) | 子 Agent 预算、创建输入、控制句柄、结果及终止错误 |
| [events.ts](events.ts) | 模型流事件和带会话、运行、顺序号的 Agent 事件 |
| [delivery.ts](delivery.ts) | 可选输出合同、交付内容与区分格式校验/业务核验的回执 |

经 [../index.ts](../index.ts) 从 `@vykor/agent-contracts` 导出。宿主实现这些接口后，运行方可申请准备资源、调用模型与工具、发布事件，再通过 `AgentRunHandle.result` 返回结果。这里仅约定交互形式；它不实现这些运行步骤。

`AgentPostRunChildParent.childOutputContract` 是宿主为本次系统子 Agent 明确选择的合同，不属于可序列化的 `AgentChildSpawnInput`，也不从父 Agent 继承。`AgentChildResult.delivery` 返回实际的格式检查和宿主核验回执；核验通过与报告自身的业务结论分别表达。

运行句柄、子 Agent 目录、预算计数、事件顺序和模型尝试记录都由消费方管理。错误类只保存失败原因或限制值。新增运行相关定义放本目录，测试建议放同层 `__test__/`；跨分类测试放 [../__test__](../__test__/)。

`PreparedAgentRun.bindToolResults(finalTools)` 在最终工具范围确定、可靠 run.started 投影完成后创建结果读取能力，参数保留实际工具定义、来源和调用函数。模型和手动执行使用相同绑定函数，工厂不进入工具执行上下文。旧 `PreparedAgentRun.toolResults` 已弃用，暂保留公开兼容：最终绑定必须完整等价；收窄或替换来源、定义、调用函数后，旧存储不可用。新代码应使用工厂。


## 共用执行核心（阶段 A）

AgentChildInvocation 的 inputId/runId 是成功接纳后的必填身份。AgentChildRunSnapshot 与 readRun/waitRun 只观察固定轮次；JobInputReceipt 与 AgentInputReceipt 结构一致。

阶段 B 的 `AgentRunSettlement` 固定实际结果与停止时间；`AgentRunHandle.settled` 等待真实调用和清理，`result` 继续承接可靠保存错误。`observeInvocation` 把工具真实完成 Promise 交给当前 run。`cleanupUnconfirmed` 表示清理未确认，`projectionError` 表示已停止但结果尚未保存，二者均不创建新的执行状态或身份。
