# Agent 执行观测底座设计

> 状态：已确认设计，待实现。

## 目标

为主 Agent、子 Agent、Workflow 和 Workflow Task 提供同一套只读观测模型，使后续自动评审策略和复杂任务对照评估可以使用一致的统计口径。

首版只提供本地查询和 JSON 导出，不增加 Desktop 指标页面，不改变现有调度策略，也不让观测结果自动调整并发、模型或预算。

## 背景与现状

仓库已经保存了大部分原始数据，但分散在不同结构中：

- Session Run 保存运行状态、起止时间、模型尝试和 token 用量。
- Child Agent 事件保存 `childId`、父 Session、父 Run、子 Session 和生命周期状态；投影器同时创建持久 Session Task。
- Workflow snapshot 保存 Workflow 状态、执行模式、并发设置、任务结果、起止时间和已知预算用量。
- Durable Session Event 已包含 Child 与 Workflow 生命周期事件。
- Server 的结构化日志已有 `traceId`、`sessionId`、`runId`、`taskId`、时长和错误字段，但它面向运行日志，不是稳定的统计查询契约。

当前缺口不是没有数据，而是缺少以下统一语义：

1. 同一个执行在不同系统中的身份和父子关系。
2. 成功、失败、超时、取消、跳过和阻塞的统一口径。
3. token 不完整或无法计算金额时的诚实表达。
4. 可用于自动评审 A/B 实验的稳定 JSON 格式。

## 设计原则

1. **只读投影**：从现有 Session Store 和 Workflow Repository 读取并归一化，不新增观测数据库或双写链路。
2. **不伪造精度**：原始数据缺失时返回 `unknown` 或标记不完整，不用零值冒充真实值。
3. **运行粒度统一**：Agent 以每个 Run 为一条记录；Workflow Run 和 Workflow Task 各自一条记录。
4. **身份可追踪**：每条记录都能定位原始 Session、Run、Child 或 Workflow Task，并通过父执行 ID 形成树。
5. **统计与原始记录分离**：执行记录只表达事实；成功率、耗时分位数等聚合结果在查询时计算。
6. **默认不导出内容**：不导出 prompt、模型正文、工具完整输入输出或原始错误文本。
7. **保持轻量**：首版不做 UI、远程遥测、指标推送、价格表和调度自动优化。

## 方案选择

### 采用：查询时统一投影

新增一个只读观测服务，从现有持久化源读取记录，转换为统一的 `ExecutionObservation`，再提供过滤、聚合和 JSON 导出。

优点：

- 无数据库迁移，无运行时双写一致性问题。
- 不改变 Child Agent 和 Workflow 的可靠性边界。
- 已有历史数据可以尽可能参与统计。
- 如果字段设计需要调整，只改投影和导出版本，不迁移运行记录。

代价：

- 不同来源可用字段不完全一致。
- 查询时需要做关联和归一化。
- 旧数据无法补齐当时没有记录的并发峰值或失败分类。

首版接受这些限制，并显式返回完整性标记。

### 不采用：统一观测表

让 Agent 和 Workflow 在运行时额外写入一张统一表，会引入数据库迁移、双写事务和恢复对账。本阶段尚未证明查询压力或历史规模需要这套成本。

### 不采用：独立事件流与异步投影

独立事件流适合多实例和集中监控，但当前目标是本地评估。引入消费者、水位、重放和投影版本管理属于过度设计。

## 统一记录模型

```ts
type ExecutionKind =
  | "root_agent_run"
  | "child_agent_run"
  | "workflow_run"
  | "workflow_task";

type ExecutionOutcome =
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "blocked"
  | "skipped"
  | "running"
  | "pending"
  | "unknown";

interface ExecutionObservation {
  schemaVersion: 1;
  executionKind: ExecutionKind;
  executionId: string;
  parentExecutionId?: string;
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
    completeness: "complete" | "partial" | "unknown";
  };

  review?: {
    mode: "none" | "automatic" | "manual";
    verdict?: "pass" | "fail" | "partial";
    findingCount?: number;
    overridden?: boolean;
  };

  source: {
    kind: "session_run" | "workflow_snapshot";
    id: string;
  };
  completeness: "complete" | "partial";
}
```

`review` 在本阶段通常为 `{ mode: "none" }`。字段提前固定是为了下一阶段加入自动评审时保持导出格式稳定；本阶段不推断评审是否发生。

## 身份与父子关系

### Root Agent Run

- `executionId = "agent-run:" + runId`
- `runId` 和 `sessionId` 来自 Session Run。
- 没有 Child 父关系时分类为 `root_agent_run`。

### Child Agent Run

- 粒度是子 Session 中的每个 Run，而不是整个 Child 实例。
- `executionId = "agent-run:" + runId`
- 通过 Session Task、Child 创建事件或子 Session 元数据取得 `childId`、`childSessionId` 和 `parentRunId`。
- `parentExecutionId = "agent-run:" + parentRunId`
- 同一个 Child 接收 follow-up 后产生的新 Run 单独计数，避免把多轮执行的耗时和 token 混成一条。

### Workflow Run

- `executionId = "workflow:" + workflowRunId`
- `parentExecutionId` 优先使用 snapshot 的 `ownerRun`，映射为对应 Agent Run。
- 保存 Workflow mode 和配置的 `maxConcurrency`；不把配置并发误称为实际并发峰值。

### Workflow Task

- `executionId = "workflow-task:" + workflowRunId + ":" + taskId`
- `parentExecutionId = "workflow:" + workflowRunId`
- attempt、起止时间、预算用量和终态来自 Workflow task result/running task。

若关联数据缺失，记录仍可导出，但 `parentExecutionId` 留空并将 `completeness` 标为 `partial`。

## 状态归一化

统一 outcome 只描述观察到的终态或当前态：

| 原始状态/事实 | 统一 outcome |
| --- | --- |
| 正常完成 | `completed` |
| 明确执行失败 | `failed` |
| timeout 标志或超时错误分类 | `timed_out` |
| 用户、父任务或系统取消 | `cancelled` |
| 等待依赖、权限或资源且没有执行 | `blocked` |
| 因依赖、预算或 fail-fast 未启动 | `skipped` |
| 正在执行 | `running` |
| 已持久化但未开始 | `pending` |
| 旧数据无法可靠判断 | `unknown` |

失败分类使用有限枚举：

```ts
type ExecutionFailureKind =
  | "model_error"
  | "tool_error"
  | "timeout"
  | "permission_denied"
  | "budget_exceeded"
  | "dependency_failed"
  | "cancelled_by_user"
  | "cancelled_by_parent"
  | "recovery_failed"
  | "conflict"
  | "unknown";
```

只有原始状态、结构化 metadata 或稳定错误类型能够证明分类时才设置具体值；禁止仅根据自由文本关键词猜测。原始错误字符串默认不进入导出。

## 用量与成本口径

- Agent Run 复用已有模型 attempt/usage 结算结果。
- Child Agent 的 token 记在对应子 Session Run，不重复累计到父 Run 记录。
- Workflow Task 使用 snapshot 中已上报的 budget；未上报时保持未知。
- Workflow Run 的 token 是其 Task 已知用量之和，并继承 Task 的不完整性。
- 首版不计算货币成本。模型价格、缓存计价和第三方工具费用可能缺失或变化，用 token 冒充金额会产生误导。
- 后续如引入金额估算，必须同时记录价格表版本、币种和 `estimated` 标记。

## 聚合指标定义

查询服务可以在统一记录上计算：

- `completionRate`：`completed / 已结束且实际开始的记录`。
- `failureRate`：`failed + timed_out / 已结束且实际开始的记录`。
- `cancellationRate`：单独统计 `cancelled`，不混入技术失败率。
- `skipRate`：单独统计 `skipped`，不进入完成率分母。
- `durationMs`：只统计同时具备起止时间的记录，并报告样本数。
- token 总量和均值：只对已知字段求和，同时报告 `complete / partial / unknown` 样本数。
- 失败类型分布：按 `failureKind` 分组，未知单列。

“成功率”在产品文案中统一使用 `completionRate` 或 `technicalSuccessRate` 的明确名字，避免把用户取消和依赖跳过算成模型失败。

## 查询和 JSON 导出

首版提供一个公共只读服务，支持以下过滤：

- 时间范围；
- `executionKind`；
- Session、Run、Child、Workflow Run 或 Task ID；
- outcome 和 failureKind；
- model/provider；
- 是否启用评审及评审结论。

JSON 导出结构：

```ts
interface ExecutionObservationExport {
  schemaVersion: 1;
  generatedAt: number;
  filters: ExecutionObservationFilter;
  summary: ExecutionObservationSummary;
  records: ExecutionObservation[];
  warnings: string[];
}
```

`warnings` 必须说明缺失来源、损坏 snapshot、usage 不完整和无法关联的父执行。单个损坏 Workflow snapshot 不应让全部导出失败；它应被跳过并生成 warning。Session Store 无法读取属于整体数据源失败，查询应明确失败，不能返回空报告伪装成没有数据。

导出先接到现有 CLI/本地 API 的只读入口；具体命令名在实现计划中根据当前 CLI 命令结构确定。本阶段不增加 Desktop 页面。

## 数据来源与投影边界

观测服务分成三个小组件：

1. `SessionExecutionObservationReader`：读取 Session Run、Session Task、Session 元数据和 usage。
2. `WorkflowExecutionObservationReader`：读取持久 Workflow snapshot，生成 Run 与 Task 记录。
3. `ExecutionObservationService`：合并、过滤、排序、聚合并导出。

Reader 只负责把一个来源转成统一记录；Service 不反向修改原始记录。排序固定使用 `startedAt`，缺失时回退到来源创建时间，再以 `executionId` 保证稳定输出。

不新增通用 Repository 接口来强迫 SQLite 与文件 snapshot 伪装成同一种存储。统一发生在只读领域模型层。

## 安全与隐私

默认导出仅包含标识符、枚举、时间、模型信息和计数：

- 不包含用户 prompt、Agent 输出、Workflow task prompt、工具输入输出和附件内容。
- 不包含原始错误文本、绝对工作区路径、环境变量或密钥。
- model/provider 名称可导出；自定义 provider 的 base URL 不导出。
- 导出是显式本地操作，不自动上传或发送遥测。

如果后续需要诊断详情，必须作为独立的显式选项设计，不能扩张默认导出。

## 兼容性与历史数据

- `schemaVersion` 从 1 开始；新增可选字段不提升版本，改变字段含义或删除字段才提升。
- 旧 Session Run 和 Workflow snapshot 尽可能读取；字段缺失时使用完整性标记。
- 不回填或改写历史数据库和 snapshot。
- 原始数据保留周期保持现状；首版不建立第二套清理策略。

## 实施阶段

### 阶段一：统一记录与 Reader

- 在共享协议层定义 observation、filter、summary 和 export 类型。
- 实现 Session 与 Workflow 两个 Reader。
- 覆盖身份映射、状态归一化、usage 完整性和损坏数据处理测试。

### 阶段二：查询、聚合和导出

- 实现过滤、稳定排序和聚合口径。
- 增加本地只读 API 与 CLI JSON 导出入口。
- 用固定 fixture 验证报告内容可重复、无正文泄漏。

### 阶段三：为自动评审预留实验标签

- 只加入明确由调用方提供的实验/评审标签，不自动触发评审。
- 验证同一任务的评审开启/关闭记录可以被可靠分组。

自动评审策略本身属于下一份设计，不在本阶段实现。

## 验收标准

1. 同一个父 Agent、两个 Child Run、一个 Workflow Run 和多个 Workflow Task 能导出一棵父子关系明确的执行树。
2. follow-up Child Run 独立计数，token 不与父 Run 或同 Child 的其它 Run 重复。
3. failed、timed out、cancelled、blocked、skipped 能按稳定规则区分。
4. usage 缺失或部分可用时，报告同时保留已知值和完整性状态，不补零伪装完整。
5. 聚合结果明确排除 skipped，单列 cancelled，并报告实际样本数。
6. 损坏的单个 Workflow snapshot 产生 warning，其余记录仍可导出。
7. Session Store 整体读取失败时导出失败，不返回误导性的空结果。
8. 默认 JSON 不包含 prompt、模型正文、工具内容、原始错误或绝对路径。
9. 不修改 Child Agent、Workflow 的调度、预算和恢复行为。
10. 不新增数据库表、远程遥测或 Desktop 指标页面。

## 后续决策门槛

只有在统一观测数据能够稳定回答以下问题后，才进入自动评审策略实现：

- 不同执行模式的完成率、失败率、耗时和 token 分布是否可信；
- 评审开启与关闭能否按同类任务分组比较；
- 缺失数据比例是否足以影响结论；
- 哪类失败值得触发评审，哪些属于环境或用户取消。

只有当查询性能、历史规模或多实例部署证明查询时投影不足，才考虑新增统一观测表或事件投影系统。
