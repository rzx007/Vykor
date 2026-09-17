# OpenHarness 架构总览

> 状态：当前实现的权威鸟瞰。最后核对：2026-09-17。

## 一句话说明

OpenHarness 是一套可长期保存运行状态的 Agent 应用。CLI、TUI、Web、Desktop、Bot 和 Workflow 是不同入口，共用领域 Client、Daemon Application、Session Runtime 存储和 Agent Runtime，不各自维护一套 Run 或会话真相。

```text
CLI / TUI / Web / Desktop / Bot / Workflow
                    |
      @openharness/client 领域 Resources
                    |
          HTTP routes + SSE transport
                    |
 Query / Command / Interaction / Run Control
             SessionOperationRunner
                    |
 Repository / Transaction + SQLite   Agent Runtime
                    |                     |
        snapshot + durable event     Provider / Tools / Child
                    |
              Client reducer -> UI
```

## 四层怎样协作

### 1. 产品入口与 Client

产品入口负责人和机器交互：收集输入、显示消息、管理页面和调用平台能力。它不直接读取 SQLite，也不自行决定 Run 怎样排队或恢复。

业务调用通过 `OpenHarnessClient` 的领域 Resource，例如：

```ts
await client.sessions.create(input);
await client.sessions.admitPrompt(sessionId, { content: "hello" });
await client.permissions.reply(requestId, decision);
```

Client transport 负责 HTTP、SSE、鉴权、协议 header 和错误转换；Resource 负责把一个领域动作映射到 endpoint。Client state 先应用 snapshot，再按 SSE cursor 合并增量。

### 2. Daemon Application

HTTP route 只解析请求并调用窄应用服务。当前 Session 主链路包括：

- `SessionQueryService`：读取 session、snapshot、message 和 part；
- `SessionCommandService`：create、update、fork、archive、delete；
- `SessionInteractionService`：prompt、queue、resume、interrupt 和 child 交互；
- `RunAdmissionService`：把输入归类为 start、queue、steer、replay 或 reject；
- `RunControlService`：查找和控制 live run/agent handle；
- `SessionMaintenanceService`：compact、rewind、remember、export 和 usage；
- `SessionOperationRunner`：在同一 session 内串行操作，等待 ready、取得 operation lease，并在成功提交后发布事件。

`DaemonApplication` 组装这些服务并管理启动/关闭。它不是一个继续承接所有业务方法的万能类。

### 3. Services / Storage

一份 SQLite 保存 Session、Input、Message、Part、Run、Attempt、Permission、Goal、Attachment、Schedule、Workflow、Channel 和 durable event。

- Repository 拥有单个领域的数据读写；
- Transaction 拥有跨领域的原子操作；
- `StorageContext` 让所有入口共享数据库、read model、mutation buffer、事件序号和事务协调器；
- `SessionStore` 负责数据库生命周期、领域入口组装、owner lease、waiter/listener、恢复与维护能力。

详细边界见 [Session Runtime 存储架构](./session-runtime-storage-architecture.md)。

### 4. Agent Runtime

Agent Runtime 只负责正在发生的执行：

- Agent history、当前模型回合和操作互斥；
- Provider stream、Tool 调用和权限等待；
- root/child Agent handle；
- 有序事件、取消、关闭和资源释放。

Runtime 不读取 daemon 数据库，不开 HTTP 服务，也不知道界面来自 CLI 还是 Desktop。Daemon 通过事件和 Handle 观察、持久化和控制它。

## 一条 prompt 的完整路径

```text
1. 产品调用 client.sessions.admitPrompt(sessionId, input)
2. Client 在首个业务请求前确认协议版本 4
3. POST /sessions/:id/prompts 进入 SessionInteractionService
4. SessionOperationRunner 串行该 session，等待 ready 并取得 shared lease
5. RunAdmissionService 在一个 Transaction 中保存 Input 和 pending Run
6. Session lane 把 Run 交给 SessionRunExecutor
7. AgentPool 取得或创建该 session 的 OpenHarnessAgent
8. Agent Runtime 执行模型和 Tool，持续发出 AgentEvent
9. DaemonAgentEventProjector 将事件写入 Repository/Transaction
10. 已提交事件经 SSE 返回，Client reducer 合并到 snapshot
11. terminal projection 完成后，Run Handle 才把最终结果交回应用层
```

因此状态不会因为换一个界面而分叉；daemon 重启后由持久记录收束旧活动状态，产品不需要猜测上次进程做到哪里。

## 状态所有权

| 状态 | 唯一负责人 | 其他层如何使用 |
| --- | --- | --- |
| live history、当前模型回合、root/child handle | Agent Runtime | Application 通过事件和 Handle 观察、控制 |
| Session、Input、Run、Attempt、Message、Permission、Goal、Workflow | Repository / Transaction + SQLite | Application 编排；Client 通过 snapshot/SSE 读取 |
| 同 session 串行、operation lease、checkpoint/publish | `SessionOperationRunner` | Query/Command/Interaction 共用 |
| 当前选中项、面板、草稿、连接展示 | 产品入口 | 不写成服务端业务真相 |
| provider、文件、进程、Git、MCP、Sandbox | Node 宿主能力 | Runtime 通过明确接口调用 |

## 包的边界

| 包或目录 | 当前定位 |
| --- | --- |
| `@openharness/protocol` | 跨进程请求、响应、事件、公共 DTO、错误码和协议版本 |
| `@openharness/services` | SQLite Repository/Transaction、Memory 和 Node 本地持久服务 |
| `@openharness/agent-runtime` | 可独立嵌入的 Agent Kernel、Run/Child handle 和事件/effect 契约 |
| `@openharness/server` | Daemon Application、HTTP routes、运行编排、投影、恢复和运维 |
| `@openharness/client` | 协议握手、HTTP/SSE transport、领域 Resources、reducer 和同步控制器 |
| `@openharness/coordinator` / `@openharness/jobs` | Workflow 调度以及统一 Job 观察与控制 |
| `apps/*` | CLI、TUI、Desktop、Website 等产品入口 |

依赖方向不是一条简单直线，而是两条能力在 Server 汇合：

```text
@openharness/protocol
      ^
@openharness/services       @openharness/agent-runtime
      ^                           ^
      +------ @openharness/server-+
                      ^
              @openharness/client
                      ^
                    apps
```

约束是：Protocol 不依赖上层；Services 不依赖 Server/Client/UI；Agent Runtime 不依赖 daemon；Repository 不依赖 Application；Application 不依赖 HTTP transport；UI 不直接访问 Repository。

## 三条可靠性主线

1. **原子持久化：** SQLite、read model、mutation buffer、event sequence 和提交后 callback 一起提交或一起回滚。
2. **先提交再发布：** Application 从 checkpoint 开始执行，只有 Repository/Transaction 完成后才把 durable event 发布给 SSE。
3. **live 与 durable 分离：** Runtime handle 可以随进程消失；Run、Attempt、Task 和 Projection Settlement 必须进入明确终态，重启时按 durable 数据恢复。

详细状态机见 [Agent Lifecycle Contract](./agent-lifecycle-contract.md)，固定记录格式见 [Durable Execution Data Model](./durable-execution-data-model.md)。

## 禁止的捷径

- 在 route 或 UI 中直接访问 Store/Repository；
- 在 Client transport 中加入 endpoint 业务判断；
- 在 `SessionStore`、`DaemonApplication` 或新的 Manager/Context 中重新聚合全部业务；
- 在 Runtime 中读取 SQLite 或产品设置文件；
- 从旧字段、旧目录或旧数据库猜测当前格式；
- 先发布 SSE，再尝试提交数据库。

这些约束由 `pnpm check:architecture` 和 `pnpm check:clean-slate` 持续检查。

## 继续阅读

- 想看当前分层图：[可交互架构图](./openharness-current-architecture.html)
- 想追踪 daemon 请求：[Daemon Application Architecture](./daemon-application-architecture.md)
- 想理解 SQLite 与 Repository：[Session Runtime 存储架构](./session-runtime-storage-architecture.md)
- 想理解多端同步：[Client Sync Flow](./client-sync-flow.md)
- 想接一个产品入口：[Product Surface Integration](./product-surface-integration.md)
- 想嵌入 Runtime：[OpenHarness Agent SDK](./agent-sdk.md)
- 想排障、备份或恢复：[Operations and Recovery](./operations-and-recovery.md)
- 想看本次重构结论：[架构重构收口与当前边界](./architecture-migration-status.md)
