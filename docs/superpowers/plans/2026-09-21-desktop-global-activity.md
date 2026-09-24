# Desktop 全局后台活动感知实现计划

> **面向 AI 代理的工作者：** 使用 executing-plans 在当前工作区逐任务执行；每个行为先写失败测试，再实现。不要提交或改动用户已有的无关工作。

**目标：** Desktop 无论停在哪个页面，都及时显示后台会话、IM 和 ScheduledRun 的运行、待处理与未读，并在打开对应详情后清除未读。

**架构：** 复用 client 全局 `syncEvents`；ScheduledRun 追加同事务 durable event；Desktop main 为每个 renderer owner 保持一条全局订阅，通过轻量 IPC 向独立 Activity store 投影。当前会话 transcript 路径保持不变。

**技术栈：** TypeScript、SQLite/better-sqlite3、Electron IPC、Zustand、React、Vitest。

**规格：** `docs/superpowers/specs/2026-09-21-desktop-global-activity-design.md`

---

## 文件职责

- `packages/client/src/state/sync.ts`：全局 replay 完毕发出基线 marker。
- `packages/services/src/schedules/schedule-repository.ts`、`packages/services/src/session-runtime/event-registry.ts`、`packages/services/src/session-runtime/store.ts`：ScheduledRun 事务事件。
- `packages/server/src/daemon/scheduled-task-service.ts`、`packages/server/src/application/daemon-application.ts`：提交后广播与重启收敛。
- `apps/desktop/src/main/features/activity/activity-subscription-service.ts`：每 owner 一条全局流和轻量摘要。
- `apps/desktop/src/shared/activity-types.ts`、`apps/desktop/src/shared/ipc-channels.ts`、`apps/desktop/src/preload/desktop-api.ts`：窄 IPC 契约。
- `apps/desktop/src/renderer/src/stores/desktop-session/activity-state.ts`、`activity-persistence.ts`：纯 reducer、read watermark 和通知资格。
- `apps/desktop/src/renderer/src/stores/desktop-session/store.ts`、`session-actions.ts`：订阅、自动已读与会话列表 upsert。
- `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.tsx`、`scheduled-page/scheduled-page.tsx`：状态投影与 Scheduled 自动已读。

## 任务 1：全局 replay 基线

- [ ] 在 `packages/client/src/state/__test__/sync.test.ts` 写测试：replay 两条事件后收到一次无 event 的 snapshot，再收到 live；sessionId 路径原样。
- [ ] 运行 `pnpm --filter @vykor/client exec vitest run src/state/__test__/sync.test.ts`，确认新测试因缺少 marker 失败。
- [ ] 在 `sync.ts` 的全局 replay 循环后 yield `{ state, source: "snapshot" }`，不改变 live 重连。
- [ ] 重跑目标测试，确认通过。

## 任务 2：Scheduled durable event

- [ ] 在 `packages/services/src/schedules/schedule-repository.test.ts` 写测试：create、running、linked、terminal、read、restart interrupted 每次产生对应可 replay 事件；事务回滚后 run 和 event 都不留下。
- [ ] 跑该文件并确认缺少 `scheduled.run.*` 事件而失败。
- [ ] 在 registry 注册两种 global 事件；ScheduleRepository 通过构造注入 `appendEvent`，在同一 `storage.atomic` 内先写表后追加 `{ run }`，updated 携带 `previousStatus`。store 装配注入 conversations 的 appendEvent；批量中断逐条更新并记录事件。
- [ ] 重跑 repository、event-registry、store 测试，确认通过。
- [ ] 在 `scheduled-task-service.test.ts` 增加测试：每次 run 状态提交后按旧 seq 广播，包含 scheduled 页面未挂载的情形。
- [ ] 在 service 注入 `latestEventSeq` / `onDurableEvent`，对写操作包装 `publishSince`；application 用现有 eventPublisher 注入，重跑目标测试。

## 任务 3：Activity IPC 与 main 进程订阅

- [ ] 在新的 `activity-subscription-service.test.ts` 写测试：每 owner 单例；首批 replay 为 baseline；live 和 gap 分别标记；重复 seq 只发一次；owner destroyed abort；旧 generation 不能发送。
- [ ] 跑新测试，确认因不存在 service 失败。
- [ ] 新增共享 Activity 类型，main service 用 `syncEvents(client, {})`，按 bucket 只归一化受到 event 影响的 session / scheduled run，不发送 transcript。
- [ ] 在 session service 或独立 IPC contribution 注册 `activity:open`，在 preload 提供 `activity.onUpdated`，并补 `desktop-api.test.ts` listener 清理测试。
- [ ] 跑 main / preload 目标测试与 Desktop node typecheck。

## 任务 4：纯状态与通知

- [ ] 在 `activity-state.test.ts` 写测试：running→completed/failed、pending permission、当前会话无未读、初始基线、重启期间 replay、重复 seq、scheduled 多任务分离、状态优先级。
- [ ] 跑新测试，确认缺少纯 reducer 而失败。
- [ ] 实现 activity reducer，`executionState` 与 `attentionState` 分离；read watermark 从版本化 localStorage 加载和保存；通知意图仅由 live 且有新跃迁产生。
- [ ] 重跑目标测试并确认通过。
- [ ] 替换 active session view 和 Scheduled 页面各自的通知观察器；统一从 Activity effect 按现有 notificationMode 通知，测试 `never/when_unfocused/always` 和重启去重。

## 任务 5：store / Sidebar / Scheduled UI

- [ ] 在 store 与 Sidebar 测试写场景：新 IM 事件自动 upsert、非当前会话 unread 与 aria-label、StrictMode 重挂载只有一条全局订阅、打开会话只清其未读。
- [ ] 跑目标测试，确认缺少 Activity store / UI 而失败。
- [ ] 在 `attachDesktopSessionEvents()` 引用计数边界挂 Activity listener；snapshot/delta 更新摘要和 `sessions`；Sidebar 行复用状态 indicator，Scheduled 入口显示 unread badge / running，删除 IM 展开自动刷新。
- [ ] 在 Scheduled 页面测试写场景：页面未挂载 badge 仍变化，列表打开不清，选中 task detail 只清该 task。
- [ ] 跑测试见红；Scheduled 页面从 Activity 获取状态变化、首次列表/详情从 API 加载；移除 20 秒主轮询和组件内通知 Set。
- [ ] 重跑 store、Sidebar、Scheduled 与当前 transcript 同步目标测试。

## 任务 6：核对与独立审查

- [ ] 运行受影响包的测试、`pnpm --filter @vykor/desktop typecheck`、`pnpm check-docs` 和边界检查；完整读取退出码与失败数。
- [ ] 对照规格逐条核对首次 replay、cursor、gap、StrictMode、Scheduled 持久已读和通知一次。
- [ ] 请求独立代码审查，修复重要问题后重新运行相关检查。
- [ ] 用 `git diff` 核对只包含本任务文件；不暂存、不提交用户已有无关改动。

## 架构加固任务 7：会话删除全局收敛

**文件：** `packages/services/src/conversations/conversation-transactions.ts`、`packages/services/src/session-runtime/event-registry.ts`、`packages/server/src/application/session/session-command-service.ts`、`apps/desktop/src/main/features/activity/global-activity-subscription-service.ts`、`apps/desktop/src/shared/activity-types.ts`、`apps/desktop/src/renderer/src/stores/desktop-session/{activity-state.ts,store.ts}`，及各层对应测试。

- [x] 写失败测试：删除 root + child 后 durable `session.deleted` 携带两个 ID；另一窗口的 Activity delta 和列表同时移除它们；迟到基线不能复活被删会话。
- [x] 运行 services/server/Desktop 对应目标测试，确认行为缺失而失败。
- [x] 在删除事务内追加 global 事件，服务层用已有 checkpoint/publishSince 广播，main 和 renderer 对摘要/列表/水位执行删除。
- [x] 重跑目标测试及原有会话删除、Activity 订阅回归。

## 架构加固任务 8：轻量全局归纳

**文件：** `packages/client/src/state/sync.ts`、`apps/desktop/src/main/features/activity/{activity-reducer.ts,global-activity-subscription-service.ts}` 及测试。

- [x] 写失败测试：全局 replay 与 live 处理消息/parts 后 Activity state 的 `eventsBySeq`、`messages`、`partsByMessageId` 仍为空；Run/Permission/Scheduled 与 cursor/gap 语义不变。
- [x] 运行 client 与 Desktop 目标测试确认失败。
- [x] 给 `syncEvents` 的全局路径注入可选归纳函数（默认仍为原 reducer）；Desktop 只归纳 session 摘要、必要 run/permission 与 seq，跳过 transcript 大对象。
- [x] 重跑 client sync、main subscription 和 active transcript 回归，比较重放/重连输出。

## 架构加固任务 9：收敛 Scheduled 刷新

**文件：** `apps/desktop/src/renderer/src/components/desktop/scheduled-page/scheduled-page.tsx` 与 `scheduled-page.activity.test.tsx`。

- [x] 写失败测试：手动刷新、状态事件和失败重试交错时列表仅应用最新响应；已读事件不触发列表请求；选中任务详情仍按需更新。
- [x] 运行目标测试确认失败。
- [x] 合并重复的列表请求版本与退避逻辑为单一协调器；详情保留独立加载，删除只为互相修补而存在的 nonce/ref。
- [x] 重跑 Scheduled、Sidebar、Desktop 类型与 lint 检查。
