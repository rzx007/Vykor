# MCP OAuth CLI 闭环设计

**日期：** 2026-09-18  
**状态：** 已确认，待实现计划  
**目标：** 为 Streamable HTTP MCP Server 提供与 Codex CLI 主要命令兼容的 OAuth 登录、持久化、刷新、状态查询和退出闭环。

## 背景

OpenHarness 当前支持 stdio、Streamable HTTP 和 SSE MCP 连接，也能通过静态 Bearer、自定义 Header 或 stdio 环境变量配置鉴权。现有 `McpAuth` 会把静态凭据写入 settings 并重连，但不包含浏览器授权、PKCE、动态客户端注册、OAuth Token 独立存储、自动刷新或重新授权状态。

本阶段补齐 CLI 可用闭环。Desktop 暂不增加授权界面，但后续可以复用本阶段形成的 OAuth 服务和状态模型。

## 用户体验和 Codex 兼容边界

命令名称和主要参数对齐当前 Codex CLI 的兼容子集：

```bash
ohs mcp add linear --url https://mcp.linear.app/mcp
ohs mcp login linear --scopes read
ohs mcp login linear --scopes read --no-browser
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

本阶段实现 Codex 命令面的兼容子集，不实现 Codex 的全局 `-c/--config`、feature flags、CIMD 或企业托管登录。OpenHarness 可以继续使用自己的 settings 文件结构。

兼容矩阵：

| 命令或参数 | 本阶段 | 与 Codex 的关系 |
|---|---|---|
| `mcp add <name> --url <url>` | 支持，只保存配置 | 命令兼容；故意不沿用 Codex 当前可能立即发起 OAuth 的行为，避免在用户尚未明确 scope 时扩权 |
| `mcp add <name> -- <command...>` | 支持 | 兼容 |
| `mcp login <name> --scopes <csv>` | 支持 | 兼容 |
| `mcp login <name> --no-browser` | 支持 | 兼容；打印 URL，并允许用户粘贴浏览器最终得到的完整 callback URL |
| `mcp get/list [--json]` | 支持 | 兼容子集，并增加本地授权状态字段 |
| `mcp logout/remove` | 支持 | 兼容主要语义 |
| `--bearer-token-env-var`、`--oauth-client-id`、`--oauth-resource`、`--oauth-client-registration` | 暂不支持 | 明确超出本阶段，不静默接受 |

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
- 登录成功后的临时 MCP 连接验证；新建 session 在连接时使用保存的 OAuth 凭据。
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
- 通知或重连已经运行的 daemon/session；凭据变更从下一次连接或新 session 起生效。

## 架构

```text
ohs mcp login <name>
        │
        ▼
McpOAuthService
  bind callback → discovery → PKCE → DCR → browser → token exchange
        │
        ▼
McpOAuthCredentialStore
  $OPENHARNESS_CONFIG_DIR/mcp-oauth.json
        │
        ▼
McpClientManager
  load/refresh token → authenticated transport → connect
```

职责边界：

- `packages/mcp`：MCP OAuth 协议流程、Token 刷新、认证状态和 HTTP Transport 注入。它定义窄的 credential-store 接口并优先复用 `@modelcontextprotocol/sdk` 的 OAuth provider/transport 能力，同时显式补齐 SDK 1.29.0 未覆盖的 issuer、scope 和 runtime 交互限制。
- `packages/auth`：实现 credential-store 接口，负责 `mcp-oauth.json` 的读取、跨进程锁、原子写入、权限限制和删除；不包含网络协议。
- `packages/core`：共享的纯 MCP 配置和状态 DTO，不引用 SDK 类型或协议服务接口。
- `apps/cli`：命令解析、浏览器打开、交互提示和退出码。
- `packages/agent-runtime`：在创建 session manager 时注入 runtime OAuth provider；现有静态 `McpAuth` 保持兼容。

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

`approvedScopes` 是本次登录唯一允许的权限集合：`login --scopes` 优先，其次使用配置中的 `oauth.scopes`。如果两者都没有，而 discovery 声明了非空 scope，CLI 列出可选 scope 并终止，要求用户通过 `--scopes` 明确重试；如果 discovery 没有声明 scope，则 `approvedScopes` 为空集合并允许继续。成功登录后，实际授权 scope 与 Token 一起持久化；不会静默扩大到 `approvedScopes` 之外。

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
      "revision": 3,
      "binding": {
        "issuer": "https://example-issuer.invalid",
        "redirectUri": "http://127.0.0.1:49152/callback",
        "tokenEndpoint": "https://example-issuer.invalid/token",
        "registrationEndpoint": "https://example-issuer.invalid/register",
        "revocationEndpoint": "https://example-issuer.invalid/revoke"
      },
      "registration": {
        "client_id": "registered-client-id",
        "client_secret": "registered-client-secret-if-issued",
        "token_endpoint_auth_method": "none",
        "client_id_issued_at": 1790000000,
        "client_secret_expires_at": 0
      },
      "tokens": {
        "accessToken": "access-token",
        "refreshToken": "refresh-token-if-issued",
        "tokenType": "Bearer",
        "scope": ["read"],
        "expiresAt": 1790000000000
      }
    }
  }
}
```

要求：

- settings 只保存 URL、scope、预注册 client ID 等非 Token 配置。
- 写入采用同目录临时文件后 rename，避免进程中断留下半个 JSON。
- 所有 read-modify-write 和 refresh token 轮换都必须持有跨进程锁。锁文件使用 exclusive create（Node `open(..., "wx")`）原子获取；普通写入后再判断不算持锁。锁文件记录 PID 和创建时间，每 50ms 重试，最长等待 10 秒，超时返回稳定的 `credential-lock-timeout` 错误。锁超过 30 秒且 PID 已不存在时才允许回收。登录等待 callback 时不持锁。
- 每次 server 凭据写入递增 `revision`。刷新调用者保留最初读取的 Token 快照；拿锁重读后按完整状态判断：entry 被删除或绑定变化则终止；access token 已更新且距离过期超过 30 秒，或者 refresh token 已轮换，则复用最新凭据；如果只有 revision/diagnostic 变化但 Token 仍需刷新，则继续执行刷新。
- POSIX 上目录和文件分别限制为当前用户可访问，凭据文件权限为 `0600`。
- Windows 首版依赖用户配置目录的 ACL，不额外引入原生 keyring 依赖。
- JSON 解析失败必须报出可操作错误，不能当成空仓库覆盖原文件。
- 所有日志和错误信息禁止输出 access token、refresh token、授权码、PKCE verifier 或 client secret。
- 每个 server name 只保存一份凭据。server URL、issuer 或 redirect URI 绑定变化，或者 client secret 已过期时，旧注册信息和 Token 均不得复用，必须重新注册/授权。

## 登录流程

1. CLI 加载 server 配置并确认其 transport 为 `http`。
2. 拒绝 URL 中的用户名、密码或 fragment。OAuth MCP、authorization、token、registration 和 revocation endpoint 默认都必须使用 HTTPS；自动化测试仅允许 `http://127.0.0.1` 或 `http://[::1]`。
3. 先在 `127.0.0.1` 启动临时 HTTP callback。端口默认由操作系统分配，也可使用 server 配置的 `callbackPort`；成功监听后才能确定完整 redirect URI。
4. 对 MCP endpoint 执行 OAuth discovery，解析 protected resource、authorization server、授权端点、Token 端点、注册端点和可用 scopes。authorization-server metadata 返回的 `issuer` 必须与请求/发现得到的 issuer 精确匹配。
5. 按配置模型计算 `approvedScopes`。discovery scope 只用于展示和校验服务能力，不能自动变成获批权限。
6. 使用配置的预注册 client ID；否则用已经确定的 redirect URI 通过 DCR 注册 public client。完整保存 SDK 返回的 `OAuthClientInformationMixed` 必要字段；DCR 返回的 client secret 按敏感凭据处理。
7. 生成随机 `state`、PKCE verifier 和 S256 challenge。
8. 默认尝试打开系统浏览器；打开失败时打印可复制的授权 URL，并继续等待 callback。使用 `--no-browser` 时不打开浏览器，打印授权 URL，同时等待本地 callback 或用户从 stdin 粘贴完整 callback URL；粘贴 URL 必须匹配预期 redirect origin/path，并执行与 HTTP callback 相同的 state、iss 和 code 校验。
9. `state` 必须一次性消费。callback 的 `iss` 若存在，必须与期望 issuer 精确匹配；若 metadata 声明 authorization response 必须携带 issuer，则缺少 `iss` 也失败。任何校验失败都立即关闭 listener 并清理 code、state 和 verifier。
10. 使用 authorization code 和 PKCE verifier 换取 Token。Token response 包含 `scope` 时，解析后的集合必须是 `approvedScopes` 的子集；如果返回额外 scope，则拒绝保存并尽力撤销。Token response 不含 `scope` 时，按 OAuth 规则视为本次请求的 `approvedScopes`。校验通过后才保存凭据。
11. 关闭 callback server，并使用下述非交互 `runtime` provider 创建临时 authenticated transport，完成 `initialize`/`tools/list` 验证。验证过程禁止 redirect、DCR 和扩 scope，最多刷新一次。401/403 将凭据诊断标记为 `reauthentication-required`；其他 MCP 初始化错误保留凭据但以非零退出码说明连接验证失败，且输出不得声称远端验证成功。
12. 已运行的 daemon/session 不在独立 CLI 进程内重连；新 session 或下一次连接读取保存后的凭据。
13. 单次登录共享 5 分钟总 deadline，覆盖 discovery、DCR、callback、token exchange 和临时连接验证，其中每个 HTTP 请求最多等待 15 秒。runtime refresh 和 logout/revocation 各自使用 30 秒操作 deadline，每个 HTTP 请求仍最多等待 15 秒。SIGINT/SIGTERM、超时和错误都走同一清理路径。

## 连接、刷新和恢复

OAuth provider 分为两种模式，不能复用同一套交互策略：

- `interactive-login`：允许打开浏览器和处理 callback。服务端 challenge 提出的 scope 必须是 `approvedScopes` 的子集；若要求新增 scope，终止并提示用户使用新的 `--scopes` 明确重试。Token response 的最终 scope 也必须再次执行相同的子集校验。
- `runtime`：禁止打开浏览器、禁止 DCR、禁止扩大 scope。它只能使用已有注册和 Token，并在原授权 scope 内刷新；需要交互时把状态写为 `reauthentication-required` 并返回类型化错误。

这是对 SDK 1.29.0 默认行为的约束：不能依赖 SDK 的 `finishAuth(code)` 完成 issuer 校验，也不能允许 transport 在 401/403 challenge 后自行开启扩权授权。

连接 Streamable HTTP MCP 时按以下优先级解析认证：

1. 配置中的显式 `Authorization` Header。
2. 与 server name 和 server URL 同时匹配的 OAuth 凭据。
3. 其他静态 Header。
4. 无认证连接。

OAuth access token 在距离过期不足 30 秒时刷新。同一进程内按 server name 合并为同一个进行中的 Promise；跨进程刷新必须再使用凭据文件锁，并在锁内重新读取，避免 refresh token 轮换竞争。

每次 refresh response 都以持久化的原授权 scope 为权限上限。响应包含 `scope` 时必须是原集合的子集；缺少 `scope` 时继承原集合；返回额外 scope 时拒绝保存该结果、清除不可使用的临时 Token，并标记 `reauthentication-required`。

同一 HTTP 请求的认证恢复只由 authenticated transport 负责，manager 不再重复同一工具调用：

- 首次 `401` 且有 refresh token：刷新一次，然后由 transport 重发原请求一次。
- 无 refresh token：标记为 `reauthentication-required`。
- refresh 返回 `invalid_grant`：清除不可再用的 access token，保留非秘密诊断状态并要求重新登录。
- 刷新后的第二次 `401`：停止重试并要求重新登录。
- `403 insufficient_scope`：runtime 不打开浏览器、不扩大 scope，直接要求用户显式执行带新 scope 的 `mcp login`。

`McpClientManager` 只负责 connect 失败或 transport 已失效后的新 transport 构建，并把 SDK 的 `UnauthorizedError`/HTTP 401 转换到授权状态；它不能在工具调用层再执行第二套刷新或重试，避免有副作用的工具被重复调用。

某个 MCP Server 缺少授权或授权失败时，只影响该 server。它不得阻止其他 MCP Server 连接，也不得拖垮整个 session。

## 状态模型和输出

对外状态为：

- `not-configured`：没有该 server 配置。
- `not-logged-in`：HTTP server 没有匹配凭据；这是纯本地判断，不表示远端一定支持 OAuth。
- `valid`：本地存在、绑定匹配且未过期的 access token；不表示远端一定仍接受。
- `expired-refreshable`：access token 已过期，但有 refresh token；状态查询本身不触发网络刷新。
- `reauthentication-required`：凭据不可刷新或服务拒绝刷新后的凭据。
- `static`：使用显式 Header/env 等现有静态鉴权。
- `unsupported`：stdio 或 SSE 不支持本阶段 OAuth。远端 HTTP 是否支持 OAuth 只在显式 login/discovery 后确定。

`not-logged-in`、`valid` 和 `expired-refreshable` 每次都根据配置绑定、Token 和当前时间动态计算，不写入文件。只有 `reauthentication-required` 等无法从 Token 推导的事实以可选 `diagnostic: { code, updatedAt }` 持久化，并优先于 Token 时间状态；刷新或重新登录成功后清除该诊断。

`mcp list` 给出适合人阅读的表格；`mcp get` 给出单个 server 的 transport、地址、OAuth 配置和授权状态。`--json` 使用稳定字段，并且永远不返回 Token、client secret 或完整 Authorization Header。

命令失败使用非零退出码，并区分至少以下错误：配置不存在、transport 不支持、discovery 失败、浏览器/callback 失败、用户拒绝、超时、state/issuer 不匹配、Token 交换失败、刷新失败和凭据文件损坏。

## 登出和删除

`ohs mcp logout <name>` 删除该 server 的本地 OAuth 凭据。若已保存的 metadata 提供撤销端点，先使用与 token endpoint 相同的 client authentication 尽力撤销 refresh token，再尽力撤销 access token；无论远端撤销是否成功，本地秘密都必须删除。独立 CLI 不承诺断开已运行 session，只提示凭据变更从下一次连接起生效。

`ohs mcp remove <name>` 保持 Codex 的配置删除语义。为了避免留下秘密，它同时删除该 server 的本地 OAuth 凭据；如果存在凭据，输出应说明配置和本地授权均已移除。`remove` 不隐式承诺远端撤销成功，也不影响已经运行的 session。

## 测试策略

自动化测试使用本地模拟 OAuth/MCP 服务，不依赖外网，覆盖：

- CLI add 的 HTTP/stdio 互斥解析和 Codex 兼容参数。
- `list/get --json` 的稳定结构和敏感字段脱敏。
- Protected Resource 与 Authorization Server discovery。
- HTTPS 强制规则，以及仅 loopback HTTP 可用于自动化测试。
- PKCE S256、state 一次性消费、metadata issuer 精确匹配、callback `iss` 缺失/不匹配和 DCR。
- callback 成功、拒绝、state 不匹配、超时及监听器清理。
- callback 先监听并确定 redirect URI，再执行 DCR。
- 凭据首次写入、更新、删除、原子替换、损坏文件保护，以及 server URL/issuer/redirect URI 绑定。
- access token 未过期、临近过期、可刷新和不可刷新状态。
- 两个独立 store/service 实例并发更新不同 server 不丢数据，并发刷新只发送一次 Token 请求。
- runtime 在只授权 `read` 时遇到 `write` challenge，绝不打开浏览器或发起扩权授权。
- token response 在请求 `read` 后返回额外 `write` scope 时拒绝保存并尽力撤销。
- re0.
- ++fresh response 在原授权为 `read` 时返回额外 `write` scope，拒绝保存并标记需要重新授权。
- 首次 401 由 transport 刷新并重发一次，第二次 401 不循环，manager 不重复执行工具调用。
- discovery、DCR、token、refresh 和 revocation endpoint 挂起时能按阶段超时并清理。
- 一个 server 授权失败时其他 server 仍能连接。
- 日志和错误中不出现测试 Token、code、verifier 或 secret。
- 至少一组集成测试使用 SDK 1.29.0 的真实 Streamable HTTP transport/provider 对接本地模拟服务；不能全部 mock transport。

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
7. `mcp-oauth.json` 之外的 settings、命令输出和日志均不包含 OAuth secret。
8. 如果登录时 Linear 要求超出 `read` 的 scope，CLI 拒绝继续并要求用户显式确认新的 `--scopes`，不会自动扩权。

## 后续阶段

本阶段稳定后再独立设计：Desktop 授权 UI、OS keyring、多账号、自定义/远程 callback、CIMD、企业托管授权，以及从文件凭据安全迁移到 keyring 的机制。
