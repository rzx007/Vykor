# Client Sync Flow

> 状态：当前 TUI、Web、Desktop 共用客户端同步的权威说明。最后核对：2026-09-17。

## 边界

`@openharness/client` 负责四件事：

1. 在首个业务请求前确认 Client 与 daemon 使用同一个协议版本；
2. 通过领域 Resource 发起 typed HTTP 请求；
3. 读取 session snapshot，并从对应 cursor 继续接收 SSE；
4. 用共享 reducer 把 replay/live event 合并成客户端可展示状态。

Client 不运行 Agent、不读 SQLite、不决定 prompt 是 steer 还是 queue，也不保存第二份服务端业务真相。

## 公开入口

`OpenHarnessClient` 只组装 `protocol` 和领域 Resource：

```ts
const client = new OpenHarnessClient({ baseUrl, token });

const session = await client.sessions.create(input);
await client.sessions.admitPrompt(session.id, { content: "hello" });
await client.permissions.reply(requestId, { decision: "allow" });
const jobs = await client.jobs.list();
```

当前资源包括 system、providers、auth、projects、plugins、development、sessions、attachments、permissions、schedules、jobs、terminals、channels 和 events。底层 transport 类仍可作为 SDK 构件导入，但 `OpenHarnessClient` 实例不暴露 transport 属性；产品代码不应绕过 Resource 直接拼业务 endpoint。

## 首个请求前的协议握手

`HttpTransport` 把 `/health` 和 `/capabilities` 视为握手例外。首次普通业务请求的顺序是：

```text
Resource method
  -> HttpTransport.ensureProtocol()
  -> GET /capabilities
  -> checkProtocolCompatibility({ version: 4 })
  -> 成功后缓存握手结果
  -> 业务请求携带 x-openharness-protocol-version: 4
```

版本必须完全相等。缺少版本、版本不是 4 或响应格式错误都会在业务请求前失败；Client 不尝试 min/max 范围协商，也不降级到旧协议。

## 单个 Session 的 snapshot-first attach

`SessionSyncController` 是无 UI 框架依赖的同步控制器。给定 `sessionId` 时，它先建立完整基线，再接 live stream：

```text
client.sessions.getState(sessionId)
  -> session / inputs / messages / parts
  -> runs / attempts / tasks / permissions
  -> snapshot.cursor
  -> applySessionSnapshot()
  -> client.events.stream({ sessionId, cursor })
```

snapshot 和 cursor 在服务端同一个原子读取中产生，因此不会出现“状态读取完、订阅前刚好漏掉一个事件”的窗口。Controller 使用 `max(initialCursor, snapshot.cursor, state.lastSeq)` 作为下一次 SSE 起点。

## 全局同步

没有 `sessionId` 时，Controller 从当前 cursor 调用 `client.events.list()` 回放 durable event，然后订阅 `client.events.stream()`。这适合 session 列表、全局任务或其他跨 session 状态。

调用方如果传入非零 cursor，必须同时传入与该 cursor 对应的 `initialState`。只有 cursor 没有状态会跳过历史，Controller 会直接拒绝这种组合。

## SSE gap、重连和去重

收到 live event 后，Controller 比较 `event.seq` 与当前 cursor：

```text
event.seq == cursor + 1
  -> 直接 applyEvent()

event.seq > cursor + 1
  -> client.events.list({ cursor }) 补 durable gap
  -> 按序 applyEvent()
  -> 再应用当前 live event
```

stream 正常结束或遇到可恢复网络错误时，状态进入 `reconnecting`，按指数退避等待，再从 `state.lastSeq` 建立新连接。Abort 会结束循环；不支持的 event schema version 属于不可恢复错误，状态进入 `error`，不会靠跳过事件继续。

Reducer 以 durable `seq` 去重。text delta 是 transient event：它会立即追加显示，但不进入 durable `eventsBySeq`，只推进 `transientCursor`，避免重连时重复文字。part complete、Tool 边界和 Run terminal 会把完整正文持久化，后续 snapshot 可以恢复。

## 状态放在哪里

顶层 `OpenHarnessClientState` 保存：

- session 列表和按 session 分桶的 Input、Message、Part、Run、Attempt、Task、Permission；
- `eventsBySeq` 和 `lastSeq`，用于 durable replay 去重；
- `transientCursor`，用于 live-only delta 去重；
- reducer 派生所需的连接无关状态。

TUI transcript 只从 Message + Part 派生，不扫描 `runtime.*` 日志猜文本。Frontend 或 Desktop 可以在这份状态外保存选中项、草稿、面板和连接提示，但不能把本地 UI 状态写成服务端 Run 真相。

## Prompt ID 与可靠重试

`client.sessions.admitPrompt()` 在调用方未提供 `id` 时生成一个 request ID，随后把它放入请求 body。服务端 HTTP body 中 `id` 仍是可选字段，可以为简单调用生成 ID。

需要可靠重试的调用方必须自己生成并持久保存稳定 ID：

```ts
const id = createPromptRequestId();
await client.sessions.admitPrompt(sessionId, { id, content });
// 网络结果不确定时，使用同一个 id 重试。
```

同一个 ID 和相同内容可以安全重试；同一个 ID 携带不同内容会被拒绝。自动生成 ID 适合不需要恢复“响应是否丢失”的一次性调用，不构成跨进程重试保证。

## UI 接线

```text
Frontend / Desktop
  -> 创建 SessionSyncController
  -> onStatusChange 更新连接提示
  -> onUpdate 接收 snapshot / replay / live / reconnecting
  -> 把 controller.currentState 交给 selector 和组件
  -> 切换 session 或卸载时 abort 旧 generation
```

generation fencing 防止旧 session 的迟到事件写进新页面。Frontend hook 和 Desktop Main subscription service 共用 Controller，不各自实现 stream pump、cursor、gap catch-up 或重连计时器。

## 结果怎样回到界面

一次业务动作的 HTTP response 只说明该动作已经被 daemon 接受或完成相应同步步骤。持续输出和最终 durable 状态通过 SSE 回到 reducer：

```text
Resource response
  + snapshot/replay/live SSE
  -> shared reducer
  -> selectors
  -> TUI / Web / Desktop components
```

产品界面不应在收到 HTTP response 后手工拼一份 Message 或 Run；否则下一次 snapshot 会与本地副本冲突。

## 失败语义

- 协议不兼容：`IncompatibleProtocolError`，不发送业务请求；
- HTTP 已知错误：转换为 `OpenHarnessApiError`，保留状态码和结构化 payload；
- 网络/SSE 暂时失败：Controller 进入 reconnecting 并从 `lastSeq` 继续；
- event schema 不支持：进入 error，要求升级 Client；
- generation 已过期或 signal aborted：丢弃迟到结果，不更新当前界面；
- prompt 响应未知：只有保存过稳定 request ID 的调用方才能可靠重试。

## 验证入口

- `packages/client/src/transport/__test__/protocol-handshake.test.ts`：握手和版本 header；
- `packages/client/src/state/__test__/session-sync-controller.test.ts`：snapshot、gap、重连、abort 和 generation；
- `packages/client/src/state/__test__/reducer.test.ts`：durable/transient event 合并；
- `packages/client/src/__test__/public-api.test.ts`：公共导出与禁止 facade；
- `tests/client-public-api/`：跨包编译契约；
- `scripts/client-public-api-contract.json`：当前公共面事实源。

服务端请求与投影流程见 [Daemon Application Architecture](./daemon-application-architecture.md)，协议错误和 breaking change 规则见 [Protocol Contract](./protocol-contract.md)。
