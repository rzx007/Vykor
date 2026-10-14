# Goal B 阶段实施计划审查与修订记录

日期：2026-10-14。

审查对象：[B：真实用量与可选 Token 预算](../plans/2026-10-14-goal-phase-b-token-budget.md)。依据：[Goal spec §6、§9、B1–B7](../specs/2026-10-14-goal-reliability-and-budget-design.md) 与当前工作区 [A 交付](./2026-10-14-goal-phase-a-implementation-review.md)。Git HEAD 为 `f364f7c9`，A 尚有未提交实现；计划不把该提交当作完整 A 基线。

## 1. 范围与方法

本轮只写 B 实施计划和审查记录，没有实施 B、运行计划中的测试或调用真实模型。使用一名独立子代理 `goal_phase_b_plan_review`，不继承完整聊天，只读计划与必要源码，集中审核后仅定点复核发现的问题。

保留用户约束：不兼容旧数据，关键验证集中运行，避免过度设计，职责留在原模块内。新增生产文件限定为单次用量合并文件和 provider 规范化文件；不引入第二个协调器、额度预留平台或新的 Desktop Goal 同步状态。

## 2. 集中审核与修订

| 问题 | 源码中的失败路径 | 已写入计划的修订与验证 |
| --- | --- | --- |
| P1：预算拒绝被投影补偿吞掉，或包装后失去身份 | projector 对 Child 异常补偿后可能返回；EventBus 将 sink 异常包装为 DeliveryError | 定义共享限制错误判断，projector 不对该拒绝做补偿，EventBus 原样拒绝；真实 Child → EventBus → projector 回归断言 client 未调用、无补偿记录，后续清理仍能投递 |
| P2：工具模式未请求 OpenAI 用量 | 当前 createParams 的 stream_options 在 tools 存在时为 undefined | 有 / 无工具都请求 include_usage，provider 测试检查实际请求参数及终结报告；上游仍缺账时保留 unknown，不补 0 |
| P2：Desktop 刷新链路没有选定，文件入口不准确 | Main 实际转发在 session-subscription-service.ts；Client bucket、服务端 SessionStateSnapshot、Desktop view 均不含 Goal | 明确沿原 non-delta 事件 → Main snapshot → Renderer GoalRefreshScheduler → getGoal；不扩充三份状态。补孤立 usage、同窗口文本、ACK、重连与 revision / usage.seq 独立合并的回归 |

主代理核对上述源码后接受三项意见，并补齐 begin 返回的 budgetClosed 字段。取消响应保留 Goal 账本快照，Banner 是否隐藏沿用现有展示状态；取消后的补账不得重新激活目标。

## 3. 责任与验收边界

- B1 保存原始尝试，按差额汇总；pending 单列进行中，不假装缺账，终态和旧正文版本的合法报告仍可补账。
- B2 规范化真实输入 / 输出 / 缓存口径，并绑定根、重试、压缩、后代和来源明确的后置调用；不猜最后一次 Run，不叠加父级汇总。
- B3 用同一预算规则检查执行入口，事务内关闭新增工作，提交后复用原 RunControl 清理；不在事件回调中等待本 Run，不追加模型总结。
- B4 复用原查询与 Banner，Goal revision 和 usage.seq 分开合并；预算变更不自动恢复执行，不把已派发超额量截成预算值。

计划审查不表示能力已实现或测试已通过。数值预算未由用户指定，本轮不设定或报告虚构的 Token 使用量。

## 4. 定点复核与文档检查

同一子代理定点复核 §5.1、§5.2、§6.1、§7 及对应文件与回归要求，确认原三项问题已补齐、budgetClosed 的提交后停止通知已明确，未发现这些问题的剩余实质缺口。未改代码、未跑测试，没有再次全文重审。

文档检查仅限相对链接、任务覆盖、接口一致性、引用路径和 diff 空白；计划中的 provider、服务、运行时、Desktop 测试和类型 / 结构检查留待 B 实施。

交付检查通过：三份相关文档共 13 个相对链接均存在，无未完成标记；10 个完整文件路径区分了计划新建项，其余均存在；路线 diff 与新增文档无行尾空白。未运行行为测试、构建或数据库命令。

结论：B 计划可以进入实施，代码实施仍待用户授权。本次只交付计划和审查记录，A 的现有未提交代码及其他任务改动继续保留。
