# Agent 执行观测底座实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 从现有 Session Run、Child Agent 投影和 Workflow 持久化数据生成统一、可过滤、可聚合且默认不泄漏内容的执行观测 JSON。

**架构：** 不新增观测表，也不修改调度行为。协议包定义稳定的观测契约；Server 中两个只读 Reader 分别投影 Session/Child 与 Workflow 数据，Service 负责按执行层级过滤和聚合；现有 debug HTTP 与 CLI 暴露本地查询及 JSON 输出。Workflow 文件与 SQLite Repository 先补充逐条解码诊断，避免坏记录被静默忽略或拖垮整个导出。

**技术栈：** TypeScript、Vitest、Hono、Commander、现有 SQLite SessionStore、`@vykor/coordinator` Workflow Repository。

**设计规格：** `docs/superpowers/specs/2026-09-29-agent-execution-observability-design.md`

---

## 执行约束

- 从仓库根目录 `D:\code\personal-project\OpenHarness-ts` 执行命令。
- 每个任务严格按 RED → GREEN → 受影响回归 → commit 执行；不要把多个任务压成一个提交。
- 开始每个任务前运行 `git status --short`。工作区已有修改属于用户，不得暂存、格式化或回滚计划之外的文件。
- 除最终验证外，不重复运行全仓测试；使用每个任务列出的定向命令。
- 不增加数据库表，不写远程遥测，不添加 Desktop 页面，不计算货币金额，不修改 Child/Workflow 调度行为。
- 不从自由文本错误推断失败类型；无法由结构化字段证明的分类必须保持 `unknown`。
- 默认 JSON 不得包含 prompt、模型正文、工具输入输出、原始错误、绝对路径或 provider base URL。

## 任务依赖与所有权

任务必须按 1 → 8 顺序执行。若由多个智能体接力，每个智能体只修改当前任务列出的文件，并以当前上一个任务的 commit 为基线。

| 任务 | 交付物 | 依赖 |
| --- | --- | --- |
| 1 | 公共协议与过滤解析 | 无 |
| 2 | 文件 Workflow Repository 带诊断读取 | 任务 1 |
| 3 | SQLite Workflow Repository 带诊断读取 | 任务 2 |
| 4 | Session/Child Run Reader | 任务 1 |
| 5 | Workflow Run/Task Reader | 任务 3、4 |
| 6 | 过滤、按 kind 聚合和安全导出 Service | 任务 4、5 |
| 7 | Daemon 装配、能力声明和 HTTP 查询 | 任务 6 |
| 8 | CLI、人类摘要和端到端验收 | 任务 7 |

## 文件结构

### 新建

- `packages/protocol/src/execution-observability.ts`：公共类型、枚举、过滤参数解析。
- `packages/protocol/src/execution-observability.test.ts`：协议解析、枚举和边界测试。
- `packages/server/src/application/observability/session-execution-observation-reader.ts`：Session Run、attempt、Child Session/Task 投影。
- `packages/server/src/application/observability/session-execution-observation-reader.test.ts`：Root/Child、follow-up、usage、unknown 终态测试。
- `packages/server/src/application/observability/workflow-execution-observation-reader.ts`：Workflow Run/Task 四态投影、事件时间、backing 关联。
- `packages/server/src/application/observability/workflow-execution-observation-reader.test.ts`：Task 唯一投影、时间、budget 完整性测试。
- `packages/server/src/application/observability/execution-observation-service.ts`：合并、过滤、排序、按 kind 聚合和安全 warning。
- `packages/server/src/application/observability/execution-observation-service.test.ts`：分母、去重、稳定排序和泄漏测试。
- `packages/server/src/application/observability/index.ts`：观测模块导出。
- `packages/server/src/application/workflow/__test__/session-workflow-run-repository.test.ts`：SQLite snapshot/event 解码诊断测试。

### 修改

- `packages/protocol/src/index.ts`：导出观测协议。
- `packages/coordinator/src/workflow/store.ts`：定义诊断结果并为文件 Repository 实现 snapshot/event 逐条诊断读取。
- `packages/coordinator/src/workflow/__test__/store.test.ts`：文件 snapshot/event 损坏测试。
- `packages/services/src/workflows/workflow-records.ts`：增加带序号的存储事件记录类型。
- `packages/services/src/workflows/workflow-repository.ts`：增加 `listEventRecords()`，保留原 `listEvents()` 兼容入口。
- `packages/services/src/workflows/workflow-repository.test.ts`：SQLite 原始事件记录顺序和 ID 测试。
- `packages/server/src/application/workflow/session-workflow-run-repository.ts`：实现 SQLite `listWithDiagnostics()` 与 `loadEventsWithDiagnostics()`。
- `packages/server/src/application/index.ts`：导出观测模块。
- `packages/server/src/application/control/daemon-control-service.ts`：组合观测 Service 并暴露只读查询。
- `packages/server/src/application/control/__test__/daemon-control-service.test.ts`：控制面转发测试。
- `packages/server/src/application/daemon-application.ts`：装配观测 Service。
- `packages/server/src/http/routes/system.ts`：新增 `GET /debug/executions`。
- `packages/server/src/http/__test__/http.test.ts`：鉴权、过滤和响应集成测试。
- `packages/server/src/http/routes/__test__/routes.test.ts`：路由参数与错误映射测试。
- `packages/server/src/http/routes/system.ts`：在默认 capabilities 中声明 `executionObservability: 1`。
- `apps/cli/src/commands/debug.ts`：新增 `debug executions` 子命令和人类可读摘要。
- `apps/cli/src/commands/debug.test.ts`：查询串、握手、JSON 与文本格式测试。

---

### 任务 1：定义公共观测协议和过滤解析

**文件：**

- 创建：`packages/protocol/src/execution-observability.ts`
- 创建：`packages/protocol/src/execution-observability.test.ts`
- 修改：`packages/protocol/src/index.ts`

- [ ] **步骤 1：编写协议失败测试**

在 `execution-observability.test.ts` 写出以下行为：

```ts
import { describe, expect, it } from "vitest";
import { parseExecutionObservationFilter } from "./execution-observability.js";

describe("parseExecutionObservationFilter", () => {
  it("parses bounded comma-separated filters", () => {
    expect(parseExecutionObservationFilter({
      kind: "child_agent_run,workflow_task",
      outcome: "completed,failed",
      from: "100",
      to: "200",
      sessionId: "s1",
      model: "deepseek-v4.1-flash",
    })).toEqual({
      executionKinds: ["child_agent_run", "workflow_task"],
      outcomes: ["completed", "failed"],
      from: 100,
      to: 200,
      sessionId: "s1",
      model: "deepseek-v4.1-flash",
    });
  });

  it.each([
    [{ kind: "other" }, "invalid_execution_kind"],
    [{ outcome: "success" }, "invalid_execution_outcome"],
    [{ from: "NaN" }, "invalid_observation_from"],
    [{ from: "200", to: "100" }, "invalid_observation_range"],
  ])("rejects %j", (input, code) => {
    expect(() => parseExecutionObservationFilter(input)).toThrow(code);
  });
});
```

- [ ] **步骤 2：运行测试确认 RED**

运行：

```powershell
pnpm --filter @vykor/protocol exec vitest run src/execution-observability.test.ts
```

预期：FAIL，模块或 `parseExecutionObservationFilter` 尚不存在。

- [ ] **步骤 3：实现最小公共契约**

在 `execution-observability.ts` 定义并导出：

```ts
export const EXECUTION_KINDS = [
  "root_agent_run",
  "child_agent_run",
  "workflow_run",
  "workflow_task",
] as const;

export const EXECUTION_OUTCOMES = [
  "completed", "failed", "timed_out", "cancelled", "blocked",
  "skipped", "running", "pending", "unknown",
] as const;

export const EXECUTION_FAILURE_KINDS = [
  "model_error", "tool_error", "timeout", "permission_denied",
  "budget_exceeded", "dependency_failed", "cancelled_by_user",
  "cancelled_by_parent", "recovery_failed", "conflict", "unknown",
] as const;

export type ExecutionKind = typeof EXECUTION_KINDS[number];
export type ExecutionOutcome = typeof EXECUTION_OUTCOMES[number];
export type ExecutionFailureKind = typeof EXECUTION_FAILURE_KINDS[number];
export type ExecutionUsageCompleteness = "complete" | "partial" | "unknown";

export interface ExecutionObservationWarning {
  code:
    | "invalid_workflow_snapshot"
    | "invalid_workflow_event"
    | "missing_parent_execution"
    | "missing_backing_execution"
    | "partial_usage";
  sourceId: string;
}

export interface ExecutionObservation {
  schemaVersion: 1;
  executionKind: ExecutionKind;
  executionId: string;
  parentExecutionId?: string;
  backingExecutionIds?: string[];
  traceId?: string;
  sessionId?: string;
  runId?: string;
  childId?: string;
  childSessionId?: string;
  workflowRunId?: string;
  workflowTaskId?: string;
  model?: string;
  provider?: string;
  workflowMode?: "sequential" | "parallel" | "pipeline";
  configuredConcurrency?: number;
  attemptCount?: number;
  createdAt?: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  outcome: ExecutionOutcome;
  failureKind?: ExecutionFailureKind;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    completeness: ExecutionUsageCompleteness;
  };
  source: { kind: "session_run" | "workflow_snapshot"; id: string };
  completeness: "complete" | "partial";
}

export interface ExecutionObservationFilter {
  from?: number;
  to?: number;
  executionKinds?: ExecutionKind[];
  outcomes?: ExecutionOutcome[];
  failureKinds?: ExecutionFailureKind[];
  sessionId?: string;
  runId?: string;
  childId?: string;
  workflowRunId?: string;
  workflowTaskId?: string;
  model?: string;
  provider?: string;
}

export interface ExecutionKindSummary {
  total: number;
  technicalTerminal: number;
  completed: number;
  failed: number;
  timedOut: number;
  cancelled: number;
  blocked: number;
  skipped: number;
  unknown: number;
  completionRate?: number;
  failureRate?: number;
  duration: { count: number; sumMs: number; minMs?: number; maxMs?: number };
  usage: {
    inputTokens: number;
    outputTokens: number;
    completeRecords: number;
    partialRecords: number;
    unknownRecords: number;
  };
  failures: Partial<Record<ExecutionFailureKind, number>>;
}

export interface ExecutionObservationExport {
  schemaVersion: 1;
  generatedAt: number;
  filters: ExecutionObservationFilter;
  summary: Partial<Record<ExecutionKind, ExecutionKindSummary>>;
  records: ExecutionObservation[];
  warnings: ExecutionObservationWarning[];
}
```

实现 `parseExecutionObservationFilter(input: Record<string, unknown>)`：逗号分隔字段去空白、去重且最多 16 项；ID/model/provider 必须是 1–256 个非控制字符；时间必须是非负安全整数，且 `from <= to`。错误消息使用测试中的稳定错误码。

在 `packages/protocol/src/index.ts` 增加：

```ts
export * from "./execution-observability.js";
```

- [ ] **步骤 4：运行协议测试和类型检查**

```powershell
pnpm --filter @vykor/protocol exec vitest run src/execution-observability.test.ts src/capabilities.test.ts
pnpm --filter @vykor/protocol run check-types
```

预期：全部 PASS，退出码 0。

- [ ] **步骤 5：提交任务 1**

```powershell
git add packages/protocol/src/execution-observability.ts packages/protocol/src/execution-observability.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): define execution observation contract"
```

---

### 任务 2：让文件 Workflow Repository 返回安全诊断

**文件：**

- 修改：`packages/coordinator/src/workflow/store.ts`
- 修改：`packages/coordinator/src/workflow/__test__/store.test.ts`

- [ ] **步骤 1：为损坏 snapshot 和 event 写失败测试**

在现有 `FileWorkflowRunRepository` describe 中增加：

```ts
it("returns usable workflow data with safe diagnostics for corrupt files", () => {
  const dir = tempDir();
  const store = new FileWorkflowRunRepository({ dir });
  const valid = createWorkflowRunSnapshot({
    runId: "valid",
    status: "completed",
    summary: "done",
    spec: { mode: "sequential", tasks: [] },
    plan: createWorkflowPlan({ mode: "sequential", tasks: [] }),
    results: new Map(),
    running: new Set(),
    createdAt: 10,
  });
  store.save(valid);
  writeFileSync(join(dir, "broken.json"), "{broken", "utf8");
  appendFileSync(store.eventPathFor("valid"), "{broken\n", "utf8");

  expect(store.listWithDiagnostics()).toEqual({
    snapshots: [expect.objectContaining({ runId: "valid" })],
    diagnostics: [{ code: "invalid_workflow_snapshot", sourceId: "broken" }],
  });
  expect(store.loadEventsWithDiagnostics("valid")).toEqual({
    events: [],
    diagnostics: [{ code: "invalid_workflow_event", sourceId: "valid:event:1" }],
  });
});
```

同步给测试导入 `appendFileSync`、`writeFileSync`。不得断言或返回绝对路径、异常 message 或损坏正文。

- [ ] **步骤 2：运行测试确认 RED**

```powershell
pnpm --filter @vykor/coordinator exec vitest run src/workflow/__test__/store.test.ts
```

预期：FAIL，两个带诊断方法尚不存在。

- [ ] **步骤 3：扩展 Workflow Repository 契约并保留兼容方法**

在 `store.ts` 增加：

```ts
export interface WorkflowReadDiagnostic {
  code: "invalid_workflow_snapshot" | "invalid_workflow_event";
  sourceId: string;
}

export interface WorkflowSnapshotReadResult {
  snapshots: WorkflowRunSnapshot[];
  diagnostics: WorkflowReadDiagnostic[];
}

export interface WorkflowEventReadResult {
  events: WorkflowRunEvent[];
  diagnostics: WorkflowReadDiagnostic[];
}
```

将 `WorkflowRunRepository` 扩展为：

```ts
listWithDiagnostics(): WorkflowSnapshotReadResult;
loadEventsWithDiagnostics(runId: string): WorkflowEventReadResult;
```

文件实现逐文件、逐非空事件行 decode：有效数据进入数组，失败只追加 `{ code, sourceId }`。旧方法必须委托新方法，保持调用方行为：

```ts
list(): WorkflowRunSnapshot[] {
  return this.listWithDiagnostics().snapshots;
}

loadEvents(runId: string): WorkflowRunEvent[] {
  return this.loadEventsWithDiagnostics(runId).events;
}
```

snapshot `sourceId` 使用去掉 `.json` 的文件名；event `sourceId` 使用 `${runId}:event:${lineNumber}`。不得返回目录。

- [ ] **步骤 4：运行 Repository 测试和类型检查**

```powershell
pnpm --filter @vykor/coordinator exec vitest run src/workflow/__test__/store.test.ts
pnpm --filter @vykor/coordinator run check-types
```

预期：PASS。其它 `WorkflowRunRepository` 实现会因新接口尚未补齐而可能在全仓类型检查中失败；任务 3 负责补齐 SQLite 实现，本任务只要求 coordinator 包自身通过。

- [ ] **步骤 5：提交任务 2**

```powershell
git add packages/coordinator/src/workflow/store.ts packages/coordinator/src/workflow/__test__/store.test.ts
git commit -m "feat(workflow): report corrupt persisted records"
```

---

### 任务 3：让 SQLite Workflow Repository 返回同样的诊断

**文件：**

- 修改：`packages/services/src/workflows/workflow-records.ts`
- 修改：`packages/services/src/workflows/workflow-repository.ts`
- 修改：`packages/services/src/workflows/workflow-repository.test.ts`
- 修改：`packages/server/src/application/workflow/session-workflow-run-repository.ts`
- 创建：`packages/server/src/application/workflow/__test__/session-workflow-run-repository.test.ts`

- [ ] **步骤 1：先测试 SQLite 原始事件记录包含稳定序号**

在 services 测试创建两个事件后断言：

```ts
expect(repository.listEventRecords("wf-1")).toEqual([
  { id: "1", eventJson: "{\"type\":\"workflow_started\"}" },
  { id: "2", eventJson: "{broken" },
]);
```

测试不要依赖全局自增从 1 开始；从返回结果取第一个 ID，并断言第二个 ID 不同且顺序与插入一致。

- [ ] **步骤 2：运行 services 测试确认 RED**

```powershell
pnpm --filter @vykor/services exec vitest run src/workflows/workflow-repository.test.ts
```

预期：FAIL，`listEventRecords` 不存在。

- [ ] **步骤 3：实现不破坏旧调用方的原始事件读取**

在 `workflow-records.ts` 增加：

```ts
export interface StoredWorkflowEventRecord {
  id: string;
  eventJson: string;
}
```

在 services `WorkflowRepository` 增加：

```ts
listEventRecords(runId: string): StoredWorkflowEventRecord[] {
  return rows.map((row) => ({ id: String(row.seq), eventJson: row.event_json }));
}

listEvents(runId: string): string[] {
  return this.listEventRecords(runId).map((row) => row.eventJson);
}
```

- [ ] **步骤 4：编写 Server SQLite 适配器失败测试**

新测试用真实临时 `SessionStore` 和 `SessionWorkflowRunRepository`：保存一个合法 snapshot、一条合法 event，再直接通过 `store.workflows.saveRun/appendEvent` 写入一条损坏 snapshot 和 event。断言：

```ts
expect(repository.listWithDiagnostics()).toMatchObject({
  snapshots: [expect.objectContaining({ runId: "valid" })],
  diagnostics: [{ code: "invalid_workflow_snapshot", sourceId: "broken" }],
});
expect(repository.loadEventsWithDiagnostics("valid")).toMatchObject({
  events: [expect.objectContaining({ type: "workflow_started" })],
  diagnostics: [{ code: "invalid_workflow_event" }],
});
```

`sourceId` 只能是 runId 或 `${runId}:event:${seq}`，不能包含数据库路径或异常文本。

- [ ] **步骤 5：运行 Server 测试确认 RED**

```powershell
pnpm --filter @vykor/server exec vitest run src/application/workflow/__test__/session-workflow-run-repository.test.ts
```

预期：FAIL，SQLite 适配器未实现新接口。

- [ ] **步骤 6：实现 SQLite 逐条解码**

扩展 `WorkflowStorage`：

```ts
listEventRecords(runId: string): Array<{ id: string; eventJson: string }>;
```

`listWithDiagnostics()` 遍历 `listRuns()` 并分别 decode；`loadEventsWithDiagnostics()` 遍历 `listEventRecords()` 并分别 decode。旧 `list()` 与 `loadEvents()` 委托诊断方法的有效数组。底层查询抛错必须继续向外抛出，不能转换为空结果。

- [ ] **步骤 7：运行两包相关测试和类型检查**

```powershell
pnpm --filter @vykor/services exec vitest run src/workflows/workflow-repository.test.ts
pnpm --filter @vykor/server exec vitest run src/application/workflow/__test__/session-workflow-run-repository.test.ts
pnpm --filter @vykor/services run check-types
pnpm --filter @vykor/server run check-types
```

预期：全部 PASS。

- [ ] **步骤 8：提交任务 3**

```powershell
git add packages/services/src/workflows/workflow-records.ts packages/services/src/workflows/workflow-repository.ts packages/services/src/workflows/workflow-repository.test.ts packages/server/src/application/workflow/session-workflow-run-repository.ts packages/server/src/application/workflow/__test__/session-workflow-run-repository.test.ts
git commit -m "feat(server): diagnose sqlite workflow records"
```

---

### 任务 4：投影 Root 与 Child Agent Run

**文件：**

- 创建：`packages/server/src/application/observability/session-execution-observation-reader.ts`
- 创建：`packages/server/src/application/observability/session-execution-observation-reader.test.ts`
- 创建：`packages/server/src/application/observability/index.ts`
- 修改：`packages/server/src/application/index.ts`

- [ ] **步骤 1：写真实 SessionStore fixture 的失败测试**

测试建立：一个 root Session/Run、一个带 `parentId` 和 `metadata.childId` 的 child Session、该 child 下两个 follow-up Run、对应父 Session Task。为 Run 创建多个 attempt，并给 root Run 设置：

```ts
metadata: {
  traceId: "trace-1",
  usage: {
    inputTokens: 30,
    outputTokens: 7,
    cacheReadTokens: 5,
    cacheCreationTokens: 2,
  },
  modelUsage: { incomplete: false, unknownAttempts: 0, partialAttempts: 0 },
}
```

关键断言：

```ts
expect(result.records).toEqual(expect.arrayContaining([
  expect.objectContaining({
    executionKind: "root_agent_run",
    executionId: "agent-run:root-run",
    model: "final-model",
    provider: "provider-b",
    usage: expect.objectContaining({ inputTokens: 30, completeness: "complete" }),
  }),
  expect.objectContaining({
    executionKind: "child_agent_run",
    executionId: "agent-run:child-run-2",
    parentExecutionId: "agent-run:root-run",
    childId: "child-1",
  }),
]));
expect(result.backingExecutionsByTaskId.get("child-1")).toEqual([
  "agent-run:child-run-1",
  "agent-run:child-run-2",
]);
```

另加三种边界：

- `interrupted` Run → `outcome: "unknown"`；
- `modelUsage.incomplete=true` → usage `partial`；
- 缺少 parentRunId → `completeness: "partial"` 和 `missing_parent_execution` warning，不从错误文本猜测。

- [ ] **步骤 2：运行测试确认 RED**

```powershell
pnpm --filter @vykor/server exec vitest run src/application/observability/session-execution-observation-reader.test.ts
```

预期：FAIL，Reader 不存在。

- [ ] **步骤 3：实现只读 Session Reader**

定义最小来源接口，禁止 Reader 依赖整个 `SessionStore`：

```ts
export interface SessionObservationSource {
  listSessions(): SessionRecord[];
  listRuns(sessionId: string): SessionRunRecord[];
  listRunAttempts(runId: string): SessionRunAttemptRecord[];
  listSessionTasks(sessionId: string): SessionExecutionRecord[];
}

export interface SessionObservationReadResult {
  records: ExecutionObservation[];
  warnings: ExecutionObservationWarning[];
  backingExecutionsByTaskId: Map<string, string[]>;
}
```

映射规则必须写成显式纯函数：

- Session 有 `parentId` 且 `metadata.childId` 是字符串 → `child_agent_run`，否则 root。
- Child `parentExecutionId` 只读取 Run `metadata.parentRunId`；没有则留空并 warning。
- model/provider 取 `listRunAttempts()` 中 sequence 最大且已结束的 attempt。
- usage 数值从 Run `metadata.usage` 安全读取；`readSessionModelUsage(metadata)?.incomplete` 或未知/部分 attempt 大于 0 时为 `partial`；完全没有 usage 为 `unknown`。
- `completed → completed`、`failed → failed`、`pending/running` 保持原态、`interrupted → unknown`。
- `durationMs` 仅在起止时间同时存在时计算。
- `createdAt` 取 Session Run 的持久创建时间，供缺少 startedAt 时稳定排序和过滤。
- warning 只带固定 code 和 ID。

在 `index.ts` 和 application 根 index 导出 Reader。

- [ ] **步骤 4：运行测试和 Server 类型检查**

```powershell
pnpm --filter @vykor/server exec vitest run src/application/observability/session-execution-observation-reader.test.ts
pnpm --filter @vykor/server run check-types
```

预期：PASS。

- [ ] **步骤 5：提交任务 4**

```powershell
git add packages/server/src/application/observability/session-execution-observation-reader.ts packages/server/src/application/observability/session-execution-observation-reader.test.ts packages/server/src/application/observability/index.ts packages/server/src/application/index.ts
git commit -m "feat(server): project agent run observations"
```

---

### 任务 5：投影 Workflow Run 与全部 Task 状态

**文件：**

- 创建：`packages/server/src/application/observability/workflow-execution-observation-reader.ts`
- 创建：`packages/server/src/application/observability/workflow-execution-observation-reader.test.ts`
- 修改：`packages/server/src/application/observability/index.ts`

- [ ] **步骤 1：写四态 Task 和事件时间失败测试**

构造一个 snapshot，其 `plan.tasks` 包含 `done/running/blocked/pending`，四者分别落在 `results/runningTasks/blockedTasks/pendingTaskIds`。提供 `workflow_started` 和 `workflow_finished` 事件，以及 `backingExecutionsByTaskId`。

```ts
expect(result.records.filter((row) => row.executionKind === "workflow_task"))
  .toEqual([
    expect.objectContaining({ workflowTaskId: "done", outcome: "completed" }),
    expect.objectContaining({ workflowTaskId: "running", outcome: "running" }),
    expect.objectContaining({ workflowTaskId: "blocked", outcome: "blocked" }),
    expect.objectContaining({ workflowTaskId: "pending", outcome: "pending" }),
  ]);

expect(result.records.find((row) => row.executionKind === "workflow_run"))
  .toMatchObject({
    executionId: "workflow:wf-1",
    parentExecutionId: "agent-run:root-run",
    startedAt: 100,
    finishedAt: 200,
    durationMs: 100,
  });
```

另外覆盖：

- result metadata `workerTaskId: "child-task"` → `backingExecutionIds`；
- `attempts > 1` 且没有 `budgetCumulativeAcrossAttempts: true` → usage `partial`；
- snapshot 有 invalid event diagnostic → Workflow Run duration 留空、completeness `partial`；
- 同一 task 同时意外出现在两个容器时，按 `result > running > blocked > pending` 只产生一条；
- snapshot `maxConcurrency: "unbounded"` 时不伪造数值，`configuredConcurrency` 留空并将原值不导出。

- [ ] **步骤 2：运行测试确认 RED**

```powershell
pnpm --filter @vykor/server exec vitest run src/application/observability/workflow-execution-observation-reader.test.ts
```

预期：FAIL，Workflow Reader 不存在。

- [ ] **步骤 3：实现 Workflow Reader**

Reader 接收：

```ts
export interface WorkflowObservationSource {
  listWithDiagnostics(): WorkflowSnapshotReadResult;
  loadEventsWithDiagnostics(runId: string): WorkflowEventReadResult;
}

export interface WorkflowObservationReadResult {
  records: ExecutionObservation[];
  warnings: ExecutionObservationWarning[];
}

export function readWorkflowExecutionObservations(
  source: WorkflowObservationSource,
  backingExecutionsByTaskId: ReadonlyMap<string, string[]>,
): WorkflowObservationReadResult;
```

规则：

- 每个 snapshot 一条 `workflow_run`；每个 `plan.tasks` 元素恰好一条 `workflow_task`。
- Workflow Run `parentExecutionId` 仅由 `ownerRun` 生成。
- Workflow Run 和 Workflow Task 的 `createdAt` 都使用 snapshot `createdAt`，表示这些逻辑执行单元最迟在 Workflow 创建时已经存在；Task 的实际执行时间仍只写入 `startedAt/finishedAt`。
- Run 起止时间只取同 runId 的 `workflow_started` 与 terminal event；缺 event 不用 `updatedAt` 代替。
- `termination === "cancelled"` → cancelled；普通 completed/failed 分别映射；运行中保持 running。
- Task `timedOut === true` → timed_out；completed/failed/killed/skipped 分别映射 completed/failed/cancelled/skipped。
- Task budget 只有 `metadata.budgetCumulativeAcrossAttempts === true` 才可 complete；否则有数字为 partial，无数字为 unknown。
- Workflow Run usage 汇总 Task 已知值，并继承最差完整性。
- diagnostics 转成协议 warning；event diagnostic 同时把所属 Run completeness 降为 partial。

- [ ] **步骤 4：运行 Workflow Reader、Repository 和类型检查**

```powershell
pnpm --filter @vykor/server exec vitest run src/application/observability/workflow-execution-observation-reader.test.ts src/application/workflow/__test__/session-workflow-run-repository.test.ts
pnpm --filter @vykor/server run check-types
```

预期：PASS。

- [ ] **步骤 5：提交任务 5**

```powershell
git add packages/server/src/application/observability/workflow-execution-observation-reader.ts packages/server/src/application/observability/workflow-execution-observation-reader.test.ts packages/server/src/application/observability/index.ts
git commit -m "feat(server): project workflow observations"
```

---

### 任务 6：实现过滤、按 kind 聚合和安全 JSON 导出

**文件：**

- 创建：`packages/server/src/application/observability/execution-observation-service.ts`
- 创建：`packages/server/src/application/observability/execution-observation-service.test.ts`
- 修改：`packages/server/src/application/observability/index.ts`

- [ ] **步骤 1：写聚合分母和防双算失败测试**

使用固定 clock 和手写 records：一个 completed Child、一个 failed Child、同一工作的 completed Workflow Task（通过 backingExecutionIds 关联）、一个 skipped Task、一个 cancelled Task。

```ts
const report = service.query({});
expect(report.generatedAt).toBe(1_000);
expect(report.summary.child_agent_run).toMatchObject({
  total: 2,
  technicalTerminal: 2,
  completed: 1,
  failed: 1,
  completionRate: 0.5,
  failureRate: 0.5,
});
expect(report.summary.workflow_task).toMatchObject({
  total: 3,
  skipped: 1,
  cancelled: 1,
});
expect(report.summary).not.toHaveProperty("all");
```

再测试：

- `from/to` 和排序使用 `startedAt ?? createdAt`，两者都缺失的记录排在最后；不得拿 `updatedAt` 冒充时间边界；
- kind/outcome/ID/model/provider 组合过滤；
- 排序 `startedAt` 升序、缺失时间最后、同时间按 `executionId`；
- duration 只统计存在数字的记录；
- usage 对已知数字求和，同时分别计 complete/partial/unknown；
- warning 去重采用 `code + sourceId`；
- JSON 序列化结果不包含测试 fixture 中的 prompt、output、raw error、绝对路径和 base URL。

- [ ] **步骤 2：运行测试确认 RED**

```powershell
pnpm --filter @vykor/server exec vitest run src/application/observability/execution-observation-service.test.ts
```

预期：FAIL，Service 不存在。

- [ ] **步骤 3：实现 Service**

构造函数只接收两个 Reader 和 clock：

```ts
export class ExecutionObservationService {
  constructor(private readonly input: {
    readSessions(): SessionObservationReadResult;
    readWorkflows(backing: ReadonlyMap<string, string[]>): WorkflowObservationReadResult;
    now?: () => number;
  }) {}

  query(filter: ExecutionObservationFilter): ExecutionObservationExport;
}
```

`query()` 顺序固定：读 Session → 把 backing map 交给 Workflow → 合并 warnings → 过滤 → 稳定排序 → 按 `executionKind` 聚合。不得生成跨 kind totals。百分比没有分母时省略字段，不输出 `NaN`。

`technicalTerminal = completed + failed + timed_out`；`completionRate = completed / technicalTerminal`；`failureRate = (failed + timed_out) / technicalTerminal`。cancelled、blocked、skipped、unknown 和尚未结束的记录不进入这两个比率的分母。

- [ ] **步骤 4：运行三个观测测试和类型检查**

```powershell
pnpm --filter @vykor/server exec vitest run src/application/observability/session-execution-observation-reader.test.ts src/application/observability/workflow-execution-observation-reader.test.ts src/application/observability/execution-observation-service.test.ts
pnpm --filter @vykor/server run check-types
```

预期：PASS。

- [ ] **步骤 5：提交任务 6**

```powershell
git add packages/server/src/application/observability/execution-observation-service.ts packages/server/src/application/observability/execution-observation-service.test.ts packages/server/src/application/observability/index.ts
git commit -m "feat(server): aggregate execution observations"
```

---

### 任务 7：装配 Daemon 并暴露只读 HTTP 查询

**文件：**

- 修改：`packages/server/src/application/control/daemon-control-service.ts`
- 修改：`packages/server/src/application/control/__test__/daemon-control-service.test.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`packages/server/src/http/routes/system.ts`
- 修改：`packages/server/src/http/routes/__test__/routes.test.ts`
- 修改：`packages/server/src/http/__test__/http.test.ts`

- [ ] **步骤 1：写 System route 失败测试**

在 route 单测给 control 增加 `queryExecutionObservations` mock：

```ts
const queryExecutionObservations = vi.fn(() => ({
  schemaVersion: 1,
  generatedAt: 123,
  filters: { executionKinds: ["child_agent_run"] },
  summary: {},
  records: [],
  warnings: [],
}));

const response = await app.request(
  "/debug/executions?kind=child_agent_run&outcome=completed,failed&from=100&to=200",
);
expect(response.status).toBe(200);
expect(queryExecutionObservations).toHaveBeenCalledWith({
  executionKinds: ["child_agent_run"],
  outcomes: ["completed", "failed"],
  from: 100,
  to: 200,
});
```

非法 kind 断言 400 和 `invalid_execution_kind`；Service 抛存储错误断言 500，不能返回空 report。另在 capabilities 路由断言中确认 `features.executionObservability === 1`。

- [ ] **步骤 2：运行 route 测试确认 RED**

```powershell
pnpm --filter @vykor/server exec vitest run src/http/routes/__test__/routes.test.ts
```

预期：FAIL，路由和 control 方法不存在。

- [ ] **步骤 3：装配 Service 到控制面**

在 `DaemonApplication` 创建 `ExecutionObservationService`：

```ts
const executionObservations = new ExecutionObservationService({
  readSessions: () => readSessionExecutionObservations({
    listSessions: () => store.sessions.list({ includeArchived: true }),
    listRuns: (sessionId) => store.runs.listRuns(sessionId),
    listRunAttempts: (runId) => store.runs.listRunAttempts(runId),
    listSessionTasks: (sessionId) => store.runs.listSessionTasks(sessionId),
  }),
  readWorkflows: (backing) => readWorkflowExecutionObservations(this.workflows, backing),
});
```

把它作为最小 `{ query }` 依赖传给 `DaemonControlService`，新增：

```ts
queryExecutionObservations(filter: ExecutionObservationFilter) {
  return this.context.executionObservations.query(filter);
}
```

- [ ] **步骤 4：实现 HTTP 路由和 capability**

在 `SystemRoutesContext.control` 加入方法，并在 `createSystemRoutes`：

```ts
.get("/debug/executions", (c) => {
  try {
    const query = Object.fromEntries(new URL(c.req.url).searchParams.entries());
    return jsonResponse(
      context.control.queryExecutionObservations(parseExecutionObservationFilter(query)),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(message.startsWith("invalid_") ? 400 : 500, message);
  }
})
```

默认 capabilities `features` 增加：

```ts
executionObservability: 1,
```

这是 additive feature，不修改 `CURRENT_PROTOCOL_VERSION`。

- [ ] **步骤 5：补 HTTP 鉴权集成测试**

在 `http.test.ts` 复用现有 daemon harness：未带 token 请求 `/debug/executions` 返回 401；带 token 返回 `schemaVersion: 1` 且默认 report 不出现会话 prompt/输出正文。不要在此测试复制所有 Reader 情景。

- [ ] **步骤 6：运行路由、控制面、HTTP 和类型检查**

```powershell
pnpm --filter @vykor/server exec vitest run src/application/control/__test__/daemon-control-service.test.ts src/http/routes/__test__/routes.test.ts src/http/__test__/http.test.ts
pnpm --filter @vykor/server run check-types
```

预期：PASS。

- [ ] **步骤 7：提交任务 7**

```powershell
git add packages/server/src/application/control/daemon-control-service.ts packages/server/src/application/control/__test__/daemon-control-service.test.ts packages/server/src/application/daemon-application.ts packages/server/src/http/routes/system.ts packages/server/src/http/routes/__test__/routes.test.ts packages/server/src/http/__test__/http.test.ts
git commit -m "feat(server): expose execution observation query"
```

---

### 任务 8：增加 CLI 查询、JSON 导出和端到端验收

**文件：**

- 修改：`apps/cli/src/commands/debug.ts`
- 修改：`apps/cli/src/commands/debug.test.ts`
- 修改：`packages/server/src/http/__test__/http.test.ts`

- [ ] **步骤 1：写 CLI 参数和输出失败测试**

将 `requestDebug` 的 options 扩展为额外 query，并测试请求 URL：

```ts
await requestDebug("/debug/executions", options, {
  kind: "child_agent_run,workflow_task",
  outcome: "failed,timed_out",
  sessionId: "s1",
  from: "100",
  to: "200",
});

expect(requestUrl.searchParams.get("kind")).toBe("child_agent_run,workflow_task");
expect(requestUrl.searchParams.get("sessionId")).toBe("s1");
```

JSON 模式断言输出等于 `JSON.stringify(report, null, 2)`；文本模式断言：

```text
Execution observations: 4 records, 1 warning
child_agent_run: completed=1 failed=1 timed_out=0 cancelled=0 skipped=0
workflow_task: completed=1 failed=0 timed_out=1 cancelled=0 skipped=0
```

文本输出不得打印 record 中的任意正文；warnings 只显示 `[code] sourceId`。

- [ ] **步骤 2：运行 CLI 测试确认 RED**

```powershell
pnpm --filter @rzx/ohs exec vitest run src/commands/debug.test.ts
```

预期：FAIL，`debug executions` 尚不存在。

- [ ] **步骤 3：实现 `vykor debug executions`**

在 `createDebugCommand()` 增加：

```ts
command
  .command("executions")
  .description("Query normalized agent and workflow execution observations")
  .option("--kind <kinds>", "Comma-separated execution kinds")
  .option("--outcome <outcomes>", "Comma-separated outcomes")
  .option("--failure-kind <kinds>", "Comma-separated failure kinds")
  .option("--session <id>", "Filter by session id")
  .option("--run <id>", "Filter by agent run id")
  .option("--child <id>", "Filter by child id")
  .option("--workflow <id>", "Filter by workflow run id")
  .option("--task <id>", "Filter by workflow task id")
  .option("--model <model>", "Filter by final attempt model")
  .option("--provider <provider>", "Filter by final attempt provider")
  .option("--from <timestamp>", "Inclusive epoch-millisecond lower bound")
  .option("--to <timestamp>", "Inclusive epoch-millisecond upper bound")
  .option("--json", "Print the complete versioned JSON report")
  .option("--daemon-url <url>", "Use an explicit daemon URL")
  .option("--daemon-token <token>", "Bearer token for --daemon-url");
```

不要给该命令 `--include-content`。将 CLI 名称映射到 HTTP query：`session → sessionId`、`run → runId`、`failureKind → failureKind`。复用现有 daemon handshake。

- [ ] **步骤 4：增加真实 daemon 端到端 fixture**

在 Server HTTP 集成测试创建：

- 一个 completed root Run，带两次 attempt 和完整 usage；
- 一个 child Session/Task/Run；
- 一个含 completed、blocked、skipped Task 的 Workflow snapshot 与开始/结束事件；
- 一条损坏 Workflow event。

请求 `/debug/executions` 后断言：

```ts
expect(report.records).toEqual(expect.arrayContaining([
  expect.objectContaining({ executionKind: "root_agent_run" }),
  expect.objectContaining({ executionKind: "child_agent_run" }),
  expect.objectContaining({ executionKind: "workflow_run" }),
  expect.objectContaining({ executionKind: "workflow_task", outcome: "blocked" }),
]));
expect(report.summary).not.toHaveProperty("all");
expect(report.warnings).toContainEqual(expect.objectContaining({
  code: "invalid_workflow_event",
}));
expect(JSON.stringify(report)).not.toMatch(/prompt secret|tool secret|[A-Z]:\\/);
```

- [ ] **步骤 5：运行 CLI、HTTP、所有观测测试**

```powershell
pnpm --filter @rzx/ohs exec vitest run src/commands/debug.test.ts
pnpm --filter @vykor/coordinator exec vitest run src/workflow/__test__/store.test.ts
pnpm --filter @vykor/services exec vitest run src/workflows/workflow-repository.test.ts
pnpm --filter @vykor/server exec vitest run src/application/workflow/__test__/session-workflow-run-repository.test.ts src/application/observability src/application/control/__test__/daemon-control-service.test.ts src/http/routes/__test__/routes.test.ts src/http/__test__/http.test.ts
```

预期：全部 PASS。

- [ ] **步骤 6：运行最终类型检查和差异审计**

```powershell
pnpm check-types
git diff --check
git status --short
```

预期：33 个 package 的类型任务全部成功；`git diff --check` 无错误；状态只包含本任务计划内文件或执行前已确认的用户 WIP。

- [ ] **步骤 7：提交任务 8**

```powershell
git add apps/cli/src/commands/debug.ts apps/cli/src/commands/debug.test.ts packages/server/src/http/__test__/http.test.ts
git commit -m "feat(cli): export execution observations"
```

---

## 最终验收清单

- [ ] `vykor debug executions --json` 输出 `schemaVersion: 1`，可被 `JSON.parse`。
- [ ] `--kind`、`--outcome`、时间、Session/Run/Child/Workflow/Task、model/provider 过滤均有测试。
- [ ] Root、Child follow-up、Workflow Run 和四种 Workflow Task 当前态均只产生预期记录。
- [ ] Workflow Task 与 backing Child Run 可以关联，summary 不跨 kind 相加。
- [ ] `interrupted` 没有结构化原因时为 `unknown`。
- [ ] Workflow retry budget 无累计证明时为 `partial`。
- [ ] snapshot/event 单条损坏产生安全 warning，其余数据仍导出；底层读取失败返回 500。
- [ ] Workflow Run 没有完整 durable 时间事件时不计算 duration。
- [ ] 默认 JSON 不含 prompt、模型正文、工具内容、原始错误、绝对路径、环境变量和 provider base URL。
- [ ] 没有新增数据库表、Desktop 页面、远程遥测或自动调度逻辑。
- [ ] 受影响测试与 `pnpm check-types` 全部通过。

## 执行后的下一阶段

本计划完成后只积累和导出可信观测数据。不要在同一实现中顺手加入自动评审触发策略。下一阶段应基于实际导出样本单独设计风险分级评审开关，再用相同任务、相同模型和相同预算做评审开/关及并发配置对照。
