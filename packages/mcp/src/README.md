# MCP 源码

[index.ts](index.ts) 实现 `McpClientManager` 并作为 `@vykor/mcp` 的公开入口，集中导出连接类型、授权流程和协调接口。

## 目录导航

- [connections/](connections/README.md)：传输解析、本地进程传输和运行实例协调接口。
- [resources/](resources/README.md)：应用资源读取、校验及订阅。
- [oauth/](oauth/README.md)：HTTP 授权登录与刷新。
- [__test__/](__test__/)：管理器的连接、工具调用和跨分类行为测试。

`connect` 根据配置选择 stdio、HTTP 或 SSE，必要时取得 HTTP 令牌，再建立 SDK 连接、发现工具和资源并发布状态。需要切换连接的宿主也可用 `prepareConnection` / `activatePreparedConnection` 分阶段准备并发布；`retainCurrentConnections` 给一次 Run 保留已经捕获的客户端，返回释放函数。

连接状态、工具和资源列表、传输及旧客户端保留计数归管理器实例；授权文件由 auth 包保存。`getAsToolDefinitions`、`callTool`、`readResource` 和 `captureAppResources` 把结果返回给宿主，`disconnect` / `disconnectAll` 清理资源。

新增管理器级组装放本层，具体传输、资源和授权逻辑放分类；单模块测试随所属分类，跨分类测试放本层 `__test__/`。
