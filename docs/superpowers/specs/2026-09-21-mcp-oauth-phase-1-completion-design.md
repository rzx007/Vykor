# MCP OAuth 第一阶段补全设计

**日期：** 2026-09-21  
**状态：** 已审查通过
**目标：** 在不破坏现有 MCP OAuth CLI 和 Desktop 能力的前提下，补齐状态命令、认证方式模型以及登录/退出后的活动连接同步，使第一阶段形成真正可用的闭环。

## 背景

OpenHarness 已经具备 Streamable HTTP OAuth 的主要协议能力：OAuth metadata discovery、PKCE、`127.0.0.1` callback、Dynamic Client Registration（DCR）、独立凭据文件、提前刷新、并发刷新锁、401 单次恢复、手动 callback URL 模式，以及 Desktop 授权入口。

当前缺口不在 OAuth 协议本身，而在宿主集成：

- CLI 通过 `mcp get` 查询单个服务，没有用户预期的 `mcp status` 命令。
- `authStatus` 同时承担“认证方式”和“凭据健康状态”，调用方无法稳定区分 OAuth、Bearer 与未认证连接。
- CLI 或 Desktop 登录后只创建临时连接验证凭据。已经启动但连接失败的 MCP Runtime 不会收到重连通知。
- 退出登录会删除凭据，但已运行 Runtime 可能继续保留旧连接，直到连接关闭或 Session 重建。

第一阶段补全只解决以上闭环问题，不扩大 OAuth 协议范围。

## 用户体验

### CLI

新增以下命令：

```bash
ohs mcp status <name>
ohs mcp status <name> --json
```

`status` 与现有 `get` 使用同一个查询实现和同一个输出 DTO。`get` 继续保留，不发出弃用警告，避免破坏现有脚本。

人类可读输出同时展示认证方式和凭据状态：

```text
linear
  transport: http
  auth-mode: oauth
  auth-status: valid
  endpoint: https://mcp.linear.app/mcp
  scopes: read
  runtime: connected
```

未登录的 OAuth 服务示例：

```text
linear
  transport: http
  auth-mode: oauth
  auth-status: not-logged-in
  endpoint: https://mcp.linear.app/mcp
  scopes: read
  runtime: disconnected
```

`--json` 返回稳定字段，但不返回 Token、client secret、Authorization Header 或完整 callback URL：

```json
{
  "name": "linear",
  "enabled": true,
  "transport": "http",
  "url": "https://mcp.linear.app/mcp",
  "authMode": "oauth",
  "authStatus": "valid",
  "scopes": ["read"],
  "runtimeStatus": "connected"
}
```

没有活动 Runtime 或本地 daemon 未运行时，`runtimeStatus` 为 `unavailable`。这不是登录失败，也不会把已经验证成功的凭据降级为无效。

### Desktop

Desktop 的 MCP 设置页继续使用“浏览器授权”“重新授权”“退出登录”三个动作。每个服务同时展示：

- 认证方式：OAuth、Bearer、未配置或自定义静态认证。
- 凭据状态：未登录、已连接、待刷新、需要重新登录、静态凭据或不支持 OAuth。
- Runtime 状态：已连接、连接失败、未运行或状态不可用。

登录成功后，页面等待 Runtime 同步结果再结束操作。如果凭据保存成功但 Runtime 重连失败，页面保留 OAuth 登录状态，同时显示“授权已保存，但 MCP 重连失败”。

退出登录后，页面先确认本地凭据已删除，再显示 Runtime 断开结果。远端撤销失败不阻止本地退出。

## 范围

### 包含

- `ohs mcp status <name> [--json]`。
- 独立的认证方式和凭据状态字段。
- CLI、Server 应用层和 Desktop 共用的无秘密快照 DTO。
- 登录完成后的 Runtime 重连通知。
- 退出登录后的 Runtime 断开通知。
- 活动 Runtime 不存在时的明确降级语义。
- staged connection 和 MCP Tool Registry 的原子替换。
- CLI、Server、Runtime 和 Desktop 的自动化测试。

### 不包含

- OS Keyring。
- SSE 或 stdio OAuth。
- 自定义完整 callback URL。
- 可配置 `oauth_resource`。
- 多账号、多租户或企业托管授权。
- 将 OAuth 登录流程整体迁入 App Server。
- 登录完成事件的持久化或跨设备分发。
- 修改活动 Run 已经捕获的 MCP Tool Definition。

## 状态模型

### 认证方式

新增稳定字段：

```ts
export type McpAuthMode = "none" | "oauth" | "bearer" | "custom";
```

解析规则按优先级执行：

1. HTTP 配置存在显式 `Authorization: Bearer ...`：`bearer`。
2. HTTP 配置存在非 Bearer 的显式 `Authorization`：`custom`。
3. HTTP 配置声明 `oauth`，或存在与 server name 和 URL 匹配的 OAuth 凭据：`oauth`。
4. 其他情况：`none`。

显式静态 Header 的优先级高于 OAuth 凭据，与当前 Transport 行为保持一致。凭据文件中残留 OAuth Token，但配置使用静态 Authorization 时，`authMode` 仍为 `bearer` 或 `custom`。

OAuth 登录验证成功后，把确认过的 scopes 写入 settings 的非敏感 `oauth.scopes`。因此 logout 删除 Token 后，服务仍保持 `authMode: "oauth"` 和 `authStatus: "not-logged-in"`，不会退回 `none`。该写入不保存 Token、client secret 或 callback URL。

### 凭据状态

继续使用现有 `McpOAuthAuthStatus`，不在本阶段重命名已有值：

```ts
export type McpOAuthAuthStatus =
  | "not-configured"
  | "not-logged-in"
  | "valid"
  | "expired-refreshable"
  | "reauthentication-required"
  | "static"
  | "unsupported";
```

`authMode` 回答“使用哪种认证”，`authStatus` 回答“凭据当前能否使用”。两者不能互相替代。

映射约束：

| `authMode` | `authStatus` | 含义 |
|---|---|---|
| `oauth` | `not-logged-in` | 服务配置为 OAuth，但没有匹配凭据 |
| `oauth` | `valid` | OAuth access token 在有效期内 |
| `oauth` | `expired-refreshable` | access token 已过期，可以使用 refresh token 恢复 |
| `oauth` | `reauthentication-required` | 必须重新浏览器授权 |
| `bearer` / `custom` | `static` | 使用 settings 中的静态 Authorization |
| `none` | `not-logged-in` | HTTP 服务没有可用认证配置 |
| `none` | `unsupported` | stdio 或 SSE 不支持本阶段 OAuth |

### Runtime 状态

新增只读字段：

```ts
export type McpRuntimeStatus =
  | "connected"
  | "disconnected"
  | "error"
  | "unavailable";
```

它只描述活动 Runtime，不写入 OAuth 凭据文件。聚合前必须先按下述 server identity 筛选参与者；不包含该服务的 Runtime 不参与统计，`affectedRuntimes` 只计算参与者。零参与者返回 `unavailable`；任一参与者为 `error` 则整体为 `error`；否则全部参与者为 `connected` 时返回 `connected`；其余情况返回 `disconnected`。Runtime 内部的 `initializing` 状态对外映射为 `disconnected`。

## Server identity

Runtime 协调不能只使用 server name。daemon 会按 Session cwd 加载项目设置，不同项目可能使用同一个名称连接不同 MCP endpoint。

第一阶段定义：

```ts
export interface McpServerIdentity {
  name: string;
  transport: "http";
  endpoint: string;
  endpointFingerprint: string;
}
```

`endpoint` 是规范化 URL：移除 fragment，保留会影响资源身份的 path 和 query，主机名转为 URL 标准形式，默认端口由 `URL` 规范化规则消除。用户名和密码在更早的配置校验阶段被拒绝，不能进入 identity。`endpointFingerprint` 是规范化 endpoint 的 SHA-256 base64url 摘要，用于跨进程线协议匹配；完整 endpoint 不进入控制面 URL、请求日志或响应。

参与者筛选规则：

| Runtime 配置 | 是否参与 |
|---|---|
| name、transport、规范化 endpoint 全部相同 | 是 |
| name 相同、endpoint 不同 | 否 |
| endpoint 相同、name 不同 | 否 |
| stdio 或 SSE | 否 |
| Runtime 不包含该 server | 否 |

协调器只把 identity 发送给 Runtime handle。每个 handle 必须使用自己加载的 `McpServerConfig` 重连，不能把调用方项目的 config 广播到其他 Session。

## 架构

```text
CLI / Desktop
    │
    ▼
McpOAuthApplicationService
    ├── OAuth login / revoke / snapshot
    └── McpRuntimeConnectionCoordinator
            │
            ▼
      active Runtime registry
            │
            ▼
      McpClientManager prepare/activate/disconnect
            │
            ▼
      Tool Registry replace/remove
```

### 应用服务

`McpOAuthApplicationService` 继续作为登录、退出和快照的唯一业务入口。它新增可注入依赖：

```ts
export interface McpRuntimeConnectionCoordinator {
  getStatus(identity: McpServerIdentity): Promise<McpRuntimeSyncResult>;
  synchronize(identity: McpServerIdentity): Promise<McpRuntimeSyncResult>;
}

export interface McpRuntimeSyncResult {
  status: McpRuntimeStatus;
  affectedRuntimes: number;
  failures: Array<{ runtimeId: string; message: string }>;
}
```

未注入 coordinator 时使用只返回 `unavailable` 的空实现。OAuth 协议层和凭据仓库不依赖 Runtime。

共享 DTO 类型 `McpAuthMode`、`McpRuntimeStatus`、`McpServerIdentity`、`McpAuthServerSnapshot` 和 `McpRuntimeSyncResult` 放在 `packages/core`，保持为纯数据类型。`packages/mcp` 提供唯一的无秘密认证快照构造函数，输入 server config、匹配凭据和可选 Runtime 状态，输出 `McpAuthServerSnapshot`。CLI 和 Server 应用层都调用该函数，不各自复制认证方式或凭据状态计算。Server 应用层只负责编排 store、coordinator 和快照构造函数。

### Runtime 协调

每个 Session Runtime 继续拥有自己的 `McpClientManager` 和 Tool Registry。宿主增加进程内 Runtime registry，登记以下窄能力：

```ts
export interface ActiveMcpRuntimeHandle {
  runtimeId: string;
  identity(name: string): McpServerIdentity | undefined;
  synchronize(identity: McpServerIdentity, generation: number): Promise<void>;
  getStatus(identity: McpServerIdentity): McpRuntimeStatus;
}
```

Runtime 在开始连接 MCP 之前以 `initializing` 状态登记 handle，清理时注销。协调器先按 identity 筛选参与者，再使用 `Promise.allSettled()`；单个 Session 失败不阻止其他 Session 同步。

daemon coordinator 为每个 server identity 维护单调递增的进程内 generation，并按 identity 串行化 `synchronize`。每次同步先递增 generation，再读取 OAuth credential store 的最终状态。Runtime handle 在连接前后都核对 generation：

1. 登记时读取当前 generation。
2. staged connection 建立前再次核对；generation 已变化则放弃本次初始化。
3. staged connection 建立后、发布工具前再次核对；generation 已变化则立即关闭 staged client，不发布工具。
4. logout 触发的同步会递增 generation，使同步前后所有使用旧 generation 的在建连接失效。
5. 同步等待当时已经登记的匹配 handles 完成处理；同步期间新登记的 handle 会读取新 generation 和最新凭据状态，因此不会使用已删除的 Token 建立可见连接。

CLI/Desktop 的 login 和 logout 即使并发或跨进程发生，也只发送同一个幂等 `synchronize(identity)` 请求。daemon 不信任请求携带的“登录”或“退出”意图，而是在持有 identity 串行锁后重新读取最终凭据：存在可用且绑定匹配的 OAuth 凭据则重连；不存在凭据或凭据要求重新授权则断开。通知乱序不会覆盖最终凭据状态。

重连一个 Runtime 时按以下顺序执行：

1. handle 使用自己的匹配 config 调用 `McpClientManager.prepareConnection(name, config)`，建立未发布的 staged client/transport 并完成 tools/resources discovery。
2. 准备失败时关闭 staged 资源，保留旧连接和旧 Tool Registry，不产生半完成状态。
3. 准备成功且 generation 未变化时，调用同步方法 `activatePreparedConnection(prepared, commitTools)`。该方法在同一个无 `await` 临界区内先把 staged client/transport 设为 manager 当前连接，再调用 `commitTools`，由 Tool Registry 的 `replaceBySource({ kind: "mcp", id: name }, definitions)` 一次性替换该 server 的完整工具集合。若 Registry 提交抛错，manager 在同一临界区恢复旧连接指针，并把 staged 资源作为待清理结果返回。
4. 激活临界区返回后再异步关闭旧 client/transport。
5. Registry 提交失败时同样在离开临界区后异步关闭返回的 staged client/transport，临界区内部不执行任何异步清理。
6. 关闭旧连接失败时仍保留新连接和新 Registry，并向 coordinator 返回脱敏错误。

`status` 始终描述提交后的当前连接状态，`failures` 描述本次同步过程中发生的问题。新连接和新 Registry 已经启用、但旧连接关闭失败时，结果为 `status: "connected"` 且 `failures` 非空；CLI 仍使用非零退出码提示资源清理失败，Desktop 显示连接可用并附带警告，不能把当前连接误报为 `error`。

`ToolRegistry.replaceBySource()` 先复制当前 Map，在副本中删除匹配 source、验证所有新名称不与其他 source 冲突，再用一次 Map 引用替换提交。验证失败时原 Map 不变。manager 当前连接指针切换与 Map 引用替换之间禁止出现 `await`、事件派发或用户回调；JavaScript 执行栈内不会插入新的 Run capability view。Run 只能同时看到旧连接与旧集合，或新连接与新集合。

断开时先用 `replaceBySource(source, [])` 原子移除新 Run 可见的工具，再关闭 client/transport。`McpClientManager.disconnect()` 必须在 `finally` 中清理本地 maps，同时把 `client.close()` 的脱敏错误返回给 coordinator，不能继续吞掉异常。

活动 Run 已捕获的 Tool Definition 不替换、不重定向到新 client。重连只影响重连完成后新开始的 Run。这样可以避免一个进行中的 Tool 调用被透明切换到另一条连接。

### 跨进程通知

CLI 和 Desktop 可能与 daemon 运行在不同进程。第一阶段补全复用现有 daemon HTTP 控制面，增加一个只读状态操作和一个幂等同步操作：

```text
GET  /mcp/:name/runtime-status?fingerprint=<sha256-base64url>
POST /mcp/:name/synchronize
```

`synchronize` 请求体只携带 endpoint fingerprint，不携带完整 endpoint、Token 或操作意图。daemon 对各 Runtime 自身的规范化 endpoint 计算相同摘要后匹配，并从自己的 settings 和 OAuth credential store 读取最终状态。两个响应都只返回 `McpRuntimeSyncResult`。

这两个路由继承现有 daemon 网络模型：调用方必须携带 daemon registry 中的 Bearer Token 和协议版本 Header；daemon 可能按用户配置绑定非 loopback 地址，因此规格不承诺请求一定来自本机 peer。CLI 和 Desktop 必须通过 `@openharness/client` 新增的资源方法调用，不能手写裸 `fetch` 或自行解析 registry Token。

CLI 的默认 coordinator 行为：

1. 尝试通过现有 daemon registry 和 `@openharness/client` 调用控制面。
2. daemon 可用时等待同步结果。
3. daemon 未运行时返回 `unavailable`，不启动 daemon，也不把登录判为失败。
4. daemon 返回认证或协议错误时，将其作为 Runtime 同步失败报告，但不删除已经保存的 OAuth 凭据。

Desktop 通过现有主进程服务调用同一控制面，不直接持有 Session Runtime。

这两个端点只是 Runtime 状态和连接同步接口，不接受授权码、不打开浏览器、不执行 OAuth discovery，因此不构成第三阶段的完整 App Server 登录接口。

## 登录流程

1. 执行现有 discovery、PKCE、callback、Token exchange 和 scope 校验，生成尚未发布的候选凭据。
2. 候选凭据只保存在本次操作的内存中，不写入共享 credential store。使用绑定该候选凭据的操作内可写内存 store 和一次性 `McpOAuthRuntime` 创建 MCP Client，执行 `initialize` 和 `tools/list`。该 store 实现 `update/runExclusive`，允许验证期的单次 401 刷新和 refresh token 轮换，但所有变化只留在本次操作内存中。
3. 验证期间，活动 Runtime 继续读取共享 store 中的原凭据，绝不能看到候选 Token。
4. 验证失败时只撤销内存中的候选 Token；不修改共享凭据、settings 或 Runtime。命令返回 `oauth-login-verification-failed`。
5. 验证成功后，从操作内存 store 读取最终验证过的候选凭据；后续提交使用刷新后的 access token、refresh token、到期时间和 scopes，而不是最初 Token exchange 的快照。
6. 通过 credential store 的单次 `runExclusive()` 进入按 server 的跨进程提交区。在锁内重新加载最新 settings，只 patch 目标 server 的 `oauth.scopes`，保存成功后返回最终候选凭据作为该次 credential 更新。不能保存登录开始前读取的完整 settings 快照。
7. settings 写入或 credential 提交失败时命令失败，共享旧凭据不提前删除；如果 settings 已写入但 credential 文件最终替换失败，快照在存在旧凭据时仍以旧凭据 scopes 为准，并报告登录提交失败。下一次成功登录或 logout 兼容回填会重新对齐 settings。
8. 调用 coordinator 的 `synchronize(identity)`；daemon 根据共享 store 的最终凭据状态执行重连。
9. 所有参与 Runtime 同步成功：命令成功，返回最新快照。
10. 没有参与 Runtime：命令成功，快照的 `runtimeStatus` 为 `unavailable`。
11. 部分或全部 Runtime 重连失败：保留已验证凭据，命令返回失败，并明确说明“授权已保存，Runtime 重连失败”。调用方可以再次执行 `mcp status` 或重新触发同步，不需要重新授权。

两次并发重新授权各自持有独立候选凭据。失败操作只撤销自己的候选 Token，不执行共享 store 回滚，因此不会删除或覆盖另一个操作已经提交的凭据。两个验证都成功时，共享 credential lock 同时串行化最新 settings patch 和 credential 提交；最后离开提交区的操作同时决定最终 `oauth.scopes` 和最终凭据。每次随后发出的幂等 synchronize 都重新读取该最终状态。

重连失败不回滚 OAuth 凭据，因为 Token 已经由真实 MCP 临时连接验证通过，失败可能来自 Session Tool Registry、Runtime 生命周期或临时资源问题。回滚会迫使用户重复授权，且无法恢复远端已经签发的 Token 状态。

## 退出流程

1. 对升级前已经登录但 settings 尚无 `oauth` 标记的服务，尽力把凭据中的非敏感 scopes 写入 `oauth.scopes`；写入失败记录警告，但不能阻止 logout。
2. 尽力撤销 refresh token 和 access token。
3. 无论远端撤销是否成功，都删除本地 OAuth 凭据。
4. 调用 coordinator 的 `synchronize(identity)`；daemon 重新读取凭据为空后，关闭所有匹配 Runtime 中该 server 的 client/transport，并原子移除该 server 的 Tool Definition。
5. 没有活动 Runtime 时正常成功。
6. 某些 Runtime 断开失败时继续处理其余 Runtime，并返回失败明细；本地凭据不恢复。
7. 返回最新快照，`authMode` 根据非敏感配置重新计算，`authStatus` 回到 `not-logged-in` 或 `static`。

进入撤销和删除阶段后的安全原则是“凭据删除优先”。不能为了维持 Runtime 表面一致性而恢复已经删除的 Token。

## 错误处理

错误分成四个阶段：

- `oauth-login-failed`：discovery、callback、Token exchange 或 scope 校验失败，没有新凭据生效。
- `oauth-login-verification-failed`：Token exchange 成功，但临时 MCP `initialize`/`tools/list` 验证失败；内存候选 Token 已尽力撤销，共享凭据从未被候选值覆盖。
- `oauth-saved-runtime-sync-failed`：凭据已经保存，但活动 Runtime 同步失败。
- `oauth-removed-runtime-sync-failed`：本地凭据已经删除，但部分活动 Runtime 清理失败。

错误对象可以携带 server name、Runtime 失败数量和脱敏后的错误摘要，不得携带 Token、Authorization Header、授权码、PKCE verifier、client secret 或 callback 查询参数。

CLI 对后两类错误使用非零退出码，并保留可操作提示：

```text
OAuth authorization was saved for linear, but 1 active runtime failed to reconnect.
Run `ohs mcp status linear` for the current state.
```

Desktop 保留最新快照并显示错误，不把成功保存的授权错误地回退为“未登录”。

## 兼容性

- `mcp get` 和 `mcp list` 保留原字段；只新增 `authMode` 和 `runtimeStatus`。
- `authStatus` 继续使用现有连字符值，避免破坏 CLI JSON、Desktop 类型和已有测试。
- `mcp status` 是 `get` 的别名，不另建业务实现。
- settings 和 `mcp-oauth.json` 文件结构不迁移。
- OAuth Token 的优先级不超过显式静态 Authorization Header。
- 不自动启动 daemon，不把 daemon 缺席视为登录或退出失败。

## 操作状态表

| 阶段 | 新凭据 | settings OAuth 标记 | Runtime 同步 | 命令结果 |
|---|---|---|---|---|
| discovery / callback / Token exchange 失败 | 不保存 | 不修改 | 不执行 | 失败 |
| 候选 Token 已签发，临时 MCP 验证失败 | 候选只在内存中，尽力撤销；共享凭据不变 | 不修改 | 不执行 | 失败 |
| 临时验证成功，提交区内 settings 写入失败 | 候选只在内存中，尽力撤销；共享凭据不变 | 保持旧值 | 不执行 | 失败 |
| settings 写入成功，凭据文件最终替换失败 | 共享旧凭据不提前删除 | 可能已写入新 `oauth.scopes` | 不执行 | 失败；快照以旧凭据 scopes 为准 |
| 凭据和 settings 成功，无参与 Runtime | 保留 | 写入 `oauth.scopes` | 返回 `unavailable` | 成功 |
| 凭据和 settings 成功，Runtime 重连成功 | 保留 | 写入 `oauth.scopes` | 返回 `connected` | 成功 |
| 凭据和 settings 成功，Runtime 重连失败 | 保留 | 写入 `oauth.scopes` | 返回 `error` 和失败列表 | 失败，提示无需重新授权 |
| logout 远端撤销失败 | 删除 | 保留 `oauth.scopes` | 按最终无凭据状态断开 | Runtime 同步成功则成功 |
| 旧版本 OAuth 标记回填失败 | 继续撤销并删除 | 可能缺少 `oauth.scopes` | 按最终无凭据状态断开 | 成功并输出警告 |
| logout Runtime 断开失败 | 已删除 | 保留 `oauth.scopes` | 返回 `error` 和失败列表 | 失败，不恢复 Token |

## 并发状态迁移

| 当前事件 | generation 行为 | Runtime 行为 |
|---|---|---|
| Runtime 开始创建 | 读取 identity 当前 generation 并以 `initializing` 登记 | 连接前后均复核 generation |
| login 完成并请求同步 | identity generation 加 1 | 读取最终凭据；匹配 handles staged 重连 |
| logout 删除凭据并请求同步 | identity generation 加 1 | 读取最终无凭据状态；匹配 handles 断开 |
| 旧 staged connection 在 generation 变化后完成 | 不提交 | 立即关闭 staged 资源，不发布工具 |
| 同步期间出现新 Runtime | 使用最新 generation | 根据最新凭据连接或保持断开 |
| login/logout 通知乱序 | 每次同步都重读最终凭据 | 最终状态收敛到 credential store，而不是请求意图 |

## 测试策略

### Core 与 MCP

- 认证方式解析覆盖 OAuth、Bearer、自定义 Authorization、无认证和静态 Header 优先级。
- 状态解析继续覆盖未登录、有效、可刷新、需要重新授权和不支持 OAuth。
- 快照和错误序列化不包含任何敏感字段。

### Runtime

- Runtime handle 创建时登记、清理时注销。
- 同一个 server 重连时只原子替换该 server 的工具。
- 活动 Run 捕获的旧 Tool Definition 不会重定向到新 client。
- 一个 Runtime 重连失败不阻止其他 Runtime。
- disconnect 原子移除对应工具，在清理本地 maps 后报告 close 错误。
- coordinator 返回准确的 `affectedRuntimes` 和失败列表。
- 跨项目同名不同 URL 的 Runtime 不参与同步。
- Runtime 创建与 logout 并发时，旧 generation 连接不会发布工具。
- 跨进程 login/logout 通知乱序时，Runtime 收敛到凭据仓库最终状态。
- Registry 替换期间创建的新 Run 只能看到完整旧集合或完整新集合。
- 候选凭据验证期间，活动 Runtime 继续使用共享 store 的旧凭据。
- 两次并发重新授权中一个失败时，失败操作不会回滚另一个操作提交的凭据。
- 两次 scopes 不同的并发重新授权都成功时，最终凭据 scopes 与 settings `oauth.scopes` 来自同一个最后提交者。
- manager 指针与 Registry Map 在无 `await` 临界区切换；提交边界上创建并调用的新 Run 使用一致的新连接与工具定义。

### Server 控制面

- runtime-status/synchronize 复用现有 Bearer 与协议版本校验。
- 请求和响应均不携带 Token。
- daemon 无活动 Runtime 时返回 `unavailable`，而不是 404 或 500。
- 非法 server name、未配置 server 和连接错误返回稳定错误。
- GET 状态接口无副作用，并按 identity 只聚合匹配参与者。
- 控制面只传 endpoint fingerprint，完整 endpoint 及其 query 不进入访问日志。

### CLI

- `status` 与 `get` 的文本和 JSON 数据一致。
- `get/list/status --json` 同时返回 `authMode`、`authStatus` 和 `runtimeStatus`。
- daemon 未运行时登录仍成功，并显示 Runtime 状态不可用。
- 凭据保存后重连失败时使用非零退出码，且不删除凭据。
- logout 删除凭据后，即使 Runtime 断开失败也不会恢复凭据。
- status 通过 `@openharness/client` 的只读资源方法获取 daemon Runtime 状态。

### Desktop

- OAuth、Bearer、未配置和自定义认证方式展示正确。
- 未登录、有效、待刷新和需要重新授权状态展示正确。
- 授权成功但重连失败时同时显示已保存状态和错误。
- 退出登录后立即移除可用工具，并更新状态。

每项行为先编写失败测试，再实现最少代码使其通过。

## 验收标准

### CLI 登录

```bash
ohs mcp login linear --scopes read
ohs mcp status linear --json
```

满足以下条件：

1. OAuth 凭据写入独立凭据文件。
2. 临时 MCP 验证完成 `initialize` 和 `tools/list`。
3. daemon 已运行且存在活动 Runtime 时，所有可同步 Runtime 收到重连请求。
4. 新 Run 可以使用重连后注册的 Linear 工具。
5. JSON 返回 `authMode: "oauth"`、`authStatus: "valid"` 和真实 `runtimeStatus`。

### CLI 退出

```bash
ohs mcp logout linear
ohs mcp status linear --json
```

满足以下条件：

1. 本地 Token 已删除。
2. 活动 Runtime 的 Linear 连接被关闭，工具从 Registry 移除。
3. JSON 不再返回可用 OAuth 状态。
4. 远端撤销失败不会恢复本地 Token。

### Desktop

1. MCP 设置页可以区分 OAuth 与 Bearer。
2. 授权和退出操作完成后，页面展示新的凭据状态与 Runtime 状态。
3. 操作过程中和错误信息中不出现任何 OAuth secret。

## 后续阶段边界

配置 scope 变化的按需拦截已实现。2026-09-21 用户决定将“刷新错误分类”和“resource URL 绑定校验”移入第三阶段，与 OS Keyring、文件降级、可配置 resource/callback、App Server 登录接口和完成事件一起设计。该调整是范围迁移，不代表这两项已经完成。第三阶段详见 [设计文档](2026-09-21-mcp-oauth-phase-3-design.md)。
