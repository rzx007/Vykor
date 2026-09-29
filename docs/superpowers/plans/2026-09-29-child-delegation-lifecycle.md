# 子代理委派与运行生命周期实施计划

> 状态：可逐任务交接；尚未实施。

> **For agentic workers:** Read the spec and this plan before editing. Execute only the assigned task number, following its failing-test and verification steps. Do not start another task, spawn more agents, or stage unrelated files unless the user explicitly asks. Use a local planning/TDD skill if available; the steps below remain executable without one.

**Goal:** 让普通 Agent 与 framework Workflow worker 按任务类型接受预算，运行中可读取真实活动，并在非完整结束时交付已保存成果。

**Architecture:** 保留 Agent 和 Workflow 两个入口。ChildManager 管本次 Run 的身份与可选预算；JobRead 从现有事件/子会话读取活动；QueryEngine 在 Child 轮数触顶时收尾；终态结果沿已有投影与恢复路径传递。详见 [设计规格](../specs/2026-09-29-child-delegation-lifecycle-design.md)。

**Tech Stack:** TypeScript、Vitest、SQLite SessionStore、现有 AgentEventBus/JobHost/Workflow runner。

**Spec:** `docs/superpowers/specs/2026-09-29-child-delegation-lifecycle-design.md`

## 交接约束

- 工作区可能同时有用户或其它智能体的修改。先执行 `git status --short` 和指定文件的 `git diff`；只改本任务文件，不重置、删除或提交其它 WIP。共享文件只能串行编辑。
- 统一观测底座正在单独实施；不要编辑 `packages/server/src/application/observability/` 或改写其统计口径。若确实需要共享字段，先记录冲突并交给主代理协调。
- 保留现有 `settings.maxTurns` 默认值。不加全局 40 轮/600 秒，不在首版加入 `AgentProgress`。新时间预算仅在任务类型或调用者显式配置时生效。
- 不把助手的流式残片、reasoning、工具原始输入输出或被重试替代的文本当作已保存成果。使用现有 `isCommittedModelPart` 语义。
- `partial` 表示任务未完成。任何失败、超时、取消和触顶均不得报告 `completed`。
- 测试从仓库根目录使用 `pnpm --filter <包> exec vitest run <包内路径>`；若 pnpm 自身不可用，可进入包目录使用其已安装的 `vitest`。先跑最窄测试，最后再做相关包类型检查。
- 每项完成后报告修改文件、红/绿测试命令与实际结果、未验证部分。主代理审查后才开始下一项；未获明确要求不自行提交 Git。

## 稳定接口与数据形状

Task 1 定义可选 `scope`、`expectedResult`、`maxTurns`、`timeoutSeconds`，并保留旧 Agent 输入。`scope` 只是任务描述，不扩大文件或工具权限。

Task 2–3 将 Child Run 启动时已选定的轮数冻结为硬上限；Agent 定义已有 `maxTurns`，可新增可选 `timeoutSeconds`。优先级为角色显式值、当前请求配置、已有设置；调用方只能进一步收紧。没配置时间就没有新 deadline。root Agent 的动态配置仍按原规则工作。

Task 4–7 共用下面的只读快照。`latestAssistantText` 最多 2,000 字符；只来自已提交、未被替代的用户可见文本。其它字段缺失时省略，不以零冒充未知。

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
// JobReadResult.details?.activity?: ChildActivitySnapshot
```

Task 8–11 共用下面的失败与部分结果契约。`text` 最多 12,000 字符，超过时 `truncated=true`，完整记录仍留在子会话。没有已提交文本或成功收尾回复，就不创建 `partialResult`。错误种类只能从受信执行/取消来源取得，不能解析自由文本猜测。

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
// AgentChildResult 增加可选 partialResult 和 failureKind；status 仍是原有终态。
```

## 任务依赖与文件所有权

按编号串行交接。Task 1→2→3 确立委派与预算；Task 4→5→6→7 让父代理观察；Task 8→9→10→11 保留非完整结果；Task 12 接入 Workflow 超时；Task 13 才做角色指导和真实评估。Task 4/9 都可能触及 `child-agent.ts`，Task 5/7/10 都可能触及 server 投影或 Jobs；因此不要在一个共享工作区并行写这些任务。

如果用户要求提交某项任务，只暂存该任务自己的文件。文档、插件报告、Desktop 会话菜单和观测底座的现有 WIP 不属于本计划提交范围。

### Task 1：Agent 委派输入契约

**改动：** `packages/core/src/types/runtime.ts`、`packages/tools/src/agent/agent-tools.ts`、`packages/agent-runtime/src/child-agent.ts`、`packages/server/src/application/agent/daemon-agent-event-projector.ts`。**测试：** `packages/tools/src/agent/__test__/agent-tools.test.ts`、`packages/agent-runtime/src/child-agent.test.ts`、`packages/server/src/application/agent/__test__/daemon-agent-event-projector.test.ts`。

- [ ] 先写三个行为：`scope/expectedResult/maxTurns/timeoutSeconds` 到达 `spawnChildAgent`；`0`、负数、非整数预算被拒且不 spawn；Child 初始输入含任务边界/交付要求，父 Task metadata 保留两字段，旧输入完全不变。
- [ ] 运行 `pnpm --filter @vykor/tools exec vitest run src/agent/__test__/agent-tools.test.ts`、`pnpm --filter @vykor/agent-runtime exec vitest run src/child-agent.test.ts`、`pnpm --filter @vykor/server exec vitest run src/application/agent/__test__/daemon-agent-event-projector.test.ts`。预期新增用例分别因字段未透传/任务上下文缺失/metadata 缺失而失败。
- [ ] 添加四个可选字段并校验正安全整数、非空有界文本；ChildManager 将 `scope/expectedResult` 送入 Child 的初始任务文本，`child.created` 携带它们，daemon projector 只把这两段任务描述写入父 Task metadata。字段不作为权限或文件路径白名单。
- [ ] 重跑三条测试命令及 `pnpm --filter @vykor/tools check-types`、`pnpm --filter @vykor/agent-runtime check-types`、`pnpm --filter @vykor/server check-types`；均需退出码 0。

交付：旧 Agent 调用可用；`AgentChildSpawnInput` 收到受校验的任务范围、交付描述和可选预算。

### Task 2：角色预算选择与轮数硬上限

**改动：** `packages/coordinator/src/types.ts`、`packages/coordinator/src/agent-loader.ts`、`packages/agent-runtime/src/child-agent-options.ts`、`packages/agent-runtime/src/child-agent.ts`、`packages/agent-runtime/src/agent.ts`、`packages/agent-runtime/src/framework-agent-run.ts`、`packages/core/src/types/runtime.ts`、`packages/core/src/engine/query-engine.ts`。**测试：** `packages/coordinator/src/__test__/agent-loader.test.ts`、`packages/agent-runtime/src/child-agent-options.test.ts`、`packages/agent-runtime/src/child-agent.test.ts`、`packages/agent-runtime/src/framework-agent-run-input.test.ts`、`packages/core/src/engine/integration.test.ts`、`packages/core/src/engine/request-configuration.test.ts`。

- [ ] 先写测试：角色 `timeoutSeconds` 被加载；Child 的有效 `maxTurns` 在每次 Run 启动时冻结；后续请求配置、`setMaxTurns`、已接受 follow-up 试图调大时仍在已冻结轮数结束；同一 Child 的下一个 Run 重新取得当时配置；root Agent 的动态配置测试保持原行为。
- [ ] 分别运行 `pnpm --filter @vykor/coordinator exec vitest run src/__test__/agent-loader.test.ts`、`pnpm --filter @vykor/agent-runtime exec vitest run src/child-agent-options.test.ts src/child-agent.test.ts src/framework-agent-run-input.test.ts`、`pnpm --filter @vykor/core exec vitest run src/engine/integration.test.ts src/engine/request-configuration.test.ts`。预期新增 Child 上限用例失败。
- [ ] 角色显式 `maxTurns` 优先于当前请求配置，后者优先于现有 `settings.maxTurns`；Task 1 委派值只可取更小值。通过 ChildManager→`VykorAgentSubmitOptions`→FrameworkAgentRun→`AgentExecutionContext` 传递本次 Run 的受信 `hardMaxTurns`。QueryEngine 在本次 `submitMessage` 中用局部上限约束请求配置、`setMaxTurns` 和已接受 follow-up；不要把硬上限只放在可复用 QueryEngine 实例的构造配置里。
- [ ] 重跑三条命令及 `pnpm --filter @vykor/coordinator check-types`、`pnpm --filter @vykor/core check-types`、`pnpm --filter @vykor/agent-runtime check-types`。验证旧角色未配时间时没有新计时器。

交付：角色可配置时间，Child 本轮轮数不能运行中抬高；没有新的全局预算默认值。

### Task 3：可选墙钟 deadline 与取消来源

**改动：** `packages/agent-runtime/src/child-agent.ts`、`packages/core/src/types/runtime.ts`。**测试：** `packages/agent-runtime/src/child-agent.test.ts`。

- [ ] 先写测试：没配置 `timeoutSeconds` 的 Child 不设定时器；配置后到期会停止当前 Run，结果 `failed/failureKind=timeout`；父 Run abort 仍是 interrupted，用户 JobCancel 仍保留其来源；Run settle/close 后定时器清除，follow-up 新 Run 重新计时。
- [ ] 运行 `pnpm --filter @vykor/agent-runtime exec vitest run src/child-agent.test.ts`；预期新增 timeout 用例失败。
- [ ] ChildManager 在 `beginRun` 创建 Run 信号和可选计时器；计时器到期 abort Run 并记录受信来源，不根据异常字符串分类。清理发生在成功、失败、首次创建失败与 close 路径。
- [ ] 重跑测试和 `pnpm --filter @vykor/agent-runtime check-types`。确认失败与取消状态没有互相改写。

交付：只有明确配置了时间预算的 Child 才受墙钟约束。

### Task 4：本地 Child 活动快照

**改动：** `packages/agent-runtime/src/child-agent.ts`、`packages/core/src/types/runtime.ts`。**参考：** `packages/agent-runtime/src/event-source.ts`。**测试：** `packages/agent-runtime/src/child-agent.test.ts`。

- [ ] 先写测试：Child 发出文本 delta 时快照不可见；成功 `output.turn.completed` 后才可见最多 2,000 字符；重试/失败丢弃未提交文本；工具输入输出及 reasoning 不出现在快照；follow-up Run 清空前一 Run 数据。
- [ ] 运行 `pnpm --filter @vykor/agent-runtime exec vitest run src/child-agent.test.ts`；预期新增快照用例失败。
- [ ] ChildManager 订阅共享 EventBus，按受信 `childId/runId` 同步归并已有事件。EventBus 的可靠 sink 成功后才调用订阅者；订阅失败不伪造已持久进度。关闭时退订。
- [ ] 重跑测试与 `pnpm --filter @vykor/agent-runtime check-types`。核对快照没有改变 Child 完成状态或插件权限。

交付：`AgentChildHandle.activity` 可只读查看当前 Run 的有限活动，且文本遵守 committed 边界。

### Task 5：daemon JobRead 读取已持久化的子会话活动

**改动：** `packages/server/src/jobs/daemon-job-service.ts`、`packages/server/src/application/daemon-application.ts`。**测试：** `packages/server/src/jobs/daemon-job-service.test.ts`。

- [ ] 先写测试：父 Session 可读自己 Child 当前 Run 的 `details.activity`；伪造 `childSessionId`、错父 Session、错 Run 均被拒；只返回已提交且未被替代的文本，reasoning/工具原始内容不出现；daemon 重启后仍可读终态快照。
- [ ] 运行 `pnpm --filter @vykor/server exec vitest run src/jobs/daemon-job-service.test.ts`；预期新增活动读取用例失败。
- [ ] 扩展 `JobSessionStore` 的只读查询入口，生产组装由现有 SessionStore 提供。先核对父 Task 和子 Session 归属，再使用 `isCommittedModelPart` 过滤消息部分；按稳定时间和 Run 身份形成 Task 4 的 JSON 形状。
- [ ] 重跑测试及 `pnpm --filter @vykor/server check-types`。普通 shell/Workflow JobRead 返回形状保持原样。

交付：父代理可用 JobRead 看子代理已经持久化的事实活动，不能跨会话读取。

### Task 6：本地 JobRead/JobWait 活动读取

**改动：** `packages/tools/src/job/local-job-host.ts`。**测试：** `packages/tools/src/job/local-job-host.test.ts`。

- [ ] 先写测试：Child 仍运行时 JobRead 的 `details.activity` 来自 `AgentChildHandle.activity`；新完成回合使 JobWait 返回 `timedOut=false`；没有新回合直到等待截止才返回 `timedOut=true`；其它 Job kind 不受影响。
- [ ] 运行 `pnpm --filter @vykor/tools exec vitest run src/job/local-job-host.test.ts`；预期新增 Child 活动与等待语义用例失败。
- [ ] 本地宿主以当前 Run 活动游标判断变化，JobWait 继续使用现有有界等待，不能把“仍在运行”直接等同于“本次等待超时”。
- [ ] 重跑测试和 `pnpm --filter @vykor/tools check-types`。

交付：独立 Node/CLI 宿主和 daemon 对 Child JobRead 使用相同活动字段。

### Task 7：daemon JobWait 的父任务通知

**改动：** `packages/server/src/application/agent/daemon-agent-event-projector.ts`、`packages/server/src/jobs/daemon-job-service.ts`、`packages/services/src/runs/run-repository.ts`。**测试：** `packages/server/src/application/agent/__test__/daemon-agent-event-projector.test.ts`、`packages/server/src/jobs/daemon-job-service.test.ts`、`packages/services/src/runs/run-repository.test.ts`。

- [ ] 先写测试：子 Run 成功 `output.turn.completed` 后父 Session Task 的活动游标与 `updatedAt` 增加；同一毫秒连更两次，`updatedAt` 仍递增；等它的 JobWait 在仍 `running` 时返回 `timedOut=false`；无变化等满为 `true`；重复事件不重复计数；重试未提交的文本不可见。
- [ ] 运行 `pnpm --filter @vykor/server exec vitest run src/application/agent/__test__/daemon-agent-event-projector.test.ts src/jobs/daemon-job-service.test.ts` 和 `pnpm --filter @vykor/services exec vitest run src/runs/run-repository.test.ts`；预期新增父任务通知与同毫秒游标用例失败。
- [ ] 在子会话 `complete` 投影成功后仅更新父 Task 的轻量游标/时间，沿现有 `waitForSessionTaskChange` 唤醒；SessionTask 更新采用单调 `updatedAt`。JobWait 按游标是否真的变化设置 `timedOut`；不把模型正文复制到父 Task。
- [ ] 重跑测试及 `pnpm --filter @vykor/server check-types`、`pnpm --filter @vykor/services check-types`。

交付：父代理的 JobWait 可因真实回合进展醒来，且不误报超时。

### Task 8：QueryEngine 的 Child 轮数触顶收尾

**改动：** `packages/core/src/engine/query-engine.ts`、`packages/core/src/types/runtime.ts`。**测试：** `packages/core/src/engine/integration.test.ts`。

- [ ] 先写测试：Child 最后一轮要继续用工具时，该工具不执行，而在已冻结上限内得到一次无工具收尾；收尾依然标为非完整；根 Agent 原有 `MaxTurnsExceeded` 行为不变；模型收尾失败仍以失败终结。
- [ ] 运行 `pnpm --filter @vykor/core exec vitest run src/engine/integration.test.ts`；预期新增 Child 收尾用例失败，既有 root 轮数用例仍通过。
- [ ] 复用已有 `forceFinalResponse` 的禁用工具路径，添加 Child 专用收尾原因；不要额外越过上限，也不要从收尾文本推断任务已验证。
- [ ] 重跑上述命令与 `pnpm --filter @vykor/core check-types`。

交付：到轮数上限时不再执行普通工具，并给 Child 一次有界交付机会。

### Task 9：Framework Run 与 ChildResult 的 partial

**改动：** `packages/agent-runtime/src/framework-agent-run.ts`、`packages/agent-runtime/src/child-agent.ts`、`packages/core/src/types/runtime.ts`。**测试：** `packages/agent-runtime/src/framework-agent-run-retry.test.ts`、`packages/agent-runtime/src/child-agent.test.ts`。

- [ ] 先写测试：触顶收尾成功时是 `failed` 加 `failureKind=max_turns` 和受限 `partialResult`；中途模型失败时只保留此前已提交、未被替代的文本；没有文本时不生成空 partial；用户取消/父中断/墙钟超时保留各自受信来源。
- [ ] 运行 `pnpm --filter @vykor/agent-runtime exec vitest run src/framework-agent-run-retry.test.ts src/child-agent.test.ts`；预期新增部分结果用例失败。
- [ ] FrameworkAgentRun 维护最近一次成功 `complete` 的文本边界，`run.failed/interrupted` 只携带此边界内的文本或成功收尾回复。ChildManager 将状态、细因和 partial 一起返回；不要直接使用失败时累计的流式 `output`。
- [ ] 重跑测试及 `pnpm --filter @vykor/agent-runtime check-types`。

交付：本地 Child 失败时父代理可取得明确标为 partial 的已保存成果。

### Task 10：daemon 终态、补偿和重启读取

**改动：** `packages/server/src/application/agent/daemon-agent-event-projector.ts`、`packages/server/src/application/agent/projection-settlement-recovery.ts`、`packages/server/src/application/session/session-execution-projector.ts`、`packages/server/src/jobs/daemon-job-service.ts`。**测试：** `packages/server/src/application/agent/__test__/daemon-agent-event-projector.test.ts`、`packages/server/src/application/agent/__test__/projection-settlement-recovery.test.ts`、`packages/server/src/application/session/__test__/session-execution-projector.test.ts`、`packages/server/src/jobs/daemon-job-service.test.ts`。

- [ ] 先写测试：`run.failed/interrupted` 终态处理链把 partial/failureKind 写入父 Task；随后 `child.closed` 不覆盖；桥接失败走 `compensate-child` 时仍保留两字段；重复补偿幂等；daemon 重启后 JobRead 仍可读；无成果则仅失败而不伪造 partial。
- [ ] 运行 `pnpm --filter @vykor/server exec vitest run src/application/agent/__test__/daemon-agent-event-projector.test.ts src/application/agent/__test__/projection-settlement-recovery.test.ts src/application/session/__test__/session-execution-projector.test.ts src/jobs/daemon-job-service.test.ts`；预期新增终态/补偿用例失败。
- [ ] 沿现有 `SessionChildExecutionBridge.completeChildExecution` 更新父 Task，补偿端从同一受信终态事件取 partial。保持 Run 和 Task 当前事务边界及投影恢复机制。
- [ ] 重跑测试及 `pnpm --filter @vykor/server check-types`。

交付：正常终态和恢复路径看到同一份部分结果，不会错标完成。

### Task 11：Workflow 传递 Child 部分结果

**改动：** `packages/tools/src/agent/child-task.ts`、`packages/tools/src/agent/workflow/runner.ts`。**测试：** `packages/tools/src/agent/workflow/__test__/runner.test.ts`。

- [ ] 先写测试：framework Child 的 `failed + partialResult + failureKind` 经 await adapter 到 Workflow task result 的 metadata，任务仍为 failed，依赖任务遵守现有 failure policy；普通 completed 与 external worker 输出保持兼容。
- [ ] 运行 `pnpm --filter @vykor/tools exec vitest run src/agent/workflow/__test__/runner.test.ts`；预期新增 metadata 用例失败。
- [ ] 只扩展 Child result 映射与 Workflow worker result metadata，不改变 Workflow 状态枚举或独立 worker adapter。
- [ ] 重跑测试与 `pnpm --filter @vykor/tools check-types`。

交付：Workflow 能保留失败 worker 的可用成果，同时仍按失败传播。

### Task 12：Workflow 超时后收束实际 worker

**改动：** `packages/coordinator/src/workflow/model.ts`、`packages/coordinator/src/workflow/task-runner.ts`、`packages/tools/src/agent/workflow/runner.ts`。**测试：** `packages/coordinator/src/workflow/__test__/scheduler.test.ts`、`packages/tools/src/agent/workflow/__test__/runner.test.ts`。

- [ ] 先写测试：framework Child 超时后被停止；detached worker 由原 supervisor 停止；resume 已有 worker 也可停止；自然完成与 timeout 竞争不会取消已完成任务；自定义 runner 忽略信号时报告清理未确认。
- [ ] 运行 `pnpm --filter @vykor/coordinator exec vitest run src/workflow/__test__/scheduler.test.ts` 和 `pnpm --filter @vykor/tools exec vitest run src/agent/workflow/__test__/runner.test.ts`；预期新增停止/竞态用例失败。
- [ ] `WorkflowRunnerContext` 传 `signal/deadlineAt`。coordinator 到期 abort，默认 adapter 用自己持有的 worker ID 调用 stopTask 并等待结算；最多额外等 5 秒，无法确认时标记清理未知。Child 角色 deadline 与 task deadline 取更早值，自定义/detached 后端不被强制解释成 Child。
- [ ] 重跑两组测试与 `pnpm --filter @vykor/coordinator check-types`、`pnpm --filter @vykor/tools check-types`。

交付：默认 Workflow 后端超时后不留下活动 worker，结果诚实区分“已停止”和“停止未确认”。

### Task 13：角色指导与对照评估

**改动：** `packages/coordinator/src/agent-definitions.ts`、`packages/coordinator/src/system-prompt.ts`、`packages/tools/src/agent/agent-tools.ts`、`docs/agent-child-session-flow.md`。**测试：** 创建 `packages/coordinator/src/agent-definitions.test.ts`，并运行 `packages/tools/src/agent/__test__/agent-tools.test.ts`。

- [ ] 先写测试：只读 `review` 角色可用 Read/Grep/Glob，不能使用 Shell、Write、Edit、Agent；`verification` 继续验证实现；角色选择及 Agent 工具描述能表达范围和预期交付。
- [ ] 运行 `pnpm --filter @vykor/coordinator exec vitest run src/agent-definitions.test.ts` 和 `pnpm --filter @vykor/tools exec vitest run src/agent/__test__/agent-tools.test.ts`；预期新增 review 角色行为用例失败。
- [ ] 增加通用 review 角色及委派指引，不按报告行数或提示词字符数硬拆任务；父代理使用 JobRead 的活动和 partial 决定 JobSend、JobCancel 或拆剩余范围。
- [ ] 复跑测试及 `pnpm --filter @vykor/coordinator check-types`、`pnpm --filter @vykor/tools check-types`。然后优先使用已配置的 OpenCode Go / `deepseek-v4.1-flash` 跑插件报告审核案例，以及一项长测试、一项多文件阅读任务；模型不可用时记录环境限制，不偷偷换模型。记录交付质量、未核实项、轮数、工具调用、耗时与 token；此评估决定后续角色预算和是否需要专用进度工具，不在本任务中预设这些参数。

交付：角色选择更符合任务性质，附一份可复核的真实模型评估记录。

## 最终整合门禁

- [ ] 重跑受影响的 core、agent-runtime、tools、coordinator、server 定向测试与 TypeScript 检查；只有因当前改动触及其它模块时才扩大测试范围。
- [ ] 用一个 Child `JobRead → JobWait → JobSend/JobCancel → 终态 JobRead` 集成用例覆盖父代理观察和介入；用一个 Workflow 集成用例覆盖失败 partial 与后续依赖处理。
- [ ] `git diff --check` 为 0；用 `git status --short` 和 `git diff --name-only` 核对本任务范围。只有获准提交时才暂存指定文件，并用 `git diff --cached --name-only` 再核对一次。报告未验证环境项和真实模型评估的限制。

## 每项任务的交付回执

实施者完成指定任务后用以下格式回报，供主代理判断是否进入下一项：

```text
Task N：完成 / 部分完成 / 阻塞
修改文件：...
失败测试：命令、预期失败、实际失败
通过验证：命令、通过数、退出码
接口变化：...
与统一观测底座或其它 WIP 的交集：无 / 具体文件与处理方式
未验证或需下一任务接手：...
Git：未提交 / 仅本任务提交 <hash>
```
