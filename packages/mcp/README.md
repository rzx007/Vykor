# @vykor/mcp

MCP（让模型发现外部工具并调用它们的协议）客户端。支持 stdio 本地进程、Streamable HTTP 和 SSE 连接，统一发现工具、调用工具和读取资源。

## 目录导航

- [src/](src/README.md)：`McpClientManager`、公开导出和完整连接流程。
- [src/connections/](src/connections/README.md)：传输选择、本地进程传输和运行实例协调接口。
- [src/resources/](src/resources/README.md)：绑定具体连接的应用资源读取和订阅。
- [src/oauth/](src/oauth/README.md)：HTTP 授权发现、登录、刷新、回调和状态判断。

## 入口与运行过程

包入口是 [src/index.ts](src/index.ts)。`McpClientManager.connect` 选择传输，连接 SDK 客户端并发现工具与资源；`getAsToolDefinitions` 返回 Agent 能调用的工具定义。工具名带 `mcp__<server>__<tool>` 前缀；`callTool` 返回统一结果，`readResource` 返回资源文本，`disconnectAll` 释放连接。

```ts
import { McpClientManager } from "@vykor/mcp";

const manager = new McpClientManager();
await manager.connect("files", {
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem"],
});
const tools = manager.getAsToolDefinitions();
// 宿主结束使用后调用 await manager.disconnectAll()。
```

管理器持有连接、SDK 客户端和传输的内存 Map。工具与应用资源绑定具体客户端，替换同名连接不会把旧调用转发到新客户端；活动 Run 可通过 `retainCurrentConnections` 暂时保留旧连接。

## Streamable HTTP OAuth

OAuth 支持 PKCE（使用一次性校验值保护授权码交换）、元数据发现、动态客户端注册和令牌刷新。网络、429、5xx 等临时刷新失败保留凭据；确认失效才提示重新授权。401 最多刷新恢复一次，旧请求失败不会把另一轮登录保存的新凭据标成失效。

`oauth.resourceUrl` 指定令牌资源标识；发现结果须匹配预期并包含当前 endpoint，授权、交换、刷新使用同一验证值。`oauth.callbackUrl` 支持固定 loopback HTTP 或手动模式的 HTTPS 接收地址，不能与 `oauth.callbackPort` 同时设置；HTTPS 接收地址由用户提供。权限、资源或固定回调变化后提示重新授权，运行请求不会自动打开浏览器或重放工具调用。

协议与连接决策在本包；凭据文件及跨进程锁由 `@vykor/auth` 管理，登录/退出编排与活动 Session 同步由 `@vykor/server` 管理。凭据是独立明文 JSON，系统凭据库（OS Keyring）及配套文件兜底方案暂缓。存储可读 v1，首次实际修改写 v2；v2 增加退出计数，拒绝迟到的旧登录恢复凭据。只读不迁移；旧客户端不能读取 v2，共享配置目录的 CLI、daemon 和 Desktop 应一起更新。

## 新增代码与检查

传输与协调接口、资源能力、授权协议分别进入三个分类。单模块测试放同层 `__test__/`；管理器及跨分类连接场景放 `src/__test__/`。

```bash
pnpm --filter @vykor/mcp test
pnpm --filter @vykor/mcp check-types
```
