# Goal B 阶段实现计划：真实用量与可选 Token 预算

> **面向执行者：**使用 `executing-plans` 按 B1 → B2 → B3 → B4 实施，复选框记录进度。用户要求优先：关键回归集中运行，一名子代理集中审核和必要定点复核，不逐步骤设审批、重复全套测试或强制提交。
> 日期：2026-10-14。状态：已实施并完成集中审核修订，变更未提交；交付见 [B 实施审查](../reviews/2026-10-14-goal-phase-b-implementation-review.md)。
> 基线：当前工作区 A 实现，Git HEAD 为 `f364f7c9`，A 尚有未提交变更；不能只检出该提交就认为包含 A。
> 规格：[Goal spec §6、§9、B1–B7](../specs/2026-10-14-goal-reliability-and-budget-design.md)。依赖：[A 实施与审查](../reviews/2026-10-14-goal-phase-a-implementation-review.md)。
> 审查：[B 计划审查与修订记录](../reviews/2026-10-14-goal-phase-b-plan-review.md)。

**目标：**用户可设置 Goal 的总 Token 预算，看到真实已知用量和缺账；达到限制后停止新增调用，并保留已派发调用的补账。

**架构：**provider 适配器提供规范化的单次报告，Runtime 给每次真实请求固定身份，projector 把报告交给现有 GoalTransactions。新增 `goals/goal-usage.ts` 只保存、合并和汇总用量；Goal 服务决定是否允许执行，原 RunControl 请求停止和清理。Desktop 沿原会话更新触发 getGoal，合并状态和用量后显示在原 Banner。

**技术栈：**TypeScript、SQLite / Drizzle、Vitest、现有 Agent Runtime / HTTP / SSE / Desktop React。

## 1. 全局约束与交付边界

- 保留六个 GoalStatus、次数保护、requestId 去重、用户优先、批准检查和 A 的 objectiveVersion / 父 Run 绑定。
- 不兼容旧数据。不回填旧模型用量、扫描旧事件猜账、转换旧请求或等待，不自动重建或删除实际数据库。
- 计量单位是**完整输入（含缓存）+ 输出 Token**，不是费用或上下文窗口大小。API 适配器明确输入是否已含缓存，Goal 不按 provider 名称猜公式。
- 只计每次原始模型尝试，唯一键 `(runId, generationId, attempt)`；不叠加 Run / Child / session 的汇总用量。
- 总量跨正文版本、恢复、模型切换累积；预算变更不增加 objectiveVersion，不清零用量或 autoTurnsUsed。
- 有限预算下已知总量达到预算，或存在真实缺账，停止新增工作。**进行中的调用不等于缺账**；单列 inFlightAttempts，不能刚登记第一请求就把有限预算目标暂停。
- 不承诺绝不超额，不做精确额度预留、货币换算、Token 级流式熔断或独立预算平台。文案固定为“达到已知预算后停止新增工作，可能存在已派发用量”。
- 不加入 C 的准备阶段、正式 requirementId、GoalRead、refine/pivot 审计或新 Critic；B 的验收继续使用 A 的当前条件与评估。
- 不新增第二个协调器、恢复队列或运行状态表。用量文件不负责派发、权限裁决、provider 字段解析或文件系统验证。
- memory Goal 的用量记录只存在进程内，跟现有事务回滚和删除一起处理；不因子 Run 在另一个会话而把它落入 SQLite。
- 用户已授权实施；以下任务已执行并按影响范围集中验证。没有提交、推送、部署或操作真实数据库。

## 2. 当前源码与 B 必补的入口

| 当前入口 | 已有行为 | B 的变化 |
| --- | --- | --- |
| `core/engine/query-engine.ts` 主生成循环 | generationId + attempt；generation_started 后调用 client | 在真实请求前检查并登记尝试；不能只在 final 后查预算 |
| `core/engine/buffered-model-retry.ts` | 压缩/记忆辅助请求只提供 onAttemptFinished | 加对应开始回调；每次重试重新检查，跟主生成保持同一身份规则 |
| `core/engine/query-model-attempt.ts` | 有 usage 对象且调用成功即 complete | 按规范化报告判完整性；字段缺失/非法不能因流成功就当完整 |
| `agent/daemon-agent-event-projector.ts` | 终态 Run 早退；第一次 finished 后同尝试报告直接忽略 | 独立用量入口先登记/补账，再决定文本投影是否继续 |
| `api/providers/openai.ts`、`codex.ts` | 若字段缺失，部分分支给 0；OpenAI 有工具时未请求 include_usage | 预算报告读取回填前原字段；工具模式也请求用量，确实缺值仍不完整 |
| `agent-runtime/event-source.ts`、projector Child 补偿 | sink 错误包装为 DeliveryError；Child 投影异常可能补偿后返回 | 预算拒绝保留可识别身份并让 emit 拒绝，不进入投影故障补偿 |
| A 的 `listGoalRuns(goalId, objectiveVersion)` | 按一个正文版本查根与后代 | objectiveVersion 改为可选；省略时查该 Goal 所有版本，仅用于累计和预算停止 |
| `agent-runtime/memory-runtime.ts`、后置维护 | remember 另发辅助模型调用 | 使用明确来源 Run 和同一开始/结束回调，不作为免费调用 |
| Desktop `goal-actions.saveGoal` | 只按 revision / updatedAt 拒绝旧 Goal | 状态与 usage.seq 分别合并，旧状态快照不能回退新用量 |

实现前以此表核对入口，不把 `session_run_attempt` 当模型尝试表：它当前描述 Run 执行尝试，一个 Run 内可能发生多次生成、重试和压缩。

## 3. 文件责任清单

以下路径以仓库根目录为起点。只有两份新增生产文件；其余在现有模块内增加接口，禁止顺带拆分整个运行框架。

| 单元 | 新建 / 修改文件 | 责任 |
| --- | --- | --- |
| B1 | 新建 `packages/services/src/goals/goal-usage.ts`；修改 `goal-records.ts`、`goal-repository.ts`、`goal-transactions.ts`、`goals/index.ts`、`session-runtime/store.ts` | 单尝试记录、合并/汇总、GoalOperations 接口 |
| B1 | `packages/protocol/src/session-goals.ts`、`session.ts`；services 的 `session-runtime/schema.ts`、现行初始化 SQL / 最新 snapshot / inventory、`database/temporary-control-records.ts`、`session-runtime/event-registry.ts` | 当前格式、memory 事务、usage 事件 |
| B2 | 新建 `packages/api/src/providers/token-metering.ts`；修改 `anthropic.ts`、`openai.ts`、`codex.ts`；`packages/core/src/types/usage.ts`、`types/runtime-events.ts`、`engine/model-retry.ts`、`query-model-attempt.ts` | 单次报告规范化，原始字段与完整性 |
| B2 | `packages/core/src/engine/query-engine.ts`、`buffered-model-retry.ts`、`compact-service.ts`；`packages/agent-runtime/src/event-source.ts`、`framework-agent-run.ts`、`agent.ts`、`child-agent.ts`、`memory-runtime.ts`、`goal-extension.ts` | 所有已绑定原生模型请求的身份/报告/宿主限制参数，以及限制错误的可靠传递 |
| B2/B3 | `packages/server/src/application/agent/daemon-agent-event-projector.ts`；`session/session-run-executor.ts`、`session-run-assembly.ts`、`session-post-run-maintenance.ts`；`auto-review/session-auto-review-service.ts`；`daemon-application.ts` | 可信事件落账、后置来源、依赖注入；不复制公式 |
| B3 | `packages/core/src/types/runtime.ts`、`engine/checked-tool-execution.ts`；server 的 `session-goal-service.ts`、`run-admission-service.ts`、`run-control-service.ts`、`recovery/startup-recovery-service.ts` | 通用执行检查、预算动作、停止/恢复和启动对账 |
| B4 | `packages/client/src/resources/session-resource.ts`、`types/index.ts`；核对原 `state/reducer.ts` / `session-stream-state.ts` / `session-sync-controller.ts`；Desktop 的 `shared/session-types.ts`、`main/features/session/session-service.ts` / `session-subscription-service.ts`、`renderer/src/stores/desktop-session/types.ts` / `goal-actions.ts` / `store.ts` / `goal-refresh-scheduler.ts`；原 Composer / GoalBanner | 动作类型透传；usage 事件沿原订阅触发 GET，独立 seq 合并；轻量预算输入与展示。现有链路已满足的文件只补定点回归，不强制改代码 |

`0006_snapshot.json` 是当前最后结构快照。实施前若其他任务推进结构，核对最新文件再同步，不覆盖其他字段、不追加旧数据转换迁移。现有 HTTP actions 和 IPC 通道已能透传动作，按真实类型检查结果调整；不新增预算专用通道。

## 4. B1：单次尝试记录与当前格式

**交付：**没有运行调用也能测试重复报告、补账、完整性、memory 回滚和事件事务。此单元不启用 UI 预算。

**文件：**§3 的 B1 文件。测试新建 `packages/services/src/goals/goal-usage.test.ts`，复用 `goal-transactions.test.ts`、`database/temporary-control-records.test.ts`、`database/session-database.test.ts`。

### 4.1 类型与存储

- [x] 增加协议类型，SessionGoal 增 `tokenBudget?: number` 与必需 `usage: GoalUsage`；Create 输入增 `tokenBudget?: number`。初始 usage 全部计数为 0、incomplete=false、seq=0，时间取创建时间。正整数必须是 safe integer；budget 动作的 null 表示解除限制。

```ts
export interface GoalUsage {
  knownTokens: number;
  incomplete: boolean;
  unknownAttempts: number;
  partialAttempts: number;
  inFlightAttempts: number;
  runTimeMs: number;
  seq: number;
  updatedAt: number;
}
export interface GoalModelAttemptKey {
  runId: string;
  generationId: string;
  attempt: number; // >= 1
}
```

- [x] 新建 `session_goal_model_attempt`，主键是上述三个字段，另存 `goal_id / objective_version / session_id / provider? / model / purpose / state / known_input_tokens / known_output_tokens / inconsistent / raw_usage_json / started_at / finished_at?`。state 为 pending/unknown/partial/complete；purpose 为 generation/compaction/finalization/memory。goal_id 外键关联 Goal，增加 goal_id 查询索引。

`run_id / session_id` 保留派发时事实，**不加随 Child 会话删除级联的外键**，避免删子会话就抹掉 Goal 用量。第一次登记仍必须从现有 Run 验证归属。Goal 删除沿现有根会话生命周期清理。Goal 表增 `token_budget INTEGER`、`usage_json TEXT NOT NULL`；usage.seq 存在该 JSON 内，不加第二张汇总表。

- [x] TemporaryControlRecords 增 `goalModelAttempts` map，进入 capture/snapshot/restore/deleteSession。以**所属 Goal 是否为 memory**选择持久/临时存储，不用来源 Child 会话的 storage 判断。同步新库 SQL、当前 snapshot 和 inventory；不转换旧库。

### 4.2 服务内部接口

以下是 GoalOperations 的新增方法；`goal-usage.ts` 提供读写与纯合并，GoalTransactions 负责 storage.atomic、状态写入和事件。事件身份来自 host，模型输入无权设置这些字段。

```ts
type GoalAttemptStart = GoalModelAttemptKey & {
  sessionId: string;
  provider?: string;
  model: string;
  purpose: "generation" | "compaction" | "finalization" | "memory";
};
type GoalAttemptReport = GoalModelAttemptKey & {
  sessionId: string;
  status: "completed" | "failed" | "interrupted";
  usageStatus: "complete" | "partial" | "unknown";
  metering?: ModelTokenMetering; // §5.1 的单次报告，不是累计总账
  notDispatched?: true; // host 可证明 client 尚未被调用
};
// ModelTokenMetering 在 core/usage 定义；services 用类型导入，不导入 API。
beginGoalModelAttempt(input: GoalAttemptStart): { allowed: boolean; changed: boolean; goalId?: string; usage?: GoalUsage; budgetClosed?: boolean };
recordGoalModelAttempt(input: GoalAttemptReport): { changed: boolean; goalId?: string; usage?: GoalUsage; budgetClosed?: boolean };
refreshGoalRunTime(goalId: string): GoalUsage;
reconcileGoalModelAttempts(): number;
checkGoalBudget(goalId: string): { code?: "token_budget" | "usage_unknown"; budgetClosed?: boolean };
```

首次 begin 从 Run 的可信 metadata 派生 Goal/正文版本，并在同一事务检查允许执行后保存 pending。普通 Run 返回 allowed=true、changed=false，不伪造 Goal 记录。已有同键记录只验证派发描述相同后返回，不重置归属/数字/状态。

GoalAttemptStart / GoalAttemptReport 在 goal-usage.ts 导出；GoalTransactions 通过该文件的函数访问账本，不再建一个独立协调器。begin 的拒绝结果也可携带 budgetClosed=true（active 刚被预算关闭）；report 仅在本事务确实把 active 改为预算暂停时返回该标记。projector 提交后用该标记调用 requestBudgetStop，不用原因文字猜是否需要停运行。

report 必须有已登记记录，sessionId 匹配，使用登记时冻结的 Goal/正文版本；Run 已结束、Goal 已完成/取消或正文已改不阻止合法补账。来源 Run 如已随子会话删除，登记记录仍是权威派发证明，不能扫描其他 Run 猜归属。没有记录的 finished 拒绝入 Goal 账，不新增模型可写记账工具。

### 4.3 合并与汇总规则

- [x] 累计报告更新原行，分量分别保留已有已知最大值；只算差额，不把报告当新增增量相加。相同报告完全无操作、不递增 seq。
- [x] pending 单列 inFlight，不计为 unknown/partial；结算成 unknown/partial 或存在 inconsistent 才使 incomplete=true。正常正在飞行的请求不会把 Goal 立刻关闭。
- [x] complete 后更旧 partial/unknown 不降级，也不以旧部分报告重新增加数字。新 complete 若小于已有任一已知分量，保留数字、标 inconsistent；后续只有可信完整报告覆盖全部已知分量才能解除该矛盾。另一次调用成功不能清掉这行缺账。
- [x] 缺报告/非法字段维持 unknown/partial，knownTokens 只是可证明的小计，不能把缺值写成完整的 0。仅 host 的 notDispatched=true 且本行没有已知用量时，可结算为 complete/0；这是未发请求的事实，不是把未知账单补零。
- [x] 汇总该 Goal **所有正文版本**的尝试，knownTokens 求已知 input+output；一次有效变化在同一事务更新 usage、seq+1，并写 `session.goal.usage.updated`，payload=`{goalId, usage}`，sessionId 为 Goal 根会话。只改 usage 不增加 Goal.revision；若同时关闭预算则状态变更按 revision 写入。
- [x] 记账与预算关闭在同一事务，纯判断函数 `goalBudgetStopCode(goal, usage)` 只返回 token_budget / usage_unknown / undefined，规则见 §6；不复制到 provider 或 Renderer。
- [x] runTimeMs 由同 Goal 全版本根 Run（没有 parentRunId）的已落盘 startedAt/finishedAt 求和；Child 不相加，进行中不插值。projector 完成根 Run 后调用 refreshGoalRunTime，重放无变化不增 seq。启动中断后也刷新对应当前格式 Goal。

示例测试放在 withStore fixture；开始时 store 已有 s1/r1 和可信 Goal 绑定：

```ts
const key = { runId: "r1", generationId: "gen1", attempt: 1, sessionId: "s1" };
store.goals.beginGoalModelAttempt({ ...key, model: "m", purpose: "generation" });
const partial = { ...key, status: "failed" as const, usageStatus: "partial" as const,
  metering: { knownInputTokens: 8, knownOutputTokens: 2, completeness: "partial" as const,
    inputIncludesCache: true, raw: { input_tokens: 8, output_tokens: 2 } } };
store.goals.recordGoalModelAttempt(partial);
const once = store.goals.getGoal(goal.id)!.usage;
store.goals.recordGoalModelAttempt(partial);
expect(store.goals.getGoal(goal.id)!.usage).toEqual(once);
store.goals.recordGoalModelAttempt({ ...partial, status: "completed", usageStatus: "complete",
  metering: { ...partial.metering, knownInputTokens: 10, knownOutputTokens: 3, completeness: "complete" } });
expect(store.goals.getGoal(goal.id)!.usage).toMatchObject({ knownTokens: 13, incomplete: false, partialAttempts: 0 });
```

- [x] 另测事件失败回滚 row/usage/seq，memory 不落盘、删除 Child 不减账、正文版本变化后迟到补账、矛盾 complete 不减量、重复 begin 不重开完成记录。

**验证批次：**`pnpm --filter @vykor/services exec vitest run src/goals/goal-usage.test.ts src/goals/goal-transactions.test.ts src/database/temporary-control-records.test.ts src/database/session-database.test.ts`。结构 inventory 只生成一次：`pnpm --filter @vykor/services exec node scripts/update-schema-inventory.mjs`，再跑结构对应测试；不重置真实数据库。

## 5. B2：真实调用、缓存口径与所有已绑定后代

**交付：**真实假客户端生命周期能生成一行/次的记录；重试、压缩、子代理复用和后置辅助调用有明确来源。此处不把项目升级为所有外部工具的费用系统。

**文件：**§3 的 B2 文件与 projector/assembly。复用 api 三个 provider tests；core 的 `model-retry.integration.test.ts`、`buffered-model-retry.test.ts`；runtime 的 `event-source.test.ts`、`plugin-child-followup.test.ts`、`agent-post-run-child.test.ts`、`memory-runtime.test.ts`；projector tests。新建 API `token-metering.test.ts`。

### 5.1 一个单次报告类型

- [x] core `types/usage.ts` 定义并导出下列类型；现有 UsageSnapshot 增 `metering?: ModelTokenMetering`，现有 input/output/cache/cost 展示字段保留原含义。预算只读新 metering，不从原来已回填 0 的字段反推真实报告。

```ts
export interface ModelTokenMetering {
  knownInputTokens: number;   // 已知输入小计；不是未知字段的零值
  knownOutputTokens: number;
  completeness: "complete" | "partial" | "unknown";
  inputIncludesCache: boolean;
  raw: Record<string, unknown>; // 仅原 usage 字段，无提示词/凭据/响应正文
}
// api/providers/token-metering.ts
normalizeTokenMetering(raw: {
  input: unknown; output: unknown; cacheCreation?: unknown; cacheRead?: unknown;
}, inputIncludesCache: boolean, finalReport: boolean): ModelTokenMetering;
```

合法计数必须是非负 safe integer。inputIncludesCache=true：只加 input；缓存拆分缺失不妨碍总输入完整。false：输入小计为合法的 input/cacheCreation/cacheRead 之和；其中缺失/非法分量不能伪造为完整总输入。output 同样处理；所有必需分量有效且来自终结用量报告才 complete，没有任何有效分量才 unknown，否则 partial。合法原始零与缺失值不同。

各分量与求和都检查 safe integer；数值溢出标记报告不完整并保留可验证分量，不能用 NaN/Infinity 或截到预算值充当真实完整计量。

Anthropic 传 false，OpenAI prompt_tokens 和 Codex input_tokens 传 true。Anthropic 如上游格式明确提供“没有缓存”的零值就记 0；无法证明的缺省缓存字段保持 partial，不能在 Goal 层补 0。OpenAI 缓存明细只留诊断，不加第二次。更新三种适配器所有 usage 产出分支，避免只改无工具分支。流成功不自动证明用量完整；failed/interrupted 也可携带真正完整的终结报告。

- [x] OpenAI 请求参数在有工具与无工具时都设置 `stream_options: { include_usage: true }`，修正当前 `tools ? undefined : ...` 分支。provider 测试检查实际 createParams，并模拟有工具的流式终结 usage；不能只直接测试 normalizer。上游不支持或未返回用量时保留真实失败 / unknown，不静默补 0 或绕过有限预算。

```ts
expect(normalizeTokenMetering({ input: 10, output: 2, cacheCreation: 3, cacheRead: 5 }, false, true))
  .toMatchObject({ knownInputTokens: 18, knownOutputTokens: 2, completeness: "complete" });
expect(normalizeTokenMetering({ input: 18, output: 2, cacheRead: 5 }, true, true))
  .toMatchObject({ knownInputTokens: 18, knownOutputTokens: 2, completeness: "complete" });
expect(normalizeTokenMetering({ input: undefined, output: 2 }, true, true).completeness).toBe("partial");
```

### 5.2 派发前登记，终态后补账

- [x] 新增 host `model.attempt.started` 事件，data 为 generationId/attempt/model/provider?/purpose；主循环紧邻 client.streamMessage 前 await emit。projector 在同一事务执行 B1 begin（最终预算重查 + pending 记录）；拒绝时抛通用宿主限制错误，client 不被调用。output.generation.started 继续服务文本展示，不能代替辅助模型请求的登记。
- [x] 限制错误使用 §6.1 的统一判断。projector 在原 Child 补偿分支之前识别并重抛，不能为预算拒绝保存投影失败、补偿成功后返回或伪造结算。`AgentEventBus` 对已识别的限制错误原样抛出，其余 sink 故障仍包装为 AgentEventDeliveryError；保持原投递顺序、drain 和观察者隔离。开始事件的拒绝必须穿过真实 emit 返回到调用者。
- [x] buffered wrapper 增 `onAttemptStarted` async 回调，每次真实重试都在 client 前 await；compact client 转发 started/finished 到同一 execution.emit。最终停止与用量完整性使用 B2 报告，不复用失败后永远置位的 CostTracker 标记来做 Goal 真值。
- [x] 明确 `clientInvoked` 标志：登记失败不造 finished 或 unknown 行；登记已成功但 host 可证明 client 尚未调用便被取消，报告 notDispatched=true。一旦调用过 client，未拿到报告就是 unknown，不能根据网络错误文字断言“免费”。
- [x] projector 的记账入口在 Run 终态早退、同尝试 finished 去重、全局 lastAppliedSequence 过滤和文本恢复检查**之前**核验并处理原始 started/finished。对账变化提交后再发布事件。文本投影仍沿原顺序；Run/session 汇总可以保持原用途，不能再投入 Goal 账重复计算。
- [x] 第一次登记验证 Run/session/Goal/版本和派发参数；补账用登记身份，当前 Goal 不必 active。事件只来自 Runtime/core 的宿主路径，模型 GoalAssessment 的 payload、Tool input metadata 和父级 usage.updated 均不写账。

### 5.3 父子与后置调用

- [x] `AgentExecutionContext` / submit options 增可选宿主 limits 参数，准确接口见 §6.1；复用 A 的 TrustedChildRunParent 捕获并传递到每次 Child Run，不能挂到 Agent 实例上永久沿用。无父直接 send 保持不绑定旧 Goal。
- [x] active Goal 绑定的用户 Run、initial/edit/resume/continuation 全部计量；暂停/等待/阻塞时无关聊天不自动绑定。所有更深 Child 读取直接父 Run 的 A metadata。JobSend 继续走当次 controller，不回退到 handle 的创建时身份。
- [x] `session-post-run-maintenance.ts` 向 remember 传当次真实 origin Run、emit/limits；`agent.remember` / `AgentMemoryRuntime.remember` / extractMemories 增可选 host execution 参数，转发 buffered 开始/结束回调。不要猜“Agent 最后一次 Run”，不创建虚假 Run。post-run review 的可信 parent 参数同样带 limits；已停止 Goal 不另发总结/记忆/评审调用。
- [x] 后置辅助调用只允许明确 origin 的 purpose=memory 或 post-run Child；普通 generation 不可对终态 Run 再开启请求。Run 内子代理 finalization 仍是实际尝试并计费，但限制已经关闭时直接使用已有文本，不新发 finalization 请求。

独立定时工作流、全局记忆整理及第三方工具的服务商费用不自动归入 Goal。**由 Goal 运行触发的后置模型工作必须有来源或在发起前跳过**，不能发起一个无绑定任务规避检查；已有独立后台任务不追溯收费。若自动 Dream 路径不能携带当前 origin，Goal 来源的该次触发返回 skipped，保留其独立周期任务；不在 B 重写 Dream 调度器。

集成测试使用现有假客户端事件收集器：根生成 10、重试 3、压缩 5、Child 7、grandchild 2、memory 4，父/session 汇总随意变化，Goal 已知数仍为 31；子代理由新 Goal 复用时后续量只入新 Goal。终态后的完整补账更新 usage、但不恢复 cancelled/completed 或接纳旧评估。

**验证批次：**API provider 与 normalize 测试一起跑；core retry/compact 测试一批；runtime 子代理/后置/memory 与 server projector 各一批。mock 只替代模型网络，不能跳过真实 started/finished 投递和存储接口。

额外关键回归只补一个真实拒绝链：Child 的 started → AgentEventBus sink → projector → 有限预算拒绝，断言 emit 拒绝为宿主限制错误、client 调用次数为 0、没有 Child 投影补偿记录；随后正常终态/清理事件仍能投递。compact/retry 使用同一错误判断，不能吞掉后继续请求。

## 6. B3：共享检查、预算动作与停止恢复

**交付：**有限预算在全部实际执行入口生效，已有在飞请求正常结算，关闭检查不会触发死锁或追加总结调用。

**文件：**§3 的 B3 及 B2 的 limits 透传。复用 `session-goal-service.test.ts`、`run-admission-service.test.ts`、`run-control-service.test.ts`、`startup-recovery-service.test.ts`、`checked-tool-execution.test.ts`、runtime child tests。

### 6.1 最小宿主接口

- [x] 在 core `types/runtime.ts` 定义通用接口和 `AgentExecutionLimitError`；core/Runtime 只调用或中止，不理解 Goal/Token/权限策略，不导入 server/services。

同时导出 `isAgentExecutionLimitError(value)`，使用与现有 ModelRequestFailure 相同的 `Symbol.for` 品牌识别方式，避免多个包构建副本使 instanceof 失效。projector、EventBus、compact 和 retry 共用这一判断，不用错误文字或 Goal 停止原因猜异常类型；不新增通用异常框架。

```ts
export interface AgentExecutionLimits {
  check(boundary: "run" | "model" | "tool" | "child" | "maintenance"): void | Promise<void>;
}
// server SessionGoalService 的宿主方法
checkExecution(goalId: string, objectiveVersion: number): void; // 拒绝则抛宿主限制错误
requestBudgetStop(goalId: string): void; // 非阻塞通知清理，不在事件回调里等待本 Run
```

server 为本次执行构造闭包绑定 Goal/正文版本，注入 submit/maintenance 参数；新增 Child 自动传该次闭包，不能由模型 metadata 设置。check 检查 active、正文匹配，以及 B1 的唯一预算规则；批准与用户优先继续复用 Admission/工具权限链。主模型登记事务仍是派发前最后重查，避免异步间隙。

- [x] 检查点具体落入：persistGoalRun/dispatchPersistedRun/prepareRunExecution；main/buffered 每次模型尝试；checked-tool-execution 在批准结束后、实际 invoke 前；Child spawn 在分配环境前、send 的排队 Run 真正 begin 前；后置 remember/review 发起前。
- [x] 工具批次逐个复查，串行等待与批准结束后重查；已运行工具保留原取消上下文和最终结果。limits 不替代权限、工具白名单、次数限制或 A 的版本验证。
- [x] 限制错误直接结束本轮：compact 的 non-fatal catch、重试和 child finalization 必须识别并重抛该错误，不能将它当普通网络问题继续调用。无 limits 的普通任务保留原行为。

### 6.2 一份预算判定与原控制器清理

```ts
// goal-usage.ts 中的纯规则；incomplete 不包含正常 pending。
function goalBudgetStopCode(goal: Pick<SessionGoal, "tokenBudget">, usage: GoalUsage) {
  if (goal.tokenBudget === undefined) return undefined;
  if (usage.knownTokens >= goal.tokenBudget) return "token_budget" as const;
  if (usage.incomplete) return "usage_unknown" as const;
  return undefined;
}
```

- [x] 记账/预算修改/执行检查需要关闭时，同一事务保存 paused + code、撤销 pending 自动续跑。只对 active 当前 Goal 转状态；迟到补账不覆盖 user_paused/updating_objective 等用户原因，不改 completed/cancelled。即使 reason 保留用户暂停，恢复仍依据当前账检查。
- [x] 事务提交后 requestBudgetStop 复用 RunControl.cancelGoalRuns 与 A 的 interruptRun/stopGoalChildren；预算停止按**该 Goal 所有正文版本**查尚在活动的 Run，不只当前版本。清理失败保留 paused 和具体说明，后续 resume 继续检查实际活动记录，不伪改已停。

具体调整为 `RunRepository.listGoalRuns(goalId, objectiveVersion?: number)`，省略版本读取全部；`RunControl.stopGoalChildren(sessionId, goalId, objectiveVersion: number | undefined, reason)`，预算停止传 undefined，A 的正文编辑仍传具体版本。resume 的活动检查也调用无版本过滤的查询。
- [x] **避免循环等待：**projector 正在 await 的模型/工具事件里，不能 await stopRuns 等待当前 Run 的 result。先关闭检查和请求 interrupt，再从原执行完成/控制器路径 await 清理；有界 Promise 的错误进入现有日志与停止说明，不建常驻后台队列。已经派发的 usage 报告继续接纳。
- [x] 使用已有 assessment/evidence/工具记录生成宿主停止说明：已知/不完整用量、未完成工作或“尚无有效评估”、停止原因、预算/次数恢复方式。没有模型调用来写停止摘要，不承诺回滚已经完成的副作用。
- [x] 关闭与完成按事务提交顺序：先 completed 后迟到超额仅补账；先 paused/token_budget 后旧 complete 建议不能恢复/完成 Goal，沿 A 的 active/currentRun/正文保护。

### 6.3 用户 budget 动作

- [x] actions 加 `budget`，要求 requestId/expectedRevision/tokenBudget；仅此动作接受正 safe integer 或 null。创建只接受可选正整数。budget 不接受 response/additionalAutoTurns/questionId，其他动作也不接受 tokenBudget，沿 parser 校验。
- [x] service.action 在原 command 去重下处理 budget 分支：重读最新 usage，不允许有限值低于 knownTokens；更新总 budget 和 revision，objectiveVersion 不变。等于已知量可保存但余额为 0，不能恢复。字段 null 清除限制。
- [x] 改 budget 不自动 resume。当前 active 若新有限预算面对 incomplete，保存预算同时暂停 usage_unknown；paused 下保存预算不打开执行。resume 不默认加 Token，additionalAutoTurns 只加次数；复用 A 的等待派发候选也必须检查预算。
- [x] resume 要求有限预算 usage.incomplete=false、knownTokens<tokenBudget，以及该 Goal 全版本运行清理完毕，再通过 A 的批准、用户工作、问题和次数检查。B 不提供“忽略缺账”动作；用户可显式 budget=null 后单独继续，incomplete 提示仍保留。
- [x] 更新正文、等待结果完成、批准通过和普通消息都不能越过关闭的预算。编辑可保存新的正文，但未通过预算时不派发执行；不要先停止旧工作后留下一个已接纳请求却无法恢复的悬空结果。把“已保存新正文但因限制未运行”的 Goal 快照作为完成的编辑请求结果；只有有效预算/恢复动作再启动。

请求示例：

```ts
const changed = await service.action("s1", goal.id, {
  requestId: "budget-1", expectedRevision: goal.revision, action: "budget", tokenBudget: 50000,
});
expect(changed.objectiveVersion).toBe(goal.objectiveVersion);
expect(store.runs.listGoalRuns(goal.id)).toHaveLength(beforeRuns.length);
expect(await service.action("s1", goal.id, {
  requestId: "budget-1", expectedRevision: goal.revision, action: "budget", tokenBudget: 50000,
})).toEqual(changed);
```

### 6.4 当前格式重启

- [x] 在原 StartupRecoveryService 的 interruptActiveRuns 后、pauseActiveGoals/recoverGoalWaits 前调用 reconcileGoalModelAttempts：仅当前账本的 pending 尝试转 unknown，保留已知量，刷新根 Run 时间与 seq，有限预算 active Goal 应先暂停 usage_unknown/token_budget。随后保留 A 的默认暂停/只读等待恢复；禁止启动模型对账。
- [x] late complete 可解除对应 unknown，但不自动 resume；没有记录的旧 finished 不补建行。memory 不参与重启恢复。reconcile 重播无变化不递增 seq。

**关键回归：**已知 19、预算 20，两个请求都已授权；第一个落账到 22 后第三请求/下一工具/Child 拒绝，第二个仍补账到 25。partial/unknown 后另一次完整成功仍不恢复有限目标；取消前未调用 client 的记录完整 0，与已调用却无报告的 unknown 区分。fake emit 内关闭后 Run 能退出，不因互相 await 挂住。预算修改两客户端 revision 冲突；相同 request 重试不新 Run；当前格式重启 pending→unknown→late complete 只补账。

**验证批次：**server service/admission/control/recovery 一起跑；core 与 Runtime 执行边界测试一起跑。B3 未完成前，B1/B2 不单独对用户宣称预算可用。

## 7. B4：用量事件与原 Banner 展示

**交付：**可设置可选总预算、看到真实小计/缺账/在飞数量/累计运行耗时；状态与用量不会因事件乱序相互回退。

**文件：**§3 B4。复用 client `state/__test__/session-sync-controller.test.ts` / `sync.test.ts`，Desktop Main `session-subscription-service.coalescing.test.ts`，Renderer `store.integration.test.ts` / `goal-refresh-scheduler.test.ts` / `goal-actions.test.ts`，以及 `goal-banner.test.tsx`。只用现有输入框/按钮，不为纯格式新建组件库或页面。

- [x] `session.goal.usage.updated` 进入服务端 event-registry，沿用 protocol 的默认 schema version=1（现有版本函数并非类型白名单，无需新增覆盖）；沿根会话的现有访问检查订阅。原 SSE / SyncEventUpdate.event 保留完整事件并推进游标；不在 Client bucket 新建 Goal 状态，也不扩充服务端 SessionStateSnapshot 或 DesktopSessionView 来携带 Goal。
- [x] 固定复用当前 GET 刷新路径：usage 事件进入 `session-subscription-service.ts` 的 non-part-delta 分支 → 标记 requireSnapshot，经原合并窗口 / ACK 派发 DesktopSessionUpdate snapshot → Renderer `store.ts` 的 snapshot 分支调用 `goalRefreshScheduler.schedule(sessionId)` → 原 getGoal 返回完整 Goal/usage → `saveGoal` 合并。重连的 snapshot 同样触发 GET。只改事件白名单、动作类型和合并逻辑，已有链路用定点回归确认；不新建监听、预算 IPC 或 Goal 快照生成器。
- [x] Goal 状态快照先按 revision 决定是否接纳状态，再按相同 goalId 的 usage.seq 选择最新 usage；不能因状态较旧而丢弃其中更新的 usage，或因新的状态快照回退用量。不同 goalId 不相互合并，删除会话继续清理旧缓存。

```ts
// 本例在现有 saveGoal 中实现；current/incoming 同 goalId 且非空。
const statusGoal = current.revision > incoming.revision ? current : incoming;
const usage = current.usage.seq > incoming.usage.seq ? current.usage : incoming.usage;
const merged = { ...statusGoal, usage };
```

usage-only 事件在 Desktop 只通知刷新，不直接替换 objective/status/revision；GET 和动作响应的状态按 revision、用量按 usage.seq 合并。同 seq 重复报告不推进用量，不根据 updatedAt 猜用量先后。取消响应也保留取消 Goal 的账本快照，是否隐藏 Banner 复用 dismissedGoalId 等已有展示状态，避免迟到补账失去比较基线或把取消目标变 active。

- [x] 创建 Goal 模式可留空预算，严格解析正整数；原 maxAutoTurns 保留。编辑正文不隐式改预算，详情用 budget 动作设置总量或显式解除。busy/requestId/错误草稿沿现有 GoalActions，不新增保存状态机。
- [x] Banner 详情显示“已知使用 X Token”；不完整时“至少使用 X Token，用量不完整”，列 unknown/partial/在飞数量。有限预算并列总 budget，显示超额真实值，不截成预算值；没有预算显示“未设置 Token 限制”。次数仍叫自动续跑次数。
- [x] 耗时显示服务端“累计运行耗时”，根 Run 区间求和、Child 不相加；不显示假实时插值。使用 A 的停止原因函数 token_budget/usage_unknown 文案。
- [x] 按钮仍由后端裁决：预算调整不自动继续，解除预算后需显式继续，未决批准和未清理工作仍拒绝。保留“可能存在已派发用量”的提示，不提供绕过批准或把估算当真实用量的入口。
- [x] 按 AGENTS 由用户查看样式；实施仅做必要代码检查和已有 DOM 行为测试，不搭预览、截图或视觉 E2E。

**回归样例：**当前 status revision=8、usage.seq=10；后收到 revision=9/usage.seq=8，状态更新但用量保留 10；再收 revision=7/usage.seq=11，状态保留 9、用量变 11。取消后 usage-only 补账仍更新小计，不能变 active。

链路回归覆盖 client 接受 usage schema 且仍产出 SyncEventUpdate；Main 的孤立 usage 事件及与文本 delta 同窗口事件最终派发 snapshot、等待 ACK 后不漏刷新；Renderer snapshot / 重连均触发原 GET，返回较旧状态与较新 usage 时按上例合并。GET 网络 stub 即可，不跑浏览器 E2E，不搭新的集成测试系统。

## 8. 验收、轻量检查与交付顺序

| 规格 | 计划落点 | 必须看到的行为 |
| --- | --- | --- |
| B1 | B1 合并 / B2 独立记账入口 / B3 启动对账 | 重放一次计量、终态补账、complete 不被旧 partial 降级 |
| B2 | B2 根/后代/辅助来源 | 原始尝试相加；复用 Child 不串 Goal；父汇总不重复 |
| B3 | B2 provider normalizer | Anthropic 缓存分列、OpenAI/Codex 包含口径；缺字段保留不完整 |
| B4 | B1 每行完整性 / B3 共享检查 | 缺账未解决有限预算停止；无限预算保留次数与不完整提示 |
| B5 | B3 并发/派发重查 / B4 展示 | 已派发可超额补账，后续请求拒绝，不把显示截到上限 |
| B6 | B3 原 RunControl 清理 | pending 撤销、运行合作停止、无追加总结模型调用、无事件等待死锁 |
| B7 | B3 action/edit/wait/start / B4 seq | 编辑、加次数、普通消息与等待不绕预算；状态/量独立收敛 |

实施结束时集中跑实际新增/修改的上述测试；A 的 service、Child 复用、wait observer/verifier 和普通 Goal-free 回归保留在同一批检查，不重复全仓测试。测试重跑只因新修改、失败或未解决风险。

- [x] `pnpm --filter @vykor/api --filter @vykor/core --filter @vykor/protocol --filter @vykor/services --filter @vykor/agent-runtime --filter @vykor/server --filter @vykor/client run check-types`；Agent Runtime 的 dist 若过期，按现有 build 刷新，不能用 any 掩盖接口。
- [x] `pnpm --filter @vykor/desktop run typecheck:web`；涉及 Main 参数透传时加 `typecheck:node`；`pnpm --filter @vykor/services run db:check`；`git diff --check`。
- [x] 一名子代理集中审查预算口径、pending/unknown、原始事件身份、停止死锁、全版本累积和 seq 合并；主代理修订后只复核具体问题。文档审核不代替实施代码审核。
- [x] 更新 `docs/session-goals-design.md` 已交付的 B 部分与路线状态，不宣称 C 已支持。实际 commit/push 只按用户指令，收录本任务文件；不清理其他任务改动。

建议提交单元：B1 `feat(goal): persist model attempt usage`；B2 `feat(goal): meter bound model calls and descendants`；B3 `feat(goal): enforce shared token limits`；B4 `feat(desktop): show goal usage and total token budget`。**B 整体在 B3/B4 验收前不标记交付**；不存在只有 Banner 输入却未接通执行检查的“预算功能”。

实施预算控制：两名实现代理分别负责账本/协议和模型/Core/Runtime，主代理负责服务端与 Desktop；一名集中审查者与必要定点复核。运行受影响回归和类型/结构检查，不跑全仓套件或真实模型，不虚构用户未提供的 Token 数值预算。
