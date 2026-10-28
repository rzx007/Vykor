# daemon 任务适配

[daemon-job-service.ts](daemon-job-service.ts) 的入口是 `DaemonJobService`。它核对所属会话及会话是否接受输入，然后转发共同 Node Jobs host；不决定 wait、停止、重开或结果状态。

[job-snapshots.ts](job-snapshots.ts) 只转换已有持久任务并提供只读 archive。旧 Agent 没有可核实 runId 时，列表 errors 说明无法定位；不猜当前轮。旧轮结果从对应 run 的持久消息读取。[child-activity.ts](child-activity.ts) 读取已有有界活动记录，[index.ts](index.ts) 汇总入口。

执行状态属于真实 child handle、supervisor、Terminal provider 与 WorkflowHost，持久记录属于 SessionStore。本目录只适配授权与返回格式。新增读取适配放现有文件，回归放 [__test__/](__test__/)。
