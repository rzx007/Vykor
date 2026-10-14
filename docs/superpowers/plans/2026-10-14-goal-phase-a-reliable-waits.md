# Goal A 阶段实现计划：可靠等待与停止原因

> **面向 AI 代理的工作者：** 使用 `executing-plans` 顺序执行；需要用户授权的子代理实施时使用 `subagent-driven-development`，逐任务检查。步骤以复选框记录。用户实施指令优先：集中测试与一次集中审查、定点复核，不逐任务设置审批或提交。
> 日期：2026-10-14。源码基线：`04eea243ecce37f0ace914c8a63076085d302adc`。
> 状态：A 已实施；集中审查两项问题已修正并定点复核。交付记录见 [实施审查](../reviews/2026-10-14-goal-phase-a-implementation-review.md)。
> 执行调整：A1 确认新增用例先失败；A2–A6 的逐任务红灯运行按用户指令并入集中回归，不声称各自先跑失败。示例保留为设计依据，实际命令和结果以交付记录为准。
> 修订：用户明确不兼容旧数据；删除旧格式转换、升级接管和旧请求回放分支，只维护当前契约。
> 依据：[Goal spec](../specs/2026-10-14-goal-reliability-and-budget-design.md) · [分阶段路线](./2026-10-14-goal-improvements-roadmap.md)。
> 审查：[A 阶段计划审查记录](../reviews/2026-10-14-goal-phase-a-plan-review.md)。

**目标：**让 Goal 等待具体、可信的工作，任务结束后只恢复一次；暂停、取消、错误和额度停止有明确原因。

**架构：**GoalRepository 保存字段与事务，Runtime 捕获每次 Run 的可信身份，projector 把身份存进 Run metadata。WaitVerifier 只读核验；observer 退避观察；SessionGoalService 统一接纳等待结果，复用 RunAdmission/RunControl 和原队列。

**技术栈：**TypeScript、Vitest、SQLite / Drizzle、现有 Agent Runtime、React Desktop。

## 1. A 的范围与冻结决策

- 交付 objectiveVersion、stopReason、root/Child Run 绑定、targetRunId 等待、等待恢复事务、原因展示。
- 不加入 preparing/ready、requirements 表、GoalRead、Token 账本/门禁、stagnationCount、独立 Critic、通用工作流或新 UI 页面。A 仍使用现有逐项评估与同阻塞三轮规则。
- objectiveVersion 初值 1。实际正文内容变了才 +1；暂停、取消、恢复、次数修改和相同正文重提不增正文版本。用户编辑即使同文，也沿用现有先停再提交流程，但不伪造版本变化。
- revision 继续给用户命令和状态写事务防并发覆盖。运行资格/评估正文身份使用 goalId/objectiveVersion/runId，不把状态 revision 当正文版本。
- 等待绑定必须到当次 Run，不能把 agentId/sessionId/taskId 当成替代 Run。模型从现有 Job 结果的 activity.runId 或 AgentInputReceipt 取得 Run ID；无可靠 Run ID 时报告 wait_invalid，不建立新“猜最新任务”解析服务。
- 唯一运行意图仍使用现有 continuation 表与前一工作标识，统计自动次数仍在真正 start 时发生。
- 只支持当前格式新建的 Goal/Run/请求/等待；不转换、回填或接管此前格式的数据，不增加字段别名、双读、旧快照回放或兼容测试。当前格式内的重复请求、版本更替、失败重试和重启恢复仍是必需能力。
- 本文所有路径以仓库根目录为起点。新增函数/类型在对应任务明确命名；生产代码只新增一份小型原因文案文件，行为逻辑和少量接口放在现有模块。

## 2. 文件责任清单

| 任务 | 文件 | 责任 |
| --- | --- | --- |
| A1 | `packages/protocol/src/session-goals.ts`；`packages/services/src/session-runtime/schema.ts`；`packages/services/src/goals/goal-records.ts`、`goal-repository.ts`、`goal-transactions.ts` | Goal 字段、版本递增、原因 JSON、快照；单一当前协议 |
| A1 | `packages/services/src/session-runtime/migrations/0000_current_schema.sql`、`meta/0006_snapshot.json`；`packages/services/src/database/__fixtures__/current-schema-inventory.json` | 同步现行初始化 SQL、当前 ORM snapshot 与结构 inventory；不新增旧数据转换迁移 |
| A2 | `packages/server/src/application/session/session-goal-service.ts`、`run-admission-service.ts`、`session-run-executor.ts`；`packages/agent-runtime/src/agent.ts`、`framework-agent-run.ts`、`goal-extension.ts`、`goal-assessment-tool.ts`；`packages/server/src/application/session/goal-assessment-policy.ts`；projector | 根运行版本从接纳传到评估/证据校验 |
| A3 | `packages/core/src/types/runtime-child.ts`；`packages/agent-runtime/src/child-agent.ts`、`agent.ts`、`framework-agent-run.ts`；`packages/server/src/application/agent/daemon-agent-event-projector.ts`、`live-child-agent-directory.ts`；`packages/services/src/runs/run-repository.ts`；run-control/assembly | 每次新子 Run 的父身份、取消信号、按 Run 中断与后代清理；不改变 AgentChildInput 的模型输入权限 |
| A4 | `packages/protocol/src/session-goals.ts`、assessment tool；`packages/server/src/application/session/goal-wait-verifier.ts`；`packages/server/src/application/daemon-application.ts` | 等待数据、可信绑定、持久核验，移除 liveChildren 判断 |
| A5 | `packages/server/src/application/session/goal-external-wait-observer.ts`、`session-goal-service.ts`、`run-admission-service.ts`；`packages/services/src/goals/goal-transactions.ts` | 观察结果回到 Goal 服务；唯一事务、开跑复查、失败恢复 |
| A6 | goal service/transactions、`packages/server/src/application/session/run-control-service.ts`；`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/goal-banner.tsx`；新增同目录 `goal-stop-reason-label.ts` | 写结构化原因；原 Banner 显示与操作 |
| A7 | 已有相关测试、`packages/client/src/types/index.ts` / `index.ts` 的必要类型导出、`docs/session-goals-design.md` | 单一类型出口、回归、交付文档 |

当前结构链的最后 snapshot 是 0006；实施期间若其他任务更新了当前结构，先核对最新 snapshot，再同步现行初始化 SQL 与结构快照，不覆盖其他任务字段。本计划不新增 0007 Goal 兼容迁移，不改造全库初始化框架。

## 3. A1：Goal 字段、正文版本与持久/临时一致性

**测试文件：**`packages/services/src/goals/goal-repository.test.ts`、`goal-transactions.test.ts`；`packages/services/src/database/session-database.test.ts`、`temporary-control-records.test.ts`。

- [x] **补失败与恢复回归。** 复用该文件已有 withRepository fixture，在 repository 测试中加入：

```ts
it("changes objectiveVersion only when objective changes", () => {
  withRepository((repository) => {
    const first = repository.insertGoal({
      id: "versioned", sessionId: "s1", objective: "finish", maxAutoTurns: 2,
    });
    expect(first.objectiveVersion).toBe(1);
    const paused = repository.updateGoalRevision(first.id, {
      expectedRevision: first.revision, status: "paused",
      stopReason: { code: "user_paused", at: 100 },
    });
    expect(paused.objectiveVersion).toBe(1);
    const same = repository.updateGoalRevision(first.id, {
      expectedRevision: paused.revision, objective: "finish",
    });
    expect(same.objectiveVersion).toBe(1);
    const edited = repository.updateGoalRevision(first.id, {
      expectedRevision: same.revision, objective: "finish and verify",
    });
    expect(edited.objectiveVersion).toBe(2);
    expect(edited.revision).toBe(same.revision + 1);
  });
});
```

- [x] **确认失败。** 根目录运行：`pnpm --filter @vykor/services exec vitest run src/goals/goal-repository.test.ts -t "changes objectiveVersion"`。预期新增断言因字段不存在失败。
- [x] **实施最小字段。** SessionGoal 增 required objectiveVersion 与 optional stopReason；GoalStopReason 为 `{code, at, runId?, detail?}`，code 使用 spec §5.2 的枚举。store input 增 `stopReason?: GoalStopReason | null`；不向模型开放写原因的字段。

```ts
// GoalRepository 的统一更新计算；上下文为现有 current/input。
const objective = input.objective ?? current.objective;
const objectiveVersion = current.objectiveVersion
  + (objective !== current.objective ? 1 : 0);
const stopReason = input.stopReason === undefined
  ? current.stopReason : input.stopReason ?? undefined;
```

Schema 增 `objective_version INTEGER NOT NULL DEFAULT 1` 与 `stop_reason_json TEXT`。Row converter、insert/update、temporary map row 与状态事件快照同步变化；不得在数据库与 memory 使用不同字段默认值。更新 stopReason=null 才清除，省略表示保留。

- [x] **同步当前新库结构。** 修改 schema.ts 后直接同步现行初始化 SQL 中 session_goal 的定义，以及当前 ORM snapshot；保留本次以外的表、字段与初始化步骤。不生成旧 Goal/请求/评估/等待/Run 的转换 SQL，不扫描旧库、不归档旧快照、不回填旧用量。不符合当前结构或契约的数据不进入执行；格式错误按现有错误路径明确返回，不自动重建或删除实际数据库。
- [x] **覆盖真实回归。** 从空数据库初始化当前结构，创建当前格式 Goal 后关闭重开仍保留新字段，不重置版本/次数/原因。用已有 failGoalEvent fixture 验证 update + 新字段回滚。memory 模式抛异常后 row 回滚且 SQLite 无对应临时 Goal；不为这个任务修改 TemporaryControlRecords 的结构。不测试旧数据升级或旧请求转换。
- [x] **合并验证完成（保留建议提交单元）。** `pnpm --filter @vykor/services exec vitest run src/goals/goal-repository.test.ts src/goals/goal-transactions.test.ts src/database/session-database.test.ts src/database/temporary-control-records.test.ts`；`pnpm --filter @vykor/services exec node scripts/update-schema-inventory.mjs` 后重跑 schema inventory 对应测试。若失败修复，不改预期掩盖不一致。

## 4. A2：根 Run 与评估使用正文版本

**测试文件：**`packages/protocol/src/session-goals.test.ts`；`packages/agent-runtime/src/goal-assessment-tool.test.ts`；`packages/server/src/application/session/__test__/session-goal-service.test.ts`、`run-admission-service.test.ts`；现有 projector 测试。

- [x] **补工具绑定回归。** 在已有 goal-assessment-tool.test.ts 使用其 vi / createGoalAssessmentTool 导入，确认宿主版本实际进入事件，不只检查 parser 对未知字段的对象展开：

```ts
it("emits the host objective version", async () => {
  const emit = vi.fn(async () => undefined);
  const result = await createGoalAssessmentTool({
    goalId: "g1", objectiveVersion: 2,
  }).execute({
    decision: "continue", progress: "checking",
    progressAssessment: { kind: "no_progress", summary: "no result", blockerKey: "missing" },
    evidence: [], nextStep: "read output",
  }, {
    cwd: process.cwd(), sessionId: "s1",
    agent: { emit, scope: { runId: "r1" } } as never,
  });
  expect(result.isError).not.toBe(true);
  expect(emit).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ payload: expect.objectContaining({
      goalId: "g1", objectiveVersion: 2, runId: "r1",
    }) }),
  }));
});
```

> 原计划的单独红灯命令已并入集中验证；未单独执行该步。
- [x] **连通单一绑定。** GoalAssessment、GoalEvidenceRef、GoalRunBinding 使用 objectiveVersion 取代运行绑定中的 revision；模型没有设置宿主身份权限。Run metadata 使用 `goalId / goalObjectiveVersion / goalRunKind`，不双读 goalRevision。service.runInput、admission、executor、agent submit options、framework goal contribution、assessment tool、projector 与证据 policy 一次连通。

```ts
// 写入 root Run metadata；revision 留给状态写入和请求去重。
const binding = { goalId: goal.id, goalObjectiveVersion: goal.objectiveVersion };
// 评估接纳条件还需 run.status=running、!goalSettled、goal active、当前 Run 匹配。
const sameObjective = run.metadata.goalId === goal.id
  && run.metadata.goalObjectiveVersion === goal.objectiveVersion;
```

projector 接收模型评估事件时检查 run.status=running；settleRun 结算时必须检查 Run 已是 completed/failed/interrupted。两处时机相反，不能把上面的接收条件照抄到终态结算。

`startGoalRun` 改为 `(goalId, objectiveVersion, runId, automatic)`，Repository.bindCurrentRun 仍使用该事务读到的 current.revision 作 SQL 条件，不能拿 objectiveVersion 替代 revision 列。continuation 表的 revision 仍记录当次状态版本用于审计/唯一意图，不属于模型绑定；recordGoalAssessment 的 JSON 包含正文版本。

- [x] **防止 currentRun 被先清后验。** settleRun 先读取并验证 Goal.currentRunId === runId，再在同一事务 finishGoalRun 与标记 goalSettled。重复结算不创建续跑；禁止先清 currentRunId 后接受任意同版本旧 Run。恢复/取消仍通过 active 状态、currentRunId 与 Run 终态保护，不能仅核对正文版本。
- [x] **当前格式恢复。** 仅测试新契约保存的 Goal、Run、Input 和请求：重启按现有活动目标暂停/等待观察规则处理；重复 create/update/action 对账仍复用原接纳身份，不额外派发。缺少 goalObjectiveVersion 的运行绑定直接判无效，不从当前正文或其他字段猜版本，不新增扫描、暂停、接管旧运行的启动分支。
- [x] **行为回归。** 在 service 已有 harness 中测试状态 revision 增长但正文/currentRun 未变的合法评估可结算；旧正文版本/错误 Run/暂停目标评估拒绝；用户消息优先、次数真正开跑计数、replay 去重保持。tool 单测确认 emitted payload/evidenceRefs 为宿主版本。普通 Run 不注入 Goal 工具。
- [x] **合并验证完成（保留建议提交单元）。** `pnpm --filter @vykor/protocol exec vitest run src/session-goals.test.ts`；`pnpm --filter @vykor/agent-runtime exec vitest run src/goal-assessment-tool.test.ts`；`pnpm --filter @vykor/server exec vitest run src/application/session/__test__/session-goal-service.test.ts src/application/session/__test__/run-admission-service.test.ts`。

## 5. A3：逐 Child Run 捕获可信父身份

**测试文件：**`packages/agent-runtime/src/child-agent.test.ts`、`plugin-child-followup.test.ts`、`agent-post-run-child.test.ts`；`packages/server/src/application/agent/__test__/daemon-agent-event-projector.test.ts`。

- [x] **补复用回归。** 使用现有 ChildManager fixture，第一次由父 Run P1 spawn，等其结果终态；由 createController(P2, 同一合法 capabilityView) 的 sendChildInput 开第二 Run。断言两个 run.started.context.parentRunId 分别为 P1/P2；初始 childId/sessionId 不变。再加 queued followup：在 P2 调用时捕获身份，即使真正开跑时根会话已进入 P3，也不得绑定 P3。同父 steer 不换绑定；不同父的默认 steer 必须转排队新 Run，不能把 P2 工作合进 P1。测试使用现有事件收集器和完整生命周期，不只测试赋值函数。
> 原计划的单独红灯命令已并入集中验证；未单独执行该步。
- [x] **实施内部参数。** 在 child-agent.ts 新建仅宿主内部的 TrustedChildRunParent，复用 AgentRunScope 的 sessionId/runId；createController 闭包将当次父 scope 传到 send/sendToRecord/beginRun。spawn 首轮传其创建 scope；不修改模型可传的 AgentChildInput，不从 input.metadata 读 goalId/parentRunId。

```ts
export type TrustedChildRunParent = Pick<AgentRunScope, "sessionId" | "runId" | "signal">;
// 在 VykorAgentSubmitOptions 增加；agent 构造本次 FrameworkAgentRun.identity：
// childRunParent?: TrustedChildRunParent | null
// null 表示宿主没有为这次跟进提供父 Run，不能回退到创建时的旧父 Run。
// beginRun 从本次 send 捕获参数传递；steer 不改正在运行的绑定。
```

agent.ts 为新 FrameworkAgentRun 构造 identity 时保持 childId，使用本次 childRunParent 的 parentSessionId/parentRunId；signal 只留在 Runtime 内，绝不写入事件或持久 JSON。直接 handle.send 或 Desktop 向 idle 子会话发消息，没有可信父 scope 时明确传 null，不归入旧 Goal；现有 plugin 授权仍执行，不把“没有父身份”当绕过插件权限。只有捕获的 sessionId/runId 与当前 Child Run 的父身份相同才允许 steer；身份不同或缺少身份时，按 queue 新 Run 处理，并保留原 capability/plugin 校验。

同一 input.id 的去重记录同时保存本次父身份，重复相同请求复用原 receipt；相同 ID 配不同父身份拒绝，避免取走另一次委派的归属。异步排队使用 captured 参数，不修改共享 record.parentScope 来影响所有旧 Run 或创建事件。

- [x] **持久投影。** startRun 的创建、已有 pending Run、重放已投影 Run 三条路径均核对本次可信 parentRunId。读取父 Run 的持久 goalId/goalObjectiveVersion 写入子 Run metadata；父 Run 无 Goal 时子 Run 无 Goal。已有不一致归属拒绝，不覆盖。不要从 child session 的旧 metadata 或 children map 的创建时 parentRunId 继承。
- [x] **补完整生命周期。** 更深后代从直接父 Run 继承；原父 Run 完成后的已授权 post-run child 保留原身份，非 Goal 的 post-run 路径保持。所有排队 Child 在真正开跑时都检查本次父 signal，以及父 Run 对应 Goal 仍 active/正文版本一致；父 Run 终态后的 signal 未 abort 不能替代这个检查。宿主 projector 必须在 run.started 投影的可信身份检查中拒绝已停止/旧版本工作，Runtime 等待该事件接纳后才开始模型调用。每 Run 安装父 abort 监听，中断本 Run，不调用 close 整个 Child。终态后移除该监听，显式关闭/应用清理仍使用原 close。原创建时 parentAbortHandler 不再永久支配被复用后的工作。

补三个小接口，不加第二套管理器：`AgentChildHandle.interruptRun(expectedRunId: string, reason?: string): Promise<boolean>` 在 manager 内比较 record.currentRun.id，只中断匹配 Run 并等待 result/清理，不关闭会话；`LiveChildAgentDirectory.interruptRun(sessionId, runId, reason): Promise<boolean>` 只路由到该接口，不用可能空的 activity 猜 Run；`RunRepository.listGoalRuns(goalId, objectiveVersion): SessionRunRecord[]` 从现有持久/临时 read model 按可信 metadata 查根与后代，不新增索引表。空目录或身份不匹配返回 false，不能把 still-running 持久记录伪改成已停止。

RunControl 增 `stopGoalChildren(sessionId, goalId, objectiveVersion, reason): Promise<void>`：核对 Goal 归属，取 listGoalRuns 中该版本有 parentRunId 的活动记录，经 live directory 逐 Run 中断并等待；重读仍活动或清理错误则抛出，Goal 保持 paused，不提交新正文。SessionGoalService.stopRuns 先停止根工作，再 await stopGoalChildren，最后确认该版本全部清理。所需依赖通过原 session-run-assembly/daemon assembly 注入；只增加路由与查询，不把状态结算搬到目录。
- [x] **合并验证完成（保留建议提交单元）。** `pnpm --filter @vykor/agent-runtime exec vitest run src/child-agent.test.ts src/plugin-child-followup.test.ts src/agent-post-run-child.test.ts`；`pnpm --filter @vykor/server exec vitest run src/application/agent/__test__/daemon-agent-event-projector.test.ts src/application/agent/__test__/live-child-agent-directory.test.ts src/application/session/__test__/run-control-service.test.ts`；services 的 run-repository tests 验证后代查询包含 memory。必须覆盖旧父 abort 不误杀新 Run、取消后排队旧父任务不启动、根终态后后代仍可停止及插件授权/cleanup 失败。

## 6. A4：绑定具体等待并核验终态

**测试文件：**`packages/server/src/application/session/__test__/goal-wait-verifier.test.ts`；protocol/assessment tool 现有测试。

- [x] **构造失败回归。** 在现有 verifier 测试内使用 SessionStore 创建 root/child 会话及持久 Run；读取只依赖 runs.getRun。目标 g1/version 1、owner root Run R1、target Child Run C1(parentRunId=R1) 形成可信链。C1 completed，另一个 C2 running 复用同子会话；等待 C1 必须 completed。额外测试错误 goal/version、父链断裂/循环、target=owner、target 已完成但 finishedAt 超过截止、读取 unknown 和截止前完成但观察迟到。
> 原计划的单独红灯命令已并入集中验证；未单独执行该步。
- [x] **统一外部等待类型。** 持久 GoalWait.external 使用下列单一结构；模型输入 schema 只接受 targetRunId/deadlineAt，其余由宿主 binding 填入。

```ts
export type GoalExternalWait = {
  kind: "external";
  targetRunId: string;
  ownerRunId: string;
  goalId: string;
  objectiveVersion: number;
  deadlineAt: number;
};
```

parseGoalAssessment 用宿主 goalId/objectiveVersion/runId 生成 wait.ownerRunId；正式保存前 service 调用 verifier 核对 owner 根会话/版本、target 后代与父链。拒绝空/非法时间、target=owner、自引用或祖先循环。引用其他同 rootSession 的工作也拒绝。

- [x] **实现只读核验。** 移除 GoalWaitVerifier 的 liveChildren 参数及 daemon assembly 注入，目录仍承担 A3 的发送/准确中断。读取 owner 与 target；沿 target.metadata.parentRunId 回溯到 owner，逐节点确认同 Goal/正文版本；用 visited Set 检测循环，链长度最多 128，超出返回 missing。缺记录/归属返回 missing；读取异常在 deadline 前 unknown，到期后 failed/wait_timeout。

```ts
// owner/父链已核实后先处理落盘失败/中断，不能因观察迟到改成 timeout。
if (target.status === "failed" || target.status === "interrupted") return {
  state: "failed", code: "external_failed", reason: target.error ?? "外部运行未成功完成",
};
// 成功完成须核实 finishedAt；再判断仍运行/未知的截止时间。
if (target.status === "completed" && target.finishedAt !== undefined
    && target.finishedAt <= wait.deadlineAt) return { state: "completed" };
if (now >= wait.deadlineAt) return {
  state: "failed", code: "wait_timeout", reason: "等待外部任务超时",
};
// failed/interrupted → external_failed；pending/running → running。
```

GoalWaitCheck 的 failed 增 code=external_failed/wait_timeout；完成但缺 finishedAt 不能假装截止前完成，在期限内 unknown、期限后 wait_timeout。catch 必须用相同截止规则，持续异常不能永久 unknown。持久 Run 只有 pending/running/completed/failed/interrupted，Task 的 cancelled 不能直接当 Run 状态。

- [x] **合并验证完成（保留建议提交单元）。** protocol、assessment tool 与 verifier 三个定点测试通过。外部等待仅接受 targetRunId/ownerRunId/goalId/objectiveVersion/deadlineAt 当前结构；handleId 等此前字段不转换、不 fallback。

## 7. A5：外部结果只在一个事务里接纳一次

**测试文件：**service 现有 tests；新增 `packages/server/src/application/session/__test__/goal-external-wait-observer.test.ts`，只测试定时退避/回调；transactions 与 run-admission 测试。

- [x] **补失败与恢复回归。** 在已有 service harness 把外部等待 test 改成 targetRunId。用 fakeTimers 检查：30 秒多次 running/unknown 检查不创建 Run；任务 completed 时有未决批准、有用户 work、次数已耗尽分别不派发；重复 completed 与 recoverExternalWaits 不重复派发。向事务注入 recordGoalContinuation 失败，断言 wait、Run/Input/continuation 及事件都回滚。dispatch 抛异常后已有意图可重试，不新建第二 Run。

```ts
// 加在当前 service tests 的现有次数上限案例，不引入新 fixture。
expect(store.goals.getGoal(goal.id)).toMatchObject({
  status: "paused", stopReason: { code: "auto_turn_limit" }, autoTurnsUsed: 1,
});
// 等待恢复回归还必须比较：失败/重播前后的 findRunByInput 返回同一个 id。
```

> 原计划的单独红灯命令已并入集中验证；未单独执行该步。
- [x] **简化 observer。** deps 只保留 goals.getGoal、waitVerifier.check 与 `onWaitResult(goalId, expectedWait, check)`。回调返回 `"observe_again" | "settled" | "stopped"`：observe_again 在提交后按最新快照继续退避，后两者不再安排 timer。observer 负责已有 1/2/4/8/16/30 秒退避，清 timer、读快照、调用回调；不持有 admission、recordGoalContinuation 或状态写权限。状态/revision 改变但仍是同一 owner/target/正文版本时用最新快照继续；暂停/取消/变更则停止。
- [x] **服务内新增单一入口。** SessionGoalService 增 private `settleExternalWait(goalId: string, expectedWait: GoalExternalWait, check: GoalWaitCheck): "observe_again" | "settled" | "stopped"`，由 observer 回调调用。该函数在 context.transaction.transaction 中重读 Goal，检查 active、相同正文版本和完整 wait 身份；检查 control.hasUserWork、权限、次数、是否有同 Goal pending/running。

接纳顺序：无效/失败/超时写对应暂停原因并 stopped；有用户 work 或同目标已在执行，保留等待并 observe_again，不制造模型轮；未决批准转 waiting_user/approval 并 stopped，后续由原批准处理与有效 resume 继续，拒绝不能恢复；次数用尽 paused/auto_turn_limit 并 stopped。只有全部通过才清 wait、更新 Goal、persistGoalRun、recordGoalContinuation，并 settled。recordGoalContinuation=false 必须 throw 回滚全部状态/Run/Input/事件，不提交已清 wait 的半成品。稳定请求键为 `goal-wait-${goalId}-${objectiveVersion}-${ownerRunId}-${targetRunId}`，previousRunId 为 `wait:${ownerRunId}:${targetRunId}`，不加入当前时钟或状态 revision。

事务提交后通过原 dispatchPersistedRun 派发，成功后 markGoalContinuation(dispatched)。persistGoalRun 时在原 Run metadata 保存完整 `goalWaitSource: GoalExternalWait`；若派发失败，Goal paused/run_error，stopReason.runId 指向这个 Run，保留已保存的意图。不创建自动 GoalRequest、不新增恢复队列。

**明确恢复入口：**在 goal-records.ts 定义 GoalContinuationRecord，字段为已有表的 goalId/revision/previousRunId/inputId/runId/status；GoalRepository/GoalOperations 增 `findGoalContinuation(runId): GoalContinuationRecord | undefined`，对 SQLite/memory 作同一只读查询。RunAdmission 增 `isRunQueuedOrRunning(runId): boolean`，复用现有 runtimeQueue.runState，不维护另一份状态。

用户 resume 时，只有同时满足以下条件才进入“复用原等待意图”：goal.stopReason=run_error 且 runId 指向候选；该 Run pending，continuation.status=pending，运行器没有 queued/running；goalId/goalObjectiveVersion/goalWaitSource 与当前目标一致，owner/target 再经 verifier 核验 completed。validateResume 仅对这一个候选 pending Run 放行，其余活动/pending Run、未决批准、用户 work、次数不足继续拒绝。新用户动作 requestId 的事务更新 Goal active，并将原 runId/inputId 写入动作请求结果；不调用 persistGoalRun、不增加新续跑记录，提交后派发同一 runId。动作重试沿用原 requestId 对账。

没有候选、候选已启动/版本变化/被取消则不套用例外，使用既有明确恢复或冲突处理；绝不依据自由错误文字放宽 pending 检查。prepareRunExecution 开跑前仍检查状态/正文/批准/用户优先/次数。增加“第一次 dispatch 失败 → resume → 动作重试”的集成测试，断言原 inputId/runId/continuation 不变且自动次数只在第一次真正开跑加一。

**二次派发失败的同请求重试：**resume 已接纳原意图、但 dispatch 再次失败时，同一事务写 Goal paused/run_error，并将该动作请求保持 pending，result 保存 `phase: wait-dispatch-retry / runId / inputId / retryRevision`，retryRevision 为本次失败暂停后的 Goal.revision。replay 在调用普通 finishDispatch 前专门处理此 phase：核对当前 revision 等于 retryRevision、仍是相同 run_error 与原 Run，重新执行上述 pending 候选/版本/权限/次数/运行器检查；事务恢复 active 后派发请求结果中的原 runId，不 persist 新 Run。若期间用户 pause/cancel/edit 或其他状态操作已改变 revision/原因，返回冲突，不以旧动作恢复执行。补“等待派发失败 → resume 派发再次失败 → 相同 requestId 重试成功”的回归，断言身份和记录数量不变；另测失败后用户暂停，再重试不恢复。

- [x] **重启与取消回归。** 同时注册两次 observer、重启恢复、暂停后定时器触发、编辑后旧回调、批准拒绝、未知到期均不得重复执行或恢复用户暂停。结束前仍有运行的旧后代不得被新版本继承。假时钟期间验证模型执行 turns 不随轮询增加。
- [x] **合并验证完成（保留建议提交单元）。** `pnpm --filter @vykor/server exec vitest run src/application/session/__test__/session-goal-service.test.ts src/application/session/__test__/goal-external-wait-observer.test.ts src/application/session/__test__/run-admission-service.test.ts`；事务测试覆盖已保存意图回滚与重复键。

## 8. A6：停止原因完整覆盖与轻量展示

**测试文件：**service/transactions/run-control 原 tests；`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/__test__/goal-banner.test.tsx`；新增同目录 `goal-stop-reason-label.test.ts`。

- [x] **补行为测试。** 用户 pause/cancel、编辑停止失败、次数到达、Run 失败/中断、评估缺失/下一步缺失、wait invalid/timeout/external failed、原有三轮 blocked、启动恢复逐项断言 code。暂停期间旧失败结算不能覆盖 user_paused，未结束 editing 停止不能被 catch 覆盖为 run_error。新 resume 成功清原因、失败保留真实原因。
> 原计划的单独红灯命令已并入集中验证；未单独执行该步。
- [x] **沿现有分支写原因。** 使用 spec 的结构，不抽象一套新状态转换器。A 的生产 code：user_paused/user_cancelled/updating_objective/auto_turn_limit/run_error/assessment_invalid/wait_invalid/wait_timeout/external_failed/no_progress/startup_recovery。评估结构非法/下一步缺失用 assessment_invalid，具体等待记录缺失或归属不符用 wait_invalid；provider_limit 只有已有可信分类能提供时才写，A 不解析错误字符串猜限流。token_budget/usage_unknown/preparation_limit 在 A 无生成入口。
- [x] **加纯文案函数。** 新 `goalStopReasonLabel(goal: SessionGoal): string | undefined` 只按 code 给短标签，reason 仍显示具体说明；stopReason 为空表示当前没有结构化停止原因，展示当前 reason/wait 说明，不猜 code。GoalBanner 使用该函数，自动次数文本不改称 Token 预算，按钮权限与 server 验证不挪到前端。

```ts
// 新文案函数测试的最小断言；fixture 使用 GoalBanner tests 的现有 goal。
expect(goalStopReasonLabel({ ...goal, stopReason: {
  code: "wait_timeout", at: 1,
} })).toBe("等待任务超时");
expect(goalStopReasonLabel({ ...goal, stopReason: {
  code: "auto_turn_limit", at: 1,
} })).toBe("自动续跑次数已用完");
```

- [x] **合并验证完成（保留建议提交单元）。** server/service 定点 tests；`pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/composer/__test__/goal-banner.test.tsx src/renderer/src/components/desktop/conversation-page/composer/__test__/goal-stop-reason-label.test.ts`。依照 AGENTS，由用户查看样式，不搭预览/截图；不用新组件，直接复用 Banner/按钮。

## 9. A7：验收矩阵、检查与交付

- [x] **覆盖 spec。** W1=已完成 Child 仍 idle；W2=同代理第二 Run；W3=错误目标/版本/父关系；W4=unknown/迟到轮询；S1=A 的停止原因；V1=正文编辑与重复请求；V2=旧评估拒绝；R1=去重/用户优先/批准/memory/普通运行。C 的确认要求覆盖与防循环升级不在 A 验收中。
- [x] **根目录跑一次汇总针对性回归。** 汇总 A1–A6 中的实际变更测试，不重新跑整个 monorepo。额外包含 `packages/core/src/engine/goal-context.test.ts` 的普通任务不泄漏 Goal 扩展回归、`packages/services/src/session-runtime/__test__/session-goals.test.ts` 的现有生命周期、`packages/server/src/application/session/__test__/run-control-service.test.ts` 的暂停/用户优先。新失败先定位，不重复发模型 E2E。
- [x] **类型检查。** `pnpm --filter @vykor/protocol --filter @vykor/services --filter @vykor/agent-runtime --filter @vykor/server --filter @vykor/client run check-types`；`pnpm --filter @vykor/desktop run typecheck:web`。如果 Agent Runtime 的 dist 类型过期导致依赖方报错，按仓库既有构建顺序刷新该包，不能靠 any/复制协议类型绕过。
- [x] **结构一致性与交付。** `pnpm --filter @vykor/services run db:check`；`git diff --check`；实现后审查变更路径及 W3/A5 事务重点。只更新 `docs/session-goals-design.md` 的已交付 A 部分；本计划勾选已完成步骤、路线 A 标记交付。B/C 字段与 UI 仍不宣称已支持。
**建议提交说明（未提交/推送）。**** 每个已验证任务为一个建议提交单元，提交标题分别为 `feat(goal): persist objective identity and stop reasons`、`refactor(goal): bind runs to objective versions`、`fix(agent): bind each child run to its trusted parent`、`fix(goal): verify concrete external run waits`、`fix(goal): admit external wait results atomically`、`feat(desktop): explain goal stop reasons`。只暂存该任务文件；实际 commit/push 是否执行遵循用户授权，不使用 git add .。

## 10. 实施预算与暂停点

本次按用户明确指令在已授权工作区实施 A，保留其他任务改动；执行了相关测试、结构 inventory 生成和类型检查。未提交/推送，未清理、重建或转换实际数据。

A2/A3/A5 涉及同一 service/projector，顺序执行更省对账成本。首版仅定点测试和少量强边界集成测试，不为纯文案写截图测试。发生新代码变化、失败或未解决的风险才重复相关测试。A3 若现有可信身份接口无法按上述路径复用，先提出具体冲突和最小修改，不扩大成子代理框架重写。

本轮一名子代理集中审查 + 同一代理定点复核；没有数值 Token 预算时不虚构使用量。A 已获用户授权并实施；B/C、真实模型 E2E、部署不在本次范围。
