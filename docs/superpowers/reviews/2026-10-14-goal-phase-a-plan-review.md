# Goal A 阶段实施计划审查与修订记录

日期：2026-10-14。

> 用户补充“不用兼容旧数据”后，旧请求/旧等待转换与升级接管已从计划删除。下列审查结论按当前单一格式收敛，运行期的失败重试和重启恢复继续有效。

审查对象：[分阶段路线](../plans/2026-10-14-goal-improvements-roadmap.md)、[A 阶段详细计划](../plans/2026-10-14-goal-phase-a-reliable-waits.md)。依据：[Goal spec](../specs/2026-10-14-goal-reliability-and-budget-design.md)。源码基线：`04eea243ecce37f0ace914c8a63076085d302adc`。

## 1. 结论与方法

本次只交付实施计划，不修改运行代码或运行计划里的测试。使用一名独立子代理 `goal_phase_a_plan_review`，不继承完整聊天，集中核对必要源码；主代理修订后，同一代理定点复核 §3–8。不再拆代理、不运行完整测试、不重做 Codex 逆向调研。

复核确认原六项意见已基本闭环，职责保持在原模块内。复核最后提出同一 resume 请求二次派发失败的重试入口及排队 Child 的开跑检查两点，明确补清即可进入实施，无需全文再审；主代理已完成这两项补充及回归要求。

结论：可以按计划进入 A 阶段，代码实施仍需用户授权。计划审查不表示行为已实现或回归测试已经通过。

## 2. 第一轮核心修订

| 问题 | 失败场景 | 计划修订 |
| --- | --- | --- |
| 原审查中的旧请求升级问题已撤出范围 | 用户已明确不兼容旧数据，无需设计接管路径 | 删除转换阶段、旧快照归档/回放与专用启动扫描；只按当前请求契约查询和去重 |
| 每 Run 取消参数与准确中断接口缺失 | 父 P1 取消误关闭正在处理 P2 的 Child；根终态后旧后代漏停 | TrustedChildRunParent 带 signal；每 Run 安装/拆监听；handle/directory 准确 interruptRun 并等待清理；RunRepository 查同目标版本，RunControl 停后代 |
| 跨父 steer 混入旧工作 | P2 内容并入仍绑定 P1 的 C1，被计入错误 Goal/版本 | 同父才 steer，异父/无父排队新 Run；维持 plugin/capability 校验 |
| 读取异常到期仍 unknown | 持续 DB 异常导致永久退避；迟到观察误把早期失败写成超时 | deadline 后异常为 wait_timeout；已落盘失败/中断先于时钟；成功依 finishedAt 判是否赶上截止 |
| 等待派发失败没有可用恢复入口 | 原意图 pending，validateResume 一律拒绝，普通 resume 又创建新 Run | 原 Run 保存 goalWaitSource，stopReason.runId 定位；已有 continuation 定点查询，例外只复用未派发且核验通过的原 Run |
| completed 暂不能接纳后不再观察，事务可能半提交 | 有用户 work 保留 wait 却不再安排 timer；recordContinuation=false 仍清 wait | callback 明确 observe_again/settled/stopped；false 必须回滚 Goal/Run/Input/事件；批准分支停观察，走有效 resume |

额外明确：projector 接收评估要求 running，service 结算要求真实终态；结构评估错误为 assessment_invalid，具体等待记录/归属错误为 wait_invalid。

## 3. 定点复核后的最后补充

1. resume 复用原意图后若再次派发失败，动作请求保存 wait-dispatch-retry 与 retryRevision。相同 requestId 重试先核验该 phase 的候选和状态，事务恢复 active，派发原 runId；不走会拒绝 paused Goal 的普通 finishDispatch，也不重新 persist。用户期间暂停/取消/修改导致冲突，不恢复执行。
2. 所有排队 Child 真正开始时检查 Goal 状态/正文版本；父已终态、signal 未 abort 也不能放行旧工作。run.started 接纳在模型调用之前，避免只有 post-run spawn 检查有效。
3. 增加两次派发失败后同请求成功、失败后用户暂停再重试不恢复，以及父终态后队列旧版本拒绝的回归要求。

## 4. 简化与检查范围

- A 不包含 Token 账本、preparation、正式要求、GoalRead、独立 Critic 或新协调器；B/C 只列交付单元和依赖，暂不复制逐行步骤。
- 新接口是现有 handle/directory 的准确路由、Repository 的只读查询、service 的事务入口；未创建第二份运行状态或恢复队列。
- 主代理修正了一个失败测试样例：旧 parser 的对象展开可能已让样例通过，改为检查 assessment tool 实际 emitted payload 中的正文版本，不把已通过用例冒充红灯测试。
- 文档步骤未运行。检查仅包括相对链接、引用路径分类、任务覆盖、占位/尾部空白和 git diff --check；UI 实施后由用户查看样式。
- 用户未给具体 Token 数值，本轮不设置或虚构用量；预算节制为一名审查者、一次集中修订与一次定点复核。
- 本轮按用户补充缩减数据范围：只同步当前初始化结构与 ORM snapshot，不设计旧数据转换或用量回填；当前格式从空库创建后重开仍须保留数据。没有执行任何实际清理。
- 删除兼容步骤后，原计划审查者追加一次简短定点检查：五份文档约束一致，当前格式的持久化、重启、去重与派发失败重试均保留；检查通过，无需继续全文复审。
