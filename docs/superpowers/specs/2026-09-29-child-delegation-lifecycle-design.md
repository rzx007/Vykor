# 子代理委派与运行生命周期设计

> 状态：已按用户反馈修订并通过独立只读复审，待实施。

## 目标

让一次委派从「交代任务」到「运行、观察、调整、交付」形成闭环。复杂任务由父代理按独立工作范围拆分；宿主按任务类型约束执行资源；父代理能读取真实运行进展；预算耗尽或运行失败时保留已经取得的结果，并明确标记未完成部分。

本设计同时服务普通 `Agent` 委派和 Workflow worker。Workflow 继续负责依赖、并发、重试和写冲突调度，二者共享 ChildManager 的执行策略及进度语义。正在另行建设的统一观测底座读取这些执行事实，不承担调度控制。

## 问题证据

2026-09-29 的插件报告审核中，父会话 `4fe5e029-aa73-4e4d-a482-66e756c15764` 将约 446 行报告的全部事实核验交给一个 `verification` 子代理。该子代理运行约 16 分 21 秒，执行 147 次工具调用，数据库累计约 1,261 万输入 token，最后因 `Exceeded maximum agentic turns (100)` 失败；父代理进行了 14 次 `JobWait`，没有收到可用于交付的审核结论。

该案例说明三个独立问题：

1. 委派提示同时要求穷尽核对所有数字、运行机制、死代码断言和测试，缺少可独立交付的范围。
2. 运行中的 Child transcript 已有工具和文本事件，但 `JobRead` 对 Child job 主要读取最终 result；父代理难以判断工作已完成到哪里。
3. QueryEngine 达最大轮数时抛错，Child result 没有明确的阶段成果；任务失败与已核实内容无法同时表达。

## 方案取舍

采用**共享 Child 执行契约**：保留普通 `Agent` 与 Workflow 两种入口，在共同的 ChildManager/Run 层统一预算和非完整结束语义，并复用已有事件呈现进展。委派范围与交付要求由父代理提出；宿主只验证结构和已配置预算，不用提示词长度或文件行数猜任务难度。

不采用「只改提示词」：它无法保证预算到顶时保留结果。

不采用「所有 Agent 强制转 Workflow」：一次性委派无需先构造 DAG，迁移会增加简单任务的配置成本。待统一观测数据证实存在跨入口资源争抢，再评估是否合并队列。

## 委派契约

`Agent` 保留现有 `description`、`prompt`、`subagentType` 等输入，新增可选的结构化字段：

```ts
interface DelegationContract {
  scope?: string;
  expectedResult?: string;
  maxTurns?: number;
  timeoutSeconds?: number;
}
```

- `scope` 描述代理负责的文件、模块、问题或断言类别；它是任务边界，不是额外操作权限。
- `expectedResult` 描述父代理需要的交付物，例如带证据的发现、修改与测试结果、或明确的阻塞项。
- 字段缺省保持旧调用可用；新提示指导父代理在复杂委派中明确填写。
- 结构字段进入 Child 的任务上下文和持久任务 metadata，供 UI、JobRead 和后续观测读取。不得扩大权限或自动授予工具。
- 对明显包含多个独立工作范围的请求，协调提示要求先拆分或使用 Workflow；框架不做脆弱的关键词/长度拒绝。

角色选择也要清楚：`verification` 用于验证实现是否满足原任务，要求运行必要检查；一般的文档事实核对、代码审查和计划审核使用通用只读 `review` 角色，按断言取证，不默认运行全量测试。`review` 的工具白名单只包含 Read、Grep、Glob 等确定为只读的工具，明确拒绝 Shell、Write、Edit、Agent 等可修改状态的入口；是否允许其它只读工具以当前工具安全分类为准。两者都不能自称“权威”或“已通过”，除非输出中的证据支持。

## 子代理预算

ChildManager 为每次 Child Run 记录启动时生效的执行约束：

```ts
interface ChildRunLimits {
  maxTurns: number;
  deadlineAt?: number;
}
```

- 保留现有 `settings.maxTurns` 默认值与 Agent 定义中的 `maxTurns`。在 Child Run 启动时按现有优先级解析该任务类型的有效轮数；委派输入可进一步收紧。冻结本次 Run 的上限后，后续会话模型配置、`setMaxTurns` 和已接受 follow-up 不能抬高它。root Agent 原有动态配置语义保持不变。
- 任务类型由已有 Agent 定义表示。定义可选的 `maxTurns` 与 `timeoutSeconds`，用于区分探索、只读审核、实现和需要长时间运行测试的验证任务。普通 `Agent` 调用也可显式传更严格的预算。首版不新增统一时间默认值；没有配置时间预算的任务仍按现有行为运行。
- Workflow 保留 task/attempt 的现有 timeout 和外层 watchdog。framework Child worker 使用其角色预算；如果 Workflow task 也设置 timeout，则更早到期的约束生效，watchdog 须停止实际 worker。显式 external/detached worker 继续走原有后端和 task timeout，不套用 ChildManager 的计时器。
- 父 Run 中断或用户取消继续按现有 Abort 链传播，原因要与预算耗尽区分。
- token 用量可能由 provider 延迟上报或缺失；首版只记录/提示用量，不声称有精确的 token 硬上限。统一观测底座负责统计，不控制执行。
- 接近轮数上限时请求子代理收束并报告；到上限后不再执行新的普通工具调用。墙钟超时和用户取消立即终止，不尝试新模型收尾。
- 不设置全局 40 轮、600 秒，也不设置固定「每 20 轮」的检查点。任务类型预算和提示时机用失败审核任务及正常长任务对照后调整。

## 运行中可见的进展

首版直接读取已有的 Child 事件和子会话记录。`JobRead.details.activity` 给父代理一份有来源的、长度受限的快照：

```ts
interface ChildActivitySnapshot {
  version: 1;
  runId: string;
  updatedAt: number;
  latestAssistantText?: string;
  latestTool?: { name: string; status: "running" | "completed" | "failed"; at: number };
  toolCalls: number;
  modelTurns: number;
  usage?: { inputTokens?: number; outputTokens?: number; incomplete: boolean };
}
```

`latestAssistantText` 最多 2,000 字符，只来自已提交且未被替代的用户可见文本；更早的内容仍留在子会话。`toolCalls` 统计已开始的工具调用，`modelTurns` 只统计已成功结束的模型回合。活动对象以 `runId` 隔离，follow-up 新 Run 不继承上一轮计数。

- daemon 通过现有 `SessionStore` 的只读会话、消息和事件查询，读取已持久化的子会话文本、工具起止、模型回合与用量事件；本地 JobHost 从同一 AgentEventBus 维护当前 Run 的有限活动快照。查询前验证父 Task 属于调用者 Session、`childSessionId` 对应的子 Session 确属该父 Session、Run 身份一致。助手文本只选 `isCommittedModelPart` 接受的已提交、未被替代内容；本地流式 delta 先暂存，到成功的回合完成事件后才进入可见快照。只暴露用户可见的助手文本及工具名、状态和计数，不把 reasoning、工具输入输出、密钥或未授权子会话内容复制给父代理。
- `latestAssistantText` 是子代理原文，可能只是“正在查找”，不是已核实结论。工具成功和 token 用量也不能推导任务完成或事实正确。缺少数据时字段留空，不伪造进度。
- daemon 和本地 `JobRead` 使用一致的 `details.activity` 契约。子代理模型回合结束时，daemon 在投影子会话结果后更新父 Session Task 的小型活动游标和 `updatedAt`，唤醒现有 `waitForSessionTaskChange`。同毫秒多次 Task 更新时 `updatedAt` 必须单调递增，避免已发生的进度被旧游标漏掉；本地宿主观察 Child live 快照的回合游标。`JobWait` 因新回合或终态返回时 `timedOut=false`，只有实际达到等待截止时间才为 `true`。不要求每个工具调用都唤醒父代理。
- 父代理看到长时间没有有效进展、重复工具行为或范围偏离时，可用 `JobSend` 缩小/更正任务，用 `JobCancel` 停止，或拆出剩余工作。读取进展不隐式取消子代理。
- Workflow framework Child 可复用该活动快照；自定义/分离进程 worker 继续使用既有进度来源。
- 若对照评估证明现有事件无法表达“哪些结论已核实、证据在哪”，再单独设计 `AgentProgress` 或等价的结构化提交。首版不注册该工具，也不假设它是架构必需项。

## 完成与非完整结束

```ts
type ChildFailureKind =
  | "max_turns" | "timeout" | "user_cancelled" | "parent_interrupted"
  | "model_error" | "tool_error" | "unknown";

interface ChildPartialResult {
  version: 1;
  childSessionId: string;
  runId: string;
  source: "committed_assistant_text" | "limit_finalization";
  text: string;
  truncated: boolean;
}
```

`text` 最多 12,000 字符；超过时截断并保留子会话定位信息。`failureKind` 只从受信的执行/取消来源填写，不能靠自由文本关键词推断；无法判定时用 `unknown`。

- 子代理自然完成：保留当前 `completed` 语义及最终输出。
- 接近硬轮数上限：QueryEngine 在已冻结的轮数内为该 Child Run 预留一次禁止工具调用的收尾回复，要求说明已完成、未完成和证据；不额外越过上限，收尾回复也不是成功证明。
- 到达轮数/时间上限或模型/工具故障：若有已提交的助手文本或成功完成的收尾回复，在 Child result 中携带明确标为未完成的 `partialResult`，同时保持失败/中断的终态与明确的 `failureKind`。流式中断片段和被重试替代的文本不得进入 partial。`failureKind` 至少区分 `max_turns`、`timeout`、`user_cancelled`、`parent_interrupted`、`model_error` 和 `tool_error`；缺乏可靠来源时为 `unknown`。不能将部分成果标记为 `completed`。
- `partialResult` 区分助手原文与收尾回复，带受信 `childSessionId/runId` 便于父代理查看已持久化的子会话记录；它不声称列出了哪些结论已核实，也不编造工具记录 ID。任何文字都只是子代理的陈述。收尾模型调用本身失败时保留此前已持久化的文字与活动记录；没有成果就如实返回错误。
- 父代理看到 `partialResult` 后选择接受有证据的部分、发送 follow-up、拆出剩余任务或报告未验证；不会由框架自动重试同一宽泛提示。
- 终态 Child task 的 `JobRead` 与通知包含同一份部分结果和失败原因。部分结果须随 `run.failed/interrupted` 的现有终态投影链传给 `SessionChildExecutionBridge.completeChildExecution`，在父 Task 进入终态时一并持久化；不能等待后续 `child.closed` 再补写，因为父 Task 已终态。现有 Run 与 Task 更新分属各自事务，本阶段不为这项能力重构成一个跨模块事务。若终态桥接失败，`projection-settlement-recovery` 对该 `run.failed/interrupted` 事件的补偿也须从事件中保留 `partialResult/failureKind`，不得只写通用错误消息；重复补偿不得覆盖已保存成果。Workflow task 把部分结果保存在结果 metadata 中，仍按其 failure policy 决定下游任务。

## 运行流程

```text
父代理选择独立范围与交付物
  → Agent 或 Workflow 提交任务
  → ChildManager 冻结本次 Run 的预算、权限、父子身份
  → 子代理执行并发布现有文本、工具、回合和用量事件
  → daemon 持久化子会话；本地宿主跟踪当前 Run；JobRead/Wait 展示有来源的活动
  → 完成：返回最终结果
  → 触顶/失败：返回终态 + 原因 + 已持久化的部分结果
  → 父代理综合、纠偏或拆分剩余工作
```

普通 `Agent` 不创建 Workflow snapshot；framework Child worker 使用相同预算和进度规则。Workflow 的 external/detached worker 继续使用其已有适配器与外层 task 策略。

## 并发与安全边界

- 沿用整棵 Child 树的深度、活跃数和累计数限制。
- 同一工作目录中会写相同文件的任务，继续由 Workflow 的 `writeScope` 或 `isolate` 协调；普通 Agent 并行写入必须由父代理显式隔离或串行。
- 子会话活动只向拥有该 Child job 的父 Session 展示；已有插件能力视图保持原边界。展示活动不扩大子代理或父代理的工具权限。
- JobRead/Wait 仍检查 job 所属父 Session，不把子代理 transcript 或工具原始输入输出泄露给其他会话。
- 父代理在超时、失败或 JobRead 未更新时，可以读取结构化状态并决定下一步；系统不自动把超时解释为任务失败之外的“已经完成”。
- Workflow coordinator 将每个 attempt 的取消信号传给 runner；默认 worker adapter 在信号触发时停止它实际拥有的 Child 或 detached task，并等待收束。coordinator 的计时器只发起取消和判定超时，最多再等待 5 秒确认 runner 收束；超过该时限，结果标明停止未确认。自定义 runner 若不响应取消，同样报告清理状态未知；本阶段不承诺替外部实现清理进程。

## 兼容性

- 旧 `Agent` 调用和 Workflow spec 不要求立即添加字段。
- `AgentChildResult` 增加可选 `partialResult` / `failureKind`，旧消费者可继续读 `status/output/error`。Child result、session execution bridge、Workflow result metadata 和 Job snapshot 传递同一个细因，不把所有失败压成 `failed`。
- JobRead/Wait 在现有 `details` 中增加可选 `activity`，原有 `text/cursor/snapshot` 保持含义；`timedOut` 只描述本次等待是否超时。
- Workflow 只在已有 task metadata/summary 中补充可得的活动摘要，不改变任务状态枚举。
- 首版复用现有事件，不新增 checkpoint 事件类型或存储表；daemon 重启后终态部分结果仍可从持久记录读取。

## 验收

1. 旧任务无新增时间上限；任务类型或调用方已配置的预算生效，模型或 follow-up 不能提高该 Child Run 启动时冻结的轮数。external/detached worker 保持其独立预算策略。
2. daemon 与本地 JobRead 均可从现有事件给出有来源的活动快照；JobWait 在回合更新后返回 `timedOut=false`，真等满才为 `true`；跨会话读取仍被拒绝。
3. Child 在第 N 轮触顶时只允许收尾，不再运行普通工具；收尾失败时只保留已提交、未被替代的文字与活动记录，没有成果则明确失败。
4. 失败/超时/取消与部分结果能同时呈现，所有消费者都不能把它归为 `completed`。
5. `run.failed → child.closed` 的正常顺序、桥接完成失败后的恢复、事件重放和 daemon 重启后终态部分结果均可读取；旧任务缺少活动数据时仍正常展示。
6. 同一 Child 的 follow-up 新 Run 不沿用上一 Run 的活动快照或预算计数。
7. 使用插件报告审核任务做真实模型评估：核对任务边界、结果证据、未核实项、用量与耗时，并与本次 100 轮失败基线比较。
8. 对简单单次委派测量新增开销；只读活动快照不触发额外模型调用。
9. Workflow framework Child、detached worker、task timeout、wait timeout 和恢复执行各有测试；默认后端超时后不遗留活动 worker。自定义 runner 不响应取消时明确报告清理未确认。

## 非目标

本阶段不自动判断报告真实性、不自动决定所有任务如何拆分、不统一 Agent 与 Workflow 的排队调度器、不增加观测数据库、不设置价格表或严格货币成本上限，也不预设 `AgentProgress` 工具。是否增加专门进度工具、调整角色预算或统一队列，以观测底座与真实评估的结果决定。
