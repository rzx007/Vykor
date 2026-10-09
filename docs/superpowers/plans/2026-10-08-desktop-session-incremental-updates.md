# Desktop 会话增量更新实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 限制 Desktop 会话更新在 Renderer 落后时的积压，并避免文本流每 50 ms 都传输完整会话视图。

**架构：** 主进程每个订阅只允许一条实时更新在途；健康时维持 50 ms 更新窗口，落后时合并有界 delta，结构变化或恢复请求则以最新完整快照追齐。Renderer 同步应用更新后 ACK；应用失败或 ACK watchdog 超时后按订阅代次恢复。daemon、SSE 和公开 Client API 不变。

**技术栈：** Electron IPC、TypeScript、Zustand、Vitest、现有 `syncEvents` 与 `SessionUpdateCoalescer`。

**当前状态：** 实现和定向自动化验证已完成；同等生成负载下的 Renderer 主线程、IPC 数据量与内存复测仍待执行，不能据此宣称运行时内存问题已完全解决。

---

## 文件与职责

- `apps/desktop/src/shared/session-types.ts`：定义实时更新、delta、ACK 和重同步请求类型。
- `apps/desktop/src/shared/ipc-channels.ts`：为 ACK 和重同步 IPC 添加类型化 invoke 契约。
- `apps/desktop/src/shared/desktop-api-contract.ts`、`apps/desktop/src/preload/desktop-api.ts`：暴露最小必要的更新、ACK 与重同步 API。
- `apps/desktop/src/main/features/session/session-subscription-service.ts`：为 primary / auxiliary subscription 生产增量、快照并管理在途更新。
- `apps/desktop/src/main/features/session/session-update-coalescer.ts`：保留 50 ms 首次入队窗口；只在 ACK 未返回时合并待发 delta。
- `apps/desktop/src/main/features/session/ipc.ts`：注册 ACK 与重同步 handler，并校验发送窗口和当前订阅。
- `apps/desktop/src/renderer/src/stores/desktop-session/session-view-state.ts`：以纯函数校验并应用 delta，失败时不部分改写视图。
- `apps/desktop/src/renderer/src/stores/desktop-session/session-view-actions.ts`、`store.ts`、`types.ts`：主会话应用快照 / 增量、发送 ACK、维护 ACK watchdog。
- `apps/desktop/src/renderer/src/stores/desktop-session/session-update-delivery.ts`：复用主、辅会话的 ACK watchdog、重同步和卸载清理逻辑。
- `apps/desktop/src/renderer/src/components/desktop/tools/side-chat-panel.tsx`、`tools/agents/agents-tool.tsx`、`tools/agents/agent-task-model.ts`：辅助会话消费更新，并对各自订阅 ACK。
- 测试沿用相邻现有文件：`session-subscription-service.coalescing.test.ts`、`session-update-coalescer.test.ts`、`session-view-state.test.ts`、`session-update-delivery.test.ts`、`store.integration.test.ts`、`side-chat-panel.test.tsx`、`agents-tool.test.tsx`、`agent-task-model.test.ts`、`desktop-api.test.ts`；为现有 session IPC 注册边界新增 `ipc.test.ts`。

## 任务 1：定义更新契约并实现纯 delta reducer

**文件：**
- 修改：`apps/desktop/src/shared/session-types.ts`
- 修改：`apps/desktop/src/shared/ipc-channels.ts`
- 修改：`apps/desktop/src/shared/desktop-api-contract.ts`
- 修改：`apps/desktop/src/preload/desktop-api.ts`
- 修改：`apps/desktop/src/preload/desktop-api.test.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/session-view-state.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/session-view-state.test.ts`

- [x] **步骤 1：先写 delta reducer 失败测试**

```ts
it("exposes a session delta reducer", () => {
  expect(Reflect.get(sessionViewState, "applySessionPartDeltas")).toBeTypeOf("function")
})

it("appends a delta while preserving unchanged entity references", () => {
  const view = viewWithTextPart("hello")
  const untouchedMessage = view.messages[1]
  const result = sessionViewState.applySessionPartDeltas(view, {
    sessionId: "s1",
    deltas: [partDelta({ baseLength: 5, delta: " world", seq: 8 })],
  })

  expect(result.kind).toBe("applied")
  if (result.kind !== "applied") throw new Error("expected delta to apply")
  expect(result.view.parts[0]?.text).toBe("hello world")
  expect(result.view.messages[1]).toBe(untouchedMessage)
})
```

- [x] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @vykor/desktop exec vitest run src/renderer/src/stores/desktop-session/session-view-state.test.ts`

预期：第一个测试 FAIL，现有 session view 状态模块还没有 delta reducer。

- [x] **步骤 3：添加联合类型和最小纯 reducer**

更新联合类型包含 `kind`、`subscriptionId`、`generation`、`deliveryId`；delta 携带 `seq`、message / part ID、字段、增量文本、`baseLength`、时间和可选 `partSeq`。ACK 结果使用 `{ accepted: boolean }`；重同步请求绑定订阅、代次、超时 delivery 和最后已应用 delivery。

Reducer 按 `seq` 处理；跳过 cursor 已覆盖的项目。校验 session、message、part 和 UTF-16 offset 后，以结构共享方式只替换目标 part。任何项目不匹配时返回失败结果，原视图保持不变。

- [x] **步骤 4：扩展单元测试覆盖恢复边界**

在现有 session view 状态测试中验证 reasoning、首次创建 part、重复 / 旧 seq、UTF-16 长度、错误 offset、缺少 message、session 不匹配，以及失败批次不部分更新。

- [x] **步骤 5：运行 reducer 与 preload 定向测试**

运行：`pnpm --filter @vykor/desktop exec vitest run src/renderer/src/stores/desktop-session/session-view-state.test.ts src/preload/desktop-api.test.ts`

预期：PASS；preload ACK / resync 方法调用对应固定 IPC channel，listener 可移除。

## 任务 2：实现主进程单在途交付和有界缓冲

**文件：**
- 修改：`apps/desktop/src/main/features/session/session-subscription-service.ts`
- 修改：`apps/desktop/src/main/features/session/session-update-coalescer.ts`
- 修改：`apps/desktop/src/main/features/session/session-subscription-service.coalescing.test.ts`
- 修改：`apps/desktop/src/main/features/session/session-update-coalescer.test.ts`
- 修改：`apps/desktop/src/main/features/session/ipc.ts`
- 修改：`apps/desktop/src/main/features/session/session-subscription-service.deletion.test.ts`
- 创建：`apps/desktop/src/main/features/session/ipc.test.ts`

- [x] **步骤 1：添加主进程失败测试**

覆盖以下契约：纯 delta 窗口不调用 `toDesktopSessionView`；后续事件不会重置首次入队的 50 ms 窗口；每订阅最多一条在途更新；超出 500 项或 1 MiB 待发 delta 后只保留快照恢复标记；非 delta 更新覆盖待发 delta，恢复快照的文本与 cursor 包含被丢弃增量对应的最新状态；ACK 释放发送槽后交付 delta 或最新快照；过期 ACK 不改变当前代次。保留 plugin UI owner 行为：忽略纯文本 delta，非 delta 仍按原时机通知。

- [x] **步骤 2：运行定向测试确认失败**

运行：`pnpm --filter @vykor/desktop exec vitest run src/main/features/session/session-subscription-service.coalescing.test.ts src/main/features/session/session-update-coalescer.test.ts`

预期：FAIL，现有服务仍将完整视图直接发送，且没有 ACK 管理。

- [x] **步骤 3：实现每订阅的最小发送状态**

每个订阅保存 generation、单个 in-flight delivery、待发 delta、有界操作数 / 字节数、快照恢复标记和 50 ms 窗口。连续 delta 只保存事件资料；`baseLength` 从 reducer 后文本长度减去本次 `delta.length` 计算。相邻同目标、同字段 delta 可以合并，不同目标保持顺序。

无在途更新时按 50 ms 窗口发送 delta 或快照。已有更新未 ACK 时不再发送；结构变化、重连或缓冲超限后清空待发 delta，只保留最新权威 state 引用，ACK / 重同步后再构建一份快照。

- [x] **步骤 4：接入 ACK 与同订阅重同步 handler**

校验 Electron sender、subscription、generation 和 delivery ID。`resync-required` ACK 直接作废旧代次并发最新快照。超时重同步请求若对应 delivery 仍在途则恢复到新代次；若已 ACK 则幂等成功；若请求已过期则返回 `accepted: false`。旧 primary subscription 在导航切换时由现有 `open` 替换 / 关闭流程清理。

- [x] **步骤 5：验证背压、竞态和清理测试**

为 watchdog 请求与 `applied`、`resync-required` ACK 的两种先后顺序增加测试，断言最多推进一次 generation、最多发一份恢复快照。新增 `ipc.test.ts`，验证错误 Electron sender、错误 subscription / generation 和旧 delivery 的 ACK / 重同步请求不改变订阅状态。验证 auxiliary / primary 订阅关闭、WebContents 销毁后定时器、缓冲和在途状态均清理。

运行：`pnpm --filter @vykor/desktop exec vitest run src/main/features/session/session-subscription-service.coalescing.test.ts src/main/features/session/session-update-coalescer.test.ts src/main/features/session/session-subscription-service.deletion.test.ts`

预期：PASS；健康更新仍按 50 ms 窗口交付，慢消费者的增量积压不超过限制。

## 任务 3：接入 Renderer 主辅会话并完成验证

**文件：**
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/session-view-actions.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/store.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/types.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/side-chat-panel.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/agents/agents-tool.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/agents/agent-task-model.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/side-chat-panel.test.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/agents/agents-tool.test.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/agents/agent-task-model.test.ts`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/store.integration.test.ts`
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/session-update-delivery.ts`
- 创建：`apps/desktop/src/renderer/src/stores/desktop-session/session-update-delivery.test.ts`

- [x] **步骤 1：为 primary / auxiliary 更新处理补测试**

验证 snapshot 保持现有完整视图副作用；delta 只更新 transcript 和 cursor，不触发 runtime reconcile、项目刷新或 goal 刷新；应用成功后发送 `applied` ACK；应用失败后不改视图并发送 `resync-required`；过期 generation 不应用。

- [x] **步骤 2：实现主会话事件消费**

将主会话 `onUpdated` 改为消费更新联合类型。snapshot 走原 `applySessionUpdate`；delta 走纯 reducer 并结构共享更新 store。成功后立即 ACK。每个在途 delivery 设置 5 秒 watchdog；未收到 ACK 接收确认时请求同订阅重同步；换代或卸载后清理 watchdog。

- [x] **步骤 3：实现辅助会话事件消费**

侧边聊天和 Agent 详情只接受匹配自身 `subscriptionId` / `sessionId` 的更新。复用同一个纯 reducer；同步更新本地 view 后 ACK，失败时请求快照恢复。辅助会话同样为每条在途 delivery 设置 5 秒 watchdog；收到 ACK 确认、generation 更换或组件卸载时清理 watchdog，超时则请求原 auxiliary subscription 重同步。卸载时沿用现有 `closeAux` 清理订阅。

- [x] **步骤 4：运行 Renderer 定向测试和类型检查**

运行：

```text
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/stores/desktop-session/session-view-state.test.ts src/renderer/src/stores/desktop-session/store.integration.test.ts src/renderer/src/components/desktop/tools/side-chat-panel.test.tsx src/renderer/src/components/desktop/tools/agents/agents-tool.test.tsx src/renderer/src/components/desktop/tools/agents/agent-task-model.test.ts
pnpm --filter @vykor/desktop run typecheck
```

预期：测试通过；Node 与 Web TypeScript 检查通过。

- [x] **步骤 5：运行全链路定向验证**

运行：

```text
pnpm --filter @vykor/desktop exec vitest run src/main/features/session/session-subscription-service.coalescing.test.ts src/main/features/session/session-update-coalescer.test.ts src/main/features/session/session-subscription-service.deletion.test.ts src/main/features/session/ipc.test.ts src/preload/desktop-api.test.ts src/renderer/src/stores/desktop-session/session-view-state.test.ts src/renderer/src/stores/desktop-session/session-update-delivery.test.ts src/renderer/src/stores/desktop-session/store.integration.test.ts src/renderer/src/components/desktop/tools/side-chat-panel.test.tsx src/renderer/src/components/desktop/tools/agents/agents-tool.test.tsx src/renderer/src/components/desktop/tools/agents/agent-task-model.test.ts
pnpm check-docs
git diff --check
```

结果：11 个测试文件、137 项测试通过；Node 与 Web TypeScript 检查、Markdown 校验和 `git diff --check` 通过。运行时复测仍需在同等生成工作量下比较主进程 full-view 构建次数、IPC 字节数、待发上限、Renderer 主线程和内存；自动化通过不代表运行时内存问题已完全解决。
