# 供应商请求头模板设计

## 状态与决策

本文定义自定义供应商和已连接目录供应商的动态请求头能力。

最终决策：

- 请求头模板保存在 `Settings.customProviders[].headers`。
- 真正的自定义供应商和带 `source: "models.dev"` 的已连接目录供应商共用同一数据结构、展开器和运行时路径。
- 模板值支持 `{{sessionId}}` 和 `{{userAgent}}`；请求头名称不支持模板。
- 模板只在请求边界展开，展开后的值不写回 `settings.json`。
- daemon 只负责把稳定的会话 ID 传给 agent runtime，不识别具体供应商，也不组装供应商请求头。
- 内置供应商暂不读取该配置，也不新增独立的 `providerHeaders` 设置。
- API Key 继续保存在 `credentials.json`；非机密请求头模板继续保存在 `settings.json`。
- 删除当前按供应商名称或 URL 判断 OpenCode Go 的专用适配，改由用户配置的通用模板解决。

## 背景

OpenCode Go 要求同一对话的请求携带稳定的
`x-opencode-session`，并建议客户端使用自己的 User-Agent。当前临时实现通过
`isOpenCodeGoTarget` 和 `buildOpenCodeGoHeaders` 识别特定供应商并写入请求头。
这种实现可以修复单一供应商，但会形成“一家供应商一个适配器”的扩展模式。

项目已有两类可以保存请求头的供应商：

1. 用户创建的自定义供应商。
2. 从 models.dev 连接后持久化到 `customProviders`、并带
   `source: "models.dev"` 的目录供应商。

两类供应商在运行时都会通过 `resolveCustomProviderRuntime` 读取 Base URL 和
`headers`，因此动态模板应建立在现有数据模型上，而不是引入 daemon 特判或新的
供应商配置仓库。

## 目标

1. 让自定义供应商和目录供应商都能配置静态或动态请求头。
2. 同一个模板在一个会话内展开为稳定值，不同会话使用不同的 `sessionId`。
3. 让 Desktop 的“自定义供应商”和“可连接目录供应商”保持两个独立入口。
4. 让凭证校验和正式模型请求使用同一模板语义。
5. 新增同类请求头需求时，只增加配置，不增加供应商判断函数。
6. 保持现有合法且不包含保留模板语法的静态请求头兼容。

## 非目标

- 本阶段不为 registry 中的内置供应商增加请求头设置。
- 不把请求头模板迁移到 `credentials.json`。
- 不支持环境变量、时间、随机数或任意表达式模板。
- 不在请求头名称中展开模板。
- 不新增按供应商 ID、域名或模型名自动注入请求头的 profile 注册表。
- 不改变自定义供应商当前只支持 OpenAI 兼容协议的边界。
- 不解决 models.dev 中单个供应商按模型选择不同传输协议的问题。
- 不在本功能中重构 settings 与 credentials 的跨文件事务模型。

## 方案比较

### 方案 A：供应商专用适配

为每个有特殊要求的供应商增加 `isXxxTarget` 和
`buildXxxHeaders`。实现直接，但供应商知识会扩散到 runtime 和凭证校验，后续
每增加一家都要修改生产代码和测试。

### 方案 B：daemon 组装时覆写

daemon 创建 Agent 时根据供应商修改 settings 或 client。该方案只能覆盖 daemon
路径，会遗漏 SDK、CLI 直连和凭证校验；子 Agent 还可能错误复用父会话的头。

### 方案 C：配置模板在造客户端时展开

供应商配置声明请求头模板，agent runtime 在造客户端时使用会话上下文展开。
daemon、CLI 和 SDK 共享同一个运行时入口，供应商逻辑不进入 daemon。

采用方案 C。它复用现有 `customProviders.headers`，改动集中，且新供应商不需要
新增适配器。

## 架构边界

### 1. Settings：保存声明，不保存运行值

现有类型保持不变：

```ts
interface CustomProviderSettings {
  id: string
  displayName: string
  baseUrl: string
  apiFormat: "openai"
  models: CustomProviderModelSettings[]
  headers?: Record<string, string>
  source?: "models.dev"
}
```

`headers` 的值可以是静态字符串，也可以包含受支持的模板变量：

```json
{
  "id": "opencode-go",
  "displayName": "OpenCode Go",
  "baseUrl": "https://opencode.ai/zen/go/v1",
  "apiFormat": "openai",
  "headers": {
    "User-Agent": "{{userAgent}}",
    "x-opencode-session": "{{sessionId}}"
  },
  "source": "models.dev"
}
```

`settings.json` 保存的始终是上面的模板原文。真实会话 ID 不持久化到设置文件。

供应商清单是用户级配置，`customProviders` 以用户目录下的
`~/.openharness-ts/settings.json` 为唯一权威来源。项目级
`.openharness/settings.json` 不得覆盖 `customProviders`。该规则在
`packages/core` 的 `loadSettings` 合并边界统一实现，而不是只在 daemon 组装时
修补，因此 daemon、CLI 和 SDK 得到相同结果；其他项目设置字段仍保持现有优先级。
这样 Desktop 修改的请求头与各运行入口实际造 client 时读取的请求头一致。

### 2. Provider Service：负责配置生命周期

真正的自定义供应商沿用现有创建、更新和删除流程。

目录供应商连接接口从只接收 API Key 扩展为接收：

```ts
interface ConnectCatalogProviderInput {
  apiKey: string
  headers?: Record<string, string>
}
```

连接成功后：

- `apiKey` 仍由 `CredentialStorage` 保存到 `credentials.json`。
- `headers` 与 id、Base URL、模型快照一起保存到
  `Settings.customProviders[]`。
- 目录条目必须保留 `source: "models.dev"`，UI 和服务层继续据此区分目录供应商
  与真正的自定义供应商。

目录连接输入中的 `headers` 使用三态语义：

- 首次连接时省略 `headers`：条目不包含请求头。
- 已连接供应商重新连接时省略 `headers`：保留原请求头。
- 显式提交 `headers: {}`：清空原请求头。

断开目录供应商时，删除对应的 `customProviders` 条目并清理该供应商凭证，行为与
当前实现一致。

settings 与 credentials 是两个文件，现有 Provider Service 无法提供跨文件事务。
本功能不承诺修复已有的一致性缺口，也不引入事务日志、pending 标记或数据库迁移：

- 自定义供应商和目录连接必须在任何写入前完成请求头校验与必要的远端凭证校验。
- 请求头更新 PATCH 只修改 settings，不读取或写入 credentials，因此可沿用
  `saveSettings` 的单文件原子替换。
- 首次连接、重连、更换密钥、删除和断开继续承担现有跨文件崩溃风险。进程若在两次
  写入之间退出，可能留下孤立凭证、无凭证快照，或“新密钥 + 旧配置”等混合代际
  状态；用户通过重新连接恢复。
- 真正解决组合配置与密钥更新的崩溃一致性，需要独立设计事务日志或统一持久化
  边界，不与请求头模板功能捆绑。

目录供应商的“已连接”状态定义为：用户级 settings 中存在对应
`source: "models.dev"` 快照，并且 CredentialStorage 中存在对应 API Key。仅有
孤立凭证时仍显示为“可连接”，重新连接会覆盖该凭证并建立快照。仅目录供应商要求
这两个条件；真正的自定义供应商继续允许没有 API Key 的 `configured` 状态，用于
无需认证的兼容接口。这样不会把无法解析 Base URL 和模型列表的目录供应商误判为
可用。

### 3. Header Template：唯一的展开边界

在 `packages/api/src/providers/request-header-templates.ts` 新增一个与具体供应商
无关的小模块。它同时提供规范化校验和运行时展开：

```ts
interface RequestHeaderTemplateContext {
  sessionId: string
  userAgent: string
}

function expandRequestHeaderTemplates(
  headers: Record<string, string> | undefined,
  context: RequestHeaderTemplateContext,
): Record<string, string> | undefined

function normalizeRequestHeaderTemplates(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined
```

职责仅包括：

- 遍历请求头值。
- 把全部 `{{sessionId}}` 替换为 `context.sessionId`。
- 把全部 `{{userAgent}}` 替换为 `context.userAgent`。
- 静态值原样返回。
- 不修改输入对象。

规范化校验必须：

- 去除头名和值两端空白，丢弃头名或值为空的项；
- 按 HTTP token 语法校验头名；
- 拒绝值中的 CR 和 LF，防止请求头注入；
- 拒绝忽略大小写后的重复头名；
- 拒绝不受支持的模板变量。

该模块不读取 settings、不识别供应商、不生成会话 ID，也不发送网络请求。这样可
单独测试，并可同时供 Provider Service、runtime 与凭证校验使用。

模板变量必须使用精确、区分大小写的名称。包含未知 `{{...}}` 的值在服务端保存时
拒绝，展开器也必须防御性拒绝从手工修改的配置文件读到的未知变量。错误信息指出
请求头名称和允许的变量，避免把未展开模板静默发送给上游。

统一 User-Agent 常量由通用模块导出，第一版为：

```text
openharness-ts/1.0
```

它属于客户端身份，不属于 OpenCode Go。

### 4. Agent Runtime：解析后再造客户端

`resolveApiClient` 已经能取得：

- 当前供应商名称；
- 当前供应商对应的 `customProviders` 条目；
- Base URL；
- daemon、CLI 或 SDK 传入的 `sessionId`。

运行时数据流为：

```text
Settings.customProviders[].headers
  -> expandRequestHeaderTemplates({ sessionId, userAgent })
  -> ProviderConfig.headers
  -> OpenAICompatibleClient.defaultHeaders
  -> 上游 HTTP 请求
```

只有命中 `customProviders` 的供应商读取并展开这些头。registry 中的内置供应商
不读取模板。

`sessionId` 必须由 Agent composition 在造 client 前建立，并原样传入
`resolveApiClient`。若配置包含 `{{sessionId}}` 而调用路径没有提供会话 ID，
运行时应明确报错，不得临时生成随机值；每次造 client 都生成随机值无法保证同一
对话稳定。

所有复用该 client 的主请求、压缩和记忆请求自然共享同一展开结果。

### 5. Daemon：只传会话身份

`createDaemonAgentLoader` 保持以下职责：

```text
durable SessionRecord.id
  -> OpenHarnessAgentOptions.sessionId
  -> createOpenHarnessRuntime
  -> resolveApiClient
```

daemon 不判断 `provider === "opencode-go"`，不修改
`customProviders.headers`，也不把展开值写回 settings。子 Agent 使用自己的
session ID，因此会自然得到独立的请求头值。

### 6. 凭证校验：使用显式校验上下文

自定义供应商保存和目录供应商连接都会调用 `/models` 校验 API Key。校验请求也
必须展开模板，否则要求请求头的供应商会在保存配置前失败。

校验上下文使用固定且非敏感的值：

```text
sessionId = openharness-credential-validation
userAgent = openharness-ts/1.0
```

固定值只用于短暂的凭证校验请求，不写入 settings。正式请求仍使用真实会话 ID。
凭证校验调用同一个 `expandRequestHeaderTemplates`，不得复制模板解析逻辑。

## Desktop 交互

### 自定义供应商

`CustomProviderDialog` 保持独立入口和完整表单。现有“请求头（可选）”区域继续使用，
说明文字调整为：

> 用于租户或网关路由信息。值可以使用 `{{sessionId}}` 和
> `{{userAgent}}`，发送请求时会替换为当前会话和客户端标识。

值输入框可使用 `value 或 {{sessionId}}` 作为占位提示。保存的是模板原文。
界面同时说明请求头会明文保存在 `settings.json`，不得填写 API Key、Bearer
Token 等秘密。

### 可连接目录供应商

现有“连接供应商”对话框增加默认收起的“高级选项”，只在
`provider.source === "catalog"` 时显示。高级选项包含：

- “请求头（可选）”说明；
- 动态添加、编辑和删除请求头行；
- 与自定义供应商一致的模板变量说明。

连接请求把请求头与 API Key 一起提交。内置供应商继续使用原有连接界面，不显示
也不提交请求头高级选项。

目录供应商不打开 `CustomProviderDialog`，不会暴露或允许修改目录控制的 ID、
Base URL 和模型列表。

第一版不内置 OpenCode Go 默认头，也不按供应商预填。用户需要在高级选项中配置：

```text
User-Agent          {{userAgent}}
x-opencode-session  {{sessionId}}
```

已经连接的目录供应商在供应商行提供“请求头”操作，打开同一个请求头编辑器，但
不显示和读取已经保存的 API Key。保存时只更新该目录条目的 `headers`，不更新
目录控制的 ID、Base URL、模型列表或凭证。这样现有用户不需要断开供应商或手工
编辑 `settings.json`。

## API 契约变化

以下层级中的目录连接输入同步增加可选 `headers`：

1. Desktop shared IPC 类型 `ConnectDesktopProviderInput`。
2. Desktop main `DesktopProviderService.connect`。
3. Client `connectCatalogProvider`。
4. HTTP `POST /providers/catalog/:id/connect` 请求体。
5. Server `ProviderService.connectCatalog`。

为已连接目录供应商新增仅更新请求头的契约：

```text
PATCH /providers/catalog/:id
body: { headers?: Record<string, string> }
```

该接口只允许更新已存在且带 `source: "models.dev"` 的条目。成功保存后关闭对应
runtime，使下一次请求使用新模板。当前控制层没有供应商到 runtime 的索引，因此
第一版沿用现有全局 mutation lease，并在保存成功后调用
`closeAllRuntimes()`。Client、Desktop main 和 IPC 增加相应方法；它不接收或
返回 API Key。若未来需要按供应商精准失效，应单独设计 session-to-provider
索引，不在 daemon 中增加供应商判断。

自定义供应商 API 契约不变，因为其输入已经包含 `headers`。

服务端是最终校验边界：无论调用来自 Desktop、CLI 还是直接 HTTP client，都必须
调用 `normalizeRequestHeaderTemplates`。UI 校验只用于即时反馈。

目录请求头 PATCH 要求请求体必须包含 `headers` 属性：`headers: {}` 表示清空；
省略该属性返回 400，避免把 no-op 与清空混为一谈。

## 合并与优先级

本阶段没有 provider profile，也没有内置供应商请求头，因此只有一个可配置来源：
当前 `customProviders` 条目的 `headers`。

OpenAI SDK 自身添加的协议头和认证头不属于模板配置。现有自定义头覆盖 SDK 默认头
的行为不在本次调整中改变，避免把模板功能与请求头权限策略捆绑为一次重构。

请求头名称按 HTTP 语义大小写不敏感。服务端保存时应拒绝忽略大小写后的重复名称，
避免同一请求出现两个语义相同但大小写不同的头。

## 错误处理

- 未知模板变量：保存、连接或运行时展开时拒绝，并指出具体请求头。
- 需要 `{{sessionId}}` 但 runtime 未提供会话 ID：造客户端失败，错误信息指出调用
  路径缺少 session 上下文。
- 请求头名称为空或值为空：沿用当前行为，不保存该行。
- 非法 HTTP 头名或包含 CR/LF 的值：保存前返回 400。
- 上游拒绝请求头：沿用现有供应商请求错误，不把模板展开后的全部头值写入日志。
- API Key 校验失败：不保存新配置和密钥；更新自定义供应商时保留原配置。
- 读取到历史配置中的未知模板、非法头名、CR/LF 或大小写重复头名：供应商仍能在
  设置界面中编辑，但造 client 时明确失败并指出配置项，不静默丢弃或发送。

## 迁移与兼容性

- `headers` 类型不变；现有合法且不包含 `{{...}}` 保留语法的静态请求头无需迁移。
- 历史配置若把 `{{unknown}}` 当作普通文本，或包含新规则判定为非法的 HTTP
  请求头，必须由用户在设置界面修正；这是为防止未展开模板和请求头注入而有意收紧
  的兼容性。
- 现有目录供应商条目没有 `headers` 时继续正常加载。
- `source: "models.dev"` 的含义不变。
- 不改变 `credentials.json` 格式。
- 用户级 `customProviders` 成为所有 runtime 的权威来源；项目设置中已有的
  `customProviders` 不再覆盖用户级供应商清单，其余项目设置不受影响。
- 当前未提交的 OpenCode Go 专用模块和测试属于临时实现。正式实现应删除
  `opencode-go.ts`、`isOpenCodeGoTarget`、`buildOpenCodeGoHeaders` 及相关特判测试，
  改为通用模板模块和行为测试。

## 测试策略

### 模板单元测试

- 静态头原样返回。
- 两个变量分别展开。
- 同一值中多个变量和重复变量全部展开。
- 输入对象不被修改。
- 未知变量被拒绝。
- 忽略大小写的重复头名被拒绝。
- 非法 HTTP 头名和 CR/LF 值被拒绝。

### Runtime 测试

- 自定义供应商的模板展开后进入 OpenAI SDK `defaultHeaders`。
- 带 `source: "models.dev"` 的目录供应商走同一路径。
- 两个不同 session ID 得到不同的请求头。
- 同一 client 的多次请求保持同一个展开值。
- 内置供应商不读取 `customProviders` 之外的请求头配置。
- 缺失 session ID 且模板需要它时明确失败。

### Provider Service 与 HTTP 测试

- 目录连接 API 接收、校验并保存请求头模板。
- 已连接目录供应商的请求头更新 API 不读取或覆盖 API Key。
- API Key 仍只写入 CredentialStorage。
- 目录重连省略 headers 时保留原值，显式空对象时清空。
- 目录断开删除快照和凭证。
- 自定义供应商创建、更新继续保存模板。
- 凭证校验请求使用固定校验 session ID 展开。
- 校验失败时不产生部分持久化。
- 仅有目录供应商孤立凭证时仍显示为可连接；重连后恢复正常。
- 无 API Key 的真正自定义供应商仍显示为 `configured` 并可运行。

### Desktop 测试

- 自定义供应商表单显示两个模板变量的说明并提交模板原文。
- 目录供应商连接框显示可折叠高级选项并提交请求头。
- 已连接目录供应商可以单独编辑请求头，不需要重新输入 API Key。
- 内置供应商连接框不显示请求头高级选项。
- 关闭或成功提交连接框后清空请求头表单状态，防止串到下一个供应商。
- 删除最后一行并保存会提交 `headers: {}`，从而清空已保存请求头。

## 验收标准

1. 用户可在自定义供应商请求头值中使用 `{{sessionId}}` 和
   `{{userAgent}}`。
2. 用户可在目录供应商连接框的高级选项中配置同样的模板。
3. 模板原文保存在 `settings.json` 的对应 `customProviders[].headers`。
4. API Key 只保存在 `credentials.json`。
5. 同一会话的正式请求发送相同的展开后 session ID，不同会话发送不同值。
6. daemon 中不存在供应商专用请求头判断。
7. OpenCode Go 不再依赖专用代码；配置上述两个模板后，凭证校验和正式请求都携带
   正确请求头。
8. 内置供应商的连接和运行行为保持不变。
9. 项目级 settings 不会覆盖用户级 `customProviders`，Desktop、daemon、CLI 和
   SDK 读取一致。
10. 目录供应商只有同时存在快照和 API Key 时才显示为已连接；真正的自定义供应商
    仍可无密钥运行。
