# 进程创建与停止

在本机启动 Shell 或直接执行程序，按权限策略包装 SRT，并处理进程树信号和取消。

## 主要文件

- [shell.ts](shell.ts)：加载设置、选择 Shell、按策略创建进程。
- [srt-adapter.ts](srt-adapter.ts)：生成 SRT 临时设置与包装命令。
- [process-control.ts](process-control.ts)：登记受控进程、绑定取消并停止进程树。

## 调用与状态

包根公开 `createProcess`、`createShellProcess`、Shell 解析函数、`wrapCommandForSrt`、`signalProcessTree` 和 `terminateProcessTree` 等。

入口先使用传入设置或加载项目设置，再生成/复用调用策略。未启用沙箱时直接创建进程；启用后检查运行器，将相对权限路径按工作区解析后生成临时设置并启动包装命令。进程 close/error 时清理临时目录，信号接口处理实际进程树。

Shell 探测结果在进程内缓存；受控子进程信息归 process-control，SRT 临时目录归包装结果并提供 cleanup。子进程的输出和等待由调用方消费。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。
