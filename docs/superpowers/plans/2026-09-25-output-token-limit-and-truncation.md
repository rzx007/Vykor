# 输出上限（32k）与截断可见性 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让主对话请求的输出上限由「模型目录 limit.output 与 32k 上限取小」决定（不再写死 8192），并让「输出被截断」在界面上可见；同时删掉从未生效的 `settings.maxTokens` 死配置。

**Architecture:** 分三层修：provider 层把 OpenAI 的 `finish_reason="length"` 归一化成 `"max_tokens"`；engine 层识别两种截断停止原因并追加可见提示；runtime 层解析「目录 outputLimit」并算出 `min(catalog, outputTokenMax)`，经 `QueryRequestConfiguration.maxOutputTokens` 透传到 `streamMessage({ maxTokens })`。默认上限常量 `DEFAULT_OUTPUT_TOKEN_MAX = 32_000`，与 opencode 的 `OUTPUT_TOKEN_MAX` 对齐。

**Tech Stack:** TypeScript、pnpm workspace、vitest、Turbo。涉及包：`@vykor/core`、`@vykor/api`、`@vykor/agent-runtime`、`@vykor/server`、`@rzx/ohs`(CLI)。

## Global Constraints

- 默认输出上限常量名 `DEFAULT_OUTPUT_TOKEN_MAX`，值 `32_000`。
- 有效上限由目录 output 推导：无目录 output → `cap`；目录 output ≤ `cap` → 用满目录值；否则 `max(cap, round(目录 output × OUTPUT_TOKEN_CAP_RATIO))`，`cap = settings.outputTokenMax ?? DEFAULT_OUTPUT_TOKEN_MAX`（默认 32000，比例 0.5）。
- 新请求字段一律叫 `maxOutputTokens`；**不得**改动或复用 `QueryEngineOptions.maxTokens`（它是压缩上下文窗口，语义不同）。
- 彻底删除 `settings.maxTokens` 与 `VYKOR_MAX_TOKENS`；settings 文件里遗留的 `maxTokens` 会被当作未知字段拒绝（`SettingsFileError`），存量用户需手动删除该字段。**不要**把它加进 forbidden 清单（那会触发全仓正则扫描误报）。
- OpenAI `finish_reason === "length"` 归一化为 `"max_tokens"`；engine 同时接受 `"max_tokens"` 与 `"length"`。
- 面向用户的提示文案用简体中文。
- 不新增代码注释，除非该处本来就有注释（AGENTS.md 约定）。
- 每个任务结束跑对应包的测试与类型检查后才提交。

---

### Task 1: OpenAI 把 length 归一化为 max_tokens

**Files:**
- Modify: `packages/api/src/providers/openai.ts:362-365`
- Test: `packages/api/src/providers/openai.test.ts`（新增 `describe`）

**Interfaces:**
- Consumes: 无
- Produces: `OpenAICompatibleClient.streamMessage()` 在 `finish_reason === "length"` 且无工具调用时，`complete.stopReason` 为 `"max_tokens"`。

- [ ] **Step 1: 写失败测试**

在 `packages/api/src/providers/openai.test.ts` 末尾追加：

```ts
describe("OpenAICompatibleClient stop reason normalization", () => {
  function finishClient(finishReason: string | null) {
    const create = vi.fn(async () => ({
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: "hi" }, finish_reason: null }] };
        yield { choices: [{ delta: {}, finish_reason: finishReason }] };
      },
    }));
    const client = new OpenAICompatibleClient({ apiKey: "test", baseURL: "https://gw.example/v1" });
    client.client = { chat: { completions: { create } } } as any;
    return client;
  }

  async function completeReason(client: OpenAICompatibleClient): Promise<string> {
    let reason = "";
    for await (const event of client.streamMessage({
      model: "deepseek-v4.1-flash",
      messages: [{ type: "user", content: "hi" }],
    })) {
      if (event.type === "complete") reason = event.stopReason;
    }
    return reason;
  }

  it("maps the OpenAI length finish reason to max_tokens", async () => {
    expect(await completeReason(finishClient("length"))).toBe("max_tokens");
  });

  it("keeps ordinary finish reasons unchanged", async () => {
    expect(await completeReason(finishClient("stop"))).toBe("stop");
    expect(await completeReason(finishClient(null))).toBe("end_turn");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vykor/api test -- openai.test.ts`
Expected: FAIL，`maps the OpenAI length finish reason to max_tokens` 得到 `"length"` 而非 `"max_tokens"`。

- [ ] **Step 3: 实现归一化**

把 `packages/api/src/providers/openai.ts` 第 362-365 行：

```ts
    yield {
      type: "complete",
      stopReason: toolUseCount > 0 ? "tool_use" : finishReason ?? "end_turn",
    };
```

改为：

```ts
    const normalizedStopReason =
      finishReason === "length" ? "max_tokens" : finishReason ?? "end_turn";
    yield {
      type: "complete",
      stopReason: toolUseCount > 0 ? "tool_use" : normalizedStopReason,
    };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @vykor/api test -- openai.test.ts`
Expected: PASS，全部通过。

- [ ] **Step 5: 提交**

```bash
git add packages/api/src/providers/openai.ts packages/api/src/providers/openai.test.ts
git commit -m "fix(api): normalize OpenAI length stop reason to max_tokens"
```

---

### Task 2: QueryEngine 对两种截断停止原因都追加可见提示

**Files:**
- Modify: `packages/core/src/engine/query-engine.ts`（约 90-148 区间加辅助函数；452-458 改判断与文案）
- Test: `packages/core/src/engine/integration.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `"max_tokens"`（同时兼容 `"length"`）
- Produces: 当 `stopReason ∈ {"max_tokens","length"}` 且本轮无工具调用时，engine 追加一段包含「已被截断」的 `text_delta` 并写入 assistant 文本。

- [ ] **Step 1: 写失败测试**

在 `packages/core/src/engine/integration.test.ts` 的 `describe("Integration: Full Agent Loop", ...)` 块内追加：

```ts
  it("appends a visible truncation notice when the provider hits the output limit", async () => {
    const client = {
      streamMessage: async function* () {
        yield { type: "reasoning_delta" as const, delta: "long thinking", source: "reasoning_content" as const };
        yield { type: "complete" as const, stopReason: "length" };
      },
    };
    const engine = new QueryEngine(
      client,
      new ToolRegistry(),
      allowAll(),
      noopHooks(),
      { trajectoryTrackerFactory: false },
    );
    const events: StreamEvent[] = [];
    for await (const event of engine.submitMessage("hi")) events.push(event);
    const text = events
      .filter((event) => event.type === "text_delta")
      .map((event: any) => event.delta)
      .join("");
    expect(text).toContain("已被截断");
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vykor/core test -- integration.test.ts`
Expected: FAIL，`text` 中不含「已被截断」（原逻辑只认 `max_tokens`）。

- [ ] **Step 3: 加辅助函数并改判断与文案**

在 `packages/core/src/engine/query-engine.ts` 顶部（imports 之后、`MaxTurnsExceeded` 之类现有声明附近）新增：

```ts
function isTruncatedStopReason(stopReason: string): boolean {
  return stopReason === "max_tokens" || stopReason === "length";
}
```

把原 452-458 行：

```ts
      // 输出 token 用尽时追加截断提示，避免静默截断
      if (stopReason === "max_tokens" && toolUses.length === 0) {
        const notice =
          "\n\n⚠️ *输出已被截断（达到 max_tokens 上限）。可用 /compact 压缩上下文后继续。*";
        assistantText += notice;
        yield { type: "text_delta", delta: notice };
      }
```

改为：

```ts
      if (isTruncatedStopReason(stopReason) && toolUses.length === 0) {
        const notice =
          "\n\n⚠️ *回复已被截断：本轮输出长度达到上限。可发送「继续」让模型接着写完。*";
        assistantText += notice;
        yield { type: "text_delta", delta: notice };
      }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @vykor/core test -- integration.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/engine/query-engine.ts packages/core/src/engine/integration.test.ts
git commit -m "fix(core): surface truncated output for length and max_tokens stop reasons"
```

---

### Task 3: 新增 outputTokenMax 设置并删除死配置 maxTokens

**Files:**
- Modify: `packages/core/src/types/settings.ts:133`
- Modify: `packages/core/src/config/settings.ts:6-11, 213, 311`
- Modify: `packages/core/src/index.ts:192-198`
- Modify: `apps/cli/src/config-coerce.ts:15-20`
- Modify: `packages/server/src/application/default-services/settings-service.ts:36-41, 281`
- Modify: `packages/server/src/application/assemble-session-context-usage.test.ts:20`
- Modify: `packages/server/src/application/resolve-model-context-limits.test.ts:18`
- Modify: `packages/server/src/application/default-services/context-service.usage.test.ts:15`
- Modify: `README.md:827`
- Test: `packages/core/src/config/settings.test.ts`
- Test: `packages/server/src/application/default-services/settings-service.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `Settings.outputTokenMax?: number`；常量 `DEFAULT_OUTPUT_TOKEN_MAX = 32_000` 从 `@vykor/core` 导出；`VYKOR_OUTPUT_TOKEN_MAX` 环境变量生效；`maxTokens` 被任何 settings 文件携带时抛 `SettingsFileError`。

- [ ] **Step 1: 写失败测试**

在 `packages/core/src/config/settings.test.ts` 的 `describe("daemon settings", ...)` 内追加：

```ts
  it("defaults outputTokenMax to 32k and accepts an explicit value", async () => {
    expect((await loadSettings()).outputTokenMax).toBe(32_000);
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ outputTokenMax: 16_000 }));
    expect((await loadSettings()).outputTokenMax).toBe(16_000);
  });

  it("reads VYKOR_OUTPUT_TOKEN_MAX from the environment", async () => {
    process.env.VYKOR_OUTPUT_TOKEN_MAX = "8000";
    try {
      expect((await loadSettings()).outputTokenMax).toBe(8_000);
    } finally {
      delete process.env.VYKOR_OUTPUT_TOKEN_MAX;
    }
  });

  it("rejects a settings file that still carries the removed maxTokens field", async () => {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ maxTokens: 16_384 }));
    await expect(loadSettings()).rejects.toMatchObject({
      name: "SettingsFileError",
      field: "settings.maxTokens",
    });
  });
```

在 `packages/server/src/application/default-services/settings-service.test.ts` 顶部把 import 改为：

```ts
import { createDefaultSettingsService, settingsPatchRuntimeImpact } from "./settings-service.js";
```

并在文件末尾追加：

```ts
describe("settings runtime impact", () => {
  it("invalidates warm agents when outputTokenMax changes", () => {
    expect(settingsPatchRuntimeImpact({ path: "outputTokenMax", value: 16_000 })).toBe("invalidate");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vykor/core test -- settings.test.ts`
Expected: FAIL，`outputTokenMax` 为 `undefined`。

- [ ] **Step 3: 加常量与默认值，删 maxTokens**

`packages/core/src/config/settings.ts`：在 `const DEFAULT_SETTINGS` 之前加：

```ts
export const DEFAULT_OUTPUT_TOKEN_MAX = 32_000;
```

把第 10 行 `maxTokens: 16384,` 改为 `outputTokenMax: DEFAULT_OUTPUT_TOKEN_MAX,`。

把第 213 行：

```ts
  if (process.env.VYKOR_MAX_TOKENS !== undefined) result.maxTokens = parseInt(process.env.VYKOR_MAX_TOKENS, 10);
```

改为：

```ts
  if (process.env.VYKOR_OUTPUT_TOKEN_MAX !== undefined) {
    const parsed = parseInt(process.env.VYKOR_OUTPUT_TOKEN_MAX, 10);
    if (Number.isSafeInteger(parsed) && parsed > 0) result.outputTokenMax = parsed;
  }
```

把第 311 行 `"maxTokens",` 改为 `"outputTokenMax",`。

`packages/core/src/types/settings.ts` 第 133 行 `maxTokens?: number;` 改为 `outputTokenMax?: number;`。

`packages/core/src/index.ts` 的 settings 导出块（192-198 行）加入常量：

```ts
export {
  DEFAULT_OUTPUT_TOKEN_MAX,
  loadSettings,
  saveSettings,
  loadProjectSettings,
  saveProjectSettings,
  withMcpServerOAuthScopes,
} from "./config/settings";
```

`apps/cli/src/config-coerce.ts` 第 15-20 行把 `case "maxTokens":` 改为 `case "outputTokenMax":`。

`packages/server/src/application/default-services/settings-service.ts` 第 281 行改为：

```ts
  if (["maxTurns", "outputTokenMax", "passes"].includes(key)) {
```

同文件把 `SOFT_RUNTIME_INVALIDATE_KEYS`（36-41 行）改为（否则改设置后已预热的 session 不会应用新上限）：

```ts
const SOFT_RUNTIME_INVALIDATE_KEYS = new Set([
  "maxTurns",
  "outputTokenMax",
  "effort",
  "fastMode",
  "workStyle",
]);
```

- [ ] **Step 4: 清理旧字段引用与文档**

> 注意：**不要**把 `maxTokens` 加进 `scripts/forbidden-compatibility-surfaces.json` 的 `configFields`。该清单会被 forbidden-surface 扫描器当作全仓正则去匹配（`scripts/forbidden-compatibility-scan-policy.mjs:4-6`、`scripts/forbidden-compatibility-surfaces.mjs`），而 `maxTokens` 在 `QueryEngineOptions`、`StreamMessageParams`、`CompactService`、workflow budget 等**合法**位置大量存在（实测约 25 处非构建产物命中），加了会让 `pnpm check:architecture` 失败。`settings.maxTokens` 的拒绝行为已由「从 `TOP_LEVEL_SETTINGS_FIELDS` 删除」自动获得，并由 Step 1 的独立测试覆盖。

三个测试夹具删除 `maxTokens: 1024,` 这一行：
- `packages/server/src/application/assemble-session-context-usage.test.ts:20`
- `packages/server/src/application/resolve-model-context-limits.test.ts:18`
- `packages/server/src/application/default-services/context-service.usage.test.ts:15`

`README.md` 第 827 行改为：

```markdown
| `VYKOR_OUTPUT_TOKEN_MAX` | 单轮输出 token 上限（默认 32000，取模型目录 output 与其较小值） |
```

- [ ] **Step 5: 运行测试与类型检查确认通过**

Run: `pnpm --filter @vykor/core test -- settings.test.ts`
Expected: PASS，且 `maxTokens` 拒绝用例与 `outputTokenMax` 默认/环境变量用例通过。

Run: `pnpm --filter @vykor/server test -- settings-service.test.ts`
Expected: PASS，`outputTokenMax` 变更返回 `invalidate`。

Run: `pnpm --filter @vykor/core check-types; pnpm --filter @vykor/server check-types`
Expected: 无类型错误。

- [ ] **Step 6: 提交**

```bash
git add packages/core packages/server apps/cli README.md
git commit -m "feat(core): replace dead maxTokens setting with outputTokenMax"
```

---

### Task 4: 目录映射新增 context/output 上限读取

**Files:**
- Modify: `packages/server/src/application/default-services/catalog-provider-mapping.ts`
- Test: `packages/server/src/application/default-services/catalog-provider-mapping.test.ts`

**Interfaces:**
- Consumes: `ModelsDevCatalog`、`ModelsDevModel`
- Produces:
  - `catalogModelEntry(catalog, providerName, modelId): ModelsDevModel | undefined`
  - `catalogModelContextWindow(catalog, providerName, modelId): number | undefined`
  - `catalogModelOutputLimit(catalog, providerName, modelId): number | undefined`
  - `catalogModelReasoningEfforts` 复用 `catalogModelEntry`

- [ ] **Step 1: 写失败测试**

在 `packages/server/src/application/default-services/catalog-provider-mapping.test.ts` 内追加：

```ts
describe("catalog model limits", () => {
  const catalog = {
    opencode: {
      models: {
        "deepseek-v4.1-flash": {
          id: "deepseek-v4.1-flash",
          limit: { context: 1_000_000, output: 384_000 },
        },
        broken: { limit: { context: 0, output: -5 } },
      },
    },
  } as never;

  it("reads context and output limits by model id", () => {
    expect(catalogModelContextWindow(catalog, "opencode", "deepseek-v4.1-flash")).toBe(1_000_000);
    expect(catalogModelOutputLimit(catalog, "opencode", "deepseek-v4.1-flash")).toBe(384_000);
  });

  it("returns undefined for non-positive, non-integer, or missing limits", () => {
    expect(catalogModelContextWindow(catalog, "opencode", "broken")).toBeUndefined();
    expect(catalogModelOutputLimit(catalog, "opencode", "broken")).toBeUndefined();
    expect(catalogModelOutputLimit(catalog, "opencode", "missing")).toBeUndefined();
  });
});
```

并把文件顶部 import 改为：

```ts
import {
  catalogModelContextWindow,
  catalogModelOutputLimit,
  catalogModelReasoningEfforts,
  readCatalogProvider,
  reasoningEffortsFromModel,
} from "./catalog-provider-mapping.js";
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vykor/server test -- catalog-provider-mapping.test.ts`
Expected: FAIL（导入的 `catalogModelContextWindow`/`catalogModelOutputLimit` 不存在）。

- [ ] **Step 3: 实现**

在 `packages/server/src/application/default-services/catalog-provider-mapping.ts` 中，把 `catalogModelReasoningEfforts` 替换为下面内容（保留其上方函数不变）：

```ts
export function catalogModelEntry(
  catalog: ModelsDevCatalog,
  providerName: string,
  modelId: string,
): ModelsDevModel | undefined {
  const provider = readCatalogProvider(catalog, providerName);
  if (!provider?.models) return undefined;
  const entry = Object.entries(provider.models).find(([key, model]) => {
    const id =
      typeof model.id === "string" && model.id.trim() ? model.id.trim() : key;
    return id === modelId;
  });
  return entry?.[1];
}

function positiveLimit(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function catalogModelContextWindow(
  catalog: ModelsDevCatalog,
  providerName: string,
  modelId: string,
): number | undefined {
  return positiveLimit(catalogModelEntry(catalog, providerName, modelId)?.limit?.context);
}

export function catalogModelOutputLimit(
  catalog: ModelsDevCatalog,
  providerName: string,
  modelId: string,
): number | undefined {
  return positiveLimit(catalogModelEntry(catalog, providerName, modelId)?.limit?.output);
}

export function catalogModelReasoningEfforts(
  catalog: ModelsDevCatalog,
  providerName: string | undefined,
  modelId: string,
): string[] | undefined {
  if (!providerName) return undefined;
  const model = catalogModelEntry(catalog, providerName, modelId);
  return model ? reasoningEffortsFromModel(model) : undefined;
}
```

（如 `ModelsDevModel` 尚未在文件顶部 import，则将其加入现有 `import type { ... } from "@vykor/api"`。）

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @vykor/server test -- catalog-provider-mapping.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/server/src/application/default-services/catalog-provider-mapping.ts packages/server/src/application/default-services/catalog-provider-mapping.test.ts
git commit -m "feat(server): add catalog context and output limit helpers"
```

---

### Task 5: engine 透传 maxOutputTokens，provider 兜底改 32k

**Files:**
- Modify: `packages/core/src/types/runtime.ts:60`
- Modify: `packages/core/src/engine/query-engine.ts:408-417`
- Modify: `packages/api/src/providers/openai.ts:1-8, 166`
- Modify: `packages/api/src/providers/anthropic.ts:1-9, 61`
- Test: `packages/core/src/engine/request-configuration.test.ts`
- Test: `packages/api/src/providers/openai.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_OUTPUT_TOKEN_MAX`（Task 3 导出）
- Produces:
  - `QueryRequestConfiguration.maxOutputTokens?: number`
  - engine 在 `maxOutputTokens` 已定义时向 `streamMessage` 传 `maxTokens`
  - 两个 provider 在调用方未给 `maxTokens` 时使用 `DEFAULT_OUTPUT_TOKEN_MAX`

- [ ] **Step 1: 写失败测试（engine 透传）**

在 `packages/core/src/engine/request-configuration.test.ts` 的 `describe` 内追加：

```ts
  it("forwards maxOutputTokens to the streaming request", async () => {
    const requests: StreamMessageParams[] = [];
    const client: StreamingMessageClient = {
      async *streamMessage(params) {
        requests.push(params);
        yield { type: "complete" as const, stopReason: "end_turn" };
      },
    };
    const engine = new QueryEngine(
      client,
      new ToolRegistry(),
      { checkTool: async () => ({ action: "allow", reason: "test" }) } as never,
      { execute: async () => ({ blocked: false }) } as IHookExecutor,
      {
        resolveRequestConfiguration: async () => ({
          revision: 0,
          model: "m",
          client,
          maxOutputTokens: 32_000,
        }),
      },
    );
    for await (const _ of engine.submitMessage("hi")) { /* consume */ }
    expect(requests[0]).toMatchObject({ maxTokens: 32_000 });
  });
```

- [ ] **Step 2: 写失败测试（provider 兜底）**

在 `packages/api/src/providers/openai.test.ts` 末尾追加：

```ts
describe("OpenAICompatibleClient output token cap", () => {
  it("defaults max_tokens to the 32k cap when the caller omits it", async () => {
    const create = vi.fn(async () => ({ async *[Symbol.asyncIterator]() {} }));
    const client = new OpenAICompatibleClient({ apiKey: "test", baseURL: "https://gw.example/v1" });
    client.client = { chat: { completions: { create } } } as any;
    for await (const _ of client.streamMessage({
      model: "deepseek-v4.1-flash",
      messages: [{ type: "user", content: "hi" }],
    })) {}
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 32_000 }),
      expect.anything(),
    );
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @vykor/core test -- request-configuration.test.ts`
Expected: FAIL，`requests[0].maxTokens` 为 `undefined`。

Run: `pnpm --filter @vykor/api test -- openai.test.ts`
Expected: FAIL，`max_tokens` 为 `8192`。

- [ ] **Step 4: 实现**

`packages/core/src/types/runtime.ts`：在 `QueryRequestConfiguration` 的 `contextWindow?: number;`（第 60 行）之后加：

```ts
  maxOutputTokens?: number;
```

`packages/core/src/engine/query-engine.ts` 的 `streamMessage` 调用（408-417 行）改为：

```ts
      const stream = requestConfiguration.client.streamMessage({
        model: requestConfiguration.model,
        messages: this.messages,
        system,
        tools: tools.length > 0 ? tools : undefined,
        ...(requestConfiguration.maxOutputTokens !== undefined
          ? { maxTokens: requestConfiguration.maxOutputTokens }
          : {}),
        ...(requestConfiguration.reasoningEffort
          ? { reasoningEffort: requestConfiguration.reasoningEffort }
          : {}),
        abortSignal: options.signal,
      });
```

`packages/api/src/providers/openai.ts`：在 type import 之后加值导入：

```ts
import { DEFAULT_OUTPUT_TOKEN_MAX } from "@vykor/core";
```

第 166 行改为：

```ts
      ...tokenLimitParamForModel(params.model, params.maxTokens ?? DEFAULT_OUTPUT_TOKEN_MAX),
```

`packages/api/src/providers/anthropic.ts`：在 type import 之后加值导入：

```ts
import { DEFAULT_OUTPUT_TOKEN_MAX } from "@vykor/core";
```

第 61 行改为：

```ts
          max_tokens: params.maxTokens ?? DEFAULT_OUTPUT_TOKEN_MAX,
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @vykor/core test -- request-configuration.test.ts`
Expected: PASS。

Run: `pnpm --filter @vykor/api test -- openai.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/core/src/types/runtime.ts packages/core/src/engine/query-engine.ts packages/api/src/providers/openai.ts packages/api/src/providers/anthropic.ts packages/core/src/engine/request-configuration.test.ts packages/api/src/providers/openai.test.ts
git commit -m "feat(core): forward maxOutputTokens and raise provider output fallback to 32k"
```

---

### Task 6: daemon 解析目录上限，default-runtime 计算 32k 取小

**Files:**
- Modify: `packages/agent-runtime/src/agent-options.ts:82`
- Modify: `packages/server/src/daemon/daemon-agent.ts:88-91, 223-226`
- Modify: `packages/server/src/application/daemon-application.ts:39-41, 430-438`
- Modify: `packages/agent-runtime/src/default-runtime.ts:1-20, 309-320`
- Test: `packages/agent-runtime/src/default-runtime.test.ts`

**Interfaces:**
- Consumes: `catalogModelContextWindow` / `catalogModelOutputLimit`（Task 4）、`DEFAULT_OUTPUT_TOKEN_MAX`（Task 3）、`QueryRequestConfiguration.maxOutputTokens`（Task 5）
- Produces:
  - `VykorAgentConfiguration.resolveModelOutputLimit?(input): Promise<number | undefined>`
  - daemon 的 `resolveModelOutputLimit` 返回目录 `limit.output`
  - default-runtime 返回的请求配置里 `maxOutputTokens = min(catalogOutputLimit ?? cap, cap)`

- [ ] **Step 1: 写失败测试**

在 `packages/agent-runtime/src/default-runtime.test.ts` 内追加：

```ts
it("caps the request output tokens at the configured ceiling", async () => {
  const requested: Array<number | undefined> = [];
  const runtime = await createVykorRuntime({
    settings: { ...BASE_SETTINGS, sandbox: { enabled: false } },
    configuration: {
      resolveModelOutputLimit: async () => 384_000,
      client: {
        async *streamMessage(input) {
          requested.push(input.maxTokens);
          yield { type: "complete" as const, stopReason: "end_turn" as const };
        },
      },
    },
    requestConfigurationStore: { read: async () => ({ revision: 0, configuration: { model: "model-a" } }) },
  });
  try {
    for await (const _ of runtime.queryEngine.submitMessage("hi")) { /* consume */ }
    expect(requested).toEqual([32_000]);
  } finally {
    await runtime.close();
  }
});

it("uses a smaller catalog output limit unchanged", async () => {
  const requested: Array<number | undefined> = [];
  const runtime = await createVykorRuntime({
    settings: { ...BASE_SETTINGS, sandbox: { enabled: false } },
    configuration: {
      resolveModelOutputLimit: async () => 4_096,
      client: {
        async *streamMessage(input) {
          requested.push(input.maxTokens);
          yield { type: "complete" as const, stopReason: "end_turn" as const };
        },
      },
    },
    requestConfigurationStore: { read: async () => ({ revision: 0, configuration: { model: "model-a" } }) },
  });
  try {
    for await (const _ of runtime.queryEngine.submitMessage("hi")) { /* consume */ }
    expect(requested).toEqual([4_096]);
  } finally {
    await runtime.close();
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @vykor/agent-runtime test -- default-runtime.test.ts`
Expected: FAIL，`input.maxTokens` 为 `undefined`（配置里还没有 `resolveModelOutputLimit`，需要先补类型才能通过类型检查）。

- [ ] **Step 3: 类型与解析器打通**

`packages/agent-runtime/src/agent-options.ts` 第 82 行之后加：

```ts
  resolveModelOutputLimit?: (input: { provider?: string; model: string }) => Promise<number | undefined>;
```

`packages/server/src/daemon/daemon-agent.ts` 第 88-91 行之后加：

```ts
  resolveModelOutputLimit?(input: {
    provider?: string;
    model: string;
  }): Promise<number | undefined> | number | undefined;
```

同文件第 226 行（`resolveModelContextWindow` 透传块）之后加：

```ts
      ...(options.resolveModelOutputLimit
        ? { resolveModelOutputLimit: async (input) =>
            await options.resolveModelOutputLimit!(input) }
        : {}),
```

`packages/server/src/application/daemon-application.ts` 的 import（39-41 行）改为：

```ts
import {
  catalogModelContextWindow,
  catalogModelOutputLimit,
  catalogModelReasoningEfforts,
} from "./default-services/catalog-provider-mapping.js";
```

把 430-438 行的 `resolveModelContextWindow` 实现替换为：

```ts
        resolveModelContextWindow: async ({ provider, model }) => {
          if (!provider) return undefined;
          return catalogModelContextWindow(await this.modelCatalog.load(), provider, model);
        },
        resolveModelOutputLimit: async ({ provider, model }) => {
          if (!provider) return undefined;
          return catalogModelOutputLimit(await this.modelCatalog.load(), provider, model);
        },
```

- [ ] **Step 4: default-runtime 计算上限并注入**

`packages/agent-runtime/src/default-runtime.ts` 顶部加入值导入（若已有 `@vykor/core` 的 import，合并到其中）：

```ts
import { DEFAULT_OUTPUT_TOKEN_MAX } from "@vykor/core";
```

把第 309-320 行改为：

```ts
      const contextWindow = await configuration.resolveModelContextWindow?.({
        provider: requestConfiguration.provider,
        model: requestConfiguration.model,
      });
      const outputLimit = await configuration.resolveModelOutputLimit?.({
        provider: requestConfiguration.provider,
        model: requestConfiguration.model,
      });
      const outputCap = settings.outputTokenMax ?? DEFAULT_OUTPUT_TOKEN_MAX;
      const maxOutputTokens = resolveOutputTokenCap(outputLimit, outputCap);
      return {
        revision: snapshot.revision,
        ...snapshot.configuration,
        client: resolvedClient!,
        systemPrompt: systemPromptForRequest,
        maxOutputTokens,
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(contextWindow ? { contextWindow } : {}),
      };
```

- [ ] **Step 5: 运行测试确认通过**

Run: `pnpm --filter @vykor/agent-runtime test -- default-runtime.test.ts`
Expected: PASS。

Run: `pnpm --filter @vykor/agent-runtime check-types; pnpm --filter @vykor/server check-types`
Expected: 无类型错误。

- [ ] **Step 6: 提交**

```bash
git add packages/agent-runtime packages/server
git commit -m "feat(runtime): resolve catalog output limit and cap requests at 32k"
```

---

### Task 7: 全量验证

**Files:** 无（只跑验证）

- [ ] **Step 1: 跑受影响包的测试**

Run: `pnpm --filter @vykor/core test; pnpm --filter @vykor/api test; pnpm --filter @vykor/agent-runtime test; pnpm --filter @vykor/server test`
Expected: 全部 PASS，无新增失败。

- [ ] **Step 2: 全仓类型检查与架构边界检查**

Run: `pnpm check-types`
Expected: 无类型错误。

Run: `pnpm check:architecture`
Expected: PASS。这是防止误改 forbidden 清单的关键检查；若失败，先确认没有把 `maxTokens` 写进 `scripts/forbidden-compatibility-surfaces.json`，也没有遗留 `settings.maxTokens` 引用。

- [ ] **Step 3: 手动核对真实会话复盘数据**

Run: `pnpm --filter @rzx/ohs build` 后，用本机 daemon 跑一次包含长 reasoning 的 prompt（可选），确认本次修复后 `session_run.metadata_json.stopReason` 在截断时为 `"max_tokens"` 且存在可见提示。若不跑实机，则跳过并在 PR 说明中标注未做端到端验证。

- [ ] **Step 4: 提交（如有残留改动）**

```bash
git status
```

如无改动则无需提交。

---

## Self-Review

- **Spec 覆盖**：A（截断可见）= Task 1+2；B（32k 上限 + 目录透传）= Task 3+4+5+6；C（文案/配置可观测）= Task 2 文案 + Task 3 删死配置 + README。
- **占位符扫描**：无 TBD / TODO；每个代码步骤含完整代码。
- **类型一致性**：`maxOutputTokens`（请求配置）、`outputTokenMax`（settings）、`DEFAULT_OUTPUT_TOKEN_MAX`（常量）、`catalogModelOutputLimit`（目录助手）、`resolveModelOutputLimit`（host 解析器）命名在全部任务中一致。
- **审计修正记录**（由子代理审计后修订）：
  1. 删除「把 `maxTokens` 加入 forbidden 清单」的步骤——该清单是全仓正则扫描，会误伤 25 处合法 `maxTokens`，改为在 `settings.test.ts` 里直接断言 `settings.maxTokens` 被拒。
  2. 存量用户 `~/.vykor/settings.json` 可能仍带 `maxTokens`（旧默认值持久化）；按需求不做兼容，加载时直接拒绝，需用户手动删除该字段。
  2. 补充 `SOFT_RUNTIME_INVALIDATE_KEYS` 加 `"outputTokenMax"`，否则预热 session 不生效。
  3. Task 7 增加 `pnpm check:architecture`。
  4. 明确 Task 2 测试放在 `Integration: Full Agent Loop` describe。
- **已知未覆盖（可接受）**：`anthropic.ts` 的 `?? DEFAULT_OUTPUT_TOKEN_MAX` 兜底只有类型/对称保证，未加单独测试（其调用链与 openai 相同，均由 engine 显式传值）；`README.md:601` 处压缩示意图里的 `maxTokens - 33k buffer` 描述的是 `CompactService` 内部字段，仍然成立，不在本次改动范围。
