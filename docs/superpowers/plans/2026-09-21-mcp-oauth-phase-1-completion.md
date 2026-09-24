# MCP OAuth 第一阶段补全实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 补齐 MCP OAuth 的状态查询、登录/退出后活动 Runtime 同步，以及 CLI 与 Desktop 的统一认证状态展示，让 Streamable HTTP OAuth 形成可验证的完整闭环。

**架构：** `packages/core` 定义无秘密 DTO 与 Runtime 协调契约，`packages/mcp` 负责认证快照、endpoint identity 和 staged 连接，`packages/server` 维护活动 Runtime registry 并提供受 daemon Bearer/协议版本保护的状态与同步接口。CLI 和 Desktop 都通过同一应用服务完成 OAuth 提交，并通过 `@vykor/client` 通知 daemon；Runtime 只根据凭据仓库最终状态重连或断开。

**技术栈：** TypeScript、Vitest、Commander、Hono、Electron/React、Model Context Protocol TypeScript SDK、pnpm/Turborepo

---

## 文件结构

### 新建文件

- `packages/mcp/src/oauth/snapshot.ts`：规范化 HTTP endpoint、计算 fingerprint，并构造统一的无秘密认证快照。
- `packages/mcp/src/oauth/snapshot.test.ts`：覆盖 OAuth/Bearer/custom/none、scope 和 endpoint identity。
- `packages/server/src/application/mcp-runtime-connection-coordinator.ts`：活动 Runtime registry、per-identity generation、串行同步和聚合状态。
- `packages/server/src/application/mcp-runtime-connection-coordinator.test.ts`：覆盖 identity 筛选、并发同步、通知乱序与失败聚合。
- `packages/server/src/http/routes/mcp.ts`：提供只读 Runtime 状态与幂等同步路由。
- `packages/server/src/http/routes/mcp.test.ts`：验证请求参数、响应形状以及请求不携带 endpoint/Token。
- `packages/client/src/resources/mcp-resource.ts`：封装 daemon MCP Runtime 状态与同步 HTTP 调用。
- `packages/client/src/resources/__test__/mcp-resource.test.ts`：验证 URL、请求体和错误传播。
- `apps/cli/src/mcp-runtime-coordinator.ts`：从 daemon registry 创建 `@vykor/client` 调用；daemon 缺席时返回 `unavailable`。
- `apps/cli/src/mcp-runtime-coordinator.test.ts`：覆盖 daemon 在线、离线、认证失败和协议不兼容。

### 修改文件

- `packages/core/src/types/mcp-oauth.ts`、`packages/core/src/index.ts`：增加 `McpAuthMode`、`McpRuntimeStatus`、identity、snapshot 与同步结果 DTO。
- `packages/core/src/types/tools.ts`、`packages/core/src/engine/tool-registry.ts`、对应测试：增加 `replaceBySource()` 原子提交。
- `packages/mcp/src/index.ts`、对应测试：增加 prepared connection、同步激活和可观察的断开错误。
- `packages/mcp/src/oauth/login.ts`、对应测试：候选凭据先在内存验证，验证成功后才允许持久化。
- `packages/auth/src/mcp-oauth-credential-store.ts`、对应测试：复用 `runExclusive()` 串行化最终提交，不改变凭据文件格式。
- `packages/agent-runtime/src/runtime-integrations.ts`、`packages/agent-runtime/src/agent-options.ts`、`packages/agent-runtime/src/agent-composition.ts`、对应测试：在连接前登记 Runtime handle，在清理时注销，并使用原子 Registry 替换。
- `packages/server/src/application/mcp-oauth-application-service.ts`、对应测试：编排 settings 与 credential 的提交、Runtime 同步及稳定错误阶段。
- `packages/server/src/application/daemon-application.ts`、`packages/server/src/daemon/daemon-agent.ts`、对应测试：把 Runtime registry 注入每个 Session agent。
- `packages/server/src/http/server.ts`、`packages/server/src/index.ts`、HTTP 测试：挂载 MCP 控制面路由并导出契约。
- `packages/client/src/resources/index.ts`、`packages/client/src/transport/vykor-client.ts`、`packages/client/src/index.ts`、公共 API 测试：公开 `McpResource`。
- `apps/cli/src/commands/mcp.ts`、对应测试：增加 `status`，统一 `get/status` 输出，并在 login/logout 后同步 Runtime。
- `apps/desktop/src/shared/mcp-types.ts`、主进程 MCP service/测试、renderer MCP settings/测试：展示认证方式、凭据状态和 Runtime 状态，保留授权成功但同步失败的状态。

## 任务 1：共享状态模型与无秘密快照

**文件：**
- 修改：`packages/core/src/types/mcp-oauth.ts`
- 修改：`packages/core/src/index.ts`
- 创建：`packages/mcp/src/oauth/snapshot.ts`
- 创建：`packages/mcp/src/oauth/snapshot.test.ts`
- 修改：`packages/mcp/src/index.ts`
- 修改：`packages/mcp/src/oauth/status.ts`
- 测试：`packages/mcp/src/oauth/status.test.ts`

- [ ] **步骤 1：为状态矩阵和 identity 编写失败测试**

在 `snapshot.test.ts` 中覆盖：显式 Bearer 优先于残留 OAuth 凭据、非 Bearer Authorization 为 `custom`、配置有 `oauth.scopes` 但无凭据为 `oauth/not-logged-in`、stdio 为 `none/unsupported`、凭据 scopes 优先于 settings scopes，以及 query 被保留但 fragment 被移除。

```ts
expect(buildMcpAuthServerSnapshot({
  name: "linear",
  config: { type: "http", url: "https://MCP.Linear.app:443/mcp?tenant=a#fragment", oauth: { scopes: ["read"] } },
  credential: undefined,
  runtimeStatus: "unavailable",
})).toMatchObject({
  authMode: "oauth",
  authStatus: "not-logged-in",
  scopes: ["read"],
  runtimeStatus: "unavailable",
});

expect(createMcpServerIdentity("linear", {
  type: "http",
  url: "https://MCP.Linear.app:443/mcp?tenant=a#fragment",
})).toEqual({
  name: "linear",
  transport: "http",
  endpoint: "https://mcp.linear.app/mcp?tenant=a",
  endpointFingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
});
```

- [ ] **步骤 2：运行测试并确认新 API 尚不存在**

运行：`pnpm --filter @vykor/mcp exec vitest run src/oauth/snapshot.test.ts src/oauth/status.test.ts`

预期：FAIL，提示 `buildMcpAuthServerSnapshot` 或 `createMcpServerIdentity` 未导出。

- [ ] **步骤 3：定义纯数据 DTO**

在 `packages/core/src/types/mcp-oauth.ts` 增加并从 core 入口导出：

```ts
export type McpAuthMode = "none" | "oauth" | "bearer" | "custom";
export type McpRuntimeStatus = "connected" | "disconnected" | "error" | "unavailable";

export interface McpServerIdentity {
  name: string;
  transport: "http";
  endpoint: string;
  endpointFingerprint: string;
}

export interface McpRuntimeSyncResult {
  status: McpRuntimeStatus;
  affectedRuntimes: number;
  failures: Array<{ runtimeId: string; message: string }>;
}

export interface McpAuthServerSnapshot {
  name: string;
  enabled: true;
  transport: "stdio" | "http" | "sse";
  endpoint?: string;
  authMode: McpAuthMode;
  authStatus: McpOAuthAuthStatus;
  scopes: string[];
  runtimeStatus: McpRuntimeStatus;
}
```

- [ ] **步骤 4：实现 endpoint identity 与快照构造函数**

在 `snapshot.ts` 中使用 `URL` 规范化 endpoint，拒绝 username/password，删除 fragment，保留 path/query，并使用 `createHash("sha256").digest("base64url")` 计算 fingerprint。`buildMcpAuthServerSnapshot()` 必须先检查显式 Authorization，再检查配置 OAuth 或匹配凭据；不得返回 Header、Token、client secret 或 callback URL。

- [ ] **步骤 5：运行 MCP 测试与类型检查**

运行：`pnpm --filter @vykor/mcp exec vitest run src/oauth/snapshot.test.ts src/oauth/status.test.ts`

预期：PASS。

运行：`pnpm --filter @vykor/core check-types && pnpm --filter @vykor/mcp check-types`

预期：两个命令均成功。

- [ ] **步骤 6：提交共享模型**

```bash
git add packages/core/src/types/mcp-oauth.ts packages/core/src/index.ts packages/mcp/src/oauth/snapshot.ts packages/mcp/src/oauth/snapshot.test.ts packages/mcp/src/oauth/status.ts packages/mcp/src/oauth/status.test.ts packages/mcp/src/index.ts
git commit -m "feat(mcp): add unified OAuth status snapshot"
```

## 任务 2：Tool Registry 按来源原子替换

**文件：**
- 修改：`packages/core/src/types/tools.ts`
- 修改：`packages/core/src/engine/tool-registry.ts`
- 测试：`packages/core/src/engine/index.test.ts`
- 测试：`packages/agent-runtime/src/run-capability-mcp.test.ts`

- [ ] **步骤 1：编写失败测试**

测试必须证明：只替换 `{ kind: "mcp", id: "linear" }` 的工具；名称与其他 source 冲突时原 Map 不变；已经由 Run 捕获的旧 definition 仍调用旧闭包；新 Run 读取完整的新集合。

```ts
expect(() => registry.replaceBySource(source, [conflicting])).toThrow("already registered");
expect(registry.get("mcp__linear__old")).toBe(oldDefinition);
expect(registry.get("Builtin")).toBe(builtin);

registry.replaceBySource(source, [newDefinition]);
expect(registry.get("mcp__linear__old")).toBeUndefined();
expect(registry.get("mcp__linear__new")).toBe(newDefinition);
```

- [ ] **步骤 2：运行测试确认接口缺失**

运行：`pnpm --filter @vykor/core exec vitest run src/engine/index.test.ts`

预期：FAIL，提示 `replaceBySource` 不存在。

- [ ] **步骤 3：扩展 Registry 接口并实现 copy-on-write 提交**

在 `ToolRegistry` 接口增加：

```ts
replaceBySource(source: ToolRegistrationSource, tools: ToolDefinition[]): void;
```

实现时复制当前 `Map`，在副本中删除 source 完全匹配的 entry，验证所有新名称不与副本剩余 entry 冲突，再以一次 `this.tools = next` 完成提交。整个方法保持同步，不调用外部回调，不包含 `await`。

- [ ] **步骤 4：运行 Registry 与 Run 捕获测试**

运行：`pnpm --filter @vykor/core exec vitest run src/engine/index.test.ts`

运行：`pnpm --filter @vykor/agent-runtime exec vitest run src/run-capability-mcp.test.ts`

预期：全部 PASS。

- [ ] **步骤 5：提交 Registry 原子替换**

```bash
git add packages/core/src/types/tools.ts packages/core/src/engine/tool-registry.ts packages/core/src/engine/index.test.ts packages/agent-runtime/src/run-capability-mcp.test.ts
git commit -m "feat(core): replace tools atomically by source"
```

## 任务 3：MCP staged connection 与一致提交

**文件：**
- 修改：`packages/mcp/src/index.ts`
- 测试：`packages/mcp/src/index.test.ts`
- 修改：`packages/agent-runtime/src/mcp-auth.ts`
- 测试：`packages/agent-runtime/src/mcp-auth.test.ts`

- [ ] **步骤 1：为 staged 生命周期编写失败测试**

覆盖 prepared connection 不进入 `getConnection()`、激活成功后返回旧资源、Registry commit 抛错时恢复旧连接、旧连接 close 失败时新连接保持 connected、disconnect 在 close 抛错后仍清理 maps。

```ts
const prepared = await manager.prepareConnection("linear", config);
expect(manager.getConnection("linear")).toBe(oldConnection);

const activation = manager.activatePreparedConnection(prepared, definitions => {
  registry.replaceBySource({ kind: "mcp", id: "linear" }, definitions);
});
expect(manager.getConnection("linear")).toBe(prepared.connection);
await activation.closePrevious();
```

- [ ] **步骤 2：运行测试确认 staged API 不存在**

运行：`pnpm --filter @vykor/mcp exec vitest run src/index.test.ts`

预期：FAIL，提示 prepared/activation 方法不存在。

- [ ] **步骤 3：提取连接准备逻辑**

定义 `PreparedMcpConnection`，保存 name、connection、client、transport 和只绑定 staged client 的 Tool Definitions。`prepareConnection()` 完成 connect、tools/resources discovery，但不修改当前 maps；失败时关闭 staged 资源并抛出原始脱敏错误。

- [ ] **步骤 4：实现同步激活与可观察清理**

`activatePreparedConnection(prepared, commitTools)` 必须在同步调用栈内依次切换 manager maps、调用 `commitTools`，失败时恢复旧 maps。方法返回 `closePrevious(): Promise<void>` 或 `discardPrepared(): Promise<void>`，异步关闭只能由临界区外的调用方执行。`disconnect()` 在 `finally` 中清理 maps，并把 close 错误向上传递。

- [ ] **步骤 5：让静态认证重连复用 staged 提交**

把 `createMcpAuthHost()` 中“先删工具再 reconnect”的流程替换为 prepare → `replaceBySource()` → close previous。连接或 Registry 验证失败时保留旧连接与旧工具。

- [ ] **步骤 6：运行 MCP 与 agent-runtime 测试**

运行：`pnpm --filter @vykor/mcp exec vitest run src/index.test.ts`

运行：`pnpm --filter @vykor/agent-runtime exec vitest run src/mcp-auth.test.ts src/run-capability-mcp.test.ts`

预期：全部 PASS。

- [ ] **步骤 7：提交 staged connection**

```bash
git add packages/mcp/src/index.ts packages/mcp/src/index.test.ts packages/agent-runtime/src/mcp-auth.ts packages/agent-runtime/src/mcp-auth.test.ts
git commit -m "feat(mcp): activate prepared connections atomically"
```

## 任务 4：活动 Runtime registry 与 generation 协调

**文件：**
- 创建：`packages/server/src/application/mcp-runtime-connection-coordinator.ts`
- 创建：`packages/server/src/application/mcp-runtime-connection-coordinator.test.ts`
- 修改：`packages/agent-runtime/src/agent-options.ts`
- 修改：`packages/agent-runtime/src/agent-composition.ts`
- 修改：`packages/agent-runtime/src/runtime-integrations.ts`
- 测试：`packages/agent-runtime/src/runtime-integrations.test.ts`
- 修改：`packages/server/src/daemon/daemon-agent.ts`
- 测试：`packages/server/src/daemon/__test__/daemon-agent.test.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`packages/server/src/application/index.ts`

- [ ] **步骤 1：编写 coordinator 失败测试**

构造同名同 endpoint、同名不同 endpoint、正在初始化和失败的 fake handles。验证 identity 筛选、`affectedRuntimes`、`error > disconnected > connected` 聚合顺序、每个 identity 串行执行，以及第二次同步让第一代 staged 连接失效。

```ts
const first = coordinator.synchronize(identity);
const second = coordinator.synchronize(identity);
await Promise.all([first, second]);
expect(handle.generations).toEqual([1, 2]);
expect(handle.maxConcurrentSynchronize).toBe(1);
```

- [ ] **步骤 2：运行测试确认 coordinator 不存在**

运行：`pnpm --filter @vykor/server exec vitest run src/application/mcp-runtime-connection-coordinator.test.ts`

预期：FAIL，模块尚不存在。

- [ ] **步骤 3：实现 Runtime registry 与协调器**

实现以下窄接口：

```ts
export interface ActiveMcpRuntimeHandle {
  runtimeId: string;
  identity(name: string): McpServerIdentity | undefined;
  synchronize(identity: McpServerIdentity, generation: number): Promise<void>;
  getStatus(identity: McpServerIdentity): McpRuntimeStatus;
}

export interface McpRuntimeConnectionCoordinator {
  getStatus(identity: McpServerIdentity): Promise<McpRuntimeSyncResult>;
  synchronize(identity: McpServerIdentity): Promise<McpRuntimeSyncResult>;
}
```

使用 endpoint fingerprint 作为串行队列 key；`synchronize()` 在队列内递增 generation，再快照当时已登记的匹配 handles 并 `Promise.allSettled()`。

- [ ] **步骤 4：在 Runtime 开始连接前登记 handle**

给 agent options 增加可选 `mcpRuntimeRegistry` 依赖。`installRuntimeIntegrations()` 在 `connectAll()` 前登记 initializing handle，handle 使用自己的 `mcpServers`、manager 与 toolRegistry；Runtime cleanup 必须注销 handle并断开 manager。连接前、连接完成后和激活前分别核对 generation。

- [ ] **步骤 5：把 registry 从 daemon application 注入 Session agent**

`DurableAgentApplication` 创建唯一 registry/coordinator；`createDaemonAgent()` 组装 agent options 时传入 registry。测试证明两个 cwd 下同名不同 endpoint 的 Runtime 不互相同步。

- [ ] **步骤 6：运行跨包定向测试**

运行：`pnpm --filter @vykor/server exec vitest run src/application/mcp-runtime-connection-coordinator.test.ts src/daemon/__test__/daemon-agent.test.ts`

运行：`pnpm --filter @vykor/agent-runtime exec vitest run src/runtime-integrations.test.ts src/run-capability-mcp.test.ts`

预期：全部 PASS。

- [ ] **步骤 7：提交 Runtime 协调**

```bash
git add packages/server/src/application/mcp-runtime-connection-coordinator.ts packages/server/src/application/mcp-runtime-connection-coordinator.test.ts packages/server/src/application/daemon-application.ts packages/server/src/application/index.ts packages/server/src/daemon/daemon-agent.ts packages/server/src/daemon/__test__/daemon-agent.test.ts packages/agent-runtime/src/agent-options.ts packages/agent-runtime/src/agent-composition.ts packages/agent-runtime/src/runtime-integrations.ts packages/agent-runtime/src/runtime-integrations.test.ts
git commit -m "feat(server): coordinate active MCP runtimes"
```

## 任务 5：OAuth 候选验证与原子提交

**文件：**
- 修改：`packages/mcp/src/oauth/login.ts`
- 测试：`packages/mcp/src/oauth/login.test.ts`
- 修改：`packages/server/src/application/mcp-oauth-application-service.ts`
- 测试：`packages/server/src/application/mcp-oauth-application-service.test.ts`
- 修改：`packages/core/src/config/settings.ts`
- 测试：`packages/core/src/config/settings.test.ts`

- [ ] **步骤 1：编写失败测试覆盖候选凭据隔离**

测试验证临时 MCP 检查时共享 store 仍为旧凭据、验证期 refresh 只更新内存 store、验证失败只撤销候选 Token、两次并发重新授权中失败者不会回滚成功者。

```ts
await expect(service.login(request)).rejects.toMatchObject({
  code: "oauth-login-verification-failed",
});
expect(await sharedStore.get("linear")).toEqual(oldCredential);
expect(coordinator.synchronize).not.toHaveBeenCalled();
```

- [ ] **步骤 2：编写失败测试覆盖 settings/credential 同一提交顺序**

模拟两次 scopes 不同的成功登录，阻塞第一个提交；断言最终 credential scopes 与 settings `oauth.scopes` 都来自最后离开 `runExclusive()` 的操作。再模拟 settings 保存失败，断言候选凭据不进入共享 store。

- [ ] **步骤 3：运行应用服务与登录测试**

运行：`pnpm --filter @vykor/mcp exec vitest run src/oauth/login.test.ts`

运行：`pnpm --filter @vykor/server exec vitest run src/application/mcp-oauth-application-service.test.ts`

预期：FAIL，当前登录会提前写共享 store，应用服务也没有 coordinator。

- [ ] **步骤 4：增加操作内可写内存 credential store**

让 `loginMcpOAuth()` 返回最终候选 credential，不直接持久化共享 store。为一次性验证创建仅持有一个 server 的内存 store，实现 `get/set/delete/update/runExclusive`；`McpOAuthRuntime` 的 401 刷新与 refresh token 轮换只能写入此 store。

- [ ] **步骤 5：在应用服务中提交 settings 与 credential**

给 service 注入 `loadSettings`、`saveSettings`、store 和 coordinator。临时验证成功后进入共享 store 的 `runExclusive(name)`：锁内重新加载 settings，只 patch `mcpServers[name].oauth.scopes`，先保存 settings，再把最终候选作为 `next` 返回。不得复用登录开始前的 settings 快照。

- [ ] **步骤 6：实现 logout 兼容回填与最终状态同步**

logout 先尽力把旧凭据 scopes 回填到 settings，回填失败记录警告但继续；随后尽力 revoke 并无条件删除本地凭据，再调用 `synchronize(identity)`。同步失败使用 `oauth-removed-runtime-sync-failed`，不得恢复 Token。

- [ ] **步骤 7：实现四类稳定错误阶段**

确保应用服务对外区分：

```ts
"oauth-login-failed"
"oauth-login-verification-failed"
"oauth-saved-runtime-sync-failed"
"oauth-removed-runtime-sync-failed"
```

错误详情只允许 server name、Runtime 数量和脱敏 message。

- [ ] **步骤 8：运行认证定向测试**

运行：`pnpm --filter @vykor/mcp exec vitest run src/oauth/login.test.ts src/oauth/runtime-auth.test.ts src/oauth/verify-connection.test.ts`

运行：`pnpm --filter @vykor/auth exec vitest run src/mcp-oauth-credential-store.test.ts`

运行：`pnpm --filter @vykor/server exec vitest run src/application/mcp-oauth-application-service.test.ts`

预期：全部 PASS。

- [ ] **步骤 9：提交 OAuth 原子提交逻辑**

```bash
git add packages/mcp/src/oauth/login.ts packages/mcp/src/oauth/login.test.ts packages/server/src/application/mcp-oauth-application-service.ts packages/server/src/application/mcp-oauth-application-service.test.ts packages/core/src/config/settings.ts packages/core/src/config/settings.test.ts
git commit -m "feat(mcp): commit verified OAuth credentials atomically"
```

## 任务 6：daemon MCP 控制面与 typed client

**文件：**
- 创建：`packages/server/src/http/routes/mcp.ts`
- 创建：`packages/server/src/http/routes/mcp.test.ts`
- 修改：`packages/server/src/http/server.ts`
- 修改：`packages/server/src/http/__test__/http.test.ts`
- 创建：`packages/client/src/resources/mcp-resource.ts`
- 创建：`packages/client/src/resources/__test__/mcp-resource.test.ts`
- 修改：`packages/client/src/resources/index.ts`
- 修改：`packages/client/src/transport/http-client.ts`
- 修改：`packages/client/src/index.ts`
- 测试：`packages/client/src/__test__/public-api.test.ts`

- [ ] **步骤 1：编写 Server 路由失败测试**

挂载测试 app，验证：

```text
GET  /mcp/linear/runtime-status?fingerprint=<43-char-base64url>
POST /mcp/linear/synchronize
body: { "fingerprint": "<43-char-base64url>" }
```

缺少或非法 fingerprint 返回 400；未知 identity 返回 `unavailable`；请求/响应序列化中不出现完整 endpoint、Token 或 Authorization。

- [ ] **步骤 2：运行路由测试确认 404**

运行：`pnpm --filter @vykor/server exec vitest run src/http/routes/mcp.test.ts src/http/__test__/http.test.ts`

预期：FAIL，路由尚未挂载。

- [ ] **步骤 3：实现并挂载 Hono 路由**

路由只把 `{ name, endpointFingerprint }` 交给 coordinator。identity 的 endpoint 由参与 Runtime 自己持有；控制面不接受完整 endpoint。依赖 server 现有全局 `protocolMiddleware` 和 Bearer 中间件，不新增绕过路径。

- [ ] **步骤 4：为 typed client 编写失败测试**

断言 `McpResource.runtimeStatus(name, fingerprint)` 发 GET，`synchronize()` 发 POST JSON；两者通过现有 `HttpTransport` 自动携带协议版本与 Bearer Token。

- [ ] **步骤 5：实现 `McpResource` 并接入 `VykorClient`**

公开：

```ts
class McpResource {
  runtimeStatus(name: string, fingerprint: string): Promise<McpRuntimeSyncResult>;
  synchronize(name: string, fingerprint: string): Promise<McpRuntimeSyncResult>;
}
```

不得在 CLI/Desktop 复制裸 `fetch`。

- [ ] **步骤 6：运行 Server、Client 与公共 API 检查**

运行：`pnpm --filter @vykor/server exec vitest run src/http/routes/mcp.test.ts src/http/__test__/http.test.ts`

运行：`pnpm --filter @vykor/client exec vitest run src/resources/__test__/mcp-resource.test.ts src/__test__/public-api.test.ts`

运行：`pnpm check:client-api`

预期：全部 PASS。

- [ ] **步骤 7：提交控制面与 client**

```bash
git add packages/server/src/http/routes/mcp.ts packages/server/src/http/routes/mcp.test.ts packages/server/src/http/server.ts packages/server/src/http/__test__/http.test.ts packages/client/src/resources/mcp-resource.ts packages/client/src/resources/__test__/mcp-resource.test.ts packages/client/src/resources/index.ts packages/client/src/transport/http-client.ts packages/client/src/index.ts packages/client/src/__test__/public-api.test.ts
git commit -m "feat(client): add MCP runtime control resource"
```

## 任务 7：CLI `status` 与登录/退出同步闭环

**文件：**
- 创建：`apps/cli/src/mcp-runtime-coordinator.ts`
- 创建：`apps/cli/src/mcp-runtime-coordinator.test.ts`
- 修改：`apps/cli/src/commands/mcp.ts`
- 测试：`apps/cli/src/commands/mcp.test.ts`
- 修改：`apps/cli/package.json`（仅当现有 workspace bundle 未暴露 client 依赖时）

- [ ] **步骤 1：编写 CLI 失败测试**

覆盖 `status` 与 `get` 输出完全一致；人类输出包含 `auth-mode`、`auth-status`、`runtime`；JSON 包含稳定字段；daemon 缺席时返回 `unavailable` 且 login/logout 仍成功；同步 failures 非空时使用非零退出并保留正确凭据结果。

```ts
expect(JSON.parse(output)).toEqual({
  name: "linear",
  enabled: true,
  transport: "http",
  url: "https://mcp.linear.app/mcp",
  authMode: "oauth",
  authStatus: "valid",
  scopes: ["read"],
  runtimeStatus: "connected",
});
```

- [ ] **步骤 2：运行 CLI 测试确认失败**

运行：`pnpm --filter @rzx/ohs exec vitest run src/commands/mcp.test.ts src/mcp-runtime-coordinator.test.ts`

预期：FAIL，`status` 和 coordinator 尚不存在。

- [ ] **步骤 3：实现 daemon coordinator adapter**

复用 CLI 现有 daemon registry 与 `VykorClient` 构造路径。registry 文件不存在、进程不可达或连接被拒绝时返回：

```ts
{ status: "unavailable", affectedRuntimes: 0, failures: [] }
```

401、协议不兼容及 daemon 返回 5xx 必须作为同步失败抛出，不能伪装成离线。

- [ ] **步骤 4：统一 list/get/status 快照与输出**

删除 CLI 私有的 `describeServer()` 状态推导，改用 `buildMcpAuthServerSnapshot()`。`get` 与 `status` 注册为两个命令，但共同调用同一 handler；保留 `get` 且不输出弃用警告。

- [ ] **步骤 5：让 login/logout 使用应用服务语义**

CLI 默认依赖使用 `McpOAuthApplicationService` 或等价共享入口完成候选验证、提交与 `synchronize()`。同步失败时输出“授权已保存，Runtime 重连失败”或“凭据已删除，Runtime 断开失败”，并设置非零退出码；不得回滚已提交状态。

- [ ] **步骤 6：运行 CLI 测试和构建**

运行：`pnpm --filter @rzx/ohs exec vitest run src/commands/mcp.test.ts src/mcp-runtime-coordinator.test.ts`

运行：`pnpm --filter @rzx/ohs check-types`

运行：`pnpm --filter @rzx/ohs build`

预期：全部成功；构建产物能解析 `vk mcp status linear --json`。

- [ ] **步骤 7：提交 CLI 闭环**

```bash
git add apps/cli/src/mcp-runtime-coordinator.ts apps/cli/src/mcp-runtime-coordinator.test.ts apps/cli/src/commands/mcp.ts apps/cli/src/commands/mcp.test.ts apps/cli/package.json
git commit -m "feat(cli): complete MCP OAuth runtime workflow"
```

## 任务 8：Desktop 三类状态展示与最终验收

**文件：**
- 修改：`apps/desktop/src/shared/mcp-types.ts`
- 修改：`apps/desktop/src/main/features/mcp/mcp-service.ts`
- 测试：`apps/desktop/src/main/features/mcp/mcp-service.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/mcp-settings.tsx`
- 测试：`apps/desktop/src/renderer/src/components/desktop/settings-page/mcp-settings.test.tsx`
- 修改：`docs/superpowers/specs/2026-09-21-mcp-oauth-phase-1-completion-design.md`（仅在实现与已批准规格存在经确认的差异时）

- [ ] **步骤 1：编写 Desktop service 与 UI 失败测试**

验证 shared DTO 含 `authMode` 与 `runtimeStatus`；页面同时显示“OAuth / 已连接 / Runtime 已连接”；授权成功但同步失败时仍显示 OAuth 已登录并显示警告；`reauthentication-required` 的按钮文案为“重新授权”；静态认证不显示 OAuth 登录按钮。

- [ ] **步骤 2：运行 Desktop 定向测试确认失败**

运行：`pnpm --filter @vykor/desktop exec vitest run src/main/features/mcp/mcp-service.test.ts src/renderer/src/components/desktop/settings-page/mcp-settings.test.tsx`

预期：FAIL，shared DTO 与页面尚无三类状态。

- [ ] **步骤 3：让主进程传递统一快照**

`DesktopMcpService` 不再自行删减字段，完整复制 `McpAuthServerSnapshot` 的 `authMode`、`authStatus`、`scopes` 和 `runtimeStatus`。login/logout 等待应用服务同步结束再返回。

- [ ] **步骤 4：更新状态标签、按钮与警告**

分别建立 `authModeLabels`、`authStatusLabels`、`runtimeStatusLabels`。Runtime `error` 使用 destructive badge；`unavailable` 显示“状态不可用”，不把 OAuth 凭据标为无效。操作错误后重新拉取 snapshot，使“凭据已保存但同步失败”的事实仍能显示。

- [ ] **步骤 5：运行 Desktop 测试与类型检查**

运行：`pnpm --filter @vykor/desktop exec vitest run src/main/features/mcp/mcp-service.test.ts src/renderer/src/components/desktop/settings-page/mcp-settings.test.tsx`

运行：`pnpm --filter @vykor/desktop typecheck`

预期：全部 PASS。

- [ ] **步骤 6：运行第一阶段全量相关验证**

运行：`pnpm --filter @vykor/core test`

运行：`pnpm --filter @vykor/mcp test`

运行：`pnpm --filter @vykor/auth test`

运行：`pnpm --filter @vykor/agent-runtime test`

运行：`pnpm --filter @vykor/server test`

运行：`pnpm --filter @vykor/client test`

运行：`pnpm --filter @rzx/ohs test`

运行：`pnpm --filter @vykor/desktop test`

运行：`pnpm check-types`

运行：`pnpm check:client-api`

预期：所有命令成功；不得以忽略失败、更新无关快照或跳过并发测试的方式通过。

- [ ] **步骤 7：执行 CLI 人工验收**

使用测试 MCP 服务或 Linear 测试账号依次运行：

```powershell
vk mcp status linear --json
vk mcp login linear --scopes read
vk mcp status linear
vk mcp logout linear
vk mcp status linear --json
```

预期：登录前 `oauth/not-logged-in`；登录后 `oauth/valid` 且 daemon 有匹配 Runtime 时为 `connected`；退出后回到 `oauth/not-logged-in`，活动 Runtime 不再暴露该服务工具。Node 的 `punycode` deprecation warning 不属于本阶段验收失败。

- [ ] **步骤 8：提交 Desktop 与验收结果**

```bash
git add apps/desktop/src/shared/mcp-types.ts apps/desktop/src/main/features/mcp/mcp-service.ts apps/desktop/src/main/features/mcp/mcp-service.test.ts apps/desktop/src/renderer/src/components/desktop/settings-page/mcp-settings.tsx apps/desktop/src/renderer/src/components/desktop/settings-page/mcp-settings.test.tsx
git commit -m "feat(desktop): show MCP auth and runtime states"
```

## 完成标准

- `vk mcp get` 与 `vk mcp status` 返回同一稳定快照。
- CLI 与 Desktop 都能独立展示 `authMode`、`authStatus`、`runtimeStatus`。
- OAuth 候选 Token 在真实 MCP 验证前不会进入共享凭据文件。
- login/logout 后所有匹配的活动 Runtime 收敛到凭据仓库最终状态。
- 同名不同 endpoint 的 Runtime 不受影响，控制面日志不泄漏完整 endpoint query。
- 新 Run 只能看到完整旧 MCP 工具集合或完整新集合；已开始 Run 继续使用捕获的旧 definition。
- daemon 缺席不阻止登录或退出；daemon 认证、协议或 Runtime 同步错误被明确报告。
- 所有定向测试、包测试、类型检查和 client 公共 API 检查通过。
