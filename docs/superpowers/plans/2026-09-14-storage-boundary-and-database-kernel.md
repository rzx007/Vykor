# 存储边界护栏与数据库内核提取实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 完成长期业务域重组的阶段 0–1：阻止旧万能入口继续增长，并在不改变行为、协议、schema 或 migration 的前提下，从 `SessionStore` 提取可独立测试的 SQLite 数据库内核。

**架构：** `SessionStore` 在本阶段仍是唯一公开兼容入口和业务方法所有者；新的 `SessionDatabase` 只拥有 SQLite 连接、连接配置、迁移、格式校验和关闭。Read model 加载、mutation buffer、event sequence 与 delta checkpoint 分别提取为数据库内核协作者，Store 组合它们但不改变现有事务和回滚语义。

**技术栈：** TypeScript、Node.js、better-sqlite3、Drizzle migrations、Vitest、pnpm workspace、Turbo。

---

## 范围与执行约束

本计划只覆盖阶段 0 和阶段 1，不提取 project、schedule、workflow 等业务 repository。后续业务域迁移必须基于本计划完成后的 `StorageContext` 另写计划。

执行期间保持以下约束：

- `@openharness/services` 公共导出不变；
- `SessionStore` 构造参数和公开方法不变；
- SQLite schema、migration 文件和存储格式版本不变；
- HTTP/SSE、CLI 和 Desktop 行为不变；
- 每个任务单独提交；
- 文件移动和行为修改不放在同一个步骤；
- 不增加新的 npm 依赖。

## 文件结构

### 架构护栏

- 创建 `scripts/architecture-boundaries.mjs`：扫描 package 依赖、受限导入和旧入口调用基线。
- 创建 `scripts/architecture-boundaries.test.mjs`：验证扫描规则会拒绝反向依赖和新增旧入口。
- 创建 `scripts/architecture-baseline.json`：保存当前允许逐步减少的旧入口调用数量。
- 修改 `package.json`：增加 `check:architecture`，并接入 `check-types` 之前的独立 CI 入口，不改变现有 test 含义。
- 创建 `docs/architecture-migration-status.md`：记录阶段、调用基线、所有者和完成条件。

### 数据库内核

- 创建 `packages/services/src/database/session-database.ts`：打开、配置、迁移、格式校验和关闭 SQLite。
- 创建 `packages/services/src/database/session-database.test.ts`：验证空库初始化、旧格式拒绝、连接配置和关闭。
- 创建 `packages/services/src/database/migrations.ts`：集中 migration 路径解析、执行和格式版本检查。
- 创建 `packages/services/src/database/read-model.ts`：从已打开数据库加载 `SessionState`。
- 创建 `packages/services/src/database/read-model.test.ts`：验证完整状态重载和 legacy input 拒绝。
- 创建 `packages/services/src/database/mutation-buffer.ts`：拥有 mutation sets 的创建与克隆。
- 创建 `packages/services/src/database/mutation-buffer.test.ts`：验证克隆隔离。
- 创建 `packages/services/src/database/event-sequence.ts`：管理事件序号预留窗口。
- 创建 `packages/services/src/database/event-sequence.test.ts`：验证跨重启单调和事务失败恢复。
- 创建 `packages/services/src/database/delta-checkpoint.ts`：管理 dirty part、字节阈值和 flush timer。
- 创建 `packages/services/src/database/delta-checkpoint.test.ts`：验证阈值、timer、失败重试和 close 清理。
- 创建 `packages/services/src/database/storage-context.ts`：定义后续 repository 共用的具体上下文类型。
- 创建 `packages/services/src/database/index.ts`：仅供 services 包内部组合使用，不增加根公共导出。

### 兼容 Store

- 修改 `packages/services/src/session-runtime/store-state.ts`：删除已经迁到 database 的 mutation、加载和序号辅助实现，保留业务状态断言和记录转换。
- 修改 `packages/services/src/session-runtime/store.ts`：组合数据库内核协作者，保持全部公开方法签名和行为。
- 修改 `packages/services/src/session-runtime/__test__/store.test.ts`：保留业务特征测试，把内核测试迁到新文件，并增加兼容入口回归。
- 修改 `packages/services/drizzle.config.ts`：仅在 schema 移动确有需要时更新路径；本计划默认保持现有 schema 路径不动。

## 任务 1：建立架构边界与退场基线

**文件：**
- 创建：`scripts/architecture-boundaries.mjs`
- 创建：`scripts/architecture-boundaries.test.mjs`
- 创建：`scripts/architecture-baseline.json`
- 修改：`package.json`
- 创建：`docs/architecture-migration-status.md`

- [ ] **步骤 1：编写边界扫描失败测试**

测试脚本导出纯函数并覆盖三个规则：

```js
import test from "node:test"
import assert from "node:assert/strict"
import {
  checkPackageDependency,
  countLegacyCalls,
  validateLegacyBaseline,
} from "./architecture-boundaries.mjs"

test("services cannot depend on server", () => {
  assert.deepEqual(
    checkPackageDependency("@openharness/services", "@openharness/server"),
    ["@openharness/services must not depend on @openharness/server"],
  )
})

test("legacy SessionStore calls may decrease but not increase", () => {
  assert.deepEqual(validateLegacyBaseline({ sessionStoreFlatCalls: 8 }, { sessionStoreFlatCalls: 7 }), [])
  assert.match(
    validateLegacyBaseline({ sessionStoreFlatCalls: 8 }, { sessionStoreFlatCalls: 9 })[0],
    /8 to 9/,
  )
})

test("counts direct store calls", () => {
  assert.equal(countLegacyCalls("context.store.createRun(); store.listProjects()"), 2)
})
```

- [ ] **步骤 2：运行测试确认模块不存在**

运行：

```powershell
node --test scripts/architecture-boundaries.test.mjs
```

预期：FAIL，提示无法导入 `architecture-boundaries.mjs`。

- [ ] **步骤 3：实现无依赖扫描器**

使用 Node 标准库读取 workspace `package.json` 和由 `rg --files` 等价遍历得到的 `packages/**/src`、`apps/**/src` 源文件。固定禁止方向：

```js
const forbiddenPackageEdges = new Map([
  ["@openharness/protocol", new Set(["@openharness/services", "@openharness/server", "@openharness/client"])],
  ["@openharness/services", new Set(["@openharness/server", "@openharness/client"])],
  ["@openharness/agent-runtime", new Set(["@openharness/server"])],
])
```

旧入口计数至少覆盖：

```js
const legacyPatterns = {
  sessionStoreFlatCalls: /\b(?:context\.)?store\.[A-Za-z_$][\w$]*\s*\(/g,
  httpClientFlatCalls: /\bclient\.(?:createSession|admitPrompt|interruptRun|listProjects)\s*\(/g,
}
```

扫描脚本默认比较 `scripts/architecture-baseline.json`。实际数量小于或等于基线时通过；大于基线时报出指标、旧值、新值和匹配文件。`--write-baseline` 只在明确执行时更新基线，普通检查不得自动写文件。

- [ ] **步骤 4：生成当前基线并验证**

运行：

```powershell
node scripts/architecture-boundaries.mjs --write-baseline
node --test scripts/architecture-boundaries.test.mjs
node scripts/architecture-boundaries.mjs
```

预期：测试和扫描全部通过，baseline 包含具体整数且无通配字段。

- [ ] **步骤 5：接入命令并记录迁移状态**

在根 `package.json` 增加：

```json
"check:architecture": "node scripts/architecture-boundaries.mjs"
```

`docs/architecture-migration-status.md` 记录阶段 0–8、当前阶段、基线指标、下一目标和更新规则。不要复制完整设计文档。

- [ ] **步骤 6：验证并提交护栏**

运行：

```powershell
pnpm check:architecture
node --test scripts/architecture-boundaries.test.mjs
node scripts/check-docs.mjs
git diff --check
```

预期：全部退出 0。

```powershell
git add scripts/architecture-boundaries.mjs scripts/architecture-boundaries.test.mjs scripts/architecture-baseline.json package.json docs/architecture-migration-status.md
git commit -m "chore: guard architecture migration boundaries"
```

## 任务 2：提取 SQLite 连接、迁移和格式校验

**文件：**
- 创建：`packages/services/src/database/migrations.ts`
- 创建：`packages/services/src/database/session-database.ts`
- 创建：`packages/services/src/database/session-database.test.ts`
- 创建：`packages/services/src/database/index.ts`
- 修改：`packages/services/src/session-runtime/store.ts`

- [ ] **步骤 1：编写数据库生命周期失败测试**

测试固定接口：

```ts
const database = SessionDatabase.open({ path })
expect(database.path).toBe(resolve(path))
expect(database.connection.pragma("foreign_keys", { simple: true })).toBe(1)
expect(database.connection.prepare("select version from application_storage_format where id = 1").get())
  .toEqual({ version: 2 })
database.close()
expect(() => database.connection.prepare("select 1").get()).toThrow()
```

另建一个只有任意业务表、没有 `application_storage_format` 的 SQLite 文件，断言 `open()` 抛出当前完全相同的 unsupported format 文案。

- [ ] **步骤 2：运行新测试确认失败**

运行：

```powershell
pnpm --filter @openharness/services test -- session-database
```

预期：FAIL，缺少 `SessionDatabase`。

- [ ] **步骤 3：实现迁移函数和数据库类**

`migrations.ts` 导出：

```ts
export const CURRENT_STORAGE_FORMAT = 2
export function assertCurrentStorageFormatOrEmpty(database: Database.Database): void
export function applySessionMigrations(database: Database.Database): void
export function assertCurrentStorageFormat(database: Database.Database): void
```

`SessionDatabase.open()` 完整复用当前顺序：resolve/mkdir → new Database → WAL → foreign keys → busy timeout → synchronous NORMAL → precheck → migrate → postcheck。任何失败都关闭连接后重新抛出。

- [ ] **步骤 4：让 Store 使用数据库内核**

Store 字段改为：

```ts
private readonly databaseKernel: SessionDatabase
private readonly database: Database.Database
```

构造器中：

```ts
this.databaseKernel = SessionDatabase.open({ path: options.path })
this.path = this.databaseKernel.path
this.database = this.databaseKernel.connection
```

`close()` 在 flush 和 timer 清理后调用 `databaseKernel.close()`。删除 Store 中原有三个 migration/format 私有方法，其他业务 SQL 不动。

- [ ] **步骤 5：运行内核和完整 Store 回归**

运行：

```powershell
pnpm --filter @openharness/services test -- session-database store
pnpm --filter @openharness/services check-types
pnpm check:architecture
```

预期：全部通过；原 Store 构造、重开和旧格式错误文案不变。

- [ ] **步骤 6：提交数据库生命周期提取**

```powershell
git add packages/services/src/database packages/services/src/session-runtime/store.ts
git commit -m "refactor(services): extract session database lifecycle"
```

## 任务 3：提取 MutationBuffer

**文件：**
- 创建：`packages/services/src/database/mutation-buffer.ts`
- 创建：`packages/services/src/database/mutation-buffer.test.ts`
- 修改：`packages/services/src/session-runtime/store-state.ts`
- 修改：`packages/services/src/session-runtime/store.ts`

- [ ] **步骤 1：编写克隆隔离失败测试**

```ts
const source = createMutationBuffer()
source.sessions.add("s1")
const copy = cloneMutationBuffer(source)
copy.sessions.add("s2")
copy.deletedInputs.add("i1")
expect([...source.sessions]).toEqual(["s1"])
expect(source.deletedInputs.size).toBe(0)
```

- [ ] **步骤 2：运行测试确认新模块不存在**

运行：

```powershell
pnpm --filter @openharness/services test -- mutation-buffer
```

预期：FAIL，缺少模块。

- [ ] **步骤 3：移动现有类型和函数，不改变字段**

把 `StoreMutations` 更名为 `MutationBuffer`，把 `emptyMutations()`、`cloneMutations()` 分别更名为 `createMutationBuffer()`、`cloneMutationBuffer()`。字段集合必须与当前实现逐项一致，不增加抽象基类或动态表名。

Store 中只做机械替换：

```ts
private mutations = createMutationBuffer()
const previousMutations = cloneMutationBuffer(this.mutations)
```

- [ ] **步骤 4：验证事务回滚与完整 Store**

运行：

```powershell
pnpm --filter @openharness/services test -- mutation-buffer store
pnpm --filter @openharness/services check-types
git diff --check
```

预期：全部通过，Store 的 transaction rollback 测试保持原断言。

- [ ] **步骤 5：提交 MutationBuffer**

```powershell
git add packages/services/src/database/mutation-buffer.ts packages/services/src/database/mutation-buffer.test.ts packages/services/src/session-runtime/store-state.ts packages/services/src/session-runtime/store.ts
git commit -m "refactor(services): extract storage mutation buffer"
```

## 任务 4：提取完整 Read Model 加载器

**文件：**
- 创建：`packages/services/src/database/read-model.ts`
- 创建：`packages/services/src/database/read-model.test.ts`
- 修改：`packages/services/src/session-runtime/store-state.ts`
- 修改：`packages/services/src/session-runtime/store.ts`

- [ ] **步骤 1：编写重载和 legacy 失败测试**

先用 `SessionStore` 创建包含 session、input、message、part、run、attempt、task、permission 和 durable event 的数据库，再调用：

```ts
const loaded = loadSessionReadModel(database.connection, fixtureEventRegistry)
expect(loaded.state.sessions.s1.id).toBe("s1")
expect(loaded.state.inputs.i1.attachments).toEqual(expectedAttachments)
expect(loaded.state.events.map((event) => event.seq)).toEqual([...].sort((a, b) => a - b))
expect(loaded.nextReservedEventSeq).toBeGreaterThanOrEqual(loaded.state.nextEventSeq - 1)
```

复制现有 legacy `session_input` 行场景，断言加载器仍抛出 `LegacySessionInputError` 的相同公开文案。

- [ ] **步骤 2：运行测试确认加载器不存在**

运行：

```powershell
pnpm --filter @openharness/services test -- read-model
```

预期：FAIL，缺少 `loadSessionReadModel`。

- [ ] **步骤 3：移动加载与行转换代码**

固定返回类型：

```ts
export interface LoadedSessionReadModel {
  state: SessionState
  nextReservedEventSeq: number
}

export function loadSessionReadModel(
  database: Database.Database,
  eventRegistry: DurableEventRegistry,
): LoadedSessionReadModel
```

把当前 `load()`、`normalizeInputItems()`、`hydrateInput()`、`LegacySessionInputError` 以及仅由加载器使用的 row conversion 移入新模块。仍被业务 repository 使用的转换函数留在原有业务位置，本任务不为了减少行数强行移动。

- [ ] **步骤 4：Store 统一通过加载器初始化和回滚**

构造和 `save()` 失败恢复都调用同一个私有适配：

```ts
private reloadState(): void {
  const loaded = loadSessionReadModel(this.database, this.eventRegistry)
  this.state = loaded.state
  this.reservedEventSeq = loaded.nextReservedEventSeq
}
```

不得保留第二套 SQL load 实现。

- [ ] **步骤 5：验证完整持久化重开路径**

运行：

```powershell
pnpm --filter @openharness/services test -- read-model store session-goals
pnpm --filter @openharness/services check-types
pnpm check:architecture
```

预期：全部通过；重开、legacy 拒绝、event cursor 和附件引用结果不变。

- [ ] **步骤 6：提交 Read Model**

```powershell
git add packages/services/src/database/read-model.ts packages/services/src/database/read-model.test.ts packages/services/src/session-runtime/store-state.ts packages/services/src/session-runtime/store.ts
git commit -m "refactor(services): extract session read model loading"
```

## 任务 5：提取 DurableEventSequence

**文件：**
- 创建：`packages/services/src/database/event-sequence.ts`
- 创建：`packages/services/src/database/event-sequence.test.ts`
- 修改：`packages/services/src/session-runtime/store-state.ts`
- 修改：`packages/services/src/session-runtime/store.ts`

- [ ] **步骤 1：编写序号窗口失败测试**

固定接口：

```ts
const sequence = DurableEventSequence.load(database.connection, 1)
expect(sequence.allocate()).toBe(1)
expect(sequence.allocate()).toBe(2)
const snapshot = sequence.snapshot()
sequence.allocate()
sequence.restore(snapshot)
expect(sequence.next).toBe(snapshot.next)
```

关闭数据库后重新打开，以旧实例已经预留但未使用完的窗口为基础，断言新实例分配的序号严格大于旧窗口上界，不复用旧序号。

- [ ] **步骤 2：运行测试确认类不存在**

运行：

```powershell
pnpm --filter @openharness/services test -- event-sequence
```

预期：FAIL，缺少 `DurableEventSequence`。

- [ ] **步骤 3：实现最小序号对象**

对象只拥有 `next`、`reservedThrough`、`allocate()`、`snapshot()` 和 `restore()`。窗口大小使用现有 `EVENT_SEQUENCE_BLOCK_SIZE = 1024`。`allocate()` 跨越窗口时同步更新 `session_event_sequence` 后再返回序号。

- [ ] **步骤 4：Store 使用序号对象并保持回滚**

删除 `reservedEventSeq` 和 `allocateEventSequence()`。`appendEventInMemory()` 调用 `this.eventSequence.allocate()`；Store transaction 进入时保存 snapshot，失败时 restore。Read model loader 返回已持久化事件最大序号，构造 `DurableEventSequence.load()` 时取它和数据库预留值的最大值。

- [ ] **步骤 5：运行序号和 Store 回归**

运行：

```powershell
pnpm --filter @openharness/services test -- event-sequence store event-registry
pnpm --filter @openharness/services check-types
```

预期：全部通过，现有跨 daemon restart 序号测试保持通过。

- [ ] **步骤 6：提交事件序号内核**

```powershell
git add packages/services/src/database/event-sequence.ts packages/services/src/database/event-sequence.test.ts packages/services/src/session-runtime/store-state.ts packages/services/src/session-runtime/store.ts
git commit -m "refactor(services): extract durable event sequence"
```

## 任务 6：提取 DeltaCheckpoint

**文件：**
- 创建：`packages/services/src/database/delta-checkpoint.ts`
- 创建：`packages/services/src/database/delta-checkpoint.test.ts`
- 修改：`packages/services/src/session-runtime/store-state.ts`
- 修改：`packages/services/src/session-runtime/store.ts`

- [ ] **步骤 1：编写时间与阈值失败测试**

使用 Vitest fake timers 固定行为：

```ts
const flush = vi.fn()
const checkpoint = new DeltaCheckpoint({ intervalMs: 150, bytes: 8192, flush })
checkpoint.markDirty("part-1", 100)
expect(flush).not.toHaveBeenCalled()
await vi.advanceTimersByTimeAsync(150)
expect(flush).toHaveBeenCalledTimes(1)
```

另测：累计达到 8192 bytes 立即请求 flush；同一 part 可重复标记但 dirty ID 不重复；flush 抛错后 dirty state 恢复并重新定时；`close()` 清 timer；snapshot/restore 保留 ID 和 bytes。

- [ ] **步骤 2：运行测试确认对象不存在**

运行：

```powershell
pnpm --filter @openharness/services test -- delta-checkpoint
```

预期：FAIL，缺少 `DeltaCheckpoint`。

- [ ] **步骤 3：实现状态协作者**

`DeltaCheckpoint` 只管理 dirty ID、pending bytes 和 timer，不执行 SQL。`flush` 回调仍由 Store 提供，并调用现有 `persistDeltaPartRows()`。公开最小方法：

```ts
markDirty(partId: string, addedBytes: number): boolean
snapshot(): DeltaCheckpointSnapshot
restore(snapshot: DeltaCheckpointSnapshot): void
dirtyPartIds(): string[]
clear(): void
schedule(): void
close(): void
```

`markDirty()` 返回是否达到字节阈值，由 Store 决定在当前事务外立即 flush，避免协作者越过 Store 的事务边界。

- [ ] **步骤 4：Store 替换四个 delta 字段与辅助函数**

删除 Store 的 `dirtyDeltaPartIds`、`pendingDeltaBytes`、`deltaFlushTimer` 以及 schedule/clear/restore 私有方法。transaction 通过 checkpoint snapshot/restore 保持当前语义；`flushMessagePartDeltas()` 成功后 clear，失败后 restore 并重新 schedule；`close()` 先完整 flush 再关闭 checkpoint。

- [ ] **步骤 5：运行 fake timer、失败恢复和 Store 回归**

运行：

```powershell
pnpm --filter @openharness/services test -- delta-checkpoint store
pnpm --filter @openharness/services check-types
git diff --check
```

预期：全部通过；现有 150ms、8KB、失败恢复和 close flush 测试无断言变化。

- [ ] **步骤 6：提交 DeltaCheckpoint**

```powershell
git add packages/services/src/database/delta-checkpoint.ts packages/services/src/database/delta-checkpoint.test.ts packages/services/src/session-runtime/store-state.ts packages/services/src/session-runtime/store.ts
git commit -m "refactor(services): extract delta checkpoint state"
```

## 任务 7：建立 StorageContext 并完成阶段 1 收口

**文件：**
- 创建：`packages/services/src/database/storage-context.ts`
- 修改：`packages/services/src/database/index.ts`
- 修改：`packages/services/src/session-runtime/store.ts`
- 修改：`packages/services/src/session-runtime/__test__/store.test.ts`
- 修改：`docs/architecture-migration-status.md`

- [ ] **步骤 1：增加兼容入口特征测试**

在 Store 测试中构造完整最小流程，证明旧公开入口仍然共同工作：

```ts
const session = store.createSession({ id: "s1", cwd, model: "m" })
const admitted = store.admitPromptWithRun({
  prompt: { id: "i1", sessionId: session.id, content: "hello" },
  run: { id: "r1", sessionId: session.id },
})
store.appendEvent({ type: "run.started", sessionId: session.id, payload: { runId: admitted.run.id } })
store.close()

const reopened = new SessionStore({ path })
expect(reopened.getSessionState("s1")).toMatchObject({
  session: { id: "s1" },
  inputs: [{ id: "i1" }],
  runs: [{ id: "r1" }],
})
```

使用 event registry 中已有的合法事件载荷；不要为通过测试伪造未知 durable event。

- [ ] **步骤 2：运行兼容测试确认当前基线**

运行：

```powershell
pnpm --filter @openharness/services test -- store
```

预期：新增测试通过。这是 characterization test，不要求先红；它锁定阶段 1 收口前的公开行为。

- [ ] **步骤 3：定义具体 StorageContext**

固定内部类型：

```ts
export interface StorageContext {
  database: SessionDatabase
  state: SessionState
  mutations: MutationBuffer
  eventSequence: DurableEventSequence
  deltaCheckpoint: DeltaCheckpoint
}
```

Store 内部用一个 `storage` 字段组合这些对象。为避免一次性改写 5,000 行，本阶段允许 Store 保留指向 `storage` 成员的窄 getter；禁止复制第二份 state 或 mutation buffer。

- [ ] **步骤 4：更新状态文档和基线**

`docs/architecture-migration-status.md` 将阶段 0、1 标为完成，记录：

- 新内核文件及职责；
- `SessionStore` 当前仍拥有的业务域；
- 旧入口调用基线是否下降；
- 下一份计划从 project/schedule 等低耦合 repository 开始；
- schema、migration 和公共 API 均未变化。

仅在实际调用数下降时运行 `--write-baseline`；不得为了让检查通过提高基线。

- [ ] **步骤 5：执行阶段 1 完整验证**

运行：

```powershell
pnpm --filter @openharness/services test
pnpm --filter @openharness/services check-types
pnpm check:architecture
pnpm check-types
node scripts/check-docs.mjs
git diff --check
```

预期：全部通过。检查 `git diff -- packages/services/src/session-runtime/schema.ts packages/services/src/session-runtime/migrations` 无输出，证明 schema 和 migration 没有变化。

- [ ] **步骤 6：提交阶段 1 收口**

```powershell
git add packages/services/src/database packages/services/src/session-runtime/store.ts packages/services/src/session-runtime/__test__/store.test.ts docs/architecture-migration-status.md scripts/architecture-baseline.json
git commit -m "refactor(services): establish storage kernel boundary"
```

## 最终验收清单

- [ ] `SessionStore` 的构造参数、公开方法和根导出未变化。
- [ ] SQLite schema、migration 文件和存储格式版本未变化。
- [ ] SQLite 连接配置、迁移、格式校验和关闭由 `SessionDatabase` 唯一拥有。
- [ ] Read model 只有一个加载实现，初始化和失败恢复共用它。
- [ ] MutationBuffer 克隆不共享任何 Set。
- [ ] Durable event sequence 跨重启不复用，并能随 Store transaction 回滚内存游标。
- [ ] Delta checkpoint 保持 150ms/8KB、失败恢复、terminal flush 和 close flush 语义。
- [ ] `StorageContext` 不复制 state、mutation 或连接。
- [ ] 架构检查禁止已知反向 package 依赖。
- [ ] 旧 Store/Client 平铺调用基线只减不增。
- [ ] `packages/services` 完整测试和全仓类型检查通过。
- [ ] 主分支仍可构建、测试和发布。
- [ ] 下一阶段可在不接触 SQLite 生命周期细节的情况下提取第一个业务 repository。
