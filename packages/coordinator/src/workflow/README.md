# 工作流调度

按依赖、并发、写入范围和预算限制执行多项任务。公开入口为 `@vykor/coordinator/workflow` 的 [index.ts](index.ts)，其中主要 API 也由包根入口导出。

| 文件 | 用途 |
| --- | --- |
| [model.ts](model.ts) | `WorkflowSpec`、任务、运行结果、快照和事件类型 |
| [input.ts](input.ts) | 把工具输入解析为工作流配置和操作 |
| [validation.ts](validation.ts) | 校验依赖、执行模式和写入范围，生成执行计划 |
| [runner.ts](runner.ts) | `runWorkflow()`，挑选就绪任务并控制并发和失败处理 |
| [task-runner.ts](task-runner.ts) | 单任务执行、重试、超时和进度限制 |
| [budget.ts](budget.ts) | 预算预设、用量汇总和限制判断 |
| [snapshot.ts](snapshot.ts) | 运行标识、状态快照、结果与摘要转换 |
| [notification.ts](notification.ts) | 工作流通知的文本格式化与解析 |
| [reconciliation.ts](reconciliation.ts) | 检查任务改动重叠并生成后续处理计划 |
| [repository.ts](repository.ts) | `WorkflowRunRepository`，由宿主实现的保存与读取接口 |
| [store-decoding.ts](store-decoding.ts) | 从持久化 JSON 读取并校验快照和事件 |
| [__test__](__test__) | 调度、预算、恢复和结果处理测试 |

调用方传入配置和单任务 runner。调度器先校验并生成计划，再执行依赖已完成的任务，处理重试、失败和预算，最终返回 `WorkflowRunResult`。运行期间的事件与快照经回调交给宿主。

就绪队列、运行任务、阻塞原因和结果由 `runWorkflow()` 在内存中保存。`WorkflowRunRepository` 只约定保存、读取、领取运行权和等待变更等操作，磁盘或数据库实现属于宿主，当前目录没有 `store.ts`。

调度通用规则与数据转换放在本目录，具体 worker、工作目录和存储实现放在相应宿主模块。测试放同层 `__test__/`。返回[源码导航](../README.md)。

attempt deadline 和唯一 5 秒清理宽限由 task-runner 持有。宽限到期只发布 cleanupUnconfirmed，原 runner 尚未确认实际停止就继续等待；未知停止异常不进入下一次尝试。一次 attempt 结束后，其迟到 progress 不再改写新 attempt。默认 child runner 的查询失败带 retryable=false，不建立替代 worker；显式自定义 runner 也必须如实报告未确认清理。
