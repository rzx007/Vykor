# MCP 连接与鉴权

> 状态：当前实现。HTTP/SSE 传输、headers 静态鉴权、`McpAuth` live reconnect，以及 Streamable HTTP OAuth CLI 闭环均已接入。

## 当前入口

MCP 配置来自当前 settings 或已通过校验的插件贡献，交给 `packages/mcp/src/index.ts` 建立连接。每个 server 必须明确写 `type`，系统不会根据旧字段猜传输方式。

## 现状

- `McpClientManager`（packages/mcp）已支持 stdio、streamable HTTP 和 SSE，并保持失败隔离。
- `McpServerConfig`（packages/core/src/types/settings.ts）已支持 `type`、stdio 的 `command/args/env`，以及 HTTP/SSE 的 `url/headers`。
- HTTP/SSE 走 headers 静态鉴权；stdio 走 env 静态鉴权；连接状态记录 `authConfigured`。
- `McpAuth` 工具已支持配置静态 Bearer、自定义 Header 或 stdio 环境变量，保存 settings 后重连 live MCP server。
- Streamable HTTP 支持 OAuth discovery、DCR、PKCE、callback、独立凭据存储、连接前刷新和单次 401 恢复；SSE/stdio OAuth 不在本阶段范围内。

## 设计

### 1. 当前 `McpServerConfig`
```ts
type McpServerConfig =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: "http" | "sse"; url: string; headers?: Record<string, string>; oauth?: { scopes?: string[]; clientId?: string; callbackPort?: number } };
```

缺少 `type`、stdio 缺少 `command`、HTTP/SSE 缺少 `url` 都会明确失败。settings、CLI 写入和插件 MCP 文件都只接受这个当前格式。

### 2. `connect` 按传输选择
- `resolveTransportKind(config)` 校验显式 `type` 和必填字段；无效配置返回明确错误。
- stdio：现有 `StdioClientTransport`（env 作 auth）。
- http：`new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })`。
- sse：`new SSEClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })`。
- 无效配置 → 设 `status:"error"`（不抛、不影响其他 server，沿用失败隔离）。

### 3. 连接元数据（对齐 Python）
- `McpConnection` 加 `transport: "stdio"|"http"|"sse"` 与 `authConfigured: boolean`
  （http/sse：`!!headers`；stdio：`!!env`）。
- `transports` map 值类型从 `StdioClientTransport` 放宽为 SDK `Transport`。

### 4. resources "Method not found"
- 现 `.catch(()=>[])` 吞所有错。改为：错误信息含 "Method not found"（server 不支持 resources）→ 正常返回 `[]`；其他错误记录到 connection（不致命）。

## 测试

- `resolveTransportKind`（纯函数）：url→http、command→stdio、type 显式优先、缺字段→error、http+SSE type 用 url。
- `connect`：mock SDK transport，断言 http 用 StreamableHTTPClientTransport 且 headers 进了 requestInit；sse 同理；stdio 不变。
- `authConfigured`：http+headers→true、stdio+env→true、无→false。
- resources：Method-not-found→[]、其他错误不崩。

## OAuth CLI

```bash
ohs mcp add linear --url https://mcp.linear.app/mcp
ohs mcp login linear --scopes read
ohs mcp get linear --json
ohs mcp logout linear
```

- `add --url` 只保存配置，不自动发起授权；scope 必须在 `login --scopes` 显式确认。
- `--no-browser` 会打印授权 URL，并允许粘贴完整 callback URL。
- Token 与动态注册 secret 存在 `$OPENHARNESS_CONFIG_DIR/mcp-oauth.json`，不进入 settings 或命令输出；首版尚未接入系统 keyring。
- 配置里的显式 `Authorization` Header 优先于 OAuth。存在冲突 Header 时，`mcp login` 会拒绝继续。
- runtime 不打开浏览器、不执行 DCR、不扩大 scope。首次 401 可刷新并重发底层 HTTP 请求一次；403 `insufficient_scope` 要求用户显式重新登录。
- 独立 CLI 修改凭据不会主动断开已经运行的 session，新连接会读取最新凭据。
- OAuth endpoint 默认必须为 HTTPS；只有自动化测试可显式允许 loopback HTTP。

## 范围外

- SSE OAuth、stdio OAuth、Desktop 授权 UI 和系统 keyring。
