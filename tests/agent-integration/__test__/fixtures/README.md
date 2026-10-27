# 跨进程操作测试夹具

`s1-tool-operation-worker.ts` 是 S1 崩溃测试启动的独立 Node 进程。
它使用真实临时 SQLite，在派发意图、外部效果或结果确认完成后通过 IPC 通知父测试，然后等待父进程强制终止。

调用入口是相邻的 `durable-tool-operations.integration.test.ts`。
数据库保存操作事实，独立的效果文件保存工具对外写入次数；两者都在父测试创建的临时目录中，进程退出后仍可读取。
新增崩溃位置应在这个夹具中增加明确暂停点，断言放在父测试，不将暂停点加进生产代码。


`task-lifecycle-fixture.ts` 通过真实 Node 工厂与 DaemonApplication/session executor 驱动 Agent、Jobs、Shell、PTY 与 Workflow。受控边界仅为模型网络、环境/清理门闩与指定 store 故障；decorator 完整调用 base.execute，Read 在真实读取后等待释放，整个真实 invocation 保持未结束。Read wrapper 明确通过既有 `markTrustedReadOnlyTool` 恢复测试宿主已知无写副作用的语义；生产 decorator 仍默认失去只读身份，S1 unknown 写入规则不变。

普通操作都走真实根工具。容量竞争和预期拒绝在新真实 JobList run 的 execute 作用域内调用其 `execution.children`，不借用已经结束的 scope。这样不会把预期 core 拒绝错误伪装成成功的写工具回执；独立回归仍验证真实 Agent 工具容量拒绝留下 unknown。`inRootRun` 也用于大批量留存测试，避免为每个观察请求增加模型轮次。恢复 store 后直接调用既有 `recoverProjectionSettlements`，不另建重试循环。关闭先释放门闩和等待任务，再关闭执行资源、数据库并删临时目录。
