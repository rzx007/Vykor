# Vykor Session Part Event Model 计划

> 日期：2026-08-01
> 状态：已完成第二轮回归修正。canonical parts、snapshot attach、TUI busy/streaming、Windows runtime 初始化无子进程已完成定向验收。
> 实施背景（问题已解决）：`vk --tui` 迁到 daemon/client 主线后，流式输出、工具调用展示、busy 状态和跨客户端恢复曾依赖临时 `runtime.*` 事件。本任务已将 server 事件模型升级为 durable message parts，并删除旧 `session.message.appended` 主模型。

## 目标

建立一套 server-owned、可持久化、可 replay、可被 TUI/Web/Desktop/remote attach 共同消费的消息状态模型：

```text
TUI / Web / Desktop / remote attach
  -> @vykor/client
  -> HTTP snapshot/actions + SSE live
  -> @vykor/server
  -> SessionStore
  -> SessionRuntime / QueryEngine
```

核心变化：

- 文本、工具调用、工具结果、reasoning、workflow/task 状态都进入统一 event log。
- 客户端不再消费 `runtime.text_delta`、`runtime.tool_use_start`、`runtime.tool_use_end`。
- server 不再只在 run 结束后追加完整 assistant message。
- `@vykor/client` reducer 成为 TUI/Web/Desktop 的唯一状态归并层。
- 当前 message-part 数据结构是唯一实现；旧事件和旧 store 代码已删除。

## 2026-08-01 回归复盘

Task 9 初次实现后把现场问题完全归因于 stale daemon 是错误结论。第二轮复盘确认了三个独立缺口：

- server 的 canonical message/part 数据实际完整，但客户端 attach 只依赖从 event log 全量回放，没有权威 session snapshot。跨客户端恢复、session 切换和事件边界都缺少稳定基线。
- TUI 用 `localBusy || activeRun` 表示提交状态；run 的 running/completed 事件若被 React 合并为最终状态，`activeRun` 从未发生可观察变化，`localBusy` 会永久保持 true。
- 每个新 session 初始化 runtime 时会隐式启动三次 Git 子进程：两次构建环境信息、一次解析 repo root。补 `windowsHide` 只隐藏症状，没有消除发送消息路径上的隐式进程。
- stale daemon 检测仍有价值，但它不是 assistant/tool 不可见和闪窗的充分解释。

本次修正：

- `/health` 返回存活状态与 release version；不暴露 session schema/protocol 版本。
- daemon registry 写入 version/startedAt；`vk --tui` 和 `vk daemon start` 会探测 health，发现 daemon 早于当前 CLI 构建或 release 不同时停止它并启动当前构建。
- 新增 `GET /sessions/:sessionId/state`，在单一 cursor 下返回 session、inputs、messages、parts、runs、permissions；`@vykor/client` 使用 snapshot + SSE delta attach。
- TUI 用服务端返回的 run id 跟踪提交，直到对应 run 进入 terminal 状态；running part 显式交给 OpenTUI streaming markdown，transcript item 使用稳定 id。
- daemon 启动时将前一进程遗留的 pending/running run 标记为 interrupted，避免恢复后永久 busy。
- repo root/branch 检测改为读取 `.git` marker/HEAD，不再在 runtime 初始化时 spawn Git。
- 唯一默认存储为 `~/.vykor/data/session-runtime/sessions.db`；旧 `~/.vykor` 与 JSON store 都不读取、不迁移。
- `@vykor/client.health()` 只负责 transport 探活，stale daemon 判断归 CLI 生命周期所有。
- 修正多轮工具执行边界：工具调用后的下一轮模型输出创建新的 assistant message，不再混入上一轮 message。

真实 daemon 验收结果：

- services/server/client 的 snapshot 与 canonical parts 定向测试通过。
- OpenTUI 完整 `AppView` 与 `useServerSync` 共 9 个测试通过，覆盖“先出现 user、随后 live assistant part”、历史/live 工具调用和工具结果。
- core/prompts 共 69 个测试通过，包含纯文件系统 Git repository/worktree marker 识别。
- core/client/services/server/prompts/frontend 六个 package 定向类型检查通过；CLI 与 frontend 生产构建通过。
- 使用生产构建启动真实 daemon，registry/store 仅写入 `~/.vykor`，并完成 create session → atomic snapshot → archive → stop。
- CLI workspace 总类型检查仍存在既有长时间不退出问题；本轮按约定跳过，不把它误写为已通过。

## 实施前代码地图

以下内容保留为 Task 9 的决策基线，不代表当前实现；当前结构以本文“本次修正”和 [client-sync-flow.md](../../client-sync-flow.md) 为准。

### CLI / TUI 启动

- `apps/cli/src/index.ts`
  - 暴露 `vk --tui`、`vk serve`、`vk daemon`。
- `apps/cli/src/commands/main.ts`
  - `mainAction()` 进入 `runTuiMode()`。
  - `runTuiMode()` 读取 daemon registry；没有可用 daemon 时 spawn `node <cli> serve --register --host 127.0.0.1 --port 0`。
  - 再 spawn Bun frontend，并通过 `VYKOR_FRONTEND_CONFIG` 注入 daemon url/token/cwd/model。
- `apps/cli/src/commands/daemon.ts`
  - `serve` 前台启动 Hono server。
  - `daemon start/status/stop` 管理后台 daemon。

当前判断：

- `runTuiMode()` 的 daemon spawn 已使用 `windowsHide: true`。
- 发送消息路径不再为了 runtime 环境信息和 repo root 启动 Git 子进程。
- Bash、Git worktree、search 等显式工具仍可启动隐藏子进程，这是工具执行能力，不属于普通 prompt 初始化。

### Server（实施前基线）

- `packages/server/src/http.ts`
  - `VykorHttpServer` 基于 Hono。
  - 路由包括 sessions、messages、prompts、interrupt、permissions、events、SSE。
  - 内部维护：
    - `SessionStore`
    - `StorePermissionBroker`
    - `SessionRunCoordinator`
    - `Map<sessionId, Promise<SessionRuntime>>`
- `packages/server/src/run-coordinator.ts`
  - 同 session 串行，不同 session 可并发。
  - 支持 queued run 和 interrupt。
- `packages/server/src/runtime.ts`
  - 实施前：`SessionRuntime.runPrompt()` 返回最终 messages。
  - 实施前：`hooks.onEvent()` 只是透传 runtime 私有事件。

实施前问题（已解决）：

- `executeRun()` 将 QueryEngine 流事件写成 `runtime.*` event。
- 最终 `result.messages` 再通过 `appendRuntimeMessage()` 写入 `session.message.appended`。
- 流式状态和持久 message 是两套来源。

### Session Store（实施前基线）

- `packages/services/src/session-runtime/types.ts`
  - 实施前已有 `SessionRecord`、`SessionInputRecord`、`SessionMessageRecord`、`SessionEventRecord`、`SessionRunRecord`、`PermissionRequestRecord`。
- `packages/services/src/session-runtime/store.ts`
  - 实施前 store 只有整条 message，没有 part 表。
  - 实施前 message 是整条 `SessionMessageRecord`。
  - `appendMessage()` 产生 `session.message.appended`。
  - `appendEvent()` 可写任意 event，但没有 message part 语义。

实施前问题（已解决）：

- tool use 存在于 assistant message metadata 里，tool result 是独立 `tool_result` message。
- 这对历史恢复勉强可用，但不适合流式 UI、工具状态更新和跨客户端一致渲染。
- 没有办法稳定表达“一个 assistant message 下面的多个 part 正在增量更新”。

### Client SDK（实施前基线）

- `packages/client/src/client.ts`
  - typed HTTP/SSE client。
- `packages/client/src/sync.ts`
  - 实施前：`listEvents()` replay 后再 `streamEvents()` live。
- `packages/client/src/reducer.ts`
  - 实施前 reducer 只处理：
    - `session.created`
    - `session.archived`
    - `session.input.admitted`
    - `session.message.appended`
    - `session.run.created`
    - `session.run.updated`
    - `permission.asked`
    - `permission.replied`
- `packages/client/src/types.ts`
  - 实施前 `SessionBucket` 是 `messages[] + inputs[] + runs + permissions`。

实施前问题（已解决）：

- reducer 不理解 part。
- `runtime.*` 虽然进入 `eventsBySeq`，但不归并到规范状态，只能由 TUI 自己扫描 event log。

### TUI Frontend（实施前基线）

- `apps/frontend/src/hooks/useServerSync.ts`
  - 创建 `VykorClient`。
  - 选择/创建 active session。
  - 订阅 `syncEvents()`。
  - 将 bucket messages 映射为 transcript。
  - 额外扫描 `runtime.text_delta` 得到 `assistantBuffer`。
  - 额外扫描 `runtime.tool_use_start/end` 得到临时工具 transcript。
- `apps/frontend/src/routes/session/Session.tsx`
  - 渲染 `items` 和独立 `assistantBuffer`。
- `apps/frontend/src/routes/session/parts.tsx`
  - 已有 `tool` / `tool_result` 展示能力，包括 Edit/Write diff。

实施前问题（已解决）：

- TUI 同时从 `messages[]` 和 `runtime.*` 读状态。
- 切换 session、run 完成、SSE replay/live 交错时容易出现 busy、空白页、工具调用缺失、重复/丢失流式输出。
- Web/Desktop 后续如果复用 SDK，也会被迫复制 TUI 的 runtime event 解释逻辑。

### QueryEngine / Runtime Adapter（实施前基线）

- `packages/core/src/types/events.ts`
  - QueryEngine 事件只有：
    - `text_delta`
    - `tool_use_start`
    - `tool_use_end`
    - `usage`
    - `complete`
    - `error`
- `packages/core/src/engine/query-engine.ts`
  - `submitMessage()` 会将 user message 加入内存 history。
  - provider 流内聚合 assistant text 和 toolUses。
  - 工具执行后 yield `tool_use_end`。
  - run 结束后 `getHistory()` 可返回完整 core messages。
- `apps/cli/src/session-runtime.ts`
  - 实施前把 core history 转成 `RuntimeMessageRecord`。
  - 实施前把 QueryEngine event 透传为 `runtime.${event.type}`。

当时判断（已按此实施）：

- 本任务不需要先重写 provider 或 QueryEngine。
- 可以在 server/runtime adapter 层把 QueryEngine event 翻译为 durable message part event。
- 后续再决定是否把 QueryEngine 自身升级为直接产生 part 事件。

## opencode 对照结论

opencode 的关键不是“有没有 HTTP”，而是：

- 本地 TUI 默认用 worker 内嵌 server，通过 direct `app.fetch` 和 RPC events 连接，不把外部 daemon 当 prompt 主路径。
- server runtime 是长生命周期 instance，session runner 只负责 busy/cancel/run lifecycle。
- UI 消费的是 durable message parts：
  - `message.part.updated`
  - `message.part.delta`
  - tool/text/reasoning 都是 part
- prompt async 提交后立即返回，真实输出靠 event bus。

Vykor 当前已经有 daemon、run coordinator、SSE、client reducer 的骨架。缺的是 durable message parts。因此本任务先做 event/state 模型，不先做 worker direct fetch 拓扑。

## 新模型

### Store schema

将 `SessionStore` 直接升级为唯一的 message shell + parts 数据结构，不保留旧 state 读取分支。

新增记录：

```ts
type MessageRole = "system" | "user" | "assistant";

type MessagePartType =
  | "text"
  | "reasoning"
  | "tool"
  | "tool_result"
  | "error"
  | "log";

type MessagePartStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted";

interface SessionMessageRecord {
  id: string;
  sessionId: string;
  seq: number;
  role: MessageRole;
  runId?: string;
  inputId?: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

interface SessionMessagePartRecord {
  id: string;
  sessionId: string;
  messageId: string;
  seq: number;
  type: MessagePartType;
  status: MessagePartStatus;
  text?: string;
  toolUseId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  isError?: boolean;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}
```

Store API：

```ts
createMessage(input): SessionMessageRecord
upsertMessagePart(input): SessionMessagePartRecord
appendMessagePartDelta(input): SessionEventRecord
listMessages(sessionId, options): SessionMessageRecord[]
listMessageParts(sessionId, options): SessionMessagePartRecord[]
```

### Event types

废弃主路径：

- `session.message.appended`
- `runtime.text_delta`
- `runtime.tool_use_start`
- `runtime.tool_use_end`

新增主路径：

- `session.message.created`
- `session.message.part.updated`
- `session.message.part.delta`
- `session.run.created`
- `session.run.updated`
- `session.run.error`
- `session.run.interrupted`
- `permission.asked`
- `permission.replied`

事件 payload 约定：

```ts
type MessageCreatedPayload = {
  message: SessionMessageRecord;
};

type MessagePartUpdatedPayload = {
  part: SessionMessagePartRecord;
};

type MessagePartDeltaPayload = {
  sessionId: string;
  messageId: string;
  partId: string;
  field: "text";
  delta: string;
};
```

规则：

- `message.part.delta` 只用于追加型文本增量。
- 每个 delta 最终必须能通过对应 part 的 `text` 聚合恢复。
- `message.part.updated` 是 authoritative snapshot，可用于 replay 后纠偏。
- 工具调用开始、工具结果、错误状态都通过 `message.part.updated` 表达。

## Runtime 翻译策略

在 `VykorHttpServer.executeRun()` 内维护本次 run 的 transient builder：

```ts
type ActiveRunRenderState = {
  userMessageId: string;
  assistantMessageId?: string;
  activeTextPartId?: string;
  toolPartByUseId: Map<string, string>;
};
```

流程：

1. prompt admitted 后，run 真正开始前创建 user message + text part。
2. 收到第一个 assistant 事件时创建 assistant message。
3. `text_delta`
   - 若没有 active text part，创建 `type: "text"` part，status `running`。
   - append delta 到 part text。
   - 发 `session.message.part.delta`。
4. `tool_use_start`
   - 创建/更新 `type: "tool"` part。
   - 写入 `toolUseId/toolName/input/status: "running"`。
   - 发 `session.message.part.updated`。
   - 当前 active text part 若存在，标记 completed。
5. `tool_use_end`
   - 找到对应 tool part。
   - 写入 `output/isError/status`。
   - 发 `session.message.part.updated`。
6. `usage`
   - 可暂存到 run metadata，或发 `session.run.updated` metadata。
7. `complete`
   - 完成 active text/tool part。
   - run status completed。
8. `error`
   - 创建 `type: "error"` part，run status failed。

关键点：

- `SessionRuntime.runPrompt()` 不再返回最终 messages 作为 server 落盘来源。
- 可以暂时保留返回值用于 debug，但 server 主路径不依赖它。
- QueryEngine 的 internal history 仍由 runtime 维护；store 的 message/part 是客户端状态真相。

## Client reducer 改造

`VykorClientState` 改为：

```ts
interface SessionBucket {
  session?: SessionRecord;
  inputs: SessionInputRecord[];
  messages: SessionMessageRecord[];
  partsByMessageId: Record<string, SessionMessagePartRecord[]>;
  runs: Record<string, SessionRunRecord>;
  permissions: Record<string, PermissionRequestRecord>;
}
```

reducer 规则：

- `session.message.created`：upsert message，按 `seq` 排序。
- `session.message.part.updated`：upsert part，按 `seq` 排序。
- `session.message.part.delta`：找到 part，追加 `delta` 到指定 field。
- 如果 delta 先于 updated 到达：
  - 创建一个 placeholder part，状态 `running`，等 updated 到达后合并。
- `session.run.updated`：更新 run，同时更新 bucket session status。

客户端 transcript 应由 reducer 派生，不扫描 raw `eventsBySeq`。

## TUI 改造

`apps/frontend/src/hooks/useServerSync.ts`：

- 删除 `assistantBufferFromEvents()`。
- 删除 `runtimeTranscriptFromEvents()`。
- 删除 runtime tool use 临时映射。
- 从 `bucket.messages + bucket.partsByMessageId` 派生 transcript。
- 流式文本可以作为普通 assistant transcript item 渲染，不再单独维护 `assistantBuffer`。

`apps/frontend/src/routes/session/Session.tsx`：

- 可保留 `assistantBuffer` 字段一小段过渡，但主路径应让其恒为空。
- 更理想：后续删除 `assistantBuffer` prop。

`apps/frontend/src/routes/session/parts.tsx`：

- 复用现有 tool/tool_result 渲染。
- 后续可把 tool part 的 `status` 显示为 running/completed/failed。

## API 改造

新增：

```text
GET /sessions/:sessionId/parts?cursor=&limit=
```

或者让 `/sessions/:sessionId/messages` 返回：

```json
{
  "messages": [],
  "parts": []
}
```

建议本任务选择第一种，保持 messages 与 parts 独立，client hydrate 更清晰。

`GET /events` / `/events/stream` 保留给全局 replay/live；session attach 以 `GET /sessions/:sessionId/state` snapshot + cursor 后的 SSE live 为主入口。

## 测试计划

### Store

修改 `packages/services/src/session-runtime/store.test.ts`：

- 创建 message。
- upsert text/tool/tool_result part。
- append part delta。
- reload 后 messages/parts/events 都可恢复。
- reload 只覆盖当前 canonical state，不提供旧 state 迁移器。

### Client

修改 `packages/client/src/reducer.test.ts`：

- `session.message.created` + `session.message.part.updated` 能 hydrate transcript state。
- delta 追加能更新 part text。
- delta 先到、updated 后到能收敛。
- 重复 event seq 不重复应用。

### Server

修改 `packages/server/src/http.test.ts`：

- injected runtime yield `text_delta` 后，event log 包含 `session.message.part.delta`，不再断言 `runtime.text_delta`。
- tool start/end 生成 tool part update。
- run 完成后 messages/parts 可通过 API 读取。
- 同 session queue 行为保持不变。
- permission pending/reply 行为保持不变。

### TUI

修改 `apps/frontend/src/hooks/useServerSync.test.tsx`：

- replay message + part 生成 transcript。
- live delta 更新 transcript 文本。
- live tool part update 显示 tool/tool_result。
- `/new` 切换后不 busy。
- delete session 仍可用。

## 分阶段实施

### Task 9.1：Canonical Store

- [x] 改 `SessionMessageRecord` 为 message shell。
- [x] 新增 `SessionMessagePartRecord`。
- [x] 新增 store API：createMessage/upsertMessagePart/appendMessagePartDelta/listMessageParts。
- [x] 废弃 `appendMessage()` 主路径。
- [x] 更新 services exports。
- [x] 更新 store tests。

退出标准：

- store 单测通过。
- event log 能 replay message/part/delta。

### Task 9.2：Message-part Client Reducer

- [x] 更新 client types。
- [x] reducer 支持 message created / part updated / part delta。
- [x] 添加 message+parts selector，供 TUI/Web/Desktop 复用。
- [x] 更新 client tests。

退出标准：

- client reducer 不再依赖 `session.message.appended`。
- raw runtime events 不参与 UI 状态。

### Task 9.3：Server runtime event translator

- [x] 在 server 执行 run 时创建 user message/part。
- [x] 将 QueryEngine `text_delta` 翻译为 part delta。
- [x] 将 QueryEngine `tool_use_start/end` 翻译为 tool part update。
- [x] 将 error/complete/usage 写入 run/message part 状态。
- [x] 停止发 `runtime.*` 主事件。
- [x] 更新 server tests。

退出标准：

- server event log 中没有 `runtime.text_delta` 等主路径事件。
- 流式文本和工具调用都可以从单会话 snapshot + 其后的 SSE live 恢复。

### Task 9.4：TUI useServerSync 去 runtime 临时逻辑

- [x] 删除 `assistantBufferFromEvents()`。
- [x] 删除 `runtimeTranscriptFromEvents()`。
- [x] transcript 只来自 client state。
- [x] 更新 TUI hook tests。

退出标准：

- TUI 流式输出、工具调用、历史恢复走同一状态来源。
- `/new`、session 切换、delete session 不依赖 running runtime event。

### Task 9.5：进程闪窗审计

在 part event 模型稳定后再做：

- [x] 审计所有 `spawn/execFile/execFileSync/spawnSync/Bun.spawn`。
- [x] 对 Windows 下可能弹窗的子进程补 `windowsHide: true`。
- [x] 给 shell/git/lsp/search/task 等路径分类。
- [x] 定位现场仍闪窗的原因：TUI 复用了 Task 9 前启动的 stale daemon，新进程策略从未生效。
- [x] 增加基于 release version 与 CLI 构建时间的 stale daemon 退场逻辑；不引入协议/schema 兼容层。
- [x] Ctrl+C 改为等待 OpenTUI renderer 完成销毁后退出，恢复 raw mode、光标与 alternate screen。

退出标准：

- 发送普通 prompt 不出现额外终端窗口。
- 若工具本身需要可见终端，必须是显式用户行为。

## 不做事项

本任务不做：

- 不实现 worker direct fetch。本地 TUI 后续可参考 opencode 改成 worker 内嵌 server，但要等 canonical state 稳定。
- 不做 Web/Desktop UI。
- 已完成 SQLite adapter；本条为历史阶段的范围限定。
- 不提供旧 store 读取或迁移分支。
- 不保留 `runtime.*` 作为客户端协议。

## 风险

- QueryEngine 仍维护自己的内存 history，server store 维护 message parts，两者短期会双写。需要以 store 作为 UI truth，QueryEngine history 只作为模型上下文。
- `tool_use_end` 当前在工具执行后才 yield，中间工具执行耗时阶段只有 tool part running；这符合 UI 预期。
- workflow/task 已经通过 `runtimeEventSink` 发 `workflow.*`，本任务不应把它误删；可以继续作为 domain event，但不应和 assistant transcript 混用。
- 事件量会增加，尤其 token delta。后续可做 delta batching，但本任务先保证语义正确。

## 验收标准

- TUI 发送消息时能看到真正流式输出。
- 工具调用开始、输入、结果都能显示。
- session 切换后不会因为缺 runtime 临时事件而显示空白或长期 busy。
- `/new` 后进入新会话起始状态，不是空白 busy 对话页。
- 第二个客户端 attach 后能从 session snapshot + 其后的 SSE live 恢复当前消息和工具状态。
- event reducer 是 TUI/Web/Desktop 的共同状态来源。
