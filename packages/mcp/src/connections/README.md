# MCP 连接与传输

选择服务器传输方式，把本地命令接到 MCP SDK，并定义宿主同步活动连接时需要的接口。

## 主要文件

- [connection-types.ts](connection-types.ts)：stdio、HTTP、SSE 配置选择及连接结果类型。
- [sandbox-stdio-transport.ts](sandbox-stdio-transport.ts)：通过执行环境或 sandbox 创建本地 MCP 进程并传递消息。
- [runtime-coordination.ts](runtime-coordination.ts)：活动运行实例、协调器接口与不可用实现。

## 调用与状态

公开调用从 `@vykor/mcp` 的 `McpClientManager.connect` 开始；包根还导出 `resolveTransportKind`、连接类型及 `createUnavailableMcpRuntimeCoordinator`。本地传输类是内部实现。

管理器解析配置，stdio 传输调用注入的执行环境或 sandbox 进程接口，按 SDK 格式读写消息；远端传输由管理器创建 SDK 的 HTTP/SSE 实现。宿主通过协调接口同步配置变化；无活动注册表时返回 unavailable，不启动 daemon。

传输实例持有子进程和读缓冲；连接 Map 归上层管理器。这里仅定义活动实例注册表契约，实际注册表和跨 Session 同步由宿主实现。

现有连接集成测试在 [../__test__/](../__test__/)，覆盖管理器与传输组合。

## 新增代码与测试

同一职责的新代码放在本目录。本目录目前没有 `__test__/`；新增单模块测试时在本目录创建，跨分类场景放它们共同上层的 `__test__/`。
