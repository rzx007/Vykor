# Agent Runtime 默认能力阶段三实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 使用现有 `LocalTerminalProvider` 补全 standalone Terminal，并把 Terminal 会话完整投影到统一 Jobs 控制面，同时建立 runtime-owned 资源的可靠清理机制。

**架构：** `@vykor/terminal-node` 提供一个由同一 `LocalTerminalProvider` 支撑的 `{ terminal, jobs, cleanup }` bundle；agent-runtime 将 bundle 的 Terminal 接到工具，将 Job source 接到阶段一的 `CompositeAgentJobHost`。默认工厂通过清理栈登记资源，Host overrides 始终作为借用对象，不由 Agent 释放。

**技术栈：** TypeScript、Vitest、`node-pty`、现有 `@vykor/terminal-node`、`@vykor/jobs`、`@vykor/agent-runtime`、pnpm workspace。

---

## 前置条件

开始前确认阶段一和阶段二都已完成：

```bash
rg -n "hostCapabilities|AgentHostCapabilities|CompactAttachments|setAttachmentsProvider" packages apps -g "*.ts"
```

预期：无匹配。并运行：

```bash
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/server test
```

预期：全部 PASS。

## 文件结构

### 新建

- `packages/terminal-node/src/agent-terminal-host.ts`：把 `LocalTerminalProvider` 适配成 Agent Terminal producer 与 Job source。
- `packages/terminal-node/src/agent-terminal-host.test.ts`：open、list、read、wait、send、cancel 和 session 边界测试。
- `packages/agent-runtime/src/cleanup-stack.ts`：runtime-owned cleanup 的逆序、去重、幂等执行。
- `packages/agent-runtime/src/cleanup-stack.test.ts`：顺序、共享 identity、失败汇总和幂等测试。
- `packages/agent-runtime/src/default-node-terminal.ts`：创建默认 Node Terminal bundle 并返回 cleanup。
- `packages/agent-runtime/src/default-node-terminal.test.ts`：默认 factory 与 Host override 的所有权测试。

### 修改

- `packages/terminal-node/package.json`：增加 `@vykor/jobs` workspace 依赖。
- `packages/terminal-node/src/index.ts`：导出 Agent Terminal bundle factory。
- `packages/agent-runtime/package.json`：在 `dependencies` 增加 `"@vykor/terminal-node": "workspace:*"`，保证默认 Node Agent 安装后实际带有 Terminal 实现。
- `packages/agent-runtime/src/agent-composition.ts`：未覆盖 Terminal 时创建默认 bundle，登记 cleanup 并接入 Jobs。
- `packages/agent-runtime/src/agent.ts`：Agent close 调用装配 cleanup，保持现有关闭顺序和幂等语义。
- `packages/agent-runtime/src/default-agent.ts`：Node-only 默认工厂入口。
- `packages/agent-runtime/src/sdk.test.ts`：无 Host 的完整默认能力集成测试。
- `packages/agent-runtime/src/agent.test.ts`：关闭与初始化失败回滚测试。
- `packages/tools/src/terminal/__test__/terminal-tools.test.ts`：Terminal 工具与 Job ID 契约回归。
- `packages/server/src/daemon/__test__/daemon-agent.test.ts`：daemon Host Terminal 不创建本地 provider。

## 任务 1：把 LocalTerminalProvider 投影成 Agent Jobs

**文件：**

- 创建：`packages/terminal-node/src/agent-terminal-host.ts`
- 创建：`packages/terminal-node/src/agent-terminal-host.test.ts`
- 修改：`packages/terminal-node/src/index.ts`
- 修改：`packages/terminal-node/package.json`
- 修改：`pnpm-lock.yaml`

- [ ] **步骤 1：先写 open 与 list 的失败测试**

使用可注入的 fake provider，避免单元测试依赖真实 PTY：

```ts
const bundle = createAgentTerminalBundle({
  cwd,
  sessionId: "session-1",
  provider: fakeLocalTerminalProvider(),
});
const opened = await bundle.terminal.open({
  cwd,
  sessionId: "session-1",
  name: "node-repl",
  shell: process.execPath,
  cols: 80,
  rows: 24,
});
expect(await bundle.jobs.list({ sessionId: "session-1" }))
  .toEqual([expect.objectContaining({ id: opened.id, kind: "terminal" })]);
```

`AgentTerminalHost.open` 返回 `TerminalSessionInfo`，因此 Job snapshot ID 必须等于 `opened.id`。

- [ ] **步骤 2：先写 read/wait/send/cancel 映射测试**

断言：

- `read.after/maxChars` 映射到 provider read。
- `wait.timeoutMs/after/signal` 映射到 provider wait。
- `send.data` 映射到 provider write。
- `cancel.reason` 调用 provider kill/close，并返回 killed snapshot。
- provider exit code 0/非 0 分别映射 completed/failed。
- 其他 session ID 访问时抛出 `Job owner session mismatch.`。

- [ ] **步骤 3：运行新测试确认失败**

```bash
pnpm --filter @vykor/terminal-node exec vitest run src/agent-terminal-host.test.ts
```

预期：FAIL，缺少 `createAgentTerminalBundle`。

- [ ] **步骤 4：定义 bundle 与最小 provider 结构类型**

```ts
export interface AgentTerminalBundle {
  terminal: AgentTerminalHost;
  jobs: AgentJobHost;
  cleanup(): Promise<void>;
  cleanupIdentity: object;
}
```

factory 默认创建 `LocalTerminalProvider`，测试可以传入实现其实际方法集合的 provider。不要扩大 `AgentTerminalHost` 接口；完整控制仍通过 Jobs。

- [ ] **步骤 5：实现 Terminal Job snapshot 和路由**

Job snapshot 固定：

```ts
{
  id: terminal.id,
  kind: "terminal",
  ownerSession: sessionId,
  capabilities: { read: true, wait: true, send: running, cancel: running },
  cwd: terminal.cwd,
  status: mappedStatus,
  startedAt: terminal.createdAt,
  updatedAt: terminal.updatedAt,
}
```

时间字段使用 provider 已有数据；若 provider 没有 updatedAt，由 adapter 在输出、resize、write、退出时维护，不使用每次读取时的当前时间伪造变化。

- [ ] **步骤 6：让 cleanup 调用 provider.dispose()**

cleanup 必须可重复调用，第二次不重复释放；首次失败后再次调用返回同一个失败结果或已结算 promise，不重新操作 provider。

- [ ] **步骤 7：运行 terminal-node 全包测试和类型检查**

```bash
pnpm --filter @vykor/terminal-node test
pnpm --filter @vykor/terminal-node check-types
```

预期：全部 PASS。

- [ ] **步骤 8：提交 Terminal Job adapter**

```bash
git add packages/terminal-node pnpm-lock.yaml
git commit -m "feat(terminal-node): expose terminal sessions as jobs"
```

## 任务 2：实现 runtime cleanup stack

**文件：**

- 创建：`packages/agent-runtime/src/cleanup-stack.ts`
- 创建：`packages/agent-runtime/src/cleanup-stack.test.ts`

- [ ] **步骤 1：先写逆序、identity 去重和幂等测试**

```ts
it("runs unique cleanups once in reverse order", async () => {
  const calls: string[] = [];
  const stack = new CleanupStack();
  const shared = {};
  stack.add(() => { calls.push("first"); });
  stack.add(() => { calls.push("shared"); }, shared);
  stack.add(() => { calls.push("duplicate"); }, shared);
  await stack.close();
  await stack.close();
  expect(calls).toEqual(["shared", "first"]);
});
```

- [ ] **步骤 2：先写多个 cleanup 失败汇总测试**

断言一个失败原样抛出，多个失败抛出 `AggregateError`，但每个 cleanup 都已经运行。再测试初始化主错误和 cleanup 错误组合时，主错误排在 AggregateError 的第一个元素。

- [ ] **步骤 3：运行测试确认失败**

```bash
pnpm --filter @vykor/agent-runtime exec vitest run src/cleanup-stack.test.ts
```

预期：FAIL，缺少 `CleanupStack`。

- [ ] **步骤 4：实现小型 cleanup stack**

```ts
export class CleanupStack {
  private entries: Array<{ cleanup: () => void | Promise<void>; identity: object }> = [];
  private identities = new Set<object>();
  private closePromise?: Promise<void>;

  add(cleanup: () => void | Promise<void>, identity: object = cleanup): void;
  close(): Promise<void>;
}
```

`add()` 在开始 close 后必须抛出明确错误，避免资源永远不被释放。`close()` 创建并缓存一个 promise。

- [ ] **步骤 5：运行测试和类型检查**

```bash
pnpm --filter @vykor/agent-runtime exec vitest run src/cleanup-stack.test.ts
pnpm --filter @vykor/agent-runtime check-types
```

预期：全部 PASS。

- [ ] **步骤 6：提交 cleanup stack**

```bash
git add packages/agent-runtime/src/cleanup-stack.ts packages/agent-runtime/src/cleanup-stack.test.ts
git commit -m "feat(agent-runtime): manage owned capability cleanup"
```

## 任务 3：给 DefaultNodeAgent 安装本地 Terminal 默认能力

**文件：**

- 创建：`packages/agent-runtime/src/default-node-terminal.ts`
- 创建：`packages/agent-runtime/src/default-node-terminal.test.ts`
- 修改：`packages/agent-runtime/package.json`
- 修改：`pnpm-lock.yaml`
- 修改：`packages/agent-runtime/src/agent-composition.ts`
- 修改：`packages/agent-runtime/src/default-agent.ts`
- 修改：`packages/agent-runtime/src/agent.ts`
- 修改：`packages/agent-runtime/src/sdk.test.ts`

- [ ] **步骤 1：先写默认 factory 与 override 惰性测试**

```ts
it("creates the local terminal only when terminal is omitted", async () => {
  const createLocal = vi.fn(async () => fakeCreatedTerminal());
  await resolveDefaultNodeTerminal({ override: undefined, createLocal });
  expect(createLocal).toHaveBeenCalledOnce();
});

it("borrows a host terminal without registering cleanup", async () => {
  const host = fakeObservableTerminal();
  const result = await resolveDefaultNodeTerminal({ override: host, createLocal: vi.fn() });
  expect(result.source).toBe("override");
  expect(result.cleanup).toBeUndefined();
});
```

- [ ] **步骤 2：运行测试确认失败**

```bash
pnpm --filter @vykor/agent-runtime exec vitest run src/default-node-terminal.test.ts
```

预期：FAIL，缺少 resolver/factory。

- [ ] **步骤 3：增加 terminal-node 依赖并建立 Node-only factory**

`default-node-terminal.ts` 是唯一直接导入 `@vykor/terminal-node` 的 agent-runtime 文件。Kernel entry 和跨平台核心文件不得导入它。

```ts
export async function createDefaultNodeTerminal(input: {
  cwd: string;
  sessionId: string;
}): Promise<CreatedCapability<ObservableJobProducer<AgentTerminalHost>>>;
```

返回的 `value` 为 `{ value: bundle.terminal, jobs: bundle.jobs }`，cleanup 和 identity 来自 bundle。

- [ ] **步骤 4：在 composition 中接入默认 Terminal 和 Jobs**

解析规则：

- override 未传：创建本地 bundle，将 Terminal 接到 QueryEngine，将 bundle.jobs 加入 Composite。
- override 对象：直接借用，将 bundle.jobs 加入 Composite，不登记 cleanup。
- override false：不创建本地 provider，不注册 Terminal 工具。

任何默认创建失败都执行已经登记的 cleanup 后让 Agent 创建失败，不把 Terminal 降成 unavailable。

- [ ] **步骤 5：把 cleanup stack 接到 Agent close**

`AgentComposition` 返回 `cleanup: CleanupStack` 或一个 `closeOwnedCapabilities()` 函数。`DefaultVykorAgent.close()` 在中断 run、等待 maintenance、关闭 children 后执行 capability cleanup，再关闭 runtime/event bus。保持每一步失败不阻止下一步。

- [ ] **步骤 6：写无 Host 默认能力集成测试**

`sdk.test.ts` 使用 fake model client 创建 Agent，不传 Host：

```ts
expect(agent.getCapabilities()).toMatchObject({
  terminal: { status: "available", source: "default" },
  backgroundShell: { status: "available", source: "default" },
  jobs: { status: "available", source: "default" },
  memory: { status: "available", source: "default" },
  workflowRepository: { status: "available", source: "default" },
  attachments: { status: "unavailable" },
  schedules: { status: "unavailable" },
});
```

测试结束必须 `await agent.close()`，避免 PTY 句柄泄漏。

- [ ] **步骤 7：运行 agent-runtime 定向测试**

```bash
pnpm --filter @vykor/agent-runtime exec vitest run src/default-node-terminal.test.ts src/sdk.test.ts src/agent.test.ts
pnpm --filter @vykor/agent-runtime check-types
```

预期：全部 PASS。

- [ ] **步骤 8：提交默认 Terminal 装配**

```bash
git add packages/agent-runtime packages/agent-runtime/package.json pnpm-lock.yaml
git commit -m "feat(agent-runtime): install default local terminal"
```

## 任务 4：验证 Terminal、Jobs 与生命周期完整闭环

**文件：**

- 修改：`packages/agent-runtime/src/sdk.test.ts`
- 修改：`packages/agent-runtime/src/agent.test.ts`
- 修改：`packages/tools/src/terminal/__test__/terminal-tools.test.ts`
- 修改：`packages/server/src/daemon/__test__/daemon-agent.test.ts`
- 修改：`packages/terminal-node/src/agent-terminal-host.test.ts`

- [ ] **步骤 1：写真实本地 Terminal 联合测试**

仅在 `node-pty` 支持的平台运行真实集成测试：创建 DefaultNodeAgent，通过 Terminal tool 以 `shell: process.execPath` 启动 Node REPL，然后通过 Job send 写入下列 JavaScript，再用 read/wait 读取输出和完成状态，避免依赖 bash：

```ts
await jobs.send({
  sessionId,
  jobId: terminal.id,
  data: "process.stdout.write('terminal-ok'); process.exit(0)\n",
});
```

断言输出包含 `terminal-ok`，wait 的 `timedOut` 为 false，最终状态 completed。

- [ ] **步骤 2：写交互与取消测试**

启动读取 stdin 的 Node 进程，通过 Job send 写入一行并读取回显；另启动长等待进程，通过 cancel 结束，snapshot 状态为 killed。每个测试 finally 中关闭 Agent。

- [ ] **步骤 3：写关闭和初始化失败回滚测试**

覆盖：

- `agent.close()` 调两次只 dispose provider 一次。
- 默认 Terminal 创建后，后续 Workflow/MCP 初始化失败会 dispose Terminal。
- Terminal dispose 失败不阻止 child manager、event bus 和 runtime cleanup。
- Host Terminal override 的 cleanup/dispose 从未被 Agent 调用。

- [ ] **步骤 4：写 daemon 不创建本地 Terminal 测试**

向 daemon loader 注入 Host Terminal bundle，再注入一个会在被调用时抛错的本地 Terminal factory。Agent 创建应成功，factory 调用次数为 0，capability source 为 override。

- [ ] **步骤 5：运行 Terminal、Agent 和 daemon 定向测试**

```bash
pnpm --filter @vykor/terminal-node test
pnpm --filter @vykor/tools exec vitest run src/terminal/__test__/terminal-tools.test.ts src/job/job-tools.test.ts
pnpm --filter @vykor/agent-runtime exec vitest run src/sdk.test.ts src/agent.test.ts
pnpm --filter @vykor/server exec vitest run src/daemon/__test__/daemon-agent.test.ts src/jobs/daemon-job-service.test.ts
```

预期：全部 PASS，测试进程正常退出，没有悬挂 PTY。

- [ ] **步骤 6：运行全仓验收**

```bash
pnpm check-types
pnpm test
pnpm check-docs
```

预期：三条命令退出码均为 0，Turbo 汇总 0 failed。

- [ ] **步骤 7：检查 API 和依赖边界**

```bash
rg -n "hostCapabilities|AgentHostCapabilities|CompactAttachments|setAttachmentsProvider|AgentMemoryStore|FeatureRegistry" packages apps -g "*.ts"
rg -n "@vykor/terminal-node" packages/agent-runtime/src -g "*.ts"
git diff --check
```

预期：第一条无匹配；第二条只匹配 `default-node-terminal.ts` 或明确的 Node 入口；diff check 无错误。

- [ ] **步骤 8：提交联合测试与验收修正**

```bash
git add packages apps pnpm-lock.yaml
git commit -m "test(agent-runtime): verify standalone capability bundle"
```

提交前逐项检查 staged 文件，保留用户无关改动。

## 任务 5：更新架构文档和不兼容变更说明

**文件：**

- 修改：`docs/memory-system.md`
- 修改：与 Agent SDK、Terminal、Jobs 或 Host 接线直接相关、且被 `rg -n "hostCapabilities|setCompactAttachmentsProvider" docs` 找到的文档。
- 修改：项目现有 changeset 目录中的一个新 Markdown changeset 文件（文件名由 `pnpm changeset` 生成）。

- [ ] **步骤 1：更新 Memory 文档的所有权说明**

明确写出：agent-runtime 创建 `AgentMemoryRuntime`；Host 不传记忆路径；user/project Markdown 位置仍由现有配置解析；Session Memory 是独立 compact checkpoint。

- [ ] **步骤 2：更新 SDK 与 Host 示例**

所有示例使用：

```ts
capabilityOverrides: {
  terminal: { value: terminal, jobs: terminalJobs },
  backgroundShell: { value: backgroundShell, jobs: shellJobs },
},
effects: { requestPermission },
```

说明 override 对象必须支持 root session tree，且由 Host 自己释放。

- [ ] **步骤 3：添加不兼容 changeset**

changeset 至少列出：移除 `hostCapabilities`；新增 `capabilityOverrides/effects`；compact setter 改名；DefaultNodeAgent 新增本地 Terminal 默认值；Attachments 和 Schedules 无 Host 时为 unavailable。

- [ ] **步骤 4：运行文档旧词扫描和检查**

```bash
rg -n "hostCapabilities|setCompactAttachmentsProvider|AgentMemoryStore|FeatureRegistry" docs -g "*.md"
pnpm check-docs
```

预期：旧词只允许出现在已完成的历史规格或迁移说明中；活跃使用文档不得继续推荐旧 API。文档检查退出码为 0。

- [ ] **步骤 5：提交文档与 changeset**

```bash
git add docs .changeset
git commit -m "docs(agent-runtime): document default capability assembly"
```

## 阶段三完成检查

- [ ] 无 Host 的 DefaultNodeAgent 默认拥有 Terminal。
- [ ] Terminal 创建的每个会话都能通过 Jobs list/read/wait/send/cancel 控制。
- [ ] Host Terminal override 不创建本地 provider，也不由 Agent 释放。
- [ ] runtime cleanup 逆序、去重、幂等，并汇总失败。
- [ ] Kernel 和跨平台入口不直接导入 terminal-node。
- [ ] standalone 能力快照与实际工具一致，Attachments/Schedules 不被虚报。
- [ ] 全仓类型检查、测试、文档检查通过。
- [ ] 活跃文档和 changeset 已说明不兼容迁移方式。
