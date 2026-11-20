# MCP 运行与授权

从 `@vykor/daemon-admin/mcp` 使用 `McpResource` 同步活动会话的 MCP 连接，或启动、查询、取消 OAuth 登录。授权事件经服务端持续推送的 SSE 返回。daemon 保存授权凭据和操作状态，CLI 和 Desktop 管理打开浏览器等交互。

新增 MCP 管理请求放在 `mcp-resource.ts`，请求和事件解码测试放在 [__test__/](./__test__/README.md)。
