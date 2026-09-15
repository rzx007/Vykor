# Server 阶段 4D：Session Lane 与 Run Executor 边界实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（- [ ]）语法来跟踪进度。

**目标：** 让 Runtime 唯一拥有 Session 内 live 排队/中断句柄，让 SessionRunExecutor 只执行一个已 admission 的 durable Run。

**架构：** 优先扩展现有 SessionRunCoordinator，不为“Lane”名字新建重复 registry。Runtime map 只保存 id、Promise、AbortController 等 live 数据；所有 durable 状态从窄 capability 查询和提交。

**技术栈：** TypeScript、Vitest、Promise/AbortSignal、SessionRunCoordinator、AgentPool、Services Run capability、pnpm。

---

## 硬边界

- Runtime 不保存完整 SessionRunRecord/SessionRecord 快照。
- Executor 不做 admission、queue/steer 或 HTTP 解析。
- 一个 Session 的 active/queued 规则只有一个所有者。
- stale completion 不能覆盖已经 interrupted/terminal 的 durable Run。
- shutdown 必须阻止新 enqueue，并等待或中断现有 work。

### 任务 1：固定 Runtime 并发特征

- [ ] **步骤 1：审计 run-coordinator**

列出 map 的 key/value、enqueue、promotion、interrupt、completion、drain、close 和所有回调。

- [ ] **步骤 2：补竞态测试**

使用 controllable Promise 覆盖同 Session 两个 Run、不同 Session 并行、queued cancel、active interrupt、interrupt 与 completion 同时、stop 后 enqueue、stale completion、wait abort。

- [ ] **步骤 3：断言 live entry 只含 id/handle**

测试或类型断言禁止把 SessionRunRecord 放入 coordinator entry。

- [ ] **步骤 4：运行旧实现并提交**

运行 runtime/run-coordinator.test.ts 和 session-run-engine tests。
提交：git commit -m "test(server): lock session runtime lane contracts"

### 任务 2：把 SessionRunCoordinator 收敛为唯一 Lane

- [ ] **步骤 1：写最小 Runtime 接口红灯**

接口含 enqueue、dispatch、activeId、queuedIds、interrupt、cancelQueued、wait、stopAndDrain；返回 id/状态枚举，不返回 durable record。

- [ ] **步骤 2：复用现实现**

若现有 coordinator 已覆盖，不新建 SessionLane 类，只重命名内部类型或补方法。若存在第二个 queue map，从 Engine 删除并迁到 coordinator。

- [ ] **步骤 3：验证状态转换回调**

Runtime 通过 onStarted/onCompleted/onInterrupted 回调请求 Application 持久化；回调失败按现有策略终止 live work并传播，不直接改 Store。

- [ ] **步骤 4：验证提交**

运行 coordinator + admission/control 集成测试。
提交：git commit -m "refactor(server): make run coordinator the session lane owner"

### 任务 3：收窄 SessionRunExecutor

**文件：**
- 修改 session-run-executor.ts/test.ts

- [ ] **步骤 1：建立执行顺序测试**

断言读取 Session/Input/Run → Agent acquire → Attempt running → event projection → terminal transaction → maintenance。分别覆盖成功、provider error、abort、投影失败、terminal event 已发出。

- [ ] **步骤 2：定义窄 context**

分为 sessionQueries、runTransactions、attachments、agentProvider、transcriptProjection、events、postRunMaintenance、observability。禁止 store: SessionStore。

- [ ] **步骤 3：迁移类型和调用**

把 Pick 类型放到使用文件；transaction 由一个窄 atomic capability 提供。不要在 Executor 复制 admission/queue。

- [ ] **步骤 4：验证错误归属**

catch 只处理 Agent 尚未发出终态的路径；已终态不能再次 updateRun。Attempt 和 Run 同事务收尾。

- [ ] **步骤 5：提交**

运行 executor、projection、services transaction 测试和类型检查。
提交：git commit -m "refactor(server): narrow single run executor"

### 任务 4：AgentPool、LiveChild 和 OperationGate 边界

- [ ] **步骤 1：类型审计**

确认 AgentPool 只保存 live Agent；LiveChild 只保存 child entry；OperationGate 只保存 lease/counter。 durable id 可以保存，durable record 不保存。

- [ ] **步骤 2：补 stale/restart 测试**

关闭并重新构造 Runtime，断言旧 handle 不恢复；durable active record 交由 4E Recovery，而不是自动放回 live map。

- [ ] **步骤 3：收窄互相依赖**

Executor/Control 通过接口使用 AgentPool；这些 Runtime 类不导入 DaemonApplication、HTTP 或 Repository。

- [ ] **步骤 4：提交**

提交：git commit -m "refactor(server): separate durable records from live handles"

### 任务 5：shutdown 和阶段收尾

- [ ] **步骤 1：集成 shutdown 测试**

同时存在 active、queued、child、terminal 和 operation lease；shutdown 后新操作拒绝，active 被按现语义终止，queued 有 durable terminal，所有 wait 完成。

- [ ] **步骤 2：迁移 Daemon control**

DaemonControlService 调用 RunControl/Runtime 的 stopAndDrain，不遍历 Store 自己推导 live 状态。

- [ ] **步骤 3：架构护栏**

Runtime 禁止 HTTP/Daemon/Repository；新增生产代码禁止 live entry 包含 SessionRunRecord 类型。

- [ ] **步骤 4：最终验证和状态**

Server 全量、Services 回归、类型、架构、文档、diff；只标 4D 完成。
提交：git commit -m "chore: close server runtime lane extraction"

## 审核重点

竞态测试必须真实控制 Promise；Runtime 不复制 durable record；Executor 单次执行；shutdown 不丢 queued/active 状态；不要创建与 coordinator 重复的 Lane 空壳。
