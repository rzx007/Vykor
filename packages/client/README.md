# @openharness/client

连接 OpenHarness daemon（`ohs serve`）的共享客户端 SDK。面向 TUI / Web / Desktop / IDE：typed HTTP API、SSE 事件流、事件 reducer、snapshot + live 同步。

客户端只负责展示与控制，不拥有 agent runtime。

```text
TUI / Web / Desktop
        |
        | @openharness/client
        | HTTP actions + SSE events
        v
ohs serve / daemon
```

## 职责

| 模块 | 作用 |
|------|------|
| `client.ts` | `OpenHarnessClient`：包装 server REST + `/events/stream` SSE |
| `reducer.ts` | `applySessionSnapshot` / `applyEvent`：快照水合后归并实时事件 |
| `selectors.ts` | `selectSessionMessagesWithParts` / `selectFirstPendingPermission` 等纯函数读视图 |
| `sync.ts` | `syncEvents`：会话先读取原子 snapshot，再从 snapshot cursor 接 SSE live |
| `types.ts` | 请求/响应与客户端聚合状态类型 |

### 状态所有权矩阵

| 状态类别 | 包含内容 | 唯一所有者 | 规则 |
|---|---|---|---|
| **Durable Remote State** | Session, Input, Message, Part, Run, Task, Permission, Event cursor | `@openharness/client/state` (`reducer`, `snapshot`, `sync`) | 平台层不得自行实现第二套 Message/Run/Task 对账 |
| **Connection State** | daemon registry, client instance, connected/reconnecting/error, abort/generation fencing, retry timers | 平台 connection controller / service | 纯平台生命周期持有，不混入 durable 对账 |
| **Operation State** | create/update/archive, prompt admission, upload, job 操作, optimistic tokens | 各平台 feature store / hook | 失败只回退局部 operation，不重置全局 durable 状态 |
| **Draft State** | composer text, attachments, plugin selection, edit state | 各平台 composer feature | 纯本地瞬态，不跨 session 混淆 |
| **View State** | selected session/project, panels, scroll, filters | UI store | 纯界面派生展示状态 |
| **Platform State** | window, tray, updater, filesystem, terminal, IPC | Desktop main / preload | 不得泄漏到共享 Client 或 Web 前端 |

约束：

- UI 不直接读 daemon 内部 store 文件
- 可恢复状态来自 HTTP snapshot + SSE live
- 多端 attach 同一 daemon 时，用同一套 reducer 收敛状态
- 公共 Session/Run/Event/Job/Terminal 类型来自浏览器安全的 `@openharness/protocol`
- client 生产代码不依赖 `@openharness/services`、`@openharness/jobs`、`@openharness/terminal`、SQLite、Drizzle 或 Node builtin
- Session Snapshot、Event、Job 和 Terminal 响应会在进入客户端状态前检查字段
- `/doctor` 等本机信息由宿主提供；浏览器可以不提供

## 使用

```ts
import {
  OpenHarnessClient,
  syncEvents,
} from "@openharness/client";

const client = new OpenHarnessClient({
  baseUrl: "http://127.0.0.1:12345",
  token: registry.token,
});

await client.health();
const session = await client.createSession({ cwd: process.cwd() });
await client.admitPrompt(session.id, { content: "hello" });

for await (const update of syncEvents(client, { sessionId: session.id })) {
  // update.source: "snapshot" | "live"
  // update.state: OpenHarnessClientState
  console.log(update.event?.type ?? "snapshot", update.state.lastSeq);
}
```

当前主要消费者：

- `apps/frontend` 的 `useServerSync`（TUI）
- `apps/cli` 的 `print-session.ts`（用户 headless print）

## API 一览

| 方法 | HTTP |
|------|------|
| `health()` | `GET /health` |
| `listSessions()` | `GET /sessions` |
| `createSession()` | `POST /sessions` |
| `getSession(id)` | `GET /sessions/:id` |
| `getSessionState(id)` | `GET /sessions/:id/state` |
| `listMessages(id)` | `GET /sessions/:id/messages` |
| `admitPrompt(id, input)` | `POST /sessions/:id/prompts` |
| `interruptSession(id)` | `POST /sessions/:id/interrupt` |
| `listEvents()` | `GET /events` |
| `streamEvents()` | `GET /events/stream` |
| `listPermissions()` | `GET /permissions` |
| `replyPermission(id, input)` | `POST /permissions/:id/reply` |

## 相关文档

- [docs/client-sync-flow.md](../../docs/client-sync-flow.md)
- [docs/daemon-application-architecture.md](../../docs/daemon-application-architecture.md)

## 测试

```bash
pnpm --filter @openharness/client test
pnpm --filter @openharness/client check-types
pnpm test:client-browser
```
