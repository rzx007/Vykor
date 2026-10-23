# Coordinator 硬调度器调用链

> 状态：当前 Workflow DAG 调度、持久化和 child 执行的权威流程。

硬调度器用**代码**决定哪个子 agent 先跑、哪个后跑、哪些能并行、失败后怎么办，而不是只靠 Coordinator prompt 让模型自己记住。

当前职责分工是：

```text
Coordinator  → 理解目标、提交 Workflow spec、汇总结果
硬调度器     → 按排班表决定何时开工、重试、跳过、串行写冲突
Agent runner → 通过 framework child（或显式 external task adapter）真正跑 worker
```

设计演进与路线图见 [`coordinator-hard-scheduler-design.md`](./coordinator-hard-scheduler-design.md)。Coordinator 模式 / agent 加载见 [`coordinator-agents-design.md`](./coordinator-agents-design.md)。

## 核心模型：一次提交 + 调度循环 + 持久快照

分四层：

1. **入口**：模型调 `Workflow` 工具创建、恢复或做领域查询，普通生命周期控制交给 Jobs；代码可直接调用纯 `runWorkflow`；持久执行调用 Node `WorkflowHost.runPersistentWorkflow`。
2. **宿主**：Node WorkflowHost 接收工具的一次 invoke，绑定 owner、保存初始快照、持有后台执行和取消；Jobs 与关闭共用它。
3. **调度**：`runWorkflow` 维护 ready 队列、并发上限、失败策略、写冲突串行、预算与超时。
4. **执行**：每个 task 经 `WorkflowRunner`（默认 `createAgentWorkflowRunner`）调用 `context.agent.children.spawnChildAgent()`，再等待同一个 framework child 完成并把结构化结果回填；只有调用方显式提供 external worker adapter 时才走外部 task。

```text
┌─ 模型 / 代码入口 ─────────────────────────────────────┐
│ Workflow action=run|resume|timeline|history|...         │
│   run      → port.invoke → WorkflowHost.runPersistentWorkflow │
│   resume   → port.invoke → WorkflowHost.resumePersistentWorkflow │
│   timeline → load snapshot + filtered events           │
│   history  → advanced persisted-run query              │
│ JobRead/Wait/List/Cancel → 普通生命周期控制             │
└────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─ runWorkflow 调度循环 ─────────────────────────────────┐
│ createWorkflowPlan（DAG / mode / 并发 / budget）        │
│ ready queue → scheduleMore                             │
│   预算超限 → skip 未启动                                │
│   writeScope 冲突 → blocked，等运行中写任务结束         │
│   可跑 → runner(task) → onFinished → 传播失败 / 入队    │
│ onSnapshot / onEvent → Host → WorkflowRunRepository   │
└────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─ Agent WorkflowRunner（每个 task）─────────────────────┐
│ 默认 spawn framework child → await 同一 child          │
│ 显式 external adapter → awaitTask → 可选 git diff 摘要  │
│ 返回 summary / result / metadata / budget / status     │
└────────────────────────────────────────────────────────┘
```

## 涉及的模块

| 组件 | 文件 | 职责 |
|------|------|------|
| 公共调度入口 | `packages/coordinator/src/workflow/index.ts` | 从正式 `@vykor/coordinator/workflow` 导入纯调度 API |
| 调度循环 | `packages/coordinator/src/workflow/runner.ts` | `runWorkflow`、ready queue、并发、失败策略、budget、blocked task |
| task attempt | `packages/coordinator/src/workflow/task-runner.ts` | 单 task 执行、retry、timeout、progress budget |
| plan / 校验 | `packages/coordinator/src/workflow/validation.ts` | `WorkflowSpec` 展开、DAG、mode、writeScope 校验 |
| budget | `packages/coordinator/src/workflow/budget.ts` | preset、hard/soft limit、usage 汇总 |
| snapshot | `packages/coordinator/src/workflow/snapshot.ts` | run id、snapshot、summary、snapshot/result 转换 |
| notification | `packages/coordinator/src/workflow/notification.ts` | `<workflow-notification>` formatter/parser |
| reconciliation | `packages/coordinator/src/workflow/reconciliation.ts` | changed-file / write-scope overlap 检测、summary、follow-up spec |
| 仓库接口与解码 | `packages/coordinator/src/workflow/repository.ts` | 纯 Repository 契约；不保存活动执行 |
| Node 持久运行入口 | `packages/agent-runtime/src/workflow-entry.ts` | 正式 `@vykor/agent-runtime/node/workflow`；导出 Host、文件仓库和 runner |
| 活动执行与关闭 | `packages/agent-runtime/src/node/workflow/workflow-host.ts` | 同应用共享 Host，session 绑定视图；取消等待 worker 和终态保存 |
| 文件持久化实现 | `packages/agent-runtime/src/node/workflow/file-workflow-run-repository.ts` | `FileWorkflowRunRepository`；`.vykor/workflows/<runId>.json` + `.events.ndjson` |
| daemon 持久化实现 | `packages/server/src/application/workflow/session-workflow-run-repository.ts` | `SessionWorkflowRunRepository`；写入统一 SQLite |
| Coordinator 模式 | `packages/coordinator/src/coordinator-mode.ts` | `getCoordinatorTools()` 含 `Workflow`；prompt / user context |
| System prompt | `packages/coordinator/src/index.ts` | `COORDINATOR_SYSTEM_PROMPT` 说明何时用 Workflow vs Agent |
| Workflow 工具 | `packages/tools/src/agent/workflow/tool.ts` | 校验参数并传递真实 scope/signal、children 和捕获的角色集合；一次合法调用只 invoke 一次 |
| Jobs adapter | `packages/server/src/jobs/daemon-job-service.ts`、`packages/agent-runtime/src/node/jobs/local-agent-job-host.ts` | Workflow 普通 list/read/wait/cancel |
| Agent runner | `packages/agent-runtime/src/node/workflow/agent-workflow-runner.ts` | 默认 spawn/await framework child；也接受显式 external worker adapter |
| 工具注册 | `packages/agent-runtime/src/node/tools/default-tool-registry.ts` | Node 有绑定后的 WorkflowToolPort 时才注册工具；工具不从 context 查找仓库 |
| CLI 白名单 | `apps/cli/src/commands/main.ts` | coordinator 模式 `setAllowedTools(getCoordinatorTools())` |
| Workflow CLI | `apps/cli/src/commands/workflow.ts` | `vk workflow list/status/validate/template/reconcile/cancel`；JSON-first 管理面 |

## A. 入口阶段

### A1. Coordinator 模式工具面

开启 `VYKOR_COORDINATOR_MODE` 后，CLI 启动时：

```text
apps/cli/src/commands/main.ts
  if (isCoordinatorMode())
    queryEngine.setAllowedTools(getCoordinatorTools())
    # = ["Agent", "JobList", "JobRead", "JobWait", "JobSend", "JobCancel", "Workflow"]
```

Leader 不能直接 Read/Bash；简单委托使用 `Agent` + `JobWait`，后续输入和停止分别使用 `JobSend` / `JobCancel`；有明确 DAG / 重试 / 失败策略时用 `Workflow`。

### A1.5. Workflow CLI 管理面

`vk workflow` 是面向人的项目文件 CLI，不是 Coordinator 模式本身。它明确创建 `FileWorkflowRunRepository`，只读取 `.vykor/workflows/`：

```text
vk workflow list       # 历史 run 列表，可按状态/时间/reconcile/budget 过滤
vk workflow status     # latest 或指定 runId 的 snapshot + events
vk workflow validate   # dry-run 校验 spec，不启动 worker
vk workflow template   # 展示/参数化内置 workflow spec 模板
vk workflow reconcile  # 从 reconciliationPlan 生成 follow-up spec
vk workflow cancel     # stop backing task，并写 terminal snapshot
```

完整命令和示例见 [`workflow-cli.md`](./workflow-cli.md)。daemon/TUI/Web 使用 SQLite repository 和 Jobs API，不会把这些项目文件当成 daemon 的权威状态。

### A2. Workflow 工具

```text
模型调 Workflow
  → createWorkflowTool(port).execute()
      校验 action 和当前 Run scope
      传递 input / scope / signal / children / 本轮角色集合
  → port.invoke()（一次）
  → Node WorkflowHost 的当前 session 视图
      run     → 校验 spec → 创建 runner → 同步保存初始快照和 claim → 调度
      resume  → owner 与角色校验 → 恢复旧快照
      timeline / history / validate / template / reconcile → Node 动作处理
      detached → 返回 jobId；Host 保留后台 Promise 和取消监听
      waitForCompletion → 等待并返回原有结果信封
```

`persist` 默认 `true`。daemon 应用注入共享 SQLite Host；standalone Node Agent 默认创建文件仓库，也可以明确关闭或替换。缺少能力时不会注册 Workflow 工具，工具自身不创建文件 fallback。`persist: false` 使用 Host 内存仓库，不写文件。

请求 signal 只控制本次调用或等待；scope.signal 绑定拥有后台工作的 Run。显式取消、父 Run 取消和关闭等待 worker 及终态保存，写入失败返回错误。关闭一个 session 只处理自己的运行，应用关闭等待整个 Host。

常用 input 字段：

| 字段 | 含义 |
|------|------|
| `mode` | `parallel` / `sequential` / `pipeline` |
| `tasks[]` | `id` 必填；`dependsOn` / `retry` / `timeoutSeconds` / `writeScope` / `isolate` / `readOnly` … |
| `maxConcurrency` | 仅 parallel；sequential/pipeline 强制 1 |
| `failurePolicy` | `skip-dependents`（默认）/ `fail-fast` / `continue` |
| `budgetPreset` | `cheap-review` / `safe-write` / `fast-parallel`；可被 `budgetPolicy` 覆盖 |
| `defaultTaskTimeoutSeconds` | 默认 attempt 墙钟超时；task 级可覆盖 |
| `runId` / `latest` | 持久化 id；resume/status 可省略 runId 用 latest |

## B. 调度阶段（`runWorkflow`）

### B1. Plan

```text
createWorkflowPlan(spec)
  normalizeTasksForMode
    sequential/pipeline → 自动把 tasks[i] 依赖 tasks[i-1]
  validate timeouts / budgetPreset / budgetPolicy / tasks
  buildDependencyMap + dependentsMap
  topologicalOrder（环依赖抛错；缺失依赖抛错）
  resolveMaxConcurrency
    sequential|pipeline → 1
    parallel 未设 → Infinity
```

### B2. 调度循环

```text
emit workflow_started + snapshot
propagateInitialFailures（resume 时已有失败结果）
scheduleMore:
  while running < maxConcurrency && ready 非空:
    hard budget 超限 → skip 全部未启动 → break
    soft budget → serialize（有 running 则暂缓）和/或 conserve
    findNextRunnableReadyIndex
      writeScope 与 running 非隔离写任务重叠 → 跳过该 ready（记 blocked）
    取出 task → running
    runWorkflowTask(runner, …).then(onFinished)

onFinished:
  写入 result；emit task_finished + snapshot
  失败:
    fail-fast → skip 全部未启动
    skip-dependents → 递归 skip 下游
    continue → 依赖仅要求「已有结果」，不要求 completed
  成功/继续 → 依赖满足的下游进 ready
  scheduleMore
```

要点：

- **retry** 在 task 内部循环（`retry.maxAttempts`，含首次）；超时记 `failed + timedOut`，再走失败策略。
- **pipeline** 把上一步 `WorkflowTaskRunResult` 注入 `pipelineInput`；依赖结果也会写入 worker prompt。
- **snapshot / event 回调失败不影响调度**（best-effort）。

### B3. 写冲突与 reconcile

**运行时串行**（共享 cwd）：

- `readOnly: true` 或 `isolate: true` → 不参与共享写冲突。
- 否则用 `writeScope` 路径前缀重叠检测；重叠则后到的 ready task 进入 `blockedTasks`，等冲突 running 结束。

**跑完后 reconcile**（不自动 merge）：

| 类型 | 含义 |
|------|------|
| `write-scope-overlap` | 两个 completed 任务声明的 writeScope 重叠（needs-reconciliation） |
| `changed-file-overlap` | worker metadata / git diff 里真实改了同一文件（actual-conflict） |

结果带 `needsReconciliation`、`reconciliationIssues`、`reconciliationSummary`（按文件/任务聚合 insertions/deletions）。

## C. 执行阶段（Agent runner）

```text
createAgentWorkflowRunner()(context)
  buildWorkerPrompt
    task.prompt|description
    + conserve hint（budgetMode=conserve）
    + dependency results
    + pipeline input（mode=pipeline）
  │
  ├─ resumeFrom.metadata.workerTaskId 存在
  │    → live framework child 存在：awaitChildAgent(旧 id)
  │    → 否则：awaitTask(旧 durable/external task id)
  │    成功 → 映射结果 + git diff
  │    失败 → 记 resumeError，改走 spawn
  │
  └─ agent.children.spawnChildAgent(WorkflowWorkerSpawnConfig)
       isolate / permissionMode / tools / maxTurns（conserve 可覆盖）
       → agent.children.awaitChildAgent(spawn.taskId, { timeoutMs })
       → timeout 时 interruptChildAgent(spawn.taskId)
       → getDiffSummary（worktree/cwd git）
       → WorkflowWorkerResult
            status / summary / result
            metadata: agentId, workerTaskId, backendType, worktree, diff, changedFiles
```

worker adapter 放在 `@vykor/agent-runtime/node/workflow`，`@vykor/coordinator` 保持纯调度。显式注入的 external worker 仍可通过 `awaitTask` / `stopTask` adapter 接入；默认 framework worker 直接使用 child handle。旧的文件邮箱、团队文件和权限同步包已经退役，不参与执行。

## D. 持久化与恢复

纯调度器只接收快照和事件回调；WorkflowHost 调用 `WorkflowRunRepository` 保存，不由调度器选择数据位置。当前有两种明确实现：

| 使用场景 | Repository | 状态放在哪里 |
|---|---|---|
| daemon、多客户端、Bot、TUI/Web/Desktop | `SessionWorkflowRunRepository` | 与 Session/Run 相同的 SQLite |
| 独立项目文件 CLI 或 standalone Node Agent 默认配置 | `FileWorkflowRunRepository` | `.vykor/workflows/` |

文件实现的目录结构：

```text
.vykor/workflows/
  <runId>.json           # WorkflowRunSnapshot
  <runId>.events.ndjson  # 一行一个 WorkflowRunEvent
```

快照关键字段：`status`、`spec`、`plan`、`results`、`pendingTaskIds`、`runningTasks`（含 attempt / workerTaskId 等 metadata）、`blockedTasks`、`budget`。

恢复：

```text
host.resumePersistentWorkflow(snapshot, runner)
  status !== "running" → 直接从 snapshot 合成 WorkflowRunResult（不重跑）
  status === "running" → runWorkflow(spec, {
       runId, createdAt,
       initialResults: 已完成/失败/跳过的 terminal 结果,
       initialRunningTasks: 仍在跑的任务,
       onSnapshot / onEvent → 继续写盘
     })
```

已 terminal 的 task **不会重跑**；仍在跑的任务会先尝试等待当前进程仍可找到的同一个 framework child 或显式 external task。找不到旧 live worker 时，显式 resume 可以创建 replacement；daemon 进程启动恢复则不会调用 resume 重放工作，而是把遗留 running Workflow 收束为 cancelled terminal 状态。

## E. 三种 mode / 失败策略 / 预算

### Mode

| mode | 行为 |
|------|------|
| `parallel` | 尊重 `dependsOn`；可并发；受 `maxConcurrency` 限制 |
| `sequential` | 自动链式依赖；并发=1；**不**自动传上一步产物 |
| `pipeline` | 同 sequential 链式；额外把上一步结果作 `pipelineInput` |

### Failure policy

| 策略 | 行为 |
|------|------|
| `skip-dependents` | 默认；失败只跳过依赖它的下游 |
| `fail-fast` | 任一失败，未启动全部 skip |
| `continue` | 尽量跑完可运行任务；依赖只需「有结果」 |

### Budget

- **Hard**（`maxTokensUsed` / `maxTimeUsedMs`）：达到后不再启动新 worker，未启动标 skipped。
- **Soft**（`softMax*` + `onSoftLimit`）：`continue` / `serialize` / `conserve` / `serialize-and-conserve`。
- **Preset**：`cheap-review`、`safe-write`、`fast-parallel`；显式 `budgetPolicy` 覆盖 preset。
- 用量来自 task result / progress metadata 的 `budget` 或等价字段；最终汇总进 snapshot / notification。

## F. 结果信封

跑完返回：

```xml
<workflow-notification>
<payload>{…JSON…}</payload>
</workflow-notification>
```

JSON 含：`runId`、`status`、`summary`、`mode`、任务计数、`tasks[]`（含 attempts / timedOut / skippedReason）、`needsReconciliation`、`reconciliationIssues`、`reconciliationSummary`、`budget`。

detached run 先返回 Job receipt：

```json
{"kind":"job","action":"created","jobId":"workflow:<runId>","jobKind":"workflow","status":"running"}
```

随后 `JobRead` 返回通用 snapshot，并在 `details` 中带上 plan、pending/running/blocked、results、budget 和 reconciliation；事件时间线使用 `Workflow action: "timeline"`。

与单 worker 的 `<task-notification>` 分开；Coordinator 应以 structured payload 为准，不要靠闲聊文本猜状态。

## G. 事件类型

| type | 何时 |
|------|------|
| `workflow_started` / `workflow_finished` | 整次 run 起止 |
| `task_started` / `task_progress` / `task_finished` | 单 task 生命周期 |
| `task_blocked` | ready 但因 writeScope 冲突暂缓 |
| `workflow_budget_conserving` | 触达 soft budget |
| `workflow_budget_exceeded` | 触达 hard budget，开始 skip |

## H. 何时用 Workflow vs Agent

| 场景 | 选择 |
|------|------|
| 一次性调研 / 交互式来回修正 | `Agent` + `JobWait` / `JobSend` |
| 明确 DAG、顺序、pipeline、重试、失败策略、并发上限 | `Workflow` |
| 并行写同一目录且未 isolate | 声明 `writeScope`，让调度器串行 |
| 可隔离的并行写 | `isolate: true`（worktree） |
| 中断后续跑 | 宿主显式配置 repository 后使用 `action: "resume"` |
| 只看当前进度 | `JobRead`；需要阻塞等待时用 `JobWait` |
| 查看事件时间线 | `Workflow action: "timeline"` |
| 高级历史筛选 | `Workflow action: "history"`；普通 owned Job 列表用 `JobList` |

## I. 测试入口

| 范围 | 文件 |
|------|------|
| 纯调度（fake runner） | `packages/coordinator/src/workflow/__test__/scheduler.test.ts` |
| 文件仓库兼容 | `packages/agent-runtime/src/node/workflow/__test__/file-workflow-run-repository.test.ts` |
| Node 动作 / timeline / history | `packages/agent-runtime/src/node/workflow/__test__/workflow-actions.test.ts` |
| runner 单元 | `packages/agent-runtime/src/node/workflow/__test__/agent-workflow-runner.test.ts` |
| 工具 → scheduler → framework child smoke | `packages/agent-runtime/src/node/workflow/__test__/workflow-smoke.test.ts` |

工具参数与单次 port 调用见 `packages/tools/src/agent/workflow/tool.test.ts`；内存/文件/SQLite 共用生命周期场景见 `tests/workflow/lifecycle-scenarios.ts`，Node Host 和 Server Host 测试分别执行。真实 Agent.close 顺序见 `packages/agent-runtime/src/node/workflow/__test__/agent-workflow-close.test.ts`。

## J. 当前能力边界

当前已经具备：内存调度、framework child runner、显式 repository 持久化、resume、writeScope 串行、timeout、事件流、budget soft/hard + preset、reconcile follow-up spec、模板，以及 Jobs 统一生命周期控制。TUI 的统一 Jobs Panel 可以看 Workflow 列表和 Steps；它不维护第二份 Workflow 状态。

当前明确不做：

- daemon 重启后自动重放模型、Tool 或旧 worker；
- 自动读取或迁移旧项目 Workflow JSON；
- 自动 merge 多个 worktree；
- 用 Jobs 替代 Workflow 自己的 DAG、模板、timeline 和 reconcile 语义。
