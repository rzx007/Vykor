# Goal A 阶段实施审查与交付

日期：2026-10-14。实施基线：`3736165e`。依据：[详细计划](../plans/2026-10-14-goal-phase-a-reliable-waits.md)、[Goal spec](../specs/2026-10-14-goal-reliability-and-budget-design.md)。

## 交付范围

A 已实现：正文版本、结构化停止原因、根/子 Run 的可信绑定、具体 Run 等待核验、等待恢复事务、派发失败的原意图重试，以及原 GoalBanner 的原因展示。六种 GoalStatus 和原队列保留。

只维护当前格式。同步现行 schema、初始化 SQL、0006 snapshot 和结构 inventory；没有新增转换迁移，没有清理或转换实际数据库。B 的 Token 账本、C 的准备/正式要求/版本审计和新防循环规则未实现。

## 职责

- GoalRepository / GoalTransactions 保存字段、当前 Run、状态事件和原 continuation 记录；revision 仍检查状态写入，objectiveVersion 只标识正文。
- Runtime 捕获每次 Child Run 的父 scope 和 signal，projector 从直接父 Run 派生持久 Goal 绑定，在模型调用前核验资格。
- WaitVerifier 只读 owner/target 与最多 128 层父链；observer 只安排退避观察和回调。
- SessionGoalService 在同一事务接纳结果、保存唯一 Input/Run/continuation，提交后调用原 Admission 派发；RunControl 等待根与后代停止。
- Desktop 只按 code 显示短原因，复用已有 Banner 和操作，未增加预览或截图流程。

模型 JobSend 通过当次 controller 发送 Child 输入并返回可信 receipt。直接 handle.send / Desktop 跟进没有父 Run，不继承创建时 Goal。插件授权仍由 manager 检查。

## 子代理审查与修订

由一名独立子代理 `goal_phase_a_code_review` 集中只读审查，无完整聊天继承、无并行代码编辑、无子代理代跑全量测试。修订后同一代理做一次定点复核。

| 发现 | 修正 | 回归 |
| --- | --- | --- |
| 等待结果已接纳，排队期间出现批准，开跑拒绝后 Goal 留在 active 且没有可执行 Run | 开跑前取得可信 permissionRequestId，取消本 Run，并将仍 active/同正文的 Goal 转 waiting_user/approval | Admission 排队时序；Goal 完成等待遇到批准及拒绝恢复 |
| 真实模型 JobSend 直接调用 handle.send，第二 Child Run 丢失当次父身份 | 当前 controller 持有的 Child 通过 sendChildInput，普通 Job 保留原发送路径 | 真实 JobSend 的插件拒绝、第二 Run 父身份及同一子会话复用 |

定点复核结论：两项发现均已修正，未发现剩余实质缺陷或必要权限绕过。子代理结论不代替下面的实际测试。

主代理在回归中另修正暂停结算：先核对 currentRunId 和正文，再清理对应 Run；已暂停目标保留用户原因。父 abort 只中断当次 Run，并在终态拆除监听，不关闭整个可复用 Child。

## 验证记录

按用户指令集中运行受影响测试，仅因新增用例、失败或修订重跑相关文件。A1 新增正文版本用例先确认失败；没有逐任务声称执行全部红灯命令。所有客户端/模型客户端测试使用现有假客户端，无真实模型 E2E。

| 范围 | 文件与结果 |
| --- | --- |
| Protocol | session-goals：7 项通过 |
| Services | goal-repository、goal-transactions、session-database、temporary-control-records、session-goals、run-repository：54 项通过 |
| Agent Runtime | child-agent、framework-agent-run-input、goal-assessment-tool、plugin-child-followup、agent-post-run-child：64 项通过；父取消路径修订后定点复核 |
| Server | Goal service、wait verifier/observer、Admission、Control、projector、live directory、executor：184 项通过；最后补充的评估保护定点复核 |
| Core | goal-context：3 项通过，普通运行不泄漏 Goal 扩展 |
| Tools | job-tools、local-job-host：34 项通过，普通 Job 路径保持 |
| Desktop | goal-banner、goal-stop-reason-label：5 项通过 |

检查：Protocol、Services、Agent Runtime、Server、Client、Tools 的 check-types；Desktop typecheck:web；Agent Runtime build；Services db:check；git diff --check。相关检查通过，未跑整个 monorepo 测试。

覆盖关键边界：同代理第二 Run、不同父排队/身份去重、旧父 abort、排队前父取消、持久父链/循环/错误 Goal 或正文、观察迟到/读取异常到期、未知完成时间、用户优先、批准、次数耗尽、事务回滚、重复观察、两次派发失败后同请求复用、用户暂停阻止旧重试、当前格式重开与 memory 回滚。

## 实施边界

当前格式的重启沿用原运行恢复规则：既有 pending/running Run 会被原维护流程中断；等待记录可以恢复只读观察，其他 active Goal 提示手动继续。已经启动、取消或中断的 Run 不套用“复用未派发等待意图”的例外。

未新增第二套运行状态、恢复队列、协调器或常驻 Critic。没有用户指定的数值 Token 预算，因此不虚构消耗量。本次未提交、推送或部署；其他任务的页面/样式改动保留。
