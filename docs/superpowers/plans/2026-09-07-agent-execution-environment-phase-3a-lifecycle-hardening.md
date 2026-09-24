# Agent 执行环境第三阶段 3A 生命周期加固实现计划

> 状态：历史计划。容器 identity、复用和孤儿回收实现均已删除；当前方案见 [Native / WSL 智能体运行环境设计](../specs/2026-09-07-native-wsl-execution-environment-design.md)。

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:executing-plans 内联逐任务实现此计划。步骤使用复选框（`- [ ]`）语法跟踪进度；不调度子代理。

**目标：** 在继续采用“保存设置后重启生效”的前提下，补齐 settings 原子写、Docker 运行身份、daemon 启动孤儿清理和真实 Docker 验证，不引入数据库表、持久切换状态或热切换协议。

**架构：** `settings.json` 是环境配置的唯一事实来源，使用同目录临时文件加原子 rename 提交。`ExecutionEnvironmentManager` 继续只在内存管理 lease；Docker 容器和 exec 携带由数据目录派生的 installation ID，以及当前 `application_owner` 的 owner ID + generation。daemon 重启后在进入 ready 前保守清理能够证明属于本安装、且属于旧 daemon 实例的临时容器和 exec；复用容器保留，配置 hash 不匹配时仍由现有单版本启动逻辑在下一次 acquire 时替换。

**技术栈：** TypeScript、Vitest、Node.js 文件 API、SQLite 中现有 `application_owner`、Docker CLI、Turbo。

---

## 本计划明确不做

- 不新增 migration 或数据库表。
- 不持久化 `draining`、`switching`、`ready`、`unavailable`。
- 不保存 source/target Settings、affected owners 或 Session 环境版本。
- 不增加 `/environment` HTTP API、Client DTO 或 Desktop 状态机。
- 不实现无需重启的 local/docker 热切换；设置页继续明确显示“重启后生效”。
- 不自动停止用户终端或后台任务。
- 不实现 Native Plugin 环境化、工作区删除入口或跨平台自托管 CI。

## 必须保持的安全约束

- Docker 不可用时 fail-closed，不退回宿主执行。
- 同一 workspace owner 的容器名不包含 config hash，不并存多个配置版本。
- 只有 managed、installation、workspace owner 都匹配时，才允许复用或替换容器。
- orphan 判断必须同时比较 daemon owner ID 和 generation；不能只比较 generation。
- 未携带 installation label 的旧容器，以及 label 缺失、冲突或无法解析的资源，只报告，不删除、不 kill。
- 临时容器在 daemon 崩溃后不接管；复用容器可以保留，但旧 daemon exec 必须清理。
- reconciliation 在 daemon 对外 ready 之前完成。
- 配置保存前崩溃时恢复旧配置；原子保存后崩溃时只使用新配置。

## 文件职责

### 新建文件

- `packages/core/src/config/atomic-json-write.ts`：同目录临时文件、rename 和失败清理。
- `packages/core/src/config/atomic-json-write.test.ts`：原子提交与故障注入测试。
- `packages/server/src/runtime/installation-id.ts`：根据 daemon 数据目录派生稳定 installation ID。
- `packages/server/src/runtime/installation-id.test.ts`：Windows/POSIX 路径归一化与稳定性测试。
- `packages/sandbox/src/docker-orphan-reconciler.ts`：Docker inventory、纯清理决策和动作执行。
- `packages/sandbox/src/docker-orphan-reconciler.test.ts`：所有权验证与不误删测试。
- `packages/sandbox/e2e/docker-orphan-reconciliation.e2e.test.ts`：真实 Docker 崩溃残留清理测试。

### 修改文件

- `packages/core/src/config/settings.ts`：用户级和项目级 Settings 改用原子写。
- `packages/core/src/config/settings.test.ts`：保存结果与临时文件残留测试。
- `packages/environment/src/types.ts`：加入 daemon/environment 运行身份和执行 owner。
- `packages/sandbox/src/execution-environment-manager.ts`：在调用 `create()` 前生成 environment ID 并传入身份。
- `packages/sandbox/src/execution-environment-manager.test.ts`：同一 record 身份共享与新 record 换 ID。
- `packages/sandbox/src/execution-environment.ts`：把身份传给 Docker Runtime。
- `packages/sandbox/src/lifecycle.ts`：Sandbox Runtime 接收身份。
- `packages/sandbox/src/types.ts`：Sandbox Session 身份契约。
- `packages/sandbox/src/docker-backend.ts`：容器 labels、exec/PTY owner 环境变量和严格复用校验。
- `packages/sandbox/src/index.ts`：导出身份 label 与 reconciler。
- `packages/sandbox/src/index.test.ts`：Docker argv、labels 与 exec 环境变量测试。
- `packages/terminal-node/e2e/docker-pty.e2e.test.ts`：真实共享环境使用完整 daemon identity。
- `packages/services/src/executions/detached-process-supervisor.ts`：以 durable task ID 标记后台 Docker 进程。
- `packages/services/src/executions/__test__/detached-process-supervisor.test.ts`：后台 owner 传递测试。
- `packages/server/src/runtime/session-execution-environment.ts`：把 installation 和 application owner 交给 Manager。
- `packages/server/src/runtime/session-execution-environment.test.ts`：身份传递测试。
- `packages/server/src/application/daemon-application.ts`：在 application owner 之后、ready 之前运行 reconciliation。
- `packages/server/src/application/default-node-application.ts`：只在默认 Desktop managed 组装中注入真实 Docker reconciler。
- `packages/server/src/application/__test__/durable-agent-application.test.ts`：启动顺序和失败隔离测试。
- `packages/server/src/terminal/daemon-terminal-service.ts`：为 PTY 注入可信 terminal ID。
- `packages/server/src/terminal/daemon-terminal-service.test.ts`：终端 owner 标记测试。
- `packages/sandbox/package.json`：把 orphan E2E 纳入 Docker 测试脚本。
- `docs/sandbox-runtime-flow.md`：记录原子设置提交与启动清理流程。
- `docs/superpowers/specs/2026-09-07-agent-runtime-environment-and-terminal-design.md`：删除 3A 持久 switching 要求，明确热切换暂缓。

## 任务 1：让 Settings 文件真正原子提交

**文件：**

- 创建：`packages/core/src/config/atomic-json-write.ts`
- 创建：`packages/core/src/config/atomic-json-write.test.ts`
- 修改：`packages/core/src/config/settings.ts`
- 修改：`packages/core/src/config/settings.test.ts`

- [ ] **步骤 1：编写失败的原子写测试**

测试使用临时目录和可注入文件操作，覆盖：

```ts
const calls: string[] = []
await writeJsonFileAtomically(target, { sandbox: { enabled: true } }, {
  writeFile: async (path, content) => {
    calls.push(`write:${path}`)
    await fs.writeFile(path, content, "utf8")
  },
  rename: async (from, to) => {
    calls.push(`rename:${from}->${to}`)
    await fs.rename(from, to)
  },
  rm: fs.rm,
})

expect(calls[0]).toMatch(/write:.*\.tmp$/)
expect(calls[1]).toMatch(/rename:.*\.tmp->.*settings\.json$/)
expect(JSON.parse(await fs.readFile(target, "utf8")))
  .toMatchObject({ sandbox: { enabled: true } })
```

再注入 rename 失败，断言原 target 内容保持完整、临时文件被清理、原始错误返回。用户级 `saveSettings()` 与项目级 `saveProjectSettings()` 都必须走同一 helper。

- [ ] **步骤 2：运行测试并确认失败**

```bash
pnpm --filter @vykor/core test -- atomic-json-write.test.ts settings.test.ts
```

预期：FAIL，helper 尚不存在，当前实现直接覆盖 `settings.json`。

- [ ] **步骤 3：实现最小原子写 helper**

```ts
export async function writeJsonFileAtomically(
  targetPath: string,
  value: unknown,
  operations: AtomicJsonWriteOperations = nodeFileOperations,
): Promise<void> {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await operations.writeFile(temporaryPath, JSON.stringify(value, null, 2), "utf8")
    await operations.rename(temporaryPath, targetPath)
  } catch (error) {
    await operations.rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}
```

临时文件必须与 target 同目录，不能先删除 target，也不能用 copy 覆盖代替 rename。`saveSettings()` 和 `saveProjectSettings()` 只负责创建目录和调用 helper。

- [ ] **步骤 4：运行 Core 全套测试和类型检查**

```bash
pnpm --filter @vykor/core test
pnpm --filter @vykor/core check-types
git diff --check
```

预期：全部通过；保存后的 JSON 不包含 `_formatVersion`。

- [ ] **步骤 5：Commit**

```bash
git add packages/core/src/config
git commit -m "fix(settings): save configuration atomically (task 1/4)"
```

## 任务 2：为环境、容器和 exec 建立可验证运行身份

**文件：**

- 创建：`packages/server/src/runtime/installation-id.ts`
- 创建：`packages/server/src/runtime/installation-id.test.ts`
- 修改：`packages/environment/src/types.ts`
- 修改：`packages/sandbox/src/execution-environment-manager.ts`
- 修改：`packages/sandbox/src/execution-environment-manager.test.ts`
- 修改：`packages/sandbox/src/execution-environment.ts`
- 修改：`packages/sandbox/src/lifecycle.ts`
- 修改：`packages/sandbox/src/types.ts`
- 修改：`packages/sandbox/src/docker-backend.ts`
- 修改：`packages/sandbox/src/index.test.ts`
- 修改：`packages/terminal-node/e2e/docker-pty.e2e.test.ts`
- 修改：`packages/services/src/executions/detached-process-supervisor.ts`
- 修改：`packages/services/src/executions/__test__/detached-process-supervisor.test.ts`
- 修改：`packages/server/src/runtime/session-execution-environment.ts`
- 修改：`packages/server/src/runtime/session-execution-environment.test.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`packages/server/src/application/default-node-application.ts`
- 修改：`packages/server/src/terminal/daemon-terminal-service.ts`
- 修改：`packages/server/src/terminal/daemon-terminal-service.test.ts`

- [ ] **步骤 1：编写失败的 installation 与 identity 测试**

installation ID 只依赖规范化数据目录：

```ts
expect(deriveInstallationId("C:\\Users\\A\\.vykor\\data"))
  .toBe(deriveInstallationId("c:/Users/A/.vykor/data/"))
expect(deriveInstallationId("D:\\other\\data"))
  .not.toBe(deriveInstallationId("C:\\Users\\A\\.vykor\\data"))
```

算法固定为：

```text
sha256("vykor-installation-v1\0" + normalizedAbsoluteDataDir).slice(0, 32)
```

Windows 统一分隔符、盘符和大小写；POSIX 保持大小写。只把 hash 写入 Docker label，不暴露宿主绝对数据目录。

Manager 测试断言 `create(identity)` 在 handle 创建前拿到 environment ID；同 record 的 Agent/Terminal lease 共享身份，最后 lease 释放后再次 acquire 得到新 environment ID。

- [ ] **步骤 2：编写失败的 Docker label 与 exec owner 测试**

`docker run` 必须包含：

```text
org.vykor.sandbox.managed=true
org.vykor.sandbox.installation=<installationId>
org.vykor.sandbox.workspace-owner=<workspaceOwnerId>
org.vykor.sandbox.config-hash=<configHash>
org.vykor.sandbox.reusable=true|false
org.vykor.sandbox.created-by-owner=<daemonOwnerId>
org.vykor.sandbox.created-by-generation=<daemonGeneration>
org.vykor.sandbox.environment-id=<environmentId>
```

环境进程和 PTY 必须带：

```text
VYKOR_INSTALLATION_ID
VYKOR_DAEMON_OWNER_ID
VYKOR_DAEMON_GENERATION
VYKOR_ENVIRONMENT_ID
VYKOR_EXECUTION_KIND
VYKOR_EXECUTION_ID
```

后台任务使用 durable task ID；Terminal 使用服务端生成的 terminal ID。用户传入的同名 `VYKOR_*` 环境变量必须被覆盖或拒绝，不能伪造 owner。

- [ ] **步骤 3：运行测试并确认失败**

```bash
pnpm --filter @vykor/sandbox test -- execution-environment-manager.test.ts index.test.ts
pnpm --filter @vykor/terminal-node test -- environment-terminal-target.test.ts
pnpm --filter @vykor/services test -- detached-process-supervisor.test.ts
pnpm --filter @vykor/server test -- installation-id.test.ts session-execution-environment.test.ts daemon-terminal-service.test.ts
```

预期：FAIL，当前环境创建没有 installation/application owner identity，Docker 只有 managed/config/workspace labels。

- [ ] **步骤 4：实现身份传递和严格容器校验**

共享契约：

```ts
export interface ExecutionEnvironmentIdentity {
  installationId: string
  daemonOwnerId: string
  daemonGeneration: number
  environmentId: string
  workspaceOwnerId: string
  configHash: string
}

export interface EnvironmentExecutionOwner {
  kind: "agent" | "terminal" | "background" | "hook" | "mcp"
  id: string
}
```

将 Manager 请求改为：

```ts
create(identity: ExecutionEnvironmentIdentity): Promise<ExecutionEnvironmentHandle>
```

`DaemonApplication` 从现有 `store.path` 的目录派生 installation ID，并使用已经取得的 `ApplicationOwnerLease.ownerId/generation`。Agent 核心仍只接收环境 lease，不解析 Docker 身份。

`prepareReusableContainer()` 只有在 managed、installation、workspace owner、规范化 workspace 全部匹配后，才比较 config hash 并决定复用或删除重建。缺少新 label 的旧容器返回 `docker_container_ownership_unverified`，不添加兼容删除分支。

判断 exec 是否属于当前 daemon 必须比较完整复合键：

```ts
execution.daemonOwnerId === current.ownerId &&
execution.daemonGeneration === current.generation
```

- [ ] **步骤 5：运行相关包测试、类型检查和现有 Docker E2E**

```bash
pnpm --filter @vykor/environment test
pnpm --filter @vykor/sandbox test
pnpm --filter @vykor/terminal-node test
pnpm --filter @vykor/services test -- detached-process-supervisor.test.ts
pnpm --filter @vykor/server test -- installation-id.test.ts session-execution-environment.test.ts daemon-terminal-service.test.ts
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/sandbox e2e:docker
pnpm --filter @vykor/terminal-node e2e:docker
```

预期：全部通过；现有 PTY 输入、resize、Ctrl-C、EOF、terminate 和 lease 隔离行为不变。

- [ ] **步骤 6：Commit**

```bash
git add packages/environment packages/sandbox packages/terminal-node packages/server
git commit -m "feat(runtime): identify managed Docker workloads (task 2/4)"
```

## 任务 3：daemon 启动时保守清理孤儿 Docker 资源

**文件：**

- 创建：`packages/sandbox/src/docker-orphan-reconciler.ts`
- 创建：`packages/sandbox/src/docker-orphan-reconciler.test.ts`
- 修改：`packages/sandbox/src/index.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`packages/server/src/application/__test__/durable-agent-application.test.ts`

- [ ] **步骤 1：编写失败的纯清理策略测试**

inventory 输入包含 container labels 和 `/proc/*/environ` 解析出的 exec owner。覆盖：

- 当前 installation、旧 daemon 复合身份的临时容器：删除精确 container ID；
- 当前 installation 的复用容器：保留容器，只杀旧 daemon exec 进程组；
- 当前 daemon owner ID + generation 的 exec：保留；
- generation 相同但 owner ID 不同：仍视为旧 daemon；
- 另一 installation 或 installation 缺失：只报告 `ownership_unverified`；
- Docker inventory 命令失败：返回 diagnostics，不伪装成空列表。

```ts
expect(planDockerOrphanReconciliation(inventory, {
  installationId: "install-1",
  daemon: { ownerId: "daemon-new", generation: 1 },
})).toEqual({
  actions: [
    {
      kind: "kill_execution",
      containerId: "reuse-id",
      pid: 42,
      reason: "stale_daemon_execution",
    },
    {
      kind: "remove_container",
      containerId: "temp-id",
      reason: "orphan_temporary_environment",
    },
  ],
  diagnostics: [],
})
```

- [ ] **步骤 2：运行测试并确认失败**

```bash
pnpm --filter @vykor/sandbox test -- docker-orphan-reconciler.test.ts
```

预期：FAIL，reconciler 尚不存在。

- [ ] **步骤 3：实现 inventory、决策和动作执行**

单个文件保持三层函数：

```ts
listManagedDockerResources(input): Promise<DockerResourceInventory>
planDockerOrphanReconciliation(inventory, current): DockerCleanupAction[]
reconcileDockerOrphans(input): Promise<DockerReconciliationReport>
```

执行顺序：

1. `docker ps -a --filter label=org.vykor.sandbox.managed=true`；
2. inspect 候选容器并读取 labels/state；
3. 只对匹配 installation 的运行容器扫描 `/proc/*/environ`；
4. 先杀复用容器里的旧 exec 进程组；
5. 再 `docker rm -f <exact-container-id>` 删除旧 daemon 的临时容器；
6. 每个失败转换为 diagnostic，继续处理下一项。

不扫描宿主进程，不按容器名前缀直接删除，不接管临时容器。复用容器的 config hash 是否过期继续由 `DockerSandboxSession.start()` 按当前 cwd 的最新有效设置判断，reconciler 不冻结 owner/hash 列表。

- [ ] **步骤 4：接入 DaemonApplication 启动顺序**

顺序固定为：

```text
打开 Store
→ 取得 application owner lease
→ 派生 installation ID
→ reconcileDockerOrphans
→ 原有 workflow/background/projection recovery
→ ready
```

本机环境或 Docker CLI 不可用时，reconciler 只记录 observability diagnostic；它不能让本机 Agent 启动失败。当前有效环境是 Docker 时，后续环境 acquire 仍按现有规则 fail-closed。

- [ ] **步骤 5：运行 Sandbox 与 Server 测试和类型检查**

```bash
pnpm --filter @vykor/sandbox test -- docker-orphan-reconciler.test.ts
pnpm --filter @vykor/server test -- durable-agent-application.test.ts durability-boundaries.test.ts
pnpm --filter @vykor/sandbox check-types
pnpm --filter @vykor/server check-types
```

预期：全部通过；application 在 reconciliation 完成前不进入 ready。

- [ ] **步骤 6：Commit**

```bash
git add packages/sandbox packages/server/src/application
git commit -m "feat(runtime): reconcile Docker orphans on startup (task 3/4)"
```

## 任务 4：真实 Docker 验证与文档收尾

**文件：**

- 创建：`packages/sandbox/e2e/docker-orphan-reconciliation.e2e.test.ts`
- 修改：`packages/sandbox/package.json`
- 修改：`docs/sandbox-runtime-flow.md`
- 修改：`docs/superpowers/specs/2026-09-07-agent-runtime-environment-and-terminal-design.md`

- [ ] **步骤 1：编写真实 Docker E2E**

使用唯一 container prefix 和临时数据目录，覆盖：

1. 创建带完整身份 labels 的临时容器和复用容器；
2. 在复用容器启动两个带不同 daemon owner 复合身份的长进程；
3. 执行 reconciliation 后，旧临时容器消失；
4. 复用容器仍存在，旧 daemon exec 消失，当前 daemon exec 继续运行；
5. 相同 generation、不同 owner ID 的 exec 被正确视为旧实例；
6. installation 不同或缺失的容器保持不动，并出现在 diagnostics；
7. config hash 变化后下一次 acquire 替换原容器，且同名 owner 仍只有一个容器；
8. 测试结束只清理本测试唯一 prefix 下的容器。

- [ ] **步骤 2：运行 E2E 并确认失败**

```bash
pnpm --filter @vykor/sandbox e2e:docker
```

预期：FAIL，新 E2E 需要的 labels 和 reconciler 尚未实现。

- [ ] **步骤 3：把 orphan E2E 纳入现有 Docker 脚本**

```json
{
  "scripts": {
    "e2e:docker": "vitest run --config ../../vitest.e2e.config.ts e2e/docker.e2e.test.ts e2e/docker-orphan-reconciliation.e2e.test.ts"
  }
}
```

不在 3A 新增 CI job。GitHub hosted Windows/macOS 的 Linux Docker daemon 能力与自托管 runner 选择由 3D 单独计划决定。

- [ ] **步骤 4：修订权威文档**

删除或改写这些旧假设：

- 第 5.4 节不再把热切换列为 3A 交付，保留为可选未来能力；
- 第 10.4 节不再要求持久 switching 或完整 lease 恢复；
- 第 18.3 节明确 3A 是“安全重启与启动清理”，热切换另行评估；
- 验收项删除持久 source/target hash 和 switching 恢复；
- UI 继续准确显示“设置已保存，重启后生效”。

文档加入确定性崩溃说明：

```text
settings rename 前崩溃 → 完整旧配置
settings rename 后崩溃 → 完整新配置
daemon 重启 → 用当前 settings + Docker labels 清理/重建
```

- [ ] **步骤 5：运行最终验证**

```bash
pnpm exec turbo test --concurrency=4 --env-mode=loose
pnpm exec turbo check-types --concurrency=4 --env-mode=loose
node --test scripts/prepare-tag-release.test.mjs scripts/npm-release.test.mjs
pnpm --filter @vykor/sandbox e2e:docker
pnpm --filter @vykor/terminal-node e2e:docker
git diff --check
```

真实 Docker 结果单独记录通过数量和显式 skip。若全仓 Desktop 路由测试在并发压力下超时，使用完整 Desktop 单包测试复核；不能把产品失败标成环境波动。

- [ ] **步骤 6：确认安全不变量**

逐项核对：

- 用户级和项目级 Settings 都只会留下完整旧文件或完整新文件；
- installation ID 不写数据库，不包含原始数据目录；
- 当前 daemon 身份使用 owner ID + generation，而不是单独 generation；
- 未验证资源没有收到 rm/kill；
- 临时 orphan 被删除，复用容器只清理旧 exec；
- 配置 hash 不匹配时只在完整所有权验证后替换；
- 同一 workspace owner 没有第二个配置版本容器；
- Docker 失败没有触发宿主回退；
- 设置页没有声称支持热切换。

- [ ] **步骤 7：Commit**

```bash
git add packages/sandbox docs
git commit -m "test(runtime): verify restart lifecycle safety (task 4/4)"
```

## 第三阶段 3A 完成条件

- Settings 保存具备真实原子提交边界。
- 容器和 exec 身份足以区分安装、workspace、environment 和 daemon 实例。
- daemon ready 前清理当前安装中可确认的孤儿临时容器和旧 exec。
- 未知所有权资源保持不动并给出诊断。
- 重启后按当前最新设置恢复，不保存或恢复旧环境版本。
- 同一 workspace owner 仍只保留一个容器版本。
- 真实 Docker E2E、全仓测试和类型检查全部有明确通过证据。
