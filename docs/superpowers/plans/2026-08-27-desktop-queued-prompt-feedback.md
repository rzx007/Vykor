# 桌面端排队消息即时反馈实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让桌面端发送、调整方向和取消排队消息后立即给出正确反馈，并由 SSE 最终状态无闪回地接管。

**架构：** `sessionView` 继续只保存 daemon snapshot/SSE 权威状态。Zustand store 保存按 `sessionId/runId` 隔离的本地确认状态；ConversationPage 把两层状态合并为可见队列。SSE 出现对应 input/run 或终态后清理本地层。

**技术栈：** TypeScript、React、Zustand、Electron IPC、Vitest、SSE session sync。

---

## 文件结构

- 修改 `apps/desktop/src/renderer/src/stores/desktop-session-store.ts`：维护提交确认、队列操作和 SSE 对账。
- 修改 `apps/desktop/src/renderer/src/stores/desktop-session-store.test.ts`：覆盖 HTTP 与 SSE 不同到达顺序、失败和会话隔离。
- 创建 `apps/desktop/src/renderer/src/components/desktop/conversation-page/pending-prompt-view.ts`：纯函数合并权威队列与本地确认层。
- 创建 `apps/desktop/src/renderer/src/components/desktop/conversation-page/pending-prompt-view.test.ts`：验证去重、即时显示和隐藏覆盖。
- 修改 `apps/desktop/src/renderer/src/components/desktop/conversation-page/pending-prompt-queue.tsx`：展示发送中、操作中和行内错误。
- 修改 `apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx`：使用合并后的队列视图。

### 任务 1：发送后立即显示待处理消息

- [ ] **步骤 1：编写失败测试**

在 store 测试中延迟 `sendPrompt` Promise，调用 `sendMessage("new request")` 后、Promise 完成前断言 `pendingPromptSubmission` 已带 `phase: "submitting"`；完成后但未调用 `applySessionUpdate` 时断言它仍为 `phase: "accepted"`。

在纯函数测试中输入空的 `sessionView` 队列和上述本地提交，断言返回一条内容为 `new request`、状态为 `submitting` 的可见项。

- [ ] **步骤 2：运行测试并确认红灯**

运行：

```powershell
..\..\node_modules\.bin\vitest.CMD run src/renderer/src/stores/desktop-session-store.test.ts src/renderer/src/components/desktop/conversation-page/pending-prompt-view.test.ts
```

预期：FAIL，因为现有提交没有 `phase`，HTTP 成功后会立即清空，且合并纯函数尚不存在。

- [ ] **步骤 3：实现最少的本地提交状态**

把提交状态改为：

```ts
interface PendingPromptSubmission {
  id: string
  sessionId: string
  content: string
  phase: "submitting" | "accepted" | "failed"
  error?: string
}
```

发送前写入 `submitting`，HTTP 成功写入 `accepted`，失败写入 `failed` 并保留相同 ID 供重试。`applySessionUpdate` 看到同 ID input 后清理它。

纯函数将当前会话中 `submitting/accepted` 的本地提交合入权威 pending run；相同 input ID 只保留权威项。

- [ ] **步骤 4：运行测试确认绿灯**

运行任务 1 的 Vitest 命令，预期全部 PASS。

### 任务 2：调整方向和取消立即更新且错误可见

- [ ] **步骤 1：编写失败测试**

在 store 测试中构造一个 pending run：

- mutation Promise 未完成时，只有目标 run 的 `phase` 为 `pending`；
- mutation 成功而 SSE 未到时，目标 run 的 `phase` 为 `acknowledged`；
- mutation 失败时，目标 run 保留并带可见错误；
- 切换 `activeSessionId` 后，旧会话 action 不会锁住新会话。

在纯函数测试中断言 `acknowledged` 的 promote/cancel run 被隐藏，失败 run 保留并带错误。

- [ ] **步骤 2：运行测试并确认红灯**

运行任务 1 的 Vitest 命令，预期 FAIL，因为现有代码只有全局 `pendingPromptActionId`，成功后不隐藏、失败错误不属于具体 run。

- [ ] **步骤 3：实现按会话隔离的操作状态**

使用：

```ts
interface QueuedPromptAction {
  sessionId: string
  inputId: string
  runId: string
  kind: "promote" | "cancel"
  phase: "pending" | "acknowledged" | "failed"
  error?: string
}
```

以 `${sessionId}:${runId}` 为 key 保存。成功时置为 `acknowledged` 并立即在合并视图隐藏；失败时置为 `failed` 并展示行内错误。`applySessionUpdate` 看到 run 已终态后删除 action。

- [ ] **步骤 4：更新队列组件**

发送中的本地项显示 Spinner 和“正在发送”；`pending` action 只禁用当前行；`failed` action 在当前行显示错误并允许重试。其他行和其他会话不受影响。

- [ ] **步骤 5：运行测试确认绿灯**

运行任务 1 的 Vitest 命令，预期全部 PASS。

### 任务 3：时序回归与完整验证

- [ ] **步骤 1：补充 SSE 对账测试**

覆盖：SSE 先于 HTTP、HTTP 先于 SSE、相同 input 去重、旧会话请求晚完成，以及权威 run 进入 `running/interrupted` 后覆盖状态被清理。

- [ ] **步骤 2：运行桌面完整测试**

```powershell
..\..\node_modules\.bin\vitest.CMD run
```

工作目录：`apps/desktop`。预期所有测试 PASS。

- [ ] **步骤 3：运行类型和代码检查**

```powershell
pnpm check-types
pnpm --filter @vykor/desktop lint
git diff --check
```

预期三个命令退出码均为 0。

- [ ] **步骤 4：审查最终差异**

确认只修改计划列出的桌面客户端文件，不改变 daemon 的 queue、steer、幂等和取消语义。
