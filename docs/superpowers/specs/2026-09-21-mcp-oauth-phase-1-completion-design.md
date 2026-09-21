# MCP OAuth 第一阶段补全设计

**日期：** 2026-09-21  
**状态：** 已确认，待用户审查  
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
- 重连后 MCP Tool Registry 的原子替换。
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

它只描述活动 Runtime，不写入 OAuth 凭据文件。没有 daemon、没有已创建的 Runtime，或宿主无法提供连接状态时返回 `unavailable`。存在多个 Runtime 时按以下顺序聚合：任一 Runtime 为 `error` 则整体为 `error`；否则全部已连接时为 `connected`；其余情况为 `disconnected`。

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
      McpClientManager reconnect/disconnect
            │
            ▼
      Tool Registry replace/remove
```

### 应用服务

`McpOAuthApplicationService` 继续作为登录、退出和快照的唯一业务入口。它新增可注入依赖：

```ts
export interface McpRuntimeConnectionCoordinator {
  getStatus(name: string): Promise<McpRuntimeStatus>;
  reconnect(name: string, config: McpServerConfig): Promise<McpRuntimeSyncResult>;
  disconnect(name: string): Promise<McpRuntimeSyncResult>;
}

export interface McpRuntimeSyncResult {
  status: McpRuntimeStatus;
  affectedRuntimes: number;
  failures: Array<{ runtimeId: string; message: string }>;
}
```

未注入 coordinator 时使用只返回 `unavailable` 的空实现。OAuth 协议层和凭据仓库不依赖 Runtime。

### Runtime 协调

每个 Session Runtime 继续拥有自己的 `McpClientManager` 和 Tool Registry。宿主增加进程内 Runtime registry，登记以下窄能力：

```ts
export interface ActiveMcpRuntimeHandle {
  runtimeId: string;
  reconnect(name: string, config: McpServerConfig): Promise<void>;
  disconnect(name: string): Promise<void>;
  getStatus(name: string): McpRuntimeStatus;
}
```

Runtime 创建完成后登记 handle，清理时注销。协调器对当前登记的 handles 使用 `Promise.allSettled()`，单个 Session 失败不阻止其他 Session 同步。

重连一个 Runtime 时按以下顺序执行：

1. 从 Tool Registry 移除该 server 的工具。
2. 调用 `McpClientManager.reconnect(name, config)`。
3. 连接成功后注册新工具。
4. 连接失败时不恢复绑定旧 client 的 Tool Definition，避免 Registry 暴露已经不可调用的工具。
5. 将 Runtime 状态记录为 `error`，并返回具体错误。

活动 Run 已捕获的 Tool Definition 不替换、不重定向到新 client。重连只影响重连完成后新开始的 Run。这样可以避免一个进行中的 Tool 调用被透明切换到另一条连接。

### 跨进程通知

CLI 和 Desktop 可能与 daemon 运行在不同进程。第一阶段补全复用现有本地 daemon HTTP 控制面，增加两个只接受本机认证客户端调用的窄操作：

```text
POST /mcp/:name/reconnect
POST /mcp/:name/disconnect
```

请求体不携带 Token。daemon 从自己的 settings 和 OAuth credential store 读取最新状态。响应只返回 `McpRuntimeSyncResult`。

CLI 的默认 coordinator 行为：

1. 尝试调用本地 daemon 控制面。
2. daemon 可用时等待同步结果。
3. daemon 未运行时返回 `unavailable`，不启动 daemon，也不把登录判为失败。
4. daemon 返回认证或协议错误时，将其作为 Runtime 同步失败报告，但不删除已经保存的 OAuth 凭据。

Desktop 通过现有主进程服务调用同一控制面，不直接持有 Session Runtime。

这两个端点只是连接同步接口，不接受授权码、不打开浏览器、不执行 OAuth discovery，因此不构成第三阶段的完整 App Server 登录接口。

## 登录流程

1. 执行现有 discovery、PKCE、callback、Token exchange 和 scope 校验。
2. 将 OAuth 凭据安全写入独立凭据仓库。
3. 使用一次性 MCP Client 执行 `initialize` 和 `tools/list`，验证新凭据。
4. 验证成功后调用 coordinator 的 `reconnect(name, config)`。
5. 所有活动 Runtime 同步成功：命令成功，返回最新快照。
6. 没有活动 Runtime：命令成功，快照的 `runtimeStatus` 为 `unavailable`。
7. 部分或全部 Runtime 重连失败：保留凭据，命令返回失败，并明确说明“授权已保存，Runtime 重连失败”。调用方可以再次执行 `mcp status` 或重新触发重连，不需要重新授权。

重连失败不回滚 OAuth 凭据，因为 Token 已经由真实 MCP 临时连接验证通过，失败可能来自 Session Tool Registry、Runtime 生命周期或临时资源问题。回滚会迫使用户重复授权，且无法恢复远端已经签发的 Token 状态。

## 退出流程

1. 尽力撤销 refresh token 和 access token。
2. 无论远端撤销是否成功，都删除本地 OAuth 凭据。
3. 调用 coordinator 的 `disconnect(name)`，关闭所有活动 Runtime 中该 server 的 client/transport，并移除该 server 的 Tool Definition。
4. 没有活动 Runtime 时正常成功。
5. 某些 Runtime 断开失败时继续处理其余 Runtime，并返回失败明细；本地凭据不恢复。
6. 返回最新快照，`authMode` 根据非敏感配置重新计算，`authStatus` 回到 `not-logged-in` 或 `static`。

退出后的安全原则是“凭据删除优先”。不能为了维持 Runtime 表面一致性而恢复已经删除的 Token。

## 错误处理

错误分成三个阶段：

- `oauth-login-failed`：OAuth 流程或临时 MCP 验证失败，凭据未保存或已标记为需要重新授权。
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

## 测试策略

### Core 与 MCP

- 认证方式解析覆盖 OAuth、Bearer、自定义 Authorization、无认证和静态 Header 优先级。
- 状态解析继续覆盖未登录、有效、可刷新、需要重新授权和不支持 OAuth。
- 快照和错误序列化不包含任何敏感字段。

### Runtime

- Runtime handle 创建时登记、清理时注销。
- 同一个 server 重连时只替换该 server 的工具。
- 活动 Run 捕获的旧 Tool Definition 不会重定向到新 client。
- 一个 Runtime 重连失败不阻止其他 Runtime。
- disconnect 关闭 client/transport 并移除对应工具。
- coordinator 返回准确的 `affectedRuntimes` 和失败列表。

### Server 控制面

- reconnect/disconnect 只接受本机认证请求。
- 请求和响应均不携带 Token。
- daemon 无活动 Runtime 时返回 `unavailable`，而不是 404 或 500。
- 非法 server name、未配置 server 和连接错误返回稳定错误。

### CLI

- `status` 与 `get` 的文本和 JSON 数据一致。
- `get/list/status --json` 同时返回 `authMode`、`authStatus` 和 `runtimeStatus`。
- daemon 未运行时登录仍成功，并显示 Runtime 状态不可用。
- 凭据保存后重连失败时使用非零退出码，且不删除凭据。
- logout 删除凭据后，即使 Runtime 断开失败也不会恢复凭据。

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

完成本设计后，第二阶段仅剩“配置 scope 变化主动进入重新授权状态”的补全工作。第三阶段继续独立设计 OS Keyring、文件降级策略、可配置 `oauth_resource`、完整自定义 callback，以及 App Server 登录接口和完成事件。
