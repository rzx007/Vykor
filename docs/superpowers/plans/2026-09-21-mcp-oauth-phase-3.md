# MCP OAuth 第三阶段实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 完成第三阶段的刷新错误分类、资源绑定及 App Server 授权操作，保留已有 CLI、Desktop 和 Session 行为。

**架构：** 在现有 mcp/auth/server/client 分工内扩展；先完成协议可靠性，再补最小文件并发保护并接入授权操作接口。MCP 层不依赖文件实现，agent-runtime 不解析授权策略，OAuth 临时操作不写 Session 事件库。

**技术栈：** TypeScript、现有 MCP SDK 1.29.x、Vitest、Hono、typed HTTP/SSE client、Electron。

---

## 执行依据与范围

- 设计：[第三阶段设计](../specs/2026-09-21-mcp-oauth-phase-3-design.md)，2026-09-28 按用户要求暂缓 Keyring，并重新进行子代理范围审核。
- 本文件是实现顺序和测试安排；设计中的行为约束高于代码草图。
- 批次 A：任务 1–2；批次 B：任务 3–8；任务 9 为交付验收。任务 3 与任务 5 的退出计数生产者/消费者必须一起验收后交付。
- 当前任务 1–8 已实现并经审核修复，任务 9 的真实服务/安装产物验收待完成。下列步骤保留原始任务定义；实际执行证据及未验证项以 [验收记录](../reviews/2026-09-21-mcp-oauth-phase-3-acceptance.md) 为准。本轮按用户要求未创建 Git 提交。
- 执行开始时记录 HEAD 和 dirty paths。仓库可能同时有请求配置、思考过程或其他 Desktop 改动，只提交本任务文件/hunk，不改写其他人的提交。
- 使用独立工作区实施优先；不共享正在更新的 node_modules 或生成目录。先确认基线测试，针对失败记录具体原因，不把当前环境问题当作可永久跳过的清单。
- Windows 沙箱无法读取 pnpm 依赖时，请求运行权限后用本地 `node_modules/.bin/vitest.CMD`；不要重新安装依赖去规避文件访问限制。
- 每个任务依次完成失败测试、最小实现和通过测试；按依赖闭合、可验证的变更提交；不为绿灯放宽安全断言。

## 文件职责

| 位置 | 变化 |
|---|---|
| `packages/mcp/src/oauth/runtime-auth.ts`、`errors.ts`、`protocol.ts` | 结构化刷新失败、Token 使用版本、发现来源、资源选择 |
| 新建 `packages/mcp/src/oauth/resource-binding.ts` | 资源标识精确比较及 endpoint 包含关系，集中复用 |
| `packages/mcp/src/oauth/login.ts`、`callback.ts` | 配置快照、URL 通知、可取消授权与完整 callback |
| `packages/auth/src/mcp-oauth-credential-store.ts` | 继续作为唯一存储入口，锁、最小 v1/v2 兼容、epoch、原子删除 |
| `packages/core/src/types/mcp-oauth.ts`、`config/settings.ts` | resource/callback 配置、binding 和操作上下文类型 |
| 新建 `packages/server/src/application/mcp-oauth-operation-service.ts` | 进程内有界登录操作、幂等、取消与订阅 |
| `packages/server/src/application/mcp-oauth-application-service.ts` | 实际授权提交/退出用例，仍为协议与存储编排入口 |
| 新建 `packages/protocol/src/mcp-oauth.ts` | HTTP 操作输入/输出与安全事件 DTO、运行时校验 |
| `packages/server/src/http/routes/mcp.ts`、`routes/system.ts`、`server.ts` | 路由、能力声明、SSE，沿用已有中间件 |
| `packages/client/src/resources/mcp-resource.ts` | typed 操作资源，不在 CLI/Desktop 写裸 fetch |
| CLI MCP command、Desktop MCP main/IPC、主页插件页 MCP tab | 用户交互、授权 URL 与回调输入、状态和取消 |

新增实现文件各自配同名 `.test.ts`；React 测试使用现有 `.test.tsx` 位置。不增加通用存储插件框架、后台刷新队列或持久 OAuth 事件日志。

## 任务 1：刷新错误分类与条件诊断

**修改：** `packages/mcp/src/oauth/runtime-auth.ts`、`errors.ts`、`protocol.ts`、`login.ts`、`packages/auth/src/mcp-oauth-credential-store.ts`、`packages/core/src/types/mcp-oauth.ts`。

**测试：** `packages/mcp/src/oauth/runtime-auth.test.ts`、`login.test.ts`、`packages/auth/src/mcp-oauth-credential-store.test.ts`。

**交付物：** 临时失败保留凭据，旧失败不会损坏新登录，401 最多恢复一次。

- [ ] 在现有 `makeCredential()`、`memoryStore()` fixture 上增加 timeout/429/503/取消/invalid_grant 表驱动测试；fake fetch 返回真实 Response。网络与 5xx 后断言记录的 Token、revision 和 diagnostic 完全未变。注入 SDK `InvalidGrantError` 与只在 message 含相同文字的普通 Error，只有前者进入失效分支。
- [ ] 运行 `pnpm --filter @vykor/mcp exec vitest run src/oauth/runtime-auth.test.ts`，确认现有“一律 markReauthentication”造成预期失败。
- [ ] 给 `McpOAuthCredentialStore.runExclusive` 的 operation 增加上下文，并同步修改 file store、login 的内存 store 和测试替身：

```ts
interface CredentialMutationContext {
  nextRevision: number;
}
```

  store 保证实际写入 revision 等于 nextRevision；`next === current` 的不变结果不写文件、不递增。回调不得原地修改 current，要修改时必须返回新对象。内部刷新返回实际使用的 Token 与写入 revision 的快照；公共 getAccessToken 可仍返回字符串。失效写入先比较该快照，CAS 未命中直接保留 current。
- [ ] 在 HTTP 失败边界保留安全状态码和 SDK errorCode，按设计错误表转换为 `McpOAuthError`。调用取消原样结束；临时错误 `retryable=true`，不新增 retry loop。存储写失败不落入 invalid_grant 分支。
- [ ] 跑 `pnpm --filter @vykor/mcp exec vitest run src/oauth/runtime-auth.test.ts src/oauth/login.test.ts` 与 `pnpm --filter @vykor/auth exec vitest run src/mcp-oauth-credential-store.test.ts`。用两个真实文件 store 实例验证 CAS miss 文件内容不变；诊断不能复活被删除项。通过后提交 `fix(mcp): classify refresh failures without invalidating fresh credentials`，仅暂存本任务文件。

## 任务 2：resource 发现来源、配置和凭据绑定

**创建：** `packages/mcp/src/oauth/resource-binding.ts`、`resource-binding.test.ts`、`protocol.test.ts`。

**修改：** `packages/mcp/src/oauth/protocol.ts`、`login.ts`、`runtime-auth.ts`、`status.ts`、`packages/core/src/types/mcp-oauth.ts`、`packages/core/src/config/settings.ts`、`packages/agent-runtime/src/runtime-integrations.ts`。

**测试：** 上述 MCP 测试与 `packages/core/src/config/settings.test.ts`。

**交付物：** discovery、授权和刷新共享一个可追溯的资源标识。

- [ ] 新建独立 URL fixture，逐项断言 challenge 精确 endpoint、路径 well-known、根 fallback、显式 override、兄弟路径、不同 query、编码分隔符、fragment/userinfo 和不同 origin。以下是接口与断言形状；每个 fixture 写明实际来源，不由被测函数生成期望值：

```ts
type ResourceDiscoverySource = "challenge" | "endpoint-well-known" | "origin-well-known" | "explicit";
interface ResourceBindingInput {
  endpoint: string;
  expectedResource: string;
  metadataResource: string;
  source: ResourceDiscoverySource;
}
function validateResourceBinding(input: ResourceBindingInput): URL;
```

- [ ] 运行 `pnpm --filter @vykor/mcp exec vitest run src/oauth/resource-binding.test.ts src/oauth/protocol.test.ts`，确认当前 origin-only 校验不能拒绝同域不同资源。
- [ ] 为 `oauth.resourceUrl?: string` 和 `binding.resourceUrl?: string` 增加类型、settings 白名单及校验。由 discovery 代码在发请求前确定 expectedResource，返回值携带已验证 resourceUrl；禁止收到 metadata 后反向生成 expectedResource。SDK 不暴露最终发现来源时，在本模块显式执行已有候选 URL 顺序，不复制整个 SDK 授权流程。
- [ ] 将 authorization、code exchange 和 refresh 的 `resource` 参数都改为验证后的值；旧记录缺字段按原 serverUrl 解释。现有注入项 `getConfiguredScopes` 收敛为 `getConfiguredOAuth(name, config): Promise<McpOAuthSettings | undefined>`，由 Session 组装入口提供最新非秘密 OAuth 设置；统一更新全部调用者和测试，不同时保留两套读取逻辑。McpOAuthSettings 为 core 现有类型，本任务加 resourceUrl，任务 4 加 callbackUrl。策略仍留在 mcp。URL 或 audience 不匹配必须在发 Token 前报重新授权；为带 Token fetch 设置禁止跨 origin 跳转的处理。
- [ ] 跑 `pnpm --filter @vykor/mcp test`、`pnpm --filter @vykor/core exec vitest run src/config/settings.test.ts` 和 `pnpm --filter @vykor/agent-runtime exec vitest run src/runtime-integrations.test.ts`；记录捕获的三种 OAuth resource 参数一致性，通过后提交 `feat(mcp): validate discovered resource bindings`。

## 任务 3：最小文件格式与跨进程退出保护

**修改：** `packages/auth/src/mcp-oauth-credential-store.ts`、`packages/core/src/types/mcp-oauth.ts`、`packages/mcp/src/oauth/login.ts`。

**测试：** `packages/auth/src/mcp-oauth-credential-store.test.ts`、`packages/mcp/src/oauth/login.test.ts`。

**交付物：** 保留现有明文记录和单文件锁，只增加退出计数及原子删除。与任务 5 一起验收，不把始终返回 0 的占位实现当成保护。

- [ ] 用两个真实 store 实例测试 v1 只读不迁移、首次实际修改升级、其他服务记录保留、CAS miss 不写文件、不存在的目标退出仍递增 epoch、rename 失败保留原文件。先运行 auth store 测试，确认当前实现缺失这些行为。
- [ ] 仅采用以下格式，不新增 backend 包装、加密或存储选择：

```ts
interface McpOAuthStoreV2 {
  version: 2;
  logoutEpochs: Record<string, number>;
  servers: Record<string, McpOAuthCredentialRecord>;
}
```

  v1 缺省 epoch 为 0；未知版本或非法 epoch 拒绝，不按空文件处理。epoch 必须是非负安全整数，递增溢出时报错而非回绕。读取 v1 不修改文件，实际写入在原锁内原子替换为 v2。旧 reader 拒绝 v2；注明同配置目录的所有客户端必须一起更新。
- [ ] 新增 `readLogoutEpoch(name)` 和 `takeAndDelete(name)`。前者持锁读取；后者在同一锁内取出旧 Record、删除、递增 epoch 并落盘，返回旧 Record 供撤销。普通 `delete` 委托它；空删除也保留计数。任务 1 的 mutation context 此时增加真实 `logoutEpoch`，同步所有实现与测试替身，不提前发布占位上下文。
- [ ] 将 revoke 收敛为对传入旧 Record 的尽力撤销；删除后不重新读取共享 store。文件读写失败如实失败。沿用现有权限措施，本轮不加入 Windows ACL 工具或原生依赖。
- [ ] 跑 `pnpm --filter @vykor/auth exec vitest run src/mcp-oauth-credential-store.test.ts` 和 `pnpm --filter @vykor/mcp exec vitest run src/oauth/login.test.ts src/oauth/runtime-auth.test.ts`。保留跨进程 fixture 供任务 5 验证迟到提交被拒绝；与消费者一起提交可验证的退出保护。

## 任务 4：完整 callback URL 与抗无关请求干扰

**修改：** `packages/core/src/types/mcp-oauth.ts`、`packages/core/src/config/settings.ts`、`packages/mcp/src/oauth/callback.ts`、`login.ts`。

**测试：** `packages/mcp/src/oauth/callback.test.ts`、`login.test.ts`、`packages/core/src/config/settings.test.ts`。

**交付物：** 本地固定 callback 与 HTTPS 手动 callback 共用一次性验证。

- [ ] 用真实 loopback HTTP server 测试 favicon/错误路径/错误 state 后正确 callback 仍成功；有效 access_denied 立即结束；第二个正确 callback 被拒绝。测试 callbackUrl 与 callbackPort 冲突、非 loopback HTTP 拒绝、userinfo/query/fragment 拒绝。
- [ ] 跑 callback/settings 测试，确认当前 consume 提前设置 consumed 会导致正确回调不能恢复。
- [ ] 增加 `oauth.callbackUrl?: string`。将 URL/state/issuer 校验与消费 resultPromise 分开：无效输入只返回失败响应，通过校验后才一次性消费。HTTP loopback 在指定地址/端口/path listen；HTTPS 手动模式只建立内存等待器，不 listen、不对公网 URL 发请求。
- [ ] DCR、startAuthorization、exchangeAuthorization 都使用同一冻结 redirectUri。给 login deps 增加 `onAuthorizationUrl?(url: string): void | Promise<void>`，无论自动/手动模式都调用一次，再由原来的 openBrowser/readCallbackUrl 适配交互：

```ts
await deps.onAuthorizationUrl?.(authorizationUrl.toString());
// URL 通知不等于打开浏览器；daemon 只接收通知。
```

- [ ] 跑 `pnpm --filter @vykor/mcp exec vitest run src/oauth/callback.test.ts src/oauth/login.test.ts` 和 settings 测试。检查 abort/timeout 关闭监听器与 timer，通过后提交 `feat(mcp): support validated custom and manual callbacks`。

## 任务 5：应用服务的可取消提交与跨进程 logout

**修改：** `packages/server/src/application/mcp-oauth-application-service.ts`、`packages/mcp/src/oauth/login.ts`；维护现有 CLI 本地调用兼容。

**测试：** `packages/server/src/application/mcp-oauth-application-service.test.ts`、`packages/auth/src/mcp-oauth-credential-store.test.ts`。

**交付物：** 本地/daemon 登录共用明确提交点，迟到回调不复活凭据。

- [ ] 测试浏览器等待期间立即取消、等待文件锁时取消、进入提交后取消、等待 callback 时配置改变、另一个 store 实例 logout。使用 deferred promise 控制边界，不用固定 sleep。
- [ ] 跑应用服务测试，确认当前无 epoch 检查/无配置绑定复核造成失败。
- [ ] `McpOAuthLoginRequest` 增加可选 signal 和 onAuthorizationUrl。应用服务接入外部 abort；协议依赖接到统一信号。启动时捕获 logout epoch 和影响授权的配置，取得文件锁后先比较 context.logoutEpoch 与配置，再 patch scopes 和提交。配置比较只覆盖授权字段，其他设置变化不得取消授权。
- [ ] 定义应用层操作结果，让已经提交但同步失败能被上层识别：

```ts
interface McpOAuthCommitOutcome {
  credentialCommitted: true;
  runtimeSync: McpRuntimeSyncResult;
}
```

  `McpRuntimeSyncResult` 复用 core；保留 CLI 现有非零退出语义。logout 在队列外 abort，锁内 takeAndDelete 先落盘，再 revoke 返回的旧记录并同步。snapshot 读取失败不能抹掉 credentialCommitted 的事实。
- [ ] 跑应用服务、auth store、CLI MCP 测试，覆盖成功双登录仍最后提交生效、logout epoch 永不回退。通过后提交 `fix(server): fence OAuth commits against cancellation and logout`。

## 任务 6：有界授权操作与状态订阅

**创建：** `packages/server/src/application/mcp-oauth-operation-service.ts`、`mcp-oauth-operation-service.test.ts`。

**修改：** `packages/server/src/application/daemon-application.ts`、`packages/server/src/application/index.ts`。

**交付物：** daemon 持有临时授权状态，不持久化授权 URL、PKCE 或操作事件。

- [ ] 注入 fake clock 与受控 application login promise，测试 requestId 幂等、输入冲突、同名 busy、20 pending/100 total、终态十分钟保留、超时、取消、重启实例、订阅后/前完成均不漏终态。创建服务就生成一个随机 oauthInstanceId。
- [ ] 跑 `pnpm --filter @vykor/server exec vitest run src/application/mcp-oauth-operation-service.test.ts`，确认新服务尚不存在。
- [ ] 服务只保留一个 Map 和每操作的订阅集合。内部记录持有 AbortController、授权 URL 与手动输入 deferred；公开 snapshot 由单一安全 mapper 构造：

```ts
type OAuthOperationState = "pending" | "completed" | "failed" | "cancelled";
interface OAuthOperationView {
  loginId: string;
  name: string;
  state: OAuthOperationState;
  credentialCommitted: boolean;
  authorizationReady: boolean;
  errorCode?: string;
}
```

  completed 的历史提交事实与当前服务认证状态分开。instanceId 不匹配在任何 DCR/callback 副作用前拒绝。
- [ ] begin 调用先查幂等再限额；没有可清理的过期终态时拒绝新建。cancel 先 abort 再等收尾；进入不可回滚提交区的取消返回冲突。daemon.close 中停止接收新操作、abort 未提交项、等待已提交区收尾并释放 timer/listener。
- [ ] 测试 GET 不改变状态，终态订阅立即返回且关闭，HTTP 断开只释放订阅。通过后提交 `feat(server): manage bounded MCP OAuth login operations`。

## 任务 7：协议、HTTP/SSE 和 typed client

**创建：** `packages/protocol/src/mcp-oauth.ts`、`mcp-oauth.test.ts`。

**修改：** `packages/protocol/src/index.ts`、`capabilities.ts`、`capabilities.test.ts`、`packages/server/src/http/routes/mcp.ts`、`mcp.test.ts`、`routes/system.ts`、`http/server.ts`、`packages/client/src/resources/mcp-resource.ts`、`resources/__test__/mcp-resource.test.ts`、`packages/client/src/index.ts`、`types/index.ts`、`scripts/client-public-api-contract.json`、`tests/client-public-api/consumer.ts`。

**交付物：** 设计列出的七个 OAuth 接口可通过受认证的 client 调用。

- [ ] 先写协议输入校验测试：禁止任意 endpoint/redirect 覆盖；scopes 必须是字符串数组；requestId、instanceId、loginId 有长度上限；错误响应只含安全字段。路由测试覆盖401、非法 origin、409实例/输入冲突、429限额与SSE终态。
- [ ] 跑 protocol/mcp、server route/mcp、client resource/mcp 三组测试，确认新增接口缺失。
- [ ] 协议能力增加 `features.mcpOAuth = 1` 和 `mcpOAuth: { instanceId: string }`；parser 必须保留该字段，缺失仍兼容旧 server。DTO 显式列出允许字段，不直接 JSON.stringify 内部操作记录：

```ts
interface McpOAuthLoginInput {
  oauthInstanceId: string;
  requestId: string;
  scopes?: string[];
  callbackMode: "local" | "manual";
}
```

  authenticated GET 操作可返回 authorizationUrl；SSE DTO 不含它。所有 OAuth 响应 no-store，callbackUrl 只接受 POST body。
- [ ] 挂载路由时复用全局协议/Bearer/origin 中间件。client 资源增加 authStatus/startLogin/getLogin/watchLogin/submitCallback/cancelLogin/logout 方法，SSE 复用现有 transport，并支持 AbortSignal。保持原 runtimeStatus/synchronize 方法。pending 的 updated 事件只暴露 authorizationReady，客户端收到 true 后 GET 私有操作详情取 URL；completed 后调用 authStatus 读取最新服务状态。
- [ ] 跑 `pnpm --filter @vykor/protocol exec vitest run src/mcp-oauth.test.ts src/capabilities.test.ts`、`pnpm --filter @vykor/server exec vitest run src/http/routes/mcp.test.ts`、`pnpm --filter @vykor/client exec vitest run src/resources/__test__/mcp-resource.test.ts src/transport/__test__/protocol-handshake.test.ts` 与 `pnpm check:client-api`。通过后提交 `feat(client): expose MCP OAuth operations and completion events`。

## 任务 8：CLI 与 Desktop 用户流程

**修改：** `apps/cli/src/commands/mcp.ts`、`mcp.test.ts`、`apps/cli/src/mcp-runtime-coordinator.ts`、对应测试；`apps/desktop/src/main/features/mcp/mcp-service.ts`、`mcp-service.test.ts`、`ipc.ts`、`apps/desktop/src/shared/mcp-types.ts`、`ipc-channels.ts`、`desktop-api-contract.ts`、`apps/desktop/src/preload/desktop-api.ts`、对应测试、`apps/desktop/src/renderer/src/components/desktop/plugin-page/mcp-manager.tsx` 与 `mcp-manager.test.tsx`。

**界面入口：** 主页 → 插件 → MCP tab。复用 `plugin-page/plugin-page.tsx` 的现有挂载，不恢复旧设置页、不另建 MCP 管理入口；本任务不重构插件导航、MCP 编辑器或表单。

**参考：** `apps/desktop/src/main/features/session/daemon-connection-service.ts` 的接管与 dispose 行为，不改写整个连接服务。

**交付物：** 用户显式发起授权时在正确宿主打开浏览器，掉线不重复创建授权。

- [ ] CLI 测试同实例响应丢失恢复、instanceId 改变停止、手动打印 URL、粘贴 callback、完成但 Runtime 警告非零退出。Desktop 测试 renderer 从不收到 Token/Bearer/授权 URL，main 收到 pending URL 后只打开一次浏览器。
- [ ] 在当前 CLI/Desktop 运行定向测试，确认尚未使用 operation resource。
- [ ] CLI 仅在明确离线且尚未发出可能被受理请求时走本地 service；否则固定 instanceId/requestId/loginId 查询。手动模式通过 typed client 提交 callback。取消信号释放本地 readline/SSE，并尽力取消未提交操作。
- [ ] Desktop 只接入现有 daemon 主路径，开始前完成连接/接管；连接失败明确报错，不新增本地回退分支。main 管理 operation 与 URL 校验/openExternal；renderer 获取安全 operation 状态和取消按钮。窗口退出时释放 UI 订阅，内置 daemon 停止交给任务 6 cleanup。旧 daemon 能力不支持时显示升级提示。scope 请求错误仍只有手动重新授权提示，不自动重放 MCP 工具调用。
- [ ] 跑 `pnpm --filter @rzx/ohs exec vitest run src/commands/mcp.test.ts src/mcp-runtime-coordinator.test.ts`、Desktop MCP service/preload 的定向测试、`pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/plugin-page/mcp-manager.test.tsx` 及 `pnpm --filter @vykor/desktop typecheck`。通过后提交 `feat(desktop): use shared MCP OAuth login operations`。

## 任务 9：阶段验收与交接

**修改：** `packages/mcp/README.md`、`apps/cli/README.md`；创建 `docs/superpowers/reviews/2026-09-21-mcp-oauth-phase-3-acceptance.md` 记录真实结果。

**交付物：** 可复核的发布前验收记录，不以单测冒充真实 Linear 结果。

- [ ] 依次跑完整 `mcp`、`auth`、`agent-runtime` 测试；Server、Client、CLI、Desktop 跑本阶段全部变更文件及相关集成测试。已有无关失败记录实际触发条件，保持失败记录可见。
- [ ] 跑 `pnpm check-types`、`pnpm --filter @vykor/desktop typecheck`、`pnpm check:client-api`、`node scripts/architecture-boundaries.mjs`、`node scripts/check-docs.mjs`；不修改架构基线来容纳新的层间依赖。
- [ ] 真实 Linear 验收：本地 CLI、daemon CLI、Desktop 显式登录各一次；活跃 Session 重连和 logout；固定 loopback callback；手动 URL 模式；人为配置不同 resource 被拒绝。临时刷新错误与 invalid_grant 用本地受控 OAuth server 注入，不破坏真实账号 Token。
- [ ] 报告各交付提交 SHA 及覆盖任务、命令/退出码、未验证路径、最小文件格式兼容限制、已知风险；仅在证据齐全的批次标完成。提交文档 `docs(mcp): record phase three acceptance evidence`。不自动发布、部署或创建 PR。

## 规格覆盖与复查清单

| 设计约束 | 任务 |
|---|---|
| 刷新失败分类、版本快照、CAS 无副作用 | 1 |
| metadata 来源、resource 配置/传参/旧记录绑定 | 2 |
| 最小 v2、退出计数、原子删除 | 3、5（联合验收） |
| 完整 callback、错误 state、不相关请求、有效拒绝 | 4 |
| 取消先 abort、配置提交复核、跨进程退出不复活 | 5 |
| 操作容量/TTL、幂等、实例重启、内存订阅 | 6 |
| 受认证 API、SSE、客户端能力协商 | 7 |
| CLI 离线、手动模式、Desktop main 边界 | 8 |
| 原功能回归、真实 Linear、交接 | 9 |

## 明确不做

OS Keyring + file fallback 整体暂缓，不安装原生依赖，不创建加密/后端适配文件，不增加存储模式开关、专用展示字段或跨平台打包验收。保留现有独立文件不等于实现了 file fallback。

不新建通用操作框架、持久事件库、后台刷新服务、多账号体系或跨机器秘密同步。自定义 resource/callback 与 App Server 接口仍按已定范围实现；DCR 复用现有能力。需要扩大这些范围时单独提出，不提前留框架。
