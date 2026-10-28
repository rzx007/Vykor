# daemon 任务适配

[daemon-job-service.ts](daemon-job-service.ts) 的入口是 `DaemonJobService`。它核对所属会话及会话是否接受输入，输入提交持有现有 DaemonOperationGate 租约直到接纳结束，避免与项目重绑定交错，然后转发共同 Node Jobs host；不决定 wait、停止、重开或结果状态。

[job-snapshots.ts](job-snapshots.ts) 只转换已有持久任务并提供只读 archive。旧 Agent 没有可核实 runId 时，列表 errors 说明无法定位；不猜当前轮。旧轮结果从对应 run 的持久消息读取。[child-activity.ts](child-activity.ts) 读取已有有界活动记录，[index.ts](index.ts) 汇总入口。

执行状态属于真实 child handle、supervisor、Terminal provider 与 WorkflowHost，持久记录属于 SessionStore。本目录只适配授权与返回格式。新增读取适配放现有文件，回归放 [__test__/](__test__/)。

框架子运行归档按 target.runId 读取对应 Run 的错误、输出与 `metadata.childFailure`，不借用最新 Task 的失败信息或结束时间。归档始终只读，当前输入能力可与实时快照不同；独立进程仍按原来源处理。定点归档回归位于 [job-snapshots.test.ts](__test__/job-snapshots.test.ts)。

归档列表与定点读取复用 readChildFailure 校验版本、来源、非空正文和报告身份；无效报告不进入快照或 details，已知停止原因仍可返回。
