# Daemon Application Architecture

> 状态：当前实现的权威运行索引。最后核对：2026-09-17。查询 prompt、steer、interrupt、permission、child、compact/remember/usage 等流程时，从本文进入；存储边界见 [Session Runtime 存储架构](./session-runtime-storage-architecture.md)，跨层终态和失败语义见 [Agent Lifecycle Contract](./agent-lifecycle-contract.md)。

## 总体模型

```text
agent framework = execution + live state + events/effects/handles
daemon          = HTTP + durable state + multi-client policy + event projection
TUI/Web/Desktop = interaction surfaces
```

daemon 直接依赖 `@openharness/agent-runtime`，不经过 runtime adapter。framework 可以脱离 daemon 独立运行；daemon 是它的一种有 durable state 和多 UI 协调能力的应用形态。

## 核心请求链

```mermaid
flowchart TD
  Surface["TUI / Web / Desktop / print"]
  Client["OpenHarnessClient Resources"]
  Routes["HTTP routes"]
  App["Query / Command / Interaction / Run Control"]
  Runner["SessionOperationRunner"]
  Engine["RunAdmissionService"]
  Lane["SessionRunCoordinator"]
  Executor["SessionRunExecutor"]
  Pool["AgentPool"]
  Agent["OpenHarnessAgent"]
  QE["QueryEngine"]
  Events["AgentEventBus"]
  Projector["DaemonAgentEventProjector"]
  Transcript["SessionTranscriptProjection"]
  Store["Repository / Transaction + SQLite"]
  SSE["SessionEventPublisher / SSE"]

  Surface --> Client --> Routes --> App --> Runner --> Engine --> Lane --> Executor
  Executor --> Pool --> Agent --> QE
  Agent --> Events --> Projector --> Transcript --> Store --> SSE --> Client
  Projector --> Store
```

准确表述是：

```text
Surface -> Client Resource -> route -> application service
  -> SessionOperationRunner (ready + session lane + operation lease + checkpoint)
  -> RunAdmissionService
  -> SessionRunCoordinator (per-session lane)
  -> SessionRunExecutor (one admitted root run)
  -> AgentPool -> OpenHarnessAgent -> QueryEngine

OpenHarnessAgent onEvent sink
  -> DaemonAgentEventProjector.apply(event)
  -> Repository / Transaction -> transcript/session/run/task/event durable state
  -> SSE
```

`DaemonAgentEventProjector` 是 daemon-owned 单向 reducer。framework 只看到创建参数里的 `onEvent(event)` callback，不依赖 projector、store 或 daemon 类型。

## Composition 与 transport

`packages/server/src/application/daemon-application.ts` 是 daemon durable application 的唯一 composition root。它组装 store recovery、permission broker、Agent loader/pool、event projection、run engine、Workflow、Scheduled Tasks，以及 Query / Command / Interaction / Maintenance / Control 等应用服务。它暴露这些服务，但不亲自实现它们的业务动作。

`packages/server/src/http/server.ts` 只负责 Hono、鉴权、CORS、route mounting、HTTP listener 和 SSE client lifecycle。HTTP transport 不再创建或持有 AgentPool、run engine、projector 等内部组件。

`packages/server/src/daemon/daemon-agent.ts` 是唯一的 durable session -> live Agent 翻译点：读取动态 settings、合并 session metadata、注入 permission/event callback、创建 agent、恢复 history。`AgentPool` 不再理解配置和投影。

## Session 运行配置

一条 session 有两类模型信息，不能混着看：

| 位置                             | 大白话含义                        | 谁会使用                             |
| -------------------------------- | --------------------------------- | ------------------------------------ |
| `session.model`                  | 列表、导出和统计使用的展示列       | UI 展示、导出、统计展示              |
| `session.metadata.runtime.model` | 这条 session 下一轮真正要用的模型 | daemon 创建或重建 `OpenHarnessAgent` |

当前规则：

1. 新建 session 时，CLI/TUI/Web 会把默认模型写入 `metadata.runtime.model`，同时同步写入 `session.model` 展示列。
2. `ohs provider use <provider> -m <model>` 或 Home 页 `/models` 只改 settings，作用是“以后新建 session 的默认模型”。
3. 已经打开的 session 改模型时，只能 PATCH `metadata.runtime.model`。旧写法 `PATCH /sessions/:id { model }` 会被拒绝。
4. runtime 读取只认 `metadata.runtime.model`。缺少这个字段时不会从展示用的 `session.model` 猜测运行配置。
5. `SessionCommandService.updateSession()` 发现 runtime metadata 变化后，会先通过 `RunControlService` 确认当前 session 没有正在跑的任务，再关闭 `AgentPool` 里当前 agent。下一次发送消息时，pool 会重新读 session repository，用新的 runtime 配置创建 agent。
6. `provider`、`baseUrl`、`apiFormat`、`permissionMode`、`maxTurns` 等同理放在 `metadata.runtime`。settings 只作为新 session 的默认值，或补齐 session 没写的可选字段；模型本身不能靠 settings 补。

所以 TUI 下 `/models` 的行为是：

```text
没有 active session:
  选择模型 -> PATCH /settings
  下一次新会话使用这个模型

有 active session:
  选择模型 -> PATCH /sessions/:id { metadata: { runtime: { model, provider } } }
  daemon 关闭旧 agent
  下一次发送消息时重建 agent，并使用这条 session 自己的模型
```

## 请求入口与应用服务

routes 在 `packages/server/src/http/server.ts` 组装；应用对象来自 `DaemonApplication`。

Session 写操作共享 `SessionOperationRunner`。它先等待同 session 前一个操作结束，再检查 Application ready、读取 session、取得 `DaemonOperationGate` shared lease 和事件 checkpoint。业务工作完成或失败后只发布 checkpoint 之后已经提交的事件，最后释放 lease；发布失败不会掩盖原始业务错误。

| 服务                        | 文件                                  | 负责                                                               |
| --------------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| `SessionCommandService`     | `application/session/session-command-service.ts`     | create/update/archive/delete/fork                                 |
| `SessionInteractionService` | `application/session/session-interaction-service.ts` | prompt、resume、interrupt、queued prompt 与 child route           |
| `SessionQueryService`       | `application/session/session-query-service.ts`       | session/state/message/part 查询                                    |
| `SessionMaintenanceService` | `application/session/session-maintenance-service.ts` | compact、rewind、export、remember、MCP、usage                      |
| `DaemonControlService`      | `application/control/daemon-control-service.ts`      | runtime snapshot、run barrier、pool close/inspect                  |
| `ScheduledTaskService`      | `daemon/scheduled-task-service.ts`                   | 保存已安排任务、启动定时器、运行 Agent、保存执行记录和需要处理状态 |

它们是 HTTP 后面的应用用例门面，不是独立网络服务。

| HTTP 能力                                | route 文件                       | 主要入口                 |
| ---------------------------------------- | -------------------------------- | ------------------------ |
| session CRUD/query                       | `http/routes/session.ts`         | Application / Query      |
| prompt/steer/interrupt/resume            | `http/routes/run-execution.ts`   | Application              |
| compact/rewind/export/remember/MCP/usage | `http/routes/session-utility.ts` | Maintenance              |
| permission list/reply                    | `http/routes/permission.ts`      | `StorePermissionBroker`  |
| Jobs list/read/wait/send/cancel          | `http/routes/job.ts`             | `DaemonJobService`       |
| Scheduled Task create/list/run/history   | `http/routes/schedules.ts`       | `ScheduledTaskService`   |
| health/settings/provider                 | `http/routes/system.ts`          | Control/default services |
| replay/live SSE                          | `http/routes/events.ts`          | `HttpEventHub`           |

已安排任务的创建、到点执行、Agent 工具接入和 daemon 启停流程见 [Scheduled Tasks 运行流程](./scheduled-tasks-flow.md)。

## TUI 发送 hi

```mermaid
sequenceDiagram
  participant UI as useServerSync
  participant C as client.sessions
  participant R as SessionOperationRunner
  participant A as SessionInteractionService
  participant E as RunAdmissionService
  participant L as SessionRunCoordinator
  participant X as SessionRunExecutor
  participant P as AgentPool
  participant G as OpenHarnessAgent
  participant Q as QueryEngine
  participant D as DaemonAgentEventProjector
  participant S as Repository/Transaction + SSE

  UI->>C: admitPrompt(sessionId, { content: hi })
  C->>A: POST /sessions/:id/prompts
  A->>R: run(sessionId, work)
  R->>E: admitPromptAndMaybeRun
  E->>S: durable input + pending run
  E->>L: enqueue(sessionId, runId)
  L->>X: execute(workContext)
  X->>P: acquireSession(sessionId)
  P-->>X: warm/cached agent
  X->>G: submitMessage(hi, durable IDs)
  G-->>X: AgentRunHandle
  X->>L: registerHandle(handle)
  G->>D: input.accepted + run.started
  D->>S: running run + transcript begin
  G->>Q: model/tool loop
  loop output/tool/usage
    G->>D: AgentEvent
    D->>S: durable projection + SSE
  end
  G->>D: terminal event
  D->>S: finalize transcript + run
  G-->>X: run.result settles
```

对应代码顺序：

```text
apps/frontend/src/hooks/useServerSync.ts
packages/client/src/resources/session-resource.ts
packages/client/src/transport/http-transport.ts
packages/server/src/http/routes/run-execution.ts
packages/server/src/application/session/session-interaction-service.ts
packages/server/src/application/session/session-operation-runner.ts
packages/server/src/application/session/run-admission-service.ts
packages/server/src/application/session/session-run-engine.ts
packages/server/src/runtime/run-coordinator.ts
packages/server/src/application/session/session-run-executor.ts
packages/server/src/application/agent/agent-pool.ts
packages/server/src/daemon/daemon-agent.ts
packages/agent-runtime/src/agent.ts
packages/core/src/engine/query-engine.ts
packages/server/src/application/agent/daemon-agent-event-projector.ts
```

## 带结构化 Skill 的 prompt

带 Skill 的 prompt 不建立第二条 Run 链。客户端仍调用 `client.sessions.admitPrompt()`，区别只是 input 的 `items` 中含 `{ type: "skill", name, path }`。

`SessionRunExecutor` 在 `submitMessage` 前按 session cwd 重新取得 Skill registry，用当前 catalog 校验每个 name/path，再由 `session-input-materializer.ts` 生成明确的 Skill 工具调用要求。materializer 不读取 `SKILL.md`；模型调用原生 `Skill { name, path }` 后才取得 Skill file、Skill root 和正文。此后 AgentEvent、durable projection、SSE 和 terminal settlement 与上面的普通 prompt 完全相同。

完整时序、附件组合和失败边界见 [Skill Prompt Flow](./skill-prompt-flow.md)。

## AgentPool 与实例归属

`AgentPool` 缓存一个带代际所有权的 entry：

```text
sessionId -> { promise: Promise<OpenHarnessAgent>, agent?, state, closePromise? }
```

职责分工：

1. `AgentPool` 读取 durable session/messages/parts，并负责同 session 创建去重、代际关闭和缓存。
2. `createDaemonAgentLoader()` 合并 settings 与 session metadata。
3. loader 注入 daemon 的 `requestPermission` 与可靠 `onEvent` callback，创建 agent。
4. loader 执行 `loadHistory(transcriptToAgentMessages(...))` 并绑定 projector，然后才返回完整 agent。
5. Pool 缓存返回值，后续 root run 复用实例。
6. archive、runtime config change、failure 或 shutdown 时 Pool close。

close 只清理自己捕获的 entry。entry 一旦进入 `closing`，同一 session 的 acquire 会等待旧实例完整释放，再重新读取 durable session/history 创建 replacement；旧代际的 finally 不会误删新代际。批量 close 等待全部 entry settle 后再聚合上报，单个 cleanup 失败不会让 shutdown 提前越过仍在关闭的 agent。

live child 由 root agent 的 `AgentChildManager` 持有，不进入 AgentPool。`LiveChildAgentDirectory` 让 pool 拒绝为该 durable child session 创建第二个 agent。

## Daemon operation gate

`DaemonOperationGate` 是 daemon 应用层的统一准入边界，scope 为 `sessionId + cwd`。普通 runtime 使用持有 shared lease；配置、维护与 archive 持有 exclusive barrier：

| barrier | 阻止的准入              | 典型调用                                        |
| ------- | ----------------------- | ----------------------------------------------- |
| session | 同一 session            | runtime PATCH、compact、rewind、archive         |
| cwd     | 同一 cwd 的所有 session | remember、memory/plugin reload                  |
| global  | 所有 session            | settings/auth/profile/plugin mutation、shutdown |

线性化顺序固定为：先安装 barrier，原子检查 lane 与 `AgentPool` live state，再执行 mutation/close，最后释放 barrier。prompt、resume、required runtime inspect 和 best-effort warm 都必须经过 shared admission；warm 拿不到 lease 时只跳过预热，Maintenance/Control 的必需 runtime 创建失败则直接向调用方传播。

framework 实例内部还有更小一层状态机：`idle -> running | maintaining -> idle`，close 从任意非 closed 状态进入 `closing -> closed`。因此 daemon barrier 解决跨请求/跨实例策略，agent state 解决单实例历史、模型、run 与 maintenance 的互斥，两层不互相替代。

## Event projection

唯一入口：

```ts
createDaemonAgentLoader({
  // loader 内部调用 createDefaultNodeAgent(...)
  createEventSink: () => (event) => projector.apply(event),
  requestPermission: (request, context) => permissionBroker.ask(/* ... */),
});
```

| AgentEvent                      | daemon 行为                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `input.accepted`                | create/validate durable input；steer 时追加 user transcript                                                  |
| `run.started`                   | create/validate run、置 running、begin transcript                                                            |
| `output.text.delta`             | 立即更新内存 text part 并发 live SSE；dirty part 按 checkpoint 批量持久化，delta event 本身不进入 replay log |
| `output.turn.completed`         | 完成当前 text part，保留 provider model-turn 边界                                                            |
| `tool.started/completed`        | create/update tool part + observability                                                                      |
| `usage.updated`                 | project usage event                                                                                          |
| `domain.event`                  | 写 durable domain event                                                                                      |
| `permission.requested/resolved` | 写 framework observation event                                                                               |
| `child.created`                 | child session + task + live directory                                                                        |
| `child.suspended/resumed`       | durable lifecycle observation                                                                                |
| `child.closed`                  | finish task、unregister live route；durable 失败时保留 pending projection 供有序重试                         |
| run terminal                    | complete text、finalize durable run/task                                                                     |

projector 按 root event source 单调 `sequence` 保存已成功应用的水位；重复或更旧事件直接跳过，失败事件不推进水位。所有 child required event 共用 SQLite `projection_settlement` 状态机：`child.closed` 重试 durable terminal projection，其他 child event 执行 durable compensation；settlement 再失败时保持 pending，下一有序事件必须先修复同一 root 的 pending 记录，水位不能越过 poison event。root projection failure 传播给 framework，并由 `SessionRunExecutor` 对仍非 terminal 的 durable run 做 infrastructure fallback。详细失败边界见 [ADR 0001](./adr/0001-projection-settlement-failure-policy.md)。

Settlement 保存的是可序列化修复说明，不是旧进程的 Handle。Daemon 对外 ready 前先修复 Settlement，再执行普通的 active Run/Task/Permission 重启收束：terminal child 可以补齐真实结果；live-only child 创建或路由失败只能把 Run/Task 标为 failed，并归档半初始化 child Session。每次原始失败、下一相关事件和显式 recovery 都只尝试一次，不运行无限重试循环。`/debug/runtime` 的 `projectionSettlements.pending` 显示仍需处理的数量；正常完成或正常 shutdown 应为 `0`。

input/run/stream/terminal 的多步 durable 归约通过具名 Transaction 和共享 `TransactionCoordinator` 提交，SQLite 与内存 read model 同时提交或同时回滚，transcript projection state 也在失败时恢复。input/run/child identity 使用 create-or-validate：input 会比较去除 traceId 后的完整 metadata，既有 child session 必须匹配 parent/cwd/childId，terminal run 不允许被 `run.started` 重开。当前 framework event source 不跨进程 replay，daemon restart 仍走 durable recovery，不恢复 live event stream。

每个真正进入 `run.started` 的新 Run 会建立一条 durable Run Attempt。Attempt 保存独立的 sequence、provider、model、状态、token 用量和起止时间；当前 Provider 内部的连接/传输 retry 仍属于同一 Attempt。Run terminal 之前必须先把活动 Attempt 收束为 completed、failed 或 cancelled。Daemon 重启不会重新调用模型，而是把 pending/running Attempt 标为 cancelled。Attempt 同时进入 session snapshot 和 durable replay event，客户端可以按 Run ID 关联展示。

每条 durable event（持久化后可回放的事件）都带 `schemaVersion`。当前内置事件版本统一为 `1`。版本表示事件载荷采用哪一版格式，不代表业务发生顺序；顺序仍由 `seq` 决定。缺少版本或版本不同会直接失败。

durable event 的格式由 `DurableEventRegistry` 集中登记。登记项包含事件名、当前版本、属于单个 session 还是全局事件，以及 payload 校验器。Store 写入和读取时都要求精确版本；未登记的名称、缺字段、字段类型错误、错误的 session/global 归属或旧版本都会被拒绝。registry 不提供读取时升级函数。

Framework 的 `domain.event` 统一持久化为 `agent.domain.event`，原始业务名称保存在 payload 的 `name` 字段；Workflow 事件则逐项登记允许的九种事件名。读取时不会再把旧的业务事件名猜成 `agent.domain.event`。这样新增业务事件必须显式注册，不会因为字符串拼错而产生客户端永远不认识的历史记录。测试或插件若确实拥有额外事件，可以通过 `createDurableEventRegistry([...extensions])` 建立专用 registry，并在创建 `SessionStore` 时传入，生产默认 registry 不会自动放行它们。

### Text delta durability

delta 有两条彼此独立的输出：`liveEvent` 立即发给当前 SSE 客户端；durable text 按 part 累积 dirty checkpoint。默认每 `150ms` 或 `8KB` flush，同批 dirty part 在一个 SQLite transaction 中更新 part/message/session。part complete、tool boundary、run terminal 和 `SessionStore.close()` 会通过普通 unit-of-work 或显式 close 强制落盘。

异常进程退出最多丢失最后一个 checkpoint 窗口；正常 terminal/shutdown/close 不丢失。transient delta 不进入 `SessionStore.events`，client reducer 也不把它保留在 durable `eventsBySeq` 索引，只记录 `transientCursor` 防止 SSE 重连重复追加。durable event 与 live delta 共用全局 SSE 序号，store 每次预留 1024 个序号并持久化高水位；重启可以留下空洞，但绝不复用客户端已经见过的 cursor。

`SessionStore` 的普通写使用 row-level mutation/unit-of-work：只 upsert dirty row、只 append 新 durable event，`replaceTranscript` 只删除目标 session 的旧 message/part。成本不再随全库历史线性增长。

## Steer

```mermaid
sequenceDiagram
  participant UI
  participant Engine as SessionRunEngine
  participant Lane as SessionRunCoordinator
  participant Run as AgentRunHandle
  participant QE as QueryEngine
  participant Projector

  UI->>Engine: prompt delivery=steer
  Engine->>Engine: durable admit input
  Engine->>Lane: steer(sessionId, input)
  alt handle 尚未注册
    Lane->>Lane: pendingSteers FIFO
  else handle 已注册
    Lane->>Run: steer(input)
  end
  Run->>Run: reserve pending steer
  QE->>Run: take one steered input at usable boundary
  Run->>Projector: input.accepted delivery=steer
  Run-->>QE: consumed input
  Run-->>Lane: receipt(runId)
  Lane-->>Engine: final owning runId
  Engine-->>UI: input + original/replacement run
```

正常 steer 不创建第二个 run。没有 active lane 时，`delivery=steer` 按普通 prompt 创建新 run。已 admit 但 handle 尚未注册的 steer 保存在 lane，注册后按序 flush。framework 每个可继续的 turn boundary 只消费一个 steer，因此并发输入按 FIFO 分布到后续模型回合，receipt 独立结算。HTTP application 会等待 delivery receipt，因此响应中的 `run` 一定是该输入最终归属的原 active run 或 replacement run，而不是过早返回旧 run。

最终 turn boundary 与 max-turn boundary 由 framework 关闭 steering；未到可继续的模型回合前，`input.accepted` 和 receipt 都不会产生。若 lane 已接收输入、但 `run.steer()` 明确抛出 `AgentRunNotAcceptingInputError`，coordinator 不丢弃 durable input，而是在同一 lane 创建带 `recoveredFromSteer` metadata 的 replacement run，并用新 run ID 结算 HTTP delivery。其他 steer 错误以及 replacement 创建错误都会明确拒绝请求并终止当前 lane 控制链，不会留下悬挂 promise。

steer 的 durable 归属既可以由新 run 的 `run.inputId` 表达，也可以由原 active run transcript 中的 user message（`message.inputId + message.runId`）表达。live child receipt 校验也使用这两种关系，不能要求 active steer 等于 run 的首个 input。相同 input ID 重试时，application 会找到最终 owning run，不会再次 delivery。相同 ID 在首次 delivery 仍 pending 时，共享同一个进程内 admission promise；payload、session 或 delivery 不一致则按 idempotency conflict 拒绝。

interrupt 或 delivery failure 会拒绝所有尚未结算的 steer。若输入还没有任何 owning run，engine 会为它建立 terminal `interrupted`/`failed` run，保证 durable input 不会永久悬空；如果 projector 已把它绑定到原 run，则由该 run 的 terminal projection 收束。

## Interrupt

```text
HTTP interrupt
  -> SessionInteractionService.interruptSession
  -> RunControlService.interruptSession
  -> SessionRunCoordinator.interrupt
     -> abort work signal
     -> active run.interrupt()
     -> reject queued runs
  -> LiveChildAgentDirectory.interrupt descendants
```

framework 发 `run.interrupted` 后 projector 完成 durable terminal 状态。若 event delivery 或 agent 创建在 terminal event 前失败，`SessionRunExecutor` 只对仍非 terminal 的 run 执行 infrastructure fallback，并把该 run 遗留的 `running` transcript parts 收束为 `failed` 或 `interrupted`。

每个真正进入模型执行的 Run 还会留下独立 Attempt。大白话说，Run 是“用户这件事”，Attempt 是“系统为办成这件事实际找模型试了第几次”。Run 结束前必须把仍在 pending/running 的 Attempt 一并收口；Daemon 重启会把旧活动 Attempt 取消，不会伪装成模型从未被调用。

## 工具运行与授权

```mermaid
sequenceDiagram
  participant QE as QueryEngine
  participant Run as FrameworkAgentRun
  participant FX as daemon AgentEffects
  participant B as StorePermissionBroker
  participant UI

  QE->>Run: permission required
  Run->>Run: permission.requested event
  Run->>FX: requestPermission(request, scope)
  FX->>B: ask(scope + signal)
  B-->>UI: durable request + SSE
  UI->>B: HTTP reply
  B-->>FX: decision
  Run->>Run: permission.resolved event
  Run-->>QE: decision
```

effect 注入位置是 `packages/server/src/daemon/daemon-agent.ts`；durable wait/reply 在 `packages/server/src/permissions/permission-broker.ts` 与 `permission-controller.ts`。daemon 不创建 run host，也不向 QueryEngine 传 callback。

Tool 的 durable part 同时承担第一版执行账本：`toolCallId` 是模型发起调用的固定编号，`toolAttemptId` 是实际执行次数。Tool 开始后若进程突然退出，Store 会把结果标成 `unknown_outcome`，意思是“可能已经执行，只是结果没来得及记下来”；系统不会因此自动再执行一遍。失败原因通过 permission、policy、timeout、command、transport、provider、interrupted、unknown_outcome 等结构化类别传递，不靠解析报错文字。

## Child session 与 task

```text
Agent tool -> framework AgentChildManager
  -> child.created event
  -> DaemonAgentEventProjector
     -> durable child session
     -> SessionExecutionProjector 创建 durable task (id = childId)
     -> LiveChildAgentDirectory(sessionId -> rootAgent + childId)
  -> recursive child OpenHarnessAgent
  -> ordinary input/run/output/tool terminal events
```

HTTP child prompt、`JobSend` 的 session-task callback 和 `JobCancel` 最终都通过 `rootAgent.children` 调 live handle。daemon 只保存路由索引，不复制 controls。完整流程见 [Agent Child Session Flow](./agent-child-session-flow.md)。

`rootAgent.children` 是 framework root tree 共享的 descendant directory，不只包含 direct child。`child.created` durable 建模若在 task/live-route 阶段失败，projector 会失败 task、注销已注册 route，并 archive 本次新建的 child session；framework 随后回滚 handle 与 environment lease。parent 一旦进入 `closing/archived`，projector 拒绝新的 `child.created`。

child 普通 input/run/output/tool 投影失败时，projector 会把已存在的 durable run、未完成 transcript part 与 parent task 收束为 failed，再把 required event failure 传播回 framework。live child HTTP 路径只接受 framework `started/steer` receipt 对应的 durable input/run；缺失或身份不一致返回 500，不再由 application 临时补造 input/run。`SessionExecutionProjector` 先创建 durable task，再登记 `ChildAgentExecutionRegistry` 的 live handle；live 登记失败会标记 durable task failed，live completion 失败也不阻止 durable terminal 状态落盘。

durable child task 的 terminal 状态不会被延迟到达的 live `pending/running` snapshot 回退。只有显式的新一轮 child run 才会把 task 重新置为 `running`；重开时同时清除上一轮的 `finishedAt/output/error` 与 live output file，避免两轮结果混合。

## Maintenance

| 用例        | 主要路径                                                                                                        |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| compact     | Maintenance -> `agent.compact()` -> replace durable transcript                                                  |
| remember    | Maintenance -> `agent.remember()`                                                                               |
| usage       | Maintenance -> `agent.getUsage()`                                                                               |
| inspect/MCP | Maintenance/Control -> `agent.inspect()`                                                                        |
| rewind      | close agent -> mutate durable transcript -> later rehydrate                                                     |
| archive     | parent 先进入 closing -> 固定 descendant snapshot -> interrupt/wait -> close pool/live child -> durable archive |

这些 API 是 framework 能力的 daemon 应用化；daemon 负责 durable 更新和并发保护。compact/rewind 使用 session barrier，remember 使用 cwd barrier；barrier 覆盖 agent operation、durable mutation 与必要的 runtime close，不使用“先检查 active run、稍后再执行”的 check-then-act。

root Run 成功写入 `completed` 后，`SessionPostRunMaintenance` 从 Store 读取已经投影完成的 transcript，依次更新 session memory checkpoint、personalization、可选的长期记忆自动抽取和 auto dream 门槛。任何一步失败都只写结构化告警，不会把已经完成的 Run 改回失败；failed/interrupted Run 不执行这条维护链。

## Durable Workflow 与 Jobs

daemon 中的 Workflow 和 Session、Run 使用同一份 SQLite：

```text
Workflow tool / daemon command
  -> Workflow scheduler
  -> SessionWorkflowRunRepository
  -> workflow_run / workflow_task_attempt / durable event
  -> DaemonJobService
  -> HTTP client / TUI / Web / Desktop
```

`SessionWorkflowRunRepository` 是 daemon 唯一注入的 Workflow 仓库。它保存完整快照、每个 task 的 attempt 和 Workflow 事件；不会读取 `.openharness-ts/workflows`，也不会在启动时迁移旧 JSON。独立 CLI 如果要查看项目文件，必须明确创建 `FileWorkflowRunRepository`，详见 [Workflow CLI](./workflow-cli.md)。

Workflow run ID 只能创建一次。scheduler 开始或恢复前必须 claim，意思是先在数据库里取得这次运行的处理权；重复 ID、重复 claim 或已经被其他执行者取得的 run 会直接失败。Daemon 重启不会重放模型或 Tool，而是先 claim 遗留的 running Workflow，再把 running task 记为 killed、未开始 task 记为 skipped，并写入 terminal 状态。

Jobs 层只读取和控制这份 Workflow 状态，不复制第二份快照。Workflow Job ID 固定为 `workflow:<runId>`，裸 `runId` 不再接受。`JobWait` 订阅状态变化后会立刻再读一次数据库，避免“状态刚好在订阅前完成”导致永久等待；timeout 只返回当时快照，不会取消工作。

## 单执行者保护

每个 SQLite 数据目录同一时间只能有一个活动 `DaemonApplication`：

1. Application 构造时取得 owner lease，也就是带 generation 的数据库租约。
2. 心跳定期续租；租约丢失后 Application 进入 failed，不能继续写入。
3. 新实例只有在旧租约过期后才能接管，并得到更大的 generation。
4. Session、Workflow、Bot 映射、Channel Delivery 和 Projection Settlement 等直接写入路径都会核对当前 owner。
5. 构造或启动恢复失败会停止心跳并释放租约；正常关闭也会释放。

这套规则挡的是两个进程同时修改一份本地数据库，不是多租户授权系统。

## 协议能力

`GET /capabilities` 返回服务版本、精确协议版本和功能版本。当前协议格式是：

```json
{
  "protocol": { "version": 4 }
}
```

客户端必须在发起普通业务请求前检查它。版本完全相同才继续；版本不同立即报 `IncompatibleProtocolError`，不使用 `minVersion/maxVersion` 范围，也不猜测旧响应。`features` 中各数字表示某项能力自己的版本，例如 Jobs、Workflow、Backup 和 Retention；它们不能代替总协议版本检查。

完整请求、错误、snapshot、SSE 和 breaking change 规则见 [Protocol Contract](./protocol-contract.md)。

## 清理与备份

`ApplicationRetentionService` 是统一清理入口。它按策略删除过期的 terminal Run、Workflow、事件和审计范围内的数据；删除结果与 `retention_audit` 在同一个 SQLite transaction 中提交，因此不会出现“数据删了但审计没写”或相反的半完成状态。

Application backup 包含 SQLite 数据库，以及明确配置的 artifacts、memory 和 execution output 目录。每个备份带 manifest 和逐文件 SHA-256 校验。恢复前先完成全部检查：manifest 格式、校验和、目标数据库不存在、目标目录为空；检查全部通过后才复制。符号链接和其他特殊文件会被拒绝，备份目录也不能放进被备份的源目录中。恢复只恢复 durable 数据，不复活旧进程；下次启动仍按普通 recovery 收束活动记录。

可执行的启动、Owner、排障、Retention、备份恢复和当前格式规则见 [Operations and Recovery](./operations-and-recovery.md)。

## 启动与关闭

- `startOpenHarnessDaemon()`：默认完整应用，CLI daemon command 使用。
- `startOpenHarnessServer()`：低层 embedding API，通过 `services` 注入 HTTP resource services，测试可注入 agent creator。
- 默认组合：`default-daemon.ts` 调用 `createDefaultApplicationServices()` 与 `createDefaultCommandCatalog()`，具体实现分别位于 `default-application-services.ts`、`default-command-catalog.ts`。
- CLI `commands/daemon.ts` 只处理 host/port/token、registry 与进程信号。

`DaemonApplication.ready()` 在 HTTP 对外可用前等待 durable recovery：

1. pending/running run -> `interrupted`，并把该 run 的 `running` transcript parts 同步置为 `interrupted`。
2. 没有 primary run、也没有 transcript message 归属的 input -> 创建一个 terminal `interrupted` owner run；它只记录 `recovery.kind=orphan_input`，不会自动重新执行模型或工具。
3. pending/running task -> `interrupted`。
4. pending permission -> `expired`，因为旧进程的 resolver 已不存在。
5. 对已无 active run 的 `closing` session 完成 archive。
6. claim 并收束遗留的 running Workflow，不重新执行 worker。

shutdown 先把 `DaemonOperationGate` 置为 closing 并等待现有 shared/barrier lease；随后 `SessionRunEngine.stopAndDrain()` 停止新 admission、同时中断 active/queued lanes 并等待 run promise 收敛；最后关闭 agents/children、HTTP listener/SSE 和 store。queued run 不会在已有 agent 关闭后被重新启动。

## 运行指标与只读排障

`GET /debug/runtime` 的 `metrics` 从 durable 数据汇总 Run、Attempt、Tool、token、Permission、Child 和 Projection 状态。它只用有限类别做标签，不把 sessionId、runId、traceId、文件路径、提示词或 Tool 参数塞进指标。指标汇总失败时返回空指标，不影响 Run 执行。

排查单次 Run 可使用 `ohs debug inspect-run <runId>`；查看投影补偿队列可使用 `ohs debug settlements`。两条命令都只读，也不会自动启动 Daemon；本机没有已注册的运行中 Daemon 时会提示用户先显式启动。默认隐藏正文和 Tool/Permission payload；`--include-content` 才展开并提示敏感信息风险，`--json` 用于脚本处理。发现数据断链、关闭 Run 仍有活动 Attempt、未知事件、待处理 settlement 或 Tool 结果未知时，命令会给出具体 warning 并返回非零退出码。当前没有自动 repair 命令。

## 不变量

- queue 形式的 root durable input/run 在一个 store transaction 中创建，再进入 coordinator；steer input 先 durable admit，成功交付后通过 primary run 或 transcript message 建立归属。
- 每个 durable input 最终可通过 primary run input 或 transcript message 解析到 owning run；失败/中断的 steer 也必须 terminalize。
- durable run 一旦 completed/failed/interrupted 就不可重新进入 running；child task 可绑定新的 run 并显式 reopen。
- 一个 terminal Run 不得留下 pending/running Attempt。
- 每个 pool-owned session 最多一个 root agent generation；closing entry 在旧实例完整释放前阻止 replacement，每个 agent 最多一个 active root run。
- 具名 Transaction 通过共享 `TransactionCoordinator` 同时保护 SQLite 与内存 read model；存储失败后不得暴露未提交实体。
- text delta 立即 live publish，并按 `150ms/8KB` checkpoint durable part；异常退出只允许丢失一个有界尾窗，正常 terminal/close 必须完整。
- SSE 序号跨 daemon restart 单调不复用；transient delta 不进入 durable replay log 或 client durable event index。
- required event projection 先于 `run.result` settlement。
- `run.started` projection 先于 `run.started` receipt settlement。
- framework 只通过 event/effect/handle 与 daemon 接触。
- daemon 不持有 QueryEngine，也不生成 framework child controls。
- SSE 来自 durable store/event publisher，不直接把 framework event 透传给 UI。
