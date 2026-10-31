# MCP 配置与登录

管理外部工具服务的配置、OAuth 登录和运行连接同步。

## 入口与流程

配置服务读取或更新连接定义，登录服务启动并完成授权，操作服务协调异步登录，连接协调器将变更同步到运行能力。

`McpConfigure` 的添加操作先检查主会话范围、配置格式、本地启动禁令和重名，再通过 `ToolContext.requestPermission` 请求标准权限决策；说明中只展示掩码后的地址和凭据字段名称。批准后保存配置并同步活动连接；拒绝、过期或取消时不保存。此流程不使用 `AskUser` 提问入口，也不代替外部服务的 OAuth 登录授权。

## 状态归属

配置与凭据由配置和认证能力保存，登录过程和待处理操作由对应服务实例管理。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [mcp-config-application-service.ts](./mcp-config-application-service.ts) | `McpConfigApplicationErrorCode`、`McpConfigApplicationError`、`McpConfigOperationResult`、`McpServerSummary` 等 |
| [mcp-configure-tool.ts](./mcp-configure-tool.ts) | `createMcpConfigureTool` |
| [mcp-oauth-application-service.ts](./mcp-oauth-application-service.ts) | `McpOAuthServerSnapshot`、`McpOAuthSnapshot`、`McpOAuthLoginRequest`、`McpOAuthCommitOutcome` 等 |
| [mcp-oauth-operation-service.ts](./mcp-oauth-operation-service.ts) | `OAuthOperationState`、`OAuthCallbackMode`、`MCP_OAUTH_LOGIN_UPDATED_EVENT`、`MCP_OAUTH_LOGIN_COMPLETED_EVENT` 等 |
| [mcp-runtime-connection-coordinator.ts](./mcp-runtime-connection-coordinator.ts) | `McpRuntimeConnectionCoordinator` |

## 测试与维护

外部工具服务的配置、授权流程和连接协调放在这里，工具执行由注入的 MCP 能力提供。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
