# 设计：Coordinator 硬调度器演进

> 状态：历史演进设计。本文保留当时的动机和版本路线，里面的 `TaskManager`、`swarm`、`WorkflowRunStore` 等名字不代表当前入口。**当前运行时调用链与模块真相以 [`coordinator-hard-scheduler-flow.md`](./coordinator-hard-scheduler-flow.md) 为准**。

## 一句话

Vykor 已经能拉起子 agent，也能用 swarm 管通信、任务和 worktree。

硬调度器补的是一层“排班表”：由代码明确决定哪个子 agent 先跑、哪个后跑、哪些能并行、失败后怎么办，而不是只靠 Coordinator prompt 让模型自己记住。

## 和现有系统的关系

不要重做子 agent，也不要重做 swarm。

现有能力分工：

| 部分 | 现在负责什么 | 后续仍然负责什么 |
| --- | --- | --- |
| `Agent` 工具 | 拉起一个子 agent | 继续作为启动 worker 的入口 |
| `JobSend` | 给已有 worker 发后续消息 | 统一负责 continuation / 修正 |
| `JobWait` | 等一个或多个后台任务结束 | 统一负责等待 worker 完成 |
| `JobCancel` | 停止后台任务 | 统一负责取消/失败处理 |
| `TaskManager` | 记录任务状态、输出、完成监听 | 继续作为任务生命周期真相 |
| `swarm` | 管 agent backend、消息、worktree 隔离 | 继续负责 worker 实际运行环境 |
| `Coordinator` | 理解用户目标、拆任务、总结结果 | 逐步从“自己记调度”变成“生成计划 + 汇总结果” |

新增的硬调度器在它们上面：

```text
用户目标
  -> Coordinator 拆任务
  -> 硬调度器按排班表执行
  -> Agent / swarm / TaskManager 真正跑 worker
  -> JobWait / completion listener 收结果
  -> Coordinator 汇总回复用户
```

也就是说：

```text
swarm 负责把工人跑起来。
硬调度器负责决定什么时候让哪个工人开工。
Coordinator 负责理解目标和总结结果。
```

## 当前缺口

当前 Coordinator 主要靠系统提示词约束 Leader：

- “先并行调研”
- “等结果回来”
- “再实现”
- “最后验证”

这属于模型软编排。简单任务够用，但复杂工作流不稳定：

- 依赖没完成，下游任务就启动了；
- worker 失败后，不清楚该重试、跳过还是继续；
- 多个写任务可能同时改同一片文件；
- 并发数量和预算没有硬限制；
- pipeline 上一步结果不一定稳定传给下一步；
- 最终结果汇总依赖模型读聊天记录，不够结构化。

硬调度器要把这些变成代码规则。

## 第一版只做什么

先做一个很薄的 workflow runtime，不上复杂任务板。

第一版只需要支持：

1. 任务列表。
2. 任务依赖。
3. `sequential` / `parallel` / `pipeline` 三种 mode。
4. 最大并发数。
5. 失败策略。
6. worker 重试。
7. 结果按任务顺序汇总。

先不要做：

- 持久化数据库；
- Hermes Kanban 那种 claim / assignee / board；
- 多层嵌套 orchestrator；
- 自动语义冲突解决；
- 精准 token 成本分摊。

## 三种 mode

### `parallel`

适合调研、审查、独立检查。

规则：

- 没有依赖的任务可以同时跑；
- 有依赖的任务必须等依赖完成；
- 同时运行数量受 `maxConcurrency` 限制；
- 失败默认只影响依赖它的下游任务。

例子：

```text
Explore auth     \
Explore tests     -> Plan fix -> Implement -> Verify
Explore settings /
```

### `sequential`

适合“按顺序做几件事”，但不强调上一步输出自动喂给下一步。

规则：

- 每次只跑一个；
- 前一个完成后再跑后一个；
- 本质是线性任务队列。

例子：

```text
clean -> build -> test
```

### `pipeline`

适合“上一步产物就是下一步输入”。

规则：

- 每次只跑一个；
- 后一步会收到前一步的结构化结果；
- 适合 research -> implement -> verify。

例子：

```text
research files -> implement exact patch -> verify changed behavior
```

`sequential` 和 `pipeline` 的区别：

- `sequential` 只保证顺序；
- `pipeline` 还保证结果传递。

## 失败策略

第一版建议三种：

| 策略 | 行为 | 适合场景 |
| --- | --- | --- |
| `skip-dependents` | 某任务失败，只跳过依赖它的下游任务，其他分支继续 | 默认策略 |
| `fail-fast` | 任一任务失败，未启动任务全部跳过 | 发布、危险操作 |
| `continue` | 即使失败也继续跑可运行任务，最后统一汇总失败 | 调研、竞品分析、多方案探索 |

重试应该是 runtime 规则，而不是 prompt 里的口头提醒：

```text
task.retry.maxAttempts = 2
```

如果第一次 worker 失败，调度器用同一个 task 生成第二次 attempt。

## 写任务和冲突

第一版不用自动 merge，但要避免明显事故。

建议规则：

- read-only 任务可以大胆并行；
- write 任务默认建议 `isolate: true`，走独立 worktree；
- 不隔离的 write 任务需要声明 `writeScope`；
- 如果两个未隔离 write 任务的 `writeScope` 重叠，调度器应该串行它们，或者标记冲突。

例子：

```text
Task A: writeScope = ["packages/auth"]
Task B: writeScope = ["packages/auth/src/index.ts"]
```

这两个不能在共享 cwd 下并行写。

## 结果汇总

每个 worker 完成后，调度器保存一条结构化记录：

```text
taskId
attempt
status
summary
outputTail
startedAt
finishedAt
taskManagerTaskId
dependencies
```

最终给 Coordinator 的不是散落的聊天记录，而是类似：

```text
research-auth: completed
research-tests: completed
implement: failed after 2 attempts
verify: skipped because implement failed
```

这样 Coordinator 再负责对用户说人话。

## 借鉴 Python 原版

Python 原版值得保留的思路：

- coordinator mode 只给 Leader 开放有限工具；
- worker 结果用 `<task-notification>` 这种结构化信封；
- 后台任务由 task manager 管；
- worker 完成后，由 drain 逻辑把结果作为后续输入交给 Coordinator。

对应 TS：

- `packages/coordinator` 继续管 prompt、agent 定义、模式判断；
- `packages/services/src/tasks` 继续管真实任务生命周期；
- `packages/tools/src/agent` 管 Agent 创建，`packages/tools/src/job` 管生命周期控制；
- 新增调度层只做 workflow 状态机和执行顺序。

## 借鉴 Hermes

Hermes 值得借鉴的是思想，不是重量级形态：

- 每个 task 有 run / attempt 记录；
- 依赖满足后才 promotion；
- 有最大并发；
- 有失败重试；
- 有运行时状态，而不是只靠模型记忆；
- 复杂任务可以拆成叶子 worker。

第一版不要搬：

- Kanban 数据库；
- assignee/profile 路由；
- claim lock；
- dashboard board；
- 多层 orchestrator。

Vykor 可以先做内存版，等稳定后再考虑持久化。

## 推荐落地顺序

### R1：纯调度核心

新增一个纯 TypeScript 的调度器，只用 fake runner 测试。

验证：

- DAG 校验；
- 缺失依赖报错；
- 环依赖报错；
- `parallel` ready queue；
- `maxConcurrency`；
- `sequential` 顺序；
- `pipeline` 结果传递；
- 失败后跳过下游；
- retry attempt。

这一步不启动真实 agent。

### R2：接 Agent runner

调度器不直接 spawn 进程，而是通过一个 adapter：

```text
runWorker(task) -> workerTaskId
waitWorker(workerTaskId) -> result
stopWorker(workerTaskId)
```

adapter 里面复用现有：

- `Agent`;
- `JobWait` / `JobCancel`;
- framework child `awaitChildAgent` / `interruptChildAgent`;
- external worker 的 `TaskManager.awaitTask` / `stopTask` adapter；
- `swarm` backend；
- `isolate` worktree。

### R3：把结果喂回 Coordinator

调度器跑完一批任务后，生成结构化摘要，让 Coordinator 做最后总结。

可以继续兼容 `<task-notification>`，也可以增加更适合 workflow 的 envelope：

```xml
<workflow-notification>
...
</workflow-notification>
```

第一版可以先不用新 XML，直接用内部对象测试。

### R4：持久化和恢复

等内存版稳定后，再考虑把 workflow run 写入：

```text
.vykor/workflows/<runId>.json
```

这样中断后能恢复：

- 哪些 task 完成了；
- 哪些 task 失败了；
- 哪些还没跑；
- 哪些后台 task id 还在运行。

## 后续版本路线图

这条路线不要一口吃成 Hermes Kanban。每个版本只补一层能力，上一层稳定后再往上叠。

### V0：文档和边界

目标：统一理解，不改变运行时行为。

交付：

- 明确硬调度器不是替代 swarm；
- 明确 `Coordinator`、`Agent`、`TaskManager`、`swarm` 的分工；
- 明确第一版只做内存调度，不做持久化和 UI；
- 明确 `parallel`、`sequential`、`pipeline` 的语义。

不做：

- 不改 `Agent` 工具；
- 不改 worker spawn；
- 不引入新存储。

### V1：内存版调度核心

目标：先把“排班表”本身做正确。

交付：

- `WorkflowSpec` / `WorkflowTask` 的最小结构；
- DAG 校验；
- ready queue；
- `maxConcurrency`；
- `parallel` / `sequential` / `pipeline`；
- `skip-dependents` / `fail-fast` / `continue`；
- retry attempt；
- fake runner 单测。

不做：

- 不启动真实子 agent；
- 不接真实 `TaskManager`；
- 不保存 workflow 文件。

判断完成的标准：

- 给一组 fake tasks，调度器能稳定算出谁先跑、谁后跑、谁跳过；
- 测试能覆盖环依赖、缺失依赖、失败重试、并发上限。

### V2：接入真实 Agent runner

目标：让硬调度器真的能调 swarm 工人干活。

交付：

- runner adapter：`runWorker`、`waitWorker`、`stopWorker`；
- 默认通过 `Agent` 创建 framework child，并由 Jobs adapter 控制 live handle；external worker 复用 `TaskManager` adapter；
- worker 完成后写入 workflow ledger；
- pipeline 下游能收到上游 summary/result；
- 失败后按策略跳过或重试。

不做：

- 不做跨进程恢复；
- 不做复杂冲突解决；
- 不做 dashboard。

判断完成的标准：

- 一个 `research -> implement -> verify` 工作流能真实跑完；
- `research-a` / `research-b` 能并行；
- `implement` 失败时 `verify` 不会误跑。

### V3：持久化和恢复

目标：Coordinator 或进程中断后，workflow 状态不丢。

交付：

- `.vykor/workflows/<runId>.json`；
- 保存 task 状态、attempt、taskManagerTaskId、输出摘要；
- 启动时能识别仍在运行的后台 task；
- 已完成 task 不重复跑；
- 未完成 task 可继续、跳过或重新 attempt。

不做：

- 不做多机器 claim；
- 不做 profile/assignee 路由；
- 不做 Kanban board。

判断完成的标准：

- 中断后恢复，不会把已完成 worker 再跑一遍；
- 仍在运行的 worker 可以继续 wait；
- 已失败的 task 能按策略重试或保持失败。

### V4：写任务隔离和冲突策略

目标：复杂并行写代码时不互相踩。

交付：

- `readOnly` / `writeScope` / `isolate` 字段；
- writeScope 重叠检测；
- 未隔离写任务自动串行或报 conflict；
- 默认建议写任务用 worktree isolation；
- 汇总 isolated worktree 的分支和路径。

不做：

- 不自动 merge 多个 worktree；
- 不自动解决语义冲突；
- 不替用户做危险 git 操作。

判断完成的标准：

- 两个改同一目录的写任务不会在共享 cwd 下并发；
- 隔离任务能并发跑，并把 worktree 信息带回结果。

### V5：预算、观测和高级策略

目标：让长工作流可控、可看、可调。

交付：

- workflow 级最大任务数、最大 attempt、最大运行时长；
- worker usage 能回传后再做 token/cost 预算；
- 运行状态快照；
- 简单 CLI/status 展示；
- 超时 worker 的 stop / retry 策略；
- 后续可考虑 planner 生成 workflow spec。

不做：

- 不急着做图形化 dashboard；
- 不急着做多层 orchestrator；
- 不急着做 Hermes 级任务板。

判断完成的标准：

- 用户能看见 workflow 正在等谁、谁失败了、谁被跳过；
- 超预算或超时不会无限跑；
- 结果汇总不再依赖翻聊天记录。

## 最小可行路径

如果只想最快看到价值，按这个顺序做：

```text
V1 内存调度核心
  -> V2 接真实 Agent/TaskManager
  -> V4 写任务隔离
  -> V3 持久化恢复
  -> V5 预算和观测
```

原因：

- V1 先保证调度规则正确；
- V2 立刻让真实子 agent 受代码调度；
- V4 尽早解决并行写代码的安全问题；
- V3 再解决长任务恢复；
- V5 最后补运营级体验。

## 成功标准

第一阶段完成后，Coordinator 不再只是“会建议并行”的 prompt，而能真正保证：

- 下游不会早跑；
- 并发不会超上限；
- 失败会按策略传播；
- worker 会按配置重试；
- 最终结果有结构化 ledger；
- swarm 仍然负责真正的 worker 运行。

这就是从“模型软编排”到“代码硬编排”的第一步。

## 当前实现状态

运行时细节（工具入口、调度循环、持久化路径、信封格式）见 [`coordinator-hard-scheduler-flow.md`](./coordinator-hard-scheduler-flow.md)。

以下 V0-V14.2 条目记录能力演进；其中旧 TUI Workflow Runs 面板及其 `f` follow-up 操作已经被统一 Jobs Panel 收口取代。当前 TUI 只通过 Jobs list/read/cancel 管理 Workflow Job，并在选中详情中展示 Steps；timeline、history、reconcile 和 follow-up spec 生成继续由 Workflow 工具或 `vk workflow` CLI 提供。

- V0：已完成。边界和路线图写在本文档里。
- V1：已完成。`@vykor/coordinator` 提供纯内存 `WorkflowSpec`、DAG 校验、三种 mode、并发上限、失败策略、retry 和结构化结果。
- V2：已完成基础版。`@vykor/tools` 提供 `createAgentWorkflowRunner`；默认通过 framework child controller 启动并直接等待 worker，显式 external backend 通过注入的 task adapter 等待结果。
- V2.5：已完成。默认工具注册表新增 `Workflow` 工具，Coordinator/Leader 可以一次提交 workflow spec，让代码负责调度顺序、依赖、重试和聚合。
- V2.6：已完成。增加 smoke 测试，覆盖 `Workflow` 工具 -> scheduler -> agent runner -> framework child spawn/await 的无 daemon 闭环。
- V2.7：已完成。固定 `<workflow-notification>` envelope，提供 formatter/parser，并让 `Workflow` 工具返回结构化结果。
- V3.1：已完成。新增 workflow snapshot / store：运行开始、worker 运行中、task terminal、最终完成都会产出快照；`Workflow` 工具默认把 run 写到项目 `.vykor/workflows`。
- V3.2：已完成。新增恢复入口：scheduler 支持 `initialResults` 续跑；store 支持 `latest/load/resume/resumeLatest`；`Workflow` 工具支持 `action: "status"` 和 `action: "resume"`，恢复时不会重跑已完成 terminal task。
- V3.3：已完成。running snapshot 会记录 runner 上报的 `taskManagerTaskId` 等 metadata；恢复时 agent runner 会优先等待仍存活的 framework child 或 external task，不可达时才 spawn replacement worker。
- V4.1：已完成。scheduler 会检测声明了 `writeScope` 的非隔离写任务；重叠 scope 在共享 cwd 下自动串行，不重叠 scope 可以并行；`readOnly: true` 和 `isolate: true` 不参与共享 cwd 写冲突。
- V4.2：已完成。snapshot/status 会记录 `blockedTaskIds` 和 `blockedTasks`，说明哪个 ready task 因为 `writeScope` 冲突暂缓、正在等待哪些 running task。
- V5.1：已完成基础版。支持 workflow 默认 task timeout 和单 task timeout；超时 attempt 会标记为 `failed + timedOut`，继续走既有 retry / failurePolicy。
- V5.2：已完成基础版。scheduler 支持 `onEvent` 结构化事件流，覆盖 workflow started/finished、task started/progress/blocked/finished。
- V5.3：已完成基础版。最终结果和 notification 会输出 `needsReconciliation` / `reconciliationIssues`，把多个 completed worker 的重叠 `writeScope` 显式标为需要 reconcile。
- V5.4：已完成基础版。persistent workflow 会把 `onEvent` 写入 `.events.ndjson`，`Workflow` 的 status payload 会返回 snapshot + events timeline。
- V5.5：已完成基础版。worker 可通过 progress metadata 或 `budget` 字段上报 token/时间预算消耗，scheduler 会写入 running snapshot、task result、workflow budget 汇总。
- V6.1：已完成基础版。`Workflow` status payload 包含结构化 `timeline` / `timelineText`，并支持 `view: "timeline"` 直接返回人类可读时间线。
- V6.2：已完成基础版。reconcile issue 会区分声明层 `write-scope-overlap` 和 worker metadata 上报 `changedFiles` 形成的 `changed-file-overlap` 实际文件重叠。
- V6.3：已完成基础版。`budgetPolicy` 支持 token/time 阈值；当已知消耗达到阈值后，scheduler 不再启动后续 worker，而是把未启动 task 标记为 skipped。
- V7.1：已完成基础版。`Workflow` status timeline 支持按 `taskIds`、`eventTypes`、`statuses` 过滤，JSON payload 同步返回过滤后的 `timeline` / `timelineText`。
- V7.2：已完成基础版。agent workflow runner 会在 worker 完成后自动读取对应 worktree/cwd 的 git changed files，并写入 result metadata，reconcile 不再完全依赖 worker 手工声明。
- V7.3：已完成基础版。`budgetPolicy` 支持 soft limit 和 `onSoftLimit`，达到软阈值后可 serialize 后续 worker、进入 conserve prompt 模式，或两者同时启用。
- V8.1：已完成基础版。`Workflow` status JSON 增加 `timelineControls` 和 `timelineSummary`，让 UI 可以直接渲染 task/status/event type filter 控件和汇总计数。
- V8.2：已完成基础版。agent workflow runner 会采集 git diff summary，输出 changed files、文件状态分类以及 insertions/deletions 汇总，并继续兼容旧的 `changedFiles` 字段。
- V8.3：已完成基础版。`budgetPolicy.conserve` 支持配置 conserve prompt hint、permission mode 和 maxTurns，soft budget 后的 worker 可以更明确地降成本运行。
- V9.1：已完成基础版。`Workflow` status JSON 的 `timelineControls` 同时返回 `available` 和 `selected`，前端可以直接渲染筛选控件并保存/恢复筛选状态，同时继续兼容旧的顶层 `taskIds` / `eventTypes` / `statuses`。
- V9.2：已完成基础版。`<workflow-notification>` 增加 `reconciliationSummary`，按文件和任务聚合 reconcile issue、diff status、insertions/deletions，让 UI 可以按文件查看冲突任务和变更规模。
- V9.3：已完成基础版。新增 `budgetPreset`，支持 `cheap-review`、`safe-write`、`fast-parallel` 三种常用预算策略；显式 `budgetPolicy` 字段仍可覆盖 preset 默认值。
- V10.1：已完成基础版。`WorkflowRunStore` 增加轻量 `listSummaries()`，`Workflow` 工具支持 `action: "list"`，可以按 run status 和 limit 浏览历史 workflow run。
- V10.2：已完成基础版。`<workflow-notification>` 增加 `reconciliationPlan`，为每个 reconcile issue 生成稳定 follow-up action、推荐 task id、prompt、依赖 task 和 writeScope。
- V10.3：已完成基础版。新增内置 workflow spec templates，并通过 `Workflow action: "template"` 暴露 `research-implement-verify`、`parallel-review`、`safe-write` 模板，减少重复手写工作流。
- V11.1：已完成基础版。`Workflow action: "list"` 支持按 `runIdPrefix`、created/updated 时间范围、`needsReconciliation` 和 `budgetPreset` 过滤历史 run。
- V11.2：已完成基础版。新增 `createWorkflowSpecFromReconciliationPlan` 和 `Workflow action: "reconcile"`，可把已持久化 run 的 `reconciliationPlan.actions` 转成 follow-up workflow spec。
- V11.3：已完成基础版。`Workflow action: "template"` 支持 `templateParameters`，可覆盖 task prompt、writeScope、maxConcurrency、budgetPreset 和 failurePolicy。
- V12.1：已完成基础版。新增 `createWorkflowValidationReport` 和 `Workflow action: "validate"`，可在启动 worker 前 dry-run 展开 DAG、预算 preset 和非隔离写范围冲突。
- V12.2：已完成基础版。新增 `cancelPersistentWorkflow` 和 `Workflow action: "cancel"`，会停止 backing framework child 或 external task，并把 running task 标记为 killed、未启动 task 标记为 skipped 后持久化 terminal snapshot。
- V12.3：已完成基础版。内置 workflow templates 增加 `version` 字段，模板输出可明确说明模板版本和含义。
- V13.1：已完成基础版。新增普通 CLI 管理面 `vk workflow list/status/validate/template/reconcile/cancel`，对接同一份 `.vykor/workflows` 持久化数据，输出 JSON，方便脚本和后续 TUI/Web 复用。完整用法见 [`workflow-cli.md`](./workflow-cli.md)。
- V13.2（历史、已被收口）：当时完成过独立 TUI Workflow Runs 管理面板，读取同一份 workflow JSON 状态。该面板现已删除并由统一 Jobs Panel 取代；timeline/filter/reconcile 等 Workflow 领域查询保留在 Workflow 工具和 CLI。
- V13.3：已完成基础版。持久化 `Workflow action: "run"` 默认 detached 提交，快速返回 running snapshot 和 runId，后台继续调度 worker；不再给 worker wait 隐式套 300s 默认超时，只有显式 `timeoutSeconds` / task timeout 才会判超时。
- V13.4：已完成基础版。修复 subprocess task-worker 一轮完成后 stdin pipe 未释放导致 child process 不退出、TaskManager task 长时间停留在 running、Workflow awaitTask 卡住的问题；worker 结束时会释放 stdin 并关闭 runtime cleanup。
- V14.1（历史、已被收口）：独立 TUI `/workflow` 面板曾支持数字键选择 reconciliation action，并用 `f` 提交 detached follow-up run；该面板和快捷键现已删除。当前 follow-up spec 由 Workflow `action: "reconcile"` 或 `vk workflow reconcile` 生成，后续执行由调用方显式提交。
- V14.2：已完成。模型侧 Workflow 生命周期控制硬切到 Jobs：detached run 返回 `jobId`，普通状态/列表/取消使用 `JobRead/JobList/JobCancel`；Workflow 工具只保留 run/resume/validate/template/reconcile 以及明确的 timeline/history 领域查询。CLI 继续提供领域管理命令；TUI `/workflow(s)` 现在只是统一 Jobs Panel 的别名，不再恢复独立管理面。

下一步建议：

- 产品化 backlog：Web workflow 管理面、follow-up run 与 origin run 的结构化关联展示、timeline 更细粒度搜索，以及长期历史清理/分页。
- 运维化 backlog：补 metrics/export、长期历史清理、run artifact 打包，以及跨进程/多实例 claim lock。
- 智能化 backlog：让 planner 基于目标自动选择模板、填参数、validate 后再提交 workflow。
