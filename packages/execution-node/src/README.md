# Node 执行源码

[index.ts](index.ts) 是 `@vykor/execution-node` 的公开入口，导出 executions 的能力和有界日志函数，以及 lsp 的代码查询接口。

## 目录导航

- [executions/](executions/README.md)：`ExecutionRuntimeOwner`、后台非 PTY 进程、框架子 Agent 观察与日志。
- [lsp/](lsp/README.md)：文件符号提取和基于 ripgrep 的代码查询。

宿主创建 owner 后按 cwd/session 获取执行管理器，或通过 `withLspClient` 执行一次代码查询。后台执行结果通过快照、监听器、readOutput 和 awaitExecution 返回；代码查询返回符号或引用列表。结束时宿主关闭 scope 或 owner，等待活动资源清理。

owner 持有资源集合和关闭状态，具体进程与输出状态归 executions，单次查询状态归 LspClient。新增逻辑进入现有两类，公开导出在本层维护；测试放所属目录的 `__test__/`，未来需要的包内跨分类测试放本层 `__test__/`，目前本层没有该目录。
