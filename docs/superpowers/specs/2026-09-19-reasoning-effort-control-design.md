# 推理强度（Reasoning Effort）按会话控制设计

> 状态：待实现。

## 目标

让「模型实际声明了推理强度档位」的模型，能在模型卡片里看到档位、在输入框旁按会话选择档位，并把选中的档位以 `reasoning_effort` 发给 OpenAI 兼容后端。模型没有声明档位时不显示选择器、也不发送字段，避免未知字段导致 400。

本次只打通 OpenAI 兼容后端（`openai_compat`，覆盖 opencode-go 这类目录供应商）。Anthropic 的 thinking budget 与 Codex 的 reasoning 不在范围内。

## 背景与现状

- models.dev 目录里有 `reasoning_options`，但类型没声明、转换时被丢弃：
  - `packages/api/src/models/catalog.ts:13-40` 的 `ModelsDevModel` 没有该字段。
  - `packages/server/src/application/default-services/model-service.ts:122` 的 `toModelInfo` 只输出 `reasoning: boolean`。
- catalog 里 `reasoning_options` 只有三种形态，实测（对整个 `api.json` 统计）：`toggle` 1313 处、`effort` 3437 处、`budget_tokens` 677 处。本次只消费 `effort`。
- `effort` 设置当前**只拼进系统提示词**，从未进入请求：
  - 取值定义在 `packages/core/src/types/settings.ts:151`（`"low" | "medium" | "high"`）。
  - 提示词注入在 `packages/prompts/src/prompt-segments-assembly.ts:113-115`（输出 `- Effort: high`）。
  - `packages/api/src/providers/*` 里搜不到任何 effort / reasoning_effort 相关代码。
- `effort` 被硬编码成 `low|medium|high`，共 5 处：`settings.ts:151`、`packages/protocol/src/runtime-config.ts:13,45-47`、`packages/agent-runtime/src/child-agent-options.ts:59`、`packages/server/src/daemon/scheduled-task-service.ts:441`、`packages/client/src/commands/session-commands.ts:766-777`。
- 会话运行时的 `effort` 已可用：`packages/protocol/src/runtime-config.ts:13` 定义了 `SessionRuntimeConfig.effort`，`packages/server/src/daemon/daemon-agent.ts:258,272` 已把它合成进 Agent 配置的 `effort`。
- 已安装的 `openai@4.104.0` 支持请求字段 `reasoning_effort`（`Shared.ReasoningEffort = 'low' | 'medium' | 'high' | null`），类型偏窄，需要局部断言才能发任意字符串。

## 术语

- **推理强度 / effort**：用户可见的一档取值，字符串。
- **声明档位（declared）**：catalog 中某模型 `reasoning_options` 里 `type === "effort"` 的 `values`，过滤掉 `null` 与空白后的字符串列表。
- **有效档位**：会话 runtime 的 `effort`，没有时回退全局 `settings.effort`。
- **发送值（reasoningEffort）**：只有「有效档位存在于当前模型的声明档位里」时才产生；否则视为未设置。

## 设计决策

1. **复用现有 `effort` 作为唯一用户选择值**，而不是新增第二套「推理强度」概念。会话选择写入 `session.metadata.runtime.effort`，全局默认仍是 `settings.effort`（默认 `medium`）。
2. **只在请求层新增 `reasoningEffort`**，作为「已校验、可安全发送」的中间值。它与 `effort` 分开的原因：`effort` 还要继续驱动系统提示词和子代理继承，不能因为当前模型不支持就整体清空。
3. **校验发生在 daemon 组装 Agent 时**（那里能同时拿到会话 runtime 和模型目录），UI 只做「按声明档位展示与选择」。这样即使历史会话残留了不匹配的档位，也不会发出去。
4. **模型没有声明档位时不显示、不发送**（用户已确认）。仅声明 `toggle` / `budget_tokens` 的模型同样不显示选择器。
5. **`effort` 放宽为自由字符串**（用户已确认按模型动态取值）。协议与设置层不再枚举校验，只校验「非空字符串」。
6. **composer 按会话选择**（用户已确认）。新会话在选择时先存内存值，创建会话时写入 `metadata.runtime.effort`；已有会话通过 session update 写入。

## 数据模型

### catalog 层

`packages/api/src/models/catalog.ts` 新增：

```ts
export interface ModelsDevReasoningOption {
  type?: string;
  values?: Array<string | null>;
  min?: number;
  max?: number;
}
```

`ModelsDevModel` 增加 `reasoning_options?: ModelsDevReasoningOption[]`。

### 模型信息层

`ModelInfo`（`packages/server/src/application/settings-api.ts:75-89`、`packages/client/src/types/index.ts:367-381`）与 `DesktopModel`（`apps/desktop/src/shared/session-types.ts:39-53`）统一新增：

```ts
reasoningEfforts?: string[];
```

语义：该模型声明的 effort 档位；未声明时为 `undefined`（不是空数组）。

### 请求链路

- `packages/core/src/types/client.ts:5-13` `StreamMessageParams` 增加 `reasoningEffort?: string`。
- `packages/core/src/types/runtime.ts:488` `QueryEngineOptions` 增加 `reasoningEffort?: string`。
- `packages/agent-runtime/src/agent-options.ts:41-73` `OpenHarnessAgentConfiguration` 增加 `reasoningEffort?: string`。

### 设置与协议放宽

- `packages/core/src/types/settings.ts:151`：`effort?: string`。
- `packages/protocol/src/runtime-config.ts:13`：`SessionRuntimeConfig.effort?: string`；`effortValue` 改为「非空 trim 字符串」。
- `packages/agent-runtime/src/child-agent-options.ts:56-60`：`isSupportedEffort` 改为「非空字符串」。
- `packages/server/src/daemon/scheduled-task-service.ts:441`：校验改为非空字符串。
- `packages/client/src/commands/session-commands.ts:766-777`：接受任意非空值；能拿到当前模型声明档位时列出候选，拿不到时按自由值处理。

## 行为规格

### 1. 目录解析（声明档位）

`packages/server/src/application/default-services/model-service.ts` 的 `toModelInfo` 增加派生：

```ts
function modelReasoningEfforts(model: ModelsDevModel): string[] | undefined {
  const option = model.reasoning_options?.find((item) => item.type === "effort");
  const values = option?.values?.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return values && values.length > 0 ? values : undefined;
}
```

输出 `...(efforts ? { reasoningEfforts: efforts } : {})`。内置供应商与 models.dev 目录供应商都会经过 `toModelInfo`，因此两者都生效。

`packages/server/src/application/default-services/catalog-provider-mapping.ts` 新增：

```ts
export function catalogModelReasoningEfforts(
  catalog: ModelsDevCatalog,
  providerName: string | undefined,
  modelId: string,
): string[] | undefined
```

实现：`readCatalogProvider(catalog, providerName)` 取模型，按 `model.id?.trim() || key` 匹配 `modelId`，再复用同一套 `effort` 过滤逻辑（与 `toModelInfo` 保持一致）。找不到 provider 或 model 时返回 `undefined`。

### 2. 模型卡片展示

`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/model-picker.tsx:118-122`：

- `reasoning !== true` → `不支持推理` / `—`（保持现状）。
- `reasoning === true` 且 `reasoningEfforts?.length` → `支持推理（low / high / max）`。
- `reasoning === true` 无档位 → `支持推理`（保持现状）。

### 3. 会话选择与持久化

- 新会话：`CreateDesktopSessionInput` 增加 `effort?: string`。`apps/desktop/src/main/features/session/session-operations.ts` 的 `createSession` 把它写进 `metadata.runtime.effort`（与现有 `permissionMode` 写法并列）。
- 已有会话：新增 `sessionUpdateEffort` IPC 通道，`updateSessionEffort` 写 `metadata: { runtime: { effort } }`（对齐 `updateSessionPermissionMode`，`session-operations.ts:398`）。传空字符串表示清除，写 `effort: undefined` 不做处理——清除通过写回空字符串并在协议层过滤实现；见下文「清除语义」。
- 桌面 store 新增 `selectedEffort: string | null`、`defaultEffort: string | null`、`sessionEffort(session, fallback)` helper、`selectEffort(value)`（新会话）与 `updateSessionEffort(sessionId, value)`。`bootstrap` 从 `settings.effort` 读 `defaultEffort`。

**清除语义**：协议 `patchSessionRuntimeMetadata` 会 `stripUndefined`，`mergeSessionMetadata` 会做对象合并，因此无法用 `undefined` 删除已有 key。清除采用空字符串：`effortValue` 允许空字符串表示「未设置」，`readSessionRuntimeConfig` 遇到空字符串时不产出 `effort` 字段。这样选择器可回到「默认」。

### 4. 校验与发送（daemon）

`packages/server/src/daemon/daemon-agent.ts` 的加载器（`createDaemonAgentLoader`，第 114 行）在异步回调里、构造 `agentOptions` 之前：

1. 从 `agentConfigurationFromSession(session, settings)` 得到 `configuration`（含 `effort`、`provider`、`model`）。
2. 调新增的可选注入项 `options.resolveReasoningEfforts?.({ provider, model })` 拿声明档位。
3. 计算：
   ```ts
   const chosen = configuration.effort;
   const declared = await options.resolveReasoningEfforts?.({ provider: configuration.provider, model: configuration.model });
   const reasoningEffort = chosen && declared?.includes(chosen) ? chosen : undefined;
   ```
4. 把 `reasoningEffort` 写进 `agentOptions`。

`DaemonAgentLoaderOptions`（`daemon-agent.ts:72-102`）新增：

```ts
resolveReasoningEfforts?(input: {
  provider?: string;
  model?: string;
}): Promise<string[] | undefined> | string[] | undefined;
```

`packages/server/src/application/daemon-application.ts:395` 组装加载器时注入：用 `createModelCatalogService()` 载入目录，调 `catalogModelReasoningEfforts`。目录服务实例在 DaemonApplication 生命周期内复用（`load()` 自带缓存）。

`packages/agent-runtime/src/default-runtime.ts:231-248` 的 `engineOptions` 增加 `reasoningEffort: configuration.reasoningEffort`；`packages/core/src/engine/query-engine.ts` 构造函数保存该值，并在第 365 行的 `streamMessage({...})` 里加 `...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {})`。

`packages/api/src/providers/openai.ts:183-191` 的 `createParams` 增加：

```ts
...(params.reasoningEffort
  ? { reasoning_effort: params.reasoningEffort as OpenAI.ChatCompletionCreateParamsStreaming["reasoning_effort"] }
  : {}),
```

`AnthropicClient` 与 `CodexSubscriptionClient` 不读取该字段（不发送、不报错）。

### 5. 子代理

`packages/agent-runtime/src/child-agent-options.ts` 的 `deriveChildAgentOptions`：

- 子代理沿用父模型（`child.model` 未设置）时，继承 `configuration.reasoningEffort`。
- 子代理指定了不同模型时，不继承（`reasoningEffort: undefined`），避免把父模型的档位发给不支持的模型。

### 6. 系统提示词

`packages/prompts/src/prompt-segments-assembly.ts:113-115` 保持不变，继续用 `configuration.effort ?? settings.effort` 输出 `- Effort: X`。本次不改变提示词行为。

### 7. 桌面端选择器

在 `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/` 新增 `effort-picker.tsx`，并在 `controls.tsx` 增加 `EffortMenu`（对齐 `PermissionModeMenu`）。`composer.tsx` 在权限选择器旁（第 279-310 行区域）渲染：

- 当前模型从 `models` 里按 `selectedModel` + `selectedProvider` 解析；`reasoningEfforts` 为空或不存在时不渲染选择器。
- 选项 = 声明档位，加一项「默认」用于清除。
- 选中值 = `sessionEffort(session, defaultEffort)` 若在声明档位内，否则显示「默认」。
- 选择后：已有会话调 `updateSessionEffort(activeSessionId, value)`；新会话调 `selectEffort(value)`。

`conversation-page.tsx`（约 105-107、499、619、657 行）与新会话页 `new-conversation-start.tsx`（约 48、96、126、433、461 行）同步透传 `effort` / `onSelectEffort`。

`apps/desktop/src/renderer/src/stores/desktop-session/`（`types.ts`、`initial-state.ts`、`session-actions.ts`、`session-view-actions.ts`、`bootstrap-actions.ts`、`helpers.ts`）按 `permissionMode` 的既有模式补齐 effort 的 state、helper、action 与 bootstrap 字段。`DesktopBootstrapData`（`session-types.ts`）增加 `defaultEffort?: string`。

档位中文标签：`low→低`、`medium→中`、`high→高`、`xhigh→极高`、`max→最高`、`minimal→极低`、`none→关闭`、其余回退原值。

## 组件边界与数据流

```text
models.dev api.json
  reasoning_options: [{ type: "effort", values: [...] }]
    ├─[展示] model-service.toModelInfo → ModelInfo.reasoningEfforts
    │          → DesktopModel.reasoningEfforts → 模型卡片 + effort 选择器
    └─[发送] daemon-application 注入 resolveReasoningEfforts
               → catalogModelReasoningEfforts(catalog, provider, model)
               → daemon-agent 校验有效档位 ∈ 声明档位
               → configuration.reasoningEffort
               → QueryEngineOptions → StreamMessageParams.reasoningEffort
               → OpenAICompatibleClient 请求体 reasoning_effort
```

用户选择路径：

```text
composer 选择档位
  → 新会话：CreateDesktopSessionInput.effort → metadata.runtime.effort
  → 已有会话：sessionUpdateEffort → metadata.runtime.effort
  → 下一次运行由 daemon 读取并校验
```

## 状态、错误与安全

- 模型未声明档位：选择器不渲染；daemon 不产生 `reasoningEffort`；请求体不含 `reasoning_effort`。
- 有效档位不在声明集合（历史残留、模型切换）：daemon 静默丢弃，不报错。
- provider 缺失、未知、或自定义（非 models.dev）供应商：`catalogModelReasoningEfforts` 返回 `undefined`，不发送。
- 非 OpenAI 兼容后端：字段被忽略，不发送、不报错。
- 目录加载失败：`resolveReasoningEfforts` 返回 `undefined`（保守不发送），不阻塞 Agent 创建。
- `reasoning_options.values` 含 JSON `null` 或空白：解析时过滤。
- 空字符串 effort：视为未设置，不进入 runtime config。
- 会话运行中修改 effort：沿用 `runtimeSessionMetadataChanged` 的既有限制（有活动运行时返回 409），不新增规则。

## 测试与验收

自动化测试至少覆盖：

- `model-service`：`reasoning_options` 含 `effort` 时输出 `reasoningEfforts`；含 `null`/空白时过滤；无 `effort` 选项时不输出字段。
- `catalog-provider-mapping`：`catalogModelReasoningEfforts` 命中内置别名、目录供应商、缺失 provider/model 三种情况。
- `model-picker`：`formatReasoning` 输出带档位的文案；无档位保持原文案。
- `runtime-config`：`effort` 接受任意非空字符串；空字符串视为未设置；非字符串仍拒绝。更新原「rejects invalid runtime structure」用例（把 `effort: "old-effort"` 换成 `effort: 123`）。
- `child-agent-options`：同模型继承 `reasoningEffort`；换模型不继承；`effort` 接受任意非空字符串。更新原「ignores unsupported child effort values」用例中 `"ultra"` 的断言。
- `daemon-agent`：声明档位包含有效值时写入 `configuration.reasoningEffort`；不包含或未声明时不写入；目录缺失时不写入。
- `query-engine`：`reasoningEffort` 透传进 `streamMessage` 参数。
- `openai` 客户端：设置 `reasoningEffort` 时请求体含 `reasoning_effort`，未设置时不含。
- 桌面 store：`updateSessionEffort` 写入 `metadata.runtime.effort`；`sessionEffort` 读取与回退；`applyBootstrapData` 带 `defaultEffort`。
- 桌面组件：模型无声明档位不渲染选择器；选择档位触发回调。

人工验收：

- 用 opencode-go 的 `deepseek-v4.1-flash`（声明 `low/high/max`）：模型卡片显示档位；选择 `high` 后抓请求体确认 `reasoning_effort: "high"`；重开会话选择仍为 `high`。
- 切换到一个只声明 `toggle` 的模型：选择器消失，请求体不含 `reasoning_effort`。
- 全局 `settings.effort` 为 `medium` 且模型只声明 `low/high/max`：默认不发送。

## 不在范围内

- Anthropic `thinking.budget_tokens` 与 `max_tokens`/`temperature` 联动。
- Codex `reasoning.effort`。
- `toggle` / `budget_tokens` 类型的 UI 表达与预算映射。
- 设置页单独的全局推理强度选择器。
- 会话运行中热切换档位（仍走现有 409 限制）。
