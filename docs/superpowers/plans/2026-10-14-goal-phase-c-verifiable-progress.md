# Goal C 阶段实施计划：准备澄清、正式条件与可核实进展

> **面向执行者：**使用 `executing-plans`，按 C1 → C2 → C3 → C4 实施，复选框记录进度。用户要求优先：关键回归集中运行，一名子代理集中审核和必要定点复核，不逐步骤审批、重复全仓测试或强制提交。
> 日期：2026-10-14。状态：C1–C4 已实施，集中验证与实现审核定点复核通过。计划审查见 [C 计划审查](../reviews/2026-10-14-goal-phase-c-plan-review.md)；交付见 [C 实施审查](../reviews/2026-10-14-goal-phase-c-implementation-review.md)。
> 基线：当前 `codex/goal-phase-b` 工作区；HEAD 为 `f364f7c9`，A/B 仍有未提交实现，单独检出该提交不包含交付基线。
> 规格：[Goal spec §3、§4、§7–9、C1/C2/V1/V2/E1/E2/L1/L2](../specs/2026-10-14-goal-reliability-and-budget-design.md)。依赖：[B 实施与审核](../reviews/2026-10-14-goal-phase-b-implementation-review.md)。

**目标：**明确目标先整理条件再执行，模糊目标只问必要问题；用户变更可追溯，完成逐项核验，连续三轮没有可信推进时有依据地停止。

**架构：**准备和执行仍走原 Goal-linked Run 与会话队列；SessionGoalService 接纳用户输入、结算建议并决定续跑。版本文件只管存取，证据读取器只核对已有记录，进展 policy 只计算事实与计数。Runtime 提供绑定的 GoalRead/GoalAssessment 与通用限制，Desktop 沿 B 的 snapshot → GET 展示当前 Goal。

**技术栈：**TypeScript、SQLite / Drizzle、现有事务与 memory controls、Agent Runtime、HTTP/SSE、Vitest、Desktop React。

## 1. 全局约束与具体取舍

- 保留六个 GoalStatus、A 的可信父子 Run/等待、B 的总量/缺账/取消补账、requestId 去重、用户优先与批准检查。phase 仅为 preparing/executing，不是另一套状态机。
- 只维护当前格式，不转换 A/B 旧格式的已有数据库记录，不回填版本或旧评估，不双读旧字段，不删除或重建真实数据库。当前格式的旧正文版本、迟到事件、同请求重试及重启恢复继续保护。
- C 只新增一张 `session_goal_version` 表；沿用 B 已实现的 `session_goal_model_attempt` 和三元唯一键，不按规格早期表名另建账本。准备计数放现有请求结果，进展与证据复核放现有 assessment JSON。
- 最多新增四份生产文件：`services/goals/goal-version.ts`、`agent-runtime/goal-read-tool.ts`、server 的 `goal-evidence-reader.ts` / `goal-progress-policy.ts`。不建立准备服务、需求服务、提案工作流、Critic、评分平台或恢复队列。
- 准备阶段只整理条件；次数仅作诊断计数，复用通用运行上限、用户预算和常规模型输出设置，不再设专属 5 次模型 / 4 次调查 / 1024 输出硬限额。明确条件直接 ready，必要时才读取用户引用材料；无子代理、部署、实质文件修改或长后台任务。
- 条件最多 **64 项**，正文继续 32000 字符。沿用协议的 4000 字符说明、256 字符标识符及 32 条证据引用上限；超限要求用户拆分，不静默丢条件。
- 源码只能核验身份、引用文本、工具结果、摘要及环境等事实，不能数学证明自由文本语义。来源可信不等于结论正确；模型整理与当前审查仍不可省。
- 首版进展仅 `requirement_satisfied / artifact_changed / external_terminal`。无量化指标的文档/视觉任务可以使用交付物审查或用户验收；不强迫填 QPS，不让模型发明性能阈值。
- 不设置用户未指定的数值 Token 预算。没有预算仍受准备批次、自动续跑次数和三轮保护；refine/pivot/resume 不清零总量或次数。
- 原规划轮仅交付计划；本轮按用户授权完成实施，回归及结构检查见实现审查。不搭 UI 预览、截图或视觉 E2E。

## 2. 当前入口与任务责任

| 现有事实 | C 必须改变的地方 |
| --- | --- |
| create/update 直接保存并派发 initial/edit；settleRun 只有一种执行结算 | 先派发 preparation，终态 ready 才在事务冻结并保存唯一 initial；按 Run 的可信 phase 分流 |
| GoalRunBinding 只有 ID/版本/正文，GoalAssessment 每轮自由列要求 | 摘要和 GoalRead 共用当前快照；正式集合只读，评估使用 requirementId |
| `classifyGoalCompletion` 先 needs_user 后 incomplete | 先查完整集合、客观缺项和证据，再决定是否只剩用户验收 |
| progress + 新工具签名可归零，历史签名按整个 Goal 查询 | 读取当前版本已核实信号，换日志/阻塞文本不能归零 |
| B 的 limits.check 只拿边界名 | 只读工具计数需可信工具描述；输出上限需每 Run 的通用参数，不能只靠提示词 |
| Write 只在短摘要里写截短 hash；Edit 没有内容摘要 | 不能解析摘要冒充证据；补最小可信文件观察/修改回执 |
| B 的 GET 能读最新终态，慢查询可补读一次 | 保持该链路；不扩充 Client bucket、SessionStateSnapshot 或新增 Goal 页面 |

路径以下均从仓库根目录开始；同文件任务顺序实施，避免代理同时改。

| 单元 | 文件 | 唯一责任 |
| --- | --- | --- |
| C1 | `packages/protocol/src/session-goals.ts` / `session-goals.test.ts`；services `goals/goal-records.ts` / `goal-repository.ts` / `goal-transactions.ts` / `index.ts` / 根 `index.ts` | 当前条件、阶段、版本/请求类型与原子存储 |
| C1 | 新建 `packages/services/src/goals/goal-version.ts` / `goal-version.test.ts`；修改 `session-runtime/schema.ts` / `store.ts`、`database/temporary-control-records.ts` 及测试、现行 SQL / 最新 snapshot / inventory | 版本行存取、memory journal、当前格式；不调模型 |
| C2 | server `application/session/session-goal-service.ts` / `run-admission-service.ts` / `session-run-executor.ts` / `session-run-assembly.ts` / `session-post-run-maintenance.ts` / `run-auto-review.ts`；`application/agent/daemon-agent-event-projector.ts` / `application/daemon-application.ts` / `application/recovery/startup-recovery-service.ts` | 批次、阶段接纳、准备限制、恢复记录与 ready 唯一派发 |
| C2 | runtime `agent.ts` / `framework-agent-run.ts` / `goal-extension.ts` / `goal-assessment-tool.ts` / `run-capability-view.ts` / `index.ts`；新建 `goal-read-tool.ts` 及测试；core `types/runtime.ts` / `engine/query-engine.ts` / `query-tool-permissions.ts` / `checked-tool-execution.ts` / `compact-service.ts` | 绑定摘要/只读查询；通用输出上限与工具检查，准备不开放副作用 |
| C3 | 原 Goal service/policy、protocol、goal-version；HTTP `packages/server/src/http/routes/session-goal.ts`；新建 `packages/server/src/application/session/goal-evidence-reader.ts` 及测试 | 用户变更、覆盖/验收、来源与当前有效性核对；不扫描工作区或运行验收命令 |
| C3/C4 | `packages/tools/src/file/read.ts` / `write.ts` / `edit.ts` / `apply-patch.ts`；core `types/tools.ts` / `engine/tool-result-feedback.ts` / `checked-tool-execution.ts`；原 projector | 可信回执及保留事实，不理解 Goal、不根据普通 metadata 自报信任 |
| C4 | 新建 `packages/server/src/application/session/goal-progress-policy.ts` 及测试；原 goal service/policy、services assessment 查询 | 三类信号去重、两种无进展计数和停止说明 |
| C2–C4 UI | client `types/index.ts` / `index.ts` / `resources/session-resource.ts`；Desktop 原 `shared/session-types.ts`、`renderer/src/stores/desktop-session/types.ts` / `goal-actions.ts`；Composer / GoalBanner / conversation-page | 类型透传、澄清/变更/指定项验收，沿 B 的独立 seq 合并 |

## 3. C1：当前契约与不可改写的版本记录

**交付：**从空库创建当前格式，版本和请求记录能原子保存、去重、重开；此单元不单独对外开启新的执行流程。

### 3.1 最小字段

- [x] SessionGoal 增 phase、requirements、stagnationCount 及准备期的 `preparationEpisodeId?: string`；该指针在接纳新批次的同一事务保存，冻结时清除，使预算暂停清 currentRun 后仍能找到唯一当前批次，不能按“最新 Run”猜。正式状态仍从当前 assessment 派生，没有第二份需求状态表。requirements 是冻结定义，不能因验收把版本行原地改写。GET 的 `versionSummary: { changeKind; changeReason; createdAt }` 从当前版本行组装，不在 Goal 表重复维护变更正文。

```ts
type GoalPhase = "preparing" | "executing";
type GoalChangeKind = "create" | "refine" | "pivot";
type GoalUserActor = { kind: "local_user" } | { kind: "authenticated_user"; id: string };
type GoalRequirementSource =
  | { kind: "input"; inputId: string; quote: string }
  | { kind: "document"; path: string; digest: string; quote: string; evidencePartId: string };
interface GoalRequirement {
  id: string;
  text: string;
  source: GoalRequirementSource[];
  verification:
    | { kind: "check"; method: string; command?: string; environment: string; expected: string }
    | { kind: "artifact_review"; artifact: string; standard: string }
    | { kind: "user_acceptance"; question: string };
  constraints: string[];
  replaces?: string[];
}
interface GoalVersion {
  goalId: string; objectiveVersion: number; previousVersion?: number;
  objective: string; requirements: GoalRequirement[]; frozenAt?: number;
  changeKind: GoalChangeKind; changeReason: string;
  requestId: string; actor: GoalUserActor; inputIds: string[]; createdAt: number;
}
```

preparedRequirements 是去掉 id/replaces 的候选，可携带 `previousRequirementId?: string`；宿主分配/复用正式 ID。来源引用必须能回到该版本的可信用户 Input 或准备允许读取的文档记录。input.quote 检查确实存在，document.digest 使用可信读取回执；这一检查不声称完成语义证明。

- [x] `session_goal_version` 主键 `(goal_id, objective_version)`，存上述正文/条件 JSON、变更、请求/actor/输入身份及冻结时间，Goal 删除跟根会话生命周期清理。初始版本 1 的未冻结行可补入准备答复与首次冻结；已冻结定义不可 update。
- [x] Goal 行增加 phase/requirements_json/stagnation_count/preparation_episode_id。现有 request.result 增 `preparation`；memory controls 只增加 versions map，纳入 capture/snapshot/restore/delete。初始化 SQL、当时最新 snapshot 与 inventory 一次同步，不追加旧数据转换。

```ts
interface PreparationEpisode {
  episodeId: string; // 接纳的用户 requestId
  goalId: string; objectiveVersion: number;
  inputIds: string[]; modelAttempts: number; readToolCalls: number;
  runId?: string; readyRunId?: string;
  state: "accepted" | "running" | "waiting_user" | "ready" | "stopped";
}
// GoalOperations 新增；GoalTransactions 负责 atomic / 事件，goal-version.ts 只读写。
getGoalVersion(goalId: string, objectiveVersion: number): GoalVersion | undefined;
beginGoalVersion(input: GoalVersion): GoalVersion;
appendGoalVersionInput(goalId: string, objectiveVersion: number, inputId: string): void;
freezeGoalVersion(input: { goalId: string; objectiveVersion: number; expectedRevision: number;
  runId: string; requirements: GoalRequirement[] }): SessionGoal;
getPreparationEpisode(episodeId: string): PreparationEpisode | undefined;
reservePreparationTool(episodeId: string, runId: string): void; // 核对当前 Run 后，第 5 个拒绝
listGoalAssessments(goalId: string, objectiveVersion: number): GoalAssessment[];
```

beginGoalVersion 同键/同 request 重播返回原行；不同提交拒绝。freeze 检查当前 active、phase=preparing、同版本/episode、真实 completed Run、未消费建议与预算；通常匹配 currentRun，预算暂停后显式 resume 可在同一事务核对 episode.readyRunId 并冻结，不能放开任意旧 Run。已经冻结的重播只读取结果，不再创建 initial。唯一 initial 由原 continuation 表/请求结果记录，不加意图表。

- [x] PATCH 必须提供 `changeKind: refine|pivot`、非空 changeReason。refine 若明确替换既有条件，增加可选 `replaceRequirementIds: string[]`，只能从旧版本集合选择；补充条件不用填。该小字段使“替换客观条件”有可信用户授权，不建立提案流程。pivot 的显式方向变更允许重整旧集合，仍须保留前后差异及原因。
- [x] user wait 增 `purpose: clarification|acceptance`、objectiveVersion，acceptance 增 requirementIds。actions confirm/resume 回答必须带该 wait 的 objectiveVersion；普通无问答 resume 不用模型/客户端自报版本覆盖宿主。拒绝旧结构，不按 questionId 前缀猜用途。

GoalAssessment 保留原可信绑定与说明字段，preparing 的 ready 必须带 preparedRequirements；waiting_user 必须说明当前最少问题，blocked 保留可读原因，不能自定正式 ID。executing 使用完整 requirementId 集合和 progressSignals，禁止准备字段。派发始终按 Run.goalPhase 校验，不能仅改工具枚举而沿用旧 phase 无条件 parser。

**回归样例：**同 request 创建一次 version 1；首次冻结仍是 version 1；状态/预算/用户验收不改版本；正文或正式定义改变才产生 version 2；临时版本冻结事件失败时 Goal/版本/请求全部回滚；重开当前格式数据仍在，旧格式不做读取适配。

```ts
const once = store.goals.beginGoalVersion(version1);
expect(store.goals.beginGoalVersion(version1)).toEqual(once);
expect(() => store.goals.beginGoalVersion({ ...version1, requestId: "other" })).toThrow();
expect(store.goals.getGoalVersion(goal.id, 1)?.frozenAt).toBeUndefined();
```

## 4. C2：受限准备、澄清与 GoalRead

**交付：**创建后只能整理条件；明确/主观目标可以直接 ready，真正缺少关键选择才提问；整个批次受 B 的真实预算保护。

### 4.1 批次与派发

- [x] create 保存 Goal preparing、原用户 Input、version 1、request.result.preparation、唯一 preparation Run，在同一事务完成，提交后原队列派发。用户原文 Input 直接使用现有 `conversationTransactions.admitPrompt(...)` 保存；它本身不创建 Run，不能虚构 createRun 参数。运行记录保存可信 `goalPhase / goalEpisodeId / goalRunKind=preparation`。
- [x] 原开跑检查核对 phase 与 metadata，不把 preparing 当可执行任务。准备不加 autoTurnsUsed；用户无关聊天仍按 A/B 规则，不能偷偷转成 executing 或换 episode。goalSettled 仍阻止同 Run 结算两次。
- [x] beginGoalModelAttempt 在 B 同一登记事务中，对首次新尝试递增所属 episode.modelAttempts，仅作诊断，不设置准备专属调用上限。已有键重播不再计数。generation/compaction 都记录；用户 Token 预算继续按 B 的账本检查。
- [x] resume 增仅 preparing 可用的 `reprepare?: true`，对应 UI“重新整理目标”。只有该显式新用户提交、create/update 或有效关联回答开启新批次；普通 resume / 同请求重试 / 网络重新派发 / 重启延续原批次及计数。终态准备 Run 需要再跑时可创建同 episode 的新 Run，仍受用户预算和通用执行限制保护；不复用已终态 Run 执行。暂停/预算变更本身不新开批次，模型没有入口。

### 4.2 实际执行限制

```ts
// 扩展 B 的可选通用接口，core 不认识 Goal/episode。
interface AgentExecutionLimits {
  check(boundary: "run" | "model" | "tool" | "child" | "maintenance",
    tool?: { toolName: string; toolAttemptId: string }): void | Promise<void>;
}
// submit → execution 的通用、每 Run 参数；不改 Agent 全局配置。
interface AgentExecutionProfile {
  maxOutputTokens?: number;
  executableHooks?: boolean;
}
// 仅宿主注册的工具贡献可要求成功提交后结束；模型参数/普通工具 metadata 无此能力。
// 原 AgentRunToolContribution 增 endRunOnSuccess?: true。
// VykorAgentSubmitOptions / FrameworkAgentRunOptions / AgentExecutionContext 增 profile?: AgentExecutionProfile。
// runtime 的 GoalReadSnapshot 是独立 DTO，不给 core 增 Goal 类型，不新增 runtime→services 依赖。
interface GoalReadSnapshot {
  goalId: string; objectiveVersion: number; phase: "preparing" | "executing";
  objective: string; sourceInputIds: string[]; // 当前版本允许引用的用户输入，正文仍在原消息上下文。
  requirements: Array<{ id: string; text: string; verification: string;
    status: "incomplete" | "satisfied" | "needs_user" }>;
  latestAssessment?: string; waitSummary?: string; stopReason?: string;
  autoTurnsUsed: number; maxAutoTurns: number;
  knownTokens: number; usageIncomplete: boolean;
}
```

- [x] preparing 复用常规模型输出配置，不注入专属 1024 Token 截断。准备不运行 auto-review、remember/Dream 或可执行用户/插件 hooks，避免只禁工具却从其他路径写入；`query-tool-permissions.ts` 当前在批准后执行 pre_tool_use hook，必须受同一 profile 禁止，原权限裁决仍执行。普通 Run 不注入 profile，保持原行为。
- [x] RunCapabilityView 只保留已捕获的 builtin Read/Glob/Grep、身份及执行函数与宿主可信快照一致的替代实现，以及两项宿主 Goal 工具；去掉 agents/MCP/插件 UI 动作/会改变权限的控制工具。不按名称前缀判断只读，也不把 Shell 中的“只读命令”加进白名单。注入的 skills/资料仍是数据，不能扩权。保留原路径、环境与批准检查。
- [x] checked-tool-execution 在批准/串行等待之后、invoke 前传可信工具描述；宿主在 `reservePreparationTool` 的事务中计一次已授权调查派发，仅作诊断。GoalRead/GoalAssessment 不计调查，依据实际宿主定义身份区分。非法/被拒工具不执行；limits 对 child/maintenance 直接拒绝。
- [x] 准备内 `GoalAssessment` 只允许 ready/waiting_user/blocked；ready 必须有完整候选和来源说明，不能 complete。执行内禁止 ready/preparedRequirements，不能重定义正式条件。原 projector 仅保存绑定建议，phase 校验来自 Run/Goal，不能信任模型自报。
- [x] 准备的 GoalAssessment 贡献设置 `endRunOnSuccess: true`。QueryEngine 在整批工具结果保存/交付、失败与取消检查之后，识别该捕获定义的成功调用，关闭 steering 并正常 return；不再调用模型写收尾文字，不提前跳过同批结果。执行的 GoalAssessment 和普通工具不设置该标志。不要用 `hardMaxTurns=2` 代替批次限制：当前最后一轮会去掉工具，反而使第 2 次无法提交建议。宿主冻结仍在 Run completed 后发生，无效候选暂停/澄清，不通过工具返回自行切执行阶段。

### 4.3 终态、冻结与回答

- [x] settleRun 按真实 preparation Run 分支结算；准备分支不能先执行现有 executing 分支的 finishGoalRun/goalSettled 标记再尝试冻结，也不能因预算已清 currentRun 就丢掉绑定候选。ready 先核对来源、范围/约束覆盖及完整性，把已接纳且真实 completed 的候选来源记为 episode.readyRunId/state=ready，正文建议仍在原 Run metadata，不复制另一份契约。再在单一事务冻结 version、切 executing、清 currentRun/wait、保存唯一 initial，成功后才标候选已消费/准备 Run 已结算。initial 输入 ID 固定为 `goal-initial-${goalId}-${objectiveVersion}`，原 request.result 保存 initialRunId，Run metadata 保存 goalPreparedBy={episodeId,preparationRunId}。
- [x] ready 被 B 预算或用户暂停挡住时，保留未消费候选及原计数，Goal 保持 paused，不自动派发。预算恢复后的**普通显式 resume**优先重新核对同版本/episode/来源与所有 A/B 接纳条件，原子冻结并保存唯一 initial，零新增准备模型调用；重启也读同一记录。`reprepare:true` 才明确放弃候选、保存操作来源并开新批次。未实际执行、被限额拒绝、interrupted/failed Run 上的建议只能诊断，不能冒充 completed ready。迟到/旧版本建议仍拒绝，预算调整本身不消费候选。
- [x] 准备/initial 的派发失败都保存 paused/run_error + 候选 runId；原 replay/finishDispatch 按候选 phase/版本处理。executing 下显式 resume 可核验已冻结版本、goalPreparedBy、原意图和所有 A/B 接纳条件后复用未派发 initial；沿 A 的同请求二次失败恢复规则，不能回退为 preparation 或建第二 initial。已完成 preparation 的原创建请求重播仍返回原接纳快照，不把它再次派发。
- [x] 模型新增范围、删用户条件或发明性能阈值不冻结，转最少澄清。性能任务的基线/环境/负载/方法/阈值/不可退化约束需有来源；未知基线允许之后测量，阈值只能来自用户。已有明确取舍不重新提问。只读调查后仍不明则 waiting_user，不自动新开 preparation。
- [x] 无有效建议或条件仍不明确时，暂停 preparation_incomplete 或保存 clarification wait，说明用户需补足的具体条件；没有新的自动准备 Run。运行网络故障仍保留 run_error，B 的 token_budget/usage_unknown 优先保护。
- [x] clarification 回答必须匹配当前 goalId/version/questionId，保存真实 response Input，加入未冻结版本.inputIds 和来源，再以该用户 requestId 开一个批次。旧答案拒绝；answered request 重试返回原结果。被预算阻挡时回答可保存为已接纳结果、Goal 保持 paused；以后显式 resume 用同一已接纳批次，不能丢答案或自动发请求。
- [x] 启动仍先 B 对账再 A 默认暂停；memory 不恢复。新请求结果保留 episode 计数与 phase。preparing 的外部等待拒绝；executing 的外部等待继续只读观察，不累计准备或执行轮。

### 4.4 摘要与只读查询

- [x] 扩展 GoalRunBinding，含 phase、当前正式要求/完成状态、最新审查、等待、次数与 usage 小计；摘要截短每条说明、最多 64 项，不带完整工具历史。
- [x] 新 `createGoalReadTool(read: () => Promise<GoalReadSnapshot>)`，输入为空对象、additionalProperties=false。宿主闭包绑定当次 goalId/version/runId；执行时再检查仍属当前 Run，过期返回明确错误，不让模型指定其他会话或 Goal。复用构建摘要的同一函数，必要时拿最新状态；它不改变目标、预算或完成状态。
- [x] GoalRead 与 GoalAssessment 只在真实 Goal-linked Run 注册，普通任务没有这两项工具。数据由 server callback 注入，runtime 不 import Repository/services，core 不存 Goal 类型。完整证据仍用原读取工具按需看。

GoalRunBinding 增 `readSnapshot: () => Promise<GoalReadSnapshot>`，server 闭包捕获当前 Run 身份；`createGoalRunContribution(goal): Promise<AgentRunContribution>` 与原 agent 调用点改为 await，通过这一个回调构建 systemGuidance，GoalRead 执行时再次调用。显示文本都由同一 formatter 截短，查询不接受任意 ID；不要把来源为模型的客体 JSON 充当宿主快照。

**关键回归：**明确修复 → preparation ready → 一次 initial；“优化系统” → 一次当前澄清，不强制 QPS；范围明确 UI → user_acceptance 条件。条件明确时零调查即可 ready；读取材料后提交建议正常 completed，无额外收尾模型；被真正取消则不冻结。超过旧模型及调查次数仍可继续，显式用户预算仍有效；生产宿主 Read 可用，伪造或被替换的 Read、Shell、Child、可执行 hook、后置维护均不运行。ready 被预算挡住后，重启/同请求重播/普通 resume 零重新准备且只一个 initial，显式 reprepare 才开新 episode；输出复用常规模型配置。回答重试/重启保留原 episode，过期问题不能补新来源。

## 5. C3：用户变更、完整集合与历史证据

**交付：**refine/pivot 有前后版本记录，确认只针对指定用户验收项；当前有效历史证据能复用，缺项或无效证据不能被主观确认掩盖。

### 5.1 可信变更与稳定 ID

- [x] 原 PATCH stop 流程保留：先保存 paused/updating_objective 与用户修改意图，撤销观察/续跑，阻止旧版本新调用；等待根与旧版本后代清理，再事务保存新的未冻结 version/preparing 与唯一 preparation。停止失败同 request 继续 stopping；正文/条件的变化仅提交一次。
- [x] 用户 actor 从当前本地调用/已有鉴权上下文注入。当前本地接口只能证明 local_user 就只记这个身份，不编造个人 ID；模型 JSON/客户端的 origin/actor 字段拒绝。记录原目标、完整旧条件、新正文、changeKind/reason/request/input/时间，冻结时补充新条件与 replaces，审计来源就是前后两行。
- [x] 准备候选的 previousRequirementId 仅是建议。宿主对 text/verification/constraints 的规范化结构精确相等才保留 ID；不是自由文本语义去重。改内容/验收方法给新 ID 并记录 replaces；refine 不在用户 replaceRequirementIds 内的旧条件必须保持，不得丢弃。新增范围或来源不明仍澄清；pivot 的新结果/阈值也只能来自用户。
- [x] 新版本 inputIds 包含本次用户提交，以及继续有效的旧正式条件所引用的可信输入；不把全会话的任意消息加为授权来源。继承定义的原来源保持原 Input/文档 Part 身份，当前复核是新证据；新增来源必须来自本次用户提交或准备的可信读取，不改写旧输入冒充新授权。
- [x] 原文/条件/约束完全相同的 refine 不增版本、不重新准备，不清零任何量或进展计数，可保存命令结果说明无变化。理由不同不等于正文版本改变。有效提交可开始新连续审查，历史 assessment 保留；改变目标本身不是进展。
- [x] B 预算关闭时仍可保存新正文/未冻结版本/接受的准备批次，保持 paused 且不建可运行意图；预算调整后明确 resume 才派发。不得先停旧轮后让请求永远 pending。新 preparing 未冻结版本的再次编辑同样留下版本来源，不覆盖已接纳用户 Input。

### 5.2 覆盖与指定项验收

- [x] GoalRequirementAssessment 使用 `requirementId / status / evidenceRefs / explanation`；不再接收自由 requirement/source 当定义。executing 每轮对完整当前集合报告，缺/未知/重复 ID 均为 assessment_invalid，不能从漏项报告完成；合法局部成功通过完整集合里其他项 incomplete 表达。
- [x] `classifyGoalCompletion(goal, assessment, verifiedEvidence)` 先检查缺项/incomplete/客观证据，再处理 needs_user。客观 check/artifact_review 无有效证明只能保持 incomplete；失败结果可解释诊断，不能证明 satisfied。有可执行下一步先 continue；不能继续则等待或停止，不能给通用“全部满足”按钮。
- [x] 只有所有客观项有效、剩下仅 user_acceptance 时生成 acceptance wait，保存 goalId/version/questionId/requirementIds。confirm 匹配 current wait，只保存这些 ID 的用户验收回执，再核对完整集合。无当前验收、旧按钮/版本、客观项混入均 409；不通过 confirm 免除失败测试。
- [x] confirm 的用户输入与 receipt 保存 requestId/inputId/actor/at/questionId，属于当前 assessment 的宿主字段；模型不能填 receipt。验收变化不改冻结定义/objectiveVersion，不重置次数/总量。批准仍是独立 approval wait，confirm 不是批准。

### 5.3 证据读取器与可信文件事实

```ts
// server goal-evidence-reader.ts；依赖已有 Run/消息/Part 查询，不调用模型或命令。
interface VerifiedGoalEvidence {
  requirementId: string;
  origin: { goalId: string; objectiveVersion: number; runId: string; messagePartId: string };
  verifiedForVersion: number;
  facts: { environmentKey?: string; command?: string; expected?: string;
    artifacts?: Array<{ subjectKey: string; beforeDigest?: string; afterDigest: string }>;
    external?: { waitOwnerRunId: string; targetRunId: string;
      observedStatus: "pending" | "running" | "completed" | "failed" | "interrupted";
      status: "completed" | "failed" | "interrupted"; resultPartId: string } };
}
interface VerifiedGoalDiagnostic {
  origin: VerifiedGoalEvidence["origin"];
  kind: "tool_error" | "run_error" | "unavailable_resource";
  summary: string; // 已有真实失败/资源记录，不能直接复制模型 blockerKey。
}
readGoalEvidence(goal: SessionGoal, assessment: GoalAssessment): VerifiedGoalEvidence[];
readGoalDiagnostics(goal: SessionGoal, assessment: GoalAssessment): VerifiedGoalDiagnostic[];
```

- [x] 扩展现有 GoalEvidenceRef：外层评估仍由宿主绑定当前 goalId/version/runId；每个引用单独记录来源 version/run/Part，不能把旧证据身份重写成当前 Run。当前来源可为根或 A 的可信后代；历史只能属于同 Goal 的正式历史版本，有明确当前复核，不能仅同会话就放行。
- [x] projector 只解析当前工具 ID 为 Part，不把任意历史 token 当本轮工具 ID；显式历史引用由 reader 查原 Run/Part/Goal 绑定。查不到、失败/未结算、GoalRead/GoalAssessment 自身产出不能证明要求完成。
- [x] 同一 reader 可读取已结算的真实失败 Part/资源记录作为诊断，输出 VerifiedGoalDiagnostic；它不进入 satisfied 证据数组。进展 policy 据该字段区分实际阻塞与仅缺核实信号，不从模型 reason/blockerKey 自证失败或无路线。
- [x] 成功读取本地正文的普通 Read 与 Read(info_only)，以及成功 Write/Edit/ApplyPatch，补统一、完整 SHA-256 的文件观察/修改事实：实际规范路径/执行环境、before（不存在有明确标识）/after、操作是否完成。普通 Read 的正文与摘要从**同次已读入的原始字节**产生，不另读一次；文档来源的 quote/digest/evidencePartId 必须指向同一个 Part 的实际可见正文与回执，截断后未显示文本不接纳引用，info_only 不能提供正文 quote。URL/媒体等没有这一可信正文回执时不接纳为文档引用来源。ApplyPatch 多文件只列真实目标，失败/未知写入不声明完成。
- [x] digest 字段只允许 `sha256:<64位十六进制>` 或明确 `missing`，创建/删除都有前后状态；不把“不知道”写成 missing。environmentKey 使用稳定的执行环境/工作区/验证配置，不用每次变化的 lease ID。subjectKey 从环境与规范路径摘要生成，不截短真实路径造碰撞，也不信任模型给的随机 ID。
- [x] Core 只为捕获且验证的 builtin 定义保留这些宿主事实，在 projector 持久化 Part metadata；普通插件/MCP metadata 同名字段剥离，不按 toolName 猜信任。不解析 compactSummary 的短 hash；不在 GoalService 直接读 Node 文件绕过环境/路径权限。
- [x] 历史测试/交付物复用要求当前 Run 的廉价只读复核事实匹配当时的文件/输入摘要、环境、验收命令和目标值。当前实际读取可用原 Read；reader 只比较记录。环境/依赖条件未知、文件已变或只有主观解释时重新执行对应检查。没有依赖清单不假装“某一文件未改”证明全部测试有效，也不默认重跑全套测试。
- [x] artifact_review 的语义由当前模型按正式标准审查，宿主核对产物与当前事实；主观 user_acceptance 必须用户 receipt。历史证据不是直接继承的 satisfied 状态；新版本当前报告重新引用并核对后才接纳。

**回归样例：**正式 R1 接口检查 incomplete、R2 UI needs_user，complete 建议仍不能进入验收；R1 有效 satisfied 后 acceptance 只列 R2。旧 version=1 的 confirm 对当前 version=2 拒绝。同 request stop 失败重试只有一个版本/准备；旧评估拒绝、旧 usage 仍补账；历史检查的全部已声明依赖匹配才复用，未知环境不复用。

```ts
expect(classifyGoalCompletion(goal, fullAssessment, verified)).toMatchObject({ kind: "continue" });
expect(() => validateRequirementCoverage(goal.requirements, [{ requirementId: "R2", status: "needs_user", evidenceRefs: [], explanation: "待验收" }]))
  .toThrow("goal_assessment_requirement_coverage_invalid");
// validateRequirementCoverage 定义在原 goal-assessment-policy.ts，检查集合完整/唯一。
```

## 6. C4：可核实信号、防循环与原界面

**交付：**不把新日志/换 blockerKey 当进展；三轮停止有事实与恢复条件，现有 Banner 能展示阶段、条件、版本变更和验收范围。

### 6.1 仅三类信号

```ts
type GoalProgressSignal = {
  requirementId: string;
  kind: "requirement_satisfied" | "artifact_changed" | "external_terminal";
  evidenceRefs: GoalEvidenceRef[];
  subjectKey: string;
};
type VerifiedGoalProgressSignal = {
  requirementId: string; subjectKey: string;
  origins: VerifiedGoalEvidence["origin"][];
} & (
  | { kind: "requirement_satisfied"; from: "incomplete"; to: "satisfied" }
  | { kind: "artifact_changed"; beforeDigest: string; afterDigest: string }
  | { kind: "external_terminal"; waitOwnerRunId: string; targetRunId: string;
      observedStatus: "pending" | "running";
      terminalStatus: "completed" | "failed" | "interrupted"; resultPartId: string }
);
interface GoalHostProgress {
  verifiedSignals: VerifiedGoalProgressSignal[];
  stagnationCount: number; noProgressCount: number;
}
// GoalAssessment 增 hostProgress?: GoalHostProgress，只由宿主写入；模型 schema/parser 拒绝它。
// readGoalEvidence 核实来源事实，policy 产生转换与去重结果；原 assessment JSON 保存完整事实。
// goal-progress-policy.ts 是纯函数，不读数据库、不发请求。
evaluateGoalProgress(input: { goal: SessionGoal; assessment: GoalAssessment;
  evidence: VerifiedGoalEvidence[]; diagnostics: VerifiedGoalDiagnostic[];
  history: GoalAssessment[] }): {
  trustedProgress: boolean; stagnationCount: number; noProgressCount: number;
  disposition?: "paused" | "blocked"; verifiedSignals: VerifiedGoalProgressSignal[];
};
```

- [x] 客户端/模型只提交候选信号；宿主补或验证 digest、真实 targetRun 终态、要求转换。已核实细节存原 assessment JSON，history 查询按 objectiveVersion 过滤；不创建信号/评分表。
- [x] requirement_satisfied 仅当前完整证据第一次使该 ID 从 incomplete 到 satisfied；重跑同检查、重复确认不算新推进。
- [x] artifact_changed 必须有关正式 requirement，当前审查解释如何推进；可信 before/after 不同，规范 subjectKey 来自宿主路径/环境。当前版本历史记录初始 before 和所有 after 状态；A→B→A→B 已出现的状态不归零。仅更新时间、随机日志 ID、换文本解释不算交付变化。
- [x] external_terminal 必须是当前合法外部等待的具体 targetRunId。建立等待时，宿主在原 wait/assessment 保存 observedStatus、owner/target 身份；原 `goalWaitSource` 把这份可信等待来源带到结果检查 Run，reader 再核对当前真实终态及结果 Part。已开始等待时就 completed 的目标无非终态转换，仍可查结果但不算该信号。已核实信号按当前版本的 waitOwnerRunId/targetRunId 去重并保存 terminalStatus/resultPartId；旧 completed 记录反复读取不归零，observer 自身不累计轮。
- [x] 实际同阻塞仍需当前错误/资源/阶段及诊断证据；模型 blockerKey 只辅助分组。原 noProgressCount 同阻塞三轮保留；stagnationCount 对每个已结算 executing 轮无可信推进则 +1，有推进归零，换 blockerKey 不重置。模型 progress、签名和新诊断解释单独都无效。
- [x] 停止阈值 3：确有阻塞事实且当前审查没有可执行路线才 blocked/no_progress；仅未核实进展则 paused/no_progress。准备、宿主等待、用户等待和权限等待不累计；暂停或过期 Run 不改计数。用户明确有效 resume/refine/pivot 可重开连续审查，保留历史，不清账、不解除硬限制。
- [x] 宿主用当前/历史 assessment 构建有长度上限的停止说明：未完成 ID/文本、尝试路线及证据入口、真实阻塞或未核实的原因、用户需要决定的事和恢复条件。撤销待派发续跑，复用原停止路径；不调用模型写摘要、不宣称已无路可走或回滚副作用。

**回归样例：**三轮换 blockerKey、时间戳或工具签名但无信号 → stagnation 1/2/3 → paused；真实错误+无路线 → blocked。A→B 首次有效，之后 B→A/A→B 不清零；等待三次观察仍 0 轮，结果检查首次消费终态信号一次。重复 Run 结算不重复加计数。

```ts
expect(evaluateGoalProgress({ goal: { ...goal, stagnationCount: 2 }, assessment: changedLog, evidence: [], diagnostics: [], history }))
  .toMatchObject({ trustedProgress: false, stagnationCount: 3, disposition: "paused" });
```

### 6.2 原 UI 与动作

- [x] GoalBanner 根据 phase 展示“正在整理目标”或执行状态；正式条件未冻结时不假装已完成。预算、usage.seq、终态查询和慢 GET 补读保持 B 的实现。
- [x] 编辑区域显式“补充条件 / 改变方向”、理由；refine 替换条件可选择旧 requirementIds，补充不选。保存仍通过 PATCH 和原 requestId/expectedRevision；预算输入保持独立。
- [x] clarification 表单“提交回答”，acceptance 表单“结果满足所列条件”，显示本次 requirementIds 对应文字；按钮传当前 objectiveVersion/questionId。批准等待不提供验收快捷入口。
- [x] 详情按稳定 ID 显示正式条件及当前状态、停止摘要和最近变更原因。无需历史版本新路由或独立详情页，原 Goal 快照携带当前版本 changeKind/changeReason 的小摘要；完整审计在版本记录中。
- [x] 首版不以 slash 子命令作为交付前提；现有 `/goal` 编辑仍提交同一操作。不增加常驻浮层、组件库或页面，使用原输入/按钮，样式由用户反馈。

## 7. 集中验收与交付顺序

| 规格 | 落点 | 实施验收 |
| --- | --- | --- |
| C1 | C1/C2 | 明确修复最少整理后执行；模糊目标最少澄清；主观目标有效条件 |
| C2 | C2 | 第 3 模型 / 第 5 调查 / 高输出 / Child / hook 拒绝；重试/重启/回答批次不绕限制 |
| V1/V2 | C1/C3 | 两客户端冲突、停止失败、版本/派发去重；旧评估/按钮拒绝，旧用量补账 |
| E1/E2 | C3 | 全集合、客观项优先、指定项用户 receipt；来源和当前依赖有效才复用 |
| L1/L2 | C4 | 日志/换 blocker/往返不归零；可信推进和真实等待不同；停止不夸大 |
| B7/R1 | 全部 | preparing/refine/回答/confirm 不绕预算与权限；memory/普通 Goal-free Run 原行为 |

- [x] 每单元写能捕捉上述错误的关键回归，集中观察缺功能失败并实现；不以源码字符串/常量测试代替调用行为。各任务完成可自测，完整功能仅 C1–C4 验收后标交付，不提前开放新格式的半套 UI。
- [x] Services 一批：新 `src/goals/goal-version.test.ts`、原 `goal-repository.test.ts` / `goal-transactions.test.ts` / `goal-usage.test.ts`、temporary records 与 DB inventory；protocol `session-goals.test.ts`。
- [x] Server 一批：新 `src/application/session/__test__/goal-evidence-reader.test.ts` / `goal-progress-policy.test.ts`，原 `session-goal-service.test.ts` / `run-admission-service.test.ts` / `run-control-service.test.ts` / projector / startup recovery / 后置维护；保留 A/B 的关键等待与取消补账回归。
- [x] Core/Runtime 一批：query retry/compact/tool tests、GoalAssessment/新 GoalRead、Framework/Child/RunCapabilityView；仅假模型网络，验证实际 createParams、emit 与零副作用。Tools 仅新回执影响的 Read/Write/Edit/ApplyPatch 回归，不扩到全工具库。
- [x] Desktop 一批：GoalActions、Banner、store/scheduler 行为；client 只测新增参数与既有事件解码。无页面预览或视觉 E2E。
- [x] `pnpm --filter @vykor/protocol --filter @vykor/services --filter @vykor/core --filter @vykor/agent-runtime --filter @vykor/server --filter @vykor/client --filter @vykor/tools run check-types`，Runtime 声明过期再 build；Desktop `typecheck:web`，Main 参数若需变更再 `typecheck:node`；services `db:check`、`git diff --check`。不跑真实模型、不操作真实库。
- [x] 一名集中代码审核，重要问题修后只定点复核；计划审核不代替实施审核。更新 Goal 设计与路线，只标 C 已实际验收能力，不宣称任意诊断归一/绝对成本上限已实现。不强制 commit/push。

原规划预算沿用于实施：只读必要文件，一名集中实现审核者，一次集中修订及必要定点复核，验证按受影响范围集中进行。用户未给预算数字，不虚构 Token 使用量或设新目标预算。


2026-10-15 实测修正：准备阶段允许最多 5 次模型调用，为最多 4 次顺序只读调查保留一次提交条件的机会。该内部防循环限制独立于用户的 Token 预算和自动续跑轮数；目标条件已经明确时应直接提交 ready，不在准备阶段提前执行或验收任务。


2026-10-15 后续修正：以前述最新规格为准，取消本日此前提出的准备专有次数上限；实现及审核见 `../reviews/2026-10-15-goal-read-preparation-fix.md`。
