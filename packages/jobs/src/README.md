# 后台任务共用接口

| 文件 | 用途 |
| --- | --- |
| [index.ts](index.ts) | `@vykor/jobs` 公开入口，请求与宿主接口、终态判断和列表筛选 |
| [contracts.ts](contracts.ts) | 任务快照、能力、状态、输出和等待结果，也由 `@vykor/jobs/contracts` 公开 |
| [composite-agent-job-host.ts](composite-agent-job-host.ts) | 将多个任务来源组合成一个 `AgentJobHost` |

`filterJobSnapshots` 验证时间与数量条件，筛选快照后按启动时间从新到旧排序。组合宿主的 `list` 先查询各来源、检查同一会话内任务标识是否冲突，再合并筛选；读取、等待、输入和取消都转交给任务所属来源。未缓存的任务会先通过各来源的列表重建归属，同一会话内找不到任务则报错。

组合宿主只保存来源列表和按会话、任务标识建立的内存归属缓存。输出正文、运行状态和进程句柄保留在各来源；`send` 的宿主授权证据只转交，不在本包解释。

新增共用数据放 `contracts.ts`，接口与筛选放 `index.ts`，组合行为放对应实现文件。测试放 [__test__](__test__/)。
