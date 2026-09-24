# 推理强度（Reasoning Effort）按会话控制设计

> 状态：待实现。

## 目标

让「模型实际声明了推理强度档位」的模型，能在模型卡片里看到档位、在输入框旁按会话选择档位，并把选中的档位以 `reasoning_effort` 发给 OpenAI 兼容后端。模型没有声明档位时不显示选择器、也不发送字段，避免未知字段导致 400。

本次只打通 OpenAI 兼容后端（`openai_compat`，覆盖 opencode-go 这类目录供应商）。Anthropic 的 thinking budget 与 Codex 的 reasoning 不在范围内。

## 背景与现状

- models.dev 目录里有 `reasoning_options`，但类型没声明、转换时被丢弃：
  - `packages/api/src/models/catalog.ts:19-39` 的 `ModelsDevModel` 没有该字段。
  - `packages/server/src/application/default-services/model-service.ts:122-145` 的 `toModelInfo` 只输出 `reasoning: boolean`。
- catalog 里 `reasoning_options` 只有三种形态，实测（对整个 `api.json` 统计）：`toggle` 1313 处、`effort` 3437 处、`budget_tokens` 677 处。本次只消费 `effort`。
- `effort` 设置当前**只拼进系统提示词**，从未进入请求：
  - 取值定义在 `packages/core/src/types/settings.ts:151`（`"low" | "medium" | "high"`），默认 `medium`（`packages/core/src/config/settings.ts:49`）。
  - 提示词注入在 `packages/prompts/src/prompt-segments-assembly.ts:113-115`（输出 `- Effort: high`）。
  - `packages/api/src/providers/*` 里搜不到任何 effort / reasoning_effort 相关代码（命中的 `reasoning_content`、`reasoning.encrypted_content` 是另一回事）。
- 会话运行时的 `effort` 已可用：`packages/protocol/src/runtime-config.ts:13` 定义了 `SessionRuntimeConfig.effort`，`packages/server/src/daemon/daemon-agent.ts:248-276` 的 `agentConfigurationFromSession` 会把它合成进 Agent 配置的 `effort`；`packages/agent-runtime/src/default-runtime.ts:221` 用它生成系统提示词。
- `effort` 被硬编码成 `low|medium|high` 的校验点共 8 处：
  1. `packages/core/src/types/settings.ts:151`（类型）
  2. `packages/protocol/src/runtime-config.ts:13,45-47,72`（类型 + `effortValue` + switch）
  3. `packages/agent-runtime/src/child-agent-options.ts:56-60`（`isSupportedEffort`）
  4. `packages/server/src/daemon/scheduled-task-service.ts:441`（定时任务校验）
  5. `packages/tools/src/schedule/scheduled-task-tools.ts:55,189`（工具 schema `enum`）
  6. `packages/client/src/commands/session-commands.ts:766-780`（`/effort` 命令）
  7. `packages/coordinator/src/agent-loader.ts:20,138`（Agent 定义 frontmatter `EFFORT_LEVELS`）
  8. `packages/server/src/application/agent/daemon-agent-event-projector.ts:217,798`（`isRuntimeEffort`，子会话 runtime 投影）
- 已安装的 `openai@4.104.0` 支持请求字段 `reasoning_effort`：`resources/chat/completions/completions.d.ts:1104`，类型 `resources/shared.d.ts:137` 为 `'low' | 'medium' | 'high' | null`（偏窄，需要局部断言才能发任意字符串）。

## 术语

- **推理强度 / effort**：用户可见的一档取值，字符串。
- **声明档位（declared）**：catalog 中某模型 `reasoning_options` 里 `type === "effort"` 的 `values`，过滤掉非字符串、`null` 与空白后的列表。
- **会话选择值**：`session.metadata.runtime.effort` 里的非空字符串。空字符串是「已清除」哨兵，见下文。
- **发送值（reasoningEffort）**：只有「会话选择值存在于当前模型的声明档位里」时才产生；否则视为未设置。

## 设计决策

1. **复用现有 `effort` 作为唯一用户选择值**，会话选择写入 `session.metadata.runtime.effort`。
2. **只有会话显式选择才发送**（本版决策，取代早期草案的「回退全局」）。理由：
   - 全局 `settings.effort` 是提示词层的软提示，默认 `medium`；若它自动成为发送值，会导致「用户从未选择也发 `reasoning_effort`」，且「清除会话选择」无法压过全局默认，语义自相矛盾。
   - 因此全局 `settings.effort` 继续只影响系统提示词（现状不变）；要改变实际发送的推理强度，必须在会话里选择。会话未选择或已清除时，请求体不带 `reasoning_effort`，交给供应商默认。
   - `/effort` 命令（全局设置）同样只影响提示词；这是已知的语义差异，见「不在范围内」。
3. **请求层新增 `reasoningEffort`**，作为「已校验、可安全发送」的中间值。它与 `effort` 分开的原因：`effort` 还要继续驱动系统提示词和子代理继承，不能因为当前模型不支持就整体清空。
4. **校验发生在 daemon 组装 Agent 时**（那里能同时拿到会话 runtime 和模型目录），UI 只做「按声明档位展示与选择」。这样即使历史会话残留了不匹配的档位，也不会发出去。
5. **模型没有声明档位时不显示、不发送**（用户已确认）。仅声明 `toggle` / `budget_tokens` 的模型同样不显示选择器。
6. **`effort` 放宽为自由字符串**（用户已确认按模型动态取值）。协议与设置层不再枚举校验，只校验「非空字符串」，并允许空字符串作为 effort 的「已清除」哨兵。
7. **composer 按会话选择**（用户已确认）。新会话在选择时先存内存值，创建会话时写入 `metadata.runtime.effort`；已有会话通过 `sessions.update` 写入。

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

### 共享派生函数（避免重复实现与循环依赖）

`packages/server/src/application/default-services/catalog-provider-mapping.ts` 新增并导出：

```ts
export function reasoningEffortsFromModel(
  model: Pick<ModelsDevModel, "reasoning_options">,
): string[] | undefined;

export function catalogModelReasoningEfforts(
  catalog: ModelsDevCatalog,
  providerName: string | undefined,
  modelId: string,
): string[] | undefined;
```

- `reasoningEffortsFromModel`：取 `reasoning_options` 中 `type === "effort"` 的 `values`，过滤非字符串、`null`、空白；结果为空时返回 `undefined`。
- `catalogModelReasoningEfforts`：`readCatalogProvider(catalog, providerName)` → 按 `model.id?.trim() || key` 匹配 `modelId` → 调 `reasoningEffortsFromModel`；找不到时返回 `undefined`。
- **落点说明**：`model-service.ts:16` 已经 import `catalog-provider-mapping.ts`，所以共享函数必须定义在 `catalog-provider-mapping.ts`，由 `model-service.ts` 反向 import 复用；否则会成环。

### 模型信息层

`ModelInfo`（`packages/server/src/application/settings-api.ts:75-89`、`packages/client/src/types/index.ts:367-381`）与 `DesktopModel`（`apps/desktop/src/shared/session-types.ts:39-53`）统一新增：

```ts
reasoningEfforts?: string[];
```

语义：该模型声明的 effort 档位；未声明时为 `undefined`（不是空数组）。

### 请求链路

- `packages/core/src/types/client.ts:5-13` `StreamMessageParams` 增加 `reasoningEffort?: string`。
- `packages/core/src/types/runtime.ts:488` `QueryEngineOptions` 增加 `reasoningEffort?: string`。
- `packages/agent-runtime/src/agent-options.ts:41-73` `VykorAgentConfiguration` 增加 `reasoningEffort?: string`。

### 设置与协议放宽

- `packages/core/src/types/settings.ts:151`：`effort?: string`。
- `packages/protocol/src/runtime-config.ts`：`SessionRuntimeConfig.effort?: string`；`effortValue` 按下面的真值表实现。
- 其余 6 处硬编码校验（背景第 4-8 条）统一放宽为「非空字符串」；`scheduled-task-tools.ts` 的两处工具 schema 去掉 `enum`，保留 `type: "string"`。

## 行为规格

### 1. `effort` 的清除语义（真值表）

这是本次唯一需要「删除」语义的字段，必须严格按下列规则实现：

| 输入 `value` | `effortValue(value)` | `readRuntimeMetadata` 校验 | `readSessionRuntimeConfig` 结果 |
| --- | --- | --- | --- |
| 非空字符串（trim 后非空） | 去空格后的字符串 | 合法 | 产出 `effort` |
| 空字符串或纯空白 | `""` | 合法（哨兵） | **不产出** `effort`，且**不回退** `defaults.effort` |
| 缺少该 key / `undefined` | `undefined` | 合法 | 回退 `defaults.effort`（当传入时） |
| 非字符串（数字、布尔、对象等） | `undefined` | 非法，抛 `ProtocolDataError` | 不适用 |

要点：

- `effortValue` 对空字符串返回 `""`（不是 `undefined`），否则 `readRuntimeMetadata` 的 `valid = effortValue(value) !== undefined` 会判非法，清除直接失败。
- `readSessionRuntimeConfig` 现有写法 `...(effortValue(runtime.effort) ?? defaults?.effort ? { effort: ... } : {})` 对 `""` 恰好短路（`"" ?? default` 得 `""`，为 falsy），因此**不需要改表达式**，但要补测试固定该行为。
- 会话 runtime 的清除写入 `metadata.runtime.effort = ""`。

`readSessionRuntimeConfig` 的默认值来源调整见第 4 节。

### 2. 目录解析

`packages/server/src/application/default-services/model-service.ts` 的 `toModelInfo` 调用 `reasoningEffortsFromModel(model)`，输出 `...(efforts ? { reasoningEfforts: efforts } : {})`。内置供应商与 models.dev 目录供应商都会经过 `toModelInfo`，因此两者都生效。

### 3. 模型卡片展示

`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/model-picker.tsx:118-122`：

- `reasoning !== true` → `不支持推理` / `—`（保持现状）。
- `reasoning === true` 且 `reasoningEfforts?.length` → `支持推理（low / high / max）`。
- `reasoning === true` 无档位 → `支持推理`（保持现状）。

### 4. Agent 配置的 effort 来源调整

`packages/server/src/daemon/daemon-agent.ts:248-276` 的 `agentConfigurationFromSession` 目前把 `settings?.effort` 作为 `readSessionRuntimeConfig` 的 `effort` 默认值（第 258 行）。改为**不再传 `effort` 默认值**，使 `configuration.effort` 只表示「会话显式选择值」：

- 提示词行为不变：`default-runtime.ts:221` 仍是 `configuration.effort ?? settings.effort`，会话未选择时照旧用全局值。
- 这样 `configuration.effort` 可直接作为候选发送值，且「清除」能被正确表达（不产出 → 候选为空）。

### 5. 校验与发送（daemon）

`packages/server/src/daemon/daemon-agent.ts` 的加载器（`createDaemonAgentLoader`，第 114 行）在异步回调里、构造 `agentOptions` 之前：

1. `const configuration = agentConfigurationFromSession(session, settings);`
2. 取声明档位（**必须 try/catch**）：
   ```ts
   let declared: string[] | undefined;
   try {
     declared = await options.resolveReasoningEfforts?.({
       provider: configuration.provider,
       model: configuration.model,
     });
   } catch {
     declared = undefined;
   }
   ```
3. 计算发送值：
   ```ts
   const chosen = configuration.effort;
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

`packages/server/src/application/daemon-application.ts:395` 组装加载器时注入：创建并复用 `createModelCatalogService()`（目录服务自带内存缓存，`catalog.ts:90-141`），实现里调 `catalogModelReasoningEfforts`。provider 或 model 缺失时直接返回 `undefined`。

**注意**：目录首次 `load()` 可能发起网络请求（超时上限 10 秒，`catalog.ts:111-135`）。规格不要求它对首次加载做超时缩短；但因为已有内置副本来源与 catch fallback，失败会降级为空档位（不发送），不会阻塞 Agent 创建。resolver 自身抛错也必须被上面的 try/catch 吞掉。

`packages/agent-runtime/src/default-runtime.ts:231-248` 的 `engineOptions` 增加 `reasoningEffort: configuration.reasoningEffort`；`packages/core/src/engine/query-engine.ts` 构造函数保存该值，并在第 365 行的 `streamMessage({...})` 里加 `...(this.reasoningEffort ? { reasoningEffort: this.reasoningEffort } : {})`。

`packages/api/src/providers/openai.ts:183-191` 的 `createParams` 增加：

```ts
...(params.reasoningEffort
  ? { reasoning_effort: params.reasoningEffort as OpenAI.ChatCompletionCreateParamsStreaming["reasoning_effort"] }
  : {}),
```

`AnthropicClient` 与 `CodexSubscriptionClient` 不读取该字段（不发送、不报错）。

### 6. warm Agent 失效不变量

发送值在 Agent 创建时固定进 `QueryEngine`（`default-runtime.ts:231`）。已缓存的 warm Agent 不会被重新计算（`agent-pool.ts` 对 active agent 直接返回），因此**任何 effort 或 model 变更都必须走 `sessions.update`（`session-command-service.ts:212-286`）**：`runtimeSessionMetadataChanged` 为真时现有逻辑会关闭旧 Agent，下次 acquire 重建并重算发送值。

- 桌面 `updateSessionEffort` 必须复用 `updateSessionPermissionMode` 的同一路径（`session-operations.ts:398-409`，写 `metadata.runtime.effort`），不得走轻量内存 patch。
- 新增回归测试：warm 后改 effort → 旧 Agent 被关闭、下次发送值更新；warm 后换模型 → 不复用旧 `reasoning_effort`。

### 7. 子代理

`packages/agent-runtime/src/child-agent-options.ts` 的 `deriveChildAgentOptions` 目前 `...configuration` 会把 `reasoningEffort` 默认带下去，必须显式覆盖。规则：

```ts
const childModel = child.model ?? configuration.model;
const childEffort = child.effort ?? configuration.effort;
const inheritsModel = childModel === configuration.model;
const effortUnchanged = childEffort === configuration.effort;
reasoningEffort: inheritsModel && effortUnchanged
  ? configuration.reasoningEffort
  : undefined,
```

即：只有「子代理沿用同一模型」且「子代理 effort 未改变」时才继承，否则显式置空，避免把父模型的档位发给不支持的模型，也避免提示词 effort 与请求 effort 不一致。

### 8. 系统提示词

`packages/prompts/src/prompt-segments-assembly.ts:113-115` 保持不变，继续用 `configuration.effort ?? settings.effort` 输出 `- Effort: X`。

### 9. 桌面端选择器

在 `apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/` 新增 `effort-picker.tsx`，并在 `controls.tsx` 增加 `EffortMenu`（对齐 `PermissionModeMenu`）。`composer.tsx` 在权限选择器旁（第 279-310 行区域）渲染：

- 当前模型从 `models` 里按 `selectedModel` + `selectedProvider` 解析；`reasoningEfforts` 为空或不存在时不渲染选择器。
- 选项 = 声明档位，加一项「默认」表示清除。
- 选中值 = `sessionEffort(session)`（读原始 `metadata.runtime.effort` 三态：缺 key → `null`；`""`/空白 → `null`；非空 → 该值）且该值在声明档位内时高亮，否则高亮「默认」。**不引入全局默认值的展示**（因为全局值不参与发送）。
- 选择后：已有会话调 `updateSessionEffort(activeSessionId, value)`（`""` 表示清除）；新会话调 `selectEffort(value)`（内存），创建会话时写入 `metadata.runtime.effort`。

`conversation-page.tsx`（约 105-107、499、619、657 行）与新会话页 `new-conversation-start.tsx`（约 48、96、126、433、461 行）同步透传 `effort` / `onSelectEffort`。

`apps/desktop/src/renderer/src/stores/desktop-session/`（`types.ts`、`initial-state.ts`、`session-actions.ts`、`session-view-actions.ts`、`bootstrap-actions.ts`、`helpers.ts`）按 `permissionMode` 的既有模式补齐 effort 的 state、helper、action。**不新增 `defaultEffort` 到 bootstrap**（YAGNI，避免全局默认误导展示）。

档位中文标签：`low→低`、`medium→中`、`high→高`、`xhigh→极高`、`max→最高`、`minimal→极低`、`none→关闭`、`default→默认`，其余回退原值。

### 10. 新会话持久化

`CreateDesktopSessionInput`（`apps/desktop/src/shared/session-types.ts:293-300`）增加 `effort?: string`；`session-operations.ts:191-217` 的 `createSession` 把它写进 `metadata.runtime.effort`（与 `permissionMode` 并列）。仅在用户选择过时写入；未选择时不写。

## 组件边界与数据流

```text
models.dev api.json
  reasoning_options: [{ type: "effort", values: [...] }]
    ├─[展示] catalog-provider-mapping.reasoningEffortsFromModel
    │          → model-service.toModelInfo → ModelInfo.reasoningEfforts
    │          → DesktopModel.reasoningEfforts → 模型卡片 + effort 选择器
    └─[发送] 会话显式选择 metadata.runtime.effort
               → daemon-application 注入 resolveReasoningEfforts
               → catalogModelReasoningEfforts(catalog, provider, model)
               → daemon-agent 校验 选择值 ∈ 声明档位
               → configuration.reasoningEffort
               → QueryEngineOptions → StreamMessageParams.reasoningEffort
               → OpenAICompatibleClient 请求体 reasoning_effort
```

用户选择路径：

```text
composer 选择档位
  → 新会话：CreateDesktopSessionInput.effort → metadata.runtime.effort
  → 已有会话：sessionUpdateEffort → sessions.update → metadata.runtime.effort
  → sessions.update 触发 Agent 关闭（warm 失效）
  → 下一次运行由 daemon 读取并校验
```

## 状态、错误与安全

- 模型未声明档位：选择器不渲染；daemon 不产生 `reasoningEffort`；请求体不含 `reasoning_effort`。
- 会话未选择或已清除：`configuration.effort` 为 `undefined`，不发送；系统提示词回退全局 `settings.effort`。
- 选择值不在声明集合（历史残留、模型切换）：daemon 静默丢弃，不报错。
- provider 或 model 缺失、未知、或自定义（非 models.dev）供应商：返回 `undefined`，不发送。
- 非 OpenAI 兼容后端：字段被忽略，不发送、不报错。
- 目录加载失败或 resolver 抛错：try/catch 降级为 `undefined`，不阻塞 Agent 创建。
- `reasoning_options.values` 含 JSON `null`、数字、布尔、空白：解析时过滤。
- 会话运行中修改 effort：沿用 `runtimeSessionMetadataChanged` 的既有限制（有活动运行时返回 409），不新增规则。
- 残余风险：models.dev 声明的是「供应商接受该值」的假设而非保证，个别网关仍可能对 `max`/`xhigh`/`none` 返回 400。本次不做失败降级或重试，只在验收中记录。

## 测试与验收

自动化测试至少覆盖：

- `catalog-provider-mapping`：`reasoningEffortsFromModel` 过滤 `null`、非字符串、空白；无 `effort` 选项返回 `undefined`。`catalogModelReasoningEfforts` 命中内置别名、目录供应商、缺失 provider/model 三种情况。
- `model-service`：`toModelInfo` 输出 `reasoningEfforts`；无声明时不输出该字段。
- `model-picker`：`formatReasoning` 输出带档位的文案；无档位保持原文案。
- `runtime-config`：`effortValue` 真值表（非空字符串去空格；`""`/空白 → `""`；非字符串 → 非法）。`readRuntimeMetadata` 接受 `effort: ""`。`readSessionRuntimeConfig` 对 `""` 不产出 `effort` 且不回退默认值。更新原「rejects invalid runtime structure」用例：把 `effort: "old-effort"` 换成 `effort: 123`。
- `session-command-service`：写 `effort: ""` 的往返成功（不抛 400），且 `metadata.runtime.effort` 保留 `""`。
- `child-agent-options`：同模型且子代理 effort 未变时继承 `reasoningEffort`；换模型不继承；子代理改 effort 不继承；`effort` 接受任意非空字符串。更新原「ignores unsupported child effort values」用例中 `"ultra"` 的断言。
- `daemon-agent`：声明档位包含选择值时写入 `configuration.reasoningEffort`；不包含或未声明时不写入；resolver 抛错时不写入且仍能建 Agent。
- `daemon-agent`：warm 后改 effort/换模型会关闭旧 Agent（回归）。
- `query-engine`：`reasoningEffort` 透传进 `streamMessage` 参数。
- `openai` 客户端：设置 `reasoningEffort` 时请求体含 `reasoning_effort`，未设置时不含。
- 桌面 store：`updateSessionEffort` 走 `sessions.update` 且写入 `metadata.runtime.effort`；`sessionEffort` 三态（缺 key / `""` / 非空）；`createSession` 带 `effort` 时落进 metadata。
- 桌面组件：模型无声明档位不渲染选择器；选择档位触发回调；清除后显示「默认」。
- CLI `/effort`：接受任意非空字符串；非法（空）时给出提示。`scheduled-task-service` 校验放宽的用例。

人工验收：

- 用 opencode-go 的 `deepseek-v4.1-flash`（声明 `low/high/max`）：模型卡片显示档位；选择 `high` 后抓请求体确认 `reasoning_effort: "high"`；重开会话选择仍为 `high`。
- 切换到一个只声明 `toggle` 的模型：选择器消失，请求体不含 `reasoning_effort`。
- 清除选择后：选择器显示「默认」，请求体不含 `reasoning_effort`（即使全局 `settings.effort` 为 `medium`）。
- warm Agent 存在时切换 effort 或模型：下一轮请求使用的是新值。

## 不在范围内

- Anthropic `thinking.budget_tokens` 与 `max_tokens`/`temperature` 联动。
- Codex `reasoning.effort`。
- `toggle` / `budget_tokens` 类型的 UI 表达与预算映射。
- 设置页单独的全局推理强度选择器；全局 `settings.effort` 保持提示词层语义，`/effort` 也只改全局（提示词）。
- 会话运行中热切换档位（仍走现有 409 限制）。
- 供应商对未知档位返回 400 时的自动降级重试。
