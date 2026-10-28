# Agent 终端与作业适配

把同一个终端 provider 接到 Agent Terminal 和 Jobs，限制操作只能访问当前会话的终端。

## 主要文件

- [agent-terminal-host.ts](agent-terminal-host.ts)：创建 terminal/jobs 能力包、转换作业快照并统一清理。

## 调用与状态

从包根调用 `createAgentTerminalBundle({ cwd, sessionId, provider? })`，取得 terminal、jobs、cleanup 和 cleanupIdentity。未传 provider 时创建 `LocalTerminalProvider`。

`terminal.open` 核对会话和 cwd 后创建终端；jobs 的 list/read/wait/send/cancel 先校验归属，再调用 provider，最后把终端状态和输出游标转换成作业结果。cleanup 取消监听并等待 provider.dispose。

此层保存终端观察时间、归属和幂等清理 Promise；PTY、输出和实际关闭状态归 provider。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。


## 共用执行核心（阶段 A）

createAgentTerminalBundle 同时服务 SDK 和 daemon。它把 TerminalProvider 映射为工具与 Jobs；列表与 requireOwnedTerminal 共用同一归属判断，要求所属会话相符且 source 为 agent。定点操作通过 get 核对，不依赖列表；用户手动终端即使 ID 已知也不能由 Agent 操作。
