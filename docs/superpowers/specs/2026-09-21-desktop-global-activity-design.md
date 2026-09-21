# Desktop 全局后台活动感知与未读状态设计

## 目标

Desktop 使用一条全局 durable event 订阅，持续感知所有 Session、IM、Permission 和 ScheduledRun 的后台变化。当前页面只负责展示详情，不再决定 Desktop 能否看见后台活动。

第一阶段交付：

- 非当前会话的运行、完成、失败、中断和等待权限状态；
- 会话级本机未读和打开会话自动已读；
- IM 新会话自动进入侧边栏；
- Scheduled 入口的运行状态与未读数量，以及打开单个任务详情自动已读；
- 按现有通知设置发送一次系统通知；
- 初始 replay、断线补齐和重复事件不产生重复通知；
- 保持当前会话完整 transcript 的订阅路径不变。

完整 Activity 收件箱面板是第二阶段，本阶段只把数据模型和 IPC 保持为可直接复用的形状。

参考语义来自 [OpenAI 官方 Notifications](https://learn.chatgpt.com/docs/notifications) 与 [Scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app)：Activity 展示未读、运行中和等待回复；Scheduled 同时是运行结果收件箱。此处只借鉴信息层级，不照搬完整界面或通知开关。

## 已验证的现状

- `packages/client/src/state/sync.ts` 的无 `sessionId` 路径已经支持全局 replay、SSE live、cursor、gap catch-up、重连和 seq 去重。
- Desktop main 的 `SessionSubscriptionService` 只维护 primary / auxiliary 的指定会话订阅。
- renderer 只有一个完整 `sessionView`，并通过 `acceptActiveSessionView()` 丢弃非当前会话 view。
- 当前通知观察器只比较 active session 的前后完整 view。
- Session、Run、Task 和 Permission 已写入 durable event；ScheduledTask / ScheduledRun 只写独立 SQLite 表，尚未进入该事件流。
- Scheduled 页面每 20 秒轮询，并在组件内使用临时 `Set` 去重通知；页面未挂载时无法工作。
- `ScheduledRun.unread`、`listRuns({ unread: true })` 和 `setRunUnread()` 已存在，应继续作为 Scheduled 未读真相源。
- Sidebar 展开 IM 分区时调用 `refreshBootstrap()`，说明新 IM 会话目前依赖主动刷新。
- 工作区已有与本任务无关的 `README.md`、`docs/channels-flow.md`、`scripts/client-public-api-contract.json` 修改；实施时不触碰、不暂存它们。

## 方案选择

采用“扩展现有 durable event 流”的方案：ScheduledRun 也写入全局事件序列，Desktop main 复用 `syncEvents(client, {})`，renderer 消费轻量 Activity 协议。

不采用以下方案：

- Scheduled 单独轮询：会形成第二套重连、去重和通知逻辑，且页面关闭时仍有延迟。
- renderer 直接连接 daemon：会把连接生命周期和 daemon 协议泄漏到 UI 层，也更难保证 Electron 重挂载时只有一条订阅。
- 为每个会话建立订阅：不必要地放大连接数，并复制已有全局事件能力。

## 总体架构

```text
daemon repositories
  ├─ Session / Run / Task / Permission durable events（现有）
  └─ ScheduledRun durable events（新增，同事务）
             │
             ▼
syncEvents(client, {})
  initial replay → baseline marker → live / gap replay
             │
             ▼
Desktop main GlobalActivitySubscriptionService
  每个 webContents 一条订阅、generation、AbortController、归一化
             │ activity snapshot / delta
             ▼
preload activity.onUpdated(listener)
             │
             ▼
renderer Activity slice
  ├─ Sidebar session / IM 状态
  ├─ Scheduled 入口 badge / running
  ├─ 本机 Session read watermark
  └─ 通知 effect

现有 primary session subscription → session:updated → 单个完整 sessionView（保持不变）
```

## Durable 事件

新增三种最小事件：

- `scheduled.run.created`，payload 为 `{ run: ScheduledRunRecord }`；
- `scheduled.run.updated`，payload 为 `{ run: ScheduledRunRecord }`。
- `scheduled.task.deleted`，payload 为 `{ taskId: string }`；删除 task 及其 runs 后同事务写入，用于清理全局 Activity 中的旧运行状态和未读计数。

两种事件均为 global scope，不填写顶层 `sessionId`；`taskId`、`runId` 和可选的会话 ID 从 `payload.run` 中读取。事件携带完整、轻量的 ScheduledRun 记录，避免 delta patch 对顺序和缺省字段产生额外复杂度。

`ScheduleRepository` 的创建、更新、关联会话和 daemon 重启中断操作改用共享 `storage.atomic()`。Scheduled 表更新和 `appendEvent()` 在同一事务内完成；事务提交后通过现有 `SessionEventPublisher.publishSince(previousSeq)` 广播。批量重启中断为每个被改变的 run 追加一条 updated 事件，不能只发聚合计数，否则 renderer 无法精确收敛。`scheduled.run.updated` 携带 `previousStatus`，用于区分真正的状态跃迁和重复写入。

ScheduledTask 的创建与编辑不进入 Activity；删除需要事件来移除旧 run。任务列表继续通过现有 API 获取，只在 run 的 ID/状态变化或 task 删除时合并刷新；当前任务的运行详情按需加载，已读变更不再触发整页请求。请求失败时退避重试，旧请求不能覆盖较新的结果。

## `syncEvents` 基线协议

全局 `syncEvents` 在初始 replay 完成后额外 yield 一次无 event 的 `{ state, source: "snapshot" }`。指定 session 的 snapshot 行为不变。

Desktop main 据此区分：

- `replay` 且尚未看到 snapshot：初始历史重建，只累积状态；
- `snapshot`：发布一次 Activity baseline；
- `live`：发布可产生未读和通知的 delta；
- baseline 之后的 `replay`：断线 gap catch-up，更新状态和未读，但禁止补弹系统通知；
- `reconnecting`：只更新连接状态，不改变业务状态。

这避免 main 自己重新实现 list + stream 之间的无缝切换。

## Activity IPC 协议

共享类型：

```ts
type DesktopExecutionState =
  | "idle"
  | "running"
  | "needs_input"
  | "completed"
  | "failed"
  | "interrupted"

type DesktopAttentionState = "read" | "unread"
type DesktopActivityDelivery = "baseline" | "live" | "catchup" | "reconnecting"

interface DesktopSessionActivity {
  session: DesktopSessionRecord
  executionState: DesktopExecutionState
  attentionState: DesktopAttentionState
  activitySeq: number
  updatedAt: number
  runId?: string
  permissionId?: string
  error?: string
}

interface DesktopScheduledActivity {
  taskId: string
  run: DesktopScheduledRun
  executionState: DesktopExecutionState
  attentionState: DesktopAttentionState
  activitySeq: number
  updatedAt: number
}

interface DesktopActivityUpdate {
  cursor: number
  delivery: DesktopActivityDelivery
  sessions: DesktopSessionActivity[]
  scheduled: DesktopScheduledActivity[]
}
```

baseline 可以带全部摘要；后续 update 只带被当前 event 影响的对象。IPC 不携带 messages、parts 或完整 transcript。

preload 暴露 `window.desktop.activity.onUpdated(listener): () => void`。取消函数必须移除同一个 wrapped listener，并由契约测试覆盖。

## main 订阅生命周期

新增 `GlobalActivitySubscriptionService`，与现有 Session subscription service 并列：

- owner key 为 `webContents.id`，同一 owner 再次 open 时复用已有订阅；
- 每个 owner 保存 AbortController、generation 和最后发送 cursor；
- `webContents.destroyed`、Desktop shutdown 或显式 close 时 abort；
- daemon client 替换或重连时递增 generation，旧 iterator 的回调先检查 generation；
- 当前会话切换不触碰全局订阅；
- `syncEvents` 已处理 SSE 断流、gap 和重复 seq，service 不再维护第二套 event bus 或连接算法。

renderer 的 `attachDesktopSessionEvents()` 继续使用已有引用计数抵抗 React StrictMode；首次引用同时订阅 Activity IPC，最后一次 detach 时移除 listener。main subscription 的创建由显式 `activity.open` invoke 保证幂等，不由 React listener 数量隐式控制。

## 状态归一化

归一化器是纯函数，输入一条 durable event 和对应的 client state bucket，输出受影响的 Activity 摘要。

Session 规则：

- 存在 pending permission：`needs_input`；
- 否则最新 run 为 pending / running：`running`；
- 最新 run 为 failed：`failed`；
- 最新 run 为 interrupted：`interrupted`；
- 最新 run 为 completed：`completed`；
- 没有相关 run：从 session status 映射为 `running`、`failed` 或 `idle`。

Permission 优先于 run，确保等待授权不会被 running 覆盖。Task 事件会推进 session 的 `updatedAt`，但第一阶段不单独给 task 建 UI 项。

Scheduled 规则：

- queued / running → `running`；
- needs_attention → `needs_input`；
- succeeded / skipped → `completed`；
- failed → `failed`；
- interrupted → `interrupted`。

`attentionState` 独立计算。显示 selector 使用以下优先级：

1. needs_input；
2. failed / interrupted；
3. running；
4. completed + unread；
5. idle。

已读后的 completed 不再显示强调；已读后的 failed / interrupted 可以保留图标和文字语义，但去掉未读强调。

## Session 未读水位

Session 未读是单设备 Desktop 视角，保存在 renderer `localStorage`：

```ts
interface PersistedActivityStateV1 {
  version: 1
  lastObservedCursor: number
  lastNotifiedCursor: number
  readSeqBySessionId: Record<string, number>
}
```

规则：

- 首次使用且无持久状态：baseline 中所有现存活动视为已读，并把 `lastObservedCursor` 设为 baseline cursor；
- 后续启动：保留已有未读；关闭期间 seq 大于 `lastObservedCursor` 的终态或 needs_input 事件标为未读，但不补弹通知；首次 replay 要按 seq 重建这些变化，不可仅用最终 snapshot 推断全部历史；
- live 中，非当前会话的 terminal 或 needs_input 事件将 attention 设为 unread；running 本身不制造未读；
- 当前会话成功取得并接受 view 时，把 watermark 推进到该会话最新 activity seq；保持打开期间同步推进；仅有 `activeSessionId`、正在打开或打开失败不算已查看；
- 未读以最近一次需关注事件的 seq 与 read watermark 比较；即使随后开始新一轮运行，也不能自动清除旧结果的未读；
- 打开会话的动作在成功接受对应 session view 后执行清除，避免打开失败却误标已读；
- 删除会话时清除对应 watermark，防止无限增长；归档会话保留水位以免恢复时重报历史；持久状态解析失败时安全回退到首次基线语义。

不修改核心 Session 数据模型，也不做多设备同步。

## Scheduled 未读

Scheduled 的 `run.unread` 是唯一真相：

- terminal / needs_attention 状态由 daemon 写 `unread: true`；
- Activity 直接投影该字段；
- 打开 Scheduled 列表不清除；
- 选中某个 task detail 后，只对该 task 当前未读 runs 调用 `setRunUnread(run.id, false)`；
- setRunUnread 产生 `scheduled.run.updated`，全局 Activity 自动降低 badge，无需手工修补两份状态；
- 页面仍可在首次挂载时获取 task 列表和所选 task 的历史 runs，但删除 20 秒主轮询。断线时仅保留用户点击刷新和一次低频恢复兜底，不承担通知职责。

## 通知

通知由 renderer Activity effect 统一触发，替换 active-session observer 和 Scheduled 页面 observer。纯 reducer 返回“状态变化 + 可选通知意图”，副作用层再读取现有 `notificationMode` 并调用 tray。

可通知事件：

- 非当前会话 active → completed / failed / interrupted；
- 非当前会话首次出现 pending permission；
- ScheduledRun 首次进入 succeeded / failed / interrupted / needs_attention / skipped。

约束：

- 当前正在查看的会话始终不弹，包括 `always`；
- 正在查看的 Scheduled task 不弹该 task 通知；
- `never` 不弹；`when_unfocused` 沿用 tray 当前聚焦判断；`always` 仅允许应用聚焦时提醒后台对象；
- 只有 `delivery: live` 具有通知资格；baseline 和 catchup 禁止通知；
- reducer 先检查全局 seq，重复 seq 不改变状态；`lastNotifiedCursor` 持久化，进程重启不重复通知；
- Scheduled 额外以 `run.id + status` 验证终态跃迁，避免同一 run 的重复 updated 事件重复通知。

## UI 投影

会话行复用一个小型 `ActivityIndicator`：

- running：spinner 或动态点，尊重 reduced motion；
- needs_input：琥珀色图标和“等待处理”可访问文本；
- completed + unread：蓝点和“有新结果” aria-label；
- failed / interrupted：红色图标，并用文字或 aria-label 表达状态；
- 不能只靠颜色。

同一组件用于项目、最近和 IM 会话。收到 `session.created` / `session.updated` baseline 或 delta 时，全局 store upsert `DesktopSessionRecord`，沿用现有 `upsertSession` 排序，因此新 IM 会话无需展开分区或刷新；IM 分区不提供手动刷新按钮，展开分区也不触发 `refreshBootstrap`。

Scheduled 导航项显示总 unread badge；存在 queued / running run 时显示轻量运行标识。Scheduled 页面从 Activity slice 获取 status 和 runningTaskIds，task / run 详情仍通过现有 schedule API 加载。

## 错误与恢复

- Activity 连接错误只把 sync 状态置为 reconnecting，不清空最后可用摘要。
- daemon 重启后 `syncEvents` 从 cursor 续传；gap replay 收敛状态和未读，不补弹通知。
- Scheduled 事件与表更新同事务，广播失败不丢事件；下次 replay 可补齐。
- renderer 收到 cursor 小于或等于已应用 cursor 的 update 时忽略。
- 未知事件类型由 client reducer安全保留 cursor；Activity 归一化器返回无变化。
- 本地持久化写失败不阻断聊天，仅失去跨重启的 Session 已读记忆。

## 测试策略

按 TDD 分层覆盖：

1. client sync：全局初始 replay 后产生 snapshot marker；gap replay 仍标为 replay；abort 和重复 seq 保持现有行为。
2. ScheduleRepository / ScheduledTaskService：created、running、linked、terminal、重启 interrupted、read 变化都写 durable event；事务失败不留下半套状态；发布从旧 cursor 开始。
3. main subscription：每 owner 单例、destroy abort、generation 防旧结果、daemon 重连、gap、unsubscribe；IPC 只发送轻量摘要。
4. Activity 纯 reducer：非当前 completed / failed / permission、当前会话无未读、首次 baseline、关闭期间 catchup、重复 seq、状态优先级。
5. preload：订阅和取消使用正确 channel / wrapped listener。
6. store / UI：打开会话清未读；新 IM 自动 upsert；StrictMode 只有一条订阅；Sidebar 状态与 aria-label；Scheduled 页面未挂载时 badge 更新；打开 task 只清该 task。
7. 回归：active session transcript `session:updated`、通知设置和现有 Scheduled CRUD / detail 继续通过。

最终运行受影响测试、Desktop node/web typecheck、文档检查和架构边界检查。完整仓库测试仅在受影响检查无法覆盖跨包风险时运行。

## 非目标与刻意省略

- 不实现完整 Activity 面板；
- 不修改 Session / Run 核心数据模型；
- 不引入新状态管理库、消息队列或 WebSocket；
- 不建立每会话订阅；
- 不做移动端或多设备已读同步；
- 不重做 Sidebar 视觉；
- 不把所有后台 Job 纳入 Activity；
- 不删除 Scheduled 手动刷新能力，只移除其作为主事件链路和通知来源的职责。

## 架构加固（审核后确认）

- 会话树删除必须在删除事务内写一个 global `session.deleted` 事件，payload 含全部被删除的 session IDs；提交后经现有 publisher 广播。全局 Activity 的 main 摘要与 renderer 列表、水位都消费同一删除事件，baseline 也携带删除 ID，窗口重挂载不能复活已删除会话。按会话 SSE 的 live 过滤 global 事件，因此由全局 Activity 在 main 通知对应 owner 关闭匹配的 primary/aux 订阅。
- 全局 Activity 继续使用 `syncEvents` 的 replay、SSE、cursor、gap 与重连，但传入轻量事件归纳函数；main 不再长期保留消息、parts 与 `eventsBySeq`。当前会话的完整 transcript 仍使用原有 primary subscription。初次 HTTP replay 仍会读取保留期内的原始事件；若实测启动耗时成为瓶颈，另做服务端 Activity snapshot，不在本轮造第二条传输。
- Scheduled 列表只保留一条带版本检查和失败退避的刷新协调路径；选中任务详情独立加载。状态/删除事件触发列表刷新，纯已读事件不触发；手动刷新和事件刷新不得互相覆盖。保持 daemon `ScheduledRun.unread` 为唯一已读真相。
