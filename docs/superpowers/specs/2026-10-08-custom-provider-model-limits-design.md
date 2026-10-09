# 自定义供应商模型上下文与输出上限设计

日期：2026-10-08

状态：设计已确认；已按代码事实第二轮复核修订。实现计划见 [同名计划文档](../plans/2026-10-08-custom-provider-model-limits.md)。

关联文档：[自定义供应商设计说明](./2026-08-19-custom-providers-design.md)

## 目标

自定义供应商的每个模型可以声明「上下文大小」（上下文窗口）和「最大输出」。留空时行为与现在完全一致。

这两个值决定两件真实的事：上下文窗口是压缩服务的上下文上限（自动压缩阈值再从上限里扣掉输出预留与缓冲），同时是上下文用量条的分母；最大输出是单次请求的 `max_tokens`。目前自定义供应商无法声明它们，手写端点只能落到默认值，用户看到的是与自己模型不符的数字。

## 当前行为与问题

`CustomProviderModelSettings` 目前只有 `id`、`displayName`、`imageInputSupport` 三个字段，没有地方存这两个值：

```ts
interface CustomProviderModelSettings {
  id: string
  displayName: string
  imageInputSupport?: InputSupport
}
```

唯一的数值来源是 models.dev 目录。因此：

- 从目录添加的自定义供应商（`source: "models.dev"`）能拿到数值；手写端点拿不到。
- 拿不到上下文窗口时，用量条没有分母，上下文占用无法按比例展示；压缩服务退回 `CompactService` 的默认上限 `100_000`（`packages/core/src/engine/compact-service.ts:114-115`）。窗口是「设进去」而不是每次重算，所以切换模型后若新模型同样没拿到窗口，会沿用上一个模型设过的值。
- 拿不到最大输出时，回退到 `DEFAULT_OUTPUT_TOKEN_MAX`（32000），与模型真实能力无关。

## 数据模型

`CustomProviderModelSettings` 增加两个可选字段：

```ts
interface CustomProviderModelSettings {
  id: string
  displayName: string
  imageInputSupport?: InputSupport
  /** 上下文窗口，单位 token；未声明时回退 models.dev 目录值。 */
  contextWindow?: number
  /** 单次最大输出，单位 token；未声明时回退 models.dev 目录值。 */
  outputLimit?: number
}
```

两者都是正整数，缺失表示未声明。持久化位置不变，仍随 `Settings.customProviders` 保存。

## 取值规则

优先级固定为：

```
用户声明值 → models.dev 目录值 → 现有默认
```

**关键约束：代码里有两条互相独立的取值路径，必须套用同一规则。** 否则会出现「设置页显示 200K、实际按 128K 触发压缩」的错位。

| 路径 | 入口 | 用途 |
|------|------|------|
| 展示 | `model-service` 的模型服务 `list()` | 桌面设置页显示模型信息、编辑弹框回填，**以及上下文用量条的分母** |
| 运行时 | `agent-runtime` 的 `default-runtime` | 自动压缩的上下文上限、单次请求 `max_tokens` |

用量条的分母虽然显示在运行时界面上，取的却是展示路径的值：`resolveSessionModelContextLimits` 里 `resolveModelContextLimits` 的 `listProviders` 回调就是 `createDefaultModelService({ current: settings }).list()`（`packages/server/src/application/session/session-runtime-discovery.ts:26-31`、`packages/server/src/application/assemble-session-context-usage.ts:99-135`）。所以改展示路径时，用量条会一起被修好。

运行时路径不经过模型服务，它直接查目录，所以两处都要改。

本次只统一「声明值」这一层：两条路径都会先看声明值，所以用户一旦填了值，展示与实际必然一致。

「目录回退」这一层两条路径并不对称，这是既有行为，本次不改：

- 展示路径只在自定义供应商标记为 `source: "models.dev"` 时才查目录。
- 运行时路径不检查 `source`，只要 provider 与 model 能在目录里找到就用目录值。

后果：手写供应商的模型 id 恰好与目录键重合、且用户未声明数值时，运行时用目录值、设置页不显示数值。这是当前就存在的行为，不是本次引入；用户填上声明值即可消除不一致。

### 共用取数函数

在 `@vykor/core` 增加一个纯函数，两条路径共同使用：

```ts
export function resolveCustomProviderModelLimits(
  settings: Settings,
  provider: string | undefined,
  model: string,
): { contextWindow?: number; outputLimit?: number } | undefined
```

放在 `packages/core/src/config/settings.ts`，紧邻已有的 `resolveOutputTokenCap`。`server` 与 `agent-runtime` 都已依赖 `@vykor/core`，不新增包依赖，也避免这段判断写两遍。

函数只负责「从 `settings.customProviders` 里找出该 provider + model 的声明值」，不做目录回退；目录回退由各路径既有逻辑承担。

## 运行流程

1. Desktop 弹框提交自定义供应商配置，每个模型附带可选的上下文大小与最大输出。
2. 服务端规范化时校验并写入 `customProviders`；非法值丢弃，不阻塞保存。
3. 桌面快照读取设置，把解析后的有效值映射给展示层；同时把用户原始声明值单独透出给编辑弹框回填。
4. 展示路径（含用量条分母）由 `model-service` 解析当前 provider + model：先取声明值，缺失才查 models.dev 目录。
5. 运行时路径由 `default-runtime` 调用宿主注入的两个容量回调解析（回调由 server 侧的 `daemon-application` 提供，目录查询也在 server 侧）：先取声明值，缺失才查目录。
6. 上下文窗口经 `setContextWindow` 交给压缩服务（阈值 = 窗口 − 输出预留 − 缓冲），并作为用量条分母；最大输出交给 `setOutputReserve` 与 `resolveOutputTokenCap` 换算成 `max_tokens`。

## 各层改动

数据与入参（四处，纯加可选字段）

- `@vykor/core` 的 `CustomProviderModelSettings`（持久化类型，定义在 `packages/core/src/types/settings.ts:118-123`；`Settings.customProviders` 在同文件 `:147`。注意新函数 `resolveCustomProviderModelLimits` 放在 `packages/core/src/config/settings.ts`，**类型不要加到那个文件**）
- `@vykor/server` 的 `CustomProviderModelInput`（服务端入参）
- `@vykor/client` 的 `CustomProviderInput.models`（客户端入参）
- Desktop 的 `DesktopCustomProviderInput.models`（主进程入参）

写入校验

- `provider-service` 的 `normalizeCustomProvider`：模型映射时只保留合法正整数，其余丢弃。

运行时取值

- `agent-runtime` 的 `default-runtime`：把当前 `settings` 传给两个容量回调（签名在 `agent-options.ts:90,92`，调用点在 `default-runtime.ts:324-331`）。
- `server` 的回调实现：`daemon-application.ts:507-514` 现有的目录查询之前先查声明值（目录解析的真正实现位置，`default-runtime` 只是 await 注入进来的回调）。

展示取值

- `model-service` 的自定义供应商分支：命中目录的分支在生成模型信息后覆盖声明值；未命中目录的分支在建对象时补上声明值。上下文用量条的分母走同一个 `list()`，改动随之生效，不需要额外改代码，但测试要覆盖到这条链路（见「测试」）。

桌面快照与界面

- `DesktopProviderInfo` 增加 `declaredModels`，只承载用户原始声明值（结构见「Desktop 交互」）。
- `buildDesktopProviderSnapshot` 里现有的自定义供应商解析函数需要扩展：它在提取 `id`、`baseUrl`、`source`、`headers` 时一并解析各模型的声明数值。
- `custom-provider-form`：模型行增加两个字段，并在校验函数里做数字解析。
- `custom-provider-dialog`：每个模型占两行，第二行放「上下文大小」「最大输出」。

不改 `DesktopProviderModel`：它本身就是由 `client.providers.listModels()` 的结果构建的（`apps/desktop/src/main/features/provider/provider-service.ts:26-36`、`:155-163`），上下文数值已经能带出来。`outputLimit` 也已经有人在读，不需要新增字段：会话输入框的模型选择器悬浮卡渲染「最大输出」一行（`apps/desktop/src/renderer/src/components/desktop/conversation-page/composer/model-picker.tsx:160` 读 `DesktopModel.outputLimit`，字段定义在 `apps/desktop/src/shared/session-types.ts:52`，取值来源与 `ProviderModelInfo` 是同一个字段，`packages/client/src/types/index.ts:313-314`）。所以声明值会同时改变运行时行为和选择器展示。编辑弹框需要的原始声明值走新字段 `declaredModels`。

## Desktop 交互

模型行保持现有结构：第一行是 ID、显示名称、图片输入能力、删除按钮。第二行新增两个数字输入，标签为「上下文大小」和「最大输出」，单位 token，占位提示标明留空即自动取值。

编辑回填必须区分两个来源：

- `models`（现有字段）是解析后的有效值，用于展示「这个模型实际按多少 token 计算」。编辑框的 ID、显示名称、图片输入能力仍从这里取。
- `declaredModels`（新增字段）只承载数值声明，按模型 id 索引：

```ts
declaredModels?: Array<{ id: string; contextWindow?: number; outputLimit?: number }>
```

编辑框的两个数字输入只从 `declaredModels` 按 id 取值，取不到就留空；其余字段不受影响。

之所以要区分：如果数字输入回填有效值，那么目录带来的数值会在用户下次保存时被静默固化成声明值，之后目录更新不再生效。用户什么都没改，却产生了持久化的行为变化。

因此编辑框只回填声明值，读不到就留空。用户清空输入并保存，声明随之被移除，该模型回到目录 / 默认值。

## 校验

服务端与表单使用同一套规则：

- 留空 → 不写入该字段。
- 只接受正整数。`0`、负数、小数、非数字在表单里报错。
- 上限 `1 ~ 10,000,000`，防止手滑多打一个 `0`。
- 服务端校验失败时丢弃该字段而不是拒绝整个请求，保证旧客户端或手改配置不会因为一个坏值无法保存。这与同一函数对 `id`、`displayName`、`baseUrl`、`apiFormat`、`models` 的处理不同——那几项非法时抛 400（`packages/server/src/application/default-services/provider-service.ts:415-453`）。数值字段故意按「可丢弃」处理，是刻意的例外。

## 沿用的既有行为

以下逻辑本次不改，但会直接影响用户看到的结果，需要在文档和使用提示里说明：

- 最大输出会被 `resolveOutputTokenCap` 换算（`packages/core/src/config/settings.ts:14-18`），第二入参 fallback 为 `settings.outputTokenMax ?? 32000`：未声明时直接用 fallback；声明值小于等于 fallback 时原样保留；大于 fallback 时变为 `max(fallback, round(声明值 × 0.5))`。所以声明 100000 实际只按 50000 用，声明值不会无损生效。
- 上下文窗口不是自动压缩阈值本身，只是阈值计算的上限：`threshold = maxTokens − outputReserve − AUTOCOMPACT_BUFFER_TOKENS`，其中 `maxTokens` 即上下文窗口（`packages/core/src/engine/compact-service.ts:196-197`）。
- 因此声明的 `outputLimit` 会间接影响压缩触发点：换算后的值经 `setOutputReserve` 抬高输出预留，把清理线压低（`compact-service.ts:148-153`）。
- 但 `setOutputReserve` 内部有下限 `MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000`（`compact-service.ts:67`、`:152`）。换算后的上限不超过 20000 时输出预留不变，压缩阈值也就不变——声明 8192 这类常见小值只影响单次请求的输出上限，不影响压缩。这条要写进使用提示。
- 上下文窗口用作用量条分母时是原值，不做折扣（`packages/core/src/context-budget/assemble.ts:48-50`）。
- 设置页不新增 `outputLimit` 展示位；但模型选择器悬浮卡的「最大输出」会显示它（见上文「桌面快照与界面」）。

## 兼容性与边界

- 已有配置不含新字段，读取时视为未声明，行为与现在完全一致，无需迁移。
- models.dev 目录数据本身不改。
- 内置供应商的行为不改；本次只覆盖 `Settings.customProviders`。
- 编辑保存时模型列表整体替换，因此「清空字段」等价于「删除声明」。
- 声明值只有手写供应商能写：新字段都加在手写供应商的写入口上；目录来源供应商的写入口（`ConnectCatalogProviderInput`）本身不带模型列表（`packages/client/src/types/index.ts:297-301`），所以「表单 + 服务端校验」这条分支对目录来源不可达。这不是功能缺失——目录来源的数值本来就来自 models.dev。
- 改动声明值后，运行中的会话不一定立刻用上新值：`customProviders` 不在设置服务的「软失效键」集合里（`packages/server/src/application/default-services/settings-service.ts:44-55`），而运行时持有 `settings` 快照。是否需要让设置重载一并刷新，留待实现时确认。
- CLI 侧无需改动：`apps/cli/src/config-coerce.ts:17-19` 已覆盖 `outputTokenMax`，`packages/server/src/settings-transfer.ts:63-67` 已把 `customProviders` 列入传输校验字段。

## 测试

- `@vykor/core`：`resolveCustomProviderModelLimits` 命中、未命中 provider、未命中 model、两者都缺失。
- `@vykor/server`：`normalizeCustomProvider` 保留合法值、丢弃非法值；模型服务自定义分支能带出声明值，且在命中目录时声明值覆盖目录值；用量条链路的 `resolveSessionModelContextLimits` / `createSessionRuntimeDiscovery().resolveModelLimits` 在模型声明了 `contextWindow` 时返回该值，未声明时仍返回 `list()` 的解析值。
- `@vykor/agent-runtime`：`default-runtime` 声明值优先，缺失时回退目录回调；两者都缺失时仍写入 `maxOutputTokens`（回退全局 `outputTokenMax`），只有 `contextWindow` 被省略。
- Desktop：`validateCustomProviderForm` 的数字解析与报错；编辑弹框回填只取 `declaredModels`。

## 不包含

- 不增加供应商级默认值，只按模型声明。
- 不新增 `outputLimit` 的界面展示位；模型选择器悬浮卡里已有的「最大输出」不算新增。
- 不做模型列表自动拉取或数值自动探测。
- 不支持 Anthropic 自定义协议，与既有边界一致。
