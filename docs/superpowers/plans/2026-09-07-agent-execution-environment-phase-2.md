# Agent 运行环境第二期：统一终端体验实现计划

> 状态：历史计划，Docker 终端与共享 lease 已删除；当前终端见 [Desktop 终端与 PTY](../../desktop-terminal-pty-design.md)。

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 Agent Terminal 和用户默认集成终端跟随当前 Agent 环境，在 Docker 中使用真实 PTY，并让项目、项目外会话、fork 和非隔离子 Agent 通过内存 lease 安全共享同一个环境。

**架构：** daemon 持有唯一 `ExecutionEnvironmentManager`，Agent、终端和后台任务只能向它取得带 owner 的 lease。`@vykor/environment` 定义通用 PTY 启动契约，Sandbox 负责生成并监督 Docker `exec -it`，`@vykor/terminal-node` 只负责用 `node-pty` 驱动目标。第二期保持“重启后切换配置”，不加入第三期的运行中 switching、持久 lease 或崩溃恢复。

**技术栈：** TypeScript、Node.js、Electron、Hono、node-pty、Docker CLI、Vitest、React。

**依据规格：** `docs/superpowers/specs/2026-09-07-agent-runtime-environment-and-terminal-design.md` 第 10～12 节和第 18.2 节。

---

## 范围边界

本计划包含：

- Docker 真实 PTY、输入、resize、Ctrl-C、EOF 和 terminate；
- Agent Terminal 跟随 Agent 环境；
- 用户默认终端跟随 Agent 环境，并保留“在本机打开”；
- `project` / `session` 判别作用域；
- 项目外会话终端；
- daemon 内唯一 Environment Manager、workspace owner 和内存 lease；
- Agent、终端、后台任务共享环境；
- 同一 owner 不并存多个配置版本。

本计划不包含：

- 运行中热切换、draining/switching 事务；
- lease 持久化、daemon 崩溃恢复和 orphan reconciliation；
- Native Plugin Tool 在 Docker 中重新启用；
- 动态挂载或 Plugin 根目录挂载；
- 恢复历史 Session 使用过的旧环境版本。

## 文件结构

### Environment 与 Sandbox

- `packages/environment/src/types.ts`：增加通用交互终端目标、控制器和 lease 契约。
- `packages/environment/src/types.test.ts`：验证 PTY 与 lease 的最小类型行为。
- `packages/sandbox/src/docker-backend.ts`：生成受监督的 `docker exec -it` 启动参数并停止单个 exec 进程组。
- `packages/sandbox/src/execution-environment.ts`：向环境句柄暴露交互终端目标工厂。
- `packages/sandbox/src/execution-environment-manager.ts`：唯一的内存环境记录、并发 acquire 和引用计数。
- `packages/sandbox/src/execution-environment-manager.test.ts`：覆盖共享、并发、幂等 release 和配置冲突。
- `packages/sandbox/src/index.ts`：导出 Manager 和 PTY 相关能力。

### Terminal、协议与服务

- `packages/protocol/src/terminal.ts`：定义 `TerminalScope`，让 `projectId` 可选并保留解析后的 scope。
- `packages/protocol/src/serialization.ts`：严格解码新终端响应。
- `packages/protocol/src/serialization.test.ts`：覆盖 project/session 两种 scope。
- `packages/terminal/src/provider.ts`：让 Terminal Provider 接收已解析的 PTY target 和释放回调。
- `packages/terminal-node/src/local-terminal-provider.ts`：统一使用 node-pty，删除普通 pipe 的 sandbox terminal。
- `packages/terminal-node/src/environment-terminal-target.ts`：把本机或环境 PTY target 转成 node-pty 参数。
- `packages/terminal-node/src/local-terminal-provider.test.ts`：覆盖输入、resize、信号和只释放本终端。
- `packages/terminal-node/e2e/docker-pty.e2e.test.ts`：真实 Docker PTY 闭环。
- `packages/server/src/runtime/environment-owner.ts`：从 Session、Project、fork 和 cwd 计算 workspace owner。
- `packages/server/src/runtime/environment-owner.test.ts`：覆盖 owner 继承规则。
- `packages/server/src/terminal/daemon-terminal-service.ts`：验证 scope/cwd，向 Manager 获取终端 lease。
- `packages/server/src/http/routes/terminal.ts`：解析新 scope，并严格处理旧请求。
- `packages/server/src/http/routes/terminal.test.ts`：覆盖协议兼容和拒绝条件。

### Agent、后台任务与 Desktop

- `packages/server/src/application/daemon-application.ts`：创建并持有唯一 Manager，注入 Agent、终端和后台任务。
- `packages/server/src/daemon/daemon-agent.ts`：在创建 Agent 前取得环境 lease。
- `packages/agent-runtime/src/agent-composition.ts`：优先使用宿主传入的 lease，不自行创建第二个容器。
- `packages/agent-runtime/src/default-runtime.ts`：Docker 中重新开放 `TerminalOpen`。
- `packages/server/src/application/session/background-shell-service.ts`：后台任务独立持有环境 lease，结束后释放。
- `apps/desktop/src/renderer/src/components/desktop/tools/terminal/terminal-runtime-model.ts`：纯函数决定默认环境终端、显式本机终端和 scope。
- `apps/desktop/src/renderer/src/components/desktop/tools/terminal/terminal-runtime-model.test.ts`：覆盖项目与项目外会话。
- `apps/desktop/src/renderer/src/components/desktop/tools/terminal/terminal-tool.tsx`：默认跟随 Agent 环境并提供“在本机打开”。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx`：更新终端设置说明。
- `docs/sandbox-runtime-flow.md`：更新第二期真实调用链和生命周期。
- `docs/superpowers/specs/2026-09-07-agent-runtime-environment-and-terminal-design.md`：勾选第二期实际交付项。

---

## 任务 1：升级 Terminal 判别作用域协议

**文件：**

- 修改：`packages/protocol/src/terminal.ts`
- 修改：`packages/protocol/src/serialization.ts`
- 修改：`packages/protocol/src/serialization.test.ts`
- 修改：`packages/client/src/transport/http-client.ts`
- 修改：`packages/server/src/http/routes/terminal.ts`
- 修改：`packages/server/src/http/routes/terminal.test.ts`

- [ ] **步骤 1：编写 project/session scope 解码测试**

```ts
expect(decodeTerminalSessionInfo({
  id: "t1",
  name: "Terminal",
  scope: { kind: "session", sessionId: "s1" },
  runtime: "sandbox",
  source: "user",
  status: "running",
  cwd: "/workspace",
  shell: "/bin/sh",
  cols: 100,
  rows: 30,
  createdAt: "2026-09-07T00:00:00.000Z",
})).toMatchObject({ scope: { kind: "session", sessionId: "s1" } });
```

同时增加以下失败断言：新请求同时提交 project scope 与 session scope；scope 缺少 ID；响应没有 scope；`projectId` 与 project scope 不一致。

- [ ] **步骤 2：运行协议测试并确认失败**

运行：`pnpm --filter @vykor/protocol test -- serialization.test.ts`

预期：FAIL，当前 `TerminalCreateRequest` 强制 `projectId`，响应也没有 scope。

- [ ] **步骤 3：实现新协议类型**

```ts
export type TerminalScope =
  | { kind: "project"; projectId: string }
  | { kind: "session"; sessionId: string };

export interface TerminalCreateRequest {
  scope: TerminalScope;
  runtime: "local" | "sandbox";
  cols: number;
  rows: number;
  name?: string;
  shell?: string;
  cwd?: string;
  source?: "user" | "agent";
}

export interface TerminalSessionInfo {
  scope: TerminalScope;
  projectId?: string;
  sessionId?: string;
  // 保留现有状态、cwd、shell、尺寸和时间字段
}
```

`decodeTerminalSessionInfo()` 必须检查 scope 与可选扁平 ID 一致，不能只做类型断言。

- [ ] **步骤 4：在 HTTP 边界兼容旧请求**

新增 `readTerminalScope(body)`：

```ts
if (isTerminalScope(body.scope)) return body.scope;
if (projectId && !sessionId) return { kind: "project", projectId };
if (sessionId && !projectId) return { kind: "session", sessionId };
if (projectId && sessionId) return { kind: "session", sessionId };
throw new DaemonTerminalError(400, "terminal scope is required");
```

同时出现旧 `projectId/sessionId` 时只做兼容解析；关联关系和 cwd 验证由任务 5 的服务层完成。新 Client 和 Desktop 只发送 `scope`。

- [ ] **步骤 5：运行协议、Client 和路由测试**

运行：

```bash
pnpm --filter @vykor/protocol test
pnpm --filter @vykor/client test
pnpm --filter @vykor/server test -- terminal.test.ts
pnpm --filter @vykor/protocol check-types
```

预期：全部通过。

- [ ] **步骤 6：Commit**

```bash
git add packages/protocol packages/client packages/server/src/http/routes/terminal.ts packages/server/src/http/routes/terminal.test.ts
git commit -m "feat(terminal): add project and session scopes"
```

## 任务 2：定义环境 PTY 契约并生成 Docker 交互目标

**文件：**

- 修改：`packages/environment/src/types.ts`
- 修改：`packages/environment/src/types.test.ts`
- 修改：`packages/sandbox/src/types.ts`
- 修改：`packages/sandbox/src/docker-backend.ts`
- 修改：`packages/sandbox/src/index.test.ts`
- 修改：`packages/sandbox/src/execution-environment.ts`
- 修改：`packages/sandbox/src/execution-environment.test.ts`

- [ ] **步骤 1：编写 Docker PTY 启动参数测试**

```ts
expect(buildDockerPtyTarget({
  dockerCommand: "docker",
  containerName: "vk-project",
  hostCwd: "D:\\code\\vk",
  executionCwd: "/workspace",
  shell: "/bin/sh",
  executionId: "terminal-1",
})).toMatchObject({
  command: "docker",
  hostCwd: "D:\\code\\vk",
  args: expect.arrayContaining(["exec", "-it", "-w", "/workspace", "vk-project"]),
});
```

再断言目标 argv 最终启动受监督的交互 shell，且 `stop("interrupt")` 只停止 `terminal-1` 对应进程组。

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm --filter @vykor/sandbox test -- index.test.ts execution-environment.test.ts`

预期：FAIL，当前环境句柄没有交互终端工厂。

- [ ] **步骤 3：增加通用 PTY target 契约**

```ts
export interface EnvironmentPtyTarget {
  command: string;
  args: string[];
  hostCwd: string;
  executionCwd: string;
  shell: string;
  env?: Record<string, string>;
  signal(signal: "interrupt" | "terminate"): Promise<void>;
  close(): Promise<void>;
}

export interface EnvironmentTerminalFactory {
  prepare(input: {
    cwd?: string;
    shell?: string;
    cols: number;
    rows: number;
  }): Promise<EnvironmentPtyTarget>;
}
```

在 `ExecutionEnvironmentHandle` 增加 `terminal: EnvironmentTerminalFactory`。本机 target 使用宿主 shell；Docker target 使用环境 shell和容器 cwd。

- [ ] **步骤 4：实现受监督的 Docker PTY target**

`DockerSandboxSession.preparePtyTarget()` 生成唯一 executionId，复用现有 marker/cancel 文件和进程组 stopper。Docker argv 必须满足：

```text
docker exec -it -w /workspace <container> <supervisor> /bin/sh -i
```

禁止使用 `ChildProcess` 普通 pipe 模拟 TTY。`hostCwd` 固定为 WorkspaceBinding.hostRoot，`executionCwd` 只进入 Docker `-w`。

- [ ] **步骤 5：验证 shell 和路径**

Docker shell 只接受 `settings.terminal.dockerShell` 的 `/bin/sh` 或 `/bin/bash`，启动前在容器中执行 `test -x <shell>`。失败返回 `docker_terminal_shell_unavailable`，不尝试宿主 shell。

- [ ] **步骤 6：运行 Sandbox 测试和类型检查**

运行：

```bash
pnpm --filter @vykor/environment test
pnpm --filter @vykor/sandbox test -- index.test.ts execution-environment.test.ts
pnpm --filter @vykor/sandbox check-types
```

预期：全部通过。

- [ ] **步骤 7：Commit**

```bash
git add packages/environment packages/sandbox
git commit -m "feat(sandbox): expose supervised Docker PTY targets"
```

## 任务 3：实现唯一的内存 ExecutionEnvironmentManager

**文件：**

- 创建：`packages/sandbox/src/execution-environment-manager.ts`
- 创建：`packages/sandbox/src/execution-environment-manager.test.ts`
- 修改：`packages/sandbox/src/index.ts`
- 修改：`packages/environment/src/types.ts`

- [ ] **步骤 1：编写并发 acquire 和 lease 测试**

```ts
const [agent, terminal] = await Promise.all([
  manager.acquire(request("project:D:/repo", "agent:s1")),
  manager.acquire(request("project:D:/repo", "terminal:t1")),
]);

expect(createEnvironment).toHaveBeenCalledTimes(1);
expect(agent.environmentId).toBe(terminal.environmentId);
expect(manager.inspect("project:D:/repo")?.leaseCount).toBe(2);
```

覆盖：并发只创建一次；release 幂等；释放一个 lease 不停止环境；最后一个临时 lease 释放后停止；可复用容器只清理本 Runtime 进程并保留容器；活动 lease 下不同 configHash 返回 `environment_config_in_use`。

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm --filter @vykor/sandbox test -- execution-environment-manager.test.ts`

预期：FAIL，Manager 尚不存在。

- [ ] **步骤 3：实现记录与 lease**

```ts
interface EnvironmentRecord {
  environmentId: string;
  ownerId: string;
  configHash: string;
  state: "preparing" | "ready" | "failed" | "stopped";
  handle?: ExecutionEnvironmentHandle;
  preparing?: Promise<ExecutionEnvironmentHandle>;
  leases: Map<string, { consumerId: string; kind: "agent" | "terminal" | "background" }>;
}
```

`acquire()` 返回 `ExecutionEnvironmentLease`，其 `release()` 只删除自己的 lease。Manager 内部用 ownerId 作为唯一 key，并缓存 preparing Promise 防止并发重复启动。

- [ ] **步骤 4：实现配置冲突规则**

第二期不热切换：

- 同 owner、同 hash：共享；
- 同 owner、不同 hash、仍有 lease：拒绝；
- 同 owner、不同 hash、零 lease：释放旧记录后创建最新环境；
- configHash 不参与容器名。

- [ ] **步骤 5：运行 Manager 测试**

运行：

```bash
pnpm --filter @vykor/sandbox test -- execution-environment-manager.test.ts
pnpm --filter @vykor/sandbox check-types
```

预期：全部通过。

- [ ] **步骤 6：Commit**

```bash
git add packages/environment packages/sandbox
git commit -m "feat(environment): manage shared in-memory leases"
```

## 任务 4：确定 workspace owner 与继承规则

**文件：**

- 创建：`packages/server/src/runtime/environment-owner.ts`
- 创建：`packages/server/src/runtime/environment-owner.test.ts`
- 修改：`packages/server/src/runtime/index.ts`

- [ ] **步骤 1：编写 owner 矩阵测试**

```ts
expect(resolveEnvironmentOwner(projectSession, store, { reuseContainer: true }))
  .toEqual({ ownerId: "project:D:/repo", hostRoot: "D:/repo" });

expect(resolveEnvironmentOwner(projectlessFork, store, { reuseContainer: false }))
  .toEqual({ ownerId: "session:outside-root", hostRoot: outsideCwd });
```

同时覆盖：独立项目外根会话不共享；fork 继承根 owner；同 cwd 非隔离子 Agent 继承；不同 cwd 的隔离 worktree 子 Agent 使用自己的 workspace owner。

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm --filter @vykor/server test -- environment-owner.test.ts`

预期：FAIL，当前没有统一 owner 解析器。

- [ ] **步骤 3：实现纯 owner 解析器**

输入只使用可信的 `SessionStore` 记录：

```ts
export interface ResolvedEnvironmentOwner {
  ownerId: string;
  hostRoot: string;
  rootSessionId: string;
}
```

规则顺序固定为：隔离 cwd → 项目复用 owner → 根 Session owner。路径比较在 Windows 下忽略大小写并统一分隔符。

- [ ] **步骤 4：运行测试和类型检查**

运行：

```bash
pnpm --filter @vykor/server test -- environment-owner.test.ts
pnpm --filter @vykor/server check-types
```

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add packages/server/src/runtime
git commit -m "feat(server): resolve shared environment owners"
```

## 任务 5：让 daemon 持有 Manager，并把 Agent 接到 lease

**文件：**

- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`packages/server/src/application/default-node-application.ts`
- 修改：`packages/server/src/daemon/daemon-agent.ts`
- 修改：`packages/server/src/daemon/__test__/daemon-agent.test.ts`
- 修改：`packages/agent-runtime/src/agent-composition.ts`
- 修改：`packages/agent-runtime/src/agent.test.ts`

- [ ] **步骤 1：编写 daemon 单例环境测试**

创建同 owner 的根 Agent 和非隔离子 Agent，断言：

```ts
expect(manager.acquire).toHaveBeenCalledWith(expect.objectContaining({
  ownerId: expectedOwner,
  consumer: { kind: "agent", id: session.id },
}));
expect(childOptions.executionEnvironment?.environmentId)
  .toBe(rootOptions.executionEnvironment?.environmentId);
```

还要断言 Agent 创建失败会释放 lease，且 Agent Runtime 不再自行启动第二个 Docker 环境。

- [ ] **步骤 2：运行测试并确认失败**

运行：

```bash
pnpm --filter @vykor/server test -- daemon-agent.test.ts
pnpm --filter @vykor/agent-runtime test -- agent.test.ts
```

预期：FAIL，daemon 尚未向 Agent 注入共享 lease。

- [ ] **步骤 3：在 daemon 创建唯一 Manager**

`DaemonApplication` 构造时创建一个 Manager，并在 `close()` 中调用 `dispose()`。`createDaemonAgentLoader` 新增 `acquireEnvironment(session, settings)` 依赖，在 `createDefaultNodeAgent()` 前完成 acquire。

- [ ] **步骤 4：把 lease 作为现有 ExecutionEnvironmentHandle 注入**

`VykorAgentOptions.executionEnvironment` 接收 lease。Agent composition 保留 standalone fallback，但只在宿主没有传入环境时创建自己的句柄。Agent close 调用 lease.release()，不能直接停止共享容器。

- [ ] **步骤 5：运行 Agent/Server 测试**

运行：

```bash
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/server test -- daemon-agent.test.ts durable-agent-application.test.ts
pnpm --filter @vykor/server check-types
```

预期：全部通过。

- [ ] **步骤 6：Commit**

```bash
git add packages/agent-runtime packages/server
git commit -m "refactor(server): lease agent execution environments"
```

## 任务 6：用 node-pty 统一驱动本机和 Docker 终端

**文件：**

- 创建：`packages/terminal-node/src/environment-terminal-target.ts`
- 创建：`packages/terminal-node/src/environment-terminal-target.test.ts`
- 修改：`packages/terminal-node/src/local-terminal-provider.ts`
- 修改：`packages/terminal-node/src/local-terminal-provider.test.ts`
- 修改：`packages/terminal/src/provider.ts`

- [ ] **步骤 1：编写统一 PTY Provider 测试**

用 fake IPty 断言：

```ts
expect(spawnPty).toHaveBeenCalledWith(
  target.command,
  target.args,
  expect.objectContaining({ cwd: target.hostCwd, cols: 100, rows: 30 }),
);
await provider.resize({ terminalId, cols: 120, rows: 40 });
expect(fakePty.resize).toHaveBeenCalledWith(120, 40);
```

分别覆盖输入、data/exit 事件、Ctrl-C 写入 `\x03`、EOF 写入 `\x04`、terminate 调 target.signal/close、重复 kill 幂等。

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm --filter @vykor/terminal-node test -- local-terminal-provider.test.ts environment-terminal-target.test.ts`

预期：FAIL，sandbox 分支仍使用普通 ChildProcess pipe。

- [ ] **步骤 3：把 Provider 改为单一 PTY Session**

删除 `SandboxTerminalSession.kind = "process"`。Provider 通过 `resolveTarget(input)` 获取 `EnvironmentPtyTarget`，所有 runtime 都执行一次 `node-pty.spawn()`。Session 保存：

```ts
interface PtyTerminalSession {
  info: TerminalSessionInfo;
  pty: IPty | null;
  target: EnvironmentPtyTarget;
  output: OutputBuffer;
  transcript: TerminalOutputStore;
  cancelRequested: boolean;
}
```

- [ ] **步骤 4：实现可靠关闭顺序**

terminate 顺序固定为：标记 stopping → `target.signal("terminate")` → `pty.kill()` → 等待 exit → `target.close()`。普通 shell 自行退出也必须调用一次 `target.close()`。

- [ ] **步骤 5：运行 Terminal 测试和类型检查**

运行：

```bash
pnpm --filter @vykor/terminal-node test
pnpm --filter @vykor/terminal-node check-types
```

预期：全部通过。

- [ ] **步骤 6：Commit**

```bash
git add packages/terminal packages/terminal-node
git commit -m "feat(terminal): drive environment shells with node pty"
```

## 任务 7：让 Daemon Terminal 使用可信 scope 和共享环境

**文件：**

- 修改：`packages/server/src/terminal/daemon-terminal-service.ts`
- 创建：`packages/server/src/terminal/daemon-terminal-service.test.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`packages/server/src/http/routes/terminal.test.ts`

- [ ] **步骤 1：编写 scope 与 cwd 安全测试**

覆盖：

```ts
await terminals.create({
  scope: { kind: "session", sessionId: outsideSession.id },
  runtime: "sandbox",
  cols: 100,
  rows: 30,
});

expect(manager.acquire).toHaveBeenCalledWith(expect.objectContaining({
  ownerId: `session:${outsideSession.id}`,
  consumer: expect.objectContaining({ kind: "terminal" }),
}));
```

拒绝：未知 project/session；旧请求的 projectId 与 session 实际项目不一致；传入 cwd 与 Store 中可信 cwd 不一致；sandbox terminal 没有 ready 环境。

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm --filter @vykor/server test -- daemon-terminal-service.test.ts terminal.test.ts`

预期：FAIL，当前服务强制 projectId 且会自己创建 sandbox runtime。

- [ ] **步骤 3：实现 scope 解析和 target 选择**

- project scope：从 ProjectStore 取 cwd；
- session scope：从 SessionStore 取 cwd 和 owner；
- `runtime: local`：显式宿主 target，不取得 Docker lease；
- `runtime: sandbox`：取得当前 Agent 环境 lease，并使用 `lease.terminal.prepare()`；
- `TerminalSessionInfo` 保存 scope、解析后的 projectId/sessionId 和执行环境 cwd。

- [ ] **步骤 4：验证兼容旧双 ID 请求**

旧请求同时含 projectId/sessionId 时，服务必须确认 Session.projectId 等于 projectId，并确认两者解析出的 cwd 相同；任一不一致返回 400。

- [ ] **步骤 5：运行 Server 测试**

运行：

```bash
pnpm --filter @vykor/server test -- daemon-terminal-service.test.ts terminal.test.ts
pnpm --filter @vykor/server check-types
```

预期：全部通过。

- [ ] **步骤 6：Commit**

```bash
git add packages/server/src/terminal packages/server/src/http/routes/terminal.ts packages/server/src/http/routes/terminal.test.ts packages/server/src/application/daemon-application.ts
git commit -m "feat(server): share environments with scoped terminals"
```

## 任务 8：重新启用跟随环境的 Agent Terminal

**文件：**

- 修改：`packages/server/src/terminal/daemon-terminal-service.ts`
- 修改：`packages/server/src/daemon/daemon-agent.ts`
- 修改：`packages/server/src/daemon/__test__/daemon-agent.test.ts`
- 修改：`packages/agent-runtime/src/agent-composition.ts`
- 修改：`packages/agent-runtime/src/default-runtime.test.ts`
- 修改：`packages/tools/src/registry.ts`
- 修改：`packages/tools/src/terminal/__test__/terminal-tools.test.ts`

- [ ] **步骤 1：编写 Docker Agent Terminal 可见性测试**

```ts
expect(runtime.toolRegistry.has("TerminalOpen")).toBe(true);
expect(runtime.toolRegistry.get("TerminalOpen")?.execution).toEqual({
  domain: "environment",
  supportedEnvironments: ["local", "docker"],
});
```

项目外 Session 调 `TerminalOpen` 后，断言请求 scope 为 session、runtime 为 sandbox，且返回的终端属于该 Session。

- [ ] **步骤 2：运行测试并确认失败**

运行：

```bash
pnpm --filter @vykor/agent-runtime test -- default-runtime.test.ts
pnpm --filter @vykor/server test -- daemon-agent.test.ts
```

预期：FAIL，第一期明确隐藏了 Docker TerminalOpen。

- [ ] **步骤 3：移除第一期禁用分支**

Agent composition 不再对 Docker 写入 `terminal: false`。Daemon 注入的 `AgentTerminalHost.open()` 一律通过 `DaemonTerminalService` 创建 scoped terminal；不能 new 独立 LocalTerminalProvider。

- [ ] **步骤 4：统一 shell 来源**

- 本机 Agent 环境：使用 `settings.terminal.localShell` 或项目默认 Shell；
- Docker Agent 环境：使用 `settings.terminal.dockerShell`；
- Docker 模式忽略 Windows `ProjectRecord.defaultShell`；
- 模型传入 shell 只能在当前环境允许列表内选择。

- [ ] **步骤 5：运行 Agent、Tools 和 Server 测试**

运行：

```bash
pnpm --filter @vykor/tools test -- terminal-tools.test.ts
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/server test -- daemon-agent.test.ts daemon-terminal-service.test.ts
```

预期：全部通过。

- [ ] **步骤 6：Commit**

```bash
git add packages/tools packages/agent-runtime packages/server
git commit -m "feat(runtime): make Agent Terminal follow its environment"
```

## 任务 9：让后台任务独立持有环境 lease

**文件：**

- 修改：`packages/server/src/application/session/background-shell-service.ts`
- 修改：`packages/server/src/application/session/__test__/background-shell-service.test.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`packages/services/src/executions/detached-process-supervisor.ts`
- 修改：`packages/services/src/executions/__test__/detached-process-supervisor.test.ts`

- [ ] **步骤 1：编写 Agent 关闭后任务继续运行测试**

```ts
const execution = await backgroundShells.create(input);
await agent.close();

expect(manager.inspect(ownerId)?.leaseKinds).toContain("background");
expect(await backgroundShells.read(execution.id)).toContain("still-running");
```

再断言任务 completed/failed/killed 后释放 background lease；取消一个任务不释放其他任务或终端 lease。

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm --filter @vykor/server test -- background-shell-service.test.ts`

预期：FAIL，后台任务当前借用 Agent Runtime 的活动环境，没有自己的 lease。

- [ ] **步骤 3：接入任务 lease**

`BackgroundShellService.create()` 在 supervisor 启动前 acquire `{ kind: "background", id: executionId }`。启动失败立即 release；成功后保存 `executionId → lease`。Supervisor terminal event 进入 completed/failed/killed 时调用一次 release。

- [ ] **步骤 4：处理 daemon dispose**

dispose 顺序固定为：停止本 daemon 创建的后台任务 → 等待 terminal 状态 → 释放对应 lease → dispose Manager。不能先停共享容器。

- [ ] **步骤 5：运行 Services/Server 测试**

运行：

```bash
pnpm --filter @vykor/services test -- detached-process-supervisor.test.ts
pnpm --filter @vykor/server test -- background-shell-service.test.ts durable-agent-application.test.ts
pnpm --filter @vykor/server check-types
```

预期：全部通过。

- [ ] **步骤 6：Commit**

```bash
git add packages/services packages/server
git commit -m "fix(runtime): retain environments for background jobs"
```

## 任务 10：让 Desktop 默认终端跟随 Agent 环境

**文件：**

- 创建：`apps/desktop/src/renderer/src/components/desktop/tools/terminal/terminal-runtime-model.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/tools/terminal/terminal-runtime-model.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/tools/terminal/terminal-tool.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/utility-panel.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx`
- 修改：`apps/desktop/src/main/features/terminal/terminal-service.ts`
- 修改：`apps/desktop/src/shared/terminal-types.ts`

- [ ] **步骤 1：编写默认 runtime/scope 纯函数测试**

```ts
expect(resolveTerminalCreateTarget({
  agentEnvironment: "docker",
  session: { id: "s1", projectId: undefined },
  explicitHost: false,
})).toEqual({
  runtime: "sandbox",
  scope: { kind: "session", sessionId: "s1" },
});
```

覆盖：本机 Agent 默认 local；Docker Agent 默认 sandbox；“在本机打开”始终 local；项目会话优先使用 session scope，以保证终端绑定当前 Agent 环境；没有活动 Session 时不允许创建默认环境终端。

- [ ] **步骤 2：运行测试并确认失败**

运行：`pnpm --filter @vykor/desktop test -- terminal-runtime-model.test.ts`

预期：FAIL，当前 UI 固定 `runtime: local` 且依赖 projectId。

- [ ] **步骤 3：接入当前 Settings 与 Session**

Terminal Tool 加载 `settings.snapshot()`，保存 `agentEnvironment`。默认“新建终端”调用纯函数生成 request；项目外会话直接发送 session scope，不再要求 selectedProject。

- [ ] **步骤 4：实现显式本机入口**

“新建终端”按钮或下拉菜单提供：

```text
在当前 Agent 环境中打开（默认）
在本机打开
```

第二项发送 `runtime: local`，但仍使用可信 session scope 解析 cwd。标签分别显示“Docker 终端”或“本机终端”，不能只显示模糊的“终端”。

- [ ] **步骤 5：更新设置文案**

“集成终端 Shell”说明改为：本机环境使用本机 Shell；Docker 环境使用容器 Shell。显式“在本机打开”始终使用本机 Shell。

- [ ] **步骤 6：运行 Desktop 测试、类型检查和 lint**

运行：

```bash
pnpm --filter @vykor/desktop test
pnpm --filter @vykor/desktop typecheck
pnpm --filter @vykor/desktop lint
```

预期：全部通过。

- [ ] **步骤 7：Commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): make terminals follow the Agent environment"
```

## 任务 11：真实 Docker PTY、共享与关闭语义 E2E

**文件：**

- 创建：`packages/terminal-node/e2e/docker-pty.e2e.test.ts`
- 修改：`packages/terminal-node/package.json`
- 修改：`packages/sandbox/e2e/docker.e2e.test.ts`
- 修改：`packages/server/src/application/__test__/durable-agent-application.test.ts`

- [ ] **步骤 1：编写真实 Docker PTY E2E**

测试用同一个 owner 依次取得 Agent、用户终端和 Agent Terminal 三个 lease，并覆盖：

```text
交互 shell 的 tty -s 成功
pwd 返回 /workspace
输入 echo sentinel 并实时收到输出
resize 后 stty size 返回新尺寸
Ctrl-C 中断 sleep，但 shell 继续可用
EOF 结束 shell
terminate 停止单个 exec 进程组
```

- [ ] **步骤 2：编写共享容器与关闭测试**

断言三个 lease 的 environmentId/containerName 相同。关闭 Agent Terminal 后，用户终端仍能执行命令；关闭 Agent 后，后台任务仍运行；最后一个临时 lease 释放后容器消失。可复用模式最后一个 lease 释放后容器保留，但没有该 Runtime 遗留的 exec。

- [ ] **步骤 3：运行真实 Docker E2E**

运行：

```bash
pnpm --filter @vykor/terminal-node e2e:docker
pnpm --filter @vykor/sandbox e2e:docker
```

预期：Docker daemon 可用时全部通过；只允许外网用例按既有环境开关 skip，PTY/shared-container 用例不能 skip。

- [ ] **步骤 4：运行服务集成测试**

运行：

```bash
pnpm --filter @vykor/server test -- durable-agent-application.test.ts daemon-terminal-service.test.ts
pnpm --filter @vykor/agent-runtime test
```

预期：全部通过。

- [ ] **步骤 5：Commit**

```bash
git add packages/terminal-node packages/sandbox packages/server packages/agent-runtime
git commit -m "test(terminal): verify shared Docker PTY environments"
```

## 任务 12：文档收尾与全仓验证

**文件：**

- 修改：`docs/sandbox-runtime-flow.md`
- 修改：`docs/superpowers/specs/2026-09-07-agent-runtime-environment-and-terminal-design.md`

- [ ] **步骤 1：更新权威运行流程**

文档必须明确展示：

```text
Session / Project
  → workspace owner
  → ExecutionEnvironmentManager.acquire()
       ├─ Agent lease
       ├─ Agent Terminal lease
       ├─ user environment-terminal lease
       └─ background job lease
  → one EnvironmentHandle / one current container
```

删除第一期“用户终端固定本机”和“Docker TerminalOpen 禁用”的说明，保留显式本机终端不属于 Docker fail-closed 范围。

- [ ] **步骤 2：对照规格第 18.2 节逐项勾选**

只勾选有自动化测试证据的第二期项目。第 18.3 节保持未开始；不得把内存 lease 描述成崩溃后可恢复。

- [ ] **步骤 3：运行全仓稳定验证**

Windows 上使用限制并发的命令，避免已知 PTY/worktree 测试资源竞争：

```bash
pnpm exec turbo test --concurrency=4 --env-mode=loose
pnpm exec turbo check-types --concurrency=4 --env-mode=loose
node --test scripts/prepare-tag-release.test.mjs scripts/npm-release.test.mjs
pnpm --dir apps/desktop lint
git diff --check
```

预期：全部退出 0。真实 Docker E2E 结果单独记录测试数量和任何显式 skip。

- [ ] **步骤 4：确认第二期安全不变量**

逐项检查：

- 同一 owner 只有一个 ready 环境；
- Docker Terminal 的命令、cwd 和 Shell 来自环境 target；
- Renderer 提供的 cwd 不能扩大访问范围；
- 关闭单个消费者不停止其他 lease；
- 没有环境 lease 时 sandbox Terminal fail-closed；
- 显式本机终端不会被误当作 Docker lease；
- 运行中配置变化仍要求重启，不出现第二个配置版本。

- [ ] **步骤 5：Commit**

```bash
git add docs
git commit -m "docs(runtime): complete the unified terminal phase"
```

## 第二阶段完成条件

- Docker 终端使用真实 PTY，不再走普通 stdin/stdout pipe。
- Agent Terminal 和用户默认终端使用当前 Agent 环境。
- 项目外会话不需要 projectId 也能创建用户终端和 Agent Terminal。
- 同一 owner 的 Agent、终端和后台任务共享同一个 environmentId/containerName。
- Ctrl-C、EOF、resize 和 terminate 都有单元测试与真实 Docker E2E。
- 关闭一个终端或 Agent 不影响其他 lease；最后一个 lease 才触发环境释放。
- 配置冲突 fail-closed，不并存多个环境版本。
- 第二期不声称支持热切换、持久 lease 或 daemon 崩溃恢复。
