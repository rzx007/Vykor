# MCP OAuth CLI 闭环实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 Streamable HTTP MCP Server 实现安全、可持久化、主要命令兼容 Codex 的 CLI OAuth 登录、刷新、状态查询和退出闭环。

**架构：** `packages/mcp` 负责 OAuth 协议、安全校验和 authenticated transport，`packages/auth` 通过跨进程锁实现独立凭据文件，`packages/core` 只承载配置及持久化 DTO，CLI 负责编排浏览器/粘贴 callback 交互。交互登录使用 SDK 1.29.0 的 discovery、DCR、PKCE 和 token helper，但在保存前自行补齐 issuer、scope 和 endpoint 安全校验；运行期通过受控 fetch 包装器刷新并只重试一次，不让 SDK 自动扩权或打开浏览器。

**技术栈：** TypeScript、Node.js 20、Commander、Vitest、`@modelcontextprotocol/sdk` 1.29.0、Streamable HTTP、OAuth 2.1、PKCE、RFC 8414/9207/9728。

**已批准规格：** `docs/superpowers/specs/2026-09-18-mcp-oauth-cli-design.md`。实现与计划冲突时，以该规格的安全边界和验收条件为准。

---

## 文件结构

### 新建

- `packages/core/src/types/mcp-oauth.ts`：纯配置/凭据/状态 DTO，不引用 MCP SDK。
- `packages/auth/src/mcp-oauth-credential-store.ts`：版本化 JSON、exclusive lock、原子写入和权限控制。
- `packages/auth/src/mcp-oauth-credential-store.test.ts`：存储损坏、并发写、锁回收和脱敏回归。
- `packages/mcp/src/oauth/errors.ts`：稳定错误码和不携带 secret 的错误类型。
- `packages/mcp/src/oauth/security.ts`：HTTPS/loopback、issuer、callback 和 scope 子集校验。
- `packages/mcp/src/oauth/security.test.ts`：安全边界单元测试。
- `packages/mcp/src/oauth/callback.ts`：loopback callback listener 与粘贴 URL 竞速、一次性 state 消费。
- `packages/mcp/src/oauth/callback.test.ts`：callback、超时、取消、state/iss 测试。
- `packages/mcp/src/oauth/login.ts`：discovery、DCR、PKCE、exchange、临时连接验证和撤销编排。
- `packages/mcp/src/oauth/login.test.ts`：登录服务的协议级测试。
- `packages/mcp/src/oauth/runtime-auth.ts`：连接前刷新、跨进程去重、401 单次恢复和 403 拒绝扩权。
- `packages/mcp/src/oauth/runtime-auth.test.ts`：刷新、并发、scope 和单次重试测试。
- `packages/mcp/src/oauth/status.ts`：纯本地授权状态计算。
- `packages/mcp/src/oauth/status.test.ts`：状态矩阵测试。
- `apps/cli/src/commands/mcp.test.ts`：Codex 兼容命令解析、输出与退出码测试。
- `packages/mcp/src/oauth/test-server.test.ts`：真实 SDK transport 对接本地 OAuth/MCP server 的集成测试。

### 修改

- `packages/core/src/types/settings.ts`：远程 MCP 的非敏感 OAuth 配置。
- `packages/core/src/config/paths.ts`：`mcp-oauth.json` 路径。
- `packages/core/src/config/settings.ts`：校验 MCP OAuth 配置字段。
- `packages/core/src/index.ts`：导出新 DTO 和路径函数。
- `packages/auth/src/index.ts`：导出 `McpOAuthCredentialStore`。
- `packages/mcp/src/index.ts`：注入 credential store/runtime auth，构造 authenticated HTTP transport，暴露连接验证入口。
- `packages/mcp/package.json`：保持 SDK 依赖，补充测试所需依赖时只放 devDependencies。
- `packages/agent-runtime/src/runtime-integrations.ts`：创建 store/runtime auth 并注入每个 session 的 manager。
- `packages/agent-runtime/src/runtime-integrations.test.ts`：验证 OAuth 依赖注入和失败隔离。
- `apps/cli/src/commands/mcp.ts`：实现 `add/get/list/login/logout/remove`。
- `apps/cli/package.json`：加入 `open` runtime dependency，用函数式 API 跨平台打开授权 URL。
- `README.md`、`docs/mcp-http-transport-design.md`：更新状态、命令和安全限制。

## 任务 1：建立核心配置、凭据 DTO 和状态契约

**文件：**
- 创建：`packages/core/src/types/mcp-oauth.ts`
- 修改：`packages/core/src/types/settings.ts`
- 修改：`packages/core/src/config/paths.ts`
- 修改：`packages/core/src/config/settings.ts`
- 修改：`packages/core/src/index.ts`
- 测试：`packages/core/src/config/settings.test.ts`
- 测试：`packages/core/src/config/paths.test.ts`

- [ ] **步骤 1：编写失败的配置和路径测试**

```ts
it("accepts non-secret MCP OAuth settings", async () => {
  await writeSettings({
    ...baseSettings,
    mcpServers: {
      linear: {
        type: "http",
        url: "https://mcp.linear.app/mcp",
        oauth: { scopes: ["read"], callbackPort: 43119 },
      },
    },
  });
  await expect(loadSettings()).resolves.toMatchObject({
    mcpServers: { linear: { oauth: { scopes: ["read"] } } },
  });
});

it("rejects secret-looking OAuth fields in settings", async () => {
  await writeRawSettings({
    ...baseSettings,
    mcpServers: {
      linear: { type: "http", url: "https://mcp.linear.app/mcp", oauth: { accessToken: "secret" } },
    },
  });
  await expect(loadSettings()).rejects.toThrow("settings.mcpServers.linear.oauth.accessToken");
});

it("resolves MCP OAuth credentials beside credentials.json", () => {
  expect(resolvePaths().mcpOAuthFilePath).toBe(join(resolvePaths().configDir, "mcp-oauth.json"));
});
```

- [ ] **步骤 2：运行测试并确认因类型、路径和嵌套校验缺失而失败**

运行：`pnpm --filter @openharness/core test -- src/config/settings.test.ts src/config/paths.test.ts`

预期：FAIL，缺少 `oauth` 类型、`mcpOAuthFilePath` 或嵌套字段校验。

- [ ] **步骤 3：添加纯 DTO 和设置类型**

```ts
export interface McpOAuthSettings {
  scopes?: string[];
  clientId?: string;
  callbackPort?: number;
}

export type McpOAuthAuthStatus =
  | "not-configured"
  | "not-logged-in"
  | "valid"
  | "expired-refreshable"
  | "reauthentication-required"
  | "static"
  | "unsupported";

export interface McpOAuthCredentialRecord {
  serverUrl: string;
  revision: number;
  binding: {
    issuer: string;
    redirectUri: string;
    tokenEndpoint: string;
    registrationEndpoint?: string;
    revocationEndpoint?: string;
  };
  registration: {
    client_id: string;
    client_secret?: string;
    token_endpoint_auth_method?: string;
    client_id_issued_at?: number;
    client_secret_expires_at?: number;
  };
  tokens: {
    accessToken: string;
    refreshToken?: string;
    tokenType: string;
    scope: string[];
    expiresAt?: number;
  };
  diagnostic?: { code: "reauthentication-required"; updatedAt: number };
}
```

把 `oauth?: McpOAuthSettings` 仅加到 `McpRemoteServerConfig`，stdio 继续声明 `oauth?: never`。在 settings 校验中逐个验证 `mcpServers.*` 和 `oauth` 的允许字段；不要接受 Token/secret 字段。

- [ ] **步骤 4：添加路径并导出契约**

在 `ResolvedPaths` 添加 `mcpOAuthFilePath`，实现 `getMcpOAuthFilePath()`，并从 `packages/core/src/index.ts` 导出 DTO 与路径函数。

- [ ] **步骤 5：运行核心测试和类型检查**

运行：`pnpm --filter @openharness/core test -- src/config/settings.test.ts src/config/paths.test.ts`

运行：`pnpm --filter @openharness/core check-types`

预期：PASS。

- [ ] **步骤 6：提交**

```bash
git add packages/core/src/types/mcp-oauth.ts packages/core/src/types/settings.ts packages/core/src/config/paths.ts packages/core/src/config/settings.ts packages/core/src/index.ts packages/core/src/config/settings.test.ts packages/core/src/config/paths.test.ts
git commit -m "feat(mcp): define OAuth configuration contracts"
```

## 任务 2：实现安全的 MCP OAuth 凭据仓库

**文件：**
- 创建：`packages/auth/src/mcp-oauth-credential-store.ts`
- 创建：`packages/auth/src/mcp-oauth-credential-store.test.ts`
- 修改：`packages/auth/src/index.ts`

- [ ] **步骤 1：先写存储、损坏文件和权限测试**

```ts
it("does not overwrite malformed credentials", async () => {
  await writeFile(file, "{broken", "utf8");
  const store = new McpOAuthCredentialStore(file);
  await expect(store.update("linear", () => credential)).rejects.toMatchObject({
    code: "invalid-mcp-oauth-store",
  });
  expect(await readFile(file, "utf8")).toBe("{broken");
});

it.runIf(process.platform !== "win32")("writes credentials with mode 0600", async () => {
  await store.set("linear", credential);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});
```

- [ ] **步骤 2：先写两个实例并发更新和刷新判据测试**

```ts
it("preserves updates from two store instances", async () => {
  const a = new McpOAuthCredentialStore(file);
  const b = new McpOAuthCredentialStore(file);
  await Promise.all([a.set("linear", linear), b.set("github", github)]);
  await expect(a.list()).resolves.toMatchObject({ linear, github });
});

it("does not treat a diagnostic-only revision as a completed refresh", async () => {
  const snapshot = expiringCredential({ revision: 1 });
  await store.set("linear", snapshot);
  await store.update("linear", current => ({ ...current!, revision: 2, diagnostic: reauthDiagnostic }));
  expect(shouldReuseCredentialAfterLock(snapshot, await store.get("linear"), Date.now())).toBe(false);
});
```

- [ ] **步骤 3：运行测试并确认缺少 store 而失败**

运行：`pnpm --filter @openharness/auth test -- src/mcp-oauth-credential-store.test.ts`

预期：FAIL，模块不存在。

- [ ] **步骤 4：实现版本化读取和 exclusive lock**

```ts
export interface McpOAuthStoreFile {
  version: 1;
  servers: Record<string, McpOAuthCredentialRecord>;
}

export class McpOAuthCredentialStore {
  constructor(
    private readonly filePath = getMcpOAuthFilePath(),
    private readonly clock = () => Date.now(),
  ) {}

  get(name: string): Promise<McpOAuthCredentialRecord | undefined>;
  list(): Promise<Record<string, McpOAuthCredentialRecord>>;
  set(name: string, value: McpOAuthCredentialRecord): Promise<void>;
  delete(name: string): Promise<boolean>;
  update(
    name: string,
    mutate: (current: McpOAuthCredentialRecord | undefined) => McpOAuthCredentialRecord | undefined,
  ): Promise<McpOAuthCredentialRecord | undefined>;
  runExclusive<T>(
    name: string,
    operation: (current: McpOAuthCredentialRecord | undefined) => Promise<{
      next: McpOAuthCredentialRecord | undefined;
      result: T;
    }>,
  ): Promise<T>;
}
```

锁用 `open(lockPath, "wx", 0o600)` 获取，50ms 重试，10 秒超时抛 `credential-lock-timeout`。只在 `mtime > 30s` 且记录 PID 不存在时清理 stale lock。每次拿锁后重新读取；`runExclusive()` 允许刷新流程在同一把锁内比较快照、请求 Token endpoint 并提交结果。发生写入时使用同目录唯一临时文件，`chmod(0o600)` 后 `rename`，最后在 `finally` 释放锁。

- [ ] **步骤 5：实现完整 Token 快照比较**

提供纯函数 `shouldReuseCredentialAfterLock(before, current, now)`：entry 缺失或 binding 变化抛稳定错误；refresh token 变化，或 access token 变化且 `expiresAt - now > 30_000` 时返回 true；仅 revision/diagnostic 变化但仍在刷新窗口则返回 false。

- [ ] **步骤 6：运行 auth 测试与类型检查**

运行：`pnpm --filter @openharness/auth test -- src/mcp-oauth-credential-store.test.ts src/index.test.ts`

运行：`pnpm --filter @openharness/auth check-types`

预期：PASS，且测试临时目录无残留 `.lock`/`.tmp`。

- [ ] **步骤 7：提交**

```bash
git add packages/auth/src/mcp-oauth-credential-store.ts packages/auth/src/mcp-oauth-credential-store.test.ts packages/auth/src/index.ts
git commit -m "feat(auth): persist MCP OAuth credentials safely"
```

## 任务 3：实现 OAuth 安全原语和 callback 生命周期

**文件：**
- 创建：`packages/mcp/src/oauth/errors.ts`
- 创建：`packages/mcp/src/oauth/security.ts`
- 创建：`packages/mcp/src/oauth/security.test.ts`
- 创建：`packages/mcp/src/oauth/callback.ts`
- 创建：`packages/mcp/src/oauth/callback.test.ts`

- [ ] **步骤 1：编写 HTTPS、issuer、scope 和 callback URL 失败测试**

```ts
it.each([
  "http://example.com/mcp",
  "https://user:pass@example.com/mcp",
  "https://example.com/mcp#fragment",
])("rejects unsafe OAuth endpoint %s", value => {
  expect(() => assertOAuthEndpoint(new URL(value))).toThrow();
});

it("allows loopback HTTP only when explicitly enabled", () => {
  expect(() => assertOAuthEndpoint(new URL("http://127.0.0.1:3000/mcp"))).toThrow();
  expect(() => assertOAuthEndpoint(new URL("http://127.0.0.1:3000/mcp"), { allowLoopbackHttp: true })).not.toThrow();
});

it("rejects scopes outside the approved set", () => {
  expect(() => assertScopeSubset(["read", "write"], ["read"])).toThrow("scope-expansion-required");
});
```

- [ ] **步骤 2：编写 callback 一次性消费、iss 和取消测试**

```ts
it("rejects a second callback and mismatched issuer", async () => {
  const callback = await createOAuthCallback({ expectedState: "s1", expectedIssuer: "https://issuer.test" });
  await expect(callback.accept(new URL(`${callback.redirectUri}?code=c&state=s1&iss=https://evil.test`)))
    .rejects.toMatchObject({ code: "oauth-issuer-mismatch" });
  await expect(callback.accept(new URL(`${callback.redirectUri}?code=c&state=s1&iss=https://issuer.test`)))
    .rejects.toMatchObject({ code: "oauth-callback-consumed" });
});
```

- [ ] **步骤 3：运行测试确认失败**

运行：`pnpm --filter @openharness/mcp test -- src/oauth/security.test.ts src/oauth/callback.test.ts`

预期：FAIL，模块不存在。

- [ ] **步骤 4：实现稳定错误类型和安全校验**

```ts
export class McpOAuthError extends Error {
  constructor(
    readonly code: McpOAuthErrorCode,
    message: string,
    readonly retryable = false,
  ) { super(message); }
}

export function assertScopeSubset(received: readonly string[], approved: readonly string[]): void;
export function assertIssuer(actual: string | undefined, expected: string, required: boolean): void;
export function assertOAuthEndpoint(url: URL, options?: { allowLoopbackHttp?: boolean }): void;
```

错误消息只能包含 endpoint origin、错误码和 scope 名称，不得包含 code、state、verifier 或 Token。

- [ ] **步骤 5：实现 loopback callback controller**

`createOAuthCallback()` 先绑定 `127.0.0.1`（固定端口或 `0`），再返回 `redirectUri`、`wait()`、`accept(url)` 和 `close()`。HTTP 请求与 stdin 粘贴 URL竞速，第一份结果一次性消费；state/iss 校验失败也消耗本次 flow 并关闭 listener。`AbortSignal`、5 分钟 deadline、SIGINT/SIGTERM 都调用同一个幂等 cleanup。

- [ ] **步骤 6：运行测试和类型检查**

运行：`pnpm --filter @openharness/mcp test -- src/oauth/security.test.ts src/oauth/callback.test.ts`

运行：`pnpm --filter @openharness/mcp check-types`

预期：PASS。

- [ ] **步骤 7：提交**

```bash
git add packages/mcp/src/oauth/errors.ts packages/mcp/src/oauth/security.ts packages/mcp/src/oauth/security.test.ts packages/mcp/src/oauth/callback.ts packages/mcp/src/oauth/callback.test.ts
git commit -m "feat(mcp): add OAuth security and callback primitives"
```

## 任务 4：实现交互登录、DCR、Token 交换和撤销

**文件：**
- 创建：`packages/mcp/src/oauth/login.ts`
- 创建：`packages/mcp/src/oauth/login.test.ts`
- 修改：`packages/mcp/src/index.ts`

- [ ] **步骤 1：编写 discovery issuer、approvedScopes 和 DCR 顺序测试**

```ts
it("binds callback before registering the dynamic client", async () => {
  const events: string[] = [];
  await login(fixture, {
    ...deps,
    callbackFactory: async () => { events.push("callback"); return callback; },
    registerClient: async (_issuer, input) => {
      events.push(`dcr:${input.clientMetadata.redirect_uris?.[0]}`);
      return registration;
    },
  });
  expect(events).toEqual(["callback", `dcr:${callback.redirectUri}`]);
});

it("requires explicit approval when discovery advertises scopes", async () => {
  const oauthServer = createOAuthFetchFixture({ protectedResourceScopes: ["read", "write"] });
  await expect(login({ ...fixture, scopes: undefined }, { ...deps, fetch: oauthServer.fetch }))
    .rejects.toMatchObject({ code: "oauth-scopes-not-approved" });
});

it("rejects metadata whose issuer differs from the discovered authorization server", async () => {
  await expect(login(mismatchedIssuerFixture, deps))
    .rejects.toMatchObject({ code: "oauth-issuer-mismatch" });
});
```

- [ ] **步骤 2：编写 callback iss 与最终 Token scope 测试**

```ts
it("rejects and revokes a token that grants extra scope", async () => {
  const oauthServer = createOAuthFetchFixture({ tokenScope: "read write" });
  await expect(login({ ...fixture, scopes: ["read"] }, { ...deps, fetch: oauthServer.fetch }))
    .rejects.toMatchObject({ code: "oauth-scope-expansion" });
  expect(oauthServer.revocationCalls).toBe(1);
  await expect(store.get("linear")).resolves.toBeUndefined();
});
```

- [ ] **步骤 3：运行测试确认失败**

运行：`pnpm --filter @openharness/mcp test -- src/oauth/login.test.ts`

预期：FAIL，`loginMcpOAuth` 不存在。

- [ ] **步骤 4：实现可注入的登录服务**

```ts
export interface McpOAuthCredentialStore {
  get(name: string): Promise<McpOAuthCredentialRecord | undefined>;
  set(name: string, credential: McpOAuthCredentialRecord): Promise<void>;
  delete(name: string): Promise<boolean>;
  update(name: string, mutate: CredentialMutation): Promise<McpOAuthCredentialRecord | undefined>;
  runExclusive<T>(name: string, operation: ExclusiveCredentialOperation<T>): Promise<T>;
}

export interface McpOAuthLoginDeps {
  fetch: typeof fetch;
  callbackFactory: typeof createOAuthCallback;
  registerClient: typeof registerClient;
  openBrowser(url: string): Promise<void>;
  readCallbackUrl(prompt: string): Promise<string>;
  verifyConnection(input: VerifyMcpOAuthConnectionInput): Promise<void>;
}

export async function loginMcpOAuth(input: {
  serverName: string;
  config: McpRemoteServerConfig;
  scopes?: string[];
  noBrowser?: boolean;
  store: McpOAuthCredentialStore;
  allowLoopbackHttp?: boolean;
  signal?: AbortSignal;
}, deps: McpOAuthLoginDeps): Promise<{ status: "valid"; scopes: string[]; verified: boolean }>;
```

流程严格按规格执行。测试中的 `createOAuthFetchFixture()` 返回实现 discovery/DCR/authorize/token/revoke 响应的可控 `fetch` 和请求计数器。生产代码使用 SDK 1.29.0 的 `discoverOAuthServerInfo`、`registerClient`、`startAuthorization` 和 `exchangeAuthorization`；resource URL、endpoint、issuer 和 scope 由本项目安全原语显式校验，不依赖 SDK 自动升级权限。`metadata.issuer` 必须与 discovered authorization server 精确匹配；callback `iss` 根据 metadata 声明校验；Token `scope` 缺失时继承 `approvedScopes`。

- [ ] **步骤 5：实现撤销并挂接临时连接验证**

撤销使用 metadata 的 `revocation_endpoint`，先 refresh token 后 access token。调用 SDK `selectClientAuthMethod` 选出 `client_secret_basic`、`client_secret_post` 或 `none`，再由本地 `applyClientAuthentication()` 分支准确写入 Authorization Header 或表单字段；所有请求 15 秒超时。实现并导出 `revokeMcpOAuthCredential()` 供 CLI logout 调用。

登录保存后必须调用注入的 `verifyConnection()`；任务 4 的协议单元测试注入非交互 fake，任务 5 再提供使用 runtime authenticated fetch 的真实实现。401/403 写入 diagnostic；非认证初始化错误保留凭据但返回 `verified:false`。这样任务 4 不复制刷新逻辑，最终验证仍允许在原授权 scope 内最多刷新一次，并始终禁止 redirect、DCR 和扩权。

- [ ] **步骤 6：运行登录测试与现有 MCP 测试**

运行：`pnpm --filter @openharness/mcp test -- src/oauth/login.test.ts src/index.test.ts`

预期：PASS，现有静态 Header/SSE/stdio 测试不变。

- [ ] **步骤 7：提交**

```bash
git add packages/mcp/src/oauth/login.ts packages/mcp/src/oauth/login.test.ts packages/mcp/src/index.ts
git commit -m "feat(mcp): implement interactive OAuth login"
```

## 任务 5：实现运行期刷新、单次 401 恢复和 manager 注入

**文件：**
- 创建：`packages/mcp/src/oauth/runtime-auth.ts`
- 创建：`packages/mcp/src/oauth/runtime-auth.test.ts`
- 创建：`packages/mcp/src/oauth/status.ts`
- 创建：`packages/mcp/src/oauth/status.test.ts`
- 创建：`packages/mcp/src/oauth/verify-connection.ts`
- 修改：`packages/mcp/src/index.ts`
- 修改：`packages/agent-runtime/src/runtime-integrations.ts`
- 修改：`packages/agent-runtime/src/runtime-integrations.test.ts`

- [ ] **步骤 1：编写状态计算和刷新 scope 测试**

```ts
it("computes expired-refreshable without mutating storage", () => {
  expect(resolveMcpOAuthStatus(config, expiredCredential, now)).toBe("expired-refreshable");
});

it("rejects refresh responses that expand scope", async () => {
  const { runtime, store } = runtimeFixture({
    stored: expiringCredential(),
    refreshResponseScope: "read write",
  });
  await expect(runtime.getAccessToken("linear", config))
    .rejects.toMatchObject({ code: "oauth-scope-expansion" });
  expect((await store.get("linear"))?.diagnostic?.code).toBe("reauthentication-required");
});
```

- [ ] **步骤 2：编写同进程、跨实例并发和 401/403 测试**

```ts
it("refreshes once across two runtime instances", async () => {
  await Promise.all([runtimeA.getAccessToken("linear", config), runtimeB.getAccessToken("linear", config)]);
  expect(tokenEndpointCalls).toBe(1);
});

it("retries one 401 exactly once and never retries insufficient_scope", async () => {
  const response = await authenticatedFetch(request);
  expect(response.status).toBe(200);
  expect(resourceCalls).toBe(2);
  await expect(authenticatedFetch(writeChallengeRequest)).rejects.toMatchObject({ code: "oauth-scope-expansion-required" });
  expect(openBrowser).not.toHaveBeenCalled();
});
```

- [ ] **步骤 3：运行测试确认失败**

运行：`pnpm --filter @openharness/mcp test -- src/oauth/runtime-auth.test.ts src/oauth/status.test.ts`

预期：FAIL，runtime auth 尚不存在。

- [ ] **步骤 4：实现 runtime service 和 authenticated fetch**

```ts
export class McpOAuthRuntime {
  constructor(options: {
    store: McpOAuthCredentialStore;
    fetch?: typeof fetch;
    allowLoopbackHttp?: boolean;
    clock?: () => number;
  });
  getStatus(name: string, config: McpServerConfig): Promise<McpOAuthAuthStatus>;
  getAccessToken(name: string, config: McpRemoteServerConfig, signal?: AbortSignal): Promise<string | undefined>;
  createFetch(name: string, config: McpRemoteServerConfig): typeof fetch;
}
```

连接前若 `expiresAt - now <= 30_000`，先刷新。进程内用 `Map<string, Promise<Credential>>` 合并；进程间调用 store 的 `runExclusive()`，在锁内重读并比较完整 Token 快照，其他进程已经刷新则直接复用，否则请求 Token endpoint 并原子提交。刷新用 SDK `refreshAuthorization`，30 秒操作 deadline、单请求 15 秒；返回 scope 缺失则继承原 scope，扩大则拒绝保存并写 diagnostic。

`createFetch` 每次请求从 store 获取当前 Token并设置 `Authorization`。首次 401 刷新后克隆并重发原请求一次；第二次 401 抛类型化错误。403 `insufficient_scope` 直接抛 `oauth-scope-expansion-required`，不调用 DCR、redirect 或浏览器。这里不向 SDK transport 传 `OAuthClientProvider`，从结构上关闭 SDK 1.29.0 的自动 upscoping。

- [ ] **步骤 5：实现登录后的临时连接验证**

`verifyMcpOAuthConnection()` 使用 `runtime.createFetch()` 创建一次性的 `StreamableHTTPClientTransport` 与 `Client`，执行 `initialize`、`tools/list`，并在 `finally` 关闭 client/transport。它不传 `OAuthClientProvider`；401 的刷新与单次重发只发生在 authenticated fetch 层，绝不重放工具调用。任务 4 的 `McpOAuthLoginDeps.verifyConnection` 由此函数满足。

- [ ] **步骤 6：把 runtime auth 注入 `McpClientManager`**

扩展 manager options：

```ts
oauthRuntime?: McpOAuthRuntime;
```

HTTP 且没有显式 `Authorization` Header 时，为 `StreamableHTTPClientTransport` 传 `fetch: oauthRuntime.createFetch(name, config)`；显式 Header 保持最高优先级。更新 `authConfigured` 和连接错误映射，但 manager 不在 `callTool()` 再重试。

- [ ] **步骤 7：在 session runtime 组合依赖并验证失败隔离**

`runtime-integrations.ts` 创建一个文件 store 和 `McpOAuthRuntime`，注入 manager。测试一个 OAuth server 返回重认证错误时，另一个 stdio server 仍注册工具；不得把 Token 写入 inspection 或错误文本。

- [ ] **步骤 8：运行相关测试**

运行：`pnpm --filter @openharness/mcp test -- src/oauth/runtime-auth.test.ts src/oauth/status.test.ts src/index.test.ts`

运行：`pnpm --filter @openharness/agent-runtime test -- src/runtime-integrations.test.ts src/mcp-auth.test.ts`

运行：`pnpm --filter @openharness/mcp check-types && pnpm --filter @openharness/agent-runtime check-types`

预期：PASS。

- [ ] **步骤 9：提交**

```bash
git add packages/mcp/src/oauth/runtime-auth.ts packages/mcp/src/oauth/runtime-auth.test.ts packages/mcp/src/oauth/status.ts packages/mcp/src/oauth/status.test.ts packages/mcp/src/oauth/verify-connection.ts packages/mcp/src/index.ts packages/agent-runtime/src/runtime-integrations.ts packages/agent-runtime/src/runtime-integrations.test.ts
git commit -m "feat(mcp): refresh OAuth credentials at runtime"
```

## 任务 6：实现 Codex 兼容的 MCP CLI 闭环

**文件：**
- 修改：`apps/cli/src/commands/mcp.ts`
- 创建：`apps/cli/src/commands/mcp.test.ts`
- 修改：`apps/cli/package.json`

- [ ] **步骤 1：编写命令解析和配置写入测试**

```ts
it("adds streamable HTTP using the Codex command shape", async () => {
  await runMcp(["add", "linear", "--url", "https://mcp.linear.app/mcp"]);
  expect(savedSettings.mcpServers?.linear).toEqual({
    type: "http",
    url: "https://mcp.linear.app/mcp",
  });
});

it("adds stdio only after the command separator", async () => {
  await runMcp(["add", "local", "--", "node", "server.js"]);
  expect(savedSettings.mcpServers?.local).toMatchObject({ type: "stdio", command: "node", args: ["server.js"] });
});

it("rejects URL and stdio command together", async () => {
  await expect(runMcp(["add", "bad", "--url", "https://x.test/mcp", "--", "node"])).rejects.toThrow();
});
```

- [ ] **步骤 2：编写 login/get/list/logout/remove 和脱敏测试**

```ts
it("passes comma-separated scopes and no-browser to login", async () => {
  await runMcp(["login", "linear", "--scopes", "read,issues:read", "--no-browser"]);
  expect(loginMcpOAuth).toHaveBeenCalledWith(expect.objectContaining({
    scopes: ["read", "issues:read"],
    noBrowser: true,
  }));
});

it("never prints secrets in list/get JSON", async () => {
  const output = await runMcp(["get", "linear", "--json"]);
  expect(output).not.toContain("access-secret");
  expect(JSON.parse(output)).toMatchObject({ name: "linear", authStatus: "valid" });
});
```

- [ ] **步骤 3：运行 CLI 测试确认失败**

运行：`pnpm --filter @rzx/ohs test -- src/commands/mcp.test.ts`

预期：FAIL，缺少新命令和参数。

- [ ] **步骤 4：重构命令为可注入依赖的 command factory**

```ts
export interface McpCommandDeps {
  loadSettings: typeof loadSettings;
  saveSettings: typeof saveSettings;
  store: McpOAuthCredentialStore;
  login: typeof loginMcpOAuth;
  revoke: typeof revokeMcpOAuthCredential;
  runtime: McpOAuthRuntime;
  openBrowser(url: string): Promise<void>;
  readLine(prompt: string): Promise<string>;
  stdout(line: string): void;
}

export function createMcpCommand(deps: McpCommandDeps = createDefaultMcpCommandDeps()): Command;
```

默认依赖使用 `open` 包的函数式 API 打开授权 URL，不得通过 `shell:true` 或拼接命令。先运行 `pnpm --filter @rzx/ohs add open`，让 `apps/cli/package.json` 记录 runtime dependency、`pnpm-lock.yaml` 固定实际解析版本；测试只注入 `openBrowser`，不启动真实浏览器。

- [ ] **步骤 5：实现命令行为和稳定 JSON**

- `add --url` 只保存 HTTP 配置，不自动登录；stdio 使用 `-- <command...>`。
- `login --scopes <csv> [--no-browser]` 调用登录服务。
- `login` 遇到显式 `Authorization` Header 时拒绝继续并提示先移除冲突配置，避免静态 Header 遮蔽新 Token。
- `get/list --json` 输出 `{ name, enabled, transport, url|command, authStatus, scopes }`，省略 Header 值和所有凭据字段。
- `logout` 先尽力撤销，始终删除本地凭据，并提示现有 session 不会即时断开。
- `remove` 删除配置和本地凭据，不承诺远端撤销。
- 配置不存在、transport 不支持、登录失败使用非零退出码；错误文本只含稳定 code 和可操作提示。

- [ ] **步骤 6：运行 CLI 测试、帮助快照和类型检查**

运行：`pnpm --filter @rzx/ohs test -- src/commands/mcp.test.ts src/index.test.ts`

运行：`pnpm --filter @rzx/ohs check-types`

手工检查：`pnpm --filter @rzx/ohs exec tsx src/index.ts mcp --help`

预期：命令面包含 `list/get/add/remove/login/logout`，`login --help` 包含 `--scopes`、`--no-browser`。

- [ ] **步骤 7：提交**

```bash
git add apps/cli/src/commands/mcp.ts apps/cli/src/commands/mcp.test.ts apps/cli/package.json pnpm-lock.yaml
git commit -m "feat(cli): add MCP OAuth login commands"
```

## 任务 7：加入真实 SDK 本地集成测试、文档和 Linear 验收说明

**文件：**
- 创建：`packages/mcp/src/oauth/test-server.test.ts`
- 修改：`README.md`
- 修改：`docs/mcp-http-transport-design.md`

- [ ] **步骤 1：编写真实 SDK transport 的本地端到端测试**

本测试启动 `127.0.0.1` HTTP server，提供：MCP endpoint、Protected Resource Metadata、Authorization Server Metadata、DCR、authorize、token、refresh、revoke。除浏览器打开外不 mock `StreamableHTTPClientTransport` 或 `Client`。

```ts
it("logs in, persists, reconnects, refreshes once, and logs out", async () => {
  const harness = await startOAuthMcpTestServer({ grantedScopes: ["read"] });
  const login = loginMcpOAuth({
    serverName: "local",
    config: { type: "http", url: harness.mcpUrl, oauth: { scopes: ["read"] } },
    store,
    allowLoopbackHttp: true,
  }, {
    ...createDefaultMcpOAuthLoginDeps(),
    openBrowser: harness.followAuthorizationRedirect,
  });
  await expect(login).resolves.toMatchObject({ status: "valid", verified: true });

  const manager = new McpClientManager({ oauthRuntime: new McpOAuthRuntime({ store, allowLoopbackHttp: true }) });
  await expect(manager.connect("local", { type: "http", url: harness.mcpUrl })).resolves.toMatchObject({ status: "connected" });
  expect(harness.toolsListCalls).toBeGreaterThan(0);

  harness.expireAccessToken();
  await manager.connect("local", { type: "http", url: harness.mcpUrl });
  expect(harness.refreshCalls).toBe(1);
});
```

- [ ] **步骤 2：加入协议攻击与超时集成场景**

在同一测试 server 覆盖：metadata issuer 不匹配、callback `iss` 缺失/不匹配、token/refresh 扩大 scope、远程 HTTP endpoint 被拒、挂起 discovery/DCR/token/refresh/revoke 的单请求超时（测试注入短 deadline）、401 只重试一次、一个 OAuth server 失败不影响另一个 server。

- [ ] **步骤 3：运行集成测试并实现完整本地协议夹具**

运行：`pnpm --filter @openharness/mcp test -- src/oauth/test-server.test.ts`

预期初次 FAIL 于缺少本地 server 行为。实现 `startOAuthMcpTestServer()`：逐一注册步骤 1 所列七类 endpoint，返回与 SDK 1.29.0 兼容的 metadata/challenge/JSON，并暴露 authorize 跟随器、Token 失效开关和 DCR/token/refresh/revoke/tools-list 请求计数器；完成后测试 PASS。

- [ ] **步骤 4：更新用户文档**

README 和 MCP 设计文档必须包含：

```bash
ohs mcp add linear --url https://mcp.linear.app/mcp
ohs mcp login linear --scopes read
ohs mcp get linear
ohs mcp logout linear
```

同时说明：凭据位于 `mcp-oauth.json`、首版没有 keyring、`add --url` 不自动登录、运行中的 session 不即时重连、HTTP 只允许测试 loopback、`--no-browser` 可粘贴完整 callback URL。

- [ ] **步骤 5：运行相关包测试和全仓类型检查**

运行：`pnpm --filter @openharness/core test`

运行：`pnpm --filter @openharness/auth test`

运行：`pnpm --filter @openharness/mcp test`

运行：`pnpm --filter @openharness/agent-runtime test -- src/runtime-integrations.test.ts src/mcp-auth.test.ts`

运行：`pnpm --filter @rzx/ohs test -- src/commands/mcp.test.ts src/index.test.ts`

运行：`pnpm check-types`

预期：全部 PASS，输出中搜索不到测试用 access token、refresh token、code verifier 或 client secret。

- [ ] **步骤 6：执行 Linear 人工验收**

准备测试 Linear workspace 后运行：

```bash
ohs mcp add linear --url https://mcp.linear.app/mcp
ohs mcp get linear
ohs mcp login linear --scopes read
ohs mcp get linear --json
ohs mcp list
```

确认登录前 `not-logged-in`，登录后本地状态 `valid`，`tools/list` 和一个只读调用成功，重启 CLI/新 session 后无需重新登录。最后运行 `ohs mcp logout linear` 并确认回到 `not-logged-in`。人工验收不得把真实 Token 写入测试夹具、日志或提交。

- [ ] **步骤 7：提交**

```bash
git add packages/mcp/src/oauth/test-server.test.ts README.md docs/mcp-http-transport-design.md
git commit -m "test(mcp): cover OAuth CLI end to end"
```

## 最终验证

- [ ] 运行 `git diff --check`。
- [ ] 运行 `pnpm --filter @openharness/core test`。
- [ ] 运行 `pnpm --filter @openharness/auth test`。
- [ ] 运行 `pnpm --filter @openharness/mcp test`。
- [ ] 运行 `pnpm --filter @openharness/agent-runtime test -- src/runtime-integrations.test.ts src/mcp-auth.test.ts`。
- [ ] 运行 `pnpm --filter @rzx/ohs test -- src/commands/mcp.test.ts src/index.test.ts`。
- [ ] 运行 `pnpm check-types`。
- [ ] 检查 `git status --short`，确保没有提交 `mcp-oauth.json`、真实 Token、测试临时文件或工作区中原有的无关改动。
- [ ] 请求独立代码审查，修复全部 Critical/Important 问题后再进行 Linear 人工验收。
