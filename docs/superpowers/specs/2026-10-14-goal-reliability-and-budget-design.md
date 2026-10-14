# Goal 持续执行改进规格：可靠等待、可验证进展与预算

> 日期：2026-10-14
> 状态：独立审查与修订复核通过；尚未实现。可进入分阶段实施计划。
> 源码基线：`12bbe28bc3538a74aa8f57da2e5583ea34fd3d99`，同时核对本次工作区中的 Goal 相关文件；不修改其他正在进行的工作。
> 依据：[Codex `/goal` 实现与改进建议](../../codex-goal-implementation-research.md)、[已有 Goal 设计](../../session-goals-design.md)。本文对冲突部分给出增量规则，不声称复原 Codex 的计费或调度算法。
> 审查：[设计审查与修订记录](../reviews/2026-10-14-goal-reliability-and-budget-design-review.md)。

## 1. 目标、范围和简化原则

保留当前持续目标的运行方式：用户显式创建 Goal，服务端保存，当前 Run 结束后核对结果；仍可继续时保存唯一续跑意图，再交现有运行队列执行。Run 指一次有独立身份和终态的运行，不能用“代理会话仍存在”代替它。

本阶段补齐五件事：等待具体工作、区分停止原因、归集真实 Token 用量、保存稳定完成条件、依据实际变化停止空转。模糊目标的澄清和用户修改目标也使用同一套版本与完成条件。

约束：

- 沿用六个 `GoalStatus`：`active / waiting_user / blocked / paused / completed / cancelled`。预算用尽和运行错误通过结构化原因表达，不扩充一套平行状态机。
- Goal 服务负责目标状态；Run admission 负责排队及开跑；模型运行器负责执行和检查宿主限制；Repository 负责事务读写。UI 展示结果并提交用户动作，不判定完成、余额或子任务状态。
- 不增加独立 Critic、新的工作流引擎、通用预算平台、后台目标规划代理或默认定时唤醒。评估继续由运行模型提交，宿主核对；不是每轮再调用一个模型评审。
- Token 限制是可选的，仅由用户明确设置。现有默认 20 次自动续跑额度继续保留，是次数限制，不冒充成本预算。
- 本次只输出规格，不实施代码。分三个可独立交付的阶段；未实施阶段不得在 UI 宣称已支持。

## 2. 已有能力与确认缺口

| 当前事实 | 本阶段增量 | 核对位置 |
| --- | --- | --- |
| 请求去重、revision 冲突保护、先保存后派发、用户消息优先已存在 | 保留；新字段参与相同事务与去重 | `session-goal-service.ts`、`run-admission-service.ts`、`goal-transactions.ts` |
| GoalWaitVerifier 接受同会话 Run；找不到时用子会话目录存在判断 running | 改为具体 Run 身份与持久父子归属；移除存在即运行的分支 | `goal-wait-verifier.ts`、`live-child-agent-directory.ts` |
| 多类自动停止与用户暂停都使用 paused + 自由文字 | 增加 stopReason，保留 reason 作为面向用户的说明 | `session-goal-service.ts`、`goal-external-wait-observer.ts` |
| `model.attempt.finished` 已按 Run + generationId + attempt 去重，记录成功/失败/中断用量与完整性 | 复用事实事件，新增 Goal 归属账本；迟到事件不依赖 Run 仍 running | `daemon-agent-event-projector.ts`、`core/types/usage.ts` |
| 目标只有 maxAutoTurns/autoTurnsUsed，没有 Token 预算 | 新增可选 tokenBudget 与用量快照；在模型尝试及工具派发边界检查 | `protocol/session-goals.ts` |
| 完成评估逐项核对成功工具证据，但要求是当轮自由文本 | 固定 objectiveVersion 内的 requirementId，核对完整集合与有效证据 | `goal-assessment-policy.ts`、`goal-assessment-tool.ts` |
| 新工具输入/输出签名被当作新进展；修改正文后仍查整个 Goal 的历史签名 | 以要求、交付物和诊断的有效变化判断；签名只作辅助 | `session-goal-service.ts`、`goal-repository.ts` |
| 子 Task 可复用，同一子代理可开始新工作 | 等待与用量按每次 Child Run 绑定，不能只绑定 taskId 或 childId | `daemon-agent-event-projector.ts`、`child-agent-execution-registry.ts` |

当前没有独立 Critic，也没有可靠的自由文本语义验证器。宿主可核对身份、版本、来源、检查结果和要求覆盖；无法仅靠字段校验保证任意证据在语义上支持结论。规格保留模型审查与用户验收，不制造这一保证。

## 3. 数据与职责边界

### 3.1 Goal 聚合继续是唯一目标状态来源

在 `SessionGoal` 增加：

| 字段 | 定义 |
| --- | --- |
| `objectiveVersion: number` | 正文、正式完成条件或约束变化才递增；初值 1 |
| `phase: "preparing" \| "executing"` | preparing 只整理目标/澄清；executing 才允许实质工作。与等待/暂停状态组合，不产生另一套生命周期 |
| `stopReason?: GoalStopReason` | 结构化停止原因；自由文字 reason 保留，UI 不解析文字判断动作 |
| `requirements: GoalRequirement[]` | 当前正文版本的正式完成条件，最大 64 项；preparing 时可以为空 |
| `tokenBudget?: number` | 正整数、单位 Token；缺失表示用户未设置限制 |
| `usage: GoalUsageSummary` | 已知累计 Token、完整性、未知/部分/飞行中尝试数、累计运行耗时；是账本派生快照 |
| `stagnationCount: number` | 连续没有可信推进的已结算执行轮；不依赖模型 blockerKey |

`revision` 继续用于客户端请求的乐观并发控制，即拒绝旧界面覆盖新状态。用量事件通过独立记账操作更新快照，不调用会递增 revision 的 updateGoal，避免每次记账让用户操作失效；`usage.seq` 为每次有效补账递增的序号，updatedAt 仅用于显示时间。评估和 Run 除 goalId 外绑定 objectiveVersion；宿主还核对当前 Run、运行状态和是否已结算。旧 Run 的评估无权更改新目标，旧 Run 的真实用量仍必须入账。

运行评估的可信绑定以 `(goalId, objectiveVersion, runId)` 为准，不再把当前 Goal.revision 必须等于开跑时 revision 作为正文有效性的判断。修改预算/普通状态会改变 revision，但不应让同正文版本的合法评估失效；暂停/取消仍通过状态和 currentRunId 拒绝，正文变化通过 objectiveVersion 拒绝。宿主状态事务提交仍以读取时的 expectedRevision 防并发覆盖，续跑去重沿用已有运行意图唯一规则。

`GoalRequirement` 最小字段：`id / text / source / verification / constraints`。source 包含用户目标文本定位，或引用文档路径与内容摘要；verification 为 `check / artifact_review / user_acceptance`。`check` 记录验收命令或结构化条件与执行环境；`artifact_review` 记录交付物及复查标准；`user_acceptance` 记录用户需要判断的结果。无量化指标的 UI、调研与文档任务也可形成有效条件。

创建时的版本是尚未冻结的 version 1；首次冻结补足该版本记录，不另增 objectiveVersion。冻结前绑定的澄清答复补充这个版本的来源；冻结后改变正文、条件或约束才生成下一版本。用量、状态、进度与用户对既有条件的验收都不增加正文版本。

仅增加两类持久记录，不建独立需求、诊断、提案、审计、预算服务：

- `session_goal_version`：每次正文版本的 objective、requirements、changeKind、变更原因、用户请求身份、时间及前一版本。正式条件冻结也写在对应版本内；冻结后不可原地改写。历史版本是审计来源，现有 Goal 行保存当前快照。
- `session_goal_usage_attempt`：一次真实模型尝试的归属、规范化用量及完整性，唯一键为 `(sessionId, runId, generationId, attempt)`。记录 provider/model 供排查，但不保存密钥。真实派发前写 pending 行，结束更新；正常飞行中的 pending 不当作已经缺账，显示为 inFlightAttempts。重启后无法确认结果的 pending 标记 unknown；宿主证明未发出的尝试为 not_sent，不算真实使用量。

临时会话沿用 memory 存储语义：相同去重与事务规则，但不把本应临时的内容写到 SQLite。用量不得为了落盘改变临时会话的隐私行为。

### 3.2 各层实际做什么

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| `packages/protocol` | 类型、长度/枚举/整数校验；相同输入在 HTTP/客户端解释一致 | 语义判断、查数据库、选择是否续跑 |
| `services/goals` | Goal/版本/尝试的事务读写、唯一约束、快照聚合 | 调模型、轮询子代理、执行命令 |
| `SessionGoalService` 与现有 policy | 准备、用户变更、可信评估结算、停止原因及续跑资格 | 替代 Run 队列或读取 live handle 猜测完成 |
| `RunAdmissionService` / `RunControlService` | 开跑前再检查、用户优先、撤销/中断/等待清理 | 解释证据语义、估算价格 |
| `GoalWaitVerifier` / wait observer | 查询具体 Run 终态、归属、退避；完成后只接纳一次续跑 | 因观察超时重启原任务或产生轮询模型调用 |
| `DaemonAgentEventProjector` | 将真实尝试事件及父子归属投影到账本 | 从用户文本或模型自报决定调用归属 |
| `goal-extension` / 通用执行器边界 | 注入精简目标摘要、提供只读 GoalRead、提交评估、执行宿主限制回调 | import 服务端 GoalRepository；让普通 Run 依赖 Goal |
| Desktop / Client | 展示快照、编辑/继续/验收/预算动作；请求带 requestId 与 expectedRevision | 本地自动计数或自动恢复 |

执行器需要限制回调时，使用可选的通用“执行前允许/停止”接口，由 Goal 扩展注入；不把 Goal 类型或数据库放进 core。普通任务不提供该回调，保持现有路径。

## 4. 先形成可验收目标，再进入实质执行

### 4.1 准备和澄清

创建时保存 Goal、原始正文及 preparing 运行意图。准备使用现有队列内的 Goal-linked `preparation` Run，不另建 Agent。首先利用用户已给出的正文、引用规格和会话上下文整理完成条件。

- **明确目标：**提取原指令中的范围、条件与约束；准备 Run 终态后，宿主检查来源与结构，冻结当前版本的 requirements，切到 executing，唯一接纳一个 initial 执行 Run。用户显式创建已提供授权，不要求再次点“确认”。不在正在执行的 Run 中切换正式契约。
- **缺少关键选择：**保存最少问题，进入 waiting_user，等待使用现有 questionId/response 链路；不创建自动续跑。例：“优化系统”需要知道优化对象与用户希望得到的结果。
- **只缺可调查事实：**在既有授权内允许一次低成本只读调查。必须使用明确允许的读取/查询工具，不以工具名称前缀推断只读；不得写文件、执行部署、启动子代理或长后台任务。调查结束若仍有重要取舍，waiting_user；不得把“调查已完成”当原优化目标已完成。
- **主观但范围明确：**可直接执行，verification 为 user_acceptance，结果交用户验收。不得强迫文档/视觉任务填入 QPS 等指标。

准备阶段复用 GoalAssessment，增加仅供 phase=preparing 使用的 `decision: ready` 和 `preparedRequirements`。ready 只是准备建议，不能 complete；projector 保存建议，SessionGoalService 在 Run 终态后冻结并派发 initial。preparing 下提交 complete 拒绝；executing 下提交 ready 或修改正式条件也拒绝。若无法通过校验则 waiting_user 或 preparation_limit，不新增自动准备 Run。完整调用和结算继续经过现有权限、预算和请求去重。

准备限额按一次可信用户提交计算：创建、编辑、关联澄清回答或明确“重新整理目标”的 resume，各开启一个 preparation episode（准备批次）。批次身份使用去重后的用户 requestId，计数保存在对应请求结果中；自动重试、重新派发、窗口/进程重启都延续同一计数。每批最多 2 次真实模型尝试（重试也计入）、4 次只读工具调用，单次输出上限 1024 Token；不得派生子代理。初次等待问题后不自动开启新批次，只有绑定当前版本问题的用户答复才能继续。新批次不清零 Goal 总用量/次数。

澄清问题绑定 goalId/objectiveVersion/questionId；通过既有 response 路径提交的有效答复持久化为用户 Input，其 inputId、原文与正式条件来源一起写入该目标版本。过期版本/问题的答复不修改新条件。准备 Run 不消耗 autoTurnsUsed；ready 后 initial 仍只接纳一次，不计自动续跑。它们的所有模型量都进入 Token 账本；本轮没有冻结成功就不派发 initial。无法在固定限额内整理复杂要求时保留草稿并要求用户缩小/拆分，不丢条件换取 ready。

性能条件必须包含基线/测试环境/负载/测量方法/目标值/不可退化约束。允许先测未知基线；最终阈值只能来自用户指令或答复，模型不填一个“看起来合理”的数字。已明确任务只整理指令，不重新打开已经决定的产品取舍。

冻结来源与条件是覆盖审查，不是自由文本语义的数学证明。模型提出新增范围、改变目标值或删去原要求时转为用户澄清，不自动冻结。引用资料保存当时的摘要；资料后来变化不会悄悄替换正式条件。

### 4.2 执行轮与只读摘要

每轮注入宿主摘要：goalId、objectiveVersion、原正文、正式要求及当前完成情况、最新评估、具体等待、stopReason、次数与 Token 小计/完整性。按最多 64 项要求截断单条说明，完整证据按需查询；不得把整个历史工具输出加入每轮提示。

新增 `GoalRead`，只能读取宿主绑定的当前 Goal，不接受任意会话 ID。其内容与注入摘要同源；查询长证据继续使用已有读取工具。它只提供事实，不创建、修改、恢复、增加预算或标记完成。

## 5. 可靠等待与停止原因

### 5.1 等待具体 Run

外部等待保留 deadlineAt，改为绑定 `targetRunId`，以及宿主写入的 `ownerRunId / goalId / objectiveVersion`。模型可提出已有 Run ID；宿主验证后才持久化。需要从 Job/Task 入口选择时，在建立等待时解析到当次 Child Run，不能存一个会复用的代理/Task ID 后持续读取“最新 Run”。

归属合法条件：目标根 Run，或从该 Goal-linked owner Run 派生且父链有持久记录的后代 Run。仅仅拥有相同 rootSessionId 不足以证明属于该目标。缺少可信归属返回 missing，不允许模型补写父关系。

- pending/running → 保持 active + external wait；宿主退避查询，不产生模型轮。
- completed → 清除等待，检查续跑资格并唯一接纳一次结果检查轮。
- failed/interrupted/cancelled → paused + external_failed；保留真实终态与输出入口，原任务不重启。
- 读取临时失败 → unknown，继续退避直到原 deadlineAt；不算任务已结束或有效进展。
- 任务记录不存在或归属不符 → paused + wait_invalid。
- 截止时间到且任务仍未完成/无法确认 → paused + wait_timeout。先检查已落盘终态：截止前已经完成的任务不会因轮询迟到被判超时。

子代理完成后即使会话 idle/仍可收消息，也立即按当次 Run 终态处理；该代理开始新 Run 不影响旧等待。暂停、取消或变更时清除等待观察；重启后的外部等待仅恢复宿主观察，仍需通过当前版本、权限、预算、用户消息与次数检查才能接纳结果轮。

### 5.2 结构化原因

stopReason 的最小结构：`{ code, at, runId?, detail? }`。code 首版限定为：

`user_paused / user_cancelled / updating_objective / auto_turn_limit / token_budget / usage_unknown / provider_limit / run_error / assessment_invalid / wait_invalid / wait_timeout / external_failed / no_progress / startup_recovery / preparation_limit`。

`provider_limit` 只在运行器返回可信可分类的限流/额度错误时使用；无法可靠分类仍为 run_error，不从错误正文猜账号余额。等待批准与等待用户分别继续使用 wait，不混成上述错误原因。

预算门禁关闭是强约束，不能因为本轮评估 says continue、用户回答了一个普通问题或等待任务完成而恢复。用户暂停也不能被自动等待恢复覆盖。完成只能由当前版本的有效完整验收，或绑定该版本指定要求的用户 confirm 提交；限制耗尽不得伪装完成。

## 6. Token 预算：真实计量与明确的能力边界

### 6.1 计量口径

首版预算单位是“调用处理的 Token 数”，不是人民币/美元，也不是单次上下文窗口占用。按规范化后的 **完整输入 Token（包含缓存）+ 输出 Token** 计入已知小计。

当前 provider 字段不同：Anthropic 的 inputTokens 与缓存创建/读取分列，需相加；OpenAI 的 prompt_tokens 已包含缓存输入，不再次相加；Codex provider 当前只有 input/output，按其已知输入输出计量，缓存拆分缺失不等于输入总量缺失。adapter 明确标注输入字段是否包含缓存；不在 Goal 服务靠 provider 名称猜公式。原始字段保留用于排查，不改变现有账单展示口径。

归属在调用开始前由宿主固定：

- 计入 initial/edit/resume/continuation，以及 active Goal 下已绑定的用户 Run。
- 从这些 Run 派生的所有 Child Run、重试、完成评估与准备调用均计入；复用子代理时按新的父 Run 重新绑定，不沿用创建会话时的归属。
- paused/waiting_user/blocked 下的无关普通聊天不自动归入；明确恢复后产生的绑定 Run 才计入。输入内容不能让模型自行声明“这是免费调用”。
- 只累加每次原始模型尝试，不再叠加父代理汇总、子 Task 汇总或 session usage。失败/中断也保留已经发生的量。
- 身份合法的迟到事件可补账，即使 Goal 已完成、取消或正文变更。补账不重新打开 Goal、不接受旧评估、不改变新版本正文。

usage 的规范化字段：`knownTokens / incomplete / unknownAttempts / partialAttempts / inFlightAttempts / runTimeMs / seq / updatedAt`。同一尝试从 pending 变为 unknown/partial/complete 时更新一行并计算差额，重播不累加两次。缺失或非法字段保持 unknown/partial，不填零；已知数字可展示为“至少使用 X Token”。只有对应尝试收到可信完整补账后才能消除其未知状态，后续另一次成功不能覆盖历史缺账。

补账规则独立于现有会话投影的“Run 终态早退”和“第一个 finished 事件即去重”：账本入口先验证原始派发身份并写账，再决定会话文本投影是否需要执行。complete 记录不被更旧的 partial/unknown 降级；部分报告只增加已知量，不重复累加整份累计报告。一个更完整报告与已知数字矛盾时保留记录并标记 incomplete，不能悄悄减小累计量以重新放行。每次有效改变在同一事务递增 seq，并重算未知/部分尝试数与门禁；过期重复消息不递增 seq。

### 6.2 停止新增工作，不承诺绝对无超额

首版采用共享 Goal 计量门禁，**不承诺真实用量永远不超过设定数**。一个模型请求内部的输出、已派发子调用以及 provider 迟报用量仍可能造成超额；没有准确输入估算和 provider 输出上限时，不能宣称已预留精确余量。

最小运行规则：

1. Goal 和后代使用同一宿主门禁。排队、开始 Run、每次模型尝试（含重试/压缩）、新工具调用与派生 Child 前重新读取状态、版本与预算；不只在一轮 final 后检查。
2. 已知小计达到 tokenBudget：事务置 paused + token_budget，撤销尚未执行的续跑；拒绝新的模型/工具/子任务。通知关联运行合作停止，已提交工具按现有取消能力清理，不能回滚已完成操作。
3. 有限预算下 `usage.incomplete=true`：paused + usage_unknown，不假设仍有余额，包含旧数据无法重建的缺账，不能仅检查 unknownAttempts/partialAttempts。无 Token 预算时保持“用量不完整”提示与次数保护，可继续，不为每个不完整事件增加确认流程。
4. 排队检查与真正派发之间要重新检查；记账与关闭门禁在同一事务。并发请求都通过同一宿主限制检查，正在飞行的尝试在详情显示数量；其实际用量到达后照常补账。
5. 达到限制不新增“最后再总结一次”的模型调用。使用现有持久 assessment/requirements/工具结果生成宿主停止摘要，列出已做、剩余、限制原因与恢复方式；没有评估也可明确报告信息缺失。
6. 若完整结果在限制触发前已经提交并满足验收，可保留 completed；限制触发后旧 Run 的迟到评估只入历史，不改状态。限额判断与验收结算均按事务顺序保存，不能仅凭事件网络到达顺序做 UI 判定。

用户通过独立 budget 动作设置**总预算**，不是追加后偷偷清零。预算只可为正整数或显式 null（解除限制），不低于当前已知使用量；恢复要求余额大于零、usage.incomplete=false、旧运行完成清理，并通过其他门禁。历史缺账时可以保存用户明确给出的有限预算，但保持 paused + usage_unknown，不因看过提示就当作缺账已解决。无法补齐未知用量时，用户可明确解除 Token 限制后继续，UI 说明仍会展示不完整小计；不把估算转成真实用量。

改预算不会自动 resume，resume 不默认加预算；`additionalAutoTurns` 只改次数上限。用户可以一次提交明确的预算修改与继续操作，后台仍按先改预算、再检查恢复的顺序执行。refine/pivot、重启、模型更换均保留整个 Goal 的累计用量与已用续跑次数。

runTimeMs 复用 Goal 根 Run 的 startedAt→finishedAt 耗时之和，不再叠加 Child Run 耗时；运行内工具/批准等待包含在内，Run 结束后的 external wait、用户思考和空闲不计入。显示名称为“累计运行耗时”，不称“有效工作时间”。首版不实现扣除所有等待的区间算法，不新增计时调度器；总时间截止和货币预算另行设计。

严格的余额预留、按 token 即时流式熔断、第三方工具费用与货币换算不在本阶段。上线文案必须使用“达到已知预算后停止新增工作，可能存在已派发用量”，不得写成绝不超支。

## 7. 用户演进目标与证据有效性

### 7.1 refine / pivot

复用已有 PATCH 编辑入口，增加 `changeKind: "refine" | "pivot"` 与 `changeReason`；旧普通编辑入口默认解释为 refine，不另建三套后端流程。Desktop 在现有编辑区域提供“补充条件/改变方向”，slash 子命令可后续接入同一操作，不是本阶段交付前提。

- refine：补充原范围内的条件、约束与表述。
- pivot：显式改变预期结果或主要范围。首版仍使用同一个 Goal ID，写新 objectiveVersion 与历史版本；不引入跨 Goal 替代链和另一套预算账户。
- 两者都必须来自可信用户请求；模型只能在正常回答中说明原因和候选路线。沿用 UI 编辑提交授权，不增加独立提案工作流。GoalAssessment/GoalRead 无正式目标修改权限。

变更流程复用现有先暂停再停 Run：保存修改意图与旧版本 → 撤销旧续跑/观察，阻止旧版本新调用 → 中断并等待根与相关后代清理 → 事务写入新正文版本及审计 → preparing 整理新条件 → executing。停止失败保留 paused + updating_objective，重试相同 requestId；不保存第二个版本、不启动新运行。

version 记录保存提交前后正文/条件、变更类型、原因、用户身份、请求 ID 与时间。用户身份由接口鉴权/本地调用上下文给出，不信任请求 JSON 自报 origin。当前目标内的 Token/次数/运行耗时账本不清零；模型也不能通过 pivot 回避连续空转记录。

正式要求 ID：未改变的要求可保持 ID；改内容/验收方法的要求获得新 ID，注明替代项。旧 assessment 与 evidence 不直接视为新版本完成依据，先放入历史；只有新版本重新核对后明确继承的证据才可用。

### 7.2 历史证据与完成

GoalAssessment 增加 requirementId，必须覆盖当前正式要求的完整 ID 集合；未知 ID、漏项、重复冲突项拒绝结算为 completed。用户 confirm 绑定当前 goalId/objectiveVersion/questionId，不接受旧验收按钮。

结算先检查缺项、incomplete 和无效证据，再处理 needs_user：有可继续的未完成工作先 continue；无法继续则按原因等待或停止，不能提前生成“全部满足”的确认按钮。仅剩 user_acceptance 项时，验收问题保存明确的 requirementIds。confirm 只更新这些项，再检查完整集合；不能跳过接口测试等其他未满足要求。用户若要替换某项客观验收条件，须明确 refine，记录被替换条件与原因，不能用通用确认隐式免除检查。

证据仍绑定可信 Goal/版本/Run/Part 来源，不取消归属检查。历史证据允许复用，但必须证明其适用条件仍成立：文件/输入摘要、工作区版本、测量环境与验收命令等；宿主能核实的字段由宿主核实，其他需要当前模型复查或用户验收。无廉价有效性检查时重新执行对应检查，不默认重跑完整套件。

失败工具的诊断可用于进展判断，但不能单独证明一个要求 satisfied。子代理完成只能证明该次工作结束；正文摘要不代替产物和验证证据。外部等待 completed 后的结果检查轮依然要按目标要求验收。

## 8. 防循环：不把新日志当作新进展

保留当前同一阻塞三轮规则，同时新增与 blockerKey 无关的 stagnationCount。只统计已结算的 executing 轮；准备阶段由自身固定限额控制。宿主观察等待、权限等待、用户等待不产生轮，不累计无进展。

在已有 assessment 中增加 progressSignals，不创建进展表或新评分服务。每项包含 `requirementId / kind / evidenceRefs / subjectKey`；kind 首版只有 `requirement_satisfied / artifact_changed / external_terminal`。artifact_changed 的 before/after 内容摘要、external_terminal 的 targetRunId/终态由宿主证据读取器补齐或核实，不信任模型自报摘要。证据不足的信号不清零计数。

- requirement_satisfied：对当前正式要求进行有效证据审查，首次从 incomplete 变为 satisfied。
- artifact_changed：有关交付物的内容变化，且当前审查说明如何推进对应要求；按当前版本内 `(requirementId, subjectKey, afterDigest)` 检查历史 assessment，已出现的状态或往返修改不单独归零。时间戳、日志随机 ID 不是交付物内容摘要。
- external_terminal：当前等待目标 Run 首次从非终态进入终态，结果已读取；只读取老 completed 记录不形成新推进。

诊断发现、失败工具输出和模型解释保存为辅助说明，不在首版实现“任意自由文本假设的语义归一”。无法落在上述可核实信号中的工作记为“尚未核实到进展”，不伪装确定没有价值；必要时交用户调整条件或确认下一步。模型自报 Progress Score/kind=progress 和新工具签名都不能单独清零。

每轮没有可信推进：stagnationCount +1；有可信推进：归零。换 blockerKey 不重置它。连续达到 3：有当前真实阻塞证据及无可执行路线的审查时 blocked + no_progress；仅缺少可核实信号时 paused + no_progress，提示检查现有工作。现有同一阻塞三轮规则继续保留，但也必须有实际错误/资源/阶段与证据，不能只凭模型改写 blockerKey 判断。两类停止都取消待执行续跑，不虚构“已经无路可走”。

停止摘要包含：未完成要求、已尝试路线及证据、实际阻塞或未核实进展的具体原因、用户需要提供的信息/选择、恢复条件。用户明确 resume 或提交有效 refine/pivot 后可开始新一轮连续审查，历史阻塞保留；总用量/次数不重置。修改目标本身不是进展，不自动恢复硬限制。

## 9. 对外操作与 UI

沿用 `GET /:sessionId/goal`、创建、PATCH 和 actions 路由及 `session.goal.updated`。用量发生变化发布 `session.goal.usage.updated`，携带 goalId 与完整 usage 快照，客户端按 usage.seq 防旧快照覆盖；完整 Goal 快照中的 usage 也按同样序号合并，避免较晚收到的状态快照回退用量。要求/状态变化仍走原 Goal 快照。服务端订阅与当前会话访问检查一致。

- 创建输入新增可选 tokenBudget；未填写不设 Token 限制。保留 maxAutoTurns。
- 更新新增 changeKind/changeReason；变更预算不混入正文修改，避免预算变化递增 objectiveVersion。
- actions 新增 budget，携带 requestId、expectedRevision、tokenBudget（整数/null）；现有 pause/resume/cancel/confirm 保持含义。
- preparing、等待、停止与未知用量均通过同一 Goal Banner 展示。详情增加正式条件、已知用量、完整性和停止原因；不增加常驻浮层或独立 Goal 页面。
- 限制停止展示“调整预算/次数”和“继续”，不提供绕过批准、忽略未知账单或自动继续的按钮。用户验收与澄清回答使用不同 questionId 类型，按钮文案区别“结果满足条件”与“提交回答”。
- UI 不用时钟累加猜真实执行耗时；显示服务端累计值，进行中可做明确标识的显示插值。初期可只显示累计值，避免新增计时同步代码。

## 10. 实施阶段与文件落点

| 阶段 | 独立交付结果 | 修改集中点 | 后续阶段依赖 |
| --- | --- | --- | --- |
| A | 具体 Run 等待 + 停止原因 + 最小 objectiveVersion/父子归属；已有可靠续跑规则不退化 | `protocol/session-goals.ts`；schema/迁移/memory controls；`services/goals/goal-records.ts`、repository/transactions；`server/application/agent/daemon-agent-event-projector.ts` 逐 Child Run 持久绑定 parentRunId/goalId/objectiveVersion；run admission/executor 与 wait verifier/observer/goal service；现有 Goal Banner | B/C 使用同一版本和可信归属，不依赖尚未交付的后阶段 |
| B | 真实尝试账本、可选 Token 门禁、用量展示 | schema/迁移/memory controls；新增 `services/goals/goal-usage.ts`；projector；run admission/control；core 可选通用执行限制接口、api provider 用量适配；client Goal 类型/动作与 Desktop | 依赖 A；不依赖 C 的稳定要求，可先完整交付预算 |
| C | preparing 澄清、objectiveVersion/版本审计、正式条件、GoalRead、历史证据与 stagnationCount | 新增 `services/goals/goal-version.ts`；现有 goal service/policy；`agent-runtime/goal-extension.ts`、assessment tool；`server/application/session/session-run-executor.ts`；协议与原编辑/验收 UI | 受 A/B 的等待和预算保护 |

不新建 GoalCoordinator 替代现有 SessionGoalService。新增的 usage/version 文件留在已有 goals 模块，分别只管记账和版本读写；service 不吸收 provider 字段适配或文件系统检查逻辑。具体检查复用已有工具结果或注入小型 evidence reader。

采用仓库现有数据库迁移链更新结构，保持单一当前协议，不运行时双读两个 Goal 设计。A 为旧目标初始化 objectiveVersion=1，之后既有正文编辑也递增它，状态变化不递增；不在 A 引入准备与正式条件。B 为旧目标保留 tokenBudget 未设置，尝试重建账本；C 为当前 objectiveVersion 建立版本记录并初始化空 requirements/phase=preparing，下次执行整理条件，不把 A/B 期间的版本重置成 1。既有 objective/次数/状态/历史保留。

旧数据未记录的模型量不编造历史零用量：能从已有尝试事件重建时按同一唯一键重建；无法重建标记 incomplete，用户设置有限预算前明确提示。迁移不启动 Goal 或删除历史；临时存储同步更新，按现有语义不做重启恢复。

重启恢复仍沿用活动目标默认暂停、外部等待恢复观察的现有规则。pending 尝试先对账，再应用 usage_unknown/token_budget；重新打开窗口不恢复执行。stage C 尚未上线前保持旧验收规则，不能提前显示正式条件已冻结。

## 11. 验收与回归场景

| 编号 | 输入/场景 | 必须观察到的结果 |
| --- | --- | --- |
| W1 | Child Run completed，但会话 idle 且仍在目录 | 等待完成；最多一次结果检查 Run |
| W2 | 同一子代理开始第二次工作 | 第一等待仍绑定第一 Run，不改追新工作 |
| W3 | 不同 Goal/旧正文版本/无可信父链的 Child ID | 拒绝等待绑定，不因同 rootSession 放行 |
| W4 | 读取超时、任务仍在运行；截止前完成但轮询迟到 | 不重启、不空转；后者读取完成结果 |
| S1 | 用户暂停/次数耗尽/Token/运行失败/无评估/重启 | code 可区分；前端动作不靠 reason 文本 |
| B1 | 重复事件、失败重试、重启重播、Run 终态后 unknown→complete 补账、complete 后旧 partial | 每次真实尝试一次；完整补账可清除对应缺账；旧部分消息不降级；补账不恢复 Goal |
| B2 | 根调用 + 子调用 + 更深后代 + 父级汇总 | 只按原始尝试相加；子代理复用改绑定 |
| B3 | Anthropic 缓存分列与 OpenAI 缓存包含于 prompt | 规范化总输入正确，缓存不漏算也不重复 |
| B4 | partial/unknown 后另一次成功 | 缺账仍可见；有限预算不新增工作，无限制目标保留次数保护 |
| B5 | 并发调用在额度到达前发出、用量稍后到达 | 拒绝后续新调用；照常补已派发账；显示超额而非改成预算值 |
| B6 | 限制到达时工具正在写入/子代理运行/已有续跑 pending | 关闭共享门禁、取消待派发、合作停止与清理；已完成副作用不伪装回滚 |
| B7 | 等待恢复、普通消息、增加次数、refine/pivot | 不绕过 Token/权限/用户暂停；累计账不清零 |
| C1 | 有明确复现与验收的修复；“优化系统”；主观 UI 任务 | 分别直接执行、最少澄清、执行后用户验收；不固定要性能百分比 |
| C2 | 准备重试/调查超过限制、换 Run/重启、用户回答当前/过期问题、有限预算不够 | 自动操作不重置批次；有效答复才新批次且计入版本来源；旧答复拒绝；不启动子代理或实质修改 |
| V1 | 两个客户端同时编辑、停止超时、相同请求重试 | revision 冲突明确；旧目标 paused；仅一个新版本/运行意图 |
| V2 | refine/pivot 后旧评估/旧验收按钮/旧用量迟到 | 拒绝旧评估与验收；用量照常计入；正式条件不被旧结果覆盖 |
| E1 | 缺 requirementId、局部成功、失败工具证明完成；UI needs_user 且接口 incomplete | 不 completed；先处理真实缺项，不能由 UI 确认隐式覆盖接口条件 |
| E2 | 历史检查对应文件不变/文件已变/环境未知 | 廉价复核后可复用；变化或未知重新检查。替换客观条件须按 §7.2 显式 refine，再按新条件验收 |
| L1 | 日志仅变时间戳、不断换 blockerKey、交付物状态反复往返 | 三轮后停止；有真实阻塞时 blocked，仅缺核实信号时 paused |
| L2 | 新诊断说明、重复回归验证、可信长任务等待 | 说明和重复检查不单独归零；宿主等待不累计轮；停止摘要不编造无路可走 |
| R1 | requestId 去重、用户消息优先、未决批准、temporary 会话 | 原规则保持；普通任务无 Goal 也照常执行 |

实现时按阶段跑受影响测试与包类型检查，避免每次重复全仓库套件。文件落点已有测试包括 `goal-wait-verifier.test.ts`、`session-goal-service.test.ts`、`goal-repository.test.ts`、`goal-transactions.test.ts`、`session-goals.test.ts`、projector/Run admission 测试及 Desktop Goal Banner 测试；新账本与版本补自己的事务测试。新限制回调需验证普通 Run 未注入时的原执行行为。

## 12. 交付与审查控制

本次文档制作使用一名独立子代理集中检查源码适配、职责、预算/并发边界、澄清与变更、验收可执行性；审查者只读取本文和必要源码，不继承全会话、不继续拆代理、不运行完整测试。审查后由主代理修订，重要问题交同一审查者定点复核，避免多轮全文改写与重复调查。

这里的审查节制是工作方式，不代表已设置某个具体 Token 上限。用户未给出数值预算，本次不虚构用量或设置预算数值。功能实施需另行授权；预算预留、货币限额、自动重启继续、独立 Critic、跨 Goal 替代链均不属于本文的首版范围。
