# Goal 改进分阶段实施路线

> 日期：2026-10-14
> 状态：A/B/C 已实施并完成集中审核修订。交付记录见 [A 实施审查](../reviews/2026-10-14-goal-phase-a-implementation-review.md)、[B 实施审查](../reviews/2026-10-14-goal-phase-b-implementation-review.md)、[C 实施审查](../reviews/2026-10-14-goal-phase-c-implementation-review.md)。
> 修订：用户明确不兼容旧数据；只维护当前格式，不设计转换、回填或升级接管。
> 规格：[Goal 持续执行改进规格](../specs/2026-10-14-goal-reliability-and-budget-design.md)。
> 详细计划：[A：可靠等待与停止原因](./2026-10-14-goal-phase-a-reliable-waits.md)、[B：真实用量与可选 Token 预算](./2026-10-14-goal-phase-b-token-budget.md)、[C：准备澄清与可核实进展](./2026-10-14-goal-phase-c-verifiable-progress.md)。
> 审查：[A 计划审查](../reviews/2026-10-14-goal-phase-a-plan-review.md)、[B 计划审查](../reviews/2026-10-14-goal-phase-b-plan-review.md)、[C 计划审查](../reviews/2026-10-14-goal-phase-c-plan-review.md)。
> 源码基线：`04eea243ecce37f0ace914c8a63076085d302adc`。实施基线：`3736165e`；保留其他任务改动。

**目标：**先保证目标知道自己在等什么、为何停止，再加入真实预算，最后提升完成条件与防循环判断。

**架构：**继续由 SessionGoalService 结算目标、现有 RunAdmission/RunControl 保存和执行 Run、GoalRepository 做事务读写。每个阶段使用同一套当前协议；不引入第二个协调器、常驻评审代理或通用预算平台。

**技术栈：**TypeScript、Vitest、SQLite / Drizzle、现有 Agent Runtime、HTTP/SSE、React Desktop。

## 1. 阶段与完成标准

| 阶段 | 用户可见结果 | 必须完成的内容 | 验收后才能展开的内容 |
| --- | --- | --- | --- |
| A（已交付） | 完成的子任务不再被一直等待；暂停原因可区分 | 最小 objectiveVersion、可信逐 Run 父关系、等待真实 targetRunId、停止原因、等待恢复的完整接纳检查与唯一事务 | B 的账本；C 的正式要求/准备阶段 |
| B（已交付） | 能设置可选 Token 预算，并看到真实已知量与缺账 | 唯一模型尝试账本、缓存口径适配、迟到补账、后代归集、共享执行检查、有限预算缺账停止、usage.seq 和 UI | 准确货币成本、绝对不超额承诺、精确余额预留 |
| C（已交付） | 模糊目标先补条件，修改目标有版本记录，空转有依据地停止 | preparation/ready、正式 requirementId、GoalRead、版本审计、指定要求验收、历史证据复核、三类 progressSignals | 独立 Critic、任意诊断语义归一、跨 Goal 替代链 |

三个阶段都保留六个 GoalStatus、requestId 去重、用户消息优先、未决批准保护、普通任务不依赖 Goal、临时会话不落盘、默认次数上限和当前重启恢复规则。未交付的能力不提前加 UI 开关。

## 2. A 阶段任务顺序

1. **A1：当前数据结构。** 两个 Goal 字段及持久/临时一致性，revision 与 objectiveVersion 分离；初始化 SQL 与 ORM snapshot 同步。
2. **A2：根 Run 绑定。** 从排队、开始到工具评估/证据核对使用宿主正文版本；保留当前请求的冲突检查和去重。
3. **A3：Child Run 归属。** 每次新子 Run 捕获当前可信父 Run，复用/排队/steer 不串账；投影到持久 metadata。
4. **A4：等待核验。** 固定 targetRunId 与 ownerRunId，验证父链、终态、截止时间，移除会话存在即 running。
5. **A5：恢复接纳。** observer 只观察；Goal 服务在事务内检查并保存唯一后续 Run，提交后交原队列派发。
6. **A6：停止原因与展示。** 覆盖所有 A 阶段停止路径，UI 按 code 展示，保持原有操作入口。
7. **A7：整体验收与交付。** W1–W4、S1 的 A 子集、V1/V2 的身份子集、R1；完成针对性回归、类型检查和实现后审查。

A1–A4 可各自形成小提交，但 A 整体在 A5/A6 完成前不标记交付。当前数据结构、协议和运行链作为一套版本发布，不提供旧格式适配；当前格式内的持久化、重启恢复与失败重试继续验收。不自动删除或重建实际存储。

## 3. B 阶段边界与检查点

在 A 的可信 Run 身份之上增加一次模型尝试的 usage 记录，provider 只负责规范化输入口径，projector 写事实，Goal 服务关门禁，执行器在现有尝试/工具/派生边界检查宿主允许/停止结果。

已在 [B 详细计划](./2026-10-14-goal-phase-b-token-budget.md) 细化四个交付单元：当前账本/迟到补账、原始调用及后代归集、可选 Token 检查、usage.seq 与 UI。每单元的入口/结果均以规格 §6 和 B1–B7 为验收依据；审查修订见 [B 计划审查](../reviews/2026-10-14-goal-phase-b-plan-review.md)。保留 Token 可能因已派发调用或迟报而超额的明确文案；耗尽不新增模型收尾调用，不重建或回填旧用量。Desktop 用量事件复用现有 getGoal 刷新，不另建 Goal 同步状态。

B 的开工条件：A 的 Child 复用身份、等待恢复事务、停止原因及普通 Run 回归已通过。B 的交付条件：重复/迟到事件不多算，当前调用 partial/unknown 不假装零，所有后代共享门禁，取消待派发工作但不声称回滚已有副作用。

## 4. C 阶段边界与检查点

继续使用原 Goal-linked Run、GoalAssessment 与编辑/actions 接口。准备在独立的受限 preparation Run 中结束，ready 后由宿主冻结正式条件并唯一派发 initial。模型只提建议，正式版本变化来自可信用户输入。

已在 [C 详细计划](./2026-10-14-goal-phase-c-verifiable-progress.md) 细化为四个交付单元，按依赖顺序实施：C1 当前契约与版本记录，C2 受限准备/澄清与 GoalRead，C3 用户变更/完整集合/历史证据与指定项验收，C4 可核实进展/防循环与原界面。以 C1/C2、V1/V2、E1/E2、L1/L2 为验收依据；只新增版本表，沿用请求结果和 assessment JSON，最多四份新增生产文件。

已实现预算暂停后保留 ready、普通继续与明确重新整理、正文引用和摘要同次读取、进展事实持久去重；准备建议提交后不再增加收尾模型调用。计划审查见 [C 计划审查](../reviews/2026-10-14-goal-phase-c-plan-review.md)，实际六项修订与集中验证见 [C 实施审查](../reviews/2026-10-14-goal-phase-c-implementation-review.md)。

C 的开工条件：B 账本能覆盖准备/重试/后代并阻止越过有限预算。C 的交付条件：准备不无限重试，变更不重置总量，主观确认不能掩盖客观缺项，换 blockerKey/日志时间戳不能绕过停止，暂停报告不编造“已无路可走”。

## 5. 工作方式与预算

- 本次规划一名独立审查者，一次集中审查加必要的定点复核；不并行写相互依赖的 A 任务，不运行模型 E2E 或全仓测试。
- 按用户实施指令轻量执行：补关键回归后集中运行受影响测试、类型与结构检查；只因新修改、失败或未解决风险重跑相关文件，不运行全仓测试。
- 实现后审查集中于身份归属、事务/重启和状态保护；文档审查不替代实现后审查。修改涉及同一文件时顺序执行，避免多代理同时编辑。
- 不设置用户未指定的数值 Token 预算，不报告无来源的精确使用量；这里的预算控制是工作节制。是否提交/推送按用户届时授权执行，只收录本任务路径。
- A/B/C 已获用户实施授权并交付；部署、定时任务不在本次范围。变更保留于当前工作区，未提交或推送代码。
