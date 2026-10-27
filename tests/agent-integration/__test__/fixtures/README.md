# 跨进程操作测试夹具

`s1-tool-operation-worker.ts` 是 S1 崩溃测试启动的独立 Node 进程。
它使用真实临时 SQLite，在派发意图、外部效果或结果确认完成后通过 IPC 通知父测试，然后等待父进程强制终止。

调用入口是相邻的 `durable-tool-operations.integration.test.ts`。
数据库保存操作事实，独立的效果文件保存工具对外写入次数；两者都在父测试创建的临时目录中，进程退出后仍可读取。
新增崩溃位置应在这个夹具中增加明确暂停点，断言放在父测试，不将暂停点加进生产代码。


`task-lifecycle-fixture.ts` 通过真实 Node 工厂与 DaemonApplication/session executor 驱动 Agent、Jobs、Shell、PTY 与 Workflow。只替换模型网络；工具 decorator 完整调用 base.execute，Read 门闩阻塞真实工具 invocation。状态与输出属于执行器，daemon 使用临时 SQLite。关闭先释放门闩和等待任务，再关闭执行资源、数据库并删临时目录。
