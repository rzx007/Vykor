# Session Runtime 阶段 3C：跨域事务实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（- [ ]）语法来跟踪进度。

**目标：** 把 Session、Conversation、Run 之间必须共同成功或共同失败的业务动作迁入命名明确的事务模块，并把 atomic 协调器从 SessionStore 下沉到 database 内核。

**架构：** ConversationTransactions 组合 3A/3B Repository；TransactionCoordinator 只负责 SQLite、read model、mutation、event sequence 和 delta checkpoint 的提交/回滚。业务事务不依赖 Server，数据库内核不反向依赖业务域。

**技术栈：** TypeScript、Vitest、better-sqlite3 transaction、StorageContext、MutationBuffer、DeltaCheckpoint、DurableEventSequence、pnpm。

---

## 开工条件和不可破坏约束

- 只能基于复审通过的 3B。
- 不改 schema、协议、附件产品规则、Server 排队策略和 SSE payload。
- 每个复杂事务单独提交；禁止一次搬完整个 3C。
- Transaction 可以组合 Repository，不能调用 SessionStore 或 Server Service。
- atomic 失败必须同时恢复 SQLite、SessionState、MutationBuffer、DurableEventSequence、DeltaCheckpoint 和待提交回调。
- Task listener、SSE 发布等外部副作用只能在最外层 commit 成功后发生。
- deleteSessionTree 现有“禁止嵌套 Store transaction”语义在迁移中保持，除非独立设计明确替代并有兼容测试。

## 文件

- 创建 packages/services/src/database/transaction-coordinator.ts 及测试。
- 修改 packages/services/src/database/storage-context.ts、mutation-buffer.ts、delta-checkpoint.ts、event-sequence.ts。
- 创建 packages/services/src/conversations/conversation-transactions.ts 及测试。
- 修改 packages/services/src/conversations/index.ts。
- 修改 packages/services/src/session-runtime/store.ts 及事务/恢复测试。
- 按实际依赖修改 Attachment/Permission 等现有 Repository 的窄协作者，不重写其业务。
- 收尾修改 architecture checker/baseline 和迁移状态。

## 事务清单

1. admitPrompt：Input、附件引用、Session seq/title/updatedAt、event、幂等指纹。
2. admitPromptWithRun：admitPrompt 与 owning Run 原子绑定；steer 特例保持现状。
3. replaceTranscriptAndAdmitPrompt：替换历史、重新 admission、可选 Run。
4. createReplayRun：source Input 校验与 replay Run 幂等。
5. replaceLatestPromptWithAdmission：删除被替换历史、附件引用、Run/Attempt/Part 后再 admission。
6. forkSessionWithHistory：创建 fork，复制 Input/reference/Message/Part 映射，保持边界 before/after。
7. deleteSessionTree：跨所有域删除，清理 delta、permission、task、run、attempt、event 和附件引用。
8. interrupt/settle/recovery：active Task、Run、Attempt、running Part、orphan Input、closing Session。
9. getSessionState：单 cursor 的跨域一致快照，只读但属于事务视图。

### 任务 1：建立通用失败注入测试夹具

**文件：**
- 创建 packages/services/src/database/transaction-coordinator.test.ts
- 修改测试工厂文件

- [ ] **步骤 1：定义可控失败点**

测试夹具提供 beforeFlush、afterMutationSql、beforeCommit 三个同步 hook，仅测试环境注入。生产默认不分配 hook 对象。

- [ ] **步骤 2：写失败测试**

在 atomic 内依次修改 Session、写 event、标记 part dirty，再从每个 hook 抛错。断言内存查询恢复、dirty ids 恢复、数据库关闭重开无修改、commit callback 未运行。

- [ ] **步骤 3：验证当前实现至少一个场景失败**

运行：pnpm --filter @openharness/services test -- src/database/transaction-coordinator.test.ts

预期：FAIL，TransactionCoordinator 尚不存在或 Store 私有 coordinator 无法满足独立测试。

- [ ] **步骤 4：提交测试护栏**

运行：git add packages/services/src/database
运行：git commit -m "test(services): define storage transaction rollback contract"

### 任务 2：下沉 TransactionCoordinator

**文件：**
- 创建 packages/services/src/database/transaction-coordinator.ts
- 修改 packages/services/src/database/storage-context.ts
- 修改 packages/services/src/database/mutation-buffer.ts
- 修改 packages/services/src/database/delta-checkpoint.ts
- 修改 packages/services/src/database/event-sequence.ts
- 修改 packages/services/src/session-runtime/store.ts

- [ ] **步骤 1：为四类内存状态提供显式 snapshot/restore**

复用 cloneMutationBuffer；为 SessionState 使用当前 Store 已验证的 clone；DeltaCheckpoint 和 DurableEventSequence 增加最小 snapshot/restore，不暴露内部可变集合。

- [ ] **步骤 2：实现最外层与嵌套语义**

Coordinator 保存 depth。depth=1 时建立快照并打开 better-sqlite3 transaction；嵌套 atomic 只执行 callback。最外层成功才 flush/commit；任何层抛错都由最外层恢复。

- [ ] **步骤 3：实现 afterCommit 队列**

提供 deferUntilCommit(callback)。无事务时 callback 在持久化成功后立即执行；事务内排队；rollback 丢弃；嵌套不得提前执行。该能力用于 listener/SSE 等进程副作用。

- [ ] **步骤 4：替换 StorageContext.atomic 实现**

StorageContext 仍暴露 atomic 和 assertWritable，业务代码无需知道 coordinator 类型。database 目录不得导入 conversations/runs/sessions。

- [ ] **步骤 5：运行验证**

运行：pnpm --filter @openharness/services test -- src/database src/session-runtime
运行：pnpm --filter @openharness/services check-types

- [ ] **步骤 6：提交**

运行：git add packages/services/src/database packages/services/src/session-runtime/store.ts
运行：git commit -m "refactor(services): move transaction coordination into database"

### 任务 3：迁移 Prompt admission

**文件：**
- 创建 packages/services/src/conversations/conversation-transactions.ts
- 创建 packages/services/src/conversations/conversation-transactions.test.ts
- 修改 packages/services/src/session-runtime/store.ts

- [ ] **步骤 1：固定 admission 测试矩阵**

覆盖纯文本、structured items、空输入、同 id 同内容幂等、同 id 不同内容冲突、delivery steer、seq、初始标题、trace metadata；附件不存在/deleted/not-ready/mime/size/file-count/prompt-bytes/session-bytes；引用 position 和 referenced bytes。

- [ ] **步骤 2：加入失败注入**

分别在 Input 写入后、附件引用中途、标题更新后、event 分配后抛错；每次断言无 Input、无引用、Session seq/title 不变、无事件，重启结果一致。

- [ ] **步骤 3：验证红灯**

运行：pnpm --filter @openharness/services test -- src/conversations/conversation-transactions.test.ts

- [ ] **步骤 4：实现 admitPrompt**

原样迁移 normalizeSessionUserInputItems、normalizePromptAttachments、fingerprint、limits、title、metadataWithoutTrace 等规则。Transaction 通过 Repository 内部写原语完成，不能调用 Store 公共方法形成递归保存。

- [ ] **步骤 5：Store 转发并验证**

运行：pnpm --filter @openharness/services test -- src/conversations src/attachments src/session-runtime
运行：pnpm --filter @openharness/services check-types

- [ ] **步骤 6：提交**

运行：git add packages/services/src/conversations packages/services/src/session-runtime/store.ts
运行：git commit -m "refactor(services): move prompt admission transaction"

### 任务 4：迁移 admission + Run 和 replay

**文件：**
- 修改 conversation-transactions.ts 及测试
- 修改 store.ts

- [ ] **步骤 1：写 admitPromptWithRun 测试**

覆盖普通 admission、相同 input 重试返回既有 owning run、steer 不创建 run、Run 创建失败时 Input 回滚、Input 已存在但不匹配时无新 Run。

- [ ] **步骤 2：写 createReplayRun 测试**

覆盖 source Input 不存在、显式 id 幂等、显式 id 冲突、metadata 继承和 replay ownership。

- [ ] **步骤 3：实现两个命名事务**

接口保持现有 Store 输入输出类型。复用 Repository 原语与同一个 outer atomic，不复制 admitPrompt。

- [ ] **步骤 4：验证并提交**

运行：pnpm --filter @openharness/services test -- src/conversations src/runs src/session-runtime
运行：git add packages/services/src/conversations packages/services/src/session-runtime/store.ts
运行：git commit -m "refactor(services): move run admission transactions"

### 任务 5：迁移 transcript replace 和 edit

**文件：**
- 修改 conversation-transactions.ts 及测试
- 修改 store.ts

- [ ] **步骤 1：写 replaceTranscript 测试**

覆盖清空现有 Message/Part、按输入顺序重建 seq、所有 part 字段、Session updatedAt、mutation deletion 集合、失败回滚和 reopen。

- [ ] **步骤 2：写 replaceTranscriptAndAdmitPrompt 测试**

覆盖替换后 admission、createRun true/false、Run 创建失败导致 transcript 和 admission 全部回滚。

- [ ] **步骤 3：写 replaceLatestPromptWithAdmission 测试**

覆盖 source Input/session 校验；移除目标之后的 Input/reference/Message/Part/Run/Attempt；保留目标之前数据；附件引用计数；失败回滚。

- [ ] **步骤 4：实现并逐个提交**

replaceTranscript 可以是 Transaction 私有原语；公开兼容入口保持原签名。每完成一个动作先跑测试再提交，避免一个大 commit。

提交标题依次使用：
refactor(services): move transcript replacement transaction
refactor(services): move prompt edit transaction

### 任务 6：迁移 forkSessionWithHistory

**文件：**
- 修改 conversation-transactions.ts 及测试
- 修改 store.ts

- [ ] **步骤 1：固定复制矩阵**

覆盖完整 fork、beforeMessageId、afterMessageId、边界 id 不存在、Input 去重映射、附件引用 position、Message inputId/runId 关系、Part 字段、Session parent/project/cwd/title/model/agent/metadata。

- [ ] **步骤 2：测试中途失败**

在 fork Session 创建后、Input 复制中、Message 复制中、Part 复制中抛错；断言没有残留 child 或复制记录。

- [ ] **步骤 3：实现映射**

id map 必须局部存在于一次事务；不要把映射放入 Repository 状态。复用 Session create 和 Conversation 内部 create 原语，避免产生不属于现有行为的额外事件。

- [ ] **步骤 4：验证并提交**

运行：pnpm --filter @openharness/services test -- src/conversations/conversation-transactions.test.ts src/session-runtime
运行：git add packages/services/src/conversations packages/services/src/session-runtime/store.ts
运行：git commit -m "refactor(services): move session fork transaction"

### 任务 7：迁移 deleteSessionTree

**文件：**
- 修改 conversation-transactions.ts 及测试
- 修改 store.ts
- 按需修改 permissions/attachments 的窄删除协作者

- [ ] **步骤 1：建立完整删除 fixture**

根、child、grandchild 各含 Input、attachment ref、Message、Part、Run、Attempt、Task、Permission、Event；另建不属于树的数据作为保留对照。

- [ ] **步骤 2：断言删除顺序和返回值**

返回树 id 顺序保持 collectSessionTreeIds 现状；只删除树内记录；dirty part 被清理；无关 mutation 不得被 createMutationBuffer 全量抹掉。

- [ ] **步骤 3：失败注入**

在 SQL 删除中途和内存清理中途抛错，断言 SQLite/read model/delta/mutation 全恢复。

- [ ] **步骤 4：实现事务**

优先通过各 Repository 的 package-private bulk delete 原语；如果现有 FK/SQL 批量删除更安全，可保留集中 SQL，但所有权必须在 Transaction，不在 Store。不得调用每行公共 delete 造成多次保存。

- [ ] **步骤 5：验证并提交**

运行：pnpm --filter @openharness/services test -- src/conversations src/permissions src/attachments src/session-runtime
运行：git add packages/services/src packages/services/src/session-runtime/store.ts
运行：git commit -m "refactor(services): move session tree deletion transaction"

### 任务 8：迁移中断、恢复和 closing 收尾

**文件：**
- 修改 conversation-transactions.ts 及测试
- 修改 store.ts
- 修改 Task listener 相关测试

- [ ] **步骤 1：分别测试五类动作**

settleActiveRunAttempts；interruptActiveSessionTasks；interruptActiveRuns；terminalizeUnownedInputs；finalizeClosingSessions。保持默认 reason、计数、tool unknown outcome metadata、orphan recovery metadata 和 active 判定。

- [ ] **步骤 2：保证联合 terminal 原子**

Run interrupted、Attempt cancelled、running Part interrupted/failed 必须一次提交；任一点失败全部恢复。最后 delta flush 由 3D 接管前仍调用现有机制。

- [ ] **步骤 3：提交后通知**

批量 Task 更新的 listener 在成功提交后逐 task 通知；rollback 不通知。

- [ ] **步骤 4：验证重启恢复**

运行 Services recovery 测试和 Server HTTP restart/maintenance 定向测试，确认不会遗留 active 状态。

- [ ] **步骤 5：提交**

运行：git add packages/services/src/conversations packages/services/src/session-runtime
运行：git commit -m "refactor(services): move session recovery transactions"

### 任务 9：迁移一致快照并收尾

**文件：**
- 修改 conversation-transactions.ts 及测试
- 修改 store.ts
- 修改 architecture checker/baseline
- 修改 docs/architecture-migration-status.md

- [ ] **步骤 1：测试 getSessionState**

断言 root、canonical children、Input、attachment、Message、Part、Run、Attempt、Task、Permission 和 event cursor 取自同一已提交状态；返回深拷贝；不存在 Session 保持错误。

- [ ] **步骤 2：迁移快照组装**

只组合 Repository 查询；不得读取 Server live handle，也不改变 Snapshot 协议。

- [ ] **步骤 3：检查 Store 残留**

运行：rg -n "transactionDepth|saveRequested|database\.transaction|DELETE FROM session_|INSERT INTO session_|UPDATE session_" packages/services/src/session-runtime/store.ts

预期：业务事务 SQL 和 Store 私有 coordinator 已消失；保留项必须逐条说明。

- [ ] **步骤 4：最终验证**

运行：
pnpm --filter @openharness/services test
pnpm --filter @openharness/services check-types
pnpm --filter @openharness/server test -- src/application/session src/permissions src/http
pnpm --filter @openharness/server check-types
node --test scripts/architecture-boundaries.test.mjs
pnpm check:architecture
node scripts/check-docs.mjs
git diff --check

全仓测试若出现已知 WSL/node-pty 并发问题，记录精确失败签名；不得宣称全仓通过。

- [ ] **步骤 5：更新状态和提交**

只标记 3C 完成、3D 未开始，记录失败注入数量、Store 行数和 flat calls。
提交：git commit -m "chore: close session runtime transaction extraction"

## 审核重点

逐事务验证真正只有一个 outer atomic；失败恢复所有内存组件；外部副作用在 commit 后；delete tree 不误删且不抹掉无关 mutation；fork/edit 保持引用关系；database 不反向依赖业务域；Store 不残留事务实现。
