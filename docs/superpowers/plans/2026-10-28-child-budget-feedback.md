# 子代理预算反馈实施计划

> 状态：已实施，所选自动化验收通过（2026-10-28）；真实模型行为和用户实际样式检查未执行。执行范围与证据见文末。
>
> **面向 AI 代理的工作者：** 使用 `executing-plans` 逐任务实施，以复选框记录进度；本计划采用顺序执行，不要求并行代理。

**目标：**子运行用完额度后，停止原因、已有报告和运行身份能准确保存与读取，主代理和桌面获得一致说明。

**架构：**Core（模型与工具循环的执行核心）计算预算；Runtime（子代理运行层）固定本轮结果；daemon（共用后台进程）将事件写成持久记录；Jobs（后台任务读取与控制接口）的来源统一返回格式；工具和桌面各自消费这些事实。复用现有状态、报告、输入能力和运行回执。

**技术栈：**现有 TypeScript、Vitest、React、SessionStore 与临时 SQLite；不增加依赖、数据库迁移或测试框架。

设计依据：[子代理预算提示与未完成结果处理方案](../specs/2026-10-28-child-budget-feedback-design.md)。当前流程：[子代理流程](../../agent-child-session-flow.md)、[Jobs 协议](../../jobs-protocol.md)。

## 修改顺序与止步条件

顺序固定为 **1 结果保存 → 2 Jobs 来源 → 3 预算提示及工具说明 → 4 桌面展示 → 5 集成验收**。本轮按用户后续要求先完成编码与回归用例，再集中运行相关测试和类型检查；未执行逐任务的红灯循环，也未逐任务提交。勾选表示交付目标及对应集中验收已完成。已通过的测试只在代码变化、失败或新发现需要时重跑。

本次不新增 `outcome.status`、动态 `nextAction`、可配置策略、报告正文解析器、预算计数器或续跑入口。不迁移目录，不重构完整生命周期，也不把所有失败都解释成预算耗尽。若必须改变权限、真实停止或共享额度规则，应返回设计讨论，不能在工具或 UI 中补分支绕过。

代码实施前按仓库隔离约定准备工作区，并带上已修订设计；不要覆盖当前其他修改或未跟踪文件。下文命令从仓库根运行，`pnpm --filter` 会切换到对应包目录。

## 文件边界

以下先列生产文件与职责，测试及 README 跟随各任务列出。除两项明确的新文件外，均修改既有文件。

| 任务 | 生产文件 | 职责 |
| --- | --- | --- |
| 1 | `packages/services/src/runs/commands.ts`、`run-repository.ts` | 为现有任务更新命令补充显式清除错误的能力 |
| 1 | 新建 `packages/server/src/application/agent/child-task-result.ts` | 正常结算与恢复共用的内部结果字段转换，不保存状态 |
| 1 | `packages/server/src/application/agent/daemon-agent-event-projector.ts`、`projection-settlement-recovery.ts` | 分开保存报告和错误，清除上一轮失败信息，保护新一轮 |
| 2 | `packages/agent-runtime/src/node/jobs/child-job-source.ts` | 实时 List／Read／Wait 使用同一个快照构造函数 |
| 2 | `packages/server/src/jobs/job-snapshots.ts` | 归档按请求的 Run 读取，与实时使用相同字段位置 |
| 3 | `packages/core/src/engine/query-engine.ts` | 在既有当轮提示组装点使用真实剩余轮次 |
| 3 | `packages/tools/src/agent/agent-tools.ts`、`packages/tools/src/job/job-tools.ts` | 参数说明、父代理处理说明与有界摘要 |
| 4 | `apps/desktop/src/renderer/src/components/desktop/tools/agents/agent-task-model.ts`、`agents-tool.tsx` | 统一展示计算及列表、详情接入 |
| 4 | `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/activity/agent-activity-message.tsx` | 活动行复用同一展示计算，保留派出和等待处理行为 |

任务 2 新建的专门测试为 `packages/server/src/jobs/__test__/job-snapshots.test.ts`；任务 5 复用真实工厂夹具，不新增另一套生命周期夹具。共享状态枚举、`packages/jobs/src/contracts.ts`、数据库表和客户端协议类型保持现有结构。

## 任务 1：让正常结算与恢复保存同一份运行事实

**修改：**

- `packages/services/src/runs/commands.ts`
- `packages/services/src/runs/run-repository.ts`
- `packages/server/src/application/agent/daemon-agent-event-projector.ts`
- `packages/server/src/application/agent/projection-settlement-recovery.ts`

**创建：**`packages/server/src/application/agent/child-task-result.ts`。

**测试：**

- `packages/services/src/runs/__test__/run-repository.test.ts`
- `packages/server/src/application/agent/__test__/daemon-agent-event-projector.test.ts`
- `packages/server/src/application/agent/__test__/projection-settlement-recovery.test.ts`

**同步说明：**`packages/services/src/runs/README.md`、`packages/server/src/application/agent/README.md`。

- [x] **1.1 写失败用例。**在真实 SessionStore 或已有投影测试夹具上使用不同的输出和错误文本：`output="构建通过；运行检查未完成"`、`error="Exceeded maximum agentic turns (2)"`。通过 `run.failed`、启动失败后的 `child.closed`、恢复重放三条路径，断言 Task 的两字段分别保存，不能只测试新增转换函数。
- [x] **1.2 补齐恢复与轮次用例。**覆盖缺少错误正文、状态和输出已相同但错误或 `childFailure` 缺失、同一事件重放两次，以及旧轮 A 未补存时新轮 B 已运行。验证 B 的状态、正文和失败信息不被 A 覆盖，A 的 Run 仍可修复。无可核实运行身份的异常记录保持可见失败，不推测成当前轮。
- [x] **1.3 将本项归入集中验收。**依用户后续要求，不单独执行修改前的失败测试；保留真实行为断言，不回退正确代码制造红灯。
- [x] **1.4 补充现有更新命令的清除语义。**`UpdateSessionTaskInput.error` 改为 `string | null`：`undefined` 表示不修改，字符串表示替换，`null` 表示删除字段。仅改变内部写命令，读取记录的 `error` 仍为可选字符串；不把 `null` 作为新的持久错误值。

在 `RunRepository.updateSessionTask` 原错误赋值处使用：

```ts
if (input.error === null) delete task.error;
else if (input.error !== undefined) task.error = input.error;
```

仓库测试至少包含：

```ts
store.updateSessionTask("task-1", { status: "failed", error: "old error" });
store.updateSessionTask("task-1", { error: undefined });
expect(store.getSessionTask("task-1")?.error).toBe("old error");
store.updateSessionTask("task-1", { error: null });
expect(store.getSessionTask("task-1")).not.toHaveProperty("error");
```

用现有持久化夹具关闭再打开临时库后，再确认字段仍缺省；不直接修改 Store 内部对象。

- [x] **1.5 抽出唯一的 Task 结果字段转换。**新文件只导出内部函数 `childTaskResultPatch`，由投影和恢复调用，不在包公开入口导出。实现形状如下：

```ts
import type { AgentChildResult } from "@vykor/agent-contracts";
import type { UpdateSessionTaskInput } from "@vykor/services";

export function childTaskResultPatch(result: AgentChildResult): UpdateSessionTaskInput {
  const childFailure = result.failureKind || result.partialResult
    ? {
        ...(result.failureKind ? { failureKind: result.failureKind } : {}),
        ...(result.partialResult ? { partialResult: result.partialResult } : {}),
      }
    : null;
  return {
    status: result.status,
    output: result.output,
    error: result.error ?? null,
    metadata: { childFailure },
  };
}
```

`childFailure: null` 利用现有 metadata 浅合并机制清除旧值；读取方按“无失败详情”处理，不扫描或批量改写历史库。

- [x] **1.6 接通正常、补偿和恢复路径。**正常终态将 `event.data.error.message` 独立传给结算；`child.closed` 使用原 `result.error`；移除 child 结果中的 `error: output` 和 `error ?? output` 回退。投影失败的补偿继续保存真实投影错误和原可信失败元数据，不把投影故障伪装成成功保存。更新恢复的字段比较，涵盖 `error` 与 `childFailure`，保证“状态及输出相同”不会漏修其余字段。
- [x] **1.7 在绑定新 Run 的既有入口清除旧失败信息。**`bindChildTask`／`bindChildTaskRun` 确认换轮后写入 `metadata: { childFailure: null }`；沿用现有运行时间、输出与错误重置。写终态前核对 `task.runId`；启动尚无 Run 的失败沿用已有启动记录路径，不凭子代理身份覆盖后来一轮。
- [x] **1.8 运行本项测试与类型检查，更新说明。**说明新增内部文件的入口和字段职责；不把 Task 升格为历史结果仓库。

```powershell
pnpm --filter @vykor/services exec vitest run src/runs/__test__/run-repository.test.ts
pnpm --filter @vykor/server exec vitest run src/application/agent/__test__/daemon-agent-event-projector.test.ts src/application/agent/__test__/projection-settlement-recovery.test.ts
pnpm --filter @vykor/services check-types
pnpm --filter @vykor/server check-types
```

**完成条件：**报告与错误分别保存；缺省错误能显式清除；重放修复原 Run 且不污染新轮；没有第二个执行状态或恢复调度器。

## 任务 2：在 Jobs 来源统一实时与归档结构

**修改：**`packages/agent-runtime/src/node/jobs/child-job-source.ts`、`packages/server/src/jobs/job-snapshots.ts`。

**测试：**修改 `packages/agent-runtime/src/node/jobs/__test__/child-job-source.test.ts`；创建 `packages/server/src/jobs/__test__/job-snapshots.test.ts`。已有 `daemon-job-service.test.ts` 作为授权与冷读取回归。

**同步说明：**`packages/agent-runtime/src/node/jobs/README.md`、`packages/server/src/jobs/README.md`、[Jobs 协议](../../jobs-protocol.md)。

- [x] **2.1 写来源契约测试，归入集中验收。**复用 `createLifecycleFixture` 的 `failure: { label, kind: "max_turns" }` 创建真实失败子运行，验证实时列表、读取和等待都出现 `metadata.childFailure`，顶层不再出现平铺的 `failureKind/partialResult`。专门归档测试使用真实临时 SessionStore，分别创建旧失败 Run 与最新成功 Run，确保请求旧 `target` 只读取旧轮数据。

关键断言使用既有 `f` 与运行回执：

```ts
const result = await f.wait(first.target);
const actual = first.handle.readRun(first.target.runId).result!;
expect(result.snapshot.metadata?.childFailure).toEqual({
  failureKind: actual.failureKind,
  partialResult: actual.partialResult,
});
expect(result.snapshot.metadata).not.toHaveProperty("failureKind");
expect(result.snapshot.metadata).not.toHaveProperty("partialResult");
expect(result.snapshot.target).toEqual(first.target);
```

- [x] **2.2 修改实时快照唯一构造点。**`snapshot(handle, run)` 将原失败字段放入 `metadata.childFailure`，继续保留 `childSessionId`、`childState`、保存与清理诊断。List／Read／Wait 复用此函数，不给三个方法各写转换。`output`、游标、输出窗口和能力计算保持原流程。
- [x] **2.3 核对并修正归档读取。**框架子运行以 `executionBackend(task) === "child_agent"` 识别，先核对所属子会话，再按 `target.runId` 取 Run。取旧轮时清掉从最新 Task 带来的失败信息和结束时间，再采用目标 Run 的值；`detail` 来自其原错误。`details.childFailure` 若保留，只使用同一规范化对象。独立进程即使 `kind: agent`，仍走原进程逻辑。
- [x] **2.4 用少量表驱动用例覆盖边界。**停止原因覆盖 `max_turns`、执行 `timeout`、普通错误、取消和未知原因；报告覆盖缺失、裁剪、版本或身份不匹配。实时可信结构原样映射，归档未知 metadata 做字段核对，消费者不采信畸形报告。只处理确定字段，不根据正文修补。新 Run 与旧 Run 各放不同文本，确认不会借用另一轮内容。
- [x] **2.5 核对来源差异的合法范围。**相同 Run 的状态、错误、原因和报告一致；`capabilities.send` 可以不同，归档必须为 false。普通等待到期仍 `running` 与 `timedOut: true`，不能写终态。正文窗口裁剪与 `partialResult.truncated` 独立保留；无效报告不删除已知停止原因或原始诊断。
- [x] **2.6 运行来源测试、类型检查并更新说明。**不在工具层增加实时／归档 fallback，不为此新增 Job 类型或状态枚举。

```powershell
pnpm --filter @vykor/agent-runtime exec vitest run src/node/jobs/__test__/child-job-source.test.ts
pnpm --filter @vykor/server exec vitest run src/jobs/__test__/job-snapshots.test.ts src/jobs/__test__/daemon-job-service.test.ts
pnpm --filter @vykor/agent-runtime check-types
pnpm --filter @vykor/server check-types
```

**完成条件：**三个观察入口返回一种失败结构；历史结果按 Run 定位；当前输入能力仍由执行入口复核。

## 任务 3：补齐真实轮次预期与父代理处理说明

**修改：**

- `packages/core/src/engine/query-engine.ts`
- `packages/tools/src/agent/agent-tools.ts`
- `packages/tools/src/job/job-tools.ts`

**测试：**

- `packages/core/src/engine/__test__/integration.test.ts`
- `packages/core/src/engine/__test__/request-configuration.test.ts`
- `packages/tools/src/agent/__test__/agent-tools.test.ts`
- `packages/tools/src/job/__test__/job-tools.test.ts`

**同步说明：**`packages/core/src/engine/README.md`、`packages/tools/src/agent/README.md`、`packages/tools/src/job/README.md`，以及[子代理流程](../../agent-child-session-flow.md)。

- [x] **3.1 在已有 Core 集成测试中补普通阶段提示用例。**复用 `QueryEngine`、`makeTool`、`allowAll`、`noopHooks` 和 `createExecutionContext`；受控模型在有工具时调用 `Loop`，无工具时输出报告。采集当次请求的 system 与 tools，而不是测试一个孤立字符串生成函数。

```ts
it("shows remaining child work rounds and reuses the reserved finalization", async () => {
  const systems: string[] = [];
  const toolCounts: number[] = [];
  let executions = 0;
  const registry = new ToolRegistry();
  registry.register(makeTool("Loop", () => { executions++; return "checked"; }));
  const client = {
    async *streamMessage(params: { system?: string; tools?: unknown[] }) {
      systems.push(params.system ?? "");
      toolCounts.push(params.tools?.length ?? 0);
      if (toolCounts.at(-1) === 0) {
        yield { type: "text_delta" as const, delta: "partial report" };
        yield { type: "complete" as const, stopReason: "end_turn" };
      } else {
        yield { type: "tool_use_start" as const, toolUse: {
          type: "tool_use" as const, id: `loop-${systems.length}`, name: "Loop", input: {},
        } };
        yield { type: "complete" as const, stopReason: "tool_use" };
      }
    },
  };
  const engine = new QueryEngine(client, registry, allowAll(), noopHooks(), {
    maxTurns: 5, trajectoryTrackerFactory: false,
  });
  await expect(async () => {
    for await (const event of engine.submitMessage("check", {
      execution: { ...createExecutionContext(), hardMaxTurns: 5 },
    })) void event;
  }).rejects.toMatchObject({ name: "MaxTurnsExceeded", finalizationText: "partial report" });
  expect(systems.map(value => value.match(/含当前轮还剩 (\d+) 轮/)?.[1]))
    .toEqual(["5", "4", "3", "2", undefined]);
  expect(toolCounts).toEqual([1, 1, 1, 1, 0]);
  expect(executions).toBe(4);
  expect(JSON.stringify(engine.getHistory())).not.toContain("含当前轮还剩");
});
```

此用例的调用数断言只对应正文很短、未触发压缩且没有网络重试的受控路径，不作为所有底层请求的预算定义。`trajectoryTrackerFactory: false` 避免轨迹收尾干扰本次轮次验收。

- [x] **3.2 补配置和终止回归，归入集中验收。**覆盖有效上限为 1、没有硬上限、上限前自然完成、请求配置上调仍受硬上限约束、收紧后按新有效额度提示、收尾出错无报告。复用现有取消和收尾禁用工具测试，保留原停止语义。
- [x] **3.3 在当轮提示组装点接入。**应用请求配置和判断收尾后，仅在 `hardMaxTurns !== undefined && !forcedFinalTurn` 时，用 `maxTurnsLimit() - turnCount` 生成普通工作提示，再通过现有 `appendSystemGuidance` 拼接。收尾沿用 `CHILD_FINALIZATION_PROMPT`。不向 `this.messages` 写提示，不保存新计数，不改网络重试循环。
- [x] **3.4 验证重试与压缩的计数边界。**在现有模型重试测试模式中制造同一普通轮的一次可重试网络失败，确认重试冻结同一请求、提示次数不递减，随后工作轮再递减；复用已有压缩回归，并用 3.1 的真实历史断言确认预算提示没有进入长期历史，不另造压缩夹具。现有压缩、网络重试请求不被纳入“5 轮”总请求断言。
- [x] **3.5 更新 Agent 参数说明。**明确 `maxTurns` 是本轮工作循环上限、只能收紧配置、最后一轮只收尾；保留参数验证和运行时预算解析。说明变更不复制一套 `resolveChildMaxTurns`。
- [x] **3.6 为 JobRead／JobWait 摘要补失败用例。**在现有 `executeJob`／`context` 夹具中注入规范化子运行快照，断言读取成功、原 JSON 保留、摘要包含完整 `runId`、停止分类和报告可用性，但没有报告正文。未知原因、无效报告、独立进程和运行中等待到期不误报为预算未完成。

在现有 Jobs 工具测试中使用以下快照；报告采用匹配的子会话和运行身份：

```ts
const childSnapshot = {
  ...snapshot,
  id: "child-1",
  kind: "agent" as const,
  target: { kind: "agent" as const, jobId: "child-1", runId: "run-1" },
  status: "failed" as const,
  metadata: {
    childSessionId: "child-session",
    childFailure: {
      failureKind: "max_turns",
      partialResult: {
        version: 1, childSessionId: "child-session", runId: "run-1",
        source: "limit_finalization", text: "private partial report", truncated: false,
      },
    },
  },
};
const read = vi.fn(async () => ({
  text: "private partial report", cursor: 22, truncated: false,
  snapshot: childSnapshot,
}));
const result = await executeJob("JobRead", { target: childSnapshot.target }, context({ read }));
expect(result.isError).not.toBe(true);
expect(result.executionState).toBe("completed");
expect(result.compactSummary).toContain("failureKind=max_turns");
expect(result.compactSummary).toContain(`runId=${childSnapshot.target.runId}`);
expect(result.compactSummary).toContain("partialResult=available");
expect(result.compactSummary).not.toContain("private partial report");
expect(payload(result)).not.toHaveProperty("outcome");
```

- [x] **3.7 扩充现有摘要事实和工具说明。**只读取 `metadata.childFailure`，在当前 `result()` 摘要路径增加可信枚举、完整运行标识及 `partialResult=available/none`；该文本标记不成为新协议字段。完整 JSON 仍由原来源返回。List 从已有 `jobs`、Read 从 `snapshot`、Wait 从 `results` 提取同一种摘要事实，不为摘要再次查询来源；补一个 List 摘要用例。摘要继续最多 8 项、长度最多 1,000 字符，放不下时省略完整项并计数，不能截断 ID。读取失败子任务仍为成功观察，不产生工具重试。
- [x] **3.8 说明处理顺序并验证。**工具说明引导“阅读报告 → 对照委派要求说明证据与缺项 → 在已有授权内决定接手或继续”。只有当前 `capabilities.send` 支持时才能向原目标发送输入，接纳后改用新回执；不返回动态动作或自动分派。保留既有参数校验与预算接纳回归；新增摘要测试验证完整工具调用，不单独为说明文案增加字符串快照测试。

```powershell
pnpm --filter @vykor/core exec vitest run src/engine/__test__/integration.test.ts src/engine/__test__/request-configuration.test.ts src/engine/model/__test__/model-retry.integration.test.ts
pnpm --filter @vykor/tools exec vitest run src/agent/__test__/agent-tools.test.ts src/job/__test__/job-tools.test.ts
pnpm --filter @vykor/core check-types
pnpm --filter @vykor/tools check-types
```

**完成条件：**提示与执行共用真实轮次；收尾没有额外轮次；工具返回事实与简短指导，压缩摘要不丢停止原因或运行身份。

## 任务 4：桌面三个入口共用一种展示解释

**修改：**

- `apps/desktop/src/renderer/src/components/desktop/tools/agents/agent-task-model.ts`
- `apps/desktop/src/renderer/src/components/desktop/tools/agents/agents-tool.tsx`
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/activity/agent-activity-message.tsx`

**测试：**

- `apps/desktop/src/renderer/src/components/desktop/tools/agents/__test__/agent-task-model.test.ts`
- `apps/desktop/src/renderer/src/components/desktop/tools/agents/__test__/agents-tool.test.tsx`
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/activity/__test__/agent-activity-message.test.tsx`

**同步说明：**`apps/desktop/src/renderer/src/components/desktop/tools/agents/README.md`、`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/activity/README.md`；先阅读 `apps/desktop/DESIGN.md` 和桌面目录约定，复用现有组件。

- [x] **4.1 在现有模型测试中先定义展示契约。**新增 `agentTaskPresentation(task)`，只接收完整 `DesktopSessionTask`，返回本次渲染计算结果，不写 Store。字段限定为：

```ts
interface AgentTaskPresentation {
  label: string;
  tone: "neutral" | "warning" | "error";
  reason?: string;
  hasPartialReport: boolean;
}
```

使用现有 `task(id, status, input)` 测试工厂，覆盖下表；原因和报告有效性分别判断，无报告仍可显示预算未完成。

| 输入 | 核心断言 |
| --- | --- |
| 当前失败 Run，`max_turns`，有效报告 | `label="未完成 · 已达轮次上限"`、warning、报告可用 |
| 当前失败 Run，执行 `timeout`，无报告 | 时间上限说明、warning、报告不可用 |
| 普通失败或未知分类，有报告 | 执行出错、error；报告不改变分类 |
| 非对象 metadata、空报告、错版本或错 Run／会话 | 不崩溃、不承诺报告可用；可信停止原因仍保留 |
| running／completed，残留旧轮 metadata | 当前状态优先，不展示旧预算失败或旧报告 |
| stopped／interrupted | 沿用对应标签与既有样式语义，不改成预算失败 |
| 旧记录含长错误与报告混合 | 顶层只显示通用简短说明，原记录可展开 |

- [x] **4.2 补活动行、列表和详情的行为失败测试。**同一 Task 在三个入口都显示相同预算原因；切为新 Run 后原组件更新为运行中，再正常完成。点击仍能打开原子会话；尚未收到 Task 时仍为“已派出”，派出失败仍为“启动失败”。保留 `needs_input` 对活跃任务的“等待处理”，不改订阅生命周期。
- [x] **4.3 实现展示函数并纳入集中验收。**只读取本轮嵌套失败字段，校验报告版本、source、文本与身份，集中计算 label、tone 和短原因。保留分组、计时及现有订阅函数；不引入新的前端生命周期状态。
- [x] **4.4 替换三个入口的重复判断。**列表和详情使用展示函数；活动行有 Task 时复用它，无 Task 时保留派出状态映射。技术错误放在已有详情区域或原生可展开区域，报告由子会话正文呈现；tooltip 使用短原因，不能使用完整 `task.error`。组件不解析报告中的 PASS 或构建结论，也不新增 Jobs 查询。
- [x] **4.5 运行行为测试与 renderer 类型检查，更新说明。**仅验证文案、链接、展开行为、状态更新和错误样式选择。样式由用户实际查看反馈，不启动浏览器预览或截图。

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/tools/agents/__test__/agent-task-model.test.ts src/renderer/src/components/desktop/tools/agents/__test__/agents-tool.test.tsx src/renderer/src/components/desktop/conversation-page/message/activity/__test__/agent-activity-message.test.tsx
pnpm --filter @vykor/desktop typecheck:web
```

**完成条件：**三个入口的同一 Task 同义展示；预算、错误、中断和等待没有混类；既有打开会话与动态更新行为保持。

## 任务 5：用真实链路验收并收尾

**修改测试：**`tests/agent-integration/__test__/child-run-settlement.integration.test.ts`。

**复用夹具：**`tests/agent-integration/__test__/fixtures/task-lifecycle-fixture.ts`，不增加测试模式、宿主注入接口或新的夹具文件。

**同步说明：**`tests/agent-integration/README.md`、[子代理流程](../../agent-child-session-flow.md)、[Jobs 协议](../../jobs-protocol.md)、[文档入口](../../README.md)与本计划执行状态。

- [x] **5.1 增加一条贯通用例。**真实默认工厂、Kernel、QueryEngine、工具、daemon 投影和临时 SQLite 全部参与；仅替换模型网络响应。下面用例放入现有测试文件，使用其已有导入：

```ts
it("keeps budget feedback pinned across followup and archive", async () => {
  const f = await createLifecycleFixture("daemon", {
    failure: { label: "budget-feedback", kind: "max_turns" },
  });
  try {
    const first = await f.spawn("budget-feedback");
    await first.handle.waitRun(first.target.runId);
    const live = await f.wait(first.target);
    const actual = first.handle.readRun(first.target.runId).result!;
    expect(actual.failureKind).toBe("max_turns");
    expect(live.snapshot.metadata?.childFailure).toEqual({
      failureKind: actual.failureKind, partialResult: actual.partialResult,
    });
    const saved = f.store!.runs.getSessionTask(first.handle.id)!;
    expect(saved.output).toBe(actual.output);
    expect(saved.error).toBe(actual.error);
    expect(saved.error).not.toBe(saved.output);
    expect(f.modelCalls("budget-feedback")).toBe(2);

    f.hold("remaining-checks");
    const receipt = await f.send(first.target, "remaining-checks");
    const next = { ...first.target, runId: receipt.runId };
    expect(next.runId).not.toBe(first.target.runId);
    await f.entered("remaining-checks");
    const current = f.store!.runs.getSessionTask(first.handle.id)!;
    expect(current).toMatchObject({ runId: next.runId, status: "running" });
    expect(current.error).toBeUndefined();
    expect(current.metadata.childFailure ?? null).toBeNull();
    await f.redeliverTerminal(first.target.runId);
    expect(f.store!.runs.getSessionTask(first.handle.id)?.runId).toBe(next.runId);
    expect((await f.read(first.target)).snapshot.metadata?.childFailure)
      .toEqual(live.snapshot.metadata?.childFailure);

    f.release("remaining-checks");
    const continued = await f.wait(next);
    expect(continued.snapshot).toMatchObject({ status: "failed", metadata: { childFailure: {
      failureKind: "max_turns", partialResult: { runId: next.runId, childSessionId: first.handle.sessionId },
    } } });
    expect(f.modelCalls("remaining-checks")).toBe(2);
    await first.handle.close();
    const archived = await f.read(first.target);
    expect(archived.snapshot.target).toEqual(first.target);
    expect(archived.snapshot.detail).toBe(live.snapshot.detail);
    expect(archived.snapshot.metadata?.childFailure).toEqual(live.snapshot.metadata?.childFailure);
    expect(archived.text).toBe(live.text);
    expect(archived.snapshot.capabilities.send).toBe(false);
    await expect(f.send(first.target, "cannot-send-to-archive")).rejects.toThrow();
    expect(f.modelCalls("budget-feedback")).toBe(2);
  } finally {
    await f.close();
  }
});
```

- [x] **5.2 扩展既有保存失败原因表，不复制整条链。**在现有 `preserves identical live, terminal-event and recovered ... output` 用例中，增加 Task 与 Run 的错误断言和嵌套失败信息断言；保留 `completed/failed/max_turns/timeout/user_cancelled` 表、恢复重放与调用次数检查。确认补存和重复观察没有再调用模型或重复工具。
- [x] **5.3 先运行新增用例，再运行完整相关集成文件。**若较早任务已修复该用例覆盖的缺口，可直接通过；不回退正确实现制造失败。保留 SDK／daemon 的既有真实停止、能力、旧轮与来源回归。

```powershell
pnpm exec vitest run --config tests/agent-integration/vitest.config.ts tests/agent-integration/__test__/child-run-settlement.integration.test.ts -t "keeps budget feedback pinned"
pnpm exec vitest run --config tests/agent-integration/vitest.config.ts tests/agent-integration/__test__/child-run-settlement.integration.test.ts tests/agent-integration/__test__/shared-job-composition.integration.test.ts
```

- [x] **5.4 进行一次定向整体复核。**逐项检查报告与错误是否仍有赋值混用、工具是否兼容探测多个来源形状、界面是否仍独立按 failed 决定预算文案、续做是否使用新回执。只修与此次目标直接相关的问题。保留普通进程、未知失败和读取异常的原规则。
- [x] **5.5 执行最终仓库检查。**以下命令应无错误；若边界检查因新内部文件失败，修正导入归属，不放宽门禁。此前各任务已通过且后续未影响的类型与单元测试不反复全量重跑。

```powershell
node scripts/architecture-boundaries.mjs
pnpm check:retired-ui
pnpm check-docs
git diff --check
```

- [x] **5.6 同步实际状态与交付证据。**在各主题手册只记录已实现行为，入口连接设计与计划。执行记录列出实际命令、退出结果、覆盖范围和未验证项目；不以通过文档检查声称代码或模型行为通过。不自动提交其他任务文件或用户未跟踪内容。

**完成条件：**真实轮次耗尽经过保存、观察、显式续做与归档都能正确定位；恢复不重放执行；对应手册及代码检查一致。

## 真实模型行为验收

上述离线测试证明数据与流程，不证明模型会遵循说明。真实模型验证沿用已有费用和执行授权，未执行时必须记录“模型行为未验证”，不能标成已经全部验证。

- [ ] 在原任务的可复现副本中，以只读验证子代理和 `maxTurns: 5` 运行构建及正确性检查；保存实际 Agent 回执、各工作轮次预算提示、终态、JobWait 返回及主代理最终回复。
- [ ] 对照委派要求记录：子代理是否在额度内优先取得证据；若达到上限，主代理是否明确区分通过项、尚未检查事项和停止原因；是否避免把构建通过当成全部验证通过。
- [ ] 若原页面副本不可取得，使用明确写有“构建、语法与额外运行检查”的临时样例，并标注为替代场景；若提前自然完成，如实记录，不把它当预算耗尽场景的证据。
- [ ] 用户在实际桌面查看活动行、列表及详情，反馈短原因、报告入口和错误展开是否清楚。此项由用户检查，不自动生成样式预览或截图。

真实模型未充分解释缺项时，先记录实际输入输出并检查说明是否清晰；不能在此次验收中直接增加自动续跑、强制业务状态或无限重试。

## 设计要求与验收位置

| 修订设计要求 | 实施与验证位置 |
| --- | --- |
| 循环有界、剩余轮次、已有收尾 | 任务 3 的 Core 集成、请求配置及模型重试回归 |
| 输出与错误分离、补存、重放、新轮清理 | 任务 1 的 Repository／投影／恢复测试，任务 5 保存失败原因表 |
| 同形来源、旧轮定位、能力差异、部分报告 | 任务 2 的实时与归档测试，任务 5 的贯通用例 |
| 成功观察失败子任务、等待无副作用、摘要有界 | 任务 3 的 Jobs 工具测试及任务 2 来源回归 |
| 活动行、列表、详情一致且不解析报告正文 | 任务 4 模型与组件行为测试 |
| 主代理说明缺项、用户能理解展示 | 真实模型行为验收；与离线程序检查分别报告 |

计划只新增一个内部生产转换文件和一个归档测试文件。其余沿用原入口和现有测试环境；不要求为了“架构完整”再建立通用结果层、观察缓存或组件体系。

## 实施记录（2026-10-28）

### 范围与调整

- 在原检出目录的 `codex/child-budget-feedback` 分支实施；保留原有设计与计划修改，未改动未跟踪的 `plugins/`。编码验收阶段未提交、推送或合并，也未创建额外 worktree；后续集成按用户的明确授权执行。
- 按用户要求先完成编码，再集中执行测试；未进行逐步骤 RED／GREEN，不将测试夹具修正描述成生产行为修复。
- 结果转换只有一个新的内部文件；归档规范化复用原文件的 readChildFailure。没有新增预算计数器、业务状态、动作协议、自动续跑、依赖或数据库迁移。
- 贯通用例原先断言续做正常完成，与夹具保留的 2 轮上限矛盾：读取占普通轮后，下一轮仍须无工具收尾。用例现验证新轮独立的 max_turns 原因、报告身份及调用次数，不扩大上限；自然提前完成与普通多轮复用由已有回归覆盖。

### 编码与复核结果

- 正常终态、启动失败和恢复分开保存 output／error；任务更新以 error:null 显式清除旧值；恢复比较包含错误与失败元数据。
- 新轮清除旧 childFailure。旧轮补偿传入原 runId，迟到的创建补偿在任务绑定其他轮次时整段退出，包含路由注销与归档副作用。child.closed 的父上下文不能作为子 Run 身份。
- 实时 List／Read／Wait 使用嵌套失败结构；归档 List 与按 Run 读取共用报告校验，过滤畸形、错版本及跨轮报告并保留可信原因。快照与 details 使用同一规范化结果。
- Core 的当轮提示共用有效上限和 turnCount，重试冻结同轮提示；工具摘要保留完整运行身份、原因及报告可用性。桌面活动行、列表和详情复用同一个展示函数，原始错误可展开。
- 一次独立定向审查发现旧轮补偿副作用与归档校验两项实质问题，已修复并复核关闭；审查者未修改代码或重复运行测试。

### 自动化证据

下表按各文件的最终有效结果计数，不将重跑或门禁脚本重复计入。合计 **317 项**，不是整个仓库的全量测试。

| 范围 | 文件数／通过数 | 实际验证 |
| --- | --- | --- |
| Services | 1／9 | RunRepository 显式清错、持久化与原有记录操作 |
| Core | 3／113 | 循环与请求配置两文件 90 项通过；重试文件修正上下文夹具后最终 23 项通过 |
| Tools | 2／55 | Agent 参数与 Jobs 观察、摘要、窗口、来源和畸形报告 |
| Runtime | 1／3 | 真实子运行的列表、读取、等待及旧轮／并发接纳 |
| Server | 4／56 | 最终四文件联合运行通过，覆盖投影、重放、迟到创建、归档与授权读取 |
| Desktop | 3／42 | 展示模型、活动行和真实组件行为；未运行样式预览 |
| 跨包集成 | 2／39 | 最终完整 child-run-settlement 与 shared-job-composition 联合运行通过 |

模块命令见各任务。跨包最终执行：

```powershell
pnpm exec vitest run --config tests/agent-integration/vitest.config.ts tests/agent-integration/__test__/child-run-settlement.integration.test.ts tests/agent-integration/__test__/shared-job-composition.integration.test.ts --reporter=dot
```

跨包首次运行的 38／39 中，唯一失败为上述续做预期；修正后先定向 7／7，再以最终代码完整运行 39／39。Windows 原生 PTY 的附属清理进程输出了 AttachConsole failed；两个测试文件及主进程退出码仍为 0，该输出保留为环境诊断，本次未修改 Terminal 代码。

以下类型检查全部退出 0：

```powershell
pnpm --filter @vykor/services check-types
pnpm --filter @vykor/core check-types
pnpm --filter @vykor/tools check-types
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/agent-runtime check-types
pnpm --filter @vykor/desktop typecheck:web
```

架构边界通过，sessionStoreFlatCalls 仍为 103，新增例外为 0；退役引用检查、文档检查和差异格式检查通过。未调用付费模型；真实模型行为与用户实际样式验收保持上方未勾选状态。

### 合并前复核（2026-10-28）

- 用户要求复核复杂度，无实质问题后合并 main 并推送。独立审查确认现有结果映射和边界校验足够小，无须增加跨层公共解析接口、状态或策略层。
- 审查发现缺少 runId 的事件仍能通过补偿覆盖已绑定运行中的任务。两条真实投影与重启恢复回归先复现状态和进度被覆盖；随后统一结算入口严格匹配任务与事件身份，恢复补偿移除缺省身份通配，已核对的创建补偿显式传入原身份。
- 修改后四个相关 Server 文件联合验证 **58／58**；独立复核确认该阻塞项关闭，未发现其他实质问题。此前 317 项统计保留为编码阶段证据，本轮新增上述 2 项回归。
- 提交保留仓库原有类型检查钩子；合并结果继续检查相关集成、架构、文档、退役引用和差异格式。真实模型与实际样式仍未验证。
