# Product Surface Integration

> 状态：CLI、TUI、Web、Desktop、IDE、Bot 和 Workflow 接入 Durable Application 的权威边界。最后核对：2026-08-23。

## 共同原则

一个产品入口可以有自己的交互方式，但不能有自己的业务真相。Session、Input、Run、消息、权限、Job 和 Workflow 都来自同一个 Durable Application。

```text
产品自己的状态：窗口、路由、选择、输入草稿、通知
共享业务状态：Session、Run、消息、Tool、Permission、Job、Workflow
```

## 接入方式

| 产品 | 推荐入口 | 自己负责 | 不能自己再做一套 |
|---|---|---|---|
| CLI 单次执行 | `VykorClient` + daemon Session API | 参数、终端输出、退出码 | 临时 JSON Session、独立 Run 状态机 |
| TUI | client snapshot + SSE + command API | 键盘、布局、选择、权限弹框 | 后台 Task/Workflow 真相、第二个 Agent |
| Web | browser-safe client + HTTP/SSE | Web 路由、渲染、断线提示 | Node polyfill、直接访问文件和数据库 |
| Desktop | renderer 使用 client；main 提供本机能力 | 窗口、PTY、系统集成 | renderer 直连 SQLite、第二份 Run 状态 |
| IDE | client + IDE host bridge | 编辑器选择、diff、workspace UX | 绕过 Permission 直接写文件 |
| Bot | Channel adapter + DurableChannelBridge | 平台鉴权、message ID、ACL、发送 | 独立 Agent history、失败后重跑 Agent |
| Workflow | Application 提供 repository 和 child host | DAG 计划、task snapshot、重试策略 | 第二套 Session/Job/child 所有权 |
| 程序内嵌入 | `createAgentKernel()` 或 `createDefaultNodeAgent()` | 自己持有 live Agent 和关闭资源 | 假装获得 daemon 的跨进程恢复能力 |

## 共享 client 的标准流程

TUI、Web、Desktop 和 IDE 应复用 `@vykor/client`：

1. 调 `/capabilities`，协议版本必须完全匹配。
2. 获取 Session snapshot。
3. 用 snapshot cursor 连接 SSE。
4. 所有事件交给共享 reducer。
5. 断线后从最后 cursor 重连。
6. 写操作只调用 Application API，不直接修改本地 reducer 伪造成功。

界面可以先显示“正在提交”，但服务端返回 Input/Run 后必须用服务端 ID 和状态替换临时 UI 状态。

## CLI

CLI 的 headless prompt 和 TUI 都走 daemon。CLI 可以负责启动本机 daemon、选择输出格式和把最终结果映射为退出码，但不再读取旧项目 Session snapshot 来恢复对话。

需要完全不使用 daemon 的程序应明确选择 SDK 入口；这是另一种部署形态，不是 CLI 的备用持久化路径。

## Desktop 与 IDE

Desktop renderer 和 IDE WebView 都是不可信展示层：

- 不拿 provider secret；
- 不直接访问 SQLite；
- 不自己执行 Tool；
- 通过受控 IPC 或 HTTP 调 main/daemon；
- 文件修改仍经过统一 Permission 和 Sandbox 规则。

PTY、窗口、系统通知等本机能力由 Desktop main 或 IDE extension host 提供，再通过窄接口交给 Runtime。

## Bot

Bot 是“在聊天平台里使用 Vykor 的产品入口”。它不是另一种 Agent。

平台的一条消息先经过 ACL，再用稳定 message ID 进入 daemon。daemon 保存 Chat 到 Session 的映射、Input、Run 和待发送回复。Agent 已完成与平台已收到回复是两个状态；发送失败只重发保存好的回复。

这保证 Bot 对话能在 TUI/Desktop 中看到并继续，也避免平台重试导致 Agent 重复写文件。

详细流程见 [Channels Flow](./channels-flow.md)。

## Workflow

Workflow 负责“任务怎样拆、依赖怎样排、失败怎样重试”，Application 负责“记录放在哪里、谁可以执行、重启怎样收束”。

- Workflow Run snapshot 写入 daemon SQLite。
- 每次 Task retry 新建 Task Attempt。
- child Agent 由 Runtime 创建并受全树预算限制。
- Job API 提供统一 read/wait/send/cancel。
- Workflow 不能保存 live Handle，也不能绕过 Application owner。

## 新产品接入检查表

- 是否先检查 protocol 版本和所需 feature？
- 是否使用共享 client 和 reducer？
- 是否把 prompt 先交给 durable admission？
- 是否使用服务端返回的 Session/Input/Run ID？
- 是否把权限请求交给共用 Permission API？
- 是否从 Job/Workflow API读取长期工作，而非建立本地状态机？
- 是否正确处理断线、重试、409 幂等冲突和 terminal 状态？
- 是否在退出时断开 observer，但不擅自删除 durable 记录？
- 是否没有把 secret、SQLite 或 live Handle 放进 UI 层？

## 相关文档

- 系统全景：[Architecture Overview](./architecture-overview.md)
- 多端同步：[Client Sync Flow](./client-sync-flow.md)
- 协议：[Protocol Contract](./protocol-contract.md)
- Runtime 嵌入：[Vykor Agent SDK](./agent-sdk.md)
- 状态所有权：[Agent Framework Capability Boundary](./agent-framework-capability-boundary.md)
