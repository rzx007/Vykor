# Agent 内置 Tool 显式覆盖实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 `DefaultNodeAgent` 增加可诊断的显式 Tool 新增与覆盖 API，删除同名隐式覆盖，并修正 `Read` 对 `attachment://` 的模型可见契约。

**架构：** `ToolRegistry` 负责严格的新增、覆盖和来源记录；`DefaultNodeAgent` 在计算工具 ceiling/allow/deny 前原子应用 `tools` 与 `toolOverrides`；Extension、Plugin、MCP 只使用新增入口。覆盖实现继续走 QueryEngine 的统一执行管线，并从内置只读隐式批准集合中剔除。

**技术栈：** TypeScript、Vitest、pnpm workspace、Turbo、现有 `@vykor/core` / `@vykor/permissions` / `@vykor/tools` / `@vykor/agent-runtime` 包。

---

## 文件结构

- 修改 `packages/core/src/types/tools.ts`：定义 Tool 来源、诊断结果和严格 Registry 接口。
- 修改 `packages/core/src/engine/tool-registry.ts`：实现新增/覆盖互斥、稳定错误和来源记录。
- 修改 `packages/core/src/engine/index.test.ts`：锁定 Registry 的新增、覆盖、拼写错误和注销行为。
- 修改 `packages/core/src/index.ts`：导出新增类型和错误。
- 修改 `packages/permissions/src/index.ts`：允许 Runtime 标记失去内置本地只读信任的 Tool 名称。
- 修改 `packages/permissions/src/index.test.ts`：验证覆盖后的 `Read` 不再按名称自动放行。
- 修改 `packages/tools/src/registry.ts`：将默认 Tool 明确登记为 `builtin`。
- 修改 `packages/agent-runtime/src/agent-options.ts`：增加 `tools` 与 `toolOverrides` 公共配置。
- 修改 `packages/agent-runtime/src/default-runtime.ts`：原子应用调用方 Tool、修正可见性计算和权限信任。
- 修改 `packages/agent-runtime/src/default-runtime.test.ts`：覆盖配置验证、过滤和权限测试。
- 修改 `packages/agent-runtime/src/agent-composition.ts`：将 Tool 配置传入 Runtime 装配。
- 修改 `packages/agent-runtime/src/child-agent-options.ts`：显式传播父级 Tool 配置。
- 修改 `packages/agent-runtime/src/child-agent-options.test.ts`：锁定父子继承和对象身份。
- 修改 `packages/agent-runtime/src/agent.ts`：扩展 `agent.inspect().tools` 来源诊断。
- 修改 `packages/agent-runtime/src/agent.test.ts`：验证公开 API、执行结果和 inspect。
- 修改 `packages/agent-runtime/src/extensions.ts`：给第三方 Extension 只暴露新增语义并标记来源。
- 修改 `packages/agent-runtime/src/runtime-integrations.ts`：标记 Extension、MCP、Remember 来源并拒绝冲突。
- 修改 `packages/agent-runtime/src/native-tools/activate.ts`：标记 Native Plugin 来源，保留冲突失败。
- 修改 `packages/agent-runtime/src/mcp-auth.ts`：MCP 重连注册时标记来源。
- 修改 `packages/agent-runtime/src/extensions.test.ts`：验证 Extension/Plugin 不覆盖现有 Tool。
- 修改 `packages/tools/src/file/read.ts`：明确 `Read` 支持 `attachment://` 且不是 MCP Resource。
- 修改 `packages/tools/src/file/__test__/read.test.ts`：锁定新的模型可见描述和既有读取行为。
- 修改 `packages/server/src/application/attachment-routing/attachment-capability-router.ts`：大文本提示提供精确 `Read` 调用并禁止 `ReadMcpResource`。
- 修改 `packages/server/src/application/attachment-routing/__test__/attachment-capability-router.test.ts`：验证提示契约。

### 任务 1：严格 ToolRegistry 与来源诊断

**文件：**
- 修改：`packages/core/src/types/tools.ts`
- 修改：`packages/core/src/engine/tool-registry.ts`
- 修改：`packages/core/src/engine/index.test.ts`
- 修改：`packages/core/src/index.ts`

- [x] **步骤 1：编写失败的 Registry 测试**

在 `packages/core/src/engine/index.test.ts` 增加：

```ts
it("rejects implicit duplicate registration", () => {
  const registry = new ToolRegistry();
  registry.register(tool("Read"), { kind: "builtin" });
  expect(() => registry.register(tool("Read"), { kind: "extension" }))
    .toThrow(expect.objectContaining({ code: "tool_already_registered" }));
});

it("overrides an existing tool and records both sources", () => {
  const registry = new ToolRegistry();
  const replacement = tool("Read", "custom");
  registry.register(tool("Read", "builtin"), { kind: "builtin" });
  registry.override(replacement, { kind: "agent" });
  expect(registry.get("Read")).toBe(replacement);
  expect(registry.inspect("Read")).toEqual({
    name: "Read",
    source: { kind: "agent" },
    overrides: { kind: "builtin" },
  });
});

it("rejects an override whose target does not exist", () => {
  const registry = new ToolRegistry();
  expect(() => registry.override(tool("Raed"), { kind: "agent" }))
    .toThrow(expect.objectContaining({ code: "tool_override_target_not_found" }));
});
```

- [x] **步骤 2：运行 Core 测试并确认失败**

运行：

```powershell
pnpm --filter @vykor/core test -- src/engine/index.test.ts
```

预期：FAIL，原因是 `register()` 仍然隐式覆盖，且 `override()`、`inspect()` 和来源类型不存在。

- [x] **步骤 3：实现 Registry 类型与严格语义**

在 `packages/core/src/types/tools.ts` 增加：

```ts
export interface ToolRegistrationSource {
  kind: "builtin" | "agent" | "extension" | "plugin" | "mcp" | "runtime";
  id?: string;
}

export interface RegisteredToolInspection {
  name: string;
  source: ToolRegistrationSource;
  overrides?: ToolRegistrationSource;
}
```

将 Registry 接口扩为：

```ts
register(tool: ToolDefinition, source?: ToolRegistrationSource): void;
override(tool: ToolDefinition, source: ToolRegistrationSource): void;
inspect(name: string): RegisteredToolInspection | undefined;
```

在 `packages/core/src/engine/tool-registry.ts` 使用一个 Map 同时保存定义和来源：

```ts
interface ToolEntry {
  definition: ToolDefinition;
  source: ToolRegistrationSource;
  overrides?: ToolRegistrationSource;
}

export class ToolRegistrationError extends Error {
  constructor(
    readonly code: "tool_already_registered" | "tool_override_target_not_found",
    message: string,
  ) {
    super(message);
    this.name = "ToolRegistrationError";
  }
}
```

`register()` 的默认来源为 `{ kind: "runtime" }`，重名抛 `tool_already_registered`；`override()` 要求目标存在并记录被替换来源；`unregister()` 同时删除定义和来源；`get()` / `getAll()` 仍只返回 `ToolDefinition`。

- [x] **步骤 4：补齐所有 Core Registry 视图的接口实现**

更新 `QueryEngine.visibleToolRegistry()` 返回的包装对象，使它转发：

```ts
register: (tool, source) => inner.register(tool, source),
override: (tool, source) => inner.override(tool, source),
inspect: (name) => inner.inspect(name),
```

从 `packages/core/src/index.ts` 导出 `ToolRegistrationError`、`ToolRegistrationSource` 和 `RegisteredToolInspection`。

- [x] **步骤 5：运行 Core 测试和类型检查**

运行：

```powershell
pnpm --filter @vykor/core test -- src/engine/index.test.ts
pnpm --filter @vykor/core check-types
```

预期：PASS；现有依赖包可能因尚未补齐来源参数而在后续任务修复，但 Core 自身类型检查通过。

- [x] **步骤 6：提交 Registry 语义**

```powershell
git add packages/core/src/types/tools.ts packages/core/src/engine/tool-registry.ts packages/core/src/engine/index.test.ts packages/core/src/engine/query-engine.ts packages/core/src/index.ts
git commit -m "feat(core): make tool overrides explicit"
```

### 任务 2：DefaultNodeAgent 新增与覆盖 API

**文件：**
- 修改：`packages/permissions/src/index.ts`
- 修改：`packages/permissions/src/index.test.ts`
- 修改：`packages/tools/src/registry.ts`
- 修改：`packages/agent-runtime/src/agent-options.ts`
- 修改：`packages/agent-runtime/src/agent-composition.ts`
- 修改：`packages/agent-runtime/src/default-runtime.ts`
- 修改：`packages/agent-runtime/src/default-runtime.test.ts`
- 修改：`packages/agent-runtime/src/agent.ts`
- 修改：`packages/agent-runtime/src/agent.test.ts`
- 修改：`packages/agent-runtime/src/child-agent-options.ts`
- 修改：`packages/agent-runtime/src/child-agent-options.test.ts`

- [x] **步骤 1：先写 Agent API 与配置校验失败测试**

在 `default-runtime.test.ts` 和 `agent.test.ts` 增加：

```ts
it("adds a caller tool before visibility filtering", async () => {
  const custom = testTool("BusinessSearch", "business-result");
  const runtime = await createRuntime({
    tools: [custom],
    hostToolCeiling: ["BusinessSearch"],
  });
  expect(runtime.toolRegistry.get("BusinessSearch")).toBe(custom);
});

it("replaces one builtin tool only through toolOverrides", async () => {
  const replacement = testTool("Read", "replacement-result");
  const agent = await createDefaultNodeAgent({
    cwd,
    settings,
    client,
    toolOverrides: [replacement],
  });
  expect(agent.inspect().tools).toContainEqual({
    name: "Read",
    source: { kind: "agent" },
    overrides: { kind: "builtin" },
  });
});

it.each([
  { tools: [testTool("Read")] },
  { toolOverrides: [testTool("Raed")] },
  { tools: [testTool("X")], toolOverrides: [testTool("X")] },
])("rejects invalid caller tool configuration", async (configuration) => {
  await expect(createDefaultNodeAgent({ cwd, settings, client, ...configuration }))
    .rejects.toThrow();
});
```

- [x] **步骤 2：先写覆盖 Tool 权限降级测试**

在 `packages/permissions/src/index.test.ts` 增加：

```ts
it("does not auto-approve an overridden local read-only tool", async () => {
  const checker = new PermissionChecker({
    mode: "default",
    cwd: "/repo",
    untrustedToolNames: ["Read"],
  });
  await expect(checker.checkTool("Read", { file_path: "/repo/a.txt" }))
    .resolves.toMatchObject({ action: "ask" });
});
```

在 `default-runtime.test.ts` 增加 `autoApproveReadOnly` 测试，断言覆盖后的非本地只读 Tool 不会被隐式加入自动批准列表，但 `settings.permission.autoApproveTools` 或 `configuration.autoApproveTools` 的显式授权仍保留。

- [x] **步骤 3：运行定向测试并确认失败**

运行：

```powershell
pnpm --filter @vykor/permissions test -- src/index.test.ts
pnpm --filter @vykor/agent-runtime test -- src/default-runtime.test.ts src/agent.test.ts src/child-agent-options.test.ts
```

预期：FAIL，原因是 API、配置校验、来源诊断和权限降级尚未实现。

- [x] **步骤 4：增加公共配置并原子应用 Tool**

在 `VykorAgentConfiguration` 增加：

```ts
tools?: ToolDefinition[];
toolOverrides?: ToolDefinition[];
```

在 `createVykorRuntime()` 中：

1. 先创建默认 Registry，默认工具来源统一为 `{ kind: "builtin" }`。
2. 用纯函数验证两个数组内部无重名、彼此无交集、所有 override 目标存在。
3. 验证完成后先 `register(..., { kind: "agent" })`，再 `override(..., { kind: "agent" })`。
4. 应用完成后再计算 `knownToolNames`、ceiling、allowlist 和 deny。

配置错误信息必须带稳定原因和 Tool 名称，不允许部分应用后再失败。

- [x] **步骤 5：实现覆盖来源的权限降级**

给 `PermissionCheckOptions` 增加：

```ts
untrustedToolNames?: string[];
```

`PermissionChecker` 在 `isLocalReadOnlyToolAllowed()` 前检查该集合。`createVykorRuntime()` 将 `toolOverrides` 名称传入该选项。

将 `resolveAutoApproveTools()` 扩为接收 `implicitlyUntrustedToolNames`。只过滤 `autoApproveReadOnly` 自动注入的名称，不过滤 Settings 或 Agent 配置中的显式 `autoApproveTools`。

- [x] **步骤 6：扩展 inspect 并传播给子 Agent**

`agent.inspect()` 对每个可见 Tool 调用 Registry `inspect()`，返回：

```ts
{
  name: tool.name,
  source: entry.source,
  ...(entry.overrides ? { overrides: entry.overrides } : {}),
}
```

`deriveChildAgentOptions()` 显式返回父配置中的 `tools` 和 `toolOverrides`；测试使用 `toBe()` 确认数组及 Tool 定义对象保持身份，同时验证子级 role allowlist 和 deny 不变。

- [x] **步骤 7：运行定向测试**

运行：

```powershell
pnpm --filter @vykor/permissions test -- src/index.test.ts
pnpm --filter @vykor/agent-runtime test -- src/default-runtime.test.ts src/agent.test.ts src/child-agent-options.test.ts
pnpm --filter @vykor/agent-runtime check-types
```

预期：全部 PASS。

- [x] **步骤 8：提交 Agent API**

```powershell
git add packages/permissions/src/index.ts packages/permissions/src/index.test.ts packages/tools/src/registry.ts packages/agent-runtime/src/agent-options.ts packages/agent-runtime/src/agent-composition.ts packages/agent-runtime/src/default-runtime.ts packages/agent-runtime/src/default-runtime.test.ts packages/agent-runtime/src/agent.ts packages/agent-runtime/src/agent.test.ts packages/agent-runtime/src/child-agent-options.ts packages/agent-runtime/src/child-agent-options.test.ts
git commit -m "feat(agent-runtime): support explicit tool overrides"
```

### 任务 3：阻止 Extension、Plugin 与 MCP 隐式覆盖

**文件：**
- 修改：`packages/agent-runtime/src/extensions.ts`
- 修改：`packages/agent-runtime/src/runtime-integrations.ts`
- 修改：`packages/agent-runtime/src/native-tools/activate.ts`
- 修改：`packages/agent-runtime/src/mcp-auth.ts`
- 修改：`packages/agent-runtime/src/extensions.test.ts`
- 修改：`packages/agent-runtime/src/mcp-auth.test.ts`

- [x] **步骤 1：编写集成来源和冲突测试**

增加测试：

```ts
it("does not let an extension replace a builtin tool", async () => {
  const extension = {
    setup({ toolRegistry }: VykorExtensionContext) {
      toolRegistry.register(testTool("Read"));
    },
  };
  await expect(createDefaultNodeAgent({ cwd, settings, client, extensions: [extension] }))
    .rejects.toMatchObject({ code: "tool_already_registered" });
});

it("keeps a caller override when a later integration uses the same name", async () => {
  // 使用测试 Extension 或 MCP Tool 注册同名 Read。
  // 断言集成失败，Registry 中仍是 source=agent 的调用方定义。
});
```

为 MCP reconnect 增加断言：重新注册的 MCP Tool 来源为 `{ kind: "mcp", id: serverName }`，与现有 Tool 冲突时不会替换现有定义。

- [x] **步骤 2：运行测试并确认来源断言失败**

运行：

```powershell
pnpm --filter @vykor/agent-runtime test -- src/extensions.test.ts src/mcp-auth.test.ts
```

预期：冲突因任务 1 的严格 Registry 已经不会覆盖，但来源诊断和受限 Extension 视图尚未满足断言。

- [x] **步骤 3：为各集成传入准确来源**

固定来源：

```ts
// 程序化 Extension
{ kind: "extension" }

// Native Plugin
{ kind: "plugin", id: plugin.manifest.id }

// MCP
{ kind: "mcp", id: serverName }

// Remember 等 Runtime 后装 Tool
{ kind: "runtime", id: "memory" }
```

Extension 上下文暴露一个受限 Registry 包装器：`register()` 强制使用 Extension 来源；`override()` 不暴露给 `VykorExtensionContext` 的公开类型。Native Plugin 和 MCP 继续使用内部完整 Registry，但只能调用 `register()`。

- [x] **步骤 4：保证失败回滚不删除原有 Tool**

Extension/Plugin 一轮注册多个 Tool 时只记录本轮成功注册的名称；发生后续冲突时仅注销这些名称。严禁按冲突名称调用 `unregister()`，否则会删除内置或调用方 Tool。

MCP connect/reconnect 遇到冲突时保持当前连接错误策略，同时断言已存在 Tool 定义和来源不变。

- [x] **步骤 5：运行集成测试与类型检查**

运行：

```powershell
pnpm --filter @vykor/agent-runtime test -- src/extensions.test.ts src/mcp-auth.test.ts
pnpm --filter @vykor/agent-runtime check-types
```

预期：全部 PASS。

- [x] **步骤 6：提交集成冲突保护**

```powershell
git add packages/agent-runtime/src/extensions.ts packages/agent-runtime/src/runtime-integrations.ts packages/agent-runtime/src/native-tools/activate.ts packages/agent-runtime/src/mcp-auth.ts packages/agent-runtime/src/extensions.test.ts packages/agent-runtime/src/mcp-auth.test.ts
git commit -m "fix(agent-runtime): prevent integration tool shadowing"
```

### 任务 4：修正 `Read` 附件资源契约

**文件：**
- 修改：`packages/tools/src/file/read.ts`
- 修改：`packages/tools/src/file/__test__/read.test.ts`
- 修改：`packages/server/src/application/attachment-routing/attachment-capability-router.ts`
- 修改：`packages/server/src/application/attachment-routing/__test__/attachment-capability-router.test.ts`

- [x] **步骤 1：编写模型可见契约失败测试**

在 `read.test.ts` 增加：

```ts
it("advertises attachment resources as Read inputs rather than MCP resources", () => {
  expect(fileReadTool.description).toContain("attachment://");
  expect(fileReadTool.description).toContain("not ReadMcpResource");
  expect(fileReadTool.inputSchema.properties.file_path.description)
    .toContain("attachment://");
});
```

在路由测试的大文本用例中增加：

```ts
expect(block.text).toContain('"file_path":"attachment://large/large.log"');
expect(block.text).toContain("不要调用 ReadMcpResource");
```

- [x] **步骤 2：运行测试并确认失败**

运行：

```powershell
pnpm --filter @vykor/tools test -- src/file/__test__/read.test.ts
pnpm --filter @vykor/server test -- src/application/attachment-routing/__test__/attachment-capability-router.test.ts
```

预期：FAIL，当前描述只声明绝对本地路径，大文本提示没有完整 Tool 参数示例。

- [x] **步骤 3：更新 `Read` 和附件提示**

`Read` 描述改为：

```ts
description:
  "Read a local file, directory, or Vykor attachment resource. " +
  "Use Read, not ReadMcpResource, for attachment:// resources."
```

`file_path` 描述改为：

```ts
"An absolute local path or the exact attachment:// resource URI provided in the conversation."
```

大文本资源块明确输出：

```text
这是 Vykor 附件资源，不是 MCP Resource。
需要更多内容时调用 Read，并传入：
{"file_path":"attachment://...","offset":1,"limit":2000}
不要调用 ReadMcpResource。
```

- [x] **步骤 4：运行附件定向测试**

运行：

```powershell
pnpm --filter @vykor/tools test -- src/file/__test__/read.test.ts
pnpm --filter @vykor/server test -- src/application/attachment-routing/__test__/attachment-capability-router.test.ts
```

预期：全部 PASS，并且现有 `AgentAttachmentResourceHost.readText()` 行为测试保持通过。

- [x] **步骤 5：提交附件契约修正**

```powershell
git add packages/tools/src/file/read.ts packages/tools/src/file/__test__/read.test.ts packages/server/src/application/attachment-routing/attachment-capability-router.ts packages/server/src/application/attachment-routing/__test__/attachment-capability-router.test.ts
git commit -m "fix(tools): clarify attachment reads"
```

### 任务 5：全量验证与文档收口

**文件：**
- 修改：`docs/superpowers/plans/2026-09-02-agent-tool-overrides.md`（只勾选实际完成步骤）
- 核对：`docs/superpowers/specs/2026-09-02-agent-tool-override-design.md`

- [x] **步骤 1：运行受影响包测试**

```powershell
pnpm --filter @vykor/core test
pnpm --filter @vykor/permissions test
pnpm --filter @vykor/tools test
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/server test
```

预期：全部 PASS。Windows `node-pty AttachConsole failed` 的子进程噪音只有在测试退出码为 0 且断言全部通过时才可视为非阻塞信息。

- [x] **步骤 2：运行全仓类型检查**

```powershell
pnpm check-types
```

预期：57 个任务全部成功。

- [x] **步骤 3：检查差异和工作区边界**

```powershell
git diff --check
git status --short
git diff --name-only 826dc06c..HEAD
```

预期：没有空白错误；实现提交不包含用户已有的 `tests/browser-client` 删除；没有生成物或无关文件。

- [x] **步骤 4：对照规格逐条复核验收标准**

逐项确认：显式新增、显式覆盖、未知目标失败、第三方来源不能覆盖、权限信任降级、子 Agent 继承、inspect 来源、附件 `Read` 提示均有通过的自动化测试。任何未满足项必须在结束前修复，不能只在总结中声明延期。

- [x] **步骤 5：提交计划完成状态**

仅在前四步全部通过后勾选本计划实际完成的复选框并提交：

```powershell
git add docs/superpowers/plans/2026-09-02-agent-tool-overrides.md
git commit -m "docs(agent-runtime): complete tool override plan"
```
