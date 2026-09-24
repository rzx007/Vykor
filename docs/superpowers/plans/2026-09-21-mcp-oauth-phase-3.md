# MCP OAuth 第三阶段实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 完成第三阶段的刷新错误分类、资源绑定、安全凭据存储及 App Server 授权操作，保留已有 CLI、Desktop 和 Session 行为。

**架构：** 在现有 mcp/auth/server/client 分工内扩展；先完成协议可靠性，再升级存储，最后接入授权操作接口。MCP 层不依赖系统 Keyring，agent-runtime 不解析授权策略，OAuth 临时操作不写 Session 事件库。

**技术栈：** TypeScript、现有 MCP SDK 1.29.x、Node crypto、Vitest、Hono、typed HTTP/SSE client、Electron、可选原生依赖 `@napi-rs/keyring`。

---

## 执行依据与范围

- 设计：[第三阶段设计](../specs/2026-09-21-mcp-oauth-phase-3-design.md)，已经过两位子代理两轮审核修订。
- 本文件是实现顺序和测试安排；设计中的行为约束高于代码草图。
- 批次 A：任务 1–2；批次 B：任务 3–5；批次 C：任务 6–10；任务 11 为交付验收。
- 本轮只编写文档；下列复选框均未执行，不代表实现或测试已完成。
- 执行开始时记录 HEAD 和 dirty paths。仓库可能同时有请求配置、思考过程或其他 Desktop 改动，只提交本任务文件/hunk，不改写其他人的提交。
- 使用独立工作区实施优先；不共享正在更新的 node_modules 或生成目录。先确认基线测试，针对失败记录具体原因，不把当前环境问题当作可永久跳过的清单。
- Windows 沙箱无法读取 pnpm 依赖时，请求运行权限后用本地 `node_modules/.bin/vitest.CMD`；不要重新安装依赖去规避文件访问限制。
- 每个任务依次完成失败测试、最小实现、通过测试和独立提交；不为绿灯放宽安全断言。

## 文件职责

| 位置 | 变化 |
|---|---|
| `packages/mcp/src/oauth/runtime-auth.ts`、`errors.ts`、`protocol.ts` | 结构化刷新失败、Token 使用版本、发现来源、资源选择 |
| 新建 `packages/mcp/src/oauth/resource-binding.ts` | 资源标识精确比较及 endpoint 包含关系，集中复用 |
| `packages/mcp/src/oauth/login.ts`、`callback.ts` | 配置快照、URL 通知、可取消授权与完整 callback |
| `packages/auth/src/mcp-oauth-credential-store.ts` | 继续作为唯一存储入口，锁、v1/v2、epoch、删除 |
| 新建 `packages/auth/src/mcp-oauth-keyring.ts` | 原生后端适配和明确错误分类 |
| 新建 `packages/auth/src/mcp-oauth-envelope.ts` | AES-GCM 编解码、格式校验、权限保护 |
| `packages/core/src/types/mcp-oauth.ts`、`config/settings.ts` | resource/callback 配置、binding、存储状态和操作上下文类型 |
| 新建 `packages/server/src/application/mcp-oauth-operation-service.ts` | 进程内有界登录操作、幂等、取消与订阅 |
| `packages/server/src/application/mcp-oauth-application-service.ts` | 实际授权提交/退出用例，仍为协议与存储编排入口 |
| 新建 `packages/protocol/src/mcp-oauth.ts` | HTTP 操作输入/输出与安全事件 DTO、运行时校验 |
| `packages/server/src/http/routes/mcp.ts`、`routes/system.ts`、`server.ts` | 路由、能力声明、SSE，沿用已有中间件 |
| `packages/client/src/resources/mcp-resource.ts` | typed 操作资源，不在 CLI/Desktop 写裸 fetch |
| CLI MCP command、Desktop MCP main/IPC/settings | 用户交互、授权 URL 与回调输入、状态和取消 |
| CLI/Agent bundle、Electron packaging | 原生模块 external、安装产物与跨宿主验证 |

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
  logoutEpoch: number; // v1 固定为 0，任务 4 启用持久 epoch
}
```

  store 保证实际写入 revision 等于 nextRevision；`next === current` 的不变结果不写文件、不递增。内部刷新返回实际使用的 Token 与写入 revision 的快照；公共 getAccessToken 可仍返回字符串。失效写入先比较该快照，CAS 未命中直接保留 current。
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
- [ ] 将 authorization、code exchange 和 refresh 的 `resource` 参数都改为验证后的值；旧记录缺字段按原 serverUrl 解释。现有注入项 `getConfiguredScopes` 收敛为 `getConfiguredOAuth(name, config): Promise<McpOAuthSettings | undefined>`，由 Session 组装入口提供最新非秘密 OAuth 设置；统一更新全部调用者和测试，不同时保留两套读取逻辑。McpOAuthSettings 为 core 现有类型，本任务加 resourceUrl，任务 6 加 callbackUrl。策略仍留在 mcp。URL 或 audience 不匹配必须在发 Token 前报重新授权；为带 Token fetch 设置禁止跨 origin 跳转的处理。
- [ ] 跑 `pnpm --filter @vykor/mcp test`、`pnpm --filter @vykor/core exec vitest run src/config/settings.test.ts` 和 `pnpm --filter @vykor/agent-runtime exec vitest run src/runtime-integrations.test.ts`；记录捕获的三种 OAuth resource 参数一致性，通过后提交 `feat(mcp): validate discovered resource bindings`。

## 任务 3：Keyring 主密钥与加密 envelope

**创建：** `packages/auth/src/mcp-oauth-keyring.ts`、`mcp-oauth-keyring.test.ts`、`mcp-oauth-envelope.ts`、`mcp-oauth-envelope.test.ts`。

**修改：** `packages/auth/package.json`、`pnpm-lock.yaml`。

**交付物：** 与 OAuth 无关的窄秘密存储适配器及加密编码。

- [ ] 在新测试中定义内存 Keyring fake，只替代 OS 交互；加解密使用真实 Node crypto。测试 nonce 不重复、篡改密文/tag/AAD 拒绝、不同 name/configDir 不能互解，以及锁定与缺失必须返回不同结果。
- [ ] 执行 `pnpm --filter @vykor/auth exec vitest run src/mcp-oauth-keyring.test.ts src/mcp-oauth-envelope.test.ts`，确认新实现缺失的红灯。
- [ ] 定义且只实现两个平台方法，使用字节密钥而非 OAuth Record：

```ts
interface McpKeyring {
  read(account: string): Promise<Uint8Array | undefined>;
  write(account: string, key: Uint8Array): Promise<void>;
}
type KeyringFailure = "unavailable" | "locked" | "denied" | "invalid-key";
```

  错误转换只输出上述枚举。固定 service，account 由配置目录摘要计算。主密钥使用 Node `randomBytes(32)`，nonce 使用 `randomBytes(12)`，AES-256-GCM 验证 tag 后才解析 JSON。
- [ ] 将 `@napi-rs/keyring` 作为可选原生依赖接入，实施时固定经过验证的版本；首次候选为已查证的 2.1.0。Linux 显式选择 secret-service，缺失不能静默改用 keyutils。只有 load/调用该后端时才加载原生模块，file 模式启动不依赖它。
- [ ] 跑上述两组测试与 auth 类型检查。对原生 adapter 额外进行本机临时 account 的真实 set/get/delete 验证，临时 account 不使用生产服务记录；不把秘密打印到终端。通过后提交 `feat(auth): add keyring-backed MCP credential encryption`。

## 任务 4：v2 store、降级、logout epoch 与删除保障

**修改：** `packages/auth/src/mcp-oauth-credential-store.ts`、`mcp-oauth-envelope.ts`、`packages/core/src/types/mcp-oauth.ts`、`packages/mcp/src/oauth/login.ts`。

**测试：** `packages/auth/src/mcp-oauth-credential-store.test.ts`、`packages/mcp/src/oauth/login.test.ts`。

**交付物：** 同一个 store facade 支持新旧格式、加密与明确降级，退出不依赖解密。

- [ ] 用临时目录和两个真实 store 实例增加以下测试：v1 可读但 get 不迁移；写入变 v2；刷新保持后端；auto 锁定不降级；不同服务并发不丢项；文件 rename 失败保留原文；密钥丢失不被当成首次初始化；全部密文删除后明确 missing key 可重建。
- [ ] 在当前实现运行测试确认格式/epoch 行为缺失。v2 结构按设计定义，fixture 示例：

```ts
interface McpOAuthStoreV2 {
  version: 2;
  logoutEpochs: Record<string, number>;
  servers: Record<string,
    | { backend: "file"; record: McpOAuthCredentialRecord }
    | { backend: "keyring"; nonce: string; tag: string; ciphertext: string }
  >;
}
```

  `McpOAuthCredentialRecord` 使用 core 现有类型。不能将 entire store 作为一个密文，否则单项 logout 需要解密所有数据。
- [ ] 保留 file lock，新增 `readLogoutEpoch(name)` 和 `takeAndDelete(name)`；后者在锁内尽力解密旧目标、删除 raw entry、增加 epoch，返回旧凭据或安全的读取失败标记。即使不存在 entry 也增加 epoch。`runExclusive` 的上下文读取同一文件中的 logoutEpoch；delete 委托 takeAndDelete。
- [ ] 将协议撤销拆成“对传入旧 Record 尽力 revoke”与 store 删除编排；不能删除后重读 store。Keyring locked 的 takeAndDelete 必须可成功，文件结构损坏/写失败仍如实失败。实现 POSIX 权限与 Windows SID ACL，仅操作凭据文件/临时文件及新建凭据目录，不递归改配置树权限。
- [ ] 跑 auth 全套与 MCP login/runtime-auth 测试。增加跨进程测试：旧登录读取 epoch=0，另一进程 logout 后 epoch=1，旧登录提交在锁内被拒绝；CAS miss 保持原文件字节与 revision。通过后提交 `feat(auth): migrate MCP credentials with safe fallback and logout fencing`。

## 任务 5：存储状态展示与原生打包

**修改：** `packages/core/src/types/mcp-oauth.ts`、`packages/mcp/src/oauth/snapshot.ts`、`packages/server/src/application/mcp-oauth-application-service.ts`、`apps/cli/src/commands/mcp.ts`、`apps/desktop/src/shared/mcp-types.ts`、`apps/desktop/src/main/features/mcp/mcp-service.ts`、`apps/desktop/src/renderer/src/components/desktop/settings-page/mcp-settings.tsx`。

**打包：** `apps/cli/package.json`、`apps/cli/build.ts`、`packages/agent-runtime/package.json`、`packages/agent-runtime/scripts/build.mjs`、`apps/desktop/package.json`、`apps/desktop/electron-builder.yml`；创建 `scripts/verify-mcp-keyring-packaging.mjs`。

**测试：** 现有 snapshot、application-service、CLI MCP、Desktop MCP service/settings 测试及新脚本配套 `.test.mjs`。

- [ ] 先测试一个 Keyring 项 locked、另一个 file 项 valid 的 snapshot；列表必须仍返回两项，前者 authStatus=unavailable。CLI 输出安全的降级提示；UI 不把存储不可读显示成未登录。
- [ ] 定向执行上述测试确认新字段/状态缺失。只新增以下可见信息：

```ts
type CredentialStorage = "keyring" | "file";
// McpOAuthAuthStatus 增加 unavailable
// snapshot 可选字段：
credentialStorage?: CredentialStorage;
credentialError?: { code: "credential-storage-unavailable" };
```

- [ ] 应用服务逐项捕获已知 storage error，未知配置/协议错误不统一吞成未登录。保留旧 snapshot 字段。更新 Desktop 的状态标签和按钮条件，锁定时提供存储故障提示及退出动作，不自动打开授权浏览器。
- [ ] 把原生 package 加入三个安装产物的正确生产/可选依赖及 external/unpack 配置。验证脚本使用产物目录的 `createRequire` 实际解析原生模块；file 模式在缺少模块时也能执行状态命令。不要把工作区依赖可读当成安装包合格。
- [ ] 跑定向测试、`pnpm --filter @rzx/ohs build`、`pnpm --filter @vykor/agent-runtime test:pack`、`pnpm --filter @vykor/desktop build:unpack`。在 Windows/macOS/Linux 各自验收 Keyring 持久性；缺少平台结果时可交付代码，但批次 B 的跨平台发布验收保持未完成。通过可用平台检查后提交 `feat(mcp): expose credential storage status and package keyring runtime`。

## 任务 6：完整 callback URL 与抗无关请求干扰

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

## 任务 7：应用服务的可取消提交与跨进程 logout

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

## 任务 8：有界授权操作与状态订阅

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

## 任务 9：协议、HTTP/SSE 和 typed client

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

## 任务 10：CLI 与 Desktop 用户流程

**修改：** `apps/cli/src/commands/mcp.ts`、`mcp.test.ts`、`apps/cli/src/mcp-runtime-coordinator.ts`、对应测试；`apps/desktop/src/main/features/mcp/mcp-service.ts`、`mcp-service.test.ts`、`ipc.ts`、`apps/desktop/src/shared/mcp-types.ts`、`ipc-channels.ts`、`desktop-api-contract.ts`、`apps/desktop/src/preload/desktop-api.ts`、对应测试、`apps/desktop/src/renderer/src/components/desktop/settings-page/mcp-settings.tsx` 与测试。

**参考：** `apps/desktop/src/main/features/session/daemon-connection-service.ts` 的接管与 dispose 行为，不改写整个连接服务。

**交付物：** 用户显式发起授权时在正确宿主打开浏览器，掉线不重复创建授权。

- [ ] CLI 测试同实例响应丢失恢复、instanceId 改变停止、手动打印 URL、粘贴 callback、完成但 Runtime 警告非零退出。Desktop 测试 renderer 从不收到 Token/Bearer/授权 URL，main 收到 pending URL 后只打开一次浏览器。
- [ ] 在当前 CLI/Desktop 运行定向测试，确认尚未使用 operation resource。
- [ ] CLI 仅在明确离线且尚未发出可能被受理请求时走本地 service；否则固定 instanceId/requestId/loginId 查询。手动模式通过 typed client 提交 callback。取消信号释放本地 readline/SSE，并尽力取消未提交操作。
- [ ] Desktop 在开始前完成连接/接管，main 管理 operation 与 URL 校验/openExternal；renderer 获取安全 operation 状态和取消按钮。窗口退出时释放 UI 订阅，内置 daemon 停止交给任务 8 cleanup。旧 daemon 能力不支持时显示升级提示。scope 请求错误仍只有手动重新授权提示，不自动重放 MCP 工具调用。
- [ ] 跑 `pnpm --filter @rzx/ohs exec vitest run src/commands/mcp.test.ts src/mcp-runtime-coordinator.test.ts`、Desktop MCP service/settings/preload 的定向测试及 `pnpm --filter @vykor/desktop typecheck`。通过后提交 `feat(desktop): use shared MCP OAuth login operations`。

## 任务 11：阶段验收与交接

**修改：** `packages/mcp/README.md`、`apps/cli/README.md`；创建 `docs/superpowers/reviews/2026-09-21-mcp-oauth-phase-3-acceptance.md` 记录真实结果。

**交付物：** 可复核的发布前验收记录，不以单测冒充真实 Keyring/Linear 结果。

- [ ] 依次跑完整 `mcp`、`auth`、`agent-runtime` 测试；Server、Client、CLI、Desktop 跑本阶段全部变更文件及相关集成测试。已有无关失败记录实际触发条件，保持失败记录可见。
- [ ] 跑 `pnpm check-types`、`pnpm --filter @vykor/desktop typecheck`、`pnpm check:client-api`、`node scripts/architecture-boundaries.mjs`、`node scripts/check-docs.mjs`；不修改架构基线来容纳新的层间依赖。
- [ ] 在实际安装产物进行 OS Keyring 验收：本机及支持平台重启后仍能读；同用户 CLI/Desktop/daemon 互读；无 Keyring 显示 file；锁定已有 Keyring 不降级；logout 无法解密时仍删除目标记录。只使用测试记录。
- [ ] 真实 Linear 验收：本地 CLI、daemon CLI、Desktop 显式登录各一次；活跃 Session 重连和 logout；固定 loopback callback；手动 URL 模式；人为配置不同 resource 被拒绝。临时刷新错误与 invalid_grant 用本地受控 OAuth server 注入，不破坏真实账号 Token。
- [ ] 报告各任务提交 SHA、命令/退出码、未验证平台、存储格式兼容限制、已知风险；仅在证据齐全的批次标完成。提交文档 `docs(mcp): record phase three acceptance evidence`。不自动发布、部署或创建 PR。

## 规格覆盖与复查清单

| 设计约束 | 任务 |
|---|---|
| 刷新失败分类、版本快照、CAS 无副作用 | 1 |
| metadata 来源、resource 配置/传参/旧记录绑定 | 2 |
| Keyring 主密钥、真实加密、平台后端 | 3 |
| v1/v2、锁、fallback、权限、logout epoch | 4 |
| unavailable 状态、降级提示、安装产物 | 5 |
| 完整 callback、错误 state、不相关请求、有效拒绝 | 6 |
| 取消先 abort、配置提交复核、跨进程退出不复活 | 7 |
| 操作容量/TTL、幂等、实例重启、内存订阅 | 8 |
| 受认证 API、SSE、客户端能力协商 | 9 |
| CLI 离线、手动模式、Desktop main 边界 | 10 |
| 原功能回归、真实平台/Linear、发布交接 | 11 |

实施期间如需新增 Keyring 产品、服务端授权模式或跨机器秘密同步，应单独提出范围变更；本计划不为这些能力预留框架。
