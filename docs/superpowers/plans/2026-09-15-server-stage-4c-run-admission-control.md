# Server 阶段 4C：Run Admission 与 Control 拆分实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（- [ ]）语法来跟踪进度。

**目标：** 从 SessionApplicationService 和 SessionRunEngine 中提取 RunAdmissionService 与 RunControlService，分别拥有输入接纳和运行控制规则。

**架构：** Admission 负责把用户输入变成 durable Input/Run 并交给 Runtime queue；Control 负责查询、等待、中断、取消和提升。SessionRunEngine 暂时成为兼容门面，不执行重复业务规则。

**技术栈：** TypeScript、Vitest、SessionStore 窄事务 capability、SessionRunCoordinator、ApplicationError、pnpm。

---

## 方法映射

Admission：
- persistGoalRun；
- replaceTranscriptAndAdmitPrompt；
- replaceLatestPrompt；
- replayInput；
- admitPromptAndMaybeRun；
- admitPrompt；
- owning Run 幂等恢复；
- input materialization 调用顺序。

Control：
- dispatchPersistedRun；
- hasUserWork/hasWork/hasAnyActiveRuns；
- activeRunId/queuedRunIds；
- promoteQueuedRun；
- interruptSession/interruptRun/interruptQueuedRun；
- awaitRun/waitForRuns；
- cancelGoalRuns；
- hasActiveRunsForCwd；
- stopAndDrain。

Executor 不在 4C 修改业务体。

### 任务 1：固定 admission/control 契约

- [ ] **步骤 1：列出分支矩阵**

对 queue/steer、active/idle、existing input/run、attachment、goal run、edit、replay、resume、cancel/promote、interrupt、await timeout/abort 建表。

- [ ] **步骤 2：补 Characterization 测试**

重点加入同 id 重试、steer 降级、queued promotion、用户消息优先、goal revision 变化、terminal idempotency 和 close drain。

- [ ] **步骤 3：运行旧实现**

运行：pnpm --filter @openharness/server test -- src/application/session/__test__/session-run-engine.test.ts src/application/session/__test__/session-application-service-queue-actions.test.ts src/application/session/__test__/session-application-service-edit.test.ts

- [ ] **步骤 4：提交**

提交：git commit -m "test(server): lock run admission and control contracts"

### 任务 2：提取 RunAdmissionService

**文件：**
- 创建 session/run-admission-service.ts/test.ts
- 修改 session/session-input-materializer.ts 的窄依赖

- [ ] **步骤 1：定义最小 context**

包含 sessionQueries、conversationTransactions、runQueries/writes、materializer、runtimeQueue、events 和 attachment limits；不接收 Store/Daemon。

- [ ] **步骤 2：写普通 admission 红灯**

测试 idle 立即 dispatch、busy queue、steer active、attachment steer→queue、existing owning Run 幂等、输入冲突不创建 Run。

- [ ] **步骤 3：实现 admission 核心**

复用 Services admitPromptWithRun/admitPrompt 事务。先持久化，再将 runId 交给 Runtime；Runtime enqueue 失败的现有补偿语义保持。

- [ ] **步骤 4：写 edit/replay/resume 红灯**

分别验证 replace transaction、source ownership、metadata、explicit id 和 terminal source。实现时不复制 Services 事务规则。

- [ ] **步骤 5：写 goal admission 红灯**

保持 goalId/revision/runKind、用户工作优先和取消旧 goal run 的规则。

- [ ] **步骤 6：验证提交**

运行 admission、materializer、goal 相关测试和 Server 类型检查。
提交：git commit -m "refactor(server): extract run admission service"

### 任务 3：提取 RunControlService

**文件：**
- 创建 session/run-control-service.ts/test.ts

- [ ] **步骤 1：定义 durable/live 分栏 context**

durableRuns 只查询/更新 record；runtime 只用 active/queued/enqueue/interrupt/wait/stop。不要让 runtime 返回完整 SessionRunRecord。

- [ ] **步骤 2：写查询控制红灯**

activeRunId、queuedRunIds、hasWork、hasActiveRunsForCwd 以现有顺序和 archived 行为断言。

- [ ] **步骤 3：写 promote/cancel 红灯**

验证 queued ownership、active 冲突、durable event、idempotency 和不存在错误。

- [ ] **步骤 4：写 interrupt/await/stop 红灯**

覆盖 active/queued/terminal、abort、timeout、并发 interrupt、stopAndDrain 等待所有 live work。

- [ ] **步骤 5：实现最小控制服务**

只迁控制规则。终态持久化仍走 Services transaction/Run capability；不得直接修改 runtime map 内的 durable status 副本。

- [ ] **步骤 6：验证提交**

提交：git commit -m "refactor(server): extract run control service"

### 任务 4：收缩 SessionRunEngine 与 SessionApplicationService

- [ ] **步骤 1：注入 Admission/Control**

Engine 构造只持两个服务和 4D 尚需的执行兼容依赖。SessionApplicationService 的 edit/admit/resume/interrupt/promote/cancel/await 转发到相应服务。

- [ ] **步骤 2：删除迁出方法体**

保留公共签名。内部方法若无调用则删除；不得留 deprecated 实现副本。

- [ ] **步骤 3：搜索规则重复**

运行：rg -n "admitPromptWithRun|replaceLatestPromptWithAdmission|promoteQueued|interruptQueued|cancelGoalRuns" packages/server/src/application/session -g "*.ts" -g "!*.test.ts"

每条规则应只有一个 Application 所有者，兼容转发除外。

- [ ] **步骤 4：验证提交**

运行 Session 全套及 HTTP queue/edit/retry 测试。
提交：git commit -m "refactor(server): delegate run admission and control"

### 任务 5：调用方、架构和收尾

- [ ] **步骤 1：迁移内部调用方**

Goal、Schedule、Channel、Control 和 Maintenance 使用 admission/control 窄接口。Route 保持 DurableAgentApplication 兼容入口。

- [ ] **步骤 2：架构测试**

禁止 Admission 导入 HTTP/Daemon；Control 不导入 Executor 具体实现；Runtime 不返回 protocol durable record 作为 live 状态。

- [ ] **步骤 3：最终验证**

Server 全量、Services 回归、类型、architecture/docs/diff。记录 Engine 和 SessionApplicationService 行数、context.store 调用下降。

- [ ] **步骤 4：提交状态**

只标 4C 完成、4D 未开始。
提交：git commit -m "chore: close run admission control extraction"

## 审核重点

Admission 先 durable 再 live；Control 不执行模型；queue/steer/replay/resume 兼容；旧门面只转发；没有两套 owning Run 或 terminal 规则。
