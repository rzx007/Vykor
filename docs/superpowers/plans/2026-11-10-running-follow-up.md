# Vykor 运行中补充 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> 状态：提案，按 Ponytail 审核收缩为六项任务，全部待实施。当前只修订文档，不因本计划启动实现或子代理。

**Goal:** 先修三个前置问题，再接通主聊天与侧聊；完全访问默认直接补充，其余授权默认排队，允许手动切换。

**Architecture:** 消费等待放在现有会话操作通道外；在内容实际加入历史时记录 Run 的已应用输入序列。复用 Input/Run/promotion metadata、接纳事件和快照，不建新投递状态机；沿现有 HTTP 回执与协议 7 接通可选目标保护，Desktop 保存已提交请求的选择。

**Tech Stack:** TypeScript、现有 SQLite 存储、Hono、Agent Runtime/Core、React/Zustand、Electron IPC、Vitest。

**Spec:** [运行中补充设计说明](../specs/2026-11-10-running-follow-up-design.md)。状态推导和 17 项验收场景以设计为准。

## Global Constraints

- 本轮只修订文档；以下任务尚未执行，不修改业务代码、不生成迁移。
- 完全访问默认直接补充，询问审批和自动审查默认排队；plan 不额外改变此映射，原权限限制继续生效。
- 首次提交固定 inputId、正文、附件、delivery、expectedActiveRunId；重试不重新计算。
- 原始 scope.inputId、Run.inputId 保留归属；真实应用事实和审批输入版本必须保留。
- 不新增投递 JSON 列、逐输入状态机、逐输入 revision、偏好持久化、通用调度器或第二套 route；精确协议保持 7。
- 手动切换只影响本条输入，确认接纳后恢复默认；不增加“自动”第三选项或跨重启偏好。
- 新测试归被测分类的 `__test__/`，跨模块测试放共同所属目录；只建设一条完整 HTTP＋SDK＋运行器链路。
- 复用现有 UI；确需新组件时查 beUI 并遵循 `apps/desktop/DESIGN.md`，保留键盘操作和减少动态效果。样式由用户查看，不主动预览或截图。
- 使用受控 Promise、事件和脚本化供应商测试，不使用固定 sleep、真实模型费用或部署。

## 顺序与实施关口

| 任务 | 交付 | 依赖 | 验收编号 |
| --- | --- | --- | --- |
| T1 | 消费等待不阻挡停止 | 无 | A01、A02 |
| T2 | 实际应用指令和审批版本保护 | T1 | A03–A06 |
| T3 | 拒绝带输出要求的提升 | 无；按顺序验收 | A07 |
| G1 | 三个前置修复通过 | T1–T3 | A01–A07 |
| T4 | 最小目标接线、元数据和能力 | G1 | B04、B05、B09 |
| T5 | 主聊天和侧聊的共同提交、恢复与队列 UI | T4 | B01–B03、B06、B07 |
| T6 | 一条贯通链路、失败恢复与文档收口 | T4、T5 | B08、B10，核对全部 17 项 |

G1 前不开放默认补充。T4 接好并验证有目标补充后才发布 `features.steer=2`；不把“后台已接纳”和“模型历史已应用”合成一个信号。

## T1：解除追加与停止的等待关系

**Files**

- Modify: `packages/server/src/application/session/interactions/session-interaction-service.ts`
- Modify: `packages/server/src/application/session/execution/run-admission-service.ts`、`run-admission-work.ts`、`run-control-service.ts`
- Modify: `packages/server/src/runtime/run-coordinator.ts`
- Create: `packages/server/src/application/session/interactions/__test__/session-input-operation-lane.test.ts`
- Test: `packages/server/src/runtime/__test__/run-coordinator.test.ts`、execution 的既有接纳和控制测试。
- Docs: 实际受影响的 interactions、execution、runtime 分类 README。

**接口与做法**

复用现有返回类型推断，仅将消费 Promise 装在对象里带出会话操作；直接返回 Promise 会让操作通道继续等待。

```ts
const prepared = await operationRunner.run(sessionId, async () => ({
  completion: registerInput(),
}));
return await prepared.completion;
```

- [ ] 组装真实 SessionInteractionService、SessionOperationRunner 和 RunAdmissionService，只把运行器消费换成受控 Promise；不把 operationRunner mock 成直接执行。
- [ ] 写 A01：输入已登记但消费未完成时提交指定 Run 的停止，用控制层调用通知同步；断言停止先到，再释放消费并收束所有 Promise。

```ts
expect(control.interruptRun).toHaveBeenCalledWith("s1", "r1");
expect(deliverySettled).toBe(false);
expect(admittedInputIds).toEqual(["i-steer"]);
```

- [ ] 写 A02：提升先占位、旧 queued Run 不派发；拒收恢复原队位；取消或停止后的迟到回调不复活；重复提升只合入一次。
- [ ] 先运行定向测试，确认旧实现失败在停止等待关系，而非 fixture 或环境。
- [ ] 将长内容准备移到短操作外，登记前复核配置和目标；短操作内保存并占位，通道外等待消费，公开 HTTP 返回边界不变。
- [ ] 成功和失败只在短操作里结算，保留 owner、原目标、取消状态、promotions 和 shutdown 的既有保护，不留下未捕获的拒绝。
- [ ] 重跑同组测试，更新分类 README；形成可独立验收的修复。

```powershell
pnpm --filter @vykor/server exec vitest run src/application/session/interactions/__test__/session-input-operation-lane.test.ts src/runtime/__test__/run-coordinator.test.ts src/application/session/execution/__test__/run-control-service.test.ts src/application/session/execution/__test__/run-admission-service.test.ts
```

## T2：实际应用指令进入审批证据

**Files**

- Modify: `packages/agent-contracts/src/execution/execution.ts`、`events.ts`；`packages/agent-contracts/src/policy/permissions.ts`
- Modify: `packages/agent-runtime/src/kernel/framework-agent-run.ts`
- Modify: `packages/core/src/engine/query-engine.ts`、`packages/core/src/engine/tools/checked-tool-execution.ts`
- Modify: `packages/server/src/application/agent/daemon-agent-event-projector.ts`
- Modify: `packages/server/src/permissions/session-approval.ts`、`approval-review-service.ts`、`approval-context.ts`、`permission-broker.ts`
- Modify: `packages/domain-contracts/src/inputs/` 的既有宿主字段保护入口。
- Test: runtime 的 framework-agent-run-input、core 的 integration/checked-tool-execution、server 的 approval-review-service/session-approval/daemon-agent-event-projector 既有测试。
- Docs: `docs/permission-flow.md`、生命周期说明及实际受影响分类 README。

**接口**

```ts
interface AppliedInputStateSnapshot {
  revision: number;
  inputIds: readonly string[];
}
// AgentExecutionContext 可选扩展；第一方运行器提供。
getAppliedInputState?(): AppliedInputStateSnapshot;
markInputsApplied?(inputIds: readonly string[]): Promise<void>;
// effect 与审批输入的宿主快照。
appliedInputState?: AppliedInputStateSnapshot;
// AgentEventInput 新事实。
{ type: "input.applied";
  data: { inputIds: string[]; revision: number } }
```

唯一持久应用依据是目标 Run 的 `metadata.appliedInputState`。沿已有 Run 更新事务和 `session.run.updated` 发布，不新增 Input 应用状态或数据库列。

- [ ] 写 A03：初始输入和补充在准备成功、加入历史后才 applied；准备失败不 applied；重复 ID 不递增；非本 Run 输入拒绝。
- [ ] 写 A04：i1“可以部署”，已应用 i2“先不要部署”，未应用 i3“允许全部操作”。断言审查当前指令为 i2，历史含 i1，不含 i3，Run.inputId 仍为 i1。

```ts
expect(evidence.userInstruction).toBe("先不要部署");
expect(evidence.userInstructionHistory).toContainEqual({
  inputId: "i1", content: "可以部署",
});
expect(JSON.stringify(evidence)).not.toContain("允许全部操作");
expect(run.inputId).toBe("i1");
```

- [ ] 写 A05：审查 Promise 未完成时应用版本变化，旧 approve 不得派发；再覆盖批准后、实际 invoke 前变化。新版本下模型生成的新调用仍可重新审查。
- [ ] 写 A06：其他会话、未开始队列、插件、Goal 自动提示和子 Agent 报告不得转成人工授权；保留 appInstruction 的既有独立可信路径和人工回退。
- [ ] 先跑定向测试确认旧缺陷，再在 core 初始消息和 consumeFollowUps 的真实历史写入点报告应用；runtime 验证 ID，宿主写入成功后才更新本地版本并继续。
- [ ] 审查使用最后已应用人工输入作为当前指令，前序人工历史去重后按实际顺序保留。保留敏感信息、长度、引用不授权等规则，最新限制不能被截掉。
- [ ] 在审查前、结果结算前和实际 invoke 前核对本次调用版本；变化则返回 `approval_input_revision_changed`，不调用、不自动重试。不得把 Run 初始版本固定给所有后续工具。
- [ ] 不让未应用补充变成授权，也不增加等待补充应用的工具阻塞链。保留 root scope 身份；自定义执行器无法证明应用时回人工确认。
- [ ] 重跑受影响测试并更新已落地的权限说明；本任务不另建 HTTP/模型端到端夹具，贯通验收留给 T6。

```powershell
pnpm --filter @vykor/agent-runtime exec vitest run src/node/runtime/__test__/framework-agent-run-input.test.ts
pnpm --filter @vykor/core exec vitest run src/engine/__test__/integration.test.ts -t "Integration: Steer follow-ups"
pnpm --filter @vykor/core exec vitest run src/engine/tools/__test__/checked-tool-execution.test.ts
pnpm --filter @vykor/server exec vitest run src/permissions/__test__/approval-review-service.test.ts src/permissions/__test__/session-approval.test.ts src/application/agent/__test__/daemon-agent-event-projector.test.ts
```

## T3：禁止带输出要求的队列提升

**Files**

- Modify: `packages/server/src/application/session/execution/run-control-service.ts`，复用 run-admission-work 的保存合同读取。
- Test: execution 的 run-control-service、interactions 的 session-interaction-service-queue-actions 既有测试。
- Docs: execution 分类 README。

- [ ] 写 A07：仅 Input 保存 Schema、仅 queued Run 保存、双方相同、双方冲突，全部在调用 runtime 前拒绝；原合同、pending 状态和队位不变。

```ts
expect(runtime.promoteQueuedRun).not.toHaveBeenCalled();
expect(queuedRun.status).toBe("pending");
expect(queuedRun.metadata.outputSchema).toEqual(originalSchema);
```

- [ ] 保留普通文本成功、直接 steer＋outputSchema 拒绝的回归。
- [ ] 先运行确认旧实现缺少检查，再在移队列前统一拒绝；不新增运行中合同协商。
- [ ] 重跑同组测试，更新说明。

```powershell
pnpm --filter @vykor/server exec vitest run src/application/session/execution/__test__/run-control-service.test.ts src/application/session/interactions/__test__/session-interaction-service-queue-actions.test.ts
```

## G1：前置修复关口

- [ ] A01 使用真实会话操作通道，A04/A05 检查真实证据与 invoke，A07 检查原持久记录和队位。
- [ ] A01–A07 通过，无未结算 Promise 或固定 sleep；权限和队列既有回归通过。
- [ ] 受影响包类型检查通过，再进入运行中补充接入。

```powershell
pnpm --filter @vykor/agent-contracts --filter @vykor/core --filter @vykor/agent-runtime --filter @vykor/server run check-types
```

## T4：最小目标接线与能力扩展

**Files**

- Modify: `packages/protocol/src/session/session-requests.ts`、`requests/requests.ts`。
- Modify: `packages/client/src/types/index.ts`、`resources/session/session-resource.ts`；`packages/application-client/src/resources/session/session-resource.ts`。
- Modify: Server 的 session-interaction-service、run-admission-work、run-admission-service、run-control-service、run-coordinator 既有接点。
- Modify: `packages/server/src/http/routes/run-execution.ts`、`system.ts`；既有宿主 metadata 保护入口。
- Modify: `packages/services/src/conversations/conversation-tree-operations.ts` 的既有 fork 字段清理。
- Test: requests、Client session-resource、Server 接纳/控制/coordinator/路由和既有 fork 测试。
- Docs: 对应分类 README 与 `docs/protocol-contract.md` 的能力说明。

**接口与最少事实**

```ts
// 现有请求增加可选字段；新版 Desktop 的 steer 必须带，queue 不带。
expectedActiveRunId?: string;
// 保存到已存在的宿主 metadata，不新建表或字段列：
Input.metadata.steerTargetRunId;
Run.metadata.promotion; // kind=steering 占位，成功仍用 kind=steered
Run.metadata.appliedInputState; // T2 的唯一应用序列
// 精确协议仍为 7，features.steer 升为 2，表示支持目标保护。
```

- [ ] 写 B04：新请求预期 r1、当前为 r2，接纳前拒绝；接纳后 r1 结束但输入未应用，不转投 r2、不启动替代 Run。
- [ ] 写重试：同 inputId 先核对已接纳请求；原 Run 已结束时仍返回原结果，不能当成新请求重新路由。相同 ID 的正文、附件、delivery、原目标不同则冲突。
- [ ] 写 B05/B09：新版有目标输入遇附件等不兼容内容明确拒绝；缺能力的 Client 不发目标字段。旧请求未带该字段时维持既有合同，版本 7 不变。
- [ ] parser、HTTP 映射、Client 和应用客户端只透传可选字段。目标保护在运行器同步登记点校验，不能只在 HTTP 入口比较。
- [ ] 直接补充初次接纳时写宿主 steerTargetRunId，提升复用原 queued Run 的 promotion 记录占位目标；对外仍只发已有 input.admitted/run.updated 事件。
- [ ] 提升拒收恢复原队位和 metadata；input.applied 成功时，在原事务里更新目标应用序列并结算旧 queued Run；重复或迟到回调只核对、清理占位，不另写成功事实。
- [ ] 精确目标请求沿既有失败路径收束，保留可核对输入和错误，不走跨 Run 自动恢复执行。复用 Run.error 与终态，不加逐输入 failed/cancelled。
- [ ] 将新宿主字段列为不可伪造；fork 沿已有清理逻辑去掉活体目标。memory、SQLite 保存、owner 和恢复继续原机制，不创建迁移或新恢复器。
- [ ] 保留 T1 的 HTTP 等待边界，不改立即返回。运行器及所有接线完成后才发布 steer=2；验证错误码与目标穿过现有客户端而不丢失。

```ts
expect(capabilities.protocol.version).toBe(7);
expect(newRequest.expectedActiveRunId).toBe("r1");
expect(admitted.input.metadata.steerTargetRunId).toBe("r1");
expect(retried.input.id).toBe(admitted.input.id);
expect(executionStartedForR2).toBe(false);
```

```powershell
pnpm --filter @vykor/protocol exec vitest run src/requests/__test__/requests.test.ts
pnpm --filter @vykor/server exec vitest run src/application/session/execution/__test__/run-admission-service.test.ts src/application/session/execution/__test__/run-control-service.test.ts src/runtime/__test__/run-coordinator.test.ts src/http/routes/__test__/run-execution.test.ts
pnpm --filter @vykor/services exec vitest run src/conversations/__test__/conversation-transactions.test.ts
pnpm check-types:server-client
pnpm check:client-api
```

## T5：主聊天与侧聊共用提交和队列

**Files**

- Modify: `apps/desktop/src/renderer/src/stores/desktop-session/types.ts`、`prompt-actions.ts`、`prompt-submission.ts`、`composer-recovery.ts`、`composer-draft-state.ts`、`session-view-state.ts`、`queued-prompt-actions.ts`、`pending-prompt-state.ts`。
- Modify: `apps/desktop/src/shared/session-types.ts`、`src/preload/desktop-api.ts`、`src/main/features/session/session-operations.ts`。
- Modify: conversation-page 的 composer/controls、conversation-page、transcript/pending-prompt-queue 和 tools/side-chat/side-chat-panel 既有入口。
- Create: `apps/desktop/src/renderer/src/stores/desktop-session/__test__/prompt-follow-up.test.ts`。
- Create: `apps/desktop/src/renderer/src/components/desktop/tools/side-chat/__test__/side-chat-follow-up.test.tsx`。
- Test: 既有 composer-recovery、prompt-actions、主聊天 queue-lifecycle、side-chat-panel、session-operations-modes 和 preload 测试。
- Docs: 实际受影响的 desktop-session、composer、transcript、side-chat、main/session 分类 README。

**接口**

```ts
// 默认值计算留在现有输入框/提交分类，两个入口共用，不新增配置服务。
const delivery = manualDelivery ??
  (approvalMode === "full_access" ? "steer" : "queue");
// PendingPromptSubmission 与 SendDesktopPromptInput 保存已提交意图。
delivery: "queue" | "steer";
expectedActiveRunId?: string;
// 队列动作增加可选 target，复用 SubmitPromptOptions["target"]。
promoteQueuedPrompt(inputId, queuedRunId, expectedActiveRunId, target?): Promise<void>;
cancelQueuedPrompt(inputId, queuedRunId, target?): Promise<void>;
```

- [ ] 写 B01/B02：两入口各三档授权与 plan；本条手动选择优先，接纳后恢复默认；切聊天重置，主侧聊互不覆盖。无 active Run 时正常发送，不带目标。
- [ ] 写 B03：Enter 与点击使用相同快照，输入法/换行不提交；停止在途禁止同作用域新提交，其他会话仍可用。
- [ ] 写 B06：HTTP 未结束时接纳事件已确认输入，草稿准确清理、发送状态释放、选择只重置一次；随后新草稿和新选择不被迟到 HTTP 改写。
- [ ] 写 B07：activeSessionId=s-main、target=s-side，提升/取消/核对都发给侧聊，await 后切换或关闭不改变归属。

```ts
expect(promoteRequest).toMatchObject({
  sessionId: "s-side", inputId: "i-side",
  queuedRunId: "r-side-queued", expectedActiveRunId: "r-side-active",
});
expect(mainRuntimeAfter).toEqual(mainRuntimeBefore);
expect(mainDraftAfter).toEqual(mainDraftBefore);
expect(sendingAfterAdmittedEvent).toBe(false);
expect(httpCompletedAtThatPoint).toBe(false);
```

- [ ] 用现有输入框状态保存本条手动选择，只展示两种时机；不加入恢复文件、不新增“自动”选项。已知输入限制可见，不能选择不支持的补充方式。
- [ ] 创建 submission 时固定 delivery/target，main 删除固定 queue、改为校验透传，preload 不重算。恢复格式仅增加这两个已提交字段；旧 submission 恢复为历史 queue，不按当前权限改义。
- [ ] 复用 reconcilePendingPromptSubmissions、reconcileSubmittedDrafts、clearSubmittedDraft 的接纳确认与准确清理。RPC 只确认，不把返回旧对象灌回 store，也不另加逐输入 revision。
- [ ] 主聊与侧聊共用队列，等待补充从目标 Run 的 appliedInputState 推导；原队列和取消从 Run/promotion 推导，不新增持久 phase。用户消息已出现但尚未 applied 时不能显示模型已处理。
- [ ] 队列动作捕获 target sessionId/view，确认、错误、重试及清理全程使用它。侧聊沿已有订阅确认接纳，不增加主聊天订阅或持久记录。
- [ ] 接纳未知先核对同 inputId；确定未应用且终态的输入可恢复到草稿后新提交。未完成请求恢复原 delivery/target，memory 侧聊仍不落盘，不自动重发。
- [ ] 明确 409 且未接纳时，“按当前目标重新发送”恢复为新提交并生成新 ID；普通核对重试仍用旧 ID 和目标，不把两种动作混在同一重试按钮里。
- [ ] 发送按钮与独立停止入口接好，保持键盘、焦点和减少动态效果；不启动预览或截图。
- [ ] 运行定向测试和 Desktop 类型检查，更新分类说明。

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/stores/desktop-session/__test__/prompt-follow-up.test.ts src/renderer/src/stores/desktop-session/__test__/composer-recovery.test.ts src/renderer/src/stores/desktop-session/prompt-actions.test.ts src/renderer/src/components/desktop/conversation-page/__test__/conversation-page.queue-lifecycle.test.tsx src/renderer/src/components/desktop/tools/side-chat/__test__/side-chat-follow-up.test.tsx src/renderer/src/components/desktop/tools/side-chat/__test__/side-chat-panel.test.tsx src/main/features/session/session-operations-modes.test.ts src/preload/desktop-api.test.ts
pnpm --filter @vykor/desktop run check-types
```

## T6：一条完整链路与验收收口

**Files**

- Create: `tests/server-client/__test__/running-follow-up.test.ts`，复用既有后台与存储测试夹具，模型和审查器受控。
- Extend: 实际需要的 startup-recovery、保存重开与 Client 同步既有测试；不另建 Server HTTP 或 Desktop 全链路模型夹具。
- Modify: 权限流程、协议能力说明、持久数据、生命周期、客户端同步、输入框能力、产品接入边界、Client SDK、契约测试索引和实际受影响分类 README。
- Modify: 本设计和计划的实施记录，最终验收结果放现有 reviews 目录。

- [ ] 验证 HTTP → 应用 → 第一方 runtime/core → 投影 → Client：接纳先可见，HTTP 在锁外等待；后续模型请求含补充，Run 身份稳定，工具结果保存一次。
- [ ] 同一夹具验证长工具/待审批时停止先到、已应用撤销进入审批证据、旧目标不能接收新投递。其他边界沿 T1–T5 的最小测试，不把 17 个场景全部重复端到端化。
- [ ] 在既有恢复测试注入接纳后、应用后、提升中三个点，重开正式存储；保留应用事实、审批过期、输入可核对、不自动执行、旧 owner 回调不复活。memory 不落盘。
- [ ] 对照设计 A01–A07、B01–B10 逐项填写测试入口及实际结果，保留所有验收要求；未验证真实供应商和样式时明确记录。
- [ ] 回写已经落地的当前手册与分类 README；精确协议仍为 7，只更新 steer 能力和目标字段说明。
- [ ] 运行收口检查；已通过的实现测试不重复全套，只对最后修改涉及的组补跑。

```powershell
pnpm exec vitest run --config tests/server-client/vitest.config.ts tests/server-client/__test__/running-follow-up.test.ts
pnpm --filter @vykor/server exec vitest run src/application/recovery/__test__/startup-recovery-service.test.ts
pnpm --filter @rzx/client exec vitest run src/state/__test__/session-sync-controller.test.ts
pnpm --filter @vykor/agent-contracts --filter @vykor/core --filter @vykor/agent-runtime --filter @vykor/server --filter @vykor/protocol --filter @rzx/client --filter @vykor/application-client --filter @vykor/desktop run check-types
pnpm check-types:server-client
pnpm check:architecture
pnpm check-docs
pnpm check:retired-ui
git diff --check
```

## 修订自检与实施记录

文档修订自检：六项任务保留 17 项场景；三个前置修复仍有 G1 关口；只保留 Run 应用版本；没有新列、五状态、逐输入版本、强制协议升级或偏好持久化。新建测试明确标注，未新增业务文件。

本轮文档验证：`pnpm check-docs` 通过（1005 个 Markdown 文件），`pnpm check:retired-ui` 通过，`git diff --check` 通过。以下实施任务仍全部未开始，未运行新实现测试。

| 任务 | 实施状态 | 验证状态 |
| --- | --- | --- |
| T1 | 未开始 | 未执行实现验证 |
| T2 | 未开始 | 未执行实现验证 |
| T3 / G1 | 未开始 | 未执行实现验证 |
| T4 | 未开始 | 未执行实现验证 |
| T5 | 未开始 | 未执行实现验证 |
| T6 | 未开始 | 未执行实现验证 |

全部仍待实施；先前 212 项现有测试不作为新实现的验收结果。
