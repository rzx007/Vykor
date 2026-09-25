# 桌面会话流式更新合并实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度。

**目标：** 消除桌面端会话大量输出时的整体卡顿：主进程按固定窗口合并会话更新，使文件树、设置页等操作在流式期间仍可响应。

**架构：** 桌面主进程新增一个不依赖 Electron 的窗口合并器；`SessionSubscriptionService.pumpSession` 的主/辅订阅用它把「每事件一份全量快照」降为「每窗口一份」。渲染端仅把 `refreshGoal` 改为尾延防抖。

**技术栈：** TypeScript、Vitest；不新增依赖。

**设计依据：** [桌面会话流式更新合并设计](../specs/2026-09-26-desktop-session-stream-coalescing-design.md)。执行前确认工作区状态；每个任务单独做红灯、绿灯、审查和提交。

**执行进度：** 任务 1–3 已完成（红灯 → 绿灯 → 全量验证）；任务 4 的端到端手动验证待在有真实流式输出的环境执行；任务 5 收尾进行中。

---

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `apps/desktop/src/main/features/session/session-update-coalescer.ts` | 纯窗口合并器：`queue` / `cancelPending` / `flushNow` / `dispose` |
| `apps/desktop/src/main/features/session/session-update-coalescer.test.ts` | 合并器单测（假定时器） |
| `apps/desktop/src/main/features/session/session-subscription-service.ts` | 主/辅订阅接入合并器，注入窗口与发送校验 |
| `apps/desktop/src/main/features/session/session-subscription-service.coalescing.test.ts` | 服务级合并/重连/删除竞态/辅订阅测试 |
| `apps/desktop/src/renderer/src/stores/desktop-session/store.ts` | `refreshGoal` 尾延防抖 |
| `apps/desktop/src/renderer/src/stores/desktop-session/goal-refresh-scheduler.ts`、`goal-refresh-scheduler.test.ts` | 每会话尾延防抖器与单测 |
| `apps/desktop/src/renderer/src/stores/desktop-session/store.integration.test.ts` | 一批更新只触发一次 `getGoal` 的集成测试 |

## 任务 1：窗口合并器（纯模块）

**文件：** 新增 `session-update-coalescer.ts`、`session-update-coalescer.test.ts`。

- [x] **步骤 1：先写失败测试。** 用假定时器断言：窗口内 `queue` N 次 → 只 `deliver` 1 次且内容是最后一次 state；`flushNow(next)` 立即发送并取消挂起；`cancelPending()` 后实例可继续 `queue`；`dispose()` 后 `queue`/定时器都不再发送；不重复发送。
- [x] **步骤 2：确认红灯。** 在 `apps/desktop` 执行 `../../node_modules/.bin/vitest.CMD run src/main/features/session/session-update-coalescer.test.ts`。预期 FAIL，不是配置错误。
- [x] **步骤 3：实现最小合并器。** 固定窗口（首次 `queue` 起定时器，窗口内覆盖最新、不重置）；`deliver` 由调用方注入；不 import Electron。
- [x] **步骤 4：绿灯、审查、提交。**

## 任务 2：接入订阅服务（主 + 辅 + 重连 + 删除竞态）

**文件：** 修改 `session-subscription-service.ts`；新增 `session-subscription-service.coalescing.test.ts`。

- [x] **步骤 1：先写失败测试（假定时器，假 client 突发多条）。** 断言：一个窗口内多条 live → 只 `send` 1 次且 cursor 最新；`onReconnecting` 立即 `send` 一条 reconnecting 且顺序在后续 live 之前；删除/替换会话后挂起的窗口不再 `send`；辅订阅（`sessionAuxUpdated`）同样被合并；打开会话返回的快照与首个 live 刷出顺序无回归。
- [x] **步骤 2：确认红灯。**
- [x] **步骤 3：接线。** `pumpSession` 注入窗口 ms（构造可选，默认 50）；`send` 回调统一做校验（`webContents.isDestroyed()`、`subscriptions.isCurrent(...)`、`state.buckets[sessionId]?.session` 存在），定时器刷出与 `flushNow` 共用该 `send`；`onUpdate` → `queue`；`source === "reconnecting"` 与迭代器结束时 `flushNow`；`pumpSubscription` 外层 `try/finally` 调 `dispose()`。
- [x] **步骤 4：绿灯、审查、提交。**

## 任务 3：refreshGoal 尾延防抖

**文件：** 新增 `goal-refresh-scheduler.ts`；修改 `store.ts`（`onUpdated` 回调与清理）；测试放 `goal-refresh-scheduler.test.ts` 与 `store.integration.test.ts`。

- [x] **步骤 1：先写失败测试。** 一批 session 更新只触发一次 `getGoal`，并有尾延调用。
- [x] **步骤 2：确认红灯。**
- [x] **步骤 3：实现每会话尾延防抖（≈1s，复用 `project-git-scheduler` 模式），保留单飞。**
- [x] **步骤 4：绿灯、审查、提交。**

## 任务 4：端到端验证（不提交临时埋点）

- [ ] 长会话（≥100 条消息）长输出：临时计数主进程 `sessionUpdated` 发送频率，确认 ≤20/s；开文件树、点设置页 1s 内响应；结束后 cursor 与最后一条 part 文本一致。
- [ ] dev 与打包版各测一次并记录（dev 有 StrictMode，偏重属预期）。

## 任务 5：收尾

- [x] `apps/desktop` 全量单测（195 文件 / 1180 用例）、`tsconfig.node.json` 与 `tsconfig.web.json` typecheck、`node scripts/check-docs.mjs`、`git diff --check` 全过。
- [ ] 提交。

## 阶段二（观察后再定，不在本计划）

若阶段一后长会话仍卡：渲染端 `useDeferredValue` / transcript memo / 拆分流式切片；必要时再评估协议级 delta。先拿到阶段一的发送频率与响应时间数据再决定。
