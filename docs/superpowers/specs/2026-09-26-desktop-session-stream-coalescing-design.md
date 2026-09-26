# 桌面会话流式更新合并设计

> 状态：已实施（2026-09-26，阶段一）。仅覆盖 Electron 桌面端主进程向渲染进程推送会话状态的路径；不改协议、不改 daemon、不改 CLI/TUI。

## 目标与现状

现象：会话大量输出时桌面端整体卡顿——右侧/文件 tab 的文件树打不开、刷新一直转圈，点设置页迟迟不跳转；输出放缓或结束后立刻恢复。

现状（代码依据）：

- 每个模型文本 delta 生成一条 `session.message.part.delta`（`packages/services/src/conversations/incremental-output.ts:14`）；SSE 每条事件立即推送，无合并（`packages/server/src/http/routes/events.ts:88-105`）。
- 桌面主进程每收到一条 live 更新就调用 `toDesktopSessionView()` 构造整份会话视图（复制并排序全部 inputs/messages/parts），再 `webContents.send`（`apps/desktop/src/main/features/session/session-subscription-service.ts:163-169`、`185-206`）。打开会话返回的快照走 `openSession` 返回值，不重复计。
- 客户端 `syncEvents` 只在 live 事件使状态发生变化时 yield（`packages/client/src/state/sync.ts:148-151`）；渲染端每条都 `applySessionUpdate`（`apps/desktop/src/renderer/src/stores/desktop-session/session-view-actions.ts:28`），订阅整份 `sessionView` 的会话页随之整页重渲染，并顺带发一次 `refreshGoal` IPC（`apps/desktop/src/renderer/src/stores/desktop-session/store.ts:117-120`）。

结果：IPC 频率与包体大小由模型吐字速度决定；主进程和渲染进程持续无空档，`workspace.listFiles` 回包、路由跳转等其它工作只能排队到输出放缓。

## 选择及其边界

选择：在桌面主进程按固定时间窗合并会话更新（throttle）：首次入队启动窗口定时器，窗口内后续入队只覆盖最新 state、不重置窗口；窗口到点才构造一次视图并发送。每条消息本身是整份快照，丢弃中间帧不丢数据。

边界：只动桌面主进程的会话订阅推送；不改 SSE/协议/daemon/客户端 reducer/CLI/TUI；不改渲染端组件结构；不引入依赖、不新增用户设置；窗口用常量（默认 50ms），仅测试可注入；`GlobalActivitySubscriptionService` 推的是增量事件，不合并。

其他做法不采用：渲染端节流（主进程仍会做无谓的全量视图构造）、协议级 delta（改动过大，留作后续阶段）、daemon 侧合并（影响所有客户端，而现象只在桌面端）。

## 行为契约

1. 频率：固定窗口节流（非 debounce）。稳态流式下同一订阅任意两次发送间隔 ≥ 窗口（默认 50ms，≤20 次/秒）；重连的强制 `flushNow` 不受此约束。持续输出时每窗口最多一次。
2. 内容：每次发送都是刷出时刻的最新整份视图，不发送过期于最后入队 state 的视图。
3. 终态不丢：任一窗口必有一次 trailing 刷出；只有订阅真正结束（切会话/删除/窗口销毁）才丢弃挂起状态。
4. 重连：收到 reconnecting（`SyncEventUpdate.source === "reconnecting"`，由 `onUpdate` 交付）或订阅迭代器结束时，用 `flushNow` 立即以最近一次 state 以 reconnecting 语义发送（`flushNow` 会取消挂起窗口），保持顺序；实例保持可复用，不 `dispose()`。
5. 竞态与失效：订阅结束时通过 abort signal 触发 `dispose()`，停止后续发送。定时器回调刷出与 `flushNow` 共用同一个由 `pumpSession` 注入的 `send` 校验：`webContents.isDestroyed()`、订阅仍 current、且 `state.buckets[sessionId]?.session` 仍存在；任一不满足即静默丢弃，避免向已删会话发送或在 `setTimeout` 里抛错。
6. CPU：本阶段只把 `toDesktopSessionView()` 从每事件一次降为每窗口一次，从而减少主进程视图构造、IPC 与渲染端整页重渲染；客户端 `syncEvents` reducer 仍逐事件运行，这部分 CPU 不在本阶段优化。

## 连带影响与已知取舍

- `refreshGoal`（`apps/desktop/src/renderer/src/stores/desktop-session/store.ts:117-120`）改为尾延防抖（约 1s），保留现有单飞。代价：只要流式更新间隔持续小于 1s，goal 状态要等输出出现空档才刷新（此前是每条更新一次）；goal 变化由事件驱动，run 结束或用户操作也会触发刷新，接受这一取舍。防抖按 sessionId 记录，不随切换会话取消，旧会话的刷新最多晚 1s 到达且只写 `goalsBySession[旧 id]`，无副作用。
- reconnecting 帧可能经 `onUpdate` 与迭代器结束两条路径各发一次；两次内容相同、cursor 单调，按幂等处理。
- `applySessionUpdate` 用「上一份视图有 running run、下一份变终态」判定 run 结束并刷新上下文用量（`apps/desktop/src/renderer/src/stores/desktop-session/session-view-actions.ts:36,87-101`）。合并窗口理论上可能让一个 run 的首个交付状态就已经是终态（run 在单个窗口内起止），从而漏一次刷新。实际 agent run 远长于 50ms，且现有 `didActiveRunFinish` 已明确忽略「上一份视图未见过的新终态 run」（`apps/desktop/src/renderer/src/stores/desktop-session/session-view-actions.context-usage.test.ts:52-57`）；本阶段不改变这一语义，接受这一可忽略的理论边界，并在验收里记录。

## 实现位置

- 新增 `apps/desktop/src/main/features/session/session-update-coalescer.ts`：纯窗口合并器，暴露 `queue(state, source)`、`flushNow(state, source)`、`dispose()`；不 import Electron。是否允许发送的校验由 `pumpSession` 注入的 `deliver` 统一负责（`isDestroyed`/`isCurrent`/session 存在，并吞掉窗口销毁瞬间的 `send` 异常），定时器刷出与 `flushNow()` 共用。
- 修改 `apps/desktop/src/main/features/session/session-subscription-service.ts`：`pumpSession` 的主/辅订阅都用合并器；构造函数可选注入窗口毫秒数；重连与迭代器结束走 `flushNow()`；订阅结束走 `dispose()`。
- 修改 `apps/desktop/src/renderer/src/stores/desktop-session/store.ts:117-120`：`refreshGoal` 改尾延防抖。

## 验收

1. 长会话（≥100 条消息）长输出期间，主进程 `sessionUpdated` 发送频率 ≤20 次/秒（临时计数确认，不提交）。
2. 同场景下开文件树、点设置页 1s 内响应，不再卡到输出结束。
3. 流式文本仍连续更新；结束后终态与 daemon 一致（cursor、最后一条 part 文本）。
4. 切会话/删除会话/窗口关闭：不出现向已销毁窗口发送、不出现 cursor 倒退、不出现向已删会话的发送。
5. 主/辅订阅都被合并；打开会话的返回快照与首个 live 刷出顺序无回归。
6. 新增合并器单测与订阅服务（主+辅+重连+删除竞态）测试通过；`apps/desktop` 单测与 typecheck 通过；`node scripts/check-docs.mjs` 通过。

## 风险

- dev 模式 `StrictMode`（`apps/desktop/src/renderer/src/main.tsx:14`）双渲染，整体仍比打包版重；验收需在打包版确认。
- 超长会话单次视图构造本身仍可能重；若阶段一后仍卡，进入阶段二（渲染端 memo/延迟渲染/拆分流式切片），本设计不含。

## 本阶段不做

- 协议级 delta 载荷 / 按 cursor 增量拉取。
- transcript 虚拟化、`React.memo`、`useDeferredValue` 等渲染端改造。
- daemon 或 CLI/TUI 侧的更新合并。
- 把 50ms 做成用户可配项。
