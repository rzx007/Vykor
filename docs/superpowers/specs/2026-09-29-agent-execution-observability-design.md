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

  source: {
    kind: "session_run" | "workflow_snapshot";
    id: string;
  };
  completeness: "complete" | "partial";
}
```

`model` 和 `provider` 表示最后一个已结束 model attempt 使用的值；过滤也只针对这个值。一个 Run 的完整 attempt 序列仍保留在原始 Session Store，不在首版记录中复制。后续评审字段可以作为可选字段新增，不需要为了尚未存在的数据在首版预留空对象。

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
- 逐个遍历 `plan.tasks`，按 `result > running > blocked > pending` 的优先级为每个 Task 生成且只生成一条记录。
- attempt、起止时间、预算用量和终态来自对应的 result、running task、blocked task 或 pending 列表。
- 若 Task metadata 中的 `workerTaskId` 能关联到持久 Session Task/Child Run，则把对应 Agent Run 写入 `backingExecutionIds`。Workflow 重试目前只保留最后一次 worker metadata，无法找回更早 attempt 的 Child Run 时必须标记 `partial`。

若关联数据缺失，记录仍可导出，但 `parentExecutionId` 留空并将 `completeness` 标为 `partial`。

Workflow Task 与其 Child Run 是同一工作的逻辑层和物理执行层，不能直接相加。默认 summary 必须按 `executionKind` 分组；不提供跨四种 kind 的总完成数、总耗时或总 token。调用方如要比较调度层，使用 `workflow_task`；如要分析模型实际消耗，使用 `child_agent_run`。

## 状态归一化

统一 outcome 只描述观察到的终态或当前态：

| 原始状态/事实 | 统一 outcome |
| --- | --- |
| 正常完成 | `completed` |
| 明确执行失败 | `failed` |
| 结构化 timeout 标志 | `timed_out` |
| 结构化取消原因 | `cancelled` |
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

只有原始状态、结构化 metadata 或稳定错误类型能够证明分类时才设置具体值；禁止仅根据自由文本关键词猜测。当前 Session Run 的 `interrupted` 没有持久化结构化的用户取消、父取消、超时或恢复失败原因，因此首版必须映射为 `unknown`，不能伪装成 `cancelled`。同理，`tool_error` 和 `permission_denied` 仅在来源存在结构化分类时使用。原始错误字符串默认不进入导出。

## 用量与成本口径

- Agent Run 复用已有模型 attempt/usage 结算结果。
- Child Agent 的 token 记在对应子 Session Run，不重复累计到父 Run 记录。
- Workflow Task 使用 snapshot 中已上报的 budget；未上报时保持未知。当前重试逻辑只保留最后一次已知 budget，并不保证跨 attempt 累计，因此只有来源明确带有“跨 attempt 累计”标记时才能记为 `complete`；`attemptCount > 1` 且没有该标记时必须为 `partial`。
- Workflow Run 的 token 是其 Workflow Task 已知用量之和，并继承 Task 的不完整性。该数值属于调度层视图，不得再与 backing Child Run 的 token 相加。
- 首版不计算货币成本。模型价格、缓存计价和第三方工具费用可能缺失或变化，用 token 冒充金额会产生误导。
- 后续如引入金额估算，必须同时记录价格表版本、币种和 `estimated` 标记。

## 聚合指标定义

查询服务按 `executionKind` 分组计算，不生成跨 kind 的默认总计：

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

`warnings` 必须说明缺失来源、损坏 snapshot、usage 不完整和无法关联的父执行。warning 只能包含稳定错误码和不透明记录 ID，不能拼接 decoder exception、原始 JSON 或绝对 snapshot 路径。

现有 Workflow Repository 的 snapshot 与 event 读取都无法满足诊断要求：文件实现会静默忽略损坏 snapshot 或 event 行，SQLite 实现会因一条损坏记录让整批读取失败。Workflow 带诊断读取阶段必须为 snapshot 列表和单个 Run 的 event 列表增加逐条解码接口，同时返回有效记录和安全诊断。

单个损坏 snapshot 被跳过并产生 warning；单个损坏 event 被跳过，只让对应 Workflow Run 的时间与 `completeness` 变为 `partial`，其余有效事件仍可用于投影。底层存储整体不可读时查询明确失败，不能返回空报告伪装成没有数据。

导出先接到现有 CLI/本地 API 的只读入口；具体命令名在实现计划中根据当前 CLI 命令结构确定。本阶段不增加 Desktop 页面。

## 数据来源与投影边界

观测服务分成三个小组件：

1. `SessionExecutionObservationReader`：读取 Session Run、Session Task、Session 元数据和 usage。
2. `WorkflowExecutionObservationReader`：通过带诊断的 snapshot/event 读取接口获取持久 Workflow 数据，生成 Run 与 Task 记录。
3. `ExecutionObservationService`：合并、过滤、排序、聚合并导出。

Reader 只负责把一个来源转成统一记录；Service 不反向修改原始记录。排序固定使用 `startedAt`，缺失时回退到来源创建时间，再以 `executionId` 保证稳定输出。

Workflow snapshot 只有 `createdAt/updatedAt`，其中 `updatedAt` 可能被恢复、对账或后续保存改变，不能直接当作精确结束时间。Workflow Run 优先从持久的 `workflow_started`、`workflow_finished`、`workflow_cancelled` 事件取得起止时间；缺少事件时只保留可证明的时间，并将 `durationMs` 留空、`completeness` 标为 `partial`。

不新增横跨 Session Store 与 Workflow Repository 的通用存储抽象。文件和 SQLite Workflow Repository 继续实现已有的同一领域接口，只补充 snapshot/event 带安全诊断的读取能力；最终统一仍发生在只读观测模型层。

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

### 阶段一：协议与纯函数

- 在共享协议层定义 observation、filter、summary 和 export 类型及解析测试。
- 用纯函数测试状态归一化、usage 完整性和安全 warning 格式。

### 阶段二：Session Reader

- 从 Session Run、attempt、Session Task 和 Child 元数据生成 Root/Child Run。
- 测试 follow-up、缺失父关系、多 attempt 最终模型语义和 interrupted → unknown。

### 阶段三：Workflow 带诊断读取

- 为文件与 SQLite Workflow Repository 的 snapshot 和 event 增加逐条解码诊断。
- 测试单条损坏 snapshot、单条损坏 event、底层存储失败和诊断内容不泄漏路径/原文。

### 阶段四：Workflow Reader

- 按 `result > running > blocked > pending` 投影所有 plan task。
- 测试 backing Child 关联、重试 budget partial、事件时间和每个 Task 恰好一条记录。

### 阶段五：查询、聚合和导出

- 实现过滤、稳定排序、按 kind 聚合及重复计数防护。
- 增加本地只读 API 与 CLI JSON 导出入口。
- 用固定 fixture 验证报告内容可重复、无正文/错误/路径泄漏。

自动评审标签的持久化来源和触发策略属于下一份设计，不在本阶段预留或实现。

## 验收标准

1. 同一个父 Agent、两个 Child Run、一个 Workflow Run 和多个 Workflow Task 能导出一棵父子关系明确的执行树。
2. follow-up Child Run 独立计数；Workflow Task 能关联已知 backing Child Run；默认聚合不跨 kind 相加。
3. failed、timed out、cancelled、blocked、skipped 只在结构化来源足够时区分；无法证明的 interrupted Run 输出 `unknown`。
4. usage 缺失或部分可用时，报告同时保留已知值和完整性状态，不补零伪装完整。
5. 聚合结果按 executionKind 分组，明确排除 skipped，单列 cancelled，并报告实际样本数。
6. 损坏的单个 Workflow snapshot 或 event 产生安全 warning；坏 event 只让所属 Workflow Run 的时间与完整性降级，其余记录仍可导出。
7. Session Store 整体读取失败时导出失败，不返回误导性的空结果。
8. 默认 JSON 不包含 prompt、模型正文、工具内容、原始错误或绝对路径。
9. 不修改 Child Agent、Workflow 的调度、预算和恢复行为。
10. Workflow Run 只在持久事件提供边界时计算 duration，不把 snapshot `updatedAt` 当精确结束时间。
11. 不新增数据库表、远程遥测或 Desktop 指标页面。

## 后续决策门槛

只有在统一观测数据能够稳定回答以下问题后，才进入自动评审策略实现：

- 不同执行模式的完成率、失败率、耗时和 token 分布是否可信；
- 评审开启与关闭能否按同类任务分组比较；
- 缺失数据比例是否足以影响结论；
- 哪类失败值得触发评审，哪些属于环境或用户取消。

只有当查询性能、历史规模或多实例部署证明查询时投影不足，才考虑新增统一观测表或事件投影系统。
