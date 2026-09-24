# Session 模型切换分割提示实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在已有 Session 主动切换模型后，持久化一条只供界面展示的分割提示，同时保证该提示永远不进入模型上下文。

**架构：** 复用现有 `system` 消息和文本 part，通过 `metadata.presentation.kind = "model_switch"` 标记。`SessionApplicationService.updateSession` 在一个 Store 事务中更新模型并写入提示；`buildAgentTranscript` 在角色转换前过滤该标记；Desktop 的 `MessageBlock` 将它渲染成横线分割组件。

**技术栈：** TypeScript、React、Vitest、SessionStore/SQLite、Tailwind CSS、Lucide React

---

## 文件职责

- 修改 `packages/server/src/application/session/session-application-service.ts`：原子写入模型更新和 presentation 消息。
- 修改 `packages/server/src/application/session/__test__/session-application-service.test.ts`：验证变化、相同值和失败三类写入行为。
- 修改 `packages/server/src/application/agent/agent-transcript.ts`：过滤合法的 UI presentation 消息。
- 修改 `packages/server/src/application/agent/__test__/agent-transcript.test.ts`：验证 presentation 隔离且普通 system 消息不受影响。
- 修改 `packages/services/src/session-runtime/__test__/store.test.ts`：验证模型切换消息按分叉边界复制。
- 创建 `apps/desktop/src/renderer/src/components/desktop/conversation-page/message/model-switch-divider.tsx`：读取 metadata 并渲染分割线。
- 修改 `apps/desktop/src/renderer/src/components/desktop/conversation-page/message-block.tsx`：把合法 presentation system 消息路由到专用组件。
- 修改 `apps/desktop/src/renderer/src/components/desktop/conversation-page/transcript.test.ts`：验证分割线和普通系统消息的 HTML。

### 任务 1：持久化模型切换并隔离模型上下文

**文件：**

- 修改：`packages/server/src/application/session/session-application-service.ts`
- 修改：`packages/server/src/application/session/__test__/session-application-service.test.ts`
- 修改：`packages/server/src/application/agent/agent-transcript.ts`
- 修改：`packages/server/src/application/agent/__test__/agent-transcript.test.ts`

- [ ] **步骤 1：编写 Session 更新失败测试**

扩展测试 Store mock，使 `transaction(work)` 直接执行 `work`，并提供 `createMessage`、`upsertMessagePart` mock。给“changing the model”测试增加断言：

```ts
expect(store.transaction).toHaveBeenCalledOnce();
expect(store.createMessage).toHaveBeenCalledWith({
  sessionId: "s1",
  role: "system",
  metadata: {
    presentation: {
      kind: "model_switch",
      fromModel: "gpt-test",
      toModel: "next-model",
    },
  },
});
expect(store.upsertMessagePart).toHaveBeenCalledWith(
  expect.objectContaining({
    sessionId: "s1",
    type: "text",
    status: "completed",
    text: "模型已切换 gpt-test → next-model",
  }),
);
```

增加两个测试：更新为相同模型不创建消息；运行中的 Session 被拒绝时不创建消息。

- [ ] **步骤 2：编写 Agent transcript 过滤失败测试**

在 `agent-transcript.test.ts` 构造两个 system 消息：一个带合法 `model_switch` metadata，一个普通 system 消息。断言结果只保留普通 system 消息：

```ts
expect(transcript.messages).toEqual([
  { type: "system", content: "keep this instruction" },
]);
```

再增加一个 metadata 不完整的 system 消息，断言它不会被误过滤。

- [ ] **步骤 3：运行测试并确认红灯**

```powershell
pnpm --filter @vykor/server exec vitest run src/application/session/__test__/session-application-service.test.ts src/application/agent/__test__/agent-transcript.test.ts
```

预期：Session 更新没有调用 presentation 写入；Agent transcript 仍包含提示文本。

- [ ] **步骤 4：实现严格的 presentation 判定**

在 `agent-transcript.ts` 增加只接受完整 schema 的内部函数：

```ts
function isPresentationOnlyMessage(message: SessionMessageRecord): boolean {
  const presentation = message.metadata.presentation;
  if (
    !presentation ||
    typeof presentation !== "object" ||
    Array.isArray(presentation)
  )
    return false;
  const value = presentation as Record<string, unknown>;
  return (
    value.kind === "model_switch" &&
    typeof value.fromModel === "string" &&
    Boolean(value.fromModel.trim()) &&
    typeof value.toModel === "string" &&
    Boolean(value.toModel.trim())
  );
}
```

在 `buildAgentTranscript` 遍历消息后、读取附件和角色之前执行：

```ts
if (isPresentationOnlyMessage(message)) continue;
```

- [ ] **步骤 5：原子写入 Session 和提示**

在 `SessionApplicationService.updateSession` 中先计算 `modelChanged`。使用 `store.transaction` 包住现有 `updateSession`；仅在 `modelChanged` 时调用 `createMessage` 和 `upsertMessagePart`：

```ts
const modelChanged = nextModel !== undefined && nextModel !== existing.model;
const session = this.context.store.transaction(() => {
  const updated = this.context.store.updateSession(sessionId, update);
  if (!modelChanged) return updated;
  const message = this.context.store.createMessage({
    sessionId,
    role: "system",
    metadata: {
      presentation: {
        kind: "model_switch",
        fromModel: existing.model,
        toModel: nextModel,
      },
    },
  });
  this.context.store.upsertMessagePart({
    sessionId,
    messageId: message.id,
    type: "text",
    status: "completed",
    text: `模型已切换 ${existing.model} → ${nextModel}`,
  });
  return updated;
});
```

缓存失效继续复用 `modelChanged`，Agent runtime 关闭和事件发布仍在事务成功之后执行。

- [ ] **步骤 6：运行服务端测试并确认绿灯**

```powershell
pnpm --filter @vykor/server exec vitest run src/application/session/__test__/session-application-service.test.ts src/application/agent/__test__/agent-transcript.test.ts
```

预期：相关测试全部 PASS。

- [ ] **步骤 7：提交持久化和隔离逻辑**

```powershell
git add -- packages/server/src/application/session/session-application-service.ts packages/server/src/application/session/__test__/session-application-service.test.ts packages/server/src/application/agent/agent-transcript.ts packages/server/src/application/agent/__test__/agent-transcript.test.ts
git commit -m "feat(session): persist model switch presentation events"
```

### 任务 2：验证分叉复制边界

**文件：**

- 修改：`packages/services/src/session-runtime/__test__/store.test.ts`

- [ ] **步骤 1：增加分叉行为测试**

在 Store 测试中创建 `system` presentation 消息、其文本 part、一个在它之后的普通消息，然后分别从提示之后和提示之前分叉：

```ts
expect(
  afterMessages.some(
    (message) =>
      (message.metadata.presentation as { kind?: string } | undefined)?.kind ===
      "model_switch",
  ),
).toBe(true);
expect(
  beforeMessages.some(
    (message) =>
      (message.metadata.presentation as { kind?: string } | undefined)?.kind ===
      "model_switch",
  ),
).toBe(false);
```

同时断言复制后的提示 part 文本仍为 `模型已切换 model-a → model-b`。

- [ ] **步骤 2：运行 Store 测试**

```powershell
pnpm --filter @vykor/services exec vitest run src/session-runtime/__test__/store.test.ts
```

预期：PASS；现有 Store 复制逻辑已经支持 metadata 与 part，不需要修改生产 Store。

- [ ] **步骤 3：提交分叉回归覆盖**

```powershell
git add -- packages/services/src/session-runtime/__test__/store.test.ts
git commit -m "test(session): preserve model switch dividers across forks"
```

### 任务 3：渲染模型切换分割线

**文件：**

- 创建：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message/model-switch-divider.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/message-block.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/transcript.test.ts`

- [ ] **步骤 1：编写 Desktop 失败测试**

在 `transcript.test.ts` 构造合法 presentation system 消息并静态渲染 `MessageBlock`，断言：

```ts
expect(html).toContain('role="separator"');
expect(html).toContain("模型已切换");
expect(html).toContain("GLM-5.3");
expect(html).toContain("GLM-5.3-Flash");
expect(html).toContain('aria-label="模型已切换 GLM-5.3 到 GLM-5.3-Flash"');
```

保留一个普通 system 消息测试，断言它仍显示原始文本且没有 `role="separator"`。

- [ ] **步骤 2：运行测试并确认红灯**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/transcript.test.ts
```

预期：presentation 消息仍按普通小号文本显示，没有 separator 角色。

- [ ] **步骤 3：实现 metadata 解析和分割组件**

在新组件中导出严格解析器与组件：

```ts
export interface ModelSwitchPresentation {
  kind: "model_switch";
  fromModel: string;
  toModel: string;
}

export function readModelSwitchPresentation(
  metadata: Record<string, unknown>,
): ModelSwitchPresentation | null;
```

`ModelSwitchDivider` 使用 `ArrowRightLeft` 图标，外层 `role="separator"`，左右各一条 `h-px flex-1 bg-border/70` 横线，中间为弱化的小号文案。使用 `aria-label` 提供无箭头的朗读文本。

- [ ] **步骤 4：在 MessageBlock 路由 presentation 消息**

在 `message.role === "system"` 分支先解析 metadata：

```tsx
const modelSwitch = readModelSwitchPresentation(message.metadata);
if (modelSwitch) return <ModelSwitchDivider presentation={modelSwitch} />;
```

解析失败或普通 system 消息继续走现有文本渲染。

- [ ] **步骤 5：运行 Desktop 测试并确认绿灯**

```powershell
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/conversation-page/transcript.test.ts
```

预期：相关测试全部 PASS。

- [ ] **步骤 6：提交 Desktop 分割线**

```powershell
git add -- apps/desktop/src/renderer/src/components/desktop/conversation-page/message/model-switch-divider.tsx apps/desktop/src/renderer/src/components/desktop/conversation-page/message-block.tsx apps/desktop/src/renderer/src/components/desktop/conversation-page/transcript.test.ts
git commit -m "feat(desktop): show model switches in session history"
```

### 任务 4：整体验证

**文件：**

- 验证：前三个任务的全部文件

- [ ] **步骤 1：运行相关包测试**

```powershell
pnpm --filter @vykor/server test
pnpm --filter @vykor/services test
pnpm --filter @vykor/desktop test
```

预期：全部 PASS；若仓库既有平台测试失败，单独记录且不得把它算作本功能通过证据。

- [ ] **步骤 2：运行类型检查**

```powershell
pnpm check-types
```

预期：Turbo 报告全部类型检查成功。

- [ ] **步骤 3：检查改动范围**

```powershell
git diff --check
git diff --name-only HEAD~3..HEAD
git status --short
```

预期：只有计划列出的 Session、Agent transcript、Store 测试和 Desktop 渲染文件发生变化，工作区干净。
