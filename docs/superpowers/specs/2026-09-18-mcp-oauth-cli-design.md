# MCP OAuth CLI 闭环设计

**日期：** 2026-09-18  
**状态：** 已确认，待实现计划  
**目标：** 为 Streamable HTTP MCP Server 提供与 Codex CLI 主要命令兼容的 OAuth 登录、持久化、刷新、状态查询和退出闭环。

## 背景

OpenHarness 当前支持 stdio、Streamable HTTP 和 SSE MCP 连接，也能通过静态 Bearer、自定义 Header 或 stdio 环境变量配置鉴权。现有 `McpAuth` 会把静态凭据写入 settings 并重连，但不包含浏览器授权、PKCE、动态客户端注册、OAuth Token 独立存储、自动刷新或重新授权状态。

本阶段补齐 CLI 可用闭环。Desktop 暂不增加授权界面，但后续可以复用本阶段形成的 OAuth 服务和状态模型。

## 用户体验和 Codex 兼容边界

命令名称、主要参数和用途对齐当前 Codex CLI：

```bash
ohs mcp add linear --url https://mcp.linear.app/mcp
ohs mcp login linear --scopes read
ohs mcp get linear
ohs mcp get linear --json
ohs mcp list
ohs mcp list --json
ohs mcp logout linear
ohs mcp remove linear
```

`add` 同时支持两种互斥形式：

```bash
# Streamable HTTP
ohs mcp add <name> --url <url>

# stdio
ohs mcp add <name> -- <command> [args...]
```

本阶段实现 Codex 命令面的兼容子集，不实现 Codex 的全局 `-c/--config`、feature flags、CIMD 或企业托管登录。OpenHarness 可以继续使用自己的 settings 文件结构，但相同命令应具有相同的主要语义。

不新增独立的 `status` 子命令。授权状态由 `list` 和 `get` 返回，避免形成与 Codex 不同的平行命令面。

## 范围

### 包含

- Streamable HTTP MCP OAuth。
- OAuth Protected Resource 与 Authorization Server metadata discovery。
- Authorization Code + PKCE。
- Dynamic Client Registration（DCR）。
- 本机浏览器授权和 `127.0.0.1` 临时 callback。
- OAuth Token 与动态注册客户端凭据的独立持久化。
- 连接前刷新、一次 401 恢复和重新授权状态。
- 登录成功后的 MCP 重连。
- CLI `add/get/list/login/logout/remove` 闭环。
- 本地模拟 OAuth/MCP 服务的自动化测试。
- Linear MCP 的人工只读验收。

### 不包含

- Desktop 授权界面。
- OS keyring。
- 同一 server name 的多账号或多工作区。
- Enterprise Managed Authorization。
- CIMD。
- 自定义远程 callback URL。
- SSE OAuth。
- stdio OAuth。
- CI 中访问真实 Linear 服务。

## 架构

```text
ohs mcp login <name>
        │
        ▼
McpOAuthService
  discovery → PKCE → DCR → browser → callback → token exchange
        │
        ▼
McpOAuthCredentialStore
  $OPENHARNESS_CONFIG_DIR/mcp-oauth.json
        │
        ▼
McpClientManager
  load/refresh token → Authorization header → connect/reconnect
```

职责边界：

- `packages/mcp`：MCP OAuth 协议流程、Token 刷新、认证状态和 HTTP Transport 注入。优先复用 `@modelcontextprotocol/sdk` 的 OAuth provider/transport 能力，不自行重写 SDK 已实现的协议细节。
- `packages/auth`：`mcp-oauth.json` 的读取、原子写入、权限限制和删除。它只负责持久化，不包含网络协议。
- `packages/core`：共享的 MCP 配置、OAuth 状态和服务接口类型。
- `apps/cli`：命令解析、浏览器打开、交互提示和退出码。
- `packages/agent-runtime`：把 OAuth 服务和现有 MCP manager 接到 session runtime；现有静态 `McpAuth` 保持兼容。

## 配置模型

远程 MCP 配置增加非敏感 OAuth 选项：

```ts
export interface McpRemoteServerConfig {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  oauth?: {
    scopes?: string[];
    clientId?: string;
    callbackPort?: number;
  };
}
```

`login --scopes` 是本次登录的显式输入，并覆盖配置中的 `oauth.scopes`。若显式登录成功，实际授权 scope 与 Token 一起持久化；不会静默扩大到未请求的权限。

当配置里存在显式 `Authorization` Header 时，静态鉴权优先，普通连接不会自动改用 OAuth。用户显式执行 `mcp login` 时，如果静态 Authorization 会遮蔽 OAuth，CLI 应清楚报错并要求先移除冲突配置。

## 凭据存储

OAuth 凭据保存到：

```text
$OPENHARNESS_CONFIG_DIR/mcp-oauth.json
```

未设置 `OPENHARNESS_CONFIG_DIR` 时沿用 OpenHarness 当前默认配置目录。文件使用版本化结构：

```json
{
  "version": 1,
  "servers": {
    "linear": {
      "serverUrl": "https://mcp.linear.app/mcp",
      "issuer": "https://example-issuer.invalid",
      "clientId": "registered-client-id",
      "clientSecret": "registered-client-secret-if-issued",
      "accessToken": "access-token",
      "refreshToken": "refresh-token-if-issued",
      "tokenType": "Bearer",
      "scope": ["read"],
      "expiresAt": 1790000000000
    }
  }
}
```

要求：

- settings 只保存 URL、scope、预注册 client ID 等非 Token 配置。
- 写入采用同目录临时文件后 rename，避免进程中断留下半个 JSON。
- POSIX 上目录和文件分别限制为当前用户可访问，凭据文件权限为 `0600`。
- Windows 首版依赖用户配置目录的 ACL，不额外引入原生 keyring 依赖。
- JSON 解析失败必须报出可操作错误，不能当成空仓库覆盖原文件。
- 所有日志和错误信息禁止输出 access token、refresh token、授权码、PKCE verifier 或 client secret。
- 每个 server name 只保存一份凭据。server URL 变化时旧凭据不得用于新 URL。

## 登录流程

1. CLI 加载 server 配置并确认其 transport 为 `http`。
2. 拒绝 URL 中的用户名、密码或 fragment，并要求 HTTP(S) URL。
3. 对 MCP endpoint 执行 OAuth discovery，解析 protected resource、authorization server、授权端点、Token 端点、注册端点和可用 scopes。
4. scope 优先级为：本次 `--scopes`、配置 `oauth.scopes`、服务发现值、空集合。
5. 使用配置的预注册 client ID；否则通过 DCR 注册 public client。DCR 返回的 client secret 若存在，也按敏感凭据处理。
6. 生成随机 `state`、PKCE verifier 和 S256 challenge。
7. 只在 `127.0.0.1` 启动临时 HTTP callback。端口默认由操作系统分配，也可使用 server 配置的 `callbackPort`。
8. 尝试打开系统浏览器；打开失败时打印可复制的授权 URL，并继续等待 callback。
9. callback 必须校验 state；存在 issuer 参数或 metadata 绑定时同时校验 issuer。
10. 使用 authorization code 和 PKCE verifier 换取 Token，保存凭据。
11. 关闭 callback server，并重新连接对应 MCP Server。
12. 整个等待流程默认 5 分钟。超时、取消或错误都必须清理监听器和内存中的临时秘密。

## 连接、刷新和恢复

连接 Streamable HTTP MCP 时按以下优先级解析认证：

1. 配置中的显式 `Authorization` Header。
2. 与 server name 和 server URL 同时匹配的 OAuth 凭据。
3. 其他静态 Header。
4. 无认证连接。

OAuth access token 在距离过期不足 30 秒时刷新。若同一 server 同时发生多个连接或请求，刷新操作按 server name 合并为同一个进行中的 Promise，避免 refresh token 被并发使用。

收到首次认证 `401` 时：

- 有 refresh token：刷新一次，保存新 Token 并重连一次。
- 无 refresh token：标记为 `reauthentication-required`。
- refresh 返回 `invalid_grant`：清除不可再用的 access token，保留非秘密诊断状态并要求重新登录。
- 刷新后的第二次 `401`：停止重试并要求重新登录。

某个 MCP Server 缺少授权或授权失败时，只影响该 server。它不得阻止其他 MCP Server 连接，也不得拖垮整个 session。

## 状态模型和输出

对外状态为：

- `not-configured`：没有该 server 配置。
- `not-logged-in`：HTTP server 可使用 OAuth，但没有匹配凭据。
- `valid`：当前 access token 可用。
- `expired-refreshable`：access token 已过期，但有 refresh token；状态查询本身不触发网络刷新。
- `reauthentication-required`：凭据不可刷新或服务拒绝刷新后的凭据。
- `static`：使用显式 Header/env 等现有静态鉴权。
- `unsupported`：stdio、SSE 或服务不支持本阶段 OAuth。

`mcp list` 给出适合人阅读的表格；`mcp get` 给出单个 server 的 transport、地址、OAuth 配置和授权状态。`--json` 使用稳定字段，并且永远不返回 Token、client secret 或完整 Authorization Header。

命令失败使用非零退出码，并区分至少以下错误：配置不存在、transport 不支持、discovery 失败、浏览器/callback 失败、用户拒绝、超时、state/issuer 不匹配、Token 交换失败、刷新失败和凭据文件损坏。

## 登出和删除

`ohs mcp logout <name>` 删除该 server 的本地 OAuth 凭据并断开现有连接。如果 discovery metadata 提供撤销端点，可以尽力撤销远端 Token；远端撤销失败不阻止本地凭据删除，但 CLI 必须提示远端撤销未确认。

`ohs mcp remove <name>` 保持 Codex 的配置删除语义。为了避免留下秘密，它同时删除该 server 的本地 OAuth 凭据；如果存在凭据，输出应说明配置和本地授权均已移除。`remove` 不隐式承诺远端撤销成功。

## 测试策略

自动化测试使用本地模拟 OAuth/MCP 服务，不依赖外网，覆盖：

- CLI add 的 HTTP/stdio 互斥解析和 Codex 兼容参数。
- `list/get --json` 的稳定结构和敏感字段脱敏。
- Protected Resource 与 Authorization Server discovery。
- PKCE S256、state 校验和 DCR。
- callback 成功、拒绝、state 不匹配、超时及监听器清理。
- 凭据首次写入、更新、删除、原子替换、损坏文件保护和 server URL 绑定。
- access token 未过期、临近过期、可刷新和不可刷新状态。
- 并发刷新只发送一次 Token 请求。
- 首次 401 刷新后重连一次，第二次 401 不循环。
- 一个 server 授权失败时其他 server 仍能连接。
- 日志和错误中不出现测试 Token、code、verifier 或 secret。

每项行为先写失败测试，再实现最少代码使其通过。真实 Linear 不进入 CI。

## 人工验收

验收服务使用 Linear Streamable HTTP MCP，账号放在测试 workspace。首轮只申请 `read` scope：

```bash
ohs mcp add linear --url https://mcp.linear.app/mcp
ohs mcp get linear
ohs mcp login linear --scopes read
ohs mcp get linear
ohs mcp list
```

验收标准：

1. 登录前状态为 `not-logged-in`。
2. 登录打开浏览器并完成 Linear 授权。
3. 登录后状态为 `valid`，并能完成 MCP `tools/list` 和至少一次只读工具调用。
4. 重启 CLI/daemon 后不重新登录即可连接。
5. 使用本地测试手段让 access token 进入刷新窗口后，下一次连接自动刷新。
6. `ohs mcp logout linear` 后状态回到 `not-logged-in`。
7. `mcp-oauth.json`、命令输出和日志均未泄露到 settings 或诊断输出。

## 后续阶段

本阶段稳定后再独立设计：Desktop 授权 UI、OS keyring、多账号、自定义/远程 callback、CIMD、企业托管授权，以及从文件凭据安全迁移到 keyring 的机制。
