# Project Repository 提取设计

> 状态：当前。阶段 2A 的实施规格。

## 背景

阶段 0–1 已将 SQLite 生命周期、read model、mutation buffer、durable event sequence 和 delta checkpoint 从 `SessionStore` 提取到 `packages/services/src/database`。`SessionStore` 仍包含 project 的查询、识别、重命名、置顶、默认 shell、归档和路径重绑定逻辑。

Project 是阶段 2 中耦合最低、边界最清楚的业务域，适合作为第一个 Repository 提取样板。

## 目标

- 建立唯一的 `ProjectRepository` 项目存储入口。
- 从 `SessionStore` 移出全部 Project SQL、路径规范化和行转换逻辑。
- 保留 `SessionStore` 原有公开方法作为兼容转发。
- `createSession()` 通过 Repository 查找或识别项目，不复制项目规则。
- 保持数据库 schema、migration、公共类型、ID 和行为不变。
- 为后续 Schedule、Workflow 等 Repository 提供简单、可复用的组织模式。

## 非目标

- 不新增 `ProjectService`、Repository interface 或 factory。
- 不修改 HTTP、SSE、CLI、Desktop 或 Client 协议。
- 不改变项目名称生成、排序、归档或 rebind 行为。
- 不迁移其他业务域。
- 不重命名 `packages/services`。

## 采用方案

使用一个具体的 `ProjectRepository` 作为唯一实现者。它直接依赖 `StorageContext`，负责 Project 的 SQLite 读写和涉及 session cwd 的原子更新。`SessionStore` 原方法只转发。

不采用只提取 helper 的方案，因为它仍会让 Store 拥有业务流程；也不增加 `ProjectService`，因为当前没有独立于持久化的应用编排需要承载。

## 文件结构

```text
packages/services/src/projects/
├─ project-repository.ts
├─ project-records.ts
├─ project-repository.test.ts
└─ index.ts
```

### `project-repository.ts`

公开具体类：

```ts
export class ProjectRepository {
  constructor(private readonly storage: StorageContext)

  list(options?: { includeArchived?: boolean }): ProjectRecord[]
  get(projectId: string): ProjectRecord | undefined
  inspect(inputPath: string): ProjectRecord
  rename(projectId: string, name: string): ProjectRecord
  setPinned(projectId: string, pinned: boolean): ProjectRecord
  setDefaultShell(projectId: string, shell: string | undefined): ProjectRecord
  archive(projectId: string): ProjectRecord
  rebind(projectId: string, inputPath: string): ProjectRecord
}
```

方法名在 Repository 内采用简洁业务名；`SessionStore` 保留 `listProjects()`、`getProject()` 等旧方法。

### `project-records.ts`

只保存 Project 域的数据转换和路径规则：

- SQLite row 到 `ProjectRecord`；
- 路径解析和规范化；
- 默认项目名称；
- project location 行读取所需的内部类型。

不得放置 SQL、事务或跨域流程。

### `index.ts`

只导出 `ProjectRepository` 及项目域内部确实需要的类型。阶段 2A 不从 `@openharness/services` 根入口公开 Repository。

## StorageContext 调整

Repository 需要访问：

- `storage.database.connection`：执行 Project 和 session cwd SQL；
- `storage.state`：更新已加载 session 的 cwd、projectId 和时间；
- `storage.mutations`：标记受影响 session；
- Store 提供的事务提交能力。

现有 `StorageContext` 不应反向依赖 `ProjectRepository`。为了让 Repository 触发与 Store 相同的提交/回滚语义，在 Context 中增加最窄的事务能力：

```ts
transaction<T>(work: () => T): T
save(): void
```

这两个函数由 `SessionStore` 组合时注入，Repository 不持有 Store，也不调用 Store 的公开业务方法。

## 数据流

### Project 查询

```text
调用方
  → SessionStore 兼容方法或内部 ProjectRepository
  → ProjectRepository
  → SQLite project + active project_location
  → ProjectRecord
```

Project 不进入 Session read model，查询继续以 SQLite 为权威来源。

### Inspect

1. resolve 输入路径并计算 normalized path；
2. 查找 active project location；
3. 已存在则更新 project `last_opened_at/updated_at`；
4. 不存在则创建 project 与 active location；
5. 返回当前 ProjectRecord。

项目和 location 的创建必须处于一个 SQLite 事务中。

### Rebind

1. 校验 project 存在；
2. resolve 并规范化新路径；
3. 检查新路径没有绑定给其他 active project；
4. 将旧 active location 退役并创建或激活新 location；
5. 根据每个 session 的 `cwdRelative` 更新 SQLite 和内存 read model 中的 cwd；
6. 一次提交全部变化。

任何一步失败时，location、session SQLite 行和内存 state 必须一起回滚。

## SessionStore 兼容边界

Store 构造后拥有：

```ts
readonly projects: ProjectRepository
```

旧方法只转发：

```ts
listProjects(options) { return this.projects.list(options) }
getProject(id) { return this.projects.get(id) }
inspectProject(path) { return this.projects.inspect(path) }
```

其余 rename、pin、shell、archive 和 rebind 同理。兼容方法中不得保留 SQL、路径判断或状态修改。

`createSession()` 改为调用 `projects.get()` 或 `projects.inspect()`。ProjectRepository 不调用 `createSession()`，避免循环。

## 不变量

- 同一个规范化路径最多属于一个 active project location。
- Windows 路径比较保持当前大小写和斜杠归一化规则。
- 再次 inspect 已知路径只更新打开时间，不创建重复项目。
- 未置顶项目的排序保持稳定。
- 清空默认 shell 后返回 `undefined`，而不是空字符串。
- archive 后默认列表不可见，`includeArchived` 仍可查询。
- rebind 保持 session ID 和 `cwdRelative`，只更新绝对 cwd。
- rebind 的 location 与 session 更新原子提交。
- 所有返回对象继续使用克隆值，调用方不能修改内部状态。

## 错误处理

保持当前错误类型和消息行为：

- Project 不存在时拒绝更新、归档或 rebind；
- 名称经过当前规则处理；
- active path 已绑定其他 Project 时拒绝 rebind；
- SQLite 或事务失败时不暴露半完成状态。

阶段 2A 不引入新的错误码或异常层次。

## 测试策略

### Repository 测试

使用真实临时 SQLite 数据库和 `StorageContext`，覆盖：

- inspect 新路径和重复路径；
- list/get 与 archived 过滤；
- rename、pin、默认 shell 设置和清除；
- 未置顶排序；
- rebind 更新 location 和 session cwd；
- rebind 冲突与事务回滚；
- 返回对象克隆隔离。

### Store 兼容测试

保留一组通过 `SessionStore` 旧方法执行的端到端测试，证明公共入口和返回值不变。原有 Project 测试迁入 Repository 测试后，不在两个文件完整重复。

### Server 接入测试

`ProjectApplicationService` 改为依赖窄的 Project 能力，而不是整个 `SessionStore`。测试证明 list/get/inspect/update 请求只通过新入口执行。

## 实施顺序

1. 为 `ProjectRepository` 编写失败测试；
2. 提取 project records 和只读查询；
3. 提取 inspect 与简单更新；
4. 提取 rebind 及事务回滚；
5. 给 `StorageContext` 注入最窄事务能力；
6. 让 Store 旧方法转发，并迁移 `createSession()`；
7. 迁移 Server Project service 到窄依赖；
8. 运行 Services、Server、架构和文档验证；
9. 更新旧入口调用基线。

## 验收标准

- `SessionStore` 不再包含 Project SQL、路径规范化或 row conversion。
- `ProjectRepository` 是 Project 持久化规则的唯一所有者。
- `SessionStore` 原 Project API 和 `@openharness/services` 根导出不变。
- `createSession()` 不复制 project 识别规则。
- Project/location 创建与 rebind 继续原子提交。
- schema 和 migration 无变化。
- Project Repository、Store 兼容和 Server 接入测试通过。
- Services 与 Server 类型检查通过。
- 架构基线只减不增。
