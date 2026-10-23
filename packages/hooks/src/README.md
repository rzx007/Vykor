# 事件钩子

[`index.ts`](index.ts) 是 `@vykor/hooks` 的公开入口，包含 `HookExecutor`、`HookLoader`、详细执行结果类型，并转导出宿主配置和运行契约中的钩子类型。

`HookLoader.loadFromConfig()` 或 `loadFromDirectory()` 把定义登记到执行器。`execute()` 按事件、启用开关和通配匹配条件筛选钩子，优先级高的先运行，同优先级保持登记顺序，遇到阻止结果就返回。`executeWithResults()` 收集每项结果和耗时。

执行器支持命令、HTTP、提示词和 Agent 检查。命令通过注入的环境执行器或沙箱进程运行，模型检查通过 `setClient()` 注入的客户端运行。是否在失败时阻止操作由钩子类型和 `blockOnFailure` 配置决定。

定义表、客户端和运行配置保存在执行器实例中；`HookLoader.watch()` 的轮询计时器由加载器保存，结束时调用 `stopWatching()`。本包不保存运行历史。新增执行与加载代码放在本目录，测试放同层 [`__test__`](__test__)。返回[包说明](../README.md)。
