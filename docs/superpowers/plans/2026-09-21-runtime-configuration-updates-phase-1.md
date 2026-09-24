# 会话模型与推理强度热更新 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 默认在当前任务顺序执行，不要求创建新任务或派遣子 Agent。

**Goal:** 会话运行中允许修改模型、provider 与推理强度，在下一次模型请求使用新配置，保留任务与历史。

**Architecture:** SDK 内存存储与 daemon 会话存储实现同一个小型配置读写契约。agent-runtime 从目标配置生成完整请求配置，core 在请求边界捕获它，并将它用于压缩、提示词和 API 请求。沿用会话更新事件与错误反馈，不增加配置状态 UI。

**Tech Stack:** TypeScript、Node.js、pnpm、Vitest、现有 session metadata/事务/Agent 事件通道、React 桌面端。

**Spec:** [运行配置设计](../specs/2026-09-21-runtime-configuration-updates-design.md)

## Global Constraints

- 界面不增加“待生效”“已生效”等状态提示、徽标或成功通知。
- 当前模型请求及其发出的工具调用完成后，下一次模型请求使用新配置。
- 不主动中断正在输出的请求，不重放已经执行的工具。
- Native/WSL 等执行环境不在本次范围。
- 第一阶段保持现有全局默认与会话覆盖关系；不宣称已支持配置文件热更新、权限热更新、插件热插拔。
- 不新增数据库表，不引入配置框架或文件监听依赖；文件监听属于第二阶段。
- 只放开实际发生变化的 model/provider/baseUrl/apiFormat/effort；其他字段保留已有保护。
- 凭证不写入 session metadata、请求配置摘要或日志。
- core 不依赖 server、protocol 或 api；共享运行时类型放在 core，再由 agent-runtime 暴露。
- 同 provider 的路径先通过验证；任务 5 完成前不能宣称跨 provider 热切换可用。

## 实施次序与文件责任

| 任务 | 可独立验证的产物 | 核心位置 |
| --- | --- | --- |
| 1 | 配置快照、版本、校验、顺序更新 | core 类型、agent-runtime 配置存储、protocol |
| 2 | 同一长任务中按请求边界切换 | core QueryEngine、CompactService |
| 3 | SDK 热更新与子 Agent 继承 | agent-runtime 组装、Agent、child manager |
| 4 | 会话 API 保存、恢复、运行中读取 | server command/store/daemon loader |
| 5 | 跨 provider、上下文与历史兼容 | agent-runtime provider、api 适配器、能力解析 |
| 6 | 实际请求记录与无状态提示交互 | server 投影、client、desktop/TUI |

新增文件仅用于具体职责：`request-configuration.ts` 管目标配置，`request-configuration-resolver.ts` 管准备模型请求，`session-request-configuration-store.ts` 管会话持久化。不要拆成注册中心、通用事件总线或依赖注入框架。

## Task 1：目标配置契约、版本与原子更新

**Files:**

- Modify: `packages/core/src/types/runtime.ts`、`packages/core/src/index.ts`
- Create: `packages/agent-runtime/src/request-configuration.ts`
- Create: `packages/agent-runtime/src/request-configuration.test.ts`
- Modify: `packages/protocol/src/runtime-config.ts`、`packages/protocol/src/runtime-config.test.ts`

**Interfaces:**

在 core 定义并导出设计中的 `AgentRequestConfiguration`、`AgentRequestConfigurationPatch`、`AgentRequestConfigurationSnapshot`、`AgentRequestConfigurationStore`。在 agent-runtime 实现内存 store；通过 validate 回调接入宿主和模型能力校验。

```ts
function createMemoryRequestConfigurationStore(
  initial: AgentRequestConfiguration,
  validate: (
    next: AgentRequestConfiguration,
    patch: AgentRequestConfigurationPatch,
  ) => Promise<AgentRequestConfiguration>,
): AgentRequestConfigurationStore;

// protocol：只负责元数据字段与类型，不引入 provider SDK。
function readSessionRuntimeRevision(metadata: Record<string, unknown>): number;
function changedSessionRuntimeKeys(
  before: SessionRuntimeConfig,
  after: SessionRuntimeConfig,
): (keyof SessionRuntimeConfig)[];
```

- [ ] 在新测试文件中定义固定模型目录校验回调，先覆盖并发 patch、失败不提交、返回值与输入引用隔离、相同值不递增版本，以及有条件恢复。

```ts
it("merges concurrent patches and cannot roll back a newer selection", async () => {
  const store = createMemoryRequestConfigurationStore(
    { model: "a", effort: "low" }, async (next) => next,
  );
  const a = await store.read();
  const bWrite = store.update({ model: "b" });
  const cWrite = store.update({ effort: "high" });
  const [b, c] = await Promise.all([bWrite, cWrite]);
  expect(c.configuration).toEqual({ model: "b", effort: "high" });
  expect(c.revision).toBe(b.revision + 1);
  expect(await store.restoreIfCurrent(b.revision, a.configuration)).toBeUndefined();
  expect(await store.read()).toEqual(c);
});
```

- [ ] 运行 `pnpm --filter @vykor/agent-runtime exec vitest run src/request-configuration.test.ts`，确认新增测试因尚未提供目标行为失败。
- [ ] 使用每个 store 自己的 Promise 链串行更新；在队列内读取旧值、合并、await validate、比较实际差异、写入副本并递增 revision。队列错误不能阻塞下一次更新。`restoreIfCurrent` 也进入同一队列并重新校验 previous，条件不满足直接返回 undefined。

```ts
// 每个 store 独立持有 tail；成功与失败都释放后续写入。
let tail: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const result = tail.then(work, work);
  tail = result.then(() => undefined, () => undefined);
  return result;
}
```

- [ ] protocol 测试：缺失 runtimeRevision 返回 0；非法负数、非整数明确报错；相同字段值不进入 changed keys；空 effort 保持可清空语义。版本放 metadata.runtimeRevision，原 `readRuntimeMetadata` 仍拒绝未知 runtime 字段。
- [ ] 执行以上 store 测试及 `pnpm --filter @vykor/protocol exec vitest run src/runtime-config.test.ts`；结果通过后检查类型导出，不顺带修改其他 metadata 契约。

## Task 2：模型请求边界捕获完整配置

**Files:**

- Modify: `packages/core/src/types/runtime.ts`
- Modify: `packages/core/src/engine/query-engine.ts`
- Modify: `packages/core/src/engine/compact-service.ts`
- Modify: `packages/core/src/engine/index.test.ts`
- Create: `packages/core/src/engine/request-configuration.test.ts`
- Modify: `packages/core/src/engine/compact-service-advanced.test.ts`（沿用已有压缩测试）

**Interfaces:**

```ts
type QueryRequestConfiguration = {
  revision: number;
  model: string;
  provider?: string;
  effort?: string;
  reasoningEffort?: string;
  client: StreamingMessageClient;
  systemPrompt?: string;
  contextWindow?: number;
};

// QueryEngineOptions 新增；未提供时使用原有初始配置。
resolveRequestConfiguration?: (input: {
  signal?: AbortSignal;
  capabilityView?: RunCapabilityView;
}) => Promise<QueryRequestConfiguration>;

// CompactService 新增：校验为有限正数，仅更新上限，不清除历史。
setContextWindow(tokens: number): void;
```

- [ ] 新建一个可控制暂停的 fake stream 回归用例。使用现有 `ToolRegistry` 与允许执行的 mock checker/hook，定义 `Echo` 工具；第一次请求输出工具调用前暂停，修改目标，再释放流。断言旧请求参数未变、工具执行一次、第二次请求已变。

```ts
it("changes the next request without replaying a tool", async () => {
  const requests: StreamMessageParams[] = [];
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const firstStarted = new Promise<void>((r) => { started = r; });
  let selected = { revision: 0, model: "a", reasoningEffort: "low" };
  const client: StreamingMessageClient = {
    async *streamMessage(params) {
      requests.push(structuredClone({ ...params, abortSignal: undefined, tools: undefined }));
      if (requests.length === 1) {
        started();
        await held;
        yield { type: "tool_use_start", toolUse: {
          type: "tool_use", id: "echo-1", name: "Echo", input: {},
        } };
        yield { type: "complete", stopReason: "tool_use" };
      } else {
        yield { type: "text_delta", delta: "done" };
        yield { type: "complete", stopReason: "end_turn" };
      }
    },
  };
  const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
  const registry = new ToolRegistry();
  registry.register({ name: "Echo", description: "echo", inputSchema: {}, execute });
  const engine = new QueryEngine(client, registry,
    { checkTool: async () => ({ action: "allow" }) } as IPermissionChecker,
    { execute: async () => ({ blocked: false }) } as IHookExecutor,
    { resolveRequestConfiguration: async () => ({ ...selected, client }) });
  const running = (async () => { for await (const _ of engine.submitMessage("go")) {} })();
  await firstStarted;
  selected = { revision: 1, model: "b", reasoningEffort: "high" };
  release();
  await running;
  expect(requests.map(({ model, reasoningEffort }) => [model, reasoningEffort]))
    .toEqual([["a", "low"], ["b", "high"]]);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(requests[1]!.messages.some((m) => m.type === "tool_result")).toBe(true);
});
```

- [ ] 执行 `pnpm --filter @vykor/core exec vitest run src/engine/request-configuration.test.ts`，确认失败指向请求仍然使用旧配置。
- [ ] 将配置读取放到每次请求迭代的自动压缩前；同一迭代捕获 `const request = await ...`，压缩客户端、阈值、prompt 与 `request.client.streamMessage` 使用该快照。循环外的 memory 检索不重复执行；将已有 memory、contribution、trajectory guidance 合并到当前配置生成的基础 prompt 上。
- [ ] 首次 `prepareUserContent` 也用第一次捕获的 client，不能先用旧 client 处理附件再切换；捕获的首次快照直接用于首轮，不做两次独立读取。摘要请求结束期间收到更新留给下一迭代。
- [ ] 通过 `execution.emit` 在请求开始前发送 `domain.event`，name 为 `request.configuration`，payload 只含 revision/model/provider/effort。事件失败遵循现有有序输出失败策略，不创建另一条绕过存储的旁路。
- [ ] 补测流式期间连续更新、工具执行期间更新、最终回答后更新、空 effort 清除、压缩期间更新、取消期间不启动新请求。较小 contextWindow 更新压缩阈值，配置不变时不重复重建 client。
- [ ] 运行 core 请求配置、已有 engine 和 compact 三组相关测试；通过后停止扩大测试范围。

## Task 3：agent-runtime 公共 API、强度解析与子 Agent

**Files:**

- Create: `packages/agent-runtime/src/request-configuration-resolver.ts`
- Create: `packages/agent-runtime/src/request-configuration-resolver.test.ts`
- Modify: `packages/agent-runtime/src/agent-options.ts`、`agent.ts`、`agent-composition.ts`
- Modify: `packages/agent-runtime/src/default-runtime.ts`、`default-runtime-provider.ts`
- Modify: `packages/agent-runtime/src/default-agent-capabilities.ts`、`child-agent.ts`、`child-agent-options.ts`
- Modify: `packages/agent-runtime/src/kernel.ts`、`kernel-entry.ts`、`index.ts`
- Modify: `packages/agent-runtime/src/agent.test.ts`、`child-agent-options.test.ts`、`child-agent.test.ts`、`kernel.test.ts`、`public-surface.test.ts`

**Interfaces:**

```ts
// VykorAgent 新增；完成意味着配置已经通过校验并被接受。
updateConfiguration(patch: AgentRequestConfigurationPatch): Promise<AgentRequestConfigurationSnapshot>;

// VykorAgentOptions 的宿主扩展：默认创建内存 store。
requestConfigurationStore?: AgentRequestConfigurationReader;

// 将 provider/目录校验注入 SDK 内存 store 与 daemon store。
type ValidateRequestConfiguration = (
  next: AgentRequestConfiguration,
  patch: AgentRequestConfigurationPatch,
) => Promise<AgentRequestConfiguration>;

function createRequestConfigurationValidator(input: {
  resolveCapabilities: (selection: AgentRequestConfiguration) => Promise<{
    modelAvailable: boolean;
    reasoningEfforts: readonly string[];
  }>;
}): ValidateRequestConfiguration;
```

- [ ] 用 Task 2 的受控流模式写 SDK 用例：`agent.submitMessage` 尚未完成时 await `agent.updateConfiguration({ effort: "high" })` 可以返回，run ID、历史、terminal/MCP 实例保持不变；下一次请求收到 high。创建时使用 `client` 注入 fake，关闭网络与插件依赖。
- [ ] 对 resolver 编写行为表，显式非法值必须报错，隐式继承的不兼容 effort 必须清空：

```ts
const cases = [
  { next: { model: "a", effort: "high" }, patch: { effort: "high" }, supported: ["low", "high"], expected: "high" },
  { next: { model: "b", effort: "high" }, patch: { model: "b" }, supported: ["low"], expected: undefined },
  { next: { model: "b", effort: "high" }, patch: { effort: "high" }, supported: ["low"], error: true },
  { next: { model: "a", effort: "" }, patch: { effort: "" }, supported: ["low", "high"], expected: undefined },
];
```

- [ ] 在 `request-configuration-resolver.ts` 实现 `createRequestConfigurationValidator`：从现有 provider/catalog 能力取得合法模型和强度，按上述表处理；宿主自定义 client 通过明确的能力回调校验，未知目录不冒充不支持。把 daemon 当前创建时 effort 转换迁到共享 resolver，消除创建与更新两套转换。
- [ ] runtime 组装一次 store 与 resolver，将 Task 2 的 callback 接入 QueryEngine。prompt 生成函数显式接收本次 effort；保留 systemPromptForRun 的技能/agent 摘要和原权限上限，不因模型更新重新发现插件。
- [ ] 独立 SDK Agent 的 `updateConfiguration` 在 idle/running/maintaining 接受配置，在 closing/closed 拒绝。`setModel` 保持同步 idle 约束，并同步内存目标。daemon Agent 的两个直接修改入口都明确拒绝，调用方通过会话命令更新；run executor 不再使用 `setModel`。
- [ ] 将子 Agent 派生输入改为读取父 Agent 已应用配置；`getAppliedRequestConfiguration(): AgentRequestConfigurationSnapshot` 作为运行时内部 getter。父 Agent 更新未应用时创建的子任务沿用旧值；应用后新建子任务用新值；已有 child 不被遍历改写。子任务显式覆盖后重新校验 effort。
- [ ] 新增宿主按 child sessionId 提供读取器的工厂选项 `requestConfigurationStoreForSession?: (sessionId: string) => AgentRequestConfigurationReader | undefined`；child 创建时取得自己的读取器，不继承父读取器。child.created 事件携带父 Agent 已应用的选择；server 据此创建子会话，再供读取器使用。事件失败终止 child 创建。
- [ ] 注册表/模型/强度变更不涉及 terminal、sandbox 或 executionEnvironment 资源重建。只在核心 API 与默认 runtime 所需位置接线，公开类型经 index/kernel-entry 一致导出。
- [ ] 执行 `pnpm --filter @vykor/agent-runtime exec vitest run src/request-configuration.test.ts src/request-configuration-resolver.test.ts src/agent.test.ts src/child-agent-options.test.ts src/child-agent.test.ts src/kernel.test.ts src/public-surface.test.ts`。

## Task 4：daemon 会话存储与运行中修改接口

**Files:**

- Create: `packages/server/src/application/session/session-request-configuration-store.ts`
- Create: `packages/server/src/application/session/__test__/session-request-configuration-store.test.ts`
- Modify: `packages/server/src/application/session/session-command-service.ts`
- Modify: `packages/server/src/application/session/__test__/session-command-service.test.ts`
- Modify: `packages/server/src/daemon/daemon-agent.ts`、`packages/server/src/daemon/__test__/daemon-agent.test.ts`
- Modify: `packages/server/src/application/daemon-application.ts`
- Modify: `packages/server/src/application/session/session-run-executor.ts`、`packages/server/src/application/session/__test__/session-run-executor.test.ts`
- Modify: `packages/server/src/application/agent/__test__/agent-pool.test.ts`

**Interfaces:**

`createSessionRequestConfigurationStore(sessionId, dependencies)` 返回 Task 1 store 契约。dependencies 显式传入 sessions、transactions、配置 validator、events、生命周期检查；不直接依赖整个 DaemonApplication。针对同一个 session 返回同一队列的适配器，删除 session 后释放队列。

- [ ] 替换当前测试“rejects runtime config update when session has active work”：只改 model/effort 成功，不调用 closeAgent、不获取要求空闲的 barrier；其他字段仍被保护。

```ts
it("accepts request configuration while a run is active", async () => {
  const { service, runtimeControl } = createService({ hasWork: true });
  const updated = await service.updateSession("s1", {
    metadata: { runtime: { model: "another-model", effort: "high" } },
  });
  expect(updated.metadata.runtime).toMatchObject({ model: "another-model", effort: "high" });
  expect(runtimeControl.closeAgent).not.toHaveBeenCalled();
});
```

- [ ] 在 createService fixture 中接入共享 store/validator；用真实 mutable session fixture 覆盖两个并发 patch，不能继续让 getSession 永远返回旧常量。执行 command/store 测试确认新增行为尚未满足。
- [ ] 更新操作在同一 session 队列内读最新 session、计算实际 diff、校验。纯请求字段修改走 store；混合其他运行字段保留 barrier 后整体事务写入。title 等普通字段照常处理。会话 closing/archived/deleted 的检查不依赖 Agent 是否驻留。
- [ ] 将规范化的 runtime、session.model、runtimeRevision 在一次事务中写入；事务成功后发布现有 session 事件。保存目标时不创建 model_switch 分割线。失败不改版本与选择。
- [ ] loader 注入每会话 store；run executor 移除从早期 session 快照调用 `agent.setModel` 的操作。已有池中 Agent 在下一边界读 store；cold Agent 创建时直接读最新配置，不能先用旧 metadata 构造客户端再覆盖。
- [ ] 活跃 child 使用 Task 3 工厂所取得的 child store，HTTP 更新仅写对应持久记录；不调用 AgentPool.acquireSession 去创建另一个 Agent。父会话仅改请求参数时不再因 hasLiveChild 拒绝。
- [ ] 失败恢复按 Task 1 的 revision 条件检查写回，并发布现有 session 更新；已有更高版本时不恢复。每次失败 revision 仅产生一条脱敏错误。保存成功但进程在下一请求前退出，重启直接读取保存选择。
- [ ] 执行相关 server command/store/loader/executor/pool 测试和对应 HTTP 会话修改用例，验证 lifecycle barrier 对 archive/delete/角色变更仍有效。

## Task 5：跨 provider 切换、历史和上下文

**Files:**

- Modify: `packages/agent-runtime/src/request-configuration-resolver.ts`、对应测试
- Modify: `packages/agent-runtime/src/default-runtime-provider.ts`、对应测试
- Modify: `packages/api/src/providers/openai.ts`、`anthropic.ts` 及对应测试
- Inspect/Modify: `packages/api/src` 中 Codex 适配器的实际请求与历史转换入口（先用下方命令定位）
- Modify: `packages/server/src/application/assemble-session-context-usage.ts`
- Modify: `packages/server/src/application/resolve-model-context-limits.test.ts`
- Modify: `packages/core/src/engine/request-configuration.test.ts`、`compact-service-advanced.test.ts`

**Interfaces:**

resolver 返回 Task 2 的完整 `QueryRequestConfiguration`。复用已有 `resolveApiClient` 与 `resolveSessionModelContextLimits` 所依据的模型目录数据；把必要的 provider/model 限制查询向 agent-runtime 注入，不能让它 import server。

- [ ] `rg -n "class CodexSubscriptionClient|convertMessages|reasoningReplay|reasoningEffort" packages/api/src` 定位并读取 Codex 转换路径，沿用现有协议适配测试 fixture。只修改目标切换实际影响的转换分支。
- [ ] 用两个独立 fake client 验证请求路由，而不是只 spy setter：A 的流未结束时更新 provider=B；第一请求仍发 A，工具结果后第二请求只发 B；相同 model ID 不同 provider 也切换 client。

```ts
// 在请求捕获断言中检查整组参数，不能只检查 model。
expect(calls.map((c) => [c.provider, c.model, c.effort]))
  .toEqual([["provider-a", "shared-id", "low"], ["provider-b", "shared-id", "high"]]);
expect(toolExecutions).toBe(1);
expect(historyBefore.every((message) => persistedHistory.includes(message))).toBe(true);
```

- [ ] provider/baseUrl/apiFormat/model 作为一次完整解析；更换 provider 不继承不适用的旧地址。准备结果在边界一次捕获，旧流仍使用旧 client。相同连接参数只变 effort 复用 client。
- [ ] 测试客户端构造/能力预检失败触发有条件恢复，较旧失败不覆盖新选择。通过既有 `domain.event` 发出脱敏的 `request.configuration.failed`，宿主映射到既有错误出口；不输出配置状态。首次创建无旧可用配置时直接失败。恢复完整替换请求字段，不能残留失败配置的地址/强度。实际 API 发出后的失败遵循已有请求错误处理，不自动改模型重发。取消时丢弃准备结果，关闭期间不启动请求。
- [ ] 加入跨 OpenAI-compatible/Anthropic/Codex 的结构化历史 fixture：普通文本、tool_use/tool_result、reasoning 来源和图片；保留存储原始内容，发送时按目标适配。模型专属推理字段不盲传；目标不能处理历史附件时请求前明确失败。
- [ ] 目录与 adapter 共同决定 effort 是否可发。当前 Anthropic 适配器未把 reasoningEffort 写入请求，不能把目录显示支持当作实际已支持；本阶段不顺带新增完整 Anthropic thinking 功能，校验层应如实处理能力。
- [ ] 在 fake 大模型→小模型切换中验证 compact 使用新 contextWindow 和新 client；有未配对工具结果时不跨配对压缩。压缩失败且内容仍超限制，明确失败；不把 UI cache invalidate 当作容量适配实现。
- [ ] 执行 provider 转换、resolver、请求边界、context limits 和 compact 的定向测试。通过前跨 provider 更新保留明确拒绝，完成后移除该临时限制并补一条真实 server→runtime fake-provider 集成测试。

## Task 6：请求记录、界面一致性与集成验收

**Files:**

- Modify: `packages/server/src/application/agent/daemon-agent-event-projector.ts`、对应测试
- Modify: `packages/server/src/application/session/transcript-projection.ts`、对应测试
- Modify: `packages/client/src/state/reducer.ts`（如现有事件排序不能保护配置版本）及现有 reducer 测试
- Modify: `apps/desktop/src/main/features/session/session-operations.ts`、对应现有 session-service 测试
- Modify: `apps/desktop/src/renderer/src/stores/desktop-session/session-actions.ts`、对应测试
- Inspect/Modify: `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/composer.tsx`
- Inspect/Modify: `apps/frontend/src/hooks/sessionController.ts`、`sessionSlashCommands.ts`
- Modify: `docs/agent-lifecycle-contract.md`、`docs/contract-test-index.md`

**Interfaces:**

消费 Task 2 的 `request.configuration` 内部事件；不新增面向用户的配置状态协议。ActiveTranscriptProjectionState 增加当前实际请求配置摘要，创建 assistant message 时将摘要写入 message.metadata；不得从 session.model 反推实际模型。

- [ ] 投影测试：先收到 A 的请求配置和部分输出，session 选择已变成 B，A 剩余输出仍记录 A；下一次请求配置 B 到达后，写入一次已有 model_switch presentation，再记录 B 输出。
- [ ] 只改 effort 不创建 model_switch；相同 revision 重投不重复生成记录；恢复历史按最后实际使用记录比较，不凭目标选择虚构已经发生的切换。保持 presentation 不进入模型上下文的既有规则。
- [ ] desktop action 测试两个异步更新响应逆序完成，较早响应不能覆盖较新选择；活跃会话切换后迟到响应只能更新对应 session，不能改变另一个会话选择器。

```ts
// 复用 session-actions.test.ts 已有 store 与 window.desktop fixture。
const older = store.getState().updateSessionModel("s1", modelB);
const newer = store.getState().updateSessionModel("s1", modelC);
resolveC(sessionC);
await newer;
resolveB(sessionB);
await older;
expect(store.getState().selectedModel).toBe(modelC.id);
```

- [ ] 将按 session 的操作序号与服务端 runtimeRevision 一起用于接收结果；选择器直接显示最新已接受选择，不新增待生效/已生效 UI。失败回到服务端最新记录，不能恢复本地捕获但已经过时的旧值。现有 model_switch 组件继续复用。
- [ ] TUI/CLI 现有会话配置路径使用相同服务端契约，删除只针对模型/强度的运行中前端拦截；不扩大到权限/角色。没有相应交互入口的产品面不在本阶段新增完整设置页。
- [ ] 新增一条 server 集成用例串起 active run、会话 patch、一次工具执行、第二次请求、实际请求记录与会话恢复；一条 child 用例覆盖父修改、新 child 继承和已有 child 继续运行。使用 fake stream，不使用真实模型或付费请求。
- [ ] 更新生命周期文档与测试映射，明确异步 updateConfiguration 的运行中契约、旧同步 setModel 的边界、纯请求字段不重启，以及环境设置排除范围。

## 完成前验证

- [ ] 在相关包运行前述定向测试，失败时定位具体差异，修改后仅重跑受影响组。
- [ ] 执行受影响包类型检查：

```powershell
pnpm --filter @vykor/core --filter @vykor/protocol --filter @vykor/agent-runtime --filter @vykor/api --filter @vykor/server --filter @vykor/client --filter @vykor/frontend check-types
pnpm --filter @vykor/desktop typecheck
```

- [ ] 公共 SDK/客户端接口变化执行 `pnpm check:client-api`；agent-runtime 导出/build 变化执行 `pnpm --filter @vykor/agent-runtime test:pack`。将真实失败与环境限制分别记录，不宣称未运行的检查已通过。
- [ ] 执行 `pnpm check-docs`，检查新增文档链接和生命周期测试映射。
- [ ] 人工验收：长任务工具执行期间切模型/强度；快速连续选择；模型无效或配置失败；关闭重开会话；有活跃子任务时修改父会话。确认没有新增生效状态提示，没有环境切换行为变化。
- [ ] `git diff --check`，核对修改文件全部属于本阶段；按用户当前分支/提交约定组织提交，不为本计划强制新建任务或自动发布。

第一阶段完成后，依据设计文档第二阶段要求编写配置文件同步计划。MCP/插件热插拔保留独立验收与实施计划，不能以第一阶段通过替代其完成证据。
