# Goal B 阶段实施与审核记录

日期：2026-10-14。状态：已交付，未提交或推送。

依据：[B 实施计划](../plans/2026-10-14-goal-phase-b-token-budget.md)、[Goal spec §6 / B1–B7](../specs/2026-10-14-goal-reliability-and-budget-design.md)。实施分支为 `codex/goal-phase-b`；沿用当前工作区的 A 实现，保留原有未提交代码与其他任务变更，没有另建不含 A 的检出。

## 1. 已交付行为

- B1：唯一模型尝试账本，原始报告按差额合并，终态与旧版本补账，pending / partial / unknown 分开，独立 usage.seq；memory 跟根 Goal 的存储与事务走。
- B2：三个 provider 规范化输入 / 输出 / 缓存，原始调用、重试、压缩、后代和明确来源的记忆纳入计量；工具模式请求 OpenAI 用量，取消也结算。
- B3：统一执行检查、budget 动作、全版本停止与恢复、受限编辑保存、启动对账。预算不清零、调整不自动继续，有限预算缺账暂停，不追加模型总结。
- B4：原 Composer 的可选预算、Banner 的真实小计 / 缺账 / 在飞 / 耗时；状态 revision 与 usage.seq 分别合并，终态 GET 和慢查询补读沿原链路运行。

没有旧数据转换、精确额度预留、货币账本、第二个协调器、额外恢复队列或新的 Desktop Goal 状态。停止是合作中断；已派发请求仍可能超额，数字不会被截成预算值。

## 2. 子代理审核与修订

两名实现代理按不共享的文件范围工作；一名 `goal_b_implementation_review` 集中只读审核，随后仅复核三项发现，未运行另一套测试。

| 发现 | 修订 | 验证 |
| --- | --- | --- |
| P1：消费者取消关闭生成器，可能让已调用尝试永远 pending | 流中提前关闭由 finally 通过可靠 emit 结算；成功尝试先结算，再发布缓冲 progress / 文本 / tool_use_start | 真实 Framework + QueryEngine 的无报告 delta、部分报告 delta、成功后工具事件取消；buffered consumer return 只结算一次 |
| P2：取消后 GET 只查未结束 Goal，账本被 null 擦掉且无法补账 | 原 getCurrentGoal 增可选 includeTerminal；默认仍只查 open，GET 读取最新终态。UI 保留终态账本，仅隐藏 Banner | 持久 / memory 取消后迟到完整报告、同会话 GET、Renderer 在线空结果及 usage.seq 补账 |
| P2：慢 GET 期间新的刷新被吞掉 | 原 readsMap 配一个补读标记，完成后再读一次，不新增监听 | deferred GET 回归先确认一读漏更新，修订后两次读取并显示新 seq |

定点复核确认上述三项关闭，无必要的残留修正。另保留预算拒绝穿过真实 Child → EventBus → projector 的回归：client 未调用、没有投影补偿，正常清理事件仍能投递。

## 3. 检查与实际范围

集中检查后只因具体修订重跑受影响文件；没有全仓测试或模型网络调用。以下计数来自相应检查批次，跨批次有重叠，不能相加当作唯一测试总数。

- Services / protocol：账本 16 项、GoalRepository 6 项、protocol 8 项，以及事务、临时记录、结构 inventory 和 Run 查询回归通过；services / protocol 类型、db:check 通过。
- API / Core / Runtime：75 / 87 / 107 项相关回归通过，包含取消三种出口、工具批准后的检查、Child 复用和记忆来源；三包类型检查通过，Runtime dist 已构建更新。
- Server：首次八文件 181 项中两项新增夹具遗漏 running 转换，修正后 GoalService 42 项通过；后续 projector / GoalService / 后置维护 88 项通过，新终态 GET 单项另行通过。其余等待、Admission、Control 与启动回归均通过。
- Client：sync / controller 22 项通过。
- Desktop：Renderer 的 GoalActions、订阅 store、刷新器、Banner 与停止原因回归通过。Main 初次回归有新夹具缺少首个通知及一个 Write 等待超时，修订夹具和增加提前失败保护后，usage / ACK 与真实 Write 两项定点回归通过；其余 Main 用例在首批已通过。
- Server / client 类型、Desktop web / node 类型、数据库结构与 diff 空白检查通过。未搭 UI 预览、截图或视觉 E2E；样式由用户查看反馈。

## 4. 边界

计量只使用新原始报告，不把旧展示字段的默认零当作完整。Anthropic 无法证明缓存字段为零时保持 partial。总预算面对缺账停止新增工作；用户可明确解除限制后另行继续，缺账提示仍在。

当前格式的未结算持久记录在重启时转 unknown；不回填旧事件或转换旧库，不自动重建实际数据库。由 Goal 触发且无法携带来源的自动 Dream 跳过，独立周期工作维持原行为。C 的准备阶段、正式要求和目标演进审计尚未实施。
