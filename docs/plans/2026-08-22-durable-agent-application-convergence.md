# Durable Agent Application 多端收口计划

> 状态：已完成（A1–F4，2026-08-22）。本文是实施记录，不是当前 API 手册；当前文档入口见 [`docs/README.md`](../README.md)。
>
> 本计划基于 2026-08-22 对当前代码的架构核查。上一轮 Runtime Hardening 已经补齐 Input/Run 原子准入、重启收束、事件版本、Projection Settlement、Child Budget、Run Attempt、Tool 未知结果、Metrics 和 Run Inspector。本计划不重复这些工作，而是让它们真正被 CLI、TUI、Web、Desktop、IDE、Bot 和 Workflow 共用。
>
> Agent 和 Daemon 的生命周期规则继续以 [Agent Lifecycle Contract](../agent-lifecycle-contract.md) 为准；当前请求链继续以 [Daemon Application Architecture](../daemon-application-architecture.md) 为准。本计划只说明下一步怎么改，不另造一套相互冲突的运行规则。

## 实施进度

- [x] A1：创建 `@vykor/protocol`。Session/Run/Schedule/Job/Terminal 跨端类型、runtime metadata 纯函数、主路径请求校验、统一错误、主要成功响应校验及 snapshot/event JSON 往返测试已经完成。
- [x] A2：移除 `client -> services` 依赖；client 测试不再加载 SQLite Store。
- [x] A3：共享 client 不再直接读取 Node `process`；`/doctor` 的本机信息由宿主提供。
- [x] A4：增加无 Node polyfill 的 Vite 浏览器构建 fixture。
- [x] B1：AgentPool、Session/Run/Projection/Recovery 和 Control 实现已经移入 `packages/server/src/application`；生产代码不再依赖 Hono 或 HTTP 类型。
- [x] B2-B4：应用现在自己拥有 Session、Run、Permission、Job、Terminal、Project 和事件入口；HTTP 可以接收外部 Application；事件支持先按游标补历史、再持续接收新事件。
- [x] C1-C4：Bot 已通过 daemon 进入同一套 durable Session/Run；聊天映射、重复消息准入和回复发送结果都会保存。
- [x] D1-D4：Kernel 已改为只接收显式 runtime 和宿主能力；Node 默认组装只保留命名明确的入口；发布包可在仓库外安装并跑完 root、child 和 close。
- [x] E1-E4：daemon Workflow 已写入统一 SQLite；不读取或迁移旧项目文件；Jobs 等待改成状态变化通知并补上订阅竞态保护。
- [x] F1-F4：已增加单执行者租约和 generation 防旧写、协议能力清单、可审计清理策略及带校验的备份恢复。

## 一、这轮要解决什么

以下是计划开始时的代码基线，当时已经有三块重要能力：

```text
agent-runtime
  负责一次 Agent 怎么运行、怎么调用工具、怎么创建子 Agent、怎么停止和释放资源

daemon application
  负责 Session、Input、Run、Permission 和 Transcript 怎么保存、排队、恢复和给多个客户端使用

client
  负责通过 HTTP/SSE 读取状态、发送命令，并把 snapshot 与增量事件合并成客户端状态
```

这三块各自已经可用，但连接方式还没有完全收口：

1. `@vykor/client` 仍依赖带 SQLite 实现的 `@vykor/services`，浏览器或 IDE webview 很难只拿一个轻量客户端包。
2. 真正负责 durable 业务的 `DaemonApplication` 仍放在 `@vykor/server` 内部，很多实现文件也仍位于 `http/` 目录。
3. `vk channels serve` 直接创建 standalone Agent，Bot 消息没有进入 daemon 的 durable Session/Run。
4. `agent-runtime` 的运行规则已经像独立内核，但默认组装同时读取本机配置、凭据、插件、Skill、MCP、Sandbox 和 Git worktree，包本身也还不能脱离 monorepo 发布。
5. 当时 Workflow 使用项目目录中的 JSON/NDJSON 文件保存状态，没有和 Session/Run 使用同一份 durable 状态与诊断入口。

用大白话说，这轮的目标是：

- Web 和 IDE 只安装客户端，不会顺带安装 SQLite；
- Bot 发来的消息和 TUI 输入一样，都先保存成 durable Input，再由同一个应用执行；
- HTTP 只是“怎么从网络调用应用”，不再负责组装和拥有业务对象；
- `agent-runtime` 可以在仓库外作为一个正常 npm 包使用；
- Workflow 在 daemon 产品里可以和 Session、Run、Job 一起查询、恢复和清理。

本文会保留少量代码里已经使用的英文词，含义统一如下：

- durable：关键状态已经写到持久存储中，进程退出后仍能查到；不等于旧进程中的工作一定会自动继续。
- protocol：客户端和服务端共同使用的请求、响应、事件和错误格式。
- projection：把 Agent 运行时发出的事件写成数据库记录和客户端可读状态。下文也直接称为“事件写入”。
- adapter：把 HTTP、Bot 等外部入口接到应用上的一小层代码。下文也称为“接入层”。
- capability：宿主明确提供给 Agent 的能力，例如 Terminal、Jobs 或 Schedule。下文也称为“宿主能力”。
- owner：当前有资格执行或修改某项工作的进程。下文也称为“执行者”。

## 二、完成后的运行关系

```text
CLI / TUI / Web / Desktop / IDE / Bot / Workflow
                    |
                    | 远程产品走 HTTP/SSE
                    | 内嵌产品也可以直接调用应用接口
                    v
          Durable Agent Application
          - Session 创建、更新、归档
          - Input/Run 准入和排队
          - Permission 等待和回复
          - durable event 与 transcript
          - Job、Schedule、Workflow
          - restart recovery 和 inspect
                    |
                    v
             Agent Runtime Kernel
          - live Agent / Run / Child
          - 模型回合与工具执行
          - event / effect / handle
          - interrupt / close / cleanup
                    |
                    v
       Node 能力：模型、文件、Git、MCP、Sandbox、Terminal
```

这里的 Kernel 是“运行核心”：它只关心一轮 Agent 怎么跑和资源怎么释放。用户目录、SQLite、HTTP、TUI、Bot 平台都不属于 Kernel。

## 三、本轮明确不做

为了避免一次改动横跨全仓，本计划明确不做下面的事：

- 不重写 `QueryEngine`。
- 不改变已有 Run、Attempt、Tool Attempt 和 terminal 状态含义。
- 不把系统改成只靠事件重建全部状态的 Event Sourcing。
- 不在 Daemon 重启后自动重放可能产生副作用的 Tool。
- 不同时支持多个 Daemon 执行同一个 SQLite 数据库中的 Run；第一阶段只增加“一个数据目录只能有一个执行者”的保护。
- 不在第一阶段建设完整的多租户账号和角色系统。
- 不一次性迁移所有 CLI 命令；只迁移影响多端共享的 command、query 和 host 能力。
- 不为了拆包恢复已经删除的 RuntimeFactory、RunHost 或 Projection Adapter 旧抽象。
- 不要求第一阶段同时上线完整 Web 或 IDE 产品；先用最小示例和构建测试证明公共包可用。

## 四、必须一直守住的规则

每个任务都要继续满足下面这些规则：

1. Framework 拥有 live Agent、Run Handle 和 Child Handle；Durable Application 拥有保存到数据库的 Session、Input、Run、Task、Permission 和 Transcript。
2. live Handle、Promise、AbortSignal 和进程对象不能写进数据库。
3. 一个 terminal Run 不能重新变成 running；恢复必须创建新 Run，并记录它从哪个旧 Run 恢复。
4. 相同请求 ID 和相同内容可以安全重试；相同 ID 和不同内容必须明确失败。
5. Tool 结果无法确认时只能记录 `unknown_outcome`，不能自动再执行一次。
6. required projection 写入失败必须让当前操作失败，不能只打印日志后继续。
7. HTTP、Bot 和未来 IDE 只是入口，不能各自维护第二份 Session/Run 状态。
8. 浏览器客户端公共入口不能 import Node 文件系统、SQLite、Drizzle 或服务端 Store。
9. 单机模式下，一个数据目录只能有一个 active application owner，避免两个 Daemon 同时执行同一个 Run。
10. 新增跨进程保存的数据必须有数据库 migration、严格解码测试和异常退出测试；不为了旧文件格式增加自动读取分支。

## 五、实施顺序

```text
Milestone A：拆出纯协议包，让 client 真正可用于浏览器
        |
        v
Milestone B：把 Durable Application 从 HTTP Server 中拿出来
        |
        v
Milestone C：让 Bot 进入同一个 durable Session/Run
        |
        v
Milestone D：拆开 Agent Kernel 与 Node 默认组装，并完成独立打包
        |
        v
Milestone E：让 daemon 中的 Workflow 使用统一 durable state
        |
        v
Milestone F：补单 owner 保护、协议协商、保留与备份
```

A 是后面所有多端工作的基础。B 完成后，HTTP 和 Bot 才能真正成为同一个应用的两种入口。C 是第一个非 UI 产品验收。D 和 E 涉及包边界及数据迁移，放在前三项稳定之后。F 负责长期运行和独立版本升级。

---

# Milestone A：拆出纯协议包

## 目标

让 `@vykor/client` 只包含浏览器可以运行的代码，不再因为复用 Session 类型而加载 `@vykor/services` 和 SQLite。

完成后的依赖关系：

```text
@vykor/protocol
  <- @vykor/client
  <- Web / Desktop renderer / IDE webview / TUI

@vykor/protocol
  <- @vykor/services
  <- @vykor/application
  <- HTTP server
```

`protocol` 的意思是“客户端和服务端都同意的数据格式”。它只放请求、响应、事件、错误和版本信息，不放数据库代码。

## Task A1：创建 `@vykor/protocol`

### 要做的事

1. 新建 `packages/protocol`。
2. 从 `@vykor/services/session-runtime/types` 移出客户端会用到的公开数据类型：
   - Session
   - Input
   - Run
   - Run Attempt
   - Message / Part
   - Permission
   - Schedule
   - Session Execution
   - Session Snapshot
3. 移出 runtime metadata 的纯函数和类型：
   - `readRuntimeMetadata`
   - `readSessionRuntimeConfig`
   - `patchSessionRuntimeMetadata`
   - `runtimeMetadataChanged`
4. 把 Jobs 和 Terminal 对外 DTO 统一从 protocol 导出；底层 producer 的实现类型继续留在原包。
5. 定义统一错误响应：

```ts
interface ProtocolError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
  traceId?: string;
}
```

6. 为 HTTP 请求和响应增加运行时校验。运行时校验实际做的是：收到 JSON 后检查字段和类型，而不是只相信 TypeScript 编译期类型。
7. `protocol` 不得依赖任何 `@vykor/services`、`better-sqlite3`、Drizzle 或 Node builtin。

### 兼容方式

- 第一阶段 `@vykor/services` 可以 re-export 新 protocol 类型，减少一次性改动。
- re-export 只作为迁移入口，并在注释中标记后续删除版本。
- 数据库内部类型若含有 SQL 专用字段，保留单独的 storage record，不要重新塞回 protocol。

### 完成标准

- `@vykor/protocol` 可在只包含 DOM/ES 标准库的 TypeScript 项目中通过类型检查。
- 包依赖树不包含 Node、SQLite、Drizzle。
- Session snapshot 和 event envelope 有序列化/反序列化测试。
- 非法请求字段在进入 application 前被拒绝，并返回稳定错误 code。

## Task A2：移除 `client -> services` 依赖

### 要做的事

1. `packages/client/src/types/index.ts` 改从 `@vykor/protocol` 导入。
2. `packages/client/src/index.ts` 不再从 `@vykor/services` re-export。
3. `packages/client/src/commands/session-commands.ts` 改用 protocol 中的 runtime metadata helper。
4. 从 `packages/client/package.json` 删除 `@vykor/services`。
5. 检查 client 公共入口的整个依赖树，确保没有通过其他包间接带回 SQLite。

### 完成标准

- `packages/client` 测试不需要解析 `services/session-runtime/store.ts`。
- 人为移除 `better-sqlite3` 后，client 的 transport/reducer/command 测试仍能运行。
- `rg '@vykor/services' packages/client` 没有生产代码命中。

## Task A3：把 Node 专用命令能力交给宿主

### 当前问题

共享 command 代码直接读取：

```text
process.cwd()
process.version
process.platform
process.arch
```

浏览器没有这些对象。共享 client 不应该假装每个宿主都是 Node。

### 要做的事

给 `SessionCommandHost` 增加可选能力：

```ts
interface SessionCommandHost {
  emit(...): void;
  getCwd?(): string | undefined;
  getRuntimeDiagnostics?(): Promise<RuntimeDiagnostics>;
  exportSessionFile?(...): Promise<ExportResult>;
  openLocalUi?(target: string): void;
}
```

- TUI/CLI adapter 提供 Node 版本信息和 cwd。
- Desktop main/preload 提供桌面宿主信息。
- Web 没有该能力时，命令输出“当前宿主未提供本机运行信息”，不能访问不存在的 `process`。
- command 的业务调用仍留在 client；读取本机环境的动作由 host 完成。

### 完成标准

- client 生产代码没有无保护的 `process`、`Buffer`、`node:*` 引用。
- Node、browser 两组 command host 测试通过。

## Task A4：增加最小浏览器构建测试

### 要做的事

在仓库中增加一个很小的 browser fixture：

```text
tests/browser-client/
  package.json
  index.ts
  vite.config.ts
```

它只做三件事：

1. 创建 `VykorClient`；
2. 解析一段 mock SSE；
3. 用 reducer 合并 snapshot 和 event。

### 完成标准

- Vite build 成功。
- 不配置 Node polyfill。
- 构建产物中不出现 `better-sqlite3`、`drizzle-orm`、`node:fs`。

---

# Milestone B：把 Durable Application 从 HTTP Server 中拿出来

## 目标

让 Durable Application 可以不启动 HTTP listener 也能完整工作。HTTP Server 只负责：

- 认证；
- CORS；
- 解析 URL 和 JSON；
- 调用 application；
- 把结果转换成 HTTP/SSE 响应。

Session、Run、Permission、Projection、Recovery 和 AgentPool 不属于 HTTP。

## Task B1：移动不属于 HTTP 的实现

### 要做的事

把下面这些文件从 `packages/server/src/http` 移到 `packages/application` 或 `packages/server/src/application`：

```text
http/agent/agent-pool
http/agent/daemon-agent-event-projector
http/agent/live-child-agent-directory
http/agent/projection-settlement-recovery

http/session/session-run-engine
http/session/session-run-executor
http/session/session-application-service
http/session/session-query-service
http/session/session-maintenance-service
http/session/session-event-publisher
http/session/session-execution-projector
http/session/transcript-projection
http/session/background-shell-service

http/control/daemon-operation-gate
http/control/daemon-control-service
http/control/run-inspector
```

第一步只移动目录和 import，不改变运行行为。避免在同一个 PR 中同时重命名全部类型。

### 完成标准

- application 生产代码不 import Hono、HTTP Context、Request 或 Response。
- HTTP route 测试继续覆盖原有状态码。
- application 原有 lifecycle 测试路径更新后全部通过。

## Task B2：定义应用命令和查询入口

应用对外至少提供下面这些入口：

```ts
interface DurableAgentApplication {
  ready(): Promise<void>;

  sessions: {
    create(...): ...;
    update(...): ...;
    archive(...): ...;
    admitInput(...): Promise<PromptReceipt>;
    interrupt(...): Promise<...>;
    resume(...): Promise<...>;
  };

  queries: {
    getSession(...): ...;
    getSnapshot(...): ...;
    listEvents(...): ...;
    inspectRun(...): ...;
  };

  permissions: {
    list(...): ...;
    reply(...): ...;
  };

  jobs: ...;
  schedules: ...;
  events: ...;

  close(): Promise<void>;
}
```

这里不要引入一个万能 `execute(commandName, payload)`。每个用例继续有明确方法和输入类型，调用链更容易查，也能让 TypeScript 正常发现错误。

### 所有权

- application 创建并关闭 AgentPool、RunEngine、PermissionBroker、Scheduler 和事件写入组件。
- HTTP server 可以拥有 listener 和 SSE 连接，但不能拥有 AgentPool。
- Store 可以由外部注入；默认 Node composition 创建 SQLite Store。
- 事件出口由接入层注入；没有 HTTP 时可以使用内存订阅或 Bot 接入层。

### 完成标准

- 不启动端口即可执行完整的 create session -> admit input -> run -> query snapshot。
- `ready()` 完成前不会接受命令。
- `close()` 可重复调用，并等待 active operation 收束。

## Task B3：让 HTTP Server 接收 application

### 要做的事

1. `VykorHttpServer` constructor 改为接收已经创建好的 application，或调用一个明确的 `createDefaultNodeApplication()`。
2. routes 只调用 application 的公开入口。
3. routes 不直接操作 `SessionStore`；只有纯事件流读取可通过 application query/event port 完成。
4. route 内所有 request body 使用 protocol schema 校验。
5. HTTP status 与 application error code 建立集中映射，避免每个 route 自己判断错误文字。

### 完成标准

- Application 公共行为测试不 import Hono。
- HTTP route test 可以注入 fake application，不需要真实 SQLite。
- 真实 HTTP integration test 仍覆盖 SQLite + Agent + SSE 全链路。

## Task B4：增加应用级事件订阅

### 要做的事

HTTP SSE、Bot 回复和未来 IDE 状态更新都需要消费 application event，但不能直接订阅 framework live event。

应用级订阅应只输出已经通过 durable 规则处理的内容：

```ts
interface ApplicationEventSubscription {
  snapshotCursor: number;
  stream(options: { after: number; sessionId?: string }): AsyncIterable<SessionEvent>;
}
```

- durable event 从 Store replay；
- transient text delta 可以 live 发送，但必须带 cursor 去重信息；
- Bot 如果只需要 terminal reply，可以等待 Run/Part query，不必拼接所有 delta；
- framework event 不直接透传给产品。

### 完成标准

- HTTP SSE 与直接 application subscription 对同一个 session 最终得到相同状态。
- 订阅中断不会取消后台 Run。
- 重连从 cursor 继续，不重复追加文本。

### 实施结果

- `DaemonApplication` 是可直接调用的应用入口。调用方先等 `ready()`，之后可以创建 Session、提交输入、等待 Run、查询状态，最后重复调用 `close()` 也不会重复释放资源。
- 默认 Node 组装集中在 `createDefaultNodeApplication()`。它自己创建 SQLite Store 时也负责关闭；Store 由外部传入时，默认仍由外部关闭，也可以明确把所有权交给 Application。
- `VykorHttpServer` 可以接收已经创建好的 Application。外部注入时，HTTP Server 默认只关闭 listener 和自己的 SSE 连接，不关闭 Application。
- Project、Job、Terminal 和事件路由都通过 Application 调用，不再由 HTTP Server 直接组装这些服务。
- `ApplicationEventService` 只发布已经写入 Store 的事件。订阅建立时先记住当前游标、补齐历史事件，再接收实时事件，避免建立连接的空档丢事件。
- Application 错误带稳定 code；HTTP 状态码集中转换，不再要求各个路由靠错误文字猜状态。
- 已增加不启动 HTTP 的完整运行测试、Application 事件重放/过滤/取消测试，以及 HTTP 注入 Application 的测试。

---

# Milestone C：让 Bot 进入同一个 durable Session/Run

## 目标

把当前：

```text
Channel -> ChannelBridge -> standalone VykorAgent
```

改为：

```text
Channel -> DurableChannelBridge -> Durable Agent Application
```

## Task C1：建立外部聊天与 Session 的持久映射

### 数据

增加 external conversation record：

```ts
interface ExternalConversationRecord {
  id: string;
  connector: string;
  accountId: string;
  workspaceId?: string;
  chatId: string;
  threadId?: string;
  sessionId: string;
  createdAt: number;
  updatedAt: number;
}
```

唯一键至少包含：

```text
connector + accountId + chatId + threadId
```

同一个飞书群或 Telegram thread 每次都找到同一个 durable Session，不再共享一个全局 Agent history。

### 完成标准

- 两个 chat 的消息不会串到同一个 Session。
- daemon 重启后仍能找到原 Session。
- Session 被 archive 后，下一条外部消息按明确策略新建 Session 或返回提示，不能静默写回已归档 Session。

## Task C2：用外部消息 ID 做幂等准入

通道平台可能重复推送同一条消息。Bot 接入层必须把平台消息 ID 转成稳定 input ID：

```text
inputId = connector + accountId + externalMessageId
```

要保留原始 ID 和来源 metadata，但不要把用户正文塞进 ID。

### 完成标准

- 同一 webhook/WS 消息投递两次，只创建一个 durable Input。
- 第一次响应丢失后重试，可以查询到原 owning Run。
- 相同 externalMessageId 但正文不同，返回 idempotency conflict 并记录 warning。

## Task C3：实现 `DurableChannelBridge`

### 处理流程

```text
收到消息
  -> ACL 检查
  -> 找到或创建 external conversation
  -> 找到 durable Session
  -> 用 externalMessageId admit Input
  -> 等待 owning Run terminal 或读取最终 assistant part
  -> 发送回复
  -> 保存 delivery result
```

发送回复也要有状态：

```text
pending -> sent | failed | unknown
```

如果 Agent 已成功但平台回复失败，不能重新执行 Agent；只能重试发送同一个已保存回复。

### 完成标准

- Agent 执行和平台回复是两个可分别查询的步骤。
- 回复失败不会产生第二个 Run。
- daemon 关闭时停止接收新消息，等待或中断当前应用操作，再关闭通道接入层。

## Task C4：迁移 `vk channels serve`

### 要做的事

- 默认 attach 已有 daemon；没有 daemon 时按 CLI 现有规则启动。
- 只调用命名明确的 `createDefaultNodeAgent()` 或显式 Kernel 入口。
- 保留 standalone bridge 作为库测试能力，但名字明确为 ephemeral，不作为正式 serve 主线。
- `channels status` 显示 daemon、connector、conversation mapping 和最近 delivery 状态。

### 完成标准

- TUI 可以看到 Bot 创建的 Session 和 transcript。
- TUI/desktop 可以接管同一个 Bot Session 继续对话。
- Bot 触发的 permission 可在已有 permission UI 中处理，或按 Bot 专用 policy 明确拒绝。

---

# Milestone D：让 Agent Runtime 成为可独立交付的 Kernel

## 目标

把“Agent 怎么运行”和“本机默认加载什么”拆开，不保留旧函数别名。

## Task D1：列出 Kernel 与 Node 默认能力

先在代码旁建立一张清单，不能靠目录名字猜：

| 能力 | 应放位置 |
|---|---|
| Agent/Run/Child 状态与关闭 | Kernel |
| event/effect/handle | Kernel |
| QueryEngine turn loop | Kernel 或其直接依赖 |
| Provider client interface | Kernel contract |
| 具体 Anthropic/OpenAI client | Node default runtime |
| CredentialStorage | Node default runtime |
| settings 文件读取 | Node default runtime |
| plugin/skill 文件发现 | Node default runtime |
| MCP transport | Node capability |
| Sandbox/process/worktree | Node capability |
| LocalAgentJobHost | 显式 Node fallback |
| HTTP/SQLite/SSE | Durable Application，不进 Runtime |

完成这张清单后再移动代码，避免一边拆一边改变定义。

## Task D2：建立显式 Host Capabilities

把目前表示宿主能力的布尔值和隐式备用实现改成明确对象：

```ts
interface AgentHostCapabilities {
  permissions: AgentPermissionHost;
  jobs?: AgentJobHost;
  terminals?: AgentTerminalHost;
  schedules?: AgentScheduleHost;
  artifacts?: AgentArtifactHost;
  workspace?: AgentWorkspaceHost;
}
```

规则：

- 没有能力就不注册相关工具；
- Kernel 不自行去本机寻找能力；
- local fallback 必须由 `createDefaultNodeAgent()` 显式安装；
- child 只能继承父级允许的宿主能力上限；
- `inspect()` 返回实际安装的宿主能力列表。

## Task D3：拆出默认 Node composition

建议目标入口：

```ts
createAgentKernel(...)
createDefaultNodeAgent(...)
```

`createAgentKernel()` 不得：

- 调用 `loadSettings()`；
- 读取用户目录；
- 创建 CredentialStorage；
- 自动发现插件和 Skill；
- 启动 Sandbox；
- 写 `process.stderr`；
- 自动创建 LocalAgentJobHost。

默认 Node 入口继续提供当前开箱即用行为。

## Task D4：完成真实 npm 打包

### 要做的事

- 所有计划发布的包构建到 `dist`。
- `main`、`types`、`exports` 指向 `dist`，不指向 `src/*.ts`。
- 发布包不含 `workspace:*`。
- 定义哪些包公开发布、哪些包只在 monorepo 内使用。
- 为公开包增加 semver 和 changeset 规则。
- 使用 `pnpm pack` 生成 tarball，在临时仓库安装并运行测试。

### 完成标准

在 monorepo 外完成：

```text
安装 Agent Runtime
  -> 注入 fake model
  -> 注册两个 fake tools
  -> 运行 root agent
  -> 创建 child agent
  -> interrupt
  -> close
```

整个过程不需要仓库源码路径或 workspace symlink。

---

# Milestone E：让 daemon 中的 Workflow 使用统一 durable state

## 目标

保留 WorkflowRunner 的独立性，但 daemon 产品不再把 Workflow 的唯一事实放在 `.vykor/workflows/*.json`。

## Task E1：给 WorkflowStore 定义接口

```ts
interface WorkflowRunRepository {
  create(...): Promise<WorkflowRunSnapshot>;
  load(runId: string): Promise<WorkflowRunSnapshot | undefined>;
  list(...): Promise<WorkflowRunSummary[]>;
  saveCheckpoint(...): Promise<void>;
  appendEvent(...): Promise<void>;
  claim(...): Promise<WorkflowExecutionClaim>;
  finish(...): Promise<void>;
}
```

- 当前文件实现保留为 `FileWorkflowRunRepository`。
- WorkflowRunner 只依赖接口，不 import `node:fs`。
- daemon 新增基于 SessionStore/SQLite 的实现。

## Task E2：把 daemon Workflow 写入统一 Store

至少增加：

- workflow run；
- workflow task attempt；
- workflow checkpoint；
- workflow event；
- workflow execution claim；
- owner session 和 owner input/run 关系。

Workflow 事件进入 durable event registry，可以被 SSE、inspector 和 metrics 统一读取。

### 完成标准

- 一个 Run Inspector 可以看到 root Run 创建了哪个 Workflow、Workflow 又创建了哪些 child Run。
- daemon 重启能从 SQLite 判断 Workflow 是 completed、failed、interrupted 还是 needs attention。
- 不需要扫描项目目录 JSON 才能构建 Jobs 列表。

## Task E3：明确切断旧 Workflow 文件

- daemon 只读取 SQLite，不扫描项目目录里的 Workflow JSON；
- 不提供自动迁移、旧 ID 或旧格式解析；
- 旧文件不会影响 Jobs、恢复或运行状态；
- 需要保留的数据由用户在升级前自行导出和处理。

## Task E4：Jobs 改成事件式 wait

- Terminal、Detached Process、Agent、Workflow 继续各自拥有真实状态。
- Jobs 只做统一查询和控制，不保存第四份 JobSnapshot。
- Workflow 和 Session Execution 的 wait 改用事件/condition，不再固定 50ms 轮询 Store。
- ID 使用 producer-qualified identity，例如 `workflow:<id>`，避免不同 producer 撞 ID。

### 实施结果

- `WorkflowRunRepository` 是 Workflow 保存快照、事件和等待状态变化的统一入口。独立 CLI 仍使用项目文件；daemon 明确注入 SQLite 实现。
- daemon 保存 Workflow run、任务结果、事件、执行 claim，以及它属于哪个 Session、Input 和 Run。Run Inspector 和 runtime metrics 都能看到 Workflow。
- daemon 不读取或迁移旧 Workflow JSON；SQLite 是唯一事实来源，旧文件由用户自行处理。
- Workflow Job ID 只接受 `workflow:<runId>`，不接受裸 runId。
- Workflow 和 Session Execution 的 `JobWait` 现在等待状态变化通知或超时，不再每 50ms 查询一次 Store。

---

# Milestone F：补长期运行所需的边界

## Task F1：一个数据目录只能有一个执行 owner

第一阶段不做多实例接管，只防止双重执行。

### 要做的事

- application 启动时为 Store 获取 owner lock；
- lock 记录 owner ID、PID、启动时间和心跳；
- 同一数据目录已有活 owner 时，新实例明确失败并给出 attach 信息；
- owner 死亡且超过安全窗口后允许新实例接管；
- 每次写执行状态时保留 owner generation，旧实例迟到写入不能覆盖新状态。

这里的 generation 是“第几任执行者”的数字。它的作用是：旧进程即使突然恢复，也不能再修改新进程已经接管的数据。

## Task F2：增加协议版本与功能清单

新增公开入口，例如 `GET /capabilities`：

```json
{
  "serverVersion": "0.4.0",
  "protocol": { "version": 2 },
  "features": {
    "steer": 1,
    "runAttempts": 1,
    "toolAttempts": 1,
    "jobs": 2,
    "schedules": 1,
    "workflow": 2
  }
}
```

- client 启动时检查协议版本是否完全一致；
- 功能不存在时隐藏或禁用 UI，并说明原因；
- 不通过“请求一下看看是不是 404”猜功能；
- release version 和 protocol version 分开。

## Task F3：增加数据保留与清理规则

明确：

- completed Run/Attempt 保存多久；
- durable events 保存多久或压缩到哪里；
- terminal/process output 上限；
- completed Jobs 何时不再出现在默认列表；
- Workflow event 何时归档；
- projection settlement 永久失败如何人工 abandon；
- Session archive 是否级联清理 child、artifact 和外部 conversation mapping。

所有自动清理都必须可审计，并且不能删除仍被 active/recovery 记录引用的数据。

## Task F4：统一备份清单

备份不能只复制 SQLite，因为当前还有 memory、artifact、process output、worktree metadata 等文件。

定义 backup manifest：

```text
backup/
  manifest.json
  database.sqlite
  artifacts/
  memory/
  execution-output/
  checksums.json
```

完成标准：

- 在空数据目录恢复后，可以读取历史 Session、Run、Workflow 和 artifact；
- 不尝试复活旧 live process；
- active 记录按 restart recovery 规则收束。

### 实施结果

- Application 启动时会在 SQLite 中取得 owner 租约。租约包含 owner ID、PID、启动时间、心跳和 generation。活 owner 存在时第二个 Application 会直接失败；心跳超过安全窗口后才能接管。
- Store 保存前会核对 owner ID 和 generation。旧进程即使在接管后恢复运行，也不能继续写入。
- `/capabilities` 明确返回发布版本、唯一协议版本和功能版本。Client 的 `capabilities()` 要求协议版本完全一致；UI 可以用 `supportsFeature()` 决定是否显示功能。
- 默认清理规则保留 Run 摘要，清理过期 attempt、已结束 Workflow、旧事件和已经 resolved/abandoned 的 projection settlement；active 或仍被执行 claim 引用的数据不会删除。每次清理结果写入 `retention_audit`。
- 后台进程和子 Agent 的落盘输出最多保留最新 10MB；终端内存输出沿用原有的更小上限。读取接口仍可要求更短的尾部内容。
- archive Session 会先停止它和子 Session 的运行，但不会顺手删除 artifact、Bot 对话映射或历史正文；这些内容要等明确的保留规则或人工删除，避免“归档”意外变成“清空”。
- 备份使用 SQLite 在线备份，不直接复制正在写入的数据库文件。备份包含 manifest、数据库、可选 artifact/memory/execution-output 和 SHA-256 校验。恢复只允许写入空目标，并明确不复活旧进程；旧 active 状态交给正常启动恢复收束。

---

# 六、每个里程碑的测试要求

## A：Protocol / Client

- protocol serialization tests；
- browser Vite build；
- client reducer replay/live convergence；
- client 包无 Node/SQLite import 检查；
- 新旧 runtime metadata 兼容测试。

## B：Application

- 不启动 HTTP 的 application integration test；
- startup recovery 后才 ready；
- close/drain 测试；
- fake transport 与真实 HTTP transport 得到相同业务结果；
- route request schema 和 error mapping 测试。

## C：Bot

- 两个 chat 隔离；
- duplicate message 幂等；
- reply 失败只重试发送、不重跑 Agent；
- daemon restart 后继续原 Session；
- Bot 与 TUI 同时 attach；
- permission pending/reply/expire。

## D：Kernel

- standalone Kernel contract；
- Node default composition contract；
- child capability inheritance；
- npm packed install test；
- 无用户目录、无 Git、无 Sandbox 的最小运行。

## E：Workflow

- file repository 与 SQLite repository 共享 contract test；
- restart/cancel/late-write；
- daemon 不读取或迁移旧项目文件；
- SQLite 与文件 repository 分别做严格解码和损坏数据诊断；
- Jobs event-driven wait。

## F：长期运行

- 两个 process 竞争同一 Store owner；
- stale owner 接管；
- 旧 generation 写入被拒绝；
- 协议版本精确匹配测试；
- retention 不删除 active 引用；
- backup/restore。

---

# 七、建议的 PR 切分

不要按“改完一个包”切 PR，要按可以独立验证的行为切：

1. `[protocol] Add browser-safe session and event contracts`
2. `[client] Remove services and SQLite from the public client entry`
3. `[client] Move Node diagnostics behind host capabilities`
4. `[client] Add browser build fixture`
5. `[application] Move agent/session/control services out of HTTP folders`
6. `[application] Export a transport-free durable application entry`
7. `[http] Route all session operations through application ports`
8. `[channels] Persist external conversation to session mappings`
9. `[channels] Admit channel messages with stable input IDs`
10. `[channels] Replace standalone serve with durable application bridge`
11. `[agent-runtime] Add explicit host capability composition`
12. `[agent-runtime] Separate kernel from Node defaults`
13. `[release] Build and pack public runtime packages`
14. `[workflow] Introduce WorkflowRunRepository contract`
15. `[workflow] Add SessionStore-backed workflow persistence`
16. `[workflow] Cut over daemon Workflow state to SQLite only`
17. `[jobs] Replace Workflow polling with event-driven wait`
18. `[daemon] Add single-owner store protection and generation fencing`
19. `[protocol] Add client/server version and feature negotiation`
20. `[storage] Add retention and backup manifest`

每个 PR 都应该做到：

- 先写能暴露旧问题的测试；
- 不顺手改变无关 public API；
- 新数据库结构有 migration 和严格读取测试；
- 更新一份权威文档，不新增重复说法；
- focused tests 通过；
- 受影响 package typecheck 通过；
- `git diff --check` 通过。

---

# 八、版本门槛

## 下一个版本：Browser-safe Client

必须完成 A1-A4。

发布前必须证明：

- client 不依赖 services；
- browser fixture 无 Node polyfill 构建成功；
- protocol 请求/响应能在 client 和 server 两侧校验；
- 现有 CLI/TUI/Desktop 行为不回退。

## 后续版本：Transport-free Durable Application

必须完成 B1-B4。

发布前必须证明：

- application 不依赖 Hono；
- 不启动端口也能跑完整 durable session；
- HTTP/SSE 只是接入层；
- startup recovery、shutdown 和 projection 语义不变。

## 后续版本：Durable Bot

必须完成 C1-C4。

发布前必须证明：

- Bot、TUI、Desktop 看到同一份 Session；
- 重复平台消息不会重复运行 Agent；
- 回复失败不会重跑 Agent；
- 重启后 conversation mapping 不丢失。

## 后续版本：Independent Runtime Kernel

必须完成 D1-D4。

发布前必须证明：

- packed npm 包可在仓库外运行；
- Kernel 不读取本机 settings/credentials/plugins；
- Node default 入口仍保持当前开箱即用行为；
- public package 不再指向 TypeScript 源码。

## 后续版本：Unified Workflow Durability

必须完成 E1-E4 和 F1。

发布前必须证明：

- daemon Workflow 的事实进入统一 Store；
- Workflow 可被统一 inspector、events、metrics 和 Jobs 查询；
- daemon 不扫描、不读取也不迁移旧 Workflow 文件；
- 一个 Store 不会被两个执行者同时执行。

---

# 九、最终验收场景

最终用一个临时数据目录跑下面的真实流程：

```text
1. CLI 创建 Session 并发送第一条消息。
2. Web client 从 snapshot + SSE 看到同一条消息和输出。
3. Desktop attach 同一个 Session，并修改下一轮 model 配置。
4. Bot 某个 chat 第一次发消息，系统建立 external conversation mapping。
5. Bot 平台重复投递同一个 message ID，系统只保留一个 Input 和一个 owning Run。
6. Bot 回复发送失败；系统重试发送旧回复，不重新调用模型。
7. 一轮 Run 创建 Child Agent 和 Workflow。
8. Tool started 后强制 kill Daemon。
9. 新 Daemon 启动：
   - 旧 Run/Attempt/Tool 安全收束；
   - Tool 显示 unknown_outcome；
   - Workflow 显示 interrupted 或 needs attention；
   - Bot conversation 仍指向原 Session；
   - client 从旧 cursor 重连并最终收敛。
10. inspect-run 能串起 Input、Run、Attempt、Tool、Child 和 Workflow。
11. 同时启动第二个 Daemon，第二个明确拒绝成为同一 Store 的执行 owner。
12. 把 agent-runtime packed tarball 安装到临时仓库，用 fake provider 独立跑完 root + child + close。
```

这组验收真正要证明的是：

> 不管用户从哪个产品入口进来，输入都进入同一个 Durable Agent Application；不管进程在哪里退出，系统都能说明已经发生什么、哪些结果无法确认、用户接下来可以安全做什么。
