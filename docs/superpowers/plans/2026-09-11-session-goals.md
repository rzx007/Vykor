# 会话目标实现计划

依据：[会话目标设计](../../session-goals-design.md)。本文是实现前计划，不代表功能已实现；不做旧 Goal 数据兼容，不包含站点。用户明确允许主分支开发、最后统一运行相关测试；编写测试随实现进行，执行集中在最后。

## 已核实的接入位置

- `packages/server/src/application/session/session-run-engine.ts`：持有 SessionRunCoordinator、runPromises 和 pendingAdmissions，负责入队与 steer。
- `packages/server/src/runtime/run-coordinator.ts`：每会话车道、AbortSignal 与 AgentRunHandle，不保存业务目标。
- `packages/server/src/application/session/session-run-executor.ts`：读取持久输入、调用 agent.submitMessage、等待 run.result，然后执行维护及清理。
- `packages/server/src/application/agent/daemon-agent-event-projector.ts`：将 run.completed/failed/interrupted 投影到数据库；不能收到 completed 就立刻运行下一目标回合。
- `packages/services/src/session-runtime/schema.ts`、`store.ts`、`migrations/`：当前 SQLite/Drizzle 状态与事件持久化。当前最后迁移为 0017，实施时重新确认编号。
- `apps/desktop/src/renderer/src/stores/desktop-session/composer-draft-state.ts`：每会话独立 document 与 attachments。
- Composer 已拆分为 `composer.tsx`、`rich-prompt-input.tsx`、`composer-picker-plugin.tsx`、`context-picker.tsx`，可独立接入目标模式。

以下新文件和方法为拟新增接口，不表示仓库当前已提供。

## 任务 1：共享协议与持久化

新增 `packages/protocol/src/session-goals.ts` 并从 `index.ts` 导出；使用设计文档的 GoalStatus。创建、修改、动作请求都必须带 requestId，修改及动作带 expectedRevision。限制 objective 为非空文本、最长 32,000 字符；maxAutoTurns 为 1—1,000 的整数，默认 20。

```ts
type GoalAction = 'pause' | 'resume' | 'cancel'
interface GoalActionInput {
  requestId: string
  expectedRevision: number
  action: GoalAction
  additionalAutoTurns?: number
}
interface GoalAssessment {
  goalId: string
  revision: number
  runId: string
  decision: 'continue' | 'complete' | 'waiting_user' | 'blocked'
  progress: string
  evidence: string[]
  nextStep?: string
  reason?: string
}
```

补充共享类型 `GoalWait` 与 `GoalEvidenceRef`，由目标子记录持久化：

```ts
type GoalWait =
  | { kind: 'user'; questionId: string; question: string; replyInputId?: string }
  | { kind: 'approval'; permissionRequestId: string }
  | { kind: 'external'; handleId: string; runId: string; deadlineAt: number }
interface GoalEvidenceRef {
  goalId: string
  revision: number
  runId: string
  messagePartId: string
  criterion: string
}
```

GoalAssessment 增加 `evidenceRefs: GoalEvidenceRef[]` 和可选 wait；evidence 字符串仅用于可读说明。用户答复携带 questionId，由服务端关联 replyInputId；批准通过已有权限请求 ID 对账。普通输入无此关联不得自动解除 waiting_user。

修改 schema/store，增加目标、目标请求、目标评估和续跑意图表。目标未终结状态建立 sessionId 部分唯一索引；评估按 goalId/revision/runId 唯一；续跑意图按 goalId/revision/previousRunId 唯一。请求表保存 requestId、内容指纹、状态与结果；相同 ID 不同正文返回 409。

- [ ] 新增 store 方法：createGoal、getCurrentGoal、updateGoal、recordGoalAssessment、recordGoalContinuation；更新检查 expectedRevision，状态变化也递增 revision。
- [ ] 将目标状态、对应事件、首次输入/续跑意图在同一数据库事务中持久化；内存队列从持久意图投递。投递失败保留意图并可重试。
- [ ] 新建表使用正常数据库结构迁移；不写旧 goal 字段转换或双读。不能将“不做兼容”解释为不安装新表。
- [ ] `packages/services/src/session-runtime/__test__/session-goals.test.ts` 覆盖重复创建、同请求冲突、同会话两个目标、版本冲突、事务回滚和重放去重。

## 任务 2：目标用例与接口

新增 `packages/server/src/application/session/session-goal-service.ts`，由 `daemon-application.ts` 装配。新增 `packages/server/src/http/routes/session-goal.ts` 并在现有 HTTP 路由装配处注册。

| 请求 | 作用 |
| --- | --- |
| GET /sessions/:sessionId/goal | 优先未终结目标，否则最近终态目标，否则 null |
| POST /sessions/:sessionId/goals | 创建目标并持久化首次运行意图 |
| PATCH /sessions/:sessionId/goals/:goalId | 修改正文并请求继续 |
| POST /sessions/:sessionId/goals/:goalId/actions | 暂停、恢复、取消 |
| GET /sessions/:sessionId/goal-requests/:requestId | 查询响应丢失后的操作结果 |

响应返回 goal、requestId、operation 状态；202 表示已接受、仍等待中断/排队处理，不能让 UI 误认为修改已完成。目标创建/修改的请求携带当前 items 与 attachments，复用现有附件归属校验和输入持久化。

- [ ] 归档会话、会话/goalId 不匹配拒绝；目标操作复用 daemon operation gate。
- [ ] 编辑：先持久化暂停与修改意图，撤销旧目标未开始的续跑，再中断旧 run。中断失败保留暂停与错误；成功后应用正文、推进版本、排队。
- [ ] 初次目标创建发生在普通 run 运行期间时，只排到该普通 run 后面，不中断普通 run。
- [ ] waiting_user 的问题/批准 ID 持久化；拒绝或无关消息不能恢复。blocked 恢复需重新检查原因；额度耗尽只能显式增加额度后恢复。
- [ ] 增加 `session-goal-service.test.ts` 和 `http/routes/session-goal.test.ts`，覆盖 400/404/409、幂等、暂停/恢复、迟到结果与中断失败。

## 任务 3：目标上下文和每轮评估

新增 `packages/server/src/application/session/session-goal-context.ts`，在 session-run-executor 构建请求内容时加入目标正文、当前版本与成功条件检查指引。保持用户原始 items/附件不变。steer 和 live child 路径必须携带所属目标关联，不能让同会话输入绕过目标评估。

新增 Agent 可调用的目标评估工具（具体注册方式沿用 `packages/agent-runtime/src/default-runtime-tools.ts`），调用参数使用 GoalAssessment 的业务字段；goalId/revision/runId 从当前运行绑定，不信任模型提供的任意 ID。通过现有 domain.event 持久化评估建议。

工具构造新增于 `packages/agent-runtime/src/goal-assessment-tool.ts`。运行身份从 `framework-agent-run.ts` 创建的每轮 AgentExecutionContext 传入，扩展 core 的运行上下文类型以携带服务端验证的目标绑定；query-engine 调用工具时传递此绑定。不得把首轮 goalId/revision 捕获在 AgentPool 缓存实例的闭包中。无目标绑定时隐藏该工具，调用时仍须二次校验。

- [ ] 评估工具只提交建议，不启动下一轮。只对有目标关联的运行开放。
- [ ] 新增服务端证据校验函数：按 messagePartId 读取实际结果，检查所属 run、目标版本和成功状态；模型不能自行制造验证结果。证据不存在或只是普通陈述时不接受 complete。证据是否覆盖 criterion 的业务含义仍由 Agent 评估，服务端只保证来源与状态，主观判断交用户验收。
- [ ] 建议 complete 时校验存在逐项证据；证据引用当前版本的实际检查结果。主观验收转 waiting_user；缺失评估转 paused 并说明。
- [ ] 一个 run 的多次评估保留最新有效建议，处理 run 结束后到达的建议时拒绝影响已结算目标。
- [ ] 压缩后重新加入有效目标；目标正文不是 presentation-only 消息。状态展示消息不进入模型上下文。
- [ ] 测试覆盖评估归属、伪造标识、缺失评估、过期版本、正文压缩后保留、presentation 不进入上下文。

## 任务 4：续跑与停止

新增 `packages/server/src/application/session/session-goal-coordinator.ts`。SessionRunEngine 在执行器 Promise 结算并释放会话车道后调用目标结算；投影器负责记录事件，不直接续跑。结算检查数据库终态，不能把 executor 捕获错误后的正常 Promise resolve 当作 run 成功。

- [ ] 事务中验证目标 active、版本匹配、无用户输入待入队/执行、无未决权限、额度未尽；生成唯一续跑意图，经现有入队接口投递。
- [ ] 新增 `SessionRunEngine.dispatchPersistedRun(runId)`：只投递数据库中已创建的 pending run；runPromises/当前车道已有同 run 时直接返回，非 pending 时不执行。持久意图重放走此接口，不能重调普通 admit 接口（其已有 pending 分支只返回 queued，不重新 enqueue）。交付测试模拟“事务完成、内存 enqueue 前中断”，恢复后同 run 只执行一次；服务重启暂停规则仍优先于重投。
- [ ] 每个自动 run 开始前重新校验，并原子增加 autoTurnsUsed。显式用户回合不计自动额度。
- [ ] 用户提交与自动续跑创建使用同一会话准入锁；覆盖尚在 pendingAdmissions、尚未进入数据库的用户消息。普通用户消息优先，撤销旧续跑意图，处理完再评估。
- [ ] pause/cancel 只撤销该目标关联 run，不能用清空整个会话队列代替。旧版本或已暂停自动 run 必须在开始前跳过。
- [ ] 三轮无进展 blocked；有效外部等待沿用现有句柄，不重复开新 run，记录截止时间。运行终结的等待不能冒充活跃等待。
- [ ] 重启先完成 run 对账，再暂停 active 目标并作废未开始续跑；waiting_user/blocked 原样保留。恢复显式触发。
- [ ] `session-goal-coordinator.test.ts` 覆盖自动两轮后完成、预算耗尽、无进展、有效等待、用户输入竞争、暂停竞争、旧结果及重启重放。

## 任务 5：Client、Desktop IPC 与状态同步

修改 `packages/client/src/transport/http-client.ts`，增加对应目标方法；修改 `apps/desktop/src/shared/session-types.ts`、`desktop-api-contract.ts`、`ipc-channels.ts`、`preload/desktop-api.ts`、`main/features/session/session-service.ts` 和 `ipc.ts`，端到端使用共享解析器。

新增 `apps/desktop/src/renderer/src/stores/desktop-session/goal-actions.ts`，接入 store/types。目标状态按 sessionId 保存，快照包含 currentGoal，goal.updated 事件携带版本；低版本事件忽略。中断未结束单独显示操作进行中，不覆写目标业务状态。

- [ ] sendGoal、editGoal、pauseGoal、resumeGoal、cancelGoal、refreshGoal 均捕获原会话 ID，迟到响应不污染当前页面。
- [ ] 新会话复用现有创建逻辑；创建会话成功后重试必须复用该 sessionId。关闭错误只清提示。
- [ ] 相关 IPC 与 store 测试覆盖结构化目标请求、错误透传、快照恢复、版本乱序及会话切换。

## 任务 6：Composer 目标模式

扩展 `composer-draft-state.ts`：目标编辑模式和普通草稿按 scope 保存；新增 `composer/goal-mode-pill.tsx`。修改 context-picker 的 action 联合、composer-picker-plugin、composer、rich-prompt-input、conversation-page，以及 `session/new-conversation-start.tsx`，覆盖新建和已有会话两个入口。

- [ ] `@/+` 目标及 `/goal` 进入同一模式，消费触发 token，改变 placeholder 为用户确认文案，显示“× 目标”胶囊。
- [ ] 新建目标使用当前正文；编辑已有目标暂存普通草稿。关闭胶囊按设计恢复草稿，不操作持久目标。
- [ ] 发送按钮和 Enter 走 sendGoal/editGoal；Shift+Enter 换行、IME 不误发。空白正文禁发；提交中禁重复提交和退出。
- [ ] 服务端确认保存与入队后恢复普通模式；202 操作未完成时保持提交态并等待事件/查询，断线可按 requestId 对账。
- [ ] `composer/__test__/goal-mode.test.tsx` 覆盖三种入口、关闭、输入法、成功、失败重试和会话切换；附件沿用现有链路。

## 任务 7：Banner、详情及验收

新增 `composer/goal-banner.tsx`、`composer/goal-details.tsx`，在 conversation-page 和新会话创建成功路径接入。复用现有 Button、Popover/Dialog 与样式变量。更新 Composer README 和目标设计文档的实现状态。

- [ ] Banner 与输入框同宽：图标、状态、目标摘要、暂停/恢复/取消/详情。终态可收起，隐藏按 goalId 保存，不隐藏后续新目标。
- [ ] 详情显示完整正文、阻塞原因、证据与额度。等待批准显示原批准入口，不提供绕过权限的继续按钮。
- [ ] 取消保留对话和产物；请求失败保留真实状态，错误可关闭。
- [ ] 最终执行各包相关测试：protocol 的 Goal 解析；services 的目标存储；server 的目标服务/路由/续跑/上下文；desktop 的 IPC、goal-actions、goal-mode、Banner，以及现有 Composer/附件回归。
- [ ] 类型检查使用各包 check-types；Desktop 使用 `pnpm --filter @vykor/desktop typecheck`，不能以不展开项目引用的根 tsconfig 检查代替 node/web 检查。
- [ ] 手动验证：创建目标 → 发送 → Banner → 普通消息插入 → 暂停 → 继续 → 完成；补充编辑、取消、刷新与网络断开。只有真实完成这些检查后才勾选完成。

## 交付记录

实现已完成。初版实现经代码审核判定存在持久续跑、幂等、Run 结算和前端状态归属问题，随后重构为：目标请求/input/run 在一个持久事务内创建；Run 先落库后投递；车道释放后统一结算；启动时对账；目标工具按 Run 绑定；Desktop 使用按 scope 的 goal-actions。最终相关验证为 protocol 13、core 1、agent-runtime 17、services 3、server 46、desktop 69，全部退出码 0；七组 TypeScript 检查、electron-vite 生产构建及用户手动启动均通过。代码审核未发现剩余 Critical/Important 阻断。
