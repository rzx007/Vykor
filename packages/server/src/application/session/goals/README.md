# 会话目标推进

协调会话目标的启动、暂停、续跑和外部等待。

## 入口与流程

`SessionGoalService` 接收目标操作并安排下一次运行；等待核验器确认外部任务状态，观察器在等待条件变化时触发后续处理。

Run 正常结束、结构化交付状态、格式检查、宿主核验和 Goal 状态各自独立。`done` 不自动完成 Goal，`waiting` 不自动暂停或等待用户；Goal 仍按显式 `GoalUpdate`、预算和已有等待规则结算。如果同一 Run 的真实交付回执是 `partial`、`blocked` 或 `waiting`，却显式提交 `GoalUpdate.status=completed`，服务把 Goal 暂停，记录 `run_error` 并说明矛盾，供核对后续做。

普通自动续跑前检查本轮已确认的结果。成功工具的名称、输入、结果正文和已核验的文件变更事实组成本轮指纹，忽略调用 ID、结果引用及诊断 metadata；没有工作工具时，以最终回复作为纯文字交付。最近 64 轮中已出现的结果不算新增，连续三轮没有新增结果便暂停并记录 `no_progress`。失败工具和 Goal 状态查询不算执行进展；有工作工具时，改写总结不能替代新的工具结果。每轮只保存一个指纹，工具很多时也不会扩大后续运行携带的状态。

这是一项针对近期重复执行的续跑安全条件，不替代模型对任务含义、完成或真实阻塞的判断。文字改写、正文中的动态字段、不同的工具组合及超出窗口的长周期可能被识别为新结果，不承诺自动判断所有语义上的空转。

## 状态归属

目标、评估和等待事实保存在目标与运行存储中，等待观察的订阅和计时器保存在服务实例中。交付回执来自运行事件投影器写入的 Run `metadata.delivery`，不从普通输出文字推断。

`metadata.goalProgress` 保存有限结果窗口和无新增结果次数，并只传给下一次普通自动运行；不保存工具正文，不新增数据库表。用户消息、正文修改、手动恢复和外部等待唤醒不继承此状态。消息查询按本次 Run 过滤后再返回，避免复制完整旧会话。显式控制请求、权限、预算和自动次数限制仍按原有优先级结算。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [goal-external-wait-observer.ts](./goal-external-wait-observer.ts) | `GoalWaitObservationResult`、`sameGoalExternalWait`、`GoalExternalWaitObserver` |
| [goal-wait-verifier.ts](./goal-wait-verifier.ts) | `GoalWaitCheck`、`GoalWaitVerifier` |
| [goal-run-progress.ts](./goal-run-progress.ts) | 提取已确认结果，判断是否允许继续自动运行 |
| [session-goal-service.ts](./session-goal-service.ts) | `SessionGoalService` |

## 测试与维护

会话目标调度与等待规则放在这里；面向 Agent 的目标工具放在 application/goals。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
