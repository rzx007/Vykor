# MCP 应用资源

为插件应用提供绑定具体 MCP 连接的资源访问，防止同名服务器重连后继续使用旧资源入口。

## 主要文件

- [app-resources.ts](app-resources.ts)：捕获资源接口、检查连接代次并验证内容限制。
- [resource-subscriptions.ts](resource-subscriptions.ts)：按客户端和 URI 共享订阅与串行取消。

## 调用与状态

宿主通过包根 `McpClientManager.captureAppResources(name)` 获取 `CapturedMcpAppResources`，再调用 read/list/templates 或可选的 `subscribeResource`；底层函数不从包根直接公开。

捕获接口在请求前后都确认原客户端仍是当前连接，资源读取后校验大小和内容结构。订阅把相同 URI 的监听器合并为一次服务端订阅，最后一个监听者离开后取消。

连接代次归管理器；每个具体 SDK 客户端通过 WeakMap 关联订阅表，只保存监听者和串行操作，不保留资源载荷。调用方负责释放订阅或中止信号。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。
