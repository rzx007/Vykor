# 自定义供应商模型上限声明 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 允许在自定义供应商的每个模型上声明「上下文大小」和「最大输出」，界面展示与会话运行时两条取值路径都以声明值为准，留空时保持现有目录 / 默认行为。

**架构：** 在 `@vykor/core` 增加纯函数 `resolveCustomProviderModelLimits`，统一从 `Settings.customProviders` 读声明值；写入侧由服务端 `normalizeCustomProvider` 校验并持久化，客户端与桌面主进程只扩展入参类型；读取侧改两处——`model-service`（界面展示，同时也是上下文用量条分母的来源）与 `daemon-application` 的两个运行时回调（自动压缩的上下文上限、单次请求 `max_tokens`）。两处都遵循「声明值 → 目录值 → 现有默认」。

**技术栈：** TypeScript、Vitest、pnpm workspace（`@vykor/core`、`@vykor/server`、`@vykor/agent-runtime`、`@vykor/client`、`@vykor/desktop`）。

**规格：** `docs/superpowers/specs/2026-10-08-custom-provider-model-limits-design.md`

---

## 文件结构

全部为既有文件的修改，**不新增源文件**：

写入链路

- `packages/core/src/types/settings.ts` — 持久化类型加两个可选字段。
- `packages/client/src/types/index.ts` — 客户端入参加两个可选字段。
- `apps/desktop/src/shared/provider-types.ts` — 主进程入参加两个可选字段，快照加 `declaredModels`。
- `packages/server/src/application/settings-api.ts` — 服务端入参加两个可选字段。
- `packages/server/src/application/default-services/provider-service.ts` — 写入时保留合法正整数。

取值函数

- `packages/core/src/config/settings.ts` — 新增 `resolveCustomProviderModelLimits`。
- `packages/core/src/index.ts` — 导出该函数。

读取链路

- `packages/server/src/application/default-services/model-service.ts` — 展示路径合并声明值。
- `packages/agent-runtime/src/agent-options.ts` — 两个运行时回调类型加 `settings`。
- `packages/server/src/daemon/daemon-agent.ts` — 同上（宿主侧类型）。
- `packages/agent-runtime/src/default-runtime.ts` — 调用回调时传当前 `settings`。
- `packages/server/src/application/daemon-application.ts` — 回调实现先查声明值。

桌面界面

- `apps/desktop/src/main/features/provider/provider-service.ts` — 快照透出 `declaredModels`。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-form.ts` — 表单字段、数字校验、`initialForm` 迁入并导出。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-dialog.tsx` — 模型行改两行布局、改用迁入的 `initialForm`。

测试只追加到既有测试文件：

- `packages/core/src/config/settings.test.ts`
- `packages/server/src/application/__test__/default-application-services.test.ts`
- `packages/agent-runtime/src/default-runtime.test.ts`
- `apps/desktop/src/main/features/provider/provider-service.test.ts`
- `apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-form.test.ts`

---

## 任务 1：core 声明值类型与取数函数

**文件：**

- 修改：`packages/core/src/types/settings.ts:118-123`
- 修改：`packages/core/src/config/settings.ts:14-18`
- 修改：`packages/core/src/index.ts:241-253`
- 测试：`packages/core/src/config/settings.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `packages/core/src/config/settings.test.ts` 顶部从 `./settings.js` 的 import 里加入 `resolveCustomProviderModelLimits`（与 `resolveOutputTokenCap` 同一处），并追加：

```ts
function settingsWithDeclaredModels(
  models: Array<{ id: string; contextWindow?: number; outputLimit?: number }>,
): Settings {
  return {
    model: "chat",
    apiFormat: "openai",
    maxTurns: 10,
    permission: { mode: "default" },
    customProviders: [
      { id: "gateway", displayName: "Gateway", baseUrl: "http://localhost/v1", apiFormat: "openai", models },
    ],
  };
}

describe("resolveCustomProviderModelLimits", () => {
  it("returns declared limits for one model", () => {
    const settings = settingsWithDeclaredModels([
      { id: "chat", contextWindow: 200_000, outputLimit: 16_384 },
    ]);
    expect(resolveCustomProviderModelLimits(settings, "gateway", "chat")).toEqual({
      contextWindow: 200_000,
      outputLimit: 16_384,
    });
  });

  it("returns only the declared field when the other is absent", () => {
    const settings = settingsWithDeclaredModels([{ id: "chat", contextWindow: 200_000 }]);
    expect(resolveCustomProviderModelLimits(settings, "gateway", "chat")).toEqual({
      contextWindow: 200_000,
    });
  });

  it("returns undefined for an unknown provider or model", () => {
    const settings = settingsWithDeclaredModels([{ id: "chat", contextWindow: 200_000 }]);
    expect(resolveCustomProviderModelLimits(settings, "other", "chat")).toBeUndefined();
    expect(resolveCustomProviderModelLimits(settings, "gateway", "other")).toBeUndefined();
  });

  it("returns undefined when nothing is declared", () => {
    expect(
      resolveCustomProviderModelLimits(settingsWithDeclaredModels([{ id: "chat" }]), "gateway", "chat"),
    ).toBeUndefined();
    expect(
      resolveCustomProviderModelLimits(
        { model: "chat", apiFormat: "openai", maxTurns: 10, permission: { mode: "default" } },
        "gateway",
        "chat",
      ),
    ).toBeUndefined();
  });

  it("ignores non-positive-integer persisted values", () => {
    const settings = settingsWithDeclaredModels([{ id: "chat", contextWindow: 0, outputLimit: -5 }]);
    expect(resolveCustomProviderModelLimits(settings, "gateway", "chat")).toBeUndefined();
  });

  it("matches the provider id case-insensitively", () => {
    const settings = settingsWithDeclaredModels([{ id: "chat", contextWindow: 1_000 }]);
    expect(resolveCustomProviderModelLimits(settings, "Gateway", "chat")).toEqual({ contextWindow: 1_000 });
  });
});
```

> 该文件当前**没有** import `Settings` 类型（`packages/core/src/config/settings.test.ts:7` 只从 `./settings.js` 导入），需要在顶部新增一行 `import type { Settings } from "../types/settings.js";`。

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @vykor/core exec vitest run src/config/settings.test.ts`
预期：FAIL，报错提示 `resolveCustomProviderModelLimits` 不是 `./settings.js` 的导出。

- [ ] **步骤 3：把类型字段加上**

`packages/core/src/types/settings.ts` 的 `CustomProviderModelSettings`（L118-123）：

```ts
export interface CustomProviderModelSettings {
  id: string;
  displayName: string;
  /** Missing persisted values are read conservatively as unknown. */
  imageInputSupport?: InputSupport;
  /** User-declared context window in tokens; absent means "read from catalog / default". */
  contextWindow?: number;
  /** User-declared max output in tokens; absent means "read from catalog / default". */
  outputLimit?: number;
}
```

- [ ] **步骤 4：实现取数函数**

在 `packages/core/src/config/settings.ts` 的 `resolveOutputTokenCap`（L14-18）之后追加：

```ts
/** Positive safe integers survive; everything else counts as "not declared". */
function declaredPositiveLimit(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

/**
 * Reads user-declared token limits for one custom-provider model.
 * Returns undefined when neither field is declared, so callers fall back to
 * the models.dev catalog and then to their existing default.
 */
export function resolveCustomProviderModelLimits(
  settings: Settings,
  provider: string | undefined,
  model: string,
): { contextWindow?: number; outputLimit?: number } | undefined {
  if (!provider) return undefined;
  const providerId = provider.trim().toLowerCase();
  const declaredProvider = settings.customProviders?.find(
    (item) => item.id === providerId,
  );
  const declaredModel = declaredProvider?.models.find((item) => item.id === model);
  if (!declaredModel) return undefined;
  const contextWindow = declaredPositiveLimit(declaredModel.contextWindow);
  const outputLimit = declaredPositiveLimit(declaredModel.outputLimit);
  if (contextWindow === undefined && outputLimit === undefined) return undefined;
  return {
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(outputLimit !== undefined ? { outputLimit } : {}),
  };
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`pnpm --filter @vykor/core exec vitest run src/config/settings.test.ts`
预期：PASS，新增 6 个用例与既有用例全绿。

- [ ] **步骤 6：导出函数并做类型检查**

`packages/core/src/index.ts` 的导出块（L241-253）里，`resolveOutputTokenCap,`（L245）后追加一行 `resolveCustomProviderModelLimits,`。

运行：`pnpm --filter @vykor/core check-types`
预期：无错误。

- [ ] **步骤 7：Commit**

```bash
git add packages/core/src/types/settings.ts packages/core/src/config/settings.ts packages/core/src/config/settings.test.ts packages/core/src/index.ts
git commit -m "feat(core): 自定义供应商模型可声明上下文与最大输出上限"
```

---

## 任务 2：写入时校验并持久化

**文件：**

- 修改：`packages/server/src/application/settings-api.ts:38-42`
- 修改：`packages/server/src/application/default-services/provider-service.ts:441-447`
- 修改：`packages/client/src/types/index.ts:282-291`
- 修改：`apps/desktop/src/shared/provider-types.ts:69-73`
- 测试：`packages/server/src/application/__test__/default-application-services.test.ts:444`

- [ ] **步骤 1：编写失败的测试**

在 `default-application-services.test.ts` 的 `creates a custom provider and exposes it with declared models`（L444）用例之后追加，照抄该用例的夹具写法（`vi.stubGlobal("fetch", ...)`、`ref`、`createDefaultProviderService(ref)`）：

```ts
it("persists declared model limits and drops invalid ones", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
  );
  const ref = {
    current: {
      model: "m",
      apiFormat: "openai" as const,
      provider: "openai",
      maxTurns: 50,
      permission: { mode: "default" as const },
    },
  };
  const providers = createDefaultProviderService(ref);

  await providers.create({
    id: "office-gateway",
    displayName: "Office Gateway",
    baseUrl: "https://gateway.example/v1",
    apiFormat: "openai",
    apiKey: "secret",
    models: [
      { id: "chat", displayName: "Chat", contextWindow: 200_000, outputLimit: 16_384 },
      { id: "broken", displayName: "Broken", contextWindow: 0, outputLimit: -1 },
      { id: "half", displayName: "Half", contextWindow: 128_000 },
      { id: "bare", displayName: "Bare" },
    ],
  });

  expect(ref.current.customProviders).toEqual([
    {
      id: "office-gateway",
      displayName: "Office Gateway",
      baseUrl: "https://gateway.example/v1",
      apiFormat: "openai",
      models: [
        { id: "chat", displayName: "Chat", contextWindow: 200_000, outputLimit: 16_384 },
        { id: "broken", displayName: "Broken" },
        { id: "half", displayName: "Half", contextWindow: 128_000 },
        { id: "bare", displayName: "Bare" },
      ],
    },
  ]);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @vykor/server exec vitest run src/application/__test__/default-application-services.test.ts -t "persists declared model limits"`
预期：FAIL，`contextWindow` / `outputLimit` 未出现在持久化结果里。

- [ ] **步骤 3：扩展三处入参类型**

`packages/server/src/application/settings-api.ts` L38-42：

```ts
export interface CustomProviderModelInput {
  id: string;
  displayName: string;
  imageInputSupport?: InputSupport;
  contextWindow?: number;
  outputLimit?: number;
}
```

`packages/client/src/types/index.ts` 的 `CustomProviderInput.models` 元素（L282 起）在 `imageInputSupport?: InputSupport;` 后加 `contextWindow?: number;`、`outputLimit?: number;`。

`apps/desktop/src/shared/provider-types.ts` L69-73：

```ts
  models: Array<{
    id: string
    displayName: string
    imageInputSupport?: DesktopInputSupport
    contextWindow?: number
    outputLimit?: number
  }>
```

- [ ] **步骤 4：写入时保留合法正整数**

在 `packages/server/src/application/default-services/provider-service.ts` 的 `normalizeCustomProvider` 之前加入：

```ts
/** Out-of-range declarations are dropped instead of rejecting the whole save. */
function isDeclaredLimit(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 10_000_000;
}
```

并把 `normalizeCustomProvider` 里构造 `models` 的那段（L441-447）改为：

```ts
  const models = input.models.map((model) => ({
    id: model.id?.trim(),
    displayName: model.displayName?.trim() || model.id?.trim(),
    ...(model.imageInputSupport ? { imageInputSupport: model.imageInputSupport } : {}),
    ...(isDeclaredLimit(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
    ...(isDeclaredLimit(model.outputLimit) ? { outputLimit: model.outputLimit } : {}),
  }));
```

- [ ] **步骤 5：运行测试验证通过**

运行：`pnpm --filter @vykor/server exec vitest run src/application/__test__/default-application-services.test.ts`
预期：PASS。

- [ ] **步骤 6：类型检查**

运行：`pnpm --filter @vykor/server check-types` 与 `pnpm --filter @vykor/client check-types`
预期：无错误。

- [ ] **步骤 7：Commit**

```bash
git add packages/server/src/application/settings-api.ts packages/server/src/application/default-services/provider-service.ts packages/client/src/types/index.ts apps/desktop/src/shared/provider-types.ts packages/server/src/application/__test__/default-application-services.test.ts
git commit -m "feat(server): 自定义供应商写入时保留声明的模型上限"
```

---

## 任务 3：展示路径合并声明值

**文件：**

- 修改：`packages/server/src/application/default-services/model-service.ts:66-86`
- 测试：`packages/server/src/application/__test__/default-application-services.test.ts`

- [ ] **步骤 1：编写失败的测试**

在同文件的写入用例之后追加（该文件 L503 已经在用 `createDefaultModelService(ref).list()`，沿用同一写法）：

```ts
it("exposes declared model limits through the model service", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
  );
  const ref = {
    current: {
      model: "chat",
      apiFormat: "openai" as const,
      provider: "openai",
      maxTurns: 50,
      permission: { mode: "default" as const },
      customProviders: [
        {
          id: "gateway",
          displayName: "Gateway",
          baseUrl: "https://gateway.example/v1",
          apiFormat: "openai" as const,
          models: [
            { id: "chat", displayName: "Chat", contextWindow: 200_000, outputLimit: 16_384 },
            { id: "bare", displayName: "Bare" },
          ],
        },
        {
          id: "openrouter",
          displayName: "OpenRouter",
          baseUrl: "https://gateway.example/v1",
          apiFormat: "openai" as const,
          source: "models.dev" as const,
          models: [{ id: "openai/gpt-4o", displayName: "GPT-4o", contextWindow: 1_234_567 }],
        },
      ],
    },
  };

  const providers = await createDefaultModelService(ref).list();

  const gateway = providers.find((item) => item.name === "gateway");
  expect(gateway?.models).toContainEqual(
    expect.objectContaining({ id: "chat", contextWindow: 200_000, outputLimit: 16_384 }),
  );
  expect(gateway?.models).toContainEqual(expect.objectContaining({ id: "bare" }));

  // 无论目录里有没有这个 model，声明值都必须胜出。
  const overridden = providers
    .find((item) => item.name === "openrouter")
    ?.models.find((model) => model.id === "openai/gpt-4o");
  expect(overridden?.contextWindow).toBe(1_234_567);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @vykor/server exec vitest run src/application/__test__/default-application-services.test.ts -t "exposes declared model limits"`
预期：FAIL，`contextWindow` 为 `undefined`。

- [ ] **步骤 3：实现声明值合并**

把 `packages/server/src/application/default-services/model-service.ts` L66-86 的 `provider.models.map(...)` 改为：

```ts
          models: provider.models.map((model) => {
            const declared = {
              ...(typeof model.contextWindow === "number"
                ? { contextWindow: model.contextWindow }
                : {}),
              ...(typeof model.outputLimit === "number"
                ? { outputLimit: model.outputLimit }
                : {}),
            };
            const catalogModel = catalogModels?.get(model.id);
            if (catalogModel) {
              return {
                ...toModelInfo(provider.id, provider.displayName, model.id, catalogModel),
                ...declared,
              };
            }
            return {
              id: model.id,
              label: model.displayName,
              provider: provider.displayName,
              providerName: provider.id,
              status: "active" as const,
              inputCapabilities: {
                image: normalizeInputSupport(model.imageInputSupport),
              },
              ...declared,
            };
          }),
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @vykor/server exec vitest run src/application/__test__/default-application-services.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add packages/server/src/application/default-services/model-service.ts packages/server/src/application/__test__/default-application-services.test.ts
git commit -m "feat(server): 模型列表以声明的上限覆盖目录值"
```

---

## 任务 4：运行时回调先查声明值

**文件：**

- 修改：`packages/agent-runtime/src/agent-options.ts:90-92`
- 修改：`packages/server/src/daemon/daemon-agent.ts:97-104`
- 修改：`packages/agent-runtime/src/default-runtime.ts:324-331`
- 修改：`packages/server/src/application/daemon-application.ts:507-514`
- 测试：`packages/agent-runtime/src/default-runtime.test.ts:793`

- [ ] **步骤 1：编写失败的测试**

在 `packages/agent-runtime/src/default-runtime.test.ts` 的 `derives the request output cap from the catalog output size`（L793）之后追加，照抄该用例的 `createVykorRuntime` 夹具：

```ts
it("passes the current settings to the model capacity callbacks", async () => {
  const seen: Array<{ provider?: string; model: string; outputTokenMax?: number }> = [];
  const runtime = await createVykorRuntime({
    settings: { ...BASE_SETTINGS, outputTokenMax: 12_345, sandbox: { enabled: false } },
    configuration: {
      resolveModelOutputLimit: async ({ provider, model, settings: passed }) => {
        seen.push({ provider, model, outputTokenMax: passed.outputTokenMax });
        return undefined;
      },
      client: {
        async *streamMessage() {
          yield { type: "complete" as const, stopReason: "end_turn" as const };
        },
      },
    },
    requestConfigurationStore: {
      read: async () => ({ revision: 0, configuration: { model: "model-a", provider: "gateway" } }),
    },
  });
  try {
    for await (const _ of runtime.queryEngine.submitMessage("hi")) { /* consume */ }
    // 该回调每次 `submitMessage` 会被调用多次：首轮解析一次（`query-engine.ts:275`），
    // 无工具调用的回合边界再解析一次（`:721-722`）。所以只断言首元素，不要比对整个数组。
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toEqual({ provider: "gateway", model: "model-a", outputTokenMax: 12_345 });
  } finally {
    await runtime.close();
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @vykor/agent-runtime exec vitest run src/default-runtime.test.ts -t "passes the current settings"`
预期：FAIL，`passed` 为 `undefined`（回调收到 `{ provider, model }`，没有 `settings`）。

- [ ] **步骤 3：扩展两处回调类型**

`packages/agent-runtime/src/agent-options.ts` L90-92：

```ts
  /** Host-owned model capacity lookup; absent for SDK callers without a catalog. */
  resolveModelContextWindow?: (input: { provider?: string; model: string; settings: Settings }) => Promise<number | undefined>;
  /** Host-owned output capacity lookup; absent for SDK callers without a catalog. */
  resolveModelOutputLimit?: (input: { provider?: string; model: string; settings: Settings }) => Promise<number | undefined>;
```

`packages/server/src/daemon/daemon-agent.ts` L97-104：

```ts
  resolveModelContextWindow?(input: {
    provider?: string;
    model: string;
    settings: Settings;
  }): Promise<number | undefined> | number | undefined;
  resolveModelOutputLimit?(input: {
    provider?: string;
    model: string;
    settings: Settings;
  }): Promise<number | undefined> | number | undefined;
```

> 两个文件都需要 `Settings` 类型。`daemon-agent.ts` 应已有；`agent-options.ts` 若没有，从 `@vykor/core` 加 type-only import。

- [ ] **步骤 4：调用时传入当前 settings**

`packages/agent-runtime/src/default-runtime.ts` L324-331：

```ts
      const contextWindow = await configuration.resolveModelContextWindow?.({
        provider: requestConfiguration.provider,
        model: requestConfiguration.model,
        settings,
      });
      const outputLimit = await configuration.resolveModelOutputLimit?.({
        provider: requestConfiguration.provider,
        model: requestConfiguration.model,
        settings,
      });
```

> `settings` 已在同一作用域（L332 的 `settings.outputTokenMax` 就在用它），无需新增变量。

- [ ] **步骤 5：运行测试验证通过**

运行：`pnpm --filter @vykor/agent-runtime exec vitest run src/default-runtime.test.ts`
预期：PASS。

- [ ] **步骤 6：实现先查声明值的回调**

`packages/server/src/application/daemon-application.ts` L507-514：

```ts
        resolveModelContextWindow: async ({ provider, model, settings }) => {
          if (!provider) return undefined;
          const declared = resolveCustomProviderModelLimits(settings, provider, model);
          if (declared?.contextWindow !== undefined) return declared.contextWindow;
          return catalogModelContextWindow(await this.modelCatalog.load(), provider, model);
        },
        resolveModelOutputLimit: async ({ provider, model, settings }) => {
          if (!provider) return undefined;
          const declared = resolveCustomProviderModelLimits(settings, provider, model);
          if (declared?.outputLimit !== undefined) return declared.outputLimit;
          return catalogModelOutputLimit(await this.modelCatalog.load(), provider, model);
        },
```

在同文件新增一行**值导入**，不要并进 L3 那条（L3 是 `import type { AgentBackgroundShellHost, Settings } from "@vykor/core"`，类型专用导入里放值会报 TS1361）：

```ts
import { resolveCustomProviderModelLimits } from "@vykor/core";
```

`@vykor/server` 已依赖 `@vykor/core`，插入位置无额外约束。

- [ ] **步骤 7：类型检查**

运行：`pnpm --filter @vykor/server check-types` 与 `pnpm --filter @vykor/agent-runtime check-types`
预期：无错误。

- [ ] **步骤 8：Commit**

```bash
git add packages/agent-runtime/src/agent-options.ts packages/agent-runtime/src/default-runtime.ts packages/agent-runtime/src/default-runtime.test.ts packages/server/src/daemon/daemon-agent.ts packages/server/src/application/daemon-application.ts
git commit -m "feat(agent-runtime): 运行时模型上限优先采用声明的值"
```

---

## 任务 5：桌面快照透出声明值

**文件：**

- 修改：`apps/desktop/src/shared/provider-types.ts:14-30`
- 修改：`apps/desktop/src/main/features/provider/provider-service.ts:213-254`、`164-182`
- 测试：`apps/desktop/src/main/features/provider/provider-service.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `provider-service.test.ts` 的 `merges provider, auth, settings and model state without exposing credentials` 用例（L38）之后追加，照抄它的 `providers` / `auth` 字面量形状：

```ts
it("exposes declared model limits without overwriting resolved models", () => {
  const snapshot = buildDesktopProviderSnapshot({
    providers: [{ name: "gateway", displayName: "Gateway", hasKey: true, active: false }],
    auth: {
      codex: { configured: false, state: "unconfigured", source: "" },
      storedProviders: [],
      envProviders: [],
    },
    settings: {
      provider: "gateway",
      model: "chat",
      customProviders: [
        {
          id: "gateway",
          displayName: "Gateway",
          baseUrl: "http://localhost/v1",
          apiFormat: "openai",
          models: [
            { id: "chat", displayName: "Chat", contextWindow: 200_000, outputLimit: 16_384 },
            { id: "bare", displayName: "Bare" },
          ],
        },
      ],
    },
    models: [
      {
        name: "gateway",
        displayName: "Gateway",
        models: [
          {
            id: "chat",
            label: "Chat",
            contextWindow: 128_000,
            provider: "Gateway",
            providerName: "gateway",
            inputCapabilities: { image: "unknown" },
          },
        ],
      },
    ],
  })

  const provider = snapshot.providers.find((item) => item.name === "gateway")
  expect(provider?.declaredModels).toEqual([
    { id: "chat", contextWindow: 200_000, outputLimit: 16_384 },
    { id: "bare" },
  ])
  // models 仍是被解析后的值，不被声明值覆盖。
  expect(provider?.models.find((model) => model.id === "chat")?.contextWindow).toBe(128_000)
})
```

> 若 `auth.codex` 的 `state` / `source` 字面量类型报错，照抄同文件第一条用例里的 `auth` 对象。

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @vykor/desktop exec vitest run src/main/features/provider/provider-service.test.ts`
预期：FAIL，`declaredModels` 为 `undefined`。

- [ ] **步骤 3：加类型字段**

`apps/desktop/src/shared/provider-types.ts` 的 `DesktopProviderInfo`（L14-30）在 `models: DesktopProviderModel[]` 后追加：

```ts
  /** Raw values the user typed, keyed by model id; used to refill the edit dialog. */
  declaredModels?: Array<{ id: string; contextWindow?: number; outputLimit?: number }>
```

`DesktopProviderModel` 保持不动。

- [ ] **步骤 4：解析并透出声明值**

`apps/desktop/src/main/features/provider/provider-service.ts` 的 `CustomProviderSettingView`（L213-220）追加：

```ts
  models?: Array<{ id: string; contextWindow?: number; outputLimit?: number }>
```

在同文件 `customProviderSettings` 的 entries 构造里，与 `headers` 解析并列加入：

```ts
    const models = Array.isArray(record.models)
      ? record.models.flatMap(
          (item): Array<{ id: string; contextWindow?: number; outputLimit?: number }> => {
            if (!item || typeof item !== "object") return []
            const entry = item as Record<string, unknown>
            if (typeof entry.id !== "string") return []
            return [
              {
                id: entry.id,
                ...(typeof entry.contextWindow === "number"
                  ? { contextWindow: entry.contextWindow }
                  : {}),
                ...(typeof entry.outputLimit === "number"
                  ? { outputLimit: entry.outputLimit }
                  : {}),
              },
            ]
          }
        )
      : undefined
```

并把 `models` 并入返回的视图对象（`...(models ? { models } : {})`）。

在 `buildDesktopProviderSnapshot` 的 provider 返回对象里（L178-181 那一组 `...(custom?.xxx ? ...)` 之后）追加：

```ts
      ...(custom?.models?.length ? { declaredModels: custom.models } : {}),
```

- [ ] **步骤 5：运行测试验证通过**

运行：`pnpm --filter @vykor/desktop exec vitest run src/main/features/provider/provider-service.test.ts`
预期：PASS。

- [ ] **步骤 6：类型检查**

运行：`pnpm --filter @vykor/desktop run typecheck:node`
预期：无错误。

- [ ] **步骤 7：Commit**

```bash
git add apps/desktop/src/shared/provider-types.ts apps/desktop/src/main/features/provider/provider-service.ts apps/desktop/src/main/features/provider/provider-service.test.ts
git commit -m "feat(desktop): 供应商快照透出用户声明的模型上限"
```

---

## 任务 6：表单字段、数字校验与回填构造

**文件：**

- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-form.ts`
- 测试：`apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-form.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `custom-provider-form.test.ts` 里把 import 行改为：

```ts
import { initialCustomProviderForm, validateCustomProviderForm } from "./custom-provider-form"
```

`CustomProviderModelRow` 新增的两个字段是必填，所以文件里**四处**模型字面量都要补齐，否则任务 7 步骤 4 的 `typecheck:web` 会因为缺属性失败（`tsconfig.web.json` 的 include 覆盖 `src/renderer/src/**/*`，含 `*.test.ts`；vitest 用 esbuild 不做类型检查，所以这四处不会在步骤 2 / 步骤 4 里暴露）：

- `validForm.models[0]`（`custom-provider-form.test.ts:10-15`）
- `:55-60` 的内联字面量
- `:68-69` 的两个内联字面量
- `:82-83` 的两个内联字面量

各补 `contextWindow: ""`、`outputLimit: ""`（既有 `toEqual` 断言的是返回值，不受影响），并追加：

```ts
describe("declared model limits", () => {
  it("parses numeric strings into declared limits", () => {
    const result = validateCustomProviderForm({
      ...validForm,
      models: [{ key: "model-1", id: "team-model", displayName: "Team Model", imageInputSupport: "native", contextWindow: " 200000 ", outputLimit: "16384" }],
    })
    expect(result).toMatchObject({
      ok: true,
      value: { models: [{ id: "team-model", contextWindow: 200_000, outputLimit: 16_384 }] },
    })
  })

  it("omits blank fields instead of writing zero", () => {
    const result = validateCustomProviderForm({
      ...validForm,
      models: [{ key: "model-1", id: "team-model", displayName: "Team Model", imageInputSupport: "native", contextWindow: "  ", outputLimit: "" }],
    })
    expect(result).toMatchObject({ ok: true, value: { models: [{ id: "team-model" }] } })
  })

  it.each(["0", "-1", "1.5", "abc", "20000000"])("rejects invalid limit %s", (raw) => {
    const result = validateCustomProviderForm({
      ...validForm,
      models: [{ key: "model-1", id: "team-model", displayName: "Team Model", imageInputSupport: "native", contextWindow: raw, outputLimit: "" }],
    })
    expect(result).toEqual({
      ok: false,
      field: "models",
      message: "第 1 个模型的上下文大小必须是 1 ~ 10000000 的整数。",
    })
  })

  it.each(["0", "-1", "1.5", "abc", "20000000"])("rejects invalid output limit %s", (raw) => {
    const result = validateCustomProviderForm({
      ...validForm,
      models: [
        {
          key: "model-1",
          id: "team-model",
          displayName: "Team Model",
          imageInputSupport: "native",
          contextWindow: "200000",
          outputLimit: raw,
        },
      ],
    })
    expect(result).toEqual({
      ok: false,
      field: "models",
      message: "第 1 个模型的最大输出必须是 1 ~ 10000000 的整数。",
    })
  })
})

describe("initialCustomProviderForm", () => {
  it("refills limit inputs from declared values, not resolved ones", () => {
    const form = initialCustomProviderForm({
      name: "gateway",
      displayName: "Gateway",
      baseUrl: "http://localhost/v1",
      models: [{ id: "chat", label: "Chat", contextWindow: 128_000 }],
      declaredModels: [{ id: "chat", contextWindow: 200_000 }],
    })
    expect(form.models[0]).toMatchObject({
      id: "chat",
      displayName: "Chat",
      contextWindow: "200000",
      outputLimit: "",
    })
  })

  it("leaves limit inputs blank when the model has no declaration", () => {
    const form = initialCustomProviderForm({
      name: "gateway",
      displayName: "Gateway",
      baseUrl: "http://localhost/v1",
      models: [{ id: "chat", label: "Chat", contextWindow: 128_000 }],
    })
    expect(form.models[0]).toMatchObject({ contextWindow: "", outputLimit: "" })
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/settings-page/custom-provider-form.test.ts`
预期：FAIL，`initialCustomProviderForm` 未导出，且 `contextWindow` 未出现在解析结果中。

- [ ] **步骤 3：加字段并实现解析**

在 `custom-provider-form.ts` 里，`CustomProviderModelRow`（L4-9）追加两个字符串字段：

```ts
export interface CustomProviderModelRow {
  key: string
  id: string
  displayName: string
  imageInputSupport: DesktopInputSupport
  contextWindow: string
  outputLimit: string
}
```

分两步插入，顺序不能反。

**第一步**：在 `const models = form.models.map(...)`（`custom-provider-form.ts:54`）**之前**插入解析块。必须在前——下面改写的 `models` 映射会读它；若按「放在校验之后」写，就变成声明前引用，`tsc` 报 TS2448，运行时每次校验都抛 `ReferenceError: Cannot access 'parsedLimits' before initialization`。

```ts
  type ParsedLimit = number | undefined | "invalid"
  const parsedLimits = form.models.map(
    (model): { contextWindow: ParsedLimit; outputLimit: ParsedLimit } => ({
      contextWindow: parseDeclaredLimit(model.contextWindow),
      outputLimit: parseDeclaredLimit(model.outputLimit),
    })
  )
```

**第二步**：在既有的重复 ID 检查之后、headers 检查之前插入报错分支（保持既有报错顺序：空模型 → ID 为空 → ID 重复 → 数值非法 → headers）。

```ts
  const badIndex = parsedLimits.findIndex(
    (item) => item.contextWindow === "invalid" || item.outputLimit === "invalid"
  )
  if (badIndex >= 0) {
    const item = parsedLimits[badIndex]
    return {
      ok: false,
      field: "models",
      message:
        item.contextWindow === "invalid"
          ? `第 ${badIndex + 1} 个模型的上下文大小必须是 1 ~ 10000000 的整数。`
          : `第 ${badIndex + 1} 个模型的最大输出必须是 1 ~ 10000000 的整数。`,
    }
  }
```

> `parsedLimits[badIndex]` 与 `parsedLimits[index]` 都不需要可选链：桌面渲染端继承的 `@electron-toolkit/tsconfig` 没有开启 `noUncheckedIndexedAccess`（根 `tsconfig.json` 开了，但 `apps/desktop/tsconfig.web.json` 不继承根配置），索引结果的类型不是 `| undefined`；而且下标都来自同一个 `form.models`，必定在范围内。

**第三步**：把构造 `models` 的那段（既有 `const models = form.models.map(...)`）改为：

```ts
  const models = form.models.map((model, index) => {
    const contextWindow = parsedLimits[index].contextWindow
    const outputLimit = parsedLimits[index].outputLimit
    return {
      id: model.id.trim(),
      displayName: model.displayName.trim() || model.id.trim(),
      imageInputSupport: model.imageInputSupport,
      ...(typeof contextWindow === "number" ? { contextWindow } : {}),
      ...(typeof outputLimit === "number" ? { outputLimit } : {}),
    }
  })
```

在同文件底部加入 helper 与迁入的构造函数：

```ts
function parseDeclaredLimit(raw: string): number | undefined | "invalid" {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (!/^\d+$/.test(trimmed)) return "invalid"
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10_000_000) return "invalid"
  return parsed
}

export function initialCustomProviderForm(
  provider?: Pick<
    DesktopProviderInfo,
    "name" | "displayName" | "baseUrl" | "models" | "headers" | "secretHeaderNames"
  > & {
    declaredModels?: Array<{ id: string; contextWindow?: number; outputLimit?: number }>
  }
): CustomProviderFormState {
  const declaredById = new Map((provider?.declaredModels ?? []).map((item) => [item.id, item]))
  return {
    id: provider?.name ?? "",
    displayName: provider?.displayName ?? "",
    baseUrl: provider?.baseUrl ?? "",
    apiKey: "",
    models: provider?.models.length
      ? provider.models.map((model, index) => {
          const declared = declaredById.get(model.id)
          return {
            key: `model-${index}`,
            id: model.id,
            displayName: model.label,
            imageInputSupport: model.imageInputSupport ?? "unknown",
            contextWindow: declared?.contextWindow !== undefined ? String(declared.contextWindow) : "",
            outputLimit: declared?.outputLimit !== undefined ? String(declared.outputLimit) : "",
          }
        })
      : [
          {
            key: "model-0",
            id: "",
            displayName: "",
            imageInputSupport: "unknown",
            contextWindow: "",
            outputLimit: "",
          },
        ],
    headers: rowsFromHeaders(provider?.headers, provider?.secretHeaderNames),
    secretHeaderNames: provider?.secretHeaderNames,
  }
}
```

顶部 import 改为（新增 `DesktopProviderInfo` 类型与 `rowsFromHeaders`，后者是迁入的 `initialCustomProviderForm` 回填请求头所需）：

```ts
import type { DesktopCustomProviderInput, DesktopInputSupport, DesktopProviderInfo } from "@shared/provider-types"
import { headersFromRows, rowsFromHeaders, type RequestHeaderRow } from "./request-header-form"
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/settings-page/custom-provider-form.test.ts`
预期：PASS，既有用例与新增用例全绿。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-form.ts apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-form.test.ts
git commit -m "feat(desktop): 自定义供应商表单支持声明模型上限"
```

---

## 任务 7：弹框两行布局与回填接线

**文件：**

- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-dialog.tsx:54`、`63`、`186-199`、`206-282`、`318-342`

- [ ] **步骤 1：改用迁入的构造函数**

`custom-provider-dialog.tsx` 的 import 改为：

```ts
import { type CustomProviderFormState, initialCustomProviderForm, validateCustomProviderForm } from "./custom-provider-form"
```

把 `useState`（L54）与 `useEffect`（L63）里的 `initialForm(provider)` 都换成 `initialCustomProviderForm(provider)`，并删除文件底部的本地 `initialForm` 函数（L318-342）。

- [ ] **步骤 2：新增模型时带上空字段**

把「添加模型」按钮（L186-199）新增对象改为：

```ts
                        {
                          key: rowKey("model"),
                          id: "",
                          displayName: "",
                          imageInputSupport: "unknown",
                          contextWindow: "",
                          outputLimit: "",
                        },
```

- [ ] **步骤 3：模型行改两行布局**

把模型行（L206-282）外层改为两行、内层沿用现有元素：

```tsx
                {form.models.map((model, index) => (
                  <div key={model.key} className="flex flex-col gap-2 rounded-md border p-3">
                    <div className="grid grid-cols-[1fr_1fr_10rem_auto] gap-2">
                      {/* 现有 ID Input、显示名称 Input、图片能力 Select、删除 Button 原样保留，onChange 不改 */}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <Input
                        value={model.contextWindow}
                        inputMode="numeric"
                        aria-label={`模型 ${index + 1} 上下文大小`}
                        aria-invalid={invalid?.field === "models" || undefined}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            models: current.models.map((item) =>
                              item.key === model.key
                                ? { ...item, contextWindow: event.target.value }
                                : item
                            ),
                          }))
                        }
                        placeholder="上下文大小（token，留空即自动取值）"
                      />
                      <Input
                        value={model.outputLimit}
                        inputMode="numeric"
                        aria-label={`模型 ${index + 1} 最大输出`}
                        aria-invalid={invalid?.field === "models" || undefined}
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            models: current.models.map((item) =>
                              item.key === model.key
                                ? { ...item, outputLimit: event.target.value }
                                : item
                            ),
                          }))
                        }
                        placeholder="最大输出（token，留空即自动取值）"
                      />
                    </div>
                  </div>
                ))}
```

> 第一行四列的内容整体平移进内层 `grid`，不要改动它们的 `value` / `onChange` / `aria-label`。`Input` 为文件内已引入的组件库输入框。

- [ ] **步骤 4：类型检查**

运行：`pnpm --filter @vykor/desktop run typecheck:web`
预期：无错误。

- [ ] **步骤 5：Commit**

```bash
git add apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-dialog.tsx
git commit -m "feat(desktop): 自定义供应商弹框支持填写模型上限"
```

---

## 收尾

- [ ] 跑全部受影响包的类型检查：`pnpm --filter @vykor/core check-types`、`pnpm --filter @vykor/server check-types`、`pnpm --filter @vykor/agent-runtime check-types`、`pnpm --filter @vykor/client check-types`、`pnpm --filter @vykor/desktop run typecheck`。
- [ ] 请用户打开设置页实际看一眼两行布局、留空回填与非法输入提示（界面样式由用户确认，不做自动化截图）。
- [ ] 在下方「验证记录」补上实际跑过的测试与结果。

## 验证记录

（执行后填写）

## 不包含

- 不增加供应商级默认值，只按模型声明。
- 不给 `outputLimit` 增加单独的界面展示位（设置页与模型选择器的上限展示仍走既有链路）。
- 不改 models.dev 目录数据，不改内置供应商行为。
- 不自动拉取模型列表或探测真实上限。
- 不支持 Anthropic 自定义协议，与既有边界一致。

## 复核修订记录（第二轮）

对计划做了逐条代码核对，修正如下：

| # | 位置 | 问题 | 修正 |
|---|------|------|------|
| 1 | 任务 6 步骤 3 | `parsedLimits` 被指令放在 `const models = ...` 之后，而 `models` 的映射要读它 → TS2448，运行时抛 `ReferenceError` | 拆成「第一步 前移解析块 / 第二步 留原位插报错分支 / 第三步 改写映射」 |
| 2 | 任务 4 步骤 6 | `daemon-application.ts:3` 是 `import type`，往里加值会报 TS1361 | 改为新增独立一行值导入 |
| 3 | 任务 6 步骤 1 | 只提了 `validForm.models[0]`，漏掉 `custom-provider-form.test.ts` 另外三处内联模型字面量（`:55-60`、`:68-69`、`:82-83`），要到任务 7 的 `typecheck:web` 才暴露 | 明确列出四处并全部补齐 |
| 4 | 任务 1 步骤 1 | 断言「该文件已 import `Settings`」与实际不符 | 改为「当前没有，需新增 type-only import」 |
| 5 | 任务 6 步骤 1 | 只覆盖上下文非法分支，`outputLimit` 非法分支无断言 | 补一条 `it.each` 用例 |
| 6 | 架构摘要 | 把「上下文用量条分母」记在运行时回调名下 | 改为展示路径（`model-service` 的 `list()`），与设计文档一致 |

另有一条曾被判为「必然失败」的问题经核实不成立：`parsedLimits[index]` 是否触发 `noUncheckedIndexedAccess` 报错，取决于桌面渲染端的编译配置。`apps/desktop/tsconfig.web.json` 继承的是 `@electron-toolkit/tsconfig`，该开关未开启，根 `tsconfig.json` 里的同名开关不作用于桌面渲染端。已在任务 6 步骤 2 后加注说明，代码保持直接索引。

## 复核修订记录（第三轮）

第三轮复核专门核「文档里的代码事实是否成立」，每条都回到源码确认。设计文档的修正：

| # | 位置 | 问题 | 修正 |
|---|------|------|------|
| 1 | 「桌面快照与界面」 | 称 `outputLimit`「没有任何界面消费者」，与代码不符：模型选择器悬浮卡已经在渲染「最大输出」（`model-picker.tsx:160` 读 `DesktopModel.outputLimit`，字段定义 `apps/desktop/src/shared/session-types.ts:52`，取值来自 `listModels()` 的 `ProviderModelInfo.outputLimit`，`packages/client/src/types/index.ts:313-314`） | 改为「已有消费者」，并说明声明值会同时改动运行时行为与选择器展示 |
| 2 | 「校验」 | 抛 400 的引用写成 `provider-service.ts:426-453`，范围偏窄，且枚举里漏了 `apiFormat` | 改为 `:415-453`，枚举补上 `apiFormat` |
| 3 | 「沿用的既有行为」 | `resolveOutputTokenCap` 的描述不完整：漏了 `Math.round`，也没写明「小于等于 fallback 时原样保留」 | 补全三分支语义，并补上 `packages/core/src/config/settings.ts:14-18` 引用 |
| 4 | 「沿用的既有行为」 | `setOutputReserve` 引用写成 `:143-153`；更要紧的是漏了函数内部的 20000 下限 | 引用改为 `:148-153`，并新增一条：`MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000`（`compact-service.ts:67`、`:152`），换算后的上限不超过 20000 时压缩阈值不变 |
| 5 | 「沿用的既有行为」 | 称「`outputLimit` 只在运行时生效」，与事实不符 | 改为「设置页不新增展示位，但悬浮卡会显示」 |
| 6 | 「不包含」 | 「不新增 `outputLimit` 展示位」与第 1 条修正后的表述容易打架 | 补一句：悬浮卡里已有的展示不算新增 |

经核对**无需修改**的表述（同样已到源码验证）：

- 上下文用量条分母是裸 `contextWindow`、不做折扣（`packages/core/src/context-budget/assemble.ts:48-50`、`context-budget/types.ts:52` 的注释）。
- 压缩阈值公式 `threshold = maxTokens − outputReserve − AUTOCOMPACT_BUFFER_TOKENS`（`compact-service.ts:196-197`）。
- 目录来源供应商的写入口本身不带模型列表（`packages/client/src/types/index.ts:297-301`），所以「表单 + 服务端校验」这条分支对目录来源不可达。
- CLI 侧无需改动（`apps/cli/src/config-coerce.ts:17-19`、`packages/server/src/settings-transfer.ts:63-67`）。

计划文档本轮发现**一处会阻断执行的问题**，另有两处引用不精确，均已改：

| # | 位置 | 问题 | 修正 |
|---|------|------|------|
| 7 | 任务 4 步骤 1 | 新测试断言 `expect(seen).toEqual([{ provider, model, outputTokenMax }])`，但 `submitMessage` 每次调用会解析请求配置**两次**（首轮 `query-engine.ts:275`、无工具调用的回合边界 `:721-722`），而容量回调在 `default-runtime.ts:328` 是**无条件调用**。所以 `seen` 必有两个相同元素，按原样**即使用正确实现也会失败**，步骤 5 的「预期 PASS」不可达，执行者会被误导去改本来就对的实现 | 断言改为先判非空、再比对首元素（`seen.length > 0` + `seen[0]` 深比较），并在测试内加注释说明该回调每轮会被调用多次 |
| 8 | 任务 1（`packages/core/src/index.ts` 引用，出现两处） | 导出块写成 `241-251`，实际到第 `253` 行（`type McpServerConfigSnapshot,` 属于该块） | 两处都改为 `241-253`；插入锚点 `resolveOutputTokenCap,`（L245）本身无误 |
| 9 | 任务 5 步骤 1 | 引用的既有用例名被截短为 `merge provider, auth, settings and model state`，与实际 `it(...)` 全文不符（`provider-service.test.ts:38` 实为 `merges provider, auth, settings and model state without exposing credentials`），按名字定位会找不到 | 改为用例名全文并标出行号 |

另：架构摘要只把 `outputLimit` 归到「单次请求 `max_tokens`」，没有声称它会改变压缩阈值，与第 4 条修正后的说法一致，无需改动。
