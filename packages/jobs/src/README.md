# 后台任务共用接口

[index.ts](index.ts) 定义宿主请求与筛选入口，[contracts.ts](contracts.ts) 定义纯数据，包括 `JobTarget`、快照、列表错误和接纳回执。

[routed-agent-job-host.ts](routed-agent-job-host.ts) 在构造时按 kind 固定来源。read、wait、send、cancel 直接访问 target 指定的来源，不调用 list。list 并行查询每种来源，保留成功项与来源错误，再统一筛选、排序和截断。

本层只保存固定来源引用，不保存任务归属缓存、执行结果或进程。新增数据放 contracts，筛选放 index，路由行为及回归放本目录与 [__test__/](__test__/)。
