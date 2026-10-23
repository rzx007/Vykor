# @vykor/terminal-node

提供 Node 端交互终端实现，管理 PTY（让程序像连接到真实终端一样运行的进程接口），并把终端接到 Agent Terminal 和 Jobs 能力。node-pty 留在本包的运行实现中。

## 目录导航

- [src/](src/README.md)：公开导出和终端完整流程。
- [src/host/](src/host/README.md)：按会话组装 Agent Terminal 与 Jobs。
- [src/providers/](src/providers/README.md)：本机/执行环境目标、Shell 选择和 PTY 生命周期。
- [src/output/](src/output/README.md)：短时合并输出及有上限的内存快照。

## 入口、运行与状态

包入口是 [src/index.ts](src/index.ts)。`LocalTerminalProvider` 接收目录解析器和可选执行环境目标解析器；`create` 校验请求、准备目标并启动 node-pty。数据经过 `OutputBuffer` 合并后写入 `TerminalOutputStore`，同时发送事件。调用方通过 write、resize、read、wait、signal、kill 操作终端。

Agent 接入使用 `createAgentTerminalBundle({ cwd, sessionId, provider? })`，取得 terminal、jobs 和 cleanup。它验证会话归属，把终端快照转换成作业快照；用完调用 cleanup，等待 provider 完成资源释放。

`LocalTerminalProvider` 持有会话、PTY 和有上限的内存输出，不落盘；dispose 后释放。取消保留可查询的终端快照，先进入 stopping，PTY/目标资源释放后收敛为 killed。执行环境目标的 close 由 provider 调用；后台非 PTY 进程和磁盘输出日志由 execution-node 管理。

## 新增代码与检查

Agent 能力适配放 host，终端进程与目标适配放 providers，输出算法放 output；测试放被测分类的 `__test__/`。

```bash
pnpm --filter @vykor/terminal-node test
pnpm --filter @vykor/terminal-node check-types
```
