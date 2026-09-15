# Session Runtime 阶段 3D：增量输出与 Checkpoint 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（- [ ]）语法来跟踪进度。

**目标：** 将 Message Part 文本增量、延迟 checkpoint 和强制刷盘从 SessionStore 提取为独立模块，并证明 terminal、事务和关闭场景不会丢失最后一段输出。

**架构：** IncrementalOutput 更新 read model 并使用现有 DeltaCheckpoint 累积 dirty part；达到字节/时间阈值时只刷相关 Part、Message、Session。TransactionCoordinator 决定事务内提交/回滚，Store close 和 Run terminal 路径显式要求最终 flush。

**技术栈：** TypeScript、Vitest、better-sqlite3、DeltaCheckpoint、TransactionCoordinator、ConversationRepository、pnpm。

---

## 开工条件与范围

- 只能基于复审通过的 3C。
- 不改变 SSE payload、delta 文本拼接、flush 默认阈值、数据库 schema 或 Run 状态机。
- 不把普通 MessagePart upsert 合并进 IncrementalOutput。
- 不增加后台定时器；继续使用调用时检查 interval 的现有策略。
- 不为性能猜测添加批处理框架；保留当前 prepare/loop 语义，除非基准证明需要更改。
- terminal、close、backup/compaction 等完整性边界必须检查，但只修改确实依赖 flush 的入口。

## 文件

- 创建 packages/services/src/conversations/incremental-output.ts
- 创建 packages/services/src/conversations/incremental-output.test.ts
- 修改 packages/services/src/conversations/index.ts
- 修改 packages/services/src/database/delta-checkpoint.ts 及测试
- 修改 packages/services/src/database/transaction-coordinator.ts 及测试
- 修改 packages/services/src/session-runtime/store.ts 及 durability 测试
- 修改 Server transcript projection/run executor 的窄 capability 类型和测试（仅接线）
- 收尾修改 architecture baseline、迁移状态和总体设计状态。

## 必须保持的运行规则

- append 的 part 必须存在，且 session/message 关系不变。
- 只允许当前实现接受的 Part 类型和状态接收 delta。
- delta 同步追加到内存 text，更新 Part、Message、Session 的 updatedAt。
- 未达阈值时 SQLite 可暂时落后，查询仍看到最新内存值。
- 达到 byte threshold 或 interval threshold 后刷盘。
- 事务内不得单独提交；rollback 后 text、时间戳和 dirty checkpoint 回到事务前。
- Run terminal、相关恢复动作、Store close、必要的 backup/compact 前必须完整 flush。
- flush 成功后才从 dirty 集合删除；SQL 失败必须保留 dirty，允许重试。
- SSE 继续由上层决定 durable/transient 可见性，本模块不发布事件。

### 任务 1：固定增量输出特征测试

**文件：**
- 修改 packages/services/src/session-runtime 现有 delta/durability 测试
- 修改 packages/services/src/database/delta-checkpoint.test.ts

- [ ] **步骤 1：盘点所有入口**

运行：rg -n "appendMessagePartDelta|flushMessagePartDeltas|deltaCheckpoint|DEFAULT_DELTA_FLUSH|flush.*Delta" packages/services packages/server/src

列出生产调用、terminal 调用、close、backup、compaction 和测试覆盖。

- [ ] **步骤 2：补充阈值测试**

使用可控 bytes 与 clock：阈值下 append 后内存为完整 text、SQLite 仍为旧 text；超过 byte threshold 后 SQLite 更新；推进时间超过 interval 后下一次 append 触发 flush。

- [ ] **步骤 3：补充完整性边界测试**

分别验证显式 flush、Run terminal、interrupt/recovery、Store close、backup/compact 前后的 reopen 文本完整。

- [ ] **步骤 4：补充失败测试**

模拟 SQL update 抛错，断言 dirty ids 仍存在；重试 flush 后写入成功。atomic 内 append 后抛错，断言内存 text、时间戳和 dirty 状态恢复。

- [ ] **步骤 5：运行旧实现**

运行：pnpm --filter @openharness/services test -- src/database/delta-checkpoint.test.ts src/session-runtime

预期：PASS；若发现旧实现无法满足规格，停止迁移并把它作为独立 bug 报告，不在搬迁 commit 中暗修。

- [ ] **步骤 6：提交**

运行：git add packages/services/src/database/delta-checkpoint.test.ts packages/services/src/session-runtime
运行：git commit -m "test(services): lock incremental output durability"

### 任务 2：增强 DeltaCheckpoint 的明确契约

**文件：**
- 修改 packages/services/src/database/delta-checkpoint.ts
- 修改 packages/services/src/database/delta-checkpoint.test.ts

- [ ] **步骤 1：先测试 snapshot/restore 和 flush 失败保留**

若 3C 已实现 snapshot/restore，只补缺失断言；禁止创建第二种快照类型。测试 mark、delete、dirtyPartIds、reachedThreshold、reset-after-success 和 restore。

- [ ] **步骤 2：验证红灯**

运行：pnpm --filter @openharness/services test -- src/database/delta-checkpoint.test.ts

- [ ] **步骤 3：实现最小 API**

只暴露 IncrementalOutput 和 TransactionCoordinator 实际需要的 mark/delete/dirty/reachedThreshold/snapshot/restore。不要暴露内部 Set。

- [ ] **步骤 4：验证并提交**

运行：pnpm --filter @openharness/services test -- src/database/delta-checkpoint.test.ts src/database/transaction-coordinator.test.ts
运行：git add packages/services/src/database
运行：git commit -m "refactor(services): formalize delta checkpoint lifecycle"

### 任务 3：创建 IncrementalOutput

**文件：**
- 创建 packages/services/src/conversations/incremental-output.ts
- 创建 packages/services/src/conversations/incremental-output.test.ts
- 修改 packages/services/src/conversations/index.ts

- [ ] **步骤 1：写模块级失败测试**

直接构造 IncrementalOutput，覆盖 append、显式 flush、byte/interval threshold、missing part、非法状态、父级 updatedAt 和 clone/查询可见性。

- [ ] **步骤 2：确认红灯**

运行：pnpm --filter @openharness/services test -- src/conversations/incremental-output.test.ts

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现 append**

接口保持 appendMessagePartDelta(input: AppendMessagePartDeltaInput): SessionEventRecord。先校验，再更新 read model 和 checkpoint。达到阈值时调用 flush；事务内 flush 服从 coordinator，不直接 commit。

- [ ] **步骤 4：实现 flush**

接口 flushMessagePartDeltas(): void。复制 dirty id 列表；在一个数据库事务/outer atomic 内更新 Part text/updatedAt，再更新受影响 Message 和 Session updatedAt；全部成功后删除 checkpoint。失败时不删除。

- [ ] **步骤 5：不复制 SQL 映射**

优先复用 3B ConversationRepository 的 package-private persistence 原语或把 delta 专用 SQL唯一放在 IncrementalOutput。Store 中相同 SQL 必须在接线时删除。

- [ ] **步骤 6：验证并提交**

运行：pnpm --filter @openharness/services test -- src/conversations/incremental-output.test.ts src/database
运行：pnpm --filter @openharness/services check-types
运行：git add packages/services/src/conversations
运行：git commit -m "refactor(services): extract incremental message output"

### 任务 4：接入 Store 并删除旧实现

**文件：**
- 修改 packages/services/src/session-runtime/store.ts
- 修改 packages/services/src/session-runtime 相关测试

- [ ] **步骤 1：构造单一实例**

新增 readonly 或私有 incrementalOutput，接收与 ConversationRepository 相同 StorageContext。公开性由真实 Server 调用决定，不为对称性导出。

- [ ] **步骤 2：旧方法只转发**

appendMessagePartDelta 和 flushMessagePartDeltas 改为转发；删除 Store 内 persistDeltaPartRows 及仅服务该逻辑的 SQL/helper。

- [ ] **步骤 3：close 顺序**

close 必须先完整 flush，再关闭数据库；flush 失败不得悄悄清空 dirty。保持 owner lease release 的既有先后顺序，并由测试锁定。

- [ ] **步骤 4：检查残留**

运行：rg -n "deltaCheckpoint|persistDeltaPartRows|dirtyPartIds|reachedThreshold" packages/services/src/session-runtime/store.ts

预期：只剩构造/close 所需引用或完全没有；每个保留项写入交付说明。

- [ ] **步骤 5：验证并提交**

运行：pnpm --filter @openharness/services test -- src/conversations src/session-runtime src/database
运行：pnpm --filter @openharness/services check-types
运行：git add packages/services/src/session-runtime packages/services/src/conversations
运行：git commit -m "refactor(services): delegate incremental output persistence"

### 任务 5：接通 terminal、恢复、backup 和 compact 边界

**文件：**
- 修改实际调用 flush 的 Services/Server 文件
- 修改对应测试

- [ ] **步骤 1：建立边界矩阵**

对 complete/failed/interrupted Run、settle attempts、daemon restart recovery、archive close、Store close、backup、compact 逐一标记是否要求 flush。只为会产生未刷 delta 的路径加调用。

- [ ] **步骤 2：先写集成失败测试**

每条路径先 append 低于阈值的 delta，触发边界，关闭并重开数据库，断言最后文本存在且 Part/Message/Session updatedAt 一致。

- [ ] **步骤 3：通过窄 capability 接线**

Server 只获得 flush 或 terminalize 所需能力，不 import IncrementalOutput 具体类。若 3C Transaction 已在 terminal 动作内统一 flush，调用方不得重复 flush。

- [ ] **步骤 4：验证 Server 投影**

运行：pnpm --filter @openharness/server test -- src/application/session/__test__/transcript-projection.test.ts src/application/session/__test__/session-run-executor.test.ts src/application/session/__test__/session-run-engine.test.ts

- [ ] **步骤 5：提交**

运行：git add packages/services packages/server
运行：git commit -m "refactor: flush incremental output at durability boundaries"

### 任务 6：事务与可见性复核

**文件：**
- 修改 incremental-output.test.ts
- 修改 transaction-coordinator.test.ts
- 修改相关 SSE/HTTP 测试

- [ ] **步骤 1：验证嵌套 atomic**

outer atomic 内 append 多次并调用 flush，嵌套返回时 SQLite 不提前提交；outer commit 后一次可见；outer rollback 全部恢复。

- [ ] **步骤 2：验证事件/通知时序**

对外 observer 在 commit 前不能读到标记为 durable 的新状态；rollback 不产生 Task listener 或 durable SSE 假通知。Transient SSE 保持现有规则。

- [ ] **步骤 3：验证 flush 失败可恢复**

第一次 flush SQL 失败，第二次正常；断言文本不重复追加、dirty 仍存在、最终 SQLite 只有一次完整结果。

- [ ] **步骤 4：运行定向集成**

运行：pnpm --filter @openharness/services test -- src/conversations src/database src/session-runtime
运行：pnpm --filter @openharness/server test -- src/application/session src/http

- [ ] **步骤 5：提交**

运行：git add packages/services packages/server
运行：git commit -m "test: verify incremental output commit visibility"

### 任务 7：阶段 3 总收尾

**文件：**
- 修改 scripts/architecture-boundaries.mjs 及测试（仅缺少规则时）
- 修改 scripts/architecture-baseline.json（仅下降）
- 修改 docs/architecture-migration-status.md
- 修改 docs/superpowers/specs/2026-09-15-session-conversation-run-extraction-design.md

- [ ] **步骤 1：核对 Stage 3 完成条件**

SessionStore 只剩组合、兼容转发、进程内 listener 协调、生命周期/close；三域 SQL、状态转换、事务实现和 delta SQL 已移走。

- [ ] **步骤 2：搜索残留**

运行：
rg -n "INSERT INTO session_|UPDATE session_|DELETE FROM session_" packages/services/src/session-runtime/store.ts
rg -n "transactionDepth|saveRequested|persistDeltaPartRows" packages/services/src/session-runtime/store.ts
rg -n "context\.store\." packages/server/src packages/services/src

对每个非零结果说明为什么必须保留；不可用注释压过 checker。

- [ ] **步骤 3：更新真实指标**

记录 Store 最终行数、sessionStoreFlatCalls、各新模块行数、测试数量和失败注入数量。baseline 只能下降。

- [ ] **步骤 4：运行最终验证**

运行：
pnpm --filter @openharness/services test
pnpm --filter @openharness/services check-types
pnpm --filter @openharness/server test -- src/application/session src/permissions src/jobs src/http
pnpm --filter @openharness/server check-types
node --test scripts/architecture-boundaries.test.mjs
pnpm check:architecture
node scripts/check-docs.mjs
git diff --check
git status --short

可补充运行 pnpm test。若出现已知 WSL/node-pty 并发失败，记录测试名、首个错误和单独重跑结果，不声称全仓通过。

- [ ] **步骤 5：两轮审查**

先做规格覆盖审查，再做代码质量审查。Important 及以上全部修复并复审；确认没有提前开始阶段 4。

- [ ] **步骤 6：提交文档收尾**

更新总体设计状态为已完成，迁移状态标记阶段 3 完成、阶段 4 未开始。
提交：git commit -m "chore: complete session runtime repository extraction"

## 审核重点

未达阈值时内存领先 SQLite是有意设计；所有完整性边界必须最终刷盘。审核者重点检查 flush 成功前不清 dirty、rollback 恢复 text/时间戳/checkpoint、terminal/close 不丢尾部、嵌套事务不提前可见，以及 Store 不残留第二套 delta SQL。
