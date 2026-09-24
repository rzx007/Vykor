# Runtime Hardening 与可运维性实施计划

> 状态：已完成（A1-D4，2026-08-22）。本文是历史实施记录；当前生命周期以 [Agent Lifecycle Contract](../agent-lifecycle-contract.md) 为准，当前文档入口见 [`docs/README.md`](../README.md)。
>
> 本计划基于 2026-08-22 对当前 `main` 分支的实际代码核查。它只处理当前仍存在的运行时缺口，不重复建设已经完成的 Agent 生命周期、Run lane、输入幂等、Daemon 重启收束、Permission 持久化、SSE cursor replay、Runtime Debug View 等能力。
>
> 生命周期语义继续以 [Agent Lifecycle Contract](../agent-lifecycle-contract.md) 为准；framework/daemon 边界继续以 [Agent Runtime Framework Architecture](../agent-runtime-framework-architecture.md) 和 [Daemon Application Architecture](../daemon-application-architecture.md) 为准。本计划不能成为另一份互相冲突的架构规范。

## 实施进度

- [x] A1：建立 Input/Run 崩溃窗口测试基线。
- [x] A2：为 queue Input + Run 提供原子准入。
- [x] A3：重启时把无 owner Input 收束为 interrupted Run，不自动重放副作用。
- [x] B1：定义 Durable Event Envelope v1。
- [x] B2：建立 Durable Event Registry、校验和升级入口。
- [x] B3：持久化 Projection Settlement。
- [x] C1：增加 Child Hierarchy Budget。
- [x] C2：明确 Child Failure Policy 的归属。
- [x] D1：增加 Durable Run Attempt。
- [x] D2：Tool Execution Identity 与未知结果。
- [x] D3：增加 Runtime Metrics。
- [x] D4：增加只读 Run Inspector 与 Projection Diagnostics。

A3 的 HTTP 兼容性决策采用方案二：当前继续允许裸 HTTP 请求省略 body `id`，但权威客户端文档明确说明只有调用方稳定 ID 才具备响应丢失后的端到端幂等保证。将 ID 改为必填留作独立 breaking API Issue。

## 一、目标

在不推倒现有架构的前提下，补齐下面五类真实缺口：

1. Input 已落盘、但 owning Run 尚未建立时的进程崩溃窗口。
2. durable event 缺少版本、集中注册和运行时载荷校验。
3. live projector 的 pending settlement 只在内存中，无法跨 Daemon 重启继续收束。
4. Child Agent 缺少统一的数量、深度和根运行级资源预算。
5. Run 没有 durable Attempt 记录，当前日志也无法形成长期的失败率和延迟指标。

完成后必须保持下面的运行关系：

```text
Client request
  -> durable Input / Run admission
  -> per-session Run Coordinator
  -> Framework AgentRunHandle
  -> ordered AgentEvent
  -> durable projection
  -> Session snapshot / SSE / metrics / inspector
```

用白话表达，目标是：

- 请求重复发送不会重复执行；
- 进程死在任意关键步骤，都不会留下永远显示“运行中”的幽灵记录；
- 旧事件在代码升级后仍能被识别或明确拒绝；
- 投影失败不会只靠旧进程内存记住；
- 子 Agent 不会无限递归或无限并发；
- 一次 Run 到底尝试了几次、为什么重试、耗时和费用如何，可以被查询和统计。

## 二、本轮明确不做

以下内容不属于本计划，实施过程中不得顺手扩大范围：

- 不把当前架构迁移成完整 Event Sourcing；不要求删除所有状态表后仅靠事件重建整个 Session。
- 不持久化每一条 `output.text.delta`；继续保留 live delta + durable checkpoint/full part 的现有策略。
- 不把已经结束的 Run 重新改回 `running`；显式恢复继续创建新 Run。
- 不在 Daemon 重启后盲目重放可能产生外部副作用的 Tool。
- 不重写 QueryEngine。
- 不创建通用 `AgentStateMachine`、`RunStateMachine`、`ChildStateMachine` 框架；只在现有领域边界补必要的转移断言。
- 不冻结所有 Provider、UI、Channel、Tool 功能；仅冻结会同时改动 Run/Event/Projection/Recovery 协议的无关重构。
- 不在第一阶段引入完整消息队列、通用 dead-letter queue 或分布式调度系统。

## 三、必须始终成立的规则

实施每个任务时都必须验证：

1. Framework 继续拥有 live Agent、Run Handle 和 Child Handle；Daemon 只拥有 durable 状态和多客户端策略。
2. 同一 Session 同一时刻最多执行一个 root Run；排队由 `SessionRunCoordinator` 管理。
3. 一个外部 Input 最多归属于一个 root Run；相同 Input ID 的不同 payload 必须失败。
4. `completed`、`failed`、`interrupted` Run 不可重新进入活动状态。
5. Daemon 重启只恢复 durable 状态，不假装恢复旧进程中的 Promise、AbortSignal、Tool 进程或 live Handle。
6. 无法确认是否完成的外部副作用只能标记为 unknown/interrupted，不能自动执行第二次。
7. required event projection 必须先完成，公开的 `run.started`/`run.result` receipt 才能完成。
8. 新增持久表和事件字段必须有 SQLite migration、旧数据读取测试和回滚失败测试。

## 四、里程碑与依赖

```text
Milestone A：Admission Consistency
  A1 基线失败测试
  A2 Queue Input + Run 原子准入
  A3 Steer / orphan Input 重启收束
        |
        +-------------------+
                            v
Milestone B：Durable Event Contract
  B1 Event envelope v1
  B2 Registry / validation / upgrade
  B3 Projection settlement 持久化
        |
        +-------------------+
                            v
Milestone C：Runtime Resource Safety
  C1 Child hierarchy budget
  C2 Child failure policy contract
        |
        +-------------------+
                            v
Milestone D：Attempts 与可运维性
  D1 Run Attempt
  D2 Tool execution identity / unknown outcome
  D3 Metrics
  D4 inspect-run / projection diagnostics
```

Milestone A、B 是下一个版本的合并门槛。C、D 可以在 A、B 的数据契约稳定后并行推进，但不得提前改变 Run terminal 和 recovery 语义。

---

# Milestone A：Admission Consistency

## Task A1：建立 Input/Run 崩溃窗口测试基线

### 目的

先用测试固定当前缺口，避免在没有可观察失败的情况下修改准入链。

### 新增测试

在 server/store 测试中覆盖：

1. Input 成功写入后、`createRun()` 前注入失败。
2. queue 请求未返回 HTTP 202 时模拟进程退出，重启后 Input 不得永久无 owner。
3. steer Input 已持久化但尚未被 active Run 接收时模拟进程退出。
4. 同一个稳定 Input ID 重试时：
   - 相同 payload 返回同一结果；
   - 不同 content、delivery 或 metadata 明确冲突；
   - traceId 不同不产生第二次执行。
5. 没有 active Agent runtime 时，准入失败不能留下 `running` Session。

### 建议文件

- `packages/server/src/http/session/__test__/session-run-engine.test.ts`
- `packages/server/src/http/__test__/http.test.ts`
- `packages/services/src/session-runtime/__test__/store.test.ts`

### 完成标准

- 至少有一个测试能在改动前稳定复现“Input 已存在但没有 owning Run”。
- 测试不依赖固定延时；使用注入点、受控 Promise 或真实子进程退出控制故障时刻。
- 测试清楚区分 queue 和 steer，因为两者的 owner 建立时机不同。

## Task A2：为 queue Input + Run 提供原子准入

### 目的

普通 queue 请求不再分两次独立保存 Input 和 Run。所谓“原子”，就是两条记录要么一起成功，要么一起失败。

### 实现

1. 在 `SessionStore` 增加窄接口，例如：

   ```ts
   admitPromptWithRun({
     input: { id, sessionId, delivery: "queue", content, metadata },
     run: { id?, metadata },
   }): { input: SessionInputRecord; run: SessionRunRecord }
   ```

2. 接口内部使用现有 `SessionStore.transaction()`：
   - create-or-validate Input；
   - 查找已有 owning Run；
   - 没有时创建 `pending` Run；
   - 保持 `session_run.input_id` 唯一约束；
   - Input/Run 事件与实体一起提交。
3. `SessionRunEngine` 的 queue 路径改用该接口，事务提交后才 enqueue。
4. 相同 ID 的并发请求继续共享现有 `pendingAdmissions` promise。
5. 数据库提交成功、enqueue 前发生错误时，保留 `pending` Run，由重启恢复或本进程兜底收束；不得回滚已经对客户端具有稳定身份的 durable admission。

### 不应改变

- HTTP 仍返回 202 和既有 `input/run/queue_state` 结构。
- Run 初始 durable 状态继续使用 `pending`，本轮不为命名统一引入 `accepted` 状态。
- `SessionRunCoordinator` 不写 durable Run 状态。

### 建议文件

- `packages/services/src/session-runtime/store.ts`
- `packages/services/src/session-runtime/types.ts`
- `packages/server/src/http/session/session-run-engine.ts`
- 对应 store/engine/HTTP tests

### 完成标准

- 任意一次 Store 写失败后，不会只暴露新 Input 或只暴露新 Run。
- 相同 Input ID 在重试、并发重试和 Daemon 重启后最多对应一个 Run。
- 入队失败或 Agent 创建失败最终留下 `failed/interrupted` Run，而不是活动幽灵 Run。

## Task A3：收束 steer 和历史 orphan Input

### 目的

steer 必须先保存 Input，再尝试交给当前 active Run，因此不能简单套用 queue 的 Input+Run 原子事务。需要定义 Daemon 退出时尚未绑定 owner 的 Input 应该怎样结束。

### 决策

第一版采用安全策略：

```text
durable Input
  + 没有 primary run.inputId 归属
  + 没有 transcript message.runId 归属
  + Daemon 已重启
    -> 创建一个 terminal interrupted Run
    -> metadata.recovery.kind = "orphan_input"
    -> 不自动执行 Tool 或模型
```

用户之后可以通过现有显式 resume API 创建新 Input、新 Run。

### 实现

1. 在 Store 增加只读查询或原子 recovery 方法，找出无 owning Run 的 Input。
2. Daemon startup recovery 在开放 listener 前完成 orphan 收束。
3. 恢复记录带上：
   - 原 Input ID；
   - delivery；
   - restart reason；
   - 原 traceId；
   - `recovery.kind = "orphan_input"`。
4. 不重新提交模型，不调用 Tool，不尝试找回旧 active Run。
5. 为官方 HTTP client 保留自动生成稳定 Input ID 的行为，并在 API 文档中把调用方稳定 ID 标为可靠重试的必要条件。

### 兼容性说明

直接 HTTP 调用如果不传稳定 ID，服务端虽然能在重启后收束数据库记录，但响应丢失的调用方无法知道应查询哪个 Input。因此需在本任务中做出并记录以下二选一决策：

- 方案一：`POST /sessions/:id/prompts` 要求 body `id` 或 `Idempotency-Key`，缺失返回 400；
- 方案二：暂时继续生成服务端 ID，但文档明确说明该调用不具备响应丢失后的端到端幂等保证。

推荐方案一。官方 client 已经自动携带 ID，主要影响手写 HTTP 调用者。

### 完成标准

- 启动恢复后不存在无 owner 的历史 Input。
- orphan steer 不会在重启后自动再次执行。
- recovery 事件可以通过 Session snapshot 和 SSE 查询。
- 恢复方法可以重复执行，不会重复创建 terminal Run。

---

# Milestone B：Durable Event Contract

## Task B1：定义 Durable Event Envelope v1

### 目的

让数据库中的事件拥有明确版本。以后字段调整时，可以识别旧数据，而不是默认所有历史 payload 都符合最新 TypeScript 类型。

### 数据模型

`SessionEventRecord` 增加：

```ts
schemaVersion: number
```

新事件默认写入当前类型的版本。第一阶段可统一为 `1`，但 registry 必须允许不同 event type 以后拥有不同当前版本。

### 实现

1. SQLite migration 为 `session_event` 增加非空 `schema_version`，历史记录回填 `1`。
2. `AppendEventInput` 默认版本只能在集中 registry 中决定，业务调用方不应随意填写。
3. `SessionStore.load()`、`listEvents()`、Session snapshot 和 client types 透传版本。
4. SSE data 保留完整 envelope。
5. Client reducer 遇到未知高版本事件时：
   - 不崩溃整个 stream；
   - 记录可诊断错误；
   - 不推进该事件的已应用 cursor，避免静默丢状态。

### 建议文件

- `packages/services/src/session-runtime/schema.ts`
- `packages/services/src/session-runtime/types.ts`
- `packages/services/src/session-runtime/migrations/`
- `packages/services/src/session-runtime/store.ts`
- `packages/client/src/types/index.ts`
- `packages/client/src/state/reducer.ts`

### 完成标准

- 新数据库和旧数据库升级后都能读取事件。
- migration 重复运行安全。
- SSE replay/live 使用同一个带版本 envelope。
- 未知版本不会被静默当成当前版本处理。

## Task B2：建立 Durable Event Registry、校验和升级入口

### 目的

Framework `AgentEvent` 已经是集中联合类型；本任务只收口持久化的 `session.*` 等事件，不重复创建第二套 Framework registry。

### 实现

1. 建立集中 durable event registry，至少包含：
   - event type；
   - current schema version；
   - payload validator；
   - 可选的 `upgrade(fromVersion, payload)`；
   - 是否属于 session/global event。
2. 替换生产代码中的主要裸字符串，或至少让 `appendEvent()` 在运行时经过 registry。
3. 对现有事件做分组，不要求一次写出几十个独立 class：
   - session/input/run；
   - message/part；
   - task/execution；
   - permission；
   - workflow/schedule；
   - project/system。
4. 未注册事件的策略必须显式：生产环境拒绝，测试 fixture 可通过专用扩展入口注册；不得默认放行拼写错误。
5. 增加 v1 fixture，证明未来 v2 upgrader 的调用链可工作。

### 完成标准

- `rg 'appendEvent\(\{' packages/server packages/services` 中每个生产 event type 都能在 registry 找到。
- payload 缺字段、字段类型错误、未知版本都有明确测试。
- 旧事件升级不会修改原始数据库行；升级发生在读取边界，除非以后有单独 migration 命令。

## Task B3：持久化 Projection Settlement

### 目的

把当前 projector 内存中的 `pendingSettlement` 变成可在 Daemon 重启后继续处理的 durable 修复任务。

### 先做失败分类

在编码前用一个短 ADR 固定三类失败：

1. **可重试 durable terminal projection**：例如 child 已关闭，但写 terminal task/run 时失败。
2. **只能补偿**：live route 或 child 初始化失败，重启后不能恢复旧 Handle，只能把相关 durable 实体收束为 failed/interrupted。
3. **存储完全不可用**：连 settlement 本身也无法写入；此时传播原错误，依靠 Run executor fallback 和下一次 startup 扫描活动实体，不能声称实现 exactly-once。

### 数据模型建议

新增窄表 `projection_settlement`：

```text
id
projector
root_session_id
event_sequence
action
payload_json
status              pending | retrying | resolved | abandoned
attempt_count
last_error
next_retry_at
created_at
updated_at
resolved_at
```

这里保存的是“重启后仍能执行的修复动作”，不是 live Handle、Promise 或 AbortSignal。

### 实现顺序

1. 把 `DaemonAgentEventProjector.pendingSettlement` 的动作表示提取为可序列化 DTO。
2. projector 处理失败时，先尝试保存 settlement，再把 required event failure 传播给 Framework。
3. 同一 `projector + rootSession + eventSequence` 建唯一约束，防止重复 repair。
4. `DaemonApplication.ready()` 前运行 settlement recovery：
   - terminal projection 可安全重试；
   - live-only 行为改做 durable compensation；
   - 成功后标记 resolved；
   - 失败保留原错误和 attemptCount。
5. 第一版只实现有限重试，不运行无限循环：启动时一次、下一相关事件前一次、显式 repair 一次。
6. 不在本任务引入通用后台队列；`nextRetryAt` 只为后续扩展保留明确数据语义。

### 完成标准

- child terminal projection 失败后立刻 kill Daemon，重启仍能完成或明确保留 pending settlement。
- pending settlement 未解决前，相关 root projection 水位不能越过失败事件。
- repair 重复调用安全。
- 无法持久化 settlement 时，错误不得被日志吞掉或伪装成成功。
- 正常 shutdown 后 pending settlement 数量为零；异常 shutdown 后 `/debug/runtime` 能显示数量。

---

# Milestone C：Runtime Resource Safety

## Task C1：增加 Child Hierarchy Budget

### 目的

限制一个 root Run 可以创建的 Child 数量和递归深度，防止 Agent 无限创建 Agent。

### 第一阶段预算

```ts
interface AgentChildBudget {
  maxDepth: number;
  maxActiveChildren: number;
  maxTotalChildren: number;
}
```

推荐先提供保守默认值，并允许 Settings/Agent 配置覆盖。默认值必须通过现有实际 workflow 测试校准，不能只凭感觉决定。

### 计数归属

- `maxDepth`：从 root agent 为 0 开始，创建 child 时检查下一层。
- `maxActiveChildren`：整棵 root tree 当前处于 starting/running/idle/suspended/closing 的 live child 数。
- `maxTotalChildren`：一次 root Run 生命周期内成功分配过的 child 总数；child 关闭后不退还，以防循环创建绕过限制。

### 实现

1. root tree 共享 budget ledger；创建 child 的 manager 仍是生命周期 owner。
2. 在申请 worktree/environment 之前检查预算，失败不得留下目录或 registry 记录。
3. 预算拒绝使用结构化错误，例如 `AgentChildBudgetExceededError`，包含 limit、current、dimension。
4. 发布可观察的 domain/structured log，但不要伪造 `child.created`。
5. parent abort/close 后 ledger 随 root Run/Agent 生命周期释放。

### 完成标准

- 达到 depth/active/total 任一上限时，下一次 spawn 在副作用前失败。
- 并发 spawn 不会同时越过同一个上限。
- child 创建失败、关闭失败或 suspend 不导致计数泄漏。
- root 能查询当前预算快照，供 `/debug/runtime` 和未来 Metrics 使用。

## Task C2：明确 Child Failure Policy 的归属

### 目的

明确 child 失败后父级继续、失败还是重试，避免行为隐藏在 Tool/Workflow 的错误处理代码里。

### 边界决策

`AgentChildManager` 只返回事实：

```text
completed | failed | interrupted | stopped
```

它不替父级决定失败策略。策略由调用 child 的 producer 负责：

- 单次 Child Tool 默认把 failed 返回给模型，由模型决定下一步；
- Workflow step 使用自己的 `failurePolicy/retry`；
- Parent abort 始终向下传播 interrupt；
- 自动重试必须创建新的 child Run，不复活 terminal Run。

### 实现

1. 在 child tool/workflow adapter 的公共结果中统一暴露 failure kind。
2. 删除通过错误文本判断 child 状态的逻辑。
3. 文档列出每个 producer 的默认策略。
4. 为 parent continue、workflow fail、workflow retry、parent abort 各增加一个测试。

### 完成标准

- ChildManager 中不存在产品级“父是否失败”的隐藏策略。
- 所有自动 retry 都可从 Run/Attempt 或 Workflow 记录中看见。
- 同一个 terminal child Run 不被重新打开。

---

# Milestone D：Attempts 与可运维性

## Task D1：增加 Durable Run Attempt

### 目的

区分“用户提交的一次 Run”和“系统为了完成这个 Run 实际调用模型多少次”。

### 领域模型

```text
Input
  -> Run
      -> Attempt #1
      -> Attempt #2
```

建议记录：

```ts
interface SessionRunAttemptRecord {
  id: string;
  runId: string;
  sequence: number;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  provider?: string;
  model?: string;
  retryReason?: string;
  errorKind?: string;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  startedAt?: number;
  finishedAt?: number;
  createdAt: number;
  updatedAt: number;
}
```

### 必须先回答的协议问题

1. Provider 请求真正发出后才创建 Attempt，还是进入 Provider adapter 就创建？推荐后者，避免连接失败没有记录。
2. Provider 内部网络 retry 是新 Attempt 还是同一 Attempt 的 transport retry？推荐只有可能产生第二份模型账单或第二个模型输出时才创建新 Attempt；纯连接建立重试记录在 metadata/metrics。
3. 用户显式 resume/retry 是否复用旧 Run？继续创建新 Run，并通过 recovery metadata 关联 sourceRunId。
4. Tool retry 不计为 Run Attempt；它属于后续 Tool Attempt。

### 实现顺序

1. 增加 schema、migration、store CRUD 和 snapshot/client types。
2. 先只记录现有的一次执行，保证每个新 Run 至少有一个 Attempt。
3. 把 Provider fallback/retry 边界接入 Attempt 状态更新。
4. Run terminal 前强制收束仍为 pending/running 的 Attempt。
5. Daemon 重启把旧 running Attempt 置为 cancelled/failed，并保留旧 Run interrupted 语义。

### 完成标准

- 每个执行过模型的新 Run 至少有一个 Attempt。
- 两次 Provider 尝试共享 Run ID，但 Attempt ID/sequence 不同。
- Run terminal 后没有活动 Attempt。
- 旧数据库没有 Attempt 的历史 Run 仍能正常读取，客户端显示为“无 attempt 明细”，不伪造历史。

## Task D2：Tool Execution Identity 与未知结果

### 目的

为可能产生外部副作用的 Tool 建立稳定执行身份，避免重启后把“结果未知”错误地理解为“没有执行”。

### 实现

1. 每次 Tool 调用使用稳定 `toolCallId`；一次重试使用新的 `toolAttemptId`。
2. 统一结构化 Tool failure kind：
   - permission
   - policy
   - timeout
   - command
   - transport
   - provider
   - interrupted
   - unknown_outcome
3. Tool started 已持久化、completed 未持久化且 Daemon 异常退出时：
   - 标记 `unknown_outcome` 或 `interrupted`；
   - 不自动再次调用；
   - 在 Run inspector 中明确显示“可能已经执行”。
4. 只有 ToolDefinition 明确声明安全重试，或者调用方提供外部 idempotency key 时，才允许自动 Tool retry。

### 完成标准

- `chargeCreditCard` 一类假想非幂等工具在 started 后崩溃，不会被自动执行第二次。
- read-only 工具可以通过显式 retry policy 重试，并产生独立 Tool Attempt。
- 错误分类不再依赖字符串匹配。

### 已落地说明

- durable transcript 中的 Tool part 就是第一版 Tool Attempt 账本：`toolCallId` 表示模型发起的那次调用，`toolAttemptId` 表示实际执行次数。
- Runtime 统一返回结构化 `failureKind`；异常重启会把尚在运行的 Tool 标为 `unknown_outcome`，不会自动重放。
- `ToolDefinition.safeToRetry` 只声明“允许上层制定重试策略”，当前版本没有暗中自动重试 Tool，因此不会因为打开该字段就重复外部副作用。

## Task D3：增加 Runtime Metrics

### 目的

现有 structured logs 和 `/debug/runtime` 回答单次故障；Metrics 用于回答一段时间内的失败率和延迟趋势。

### 最小指标

```text
vykor_runs_total{status}
vykor_runs_active
vykor_run_duration_ms
vykor_run_attempts_total{provider,model,status}
vykor_model_request_duration_ms{provider,model}
vykor_tool_calls_total{tool,status,failure_kind}
vykor_tool_call_duration_ms{tool}
vykor_tokens_total{provider,model,direction}
vykor_permissions_pending
vykor_child_agents_active
vykor_projection_settlements_pending
vykor_projection_failures_total{projector,action}
```

### 约束

- label 不得包含 sessionId、runId、traceId、文件路径、用户输入或任意高基数字段。
- Trace ID 继续留在日志中，不作为 Metrics label。
- 第一版先定义内部 Metrics sink 和内存实现；是否导出 Prometheus/OpenTelemetry 由独立集成决定。
- duration 必须使用单调时钟或可靠的开始/结束时间差。

### 完成标准

- Run、Attempt、Tool、Permission、Child、Projection 主路径都有计数和耗时测试。
- Metrics 失败不得影响 Run 执行。
- `/debug/runtime` 可显示当前 gauge，但不混入高基数历史明细。

### 已落地说明

第一版指标由 durable Run、Attempt、Tool part、Permission、Child task 和 Projection Settlement 即时汇总进 `/debug/runtime.metrics`。指标构建器发生异常时返回空快照，不把可观测性故障传进 Run 主流程。指标 label 只使用有限状态、provider、model、tool、projector 和 action，不包含会话 ID、Run ID、路径或正文。

## Task D4：增加只读 Run Inspector 与 Projection Diagnostics

### 目的

把现有分散在 Session snapshot、events、logs 中的数据整理成一次可读的排障视图。

### 第一阶段命令

```bash
vk debug inspect-run <runId>
vk debug settlements
```

`inspect-run` 输出：

```text
Run
├─ Input
├─ Source/recovery relation
├─ Attempts
├─ Messages / parts
├─ Tool calls / attempts
├─ Permissions
├─ Child executions
├─ Trace ID
├─ Relevant durable events
└─ Terminal result / unresolved warnings
```

### 实现原则

- 第一阶段只读，不自动修改数据库。
- 默认隐藏 prompt、model output、Tool 参数和结果；用户显式 `--include-content` 才显示，并给出敏感信息提示。
- 输出同时支持适合人的文本和 `--json`。
- 若发现 orphan Input、active row on closed daemon、unknown event version 或 pending settlement，返回非零退出码并给出具体诊断。

### 后续 repair 命令

只有 B3 完成并稳定后，才能另开 Issue 评估：

```bash
vk debug retry-projection <settlementId>
vk debug abandon-projection <settlementId> --reason ...
```

`abandon` 属于有数据影响的操作，必须有审计事件和显式确认；不在本计划第一阶段实现。

### 完成标准

- 任意 Run 可通过一个命令看到 Input、Attempt、Tool、Permission、Child 和 terminal 状态的关联。
- Inspector 不 warm Agent、不执行 Tool、不改变 Store。
- 缺失或不一致的数据以 warning/error 显示，不通过猜测补造。

### 已落地说明

- HTTP 只读入口：`GET /debug/runs/:runId`、`GET /debug/projection-settlements`。
- CLI：`vk debug inspect-run <runId>`、`vk debug settlements`；两者支持 `--json` 和显式 `--include-content`。旧命令 `list-projection-settlements` 保留为兼容别名。
- 默认对 Input、消息正文、Tool 参数/结果、Permission payload、Child output、Event/Settlement payload 打码。
- orphan input、已关闭 Run 上仍活动的 Attempt、未知事件、pending settlement 和 `unknown_outcome` Tool 会产生 warning，并让 CLI 设置退出码 2。
- 没有实现 retry/abandon 等修复命令，Inspector 不 warm Agent，也不修改 Store。
- 为保持只读边界，CLI 不会为了排障命令自动启动 Daemon；没有已注册 Daemon 时会提示先显式启动。

---

# 五、Failure Injection 测试矩阵

每个里程碑不能只写 happy path。最终至少覆盖下面的故障点：

| 故障位置 | 预期 durable 结果 | 是否允许自动重试 |
|---|---|---|
| Input 写入失败 | 没有新 Input、没有新 Run | 客户端可用同 ID 重试 |
| Input 已写、Run 创建前退出 | 重启后形成 interrupted owner Run | 不自动执行模型 |
| Run 已创建、enqueue 前退出 | Run 重启后 interrupted | 由用户显式 resume |
| Agent 创建失败 | Run failed，Session 不永久 busy | 可以新 Run 重试 |
| Provider 请求前失败 | Attempt failed，Run 按策略失败/重试 | 按 Provider policy |
| Provider 请求结果未知 | Attempt unknown/failed | 默认不盲目重试 |
| Tool started 后进程退出 | Tool unknown_outcome，Run interrupted | 默认禁止 |
| Permission pending 时退出 | Permission expired，Run interrupted | 用户显式 resume |
| Child environment acquire 失败 | 无 child registry/task 泄漏 | 可以新 child 重试 |
| Child terminal projection 失败 | pending settlement 持久化 | 可安全 repair |
| Settlement 写入也失败 | 原错误传播，startup active-row recovery | 不声称 exactly-once |
| SSE replay/live 交界断线 | 客户端从 cursor 重连，最终收敛 | 自动重连 |
| Metrics sink 抛错 | 业务执行不受影响 | 可丢该次 metric |

进程级故障优先使用独立临时数据库和真实子进程，不在单进程测试中伪装“重启”。测试必须验证重启前后的 SQLite 状态，而不只验证内存对象。

# 六、建议 GitHub Issues

可以按下面标题直接创建 Issues：

## Milestone：Admission Consistency

- `[runtime] Add failure baseline for orphan durable inputs`
- `[store] Atomically admit queued input and run`
- `[recovery] Terminalize unowned inputs after daemon restart`
- `[http] Require a caller-stable prompt idempotency key`

## Milestone：Durable Event Contract

- `[events] Add schemaVersion to durable event envelopes`
- `[events] Register and validate every durable event type`
- `[events] Add read-time event schema upgrades`
- `[projection] Persist recoverable projection settlements`
- `[recovery] Resolve pending projection settlements before ready`

## Milestone：Runtime Resource Safety

- `[agent-runtime] Enforce child depth and count budgets`
- `[agent-runtime] Make child budget accounting concurrency-safe`
- `[workflow] Make child failure and retry policy explicit`

## Milestone：Attempts and Operability

- `[runtime] Add durable run attempt records`
- `[providers] Project provider retry and fallback attempts`
- `[tools] Add tool execution identity and structured failure kinds`
- `[observability] Add runtime metrics sink and core metrics`
- `[debug] Add read-only inspect-run command`
- `[debug] Add projection settlement diagnostics`

# 七、每个 PR 的统一完成清单

每个 PR 在合并前必须完成：

- [x] 先有能失败的回归测试，再修改生产代码。
- [x] 新状态有唯一 owner，并说明释放或终态边界。
- [x] 新持久字段有 migration、旧数据加载测试和序列化测试。
- [x] terminal 状态不可被迟到事件重新打开。
- [x] 相同 ID + 相同 payload 可安全重试；相同 ID + 不同 payload 明确失败。
- [x] shutdown/restart 不依赖旧 live Handle 或 Promise。
- [x] 非幂等副作用不会被恢复流程自动执行。
- [x] required projection 失败不会被 observer/log/metrics 吞掉。
- [x] 更新权威架构文档，而不是新增重复规则文档。
- [x] focused tests 通过。
- [x] 受影响 package typecheck 通过。
- [x] 全量测试或明确记录未执行原因。
- [x] `git diff --check` 通过。

验收记录：全仓 `check-types` 为 33/33；受影响包的完整测试均通过（Core 101、Agent Runtime 74、Tools 158、Services 140、Client 52、Server 225、CLI 182）。全仓 `bun run test` 被仓库既有的 `@vykor/terminal`“没有测试文件即退出 1”配置中止；并发负载下前端一个 5 秒用例曾超时，单独复跑为 10/10 通过。

# 八、验证命令

依赖安装完整后，至少执行：

```bash
pnpm --filter @vykor/services test
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/server test
pnpm --filter @vykor/client test

pnpm --filter @vykor/services check-types
pnpm --filter @vykor/agent-runtime check-types
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/client check-types

git diff --check
```

涉及真实 Daemon restart、SQLite migration、SSE reconnect 或 Tool side effect 的任务，必须额外运行对应的 server integration/soak test。不能只用 mock 单元测试替代进程级恢复验证。

# 九、版本建议

## 下一个版本：Runtime Consistency

必须完成：A1、A2、A3、B1、B2、B3。

发布标准：

- 没有 orphan Input；
- 没有重启后继续显示 active 的旧 Run/Task/Permission；
- durable event 都带已知版本；
- projection settlement 可以被重启发现和诊断；
- 现有 CLI/TUI/Desktop 的 prompt、steer、permission、child、SSE 行为不回退。

## 后续版本：Resource Safety and Attempts

完成：C1、C2、D1、D2。

发布标准：

- Child 数量和深度有硬上限；
- Provider fallback 可以从 Attempt 记录解释；
- Tool 未知结果不会被自动重复执行。

## 再后续版本：Operability

完成：D3、D4，并根据真实故障数据决定是否增加定时 backoff、dead-letter/abandon 流程或外部 Metrics exporter。

# 十、最终验收场景

最终用一个真实临时 SQLite 数据库完成下面的端到端场景：

```text
1. Client 用稳定 inputId 提交 prompt
2. Daemon 创建 Input + Run
3. Provider 第一次 Attempt 失败，第二次成功
4. Run 创建两个 Child，其中一个失败但父继续
5. 第三个 Child 因预算上限被副作用前拒绝
6. Tool started 后强制 kill Daemon
7. 新 Daemon 启动：
   - 旧 Run/Attempt/Tool 被安全收束
   - pending Permission expired
   - orphan Input 有 terminal owner
   - pending projection settlement 可见并按策略处理
8. Client 从 Last-Event-ID 重连并最终收敛
9. inspect-run 能解释完整链路
10. Metrics 能看到 Run、Attempt、Tool、Child 和 projection 结果
```

验收的重点不是“自动把一切继续跑完”，而是：系统对已经发生什么、无法确认什么、允许用户怎样安全恢复，都给出一致且可查询的答案。
