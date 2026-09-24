# Server 阶段 4B：Session Query 与 Command 拆分实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（- [ ]）语法来跟踪进度。

**目标：** 把 SessionApplicationService 中的只读查询和 Session 生命周期命令分别交给 SessionQueryService 与新 SessionCommandService，旧服务保留兼容转发。

**架构：** Query 只组合持久化查询；Command 处理 create/update/archive/fork/delete 的应用流程，并通过 Run Control、Operation Gate 和事件 capability 协调。Prompt、queue、resume 仍留给 4C。

**技术栈：** TypeScript、Vitest、现有 Session Repository/Transactions、ApplicationError、pnpm。

---

## 方法归属

Query：
- getSession、listSessions、getSessionState；
- listMessages、listMessageParts；
- 必要的只读 title/过滤组合。

Command：
- createSession；
- forkSession；
- updateSession；
- archiveSessionTree；
- deleteSessionTree；
- closeRuntime 仅在它确属 Session 生命周期协调时由 Command 调用 Runtime capability。

4C 保留：
- editLatestPrompt、admitPrompt、resumeRun；
- interruptSession、promoteQueuedPrompt、cancelQueuedPrompt、awaitRun。

## 文件

- 修改 session/session-query-service.ts 及测试。
- 创建 session/session-command-service.ts 及测试。
- 修改 session/session-application-service.ts 及测试。
- 修改 session/index.ts、daemon-application.ts 和 routes/session*.ts。
- 修改架构脚本、baseline 和状态文档。

### 任务 1：固定 Session 生命周期行为

- [ ] **步骤 1：盘点每个公开方法调用链**

运行：rg -n "createSession|getSession|forkSession|updateSession|archiveSessionTree|deleteSessionTree|closeRuntime" packages/server/src/application/session packages/server/src/http/routes -g "*.ts"

- [ ] **步骤 2：补旧实现 Characterization**

create 覆盖默认字段和 runtime metadata；fork 覆盖 source/before/after 和 live child；update 覆盖 metadata patch、runtime change、busy conflict；archive/delete 覆盖 child tree、operation gate、Agent/Run drain、错误映射。

- [ ] **步骤 3：运行旧实现**

运行：pnpm --filter @vykor/server test -- src/application/session/__test__/session-application-service.test.ts src/application/session/__test__/session-application-service-edit.test.ts

预期：新增断言通过。

- [ ] **步骤 4：提交**

提交：git commit -m "test(server): lock session lifecycle application contracts"

### 任务 2：完善 SessionQueryService

**文件：**
- 修改 session-query-service.ts/test.ts

- [ ] **步骤 1：用最小 query fake 写失败测试**

fake 只提供 listSessions/getSession/getSessionState/listMessages/listMessageParts。断言 cwd/includeArchived/limit 原样传递，missing 行为和返回值不加工。

- [ ] **步骤 2：扩展接口**

只添加真实 Route 或兼容门面需要的方法。示例：

    interface SessionQueries {
      getSession(id: string): SessionRecord | undefined;
      listSessions(options?: ListSessionsOptions): SessionRecord[];
      getSessionState(id: string): SessionStateSnapshot;
      listMessages(id: string, options?: ListMessagesOptions): SessionMessageRecord[];
      listMessageParts(id: string, options?: ListMessagePartsOptions): SessionMessagePartRecord[];
    }

- [ ] **步骤 3：迁移只读规则**

若 SessionApplicationService 里存在纯查询辅助，移到 Query；含 live handle 的查询不在本任务移动。

- [ ] **步骤 4：验证并提交**

运行：pnpm --filter @vykor/server test -- src/application/session/__test__/session-query-service.test.ts
提交：git commit -m "refactor(server): complete session query service"

### 任务 3：创建 SessionCommandService

**文件：**
- 创建 session-command-service.ts/test.ts

- [ ] **步骤 1：先定义最小 context 测试**

context 分为 sessions、transactions、runtimeControl、operationGate、events；不接受 store。

- [ ] **步骤 2：写 create/update 红灯**

测试 API 为 createSession(input)、updateSession(id, command)。断言现有 metadata merge、runtime patch、event 和错误映射。

- [ ] **步骤 3：实现最小方法**

从旧服务原样迁移，复用现有 helpers；helper 只被 Command 使用时一起移动，不复制。

- [ ] **步骤 4：写 fork 红灯并实现**

覆盖 source missing、before/after、runtime selection、child ownership。调用 Services fork transaction，不自行复制历史。

- [ ] **步骤 5：写 archive/delete 红灯并实现**

验证先阻止新操作、停止/等待 live work、再 durable archive/delete；失败时释放 operation lease。保持返回值和错误 code。

- [ ] **步骤 6：验证并提交**

运行：pnpm --filter @vykor/server test -- src/application/session/__test__/session-command-service.test.ts
运行：pnpm --filter @vykor/server check-types
提交：git commit -m "refactor(server): extract session command service"

### 任务 4：旧 SessionApplicationService 转发

- [ ] **步骤 1：注入 queries 与 commands**

旧 context 保留 4C 尚需依赖，同时新增 query/command 服务；不要让兼容类重新构造它们。

- [ ] **步骤 2：逐方法转发**

已迁出的 create/get/fork/update/archive/delete 只做参数兼容和 return await。删除旧方法体和专用 helper。

- [ ] **步骤 3：检查残留**

运行：git diff --word-diff=plain -- packages/server/src/application/session/session-application-service.ts

确认 edit/admit/resume/queue/control 方法未变。

- [ ] **步骤 4：验证并提交**

运行 SessionApplication 全套测试和 HTTP session route 测试。
提交：git commit -m "refactor(server): delegate session query and commands"

### 任务 5：Route、Daemon 接线和收尾

- [ ] **步骤 1：Daemon 构造一次服务**

先构造 queries、commands，再把同一实例传给兼容门面和 DurableAgentApplication 属性。不得在 Route new Service。

- [ ] **步骤 2：迁移 Route**

只在不改变公共 application 接口时让 Route 使用 queries/commands；若 DurableAgentApplication 尚未暴露 commands，保留 sessions 兼容入口，不扩协议。

- [ ] **步骤 3：新增依赖护栏**

SessionCommand 不可导入 HTTP/Daemon；Query 不可导入 Runtime；Route 不可 Store/Repository。

- [ ] **步骤 4：最终验证**

运行 Server 全量、Services 回归、全仓类型、architecture/docs/diff 检查。

- [ ] **步骤 5：更新指标和提交**

记录 SessionApplicationService 行数和 context.store 调用下降。只标 4B 完成。
提交：git commit -m "chore: close session query command extraction"

## 审核重点

Query 绝不写状态；Command 不接管 Prompt/Run；archive 的 live/durable 顺序保持；旧门面不保留重复逻辑；Route 协议不变。
