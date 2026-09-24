# 公共 API 收口 Stage 7 设计

> 状态：设计已确认，待编写实施计划。
>
> Stage 7 迁移仓库内部调用方、固定长期公共契约并建立弃用周期；不删除兼容入口。兼容层的物理删除属于 Stage 8。

## 1. 背景

阶段 0–6 已完成存储、业务 Repository、Session/Conversation/Run、Server Application/Runtime、Client Transport/Resource，以及 Desktop/Frontend 状态边界重组。现在主要剩余问题不再是业务逻辑放错位置，而是旧公共入口仍然掩盖新边界：

- `VykorClient` 已拥有 `sessions`、`projects`、`jobs`、`attachments` 等 Resource，但仍保留一百多个平铺转发方法；
- 仓库内部生产代码还有 `clientLegacyFlatCalls: 79`，调用方仍容易绕过命名 Resource；
- `@vykor/client` 根入口同时导出 transport、resources、state、commands、protocol 类型和兼容门面，长期承诺范围不清楚；
- 外部使用者无法从类型和文档判断哪些入口会长期保留，哪些只是迁移桥梁；
- 如果直接删除平铺方法，Desktop、Frontend、CLI 和潜在外部使用者会在同一个版本中承受过大的破坏面。

Stage 7 因此只完成“迁移和告知”：仓库内部停止依赖旧入口，类型系统明确弃用入口，文档给出一对一迁移表，架构检查阻止旧调用回流。Stage 8 才在明确 breaking version 中删除这些入口。

## 2. 目标

1. 把 Client 导出分为长期公共契约、受控高级契约和兼容入口。
2. 将仓库内部生产调用全部迁移到命名 Resource 或更窄 capability。
3. 让新业务模块不再接收完整 `VykorClient`，只接收实际需要的 Resource 组合。
4. 为平铺兼容方法增加准确的 `@deprecated` 迁移目标，不改变运行行为。
5. 建立可自动比较的公共导出快照和旧调用基线。
6. 保持 HTTP、SSE、IPC、CLI、UI、错误类型和返回结构兼容。
7. 提供 Stage 8 可执行的删除清单，但本阶段不执行删除。

## 3. 不处理

- 不删除 `VykorClient` 平铺方法。
- 不删除根入口现有导出。
- 不改变包名、HTTP/SSE/IPC schema、请求路径或认证方式。
- 不改变 `VykorApiError`、`IncompatibleProtocolError` 及 Resource decoder 的现有错误语义。
- 不增加产品功能、视觉改版或新的状态库。
- 不拆分 npm 包，也不引入 API Extractor、Changesets 等新依赖。
- 不为尚不存在的第三方使用场景增加抽象。

## 4. 公共契约分类

### 4.1 长期公共契约

以下入口是普通调用方应使用的稳定表面：

- `VykorClient` 构造器；
- Client 的命名 Resource 属性：`protocol`、`system`、`providers`、`auth`、`projects`、`plugins`、`development`、`sessions`、`attachments`、`permissions`、`schedules`、`jobs`、`terminals`、`channels`、`events`；
- Resource 方法使用的输入、输出和稳定 record 类型；
- `VykorApiError`、`IncompatibleProtocolError`；
- 协议兼容检查：`CURRENT_PROTOCOL_VERSION`、`checkProtocolCompatibility`、`supportsFeature`。

构造器继续作为 transport、protocol 和 resources 的组合根。普通调用方不需要自行创建 transport 或 resource。

### 4.2 受控高级契约

以下入口继续从根包导出，但文档明确为高级能力；它们适合自定义适配器、TUI/CLI 状态同步或测试工具，不是普通 CRUD 的首选：

- `HttpTransport`、`SseTransport`、`ProtocolClient`；
- 各个 Resource class；
- `createPromptRequestId`、`normalizeDaemonBaseUrl`、`streamServerSentEvents`；
- `applyEvent`、`applySessionSnapshot`、`SessionSyncController`、`syncEvents` 和 selectors；
- commands parser/dispatcher。

`VykorClient.transport`、`sse`、`baseUrl`、`token`、`fetchImpl` 暂列为“保留但待 Stage 8 评估”的高级表面：Stage 7 不删除、不新增使用，也不把它们写成普通业务调用的推荐入口。`health` 和 `capabilities` 是兼容方法，长期目标分别是 `client.protocol.health()` 和 `client.protocol.capabilities()`。

Stage 7 建立穷尽式契约清单，逐项记录根入口每个 runtime export、每个 type-only export，以及 `VykorClient` 每个 public property、getter 和 method，并标明分类、替代入口、Stage 7 行为和 Stage 8 决策。大量协议 record type 继续作为长期类型契约，但以该清单为准，不在正文重复数百个名称。`ProtocolDataError` 当前不是根入口导出，Stage 7 不新增对它的根包导出承诺。

Stage 7 不建立新的 subpath export。原因是当前包只发布源码入口，贸然增加 `@vykor/client/state` 等子路径会形成新的长期兼容承诺。Stage 8 删除兼容层后再根据真实外部使用情况决定是否增加子路径。

### 4.3 兼容入口

`VykorClient` 上所有与 Resource 或 ProtocolClient 一对一转发的平铺方法属于兼容入口，例如：

```ts
client.getSession(id)        // 兼容入口
client.sessions.get(id)      // 长期入口

client.listJobs(options)     // 兼容入口
client.jobs.list(options)    // 长期入口
```

这些方法在 Stage 7：

- 保持签名、返回值、错误和运行行为；
- 增加 `@deprecated Use client.<resource>.<method>() instead.`；
- 保留转发一致性测试；
- 不允许仓库内部生产代码继续调用；
- 在迁移指南中提供一对一映射。

## 5. 调用迁移规则

### 5.1 Resource 优先

生产代码从：

```ts
await client.getSession(sessionId)
await client.replyPermission(requestId, input)
```

迁移到：

```ts
await client.sessions.get(sessionId)
await client.permissions.reply(requestId, input)
```

迁移只改变调用路径，不改变参数、返回值、catch、retry 或状态更新顺序。

### 5.2 窄 capability

如果函数只使用一个或少量 Resource，不再接受完整 `VykorClient`：

```ts
type SessionReadClient = Pick<VykorClient, "sessions">
```

更优先直接描述结构能力：

```ts
interface SessionReadResources {
  sessions: Pick<SessionResource, "get" | "getState">
}
```

只在多个现有调用方真实共享同一能力组合时提取命名类型。单一调用方使用局部结构类型，避免建立新的万能 Client 接口。

### 5.3 保留完整 Client 的位置

以下位置允许持有完整 Client：

- Client factory/connection owner；
- Desktop daemon connection service；
- Frontend connection lifecycle；
- 明确的组合门面，它负责把同一 Client 分发给多个 feature；
- 兼容转发测试。

业务 operation、feature service、command handler 和状态 selector 不应仅为方便而接收完整 Client。

## 6. 迁移顺序

### 6.1 7A：契约清单与自动化护栏

- 从 `VykorClient` 实际属性和方法生成/维护人工可审查的契约清单；
- 建立根入口 runtime export 快照和代表性 type consumer fixture；
- 将旧调用统计从正则表达式升级为基于仓库现有 `typescript` 包的 AST（语法树）扫描，同时覆盖调用、属性取值/传递、解构和 `VykorClient["method"]` 类型索引引用，并按文件、方法和生产/测试分类；
- 建立经过人工核对的兼容方法名清单，扫描 `client/api/this.client`、`(await client())`、可识别别名与解构引用；
- 用架构测试 fixture 证明直接调用、别名、await factory、成员字段和解构形态都能被识别；
- 将 `clientLegacyFlatCalls: 79` 只记录为旧正则脚本的历史基线，不把它当作真实迁移分母；7A 输出新的 AST 基线后，后续阶段只使用新指标；
- 规则允许兼容门面自身和专门的兼容测试，禁止新增生产调用。

不新增依赖：AST 扫描直接使用仓库已有的 `typescript`。runtime export 使用动态 import 后排序比较；type-only export 使用 TypeChecker 的 `getExportsOfModule` 枚举并按 SymbolFlags 分类后与穷尽契约清单比较，另用只编译、不执行的代表性 consumer fixture 验证关键导入和签名。fixture 使用独立 `tests/client-public-api/tsconfig.json`，通过 workspace package resolution 指向 `@vykor/client`。扫描器测试、契约比较和 consumer 编译统一接入根 `check:architecture`，避免成为可漏跑的旁路命令。

### 6.2 7B：Client commands 与 state

- commands 使用所需 Resource capability；
- state/sync/controller 只依赖 `sessions.getState`、`events.list/stream`；
- 不让 Resource 反向依赖 `VykorClient`；
- 保持 reducer、cursor、abort、reconnect 行为不变。

这一波应使 Client 包内部除 facade 和兼容测试外不再调用平铺方法。

### 6.3 7C：CLI

- `print-session` 改用 `sessions`、`events`、`permissions` 等 Resource；
- channel commands 改用 `protocol`、`channels`；
- plugin commands 改用 `plugins`，覆盖当前 `(await client()).listPlugins/installLocalPlugin/...` 等旧统计器漏报调用；
- daemon lifecycle 可以构造完整 Client，但业务命令只接收窄能力；
- CLI 输出、退出码、JSON 和错误消息保持不变。

### 6.4 7D：Desktop main

按 feature 迁移，不跨 feature 建立新的通用 facade：

- settings/provider 使用 `system`、`providers`、`auth`；
- attachment 使用 `attachments` 与 `protocol.capabilities`；
- plugin/skill 使用 `plugins` 与对应 system/development resource；
- schedule 使用 `schedules`；
- terminal 使用 `terminals`；
- session operations 使用 `sessions`、`projects`、`permissions`、`jobs` 等命名 Resource。

`DaemonConnectionService` 仍返回完整 Client，因为它是连接所有者。`withDaemonRetry` 也继续把完整 Client 交给 callback，以便统一刷新连接；callback 的第一步取得需要的 Resource/Protocol capability，再传给业务函数。各 feature 业务函数不接收完整 Client，不为每个 feature 复制一套 retry helper。

### 6.5 7E：Frontend

- connection lifecycle 继续创建完整 Client；
- `useServerSync` 初始化调用迁到 `protocol.health`、`system`、`sessions`；
- model 与 Job 调用分别迁到 `providers`、`jobs`；
- action 子模块按 feature 接收 Resource capability；
- Jobs、MCP、permission、session actions 不使用平铺方法；
- `SessionSyncController` 继续接收既有 `SyncEventsClient` 窄接口。

不再次重构 React 状态，不改变 Hook 返回值，也不把 React 类型带入 Client 包。

### 6.6 7F：弃用标记与迁移指南

- 所有平铺方法增加准确 JSDoc `@deprecated`；
- `packages/client/README.md` 以 Resource API 为主示例；
- 新增完整迁移表：旧方法、替代 Resource 方法、是否存在参数差异；
- 更新架构迁移状态、真实调用指标和验证结果；
- 生成 Stage 8 删除清单，列出仍需保留的纯兼容测试和可能的外部 breaking surface。

### 6.7 已知生产调用文件矩阵

7A 的 AST 清单是最终事实来源，但实施计划不得遗漏当前已经确认的文件：

| 消费层 | 当前文件 | 目标能力 |
|---|---|---|
| Client | `packages/client/src/commands/session-commands.ts` | `protocol`、`system`、`sessions` 等窄能力 |
| Client | `packages/client/src/state/sync.ts`、`session-sync-controller.ts` | 已有 `sessions.getState`、`events.list/stream` 窄接口，验证而非重写 |
| CLI | `apps/cli/src/print-session.ts` | `sessions`、`events`、`permissions` |
| CLI | `apps/cli/src/commands/channels.ts` | `protocol`、`channels` |
| CLI | `apps/cli/src/commands/plugin.ts` | `plugins`；包括 await factory 和 `api` 别名调用 |
| Desktop | `features/settings/settings-service.ts` | `protocol`、`system` |
| Desktop | `features/attachment/attachment-service.ts`、`attachment/ipc.ts` | `attachments`、`protocol` |
| Desktop | `features/provider/provider-service.ts` | `providers`、`auth`、`system` |
| Desktop | `features/plugin/plugin-service.ts` | `plugins` |
| Desktop | `features/skill/skill-service.ts` | `development` |
| Desktop | `features/schedule/schedule-service.ts` | `schedules` |
| Desktop | `features/terminal/terminal-service.ts` | `terminals` |
| Desktop | `features/session/session-service.ts`、`session-operations.ts`、`session-subscription-service.ts` | `protocol`、`system`、`sessions`、`projects`、`permissions`、`events`、`jobs` |
| Frontend | `apps/frontend/src/hooks/useServerSync.ts` | `protocol`、`system`、`sessions`、`providers`、`jobs` |
| Frontend | `sync-submodules/actions.ts`、`sessionSlashCommands.ts` | 按 action 使用 `sessions`、`projects`、`permissions`、`plugins`、`development`、`jobs` 等能力 |

连接 owner 仍可构造和保存完整 Client，但表中业务调用必须使用命名属性。7A 如果发现矩阵外生产文件，先补进清单和对应波次，再实施迁移。

## 7. 弃用与版本策略

Stage 7 不承诺具体发布日期，但固定以下退场条件：

1. 必须有两个可验证发行证据：首次携带 deprecated API 的发行，以及至少一个后续仍保留该 API 的发行；
2. 仓库内部生产代码旧调用为 0；
3. README、示例和命令代码均使用 Resource API；
4. 兼容方法拥有一对一迁移目标；
5. Stage 8 只能在明确 breaking version 中删除；
6. 删除前再次搜索仓库、发布文档和已知外部适配器。

Stage 7 的契约清单是唯一事实源，每个兼容符号记录 `deprecatedSince`、`deprecatedCarrierRelease` 和 `retentionCarrierRelease`。两份 release 字段都包含 version、date、channel 与 release-note URL 或提交 hash；未知值必须为 `null`/`pending`。若 `@vykor/client` 没有独立发布物，项目必须预先固定一个实际 carrier（默认使用发布 Client 的 CLI；只有发行流程明确由 Desktop 承载时才改为 Desktop），全部符号使用同一关联规则，不能逐项任意选择。Stage 8 仅在首次弃用发行与至少一个后续保留发行两份证据齐全后才能删除；任一字段 pending 就继续保留。

如果项目在 Stage 8 前仍按 `0.x` 发布，也必须在 release notes 明确标注 breaking change，不能以 `0.x` 为由静默删除。

## 8. API 快照与架构检查

### 8.1 Runtime export 快照

测试动态导入 `@vykor/client` 根入口，比较排序后的关键 runtime export 名称。快照关注“意外删除或新增承诺”，不记录函数源码、属性顺序或构建器内部字段。

### 8.2 代表性 Type consumer fixture

建立独立 TypeScript fixture，验证：

- 能从根入口构造 `VykorClient`；
- 能访问每个长期 Resource；
- 关键 Resource 输入/输出类型可导入；
- 高级 state/sync 能力仍可导入；
- deprecated 平铺方法在 Stage 7 仍能编译。

该 fixture 证明列出的代表性契约可消费。完整 type-only export 由 TypeChecker 枚举并与契约清单自动比较，清单 diff 再由人工审查分类。fixture 的独立 tsconfig、扫描器测试和契约比较必须由根 `check:architecture` 串联，不能只依赖源码包内部的相对路径解析或要求执行者记住额外命令。

### 8.3 旧调用治理

基于 TypeScript AST 的架构脚本输出：

- 生产旧调用总数；
- 生产旧成员引用总数（属性取值/传递、解构及类型索引访问）；
- 测试兼容调用总数；
- 按文件和方法的详细位置；
- 允许列表仅包含 `http-client.ts` facade 实现和专门兼容测试。

完成 Stage 7 时，生产旧调用和旧成员引用都必须为 0。兼容测试引用不计入生产基线，但必须保留到 Stage 8。对已经确认来源为 `VykorClient`、却无法解析具体成员的 production diagnostic，门禁直接失败；动态字符串成员另列人工审计结果，不允许静默跳过。

## 9. 错误与行为兼容

迁移前后必须保持：

- 相同 URL、method、query、body 和 header；
- 相同 decoder 和返回结构；
- 相同 AbortSignal 传递；
- 相同 retry 所有者，不能同时由 transport 和平台重连；
- 相同 `VykorApiError` status/body/message；
- 相同 CLI 输出、Desktop IPC payload、Frontend Hook 返回值；
- upload/download/SSE 继续保持流式，不为了统一类型改成缓冲读取。

迁移过程中如果发现平铺方法和 Resource 行为不一致，以 Stage 5 已确认的 Resource 为规则所有者；先补转发一致性测试，再修兼容门面，不能在调用方保留两套分支。

## 10. 测试节奏

继续遵循用户确认的批量节奏：

1. 7A 只运行建立可靠门禁所需的 scanner/contract 自测；
2. 7B–7E 连续完成生产迁移，只用 AST 明细核对范围，不运行包级 typecheck/test/architecture；中途提交注明尚未统一验证；
3. 7F 在全部调用方迁完后统一运行类型检查、各包完整测试和所有根门禁；
4. 集中修复完整测试发现的真实失败；
5. 最后统一子代理代码审查并修复全部 Critical/Important。

最终验证至少包括：

- Client 全量与公共 API consumer fixture；
- CLI 全量；
- Desktop 全量；
- Frontend 全量；
- Server HTTP 兼容测试；
- 全仓 TypeScript；
- architecture、docs、diff；
- facade 与 Resource 的 path/body/error/stream 一致性。

## 11. 提交边界

建议提交顺序：

1. `test(client): lock public api contract`
2. `refactor(client): migrate internal resource consumers`
3. `refactor(cli): use client resources`
4. `refactor(desktop): use client resources`
5. `refactor(frontend): use client resources`
6. `docs(client): deprecate flat client facade`
7. `chore: complete public api convergence stage`

每个提交只覆盖一个消费层。迁移调用路径与删除 API 不得出现在同一个提交。某波审计后没有实际 diff 时不制造空提交，只在迁移状态记录结果。

## 12. 风险与控制

### 12.1 类型收窄过度

大量一次性 interface 会让代码更难读。控制方式是优先使用现有 Resource class 或局部结构类型，只有两个以上真实调用方共享时才命名 capability。

### 12.2 deprecated 注释与真实映射不一致

迁移表由实际 facade 转发目标逐项核对；兼容测试验证调用同一 Resource。禁止批量生成未经核对的注释。

### 12.3 测试把兼容入口当长期入口

业务测试迁到 Resource；只有 `http-client` 兼容转发测试可以直接调用 deprecated 方法。架构统计分别报告生产和兼容测试，避免用测试调用掩盖生产回流。

### 12.4 Stage 7 偷跑 Stage 8

任何删除公开方法、根导出或类型 alias 的变更都拒绝进入 Stage 7。发现无调用方法也只记录到删除清单。

## 13. 完成条件

- 新 AST 指标中的仓库内部生产旧调用和旧成员引用均为 0；旧正则指标 79 只保留为历史参考；
- facade 和专门兼容测试之外没有平铺 Client 调用、属性取值/传递、解构或类型索引依赖；
- 所有平铺方法都有准确 `@deprecated` 替代路径；
- 长期、高级和兼容 API 分类写入 Client README；
- runtime/type-only export 契约比较和 type consumer fixture 能阻止意外破坏；
- Client、CLI、Desktop、Frontend 不改变可观察行为；
- Client、Server、CLI、Desktop、Frontend、类型、架构和文档验证通过；
- Stage 8 删除清单完整，但没有提前删除任何兼容入口；
- `docs/architecture-migration-status.md` 标记阶段 0–7 完成、阶段 8 未开始。

## 14. Stage 8 交接

Stage 8 基于本阶段清单执行明确 breaking change：

- 删除 deprecated 平铺方法；
- 删除只服务旧入口的类型 alias、re-export 和兼容测试；
- 评估是否增加稳定 subpath exports；
- 将旧调用基线替换为“禁止出现”规则；
- 更新版本与迁移说明。

Stage 8 不应重新迁移业务调用方。若届时仓库内部仍存在旧调用，说明 Stage 7 未完成，不能开始删除。
