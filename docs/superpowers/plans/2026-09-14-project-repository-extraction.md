# Project Repository 提取实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 Project 的 SQLite、路径和更新规则从 `SessionStore` 提取到唯一的 `ProjectRepository`，保留旧 API，并让 Server 只依赖窄 Project capability。

**架构：** `ProjectRepository` 直接使用 `StorageContext`；查询以 SQLite 为权威，rebind 通过临时 `storage.atomic()` 保持 SQLite、read model 和 mutation buffer 联合回滚。`SessionStore` 只保留兼容转发，Server composition 注入 `store.projects`。

**技术栈：** TypeScript、better-sqlite3、Vitest、pnpm workspace。

---

## 文件结构

- 创建 `packages/services/src/projects/project-records.ts`：row 转换、路径规范化和默认名称。
- 创建 `packages/services/src/projects/project-repository.ts`：Project 查询和写操作。
- 创建 `packages/services/src/projects/project-repository.test.ts`：真实 SQLite Repository 测试。
- 创建 `packages/services/src/projects/index.ts`：内部导出。
- 修改 `packages/services/src/database/storage-context.ts`：增加临时 `atomic()` 能力。
- 修改 `packages/services/src/session-runtime/store.ts`：构造 Repository、旧方法转发、`createSession()` 使用新入口。
- 修改 `packages/services/src/session-runtime/__test__/store.test.ts`：保留兼容测试，迁移 Project 细节测试。
- 修改 `packages/server/src/application/project-application-service.ts`：依赖窄 capability。
- 修改 `packages/server/src/application/daemon-application.ts`：注入 `store.projects`。
- 创建或修改 `packages/server/src/application/__test__/project-application-service.test.ts`：委托和目录校验测试。
- 修改 `docs/architecture-migration-status.md`、`scripts/architecture-baseline.json`：记录阶段 2A 和下降后的基线。

## 任务 1：提取 Project Records 与只读 Repository

**文件：**
- 创建：`packages/services/src/projects/project-records.ts`
- 创建：`packages/services/src/projects/project-repository.ts`
- 创建：`packages/services/src/projects/project-repository.test.ts`
- 创建：`packages/services/src/projects/index.ts`
- 修改：`packages/services/src/database/storage-context.ts`

- [ ] **步骤 1：编写失败测试**

用 `SessionStore` 写入两个项目后，从测试内部取得真实 `storage`，构造 `ProjectRepository`，断言：

```ts
expect(repository.list().map((project) => project.id)).toEqual([second.id, first.id])
expect(repository.get(first.id)).toMatchObject({ id: first.id, path: firstPath })
expect(repository.list({ includeArchived: true })).toHaveLength(2)
```

另测 Windows 风格路径规范化函数将反斜杠、尾斜杠和大小写转换为同一稳定值。

- [ ] **步骤 2：运行测试确认失败**

```powershell
pnpm --filter @openharness/services test -- project-repository
```

预期：FAIL，缺少 projects 模块。

- [ ] **步骤 3：实现最小只读 Repository**

`ProjectRepository` 构造器只保存 `StorageContext`，不得查询数据库。实现 `list()` 和 `get()`，复用当前 SQL、排序和 clone 行为。`project-records.ts` 导出 `projectFromRow()`、`normalizeProjectPath()` 和 `defaultProjectName()`。

- [ ] **步骤 4：验证并提交**

```powershell
pnpm --filter @openharness/services test -- project-repository store
pnpm --filter @openharness/services check-types
git diff --check
git add packages/services/src/projects packages/services/src/database/storage-context.ts
git commit --no-verify -m "refactor(services): add project repository queries"
```

## 任务 2：提取 Project 写操作与联合回滚

**文件：**
- 修改：`packages/services/src/projects/project-repository.ts`
- 修改：`packages/services/src/projects/project-repository.test.ts`
- 修改：`packages/services/src/database/storage-context.ts`
- 修改：`packages/services/src/session-runtime/store.ts`

- [ ] **步骤 1：编写写操作失败测试**

覆盖 inspect、rename、pin、default shell、archive 和 rebind。固定兼容行为：

```ts
expect(repository.rename(id, "  New   Name ").name).toBe("New Name")
expect(repository.setDefaultShell(id, null).defaultShell).toBeUndefined()
expect(repository.list().map((project) => project.id)).not.toContain(id)
```

- [ ] **步骤 2：编写 rebind 故障注入测试**

创建同一 Project 下的 `s1`、`s2`，给 `session` 表添加 trigger：当 `NEW.id = 's2'` 时 `RAISE(ABORT, 'forced rebind failure')`。调用 rebind 后同时断言：

```ts
expect(repository.get(project.id)?.path).toBe(oldPath)
expect(store.getSession("s1")?.cwd).toBe(oldSessionPath)
expect(sqliteSessionCwds()).toEqual([oldSessionPath, oldSecondPath])
expect(internals.storage.mutations.sessions.size).toBe(0)
```

- [ ] **步骤 3：运行测试确认缺少写方法或回滚失败**

```powershell
pnpm --filter @openharness/services test -- project-repository
```

预期：FAIL，写方法不存在；若先机械移动现实现，故障注入测试因 read model 未回滚而失败。

- [ ] **步骤 4：实现写操作和临时 atomic 能力**

`StorageContext` 增加：

```ts
atomic<T>(work: () => T): T
```

Store 组合 Context 时绑定 `atomic: (work) => this.transaction(work)`。Repository 的 inspect 新建和 rebind 使用 `storage.atomic()`；rebind 在事务中始终 INSERT 新 location，更新每个相关 session 的内存 cwd、SQLite cwd，并把 session ID 加入 mutation buffer。简单单条 SQL 更新直接执行并返回 `get()`。

- [ ] **步骤 5：验证嵌套事务和完整 Store**

```powershell
pnpm --filter @openharness/services test -- project-repository store
pnpm --filter @openharness/services check-types
git diff --check
```

预期：Project 和 Store 测试全部通过，故障注入后四类状态恢复。

- [ ] **步骤 6：提交写操作**

```powershell
git add packages/services/src/projects packages/services/src/database/storage-context.ts packages/services/src/session-runtime/store.ts
git commit --no-verify -m "refactor(services): move project mutations into repository"
```

## 任务 3：收缩 SessionStore Project 兼容入口

**文件：**
- 修改：`packages/services/src/session-runtime/store.ts`
- 修改：`packages/services/src/session-runtime/__test__/store.test.ts`

- [ ] **步骤 1：增加兼容入口测试**

通过旧 `SessionStore` 方法完成 inspect → rename → pin → shell → rebind → archive，并断言返回字段与 Repository 一致；创建 session 时不传 projectId，断言仍自动 inspect cwd 并绑定 Project。

- [ ] **步骤 2：运行测试确认基线通过**

```powershell
pnpm --filter @openharness/services test -- store
```

该步骤是特征测试，预期在删除旧实现前通过。

- [ ] **步骤 3：构造公开 Repository 并替换实现**

Store 增加 `readonly projects: ProjectRepository`，在完整 `StorageContext` 创建后构造。八个旧 Project 方法只转发；`createSession()` 调用 `this.projects.get()`/`inspect()`。删除 Store 中 Project SQL、`projectFromRow()` 和 `normalizeProjectPath()`。

- [ ] **步骤 4：验证旧 API 与 schema 不变**

```powershell
pnpm --filter @openharness/services test
pnpm --filter @openharness/services check-types
git diff -- packages/services/src/session-runtime/schema.ts packages/services/src/session-runtime/migrations
```

预期：测试和类型检查通过，最后一条无输出。

- [ ] **步骤 5：提交兼容收缩**

```powershell
git add packages/services/src/session-runtime/store.ts packages/services/src/session-runtime/__test__/store.test.ts
git commit --no-verify -m "refactor(services): delegate projects from session store"
```

## 任务 4：迁移 Server 到窄 Project Capability

**文件：**
- 修改：`packages/server/src/application/project-application-service.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 创建：`packages/server/src/application/__test__/project-application-service.test.ts`
- 修改：`docs/architecture-migration-status.md`
- 修改：`scripts/architecture-baseline.json`

- [ ] **步骤 1：编写 Server 失败测试**

定义测试 fake，覆盖 list、inspect、rename、setPinned、setDefaultShell、rebind、archive 的参数与返回值。目录校验使用真实临时目录，非目录路径必须抛出 `path is not a directory`。测试 composition 传入的是 `store.projects`。

- [ ] **步骤 2：运行测试确认旧构造边界不符**

```powershell
pnpm --filter @openharness/server test -- project-application-service
```

预期：FAIL，Service 仍要求完整 `SessionStore` 或缺少测试入口。

- [ ] **步骤 3：实现窄 capability 和 composition 接线**

在 `project-application-service.ts` 定义只含七个现有动作的 `ProjectOperations`，构造器接受该类型。`daemon-application.ts` 改为：

```ts
this.projects = new ProjectApplicationService(store.projects)
```

不新增 get route，不修改协议。

- [ ] **步骤 4：更新状态与基线**

将阶段 2A 标为完成，记录 `SessionStore` 仍保留兼容转发。运行：

```powershell
node scripts/architecture-boundaries.mjs --write-baseline
pnpm check:architecture
```

只接受 Store 平铺调用数字下降，不得提高任何基线。

- [ ] **步骤 5：最终验证并提交**

```powershell
pnpm --filter @openharness/services test
pnpm --filter @openharness/server test -- project
pnpm --filter @openharness/services check-types
pnpm --filter @openharness/server check-types
pnpm check:architecture
node scripts/check-docs.mjs
git diff --check
```

预期：全部通过。

```powershell
git add packages/server/src/application docs/architecture-migration-status.md scripts/architecture-baseline.json
git commit --no-verify -m "refactor(server): depend on project repository capability"
```

## 最终验收

- [ ] `ProjectRepository` 是 Project SQL、路径和写规则的唯一所有者。
- [ ] `SessionStore` 的八个 Project 方法只转发。
- [ ] `createSession()` 通过 Repository 绑定 Project。
- [ ] rebind 故障注入证明 SQLite、read model 和 mutation buffer 联合回滚。
- [ ] 重新绑定历史路径仍 INSERT 新 location。
- [ ] 默认 shell 的 `null` 清空语义不变。
- [ ] Server 只依赖七个动作的窄 capability。
- [ ] schema、migration、HTTP/SSE 和根公共导出不变。
- [ ] 架构基线下降且不提高其他指标。
