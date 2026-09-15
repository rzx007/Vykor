# Server 阶段 4E：Projection、Recovery 与 Maintenance 收口实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（- [ ]）语法来跟踪进度。

**目标：** 为 transcript/execution projection、启动恢复和维护流程建立唯一所有者，并从 DaemonApplication 构造函数移出具体恢复步骤。

**架构：** Projection 把 live event 转成 durable 记录但不管理 subscriber；StartupRecoveryService 按固定顺序恢复并决定 ready 成败；Maintenance 只处理显式 compact/archive 与 post-run 收尾。

**技术栈：** TypeScript、Vitest、真实临时 SQLite、Agent events、Services transactions、pnpm。

---

## 文件

- 修改 session/transcript-projection.ts 及测试。
- 修改 session/session-execution-projector.ts 及测试。
- 修改 agent/daemon-agent-event-projector.ts 及测试。
- 创建 recovery/startup-recovery-service.ts/test.ts/index.ts。
- 修改 session/session-maintenance-service.ts、session-post-run-maintenance.ts。
- 修改 daemon-application.ts、session-event-publisher.ts、相关测试和文档。

### 任务 1：固定 Projection 所有权

- [ ] **步骤 1：建立 Agent event 映射表**

对 message start/text delta/part complete/tool start/tool result/usage/stop、child agent/process event 列出 durable Message/Part/Task/Event 和 transient event。

- [ ] **步骤 2：搜索重复 mapper**

运行：rg -n "createMessage|upsertMessagePart|appendMessagePartDelta|createSessionTask|updateSessionTask" packages/server/src/application/agent packages/server/src/application/session

标记每个规则当前所有者。

- [ ] **步骤 3：补真实行为测试**

输入真实 AgentEvent，查询 Store 断言 durable 结果；失败注入验证 settlement retry/resolve/fail；subscriber 只收到 commit 后事件。

- [ ] **步骤 4：提交**

提交：git commit -m "test(server): lock projection ownership contracts"

### 任务 2：收敛 Transcript 与 Execution Projection

- [ ] **步骤 1：定义窄 capability**

Transcript 只需 conversation/run 写与 transient event sink；Execution 只需 Task 写、child bridge 和 event publisher。不接 Store。

- [ ] **步骤 2：把重复规则移到对应 Projection**

DaemonAgentEventProjector 只做 AgentEvent 路由和必要 settlement 编排；Message/Part 细节由 TranscriptProjection；Task 细节由 ExecutionProjector。

- [ ] **步骤 3：保持事件顺序**

durable 写提交后 publishSince；text delta 返回 transient event 直接发布，但不得进入 listEvents。

- [ ] **步骤 4：验证和提交**

运行三组 projector tests、session run executor 和 HTTP SSE tests。
提交：git commit -m "refactor(server): converge session event projections"

### 任务 3：创建 StartupRecoveryService

- [ ] **步骤 1：从 Daemon 列出真实恢复顺序**

包括 Permission、Task/Run/Attempt、orphan Input、closing Session、Workflow、Projection Settlement、Background shell/child 清理。以当前构造执行顺序为兼容依据。

- [ ] **步骤 2：写真实 SQLite 红灯**

构造 active/orphan/closing 状态，调用 recovery.run，close/reopen 验证；第二次 run 幂等。每一步注入失败，断言 Promise reject。

- [ ] **步骤 3：定义接口**

    interface StartupRecoveryStep {
      name: string;
      run(): void | Promise<void>;
    }

若只有固定步骤，不建立通用插件 registry；可直接在 Service 中显式调用命名 capability，保证顺序清楚。

- [ ] **步骤 4：实现并从 Daemon 接线**

Daemon 只保存 startupRecovery.run() 返回的 Promise；ready await 它。catch 只用于避免未处理 rejection，不能把 ready 改成功。

- [ ] **步骤 5：验证和提交**

提交：git commit -m "refactor(server): extract startup recovery service"

### 任务 4：收窄 Maintenance

- [ ] **步骤 1：固定 compact/archive/post-run 流程**

测试 operation gate、active run conflict、transcript replace、attachment reference、memory/dream failure 和返回数据。

- [ ] **步骤 2：SessionMaintenance 使用 Command/Control capability**

不接完整 Store/Engine/AgentPool；显式维护与 startup recovery 分开。

- [ ] **步骤 3：PostRunMaintenance 只处理一次 Run**

输入 sessionId/runId；读取 transcript/context，执行 memory/dream。不得改变 queue 或启动新 Run，除非现有明确行为要求。

- [ ] **步骤 4：验证和提交**

提交：git commit -m "refactor(server): narrow session maintenance services"

### 任务 5：恢复、ready、SSE 集成

- [ ] **步骤 1：ready 失败测试**

任一 recovery step 抛错，Daemon ready reject；HTTP readiness 不可报告 ready；close 仍释放已构造资源。

- [ ] **步骤 2：commit 可见性测试**

Projection/Recovery 写入后 publish；回滚不 publish；subscriber 注册竞态仍由 cursor + publishSince 解决。

- [ ] **步骤 3：restart E2E 定向**

启动 Store 写 active 状态，关闭模拟崩溃，创建新 Application，await ready，验证终态和 SSE history。

- [ ] **步骤 4：架构与状态收尾**

禁止 Projection 导入 subscriber 实现，Recovery 导入 HTTP，Maintenance 持完整 Store。标 4E 完成、4F 未开始。

- [ ] **步骤 5：最终验证提交**

Server 全量、Services、types、architecture/docs/diff。
提交：git commit -m "chore: close server recovery projection stage"

## 审核重点

一个 event 只有一个 projector；Recovery 顺序可读且失败阻止 ready；Maintenance 不接管恢复；SSE durable/transient 边界不变；真实 SQLite/reopen 而非只看 mock。
