# Agent Run Events / Effects 实施计划

> 状态：已完成。当前架构见 [Vykor Agent SDK](../../agent-sdk.md) 与 [Agent Runtime Framework Architecture](../../agent-runtime-framework-architecture.md)。
>
> 迁移原则：**不做兼容**。不提交双 public API、deprecated alias、daemon adapter 或旧 projection fallback；每个提交都必须通过相关 typecheck/tests。

## 目标

把当前：

```text
daemon creates AgentRunHost + AgentChildProjection
  -> framework calls daemon methods during execution
```

替换为：

```text
framework owns AgentRunHandle / AgentChildHandle
  -> emits ordered AgentEvent
  -> awaits AgentEffects only when a result is required
daemon consumes events and projects durable state
```

## 改造前基线

- root：`SessionRunExecutor -> DaemonRunProjection.createHost -> VykorAgent.submitMessage`。
- permission：`QueryEngine -> AgentRunHost.requestPermission -> StorePermissionBroker`。
- steer：`mergeWake -> wakeCount -> drainSteeredInputs -> pullFollowUps`。
- child：`AgentChildManager <-> AgentChildProjection <-> DaemonChildAgentProjection`。
- live child：`LiveChildAgentRegistry` 保存 daemon 收到的 `AgentChildControls`。
- durable transcript：`SessionTranscriptProjection` 已经是可保留的窄 reducer。

## Task 1：一次性切换 framework execution API

- [x] 在 core/agent-runtime 定义 serializable `AgentEvent` union、event envelope、`AgentEventSource`、`AgentEffects`、`AgentRunHandle`、`AgentChildHandle`。
- [x] `VykorAgent.submitMessage()` 改为返回 active `AgentRunHandle`；`runMessage()` 作为 await-result convenience API。
- [x] event source 支持一个 agent-level ordered/awaited required subscriber；terminal event 被消费后才 settle `run.result`。
- [x] agent-level effects 在 child agent 中继承；无 permission effect 时默认 denied。
- [x] 将 provider `StreamEvent` 在 framework 内归一化为 output/tool/usage/run events；error 改为 serializable DTO。
- [x] 将 QueryEngine/tool/workflow 的 `QueryRuntimeHost` 改为 framework internal execution context。
- [x] 删除 `AgentRunHost`、`QueryRuntimeHost` application contract、`AgentSessionHostCallbacks` 和 `composeAgentRunHost()`。
- [x] 更新 framework tests：direct run、event ordering、listener failure、permission effect、interrupt、steer、terminal barrier。

退出标准：

- 单进程代码可以 `const run = agent.submitMessage("hi"); await run.result`。
- framework package 不需要 daemon 提供任何 host 才能执行工具和 child。
- public declarations 中不存在旧 host contract。

## Task 2：一次性切换 daemon root run 与 permission

- [x] 新增单入口 `DaemonAgentEventProjector.apply(event)`，复用 `SessionTranscriptProjection`、store、event publisher 和 observability。
- [x] daemon Agent loader 创建 agent 时注入 `requestPermission` 与可靠 `onEvent` sink，并在返回 agent 前恢复 history、绑定 projector；`AgentPool` 只缓存完整实例。
- [x] `SessionRunExecutor` 只 acquire agent、submit admitted IDs、注册 active run handle、await result 和处理基础设施兜底。
- [x] permission effect 直接调用 `StorePermissionBroker.ask(context + request + signal)`；保留现有 durable request、lineage、HTTP reply 和 expiration 语义。
- [x] `SessionRunCoordinator` 保存 active run handle 引用；steer 直接调用 `run.steer()`，interrupt 调用 `run.interrupt()`。
- [x] handle 注册前已 durable admit 的 steer 在 lane 中按顺序暂存，`registerActiveHandle()` 后主动 flush；用 `input.accepted` event 绑定 input/run。
- [x] 删除 `DaemonRuntimeHostPort`、`DaemonRunProjection`、对应 factory/context/test。
- [x] 删除 `wakeCount`、`drainSteeredInputs()`、`pullFollowUps()` 的 root run 回拉链路。
- [x] 更新 server tests：admit/run、delta transcript、tool part、failed run、permission、steer、interrupt、pool eviction/restart。

退出标准：

- TUI 发送 `hi` 的 durable transcript/SSE 行为不变。
- root run 的 framework -> daemon 调用只剩 event subscription 和 permission effect。
- server 源码不再 import `AgentRunHost`。

## Task 3：一次性切换 child lifecycle

- [x] `AgentChildManager` 直接生成 canonical `childId/sessionId/inputId/runId`，暴露 `agent.children` directory。
- [x] child tool 返回/接收 `childId`；删除 daemon `taskId` 作为 framework alias 的行为。
- [x] child create/run/suspend/resume/close 使用统一 `AgentEvent`，descendant event 汇入 root agent event source。
- [x] 把 worktree acquire/release 移入 agent-runtime 的 `ChildEnvironmentProvider`；daemon 只投影 worktree metadata。
- [x] `DaemonAgentEventProjector` 根据 child events 创建/更新 durable child session/input/run/task/transcript。
- [x] durable task 保存 `childId`；task input/stop 和 child HTTP route 通过 `agent.children` directory 路由。
- [x] 删除 `AgentChildProjection`、所有 projection handle/state、`DaemonChildAgentProjection`、`ChildAgentProjectionFactory`。
- [x] 删除 controls 注册式 `LiveChildAgentRegistry`；如仍需索引，只保存 root agent/session 与 childId，不复制 controls。
- [x] 更新 child tests：follow-up、active steer、parent abort、idle suspend/resume、required event failure、worktree cleanup，并由 server integration 覆盖 durable child follow-up。

退出标准：

- framework child 在无 daemon 环境下完整运行。
- daemon 不向 framework 返回 session/task/run/host/opaque state。
- framework event 中不存在 function、Promise、AbortSignal 或 controls。

## Task 4：数据一致性与清理

- [x] projector 按 framework event ID 做当前进程幂等投影；实体 ID 重放执行 create-or-validate，相同 ID 不同 payload 失败关闭。
- [x] 验证 root daemon-assigned ID 与 child framework-assigned ID 共用同一 durable namespace。
- [x] output delta 通过 ordered/awaited event bus 串行投影，复用 transcript delta 边界测试。
- [x] 验证 required listener 失败时 live run 失败，executor 对未终态 durable run 执行 failed/interrupted fallback。
- [x] 验证 listener failure 不会通过同一个失败 listener 递归发送 terminal event。
- [x] 删除旧测试 fixture、导出、文件和文档中的 `AgentRunHost` / `DaemonRunProjection` / `AgentChildProjection` 当前链路描述。
- [x] 将本文标记完成，并把目标架构文档状态改为“当前实现”。
- [x] 更新 `daemon-application-architecture.md`、`agent-runtime-framework-architecture.md`、`agent-framework-capability-boundary.md`、`permission-flow.md`、`agent-child-session-flow.md`。

退出标准：

- `rg "AgentRunHost|DaemonRuntimeHostPort|AgentChildProjection|DaemonChildAgentProjection|pullFollowUps|wakeCount" packages` 只允许历史迁移说明中出现，生产代码为零。
- 全量 package typecheck 通过。
- framework、server、client、frontend 的 run/permission/child integration tests 通过。
- daemon 启动、TUI prompt、permission approve/deny、child follow-up 完成人工 smoke test。

## Task 5：复盘 hardening

- [x] framework 用 typed `AgentRunNotAcceptingInputError` 表达 terminal boundary，不再匹配错误字符串。
- [x] steer 先同步预占 pending slot；最终 turn 原子 drain/close，late reject 由 daemon 创建 durable replacement run。
- [x] `AgentRunHandle.started` 建立 required `run.started` delivery barrier；child receipt 不早于 durable run start。
- [x] root tree 共享 `AgentChildRegistry`，支持从 root 路由任意深度 descendant，同时保留 manager-local lifecycle ownership。
- [x] `AgentPool` 把 agent promise 与 subscription 收入同一代际 entry；closing 完成后的清理不误伤后续 replacement。
- [x] `child.created` partial failure 补偿 task/live route/new child session。
- [x] projector 用成功 event sequence 水位替代无界 event/input sets。
- [x] listener/infrastructure failure 收束遗留 running transcript parts。
- [x] permission effect 原样保留 `approved | denied | expired`。
- [x] 增加 terminal steer、descendant directory、pool race、projection rollback、transcript fallback、permission expiration 回归测试。
- [x] 更新 TUI、framework、daemon、child、permission 权威文档。

退出标准：相关 package typecheck 和 focused tests 通过；生产代码不存在旧 host/projection compatibility path。

## Task 6：二次复盘一致性修复

- [x] steer receipt 延迟到可用 turn boundary 的 `input.accepted` 成功交付与实际消费；provider/tool/terminal/max-turn 先结束时统一 typed reject。
- [x] steer receipt 不在 projection 前报告成功；后续归零复盘进一步改为每 boundary 单条消费。
- [x] coordinator delivery 返回输入最终归属 run；late steer replacement run ID 透传到 HTTP，replacement 失败不会悬挂 promise。
- [x] child run 严格校验 framework `started` receipt，不再用 manager 预分配 ID 覆盖真实 receipt。
- [x] live child HTTP 删除 durable input/run 补造 fallback；receipt 与 durable projection 不一致时明确失败。
- [x] `input.accepted` 携带 child input metadata，删除 fallback 后仍由唯一 projector 完整落盘。
- [x] child event projection 失败补偿 durable run/transcript/task terminal 状态；`child.closed` 不再吞 durable completion failure。
- [x] task bridge durable-first 注册；live TaskManager 注册失败回写 failed，live completion 失败不阻断 durable terminal。
- [x] 更新 framework/daemon/event 权威文档并补充 steer、child identity、projection、task bridge 回归测试。

退出标准：core、agent-runtime、server typecheck 通过；上述 focused tests 通过；所有 steer delivery promise 都有 resolve/reject 终点。

## Task 7：第三次复盘一致性修复

- [x] steer 幂等查询同时识别 primary run input 与 transcript message ownership；成功 retry 不重复 delivery。
- [x] 同一 pending input ID 共享 admission promise；冲突 payload 明确拒绝，不保留无界 pending admission。
- [x] interrupt/delivery failure terminalize 尚未绑定 run 的 durable steer input。
- [x] late steer rejection 即使已部分投影到原 run，也创建 replacement run，不误复用原 run。
- [x] durable child task 拒绝 stale active snapshot 覆盖 terminal 状态；显式 reopen 清除旧 terminal 字段和 output file。
- [x] live child request 幂等历史限制为最近 256 个 settled request，长期 HTTP 幂等留给 daemon durable store。
- [x] prompt route 保留 `SessionApplicationError.status`，不把 framework/durable 一致性错误降级成 404。
- [x] 补充 store、run engine、coordinator、task bridge、route 与 child manager 回归测试，并更新权威文档。

退出标准：services、core、agent-runtime、server typecheck 与全量测试通过；`git diff --check` 无错误；每个 admitted steer input 都有 owning run 或 terminal failure run。

## Task 8：归零复盘与状态机收口

- [x] steer 改为每个可用 turn boundary FIFO 消费一个；receipt 与单个 `input.accepted` 一一对应。
- [x] live child receipt 通过 primary input 或 transcript message 验证 owning run，active steer 不再误报 500。
- [x] child 首次创建/恢复实例纳入可等待 creation barrier；close 与 spawn cleanup 去重，不产生 orphan run 或重复 `child.closed`。
- [x] tree-wide child sessionId 在 environment acquire 前预检；durable child session 同时校验 childId。
- [x] daemon restart 收束 running transcript parts，并把旧进程 pending permission 置为 expired。
- [x] input create-or-validate 比较完整业务 metadata；root executor 原样传递 admitted metadata。
- [x] durable run terminal 不可 reopen；child task 仍可显式绑定新 run 后 reopen。
- [x] `child.closed` durable completion 失败时清理 live route，并保留 pending projection state 供后续重试。
- [x] 删除 `listUnboundInputs`、`createChildSession`、`writeToSessionTask` 旧接口并更新权威文档。

退出标准：agent-runtime/server/services focused tests、全量 package tests/typecheck 与 `git diff --check` 通过；重启集成测试覆盖 run part/task/permission 三类 stale state。

## Task 9：事务边界与 closing 线性化

- [x] `SessionStore.transaction()` 将 SQLite commit 与内存 read model 绑定；任一嵌套写失败时整体恢复事务前快照。
- [x] projector 的 input/run/stream/terminal/compensation 多步归约使用 store transaction，并在失败时恢复 transcript reducer state。
- [x] text delta 从全量 snapshot save 分离为 part 级增量持久化；后续 checkpoint follow-up 将其收敛为有界批写与正常关闭强制 flush。
- [x] child lifecycle 增加不可逆 `closing`；close 开始后拒绝 steer/queue，run/creation 续体不能回写 active state。
- [x] 删除 `agent@team` command alias；child command 只接受 canonical child/task ID，session 查询走 tree-wide directory。
- [x] `AgentPool` closing entry 阻止 replacement generation，并在等待后重新读取 durable session/history；closing/archived session 不可 warm/acquire。
- [x] archive 在 descendant snapshot 前先把 parent 置为 closing；projector 拒绝 closing/archived parent 的 `child.created`。
- [x] `child.closed` durable completion 失败时保留 pending projection state，下一有序事件或同 event retry 先完成 terminal projection。
- [x] 增加 store fault injection、running delta reload、child close/input、pool close/acquire、archive admission 与 child close retry 回归测试。

退出标准：agent-runtime、services、server、core 全量测试与相关 package typecheck 通过；durable store 失败不产生进程内幽灵状态；同一 session/child 在 closing 窗口没有第二个执行 owner。

## Follow-up：text delta checkpoint 性能

> 状态：已完成。delta 立即更新内存 read model 并 live publish；durable text 默认按 `150ms/8KB` checkpoint。异常退出最多丢失一个 checkpoint 尾窗，正常 terminal/close 不丢失。

对照 OpenCode 当前实现后确认这里是有意增强，而不是逐 delta event sourcing：OpenCode 的 `Text.Delta` / `message.part.delta` 同样是 live-only，完整文本只在可 replay 的 `Text.Ended` / `PartUpdated` 边界持久化；Vykor 保留相同的 transient delta + full-value terminal 边界，并额外 checkpoint 聚合后的 part row，以较小的固定写放大换取有界的 daemon 崩溃尾窗。该策略仍归 `SessionStore` 所有，不进入 framework 或 projector 的业务协议。

- [x] delta 先更新内存 read model 并立即发布 SSE，以 part 为单位累计 dirty checkpoint。
- [x] delta hot path 不再触发整份 `SessionState` 的 `structuredClone` 或全量 `save()`；事务回滚覆盖 dirty part/checkpoint 状态。
- [x] 默认按 `150ms` 或 `8KB` 阈值批量 flush；同批 dirty part 使用单个 SQLite 事务。
- [x] part complete、tool boundary、run terminal 与 daemon shutdown/store close 强制 flush。
- [x] transient delta event 只做 live publish；daemon store 与 client durable event index 都不保留逐 chunk 事件。
- [x] 明确 durability contract：异常进程退出最多丢失一个 checkpoint 窗口；正常 terminal/close 不丢失。
- [x] 增加 100 chunk/1 checkpoint 写事务、定时 flush、阈值 flush、terminal/close flush、失败重试与 restart cursor 回归测试。
- [x] transient cursor 续租先于内存正文 mutation；序号预留失败不得留下未发布、未持久化的 ghost delta。

退出标准：delta 写事务数量不再随 chunk 数量线性增长；SSE 实时性不依赖 durable flush；正常生命周期边界可恢复完整文本；文档明确异常退出的有界尾部丢失语义。

## Follow-up：归零复盘待办

> 状态：已完成。以下问题均按共享状态机、scope gate、统一 settlement 与 unit-of-work 收敛，没有保留兼容路径。

- [x] framework 为 `submitMessage`、`compact`、`remember`、`loadHistory`、`clear`、`setModel`、`close` 建立统一 operation state machine；历史/配置变更不得与 active run 并发。
- [x] daemon 建立 session/cwd/global application admission gate；shutdown、配置重载、runtime PATCH、archive 和 maintenance 先安装 barrier，再检查/中断/drain，最后关闭 agent/store。
- [x] `SessionRunEngine` 提供全局 stop-and-drain 生命周期；server shutdown 不会在关闭已有 agent 后启动 queued run，并保留自定义 interrupt reason。
- [x] projector 对 child required event 的“投影失败 + 补偿失败”采用统一 pending settlement；root failure 传播到 executor durable fallback，sequence watermark 不越过未收敛事件。
- [x] `AgentPool.warm()` 保持 best-effort 语义，但 warm 也服从 shared admission；Maintenance/Control 的必需 runtime 操作直接传播 agent 创建失败。
- [x] `SessionStore.save()` 已迁移为行级 mutation/unit-of-work；durable event append，普通状态更新成本不随全库历史线性增长。

退出标准：framework 单实例操作具有明确互斥状态机；daemon close/config/maintenance 与 prompt admission 线性化；required event 失败必有可观察终态；store 写放大有基准和上界。

## 提交策略

建议按三个可审查提交落地，而不是按文件碎片提交：

1. `refactor(agent): expose runs through events effects and handles`
   - Task 1 + Task 2，root vertical slice 原子切换。
2. `refactor(agent): move child lifecycle to framework events`
   - Task 3，child vertical slice 原子切换。
3. `docs(test): close agent event architecture migration`
   - Task 4 的 hardening、文档和退场检查。

实现过程中工作区可以暂时处于未编译状态，但任何 commit 都不能同时暴露新旧两套 public API。

## 不接受的实现

- 新增 `AgentEvent`，同时长期保留 `AgentRunHost.emitEvent()`。
- 用 `LegacyAgentRunHostAdapter`、`CompatChildProjection` 等兼容层包住旧链路。
- 把 `resolve/reject` function 放进 permission event 或 durable store。
- 把 `AgentRunHandle`、`AgentChildHandle` 序列化到 event/SSE。
- daemon 继续生成 taskId，再把它返回 framework 当 invocation handle。
- child event 已存在，仍要求 framework 调 `projection.startRun/finishRun`。
- 为了删除 projection，把 transcript/task/store 逻辑搬进 framework。

## 完成定义

用户面对的心智模型应收敛为：

```text
agent.submitMessage() -> AgentRunHandle
agent onEvent         -> daemon 可靠消费执行事实
agent.subscribe       -> 普通观察
agent.effects         -> 外部决定
agent.children        -> live child handles

daemon                -> durable projection + HTTP/SSE + concurrency policy
```

打开目标架构文档，应能直接定位一条动作属于 event、effect 还是 handle，并沿同一条链找到 framework 产生点和 daemon durable 消费点。
