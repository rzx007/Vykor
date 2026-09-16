# Clean-slate Stage 8B：应用与存储边界收口实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将真实会话编排保留在 `SessionInteractionService`，让查询、命令、控制和 Goal 直接依赖窄服务，并删除 `SessionApplicationService` 与 `SessionStore` 的纯转发职责。

**架构：** `SessionInteractionService` 负责 Prompt/Run 的跨服务业务编排；`SessionOperationRunner` 只提供 session 串行化、ready/lease 与事件 checkpoint。Repository/Transaction 是持久化事实源，`SessionStore` 只保留数据库生命周期、当前事件/waiter 和尚无独立所有者的职责。

**技术栈：** TypeScript、Vitest、SQLite、Repository/Transaction services

---

## 文件结构

- 创建：`packages/server/src/application/session/session-interaction-service.ts`。
- 创建：`packages/server/src/application/session/session-operation-runner.ts`。
- 创建：对应 `__test__/session-interaction-service*.test.ts` 与 `session-operation-runner.test.ts`。
- 修改：`session-goal-service.ts`、`daemon-application.ts`、session HTTP routes 与 daemon services。
- 删除：`session-application-service.ts` 及其旧命名测试，完成后不得保留 re-export alias。
- 修改：`packages/services/src/session-runtime/store.ts` 和各领域 repository/transaction 调用方。

### 任务 1：建立 Operation Runner

- [ ] **步骤 1：写并发、lease 与异常释放测试**

测试以下公开契约：

```ts
export interface SessionOperationRunner {
  run<T>(sessionId: string, work: () => Promise<T>): Promise<T>;
}
```

同一 session 的两个 work 串行，不同 session 可并行；warming/ready 失败时 work 不运行；work 抛错后 lease 被释放，下一次操作仍能执行；checkpoint/publish 每次成功操作只发生一次。

- [ ] **步骤 2：运行目标测试确认失败**

运行：`pnpm --filter @openharness/server exec vitest run src/application/session/__test__/session-operation-runner.test.ts`

预期：FAIL，模块不存在。

- [ ] **步骤 3：从 `SessionApplicationService` 提取最小实现**

构造上下文只包含 operation queue、runtime readiness、lease 与 event publisher；不得接收完整 `SessionStore` 或完整 `DaemonApplication`。

- [ ] **步骤 4：让 Goal 使用 Runner**

`SessionGoalService` 构造参数新增 `operationRunner: Pick<SessionOperationRunner, "run">`，原 `withSessionOperation` 调用替换为 `operationRunner.run(sessionId, work)`；保留幂等事务、ready 检查和事件顺序。

- [ ] **步骤 5：验证 Runner 和 Goal**

运行：

```powershell
pnpm --filter @openharness/server exec vitest run src/application/session/__test__/session-operation-runner.test.ts src/application/session/__test__/session-goal-service.test.ts
pnpm --filter @openharness/server check-types
```

预期：PASS。

### 任务 2：建立 SessionInteractionService 并迁移调用者

- [ ] **步骤 1：复制行为测试并改用新类名**

把 edit、admit、resume、interrupt、promote、cancel、warm-get 测试迁到新文件；公开方法固定为：

```ts
warmSession(sessionId: string): Promise<SessionRecord | undefined>;
editLatestPrompt(sessionId: string, input: EditLatestPromptInput): Promise<PromptResponse>;
admitPrompt(sessionId: string, input: AdmitPromptInput): Promise<AdmitPromptResult>;
resumeRun(sessionId: string, runId: string, input: ResumeRunInput): Promise<ResumeRunResult>;
interruptSession(sessionId: string): Promise<InterruptSessionResult>;
promoteQueuedPrompt(sessionId: string, inputId: string): Promise<PromoteQueuedPromptResult>;
cancelQueuedPrompt(sessionId: string, inputId: string): Promise<CancelQueuedPromptResult>;
```

- [ ] **步骤 2：运行新测试确认类尚不存在**

运行：`pnpm --filter @openharness/server exec vitest run src/application/session/__test__/session-interaction-service*.test.ts`

预期：FAIL。

- [ ] **步骤 3：移动真实编排代码**

从旧类移动方法实现；内部直接依赖 `RunAdmissionService`、`RunControlService`、`SessionOperationRunner`、必要 Repository 与 publisher。不得把 create/fork/update/archive/delete/get/awaitRun 转发方法复制过去。

- [ ] **步骤 4：迁移 HTTP、Channel、Schedule 和 daemon composition**

规则如下：create/fork/update/archive/delete/close → `SessionCommandService`；纯 get → `SessionQueryService`；warm get 和 Prompt/Run 交互 → `SessionInteractionService`；await → `RunControlService`。

- [ ] **步骤 5：更新 `DaemonApplication` 的窄属性**

组装一份共享 Runner 和 Interaction 实例，routes 只接收实际使用的 `Pick<...>`。移除 `sessions: SessionApplicationService` 这种全能门面。

- [ ] **步骤 6：验证行为与引用归零**

运行：

```powershell
rg -n 'SessionApplicationService|session-application-service|withSessionOperation' packages/server/src
pnpm --filter @openharness/server check-types
pnpm --filter @openharness/server test
```

预期：`rg` 无输出；测试 PASS。

### 任务 3：删除 SessionStore 领域转发

- [ ] **步骤 1：生成方法所有权清单**

对 `store.ts` 当前公开方法逐项映射到 `projects`、`schedules`、`channels`、`goals`、`permissions`、`attachments`、`sessions`、`conversations`、`runs` repository 或 transaction。清单写入 `docs/architecture-migration-status.md` 的当前状态表，只记录最终所有者，不保留兼容数量。

- [ ] **步骤 2：先迁移生产调用方**

用以下命令定位生产调用，逐个改为最小依赖：

```powershell
rg -n '\b(store|context\.store)\.(listProjects|getProject|createScheduledTask|getScheduledTask|createSession|getSession|archiveSession|createGoal|getGoal|createRun|getRun|createPermissionRequest|replyPermission|createImportingAttachment|getAttachment)\b' packages/server packages/services --glob '!**/*.test.ts'
```

每个调用方构造参数使用对应 repository interface，不允许改成 `Pick<SessionStore, ...>`。

- [ ] **步骤 3：迁移测试 fixture**

测试可以用 `SessionStore` 创建数据库 kernel，但行为调用必须走 repository/transaction；给测试 helper 返回具名能力：

```ts
return {
  store,
  sessions: store.sessions,
  conversations: store.conversations,
  runs: store.runs,
};
```

- [ ] **步骤 4：删除确认已迁移的转发方法**

从 `store.ts` 删除对应一行委托和无用 imports。保留 `close`、数据库 backup、当前 event subscription/waiter、owner lease，以及没有独立 owner 的 retention/recovery 职责。

- [ ] **步骤 5：验证存储边界**

运行：

```powershell
pnpm --filter @openharness/services check-types
pnpm --filter @openharness/services test
pnpm --filter @openharness/server check-types
pnpm --filter @openharness/server test
pnpm check:architecture
```

预期：全部 PASS。

- [ ] **步骤 6：提交 8B**

```powershell
git add packages/server packages/services docs/architecture-migration-status.md scripts/architecture-baseline.json
git commit -m "refactor: finalize session application and storage boundaries"
```
