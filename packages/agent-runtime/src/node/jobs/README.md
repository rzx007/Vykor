# 本地 Job 接入

`local-agent-job-host.ts` 提供 `LocalAgentJobHost`，把本地执行和 agent 子任务接到统一的 Job 接口。Job 表示可查询、等待和取消的一项后台工作。

调用方注入执行管理、持久化、事件和路由能力。宿主按工作类型转交请求，把状态与结果转换为调用方需要的记录，并在关闭时处理自己负责的后台工作。

状态由注入的仓库和执行管理器维护，本层保存这些能力的引用与所属范围。新增 Job 接入规则放在这里，通用 Job 数据约定放在 `@vykor/jobs`，子任务等待适配放在 `../children/`。测试放在同层 `__test__/local-agent-job-host.test.ts`。
