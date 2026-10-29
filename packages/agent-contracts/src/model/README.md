# 模型请求与用量契约

让模型客户端、运行引擎和用量记录使用同一组字段，不依赖具体模型提供商的实现。

| 文件 | 用途 |
| --- | --- |
| [model.ts](model.ts) | 流式请求接口、生成身份、重试时间和尝试结算数据 |
| [errors.ts](errors.ts) | 失败分类、可重试信息和 `ModelRequestFailure` 错误 |
| [usage.ts](usage.ts) | 用量快照、完整性标记和成本统计接口 |
| [context-usage.ts](context-usage.ts) | 上下文分组及用于估算的文本片段 |

这些定义由 [../index.ts](../index.ts) 从 `@vykor/agent-contracts` 导出。消费方调用 `StreamingMessageClient.streamMessage` 获取事件流，按 `generationId` 和 `attempt` 区分生成与重试，再记录结算用量。重试等待和成本累加由实现方执行，本目录不发起网络请求。

用量计数、重试计时器和请求历史由消费方保存。`usageIncomplete` 表示数值只是已知小计，未知用量不能填成零。新增相关定义放本目录，测试放 [__test__](__test__/)。

`ModelFailureInfo.contextLengthExceeded` 保存超长分类：`true` 表示上下文超长，`false` 表示具体错误码确认是其他问题，缺省表示尚未分类。`isContextLengthExceededMessage()` 是 API 与 Core 共用的文字兜底，只识别实际错误说明开头的溢出描述，不匹配被引用的工具名或字段名。分类与传输阶段无关，不授权跳过预算检查，也不能作为零用量证明。
