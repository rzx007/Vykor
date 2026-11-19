# 运行权限资源

[permission-resource.ts](./permission-resource.ts) 导出 `PermissionResource`，通过 `client.permissions` 查询待处理请求，并用 `reply` 回复工具审批或回答 Agent 提问。回复结果来自 daemon，执行是否继续由服务端权限流程决定。

权限请求和决定由 daemon 保存，客户端快照和事件只维护其本地视图。等待 Run 的函数不会自动回复请求；界面或脚本必须提供自己的权限处理方式。

权限请求测试放本目录的 `__test__/`。登录、模型提供商、全局设置与 MCP 管理通过 daemon-admin 的独立入口调用。 [配置管理](../../../../daemon-admin/src/configuration/README.md) · [MCP 管理](../../../../daemon-admin/src/mcp/README.md) · [测试](./__test__)
