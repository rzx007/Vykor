# Workflow Repository 提取设计

> 状态：当前。阶段 2C1 的实施规格。

## 背景

Project 和 Schedule Repository 已从 `SessionStore` 提取。Workflow 存储比前两域复杂：写操作受 Application Owner 保护；保存一个 Workflow Run 时会原子替换 task attempts；追加 workflow event 后，Server 还可能把它镜像为 session durable event 并通知 SSE。

## 目标

- 建立唯一的 `WorkflowRepository`，拥有 Workflow SQL 和 row conversion。
- 保留 owner fence、run/attempt 原子保存、event 顺序和 claim 语义。
- `SessionWorkflowRunRepository` 继续负责 Coordinator 编解码、wait/listener、session event 镜像和 SSE 通知。
- Store 原有七个 Workflow 方法保留为兼容转发。
- `run-inspector` 和 daemon control 使用窄 Workflow 查询能力。
- schema、migration、Coordinator API 和协议不变。

## 非目标

- 不同时迁移 Channel。
- 不把 Workflow event 与 session durable event 合并成同一张表。
- 不把 wait/listener 放进 Services 存储层。
- 不重做 claim 为分布式租约或增加 heartbeat。
- 不移动 retention 中的 Workflow 清理 SQL；该跨域清理留给 Maintenance 阶段。

## 目标结构

```text
packages/services/src/workflows/
├─ workflow-records.ts
├─ workflow-repository.ts
├─ workflow-repository.test.ts
└─ index.ts
```

## Repository API

```ts
export class WorkflowRepository {
  constructor(private readonly storage: StorageContext)

  saveRun(input: StoredWorkflowRunInput): void
  loadRun(runId: string): StoredWorkflowRunRecord | undefined
  listRuns(options?: { ownerSessionId?: string; status?: string }): StoredWorkflowRunRecord[]
  appendEvent(input: StoredWorkflowEventInput): number
  listEvents(runId: string): string[]
  claimRun(runId: string, ownerId: string): WorkflowRunClaim
  finishClaim(runId: string, ownerId: string, status: string): void
}
```

Workflow 类型从 `store.ts` 移入 `workflows/workflow-records.ts`，但继续由 session-runtime 兼容入口和 Services 根入口按原名称导出。

## Owner Fence

`saveRun()`、`appendEvent()`、`claimRun()` 和 `finishClaim()` 必须保留当前 Application Owner 检查。`StorageContext` 增加迁移期能力：

```ts
assertWritable(): void
```

它由 Store 绑定到现有 owner fence。Repository 不持有 Store，不读取 `activeOwnerLease`。Owner lease 最终迁入 database 内核时，只替换能力提供者。

只读方法不触发 owner fence。

## 原子与状态规则

### 保存 Run

在一个 SQLite transaction 中：

1. upsert workflow_run；
2. 删除该 run 的旧 task attempts；
3. 插入新 attempts。

任一 attempt 插入失败时，run upsert 和 attempts 删除一起回滚。测试必须用 trigger 在第二个 attempt 插入时失败，并验证旧 run snapshot 与旧 attempts 完整保留。

### Workflow Event

`WorkflowRepository.appendEvent()` 只写 `workflow_event` 并返回数据库 seq。`SessionWorkflowRunRepository.appendEvent()` 负责：

1. 读取 Workflow owner session；
2. 记录 `previousEventSeq`；
3. 写 workflow event；
4. 若有 owner session，调用 session event 能力写 `workflow.<type>`；
5. 调用 SSE 通知；
6. 通知本地 wait listener。

本阶段保持当前先后顺序，不声称两张事件表原子提交。若 workflow event 已保存、随后 session durable event 写入失败，则 workflow event 保留，错误继续上抛，SSE 回调和本地 waiter 都不通知。不得在 `finally` 中通知或吞掉镜像错误。跨域原子化需要独立 transaction script 设计，不在 Repository 内注入 session event 回调。

### Claim

- 首次 claim generation 为 1；
- 同一 owner 对仍 running 的 claim 重复获取时拒绝；
- 不同 owner 或已结束 claim 可用更高 generation 接管；
- finish 只允许当前 owner 且 status=running；
- 所有 claim 写入受 owner fence 保护。

## Server 边界

`SessionWorkflowRunRepository` 构造时接收：

- `WorkflowRepository` 的七项存储能力；
- session event 的 `latestEventSeq/appendEvent` 窄能力；
- durable event 通知回调。

它不再依赖完整 `SessionStore`。`repositoryKey` 从显式数据库 path 构造，不通过 Store 取路径。

为解决 event-only 变化发生在 `waitForChange()` 首次读取与 listener 注册之间时的丢唤醒，Server adapter 为每个 run 保存进程内 change version。`save()` 和成功完成全部 event 镜像后递增 version 并 notify；wait 在首次读取前捕获 version，注册 listener 后同时复查 snapshot `updatedAt` 和 version。event 镜像失败不递增 version。该 version 只解决当前进程的注册竞态，不进入 durable schema。

`run-inspector` 和 daemon control 只需要 `listRuns()`；通过局部结构类型接收，不依赖 Workflow 的写方法。

Daemon composition 注入 `store.workflows`、session event capability 和 `store.path`。

## SessionStore 兼容边界

Store 增加：

```ts
readonly workflows: WorkflowRepository
```

旧七个 Workflow 方法只转发。兼容 `appendWorkflowEvent()` 继续处理可选 `sessionId`：先写 Repository event，再按当前行为追加 session durable event。新 Server adapter 不使用该复合兼容方法，而是显式组合两个窄能力。

## 测试

Repository 使用真实 SQLite，覆盖：

- run/attempt 保存、替换、过滤和磁盘重载；
- 第二个 attempt 失败时完整回滚；
- event seq 与顺序；
- claim 重复、接管、结束和错误；
- owner fence 拒绝失效 owner 的写入；
-返回对象隔离。

Store 测试覆盖七个旧方法，特别是带 `sessionId` 的兼容 event 镜像。

Server 测试覆盖：

- snapshot/event 编解码；
- snapshot save 与 event-only 变化在 wait 注册前后都不丢唤醒；
- event 镜像成功后通知 SSE；session event 写入失败时 workflow event 保留，但 SSE、waiter 不通知且错误上抛；
-窄 fake 的全部存储调用；
-真实 DaemonApplication composition 不使用 Store Workflow 平铺方法。

## 验收标准

- 除明确保留到 Maintenance 阶段的 retention 跨域清理 SQL 外，Workflow CRUD、event 和 claim SQL 只存在于 `packages/services/src/workflows`。
- Store 七个方法只转发或保留明确标注的 event 镜像兼容编排。
- Server Workflow adapter 不依赖完整 SessionStore。
- owner fence、原子保存、claim 和 wait 行为有失败路径测试。
- retention 行为、schema、migration 和协议不变。
- Services、Server、架构和文档检查通过。
-旧 Store 调用基线下降。
