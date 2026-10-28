# 后台执行与输出日志

管理真实后台进程，观察 Agent 框架拥有的子 Agent，并为宿主统一持有和释放执行资源。

## 主要文件

- [index.ts](index.ts)：执行能力公开导出。
- [runtime-owner.ts](runtime-owner.ts)：按工作区/会话复用资源并等待关闭。
- [detached-process-supervisor.ts](detached-process-supervisor.ts)：启动后台 Shell/程序，跟踪状态、输入、停止和输出。
- [detached-process-supervisor.ts](detached-process-supervisor.ts)：登记框架子 Agent 回调及完成状态。
- [bounded-output-file.ts](bounded-output-file.ts)：有大小上限的磁盘日志追加和替换。
- [shell-output-log.ts](shell-output-log.ts)：会话归属检查、分页读取、搜索和保留期清理。
- [process-support.ts](process-support.ts)：执行进程适配、编码和停止辅助。
- [types.ts](types.ts)：执行快照、事件与创建参数。

## 调用与状态

包根公开 `ExecutionRuntimeOwner`、`DetachedProcessSupervisor`、`ChildManager`、`createShellOutputLogHost` 和有界日志函数；宿主通常从 owner 获取前两种执行管理器。

supervisor 的 `startShellExecution` 接收 command 或 argv，通过注入环境或 sandbox 创建进程，登记输出与完成监听；查询、写入、停止和等待都按执行 ID 操作。registry 只登记框架提供的 onInput/onStop，框架报告完成后更新观察结果，不创建操作系统进程。owner 关闭时拒绝新请求并等待进程和查询结束。

owner 保存按 cwd/session 分组的管理器及活动查询；supervisor 保存进程、快照和写入链；registry 保存观察记录与回调。owner 创建的日志位于项目 `.vykor/executions/` 下按 backend、owner 和实例隔离的目录；Shell 输出日志另由 `createShellOutputLogHost` 管理，默认目录来自 host-config，可显式传入 directory。

有界执行日志默认上限 10 MiB，通常保留尾部；Shell 输出捕获可保留前缀，并记录截断与完成状态。句柄释放不代表删除历史日志。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。


## 共用执行核心（阶段 A）

ShellAdmissionPorts 只提供 reserve/load/save 与 acquireEnvironment。supervisor 持有唯一启动表，决定预留、获取环境、启动、停止、输出收尾和 lease 释放的顺序；启动保存失败不派发，确认终态后的保存失败作为 projectionError。显式 Agent 进程结束后输入不会自动重开。
