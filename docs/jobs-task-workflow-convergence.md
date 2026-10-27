# Jobs Task/Workflow Convergence

> 状态：历史实施完成记录。当前 Jobs 权威契约见 [Jobs 统一后台任务协议](./jobs-protocol.md)，本文只解释 2026-08-17 的收口过程。

## 结论

收口目标不是让 Jobs 创建所有工作，而是让后台工作的生命周期控制只有一套入口：

```text
producer-specific creation:
  BackgroundShellCreate / Agent / TerminalOpen / Workflow

common lifecycle control:
  JobList / JobRead / JobWait / JobSend / JobCancel
```

Task 和 Workflow 自己仍可保留创建、验证、恢复、模板、reconcile、历史查询和时间线等领域命令。应该移除的是与 Jobs 重复的普通 list/read/wait/send/cancel。

不建议增加万能 `JobCreate`，也不建议为了保留 `TaskUpdate` 而增加通用 `JobUpdate`。

## 2026-08-20：公共面第一阶段完成

这次收口没有改写下面的模型工具迁移历史，而是把同一条边界落实到 HTTP client、slash command 和 TUI：

- 2026-08-20：HTTP client、slash command 与 TUI 已硬切到 Jobs。
- 后台 shell 由 `/background` 与 `POST /background-shells` 创建；创建后统一使用 `JobRead/Wait/Send/Cancel`。
- 旧 `/tasks`、`TaskSnapshot` 与 TUI `session.tasks` 已删除，不保留兼容别名。
- TUI 的 `jobState/jobs` 只是客户端缓存；权威状态仍在 Terminal、两个分离的执行后端、`SessionExecutionRecord` 持久化投影和 daemon SQLite 中的 `SessionWorkflowRunRepository`，由 `DaemonJobService` 在读取时聚合。
- `TodoPanel`、`SwarmPanel` 和独立 `WorkflowRunsPanel` 已移除。普通 Workflow 列表和详情进入统一 Jobs Panel，Steps 从所选 Workflow Job 的 `JobRead` details 展示。

旧的通用 `TaskManager` 已拆成两块：`DetachedProcessSupervisor` 只管 shell/dream/显式 Agent 子进程，`ChildManager 的定点 run 记录` 只管 framework child Agent 的回调句柄。`SessionExecutionRecord` 是当前 schema 的内部持久化投影；模型侧 shell producer 已硬切为 `BackgroundShellCreate`，没有 `TaskCreate` 别名。

当前实现没有 `parentJobId` 和规范化 Job SSE。这份历史记录不承诺后续阶段；若要增加这些能力，以新的协议设计、版本和测试为准。

## 当前工具面

### Jobs

| 工具 | 当前能力 |
|---|---|
| `JobList` | 按 kind/status/时间/终态/limit 列出 Terminal、Task、child Agent、dream、Workflow；模型侧默认最近 100 条 |
| `JobRead` | 返回输出、cursor、截断标记、统一快照和可选 producer details |
| `JobWait` | 并发等待 1 到 32 个 Job；分别返回结果或错误；timeout 不取消 |
| `JobSend` | 给 running Terminal/Agent 输入 |
| `JobCancel` | 按 owner 路由到底层 producer 取消 |

### Task/Agent 重复面

| 当前工具 | 与 Jobs 的关系 | 额外能力 |
|---|---|---|
| `TaskGet` | 被 `JobRead` 覆盖 | 暴露 TaskManager 私有 TaskInfo |
| `TaskList` | 被 `JobList` 覆盖 | 只看 TaskManager，可按原始 task status 过滤 |
| `TaskOutput` | 被 `JobRead` 覆盖 | 直接按 maxBytes 读日志尾部 |
| `TaskStop` | 被 `JobCancel` 覆盖 | 直接识别 framework child handle |
| `TaskWait` | 大部分被 `JobWait` 覆盖 | 批量等待、heartbeat、hard timeout 自动 stop |
| `SendMessage` | 被 `JobSend` 覆盖 | 直接识别 framework child handle |
| `TaskUpdate` | 没有 Jobs 对应物 | 当前实现并没有可靠保存 progress/statusNote |

### Workflow 重复面

`Workflow` 当前把多个领域动作放在同一个工具里：

| action | 是否属于 Jobs 控制 | 建议 |
|---|---|---|
| `run` | 否，创建执行 | 保留 |
| `resume` | 否，恢复并重新开始执行 | 保留 |
| `validate` | 否，验证任务图 | 保留 |
| `template` | 否，生成模板 | 保留 |
| `reconcile` | 否，生成冲突修复 Workflow | 保留 |
| `status` JSON | 是，普通状态读取 | 由 `JobRead` 替代 |
| `cancel` | 是，取消运行 | 由 `JobCancel` 替代 |
| `list` 基础部分 | 是，列出 Workflow Job | 由 `JobList(kind=workflow)` 替代 |
| `status` timeline | 否，Workflow 领域时间线 | 改名为明确的 `timeline` 能力并保留 |
| `list` 高级历史过滤 | 否，Workflow 历史查询 | 改名为明确的 `history` 能力并保留 |

## 审计发现

### TaskWait 和 JobWait 的 timeout 语义相反

当前 `TaskWait`：

```text
heartbeat timeout -> 返回进度，不停止
hard timeout      -> 返回进度，并主动 TaskStop
调用方 abort       -> 主动停止所有正在等待的任务
```

当前 `JobWait`：

```text
timeout       -> 只结束等待，Job 继续运行
调用方 abort   -> 只结束等待，Job 继续运行
明确 JobCancel -> 才停止 Job
```

收口时必须选择一种语义。建议保留 Jobs 的规则：等待与取消分开。理由是 timeout 只说明调用方不想继续占住这一轮，并不证明后台工作应该被杀掉；需要 hard deadline 的调用方应显式执行 `JobWait` 后再 `JobCancel`。

因此不能只把 prompt 里的 `TaskWait` 替换成 `JobWait`，还要删除所有“wait timeout 自动清理任务”的假设，并由 session/parent 生命周期负责真正的孤儿清理。

### TaskWait 与旧版 JobWait 的批量差异

Coordinator 经常一次派出多个 Agent，`TaskWait(taskIds[])` 能并行等待并分别返回结果。让模型串行调用多个 `JobWait` 会增加等待时间和轮次。

模型工具 `JobWait` 现已接受 `jobIds: string[]`，在工具层并发调用单 Job 的 `AgentJobHost.wait()`；底层协议仍保持单 Job wait，便于各 producer 实现。返回值保留每个 Job 独立的成功、timeout 和错误，一个未知 ID 不会让整批失败。

`timeoutSeconds` 本身就能承担 heartbeat：`timedOut: true` 时返回当前 snapshot/output，调用方稍后再次 `JobWait` 即可，不需要单独的 `heartbeatSeconds`。

### TaskUpdate 当前没有形成真实状态

当前实现只有 description 会直接修改进程内 `TaskInfo`；没有调用 task listener，也不会同步到 `SessionTaskRecord`。`progress` 和 `statusNote` 甚至没有写入 TaskInfo，只出现在本次工具返回文本中。

因此 `TaskUpdate` 不能原样迁移成 `JobUpdate`。建议直接移除模型工具。如果以后 worker 确实需要上报进度，再设计 producer-specific `TaskReport`：写入 TaskManager metadata、触发 listener、投影到 durable record，并产生可观察事件。

### TaskCreate local_agent 当前不是可用的创建路径

`TaskCreate(type=local_agent)` 没有传入 `command/argv`，而 `TaskManager.createAgentTask()` 在缺少这两个字段时会立即创建 failed task，并写入 `needs_argv=1`。真正可用的 child Agent 创建入口是 `Agent`。

建议硬切时把 `TaskCreate` 收窄为后台 shell producer，删除 `local_agent` 选项；Agent 工作统一由 `Agent` 创建。将来若接通独立 agent subprocess backend，再作为明确的新 producer 能力重新加入。

### standalone Agent 的 Jobs host 缺口已补齐

daemon 会注入 `DaemonJobService.createAgentHost()`。standalone SDK 在没有 `options.jobs` 时，现在会自动创建 `createNodeJobBindings`，并使用真实 runtime session ID 做 owner 校验。

本地 host 聚合范围如下：

```text
createNodeJobBindings
  -> framework child manager
  -> scoped TaskManager
  -> optional local workflow store
```

没有外部 sessionId 时，runtime 创建的 session ID 同时用于后台 producer 和 Job 调用；本地模式不会跳过 owner 校验。调用方显式提供 `options.jobs` 时，外部 host 仍然优先。

### Workflow timeline/history 不是普通 Job 控制

Workflow timeline 支持 task IDs、event types、statuses 过滤；历史 list 支持 run ID 前缀、创建/更新时间范围、reconciliation 状态和 limit。这些是 Workflow 领域查询，不应全部塞进通用 Job 协议。

建议：

```text
JobRead(workflowJobId)       -> 当前统一状态和结果
JobList(kind=workflow)       -> 当前/近期 Workflow Job
JobCancel(workflowJobId)     -> 取消
Workflow(action=timeline)    -> 领域事件时间线
Workflow(action=history)     -> 持久历史高级查询
```

名字必须体现差异，不能继续同时提供含糊的 `Workflow status/list` 和 `JobRead/JobList`。

## 目标工具面

### 后台创建工具

| 工具 | 硬切后的责任 |
|---|---|
| `BackgroundShellCreate` | 只创建后台 shell process |
| `Agent` | 创建 framework child Agent |
| `TerminalOpen` | 创建持久交互终端 |
| `Workflow` | run/resume/validate/template/reconcile/timeline/history |

### 唯一生命周期控制工具

| 工具 | 硬切后的责任 |
|---|---|
| `JobList` | 按 kind/status/时间/limit 列出 owner Jobs |
| `JobRead` | 读取当前状态、输出和 producer payload |
| `JobWait` | 等待一个或多个 Jobs，不隐式取消 |
| `JobSend` | 给支持输入的 Job 发送内容 |
| `JobCancel` | 唯一显式取消入口 |

### 从模型注册面移除

```text
TaskGet
TaskList
TaskOutput
TaskStop
TaskWait
TaskUpdate
SendMessage
Workflow action=status
Workflow action=list
Workflow action=cancel
```

Workflow 的高级列表和时间线分别改成 `history`、`timeline`，不保留旧 action 兼容。

## Jobs 需要先补的能力

### JobList 过滤

目标请求至少需要：

```ts
interface JobListRequest {
  sessionId: string;
  kinds?: JobKind[];
  statuses?: JobStatus[];
  startedAfter?: number;
  startedBefore?: number;
  updatedAfter?: number;
  updatedBefore?: number;
  includeFinished?: boolean;
  limit?: number;
}
```

过滤和 limit 必须在 service 内完成后再返回，不能让模型拉取无限历史再自行筛选。

### JobWait 批量工具输入

底层 `AgentJobHost.wait()` 保持单 Job。模型工具调整为：

```ts
{
  jobIds: string[];
  timeoutSeconds?: number;
  after?: Record<string, number>;
  maxChars?: number;
}
```

返回每个 jobId 独立的 `JobWaitResult` 或结构化错误。timeout 不触发 cancel。

### JobRead producer payload

`text + snapshot` 可以展示，但不足以完整替代 Workflow JSON status。现在通过可选 `details` 返回 producer 结构化状态，内容由 `snapshot.kind` 判别：

```ts
interface JobReadResult {
  text: string;
  cursor: number;
  truncated: boolean;
  snapshot: JobSnapshot;
  details?: Record<string, unknown>;
}
```

Workflow adapter 返回当前 plan、pending/running/blocked、results 和 budget。timeline events 不放进 details，仍走 Workflow timeline 查询。

### 全 runtime host parity

daemon 和 standalone 必须都注入 `AgentJobHost`，然后才能从默认 registry 移除 Task 控制工具。工具面不能因是否经过 daemon 而使用两套名字。

## 分阶段实施

### 第一阶段：补齐 Jobs，不移除旧工具（已完成）

1. 实现 local `AgentJobHost`，覆盖 framework child 和 scoped TaskManager。
2. standalone runtime 自动创建 runtime owner ID，并默认注册 Job 工具。
3. 给 JobList 增加 kind/status/limit 等过滤。
4. 给模型 `JobWait` 增加批量输入和逐项结果。
5. 给 Workflow JobRead 增加结构化 payload。
6. 增加 daemon 与 standalone 的同场景契约测试。

这一阶段允许短暂双工具面，只用于验证能力等价，不更新 prompt 引导模型使用旧工具。

### 第二阶段：Task/Agent 硬切（已完成）

1. `TaskCreate` 删除 `local_agent`，只保留后台 shell。
2. `Agent` 返回明确的 `jobId`，描述改为 JobWait/JobSend。
3. Coordinator prompt、role tool ceiling、agent definitions 改用 Job 工具。
4. permission readonly 集删除 TaskGet/List/Output/Wait 和已经不存在的 TerminalRead/List，加入 JobList/JobRead/JobWait。
5. core snake_case aliases 和所有 allow/disallow tool lists 改用 Job 名称。
6. 从 registry 和导出中删除 TaskGet/List/Output/Stop/Wait/Update、SendMessage。
7. 删除旧测试，新增 daemon/standalone Job 契约测试，不保留旧名兼容。

落地结果：`TaskCreate` 只创建后台 shell，`Agent` 返回结构化 `jobId`；所有模型侧 list/read/wait/send/cancel 都通过 Jobs。已完成或失败但会话仍可恢复的 Agent 允许 `JobSend` 继续，已取消的 Agent 不可恢复。

### 第三阶段：Workflow 硬切（已完成）

1. detached Workflow 返回 `jobId`，提示使用 JobRead/JobWait/JobCancel。
2. 删除 `status/list/cancel` actions。
3. 将 timeline 和高级历史查询改成明确的 `timeline/history` actions。
4. 当前状态、普通列表、取消的测试迁到 DaemonJobService 和 Job tools。
5. 验证 JobCancel 仍停止 active scheduler，JobRead payload 能表达 blocked/budget/reconciliation。

落地结果：detached `Workflow run` 返回标准 Job receipt；模型工具删除 `status/list/cancel`，新增语义明确的 `timeline/history`。普通状态、等待、列表和取消全部走 Jobs；CLI/TUI 的同名管理命令作为人工管理面继续保留。

### 第四阶段：清理与观察（部分完成）

1. 已清理当前文档、prompt、slash command catalog 中面向模型的旧工具名；迁移复盘和历史实施计划保留旧名用于说明变更。
2. 已检查 settings/plugin/agent definitions；运行时会明确拒绝被删除的 allow/deny/auto-approve 名称并提示对应 `Job*`，未知插件工具仍允许稍后动态注册。
3. 已给模型侧 `JobList` 增加最近 100 条默认窗口和窗口元数据，给单次 `JobWait` 增加 32 项输入上限。这些是返回量和并发护栏，不是历史清理策略。
4. 继续观察 JobList 总量、终态保留成本和轮询 wait 压力，再决定事件式 wait、retention/pagination、namespaced Job ID 和 completion claim。

## 验收标准

- daemon、CLI/SDK standalone 和 child Agent 都看到同一组 Job 控制工具。
- 默认 registry 不再注册 TaskGet/List/Output/Stop/Wait/Update 或 SendMessage。
- Coordinator 的 one-off delegation 使用 `Agent -> JobWait`，follow-up 使用 `JobSend`，停止使用 `JobCancel`。
- `JobWait` 可一次等待多个 Job，单个错误不影响其他结果。
- wait timeout 和 request abort 永不隐式取消 Job。
- `TaskCreate` 不再宣称可创建一个实际会立即 failed 的 local_agent。
- Workflow 普通状态、列表、取消只能通过 Jobs；timeline/history 仍可访问原有领域信息。
- JobRead 的 Workflow payload 足以判断 running/pending/blocked/results/budget/reconciliation。
- owner mismatch 在 daemon 和 standalone 都在触碰 producer 前失败。
- 全仓不存在面向模型的旧工具名和旧 Workflow actions。

## 不做的事

- 不增加兼容别名或同时长期注册两套控制工具。
- 不让 JobWait timeout 自动 JobCancel。
- 不把 Workflow template/validate/reconcile/resume 塞进 Jobs。
- 不为 TaskUpdate 增加没有真实状态语义的 JobUpdate。
- 不新增第二套 Job 数据库。


阶段 A 已接通 Jobs 协议 6 与共同执行来源；最新接口和所有权说明见 [Jobs 协议](./jobs-protocol.md)。额度和 Workflow runner 的后续收拢仍按阶段 B/C 计划执行。
