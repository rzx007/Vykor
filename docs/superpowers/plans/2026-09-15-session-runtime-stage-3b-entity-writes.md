# Session Runtime 阶段 3B：单实体写 Repository 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（- [ ]）语法来跟踪进度。

**目标：** 把 Session、Conversation、Run 的单实体创建和更新规则迁入 3A Repository，同时保持跨域事务由 Store 负责。

**架构：** Repository 写方法操作共享 read model、mutation buffer 和 durable event，并经现有保存边界落盘。Store 只保留兼容转发和 Task listener 通知；涉及多个实体整体一致性的动作不进入 3B。

**技术栈：** TypeScript、Vitest、better-sqlite3、StorageContext、MutationBuffer、DurableEventSequence、pnpm。

---

## 开工条件和硬边界

- 只能基于已合入、复审通过的 3A。
- 包含 Session create/update/archive/beginArchive；Message create；MessagePart upsert；Event append；Run create/update；Attempt create/update；Task create/update/reserve/transition。
- 不包含 Prompt admission、transcript replace、replay/edit/fork、delete tree、批量 interrupt/recovery、projection settlement、delta append/flush。
- createSession 可以调用现有 ProjectRepository，不能复制 Project 逻辑。
- Task listener 继续由 Store 持有；写入成功才通知。
- 错误文本、时间戳、metadata merge、event payload、clone 和 id/sequence 生成方式保持不变。

## 文件

- 修改 packages/services/src/sessions/session-repository.ts 及测试。
- 修改 packages/services/src/conversations/conversation-repository.ts 及测试。
- 修改 packages/services/src/runs/run-repository.ts 及测试。
- 修改 packages/services/src/session-runtime/store.ts 及现有契约测试。
- 收尾修改 docs/architecture-migration-status.md 和按条件修改 architecture baseline。

## 单实体判定

一个写操作的核心记录属于单个领域，伴随 event、mutation、所属 Session updatedAt 属于统一持久化机制时，可进入 3B。以下必须留给 3C：admitPrompt、admitPromptWithRun、replaceTranscriptAndAdmitPrompt、createReplayRun、replaceLatestPromptWithAdmission、forkSessionWithHistory、deleteSessionTree、interruptActiveRuns、terminalizeUnownedInputs、finalizeClosingSessions、getSessionState。

### 任务 1：锁定写入状态机

**文件：**
- 修改 packages/services/src/session-runtime/__test__ 下对应测试。

- [ ] **步骤 1：盘点生产和测试调用**

运行：rg -n "createSession\(|updateSession\(|archiveSession\(|beginArchive\(|createMessage\(|upsertMessagePart\(|appendEvent\(|createRun\(|updateRun\(|createRunAttempt\(|updateRunAttempt\(|createSessionTask\(|updateSessionTask\(|reserveSessionTask\(|transitionPendingSessionTask\(" packages/services packages/server/src

- [ ] **步骤 2：补齐状态机测试**

每类写至少断言返回 clone、事件 type/payload/previousStatus、所属 Session updatedAt、terminal guard、关闭重开一致。Task 额外覆盖 requestNamespace/requestId 成对出现、child/run ownership 和 pending compare-and-set。

- [ ] **步骤 3：跑迁移前测试**

运行：pnpm --filter @openharness/services test -- src/session-runtime

预期：PASS；新增断言在旧实现上成立。

- [ ] **步骤 4：提交**

运行：git add packages/services/src/session-runtime/__test__
运行：git commit -m "test(services): lock session runtime write contracts"

### 任务 2：迁移 Session 写入

**文件：**
- 修改 packages/services/src/sessions/session-repository.ts
- 修改 packages/services/src/sessions/session-repository.test.ts

- [ ] **步骤 1：写新接口失败测试**

覆盖重复 id、parent project 继承、Project inspect、cwd/cwdRelative、默认 title/status/metadata、archived 与 closing 幂等、mutable guard、agent null 删除、metadata 替换和三个事件。

- [ ] **步骤 2：确认红灯**

运行：pnpm --filter @openharness/services test -- src/sessions/session-repository.test.ts

预期：FAIL，create/update/archive/beginArchive 尚不存在。

- [ ] **步骤 3：实现接口**

新增 create(CreateSessionInput)、update(id, UpdateSessionInput)、archive(id)、beginArchive(id)。构造依赖只能是 StorageContext、ProjectRepository 和现有 event/save 窄能力，禁止传整个 Store。

- [ ] **步骤 4：逐行比对旧实现**

确认 randomUUID、now、resolve/relative、project 继承、错误字符串、payload clone 和 mutation.sessions 完全一致。

- [ ] **步骤 5：验证并提交**

运行：pnpm --filter @openharness/services test -- src/sessions/session-repository.test.ts
运行：pnpm --filter @openharness/services check-types
运行：git add packages/services/src/sessions
运行：git commit -m "refactor(services): move session entity writes"

### 任务 3：迁移 Message、Part、Event 写入

**文件：**
- 修改 packages/services/src/conversations/conversation-repository.ts
- 修改 packages/services/src/conversations/conversation-repository.test.ts

- [ ] **步骤 1：写失败测试**

接口为 createMessage(CreateMessageInput)、upsertMessagePart(UpsertMessagePartInput)、appendEvent(AppendEventInput)。覆盖重复 Message、Session mutable、seq；Part message/session 对齐、create/update 字段合并、typed fields、状态；Event registry 校验、可选 session 和 durable sequence。

- [ ] **步骤 2：确认红灯**

运行：pnpm --filter @openharness/services test -- src/conversations/conversation-repository.test.ts

- [ ] **步骤 3：迁移 event 内核**

若 appendEventInMemory 仍是 Store 私有函数，把唯一实现放入 ConversationRepository 或一个仅由它拥有的 event writer。不得复制 DurableEventRegistry、sequence 或 mutation 规则。

- [ ] **步骤 4：迁移 Message 与 Part**

保持所属 Session/Message updatedAt、mutation 集合、已有字段删除语义和返回 clone。appendMessagePartDelta 不动。

- [ ] **步骤 5：验证并提交**

运行：pnpm --filter @openharness/services test -- src/conversations src/database/event-sequence.test.ts src/session-runtime
运行：pnpm --filter @openharness/services check-types
运行：git add packages/services/src/conversations
运行：git commit -m "refactor(services): move conversation entity writes"

### 任务 4：迁移 Run 和 Attempt 写入

**文件：**
- 修改 packages/services/src/runs/run-repository.ts
- 修改 packages/services/src/runs/run-repository.test.ts

- [ ] **步骤 1：写失败测试**

接口为 createRun、updateRun、createRunAttempt、updateRunAttempt。覆盖 input/session 对齐、重复 id、terminal guard、startedAt/finishedAt、error 清理、metadata merge、attempt 自动 sequence、sequence 冲突、token 字段和事件 previousStatus。

- [ ] **步骤 2：确认红灯**

运行：pnpm --filter @openharness/services test -- src/runs/run-repository.test.ts

- [ ] **步骤 3：移动最小实现**

调用同一个 Conversation event writer；更新所属 Session 时间戳；不得生成第二条 event sequence 路径。

- [ ] **步骤 4：验证并提交**

运行：pnpm --filter @openharness/services test -- src/runs/run-repository.test.ts src/database/event-sequence.test.ts
运行：pnpm --filter @openharness/services check-types
运行：git add packages/services/src/runs
运行：git commit -m "refactor(services): move run entity writes"

### 任务 5：迁移 Session Task 写入和通知

**文件：**
- 修改 packages/services/src/runs/run-repository.ts 及测试
- 修改 packages/services/src/session-runtime/store.ts 及等待者测试

- [ ] **步骤 1：补全 Task 失败测试**

覆盖成对 request key、重复 request、child ownership、run ownership、默认 running、pending reserve、transition 只处理 pending、running 清理旧 terminal 字段、terminal finishedAt 和 metadata merge。

- [ ] **步骤 2：实现四个方法**

新增 createSessionTask、reserveSessionTask、transitionPendingSessionTask、updateSessionTask。Repository 不接收 listener。

- [ ] **步骤 3：Store 只在成功后通知**

create/update 成功后 notify；reserve created=false 不通知；transition transitioned=false 不通知；任何抛错不通知。不得把 listener 放进 StorageContext。

- [ ] **步骤 4：验证等待竞态**

同时启动 waitForSessionTaskChange，断言成功更新会唤醒；失败不虚假唤醒；注册前后二次读取可以捕获竞态；abort 和 timeout 清理 listener。

- [ ] **步骤 5：验证并提交**

运行：pnpm --filter @openharness/services test -- src/runs src/session-runtime
运行：pnpm --filter @openharness/server test -- src/jobs/daemon-job-service.test.ts
运行：git add packages/services/src/runs packages/services/src/session-runtime
运行：git commit -m "refactor(services): move session task entity writes"

### 任务 6：Store 全量兼容转发

**文件：**
- 修改 packages/services/src/session-runtime/store.ts

- [ ] **步骤 1：逐领域替换方法体**

已迁方法只做输入兼容、Repository 调用和必要成功后通知；旧实现删除。

- [ ] **步骤 2：检查未授权改动**

运行：git diff --word-diff=plain -- packages/services/src/session-runtime/store.ts

预期：3C/3D 方法没有被移动、格式化或更改。

- [ ] **步骤 3：运行 Services 全包**

运行：pnpm --filter @openharness/services test
运行：pnpm --filter @openharness/services check-types

- [ ] **步骤 4：提交**

运行：git add packages/services/src/session-runtime/store.ts
运行：git commit -m "refactor(services): delegate session runtime entity writes"

### 任务 7：调用方、基线与收尾

**文件：**
- 修改具有现有窄 capability 的 Server application/runtime 文件
- 按条件修改 scripts/architecture-baseline.json
- 修改 docs/architecture-migration-status.md

- [ ] **步骤 1：只迁窄 capability**

已有 service 的构造参数从整个 Store 缩为实际方法集合。HTTP route 不直接 import Repository，这属于阶段 4。

- [ ] **步骤 2：运行调用方测试**

至少覆盖 Session Application、Run Engine/Executor、Transcript Projection、Daemon Job Service、Permission Broker。

- [ ] **步骤 3：更新真实指标**

运行 architecture checker 后记录 Store 行数和 flat calls。只标记 3B 完成、3C–3D 未开始。

- [ ] **步骤 4：最终验证**

运行：
pnpm --filter @openharness/services test
pnpm --filter @openharness/services check-types
pnpm --filter @openharness/server check-types
node --test scripts/architecture-boundaries.test.mjs
pnpm check:architecture
node scripts/check-docs.mjs
git diff --check

- [ ] **步骤 5：提交**

运行：git add packages/server scripts/architecture-baseline.json docs/architecture-migration-status.md
运行：git commit -m "chore: close session runtime entity write extraction"

## 审核重点

逐个比对旧 Store：状态机、时间戳、metadata merge、event payload、clone 和错误文本不变；Task 只在成功后唤醒；跨域动作未提前迁移；已迁方法没有残余规则；baseline 未上调。
