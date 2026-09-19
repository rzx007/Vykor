# Desktop 终端与 PTY

> 状态：当前实现，最后核对：2026-09-08。

## 一句话结论

daemon 是终端的唯一运行时所有者。Desktop 和 Agent 通过同一套 Terminal/Jobs 协议操作终端；用户终端与 Agent Terminal 默认跟随当前会话的 Native/WSL 执行环境。

## 组成

```text
Renderer (@xterm/xterm)
  → Electron preload / main
  → OpenHarnessClient
  → daemon Terminal HTTP/SSE
  → DaemonTerminalService
  → LocalTerminalProvider
  → node-pty
  → Native Shell 或 wsl.exe
```

`@xterm/xterm` 只渲染终端并采集键盘输入。真正的 PTY 由 daemon 中的 `node-pty` 创建，Desktop renderer/main 都不直接加载原生 PTY 模块。

## 运行环境

新客户端使用：

```ts
type TerminalRuntime = "local" | "environment";
```

- `environment`：默认值。daemon 从受信任的 session/project scope 取得 cwd，再向当前 `ExecutionEnvironment` 请求 PTY target。
- `local`：保留给明确的宿主终端入口，不是 Desktop 会话终端的默认路径。

`environment` 终端要求所连接的 daemon 以 `desktop_managed` 模式启动。Desktop 启动时只复用这种 daemon；如果 registry 里是 CLI 启动的 daemon，会先停掉并按需重启或将系统服务切换为桌面入口，否则环境终端不可用。

Native：

```text
EnvironmentPtyTarget
  command      = 用户选择的宿主 Shell 或系统默认 Shell
  hostCwd      = Session.cwd
  executionCwd = Session.cwd
```

WSL：

```text
EnvironmentPtyTarget
  command      = wsl.exe
  args         = ["--cd", <POSIX cwd>]
  hostCwd      = Windows Session.cwd
  executionCwd = /mnt/<drive>/...
  shell        = default
```

WSL 终端忽略 PowerShell/cmd/Git Bash 等宿主 Shell 偏好，使用默认 Linux Shell。Agent、文件工具、后台 Shell 和终端因此看到同一种路径和 cwd。

当前不支持以 `\\wsl.localhost\...` 或 `\\wsl$\...` 为项目根；只支持可映射为 `/mnt/<drive>/...` 的 Windows 盘符项目。

## 用户终端与 Agent Terminal

用户从 Desktop 右侧 Panel 创建、切换、清屏、重启和关闭终端。Agent 使用 `TerminalOpen` 创建持久终端，工具结果以 Job 形式返回；后续通过统一 Jobs 工具控制：

| 工具 | 用途 |
| --- | --- |
| `TerminalOpen` | 创建环境终端 |
| `JobSend` | 写入文本、Enter、Ctrl-C 或 EOF |
| `JobRead` | 读取状态和增量输出 |
| `JobWait` | 等待退出或等待超时 |
| `JobCancel` | 终止终端 |
| `JobList` | 列出当前会话拥有的 Jobs |

`JobSend` 原样写入数据：Enter 使用 `\r`，Ctrl-C 使用 `\u0003`，EOF 使用 `\u0004`。终止整个 PTY 使用 `JobCancel`。

Agent 不应把终端替代所有短命命令。一次性查询和脚本优先使用 `Bash`；需要长期运行、多轮输入或用户接管时使用 Terminal。

## Scope 与所有权

创建请求必须提供可信 scope：

```ts
type TerminalScope =
  | { kind: "project"; projectId: string }
  | { kind: "session"; sessionId: string };
```

daemon 从 Store 解析真实 cwd。请求中的 projectId/sessionId/cwd 如果互相冲突会被拒绝，renderer 不能覆盖 Store 中的 cwd。

- 用户终端：`source = user`。
- Agent Terminal：`source = agent`，同时记录创建者 sessionId。
- Agent 只能操作自己 session 创建的 Agent Terminal。
- 子 Agent 不能读写父 Agent 或兄弟 Agent 的终端。
- Desktop 用户可以查看和接管 Agent Terminal。
- 项目外会话使用已有受管 cwd，不依赖 projectId。

## 输入、输出与 resize

`LocalTerminalProvider` 把输入写入 `IPty.write()`，把窗口变化写入 `IPty.resize()`，同时调用 target 的可选 resize。Native 和 WSL 都使用真实 PTY，不再存在 pipe-backed container terminal。

输出先进入内存 transcript，再通过 SSE 推送。读取接口返回 cursor、截断状态和 bounded snapshot；完整终端日志不写入会话数据库。

关闭右侧 Panel 只断开视图，不结束 PTY。关闭具体 tab、调用 `JobCancel` 或关闭 daemon 才会回收终端。

## HTTP API

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `POST` | `/terminals` | 创建终端 |
| `GET` | `/terminals` | 按 project/session/source 列出终端 |
| `GET` | `/terminals/:terminalId` | 获取状态 |
| `GET` | `/terminals/:terminalId/output` | 读取输出快照 |
| `POST` | `/terminals/:terminalId/input` | 写入输入 |
| `POST` | `/terminals/:terminalId/resize` | 调整尺寸 |
| `POST` | `/terminals/:terminalId/signal` | 中断、EOF 或终止 |
| `DELETE` | `/terminals/:terminalId` | 关闭终端 |
| `GET` | `/terminals/stream` | SSE 事件流 |

所有路由使用 daemon Bearer token 认证。daemon 关闭时先断开 SSE，再回收 PTY 和其他资源。

## 生命周期和存储

- daemon 内存持有 PTY、状态和输出；daemon 重启后不恢复终端。
- transcript 只保存工具调用和精简结果，不保存完整终端输出。
- Agent Runtime、用户终端和后台任务分别创建轻量环境 handle；Native/WSL 没有容器 lease、引用计数或共享实例管理器。
- `agentEnvironment` 修改后写入全局配置，但当前 daemon 生命周期固定使用启动时环境；重启 daemon 后统一生效。

## 验证

单元测试覆盖创建、输入、输出、resize、signal、退出、scope 校验和 Shell 注入。真实 WSL E2E 还覆盖 stdio MCP、真实 PTY、resize、Ctrl-C 后继续交互，以及关闭时资源回收：

```bash
pnpm --filter @openharness/sandbox e2e:wsl
```

相关权威文档：

- [Agent 运行环境调用链](./sandbox-runtime-flow.md)
- [Native / WSL 运行环境与 SRT](./sandbox-runtime-design.md)
- [Jobs Protocol](./jobs-protocol.md)
