# @vykor/mcp

MCP (Model Context Protocol) client with stdio transport support.

## Streamable HTTP OAuth

HTTP OAuth 支持 PKCE、metadata 发现、动态客户端注册和 Token 刷新。网络、429、5xx 等临时刷新失败保留凭据；确认失效才提示重新授权。401 最多刷新恢复一次，旧请求失败不会把另一轮登录保存的新凭据标成失效。

- `oauth.resourceUrl` 可指定 Token 的资源标识；发现结果必须与预期标识一致，并包含当前 MCP endpoint。授权、交换和刷新使用同一个已验证值。
- `oauth.callbackUrl` 可指定固定 loopback HTTP 地址或手动模式的 HTTPS 接收地址，不能与 `oauth.callbackPort` 同时设置。HTTPS 接收地址由用户自行提供，本项目不托管回调代理。
- 权限、资源或固定回调配置变化后，下次使用会提示重新授权，不自动打开浏览器或重放工具调用。

本包只处理协议和连接决策。凭据文件及跨进程锁由 `@vykor/auth` 管理，登录/退出编排与活动 Session 同步由 `@vykor/server` 管理。

凭据继续保存在独立明文 JSON 文件，OS Keyring 与 file fallback 暂缓。新代码可读 v1，第一次实际修改写为 v2；v2 仅增加退出计数，防止退出前开始的旧登录迟到后恢复凭据。只读查询不迁移。旧客户端不能读取 v2，同一配置目录的 CLI、daemon 和 Desktop 应一起更新。

## 功能

- **McpClientManager**: MCP 服务器连接管理
- **StdioTransport**: stdio 传输（通过 @modelcontextprotocol/sdk）
- **工具发现**: 自动发现并注册 MCP 工具
- **资源读取**: MCP 资源读取

## 使用

```ts
import { McpClientManager } from "@vykor/mcp";

const manager = new McpClientManager();
await manager.connect("my-server", {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem"]
});

// 获取工具
const tools = manager.getAsToolDefinitions();
```

## API

- `connect(name, config)` - 连接 MCP 服务器
- `disconnect(name)` - 断开连接
- `callTool(server, tool, args)` - 调用工具
- `readResource(server, uri)` - 读取资源

## 测试

```bash
pnpm --filter @vykor/mcp test
```
