# Session Runtime 阶段 3A：只读 Repository 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（- [ ]）语法来跟踪进度。

**目标：** 为 Session、Conversation、Run 建立只读 Repository，并在不改变写入、事务或协议行为的前提下让 SessionStore 查询方法转发到新边界。

**架构：** 三个 Repository 共享现有 StorageContext，从 storage.state 读取并返回深拷贝。3A 不读取 SQLite、不移动写方法；Store 继续拥有写入，只把查询委托给 Repository。

**技术栈：** TypeScript、Vitest、better-sqlite3、StorageContext、SessionState、pnpm、架构边界脚本。

---

## 开工条件

- 基线包含总体设计 commit b1daf2ef，并基于最新 main 建立独立 worktree。
- 不改 schema、migration、protocol、HTTP、SSE 和任何写方法。
- Repository 不得导入 SessionStore，不新增基类、查询 DSL 或缓存层。
- architecture baseline 只能在真实调用下降时调低。
- 所有查询继续使用现有 clone()，禁止直接返回 read model 对象。

## 文件结构

- 创建 packages/services/src/sessions/session-repository.ts 及同目录测试、index.ts。
- 创建 packages/services/src/conversations/conversation-repository.ts 及同目录测试、index.ts。
- 创建 packages/services/src/runs/run-repository.ts 及同目录测试、index.ts。
- 修改 packages/services/src/session-runtime/store.ts：构造 Repository，旧查询方法改为转发。
- 修改 scripts/architecture-boundaries.mjs 及其测试：加入新目录依赖规则。
- 仅在计数下降时修改 scripts/architecture-baseline.json。
- 收尾时修改 docs/architecture-migration-status.md。

## 完整方法映射

SessionRepository：

- getSession → get：不存在返回 undefined；返回 clone。
- listSessions → list：cwd 先 resolve；默认排除 archived；updatedAt 降序；最后 limit。
- listChildSessions → listChildren：parent 不存在抛错；默认排除 archived；createdAt 升序。
- resolveSessionListTitle 和 getSessionState 是跨域查询，3A 留在 Store。

ConversationRepository：

- getInput、listInputs。
- listInputAttachments、listSessionInputAttachments。
- countInputAttachmentReferences、countAttachmentReferences。
- listMessages、listMessageParts。
- listEvents、latestEventSeq。
- 保持 afterSeq、messageId、sessionId、limit 的现有应用顺序和错误文本。

RunRepository：

- getRun、findRunByInput、listRunsByInput、findOwningRunByInput、listRuns。
- getRunAttempt、listRunAttempts。
- getSessionTask、listSessionTasks、findSessionExecutionByRuntimeId。
- findRunByInput 先找 owning run，再找已经由 message.runId 提升的 run。
- listRunsByInput 以 createdAt、id 稳定升序；attempt 以 sequence 升序。

### 任务 1：固定查询契约

**文件：**
- 修改 packages/services/src/session-runtime/__test__ 下现有 Store 测试。

- [ ] **步骤 1：盘点真实调用**

运行：rg -n "getSession|listSessions|listChildSessions|listInputs|listMessages|listMessageParts|listEvents|findRunByInput|listRunAttempts|listSessionTasks" packages/services/src/session-runtime packages/server/src

预期：同时获得实现、生产调用和测试断言；把遗漏方法加入交付清单。

- [ ] **步骤 2：补充 clone 测试**

创建 Session/Run/Part 后取得查询结果，修改结果中的 title、text、metadata，再次查询，断言存储值没有变化。列表返回值也执行同样测试。

- [ ] **步骤 3：补充排序和错误测试**

明确断言 Session updatedAt 降序；child/input/message/part/run/task 创建顺序；attempt sequence 顺序；父 Session、Run、Input 不存在时保持当前错误文本。

- [ ] **步骤 4：运行迁移前测试**

运行：pnpm --filter @vykor/services test -- src/session-runtime

预期：PASS。新增测试必须在旧实现上通过，证明固定的是现状。

- [ ] **步骤 5：提交**

运行：git add packages/services/src/session-runtime/__test__
运行：git commit -m "test(services): lock session runtime read contracts"

### 任务 2：SessionRepository

**文件：**
- 创建 packages/services/src/sessions/session-repository.ts
- 创建 packages/services/src/sessions/session-repository.test.ts
- 创建 packages/services/src/sessions/index.ts

- [ ] **步骤 1：先写失败测试**

通过 Store 现有测试工厂创建 state，直接测试 get、list、listChildren。覆盖 cwd resolve、archived、limit、排序、parent not-found 和 clone。

- [ ] **步骤 2：验证红灯**

运行：pnpm --filter @vykor/services test -- src/sessions/session-repository.test.ts

预期：FAIL，原因是 SessionRepository 尚不存在。

- [ ] **步骤 3：实现最小接口**

接口固定为 constructor(storage: StorageContext)、get(sessionId)、list(options?)、listChildren(parentId, options?)。从 Store 原样移动查询体，继续使用 resolve、assertSession 和 clone。

- [ ] **步骤 4：验证绿灯**

运行：pnpm --filter @vykor/services test -- src/sessions/session-repository.test.ts
运行：pnpm --filter @vykor/services check-types

预期：PASS。

- [ ] **步骤 5：提交**

运行：git add packages/services/src/sessions
运行：git commit -m "refactor(services): add session read repository"

### 任务 3：ConversationRepository

**文件：**
- 创建 packages/services/src/conversations/conversation-repository.ts
- 创建 packages/services/src/conversations/conversation-repository.test.ts
- 创建 packages/services/src/conversations/index.ts

- [ ] **步骤 1：先写失败测试**

为完整方法映射中的 Conversation 查询逐一写断言。特别覆盖 Input Attachment position、afterSeq 后再 limit、messageId filter、session not-found 和 latest durable cursor。

- [ ] **步骤 2：验证红灯**

运行：pnpm --filter @vykor/services test -- src/conversations/conversation-repository.test.ts

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现最小接口**

方法名与现有 Store 名一致。方法体原样移动，不改为 SQL 查询，不合并两个 attachment count，不提取通用 filter helper。

- [ ] **步骤 4：验证**

运行：pnpm --filter @vykor/services test -- src/conversations/conversation-repository.test.ts
运行：pnpm --filter @vykor/services check-types

- [ ] **步骤 5：提交**

运行：git add packages/services/src/conversations
运行：git commit -m "refactor(services): add conversation read repository"

### 任务 4：RunRepository

**文件：**
- 创建 packages/services/src/runs/run-repository.ts
- 创建 packages/services/src/runs/run-repository.test.ts
- 创建 packages/services/src/runs/index.ts

- [ ] **步骤 1：先写失败测试**

覆盖直接 get、owning/promoted input 查找、所有稳定排序、Run not-found、Session not-found、runtimeExecutionId 与 taskManagerId 两个 metadata 键，以及 clone。

- [ ] **步骤 2：验证红灯**

运行：pnpm --filter @vykor/services test -- src/runs/run-repository.test.ts

预期：FAIL，模块不存在。

- [ ] **步骤 3：实现最小接口**

只实现完整方法映射中的十个读取方法。findOwningRunByInput 调用 listRunsByInput，不重复排序逻辑。

- [ ] **步骤 4：验证并提交**

运行：pnpm --filter @vykor/services test -- src/runs/run-repository.test.ts
运行：pnpm --filter @vykor/services check-types
运行：git add packages/services/src/runs
运行：git commit -m "refactor(services): add run read repository"

### 任务 5：Store 兼容转发

**文件：**
- 修改 packages/services/src/session-runtime/store.ts

- [ ] **步骤 1：构造三个只读字段**

新增 readonly sessions、conversations、runs，全部接收同一个 StorageContext。构造方式跟现有 Goal/Attachment Repository 一致。

- [ ] **步骤 2：逐领域替换旧方法体**

每个旧查询方法只调用对应 Repository 并原样返回。原实现必须删除，不注释保留。每迁一个领域立即运行该领域测试。

- [ ] **步骤 3：审查 diff**

运行：git diff -- packages/services/src/session-runtime/store.ts

预期：只有 import、字段、构造和查询转发；create、update、admit、append、delete、transaction、delta 方法体没有变化。

- [ ] **步骤 4：兼容验证**

运行：pnpm --filter @vykor/services test -- src/sessions src/conversations src/runs src/session-runtime
运行：pnpm --filter @vykor/services check-types

- [ ] **步骤 5：提交**

运行：git add packages/services/src/session-runtime/store.ts
运行：git commit -m "refactor(services): delegate session runtime reads"

### 任务 6：架构护栏和收尾

**文件：**
- 修改 scripts/architecture-boundaries.mjs
- 修改 scripts/architecture-boundaries.test.mjs
- 按条件修改 scripts/architecture-baseline.json
- 修改 docs/architecture-migration-status.md

- [ ] **步骤 1：先写失败的边界测试**

用脚本现有 fixture 证明 sessions/conversations/runs 不可导入 server，database 不可反向导入三域，Repository 不可导入 session-runtime/store。

- [ ] **步骤 2：运行红灯**

运行：node --test scripts/architecture-boundaries.test.mjs

预期：FAIL，新规则尚未覆盖。

- [ ] **步骤 3：实现最窄规则**

复用现有文本扫描与诊断格式，不增加解析依赖。

- [ ] **步骤 4：计算真实基线**

运行：node scripts/architecture-boundaries.mjs
运行：node scripts/architecture-boundaries.mjs --write-baseline
运行：git diff -- scripts/architecture-baseline.json

只有 sessionStoreFlatCalls 下降时保留修改；未下降就不提交 baseline。

- [ ] **步骤 5：更新状态**

只标记 3A 完成、3B–3D 未开始，记录真实 Store 行数、调用数、commit 和验证命令。

- [ ] **步骤 6：最终验证**

运行：
pnpm --filter @vykor/services test -- src/sessions src/conversations src/runs src/session-runtime
pnpm --filter @vykor/services check-types
pnpm --filter @vykor/server check-types
node --test scripts/architecture-boundaries.test.mjs
pnpm check:architecture
node scripts/check-docs.mjs
git diff --check

预期：全部退出码 0。

- [ ] **步骤 7：提交收尾**

运行：git add scripts docs/architecture-migration-status.md
运行：git commit -m "chore: close session runtime read extraction"

## 交付与审核重点

交付必须包含起始 main commit、所有 commit、迁出方法表、Store 行数、flat call 数、逐条测试命令与测试数量。审核者确认：结果仍 clone；排序/limit 顺序未变；跨域查询未提前拆；写方法零变化；Repository 不依赖 Store；baseline 没上调。
