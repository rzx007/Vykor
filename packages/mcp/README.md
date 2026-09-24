# @vykor/mcp

MCP (Model Context Protocol) client with stdio transport support.

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