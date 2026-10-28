# SDK 与 daemon 共用执行核心实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户已明确授权 A、B、C 全部生产修改；三个阶段已实施，通过真实统一验收并分别提交。

**Goal:** 完成 Agent、Shell、Terminal、Workflow 生命周期收拢，使 SDK 和 daemon 共用同一套执行规则，并删除被替代的实现。

**Architecture:** 沿用 ChildManager / FrameworkAgentRun、DetachedProcessSupervisor、LocalTerminalProvider、WorkflowHost / coordinator 四类执行器。Jobs 静态路由到唯一来源；daemon 只负责权限、环境、存储与返回格式。子身份、单轮结果、运行许可分开，停止由真实 handle 确认，保存失败使用既有补偿。

**Tech Stack:** TypeScript、Node.js、pnpm 10.30.2、Vitest 3、现有 SQLite SessionStore、现有 HTTP/SSE 协议。

**Spec:** [架构方案](../specs/2026-10-27-shared-execution-core-design.md)。先读该文 §3 到 §6 的契约，再执行本文。调研材料只用于固定证据，不重做整轮调研。

## 当前进度

阶段 A 已审查并提交为 `a54f28210b88d3a4f9c78ecf492bb7afa492ce7b`；阶段 B 已审查并提交为 `59f3ebd41c1ac7b4e8c858f72149fbddc7f51925`。协议为 6，Jobs feature 为 3。阶段 C 已实施并通过最终验收：A/B/C 真实三文件 66/66、Workflow 28/28；审查尾部修正另复验 8/8 真实取消/查询路径和 26/26 runner/宿主用例。四大门禁及文档/退役检查通过；阶段 C 的独立提交包含本次最终记录。证据见工作树 `.superpowers/sdd/2026-10-27-shared-execution-core/stage-c-report.md`。

## 全局约束与基线

- 工作目录：`C:/Users/ruanz/.codex/worktrees/shared-execution-core/openharness-ts`。下列文件表使用仓库相对路径。
- 核对 HEAD：`f40f276b（本工作树生产基线；与原计划生产代码一致）`；调研基线：`45e30ad25d66a53b4aff2e8fb2b4960910e31bfc`。执行前只检查此后涉及文件的差异；有相关变动时调整对应任务，不重新研究参考仓库。
- 不修改 Q1 存储优化和 S1 unknown 工具写入保护。可靠启动/工具记录仍是执行前置条件。
- 不新增通用 Job 状态库、分布式调度器、跨进程自动重放、额外执行 ID、结果缓存服务或生命周期管理器。
- 保留默认 `maxDepth=4`、`maxActiveChildren=8`、`maxTotalChildren=64`、child 空闲 TTL 5 分钟、现有 requests 保留上限 256；只把 activeChildren 改为按 run 占用。
- SDK 与 daemon 的运行、名额、取消与收尾规则只能在共同核心出现。适配层不能注册自己的结果观察 Map、停止 timer 或状态回滚。
- 每种任务只有一个执行归属；点查、等待、取消不得调用 list，也不得以捕获任意异常触发另一后端。
- 新路径与旧路径在同一阶段完成替换和删除；没有永久兼容别名、v5 fallback 或切换开关。
- 测试放模块的 `__test__/`；跨模块验收放 `tests/agent-integration/__test__/`，共享 fixture 放其中 `fixtures/` 并更新 README。
- 本计划三阶段顺序为 A → B → C。阶段内可形成审查提交，整阶段通过前不发布；每阶段结束都有可使用的系统。

## 文件职责与稳定接口

新增生产文件仅四个，均替代旧文件中的职责：

| 新文件 | 输入 / 输出 | 允许拥有的状态 |
| --- | --- | --- |
| `packages/jobs/src/routed-agent-job-host.ts` | `new RoutedAgentJobHost(sources: Partial<Record<JobKind, AgentJobHost>>)` → `AgentJobHost` | 固定来源绑定；不能有按 jobId 的缓存 |
| `packages/agent-runtime/src/node/jobs/child-job-source.ts` | `createChildJobSource(options: ChildJobSourceOptions): AgentJobHost` | 无独立结果与生命周期状态 |
| `packages/agent-runtime/src/node/jobs/process-job-source.ts` | `createProcessJobSource(options: ProcessJobSourceOptions): ProcessJobBindings` | 无独立请求/执行表；直接使用 supervisor |
| `packages/agent-runtime/src/node/jobs/node-job-bindings.ts` | `createNodeJobBindings(options: NodeJobBindingsOptions): NodeJobBindings` | 无执行状态；一次绑定来源、Shell 工具端口 |

类型随使用它的文件放置，不新增 interfaces/types/manager 分类目录。Shell 接纳规则直接放已有 supervisor，Terminal/Workflow Jobs 直接复用已有 bundle/bind，不新增来源文件。以下类型中的既有领域接口从原文件导入；新接口定义完整如下：

```ts
// packages/jobs/src/contracts.ts；JobKind/JobSnapshot 已存在。
export type JobTarget =
  | { kind: "agent"; jobId: string; runId: string }
  | { kind: "shell" | "terminal" | "workflow" | "dream"; jobId: string };
export interface JobInputReceipt { sessionId: string; inputId: string; runId: string }
export interface JobListResult {
  jobs: JobSnapshot[];
  errors: Array<{ kind: JobKind; message: string }>;
}

// packages/jobs/src/index.ts；沿用现有 Authorization。
export interface JobReadRequest {
  sessionId: string; target: JobTarget; after?: number; maxChars?: number;
}
export interface JobWaitRequest extends JobReadRequest {
  timeoutMs: number; signal?: AbortSignal;
}
export interface JobSendRequest {
  sessionId: string; target: JobTarget; data: string;
}
export interface JobCancelRequest {
  sessionId: string; target: JobTarget; reason?: string;
}
// AgentJobHost: list -> Promise<JobListResult>；
// send -> Promise<JobInputReceipt | void>；其余保留既有返回类型。
// JobSnapshot 加 target: JobTarget；JobListRequest 沿用现有过滤字段。
```

```ts
// node/jobs/child-job-source.ts
export interface ChildJobSourceOptions {
  sessionId: string;
  cwd: string;
  children: AgentChildDirectory;
  processes: DetachedProcessSupervisor;
  sendChildInput(
    childId: string, expectedRunId: string, input: AgentChildInput,
    authorization?: AgentJobAuthorization,
  ): Promise<AgentInputReceipt>;
  archive?: Pick<AgentJobHost, "list" | "read">;
}
// node/jobs/process-job-source.ts
export interface ProcessJobSourceOptions {
  sessionId: string;
  cwd: string;
  processes: DetachedProcessSupervisor;
  admission?: ShellAdmissionPorts;
  archive?: Pick<AgentJobHost, "list" | "read">;
}
export interface ProcessJobBindings {
  jobs: AgentJobHost;
  backgroundShell: AgentBackgroundShellHost;
}
// node/jobs/node-job-bindings.ts
export interface NodeJobBindingsOptions {
  child: ChildJobSourceOptions;
  process: ProcessJobSourceOptions;
  terminal?: AgentJobHost;
  workflow?: AgentJobHost;
}
export interface NodeJobBindings {
  jobs: AgentJobHost;
  backgroundShell: AgentBackgroundShellHost;
}
```

`archive` 是领域只读持久端口，不是第二个 AgentJobHost 执行器。点查只有在实时索引明确返回不存在时才能用它；存储错误不能吞掉。历史 list 与实时项用 `(kind, jobId, runId)` 合并，实时项优先；这是一次查询的合并，无常驻缓存。Agent 归档找不到 runId 时只提供只读归档项，不伪造可取消 target；这类项以旧持久记录详情返回，正常 Jobs 列表只输出可确定 target 的项，并在 errors 中说明不可定位的旧记录。

低层注入接口经 2026-10-28 复核修正为：`AgentCapabilityOverrides.terminal?: CapabilityOverride<SessionCapabilityFactory<TerminalProvider>>`，`backgroundShell?: CapabilityOverride<SessionCapabilityFactory<ShellAdmissionPorts>>`；`SessionCapabilityFactory<T>` 接收实际 `{ sessionId, cwd }` 并返回端口，每个会话组装时调用一次。其余 childEnvironment/workflowRepository 等既有端口保留。`VykorAgentOptions.jobArchiveForSession?: (sessionId: string) => { agent?: Pick<AgentJobHost,"list"|"read">; process?: Pick<AgentJobHost,"list"|"read"> }` 只用于持久读取。`DaemonApplicationOptions` 的 `createTerminal/createBackgroundShell` 原全 host 工厂分别替换为 `terminalProviderForSession(session: SessionRecord): TerminalProvider` 和 `shellAdmissionForSession(session: SessionRecord): ShellAdmissionPorts`，不保留旧字段或父会话端口值形式。共同工厂用实际会话端口创建同一 Terminal bundle 和进程来源，宿主不再提供 Jobs 控制器。

## A1：Jobs 契约与无全量发现的路由

**修改文件：**

- `packages/jobs/src/contracts.ts`、`packages/jobs/src/index.ts`、`packages/jobs/src/README.md`。
- 新建 `packages/jobs/src/routed-agent-job-host.ts` 和 `src/__test__/routed-agent-job-host.test.ts`。
- 删除 `packages/jobs/src/composite-agent-job-host.ts` 和 `src/__test__/composite-agent-job-host.test.ts`，保留过滤/排序契约测试并迁入新测试文件。
- `packages/protocol/src/runtime/job.ts`、`runtime/capabilities.ts`、`serialization/serialization.ts`、`serialization/__test__/serialization.test.ts`、`src/index.ts`。
- `packages/server/src/http/routes/job.ts`、`system.ts`；`packages/client/src/resources/runtime/job-resource.ts` 和 `__test__/job-resource.test.ts`。

**接口：**消费上文的 `JobTarget/JobListResult/JobInputReceipt`，产出 `RoutedAgentJobHost`。直接方法仅使用 `sources[input.target.kind]`；缺失类型返回现有业务错误。list 对每一个 kind 分别调用 `list({...input,kinds:[kind]})`，即使同一进程来源绑定了 shell/agent/dream，也不会重复返回其他类型。

- [x] 写入路由回归测试。以下 host 仅用于路由单元测试，不能替代 A5 的真实组装验收。

```ts
it("does not consult any list for a direct read, wait or cancel", async () => {
  const request = { sessionId: "s", target: { kind: "agent", jobId: "a", runId: "r" } } as const;
  const snapshot: JobSnapshot = {
    id: "a", kind: "agent", target: request.target, label: "a", ownerSession: "s",
    status: "completed", capabilities: { read: true, wait: true, send: true, cancel: false },
    cwd: "/repo", startedAt: 1, updatedAt: 2, finishedAt: 2,
  };
  const list = vi.fn(async () => { throw new Error("unrelated shell listing failed"); });
  const source: AgentJobHost = {
    list,
    read: vi.fn(async () => ({ snapshot, text: "done", cursor: 4, truncated: false })),
    wait: vi.fn(async () => ({ snapshot, text: "done", cursor: 4, truncated: false, timedOut: false })),
    send: vi.fn(async () => undefined), cancel: vi.fn(async () => snapshot),
  };
  const jobs = new RoutedAgentJobHost({ agent: source, shell: { ...source, list } });
  expect((await jobs.read(request)).text).toBe("done");
  expect((await jobs.wait({ ...request, timeoutMs: 1 })).snapshot.status).toBe("completed");
  expect((await jobs.cancel(request)).status).toBe("completed");
  expect(list).not.toHaveBeenCalled();
  expect((await jobs.list({ sessionId: "s" })).errors).toHaveLength(2);
});
```

- [x] 执行 `pnpm --filter @vykor/jobs exec vitest run src/__test__/routed-agent-job-host.test.ts`。基线应在导入新路由/新 target 契约处失败；先记录失败，再实现。
- [x] 将直接操作实现为 `return sourceFor(input.target.kind).read(input)` 等五个薄方法；list 使用 `Promise.allSettled` 汇总，调用现有 `filterJobSnapshots`。没有 ownerByJobKey 或来源探测。
- [x] 协议改为版本 6、Jobs feature 3；decoder 验证 kind、target 与 snapshot.id 一致，agent 必须带 runId；Client read/wait/cancel 改为 `(target, options)`，send 返回可选回执，list 返回 `{jobs,errors}`。HTTP 与 Client 不为旧参数提供重载。
- [x] 同阶段补测试：缺失 kind、过期 runId、非法 receipt、部分列表失败、版本不匹配。沿用现有错误响应格式，不能改为成功空列表。
- [x] 运行 Jobs、protocol serialization、Client job-resource 定向测试。A4/A5 接线完成前此提交仅作为阶段内审查点，不发布。

## A2：唯一 child 来源与共同 Node 组装

**修改文件：**

- `packages/agent-contracts/src/execution/children.ts`、`src/index.ts` 和 `src/execution/README.md`。
- `packages/agent-runtime/src/kernel/children/child-agent.ts`、`child-registry.ts` 及 `README.md`。
- `packages/agent-runtime/src/node/children/node-child-manager.ts`、`README.md`。
- 新建上文三个 `node/jobs/` 文件、`__test__/child-job-source.test.ts`、`__test__/process-job-source.test.ts`；更新该目录 README。
- `packages/agent-runtime/src/node/capabilities/default-agent-capabilities.ts`、`node/agent/default-agent.ts`、`agent-options.ts`、`node/environment/default-node-terminal.ts`，以及这些目录的 README。
- `packages/agent-runtime/src/index.ts`、`kernel-entry.ts`，只导出仍有用途的真实契约。

**接口：**消费 `AgentChildHandle.readRun/waitRun` 与 `AgentChildInvocation` 的必填 runId/inputId；产出 `NodeJobBindings`。A2 先用现有真实 run.result 的结束来填 canonical requests，B1 再替换为真实 settled 屏障；不保留两套运行记录，仍然只有 requests 一处。A 仍采用旧 activeChildren 计数，直到 B 整体替换。

- [x] 在真实 child 的既有测试目录增加多轮与过期取消断言；新增 Jobs source 测试只能引用 ChildManager 实际返回的 handle，不能手写 getter。

```ts
// 在 A5 的真实 fixture 中也执行，避免只在 ChildManager 隔离测试中通过。
const first = await f.spawn("first");
await first.handle.waitRun(first.target.runId);
f.hold("second");
const receipt = await f.send(first.target, "second");
const second = { ...first.target, runId: receipt.runId };
expect(second.runId).not.toBe(first.target.runId);
expect((await f.read(first.target)).text).toContain("first");
await f.cancel(first.target);
expect((await f.read(second)).snapshot.status).toBe("running");
f.release("second");
expect((await f.wait(second)).snapshot.status).toBe("completed");
expect(first.handle.state).not.toBe("closed");
```

- [x] 运行新增测试，确认基线因旧轮不可定点读取、Promise 身份比较或取消关闭整个 child 而失败。
- [x] 将 requests 中原先 input/receipt/settled 数据扩为同一记录的真实 handle、runId、timestamps、结果引用。`readRun` 只查此记录；`waitRun` 只等待记录的那次执行。删掉 `lastResult` 与额外 resultPromise 观察状态。保留当前 run 指针，它指向同一记录，不另存结果。
- [x] 将 `sendChildInput` 扩成带 expectedRunId 的原子核对入口；保留当前授权快照和 follow-up 再授权。过期请求报冲突，不重开/覆盖新轮。
- [x] 实现 child/process 来源：实时 child 从 `AgentChildDirectory.get(jobId)` 找 handle；其 runId 不匹配时只读旧 requests。显式进程 Agent 依据现有 task metadata 定点选择 supervisor；SDK 无存储时定点核对两个已有索引并拒绝同 ID 双重归属。进程的纯 snapshot/read 映射函数放 process-job-source.ts，供 Agent 来源复用，不再复制映射。read/wait/cancel 只调用被选择的真实执行器。
- [x] 实现 `createNodeJobBindings`，Agent 来源只注册一次，Shell 只绑定选定 supervisor，Terminal/Workflow 使用既有 bundle/bind。删除 `ObservableJobProducer` 生命周期覆盖接口，改为 provider/environment/storage 端口；`jobs:false` 仍只关闭工具暴露，不复制执行规则。
- [x] 删除 `node/jobs/local-agent-job-host.ts` 和 `__test__/local-agent-job-host.test.ts`；原过滤、输出截断、Shell 幂等测试迁至对应来源/执行器测试。不得在新文件保留 childObservations 或 shellRequests。
- [x] 运行 `pnpm --filter @vykor/agent-runtime exec vitest run src/node/jobs/__test__ src/node/children/__test__/child-agent.test.ts`。确认前台 Agent 工具回执包含 `{target,inputId,runId,childSessionId}`，并沿用原 jobId 的 childId，不新增 ID。

## A3：Shell 与 Terminal 的执行所有权回到既有执行器

**修改文件：**

- `packages/execution-node/src/executions/detached-process-supervisor.ts`、`types.ts`、`README.md`、`__test__/detached-process-supervisor.test.ts`。
- `packages/server/src/application/session/execution/background-shell-service.ts`、`__test__/background-shell-service.test.ts` 与 `README.md`。
- `packages/terminal/src/provider.ts`、`README.md`；`packages/terminal-node/src/providers/local-terminal-provider.ts`、`host/agent-terminal-host.ts`，各自 `__test__` 与 README。
- `packages/server/src/terminal/daemon-terminal-service.ts` 与同目录 README、对应测试。

**接口：**保留 `DetachedProcessSupervisor.startShellExecution/stopExecution`，对象参数形式扩为 `startShellExecution(options: StartShellExecutionOptions, ports?: ShellAdmissionPorts): Promise<DetachedProcessExecution>`；端口省略时采用同一路径的本地环境和无持久存储实现。TerminalProvider 增加 `get(terminalId: string): Promise<TerminalSessionInfo | undefined>`，复用现有 TerminalSessionInfo，不能再定义另一份 terminal DTO。

Shell 端口类型放 `executions/types.ts`，以已有 `StartShellExecutionOptions` 为基础：

```ts
export interface ShellAdmissionPorts {
  // reserve/load/save 只读写既有 SessionExecutionRecord，执行器不依赖 SQL。
  reserve(input: StartShellExecutionOptions): Promise<void>;
  load(id: string): Promise<DetachedProcessExecution | undefined>;
  save(execution: DetachedProcessExecution): Promise<void>;
  acquireEnvironment(input: StartShellExecutionOptions): Promise<{
    launch: StartShellExecutionOptions;
    release(): Promise<void>;
  }>;
}
```

SDK 使用不落库端口和原本地 launch 配置；daemon 将已有 pending task 接纳、请求指纹和环境 lease 接入这些端口。类型字段映射在 adapter 内完成，判断何时 reserve/start/stop/release 的顺序全部在 supervisor。已经存在的 shellStartPromises、execution/state、输出 log 是唯一运行表。

- [x] 增加三项失败测试：同一请求并发只启动一个进程；环境尚未获得时取消，之后绝不 spawn；kill 拒绝或输出 drain 未结束时不发布 stopped。

```ts
it("does not spawn when cancelled before environment admission", async () => {
  function gate() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }
  const requested = gate(), environment = gate();
  const supervisor = makeManager(); // 该测试文件既有的真实 supervisor 工厂。
  const invoke = vi.fn(async () => { throw new Error("must not spawn"); });
  const released = vi.fn(async () => undefined);
  const options: StartShellExecutionOptions & { id: string } = {
    id: "cancel-before-environment", argv: [process.execPath, "-e", "process.exit(0)"],
    cwd: process.cwd(), sessionId: "s", description: "controlled environment",
    processExecutor: { execShell: invoke, execProcess: invoke },
  };
  const ports: ShellAdmissionPorts = {
    reserve: async () => undefined, load: async () => undefined, save: async () => undefined,
    acquireEnvironment: async input => {
      requested.resolve();
      await environment.promise;
      return { launch: input, release: released };
    },
  };
  const started = supervisor.startShellExecution(options, ports);
  // 立即挂接拒绝处理，防止取消故障测试产生未处理拒绝。
  const startOutcome = Promise.allSettled([started]);
  await requested.promise;
  const stopping = supervisor.stopExecution(options.id);
  expect(supervisor.getExecution(options.id)?.status).not.toBe("stopped");
  environment.resolve();
  await Promise.all([startOutcome, stopping]);
  expect(invoke).not.toHaveBeenCalled();
  expect(released).toHaveBeenCalledTimes(1);
});
```

使用已有 `makeManager()` 以纳入该文件的真实资源清理；新增类型从 executions/types 导入。用 deferred 门闩控制竞态，不能用延时猜顺序。

- [x] 运行 executor 定向测试，记录旧代码提前 stopped 或重复启动的失败断言。
- [x] 将 daemon 的 starting Map、environmentLeases 及 LocalAgentJobHost 的 shellRequests 指纹/去重规则合入 supervisor 已有启动表，保持“同请求同参数复用、改参数冲突”的既有语义。清理 stale 请求沿用现有限制，不新增请求缓存。显式进程 Agent 的 writeInput 只向仍在运行的进程写入；删除已停止后复用同 ID 自动 restart 的分支及 MAX_RESTARTS/RESTART_NOTICE。再次启动必须显式调用 startAgentProcess，得到其本来使用的新 execution ID，避免同一 target 指向另一轮进程。
- [x] `stopExecution` 先标记停止请求，等待进程树退出和输出 drain，再冻结 stopped；失败保持 stopping。environment release 完成前若仍有实际附属执行，保持未停止；单纯结果 save 失败只报告 projectionError。
- [x] Terminal `get` 直接访问 provider Map；bundle 的 requireOwnedTerminal 与 daemon get 改用它。daemon 经同一个 agent-terminal-host bundle 提供 Jobs；不再复制 terminalSnapshot/wait/cancel。
- [x] 执行 `pnpm --filter @vykor/execution-node exec vitest run src/executions/__test__/detached-process-supervisor.test.ts` 和 `pnpm --filter @vykor/terminal-node exec vitest run src/providers/__test__/local-terminal-provider.test.ts src/host/__test__/agent-terminal-host.test.ts`；daemon Shell 定向测试也须通过。

## A4：daemon 只做适配，协议调用方一次切换

**修改文件：**

- `packages/server/src/application/daemon-application.ts`、`daemon/daemon-agent.ts`。
- `packages/server/src/application/agent/live-child-agent-directory.ts`、`daemon-agent-event-projector.ts` 及各自 `__test__`。
- `packages/server/src/application/session/transcript/session-execution-projector.ts` 及其 `__test__`。
- `packages/server/src/jobs/daemon-job-service.ts`、`job-snapshots.ts`、`child-activity.ts`、同目录测试和 README。
- `packages/execution-node/src/executions/runtime-owner.ts`、`types.ts`、`src/index.ts`、`__test__/runtime-owner.test.ts`。
- `packages/execution-node/src/executions/index.ts` 和 `__test__/legacy.test.ts`，删除旧 child 导出，保留仍有用途的显式进程 API 测试。
- `packages/agent-runtime/src/node/workflow/workflow-host.ts`、`node/capabilities/default-agent-capabilities.ts`，同步替换对旧 child registry 的停止接线；runner 的控制逻辑在 C1 收拢。
- `packages/server/src/application/agent/__test__/child-mode-recovery.integration.test.ts`、`projection-settlement-recovery.test.ts`，把旧 registry fixture 改为真实 child 或纯持久投影 fixture。
- `packages/tools/src/agent/agent-tools.ts`、`job/job-tools.ts` 与相关 `__test__`。
- `packages/client/src/commands/job-commands.ts`、`diagnostic-commands.ts`、`resources/runtime/job-resource.ts`、`transport/__test__/http-client.test.ts`。
- `apps/desktop/src/main/features/session/read-workflows.ts`、`session-service.ts`；`tests/server-client/http.test.ts`、`tests/client-public-api/` 的 Jobs 类型断言。
- 上述变更目录 README 和 `docs/{jobs-protocol,protocol-contract,client-sdk,agent-sdk,slash-commands}.md`。

**接口：**`CreateDaemonAgentContext.options` 使用 `DefaultNodeAgentOptions`，生产分支和测试/嵌入宿主分支都收到同一份 executionOwner、workflowHost 与端口。`DaemonJobService` 构造参数改为会话授权查询和 `getJobs(sessionId): AgentJobHost`；其直接方法不写 task 状态，也不自己 wait/stop。`LiveChildAgentDirectory` 暴露定点真实 handle 查找；授权仍在执行器调用前完成。

- [x] 写 daemon 验收失败测试：生产组装的同一 Shell 不被两个来源声明，child 连续三次 read 都返回实际结果，取消旧 run 不影响新 run，其他来源 list 故障不影响 Agent read/wait/cancel。
- [x] daemon 的 child 事件写入统一到 `DaemonAgentEventProjector`；`SessionExecutionProjector` 只保留 process track/sync 与既有持久核对，移除 createBridge、beginChildExecution、completeChildExecution 的 runtime 镜像调用。child.created 仍创建 durable session/task 并注册 LiveChildDirectory，关闭仍注销接线。
- [x] 删除 `ChildAgentExecutionRegistry` 及其专项测试；删除 `ExecutionRuntimeOwner.children/getChildAgentExecutionRegistry`、相关导出、runtime-only child process 类型。原 SessionTask 存储结构与旧 backend 元数据只保留读取，不保留旧运行入口。
- [x] 同时替换 WorkflowHost 和 default-agent-capabilities 的旧 registry stop 接线：直接使用已捕获 childId/runId 调 interruptRun。现有 runtime-owner、daemon continue-race、child-mode-recovery 和 projection-settlement 测试必须移除该 registry；不能把编译破损留给 C。删除 supervisor 注释中的旧归属说明。
- [x] `DaemonJobService` 删除 `createTerminalAgentHost/createDetachedProcessAgentHost` 的独立控制实现、runtimeFor、sendAdmitted 重开/回滚、stopWorkflowWorker 的 catch fallback 和独立 polling；改为授权后转发共同 host。job-snapshots 只做既有持久记录转换。
- [x] `JobList` 返回 errors；`JobRead/Wait/Send/Cancel` 接受完整 target；Agent send 返回接纳 receipt。`JobWait` 多目标改为 targets 数组和按 target 对应的 cursor，不保留 jobIds 参数。工具描述、schema 与回执同步更新。
- [x] `/jobs show <kind> <id> [runId]` 和 `/jobs cancel <kind> <id> [runId]` 定点调用；agent 必须给 runId。诊断命令显示 list.errors；Desktop Workflow 直接使用 snapshot.target，停止按钮携带已选中的 target，不能用 list 查归属。
- [x] 删除 `workflow:` 前缀双解析并统一原始 Workflow runId；更新客户端测试。协议 6 / Jobs 3 与所有调用方同阶段发布。
- [x] 通过 `rg -n 'CompositeAgentJobHost|LocalAgentJobHost|ChildAgentExecutionRegistry|getChildAgentExecutionRegistry|SessionChildExecutionBridge|childObservations|ownerByJobKey' packages apps tests` 检查运行代码与测试应无匹配。历史研究文档可保留旧名，现行手册必须描述新行为。

## A5：真实组装验收、阶段 A 删除门槛

**新增测试文件：**

- `tests/agent-integration/__test__/fixtures/task-lifecycle-fixture.ts`。
- `tests/agent-integration/__test__/shared-job-composition.integration.test.ts`。
- 更新 `tests/agent-integration/__test__/fixtures/README.md`、`tests/agent-integration/README.md`。
- `scripts/architecture-boundaries.test.mjs` 增加共同核心边界检查，禁止 server 再导入已退场的 child registry 或定义 Jobs 生命周期分支。

fixture 必须满足下面的接口，接口仅供测试，不进入 SDK 产品 API：

```ts
type AgentTarget = Extract<JobTarget, { kind: "agent" }>;
export interface LifecycleFixture {
  agent: DefaultNodeAgent;
  store?: SessionStore;
  spawn(prompt: string): Promise<{ handle: AgentChildHandle; target: AgentTarget }>;
  read(target: JobTarget): Promise<JobReadResult>;
  wait(target: JobTarget, timeoutMs?: number): Promise<JobWaitResult>;
  send(target: AgentTarget, text: string): Promise<JobInputReceipt>;
  cancel(target: JobTarget): Promise<JobSnapshot>;
  list(): Promise<JobListResult>;
  hold(label: string): void;
  entered(label: string): Promise<void>;
  release(label: string): void;
  restoreTerminalSave(): Promise<void>;
  close(): Promise<void>;
}
export function createLifecycleFixture(
  mode: "sdk" | "daemon",
  options?: { childBudget?: Partial<AgentChildBudget>; failTerminalSave?: boolean },
): Promise<LifecycleFixture>;
```

**fixture 实现步骤，必须与测试一起写，不能换成 fake handle：**

- [x] 建临时目录，daemon 模式新建真实 SessionStore、owner lease、session；实例化真实 DaemonApplication，让其真实 SessionRunExecutor 驱动 root run。SDK 模式直接创建真实 createDefaultNodeAgent。
- [x] 使用 `StreamingMessageClient` 受控实现，只替换网络。root 的每次脚本请求产生一次真实 Agent/JobRead/JobWait/JobSend/JobCancel/JobList tool_use；下一次 model 请求正常结束。普通 child 根据 prompt label 返回对应文本。`hold(label)` 的 child 改为调用真实 Read 工具读取测试目录里的标签文件：Read decorator 先兑现 entered，再等 release 门闩，随后调用真实 base.execute。由此阻塞的是实际工具 invocation，收到 abort 后也不会在门闩释放前完成；不能只阻塞一个 fake result Promise。
- [x] 通过现有 `toolDecorators` 包裹相应默认工具，只捕获 `await base.execute(input, context)` 的原始返回，仍完整执行真实工具。fixture 的 read/wait/send/cancel/list 都走 root 工具请求再用协议 decoder 解析捕获结果；不能单独 new host 作为测试对象。
- [x] spawn 从真实 Agent 工具返回解析 target，通过 `agent.children.get(target.jobId)` 取得真实 handle 并断言 sessionId/runId 与 receipt 一致。测试要多次访问实际 handle.result getter，不把它替换为稳定 Promise。
- [x] daemon 仅在工厂注入点添加离线 client，必须保留 loader 传来的完整 options；禁止 mock createDefaultNodeAgent 或使用 hosted echo kernel。核心创建语句固定为：

```ts
createAgent: async ({ options }) => {
  const node = await createDefaultNodeAgent({ ...options, client });
  return { agent: node, host: node.host };
}
```

- [x] 关闭顺序为释放所有测试门闩、等待真实任务结束、关闭 application/agent、关闭 store、删除测试目录。故障测试恢复保存端口后再关闭，不强行删除仍有归属的 run。

**阶段 A 必过用例：**

```ts
describe.each(["sdk", "daemon"] as const)("shared composition: %s", mode => {
  it("reads a real child result repeatedly and pins old-run cancellation", async () => {
    const f = await createLifecycleFixture(mode);
    try {
      const first = await f.spawn("first");
      await first.handle.waitRun(first.target.runId);
      for (let n = 0; n < 3; n++) {
        await first.handle.result;
        expect((await f.read(first.target)).text).toContain("first");
      }
      f.hold("second");
      const receipt = await f.send(first.target, "second");
      const second = { ...first.target, runId: receipt.runId };
      await f.entered("second");
      await f.cancel(first.target);
      expect((await f.read(second)).snapshot.status).toBe("running");
      f.release("second");
      expect((await f.wait(second)).snapshot.status).toBe("completed");
    } finally { await f.close(); }
  });
});
```

- [x] 为定点操作测试注入 TerminalProvider.list 的失败，只替换此低层读取函数，其他真实来源保留；fixture 的 Agent read/wait/cancel 仍成功，JobList 返回该来源错误和其他成功项。增加同一个真实 Shell 在 SDK/daemon 列表仅出现一次的断言。
- [x] 用原生进程 `node -e "process.stdout.write('shell-ok')"` 检查真实 Shell 输出与退出码；用现有本机 PTY provider 创建、读取并 kill Terminal；运行一份真实单步骤 Workflow。两种入口均执行，不能以 mock provider 算作执行器集成验收。
- [x] 执行 `pnpm exec vitest run --config tests/agent-integration/vitest.config.ts tests/agent-integration/__test__/shared-job-composition.integration.test.ts`；首次在基线真实组合处观察重复归属或结果丢失，阶段 A 完成后全部通过。
- [x] 执行 A1 到 A4 的定向测试、受影响包类型检查、`pnpm check:client-api`、`pnpm check-types:server-client`、`pnpm check:retired-ui`、`pnpm check-docs`、`git diff --check`。协议变化另跑 `pnpm test:server-client`。
- [x] 确认阶段 A 删除清单全部完成：Composite、LocalAgentJobHost、ChildAgentExecutionRegistry、child bridge、daemon 的 reopen/stop fallback/live snapshot 复制、Shell 两张 daemon 运行表、Terminal list 找指定 ID、workflow 前缀别名与所有 v5 请求入口。
- [x] 记录阶段 A 验收证据并形成阶段提交（a54f2821，审查与原始提交 hook 已通过）。此时 SDK/daemon 正常使用同一核心，仍沿用旧额度计数；不把 B 的改善宣称已交付。

## B1：单轮许可与真实停止屏障

执行边界补充：容量竞争/预期接纳拒绝在有效的真实根 run 的 `execution.children` 上探测，正常调用仍走真实工具；真实 Agent 工具拒绝仍覆盖其既有 S1 unknown 保护。Read 测试门闩保留真实读取与 ledger，仅由测试宿主标记这一明确无写副作用的 wrapper。首个准备 request 从身份分配起持有许可与 pending 结果通知；follow-up 的许可只跟实际停止，不因 started ACK 失败长期占用。新身份还需启动确认或实际环境撤销确认。

**修改文件：**

- `packages/agent-contracts/src/execution/execution.ts`、`children.ts`、`src/index.ts`。
- `packages/agent-runtime/src/kernel/framework-agent-run.ts`、`kernel/children/child-agent.ts`、`child-registry.ts`。
- `packages/core/src/engine/tools/checked-tool-execution.ts`、`__test__/checked-tool-execution.test.ts`、`__test__/query-tool-limits.test.ts`；复用 query-tool-limits.ts 的现有 invocation Promise，不改工具 unknown 写入策略。
- `packages/agent-runtime/src/node/children/__test__/child-agent.test.ts`。
- `packages/agent-runtime/src/node/runtime/__test__/framework-agent-run-input.test.ts`、`framework-agent-run-retry.test.ts`，同步必要的 run handle fixture。
- `packages/server/src/application/agent/live-child-agent-directory.ts`、`__test__/live-child-agent-directory.test.ts`、`application/session/execution/session-run-assembly.ts`，同步 interruptRun 的接纳与确认语义。
- 新建 `tests/agent-integration/__test__/child-run-settlement.integration.test.ts`，扩充真实 lifecycle fixture。

**接口：**使用方案 §3 的 `AgentRunSettlement` 和 `AgentRunHandle.settled`；只保留一份实际结果。`reserveIdentity(...)` 返回已有 reservation 的 commit/rollback/release 形状；`acquireRun(childSessionId, runId): { release(): void }` 在已有 Registry 内原子获取。AgentChildRunSnapshot 结构沿用 A2，无新增状态枚举。`AgentExecutionContext` 增加 `observeInvocation(settled: Promise<void>): void`，由真实 FrameworkAgentRun 接收；它仅追踪本轮已接纳调用的停止屏障。

- [x] 写连续执行、并发、取消未确认和启动回执失败测试，先在 A 结束版本记录失败。

```ts
it.each(["sdk", "daemon"] as const)("reuses identity without consuming 24 run permits: %s", async mode => {
  const f = await createLifecycleFixture(mode, { childBudget: { maxActiveChildren: 1 } });
  try {
    const first = await f.spawn("run-0");
    let target = first.target;
    for (let n = 0; n < 24; n++) {
      expect((await f.wait(target)).snapshot.status).toBe("completed");
      if (n < 23) {
        const receipt = await f.send(target, `run-${n + 1}`);
        target = { ...target, runId: receipt.runId };
      }
    }
    expect(first.handle.id).toBe(target.jobId);
    expect(first.handle.state).not.toBe("closed");
    const next = await f.spawn("another-identity");
    expect((await f.wait(next.target)).snapshot.status).toBe("completed");
  } finally { await f.close(); }
});
```

fixture 的同一轮返回标签文本，必须断言每轮文本都来自对应 label。另加 24 个新 child 的顺序用例，避免仅复用一个身份漏测旧的 8 个身份上限；total 仍应累计 24，达到 total=64 后第 65 个身份必须拒绝。

```ts
it.each(["sdk", "daemon"] as const)("holds a permit until the real invocation stops: %s", async mode => {
  const f = await createLifecycleFixture(mode, { childBudget: { maxActiveChildren: 1 } });
  try {
    f.hold("held-tool");
    const a = await f.spawn("held-tool");
    await f.entered("held-tool");
    expect((await f.cancel(a.target)).status).toBe("stopping");
    await expect(f.spawn("must-be-rejected")).rejects.toThrow();
    expect(a.handle.readRun(a.target.runId).result).toBeUndefined();
    f.release("held-tool");
    await a.handle.waitRun(a.target.runId);
    const b = await f.spawn("capacity-returned");
    expect((await f.wait(b.target)).snapshot.status).toBe("completed");
  } finally { await f.close(); }
});
```

- [x] 并发测试设置上限 8，阻塞 8 个真实 child；同时发起第 9、10 个申请，都应拒绝且实际进入模型/工具的 child 仍为 8。释放一个后仅允许一个新 run 接纳；同一 run 重复 settle 不得减成负数。另用上限 1 在两个已保留身份间竞争 send，只有一个获准。
- [x] 修改 Registry：身份保留只记录深度与 total；运行许可按 runId 占用，release 幂等且只释放自身。`activeChildren` 作为现有预算字段名保留，含义改为未确认停止的 child run 数；更新配置说明，不新增 activeRuns 别名字段。
- [x] 将 checked-tool-execution 传给 executeToolWithTimeout 的现有 observer 同时连接到 `execution.observeInvocation` 和原 operation observer；前者覆盖 SDK 无 toolSafety 的情况。FrameworkAgentRun 在现有本轮工具活动记录中保存未结束 invocation 的引用并在结束时删除，等待它们和附属清理后兑现 settled，再等待终态保存。工具 timeout/abort 的 race 不能兑现该屏障。result 为既有调用约定的派生入口，终态保存失败仍可拒绝；不能影响 settled 的实际 outcome。已有 completedResult/onSettled 分散写入收拢到此，不增加全局 invocation 或 settlement registry。
- [x] 修改 ChildManager：生成 runId 后先获取运行许可；在 submit 返回真实 handle 后立即把 handle 放进 requests，再等待 started。启动 ACK 抛错时停止这个已记录的 handle 并等 settled；没有真实 handle 时也要确认创建/环境撤销完成再回滚。不得在 catch 中直接 close/delete 后释放。
- [x] 完成、失败、deadline、取消都调用同一条以 run record 为参数的收尾函数。迟到回调必须核对 `record.currentRun === runRecord` 才能切换 child 的当前指针；旧记录可以完成自身结果/许可，不得动新轮。
- [x] 将 interruptRun 的 boolean 明确定义为停止请求是否接纳；原 run record 保存唯一 stop Promise，停止错误记在该记录诊断中。Jobs cancel 接纳后立即读回 stopping，不增加观察 timer；需要确认的 Workflow runner、close 和 daemon 等待型调用方继续 await waitRun。FrameworkAgentRun.active 和 ChildManager.currentRun 只在真实停止后解除，不能随 result 的错误提前解除。不得把停止动作错误写成 killed 或启动下一轮。
- [x] 运行 B1 新测试和既有 child/run 定向测试；SDK/daemon 两模式都通过前不交付 B。

## B2：终态保存失败补偿、迟到结果与阶段 B 退场

已发生的执行失败是原实际失败；模型暂时完成、真实 invocation/cleanup 尚未停止时收到的可信停止可以改变暂算成功。终态事件、child 快照和持久补偿使用同一输出/失败明细。清理失败保留 `cleanupUnconfirmed`；重复 cancel/close 只推进原资源清理，复用原等待者，不重新调用模型或工具。原 delivery error 的保存确认谓词只读取原 settlement 的 resolved 状态，不把启动/工具补偿当作接纳成功。阶段 B 的提交由主会话集中审查后单独执行，实现代理不提交。

**修改文件：**

- `packages/server/src/application/agent/daemon-agent-event-projector.ts`、相关测试。
- `packages/server/src/application/agent/projection-settlement-recovery.ts`、`__test__/projection-settlement-recovery.test.ts`。
- `packages/server/src/application/session/transcript/session-execution-projector.ts`、相关测试。
- `packages/agent-runtime/src/kernel/children/child-agent.ts` 及 `node/jobs/child-job-source.ts`。
- `tests/agent-integration/__test__/fixtures/task-lifecycle-fixture.ts`、`child-run-settlement.integration.test.ts`。
- `docs/{agent-lifecycle-contract,agent-child-session-flow,durable-execution-data-model}.md`、涉及目录 README。

**接口：**复用 `projectionError`、既有 projection settlement 的待补偿记录/重试入口与原事件 ID；无新持久队列或任务表。实际终态保存成功前保留原 run 的不可变结果，持久补偿不能调用 submitMessage、spawn 或工具。

**故障注入与明确断言：**

| 用例 | 注入位置 | 必须观察到的结果 |
| --- | --- | --- |
| started ACK 失败 | 真实 `run.started` 投影先接受事件再抛错；准备资源释放由门闩控制 | spawn 报错；真实 child handle 仍可在目录找到并为 stopping；上限 1 时另一个 child 被拒绝；资源清理确认后才能接纳 |
| 取消未确认 | 真实 child 正在运行一个受控工具，工具收到 abort 后仍等待测试释放；底层附属清理也由门闩确认 | cancel 接纳后返回 stopping；名额未释放；重复取消不重复收尾；释放后原轮终态出现且新 run 可启动 |
| 终态 save 失败 | 仅使同一 run 的终态 store 写入失败，模型/工具已停止，启动/工具写入成功 | live read 返回实际结果和 projectionError；下个 child 可启动；恢复 store 后补偿原 run，无第二次模型/工具调用 |
| 迟到结果与回调 | A 首次保存失败后阻塞其补偿回调；A 实际停止后启动 B，再释放 A 补偿回调；重复投递 A 终态事件 | B 不被改为 completed/failed，不释放 B 许可；A 结果可读且只保存一次 |
| 结果保留达到上限 | 完成并保存超过 256 个 follow-up；另测未保存记录占满 | 可淘汰旧已归档结果，点查走现有归档；未保存结果不丢弃，明确拒绝新增留存项；不是假 running |

- [x] 用以下核心断言实现保存失败用例。`failTerminalSave` 在 fixture 内只故障指定终态写入，不替换真实事件投影；恢复函数直接恢复原 store 方法并调用现有补偿入口。

```ts
const f = await createLifecycleFixture("daemon", {
  childBudget: { maxActiveChildren: 1 }, failTerminalSave: true,
});
try {
  const a = await f.spawn("saved-later");
  await a.handle.waitRun(a.target.runId);
  await vi.waitFor(() => expect(a.handle.readRun(a.target.runId).projectionError).toBeDefined());
  expect(a.handle.readRun(a.target.runId).result?.status).toBe("completed");
  const b = await f.spawn("next-run");
  expect(b.target.runId).not.toBe(a.target.runId);
  await f.restoreTerminalSave();
  expect(f.store!.runs.getRun(a.target.runId)?.status).toBe("completed");
} finally { await f.close(); }
```

必须追加 store 恢复后 `store.runs.getRun(a.target.runId)` 为 completed、输出相同且执行计数未增加的断言；fixture 暴露测试内定义的 `restoreTerminalSave(): Promise<void>`，实现只恢复被替换写入并调用原补偿方法，不另造 retry loop。

- [x] started ACK 与取消未确认用 deferred 屏障实现；不通过 fake timers 跳过真实清理，不用 catch 后忽略故障让测试通过。若核心现有引擎无法等待受控工具退出，先补齐该真实停止屏障，再更新名额规则。
- [x] started ACK 另覆盖“真实 run 已派发但回执丢失”：在 child-manager 定向测试的 createAgent 注入点调用真实 createDefaultNodeAgent，保留真实 submitMessage 返回的 run handle，只把对外 started Promise 改为原 started 兑现后、真实 Read 的 entered 门闩也兑现后抛出 `new Error("lost started acknowledgement")` 的派生 Promise；result、settled 和 child handle 均保持真实。必须先证明 Read 已进入，再使回执失败，以免只测到启动前撤销。Read 的 release 门闩继续阻塞实际停止，验证另一个 child 接纳被拒绝，释放后才恢复。此处替换的是故障回执，不能换成 fakeAgent/completedRun；A5 的 SDK/daemon 工厂验收仍完整执行。
- [x] 新增单元测试表格驱动 completed/failed/timeout/user_cancelled/parent_interrupted，共用同一收尾函数；重复终态和迟到事件不会重复 release 或覆盖新轮。超时只改变 failureKind，不复制收尾代码。
- [x] 将 child 终态投影改为纯保存共同核心 outcome。现有补偿目前只把 child.closed 放进 retry-terminal-projection；扩展同一分支到 run.completed/run.failed/run.interrupted，不再把这些事件走 compensate-child 改成失败。启动/工具持久失败仍沿用原保护。原 run 的 transcript/run 始终可补齐，更新 child task 摘要前须核对 `task.runId === event.context.runId`，不得把旧轮结果写进新轮摘要。S1 unknown 工具输入不重放。
- [x] 核对 `DaemonAgentEventProjector.apply` 的 recovered 返回分支：启动、输入、工具持久失败即使已保存失败补偿，也必须把原接纳失败传回执行核心，不能因“补偿记录已保存”而当作启动成功继续 dispatch。只有原终态保存已确实修复，才可把终态投递视为成功。增加与真实 started ACK 故障测试对应的回归断言。
- [x] Shell 保存失败使用同一既有 projection-settlement 表和 recovery 函数：沿用 action=retry-terminal-projection，projector 取 `process-terminal:<现有 execution.id>`，eventSequence 固定为本次不可变终态的 1，payload 保存 `{execution,durableTaskId,cause}`。recovery 先按 projector 分支识别该保存载荷，再执行已有 SessionTask 终态写入；不能伪造 AgentEvent，也不能启动进程。`recoverProjectionSettlements` 的原 Agent 分支仍处理真实事件；daemon 启动与进程投影重试入口覆盖这类已有记录。只扩展保存载荷，不新增表、ID 或调度服务。
- [x] 删除旧 `reserve()` 绑定 child.close 的 activeChildren 管理分支、残余 resultPromise 身份判断、启动 ACK 失败直接 deleteRecord 的路径。没有双方法兼容导出。
- [x] 执行 `pnpm exec vitest run --config tests/agent-integration/vitest.config.ts tests/agent-integration/__test__/child-run-settlement.integration.test.ts` 和 A5 真实组装回归；运行对应投影/child 定向测试及受影响类型检查。
- [x] 运行 `pnpm check:retired-ui`、`pnpm check-docs`、`git diff --check`，记录 B 阶段证据；阶段提交由主会话集中审查后执行，实现代理不提交。此阶段结束连续运行、并发、启动失败与取消/保存分离均可用，Workflow 尚待 C 删除多余控制。

## C1：Workflow 固定真实 child run，删除第二套控制

**修改文件：**

- `packages/agent-runtime/src/node/workflow/agent-workflow-runner.ts`、`workflow-host.ts`、`index.ts` 与目录 README。
- `packages/agent-runtime/src/node/children/child-agent-options.ts` 及 `__test__/child-agent-options.test.ts`。
- `packages/coordinator/src/workflow/task-runner.ts`、该目录 `__test__` 与 README，只修改与真实停止结果交接必要的部分，保留调度算法。
- `packages/agent-runtime/src/node/workflow/__test__/agent-workflow-runner.test.ts`、`workflow-host.test.ts`、`workflow-host.child-cancellation.test.ts`。
- `packages/agent-runtime/src/kernel/children/child-agent.ts` 安全 suspend 条件；`node/children/__test__/child-agent.test.ts`。
- 删除 `packages/agent-runtime/src/node/children/child-task-adapter.ts`，删除相应导出和仅测试 child→process 转换的断言。

**接口：**runner 的 worker receipt 保存已有 `childId + runId`；等待调用真实 handle.waitRun(runId)，取消调用 interruptRun(runId)。WorkflowHost 的取消不再传 taskId 后探测 backend；coordinator 继续拥有 attempt deadline、唯一停止宽限和 cleanupUnconfirmed 阻止重试规则。保留显式自定义 WorkflowRunner 扩展，不保留默认 runner 的隐式另一后端。

- [x] 先写查询失败不重建 worker、超时不重叠 retry、迟到结果只更新原 attempt 的测试。使用真实 worker receipt；不要把 child result 转换为 AwaitExecutionResult 再断言。
- [x] role 解析统一把 inherit 解析为父实际 model/provider/effort；创建环境前完成。单元测试覆盖普通 Agent、Workflow、system child，同一解析函数；显式模型仍受父授权上限约束。
- [x] runner 删除 `hasChildAgent -> else process`、`catch -> spawn replacement`、`stopTimedOutTask` 及重复等待 timer。给 coordinator 的 runnerResult 明确携带实际 failureKind、partialResult 与 cleanupUnconfirmed，不能把未知停止报成可重试失败。
- [x] WorkflowHost 默认 stop 直接固定 child run；删除 `stopTask` 的模糊 taskId fallback。持久元数据读取只定位旧归档，不能因此恢复执行或自动生成替代 worker。
- [x] 一次性 worker 完成后请求现有 suspend；要求没有 active run、steer 队列、审批、活动后代、附属后台工作和 cleanup。无法证明安全就沿用现有 TTL；不增加新的池/缓存。检查 old instance 的清理只作用于该实际实例引用。
- [x] 执行 `pnpm --filter @vykor/agent-runtime exec vitest run src/node/workflow/__test__ src/node/children/__test__/child-agent-options.test.ts src/node/children/__test__/child-agent.test.ts` 和 coordinator 对应 task-runner 测试。

## C2：最终真实 Workflow 验收与旧路径清零

**新增 / 修改文件：**

- 新建 `tests/agent-integration/__test__/workflow-child-lifecycle.integration.test.ts`；复用 task-lifecycle-fixture 的真实 SDK/daemon 模式，允许通过 root 的真实 Workflow 工具发起测试。
- `tests/workflow/lifecycle-scenarios.ts` 继续保留 memory/file repository 公共断言，补真实 worker receipt，不用它取代工厂验收。
- 更新 `docs/{agent-child-session-flow,coordinator-hard-scheduler-flow,agent-runtime-framework-architecture,daemon-application-architecture,architecture-migration-status,contract-test-index}.md`、`packages/{agent-runtime,execution-node,jobs,server}/README.md` 及相关目录 README。
- `scripts/architecture-boundaries.test.mjs`、`tests/agent-integration/README.md` 补边界和验收入口。

- [x] SDK 和 daemon 各运行 3 轮真实 Workflow，每轮 12 个顺序 child worker；默认额度 8 不得耗尽。测试固定总身份数 36，小于 64，不能通过放大预算绕过问题。
- [x] 真实 Workflow 的并发设为 8，worker 受控阻塞，统计实际进入执行的 child run 峰值；第 9 个接纳按核心限额拒绝，coordinator 不能为了补偿额度创建重复 worker。
- [x] 工作流取消及 deadline 测试：阻塞一个真实 worker 的清理，使其停止未确认；Workflow 保持 stopping，不能重试/显示完成；释放后结算原 worker。另测试旧 attempt 的迟到结果不覆盖新 attempt。
- [x] 验证 safe suspend 后同一身份 follow-up 恢复历史与工作目录；活动后代或未决审批存在时不提前卸载；授权快照和工具绑定不得扩大。
- [x] 执行 `pnpm exec vitest run --config tests/agent-integration/vitest.config.ts tests/agent-integration/__test__/shared-job-composition.integration.test.ts tests/agent-integration/__test__/child-run-settlement.integration.test.ts tests/agent-integration/__test__/workflow-child-lifecycle.integration.test.ts`。
- [x] 执行 `pnpm check-types`、`pnpm check:client-api`、`pnpm test:execution-integration`、`pnpm test:server-client` 和受影响四类执行器/Workflow 包的定向测试；只有新的失败或跨模块风险未解决时才扩大到完整测试套件。
- [x] 执行 `pnpm check:retired-ui`、`pnpm check-docs`、`git diff --check`；检查现行手册、imports、exports、README 与旧引用清单已同步。历史研究保留原事实，通过顶部链接指向新方案，不伪造旧源码行号为现状。
- [x] 做最终删除审计并记录证据：下表每项均需文件不存在或运行代码零引用，不能留未启用的实现。

| 阶段 | 必须退场的旧路径 | 替代入口 |
| --- | --- | --- |
| A | CompositeAgentJobHost、ownerByJobKey、resolve 时 list | RoutedAgentJobHost + JobTarget |
| A | LocalAgentJobHost、childObservations、shellRequests | 真实 child run / supervisor / 静态来源 |
| A | ChildAgentExecutionRegistry、owner.children 工厂和导出 | ChildManager + LiveChildDirectory 定点接线 |
| A | SessionChildExecutionBridge 的 register/begin/complete runtime 控制 | DaemonAgentEventProjector 保存核心事件 |
| A | DaemonJobService reopen / rollback / backend fallback / polling | 共同 host 与领域执行器 |
| A | BackgroundShellService.starting/environmentLeases | supervisor 现有启动表和 lease |
| A | Terminal 用 list 找指定 ID、daemon live snapshot 复制 | provider.get + 共同 Terminal bundle |
| A | v5 请求重载、workflow: 别名、全 host 生命周期覆盖 | 协议 6 / Jobs 3 与低层端口 |
| B | child.close 才释放 activeChildren、启动失败直接释放 | Registry 按 run 许可与 settled 屏障 |
| B | 以 Promise 相等判 run、保存失败改实际 outcome | runId + canonical requests + 现有补偿 |
| C | child-task-adapter、Workflow process fallback、catch 后 spawn | 真实 childId/runId 与 waitRun |
| C | runner 第二套 wait timeout / stopTimedOutTask 宽限 | coordinator 唯一 deadline / cleanup 策略 |

- [x] 由主会话审查后形成阶段 C 提交，并将方案状态改为“已实施”时附真实命令输出、测试数和版本。不能仅因计划条目勾完而宣称完成。

## 阶段检查命令与提交方式

在隔离工作区实施生产修改，遵守 using-git-worktrees 和现有仓库约定。用户已授权三个阶段，阶段 A 在既有隔离工作树完成。每个任务按“失败测试、最小实现、对应测试、删除审计、阶段证据”推进。

类型检查按阶段涉及包执行，例：

```powershell
pnpm --filter @vykor/jobs --filter @vykor/protocol --filter @vykor/agent-contracts --filter @vykor/agent-runtime --filter @vykor/execution-node --filter @vykor/terminal --filter @vykor/terminal-node --filter @vykor/server --filter @rzx/client --filter @vykor/tools check-types
pnpm check-types:server-client
pnpm check:retired-ui
pnpm check-docs
git diff --check
```

提交以已通过验收的阶段为边界，例如 `refactor: unify task ownership and direct job routing`、`fix: settle child run permits after confirmed stop`、`refactor: route workflows through the shared child core`。只 stage 本阶段文件，保存完整测试证据；不顺带提交其他存储、UI 或未完成改动。

## 计划自检结果与执行停止条件

本计划已逐项对应方案 §11：共同组装落 A2/A4，唯一归属与点查落 A1/A3/A5，身份/run/结果/额度分离落 A2/B1，停止和保存分离落 B1/B2，新旧替换落每阶段删除门槛，范围限制落全局约束。

实现时若出现下列情况，应先返回职责边界检查：需要第二个结果 Map 才能读完、需要 list 才能取消、需要 catch 后换执行器才能运行、需要新 Job 表才能结算、需要后台重放才能恢复、需要 flag 才能长期保留旧控制器。先修正来源绑定、run 记录、停止屏障和投影接口；不能直接增加兜底层。

计划初稿仅核对文档；后续用户已授权 A、B、C 生产实施。阶段 A 的验收使用真实默认工厂、daemon、child handle、SQLite、进程和原生 PTY，已取得独立输出；原调研的 39 个隔离测试仍只作为历史证据。B、C 已按各自门槛完成；最终真实生命周期三文件 66/66，四大门禁与文档/退役检查均通过。


## 阶段 C 的源码核对与计划修正

实际执行位置为 `C:/Users/ruanz/.codex/worktrees/shared-execution-core/openharness-ts`，分支 `codex/shared-execution-core`；主工作区的其他 Desktop/UI/plugin 工作未修改。A/B 提交如上，C 经主会话与独立审查后单独提交。

初始源码在 child 环境申请后才调用 resolveChild；仅替换 inherit 字符串不满足顺序。现改为 Node 预检并解析 model/provider/effort，Kernel 成功后才申请环境，仍使用原 lease 对象，创建实例时读取实际 cwd。现有配置只有容量查询与只读 reader，故沿既有 modelMetadata 接线增加窄 validateModelSelection 端口，复用 Server 的 validateRequestSelection；授权通过当前 settings/catalog reader 在初始、冷恢复和每轮实际配置准备时复查。没有新增目录、缓存或验证平台，SDK 自有 client 且无目录时保留显式自定义模型。

原 TTL 关闭父实例会关闭它的后代管理器。为保存后代身份，安全卸载保守要求没有任何保留后代，而不只是没有活动后代。startChain 内固定原 request/runId/实例，suspending 仅在槽实际执行时公布；同 tick 先 send 再旧轮 suspend 不循环等待。普通 child 保持 5 分钟 TTL，成功且已保存的一次性 worker 可请求立即卸载。

唯一 deadline/5 秒清理诊断宽限/retry 留在 coordinator。宽限不代表停止，等待原执行真实确认；查询故障先停止并等待原回执的实际结果屏障，再返回不可重试的查询失败。缺回执、缺 handle 或无法确认清理时禁止重试，保留 WorkflowHost 原 active 与 Jobs stopping；取消也不能用缺失回执伪造确认。重复取消只确认原 worker 清理，不更换 waiter 或重放模型。迟到旧 attempt 的进度与终态不覆盖新 attempt。

删除清单：阶段 A 的三份旧执行/Jobs 镜像文件与对应导出/专项测试已退场；C 删除 child-task-adapter.ts，旧 runner 的 spawnWorker/awaitTask/stopTask 注入、process 探测、catch-spawn、重复等待 timer 和 stopTimedOutTask 全部删除。显式完整 WorkflowRunner 扩展保留。历史研究保留原事实，并从顶部链接到新方案；现行手册更新为真实 childId/runId。

最终状态归属：FrameworkAgentRun 拥有实际调用与清理停止事实；ChildManager requests 拥有原 run 回执/结果/保存诊断，Registry 拥有身份和原子运行许可；supervisor/Terminal provider 各自拥有真实进程/PTY；WorkflowHost 拥有 live workflow 与取消，coordinator 拥有依赖/attempt/deadline/retry；daemon 只提供授权、环境、持久投影与格式转换。阶段 C 没有新增生产文件；全方案仅新增计划内四份路由/来源绑定文件。没有新增管理器、缓存、状态表或执行 ID；C 删除一份生产适配文件并缩减 runner，新增窄配置校验和安全卸载方法。

限制保持：SDK 无 archive 的旧轮在 256 条有界留存淘汰后返回 RUN_RESULT_NOT_RETAINED；未保存结果不能淘汰，满时拒绝接纳。S1 unknown 写入保护不放宽；没有跨进程自动追杀、模型/工具自动重放。保留后代的父实例继续保守驻留。


## 最终验证记录（2026-10-28）

运行环境：Windows，Node v24.10.0，pnpm 10.30.2。命令输出保存在隔离工作树 `.superpowers/sdd/2026-10-27-shared-execution-core/`；阶段 C 由主会话独立提交，并执行仓库原始类型检查 hook。

- `pnpm exec vitest run --config tests/agent-integration/vitest.config.ts tests/agent-integration/__test__/shared-job-composition.integration.test.ts tests/agent-integration/__test__/child-run-settlement.integration.test.ts tests/agent-integration/__test__/workflow-child-lifecycle.integration.test.ts`：3 文件 66/66（A7+B31+C28），242.86 秒，`stage-c-integration-accepted.log`。没有跳过的验收；原生 Windows PTY helper 有 AttachConsole 噪声，但实际退出断言通过。
- Runtime 定向：`pnpm --filter @vykor/agent-runtime exec vitest run src/node/workflow/__test__ src/node/children/__test__ src/node/jobs/__test__ src/node/agent/__test__/agent-post-run-child.test.ts src/node/runtime/__test__/default-runtime.test.ts`：16 文件 206/206，`stage-c-runtime-accepted.log`。审查尾部增加未知回执与真实 memory/file receipt 后，runner/host 两文件 26/26，`stage-c-review-tail-accepted.log`；实际取消、deadline、重复取消及查询清理两模式另复验 8/8，`stage-c-review-tail-integration.log`。
- `pnpm --filter @vykor/coordinator exec vitest run src/workflow/__test__`：30/30，`stage-c-coordinator-accepted.log`。
- Server 模型配置、loader、Jobs 与投影定向：5 文件 82/82，`stage-c-server-accepted.log`。
- 主会话独立运行 `pnpm check-types`：Turbo 72/72 成功，另 server-client TypeScript 成功，`stage-c-final-types.log`；`pnpm check:client-api`：73 条边界和 4 条公开 API 检查成功，`stage-c-client-final-guard.log`；`pnpm test:server-client`：124/124，`stage-c-final-server-client.log`；`pnpm test:execution-integration` 最终 4/4，真实 WSL Shell/PTY，无跳过，`stage-c-final-execution-confirmed.log`。初轮有平台预检跳过，补实测后不以该跳过作为验收。
- `node --test scripts/architecture-boundaries.test.mjs`：64/64，`stage-c-architecture.log`。
- `pnpm check-docs`：检查器 4/4，925 Markdown / 404 模块 README 通过；`pnpm check:retired-ui`：检查器 1/1，errors=[]，4559 文件、731 引用、90 移除。源码插入三行后，既有清单只更新原文完全相同的一项行号 1045→1048；未扩大批准范围。
- 最终删除审计：909 个生产 TypeScript 文件，18 项文件/符号/控制分支检查通过，`stage-c-deletion-audit.log`；全部 staged/unstaged `git diff HEAD --check` 通过。当前 adapter、process 回退、catch-spawn 和重复停止 timer 零运行引用。

完整失败/修正记录、审查处理与最终限制见本地 `stage-c-report.md`。最终代码经主会话及独立审查代理只读审查，三项生命周期问题及两个尾部分支均已修复并有实际回归证据。

## 2026-10-28 复核修正

复核基线为主仓库 `b714d3e702e4a719a671a33ec438f605abc9231f`。这次只修四项复核缺陷和验收自身的等待问题，不重做外部调研，也不改四类执行器的职责。

- `node/agent/agent-options.ts`、`agent-composition.ts`、`node/capabilities/default-agent-capabilities.ts` 与 daemon loader：Terminal / Shell 只传按实际会话绑定的端口工厂。child.created 已持久投影后，工厂读取原 child SessionRecord，再绑定 provider / admission。删除借用父会话端口值的旧形式，无兼容 union、开关、缓存或新管理器。
- `terminal-node/src/host/agent-terminal-host.ts`：列表和定点操作共用会话与 `source=agent` 判断。已知手动终端 ID 不代表 Agent 获得操作权，定点拒绝不需要 list。
- `coordinator/src/workflow/task-runner.ts`：正常返回和超时后迟到结果使用同一重试条件；`retryable=false` 或未确认清理都不建立下一次尝试。
- `node/workflow/workflow-host.ts`：顶层时限换算到既有 task.timeoutMs 并保存。有效期限为 `min(timeoutSeconds, task.timeoutSeconds ?? defaultTaskTimeoutSeconds)`；resume 保留或收紧原期限，coordinator 仍是唯一计时者。

新增回归先观察到原缺陷：daemon 子 Shell 存到父会话、不同 cwd 被拒绝、子 TerminalOpen 后 JobRead 找不到任务；手动终端可以被定点读取；超时后的不可重试结果建立第二个 attempt；顶层时限到期后 signal 仍未取消。修正后以真实默认工厂、DaemonApplication、实际 child handle、真实 Shell / PTY 和临时 SQLite 验证。

deadline 不稳定的确定性复现：在真实 child 的模型返回前暂停，推进原 200ms 时限，原 Read 从未派发，因此旧用例等待 Read 门闩永远不会结束。现在分别覆盖启动阶段到期，以及原 Read 已进入后推进同一期限/清理宽限；不增加生产 timer 或测试超时。

整体试跑又暴露两项批量验收的累计耗时：48 个 child run 附带 97 个完整根模型/存储 run，64 个身份附带 130 个。将重复观察和准入放进一个仍活跃的真实根工具范围，继续通过真实 controller 和原 handle 顺序执行，首尾保留外部 Agent/JobSend/JobWait 工具检查。真实 child 数量、默认额度和 60/120 秒限制不变；另增加逐轮 activeChildren=0 断言。定向 SDK/daemon 四项通过，daemon 两项约 20/32 秒。

生产改动没有新增文件、运行状态或执行 ID；减少父/子错绑和重试条件的分散判断。新增测试集中在各模块 __test__ 与跨包验收目录，原路径直接替换，执行核心继续只有一套。

### 复核后的验证记录

运行环境为 Windows、Node v24.18.1、pnpm 10.30.2。先保留真实红灯证据，再修正生产代码；首轮整体试跑的累计根运行超时不作为验收通过。修正夹具等待顺序、批量测试范围并冻结源码后，重新完整运行：

- 真实生命周期五文件：`shared-job-composition.integration.test.ts`、`child-run-settlement.integration.test.ts`、`workflow-child-lifecycle.integration.test.ts`、`child-native-execution.integration.test.ts`、`workflow-timeout.integration.test.ts`，同用 `tests/agent-integration/vitest.config.ts`；**79/79，5 文件，无跳过，613.21 秒**。日志位于本机临时目录 `openharness-review-acceptance.log`。SDK / daemon 均执行真实工厂与原 child handle，含实际 Shell、原生 PTY、SQLite、迟到结果、8/64 额度、启动回执失败、停止未确认和保存补偿。Windows node-pty helper 仍输出既有 AttachConsole 噪声，实际创建、读取、取消与退出断言通过。
- Runtime 定向六文件：78/78；coordinator 的 task-runner / scheduler：36/36；Server 的 loader / terminal：31/31；共同 Terminal bundle：13/13；Workflow 工具适配：4/4。未使用替身 child handle 绕过真实收尾。
- `pnpm check-types`：72/72 任务成功，server-client 类型检查成功；独立 `agent-runtime build` 和受影响包类型检查也通过。全仓日志为本机临时目录 `openharness-review-check-types.log`。
- `node --test scripts/architecture-boundaries.test.mjs`：64/64；`pnpm check:retired-ui` 与 `pnpm check-docs` 通过，旧路径批准清单未扩大。
- 独立只读复核未发现实质性代码缺陷。批量测试补回首尾外部 JobWait 的 completed 状态断言，复用同一次查询结果，不增加根运行次数；补强后的四项定向复验 4/4 通过，113.69 秒，未再次重复整组测试。

## 全需求复核后的环境与嵌套会话修正

基于 `1c55cd15`，合入远端既有 `d2279368` 的子代理预算反馈与结果交付改动，再修正完整复核确认的两个组合缺口。主工作区原有草稿保持原样，验证在独立工作区进行。

- 环境归属：`agent-options.ts` 将高层 `executionEnvironment` 替换为接收实际 sessionId、host cwd 和有效 settings 的异步工厂；`agent-composition.ts` 负责核对目录和每份租约仅释放一次，`child-agent-options.ts` 删除父 lease 借用覆盖。daemon loader 提供原有环境申请回调，删除提前申请、重复 once 包装及 catch-release。SDK 静态环境值不保留兼容分支；低层 runtime 的实际 handle 合同不变。
- 嵌套 Jobs：Kernel 只从已有 child record 读取实际 agent，Node host 提供同根树现存 session host 查询。daemon 复用原 live-child 根映射并直接返回实际 host.jobs，删除完整 warm 包装。既有继承视图同时用于子模型提交和默认 Jobs 发送，显式工具身份校验不放宽。关闭中的实际实例继续可观察和取消；新的输入在 Node host 单一入口拒绝。
- 终端控制目录：TerminalOpen 向宿主传可信 hostRoot，环境内 executionRoot 不再冒充宿主会话目录。
- 合并验收：远端两条 Server 测试沿用旧的默认开启假设，真实复现失败后改为显式开启既有 `blockOnUnknownToolOutcome`；默认关闭与普通权限另有实际 Shell 测试，命令改用跨平台 Node。生产默认策略未修改。

新增两份跨包回归文件，测试真实工厂、实际 child handle 和真实 Shell。分别复现并验证父环境错绑、HTTP 孙级任务取消失败、默认嵌套发送身份误拒绝，以及关闭期间误读归档。没有增加生产模块、状态表、执行 ID、缓存、补偿服务或新的生命周期管理器。唯一原有退役清单条目因删除 warm 包装平移 1048→1043，原文与批准范围不变。

验证记录（同一最终生产源码）：

- 两份新增真实回归：SDK / daemon 环境归属 2/2、嵌套 Jobs 5/5；环境归属与初始化回滚 10/10，daemon loader 27/27，Node 子管理与宿主装配 66/66。Terminal 控制目录适配 7/7。
- 七文件生命周期整组首次为 85/87，790.02 秒；两项 48 次顺序执行的总耗时超过 60 秒，期间同时进行全仓构建/类型/架构检查。其余额度、保存补偿、迟到结果、deadline、环境与嵌套用例均通过。其他检查结束后，只复验这两项：2/2，SDK 6.06 秒、daemon 14.36 秒，未修改源码、数量、断言或时限；日志为本机临时目录 `openharness-final-sequential-loops.log`。该首次整组失败没有记为整组通过。
- Server 全包首次 1942/1943、194 文件；唯一失败是项目重绑定测试中的局部宿主替身仍使用旧包装形状。补齐 `resolveSessionHost` 并保留原接纳阻塞/释放断言后，该文件 8/8。生产代码未为替身保留旧入口。
- 远端原有两项未知结果阻断测试先复现失败，再显式启用既有设置，相关两文件 10 项通过；默认策略四项测试仍覆盖默认关闭、显式关闭、显式开启和普通权限拒绝，4/4。
- `pnpm check-types` 72/72，另 server-client TypeScript 通过；`pnpm check:architecture`、`pnpm check-docs`、`pnpm check:retired-ui` 通过。标准架构检查的迁移包清单检查因本地未构建桌面/CLI 发布包而按原脚本跳过；本次没有修改发布包或迁移源。
- 独立只读复审覆盖最终生产 diff，包括环境释放、工具身份、权限上限、现有实例查询和关闭未确认路径，未发现新增阻挡项。完整 GitHub CI 在推送 main 后按该提交单独核对。

### 与最新主线 S1 简化的组合验收

提交收尾时远端 main 已推进到 `afbb3736`，其中删除了旧 S1 操作状态机。本分支合入该主线，保留删除结果，同时撤销前一轮测试中已过时的 `blockOnUnknownToolOutcome` 接线，不重新引入旧控制层。原工作区的未提交草稿没有被复制到本分支；同名 S1 文档沿用远端既有提交的内容。

- 真实目录映射暴露两个宿主/执行目录混用点。先分别观察到 `Tool scope changed before dispatch` 和 `Tool Run does not belong to the current session or is terminal`，再将共同工具派发入口的校验目录、内置 Agent 创建请求的目录改为现有环境的 `workspace.hostRoot`。工具仍收到自己的 `executionRoot`，没有新增目录字段或转换层。真实 DaemonApplication、默认 Node 工厂、内置 Agent 和原 child handle 验证父子两次派发；映射夹具不要求安装 WSL，不代表真实 WSL 进程验收。
- 独立安装包验收复现最新主线 CI 的服务注册超时：夹具默认协议为 6，候选 SDK 为 7。`verify-pack.mjs` 改从已安装 SDK 的公开常量传入版本，真实 tarball 安装、服务启动、NodeNext/Bundler 声明和浏览器打包全部通过；生产协议校验及时限不变。
- 完整架构门禁还发现原发行静态检查及空环境 smoke 写死协议 6。先用协议 7 的夹具复现拒绝，再同步这两个检查入口和对应 fixture；保持严格匹配，不接受多套协议。
- 最新主线新 owner 校验令架构计数从基线 103 变为 104。保留这项必要校验，将维护模块的活动任务读取改为既有 `store.runs.listSessionTasks`，与相邻运行读取归属一致；减少一次 SessionStore 转发调用，计数回到 103，例外仍为 0，基线未提高。
- 七文件生命周期整组为 87/88，445.37 秒；唯一失败是新增映射夹具在父子调用中复用了同一工具调用 ID，导致 SQLite 消息部分冲突。改为每次唯一的 `toolUseId`，并让创建步骤走真实内置 Agent；该文件最终 3/3，42.45 秒，包含 SDK/daemon 原生 Shell 两项和映射目录一项。其余六文件 85 项以及本文件原两项均在整组中通过，顺序执行、额度、ACK 失败、取消未确认、保存补偿和 deadline 均未修改断言、数量或时限；不将首次整组失败记为整组通过。
- 最终受影响 Server 六文件 31/31；Core 共同执行入口 30/30；Agent/Terminal 工具 31/31。新增目录边界改动及真实映射回归经独立只读复核，无新增阻挡项。
- 发行检查及 smoke 脚本回归 12/12；静态发行检查、旧 UI 退役检查和文档检查通过。迁移包目录检查仍按原规则报告本地未构建产物的跳过，不改为通过或扩大例外。

这一组合处理只替换现有入口中的目录来源、删除重复包装和迁移一个旧转发调用；没有新增生产模块、运行状态、执行 ID、缓存、重试层或生命周期管理器。

### 完整 CI 暴露的旧测试夹具收敛

`1510ab8c` 推送后的 CI `40669895197` 已通过构建、类型、独立安装包、架构和文档门禁，但全包测试失败。该失败不记为通过。按真实失败逐项复现后，后续修改仅涉及测试及夹具，未修改生产实现：

- 有效协议夹具统一读取既有公开 `CURRENT_PROTOCOL_VERSION`，服务进程夹具要求调用方显式传入协议，不再默认旧版本。旧版本、未来版本、畸形版本及缺失能力的拒绝断言继续保留。客户端服务 13/13、桌面相关 33/33、Server 中间件 9/9、前端同步 23/23；真实安装包再次通过。
- Runtime 三文件的旧断言按现行合同核对：已经调用却自报 `not_started` 仍是 unknown，串行后继不能启动；过期或淘汰结果不能改写插件数据。手写 child 宿主补齐唯一 Jobs 端口，缺陷不靠生产兼容分支处理。相同命令先 3 失败/43 通过，修正后 46/46。
- 备份夹具从当前库回退时删除仍存在的 `tool_result`，不再删除已被主线迁移移除的三张旧表；soak 请求使用当前协议。保留真实恢复、防覆盖及重启断言，相同命令先 3 失败/2 通过，修正后 5/5。
- 完整 server-client 首次为 120 通过/4 失败；唯一失败文件的手工 lifecycle 事件漏了真实执行器已有的 `generationId`，被跨轮保护拒绝。补齐夹具并增加旧轮事件拒绝和恢复前阶段确认；执行中恢复为 unknown、已完成保持 completed 的原断言不变。定向同命令先 4 失败/16 通过，修正后 20/20，不将首次整组失败记为整组通过。
- 主线另三份 Agent 集成 10/10；真实 WSL 执行集成 4/4，包含实际进程、取消、文件、后台 Shell、MCP 和 PTY；桌面跨模块写入集成 1/1。协议及断言修正经独立只读复核，没有放宽权限、取消、停止确认或未知结果规则。

`f1ed72c3` 的 CI `40673191618` 随后在架构门禁拒绝 soak 测试新增的 Protocol 导入：该测试发实际 HTTP 请求，却放在 daemon 分类。将同一测试迁到 `http/__test__/`，删除旧路径，同步目录说明及契约索引；没有添加边界例外、重复协议常量或新的测试包装器。新导入后漏跑本地架构门禁是本轮验证缺口，迁移后重新执行完整门禁。
