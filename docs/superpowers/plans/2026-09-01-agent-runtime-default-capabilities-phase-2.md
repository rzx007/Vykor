# Agent Runtime 默认能力阶段二实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在阶段一的新装配 API 上收口 Memory、Workflow、compact、Attachments 与子 Agent 契约，使同一份状态不会被重复创建或在 Host 接线时遗漏。

**架构：** Memory 继续使用现有 `AgentMemoryRuntime`，只由 agent-runtime 创建并允许显式关闭；Workflow 工具与 Jobs 共用一份 Repository；compact 直接组合附件目录和 Session Memory 两个 provider；Attachments 没有真实 Host 时明确 unavailable；Host overrides 被定义为整个 root session tree 可用的借用对象。

**技术栈：** TypeScript、Vitest、现有 `@vykor/core` compact service、`@vykor/agent-runtime` Memory、`@vykor/coordinator` Workflow、`@vykor/server` session/attachment services。

---

## 前置条件

开始前确认阶段一已经合入当前分支：

```bash
rg -n "hostCapabilities|AgentHostCapabilities" packages apps -g "*.ts"
```

预期：无匹配。若仍有匹配，先完成阶段一，不能在本计划中同时维护两套 API。

## 文件结构

### 新建

- `packages/agent-runtime/src/compact-context.ts`：直接组合 attachment catalog 与 Session Memory provider。
- `packages/agent-runtime/src/compact-context.test.ts`：两个来源独立缺省、同时存在和单方失败的测试。

### 修改

- `packages/tools/src/job/local-job-host.ts`：显式接收 `WorkflowRunRepository | undefined`，不自行创建 Repository。
- `packages/tools/src/job/local-job-host.test.ts`：同一 Repository、关闭 Workflow 和 Job 路由测试。
- `packages/agent-runtime/src/agent-composition.ts`：Memory/Workflow/Attachments 解析和 compact 接线。
- `packages/agent-runtime/src/agent.ts`：重命名 compact provider API，公开能力诊断。
- `packages/agent-runtime/src/memory-runtime.ts`、`packages/agent-runtime/src/remember-tool.ts`：只做新装配所需的最小签名调整，不改变 Markdown schema。
- `packages/agent-runtime/src/memory-runtime.test.ts`、`packages/agent-runtime/src/remember-tool.test.ts`、`packages/agent-runtime/src/sdk.test.ts`：Memory 默认、关闭和受管路径回归。
- `packages/core/src/engine/compact-service.ts`：`CompactAttachments`/provider 改名为 `CompactContext`/provider。
- `packages/core/src/engine/query-engine.ts`：setter 改名并保持单一 provider。
- `packages/core/src/types/runtime.ts`、`packages/core/src/index.ts`：导出新名称，删除旧名称。
- `packages/core/src/engine/compact-service-advanced.test.ts`、`packages/core/src/agent-session.test.ts`：compact 类型和提示词回归。
- `packages/server/src/application/agent/agent-pool.ts`：分别接收 attachment catalog 与 Session Memory provider。
- `packages/server/src/application/agent/__test__/agent-pool.test.ts`：验证两个来源被组合且不互相覆盖。
- `packages/server/src/application/daemon-application.ts`：把现有两个读取函数分别注入 AgentPool。
- `packages/server/src/application/__test__/durable-agent-application.test.ts`：验证实际 compact 内容。
- `packages/server/src/daemon/daemon-agent.ts`：附件 override、root mount 和新 compact 参数。
- `packages/agent-runtime/src/child-agent.ts`、`packages/agent-runtime/src/child-agent.test.ts`：session tree override 借用契约。

## 任务 1：让 Workflow 工具和 Jobs 共用 Repository

**文件：**

- 修改：`packages/tools/src/job/local-job-host.ts`
- 修改：`packages/tools/src/job/local-job-host.test.ts`
- 修改：`packages/agent-runtime/src/agent-composition.ts`
- 修改：`packages/agent-runtime/src/sdk.test.ts`

- [ ] **步骤 1：先写注入 Repository 的失败测试**

把测试中的构造方式改成目标 API，并验证外部写入的 Workflow 能被同一个 Job Host 读取：

```ts
const workflows = new FileWorkflowRunRepository({ cwd });
const host = new LocalAgentJobHost({
  cwd,
  sessionId: "session-1",
  childManager: directory(),
  workflowRepository: workflows,
});
workflows.save(createWorkflowRunSnapshot({ runId: "workflow-1", ownerSession: "session-1" }));
expect(await host.read({ sessionId: "session-1", jobId: "workflow-1" }))
  .toMatchObject({ snapshot: { id: "workflow-1", kind: "workflow" } });
```

- [ ] **步骤 2：写关闭 Workflow 的失败测试**

```ts
const host = new LocalAgentJobHost({
  cwd,
  sessionId: "session-1",
  childManager: directory(),
  workflowRepository: undefined,
});
await expect(host.read({ sessionId: "session-1", jobId: "workflow-1" }))
  .rejects.toThrow("Job not found: workflow-1");
```

同时验证 `list()` 不扫描 cwd 中已经存在的 Workflow 文件。

- [ ] **步骤 3：运行 LocalAgentJobHost 测试确认失败**

```bash
pnpm --filter @vykor/tools exec vitest run src/job/local-job-host.test.ts
```

预期：FAIL，构造函数仍要求三个位置参数并自行创建 Repository。

- [ ] **步骤 4：实现显式构造参数**

```ts
export interface LocalAgentJobHostOptions {
  cwd: string;
  sessionId: string;
  childManager: AgentChildDirectory;
  workflowRepository?: WorkflowRunRepository;
}
```

将内部 `FileWorkflowRunRepository` 类型改成 `WorkflowRunRepository | undefined`。所有 workflow list/load/cancel 分支先检查实例是否存在；不要在 Job Host 内回退创建文件 Repository。

- [ ] **步骤 5：在 agent-composition 只创建一次 Repository**

`workflowRepository` 解析规则：

- override 是对象：使用对象。
- override 是 false：结果 disabled，不注册工具，不交给 LocalAgentJobHost。
- 未传：创建 `new FileWorkflowRunRepository({ cwd })` 一次。

同一对象同时传给 Workflow tool setup 和 LocalAgentJobHost。

- [ ] **步骤 6：运行 Workflow、Jobs 与 SDK 测试**

```bash
pnpm --filter @vykor/tools exec vitest run src/job/local-job-host.test.ts src/agent/workflow/__test__/workflow-smoke.test.ts src/agent/workflow/__test__/tool.test.ts
pnpm --filter @vykor/agent-runtime exec vitest run src/sdk.test.ts
```

预期：全部 PASS。

- [ ] **步骤 7：提交 Workflow Repository 收口**

```bash
git add packages/tools/src/job packages/agent-runtime/src/agent-composition.ts packages/agent-runtime/src/sdk.test.ts
git commit -m "fix(workflow): share one repository with jobs"
```

## 任务 2：固定 Memory 的 agent-runtime 所有权

**文件：**

- 修改：`packages/agent-runtime/src/agent-composition.ts`
- 修改：`packages/agent-runtime/src/agent.ts`
- 修改：`packages/agent-runtime/src/memory-runtime.test.ts`
- 修改：`packages/agent-runtime/src/remember-tool.test.ts`
- 修改：`packages/agent-runtime/src/sdk.test.ts`

- [ ] **步骤 1：先写 Memory 默认与显式关闭测试**

测试四种行为：默认创建；`settings.memory.enabled === false` 关闭；`capabilityOverrides.memory === false` 关闭；两种关闭形式得到相同 capabilities snapshot。

```ts
expect(disabledAgent.getCapabilities().memory).toEqual({ status: "disabled" });
expect(disabledAgent.inspect().tools.map((tool) => tool.name)).not.toContain("Remember");
await expect(disabledAgent.remember()).resolves.toMatchObject({
  skipped: true,
  reason: "memory is disabled",
});
```

- [ ] **步骤 2：先写现有受管语义回归测试**

保留并补强：user scope 走 `appendUserProfileUpdate`；project scope 走 `MemoryManager`；模型工具参数不出现 `USER.md`、`.vykor` 或真实记忆目录；同一 Run 主动 Remember 后不会再自动提取。

- [ ] **步骤 3：运行 Memory 定向测试确认新关闭路径失败**

```bash
pnpm --filter @vykor/agent-runtime exec vitest run src/memory-runtime.test.ts src/remember-tool.test.ts src/sdk.test.ts
```

预期：FAIL，旧实现只读取 Settings，不识别 `capabilityOverrides.memory` 或新的诊断结果。

- [ ] **步骤 4：归一化 Memory 开关并复用现有 runtime**

```ts
const memoryDisabled =
  options.capabilityOverrides?.memory === false ||
  settings.memory?.enabled === false;
const memory = memoryDisabled
  ? undefined
  : await createAgentMemoryRuntime(cwd, settings.memory?.maxFiles ?? 10);
```

只有 `memory` 存在时才注册 Remember、设置 retriever 和运行自动提取。不要增加 Memory object override，也不要移动 Markdown 文件。

- [ ] **步骤 5：运行 Memory 与受管文件安全测试**

```bash
pnpm --filter @vykor/agent-runtime exec vitest run src/memory-runtime.test.ts src/remember-tool.test.ts src/sdk.test.ts
pnpm --filter @vykor/tools exec vitest run src/file/__test__/managed-persistence-path.test.ts
```

预期：全部 PASS。

- [ ] **步骤 6：提交 Memory 所有权调整**

```bash
git add packages/agent-runtime/src packages/tools/src/file/__test__/managed-persistence-path.test.ts
git commit -m "refactor(memory): keep managed runtime agent-owned"
```

## 任务 3：将 compact provider 改成准确的上下文 API

**文件：**

- 创建：`packages/agent-runtime/src/compact-context.ts`
- 创建：`packages/agent-runtime/src/compact-context.test.ts`
- 修改：`packages/core/src/engine/compact-service.ts`
- 修改：`packages/core/src/engine/query-engine.ts`
- 修改：`packages/core/src/types/runtime.ts`
- 修改：`packages/core/src/index.ts`
- 修改：`packages/core/src/engine/compact-service-advanced.test.ts`
- 修改：`packages/core/src/agent-session.test.ts`
- 修改：`packages/agent-runtime/src/agent.ts`

- [ ] **步骤 1：先写两个 provider 的组合测试**

```ts
const provider = createCompactContextProvider({
  attachmentCatalog: async () => "attachment: spec.pdf",
  sessionMemory: async () => "goal: finish phase two",
});
await expect(provider()).resolves.toEqual({
  attachmentCatalog: "attachment: spec.pdf",
  sessionMemory: "goal: finish phase two",
});
```

另测：任一 provider 缺省时只省略对应字段；返回空字符串时不写字段；provider 抛错时保留原始 cause，不把 compact 当作成功。

- [ ] **步骤 2：运行组合测试并确认失败**

```bash
pnpm --filter @vykor/agent-runtime exec vitest run src/compact-context.test.ts
```

预期：FAIL，缺少 `compact-context.ts`。

- [ ] **步骤 3：在 core 一次性重命名类型和 setter**

精确替换：

```ts
CompactAttachments        -> CompactContext
CompactAttachmentsProvider -> CompactContextProvider
setAttachmentsProvider     -> setCompactContextProvider
```

`CompactContext` 保留现有字段结构，包括 `attachmentCatalog` 与 `sessionMemory`。`CompactService.buildCompactPrompt()` 参数和局部变量也改为 context 命名。删除旧导出，不保留别名。

- [ ] **步骤 4：实现直接组合函数并更新 Agent API**

```ts
export interface CompactContextSources {
  attachmentCatalog?: () => string | Promise<string>;
  sessionMemory?: () => string | Promise<string>;
}

export function createCompactContextProvider(
  sources: CompactContextSources,
): CompactContextProvider;
```

Agent 公开方法改为 `setCompactContextProvider(provider)`；删除 `setCompactAttachmentsProvider`。

- [ ] **步骤 5：运行 core 与 agent-runtime 定向测试**

```bash
pnpm --filter @vykor/core exec vitest run src/engine/compact-service-advanced.test.ts src/agent-session.test.ts
pnpm --filter @vykor/agent-runtime exec vitest run src/compact-context.test.ts src/agent.test.ts
```

预期：全部 PASS。

- [ ] **步骤 6：执行旧名称零命中检查**

```bash
rg -n "CompactAttachments|setAttachmentsProvider|setCompactAttachmentsProvider" packages apps -g "*.ts"
```

此时 server 尚未迁移会出现匹配；记录完整清单并在下一任务全部移除。core 与 agent-runtime 中不得再有匹配。

- [ ] **步骤 7：提交 compact 核心 API**

```bash
git add packages/core/src packages/agent-runtime/src/compact-context.ts packages/agent-runtime/src/compact-context.test.ts packages/agent-runtime/src/agent.ts
git commit -m "refactor(compact): expose context provider"
```

## 任务 4：在 daemon 分别接入附件目录和 Session Memory

**文件：**

- 修改：`packages/server/src/application/agent/agent-pool.ts`
- 修改：`packages/server/src/application/agent/__test__/agent-pool.test.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`packages/server/src/application/__test__/durable-agent-application.test.ts`

- [ ] **步骤 1：先写 AgentPool 双来源测试**

AgentPool context 改成两个明确函数：

```ts
attachmentCatalog?(sessionId: string): string | Promise<string>;
sessionMemory?(sessionId: string): string | Promise<string>;
```

测试 acquire 后传给 Agent 的 provider 同时返回两项；只有一个来源时仍能 compact；来源函数都收到相同 session ID。

- [ ] **步骤 2：运行 AgentPool 测试确认失败**

```bash
pnpm --filter @vykor/server exec vitest run src/application/agent/__test__/agent-pool.test.ts
```

预期：FAIL，当前 context 仍只有 `compactAttachments`。

- [ ] **步骤 3：实现 AgentPool 的直接组合**

AgentPool acquire 时调用 `agent.setCompactContextProvider(createCompactContextProvider(...))`。为了避免 server 依赖 agent-runtime 内部函数，可在 AgentPool 写五行等价组合，或从 agent-runtime 公共入口导出该函数；只能保留一个实现，优先复用公共函数。

- [ ] **步骤 4：拆开 daemon-application 的两个读取来源**

附件目录继续调用：

```ts
buildCompactAttachmentCatalog(store, sessionId)
```

Session Memory 继续调用：

```ts
sessionMemoryToCompactText(
  getSessionMemoryContent(getSessionMemoryPath(session.cwd, sessionId)),
)
```

不要把两者重新包回名为 attachments 的函数。

- [ ] **步骤 5：运行 daemon compact 回归**

```bash
pnpm --filter @vykor/server exec vitest run src/application/agent/__test__/agent-pool.test.ts src/application/__test__/durable-agent-application.test.ts src/application/attachment-resource/__test__/compact-attachment-catalog.test.ts
```

预期：全部 PASS；durable 测试明确断言 `sessionMemory` 与 `attachmentCatalog` 同时存在。

- [ ] **步骤 6：执行 compact 旧名称零命中检查并提交**

```bash
rg -n "CompactAttachments|compactAttachments|setAttachmentsProvider|setCompactAttachmentsProvider" packages apps -g "*.ts"
```

预期：无匹配。然后提交：

```bash
git add packages/server packages/agent-runtime packages/core
git commit -m "fix(compact): combine attachments and session memory"
```

## 任务 5：明确 Attachments 与子 Agent 的边界

**文件：**

- 修改：`packages/agent-runtime/src/agent-composition.ts`
- 修改：`packages/agent-runtime/src/default-runtime.ts`
- 修改：`packages/agent-runtime/src/child-agent.ts`
- 修改：`packages/agent-runtime/src/child-agent.test.ts`
- 修改：`packages/agent-runtime/src/sdk.test.ts`
- 修改：`packages/server/src/daemon/daemon-agent.ts`
- 修改：`packages/server/src/daemon/__test__/daemon-agent.test.ts`

- [ ] **步骤 1：先写 standalone Attachments unavailable 测试**

```ts
const agent = await createDefaultNodeAgent({ cwd, settings: testSettings() });
expect(agent.getCapabilities().attachments).toMatchObject({
  status: "unavailable",
});
expect(agent.inspect().tools.map((tool) => tool.name)).not.toContain("ReadAttachment");
```

再写 override 对象为 available、`false` 为 disabled 的测试。

- [ ] **步骤 2：先写 attachmentResourceRoot 独立保留测试**

在 `default-runtime.test.ts` 验证只提供 `attachmentResourceRoot` 时，sandbox mount 仍创建只读映射，但 Attachments capability 仍是 unavailable。不要用目录存在推断附件 API 可用。

- [ ] **步骤 3：先写子 Agent override 借用测试**

用一个记录 session ID 的 fake attachment host 和一个可观察 producer bundle。父 Agent 创建子 Agent 后，断言子 Agent 使用相同 Host 对象；父子关闭均未调用 Host cleanup；Host 能收到子 session ID。

- [ ] **步骤 4：运行测试确认旧行为不满足契约**

```bash
pnpm --filter @vykor/agent-runtime exec vitest run src/sdk.test.ts src/default-runtime.test.ts src/child-agent.test.ts
```

预期：至少新 attachments snapshot 和 session-tree 测试失败。

- [ ] **步骤 5：实现 unavailable/disabled/override 三种附件结果**

未传 attachments 时不注册工具、不调用 `setAttachments()`，snapshot reason 固定为 `No attachment intake configured`。`false` 标记 disabled。对象 override 标记 available/override。

- [ ] **步骤 6：固定子 Agent 传播规则**

子 Agent 只传播原始 `capabilityOverrides` 与 `effects`；默认 Memory、Workflow、Jobs 在子 cwd/session 重新创建。代码注释明确 Host override 必须覆盖 root session tree，不增加 factory 类型。

- [ ] **步骤 7：运行阶段二相关测试与全仓检查**

```bash
pnpm --filter @vykor/core test
pnpm --filter @vykor/tools test
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/server test
pnpm check-types
pnpm check-docs
```

预期：全部 PASS，0 failed。

- [ ] **步骤 8：提交边界调整**

```bash
git add packages/agent-runtime packages/server
git commit -m "refactor(agent-runtime): clarify attachment and child boundaries"
```

## 阶段二完成检查

- [ ] Memory 没有 object override，也没有新存储接口。
- [ ] managed Remember、自动提取和受管路径保护保持通过。
- [ ] Workflow 工具与 Jobs 使用相同 Repository；关闭后两边同时消失。
- [ ] compact API 不再使用 attachments 命名承载 Session Memory。
- [ ] daemon compact 同时注入附件目录与 Session Memory。
- [ ] standalone Attachments 为 unavailable，`attachmentResourceRoot` 仍独立服务 sandbox。
- [ ] 子 Agent 重建本地默认能力，只借用 session-tree-aware Host overrides。
- [ ] 四个相关 workspace 测试、全仓类型检查和文档检查通过。
