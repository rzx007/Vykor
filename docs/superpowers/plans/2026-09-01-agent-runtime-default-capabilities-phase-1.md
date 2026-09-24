# Agent Runtime 默认能力阶段一实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 用 `capabilityOverrides` 取代 `hostCapabilities`，让权限、Schedules、后台 Shell 和 Jobs 具备明确的默认／覆盖／关闭语义，并允许本地与 Host Job 来源同时工作。

**架构：** `DefaultNodeAgent` 解析 Settings 和调用方 overrides，形成唯一的能力结果；`AgentKernel` 只接收解析后的实现。Jobs 通过具体的 `CompositeAgentJobHost` 合并非重叠来源，daemon 将现有聚合 Job 服务收窄为 Terminal、后台 Shell等 producer 对应的视图。

**技术栈：** TypeScript、Vitest、pnpm workspace、Turbo、现有 `@vykor/agent-runtime`、`@vykor/jobs`、`@vykor/server`。

---

## 阶段边界

本阶段完成后：

- 公共 API 中不再存在 `hostCapabilities` 和 `AgentHostCapabilities`。
- `requestPermission` 是可选 effect；ask 且没有 effect 时安全拒绝。
- Schedules 只从 `capabilityOverrides.schedules` 进入运行时。
- Background Shell、Jobs、Child Environment、Workflow Repository、Attachments、Image to Text 可逐项覆盖或关闭。
- Host Terminal 与 Host Background Shell 使用 `{ value, jobs }` bundle，避免产生不可观察的 Job ID。
- `CompositeAgentJobHost` 能同时路由本地来源和 Host 来源。
- Memory 仍按现有路径工作；详细收口在阶段二。
- standalone 本地 Terminal 默认值不在本阶段实现；它在阶段三接入。

## 文件结构

### 新建

- `packages/agent-runtime/src/capability-resolution.ts`：能力三态、诊断快照、简单 override 解析和配置一致性校验。
- `packages/agent-runtime/src/capability-resolution.test.ts`：三态解析、Settings 归一化与 Jobs 关闭约束。
- `packages/jobs/src/composite-agent-job-host.ts`：多个 `AgentJobHost` 的合并、归属缓存和路由。
- `packages/jobs/src/composite-agent-job-host.test.ts`：合并、去重、冲突和五个 Job 操作的路由测试。

### 修改

- `packages/agent-runtime/src/agent-options.ts`：删除 Host 总清单，定义 overrides、effects 和 observable producer bundle。
- `packages/agent-runtime/src/agent.ts`：更新公开 options、inspection 和 `getCapabilities()`。
- `packages/agent-runtime/src/default-agent.ts`：创建默认 permission effect，不再从 Host capability 推导 effects。
- `packages/agent-runtime/src/agent-composition.ts`：逐项解析默认值与 override，创建最终 Jobs 组合器。
- `packages/agent-runtime/src/default-runtime.ts`：工具注册和 QueryEngine 接线改读最终能力结果。
- `packages/agent-runtime/src/kernel.ts`、`packages/agent-runtime/src/kernel-entry.ts`：Kernel 输入改成已解析实现，不再接受 Host 装配对象。
- `packages/agent-runtime/src/child-agent.ts`：向子 Agent 传播原始 overrides 和 effects。
- `packages/agent-runtime/src/index.ts`：导出新的公共类型。
- `packages/jobs/src/index.ts`：导出 `CompositeAgentJobHost`。
- `packages/server/src/jobs/daemon-job-service.ts`：提供按 Job 类别收窄的 Agent Job Host 视图。
- `packages/server/src/daemon/daemon-agent.ts`：构造 observable producer bundles、effects 和 capability overrides。
- `packages/server/src/application/daemon-application.ts`：把 daemon services 映射到新 loader API。
- `packages/server/src/application/agent/agent-pool.ts`：只调整新 Agent API 类型带来的调用。
- `apps/cli/src/print-session.integration.test.ts`：测试 Host options 读取改为 effects/overrides。
- 所有 `packages/**` 与 `apps/**` 中仍引用 `hostCapabilities` 的测试和调用方：一次性改到新 API，最终由零命中检查兜底。

## 任务 1：定义能力配置与解析结果

**文件：**

- 创建：`packages/agent-runtime/src/capability-resolution.ts`
- 创建：`packages/agent-runtime/src/capability-resolution.test.ts`
- 修改：`packages/agent-runtime/src/agent-options.ts`
- 修改：`packages/agent-runtime/src/index.ts`

- [ ] **步骤 1：先写三态解析和 bundle 类型测试**

测试至少覆盖：未传值返回默认、对象覆盖且不创建默认、`false` 关闭且不创建默认、同一个 Job Host 对象可被两个 producer bundle 共享。

```ts
it("uses the default only when an override is omitted", async () => {
  const factory = vi.fn(async () => "local");
  await expect(resolveCapability(undefined, factory)).resolves.toMatchObject({
    status: "available",
    value: "local",
    source: "default",
  });
  expect(factory).toHaveBeenCalledOnce();
});

it("does not call the factory for false", async () => {
  const factory = vi.fn();
  await expect(resolveCapability(false, factory)).resolves.toEqual({
    status: "disabled",
  });
  expect(factory).not.toHaveBeenCalled();
});
```

- [ ] **步骤 2：运行测试并确认因解析器不存在而失败**

运行：

```bash
pnpm --filter @vykor/agent-runtime exec vitest run src/capability-resolution.test.ts
```

预期：FAIL，错误指出无法导入 `capability-resolution.js` 或缺少 `resolveCapability`。

- [ ] **步骤 3：定义新的公共配置类型**

在 `agent-options.ts` 定义并导出一致的名称：

```ts
export type CapabilityOverride<T> = T | false;

export interface ObservableJobProducer<T> {
  value: T;
  jobs: AgentJobHost;
}

export interface AgentCapabilityOverrides {
  terminal?: CapabilityOverride<ObservableJobProducer<AgentTerminalHost>>;
  backgroundShell?: CapabilityOverride<ObservableJobProducer<AgentBackgroundShellHost>>;
  jobs?: false;
  attachments?: CapabilityOverride<AgentAttachmentResourceHost>;
  memory?: false;
  childEnvironment?: CapabilityOverride<AgentChildEnvironmentProvider>;
  workflowRepository?: CapabilityOverride<WorkflowRunRepository>;
  imageToText?: CapabilityOverride<AgentImageToTextHost>;
  schedules?: CapabilityOverride<AgentScheduleEffects>;
}

export interface AgentEffectOverrides {
  requestPermission?: AgentEffects["requestPermission"];
}
```

删除 `AgentPermissionHost` 和 `AgentHostCapabilities`，不要保留 deprecated 别名。

- [ ] **步骤 4：实现轻量解析类型和函数**

```ts
export type ResolvedCapability<T> =
  | { status: "available"; value: T; source: "default" | "override" }
  | { status: "disabled" }
  | { status: "unavailable"; reason: string };

export async function resolveCapability<T>(
  override: CapabilityOverride<T> | undefined,
  createDefault: () => Promise<T>,
): Promise<ResolvedCapability<T>> {
  if (override === false) return { status: "disabled" };
  if (override !== undefined) return { status: "available", value: override, source: "override" };
  return { status: "available", value: await createDefault(), source: "default" };
}
```

另外提供 `disabledCapability()`、`unavailableCapability(reason)` 和去除 `value` 的 `toCapabilitySnapshot()`；不要建立 registry 或 service locator。

诊断类型固定为：

```ts
export type CapabilitySnapshot =
  | { status: "available"; source: "default" | "override" }
  | { status: "disabled" }
  | { status: "unavailable"; reason: string };

export type AgentCapabilitySnapshot = {
  [K in keyof ResolvedAgentCapabilities]: CapabilitySnapshot;
};
```

- [ ] **步骤 5：增加 Jobs 关闭一致性测试与校验**

```ts
expect(() => assertJobConfiguration({
  jobs: false,
  terminal: undefined,
  backgroundShell: false,
  childEnvironment: false,
  workflowRepository: false,
})).toThrow(/terminal.*must also be disabled/i);
```

`jobs:false` 时，Terminal、Background Shell、Child Environment 和 Workflow Repository 必须全部为 `false`；否则抛出包含具体未关闭能力名的配置错误。

- [ ] **步骤 6：运行阶段测试与类型检查**

```bash
pnpm --filter @vykor/agent-runtime exec vitest run src/capability-resolution.test.ts
pnpm --filter @vykor/agent-runtime check-types
```

预期：测试 PASS，类型检查退出码为 0。

- [ ] **步骤 7：提交能力类型**

```bash
git add packages/agent-runtime/src/capability-resolution.ts packages/agent-runtime/src/capability-resolution.test.ts packages/agent-runtime/src/agent-options.ts packages/agent-runtime/src/index.ts
git commit -m "refactor(agent-runtime): define capability override model"
```

## 任务 2：实现 CompositeAgentJobHost

**文件：**

- 创建：`packages/jobs/src/composite-agent-job-host.ts`
- 创建：`packages/jobs/src/composite-agent-job-host.test.ts`
- 修改：`packages/jobs/src/index.ts`

- [ ] **步骤 1：先写 list 合并、对象身份去重与 Job ID 冲突测试**

```ts
it("deduplicates the same source object", async () => {
  const source = fakeJobHost([job("task_1")]);
  const composite = new CompositeAgentJobHost([source, source]);
  await expect(composite.list({ sessionId: "s1" })).resolves.toHaveLength(1);
});

it("rejects an id claimed by different sources", async () => {
  const composite = new CompositeAgentJobHost([
    fakeJobHost([job("shared")]),
    fakeJobHost([job("shared")]),
  ]);
  await expect(composite.list({ sessionId: "s1" })).rejects.toThrow(
    /Job source conflict: shared/,
  );
});
```

- [ ] **步骤 2：运行测试并确认失败**

```bash
pnpm --filter @vykor/jobs exec vitest run src/composite-agent-job-host.test.ts
```

预期：FAIL，缺少 `CompositeAgentJobHost`。

- [ ] **步骤 3：实现来源去重和 list 归属索引**

构造器按对象身份去重。`list()` 逐个调用来源，先完成冲突检查，再应用一次 `filterJobSnapshots`，避免各来源提前 limit 后得到错误的全局排序。

```ts
export class CompositeAgentJobHost implements AgentJobHost {
  private readonly sources: AgentJobHost[];
  private readonly ownerByJobId = new Map<string, AgentJobHost>();

  constructor(sources: Iterable<AgentJobHost>) {
    this.sources = [...new Set(sources)];
  }
}
```

向来源调用 `list` 时去掉 `limit`，保留 kinds/status/time 等过滤条件；合并后再执行全局 limit。

- [ ] **步骤 4：先写 read/wait/send/cancel 路由测试**

每种操作至少验证：已建立归属时只调用一个来源；尚未建立归属时通过 `includeFinished:true` 的无过滤 list 建立索引；找不到时抛出 `Job not found: <id>`。

```ts
await composite.list({ sessionId: "s1", includeFinished: true });
await composite.send({ sessionId: "s1", jobId: "terminal_1", data: "pwd\n" });
expect(terminalJobs.send).toHaveBeenCalledOnce();
expect(shellJobs.send).not.toHaveBeenCalled();
```

- [ ] **步骤 5：实现五个 AgentJobHost 操作**

抽取 `resolveOwner(sessionId, jobId)`；缓存键使用 `sessionId + "\0" + jobId`，避免不同子会话复用相同 ID 时串路由。缓存未命中时，对所有来源执行 `{ sessionId, includeFinished: true }` 的 list 并重建该 session 的归属；仍未找到才抛出 `Job not found`。确定来源之后，read/wait/send/cancel 的任何错误都原样返回，不靠匹配错误字符串继续试探其他来源。

- [ ] **步骤 6：运行 Jobs 包测试**

```bash
pnpm --filter @vykor/jobs exec vitest run src/index.test.ts src/composite-agent-job-host.test.ts
pnpm --filter @vykor/jobs check-types
```

预期：全部 PASS。

- [ ] **步骤 7：提交 Jobs 组合器**

```bash
git add packages/jobs/src/composite-agent-job-host.ts packages/jobs/src/composite-agent-job-host.test.ts packages/jobs/src/index.ts
git commit -m "feat(jobs): compose multiple job control sources"
```

## 任务 3：迁移 DefaultNodeAgent 装配与权限

**文件：**

- 修改：`packages/agent-runtime/src/agent.ts`
- 修改：`packages/agent-runtime/src/default-agent.ts`
- 修改：`packages/agent-runtime/src/agent-composition.ts`
- 修改：`packages/agent-runtime/src/default-runtime.ts`
- 修改：`packages/agent-runtime/src/kernel.ts`
- 修改：`packages/agent-runtime/src/kernel-entry.ts`
- 修改：`packages/agent-runtime/src/child-agent.ts`
- 修改：`packages/agent-runtime/src/default-runtime.test.ts`
- 修改：`packages/agent-runtime/src/kernel.test.ts`
- 修改：`packages/agent-runtime/src/agent.test.ts`
- 修改：`packages/agent-runtime/src/sdk.test.ts`

- [ ] **步骤 1：先写 DefaultNodeAgent 无权限 effect 的测试**

构造 PermissionChecker 返回 ask 的工具，验证不传 `effects.requestPermission` 时 Agent 能创建，但工具调用得到 denied，reason 为 `No permission effect configured`。

- [ ] **步骤 2：先写逐项 override 不影响默认值的测试**

在 `sdk.test.ts` 增加：只覆盖附件时，Background Shell 与 Jobs 仍存在；只关闭 imageToText 时 Workflow 不受影响；Schedules 为 false 时不注册 Schedule 工具。

```ts
const agent = await createDefaultNodeAgent({
  cwd,
  capabilityOverrides: { attachments: attachmentHost },
  settings: testSettings(),
});
expect(agent.getCapabilities()).toMatchObject({
  attachments: { status: "available", source: "override" },
  backgroundShell: { status: "available", source: "default" },
  jobs: { status: "available", source: "default" },
});
```

- [ ] **步骤 3：运行定向测试确认旧装配不满足新契约**

```bash
pnpm --filter @vykor/agent-runtime exec vitest run src/kernel.test.ts src/default-runtime.test.ts src/sdk.test.ts src/agent.test.ts
```

预期：FAIL，主要为新 options、`getCapabilities()` 和默认值断言不存在。

- [ ] **步骤 4：更新公开 Agent API**

`VykorAgentOptions` 使用：

```ts
capabilityOverrides?: AgentCapabilityOverrides;
effects?: AgentEffectOverrides;
```

将 `AgentInspection.hostCapabilities` 替换为 `capabilities: AgentCapabilitySnapshot`，并在 Agent 上增加：

```ts
getCapabilities(): AgentCapabilitySnapshot;
```

`inspect()` 可以继续返回 `capabilities`，但不得保留旧的字符串数组字段。

- [ ] **步骤 5：让 DefaultNodeAgent 创建安全默认 effect**

```ts
const effects: AgentEffects = {
  requestPermission: options.effects?.requestPermission ?? (async () => ({
    status: "denied",
    reason: "No permission effect configured",
  })),
};
```

不要再把 Schedules 放进 `AgentEffects`。如果核心 `AgentEffects` 类型仍包含 schedules，在本任务中删除并修复直接调用方。

- [ ] **步骤 6：重写 agent-composition 的逐项解析**

装配顺序固定为：Settings 与 extensions → child environment → Child Manager → Workflow Repository → LocalAgentJobHost → producer overrides → Composite Jobs → QueryEngine 和工具。使用明确局部变量，不创建通用 factory registry。

本阶段默认 Terminal 保持 unavailable；Host Terminal bundle 则把 `value` 接到 `setTerminal()`，把 `jobs` 加入组合器。

- [ ] **步骤 7：让工具注册读取 resolved capabilities**

删除 `default-runtime.ts` 中只为工具注册生成的 boolean capability 对象。Schedule、Terminal、Jobs、Workflow、ImageToText、Attachments 的工具存在性直接由 resolved 状态决定；QueryEngine 接收相同对象中的 `value`。

- [ ] **步骤 8：向子 Agent 传播原始 overrides 和 effects**

`AgentChildManagerOptions` 保存 `capabilityOverrides` 与 `effects`。子 Agent 调用 `createDefaultNodeAgentInternal` 时继续传原始对象；不要把父 Agent 的 resolved 本地实例传给子 Agent。

- [ ] **步骤 9：运行 agent-runtime 测试和类型检查**

```bash
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/agent-runtime check-types
```

预期：全部 PASS。若此时其他 workspace 因旧 API 还未迁移而类型失败，记录在下一任务解决，但 agent-runtime 自身不得保留旧别名。

- [ ] **步骤 10：提交 Agent 核心迁移**

```bash
git add packages/agent-runtime/src
git commit -m "refactor(agent-runtime): resolve default capabilities per item"
```

## 任务 4：将 daemon Job 能力改成非重叠来源

**文件：**

- 修改：`packages/server/src/jobs/daemon-job-service.ts`
- 修改：`packages/server/src/jobs/daemon-job-service.test.ts`
- 修改：`packages/server/src/daemon/daemon-agent.ts`
- 修改：`packages/server/src/daemon/__test__/daemon-agent.test.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`packages/server/src/application/__test__/durable-agent-application.test.ts`

- [ ] **步骤 1：先写 daemon Job 视图不重叠测试**

新增 `createTerminalAgentHost(session)` 与 `createDetachedProcessAgentHost(session)` 的契约测试：Terminal 视图只列 terminal；后台进程视图只列 `type === "shell"` 或 `metadata.executionBackend === "detached_process"` 的任务；两者都不列 Workflow 和 framework child task。

```ts
expect(await terminalJobs.list({ sessionId: root.id, includeFinished: true }))
  .toEqual([expect.objectContaining({ kind: "terminal" })]);
expect(await shellJobs.list({ sessionId: root.id, includeFinished: true }))
  .toEqual([expect.objectContaining({ kind: "shell" })]);
```

- [ ] **步骤 2：运行 daemon Job 测试确认失败**

```bash
pnpm --filter @vykor/server exec vitest run src/jobs/daemon-job-service.test.ts
```

预期：FAIL，新的视图方法不存在。

- [ ] **步骤 3：在 DaemonJobService 内复用现有 read/wait/send/cancel**

保留内部完整 `list/read/wait/send/cancel` 供 HTTP 和业务调用。Agent 视图在入口增加允许种类集合，并在 `resolve()` 后验证来源：

```ts
createTerminalAgentHost(session: SessionRecord): AgentJobHost;
createDetachedProcessAgentHost(session: SessionRecord): AgentJobHost;
```

不要复制 Terminal、task、workflow 的投影和控制代码。对视图外 Job ID 返回 `Job not found`，使 Composite 可以尝试其他来源。

- [ ] **步骤 4：迁移 DaemonAgentLoaderOptions**

用两个 producer bundle 工厂替代三个互相独立的工厂：

```ts
createTerminal?(session: SessionRecord): ObservableJobProducer<AgentTerminalHost>;
createBackgroundShell?(session: SessionRecord): ObservableJobProducer<AgentBackgroundShellHost>;
```

daemon application 将 Terminal host 与 terminal-only jobs 配对，将 Background Shell host 与 detached-process-only jobs 配对。Schedules 放到 `capabilityOverrides`，权限放到 `effects`。

- [ ] **步骤 5：运行 daemon 定向测试**

```bash
pnpm --filter @vykor/server exec vitest run src/jobs/daemon-job-service.test.ts src/daemon/__test__/daemon-agent.test.ts src/application/__test__/durable-agent-application.test.ts
pnpm --filter @vykor/server check-types
```

预期：全部 PASS；测试明确断言传给 Agent 的 Terminal 和 Shell bundle 可共享或使用不同 Job Host。

- [ ] **步骤 6：提交 daemon 适配**

```bash
git add packages/server/src/jobs packages/server/src/daemon packages/server/src/application/daemon-application.ts packages/server/src/application/__test__/durable-agent-application.test.ts
git commit -m "refactor(server): provide scoped agent job sources"
```

## 任务 5：一次性迁移剩余调用方并做阶段验收

**文件：**

- 修改：`apps/cli/src/print-session.integration.test.ts`
- 修改：`packages/server/src/http/__test__/http.test.ts`
- 修改：`packages/server/src/application/session/session-run-executor.ts`
- 修改：`packages/server/src/application/session/__test__/session-run-executor.test.ts`
- 修改：所有由下述 `rg` 命令列出的剩余 TypeScript 调用方和测试。

- [ ] **步骤 1：列出剩余旧 API 引用并逐一迁移**

```bash
rg -n "AgentHostCapabilities|hostCapabilities|AgentEffects.*schedules|effects\.schedules" packages apps -g "*.ts"
```

每个创建 Agent 的位置改用 `capabilityOverrides` 和 `effects`；每个检查安装能力的位置改用 `getCapabilities()` 或 `inspect().capabilities`。不要通过类型断言绕过迁移。

- [ ] **步骤 2：运行零命中检查**

```bash
rg -n "AgentHostCapabilities|hostCapabilities|effects\.schedules" packages apps -g "*.ts"
```

预期：无输出，退出码 1 表示没有匹配项。若业务文案需要出现旧术语，只允许出现在迁移文档，不允许在 TypeScript 源码中保留。

- [ ] **步骤 3：运行三个核心 workspace 的测试**

```bash
pnpm --filter @vykor/jobs test
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/server test
```

预期：全部 PASS，0 failed。

- [ ] **步骤 4：运行全仓类型检查和文档检查**

```bash
pnpm check-types
pnpm check-docs
```

预期：两条命令退出码均为 0。

- [ ] **步骤 5：检查阶段一 diff 范围**

```bash
git diff --check
git status --short
git log --oneline -5
```

确认没有 Memory schema、compact provider 命名、本地 Terminal 默认实现和 UI 行为变更；这些分别属于后续阶段或非目标。

- [ ] **步骤 6：提交机械迁移与阶段验收修正**

```bash
git add packages apps
git commit -m "refactor(agent-runtime): finish capability api migration"
```

提交前必须使用路径清单核对 staged 文件，不能带入用户原有的无关改动。

## 阶段一完成检查

- [ ] `hostCapabilities` 在 TypeScript 源码中零命中。
- [ ] ask 无权限 effect 时安全拒绝，而不是阻止 Agent 创建。
- [ ] Schedules 不再存在于 `AgentEffects`。
- [ ] Host producer 必须携带可观察它所建 Job 的 `AgentJobHost`。
- [ ] daemon 给 Agent 的 Job 来源互不重复。
- [ ] 覆盖一项能力不会关闭其他默认能力。
- [ ] `pnpm check-types`、`pnpm check-docs` 和三个核心 workspace 测试通过。
