# Jobs Protocol Review 2026-08-17

> 状态：历史复盘，记录 2026-08-17 当时的实现。本文出现的 TaskManager、Workflow 文件快照和轮询等待已经被后续实现替换，不能作为当前 API 契约。当前协议见 [Jobs 统一后台任务协议](./jobs-protocol.md)，后续收口记录见 [Jobs Task/Workflow Convergence](./jobs-task-workflow-convergence.md)。

## 结论

方向正确，可以继续作为统一后台控制面使用。最重要的设计选择是没有新建 Job 状态库，而是让 Terminal、Task 和 Workflow 继续拥有自己的执行资源与原始状态；`DaemonJobService` 只做 owner 校验、快照转换和动作转发。

首次实现的主链路完整，但复盘确认了五个正确性问题，其中 Workflow 外部取消和 JobSend 越过能力边界属于高优先级。本文记录问题、修正和仍然存在的风险，避免后续只看到“大一统接口”而忽略 producer 自己必须满足的生命周期条件。

## 为什么这是一次大改

表面上只是增加五个工具，实际改变了四个边界：

1. 模型不再使用 `TerminalRead/Send/Signal/Close/List`，改用通用 `Job*`。
2. daemon 第一次用一个服务聚合 PTY、TaskManager durable projection 和 Workflow 文件快照。
3. Terminal 状态扩展为通用 Job 状态，并引入 `stopping` 与 sequence cursor。
4. Workflow 和 child task 开始承担明确的 owner session 与外部取消语义。

任何一层只改类型、不改真实运行行为，都会产生“接口说已经取消，后台仍在跑”这一类问题。

## 审查方法

本次没有只按 diff 看命名，而是逐条走了这些场景：

- 创建后能否从正确 owner 的 JobList 出现。
- read 的 cursor、截断和终态后读取是否一致。
- wait 在完成事件前后两个时序下是否都能结算。
- send/cancel 是否在服务端重新检查当前能力。
- producer 完成或取消后，迟到回调能否把终态重新打开。
- TaskManager 到 durable task 的映射在 ID 冲突时是否仍更新正确记录。
- HTTP 请求中断后，daemon wait 是否停止占用轮询。

## 做得好的部分

### 状态所有权没有重复

`DaemonJobService` 每次从 producer 读取新状态，没有把 `JobSnapshot` 持久化成第四份记录。这避免了 Terminal 已退出但 Jobs 仍显示 running 的双写问题。

### Agent owner 是绑定的

`createAgentHost(session)` 不只把 sessionId 当普通工具参数，而是把 host 固定到 root session，再检查每次调用的 owner。ID 泄露本身不能让一个 Agent 跨 session 操作工作。

### Terminal 取消状态更真实

取消先写 `stopping`，只有 PTY/process 的退出回调才写 `killed`。这比调用 kill 后立刻假装资源已经释放更可靠。

### 创建入口保持具体

保留 `TerminalOpen`、Task create 和 Workflow run，各自继续表达自己的创建参数；统一只发生在创建后的控制阶段，没有制造含糊的万能 `JobCreate`。

## 已确认并修正的问题

### P1：Workflow 取消后原调度器仍可能继续工作

原行为：`cancelPersistentWorkflow()` 修改文件快照并停止当前 worker，但启动这个 Workflow 的 `runWorkflow()` 仍然存活。当前 worker 结算后，它可能继续启动 ready task，并把取消快照覆盖成 running/completed。

修正：持久 Workflow 注册进程内 active control。取消开始时先写入 stop reason；scheduler 在每次派发前检查它，停止启动未开始任务；active run 的 snapshot/event callback 在 stop reason 存在时停止写回。最终取消快照仍由 `cancelPersistentWorkflow()` 保存。

回归场景：`maxConcurrency: 1` 的两个独立任务，在第一个运行时取消。断言第二个从未启动，原 Workflow promise 结算后持久快照仍是 `termination: cancelled`。

### P1：JobSend 没有执行 capabilities 边界

原行为：快照只给 running Agent 标记 `send: true`，但 service 对所有 Task 类型都调用 `TaskManager.writeToTask()`。更严重的是，TaskManager 可以按自己的语义重启一个已完成 Agent，于是调用方能绕过 Job 快照把终态任务重新拉起。

修正：`DaemonJobService.send()` 在进入 TaskManager 前要求 `type === agent && status === running`。running shell、dream 和 completed Agent 都会被拒绝。

### P2：Terminal wait 可能错过退出事件

原行为：先检查 running，再订阅 exit。如果进程恰好在两步之间退出，wait 看不到事件，只能错误地等到 timeout。

修正：订阅建立后再检查一次当前状态。这样退出发生在订阅前会被二次检查看到，发生在订阅后会被事件看到。

### P2：Task ID 冲突分支监听了错误记录

原行为：当 live Task ID 已被另一 session 的 durable task 占用时，投影会创建新 durable ID；初次同步使用新 ID，但后续 listener 又按 live ID 查 store，导致状态不再更新。

修正：`trackTask()` 同时保存 live task ID 和 durable task ID。事件按 live ID 过滤，写入始终使用 durable ID。

### P2：HTTP JobWait 未传播请求中断

原行为：client 取消 fetch 后，daemon 仍可能轮询到 timeout。

修正：route 把 `Request.signal` 传给 `DaemonJobService.wait()`；Terminal 订阅和 Task/Workflow polling 都会释放本次 wait，后台 job 本身不受影响。

## 状态与动作审查

| 场景 | 当前行为 | 结论 |
|---|---|---|
| Terminal 正常 exit 0 | `completed` | 正确 |
| Terminal 非 0 退出 | `failed` | 正确 |
| Terminal cancel 请求已发、进程未退 | `stopping` | 正确 |
| Terminal cancel 后真实退出 | `killed` | 正确 |
| Task pending | 投影为 `running`，不可 send，可 cancel | 可接受，协议主动状态被压成一种 |
| stopped/interrupted Task | `killed` | 正确 |
| cancelled Workflow | 原始 `failed + termination: cancelled` 投影为 `killed` | 正确 |
| JobWait timeout | 返回 `timedOut: true`，不取消 job | 正确 |
| owner 不匹配 | 在 producer 操作前失败 | 正确 |
| old Workflow 无 owner | 不进入 JobList，也不能 resolve | 正确 |

## 验证记录

本次新增或强化的聚焦测试覆盖：

- Terminal wait 订阅窗口内退出。
- running shell 与 completed Agent 拒绝 JobSend。
- durable ID 冲突后的持续 Task 投影。
- active Workflow 取消后不再启动 pending task，且终态不被覆盖。
- HTTP JobWait 传递 request abort signal。

最终验证结果：

- `@vykor/terminal-node`：4/4 tests passed。
- `@vykor/coordinator`：99/99 tests passed。
- `@vykor/server`：188/188 tests passed。
- 全仓 TypeScript：33/33 Turbo tasks passed，覆盖 34 个 package。
- `git diff --check` passed。

后续修改 Jobs、Terminal wait、Workflow scheduler 或 task projection 时，应继续把这些 package test 和全仓 `check-types` 作为合并门槛。

## 剩余风险

### P2：没有统一终态保留策略

Terminal 终态在 provider dispose 前一直保留，Task/Workflow 持久记录也会持续增长。长期 daemon 运行后，JobList 的数量与扫描成本会增加。

建议按 producer 制定 retention，再由 Jobs 支持 `includeFinished`、时间窗口或分页；不要直接在聚合层静默删除 producer 状态。

### P2：Task/Workflow wait 仍依赖轮询

50ms 轮询简单可靠，但并发 wait 增加后会放大 store 和文件读取。下一步应接 Task event 和 Workflow event source，保留相同 `JobWaitResult`。

### P2：Task/Workflow cursor 不是严格增量日志

Terminal cursor 是 chunk sequence；Task/Workflow cursor 是 `updatedAt`，有更新时返回当前视图。调用方若把所有 `text` 都直接拼接，会看到重复内容。

协议文档已经明确这个差异。更长期的方案是把输出模式写入快照，或为所有 producer 提供真正的 append-only output sequence。

### P3：Job ID 没有运行时全局唯一校验

Terminal UUID、`task_*` 和默认 Workflow run ID 在正常生成下互不冲突，但 Workflow 允许显式 runId。若人为构造与 task 相同的 ID，列表可能出现重名，resolve 会按 Terminal、Task、Workflow 顺序命中。

后续应选择一种明确方案：协议层 namespaced ID，或创建时做跨 producer 冲突检查。不要只依赖当前命名习惯。

### P3：Task listener 随历史任务增长

`SessionTaskBridgeManager` 当前为每个 tracked task 注册一个 listener。功能正确，但 manager 中历史任务很多时，每个事件会遍历更多 listener。

后续可改成每个 manager 一个 listener，加 `liveTaskId -> durableTaskId` Map，不需要改变 Jobs 协议。

### P3：没有 completion claim

JobList/Read 能看到终态，但没有“这个完成通知已经由谁消费”的记录。自动唤醒 Agent 时可能重复报告同一完成事件。

只有在引入自动 completion turn 时再增加 reported/claim 语义；当前不要为尚未存在的通知流程预建状态库。

## 后续顺序建议

1. 先观察真实使用中的 Job 数量、wait 并发和终态保留时间。
2. 增加 Task/Workflow 事件式 wait，替换 50ms 轮询。
3. 定义分页与 retention，不让 JobList 无限增长。
4. 在新增更多 producer 前确定 namespaced Job ID。
5. 只有自动完成通知落地时，再增加 claim/report 语义。

这次复盘后的边界可以概括为：统一控制，不统一执行；统一快照，不复制状态；取消必须真正传到活跃调度器，能力必须由服务端执行。
