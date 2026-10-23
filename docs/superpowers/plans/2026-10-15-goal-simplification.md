# Goal 收缩精简实施计划

> 面向执行者：按 P1 → P2 → P3 顺序修改，使用 executing-plans；P4 集中验证并请一名子代理审核，修订后只复核发现的问题。用户要求优先：不逐步骤审批、提交或重复跑全套测试。
> 日期：2026-10-15。状态：P1–P3 代码改造及 P4 集中自动验证、审核修订已完成；真实应用切换与模型体验测试未执行。见 [实施审查](../reviews/2026-10-15-goal-simplification-implementation-review.md)。

**目标：** 将 Goal 收缩为持久目标、空闲续跑和模型自检，保留用户控制、可靠等待及已有用量限制。

**实现方式：** 复用 SessionGoalService、现有 Run 队列、等待观察器和用量账本。GoalUpdate 替换 GoalAssessment，只按需提交控制请求；普通回合无需汇报即可续跑。模型判断完成与连续阻塞，服务端核对身份、状态和执行资格。

**技术栈：** TypeScript、现有 Agent Runtime、SQLite / Drizzle、Vitest、Desktop React。

**规格：** [Goal 收缩规格](../specs/2026-10-14-goal-reliability-and-budget-design.md)。本计划替代旧 A/B/C 路线的后续实施指令。

## 1. 全局约束

- 默认自动续跑次数为 0，表示不限；Token 预算缺省，不要求用户填写。
- 不兼容旧 Goal 数据；不增加转换、回填、双读、工具别名或旧目标自动接管。
- 不保留 preparing、冻结条件、强制每轮评估、证据引用、新鲜度裁决和进展评分；不另建 Critic、调度器、提问服务或预算平台。
- 保留六种 Goal 状态、requestId 去重、revision 冲突保护、objectiveVersion、用户输入优先、具体任务等待和权限检查。
- 新格式内的旧正文版本、迟到用量及重复事件仍按既有身份规则处理，不能借“不兼容”删除当前运行保护。
- P1–P3 是一次改造的顺序，不作为独立上线版本；协议、服务端和界面一致后再启用，不能让新旧 Goal 逻辑并行运行。
- 只清理 Goal 的专属用途；通用工具结果、文件事实、历史会话消息及非 Goal 能力不做顺带重构。

## 2. 文件与职责

以下路径相对仓库根目录；同一行省略目录的文件名与首文件同目录，不同目录写全路径。在原文件收缩，不按每条规则新增模块。

| 位置 | 改动及职责 |
| --- | --- |
| packages/protocol/src/session/session-goals.ts | 最小 Goal、正文编辑、用户动作及 GoalUpdate 请求；只做结构校验 |
| packages/services/src/goals/goal-records.ts、goal-repository.ts、goal-transactions.ts、goal-version.ts | 最小状态与简单正文记录；删除准备、评估和证据存取 |
| packages/services/src/session-runtime/schema.ts；packages/services/src/database/temporary-control-records.ts | 同步 SQLite 与临时会话结构；保留现有事务语义 |
| packages/server/src/application/goals/goal-run-contribution.ts、goal-read-tool.ts、agent.ts | 简短目标注入、普通工具能力及绑定工具 |
| packages/server/src/application/goals/goal-update-tool.ts | 替代旧评估工具，按需提交状态、问题或具体任务等待 |
| packages/server/src/application/session/session-goal-service.ts、run-admission-service.ts | 前者接纳操作、结算和决定续跑；后者保留排队与开跑复查，移除阶段校验 |
| packages/server/src/application/session/run-control-service.ts | 暂停持久化与真实中断分别尝试，保存失败也不能跳过中断 |
| packages/server/src/application/session/session-run-executor.ts；packages/server/src/application/daemon-application.ts | 装配 Goal 绑定及宿主回调，不判断完成语义 |
| packages/server/src/application/agent/daemon-agent-event-projector.ts | 移除旧评估事件分支；保留真实用量、父子 Run 归属和通用投影 |
| packages/server/src/application/session/goal-wait-verifier.ts、goal-external-wait-observer.ts | 保留具体任务核验、退避与唯一恢复，去除准备/验收依赖 |
| packages/client/src/resources/session/session-resource.ts；packages/server/src/http/routes/session-goal.ts | 同步当前请求形状，沿用既有路由 |
| apps/desktop/src/renderer/src/stores/desktop-session/goal-actions.ts、types.ts | 删除变更类型、验收回执和重整目标动作，保留正文草稿与取消 |
| apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/goal-banner.tsx、goal-edit-fields.tsx、composer.tsx、goal-stop-reason-label.ts | 删除准备/验收展示及必填变更原因，保留已有简洁目标栏和二级详情 |
| apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx | 同步 Composer 参数和提交按钮条件，移除旧必填变更原因检查 |

同步相关 index.ts 导出、装配与测试替身；agent-runtime 的 default-runtime-tools.ts / extensions.ts 将保留名换为 GoalUpdate，不为旧工具保留别名。goal-usage.ts 沿用现有算法，调整类型依赖即可。

## P1. 收缩协议与 Goal 存储

- [x] 删除 phase、preparationEpisode、requirements、assessment/evidence、进展计数及验收回执；清理准备/验收专用停止原因。编辑请求只保留正文、已有附件/输入、requestId 与 expectedRevision，不要求 refine/pivot、原因或替换项。
- [x] 定义严格互斥的 GoalUpdate 输入，不允许模型传入目标身份或额外证据字段：

```ts
type GoalUpdateInput =
  | { status: "completed" | "blocked" | "paused"; reason: string }
  | { question: string }
  | { wait: { targetRunId: string; deadlineAt: number } };
```

- [x] GoalRead 只返回当前正文、版本、状态、等待、停止原因和用量。正文版本记录只保存版本关系、正文、用户请求身份及时间；移除来源、冻结和条件快照。
- [x] 在现有迁移目录追加一次 Goal 局部重建变更（当前下一序号 0007，文件名 goal_simplification），同步 Drizzle journal、snapshot 及数据库清单；不改历史迁移，不修改全库基线或删库启动策略。
- [x] 重建范围限定为 session_goal、session_goal_version、session_goal_model_attempt、session_goal_request、session_goal_continuation；删除 session_goal_assessment，不建替代表。旧 Goal 自有记录全部丢弃，新结构从新建 Goal 开始；保留 session、输入、消息、Run、工具结果及其他业务表。
- [x] 同步 temporary-control-records.ts，移除评估 map 和准备状态，保证临时目标仍只驻内存。保留 goal-usage.ts 的去重、真实尝试记账和迟到用量规则，不在本次重写计量算法。

**交付检查：** 新空库与仅丢弃 Goal 数据的升级库得到同一结构；协议拒绝旧评估/编辑字段；临时会话不落盘。运行期间的目标正文编辑仍保留累计用量和次数。

## P2. 简化执行、控制请求与续跑

- [x] 创建 Goal 直接保存 active 和 initial 运行意图。删除准备批次、ready、工具白名单和 Agent 中的 preparing 能力视图，继续使用普通工具注册与权限。
- [x] 新工具经 GoalRunBinding.submitUpdate 回调进入 SessionGoalService.submitRunUpdate(goalId, objectiveVersion, runId, input)。宿主绑定前三项，只接收无身份的请求；回调替换现有 reviewAssessment 装配，返回 Promise<{ recorded: true }> 或明确的身份/状态/结构错误。
- [x] 沿用现有“Run 内记录、终态结算”时序：submitRunUpdate 在事务内核对当前 active、当前根 Run、版本、权限及限制，将可选请求保存到该 Run 的 metadata.goalUpdate。工具只返回“已记录，回合结束后生效”；不提前宣告 completed，也不强制提前结束 Run，以免最终回复被执行限制截断。不要另增事件表或 goal.update 投影分支。
- [x] settleRun 对正常完成的 Run 再次事务核对状态、版本和停止条件，再应用可选请求。无请求时保持 active，去掉 assessment_invalid、缺 nextStep、证据验证和进展评分门槛，使用原始目标及简短续跑提示安排下一轮。Run 失败仍 paused；用户输入、批准及真实等待继续阻止自动接纳。
- [x] 提问生成宿主 questionId、绑定正文版本并置 waiting_user；有效回答只解除对应等待。任务等待先验证 targetRunId 及期限，结算时保存 active + wait，交现有观察器；完成重新检查后只恢复一次，失败/缺失/失效/超时明确 paused，临时观察失败不重启任务。
- [x] 用户暂停/取消和预算停止撤销续跑；迟到模型请求不得覆盖停止状态。编辑成功使旧绑定、问题、批准关联、外部观察和续跑意图失效，请求停止旧 Run 及其任务；编辑不恢复 paused/blocked 或限制停止，旧回答不能授权新正文。旧真实用量仍补账。
- [x] 修正 RunControl 的 interruptSession / interruptRun：正常情况下先保存暂停并撤销续跑，再中断；暂停保存抛错也必须继续尝试 runtime 中断，通过既有错误通道向界面说明暂停未成功、允许重试，不把“已中断”误报为“已暂停目标”。
- [x] Goal 扩展只注入完整目标和简短规则：按当前状态核查结果、保持原范围、具体任务等待、同一阻塞连续三个 Goal 回合才 blocked，恢复后重新审查。paused 仅响应用户明确请求；宿主不通过评分、字符串比较或额外模型判断阻塞语义。
- [x] 移除旧 goal.assessment 事件处理、goalAssessment/goalPhase 元数据读取和准备/证据回调。保留用量事件、后代归属、预算执行边界、用户优先和请求/结算幂等。

**交付检查：** 普通回合无需工具报告即可唯一续跑；三类控制请求都可达；模型请求与暂停、编辑、预算竞争时不能覆盖宿主决定。普通非 Goal Run 不增加 Goal 依赖。

## P3. 清理界面及失效入口

- [x] Client、HTTP 和 Desktop 同步 P1 请求；保留现有创建/读取/编辑/用户动作路由，不增加平行接口。回答仍走当前问题绑定与响应链路，删除 confirm 和 reprepare。
- [x] 目标栏只显示状态、摘要及适用操作，展开看正文；提问保留已有回答区域。正文编辑保留保存、取消和草稿恢复，删除变更类型/原因字段及要求替换列表；goal-edit-fields.tsx 无剩余用途即删除，不保留空壳。
- [x] 删除准备中、重新整理、逐项验收及证据进展区域和对应文案；用量/次数保留二级详情，默认不限且不强迫填预算。遵循 apps/desktop/DESIGN.md，复用现有组件，样式由用户实际查看反馈，不搭建截图或预览。
- [x] 删除仅供 Goal 使用的 goal-assessment-tool.ts、goal-evidence-reader.ts、goal-assessment-policy.ts、goal-progress-policy.ts 及对应失效测试；同步导出与引用。旧工具历史按普通消息展示，不重新解析为当前 Goal。通用 Tool-Result-Id、文件事实等有其他消费者时保留。
- [x] 更新 docs/session-goals-design.md 为最终收缩行为，旧 A/B/C 继续标为历史；实现完成前不把规格标为已交付，不提前重写其他研究或历史审查。

**交付检查：** 能创建、暂停、恢复、编辑、取消及回答问题；无准备或验收入口残留；不改其他聊天交互。

## P4. 集中验证、审核与切换

开发时先补少量关键行为用例，P1–P3 完成后集中运行；只为定位具体失败定点重跑。不要为被删除的协议继续维护证明包测试。

| 集中回归 | 用例重点 |
| --- | --- |
| protocol / Goal 工具 | 三类请求互斥；拒绝旧字段和模型提供的身份；正常 Run 不要求 GoalUpdate；只有 Goal Run 安装绑定工具 |
| Goal 服务 / 派发 | 无准备直接执行、无请求继续、重复终态只派发一次、用户消息优先；提交后 Run 失败不完成；暂停/预算关闭/编辑后迟到请求无效；暂停保存抛错仍尝试真实中断并报告失败 |
| 等待 / 编辑 | 问题过期回答、批准关联失效、取消编辑不改目标；具体任务终态唯一恢复、读取失败不重启；编辑不解除暂停/限制 |
| 存储 / 用量 | 临时不落盘；新库与 Goal 局部重建；非 Goal 表数据保留；默认不限、有限预算关闭、未知用量处理、后代与迟到用量不重计 |
| Desktop | 保存/取消、正常回答、操作与状态一致、无旧验收/准备区域；不重复验证现有组件自身行为 |

针对已有测试文件定点调整；新增 goal-update-tool.test.ts 替换旧工具测试。下面保留计划命令；实际执行采用本地 node 调用，结果见实施审查：

```powershell
pnpm --filter @vykor/protocol exec vitest run src/session-goals.test.ts
pnpm --filter @vykor/agent-runtime exec vitest run src/goal-update-tool.test.ts src/goal-read-tool.test.ts src/goal-extension.test.ts src/extensions.test.ts
pnpm --filter @vykor/services exec vitest run src/goals/goal-repository.test.ts src/goals/goal-transactions.test.ts src/goals/goal-version.test.ts src/goals/goal-usage.test.ts src/database/session-database.test.ts src/database/temporary-control-records.test.ts
pnpm --filter @vykor/server exec vitest run src/application/session/__test__/session-goal-service.test.ts src/application/session/__test__/session-goal-dispatch-events.test.ts src/application/session/__test__/goal-wait-verifier.test.ts src/application/session/__test__/goal-external-wait-observer.test.ts src/application/session/__test__/session-run-executor.test.ts src/application/session/__test__/run-control-service.test.ts src/application/agent/__test__/daemon-agent-event-projector.test.ts
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/stores/desktop-session/goal-actions.test.ts src/renderer/src/components/desktop/conversation-page/composer/__test__/goal-banner.test.tsx
pnpm --filter @vykor/protocol --filter @vykor/services --filter @vykor/agent-runtime --filter @vykor/server --filter @vykor/client run check-types
pnpm --filter @vykor/desktop run typecheck:web
pnpm --filter @vykor/desktop exec node --test scripts/verify-migration-artifact.test.mjs
```

- [x] 在使用临时数据库的回归中，先插入会话、消息和工具结果，再执行 Goal 局部重建，确认这些原记录及非 Goal 表不变；保留新库、重复打开与迁移打包校验。不得拿真实 sessions.db 做破坏性回归。
- [x] 在现有 run-control-service.test.ts 中用同一组参数覆盖两条中断入口：让暂停写入抛错，断言对应 runtime 中断仍被调用，并能观察到暂停失败反馈。
- [x] 一名子代理集中审核关键竞争条件、删除范围及非 Goal 影响，修订后定点复核，不逐任务派评审。
- [ ] 真实切换时先停止旧服务的 Goal/后代及待派发工作、备份数据库，再启用一致的新版本并执行上述 Goal 局部重建；不手改迁移台账、不删除整个数据库、不恢复旧目标。此步骤是以后实施范围，本轮不执行。
- [ ] 新建一个短 Goal 实跑：创建临时文件 → 子任务改写 → 读取当前内容 → 普通回合续跑 → 最终完成。观察模型是否围绕用户工作而非研究验证器；不再测试“宿主必须拒绝旧证据”。模型自检结果如实报告，不把一次实跑当成所有语义判断的保证。
- [x] 集中验证及修订结束再统一整理提交；本次用户已授权提交并 push。本计划不要求逐任务提交或单独发布中间结构。

**完成标准：** 收缩规格第 10 节八项行为有对应回归或实跑记录；不存在新旧工具/数据格式并行维护；完成判断、权限、调度和存储职责没有混回一起。若语义实跑仍误判，先改正常执行提示或工具能力，不恢复通用证据引擎。

## 3. 计划审核与修订

子代理已集中审核规格覆盖、控制请求时序、状态竞争、数据切换范围与验证命令。发现一项遗漏：暂停持久化抛错可能跳过中断。已核对现有源码，在 P2 补充两条中断入口、文件图补入 RunControl，P4 补充针对性回归及集中命令；不增加停止协调器或额外评审调用。

计划审核确认其他重点无必须修订问题；实施后的集中审核与实际验证另见实施审查，不将计划审核当成代码验证。
