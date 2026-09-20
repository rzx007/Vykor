# 压缩分割线合并与运行韧性设计

## 问题

2026-09-20 会话 `63ab048d` 复现：用户编辑消息重发后，run 内部触发自动压缩，界面在「正在压缩上下文 / 已压缩上下文 / 正在处理」处长时间不动，直到 run 结束才恢复。

已确认的事实（来自服务端数据库与代码）：

1. 自动压缩发生在 run 内部（`query-engine.ts` 每轮开头调用 `compactService.autoCompact`）。服务端写两条 system 消息：`compact_start` →「正在压缩上下文」，`compact_end` →「已压缩上下文」（`daemon-agent-event-projector.ts:155-172`）。
2. 桌面端把「用户消息 + 该轮全部助手输出」合成一个渲染条目，排序键取**用户消息的 createdAt**（`conversation-turn-model.ts:54,122,132`）。压缩消息在用户消息投影后约 120ms 才写入，于是分割线排序在整轮内容**之后**。
3. 真实数据重放（会话 `63ab048d`）最后三个渲染条目：

   ```
   03:10:48.773  turn   input=a86cec5a  assistantMsgs=41   ← 该轮全部输出在这里
   03:10:48.893  system #272 正在压缩上下文                 ← 排在整轮下面
   03:11:12.840  system #273 已压缩上下文
   ```

   消息列表停在底部，新内容全部插到分割线上方，用户看不到，直到 run 结束 spinner 消失。同一会话 02:40–02:45 有同样的排列。
4. 这次 run 本身正常：11:10:48 开始，压缩 24 秒（90551 → 4087 tokens），随后 12 分钟工具执行，11:23:02 正常 completed。慢来自工具等待，不是压缩。

另外两处真实韧性缺口（本次一并处理）：

- 桌面端事件订阅（SSE）静默挂起或 pump 抛错时，UI 会永久停在最后一帧（`session-subscription-service.ts:140-144` 只打日志后退出；`packages/client/src/state/sync.ts:86-127` 只在 socket 报错/结束时重连）。
- 服务端没有任何 run 无进展超时；模型流卡死时 run 会永远等下去，UI 永远「正在处理」。

## 目标

- 同一次压缩在正文只显示一条分割线，开始时显示「正在压缩上下文」，完成后原地变为「已压缩上下文」，失败变「上下文压缩失败」。
- 分割线渲染在它发生的那一轮内部：用户消息之后、压缩之后的助手内容之前；一轮内多次压缩按发生位置分别插入。
- 只写了「开始」且当前没有运行中的 run 时，显示「上下文压缩已中断」，不再转圈。
- 桌面端会话事件流异常中断后能自动重建订阅并续传，无需重启应用。
- 服务端 run 超过阈值无任何进展时自动中断，并给出可读原因，让界面从「正在处理」变为明确的结束状态。
- 以上全部为显示与韧性修复，不改变压缩策略、事件协议与数据模型。

## 实施拆分与顺序

三个方案相互独立、各自可单独验证与回滚，实施计划按此拆成三段，每段内部走「先失败测试 → 最小实现 → 全绿」：

1. 方案 A（桌面渲染层，修复本次现象）；
2. 方案 B（客户端 + 桌面主进程事件流韧性）；
3. 方案 C（服务端 run 看门狗）。

每段完成后单独 review，再进入下一段；全部完成后再做整体验证。

## 非目标（本次明确不做）

- 不修改服务端压缩阈值、分层策略、摘要提示词、附件注入。
- 不重构 turn model 之外的前端状态管理；不改动 transcript 的虚拟滚动实现。
- 不新增用户可配置项或设置界面；阈值用常量，测试可注入。
- 不改事件协议、不改数据库 schema、不做数据迁移。
- 不优化「工具等待本身太久」（JobWait 轮询 240s 等），那是独立话题。
- 不做 Electron 进程级监控、崩溃上报、全局健康检查接口。

## 方案 A：压缩分割线合并与定位（桌面渲染层）

### 现状

`buildConversationEntries(messages, parts, runs)` 产出 `(turn | system)[]`，按 `createdAt` 排序；`transcript.tsx` 把每条 system 消息渲染成独立 `MessageScrollerItem`，把每轮渲染成「用户消息 + 一个 AssistantMessage」。

### 设计

1. **只渲染一条**：在 turn model 中把连续的压缩分割线配对：
   - 迭代按消息 seq 排序后的 system 消息，识别 `metadata.presentation.kind === "context_compaction"`。
   - 若当前是 `started`，且紧随其后的下一条压缩消息是 `completed` 或 `failed`，合并为一条，**phase 取后者**，**位置取前者**（保证完成后分割线不跳位）。
   - 未配对的 `started` 保留为一条。
2. **归属到轮次**：分割线不再作为顶层 system 条目（仅限 `context_compaction`；`model_switch` 等其他 system 消息行为不变）。归属规则：
   - 若存在「当前轮次」（`latestTurn`，且其用户消息 seq < 分割线消息 seq），收进该轮次的 `blocks`。
   - 否则（例如手动 `/compact` 后尚无新轮）保持顶层 system 条目，位置与现在一致（末尾）。
3. **轮内定位**：该轮的助手消息按**消息 seq**（不是 part seq，两者是独立序列）分成若干段；分割线按 `divider.message.seq` 插入对应段之间。
4. **中断态**：若一条 `started` 分割线没有配对的结束消息，且 `runs` 中没有任何 `pending/running` 的 run，则渲染 phase 为 `interrupted`（文案「上下文压缩已中断」）。有运行中的 run 时仍是 `started`（转圈是正确的进行中状态）。

### 数据流

```
服务端两条 system 消息（不改）
  → 客户端 reducer 照常入库（不改）
  → buildConversationEntries：配对 + 归属 + 按 seq 插入轮内
  → transcript.tsx：用户消息 → blocks（助手段 / 分割线）→ 最后一段带 streaming
  → ContextCompactionDivider：按 phase 渲染图标与文案
```

### 数据结构（渲染层，新增/变更）

- `ConversationTurn` 新增 `blocks: TurnBlock[]`，`TurnBlock = { kind: "assistant"; messages; parts } | { kind: "divider"; message; parts; phase }`，按内容 seq 排序。
- `ContextCompactionPhase` 增加 `"interrupted"`（仅渲染层使用，不写回服务端）。
- `transcript.tsx`：把原来单个 `AssistantMessage` 拆成按 `blocks` 渲染的多段；`streaming` 与 `AssistantMessageActions` 只挂在最后一段；用户消息仍在最前。
- 归属回退：`latestTurn` 无 `userMessage`（partial snapshot）时，分割线按消息 seq 顺序作为顶层 system 条目保留，不强行归轮。

### 涉及文件

- `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/conversation-turn-model.ts`
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/transcript/transcript.tsx`
- `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/context-compaction-divider.tsx`
- 对应测试：`message/__test__/conversation-turn-model.test.ts`（新增用例）、必要时新增组件级测试

## 方案 B：桌面端事件流断流兜底

### 现状

- `sync.ts` 的 `liveWithReconnect` 只在流抛错/结束时重连；socket 活着但不再产生事件时不会重连，UI 永久停住。
- `pumpSession` 抛错后只 `console.error` 并退出，之后不会重建订阅。

### 设计（最小改动，不改协议）

1. **静默检测（传输层，按原始 SSE 帧判活）**（`packages/client/src/transport/sse-transport.ts`）：
   - `SseStreamOptions` 新增可选 `idleTimeoutMs`；启用后为当前连接建一个内部 AbortController，并记录最后一次收到**任意原始帧**的时间（注释/keepalive 帧也算，`parseRawSseFrame` 已能解析）。
   - 超过 `idleTimeoutMs` 没有任何帧 → abort 当前响应，流按「干净结束」返回；调用方自行决定是否重连。
   - 只有 `EventResource.stream`（会话事件流）传入该选项，默认 60s（服务端每 15s 发一次 keepalive，正常情况不会触发）；terminal / attachment 等其他 SSE 消费方行为不变。
2. **重连时重新取快照**（`packages/client/src/state/sync.ts`）：
   - 会话路径的 `liveWithReconnect` 在重连前重新执行 `client.sessions.getState`，把结果作为 `source: "snapshot"` yield；这样 `syncStatus` 从 `reconnecting` 恢复为 `connected`，同时补齐缺口事件。
   - 只在发生重连时付出快照成本，正常连接不额外请求。
3. **桌面主进程重建订阅**（`session-subscription-service.ts`）：
   - `pumpSession` 改为循环：迭代器异常结束后按退避（250ms 起、上限 30s）重建订阅（重新走 `syncEvents`，先取快照天然补状态），并在重建期间向渲染进程推送 `syncStatus: "reconnecting"`。
   - 重建时同步更新 `SessionSubscriptionRegistry`，保证 `isCurrent` 判定与替换/关闭语义不变；`controller.aborted` 或窗口销毁时停止循环。
   - 为可测试性，把「带退避的重建循环」抽成不依赖 Electron 对象的纯函数/小类，service 只负责接线与推送。

### 为什么不做「按数据事件静默」判活

工具执行、子 Agent、长时间命令期间可能几十秒没有 data 帧，但 keepalive 帧一直存在；按 data 事件判活会误判并导致 UI 反复进入「正在重连」。因此判活以原始帧为准，且阈值取 keepalive 周期的 4 倍（60s）。

### 数据流

```
pumpSession 循环
  → syncEvents（snapshot → live；重连前重新 snapshot）
  → 传输层 60s 无帧 → 流干净结束
  → syncEvents 重连（重新快照，syncStatus 恢复 connected）
  → 迭代器异常 → 主进程退避重建 → 继续推送 view
```

### 涉及文件

- `packages/client/src/transport/sse-transport.ts`（+ 新增 `transport/__test__/sse-transport.test.ts`）
- `packages/client/src/resources/event-resource.ts`（透传 `idleTimeoutMs`）
- `packages/client/src/state/sync.ts`（重连重取快照；+ 新增 `state/__test__/sync.test.ts`）
- `packages/client/src/types/index.ts`（`EventSyncOptions` 增加 `idleTimeoutMs`）
- `apps/desktop/src/main/features/session/session-subscription-service.ts`（+ 新增/扩展单测）

## 方案 C：服务端 run 无进展看门狗

### 现状

run 卡在模型流或工具上时没有任何超时；`SessionRunExecutor` 只 `await run.result`，永不 settle 就永不结束。

### 设计（最小、可测、低误判）

1. **活动判据（轮询，不新增事件管道）**：新增 `RunStallWatchdog`（`packages/server/src/application/session/run-stall-watchdog.ts`），由 `SessionRunExecutor` 在 run 启动时创建、settle 时销毁。周期（默认 30s）检查：
   - `lastActivity = max(run.updatedAt, 该 run 关联 task 的 updatedAt)`；
   - 流式输出期间 `run.updatedAt` 持续更新；后台命令 / JobWait 期间 task 心跳（`updateSessionTask` 每次都会 bump `task.updatedAt` 并发事件）持续更新；
   - 同步工具受既有 5 分钟工具超时约束，小于看门狗阈值。
2. **豁免（避免误杀健康 run）**：
   - 该 run 存在 `pending` 权限请求（用户在别处、等授权）：视为活动，不判停；
   - 该 run 存在 `running` 的子智能体 task（`childSessionId` 非空）：视为活动，不判停；子 run 自身由它所在会话的看门狗负责。
3. **触发**：`now - lastActivity > staleRunTimeoutMs`（默认 10 分钟）→ `run.interrupt("运行超过 N 分钟无进展，已自动终止")`。`run.result` 随即 settle，走既有 interrupted 落库与事件路径，前端 spinner 消失并显示原因。
4. **阈值与周期**：`staleRunTimeoutMs` 默认 600000、`watchdogIntervalMs` 默认 30000，作为 executor 选项可覆盖（测试注入短值）。不做用户配置项。
5. **边界**：仅对已 started 的 run 生效；pending（排队）run 不参与；压缩摘要期间无事件但远小于阈值。

### 接线点

- `SessionRunExecutorContext.data` 的 `Pick` 增加 `permissions`（用于 pending 权限豁免）；`runs.listSessionTasks` 已在 `data.runs` 中。
- `packages/server/src/application/daemon-application.ts` 中构造 `SessionRunExecutor` 的地方补 `permissions` 依赖与看门狗选项。

### 数据流

```
SessionRunExecutor 启动 run → 创建 RunStallWatchdog（注入 clock/interval）
每 30s：读 run.updatedAt / task.updatedAt → 有活动则刷新
  无活动：pending 权限？有 running 子任务？→ 豁免
  否则超过 10 分钟 → run.interrupt(可读原因)
run settle → watchdog.dispose()（清定时器）
```

### 涉及文件

- 新增：`packages/server/src/application/session/run-stall-watchdog.ts`
- `packages/server/src/application/session/session-run-executor.ts`（创建/销毁 + 依赖与选项）
- `packages/server/src/application/daemon-application.ts`（接线）
- 新增/扩展单测：`session/__test__/run-stall-watchdog.test.ts`、`session-run-executor.test.ts`

## 测试

- **A**（`conversation-turn-model.test.ts`）：
  1. 自动压缩两条消息合并为一条，位置在该轮助手内容之前；
  2. 一轮中间压缩：分割线夹在两段助手内容之间；
  3. 只有 `started` 且无活跃 run → `interrupted`；有活跃 run → `started`；
  4. `model_switch` 等其他 system 消息仍是顶层条目且顺序不变；
  5. 现有用例（含「keeps system messages independent」）继续通过。
- **B**：
  1. 传输层：超过 `idleTimeoutMs` 无原始帧（只有 keepalive 也算有帧）→ 流结束；有 keepalive 时不断流；
  2. 客户端：流结束/抛错后重连时重新 `getState`，yield `source: "snapshot"`，缺口事件被补齐；
  3. 桌面主进程：迭代器异常后重建订阅并继续推送；订阅被替换/窗口销毁后停止重建。
- **C**：
  1. 超过阈值且 run/task 均无更新、无 pending 权限、无 running 子任务 → 触发 interrupt，reason 可读；
  2. run 持续更新（流式）或 task 心跳 → 不 interrupt；
  3. pending 权限 / running 子任务 → 不 interrupt；
  4. run settle 后定时器被清理；
  5. 现有 run executor 测试继续通过。

## 风险与默认值

- 看门狗阈值 10 分钟：流式与后台任务都有更新心跳，同步工具受 5 分钟工具超时约束；剩余风险是「超长且无心跳的自定义工具」，由权限/子任务豁免兜住大部分场景。若仍误判，表现为 run 被中断并显示原因，可通过选项回退。
- 传输层 60s 无帧判活：服务端 keepalive 周期 15s，正常不会触发；只在会话事件流启用，terminal 等流不受影响。
- 重连重新取快照：只在重连时发生，成本一次快照；换来状态收敛与 `syncStatus` 恢复。
- 分割线合并是纯渲染层改动，回滚成本低；服务端历史数据不受影响。

## 验收

- 三个工作流各自「先失败后通过」的单测；相关包 `test` 与 `typecheck` 全绿。
- 打开会话 `63ab048d` 人工确认：02:45 与 03:10 两组历史压缩各显示一条分割线，位置在该轮内容之前/中间；新触发一次自动压缩时新内容在分割线下方实时出现。
- 不产生任何事件协议、数据库 schema、服务端压缩行为的变更。
