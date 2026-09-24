# 推理强度（Reasoning Effort）按会话控制 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让声明了 effort 档位的模型能显示档位、按会话选择，并把选中值以 `reasoning_effort` 发给 OpenAI 兼容后端；未声明则不显示、不发送。

**架构：** models.dev 目录的 `reasoning_options` 经共享派生函数转成 `reasoningEfforts`；会话选择写入 `metadata.runtime.effort`；daemon 组装 Agent 时用目录校验选择值 ∈ 声明档位，产出 `reasoningEffort` 一路透传到 OpenAI 请求体。`effort` 放宽为自由字符串，空字符串作为「已清除」哨兵。

**技术栈：** TypeScript、pnpm workspace + turbo、Vitest、Electron（桌面端）、openai@4.104.0 SDK。

**规格：** `docs/superpowers/specs/2026-09-19-reasoning-effort-control-design.md`

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `packages/api/src/models/catalog.ts` | 声明 `ModelsDevReasoningOption` 与 `reasoning_options` |
| `packages/server/src/application/default-services/catalog-provider-mapping.ts` | 共享派生 `reasoningEffortsFromModel`、`catalogModelReasoningEfforts` |
| `packages/server/src/application/default-services/model-service.ts` | `toModelInfo` 输出 `reasoningEfforts` |
| `packages/server/src/application/settings-api.ts` | `ModelInfo.reasoningEfforts` |
| `packages/client/src/types/index.ts` | `ModelInfo.reasoningEfforts` 镜像 |
| `packages/core/src/types/settings.ts` | `effort?: string` |
| `packages/protocol/src/runtime-config.ts` | `effortValue` 真值表 |
| `packages/core/src/types/client.ts` | `StreamMessageParams.reasoningEffort` |
| `packages/core/src/types/runtime.ts` | `QueryEngineOptions.reasoningEffort` |
| `packages/core/src/engine/query-engine.ts` | 透传 `reasoningEffort` |
| `packages/api/src/providers/openai.ts` | 请求体写 `reasoning_effort` |
| `packages/agent-runtime/src/agent-options.ts` | `VykorAgentConfiguration.reasoningEffort` |
| `packages/agent-runtime/src/default-runtime.ts` | `engineOptions.reasoningEffort` |
| `packages/agent-runtime/src/child-agent-options.ts` | 子代理继承规则 |
| `packages/server/src/daemon/daemon-agent.ts` | 校验 + `resolveReasoningEfforts` 注入点 |
| `packages/server/src/application/daemon-application.ts` | 注入目录实现 |
| `packages/server/src/daemon/scheduled-task-service.ts` | 校验放宽 |
| `packages/tools/src/schedule/scheduled-task-tools.ts` | 工具 schema 去 enum |
| `packages/client/src/commands/session-commands.ts` | `/effort` 放宽 |
| `packages/coordinator/src/agent-loader.ts` | frontmatter effort 放宽 |
| `packages/server/src/application/agent/daemon-agent-event-projector.ts` | 子会话 effort 投影放宽 |
| `apps/desktop/src/shared/session-types.ts` | `DesktopModel.reasoningEfforts`、`CreateDesktopSessionInput.effort`、`UpdateDesktopSessionEffortInput` |
| `apps/desktop/src/main/features/session/session-operations.ts` | `createSession` 持久化 effort、`updateSessionEffort` |
| `apps/desktop/src/main/features/session/session-service.ts` | 转发 `updateSessionEffort` |
| `apps/desktop/src/shared/ipc-channels.ts` / `desktop-api-contract.ts` / `preload/desktop-api.ts` / `main/features/session/ipc.ts` | IPC 通道 |
| `apps/desktop/src/renderer/src/stores/desktop-session/*` | store state/helper/action |
| `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/effort-picker.tsx`（新建） | 选择器组件 |
| `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/controls.tsx` | `EffortMenu` |
| `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/model-picker.tsx` | `formatReasoning` 显示档位 |
| `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/composer.tsx` | 渲染选择器 |
| `apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx` | 透传 |
| `apps/desktop/src/renderer/src/components/desktop/conversation-page/session/new-conversation-start.tsx` | 透传 |

---

## 任务 1：catalog 类型与共享派生函数

**文件：**
- 修改：`packages/api/src/models/catalog.ts:19-39`
- 修改：`packages/server/src/application/default-services/catalog-provider-mapping.ts`
- 修改：`packages/server/src/application/default-services/model-service.ts:106-145`
- 修改：`packages/server/src/application/settings-api.ts:75-89`
- 修改：`packages/client/src/types/index.ts:367-381`
- 修改：`apps/desktop/src/shared/session-types.ts:39-53`
- 测试：`packages/server/src/application/default-services/catalog-provider-mapping.test.ts`
- 测试：`packages/server/src/application/__test__/default-application-services.test.ts`

- [ ] **步骤 1：编写失败的测试（共享派生）**

在 `packages/server/src/application/default-services/catalog-provider-mapping.test.ts` 追加：

```ts
import {
  catalogModelReasoningEfforts,
  readCatalogProvider,
  reasoningEffortsFromModel,
} from "./catalog-provider-mapping.js";

describe("reasoning effort derivation", () => {
  it("returns effort values and drops null/non-string/blank entries", () => {
    expect(
      reasoningEffortsFromModel({
        reasoning_options: [
          { type: "toggle" },
          { type: "effort", values: ["low", null, " ", 7, "high", "max"] },
        ],
      } as never),
    ).toEqual(["low", "high", "max"]);
  });

  it("returns undefined when there is no effort option", () => {
    expect(reasoningEffortsFromModel({ reasoning_options: [{ type: "toggle" }] } as never)).toBeUndefined();
    expect(reasoningEffortsFromModel({} as never)).toBeUndefined();
  });

  it("maps provider aliases and model ids", () => {
    const catalog = {
      zhipuai: {
        name: "Zhipu",
        models: {
          "glm-4.6": { id: "glm-4.6", reasoning_options: [{ type: "effort", values: ["low", "high"] }] },
        },
      },
    } as never;
    expect(catalogModelReasoningEfforts(catalog, "zhipu", "glm-4.6")).toEqual(["low", "high"]);
    expect(catalogModelReasoningEfforts(catalog, "zhipu", "missing")).toBeUndefined();
    expect(catalogModelReasoningEfforts(catalog, undefined, "glm-4.6")).toBeUndefined();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行（在 `packages/server` 目录）：`pnpm vitest run src/application/default-services/catalog-provider-mapping.test.ts`
预期：FAIL，报错 `reasoningEffortsFromModel is not a function`。

- [ ] **步骤 3：加 catalog 类型**

修改 `packages/api/src/models/catalog.ts`，在 `ModelsDevModel` 之前加：

```ts
export interface ModelsDevReasoningOption {
  type?: string;
  values?: Array<string | null>;
  min?: number;
  max?: number;
}
```

并在 `ModelsDevModel` 内、`reasoning?: boolean;` 之后加：

```ts
  reasoning_options?: ModelsDevReasoningOption[];
```

- [ ] **步骤 4：实现共享派生函数**

在 `packages/server/src/application/default-services/catalog-provider-mapping.ts` 顶部 import 增加类型：

```ts
import type {
  ModelsDevCatalog,
  ModelsDevModel,
  ModelsDevProvider,
} from "@vykor/api";
```

文件末尾追加：

```ts
export function reasoningEffortsFromModel(
  model: Pick<ModelsDevModel, "reasoning_options">,
): string[] | undefined {
  const option = model.reasoning_options?.find((item) => item.type === "effort");
  const values = option?.values?.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return values && values.length > 0 ? values : undefined;
}

export function catalogModelReasoningEfforts(
  catalog: ModelsDevCatalog,
  providerName: string | undefined,
  modelId: string,
): string[] | undefined {
  if (!providerName) return undefined;
  const provider = readCatalogProvider(catalog, providerName);
  if (!provider?.models) return undefined;
  const entry = Object.entries(provider.models).find(([key, model]) => {
    const id = typeof model.id === "string" && model.id.trim() ? model.id.trim() : key;
    return id === modelId;
  });
  return entry ? reasoningEffortsFromModel(entry[1]) : undefined;
}
```

- [ ] **步骤 5：`toModelInfo` 输出 reasoningEfforts**

修改 `packages/server/src/application/default-services/model-service.ts`，在 import 中把 `readCatalogProvider` 一行改为：

```ts
import {
  catalogModelReasoningEfforts,
  readCatalogProvider,
  reasoningEffortsFromModel,
} from "./catalog-provider-mapping.js";
```

在 `toModelInfo` 内，`reasoning` 之后插入：

```ts
    ...(reasoningEffortsFromModel(model)
      ? { reasoningEfforts: reasoningEffortsFromModel(model)! }
      : {}),
```

> `catalogModelReasoningEfforts` 在本任务中暂未被 model-service 使用，保留给任务 4 的 daemon 注入；若 lint 报未使用导入，只导入 `reasoningEffortsFromModel` 即可。

- [ ] **步骤 6：镜像 ModelInfo / DesktopModel 字段**

`packages/server/src/application/settings-api.ts` 的 `ModelInfo` 内、`reasoning?: boolean;` 之后加：

```ts
  reasoningEfforts?: string[];
```

`packages/client/src/types/index.ts` 的 `ModelInfo` 内同样加 `reasoningEfforts?: string[];`。

`apps/desktop/src/shared/session-types.ts` 的 `DesktopModel` 内、`reasoning?: boolean` 之后加：

```ts
  reasoningEfforts?: string[]
```

- [ ] **步骤 7：运行测试验证通过**

运行（在 `packages/server` 目录）：`pnpm vitest run src/application/default-services/catalog-provider-mapping.test.ts`
预期：PASS。

运行（在 `packages/server` 目录）：`pnpm vitest run src/application/__test__/default-application-services.test.ts`
预期：PASS（该文件此前已覆盖目录供应商模型元数据）。

- [ ] **步骤 8：类型检查**

运行（在 `packages/server` 目录）：`pnpm check-types`
运行（在 `packages/client` 目录）：`pnpm check-types`
预期：均无输出错误。

- [ ] **步骤 9：Commit**

```bash
git add packages/api/src/models/catalog.ts packages/server/src/application/default-services/catalog-provider-mapping.ts packages/server/src/application/default-services/model-service.ts packages/server/src/application/default-services/catalog-provider-mapping.test.ts packages/server/src/application/settings-api.ts packages/client/src/types/index.ts apps/desktop/src/shared/session-types.ts
git commit -m "feat(models): derive reasoning effort tiers from catalog"
```

---

## 任务 2：协议与设置层放宽 effort

**文件：**
- 修改：`packages/core/src/types/settings.ts:151`
- 修改：`packages/protocol/src/runtime-config.ts:13,45-47`
- 测试：`packages/protocol/src/runtime-config.test.ts`

- [ ] **步骤 1：编写失败的测试**

修改 `packages/protocol/src/runtime-config.test.ts`：

把第 36 行的 `{ effort: "old-effort" },` 改成 `{ effort: 123 },`。

在 `describe("session runtime metadata", ...)` 内追加：

```ts
  it("accepts any non-empty effort string and trims it", () => {
    expect(
      readSessionRuntimeConfig(session({ runtime: { model: "m", effort: "  xhigh  " } })),
    ).toEqual({ model: "m", effort: "xhigh" });
  });

  it("treats an empty effort as a cleared sentinel without falling back", () => {
    expect(
      readSessionRuntimeConfig(session({ runtime: { model: "m", effort: "" } }), { effort: "medium" }),
    ).toEqual({ model: "m" });
  });

  it("accepts a cleared effort through the metadata validator", () => {
    expect(() => readRuntimeMetadata({ runtime: { effort: "" } })).not.toThrow();
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行（在 `packages/protocol` 目录）：`pnpm vitest run src/runtime-config.test.ts`
预期：FAIL——`effort: "xhigh"` 抛 `ProtocolDataError`；`effort: ""` 抛错；`{ effort: 123 }` 用例因类型放宽尚未生效而报 TS/断言差异。

- [ ] **步骤 3：放宽类型与实现真值表**

`packages/core/src/types/settings.ts:151` 改为：

```ts
  effort?: string;
```

`packages/protocol/src/runtime-config.ts:13` 改为：

```ts
  effort?: string;
```

`packages/protocol/src/runtime-config.ts:45-47` 的 `effortValue` 改为：

```ts
function effortValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "";
}
```

> 空字符串返回 `""`（合法哨兵），非字符串返回 `undefined`（非法）。`readSessionRuntimeConfig:112-114` 的 `effortValue(runtime.effort) ?? defaults?.effort` 对 `""` 会短路为 falsy，因此无需改动该表达式；步骤 1 的测试固定此行为。

- [ ] **步骤 4：运行测试验证通过**

运行（在 `packages/protocol` 目录）：`pnpm vitest run src/runtime-config.test.ts`
预期：PASS。

- [ ] **步骤 5：类型检查**

运行（在 `packages/core` 目录）：`pnpm check-types`
运行（在 `packages/protocol` 目录）：`pnpm check-types`
预期：无错误。若其它包因 `effort` 类型从联合变为 `string` 报错，记录到任务 6 一并处理（任务 6 会放宽那些校验点）。

- [ ] **步骤 6：Commit**

```bash
git add packages/core/src/types/settings.ts packages/protocol/src/runtime-config.ts packages/protocol/src/runtime-config.test.ts
git commit -m "feat(protocol): allow free-form reasoning effort with clear sentinel"
```

---

## 任务 3：请求链路透传 reasoningEffort

**文件：**
- 修改：`packages/core/src/types/client.ts:5-13`
- 修改：`packages/core/src/types/runtime.ts:488-509`
- 修改：`packages/core/src/engine/query-engine.ts:156-201,365-371`
- 修改：`packages/api/src/providers/openai.ts:183-191`
- 测试：`packages/api/src/providers/openai.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `packages/api/src/providers/openai.test.ts` 末尾追加：

```ts
describe("OpenAICompatibleClient reasoning effort", () => {
  function captureCreateParams(): { body: () => any } {
    const client = new OpenAICompatibleClient({ apiKey: "test", baseURL: "https://gw.example/v1" });
    const captured: any[] = [];
    (client as any)._client.chat.completions.create = async (params: any) => {
      captured.push(params);
      return (async function* () {
        yield { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] };
      })();
    };
    return { body: () => captured[0] };
  }

  it("sends reasoning_effort when provided", async () => {
    const { body } = captureCreateParams();
    const client = new OpenAICompatibleClient({ apiKey: "test", baseURL: "https://gw.example/v1" });
    (client as any)._client.chat.completions.create = async (params: any) => {
      (client as any).__captured = params;
      return (async function* () {
        yield { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] };
      })();
    };
    for await (const _ of client.streamMessage({
      model: "deepseek-v4.1-flash",
      messages: [{ type: "user", content: "hi" }],
      reasoningEffort: "max",
    })) { /* drain */ }
    expect((client as any).__captured.reasoning_effort).toBe("max");
    void body;
  });

  it("omits reasoning_effort when not provided", async () => {
    const client = new OpenAICompatibleClient({ apiKey: "test", baseURL: "https://gw.example/v1" });
    (client as any)._client.chat.completions.create = async (params: any) => {
      (client as any).__captured = params;
      return (async function* () {
        yield { choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] };
      })();
    };
    for await (const _ of client.streamMessage({
      model: "deepseek-v4.1-flash",
      messages: [{ type: "user", content: "hi" }],
    })) { /* drain */ }
    expect("reasoning_effort" in (client as any).__captured).toBe(false);
  });
});
```

> 上面的 `captureCreateParams` 辅助函数是多余的；实现时删掉它，只保留两个 `it` 里的写法，避免未使用变量导致 lint 失败。

- [ ] **步骤 2：运行测试验证失败**

运行（在 `packages/api` 目录）：`pnpm vitest run src/providers/openai.test.ts`
预期：FAIL——第一个用例 `reasoning_effort` 为 `undefined`（`StreamMessageParams` 也还不接受该字段，TS 报错）。

- [ ] **步骤 3：加参数类型**

`packages/core/src/types/client.ts` 的 `StreamMessageParams` 内、`temperature?: number;` 之后加：

```ts
  reasoningEffort?: string;
```

`packages/core/src/types/runtime.ts` 的 `QueryEngineOptions` 内、`maxTokens?: number;` 之后加：

```ts
  reasoningEffort?: string;
```

- [ ] **步骤 4：实现 query-engine 透传**

`packages/core/src/engine/query-engine.ts`：在 `private sessionId: string | undefined;` 之后加字段：

```ts
  private reasoningEffort: string | undefined;
```

构造函数内、`this.sessionId = options.sessionId;` 之后加：

```ts
    this.reasoningEffort = options.reasoningEffort;
```

第 365 行的 `streamMessage({...})` 里、`abortSignal: options.signal,` 之前加：

```ts
        ...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {}),
```

- [ ] **步骤 5：实现 OpenAI 请求体字段**

`packages/api/src/providers/openai.ts:183-191` 的 `createParams` 内、`tools,` 之前加：

```ts
      ...(params.reasoningEffort
        ? {
            reasoning_effort:
              params.reasoningEffort as OpenAI.ChatCompletionCreateParamsStreaming["reasoning_effort"],
          }
        : {}),
```

- [ ] **步骤 6：运行测试验证通过**

运行（在 `packages/api` 目录）：`pnpm vitest run src/providers/openai.test.ts`
预期：PASS。

- [ ] **步骤 7：类型检查**

运行（在 `packages/core` 目录）：`pnpm check-types`
运行（在 `packages/api` 目录）：`pnpm check-types`
预期：无错误。

- [ ] **步骤 8：Commit**

```bash
git add packages/core/src/types/client.ts packages/core/src/types/runtime.ts packages/core/src/engine/query-engine.ts packages/api/src/providers/openai.ts packages/api/src/providers/openai.test.ts
git commit -m "feat(api): forward reasoning effort to openai-compatible requests"
```

---

## 任务 4：daemon 校验与目录注入

**文件：**
- 修改：`packages/agent-runtime/src/agent-options.ts:41-73`
- 修改：`packages/agent-runtime/src/default-runtime.ts:231-248`
- 修改：`packages/server/src/daemon/daemon-agent.ts:72-102,151-186,248-276`
- 修改：`packages/server/src/application/daemon-application.ts:395-440`
- 测试：`packages/server/src/daemon/__test__/daemon-agent.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `packages/server/src/daemon/__test__/daemon-agent.test.ts` 的 `describe("createDaemonAgentLoader", ...)` 内追加：

```ts
  it("sends reasoning effort only when the model declares the chosen tier", async () => {
    const createAgent = vi.fn(async () => ({ loadHistory: vi.fn(), close: vi.fn() }) as any);
    const loader = createDaemonAgentLoader({
      settings: { model: "default-model" } as any,
      createAgent,
      resolveReasoningEfforts: async () => ["low", "high", "max"],
    })!;

    await loader({ session, history: [], parts: [] });
    expect(createAgent.mock.calls[0]![0].options.reasoningEffort).toBe("high");

    createAgent.mockClear();
    const undeclared = { ...session, metadata: { runtime: { model: "m", effort: "xhigh" } } };
    await loader({ session: undeclared, history: [], parts: [] });
    expect(createAgent.mock.calls[0]![0].options.reasoningEffort).toBeUndefined();

    createAgent.mockClear();
    const noSelection = { ...session, metadata: { runtime: { model: "m" } } };
    await loader({ session: noSelection, history: [], parts: [] });
    expect(createAgent.mock.calls[0]![0].options.reasoningEffort).toBeUndefined();
  });

  it("degrades to no reasoning effort when the resolver throws", async () => {
    const createAgent = vi.fn(async () => ({ loadHistory: vi.fn(), close: vi.fn() }) as any);
    const loader = createDaemonAgentLoader({
      settings: { model: "default-model" } as any,
      createAgent,
      resolveReasoningEfforts: async () => {
        throw new Error("catalog offline");
      },
    })!;

    await loader({ session, history: [], parts: [] });
    expect(createAgent.mock.calls[0]![0].options.reasoningEffort).toBeUndefined();
  });
```

> 测试里的 `session` 常量（文件顶部）带有 `effort: "high"`，因此第一个断言为 `"high"`。

- [ ] **步骤 2：运行测试验证失败**

运行（在 `packages/server` 目录）：`pnpm vitest run src/daemon/__test__/daemon-agent.test.ts`
预期：FAIL——`resolveReasoningEfforts` 不是已知选项（TS 报错），`options.reasoningEffort` 为 `undefined`。

- [ ] **步骤 3：加 Agent 配置字段**

`packages/agent-runtime/src/agent-options.ts` 的 `VykorAgentConfiguration` 内、`effort?: Settings["effort"];` 之后加：

```ts
  reasoningEffort?: string;
```

`packages/agent-runtime/src/default-runtime.ts:231-248` 的 `engineOptions` 内、`model: runtimeModel,` 之后加：

```ts
    reasoningEffort: configuration.reasoningEffort,
```

- [ ] **步骤 4：daemon-agent 停止用全局 effort 当默认值**

`packages/server/src/daemon/daemon-agent.ts:248-276` 的 `agentConfigurationFromSession` 中，删除传入 `readSessionRuntimeConfig` 默认值里的这一行：

```ts
    effort: settings?.effort,
```

其余保持不变（`configuration.effort = runtime.effort`，未选择即 `undefined`；系统提示词仍由 `default-runtime.ts:221` 的 `configuration.effort ?? settings.effort` 回退全局）。

- [ ] **步骤 5：daemon-agent 加注入点与校验**

`DaemonAgentLoaderOptions`（`daemon-agent.ts:72-102`）内、`settings?: Settings;` 之前加：

```ts
  resolveReasoningEfforts?(input: {
    provider?: string;
    model?: string;
  }): Promise<string[] | undefined> | string[] | undefined;
```

在 loader 回调内，把 `const agentOptions: VykorAgentOptions = {` 之前改为先算配置：

```ts
    const configuration = agentConfigurationFromSession(session, settings);
    let declaredEfforts: string[] | undefined;
    try {
      declaredEfforts = await options.resolveReasoningEfforts?.({
        provider: configuration.provider,
        model: configuration.model,
      });
    } catch {
      declaredEfforts = undefined;
    }
    const chosenEffort = configuration.effort;
    const reasoningEffort =
      chosenEffort && declaredEfforts?.includes(chosenEffort)
        ? chosenEffort
        : undefined;
```

并把 `agentOptions` 里原来的 `...agentConfigurationFromSession(session, settings),` 改为 `...configuration,`，同时加：

```ts
      reasoningEffort,
```

- [ ] **步骤 6：daemon-application 注入目录实现**

`packages/server/src/application/daemon-application.ts` 顶部 import 增加：

```ts
import {
  createModelCatalogService,
} from "@vykor/api";
import { catalogModelReasoningEfforts } from "./default-services/catalog-provider-mapping.js";
```

在 `DaemonApplication` 类构造函数内（`constructor(private readonly options: DaemonApplicationOptions) {` 之后）加：

```ts
    this.modelCatalog = createModelCatalogService();
```

并在类字段区加：

```ts
  private readonly modelCatalog: ReturnType<typeof createModelCatalogService>;
```

在 `createDaemonAgentLoader({...})`（第 395 行）的配置对象内加：

```ts
        resolveReasoningEfforts: async ({ provider, model }) => {
          if (!provider || !model) return undefined;
          const catalog = await this.modelCatalog.load();
          return catalogModelReasoningEfforts(catalog, provider, model);
        },
```

- [ ] **步骤 7：运行测试验证通过**

运行（在 `packages/server` 目录）：`pnpm vitest run src/daemon/__test__/daemon-agent.test.ts`
预期：PASS。

- [ ] **步骤 8：类型检查**

运行（在 `packages/agent-runtime` 目录）：`pnpm check-types`
运行（在 `packages/server` 目录）：`pnpm check-types`
预期：无错误。

- [ ] **步骤 9：Commit**

```bash
git add packages/agent-runtime/src/agent-options.ts packages/agent-runtime/src/default-runtime.ts packages/server/src/daemon/daemon-agent.ts packages/server/src/application/daemon-application.ts packages/server/src/daemon/__test__/daemon-agent.test.ts
git commit -m "feat(daemon): validate and forward reasoning effort per session"
```

---

## 任务 5：子代理继承规则

**文件：**
- 修改：`packages/agent-runtime/src/child-agent-options.ts:22-60`
- 测试：`packages/agent-runtime/src/child-agent-options.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `packages/agent-runtime/src/child-agent-options.test.ts` 内追加（沿用该文件既有的构造 helper 风格；若 helper 名称不同，按文件内现有用法调整）：

```ts
  it("inherits reasoning effort only when the model and effort are unchanged", () => {
    const base = {
      configuration: { model: "m", reasoningEffort: "high", effort: "high" } as any,
      settings: {} as any,
      child: { description: "d", prompt: "p", agent: "a", cwd: "/repo" } as any,
      cwd: "/repo",
      sessionId: "s",
    };

    expect(
      deriveChildAgentOptions({ ...base, child: { ...base.child, model: "m" } }).reasoningEffort,
    ).toBe("high");
    expect(
      deriveChildAgentOptions({ ...base, child: { ...base.child, model: "other" } }).reasoningEffort,
    ).toBeUndefined();
    expect(
      deriveChildAgentOptions({ ...base, child: { ...base.child, effort: "low" } }).reasoningEffort,
    ).toBeUndefined();
  });
```

- [ ] **步骤 2：运行测试验证失败**

运行（在 `packages/agent-runtime` 目录）：`pnpm vitest run src/child-agent-options.test.ts`
预期：FAIL——换模型/改 effort 时仍继承 `"high"`。

- [ ] **步骤 3：实现继承规则**

`packages/agent-runtime/src/child-agent-options.ts` 的 `deriveChildAgentOptions` 内，把 `effort: isSupportedEffort(child.effort) ? child.effort : configuration.effort,` 替换为：

```ts
    effort: isSupportedEffort(child.effort) ? child.effort : configuration.effort,
    reasoningEffort: childModel === configuration.model && childEffort === configuration.effort
      ? configuration.reasoningEffort
      : undefined,
```

并在 return 之前加两个局部变量：

```ts
  const childModel = child.model ?? configuration.model;
  const childEffort = isSupportedEffort(child.effort) ? child.effort : configuration.effort;
```

把 `isSupportedEffort` 改为：

```ts
function isSupportedEffort(
  effort: string | undefined,
): effort is NonNullable<VykorAgentConfiguration["effort"]> {
  return typeof effort === "string" && effort.trim().length > 0;
}
```

> `child-agent-options.test.ts:126` 原有 `effort: "ultra"` 用例断言「回退父级 low」；由于 `"ultra"` 现在是合法字符串，该用例需改为断言子代理采用 `"ultra"`。按规格更新该用例，并把测试标题改为「accepts any non-empty child effort string」。

- [ ] **步骤 4：运行测试验证通过**

运行（在 `packages/agent-runtime` 目录）：`pnpm vitest run src/child-agent-options.test.ts`
预期：PASS。

- [ ] **步骤 5：类型检查**

运行（在 `packages/agent-runtime` 目录）：`pnpm check-types`
预期：无错误。

- [ ] **步骤 6：Commit**

```bash
git add packages/agent-runtime/src/child-agent-options.ts packages/agent-runtime/src/child-agent-options.test.ts
git commit -m "feat(agent-runtime): scope child reasoning effort to inherited models"
```

---

## 任务 6：外围 effort 校验放宽

**文件：**
- 修改：`packages/server/src/daemon/scheduled-task-service.ts:441-443`
- 修改：`packages/tools/src/schedule/scheduled-task-tools.ts:55,189`
- 修改：`packages/client/src/commands/session-commands.ts:766-780`
- 修改：`packages/coordinator/src/agent-loader.ts:20,133-139`
- 修改：`packages/server/src/application/agent/daemon-agent-event-projector.ts:798-800`

- [ ] **步骤 1：放宽定时任务校验**

`packages/server/src/daemon/scheduled-task-service.ts:441-443` 改为：

```ts
    if (typeof input.effort === "string" && input.effort.trim().length === 0) {
      throw new Error("Unknown scheduled task effort");
    }
```

- [ ] **步骤 2：放宽定时任务工具 schema**

`packages/tools/src/schedule/scheduled-task-tools.ts` 第 55 行与第 189 行，把：

```ts
      effort: { type: "string", enum: ["low", "medium", "high"] },
```

改为：

```ts
      effort: { type: "string" },
```

- [ ] **步骤 3：放宽 `/effort` 命令**

`packages/client/src/commands/session-commands.ts:766-780`：把「非 low/medium/high 报 Invalid effort」的校验改为「空字符串报错，其余透传」。具体实现：把该分支里类似

```ts
    if (!["low", "medium", "high"].includes(level)) {
      emit("Invalid effort. Use: low, medium, or high");
      return;
    }
```

改为

```ts
    if (!level.trim()) {
      emit("Invalid effort. Provide a non-empty reasoning effort value");
      return;
    }
```

同时把无参时的提示文案从 `Current effort: ...` 保留（无需改）。

- [ ] **步骤 4：放宽 Agent 定义 frontmatter**

`packages/coordinator/src/agent-loader.ts` 第 20 行删除 `EFFORT_LEVELS`（或改为不再使用）；第 133-139 行改为：

```ts
  let effort: string | number | undefined;
  const effortRaw = fm.effort;
  if (typeof effortRaw === "number") {
    effort = Number.isInteger(effortRaw) && effortRaw > 0 ? effortRaw : undefined;
  } else if (typeof effortRaw === "string" && effortRaw.trim()) {
    effort = effortRaw.trim();
  }
```

若 `EFFORT_LEVELS` 在别处被引用则保留导出；否则连同 `pickEnum` 的该处调用一起清理。运行 `pnpm check-types` 确认无未使用变量。

- [ ] **步骤 5：放宽子会话投影校验**

`packages/server/src/application/agent/daemon-agent-event-projector.ts:798-800` 改为：

```ts
function isRuntimeEffort(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
```

- [ ] **步骤 6：运行相关测试与类型检查**

运行（在 `packages/server` 目录）：`pnpm vitest run src/daemon/__test__/scheduled-task-service.test.ts`
运行（在 `packages/tools` 目录）：`pnpm vitest run src/schedule`
运行（在 `packages/coordinator` 目录）：`pnpm vitest run src/__test__/agent-loader.test.ts`
预期：PASS。注意 `agent-loader.test.ts:121` 的「silently drops invalid enum values ... effort: extreme」用例需更新——`"extreme"` 现在是合法值，改为断言被接受（或把该用例的 effort 换成非字符串）。

- [ ] **步骤 7：类型检查**

运行（在 `packages/server`、`packages/tools`、`packages/client`、`packages/coordinator` 目录分别）：`pnpm check-types`
预期：无错误。

- [ ] **步骤 8：Commit**

```bash
git add packages/server/src/daemon/scheduled-task-service.ts packages/tools/src/schedule/scheduled-task-tools.ts packages/client/src/commands/session-commands.ts packages/coordinator/src/agent-loader.ts packages/server/src/application/agent/daemon-agent-event-projector.ts packages/coordinator/src/__test__/agent-loader.test.ts
git commit -m "feat: relax effort validation to non-empty strings"
```

---

## 任务 7：桌面 IPC 与 store 会话 effort

**文件：**
- 修改：`apps/desktop/src/shared/session-types.ts:293-300,391-400`
- 修改：`apps/desktop/src/shared/ipc-channels.ts:202,546-549`
- 修改：`apps/desktop/src/shared/desktop-api-contract.ts:367-369`
- 修改：`apps/desktop/src/preload/desktop-api.ts:339-341`
- 修改：`apps/desktop/src/main/features/session/ipc.ts:209-215`
- 修改：`apps/desktop/src/main/features/session/session-service.ts:358-370`
- 修改：`apps/desktop/src/main/features/session/session-operations.ts:191-223,398-409`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/helpers.ts:96-104`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/types.ts:126-151,224-261`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/initial-state.ts:48-76`
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/session-actions.ts:282-358`
- 测试：`apps/desktop/src/renderer/src/stores/desktop-session/session-actions.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `apps/desktop/src/renderer/src/stores/desktop-session/session-actions.test.ts` 内追加（沿用该文件既有的 `vi.stubGlobal("window", ...)` 模式）：

```ts
  it("persists a session reasoning effort through sessions.update", async () => {
    const update = vi.fn(async () => ({ ...sessionFixture, metadata: { runtime: { model: "m", effort: "max" } } }));
    vi.stubGlobal("window", { desktop: { sessions: { updateEffort: update } } });
    const store = createTestStore();
    await store.getState().updateSessionEffort("session-1", "max");
    expect(update).toHaveBeenCalledWith({ sessionId: "session-1", effort: "max" });
    expect(store.getState().selectedEffort).toBe("max");
  });

  it("reads the three effort states from session metadata", () => {
    expect(sessionEffort({ ...sessionFixture, metadata: {} })).toBeNull();
    expect(sessionEffort({ ...sessionFixture, metadata: { runtime: { effort: "" } } })).toBeNull();
    expect(sessionEffort({ ...sessionFixture, metadata: { runtime: { effort: "high" } } })).toBe("high");
  });
```

> 若测试文件没有 `sessionFixture` / `createTestStore`，用文件内现有的等价构造（`store-test-fixtures.ts` 的 `createInitialState` 或既有 helper）。实现前先阅读该文件顶部的既有 setup。

- [ ] **步骤 2：运行测试验证失败**

运行（在 `apps/desktop` 目录）：`pnpm vitest run src/renderer/src/stores/desktop-session/session-actions.test.ts`
预期：FAIL——`updateSessionEffort`、`sessionEffort` 不存在。

- [ ] **步骤 3：加共享类型**

`apps/desktop/src/shared/session-types.ts`：

`CreateDesktopSessionBaseInput`（293-297 行）加：

```ts
  effort?: string
```

在 `UpdateDesktopSessionPermissionModeInput` 之后加：

```ts
export interface UpdateDesktopSessionEffortInput {
  sessionId: string
  effort: string
}
```

- [ ] **步骤 4：加 IPC 通道与契约**

`apps/desktop/src/shared/ipc-channels.ts` 第 202 行之后加：

```ts
  sessionUpdateEffort: "session:update-effort",
```

在 `IpcInvokeMap` 的 `sessionUpdatePermissionMode` 条目（546-549 行）之后加：

```ts
  [IpcChannels.sessionUpdateEffort]: {
    args: [input: UpdateDesktopSessionEffortInput]
    result: DesktopSessionRecord
  }
```

并在该文件的类型 import 区加入 `UpdateDesktopSessionEffortInput`。

`apps/desktop/src/shared/desktop-api-contract.ts` 的 `updatePermissionMode`（367-369 行）之后加：

```ts
    updateEffort: (input: UpdateDesktopSessionEffortInput) => Promise<DesktopSessionRecord>
```

并加入类型 import。

`apps/desktop/src/preload/desktop-api.ts` 的 `updatePermissionMode`（339-341 行）之后加：

```ts
      updateEffort: (input: IpcInvokeMap[typeof IpcChannels.sessionUpdateEffort]["args"][0]) =>
        invoke(IpcChannels.sessionUpdateEffort, input),
```

`apps/desktop/src/main/features/session/ipc.ts` 的 `sessionUpdatePermissionMode` handler（209-215 行）之后加：

```ts
      {
        channel: IpcChannels.sessionUpdateEffort,
        handler: (_event, input) =>
          desktopSessionService.updateSessionEffort(input as UpdateDesktopSessionEffortInput),
      },
```

并加入类型 import。

- [ ] **步骤 5：session-service 与 session-operations**

`apps/desktop/src/main/features/session/session-service.ts` 的 `updateSessionPermissionMode` 之后加：

```ts
  async updateSessionEffort(input: UpdateDesktopSessionEffortInput): Promise<DesktopSessionRecord> {
    const client = await this.getClient()
    return await this.operations.updateSessionEffort(client, input)
  }
```

`apps/desktop/src/main/features/session/session-operations.ts`：

`createSession`（191-223 行）内，把 `runtime` 对象改为：

```ts
          runtime: {
            model,
            ...(provider ? { provider } : {}),
            ...(permissionMode ? { permissionMode } : {}),
            ...(input.effort?.trim() ? { effort: input.effort.trim() } : {}),
          },
```

在 `updateSessionPermissionMode`（398-409 行）之后加：

```ts
  async updateSessionEffort(
    client: SessionOperationsClient,
    input: UpdateDesktopSessionEffortInput
  ): Promise<DesktopSessionRecord> {
    const sessionId = requireString(input.sessionId, "会话 ID")
    const effort = typeof input.effort === "string" ? input.effort.trim() : ""
    return toDesktopSessionRecord(
      await client.sessions.update(sessionId, {
        metadata: { runtime: { effort } },
      })
    )
  }
```

并加入类型 import。

- [ ] **步骤 6：store helper 与 state**

`apps/desktop/src/renderer/src/stores/desktop-session/helpers.ts` 的 `sessionPermissionMode` 之后加：

```ts
export function sessionEffort(session: DesktopSessionRecord): string | null {
  const runtime = session.metadata["runtime"]
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return null
  const effort = (runtime as Record<string, unknown>)["effort"]
  return typeof effort === "string" && effort.trim() ? effort.trim() : null
}
```

`apps/desktop/src/renderer/src/stores/desktop-session/types.ts`：

`SessionActions` 内 `updateSessionPermissionMode` 之后加：

```ts
  updateSessionEffort: (sessionId: string, effort: string) => Promise<void>
  selectEffort: (effort: string) => void
```

`DesktopSessionState` 内 `selectedPermissionMode` 之后加：

```ts
  selectedEffort: string | null
```

`initial-state.ts` 内 `selectedPermissionMode` 之后加：

```ts
    selectedEffort: null,
```

- [ ] **步骤 7：store actions**

`apps/desktop/src/renderer/src/stores/desktop-session/session-actions.ts`：

在 `updateSessionPermissionMode`（342-358 行）之后加：

```ts
    async updateSessionEffort(sessionId, effort) {
      const session = await window.desktop.sessions.updateEffort({ sessionId, effort })
      set((state) => ({
        sessions: upsertSession(state.sessions, session),
        selectedEffort:
          state.activeSessionId === sessionId ? sessionEffort(session) : state.selectedEffort,
        sessionView:
          state.sessionView?.session.id === sessionId
            ? { ...state.sessionView, session }
            : state.sessionView,
      }))
    },

    selectEffort(effort) {
      set({ selectedEffort: effort.trim() ? effort.trim() : null })
    },
```

在文件顶部 import 中把 `sessionEffort` 加入来自 `./helpers` 的导入。

在 `startSession` 的 `sessionInput`（583-596 行）里，两个分支都加：

```ts
                ...(selectedEffort ? { effort: selectedEffort } : {}),
```

并从 `get()` 解构中取出 `selectedEffort`。

- [ ] **步骤 8：运行测试验证通过**

运行（在 `apps/desktop` 目录）：`pnpm vitest run src/renderer/src/stores/desktop-session/session-actions.test.ts`
预期：PASS。

- [ ] **步骤 9：类型检查**

运行（在 `apps/desktop` 目录）：`pnpm check-types`
预期：无错误。

- [ ] **步骤 10：Commit**

```bash
git add apps/desktop/src/shared/session-types.ts apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/shared/desktop-api-contract.ts apps/desktop/src/preload/desktop-api.ts apps/desktop/src/main/features/session/ipc.ts apps/desktop/src/main/features/session/session-service.ts apps/desktop/src/main/features/session/session-operations.ts apps/desktop/src/renderer/src/stores/desktop-session/helpers.ts apps/desktop/src/renderer/src/stores/desktop-session/types.ts apps/desktop/src/renderer/src/stores/desktop-session/initial-state.ts apps/desktop/src/renderer/src/stores/desktop-session/session-actions.ts apps/desktop/src/renderer/src/stores/desktop-session/session-actions.test.ts
git commit -m "feat(desktop): persist per-session reasoning effort"
```

---

## 任务 8：桌面选择器与展示

**文件：**
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/model-picker.tsx:118-122,152-171`
- 新建：`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/effort-picker.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/controls.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/composer.tsx:112,152-171,256-343`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/conversation-page/session/new-conversation-start.tsx`
- 测试：`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/__test__/model-picker.test.ts`
- 测试：`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/__test__/effort-picker.test.ts`（新建）

- [ ] **步骤 1：编写失败的测试（展示）**

在 `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/__test__/model-picker.test.ts` 追加：

```ts
import { formatReasoning } from "../model-picker"

describe("model picker reasoning tiers", () => {
  it("lists declared effort tiers", () => {
    expect(formatReasoning({ ...model("native"), reasoning: true, reasoningEfforts: ["low", "high", "max"] }))
      .toBe("支持推理（low / high / max）")
  })

  it("falls back to plain support without tiers", () => {
    expect(formatReasoning({ ...model("native"), reasoning: true })).toBe("支持推理")
    expect(formatReasoning({ ...model("native"), reasoning: false })).toBe("不支持推理")
    expect(formatReasoning(model("native"))).toBe("—")
  })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行（在 `apps/desktop` 目录）：`pnpm vitest run src/renderer/src/components/desktop/conversation-page/composer/__test__/model-picker.test.ts`
预期：FAIL——`formatReasoning` 未导出。

- [ ] **步骤 3：实现 formatReasoning**

`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/model-picker.tsx`：把第 118-122 行的 `formatReasoning` 改为导出并接收整个 model：

```tsx
export function formatReasoning(model: DesktopModel): string {
  if (model.reasoning !== true) return model.reasoning === false ? "不支持推理" : "—"
  const efforts = model.reasoningEfforts
  return efforts && efforts.length > 0 ? `支持推理（${efforts.join(" / ")}）` : "支持推理"
}
```

`ModelHoverDetails` 内第 157 行改为：

```tsx
    { label: "推理", value: formatReasoning(model) },
```

- [ ] **步骤 4：新建选择器组件**

新建 `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/effort-picker.tsx`：

```tsx
import { ChevronDown, Gauge } from "lucide-react"

import { Button } from "@renderer/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@renderer/components/ui/popover"
import type { DesktopModel } from "@shared/session-types"
import { PickerMenuItem } from "./controls"

const EFFORT_LABELS: Record<string, string> = {
  none: "关闭",
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
  default: "默认",
}

export function effortLabel(value: string): string {
  return EFFORT_LABELS[value] ?? value
}

export function resolveEffortTiers(
  models: DesktopModel[],
  selectedModel: string | null,
  selectedProvider: string | null
): string[] {
  const model =
    models.find((item) => item.id === selectedModel && item.providerName === selectedProvider) ??
    models.find((item) => item.id === selectedModel)
  return model?.reasoningEfforts ?? []
}

export function EffortPicker({
  open,
  onOpenChange,
  tiers,
  value,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tiers: string[]
  value: string | null
  onSelect: (effort: string) => void
}): React.JSX.Element | null {
  if (tiers.length === 0) return null
  const label = value && tiers.includes(value) ? effortLabel(value) : "默认"
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            aria-label="推理强度"
            className="h-8 max-w-32 min-w-0 shrink overflow-hidden px-2 text-xs font-normal text-muted-foreground"
          />
        }
      >
        <Gauge data-icon="inline-start" />
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown data-icon="inline-end" />
      </PopoverTrigger>
      <PopoverContent role="menu" side="top" align="end" sideOffset={8} className="w-44 gap-0 rounded-xl p-1.5 shadow-lg ring-1 ring-black/10">
        <PickerMenuItem selected={!value || !tiers.includes(value)} onClick={() => onSelect("")}>
          <span>默认</span>
        </PickerMenuItem>
        {tiers.map((tier) => (
          <PickerMenuItem key={tier} selected={value === tier} onClick={() => onSelect(tier)}>
            <span className="min-w-0 flex-1 truncate">{effortLabel(tier)}</span>
            <span className="text-ui-caption ml-auto text-muted-foreground">{tier}</span>
          </PickerMenuItem>
        ))}
      </PopoverContent>
    </Popover>
  )
}
```

- [ ] **步骤 5：接入 composer**

`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/composer.tsx`：

- 在 props 类型与解构中加入：

```tsx
  effort,
  onSelectEffort,
```

类型：

```tsx
  effort: string | null
  onSelectEffort: (effort: string) => void
```

- import 中加入：

```tsx
import { EffortPicker, resolveEffortTiers } from "./effort-picker"
```

- `activePicker` 状态改为：

```tsx
  const [activePicker, setActivePicker] = useState<"model" | "permission" | "effort" | null>(null)
```

- 在权限 Popover（279-310 行）之后加：

```tsx
          <EffortPicker
            open={activePicker === "effort"}
            onOpenChange={(open) => setActivePicker(open ? "effort" : null)}
            tiers={resolveEffortTiers(models, selectedModel, selectedProvider)}
            value={effort}
            onSelect={(next) => {
              onSelectEffort(next)
              closePicker()
            }}
          />
```

- [ ] **步骤 6：页面透传**

`conversation-page.tsx`：读取 store 的 `selectedEffort` 与 `updateSessionEffort`，在两个 `<Composer>`（约 463 与 609 行）上加：

```tsx
          effort={selectedEffort}
          onSelectEffort={(effort) => {
            if (activeSessionId) void updateSessionEffort(activeSessionId, effort)
            else selectEffort(effort)
          }}
```

`new-conversation-start.tsx`：props 增加 `effort: string | null` 与 `onSelectEffort: (effort: string) => void`，并在 `<Composer>`（422-464 行）上透传这两个属性。

- [ ] **步骤 7：新建选择器测试**

新建 `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/__test__/effort-picker.test.ts`：

```ts
import { describe, expect, it } from "vitest"

import { effortLabel, resolveEffortTiers } from "../effort-picker"

describe("effort picker", () => {
  it("maps known tiers to Chinese labels and falls back to raw", () => {
    expect(effortLabel("max")).toBe("最高")
    expect(effortLabel("low")).toBe("低")
    expect(effortLabel("weird")).toBe("weird")
  })

  it("resolves tiers from the selected model", () => {
    const models = [
      { id: "m", label: "M", provider: "P", providerName: "p", reasoningEfforts: ["low", "high"] },
    ] as never
    expect(resolveEffortTiers(models, "m", "p")).toEqual(["low", "high"])
    expect(resolveEffortTiers(models, "missing", "p")).toEqual([])
  })
})
```

- [ ] **步骤 8：运行测试验证通过**

运行（在 `apps/desktop` 目录）：`pnpm vitest run src/renderer/src/components/desktop/conversation-page/composer/__test__/model-picker.test.ts src/renderer/src/components/desktop/conversation-page/composer/__test__/effort-picker.test.ts`
预期：PASS。

- [ ] **步骤 9：类型检查**

运行（在 `apps/desktop` 目录）：`pnpm check-types`
预期：无错误。

- [ ] **步骤 10：Commit**

```bash
git add apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/model-picker.tsx apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/effort-picker.tsx apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/controls.tsx apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/composer.tsx apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx apps/desktop/src/renderer/src/components/desktop/conversation-page/session/new-conversation-start.tsx apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/__test__/model-picker.test.ts apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/__test__/effort-picker.test.ts
git commit -m "feat(desktop): add per-session reasoning effort picker"
```

---

## 任务 9：全量验证与验收

**文件：**
- 无源码修改（仅运行与记录）

- [ ] **步骤 1：全仓类型检查**

运行（仓库根目录）：`pnpm check-types`
预期：`Tasks: N successful, N total`，无失败。

- [ ] **步骤 2：跑受影响包测试**

运行（仓库根目录）：

```bash
pnpm --filter @vykor/api test
pnpm --filter @vykor/core test
pnpm --filter @vykor/protocol test
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/server test
pnpm --filter @vykor/client test
pnpm --filter @vykor/coordinator test
pnpm --filter @vykor/tools test
pnpm --filter @vykor/desktop test
```

预期：全部 PASS。

- [ ] **步骤 3：全仓 lint**

运行（仓库根目录）：`pnpm lint`
预期：无错误。

- [ ] **步骤 4：人工验收（记录结果）**

1. 用 opencode-go 的 `deepseek-v4.1-flash`（声明 `low/high/max`）：模型卡片显示档位；选择 `high`；抓请求体确认 `reasoning_effort: "high"`；重开会话选择仍为 `high`。
2. 切到只声明 `toggle` 的模型：选择器消失，请求体不含 `reasoning_effort`。
3. 清除选择：选择器显示「默认」，请求体不含 `reasoning_effort`（即使全局 `settings.effort` 为 `medium`）。
4. warm Agent 存在时切换 effort 或模型：下一轮请求使用新值。

- [ ] **步骤 5：Commit（若有验收期间产生的文档/修复）**

```bash
git add -A
git commit -m "chore: verify reasoning effort control end to end"
```

---

## 自检记录

**规格覆盖度：** 目标、数据模型、清除真值表、目录解析、卡片展示、Agent effort 来源、daemon 校验与发送、warm 失效不变量、子代理、系统提示词、桌面选择器、新会话持久化、状态与安全、测试与验收、不在范围内——均有对应任务（任务 1-8），任务 9 收口验证。

**占位符扫描：** 无 TODO / 待定；所有代码步骤含实际代码或精确替换文本。

**类型一致性：** `reasoningEfforts`（复数，`string[]`）、`reasoningEffort`（发送值，`string`）、`effort`（用户值，`string`）、`selectedEffort`（store，`string | null`）、`sessionEffort`（helper）在各任务间命名一致。`UpdateDesktopSessionEffortInput` 仅在任务 7 定义与使用。
